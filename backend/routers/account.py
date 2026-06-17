"""Account router — affiliation verification, portfolio, and API key management."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

from core.config import settings
from core.security import encrypt
from services.hyperliquid_service import hyperliquid_service

router = APIRouter()

REFERRAL_LINK = "https://app.hyperliquid.xyz/join/KNS"

TOP_ASSETS = ["BTC", "ETH", "SOL", "AVAX", "MATIC", "ARB", "OP", "DOGE", "LINK", "UNI"]


def _supabase():
    if not settings.supabase_url or not settings.supabase_key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    return create_client(settings.supabase_url, settings.supabase_key)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class VerifyAffiliationRequest(BaseModel):
    wallet_address: str


class SaveApiKeyRequest(BaseModel):
    wallet_address: str
    private_key: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/verify-affiliation")
async def verify_affiliation(body: VerifyAffiliationRequest):
    wallet = body.wallet_address
    print(f"[verify] wallet={wallet}")
    is_affiliated = await hyperliquid_service.check_affiliation(
        wallet, settings.hyperliquid_referral
    )

    now = datetime.now(timezone.utc).isoformat()
    upsert_data: dict = {
        "wallet_address": wallet,
        "is_affiliated": is_affiliated,
        "updated_at": now,
    }
    if is_affiliated:
        upsert_data["affiliated_at"] = now

    db = _supabase()
    db.table("users").upsert(upsert_data, on_conflict="wallet_address").execute()

    return {
        "wallet_address": wallet,
        "is_affiliated": is_affiliated,
        "referral_link": REFERRAL_LINK,
    }


@router.get("/{wallet_address}/status")
async def get_account_status(wallet_address: str):
    wallet = wallet_address.lower()
    db = _supabase()

    user_resp = (
        db.table("users")
        .select("id, is_affiliated, created_at")
        .eq("wallet_address", wallet)
        .maybe_single()
        .execute()
    )
    user = user_resp.data
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    bot_resp = (
        db.table("bots")
        .select("id", count="exact")
        .eq("user_id", user["id"])
        .execute()
    )
    bot_count = bot_resp.count or 0

    return {
        "wallet_address": wallet,
        "is_affiliated": user["is_affiliated"],
        "created_at": user["created_at"],
        "bot_count": bot_count,
    }


@router.get("/{wallet_address}/portfolio")
async def get_portfolio(wallet_address: str):
    """Return account value, margin, unrealized PnL and open positions."""
    wallet = wallet_address.lower()

    try:
        state = await hyperliquid_service.get_user_state(wallet)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Margin summary
    margin = state.get("marginSummary", {})
    account_value = float(margin.get("accountValue", 0))
    available_margin = float(margin.get("withdrawable", 0))

    # Positions
    raw_positions = state.get("assetPositions", [])
    positions = []
    total_pnl = 0.0

    for item in raw_positions:
        pos = item.get("position", {})
        size = float(pos.get("szi", 0))
        if size == 0:
            continue
        upnl = float(pos.get("unrealizedPnl", 0))
        total_pnl += upnl
        positions.append({
            "symbol": pos.get("coin", ""),
            "size": size,
            "entry_price": float(pos.get("entryPx", 0)),
            "mark_price": float(pos.get("positionValue", 0) / size) if size else 0,
            "unrealized_pnl": upnl,
            "leverage": pos.get("leverage", {}).get("value", 1),
        })

    return {
        "wallet_address": wallet,
        "account_value": account_value,
        "total_pnl": total_pnl,
        "open_positions": positions,
        "available_margin": available_margin,
    }


@router.post("/save-api-key")
async def save_api_key(body: SaveApiKeyRequest):
    wallet = body.wallet_address.lower()

    try:
        encrypted = encrypt(body.private_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    now = datetime.now(timezone.utc).isoformat()
    db = _supabase()
    db.table("users").upsert(
        {
            "wallet_address": wallet,
            "hyperliquid_api_key_encrypted": encrypted,
            "updated_at": now,
        },
        on_conflict="wallet_address",
    ).execute()

    return {"success": True, "message": "API key saved securely"}
