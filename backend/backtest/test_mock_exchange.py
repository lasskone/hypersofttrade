"""
Standalone tests for MockExchange — no pytest required.
Run:  python backend/backtest/test_mock_exchange.py
"""
from __future__ import annotations
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backtest.mock_exchange import MockExchange

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
_failures: list[str] = []


def assert_eq(label: str, got, expected) -> None:
    ok = abs(got - expected) < 1e-9 if isinstance(got, float) else got == expected
    status = PASS if ok else FAIL
    print(f"  [{status}] {label}: got={got!r}  expected={expected!r}")
    if not ok:
        _failures.append(label)


def assert_true(label: str, cond: bool) -> None:
    status = PASS if cond else FAIL
    print(f"  [{status}] {label}")
    if not cond:
        _failures.append(label)


# ─────────────────────────────────────────────────────────────────────────────
# Test helpers
# ─────────────────────────────────────────────────────────────────────────────

def _candle(o, h, l, c, t=0):
    return {"open": o, "high": h, "low": l, "close": c, "time": t}


# ─────────────────────────────────────────────────────────────────────────────
# 1. update_leverage
# ─────────────────────────────────────────────────────────────────────────────
def test_update_leverage():
    print("\n── test_update_leverage")
    ex = MockExchange(sz_decimals=3)
    result = ex.update_leverage(5, "BTC", False)
    assert_eq("status", result["status"], "ok")
    assert_eq("leverage stored", ex.leverage, 5)


# ─────────────────────────────────────────────────────────────────────────────
# 2. IOC order — immediate fill on marketable open
# ─────────────────────────────────────────────────────────────────────────────
def test_ioc_fill():
    print("\n── test_ioc_fill: buy IOC fills at candle open")
    ex = MockExchange(sz_decimals=3)
    ex.current_candle = _candle(50_000, 51_000, 49_000, 50_500, t=1)

    # Buy IOC at $50 100 — open is $50 000, so px >= open → marketable
    result = ex.order("BTC", True, 0.01, 50_100, {"limit": {"tif": "Ioc"}})
    statuses = result["response"]["data"]["statuses"]
    assert_true("status ok", result["status"] == "ok")
    assert_true("filled status present", "filled" in statuses[0])
    assert_eq("position_szi", ex.position_szi, 0.01)
    assert_eq("fill_px at open", float(statuses[0]["filled"]["avgPx"]), 50_000.0)
    assert_eq("fill_log length", len(ex.fill_log), 1)


def test_ioc_cancel_not_marketable():
    print("\n── test_ioc_cancel: buy IOC below open → cancelled")
    ex = MockExchange(sz_decimals=3)
    ex.current_candle = _candle(50_000, 51_000, 49_000, 50_500, t=2)

    # Buy IOC at $49 500 — open is $50 000, px < open → not marketable
    result = ex.order("BTC", True, 0.01, 49_500, {"limit": {"tif": "Ioc"}})
    statuses = result["response"]["data"]["statuses"]
    assert_true("error returned", "error" in statuses[0])
    assert_eq("position unchanged", ex.position_szi, 0.0)
    assert_eq("fill_log empty", len(ex.fill_log), 0)


# ─────────────────────────────────────────────────────────────────────────────
# 3. GTC limit + check_fills — the core DCA scenario
# ─────────────────────────────────────────────────────────────────────────────
def test_gtc_dca_fill():
    print("\n── test_gtc_dca_fill: DCA limit rests, fills when candle crosses price")
    ex = MockExchange(sz_decimals=3)

    # ── Candle 1: open long via IOC market order ──────────────────────────────
    entry_candle = _candle(50_000, 51_000, 49_500, 50_800, t=100)
    ex.current_candle = entry_candle
    ex.order("BTC", True, 0.01, 50_500, {"limit": {"tif": "Ioc"}})
    assert_eq("after entry: position_szi", ex.position_szi, 0.01)
    assert_eq("after entry: entry_px", ex.position_entry_px, 50_000.0)

    # ── Place GTC DCA limit 7% below entry ───────────────────────────────────
    dca_px = round(50_000 * (1 - 0.07), 1)   # 46 500.0
    result = ex.order("BTC", True, 0.02, dca_px, {"limit": {"tif": "Gtc"}})
    dca_oid = result["response"]["data"]["statuses"][0]["resting"]["oid"]
    assert_true("DCA order resting", dca_oid in ex.resting_orders)
    assert_eq("resting_orders count", len(ex.resting_orders), 1)

    # ── Candle 2: price doesn't reach DCA level ───────────────────────────────
    ex.check_fills(_candle(50_800, 51_200, 47_500, 51_000, t=200))
    assert_eq("DCA not filled yet (low=47 500 > 46 500)", len(ex.resting_orders), 1)
    assert_eq("position_szi still 0.01", ex.position_szi, 0.01)

    # ── Candle 3: low dips below DCA → fill ──────────────────────────────────
    ex.check_fills(_candle(47_000, 47_200, 46_000, 46_800, t=300))
    assert_eq("DCA filled — resting_orders empty", len(ex.resting_orders), 0)
    assert_eq("position_szi after DCA", ex.position_szi, 0.03)   # 0.01 + 0.02

    # Weighted average entry: (0.01*50000 + 0.02*46500) / 0.03
    expected_entry = (0.01 * 50_000 + 0.02 * 46_500) / 0.03
    assert_eq("weighted avg entry", ex.position_entry_px, expected_entry)
    assert_eq("fill_log has 2 entries", len(ex.fill_log), 2)
    assert_eq("DCA fill oid correct", ex.fill_log[-1]["oid"], dca_oid)
    assert_eq("DCA fill ts", ex.fill_log[-1]["ts"], 300)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Trigger (stop-market SL) — fills when candle's low crosses triggerPx
