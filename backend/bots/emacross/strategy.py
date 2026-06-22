"""
EMA Cross Trend Following Bot for Hyperliquid.

Strategy:
- Uses two EMAs: fast (default 9) and slow (default 21)
- LONG entry: fast EMA crosses above slow EMA (golden cross)
- SHORT entry: fast EMA crosses below slow EMA (death cross)
- Exit: opposite cross signal OR stop loss
- Optional ATR-based dynamic stop loss
- Timeframe: configurable (default 4h)
"""
from __future__ import annotations
import asyncio
import math
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"


def compute_ema(values: list[float], period: int) -> list[Optional[float]]:
    result: list[Optional[float]] = []
    k = 2 / (period + 1)
    ema = None
    for i, v in enumerate(values):
        if i < period - 1:
            result.append(None)
        elif i == period - 1:
            ema = sum(values[:period]) / period
            result.append(ema)
        else:
            ema = v * k + ema * (1 - k)
            result.append(ema)
    return result


def compute_atr(candles: list[dict], period: int = 14) -> list[Optional[float]]:
    trs = []
    for i in range(len(candles)):
        if i == 0:
            trs.append(candles[i]["high"] - candles[i]["low"])
        else:
            high = candles[i]["high"]
            low = candles[i]["low"]
            prev_close = candles[i-1]["close"]
            trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    result: list[Optional[float]] = [None] * (period - 1)
    if len(trs) < period:
        return [None] * len(trs)
    atr = sum(trs[:period]) / period
    result.append(atr)
    for i in range(period, len(trs)):
        atr = (atr * (period - 1) + trs[i]) / period
        result.append(atr)
    return result


def round_price(price: float) -> float:
    if price >= 1000:
        return round(price)
    elif price >= 10:
        return round(price, 1)
    else:
        return round(price, 2)


def round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor


