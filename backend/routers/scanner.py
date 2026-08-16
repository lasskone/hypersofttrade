"""
backend/routers/scanner.py

Technical scanner endpoints — watchlist management + signals feed.

  GET    /scanner/available-symbols                   all tradeable perp symbols (cached 5 min)
  GET    /scanner/watchlist?wallet_address=X          list active watchlist entries
  POST   /scanner/watchlist                           add a coin (upsert, reactivates)
  DELETE /scanner/watchlist/{id}?wallet_address=X     soft-delete (active=false)
  GET    /scanner/signals?wallet_address=X&limit=100  recent detected signals
"""
from __future__ import annotations

import os
import time

from fastapi import APIRouter, HTTPException
from supabase import create_client

router = APIRouter()

# ---------------------------------------------------------------------------
# In-process symbol cache — backed by the existing get_all_markets() call
# (which already calls allPerpMetas + metaAndAssetCtxs).  5-minute TTL is
# fine because the perp listing changes rarely.
# ---------------------------------------------------------------------------
_symbols_cache: list[str] = []
_symbols_cache_time: float = 0.0
_SYMBOLS_TTL = 300  # seconds


def _db():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


# ---------------------------------------------------------------------------
# GET /scanner/available-symbols
# ---------------------------------------------------------------------------
@router.get("/available-symbols")
async def get_available_symbols():
    """Return a sorted flat list of all tradeable perp coin names.

    Backed by get_all_markets() (which calls allPerpMetas).  Cached in-process
    for 5 minutes so autocomplete keystrokes never hit Hyperliquid directly.
    """
    global _symbols_cache, _symbols_cache_time

    now = time.time()
    if _symbols_cache and (now - _symbols_cache_time) < _SYMBOLS_TTL:
        return {"symbols": _symbols_cache}

    from services.hyperliquid_service import get_all_markets
    try:
        markets = await get_all_markets()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch symbols: {exc}") from exc

    # Use m["name"] — the full identifier including dex prefix for HIP-3 coins
    # (e.g. "xyz:TSLA100"), which is exactly what TradePanel uses and what the
    # scanner_watchlist.coin column must store to correctly route candle fetches.
    # display_name (the stripped label) must NOT be used here: it loses the prefix,
    # causing scan_pair_all_timeframes to query the wrong DEX for HIP-3-only coins.
    seen: set[str] = set()
    symbols: list[str] = []
    for m in markets:
        name = m.get("name", "")
        if name and name not in seen:
            seen.add(name)
            symbols.append(name)

    symbols.sort()
    _symbols_cache = symbols
    _symbols_cache_time = now
    return {"symbols": symbols}


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
