"""
Hyperliquid service — async HTTP wrapper around the Hyperliquid public REST API.
"""
from __future__ import annotations

import asyncio
import math

import httpx
from fastapi import HTTPException

MAINNET_API_URL = "https://api.hyperliquid.xyz"
INFO_ENDPOINT = f"{MAINNET_API_URL}/info"


class HyperliquidService:
    """Thin async wrapper around the Hyperliquid public API."""

    def __init__(self, referral_code: str = "KNS"):
        self.referral_code = referral_code

    # ------------------------------------------------------------------
    # Market data
    # ------------------------------------------------------------------

    async def get_all_mids(self) -> dict:
        """Return a dict of symbol -> mid price for all assets."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"})
            resp.raise_for_status()
        return resp.json()

    async def get_orderbook(self, symbol: str) -> dict:
        """Return top-of-book bids and asks for *symbol*."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                INFO_ENDPOINT, json={"type": "l2Book", "coin": symbol}
            )
            resp.raise_for_status()
        data = resp.json()
        levels = data.get("levels", [[], []])
        bids = levels[0] if len(levels) > 0 else []
        asks = levels[1] if len(levels) > 1 else []
        return {"bids": bids, "asks": asks}

    # ------------------------------------------------------------------
    # Per-DEX account queries
    # ------------------------------------------------------------------

    async def get_all_perp_dexes(self) -> list[str]:
        """Return all perp DEX identifiers: '' for main, name string for HIP-3."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "perpDexs"},
                headers={"Content-Type": "application/json"},
            )
            dexes = response.json()
        dex_names: list[str] = []
        for dex in dexes:
            if dex is None:
                dex_names.append("")        # empty string = main dex
            elif isinstance(dex, dict) and "name" in dex:
                dex_names.append(dex["name"])
        return dex_names

    async def get_clearinghouse_state(self, wallet_address: str, dex: str = "") -> dict:
        """Return clearinghouse state for a specific DEX ('' = main)."""
        payload: dict = {"type": "clearinghouseState", "user": wallet_address}
        if dex:
            payload["dex"] = dex
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            return response.json()

    async def get_spot_state(self, wallet_address: str) -> dict:
        """Return spot balances for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "spotClearinghouseState", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    async def get_user_fills(self, wallet_address: str) -> list:
        """Return full trade history for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "userFills", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    async def get_open_orders(self, wallet_address: str) -> list:
        """Return all open orders for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "openOrders", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    # ------------------------------------------------------------------
    # Complete portfolio aggregation
    # ------------------------------------------------------------------

    async def get_complete_portfolio(self, wallet_address: str) -> dict:
        """Aggregate portfolio across ALL DEXes (main + HIP-3), spot, fills, orders."""
        # Step 1: discover all DEX names
        dex_names = await self.get_all_perp_dexes()
        print(f"[portfolio] Found {len(dex_names)} DEXes: {dex_names}")

        # Step 2: fan-out — all DEX states + spot + fills + orders in parallel
        tasks = [self.get_clearinghouse_state(wallet_address, dex) for dex in dex_names]
        tasks.append(self.get_spot_state(wallet_address))
        tasks.append(self.get_user_fills(wallet_address))
        tasks.append(self.get_open_orders(wallet_address))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        perp_states = results[:len(dex_names)]
        spot_state  = results[len(dex_names)]
        fills       = results[len(dex_names) + 1]
        open_orders = results[len(dex_names) + 2]

        # Fetch mark prices and sz_decimals for position enrichment
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                mids_r, metas_r = await asyncio.gather(
                    client.post(INFO_ENDPOINT, json={"type": "allMids"}, headers={"Content-Type": "application/json"}),
                    client.post(INFO_ENDPOINT, json={"type": "allPerpMetas"}, headers={"Content-Type": "application/json"}),
                )
            mids_json = mids_r.json()
            metas_json = metas_r.json()
            all_mids = mids_json if isinstance(mids_json, dict) else {}
            perp_metas_raw = metas_json if isinstance(metas_json, list) else []
        except Exception:
            all_mids = {}
            perp_metas_raw = []

        # Build coin→sz_decimals lookup from allPerpMetas (flat list of dicts)
        sz_decimals_map: dict[str, int] = {}
        for meta_dex in perp_metas_raw:
            if not isinstance(meta_dex, dict):
                continue
            for asset in meta_dex.get("universe", []):
                if isinstance(asset, dict) and "name" in asset:
                    sz_decimals_map[asset["name"]] = asset.get("szDecimals", 5)

        # Step 3: aggregate perp positions across all DEXes
        total_account_value  = 0.0
        total_unrealized_pnl = 0.0
        all_positions: list[dict] = []

        for i, state in enumerate(perp_states):
            if isinstance(state, Exception):
                print(f"[portfolio] DEX {dex_names[i]!r} error: {state}")
                continue

            if not isinstance(state, dict):
                print(f"[portfolio] DEX {dex_names[i]!r} returned non-dict: {type(state)}")
                continue

            dex_label      = dex_names[i] or "main"
            margin_summary = state.get("marginSummary") or {}
            acct_val       = float(margin_summary.get("accountValue", "0") or "0")
            total_account_value += acct_val
            print(f"[portfolio] DEX={dex_label} accountValue={acct_val}")

            asset_positions = state.get("assetPositions") or []
            for ap in asset_positions:
                if not isinstance(ap, dict):
                    continue
                pos = ap.get("position") or {}
                if not isinstance(pos, dict):
                    continue
                szi = float(pos.get("szi", "0") or "0")
                if szi == 0.0:
                    continue
                upnl = float(pos.get("unrealizedPnl", "0") or "0")
                total_unrealized_pnl += upnl
                all_positions.append({
                    "dex":               dex_label,
                    "symbol":            pos.get("coin", ""),
                    "size":              szi,
                    "entry_price":       float(pos.get("entryPx", "0") or "0"),
                    "position_value":    float(pos.get("positionValue", "0") or "0"),
                    "unrealized_pnl":    upnl,
                    "leverage":          (pos.get("leverage") or {}).get("value", 1),
                    "leverage_type":     (pos.get("leverage") or {}).get("type", "cross"),
                    "liquidation_price": float(pos.get("liquidationPx", "0") or "0"),
                    "margin_used":       float(pos.get("marginUsed", "0") or "0"),
                    "sz_decimals":       sz_decimals_map.get(pos.get("coin", ""), 5),
                    "mark_price":        float(all_mids.get(pos.get("coin", ""), pos.get("entryPx", "0")) or "0"),
                })

        # Step 4: spot balances (also add USDC spot to account value)
        spot_balances: list[dict] = []
        if not isinstance(spot_state, Exception) and isinstance(spot_state, dict):
            for balance in (spot_state.get("balances") or []):
                if not isinstance(balance, dict):
                    continue
                amount = float(balance.get("total", "0") or "0")
                if amount > 0:
                    spot_balances.append({
                        "coin":  balance.get("coin", ""),
                        "total": amount,
                        "hold":  float(balance.get("hold", "0") or "0"),
                    })
                    if balance.get("coin") == "USDC":
                        total_account_value += amount
                        print(f"[portfolio] USDC spot balance added: {amount}")

        # Step 5: recent fills (last 50)
        recent_fills: list[dict] = []
        if not isinstance(fills, Exception) and isinstance(fills, list):
            for fill in fills[:50]:
                if not isinstance(fill, dict):
                    continue
                recent_fills.append({
                    "coin":       fill.get("coin", ""),
                    "side":       fill.get("side", ""),
                    "price":      float(fill.get("px", "0") or "0"),
                    "size":       float(fill.get("sz", "0") or "0"),
                    "closed_pnl": float(fill.get("closedPnl", "0") or "0"),
                    "fee":        float(fill.get("fee", "0") or "0"),
                    "time":       fill.get("time", 0),
                    "order_type": "liquidation" if fill.get("liquidation") else "trade",
                })

        # Step 6: open orders
        orders: list[dict] = []
        if not isinstance(open_orders, Exception) and isinstance(open_orders, list):
            for order in open_orders:
                if not isinstance(order, dict):
                    continue
                orders.append({
                    "coin":     order.get("coin", ""),
                    "side":     order.get("side", ""),
                    "price":    float(order.get("limitPx", "0") or "0"),
                    "size":     float(order.get("sz", "0") or "0"),
                    "order_id": order.get("oid", ""),
                    "time":     order.get("timestamp", 0),
                })

        usdc_spot = next(
            (b["total"] for b in spot_balances if b["coin"] == "USDC"), 0.0
        )

        return {
            "wallet_address":       wallet_address,
            "account_value":        round(total_account_value, 4),
            "unrealized_pnl":       round(total_unrealized_pnl, 4),
            "usdc_spot_balance":    round(usdc_spot, 4),
            "open_positions":       all_positions,
            "open_positions_count": len(all_positions),
            "spot_balances":        spot_balances,
            "recent_fills":         recent_fills,
            "open_orders":          orders,
            "dexes_queried":        dex_names,
        }

    # ------------------------------------------------------------------
    # Affiliation
    # ------------------------------------------------------------------

    async def check_affiliation(self, wallet_address: str, referral_code: str) -> bool:
        """Return True if *wallet_address* is referred by *referral_code*."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "referral", "user": wallet_address},
                    headers={"Content-Type": "application/json"},
                    timeout=10.0,
                )
                data = response.json()
                referred_by = data.get("referredBy") or {}
                code = referred_by.get("code", "")
                result = code.strip().upper() == referral_code.strip().upper()
                print(f"[affiliation] referredBy={referred_by} code='{code}' expected='{referral_code}' result={result}")
                return result
        except Exception as e:
            print(f"[affiliation] ERROR type={type(e)} msg={e}")
            return False

    # ------------------------------------------------------------------
    # Legacy shims (kept for other routers)
    # ------------------------------------------------------------------

    async def get_user_state(self, wallet_address: str) -> dict:
        return await self.get_clearinghouse_state(wallet_address, "")

    async def get_user_positions(self, wallet_address: str) -> dict:
        return await self.get_user_state(wallet_address)

    async def get_account_info(self, address: str) -> dict:
        return await self.get_user_state(address)

    async def get_positions(self, address: str) -> list:
        state = await self.get_user_state(address)
        return state.get("assetPositions", [])

    async def place_order(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        is_buy: bool,
        size: float,
        price: float,
        order_type: str,
        leverage: int = 1,
        sz_decimals: int = 5,
    ) -> dict:
        """
        Place an order on Hyperliquid using the SDK.
        private_key    = API wallet private key (decrypted)
        master_address = MetaMask wallet address (master account)
        """
        dex_name = coin.split(":")[0] if ":" in coin else None
        # Round size to asset precision (floor to avoid float_to_wire errors)
        factor = 10 ** sz_decimals
        size = math.floor(size * factor) / factor
        if size <= 0:
            raise ValueError(
                f"Size too small after rounding to {sz_decimals} decimals. "
                f"Increase USD amount."
            )

        import asyncio

        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        account = eth_account.Account.from_key(private_key)

        # Extract DEX name from coin prefix if HIP-3 (e.g. "xyz:XYZ100" → dex="xyz")
        # coin has already been stripped to short name at this point
        # We need the original coin passed to the method — use the dex extracted before stripping
        dex_list = [dex_name] if dex_name else []
        exchange = Exchange(
            account,
            constants.MAINNET_API_URL,
            account_address=master_address,
            perp_dexs=dex_list if dex_list else None,
        )

        if order_type == "market":
            slippage = 0.05
            raw_price = price * (1 + slippage) if is_buy else price * (1 - slippage)
            # Round to appropriate precision based on price magnitude
            if raw_price >= 1000:
                limit_price = round(raw_price)        # whole number for high-price assets
            elif raw_price >= 10:
                limit_price = round(raw_price, 1)     # 1 decimal for mid-price assets
            else:
                limit_price = round(raw_price, 2)     # 2 decimals for low-price assets
            order_result = await asyncio.to_thread(
                exchange.order,
                coin, is_buy, size, limit_price,
                {"limit": {"tif": "Ioc"}},
            )
        else:
            order_result = await asyncio.to_thread(
                exchange.order,
                coin, is_buy, size, price,
                {"limit": {"tif": "Gtc"}},
            )

        print(f"[order] result={order_result}")
        return order_result

    async def cancel_order(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        order_id: int,
    ) -> dict:
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        dex_name = coin.split(":")[0] if ":" in coin else None
        account = eth_account.Account.from_key(private_key)
        # Extract DEX name from coin prefix if HIP-3 (e.g. "xyz:XYZ100" → dex="xyz")
        # coin has already been stripped to short name at this point
        # We need the original coin passed to the method — use the dex extracted before stripping
        dex_list = [dex_name] if dex_name else []
        exchange = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None)
        result = await asyncio.to_thread(exchange.cancel, coin, order_id)
        print(f"[cancel_order] result={result}")
        return result

    async def close_position(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        is_long: bool,
        size: float,
        sz_decimals: int,
        percentage: int,
        mark_price: float,
    ) -> dict:
        dex_name = coin.split(":")[0] if ":" in coin else None
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        factor = 10 ** sz_decimals
        close_size = math.floor(size * (percentage / 100) * factor) / factor
        if close_size <= 0:
            raise ValueError("Size too small after rounding.")

        account = eth_account.Account.from_key(private_key)
        # Extract DEX name from coin prefix if HIP-3 (e.g. "xyz:XYZ100" → dex="xyz")
        # coin has already been stripped to short name at this point
        # We need the original coin passed to the method — use the dex extracted before stripping
        dex_list = [dex_name] if dex_name else []
        exchange = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None)

        # Close = opposite side, IOC market order with 5% slippage
        is_close_buy = not is_long
        slippage = 0.05
        raw_price = mark_price * (1 + slippage) if is_close_buy else mark_price * (1 - slippage)
        # Round to appropriate precision based on price magnitude
        if raw_price >= 1000:
            limit_price = round(raw_price)        # whole number for high-price assets
        elif raw_price >= 10:
            limit_price = round(raw_price, 1)     # 1 decimal for mid-price assets
        else:
            limit_price = round(raw_price, 2)     # 2 decimals for low-price assets

        result = await asyncio.to_thread(
            exchange.order,
            coin, is_close_buy, close_size, limit_price,
            {"limit": {"tif": "Ioc"}},
        )
        print(f"[close_position] result={result}")
        return result


hyperliquid_service = HyperliquidService()


# ---------------------------------------------------------------------------
# Standalone market helpers (not tied to a user session)
# ---------------------------------------------------------------------------

async def get_all_markets() -> list:
    """
    Get ALL available trading pairs from ALL DEXes.

    allPerpMetas returns a flat list of meta dicts (one per DEX):
      [{'universe': [...], ...}, {'universe': [...], ...}, ...]

    Mark prices for the main DEX come from metaAndAssetCtxs → [meta, ctxs].
    Prices for HIP-3 coins fall back to allMids.
    """
    async with httpx.AsyncClient() as client:
        # Flat list of meta dicts, one per DEX
        metas_resp = await client.post(
            INFO_ENDPOINT,
            json={"type": "allPerpMetas"},
            headers={"Content-Type": "application/json"},
            timeout=15.0,
        )
        all_metas = metas_resp.json()

        # Main DEX mark prices: returns [meta_dict, [ctx1, ctx2, ...]]
        ctxs_resp = await client.post(
            INFO_ENDPOINT,
            json={"type": "metaAndAssetCtxs"},
            headers={"Content-Type": "application/json"},
            timeout=10.0,
        )
        main_ctxs_data = ctxs_resp.json()
        main_ctxs = main_ctxs_data[1] if len(main_ctxs_data) > 1 else []
        main_universe = main_ctxs_data[0].get("universe", []) if main_ctxs_data else []

        # name → markPx / prevDayPx / funding for the main DEX
        main_price_map: dict[str, float] = {}
        main_ctx_map: dict[str, dict] = {}
        for i, asset in enumerate(main_universe):
            if i < len(main_ctxs):
                ctx = main_ctxs[i]
                px = ctx.get("markPx")
                if px:
                    main_price_map[asset["name"]] = float(px)
                main_ctx_map[asset["name"]] = {
                    "prev_day_px": float(ctx.get("prevDayPx", 0) or 0),
                    "funding": float(ctx.get("funding", 0) or 0),
                }

        # Fallback prices for HIP-3 coins
        mids_resp = await client.post(
            INFO_ENDPOINT,
            json={"type": "allMids"},
            headers={"Content-Type": "application/json"},
            timeout=10.0,
        )
        all_mids = mids_resp.json()

    print(f"[markets] allPerpMetas len={len(all_metas)}")
    print(f"[markets] main price map size={len(main_price_map)}")

    markets = []
    for meta in all_metas:
        if not isinstance(meta, dict):
            continue
        universe = meta.get("universe", [])

        for asset in universe:
            name = asset.get("name", "")
            if not name or asset.get("isDelisted"):
                continue

            mark_px = (
                main_price_map.get(name)
                or float(all_mids.get(name, 0) or 0)
            )

            dex = name.split(":")[0] if ":" in name else "main"
            display = name.split(":")[-1] if ":" in name else name
            ctx_data = main_ctx_map.get(name, {})

            markets.append({
                "name": name,
                "display_name": display,
                "max_leverage": asset.get("maxLeverage", 50),
                "sz_decimals": asset.get("szDecimals", 4),
                "mark_price": mark_px,
                "dex": dex,
                "only_isolated": asset.get("onlyIsolated", False),
                "prev_day_px": ctx_data.get("prev_day_px", 0),
                "funding": ctx_data.get("funding", 0),
            })

    markets.sort(key=lambda x: (x["dex"] != "main", -x["mark_price"]))
    print(f"[markets] Total markets found: {len(markets)}")
    return markets


async def get_recent_trades(coin: str) -> list:
    """Get the last 20 recent trades for *coin*."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            INFO_ENDPOINT,
            json={"type": "recentTrades", "coin": coin},
            headers={"Content-Type": "application/json"},
            timeout=10.0,
        )
        data = response.json()

    trades = []
    for trade in data[:20]:
        trades.append({
            "price": float(trade.get("px", 0)),
            "size": float(trade.get("sz", 0)),
            "side": trade.get("side", ""),
            "time": trade.get("time", 0),
        })
    return trades


