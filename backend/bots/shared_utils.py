"""Shared utility functions used across bot strategies."""
from __future__ import annotations
import math


def round_price(price: float) -> float:
    """Round price to Hyperliquid tick size based on magnitude."""
    if price >= 1000:
        return round(price)
    elif price >= 10:
        return round(price, 1)
    else:
        return round(price, 2)


def round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor
