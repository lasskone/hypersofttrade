import asyncio
import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.config import settings
from routers import account, bots
from services.backtest_engine import backtest_rsi_dca_grid
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
    from services.hyperliquid_service import get_candles

    # DIAGNOSTIC — log the full raw body so we can confirm what the frontend sends
    logger.info(f"POST /backtest RAW BODY: {body}")

    bot_type = body.get("bot_type")
    if not bot_type:
        raise HTTPException(status_code=400, detail="bot_type is required")

    symbol = body.get("symbol", "BTC")
    dex = body.get("dex", "")
    interval = body.get("interval", "1h")
    limit = int(body.get("limit", 500))
    allocation = float(body.get("allocation", 1000))

    logger.info(f"POST /backtest bot_type={bot_type} symbol={symbol} interval={interval}")

    coin = f"{dex}:{symbol}" if dex else symbol

    try:
        candles = await asyncio.wait_for(
            get_candles(coin, interval, limit), timeout=10.0
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Candle fetch timed out — upstream Hyperliquid API too slow")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch candles: {exc}")

    if len(candles) < 10:
        raise HTTPException(status_code=400, detail="Not enough historical data")

    if bot_type == "rsi_dca":
        from services.hyperliquid_meta import get_sz_decimals

        date_range_days = int(body.get("date_range_days", 90))
        ema_period      = int(body.get("ema_period", 200))

        # Context candles are always 1h (EMA / ADX filter)
        if interval == "1h":
            candles_context = candles
        else:
            ctx_limit = min(date_range_days * 24 + ema_period + 50, 5000)
            try:
                candles_context = await asyncio.wait_for(
                    get_candles(coin, "1h", ctx_limit), timeout=15.0
                )
            except asyncio.TimeoutError:
                raise HTTPException(status_code=503, detail="Context candle fetch timed out")
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"Failed to fetch context candles: {exc}")

        sz_decimals = await get_sz_decimals(coin)

        # sides / dca_pcts may come from the body or fall back to strategy defaults
        sides    = body.get("sides", ["long", "short"])
        dca_pcts = [float(p) for p in body.get("dca_pcts", [2.0, 4.0, 7.0, 12.0])]

        result = await backtest_rsi_dca_grid(
            candles_entry         = candles,
            candles_context       = candles_context,
            allocated_usdc        = allocation,
            leverage              = int(body.get("leverage",              1)),
            sz_decimals           = sz_decimals,
            sides                 = sides,
            ema_period            = ema_period,
            use_adx_filter        = bool(int(body.get("use_adx_filter",  0))),
            adx_period            = int(body.get("adx_period",           14)),
            adx_threshold         = float(body.get("adx_threshold",      25)),
            rsi_period            = int(body.get("rsi_period",           14)),
            rsi_oversold          = float(body.get("rsi_oversold",       30)),
            rsi_overbought        = float(body.get("rsi_overbought",     70)),
            use_time_window       = bool(int(body.get("use_time_window", 0))),
            window_start_utc_hour = int(body.get("window_start_utc_hour", 0)),
            window_end_utc_hour   = int(body.get("window_end_utc_hour",  24)),
            use_volume_filter     = bool(int(body.get("use_volume_filter", 0))),
            volume_multiplier     = float(body.get("volume_multiplier",  1.3)),
            volume_lookback       = int(body.get("volume_lookback",      20)),
            dca_pcts              = dca_pcts,
            sl_pct                = float(body.get("sl_pct",             3)),
            tp_pct                = float(body.get("tp_pct",             1.5)),
            cooldown_candles      = int(body.get("cooldown_candles",     3)),
        )

        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])

        result.update(symbol=symbol, interval=interval, bot_type=bot_type)
        return result

    raise HTTPException(status_code=400, detail=f"Unknown bot type: {bot_type}")