# ─────────────────────────────────────────────────────────────────────────────
def test_stop_market_sl():
    print("\n── test_stop_market_sl: SL trigger fills when price drops below trigger")
    ex = MockExchange(sz_decimals=3)

    # Open a long position
    ex.current_candle = _candle(50_000, 51_000, 49_500, 50_800, t=100)
    ex.order("BTC", True, 0.01, 50_500, {"limit": {"tif": "Ioc"}})

    # Place a stop-sell SL at $45 000
    sl_px = 45_000.0
    order_type = {"trigger": {"triggerPx": sl_px, "isMarket": True, "tpsl": "sl"}}
    result = ex.order("BTC", False, 0.01, sl_px, order_type, reduce_only=True)
    sl_oid = result["response"]["data"]["statuses"][0]["resting"]["oid"]
    assert_true("SL order resting", sl_oid in ex.resting_orders)

    # Candle whose low doesn't reach SL
    ex.check_fills(_candle(49_000, 49_500, 45_100, 49_200, t=200))
    assert_eq("SL not triggered (low=45 100 > 45 000)", len(ex.resting_orders), 1)

    # Candle whose low crosses SL
    ex.check_fills(_candle(46_000, 46_200, 44_500, 45_800, t=300))
    assert_eq("SL triggered — resting_orders empty", len(ex.resting_orders), 0)
    assert_eq("position_szi after SL", ex.position_szi, 0.0)
    assert_eq("fill_log has 2 entries", len(ex.fill_log), 2)
    assert_eq("SL fill price = triggerPx", ex.fill_log[-1]["fill_px"], sl_px)


# ─────────────────────────────────────────────────────────────────────────────
# 5. modify_order — success and fallback-to-new-order paths
# ─────────────────────────────────────────────────────────────────────────────
def test_modify_order():
    print("\n── test_modify_order: in-place update and error on missing oid")
    ex = MockExchange(sz_decimals=3)

    # Place a GTC limit
    ex.current_candle = _candle(50_000, 51_000, 49_500, 50_800, t=100)
    result = ex.order("BTC", False, 0.01, 45_000,
                      {"trigger": {"triggerPx": 45_000.0, "isMarket": True, "tpsl": "sl"}},
                      reduce_only=True)
    oid = result["response"]["data"]["statuses"][0]["resting"]["oid"]

    # Modify to new SL price
    new_sl = 44_000.0
    mod = ex.modify_order(
        oid, "BTC", False, 0.01, new_sl,
        {"trigger": {"triggerPx": new_sl, "isMarket": True, "tpsl": "sl"}},
        True,
    )
    assert_true("modify status ok", mod["status"] == "ok")
    assert_true("resting in response", "resting" in mod["response"]["data"]["statuses"][0])
    assert_eq("trigger_px updated", ex.resting_orders[oid]["trigger_px"], new_sl)

    # Modify a non-existent oid — must return error so caller places a new order
    err = ex.modify_order(9999, "BTC", False, 0.01, new_sl,
                          {"trigger": {"triggerPx": new_sl, "isMarket": True, "tpsl": "sl"}},
                          True)
    assert_true("error on missing oid", "error" in err["response"]["data"]["statuses"][0])


