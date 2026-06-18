"""Orders router — market data and order placement."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

from core.config import settings
from core.security import decrypt
from services.hyperliquid_service import hyperliquid_service, get_all_markets, get_recent_trades, get_candles

router = APIRouter()          # mounted at /market  (market data)
orders_router = APIRouter()  # mounted at /orders  (order execution)

TOP_ASSETS = ["BTC", "ETH", "SOL", "AVAX", "MATIC", "ARB", "OP", "DOGE", "LINK", "UNI"]


def _supabase():
    if not settings.supabase_url or not settings.supabase_key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    return create_client(settings.supabase_url, settings.supabase_key)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class PlaceOrderRequest(BaseModel):
    wallet_address: str   # master MetaMask address
    coin: str             # e.g. "BTC", "ETH", "xyz:XYZ100"
    is_buy: bool
    size: float           # USD notional
    price: float          # mark price (for market orders)
    order_type: str       # "market" or "limit"
    limit_price: float = 0.0
    leverage: int = 1
    sz_decimals: int = 5  # asset's decimal precision for size rounding


class CancelOrderRequest(BaseModel):
    wallet_address: str
    coin: str
    order_id: int


class ClosePositionRequest(BaseModel):
    wallet_address: str
    coin: str
    is_long: bool
    size: float
    sz_decimals: int
    percentage: int  # 1-100
    mark_price: float


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

@router.get("/prices")
async def get_market_prices():
    """Return mid prices for the top 10 assets."""
    try:
        all_mids = await hyperliquid_service.get_all_mids()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    prices = {
        symbol: all_mids.get(symbol)
        for symbol in TOP_ASSETS
        if symbol in all_mids
    }
    return {"prices": prices}


@router.get("/all")
async def get_all_markets_route():
    """Return all available trading pairs from all DEXes with current prices."""
    try:
        markets = await get_all_markets()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return markets


@router.get("/orderbook/{symbol:path}")
async def get_orderbook(symbol: str):
    """Return top 12 bids and asks for *symbol* (supports xyz:XYZ100 style names)."""
    try:
        book = await hyperliquid_service.get_orderbook(symbol)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Convert {px, sz} objects → [px, sz] arrays for the frontend
    bids = [[level["px"], level["sz"]] for level in book["bids"][:12]]
    asks = [[level["px"], level["sz"]] for level in book["asks"][:12]]

    return {
        "symbol": symbol,
        "bids": bids,
        "asks": asks,
    }


@router.get("/trades/{symbol:path}")
async def get_trades(symbol: str):
    """Return last 20 recent trades for *symbol*."""
    try:
        trades = await get_recent_trades(symbol)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return trades


@router.get("/candles/{symbol:path}")
async def get_candles_route(
    symbol: str,
    interval: str = "15m",
    limit: int = 500,
):
    """Return OHLCV candles for *symbol* (supports HIP-3 names like xyz:XYZ100)."""
    try:
        candles = await get_candles(symbol, interval, limit)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return candles


# ---------------------------------------------------------------------------
# Order execution  (served under /orders via orders_router)
# ---------------------------------------------------------------------------

@orders_router.post("/place")
async def place_order(body: PlaceOrderRequest):
    """Place an order on Hyperliquid using the user's stored API key."""
    # 1. Fetch user from Supabase
    db = _supabase()
    result = (
        db.table("users")
        .select("hyperliquid_api_key_encrypted")
        .ilike("wallet_address", body.wallet_address)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=400, detail="No API key configured")

    encrypted = result.data[0].get("hyperliquid_api_key_encrypted")
    if not encrypted:
        raise HTTPException(status_code=400, detail="No API key configured")

    # 2. Decrypt private key
    try:
        private_key = decrypt(encrypted)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to decrypt API key") from exc

    # 3. Determine execution price
    exec_price = body.limit_price if body.order_type == "limit" else body.price

    # 4. Place order
    try:
        result_data = await hyperliquid_service.place_order(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            is_buy=body.is_buy,
            size=body.size,
            price=exec_price,
            order_type=body.order_type,
            leverage=body.leverage,
            sz_decimals=body.sz_decimals,
        )
    except Exception as exc:
        print(f"[place_order] ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"success": True, "result": result_data}


@orders_router.post("/cancel")
async def cancel_order(body: CancelOrderRequest):
    db = _supabase()
    result = db.table("users").select("hyperliquid_api_key_encrypted").ilike("wallet_address", body.wallet_address).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=400, detail="No API key configured")
    encrypted = result.data[0].get("hyperliquid_api_key_encrypted")
    if not encrypted:
        raise HTTPException(status_code=400, detail="No API key configured")
    try:
        private_key = decrypt(encrypted)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to decrypt API key") from exc
    try:
        result_data = await hyperliquid_service.cancel_order(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            order_id=body.order_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "result": result_data}


@orders_router.post("/close")
async def close_position(body: ClosePositionRequest):
    db = _supabase()
    result = db.table("users").select("hyperliquid_api_key_encrypted").ilike("wallet_address", body.wallet_address).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=400, detail="No API key configured")
    encrypted = result.data[0].get("hyperliquid_api_key_encrypted")
    if not encrypted:
        raise HTTPException(status_code=400, detail="No API key configured")
    try:
        private_key = decrypt(encrypted)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to decrypt API key") from exc
    try:
        result_data = await hyperliquid_service.close_position(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            is_long=body.is_long,
            size=body.size,
            sz_decimals=body.sz_decimals,
            percentage=body.percentage,
            mark_price=body.mark_price,
        )
    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        print(f"[close_position] ERROR body={body} exc={exc}\n{tb}")
        raise HTTPException(status_code=500, detail=f"{exc} | {tb}") from exc
    return {"success": True, "result": result_data}
