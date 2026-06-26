"""
Trend Magic Bot — RSI(14) + EMA(200) trend-following with Fibonacci DCA and trailing stop.

Entry signal (last closed candle, candles[-2]):
  Long:  RSI > rsi_overbought  AND  close > EMA(ema_period)  → strong upward momentum
  Short: RSI < rsi_oversold    AND  close < EMA(ema_period)  → strong downward momentum

Position sizing (Fibonacci):
  Initial market entry : 15% of allocated_usdc
  DCA Level 1 (limit)  : 35% at entry ± dca_level_1_pct%
  DCA Level 2 (limit)  : 50% at entry ± dca_level_2_pct%

Exit:
  TP : reduce-only limit at entry ± tp_pct%
  SL : trailing stop (fixed %), modified in-place via modify_order
"""
from __future__ import annotations
import asyncio
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"

from bots.envelope.strategy import round_price, round_size

_FIB_WEIGHTS = [0.15, 0.35, 0.50]   # [initial entry, DCA1, DCA2]


# ── Indicators ────────────────────────────────────────────────────────────────

def compute_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """Wilder's smoothed RSI.  Returns list of same length; first `period` values are None."""
    n = len(closes)
    rsi: list[float | None] = [None] * n
    if n <= period:
        return rsi
    gains, losses = [], []
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    rsi[period] = (100.0 if avg_loss == 0
                   else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss))
    for i in range(period + 1, n):
        d = closes[i] - closes[i - 1]
        g, lo = max(d, 0.0), max(-d, 0.0)
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + lo) / period
        rsi[i] = (100.0 if avg_loss == 0
                  else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss))
    return rsi


def compute_ema(closes: list[float], period: int = 200) -> list[float | None]:
    """EMA with SMA seed.  Returns list of same length; first period-1 values are None."""
    n = len(closes)
    ema: list[float | None] = [None] * n
    if n < period:
        return ema
    k = 2.0 / (period + 1)
    ema[period - 1] = sum(closes[:period]) / period
    for i in range(period, n):
        prev = ema[i - 1]
        if prev is not None:
            ema[i] = closes[i] * k + prev * (1 - k)
    return ema


# ── Bot class ─────────────────────────────────────────────────────────────────

