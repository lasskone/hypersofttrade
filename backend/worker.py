"""
Standalone worker process — runs all active trading bots independently from the
FastAPI web server. This process can run continuously while the API service is
redeployed, ensuring bots are never interrupted by unrelated code/UI changes.

Reconciliation loop:
- Polls the `bots` table every POLL_INTERVAL seconds
- For each bot: compares desired_status (what the user wants) against the worker's
  own in-memory task state (what is actually running)
- Starts tasks for bots that should be running but aren't
- Cancels tasks for bots that are running but shouldn't be
- Writes status + last_heartbeat back to Supabase so the API can report live state
  without needing access to this process's memory

NOTE on wallet_address:
  The `bots` table stores only `user_id` (not wallet_address directly). The worker
  joins through the `users` table to get the master wallet_address, which is required
  by BotManager.start() to fetch the encrypted API key and identify the account.
"""
from __future__ import annotations
import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

logging.Formatter.converter = time.gmtime  # force UTC for all %(asctime)s timestamps
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s UTC %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

sys.path.insert(0, os.path.dirname(__file__))

# Load .env for local development (no-op in Railway where env vars are injected)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from supabase import create_client
from services.bot_manager import BotManager
from services.db_utils import _run_db_call

POLL_INTERVAL = 5  # seconds between reconciliation passes


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


bot_manager = BotManager()


