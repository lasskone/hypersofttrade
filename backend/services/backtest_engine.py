"""
Backtest engine — simulates Grid Bot and Envelope DCA strategies on historical OHLCV data.
"""
from __future__ import annotations
import math
from typing import Optional


def run_grid_backtest(
    candles: list[dict],
    allocation: float,
    levels: int,
    range_pct: float,
    stop_loss_pct: float,
    take_profit_pct: float,
) -> dict:
    """
    Simulate a grid bot on OHLCV candles.
    Returns stats + equity curve.
    """
    if len(candles) < 10:
        raise ValueError("Not enough candles for backtest")

    # Build initial grid around first candle close
    initial_price = candles[0]["close"]
    half_range = range_pct / 100 / 2
    price_min = initial_price * (1 - half_range)
    price_max = initial_price * (1 + half_range)

    # Geometric grid levels
    ratio = (price_max / price_min) ** (1 / (levels - 1))
    grid_prices = [price_min * (ratio ** i) for i in range(levels)]

    per_level_usdc = allocation / levels
    fee_rate = 0.00035  # 0.035% maker fee

    # State
    cash = allocation
    positions: dict[float, float] = {}  # price → size in asset
    trades = []
    equity_curve = []
    max_equity = allocation
    max_drawdown = 0.0
    total_pnl = 0.0
    center_price = initial_price

    def rebuild_grid(current_price: float):
        nonlocal grid_prices, center_price, price_min, price_max
        center_price = current_price
        p_min = current_price * (1 - half_range)
        p_max = current_price * (1 + half_range)
        r = (p_max / p_min) ** (1 / (levels - 1))
        grid_prices = [p_min * (r ** i) for i in range(levels)]

    for i, candle in enumerate(candles):
        low = candle["low"]
        high = candle["high"]
        close = candle["close"]
        ts = candle["time"]

        # Rebalance if price moves outside range
        if close < price_min * 0.95 or close > price_max * 1.05:
            # Close all positions at close price
            for px, sz in list(positions.items()):
                pnl = (close - px) * sz
                fee = close * sz * fee_rate
                total_pnl += pnl - fee
                cash += close * sz - fee
                trades.append({"type": "rebalance_close", "price": close, "pnl": pnl})
            positions.clear()
            rebuild_grid(close)
            cash_per_level = cash / levels

        # Check buy orders (price crossed below grid level)
        for gp in grid_prices:
            if gp not in positions and low <= gp <= high:
                size = per_level_usdc / gp
                fee = gp * size * fee_rate
                if cash >= gp * size + fee:
                    cash -= gp * size + fee
                    positions[gp] = size
                    trades.append({"type": "buy", "price": gp, "size": size})

        # Check sell orders (price crossed above grid level)
        for gp in sorted(positions.keys()):
            sell_price = gp * ratio  # sell at next level up
            if sell_price <= high:
                size = positions[gp]
                pnl = (sell_price - gp) * size
                fee = sell_price * size * fee_rate
                total_pnl += pnl - fee
                cash += sell_price * size - fee
                del positions[gp]
                trades.append({"type": "sell", "price": sell_price, "pnl": pnl - fee})

        # Equity = cash + mark value of open positions
        pos_value = sum(close * sz for sz in positions.values())
        equity = cash + pos_value

        # Stop loss check
        if stop_loss_pct > 0 and equity < allocation * (1 - stop_loss_pct / 100):
            for px, sz in list(positions.items()):
                pnl = (close - px) * sz
                fee = close * sz * fee_rate
                total_pnl += pnl - fee
                cash += close * sz - fee
                trades.append({"type": "stop_loss", "price": close, "pnl": pnl - fee})
            positions.clear()
            equity = cash
            equity_curve.append({"time": ts, "value": round(equity, 2)})
            break

        # Take profit check
        if take_profit_pct > 0 and equity >= allocation * (1 + take_profit_pct / 100):
            for px, sz in list(positions.items()):
                pnl = (close - px) * sz
                fee = close * sz * fee_rate
                total_pnl += pnl - fee
                cash += close * sz - fee
                trades.append({"type": "take_profit", "price": close, "pnl": pnl - fee})
            positions.clear()
            equity = cash
            equity_curve.append({"time": ts, "value": round(equity, 2)})
            break

        if equity > max_equity:
            max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown:
            max_drawdown = dd

        equity_curve.append({"time": ts, "value": round(equity, 2)})

    # Final equity
    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100

    # Buy & hold comparison
    first_price = candles[0]["close"]
    last_price = candles[-1]["close"]
    bnh_pct = (last_price - first_price) / first_price * 100

    # Win rate
    sell_trades = [t for t in trades if t["type"] in ("sell", "take_profit")]
    winning = [t for t in sell_trades if t.get("pnl", 0) > 0]
    win_rate = len(winning) / len(sell_trades) * 100 if sell_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2),
        "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2),
        "total_trades": len(trades),
        "win_rate": round(win_rate, 1),
        "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2),
        "equity_curve": equity_curve,
        "candles_used": len(candles),
    }


