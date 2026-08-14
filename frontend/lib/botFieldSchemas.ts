export interface BotField {
  key: string
  label: string
  default: number
  hint: string
}

// ── RSI DCA Grid ──────────────────────────────────────────────────────────────

export const RSI_DCA_FIELDS: BotField[] = [
  { key: 'leverage',              label: 'Leverage',                   default: 1,    hint: '1x = no leverage. Higher values amplify gains and losses.' },
  { key: 'ema_period',            label: 'EMA Period (context)',        default: 200,  hint: 'EMA lookback on 1h context candles. Price must be above (long) or below (short) this line.' },
  { key: 'use_adx_filter',        label: 'ADX Filter (1=on, 0=off)',   default: 0,    hint: '1 = only enter when ADX indicates a strong trend on context candles.' },
  { key: 'adx_period',            label: 'ADX Period',                  default: 14,   hint: 'Lookback for ADX calculation on context candles.' },
  { key: 'adx_threshold',         label: 'ADX Threshold',               default: 25,   hint: 'Minimum ADX value required to enable entries.' },
  { key: 'rsi_period',            label: 'RSI Period',                  default: 14,   hint: 'RSI lookback on entry-timeframe candles.' },
  { key: 'rsi_oversold',          label: 'RSI Oversold',                default: 30,   hint: 'RSI crossing UP through this level triggers a long entry.' },
  { key: 'rsi_overbought',        label: 'RSI Overbought',              default: 70,   hint: 'RSI crossing DOWN through this level triggers a short entry.' },
  { key: 'use_time_window',       label: 'Time Window (1=on, 0=off)',   default: 0,    hint: '1 = only trade during the UTC hour window below.' },
  { key: 'window_start_utc_hour', label: 'Window Start (UTC hour)',    default: 0,    hint: 'Hour to start accepting new entries (0–23).' },
  { key: 'window_end_utc_hour',   label: 'Window End (UTC hour)',      default: 24,   hint: 'Hour to stop accepting new entries (1–24).' },
  { key: 'use_volume_filter',     label: 'Volume Filter (1=on, 0=off)', default: 0,    hint: '1 = require above-average volume on the entry candle.' },
  { key: 'volume_multiplier',     label: 'Volume Multiplier',           default: 1.3,  hint: 'Volume must exceed rolling average × this multiplier.' },
  { key: 'volume_lookback',       label: 'Volume Lookback',             default: 20,   hint: 'Bars used to compute the average volume baseline.' },
  { key: 'sl_pct',                label: 'Stop Loss %',                 default: 3,    hint: 'Stop loss % from the deepest filled DCA level.' },
  { key: 'tp_pct',                label: 'Take Profit %',               default: 1.5,  hint: 'Take profit % from the VWAP of all filled entries.' },
  { key: 'cooldown_candles',      label: 'Cooldown (candles)',          default: 3,    hint: 'Candles to wait after a trade closes before re-entering.' },
]

export const RSI_DCA_META = {
  name: 'RSI DCA Grid',
  emoji: '📉',
  tagline: 'Mean-reversion with grid DCA entries',
  description: 'Waits for RSI oversold/overbought crossovers on the entry timeframe (EMA trend-confirmed on 1h), then scales in with a DCA grid of limit orders before taking profit at the VWAP.',
  howItWorks: [
    'EMA trend filter on 1h context candles sets the macro direction',
    'RSI crossover on the entry timeframe triggers an initial market order',
    'DCA grid of GTC limit orders averages down if price continues against you',
    'SL anchored to deepest filled level; TP from the VWAP of all fills',
  ],
  bestFor: 'Ranging & mild-trend markets',
  risk: 'Medium',
  riskColor: '#f59e0b',
  minAllocation: 100,
  color: '#8b5cf6',
}

export const RSI_DCA_DEFAULTS: Record<string, number> = Object.fromEntries(
  RSI_DCA_FIELDS.map(f => [f.key, f.default])
)

// ── Momentum Scalper ──────────────────────────────────────────────────────────

