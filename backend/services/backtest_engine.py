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