async def get_candles(coin: str, interval: str, limit: int = 500) -> list:
    """
    Get OHLCV candles for any coin including HIP-3.
    coin:     full name e.g. "BTC" or "xyz:XYZ100"
    interval: "1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d","1w"
    """
    import time as _time
    end_time = int(_time.time() * 1000)

    interval_ms = {
        "1m":  60_000,
        "3m":  180_000,
        "5m":  300_000,
        "15m": 900_000,
        "30m": 1_800_000,
        "1h":  3_600_000,
        "2h":  7_200_000,
        "4h":  14_400_000,
        "8h":  28_800_000,
        "12h": 43_200_000,
        "1d":  86_400_000,
        "3d":  259_200_000,
        "1w":  604_800_000,
    }
    ms = interval_ms.get(interval, 900_000)
    start_time = end_time - ms * limit

    async with httpx.AsyncClient() as client:
        response = await client.post(
            INFO_ENDPOINT,
            json={
                "type": "candleSnapshot",
                "req": {
                    "coin": coin,
                    "interval": interval,
                    "startTime": start_time,
                    "endTime": end_time,
                },
            },
            headers={"Content-Type": "application/json"},
            timeout=15.0,
        )
        candles = response.json()

    result = []
    for c in candles:
        result.append({
            "time":   int(c["t"]) // 1000,  # ms → seconds for lightweight-charts
            "open":   float(c["o"]),
            "high":   float(c["h"]),
            "low":    float(c["l"]),
            "close":  float(c["c"]),
            "volume": float(c["v"]),
        })
    return result
