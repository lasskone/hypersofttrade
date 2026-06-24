"""
Saved backtest configurations router.
Endpoints: POST /backtest/saved, GET /backtest/saved, DELETE /backtest/saved/{id}
"""
import logging

from fastapi import APIRouter, HTTPException, Query
import os
from supabase import create_client

logger = logging.getLogger(__name__)
router = APIRouter()


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


@router.post("")
async def create_saved_backtest(body: dict):
    logger.info(f"POST /backtest/saved wallet={body.get('wallet_address')}")
    wallet_address = (body.get("wallet_address") or "").strip()
    if not wallet_address:
        raise HTTPException(status_code=400, detail="wallet_address required")
    full_config = body.get("full_config") or {}
    results = body.get("results") or {}
    db = _supabase()
    row = {
        "wallet_address": wallet_address,
        "name": (body.get("name") or "Saved Backtest").strip(),
        "bot_type": full_config.get("bot_type", ""),
        "symbol": full_config.get("symbol", ""),
        "dex": full_config.get("dex") or "",
        "full_config": full_config,
        "results": results,
    }
    res = db.table("saved_backtests").insert(row).execute()
    return res.data[0] if res.data else {}


@router.get("")
async def list_saved_backtests(wallet_address: str = Query(...)):
    logger.info(f"GET /backtest/saved wallet={wallet_address}")
    db = _supabase()
    res = (
        db.table("saved_backtests")
        .select("id, wallet_address, name, bot_type, symbol, dex, full_config, results, created_at")
        .eq("wallet_address", wallet_address)
        .order("created_at", desc=True)
        .execute()
    )
    return res.data or []


@router.delete("/{backtest_id}")
async def delete_saved_backtest(backtest_id: str, wallet_address: str = Query(...)):
    logger.info(f"DELETE /backtest/saved/{backtest_id} wallet={wallet_address}")
    db = _supabase()
    db.table("saved_backtests").delete().eq("id", backtest_id).eq("wallet_address", wallet_address).execute()
    return {"deleted": True}
