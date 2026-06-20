"""
Standalone worker process — runs all active trading bots independently from the
FastAPI web server. This process can run continuously while the API service is
redeployed, ensuring bots are never interrupted by unrelated code/UI changes.

Reconciliation loop:
- Polls the `bots` table every POLL_INTERVAL seconds
- For each bot: compares desired_status (what the user wants) against the worker's
  own in-memory task state (what is actually running)
- Starts tasks for bots that should be running but aren't
- Cancels tasks for bots that are running but shouldn't be
- Writes status + last_heartbeat back to Supabase so the API can report live state
  without needing access to this process's memory

NOTE on wallet_address:
  The `bots` table stores only `user_id` (not wallet_address directly). The worker
  joins through the `users` table to get the master wallet_address, which is required
  by BotManager.start() to fetch the encrypted API key and identify the account.
"""
from __future__ import annotations
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))

# Load .env for local development (no-op in Railway where env vars are injected)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from supabase import create_client
from services.bot_manager import BotManager

POLL_INTERVAL = 5  # seconds between reconciliation passes


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


bot_manager = BotManager()


async def reconcile_loop():
    print("[worker] Reconciliation loop starting...", flush=True)
    while True:
        try:
            db = _supabase()

            # Join bots → users to get the master wallet_address in one query.
            # The bots table has no direct wallet_address column — only user_id.
            result = db.table("bots").select("*, users(wallet_address)").execute()
            bots = result.data or []

            for bot in bots:
                bot_id = bot["id"]
                desired = bot.get("desired_status", "stopped")
                is_running_locally = bot_manager.is_running(bot_id)

                # Extract wallet_address from the joined users row
                user_row = bot.get("users") or {}
                wallet_address = user_row.get("wallet_address", "")

                if desired == "running" and not is_running_locally:
                    if not wallet_address:
                        print(f"[worker] Cannot start bot {bot_id} — wallet_address missing (user row: {user_row})", flush=True)
                        continue
                    print(f"[worker] Starting bot {bot_id} ({bot.get('name')}) for wallet {wallet_address[:8]}...", flush=True)
                    try:
                        cfg = bot.get("config", {})
                        print(f"[worker] DEBUG bot_id={bot_id} bot_type_in_config={cfg.get('bot_type')} full_config_keys={list(cfg.keys())}", flush=True)
                        await bot_manager.start(bot_id, cfg, wallet_address)
                        db.table("bots").update({
                            "status": "running",
                            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", bot_id).execute()
                    except Exception as e:
                        print(f"[worker] Failed to start bot {bot_id}: {e}", flush=True)
                        db.table("bots").update({
                            "status": "error",
                            "error_message": str(e),
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("id", bot_id).execute()

                elif desired == "stopped" and is_running_locally:
                    print(f"[worker] Stopping bot {bot_id} ({bot.get('name')})", flush=True)
                    await bot_manager.stop(bot_id)
                    db.table("bots").update({
                        "status": "stopped",
                        "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", bot_id).execute()

                elif desired == "running" and is_running_locally:
                    # Bot already running as expected — just update heartbeat
                    db.table("bots").update({
                        "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", bot_id).execute()

        except Exception as e:
            print(f"[worker] Reconciliation error: {e}", flush=True)

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(reconcile_loop())