class EMACrossBot:
    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        leverage: int,
        ema_fast: int,
        ema_slow: int,
        stop_loss_pct: float,
        use_atr_stop: bool,
        atr_multiplier: float,
        sz_decimals: int,
        interval: str,
        dex: Optional[str] = None,
        log_callback=None,
    ):
        self.private_key = private_key
        self.master_address = master_address
        self.coin = coin
        self.allocated_usdc = allocated_usdc
        self.leverage = leverage
        self.ema_fast = ema_fast
        self.ema_slow = ema_slow
        self.stop_loss_pct = stop_loss_pct
        self.use_atr_stop = use_atr_stop
        self.atr_multiplier = atr_multiplier
        self.sz_decimals = sz_decimals
        self.interval = interval
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)
        self._exchange = None
        self._position: Optional[dict] = None
        self._running = False
        self._stop_price: Optional[float] = None

        interval_ms_map = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
            "1h": 3_600_000, "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
        }
        self._interval_ms = interval_ms_map.get(interval, 14_400_000)
        self._sleep_seconds = self._interval_ms // 1000

    def _init_exchange(self):
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants
        account = eth_account.Account.from_key(self.private_key)
        dex_list = [self.dex] if self.dex else []
        self._exchange = Exchange(
            account, constants.MAINNET_API_URL,
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
                self._exchange.update_leverage, self.leverage, self.coin, True
            )
            status = (result or {}).get("status", "")
            if status == "ok":
                self.log("info", f"Leverage set to {self.leverage}x for {self.coin}")
            else:
                self.log("warning", f"Leverage update unexpected response for {self.coin}: {result}")
        except Exception as e:
            self.log("warning", f"Could not set leverage: {e}")

    async def _fetch_candles(self, limit: int = 100) -> list[dict]:
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

    async def _place_order(self, is_buy: bool, size: float, mark_price: float, reduce_only: bool = False) -> bool:
        slippage = 0.01
        limit_px = round_price(mark_price * (1 + slippage) if is_buy else mark_price * (1 - slippage))
        size = round_size(size, self.sz_decimals)
        if size <= 0:
            return False
        try:
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, limit_px,
                {"limit": {"tif": "Ioc"}}, reduce_only,
            )
            statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
            status = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Order rejected: {status['error']}")
                return False
            action = "Closed" if reduce_only else ("Bought" if is_buy else "Sold short")
            self.log("info", f"{action} {size} {self.coin} @ ~${limit_px}")
            return True
        except Exception as e:
            self.log("error", f"Order failed: {e}")
            return False

    async def run(self):
        self._running = True
        self._init_exchange()
        await self._set_leverage()
        min_candles = self.ema_slow + 10
        self.log("info", f"EMA Cross Bot started — {self.coin} | EMA({self.ema_fast}/{self.ema_slow}) | {self.interval} | Leverage={self.leverage}x")

        while self._running:
            try:
                candles = await self._fetch_candles(limit=min_candles)
                if len(candles) < min_candles:
                    self.log("warning", "Not enough candles")
                    await asyncio.sleep(300)
                    continue

                closes = [c["close"] for c in candles]
                current_price = closes[-1]

                ema_fast_vals = compute_ema(closes, self.ema_fast)
                ema_slow_vals = compute_ema(closes, self.ema_slow)
                atr_vals = compute_atr(candles, 14) if self.use_atr_stop else [None] * len(candles)

                # Use last TWO closed candles for cross detection
                fast_prev = ema_fast_vals[-3]
                fast_curr = ema_fast_vals[-2]
                slow_prev = ema_slow_vals[-3]
                slow_curr = ema_slow_vals[-2]
                atr_curr = atr_vals[-2]

                if any(v is None for v in [fast_prev, fast_curr, slow_prev, slow_curr]):
                    await asyncio.sleep(self._sleep_seconds)
                    continue

                golden_cross = fast_prev <= slow_prev and fast_curr > slow_curr
                death_cross = fast_prev >= slow_prev and fast_curr < slow_curr

                self.log("info", f"EMA Fast={fast_curr:.2f} Slow={slow_curr:.2f} | {'🟢 GOLDEN' if golden_cross else '🔴 DEATH' if death_cross else '⬜ No'} cross | Price={current_price:.2f}")

                # Stop loss check
                if self._position and self.stop_loss_pct > 0:
                    entry = self._position["entry_price"]
                    if self._position["side"] == "long":
                        pnl_pct = (current_price - entry) / entry * 100
                    else:
                        pnl_pct = (entry - current_price) / entry * 100
                    # ATR stop
                    if self.use_atr_stop and atr_curr and self._stop_price:
                        hit_stop = (self._position["side"] == "long" and current_price < self._stop_price) or \
                                   (self._position["side"] == "short" and current_price > self._stop_price)
                        if hit_stop:
                            self.log("warning", f"ATR stop hit at ${self._stop_price:.2f}")
                            await self._place_order(self._position["side"] == "short", self._position["size"], current_price, reduce_only=True)
                            self._position = None
                            self._stop_price = None
                            await asyncio.sleep(self._sleep_seconds)
                            continue
                    elif pnl_pct < -self.stop_loss_pct:
                        self.log("warning", f"Stop loss triggered: PnL={pnl_pct:.2f}%")
                        await self._place_order(self._position["side"] == "short", self._position["size"], current_price, reduce_only=True)
                        self._position = None
                        self._stop_price = None
                        await asyncio.sleep(self._sleep_seconds)
                        continue

                if self._position is None:
                    if golden_cross:
                        size = round_size((self.allocated_usdc * self.leverage) / current_price, self.sz_decimals)
                        self.log("info", f"GOLDEN CROSS → opening LONG {size} {self.coin}")
                        success = await self._place_order(True, size, current_price)
                        if success:
                            self._position = {"side": "long", "size": size, "entry_price": current_price}
                            if self.use_atr_stop and atr_curr:
                                self._stop_price = round_price(current_price - self.atr_multiplier * atr_curr)
                                self.log("info", f"ATR stop set at ${self._stop_price}")
                    elif death_cross:
                        size = round_size((self.allocated_usdc * self.leverage) / current_price, self.sz_decimals)
                        self.log("info", f"DEATH CROSS → opening SHORT {size} {self.coin}")
                        success = await self._place_order(False, size, current_price)
                        if success:
                            self._position = {"side": "short", "size": size, "entry_price": current_price}
                            if self.use_atr_stop and atr_curr:
                                self._stop_price = round_price(current_price + self.atr_multiplier * atr_curr)
                                self.log("info", f"ATR stop set at ${self._stop_price}")
                    else:
                        self.log("info", "No cross signal — waiting")
                else:
                    # Exit on opposite cross
                    if self._position["side"] == "long" and death_cross:
                        self.log("info", "DEATH CROSS → closing LONG")
                        await self._place_order(False, self._position["size"], current_price, reduce_only=True)
                        self._position = None
                        self._stop_price = None
                    elif self._position["side"] == "short" and golden_cross:
                        self.log("info", "GOLDEN CROSS → closing SHORT")
                        await self._place_order(True, self._position["size"], current_price, reduce_only=True)
                        self._position = None
                        self._stop_price = None
                    else:
                        entry = self._position["entry_price"]
                        pnl = (current_price - entry) / entry * 100 if self._position["side"] == "long" else (entry - current_price) / entry * 100
                        self.log("info", f"Holding {self._position['side'].upper()} — PnL={pnl:.2f}% | Stop=${self._stop_price}")

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — closing position...")
                if self._position:
                    candles = await self._fetch_candles(limit=5)
                    price = candles[-1]["close"] if candles else 0
                    if price:
                        await self._place_order(self._position["side"] == "short", self._position["size"], price, reduce_only=True)
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            await asyncio.sleep(self._sleep_seconds)

        self._running = False
        self.log("info", "EMA Cross Bot stopped.")
