"""
Bot management routes — /bots prefix
"""
from __future__ import annotations
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

logger = logging.getLogger(__name__)
router = APIRouter()

def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


class CreateBotRequest(BaseModel):
    wallet_address: str
    name: str
    bot_type: str  # "grid" | "envelope_dca"
    symbol: str
    allocated_usdc: float
    config: dict  # strategy-specific params


class BotActionRequest(BaseModel):
    wallet_address: str


@router.get("/")
async def list_bots(wallet_address: str):
    logger.info(f"GET /bots/ wallet={wallet_address}")
    db = _supabase()
    user = db.table("users").select("id").ilike("wallet_address", wallet_address).limit(1).execute()
    if not user.data:
        return {"bots": []}
    user_id = user.data[0]["id"]
    bots = db.table("bots").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
    result = []
    for b in bots.data:
        # Derive is_running from the DB status field (written by the Worker).
        # Never use bot_manager.is_running() here — the API and Worker run in
        # separate processes, so the API's in-memory _tasks dict is always empty
        # for bots managed by the Worker, making that check permanently wrong.
        b["is_running"] = b.get("status") == "running"
        result.append(b)
    return {"bots": result}


@router.post("/")
async def create_bot(body: CreateBotRequest):
    logger.info(f"POST /bots/ wallet={body.wallet_address} type={body.bot_type} symbol={body.symbol}")
    try:
        db = _supabase()
        user = db.table("users").select("id").ilike("wallet_address", body.wallet_address).limit(1).execute()
        if not user.data:
            raise HTTPException(status_code=404, detail="User not found")
        user_id = user.data[0]["id"]
        bot_id = str(uuid.uuid4())
        config = {**body.config, "bot_type": body.bot_type, "symbol": body.symbol, "allocated_usdc": body.allocated_usdc}
        db.table("bots").insert({
            "id": bot_id,
            "user_id": user_id,
            "name": body.name,
            "bot_type": body.bot_type,
            "symbol": body.symbol,
            "allocated_usdc": body.allocated_usdc,
            "config": config,
            "status": "stopped",
            "desired_status": "stopped",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        logger.info(f"Bot created successfully: id={bot_id} type={body.bot_type} symbol={body.symbol}")
        return {"success": True, "bot_id": bot_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            f"create_bot FAILED — type={body.bot_type} symbol={body.symbol} "
            f"wallet={body.wallet_address}: {exc}",
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=f"Failed to create bot: {exc}")


@router.post("/{bot_id}/start")
async def start_bot(bot_id: str, body: BotActionRequest):
    logger.info(f"POST /bots/{bot_id}/start")
    db = _supabase()
    bot = db.table("bots").select("id, desired_status").eq("id", bot_id).limit(1).execute()
    if not bot.data:
        raise HTTPException(status_code=404, detail="Bot not found")
    if bot.data[0].get("desired_status") == "running":
        return {"success": True, "message": "Already running"}
    # Write desired_status='running' — the Worker polls this every POLL_INTERVAL
    # seconds and will launch (or re-launch) the bot task.
    # NEVER call bot_manager.start() here: the API and Worker are separate
    # processes.  Starting a task in the API process would create a duplicate
    # bot instance running alongside the Worker's copy.
    db.table("bots").update({
        "desired_status": "running",
        "error_message": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", bot_id).execute()
    return {"success": True, "message": "Bot queued to start — the worker will launch it within seconds"}


@router.post("/{bot_id}/stop")
async def stop_bot(bot_id: str):
    logger.info(f"POST /bots/{bot_id}/stop")
    db = _supabase()
    # Write desired_status='stopped' — the Worker will cancel the running task
    # on its next reconciliation pass (within POLL_INTERVAL seconds).
    # NEVER call bot_manager.stop() here: it would target the API process's
    # in-memory task dict (always empty since bots run in the Worker), making
    # the call a silent no-op that leaves the bot actually running.
    db.table("bots").update({
        "desired_status": "stopped",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", bot_id).execute()
    return {"success": True, "message": "Bot queued to stop — the worker will stop it within seconds"}


@router.delete("/{bot_id}")
async def delete_bot(bot_id: str):
    logger.info(f"DELETE /bots/{bot_id}")
    db = _supabase()
    # CRITICAL: confirm desired_status='stopped' is written and acknowledged by
    # Supabase BEFORE deleting the row.  If we delete first (or if the update
    # silently fails), the worker's cold_start_restore will query
    # desired_status='running' and resurrect the bot on next boot — because
    # Supabase replication may still serve the old row value for a brief window.
    try:
        update_res = db.table("bots").update({
            "desired_status": "stopped",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", bot_id).execute()
    except Exception as exc:
        logger.error(f"DELETE /bots/{bot_id}: failed to set desired_status=stopped before delete: {exc}")
        raise HTTPException(
            status_code=500,
            detail=f"Could not safely stop bot before deletion (DB write failed): {exc}",
        )

    if not update_res.data:
        # Row not found — either already deleted or wrong id; treat as success
        # (idempotent delete is safe) but log so we can detect phantom deletes.
        logger.warning(f"DELETE /bots/{bot_id}: update returned no rows — bot may not exist, proceeding")

    db.table("bot_logs").delete().eq("bot_id", bot_id).execute()
    db.table("bots").delete().eq("id", bot_id).execute()
    return {"success": True}


@router.put("/{bot_id}")
async def update_bot(bot_id: str, body: dict):
    logger.info(f"PUT /bots/{bot_id}")
    wallet_address = body.get("wallet_address")
    new_config = body.get("config")
    if not wallet_address or not new_config:
        raise HTTPException(status_code=400, detail="wallet_address and config required")

    db = _supabase()
    user = db.table("users").select("id").ilike("wallet_address", wallet_address).limit(1).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    user_id = user.data[0]["id"]

    existing = db.table("bots").select("*").eq("id", bot_id).eq("user_id", user_id).limit(1).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Bot not found")
    bot = existing.data[0]
    # Check DB status/desired_status — not bot_manager.is_running(), which is an
    # API-process in-memory check and always returns False for Worker-managed bots.
    if bot.get("status") == "running" or bot.get("desired_status") == "running":
        raise HTTPException(status_code=400, detail="Stop the bot before editing its configuration")

    # Always preserve bot_type — never trust the client payload to include it correctly;
    # this is the field that determines which strategy actually runs.
    new_config = {**new_config, "bot_type": bot.get("bot_type")}

    update_data: dict = {"config": new_config, "updated_at": datetime.now(timezone.utc).isoformat()}
    new_name = body.get("name")
    if new_name:
        update_data["name"] = new_name
    result = db.table("bots").update(update_data).eq("id", bot_id).execute()
    return result.data[0] if result.data else {"success": True}


@router.get("/{bot_id}/logs")
async def get_bot_logs(bot_id: str, limit: int = 50):
    logger.info(f"GET /bots/{bot_id}/logs limit={limit}")
    db = _supabase()
    logs = db.table("bot_logs").select("*").eq("bot_id", bot_id).order("created_at", desc=True).limit(limit).execute()
    return {"logs": logs.data}


@router.get("/{bot_id}/details")
async def get_bot_details(bot_id: str, wallet_address: str):
    """Return full bot detail: config, logs, Hyperliquid fills, and computed stats."""
    logger.info(f"GET /bots/{bot_id}/details wallet={wallet_address}")
    import httpx

    db = _supabase()

    # Verify ownership and resolve wallet address
    user_res = db.table("users").select("id, wallet_address").ilike("wallet_address", wallet_address).limit(1).execute()
    if not user_res.data:
        raise HTTPException(status_code=404, detail="User not found")
    user_id     = user_res.data[0]["id"]
    user_wallet = user_res.data[0]["wallet_address"]

    bot_res = db.table("bots").select("*").eq("id", bot_id).eq("user_id", user_id).limit(1).execute()
    if not bot_res.data:
        raise HTTPException(status_code=404, detail="Bot not found")
    bot = bot_res.data[0]

    # ── Risk Manager state (momentum_scalper / momentum_fade_scalper only) ─────
    risk_state: dict | None = None
    if bot.get("bot_type") in ("momentum_scalper", "momentum_fade_scalper"):
        rs_res = db.table("bot_risk_state").select("*").eq("bot_id", bot_id).limit(1).execute()
        if rs_res.data:
            rs = rs_res.data[0]
            equity = float(rs.get("equity") or 0)
            hwm    = float(rs.get("high_water_mark") or 0)
            drawdown_pct = ((hwm - equity) / hwm * 100) if hwm > 0 else 0.0
            risk_state = {
                "equity":             round(equity, 2),
                "high_water_mark":    round(hwm, 2),
                "drawdown_pct":       round(drawdown_pct, 2),
                "daily_loss_usd":     round(float(rs.get("daily_loss_usd") or 0), 2),
                "daily_loss_date":    rs.get("daily_loss_date"),
                "consecutive_losses": int(rs.get("consecutive_losses") or 0),
                "trading_halted":     bool(rs.get("trading_halted")),
                "halt_reason":        rs.get("halt_reason"),
                "cooldown_until":     rs.get("cooldown_until"),
            }

    # Logs (last 500, most recent first)
    logs_res = db.table("bot_logs").select("*").eq("bot_id", bot_id).order("created_at", desc=True).limit(500).execute()
    logs: list[dict] = logs_res.data or []

    # ── Stats via position_orders / position_groups ────────────────────────────
    # We do NOT filter userFills by bot.symbol because momentum_scalper stores
    # symbol as a comma-joined string ("BTC,ETH,SOL,XRP,HYPE") which never
    # matches a single fill's coin field.  Instead we use the position_orders
    # table (oid → bot_id) as the authoritative fill attribution source, and
    # position_groups (bot_id, status='closed') for the trade count.

    # All oids ever placed by this bot (entry, tp, sl, dca_*).
    po_res = db.table("position_orders").select("oid").eq("bot_id", bot_id).execute()
    bot_oids: set[int] = {int(row["oid"]) for row in (po_res.data or [])}

    # Completed round-trips = closed position_groups for this bot.
    pg_res = (
        db.table("position_groups")
        .select("id, entry_price, coin")
        .eq("bot_id", bot_id)
        .eq("status", "closed")
        .execute()
    )
    closed_trades = pg_res.data or []

    fills: list[dict] = []
    stats: dict = {
        "total_trades": 0, "total_pnl": 0.0, "total_fees": 0.0,
        "net_pnl": 0.0, "win_rate": 0.0, "avg_trade_pnl": 0.0,
        "best_trade": 0.0, "worst_trade": 0.0, "total_volume": 0.0,
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://api.hyperliquid.xyz/info",
                json={"type": "userFills", "user": user_wallet},
                headers={"Content-Type": "application/json"},
            )
            all_fills = resp.json()

        if isinstance(all_fills, list) and bot_oids:
            fills = [
                f for f in all_fills
                if isinstance(f, dict) and int(f.get("oid", -1)) in bot_oids
            ]
            fills.sort(key=lambda f: int(f.get("time", 0)), reverse=True)

        # total_trades = completed position_groups (one round-trip per trade),
        # not raw fill count (which double-counts entry+exit fills per trade).
        total_trades = len(closed_trades)
        total_pnl    = sum(float(f.get("closedPnl", 0) or 0) for f in fills)
        total_fees   = sum(float(f.get("fee",       0) or 0) for f in fills)
        net_pnl      = total_pnl - total_fees
        # win_rate: % of exit fills (closedPnl != 0) that are profitable.
        exit_fills   = [f for f in fills if float(f.get("closedPnl", 0) or 0) != 0]
        winning      = [f for f in exit_fills if float(f.get("closedPnl", 0) or 0) > 0]
        win_rate     = len(winning) / len(exit_fills) * 100 if exit_fills else 0.0
        avg_pnl      = net_pnl / total_trades if total_trades > 0 else 0.0
        exit_pnls    = [float(f.get("closedPnl", 0) or 0) for f in exit_fills]
        total_volume = sum(
            float(f.get("px", 0) or 0) * float(f.get("sz", 0) or 0) for f in fills
        )
        stats = {
            "total_trades":  total_trades,
            "total_pnl":     round(total_pnl,    4),
            "total_fees":    round(total_fees,   4),
            "net_pnl":       round(net_pnl,      4),
            "win_rate":      round(win_rate,      1),
            "avg_trade_pnl": round(avg_pnl,       4),
            "best_trade":    round(max(exit_pnls), 4) if exit_pnls else 0.0,
            "worst_trade":   round(min(exit_pnls), 4) if exit_pnls else 0.0,
            "total_volume":  round(total_volume,  2),
        }
    except Exception as e:
        logger.error(f"Failed to fetch Hyperliquid fills for bot {bot_id}: {e}")

    return {"bot": bot, "logs": logs, "fills": fills, "stats": stats, "risk_state": risk_state}