class TrendMagicBot:
    """
    Live Trend Magic bot for Hyperliquid.
    Runs as an asyncio coroutine — call await bot.run() to start.
    """

    def __init__(
        self,
        private_key:        str,
        master_address:     str,
        coin:               str,
        allocated_usdc:     float,
        sz_decimals:        int,
        leverage:           int               = 1,
        interval:           str               = "1h",
        rsi_period:         int               = 14,
        rsi_overbought:     float             = 70.0,
        rsi_oversold:       float             = 30.0,
        ema_period:         int               = 200,
        dca_level_1_pct:    float             = 7.0,
        dca_level_2_pct:    float             = 14.0,
        tp_pct:             float             = 5.0,
        trailing_stop_pct:  float             = 1.0,
        sides:              Optional[list[str]] = None,
        dex:                Optional[str]     = None,
        scan_pairs:         bool              = False,
        scan_symbols:       list              = [],
        log_callback=None,
    ):
        self.private_key       = private_key
        self.master_address    = master_address
        self.coin              = coin
        self.allocated_usdc    = allocated_usdc
        self.sz_decimals       = sz_decimals
        self.leverage          = leverage
        self.interval          = interval
        self.rsi_period        = rsi_period
        self.rsi_overbought    = rsi_overbought
        self.rsi_oversold      = rsi_oversold
        self.ema_period        = ema_period
        self.dca_pcts          = [dca_level_1_pct, dca_level_2_pct]
        self.tp_pct            = tp_pct
        self.trailing_stop_pct = trailing_stop_pct
        self.sides             = [s.lower() for s in (sides or ["long", "short"])]
        self.dex               = dex
        self.scan_pairs        = scan_pairs
        self.scan_symbols      = list(scan_symbols) if scan_symbols else []
        self.log               = log_callback or (lambda level, msg: None)
        self._running          = False
        self._exchange         = None

        # Scanner per-pair state (populated in _run_scanner)
        self._pair_state:  dict = {}   # coin -> {in_long, entry_price, peak_price, sl_oid}
        self._scan_sz_dec: dict = {}   # coin -> sz_decimals
        self._scan_coins:  list = []   # ordered list of coin strings

        interval_ms_map = {
            "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
            "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
        }
        self._interval_ms = interval_ms_map.get(interval, 3_600_000)

        # Position state — reset when position closes
        self._sl_oid:             int   | None = None
        self._peak_price:         float | None = None
        self._entry_price:        float | None = None
        self._in_long:            bool  | None = None
        self._trailing_activated: bool         = False

    # ── Exchange init ─────────────────────────────────────────────────────────

    def _init_exchange(self):
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants
        account  = eth_account.Account.from_key(self.private_key)
        dex_list = [self.dex] if self.dex else []
        self._exchange = Exchange(
            account, constants.MAINNET_API_URL,
            account_address=self.master_address,
            perp_dexs=dex_list if dex_list else None,
        )

    async def _set_leverage(self):
        self.log("info", f"Setting leverage to {self.leverage}x for {self.coin}")
        try:
            result = await asyncio.to_thread(
                self._exchange.update_leverage, self.leverage, self.coin, False
            )
            if (result or {}).get("status") == "ok":
                self.log("info", f"Leverage set to {self.leverage}x")
            else:
                self.log("warning", f"Leverage update response: {result}")
        except Exception as e:
            self.log("warning", f"Failed to set leverage: {e}")

    # ── Timing ────────────────────────────────────────────────────────────────

    def _seconds_until_next_candle(self) -> float:
        now_ms  = int(time.time() * 1000)
        next_ms = ((now_ms // self._interval_ms) + 1) * self._interval_ms
        return max((next_ms - now_ms) / 1000.0, 1.0)

    # ── Data fetching ─────────────────────────────────────────────────────────

    async def _fetch_candles(self, limit: int = 230) -> list[dict]:
        end_time   = int(time.time() * 1000)
        start_time = end_time - self._interval_ms * limit
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(INFO_ENDPOINT, json={
                "type": "candleSnapshot",
                "req": {
                    "coin": self.coin, "interval": self.interval,
                    "startTime": start_time, "endTime": end_time,
                },
            })
            candles = resp.json()
        return [
            {
                "time":   int(c["t"]) // 1000,
                "open":   float(c["o"]), "high": float(c["h"]),
                "low":    float(c["l"]), "close": float(c["c"]),
                "volume": float(c["v"]),
            }
            for c in candles
        ]

    async def _fetch_real_position(self) -> dict:
        payload: dict = {"type": "clearinghouseState", "user": self.master_address}
        if self.dex:
            payload["dex"] = self.dex
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json=payload,
                                         headers={"Content-Type": "application/json"})
                state = resp.json()
            coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
            for ap in (state.get("assetPositions") or []):
                if not isinstance(ap, dict): continue
                pos = ap.get("position") or {}
                if not isinstance(pos, dict): continue
                if pos.get("coin", "") not in (self.coin, coin_short): continue
                szi = float(pos.get("szi", "0") or "0")
                if szi == 0.0: continue
                return {
                    "szi":      szi,
                    "entry_px": float(pos.get("entryPx", "0") or "0"),
                }
        except Exception as e:
            self.log("warning", f"Failed to fetch real position: {e}")
        return {"szi": 0.0, "entry_px": 0.0}

    # ── Order management ──────────────────────────────────────────────────────

    async def _cancel_all_orders(self):
        """Cancel all open orders for this coin, EXCEPT the resting SL (_sl_oid)."""
        coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address})
                orders = resp.json()
            if not isinstance(orders, list): return
            for order in [o for o in orders
                          if isinstance(o, dict) and o.get("coin") in (self.coin, coin_short)]:
                oid = order.get("oid")
                if oid:
                    if oid == self._sl_oid:
                        continue  # keep SL alive — will be modified in-place this tick
                    try:
                        await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
                        self.log("info", f"Cancelled order {oid}")
                    except Exception as e:
                        self.log("warning", f"Failed to cancel {oid}: {e}")
        except Exception as e:
            self.log("warning", f"Cancel all orders failed: {e}")

    async def _count_open_dca_orders(self) -> tuple[int, int]:
        """Count non-reduce-only open orders (DCA entries) per side."""
        coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address})
                orders = resp.json()
            if not isinstance(orders, list): return 0, 0
            coin_orders = [o for o in orders
                           if isinstance(o, dict) and o.get("coin") in (self.coin, coin_short)]
            buy_count  = sum(1 for o in coin_orders
                             if o.get("side") == "B" and not o.get("reduceOnly", False))
            sell_count = sum(1 for o in coin_orders
                             if o.get("side") == "A" and not o.get("reduceOnly", False))
            return buy_count, sell_count
        except Exception as e:
            self.log("warning", f"Count open DCA orders failed: {e}")
            return 0, 0

    async def _place_market_order(self, is_buy: bool, size: float) -> bool:
        """IOC limit order with 1% slippage to simulate a market fill. Returns True on success."""
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                self.log("warning", "Market order size rounds to 0 — skipping")
                return False
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "allMids"},
                    headers={"Content-Type": "application/json"})
                mids = resp.json()
            coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
            mid = float(mids.get(coin_short) or mids.get(self.coin) or 0)
            if mid <= 0:
                self.log("warning", "Could not fetch mid price for market order")
                return False
            limit_px = round_price(mid * 1.01 if is_buy else mid * 0.99)
            notional = size * limit_px
            if notional < 10.0:
                self.log("warning", f"Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={limit_px})")
                return False
            result   = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, limit_px,
                {"limit": {"tif": "Ioc"}},
                False,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Market order rejected: {status['error']}")
                return False
            self.log("info", f"{'Buy' if is_buy else 'Sell'} market IOC: sz={size} @ ~{limit_px:.4f}")
            return True
        except Exception as e:
            self.log("error", f"Market order failed: {e}")
            return False

    async def _place_limit_dca(self, is_buy: bool, size: float, price: float) -> Optional[int]:
        """GTC limit entry order (not reduce-only) for DCA accumulation."""
        try:
            size  = round_size(size, self.sz_decimals)
            if size <= 0: return None
            price = round_price(price)
            notional = size * price
            if notional < 10.0:
                self.log("warning", f"Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={price})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
                False,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"DCA limit rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"{'Buy' if is_buy else 'Sell'} DCA limit @ {price} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"DCA limit placement failed: {e}")
            return None

    async def _place_limit_reduce(self, is_buy: bool, size: float, price: float) -> Optional[int]:
        """Reduce-only GTC limit order (TP)."""
        try:
            size  = round_size(size, self.sz_decimals)
            if size <= 0: return None
            price = round_price(price)
            notional = size * price
            if notional < 10.0:
                self.log("warning", f"Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={price})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
                True,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"TP limit rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"{'Buy' if is_buy else 'Sell'} TP limit @ {price} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"TP limit placement failed: {e}")
            return None

    async def _place_stop_market(self, is_buy: bool, size: float, trigger_px: float) -> Optional[int]:
        """Reduce-only stop-market SL order."""
        try:
            size       = round_size(size, self.sz_decimals)
            if size <= 0: return None
            trigger_px = round_price(trigger_px)
            notional = size * trigger_px
            if notional < 10.0:
                self.log("warning", f"Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={trigger_px})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, trigger_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": True, "tpsl": "sl"}},
                True,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Stop-market rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"{'Buy' if is_buy else 'Sell'} stop-market @ {trigger_px} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"Stop-market placement failed: {e}")
            return None

    async def _modify_or_replace_sl(self, is_buy: bool, size: float, new_sl_px: float) -> None:
        """Modify the resting SL order in-place; fall back to cancel+replace if needed."""
        new_sl_px  = round_price(new_sl_px)
        size       = round_size(size, self.sz_decimals)
        if size <= 0:
            return
        order_type = {"trigger": {"triggerPx": new_sl_px, "isMarket": True, "tpsl": "sl"}}
        if self._sl_oid is not None:
            try:
                result = await asyncio.to_thread(
                    self._exchange.modify_order,
                    self._sl_oid, self.coin, is_buy, size, new_sl_px, order_type, True,
                )
                statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
                status   = statuses[0] if statuses else {}
                if "error" in status:
                    self.log("info", f"SL modify failed ({status['error']}) — placing new order")
                    self._sl_oid = None
                    new_oid = await self._place_stop_market(is_buy, size, new_sl_px)
                    self._sl_oid = new_oid
                else:
                    new_oid = (status.get("resting") or {}).get("oid") or self._sl_oid
                    self.log("info", f"Trailing SL modified → {new_sl_px:.4f} oid={new_oid}")
                    self._sl_oid = new_oid
            except Exception as e:
                self.log("warning", f"SL modify exception ({e}) — placing new order")
                self._sl_oid = None
                new_oid = await self._place_stop_market(is_buy, size, new_sl_px)
                self._sl_oid = new_oid
        else:
            new_oid = await self._place_stop_market(is_buy, size, new_sl_px)
            self._sl_oid = new_oid

    # ── Trailing stop ─────────────────────────────────────────────────────────

    def _get_trailing_sl(self, is_long: bool, cur_price: float) -> float:
        """Update peak and return new trailing SL price."""
        if self._peak_price is None:
            self._peak_price = cur_price
        if is_long:
            self._peak_price = max(self._peak_price, cur_price)
            sl = self._peak_price * (1.0 - self.trailing_stop_pct / 100.0)
        else:
            self._peak_price = min(self._peak_price, cur_price)
            sl = self._peak_price * (1.0 + self.trailing_stop_pct / 100.0)
        self.log("info", f"Trailing SL updated: peak={self._peak_price:.4f} sl={sl:.4f}")
        return sl

    # ── Scanner helpers ───────────────────────────────────────────────────────

    async def _sc_fetch_candles(self, coin: str, limit: int = 230) -> list:
        end_time   = int(time.time() * 1000)
        start_time = end_time - self._interval_ms * limit
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(INFO_ENDPOINT, json={
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": self.interval,
                        "startTime": start_time, "endTime": end_time},
            })
            candles = resp.json()
        return [
            {"time": int(c["t"]) // 1000,
             "open": float(c["o"]), "high": float(c["h"]),
             "low":  float(c["l"]), "close": float(c["c"]),
             "volume": float(c["v"])}
            for c in candles
        ]

    async def _sc_get_sz_decimals(self, coin: str) -> int:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "meta"})
                meta = resp.json()
            coin_short = coin.split(":")[-1] if ":" in coin else coin
            for asset in (meta.get("universe") or []):
                if asset.get("name") == coin_short:
                    return int(asset.get("szDecimals", 3))
        except Exception as e:
            self.log("warning", f"Failed to get sz_decimals for {coin}: {e}")
        return 3

    async def _sc_set_leverage(self, coin: str) -> None:
        try:
            result = await asyncio.to_thread(
                self._exchange.update_leverage, self.leverage, coin, False)
            if (result or {}).get("status") != "ok":
                self.log("warning", f"[{coin}] Leverage response: {result}")
            else:
                self.log("info", f"[{coin}] Leverage set to {self.leverage}x")
        except Exception as e:
            self.log("warning", f"[{coin}] Failed to set leverage: {e}")

    async def _sc_fetch_all_positions(self) -> dict:
        """Fetch one clearinghouse snapshot; return {coin: {szi, entry_px}} for all scan coins."""
        payload: dict = {"type": "clearinghouseState", "user": self.master_address}
        if self.dex:
            payload["dex"] = self.dex
        result = {c: {"szi": 0.0, "entry_px": 0.0} for c in self._scan_coins}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json=payload,
                                         headers={"Content-Type": "application/json"})
                state = resp.json()
            for ap in (state.get("assetPositions") or []):
                if not isinstance(ap, dict): continue
                pos = ap.get("position") or {}
                if not isinstance(pos, dict): continue
                pos_coin = pos.get("coin", "")
                szi = float(pos.get("szi", "0") or "0")
                if szi == 0.0: continue
                for sc in self._scan_coins:
                    sc_short = sc.split(":")[-1] if ":" in sc else sc
                    if pos_coin in (sc, sc_short):
                        result[sc] = {"szi": szi,
                                      "entry_px": float(pos.get("entryPx", "0") or "0")}
                        break
        except Exception as e:
            self.log("warning", f"Failed to fetch all positions: {e}")
        return result

    async def _sc_fetch_all_orders(self) -> dict:
        """Fetch frontendOpenOrders once; return {coin: [orders]} for all scan coins."""
        result = {c: [] for c in self._scan_coins}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address})
                orders = resp.json()
            if not isinstance(orders, list): return result
            for order in orders:
                if not isinstance(order, dict): continue
                order_coin = order.get("coin", "")
                for sc in self._scan_coins:
                    sc_short = sc.split(":")[-1] if ":" in sc else sc
                    if order_coin in (sc, sc_short):
                        result[sc].append(order)
                        break
        except Exception as e:
            self.log("warning", f"Failed to fetch all orders: {e}")
        return result

    async def _sc_cancel_orders(self, coin: str, orders: list, keep_sl_oid: Optional[int]) -> None:
        for order in orders:
            oid = order.get("oid")
            if oid is None or oid == keep_sl_oid: continue
            try:
                await asyncio.to_thread(self._exchange.cancel, coin, oid)
                self.log("info", f"[{coin}] Cancelled {oid}")
            except Exception as e:
                self.log("warning", f"[{coin}] Cancel {oid} failed: {e}")

    async def _sc_market_order(self, coin: str, sz_dec: int, is_buy: bool, size: float) -> bool:
        try:
            size = round_size(size, sz_dec)
            if size <= 0:
                self.log("warning", f"[{coin}] Market order size rounds to 0")
                return False
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"},
                                         headers={"Content-Type": "application/json"})
                mids = resp.json()
            coin_short = coin.split(":")[-1] if ":" in coin else coin
            mid = float(mids.get(coin_short) or mids.get(coin) or 0)
            if mid <= 0:
                self.log("warning", f"[{coin}] Could not fetch mid price")
                return False
            limit_px = round_price(mid * 1.01 if is_buy else mid * 0.99)
            notional = size * limit_px
            if notional < 10.0:
                self.log("warning", f"[{coin}] Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={limit_px})")
                return False
            result   = await asyncio.to_thread(
                self._exchange.order, coin, is_buy, size, limit_px,
                {"limit": {"tif": "Ioc"}}, False,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"[{coin}] Market order rejected: {status['error']}")
                return False
            self.log("info", f"[{coin}] {'Buy' if is_buy else 'Sell'} IOC sz={size} @ ~{limit_px:.4f}")
            return True
        except Exception as e:
            self.log("error", f"[{coin}] Market order failed: {e}")
            return False

    async def _sc_dca_limit(self, coin: str, sz_dec: int, is_buy: bool, size: float, price: float) -> Optional[int]:
        try:
            size  = round_size(size, sz_dec)
            if size <= 0: return None
            price = round_price(price)
            notional = size * price
            if notional < 10.0:
                self.log("warning", f"[{coin}] Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={price})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}}, False,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"[{coin}] DCA limit rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"[{coin}] {'Buy' if is_buy else 'Sell'} DCA @ {price} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"[{coin}] DCA limit failed: {e}")
            return None

    async def _sc_reduce_limit(self, coin: str, sz_dec: int, is_buy: bool, size: float, price: float) -> Optional[int]:
        try:
            size  = round_size(size, sz_dec)
            if size <= 0: return None
            price = round_price(price)
            notional = size * price
            if notional < 10.0:
                self.log("warning", f"[{coin}] Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={price})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}}, True,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"[{coin}] TP limit rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"[{coin}] {'Buy' if is_buy else 'Sell'} TP @ {price} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"[{coin}] TP limit failed: {e}")
            return None

    async def _sc_stop_market(self, coin: str, sz_dec: int, is_buy: bool, size: float, trigger_px: float) -> Optional[int]:
        try:
            size       = round_size(size, sz_dec)
            if size <= 0: return None
            trigger_px = round_price(trigger_px)
            notional = size * trigger_px
            if notional < 10.0:
                self.log("warning", f"[{coin}] Skipping order: notional=${notional:.2f} < $10 minimum (size={size}, price={trigger_px})")
                return None
            result = await asyncio.to_thread(
                self._exchange.order, coin, is_buy, size, trigger_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": True, "tpsl": "sl"}}, True,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"[{coin}] Stop-market rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"[{coin}] {'Buy' if is_buy else 'Sell'} stop @ {trigger_px} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"[{coin}] Stop-market failed: {e}")
            return None

    def _sc_trailing_sl(self, pair_st: dict, is_long: bool, cur_price: float) -> float:
        """Update peak for a pair and return new trailing SL price."""
        if pair_st["peak_price"] is None:
            pair_st["peak_price"] = cur_price
        if is_long:
            pair_st["peak_price"] = max(pair_st["peak_price"], cur_price)
            sl = pair_st["peak_price"] * (1.0 - self.trailing_stop_pct / 100.0)
        else:
            pair_st["peak_price"] = min(pair_st["peak_price"], cur_price)
            sl = pair_st["peak_price"] * (1.0 + self.trailing_stop_pct / 100.0)
        return sl

    async def _sc_modify_sl(self, coin: str, sz_dec: int, pair_st: dict,
                             is_buy: bool, size: float, new_sl_px: float) -> None:
        new_sl_px  = round_price(new_sl_px)
        size       = round_size(size, sz_dec)
        if size <= 0: return
        order_type = {"trigger": {"triggerPx": new_sl_px, "isMarket": True, "tpsl": "sl"}}
        sl_oid = pair_st["sl_oid"]
        if sl_oid is not None:
            try:
                result = await asyncio.to_thread(
                    self._exchange.modify_order,
                    sl_oid, coin, is_buy, size, new_sl_px, order_type, True,
                )
                statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
                status   = statuses[0] if statuses else {}
                if "error" in status:
                    self.log("info", f"[{coin}] SL modify failed — replacing")
                    pair_st["sl_oid"] = None
                    pair_st["sl_oid"] = await self._sc_stop_market(coin, sz_dec, is_buy, size, new_sl_px)
                else:
                    new_oid = (status.get("resting") or {}).get("oid") or sl_oid
                    self.log("info", f"[{coin}] Trailing SL → {new_sl_px:.4f} oid={new_oid}")
                    pair_st["sl_oid"] = new_oid
            except Exception as e:
                self.log("warning", f"[{coin}] SL modify exception ({e}) — replacing")
                pair_st["sl_oid"] = None
                pair_st["sl_oid"] = await self._sc_stop_market(coin, sz_dec, is_buy, size, new_sl_px)
        else:
            pair_st["sl_oid"] = await self._sc_stop_market(coin, sz_dec, is_buy, size, new_sl_px)

    async def _sc_enter(self, coin: str, sz_dec: int, pair_st: dict,
                        is_long: bool, cur_price: float, alloc: float) -> None:
        """Market entry for a scan pair → 2s wait → DCA limits + TP + initial SL."""
        side_str   = "Long" if is_long else "Short"
        initial_sz = (_FIB_WEIGHTS[0] * alloc * self.leverage) / cur_price

        success = await self._sc_market_order(coin, sz_dec, is_long, initial_sz)
        if not success:
            return

        await asyncio.sleep(2)

        all_pos  = await self._sc_fetch_all_positions()
        real_pos = all_pos.get(coin, {"szi": 0.0, "entry_px": 0.0})
        if real_pos["szi"] == 0.0:
            self.log("warning", f"[{coin}] {side_str} entry not confirmed after 2s")
            return

        entry_px = real_pos["entry_px"] or cur_price
        pair_st["in_long"]     = is_long
        pair_st["entry_price"] = entry_px
        pair_st["peak_price"]  = entry_px

        close_buy  = not is_long
        current_sz = round_size(abs(real_pos["szi"]), sz_dec)

        for j, dca_pct in enumerate(self.dca_pcts):
            dca_px = (entry_px * (1 - dca_pct / 100) if is_long
                      else entry_px * (1 + dca_pct / 100))
            dca_sz = (_FIB_WEIGHTS[j + 1] * alloc * self.leverage) / dca_px
            await self._sc_dca_limit(coin, sz_dec, is_long, dca_sz, dca_px)

        tp_px = (entry_px * (1 + self.tp_pct / 100) if is_long
                 else entry_px * (1 - self.tp_pct / 100))
        await self._sc_reduce_limit(coin, sz_dec, close_buy, current_sz, tp_px)

        sl_px = (entry_px * (1 - self.trailing_stop_pct / 100) if is_long
                 else entry_px * (1 + self.trailing_stop_pct / 100))
        pair_st["sl_oid"] = await self._sc_stop_market(coin, sz_dec, close_buy, current_sz, sl_px)

        self.log("info", (
            f"[{coin}] {side_str} entered — entry={entry_px:.4f} sz={current_sz} "
            f"tp={tp_px:.4f} sl={sl_px:.4f} sl_oid={pair_st['sl_oid']}"
        ))

    # ── Scanner tick ──────────────────────────────────────────────────────────

    async def _scan_tick(self) -> None:
        fetch_limit = max(self.ema_period + self.rsi_period + 20, 230)

        # Parallel: positions + orders + all candle sets
        candle_tasks = [self._sc_fetch_candles(c, fetch_limit) for c in self._scan_coins]
        results = await asyncio.gather(
            self._sc_fetch_all_positions(),
            self._sc_fetch_all_orders(),
            *candle_tasks,
            return_exceptions=True,
        )
        all_positions = results[0] if not isinstance(results[0], Exception) else {}
        all_orders    = results[1] if not isinstance(results[1], Exception) else {}
        all_candles   = results[2:]

        active_count = sum(
            1 for c in self._scan_coins
            if isinstance(all_positions.get(c), dict) and all_positions[c]["szi"] != 0.0
        )

        pairs_with_position: list = []

        for idx, coin in enumerate(self._scan_coins):
            sz_dec    = self._scan_sz_dec.get(coin, 3)
            pair_st   = self._pair_state[coin]
            orders    = all_orders.get(coin, []) if isinstance(all_orders, dict) else []
            real_pos  = (all_positions.get(coin, {"szi": 0.0, "entry_px": 0.0})
                         if isinstance(all_positions, dict) else {"szi": 0.0, "entry_px": 0.0})
            candles   = all_candles[idx] if isinstance(all_candles[idx], list) else []

            real_szi      = real_pos["szi"]
            real_entry_px = real_pos["entry_px"]
            has_long      = real_szi > 0
            has_short     = real_szi < 0
            has_pos       = has_long or has_short

            if len(candles) < self.ema_period + self.rsi_period + 5:
                self.log("warning", f"[{coin}] Not enough candles — skipping")
                continue

            closes     = [c["close"] for c in candles]
            cur_price  = closes[-1]
            rsi_vals   = compute_rsi(closes, self.rsi_period)
            ema_vals   = compute_ema(closes, self.ema_period)
            rsi_prev   = rsi_vals[-2]
            ema_prev   = ema_vals[-2]
            close_prev = closes[-2]

            long_signal  = (rsi_prev is not None and ema_prev is not None
                            and rsi_prev > self.rsi_overbought and close_prev > ema_prev)
            short_signal = (rsi_prev is not None and ema_prev is not None
                            and rsi_prev < self.rsi_oversold  and close_prev < ema_prev)

            self.log("info", (
                f"[{coin}] price={cur_price:.4f} "
                f"rsi={f'{rsi_prev:.1f}' if rsi_prev is not None else 'N/A'} "
                f"ema={f'{ema_prev:.4f}' if ema_prev is not None else 'N/A'} "
                f"szi={real_szi} long={long_signal} short={short_signal}"
            ))

            # Cancel non-SL orders
            await self._sc_cancel_orders(coin, orders, pair_st["sl_oid"])

            if not has_pos:
                if pair_st["sl_oid"] is not None:
                    try:
                        await asyncio.to_thread(self._exchange.cancel, coin, pair_st["sl_oid"])
                    except Exception:
                        pass
                    pair_st["sl_oid"] = None
                pair_st["trailing_activated"] = False
                pair_st["peak_price"]         = None
                pair_st["entry_price"]         = None
                pair_st["in_long"]             = None

                alloc = self.allocated_usdc / max(active_count + 1, 1)
                if "long" in self.sides and long_signal:
                    self.log("info", f"[{coin}] Long signal — entering (alloc=${alloc:.2f})")
                    await self._sc_enter(coin, sz_dec, pair_st, True, cur_price, alloc)
                    active_count += 1
                elif "short" in self.sides and short_signal:
                    self.log("info", f"[{coin}] Short signal — entering (alloc=${alloc:.2f})")
                    await self._sc_enter(coin, sz_dec, pair_st, False, cur_price, alloc)
                    active_count += 1
            else:
                is_long   = has_long
                close_buy = not is_long

                if pair_st["entry_price"] is None:
                    pair_st["entry_price"] = real_entry_px
                    pair_st["in_long"]     = is_long

                entry_px  = pair_st["entry_price"]
                close_sz  = round_size(abs(real_szi), sz_dec)
                alloc     = self.allocated_usdc / max(active_count, 1)

                tp_px = (entry_px * (1 + self.tp_pct / 100) if is_long
                         else entry_px * (1 - self.tp_pct / 100))
                await self._sc_reduce_limit(coin, sz_dec, close_buy, close_sz, tp_px)

                activation_price = (entry_px * (1 + self.trailing_stop_pct / 100) if is_long
                                    else entry_px * (1 - self.trailing_stop_pct / 100))

                if not pair_st["trailing_activated"]:
                    activated = ((is_long     and cur_price >= activation_price) or
                                 (not is_long and cur_price <= activation_price))
                    if activated:
                        # ── Phase 2: activation ───────────────────────────────
                        pair_st["trailing_activated"] = True
                        if pair_st["sl_oid"] is not None:
                            try:
                                await asyncio.to_thread(
                                    self._exchange.cancel, coin, pair_st["sl_oid"])
                            except Exception:
                                pass
                            pair_st["sl_oid"] = None
                        pair_st["peak_price"] = cur_price
                        be_sl = entry_px  # move SL to break-even
                        pair_st["sl_oid"] = await self._sc_stop_market(
                            coin, sz_dec, close_buy, close_sz, be_sl)
                        self.log("info", (
                            f"[{coin}] Trailing ACTIVATED at {cur_price:.4f} "
                            f"— SL moved to break-even {entry_px:.4f}"
                        ))
                    else:
                        # ── Phase 1: waiting for activation ───────────────────
                        self.log("info", (
                            f"[{coin}] Trailing not activated yet "
                            f"— price={cur_price:.4f} target={activation_price:.4f}"
                        ))
                        fixed_sl = (entry_px * (1 - self.trailing_stop_pct / 100) if is_long
                                    else entry_px * (1 + self.trailing_stop_pct / 100))
                        await self._sc_modify_sl(
                            coin, sz_dec, pair_st, close_buy, close_sz, fixed_sl)
                        # DCA re-place
                        n_dca      = len(self.dca_pcts)
                        buy_count  = sum(1 for o in orders
                                         if o.get("side") == "B" and not o.get("reduceOnly", False))
                        sell_count = sum(1 for o in orders
                                         if o.get("side") == "A" and not o.get("reduceOnly", False))
                        if is_long:
                            dca_start = max(0, n_dca - buy_count)
                            for j in range(dca_start, n_dca):
                                dca_px = entry_px * (1 - self.dca_pcts[j] / 100)
                                dca_sz = (_FIB_WEIGHTS[j + 1] * alloc * self.leverage) / dca_px
                                await self._sc_dca_limit(coin, sz_dec, True, dca_sz, dca_px)
                        else:
                            dca_start = max(0, n_dca - sell_count)
                            for j in range(dca_start, n_dca):
                                dca_px = entry_px * (1 + self.dca_pcts[j] / 100)
                                dca_sz = (_FIB_WEIGHTS[j + 1] * alloc * self.leverage) / dca_px
                                await self._sc_dca_limit(coin, sz_dec, False, dca_sz, dca_px)
                else:
                    # ── Phase 3: trailing active ──────────────────────────────
                    trailing_sl = self._sc_trailing_sl(pair_st, is_long, cur_price)
                    # Break-even floor: SL never retreats below entry
                    trailing_sl = (max(trailing_sl, entry_px) if is_long
                                   else min(trailing_sl, entry_px))
                    self.log("info", (
                        f"[{coin}] Trailing SL updated: "
                        f"peak={pair_st['peak_price']:.4f} sl={trailing_sl:.4f}"
                    ))
                    await self._sc_modify_sl(
                        coin, sz_dec, pair_st, close_buy, close_sz, trailing_sl)

                pairs_with_position.append(coin)

        # 3s re-check for TP fills
        if pairs_with_position:
            await asyncio.sleep(3)
            rechk = await self._sc_fetch_all_positions()
            for coin in pairs_with_position:
                pos = rechk.get(coin, {"szi": 0.0, "entry_px": 0.0})
                if pos["szi"] == 0.0:
                    self.log("info", f"[{coin}] TP fill detected — resetting")
                    pair_st = self._pair_state[coin]
                    if pair_st["sl_oid"] is not None:
                        try:
                            await asyncio.to_thread(self._exchange.cancel, coin, pair_st["sl_oid"])
                        except Exception:
                            pass
                        pair_st["sl_oid"] = None
                    pair_st["trailing_activated"] = False
                    pair_st["peak_price"]         = None
                    pair_st["entry_price"]         = None
                    pair_st["in_long"]             = None

    # ── Scanner main loop ─────────────────────────────────────────────────────

    async def _run_scanner(self) -> None:
        """Initialize all scan pairs then run _scan_tick every candle close."""
        self._scan_coins = [
            f"{self.dex}:{sym}" if self.dex else sym
            for sym in self.scan_symbols
        ]

        if not self._scan_coins:
            self.log("error", "Scanner started with empty scan_symbols — aborting")
            return

        self.log("info", (
            f"Trend Magic Scanner starting — {len(self._scan_coins)} pairs: {self._scan_coins} | "
            f"{self.interval} | RSI({self.rsi_period}) | EMA({self.ema_period}) | "
            f"TP={self.tp_pct}% | TSL={self.trailing_stop_pct}% | "
            f"Sides={self.sides} | Total alloc=${self.allocated_usdc}"
        ))

        for coin in self._scan_coins:
            self._pair_state[coin] = {
                "in_long":            None,
                "entry_price":        None,
                "peak_price":         None,
                "sl_oid":             None,
                "trailing_activated": False,
            }

        # Parallel: fetch sz_decimals + set leverage for every pair
        sz_results = await asyncio.gather(
            *[self._sc_get_sz_decimals(c) for c in self._scan_coins],
            return_exceptions=True,
        )
        await asyncio.gather(
            *[self._sc_set_leverage(c) for c in self._scan_coins],
            return_exceptions=True,
        )
        for i, coin in enumerate(self._scan_coins):
            self._scan_sz_dec[coin] = (
                int(sz_results[i]) if not isinstance(sz_results[i], Exception) else 3
            )

        while self._running:
            try:
                await self._scan_tick()
            except asyncio.CancelledError:
                self.log("info", "Scanner cancelled — cleaning up...")
                try:
                    all_orders = await self._sc_fetch_all_orders()
                    for coin in self._scan_coins:
                        for order in all_orders.get(coin, []):
                            oid = order.get("oid")
                            if oid:
                                try:
                                    await asyncio.to_thread(self._exchange.cancel, coin, oid)
                                except Exception:
                                    pass
                except Exception:
                    pass
                break
            except Exception as e:
                self.log("error", f"Scanner tick error: {e}")

            sleep_secs = self._seconds_until_next_candle()
            self.log("info", f"Scanner sleeping {sleep_secs:.0f}s until next {self.interval} candle")
            await asyncio.sleep(sleep_secs)

        self._running = False
        self.log("info", "Trend Magic Scanner stopped.")

    # ── Entry ─────────────────────────────────────────────────────────────────

    async def _enter_position(self, is_long: bool, cur_price: float) -> None:
        """Market entry → 2s wait → place DCA limits + TP + initial SL."""
        side_str   = "Long" if is_long else "Short"
        initial_sz = (_FIB_WEIGHTS[0] * self.allocated_usdc * self.leverage) / cur_price

        success = await self._place_market_order(is_long, initial_sz)
        if not success:
            return

        await asyncio.sleep(2)

        real_pos = await self._fetch_real_position()
        if real_pos["szi"] == 0.0:
            self.log("warning", f"{side_str} market entry — position not confirmed after 2s")
            return

        entry_px = real_pos["entry_px"] or cur_price
        self._entry_price = entry_px
        self._peak_price  = entry_px
        self._in_long     = is_long

        close_buy  = not is_long
        current_sz = round_size(abs(real_pos["szi"]), self.sz_decimals)

        # DCA limit orders (not reduce-only)
        for j, dca_pct in enumerate(self.dca_pcts):
            dca_px = (entry_px * (1 - dca_pct / 100) if is_long
                      else entry_px * (1 + dca_pct / 100))
            dca_sz = (_FIB_WEIGHTS[j + 1] * self.allocated_usdc * self.leverage) / dca_px
            await self._place_limit_dca(is_long, dca_sz, dca_px)

        # TP — reduce-only limit
        tp_px = (entry_px * (1 + self.tp_pct / 100) if is_long
                 else entry_px * (1 - self.tp_pct / 100))
        await self._place_limit_reduce(close_buy, current_sz, tp_px)

        # Initial SL — stop-market, reduce-only
        sl_px = (entry_px * (1 - self.trailing_stop_pct / 100) if is_long
                 else entry_px * (1 + self.trailing_stop_pct / 100))
        new_oid = await self._place_stop_market(close_buy, current_sz, sl_px)
        self._sl_oid = new_oid

        self.log("info", (
            f"{side_str} entered — entry={entry_px:.4f} sz={current_sz} "
            f"tp={tp_px:.4f} sl={sl_px:.4f} sl_oid={self._sl_oid}"
        ))

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def _run_single(self):
        """Single-pair loop — runs until cancelled."""
        await self._set_leverage()

        fetch_limit = max(self.ema_period + self.rsi_period + 20, 230)

        self.log("info", (
            f"Trend Magic Bot started — {self.coin} | {self.interval} | "
            f"RSI({self.rsi_period}) ob={self.rsi_overbought} os={self.rsi_oversold} | "
            f"EMA({self.ema_period}) | DCA={self.dca_pcts}% | TP={self.tp_pct}% | "
            f"TSL={self.trailing_stop_pct}% | Sides={self.sides} | "
            f"Allocation=${self.allocated_usdc} | Leverage={self.leverage}x"
        ))

        # ── Minimum notional check at startup ────────────────────────────────
        for lvl, weight in enumerate(_FIB_WEIGHTS):
            level_notional = weight * self.allocated_usdc * self.leverage
            if level_notional < 10.0:
                min_alloc = 10.0 / weight / max(self.leverage, 1)
                self.log("warning", (
                    f"Level {lvl} notional ${level_notional:.2f} below $10 minimum. "
                    f"Increase allocation to at least ${min_alloc:.0f} USDC"
                ))

        while self._running:
            try:
                # ── 1. Count open DCA orders before cancelling ────────────────
                canceled_buy, canceled_sell = await self._count_open_dca_orders()
                self.log("info", f"Pre-cancel — dca_buy={canceled_buy} dca_sell={canceled_sell}")

                # ── 2. Cancel all orders (except SL) ─────────────────────────
                await self._cancel_all_orders()

                # ── 3. Fetch position + candles in parallel ───────────────────
                real_pos, candles = await asyncio.gather(
                    self._fetch_real_position(),
                    self._fetch_candles(fetch_limit),
                )

                real_szi      = real_pos["szi"]
                real_entry_px = real_pos["entry_px"]
                has_long      = real_szi > 0
                has_short     = real_szi < 0
                has_pos       = has_long or has_short

                if len(candles) < self.ema_period + self.rsi_period + 5:
                    self.log("warning", "Not enough candles — waiting 5 min...")
                    await asyncio.sleep(300)
                    continue

                # ── 4. Compute RSI + EMA ──────────────────────────────────────
                closes    = [c["close"] for c in candles]
                cur_price = closes[-1]

                rsi_vals = compute_rsi(closes, self.rsi_period)
                ema_vals = compute_ema(closes, self.ema_period)

                rsi_prev   = rsi_vals[-2]
                ema_prev   = ema_vals[-2]
                close_prev = closes[-2]

                # ── 5. Signals on last closed candle (candles[-2]) ────────────
                long_signal  = (rsi_prev is not None and ema_prev is not None
                                and rsi_prev > self.rsi_overbought
                                and close_prev > ema_prev)
                short_signal = (rsi_prev is not None and ema_prev is not None
                                and rsi_prev < self.rsi_oversold
                                and close_prev < ema_prev)

                self.log("info", (
                    f"Tick — price={cur_price:.4f} "
                    f"rsi={f'{rsi_prev:.1f}' if rsi_prev is not None else 'N/A'} "
                    f"ema={f'{ema_prev:.4f}' if ema_prev is not None else 'N/A'} "
                    f"szi={real_szi} long_sig={long_signal} short_sig={short_signal}"
                ))

                # ── 6. Position management ────────────────────────────────────
                if not has_pos:
                    # Cancel any stale SL from a previous position
                    if self._sl_oid is not None:
                        try:
                            await asyncio.to_thread(self._exchange.cancel, self.coin, self._sl_oid)
                        except Exception:
                            pass  # may already be gone
                        self._sl_oid = None
                    self._trailing_activated = False
                    self._peak_price         = None
                    self._entry_price        = None
                    self._in_long            = None

                    if "long" in self.sides and long_signal:
                        self.log("info", "Long signal — entering position")
                        await self._enter_position(True, cur_price)
                    elif "short" in self.sides and short_signal:
                        self.log("info", "Short signal — entering position")
                        await self._enter_position(False, cur_price)

                else:
                    is_long   = has_long
                    close_buy = not is_long

                    # Sync entry price on first tick with position (e.g. after restart)
                    if self._entry_price is None:
                        self._entry_price = real_entry_px
                        self._in_long     = is_long

                    entry_px  = self._entry_price
                    close_sz  = round_size(abs(real_szi), self.sz_decimals)

                    # TP — reduce-only limit at entry ± tp_pct
                    tp_px = (entry_px * (1 + self.tp_pct / 100) if is_long
                             else entry_px * (1 - self.tp_pct / 100))
                    await self._place_limit_reduce(close_buy, close_sz, tp_px)

                    activation_price = (entry_px * (1 + self.trailing_stop_pct / 100) if is_long
                                        else entry_px * (1 - self.trailing_stop_pct / 100))

                    if not self._trailing_activated:
                        activated = ((is_long     and cur_price >= activation_price) or
                                     (not is_long and cur_price <= activation_price))
                        if activated:
                            # ── Phase 2: activation ───────────────────────────
                            self._trailing_activated = True
                            if self._sl_oid is not None:
                                try:
                                    await asyncio.to_thread(
                                        self._exchange.cancel, self.coin, self._sl_oid)
                                except Exception:
                                    pass
                                self._sl_oid = None
                            self._peak_price = cur_price
                            be_sl = entry_px  # move SL to break-even
                            new_oid = await self._place_stop_market(close_buy, close_sz, be_sl)
                            self._sl_oid = new_oid
                            self.log("info", (
                                f"Trailing ACTIVATED at {cur_price:.4f} "
                                f"— SL moved to break-even {entry_px:.4f}"
                            ))
                        else:
                            # ── Phase 1: waiting for activation ───────────────
                            self.log("info", (
                                f"Trailing not activated yet "
                                f"— price={cur_price:.4f} target={activation_price:.4f}"
                            ))
                            fixed_sl = (entry_px * (1 - self.trailing_stop_pct / 100) if is_long
                                        else entry_px * (1 + self.trailing_stop_pct / 100))
                            await self._modify_or_replace_sl(close_buy, close_sz, fixed_sl)
                            # DCA re-place (only in Phase 1)
                            n_dca = len(self.dca_pcts)
                            if is_long:
                                dca_start = max(0, n_dca - canceled_buy)
                                for j in range(dca_start, n_dca):
                                    dca_px = entry_px * (1 - self.dca_pcts[j] / 100)
                                    dca_sz = (_FIB_WEIGHTS[j + 1] * self.allocated_usdc
                                              * self.leverage) / dca_px
                                    await self._place_limit_dca(True, dca_sz, dca_px)
                            else:
                                dca_start = max(0, n_dca - canceled_sell)
                                for j in range(dca_start, n_dca):
                                    dca_px = entry_px * (1 + self.dca_pcts[j] / 100)
                                    dca_sz = (_FIB_WEIGHTS[j + 1] * self.allocated_usdc
                                              * self.leverage) / dca_px
                                    await self._place_limit_dca(False, dca_sz, dca_px)
                    else:
                        # ── Phase 3: trailing active ──────────────────────────
                        trailing_sl = self._get_trailing_sl(is_long, cur_price)
                        # Break-even floor: SL never retreats below entry
                        trailing_sl = (max(trailing_sl, entry_px) if is_long
                                       else min(trailing_sl, entry_px))
                        await self._modify_or_replace_sl(close_buy, close_sz, trailing_sl)

                    # ── 3s re-check: detect immediate TP fill ─────────────────
                    await asyncio.sleep(3)
                    pos_recheck = await self._fetch_real_position()
                    if pos_recheck["szi"] == 0.0:
                        self.log("info", "TP fill detected — resetting position state")
                        if self._sl_oid is not None:
                            try:
                                await asyncio.to_thread(
                                    self._exchange.cancel, self.coin, self._sl_oid)
                            except Exception:
                                pass  # exchange auto-cancels reduce-only on flat
                            self._sl_oid = None
                        self._trailing_activated = False
                        self._peak_price         = None
                        self._entry_price        = None
                        self._in_long            = None

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cleaning up...")
                await self._cancel_all_orders()
                if self._sl_oid is not None:
                    try:
                        await asyncio.to_thread(self._exchange.cancel, self.coin, self._sl_oid)
                    except Exception:
                        pass
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            sleep_secs = self._seconds_until_next_candle()
            self.log("info", f"Sleeping {sleep_secs:.0f}s until next {self.interval} candle close")
            await asyncio.sleep(sleep_secs)

        self._running = False
        self.log("info", "Trend Magic Bot stopped.")

    async def run(self):
        """Dispatcher — routes to scanner or single-pair loop."""
        self._running = True
        self._init_exchange()
        if self.scan_pairs and self.scan_symbols:
            await self._run_scanner()
        else:
            await self._run_single()
