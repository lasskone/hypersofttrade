"""
backend/bots/momentum_scalper/scanner.py

Phase 1 — Multi-pair Market Scanner + Opportunity Scoring Engine
for the Momentum Pullback Scalper bot.

This module is READ-ONLY market analysis.  No order-placing logic exists here.
Call ``scan_all()`` to get a ranked list of ``MarketScore`` objects for a set of
symbols, or ``scan_symbol()`` to evaluate a single symbol.

Scoring model (100 pts total):
    Trend score       20 pts   M5 candles — EMA alignment, RSI, ADX
    Momentum score    20 pts   M1 candles — price vs EMA, RSI, acceleration, volume
    Volume score      15 pts   M1 volume ratio vs 20-bar SMA (step function)
    Volatility score  15 pts   ATR(14, M1) as % of price (sweet-spot band)
    Pullback quality  10 pts   Distance from EMA20(M1) in ATR units + candle resumption
    Market structure  10 pts   HH/HL or LL/LH pivot pattern + breakout/breakdown
    Execution score   10 pts   Spread, order-book depth, slippage estimate

All indicator functions are imported from bots.shared_utils (ema, rsi, adx, atr)
and are pure — no side effects.  HTTP calls use the existing hyperliquid_service
singleton (get_orderbook) and the module-level get_candles helper.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from bots.shared_utils import ema, rsi, adx, atr
from services.hyperliquid_service import get_candles, hyperliquid_service

logger = logging.getLogger(__name__)

# ── Default scanner configuration ─────────────────────────────────────────────
# V1 starting values drawn from the spec's own parameter table.
# These are NOT back-test-validated — treat as a sensible starting point and
# tune against live data over time.
DEFAULT_SCANNER_CONFIG: dict = {
    # ── Trend filter (M5) ──────────────────────────────────────────────────────
    "ema_fast":    20,       # fast EMA period
    "ema_slow":    50,       # slow EMA period
    "rsi_period":  14,       # RSI period (shared across M5 and M1)
    "rsi_long":    55.0,     # RSI must be above this for a long trend signal
    "rsi_short":   45.0,     # RSI must be below this for a short trend signal
    "rsi_neutral": 50.0,     # midline used in momentum scoring
    "adx_period":  14,       # ADX period
    "min_adx":     20.0,     # ADX below this = market too flat for trend signals
    # ── ATR / volatility ──────────────────────────────────────────────────────
    "atr_period":  14,       # ATR period (M1)
    "min_atr_pct": 0.08,     # min ATR% — quieter markets score 0 volatility
    "max_atr_pct": 0.80,     # max ATR% — too-wild markets score 0 volatility
    # ── Entry quality ─────────────────────────────────────────────────────────
    "max_entry_distance_atr": 0.50,  # max distance from EMA20(M1) in ATR units
    # ── Execution ─────────────────────────────────────────────────────────────
    "max_spread_pct": 0.03,  # spreads wider than this score 0 execution points
    # ── Overall gate ──────────────────────────────────────────────────────────
    "min_score": 75.0,       # total_score threshold a caller may use to filter
}

# Candle-fetch limits.  Chosen to give each indicator enough warm-up bars even
# for the longest series required:
#   M5: EMA50 (50 bars) + ADX14 seed (28 bars) + buffer → 200
#   M1: EMA20 (20) + ATR14 (15) + vol SMA20 (21) + structure (30) + buffer → 100
_M5_LIMIT: int = 200
_M1_LIMIT: int = 100

# Minimum bars required after dropping the still-open current candle.
# M5: EMA50 warm-up (50) + ADX14 double-seed (28) + small buffer → 80
# M1: structure lookback (30) covers all shorter requirements
_M5_MIN: int = 80
_M1_MIN: int = 30

# Minimum trend score (0-20) for a direction to be declared non-neutral.
# Rationale: ADX alone can contribute up to 6 pts even for the "wrong" side
# (ADX is non-directional).  Requiring ≥ 8 means at least one of EMA alignment,
# price position, or RSI must fire with meaningful margin before a direction is
# declared — preventing a misclassification in choppy, high-ADX markets.
_MIN_TREND_FOR_DIRECTION: float = 8.0


# ── MarketScore ────────────────────────────────────────────────────────────────

@dataclass
class MarketScore:
    """Scored opportunity for one symbol.

    All sub-component scores sum to ``total_score`` (0–100).
    ``reasons`` contains one human-readable string per component explaining
    the inputs and the points awarded — suitable for logging and dashboards.
    """
    symbol:           str
    trend_score:      float       # 0-20
    momentum_score:   float       # 0-20
    volume_score:     float       # 0-15
    volatility_score: float       # 0-15
    pullback_score:   float       # 0-10
    structure_score:  float       # 0-10
    execution_score:  float       # 0-10
    total_score:      float       # 0-100
    direction:        str         # "long" | "short" | "neutral"
    atr_pct:          float       # ATR(14, M1) / price * 100
    spread_pct:       float       # (best_ask - best_bid) / mid * 100
    rsi_value:        float       # RSI(14) on M1, most recent closed bar
    adx_value:        float | None  # ADX(14) on M5, most recent closed bar
    reasons:          list[str] = field(default_factory=list)


# ── Internal helpers ───────────────────────────────────────────────────────────

def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _zero_score(symbol: str, reasons: list[str]) -> MarketScore:
    """Return a zeroed-out MarketScore with the supplied reasons list."""
    return MarketScore(
        symbol=symbol,
        trend_score=0.0, momentum_score=0.0, volume_score=0.0,
        volatility_score=0.0, pullback_score=0.0, structure_score=0.0,
        execution_score=0.0, total_score=0.0,
        direction="neutral", atr_pct=0.0, spread_pct=0.0,
        rsi_value=0.0, adx_value=None, reasons=reasons,
    )


def _vol_ratio(candles: list[dict]) -> float:
    """Ratio of the most-recent closed bar's volume to the 20-bar SMA before it.

    Returns 0.0 when fewer than 21 candles are available or average volume is 0.
    Requires candles to already have the current open bar dropped.
    """
    if len(candles) < 21:
        return 0.0
    vols = [c["volume"] for c in candles]
    avg20 = sum(vols[-21:-1]) / 20
    return vols[-1] / avg20 if avg20 > 0 else 0.0


def _swing_highs(candles: list[dict], lookback: int = 3) -> list[float]:
    """Return values of confirmed swing highs in chronological order.

    A bar at index ``i`` is a swing high when its ``high`` is strictly greater
    than every bar in the ``[i-lookback, i)`` and ``(i, i+lookback]`` windows.
    Requires at least ``2 * lookback + 1`` candles to produce any result.

    lookback=3 is the default: requires 3 confirming bars on each side, which
    filters single-bar spikes while still resolving within 3–4 M1 bars of a
    genuine turning point.  Increasing lookback adds lag; decreasing it adds noise.
    """
    highs = [c["high"] for c in candles]
    out: list[float] = []
    for i in range(lookback, len(highs) - lookback):
        h = highs[i]
        if (all(h > highs[j] for j in range(i - lookback, i)) and
                all(h > highs[j] for j in range(i + 1, i + lookback + 1))):
            out.append(h)
    return out


def _swing_lows(candles: list[dict], lookback: int = 3) -> list[float]:
    """Return values of confirmed swing lows in chronological order.

    Mirror of ``_swing_highs`` — see its docstring for parameter guidance.
    """
    lows = [c["low"] for c in candles]
    out: list[float] = []
    for i in range(lookback, len(lows) - lookback):
        lo = lows[i]
        if (all(lo < lows[j] for j in range(i - lookback, i)) and
                all(lo < lows[j] for j in range(i + 1, i + lookback + 1))):
            out.append(lo)
    return out


# ── Core scoring function ──────────────────────────────────────────────────────

async def scan_symbol(symbol: str, config: dict) -> MarketScore:
    """Evaluate *symbol* and return a fully populated ``MarketScore``.

    Fetches M5 candles, M1 candles, and the order book concurrently.
    All candle series drop the current (potentially still-open) bar before
    computing any indicator.

    *config* is merged over ``DEFAULT_SCANNER_CONFIG`` so callers only need to
    supply the keys they want to override.

    This function never places an order.
    """
    cfg = {**DEFAULT_SCANNER_CONFIG, **config}
    reasons: list[str] = []

    # ── Fetch data ─────────────────────────────────────────────────────────────
    m5_raw, m1_raw, ob = await asyncio.gather(
        get_candles(symbol, "5m", _M5_LIMIT),
        get_candles(symbol, "1m", _M1_LIMIT),
        hyperliquid_service.get_orderbook(symbol),
    )

    # Drop the current (still-open) candle so every indicator uses closed bars only.
    m5 = m5_raw[:-1] if len(m5_raw) > 1 else m5_raw
    m1 = m1_raw[:-1] if len(m1_raw) > 1 else m1_raw

    # ── Minimum data guard ─────────────────────────────────────────────────────
    if len(m5) < _M5_MIN:
        reasons.append(
            f"Insufficient M5 data: {len(m5)} bars available, {_M5_MIN} required"
        )
        return _zero_score(symbol, reasons)
    if len(m1) < _M1_MIN:
        reasons.append(
            f"Insufficient M1 data: {len(m1)} bars available, {_M1_MIN} required"
        )
        return _zero_score(symbol, reasons)

    # ── M5 indicators ─────────────────────────────────────────────────────────
    m5_closes = [c["close"] for c in m5]

    ema20_m5_vals = ema(m5_closes, cfg["ema_fast"])
    ema50_m5_vals = ema(m5_closes, cfg["ema_slow"])
    rsi14_m5_vals = rsi(m5_closes, cfg["rsi_period"])
    adx14_m5      = adx(m5, cfg["adx_period"])

    if not ema20_m5_vals or not ema50_m5_vals or not rsi14_m5_vals:
        reasons.append("M5 indicator computation failed (insufficient data after warm-up)")
        return _zero_score(symbol, reasons)

    ema20_m5 = ema20_m5_vals[-1]
    ema50_m5 = ema50_m5_vals[-1]
    rsi14_m5 = rsi14_m5_vals[-1]
    price_m5  = m5_closes[-1]

    # ── TREND SCORE (20 pts) ───────────────────────────────────────────────────
    # Four sub-components and their max points:
    #   EMA separation     5 pts   How far apart are EMA20 and EMA50 as % of EMA50?
    #                              Full 5 at ≥ 0.5% separation.  Threshold chosen
    #                              because a 0.5% gap on M5 typically reflects a
    #                              sustained multi-hour trend, not a random cross.
    #   Price vs EMA20     3 pts   Is price on the correct side of EMA20?
    #                              Full 3 at ≥ 0.2% above/below.  0.2% on M5 is
    #                              roughly one average-range candle worth of cushion.
    #   RSI excess         6 pts   How far past rsi_long / rsi_short is RSI?
    #                              Full 6 at 15 RSI units past the threshold
    #                              (e.g. RSI=70 for long at threshold=55).
    #                              Chosen because RSI rarely exceeds 80/20 sustainably;
    #                              15 units past threshold covers the "comfortably
    #                              trending" zone without requiring extreme readings.
    #   ADX strength       6 pts   How far above min_adx is ADX?
    #                              Full 6 at 20 units above min_adx (e.g. ADX=40
    #                              when min_adx=20).  ADX=40 is a commonly cited
    #                              "strong trend" threshold; linear scaling from 20.

    def _score_trend_side(
        ema_fast: float, ema_slow: float, px: float,
        rsi_val: float, rsi_thresh: float,
        adx_val: float | None, is_long: bool,
    ) -> tuple[float, str]:
        """Return (score 0-20, reason string) for one trend direction."""
        if is_long:
            sep_pct    = (ema_fast - ema_slow) / ema_slow * 100
            px_diff    = (px - ema_fast) / ema_fast * 100
            rsi_excess = rsi_val - rsi_thresh
        else:
            sep_pct    = (ema_slow - ema_fast) / ema_slow * 100
            px_diff    = (ema_fast - px) / ema_fast * 100
            rsi_excess = rsi_thresh - rsi_val

        ema_sc   = _clamp(sep_pct  / 0.5,  0.0, 1.0) * 5.0
        price_sc = _clamp(px_diff  / 0.2,  0.0, 1.0) * 3.0
        rsi_sc   = _clamp(rsi_excess / 15.0, 0.0, 1.0) * 6.0

        if adx_val is not None:
            adx_sc = _clamp((adx_val - cfg["min_adx"]) / 20.0, 0.0, 1.0) * 6.0
        else:
            adx_sc = 0.0

        total  = ema_sc + price_sc + rsi_sc + adx_sc
        side   = "LONG" if is_long else "SHORT"
        adx_s  = f"{adx_val:.1f}" if adx_val is not None else "N/A"
        reason = (
            f"Trend {side}: EMA sep={sep_pct:+.2f}% ({ema_sc:.1f}/5), "
            f"px vs EMA20={px_diff:+.2f}% ({price_sc:.1f}/3), "
            f"RSI={rsi_val:.1f} ({rsi_sc:.1f}/6), "
            f"ADX={adx_s} ({adx_sc:.1f}/6) → {total:.1f}/20"
        )
        return total, reason

    long_trend_sc,  long_trend_reason  = _score_trend_side(
        ema20_m5, ema50_m5, price_m5, rsi14_m5, cfg["rsi_long"],  adx14_m5, True
    )
    short_trend_sc, short_trend_reason = _score_trend_side(
        ema20_m5, ema50_m5, price_m5, rsi14_m5, cfg["rsi_short"], adx14_m5, False
    )

    if long_trend_sc >= short_trend_sc and long_trend_sc >= _MIN_TREND_FOR_DIRECTION:
        direction   = "long"
        trend_score = long_trend_sc
        reasons.append(long_trend_reason)
    elif short_trend_sc > long_trend_sc and short_trend_sc >= _MIN_TREND_FOR_DIRECTION:
        direction   = "short"
        trend_score = short_trend_sc
        reasons.append(short_trend_reason)
    else:
        direction   = "neutral"
        trend_score = 0.0
        reasons.append(
            f"Trend: NEUTRAL (long={long_trend_sc:.1f}, short={short_trend_sc:.1f} — "
            f"neither ≥ {_MIN_TREND_FOR_DIRECTION} threshold) → 0/20"
        )

    # ── M1 indicators ─────────────────────────────────────────────────────────
    m1_closes = [c["close"] for c in m1]

    ema20_m1_vals = ema(m1_closes, cfg["ema_fast"])
    rsi14_m1_vals = rsi(m1_closes, cfg["rsi_period"])
    atr14_m1      = atr(m1, cfg["atr_period"])

    ema20_m1 = ema20_m1_vals[-1] if ema20_m1_vals else None
    rsi14_m1 = rsi14_m1_vals[-1] if rsi14_m1_vals else 0.0
    price_m1  = m1_closes[-1]
    vol_ratio = _vol_ratio(m1)
    atr_pct   = (atr14_m1 / price_m1 * 100) if (atr14_m1 and price_m1 > 0) else 0.0

    # ── MOMENTUM SCORE (20 pts, M1) ───────────────────────────────────────────
    # Four sub-components (5 pts each):
    #   1. Price vs EMA20(M1)   Full 5 at ≥ 0.15% on the correct side of EMA20.
    #                           0.15% chosen (vs 0.2% for M5) because M1 bars are
    #                           smaller — a 0.15% move is roughly 1 average M1 range.
    #   2. RSI(M1) past midline Full 5 at RSI 20 units past 50 (e.g. RSI=70 for long).
    #                           Same reasoning as trend RSI: covers the "cleanly
    #                           trending" zone without requiring extreme values.
    #   3. Price acceleration   Count of the last 3 close-to-close moves in the trend
    #                           direction.  Score = (count / 3) × 5.  This rewards
    #                           genuine momentum without requiring all 3 bars to agree.
    #   4. Volume confirmation  Proportional from 0.8× to 1.5× average volume (same
    #                           scale as the standalone volume score, mapped to 5 pts).
    #                           Denominaor 0.7 = 1.5 - 0.8: full score at vol_ratio ≥ 1.5.

    if direction == "neutral" or ema20_m1 is None:
        momentum_score = 0.0
        reasons.append("Momentum: NEUTRAL (no trend direction or missing M1 EMA) → 0/20")
    else:
        is_long = direction == "long"

        if is_long:
            px_diff_pct = (price_m1 - ema20_m1) / ema20_m1 * 100
            rsi_excess  = rsi14_m1 - cfg["rsi_neutral"]
        else:
            px_diff_pct = (ema20_m1 - price_m1) / ema20_m1 * 100
            rsi_excess  = cfg["rsi_neutral"] - rsi14_m1

        mom_price_sc = _clamp(px_diff_pct / 0.15, 0.0, 1.0) * 5.0
        mom_rsi_sc   = _clamp(rsi_excess  / 20.0, 0.0, 1.0) * 5.0

        # Acceleration: last 3 close-to-close deltas in the trend direction.
        n_acc = 0
        for i in range(1, 4):
            if i + 1 <= len(m1_closes):
                delta = m1_closes[-i] - m1_closes[-(i + 1)]
                if (is_long and delta > 0) or (not is_long and delta < 0):
                    n_acc += 1
        mom_accel_sc = (n_acc / 3) * 5.0

        # Volume confirmation (same ratio as volume score; mapped to 5-pt scale).
        mom_vol_sc = _clamp((vol_ratio - 0.8) / 0.7, 0.0, 1.0) * 5.0

        momentum_score = mom_price_sc + mom_rsi_sc + mom_accel_sc + mom_vol_sc
        reasons.append(
            f"Momentum ({direction.upper()}): "
            f"px vs EMA20(M1)={px_diff_pct:+.2f}% ({mom_price_sc:.1f}/5), "
            f"RSI(M1)={rsi14_m1:.1f} ({mom_rsi_sc:.1f}/5), "
            f"accel={n_acc}/3 bars ({mom_accel_sc:.1f}/5), "
            f"vol_ratio={vol_ratio:.2f} ({mom_vol_sc:.1f}/5) → {momentum_score:.1f}/20"
        )

    # ── VOLUME SCORE (15 pts) ─────────────────────────────────────────────────
    # Step function matching the spec table exactly.
    if   vol_ratio < 0.80: volume_score = 0.0
    elif vol_ratio < 1.00: volume_score = 5.0
    elif vol_ratio < 1.25: volume_score = 10.0
    elif vol_ratio < 1.50: volume_score = 13.0
    else:                  volume_score = 15.0
    reasons.append(f"Volume: ratio={vol_ratio:.2f} → {volume_score:.0f}/15")

    # ── VOLATILITY SCORE (15 pts) ─────────────────────────────────────────────
    # Sweet-spot band: 0.12–0.50% ATR gives the optimal balance between enough
    # price movement for scalping profit and not so much that stops get run on noise.
    if atr14_m1 is None:
        volatility_score = 0.0
        reasons.append("Volatility: ATR unavailable → 0/15")
    elif atr_pct < 0.08 or atr_pct > 0.80:
        volatility_score = 0.0
        reasons.append(
            f"Volatility: ATR%={atr_pct:.3f}% "
            f"({'too quiet' if atr_pct < 0.08 else 'too wild'}) → 0/15"
        )
    elif atr_pct < 0.12:
        volatility_score = 7.0
        reasons.append(f"Volatility: ATR%={atr_pct:.3f}% (low) → 7/15")
    elif atr_pct < 0.20:
        volatility_score = 12.0
        reasons.append(f"Volatility: ATR%={atr_pct:.3f}% (moderate) → 12/15")
    elif atr_pct < 0.50:
        volatility_score = 15.0
        reasons.append(f"Volatility: ATR%={atr_pct:.3f}% (optimal) → 15/15")
    else:   # 0.50 – 0.80
        volatility_score = 8.0
        reasons.append(f"Volatility: ATR%={atr_pct:.3f}% (elevated) → 8/15")

    # ── PULLBACK QUALITY (10 pts) ─────────────────────────────────────────────
    # Distance component (7 pts): how close is price to EMA20(M1) in ATR units?
    #   Full 7 at distance_atr = 0 (right at EMA20), 0 at max_entry_distance_atr (0.50).
    #   Linear interpolation between 0 and max_entry_distance_atr.
    #   Rationale: a pullback that hasn't touched or returned to EMA20 isn't really
    #   a pullback — it's still in the trending move.  distance_atr > 0.50 means price
    #   is half an ATR past EMA, which the spec explicitly defines as "chasing" territory.
    # Resumption component (3 pts): does the last closed M1 bar close in the trend
    #   direction (bullish body for long, bearish body for short)?  This confirms that
    #   the pullback has actually reversed rather than still moving against the trend.

    if direction == "neutral" or ema20_m1 is None or not atr14_m1:
        pullback_score = 0.0
        reasons.append(
            "Pullback: NEUTRAL or missing ATR/EMA20(M1) data → 0/10"
        )
    else:
        distance_atr = abs(price_m1 - ema20_m1) / atr14_m1
        max_dist     = cfg["max_entry_distance_atr"]

        dist_sc = _clamp(1.0 - distance_atr / max_dist, 0.0, 1.0) * 7.0

        last_bar  = m1[-1]
        resuming  = (
            last_bar["close"] > last_bar["open"] if direction == "long"
            else last_bar["close"] < last_bar["open"]
        )
        resume_sc = 3.0 if resuming else 0.0

        pullback_score = dist_sc + resume_sc
        reasons.append(
            f"Pullback: dist={distance_atr:.2f} ATR from EMA20(M1) "
            f"({dist_sc:.1f}/7), "
            f"{'resuming ✓' if resuming else 'not resuming ✗'} ({resume_sc:.0f}/3) "
            f"→ {pullback_score:.1f}/10"
        )

    # ── MARKET STRUCTURE (10 pts) ─────────────────────────────────────────────
    # Uses the most recent 30 M1 candles with a pivot lookback of 3 bars.
    # Points:
    #   LONG:  Higher High +4, Higher Low +4, breakout above recent swing high +2
    #   SHORT: Lower Low  +4, Lower High  +4, breakdown below recent swing low  +2
    # Pivot detection: see _swing_highs / _swing_lows docstrings.
    # A breakout/breakdown is defined as current price crossing the most recent
    # confirmed swing high/low — which confirms that the structure is actively
    # being extended rather than merely having formed in the past.

    _STRUCT_LOOKBACK = 3
    struct_candles = m1[-30:] if len(m1) >= 30 else m1
    s_highs = _swing_highs(struct_candles, _STRUCT_LOOKBACK)
    s_lows  = _swing_lows(struct_candles,  _STRUCT_LOOKBACK)

    if direction == "neutral":
        structure_score = 0.0
        reasons.append("Structure: NEUTRAL → 0/10")
    elif direction == "long":
        hh = len(s_highs) >= 2 and s_highs[-1] > s_highs[-2]
        hl = len(s_lows)  >= 2 and s_lows[-1]  > s_lows[-2]
        bo = bool(s_highs) and price_m1 > s_highs[-1]
        structure_score = (4.0 if hh else 0.0) + (4.0 if hl else 0.0) + (2.0 if bo else 0.0)
        reasons.append(
            f"Structure LONG: HH={'✓' if hh else '✗'} HL={'✓' if hl else '✗'} "
            f"breakout={'✓' if bo else '✗'} → {structure_score:.0f}/10"
        )
    else:   # short
        ll = len(s_lows)  >= 2 and s_lows[-1]  < s_lows[-2]
        lh = len(s_highs) >= 2 and s_highs[-1] < s_highs[-2]
        bd = bool(s_lows) and price_m1 < s_lows[-1]
        structure_score = (4.0 if ll else 0.0) + (4.0 if lh else 0.0) + (2.0 if bd else 0.0)
        reasons.append(
            f"Structure SHORT: LL={'✓' if ll else '✗'} LH={'✓' if lh else '✗'} "
            f"breakdown={'✓' if bd else '✗'} → {structure_score:.0f}/10"
        )

    # ── EXECUTION SCORE (10 pts) ──────────────────────────────────────────────
    # Three sub-components sourced from the live order book:
    #
    # Spread (5 pts): tight spread → efficient market, lower execution cost.
    #   ≤0.01% → 5 | 0.01-0.02% → 4 | 0.02-0.03% → 2 | >0.03% → 0
    #
    # Liquidity depth (3 pts): combined USD depth within 0.1% of mid price.
    #   Threshold: $500k USD combined (bids + asks within the 0.1% band).
    #   Chosen as ~10× a typical $50k position — enough absorption for entry
    #   and exit without meaningful market impact at the intended size.
    #   Score = min(3, depth_usd / $500k × 3)  [linear, capped at 3].
    #
    # Slippage estimate (2 pts): heuristic combining spread and depth.
    #   Very tight spread (≤0.01%) AND deep book (≥$1M) → likely near-zero slippage → 2.
    #   Moderate spread (≤0.02%) AND adequate depth (≥$500k)                         → 1.
    #   Otherwise                                                                    → 0.
    #   This is intentionally simple — precise slippage estimation requires a live
    #   fill simulation that is out of scope for Phase 1.

    bids = ob.get("bids", [])
    asks = ob.get("asks", [])
    spread_pct = 0.0

    if not bids or not asks:
        execution_score = 0.0
        reasons.append("Execution: no order-book data → 0/10")
    else:
        try:
            best_bid = float(bids[0]["px"])
            best_ask = float(asks[0]["px"])
            mid_px   = (best_bid + best_ask) / 2.0
            spread_pct = (best_ask - best_bid) / mid_px * 100.0 if mid_px > 0 else 0.0

            # Spread score
            if   spread_pct <= 0.01: spread_sc = 5
            elif spread_pct <= 0.02: spread_sc = 4
            elif spread_pct <= 0.03: spread_sc = 2
            else:                    spread_sc = 0

            # Depth within 0.1% of mid
            _BAND  = 0.001   # 0.1%
            _DEPTH_THRESHOLD_USD = 500_000.0
            bid_sz = sum(
                float(b["sz"]) for b in bids
                if float(b["px"]) >= mid_px * (1.0 - _BAND)
            )
            ask_sz = sum(
                float(a["sz"]) for a in asks
                if float(a["px"]) <= mid_px * (1.0 + _BAND)
            )
            depth_usd = (bid_sz + ask_sz) * mid_px
            liq_sc    = _clamp(depth_usd / _DEPTH_THRESHOLD_USD * 3.0, 0.0, 3.0)

            # Slippage heuristic
            if   spread_pct <= 0.01 and depth_usd >= 1_000_000: slip_sc = 2
            elif spread_pct <= 0.02 and depth_usd >= 500_000:   slip_sc = 1
            else:                                                 slip_sc = 0

            execution_score = spread_sc + liq_sc + slip_sc
            reasons.append(
                f"Execution: spread={spread_pct:.4f}% ({spread_sc}/5), "
                f"depth=${depth_usd:,.0f} ({liq_sc:.1f}/3), "
                f"slippage_est ({slip_sc}/2) → {execution_score:.1f}/10"
            )
        except (KeyError, ValueError, ZeroDivisionError) as exc:
            execution_score = 0.0
            reasons.append(f"Execution: order-book parse error ({exc}) → 0/10")

    # ── Assemble final score ───────────────────────────────────────────────────
    total_score = (
        trend_score + momentum_score + volume_score +
        volatility_score + pullback_score + structure_score + execution_score
    )

    return MarketScore(
        symbol           = symbol,
        trend_score      = round(trend_score, 2),
        momentum_score   = round(momentum_score, 2),
        volume_score     = float(volume_score),
        volatility_score = float(volatility_score),
        pullback_score   = round(pullback_score, 2),
        structure_score  = float(structure_score),
        execution_score  = round(execution_score, 2),
        total_score      = round(total_score, 2),
        direction        = direction,
        atr_pct          = round(atr_pct, 4),
        spread_pct       = round(spread_pct, 4),
        rsi_value        = round(rsi14_m1, 2),
        adx_value        = round(adx14_m5, 2) if adx14_m5 is not None else None,
        reasons          = reasons,
    )


# ── Multi-symbol scan ──────────────────────────────────────────────────────────

async def scan_all(symbols: list[str], config: dict) -> list[MarketScore]:
    """Scan all *symbols* concurrently and return results sorted by total_score descending.

    Individual symbol failures (API error, insufficient data) are caught and logged;
    the failed symbol is excluded from the returned list rather than crashing the scan.

    *config* is passed through to each ``scan_symbol()`` call unchanged.
    """
    async def _safe_scan(sym: str) -> MarketScore | None:
        try:
            return await scan_symbol(sym, config)
        except Exception as exc:
            logger.error(f"[scanner] {sym}: scan failed — {exc}")
            return None

    raw = await asyncio.gather(*(_safe_scan(s) for s in symbols))
    results = [r for r in raw if r is not None]
    return sorted(results, key=lambda r: r.total_score, reverse=True)