def run_envelope_dca_backtest(
    candles_1m: list[dict],
    allocation: float,
    ma_period: int,
    envelope_1_pct: float,
    envelope_2_pct: float,
    envelope_3_pct: float,
    stop_loss_pct: float,
    leverage: int = 1,
    sides: list | None = None,
) -> dict:
    """
    Simulate Envelope DCA bot on 1-minute OHLCV candles.

    Reproduces EXACT live EnvelopeBot cancel/replace cycle per candle:

      1. CHECK FILLS on triggers placed on the PREVIOUS candle:
           - Long  trigger: LOW  <= trigger_px → fill at limit_px
           - Short trigger: HIGH >= trigger_px → fill at limit_px
           - Long  SL (pending): LOW  <= pending_long_sl  → close at SL price  (checked first)
           - Long  TP (pending): HIGH >= pending_long_tp  → close at TP price
           - Short SL (pending): HIGH >= pending_short_sl → close at SL price  (checked first)
           - Short TP (pending): LOW  <= pending_short_tp → close at TP price
      2. COUNT remaining pending triggers → canceled_orders_buy / canceled_orders_sell.
         CANCEL all pending (clear trigger dicts + pending TP/SL).
      3. PLACE NEW triggers for this candle (checked on the NEXT candle):
           - In long  position: place remaining long  levels + set pending TP/SL
           - In short position: place remaining short levels + set pending TP/SL
           - Flat on a side:    place ALL levels for that side

    KEY RULE: an order placed on candle N can ONLY fill on candle N+1.
              It cannot fill on the same candle it was placed, and it is
              cancelled before candle N+2 — exactly like the real bot.

    - MA computed at candle close (includes current close): closes[i-period+1:i+1]
    - size = (per_level * leverage) / limit_px  (identical to live bot)
    - fee_rate = 0.00035 (maker fee, trigger/limit orders)
    - Margin per level = per_level (locked from cash on entry, returned on close)
    """
    if sides is None:
        sides = ["long"]

    if len(candles_1m) < ma_period + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate  = 0.00035
    closes    = [c["close"] for c in candles_1m]

    # Convert percentages to decimals — matches live bot (env=0.07, not 7.0)
    envelopes = [e / 100.0 for e in [envelope_1_pct, envelope_2_pct, envelope_3_pct] if e > 0]
    n_levels  = len(envelopes)
    per_level = allocation / n_levels if n_levels > 0 else allocation

    cash             = allocation
    long_positions:  list[dict] = []   # [{"level": j, "entry_px": float, "size": float}, ...]
    short_positions: list[dict] = []

    # Pending trigger orders placed on the PREVIOUS candle — checked on THIS candle.
    # {level_idx: (limit_px, trigger_px)}
    open_long_triggers:  dict[int, tuple[float, float]] = {}
    open_short_triggers: dict[int, tuple[float, float]] = {}
    # Pending TP/SL prices placed on the previous candle — checked on THIS candle.
    pending_long_tp:  float | None = None  # MA from previous candle
    pending_long_sl:  float | None = None
    pending_short_tp: float | None = None  # MA from previous candle
    pending_short_sl: float | None = None

    trades:       list[dict] = []
    equity_curve: list[dict] = []
    max_equity   = allocation
    max_drawdown = 0.0

    for i in range(ma_period, len(candles_1m)):
        # MA at this candle's close — used for PLACING new orders in step 3
        ma_curr = sum(closes[i - ma_period + 1:i + 1]) / ma_period
        low     = candles_1m[i]["low"]
        high    = candles_1m[i]["high"]
        close   = candles_1m[i]["close"]
        ts      = candles_1m[i]["time"]

        # ── STEP 1: CHECK FILLS (orders placed on the PREVIOUS candle) ────────

        # Long entry triggers: LOW <= trigger_px → fill at limit_px
        filled_long = []
        for j, (limit_px, trigger_px) in list(open_long_triggers.items()):
            if low <= trigger_px and cash >= per_level:
                size = (per_level * leverage) / limit_px
                fee  = limit_px * size * fee_rate
                cash -= per_level + fee
                long_positions.append({"level": j, "entry_px": limit_px, "size": size})
                trades.append({"type": "long_entry", "price": limit_px})
                filled_long.append(j)
        for j in filled_long:
            del open_long_triggers[j]

        # Short entry triggers: HIGH >= trigger_px → fill at limit_px
        filled_short = []
        for j, (limit_px, trigger_px) in list(open_short_triggers.items()):
            if high >= trigger_px and cash >= per_level:
                size = (per_level * leverage) / limit_px
                fee  = limit_px * size * fee_rate
                cash -= per_level + fee
                short_positions.append({"level": j, "entry_px": limit_px, "size": size})
                trades.append({"type": "short_entry", "price": limit_px})
                filled_short.append(j)
        for j in filled_short:
            del open_short_triggers[j]

        has_long  = len(long_positions) > 0
        has_short = len(short_positions) > 0

        # Long SL / TP (pending from previous candle) — SL checked first (worst-case)
        if has_long:
            if pending_long_sl is not None and low <= pending_long_sl:
                sl_px = pending_long_sl
                for pos in long_positions:
                    pnl = (sl_px - pos["entry_px"]) * pos["size"]
                    fee = sl_px * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "long_sl", "price": sl_px, "pnl": pnl - fee})
                long_positions.clear()
                has_long = False
            if has_long and pending_long_tp is not None and high >= pending_long_tp:
                tp_px = pending_long_tp
                for pos in long_positions:
                    pnl = (tp_px - pos["entry_px"]) * pos["size"]
                    fee = tp_px * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "long_close", "price": tp_px, "pnl": pnl - fee})
                long_positions.clear()
                has_long = False

        # Short SL / TP (pending from previous candle) — SL checked first (worst-case)
        if has_short:
            if pending_short_sl is not None and high >= pending_short_sl:
                sl_px = pending_short_sl
                for pos in short_positions:
                    pnl = (pos["entry_px"] - sl_px) * pos["size"]
                    fee = sl_px * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "short_sl", "price": sl_px, "pnl": pnl - fee})
                short_positions.clear()
                has_short = False
            if has_short and pending_short_tp is not None and low <= pending_short_tp:
                tp_px = pending_short_tp
                for pos in short_positions:
                    pnl = (pos["entry_px"] - tp_px) * pos["size"]
                    fee = tp_px * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "short_close", "price": tp_px, "pnl": pnl - fee})
                short_positions.clear()
                has_short = False

        # ── STEP 2: COUNT remaining pending, then CANCEL all ─────────────────
        canceled_orders_buy  = len(open_long_triggers)
        canceled_orders_sell = len(open_short_triggers)
        open_long_triggers.clear()
        open_short_triggers.clear()
        pending_long_tp  = None
        pending_long_sl  = None
        pending_short_tp = None
        pending_short_sl = None

        # Refresh after all fills
        has_long  = len(long_positions) > 0
        has_short = len(short_positions) > 0

        # ── STEP 3: PLACE NEW triggers (checked on the NEXT candle) ──────────

        # In long position: place remaining levels + set TP/SL for next candle
        if has_long:
            total_sz       = sum(p["size"] for p in long_positions)
            avg_entry_long = sum(p["entry_px"] * p["size"] for p in long_positions) / total_sz
            long_start        = max(0, n_levels - canceled_orders_buy)
            existing_long_lvl = {p["level"] for p in long_positions}
            for j in range(long_start, n_levels):
                if j not in existing_long_lvl:
                    env        = envelopes[j]
                    limit_px   = ma_curr * (1.0 - env)
                    trigger_px = limit_px * 1.005
                    open_long_triggers[j] = (limit_px, trigger_px)
            pending_long_tp = ma_curr
            if stop_loss_pct > 0:
                pending_long_sl = avg_entry_long * (1.0 - stop_loss_pct / 100.0)

        # In short position: place remaining levels + set TP/SL for next candle
        if has_short:
            total_sz        = sum(p["size"] for p in short_positions)
            avg_entry_short = sum(p["entry_px"] * p["size"] for p in short_positions) / total_sz
            short_start        = max(0, n_levels - canceled_orders_sell)
            existing_short_lvl = {p["level"] for p in short_positions}
            for j in range(short_start, n_levels):
                if j not in existing_short_lvl:
                    env      = envelopes[j]
                    high_env = round(1.0 / (1.0 - env) - 1.0, 3)
                    limit_px   = ma_curr * (1.0 + high_env)
                    trigger_px = limit_px * 0.995
                    open_short_triggers[j] = (limit_px, trigger_px)
            pending_short_tp = ma_curr
            if stop_loss_pct > 0:
                pending_short_sl = avg_entry_short * (1.0 + stop_loss_pct / 100.0)

        # Flat on a side: place ALL levels for that side
        if not has_long and "long" in sides:
            for j in range(n_levels):
                env        = envelopes[j]
                limit_px   = ma_curr * (1.0 - env)
                trigger_px = limit_px * 1.005
                open_long_triggers[j] = (limit_px, trigger_px)

        if not has_short and "short" in sides:
            for j in range(n_levels):
                env      = envelopes[j]
                high_env = round(1.0 / (1.0 - env) - 1.0, 3)
                limit_px   = ma_curr * (1.0 + high_env)
                trigger_px = limit_px * 0.995
                open_short_triggers[j] = (limit_px, trigger_px)

        # ── Equity: cash + margin_in_use + unrealized PnL ────────────────────
        pos_value = 0.0
        for pos in long_positions:
            pos_value += per_level + (close - pos["entry_px"]) * pos["size"]
        for pos in short_positions:
            pos_value += per_level + (pos["entry_px"] - close) * pos["size"]
        equity = cash + pos_value

        if equity > max_equity:
            max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown:
            max_drawdown = dd

        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct      = (final_equity - allocation) / allocation * 100

    first_price = candles_1m[0]["close"]
    last_price  = candles_1m[-1]["close"]
    bnh_pct     = (last_price - first_price) / first_price * 100

    close_trades = [t for t in trades if t["type"] in ("long_close", "short_close")]
    winning      = [t for t in close_trades if t.get("pnl", 0) > 0]
    win_rate     = len(winning) / len(close_trades) * 100 if close_trades else 0

    return {
        "pnl_pct":          round(pnl_pct, 2),
        "pnl_usd":          round(final_equity - allocation, 2),
        "final_equity":     round(final_equity, 2),
        "total_trades":     len(trades),
        "win_rate":         round(win_rate, 1),
        "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct":          round(bnh_pct, 2),
        "equity_curve":     equity_curve,
        "candles_used":     len(candles_1m),
    }


