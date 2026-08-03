"""
Backtest engine — strategy simulation functions for historical OHLCV data.

Add one function per bot strategy as strategies are implemented.
Each function should accept a list of candle dicts (keys: open, high, low, close, time)
and return a standardised result dict with at minimum:
    pnl_pct, pnl_usd, final_equity, total_trades, win_rate,
    max_drawdown_pct, bnh_pct, equity_curve, candles_used
"""
from __future__ import annotations

from datetime import datetime, timezone


# ── MockExchange TP-aware subclass ────────────────────────────────────────────
# (mock_exchange.py was patched so check_fills uses tpsl field for TP direction)


# ─────────────────────────────────────────────────────────────────────────────
# RSI DCA Grid backtest
# ─────────────────────────────────────────────────────────────────────────────

class _BacktestRSIDCAGridBot:
    """
    Thin wrapper that lazily imports RSIDCAGridBot and overrides the six
    exchange-facing async methods to route through MockExchange instead of
    hyperliquid_service.  db_client=None means all position_group DB writes
    are silently skipped (guarded by ``if self._db:`` in the base class).

    Imports are deferred so the backtest module can be imported without the
    full bot dependency tree being resolved at module load time.
    """

    def __new__(cls, *, mock_exchange, **kwargs):
        from bots.rsi_dca_grid.strategy import RSIDCAGridBot
        from bots.shared_utils import round_price

        class _Bot(RSIDCAGridBot):
            # ── 1. _get_position ──────────────────────────────────────────────
            async def _get_position(self):
                return self._mock.position_szi, self._mock.position_entry_px

            # ── 2. _get_open_order_oids ───────────────────────────────────────
            async def _get_open_order_oids(self):
                return set(self._mock.resting_orders.keys())

            # ── 3. _cancel_safe ───────────────────────────────────────────────
            async def _cancel_safe(self, oid):
                if oid is None:
                    return
                self._mock.cancel(self._coin, oid)

            # ── 4. _place_entry ───────────────────────────────────────────────
            async def _place_entry(self, is_long: bool, mark_price: float) -> float:
                size = self._per_level_size(mark_price)
                size = self._ensure_min_notional(size, mark_price)
                # IOC: fills immediately at the mock's current_candle open price
                self._mock.order(
                    self._coin,
                    is_buy=is_long,
                    sz=size,
                    px=mark_price,
                    order_type={"limit": {"tif": "Ioc"}},
                )
                szi, entry_px = await self._get_position()
                if abs(szi) < 10 ** (-self._sz_decimals):
                    return 0.0
                self._position_size     = abs(szi)
                self._vwap_entry        = entry_px
                self._original_entry_px = entry_px
                self._sl_ref_price      = entry_px
                return self._position_size

            # ── 5. _place_dca_grid ────────────────────────────────────────────
            async def _place_dca_grid(self, is_long: bool, mark_price: float) -> None:
                from bots.rsi_dca_grid.strategy import _extract_oid
                size = self._per_level_size(mark_price)
                size = self._ensure_min_notional(size, mark_price)
                for i, pct in enumerate(self._dca_pcts):
                    if is_long:
                        dca_px   = round_price(self._original_entry_px * (1.0 - pct / 100.0))
                        is_buy_o = True
                    else:
                        dca_px   = round_price(self._original_entry_px * (1.0 + pct / 100.0))
                        is_buy_o = False
                    result = self._mock.order(
                        self._coin,
                        is_buy=is_buy_o,
                        sz=size,
                        px=dca_px,
                        order_type={"limit": {"tif": "Gtc"}},
                    )
                    self._dca_oids[i] = _extract_oid(result)

            # ── 6. _update_sl_tp ──────────────────────────────────────────────
            async def _update_sl_tp(self, is_long: bool) -> None:
                from bots.rsi_dca_grid.strategy import _extract_oid
                if self._position_size <= 0 or self._vwap_entry <= 0 or self._sl_ref_price <= 0:
                    return
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

                sl_result = self._mock.order(
                    self._coin,
                    is_buy=(not is_long),
                    sz=self._position_size,
                    px=sl_px,
                    order_type={"trigger": {"triggerPx": sl_px, "isMarket": True, "tpsl": "sl"}},
                    reduce_only=True,
                )
                tp_result = self._mock.order(
                    self._coin,
                    is_buy=(not is_long),
                    sz=self._position_size,
                    px=tp_px,
                    order_type={"trigger": {"triggerPx": tp_px, "isMarket": True, "tpsl": "tp"}},
                    reduce_only=True,
                )
                self._sl_oid = _extract_oid(sl_result)
                self._tp_oid = _extract_oid(tp_result)

            # ── 7. _in_time_window — use candle ts, not wall clock ─────────────
            def _in_time_window(self) -> bool:
                if not self._use_time_window:
                    return True
                candle = self._mock.current_candle
                if candle is None:
                    return True
                ts   = candle.get("time", 0)
                hour = datetime.fromtimestamp(ts, tz=timezone.utc).hour
                s, e = self._window_start, self._window_end
                if s == e:
                    return True
                if s < e:
                    return s <= hour < e
                return hour >= s or hour < e

        # Attach mock before __init__ so the bot can reference it in overrides
        instance = object.__new__(_Bot)
        instance._mock = mock_exchange
        _Bot.__init__(instance, **kwargs)
        return instance


