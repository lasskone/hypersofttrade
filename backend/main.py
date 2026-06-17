from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from routers import account, orders, bots

app = FastAPI(
    title="HyperSoftTrade API",
    description="Backend API for the HyperSoftTrade crypto trading terminal.",
    version="0.1.0",
)

# ---------------------------------------------------------------------------
# CORS — allow the Next.js frontend (and localhost for development)
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(account.router, prefix="/account", tags=["account"])
app.include_router(orders.router, prefix="/orders", tags=["orders"])
app.include_router(bots.router, prefix="/bots", tags=["bots"])


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok", "service": "hypersofttrade-api"}
