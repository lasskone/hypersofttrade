"""
Bot management routes — /bots prefix
"""
from __future__ import annotations
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from supabase import create_client

from services.bot_manager import bot_manager

router = APIRouter()

def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


class CreateBotRequest(BaseModel):
    wallet_address: str
    name: str
    bot_type: str  # "grid" | "envelope_dca"
    symbol: str
    allocated_usdc: float
    config: dict  # strategy-specific params


class BotActionRequest(BaseModel):
    wallet_address: str


@router.get("/")
async def list_bots(wallet_address: str):
    db = _supabase()
    user = db.table("users").select("id").ilike("wallet_address", wallet_address).limit(1).execute()
    if not user.data:
        return {"bots": []}
    user_id = user.data[0]["id"]
    bots = db.table("bots").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
    result = []
    for b in bots.data:
        b["is_running"] = bot_manager.is_running(b["id"])
        result.append(b)
    return {"bots": result}


@router.post("/")
async def create_bot(body: CreateBotRequest):
    db = _supabase()
    user = db.table("users").select("id").ilike("wallet_address", body.wallet_address).limit(1).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    user_id = user.data[0]["id"]
    bot_id = str(uuid.uuid4())
    config = {**body.config, "bot_type": body.bot_type, "symbol": body.symbol, "allocated_usdc": body.allocated_usdc}
    db.table("bots").insert({
        "id": bot_id,
        "user_id": user_id,
        "name": body.name,
        "bot_type": body.bot_type,
        "symbol": body.symbol,
        "allocated_usdc": body.allocated_usdc,
        "config": config,
        "status": "stopped",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    return {"success": True, "bot_id": bot_id}


@router.post("/{bot_id}/start")
async def start_bot(bot_id: str, body: BotActionRequest):
    db = _supabase()
    bot = db.table("bots").select("*").eq("id", bot_id).limit(1).execute()
    if not bot.data:
        raise HTTPException(status_code=404, detail="Bot not found")
    b = bot.data[0]
    if bot_manager.is_running(bot_id):
        return {"success": True, "message": "Already running"}
    db.table("bots").update({"error_message": None, "status": "stopped", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", bot_id).execute()
    await bot_manager.start(bot_id, b["config"], body.wallet_address)
    return {"success": True, "message": "Bot started"}


@router.post("/{bot_id}/stop")
async def stop_bot(bot_id: str):
    await bot_manager.stop(bot_id)
    return {"success": True, "message": "Bot stopped"}


@router.delete("/{bot_id}")
async def delete_bot(bot_id: str):
    await bot_manager.stop(bot_id)
    db = _supabase()
    db.table("bot_logs").delete().eq("bot_id", bot_id).execute()
    db.table("bots").delete().eq("id", bot_id).execute()
    return {"success": True}


@router.put("/{bot_id}")
async def update_bot(bot_id: str, body: dict):
    wallet_address = body.get("wallet_address")
    new_config = body.get("config")
    if not wallet_address or not new_config:
        raise HTTPException(status_code=400, detail="wallet_address and config required")

    db = _supabase()
    user = db.table("users").select("id").ilike("wallet_address", wallet_address).limit(1).execute()
    if not user.data:
        raise HTTPException(status_code=404, detail="User not found")
    user_id = user.data[0]["id"]

    existing = db.table("bots").select("*").eq("id", bot_id).eq("user_id", user_id).limit(1).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Bot not found")
    bot = existing.data[0]
    if bot_manager.is_running(bot_id):
        raise HTTPException(status_code=400, detail="Stop the bot before editing its configuration")

    # Always preserve bot_type — never trust the client payload to include it correctly;
    # this is the field that determines which strategy actually runs.
    new_config = {**new_config, "bot_type": bot.get("bot_type")}

    update_data: dict = {"config": new_config, "updated_at": datetime.now(timezone.utc).isoformat()}
    new_name = body.get("name")
    if new_name:
        update_data["name"] = new_name
    result = db.table("bots").update(update_data).eq("id", bot_id).execute()
    return result.data[0] if result.data else {"success": True}


@router.get("/{bot_id}/logs")
async def get_bot_logs(bot_id: str, limit: int = 50):
    db = _supabase()
    logs = db.table("bot_logs").select("*").eq("bot_id", bot_id).order("created_at", desc=True).limit(limit).execute()
    return {"logs": logs.data}
