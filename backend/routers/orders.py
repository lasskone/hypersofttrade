"""Orders router — market data and order placement."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)
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
    size: float           # asset size (already converted from USD/price by frontend)
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


class SetLeverageRequest(BaseModel):
    wallet_address: str
    coin: str
    leverage: int
    is_cross: bool


class PlaceTpSlRequest(BaseModel):
    wallet_address: str
    coin: str
    is_long: bool
    size: float
    sz_decimals: int
    tp_price: float | None = None
    sl_price: float | None = None


class ModifyOrderRequest(BaseModel):
    wallet_address: str
    coin: str
    oid: int
    new_trigger_px: float
    is_buy: bool      # closing side — opposite of position direction
    sz: float         # current order size to keep
    sz_decimals: int
    tpsl: str         # "tp" or "sl"


class CreateTrailingStopRequest(BaseModel):
    wallet_address: str
    coin: str
    dex: str = ""
    side: str          # "long" or "short"
    entry_price: float
    activation_pct: float
    trail_pct: float


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

@router.get("/prices")
async def get_market_prices():
    """Return mid prices for the top 10 assets."""
    logger.info("GET /market/prices")
    try:
        all_mids = await asyncio.wait_for(hyperliquid_service.get_all_mids(), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Prices fetch timed out — upstream Hyperliquid API too slow")
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
    logger.info("GET /market/all")
    try:
        markets = await asyncio.wait_for(get_all_markets(), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Markets fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return markets


@router.get("/orderbook/{symbol:path}")
async def get_orderbook(symbol: str):
    """Return top 12 bids and asks for *symbol* (supports xyz:XYZ100 style names)."""
    logger.info(f"GET /market/orderbook/{symbol}")
    try:
        book = await asyncio.wait_for(hyperliquid_service.get_orderbook(symbol), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Orderbook fetch timed out — upstream Hyperliquid API too slow")
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
    logger.info(f"GET /market/trades/{symbol}")
    try:
        trades = await asyncio.wait_for(get_recent_trades(symbol), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Trades fetch timed out — upstream Hyperliquid API too slow")
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
    logger.info(f"GET /market/candles/{symbol} interval={interval} limit={limit}")
    try:
        candles = await asyncio.wait_for(get_candles(symbol, interval, limit), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Candles fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return candles


# ---------------------------------------------------------------------------
# Order execution  (served under /orders via orders_router)
# ---------------------------------------------------------------------------

@orders_router.post("/place")
async def place_order(body: PlaceOrderRequest):
    """Place an order on Hyperliquid using the user's stored API key."""
    logger.info(f"POST /orders/place wallet={body.wallet_address} coin={body.coin} type={body.order_type}")
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

    print(f"[place_order] FULL RESULT: {result_data}")
    return {"success": True, "result": result_data}


@orders_router.post("/cancel")
async def cancel_order(body: CancelOrderRequest):
    logger.info(f"POST /orders/cancel wallet={body.wallet_address} coin={body.coin} oid={body.order_id}")
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
    logger.info(f"POST /orders/close wallet={body.wallet_address} coin={body.coin} pct={body.percentage}%")
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
    print(f"[close_position] FULL RESULT: {result_data}")
    return {"success": True, "result": result_data}


