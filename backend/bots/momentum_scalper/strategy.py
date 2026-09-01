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
     a position_group in Supabase and immediately places a TP order anchored to
     the confirmed entry price in ATR units.  No SL is ever placed.
  4. Polls every ``scan_interval_seconds`` while in_position to:
       a. Detect a flat position → _on_close().
       b. Check whether price has crossed the next martingale trigger and, if so,
          add a reinforcement layer at the Fibonacci-sized quantity.
  5. After close, enters a time-based cooldown before accepting the next entry.

State machine
-------------
    idle → in_position → cooldown → idle

Martingale reinforcement (no SL — margin-bounded, unlimited levels)
--------------------------------------------------------------------
No stop-loss order is ever placed.  Instead, if price moves adversely from the
ORIGINAL entry price, reinforcement (martingale) layers are added on demand:

    Trigger distance for level N:
        N × sl_atr_multiplier × ATR  adverse from _initial_entry_price

    Layer size for level N (golden-ratio Fibonacci):
        φ^(N-1) × _initial_entry_size
        φ = (1 + √5) / 2 ≈ 1.6180339887
        N=1: 1.000×, N=2: 1.618×, N=3: 2.618×, N=4: 4.236×, …

There is NO cap on the number of levels.  Layers continue to be added as long
as the account has sufficient margin.  An "Insufficient margin" rejection from
the exchange is logged as a warning, the level counter is NOT incremented (same
level is retried on the next tick), and execution returns cleanly — the
scan_interval_seconds sleep provides natural backoff.

