"""
Envelope DCA Bot — live trading strategy for Hyperliquid.
Based on CryptoRobotFr's envelope strategy converted from Pine Script / Jupyter.

Logic:
- Computes SMA(close, ma_base_window) shifted by 1 (no lookahead)
- Places limit buy orders at ma_base * (1 - envelope_pct) for each level
- Closes all longs when high >= ma_base (limit sell at ma_base)
- Supports up to 7 envelope levels (DCA)
- Allocates 1/N of wallet per level
"""
from __future__ import annotations
import asyncio
import math
import os
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"
MAKER_FEE = 0.0002
TAKER_FEE = 0.0007


def compute_sma(closes: list[float], period: int) -> list[Optional[float]]:
    """SMA shifted by 1 — uses closes[i-period:i], not including close[i]."""
    result: list[Optional[float]] = []
    for i in range(len(closes)):
        if i < period:
            result.append(None)
        else:
            result.append(sum(closes[i - period:i]) / period)
    return result


def round_price(price: float) -> float:
    """Round price to Hyperliquid tick size based on magnitude."""
    if price >= 1000:
        return round(price)
    elif price >= 10:
        return round(price, 1)
    else:
        return round(price, 2)


def round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor


class EnvelopeBot:
    """
    Live Envelope DCA bot for Hyperliquid.
    Runs as an asyncio coroutine — call await bot.run() to start.
    """

    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        ma_period: int,
        envelopes: list[float],  # e.g. [0.07, 0.10, 0.15]
        stop_loss_pct: float,
        sz_decimals: int,
        leverage: int = 1,
        interval: str = "4h",
        dex: Optional[str] = None,
        log_callback=None,
    ):
        self.private_key = private_key
        self.master_address = master_address
        self.coin = coin
        self.allocated_usdc = allocated_usdc
        self.ma_period = ma_period
        self.envelopes = [e for e in envelopes if e > 0]
        self.stop_loss_pct = stop_loss_pct
        self.sz_decimals = sz_decimals
        self.leverage = leverage
        self.interval = interval
        interval_ms_map = {
            "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
            "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
        }
        self._interval_ms = interval_ms_map.get(interval, 14_400_000)
        self._sleep_seconds = self._interval_ms // 1000
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)
        self._running = False
        # _positions and _open_order_ids are kept as cache only.
        # All strategy logic reads from real Hyperliquid API state fetched each tick.
        self._positions: list[dict] = []
        self._open_order_ids: set[int] = set()
        self._candles: list[dict] = []
        self._exchange = None
        self._last_ma: float = 0.0           # MA value when buy orders were last placed/refreshed
        self._waiting_close: bool = False    # True after a sell is placed; reset when position confirms closed
        self._close_order_id: Optional[int] = None  # OID of the resting sell order we are monitoring

    def _init_exchange(self):
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

    async def _set_leverage(self):
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
                self.log("warning", f"Leverage update unexpected response for {self.coin}: {result}")
        except Exception as e:
            self.log("warning", f"Failed to set leverage: {e}")

    async def _fetch_candles(self, limit: int = 200) -> list[dict]:
        end_time = int(time.time() * 1000)
        start_time = end_time - self._interval_ms * limit
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(INFO_ENDPOINT, json={
                "type": "candleSnapshot",
                "req": {"coin": self.coin, "interval": self.interval, "startTime": start_time, "endTime": end_time}
            })
            candles = resp.json()
        return [{"time": int(c["t"]) // 1000, "open": float(c["o"]), "high": float(c["h"]),
                 "low": float(c["l"]), "close": float(c["c"]), "volume": float(c["v"])} for c in candles]

    async def _fetch_real_position(self) -> dict:
        """
        Fetch real open position for self.coin from Hyperliquid clearinghouseState.
        Returns {"szi": float, "entry_px": float, "unrealized_pnl": float}.
        szi == 0.0 means no open position.
        """
        payload: dict = {"type": "clearinghouseState", "user": self.master_address}
        if self.dex:
            payload["dex"] = self.dex
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    INFO_ENDPOINT, json=payload,
                    headers={"Content-Type": "application/json"},
                )
                state = resp.json()
            # The API may return the coin as "XYZ100" (without DEX prefix) even for HIP-3 coins.
            coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
            for ap in (state.get("assetPositions") or []):
                if not isinstance(ap, dict):
                    continue
                pos = ap.get("position") or {}
                if not isinstance(pos, dict):
                    continue
                api_coin = pos.get("coin", "")
                if api_coin not in (self.coin, coin_short):
                    continue
                szi = float(pos.get("szi", "0") or "0")
                if szi == 0.0:
                    continue
                return {
                    "szi": szi,
                    "entry_px": float(pos.get("entryPx", "0") or "0"),
                    "unrealized_pnl": float(pos.get("unrealizedPnl", "0") or "0"),
                }
        except Exception as e:
            self.log("warning", f"Failed to fetch real position: {e}")
        return {"szi": 0.0, "entry_px": 0.0, "unrealized_pnl": 0.0}

    async def _fetch_real_open_orders(self) -> tuple[list[dict], list[dict]]:
        """
        Fetch all resting non-trigger orders for self.coin from frontendOpenOrders.
        Returns (resting_buys, resting_sells) — two separate lists.
        Each entry: {"price": float, "size": float, "oid": int}.
        TP/SL trigger orders are excluded from both lists.
        """
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address},
                    headers={"Content-Type": "application/json"},
                )
                orders = resp.json()
            if not isinstance(orders, list):
                return [], []
            coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
            buys: list[dict] = []
            sells: list[dict] = []
            for o in orders:
                if not isinstance(o, dict):
                    continue
                api_coin = o.get("coin", "")
                if api_coin not in (self.coin, coin_short):
                    continue
                if o.get("isTrigger"):
                    continue  # skip TP/SL trigger orders
                limit_px_raw = o.get("limitPx")
                if limit_px_raw is None:
                    continue
                entry = {
                    "price": float(limit_px_raw),
                    "size": float(o.get("sz", "0") or "0"),
                    "oid": o.get("oid"),
                }
                if (o.get("side", "") or "").upper() == "B":
                    buys.append(entry)
                else:
                    sells.append(entry)
            return buys, sells
        except Exception as e:
            try:
                self.log("warning", f"Failed to fetch real open orders: {e}")
            except Exception:
                pass
            return [], []

    async def _place_limit_order(self, is_buy: bool, size: float, price: float) -> Optional[int]:
        """Place a limit order and return order_id."""
        try:
            price = round_price(price)
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                self.log("warning", f"Size too small after rounding: {size}")
                return None
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
            )
            statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
            status = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Order rejected: {status['error']}")
                return None
            oid = status.get("resting", {}).get("oid") or status.get("filled", {}).get("oid")
            self.log("info", f"{'Buy' if is_buy else 'Sell'} order placed: {size} {self.coin} @ ${price} (oid={oid})")
            return oid
        except Exception as e:
            self.log("error", f"Order placement failed: {e}")
            return None

    async def _cancel_all_orders(self):
        """Cancel all open orders for this coin."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "openOrders", "user": self.master_address})
                orders = resp.json()
            coin_orders = [o for o in orders if o.get("coin") == self.coin]
            for order in coin_orders:
                oid = order.get("oid")
                if oid:
                    await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
                    self.log("info", f"Cancelled order {oid}")
        except Exception as e:
            self.log("warning", f"Cancel all orders failed: {e}")

    async def _close_all_positions(self, real_szi: float, mark_price: float):
        """
        Close open position using real position size from Hyperliquid.
        real_szi must come from _fetch_real_position(), never from self._positions.
        """
        total_size = round_size(abs(real_szi), self.sz_decimals)
        if total_size <= 0:
            self.log("warning", "Close requested but real_szi rounds to 0 — nothing to close")
            return
        slippage = 0.05
        limit_price = round_price(mark_price * (1 - slippage))
        try:
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, False, total_size, limit_price,
                {"limit": {"tif": "Ioc"}},
            )
            self.log("info", f"Closed position: {total_size} {self.coin} @ ~${limit_price} (real_szi={real_szi})")
        except Exception as e:
            self.log("error", f"Close positions failed: {e}")

    async def run(self):
        """Main bot loop — runs indefinitely until cancelled."""
        self._running = True
        self._init_exchange()
        await self._set_leverage()
        self.log("info", f"Envelope Bot started — {self.coin} | {self.interval} | MA={self.ma_period} | Envelopes={self.envelopes} | Allocation=${self.allocated_usdc} | Leverage={self.leverage}x")

        per_level = self.allocated_usdc / len(self.envelopes)

        while self._running:
            try:
                # 0. Fetch real state from Hyperliquid — source of truth for every tick.
                #    This makes the bot restart-safe: no stale in-memory state is trusted.
                _state = await asyncio.gather(
                    self._fetch_real_position(),
                    self._fetch_real_open_orders(),
                )
                real_pos = _state[0]
                _orders = _state[1]
                if isinstance(_orders, (list, tuple)) and len(_orders) == 2:
                    resting_buys  = _orders[0] if isinstance(_orders[0], list) else []
                    resting_sells = _orders[1] if isinstance(_orders[1], list) else []
                else:
                    resting_buys, resting_sells = [], []
                real_szi        = real_pos["szi"]
                real_entry_px   = real_pos["entry_px"]
                real_upnl       = real_pos["unrealized_pnl"]
                has_position    = real_szi != 0.0

                self.log("info", f"Real state — szi={real_szi} entry_px={real_entry_px} upnl={real_upnl:.2f} resting_buys={len(resting_buys)} resting_sells={len(resting_sells)}")

                # 1. Fetch latest candles
                candles = await self._fetch_candles(limit=self.ma_period + 10)
                if len(candles) < self.ma_period + 2:
                    self.log("warning", "Not enough candles, waiting...")
                    await asyncio.sleep(300)
                    continue

                closes = [c["close"] for c in candles]
                sma_values = compute_sma(closes, self.ma_period)

                # Current candle (last complete)
                last = candles[-2]  # -2 = last CLOSED candle (not current forming)
                current_sma = sma_values[-2]
                current_price = candles[-1]["close"]  # latest price

                if current_sma is None:
                    await asyncio.sleep(300)
                    continue

                ma_base = current_sma

                # 1b. If a sell order is in flight, check its fill status before anything else.
                #     Three possible states:
                #       a) Sell still resting on the book → wait, log, skip remaining logic.
                #       b) Sell gone + position gone   → fill confirmed, exit close mode, continue.
                #       c) Sell gone + position open   → sell was cancelled/rejected externally;
                #                                        re-place at current ma_base, continue.
                if self._waiting_close:
                    sell_resting = any(
                        o.get("oid") == self._close_order_id for o in resting_sells
                    )
                    if sell_resting:
                        sell_px = next(
                            (o["price"] for o in resting_sells if o.get("oid") == self._close_order_id),
                            ma_base,
                        )
                        self.log("info", f"Waiting for close fill — sell order {self._close_order_id} resting @ ${sell_px:.4f}")
                        continue
                    elif not has_position:
                        self.log("info", f"Position closed confirmed (sell {self._close_order_id} filled) — resuming normal operation")
                        self._waiting_close = False
                        self._close_order_id = None
                        continue
                    else:
                        self.log("warning", f"Sell order {self._close_order_id} disappeared without fill — re-placing close order at MA={ma_base:.4f}")
                        oid = await self._place_limit_order(False, abs(real_szi), ma_base)
                        if oid:
                            self._close_order_id = oid
                            self.log("info", f"Re-placed sell order (oid={oid})")
                        continue

                # 2. Stop loss — uses REAL position data (entry_px, szi) from Hyperliquid.
                #    Fires correctly after any restart because it never reads self._positions.
                if self.stop_loss_pct > 0 and has_position and real_entry_px > 0:
                    total_size    = abs(real_szi)
                    total_invested = real_entry_px * total_size
                    current_value  = current_price * total_size
                    pnl_pct = (current_value - total_invested) / total_invested * 100
                    if pnl_pct < -self.stop_loss_pct:
                        self.log("warning", f"Stop loss triggered: PnL={pnl_pct:.2f}% (entry={real_entry_px:.4f} now={current_price:.4f} szi={real_szi})")
                        await self._cancel_all_orders()
                        await self._close_all_positions(real_szi, current_price)
                        await asyncio.sleep(3600)  # pause 1h after stop loss
                        continue

                # 3. Close signal (high >= ma_base on last closed candle).
                #    Uses real_szi for the sell size.
                #    Sets _waiting_close + _close_order_id so the fill-check block (1b)
                #    monitors the order each tick until confirmed filled or re-placed.
                if has_position and last["high"] >= ma_base:
                    self.log("info", f"Close signal: high={last['high']} >= MA={ma_base:.2f} | real_szi={real_szi}")
                    await self._cancel_all_orders()
                    oid = await self._place_limit_order(False, abs(real_szi), ma_base)
                    if oid:
                        self._close_order_id = oid
                        self._waiting_close = True
                        self.log("info", f"Sell order placed (oid={oid}) — monitoring fill each tick")

                # 4. Proactively place limit buy orders at all envelope levels.
                #    Orders are placed in advance and left resting on the book (GTC),
                #    letting Hyperliquid fill them naturally when price reaches each level.
                #    This is the CryptoRobotFr passive approach — NOT reactive post-move.
                #
                #    MA drift detection avoids constant cancel/replace churn:
                #      - First tick (self._last_ma == 0.0): place all levels immediately.
                #      - MA moved > 0.5% since last placement: cancel stale buy orders by
                #        OID (real_orders contains only buys — any resting sell is safe),
                #        then re-place at the new MA-derived prices.
                #      - MA drift ≤ 0.5%: existing orders are still correctly positioned,
                #        skip placement entirely (no-op).
                #
                #    Skipped when a close signal fired this tick (step 3 set _waiting_close).
                #    _waiting_close is managed exclusively by step 3 (set) and block 1b (clear).
                in_close_mode = has_position and last["high"] >= ma_base

                if not in_close_mode:
                    ma_drifted = (
                        self._last_ma == 0.0
                        or abs(ma_base - self._last_ma) / self._last_ma > 0.005
                    )

                    if ma_drifted:
                        # Cancel stale buy orders by OID from the resting_buys snapshot.
                        # Cancelling by OID (not _cancel_all_orders) leaves any resting
                        # sell order from a prior close signal untouched.
                        if resting_buys:
                            self.log("info", f"MA drifted {self._last_ma:.4f} → {ma_base:.4f} — cancelling {len(resting_buys)} stale buy order(s)")
                            for o in resting_buys:
                                oid = o.get("oid")
                                if oid:
                                    try:
                                        await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
                                        self.log("info", f"Cancelled stale buy order {oid}")
                                    except Exception as e:
                                        self.log("warning", f"Failed to cancel buy order {oid}: {e}")
                        self._last_ma = ma_base

                        for i, env_pct in enumerate(self.envelopes):
                            buy_price = round_price(ma_base * (1 - env_pct))
                            # Skip if current price is already at or below this level —
                            # placing a buy above current price would fill immediately as
                            # taker. This level was filled (or skipped) in a prior tick.
                            if current_price <= buy_price:
                                self.log("info", f"Level {i} @ {buy_price:.4f} already passed (current={current_price:.4f}) — skipping")
                                continue
                            size = (per_level * self.leverage) / buy_price
                            order_value = per_level * self.leverage
                            self.log("info", f"Placing level {i} buy: price={buy_price:.4f} size={size:.6f} notional={order_value:.2f} USDC (capital={per_level:.2f} × leverage={self.leverage})")
                            oid = await self._place_limit_order(True, size, buy_price)
                            if oid:
                                self.log("info", f"Level {i} buy placed (oid={oid})")
                    else:
                        self.log("info", f"MA drift < 0.5% ({self._last_ma:.4f} → {ma_base:.4f}) — existing orders unchanged")

                self.log("info", f"Tick complete — MA={ma_base:.2f} | Price={current_price:.2f} | real_szi={real_szi} | resting_buys={len(resting_buys)} | resting_sells={len(resting_sells)} | in_close_mode={in_close_mode}")

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cleaning up...")
                await self._cancel_all_orders()
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            # Wait for next candle interval
            await asyncio.sleep(self._sleep_seconds)

        self._running = False
        self.log("info", "Envelope Bot stopped.")
