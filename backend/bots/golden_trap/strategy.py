"""
Golden Trap Bot — Enhanced Envelope DCA for Hyperliquid.

Four improvements over the standard Envelope DCA Bot:
  1. Fibonacci position sizing: deeper DCA levels receive larger allocation slices.
  2. MA200 trend filter: limits entry side to the trend direction each candle.
  3. Immediate re-entry: detects same-tick TP fill and instantly re-places entries.
  4. Trailing stop: fixed-% or ATR-based, with original fixed SL as hard floor.
"""
from __future__ import annotations
import asyncio
import math
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"

from bots.envelope.strategy import compute_sma, round_price, round_size


# ── Fibonacci weights ──────────────────────────────────────────────────────────

_FIB_PRESETS: dict[int, list[float]] = {
    2: [0.35, 0.65],
    3: [0.15, 0.35, 0.50],
    4: [0.10, 0.20, 0.30, 0.40],
}


def fibonacci_weights(n: int) -> list[float]:
    """Return allocation weights for n DCA levels (level 0 = closest, level n-1 = deepest)."""
    if n in _FIB_PRESETS:
        return _FIB_PRESETS[n]
    # Geometric progression for other counts, normalised to 1.0
    w = [1.5 ** i for i in range(n)]
    total = sum(w)
    return [round(x / total, 6) for x in w]


# ── Bot class ─────────────────────────────────────────────────────────────────