def run_bbrsi_backtest(
    candles_1m: list[dict],
    allocation: float,
    bb_period: int,
    bb_std: float,
    rsi_period: int,
    rsi_oversold: float,
    rsi_overbought: float,
    stop_loss_pct: float,
    leverage: int,
) -> dict:
    """Simulate BB+RSI Mean Reversion strategy on 1-minute OHLCV candles.
    OHLC ordering: long SL checked on candle LOW, short SL checked on candle HIGH.
    SL fills at the SL price (not close) for accuracy.
    """
    import math

    if len(candles_1m) < max(bb_period, rsi_period) + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes = [c["close"] for c in candles_1m]

    # SMA + STD for Bollinger Bands
    def sma(i, p):
        if i < p - 1: return None
        return sum(closes[i - p + 1:i + 1]) / p

    def std(i, p):
        if i < p - 1: return None
        window = closes[i - p + 1:i + 1]
        mean = sum(window) / p
        return math.sqrt(sum((x - mean) ** 2 for x in window) / p)

    # RSI — indexed directly by close index so rsi_values[i] = RSI using closes[0..i]
    rsi_values = [None] * len(closes)
    gains, losses = [], []
    for i in range(1, rsi_period + 1):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains) / rsi_period
    avg_loss = sum(losses) / rsi_period
    rsi_values[rsi_period] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(rsi_period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (rsi_period - 1) + max(diff, 0)) / rsi_period
        avg_loss = (avg_loss * (rsi_period - 1) + max(-diff, 0)) / rsi_period
        rsi_values[i] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    cash = allocation
    position = None
    trades = []
    equity_curve = []
    max_equity = allocation
    max_drawdown = 0.0

    for i in range(max(bb_period, rsi_period) + 1, len(candles_1m)):
        mid = sma(i - 1, bb_period)
        s   = std(i - 1, bb_period)
        rsi = rsi_values[i - 1] if i - 1 < len(rsi_values) else None
        close      = closes[i]
        prev_close = closes[i - 1]
        low        = candles_1m[i]["low"]
        high       = candles_1m[i]["high"]
        ts         = candles_1m[i]["time"]

        if mid is None or s is None or rsi is None:
            equity_curve.append({"time": ts, "value": round(cash, 2)})
            continue

        upper_bb = mid + bb_std * s
        lower_bb = mid - bb_std * s

        # Stop loss — OHLC-accurate: long SL checked on LOW, short SL on HIGH
        if position and stop_loss_pct > 0:
            entry = position["entry_price"]
            if position["side"] == "long":
                sl_px = entry * (1.0 - stop_loss_pct / 100.0)
                if low <= sl_px:
                    pnl = (sl_px - entry) * position["size"]
                    fee = sl_px * position["size"] * fee_rate
                    cash = allocation + pnl - fee
                    trades.append({"type": "stop_loss", "pnl": pnl - fee})
                    position = None
            else:  # short
                sl_px = entry * (1.0 + stop_loss_pct / 100.0)
                if high >= sl_px:
                    pnl = (entry - sl_px) * position["size"]
                    fee = sl_px * position["size"] * fee_rate
                    cash = allocation + pnl - fee
                    trades.append({"type": "stop_loss", "pnl": pnl - fee})
                    position = None

        if position is None:
            # margin = allocation (full capital), size in asset units
            size   = (allocation * leverage) / close
            margin = allocation
            fee    = close * size * fee_rate
            if prev_close <= lower_bb or rsi < rsi_oversold:
                if cash >= margin * 0.99:
                    cash -= fee
                    position = {"side": "long", "size": size, "entry_price": close}
                    trades.append({"type": "buy", "price": close})
            elif prev_close >= upper_bb or rsi > rsi_overbought:
                if cash >= margin * 0.99:
                    cash -= fee
                    position = {"side": "short", "size": size, "entry_price": close}
                    trades.append({"type": "sell_short", "price": close})
        else:
            entry = position["entry_price"]
            if position["side"] == "long" and prev_close >= mid:
                pnl = (close - entry) * position["size"]
                fee = close * position["size"] * fee_rate
                cash = allocation + pnl - fee
                trades.append({"type": "close_long", "pnl": pnl - fee})
                position = None
            elif position["side"] == "short" and prev_close <= mid:
                pnl = (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash = allocation + pnl - fee
                trades.append({"type": "close_short", "pnl": pnl - fee})
                position = None

        pos_value = 0.0
        if position:
            entry = position["entry_price"]
            if position["side"] == "long":
                pos_value = (close - entry) * position["size"]
            else:
                pos_value = (entry - close) * position["size"]

        equity = cash + pos_value
        if equity > max_equity: max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown: max_drawdown = dd
        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100
    bnh_pct = (candles_1m[-1]["close"] - candles_1m[0]["close"]) / candles_1m[0]["close"] * 100
    sell_trades = [t for t in trades if t["type"] in ("close_long", "close_short")]
    win_rate = len([t for t in sell_trades if t.get("pnl", 0) > 0]) / len(sell_trades) * 100 if sell_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2), "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2), "total_trades": len(trades),
        "win_rate": round(win_rate, 1), "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2), "equity_curve": equity_curve, "candles_used": len(candles_1m),
    }


