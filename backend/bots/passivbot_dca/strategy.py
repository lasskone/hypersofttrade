"""
Passivbot-style DCA Grid Bot for Hyperliquid.

A clean Python re-implementation of Passivbot's core DCA grid strategy logic.
This is NOT a wrapper around Passivbot — it uses this project's Hyperliquid
service layer and asyncio architecture directly.

Core strategy:
- Market-making DCA grid: places GTC limit orders in a grid below (long) or
  above (short) current price.  As price moves against the position, deeper
  grid orders fill, averaging down (long) or up (short) the entry price.
- Grid spacing widens as wallet exposure grows, slowing capital deployment.
- Take-profit: GTC limit orders linearly spaced between markup_start and
  markup_end above (long) or below (short) the average entry price.
- Unstucking: if the position is deeply negative, closes a small % at market
  provided account loss stays within unstuck_loss_allowance_pct of peak.
- Optional trailing entries: waits for price to move threshold_pct, then
  retrace retracement_pct before placing the next DCA order.

Tick rate: 60 seconds (price-level logic, not candle-based).
"""
from __future__ import annotations

import asyncio
import math
from typing import Optional

import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"
MIN_NOTIONAL = 10.0   # Hyperliquid minimum order notional ($10)


def _round_price(price: float) -> float:
    if price >= 1000:
        return round(price)
    elif price >= 10:
        return round(price, 1)
    else:
        return round(price, 2)


def _round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor


