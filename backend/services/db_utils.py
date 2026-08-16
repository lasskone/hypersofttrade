"""
backend/services/db_utils.py

Shared helper for safe Supabase .execute() calls inside the async event loop.

supabase-py's synchronous client calls .execute() synchronously — meaning the
call blocks the OS thread it runs on.  When that thread IS the asyncio event
loop thread (the common pattern when the supabase client is called directly
from an async function with no await), a stalled Supabase connection freezes
the entire event loop: no ticks fire, no Hyperliquid calls can proceed, the
bot goes silent.  This is the same class of bug that was previously fixed for
Hyperliquid HTTP calls in hyperliquid_service.py.

_run_db_call() fixes this by:
  1. Offloading the synchronous .execute() to a thread pool via asyncio.to_thread,
     so the event loop is never blocked.
  2. Applying asyncio.wait_for with a hard 15-second timeout so a stalled
     Supabase connection raises asyncio.TimeoutError rather than hanging forever.

Usage
-----
    from services.db_utils import _run_db_call, _SUPABASE_CALL_TIMEOUT_S

    res = await _run_db_call(
        lambda: db.table("my_table").select("*").eq("id", row_id).execute()
    )
"""
from __future__ import annotations

import asyncio

_SUPABASE_CALL_TIMEOUT_S: float = 15.0


async def _run_db_call(fn):
    """Run a synchronous supabase-py .execute() chain in a thread with a timeout.

    Offloads ``fn`` (a zero-argument callable that ends in .execute()) to the
    default asyncio thread-pool executor and applies a hard timeout.

    Raises
    ------
    asyncio.TimeoutError
        If the call does not complete within _SUPABASE_CALL_TIMEOUT_S seconds.
        Callers should catch this explicitly and log a clear message — do NOT
        let it silently fall through a broad ``except Exception`` without noting
        that a Supabase timeout occurred.
    """
    return await asyncio.wait_for(asyncio.to_thread(fn), timeout=_SUPABASE_CALL_TIMEOUT_S)
