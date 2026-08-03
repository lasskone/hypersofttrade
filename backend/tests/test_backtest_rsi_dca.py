"""
Smoke test — backtest_rsi_dca_grid on synthetic candle data.

Scenario
--------
- 325 entry candles (15m bars) and 82 aligned context candles (1h bars).
- First 230 entry candles: gentle uptrend → EMA50 well established, RSI ≈ neutral.
- Next 20 candles:  sharp drop of -3 per bar  → 15m RSI collapses below 30.
- Next 3 candles:   sharp recovery of +7 per bar → RSI crosses back above 30.
- Next 72 candles:  continued slow uptrend (allows TP/SL to resolve).

Expected: at least 1 trade fires (long RSI oversold bounce), all required keys present.
"""
import asyncio
import sys
import os

# Make sure the backend root is on the path.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.backtest_engine import backtest_rsi_dca_grid


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic candle generator
# ─────────────────────────────────────────────────────────────────────────────

def mk(t, o, h, l, c, vol=1000.0):
    return {
        "time":   int(t),
        "open":   float(o),
        "high":   float(h),
        "low":    float(l),
        "close":  float(c),
        "volume": float(vol),
    }


def build_candles():
    STEP_15M = 900   # seconds
    STEP_1H  = 3600

    entry = []
    p     = 100.0
    t     = 0

    # Phase 1: 230 gentle-uptrend bars
    for i in range(230):
        new_p = p + 0.05
        entry.append(mk(t, p, new_p + 0.10, p - 0.05, new_p, vol=900 + i % 100))
        p  = new_p
        t += STEP_15M

    # Phase 2: 20 sharp-drop bars (−3 each → RSI → 0)
    for _ in range(20):
        new_p = p - 3.0
        entry.append(mk(t, p, p + 0.10, new_p - 0.10, new_p, vol=2000))
        p  = new_p
        t += STEP_15M

    # Phase 3: 3 recovery bars (+7 each → RSI crosses 30)
    for _ in range(3):
        new_p = p + 7.0
        entry.append(mk(t, p, new_p + 0.50, p - 0.20, new_p, vol=3000))
        p  = new_p
        t += STEP_15M

    # Phase 4: 72 slow-continuation bars (allows TP / SL to resolve)
    for _ in range(72):
        new_p = p + 0.10
        entry.append(mk(t, p, new_p + 0.20, p - 0.05, new_p, vol=1000))
        p  = new_p
        t += STEP_15M

    # Context candles: INDEPENDENT steady uptrend on 1h bars, aligned by time.
    # Kept separate from entry so the 15m price drop does NOT drag the 1h EMA down.
    # The context "coin" price climbs steadily from 100 to 200 — well above EMA10
    # at all times, making the long context filter always pass.
    # (Real data would be the same coin at 1h; independence is fine for a smoke test.)
    context = []
    p_ctx = 100.0
    t_ctx = 0
    total_entry_time = (len(entry) - 1) * STEP_15M
    while t_ctx <= total_entry_time + STEP_1H:
        new_p_ctx = p_ctx + 1.0
        context.append(mk(t_ctx, p_ctx, new_p_ctx + 0.5, p_ctx - 0.1, new_p_ctx))
        p_ctx  = new_p_ctx
        t_ctx += STEP_1H

    return entry, context


# ─────────────────────────────────────────────────────────────────────────────
# Test
# ─────────────────────────────────────────────────────────────────────────────

REQUIRED_KEYS = {
    "pnl_pct", "pnl_usd", "final_equity", "total_trades",
    "win_rate", "max_drawdown_pct", "bnh_pct", "equity_curve", "candles_used",
}


async def run():
    candles_entry, candles_context = build_candles()
    print(f"Entry candles  : {len(candles_entry)}")
    print(f"Context candles: {len(candles_context)}")

    result = await backtest_rsi_dca_grid(
        candles_entry         = candles_entry,
        candles_context       = candles_context,
        allocated_usdc        = 1000.0,
        leverage              = 1,
        sz_decimals           = 2,
        sides                 = ["long"],
        ema_period            = 10,          # needs 12 context bars — we have 80+ ✓
        use_adx_filter        = False,       # simplify
        adx_period            = 14,
        adx_threshold         = 25.0,
        rsi_period            = 14,
        rsi_oversold          = 30.0,
        rsi_overbought        = 70.0,
        use_time_window       = False,       # simplify
        window_start_utc_hour = 0,
        window_end_utc_hour   = 24,
        use_volume_filter     = False,       # simplify
        volume_multiplier     = 1.3,
        volume_lookback       = 20,
        dca_pcts              = [2.0],       # one DCA level
        max_exposure_pct      = 100.0,
        sl_pct                = 5.0,
        tp_pct                = 3.0,
        cooldown_candles      = 3,
    )

    print("\n── Result ──────────────────────────────────────────────────────")
    for k, v in result.items():
        if k == "equity_curve":
            print(f"  equity_curve   : [{len(v)} points, first={v[0]}, last={v[-1]}]")
        else:
            print(f"  {k:<22}: {v}")

    # ── Assertions ────────────────────────────────────────────────────────────
    assert "error" not in result, f"Backtest returned error: {result.get('error')}"

    missing = REQUIRED_KEYS - result.keys()
    assert not missing, f"Missing keys: {missing}"

    assert result["candles_used"] == len(candles_entry), \
        f"candles_used mismatch: {result['candles_used']} != {len(candles_entry)}"

    assert result["total_trades"] >= 1, \
        f"Expected ≥1 trade, got {result['total_trades']}"

    assert 0.0 <= result["win_rate"] <= 1.0, \
        f"win_rate out of range: {result['win_rate']}"

    assert result["max_drawdown_pct"] >= 0.0, \
        f"Negative max_drawdown: {result['max_drawdown_pct']}"

    assert len(result["equity_curve"]) == len(candles_entry), \
        f"equity_curve length mismatch"

    print("\n── All assertions passed ✓ ──────────────────────────────────────")


if __name__ == "__main__":
    asyncio.run(run())
