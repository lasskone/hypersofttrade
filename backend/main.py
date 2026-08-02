import asyncio
import logging
import os

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
_extra_origin = os.environ.get("FRONTEND_URL", "").strip()
_allowed_origins = [
    "https://hypersofttrade-frontend-production.up.railway.app",
    "https://hypersofttrade.com",
    "https://www.hypersofttrade.com",
    "https://api.hypersofttrade.com",
    "http://localhost:3000",
]
if _extra_origin and _extra_origin not in _allowed_origins:
    _allowed_origins.append(_extra_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
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
    from services.backtest_engine import run_trend_magic_backtest
    from services.hyperliquid_service import get_candles

    bot_type = body.get("bot_type", "grid")
    symbol = body.get("symbol", "BTC")
    dex = body.get("dex", "")
    interval = body.get("interval", "1h")
    limit = int(body.get("limit", 500))
    allocation = float(body.get("allocation", 1000))

    logger.info(f"POST /backtest bot_type={bot_type} symbol={symbol} interval={interval}")

    coin = f"{dex}:{symbol}" if dex else symbol

    # Trend Magic needs 1m candles for OHLC-accurate simulation
    if bot_type == "trend_magic":
        date_range_days = int(body.get("date_range_days", 14))
        fetch_interval  = "1m"
        fetch_limit     = date_range_days * 24 * 60   # up to 20,160 candles
        fetch_timeout   = 30.0
    else:
        fetch_interval = interval
        fetch_limit    = limit
        fetch_timeout  = 10.0

    try:
        candles = await asyncio.wait_for(get_candles(coin, fetch_interval, fetch_limit), timeout=fetch_timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Candle fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch candles: {exc}")

    if len(candles) < 10:
        raise HTTPException(status_code=400, detail="Not enough historical data")

    try:
        if bot_type == "trend_magic":
            result = run_trend_magic_backtest(
                candles_1m=candles,
                allocation=allocation,
                rsi_period=int(body.get("rsi_period", 14)),
                rsi_overbought=float(body.get("rsi_overbought", 70.0)),
                rsi_oversold=float(body.get("rsi_oversold", 30.0)),
                ema_period=int(body.get("ema_period", 200)),
                dca_level_1_pct=float(body.get("dca_level_1_pct", 7.0)),
                dca_level_2_pct=float(body.get("dca_level_2_pct", 14.0)),
                tp_pct=float(body.get("tp_pct", 5.0)),
                trailing_stop_pct=float(body.get("trailing_stop_pct", 1.0)),
                leverage=int(body.get("leverage", 1)),
                sides=body.get("sides") or ["long", "short"],
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unknown bot type: {bot_type}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    result["symbol"] = coin
    result["interval"] = interval
    result["bot_type"] = bot_type
    return result
