"""Bots router — placeholder"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def list_bots():
    # TODO: fetch bots from Supabase for authenticated user
    return {"bots": []}


@router.post("/")
async def create_bot(payload: dict):
    # TODO: persist bot config, start via bot_manager
    return {"status": "placeholder", "payload": payload}


@router.delete("/{bot_id}")
async def stop_bot(bot_id: str):
    # TODO: call bot_manager.stop(bot_id)
    return {"status": "placeholder", "bot_id": bot_id}
