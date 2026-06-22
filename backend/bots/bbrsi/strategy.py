"""
Bollinger Bands + RSI Mean Reversion Bot for Hyperliquid.

Strategy:
- Uses Bollinger Bands (20 period, 2 std) + RSI (14 period)
- LONG entry: price crosses below lower BB AND RSI < oversold (default 30)
- SHORT entry: price crosses above upper BB AND RSI > overbought (default 70)
- Exit: price returns to middle BB (SMA20) OR RSI crosses back to neutral (50)
- Stop loss: configurable %
- Timeframe: 4h candles (configurable)
"""
from __future__ import annotations
import asyncio
import math
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"


def compute_sma(values: list[float], period: int) -> list[Optional[float]]:
    result = []
    for i in range(len(values)):
        if i < period - 1:
            result.append(None)
        else:
            result.append(sum(values[i - period + 1:i + 1]) / period)
    return result


def compute_std(values: list[float], period: int) -> list[Optional[float]]:
    result = []
    for i in range(len(values)):
        if i < period - 1:
            result.append(None)
        else:
            window = values[i - period + 1:i + 1]
            mean = sum(window) / period
            variance = sum((x - mean) ** 2 for x in window) / period
            result.append(math.sqrt(variance))
    return result


def compute_rsi(closes: list[float], period: int = 14) -> list[Optional[float]]:
    result: list[Optional[float]] = [None] * period
    if len(closes) <= period:
        return [None] * len(closes)
    gains, losses = [], []
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gain = max(diff, 0)
        loss = max(-diff, 0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            result.append(100.0)
        else:
            rs = avg_gain / avg_loss
            result.append(100 - 100 / (1 + rs))
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


class BBRSIBot:
    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        leverage: int,
        bb_period: int,
        bb_std: float,
        rsi_period: int,
        rsi_oversold: float,
        rsi_overbought: float,
        stop_loss_pct: float,
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
        self.bb_period = bb_period
        self.bb_std = bb_std
        self.rsi_period = rsi_period
        self.rsi_oversold = rsi_oversold
        self.rsi_overbought = rsi_overbought
        self.stop_loss_pct = stop_loss_pct
        self.sz_decimals = sz_decimals
        self.interval = interval
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)
        self._exchange = None
        self._position: Optional[dict] = None
        self._running = False

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
            action = "Closed" if reduce_only else ("Bought" if is_buy else "Sold")
            self.log("info", f"{action} {size} {self.coin} @ ~${limit_px}")
            return True
        except Exception as e:
            self.log("error", f"Order failed: {e}")
            return False

    async def run(self):
        self._running = True
        self._init_exchange()
        await self._set_leverage()
        min_candles = max(self.bb_period, self.rsi_period) + 5
        self.log("info", f"BB+RSI Bot started — {self.coin} | BB({self.bb_period},{self.bb_std}) | RSI({self.rsi_period}) | {self.interval}")

        while self._running:
            try:
                candles = await self._fetch_candles(limit=min_candles + 10)
                if len(candles) < min_candles:
                    self.log("warning", "Not enough candles")
                    await asyncio.sleep(300)
                    continue

                closes = [c["close"] for c in candles]
                current_price = closes[-1]

                # Compute indicators on closed candles (use -2 for signal, -1 for current price)
                sma = compute_sma(closes, self.bb_period)
                std = compute_std(closes, self.bb_period)
                rsi_values = compute_rsi(closes, self.rsi_period)

                mid = sma[-2]
                s = std[-2]
                rsi = rsi_values[-2]

                if mid is None or s is None or rsi is None:
                    await asyncio.sleep(self._sleep_seconds)
                    continue

                upper_bb = mid + self.bb_std * s
                lower_bb = mid - self.bb_std * s
                prev_close = closes[-2]

                self.log("info", f"BB: [{lower_bb:.2f} | {mid:.2f} | {upper_bb:.2f}] | RSI: {rsi:.1f} | Price: {current_price:.2f}")

                # Stop loss check
                if self._position and self.stop_loss_pct > 0:
                    entry = self._position["entry_price"]
                    if self._position["side"] == "long":
                        pnl_pct = (current_price - entry) / entry * 100
                    else:
                        pnl_pct = (entry - current_price) / entry * 100
                    if pnl_pct < -self.stop_loss_pct:
                        self.log("warning", f"Stop loss triggered: PnL={pnl_pct:.2f}%")
                        size = self._position["size"]
                        is_close_buy = self._position["side"] == "short"
                        await self._place_order(is_close_buy, size, current_price, reduce_only=True)
                        self._position = None
                        await asyncio.sleep(self._sleep_seconds)
                        continue

                if self._position is None:
                    # LONG entry: prev_close <= lower_bb AND rsi < oversold
                    if prev_close <= lower_bb and rsi < self.rsi_oversold:
                        size = round_size((self.allocated_usdc * self.leverage) / current_price, self.sz_decimals)
                        self.log("info", f"LONG signal: price={prev_close:.2f} <= lower_BB={lower_bb:.2f} & RSI={rsi:.1f} < {self.rsi_oversold}")
                        success = await self._place_order(True, size, current_price)
                        if success:
                            self._position = {"side": "long", "size": size, "entry_price": current_price}

                    # SHORT entry: prev_close >= upper_bb AND rsi > overbought
                    elif prev_close >= upper_bb and rsi > self.rsi_overbought:
                        size = round_size((self.allocated_usdc * self.leverage) / current_price, self.sz_decimals)
                        self.log("info", f"SHORT signal: price={prev_close:.2f} >= upper_BB={upper_bb:.2f} & RSI={rsi:.1f} > {self.rsi_overbought}")
                        success = await self._place_order(False, size, current_price)
                        if success:
                            self._position = {"side": "short", "size": size, "entry_price": current_price}
                    else:
                        self.log("info", "No signal — waiting for BB+RSI confluence")

                else:
                    # Exit: price returns to mid BB
                    if self._position["side"] == "long" and prev_close >= mid:
                        self.log("info", f"EXIT long: price={prev_close:.2f} >= mid_BB={mid:.2f}")
                        await self._place_order(False, self._position["size"], current_price, reduce_only=True)
                        self._position = None
                    elif self._position["side"] == "short" and prev_close <= mid:
                        self.log("info", f"EXIT short: price={prev_close:.2f} <= mid_BB={mid:.2f}")
                        await self._place_order(True, self._position["size"], current_price, reduce_only=True)
                        self._position = None
                    else:
                        entry = self._position["entry_price"]
                        if self._position["side"] == "long":
                            pnl_pct = (current_price - entry) / entry * 100
                        else:
                            pnl_pct = (entry - current_price) / entry * 100
                        self.log("info", f"Holding {self._position['side'].upper()} — PnL={pnl_pct:.2f}%")

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — closing position...")
                if self._position:
                    candles = await self._fetch_candles(limit=5)
                    price = candles[-1]["close"] if candles else 0
                    if price:
                        is_close_buy = self._position["side"] == "short"
                        await self._place_order(is_close_buy, self._position["size"], price, reduce_only=True)
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            await asyncio.sleep(self._sleep_seconds)

        self._running = False
        self.log("info", "BB+RSI Bot stopped.")