@orders_router.post("/tp-sl")
async def place_tp_sl(body: PlaceTpSlRequest):
    logger.info(f"POST /orders/tp-sl wallet={body.wallet_address} coin={body.coin} tp={body.tp_price} sl={body.sl_price}")
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
        result_data = await hyperliquid_service.place_tp_sl(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            is_long=body.is_long,
            size=body.size,
            sz_decimals=body.sz_decimals,
            tp_price=body.tp_price,
            sl_price=body.sl_price,
        )
    except Exception as exc:
        print(f"[tp_sl] ERROR: {exc}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "result": result_data}


@orders_router.post("/modify")
async def modify_order(body: ModifyOrderRequest):
    logger.info(f"POST /orders/modify wallet={body.wallet_address} coin={body.coin} oid={body.oid} tpsl={body.tpsl}")
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
        result_data = await hyperliquid_service.modify_order(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            oid=body.oid,
            new_trigger_px=body.new_trigger_px,
            is_buy=body.is_buy,
            sz=body.sz,
            sz_decimals=body.sz_decimals,
            tpsl=body.tpsl,
        )
    except Exception as exc:
        print(f"[modify_order] ERROR: {exc}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "result": result_data}


@orders_router.post("/set-leverage")
async def set_leverage(body: SetLeverageRequest):
    logger.info(f"POST /orders/set-leverage wallet={body.wallet_address} coin={body.coin} leverage={body.leverage}x")
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
        result_data = await hyperliquid_service.set_leverage(
            private_key=private_key,
            master_address=body.wallet_address,
            coin=body.coin,
            leverage=body.leverage,
            is_cross=body.is_cross,
        )
    except Exception as exc:
        print(f"[set_leverage] ERROR: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "result": result_data}


# ---------------------------------------------------------------------------
# Trailing stop  (served under /orders via orders_router)
# ---------------------------------------------------------------------------

@orders_router.post("/trailing-stop")
async def create_trailing_stop(body: CreateTrailingStopRequest):
    logger.info(f"POST /orders/trailing-stop wallet={body.wallet_address} coin={body.coin} side={body.side}")
    db = _supabase()

    # Compute activation price
    if body.side == "long":
        activation_price = body.entry_price * (1 + body.activation_pct / 100)
    else:
        activation_price = body.entry_price * (1 - body.activation_pct / 100)

    now = datetime.now(timezone.utc).isoformat()

    # Cancel any existing waiting/active trailing stop for this wallet+coin
    existing = (
        db.table("trailing_stops")
        .select("id, status")
        .ilike("wallet_address", body.wallet_address)
        .eq("coin", body.coin)
        .in_("status", ["waiting", "active"])
        .execute()
    )
    for rec in (existing.data or []):
        db.table("trailing_stops").update({"status": "cancelled", "updated_at": now}).eq("id", rec["id"]).execute()

    # Insert new trailing stop
    insert_data = {
        "wallet_address": body.wallet_address.lower(),
        "coin": body.coin,
        "dex": body.dex,
        "side": body.side,
        "entry_price": body.entry_price,
        "activation_pct": body.activation_pct,
        "trail_pct": body.trail_pct,
        "activation_price": activation_price,
        "status": "waiting",
        "peak_price": None,
        "sl_oid": None,
        "current_sl_price": None,
        "created_at": now,
        "updated_at": now,
    }
    res = db.table("trailing_stops").insert(insert_data).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to create trailing stop")

    return {"success": True, "trailing_stop": res.data[0]}


@orders_router.delete("/trailing-stop/{ts_id}")
async def cancel_trailing_stop(ts_id: str, wallet_address: str = Query(...)):
    logger.info(f"DELETE /orders/trailing-stop/{ts_id} wallet={wallet_address}")
    db = _supabase()

    # Fetch record
    res = db.table("trailing_stops").select("*").eq("id", ts_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Trailing stop not found")
    rec = res.data[0]

    now = datetime.now(timezone.utc).isoformat()

    # If active and has a live SL order, cancel it on Hyperliquid
    if rec.get("status") == "active" and rec.get("sl_oid"):
        user_res = (
            db.table("users")
            .select("hyperliquid_api_key_encrypted")
            .ilike("wallet_address", wallet_address)
            .limit(1)
            .execute()
        )
        encrypted = (user_res.data[0] if user_res.data else {}).get("hyperliquid_api_key_encrypted")
        if encrypted:
            try:
                private_key = decrypt(encrypted)
                await hyperliquid_service.cancel_order(
                    private_key=private_key,
                    master_address=wallet_address,
                    coin=rec["coin"],
                    order_id=int(rec["sl_oid"]),
                )
            except Exception as exc:
                logger.warning(f"[cancel_trailing_stop] Could not cancel SL order on HL: {exc}")

    # Mark cancelled in DB
    db.table("trailing_stops").update({"status": "cancelled", "updated_at": now}).eq("id", ts_id).execute()

    return {"success": True}


@orders_router.get("/trailing-stops")
async def list_trailing_stops(wallet_address: str = Query(...)):
    logger.info(f"GET /orders/trailing-stops wallet={wallet_address}")
    db = _supabase()
    res = (
        db.table("trailing_stops")
        .select("*")
        .ilike("wallet_address", wallet_address)
        .in_("status", ["waiting", "active"])
        .order("created_at", desc=True)
        .execute()
    )
    return {"trailing_stops": res.data or []}
