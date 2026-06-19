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
    candles: list[dict],
    allocation: float,
    ma_period: int,
    envelope_1_pct: float,
    envelope_2_pct: float,
    envelope_3_pct: float,
    stop_loss_pct: float,
) -> dict:
    """
    Simulate Envelope DCA bot on OHLCV candles.
    """
    if len(candles) < ma_period + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes = [c["close"] for c in candles]
    envelopes = [e for e in [envelope_1_pct, envelope_2_pct, envelope_3_pct] if e > 0]
    n_levels = len(envelopes)
    per_level = allocation / n_levels if n_levels > 0 else allocation

    cash = allocation
    positions: list[dict] = []
    trades = []
    equity_curve = []
    max_equity = allocation
    max_drawdown = 0.0

    for i in range(ma_period, len(candles)):
        ma = sum(closes[i - ma_period:i]) / ma_period
        close = closes[i]
        low = candles[i]["low"]
        high = candles[i]["high"]
        ts = candles[i]["time"]

        # Buy signals — price dips below envelope levels
        for j, env_pct in enumerate(envelopes):
            buy_price = ma * (1 - env_pct / 100)
            already_in = any(p["level"] == j for p in positions)
            if not already_in and low <= buy_price and cash >= per_level:
                size = per_level / buy_price
                fee = buy_price * size * fee_rate
                cash -= per_level + fee
                positions.append({"level": j, "price": buy_price, "size": size})
                trades.append({"type": "buy", "price": buy_price})

        # Sell signal — price recovers to MA
        if positions and high >= ma:
            for pos in positions:
                pnl = (ma - pos["price"]) * pos["size"]
                fee = ma * pos["size"] * fee_rate
                cash += ma * pos["size"] - fee
                trades.append({"type": "sell", "price": ma, "pnl": pnl - fee})
            positions.clear()

        # Equity
        pos_value = sum(close * p["size"] for p in positions)
        equity = cash + pos_value

        # Stop loss
        if stop_loss_pct > 0 and equity < allocation * (1 - stop_loss_pct / 100):
            for pos in positions:
                pnl = (close - pos["price"]) * pos["size"]
                fee = close * pos["size"] * fee_rate
                cash += close * pos["size"] - fee
                trades.append({"type": "stop_loss", "price": close, "pnl": pnl - fee})
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

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100

    first_price = candles[0]["close"]
    last_price = candles[-1]["close"]
    bnh_pct = (last_price - first_price) / first_price * 100

    sell_trades = [t for t in trades if t["type"] in ("sell",)]
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


def run_bbrsi_backtest(
    candles: list[dict],
    allocation: float,
    bb_period: int,
    bb_std: float,
    rsi_period: int,
    rsi_oversold: float,
    rsi_overbought: float,
    stop_loss_pct: float,
    leverage: int,
) -> dict:
    """Simulate BB+RSI Mean Reversion strategy on OHLCV candles."""
    import math

    if len(candles) < max(bb_period, rsi_period) + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes = [c["close"] for c in candles]

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

    for i in range(max(bb_period, rsi_period) + 1, len(candles)):
        mid = sma(i - 1, bb_period)
        s = std(i - 1, bb_period)
        rsi = rsi_values[i - 1] if i - 1 < len(rsi_values) else None
        close = closes[i]
        prev_close = closes[i - 1]
        ts = candles[i]["time"]

        if mid is None or s is None or rsi is None:
            equity_curve.append({"time": ts, "value": round(cash, 2)})
            continue

        upper_bb = mid + bb_std * s
        lower_bb = mid - bb_std * s

        # Debug first 5 valid candles
        if len(equity_curve) < 5:
            print(f"[bbrsi_debug] i={i} close={close:.2f} lower_bb={lower_bb:.2f} upper_bb={upper_bb:.2f} rsi={rsi:.2f} cash={cash:.2f} position={position}")

        # Stop loss
        if position and stop_loss_pct > 0:
            entry = position["entry_price"]
            pnl_pct = (close - entry) / entry * 100 if position["side"] == "long" else (entry - close) / entry * 100
            if pnl_pct < -stop_loss_pct:
                pnl = (close - entry) * position["size"] if position["side"] == "long" else (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
                trades.append({"type": "stop_loss", "pnl": pnl - fee})
                position = None

        if position is None:
            size = (allocation * leverage) / close
            if prev_close <= lower_bb or rsi < rsi_oversold:
                print(f"[bbrsi_debug] LONG SIGNAL: prev_close={prev_close:.2f} lower_bb={lower_bb:.2f} rsi={rsi:.2f} size={size:.6f} cost={close * size / leverage:.2f} cash={cash:.2f}")
                fee = close * size * fee_rate
                if cash >= close * size / leverage + fee:
                    cash -= close * size / leverage + fee
                    position = {"side": "long", "size": size, "entry_price": close}
                    trades.append({"type": "buy", "price": close})
            elif prev_close >= upper_bb or rsi > rsi_overbought:
                fee = close * size * fee_rate
                if cash >= close * size / leverage + fee:
                    cash -= close * size / leverage + fee
                    position = {"side": "short", "size": size, "entry_price": close}
                    trades.append({"type": "sell_short", "price": close})
        else:
            entry = position["entry_price"]
            if position["side"] == "long" and prev_close >= mid:
                pnl = (close - entry) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
                trades.append({"type": "close_long", "pnl": pnl - fee})
                position = None
            elif position["side"] == "short" and prev_close <= mid:
                pnl = (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
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
    bnh_pct = (candles[-1]["close"] - candles[0]["close"]) / candles[0]["close"] * 100
    sell_trades = [t for t in trades if t["type"] in ("close_long", "close_short")]
    win_rate = len([t for t in sell_trades if t.get("pnl", 0) > 0]) / len(sell_trades) * 100 if sell_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2), "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2), "total_trades": len(trades),
        "win_rate": round(win_rate, 1), "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2), "equity_curve": equity_curve, "candles_used": len(candles),
    }


