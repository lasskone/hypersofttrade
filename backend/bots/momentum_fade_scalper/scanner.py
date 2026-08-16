"""
backend/bots/momentum_fade_scalper/scanner.py

Phase 1 — Market Scanner for the Momentum Fade Scalper bot.

Design philosophy (distinct from momentum_scalper):
───────────────────────────────────────────────────
momentum_scalper uses RSI(14) + ADX on M5 candles with a 7-component weighted
score (100 pts).  That model works well for sustained-trend pullback entries but
accumulates lag on M1 scalping because:
  • RSI(14) is slow to react on 1-minute bars — extreme-zone trigger misses
    early in a momentum move.
  • ADX is a lagging trend-strength indicator (requires ~2× period of history
    to warm up); on M1 it often confirms a move well after the best entry.

This scanner uses three faster-reacting signals instead:
  1. RSI(7) midline-cross trigger — half the period of the default; crosses the
     50-line at the start of a momentum shift rather than waiting for extreme
     zones.  Catching the cross *through* 50 (not from 30 or 70) means we enter
     early in the momentum burst, not after a full trend leg.
  2. Kaufman Efficiency Ratio (ER, period 14) replaces ADX.  ER measures how
     directionally efficient recent price movement is (net move ÷ total path).
     A high ER means the market is trending cleanly; a low ER means it is
     chopping.  Unlike ADX, ER uses only closes (same data as RSI) and requires
     only period+1 bars — much less warm-up lag on M1.
  3. Fast EMAs (9/21, M1 only) for directional bias rather than M5 trend
     confirmation — keeps the whole signal chain on a single timeframe and
     avoids the cross-timeframe alignment delay.

Qualification is binary (all-or-nothing), not weighted:
  direction is set by EMA9/21 cross → RSI(7) must cross 50 in the same
  direction → ER must exceed threshold → volume must be elevated → spread
  must be tight.  All five gates must pass.  No partial credit.

This module is READ-ONLY market analysis.  No order-placing logic exists here.
Call scan_all() to get qualifying FadeMarketScore objects, or scan_symbol() for
a single symbol.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from bots.shared_utils import ema, rsi, atr, kaufman_efficiency_ratio
from services.hyperliquid_service import get_candles, hyperliquid_service

logger = logging.getLogger(__name__)

# ── Default scanner configuration ─────────────────────────────────────────────
DEFAULT_SCANNER_CONFIG: dict = {
    # ── EMAs (M1, directional bias) ───────────────────────────────────────────
    "ema_fast": 9,               # fast EMA — reacts within ~5 bars
    "ema_slow": 21,              # slow EMA — medium-term bias anchor
    # ── RSI (M1, momentum trigger) ────────────────────────────────────────────
    "rsi_period": 7,             # half the default period → less lag on M1
    # ── Efficiency Ratio filter (replaces ADX) ────────────────────────────────
    "min_efficiency_ratio": 0.3, # 0 = pure chop, 1 = perfectly linear move;
                                 # 0.3 keeps noisy low-ER periods out
    # ── Volume filter ─────────────────────────────────────────────────────────
    "min_volume_ratio": 1.3,     # current bar volume must be ≥ 1.3× 20-bar SMA
    # ── Execution filter ──────────────────────────────────────────────────────
    "max_spread_pct": 0.03,      # bid-ask spread as % of mid; 0.03 = 3 bps
    # ── ATR (for atr_pct logging only, not a gate) ────────────────────────────
    "atr_period": 14,
}

# Candle fetch limits — fetch extra so warm-up bars don't consume real signal.
_M1_LIMIT = 120   # need ≥ max(21 EMA slow, 7+1 RSI, 14+1 ER, 20 vol SMA) + buffer


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class FadeMarketScore:
    """
    Result of a single-symbol scan.  All indicator snapshots are the *most
    recent closed bar* value (current still-open bar is always dropped).

    Fields
    ------
    symbol          : Hyperliquid coin ticker (e.g. "BTC", "ETH")
    direction       : EMA9/21 bias — "long" | "short" | "neutral"
    ema9            : Latest EMA(9) value
    ema21           : Latest EMA(21) value
    rsi7            : Latest RSI(7) value
    efficiency_ratio: Kaufman ER over last 14 bars, or None if insufficient data
    atr_pct         : ATR(14) as % of current price (for logging / downstream use)
    volume_ratio    : Current-bar volume ÷ 20-bar volume SMA
    spread_pct      : (ask − bid) / mid × 100 at scan time
    qualifies       : True iff ALL five gates passed (hard gate, not weighted)
    reasons         : Human-readable list of which checks passed / failed
    """
    symbol: str
    direction: str                      # "long" | "short" | "neutral"
    ema9: float
    ema21: float
    rsi7: float
    efficiency_ratio: float | None
    atr_pct: float
    volume_ratio: float
    spread_pct: float
    qualifies: bool
    reasons: list[str] = field(default_factory=list)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _vol_sma(candles: list[dict], period: int = 20) -> float:
    """Return SMA of volume over the last *period* closed candles."""
    vols = [c["volume"] for c in candles[-period:]]
    return sum(vols) / len(vols) if vols else 0.0


def _zero_score(symbol: str, reasons: list[str]) -> FadeMarketScore:
    """Return a non-qualifying placeholder with zeroed indicator fields."""
    return FadeMarketScore(
        symbol=symbol,
        direction="neutral",
        ema9=0.0,
        ema21=0.0,
        rsi7=0.0,
        efficiency_ratio=None,
        atr_pct=0.0,
        volume_ratio=0.0,
        spread_pct=0.0,
        qualifies=False,
        reasons=reasons,
    )


# ── Single-symbol scanner ─────────────────────────────────────────────────────

async def scan_symbol(symbol: str, config: dict) -> FadeMarketScore:
    """
    Evaluate a single symbol and return a FadeMarketScore.

    Gates (all must pass for qualifies=True):
      1. Direction  — EMA9 vs EMA21 must not be neutral
      2. RSI cross  — RSI(7) must have crossed 50 in the direction's favour
                      on the most recent closed bar
      3. ER filter  — Kaufman Efficiency Ratio > min_efficiency_ratio
      4. Volume     — current bar volume ≥ min_volume_ratio × 20-bar SMA
      5. Spread     — bid-ask spread ≤ max_spread_pct

    Parameters
    ----------
    symbol : Hyperliquid ticker string (e.g. "BTC")
    config : Scanner config dict; missing keys fall back to DEFAULT_SCANNER_CONFIG
    """
    cfg = {**DEFAULT_SCANNER_CONFIG, **config}
    reasons: list[str] = []

    # ── 1. Fetch data concurrently ────────────────────────────────────────────
    m1_raw, ob = await asyncio.gather(
        get_candles(symbol, "1m", _M1_LIMIT),
        hyperliquid_service.get_orderbook(symbol),
        return_exceptions=True,
    )

    if isinstance(m1_raw, Exception) or not m1_raw:
        return _zero_score(symbol, [f"candle fetch failed: {m1_raw}"])
    if isinstance(ob, Exception):
        ob = {"bids": [], "asks": []}

    # Drop the current still-open candle (last bar).
    candles = m1_raw[:-1]

    # Minimum data guard — need at least ema_slow + a few bars of headroom.
    min_bars = max(cfg["ema_slow"], cfg["rsi_period"] + 1, 20) + 5
    if len(candles) < min_bars:
        return _zero_score(symbol, [f"insufficient closed bars: {len(candles)} < {min_bars}"])

    closes = [c["close"] for c in candles]

    # ── 2. Compute indicators ─────────────────────────────────────────────────

    # EMA9 / EMA21 (directional bias)
    ema9_vals  = ema(closes, cfg["ema_fast"])
    ema21_vals = ema(closes, cfg["ema_slow"])
    if not ema9_vals or not ema21_vals:
        return _zero_score(symbol, ["EMA computation failed (insufficient data)"])
    ema9_cur  = ema9_vals[-1]
    ema21_cur = ema21_vals[-1]

    # RSI(7) — need at least 2 values to check for a cross.
    rsi7_vals = rsi(closes, cfg["rsi_period"])
    if len(rsi7_vals) < 2:
        return _zero_score(symbol, ["RSI computation failed (insufficient data)"])
    rsi7_prev = rsi7_vals[-2]
    rsi7_cur  = rsi7_vals[-1]

    # Kaufman Efficiency Ratio (14)
    er = kaufman_efficiency_ratio(closes, cfg["atr_period"])  # atr_period doubles as ER period

    # ATR(14) as % of price — for logging only, not a gate.
    atr_val = atr(candles, cfg["atr_period"])
    last_price = closes[-1]
    atr_pct = (atr_val / last_price * 100.0) if (atr_val and last_price) else 0.0

    # Volume ratio — current bar vs 20-bar SMA of the preceding bars.
    current_vol = candles[-1]["volume"]
    sma_vol     = _vol_sma(candles[:-1], period=20)   # SMA of bars before current
    volume_ratio = (current_vol / sma_vol) if sma_vol > 0 else 0.0

    # Spread from order book.
    spread_pct = 0.0
    try:
        bids = ob.get("bids", [])
        asks = ob.get("asks", [])
        if bids and asks:
            bid = float(bids[0]["px"])
            ask = float(asks[0]["px"])
            mid = (bid + ask) / 2.0
            if mid > 0:
                spread_pct = (ask - bid) / mid * 100.0
    except Exception as exc:
        reasons.append(f"spread calc error: {exc}")

    # ── 3. Direction gate ─────────────────────────────────────────────────────
    if ema9_cur > ema21_cur:
        direction = "long"
        reasons.append(f"EMA9({ema9_cur:.4f}) > EMA21({ema21_cur:.4f}) → long bias")
    elif ema9_cur < ema21_cur:
        direction = "short"
        reasons.append(f"EMA9({ema9_cur:.4f}) < EMA21({ema21_cur:.4f}) → short bias")
    else:
        direction = "neutral"
        reasons.append("EMA9 == EMA21 → neutral, no trade")
        return FadeMarketScore(
            symbol=symbol, direction=direction,
            ema9=ema9_cur, ema21=ema21_cur, rsi7=rsi7_cur,
            efficiency_ratio=er, atr_pct=atr_pct,
            volume_ratio=volume_ratio, spread_pct=spread_pct,
            qualifies=False, reasons=reasons,
        )

    # ── 4. RSI(7) midline-cross trigger ──────────────────────────────────────
    # A cross *through* 50 is the early signal: it fires at the start of a
    # momentum shift, not after RSI has spent bars in an extreme zone (which
    # would confirm a move that is already well underway).
    rsi_crossed_long  = rsi7_prev <= 50.0 and rsi7_cur > 50.0
    rsi_crossed_short = rsi7_prev >= 50.0 and rsi7_cur < 50.0

    if direction == "long":
        rsi_trigger = rsi_crossed_long
        if rsi_trigger:
            reasons.append(f"RSI7 crossed above 50 ({rsi7_prev:.1f} → {rsi7_cur:.1f}) ✓")
        else:
            reasons.append(f"RSI7 did not cross above 50 ({rsi7_prev:.1f} → {rsi7_cur:.1f}) ✗")
    else:  # short
        rsi_trigger = rsi_crossed_short
        if rsi_trigger:
            reasons.append(f"RSI7 crossed below 50 ({rsi7_prev:.1f} → {rsi7_cur:.1f}) ✓")
        else:
            reasons.append(f"RSI7 did not cross below 50 ({rsi7_prev:.1f} → {rsi7_cur:.1f}) ✗")

    # ── 5. Efficiency Ratio gate ──────────────────────────────────────────────
    er_ok = er is not None and er > cfg["min_efficiency_ratio"]
    if er is None:
        reasons.append("ER unavailable (insufficient data) ✗")
    elif er_ok:
        reasons.append(f"ER={er:.3f} > {cfg['min_efficiency_ratio']} (clean trend) ✓")
    else:
        reasons.append(f"ER={er:.3f} ≤ {cfg['min_efficiency_ratio']} (choppy) ✗")

    # ── 6. Volume gate ────────────────────────────────────────────────────────
    vol_ok = volume_ratio >= cfg["min_volume_ratio"]
    if vol_ok:
        reasons.append(f"volume_ratio={volume_ratio:.2f} ≥ {cfg['min_volume_ratio']} ✓")
    else:
        reasons.append(f"volume_ratio={volume_ratio:.2f} < {cfg['min_volume_ratio']} ✗")

    # ── 7. Spread gate ────────────────────────────────────────────────────────
    spread_ok = spread_pct <= cfg["max_spread_pct"]
    if spread_pct == 0.0 and not reasons[-1].startswith("spread calc"):
        # Orderbook was empty — treat as failing (conservative).
        spread_ok = False
        reasons.append("spread=0 (empty orderbook) ✗")
    elif spread_ok:
        reasons.append(f"spread={spread_pct:.4f}% ≤ {cfg['max_spread_pct']}% ✓")
    else:
        reasons.append(f"spread={spread_pct:.4f}% > {cfg['max_spread_pct']}% ✗")

    # ── 8. Final qualification (hard gate — all must pass) ────────────────────
    qualifies = (
        direction != "neutral"
        and rsi_trigger
        and er_ok
        and vol_ok
        and spread_ok
    )

    return FadeMarketScore(
        symbol=symbol,
        direction=direction,
        ema9=ema9_cur,
        ema21=ema21_cur,
        rsi7=rsi7_cur,
        efficiency_ratio=er,
        atr_pct=atr_pct,
        volume_ratio=volume_ratio,
        spread_pct=spread_pct,
        qualifies=qualifies,
        reasons=reasons,
    )


# ── Multi-symbol concurrent scan ─────────────────────────────────────────────

async def scan_all(
    symbols: list[str],
    config: dict,
) -> list[FadeMarketScore]:
    """
    Scan *symbols* concurrently and return qualifying results sorted by
    Efficiency Ratio descending (strongest clean trend first).

    Per-symbol exceptions are caught, logged, and excluded from results —
    a single failing symbol never crashes the whole scan.

    Parameters
    ----------
    symbols : List of Hyperliquid ticker strings
    config  : Scanner config dict (merged over DEFAULT_SCANNER_CONFIG per symbol)

    Returns
    -------
    List of FadeMarketScore where qualifies=True, sorted by efficiency_ratio DESC.
    """
    tasks = [scan_symbol(sym, config) for sym in symbols]
    raw: list[FadeMarketScore | BaseException] = await asyncio.gather(
        *tasks, return_exceptions=True
    )

    qualifying: list[FadeMarketScore] = []
    for sym, result in zip(symbols, raw):
        if isinstance(result, BaseException):
            logger.error("scan_symbol(%s) raised: %s", sym, result)
            continue
        if result.qualifies:
            qualifying.append(result)

    # Sort by ER descending — among qualifying setups, prefer the cleanest trend.
    qualifying.sort(
        key=lambda r: r.efficiency_ratio if r.efficiency_ratio is not None else 0.0,
        reverse=True,
    )
    return qualifying
