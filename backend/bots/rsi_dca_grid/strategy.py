"""
RSI DCA Grid bot — live trading strategy for HyperSoftTrade.

Entry logic
-----------
On each entry-timeframe candle close:
  1. Context filter: EMA(ema_period) on context_timeframe + optional ADX gate.
     Long trades only above EMA (trend up); short trades only below EMA (trend down).
     If use_adx_filter, require ADX < adx_threshold — confirming a ranging (not
     trending) market where RSI mean-reversion is statistically more reliable.
  2. Time-window filter: restrict new entries to a configured UTC hour range.
  3. Volume filter: current candle volume >= volume_multiplier × rolling average.
  4. Entry trigger: RSI crossover on the last two *closed* entry-timeframe candles.
       Long : RSI[-2] < rsi_oversold  AND RSI[-1] >= rsi_oversold  (bounce from oversold)
       Short: RSI[-2] > rsi_overbought AND RSI[-1] <= rsi_overbought (rejection from overbought)

Position management
-------------------
On entry:
  • Place a market IOC order sized for 1/(1+N_dca) of total allocated capital,
    leaving the remainder reserved for DCA fills (see Sizing section below).
  • Wait 2 s, then fetch the live position from Hyperliquid clearinghouse to
    confirm fill and get the exact entryPx (volume-weighted average used by HL).
  • Register a position_group for MagicID tracking.
  • Place N GTC limit DCA orders at the configured percentage distances from entry.
  • Place initial SL (stop-market, reduce-only) anchored to entry price.
  • Place initial TP (trigger, reduce-only) at tp_pct above (long) / below (short)
    the volume-weighted average entry price.

On each subsequent tick (every 30 s when in_position):
  • If position is flat → _on_close() path.
  • Otherwise, diff known DCA oids against live open orders. For each filled DCA
    level: update position_size and vwap_entry from clearinghouse, move
    sl_ref_price to the price of the deepest filled DCA level, cancel+replace
    SL and TP for the enlarged position.

On close (TP / SL / flat position detected):
  • Cancel all resting DCA / SL / TP orders.
  • Close the position_group.
  • Enter COOLDOWN for cooldown_candles ticks before accepting a new entry.

Sizing
------
Capital is split equally across (1 + N_dca) grid levels.  A 20/20/20/20/20
split at 5 levels is the default with dca_pcts=[2,4,7,12] and keeps each level
uniform — this is the simplest defensible choice and ensures the DCA cascade
can be fully deployed within the allocated budget.

    per_level_usdc = allocated_usdc / (1 + len(dca_pcts))
    per_level_size = (per_level_usdc × leverage) / mark_price

Sizes are floor-rounded (round_size) and bumped up to the $10 minimum notional
if floor-rounding would push them below Hyperliquid's exchange minimum.

Entry timeframe
---------------
entry_timeframe (default "15m") controls RSI / volume computation and sets the
tick cadence in IDLE / COOLDOWN states.  It is intentionally separate from
context_timeframe (default "1h") so the context (trend) and trigger (RSI
momentum) can run at different resolutions.  Both can be set to the same value
if desired.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Callable

from bots.shared_utils import round_price, round_size
from services.hyperliquid_service import get_candles, hyperliquid_service
from services.position_groups import (
    close_position_group,
    create_position_group,
    get_open_position_group,
)

logger = logging.getLogger(__name__)

# Hyperliquid exchange minimum notional per order (USD).
_HL_MIN_NOTIONAL: float = 10.0

# Candle-fetch limits — sized to supply all indicators with warm-up data.
# Context (EMA200 + ADX14): 300 bars covers EMA seed (200) + ADX seed (28) + buffer.
# Entry  (RSI14 + vol20):   100 bars covers RSI seed (14) + volume_lookback (20) + buffer.
_CONTEXT_CANDLE_LIMIT: int = 300
_ENTRY_CANDLE_LIMIT:   int = 100

# Interval string → milliseconds.  Mirrors get_candles() internal table.
_INTERVAL_MS: dict[str, int] = {
    "1m":  60_000,    "3m":  180_000,   "5m":  300_000,
    "15m": 900_000,   "30m": 1_800_000, "1h":  3_600_000,
    "2h":  7_200_000, "4h":  14_400_000,"8h":  28_800_000,
    "12h": 43_200_000,"1d":  86_400_000,
}

# While in_position, poll this frequently (seconds) to detect DCA fills / closes.
_IN_POSITION_POLL_S: float = 30.0


# ── Time helpers ──────────────────────────────────────────────────────────────

def _seconds_to_next_candle(interval_ms: int) -> float:
    """Return seconds until the next candle boundary for *interval_ms*."""
    now_ms  = time.time() * 1000
    next_ms = math.ceil(now_ms / interval_ms) * interval_ms
    return max(5.0, (next_ms - now_ms) / 1000.0)


# ── SDK response helpers ──────────────────────────────────────────────────────

def _extract_oid(result: dict | None) -> int | None:
    """Extract the integer order-ID from an SDK-shaped order response dict."""
    if not isinstance(result, dict):
        return None
    try:
        statuses = result["response"]["data"]["statuses"]
        for s in statuses:
            if "resting" in s:
                return int(s["resting"]["oid"])
            if "filled" in s:
                return int(s["filled"]["oid"])
    except (KeyError, TypeError, ValueError, IndexError):
        pass
    return None


# ── Indicator computations (pure functions, no side-effects) ──────────────────

def _ema(closes: list[float], period: int) -> list[float]:
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


def _rsi(closes: list[float], period: int) -> list[float]:
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


def _adx(candles: list[dict], period: int) -> float | None:
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
    adx = sum(dx_vals[:period]) / period
    for dx in dx_vals[period:]:
        adx = (adx * (period - 1) + dx) / period
    return adx


# ── Main bot class ────────────────────────────────────────────────────────────

class RSIDCAGridBot:
    """Live RSI mean-reversion bot with a DCA grid, SL anchored to deepest fill,
    and TP computed from the volume-weighted average entry price.

    See module docstring for a full description of the strategy and sizing model.
    """

    def __init__(
        self,
        *,
        private_key: str,
        master_address: str,
        coin: str,
        sz_decimals: int,
        dex: str = "",
        allocated_usdc: float = 100.0,
        leverage: int = 1,
        sides: list[str] | None = None,
        # Timeframes
        entry_timeframe: str = "15m",
        context_timeframe: str = "1h",
        # Context filter
        ema_period: int = 200,
        use_adx_filter: bool = True,
        adx_period: int = 14,
        adx_threshold: float = 25.0,
        # Entry trigger
        rsi_period: int = 14,
        rsi_oversold: float = 30.0,
        rsi_overbought: float = 70.0,
        # Time window
        use_time_window: bool = True,
        window_start_utc_hour: int = 0,
        window_end_utc_hour: int = 8,
        # Volume filter
        use_volume_filter: bool = True,
        volume_multiplier: float = 1.3,
        volume_lookback: int = 20,
        # DCA grid
        dca_pcts: list[float] | None = None,
        # SL / TP
        sl_pct: float = 3.0,
        tp_pct: float = 1.5,
        # Cooldown
        cooldown_candles: int = 3,
        # Infrastructure
        db_client=None,
        bot_id: str | None = None,
        log_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        # ── Credentials & market ───────────────────────────────────────────────
        self._private_key    = private_key
        self._master_address = master_address
        self._coin           = coin
        self._sz_decimals    = sz_decimals
        self._dex            = dex or ""

        # Short coin name used for position matching (strips HIP-3 dex prefix).
        self._short_coin = coin.split(":")[-1] if ":" in coin else coin

        # ── Capital ────────────────────────────────────────────────────────────
        self._allocated_usdc   = float(allocated_usdc)
        self._leverage         = int(leverage)
        self._sides            = sides if sides is not None else ["long", "short"]

        # ── Timeframes ─────────────────────────────────────────────────────────
        self._entry_tf   = entry_timeframe    # RSI + volume + tick cadence
        self._context_tf = context_timeframe  # EMA + ADX

        # ── Context filter ─────────────────────────────────────────────────────
        self._ema_period     = int(ema_period)
        self._use_adx_filter = bool(use_adx_filter)
        self._adx_period     = int(adx_period)
        self._adx_threshold  = float(adx_threshold)

        # ── Entry trigger ──────────────────────────────────────────────────────
        self._rsi_period     = int(rsi_period)
        self._rsi_oversold   = float(rsi_oversold)
        self._rsi_overbought = float(rsi_overbought)

        # ── Time window ────────────────────────────────────────────────────────
        self._use_time_window = bool(use_time_window)
        self._window_start    = int(window_start_utc_hour)
        self._window_end      = int(window_end_utc_hour)

        # ── Volume filter ──────────────────────────────────────────────────────
        self._use_volume_filter = bool(use_volume_filter)
        self._volume_multiplier = float(volume_multiplier)
        self._volume_lookback   = int(volume_lookback)

        # ── DCA grid / SL / TP ────────────────────────────────────────────────
        self._dca_pcts         = [float(p) for p in (dca_pcts or [2.0, 4.0, 7.0, 12.0])]
        self._sl_pct           = float(sl_pct)
        self._tp_pct           = float(tp_pct)
        self._cooldown_candles = int(cooldown_candles)

        # ── Infrastructure ─────────────────────────────────────────────────────
        self._db           = db_client
        self._bot_id       = bot_id
        self._log_callback = log_callback

        # ── State ──────────────────────────────────────────────────────────────
        self._reset_state()

    # ── State management ──────────────────────────────────────────────────────

    def _reset_state(self) -> None:
        """Zero all position-tracking variables back to their initial values."""
        # High-level state machine
        self._state: str = "idle"   # "idle" | "in_position" | "cooldown"

        # Position direction and sizes
        self._is_long:            bool  = False
        self._position_size:      float = 0.0   # base-asset units currently held
        self._vwap_entry:         float = 0.0   # HL-reported volume-weighted avg entry
        self._original_entry_px:  float = 0.0   # entry price of the initial market fill
        self._sl_ref_price:       float = 0.0   # price of the deepest filled DCA level

        # position_group MagicID (Supabase)
        self._position_group_id: str | None = None

        # DCA order tracking — one slot per configured level
        n = len(self._dca_pcts)
        self._dca_oids:   list[int | None] = [None] * n   # resting GTC limit oids
        self._dca_filled: list[bool]       = [False] * n  # True once fill confirmed

        # SL / TP trigger order IDs
        self._sl_oid: int | None = None
        self._tp_oid: int | None = None

        # Cooldown counter (decrements once per entry-timeframe tick)
        self._cooldown_remaining: int = 0

    # ── Logging ───────────────────────────────────────────────────────────────

    def _log(self, level: str, msg: str) -> None:
        """Emit *msg* at *level* to the Python logger AND the log_callback (bot_logs table)."""
        prefix   = f"[RSIDCAGrid][{self._coin}]"
        full_msg = f"{prefix} {msg}"
        if level == "error":
            logger.error(full_msg)
        elif level == "warning":
            logger.warning(full_msg)
        else:
            logger.info(full_msg)

        if self._log_callback:
            try:
                self._log_callback(level, msg)
            except Exception:
                pass  # never let logging crash the strategy

    # ── Filter helpers ────────────────────────────────────────────────────────

    def _in_time_window(self) -> bool:
        """Return True if the current UTC hour falls within the configured window.

        Handles wrap-around windows (e.g. window_start=22, window_end=6).
        If start == end, the filter is disabled (always return True).
        """
        if not self._use_time_window:
            return True
        hour = datetime.now(timezone.utc).hour
        s, e = self._window_start, self._window_end
        if s == e:
            return True          # degenerate case: unrestricted
        if s < e:
            return s <= hour < e
        # Midnight-crossing window (e.g. 22:00 – 06:00 UTC)
        return hour >= s or hour < e

    def _volume_filter_ok(self, entry_candles: list[dict]) -> tuple[bool, str]:
        """Return (pass, reason) for the volume filter.

        Uses the *volume_lookback* candles immediately before the most recent
        CLOSED candle as the rolling baseline.  The current closed candle must
        have volume >= average × volume_multiplier.
        """
        if not self._use_volume_filter:
            return True, "volume filter disabled"

        # entry_candles[-1] is current closed candle (last open already dropped in tick).
        vols = [c["volume"] for c in entry_candles]
        if len(vols) < self._volume_lookback + 1:
            return False, f"insufficient bars for volume baseline ({len(vols)} < {self._volume_lookback + 1})"

        # Rolling average: volume_lookback bars before the last closed candle.
        avg_vol      = sum(vols[-(self._volume_lookback + 1):-1]) / self._volume_lookback
        current_vol  = vols[-1]
        threshold    = avg_vol * self._volume_multiplier
        ok           = current_vol >= threshold
        reason = (
            f"vol={current_vol:.2f} {'≥' if ok else '<'} "
            f"avg{self._volume_lookback}({avg_vol:.2f}) × {self._volume_multiplier} = {threshold:.2f}"
        )
        return ok, reason

    def _context_filter(
        self,
        context_candles: list[dict],
        side: str,
    ) -> tuple[bool, str]:
        """Return (allowed, reason) for the EMA + ADX context filter.

        *side* is ``"long"`` or ``"short"``.
        Long is allowed only when ``price > EMA(ema_period)``.
        Short is allowed only when ``price < EMA(ema_period)``.
        If use_adx_filter, additionally require ``ADX(adx_period) < adx_threshold``.
        """
        closes = [c["close"] for c in context_candles]
        price  = closes[-1]

        ema_vals = _ema(closes, self._ema_period)
        if not ema_vals:
            return False, (
                f"insufficient context bars for EMA{self._ema_period} "
                f"(have {len(closes)}, need {self._ema_period})"
            )
        ema_now = ema_vals[-1]

        if side == "long" and price <= ema_now:
            return False, f"price {price:.4f} ≤ EMA{self._ema_period} {ema_now:.4f} → long blocked"
        if side == "short" and price >= ema_now:
            return False, f"price {price:.4f} ≥ EMA{self._ema_period} {ema_now:.4f} → short blocked"

        adx_str = ""
        if self._use_adx_filter:
            adx_val = _adx(context_candles, self._adx_period)
            if adx_val is None:
                return False, (
                    f"insufficient context bars for ADX{self._adx_period} "
                    f"(need ≥ {self._adx_period * 2})"
                )
            if adx_val >= self._adx_threshold:
                return False, (
                    f"ADX{self._adx_period}={adx_val:.1f} ≥ threshold {self._adx_threshold} "
                    f"(trending — RSI mean-reversion unreliable)"
                )
            adx_str = f" ADX{self._adx_period}={adx_val:.1f} < {self._adx_threshold}"

        return True, (
            f"EMA{self._ema_period}={ema_now:.4f} price={price:.4f} {side} ✓{adx_str}"
        )

    def _rsi_trigger(
        self,
        entry_candles: list[dict],
        side: str,
    ) -> tuple[bool, float, float]:
        """Return (triggered, rsi_prev, rsi_curr) for *side* on the last two closed bars.

        Long  trigger: RSI crosses from below rsi_oversold  to above it (oversold bounce).
        Short trigger: RSI crosses from above rsi_overbought to below it (overbought rejection).
        """
        closes   = [c["close"] for c in entry_candles]
        rsi_vals = _rsi(closes, self._rsi_period)

        if len(rsi_vals) < 2:
            return False, 0.0, 0.0

        rsi_prev = rsi_vals[-2]
        rsi_curr = rsi_vals[-1]

        if side == "long":
            triggered = rsi_prev < self._rsi_oversold and rsi_curr >= self._rsi_oversold
        else:
            triggered = rsi_prev > self._rsi_overbought and rsi_curr <= self._rsi_overbought

        return triggered, rsi_prev, rsi_curr

    # ── Sizing helpers ────────────────────────────────────────────────────────

    def _per_level_size(self, mark_price: float) -> float:
        """Base-asset size for one grid level (equal across 1 entry + N DCA levels).

        per_level_usdc = allocated_usdc / (1 + len(dca_pcts))
        per_level_size = (per_level_usdc × leverage) / mark_price
        """
        n_levels       = 1 + len(self._dca_pcts)
        per_level_usdc = self._allocated_usdc / n_levels
        raw_size       = (per_level_usdc * self._leverage) / mark_price
        return round_size(raw_size, self._sz_decimals)

    def _ensure_min_notional(self, size: float, price: float) -> float:
        """Bump *size* up by one increment until size × price >= $10 minimum.

        Mirrors the existing bump-to-clear-minimum pattern used elsewhere in
        the codebase.  Increments by the smallest representable size unit.
        """
        increment = 10 ** (-self._sz_decimals)
        while size * price < _HL_MIN_NOTIONAL:
            size += increment
            size  = round_size(size, self._sz_decimals)
        return size

    # ── Market data ───────────────────────────────────────────────────────────

    async def _fetch_candles(self, timeframe: str, limit: int) -> list[dict]:
        """Fetch OHLCV candles for *timeframe*; returns [] on error (never raises)."""
        try:
            return await get_candles(self._coin, timeframe, limit)
        except Exception as exc:
            self._log("error", f"_fetch_candles({timeframe}, {limit}) failed: {exc}")
            return []

    async def _get_position(self) -> tuple[float, float]:
        """Fetch live position size (signed) and entryPx from clearinghouse.

        Returns ``(szi, entry_px)`` where positive szi = long.
        Returns ``(0.0, 0.0)`` if no position or on error.
        """
        try:
            state = await hyperliquid_service.get_clearinghouse_state(
                self._master_address, self._dex
            )
            for ap in (state.get("assetPositions") or []):
                pos = ap.get("position", {})
                if pos.get("coin") == self._short_coin:
                    szi      = float(pos.get("szi",     0) or 0)
                    entry_px = float(pos.get("entryPx", 0) or 0)
                    return szi, entry_px
        except Exception as exc:
            self._log("error", f"_get_position() failed: {exc}")
        return 0.0, 0.0

    async def _get_open_order_oids(self) -> set[int]:
        """Return the set of live open-order oids for our coin from Hyperliquid.

        Strips any dex prefix (e.g. "HYPE:HIP-3" → "HYPE") from the order's
        ``coin`` field before comparing, so this works correctly whether
        frontendOpenOrders returns the short name or the HIP-3 prefixed name.
        """
        def _strip_dex(c: str) -> str:
            return c.split(":")[-1] if ":" in c else c

        try:
            orders = await hyperliquid_service.get_open_orders(
                self._master_address, self._dex
            )
            return {
                int(o["oid"])
                for o in (orders or [])
                if isinstance(o, dict) and _strip_dex(o.get("coin", "")) == self._short_coin
            }
        except Exception as exc:
            self._log("error", f"_get_open_order_oids() failed: {exc}")
            return set()

    # ── Order helpers ─────────────────────────────────────────────────────────

    async def _cancel_safe(self, oid: int | None) -> None:
        """Cancel one order by oid; swallows errors (idempotent, handles already-filled)."""
        if oid is None:
            return
        try:
            await hyperliquid_service.cancel_order(
                self._private_key, self._master_address, self._coin, oid
            )
        except Exception as exc:
            self._log("warning", f"cancel oid={oid} failed (may already be gone): {exc}")

    async def _cancel_all_resting(self) -> None:
        """Cancel every resting order tracked by this bot (DCA grid + SL + TP)."""
        all_oids: list[int | None] = list(self._dca_oids) + [self._sl_oid, self._tp_oid]
        for oid in all_oids:
            if oid is not None:
                await self._cancel_safe(oid)
        self._log("info", "All resting orders cancelled (DCA grid + SL + TP)")

    async def _place_entry(self, is_long: bool, mark_price: float) -> float:
        """Place a market IOC entry order, wait 2 s, then confirm the live fill.

        Populates ``_position_size``, ``_vwap_entry``, ``_original_entry_px``,
        and ``_sl_ref_price`` from the exchange-reported position.

        Returns the confirmed position size in base-asset units, or 0.0 on failure.
        """
        size = self._per_level_size(mark_price)
        size = self._ensure_min_notional(size, mark_price)

        direction = "LONG" if is_long else "SHORT"
        self._log(
            "info",
            f"Placing ENTRY market {direction} "
            f"size={size} @ ~{mark_price:.4f} | "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x | "
            f"per-level USDC≈{self._allocated_usdc / (1 + len(self._dca_pcts)):.2f}"
        )

        try:
            result = await hyperliquid_service.place_order(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = self._coin,
                is_buy         = is_long,
                size           = size,
                price          = mark_price,
                order_type     = "market",
                leverage       = self._leverage,
                sz_decimals    = self._sz_decimals,
            )
            self._log("info", f"Entry order sent: {result}")
        except Exception as exc:
            self._log("error", f"Entry order failed: {exc}")
            return 0.0

        # Wait for the IOC fill to propagate before querying clearinghouse.
        self._log("info", "Waiting 2 s for fill confirmation…")
        await asyncio.sleep(2.0)

        szi, entry_px = await self._get_position()
        if abs(szi) < 10 ** (-self._sz_decimals):
            self._log("error", "Entry did NOT fill — position still flat after 2 s")
            return 0.0

        self._position_size     = abs(szi)
        self._vwap_entry        = entry_px
        self._original_entry_px = entry_px
        self._sl_ref_price      = entry_px   # SL anchors to entry until a DCA fills

        self._log(
            "info",
            f"Entry confirmed: szi={szi} entryPx={entry_px:.4f} "
            f"(position_size={self._position_size}, vwap={self._vwap_entry:.4f})"
        )
        return self._position_size

    async def _place_dca_grid(self, is_long: bool, mark_price: float) -> None:
        """Place GTC limit DCA orders at each configured percentage from the original entry.

        Long:  DCA levels are BELOW entry (averaging down).
        Short: DCA levels are ABOVE entry (averaging up on a short).

        Size per DCA level is identical to the entry level (equal-weight grid).
        Orders are placed shallowest-first (smallest percentage first) so deeper
        levels can be cancelled without cancelling shallower ones individually.
        """
        size = self._per_level_size(mark_price)
        size = self._ensure_min_notional(size, mark_price)

        self._log(
            "info",
            f"Placing DCA grid: {len(self._dca_pcts)} GTC limits "
            f"{'below' if is_long else 'above'} entry={self._original_entry_px:.4f} "
            f"at {self._dca_pcts}% | per-level size={size}"
        )

        for i, pct in enumerate(self._dca_pcts):
            if is_long:
                dca_px = round_price(self._original_entry_px * (1.0 - pct / 100.0))
                is_buy = True
            else:
                dca_px = round_price(self._original_entry_px * (1.0 + pct / 100.0))
                is_buy = False

            try:
                result = await hyperliquid_service.place_order(
                    private_key    = self._private_key,
                    master_address = self._master_address,
                    coin           = self._coin,
                    is_buy         = is_buy,
                    size           = size,
                    price          = dca_px,
                    order_type     = "limit",
                    leverage       = self._leverage,
                    sz_decimals    = self._sz_decimals,
                )
                oid = _extract_oid(result)
                self._dca_oids[i] = oid
                self._log(
                    "info",
                    f"DCA[{i}] @ {dca_px:.4f} ({'-' if is_long else '+'}{pct}% from entry) "
                    f"→ oid={oid}"
                )
            except Exception as exc:
                self._log("error", f"DCA[{i}] order failed: {exc}")
                self._dca_oids[i] = None

    async def _update_sl_tp(self, is_long: bool) -> None:
        """Cancel existing SL + TP and replace with recomputed prices.

        Called after entry (initial placement) and after each DCA level fills
        (because position_size and/or vwap_entry and sl_ref_price all change).

        SL price: sl_ref_price × (1 ∓ sl_pct / 100)   — anchored to deepest fill
        TP price: vwap_entry   × (1 ± tp_pct / 100)    — anchored to VWAP
        """
        if self._position_size <= 0 or self._vwap_entry <= 0 or self._sl_ref_price <= 0:
            self._log("warning", "_update_sl_tp called with invalid state — skipping")
            return

        # Cancel existing SL and TP before replacing.
        await self._cancel_safe(self._sl_oid)
        await self._cancel_safe(self._tp_oid)
        self._sl_oid = None
        self._tp_oid = None

        if is_long:
            sl_px = round_price(self._sl_ref_price * (1.0 - self._sl_pct / 100.0))
            tp_px = round_price(self._vwap_entry   * (1.0 + self._tp_pct / 100.0))
        else:
            sl_px = round_price(self._sl_ref_price * (1.0 + self._sl_pct / 100.0))
            tp_px = round_price(self._vwap_entry   * (1.0 - self._tp_pct / 100.0))

        self._log(
            "info",
            f"Placing SL={sl_px:.4f} TP={tp_px:.4f} "
            f"(sl_ref={self._sl_ref_price:.4f} −{self._sl_pct}% | "
            f"vwap={self._vwap_entry:.4f} +{self._tp_pct}%) "
            f"size={self._position_size}"
        )

        try:
            result = await hyperliquid_service.place_tp_sl(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = self._coin,
                is_long        = is_long,
                size           = self._position_size,
                sz_decimals    = self._sz_decimals,
                tp_price       = tp_px,
                sl_price       = sl_px,
            )
            self._sl_oid = _extract_oid(result.get("sl"))
            self._tp_oid = _extract_oid(result.get("tp"))
            self._log(
                "info",
                f"SL oid={self._sl_oid} @ {sl_px:.4f} | TP oid={self._tp_oid} @ {tp_px:.4f}"
            )
        except Exception as exc:
            self._log("error", f"place_tp_sl failed: {exc}")

    # ── Position-management tick ──────────────────────────────────────────────

    async def _check_dca_fills(self) -> None:
        """Detect newly filled DCA levels and update SL/TP accordingly.

        For each DCA order whose oid has disappeared from live open orders,
        the level is assumed filled (externally cancelled orders are treated as
        filled conservatively to avoid stale accounting).  On any fill:
          1. Fetch live position to get updated size and HL-computed VWAP.
          2. Move sl_ref_price to the price of the filled DCA level (deepest only).
          3. Cancel + replace SL and TP for the enlarged position.
        """
        live_oids = await self._get_open_order_oids()
        is_long   = self._is_long

        for i, (oid, already_filled) in enumerate(zip(self._dca_oids, self._dca_filled)):
            if already_filled or oid is None:
                continue
            if oid in live_oids:
                continue  # still resting — not filled yet

            # OID vanished from open orders → treat as filled.
            self._dca_filled[i] = True

            # Compute the explicit DCA level price from the original entry.
            pct = self._dca_pcts[i]
            if is_long:
                dca_level_px = round_price(self._original_entry_px * (1.0 - pct / 100.0))
                # SL anchors to the LOWEST filled level — move it DOWN only.
                self._sl_ref_price = min(self._sl_ref_price, dca_level_px)
            else:
                dca_level_px = round_price(self._original_entry_px * (1.0 + pct / 100.0))
                # SL anchors to the HIGHEST filled level — move it UP only.
                self._sl_ref_price = max(self._sl_ref_price, dca_level_px)

            # Refresh actual position size + VWAP from Hyperliquid.
            szi, entry_px = await self._get_position()
            old_size = self._position_size
            self._position_size = abs(szi)
            self._vwap_entry    = entry_px  # HL's VWAP is authoritative after DCA fills

            self._log(
                "info",
                f"DCA[{i}] filled @ ~{dca_level_px:.4f} ({'-' if is_long else '+'}{pct}% from entry={self._original_entry_px:.4f}) | "
                f"position_size {old_size:.4f} → {self._position_size:.4f} | "
                f"new vwap={self._vwap_entry:.4f} | "
                f"sl_ref moved to {self._sl_ref_price:.4f}"
            )

            # Replace SL and TP for the new (larger) position and new anchor prices.
            await self._update_sl_tp(is_long)

    async def _tick_in_position(self) -> None:
        """Manage an open position: detect closes and check for DCA fills."""
        szi, entry_px = await self._get_position()

        if abs(szi) < 10 ** (-self._sz_decimals):
            # Position is flat — TP or SL fired (or manual close).
            self._log(
                "info",
                f"Position detected as FLAT (szi≈0) — TP or SL fired. "
                f"Last known size={self._position_size:.4f} vwap={self._vwap_entry:.4f}"
            )
            await self._on_close()
            return

        # Sync position_size / vwap from exchange on each poll tick (defensive).
        self._position_size = abs(szi)
        self._vwap_entry    = entry_px

        # Check whether any DCA limit orders have filled.
        await self._check_dca_fills()

    async def _on_close(self) -> None:
        """Handle position close: cancel resting orders, close position_group, cooldown."""
        # Cancel all resting orders (DCA grid + SL + TP).
        await self._cancel_all_resting()

        # Close the position_group in Supabase.
        if self._position_group_id and self._db:
            try:
                await close_position_group(self._db, self._position_group_id)
                self._log("info", f"position_group {self._position_group_id} closed in DB")
            except Exception as exc:
                self._log("error", f"close_position_group() failed: {exc}")

        cooldown = self._cooldown_candles
        self._reset_state()
        self._state              = "cooldown"
        self._cooldown_remaining = cooldown
        self._log("info", f"Entering cooldown — {cooldown} tick(s) before next entry")

    # ── Idle tick ─────────────────────────────────────────────────────────────

    async def _tick_idle(
        self,
        context_candles: list[dict],
        entry_candles: list[dict],
    ) -> None:
        """Evaluate all filters and fire an entry if conditions are met.

        The last element of both candle lists is dropped before indicator
        computation to ensure only fully *closed* bars are used for signals.
        """
        if not context_candles or not entry_candles:
            self._log("warning", "Candle fetch returned empty — skipping tick")
            return

        # Drop the current (potentially open) candle from both series.
        ctx = context_candles[:-1]
        ent = entry_candles[:-1]

        if not ctx or not ent:
            self._log("warning", "Not enough closed candles after dropping the open bar")
            return

        current_price = ent[-1]["close"]

        # ── Time window ────────────────────────────────────────────────────────
        if not self._in_time_window():
            hour = datetime.now(timezone.utc).hour
            self._log(
                "info",
                f"Outside time window [{self._window_start}–{self._window_end} UTC] "
                f"(current hour={hour}) — no entry"
            )
            return

        # ── Volume filter ──────────────────────────────────────────────────────
        vol_ok, vol_reason = self._volume_filter_ok(ent)
        if not vol_ok:
            self._log("info", f"Volume filter FAIL: {vol_reason}")
            return
        self._log("info", f"Volume filter PASS: {vol_reason}")

        # ── Context filter + RSI trigger for each allowed side ─────────────────
        for side in self._sides:
            is_long = side == "long"

            # Context (EMA + ADX)
            ctx_ok, ctx_reason = self._context_filter(ctx, side)
            if not ctx_ok:
                self._log("info", f"Context filter FAIL [{side}]: {ctx_reason}")
                continue
            self._log("info", f"Context filter PASS [{side}]: {ctx_reason}")

            # RSI crossover trigger
            triggered, rsi_prev, rsi_curr = self._rsi_trigger(ent, side)
            level = self._rsi_oversold if is_long else self._rsi_overbought
            self._log(
                "info",
                f"RSI[{side}] RSI_prev={rsi_prev:.1f} RSI_curr={rsi_curr:.1f} "
                f"level={level} → {'TRIGGERED ✓' if triggered else 'no trigger'}"
            )
            if not triggered:
                continue

            # All conditions met — place entry.
            self._log(
                "info",
                f"ALL FILTERS PASS [{side}] @ price={current_price:.4f} — entering position"
            )
            await self._open_position(is_long, current_price)
            # Only open one position per tick (even if both sides triggered).
            return

    # ── Position open sequence ────────────────────────────────────────────────

    async def _open_position(self, is_long: bool, mark_price: float) -> None:
        """Execute the full entry sequence: order → confirm → group → DCA → SL/TP."""
        self._is_long = is_long

        # 1. Market entry
        confirmed_size = await self._place_entry(is_long, mark_price)
        if confirmed_size <= 0:
            self._log("error", "Entry sequence aborted — fill not confirmed")
            self._reset_state()
            return

        # 2. Register position_group (MagicID)
        if self._db:
            try:
                pg_id = await create_position_group(
                    db            = self._db,
                    wallet_address= self._master_address,
                    coin          = self._coin,
                    dex           = self._dex or None,
                    side          = "long" if is_long else "short",
                    entry_price   = self._original_entry_px,
                    source_type   = "bot",
                    bot_id        = self._bot_id,
                )
                self._position_group_id = pg_id
                self._log("info", f"position_group created: {pg_id}")
            except Exception as exc:
                self._log("error", f"create_position_group() failed: {exc}")

        # 3. DCA grid
        await self._place_dca_grid(is_long, mark_price)

        # 4. Initial SL + TP (anchored to entry price / VWAP before any DCA fills)
        await self._update_sl_tp(is_long)

        # 5. Transition to in_position
        self._state = "in_position"
        self._log(
            "info",
            f"Position open — size={self._position_size:.4f} "
            f"vwap={self._vwap_entry:.4f} sl_ref={self._sl_ref_price:.4f} | "
            f"dca_oids={self._dca_oids} sl_oid={self._sl_oid} tp_oid={self._tp_oid}"
        )

    # ── Cooldown tick ─────────────────────────────────────────────────────────

    async def _tick_cooldown(self) -> None:
        """Decrement the cooldown counter; transition to idle when it reaches zero."""
        self._cooldown_remaining -= 1
        self._log(
            "info",
            f"Cooldown tick — {self._cooldown_remaining} tick(s) remaining"
        )
        if self._cooldown_remaining <= 0:
            self._state = "idle"
            self._log("info", "Cooldown expired — returning to IDLE")

    # ── Main run loop ─────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Bot main loop.  Runs indefinitely until cancelled.

        Tick cadence:
          • IDLE / COOLDOWN: sleep until the next entry-timeframe candle boundary.
          • IN_POSITION: poll every 30 s (fast loop) to detect DCA fills and
            position closes without waiting for a full candle to close.

        On each tick in IDLE the bot fetches both candle series (context + entry)
        and evaluates the filter stack.  In IN_POSITION only a position query and
        open-order diff are performed (no candle fetches needed).
        """
        interval_ms = _INTERVAL_MS.get(self._entry_tf, 900_000)

        # Set leverage on startup (isolated margin).
        try:
            await hyperliquid_service.set_leverage(
                self._private_key,
                self._master_address,
                self._coin,
                self._leverage,
                False,   # is_cross=False → isolated margin
            )
            self._log("info", f"Leverage set to {self._leverage}x isolated")
        except Exception as exc:
            self._log("error", f"set_leverage failed (proceeding anyway): {exc}")

        self._log(
            "info",
            f"Bot started | coin={self._coin} sides={self._sides} "
            f"entry_tf={self._entry_tf} context_tf={self._context_tf} | "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x "
            f"dca_pcts={self._dca_pcts} sl={self._sl_pct}% tp={self._tp_pct}% "
            f"cooldown={self._cooldown_candles} ticks"
        )

        while True:
            try:
                if self._state == "in_position":
                    # ── Position management (fast poll, no candle fetch) ───────
                    await self._tick_in_position()
                    await asyncio.sleep(_IN_POSITION_POLL_S)

                else:
                    # ── Idle / cooldown (candle-boundary cadence) ─────────────
                    if self._state == "cooldown":
                        await self._tick_cooldown()
                    else:
                        # Fetch both candle series concurrently.
                        context_candles, entry_candles = await asyncio.gather(
                            self._fetch_candles(self._context_tf, _CONTEXT_CANDLE_LIMIT),
                            self._fetch_candles(self._entry_tf,   _ENTRY_CANDLE_LIMIT),
                        )
                        await self._tick_idle(context_candles, entry_candles)

                    sleep_s = _seconds_to_next_candle(interval_ms)
                    self._log(
                        "info",
                        f"[{self._state}] sleeping {sleep_s:.0f}s "
                        f"until next {self._entry_tf} candle"
                    )
                    await asyncio.sleep(sleep_s)

            except asyncio.CancelledError:
                self._log("info", "Bot received CancelledError — stopping cleanly")
                raise

            except Exception as exc:
                # Log the error but stay alive — transient network or exchange
                # errors should not terminate the bot loop.
                self._log("error", f"Unhandled tick error: {exc}")
                await asyncio.sleep(60.0)