# ─────────────────────────────────────────────────────────────────────────────
# Post-processing helpers
# ─────────────────────────────────────────────────────────────────────────────

def _trade_stats(fill_log: list[dict]) -> tuple[int, float, list[float]]:
    """
    Replay fill_log to extract per-trade realized PnL.

    Returns (total_trades, win_rate, trade_pnls).
    A "trade" is a complete round-trip: position opens from flat → closes to flat.
    DCA fills within the same position are part of the same trade.
    """
    pos_szi   = 0.0
    pos_entry = 0.0
    trade_pnls: list[float] = []

    for fill in fill_log:
        is_buy = fill["is_buy"]
        sz     = fill["sz"]
        px     = fill["fill_px"]
        ro     = fill["reduce_only"]

        if ro:
            # Closing fill — compute PnL on the portion being closed.
            if pos_szi > 0:
                actual = min(sz, pos_szi)
                pnl    = (px - pos_entry) * actual
            elif pos_szi < 0:
                actual = min(sz, abs(pos_szi))
                pnl    = (pos_entry - px) * actual
            else:
                actual = 0.0
                pnl    = 0.0
            signed_delta = actual if is_buy else -actual
            pos_szi     += signed_delta
            if abs(pos_szi) < 1e-10:
                pos_szi   = 0.0
                pos_entry = 0.0
                trade_pnls.append(pnl)
        else:
            # Opening / adding fill — update weighted average entry.
            signed_delta = sz if is_buy else -sz
            new_szi      = pos_szi + signed_delta
            if pos_szi == 0.0:
                pos_entry = px
            elif (pos_szi > 0 and signed_delta > 0) or (pos_szi < 0 and signed_delta < 0):
                pos_entry = (abs(pos_szi) * pos_entry + sz * px) / abs(new_szi)
            pos_szi = new_szi

    total  = len(trade_pnls)
    wins   = sum(1 for p in trade_pnls if p > 0)
    wr     = wins / total if total > 0 else 0.0
    return total, wr, trade_pnls


def _max_drawdown_pct(equity_curve: list[dict]) -> float:
    if not equity_curve:
        return 0.0
    peak   = equity_curve[0]["value"]
    max_dd = 0.0
    for pt in equity_curve:
        eq = pt["value"]
        if eq > peak:
            peak = eq
        if peak > 0:
            dd = (peak - eq) / peak * 100.0
            if dd > max_dd:
                max_dd = dd
    return max_dd


# ─────────────────────────────────────────────────────────────────────────────
# Main backtest function
# ─────────────────────────────────────────────────────────────────────────────

