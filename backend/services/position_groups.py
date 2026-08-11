"""
Shared service module for managing position_groups records.

position_groups is the source of truth for tracking which orders and trailing
stops belong to which specific position instance. It replaces the fragile
wallet+coin matching convention, where a stale record from a prior trade could
silently attach itself to a new position opened on the same coin.

This module is intentionally dependency-free (no FastAPI, no bot imports) so it
can be called from any context: bot strategies, the worker reconciliation loop,
and manual trading routes alike.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

from supabase import create_client


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


async def create_position_group(
    db,
    wallet_address: str,
    coin: str,
    dex: str | None,
    side: str,
    entry_price: float,
    source_type: str,
    bot_id: str | None = None,
) -> str:
    """Insert a new open position_group row and return its id.

    Parameters
    ----------
    db:
        An active Supabase client (from _supabase() or passed in by the caller).
    wallet_address:
        Master wallet address — stored lowercased for consistency.
    coin:
        Coin identifier as used on Hyperliquid (e.g. "BTC", "xyz:XYZ100").
    dex:
        DEX prefix for HIP-3 coins (e.g. "xyz"), or None for main perps.
    side:
        "long" or "short".
    entry_price:
        Mark price at the time of entry.
    source_type:
        "bot" or "manual".
    bot_id:
        UUID of the bots row that opened this position, or None for manual trades.

    Returns
    -------
    str
        The UUID of the newly created position_group row.

    Raises
    ------
    RuntimeError
        If the Supabase insert does not return a row.
    """
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "wallet_address": wallet_address.lower(),
        "coin": coin,
        "dex": dex or "",
        "side": side,
        "entry_price": entry_price,
        "source_type": source_type,
        "bot_id": bot_id,
        "status": "open",
        "created_at": now,
    }
    res = db.table("position_groups").insert(row).execute()
    if not res.data:
        raise RuntimeError(
            f"[position_groups] create_position_group failed — no row returned "
            f"(wallet={wallet_address} coin={coin} side={side})"
        )
    return str(res.data[0]["id"])


async def close_position_group(db, position_group_id: str) -> None:
    """Mark a position_group as closed and cancel any linked trailing stops.

    Safe to call multiple times — the position_groups update is filtered to
    status='open' so a second call is a no-op. The trailing_stops cancellation
    is similarly idempotent (only rows in waiting/active are touched).

    Parameters
    ----------
    db:
        An active Supabase client.
    position_group_id:
        UUID of the position_group to close.
    """
    now = datetime.now(timezone.utc).isoformat()

    # Close the position group (only if currently open — idempotent).
    db.table("position_groups").update({
        "status": "closed",
        "closed_at": now,
    }).eq("id", position_group_id).eq("status", "open").execute()

    # Cancel any waiting/active trailing stops scoped to this position group.
    # This is more precise than wallet+coin matching: only stops that were
    # explicitly linked to this position instance are cancelled.
    linked_ts = (
        db.table("trailing_stops")
        .select("id")
        .eq("position_group_id", position_group_id)
        .in_("status", ["waiting", "active"])
        .execute()
    )
    for rec in (linked_ts.data or []):
        db.table("trailing_stops").update({
            "status": "cancelled",
            "updated_at": now,
        }).eq("id", rec["id"]).execute()


async def record_position_order(
    db,
    position_group_id: str,
    bot_id: Optional[str],
    oid: int,
    order_role: str,
    coin: str,
) -> None:
    """Insert a row into position_orders for a freshly-placed bot order.

    Parameters
    ----------
    db:
        An active Supabase client.
    position_group_id:
        UUID of the parent position_group (must already exist).
    bot_id:
        UUID of the bots row, or None if not available.
    oid:
        Hyperliquid integer order ID (BIGINT).
    order_role:
        One of 'entry', 'dca_0', 'dca_1', 'dca_2', 'dca_3', 'sl', 'tp'.
    coin:
        Coin identifier (e.g. "BTC", "xyz:XYZ100").

    Notes
    -----
    This function is intentionally fire-and-forget: callers MUST wrap it in
    try/except so that a tracking failure never crashes a real-money strategy.
    """
    db.table("position_orders").insert({
        "position_group_id": position_group_id,
        "bot_id":            bot_id,
        "oid":               oid,
        "order_role":        order_role,
        "coin":              coin,
        "status":            "resting",
        "placed_at":         datetime.now(timezone.utc).isoformat(),
    }).execute()


async def mark_position_order_filled(db, oid: int) -> None:
    """Update a position_orders row's status to 'filled' when Hyperliquid confirms the fill.

    Parameters
    ----------
    db:
        An active Supabase client.
    oid:
        Hyperliquid integer order ID to mark as filled.

    Notes
    -----
    Matches on oid only — oids are exchange-unique per instrument per session.
    Safe to call on an already-filled row (the update simply becomes a no-op
    if the row status is already 'filled').
    """
    db.table("position_orders").update({
        "status":    "filled",
        "filled_at": datetime.now(timezone.utc).isoformat(),
    }).eq("oid", oid).execute()


async def get_open_position_group(
    db,
    wallet_address: str,
    coin: str,
) -> dict | None:
    """Return the most recent open position_group for a wallet+coin, or None.

    Used for the self-healing path: when a trailing stop is created on a
    position that predates position_groups (e.g. a pre-existing position or a
    bot type not yet migrated), callers can look up or create a group on the fly.

    Parameters
    ----------
    db:
        An active Supabase client.
    wallet_address:
        Master wallet address (case-insensitive match).
    coin:
        Coin identifier.

    Returns
    -------
    dict or None
        The full position_group row dict, or None if no open group exists.
    """
    res = (
        db.table("position_groups")
        .select("*")
        .ilike("wallet_address", wallet_address)
        .eq("coin", coin)
        .eq("status", "open")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if res.data:
        return res.data[0]
    return None
