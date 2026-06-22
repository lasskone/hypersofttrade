"""
Funding Rate Arbitrage Bot for Hyperliquid.

Strategy:
- Monitors funding rates across all perp pairs
- When funding rate > threshold (e.g. 0.01%/hr), opens a SHORT perp position
  to COLLECT the funding payment (longs pay shorts when funding is positive)
- When funding rate < -threshold, opens a LONG perp position
  to collect funding (shorts pay longs when funding is negative)
- Exits when funding rate drops back below exit threshold
- Neutral market exposure — profits purely from funding payments

Funding mechanics on Hyperliquid:
- Funding paid every 1 hour
- Positive funding = longs pay shorts → SHORT to collect
- Negative funding = shorts pay longs → LONG to collect
- Rate in response is per-hour (e.g. 0.0000125 = 0.00125%/hr)
"""
from __future__ import annotations
import asyncio
import math
import time
from typing import Optional
import httpx

INFO_ENDPOINT = "https://api.hyperliquid.xyz/info"


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


class FundingRateBot:
    """
    Funding Rate Arbitrage Bot.
    Collects funding payments by being on the correct side of the market.
    """

    def __init__(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        allocated_usdc: float,
        leverage: int,
        entry_threshold_pct: float,   # e.g. 0.01 = enter when |funding| > 0.01%/hr
        exit_threshold_pct: float,    # e.g. 0.005 = exit when |funding| < 0.005%/hr
        sz_decimals: int,
        min_hold_hours: int,          # minimum hours to hold before checking exit
        dex: Optional[str] = None,
        log_callback=None,
        scan_all_pairs: bool = False,  # if True, scan all pairs and pick best opportunity
    ):
        self.private_key = private_key
        self.master_address = master_address
        self.coin = coin
        self.allocated_usdc = allocated_usdc
        self.leverage = leverage
        self.entry_threshold = entry_threshold_pct / 100
        self.exit_threshold = exit_threshold_pct / 100
        self.sz_decimals = sz_decimals
        self.min_hold_hours = min_hold_hours
        self.dex = dex
        self.log = log_callback or (lambda level, msg: None)
        self.scan_all_pairs = scan_all_pairs
        self._exchange = None
        self._position: Optional[dict] = None  # {side, size, entry_price, entry_time, funding_collected}
        self._running = False

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
                self._exchange.update_leverage, self.leverage, self.coin, True
            )
            status = (result or {}).get("status", "")
            if status == "ok":
                self.log("info", f"Leverage set to {self.leverage}x for {self.coin}")
            else:
                self.log("warning", f"Leverage update unexpected response for {self.coin}: {result}")
        except Exception as e:
            self.log("warning", f"Could not set leverage: {e}")

    async def _get_funding_rate(self) -> Optional[float]:
        """Returns current hourly funding rate for self.coin."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "metaAndAssetCtxs"})
                data = resp.json()
            meta_list = data[0]["universe"]
            ctxs_list = data[1]
            for i, m in enumerate(meta_list):
                if m["name"] == self.coin:
                    return float(ctxs_list[i].get("funding", 0))
            return None
        except Exception as e:
            self.log("warning", f"Failed to fetch funding rate: {e}")
            return None

    async def _get_best_funding_opportunity(self) -> Optional[dict]:
        """Scan all perp pairs and return the best funding rate opportunity."""
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "metaAndAssetCtxs"})
                data = resp.json()
            meta_list = data[0]["universe"]
            ctxs_list = data[1]

            opportunities = []
            for i, m in enumerate(meta_list):
                name = m.get("name", "")
                funding = float(ctxs_list[i].get("funding", 0))
                mark_px = float(ctxs_list[i].get("markPx", 0))
                if mark_px <= 0 or abs(funding) < self.entry_threshold:
                    continue
                opportunities.append({
                    "coin": name,
                    "funding": funding,
                    "abs_funding": abs(funding),
                    "mark_price": mark_px,
                    "side": "short" if funding > 0 else "long",
                })

            if not opportunities:
                return None

            # Return the pair with highest absolute funding rate
            best = max(opportunities, key=lambda x: x["abs_funding"])
            return best
        except Exception as e:
            self.log("warning", f"Failed to scan pairs: {e}")
            return None

    async def _get_mark_price(self) -> Optional[float]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"})
                mids = resp.json()
            return float(mids.get(self.coin, 0)) or None
        except Exception:
            return None

    async def _open_position(self, is_short: bool, mark_price: float):
        """Open a position to collect funding."""
        from services.hyperliquid_meta import get_sz_decimals as _fetch_sz_decimals

        # Always resolve szDecimals for the *current* coin at order time.
        # In scanner mode self.coin changes dynamically, so the value stored at
        # construction (which was for the originally configured coin) may be wrong
        # or completely inapplicable to the scanner-discovered coin.
        sz_decimals = await _fetch_sz_decimals(self.coin)
        # Keep self.sz_decimals in sync so close_position and future ticks see it.
        self.sz_decimals = sz_decimals

        position_value = self.allocated_usdc * self.leverage
        raw_size = position_value / mark_price
        size = round_size(raw_size, sz_decimals)
        notional = size * mark_price

        self.log("info", f"Size calc for {self.coin}: raw={raw_size:.8f} → rounded={size} "
                         f"(szDecimals={sz_decimals}, notional=${notional:.2f})")

        if size <= 0 or notional < 10:
            self.log("warning",
                     f"Skipping order: size too small after rounding "
                     f"(szDecimals={sz_decimals}, size={size}, notional=${notional:.2f})")
            return

        # Limit GTC at mark price — aggressive limit that fills at current market
        # price without IOC rejection on thin-book coins (e.g. LAYER).
        is_buy = not is_short
        limit_px = round_price(mark_price)

        self.log("info", f"Placing {'SHORT' if is_short else 'LONG'} limit GTC order: "
                         f"{self.coin} size={size} price=${limit_px} tif=Gtc")

        try:
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, limit_px,
                {"limit": {"tif": "Gtc"}},
            )
            statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
            status = statuses[0] if statuses else {}
            if "error" in status:
                self.log("error", f"Entry order rejected: {status['error']}")
                return
            side_label = "SHORT" if is_short else "LONG"
            self._position = {
                "side": "short" if is_short else "long",
                "size": size,
                "entry_price": mark_price,
                "entry_time": time.time(),
                "funding_collected": 0.0,
            }
            self.log("info", f"Opened {side_label} {size} {self.coin} @ ${mark_price} to collect funding")
        except Exception as e:
            self.log("error", f"Failed to open position: {e}")

    async def _close_position(self, mark_price: float, reason: str):
        """Close the current position."""
        if not self._position:
            return
        size = self._position["size"]
        is_buy = self._position["side"] == "short"  # close short = buy
        limit_px = round_price(mark_price)
        self.log("info", f"Placing close {'BUY' if is_buy else 'SELL'} limit GTC order: "
                         f"{self.coin} size={size} price=${limit_px} tif=Gtc reduce_only=True")
        try:
            result = await asyncio.to_thread(
                self._exchange.order,
                self.coin, is_buy, size, limit_px,
                {"limit": {"tif": "Gtc"}},
                True,  # reduce_only
            )
            hold_hours = (time.time() - self._position["entry_time"]) / 3600
            self.log("info", f"Closed position ({reason}) after {hold_hours:.1f}h | Size={size} @ ${mark_price}")
            self._position = None
        except Exception as e:
            self.log("error", f"Failed to close position: {e}")

    async def run(self):
        """Main bot loop — checks funding every hour."""
        self._running = True
        self._init_exchange()
        await self._set_leverage()
        self.log("info", f"Funding Rate Bot started — {self.coin} | Entry>{self.entry_threshold*100:.4f}%/hr | Exit<{self.exit_threshold*100:.4f}%/hr | Allocation=${self.allocated_usdc}")

        while self._running:
            try:
                funding_rate = await self._get_funding_rate()
                mark_price = await self._get_mark_price()

                if funding_rate is None or mark_price is None:
                    self.log("warning", "Could not fetch market data, retrying in 5 min")
                    await asyncio.sleep(300)
                    continue

                funding_pct_hr = funding_rate * 100
                funding_daily = funding_pct_hr * 24
                self.log("info", f"Funding rate: {funding_pct_hr:.4f}%/hr ({funding_daily:.2f}%/day) | Price=${mark_price}")

                if self._position is None:
                    if self.scan_all_pairs:
                        # Scanner mode — find best opportunity across all pairs
                        opportunity = await self._get_best_funding_opportunity()
                        if opportunity:
                            self.coin = opportunity["coin"]
                            mark_price = opportunity["mark_price"]
                            funding_rate = opportunity["funding"]
                            funding_pct_hr = funding_rate * 100
                            self.log("info", f"Scanner found best opportunity: {self.coin} funding={funding_pct_hr:.4f}%/hr ({funding_rate*24*100:.2f}%/day)")
                            is_short = opportunity["side"] == "short"
                            await self._open_position(is_short=is_short, mark_price=mark_price)
                        else:
                            self.log("info", f"Scanner: no opportunity found above threshold ±{self.entry_threshold*100:.4f}%/hr across all pairs")
                    else:
                        # Single pair mode — original logic
                        if funding_rate > self.entry_threshold:
                            self.log("info", f"Entry signal: funding={funding_pct_hr:.4f}%/hr > threshold={self.entry_threshold*100:.4f}%/hr → opening SHORT")
                            await self._open_position(is_short=True, mark_price=mark_price)
                        elif funding_rate < -self.entry_threshold:
                            self.log("info", f"Entry signal: funding={funding_pct_hr:.4f}%/hr < -{self.entry_threshold*100:.4f}%/hr → opening LONG")
                            await self._open_position(is_short=False, mark_price=mark_price)
                        else:
                            self.log("info", f"No entry signal — funding {funding_pct_hr:.4f}%/hr within threshold ±{self.entry_threshold*100:.4f}%/hr")

                else:
                    # Check exit conditions
                    hold_hours = (time.time() - self._position["entry_time"]) / 3600
                    if hold_hours < self.min_hold_hours:
                        self.log("info", f"Holding position ({hold_hours:.1f}h / {self.min_hold_hours}h min hold)")
                    elif abs(funding_rate) < self.exit_threshold:
                        self.log("info", f"Exit signal: funding {funding_pct_hr:.4f}%/hr below exit threshold")
                        await self._close_position(mark_price, reason="funding_normalized")
                    elif (self._position["side"] == "short" and funding_rate < 0) or \
                         (self._position["side"] == "long" and funding_rate > 0):
                        self.log("warning", f"Funding flipped against position — closing")
                        await self._close_position(mark_price, reason="funding_flipped")
                    else:
                        self.log("info", f"Holding {self._position['side'].upper()} — collecting funding {funding_pct_hr:.4f}%/hr")

            except asyncio.CancelledError:
                self.log("info", "Bot cancelled — closing position...")
                if self._position:
                    mark_price = await self._get_mark_price()
                    if mark_price:
                        await self._close_position(mark_price, reason="bot_stopped")
                break
            except Exception as e:
                self.log("error", f"Bot loop error: {e}")

            # Check every hour (funding updates hourly)
            await asyncio.sleep(3600)

        self._running = False
        self.log("info", "Funding Rate Bot stopped.")
