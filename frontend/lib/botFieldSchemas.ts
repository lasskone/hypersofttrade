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
  { key: 'max_exposure_pct',      label: 'Max Exposure %',              default: 100,  hint: 'Max % of allocation deployed across entry + all DCA levels.' },
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
