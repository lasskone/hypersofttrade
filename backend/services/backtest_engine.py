"""
Backtest engine — simulates the Trend Magic strategy on historical OHLCV data.
"""
from __future__ import annotations


# ---------------------------------------------------------------------------
# Trend Magic backtest — RSI(14) + EMA(200) trend-following with Fibonacci DCA
# ---------------------------------------------------------------------------

def run_trend_magic_backtest(
    candles_1m: list[dict],
    allocation: float,
    rsi_period: int   = 14,
    rsi_overbought: float = 70.0,
    rsi_oversold:   float = 30.0,
    ema_period: int   = 200,
    dca_level_1_pct: float = 7.0,
    dca_level_2_pct: float = 14.0,
    tp_pct:          float = 5.0,
    trailing_stop_pct: float = 1.0,
    leverage: int     = 1,
    sides: list[str] | None = None,
) -> dict:
    if sides is None:
        sides = ["long", "short"]

    _FIB = [0.15, 0.35, 0.50]

    # ── Pre-compute RSI (Wilder's smoothed) ──────────────────────────────────
    closes = [c["close"] for c in candles_1m]
    n      = len(closes)
    rsi_arr: list = [None] * n

    if n > rsi_period:
        gains  = [max(closes[i] - closes[i - 1], 0) for i in range(1, n)]
        losses = [max(closes[i - 1] - closes[i], 0) for i in range(1, n)]
        avg_gain = sum(gains[:rsi_period]) / rsi_period
        avg_loss = sum(losses[:rsi_period]) / rsi_period
        for i in range(rsi_period, n - 1):
            g = gains[i]
            l = losses[i]
            avg_gain = (avg_gain * (rsi_period - 1) + g) / rsi_period
            avg_loss = (avg_loss * (rsi_period - 1) + l) / rsi_period
            if avg_loss == 0:
                rsi_arr[i + 1] = 100.0
            else:
                rsi_arr[i + 1] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)

    # ── Pre-compute EMA ───────────────────────────────────────────────────────
    ema_arr: list = [None] * n
    if n >= ema_period:
        k = 2.0 / (ema_period + 1)
        seed = sum(closes[:ema_period]) / ema_period
        ema_arr[ema_period - 1] = seed
        for i in range(ema_period, n):
            ema_arr[i] = closes[i] * k + ema_arr[i - 1] * (1.0 - k)

    # ── State ─────────────────────────────────────────────────────────────────
    cash         = allocation
    equity_curve: list[dict] = []
    trades:       list[dict] = []
    max_equity   = allocation
    max_drawdown = 0.0

    in_long:  bool | None  = None
    positions: list[dict]  = []
    tp_px:    float | None = None
    sl_px:    float | None = None
    peak_px:  float | None = None
    dca_targets: list[float] = []

    entered_this_candle = False

    def _avg_entry() -> float:
        total_sz = sum(p["size"] for p in positions)
        if total_sz == 0:
            return 0.0
        return sum(p["entry_px"] * p["size"] for p in positions) / total_sz

    def _total_size() -> float:
        return sum(p["size"] for p in positions)

    def _total_margin() -> float:
        return sum(p["margin"] for p in positions)

    def _close_pos(close_px: float, ts: int, ctype: str) -> None:
        nonlocal cash, in_long, positions, tp_px, sl_px, peak_px, dca_targets
        sz    = _total_size()
        entry = _avg_entry()
        mg    = _total_margin()
        pnl   = (close_px - entry) * sz if in_long else (entry - close_px) * sz
        cash += mg + pnl
        trades.append({"type": ctype, "px": close_px, "ts": ts, "pnl": round(pnl, 4)})
        positions   = []
        in_long     = None
        tp_px       = None
        sl_px       = None
        peak_px     = None
        dca_targets = []

    def _open_pos(entry_px: float, fib_idx: int, ts: int, is_long: bool) -> None:
        nonlocal cash, in_long, peak_px, tp_px, sl_px, dca_targets
        margin  = allocation * _FIB[fib_idx] * leverage
        size    = (margin * leverage) / entry_px
        cash   -= margin
        positions.append({"entry_px": entry_px, "size": size, "margin": margin, "fib_idx": fib_idx})
        in_long = is_long
        peak_px = entry_px
        avg     = _avg_entry()
        if is_long:
            tp_px       = avg * (1 + tp_pct / 100)
            sl_px       = avg * (1 - trailing_stop_pct / 100)
            dca_targets = [
                avg * (1 - dca_level_1_pct / 100),
                avg * (1 - dca_level_2_pct / 100),
            ]
        else:
            tp_px       = avg * (1 - tp_pct / 100)
            sl_px       = avg * (1 + trailing_stop_pct / 100)
            dca_targets = [
                avg * (1 + dca_level_1_pct / 100),
                avg * (1 + dca_level_2_pct / 100),
            ]
        trades.append({"type": "long_open" if is_long else "short_open", "px": entry_px, "ts": ts})

    for i, candle in enumerate(candles_1m):
        ts    = candle.get("time", i)
        open_ = candle["open"]
        high  = candle["high"]
        low   = candle["low"]
        close = candle["close"]

        # ── Fill checks ───────────────────────────────────────────────────────
        if not entered_this_candle and in_long is not None:
            # Update trailing stop
            if in_long:
                if peak_px is None or close > peak_px:
                    peak_px = close
                trail = peak_px * (1 - trailing_stop_pct / 100)
                if trail > (sl_px or 0):
                    sl_px = trail
            else:
                if peak_px is None or close < peak_px:
                    peak_px = close
                trail = peak_px * (1 + trailing_stop_pct / 100)
                if trail < (sl_px or float("inf")):
                    sl_px = trail

            n_filled = len(positions)

            if in_long:
                if sl_px is not None and low <= sl_px:
                    _close_pos(sl_px, ts, "long_close")
                elif n_filled < 3 and dca_targets and low <= dca_targets[0]:
                    dca_px = dca_targets.pop(0)
                    _open_pos(dca_px, n_filled, ts, True)
                    avg2  = _avg_entry()
                    tp_px = avg2 * (1 + tp_pct / 100)
                    sl_px = avg2 * (1 - trailing_stop_pct / 100)
                elif tp_px is not None and high >= tp_px:
                    _close_pos(tp_px, ts, "long_close")
            else:
                if sl_px is not None and high >= sl_px:
                    _close_pos(sl_px, ts, "short_close")
                elif n_filled < 3 and dca_targets and high >= dca_targets[0]:
                    dca_px = dca_targets.pop(0)
                    _open_pos(dca_px, n_filled, ts, False)
                    avg2  = _avg_entry()
                    tp_px = avg2 * (1 - tp_pct / 100)
                    sl_px = avg2 * (1 + trailing_stop_pct / 100)
                elif tp_px is not None and low <= tp_px:
                    _close_pos(tp_px, ts, "short_close")

        entered_this_candle = False

        # ── Entry signal (signal on candle[i-1], enter at candle[i].open) ─────
        if in_long is None and i >= 1:
            prev_rsi = rsi_arr[i - 1]
            prev_ema = ema_arr[i - 1]
            if prev_rsi is not None and prev_ema is not None:
                prev_close = closes[i - 1]
                if "long" in sides and prev_rsi > rsi_overbought and prev_close > prev_ema:
                    _open_pos(open_, 0, ts, True)
                    entered_this_candle = True
                elif "short" in sides and prev_rsi < rsi_oversold and prev_close < prev_ema:
                    _open_pos(open_, 0, ts, False)
                    entered_this_candle = True

        # ── Equity snapshot ───────────────────────────────────────────────────
        pos_value = 0.0
        for pos in positions:
            if in_long:
                pos_value += pos["margin"] + (close - pos["entry_px"]) * pos["size"]
            else:
                pos_value += pos["margin"] + (pos["entry_px"] - close) * pos["size"]
        equity = cash + pos_value

        if equity > max_equity:
            max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown:
            max_drawdown = dd

        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity  = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct_tm    = (final_equity - allocation) / allocation * 100
    fp_tm         = candles_1m[0]["close"]
    lp_tm         = candles_1m[-1]["close"]
    bnh_pct_tm    = (lp_tm - fp_tm) / fp_tm * 100
    ct_tm         = [t for t in trades if t["type"] in ("long_close", "short_close")]
    win_tm        = [t for t in ct_tm if t.get("pnl", 0) > 0]
    wr_tm         = len(win_tm) / len(ct_tm) * 100 if ct_tm else 0

    return {
        "pnl_pct":          round(pnl_pct_tm, 2),
        "pnl_usd":          round(final_equity - allocation, 2),
        "final_equity":     round(final_equity, 2),
        "total_trades":     len(trades),
        "win_rate":         round(wr_tm, 1),
        "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct":          round(bnh_pct_tm, 2),
        "equity_curve":     equity_curve,
        "candles_used":     len(candles_1m),
    }
