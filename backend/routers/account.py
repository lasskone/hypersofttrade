"""Account router — affiliation verification, status, portfolio, and API key management.

Supabase deduplication SQL (run once in Supabase SQL Editor if duplicates exist):

    -- Find duplicates
    SELECT wallet_address, COUNT(*)
    FROM users
    GROUP BY wallet_address
    HAVING COUNT(*) > 1;

    -- Keep only the most recent row per wallet
    DELETE FROM users
    WHERE id NOT IN (
      SELECT DISTINCT ON (wallet_address) id
      FROM users
      ORDER BY wallet_address, created_at DESC
    );

    -- Add unique constraint to prevent future duplicates
    ALTER TABLE users
    ADD CONSTRAINT users_wallet_address_unique
    UNIQUE (wallet_address);
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
from pydantic import BaseModel
from supabase import create_client

from core.config import settings
from core.security import decrypt, encrypt
from services.hyperliquid_service import hyperliquid_service

router = APIRouter()

REFERRAL_LINK = "https://app.hyperliquid.xyz/join/KNS"


def _supabase():
    if not settings.supabase_url or not settings.supabase_key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    return create_client(settings.supabase_url, settings.supabase_key)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class VerifyAffiliationRequest(BaseModel):
    wallet_address: str


class SaveApiKeyRequest(BaseModel):
    wallet_address: str
    api_wallet_address: str
    private_key: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_user(db, wallet_address: str):
    """Fetch user row with case-insensitive wallet match. Returns None if not found.
    Uses .limit(1) to avoid crashing when duplicate rows exist in the table.
    """
    result = (
        db.table("users")
        .select("id, is_affiliated, hyperliquid_api_key_encrypted, created_at")
        .ilike("wallet_address", wallet_address)
        .limit(1)
        .execute()
    )
    if result.data:
        return result.data[0]
    return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/verify-affiliation")
async def verify_affiliation(body: VerifyAffiliationRequest):
    wallet = body.wallet_address
    logger.info(f"POST /account/verify-affiliation wallet={wallet}")
    print(f"[verify] wallet={wallet}")
    result = await hyperliquid_service.check_affiliation(
        wallet, settings.hyperliquid_referral
    )

    # None = transient Hyperliquid API error after all retries exhausted.
    # Do NOT overwrite the existing is_affiliated value in the DB — this is not a
    # confirmed result and writing False here would cause a false rejection.
    # Return 503 so the frontend can distinguish a transient failure from a
    # genuine "not affiliated" response and avoid showing a false rejection.
    if result is None:
        logger.warning(f"[verify-affiliation] {wallet} — Hyperliquid API unavailable after retries; DB not updated")
        raise HTTPException(
            status_code=503,
            detail="affiliation_check_unavailable",
        )

    now = _now()
    upsert_data: dict = {
        "wallet_address": wallet,
        "is_affiliated": result,
        "updated_at": now,
    }
    if result:
        upsert_data["affiliated_at"] = now

    db = _supabase()
    db.table("users").upsert(upsert_data, on_conflict="wallet_address").execute()

    return {
        "wallet_address": wallet,
        "is_affiliated": result,
        "referral_link": REFERRAL_LINK,
    }


@router.get("/{wallet_address}/status")
async def get_account_status(wallet_address: str):
    """Return complete user status in one call. Never raises 404 — returns defaults for unknown wallets."""
    logger.info(f"GET /account/{wallet_address}/status")
    db = _supabase()
    user = _get_user(db, wallet_address)

    if not user:
        return {
            "wallet_address": wallet_address,
            "is_affiliated": False,
            "has_api_key": False,
            "onboarding_complete": False,
        }

    is_affiliated = bool(user.get("is_affiliated"))
    has_api_key = bool(user.get("hyperliquid_api_key_encrypted"))

    # Consistency guard: if DB somehow shows has_api_key without affiliation, treat as
    # unaffiliated. This prevents bypassing the gate due to DB inconsistency.
    if not is_affiliated:
        has_api_key = False

    return {
        "wallet_address": wallet_address,
        "is_affiliated": is_affiliated,
        "has_api_key": has_api_key,
        "onboarding_complete": is_affiliated and has_api_key,
    }


@router.get("/{wallet_address}/portfolio")
async def get_portfolio(wallet_address: str):
    """Return complete portfolio across all DEXes, spot, fills, and open orders."""
    logger.info(f"GET /account/{wallet_address}/portfolio")
    db = _supabase()
    user = _get_user(db, wallet_address)

    if not user or not user.get("hyperliquid_api_key_encrypted"):
        return {"error": "no_api_key"}

    try:
        data = await asyncio.wait_for(
            hyperliquid_service.get_complete_portfolio(wallet_address),
            timeout=10.0,
        )
    except asyncio.TimeoutError:
        logger.error(f"[portfolio] {wallet_address} timed out after 10s")
        raise HTTPException(status_code=503, detail="Portfolio fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        logger.error(f"[portfolio] {wallet_address} ERROR: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # ── Martingale state injection (non-fatal) ────────────────────────────────
    # Enrich open_positions with next_martingale_trigger_px / martingale_level
    # sourced from bot_risk_state for any momentum_scalper bot owned by this user.
    # Two synchronous Supabase queries (bots, then bot_risk_state) — not N+1.
    # A failure here must never break the portfolio response.
    try:
        user_id = user["id"]
        bots_res = (
            db.table("bots")
            .select("id")
            .eq("user_id", user_id)
            .eq("bot_type", "momentum_scalper")
            .execute()
        )
        bot_ids = [row["id"] for row in (bots_res.data or [])]
        if bot_ids:
            rs_res = (
                db.table("bot_risk_state")
                .select("active_coin, martingale_level, next_martingale_trigger_px")
                .in_("bot_id", bot_ids)
                .execute()
            )
            # Build coin → martingale state map; index by both full coin name and
            # short name (strips DEX prefix) so matching works for HIP-3 positions
            # where pos["symbol"] may be "dex:COIN" but active_coin is "COIN".
            mtg_by_coin: dict = {}
            for rs in (rs_res.data or []):
                active_coin = rs.get("active_coin")
                if not active_coin:
                    continue
                state = {
                    "martingale_level": int(rs.get("martingale_level") or 0),
                    "next_martingale_trigger_px": (
                        float(rs["next_martingale_trigger_px"])
                        if rs.get("next_martingale_trigger_px") is not None
                        else None
                    ),
                }
                mtg_by_coin[active_coin] = state
                short = active_coin.split(":")[-1] if ":" in active_coin else active_coin
                if short != active_coin:
                    mtg_by_coin[short] = state
            if mtg_by_coin:
                for pos in (data.get("open_positions") or []):
                    sym = pos.get("symbol", "")
                    sym_short = sym.split(":")[-1] if ":" in sym else sym
                    matched = mtg_by_coin.get(sym) or mtg_by_coin.get(sym_short)
                    if matched:
                        pos["martingale_level"] = matched["martingale_level"]
                        pos["next_martingale_trigger_px"] = matched["next_martingale_trigger_px"]
    except Exception as _mtg_exc:
        logger.warning(f"[portfolio] martingale state injection failed (non-fatal): {_mtg_exc}")

    return data


@router.get("/fills")
async def get_fills(wallet_address: str):
    """Return all Hyperliquid fills for *wallet_address*, sorted by time descending."""
    logger.info(f"GET /account/fills wallet={wallet_address}")
    try:
        raw: list = await asyncio.wait_for(
            hyperliquid_service.get_user_fills(wallet_address),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        logger.error(f"[fills] {wallet_address} timed out after 15s")
        raise HTTPException(status_code=503, detail="Fills fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        logger.error(f"[fills] {wallet_address} ERROR: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    fills = []
    for f in raw if isinstance(raw, list) else []:
        try:
            fills.append({
                **f,
                "closedPnl": float(f.get("closedPnl") or 0),
                "fee":       float(f.get("fee") or 0),
                "px":        float(f.get("px") or 0),
                "sz":        float(f.get("sz") or 0),
                "time":      int(f.get("time") or 0),
            })
        except (TypeError, ValueError):
            fills.append(f)

    fills.sort(key=lambda f: f.get("time", 0), reverse=True)
    return {"fills": fills}


@router.post("/save-api-key")
async def save_api_key(body: SaveApiKeyRequest):
    logger.info(f"POST /account/save-api-key wallet={body.wallet_address}")
    wallet = body.wallet_address

    db = _supabase()

    # Affiliation gate: reject wallets that are not in our DB as affiliated.
    # Reuses _get_user() — the same helper used by /status and /portfolio —
    # so no extra Hyperliquid call is made here. The is_affiliated flag was
    # written by verify-affiliation earlier in the onboarding flow.
    user = _get_user(db, wallet)
    if not user or not bool(user.get("is_affiliated")):
        raise HTTPException(
            status_code=403,
            detail="Wallet is not affiliated with HyperSoftTrade.",
        )

    try:
        encrypted = encrypt(body.private_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    db.table("users").upsert(
        {
            "wallet_address": wallet,
            "api_wallet_address": body.api_wallet_address,
            "hyperliquid_api_key_encrypted": encrypted,
            "updated_at": _now(),
        },
        on_conflict="wallet_address",
    ).execute()

    return {"success": True, "message": "API key saved securely"}
