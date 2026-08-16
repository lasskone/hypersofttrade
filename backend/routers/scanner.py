"""
backend/routers/scanner.py

Technical scanner endpoints — watchlist management + signals feed.

  GET    /scanner/watchlist?wallet_address=X          list active watchlist entries
  POST   /scanner/watchlist                           add a coin (upsert, reactivates)
  DELETE /scanner/watchlist/{id}?wallet_address=X     soft-delete (active=false)
  GET    /scanner/signals?wallet_address=X&limit=100  recent detected signals
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from supabase import create_client

router = APIRouter()


def _db():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


# ---------------------------------------------------------------------------
# GET /scanner/watchlist
# ---------------------------------------------------------------------------
@router.get("/watchlist")
async def get_watchlist(wallet_address: str):
    if not wallet_address:
        raise HTTPException(status_code=400, detail="wallet_address is required")
    db = _db()
    result = (
        db.table("scanner_watchlist")
        .select("*")
        .eq("wallet_address", wallet_address)
        .eq("active", True)
        .order("created_at", desc=False)
        .execute()
    )
    return {"watchlist": result.data or []}


# ---------------------------------------------------------------------------
# POST /scanner/watchlist
# ---------------------------------------------------------------------------
@router.post("/watchlist")
async def add_to_watchlist(body: dict):
    wallet_address = (body.get("wallet_address") or "").strip()
    coin           = (body.get("coin") or "").strip().upper()
    dex            = (body.get("dex") or "").strip()

    if not wallet_address or not coin:
        raise HTTPException(status_code=400, detail="wallet_address and coin are required")

    db = _db()

    # Upsert: if a soft-deleted row exists for same (wallet, coin, dex), reactivate it.
    # dex="" (empty string) stored as "", not NULL, so UNIQUE constraint works reliably.
    existing = (
        db.table("scanner_watchlist")
        .select("id, active")
        .eq("wallet_address", wallet_address)
        .eq("coin", coin)
        .eq("dex", dex)
        .limit(1)
        .execute()
    )
    if existing.data:
        row_id = existing.data[0]["id"]
        db.table("scanner_watchlist").update({"active": True}).eq("id", row_id).execute()
        fetched = db.table("scanner_watchlist").select("*").eq("id", row_id).limit(1).execute()
        return {"entry": fetched.data[0] if fetched.data else {}}

    result = db.table("scanner_watchlist").insert({
        "wallet_address": wallet_address,
        "coin":           coin,
        "dex":            dex,
        "active":         True,
    }).execute()
    return {"entry": result.data[0] if result.data else {}}


# ---------------------------------------------------------------------------
# DELETE /scanner/watchlist/{entry_id}
# ---------------------------------------------------------------------------
@router.delete("/watchlist/{entry_id}")
async def remove_from_watchlist(entry_id: str, wallet_address: str):
    if not wallet_address:
        raise HTTPException(status_code=400, detail="wallet_address is required")
    db = _db()
    existing = (
        db.table("scanner_watchlist")
        .select("id")
        .eq("id", entry_id)
        .eq("wallet_address", wallet_address)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Watchlist entry not found")
    db.table("scanner_watchlist").update({"active": False}).eq("id", entry_id).execute()
    return {"ok": True}


# ---------------------------------------------------------------------------
# GET /scanner/signals
# ---------------------------------------------------------------------------
@router.get("/signals")
async def get_signals(wallet_address: str, limit: int = 100):
    if not wallet_address:
        raise HTTPException(status_code=400, detail="wallet_address is required")
    if limit > 500:
        limit = 500
    db = _db()
    result = (
        db.table("technical_signals")
        .select("*")
        .eq("wallet_address", wallet_address)
        .order("detected_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {"signals": result.data or []}
