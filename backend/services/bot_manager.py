"""
Bot manager — placeholder

Will manage the lifecycle of automated trading bots:
- Start / stop bots
- Track running bot tasks
- Persist state in Supabase
"""
from __future__ import annotations

import asyncio
from typing import Dict


class BotManager:
    """Registry and lifecycle manager for trading bots."""

    def __init__(self):
        self._running: Dict[str, asyncio.Task] = {}

    async def start(self, bot_id: str, config: dict) -> None:
        if bot_id in self._running:
            return  # already running
        # task = asyncio.create_task(self._run_bot(bot_id, config))
        # self._running[bot_id] = task
        raise NotImplementedError("Bot execution not yet implemented")

    async def stop(self, bot_id: str) -> None:
        task = self._running.pop(bot_id, None)
        if task:
            task.cancel()

    def list_running(self) -> list[str]:
        return list(self._running.keys())


bot_manager = BotManager()