def run_emacross_backtest(
    candles_1m: list[dict],
    allocation: float,
    ema_fast: int,
    ema_slow: int,
    stop_loss_pct: float,
    leverage: int,
) -> dict:
    """Simulate EMA Cross Trend Following strategy on 1-minute OHLCV candles.
    OHLC ordering: long SL checked on candle LOW, short SL checked on candle HIGH.
    SL fills at the SL price (not close) for accuracy.
    """
    if len(candles_1m) < ema_slow + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes = [c["close"] for c in candles_1m]

    def compute_ema(period):
        k = 2 / (period + 1)
        result = [None] * (period - 1)
        ema = sum(closes[:period]) / period
        result.append(ema)
        for i in range(period, len(closes)):
            ema = closes[i] * k + ema * (1 - k)
            result.append(ema)
        return result

    ema_fast_vals = compute_ema(ema_fast)
    ema_slow_vals = compute_ema(ema_slow)

    cash = allocation
    position = None
    trades = []
    equity_curve = []
    max_equity = allocation
    max_drawdown = 0.0

    for i in range(ema_slow + 2, len(candles_1m)):
        fast_prev = ema_fast_vals[i - 2]
        fast_curr = ema_fast_vals[i - 1]
        slow_prev = ema_slow_vals[i - 2]
        slow_curr = ema_slow_vals[i - 1]
        close = closes[i]
        low   = candles_1m[i]["low"]
        high  = candles_1m[i]["high"]
        ts    = candles_1m[i]["time"]

        if any(v is None for v in [fast_prev, fast_curr, slow_prev, slow_curr]):
            equity_curve.append({"time": ts, "value": round(cash, 2)})
            continue

        golden_cross = fast_prev <= slow_prev and fast_curr > slow_curr
        death_cross  = fast_prev >= slow_prev and fast_curr < slow_curr

        # Stop loss — OHLC-accurate: long SL checked on LOW, short SL on HIGH
        if position and stop_loss_pct > 0:
            entry = position["entry_price"]
            if position["side"] == "long":
                sl_px = entry * (1.0 - stop_loss_pct / 100.0)
                if low <= sl_px:
                    pnl = (sl_px - entry) * position["size"]
                    fee = sl_px * position["size"] * fee_rate
                    cash = allocation + pnl - fee
                    trades.append({"type": "stop_loss", "pnl": pnl - fee})
                    position = None
            else:  # short
                sl_px = entry * (1.0 + stop_loss_pct / 100.0)
                if high >= sl_px:
                    pnl = (entry - sl_px) * position["size"]
                    fee = sl_px * position["size"] * fee_rate
                    cash = allocation + pnl - fee
                    trades.append({"type": "stop_loss", "pnl": pnl - fee})
                    position = None

        if position is None:
            size = (allocation * leverage) / close
            fee  = close * size * fee_rate
            if golden_cross and cash >= allocation * 0.99:
                cash -= fee
                position = {"side": "long", "size": size, "entry_price": close}
                trades.append({"type": "buy", "price": close})
            elif death_cross and cash >= allocation * 0.99:
                cash -= fee
                position = {"side": "short", "size": size, "entry_price": close}
                trades.append({"type": "sell_short", "price": close})
        else:
            entry = position["entry_price"]
            if position["side"] == "long" and death_cross:
                pnl = (close - entry) * position["size"]
                fee = close * position["size"] * fee_rate
                cash = allocation + pnl - fee
                trades.append({"type": "close_long", "pnl": pnl - fee})
                position = None
            elif position["side"] == "short" and golden_cross:
                pnl = (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash = allocation + pnl - fee
                trades.append({"type": "close_short", "pnl": pnl - fee})
                position = None

        pos_value = 0.0
        if position:
            entry     = position["entry_price"]
            pos_value = (close - entry) * position["size"] if position["side"] == "long" else (entry - close) * position["size"]

        equity = cash + pos_value
        if equity > max_equity: max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown: max_drawdown = dd
        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100
    bnh_pct = (candles_1m[-1]["close"] - candles_1m[0]["close"]) / candles_1m[0]["close"] * 100
    sell_trades = [t for t in trades if t["type"] in ("close_long", "close_short")]
    win_rate = len([t for t in sell_trades if t.get("pnl", 0) > 0]) / len(sell_trades) * 100 if sell_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2), "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2), "total_trades": len(trades),
        "win_rate": round(win_rate, 1), "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2), "equity_curve": equity_curve, "candles_used": len(candles_1m),
    }


