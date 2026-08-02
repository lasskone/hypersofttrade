-- Migration 003: Add position_groups table and link trailing_stops to it.
--
-- WHY: Previously, trailing stops (and any future position-scoped records) were
-- matched to positions using wallet_address + coin alone. This is ambiguous when
-- a coin is traded multiple times — a stale trailing_stop row from a prior trade
-- could silently attach itself to a new position. position_groups is the new source
-- of truth for tracking which orders and trailing stops belong to which specific
-- position instance, replacing the fragile wallet+coin matching convention.
--
-- HOW TO APPLY: Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → Run). Do not run it more than once — the
-- IF NOT EXISTS guards are safe but the trailing_stops ALTER is in a DO block.

-- ---------------------------------------------------------------------------
-- New table: position_groups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS position_groups (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT        NOT NULL,
    coin           TEXT        NOT NULL,
    dex            TEXT,
    side           TEXT        NOT NULL CHECK (side IN ('long', 'short')),
    source_type    TEXT        NOT NULL CHECK (source_type IN ('bot', 'manual')),
    bot_id         UUID        REFERENCES bots(id) ON DELETE SET NULL,
    entry_price    NUMERIC     NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    closed_at      TIMESTAMPTZ
);

ALTER TABLE position_groups ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_position_groups_wallet_coin_status ON position_groups(wallet_address, coin, status);
CREATE INDEX IF NOT EXISTS idx_position_groups_bot_id ON position_groups(bot_id);

-- ---------------------------------------------------------------------------
-- Link trailing_stops → position_groups
--
-- trailing_stops was created manually in Supabase (not via a prior migration),
-- so we guard with an IF NOT EXISTS check on information_schema.columns rather
-- than assuming a known schema state.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'trailing_stops' AND column_name = 'position_group_id'
    ) THEN
        ALTER TABLE trailing_stops
            ADD COLUMN position_group_id UUID REFERENCES position_groups(id) ON DELETE SET NULL;
        RAISE NOTICE 'Added position_group_id column to trailing_stops';
    ELSE
        RAISE NOTICE 'position_group_id column already exists on trailing_stops — skipping';
    END IF;
END $$;
