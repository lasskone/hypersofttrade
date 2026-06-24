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

    Reproduces EXACT live EnvelopeBot logic including canceled_orders tracking:

    Per candle:
      1. Count pending trigger orders BEFORE cancel (canceled_orders_buy/sell).
         Filled levels have disappeared from the book → count tells us what's remaining.
      2. Cancel ALL triggers (clear both trigger dicts).
      3. Manage long  position: SL on LOW, TP on HIGH, then place remaining long  triggers.
      4. Manage short position: SL on HIGH, TP on LOW, then place remaining short triggers.
      5. If flat: place ALL levels for each configured side.
      6. Check fills on this candle: long  fill when LOW  <= trigger_px → entry at limit_px.
                                     short fill when HIGH >= trigger_px → entry at limit_px.

    open_long_triggers / open_short_triggers: dict {level_idx → (limit_px, trigger_px)}
      Carries pending trigger orders between candles — same role as the live bot's
      frontendOpenOrders count.

    - MA shifted by 1 bar (no lookahead): uses closes[i-period:i]
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

    # Pending trigger orders carried between candles — mirrors the live bot's order book.
    # {level_idx: (limit_px, trigger_px)}
    open_long_triggers:  dict[int, tuple[float, float]] = {}
    open_short_triggers: dict[int, tuple[float, float]] = {}

    trades:       list[dict] = []
    equity_curve: list[dict] = []
    max_equity   = allocation
    max_drawdown = 0.0

    for i in range(ma_period, len(candles_1m)):
        # MA shifted by 1 — identical to live bot: closes[i-period:i], index i excluded
        ma    = sum(closes[i - ma_period:i]) / ma_period
        low   = candles_1m[i]["low"]
        high  = candles_1m[i]["high"]
        close = candles_1m[i]["close"]
        ts    = candles_1m[i]["time"]

        # ── STEP 1: count pending triggers before cancel ──────────────────────
        canceled_orders_buy  = len(open_long_triggers)
        canceled_orders_sell = len(open_short_triggers)

        # ── STEP 2: cancel all pending triggers — clean slate ─────────────────
        open_long_triggers.clear()
        open_short_triggers.clear()

        has_long  = len(long_positions) > 0
        has_short = len(short_positions) > 0

        # ── STEP 3: manage long position ─────────────────────────────────────
        if has_long:
            total_sz  = sum(p["size"] for p in long_positions)
            avg_entry = sum(p["entry_px"] * p["size"] for p in long_positions) / total_sz

            # SL: low-triggered (worst-case first)
            if stop_loss_pct > 0:
                sl_px = avg_entry * (1.0 - stop_loss_pct / 100.0)
                if low <= sl_px:
                    for pos in long_positions:
                        pnl = (sl_px - pos["entry_px"]) * pos["size"]
                        fee = sl_px * pos["size"] * fee_rate
                        cash += per_level + pnl - fee
                        trades.append({"type": "long_sl", "price": sl_px, "pnl": pnl - fee})
                    long_positions.clear()
                    has_long = False

            # TP: high-triggered, closes ALL at MA
            if has_long and high >= ma:
                for pos in long_positions:
                    pnl = (ma - pos["entry_px"]) * pos["size"]
                    fee = ma * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "long_close", "price": ma, "pnl": pnl - fee})
                long_positions.clear()
                has_long = False

        # ── STEP 4: manage short position ────────────────────────────────────
        if has_short:
            total_sz  = sum(p["size"] for p in short_positions)
            avg_entry = sum(p["entry_px"] * p["size"] for p in short_positions) / total_sz

            # SL: high-triggered (worst-case first)
            if stop_loss_pct > 0:
                sl_px = avg_entry * (1.0 + stop_loss_pct / 100.0)
                if high >= sl_px:
                    for pos in short_positions:
                        pnl = (pos["entry_px"] - sl_px) * pos["size"]
                        fee = sl_px * pos["size"] * fee_rate
                        cash += per_level + pnl - fee
                        trades.append({"type": "short_sl", "price": sl_px, "pnl": pnl - fee})
                    short_positions.clear()
                    has_short = False

            # TP: low-triggered, closes ALL at MA
            if has_short and low <= ma:
                for pos in short_positions:
                    pnl = (pos["entry_px"] - ma) * pos["size"]
                    fee = ma * pos["size"] * fee_rate
                    cash += per_level + pnl - fee
                    trades.append({"type": "short_close", "price": ma, "pnl": pnl - fee})
                short_positions.clear()
                has_short = False

        # ── STEP 5: place trigger orders ─────────────────────────────────────
        # Mirrors live bot logic exactly:
        #   - In position: place only REMAINING levels (those not already filled).
        #     n_levels - canceled_orders_buy/sell = how many were still pending last tick
        #     (filled levels were absent from the pre-cancel count).
        #   - Flat: place ALL levels.
        # The `existing_levels` check prevents re-placing a level already in positions.
        if "long" in sides:
            long_start        = max(0, n_levels - canceled_orders_buy) if has_long else 0
            existing_long_lvl = {p["level"] for p in long_positions}
            for j in range(long_start, n_levels):
                if j not in existing_long_lvl:
                    env        = envelopes[j]
                    limit_px   = ma * (1.0 - env)
                    trigger_px = limit_px * 1.005
                    open_long_triggers[j] = (limit_px, trigger_px)

        if "short" in sides:
            short_start        = max(0, n_levels - canceled_orders_sell) if has_short else 0
            existing_short_lvl = {p["level"] for p in short_positions}
            for j in range(short_start, n_levels):
                if j not in existing_short_lvl:
                    env      = envelopes[j]
                    high_env = round(1.0 / (1.0 - env) - 1.0, 3)
                    limit_px   = ma * (1.0 + high_env)
                    trigger_px = limit_px * 0.995
                    open_short_triggers[j] = (limit_px, trigger_px)

        # ── STEP 6: check fills on this candle ────────────────────────────────
        # Long fill: candle LOW <= trigger_px → entry at limit_px
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

        # Short fill: candle HIGH >= trigger_px → entry at limit_px
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