def run_passivbot_dca_backtest(
    candles: list[dict],
    allocation: float,
    direction: str,
    wallet_exposure_limit: float,
    entry_initial_qty_pct: float,
    double_down_factor: float,
    entry_grid_spacing_pct: float,
    entry_grid_spacing_we_weight: float,
    close_grid_markup_start: float,
    close_grid_markup_end: float,
    close_grid_qty_pct: float,
    leverage: int = 1,
) -> dict:
    """
    Simulate Passivbot-style DCA Grid strategy on OHLCV candles.
    Accumulates a position via DCA grid entries and exits via TP grid.
    Supports long and short directions.
    """
    if len(candles) < 10:
        raise ValueError("Not enough candles for backtest")

    MIN_NOTIONAL = 10.0
    fee_rate = 0.00035
    is_long = direction != "short"

    cash = allocation
    pos_size = 0.0   # size in asset (coins)
    avg_entry = 0.0  # average entry price

    # Number of TP levels: e.g. 0.05 -> 20 levels
    n_tp = max(1, round(1.0 / close_grid_qty_pct))

    trades: list[dict] = []
    equity_curve: list[dict] = []
    max_equity = allocation
    max_drawdown = 0.0

    for candle in candles:
        close = candle["close"]
        low = candle["low"]
        high = candle["high"]
        ts = candle["time"]

        wallet_exposure = (pos_size * avg_entry) / (allocation * leverage) if pos_size > 0 else 0.0

        # ENTRY LOGIC
        if wallet_exposure < wallet_exposure_limit:
            spacing_adj = entry_grid_spacing_pct * (
                1 + (wallet_exposure / max(wallet_exposure_limit, 1e-9)) * entry_grid_spacing_we_weight
            )

            if pos_size == 0:
                if is_long:
                    entry_price = close * (1 - entry_grid_spacing_pct)
                    if low <= entry_price:
                        qty = (entry_initial_qty_pct * allocation * leverage) / entry_price
                        notional = qty * entry_price
                        margin = notional / leverage
                        if notional >= MIN_NOTIONAL and cash >= margin * 0.999:
                            cash -= margin
                            avg_entry = entry_price
                            pos_size = qty
                            trades.append({"type": "entry", "price": entry_price})
                else:
                    entry_price = close * (1 + entry_grid_spacing_pct)
                    if high >= entry_price:
                        qty = (entry_initial_qty_pct * allocation * leverage) / entry_price
                        notional = qty * entry_price
                        margin = notional / leverage
                        if notional >= MIN_NOTIONAL and cash >= margin * 0.999:
                            cash -= margin
                            avg_entry = entry_price
                            pos_size = qty
                            trades.append({"type": "entry", "price": entry_price})
            else:
                if is_long:
                    dca_price = avg_entry * (1 - spacing_adj)
                    if low <= dca_price:
                        dca_qty = pos_size * double_down_factor
                        notional = dca_qty * dca_price
                        margin = notional / leverage
                        if notional >= MIN_NOTIONAL and cash >= margin * 0.999:
                            new_pos = pos_size + dca_qty
                            avg_entry = (pos_size * avg_entry + dca_qty * dca_price) / new_pos
                            cash -= margin
                            pos_size = new_pos
                            trades.append({"type": "dca", "price": dca_price})
                else:
                    dca_price = avg_entry * (1 + spacing_adj)
                    if high >= dca_price:
                        dca_qty = pos_size * double_down_factor
                        notional = dca_qty * dca_price
                        margin = notional / leverage
                        if notional >= MIN_NOTIONAL and cash >= margin * 0.999:
                            new_pos = pos_size + dca_qty
                            avg_entry = (pos_size * avg_entry + dca_qty * dca_price) / new_pos
                            cash -= margin
                            pos_size = new_pos
                            trades.append({"type": "dca", "price": dca_price})

        # TP GRID EXIT
        if pos_size > 1e-12:
            for j in range(n_tp):
                if pos_size < 1e-10:
                    break
                frac = j / max(n_tp - 1, 1)
                tp_pct = close_grid_markup_start + (close_grid_markup_end - close_grid_markup_start) * frac

                if is_long:
                    tp_price = avg_entry * (1 + tp_pct)
                    if high >= tp_price:
                        tp_qty = min(pos_size * close_grid_qty_pct, pos_size)
                        if tp_qty * tp_price < MIN_NOTIONAL / 10:
                            tp_qty = pos_size
                        fee = tp_price * tp_qty * fee_rate
                        pnl = (tp_price - avg_entry) * tp_qty
                        margin_returned = tp_qty * avg_entry / leverage
                        cash += margin_returned + pnl - fee
                        pos_size -= tp_qty
                        trades.append({"type": "tp", "price": tp_price, "pnl": pnl - fee})
                else:
                    tp_price = avg_entry * (1 - tp_pct)
                    if low <= tp_price:
                        tp_qty = min(pos_size * close_grid_qty_pct, pos_size)
                        if tp_qty * tp_price < MIN_NOTIONAL / 10:
                            tp_qty = pos_size
                        fee = tp_price * tp_qty * fee_rate
                        pnl = (avg_entry - tp_price) * tp_qty
                        margin_returned = tp_qty * avg_entry / leverage
                        cash += margin_returned + pnl - fee
                        pos_size -= tp_qty
                        trades.append({"type": "tp", "price": tp_price, "pnl": pnl - fee})

            if pos_size < 1e-10:
                pos_size = 0.0
                avg_entry = 0.0

        # EQUITY
        if pos_size > 0 and avg_entry > 0:
            margin_in_use = pos_size * avg_entry / leverage
            unrealized = (close - avg_entry) * pos_size if is_long else (avg_entry - close) * pos_size
            equity = cash + margin_in_use + unrealized
        else:
            equity = cash

        if equity > max_equity:
            max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown:
            max_drawdown = dd

        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100
    bnh_pct = (candles[-1]["close"] - candles[0]["close"]) / candles[0]["close"] * 100
    tp_trades = [t for t in trades if t["type"] == "tp"]
    win_rate = len([t for t in tp_trades if t.get("pnl", 0) > 0]) / len(tp_trades) * 100 if tp_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2),
        "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2),
        "total_trades": len(trades),
        "win_rate": round(win_rate, 1),
        "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2),
        "equity_curve": equity_curve,
        "candles_used": len(candles),
    }