class PassivbotDCABot:
    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        leverage: int,
        # Strategy parameters
        direction: str = "long",
        wallet_exposure_limit: float = 0.1,
        entry_initial_qty_pct: float = 0.01,
        double_down_factor: float = 0.9,
        entry_grid_spacing_pct: float = 0.003,
        entry_grid_spacing_we_weight: float = 0.5,
        close_grid_markup_start: float = 0.001,
        close_grid_markup_end: float = 0.003,
        close_grid_qty_pct: float = 0.05,
        trailing_enabled: bool = False,
        trailing_threshold_pct: float = 0.02,
        trailing_retracement_pct: float = 0.005,
        unstuck_enabled: bool = True,
        unstuck_loss_allowance_pct: float = 0.02,
        unstuck_close_pct: float = 0.02,
        sz_decimals: int = 4,
        dex: Optional[str] = None,
        log_callback=None,
    ):
        self.private_key = private_key
        self.master_address = master_address
        self.coin = coin
        self.allocated_usdc = allocated_usdc
        self.leverage = leverage
        self.direction = direction          # "long", "short", or "both"
        self.wallet_exposure_limit = wallet_exposure_limit
        self.entry_initial_qty_pct = entry_initial_qty_pct
        self.double_down_factor = double_down_factor
        self.entry_grid_spacing_pct = entry_grid_spacing_pct
        self.entry_grid_spacing_we_weight = entry_grid_spacing_we_weight
        self.close_grid_markup_start = close_grid_markup_start
        self.close_grid_markup_end = close_grid_markup_end
        self.close_grid_qty_pct = max(close_grid_qty_pct, 0.01)   # floor at 1% to avoid absurd TP counts
        self.trailing_enabled = trailing_enabled
        self.trailing_threshold_pct = trailing_threshold_pct
        self.trailing_retracement_pct = trailing_retracement_pct
        self.unstuck_enabled = unstuck_enabled
        self.unstuck_loss_allowance_pct = unstuck_loss_allowance_pct
        self.unstuck_close_pct = unstuck_close_pct
        self.sz_decimals = sz_decimals
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)

        self._exchange = None
        self._running = False
        self.peak_balance: float = 0.0

        # Tracks which open orders belong to us and their role.
        # Keys are integer order IDs; values are one of:
        #   "long_entry", "short_entry", "long_tp", "short_tp"
        self._order_tags: dict[int, str] = {}

        # Trailing entry state per direction
        self._trailing: dict[str, dict] = {
            "long":  {"armed": False, "extreme": 0.0},
            "short": {"armed": False, "extreme": float("inf")},
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Exchange initialisation
    # ──────────────────────────────────────────────────────────────────────────

    def _init_exchange(self) -> None:
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants
        account = eth_account.Account.from_key(self.private_key)
        dex_list = [self.dex] if self.dex else []
        self._exchange = Exchange(
            account,
            constants.MAINNET_API_URL,
            account_address=self.master_address,
            perp_dexs=dex_list if dex_list else None,
        )

    async def _set_leverage(self) -> None:
        # Always call update_leverage — including for 1x — so the exchange is
        # explicitly set to the configured value and never inherits stale leverage
        # from a previous bot session or manual trade.
        self.log("info", f"Setting leverage to {self.leverage}x for {self.coin} (from config)")
        try:
            result = await asyncio.to_thread(
                self._exchange.update_leverage, self.leverage, self.coin, False
            )
            status = (result or {}).get("status", "")
            if status == "ok":
                self.log("info", f"Leverage set to {self.leverage}x for {self.coin}")
            else:
                self.log("warning", f"Leverage update unexpected response: {result}")
        except Exception as e:
            self.log("warning", f"Could not set leverage: {e}")

    # ──────────────────────────────────────────────────────────────────────────
    # Market data helpers
    # ──────────────────────────────────────────────────────────────────────────

    async def _get_mark_price(self) -> Optional[float]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"})
                mids = resp.json()
            val = mids.get(self.coin)
            return float(val) if val else None
        except Exception as e:
            self.log("warning", f"Failed to fetch mark price: {e}")
            return None

    async def _get_clearinghouse_state(self) -> dict:
        try:
            payload: dict = {"type": "clearinghouseState", "user": self.master_address}
            if self.dex:
                payload["dex"] = self.dex
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json=payload)
                return resp.json()
        except Exception as e:
            self.log("warning", f"Failed to fetch clearinghouse state: {e}")
            return {}

    async def _get_open_orders(self) -> list:
        """Return open orders for self.coin only."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "openOrders", "user": self.master_address},
                )
                all_orders = resp.json()
            return [o for o in all_orders if isinstance(o, dict) and o.get("coin") == self.coin]
        except Exception as e:
            self.log("warning", f"Failed to fetch open orders: {e}")
            return []

    # ──────────────────────────────────────────────────────────────────────────
    # State extraction helpers
    # ──────────────────────────────────────────────────────────────────────────

    def _extract_position(self, state: dict, direction: str) -> Optional[dict]:
        """Return the position dict for self.coin in the given direction, or None."""
        for ap in (state.get("assetPositions") or []):
            if not isinstance(ap, dict):
                continue
            pos = ap.get("position") or {}
            if pos.get("coin") != self.coin:
                continue
            szi = float(pos.get("szi", 0) or 0)
            if direction == "long" and szi > 0:
                return pos
            if direction == "short" and szi < 0:
                return pos
        return None

    def _extract_balance(self, state: dict) -> float:
        ms = state.get("marginSummary") or {}
        return float(ms.get("accountValue", 0) or 0)

    # ──────────────────────────────────────────────────────────────────────────
    # Grid computation
    # ──────────────────────────────────────────────────────────────────────────

    def _compute_entry_grid(
        self, anchor: float, pos_size: float, is_long: bool
    ) -> list[dict]:
        """
        Compute the full intended entry grid.

        anchor   — current price (no position) or avg_entry (position exists)
        pos_size — current absolute position size in coins
        is_long  — True for long (buy orders below anchor), False for short

        Returns list of {price, size} dicts, ordered closest → deepest,
        stopping when the next level would exceed wallet_exposure_limit.
        Cap at 20 levels for safety.
        """
        if anchor <= 0:
            return []

        max_notional = self.allocated_usdc * self.wallet_exposure_limit * self.leverage
        current_notional = pos_size * anchor

        if current_notional >= max_notional:
            return []   # Already at or above exposure limit

        # Initial order size: entry_initial_qty_pct of allocation
        initial_size = _round_size(
            self.entry_initial_qty_pct * self.allocated_usdc * self.leverage / anchor,
            self.sz_decimals,
        )

        levels: list[dict] = []
        # Tracks hypothetical cumulative position as each level fills
        cum_pos = pos_size

        for _ in range(20):
            # Spacing widens as hypothetical wallet exposure grows
            hypo_notional = current_notional + sum(l["size"] * l["price"] for l in levels)
            current_we = hypo_notional / max(self.allocated_usdc * self.leverage, 1)
            spacing = self.entry_grid_spacing_pct * (1 + current_we * self.entry_grid_spacing_we_weight)

            if not levels:
                # First level: just below/above anchor
                lp = anchor * (1 - spacing) if is_long else anchor * (1 + spacing)
                ls = initial_size if cum_pos == 0 else _round_size(cum_pos * self.double_down_factor, self.sz_decimals)
            else:
                prev_price = levels[-1]["price"]
                lp = prev_price * (1 - spacing) if is_long else prev_price * (1 + spacing)
                ls = _round_size(cum_pos * self.double_down_factor, self.sz_decimals)

            lp = _round_price(lp)
            ls = _round_size(ls, self.sz_decimals)

            if ls <= 0:
                break

            level_notional = ls * lp
            if level_notional < MIN_NOTIONAL:
                self.log("warning", f"Entry grid: level ${lp:.4f} skipped — notional ${level_notional:.2f} < min ${MIN_NOTIONAL}")
                break

            remaining = max_notional - hypo_notional
            if remaining <= 0:
                break

            if level_notional > remaining:
                # Partial level to fill remaining capacity exactly
                partial = _round_size(remaining / lp, self.sz_decimals)
                if partial * lp >= MIN_NOTIONAL:
                    levels.append({"price": lp, "size": partial})
                break

            levels.append({"price": lp, "size": ls})
            cum_pos += ls

        return levels

    def _compute_tp_grid(
        self, avg_entry: float, pos_size: float, is_long: bool
    ) -> list[dict]:
        """
        Compute take-profit order levels.

        Returns GTC limit orders on the close side (reduce_only),
        linearly spaced between markup_start and markup_end.
        """
        if pos_size <= 0 or avg_entry <= 0:
            return []

        n_tp = min(20, max(1, int(round(1.0 / self.close_grid_qty_pct))))
        tp_qty = _round_size(pos_size * self.close_grid_qty_pct, self.sz_decimals)

        if tp_qty <= 0:
            return []

        levels: list[dict] = []
        for k in range(n_tp):
            t = k / (n_tp - 1) if n_tp > 1 else 0.0
            markup = self.close_grid_markup_start + (
                self.close_grid_markup_end - self.close_grid_markup_start
            ) * t
            tp_price = _round_price(
                avg_entry * (1 + markup) if is_long else avg_entry * (1 - markup)
            )
            if tp_qty * tp_price < MIN_NOTIONAL:
                continue
            levels.append({"price": tp_price, "size": tp_qty})

        return levels

    # ──────────────────────────────────────────────────────────────────────────
    # Order placement / cancellation
    # ──────────────────────────────────────────────────────────────────────────

    async def _place_limit_order(
        self,
        is_buy: bool,
        size: float,
        price: float,
        reduce_only: bool = False,
    ) -> Optional[int]:
        """Place a GTC limit order and return its order ID (or None on failure)."""
        size = _round_size(size, self.sz_decimals)
        price = _round_price(price)
        if size <= 0:
            return None
        if size * price < MIN_NOTIONAL:
            self.log("warning", f"Order skipped: notional ${size * price:.2f} < ${MIN_NOTIONAL}")
            return None
        try:
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
                reduce_only,
            )
            statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
            status = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Order rejected: {status['error']}")
                return None
            oid = (
                (status.get("resting") or {}).get("oid")
                or (status.get("filled") or {}).get("oid")
            )
            action = "reduce_only" if reduce_only else "entry"
            self.log("info", f"Placed {'BUY' if is_buy else 'SELL'} {size} {self.coin} @ ${price} ({action}, oid={oid})")
            return oid
        except Exception as e:
            self.log("error", f"Order placement failed: {e}")
            return None

    async def _cancel_order(self, oid: int) -> None:
        try:
            result = await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
            self.log("info", f"Cancelled order {oid} — {result}")
            self._order_tags.pop(oid, None)
        except Exception as e:
            self.log("warning", f"Cancel order {oid} failed: {e}")

    async def _cancel_orders_by_tag(self, tag: str, live_oids: set) -> None:
        """Cancel all our tracked orders with the given tag that are still open."""
        to_cancel = [oid for oid, t in list(self._order_tags.items()) if t == tag and oid in live_oids]
        for oid in to_cancel:
            await self._cancel_order(oid)

    async def _cancel_all_coin_orders(self) -> None:
        """Cancel ALL open orders for self.coin — used for a clean start/stop."""
        try:
            orders = await self._get_open_orders()
            for o in orders:
                oid = int(o.get("oid", 0))
                if oid:
                    await self._cancel_order(oid)
            if orders:
                self.log("info", f"Cancelled {len(orders)} pre-existing orders for {self.coin}")
        except Exception as e:
            self.log("warning", f"Could not cancel pre-existing orders: {e}")

    # ──────────────────────────────────────────────────────────────────────────
    # Drift check
    # ──────────────────────────────────────────────────────────────────────────

    def _orders_drift_too_much(
        self,
        existing_orders: list[dict],
        target_levels: list[dict],
        is_buy: bool,
    ) -> bool:
        """
        Return True if existing orders have drifted > 10% from target prices,
        or if the count doesn't match (cancel-and-replace needed).
        Only call this when existing_orders is non-empty.
        """
        if len(existing_orders) != len(target_levels):
            return True

        existing_prices = sorted(
            [float(o.get("limitPx", 0)) for o in existing_orders],
            reverse=is_buy,   # buy grid: highest first (closest); sell grid: lowest first
        )
        target_prices = [lvl["price"] for lvl in target_levels]

        for ep, tp in zip(existing_prices, target_prices):
            if tp <= 0:
                continue
            if abs(ep - tp) / tp > 0.10:
                return True

        return False

    # ──────────────────────────────────────────────────────────────────────────
    # Per-direction grid management
    # ──────────────────────────────────────────────────────────────────────────

    async def _manage_direction(
        self,
        direction: str,
        price: float,
        state: dict,
        all_open_orders: list[dict],
    ) -> None:
        """Manage entry grid and TP orders for one direction (long or short)."""
        is_long = direction == "long"
        entry_tag = f"{direction}_entry"
        tp_tag = f"{direction}_tp"

        position = self._extract_position(state, direction)
        pos_size = abs(float((position or {}).get("szi", 0) or 0))
        avg_entry = float((position or {}).get("entryPx", 0) or 0)

        live_oids = {int(o["oid"]) for o in all_open_orders}

        entry_orders = [
            o for o in all_open_orders
            if self._order_tags.get(int(o.get("oid", 0))) == entry_tag
        ]
        tp_orders = [
            o for o in all_open_orders
            if self._order_tags.get(int(o.get("oid", 0))) == tp_tag
        ]

        # ── "both" mode: if the opposite position is open, cancel our entries
        #    and skip placing new ones on this side (Hyperliquid is one-way mode)
        skip_entries = False
        if self.direction == "both":
            opp = "short" if is_long else "long"
            opp_pos = self._extract_position(state, opp)
            if opp_pos and abs(float(opp_pos.get("szi", 0) or 0)) > 0:
                skip_entries = True
                if entry_orders:
                    self.log(
                        "info",
                        f"[{direction}] Opposite {opp} position open — "
                        f"cancelling {len(entry_orders)} {direction} entry orders",
                    )
                    await self._cancel_orders_by_tag(entry_tag, live_oids)
                    entry_orders = []

        # ── ENTRY GRID ─────────────────────────────────────────────────────────
        if not skip_entries:
            if self.trailing_enabled and pos_size > 0:
                await self._manage_trailing_entry(
                    direction, price, pos_size, live_oids, entry_orders, entry_tag
                )
            else:
                # Fixed grid mode — anchor to avg_entry when in position, else current price
                anchor = avg_entry if (pos_size > 0 and avg_entry > 0) else price
                target_entry = self._compute_entry_grid(anchor, pos_size, is_long)

                # Cancel existing if target is empty (hit exposure limit)
                if not target_entry and entry_orders:
                    self.log("info", f"[{direction}] Exposure limit reached — cancelling {len(entry_orders)} entry orders")
                    await self._cancel_orders_by_tag(entry_tag, live_oids)
                    entry_orders = []

                # Cancel and re-place if existing orders have drifted
                elif entry_orders and self._orders_drift_too_much(entry_orders, target_entry, is_long):
                    self.log("info", f"[{direction}] Grid drift detected — cancelling {len(entry_orders)} entry orders")
                    await self._cancel_orders_by_tag(entry_tag, live_oids)
                    entry_orders = []

                # Place grid if empty
                if not entry_orders and target_entry:
                    self.log("info", f"[{direction}] Placing {len(target_entry)} entry grid orders")
                    for level in target_entry:
                        oid = await self._place_limit_order(is_long, level["size"], level["price"])
                        if oid is not None:
                            self._order_tags[oid] = entry_tag

        # ── TP GRID ────────────────────────────────────────────────────────────
        if pos_size > 0 and avg_entry > 0:
            target_tp = self._compute_tp_grid(avg_entry, pos_size, is_long)

            if target_tp:
                if not tp_orders:
                    # No TP orders yet — place them
                    self.log("info", f"[{direction}] Placing {len(target_tp)} TP orders | avg_entry=${avg_entry:.4f}")
                    for level in target_tp:
                        oid = await self._place_limit_order(
                            not is_long, level["size"], level["price"], reduce_only=True
                        )
                        if oid is not None:
                            self._order_tags[oid] = tp_tag
                elif self._orders_drift_too_much(tp_orders, target_tp, not is_long):
                    # TP orders drifted (position size or avg_entry changed) — rebalance
                    self.log("info", f"[{direction}] TP drift detected — rebalancing {len(tp_orders)} TP orders")
                    await self._cancel_orders_by_tag(tp_tag, live_oids)
                    for level in target_tp:
                        oid = await self._place_limit_order(
                            not is_long, level["size"], level["price"], reduce_only=True
                        )
                        if oid is not None:
                            self._order_tags[oid] = tp_tag

        elif pos_size == 0 and tp_orders:
            # Position fully closed — clean up any remaining TP orders
            self.log("info", f"[{direction}] Position closed — cancelling {len(tp_orders)} stale TP orders")
            await self._cancel_orders_by_tag(tp_tag, live_oids)

    async def _manage_trailing_entry(
        self,
        direction: str,
        price: float,
        pos_size: float,
        live_oids: set,
        entry_orders: list[dict],
        entry_tag: str,
    ) -> None:
        """
        Trailing DCA entry logic.

        LONG:  price must drop >= threshold_pct below reference extreme,
               then retrace >= retracement_pct before placing the next order.
        SHORT: price must rise >= threshold_pct above reference extreme,
               then retrace >= retracement_pct.
        """
        is_long = direction == "long"
        ts = self._trailing[direction]

        if entry_orders:
            return  # Already have a pending entry — wait for it to fill

        if not ts["armed"]:
            # Track extremes and arm when threshold is exceeded
            if is_long:
                if ts["extreme"] == 0.0 or price < ts["extreme"]:
                    ts["extreme"] = price
                if ts["extreme"] > 0 and price <= ts["extreme"] * (1 - self.trailing_threshold_pct):
                    ts["armed"] = True
                    self.log("info", f"[{direction}] Trailing armed — extreme=${ts['extreme']:.4f}")
            else:
                if ts["extreme"] == float("inf") or price > ts["extreme"]:
                    ts["extreme"] = price
                if ts["extreme"] < float("inf") and price >= ts["extreme"] * (1 + self.trailing_threshold_pct):
                    ts["armed"] = True
                    self.log("info", f"[{direction}] Trailing armed — extreme=${ts['extreme']:.4f}")
        else:
            # Armed — place DCA order when price retraces enough
            retraced = (
                price >= ts["extreme"] * (1 + self.trailing_retracement_pct) if is_long
                else price <= ts["extreme"] * (1 - self.trailing_retracement_pct)
            )
            if not retraced:
                return

            max_notional = self.allocated_usdc * self.wallet_exposure_limit * self.leverage
            current_notional = pos_size * price
            if current_notional >= max_notional:
                self.log("info", f"[{direction}] Trailing: at exposure limit, skipping DCA")
                ts["armed"] = False
                return

            dca_size = _round_size(pos_size * self.double_down_factor, self.sz_decimals)
            if dca_size * price < MIN_NOTIONAL:
                self.log("warning", f"[{direction}] Trailing: DCA size too small (${dca_size * price:.2f}), skipping")
                ts["armed"] = False
                return

            oid = await self._place_limit_order(is_long, dca_size, _round_price(price))
            if oid is not None:
                self._order_tags[oid] = entry_tag
                self.log("info", f"[{direction}] Trailing: placed DCA oid={oid} size={dca_size} @ ${price:.4f}")

            # Reset trailing state for next DCA cycle
            ts["armed"] = False
            ts["extreme"] = price

    # ──────────────────────────────────────────────────────────────────────────
    # Unstucking
    # ──────────────────────────────────────────────────────────────────────────

    async def _check_unstuck(self, price: float, state: dict, balance: float) -> None:
        """
        If a position is deeply stuck (large negative PnL) AND the account balance
        is still within the loss allowance above peak: close a small % at market.
        """
        if not self.unstuck_enabled or self.peak_balance <= 0:
            return

        loss_threshold = self.peak_balance * (1 - self.unstuck_loss_allowance_pct)
        if balance < loss_threshold:
            self.log(
                "info",
                f"Unstuck skipped: balance ${balance:.2f} < threshold ${loss_threshold:.2f} "
                f"(peak=${self.peak_balance:.2f})",
            )
            return

        directions = ["long", "short"] if self.direction == "both" else [self.direction]
        for direction in directions:
            is_long = direction == "long"
            position = self._extract_position(state, direction)
            if not position:
                continue

            pos_size = abs(float(position.get("szi", 0) or 0))
            avg_entry = float(position.get("entryPx", 0) or 0)
            if pos_size == 0 or avg_entry == 0:
                continue

            pnl_pct = (
                (price - avg_entry) / avg_entry if is_long
                else (avg_entry - price) / avg_entry
            )

            # "Stuck" if PnL is worse than 10× the grid spacing
            stuck_threshold = -(self.entry_grid_spacing_pct * 10)
            if pnl_pct > stuck_threshold:
                continue

            close_size = _round_size(pos_size * self.unstuck_close_pct, self.sz_decimals)
            if close_size <= 0 or close_size * price < MIN_NOTIONAL:
                continue

            is_close_buy = not is_long
            slippage = 0.01
            close_price = _round_price(
                price * (1 + slippage) if is_close_buy else price * (1 - slippage)
            )

            self.log(
                "warning",
                f"[{direction}] Unstucking: PnL={pnl_pct * 100:.2f}% — "
                f"closing {close_size} {self.coin} at market",
            )
            try:
                result = await asyncio.to_thread(
                    self._exchange.order,
                    self.coin, is_close_buy, close_size, close_price,
                    {"limit": {"tif": "Ioc"}},
                    True,   # reduce_only
                )
                statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
                first = statuses[0] if statuses else {}
                if "error" in first:
                    self.log("error", f"Unstuck order rejected: {first['error']}")
                else:
                    self.log("info", f"Unstuck order placed: {close_size} {self.coin}")
            except Exception as e:
                self.log("error", f"Unstuck order failed: {e}")

    # ──────────────────────────────────────────────────────────────────────────
    # Cleanup on bot stop
    # ──────────────────────────────────────────────────────────────────────────

    async def _close_all_on_cancel(self) -> None:
        """Cancel all our open orders when the bot is stopped."""
        try:
            orders = await self._get_open_orders()
            live_oids = {int(o["oid"]) for o in orders}
            for oid in list(self._order_tags.keys()):
                if oid in live_oids:
                    await self._cancel_order(oid)
        except Exception as e:
            self.log("error", f"Cleanup on cancel failed: {e}")

    # ──────────────────────────────────────────────────────────────────────────
    # Main tick
    # ──────────────────────────────────────────────────────────────────────────

    async def _tick(self) -> None:
        price = await self._get_mark_price()
        if price is None:
            self.log("warning", "Could not fetch mark price — skipping tick")
            return

        state = await self._get_clearinghouse_state()
        if not state:
            self.log("warning", "Could not fetch clearinghouse state — skipping tick")
            return

        all_open_orders = await self._get_open_orders()

        # Update peak balance
        balance = self._extract_balance(state)
        if balance > self.peak_balance:
            self.peak_balance = balance

        # Prune _order_tags: remove orders that no longer exist on the exchange
        live_oids = {int(o["oid"]) for o in all_open_orders}
        stale = [oid for oid in list(self._order_tags) if oid not in live_oids]
        for oid in stale:
            self._order_tags.pop(oid, None)

        # Aggregate stats for tick log
        total_pos_size = 0.0
        for d in ["long", "short"]:
            pos = self._extract_position(state, d)
            if pos:
                total_pos_size += abs(float(pos.get("szi", 0) or 0))

        wallet_exposure = (total_pos_size * price) / max(self.allocated_usdc * self.leverage, 1)
        grid_orders_count = sum(1 for oid, tag in self._order_tags.items() if tag.endswith("_entry") and oid in live_oids)
        tp_orders_count = sum(1 for oid, tag in self._order_tags.items() if tag.endswith("_tp") and oid in live_oids)

        self.log(
            "info",
            f"Tick | Price=${price:.4f} | PosSize={total_pos_size:.6f} | "
            f"WE={wallet_exposure:.3f}/{self.wallet_exposure_limit} | "
            f"GridOrders={grid_orders_count} | TPOrders={tp_orders_count} | "
            f"Balance=${balance:.2f}",
        )

        # Manage each configured direction
        directions = ["long", "short"] if self.direction == "both" else [self.direction]
        for direction in directions:
            await self._manage_direction(direction, price, state, all_open_orders)

        # Unstucking check
        if self.unstuck_enabled:
            await self._check_unstuck(price, state, balance)

    # ──────────────────────────────────────────────────────────────────────────
    # Main loop
    # ──────────────────────────────────────────────────────────────────────────

    async def run(self) -> None:
        self._running = True
        self._init_exchange()
        await self._set_leverage()

        # Warn if initial order notional would be below Hyperliquid minimum
        initial_capital = self.entry_initial_qty_pct * self.allocated_usdc * self.leverage
        if initial_capital < MIN_NOTIONAL:
            self.log(
                "warning",
                f"Initial order capital ${initial_capital:.2f} is below Hyperliquid "
                f"minimum notional ${MIN_NOTIONAL:.2f}. "
                f"Increase allocated_usdc, leverage, or entry_initial_qty_pct — "
                f"the bot will keep trying but orders may be skipped.",
            )

        # Clean start: cancel any pre-existing orders for this coin to avoid duplicates
        self.log("info", f"Cancelling pre-existing orders for {self.coin} (clean start)")
        await self._cancel_all_coin_orders()

        self.log(
            "info",
            f"Passivbot DCA Grid Bot started — {self.coin} | "
            f"Direction={self.direction} | WEL={self.wallet_exposure_limit} | "
            f"Spacing={self.entry_grid_spacing_pct * 100:.2f}% | "
            f"DDF={self.double_down_factor} | "
            f"Allocation=${self.allocated_usdc} | Leverage={self.leverage}x | "
            f"Trailing={'on' if self.trailing_enabled else 'off'} | "
            f"Unstuck={'on' if self.unstuck_enabled else 'off'}",
        )

        while self._running:
            try:
                await self._tick()
            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cancelling open orders...")
                await self._close_all_on_cancel()
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            await asyncio.sleep(60)

        self._running = False
        self.log("info", "Passivbot DCA Grid Bot stopped.")
