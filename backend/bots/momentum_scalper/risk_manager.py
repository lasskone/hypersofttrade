"""
backend/bots/momentum_scalper/risk_manager.py

Phase 3 — Risk Manager for the Momentum Pullback Scalper.

Responsibilities
----------------
1. Equity tracking: maintains a running equity balance updated after every
   closed trade.  Equity starts at ``allocated_usdc`` on first run and is
   persisted in ``bot_risk_state`` so it survives Railway restarts.

2. High-water mark (HWM): updated whenever equity exceeds the prior HWM.
   The HWM is the reference point for drawdown-tier calculations.

3. Drawdown-tier sizing: position size is scaled down as equity falls further
   below the HWM, and trading is halted entirely if the drawdown exceeds the
   maximum threshold.

4. Daily loss limit: tracks cumulative realised PnL losses within a UTC
   calendar day.  Resets automatically at midnight UTC.  Halts trading when
   the daily limit is breached.

5. Consecutive-loss cooldown: after N consecutive losing trades, enforces a
   timed pause before the next entry.

6. Persistence: all state is written to ``bot_risk_state`` in Supabase after
   every trade result.  DB writes are fire-and-forget (errors are logged as
   warnings but never propagated — a persistence failure must never crash the
   strategy; however it MUST be loud because it degrades capital protection).

Equity accounting model (see also migration 005_bot_risk_state.sql)
---------------------------------------------------------------------
    pnl_usd  ≈  (exit_price − entry_price) × size × direction_sign

Exit price is the mark price at the moment the strategy detects the position
is flat — NOT the exact exchange trigger-fill price.  This approximation
omits fees and funding and must NOT be used for accounting or tax purposes.
It is accurate enough for sizing (within a few basis points on a scalper) and
for drawdown-protection logic which can tolerate that level of noise.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Fraction of equity that may be posted as margin for a single order.
# Keeps 10 % in reserve for Hyperliquid's maintenance margin requirement
# and taker fees, preventing "Insufficient margin" rejections at full equity.
_MARGIN_SAFETY_BUFFER: float = 0.90


class RiskManager:
    """Per-bot risk manager with equity tracking, drawdown tiers, daily loss
    limits, and consecutive-loss cooldowns.

    All state is persisted to ``bot_risk_state`` in Supabase so it survives
    process restarts.  Call ``await load_or_init()`` once at startup before
    any trades are evaluated.
    """

    # Drawdown tiers (fraction of HWM drawdown → risk multiplier).
    # Ordered from most severe to least — evaluated top-down.
    _DRAWDOWN_TIERS: list[tuple[float, float]] = [
        (0.10, 0.00),   # > 10%  drawdown → trading halted (multiplier unused)
        (0.08, 0.25),   # 8–10%  drawdown → 25% of base risk
        (0.05, 0.50),   # 5–8%   drawdown → 50% of base risk
        (0.00, 1.00),   # < 5%   drawdown → 100% of base risk
    ]

    def __init__(
        self,
        *,
        bot_id: Optional[str],
        db_client,
        allocated_usdc: float,
        risk_per_trade: float = 0.02,
        max_daily_loss_pct: float = 0.10,
        max_consecutive_losses: int = 3,
        consecutive_loss_cooldown_minutes: int = 30,
        max_leverage: int = 5,
        min_profit_to_fee_ratio: float = 1.5,
        estimated_fee_pct: float = 0.07,
    ) -> None:
        self._bot_id    = bot_id
        self._db        = db_client
        self._allocated_usdc = float(allocated_usdc)

        # Risk parameters
        self._risk_per_trade               = float(risk_per_trade)
        self._max_daily_loss_pct           = float(max_daily_loss_pct)
        self._max_consecutive_losses       = int(max_consecutive_losses)
        self._consecutive_loss_cooldown_m  = int(consecutive_loss_cooldown_minutes)
        self._max_leverage                 = int(max_leverage)
        self._min_profit_to_fee_ratio      = float(min_profit_to_fee_ratio)
        self._estimated_fee_pct            = float(estimated_fee_pct)

        # In-memory state — loaded from DB by load_or_init(), or initialised
        # to defaults if this is the first run for this bot_id.
        self.equity:             float          = float(allocated_usdc)
        self.high_water_mark:    float          = float(allocated_usdc)
        self.daily_loss_usd:     float          = 0.0
        self.daily_loss_date:    date           = date.today()
        self.consecutive_losses: int            = 0
        self.trading_halted:     bool           = False
        self.halt_reason:        Optional[str]  = None
        self.cooldown_until:     Optional[datetime] = None   # tz-aware UTC

    # ── Startup ───────────────────────────────────────────────────────────────

    async def load_or_init(self) -> None:
        """Load existing risk state from DB, or insert a fresh row.

        Must be called once at bot startup before any trading decisions.
        Safe to call even if db_client or bot_id is None — in that case the
        in-memory defaults are kept (no persistence).
        """
        if self._db is None or self._bot_id is None:
            logger.warning(
                "[RiskManager] No db_client or bot_id — running without persistence. "
                "Drawdown state will be lost on restart."
            )
            return

        try:
            res = (
                self._db.table("bot_risk_state")
                .select("*")
                .eq("bot_id", self._bot_id)
                .execute()
            )
            rows = res.data or []

            if rows:
                row = rows[0]
                self.equity             = float(row["equity"])
                self.high_water_mark    = float(row["high_water_mark"])
                self.daily_loss_usd     = float(row["daily_loss_usd"])
                self.daily_loss_date    = date.fromisoformat(str(row["daily_loss_date"]))
                self.consecutive_losses = int(row["consecutive_losses"])
                self.trading_halted     = bool(row["trading_halted"])
                self.halt_reason        = row.get("halt_reason")
                raw_cu = row.get("cooldown_until")
                if raw_cu:
                    # Supabase returns ISO-8601 strings; parse to aware datetime.
                    self.cooldown_until = datetime.fromisoformat(
                        raw_cu.replace("Z", "+00:00")
                    )
                else:
                    self.cooldown_until = None

                logger.info(
                    "[RiskManager] Loaded existing state for bot_id=%s: "
                    "equity=%.2f hwm=%.2f daily_loss=%.2f consecutive_losses=%d "
                    "halted=%s",
                    self._bot_id, self.equity, self.high_water_mark,
                    self.daily_loss_usd, self.consecutive_losses,
                    self.trading_halted,
                )

                # Re-baseline check: if no trades have been recorded yet (equity
                # equals HWM, zero daily loss, zero consecutive losses) AND the
                # stored equity differs from the current allocated_usdc, the user
                # likely changed the allocation config before any live trades —
                # safe to adopt the new baseline.  Once real trades exist, do NOT
                # touch equity; the risk state reflects actual realised P&L.
                no_trades = (
                    self.equity == self.high_water_mark
                    and self.daily_loss_usd == 0.0
                    and self.consecutive_losses == 0
                )
                if no_trades and abs(self.equity - self._allocated_usdc) > 0.01:
                    logger.info(
                        "[RiskManager] No trades recorded yet — re-baselining equity "
                        "from %.2f to current allocated_usdc=%.2f (config was likely "
                        "changed since last run)",
                        self.equity, self._allocated_usdc,
                    )
                    self.equity          = self._allocated_usdc
                    self.high_water_mark = self._allocated_usdc
                    await self._persist()
                elif not no_trades and abs(self.equity - self._allocated_usdc) > 0.01:
                    logger.info(
                        "[RiskManager] Existing trade history found "
                        "(equity=%.2f consecutive_losses=%d) — allocated_usdc "
                        "change (%.2f) will not retroactively rebaseline equity. "
                        "To fully reset risk state, manually update bot_risk_state.",
                        self.equity, self.consecutive_losses, self._allocated_usdc,
                    )
            else:
                # First ever run for this bot — insert initial row.
                now = datetime.now(timezone.utc).isoformat()
                self._db.table("bot_risk_state").insert({
                    "bot_id":             self._bot_id,
                    "equity":             self._allocated_usdc,
                    "high_water_mark":    self._allocated_usdc,
                    "daily_loss_usd":     0.0,
                    "daily_loss_date":    date.today().isoformat(),
                    "consecutive_losses": 0,
                    "trading_halted":     False,
                    "halt_reason":        None,
                    "cooldown_until":     None,
                    "created_at":         now,
                    "updated_at":         now,
                }).execute()
                logger.info(
                    "[RiskManager] Inserted initial risk state for bot_id=%s: "
                    "equity=%.2f",
                    self._bot_id, self._allocated_usdc,
                )
        except Exception as exc:
            logger.warning(
                "[RiskManager] load_or_init() DB error — using in-memory defaults: %s",
                exc,
            )

    async def sync_allocation(self, allocated_usdc: float) -> None:
        """Re-sync in-memory equity to the current allocated_usdc config value.

        Safe to call on every scan tick — it is a no-op unless equity differs
        from allocated_usdc by more than $0.01.  Only rebaselines when no net
        P&L has been recorded yet (equity == high_water_mark), because that is
        the only state where the persisted equity is purely a config value
        rather than a record of real trading history.

        If real trades have occurred (equity ≠ high_water_mark), the mismatch
        is logged as info but equity is NOT touched — the user must manually
        update bot_risk_state to fully reset the risk history.
        """
        if abs(self.equity - allocated_usdc) <= 0.01:
            return  # already in sync — fast path

        if self.equity == self.high_water_mark:
            logger.info(
                "[RiskManager] sync_allocation: no net P&L recorded — "
                "re-baselining equity %.2f → %.2f (allocated_usdc changed)",
                self.equity, allocated_usdc,
            )
            self.equity          = allocated_usdc
            self.high_water_mark = allocated_usdc
            await self._persist()
        else:
            logger.info(
                "[RiskManager] sync_allocation: trade history present "
                "(equity=%.2f hwm=%.2f) — ignoring allocated_usdc change to %.2f; "
                "manually update bot_risk_state to fully reset risk history.",
                self.equity, self.high_water_mark, allocated_usdc,
            )

    # ── Trading gate ──────────────────────────────────────────────────────────

    async def can_trade(self) -> tuple[bool, str]:
        """Return (allowed, reason) indicating whether a new entry is permitted.

        Checks are applied in priority order:

        1. trading_halted flag (set by a previous breach — sticky until manually
           cleared in the DB, so human review is required to resume).
        2. Daily loss reset: if daily_loss_date != today (UTC), reset counter
           and persist.
        3. Daily loss limit: daily_loss_usd >= equity * max_daily_loss_pct →
           halt trading.
        4. Consecutive-loss cooldown: N+ losses with an unexpired cooldown_until
           → block entry.
        5. Consecutive-loss cooldown expiry: cooldown_until has passed → reset
           counter and resume.
        6. Drawdown > 10% safety check (redundant guard in case trading_halted
           was not set correctly by a prior record_trade_result call).
        7. All clear → (True, "ok").
        """
        # 1. Hard halt (requires manual DB intervention to clear).
        if self.trading_halted:
            return False, f"trading_halted: {self.halt_reason or 'unknown reason'}"

        # 2. Daily loss date rollover.
        today_utc = datetime.now(timezone.utc).date()
        if self.daily_loss_date != today_utc:
            logger.info(
                "[RiskManager] New UTC day — resetting daily_loss_usd "
                "(was %.2f on %s)", self.daily_loss_usd, self.daily_loss_date
            )
            self.daily_loss_usd  = 0.0
            self.daily_loss_date = today_utc
            await self._persist()

        # 3. Daily loss limit.
        daily_limit = self.equity * self._max_daily_loss_pct
        if self.daily_loss_usd >= daily_limit:
            self.trading_halted = True
            self.halt_reason    = (
                f"daily_loss_limit: lost ${self.daily_loss_usd:.2f} "
                f"(limit ${daily_limit:.2f})"
            )
            await self._persist()
            return False, self.halt_reason

        # 4. Consecutive-loss cooldown still active.
        if (
            self.consecutive_losses >= self._max_consecutive_losses
            and self.cooldown_until is not None
            and datetime.now(timezone.utc) < self.cooldown_until
        ):
            return (
                False,
                f"consecutive_loss_cooldown ({self.consecutive_losses} losses), "
                f"resumes at {self.cooldown_until.isoformat()}",
            )

        # 5. Consecutive-loss cooldown expired — reset and continue.
        if (
            self.consecutive_losses >= self._max_consecutive_losses
            and self.cooldown_until is not None
            and datetime.now(timezone.utc) >= self.cooldown_until
        ):
            logger.info(
                "[RiskManager] Consecutive-loss cooldown expired — resetting "
                "consecutive_losses from %d to 0", self.consecutive_losses
            )
            self.consecutive_losses = 0
            self.cooldown_until     = None
            await self._persist()

        # 6. Drawdown > 10% redundant safety guard.
        drawdown_pct = self._drawdown_pct()
        if drawdown_pct > 0.10:
            # Should have been caught by record_trade_result, but guard here too.
            self.trading_halted = True
            self.halt_reason    = (
                f"max_drawdown_exceeded: {drawdown_pct*100:.1f}% drawdown "
                f"(equity={self.equity:.2f} hwm={self.high_water_mark:.2f})"
            )
            await self._persist()
            return False, self.halt_reason

        return True, "ok"

    # ── Sizing ────────────────────────────────────────────────────────────────

    def compute_position_size(
        self,
        entry_price: float,
        stop_distance: float,
        leverage: int,
        *,
        tp_atr_multiplier: Optional[float] = None,
        atr_value: Optional[float] = None,
    ) -> float:
        """Return the raw base-asset size for this trade (caller applies
        round_size and min-notional bumping).

        Sizing is equity-based and scales with the current drawdown tier:

            drawdown_pct         = max(0, (HWM − equity) / HWM)
            effective_risk_pct   = risk_per_trade × risk_multiplier(drawdown_pct)
            risk_capital         = equity × effective_risk_pct
            raw_size             = (risk_capital / stop_distance) × effective_leverage

        where effective_leverage = min(requested_leverage, max_leverage).

        Safety cap: if the required margin (raw_size × entry_price / leverage)
        exceeds ``equity × _MARGIN_SAFETY_BUFFER``, raw_size is clamped so that
        margin stays within the buffer.

        Profitability filter (when tp_atr_multiplier and atr_value are supplied):
        Checks that the expected gross TP profit per unit exceeds
        min_profit_to_fee_ratio × estimated round-trip fee per unit.  Because
        both profit and fees scale linearly with size, this ratio is
        size-independent — no position size can rescue a setup that fails here.
        Returns 0.0 and logs the reason when the check fails so the caller can
        skip the trade cleanly.

        Returns 0.0 if stop_distance ≤ 0 or entry_price ≤ 0 (degenerate inputs
        — caller should treat 0.0 as "do not enter").
        """
        if stop_distance <= 0 or entry_price <= 0:
            logger.warning(
                "[RiskManager] compute_position_size called with invalid inputs: "
                "entry_price=%.4f stop_distance=%.4f — returning 0",
                entry_price, stop_distance,
            )
            return 0.0

        eff_leverage = min(leverage, self._max_leverage)
        drawdown_pct = self._drawdown_pct()
        multiplier   = self._risk_multiplier_for_drawdown(drawdown_pct)

        effective_risk_pct = self._risk_per_trade * multiplier
        risk_capital       = self.equity * effective_risk_pct
        raw_size           = (risk_capital / stop_distance) * eff_leverage

        # Safety cap: never use more than _MARGIN_SAFETY_BUFFER of equity as
        # margin.  The 10 % reserve covers maintenance margin and taker fees.
        max_margin      = self.equity * _MARGIN_SAFETY_BUFFER
        margin_required = (raw_size * entry_price) / eff_leverage
        if margin_required > max_margin:
            raw_size = (max_margin * eff_leverage) / entry_price
            logger.warning(
                "[RiskManager] Size capped by margin safety buffer (%.0f%% of equity): "
                "original_margin=%.2f > max_margin=%.2f (equity=%.2f) — capped raw_size=%.6f",
                _MARGIN_SAFETY_BUFFER * 100, margin_required, max_margin, self.equity, raw_size,
            )

        # Profitability filter: expected TP gross profit per unit vs estimated
        # round-trip fee per unit.  Both scale linearly with size so this ratio
        # is CONSTANT regardless of position size — bumping size cannot rescue a
        # setup that fails here.  Return 0.0 to skip the trade cleanly.
        if tp_atr_multiplier is not None and atr_value is not None:
            tp_profit_per_unit = tp_atr_multiplier * atr_value
            fee_per_unit       = entry_price * (self._estimated_fee_pct / 100.0)
            min_profit_needed  = self._min_profit_to_fee_ratio * fee_per_unit
            if tp_profit_per_unit < min_profit_needed:
                logger.info(
                    "[RiskManager] Trade skipped — TP profit/unit (%.5f) < %.1f× "
                    "estimated fee/unit (%.5f=%.5f×%.4f): "
                    "tp_mult=%.2f atr=%.4f entry=%.4f fee_pct=%.4f%% "
                    "— no size can fix this; wait for higher-volatility setup or "
                    "wider TP multiplier.",
                    tp_profit_per_unit, self._min_profit_to_fee_ratio,
                    min_profit_needed, self._min_profit_to_fee_ratio, fee_per_unit,
                    tp_atr_multiplier, atr_value, entry_price, self._estimated_fee_pct,
                )
                return 0.0

        logger.info(
            "[RiskManager] Sizing: equity=%.2f drawdown=%.1f%% "
            "multiplier=%.2f risk_capital=%.2f stop=%.4f raw_size=%.6f",
            self.equity, drawdown_pct * 100, multiplier,
            risk_capital, stop_distance, raw_size,
        )
        return raw_size

    # ── Trade result recording ────────────────────────────────────────────────

    async def record_trade_result(self, pnl_usd: float) -> None:
        """Update risk state after a closed trade and persist to DB.

        Parameters
        ----------
        pnl_usd:
            Approximate realised PnL in USD (positive = profit, negative = loss).
            Computed by the strategy as:
                (exit_price − entry_price) × size × direction_sign
            This omits fees and funding — it is an approximation for risk-sizing
            purposes only, NOT for accounting.

        State transitions
        -----------------
        - equity += pnl_usd
        - If new equity > HWM: HWM = equity
        - If loss: daily_loss_usd += |pnl_usd|; consecutive_losses += 1
        - If win: consecutive_losses = 0 (a single win resets the streak)
        - If consecutive_losses >= limit and no cooldown set yet: set cooldown_until
        - If daily loss limit breached: set trading_halted + halt_reason
        - If drawdown > 10%: set trading_halted + halt_reason
        - Persist all fields.

        DB write errors are logged as warnings and never re-raised — a
        persistence failure must NOT crash the strategy loop, but it IS
        loud in logs because it degrades capital protection on the next restart.
        """
        self.equity += pnl_usd

        # High-water mark update.
        if self.equity > self.high_water_mark:
            self.high_water_mark = self.equity

        # Win / loss bookkeeping.
        if pnl_usd < 0:
            self.daily_loss_usd     += abs(pnl_usd)
            self.consecutive_losses += 1
        else:
            self.consecutive_losses = 0   # a win resets the consecutive-loss streak

        # Consecutive-loss cooldown: set if we just crossed the threshold and
        # no cooldown is already active.
        if (
            self.consecutive_losses >= self._max_consecutive_losses
            and self.cooldown_until is None
        ):
            self.cooldown_until = datetime.now(timezone.utc).replace(
                second=0, microsecond=0
            ) + timedelta(minutes=self._consecutive_loss_cooldown_m)
            logger.warning(
                "[RiskManager] %d consecutive losses — cooldown until %s",
                self.consecutive_losses, self.cooldown_until.isoformat(),
            )

        # Daily loss halt check.
        daily_limit = self.equity * self._max_daily_loss_pct
        if not self.trading_halted and self.daily_loss_usd >= daily_limit:
            self.trading_halted = True
            self.halt_reason    = (
                f"daily_loss_limit: lost ${self.daily_loss_usd:.2f} "
                f"(limit ${daily_limit:.2f})"
            )
            logger.warning("[RiskManager] HALT — %s", self.halt_reason)

        # Drawdown halt check.
        drawdown_pct = self._drawdown_pct()
        if not self.trading_halted and drawdown_pct > 0.10:
            self.trading_halted = True
            self.halt_reason    = (
                f"max_drawdown_exceeded: {drawdown_pct*100:.1f}% drawdown "
                f"(equity={self.equity:.2f} hwm={self.high_water_mark:.2f})"
            )
            logger.warning("[RiskManager] HALT — %s", self.halt_reason)

        logger.info(
            "[RiskManager] Trade result: pnl=%.2f | equity=%.2f hwm=%.2f "
            "daily_loss=%.2f consecutive=%d halted=%s",
            pnl_usd, self.equity, self.high_water_mark,
            self.daily_loss_usd, self.consecutive_losses,
            self.trading_halted,
        )

        await self._persist()

    # ── Private helpers ───────────────────────────────────────────────────────

    def _drawdown_pct(self) -> float:
        """Return current drawdown as a fraction of the high-water mark.

        Returns 0.0 if HWM is zero (should never happen in practice).
        """
        if self.high_water_mark <= 0:
            return 0.0
        return max(0.0, (self.high_water_mark - self.equity) / self.high_water_mark)

    def _risk_multiplier_for_drawdown(self, drawdown_pct: float) -> float:
        """Return the risk multiplier for the given drawdown fraction.

        Tiers (applied top-down, first match wins):
            > 10%  drawdown → 0.00  (trading halted — this path is a safety
                                      backstop; normally caught by can_trade())
            8–10%  drawdown → 0.25
            5–8%   drawdown → 0.50
            < 5%   drawdown → 1.00
        """
        for threshold, multiplier in self._DRAWDOWN_TIERS:
            if drawdown_pct > threshold:
                return multiplier
        return 1.00   # fallback (drawdown_pct == 0 exactly)

    async def _persist(self) -> None:
        """Write all in-memory state to bot_risk_state in Supabase.

        Fire-and-forget: errors are logged as WARNING and never re-raised.
        A persistence failure is non-fatal to the strategy loop but degrades
        capital protection on the next restart — log loudly so it is noticed.
        """
        if self._db is None or self._bot_id is None:
            return   # No DB configured — silent skip (already warned in load_or_init).

        try:
            now = datetime.now(timezone.utc).isoformat()
            self._db.table("bot_risk_state").upsert(
                {
                    "bot_id":             self._bot_id,
                    "equity":             round(self.equity, 8),
                    "high_water_mark":    round(self.high_water_mark, 8),
                    "daily_loss_usd":     round(self.daily_loss_usd, 8),
                    "daily_loss_date":    self.daily_loss_date.isoformat(),
                    "consecutive_losses": self.consecutive_losses,
                    "trading_halted":     self.trading_halted,
                    "halt_reason":        self.halt_reason,
                    "cooldown_until":     (
                        self.cooldown_until.isoformat()
                        if self.cooldown_until is not None else None
                    ),
                    "updated_at":         now,
                },
                on_conflict="bot_id",
            ).execute()
        except Exception as exc:
            logger.warning(
                "[RiskManager] PERSISTENCE FAILURE — risk state NOT saved to DB. "
                "Drawdown protection will reset on next restart. Error: %s",
                exc,
            )
