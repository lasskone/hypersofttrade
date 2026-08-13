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


def ema(closes: list[float], period: int) -> list[float]:
    """Standard EMA seeded with the SMA of the first *period* bars.

    Returns a list whose length is ``len(closes) - period + 1`` (first value
    corresponds to index ``period - 1`` in *closes*).  Returns ``[]`` when there
    is insufficient data.
    """
    if len(closes) < period:
        return []
    k   = 2.0 / (period + 1)
    sma = sum(closes[:period]) / period
    out = [sma]
    for c in closes[period:]:
        out.append(c * k + out[-1] * (1.0 - k))
    return out


def rsi(closes: list[float], period: int) -> list[float]:
    """RSI using Wilder's smoothing.

    Returns one RSI value per bar starting from index *period* in *closes*
    (so the result list is shorter by *period* bars).  Returns ``[]`` when
    there is insufficient data.
    """
    if len(closes) < period + 1:
        return []

    gains:  list[float] = []
    losses: list[float] = []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append( max(d,  0.0))
        losses.append(max(-d, 0.0))

    avg_g = sum(gains[:period])  / period
    avg_l = sum(losses[:period]) / period

    def _rsi_from_avgs(ag: float, al: float) -> float:
        if al == 0.0:
            return 100.0
        return 100.0 - 100.0 / (1.0 + ag / al)

    out: list[float] = [_rsi_from_avgs(avg_g, avg_l)]

    for i in range(period, len(gains)):
        avg_g = (avg_g * (period - 1) + gains[i])  / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        out.append(_rsi_from_avgs(avg_g, avg_l))

    return out


def adx(candles: list[dict], period: int) -> float | None:
    """Average Directional Index via Wilder's smoothing.

    Returns the most recent ADX value as a float, or ``None`` when there
    are fewer than ``2 × period`` candles (the minimum needed for a stable
    seed + one smoothed cycle).

    Candle dicts must contain keys: ``high``, ``low``, ``close``.
    """
    n = len(candles)
    if n < period * 2:
        return None

    highs  = [c["high"]  for c in candles]
    lows   = [c["low"]   for c in candles]
    closes = [c["close"] for c in candles]

    tr_vals:  list[float] = []
    pdm_vals: list[float] = []  # +DM (directional movement)
    ndm_vals: list[float] = []  # -DM

    for i in range(1, n):
        h, l, pc  = highs[i], lows[i], closes[i - 1]
        ph, pl    = highs[i - 1], lows[i - 1]
        tr        = max(h - l, abs(h - pc), abs(l - pc))
        up_move   = h - ph
        dn_move   = pl - l
        pdm       = up_move if up_move > dn_move and up_move > 0.0 else 0.0
        ndm       = dn_move if dn_move > up_move and dn_move > 0.0 else 0.0
        tr_vals.append(tr)
        pdm_vals.append(pdm)
        ndm_vals.append(ndm)

    # Seed Wilder's smoothed sums with a plain sum of the first *period* values.
    sm_tr  = sum(tr_vals[:period])
    sm_pdm = sum(pdm_vals[:period])
    sm_ndm = sum(ndm_vals[:period])

    def _dx(sp: float, sn: float, st: float) -> float:
        if st == 0.0:
            return 0.0
        pdi, ndi = 100.0 * sp / st, 100.0 * sn / st
        denom    = pdi + ndi
        return 100.0 * abs(pdi - ndi) / denom if denom != 0.0 else 0.0

    dx_vals: list[float] = [_dx(sm_pdm, sm_ndm, sm_tr)]

    for i in range(period, len(tr_vals)):
        sm_tr  = sm_tr  - sm_tr  / period + tr_vals[i]
        sm_pdm = sm_pdm - sm_pdm / period + pdm_vals[i]
        sm_ndm = sm_ndm - sm_ndm / period + ndm_vals[i]
        dx_vals.append(_dx(sm_pdm, sm_ndm, sm_tr))

    if len(dx_vals) < period:
        return None

    # ADX = Wilder EMA of DX over *period*.
    adx_val = sum(dx_vals[:period]) / period
    for dx in dx_vals[period:]:
        adx_val = (adx_val * (period - 1) + dx) / period
    return adx_val


def atr(candles: list[dict], period: int) -> float | None:
    """Average True Range via Wilder's smoothing.

    Returns the most recent ATR value as a float, or ``None`` when there
    are fewer than ``period + 1`` candles (need at least *period* TR values
    to seed the Wilder average).

    Candle dicts must contain keys: ``high``, ``low``, ``close``.
    """
    n = len(candles)
    if n < period + 1:
        return None

    tr_vals: list[float] = []
    for i in range(1, n):
        h  = candles[i]["high"]
        l  = candles[i]["low"]
        pc = candles[i - 1]["close"]
        tr_vals.append(max(h - l, abs(h - pc), abs(l - pc)))

    if len(tr_vals) < period:
        return None

    # Seed: simple average of the first *period* TR values (Wilder's convention).
    atr_val = sum(tr_vals[:period]) / period

    # Wilder smoothing: ATR = (ATR_prev × (period − 1) + TR) / period
    for tr in tr_vals[period:]:
        atr_val = (atr_val * (period - 1) + tr) / period

    return atr_val
