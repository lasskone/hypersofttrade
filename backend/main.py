import asyncio
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.config import settings
from routers import account, bots
from routers.orders import router as market_router, orders_router
from routers.saved_backtests import router as saved_backtests_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("hypersofttrade")

app = FastAPI(
    title="HyperSoftTrade API",
    description="Backend API for the HyperSoftTrade crypto trading terminal.",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Global exception handler — catch ALL unhandled exceptions as JSON 500
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        raise exc
    logger.error(f"Unhandled exception on {request.url}: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# ---------------------------------------------------------------------------
# CORS — allow the Next.js frontend (and localhost for development)
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://hypersofttrade-frontend-production.up.railway.app",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(account.router,          prefix="/account",         tags=["account"])
app.include_router(market_router,           prefix="/market",          tags=["market"])
app.include_router(orders_router,           prefix="/orders",          tags=["orders"])
app.include_router(bots.router,             prefix="/bots",            tags=["bots"])
app.include_router(saved_backtests_router,  prefix="/backtest/saved",  tags=["backtest"])


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/health", tags=["health"])
async def health() -> dict:
    logger.info("GET /health")
    return {"status": "ok", "service": "hypersofttrade-api"}


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------
@app.get("/admin/bots", tags=["admin"])
async def admin_list_all_bots():
    """Admin route — returns ALL bots across all users with wallet_address joined."""
    logger.info("GET /admin/bots")
    from supabase import create_client
    import os
    from services.bot_manager import bot_manager
    db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    bots = db.table("bots").select("*, users(wallet_address)").order("created_at", desc=True).execute()
    result = []
    for b in bots.data:
        wallet = (b.pop("users", None) or {}).get("wallet_address", "")
        b["wallet_address"] = wallet
        b["is_running"] = bot_manager.is_running(b["id"])
        result.append(b)
    return {"bots": result}


# ---------------------------------------------------------------------------
# Backtest route
# ---------------------------------------------------------------------------
@app.post("/backtest", tags=["backtest"])
async def run_backtest(body: dict):
    from services.backtest_engine import run_grid_backtest, run_envelope_dca_backtest
    from services.hyperliquid_service import get_candles

    bot_type = body.get("bot_type", "grid")
    symbol = body.get("symbol", "BTC")
    dex = body.get("dex", "")
    interval = body.get("interval", "1h")
    limit = int(body.get("limit", 500))
    allocation = float(body.get("allocation", 1000))

    logger.info(f"POST /backtest bot_type={bot_type} symbol={symbol} interval={interval}")

    coin = f"{dex}:{symbol}" if dex else symbol

    try:
        candles = await asyncio.wait_for(get_candles(coin, interval, limit), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Candle fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch candles: {exc}")

    if len(candles) < 10:
        raise HTTPException(status_code=400, detail="Not enough historical data")

    try:
        if bot_type == "grid":
            result = run_grid_backtest(
                candles=candles,
                allocation=allocation,
                levels=int(body.get("levels", 10)),
                range_pct=float(body.get("range_pct", 5.0)),
                stop_loss_pct=float(body.get("stop_loss_pct", 10.0)),
                take_profit_pct=float(body.get("take_profit_pct", 30.0)),
            )
        elif bot_type == "envelope_dca":
            result = run_envelope_dca_backtest(
                candles=candles,
                allocation=allocation,
                ma_period=int(body.get("ma_period", 20)),
                envelope_1_pct=float(body.get("envelope_1_pct", 7.0)),
                envelope_2_pct=float(body.get("envelope_2_pct", 10.0)),
                envelope_3_pct=float(body.get("envelope_3_pct", 15.0)),
                stop_loss_pct=float(body.get("stop_loss_pct", 10.0)),
            )
        elif bot_type == "bb_rsi":
            from services.backtest_engine import run_bbrsi_backtest
            result = run_bbrsi_backtest(
                candles=candles,
                allocation=allocation,
                bb_period=int(body.get("bb_period", 20)),
                bb_std=float(body.get("bb_std", 2.0)),
                rsi_period=int(body.get("rsi_period", 14)),
                rsi_oversold=float(body.get("rsi_oversold", 30)),
                rsi_overbought=float(body.get("rsi_overbought", 70)),
                stop_loss_pct=float(body.get("stop_loss_pct", 5)),
                leverage=int(body.get("leverage", 1)),
            )
        elif bot_type == "ema_cross":
            from services.backtest_engine import run_emacross_backtest
            result = run_emacross_backtest(
                candles=candles,
                allocation=allocation,
                ema_fast=int(body.get("ema_fast", 9)),
                ema_slow=int(body.get("ema_slow", 21)),
                stop_loss_pct=float(body.get("stop_loss_pct", 5)),
                leverage=int(body.get("leverage", 1)),
            )
        elif bot_type == "passivbot_dca":
            from services.backtest_engine import run_passivbot_dca_backtest
            result = run_passivbot_dca_backtest(
                candles=candles,
                allocation=allocation,
                direction=str(body.get("direction", "long")),
                wallet_exposure_limit=float(body.get("wallet_exposure_limit", 0.1)),
                entry_initial_qty_pct=float(body.get("entry_initial_qty_pct", 0.01)),
                double_down_factor=float(body.get("double_down_factor", 0.9)),
                entry_grid_spacing_pct=float(body.get("entry_grid_spacing_pct", 0.003)),
                entry_grid_spacing_we_weight=float(body.get("entry_grid_spacing_we_weight", 0.5)),
                close_grid_markup_start=float(body.get("close_grid_markup_start", 0.001)),
                close_grid_markup_end=float(body.get("close_grid_markup_end", 0.003)),
                close_grid_qty_pct=float(body.get("close_grid_qty_pct", 0.05)),
                leverage=int(body.get("leverage", 1)),
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown bot type: {bot_type}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    result["symbol"] = coin
    result["interval"] = interval
    result["bot_type"] = bot_type
    return result