class GoldenTrapBot:
    """
    Live Golden Trap bot for Hyperliquid.
    Runs as an asyncio coroutine — call await bot.run() to start.
    """

    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        ma_period: int,
        envelopes: list[float],         # e.g. [0.07, 0.10, 0.15]
        stop_loss_pct: float,           # e.g. 10.0 = 10%
        sz_decimals: int,
        leverage: int = 1,
        interval: str = "4h",
        dex: Optional[str] = None,
        sides: Optional[list[str]] = None,
        trailing_stop_type: str = "fixed",     # "fixed" | "atr" | "none"
        trailing_stop_pct: float = 2.0,
        trailing_stop_atr_mult: float = 1.5,
        log_callback=None,
    ):
        self.private_key       = private_key
        self.master_address    = master_address
        self.coin              = coin
        self.allocated_usdc    = allocated_usdc
        self.ma_period         = ma_period
        self.envelopes         = [e for e in envelopes if e > 0]
        self.stop_loss_pct     = stop_loss_pct
        self.sz_decimals       = sz_decimals
        self.leverage          = leverage
        self.interval          = interval
        self.dex               = dex
        self.sides             = [s.lower() for s in (sides or ["long"])]
        self.trailing_stop_type      = trailing_stop_type
        self.trailing_stop_pct       = trailing_stop_pct
        self.trailing_stop_atr_mult  = trailing_stop_atr_mult
        self.log               = log_callback or (lambda level, msg: None)
        self._running          = False
        self._exchange         = None

        interval_ms_map = {
            "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
            "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
        }
        self._interval_ms = interval_ms_map.get(interval, 14_400_000)

        # Trailing stop state — reset when position closes
        self._peak_price:  float | None = None
        self._original_sl: float | None = None

    # ── Fibonacci sizing ──────────────────────────────────────────────────────

    def _per_level_usdc(self) -> list[float]:
        n = len(self.envelopes)
        return [self.allocated_usdc * w for w in fibonacci_weights(n)]

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
        now_ms = int(time.time() * 1000)
        next_ms = ((now_ms // self._interval_ms) + 1) * self._interval_ms
        return max((next_ms - now_ms) / 1000.0, 1.0)

    # ── Data fetching ─────────────────────────────────────────────────────────

    async def _fetch_candles(self, limit: int = 210) -> list[dict]:
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
                    "szi":            szi,
                    "entry_px":       float(pos.get("entryPx", "0") or "0"),
                    "unrealized_pnl": float(pos.get("unrealizedPnl", "0") or "0"),
                }
        except Exception as e:
            self.log("warning", f"Failed to fetch real position: {e}")
        return {"szi": 0.0, "entry_px": 0.0, "unrealized_pnl": 0.0}

    # ── Order management ──────────────────────────────────────────────────────

    async def _cancel_all_orders(self):
        coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address})
                orders = resp.json()
            if not isinstance(orders, list): return
            for order in [o for o in orders if isinstance(o, dict) and o.get("coin") in (self.coin, coin_short)]:
                oid = order.get("oid")
                if oid:
                    try:
                        await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
                        self.log("info", f"Cancelled order {oid}")
                    except Exception as e:
                        self.log("warning", f"Failed to cancel {oid}: {e}")
        except Exception as e:
            self.log("warning", f"Cancel all orders failed: {e}")

    async def _count_open_entry_orders(self) -> tuple[int, int]:
        coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address})
                orders = resp.json()
            if not isinstance(orders, list): return 0, 0
            coin_orders = [o for o in orders if isinstance(o, dict) and o.get("coin") in (self.coin, coin_short)]
            buy_count  = sum(1 for o in coin_orders if o.get("side") == "B" and not o.get("reduceOnly", False))
            sell_count = sum(1 for o in coin_orders if o.get("side") == "A" and not o.get("reduceOnly", False))
            return buy_count, sell_count
        except Exception as e:
            self.log("warning", f"Count open entry orders failed: {e}")
            return 0, 0

    async def _place_trigger_entry(self, is_buy: bool, size: float,
                                   limit_px: float, trigger_px: float,
                                   tpsl_type: str) -> Optional[int]:
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                self.log("warning", f"Entry size rounds to 0 (limit={limit_px:.4f}) — skipping")
                return None
            limit_px   = round_price(limit_px)
            trigger_px = round_price(trigger_px)
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, limit_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": False, "tpsl": tpsl_type}},
                False,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Trigger entry rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"{'Buy' if is_buy else 'Sell'} trigger: {size} @ "
                              f"limit={round_price(limit_px)} trigger={round_price(trigger_px)} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"Trigger entry placement failed: {e}")
            return None

    async def _place_stop_market(self, is_buy: bool, size: float, trigger_px: float) -> Optional[int]:
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0: return None
            trigger_px = round_price(trigger_px)
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
            self.log("info", f"{'Buy' if is_buy else 'Sell'} stop-market @ trigger={trigger_px} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"Stop-market placement failed: {e}")
            return None

    async def _place_limit_reduce(self, is_buy: bool, size: float, price: float) -> Optional[int]:
        try:
            size  = round_size(size, self.sz_decimals)
            if size <= 0: return None
            price = round_price(price)
            result = await asyncio.to_thread(
                self._exchange.order, self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
                True,
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Limit reduce rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            self.log("info", f"{'Buy' if is_buy else 'Sell'} limit reduce @ {price} oid={oid}")
            return oid
        except Exception as e:
            self.log("error", f"Limit reduce placement failed: {e}")
            return None

    # ── Trailing stop ─────────────────────────────────────────────────────────

    def _compute_atr14(self, candles: list[dict]) -> float:
        """ATR14 approximation: average of last 14 candles' (high − low)."""
        recent = candles[-14:] if len(candles) >= 14 else candles
        return sum(c["high"] - c["low"] for c in recent) / len(recent) if recent else 0.0

    def _get_trailing_sl(self, is_long: bool, cur_price: float, candles: list[dict]) -> float | None:
        """Compute trailing stop price, updating peak and flooring at original SL."""
        if self.trailing_stop_type == "none":
            return None

        if self._peak_price is None:
            self._peak_price = cur_price

        # Update peak
        if is_long:
            self._peak_price = max(self._peak_price, cur_price)
        else:
            self._peak_price = min(self._peak_price, cur_price)

        peak = self._peak_price

        if self.trailing_stop_type == "fixed":
            sl = peak * (1.0 - self.trailing_stop_pct / 100.0) if is_long else peak * (1.0 + self.trailing_stop_pct / 100.0)
        else:  # atr
            atr = self._compute_atr14(candles)
            sl  = (peak - atr * self.trailing_stop_atr_mult) if is_long else (peak + atr * self.trailing_stop_atr_mult)

        # Apply hard floor (never exceed original fixed SL for worse)
        if self._original_sl is not None:
            sl = max(sl, self._original_sl) if is_long else min(sl, self._original_sl)

        self.log("info", f"Trailing SL: peak={peak:.4f} sl={sl:.4f} (type={self.trailing_stop_type})")
        return sl

    # ── Flat entry placement helper ───────────────────────────────────────────

    async def _place_flat_entries(self, ma_base: float, n_levels: int,
                                  per_lvl: list[float], active_sides: list[str]):
        """Place ALL entry levels for configured active sides (flat or immediate re-entry)."""
        if "long" in active_sides:
            for i in range(n_levels):
                env        = self.envelopes[i]
                limit_px   = ma_base * (1.0 - env)
                trigger_px = limit_px * 1.005
                size       = (per_lvl[i] * self.leverage) / limit_px
                self.log("info", f"Flat long L{i}: env={env:.3f} limit={round_price(limit_px):.4f} "
                                  f"sz={round_size(size, self.sz_decimals)} margin=${per_lvl[i]:.2f}")
                await self._place_trigger_entry(True, size, limit_px, trigger_px, "sl")

        if "short" in active_sides:
            for i in range(n_levels):
                env        = self.envelopes[i]
                high_env   = round(1.0 / (1.0 - env) - 1.0, 3)
                limit_px   = ma_base * (1.0 + high_env)
                trigger_px = limit_px * 0.995
                size       = (per_lvl[i] * self.leverage) / limit_px
                self.log("info", f"Flat short L{i}: env={env:.3f} limit={round_price(limit_px):.4f} "
                                  f"sz={round_size(size, self.sz_decimals)} margin=${per_lvl[i]:.2f}")
                await self._place_trigger_entry(False, size, limit_px, trigger_px, "tp")

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def run(self):
        """Main bot loop — runs indefinitely until cancelled."""
        self._running = True
        self._init_exchange()
        await self._set_leverage()

        n_levels = len(self.envelopes)
        per_lvl  = self._per_level_usdc()
        weights  = fibonacci_weights(n_levels)

        self.log("info", (
            f"Golden Trap Bot started — {self.coin} | {self.interval} | "
            f"MA={self.ma_period} | Envelopes={self.envelopes} | Sides={self.sides} | "
            f"Allocation=${self.allocated_usdc} | Leverage={self.leverage}x | "
            f"FibWeights={[round(w, 3) for w in weights]} | "
            f"TrailingStop={self.trailing_stop_type}"
        ))

        while self._running:
            try:
                # ── 1. Count pending entry orders BEFORE cancelling ───────────
                canceled_orders_buy, canceled_orders_sell = await self._count_open_entry_orders()
                self.log("info", f"Pre-cancel — buy={canceled_orders_buy} sell={canceled_orders_sell}")

                # ── 2. Cancel ALL open orders (clean slate) ───────────────────
                await self._cancel_all_orders()

                # ── 3. Fetch position + candles in parallel ───────────────────
                fetch_limit = max(self.ma_period + 10, 210)
                real_pos, candles = await asyncio.gather(
                    self._fetch_real_position(),
                    self._fetch_candles(limit=fetch_limit),
                )

                real_szi      = real_pos["szi"]
                real_entry_px = real_pos["entry_px"]
                has_long  = real_szi > 0
                has_short = real_szi < 0
                has_pos   = has_long or has_short

                if len(candles) < self.ma_period + 2:
                    self.log("warning", "Not enough candles — waiting 5 min...")
                    await asyncio.sleep(300)
                    continue

                # ── 4. Compute MA (shifted 1 bar) + MA200 (current) ──────────
                closes   = [c["close"] for c in candles]
                sma_vals = compute_sma(closes, self.ma_period)
                ma_base  = sma_vals[-2]
                cur_price = candles[-1]["close"]

                if ma_base is None:
                    self.log("warning", "MA not computable — waiting 5 min...")
                    await asyncio.sleep(300)
                    continue

                # MA200 trend filter — uses last 200 candles of the same interval
                ma200: float | None = None
                if len(closes) >= 200:
                    ma200 = sum(closes[-200:]) / 200

                # ── 5. Apply trend filter → active_sides ─────────────────────
                active_sides = list(self.sides)
                if ma200 is not None:
                    trend_bullish = cur_price > ma200
                    trend_bearish = cur_price < ma200
                    if trend_bullish:
                        active_sides = [s for s in self.sides if s == "long"]
                        self.log("info", f"Trend filter: MA200={ma200:.4f} Price={cur_price:.4f} → LONG only")
                    elif trend_bearish:
                        active_sides = [s for s in self.sides if s == "short"]
                        self.log("info", f"Trend filter: MA200={ma200:.4f} Price={cur_price:.4f} → SHORT only")
                    else:
                        self.log("info", f"Trend filter: MA200={ma200:.4f} Price={cur_price:.4f} → neutral")
                else:
                    self.log("info", "MA200 not yet computable — no trend filter")

                self.log("info", (
                    f"Tick — MA={ma_base:.4f} | MA200={f'{ma200:.4f}' if ma200 else 'N/A'} | "
                    f"Price={cur_price:.4f} | szi={real_szi} | active_sides={active_sides}"
                ))

                # ── 6. Update trailing stop peak on position change ───────────
                if has_pos:
                    is_long_pos = has_long
                    if self._peak_price is None:
                        # First tick with this position — initialize
                        self._peak_price  = cur_price
                        if self.stop_loss_pct > 0 and real_entry_px > 0:
                            self._original_sl = (
                                real_entry_px * (1.0 - self.stop_loss_pct / 100.0)
                                if is_long_pos else
                                real_entry_px * (1.0 + self.stop_loss_pct / 100.0)
                            )
                else:
                    # Position closed — reset trailing state
                    self._peak_price  = None
                    self._original_sl = None

                # ── 7. Manage open position (TP, trailing/fixed SL, DCA) ──────
                re_entry_done = False
                if has_pos:
                    is_long = has_long
                    close_sz     = round_size(abs(real_szi), self.sz_decimals)
                    close_is_buy = not is_long

                    # TP — reduce-only GTC limit at MA
                    await self._place_limit_reduce(close_is_buy, close_sz, ma_base)

                    # SL — trailing or fixed
                    if self.trailing_stop_type != "none":
                        trailing_sl = self._get_trailing_sl(is_long, cur_price, candles)
                        if trailing_sl is not None and trailing_sl > 0:
                            await self._place_stop_market(close_is_buy, close_sz, trailing_sl)
                    elif self.stop_loss_pct > 0 and real_entry_px > 0:
                        sl_px = (
                            real_entry_px * (1.0 - self.stop_loss_pct / 100.0)
                            if is_long else
                            real_entry_px * (1.0 + self.stop_loss_pct / 100.0)
                        )
                        await self._place_stop_market(close_is_buy, close_sz, sl_px)

                    # DCA entries — only for active sides
                    if "long" in active_sides and has_long:
                        long_start = max(0, n_levels - canceled_orders_buy)
                        for i in range(long_start, n_levels):
                            env        = self.envelopes[i]
                            limit_px   = ma_base * (1.0 - env)
                            trigger_px = limit_px * 1.005
                            size       = (per_lvl[i] * self.leverage) / limit_px
                            self.log("info", f"Long DCA L{i}: env={env:.3f} limit={round_price(limit_px):.4f} "
                                              f"sz={round_size(size, self.sz_decimals)} margin=${per_lvl[i]:.2f}")
                            await self._place_trigger_entry(True, size, limit_px, trigger_px, "sl")

                    if "short" in active_sides and has_short:
                        short_start = max(0, n_levels - canceled_orders_sell)
                        for i in range(short_start, n_levels):
                            env        = self.envelopes[i]
                            high_env   = round(1.0 / (1.0 - env) - 1.0, 3)
                            limit_px   = ma_base * (1.0 + high_env)
                            trigger_px = limit_px * 0.995
                            size       = (per_lvl[i] * self.leverage) / limit_px
                            self.log("info", f"Short DCA L{i}: env={env:.3f} limit={round_price(limit_px):.4f} "
                                              f"sz={round_size(size, self.sz_decimals)} margin=${per_lvl[i]:.2f}")
                            await self._place_trigger_entry(False, size, limit_px, trigger_px, "tp")

                    # ── Improvement 3: Immediate re-entry after TP fill ────────
                    # Wait briefly, then re-check position. If TP filled immediately
                    # (price was already at/above MA when we placed the TP order),
                    # szi will now be 0 — re-place all flat entries without sleeping.
                    await asyncio.sleep(3)
                    pos_recheck = await self._fetch_real_position()
                    if pos_recheck["szi"] == 0.0:
                        self.log("info", "Immediate TP fill detected — re-placing entry triggers")
                        self._peak_price  = None
                        self._original_sl = None
                        await self._place_flat_entries(ma_base, n_levels, per_lvl, active_sides)
                        re_entry_done = True

                # ── 8. Flat — place all entries for active sides ──────────────
                if not has_pos and not re_entry_done:
                    await self._place_flat_entries(ma_base, n_levels, per_lvl, active_sides)

                self.log("info", (
                    f"Tick complete — MA={ma_base:.4f} | Price={cur_price:.4f} | "
                    f"szi={real_szi} | re_entry={re_entry_done}"
                ))

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cleaning up...")
                await self._cancel_all_orders()
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            sleep_secs = self._seconds_until_next_candle()
            self.log("info", f"Sleeping {sleep_secs:.0f}s until next {self.interval} candle close")
            await asyncio.sleep(sleep_secs)

        self._running = False
        self.log("info", "Golden Trap Bot stopped.")