# ─────────────────────────────────────────────────────────────────────────────
# 6. cancel
# ─────────────────────────────────────────────────────────────────────────────
def test_cancel():
    print("\n── test_cancel: removes order from resting_orders")
    ex = MockExchange(sz_decimals=3)
    ex.current_candle = _candle(50_000, 51_000, 49_500, 50_800, t=100)
    result = ex.order("BTC", True, 0.01, 46_000, {"limit": {"tif": "Gtc"}})
    oid = result["response"]["data"]["statuses"][0]["resting"]["oid"]
    assert_eq("order resting", len(ex.resting_orders), 1)

    cancel_result = ex.cancel("BTC", oid)
    assert_eq("cancel status", cancel_result["status"], "ok")
    assert_eq("resting_orders now empty", len(ex.resting_orders), 0)

    # Cancel non-existent oid is idempotent
    cancel_result2 = ex.cancel("BTC", 9999)
    assert_eq("idempotent cancel status", cancel_result2["status"], "ok")


# ─────────────────────────────────────────────────────────────────────────────
# 7. reduce_only never flips the position
# ─────────────────────────────────────────────────────────────────────────────
def test_reduce_only_clamp():
    print("\n── test_reduce_only_clamp: SL fill cannot overshoot position size")
    ex = MockExchange(sz_decimals=3)
    ex.current_candle = _candle(50_000, 51_000, 49_500, 50_800, t=100)

    # Open a 0.01 long
    ex.order("BTC", True, 0.01, 50_500, {"limit": {"tif": "Ioc"}})

    # SL order for 999 units — reduce_only should clamp to 0.01
    sl_px = 45_000.0
    order_type = {"trigger": {"triggerPx": sl_px, "isMarket": True, "tpsl": "sl"}}
    ex.order("BTC", False, 999.0, sl_px, order_type, reduce_only=True)

    ex.check_fills(_candle(44_000, 44_500, 43_000, 44_200, t=200))
    assert_eq("position_szi clamped to 0 (not flipped)", ex.position_szi, 0.0)


# ─────────────────────────────────────────────────────────────────────────────
# 8. Full mini-replay: entry → DCA1 → TP
# ─────────────────────────────────────────────────────────────────────────────
def test_full_replay():
    print("\n── test_full_replay: entry IOC → DCA1 GTC → TP GTC")
    ex = MockExchange(sz_decimals=3)

    # Candle 1: entry via IOC
    c1 = _candle(50_000, 51_000, 49_500, 50_800, t=1000)
    ex.current_candle = c1
    ex.order("BTC", True, 0.015, 50_500, {"limit": {"tif": "Ioc"}})
    assert_eq("entry position", ex.position_szi, 0.015)

    # Place DCA1 GTC at -7% and TP GTC at +5% (reduce-only)
    dca1_px = round(50_000 * 0.93, 1)   # 46 500
    tp_px   = round(50_000 * 1.05, 1)   # 52 500
    r_dca = ex.order("BTC", True, 0.035, dca1_px, {"limit": {"tif": "Gtc"}})
    r_tp  = ex.order("BTC", False, 0.05, tp_px, {"limit": {"tif": "Gtc"}}, reduce_only=True)
    dca_oid = r_dca["response"]["data"]["statuses"][0]["resting"]["oid"]
    tp_oid  = r_tp["response"]["data"]["statuses"][0]["resting"]["oid"]
    assert_eq("two resting orders", len(ex.resting_orders), 2)

    # Candle 2: low crosses DCA, TP not reached
    ex.check_fills(_candle(49_000, 49_200, 46_000, 47_500, t=2000))
    assert_eq("DCA filled", dca_oid not in ex.resting_orders, True)
    assert_eq("TP still resting", tp_oid in ex.resting_orders, True)
    assert_eq("position after DCA", ex.position_szi, 0.05)   # 0.015 + 0.035
    expected_avg = (0.015 * 50_000 + 0.035 * 46_500) / 0.05
    assert_eq("avg entry after DCA", ex.position_entry_px, expected_avg)

    # Candle 3: high crosses TP
    ex.check_fills(_candle(49_000, 53_000, 48_500, 52_800, t=3000))
    assert_eq("TP filled", tp_oid not in ex.resting_orders, True)
    # TP was reduce_only=True for 0.05 — entire position closed
    assert_eq("position after TP", ex.position_szi, 0.0)
    assert_eq("total fills", len(ex.fill_log), 3)


# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    test_update_leverage()
    test_ioc_fill()
    test_ioc_cancel_not_marketable()
    test_gtc_dca_fill()
    test_stop_market_sl()
    test_modify_order()
    test_cancel()
    test_reduce_only_clamp()
    test_full_replay()

    print()
    if _failures:
        print(f"\033[91m{len(_failures)} test(s) FAILED: {_failures}\033[0m")
        sys.exit(1)
    else:
        print(f"\033[92mAll tests passed.\033[0m")