async def backtest_rsi_dca_grid(
    candles_entry:        list[dict],
    candles_context:      list[dict],
    allocated_usdc:       float,
    leverage:             int,
    sz_decimals:          int,
    sides:                list[str],
    ema_period:           int,
    use_adx_filter:       bool,
    adx_period:           int,
    adx_threshold:        float,
    rsi_period:           int,
    rsi_oversold:         float,
    rsi_overbought:       float,
    use_time_window:      bool,
    window_start_utc_hour: int,
    window_end_utc_hour:  int,
    use_volume_filter:    bool,
    volume_multiplier:    float,
    volume_lookback:      int,
    dca_pcts:             list[float],
    max_exposure_pct:     float,
    sl_pct:               float,
    tp_pct:               float,
    cooldown_candles:     int,
) -> dict:
    """
    Run a full historical simulation of RSIDCAGridBot against *candles_entry*
    (entry-timeframe OHLCV) and *candles_context* (context-timeframe OHLCV).

    Uses _BacktestRSIDCAGridBot (a subclass of RSIDCAGridBot) to route all
    exchange I/O through MockExchange — zero divergence from live strategy logic.

    Returns a standardised result dict:
        pnl_pct, pnl_usd, final_equity, total_trades, win_rate,
        max_drawdown_pct, bnh_pct, equity_curve, candles_used
    """
    from backtest.mock_exchange import MockExchange

    # ── Validation ────────────────────────────────────────────────────────────
    min_entry   = max(rsi_period + 3, volume_lookback + 3, 10)
    min_context = max(ema_period + 2, adx_period * 2 + 2, 5)

    if len(candles_entry) < min_entry:
        return {
            "error":        f"Insufficient entry candles: need ≥{min_entry}, got {len(candles_entry)}",
            "candles_used": len(candles_entry),
        }
    if len(candles_context) < min_context:
        return {
            "error":        f"Insufficient context candles: need ≥{min_context}, got {len(candles_context)}",
            "candles_used": len(candles_entry),
        }

    # ── Instantiate mock + bot ────────────────────────────────────────────────
    mock = MockExchange(sz_decimals=sz_decimals)
    mock.update_leverage(leverage, "BACKTEST", False)

    bot = _BacktestRSIDCAGridBot(
        mock_exchange          = mock,
        private_key            = "backtest",
        master_address         = "backtest",
        coin                   = "BACKTEST",
        sz_decimals            = sz_decimals,
        dex                    = "",
        allocated_usdc         = float(allocated_usdc),
        leverage               = int(leverage),
        sides                  = list(sides),
        ema_period             = int(ema_period),
        use_adx_filter         = bool(use_adx_filter),
        adx_period             = int(adx_period),
        adx_threshold          = float(adx_threshold),
        rsi_period             = int(rsi_period),
        rsi_oversold           = float(rsi_oversold),
        rsi_overbought         = float(rsi_overbought),
        use_time_window        = bool(use_time_window),
        window_start_utc_hour  = int(window_start_utc_hour),
        window_end_utc_hour    = int(window_end_utc_hour),
        use_volume_filter      = bool(use_volume_filter),
        volume_multiplier      = float(volume_multiplier),
        volume_lookback        = int(volume_lookback),
        dca_pcts               = [float(p) for p in dca_pcts],
        max_exposure_pct       = float(max_exposure_pct),
        sl_pct                 = float(sl_pct),
        tp_pct                 = float(tp_pct),
        cooldown_candles       = int(cooldown_candles),
        db_client              = None,   # skip all Supabase writes
        bot_id                 = None,
        log_callback           = None,
    )

    # ── Replay loop ───────────────────────────────────────────────────────────
    initial_equity = float(allocated_usdc)
    realized_pnl   = 0.0
    equity_curve:  list[dict] = []
    n_entry        = len(candles_entry)

    for i, candle in enumerate(candles_entry):
        # Snapshot before fills for incremental realized PnL computation
        pre_szi      = mock.position_szi
        pre_entry_px = mock.position_entry_px
        pre_n_fills  = len(mock.fill_log)

        # 1. Simulate fills from resting orders (SL / TP / DCA limits)
        mock.check_fills(candle)

        # 2. Accumulate realized PnL from any closing fills this candle
        szi_cursor = pre_szi
        for fill in mock.fill_log[pre_n_fills:]:
            if fill["reduce_only"]:
                if szi_cursor > 0:
                    realized_pnl += (fill["fill_px"] - pre_entry_px) * fill["sz"]
                elif szi_cursor < 0:
                    realized_pnl += (pre_entry_px - fill["fill_px"]) * fill["sz"]
            szi_cursor = fill["position_szi_after"]
            # entry_px changes with DCA fills; we re-read it from mock for next close
            pre_entry_px = mock.position_entry_px if abs(szi_cursor) > 1e-10 else 0.0

        # 3. Mark-to-market equity at this candle's close
        mark = candle["close"]
        if mock.position_szi > 0:
            unrealized = (mark - mock.position_entry_px) * mock.position_szi
        elif mock.position_szi < 0:
            unrealized = (mock.position_entry_px - mark) * abs(mock.position_szi)
        else:
            unrealized = 0.0
        equity = initial_equity + realized_pnl + unrealized
        equity_curve.append({"time": candle["time"], "value": equity})

        # 4. Set current_candle to close-price snapshot so IOC entries fill at
        #    signal-candle close (not the raw open, which would be look-ahead-free
        #    but stale relative to the signal price).
        mock.current_candle = {**candle, "open": candle["close"]}

        # 5. Slice context: only bars up to and including current candle's time
        ctx_time  = candle["time"]
        ctx_slice = [c for c in candles_context if c["time"] <= ctx_time]

        # 6. Entry slice: include one extra bar so _tick_idle's drop-last is correct
        entry_end   = min(i + 2, n_entry)
        entry_slice = candles_entry[:entry_end]

        # 7. Drive bot tick based on current state
        if bot._state == "in_position":
            await bot._tick_in_position()
        elif bot._state == "cooldown":
            await bot._tick_cooldown()
        else:
            await bot._tick_idle(ctx_slice, entry_slice)

    # ── Close any still-open position at last candle's close ──────────────────
    if mock.position_szi != 0 and candles_entry:
        last_close = candles_entry[-1]["close"]
        if mock.position_szi > 0:
            realized_pnl += (last_close - mock.position_entry_px) * mock.position_szi
        else:
            realized_pnl += (mock.position_entry_px - last_close) * abs(mock.position_szi)

    # ── Statistics ────────────────────────────────────────────────────────────
    final_equity = initial_equity + realized_pnl
    pnl_usd      = realized_pnl
    pnl_pct      = (pnl_usd / initial_equity * 100.0) if initial_equity > 0 else 0.0

    total_trades, win_rate, _trade_pnls = _trade_stats(mock.fill_log)

    max_dd_pct = _max_drawdown_pct(equity_curve)

    # Buy-and-hold over the same period
    if candles_entry:
        bnh_start = candles_entry[0]["close"]
        bnh_end   = candles_entry[-1]["close"]
        bnh_pct   = (bnh_end - bnh_start) / bnh_start * 100.0 if bnh_start > 0 else 0.0
    else:
        bnh_pct = 0.0

    return {
        "pnl_pct":          round(pnl_pct,            4),
        "pnl_usd":          round(pnl_usd,             4),
        "final_equity":     round(final_equity,        4),
        "total_trades":     total_trades,
        "win_rate":         round(win_rate * 100.0,    2),   # returned as 0–100
        "max_drawdown_pct": round(max_dd_pct,          4),
        "bnh_pct":          round(bnh_pct,             4),
        "equity_curve":     equity_curve,
        "candles_used":     len(candles_entry),
    }
