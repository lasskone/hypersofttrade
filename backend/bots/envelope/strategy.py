"""
Envelope DCA Bot — live trading strategy for Hyperliquid.
Faithful port of CryptoRobotFr Live-Tools-V2 strategy, adapted from Bitget to Hyperliquid.

Strategy logic per candle close:
  1. Cancel ALL open orders for this coin (entries, TP, SL — clean slate each tick).
  2. Fetch real position from API.
  3. Compute SMA(close, ma_period) shifted 1 bar (no lookahead).
  4. If in position:
       - TP:  reduce-only GTC limit at ma_base
       - SL:  reduce-only stop-market at entry_price ± sl_pct%
  5. If NOT in position (per configured side):
       - Long  entries: trigger BUY at ma_base*(1 - env_i), trigger_px = limit*1.005
       - Short entries: trigger SELL at ma_base*(1 + high_env_i), trigger_px = limit*0.995
         where high_env_i = round(1/(1-env_i) - 1, 3)  (inverse of long envelope)
  6. Sleep until the next candle boundary (exact wall-clock alignment).

Sides config: "sides" param — ["long"], ["short"], or ["long", "short"].
Default: ["long"] for backward compatibility.
"""
from __future__ import annotations
import asyncio
import math
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"


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
        envelopes: list[float],      # e.g. [0.07, 0.10, 0.15]
        stop_loss_pct: float,        # percentage, e.g. 10.0 means 10%
        sz_decimals: int,
        leverage: int = 1,
        interval: str = "4h",
        dex: Optional[str] = None,
        sides: Optional[list[str]] = None,  # ["long"], ["short"], or ["long", "short"]
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
            "15m": 900_000,  "30m": 1_800_000, "1h": 3_600_000,
            "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
        }
        self._interval_ms = interval_ms_map.get(interval, 14_400_000)
        self.dex = dex
        self.sides = [s.lower() for s in (sides or ["long"])]
        self.log = log_callback or (lambda level, msg: None)
        self._running = False
        self._exchange = None

    # ── Exchange init ──────────────────────────────────────────────────────────

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
        # Always set explicitly — never inherit stale leverage from a prior session.
        self.log("info", f"Setting leverage to {self.leverage}x for {self.coin}")
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
            self.log("warning", f"Failed to set leverage: {e}")

    # ── Timing ────────────────────────────────────────────────────────────────

    def _seconds_until_next_candle(self) -> float:
        """Compute wall-clock seconds until the next candle boundary closes."""
        now_ms = int(time.time() * 1000)
        next_boundary_ms = ((now_ms // self._interval_ms) + 1) * self._interval_ms
        delay = (next_boundary_ms - now_ms) / 1000.0
        return max(delay, 1.0)

    # ── Data fetching ─────────────────────────────────────────────────────────

    async def _fetch_candles(self, limit: int = 200) -> list[dict]:
        end_time = int(time.time() * 1000)
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
        """
        Fetch real position for self.coin from Hyperliquid clearinghouseState.
        Returns {"szi": float, "entry_px": float, "unrealized_pnl": float}.
        szi > 0 = long, szi < 0 = short, szi == 0 = flat.
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
                    "szi":           szi,
                    "entry_px":      float(pos.get("entryPx", "0") or "0"),
                    "unrealized_pnl": float(pos.get("unrealizedPnl", "0") or "0"),
                }
        except Exception as e:
            self.log("warning", f"Failed to fetch real position: {e}")
        return {"szi": 0.0, "entry_px": 0.0, "unrealized_pnl": 0.0}

    # ── Order management ──────────────────────────────────────────────────────

    async def _cancel_all_orders(self):
        """
        Cancel ALL open orders for this coin — including trigger entries, TP, and SL.
        Uses frontendOpenOrders (not openOrders) so trigger orders are included.
        """
        coin_short = self.coin.split(":")[-1] if ":" in self.coin else self.coin
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "frontendOpenOrders", "user": self.master_address},
                )
                orders = resp.json()
            if not isinstance(orders, list):
                return
            coin_orders = [
                o for o in orders
                if isinstance(o, dict) and o.get("coin") in (self.coin, coin_short)
            ]
            for order in coin_orders:
                oid = order.get("oid")
                if oid:
                    try:
                        await asyncio.to_thread(self._exchange.cancel, self.coin, oid)
                        self.log("info", f"Cancelled order {oid}")
                    except Exception as e:
                        self.log("warning", f"Failed to cancel order {oid}: {e}")
        except Exception as e:
            self.log("warning", f"Cancel all orders failed: {e}")

    async def _place_trigger_entry(
        self,
        is_buy: bool,
        size: float,
        limit_px: float,
        trigger_px: float,
        tpsl_type: str,         # "sl" for long entries, "tp" for short entries
    ) -> Optional[int]:
        """
        Place a stop-limit entry order (isMarket=False, not reduce-only).
        Long  entry: is_buy=True,  tpsl_type="sl" — triggers when price falls ≤ trigger_px
        Short entry: is_buy=False, tpsl_type="tp" — triggers when price rises ≥ trigger_px
        """
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                self.log("warning", f"Entry size rounds to 0 (limit={limit_px:.4f}) — skipping")
                return None
            limit_px   = round_price(limit_px)
            trigger_px = round_price(trigger_px)
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, limit_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": False, "tpsl": tpsl_type}},
                False,  # not reduce_only — this is an entry order
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Trigger entry rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            side_str = "Buy" if is_buy else "Sell"
            self.log("info",
                f"{side_str} trigger entry placed: {size} {self.coin} "
                f"limit={limit_px} trigger={trigger_px} (oid={oid})")
            return oid
        except Exception as e:
            self.log("error", f"Trigger entry placement failed: {e}")
            return None

    async def _place_stop_market(
        self,
        is_buy: bool,
        size: float,
        trigger_px: float,
    ) -> Optional[int]:
        """
        Place a reduce-only stop-market order (isMarket=True, tpsl='sl').
        Used for stop-loss on both long and short positions.
        """
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                return None
            trigger_px = round_price(trigger_px)
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, trigger_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": True, "tpsl": "sl"}},
                True,  # reduce_only
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Stop-market rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            side_str = "Buy" if is_buy else "Sell"
            self.log("info",
                f"{side_str} stop-market placed: {size} {self.coin} "
                f"@ trigger={trigger_px} (oid={oid})")
            return oid
        except Exception as e:
            self.log("error", f"Stop-market placement failed: {e}")
            return None

    async def _place_limit_reduce(
        self,
        is_buy: bool,
        size: float,
        price: float,
    ) -> Optional[int]:
        """
        Place a reduce-only GTC limit order (used for TP close at MA level).
        """
        try:
            size = round_size(size, self.sz_decimals)
            if size <= 0:
                return None
            price = round_price(price)
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
                True,  # reduce_only
            )
            statuses = ((result.get("response") or {}).get("data") or {}).get("statuses", [{}])
            status   = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Limit reduce rejected: {status['error']}")
                return None
            oid = ((status.get("resting") or {}).get("oid")
                   or (status.get("filled") or {}).get("oid"))
            side_str = "Buy" if is_buy else "Sell"
            self.log("info",
                f"{side_str} limit reduce placed: {size} {self.coin} "
                f"@ {price} (oid={oid})")
            return oid
        except Exception as e:
            self.log("error", f"Limit reduce placement failed: {e}")
            return None

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def run(self):
        """Main bot loop — runs indefinitely until cancelled."""
        self._running = True
        self._init_exchange()
        await self._set_leverage()
        self.log("info", (
            f"Envelope Bot started — {self.coin} | {self.interval} | "
            f"MA={self.ma_period} | Envelopes={self.envelopes} | "
            f"Sides={self.sides} | Allocation=${self.allocated_usdc} | Leverage={self.leverage}x"
        ))

        while self._running:
            try:
                # ── Step 1: cancel ALL open orders — clean slate every candle ──────
                await self._cancel_all_orders()

                # ── Step 2: fetch real position + candles in parallel ──────────────
                real_pos, candles = await asyncio.gather(
                    self._fetch_real_position(),
                    self._fetch_candles(limit=self.ma_period + 10),
                )

                real_szi      = real_pos["szi"]
                real_entry_px = real_pos["entry_px"]
                has_long  = real_szi > 0
                has_short = real_szi < 0
                has_pos   = has_long or has_short

                # ── Step 3: compute MA (shifted 1 bar — no lookahead) ─────────────
                if len(candles) < self.ma_period + 2:
                    self.log("warning", "Not enough candles — waiting 5 min...")
                    await asyncio.sleep(300)
                    continue

                closes   = [c["close"] for c in candles]
                sma_vals = compute_sma(closes, self.ma_period)
                ma_base  = sma_vals[-2]   # last CLOSED candle's MA value
                cur_price = candles[-1]["close"]

                if ma_base is None:
                    self.log("warning", "MA not yet computable — waiting 5 min...")
                    await asyncio.sleep(300)
                    continue

                n_levels  = len(self.envelopes)
                per_level = self.allocated_usdc / n_levels

                self.log("info", (
                    f"Tick — MA={ma_base:.4f} | Price={cur_price:.4f} | "
                    f"szi={real_szi} | entry_px={real_entry_px} | "
                    f"has_long={has_long} | has_short={has_short}"
                ))

                # ── Step 4: manage open position ──────────────────────────────────
                if has_pos:
                    is_long  = has_long
                    close_sz = round_size(abs(real_szi), self.sz_decimals)
                    # Close side is opposite of position side
                    close_is_buy = not is_long   # sell to close long; buy to close short

                    # TP: reduce-only GTC limit at MA
                    await self._place_limit_reduce(close_is_buy, close_sz, ma_base)

                    # SL: reduce-only stop-market at entry_price ± stop_loss_pct%
                    if self.stop_loss_pct > 0 and real_entry_px > 0:
                        if is_long:
                            sl_px = real_entry_px * (1.0 - self.stop_loss_pct / 100.0)
                        else:
                            sl_px = real_entry_px * (1.0 + self.stop_loss_pct / 100.0)
                        await self._place_stop_market(close_is_buy, close_sz, sl_px)

                # ── Step 5: place entry trigger orders ────────────────────────────
                # Long entries: trigger BUY at ma_base * (1 - env_i)
                # Only placed when not currently in a long position.
                if "long" in self.sides and not has_long:
                    for i, env in enumerate(self.envelopes):
                        limit_px   = ma_base * (1.0 - env)
                        trigger_px = limit_px * 1.005   # trigger slightly above limit
                        size = (per_level * self.leverage) / limit_px
                        self.log("info", (
                            f"Long level {i}: env={env:.3f} "
                            f"limit={round_price(limit_px):.4f} "
                            f"trigger={round_price(trigger_px):.4f} "
                            f"size={round_size(size, self.sz_decimals)}"
                        ))
                        await self._place_trigger_entry(
                            True, size, limit_px, trigger_px, "sl"
                        )

                # Short entries: trigger SELL at ma_base * (1 + high_env_i)
                # high_env_i = round(1/(1 - env_i) - 1, 3)  — inverse of long envelope
                # Only placed when not currently in a short position.
                if "short" in self.sides and not has_short:
                    for i, env in enumerate(self.envelopes):
                        high_env   = round(1.0 / (1.0 - env) - 1.0, 3)
                        limit_px   = ma_base * (1.0 + high_env)
                        trigger_px = limit_px * 0.995   # trigger slightly below limit
                        size = (per_level * self.leverage) / limit_px
                        self.log("info", (
                            f"Short level {i}: env={env:.3f} high_env={high_env:.3f} "
                            f"limit={round_price(limit_px):.4f} "
                            f"trigger={round_price(trigger_px):.4f} "
                            f"size={round_size(size, self.sz_decimals)}"
                        ))
                        await self._place_trigger_entry(
                            False, size, limit_px, trigger_px, "tp"
                        )

                self.log("info", (
                    f"Tick complete — MA={ma_base:.4f} | Price={cur_price:.4f} | "
                    f"szi={real_szi} | has_pos={has_pos}"
                ))

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — cleaning up...")
                await self._cancel_all_orders()
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            # Sleep exactly until the next candle boundary closes
            sleep_secs = self._seconds_until_next_candle()
            self.log("info",
                f"Sleeping {sleep_secs:.0f}s until next {self.interval} candle close")
            await asyncio.sleep(sleep_secs)

        self._running = False
        self.log("info", "Envelope Bot stopped.")
