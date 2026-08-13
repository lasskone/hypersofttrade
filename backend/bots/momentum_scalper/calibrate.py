"""
backend/bots/momentum_scalper/calibrate.py

Calibration logger for the Momentum Pullback Scalper scanner.

Runs scan_all() on a fixed symbol list every 60 seconds, indefinitely.
Writes structured observations to calibration_log.jsonl (JSON Lines) so
scoring behaviour can be analysed across many symbols and time-of-day
periods before any threshold is tuned.

READ-ONLY — no orders are placed, no credentials required.

Usage (from backend/ directory):
    python3 bots/momentum_scalper/calibrate.py

Stop with Ctrl+C; the log file is flushed on every write so no data is
lost on an abrupt stop.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone

# Ensure backend/ is on sys.path regardless of working directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from bots.momentum_scalper.scanner import (
    DEFAULT_SCANNER_CONFIG,
    MarketScore,
    scan_all,
)

# ── Configuration ──────────────────────────────────────────────────────────────

SYMBOLS: list[str] = ["BTC", "ETH", "SOL", "XRP", "HYPE"]

SCAN_INTERVAL_S: int = 60   # seconds between scan cycles

# Log file lives alongside this script.
LOG_PATH: str = os.path.join(os.path.dirname(__file__), "calibration_log.jsonl")

# Component name → max points (used for bottleneck detection).
_MAX_SCORES: dict[str, float] = {
    "trend_score":      20.0,
    "momentum_score":   20.0,
    "volume_score":     15.0,
    "volatility_score": 15.0,
    "pullback_score":   10.0,
    "structure_score":  10.0,
    "execution_score":  10.0,
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _bottleneck(ms: MarketScore) -> str:
    """Return the sub-score component whose gap to its maximum is largest.

    E.g. if volatility_score=0 (gap=15) and all others are closer to their max,
    this returns "volatility_score 0.0/15".  Useful for spotting which gate most
    often prevents a symbol from reaching min_score.
    """
    scores = {
        "trend_score":      ms.trend_score,
        "momentum_score":   ms.momentum_score,
        "volume_score":     ms.volume_score,
        "volatility_score": ms.volatility_score,
        "pullback_score":   ms.pullback_score,
        "structure_score":  ms.structure_score,
        "execution_score":  ms.execution_score,
    }
    worst_key  = max(scores, key=lambda k: _MAX_SCORES[k] - scores[k])
    worst_val  = scores[worst_key]
    worst_max  = _MAX_SCORES[worst_key]
    return f"{worst_key} {worst_val:.1f}/{worst_max:.0f}"


def _record(ms: MarketScore, ts: str) -> dict:
    """Serialize one MarketScore to a plain dict suitable for JSON."""
    return {
        "timestamp":        ts,
        "symbol":           ms.symbol,
        "direction":        ms.direction,
        "total_score":      ms.total_score,
        "trend_score":      ms.trend_score,
        "momentum_score":   ms.momentum_score,
        "volume_score":     ms.volume_score,
        "volatility_score": ms.volatility_score,
        "pullback_score":   ms.pullback_score,
        "structure_score":  ms.structure_score,
        "execution_score":  ms.execution_score,
        "atr_pct":          ms.atr_pct,
        "spread_pct":       ms.spread_pct,
        "rsi_value":        ms.rsi_value,
        "adx_value":        ms.adx_value,
        "bottleneck":       _bottleneck(ms),
    }


def _stdout_summary(results: list[MarketScore], ts: str) -> str:
    """Build a compact one-line summary string for a scan cycle."""
    parts = [ts]
    for ms in sorted(results, key=lambda r: r.symbol):   # alphabetical in summary
        parts.append(f"{ms.symbol}={ms.total_score:.1f}({ms.direction[0]})")
    return " | ".join(parts)


# ── Main loop ──────────────────────────────────────────────────────────────────

async def _run() -> None:
    cycle = 0
    print(
        f"Calibration logger starting — symbols={SYMBOLS} "
        f"interval={SCAN_INTERVAL_S}s log={LOG_PATH}"
    )
    print("Press Ctrl+C to stop.\n")

    while True:
        cycle += 1
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        ts_short = datetime.now(timezone.utc).strftime("%H:%M:%S")

        try:
            results = await scan_all(SYMBOLS, DEFAULT_SCANNER_CONFIG)
        except Exception as exc:
            print(f"{ts_short} | cycle={cycle} ERROR during scan_all: {exc}")
            await asyncio.sleep(SCAN_INTERVAL_S)
            continue

        # Write one JSON line per symbol (flush immediately — safe on abrupt stop).
        with open(LOG_PATH, "a", buffering=1) as fh:
            for ms in results:
                row = _record(ms, ts)
                fh.write(json.dumps(row) + "\n")

        summary = _stdout_summary(results, ts_short)
        print(f"[cycle {cycle:04d}] {summary}")

        await asyncio.sleep(SCAN_INTERVAL_S)


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("\nCalibration stopped by user. Log flushed.")
        sys.exit(0)


if __name__ == "__main__":
    main()