After each confirmed fill the VWAP entry is updated from the clearinghouse and
the TP is repriced to new_vwap ± tp_atr_multiplier × entry_atr (entry_atr is
fixed at the initial fill and never changes across the trade's lifetime).

WARNING: This design accepts unlimited drawdown risk up to full liquidation.
The user has explicitly confirmed this behaviour.

Sizing (fixed notional) — IMPORTANT: read all comments before changing
----------------------------------------------------------------------
Every initial (L0) entry targets a fixed notional of $11 by default (see
l0_entry_notional_usd constructor parameter), regardless of ATR or equity:

    raw_size = (l0_entry_notional_usd × leverage) / entry_price

$11 is chosen to be just above Hyperliquid's $10 minimum notional.
ATR-risk-based sizing was removed because collapsing ATR on low-volatility
setups produced margin-cap-dominated positions with no meaningful risk
guarantee.

Safety cap (defense-in-depth — should never fire at $11 base):
    margin_required = (raw_size × entry_price) / leverage
    if margin_required > equity × 0.90:
        raw_size = (equity × 0.90 × leverage) / entry_price

Martingale layers still scale from the confirmed L0 fill size:
    layer_N_size = initial_entry_size × martingale_multiplier^(level-1)
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Callable

from bots.momentum_scalper.risk_manager import RiskManager, _MARGIN_SAFETY_BUFFER
from bots.momentum_scalper.scanner import (
    DEFAULT_SCANNER_CONFIG,
    MarketScore,
    scan_all,
)
from bots.shared_utils import atr, round_price, round_size
from services.db_utils import _run_db_call
from services.hyperliquid_service import get_candles, hyperliquid_service
from services.position_groups import (
    close_position_group,
    create_position_group,
    record_position_order,
    record_trade_signal,
    update_trade_signal_outcome,
)

logger = logging.getLogger(__name__)

# Hyperliquid exchange minimum notional per order (USD).
_HL_MIN_NOTIONAL: float = 10.0

# Hyperliquid minimum notional ($10) plus a small safety buffer.
# Used as the lower clamp for l0_entry_notional_usd in the constructor.
_L0_ENTRY_NOTIONAL_MIN: float = 10.5

# After placing a market IOC, wait this long before querying clearinghouse.
_FILL_WAIT_S: float = 2.0

# ATR look-back for position management (same as scanner default).
_ATR_PERIOD: int = 14

# Candles needed for position-management ATR recomputation.
# ATR(14) on M1 needs at least 15 bars; fetch 60 to be safe.
_ATR_CANDLE_LIMIT: int = 60

# Seconds to wait after sending a TP cancel before placing the replacement TP.
# Gives the exchange time to process the cancel, preventing duplicate TP orders
# when the cancel ACK races against the new placement.
_CANCEL_SETTLE_S: float = 0.3


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
        tp_atr_multiplier: float = 1.0,
        sl_atr_multiplier: float = 1.67,
        # Martingale size progression base — each reinforcement layer's size is
        # multiplier^(level-1) × initial_entry_size.  Default 1.618 (golden ratio)
        # preserves exact prior behavior for bots that don't have this key in config.
        martingale_multiplier: float = (1 + 5 ** 0.5) / 2,
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
        # L0 entry notional — fixed USD size of every initial entry.
        # Must be ≥ $10.50 (Hyperliquid rejects orders below the $10 minimum
        # notional; the extra $0.50 provides a rounding buffer).
        l0_entry_notional_usd: float = 11.0,
        # Daily loss limit — set to False to disable the daily loss halt.
        # When False the max_daily_loss_pct check is skipped in can_trade()
        # and record_trade_result(); trading continues regardless of intraday P&L.
        daily_loss_limit_enabled: bool = True,
        # Consecutive-loss cooldown — set to False to disable the consecutive-loss
        # pause. When False the consecutive_losses counter still increments but the
        # cooldown gate in can_trade() is never applied.
        consecutive_loss_cooldown_enabled: bool = True,
        # Time window — restrict entries to a UTC hour range (London/NY overlap
        # default: 12–16 UTC, the highest-volatility window for momentum setups).
        # Set use_time_window=False to trade around the clock.
        use_time_window: bool = False,
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

        # ── TP / SL / Martingale ──────────────────────────────────────────────
        self._tp_atr_multiplier    = float(tp_atr_multiplier)
        self._sl_atr_multiplier    = float(sl_atr_multiplier)
        self._martingale_multiplier = float(martingale_multiplier)
        self._breakeven_atr_trigger = (
            float(breakeven_atr_trigger) if breakeven_atr_trigger is not None else None
        )

        # ── Position gate ──────────────────────────────────────────────────────
        self._max_open_positions = int(max_open_positions)

        # ── Cooldown ───────────────────────────────────────────────────────────
        self._cooldown_after_trade_s = int(cooldown_after_trade_seconds)
        self._cooldown_after_loss_s  = int(cooldown_after_loss_seconds)
        self._scan_interval_s        = int(scan_interval_seconds)

        # ── L0 notional ────────────────────────────────────────────────────────
        _clamped = max(float(l0_entry_notional_usd), _L0_ENTRY_NOTIONAL_MIN)
        if _clamped != float(l0_entry_notional_usd):
            logger.warning(
                "[MomentumScalper] l0_entry_notional_usd=%.2f is below the minimum "
                "%.2f — clamping to %.2f",
                l0_entry_notional_usd, _L0_ENTRY_NOTIONAL_MIN, _clamped,
            )
        self._l0_entry_notional_usd = _clamped

        # ── Daily loss limit toggle ────────────────────────────────────────────
        self._daily_loss_limit_enabled = bool(daily_loss_limit_enabled)

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
            bot_id                              = bot_id,
            db_client                           = db_client,
            allocated_usdc                      = allocated_usdc,
            risk_per_trade                      = risk_per_trade,
            max_daily_loss_pct                  = max_daily_loss_pct,
            max_consecutive_losses              = max_consecutive_losses,
            consecutive_loss_cooldown_minutes   = consecutive_loss_cooldown_minutes,
            max_leverage                        = leverage,
            min_profit_to_fee_ratio             = min_profit_to_fee_ratio,
            estimated_fee_pct                   = estimated_fee_pct,
            daily_loss_limit_enabled            = daily_loss_limit_enabled,
            consecutive_loss_cooldown_enabled   = consecutive_loss_cooldown_enabled,
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
        self._position_size:  float = 0.0   # base-asset units held (synced from clearinghouse)
        self._entry_price:    float = 0.0   # VWAP entry across all martingale fills
        self._entry_atr:      float = 0.0   # ATR (price units) captured at initial entry — fixed
        self._initial_entry_price: float = 0.0  # price of level-0 fill (never changes)
        self._initial_entry_size:  float = 0.0  # size of level-0 fill (basis for martingale sizing)

        # Resting order IDs — NO SL order is ever placed in martingale mode.
        self._entry_oid: int | None = None
        self._tp_oid:    int | None = None
        self._sl_oid:    int | None = None   # always None; kept for _cancel_all_resting compatibility

        # Unix timestamp (ms) when the entry order was placed — used to filter
        # post-entry fills from get_user_fills() in _on_close().
        self._entry_time: int = 0

        # Supabase position_group UUID
        self._position_group_id: str | None = None

        # ── Martingale state ───────────────────────────────────────────────────
        # No SL is placed.  If price moves adversely, reinforcement layers are
        # added indefinitely (bounded only by available account margin).
        #
        # Trigger for level N: N × sl_atr_multiplier × _entry_atr adverse from
        # _initial_entry_price.  Computed on demand each tick — no pre-built list.
        #
        # Size for level N: φ^(N-1) × _initial_entry_size  (golden ratio series).
        #
        # WARNING: unlimited drawdown risk up to liquidation.  User confirmed.
        self._martingale_level: int = 0   # 0 = only initial entry filled so far
        self._martingale_level_unknown: bool = False  # True = level NULL at restore; reinforcement suspended

        # Breakeven field kept to avoid AttributeError in any path that checks it,
        # but the move-to-breakeven logic is removed — replaced by martingale.
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
        """Return the base-asset size for the initial (L0) entry.

        Sizing is fixed-notional: every entry targets self._l0_entry_notional_usd
        (default $11) of margin at the effective leverage, regardless of ATR or
        equity.  This replaces the previous ATR-risk formula, which collapsed
        to near-zero stop distances on quiet setups and produced enormous,
        margin-cap-dominated positions.

        Note: risk_per_trade is still wired through to RiskManager (and still
        used by momentum_fade_scalper's compute_position_size), but no longer
        influences momentum_scalper initial sizing.

        Two gates are preserved from the old path:
          1. Margin safety cap (90% of equity) — defense-in-depth; at $11
             base this should never fire but remains for safety.
          2. Profitability filter — skips the trade if TP profit/unit is less
             than min_profit_to_fee_ratio × estimated fee/unit.  Size-
             independent, so it applies equally at $11 as at any other size.

        Returns 0.0 when the profitability filter rejects the setup — caller
        should treat 0.0 as "do not enter".
        """
        if entry_price <= 0:
            return 0.0

        eff_leverage = min(self._leverage, self._risk_manager._max_leverage)
        raw_size     = (self._l0_entry_notional_usd * eff_leverage) / entry_price

        # Margin safety cap (defense-in-depth — should not fire at $11 base).
        max_margin      = self._risk_manager.equity * _MARGIN_SAFETY_BUFFER
        margin_required = (raw_size * entry_price) / eff_leverage
        if margin_required > max_margin:
            raw_size = (max_margin * eff_leverage) / entry_price
            logger.warning(
                "[MomentumScalper] _compute_size: margin cap fired "
                "(equity=%.2f max_margin=%.2f required=%.2f) — capped raw_size=%.6f",
                self._risk_manager.equity, max_margin, margin_required, raw_size,
            )

        # Profitability filter: TP profit/unit vs estimated round-trip fee/unit.
        # Both scale linearly with size — no position size can rescue a setup
        # that fails here.  Returns 0.0 to skip the trade cleanly.
        tp_profit_per_unit = self._tp_atr_multiplier * atr_value
        fee_per_unit       = entry_price * (self._risk_manager._estimated_fee_pct / 100.0)
        min_profit_needed  = self._risk_manager._min_profit_to_fee_ratio * fee_per_unit
        if tp_profit_per_unit < min_profit_needed:
            logger.info(
                "[MomentumScalper] Trade skipped — TP profit/unit (%.5f) < %.1f× "
                "estimated fee/unit (%.5f): tp_mult=%.2f atr=%.4f entry=%.4f",
                tp_profit_per_unit, self._risk_manager._min_profit_to_fee_ratio,
                min_profit_needed, self._tp_atr_multiplier, atr_value, entry_price,
            )
            return 0.0

        logger.info(
            "[MomentumScalper] _compute_size: fixed notional=%.2f USD "
            "entry=%.4f leverage=%dx → raw_size=%.6f",
            self._l0_entry_notional_usd, entry_price, eff_leverage, raw_size,
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

    # ── Martingale helpers ────────────────────────────────────────────────────

    async def _persist_martingale_state(
        self,
        active_coin: str | None,
        level: int,
        trigger_px: float | None,
        initial_entry_size: float | None = None,
        entry_atr: float | None = None,
    ) -> None:
        """Write martingale state to bot_risk_state (non-fatal if it fails).

        Called at three points: initial entry fill confirmed, each reinforcement
        fill confirmed, and position close.  Errors are swallowed — a failed write
        degrades restore accuracy only, never the trading path.

        ``initial_entry_size`` and ``entry_atr`` are only passed at the initial
        entry call site — they are fixed for the position lifetime and must not
        be overwritten on reinforcement fills or close.  Passing None (the default)
        leaves the existing column value untouched in the UPDATE.
        """
        if not self._db or not self._bot_id:
            return
        try:
            now = datetime.now(timezone.utc).isoformat()
            row: dict = {
                "active_coin":                active_coin,
                "martingale_level":            level,
                "next_martingale_trigger_px":  trigger_px,
                "updated_at":                  now,
            }
            if initial_entry_size is not None:
                row["initial_entry_size"] = initial_entry_size
            if entry_atr is not None:
                row["entry_atr"] = entry_atr
            await _run_db_call(
                lambda: self._db.table("bot_risk_state").update(row)
                .eq("bot_id", self._bot_id).execute()
            )
        except asyncio.TimeoutError:
            self._log("warning", "_persist_martingale_state timed out (non-fatal)")
        except Exception as exc:
            self._log("warning", f"_persist_martingale_state failed (non-fatal): {exc}")

    async def _cold_start_restore(self) -> None:
        """Detect and restore in-memory state after a Worker cold start.

        Queries position_groups (by bot_id + status='open') and bot_risk_state
        to reconstruct all position-tracking fields so the main loop re-enters
        in_position mode for any open position that survived the restart.

        Non-fatal: any unexpected failure leaves state as-is (idle) with an
        error log.  CancelledError propagates so the task can be stopped cleanly.
        """
        if not self._db or not self._bot_id:
            return

        try:
            # ── 1. Check for an open position_group owned by this bot ─────────
            pg_res = await _run_db_call(
                lambda: self._db.table("position_groups")
                .select("id, coin, side, entry_price, created_at")
                .eq("bot_id", self._bot_id)
                .eq("status", "open")
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            if not pg_res.data:
                self._log("info", "cold_start_restore: no open position_group — starting idle")
                return

            pg          = pg_res.data[0]
            coin        = pg["coin"]   # e.g. "HYPE" or "dex:HYPE"
            short_coin  = coin.split(":")[-1] if ":" in coin else coin
            is_long     = pg["side"] == "long"
            initial_px  = float(pg["entry_price"])
            pg_id       = pg["id"]

            try:
                dt = datetime.fromisoformat(pg["created_at"].replace("Z", "+00:00"))
                entry_time_ms = int(dt.timestamp() * 1000)
            except Exception:
                entry_time_ms = 0

            self._log(
                "info",
                f"cold_start_restore: open position_group found — "
                f"id={pg_id} coin={coin} side={pg['side']} "
                f"initial_entry_price={initial_px}",
            )

            # ── 2. Verify the position is still live on the exchange ──────────
            szi, vwap_entry = await self._get_position(coin, short_coin)
            if abs(szi) < 1e-9:
                self._log(
                    "warning",
                    f"cold_start_restore: position_group {pg_id} is open in DB but "
                    f"clearinghouse shows no position for {short_coin} — leaving idle "
                    f"(closed externally; will be reconciled on next tick)",
                )
                return

            # ── 3. Load persisted entry constants from bot_risk_state ─────────
            rs_res = await _run_db_call(
                lambda: self._db.table("bot_risk_state")
                .select("martingale_level, initial_entry_size, entry_atr")
                .eq("bot_id", self._bot_id)
                .execute()
            )
            rs = rs_res.data[0] if rs_res.data else {}

            raw_level             = rs.get("martingale_level")
            initial_entry_size_db = rs.get("initial_entry_size")
            entry_atr_db          = rs.get("entry_atr")

            if raw_level is None:
                # Level is genuinely unknown — cannot safely compute trigger distances.
                # Bot will manage the existing TP but fire NO reinforcement orders.
                martingale_level = 0
                level_unknown    = True
            else:
                martingale_level = int(raw_level)
                level_unknown    = False

            # ── 4. Resolve entry_atr (fixed at L0; fallback: recompute) ───────
            if entry_atr_db is not None:
                entry_atr = float(entry_atr_db)
            else:
                self._log(
                    "warning",
                    "cold_start_restore: entry_atr is NULL — recomputing from current candles",
                )
                entry_atr = await self._get_current_atr(coin)
                if entry_atr is None or entry_atr <= 0.0:
                    self._log(
                        "error",
                        "cold_start_restore: ATR fallback also failed — "
                        "cannot safely restore state without ATR, leaving idle",
                    )
                    return

            # ── 5. Resolve initial_entry_size (fallback: current full size) ───
            if initial_entry_size_db is not None:
                initial_entry_size = float(initial_entry_size_db)
            else:
                self._log(
                    "warning",
                    f"cold_start_restore: initial_entry_size is NULL — "
                    f"approximating as current position size {abs(szi):.6f}",
                )
                initial_entry_size = abs(szi)

            # ── 6. Find resting TP order on the exchange ──────────────────────
            tp_oid: int | None = None
            try:
                orders = await hyperliquid_service.get_open_orders(
                    self._master_address, self._dex
                )
                def _strip_dex(c: str) -> str:
                    return c.split(":")[-1] if ":" in c else c

                for o in (orders or []):
                    if not isinstance(o, dict):
                        continue
                    if _strip_dex(o.get("coin", "")) != short_coin:
                        continue
                    if o.get("isTrigger") and o.get("reduceOnly"):
                        tp_oid = int(o["oid"])
                        break
            except Exception as exc:
                self._log(
                    "warning",
                    f"cold_start_restore: open-orders fetch failed (non-fatal): {exc}",
                )

            # ── 7. Restore all in-memory state fields ─────────────────────────
            sz_decimals = self._sz_decimals_map.get(short_coin, 5)

            self._current_symbol      = short_coin
            self._current_coin        = coin
            self._current_sz_decimals = sz_decimals
            self._is_long             = is_long
            self._position_size       = abs(szi)
            self._entry_price         = vwap_entry
            self._entry_atr           = entry_atr
            self._initial_entry_price = initial_px
            self._initial_entry_size  = initial_entry_size
            self._martingale_level         = martingale_level
            self._martingale_level_unknown = level_unknown
            self._tp_oid                   = tp_oid
            self._sl_oid                   = None
            self._position_group_id        = pg_id
            self._entry_time               = entry_time_ms
            self._breakeven_triggered      = False
            self._state                    = "in_position"

            self._log(
                "info",
                f"cold_start_restore: state restored — "
                f"coin={coin} {'LONG' if is_long else 'SHORT'} "
                f"size={abs(szi):.6f} vwap_entry={vwap_entry:.4f} "
                f"initial_entry_price={initial_px:.4f} entry_atr={entry_atr:.6f} "
                f"martingale_level={martingale_level} level_unknown={level_unknown} "
                f"initial_entry_size={initial_entry_size:.6f} "
                f"tp_oid={tp_oid} position_group_id={pg_id}",
            )

            if level_unknown:
                self._log(
                    "warning",
                    f"cold_start_restore: martingale_level is NULL in bot_risk_state for {coin} — "
                    f"entering TP-ONLY MODE. Reinforcement layers are DISABLED until the real "
                    f"level is manually verified and the bot is redeployed with a known level. "
                    f"TP monitoring and close detection are fully active.",
                )

            # ── 8. Refresh bot_risk_state.active_coin (may be NULL pre-deploy) ─
            await self._persist_martingale_state(
                active_coin=coin,
                level=martingale_level,
                trigger_px=self._compute_next_trigger(martingale_level + 1),
            )

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log(
                "error",
                f"cold_start_restore: unexpected error — leaving idle: {exc}",
            )

    def _compute_next_trigger(self, level: int) -> float:
        """Return the mark price that should trigger martingale layer *level*.

        Measured from ``_initial_entry_price`` using ``_entry_atr`` (both fixed
        at the initial fill and never updated).

        Level N triggers when price moves N × sl_atr_multiplier × ATR adverse:
            Long:  trigger = initial_entry_price − N × sl_atr_multiplier × ATR
            Short: trigger = initial_entry_price + N × sl_atr_multiplier × ATR
        """
        distance = level * self._sl_atr_multiplier * self._entry_atr
        if self._is_long:
            return round_price(self._initial_entry_price - distance)
        return round_price(self._initial_entry_price + distance)

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

    async def _cancel_safe(self, coin: str, oid: int | None) -> bool:
        """Cancel one order by oid; swallows errors (idempotent).

        Returns True if Hyperliquid confirmed the cancel with status "ok" and
        statuses[0] == "success" — meaning the order is atomically gone from the
        book.  Returns False on any exception or non-success response (e.g. order
        already filled/cancelled before we got to it).  The caller can skip the
        post-cancel settle sleep when True is returned, since HL's cancel is
        synchronous: a success response guarantees the order is off the book.
        """
        if oid is None:
            return True   # nothing to cancel — treat as confirmed
        try:
            result = await hyperliquid_service.cancel_order(
                self._private_key, self._master_address, coin, oid
            )
            # HL cancel success shape:
            # {"status": "ok", "response": {"type": "cancel", "data": {"statuses": ["success"]}}}
            confirmed = (
                isinstance(result, dict)
                and result.get("status") == "ok"
                and result.get("response", {}).get("data", {}).get("statuses", [None])[0] == "success"
            )
            if confirmed:
                self._log("info", f"cancel oid={oid} confirmed by exchange (order removed from book)")
            else:
                self._log("warning", f"cancel oid={oid} response not clean-success — result={result}")
            return confirmed
        except Exception as exc:
            self._log("warning", f"cancel oid={oid} failed (may already be gone): {exc}")
            return False

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

        # ── 4. Compute TP anchored to confirmed entry price ────────────────────
        # Recompute atr_value using the confirmed entry price for accuracy.
        # sl_atr_multiplier is repurposed here as the MARTINGALE LAYER DISTANCE
        # (adverse ATR multiples that trigger each reinforcement layer).
        # No SL order is placed — protection is via martingale reinforcement only.
        confirmed_atr = (ms.atr_pct / 100.0) * entry_px

        if is_long:
            tp_price = round_price(entry_px + self._tp_atr_multiplier * confirmed_atr)
        else:
            tp_price = round_price(entry_px - self._tp_atr_multiplier * confirmed_atr)

        # Martingale layer distance: sl_atr_multiplier × ATR adverse per level.
        # Triggers are computed on demand each tick via _compute_next_trigger() —
        # no pre-built list; number of levels is unlimited (margin-bounded).
        layer_distance = self._sl_atr_multiplier * confirmed_atr
        # First trigger preview (L1) for the entry log — purely informational.
        l1_trigger = round_price(
            entry_px - layer_distance if is_long else entry_px + layer_distance
        )

        self._log(
            "info",
            f"TP={tp_price:.4f} ({self._tp_atr_multiplier}×ATR) | "
            f"NO SL — martingale L1 trigger @ {l1_trigger:.4f} "
            f"(layer_dist={layer_distance:.4f} = {self._sl_atr_multiplier}×ATR, unlimited levels) | "
            f"confirmed_atr={confirmed_atr:.4f}",
        )

        # ── 5. Populate state fields (before placing orders, so _cancel_all_resting works) ──
        self._current_symbol           = symbol
        self._current_coin             = coin
        self._current_sz_decimals      = sz_decimals
        self._is_long                  = is_long
        self._position_size            = confirmed_size
        self._entry_price              = entry_px
        self._entry_atr                = confirmed_atr
        self._initial_entry_price      = entry_px
        self._initial_entry_size       = confirmed_size
        self._martingale_level    = 0
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

                # Record full indicator snapshot for this trade — fire-and-forget.
                try:
                    await record_trade_signal(
                        db                = self._db,
                        position_group_id = pg_id,
                        bot_id            = self._bot_id,
                        coin              = coin,
                        side              = "long" if is_long else "short",
                        entry_price       = entry_px,
                        ms                = ms,
                    )
                except Exception as sig_exc:
                    self._log("warning", f"record_trade_signal failed (non-fatal): {sig_exc}")

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

        # ── 7. Place TP order only — NO SL in martingale mode ────────────────
        await self._place_tp_only(
            is_long     = is_long,
            coin        = coin,
            size        = confirmed_size,
            sz_decimals = sz_decimals,
            tp_price    = tp_price,
        )

        # ── 8. Transition to in_position ───────────────────────────────────────
        self._state = "in_position"
        await self._persist_martingale_state(
            active_coin=coin,
            level=0,
            trigger_px=self._compute_next_trigger(1),
            initial_entry_size=self._initial_entry_size,
            entry_atr=self._entry_atr,
        )
        self._log(
            "info",
            f"Position open (martingale mode) — symbol={symbol} direction={direction_label} "
            f"size={confirmed_size} entry={entry_px:.4f} "
            f"TP={tp_price:.4f} [NO SL] tp_oid={self._tp_oid} "
            f"martingale_L1_trigger={self._compute_next_trigger(1):.4f} (unlimited levels)",
        )

    async def _place_tp_only(
        self,
        is_long: bool,
        coin: str,
        size: float,
        sz_decimals: int,
        tp_price: float,
    ) -> None:
        """Place a TP trigger order only — no SL is ever placed in martingale mode."""
        self._log(
            "info",
            f"_place_tp_only: placing TP @ {tp_price:.4f} size={size} coin={coin} "
            f"({'long→sell' if is_long else 'short→buy'})",
        )
        try:
            result = await hyperliquid_service.place_tp_sl(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_long        = is_long,
                size           = size,
                sz_decimals    = sz_decimals,
                tp_price       = tp_price,
                sl_price       = None,   # NO SL — martingale mode, user accepts liquidation risk
            )
            self._tp_oid = _extract_oid(result.get("tp"))
            self._sl_oid = None

            if self._tp_oid is not None:
                self._log(
                    "info",
                    f"_place_tp_only: TP placed successfully — oid={self._tp_oid} @ {tp_price:.4f} | NO SL (martingale mode)",
                )
            else:
                # HL returned a response but no resting/filled oid could be extracted.
                # This means the order was rejected or returned an unexpected shape.
                self._log(
                    "warning",
                    f"_place_tp_only: TP placement got no valid oid — position is UNPROTECTED. "
                    f"raw_result={result}",
                )

            if self._db and self._position_group_id and self._tp_oid is not None:
                try:
                    await record_position_order(
                        db                = self._db,
                        position_group_id = self._position_group_id,
                        bot_id            = self._bot_id,
                        oid               = self._tp_oid,
                        order_role        = "tp",
                        coin              = coin,
                    )
                except Exception as rec_exc:
                    self._log("warning", f"record_position_order(tp) failed: {rec_exc}")
        except Exception as exc:
            self._log(
                "error",
                f"_place_tp_only: FAILED — position is UNPROTECTED (no TP on exchange). "
                f"coin={coin} tp_price={tp_price:.4f} error={exc}",
            )

    async def _reprice_tp(self, coin: str, new_avg_entry: float) -> None:
        """Cancel the existing TP and place a new one at new_avg_entry ± tp_atr_multiplier×ATR.

        Called after each martingale layer fills to move TP to the new VWAP.
        Uses _entry_atr (fixed at initial entry) for deterministic TP distance.

        Naked-window strategy:
          - If _cancel_safe returns True (exchange confirmed the cancel), we skip
            the settle sleep entirely — HL guarantees the order is off the book on
            a success response, so no sleep is needed.
          - If _cancel_safe returns False (exception, timeout, or non-success
            response), we keep the original 0.3s sleep as a safety fallback.
            This is no worse than the previous behaviour.
        The elapsed time from cancel-fire to new-TP-confirmed is logged so we can
        verify the actual improvement in Railway logs.
        """
        import time as _time
        sz_dec     = self._current_sz_decimals
        old_tp_oid = self._tp_oid   # snapshot before nulling, for diagnostic log

        # Cancel old TP FIRST — must fire before new TP is placed so the exchange
        # never sees two reduce-only TP orders simultaneously.
        t_cancel_start = _time.monotonic()
        cancel_confirmed = await self._cancel_safe(coin, old_tp_oid)
        self._tp_oid = None

        if cancel_confirmed:
            # Exchange confirmed the order is gone — no sleep needed.
            self._log(
                "info",
                f"_reprice_tp: cancel confirmed for oid={old_tp_oid} — skipping settle sleep "
                f"(elapsed so far: {((_time.monotonic() - t_cancel_start) * 1000):.0f}ms)",
            )
        else:
            # Cancel unconfirmed — sleep to reduce duplicate-TP risk.
            self._log(
                "warning",
                f"_reprice_tp: cancel unconfirmed for oid={old_tp_oid} — "
                f"sleeping {_CANCEL_SETTLE_S}s as fallback",
            )
            await asyncio.sleep(_CANCEL_SETTLE_S)

        if self._is_long:
            new_tp = round_price(new_avg_entry + self._tp_atr_multiplier * self._entry_atr)
        else:
            new_tp = round_price(new_avg_entry - self._tp_atr_multiplier * self._entry_atr)

        self._log(
            "info",
            f"Repricing TP after martingale L{self._martingale_level}: "
            f"cancelled old_tp_oid={old_tp_oid} | "
            f"new_avg_entry={new_avg_entry:.4f} → new_TP={new_tp:.4f} "
            f"({self._tp_atr_multiplier}×ATR={self._entry_atr:.4f})",
        )

        # Place new TP for the full (enlarged) position size.
        await self._place_tp_only(
            is_long     = self._is_long,
            coin        = coin,
            size        = self._position_size,
            sz_decimals = sz_dec,
            tp_price    = new_tp,
        )

        elapsed_ms = (_time.monotonic() - t_cancel_start) * 1000
        self._log(
            "info",
            f"_reprice_tp complete: cancel→new_TP total elapsed={elapsed_ms:.0f}ms "
            f"(cancel_confirmed={cancel_confirmed}, new_tp_oid={self._tp_oid})",
        )

    async def _trigger_martingale_layer(self, level: int, coin: str, short_coin: str) -> None:
        """Place the martingale reinforcement order for the given level.

        Size = φ^(level-1) × _initial_entry_size  (golden-ratio Fibonacci):
            Level 1: 1.000×, Level 2: 1.618×, Level 3: 2.618×, Level 4: 4.236×, …

        After fill is confirmed, recomputes VWAP entry from live clearinghouse data
        and reprices the TP accordingly.

        Insufficient margin: if the exchange rejects the order with an
        "Insufficient margin" error, the method logs a warning and returns WITHOUT
        incrementing _martingale_level, so the same level is retried on the next
        tick.  The scan_interval_seconds sleep provides natural backoff — no
        tight-loop retry that could freeze the event loop.
        """
        # Fibonacci-like progression — unbounded, formula-driven.
        multiplier = self._martingale_multiplier ** (level - 1)
        sz_dec     = self._current_sz_decimals
        raw_size   = self._initial_entry_size * multiplier
        layer_size = round_size(raw_size, sz_dec)

        # Apply min-notional bump in case size rounds to 0 or below $10.
        try:
            mids = await hyperliquid_service.get_all_mids()
            mark = float(mids.get(short_coin, 0))
        except Exception as exc:
            self._log("error", f"get_all_mids() for martingale L{level} sizing failed: {exc}")
            return
        if mark <= 0:
            self._log("error", f"Invalid mark price for martingale L{level} sizing: {mark}")
            return

        layer_size  = self._ensure_min_notional(layer_size, mark, sz_dec)
        trigger_px  = self._compute_next_trigger(level)

        self._log(
            "info",
            f"Martingale L{level} triggered — placing reinforcement order: "
            f"size={layer_size} ({multiplier:.4f}× initial {self._initial_entry_size}) "
            f"@ ~{mark:.4f} trigger_px={trigger_px:.4f}",
        )

        # Place market IOC reinforcement order.
        try:
            result = await hyperliquid_service.place_order(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_buy         = self._is_long,
                size           = layer_size,
                price          = mark,
                order_type     = "market",
                leverage       = self._leverage,
                sz_decimals    = sz_dec,
            )
            self._log("info", f"[diag] martingale L{level} place_order result: {result}")
            layer_oid = _extract_oid(result)
            try:
                for s in (result or {}).get("response", {}).get("data", {}).get("statuses", []):
                    if "error" in s:
                        err_str = s["error"]
                        # Insufficient margin: log as WARNING, do NOT advance level.
                        # The next tick will retry naturally after scan_interval_seconds.
                        if "Insufficient margin" in err_str or "insufficient margin" in err_str:
                            self._log(
                                "warning",
                                f"Martingale L{level} skipped — Insufficient margin "
                                f"(size={layer_size} @ {mark:.4f}): {err_str}. "
                                f"Will retry next tick.",
                            )
                            return
                        self._log("error", f"Martingale L{level} REJECTED: {err_str}")
                        return
            except Exception:
                pass
        except Exception as exc:
            self._log("error", f"Martingale L{level} order failed: {exc}")
            return

        # Wait for fill propagation (same pattern as initial entry).
        self._log("info", f"Waiting {_FILL_WAIT_S:.0f}s for martingale L{level} fill…")
        await asyncio.sleep(_FILL_WAIT_S)

        # Confirm fill via clearinghouse — get updated VWAP entry.
        szi, new_avg_entry = await self._get_position(coin, short_coin)
        new_size = abs(szi)
        if new_size <= self._position_size:
            self._log(
                "warning",
                f"Martingale L{level} fill NOT confirmed — position size unchanged "
                f"({new_size} vs {self._position_size}). Skipping VWAP/TP reprice.",
            )
            return

        # Advance martingale state.
        self._martingale_level = level
        self._position_size    = new_size
        # _entry_price tracks current VWAP (updated from clearinghouse).
        self._entry_price      = new_avg_entry if new_avg_entry > 0 else self._entry_price

        self._log(
            "info",
            f"Martingale L{level} fill confirmed: new_size={new_size:.6f} "
            f"vwap_entry={self._entry_price:.4f}",
        )

        # Record in position_orders.
        if self._db and self._position_group_id and layer_oid is not None:
            try:
                await record_position_order(
                    db                = self._db,
                    position_group_id = self._position_group_id,
                    bot_id            = self._bot_id,
                    oid               = layer_oid,
                    order_role        = f"martingale_{level}",
                    coin              = coin,
                )
            except Exception as rec_exc:
                self._log("warning", f"record_position_order(martingale_{level}) failed: {rec_exc}")

        await self._persist_martingale_state(
            active_coin=coin,
            level=self._martingale_level,
            trigger_px=self._compute_next_trigger(self._martingale_level + 1),
        )

        # Cancel old TP and reprice to new VWAP.
        await self._reprice_tp(coin, self._entry_price)

    # ── Position management tick ──────────────────────────────────────────────

    async def _tick_in_position(self) -> None:
        """Poll position state; trigger martingale layers if price hits trigger levels.

        No SL, no level cap.  Layers are added indefinitely as long as the account
        has sufficient margin.  An Insufficient margin rejection is handled inside
        _trigger_martingale_layer() and results in a clean return (retried next tick).
        """
        coin       = self._current_coin
        short_coin = coin.split(":")[-1] if ":" in coin else coin
        sz_dec     = self._current_sz_decimals

        # ── 1. Flat-position detection ─────────────────────────────────────────
        szi, _ = await self._get_position(coin, short_coin)

        if abs(szi) < 10 ** (-sz_dec):
            # Position is flat — determine outcome from which order is still live.
            live_oids = await self._get_open_order_oids(short_coin)
            await self._on_close(live_oids)
            return

        # Sync position size from exchange on every poll.
        self._position_size = abs(szi)

        # ── 2. Martingale trigger check ────────────────────────────────────────
        # Guard: if the level was unknown at cold-start restore, skip the entire
        # trigger check.  TP monitoring (step 1 flat-position detection) already
        # ran above — protection is intact.  Reinforcement is re-enabled only
        # after the position closes (which resets _martingale_level_unknown via
        # _reset_state) and a fresh entry sets a confirmed level of 0.
        if self._martingale_level_unknown:
            return

        # No level cap — layers are added as long as the account has margin.
        # Fetch mark price to compare against the next computed trigger.
        try:
            mids       = await hyperliquid_service.get_all_mids()
            mark_price = float(mids.get(short_coin, 0))
        except Exception as exc:
            self._log("warning", f"get_all_mids() for martingale check failed: {exc}")
            return

        if mark_price <= 0:
            self._log("warning", f"Invalid mark price ({mark_price}) — skipping martingale check")
            return

        next_level = self._martingale_level + 1
        trigger_px = self._compute_next_trigger(next_level)

        # Long: price falls AT OR BELOW trigger → add long.
        # Short: price rises AT OR ABOVE trigger → add short.
        triggered = (
            (self._is_long     and mark_price <= trigger_px) or
            (not self._is_long and mark_price >= trigger_px)
        )

        if triggered:
            self._log(
                "info",
                f"Martingale L{next_level} trigger hit: "
                f"mark={mark_price:.4f} {'<=' if self._is_long else '>='} "
                f"trigger={trigger_px:.4f} — adding reinforcement layer",
            )
            await self._trigger_martingale_layer(next_level, coin, short_coin)
        else:
            self._log(
                "info",
                f"In position (L{self._martingale_level}): mark={mark_price:.4f} | "
                f"next martingale trigger L{next_level} @ {trigger_px:.4f} "
                f"({'need ≤' if self._is_long else 'need ≥'} {trigger_px:.4f})",
            )

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
        snap_entry_price      = self._entry_price
        snap_position_size    = self._position_size
        snap_is_long          = self._is_long
        snap_current_coin     = self._current_coin
        snap_entry_time       = self._entry_time   # ms, set at entry order placement
        snap_position_group_id = self._position_group_id

        short_coin = (
            snap_current_coin.split(":")[-1]
            if snap_current_coin and ":" in snap_current_coin
            else snap_current_coin or ""
        )

        tp_alive = self._tp_oid is not None and self._tp_oid in live_oids

        # oid-liveness heuristic (martingale mode — no SL order is ever placed).
        # TP consumed → TP hit.  TP still live → closed before TP (liquidation / manual).
        if not tp_alive:
            oid_outcome  = "TP_HIT"
            oid_cooldown = self._cooldown_after_trade_s
        else:
            oid_outcome  = "CLOSED_UNKNOWN"
            oid_cooldown = self._cooldown_after_loss_s

        self._log(
            "info",
            f"Position closed — oid_heuristic={oid_outcome} "
            f"(tp_alive={tp_alive}) | "
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

        # Update trade_signal row with outcome and PnL — fire-and-forget.
        if snap_position_group_id and self._db:
            try:
                await update_trade_signal_outcome(
                    db                = self._db,
                    position_group_id = snap_position_group_id,
                    outcome           = outcome,
                    pnl_usd           = pnl_usd,
                )
            except Exception as sig_exc:
                self._log("warning", f"update_trade_signal_outcome failed (non-fatal): {sig_exc}")

        # Clear martingale chart state now that the position is closed.
        await self._persist_martingale_state(active_coin=None, level=0, trigger_px=None)

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

        # ── Exchange-state guard ──────────────────────────────────────────────
        # Confirm the exchange is flat before opening.  If a live position
        # exists while _state is "idle" (state desync, missed cold-start
        # restore, manual position), abort and call _cold_start_restore() so
        # the bot picks up management instead of stacking a second entry.
        # One clearinghouse call covers all symbols; fires only on qualifying
        # scanner matches (not every 5 s tick) — rate-limit impact negligible.
        try:
            cs = await hyperliquid_service.get_clearinghouse_state(
                self._master_address, self._dex
            )
            for ap in (cs or {}).get("assetPositions", []):
                pos = ap.get("position", {})
                detected_coin  = pos.get("coin", "")
                detected_short = detected_coin.split(":")[-1] if ":" in detected_coin else detected_coin
                szi = float(pos.get("szi", 0) or 0)
                if abs(szi) < 1e-9:
                    continue
                if detected_coin not in self._symbols and detected_short not in self._symbols:
                    continue

                # Live position on a symbol this bot trades.  Before treating it
                # as a state desync, confirm this bot_id owns an open
                # position_groups row for this coin.  On a shared wallet another
                # bot instance or manual trade may hold positions on the same
                # symbols — those are not this bot's concern and must not block
                # its entries or trigger a spurious cold_start_restore loop.
                coins_to_check = (
                    [detected_coin]
                    if detected_coin == detected_short
                    else [detected_coin, detected_short]
                )
                owns_pg = True  # conservative default: assume ours if check fails
                if self._db and self._bot_id:
                    try:
                        pg_check = await _run_db_call(
                            lambda _c=coins_to_check: self._db.table("position_groups")
                            .select("id")
                            .eq("bot_id", self._bot_id)
                            .in_("coin", _c)
                            .eq("status", "open")
                            .limit(1)
                            .execute()
                        )
                        owns_pg = bool(pg_check.data)
                    except Exception as pg_exc:
                        self._log(
                            "warning",
                            f"[idle-guard] ownership check for {detected_coin} failed "
                            f"({pg_exc}) — assuming ours, skipping entry attempt",
                        )
                        # owns_pg stays True — skip entry (conservative)

                if not owns_pg:
                    self._log(
                        "info",
                        f"[idle-guard] Live position on {detected_coin} szi={szi:.6f} — "
                        f"no open position_groups row for this bot_id — "
                        f"treating as foreign/manual position, not a desync",
                    )
                    continue  # not this bot's position — keep scanning

                self._log(
                    "warning",
                    f"[idle-guard] Live position detected: {detected_coin} szi={szi:.6f} "
                    f"(bot owns open position_groups row) — aborting entry, "
                    f"running cold_start_restore",
                )
                await self._cold_start_restore()
                return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log(
                "warning",
                f"[idle-guard] Clearinghouse check failed ({exc}) — skipping entry attempt",
            )
            return
        # ── End exchange-state guard ──────────────────────────────────────────

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

        # Restore in-memory position state from DB + exchange if a position
        # was open when the Worker was last restarted.  Must run before the
        # main loop so the first tick enters _tick_in_position, not _tick_idle.
        await self._cold_start_restore()

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
