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
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)
        self._running = False
        self._positions: list[dict] = []  # {level, entry_price, size, order_id}
        self._open_order_ids: set[int] = set()
        self._candles: list[dict] = []
        self._exchange = None

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

    async def _fetch_candles(self, limit: int = 200) -> list[dict]:
        interval_ms = 4 * 3600 * 1000  # 4h default
        end_time = int(time.time() * 1000)
        start_time = end_time - interval_ms * limit
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(INFO_ENDPOINT, json={
                "type": "candleSnapshot",
                "req": {"coin": self.coin, "interval": "4h", "startTime": start_time, "endTime": end_time}
            })
            candles = resp.json()
        return [{"time": int(c["t"]) // 1000, "open": float(c["o"]), "high": float(c["h"]),
                 "low": float(c["l"]), "close": float(c["c"]), "volume": float(c["v"])} for c in candles]

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

    async def _close_all_positions(self, mark_price: float):
        """Close all open positions at market."""
        if not self._positions:
            return
        total_size = sum(abs(p["size"]) for p in self._positions)
        total_size = round_size(total_size, self.sz_decimals)
        if total_size <= 0:
            return
        slippage = 0.05
        limit_price = round_price(mark_price * (1 - slippage))
        try:
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, False, total_size, limit_price,
                {"limit": {"tif": "Ioc"}},
            )
            self.log("info", f"Closed all positions: {total_size} {self.coin} @ ~${limit_price}")
            self._positions.clear()
        except Exception as e:
            self.log("error", f"Close positions failed: {e}")

    async def run(self):
        """Main bot loop — runs indefinitely until cancelled."""
        self._running = True
        self._init_exchange()
        self.log("info", f"Envelope Bot started — {self.coin} | MA={self.ma_period} | Envelopes={self.envelopes} | Allocation=${self.allocated_usdc}")

        per_level = self.allocated_usdc / len(self.envelopes)

        while self._running:
            try:
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

                # 2. Check stop loss
                if self.stop_loss_pct > 0 and self._positions:
                    total_invested = sum(p["entry_price"] * p["size"] for p in self._positions)
                    current_value = current_price * sum(p["size"] for p in self._positions)
                    pnl_pct = (current_value - total_invested) / total_invested * 100
                    if pnl_pct < -self.stop_loss_pct:
                        self.log("warning", f"Stop loss triggered: PnL={pnl_pct:.2f}%")
                        await self._cancel_all_orders()
                        await self._close_all_positions(current_price)
                        await asyncio.sleep(3600)  # pause 1h after stop loss
                        continue

                # 3. Check close signal (high >= ma_base on last closed candle)
                if self._positions and last["high"] >= ma_base:
                    self.log("info", f"Close signal: high={last['high']} >= MA={ma_base:.2f}")
                    await self._cancel_all_orders()
                    # Place limit sell at ma_base
                    total_size = sum(p["size"] for p in self._positions)
                    oid = await self._place_limit_order(False, total_size, ma_base)
                    if oid:
                        self._positions.clear()
                        self._open_order_ids.discard(oid)

                # 4. Place buy orders at envelope levels (if not already positioned)
                active_levels = {p["level"] for p in self._positions}
                for i, env_pct in enumerate(self.envelopes):
                    if i in active_levels:
                        continue
                    buy_price = ma_base * (1 - env_pct)
                    # Check if current price already below this level
                    if last["low"] <= buy_price:
                        size = per_level / buy_price
                        oid = await self._place_limit_order(True, size, buy_price)
                        if oid:
                            self._positions.append({"level": i, "entry_price": buy_price, "size": round_size(size, self.sz_decimals), "order_id": oid})
                            self._open_order_ids.add(oid)

                self.log("info", f"Tick complete — MA={ma_base:.2f} | Price={current_price:.2f} | Positions={len(self._positions)}")

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cleaning up...")
                await self._cancel_all_orders()
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            # Wait 4 hours (same as candle interval)
            await asyncio.sleep(4 * 3600)

        self._running = False
        self.log("info", "Envelope Bot stopped.")
