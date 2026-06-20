"""
Shared utility for fetching Hyperliquid per-coin metadata (szDecimals, maxLeverage, etc.)
dynamically instead of hardcoding values. Supports both the standard universe and
HIP-3 dex-specific universes (e.g. "xyz:TSLA"). Cached in-memory per dex for 5 minutes
to avoid excessive API calls while staying correct if Hyperliquid changes listings.
"""
from __future__ import annotations
import time
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"

# Cache keyed by dex name ("" = standard universe, "xyz" = HIP-3 dex, etc.)
_cache: dict[str, list[dict]] = {}
_cache_time: dict[str, float] = {}
_CACHE_TTL = 300  # 5 minutes


async def _get_universe(dex: str = "") -> list[dict]:
    now = time.time()
    if dex in _cache and (now - _cache_time.get(dex, 0)) < _CACHE_TTL:
        return _cache[dex]

    payload: dict = {"type": "meta"}
    if dex:
        payload["dex"] = dex

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(INFO_ENDPOINT, json=payload)
        data = resp.json()

    universe = data.get("universe", [])
    _cache[dex] = universe
    _cache_time[dex] = now
    return universe


def _split_coin(coin: str) -> tuple[str, str]:
    """
    Splits a coin identifier into (dex, symbol).
    "BTC" -> ("", "BTC")
    "xyz:TSLA" -> ("xyz", "TSLA")
    """
    if ":" in coin:
        dex, symbol = coin.split(":", 1)
        return dex, symbol
    return "", coin


async def get_coin_meta(coin: str) -> dict:
    """
    Returns the Hyperliquid meta dict for a coin, e.g.
    {"name": "TSLA", "szDecimals": 3, "maxLeverage": 20, ...}
    Correctly resolves HIP-3 dex-specific coins like "xyz:TSLA" by querying
    that dex's own universe (NOT the standard universe).
    Raises ValueError if the coin cannot be found.
    """
    dex, symbol = _split_coin(coin)
    universe = await _get_universe(dex)

    for c in universe:
        if c.get("name") == symbol:
            return c

    # If not found and we queried a specific dex, do not silently fall back
    # to the standard universe — dex-specific symbols are not crypto perps
    # and a fallback would return wrong metadata.
    raise ValueError(f"Coin '{symbol}' not found in Hyperliquid universe (dex='{dex or 'standard'}')")


async def get_sz_decimals(coin: str, fallback: int = 4) -> int:
    """
    Returns szDecimals for a coin (handles both standard and HIP-3 dex coins).
    Falls back to `fallback` only if the coin cannot be resolved at all.
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
