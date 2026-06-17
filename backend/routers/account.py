"""Account router — affiliation verification and status."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

from core.config import settings
from services.hyperliquid_service import hyperliquid_service

router = APIRouter()

REFERRAL_LINK = "https://app.hyperliquid.xyz/join/KNS"


def _supabase():
    """Return a Supabase client (created per-request to stay stateless)."""
    if not settings.supabase_url or not settings.supabase_key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    return create_client(settings.supabase_url, settings.supabase_key)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class VerifyAffiliationRequest(BaseModel):
    wallet_address: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/verify-affiliation")
async def verify_affiliation(body: VerifyAffiliationRequest):
    """Check whether *wallet_address* signed up via the KNS referral link.

    Always upserts a user record so subsequent status calls work even for
    non-affiliated wallets.
    """
    wallet = body.wallet_address.lower()
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
    """Return the stored status for *wallet_address* plus their bot count."""
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
