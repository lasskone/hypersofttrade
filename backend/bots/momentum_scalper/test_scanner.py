"""
Smoke test: run scan_all against live Hyperliquid market data.
READ-ONLY — no orders are placed, no credentials required.

Usage (from backend/ directory):
    python3 -m pytest bots/momentum_scalper/test_scanner.py -v -s
    python3 bots/momentum_scalper/test_scanner.py
"""
from __future__ import annotations
import asyncio
import os
import sys

# Ensure backend/ is on sys.path regardless of working directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from bots.momentum_scalper.scanner import scan_all, DEFAULT_SCANNER_CONFIG

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
_failures: list[str] = []


def assert_true(label: str, cond: bool) -> None:
    status = PASS if cond else FAIL
    print(f"  [{status}] {label}")
    if not cond:
        _failures.append(label)


def assert_range(label: str, value: float, lo: float, hi: float) -> None:
    ok = lo <= value <= hi
    status = PASS if ok else FAIL
    print(f"  [{status}] {label}: {value:.4f}  (expected [{lo}, {hi}])")
    if not ok:
        _failures.append(label)


def test_scan_all_live() -> None:
    """Integration smoke test: scan BTC, ETH, SOL against live Hyperliquid data."""
    print("\n" + "=" * 72)
    print("MOMENTUM SCALPER SCANNER — LIVE SMOKE TEST")
    print("Fetching real market data from Hyperliquid (read-only)…")
    print("=" * 72)

    results = asyncio.run(scan_all(["BTC", "ETH", "SOL"], DEFAULT_SCANNER_CONFIG))

    # ── Structural assertions ──────────────────────────────────────────────────
    print("\n── Structural checks ────────────────────────────────────────────────")
    assert_true("scan_all returned at least one result", len(results) > 0)
    assert_true(
        "results sorted by total_score descending",
        results == sorted(results, key=lambda r: r.total_score, reverse=True),
    )

    for ms in results:
        assert_range(f"{ms.symbol} total_score",      ms.total_score,      0.0, 100.0)
        assert_range(f"{ms.symbol} trend_score",      ms.trend_score,      0.0,  20.0)
        assert_range(f"{ms.symbol} momentum_score",   ms.momentum_score,   0.0,  20.0)
        assert_range(f"{ms.symbol} volume_score",     ms.volume_score,     0.0,  15.0)
        assert_range(f"{ms.symbol} volatility_score", ms.volatility_score, 0.0,  15.0)
        assert_range(f"{ms.symbol} pullback_score",   ms.pullback_score,   0.0,  10.0)
        assert_range(f"{ms.symbol} structure_score",  ms.structure_score,  0.0,  10.0)
        assert_range(f"{ms.symbol} execution_score",  ms.execution_score,  0.0,  10.0)
        assert_true(
            f"{ms.symbol} direction valid",
            ms.direction in ("long", "short", "neutral"),
        )
        assert_true(
            f"{ms.symbol} total_score == sum of components",
            abs(ms.total_score - (
                ms.trend_score + ms.momentum_score + ms.volume_score +
                ms.volatility_score + ms.pullback_score + ms.structure_score +
                ms.execution_score
            )) < 0.05,
        )
        assert_true(f"{ms.symbol} has at least one reason", len(ms.reasons) > 0)

    # ── Human-readable output ──────────────────────────────────────────────────
    print("\n── Scanner results ──────────────────────────────────────────────────")
    for ms in results:
        bar_width = 40
        filled    = int(ms.total_score / 100 * bar_width)
        bar       = "█" * filled + "░" * (bar_width - filled)
        print(f"\n{'─' * 72}")
        print(f"  {ms.symbol:<6} │ {ms.direction.upper():<7} │ total={ms.total_score:5.1f}/100  [{bar}]")
        print(f"{'─' * 72}")
        print(
            f"  trend={ms.trend_score:4.1f}/20   momentum={ms.momentum_score:4.1f}/20   "
            f"volume={ms.volume_score:4.0f}/15   volatility={ms.volatility_score:4.0f}/15"
        )
        print(
            f"  pullback={ms.pullback_score:4.1f}/10  structure={ms.structure_score:4.0f}/10   "
            f"execution={ms.execution_score:4.1f}/10"
        )
        print(
            f"  ATR%={ms.atr_pct:.3f}   spread%={ms.spread_pct:.4f}   "
            f"RSI(M1)={ms.rsi_value:.1f}   ADX(M5)={ms.adx_value}"
        )
        print("  Reasons:")
        for r in ms.reasons:
            print(f"    • {r}")

    print(f"\n{'=' * 72}")
    if _failures:
        print(f"RESULT: {len(_failures)} assertion(s) FAILED:")
        for f in _failures:
            print(f"  ✗ {f}")
        sys.exit(1)
    else:
        print(f"RESULT: all assertions passed ({len(results)} symbol(s) scanned)")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    test_scan_all_live()
