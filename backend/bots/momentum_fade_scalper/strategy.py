"""
backend/bots/momentum_fade_scalper/strategy.py

Phase 2 — Strategy Engine for the Momentum Fade Scalper.

Overview
--------
FadeScalperBot is a multi-symbol M1 scalper that catches early momentum shifts
using a hard-gate scanner rather than a weighted score.  It enters when ALL five
conditions pass simultaneously (see scanner.py for gate logic), and exits via
ATR-anchored TP/SL orders with optional breakeven SL management.

Key design differences from MomentumScalperBot
-----------------------------------------------
1. Binary qualification (not weighted): scan_symbol() from the fade scanner is
   called per-symbol so all results (qualifying and non-qualifying) are visible
   for logging.  A setup either passes all five gates or it doesn't — there is
   no score threshold to tune.

2. Inverted ATR ratio: tp_atr_multiplier=2.0, sl_atr_multiplier=1.0 by default.
   A 2:1 reward/risk is intentional: the RSI(7) midline-cross fires early in a
   momentum burst, so the expectation is a fast directional move with room to
   run — wider TP, tighter SL.

3. Single-timeframe signal chain: EMA9/21, RSI(7), and Efficiency Ratio are all
   computed on M1 candles.  No M5 confirmation step.

4. RiskManager is reused as-is from bots.momentum_scalper.risk_manager — it is
   completely bot-type-agnostic (equity tracking, drawdown tiers, daily loss,
   consecutive-loss cooldown).  No changes are made to that class.

State machine
-------------
    idle → in_position → cooldown → idle

Sizing
------
Same ATR-risk-based model as MomentumScalperBot:

    risk_capital  = equity × risk_per_trade × drawdown_multiplier
    stop_distance = atr_value × sl_atr_multiplier
    raw_size      = (risk_capital / stop_distance) × leverage

Anti-fee guard (embedded in RiskManager.compute_position_size): returns 0.0 and
skips the trade if expected TP gross profit per unit < min_profit_to_fee_ratio ×
estimated round-trip fee per unit.  For this bot tp_atr_multiplier=2.0 is
specifically chosen to clear that bar even in moderate volatility, but the guard
is always active as a hard stop.  Because the ratio is size-independent (both
profit and fees scale linearly with size), no position size can rescue a setup
that fails — so we skip rather than upsizing.

Trade-signal recording
----------------------
FadeMarketScore has no weighted sub-scores.  _record_fade_signal() inserts a
trade_signals row with the available fields (rsi_m1, atr_pct, volume_ratio_m1,
spread_pct) and leaves the score columns NULL.  efficiency_ratio is logged but
has no dedicated column in the current trade_signals schema.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Callable

from bots.momentum_scalper.risk_manager import RiskManager
from bots.momentum_fade_scalper.scanner import (
    DEFAULT_SCANNER_CONFIG,
    FadeMarketScore,
    scan_symbol,
)
from bots.shared_utils import atr, round_price, round_size
from services.hyperliquid_service import get_candles, hyperliquid_service
from services.position_groups import (
    close_position_group,
    create_position_group,
    record_position_order,
    update_trade_signal_outcome,
)

logger = logging.getLogger(__name__)

# Hyperliquid exchange minimum notional per order (USD).
_HL_MIN_NOTIONAL: float = 10.0

# After placing a market IOC, wait this long before querying clearinghouse.
_FILL_WAIT_S: float = 2.0

# ATR look-back (M1) for entry sizing and position-management re-computation.
_ATR_PERIOD: int = 14

# Break-even fee buffer above/below entry price (0.05 % expressed as fraction).
_BREAKEVEN_FEE_BUFFER: float = 0.0005

# M1 candles to fetch for ATR re-computation during position management.
# ATR(14) needs ≥ 15 bars; 60 gives comfortable headroom.
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


# ── Main bot class ─────────────────────────────────────────────────────────────

class FadeScalperBot:
    """Live multi-symbol momentum-fade scalper.

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
        # TP/SL: inverted ratio vs momentum_scalper — TP is 2× the SL distance.
        # Wide TP captures the burst; tight SL limits loss on failed moves.
        tp_atr_multiplier: float = 2.0,
        sl_atr_multiplier: float = 1.0,
        # Breakeven SL: move SL to entry + fee_buffer once price has moved
        # breakeven_atr_trigger × ATR in the trade's favour.  None = disabled.
        # 0.5 = halfway to TP (a more conservative trigger than momentum_scalper's
        # 0.25, matching the wider TP distance).
        breakeven_atr_trigger: float | None = 0.5,
        # Cooldown durations (time-based, not candle-based).
        cooldown_after_trade_seconds: int = 10,
        cooldown_after_loss_seconds: int = 60,
        # Scanner poll interval.
        scan_interval_seconds: int = 5,
        # Risk manager parameters.
        risk_per_trade: float = 0.02,
        max_daily_loss_pct: float = 0.10,
        max_consecutive_losses: int = 3,
        consecutive_loss_cooldown_minutes: int = 30,
        # min_profit_to_fee_ratio: 3.0 is stricter than momentum_scalper's 1.5
        # because the RSI midline-cross can fire on low-ATR bars where fees eat
        # more of a narrow TP.  3.0 requires TP gross profit ≥ 3× round-trip fee.
        min_profit_to_fee_ratio: float = 3.0,
        estimated_fee_pct: float = 0.07,
        # Infrastructure.
        db_client=None,
        bot_id: str | None = None,
        log_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        # ── Credentials & market ───────────────────────────────────────────────
        self._private_key     = private_key
        self._master_address  = master_address
        self._symbols         = list(symbols)
        self._sz_decimals_map = dict(sz_decimals_map)
        self._dex             = dex or ""

        # ── Capital ────────────────────────────────────────────────────────────
        self._allocated_usdc = float(allocated_usdc)
        self._leverage       = int(leverage)

        # ── Scanner ────────────────────────────────────────────────────────────
        # Merge user overrides on top of DEFAULT_SCANNER_CONFIG so any unspecified
        # keys always fall back to the scanner's validated defaults.
        self._scanner_config: dict = {
            **DEFAULT_SCANNER_CONFIG,
            **(scanner_config or {}),
        }

        # ── TP / SL ────────────────────────────────────────────────────────────
        self._tp_atr_multiplier     = float(tp_atr_multiplier)
        self._sl_atr_multiplier     = float(sl_atr_multiplier)
        self._breakeven_atr_trigger = (
            float(breakeven_atr_trigger) if breakeven_atr_trigger is not None else None
        )

        # ── Cooldown ───────────────────────────────────────────────────────────
        self._cooldown_after_trade_s = int(cooldown_after_trade_seconds)
        self._cooldown_after_loss_s  = int(cooldown_after_loss_seconds)
        self._scan_interval_s        = int(scan_interval_seconds)

        # ── Infrastructure ─────────────────────────────────────────────────────
        self._db           = db_client
        self._bot_id       = bot_id
        self._log_callback = log_callback

        # ── Risk manager (reused from momentum_scalper — bot-type-agnostic) ────
        # RiskManager tracks equity, drawdown tiers, daily loss, and consecutive-
        # loss cooldown.  It is instantiated here exactly as in MomentumScalperBot;
        # no changes are made to the class itself.
        self._risk_manager = RiskManager(
            bot_id                            = bot_id,
            db_client                         = db_client,
            allocated_usdc                    = allocated_usdc,
            risk_per_trade                    = risk_per_trade,
            max_daily_loss_pct                = max_daily_loss_pct,
            max_consecutive_losses            = max_consecutive_losses,
            consecutive_loss_cooldown_minutes = consecutive_loss_cooldown_minutes,
            max_leverage                      = leverage,
            min_profit_to_fee_ratio           = min_profit_to_fee_ratio,
            estimated_fee_pct                 = estimated_fee_pct,
        )

        # ── State ──────────────────────────────────────────────────────────────
        self._reset_state()

    # ── State management ──────────────────────────────────────────────────────

    def _reset_state(self) -> None:
        """Zero all position-tracking variables back to their initial values."""
        # High-level state machine.
        self._state: str = "idle"   # "idle" | "in_position" | "cooldown"

        # Active symbol / coin for the current open position.
        self._current_symbol:      str | None = None   # e.g. "BTC"
        self._current_coin:        str | None = None   # e.g. "BTC" or "xyz:BTC"
        self._current_sz_decimals: int        = 5

        # Position direction and tracking.
        self._is_long:        bool  = False
        self._position_size:  float = 0.0   # base-asset units held
        self._entry_price:    float = 0.0   # confirmed fill price from clearinghouse
        self._entry_atr:      float = 0.0   # ATR (in price units) at entry time

        # Resting order IDs.
        self._entry_oid: int | None = None
        self._tp_oid:    int | None = None
        self._sl_oid:    int | None = None

        # Unix timestamp (ms) when the entry order was placed — used to filter
        # post-entry fills in _on_close() (exit fills have time > this value).
        self._entry_time: int = 0

        # Supabase position_group UUID.
        self._position_group_id: str | None = None

        # Breakeven SL tracking.
        self._breakeven_triggered: bool = False

        # Monotonic-clock cooldown expiry (0.0 = no cooldown active).
        self._cooldown_until: float = 0.0

    # ── Logging ───────────────────────────────────────────────────────────────

    def _log(self, level: str, msg: str) -> None:
        """Emit msg at level to Python logger and the log_callback (if set)."""
        symbol_tag = f"[{self._current_symbol}]" if self._current_symbol else ""
        full_msg   = f"[FadeScalper]{symbol_tag} {msg}"
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

    # ── Sizing ────────────────────────────────────────────────────────────────

    def _compute_size(
        self,
        entry_price: float,
        atr_value: float,
        sz_decimals: int,
    ) -> float:
        """Return the base-asset size for this trade (rounded to exchange ticks).

        Delegates entirely to RiskManager.compute_position_size(), which applies
        equity-based sizing with drawdown-tier scaling, a margin safety cap, and
        the anti-fee profitability filter (tp_atr_multiplier × atr vs estimated
        fee).  Returns 0.0 when the setup is unprofitable or inputs are degenerate
        — caller must treat 0.0 as "do not enter".
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
        """Bump size up by one tick until size × price ≥ $10 minimum notional."""
        increment = 10 ** (-sz_decimals)
        while size * price < _HL_MIN_NOTIONAL:
            size += increment
            size  = round_size(size, sz_decimals)
        return size

    # ── Market data ───────────────────────────────────────────────────────────

    async def _get_current_atr(self, coin: str) -> float | None:
        """Fetch M1 candles and return ATR(14) in price units.  None on error."""
        try:
            candles = await get_candles(coin, "1m", _ATR_CANDLE_LIMIT)
        except Exception as exc:
            self._log("error", f"_get_current_atr fetch failed: {exc}")
            return None
        if not candles:
            return None
        return atr(candles, _ATR_PERIOD)

    async def _get_position(self, coin: str, short_coin: str) -> tuple[float, float]:
        """Return (szi, entryPx) from clearinghouse.  (0.0, 0.0) on error or flat.

        Positive szi = long position.
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
        """Return the set of live open-order oids for short_coin.

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

    # ── Trade signal recording ────────────────────────────────────────────────

    async def _record_fade_signal(
        self,
        position_group_id: str,
        coin: str,
        side: str,
        entry_price: float,
        ms: FadeMarketScore,
    ) -> None:
        """Insert a trade_signals row capturing available FadeMarketScore fields.

        FadeMarketScore uses a hard-gate model with no weighted sub-scores.
        Weighted score columns (score_total, trend_score, etc.) are stored as NULL.
        rsi_m1, atr_pct, volume_ratio_m1, and spread_pct are populated from the
        FadeMarketScore.  efficiency_ratio is logged here but has no dedicated
        column in the current trade_signals schema.

        Fire-and-forget — a DB failure here must never affect trading.
        """
        if not self._db:
            return
        try:
            self._db.table("trade_signals").insert({
                "position_group_id": position_group_id,
                "bot_id":            self._bot_id,
                "coin":              coin,
                "side":              side,
                "entry_price":       entry_price,
                # Weighted sub-scores: not applicable to this hard-gate strategy.
                "score_total":       None,
                "trend_score":       None,
                "momentum_score":    None,
                "volume_score":      None,
                "volatility_score":  None,
                "pullback_score":    None,
                "structure_score":   None,
                "execution_score":   None,
                # EMA separation not a direct FadeMarketScore field; use NULL.
                "ema_sep_pct":       None,
                # RSI: this bot uses RSI(7) on M1 only — no M5 RSI or ADX.
                "rsi_m5":            None,
                "adx_m5":            None,
                "rsi_m1":            float(ms.rsi7),
                # ATR, volume, spread: directly available in FadeMarketScore.
                "atr_pct":           float(ms.atr_pct),
                "volume_ratio_m1":   float(ms.volume_ratio),
                "spread_pct":        float(ms.spread_pct),
                # Order-book depth: not computed by fade scanner.
                "depth_usd":         None,
                "created_at":        datetime.now(timezone.utc).isoformat(),
            }).execute()
            er_str = (
                f"{ms.efficiency_ratio:.3f}"
                if ms.efficiency_ratio is not None else "n/a"
            )
            self._log(
                "info",
                f"trade_signal recorded: pg={position_group_id} "
                f"rsi7={ms.rsi7:.1f} ER={er_str} "
                f"atr_pct={ms.atr_pct:.3f}% vol_ratio={ms.volume_ratio:.2f} "
                f"spread={ms.spread_pct:.4f}%",
            )
        except Exception as exc:
            self._log("warning", f"_record_fade_signal failed (non-fatal): {exc}")

    # ── Position open sequence ────────────────────────────────────────────────

    async def _open_position(self, ms: FadeMarketScore) -> None:
        """Execute the full entry sequence for the best qualifying symbol.

        Steps:
          1.  Fetch current mid price.
          2.  Derive ATR in price units from scanner's atr_pct.
          3.  Size via RiskManager (includes anti-fee guard — returns 0.0 to skip).
          4.  Ensure Hyperliquid's $10 minimum notional.
          5.  Place market IOC entry order.
          6.  Wait _FILL_WAIT_S for fill propagation.
          7.  Confirm fill via clearinghouse; abort if still flat.
          8.  Compute TP / SL anchored to confirmed entry price in ATR units.
          9.  Populate position state fields.
          10. Register position_group in Supabase; record entry oid.
          11. Record FadeMarketScore indicator snapshot (fire-and-forget).
          12. Place TP and SL orders; record their oids.
          13. Transition state machine to in_position.
        """
        symbol      = ms.symbol
        is_long     = ms.direction == "long"
        coin        = f"{self._dex}:{symbol}" if self._dex else symbol
        short_coin  = coin.split(":")[-1] if ":" in coin else coin
        sz_decimals = self._sz_decimals_map.get(symbol, 5)

        # ── 1. Current mid price ───────────────────────────────────────────────
        try:
            mids      = await hyperliquid_service.get_all_mids()
            mid_price = float(mids.get(short_coin, 0))
        except Exception as exc:
            self._log("error", f"get_all_mids() failed: {exc}")
            return

        if mid_price <= 0:
            self._log("error", f"Invalid mid price for {symbol}: {mid_price}")
            return

        # ── 2. ATR in price units ──────────────────────────────────────────────
        # scanner's atr_pct is ATR expressed as % of price at scan time.
        # Multiply by current mid to convert to absolute USD price units.
        atr_value = (ms.atr_pct / 100.0) * mid_price
        if atr_value <= 0:
            self._log(
                "error",
                f"ATR is zero for {symbol} (atr_pct={ms.atr_pct}%) — "
                "cannot compute TP/SL distances; skipping",
            )
            return

        # ── 3. Sizing (anti-fee guard via RiskManager) ─────────────────────────
        # RiskManager.compute_position_size returns 0.0 when:
        #   (a) tp_atr_multiplier × atr < min_profit_to_fee_ratio × fee_per_unit,
        #   (b) stop_distance ≤ 0, or (c) equity margin safety cap returns 0.
        # The fee-ratio check is size-independent — no size can rescue a setup
        # where the TP distance is too narrow relative to fees.  Skip cleanly.
        size = self._compute_size(mid_price, atr_value, sz_decimals)

        if size <= 0:
            self._log(
                "info",
                f"Trade skipped — size=0 from RiskManager "
                f"(anti-fee guard or degenerate input): "
                f"symbol={symbol} atr={atr_value:.4f} mid={mid_price:.4f} "
                f"tp_mult={self._tp_atr_multiplier} sl_mult={self._sl_atr_multiplier} "
                f"min_profit_to_fee_ratio={self._risk_manager._min_profit_to_fee_ratio}",
            )
            return

        # ── 4. Minimum notional bump ───────────────────────────────────────────
        size = self._ensure_min_notional(size, mid_price, sz_decimals)

        direction_label = "LONG" if is_long else "SHORT"
        er_str = (
            f"{ms.efficiency_ratio:.3f}" if ms.efficiency_ratio is not None else "n/a"
        )
        self._log(
            "info",
            f"Entering {direction_label} {symbol} | "
            f"size={size} @ ~{mid_price:.4f} | "
            f"ER={er_str} RSI7={ms.rsi7:.1f} "
            f"atr={atr_value:.4f} atr_pct={ms.atr_pct:.3f}% | "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x",
        )

        # ── 5. Market IOC entry ────────────────────────────────────────────────
        # Record placement time BEFORE the call so fills with time > this value
        # are identified as exit fills in _on_close() (not entry fills).
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
            # Log full raw SDK result so rejections surface in bot UI logs.
            self._log("info", f"[diag] place_order raw result: {result}")
            self._entry_oid = _extract_oid(result)
            # Surface any per-order error strings from the statuses list.
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

        # ── 6. Wait for fill propagation ───────────────────────────────────────
        self._log("info", f"Waiting {_FILL_WAIT_S:.0f}s for fill confirmation…")
        await asyncio.sleep(_FILL_WAIT_S)

        # ── 7. Confirm fill via clearinghouse ──────────────────────────────────
        szi, entry_px = await self._get_position(coin, short_coin)
        if abs(szi) < 10 ** (-sz_decimals):
            self._log(
                "error",
                f"Entry did NOT fill — position still flat after {_FILL_WAIT_S:.0f}s; "
                "abort",
            )
            return

        confirmed_size = abs(szi)
        self._log("info", f"Fill confirmed: szi={szi} entryPx={entry_px:.4f}")

        # ── 8. Compute TP / SL anchored to confirmed entry price ───────────────
        # Recompute atr_value using confirmed entry price for accuracy.
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

        # ── 9. Populate state fields (before placing orders) ───────────────────
        self._current_symbol      = symbol
        self._current_coin        = coin
        self._current_sz_decimals = sz_decimals
        self._is_long             = is_long
        self._position_size       = confirmed_size
        self._entry_price         = entry_px
        self._entry_atr           = confirmed_atr
        self._breakeven_triggered = False

        # ── 10. Register position_group + entry order in Supabase ─────────────
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
                # Non-fatal: we hold the position — continue to place TP/SL.

        # ── 11. Record FadeMarketScore indicator snapshot ──────────────────────
        # Fire-and-forget via _record_fade_signal — DB failure here is non-fatal.
        if self._db and self._position_group_id:
            await self._record_fade_signal(
                position_group_id = self._position_group_id,
                coin              = coin,
                side              = "long" if is_long else "short",
                entry_price       = entry_px,
                ms                = ms,
            )

        # ── 12. Place TP and SL orders ─────────────────────────────────────────
        await self._place_tp_sl(
            is_long     = is_long,
            coin        = coin,
            size        = confirmed_size,
            sz_decimals = sz_decimals,
            tp_price    = tp_price,
            sl_price    = sl_price,
        )

        # ── 13. Transition to in_position ──────────────────────────────────────
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
        """Place TP and SL trigger orders and record their oids in position_orders."""
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
                f"TP oid={self._tp_oid} @ {tp_price:.4f} | "
                f"SL oid={self._sl_oid} @ {sl_price:.4f}",
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
                            self._log(
                                "warning",
                                f"record_position_order({role}) failed: {rec_exc}",
                            )
        except Exception as exc:
            self._log("error", f"place_tp_sl failed: {exc}")

    # ── Position management tick ──────────────────────────────────────────────

    async def _tick_in_position(self) -> None:
        """Poll position state; detect close and manage breakeven SL.

        On every tick:
          1. Query clearinghouse — if position is flat, call _on_close().
          2. Otherwise sync position_size from exchange.
          3. Check if price has moved breakeven_atr_trigger × ATR in our favour;
             if so, move SL to entry ± fee_buffer (idempotent via
             _breakeven_triggered flag).
        """
        coin       = self._current_coin
        short_coin = coin.split(":")[-1] if ":" in coin else coin
        sz_dec     = self._current_sz_decimals

        # ── 1. Flat-position detection ─────────────────────────────────────────
        szi, _ = await self._get_position(coin, short_coin)

        if abs(szi) < 10 ** (-sz_dec):
            # Position is flat — determine outcome from oid liveness and fills.
            live_oids = await self._get_open_order_oids(short_coin)
            await self._on_close(live_oids)
            return

        # Sync position size from exchange on every poll (partial closes / fills).
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
                    self._log(
                        "info",
                        f"Breakeven check: mark={mark_price:.4f} "
                        f"favourable_move={favourable_move:.4f} >= "
                        f"trigger={trigger_distance:.4f} "
                        f"({self._breakeven_atr_trigger}×ATR={self._entry_atr:.4f})",
                    )
                    await self._move_to_breakeven(coin, short_coin)

    async def _move_to_breakeven(self, coin: str, short_coin: str) -> None:  # short_coin unused; kept for call-site symmetry
        """Move SL to entry ± fee_buffer once the breakeven trigger fires.

        The fee buffer (0.05 % of entry) ensures the new SL is above (long) or
        below (short) the entry price by enough to cover taker fees if the price
        reverses sharply through entry.

        Idempotent via _breakeven_triggered flag — once triggered it never fires
        again for the same position, even if subsequent ticks see the condition
        again.
        """
        fee_buffer = self._entry_price * _BREAKEVEN_FEE_BUFFER

        if self._is_long:
            be_sl_price = round_price(self._entry_price + fee_buffer)
        else:
            be_sl_price = round_price(self._entry_price - fee_buffer)

        self._log(
            "info",
            f"Breakeven trigger fired — moving SL to {be_sl_price:.4f} "
            f"(entry={self._entry_price:.4f} fee_buffer={fee_buffer:.4f})",
        )

        # Cancel the existing SL order first.
        await self._cancel_safe(coin, self._sl_oid)
        self._sl_oid = None

        # Place a new SL-only order.  TP is left in place — do not replace it.
        try:
            result = await hyperliquid_service.place_tp_sl(
                private_key    = self._private_key,
                master_address = self._master_address,
                coin           = coin,
                is_long        = self._is_long,
                size           = self._position_size,
                sz_decimals    = self._current_sz_decimals,
                tp_price       = None,          # TP already resting — do not replace
                sl_price       = be_sl_price,
            )
            self._sl_oid          = _extract_oid(result.get("sl"))
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
                    self._log(
                        "warning",
                        f"record_position_order(sl_breakeven) failed: {rec_exc}",
                    )
        except Exception as exc:
            self._log("error", f"Breakeven SL placement failed: {exc}")

    async def _on_close(self, live_oids: set[int]) -> None:
        """Handle position close: compute PnL, record risk result, cancel orders,
        close position_group, update trade_signal, enter cooldown.

        PnL / outcome — two-tier approach
        -----------------------------------
        This is copied faithfully from MomentumScalperBot, which resolved the
        oid-liveness race condition in this session: Hyperliquid auto-cancels the
        sibling reduce-only order faster than our poll interval, so oid liveness
        alone can misclassify TP hits as SL hits (or vice versa).

        Primary (authoritative): fetch fills via get_user_fills() filtered to
        this coin + time > entry order placement time.  Sum closedPnl across all
        matching fills.  Determine outcome from sign of sum:
            fills_pnl > 0 → TP_HIT
            fills_pnl < 0 → SL_HIT
            fills_pnl == 0 → fall through to oid heuristic (breakeven close)

        Fallback (low confidence): if fills unavailable or no matches, fall back
        to oid-liveness heuristic for outcome and mark-price for PnL estimate.
        Both are approximations — logged as warnings so they stand out in logs.
        """
        # Snapshot all position state BEFORE any mutations.
        # _reset_state() and _cancel_all_resting() will clear these fields; we
        # need them for PnL calculation and DB updates after that.
        snap_entry_price       = self._entry_price
        snap_position_size     = self._position_size
        snap_is_long           = self._is_long
        snap_current_coin      = self._current_coin
        snap_entry_time        = self._entry_time
        snap_position_group_id = self._position_group_id

        short_coin = (
            snap_current_coin.split(":")[-1]
            if snap_current_coin and ":" in snap_current_coin
            else snap_current_coin or ""
        )

        tp_alive = self._tp_oid is not None and self._tp_oid in live_oids
        sl_alive = self._sl_oid is not None and self._sl_oid in live_oids

        # oid-liveness heuristic (fallback when fills unavailable).
        # If SL is still resting → TP must have filled; if TP is still resting
        # → SL must have filled.  Both gone → auto-cancel race or manual close.
        if sl_alive and not tp_alive:
            oid_outcome  = "TP_HIT"
            oid_cooldown = self._cooldown_after_trade_s
        elif tp_alive and not sl_alive:
            oid_outcome  = "SL_HIT"
            oid_cooldown = self._cooldown_after_loss_s
        else:
            # Both absent (auto-cancel race, manual close, liquidation) or both
            # still present — treat conservatively as unknown.
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
            self._log(
                "warning",
                f"get_user_fills() failed — falling back to mark-price PnL estimate: {exc}",
            )

        # Keep only fills for this coin that arrived after the entry order was placed.
        # snap_entry_time is in ms (set just before place_order call).
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
            if fills_pnl > 0:
                outcome  = "TP_HIT"
                cooldown = self._cooldown_after_trade_s
            elif fills_pnl < 0:
                outcome  = "SL_HIT"
                cooldown = self._cooldown_after_loss_s
            else:
                # Exactly-zero closed PnL (breakeven close) — rare edge case.
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
            outcome    = oid_outcome
            cooldown   = oid_cooldown
            exit_price = snap_entry_price   # last resort if mids also fail
            if short_coin:
                try:
                    mids    = await hyperliquid_service.get_all_mids()
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
                f"size={snap_position_size:.4f} "
                f"direction={'long' if snap_is_long else 'short'} "
                f"→ pnl≈${pnl_usd:.2f} (excludes fees/funding) | "
                f"outcome={outcome} cooldown={cooldown}s",
            )

        # ── Update risk manager ────────────────────────────────────────────────
        await self._risk_manager.record_trade_result(pnl_usd)

        self._log(
            "info",
            f"Risk state after trade: equity={self._risk_manager.equity:.2f} "
            f"hwm={self._risk_manager.high_water_mark:.2f} "
            f"drawdown={self._risk_manager._drawdown_pct() * 100:.1f}% "
            f"consecutive_losses={self._risk_manager.consecutive_losses} "
            f"halted={self._risk_manager.trading_halted}",
        )

        # Cancel all resting orders BEFORE reset_state() clears the oids.
        await self._cancel_all_resting()

        # Close position_group in Supabase BEFORE reset_state() clears the id.
        if self._position_group_id and self._db:
            try:
                await close_position_group(self._db, self._position_group_id)
                self._log("info", f"position_group {self._position_group_id} closed in DB")
            except Exception as exc:
                self._log("error", f"close_position_group() failed: {exc}")

        # Update trade_signal row with outcome and PnL — fire-and-forget.
        # Uses snap_position_group_id (set before reset_state clears it).
        if snap_position_group_id and self._db:
            try:
                await update_trade_signal_outcome(
                    db                = self._db,
                    position_group_id = snap_position_group_id,
                    outcome           = outcome,
                    pnl_usd           = pnl_usd,
                )
            except Exception as sig_exc:
                self._log(
                    "warning",
                    f"update_trade_signal_outcome failed (non-fatal): {sig_exc}",
                )

        # Reset all position state and enter time-based cooldown.
        self._reset_state()
        self._state          = "cooldown"
        self._cooldown_until = time.monotonic() + cooldown
        self._log("info", f"Entering cooldown — expires in {cooldown}s")

    # ── Idle tick ─────────────────────────────────────────────────────────────

    async def _tick_idle(self) -> None:
        """Run the scanner; enter a position if a qualifying opportunity exists.

        Scanner visibility: scan_symbol() is called directly (not scan_all()) so
        all results — qualifying AND non-qualifying — are available for logging.
        This lets us log the top non-qualifying candidate every tick for
        visibility into why nothing triggered, even when all gates are failing.
        """
        # Trade-level cooldown timer (distinct from RiskManager's consecutive-loss
        # cooldown, which is equity-based and persisted to DB).
        if time.monotonic() < self._cooldown_until:
            remaining = self._cooldown_until - time.monotonic()
            self._log("info", f"Cooldown active — {remaining:.0f}s remaining")
            return

        # Transition cooldown → idle once the timer expires.
        if self._state == "cooldown":
            self._state = "idle"
            self._log("info", "Cooldown expired — returning to IDLE")

        # Keep risk-manager equity in sync with current allocated_usdc config.
        # No-op when already in sync; only persists on an actual rebaseline.
        await self._risk_manager.sync_allocation(self._allocated_usdc)

        # Risk-manager gate: hard stop on drawdown, daily loss, consecutive-loss
        # cooldown, and trading_halted flag.  Different from the trade-level
        # cooldown above — this is equity-protection, not just time-based.
        can_trade, rm_reason = await self._risk_manager.can_trade()
        if not can_trade:
            self._log("warning", f"Risk manager blocked entry: {rm_reason}")
            return

        # ── Run scanner for all symbols (including non-qualifying results) ──────
        # scan_symbol() is called directly rather than scan_all() so that we get
        # all results back — scan_all() filters to qualifying only, which would
        # prevent logging the best non-qualifying candidate on empty-result ticks.
        try:
            raw: list[FadeMarketScore | BaseException] = await asyncio.gather(
                *[scan_symbol(sym, self._scanner_config) for sym in self._symbols],
                return_exceptions=True,
            )
        except Exception as exc:
            self._log("error", f"asyncio.gather over scan_symbol raised: {exc}")
            return

        all_scores: list[FadeMarketScore] = []
        for sym, result in zip(self._symbols, raw):
            if isinstance(result, BaseException):
                self._log("error", f"scan_symbol({sym}) raised: {result}")
                continue
            all_scores.append(result)

        if not all_scores:
            self._log("info", "All symbol scans failed — no results to evaluate")
            return

        # Sort all results by ER descending (qualifying and non-qualifying alike).
        all_scores.sort(
            key=lambda r: r.efficiency_ratio if r.efficiency_ratio is not None else 0.0,
            reverse=True,
        )

        # Log the top candidate regardless of whether it qualifies.
        top    = all_scores[0]
        er_top = f"{top.efficiency_ratio:.3f}" if top.efficiency_ratio is not None else "n/a"
        self._log(
            "info",
            f"Scanner top candidate: {top.symbol} dir={top.direction} "
            f"ER={er_top} RSI7={top.rsi7:.1f} vol_ratio={top.volume_ratio:.2f} "
            f"spread={top.spread_pct:.4f}% qualifies={top.qualifies}",
        )

        # Verbose per-symbol breakdown.
        for sc in all_scores:
            er_s = f"{sc.efficiency_ratio:.3f}" if sc.efficiency_ratio is not None else "n/a"
            self._log(
                "info",
                f"  [{sc.symbol} {sc.direction} ER={er_s} RSI7={sc.rsi7:.1f} "
                f"qualifies={sc.qualifies}] " + " | ".join(sc.reasons),
            )

        qualifying = [r for r in all_scores if r.qualifies]

        if not qualifying:
            self._log(
                "info",
                f"No qualifying opportunity — {len(all_scores)} symbol(s) scanned, "
                f"0 qualifying (top: {top.symbol} ER={er_top} qualifies=False)",
            )
            return

        # best = highest ER among qualifying results (already sorted).
        best = qualifying[0]

        if best.symbol not in self._sz_decimals_map:
            self._log(
                "warning",
                f"{best.symbol} not in sz_decimals_map — cannot size order; skipping",
            )
            return

        er_best = f"{best.efficiency_ratio:.3f}" if best.efficiency_ratio is not None else "n/a"
        self._log(
            "info",
            f"Opportunity found: {best.symbol} {best.direction.upper()} "
            f"ER={er_best} RSI7={best.rsi7:.1f} — opening position",
        )
        await self._open_position(best)

    # ── Main run loop ─────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Bot main loop.  Runs indefinitely until cancelled.

        Startup sequence:
          1. load_or_init() — restore persisted risk state from DB so drawdown
             protection survives Railway restarts.
          2. set_leverage for all symbols (isolated margin).

        Tick cadence: every scan_interval_seconds regardless of state.
          IDLE / COOLDOWN: run scanner, enter if qualifying.
          IN_POSITION: poll for close, manage breakeven SL.

        Error handling:
          - asyncio.CancelledError propagates cleanly (clean shutdown).
          - Any other exception is caught, logged, and the loop sleeps 60 s
            before the next tick.  A transient network or exchange error must
            never kill the bot task.
        """
        # Restore persisted risk state (equity, drawdown, daily loss, cooldowns).
        # Must run before any trading decisions.
        await self._risk_manager.load_or_init()

        # Set leverage on startup (isolated margin) for all configured symbols.
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
                self._log(
                    "error",
                    f"set_leverage({symbol}) failed (proceeding anyway): {exc}",
                )

        self._log(
            "info",
            f"FadeScalperBot started | symbols={self._symbols} "
            f"allocated={self._allocated_usdc} USDC leverage={self._leverage}x | "
            f"tp={self._tp_atr_multiplier}×ATR sl={self._sl_atr_multiplier}×ATR "
            f"breakeven_trigger={self._breakeven_atr_trigger}×ATR | "
            f"scan_interval={self._scan_interval_s}s | "
            f"scanner: rsi_period={self._scanner_config.get('rsi_period')} "
            f"ema={self._scanner_config.get('ema_fast')}/{self._scanner_config.get('ema_slow')} "
            f"min_er={self._scanner_config.get('min_efficiency_ratio')} "
            f"min_vol_ratio={self._scanner_config.get('min_volume_ratio')} "
            f"max_spread={self._scanner_config.get('max_spread_pct')}%",
        )

        while True:
            try:
                if self._state == "in_position":
                    await self._tick_in_position()
                else:
                    # Handles both "idle" and "cooldown" states; _tick_idle()
                    # checks the monotonic clock internally and returns early
                    # if the cooldown timer has not yet expired.
                    await self._tick_idle()

                await asyncio.sleep(self._scan_interval_s)

            except asyncio.CancelledError:
                self._log("info", "Bot received CancelledError — stopping cleanly")
                raise

            except Exception as exc:
                # Log and stay alive.  Transient network or exchange errors
                # should never terminate the bot task.  A 60 s sleep gives the
                # market / API time to recover before the next tick.
                self._log("error", f"Unhandled tick error: {exc}")
                await asyncio.sleep(60.0)
