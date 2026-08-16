"""
Smoke test: run scan_pair_all_timeframes("BTC", "") against live Hyperliquid data.
READ-ONLY — no orders, no credentials required.

Usage (from backend/ directory):
    python3 scanner/test_technical_scanner.py
    python3 -m pytest scanner/test_technical_scanner.py -v -s
"""
from __future__ import annotations

import asyncio
import os
import sys

# Ensure backend/ is on sys.path regardless of working directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scanner.technical_scanner import (
    detect_rsi_divergence,
    detect_ema_cross,
    detect_breakout,
    scan_pair_all_timeframes,
)
from services.hyperliquid_service import get_candles

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
_failures: list[str] = []


def assert_true(label: str, cond: bool) -> None:
    status = PASS if cond else FAIL
    print(f"  [{status}] {label}")
    if not cond:
        _failures.append(label)


def assert_in(label: str, value: object, options: tuple) -> None:
    ok = value in options
    status = PASS if ok else FAIL
    print(f"  [{status}] {label}: {value!r}  (expected one of {options})")
    if not ok:
        _failures.append(label)


# ---------------------------------------------------------------------------
# Unit-level checks on a real candle series (BTC 1h, 500 bars)
# ---------------------------------------------------------------------------

def test_detectors_unit() -> None:
    print("\n" + "=" * 72)
    print("UNIT CHECKS — BTC/1h live candles (500 bars)")
    print("=" * 72)

    candles = asyncio.run(get_candles("BTC", "1h", 500))
    # Drop current open bar (matches scanner convention).
    closed = candles[:-1]

    print(f"\n  Fetched {len(candles)} raw bars → {len(closed)} closed bars")
    assert_true("fetched ≥ 400 closed bars", len(closed) >= 400)

    # ── detect_rsi_divergence ─────────────────────────────────────────────
    print("\n── detect_rsi_divergence ────────────────────────────────────────────")
    div = detect_rsi_divergence(closed)
    assert_in("returns valid value", div, ("bullish", "bearish", None))
    print(f"  result: {div!r}")

    # ── detect_ema_cross (EMA200) ─────────────────────────────────────────
    print("\n── detect_ema_cross(200) ────────────────────────────────────────────")
    x200 = detect_ema_cross(closed, 200)
    assert_in("returns valid value", x200, ("up", "down", None))
    print(f"  result: {x200!r}")

    # ── detect_ema_cross (EMA361) ─────────────────────────────────────────
    print("\n── detect_ema_cross(361) ────────────────────────────────────────────")
    x361 = detect_ema_cross(closed, 361)
    assert_in("returns valid value", x361, ("up", "down", None))
    print(f"  result: {x361!r}")

    # ── detect_breakout ───────────────────────────────────────────────────
    print("\n── detect_breakout ──────────────────────────────────────────────────")
    bo = detect_breakout(closed)
    assert_in("returns valid value", bo, ("up", "down", None))
    print(f"  result: {bo!r}")

    # ── Insufficient-data guard ───────────────────────────────────────────
    print("\n── Insufficient-data guards ─────────────────────────────────────────")
    assert_in("divergence on 5 bars → None", detect_rsi_divergence(closed[:5]), (None,))
    assert_in("ema_cross(200) on 10 bars → None", detect_ema_cross(closed[:10], 200), (None,))
    assert_in("breakout on 5 bars → None", detect_breakout(closed[:5]), (None,))


# ---------------------------------------------------------------------------
# Integration: scan_pair_all_timeframes("BTC", "")
# ---------------------------------------------------------------------------

def test_scan_pair_all_timeframes() -> None:
    print("\n" + "=" * 72)
    print("INTEGRATION — scan_pair_all_timeframes('BTC', '') — all 3 timeframes")
    print("Fetching real market data from Hyperliquid (read-only)…")
    print("=" * 72)

    signals = asyncio.run(scan_pair_all_timeframes("BTC", ""))

    print(f"\n  Signals detected: {len(signals)}")
    assert_true("returns a list", isinstance(signals, list))

    VALID_TFS    = {"15m", "1h", "4h"}
    VALID_TYPES  = {
        "rsi_divergence_bullish", "rsi_divergence_bearish",
        "ema200_cross_up", "ema200_cross_down",
        "ema361_cross_up", "ema361_cross_down",
        "breakout_up", "breakout_down",
    }

    for sig in signals:
        assert_true(
            f"{sig['signal_type']}@{sig['timeframe']} has valid timeframe",
            sig.get("timeframe") in VALID_TFS,
        )
        assert_true(
            f"{sig['signal_type']}@{sig['timeframe']} has valid signal_type",
            sig.get("signal_type") in VALID_TYPES,
        )
        assert_true(
            f"{sig['signal_type']}@{sig['timeframe']} has positive price",
            isinstance(sig.get("price"), float) and sig["price"] > 0,
        )

    print("\n── Signal detail ────────────────────────────────────────────────────")
    if signals:
        for sig in signals:
            print(f"  {sig['timeframe']:<4}  {sig['signal_type']:<30}  price={sig['price']:,.2f}")
    else:
        print("  (no signals this cycle — expected, most candles are not at a crossover/breakout/divergence)")

    print(f"\n{'=' * 72}")
    if _failures:
        print(f"RESULT: {len(_failures)} assertion(s) FAILED:")
        for f in _failures:
            print(f"  ✗ {f}")
        sys.exit(1)
    else:
        print(f"RESULT: all assertions passed ({len(signals)} signal(s) detected)")
    print("=" * 72 + "\n")


if __name__ == "__main__":
    test_detectors_unit()
    test_scan_pair_all_timeframes()
