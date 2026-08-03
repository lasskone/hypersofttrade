"""
MockExchange — a drop-in, network-free stand-in for hyperliquid.exchange.Exchange.

Simulates the four Exchange methods used by TrendMagicBot:
    order(), cancel(), modify_order(), update_leverage()

and a replay-runner helper:
    check_fills(candle)

──────────────────────────────────────────────────────────────────────────────
Fill simulation model
──────────────────────────────────────────────────────────────────────────────
Each candle is treated as an OHLCV bar with a known high and low.  The
simulator assumes that at some point during the candle the price touched
every level between the candle's low and high with full liquidity.

Simplifications / known gaps:
  • No partial fills — an order fills entirely or not at all.
  • No slippage beyond what is already baked into the submitted px /
    triggerPx.  A GTC buy limit at $49 900 fills at exactly $49 900 if
    the candle's low is ≤ $49 900, regardless of how far price dropped.
  • No order-book depth — any size is assumed fillable at the limit price.
  • No exchange fees, funding, or liquidations.
  • Intra-candle ordering is not modelled: within a single candle a DCA
    fill and a TP fill could both be credited even if in reality only one
    could have occurred.  The replay runner must decide the priority it
    wants (e.g. check SL before TP before DCA).

These are acceptable simplifications for strategy-level backtesting; they
are NOT a guarantee of real-world fill behaviour.

──────────────────────────────────────────────────────────────────────────────
Order-type reference (mirrors the real Hyperliquid SDK wire format)
──────────────────────────────────────────────────────────────────────────────
GTC limit   : {"limit": {"tif": "Gtc"}}
IOC limit   : {"limit": {"tif": "Ioc"}}
Stop-market : {"trigger": {"triggerPx": float, "isMarket": True, "tpsl": "sl"|"tp"}}

For a stop-market the `px` argument to order() is ignored; the fill
price is triggerPx.
"""
from __future__ import annotations

import math


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor


def _ok_response(status_inner: dict) -> dict:
    """Wrap a status dict in the standard SDK response envelope."""
    return {
        "status": "ok",
        "response": {"type": "order", "data": {"statuses": [status_inner]}},
    }


def _resting(oid: int) -> dict:
    return _ok_response({"resting": {"oid": oid}})


def _filled(oid: int, total_sz: float, avg_px: float) -> dict:
    return _ok_response({"filled": {"oid": oid, "totalSz": str(total_sz), "avgPx": str(avg_px)}})


def _error(msg: str) -> dict:
    return _ok_response({"error": msg})


# ─────────────────────────────────────────────────────────────────────────────
# MockExchange
# ─────────────────────────────────────────────────────────────────────────────

