"""
backend/scanner/technical_scanner.py

Standalone technical signal detector.  READ-ONLY — no orders, no state.

Signals detected per coin per timeframe (15m / 1h / 4h):
  • rsi_divergence_bullish / rsi_divergence_bearish
      Price makes a new swing extreme while RSI diverges in the opposite
      direction — classic early-warning of a potential reversal.
  • ema200_cross_up / ema200_cross_down
      Close crossed the EMA(200) between the previous and current closed bar.
  • ema361_cross_up / ema361_cross_down
      Same for EMA(361) — the Fibonacci-period longer-term MA.
  • breakout_up / breakout_down
      Close of the current bar exceeds the highest high / lowest low of the
      prior 20 closed bars.

Public API
----------
scan_pair_all_timeframes(coin, dex) -> list[dict]
    Fetch 15m/1h/4h candles concurrently, run all detectors, return a list of
    {timeframe, signal_type, price} dicts for every signal found.  Returns []
    when no signal fires — that is the expected outcome most of the time.

detect_rsi_divergence(candles, rsi_period, lookback) -> "bullish" | "bearish" | None
detect_ema_cross(candles, ema_period) -> "up" | "down" | None
detect_breakout(candles, lookback) -> "up" | "down" | None
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from bots.shared_utils import ema, rsi
from services.hyperliquid_service import get_candles

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Candle fetch limit
# EMA(361) requires 361 bars minimum; we fetch 500 to leave plenty of warmup.
# ---------------------------------------------------------------------------
_CANDLE_LIMIT = 500

# Pivot lookback for divergence detection (same algorithm as
# momentum_scalper/scanner.py _swing_highs / _swing_lows, extended to also
# return bar indices required for RSI comparison).
_DIV_PIVOT_LOOKBACK = 3


# ---------------------------------------------------------------------------
# Internal pivot helpers
# ---------------------------------------------------------------------------

def _swing_highs_idx(candles: list[dict], lookback: int = 3) -> list[tuple[int, float]]:
    """Return (bar_index, high_value) pairs for confirmed swing highs.

    Algorithm is identical to momentum_scalper/scanner.py's _swing_highs —
    bar i is a swing high when high[i] is strictly greater than every bar in
    the [i-lookback, i) and (i, i+lookback] windows.  The only extension here
    is returning the index alongside the value so callers can look up the
    corresponding RSI value at the same bar for divergence comparison.
    """
    highs = [c["high"] for c in candles]
    out: list[tuple[int, float]] = []
    for i in range(lookback, len(highs) - lookback):
        h = highs[i]
        if (all(h > highs[j] for j in range(i - lookback, i)) and
                all(h > highs[j] for j in range(i + 1, i + lookback + 1))):
            out.append((i, h))
    return out


def _swing_lows_idx(candles: list[dict], lookback: int = 3) -> list[tuple[int, float]]:
    """Return (bar_index, low_value) pairs for confirmed swing lows.

    Mirror of _swing_highs_idx — see its docstring for parameter guidance.
    """
    lows = [c["low"] for c in candles]
    out: list[tuple[int, float]] = []
    for i in range(lookback, len(lows) - lookback):
        lo = lows[i]
        if (all(lo < lows[j] for j in range(i - lookback, i)) and
                all(lo < lows[j] for j in range(i + 1, i + lookback + 1))):
            out.append((i, lo))
    return out


# ---------------------------------------------------------------------------
# Detection functions
# ---------------------------------------------------------------------------

def detect_rsi_divergence(
    candles: list[dict],
    rsi_period: int = 14,
    lookback: int = 30,
    oversold_threshold: float = 30.0,
    overbought_threshold: float = 70.0,
) -> Optional[str]:
    """Detect classic RSI divergence on the most recent closed bars.

    Returns 'bullish', 'bearish', or None.

    Mandatory zone requirements (all four conditions must hold, or None is returned):
    ─────────────────────────────────────────────────────────────────────────────────
    BULLISH divergence:
      1. First (older) swing low RSI  ≤ oversold_threshold  (leg started in oversold)
      2. Second (recent) swing low RSI > oversold_threshold  (RSI exited the zone)
      3. Price:  second low  < first low   (lower low in price)
      4. RSI:    second RSI  > first RSI   (higher low in RSI — momentum diverges)

    BEARISH divergence:
      1. First (older) swing high RSI  ≥ overbought_threshold  (leg started overbought)
      2. Second (recent) swing high RSI < overbought_threshold  (RSI exited the zone)
      3. Price:  second high > first high  (higher high in price)
      4. RSI:    second RSI  < first RSI   (lower high in RSI — momentum diverges)

    Without the zone requirement (conditions 1 & 2) the detector fires on neutral-zone
    pivots that never represented an exhausted trend — producing false signals.

    Implementation detail
    ---------------------
    We need rsi_period bars of warmup before the lookback window so that
    RSI values are available for every bar inside the pivot window.  We
    therefore slice candles[-(lookback + rsi_period):] to get the combined
    warmup + analysis window, compute RSI over that full slice, then restrict
    pivot detection to the final `lookback` bars where RSI is available.

    The RSI index aligns with the pivot-window bar index directly:
      rsi_vals[i]   ↔   pivot_window[i]   (both share the same offset)
    """
    total_needed = rsi_period + 2 * _DIV_PIVOT_LOOKBACK + 2
    if len(candles) < total_needed:
        return None

    # Warmup slice + analysis window
    window = candles[-(lookback + rsi_period):]
    closes = [c["close"] for c in window]
    rsi_vals = rsi(closes, rsi_period)       # length = len(window) - rsi_period
    if len(rsi_vals) < 2 * _DIV_PIVOT_LOOKBACK + 1:
        return None

    # pivot_window has exactly len(rsi_vals) bars — RSI indices align 1-to-1.
    pivot_window = window[rsi_period:]

    # ── Bullish divergence: compare last two swing LOWS ───────────────────────
    lows_idx = _swing_lows_idx(pivot_window, _DIV_PIVOT_LOOKBACK)
    if len(lows_idx) >= 2:
        (i1, price_lo1), (i2, price_lo2) = lows_idx[-2], lows_idx[-1]
        rsi_lo1, rsi_lo2 = rsi_vals[i1], rsi_vals[i2]
        if (
            rsi_lo1 <= oversold_threshold       # cond 1: first leg started oversold
            and rsi_lo2 > oversold_threshold    # cond 2: second leg exited oversold
            and price_lo2 < price_lo1           # cond 3: price made lower low
            and rsi_lo2 > rsi_lo1               # cond 4: RSI made higher low
        ):
            return "bullish"

    # ── Bearish divergence: compare last two swing HIGHS ─────────────────────
    highs_idx = _swing_highs_idx(pivot_window, _DIV_PIVOT_LOOKBACK)
    if len(highs_idx) >= 2:
        (i1, price_hi1), (i2, price_hi2) = highs_idx[-2], highs_idx[-1]
        rsi_hi1, rsi_hi2 = rsi_vals[i1], rsi_vals[i2]
        if (
            rsi_hi1 >= overbought_threshold     # cond 1: first leg started overbought
            and rsi_hi2 < overbought_threshold  # cond 2: second leg exited overbought
            and price_hi2 > price_hi1           # cond 3: price made higher high
            and rsi_hi2 < rsi_hi1               # cond 4: RSI made lower high
        ):
            return "bearish"

    return None


def detect_ema_cross(
    candles: list[dict],
    ema_period: int,
) -> Optional[str]:
    """Detect a price/EMA crossover between the last two closed bars.

    Returns 'up' (close crossed above EMA), 'down' (crossed below), or None.

    The shared_utils.ema() series aligns with closes at the tail: ema_vals[-1]
    corresponds to closes[-1], ema_vals[-2] to closes[-2], etc.  We compare
    the close-vs-EMA relationship one bar ago against the current bar to
    identify a fresh crossover.
    """
    closes = [c["close"] for c in candles]
    ema_vals = ema(closes, ema_period)
    if len(ema_vals) < 2:
        return None

    prev_close, curr_close = closes[-2], closes[-1]
    prev_ema,  curr_ema   = ema_vals[-2], ema_vals[-1]

    if prev_close < prev_ema and curr_close > curr_ema:
        return "up"
    if prev_close > prev_ema and curr_close < curr_ema:
        return "down"
    return None


def detect_breakout(
    candles: list[dict],
    lookback: int = 20,
) -> Optional[str]:
    """Detect a Donchian-channel breakout on the last closed bar.

    Returns 'up' (close > highest high of prior lookback bars),
            'down' (close < lowest low of prior lookback bars), or None.

    The reference range uses the `lookback` bars immediately BEFORE the
    current (last) bar — the current bar is excluded so we compare its close
    against a pre-existing channel, not one it is part of.
    """
    if len(candles) < lookback + 1:
        return None

    ref = candles[-(lookback + 1):-1]   # the lookback bars before current
    curr_close = candles[-1]["close"]

    channel_hi = max(c["high"] for c in ref)
    channel_lo = min(c["low"]  for c in ref)

    if curr_close > channel_hi:
        return "up"
    if curr_close < channel_lo:
        return "down"
    return None


# ---------------------------------------------------------------------------
# Multi-timeframe scan
# ---------------------------------------------------------------------------

async def scan_pair_all_timeframes(
    coin: str,
    dex: str = "",
) -> list[dict]:
    """Scan a single coin across 15m, 1h, and 4h timeframes concurrently.

    Runs all four detectors (RSI divergence, EMA200 cross, EMA361 cross,
    breakout) on each timeframe.  Returns a flat list of signal dicts:
        {"timeframe": str, "signal_type": str, "price": float, "bar_time": int}
    bar_time is the epoch-seconds open timestamp of the triggering candle (the
    last closed bar) — the same value get_candles() stores in candle["time"].
    Returns [] when no signal fires — that is the normal, expected outcome.

    The current still-open bar is dropped before any indicator is computed,
    matching the convention used throughout the codebase.
    """
    timeframes = ["15m", "1h", "4h"]

    raw = await asyncio.gather(
        *[get_candles(coin, tf, _CANDLE_LIMIT) for tf in timeframes],
        return_exceptions=True,
    )

    signals: list[dict] = []

    for tf, result in zip(timeframes, raw):
        if isinstance(result, Exception):
            logger.warning("[technical_scanner] %s/%s fetch failed: %s", coin, tf, result)
            continue
        if not result:
            logger.warning("[technical_scanner] %s/%s returned empty candles", coin, tf)
            continue

        # Drop the still-open current bar (last element).
        candles = result[:-1]
        if not candles:
            continue

        price    = float(candles[-1]["close"])
        bar_time = int(candles[-1]["time"])   # epoch seconds — open time of triggering bar

        # ── RSI divergence ────────────────────────────────────────────────────
        div = detect_rsi_divergence(candles)
        if div == "bullish":
            signals.append({"timeframe": tf, "signal_type": "rsi_divergence_bullish", "price": price, "bar_time": bar_time})
        elif div == "bearish":
            signals.append({"timeframe": tf, "signal_type": "rsi_divergence_bearish", "price": price, "bar_time": bar_time})

        # ── EMA(200) cross ────────────────────────────────────────────────────
        x200 = detect_ema_cross(candles, 200)
        if x200 == "up":
            signals.append({"timeframe": tf, "signal_type": "ema200_cross_up", "price": price, "bar_time": bar_time})
        elif x200 == "down":
            signals.append({"timeframe": tf, "signal_type": "ema200_cross_down", "price": price, "bar_time": bar_time})

        # ── EMA(361) cross ────────────────────────────────────────────────────
        x361 = detect_ema_cross(candles, 361)
        if x361 == "up":
            signals.append({"timeframe": tf, "signal_type": "ema361_cross_up", "price": price, "bar_time": bar_time})
        elif x361 == "down":
            signals.append({"timeframe": tf, "signal_type": "ema361_cross_down", "price": price, "bar_time": bar_time})

        # ── Donchian breakout ─────────────────────────────────────────────────
        bo = detect_breakout(candles)
        if bo == "up":
            signals.append({"timeframe": tf, "signal_type": "breakout_up", "price": price, "bar_time": bar_time})
        elif bo == "down":
            signals.append({"timeframe": tf, "signal_type": "breakout_down", "price": price, "bar_time": bar_time})

    return signals