# ── Fibonacci weights (local copy — avoids importing from bots package) ──────
_GT_FIB_PRESETS: dict[int, list[float]] = {
    2: [0.35, 0.65],
    3: [0.15, 0.35, 0.50],
    4: [0.10, 0.20, 0.30, 0.40],
}


def _gt_fib_weights(n: int) -> list[float]:
    if n in _GT_FIB_PRESETS:
        return _GT_FIB_PRESETS[n]
    w = [1.5 ** i for i in range(n)]
    t = sum(w)
    return [x / t for x in w]


def run_golden_trap_backtest(
    candles_1m: list[dict],
    allocation: float,
    ma_period: int,
    envelope_1_pct: float,
    envelope_2_pct: float,
    envelope_3_pct: float,
    stop_loss_pct: float,
    leverage: int = 1,
    sides: list | None = None,
    trailing_stop_type: str = "fixed",
    trailing_stop_pct: float = 2.0,
    trailing_stop_atr_mult: float = 1.5,
) -> dict:
    """
    Simulate Golden Trap bot on 1-minute OHLCV candles.

    Four improvements over run_envelope_dca_backtest:
      1. Fibonacci position sizing: per_levels[j] = allocation * fib_weight[j]
      2. MA200 trend filter: only places entries in the trend direction each candle
      3. Immediate re-entry: if TP fires in step 1, new flat entries are also checked
         against the SAME candle's OHLC (simulates the live 3-second re-entry check)
      4. Trailing stop: fixed-% or ATR-based, with original fixed SL as hard floor

    Same cancel/replace cycle as run_envelope_dca_backtest:
      - Order placed on candle N can ONLY fill on candle N+1
      - MA used for placement includes current close: closes[i-period+1:i+1]
    """
    if sides is None:
        sides = ["long"]

    if len(candles_1m) < ma_period + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes   = [c["close"] for c in candles_1m]

    envelopes  = [e / 100.0 for e in [envelope_1_pct, envelope_2_pct, envelope_3_pct] if e > 0]
    n_levels   = len(envelopes)
    weights    = _gt_fib_weights(n_levels)
    per_levels = [allocation * w for w in weights]  # Fibonacci per-level margin

    cash             = allocation
    long_positions:  list[dict] = []   # [{"level": j, "entry_px": float, "size": float, "margin": float}]
    short_positions: list[dict] = []

    open_long_triggers:  dict[int, tuple[float, float]] = {}
    open_short_triggers: dict[int, tuple[float, float]] = {}
    pending_long_tp:  float | None = None
    pending_long_sl:  float | None = None
    pending_short_tp: float | None = None
    pending_short_sl: float | None = None

    # Trailing stop state
    peak_long_price:   float | None = None
    original_long_sl:  float | None = None
    peak_short_price:  float | None = None
    original_short_sl: float | None = None

    trades:       list[dict] = []
    equity_curve: list[dict] = []
    max_equity   = allocation
    max_drawdown = 0.0

    def _atr14(i: int) -> float:
        start  = max(0, i - 13)
        recent = candles_1m[start:i + 1]
        return sum(c["high"] - c["low"] for c in recent) / len(recent) if recent else 0.0

    def _tsl_long(peak: float, orig: float | None, i: int) -> float | None:
        if trailing_stop_type == "none":
            return orig
        sl = (peak - _atr14(i) * trailing_stop_atr_mult
              if trailing_stop_type == "atr"
              else peak * (1.0 - trailing_stop_pct / 100.0))
        return max(sl, orig) if orig is not None else sl

    def _tsl_short(peak: float, orig: float | None, i: int) -> float | None:
        if trailing_stop_type == "none":
            return orig
        sl = (peak + _atr14(i) * trailing_stop_atr_mult
              if trailing_stop_type == "atr"
              else peak * (1.0 + trailing_stop_pct / 100.0))
        return min(sl, orig) if orig is not None else sl

    for i in range(ma_period, len(candles_1m)):
        ma_curr = sum(closes[i - ma_period + 1:i + 1]) / ma_period
        low     = candles_1m[i]["low"]
        high    = candles_1m[i]["high"]
        close   = candles_1m[i]["close"]
        ts      = candles_1m[i]["time"]

        long_tp_fired  = False
        short_tp_fired = False

        # ── STEP 1: CHECK FILLS (orders placed on the PREVIOUS candle) ────────

        filled_long = []
        for j, (limit_px, trigger_px) in list(open_long_triggers.items()):
            margin = per_levels[j]
            if low <= trigger_px and cash >= margin:
                size = (margin * leverage) / limit_px
                fee  = limit_px * size * fee_rate
                cash -= margin + fee
                long_positions.append({"level": j, "entry_px": limit_px, "size": size, "margin": margin})
                trades.append({"type": "long_entry", "price": limit_px})
                filled_long.append(j)
        for j in filled_long:
            del open_long_triggers[j]

        filled_short = []
        for j, (limit_px, trigger_px) in list(open_short_triggers.items()):
            margin = per_levels[j]
            if high >= trigger_px and cash >= margin:
                size = (margin * leverage) / limit_px
                fee  = limit_px * size * fee_rate
                cash -= margin + fee
                short_positions.append({"level": j, "entry_px": limit_px, "size": size, "margin": margin})
                trades.append({"type": "short_entry", "price": limit_px})
                filled_short.append(j)
        for j in filled_short:
            del open_short_triggers[j]

        has_long  = len(long_positions) > 0
        has_short = len(short_positions) > 0

        if has_long:
            if pending_long_sl is not None and low <= pending_long_sl:
                sl_px = pending_long_sl
                for pos in long_positions:
                    pnl = (sl_px - pos["entry_px"]) * pos["size"]
                    fee = sl_px * pos["size"] * fee_rate
                    cash += pos["margin"] + pnl - fee
                    trades.append({"type": "long_sl", "price": sl_px, "pnl": pnl - fee})
                long_positions.clear()
                has_long = False
                peak_long_price  = None
                original_long_sl = None
            if has_long and pending_long_tp is not None and high >= pending_long_tp:
                tp_px = pending_long_tp
                for pos in long_positions:
                    pnl = (tp_px - pos["entry_px"]) * pos["size"]
                    fee = tp_px * pos["size"] * fee_rate
                    cash += pos["margin"] + pnl - fee
                    trades.append({"type": "long_close", "price": tp_px, "pnl": pnl - fee})
                long_positions.clear()
                has_long = False
                peak_long_price  = None
                original_long_sl = None
                long_tp_fired    = True

        if has_short:
            if pending_short_sl is not None and high >= pending_short_sl:
                sl_px = pending_short_sl
                for pos in short_positions:
                    pnl = (pos["entry_px"] - sl_px) * pos["size"]
                    fee = sl_px * pos["size"] * fee_rate
                    cash += pos["margin"] + pnl - fee
                    trades.append({"type": "short_sl", "price": sl_px, "pnl": pnl - fee})
                short_positions.clear()
                has_short = False
                peak_short_price  = None
                original_short_sl = None
            if has_short and pending_short_tp is not None and low <= pending_short_tp:
                tp_px = pending_short_tp
                for pos in short_positions:
                    pnl = (pos["entry_px"] - tp_px) * pos["size"]
                    fee = tp_px * pos["size"] * fee_rate
                    cash += pos["margin"] + pnl - fee
                    trades.append({"type": "short_close", "price": tp_px, "pnl": pnl - fee})
                short_positions.clear()
                has_short = False
                peak_short_price  = None
                original_short_sl = None
                short_tp_fired    = True

        # ── STEP 2: COUNT remaining pending, then CANCEL all ─────────────────
        canceled_orders_buy  = len(open_long_triggers)
        canceled_orders_sell = len(open_short_triggers)
        open_long_triggers.clear()
        open_short_triggers.clear()
        pending_long_tp  = None
        pending_long_sl  = None
        pending_short_tp = None
        pending_short_sl = None

        has_long  = len(long_positions) > 0
        has_short = len(short_positions) > 0

        # ── STEP 3: MA200 trend filter → active_sides ────────────────────────
        active_sides = list(sides)
        if i >= 200:
            ma200 = sum(closes[i - 199:i + 1]) / 200
            if close > ma200:
                active_sides = [s for s in sides if s == "long"]
            elif close < ma200:
                active_sides = [s for s in sides if s == "short"]

        # ── STEP 4: PLACE NEW triggers ────────────────────────────────────────

        if has_long:
            total_sz       = sum(p["size"] for p in long_positions)
            avg_entry_long = sum(p["entry_px"] * p["size"] for p in long_positions) / total_sz
            if peak_long_price is None:
                peak_long_price  = close
                if stop_loss_pct > 0:
                    original_long_sl = avg_entry_long * (1.0 - stop_loss_pct / 100.0)
            else:
                peak_long_price = max(peak_long_price, close)
            pending_long_sl = _tsl_long(peak_long_price, original_long_sl, i)

            long_start        = max(0, n_levels - canceled_orders_buy)
            existing_long_lvl = {p["level"] for p in long_positions}
            for j in range(long_start, n_levels):
                if j not in existing_long_lvl:
                    env        = envelopes[j]
                    limit_px   = ma_curr * (1.0 - env)
                    trigger_px = limit_px * 1.005
                    open_long_triggers[j] = (limit_px, trigger_px)
            pending_long_tp = ma_curr

        if has_short:
            total_sz        = sum(p["size"] for p in short_positions)
            avg_entry_short = sum(p["entry_px"] * p["size"] for p in short_positions) / total_sz
            if peak_short_price is None:
                peak_short_price  = close
                if stop_loss_pct > 0:
                    original_short_sl = avg_entry_short * (1.0 + stop_loss_pct / 100.0)
            else:
                peak_short_price = min(peak_short_price, close)
            pending_short_sl = _tsl_short(peak_short_price, original_short_sl, i)

            short_start        = max(0, n_levels - canceled_orders_sell)
            existing_short_lvl = {p["level"] for p in short_positions}
            for j in range(short_start, n_levels):
                if j not in existing_short_lvl:
                    env      = envelopes[j]
                    high_env = round(1.0 / (1.0 - env) - 1.0, 3)
                    limit_px   = ma_curr * (1.0 + high_env)
                    trigger_px = limit_px * 0.995
                    open_short_triggers[j] = (limit_px, trigger_px)
            pending_short_tp = ma_curr

        if not has_long and "long" in active_sides:
            for j in range(n_levels):
                env        = envelopes[j]
                limit_px   = ma_curr * (1.0 - env)
                trigger_px = limit_px * 1.005
                open_long_triggers[j] = (limit_px, trigger_px)

        if not has_short and "short" in active_sides:
            for j in range(n_levels):
                env      = envelopes[j]
                high_env = round(1.0 / (1.0 - env) - 1.0, 3)
                limit_px   = ma_curr * (1.0 + high_env)
                trigger_px = limit_px * 0.995
                open_short_triggers[j] = (limit_px, trigger_px)

        # ── STEP 4b: IMMEDIATE RE-ENTRY ──────────────────────────────────────
        if long_tp_fired and not has_long and "long" in active_sides:
            filled_re = []
            for j, (limit_px, trigger_px) in list(open_long_triggers.items()):
                margin = per_levels[j]
                if low <= trigger_px and cash >= margin:
                    size = (margin * leverage) / limit_px
                    fee  = limit_px * size * fee_rate
                    cash -= margin + fee
                    long_positions.append({"level": j, "entry_px": limit_px, "size": size, "margin": margin})
                    trades.append({"type": "long_entry_reentry", "price": limit_px})
                    filled_re.append(j)
            for j in filled_re:
                del open_long_triggers[j]
            if long_positions:
                has_long = True
                peak_long_price   = close
                total_sz_re       = sum(p["size"] for p in long_positions)
                avg_re            = sum(p["entry_px"] * p["size"] for p in long_positions) / total_sz_re
                original_long_sl  = avg_re * (1.0 - stop_loss_pct / 100.0) if stop_loss_pct > 0 else None
                pending_long_tp   = ma_curr
                pending_long_sl   = _tsl_long(peak_long_price, original_long_sl, i)

        if short_tp_fired and not has_short and "short" in active_sides:
            filled_re = []
            for j, (limit_px, trigger_px) in list(open_short_triggers.items()):
                margin = per_levels[j]
                if high >= trigger_px and cash >= margin:
                    size = (margin * leverage) / limit_px
                    fee  = limit_px * size * fee_rate
                    cash -= margin + fee
                    short_positions.append({"level": j, "entry_px": limit_px, "size": size, "margin": margin})
                    trades.append({"type": "short_entry_reentry", "price": limit_px})
                    filled_re.append(j)
            for j in filled_re:
                del open_short_triggers[j]
            if short_positions:
                has_short = True
                peak_short_price  = close
                total_sz_re       = sum(p["size"] for p in short_positions)
                avg_re            = sum(p["entry_px"] * p["size"] for p in short_positions) / total_sz_re
                original_short_sl = avg_re * (1.0 + stop_loss_pct / 100.0) if stop_loss_pct > 0 else None
                pending_short_tp  = ma_curr
                pending_short_sl  = _tsl_short(peak_short_price, original_short_sl, i)

        # ── Equity ────────────────────────────────────────────────────────────
        pos_value = 0.0
        for pos in long_positions:
            pos_value += pos["margin"] + (close - pos["entry_px"]) * pos["size"]
        for pos in short_positions:
            pos_value += pos["margin"] + (pos["entry_px"] - close) * pos["size"]
        equity = cash + pos_value

        if equity > max_equity:
            max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown:
            max_drawdown = dd

        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct      = (final_equity - allocation) / allocation * 100

    first_price = candles_1m[0]["close"]
    last_price  = candles_1m[-1]["close"]
    bnh_pct     = (last_price - first_price) / first_price * 100

    close_trades = [t for t in trades if t["type"] in ("long_close", "short_close")]
    winning      = [t for t in close_trades if t.get("pnl", 0) > 0]
    win_rate     = len(winning) / len(close_trades) * 100 if close_trades else 0

    return {
        "pnl_pct":          round(pnl_pct, 2),
        "pnl_usd":          round(final_equity - allocation, 2),
        "final_equity":     round(final_equity, 2),
        "total_trades":     len(trades),
        "win_rate":         round(win_rate, 1),
        "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct":          round(bnh_pct, 2),
        "equity_curve":     equity_curve,
        "candles_used":     len(candles_1m),
    }


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