class MockExchange:
    """
    Stateful, synchronous mock of hyperliquid.exchange.Exchange.

    Intended usage in a replay loop::

        exchange = MockExchange(sz_decimals=3)
        exchange.update_leverage(5, "BTC", False)

        for candle in candles:
            exchange.check_fills(candle)   # fill any resting orders first
            exchange.current_candle = candle
            bot_tick(exchange, candle)     # strategy places / modifies orders

    Attributes
    ----------
    position_szi : float
        Signed net position.  Positive = long, negative = short.
    position_entry_px : float
        Weighted-average entry price of the current position.
    resting_orders : dict[int, dict]
        Live order book keyed by oid.
    fill_log : list[dict]
        Chronological list of every simulated fill.
    leverage : int
        Last leverage set via update_leverage().
    current_candle : dict | None
        Must be set by the replay runner before each tick so that IOC
        orders placed during the tick can check for immediate fills.
    """

    def __init__(self, sz_decimals: int) -> None:
        self.sz_decimals: int = sz_decimals
        self.position_szi: float = 0.0
        self.position_entry_px: float = 0.0
        self.resting_orders: dict[int, dict] = {}
        self._next_oid: int = 1
        self.current_candle: dict | None = None
        self.fill_log: list[dict] = []
        self.leverage: int = 1

    # ── Internal ──────────────────────────────────────────────────────────────

    def _new_oid(self) -> int:
        oid = self._next_oid
        self._next_oid += 1
        return oid

    def _apply_fill(self, is_buy: bool, sz: float, fill_px: float,
                    reduce_only: bool, ts: int | None) -> None:
        """
        Update position_szi and position_entry_px for a fill, then log it.

        Rules
        -----
        • reduce_only=True  → only reduce an existing position (clamp sz to
          the current position size so we never flip in reduce-only mode).
        • reduce_only=False, same direction as position → size up, update
          weighted average entry.
        • reduce_only=False, opposite direction → net position may flip.
        """
        signed_delta = sz if is_buy else -sz

        if reduce_only:
            # Clamp: never exceed existing size, never flip.
            if self.position_szi > 0:
                # Closing a long: is_buy must be False → signed_delta < 0
                actual_delta = max(signed_delta, -self.position_szi)
            elif self.position_szi < 0:
                # Closing a short: is_buy must be True → signed_delta > 0
                actual_delta = min(signed_delta, -self.position_szi)
            else:
                actual_delta = 0.0
        else:
            actual_delta = signed_delta

        old_szi = self.position_szi
        new_szi = old_szi + actual_delta

        if actual_delta == 0.0:
            return  # nothing to apply

        # Weighted average entry update.
        # Only recalculate when adding to (or opening) the position.
        # Reducing never changes entry price — leave it for the remaining size.
        if old_szi == 0.0:
            # Opening fresh
            self.position_entry_px = fill_px
        elif (old_szi > 0 and actual_delta > 0) or (old_szi < 0 and actual_delta < 0):
            # Adding to existing position → weighted average
            self.position_entry_px = (
                (abs(old_szi) * self.position_entry_px + abs(actual_delta) * fill_px)
                / abs(new_szi)
            )
        # else: reducing — entry price unchanged

        self.position_szi = new_szi
        if abs(new_szi) < 1e-12:
            self.position_szi = 0.0
            self.position_entry_px = 0.0

        self.fill_log.append({
            "oid":         None,          # filled in by caller
            "is_buy":      is_buy,
            "sz":          abs(actual_delta),
            "fill_px":     fill_px,
            "reduce_only": reduce_only,
            "ts":          ts,
            "position_szi_after": self.position_szi,
        })

    # ── Public API ────────────────────────────────────────────────────────────

    def order(
        self,
        coin: str,
        is_buy: bool,
        sz: float,
        px: float,
        order_type: dict,
        reduce_only: bool = False,
    ) -> dict:
        """
        Place an order.

        Matches the positional signature of hyperliquid.exchange.Exchange.order().

        Parameters
        ----------
        coin        : trading symbol, stored on the order for reference.
        is_buy      : True = buy/long, False = sell/short.
        sz          : order size in base-asset units (already rounded by caller).
        px          : limit price (ignored for trigger orders — use triggerPx).
        order_type  : {"limit": {"tif": "Gtc"|"Ioc"}} or
                      {"trigger": {"triggerPx": float, "isMarket": bool, "tpsl": "sl"|"tp"}}
        reduce_only : if True the fill never increases position size.

        Returns
        -------
        SDK-shaped dict with "status":"ok" and a statuses list containing
        either a "resting" or "filled" entry.
        """
        oid = self._new_oid()
        ts = (self.current_candle or {}).get("time")

        # ── Determine order class ─────────────────────────────────────────────
        if "limit" in order_type:
            tif = order_type["limit"].get("tif", "Gtc")

            if tif == "Ioc":
                # IOC: attempt immediate fill against current_candle's open.
                # A buy IOC is marketable if px >= candle open (willing to pay
                # at or above the current ask).  A sell IOC is marketable if
                # px <= candle open (willing to sell at or below current bid).
                # If no candle is set, fill unconditionally (e.g. unit tests
                # that don't have a candle context).
                candle = self.current_candle
                marketable = True
                fill_px = px
                if candle is not None:
                    open_ = candle["open"]
                    if is_buy:
                        marketable = px >= open_
                        fill_px = min(px, open_)   # fill at candle open if better
                    else:
                        marketable = px <= open_
                        fill_px = max(px, open_)

                if marketable:
                    self._apply_fill(is_buy, sz, fill_px, reduce_only, ts)
                    self.fill_log[-1]["oid"] = oid
                    return _filled(oid, sz, fill_px)
                else:
                    # IOC that cannot fill is cancelled — return an error status
                    # so the caller can detect the non-fill.
                    return _error(f"IOC order {oid} could not be filled and was cancelled")

            else:  # Gtc limit
                self.resting_orders[oid] = {
                    "coin":       coin,
                    "is_buy":     is_buy,
                    "sz":         sz,
                    "px":         px,
                    "order_type": order_type,
                    "reduce_only": reduce_only,
                    "kind":       "limit",
                }
                return _resting(oid)

        elif "trigger" in order_type:
            # Stop-market (and TP-trigger) orders.
            trigger = order_type["trigger"]
            trigger_px = float(trigger["triggerPx"])
            self.resting_orders[oid] = {
                "coin":       coin,
                "is_buy":     is_buy,
                "sz":         sz,
                "px":         trigger_px,   # px field == triggerPx for triggers
                "order_type": order_type,
                "reduce_only": reduce_only,
                "kind":       "trigger",
                "trigger_px": trigger_px,
            }
            return _resting(oid)

        else:
            return _error(f"Unrecognised order_type: {order_type}")

    def cancel(self, coin: str, oid: int) -> dict:
        """
        Cancel a resting order by oid.

        Returns {"status": "ok"} regardless of whether the oid existed —
        mirroring the real exchange's idempotent cancel behaviour.
        """
        self.resting_orders.pop(oid, None)
        return {"status": "ok"}

    def modify_order(
        self,
        oid: int,
        coin: str,
        is_buy: bool,
        sz: float,
        px: float,
        order_type: dict,
        reduce_only: bool,
    ) -> dict:
        """
        Modify a resting order in place.

        If the oid exists in resting_orders the order's fields are updated
        and the method returns a "resting" response.

        If the oid does NOT exist (already filled or cancelled) the method
        returns an error status shaped like the real SDK's rejection so that
        the caller's existing fallback-to-place-new-order logic in
        TrendMagicBot._modify_or_replace_sl() triggers naturally.
        """
        if oid not in self.resting_orders:
            return _error("Order was never placed or already filled")

        order = self.resting_orders[oid]
        order["is_buy"]     = is_buy
        order["sz"]         = sz
        order["px"]         = px
        order["order_type"] = order_type
        order["reduce_only"] = reduce_only

        # For trigger orders also update the cached trigger_px.
        if "trigger" in order_type:
            order["trigger_px"] = float(order_type["trigger"]["triggerPx"])
            order["px"]         = order["trigger_px"]
            order["kind"]       = "trigger"
        else:
            order["kind"] = "limit"

        return _resting(oid)

    def update_leverage(self, leverage: int, coin: str, is_cross: bool) -> dict:
        """
        Record the leverage setting.  No-op beyond storing the value.
        Returns {"status": "ok"} as the real SDK does on success.
        """
        self.leverage = leverage
        return {"status": "ok"}

    def check_fills(self, candle: dict) -> None:
        """
        Scan all resting orders and fill those whose price level was touched
        by this candle.  Called by the replay runner once per candle, BEFORE
        strategy tick logic runs.

        Fill rules
        ----------
        GTC limit buy  : fills at px if candle.low  <= px <= candle.high
        GTC limit sell : fills at px if candle.low  <= px <= candle.high
        Trigger buy    : fills at triggerPx if candle.high >= triggerPx
                         (stop-buy / TP-sell-short: price rose to trigger)
        Trigger sell   : fills at triggerPx if candle.low  <= triggerPx
                         (stop-sell / TP-buy-long: price fell to trigger)

        Limitation: all qualifying orders in the same candle are filled in
        arbitrary dict-iteration order.  The replay runner should enforce any
        priority it needs (e.g. SL before TP) by calling check_fills for
        each order type separately if required.
        """
        self.current_candle = candle
        low   = candle["low"]
        high  = candle["high"]
        ts    = candle.get("time")

        filled_oids: list[int] = []

        for oid, order in list(self.resting_orders.items()):
            kind = order["kind"]

            if kind == "limit":
                px = order["px"]
                # Both buy and sell limits fill when price trades through them.
                if low <= px <= high:
                    filled_oids.append(oid)
                    self._apply_fill(
                        order["is_buy"], order["sz"], px,
                        order["reduce_only"], ts,
                    )
                    self.fill_log[-1]["oid"] = oid

            elif kind == "trigger":
                trigger_px = order["trigger_px"]
                tpsl_kind  = order["order_type"].get("trigger", {}).get("tpsl", "sl")
                is_tp      = tpsl_kind == "tp"

                # SL triggers fire when price moves AGAINST the position:
                #   sell SL (long): fires when price falls  → low  <= trigger_px
                #   buy  SL (short): fires when price rises  → high >= trigger_px
                #
                # TP triggers fire when price moves IN FAVOUR of the position:
                #   sell TP (long): fires when price rises  → high >= trigger_px
                #   buy  TP (short): fires when price falls  → low  <= trigger_px

                if is_tp:
                    fired = (not order["is_buy"] and high >= trigger_px) or \
                            (    order["is_buy"] and low  <= trigger_px)
                else:
                    fired = (    order["is_buy"] and high >= trigger_px) or \
                            (not order["is_buy"] and low  <= trigger_px)

                if fired:
                    filled_oids.append(oid)
                    self._apply_fill(
                        order["is_buy"], order["sz"], trigger_px,
                        order["reduce_only"], ts,
                    )
                    self.fill_log[-1]["oid"] = oid

        for oid in filled_oids:
            self.resting_orders.pop(oid, None)
