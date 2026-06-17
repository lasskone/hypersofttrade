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

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
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
    print(f"[verify] wallet={wallet}")
    is_affiliated = await hyperliquid_service.check_affiliation(
        wallet, settings.hyperliquid_referral
    )

    now = _now()
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
    """Return complete user status in one call. Never raises 404 — returns defaults for unknown wallets."""
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
    """Return account value, margin, PnL and open positions.

    Portfolio data is read from the master MetaMask wallet address (from the URL).
    The stored API private key is for signing orders only — not for reading data.
    """
    db = _supabase()
    user = _get_user(db, wallet_address)

    if not user or not user.get("hyperliquid_api_key_encrypted"):
        return {"error": "no_api_key"}

    # Read portfolio using the master MetaMask wallet address.
    # The API private key is for signing orders only — never for reading data.
    try:
        state = await hyperliquid_service.get_user_state(wallet_address)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    margin = state.get("marginSummary", {})
    account_value = float(margin.get("accountValue", 0))
    available_margin = float(margin.get("withdrawable", 0))

    raw_positions = state.get("assetPositions", [])
    positions = []
    total_pnl = 0.0

    for item in raw_positions:
        pos = item.get("position", {})
        size = float(pos.get("szi", "0") or "0")
        if size == 0.0:
            continue
        upnl = float(pos.get("unrealizedPnl", 0))
        total_pnl += upnl
        positions.append({
            "symbol": pos.get("coin", ""),
            "size": size,
            "entry_price": float(pos.get("entryPx") or 0),
            "mark_price": float(pos.get("positionValue", 0) / size) if size else 0,
            "unrealized_pnl": upnl,
            "leverage": (pos.get("leverage") or {}).get("value", 1),
        })

    return {
        "wallet_address": wallet_address,
        "account_value": account_value,
        "total_pnl": total_pnl,
        "open_positions": positions,
        "available_margin": available_margin,
    }


@router.post("/save-api-key")
async def save_api_key(body: SaveApiKeyRequest):
    wallet = body.wallet_address

    try:
        encrypted = encrypt(body.private_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    db = _supabase()
    db.table("users").upsert(
        {
            "wallet_address": wallet,
            "hyperliquid_api_key_encrypted": encrypted,
            "updated_at": _now(),
        },
        on_conflict="wallet_address",
    ).execute()

    return {"success": True, "message": "API key saved securely"}