async def cold_start_restore() -> None:
    """
    Runs ONCE at worker boot, before the reconciliation loop.

    Pass 1 — restore desired-running bots:
    • Unconditionally launches every bot whose desired_status='running',
      regardless of what the (possibly stale) 'status' column says.
    • For any bot that cannot be launched (missing wallet, start() raises),
      sets status='error' and desired_status='stopped' so the reconcile loop
      won't keep retrying it, and writes a bot_logs entry explaining why.
    • Prints a single summary line so failures are visible immediately.

    Pass 2 — correct stale status for stopped/non-running bots:
    • Any bot whose desired_status is NOT 'running' but whose 'status' column
      is still 'running' (left over from before this Worker process started)
      gets corrected to status='stopped' immediately.  Without this, those bots
      would show a perpetual "Stopping…" badge in the UI because no ongoing
      reconcile branch ever touches the (desired='stopped', no local task) case.
    """
    print("[worker] Cold start: scanning for bots to restore...", flush=True)
    db = _supabase()

    # ── Pass 1: restore desired-running bots ───────────────────────────────────
    result = await _run_db_call(
        lambda: db.table("bots")
        .select("*, users(wallet_address)")
        .eq("desired_status", "running")
        .execute()
    )
    bots = result.data or []

    restored: list[str] = []
    failed: list[tuple[str, str]] = []  # (bot_id, reason)

    if not bots:
        print("[worker] Cold start: no bots with desired_status='running' — nothing to restore.", flush=True)
    else:
        for bot in bots:
            bot_id   = bot["id"]
            bot_name = bot.get("name", bot_id)
            user_row = bot.get("users") or {}
            wallet_address = user_row.get("wallet_address", "")

            if not wallet_address:
                reason = "wallet_address missing (users join returned no data or user deleted)"
                print(f"[worker] Cold start: SKIP {bot_id} ({bot_name}) — {reason}", flush=True)
                failed.append((bot_id, reason))
                try:
                    _bid, _reason = bot_id, reason
                    await _run_db_call(lambda: db.table("bots").update({
                        "status": "error",
                        "desired_status": "stopped",
                        "error_message": _reason,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", _bid).execute())
                    bot_manager._add_log(bot_id, "error",
                        f"[cold-start] Bot could not be restored on worker boot: {reason}")
                except Exception as db_err:
                    print(f"[worker] Cold start: failed to update DB for {bot_id}: {db_err}", flush=True)
                continue

            cfg = bot.get("config", {})
            print(
                f"[worker] Cold start: launching {bot_id} ({bot_name}) "
                f"type={cfg.get('bot_type')} wallet={wallet_address[:8]}...",
                flush=True,
            )
            try:
                await bot_manager.start(bot_id, cfg, wallet_address)
                restored.append(bot_id)
                bot_manager._add_log(bot_id, "info", "[cold-start] Bot task restored on worker boot.")
            except Exception as exc:
                reason = str(exc)
                print(f"[worker] Cold start: FAILED to launch {bot_id} ({bot_name}): {reason}", flush=True)
                failed.append((bot_id, reason))
                try:
                    _bid, _reason = bot_id, reason
                    await _run_db_call(lambda: db.table("bots").update({
                        "status": "error",
                        "desired_status": "stopped",
                        "error_message": _reason,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", _bid).execute())
                    bot_manager._add_log(bot_id, "error",
                        f"[cold-start] Bot failed to restore on worker boot: {reason}")
                except Exception as db_err:
                    print(f"[worker] Cold start: failed to update DB for {bot_id}: {db_err}", flush=True)

        # ── Pass 1 summary ──────────────────────────────────────────────────────
        restored_ids = ", ".join(restored) if restored else "none"
        if failed:
            failed_parts = "; ".join(f"{bid} ({reason})" for bid, reason in failed)
            print(
                f"[worker] Worker boot: restored {len(restored)} bot(s) (ids: {restored_ids}), "
                f"{len(failed)} failed (ids: {failed_parts})",
                flush=True,
            )
        else:
            print(
                f"[worker] Worker boot: restored {len(restored)} bot(s) (ids: {restored_ids}), 0 failed.",
                flush=True,
            )

    # ── Pass 2: correct stale status='running' for non-running bots ───────────
    # Query ALL bots that still report status='running' in the DB.  Any of those
    # that are NOT in our freshly-built task set (i.e. were not just restored in
    # Pass 1) have a stale status left over from a previous Worker process.
    # Correct them to 'stopped' now so the UI does not get stuck on "Stopping…".
    try:
        stale_result = await _run_db_call(
            lambda: db.table("bots")
            .select("id, name, status, desired_status")
            .eq("status", "running")
            .execute()
        )
        stale_bots = [
            b for b in (stale_result.data or [])
            if b.get("desired_status") != "running"  # NULL desired_status is treated as stopped
        ]
        if stale_bots:
            print(
                f"[worker] Cold start: found {len(stale_bots)} bot(s) with stale status='running' "
                f"(desired_status is not 'running') — correcting now...",
                flush=True,
            )
            for bot in stale_bots:
                bot_id   = bot["id"]
                bot_name = bot.get("name", bot_id)
                print(
                    f"[worker] Cold start: bot {bot_id} ({bot_name}) "
                    f"status was stale ('running'), corrected to 'stopped' (no active task at boot)",
                    flush=True,
                )
                try:
                    _bid = bot_id
                    await _run_db_call(lambda: db.table("bots").update({
                        "status": "stopped",
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", _bid).execute())
                except Exception as db_err:
                    print(f"[worker] Cold start: failed to correct stale status for {bot_id}: {db_err}", flush=True)
        else:
            print("[worker] Cold start: no stale status fields found — DB is consistent.", flush=True)
    except Exception as e:
        print(f"[worker] Cold start: stale-status correction failed: {e}", flush=True)

    print("[worker] Cold start complete.", flush=True)


async def _check_trailing_stops() -> None:
    """Check all waiting/active trailing stops and update SL orders accordingly."""
    from core.security import decrypt
    from services.hyperliquid_service import hyperliquid_service
    import httpx

    db = _supabase()
    now = datetime.now(timezone.utc).isoformat()

    res = await _run_db_call(lambda: db.table("trailing_stops").select("*").in_("status", ["waiting", "active"]).execute())
    records = res.data or []
    if not records:
        return

    print(f"[trailing_stops] Checking {len(records)} record(s)...", flush=True)

    # All current prices in one call
    try:
        all_mids = await asyncio.wait_for(hyperliquid_service.get_all_mids(), timeout=10.0)
    except Exception as e:
        print(f"[trailing_stops] get_all_mids failed: {e}", flush=True)
        return

    # sz_decimals lookup from allPerpMetas (one call covers all coins)
    sz_dec_map: dict[str, int] = {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            metas_resp = await client.post(
                "https://api.hyperliquid.xyz/info",
                json={"type": "allPerpMetas"},
                headers={"Content-Type": "application/json"},
            )
            for meta in metas_resp.json():
                if isinstance(meta, dict):
                    for asset in meta.get("universe", []):
                        if isinstance(asset, dict) and "name" in asset:
                            sz_dec_map[asset["name"]] = asset.get("szDecimals", 5)
    except Exception as e:
        print(f"[trailing_stops] allPerpMetas failed: {e}", flush=True)

    key_cache: dict[str, str | None] = {}     # wallet → decrypted private key
    pos_cache: dict[str, dict[str, float]] = {}  # "wallet:dex" → {coin: abs_size}

    for rec in records:
        ts_id    = rec["id"]
        wallet   = rec["wallet_address"]
        coin     = rec["coin"]
        dex      = rec.get("dex") or ""
        is_long  = rec["side"] == "long"
        entry_px      = float(rec["entry_price"])
        activation_px = float(rec["activation_price"])
        trail_pct     = float(rec["trail_pct"])
        status        = rec["status"]
        sl_oid        = rec.get("sl_oid")
        peak_price    = float(rec["peak_price"]) if rec.get("peak_price") is not None else None
        cur_sl_price  = float(rec["current_sl_price"]) if rec.get("current_sl_price") is not None else None

        # Current price (try full name, then short name for HIP-3)
        cur_price_raw = all_mids.get(coin) or all_mids.get(coin.split(":")[-1] if ":" in coin else coin)
        if cur_price_raw is None:
            continue
        cur_price = float(cur_price_raw)

        # Decrypt private key (cached per wallet)
        if wallet not in key_cache:
            try:
                _wallet = wallet
                ur = await _run_db_call(
                    lambda: db.table("users")
                    .select("hyperliquid_api_key_encrypted")
                    .ilike("wallet_address", _wallet)
                    .limit(1)
                    .execute()
                )
                enc = (ur.data[0] if ur.data else {}).get("hyperliquid_api_key_encrypted")
                key_cache[wallet] = decrypt(enc) if enc else None
            except Exception as e:
                print(f"[trailing_stops] key fetch failed for {wallet}: {e}", flush=True)
                key_cache[wallet] = None

        private_key = key_cache.get(wallet)
        if not private_key:
            continue

        # Helper: fetch and cache open positions for a wallet+dex pair
        async def _get_positions(w: str, d: str) -> dict[str, float]:
            ck = f"{w}:{d}"
            if ck not in pos_cache:
                try:
                    state = await asyncio.wait_for(
                        hyperliquid_service.get_clearinghouse_state(w, d), timeout=10.0
                    )
                    pos_cache[ck] = {
                        ap["position"]["coin"]: abs(float(ap["position"].get("szi", "0") or "0"))
                        for ap in state.get("assetPositions", [])
                        if isinstance(ap.get("position"), dict)
                        and float(ap["position"].get("szi", "0") or "0") != 0.0
                    }
                except Exception as e:
                    print(f"[trailing_stops] position fetch failed {w}: {e}", flush=True)
                    pos_cache[ck] = {}
            return pos_cache[f"{w}:{d}"]

        try:
            if status == "waiting":
                # Safety net: expire orphaned waiting rows even if activation is never reached
                # (e.g. position was closed via SL hit, liquidation, or manual close).
                positions = await _get_positions(wallet, dex)
                sz = positions.get(coin) or positions.get(coin.split(":")[-1] if ":" in coin else coin)
                if not sz:
                    _ts_id, _now = ts_id, now
                    await _run_db_call(lambda: db.table("trailing_stops").update({
                        "status": "cancelled",
                        "updated_at": _now,
                    }).eq("id", _ts_id).execute())
                    print(f"[trailing_stops] ts_id={ts_id} WAITING row cancelled — no open position found for {coin}", flush=True)
                    continue

                activated = (is_long and cur_price >= activation_px) or (not is_long and cur_price <= activation_px)
                if not activated:
                    continue

                positions = await _get_positions(wallet, dex)
                sz = positions.get(coin) or positions.get(coin.split(":")[-1] if ":" in coin else coin)
                if not sz:
                    print(f"[trailing_stops] ts_id={ts_id} no open position for {coin}, skipping", flush=True)
                    continue

                sz_decimals = sz_dec_map.get(coin, sz_dec_map.get(coin.split(":")[-1] if ":" in coin else coin, 5))
                be_sl = entry_px

                sl_result = await hyperliquid_service.place_tp_sl(
                    private_key=private_key, master_address=wallet, coin=coin,
                    is_long=is_long, size=sz, sz_decimals=sz_decimals,
                    tp_price=None, sl_price=be_sl,
                )

                oid = None
                try:
                    oid = sl_result["sl"]["response"]["data"]["statuses"][0].get("resting", {}).get("oid")
                except Exception:
                    pass

                if oid is None:
                    print(f"[trailing_stops] ts_id={ts_id} WARNING: could not extract sl_oid from place_tp_sl response — this trailing stop will not auto-update its SL. Raw response: {sl_result}", flush=True)

                _ts_id, _cur_price, _oid, _be_sl, _now = ts_id, cur_price, oid, be_sl, now
                await _run_db_call(lambda: db.table("trailing_stops").update({
                    "status":          "active",
                    "peak_price":      _cur_price,
                    "sl_oid":          _oid,
                    "current_sl_price": _be_sl,
                    "updated_at":      _now,
                }).eq("id", _ts_id).execute())
                print(f"[trailing_stops] ts_id={ts_id} ACTIVATED — SL@{be_sl:.4f} oid={oid}", flush=True)

            elif status == "active":
                new_peak = (
                    max(cur_price, peak_price or cur_price) if is_long
                    else min(cur_price, peak_price or cur_price)
                )

                if is_long:
                    trail_sl = new_peak * (1 - trail_pct / 100)
                    trail_sl = max(trail_sl, entry_px)   # never retreat below break-even
                else:
                    trail_sl = new_peak * (1 + trail_pct / 100)
                    trail_sl = min(trail_sl, entry_px)   # never retreat above break-even

                updates: dict = {"updated_at": now}
                if new_peak != peak_price:
                    updates["peak_price"] = new_peak

                # Only modify when SL improved (favorable direction) by more than 0.05%.
                # For long: higher SL = better (trailing up). For short: lower SL = better (trailing down).
                improved = (
                    cur_sl_price is None
                    or (is_long and trail_sl > cur_sl_price)        # long: SL moved up
                    or (not is_long and trail_sl < cur_sl_price)    # short: SL moved down
                )
                significant = cur_sl_price is None or abs(trail_sl - cur_sl_price) / (cur_sl_price or 1) > 0.0005
                if improved and significant and sl_oid is not None:
                    positions = await _get_positions(wallet, dex)
                    sz = positions.get(coin) or positions.get(coin.split(":")[-1] if ":" in coin else coin)

                    if sz and sz > 0:
                        sz_decimals = sz_dec_map.get(coin, sz_dec_map.get(coin.split(":")[-1] if ":" in coin else coin, 5))
                        try:
                            await hyperliquid_service.modify_order(
                                private_key=private_key, master_address=wallet, coin=coin,
                                oid=int(sl_oid), new_trigger_px=trail_sl, is_buy=not is_long,
                                sz=sz, sz_decimals=sz_decimals, tpsl="sl",
                            )
                            updates["current_sl_price"] = trail_sl
                            print(
                                f"[trailing_stops] ts_id={ts_id} SL→{trail_sl:.4f} (peak={new_peak:.4f})",
                                flush=True,
                            )
                        except Exception as e:
                            print(f"[trailing_stops] modify failed ts_id={ts_id}: {e}", flush=True)
                    else:
                        # Position is gone — SL was likely triggered by Hyperliquid
                        updates["status"] = "triggered"
                        print(f"[trailing_stops] ts_id={ts_id} position closed → marking triggered", flush=True)

                if updates:
                    _ts_id, _updates = ts_id, updates
                    await _run_db_call(lambda: db.table("trailing_stops").update(_updates).eq("id", _ts_id).execute())

        except Exception as e:
            print(f"[trailing_stops] unexpected error ts_id={ts_id}: {e}", flush=True)

        await asyncio.sleep(0.15)


async def trailing_stop_loop() -> None:
    """Monitor and advance all trailing stops every 30 seconds."""
    print("[worker] Trailing stop loop starting...", flush=True)
    while True:
        try:
            await _check_trailing_stops()
        except Exception as e:
            print(f"[trailing_stops] loop error: {e}", flush=True)
        await asyncio.sleep(30)


async def _run_technical_scanner_cycle() -> None:
    """Single scan cycle: check every active watchlist coin for new signals.

    Isolation guarantee: this coroutine sleeps 0.5 s between watchlist pairs to
    yield the event loop back to bot tasks.  It never touches the bots table or
    the BotManager, so it cannot interfere with running bots even if it raises.
    """
    from scanner.technical_scanner import scan_pair_all_timeframes

    db = _supabase()
    now = datetime.now(timezone.utc)

    # ── Fetch active watchlist ────────────────────────────────────────────────
    try:
        wl_result = await _run_db_call(lambda: db.table("scanner_watchlist").select("*").eq("active", True).execute())
        watchlist = wl_result.data or []
    except Exception as e:
        print(f"[scanner] watchlist fetch failed: {e}", flush=True)
        return

    if not watchlist:
        return

    # ── Build dedup set from last 4 hours ─────────────────────────────────────
    # Key: (wallet_address, coin, timeframe, signal_type)
    # We check locally before inserting to avoid duplicate rows within the same
    # cycle and to suppress re-alerting on a signal that fired recently.
    cutoff = (now - timedelta(hours=4)).isoformat()
    try:
        seen_result = await _run_db_call(
            lambda: db.table("technical_signals")
            .select("wallet_address,coin,timeframe,signal_type")
            .gte("detected_at", cutoff)
            .execute()
        )
        seen: set[tuple[str, str, str, str]] = {
            (r["wallet_address"], r["coin"], r["timeframe"], r["signal_type"])
            for r in (seen_result.data or [])
        }
    except Exception as e:
        print(f"[scanner] dedup fetch failed: {e}", flush=True)
        seen = set()

    # ── Scan each watchlist entry ─────────────────────────────────────────────
    for entry in watchlist:
        wallet = entry["wallet_address"]
        coin   = entry["coin"]
        dex    = entry.get("dex") or ""

        try:
            signals = await scan_pair_all_timeframes(coin, dex)
        except Exception as e:
            print(f"[scanner] scan failed {coin}: {e}", flush=True)
            await asyncio.sleep(0.5)
            continue

        for sig in signals:
            key = (wallet, coin, sig["timeframe"], sig["signal_type"])
            if key in seen:
                continue
            try:
                bar_ts = datetime.fromtimestamp(sig["bar_time"], tz=timezone.utc).isoformat()
                _row = {
                    "wallet_address": wallet,
                    "coin":           coin,
                    "timeframe":      sig["timeframe"],
                    "signal_type":    sig["signal_type"],
                    "price":          sig["price"],
                    "detected_at":    now.isoformat(),
                    "bar_time":       bar_ts,
                }
                await _run_db_call(lambda: db.table("technical_signals").insert(_row).execute())
                seen.add(key)
                print(
                    f"[scanner] {wallet[:8]}... {coin} {sig['timeframe']} "
                    f"{sig['signal_type']} @ {sig['price']:.4f}",
                    flush=True,
                )
            except Exception as e:
                print(f"[scanner] insert failed {coin} {sig['signal_type']}: {e}", flush=True)

        # Yield event loop back to bot tasks between pairs.
        await asyncio.sleep(0.5)


async def technical_scanner_loop() -> None:
    """Run the technical scanner every 5 minutes (300 s)."""
    print("[worker] Technical scanner loop starting...", flush=True)
    while True:
        try:
            await _run_technical_scanner_cycle()
        except Exception as e:
            print(f"[scanner] loop error: {e}", flush=True)
        await asyncio.sleep(300)


async def reconcile_loop():
    print("[worker] Reconciliation loop starting...", flush=True)
    await cold_start_restore()
    while True:
        try:
            db = _supabase()

            # Join bots → users to get the master wallet_address in one query.
            # The bots table has no direct wallet_address column — only user_id.
            result = await _run_db_call(lambda: db.table("bots").select("*, users(wallet_address)").execute())
            bots = result.data or []

            for bot in bots:
                bot_id = bot["id"]
                desired = bot.get("desired_status", "stopped")
                is_running_locally = bot_manager.is_running(bot_id)

                # Extract wallet_address from the joined users row
                user_row = bot.get("users") or {}
                wallet_address = user_row.get("wallet_address", "")

                if desired == "running" and not is_running_locally:
                    # ── Case 1: should be running, task is absent → start it ───
                    if not wallet_address:
                        reason = f"wallet_address missing from user row (user_row={user_row})"
                        print(f"[worker] Cannot start bot {bot_id} — {reason}", flush=True)
                        _bid, _reason = bot_id, reason
                        await _run_db_call(lambda: db.table("bots").update({
                            "status": "error",
                            "desired_status": "stopped",
                            "error_message": _reason,
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", _bid).execute())
                        bot_manager._add_log(bot_id, "error", f"[reconcile] {reason}")
                        continue
                    print(f"[worker] Starting bot {bot_id} ({bot.get('name')}) for wallet {wallet_address[:8]}...", flush=True)
                    try:
                        cfg = bot.get("config", {})
                        await bot_manager.start(bot_id, cfg, wallet_address)
                        # FIX 1: Re-verify the row still exists after start() returns.
                        # The user may have clicked Delete while the start() coroutine was
                        # awaited — if the row is gone, cancel the task immediately rather
                        # than leaving it orphaned until the next reconcile cycle.
                        _bid = bot_id
                        still_exists = await _run_db_call(lambda: db.table("bots").select("id").eq("id", _bid).limit(1).execute())
                        if not still_exists.data:
                            print(
                                f"[worker] Bot {bot_id} was deleted mid-start — "
                                f"cancelling orphaned task immediately",
                                flush=True,
                            )
                            await bot_manager.stop(bot_id)
                        else:
                            _bid = bot_id
                            await _run_db_call(lambda: db.table("bots").update({
                                "status": "running",
                                "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                            }).eq("id", _bid).execute())
                    except Exception as e:
                        print(f"[worker] Failed to start bot {bot_id}: {e}", flush=True)
                        _bid, _err = bot_id, str(e)
                        await _run_db_call(lambda: db.table("bots").update({
                            "status": "error",
                            "error_message": _err,
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", _bid).execute())

                elif desired != "running" and is_running_locally:
                    # ── Case 2: should NOT be running, task exists → stop it ───
                    print(f"[worker] Stopping bot {bot_id} ({bot.get('name')})", flush=True)
                    await bot_manager.stop(bot_id)
                    _bid = bot_id
                    await _run_db_call(lambda: db.table("bots").update({
                        "status": "stopped",
                        "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", _bid).execute())

                elif desired == "running" and is_running_locally:
                    # ── Case 3: running as expected → just update heartbeat ────
                    _bid = bot_id
                    await _run_db_call(lambda: db.table("bots").update({
                        "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", _bid).execute())

                else:
                    # ── Case 4 (was missing): desired != running, no local task ─
                    # No task action needed — but the 'status' column may be stale
                    # (e.g. 'running' left over from a crashed/restarted Worker).
                    # Correct it unconditionally so the UI never gets stuck.
                    current_status = bot.get("status")
                    if current_status not in ("stopped", "error"):
                        print(
                            f"[worker] Reconcile: bot {bot_id} ({bot.get('name')}) "
                            f"status was stale ('{current_status}'), corrected to 'stopped' (no active task)",
                            flush=True,
                        )
                        _bid = bot_id
                        await _run_db_call(lambda: db.table("bots").update({
                            "status": "stopped",
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", _bid).execute())

        except Exception as e:
            print(f"[worker] Reconciliation error: {e}", flush=True)

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    async def _main():
        await asyncio.gather(reconcile_loop(), trailing_stop_loop(), technical_scanner_loop())
    asyncio.run(_main())
