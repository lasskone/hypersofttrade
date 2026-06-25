-- Migration 002: Remove any CHECK constraint on the bots.bot_type column.
--
-- WHY: The initial schema had `strategy TEXT CHECK (strategy IN ('grid', 'dca', 'trend'))`.
-- As new bot types were added (envelope_dca, bb_rsi, ema_cross, passivbot_dca, golden_trap)
-- the constraint was never updated, causing INSERT to fail with a constraint violation
-- for any bot_type not in the original allowlist.
--
-- This migration drops the constraint so any bot_type string is accepted.
-- Run this once in your Supabase SQL editor (Dashboard → SQL Editor → Run).

DO $$
DECLARE
    con_name TEXT;
BEGIN
    -- Find any CHECK constraint on the bots table that references bot_type
    SELECT conname INTO con_name
    FROM pg_constraint
    WHERE conrelid = 'bots'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%bot_type%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE bots DROP CONSTRAINT %I', con_name);
        RAISE NOTICE 'Dropped CHECK constraint on bot_type: %', con_name;
    ELSE
        RAISE NOTICE 'No CHECK constraint on bots.bot_type found — nothing to drop.';
    END IF;

    -- Also check for a constraint on the old "strategy" column name (initial schema used that)
    SELECT conname INTO con_name
    FROM pg_constraint
    WHERE conrelid = 'bots'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%strategy%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE bots DROP CONSTRAINT %I', con_name);
        RAISE NOTICE 'Dropped CHECK constraint on strategy column: %', con_name;
    ELSE
        RAISE NOTICE 'No CHECK constraint on bots.strategy found — nothing to drop.';
    END IF;
END $$;

-- Ensure the bot_type column exists and is unconstrained TEXT
-- (safe no-op if column already exists with correct type)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bots' AND column_name = 'bot_type'
    ) THEN
        ALTER TABLE bots ADD COLUMN bot_type TEXT;
        RAISE NOTICE 'Added bot_type column to bots table.';
    ELSE
        RAISE NOTICE 'bot_type column already exists — no change needed.';
    END IF;
END $$;

-- Ensure desired_status column exists (required by the worker reconciliation loop)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bots' AND column_name = 'desired_status'
    ) THEN
        ALTER TABLE bots ADD COLUMN desired_status TEXT DEFAULT 'stopped';
        RAISE NOTICE 'Added desired_status column to bots table.';
    ELSE
        RAISE NOTICE 'desired_status column already exists — no change needed.';
    END IF;
END $$;

-- Ensure api_wallet_address column exists in users table (read by bot_manager)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'api_wallet_address'
    ) THEN
        ALTER TABLE users ADD COLUMN api_wallet_address TEXT;
        RAISE NOTICE 'Added api_wallet_address column to users table.';
    ELSE
        RAISE NOTICE 'api_wallet_address column already exists — no change needed.';
    END IF;
END $$;
