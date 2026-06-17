"""Orders router — placeholder"""
from fastapi import APIRouter

router = APIRouter()


@router.post("/place")
async def place_order(payload: dict):
    # TODO: validate payload, call hyperliquid_service.place_order
    return {"status": "placeholder", "payload": payload}


@router.delete("/{order_id}")
async def cancel_order(order_id: str):
    # TODO: call hyperliquid_service.cancel_order(order_id)
    return {"status": "placeholder", "order_id": order_id}
