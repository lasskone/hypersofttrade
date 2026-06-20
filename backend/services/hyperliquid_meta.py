"""
Shared utility for fetching Hyperliquid per-coin metadata (szDecimals, maxLeverage, etc.)
dynamically instead of hardcoding values. Cached in-memory for 5 minutes to avoid
excessive API calls while still staying correct if Hyperliquid changes listings.
"""
from __future__ import annotations
import time
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"

_cache: dict | None = None
_cache_time: float = 0
_CACHE_TTL = 300  # 5 minutes


async def _get_universe() -> list[dict]:
    global _cache, _cache_time
    now = time.time()
    if _cache is not None and (now - _cache_time) < _CACHE_TTL:
        return _cache
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(INFO_ENDPOINT, json={"type": "meta"})
        data = resp.json()
    universe = data.get("universe", [])
    _cache = universe
    _cache_time = now
    return universe


async def get_coin_meta(coin: str) -> dict:
    """
    Returns the Hyperliquid meta dict for a coin, e.g.
    {"name": "BTC", "szDecimals": 5, "maxLeverage": 40, "marginTableId": 56}
    Handles HIP-3 prefixed coins like "xyz:XYZ100" by matching on the base symbol
    if the full prefixed name isn't found in the main universe.
    Raises ValueError if the coin cannot be found.
    """
    universe = await _get_universe()
    # Try exact match first
    for c in universe:
        if c.get("name") == coin:
            return c
    # Try matching just the symbol part after ':' for HIP-3 coins
    base_symbol = coin.split(":")[-1] if ":" in coin else coin
    for c in universe:
        if c.get("name") == base_symbol:
            return c
    raise ValueError(f"Coin '{coin}' not found in Hyperliquid universe metadata")


async def get_sz_decimals(coin: str, fallback: int = 4) -> int:
    """
    Returns szDecimals for a coin. Falls back to `fallback` only if the coin
    cannot be resolved at all (e.g. a HIP-3 perp not in the standard universe —
    in that case the per-DEX meta endpoint should be used instead, which callers
    handling HIP-3 dexes should query separately).
    """
    try:
        meta = await get_coin_meta(coin)
        return int(meta.get("szDecimals", fallback))
    except Exception:
        return fallback


async def get_max_leverage(coin: str, fallback: int = 10) -> int:
    try:
        meta = await get_coin_meta(coin)
        return int(meta.get("maxLeverage", fallback))
    except Exception:
        return fallback