export const MOMENTUM_SCALPER_FIELDS: BotField[] = [
  { key: 'min_score',                         label: 'Minimum Score',                   default: 75,   hint: 'Composite scanner score (0–100) required to enter a trade. Higher = fewer but higher-confidence setups. 60–70 is aggressive; 80+ is very selective.' },
  { key: 'tp_atr_multiplier',                 label: 'Take Profit ATR Multiplier',      default: 1.0,  hint: 'Take profit distance = ATR × this value. Smaller = quicker profits, higher win rate. Larger = bigger wins but fewer closes.' },
  { key: 'sl_atr_multiplier',                 label: 'Stop Loss ATR Multiplier',        default: 1.67, hint: 'Stop loss distance = ATR × this value. Should typically exceed the TP multiplier so risk/reward stays sound (e.g. 1.67 SL vs 1.0 TP at 1.67R).' },
  { key: 'breakeven_atr_trigger',             label: 'Breakeven Trigger (ATR)',         default: 0.25, hint: 'When price moves this many ATRs in your favour, the stop loss is moved to breakeven to eliminate downside. Set to 0 to disable.' },
  { key: 'cooldown_after_trade_seconds',      label: 'Cooldown After Trade (s)',        default: 10,   hint: 'Seconds to wait after any trade closes before the scanner looks for the next entry. Prevents immediately re-entering a whipsaw.' },
  { key: 'cooldown_after_loss_seconds',       label: 'Cooldown After Loss (s)',         default: 60,   hint: 'Extended cooldown applied specifically after a losing trade. Helps avoid revenge-trading in choppy or trending-against-you conditions.' },
  { key: 'scan_interval_seconds',             label: 'Scan Interval (s)',               default: 5,    hint: 'How often the market scanner runs when idle or in a position. Lower = more responsive to fast-moving markets; higher = lower API load.' },
  { key: 'risk_per_trade',                    label: 'Risk Per Trade (fraction)',       default: 0.02, hint: 'Fraction of current equity to risk per trade (e.g. 0.02 = 2%). Position size is calculated from this, scaled down automatically during drawdowns.' },
  { key: 'max_daily_loss_pct',                label: 'Max Daily Loss (fraction)',       default: 0.10, hint: 'Trading halts for the rest of the UTC day if cumulative losses exceed this fraction of equity (e.g. 0.10 = 10%). Resets automatically at midnight UTC.' },
  { key: 'max_consecutive_losses',            label: 'Max Consecutive Losses',          default: 3,    hint: 'After this many back-to-back losing trades, the bot pauses for the cooldown period below. A single win resets the counter.' },
  { key: 'consecutive_loss_cooldown_minutes', label: 'Consecutive-Loss Cooldown (min)', default: 30,   hint: 'Minutes to pause after hitting the consecutive-loss limit. Gives markets time to settle before the bot resumes scanning.' },
]

export const MOMENTUM_SCALPER_META = {
  name:        'Momentum Scalper',
  emoji:       '⚡',
  tagline:     'Multi-pair momentum with ATR-based exits',
  description: 'Continuously scans multiple markets for high-scoring momentum setups using trend, RSI, volume, ATR volatility, pullback quality, and order-book structure. Enters on the best opportunity, manages exits with ATR-scaled TP/SL and a breakeven move, then cools down before the next scan.',
  howItWorks:  [
    'Scanner scores BTC, ETH, SOL, XRP, HYPE (and more) on 7 market factors every few seconds',
    'Enters long or short on the highest-scoring pair above the minimum score threshold',
    'Sets ATR-scaled take profit and stop loss immediately on entry',
    'Moves SL to breakeven once price advances by the trigger ATR distance',
    'Risk Manager tracks equity, drawdown tiers, and daily loss — sizes down or halts automatically',
  ],
  bestFor:     'Trending & high-momentum markets',
  risk:        'High',
  riskColor:   '#ef4444',
  minAllocation: 200,
  color:       '#f97316',
}

export const MOMENTUM_SCALPER_DEFAULTS: Record<string, number> = Object.fromEntries(
  MOMENTUM_SCALPER_FIELDS.map(f => [f.key, f.default])
)
