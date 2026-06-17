"""Orders router — market data and order placement."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from services.hyperliquid_service import hyperliquid_service

router = APIRouter()

TOP_ASSETS = ["BTC", "ETH", "SOL", "AVAX", "MATIC", "ARB", "OP", "DOGE", "LINK", "UNI"]


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

@router.get("/market/prices")
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


@router.get("/market/orderbook/{symbol}")
async def get_orderbook(symbol: str):
    """Return top 10 bids and asks for *symbol*."""
    try:
        book = await hyperliquid_service.get_orderbook(symbol.upper())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "symbol": symbol.upper(),
        "bids": book["bids"][:10],
        "asks": book["asks"][:10],
    }


# ---------------------------------------------------------------------------
# Order execution (placeholder)
# ---------------------------------------------------------------------------

@router.post("/place")
async def place_order(payload: dict):
    return {"status": "placeholder", "payload": payload}


@router.delete("/{order_id}")
async def cancel_order(order_id: str):
    return {"status": "placeholder", "order_id": order_id}
