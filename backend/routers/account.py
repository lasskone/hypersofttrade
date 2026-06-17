"""Account router — placeholder"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/{address}")
async def get_account(address: str):
    # TODO: call hyperliquid_service.get_account_info(address)
    return {"address": address, "status": "placeholder"}


@router.get("/{address}/positions")
async def get_positions(address: str):
    # TODO: call hyperliquid_service.get_positions(address)
    return {"address": address, "positions": []}
