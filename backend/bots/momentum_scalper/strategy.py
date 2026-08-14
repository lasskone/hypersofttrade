"""
backend/bots/momentum_scalper/strategy.py

Phase 2 — Strategy Engine for the Momentum Pullback Scalper.

Overview
--------
MomentumScalperBot is a multi-symbol, trend-following scalper that:

  1. Scans a list of symbols every ``scan_interval_seconds`` using the Phase 1
     scanner (``scanner.scan_all``).
  2. Enters the highest-scoring symbol when its score ≥ ``min_score`` and the
     bot is idle and not in cooldown.
  3. Places a market IOC entry, waits 2 s for fill confirmation, then registers
     a position_group in Supabase and immediately sets a TP and SL anchored to
     the confirmed entry price in ATR units.
  4. Polls every ``scan_interval_seconds`` while in_position to:
       a. Detect a flat position → _on_close().
       b. Optionally move SL to breakeven once the price has moved
          ``breakeven_atr_trigger × ATR`` in the trade's favour (if configured).
  5. After close, enters a time-based cooldown before accepting the next entry.

State machine
-------------
    idle → in_position → cooldown → idle

Sizing (ATR-risk-based) — IMPORTANT: read all comments before changing
----------------------------------------------------------------------
The formula used is:

    risk_capital  = allocated_usdc × 0.02          # 2 % of allocated capital
    stop_distance = atr_value × sl_atr_multiplier  # in price units (e.g. USD)
    raw_size      = (risk_capital / stop_distance) × leverage

CAUTION: the *actual* dollar loss at SL equals:
    raw_size × stop_distance = risk_capital × leverage
    = allocated_usdc × 0.02 × leverage

At 5× leverage and 2 % risk_capital this is 10 % of allocated_usdc per losing
trade — not 2 %.  This is intentionally aggressive for a scalper; review before
increasing leverage.

Safety cap (guards against vanishingly small ATR producing enormous size):
    margin_required = (raw_size × entry_price) / leverage
    if margin_required > allocated_usdc:
        raw_size = (allocated_usdc × leverage) / entry_price

In practice the safety cap is only triggered when ATR is extremely low relative
to the sl_atr_multiplier (i.e. in near-zero-volatility conditions), which the
scanner's volatility score already penalises.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Callable

from bots.momentum_scalper.risk_manager import RiskManager
from bots.momentum_scalper.scanner import (
    DEFAULT_SCANNER_CONFIG,
    MarketScore,
    scan_all,
)
from bots.shared_utils import atr, round_price, round_size
from services.hyperliquid_service import get_candles, hyperliquid_service
from services.position_groups import (
    close_position_group,
    create_position_group,
    record_position_order,
)

logger = logging.getLogger(__name__)

# Hyperliquid exchange minimum notional per order (USD).
_HL_MIN_NOTIONAL: float = 10.0

# After placing a market IOC, wait this long before querying clearinghouse.
_FILL_WAIT_S: float = 2.0

# ATR look-back for position management (same as scanner default).
_ATR_PERIOD: int = 14

# Break-even buffer above/below entry to cover fees (0.05 % expressed as a
# fraction so we can multiply directly by the entry price).
_BREAKEVEN_FEE_BUFFER: float = 0.0005   # 0.05 %

# Candles needed for position-management ATR recomputation.
# ATR(14) on M1 needs at least 15 bars; fetch 60 to be safe.
_ATR_CANDLE_LIMIT: int = 60


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


# ── Main bot class ────────────────────────────────────────────────────────────

class MomentumScalperBot:
    """Live multi-symbol momentum scalper.

    See module docstring for a full description of the strategy, sizing model,
    and state machine.
    """

    def __init__(
        self,
        *,
        private_key: str,
        master_address: str,
        symbols: list[str],
        sz_decimals_map: dict[str, int],
        dex: str = "",
        allocated_usdc: float = 100.0,
        leverage: int = 5,
        scanner_config: dict | None = None,
        min_score: float = 75.0,
        # ATR-based TP / SL
        tp_atr_multiplier: float = 0.30,
        sl_atr_multiplier: float = 0.50,
        # Breakeven SL: move SL to entry + fee_buffer after price moves
        # breakeven_atr_trigger × ATR in the trade's favour.
        # Set to None to disable.
        breakeven_atr_trigger: float | None = 0.25,
        # Multi-position gate: number of simultaneous open positions allowed.
        # Currently only 1 is supported; kept as a parameter for future use.
        max_open_positions: int = 1,
        # Cooldown durations (time-based, not candle-based)
        cooldown_after_trade_seconds: int = 10,
        cooldown_after_loss_seconds: int = 60,
        # How often to run the scanner when idle or in_position
        scan_interval_seconds: int = 5,
        # Risk manager parameters (passed through to RiskManager)
        risk_per_trade: float = 0.02,
        max_daily_loss_pct: float = 0.10,
        max_consecutive_losses: int = 3,
        consecutive_loss_cooldown_minutes: int = 30,
        min_profit_to_fee_ratio: float = 1.5,
        estimated_fee_pct: float = 0.07,
        # Time window — restrict entries to a UTC hour range (London/NY overlap
        # default: 12–16 UTC, the highest-volatility window for momentum setups).
        # Set use_time_window=False to trade around the clock.
        use_time_window: bool = True,
        window_start_utc_hour: int = 12,
        window_end_utc_hour: int = 16,
        # Infrastructure
        db_client=None,
        bot_id: str | None = None,
        log_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        # ── Credentials & market ───────────────────────────────────────────────
        self._private_key    = private_key
        self._master_address = master_address
        self._symbols        = list(symbols)
        self._sz_decimals_map = dict(sz_decimals_map)
        self._dex            = dex or ""

        # ── Capital ────────────────────────────────────────────────────────────
        self._allocated_usdc = float(allocated_usdc)
        self._leverage       = int(leverage)

        # ── Scanner ────────────────────────────────────────────────────────────
        self._scanner_config = scanner_config if scanner_config is not None else dict(DEFAULT_SCANNER_CONFIG)
        self._min_score      = float(min_score)

        # ── TP / SL ────────────────────────────────────────────────────────────
        self._tp_atr_multiplier    = float(tp_atr_multiplier)
        self._sl_atr_multiplier    = float(sl_atr_multiplier)
        self._breakeven_atr_trigger = (
            float(breakeven_atr_trigger) if breakeven_atr_trigger is not None else None
        )

        # ── Position gate ──────────────────────────────────────────────────────
        self._max_open_positions = int(max_open_positions)

        # ── Cooldown ───────────────────────────────────────────────────────────
        self._cooldown_after_trade_s = int(cooldown_after_trade_seconds)
        self._cooldown_after_loss_s  = int(cooldown_after_loss_seconds)
        self._scan_interval_s        = int(scan_interval_seconds)

        # ── Time window ────────────────────────────────────────────────────────
        self._use_time_window = bool(use_time_window)
        self._window_start    = int(window_start_utc_hour)
        self._window_end      = int(window_end_utc_hour)

        # ── Infrastructure ─────────────────────────────────────────────────────
        self._db           = db_client
        self._bot_id       = bot_id
        self._log_callback = log_callback

        # ── Risk manager ────────────────────────────────────────────────────────
        self._risk_manager = RiskManager(
            bot_id                          = bot_id,
            db_client                       = db_client,
            allocated_usdc                  = allocated_usdc,
            risk_per_trade                  = risk_per_trade,
            max_daily_loss_pct              = max_daily_loss_pct,
            max_consecutive_losses          = max_consecutive_losses,
            consecutive_loss_cooldown_minutes = consecutive_loss_cooldown_minutes,
            max_leverage                    = leverage,
            min_profit_to_fee_ratio         = min_profit_to_fee_ratio,
            estimated_fee_pct               = estimated_fee_pct,
        )

        # ── State ──────────────────────────────────────────────────────────────
        self._reset_state()

    # ── State management ──────────────────────────────────────────────────────

    def _reset_state(self) -> None:
        """Zero all position-tracking variables back to their initial values."""
        # High-level state machine
        self._state: str = "idle"   # "idle" | "in_position" | "cooldown"

        # Active symbol / coin for the current open position
        self._current_symbol:      str | None = None   # e.g. "BTC"
        self._current_coin:        str | None = None   # e.g. "BTC" or "xyz:XYZ"
        self._current_sz_decimals: int        = 5

        # Position direction and tracking
        self._is_long:        bool  = False
        self._position_size:  float = 0.0   # base-asset units held
        self._entry_price:    float = 0.0   # confirmed fill price from clearinghouse
        self._entry_atr:      float = 0.0   # ATR (in price units) at entry time

        # Resting order IDs
        self._entry_oid: int | None = None
        self._tp_oid:    int | None = None
        self._sl_oid:    int | None = None

        # Unix timestamp (ms) when the entry order was placed — used to filter
        # post-entry fills from get_user_fills() in _on_close().
        self._entry_time: int = 0

        # Supabase position_group UUID
        self._position_group_id: str | None = None

        # Breakeven tracking
        self._breakeven_triggered: bool = False

        # Cooldown expiry as a monotonic timestamp (time.monotonic())
        # 0.0 means no cooldown active.
        self._cooldown_until: float = 0.0

    # ── Logging ───────────────────────────────────────────────────────────────

    def _log(self, level: str, msg: str) -> None:
        """Emit *msg* at *level* to the Python logger and the log_callback."""
        symbol_tag = f"[{self._current_symbol}]" if self._current_symbol else ""
        full_msg   = f"[MomentumScalper]{symbol_tag} {msg}"
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
                pass   # never let logging crash the strategy

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

    # ── Sizing ────────────────────────────────────────────────────────────────

    def _compute_size(
        self,
        entry_price: float,
        atr_value: float,
        sz_decimals: int,
    ) -> float:
        """Return the base-asset size for this trade.

        Delegates entirely to RiskManager.compute_position_size(), which
        applies equity-based sizing with drawdown-tier scaling, a margin safety
        cap, and a profitability filter (expected TP profit vs estimated fees).
        Returns 0.0 when the setup cannot be made profitable — caller should
        treat 0.0 as "do not enter".
        """
        stop_distance = atr_value * self._sl_atr_multiplier
        raw_size = self._risk_manager.compute_position_size(
            entry_price       = entry_price,
            stop_distance     = stop_distance,
            leverage          = self._leverage,
            tp_atr_multiplier = self._tp_atr_multiplier,
            atr_value         = atr_value,
        )
        return round_size(raw_size, sz_decimals)

    def _ensure_min_notional(
        self,
        size: float,
        price: float,
        sz_decimals: int,
    ) -> float:
        """Bump *size* up by one tick until size × price ≥ $10 minimum notional."""
        increment = 10 ** (-sz_decimals)
        while size * price < _HL_MIN_NOTIONAL:
            size += increment
            size  = round_size(size, sz_decimals)
        return size

    # ── Market data ───────────────────────────────────────────────────────────

    async def _get_current_atr(self, coin: str) -> float | None:
        """Fetch M1 candles and return the current ATR(14) in price units.

        Returns None on error or insufficient data.
        """
        try:
            candles = await get_candles(coin, "1m", _ATR_CANDLE_LIMIT)
        except Exception as exc:
            self._log("error", f"_get_current_atr fetch failed: {exc}")
            return None
        if not candles:
            return None
        return atr(candles, _ATR_PERIOD)

    async def _get_position(self, coin: str, short_coin: str) -> tuple[float, float]:
        """Fetch live signed position size and entryPx from clearinghouse.

        Returns ``(szi, entry_px)`` — positive szi = long.
        Returns ``(0.0, 0.0)`` on error or if no position found.
        """
        try:
            state = await hyperliquid_service.get_clearinghouse_state(
                self._master_address, self._dex
            )
            for ap in (state.get("assetPositions") or []):
                pos = ap.get("position", {})
                if pos.get("coin") == short_coin:
                    szi      = float(pos.get("szi",     0) or 0)
                    entry_px = float(pos.get("entryPx", 0) or 0)
                    return szi, entry_px
        except Exception as exc:
            self._log("error", f"_get_position() failed: {exc}")
        return 0.0, 0.0

    async def _get_open_order_oids(self, short_coin: str) -> set[int]:
        """Return the set of live open-order oids for *short_coin*.

        Strips any dex prefix (e.g. "HYPE:HIP-3" → "HYPE") before comparison.
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
                if isinstance(o, dict) and _strip_dex(o.get("coin", "")) == short_coin
            }
        except Exception as exc:
            self._log("error", f"_get_open_order_oids() failed: {exc}")
            return set()

    # ── Order helpers ─────────────────────────────────────────────────────────

    async def _cancel_safe(self, coin: str, oid: int | None) -> None:
        """Cancel one order by oid; swallows errors (idempotent)."""
        if oid is None:
            return
        try:
            await hyperliquid_service.cancel_order(
                self._private_key, self._master_address, coin, oid
            )
        except Exception as exc:
            self._log("warning", f"cancel oid={oid} failed (may already be gone): {exc}")

    async def _cancel_all_resting(self) -> None:
        """Cancel TP + SL orders for the active position."""
        if self._current_coin is None:
            return
        for oid in (self._tp_oid, self._sl_oid):
            if oid is not None:
                await self._cancel_safe(self._current_coin, oid)
        self._log("info", "All resting orders cancelled (TP + SL)")

    # ── Position open sequence ────────────────────────────────────────────────

    async def _open_position(self, ms: MarketScore) -> None:
        """Execute the full entry sequence for the best-scoring symbol.

        Steps:
          1. Compute size.
          2. Place market IOC entry.
          3. Wait _FILL_WAIT_S seconds for fill propagation.
          4. Confirm via clearinghouse; abort if flat.
          5. Compute TP / SL prices anchored to confirmed entry.
          6. Register position_group in Supabase.
          7. Place TP and SL orders.
          8. Transition state to in_position.
        """
        symbol      = ms.symbol
        is_long     = ms.direction == "long"
        coin        = f"{self._dex}:{symbol}" if self._dex else symbol
        short_coin  = coin.split(":")[-1] if ":" in coin else coin
        sz_decimals = self._sz_decimals_map.get(symbol, 5)

        # ── ATR at entry time ──────────────────────────────────────────────────
        # atr_pct from the scanner is expressed as a percentage of price.
        # Convert to absolute price units for TP / SL placement.
        # We re-fetch current mid to get an accurate entry estimate first.
        try:
            mids = await hyperliquid_service.get_all_mids()
            mid_price = float(mids.get(short_coin, 0))
        except Exception as exc:
            self._log("error", f"get_all_mids() failed: {exc}")
            return

        if mid_price <= 0:
            self._log("error", f"Invalid mid price for {symbol}: {mid_price}")
            return

        # atr_pct is ATR expressed as % of current price.
        atr_value = (ms.atr_pct / 100.0) * mid_price
        if atr_value <= 0:
            self._log("error", f"ATR value is zero for {symbol} — cannot compute TP/SL")
            return

        # ── Sizing ─────────────────────────────────────────────────────────────
        size = self._compute_size(mid_price, atr_value, sz_decimals)
        size = self._ensure_min_notional(size, mid_price, sz_decimals)

        direction_label = "LONG" if is_long else "SHORT"
        self._log(
            "info",
            f"Entering {direction_label} {symbol} | score={ms.total_score:.1f} "
            f"size={size} @ ~{mid_price:.4f} | "
            f"atr={atr_value:.4f} atr_pct={ms.atr_pct:.3f}% | "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x",
        )

        # ── 1. Market IOC entry ────────────────────────────────────────────────
        # Record placement time before the call so fills with time > this
        # value can be identified as exit fills in _on_close().
        self._entry_time = int(time.time() * 1000)
        try:
            result = await hyperliquid_service.place_order(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_buy         = is_long,
                size           = size,
                price          = mid_price,
                order_type     = "market",
                leverage       = self._leverage,
                sz_decimals    = sz_decimals,
            )
            # DIAGNOSTIC: log full raw SDK result so rejections surface in bot UI
            self._log("info", f"[diag] place_order raw result: {result}")
            self._entry_oid = _extract_oid(result)
            # Surface any per-order error strings from the statuses list
            try:
                for s in (result or {}).get("response", {}).get("data", {}).get("statuses", []):
                    if "error" in s:
                        self._log("error", f"[place_order] REJECTED by exchange: {s['error']}")
            except Exception:
                pass
            self._log("info", f"Entry order sent: oid={self._entry_oid}")
        except Exception as exc:
            self._log("error", f"Entry order failed: {exc}")
            return

        # ── 2. Wait for fill propagation ───────────────────────────────────────
        self._log("info", f"Waiting {_FILL_WAIT_S:.0f}s for fill confirmation…")
        await asyncio.sleep(_FILL_WAIT_S)

        # ── 3. Confirm fill via clearinghouse ──────────────────────────────────
        szi, entry_px = await self._get_position(coin, short_coin)
        if abs(szi) < 10 ** (-sz_decimals):
            self._log("error", f"Entry did NOT fill — position still flat after {_FILL_WAIT_S:.0f}s")
            return

        confirmed_size = abs(szi)

        self._log(
            "info",
            f"Fill confirmed: szi={szi} entryPx={entry_px:.4f}",
        )

        # ── 4. Compute TP / SL anchored to confirmed entry price ───────────────
        # Recompute atr_value using the confirmed entry price for accuracy.
        confirmed_atr = (ms.atr_pct / 100.0) * entry_px

        if is_long:
            tp_price = round_price(entry_px + self._tp_atr_multiplier * confirmed_atr)
            sl_price = round_price(entry_px - self._sl_atr_multiplier * confirmed_atr)
        else:
            tp_price = round_price(entry_px - self._tp_atr_multiplier * confirmed_atr)
            sl_price = round_price(entry_px + self._sl_atr_multiplier * confirmed_atr)

        self._log(
            "info",
            f"TP={tp_price:.4f} ({self._tp_atr_multiplier}×ATR) | "
            f"SL={sl_price:.4f} ({self._sl_atr_multiplier}×ATR) | "
            f"confirmed_atr={confirmed_atr:.4f}",
        )

        # ── 5. Populate state fields (before placing orders, so _cancel_all_resting works) ──
        self._current_symbol      = symbol
        self._current_coin        = coin
        self._current_sz_decimals = sz_decimals
        self._is_long             = is_long
        self._position_size       = confirmed_size
        self._entry_price         = entry_px
        self._entry_atr           = confirmed_atr
        self._breakeven_triggered = False

        # ── 6. Register position_group in Supabase ─────────────────────────────
        if self._db:
            try:
                pg_id = await create_position_group(
                    db             = self._db,
                    wallet_address = self._master_address,
                    coin           = coin,
                    dex            = self._dex or None,
                    side           = "long" if is_long else "short",
                    entry_price    = entry_px,
                    source_type    = "bot",
                    bot_id         = self._bot_id,
                )
                self._position_group_id = pg_id
                self._log("info", f"position_group created: {pg_id}")

                if self._entry_oid is not None:
                    try:
                        await record_position_order(
                            db                = self._db,
                            position_group_id = pg_id,
                            bot_id            = self._bot_id,
                            oid               = self._entry_oid,
                            order_role        = "entry",
                            coin              = coin,
                        )
                    except Exception as rec_exc:
                        self._log("warning", f"record_position_order(entry) failed: {rec_exc}")
            except Exception as exc:
                self._log("error", f"create_position_group() failed: {exc}")
                # Non-fatal: we still hold the position, so continue.

        # ── 7. Place TP and SL orders ─────────────────────────────────────────
        await self._place_tp_sl(
            is_long     = is_long,
            coin        = coin,
            size        = confirmed_size,
            sz_decimals = sz_decimals,
            tp_price    = tp_price,
            sl_price    = sl_price,
        )

        # ── 8. Transition to in_position ───────────────────────────────────────
        self._state = "in_position"
        self._log(
            "info",
            f"Position open — symbol={symbol} direction={direction_label} "
            f"size={confirmed_size} entry={entry_px:.4f} "
            f"TP={tp_price:.4f} SL={sl_price:.4f} "
            f"tp_oid={self._tp_oid} sl_oid={self._sl_oid}",
        )

    async def _place_tp_sl(
        self,
        is_long: bool,
        coin: str,
        size: float,
        sz_decimals: int,
        tp_price: float,
        sl_price: float,
    ) -> None:
        """Place TP and SL trigger orders and record their oids."""
        try:
            result = await hyperliquid_service.place_tp_sl(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_long        = is_long,
                size           = size,
                sz_decimals    = sz_decimals,
                tp_price       = tp_price,
                sl_price       = sl_price,
            )
            self._tp_oid = _extract_oid(result.get("tp"))
            self._sl_oid = _extract_oid(result.get("sl"))
            self._log(
                "info",
                f"TP oid={self._tp_oid} @ {tp_price:.4f} | SL oid={self._sl_oid} @ {sl_price:.4f}",
            )

            if self._db and self._position_group_id:
                for oid, role in ((self._tp_oid, "tp"), (self._sl_oid, "sl")):
                    if oid is not None:
                        try:
                            await record_position_order(
                                db                = self._db,
                                position_group_id = self._position_group_id,
                                bot_id            = self._bot_id,
                                oid               = oid,
                                order_role        = role,
                                coin              = coin,
                            )
                        except Exception as rec_exc:
                            self._log("warning", f"record_position_order({role}) failed: {rec_exc}")
        except Exception as exc:
            self._log("error", f"place_tp_sl failed: {exc}")

    # ── Position management tick ──────────────────────────────────────────────

    async def _tick_in_position(self) -> None:
        """Poll position state, check for close, optionally move breakeven SL."""
        coin       = self._current_coin
        short_coin = coin.split(":")[-1] if ":" in coin else coin
        sz_dec     = self._current_sz_decimals

        # ── 1. Flat-position detection ─────────────────────────────────────────
        szi, current_entry_px = await self._get_position(coin, short_coin)

        if abs(szi) < 10 ** (-sz_dec):
            # Position is flat — determine outcome from which order is still live.
            live_oids = await self._get_open_order_oids(short_coin)
            await self._on_close(live_oids)
            return

        # Sync position size from exchange on every poll.
        self._position_size = abs(szi)

        # ── 2. Breakeven SL management ─────────────────────────────────────────
        if (
            not self._breakeven_triggered
            and self._breakeven_atr_trigger is not None
            and self._entry_atr > 0
        ):
            try:
                mids       = await hyperliquid_service.get_all_mids()
                mark_price = float(mids.get(short_coin, 0))
            except Exception as exc:
                self._log("warning", f"get_all_mids for breakeven check failed: {exc}")
                mark_price = 0.0

            if mark_price > 0:
                if self._is_long:
                    favourable_move = mark_price - self._entry_price
                else:
                    favourable_move = self._entry_price - mark_price

                trigger_distance = self._breakeven_atr_trigger * self._entry_atr

                if favourable_move >= trigger_distance:
                    await self._move_to_breakeven(coin, short_coin)

    async def _move_to_breakeven(self, coin: str, short_coin: str) -> None:
        """Move SL to entry ± fee_buffer and record the new oid.

        The fee buffer (0.05 %) ensures we do not lock in a loss after fees
        if the price reverses sharply back through entry.
        """
        fee_buffer = self._entry_price * _BREAKEVEN_FEE_BUFFER

        if self._is_long:
            be_sl_price = round_price(self._entry_price + fee_buffer)
        else:
            be_sl_price = round_price(self._entry_price - fee_buffer)

        self._log(
            "info",
            f"Breakeven trigger hit — moving SL to {be_sl_price:.4f} "
            f"(entry={self._entry_price:.4f} buffer={fee_buffer:.4f})",
        )

        # Cancel the existing SL.
        await self._cancel_safe(coin, self._sl_oid)
        self._sl_oid = None

        # Place a new SL-only order (TP stays in place).
        try:
            result = await hyperliquid_service.place_tp_sl(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_long        = self._is_long,
                size           = self._position_size,
                sz_decimals    = self._current_sz_decimals,
                tp_price       = None,    # TP already resting — do not replace
                sl_price       = be_sl_price,
            )
            self._sl_oid = _extract_oid(result.get("sl"))
            self._breakeven_triggered = True
            self._log("info", f"Breakeven SL placed: oid={self._sl_oid} @ {be_sl_price:.4f}")

            if self._db and self._position_group_id and self._sl_oid is not None:
                try:
                    await record_position_order(
                        db                = self._db,
                        position_group_id = self._position_group_id,
                        bot_id            = self._bot_id,
                        oid               = self._sl_oid,
                        order_role        = "sl_breakeven",
                        coin              = coin,
                    )
                except Exception as rec_exc:
                    self._log("warning", f"record_position_order(sl_breakeven) failed: {rec_exc}")
        except Exception as exc:
            self._log("error", f"Breakeven SL placement failed: {exc}")

    async def _on_close(self, live_oids: set[int]) -> None:
        """Handle position close: compute PnL, record risk result, cancel orders,
        close position_group, enter cooldown.

        PnL and outcome resolution — two-tier approach
        -----------------------------------------------
        Primary (authoritative): fetch recent fills via get_user_fills() and
        filter to this coin + time > entry order placement time.  Sum closedPnl
        across all matching fills.  Outcome = sign of the sum: positive → TP_HIT,
        negative → SL_HIT.  This is exact (exchange-side, fee-adjusted) and
        immune to the oid-liveness race condition where Hyperliquid auto-cancels
        the sibling reduce-only order faster than our poll interval.

        Fallback (low confidence): if fills are unavailable (API error or no
        matches), fall back to the oid-liveness heuristic for outcome and
        mark-price for PnL.  Both are approximations; logged as warnings.
        """
        # Snapshot all position state before any mutations (cancel / reset_state
        # will clear these fields).
        snap_entry_price   = self._entry_price
        snap_position_size = self._position_size
        snap_is_long       = self._is_long
        snap_current_coin  = self._current_coin
        snap_entry_time    = self._entry_time   # ms, set at entry order placement

        short_coin = (
            snap_current_coin.split(":")[-1]
            if snap_current_coin and ":" in snap_current_coin
            else snap_current_coin or ""
        )

        tp_alive = self._tp_oid is not None and self._tp_oid in live_oids
        sl_alive = self._sl_oid is not None and self._sl_oid in live_oids

        # oid-liveness heuristic — used as fallback when fills are unavailable.
        if sl_alive and not tp_alive:
            oid_outcome  = "TP_HIT"
            oid_cooldown = self._cooldown_after_trade_s
        elif tp_alive and not sl_alive:
            oid_outcome  = "SL_HIT"
            oid_cooldown = self._cooldown_after_loss_s
        else:
            # Both gone (auto-cancel race, manual close, liquidation) or both
            # still live — treat conservatively.
            oid_outcome  = "CLOSED_UNKNOWN"
            oid_cooldown = self._cooldown_after_loss_s

        self._log(
            "info",
            f"Position closed — oid_heuristic={oid_outcome} "
            f"(tp_alive={tp_alive} sl_alive={sl_alive}) | "
            f"entry={snap_entry_price:.4f} size={snap_position_size:.4f}",
        )

        # ── Primary: authoritative PnL from fills ─────────────────────────────
        try:
            raw_fills = await hyperliquid_service.get_user_fills(self._master_address)
        except Exception as exc:
            raw_fills = []
            self._log("warning", f"get_user_fills() failed, falling back to mark-price PnL estimate: {exc}")

        # Filter: same coin, placed AFTER entry order (exit fills only).
        matching_fills = [
            f for f in (raw_fills or [])
            if (
                f.get("coin", "") in (short_coin, snap_current_coin)
                and f.get("time", 0) > snap_entry_time
            )
        ]
        fills_pnl = sum(float(f.get("closedPnl", "0") or "0") for f in matching_fills)

        if matching_fills:
            pnl_usd = fills_pnl
            # Outcome from fills sign — overrides oid heuristic.
            if fills_pnl > 0:
                outcome  = "TP_HIT"
                cooldown = self._cooldown_after_trade_s
            elif fills_pnl < 0:
                outcome  = "SL_HIT"
                cooldown = self._cooldown_after_loss_s
            else:
                # Exactly zero closed PnL (breakeven close) — rare; keep oid outcome.
                outcome  = oid_outcome
                cooldown = oid_cooldown
            self._log(
                "info",
                f"PnL from fills (authoritative): {len(matching_fills)} fill(s) "
                f"matched coin={short_coin} after t={snap_entry_time}ms "
                f"→ pnl=${pnl_usd:.4f} | outcome={outcome} cooldown={cooldown}s",
            )
        else:
            # ── Fallback: mark-price estimate ──────────────────────────────────
            outcome  = oid_outcome
            cooldown = oid_cooldown
            exit_price = snap_entry_price   # last resort if mids also fail
            if short_coin:
                try:
                    mids = await hyperliquid_service.get_all_mids()
                    fetched = float(mids.get(short_coin, 0))
                    if fetched > 0:
                        exit_price = fetched
                except Exception as exc:
                    self._log("warning", f"get_all_mids() for PnL fallback failed: {exc}")
            direction_sign = 1.0 if snap_is_long else -1.0
            pnl_usd = (exit_price - snap_entry_price) * snap_position_size * direction_sign
            self._log(
                "warning",
                f"PnL from mark-price (fallback, low confidence): no fills matched "
                f"coin={short_coin} after t={snap_entry_time}ms | "
                f"entry={snap_entry_price:.4f} exit≈{exit_price:.4f} "
                f"size={snap_position_size:.4f} direction={'long' if snap_is_long else 'short'} "
                f"→ pnl≈${pnl_usd:.2f} (excludes fees/funding) | "
                f"outcome={outcome} cooldown={cooldown}s",
            )

        await self._risk_manager.record_trade_result(pnl_usd)

        self._log(
            "info",
            f"Risk state after trade: equity={self._risk_manager.equity:.2f} "
            f"hwm={self._risk_manager.high_water_mark:.2f} "
            f"drawdown={self._risk_manager._drawdown_pct()*100:.1f}% "
            f"consecutive_losses={self._risk_manager.consecutive_losses} "
            f"halted={self._risk_manager.trading_halted}",
        )

        # Cancel all resting orders.
        await self._cancel_all_resting()

        # Close position_group in Supabase.
        if self._position_group_id and self._db:
            try:
                await close_position_group(self._db, self._position_group_id)
                self._log("info", f"position_group {self._position_group_id} closed in DB")
            except Exception as exc:
                self._log("error", f"close_position_group() failed: {exc}")

        # Enter cooldown.
        self._reset_state()
        self._state          = "cooldown"
        self._cooldown_until = time.monotonic() + cooldown
        self._log("info", f"Entering cooldown — expires in {cooldown}s")

    # ── Idle tick ─────────────────────────────────────────────────────────────

    async def _tick_idle(self) -> None:
        """Run the scanner and enter a position if a qualifying opportunity exists."""
        # Skip if in trade-level cooldown (distinct from risk-manager cooldown).
        if time.monotonic() < self._cooldown_until:
            remaining = self._cooldown_until - time.monotonic()
            self._log("info", f"Cooldown active — {remaining:.0f}s remaining")
            return

        # Transition cooldown → idle once the timer expires.
        if self._state == "cooldown":
            self._state = "idle"
            self._log("info", "Cooldown expired — returning to IDLE")

        # Keep risk-manager equity in sync with the current allocated_usdc config.
        # No-op if already in sync; only persists when a rebaseline actually fires.
        await self._risk_manager.sync_allocation(self._allocated_usdc)

        # Risk-manager gate: check drawdown, daily loss, consecutive-loss
        # cooldown, and trading_halted flag before scanning.
        # This is a hard stop — not the same as the trade-level cooldown above.
        can_trade, rm_reason = await self._risk_manager.can_trade()
        if not can_trade:
            self._log("warning", f"Risk manager blocked entry: {rm_reason}")
            return

        # Time-window gate: block new entries outside the configured UTC window.
        if not self._in_time_window():
            hour = datetime.now(timezone.utc).hour
            self._log(
                "info",
                f"Outside time window [{self._window_start}–{self._window_end} UTC] "
                f"(now={hour:02d}:xx UTC) — skipping scan",
            )
            return

        # Run scanner.
        try:
            results = await scan_all(self._symbols, self._scanner_config)
        except Exception as exc:
            self._log("error", f"scan_all failed: {exc}")
            return

        if not results:
            self._log("info", "Scanner returned no results")
            return

        best = results[0]
        self._log(
            "info",
            f"Scanner best: {best.symbol} score={best.total_score:.1f} "
            f"dir={best.direction} "
            f"(threshold={self._min_score})",
        )
        for r in results:
            self._log("info", f"  [{r.symbol} {r.total_score:.1f} {r.direction}] " + " | ".join(r.reasons))

        if best.total_score < self._min_score:
            self._log("info", f"No qualifying opportunity (best={best.total_score:.1f} < {self._min_score})")
            return

        if best.direction not in ("long", "short"):
            self._log("info", f"Best symbol direction is neutral — skipping")
            return

        if best.symbol not in self._sz_decimals_map:
            self._log(
                "warning",
                f"{best.symbol} not in sz_decimals_map — cannot size order, skipping",
            )
            return

        self._log(
            "info",
            f"Opportunity found: {best.symbol} {best.direction.upper()} "
            f"score={best.total_score:.1f} — opening position",
        )
        await self._open_position(best)

    # ── Main run loop ─────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Bot main loop. Runs indefinitely until cancelled.

        Tick cadence: every ``scan_interval_seconds`` regardless of state.
        - IDLE / COOLDOWN: run scanner, enter if qualifying opportunity found.
        - IN_POSITION: poll position, detect close, manage breakeven SL.
        """
        # Load (or initialise) persisted risk state from DB.
        # Must run before any trading decisions — this is what makes drawdown
        # protection survive Railway restarts.
        await self._risk_manager.load_or_init()

        # Set leverage on startup (isolated margin) for all symbols.
        for symbol in self._symbols:
            try:
                await hyperliquid_service.set_leverage(
                    self._private_key,
                    self._master_address,
                    symbol,
                    self._leverage,
                    False,   # is_cross=False → isolated margin
                )
                self._log("info", f"Leverage set to {self._leverage}x isolated for {symbol}")
            except Exception as exc:
                self._log("error", f"set_leverage({symbol}) failed (proceeding anyway): {exc}")

        self._log(
            "info",
            f"Bot started | symbols={self._symbols} "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x | "
            f"min_score={self._min_score} "
            f"tp={self._tp_atr_multiplier}×ATR sl={self._sl_atr_multiplier}×ATR "
            f"breakeven_trigger={self._breakeven_atr_trigger}×ATR | "
            f"scan_interval={self._scan_interval_s}s",
        )

        while True:
            try:
                if self._state == "in_position":
                    await self._tick_in_position()
                else:
                    await self._tick_idle()

                await asyncio.sleep(self._scan_interval_s)

            except asyncio.CancelledError:
                self._log("info", "Bot received CancelledError — stopping cleanly")
                raise

            except Exception as exc:
                # Log but stay alive — transient network or exchange errors
                # should not terminate the bot loop.
                self._log("error", f"Unhandled tick error: {exc}")
                await asyncio.sleep(60.0)
