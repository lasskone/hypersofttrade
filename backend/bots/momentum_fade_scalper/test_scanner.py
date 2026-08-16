"""
Smoke test: run scan_all against live Hyperliquid market data.
READ-ONLY — no orders are placed, no credentials required.

Usage (from backend/ directory):
    python3 -m pytest bots/momentum_fade_scalper/test_scanner.py -v -s
    python3 bots/momentum_fade_scalper/test_scanner.py
"""
from __future__ import annotations
import asyncio
import os
import sys

# Ensure backend/ is on sys.path regardless of working directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from bots.momentum_fade_scalper.scanner import (
    scan_all,
    scan_symbol,
    DEFAULT_SCANNER_CONFIG,
    FadeMarketScore,
)

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
    """
    Integration smoke test: scan BTC, ETH, SOL against live Hyperliquid data.

    Structural checks validate that returned FadeMarketScore objects have
    sane field values regardless of market conditions.  The qualifying filter
    is intentionally strict (all 5 gates), so 0 qualifying results is normal
    — we check shape, not that every symbol qualifies.
    """
    print("\n" + "=" * 72)
    print("MOMENTUM FADE SCALPER SCANNER — LIVE SMOKE TEST")
    print("Fetching real market data from Hyperliquid (read-only)…")
    print("=" * 72)

    SYMBOLS = ["BTC", "ETH", "SOL"]

    # ── Fetch ALL results (not just qualifying) for structural assertions ──────
    print("\nFetching individual scan results for all symbols…")

    async def _gather_all() -> list[FadeMarketScore]:
        return list(await asyncio.gather(
            *[scan_symbol(sym, DEFAULT_SCANNER_CONFIG) for sym in SYMBOLS]
        ))

    all_scores: list[FadeMarketScore] = asyncio.run(_gather_all())

    # ── Structural assertions ──────────────────────────────────────────────────
    print("\n── Structural checks ────────────────────────────────────────────────")
    assert_true("scan returned 3 results (one per symbol)", len(all_scores) == 3)

    for ms in all_scores:
        assert_true(
            f"{ms.symbol} direction valid",
            ms.direction in ("long", "short", "neutral"),
        )
        assert_true(
            f"{ms.symbol} qualifies is bool",
            isinstance(ms.qualifies, bool),
        )
        assert_true(
            f"{ms.symbol} has at least one reason",
            len(ms.reasons) > 0,
        )
        assert_range(f"{ms.symbol} rsi7",         ms.rsi7,         0.0, 100.0)
        assert_range(f"{ms.symbol} atr_pct",      ms.atr_pct,      0.0,   5.0)
        assert_range(f"{ms.symbol} volume_ratio",  ms.volume_ratio,  0.0,  50.0)
        assert_range(f"{ms.symbol} spread_pct",    ms.spread_pct,    0.0,   1.0)
        if ms.efficiency_ratio is not None:
            assert_range(f"{ms.symbol} efficiency_ratio", ms.efficiency_ratio, 0.0, 1.0)

    # ── Qualifying scan (what scan_all actually returns) ──────────────────────
    print("\nRunning scan_all (qualifying filter)…")
    qualifying = asyncio.run(scan_all(SYMBOLS, DEFAULT_SCANNER_CONFIG))

    assert_true(
        "qualifying results sorted by efficiency_ratio DESC",
        qualifying == sorted(
            qualifying,
            key=lambda r: r.efficiency_ratio if r.efficiency_ratio is not None else 0.0,
            reverse=True,
        ),
    )
    assert_true(
        "all qualifying results have qualifies=True",
        all(r.qualifies for r in qualifying),
    )

    # ── Human-readable output ──────────────────────────────────────────────────
    print("\n── All symbol results (pre-filter) ──────────────────────────────────")
    for ms in all_scores:
        gate = "QUALIFIES" if ms.qualifies else "filtered out"
        er_str = f"{ms.efficiency_ratio:.3f}" if ms.efficiency_ratio is not None else "n/a"
        print(f"\n{'─' * 72}")
        print(f"  {ms.symbol:<6} │ {ms.direction.upper():<7} │ {gate}")
        print(f"{'─' * 72}")
        print(
            f"  EMA9={ms.ema9:.4f}  EMA21={ms.ema21:.4f}  "
            f"RSI7={ms.rsi7:.1f}  ER={er_str}"
        )
        print(
            f"  ATR%={ms.atr_pct:.3f}  vol_ratio={ms.volume_ratio:.2f}  "
            f"spread%={ms.spread_pct:.4f}"
        )
        print("  Reasons:")
        for r in ms.reasons:
            print(f"    • {r}")

    print(f"\n── Qualifying results ({len(qualifying)} of {len(SYMBOLS)}) ───────────────────────────────")
    if qualifying:
        for ms in qualifying:
            er_str = f"{ms.efficiency_ratio:.3f}" if ms.efficiency_ratio is not None else "n/a"
            print(f"  {ms.symbol} | {ms.direction.upper()} | ER={er_str} | RSI7={ms.rsi7:.1f}")
    else:
        print("  (none — all gates passed for 0 symbols; this is normal at any given moment)")

    print(f"\n{'=' * 72}")
    if _failures:
        print(f"RESULT: {len(_failures)} assertion(s) FAILED:")
        for f in _failures:
            print(f"  ✗ {f}")
        sys.exit(1)
    else:
        total = len(all_scores)
        print(f"RESULT: all assertions passed ({total} symbol(s) scanned, {len(qualifying)} qualifying)")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    test_scan_all_live()
