"""Orders router — market data and order placement."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

from core.config import settings
from core.security import decrypt
from services.hyperliquid_service import hyperliquid_service

router = APIRouter()

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


@router.get("/orderbook/{symbol}")
async def get_orderbook(symbol: str):
    """Return top 12 bids and asks for *symbol*."""
    try:
        book = await hyperliquid_service.get_orderbook(symbol.upper())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "symbol": symbol.upper(),
        "bids": book["bids"][:12],
        "asks": book["asks"][:12],
    }


# ---------------------------------------------------------------------------
# Order execution
# ---------------------------------------------------------------------------

@router.post("/place")
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
        )
    except Exception as exc:
        print(f"[place_order] ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"success": True, "result": result_data}


@router.delete("/{order_id}")
async def cancel_order(order_id: str):
    return {"status": "placeholder", "order_id": order_id}
