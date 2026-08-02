"""
Backtest engine — strategy simulation functions for historical OHLCV data.

Add one function per bot strategy as strategies are implemented.
Each function should accept a list of candle dicts (keys: open, high, low, close, time)
and return a standardised result dict with at minimum:
    pnl_pct, pnl_usd, final_equity, total_trades, win_rate,
    max_drawdown_pct, bnh_pct, equity_curve, candles_used
"""
from __future__ import annotations
