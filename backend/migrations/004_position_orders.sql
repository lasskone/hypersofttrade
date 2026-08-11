-- Migration 004: Add position_orders table.
--
-- WHY: Persists every bot-placed order's oid (entry, dca_0..dca_3, sl, tp)
-- to Supabase so oids survive worker restarts and can be attributed back to
-- their source bot in the UI (Open Orders "Source" column, History "Source"
-- column). Previously, self._sl_oid / self._dca_oids etc. existed only in
-- the Python process heap and were lost on every Railway redeploy or crash.
--
-- HOW TO APPLY: Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → Run). IF NOT EXISTS guards make it safe to re-run.

CREATE TABLE IF NOT EXISTS position_orders (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    position_group_id UUID        REFERENCES position_groups(id) ON DELETE CASCADE,
    bot_id            UUID        REFERENCES bots(id) ON DELETE SET NULL,
    oid               BIGINT      NOT NULL,
    order_role        TEXT        NOT NULL CHECK (order_role IN ('entry', 'dca_0', 'dca_1', 'dca_2', 'dca_3', 'sl', 'tp')),
    coin              TEXT        NOT NULL,
    status            TEXT        NOT NULL DEFAULT 'resting' CHECK (status IN ('resting', 'filled', 'cancelled')),
    placed_at         TIMESTAMPTZ DEFAULT NOW(),
    filled_at         TIMESTAMPTZ
);

ALTER TABLE position_orders ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_position_orders_oid              ON position_orders(oid);
CREATE INDEX IF NOT EXISTS idx_position_orders_position_group_id ON position_orders(position_group_id);
CREATE INDEX IF NOT EXISTS idx_position_orders_bot_id           ON position_orders(bot_id);