def run_emacross_backtest(
    candles: list[dict],
    allocation: float,
    ema_fast: int,
    ema_slow: int,
    stop_loss_pct: float,
    leverage: int,
) -> dict:
    """Simulate EMA Cross Trend Following strategy on OHLCV candles."""
    if len(candles) < ema_slow + 5:
        raise ValueError("Not enough candles for backtest")

    fee_rate = 0.00035
    closes = [c["close"] for c in candles]

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

    for i in range(ema_slow + 2, len(candles)):
        fast_prev = ema_fast_vals[i - 2]
        fast_curr = ema_fast_vals[i - 1]
        slow_prev = ema_slow_vals[i - 2]
        slow_curr = ema_slow_vals[i - 1]
        close = closes[i]
        ts = candles[i]["time"]

        if any(v is None for v in [fast_prev, fast_curr, slow_prev, slow_curr]):
            equity_curve.append({"time": ts, "value": round(cash, 2)})
            continue

        golden_cross = fast_prev <= slow_prev and fast_curr > slow_curr
        death_cross = fast_prev >= slow_prev and fast_curr < slow_curr

        # Stop loss
        if position and stop_loss_pct > 0:
            entry = position["entry_price"]
            pnl_pct = (close - entry) / entry * 100 if position["side"] == "long" else (entry - close) / entry * 100
            if pnl_pct < -stop_loss_pct:
                pnl = (close - entry) * position["size"] if position["side"] == "long" else (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
                trades.append({"type": "stop_loss", "pnl": pnl - fee})
                position = None

        if position is None:
            size = (allocation * leverage) / close
            fee = close * size * fee_rate
            if golden_cross and cash >= close * size / leverage + fee:
                cash -= close * size / leverage + fee
                position = {"side": "long", "size": size, "entry_price": close}
                trades.append({"type": "buy", "price": close})
            elif death_cross and cash >= close * size / leverage + fee:
                cash -= close * size / leverage + fee
                position = {"side": "short", "size": size, "entry_price": close}
                trades.append({"type": "sell_short", "price": close})
        else:
            entry = position["entry_price"]
            if position["side"] == "long" and death_cross:
                pnl = (close - entry) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
                trades.append({"type": "close_long", "pnl": pnl - fee})
                position = None
            elif position["side"] == "short" and golden_cross:
                pnl = (entry - close) * position["size"]
                fee = close * position["size"] * fee_rate
                cash += close * position["size"] / leverage + pnl - fee
                trades.append({"type": "close_short", "pnl": pnl - fee})
                position = None

        pos_value = 0.0
        if position:
            entry = position["entry_price"]
            pos_value = (close - entry) * position["size"] if position["side"] == "long" else (entry - close) * position["size"]

        equity = cash + pos_value
        if equity > max_equity: max_equity = equity
        dd = (max_equity - equity) / max_equity * 100
        if dd > max_drawdown: max_drawdown = dd
        equity_curve.append({"time": ts, "value": round(equity, 2)})

    final_equity = equity_curve[-1]["value"] if equity_curve else allocation
    pnl_pct = (final_equity - allocation) / allocation * 100
    bnh_pct = (candles[-1]["close"] - candles[0]["close"]) / candles[0]["close"] * 100
    sell_trades = [t for t in trades if t["type"] in ("close_long", "close_short")]
    win_rate = len([t for t in sell_trades if t.get("pnl", 0) > 0]) / len(sell_trades) * 100 if sell_trades else 0

    return {
        "pnl_pct": round(pnl_pct, 2), "pnl_usd": round(final_equity - allocation, 2),
        "final_equity": round(final_equity, 2), "total_trades": len(trades),
        "win_rate": round(win_rate, 1), "max_drawdown_pct": round(max_drawdown, 2),
        "bnh_pct": round(bnh_pct, 2), "equity_curve": equity_curve, "candles_used": len(candles),
    }
