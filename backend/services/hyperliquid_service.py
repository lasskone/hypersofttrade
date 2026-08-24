"""
Hyperliquid service — async HTTP wrapper around the Hyperliquid public REST API.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time as _time_module
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from supabase import create_client

MAINNET_API_URL = "https://api.hyperliquid.xyz"
INFO_ENDPOINT = f"{MAINNET_API_URL}/info"

logger = logging.getLogger("hyperliquid_service")

# Maximum time (seconds) to wait for any Hyperliquid network call:
#   • Signed exchange SDK calls (exchange.order, exchange.cancel, etc.) run
#     in a thread-pool via asyncio.to_thread using the requests library, which
#     has no built-in timeout — a TCP stall would hang the thread indefinitely.
#   • Read-only market-data calls (get_candles, get_orderbook, get_all_mids,
#     get_clearinghouse_state, get_user_fills, get_open_orders, etc.) use
#     httpx.AsyncClient — these are called every scan tick (every 5 s) and are
#     far more frequent than signed calls.  A TCP stall on any of them blocks
#     the awaiting coroutine (and therefore the worker event loop) until the
#     kernel-level socket timeout fires, which can take minutes.
# Both call paths enforce this ceiling so no single network call can freeze the
# event loop beyond _EXCHANGE_CALL_TIMEOUT_S seconds.
_EXCHANGE_CALL_TIMEOUT_S: float = 15.0

# Maximum time (seconds) to wait when acquiring the per-wallet asyncio.Lock
# before an exchange call.  A stalled exchange.* thread holds the lock until
# _EXCHANGE_CALL_TIMEOUT_S fires and the RuntimeError propagates out of the
# `try` block — at which point the lock IS released via the `finally` clause.
# This lock timeout (_LOCK_ACQUIRE_TIMEOUT_S) must therefore exceed
# _EXCHANGE_CALL_TIMEOUT_S so a normal in-progress call is never interrupted
# by a lock-wait timeout on a concurrent caller.
_LOCK_ACQUIRE_TIMEOUT_S: float = 20.0

# Maximum seconds to wait for a per-key cache lock before falling through to a
# direct (uncached) HTTP call.  Intentionally matches the HTTP timeout so a
# caller waiting on a slow lock-holder never experiences more total latency
# than a real network round-trip would take.
_CACHE_MISS_LOCK_TIMEOUT_S: float = _EXCHANGE_CALL_TIMEOUT_S  # 15.0


class MarketDataCache:
    """
    Short-lived in-process cache for read-only Hyperliquid market data.

    This class is instantiated once at module level (_market_cache) and shared
    across every caller in the process — bots, /market/* API routes, worker.py.
    All of them import from the same module object, so they share one cache dict.

    TTLs
    ----
    allMids            1 s  — mid prices change tick-by-tick but 1 s staleness
                              is imperceptible to trading decisions and the UI.
    l2Book (orderbook) 1 s  — same rationale as allMids.
    candleSnapshot    15 s  — 1 m candles update at most once per minute; 5 m
                              candles even less often.  15 s captures multiple
                              scan ticks while guaranteeing a fresh read within
                              the current candle's lifetime.

    Hot path (cache HIT)
    --------------------
    Reads a plain Python dict (self._store) with no lock and no coroutine
    suspension.  This is strictly faster than any real HTTP call — it is a
    dict lookup + monotonic clock read, both O(1) and non-blocking.

    Cold path (cache MISS)
    ----------------------
    Acquires a per-key asyncio.Lock (timeout = _CACHE_MISS_LOCK_TIMEOUT_S = 15 s)
    to prevent a "stampede" where N callers all fire duplicate HTTP requests for
    the same key at the same instant.

    Flow when multiple callers miss simultaneously:
      1. All callers see a miss (no lock, instant _get check).
      2. All race to acquire the per-key lock via asyncio.wait_for.
      3. The event loop wakes exactly one coroutine (call it A); the others
         suspend in the lock's wait queue.
      4. A re-checks the cache (still cold), makes the real HTTP call, populates
         the cache, releases the lock.
      5. B, C, … wake in sequence, re-check → HIT — they return the value A
         fetched without making any additional HTTP calls.
      Total latency for B and C = A's HTTP call time + an in-memory dict read.
      This is identical to what they would have experienced making their own
      uncached call, with the bonus that only ONE HTTP call was made.

    Lock timeout fall-through
    -------------------------
    If a caller waits _CACHE_MISS_LOCK_TIMEOUT_S and the lock is still held
    (e.g. A's HTTP request is extremely slow or stalled), the waiting caller
    logs a debug line and falls through to its own direct HTTP call — it is
    NEVER blocked indefinitely and NEVER experiences more latency than a normal
    network call would take.
    """

    TTL_ALL_MIDS:      float = 1.0   # seconds
    TTL_ORDERBOOK:     float = 1.0   # seconds
    TTL_CANDLES:       float = 15.0  # seconds
    TTL_CLEARINGHOUSE: float = 3.0   # seconds — display-only portfolio fan-out

    def __init__(self) -> None:
        # {cache_key: (value, expires_at_monotonic)}
        self._store: dict[str, tuple[object, float]] = {}
        # Per-key asyncio.Lock — created lazily on first miss.
        # Dict access is safe without a guard lock: the asyncio event loop is
        # single-threaded, so no other coroutine can interleave between the
        # existence-check and the assignment (there is no `await` between them).
        self._locks: dict[str, asyncio.Lock] = {}

    # ------------------------------------------------------------------
    # Internal helpers — no awaits, no side effects
    # ------------------------------------------------------------------

    def _get(self, key: str) -> tuple[bool, object]:
        """Read the cache without any lock or coroutine suspension.

        Returns (True, value) on a fresh hit, (False, None) on a miss or
        an expired entry.
        """
        entry = self._store.get(key)
        if entry is not None and _time_module.monotonic() < entry[1]:
            return True, entry[0]
        return False, None

    def _set(self, key: str, value: object, ttl: float) -> None:
        """Write to the cache.  Must only be called by the lock-holding coroutine."""
        self._store[key] = (value, _time_module.monotonic() + ttl)

    def _lock_for(self, key: str) -> asyncio.Lock:
        """Return the per-key lock, creating it lazily if necessary.

        No `await` between the existence-check and the assignment — safe on the
        single-threaded asyncio event loop.
        """
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_or_fetch(
        self,
        key: str,
        ttl: float,
        fetch_fn,   # async () -> value
    ) -> object:
        """Return a fresh cached value, or call fetch_fn() and cache the result.

        Cache hit  → plain dict lookup, returns instantly, zero coroutine switches.
        Cache miss → per-key lock, single HTTP call, result shared with waiters.
        Lock timeout → direct uncached HTTP call, no indefinite blocking.
        """
        # ── Hot path: cache hit — no lock, no suspension ──────────────────────
        hit, cached = self._get(key)
        if hit:
            logger.debug("[cache] HIT  %s", key)
            return cached

        # ── Cold path: cache miss — acquire per-key lock ──────────────────────
        lock = self._lock_for(key)
        try:
            # asyncio.wait_for cancels lock.acquire() cleanly on timeout:
            # the coroutine is removed from the lock's wait queue and the lock
            # remains unacquired, so no release is needed in the except branch.
            await asyncio.wait_for(lock.acquire(), timeout=_CACHE_MISS_LOCK_TIMEOUT_S)
        except asyncio.TimeoutError:
            # The lock-holding caller is taking very long (stalled HTTP request).
            # Fall through to our own direct call rather than blocking the bot.
            logger.debug("[cache] LOCK_TIMEOUT %s — falling through to direct fetch", key)
            return await fetch_fn()

        try:
            # Re-check: another coroutine may have populated the cache while we
            # waited to acquire the lock — avoid a redundant HTTP call.
            hit, cached = self._get(key)
            if hit:
                logger.debug("[cache] HIT_AFTER_LOCK %s", key)
                return cached

            # We hold the lock and the cache is still cold.  Make the real call.
            logger.debug("[cache] MISS %s — fetching from Hyperliquid", key)
            result = await fetch_fn()
            self._set(key, result, ttl)
            return result
        finally:
            lock.release()


# Module-level singleton — shared by every caller (bots, routers, worker.py)
# because Python's import system returns the same module object to all importers.
_market_cache = MarketDataCache()


def _round_price(price: float) -> float:
    """Round price to Hyperliquid's 5 significant figures convention."""
    if price >= 10000: return round(price, 0)
    if price >= 1000:  return round(price, 1)
    if price >= 100:   return round(price, 2)
    if price >= 10:    return round(price, 3)
    if price >= 1:     return round(price, 4)
    if price >= 0.1:   return round(price, 5)
    return round(price, 6)


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


class HyperliquidService:
    """Thin async wrapper around the Hyperliquid public API."""

    def __init__(self, referral_code: str = "KNS"):
        self.referral_code = referral_code
        self._wallet_locks: dict[str, asyncio.Lock] = {}

    def _get_wallet_lock(self, master_address: str) -> asyncio.Lock:
        key = master_address.lower()
        if key not in self._wallet_locks:
            self._wallet_locks[key] = asyncio.Lock()
        return self._wallet_locks[key]

    # ------------------------------------------------------------------
    # Market data
    # ------------------------------------------------------------------

    async def get_all_mids(self) -> dict:
        """Return a dict of symbol -> mid price for all assets."""
        async def _fetch() -> dict:
            try:
                async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                    resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"})
                    resp.raise_for_status()
                return resp.json()
            except Exception as e:
                logger.error(f"[get_all_mids] failed: {e}")
                return {}
        return await _market_cache.get_or_fetch(
            "allMids", _market_cache.TTL_ALL_MIDS, _fetch
        )

    async def get_orderbook(self, symbol: str) -> dict:
        """Return top-of-book bids and asks for *symbol*."""
        cache_key = f"orderbook:{symbol}"

        async def _fetch() -> dict:
            try:
                async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                    resp = await client.post(
                        INFO_ENDPOINT, json={"type": "l2Book", "coin": symbol}
                    )
                    resp.raise_for_status()
                data = resp.json()
                levels = data.get("levels", [[], []])
                bids = levels[0] if len(levels) > 0 else []
                asks = levels[1] if len(levels) > 1 else []
                return {"bids": bids, "asks": asks}
            except Exception as e:
                logger.error(f"[get_orderbook] {symbol} failed: {e}")
                return {"bids": [], "asks": []}

        return await _market_cache.get_or_fetch(
            cache_key, _market_cache.TTL_ORDERBOOK, _fetch
        )

    # ------------------------------------------------------------------
    # Per-DEX account queries
    # ------------------------------------------------------------------

    async def get_all_perp_dexes(self) -> list[str]:
        """Return all perp DEX identifiers: '' for main, name string for HIP-3."""
        try:
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
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
        except Exception as e:
            logger.error(f"[get_all_perp_dexes] failed: {e}")
            return [""]

    async def get_clearinghouse_state(self, wallet_address: str, dex: str = "") -> dict:
        """Return clearinghouse state for a specific DEX ('' = main).

        NOTE: this method is intentionally uncached — bots call it directly for
        real-time position/risk checks during trade execution.  Do NOT add caching
        here.  For display-only fan-out use get_clearinghouse_state_display().
        """
        try:
            payload: dict = {"type": "clearinghouseState", "user": wallet_address}
            if dex:
                payload["dex"] = dex
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                return response.json()
        except Exception as e:
            logger.error(f"[get_clearinghouse_state] {wallet_address} dex={dex!r} failed: {e}")
            return {}

    async def get_clearinghouse_state_display(self, wallet_address: str, dex: str = "") -> dict:
        """Cached wrapper around get_clearinghouse_state for display-only use.

        TTL = MarketDataCache.TTL_CLEARINGHOUSE (3 s).  Only called from
        get_complete_portfolio() — never from bot execution paths — so short
        staleness is acceptable and absorbs duplicate polls from concurrent users.
        Cache key is (wallet_address, dex) so different wallets/DEXes are isolated.

        IMPORTANT: uses a manual cache check rather than get_or_fetch() so that
        error/null responses (None, {}) are never stored.  HL returns JSON null on
        429s — response.json() returns None without raising, which would poison the
        cache for the full TTL window if stored via get_or_fetch().
        """
        cache_key = f"clearinghouse:{wallet_address}:{dex}"
        hit, cached = _market_cache._get(cache_key)
        if hit:
            return cached
        result = await self.get_clearinghouse_state(wallet_address, dex)
        # Only cache a genuine populated response — never cache None or {}
        if isinstance(result, dict) and result:
            _market_cache._set(cache_key, result, _market_cache.TTL_CLEARINGHOUSE)
        return result if isinstance(result, dict) else {}

    async def get_spot_state(self, wallet_address: str) -> dict:
        """Return spot balances for *wallet_address*."""
        try:
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "spotClearinghouseState", "user": wallet_address},
                    headers={"Content-Type": "application/json"},
                )
                return response.json()
        except Exception as e:
            logger.error(f"[get_spot_state] {wallet_address} failed: {e}")
            return {}

    async def get_user_fills(self, wallet_address: str) -> list:
        """Return full trade history for *wallet_address*."""
        try:
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "userFills", "user": wallet_address},
                    headers={"Content-Type": "application/json"},
                )
                return response.json()
        except Exception as e:
            logger.error(f"[get_user_fills] {wallet_address} failed: {e}")
            return []

    async def get_open_orders(self, wallet_address: str, dex: str = "") -> list:
        """Return all open orders for *wallet_address* on *dex* ('' = main).

        frontendOpenOrders is DEX-scoped: HIP-3 TP/SL orders are only returned
        when the matching dex name is included in the request body.
        """
        try:
            payload: dict = {"type": "frontendOpenOrders", "user": wallet_address}
            if dex:
                payload["dex"] = dex
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                return response.json()
        except Exception as e:
            logger.error(f"[get_open_orders] {wallet_address} dex={dex!r} failed: {e}")
            return []

    async def _sync_position_opens(self, wallet_address: str, current_coins: set[str]) -> dict[str, str]:
        """
        Diff current open positions against the position_opens table.
        Insert rows for newly opened positions, stamp closed_at for closed ones.
        Returns {coin: opened_at_iso_string} for all currently open positions.
        """
        try:
            db = _supabase()
            res = (
                db.table("position_opens")
                .select("coin, opened_at")
                .eq("wallet_address", wallet_address)
                .is_("closed_at", "null")
                .execute()
            )
            existing: dict[str, str] = {r["coin"]: r["opened_at"] for r in (res.data or [])}
            existing_coins = set(existing.keys())

            now_iso = datetime.now(timezone.utc).isoformat()

            new_coins = current_coins - existing_coins
            if new_coins:
                db.table("position_opens").insert([
                    {"wallet_address": wallet_address, "coin": coin, "opened_at": now_iso}
                    for coin in new_coins
                ]).execute()
                for coin in new_coins:
                    existing[coin] = now_iso

            closed_coins = existing_coins - current_coins
            for coin in closed_coins:
                db.table("position_opens").update({"closed_at": now_iso}) \
                    .eq("wallet_address", wallet_address) \
                    .eq("coin", coin) \
                    .is_("closed_at", "null") \
                    .execute()

            return {coin: existing[coin] for coin in current_coins if coin in existing}
        except Exception as e:
            print(f"[position_opens] sync error: {e}")
            return {}

    # ------------------------------------------------------------------
    # Complete portfolio aggregation
    # ------------------------------------------------------------------

    async def get_complete_portfolio(self, wallet_address: str) -> dict:
        """Aggregate portfolio across ALL DEXes (main + HIP-3), spot, fills, orders."""
        # Step 1: discover all DEX names.
        # Always guarantee the main DEX ("") is in the list — perpDexs may represent
        # it as None, as {}, or omit it entirely depending on API version.  Without it
        # the fan-out never fetches the main clearinghouseState and withdrawable = 0.
        dex_names = await self.get_all_perp_dexes()
        if "" not in dex_names:
            dex_names.insert(0, "")
            print(f"[portfolio] Main DEX ('') missing from perpDexs — inserted at position 0")
        print(f"[portfolio] Found {len(dex_names)} DEXes: {dex_names}")

        # Step 2: fan-out — all DEX states + spot + fills + per-DEX orders in parallel.
        # frontendOpenOrders is DEX-scoped: HIP-3 TP/SL orders only appear when the
        # matching dex param is sent.  We call it once per DEX and merge the results.
        # Use the display-only cached variant (TTL 3 s) — absorbs duplicate polls
        # from concurrent users without touching bot execution paths.
        tasks = [self.get_clearinghouse_state_display(wallet_address, dex) for dex in dex_names]
        tasks.append(self.get_spot_state(wallet_address))
        tasks.append(self.get_user_fills(wallet_address))
        for dex in dex_names:
            tasks.append(self.get_open_orders(wallet_address, dex))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        perp_states = results[:len(dex_names)]
        spot_state  = results[len(dex_names)]
        fills       = results[len(dex_names) + 1]
        # Merge orders from every DEX into one flat list.
        open_orders: list = []
        for _res in results[len(dex_names) + 2:]:
            if not isinstance(_res, Exception) and isinstance(_res, list):
                open_orders.extend(_res)
        print(f"[portfolio] open_orders merged count={len(open_orders)} from {len(dex_names)} DEX(es)")

        # Fetch mark prices and sz_decimals for position enrichment
        try:
            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
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

        # Pre-process: build coin → list of {trigger_px, triggers_above} from TP/SL orders.
        # Real Hyperliquid TP/SL orders have isTrigger=True, reduceOnly=True, and
        # isPositionTpsl=False.  triggerCondition is a human string like "Price above 10"
        # or "Price below 85000".  Whether "above" means TP or SL depends on position side
        # (long: above=TP, below=SL; short: above=SL, below=TP), so we store the raw
        # direction and resolve at position-merge time when side is known.
        tpsl_triggers_by_coin: dict[str, list[dict]] = {}
        if not isinstance(open_orders, Exception) and isinstance(open_orders, list):
            # Diagnostic: log raw fields for any Stop order so we can confirm
            # whether isTrigger/reduceOnly are set (determines if our filter catches them).
            for order in open_orders:
                if isinstance(order, dict) and "stop" in (order.get("orderType") or "").lower():
                    print(
                        f"[portfolio] Stop order diagnostic — coin={order.get('coin')} "
                        f"orderType={order.get('orderType')!r} "
                        f"isTrigger={order.get('isTrigger')} "
                        f"reduceOnly={order.get('reduceOnly')} "
                        f"triggerPx={order.get('triggerPx')} "
                        f"triggerCondition={order.get('triggerCondition')!r}"
                    )

            for order in open_orders:
                if not isinstance(order, dict):
                    continue
                # Primary filter: isTrigger + reduceOnly (catches TP Market / SL Market).
                # Fallback filter: orderType contains "stop" or "take profit" + reduceOnly,
                # in case isTrigger is False for some order variants.
                otype_lower = (order.get("orderType") or "").lower()
                is_tpsl_by_flag   = order.get("isTrigger") and order.get("reduceOnly")
                is_tpsl_by_type   = ("stop" in otype_lower or "take profit" in otype_lower) and order.get("reduceOnly")
                if not (is_tpsl_by_flag or is_tpsl_by_type):
                    continue
                coin = order.get("coin", "")
                trigger_px_raw = order.get("triggerPx")
                trigger_px = float(trigger_px_raw or "0") if trigger_px_raw is not None else 0.0
                if trigger_px == 0.0:
                    continue
                condition = (order.get("triggerCondition") or "").lower()
                triggers_above = "above" in condition  # False means "below"
                entry = {
                    "trigger_px":     trigger_px,
                    "triggers_above": triggers_above,
                    "sz":             float(order.get("sz", "0") or "0"),
                    "orig_sz":        float(order.get("origSz", "0") or "0"),
                    "oid":            order.get("oid"),
                }
                # Index by full coin name (e.g. "xyz:XYZ100") AND by short name ("XYZ100")
                # so the lookup works regardless of whether clearinghouseState returns the
                # prefixed or un-prefixed form.
                tpsl_triggers_by_coin.setdefault(coin, []).append(entry)
                coin_short = coin.split(":")[-1] if ":" in coin else coin
                if coin_short != coin:
                    tpsl_triggers_by_coin.setdefault(coin_short, []).append(entry)

        # Step 3: aggregate perp positions across all DEXes.
        # Account Value and Available to Trade are NOT taken from clearinghouseState —
        # on a unified account the USDC collateral lives in spot, so the perp
        # marginSummary figures are a subset.  Both are derived from
        # spotClearinghouseState in Step 4.  clearinghouseState is used here only
        # for open positions and unrealized PnL.
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
            print(
                f"[portfolio] DEX={dex_label!r} perp accountValue={margin_summary.get('accountValue')!r} "
                f"perp withdrawable={state.get('withdrawable')!r} "
                f"(display values come from spot — see Step 4)"
            )

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
                coin_key  = pos.get("coin", "")
                entry_px  = float(pos.get("entryPx", "0") or "0")
                mark_px   = float(all_mids.get(coin_key, pos.get("entryPx", "0")) or "0")
                lev_val   = float((pos.get("leverage") or {}).get("value", 1) or 1)
                roe_pct   = 0.0
                if entry_px > 0 and mark_px > 0:
                    direction = 1 if szi > 0 else -1
                    roe_pct = round(((mark_px / entry_px) - 1) * lev_val * 100 * direction, 2)
                # Resolve TP/SL using position side:
                # Long:  triggers_above=True → TP,  triggers_above=False → SL
                # Short: triggers_above=True → SL,  triggers_above=False → TP
                is_long = szi > 0
                tp_price = None
                sl_price = None
                tp_orders: list[dict] = []
                sl_orders: list[dict] = []
                # Try full coin name first, fall back to short name (strips DEX prefix).
                coin_key_short = coin_key.split(":")[-1] if ":" in coin_key else coin_key
                triggers_for_coin = (
                    tpsl_triggers_by_coin.get(coin_key)
                    or tpsl_triggers_by_coin.get(coin_key_short)
                    or []
                )
                for trigger in triggers_for_coin:
                    order_info = {
                        "trigger_px": trigger["trigger_px"],
                        "sz":         trigger["sz"],
                        "orig_sz":    trigger["orig_sz"],
                        "oid":        trigger["oid"],
                    }
                    if trigger["triggers_above"]:
                        if is_long:
                            if tp_price is None:
                                tp_price = trigger["trigger_px"]
                            tp_orders.append(order_info)
                        else:
                            if sl_price is None:
                                sl_price = trigger["trigger_px"]
                            sl_orders.append(order_info)
                    else:
                        if is_long:
                            if sl_price is None:
                                sl_price = trigger["trigger_px"]
                            sl_orders.append(order_info)
                        else:
                            if tp_price is None:
                                tp_price = trigger["trigger_px"]
                            tp_orders.append(order_info)
                all_positions.append({
                    "dex":               dex_label,
                    "symbol":            coin_key,
                    "size":              szi,
                    "entry_price":       entry_px,
                    "position_value":    float(pos.get("positionValue", "0") or "0"),
                    "unrealized_pnl":    upnl,
                    "leverage":          (pos.get("leverage") or {}).get("value", 1),
                    "leverage_type":     (pos.get("leverage") or {}).get("type", "cross"),
                    "liquidation_price": float(pos.get("liquidationPx", "0") or "0"),
                    "margin_used":       float(pos.get("marginUsed", "0") or "0"),
                    "sz_decimals":       sz_decimals_map.get(coin_key, 5),
                    "mark_price":        mark_px,
                    "roe_pct":           roe_pct,
                    "tp_price":          tp_price,
                    "sl_price":          sl_price,
                    "tp_orders":         tp_orders,
                    "sl_orders":         sl_orders,
                    "opened_at":         None,
                })

        # Step 4: spot balances — source of truth for Account Value and Available to Trade.
        # On a Hyperliquid unified account the USDC collateral lives in spot; perp
        # marginSummary.accountValue is only the perp-margin subset.
        # We log ALL top-level fields of the response so we can verify exact field names
        # in production, then derive both display values from spot directly.
        spot_balances: list[dict] = []
        total_account_value = 0.0
        available_to_trade  = 0.0

        if not isinstance(spot_state, Exception) and isinstance(spot_state, dict):
            # Log every top-level key and the full balances array.
            spot_top = {k: v for k, v in spot_state.items() if k != "balances"}
            print(f"[portfolio] spotClearinghouseState top-level fields: {spot_top}")
            print(f"[portfolio] spotClearinghouseState balances: {spot_state.get('balances')}")

            for balance in (spot_state.get("balances") or []):
                if not isinstance(balance, dict):
                    continue
                amount = float(balance.get("total", "0") or "0")
                if amount > 0:
                    coin = balance.get("coin", "")
                    hold = float(balance.get("hold", "0") or "0")
                    spot_balances.append({
                        "coin":  coin,
                        "total": amount,
                        "hold":  hold,
                    })

            # Prefer top-level accountValue / withdrawable if the endpoint provides them
            # (Hyperliquid may extend spotClearinghouseState with these for unified accounts).
            # Fall back to USDC balance fields if they are absent.
            spot_acct_val    = float(spot_state.get("accountValue", 0) or 0)
            spot_withdrawable = float(spot_state.get("withdrawable", 0) or 0)

            usdc_entry = next((b for b in spot_balances if b["coin"] == "USDC"), None)
            usdc_total = usdc_entry["total"] if usdc_entry else 0.0
            usdc_hold  = usdc_entry["hold"]  if usdc_entry else 0.0

            total_account_value = spot_acct_val  if spot_acct_val  > 0 else usdc_total
            available_to_trade  = spot_withdrawable if spot_withdrawable > 0 else max(0.0, usdc_total - usdc_hold)

            print(
                f"[portfolio] spot accountValue field={spot_acct_val!r} "
                f"withdrawable field={spot_withdrawable!r} "
                f"usdc_total={usdc_total} usdc_hold={usdc_hold} "
                f"→ account_value={total_account_value} available_to_trade={available_to_trade}"
            )
        else:
            print(f"[portfolio] spotClearinghouseState unavailable: {spot_state}")

        # Step 5: recent fills (last 500 — frontend paginates at 10/page)
        recent_fills: list[dict] = []
        if not isinstance(fills, Exception) and isinstance(fills, list):
            for fill in fills[:500]:
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

        # Step 6: open orders (frontendOpenOrders includes TP/SL metadata)
        orders: list[dict] = []
        if not isinstance(open_orders, Exception) and isinstance(open_orders, list):
            for order in open_orders:
                if not isinstance(order, dict):
                    continue
                raw_trigger = order.get("triggerPx")
                orders.append({
                    "coin":             order.get("coin", ""),
                    "side":             order.get("side", ""),
                    "price":            float(order.get("limitPx", "0") or "0"),
                    "size":             float(order.get("sz", "0") or "0"),
                    "order_id":         order.get("oid", ""),
                    "time":             order.get("timestamp", 0),
                    "is_trigger":       bool(order.get("isTrigger", False)),
                    "is_position_tpsl": bool(order.get("isPositionTpsl", False)),
                    "order_type":       order.get("orderType", ""),
                    "trigger_px":       float(raw_trigger or "0") if raw_trigger else None,
                })

        usdc_spot = next(
            (b["total"] for b in spot_balances if b["coin"] == "USDC"), 0.0
        )

        # Sync position open timestamps and merge into positions
        current_coins = {p["symbol"] for p in all_positions}
        opened_at_map = await self._sync_position_opens(wallet_address, current_coins)
        for p in all_positions:
            p["opened_at"] = opened_at_map.get(p["symbol"])

        # Verify TP/SL extraction in Railway logs before values reach the frontend.
        for p in all_positions:
            print(
                f"[portfolio] position_tpsl — coin={p['symbol']!r} "
                f"tp_price={p['tp_price']} sl_price={p['sl_price']}"
            )

        return {
            "wallet_address":       wallet_address,
            "account_value":        round(total_account_value, 4),
            "unrealized_pnl":       round(total_unrealized_pnl, 4),
            "usdc_spot_balance":    round(usdc_spot, 4),
            "available_to_trade":   round(available_to_trade, 4),
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

    async def check_affiliation(self, wallet_address: str, referral_code: str) -> bool | None:
        """
        Two-step affiliation check with retry.

        Step 1 — direct: fetch the user's own referredBy field. This works for
        wallets that signed up through our referral link.

        Step 2 — master list: fetch the KNS master account's full referral list
        and check if the wallet appears there. This covers users who already had a
        Hyperliquid account and were affiliated via other means (e.g. airdrop,
        direct referral by another user, etc.).

        Returns:
            True  — Hyperliquid responded; wallet IS in referral data.
            False — Hyperliquid responded; wallet is genuinely NOT in referral data.
            None  — Transient API error; all retries exhausted. Caller must NOT
                    overwrite the existing DB value — this is not a confirmed result.
        """
        from core.config import settings

        _MAX_ATTEMPTS = 3
        _RETRY_DELAYS = [0.5, 1.0]  # seconds before attempt 2 and 3

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
                    # Step 1: check user's own referredBy code
                    resp1 = await client.post(
                        INFO_ENDPOINT,
                        json={"type": "referral", "user": wallet_address},
                        headers={"Content-Type": "application/json"},
                    )
                    data1 = resp1.json()
                    referred_by = data1.get("referredBy") or {}
                    code = referred_by.get("code", "")
                    if code.strip().upper() == referral_code.strip().upper():
                        print(f"[affiliation] {wallet_address} directly referred by '{referral_code}' ✅")
                        return True

                    print(f"[affiliation] {wallet_address} referredBy='{code}' (expected '{referral_code}') — checking master list…")

                    # Step 2: fetch master account's full referral list
                    master_address = settings.hyperliquid_master_address
                    if not master_address:
                        print(f"[affiliation] HYPERLIQUID_MASTER_ADDRESS not set — skipping master list check")
                        return False

                    resp2 = await client.post(
                        INFO_ENDPOINT,
                        json={"type": "referral", "user": master_address},
                        headers={"Content-Type": "application/json"},
                    )
                    data2 = resp2.json()
                    referrals = data2.get("referrals") or []
                    referred_addresses = [
                        r.get("referee", "").lower()
                        for r in referrals
                        if isinstance(r, dict)
                    ]
                    print(f"[affiliation] master list has {len(referred_addresses)} referee(s)")

                    if wallet_address.lower() in referred_addresses:
                        print(f"[affiliation] {wallet_address} found in master referral list ✅")
                        return True

                    # Hyperliquid responded cleanly — wallet genuinely not affiliated.
                    # Do not retry: a successful response with no match is authoritative.
                    print(f"[affiliation] {wallet_address} NOT found in any referral list ❌")
                    return False

            except Exception as e:
                print(f"[affiliation] attempt {attempt}/{_MAX_ATTEMPTS} ERROR type={type(e).__name__} msg={e}")
                if attempt < _MAX_ATTEMPTS:
                    await asyncio.sleep(_RETRY_DELAYS[attempt - 1])

        print(f"[affiliation] {wallet_address} — all {_MAX_ATTEMPTS} attempts failed (transient error)")
        return None

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
        coin           = full coin name including dex prefix for HIP-3 (e.g. "xyz:XYZ100")
        """
        # Extract DEX name from coin prefix for HIP-3 coins (e.g. "xyz:XYZ100" → dex="xyz")
        dex_name = coin.split(":")[0] if ":" in coin else None

        # Size is already rounded by the frontend; just validate it is positive
        if size <= 0:
            raise ValueError(
                f"Size must be greater than 0 (received {size}). "
                f"Increase USD amount."
            )

        import asyncio

        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        lock = self._get_wallet_lock(master_address)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error(
                "[place_order] Could not acquire wallet lock within %ss — "
                "coin=%s wallet=%s — likely held by a stalled call elsewhere",
                _LOCK_ACQUIRE_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Wallet lock timeout after {_LOCK_ACQUIRE_TIMEOUT_S}s — another operation may be stuck"
            )
        try:
            account = eth_account.Account.from_key(private_key)

            # Build perp_dexs list for HIP-3 coins; standard HL perps use None.
            # Exchange() is constructed INSIDE the thread closure below — not on
            # the event loop — because the Hyperliquid SDK may call requests.get()
            # in Exchange.__init__ (to fetch coin metadata), which would block the
            # event loop.  Keeping all SDK calls inside asyncio.to_thread also
            # ensures Python 3.11's asyncio.wait_for bug (where a non-cancellable
            # concurrent.futures.Future causes wait_for to await the thread instead
            # of raising TimeoutError immediately) resolves within _EXCHANGE_CALL_TIMEOUT_S
            # because the thread's own requests.post() has the same timeout.
            dex_list = [dex_name] if dex_name else []

            if order_type == "market":
                slippage = 0.05
                raw_price = price * (1 + slippage) if is_buy else price * (1 - slippage)
                limit_price = _round_price(raw_price)
                def _do_market_order():
                    exch = Exchange(
                        account, constants.MAINNET_API_URL,
                        account_address=master_address,
                        perp_dexs=dex_list if dex_list else None,
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                    return exch.order(coin, is_buy, size, limit_price, {"limit": {"tif": "Ioc"}})
                try:
                    order_result = await asyncio.wait_for(
                        asyncio.to_thread(_do_market_order),
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "[place_order] Exchange call timed out after %ss — coin=%s wallet=%s",
                        _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                    )
                    raise RuntimeError(
                        f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                    )
            else:
                rounded_price = _round_price(price)
                def _do_limit_order():
                    exch = Exchange(
                        account, constants.MAINNET_API_URL,
                        account_address=master_address,
                        perp_dexs=dex_list if dex_list else None,
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                    return exch.order(coin, is_buy, size, rounded_price, {"limit": {"tif": "Gtc"}})
                try:
                    order_result = await asyncio.wait_for(
                        asyncio.to_thread(_do_limit_order),
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "[place_order] Exchange call timed out after %ss — coin=%s wallet=%s",
                        _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                    )
                    raise RuntimeError(
                        f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                    )
        finally:
            lock.release()

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

        lock = self._get_wallet_lock(master_address)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error(
                "[cancel_order] Could not acquire wallet lock within %ss — "
                "coin=%s wallet=%s",
                _LOCK_ACQUIRE_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Wallet lock timeout after {_LOCK_ACQUIRE_TIMEOUT_S}s — another operation may be stuck"
            )
        try:
            account = eth_account.Account.from_key(private_key)
            dex_list = [dex_name] if dex_name else []
            def _do_cancel():
                exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
                return exch.cancel(coin, order_id)
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(_do_cancel),
                    timeout=_EXCHANGE_CALL_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "[cancel_order] Exchange call timed out after %ss — coin=%s wallet=%s",
                    _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                )
                raise RuntimeError(
                    f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                )
        finally:
            lock.release()

        print(f"[cancel_order] result={result}")
        return result

    async def modify_order(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        oid: int,
        new_trigger_px: float,
        is_buy: bool,
        sz: float,
        sz_decimals: int,
        tpsl: str,
    ) -> dict:
        """Modify an existing trigger order's triggerPx using the Hyperliquid modify action."""
        dex_name = coin.split(":")[0] if ":" in coin else None
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        factor = 10 ** sz_decimals
        rounded_sz = math.floor(sz * factor) / factor
        if rounded_sz <= 0:
            raise ValueError("Size too small after rounding.")

        px = round(new_trigger_px) if new_trigger_px >= 1000 else round(new_trigger_px, 1) if new_trigger_px >= 10 else round(new_trigger_px, 2)

        lock = self._get_wallet_lock(master_address)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error(
                "[modify_order] Could not acquire wallet lock within %ss — "
                "coin=%s wallet=%s",
                _LOCK_ACQUIRE_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Wallet lock timeout after {_LOCK_ACQUIRE_TIMEOUT_S}s — another operation may be stuck"
            )
        try:
            account = eth_account.Account.from_key(private_key)
            dex_list = [dex_name] if dex_name else []
            def _do_modify():
                exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
                return exch.modify_order(oid, coin, is_buy, rounded_sz, px, {"trigger": {"triggerPx": px, "isMarket": True, "tpsl": tpsl}}, True)
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(_do_modify),
                    timeout=_EXCHANGE_CALL_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "[modify_order] Exchange call timed out after %ss — coin=%s wallet=%s",
                    _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                )
                raise RuntimeError(
                    f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                )
        finally:
            lock.release()

        print(f"[modify_order] oid={oid} coin={coin} new_trigger_px={px} tpsl={tpsl} result={result}")
        return result

    async def modify_order_price(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        oid: int,
        is_buy: bool,
        sz: float,
        sz_decimals: int,
        new_price: float,
        order_type: str,   # "limit" | "tp" | "sl"
    ) -> dict:
        """Modify any order's price — handles plain limit orders as well as TP/SL triggers."""
        dex_name = coin.split(":")[0] if ":" in coin else None
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        factor = 10 ** sz_decimals
        rounded_sz = math.floor(sz * factor) / factor
        if rounded_sz <= 0:
            raise ValueError("Size too small after rounding.")

        account = eth_account.Account.from_key(private_key)
        dex_list = [dex_name] if dex_name else []

        # Price rounding — consistent with existing modify_order logic
        if new_price >= 1000:
            px = round(new_price)
        elif new_price >= 10:
            px = round(new_price, 1)
        else:
            px = round(new_price, 2)

        if order_type == "limit":
            order_type_dict = {"limit": {"tif": "Gtc"}}
            reduce_only = False
        elif order_type == "tp":
            order_type_dict = {"trigger": {"triggerPx": px, "isMarket": False, "tpsl": "tp"}}
            reduce_only = True
        else:  # "sl"
            order_type_dict = {"trigger": {"triggerPx": px, "isMarket": True, "tpsl": "sl"}}
            reduce_only = True

        def _do_modify_price():
            exch = Exchange(
                account, constants.MAINNET_API_URL,
                account_address=master_address,
                perp_dexs=dex_list if dex_list else None,
                timeout=_EXCHANGE_CALL_TIMEOUT_S,
            )
            return exch.modify_order(oid, coin, is_buy, rounded_sz, px, order_type_dict, reduce_only)
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(_do_modify_price),
                timeout=_EXCHANGE_CALL_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.error(
                "[modify_order_price] Exchange call timed out after %ss — coin=%s wallet=%s",
                _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
            )
        print(f"[modify_order_price] oid={oid} coin={coin} order_type={order_type} px={px} result={result}")
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

        def _do_close():
            exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
            return exch.order(coin, is_close_buy, close_size, limit_price, {"limit": {"tif": "Ioc"}})
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(_do_close),
                timeout=_EXCHANGE_CALL_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.error(
                "[close_position] Exchange call timed out after %ss — coin=%s wallet=%s",
                _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
            )
        print(f"[close_position] result={result}")
        return result

    async def set_leverage(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        leverage: int,
        is_cross: bool,
    ) -> dict:
        dex_name = coin.split(":")[0] if ":" in coin else None
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        lock = self._get_wallet_lock(master_address)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error(
                "[set_leverage] Could not acquire wallet lock within %ss — "
                "coin=%s wallet=%s",
                _LOCK_ACQUIRE_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Wallet lock timeout after {_LOCK_ACQUIRE_TIMEOUT_S}s — another operation may be stuck"
            )
        try:
            account = eth_account.Account.from_key(private_key)
            dex_list = [dex_name] if dex_name else []
            def _do_set_leverage():
                exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
                return exch.update_leverage(leverage, coin, is_cross)
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(_do_set_leverage),
                    timeout=_EXCHANGE_CALL_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "[set_leverage] Exchange call timed out after %ss — coin=%s wallet=%s",
                    _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                )
                raise RuntimeError(
                    f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                )
        finally:
            lock.release()
        print(f"[set_leverage] coin={coin} leverage={leverage} is_cross={is_cross} result={result}")
        return result

    async def place_tp_sl(
        self,
        private_key: str,
        master_address: str,
        coin: str,
        is_long: bool,
        size: float,
        sz_decimals: int,
        tp_price: float | None,
        sl_price: float | None,
    ) -> dict:
        dex_name = coin.split(":")[0] if ":" in coin else None
        import asyncio
        import eth_account
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants

        factor = 10 ** sz_decimals
        rounded_size = math.floor(size * factor) / factor
        if rounded_size <= 0:
            raise ValueError("Size too small after rounding.")

        # Close side is opposite of position side
        is_close_buy = not is_long
        results = {}

        lock = self._get_wallet_lock(master_address)
        try:
            await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error(
                "[place_tp_sl] Could not acquire wallet lock within %ss — "
                "coin=%s wallet=%s",
                _LOCK_ACQUIRE_TIMEOUT_S, coin, master_address,
            )
            raise RuntimeError(
                f"Wallet lock timeout after {_LOCK_ACQUIRE_TIMEOUT_S}s — another operation may be stuck"
            )
        try:
            account = eth_account.Account.from_key(private_key)
            dex_list = [dex_name] if dex_name else []

            if tp_price is not None and tp_price > 0:
                tp_px = round(tp_price) if tp_price >= 1000 else round(tp_price, 1) if tp_price >= 10 else round(tp_price, 2)
                def _do_tp():
                    exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
                    return exch.order(coin, is_close_buy, rounded_size, tp_px, {"trigger": {"triggerPx": tp_px, "isMarket": True, "tpsl": "tp"}}, True)
                try:
                    tp_result = await asyncio.wait_for(
                        asyncio.to_thread(_do_tp),
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "[place_tp_sl] TP exchange call timed out after %ss — coin=%s wallet=%s",
                        _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                    )
                    raise RuntimeError(
                        f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                    )
                print(f"[tp_sl] TP result={tp_result}")
                results["tp"] = tp_result

            if sl_price is not None and sl_price > 0:
                sl_px = round(sl_price) if sl_price >= 1000 else round(sl_price, 1) if sl_price >= 10 else round(sl_price, 2)
                def _do_sl():
                    exch = Exchange(account, constants.MAINNET_API_URL, account_address=master_address, perp_dexs=dex_list if dex_list else None, timeout=_EXCHANGE_CALL_TIMEOUT_S)
                    return exch.order(coin, is_close_buy, rounded_size, sl_px, {"trigger": {"triggerPx": sl_px, "isMarket": True, "tpsl": "sl"}}, True)
                try:
                    sl_result = await asyncio.wait_for(
                        asyncio.to_thread(_do_sl),
                        timeout=_EXCHANGE_CALL_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "[place_tp_sl] SL exchange call timed out after %ss — coin=%s wallet=%s",
                        _EXCHANGE_CALL_TIMEOUT_S, coin, master_address,
                    )
                    raise RuntimeError(
                        f"Hyperliquid exchange call timed out after {_EXCHANGE_CALL_TIMEOUT_S}s"
                    )
                print(f"[tp_sl] SL result={sl_result}")
                results["sl"] = sl_result
        finally:
            lock.release()

        return results


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
    try:
        async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
            # Flat list of meta dicts, one per DEX
            metas_resp = await client.post(
                INFO_ENDPOINT,
                json={"type": "allPerpMetas"},
                headers={"Content-Type": "application/json"},
            )
            all_metas = metas_resp.json()

            # Main DEX mark prices: returns [meta_dict, [ctx1, ctx2, ...]]
            ctxs_resp = await client.post(
                INFO_ENDPOINT,
                json={"type": "metaAndAssetCtxs"},
                headers={"Content-Type": "application/json"},
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
            )
            all_mids = mids_resp.json()

        logger.info(f"[get_all_markets] allPerpMetas len={len(all_metas)} main price map size={len(main_price_map)}")

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
        logger.info(f"[get_all_markets] total markets={len(markets)}")
        return markets
    except Exception as e:
        logger.error(f"[get_all_markets] failed: {e}")
        return []


async def get_recent_trades(coin: str) -> list:
    """Get the last 20 recent trades for *coin*."""
    try:
        async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "recentTrades", "coin": coin},
                headers={"Content-Type": "application/json"},
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
    except Exception as e:
        logger.error(f"[get_recent_trades] {coin} failed: {e}")
        return []


async def get_candles(coin: str, interval: str, limit: int = 500) -> list:
    """
    Get OHLCV candles for any coin including HIP-3.
    coin:     full name e.g. "BTC" or "xyz:XYZ100"
    interval: "1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d","1w"
    """
    # Cache key encodes every parameter that affects the result.
    cache_key = f"candles:{coin}:{interval}:{limit}"

    async def _fetch() -> list:
        try:
            end_time = int(_time_module.time() * 1000)

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

            async with httpx.AsyncClient(timeout=_EXCHANGE_CALL_TIMEOUT_S) as client:
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
                )
                candles = response.json()

            # Explicit type guard: Hyperliquid occasionally returns JSON null (None)
            # instead of an empty list for unknown/delisted coins or during transient
            # outages.  Without this check the for-loop below would raise
            # TypeError: 'NoneType' object is not iterable, which the outer except
            # would catch and log — but the explicit check gives a cleaner warning.
            if not isinstance(candles, list):
                logger.warning(
                    "[get_candles] %s/%s: API returned non-list (%s: %r) — returning empty",
                    coin, interval, type(candles).__name__, candles,
                )
                return []

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
        except Exception as e:
            logger.error(f"[get_candles] {coin}/{interval} failed: {e}")
            return []

    return await _market_cache.get_or_fetch(
        cache_key, _market_cache.TTL_CANDLES, _fetch
    )
