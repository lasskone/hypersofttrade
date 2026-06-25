'use client'
import { useState, useEffect, useRef } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

const BOT_TYPES = {
  grid: {
    name: 'Grid Bot',
    emoji: '⚡',
    tagline: 'Profit from sideways markets automatically',
    description: 'Places a ladder of buy and sell limit orders within a price range. When price oscillates, the bot buys low and sells high repeatedly — capturing spread on every swing. Best suited for ranging, sideways markets.',
    howItWorks: [
      'Divides your allocation into equal levels across a price range',
      'Places buy orders below current price, sell orders above',
      'When a buy fills, immediately places a sell above it',
      'Rebalances automatically if price moves outside the range',
    ],
    bestFor: 'Sideways / ranging markets',
    risk: 'Medium',
    riskColor: '#f59e0b',
    params: {
      levels: { label: 'Grid Levels', hint: 'Number of buy/sell order pairs. More levels = smaller gaps, more trades.' },
      range_pct: { label: 'Price Range %', hint: 'Total price range centered on current price. e.g. 5% on BTC at $60k = $57k–$63k.' },
      stop_loss_pct: { label: 'Stop Loss %', hint: 'Closes all positions if portfolio drops by this %. Protects against strong trends.' },
      take_profit_pct: { label: 'Take Profit %', hint: 'Stops the bot and takes profits if portfolio gains this %. Lock in gains.' },
    },
    minAllocation: 50,
    color: '#00d4aa',
  },
  envelope_dca: {
    name: 'Envelope DCA Bot',
    emoji: '📈',
    tagline: 'Buy the dips systematically with moving average envelopes',
    description: 'Uses moving average envelopes to identify oversold dips and accumulate positions at multiple price levels. Sells when price returns to the base moving average. Ideal for trending assets you want to accumulate.',
    howItWorks: [
      'Calculates a base moving average (SMA/EMA) on your chosen timeframe',
      'Places buy orders at configurable % below the moving average',
      'Supports up to 7 envelope levels for pyramid entries',
      'Exits all positions when price recovers to the base MA',
    ],
    bestFor: 'Trending markets with periodic dips',
    risk: 'Low–Medium',
    riskColor: '#10b981',
    params: {
      ma_period: { label: 'MA Period', hint: 'Moving average window. Longer = smoother, less noise.' },
      envelope_1_pct: { label: 'Envelope 1 %', hint: 'First buy level below MA. e.g. 7% means buy when price is 7% below MA.' },
      envelope_2_pct: { label: 'Envelope 2 %', hint: 'Second buy level. Leave 0 to disable.' },
      envelope_3_pct: { label: 'Envelope 3 %', hint: 'Third buy level. Leave 0 to disable.' },
    },
    minAllocation: 100,
    color: '#8b5cf6',
  },
  funding_rate: {
    name: 'Funding Rate Bot',
    emoji: '💰',
    tagline: 'Earn passive income from funding payments — market neutral',
    description: 'Monitors Hyperliquid funding rates 24/7. Two modes: Single Pair (monitors one asset) or Scanner (scans ALL 300+ pairs automatically and enters the best opportunity). Completely market-neutral — profits regardless of price direction.',
    howItWorks: [
      'Single Pair mode: monitors one asset\'s funding rate every hour',
      'Scanner mode: scans ALL 300+ perp pairs, picks highest funding rate',
      'When funding > threshold, opens SHORT to collect from longs',
      'Exits automatically when funding normalizes or flips',
    ],
    bestFor: 'Passive income, market-neutral strategy',
    risk: 'Low',
    riskColor: '#10b981',
    params: {
      entry_threshold_pct: { label: 'Entry Threshold %/hr', hint: 'Enter when |funding| exceeds this. e.g. 0.01 = 0.01%/hr (~2.4%/day)' },
      exit_threshold_pct: { label: 'Exit Threshold %/hr', hint: 'Exit when |funding| drops below this. e.g. 0.005 = 0.005%/hr' },
      min_hold_hours: { label: 'Min Hold Hours', hint: 'Minimum hours to hold before checking exit. Prevents rapid in/out.' },
    },
    minAllocation: 50,
    color: '#f59e0b',
  },
  bb_rsi: {
    name: 'BB + RSI Bot',
    emoji: '📊',
    tagline: 'Buy oversold dips, sell overbought peaks with precision',
    description: 'Combines Bollinger Bands and RSI to identify high-probability mean reversion setups. Enters long when price touches the lower band AND RSI confirms oversold. Shorts when price touches the upper band AND RSI is overbought.',
    howItWorks: [
      'Calculates Bollinger Bands (20 period, 2 std dev) and RSI (14 period)',
      'LONG: price below lower BB + RSI < 30 (oversold confluence)',
      'SHORT: price above upper BB + RSI > 70 (overbought confluence)',
      'Exits when price returns to the middle BB (20 SMA)',
    ],
    bestFor: 'Ranging markets with clear overbought/oversold cycles',
    risk: 'Medium',
    riskColor: '#f59e0b',
    params: {
      bb_period: { label: 'BB Period', hint: 'Bollinger Band period. Default 20.' },
      bb_std: { label: 'BB Std Dev', hint: 'Standard deviation multiplier. 2.0 = standard, higher = fewer signals.' },
      rsi_period: { label: 'RSI Period', hint: 'RSI calculation period. Default 14.' },
      rsi_oversold: { label: 'RSI Oversold', hint: 'RSI below this triggers long entry. Default 30.' },
      rsi_overbought: { label: 'RSI Overbought', hint: 'RSI above this triggers short entry. Default 70.' },
    },
    minAllocation: 50,
    color: '#3b82f6',
  },
  ema_cross: {
    name: 'EMA Cross Bot',
    emoji: '📈',
    tagline: 'Ride strong trends with golden & death cross signals',
    description: 'Detects EMA crossovers to enter trending markets early. Opens LONG on golden cross (fast EMA above slow) and SHORT on death cross. Uses ATR-based dynamic stops to protect profits. Best for trending markets.',
    howItWorks: [
      'Monitors fast EMA (9) and slow EMA (21) on every candle close',
      'Golden Cross (fast above slow) → opens LONG position',
      'Death Cross (fast below slow) → opens SHORT or closes LONG',
      'Dynamic ATR stop loss adjusts to market volatility',
    ],
    bestFor: 'Trending markets (bull or bear)',
    risk: 'Medium',
    riskColor: '#f59e0b',
    params: {
      ema_fast: { label: 'Fast EMA', hint: 'Fast EMA period. Default 9. Shorter = more signals.' },
      ema_slow: { label: 'Slow EMA', hint: 'Slow EMA period. Default 21. Must be > Fast EMA.' },
      use_atr_stop: { label: 'ATR Stop Loss', hint: 'Use dynamic ATR-based stop instead of fixed %.' },
      atr_multiplier: { label: 'ATR Multiplier', hint: 'Stop = entry ± ATR × multiplier. Default 2.0.' },
    },
    minAllocation: 50,
    color: '#10b981',
  },
  passivbot_dca: {
    name: 'Passivbot DCA',
    emoji: '🔄',
    tagline: 'Martingale DCA grid — contrarian market maker with auto-unstucking',
    description: 'A clean re-implementation of Passivbot\'s core DCA grid strategy. Places GTC limit entry orders in a grid below (long) or above (short) price. Grid spacing widens automatically as wallet exposure grows. Auto-unstucking closes a small % of stuck positions at a loss to free capital for new opportunities.',
    howItWorks: [
      'Places limit buy orders in a grid below current price (long mode)',
      'Each DCA level: size = current_pos_size × double_down_factor',
      'Spacing widens automatically as wallet exposure increases',
      'Take-profit orders placed linearly between markup_start and markup_end',
      'Auto-unstuck: closes small % of stuck position within loss allowance',
    ],
    bestFor: 'Ranging/dipping markets with mean reversion tendency',
    risk: 'High',
    riskColor: '#ef4444',
    params: {},
    minAllocation: 100,
    color: '#ec4899',
  },
}

const BOT_TYPE_DEFAULTS: Record<string, Record<string, any>> = {
  grid: {
    levels: 10,
    range_pct: 5,
    stop_loss_pct: 10,
    take_profit_pct: 30,
    allocated_usdc: 100,
    leverage: 1,
  },
  envelope_dca: {
    ma_period: 5,
    envelope_1_pct: 7,
    envelope_2_pct: 10,
    envelope_3_pct: 15,
    stop_loss_pct: 10,
    allocated_usdc: 100,
    leverage: 1,
    interval: '4h',
    sides: ['long'],
  },
  funding_rate: {
    entry_threshold_pct: 0.01,
    exit_threshold_pct: 0.005,
    min_hold_hours: 4,
    allocated_usdc: 100,
    leverage: 1,
    scan_all_pairs: false,
  },
  bb_rsi: {
    bb_period: 20,
    bb_std: 2.0,
    rsi_period: 14,
    rsi_oversold: 30,
    rsi_overbought: 70,
    stop_loss_pct: 5,
    interval: '4h',
    allocated_usdc: 100,
    leverage: 1,
  },
  ema_cross: {
    ema_fast: 9,
    ema_slow: 21,
    stop_loss_pct: 5,
    use_atr_stop: false,
    atr_multiplier: 2.0,
    interval: '4h',
    allocated_usdc: 100,
    leverage: 1,
  },
  passivbot_dca: {
    direction: 'long',
    wallet_exposure_limit: 0.1,
    entry_initial_qty_pct: 0.01,
    double_down_factor: 0.9,
    entry_grid_spacing_pct: 0.003,
    entry_grid_spacing_we_weight: 0.5,
    close_grid_markup_start: 0.001,
    close_grid_markup_end: 0.003,
    close_grid_qty_pct: 0.05,
    trailing_enabled: false,
    trailing_threshold_pct: 0.02,
    trailing_retracement_pct: 0.005,
    unstuck_enabled: true,
    unstuck_loss_allowance_pct: 0.02,
    unstuck_close_pct: 0.02,
    allocated_usdc: 100,
    leverage: 1,
  },
}

interface Bot {
  id: string
  name: string
  bot_type: string
  symbol: string
  allocated_usdc: number
  status: string
  desired_status?: string
  is_running: boolean
  pnl: number
  total_trades: number
  error_message?: string
  config: any
  created_at: string
}

interface Props {
  walletAddress: string
  onSelectBot?: (botId: string) => void
}

interface Market {
  name: string
  display_name: string
  dex: string
  mark_price: number
  sz_decimals: number
  max_leverage: number
}

const statusColor = (b: Bot) => {
  if (b.status === 'error') return '#ef4444'
  // Stopping: Worker is still running but desired_status was set to stopped
  if (b.status === 'running' && b.desired_status === 'stopped') return '#f59e0b'
  if (b.status === 'running') return '#00d4aa'
  // Starting: desired_status is running but Worker hasn't launched it yet
  if (b.desired_status === 'running') return '#f59e0b'
  return '#6b7280'
}
const statusLabel = (b: Bot) => {
  if (b.status === 'error') return 'Error'
  // Check for transitional states BEFORE the plain running/stopped checks so
  // the badge changes immediately after a Stop/Start click (desired_status
  // is updated instantly; status follows ~5 s later when the Worker catches up).
  if (b.status === 'running' && b.desired_status === 'stopped') return 'Stopping...'
  if (b.status === 'running') return 'Running'
  if (b.desired_status === 'running') return 'Starting...'
  return 'Stopped'
}
// True if the bot is running OR queued to run — used to decide Stop vs Start button.
const wantsRunning = (b: Bot) => b.status === 'running' || b.desired_status === 'running'

export default function BotsPanel({ walletAddress, onSelectBot }: Props) {
  const [bots, setBots] = useState<Bot[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createType, setCreateType] = useState('grid')
  const [toast, setToast] = useState('')
  const [logsBot, setLogsBot] = useState<Bot | null>(null)
  const [logs, setLogs] = useState<any[]>([])
  const logsRequestIdRef = useRef<string | null>(null)
  const [editingBot, setEditingBot] = useState<any>(null)
  const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<{ message: string, onConfirm: () => void } | null>(null)
  const [orderErrorAlert, setOrderErrorAlert] = useState<{ botName: string, message: string } | null>(null)
  const seenErrorIdsRef = useRef<Set<string>>(new Set())

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  // silent=true suppresses the error toast — used for background polls so a
  // transient API hiccup doesn't spam toasts every 5 seconds.
  const fetchBots = async (silent = false) => {
    try {
      const res = await fetch(`${API_URL}/bots/?wallet_address=${walletAddress}`)
      const data = await res.json()
      setBots(data.bots ?? [])
    } catch { if (!silent) showToast('Failed to load bots') }
    finally { setLoading(false) }
  }

  // Initial load (non-silent so the user sees an error if the API is unreachable).
  useEffect(() => { fetchBots() }, [walletAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 5 s — matches the Worker's POLL_INTERVAL so transitional states
  // ("Starting…" / "Stopping…") resolve automatically in at most one cycle,
  // without requiring a manual page refresh.
  useEffect(() => {
    if (!walletAddress) return
    const id = setInterval(() => fetchBots(true), 5000)
    return () => clearInterval(id)
  }, [walletAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!walletAddress || bots.length === 0) return
    const checkForOrderErrors = async () => {
      const runningBots = bots.filter(b => b.status === 'running')
      for (const bot of runningBots) {
        try {
          const res = await fetch(`${API_URL}/bots/${bot.id}/logs?limit=10`)
          const data = await res.json()
          const errorLog = (data.logs ?? []).find((l: any) =>
            l.level === 'error' &&
            typeof l.message === 'string' &&
            l.message.toLowerCase().includes('minimum value')
          )
          if (errorLog) {
            const errorId = `${bot.id}-${errorLog.created_at}`
            if (!seenErrorIdsRef.current.has(errorId)) {
              seenErrorIdsRef.current.add(errorId)
              setOrderErrorAlert({ botName: bot.name, message: errorLog.message })
            }
          }
        } catch {}
      }
    }
    checkForOrderErrors()
    const interval = setInterval(checkForOrderErrors, 20000)
    return () => clearInterval(interval)
  }, [walletAddress, bots])

  const handleAction = async (bot: Bot, action: 'start' | 'stop' | 'delete') => {
    if (action === 'delete') {
      setConfirmAction({
        message: `Delete bot "${bot.name}"? This cannot be undone.`,
        onConfirm: async () => {
          try {
            const res = await fetch(`${API_URL}/bots/${bot.id}`, { method: 'DELETE' })
            if (!res.ok) {
              const text = await res.text().catch(() => '')
              let detail = text
              try { detail = (JSON.parse(text) as any)?.detail ?? text } catch { /* not JSON */ }
              showToast(`Delete failed: HTTP ${res.status} ${detail}`)
              setConfirmAction(null)
              return
            }
            showToast('Bot deleted')
            fetchBots()
          } catch (e: any) { showToast(`Delete failed: ${e.message}`) }
          setConfirmAction(null)
        },
      })
      return
    }

    try {
      let res: Response
      try {
        res = await fetch(`${API_URL}/bots/${bot.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: walletAddress }),
        })
      } catch (networkErr: any) {
        showToast(`Action failed — no response from server: ${networkErr.message}`)
        return
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = text
        try { detail = (JSON.parse(text) as any)?.detail ?? text } catch { /* not JSON */ }
        showToast(`Action failed: HTTP ${res.status} ${detail}`)
        return
      }
      showToast(action === 'start' ? 'Bot queued to start' : 'Bot queued to stop')
      fetchBots()
    } catch (e: any) { showToast(`Action failed: ${e.message}`) }
  }

  const handleDeleteSelected = () => {
    if (selectedBots.size === 0) return
    setConfirmAction({
      message: `Delete ${selectedBots.size} bot${selectedBots.size > 1 ? 's' : ''}? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await Promise.all(
            Array.from(selectedBots).map(botId =>
              fetch(`${API_URL}/bots/${botId}`, { method: 'DELETE' })
            )
          )
          showToast(`${selectedBots.size} bot(s) deleted`)
          setSelectedBots(new Set())
          fetchBots()
        } catch {
          showToast('Failed to delete some bots')
        }
        setConfirmAction(null)
      },
    })
  }

  const fetchLogs = async (bot: Bot) => {
    setLogsBot(bot)
    setLogs([])
    logsRequestIdRef.current = bot.id
    try {
      const res = await fetch(`${API_URL}/bots/${bot.id}/logs?limit=50`)
      const data = await res.json()
      // Ignore stale response if user already switched to a different bot
      if (logsRequestIdRef.current === bot.id) {
        setLogs(data.logs ?? [])
      }
    } catch {
      if (logsRequestIdRef.current === bot.id) setLogs([])
    }
  }

  return (
    <div className="p-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium"
          style={{ backgroundColor: '#1a1a2e', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-black text-white">Bot Library</h2>
        <p className="text-xs text-gray-500 mt-0.5">Automated trading strategies running on your account</p>
      </div>

      {/* Bot Marketplace */}
      <div className="mb-8">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Available Strategies</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.entries(BOT_TYPES).map(([type, info]) => (
            <div key={type} className="rounded-xl border p-5 cursor-pointer transition-all hover:border-opacity-60"
              style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = info.color + '66')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{info.emoji}</span>
                  <div>
                    <p className="font-bold text-white text-sm">{info.name}</p>
                    <p className="text-xs" style={{ color: info.color }}>{info.tagline}</p>
                  </div>
                </div>
                <button
                  onClick={() => { setCreateType(type); setShowCreate(true) }}
                  className="text-xs px-3 py-1.5 rounded-lg font-bold shrink-0"
                  style={{ backgroundColor: info.color + '18', color: info.color, border: `1px solid ${info.color}44` }}>
                  Deploy
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-3 leading-relaxed">{info.description}</p>
              <div className="flex gap-4 text-xs">
                <div>
                  <span className="text-gray-600">Best for: </span>
                  <span className="text-gray-300">{info.bestFor}</span>
                </div>
                <div>
                  <span className="text-gray-600">Risk: </span>
                  <span style={{ color: info.riskColor }}>{info.risk}</span>
                </div>
                <div>
                  <span className="text-gray-600">Min: </span>
                  <span className="text-gray-300">${info.minAllocation}</span>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1a1a2e' }}>
                <p className="text-xs text-gray-600 mb-1.5 font-semibold">HOW IT WORKS</p>
                <ul className="space-y-1">
                  {info.howItWorks.map((step, i) => (
                    <li key={i} className="text-xs text-gray-500 flex gap-2">
                      <span style={{ color: info.color }}>→</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* My Bots */}
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">My Active Bots</p>
      {bots.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, padding: '8px 4px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>
            <input
              type="checkbox"
              checked={selectedBots.size === bots.length && bots.length > 0}
              onChange={e => {
                if (e.target.checked) setSelectedBots(new Set(bots.map(b => b.id)))
                else setSelectedBots(new Set())
              }}
              style={{ accentColor: '#00d4aa', width: 14, height: 14 }}
            />
            Select all
          </label>
          {selectedBots.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 700, cursor: 'pointer',
                background: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
              Delete {selectedBots.size} bot{selectedBots.size > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <p className="text-gray-600 text-sm">No bots deployed yet — click Deploy on a strategy above</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {bots.map(bot => (
            <div key={bot.id} className="rounded-xl border p-5" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
              <div className="flex items-start justify-between">
                <input
                  type="checkbox"
                  checked={selectedBots.has(bot.id)}
                  onChange={e => {
                    const next = new Set(selectedBots)
                    if (e.target.checked) next.add(bot.id)
                    else next.delete(bot.id)
                    setSelectedBots(next)
                  }}
                  style={{ accentColor: '#00d4aa', width: 16, height: 16, cursor: 'pointer', marginRight: 12, flexShrink: 0 }}
                />
                <div
                  className="flex-1 min-w-0"
                  onClick={onSelectBot ? () => onSelectBot(bot.id) : undefined}
                  style={onSelectBot ? { cursor: 'pointer' } : undefined}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-white">{bot.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                      {BOT_TYPES[bot.bot_type as keyof typeof BOT_TYPES]?.name ?? bot.bot_type}
                    </span>
                    <span className="text-xs font-semibold" style={{ color: statusColor(bot) }}>
                      ● {statusLabel(bot)}
                    </span>
                    {onSelectBot && (
                      <span className="text-xs ml-auto" style={{ color: '#4b5563' }}>›</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-1">
                    {[
                      { label: 'Symbol', value: bot.symbol },
                      { label: 'Allocation', value: `$${bot.allocated_usdc}` },
                      bot.bot_type === 'grid' ? { label: 'Levels', value: `${bot.config?.levels ?? '—'}` } : null,
                      bot.bot_type === 'grid' ? { label: 'Range', value: `±${bot.config?.range_pct ?? '—'}%` } : null,
                      bot.bot_type === 'envelope_dca' ? { label: 'Interval', value: bot.config?.interval ?? '4h' } : null,
                      bot.bot_type !== 'funding_rate' ? { label: 'Stop Loss', value: `${bot.config?.stop_loss_pct ?? '—'}%` } : null,
                      bot.bot_type === 'grid' ? { label: 'Take Profit', value: `${bot.config?.take_profit_pct ?? '—'}%` } : null,
                      bot.bot_type === 'funding_rate' ? { label: 'Entry', value: `>${bot.config?.entry_threshold_pct ?? '—'}%/hr` } : null,
                      bot.bot_type === 'funding_rate' ? { label: 'Exit', value: `<${bot.config?.exit_threshold_pct ?? '—'}%/hr` } : null,
                      { label: 'Leverage', value: `${bot.config?.leverage ?? 1}x` },
                    ].filter(Boolean).map((item: any) => (
                      <span key={item.label} className="text-xs">
                        <span className="text-gray-600">{item.label}: </span>
                        <span className="text-gray-300 font-medium">{item.value}</span>
                      </span>
                    ))}
                  </div>
                  {bot.error_message && (
                    <p className="text-xs text-red-400 mt-1">{bot.error_message}</p>
                  )}
                </div>
                <div className="flex gap-2 ml-4 shrink-0">
                  <button onClick={() => fetchLogs(bot)}
                    className="text-xs px-3 py-1.5 rounded font-semibold"
                    style={{ backgroundColor: '#1a1a2e', color: '#6b7280' }}>
                    Logs
                  </button>
                  {wantsRunning(bot) ? (
                    <button onClick={() => handleAction(bot, 'stop')}
                      className="text-xs px-3 py-1.5 rounded font-semibold"
                      style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                      Stop
                    </button>
                  ) : (
                    <button onClick={() => handleAction(bot, 'start')}
                      className="text-xs px-3 py-1.5 rounded font-semibold"
                      style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => !wantsRunning(bot) && setEditingBot(bot)}
                    disabled={wantsRunning(bot)}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                      cursor: wantsRunning(bot) ? 'not-allowed' : 'pointer',
                      background: wantsRunning(bot) ? '#13131f' : '#3b82f618',
                      color: wantsRunning(bot) ? '#374151' : '#3b82f6',
                      border: `1px solid ${wantsRunning(bot) ? '#1a1a2e' : '#3b82f644'}`,
                      opacity: wantsRunning(bot) ? 0.5 : 1,
                    }}
                    title={wantsRunning(bot) ? 'Stop the bot first to edit' : 'Edit bot configuration'}
                  >
                    Edit
                  </button>
                  <button onClick={() => handleAction(bot, 'delete')}
                    className="text-xs px-3 py-1.5 rounded font-semibold"
                    style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Bot Modal */}
      {showCreate && (
        <CreateBotModal
          walletAddress={walletAddress}
          botType={createType}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchBots() }}
        />
      )}

      {/* Edit Bot Modal */}
      {editingBot && (
        <EditBotModal
          bot={editingBot}
          walletAddress={walletAddress}
          onClose={() => setEditingBot(null)}
          onUpdated={() => fetchBots()}
        />
      )}

      {/* Order Error Alert Modal */}
      {orderErrorAlert && (
        <OrderErrorAlertModal
          botName={orderErrorAlert.botName}
          message={orderErrorAlert.message}
          onClose={() => setOrderErrorAlert(null)}
        />
      )}

      {/* Confirm Modal */}
      {confirmAction && (
        <ConfirmModal
          message={confirmAction.message}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Logs Modal */}
      {logsBot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={() => setLogsBot(null)}>
          <div className="w-full max-w-2xl rounded-2xl border p-6 max-h-[80vh] overflow-y-auto"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white">Logs — {logsBot.name}</h3>
              <button onClick={() => setLogsBot(null)} className="text-gray-500 hover:text-white text-xl">×</button>
            </div>
            {logs.length === 0 ? (
              <p className="text-gray-600 text-sm text-center py-8">No logs yet</p>
            ) : (
              <div className="space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="text-xs font-mono flex gap-3">
                    <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleTimeString()}</span>
                    <span style={{ color: log.level === 'error' ? '#ef4444' : log.level === 'warning' ? '#f59e0b' : '#6b7280' }}>
                      [{log.level.toUpperCase()}]
                    </span>
                    <span className="text-gray-300">{log.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CreateBotModal({ walletAddress, botType, onClose, onCreated, initialSymbol, initialDex, initialParams, initialInterval }: { walletAddress: string, botType: string, onClose: () => void, onCreated: () => void, initialSymbol?: string, initialDex?: string, initialParams?: Record<string, number>, initialInterval?: string }) {
  const ip = initialParams ?? {}
  const [name, setName] = useState(`My ${BOT_TYPES[botType as keyof typeof BOT_TYPES]?.name ?? 'Bot'}`)
  const [symbol, setSymbol] = useState(initialSymbol ?? 'BTC')
  const [dex, setDex] = useState(initialDex ?? '')
  const [allocatedUsdc, setAllocatedUsdc] = useState('100')
  const [levels, setLevels] = useState(ip.levels != null ? String(ip.levels) : '10')
  const [rangePct, setRangePct] = useState(ip.range_pct != null ? String(ip.range_pct) : '5')
  const [stopLossPct, setStopLossPct] = useState(ip.stop_loss_pct != null ? String(ip.stop_loss_pct) : '10')
  const [takeProfitPct, setTakeProfitPct] = useState(ip.take_profit_pct != null ? String(ip.take_profit_pct) : '30')
  const [maPeriod, setMaPeriod] = useState(ip.ma_period != null ? String(ip.ma_period) : '5')
  const [envelope1, setEnvelope1] = useState(ip.envelope_1_pct != null ? String(ip.envelope_1_pct) : '7')
  const [envelope2, setEnvelope2] = useState(ip.envelope_2_pct != null ? String(ip.envelope_2_pct) : '10')
  const [envelope3, setEnvelope3] = useState(ip.envelope_3_pct != null ? String(ip.envelope_3_pct) : '15')
  const [envelopeInterval, setEnvelopeInterval] = useState(initialInterval ?? '4h')
  const [leverage, setLeverage] = useState('1')
  const [entryThreshold, setEntryThreshold] = useState('0.01')
  const [exitThreshold, setExitThreshold] = useState('0.005')
  const [minHoldHours, setMinHoldHours] = useState('4')
  const [scanAllPairs, setScanAllPairs] = useState(false)
  const [bbPeriod, setBbPeriod] = useState(ip.bb_period != null ? String(ip.bb_period) : '20')
  const [bbStd, setBbStd] = useState(ip.bb_std != null ? String(ip.bb_std) : '2.0')
  const [rsiPeriod, setRsiPeriod] = useState(ip.rsi_period != null ? String(ip.rsi_period) : '14')
  const [rsiOversold, setRsiOversold] = useState(ip.rsi_oversold != null ? String(ip.rsi_oversold) : '30')
  const [rsiOverbought, setRsiOverbought] = useState(ip.rsi_overbought != null ? String(ip.rsi_overbought) : '70')
  const [btInterval, setBtInterval] = useState(initialInterval ?? '4h')
  const [emaFast, setEmaFast] = useState(ip.ema_fast != null ? String(ip.ema_fast) : '9')
  const [emaSlow, setEmaSlow] = useState(ip.ema_slow != null ? String(ip.ema_slow) : '21')
  const [useAtrStop, setUseAtrStop] = useState(false)
  const [atrMultiplier, setAtrMultiplier] = useState('2.0')
  const [emaInterval, setEmaInterval] = useState(initialInterval ?? '4h')
  const [envelopeSides, setEnvelopeSides] = useState<string[]>(['long'])
  const [pbDirection, setPbDirection] = useState('long')
  const [pbWalletExposureLimit, setPbWalletExposureLimit] = useState('0.1')
  const [pbEntryInitialQtyPct, setPbEntryInitialQtyPct] = useState('0.01')
  const [pbDoubleDownFactor, setPbDoubleDownFactor] = useState('0.9')
  const [pbEntryGridSpacingPct, setPbEntryGridSpacingPct] = useState('0.003')
  const [pbEntryGridSpacingWeWeight, setPbEntryGridSpacingWeWeight] = useState('0.5')
  const [pbCloseGridMarkupStart, setPbCloseGridMarkupStart] = useState('0.001')
  const [pbCloseGridMarkupEnd, setPbCloseGridMarkupEnd] = useState('0.003')
  const [pbCloseGridQtyPct, setPbCloseGridQtyPct] = useState('0.05')
  const [pbTrailingEnabled, setPbTrailingEnabled] = useState(false)
  const [pbTrailingThresholdPct, setPbTrailingThresholdPct] = useState('0.02')
  const [pbTrailingRetracementPct, setPbTrailingRetracementPct] = useState('0.005')
  const [pbUnstuckEnabled, setPbUnstuckEnabled] = useState(true)
  const [pbUnstuckLossAllowancePct, setPbUnstuckLossAllowancePct] = useState('0.02')
  const [pbUnstuckClosePct, setPbUnstuckClosePct] = useState('0.02')
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsLoading, setMarketsLoading] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`${API_URL}/market/all`)
      .then(r => r.json())
      .then((data: Market[]) => {
        setMarkets(data)
        setMarketsLoading(false)
      })
      .catch(() => setMarketsLoading(false))
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowSearch(false)
        setMarketSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/bots/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          name,
          bot_type: botType,
          symbol,
          allocated_usdc: parseFloat(allocatedUsdc),
          config: botType === 'grid' ? {
            dex,
            levels: parseInt(levels),
            range_pct: parseFloat(rangePct),
            stop_loss_pct: parseFloat(stopLossPct),
            take_profit_pct: parseFloat(takeProfitPct),
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
          } : botType === 'envelope_dca' ? {
            dex,
            ma_period: parseInt(maPeriod),
            envelope_1_pct: parseFloat(envelope1),
            envelope_2_pct: parseFloat(envelope2),
            envelope_3_pct: parseFloat(envelope3),
            stop_loss_pct: parseFloat(stopLossPct),
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
            interval: envelopeInterval,
            sides: envelopeSides,
          } : botType === 'funding_rate' ? {
            dex,
            entry_threshold_pct: parseFloat(entryThreshold),
            exit_threshold_pct: parseFloat(exitThreshold),
            min_hold_hours: parseInt(minHoldHours),
            scan_all_pairs: scanAllPairs,
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
          } : botType === 'bb_rsi' ? {
            dex,
            bb_period: parseInt(bbPeriod),
            bb_std: parseFloat(bbStd),
            rsi_period: parseInt(rsiPeriod),
            rsi_oversold: parseFloat(rsiOversold),
            rsi_overbought: parseFloat(rsiOverbought),
            stop_loss_pct: parseFloat(stopLossPct),
            interval: btInterval,
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
          } : botType === 'ema_cross' ? {
            dex,
            ema_fast: parseInt(emaFast),
            ema_slow: parseInt(emaSlow),
            stop_loss_pct: parseFloat(stopLossPct),
            use_atr_stop: useAtrStop,
            atr_multiplier: parseFloat(atrMultiplier),
            interval: emaInterval,
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
          } : {
            dex,
            direction: pbDirection,
            wallet_exposure_limit: parseFloat(pbWalletExposureLimit),
            entry_initial_qty_pct: parseFloat(pbEntryInitialQtyPct),
            double_down_factor: parseFloat(pbDoubleDownFactor),
            entry_grid_spacing_pct: parseFloat(pbEntryGridSpacingPct),
            entry_grid_spacing_we_weight: parseFloat(pbEntryGridSpacingWeWeight),
            close_grid_markup_start: parseFloat(pbCloseGridMarkupStart),
            close_grid_markup_end: parseFloat(pbCloseGridMarkupEnd),
            close_grid_qty_pct: parseFloat(pbCloseGridQtyPct),
            trailing_enabled: pbTrailingEnabled,
            trailing_threshold_pct: parseFloat(pbTrailingThresholdPct),
            trailing_retracement_pct: parseFloat(pbTrailingRetracementPct),
            unstuck_enabled: pbUnstuckEnabled,
            unstuck_loss_allowance_pct: parseFloat(pbUnstuckLossAllowancePct),
            unstuck_close_pct: parseFloat(pbUnstuckClosePct),
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
          }
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Error')
      onCreated()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = { width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }
  const labelStyle = { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block' as const }
  const hintStyle = { fontSize: 11, color: '#4b5563', marginTop: 4 }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border p-6 overflow-y-auto max-h-[90vh]"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between mb-6">
          <h3 className="font-bold text-white text-lg">
            {BOT_TYPES[botType as keyof typeof BOT_TYPES]?.name ?? 'Create Bot'} — Configuration
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        <div className="space-y-4">
          <div>
            <label style={labelStyle}>Bot Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={labelStyle}>MARKET</label>
              {!marketsLoading && <span style={{ fontSize: 10, color: '#4b5563' }}>{markets.length} markets</span>}
            </div>
            <div ref={dropdownRef} style={{ position: 'relative' }}>
              {showSearch ? (
                <input autoFocus type="text" value={marketSearch}
                  onChange={e => setMarketSearch(e.target.value)}
                  placeholder="Search markets…"
                  style={{ ...inputStyle, border: '1px solid #00d4aa' }}
                />
              ) : (
                <div onClick={() => setShowSearch(true)}
                  style={{ ...inputStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: marketsLoading ? '#6b7280' : 'white', fontWeight: 700, fontSize: 14 }}>
                      {marketsLoading ? 'Loading…' : (symbol || 'Select Market')}
                    </span>
                    {symbol && dex && (
                      <span style={{ fontSize: 10, color: '#6b7280', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
                        {dex.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span style={{ color: '#6b7280', fontSize: 10 }}>▼</span>
                </div>
              )}
              {showSearch && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, maxHeight: 280, overflowY: 'auto', zIndex: 2000, marginTop: 4 }}>
                  {[...new Set(markets.map(m => m.dex))].map(dexName => {
                    const dexMarkets = markets.filter(m => m.dex === dexName && (
                      m.name.toLowerCase().includes(marketSearch.toLowerCase()) ||
                      m.display_name?.toLowerCase().includes(marketSearch.toLowerCase())
                    ))
                    if (!dexMarkets.length) return null
                    return (
                      <div key={dexName}>
                        <div style={{ padding: '4px 12px', fontSize: 10, color: '#6b7280', background: '#0a0a0f', textTransform: 'uppercase', letterSpacing: 1 }}>
                          {dexName === 'main' ? 'Hyperliquid' : dexName.toUpperCase() + ' DEX'} ({dexMarkets.length})
                        </div>
                        {dexMarkets.map(m => (
                          <div key={m.name} onClick={() => {
                              setSymbol(m.name)
                              setDex(m.dex === 'main' ? '' : m.dex)
                              setShowSearch(false)
                              setMarketSearch('')
                            }}
                            style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: symbol === m.name ? '#1a1a2e' : 'transparent' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                            onMouseLeave={e => (e.currentTarget.style.background = symbol === m.name ? '#1a1a2e' : 'transparent')}>
                            <span style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                            <span style={{ color: '#6b7280', fontSize: 12 }}>{m.mark_price > 0 ? `$${m.mark_price.toLocaleString()}` : '—'}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                  {!markets.filter(m => m.name.toLowerCase().includes(marketSearch.toLowerCase())).length && (
                    <div style={{ padding: 16, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No markets found</div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Allocation (USDC)</label>
            <input style={inputStyle} type="number" value={allocatedUsdc} onChange={e => setAllocatedUsdc(e.target.value)} />
          </div>
          {botType === 'grid' ? (
            <>
              <div>
                <label style={labelStyle}>Grid Levels</label>
                <input style={inputStyle} type="number" value={levels} onChange={e => setLevels(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Number of buy/sell order pairs</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Price Range %</label>
                  <input style={inputStyle} type="number" value={rangePct} onChange={e => setRangePct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Total range around current price</p>
                </div>
                <div>
                  <label style={labelStyle}>Take Profit %</label>
                  <input style={inputStyle} type="number" value={takeProfitPct} onChange={e => setTakeProfitPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#00d4aa' : '#1a1a2e', backgroundColor: leverage === lev ? '#00d4aa18' : '#0d0d14', color: leverage === lev ? '#00d4aa' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
              </div>
            </>
          ) : botType === 'envelope_dca' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setEnvelopeInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: envelopeInterval === iv ? '#a78bfa22' : '#13131f',
                        color: envelopeInterval === iv ? '#a78bfa' : '#6b7280',
                        outline: envelopeInterval === iv ? '1px solid #a78bfa44' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for MA calculation. Shorter = more frequent checks.</p>
              </div>
              <div>
                <label style={labelStyle}>MA Period</label>
                <input style={inputStyle} type="number" value={maPeriod} onChange={e => setMaPeriod(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Moving average window (recommended: 5–20)</p>
              </div>
              <div>
                <label style={labelStyle}>Envelope 1 % (required)</label>
                <input style={inputStyle} type="number" value={envelope1} onChange={e => setEnvelope1(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First buy level below MA. e.g. 7 = buy at MA -7%</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Envelope 2 % (optional)</label>
                  <input style={inputStyle} type="number" value={envelope2} onChange={e => setEnvelope2(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
                <div>
                  <label style={labelStyle}>Envelope 3 % (optional)</label>
                  <input style={inputStyle} type="number" value={envelope3} onChange={e => setEnvelope3(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#8b5cf6' : '#1a1a2e', backgroundColor: leverage === lev ? '#8b5cf618' : '#0d0d14', color: leverage === lev ? '#8b5cf6' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Sides</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {([
                    { label: 'Long', value: ['long'] as string[] },
                    { label: 'Short', value: ['short'] as string[] },
                    { label: 'Both', value: ['long', 'short'] as string[] },
                  ]).map(opt => {
                    const active = JSON.stringify([...envelopeSides].sort()) === JSON.stringify([...opt.value].sort())
                    return (
                      <button key={opt.label} type="button" onClick={() => setEnvelopeSides(opt.value)}
                        style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                          borderColor: active ? '#8b5cf6' : '#1a1a2e',
                          backgroundColor: active ? '#8b5cf618' : '#0d0d14',
                          color: active ? '#8b5cf6' : '#6b7280',
                        }}>
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys dips. Short: sells rallies. Both: trades both directions.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if portfolio drops by this %. 0 = disabled</p>
              </div>
            </>
          ) : botType === 'funding_rate' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', marginBottom: 4 }}>
                <input type="checkbox" id="scan-pairs" checked={scanAllPairs} onChange={e => setScanAllPairs(e.target.checked)}
                  style={{ accentColor: '#f59e0b', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="scan-pairs" style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, cursor: 'pointer', display: 'block' }}>
                    Scanner Mode — All Pairs
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Automatically scan ALL perp pairs and enter the best funding opportunity</p>
                </div>
              </div>

              {!scanAllPairs && (
                <div style={{ padding: '8px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', marginBottom: 4 }}>
                  <p style={{ fontSize: 10, color: '#6b7280' }}>Single pair mode — bot monitors only the symbol above</p>
                </div>
              )}

              <div>
                <label style={labelStyle}>Entry Threshold %/hr</label>
                <input style={inputStyle} type="number" step="0.001" value={entryThreshold} onChange={e => setEntryThreshold(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Enter when |funding rate| exceeds this. 0.01 = 0.01%/hr ≈ 2.4%/day</p>
              </div>
              <div>
                <label style={labelStyle}>Exit Threshold %/hr</label>
                <input style={inputStyle} type="number" step="0.001" value={exitThreshold} onChange={e => setExitThreshold(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit when |funding rate| drops below this. Should be lower than entry.</p>
              </div>
              <div>
                <label style={labelStyle}>Min Hold Hours</label>
                <input style={inputStyle} type="number" value={minHoldHours} onChange={e => setMinHoldHours(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Minimum hours before checking exit condition. Prevents rapid trades.</p>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#f59e0b' : '#1a1a2e', backgroundColor: leverage === lev ? '#f59e0b18' : '#0d0d14', color: leverage === lev ? '#f59e0b' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if price moves against position by this %. 0 = disabled.</p>
              </div>
            </>
          ) : botType === 'bb_rsi' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setBtInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: btInterval === iv ? '#3b82f622' : '#13131f',
                        color: btInterval === iv ? '#3b82f6' : '#6b7280',
                        outline: btInterval === iv ? '1px solid #3b82f644' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for signal detection</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>BB Period</label>
                  <input style={inputStyle} type="number" value={bbPeriod} onChange={e => setBbPeriod(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 20</p>
                </div>
                <div>
                  <label style={labelStyle}>BB Std Dev</label>
                  <input style={inputStyle} type="number" step="0.1" value={bbStd} onChange={e => setBbStd(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 2.0</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>RSI Period</label>
                  <input style={inputStyle} type="number" value={rsiPeriod} onChange={e => setRsiPeriod(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>RSI Oversold</label>
                  <input style={inputStyle} type="number" value={rsiOversold} onChange={e => setRsiOversold(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>RSI Overbought</label>
                  <input style={inputStyle} type="number" value={rsiOverbought} onChange={e => setRsiOverbought(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#3b82f6' : '#1a1a2e', backgroundColor: leverage === lev ? '#3b82f618' : '#0d0d14', color: leverage === lev ? '#3b82f6' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if position drops by this %. 0 = disabled.</p>
              </div>
            </>
          ) : botType === 'ema_cross' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setEmaInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: emaInterval === iv ? '#10b98122' : '#13131f',
                        color: emaInterval === iv ? '#10b981' : '#6b7280',
                        outline: emaInterval === iv ? '1px solid #10b98144' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for EMA calculation</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Fast EMA Period</label>
                  <input style={inputStyle} type="number" value={emaFast} onChange={e => setEmaFast(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 9</p>
                </div>
                <div>
                  <label style={labelStyle}>Slow EMA Period</label>
                  <input style={inputStyle} type="number" value={emaSlow} onChange={e => setEmaSlow(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 21 (must be &gt; fast)</p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="atr-stop" checked={useAtrStop} onChange={e => setUseAtrStop(e.target.checked)}
                  style={{ accentColor: '#10b981', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="atr-stop" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Use ATR Dynamic Stop Loss
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Adjusts stop based on market volatility instead of fixed %</p>
                </div>
              </div>
              {useAtrStop ? (
                <div>
                  <label style={labelStyle}>ATR Multiplier</label>
                  <input style={inputStyle} type="number" step="0.1" value={atrMultiplier} onChange={e => setAtrMultiplier(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Stop = entry ± ATR × multiplier. Higher = wider stop.</p>
                </div>
              ) : (
                <div>
                  <label style={labelStyle}>Stop Loss %</label>
                  <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Fixed stop loss %. 0 = disabled.</p>
                </div>
              )}
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#10b981' : '#1a1a2e', backgroundColor: leverage === lev ? '#10b98118' : '#0d0d14', color: leverage === lev ? '#10b981' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label style={labelStyle}>Direction</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['long', 'short', 'both'].map(dir => (
                    <button key={dir} type="button" onClick={() => setPbDirection(dir)}
                      style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: pbDirection === dir ? '#ec4899' : '#1a1a2e',
                        backgroundColor: pbDirection === dir ? '#ec489918' : '#0d0d14',
                        color: pbDirection === dir ? '#ec4899' : '#6b7280',
                      }}>
                      {dir.charAt(0).toUpperCase() + dir.slice(1)}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys dips. Short: sells rallies. Both: grid on both sides.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Wallet Exposure Limit</label>
                  <input style={inputStyle} type="number" step="0.01" value={pbWalletExposureLimit} onChange={e => setPbWalletExposureLimit(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Max % of balance to expose per direction. 0.1 = 10%</p>
                </div>
                <div>
                  <label style={labelStyle}>Initial Entry Qty %</label>
                  <input style={inputStyle} type="number" step="0.001" value={pbEntryInitialQtyPct} onChange={e => setPbEntryInitialQtyPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First entry size as fraction of allocation. 0.01 = 1%</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Double Down Factor</label>
                  <input style={inputStyle} type="number" step="0.05" value={pbDoubleDownFactor} onChange={e => setPbDoubleDownFactor(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>DCA size multiplier. 0.9 = each level adds 90% of current pos</p>
                </div>
                <div>
                  <label style={labelStyle}>Grid Spacing %</label>
                  <input style={inputStyle} type="number" step="0.001" value={pbEntryGridSpacingPct} onChange={e => setPbEntryGridSpacingPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Base spacing between entry levels. 0.003 = 0.3%</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Spacing WE Weight</label>
                <input style={inputStyle} type="number" step="0.1" value={pbEntryGridSpacingWeWeight} onChange={e => setPbEntryGridSpacingWeWeight(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>How much wallet exposure widens spacing. 0 = fixed, 1 = fully dynamic</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>TP Markup Start</label>
                  <input style={inputStyle} type="number" step="0.0001" value={pbCloseGridMarkupStart} onChange={e => setPbCloseGridMarkupStart(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First TP level above avg entry. 0.001 = 0.1%</p>
                </div>
                <div>
                  <label style={labelStyle}>TP Markup End</label>
                  <input style={inputStyle} type="number" step="0.0001" value={pbCloseGridMarkupEnd} onChange={e => setPbCloseGridMarkupEnd(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Last TP level. 0.003 = 0.3%</p>
                </div>
                <div>
                  <label style={labelStyle}>TP Qty %</label>
                  <input style={inputStyle} type="number" step="0.01" value={pbCloseGridQtyPct} onChange={e => setPbCloseGridQtyPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>% of position per TP. 0.05 = 5%</p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="pb-trailing" checked={pbTrailingEnabled} onChange={e => setPbTrailingEnabled(e.target.checked)}
                  style={{ accentColor: '#ec4899', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="pb-trailing" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Trailing Entry Mode
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Wait for retracement before placing each DCA entry</p>
                </div>
              </div>
              {pbTrailingEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Trailing Threshold %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbTrailingThresholdPct} onChange={e => setPbTrailingThresholdPct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Price must move this % from entry to arm trailing. 0.02 = 2%</p>
                  </div>
                  <div>
                    <label style={labelStyle}>Trailing Retracement %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbTrailingRetracementPct} onChange={e => setPbTrailingRetracementPct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Retracement from extreme to trigger entry. 0.005 = 0.5%</p>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="pb-unstuck" checked={pbUnstuckEnabled} onChange={e => setPbUnstuckEnabled(e.target.checked)}
                  style={{ accentColor: '#ec4899', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="pb-unstuck" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Auto-Unstuck
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Gradually close stuck positions at a small loss to free capital</p>
                </div>
              </div>
              {pbUnstuckEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Unstuck Loss Allowance</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbUnstuckLossAllowancePct} onChange={e => setPbUnstuckLossAllowancePct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Max loss allowed for unstucking as % of balance. 0.02 = 2%</p>
                  </div>
                  <div>
                    <label style={labelStyle}>Unstuck Close %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbUnstuckClosePct} onChange={e => setPbUnstuckClosePct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>% of stuck position to close per tick. 0.02 = 2%</p>
                  </div>
                </div>
              )}
              <div>
                <label style={labelStyle}>Leverage</label>
                <input style={inputStyle} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage. Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full py-3 rounded-lg font-bold text-sm disabled:opacity-50"
            style={{ backgroundColor: BOT_TYPES[botType as keyof typeof BOT_TYPES]?.color ?? '#00d4aa', color: '#000' }}>
            {loading ? 'Creating...' : 'Create Bot'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditBotModal({ bot, walletAddress, onClose, onUpdated }: { bot: any, walletAddress: string, onClose: () => void, onUpdated: () => void }) {
  const merged = { ...(BOT_TYPE_DEFAULTS[bot.bot_type] ?? {}), ...(bot.config ?? {}) }
  const [name, setName] = useState(bot.name ?? '')
  const [symbol, setSymbol] = useState<string>(String(merged.symbol ?? bot.symbol ?? ''))
  const [dex, setDex] = useState<string>(String(merged.dex ?? ''))
  const [levels, setLevels] = useState(String(merged.levels ?? 10))
  const [rangePct, setRangePct] = useState(String(merged.range_pct ?? 5))
  const [stopLossPct, setStopLossPct] = useState(String(merged.stop_loss_pct ?? 10))
  const [takeProfitPct, setTakeProfitPct] = useState(String(merged.take_profit_pct ?? 30))
  const [leverage, setLeverage] = useState(String(merged.leverage ?? 1))
  const [maPeriod, setMaPeriod] = useState(String(merged.ma_period ?? 5))
  const [envelope1, setEnvelope1] = useState(String(merged.envelope_1_pct ?? 7))
  const [envelope2, setEnvelope2] = useState(String(merged.envelope_2_pct ?? 10))
  const [envelope3, setEnvelope3] = useState(String(merged.envelope_3_pct ?? 15))
  const [envelopeInterval, setEnvelopeInterval] = useState(String(merged.interval ?? '4h'))
  const [entryThreshold, setEntryThreshold] = useState(String(merged.entry_threshold_pct ?? 0.01))
  const [exitThreshold, setExitThreshold] = useState(String(merged.exit_threshold_pct ?? 0.005))
  const [minHoldHours, setMinHoldHours] = useState(String(merged.min_hold_hours ?? 4))
  const [scanAllPairs, setScanAllPairs] = useState(Boolean(merged.scan_all_pairs ?? false))
  const [bbPeriod, setBbPeriod] = useState(String(merged.bb_period ?? 20))
  const [bbStd, setBbStd] = useState(String(merged.bb_std ?? 2.0))
  const [rsiPeriod, setRsiPeriod] = useState(String(merged.rsi_period ?? 14))
  const [rsiOversold, setRsiOversold] = useState(String(merged.rsi_oversold ?? 30))
  const [rsiOverbought, setRsiOverbought] = useState(String(merged.rsi_overbought ?? 70))
  const [btInterval, setBtInterval] = useState(String(merged.interval ?? '4h'))
  const [emaFast, setEmaFast] = useState(String(merged.ema_fast ?? 9))
  const [emaSlow, setEmaSlow] = useState(String(merged.ema_slow ?? 21))
  const [useAtrStop, setUseAtrStop] = useState(Boolean(merged.use_atr_stop ?? false))
  const [atrMultiplier, setAtrMultiplier] = useState(String(merged.atr_multiplier ?? 2.0))
  const [emaInterval, setEmaInterval] = useState(String(merged.interval ?? '4h'))
  const [envelopeSides, setEnvelopeSides] = useState<string[]>(Array.isArray(merged.sides) ? merged.sides : ['long'])
  const [pbDirection, setPbDirection] = useState(String(merged.direction ?? 'long'))
  const [pbWalletExposureLimit, setPbWalletExposureLimit] = useState(String(merged.wallet_exposure_limit ?? 0.1))
  const [pbEntryInitialQtyPct, setPbEntryInitialQtyPct] = useState(String(merged.entry_initial_qty_pct ?? 0.01))
  const [pbDoubleDownFactor, setPbDoubleDownFactor] = useState(String(merged.double_down_factor ?? 0.9))
  const [pbEntryGridSpacingPct, setPbEntryGridSpacingPct] = useState(String(merged.entry_grid_spacing_pct ?? 0.003))
  const [pbEntryGridSpacingWeWeight, setPbEntryGridSpacingWeWeight] = useState(String(merged.entry_grid_spacing_we_weight ?? 0.5))
  const [pbCloseGridMarkupStart, setPbCloseGridMarkupStart] = useState(String(merged.close_grid_markup_start ?? 0.001))
  const [pbCloseGridMarkupEnd, setPbCloseGridMarkupEnd] = useState(String(merged.close_grid_markup_end ?? 0.003))
  const [pbCloseGridQtyPct, setPbCloseGridQtyPct] = useState(String(merged.close_grid_qty_pct ?? 0.05))
  const [pbTrailingEnabled, setPbTrailingEnabled] = useState(Boolean(merged.trailing_enabled ?? false))
  const [pbTrailingThresholdPct, setPbTrailingThresholdPct] = useState(String(merged.trailing_threshold_pct ?? 0.02))
  const [pbTrailingRetracementPct, setPbTrailingRetracementPct] = useState(String(merged.trailing_retracement_pct ?? 0.005))
  const [pbUnstuckEnabled, setPbUnstuckEnabled] = useState(Boolean(merged.unstuck_enabled ?? true))
  const [pbUnstuckLossAllowancePct, setPbUnstuckLossAllowancePct] = useState(String(merged.unstuck_loss_allowance_pct ?? 0.02))
  const [pbUnstuckClosePct, setPbUnstuckClosePct] = useState(String(merged.unstuck_close_pct ?? 0.02))
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsLoading, setMarketsLoading] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`${API_URL}/market/all`)
      .then(r => r.json())
      .then((data: Market[]) => {
        setMarkets(data)
        setMarketsLoading(false)
      })
      .catch(() => setMarketsLoading(false))
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowSearch(false)
        setMarketSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const inputStyle = { width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }
  const labelStyle = { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block' as const }

  const handleUpdate = async () => {
    setSaving(true)
    setError('')
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
      const config = bot.bot_type === 'grid' ? {
        symbol: symbol,
        dex: dex,
        levels: parseInt(levels),
        range_pct: parseFloat(rangePct),
        stop_loss_pct: parseFloat(stopLossPct),
        take_profit_pct: parseFloat(takeProfitPct),
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
      } : bot.bot_type === 'envelope_dca' ? {
        symbol: symbol,
        dex: dex,
        ma_period: parseInt(maPeriod),
        envelope_1_pct: parseFloat(envelope1),
        envelope_2_pct: parseFloat(envelope2),
        envelope_3_pct: parseFloat(envelope3),
        stop_loss_pct: parseFloat(stopLossPct),
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
        interval: envelopeInterval,
        sides: envelopeSides,
      } : bot.bot_type === 'funding_rate' ? {
        symbol: symbol,
        dex: dex,
        entry_threshold_pct: parseFloat(entryThreshold),
        exit_threshold_pct: parseFloat(exitThreshold),
        min_hold_hours: parseInt(minHoldHours),
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
        scan_all_pairs: scanAllPairs,
      } : bot.bot_type === 'bb_rsi' ? {
        symbol: symbol,
        dex: dex,
        bb_period: parseInt(bbPeriod),
        bb_std: parseFloat(bbStd),
        rsi_period: parseInt(rsiPeriod),
        rsi_oversold: parseFloat(rsiOversold),
        rsi_overbought: parseFloat(rsiOverbought),
        stop_loss_pct: parseFloat(stopLossPct),
        interval: btInterval,
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
      } : bot.bot_type === 'ema_cross' ? {
        symbol: symbol,
        dex: dex,
        ema_fast: parseInt(emaFast),
        ema_slow: parseInt(emaSlow),
        stop_loss_pct: parseFloat(stopLossPct),
        use_atr_stop: useAtrStop,
        atr_multiplier: parseFloat(atrMultiplier),
        interval: emaInterval,
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
      } : {
        symbol: symbol,
        dex: dex,
        direction: pbDirection,
        wallet_exposure_limit: parseFloat(pbWalletExposureLimit),
        entry_initial_qty_pct: parseFloat(pbEntryInitialQtyPct),
        double_down_factor: parseFloat(pbDoubleDownFactor),
        entry_grid_spacing_pct: parseFloat(pbEntryGridSpacingPct),
        entry_grid_spacing_we_weight: parseFloat(pbEntryGridSpacingWeWeight),
        close_grid_markup_start: parseFloat(pbCloseGridMarkupStart),
        close_grid_markup_end: parseFloat(pbCloseGridMarkupEnd),
        close_grid_qty_pct: parseFloat(pbCloseGridQtyPct),
        trailing_enabled: pbTrailingEnabled,
        trailing_threshold_pct: parseFloat(pbTrailingThresholdPct),
        trailing_retracement_pct: parseFloat(pbTrailingRetracementPct),
        unstuck_enabled: pbUnstuckEnabled,
        unstuck_loss_allowance_pct: parseFloat(pbUnstuckLossAllowancePct),
        unstuck_close_pct: parseFloat(pbUnstuckClosePct),
        allocated_usdc: parseFloat(merged.allocated_usdc ?? 100),
        leverage: parseInt(leverage),
      }
      const finalConfig = { ...config, bot_type: bot.bot_type }
      const res = await fetch(`${API_URL}/bots/${bot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, config: finalConfig, name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Update failed')
      onUpdated()
      onClose()
    } catch (e: any) {
      setError(e.message ?? 'Failed to update bot')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border p-6 overflow-y-auto max-h-[90vh]"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between mb-6">
          <h3 className="font-bold text-white text-lg">
            {BOT_TYPES[bot.bot_type as keyof typeof BOT_TYPES]?.name ?? bot.bot_type} — Update Configuration
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        <div style={{ padding: '8px 12px', background: '#f59e0b18', border: '1px solid #f59e0b44', borderRadius: 6, marginBottom: 16 }}>
          <p style={{ fontSize: 11, color: '#f59e0b' }}>Bot must remain stopped while editing. Start it again after saving.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label style={labelStyle}>Bot Name</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={labelStyle}>MARKET</label>
              {!marketsLoading && <span style={{ fontSize: 10, color: '#4b5563' }}>{markets.length} markets</span>}
            </div>
            <div ref={dropdownRef} style={{ position: 'relative' }}>
              {showSearch ? (
                <input autoFocus type="text" value={marketSearch}
                  onChange={e => setMarketSearch(e.target.value)}
                  placeholder="Search markets…"
                  style={{ ...inputStyle, border: '1px solid #00d4aa' }}
                />
              ) : (
                <div onClick={() => setShowSearch(true)}
                  style={{ ...inputStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: marketsLoading ? '#6b7280' : 'white', fontWeight: 700, fontSize: 14 }}>
                      {marketsLoading ? 'Loading…' : (symbol || 'Select Market')}
                    </span>
                    {symbol && dex && (
                      <span style={{ fontSize: 10, color: '#6b7280', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
                        {dex.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span style={{ color: '#6b7280', fontSize: 10 }}>▼</span>
                </div>
              )}
              {showSearch && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, maxHeight: 280, overflowY: 'auto', zIndex: 2000, marginTop: 4 }}>
                  {[...new Set(markets.map(m => m.dex))].map(dexName => {
                    const dexMarkets = markets.filter(m => m.dex === dexName && (
                      m.name.toLowerCase().includes(marketSearch.toLowerCase()) ||
                      m.display_name?.toLowerCase().includes(marketSearch.toLowerCase())
                    ))
                    if (!dexMarkets.length) return null
                    return (
                      <div key={dexName}>
                        <div style={{ padding: '4px 12px', fontSize: 10, color: '#6b7280', background: '#0a0a0f', textTransform: 'uppercase', letterSpacing: 1 }}>
                          {dexName === 'main' ? 'Hyperliquid' : dexName.toUpperCase() + ' DEX'} ({dexMarkets.length})
                        </div>
                        {dexMarkets.map(m => (
                          <div key={m.name} onClick={() => {
                              setSymbol(m.name)
                              setDex(m.dex === 'main' ? '' : m.dex)
                              setShowSearch(false)
                              setMarketSearch('')
                            }}
                            style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: symbol === m.name ? '#1a1a2e' : 'transparent' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                            onMouseLeave={e => (e.currentTarget.style.background = symbol === m.name ? '#1a1a2e' : 'transparent')}>
                            <span style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                            <span style={{ color: '#6b7280', fontSize: 12 }}>{m.mark_price > 0 ? `$${m.mark_price.toLocaleString()}` : '—'}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                  {!markets.filter(m => m.name.toLowerCase().includes(marketSearch.toLowerCase())).length && (
                    <div style={{ padding: 16, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No markets found</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {bot.bot_type === 'grid' ? (
            <>
              <div>
                <label style={labelStyle}>Grid Levels</label>
                <input style={inputStyle} type="number" value={levels} onChange={e => setLevels(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Number of buy/sell order pairs</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Price Range %</label>
                  <input style={inputStyle} type="number" value={rangePct} onChange={e => setRangePct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Total range around current price</p>
                </div>
                <div>
                  <label style={labelStyle}>Take Profit %</label>
                  <input style={inputStyle} type="number" value={takeProfitPct} onChange={e => setTakeProfitPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#00d4aa' : '#1a1a2e', backgroundColor: leverage === lev ? '#00d4aa18' : '#0d0d14', color: leverage === lev ? '#00d4aa' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
              </div>
            </>
          ) : bot.bot_type === 'envelope_dca' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setEnvelopeInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: envelopeInterval === iv ? '#a78bfa22' : '#13131f',
                        color: envelopeInterval === iv ? '#a78bfa' : '#6b7280',
                        outline: envelopeInterval === iv ? '1px solid #a78bfa44' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for MA calculation. Shorter = more frequent checks.</p>
              </div>
              <div>
                <label style={labelStyle}>MA Period</label>
                <input style={inputStyle} type="number" value={maPeriod} onChange={e => setMaPeriod(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Moving average window (recommended: 5–20)</p>
              </div>
              <div>
                <label style={labelStyle}>Envelope 1 % (required)</label>
                <input style={inputStyle} type="number" value={envelope1} onChange={e => setEnvelope1(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First buy level below MA. e.g. 7 = buy at MA -7%</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Envelope 2 % (optional)</label>
                  <input style={inputStyle} type="number" value={envelope2} onChange={e => setEnvelope2(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
                <div>
                  <label style={labelStyle}>Envelope 3 % (optional)</label>
                  <input style={inputStyle} type="number" value={envelope3} onChange={e => setEnvelope3(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>0 = disabled</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#8b5cf6' : '#1a1a2e', backgroundColor: leverage === lev ? '#8b5cf618' : '#0d0d14', color: leverage === lev ? '#8b5cf6' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Sides</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {([
                    { label: 'Long', value: ['long'] as string[] },
                    { label: 'Short', value: ['short'] as string[] },
                    { label: 'Both', value: ['long', 'short'] as string[] },
                  ]).map(opt => {
                    const active = JSON.stringify([...envelopeSides].sort()) === JSON.stringify([...opt.value].sort())
                    return (
                      <button key={opt.label} type="button" onClick={() => setEnvelopeSides(opt.value)}
                        style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                          borderColor: active ? '#8b5cf6' : '#1a1a2e',
                          backgroundColor: active ? '#8b5cf618' : '#0d0d14',
                          color: active ? '#8b5cf6' : '#6b7280',
                        }}>
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys dips. Short: sells rallies. Both: trades both directions.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if portfolio drops by this %. 0 = disabled</p>
              </div>
            </>
          ) : bot.bot_type === 'funding_rate' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', marginBottom: 4 }}>
                <input type="checkbox" id="scan-pairs-edit" checked={scanAllPairs} onChange={e => setScanAllPairs(e.target.checked)}
                  style={{ accentColor: '#f59e0b', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="scan-pairs-edit" style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, cursor: 'pointer', display: 'block' }}>
                    Scanner Mode — All Pairs
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Automatically scan ALL perp pairs and enter the best funding opportunity</p>
                </div>
              </div>

              {!scanAllPairs && (
                <div style={{ padding: '8px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', marginBottom: 4 }}>
                  <p style={{ fontSize: 10, color: '#6b7280' }}>Single pair mode — bot monitors only the symbol above</p>
                </div>
              )}

              <div>
                <label style={labelStyle}>Entry Threshold %/hr</label>
                <input style={inputStyle} type="number" step="0.001" value={entryThreshold} onChange={e => setEntryThreshold(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Enter when |funding rate| exceeds this. 0.01 = 0.01%/hr ≈ 2.4%/day</p>
              </div>
              <div>
                <label style={labelStyle}>Exit Threshold %/hr</label>
                <input style={inputStyle} type="number" step="0.001" value={exitThreshold} onChange={e => setExitThreshold(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit when |funding rate| drops below this. Should be lower than entry.</p>
              </div>
              <div>
                <label style={labelStyle}>Min Hold Hours</label>
                <input style={inputStyle} type="number" value={minHoldHours} onChange={e => setMinHoldHours(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Minimum hours before checking exit condition. Prevents rapid trades.</p>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#f59e0b' : '#1a1a2e', backgroundColor: leverage === lev ? '#f59e0b18' : '#0d0d14', color: leverage === lev ? '#f59e0b' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if price moves against position by this %. 0 = disabled.</p>
              </div>
            </>
          ) : bot.bot_type === 'bb_rsi' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setBtInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: btInterval === iv ? '#3b82f622' : '#13131f',
                        color: btInterval === iv ? '#3b82f6' : '#6b7280',
                        outline: btInterval === iv ? '1px solid #3b82f644' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for signal detection</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>BB Period</label>
                  <input style={inputStyle} type="number" value={bbPeriod} onChange={e => setBbPeriod(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 20</p>
                </div>
                <div>
                  <label style={labelStyle}>BB Std Dev</label>
                  <input style={inputStyle} type="number" step="0.1" value={bbStd} onChange={e => setBbStd(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 2.0</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>RSI Period</label>
                  <input style={inputStyle} type="number" value={rsiPeriod} onChange={e => setRsiPeriod(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>RSI Oversold</label>
                  <input style={inputStyle} type="number" value={rsiOversold} onChange={e => setRsiOversold(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>RSI Overbought</label>
                  <input style={inputStyle} type="number" value={rsiOverbought} onChange={e => setRsiOverbought(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#3b82f6' : '#1a1a2e', backgroundColor: leverage === lev ? '#3b82f618' : '#0d0d14', color: leverage === lev ? '#3b82f6' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Exit if position drops by this %. 0 = disabled.</p>
              </div>
            </>
          ) : bot.bot_type === 'ema_cross' ? (
            <>
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setEmaInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: emaInterval === iv ? '#10b98122' : '#13131f',
                        color: emaInterval === iv ? '#10b981' : '#6b7280',
                        outline: emaInterval === iv ? '1px solid #10b98144' : '1px solid #1a1a2e',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Candle interval for EMA calculation</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Fast EMA Period</label>
                  <input style={inputStyle} type="number" value={emaFast} onChange={e => setEmaFast(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 9</p>
                </div>
                <div>
                  <label style={labelStyle}>Slow EMA Period</label>
                  <input style={inputStyle} type="number" value={emaSlow} onChange={e => setEmaSlow(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Default: 21 (must be &gt; fast)</p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="atr-stop-edit" checked={useAtrStop} onChange={e => setUseAtrStop(e.target.checked)}
                  style={{ accentColor: '#10b981', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="atr-stop-edit" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Use ATR Dynamic Stop Loss
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Adjusts stop based on market volatility instead of fixed %</p>
                </div>
              </div>
              {useAtrStop ? (
                <div>
                  <label style={labelStyle}>ATR Multiplier</label>
                  <input style={inputStyle} type="number" step="0.1" value={atrMultiplier} onChange={e => setAtrMultiplier(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Stop = entry ± ATR × multiplier. Higher = wider stop.</p>
                </div>
              ) : (
                <div>
                  <label style={labelStyle}>Stop Loss %</label>
                  <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Fixed stop loss %. 0 = disabled.</p>
                </div>
              )}
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {['1', '2', '3', '5', '10'].map(lev => (
                    <button key={lev} onClick={() => setLeverage(lev)}
                      style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid', borderColor: leverage === lev ? '#10b981' : '#1a1a2e', backgroundColor: leverage === lev ? '#10b98118' : '#0d0d14', color: leverage === lev ? '#10b981' : '#6b7280' }}>
                      {lev}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label style={labelStyle}>Direction</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['long', 'short', 'both'].map(dir => (
                    <button key={dir} type="button" onClick={() => setPbDirection(dir)}
                      style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: pbDirection === dir ? '#ec4899' : '#1a1a2e',
                        backgroundColor: pbDirection === dir ? '#ec489918' : '#0d0d14',
                        color: pbDirection === dir ? '#ec4899' : '#6b7280',
                      }}>
                      {dir.charAt(0).toUpperCase() + dir.slice(1)}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys dips. Short: sells rallies. Both: grid on both sides.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Wallet Exposure Limit</label>
                  <input style={inputStyle} type="number" step="0.01" value={pbWalletExposureLimit} onChange={e => setPbWalletExposureLimit(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Max % of balance to expose per direction. 0.1 = 10%</p>
                </div>
                <div>
                  <label style={labelStyle}>Initial Entry Qty %</label>
                  <input style={inputStyle} type="number" step="0.001" value={pbEntryInitialQtyPct} onChange={e => setPbEntryInitialQtyPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First entry size as fraction of allocation. 0.01 = 1%</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Double Down Factor</label>
                  <input style={inputStyle} type="number" step="0.05" value={pbDoubleDownFactor} onChange={e => setPbDoubleDownFactor(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>DCA size multiplier. 0.9 = each level adds 90% of current pos</p>
                </div>
                <div>
                  <label style={labelStyle}>Grid Spacing %</label>
                  <input style={inputStyle} type="number" step="0.001" value={pbEntryGridSpacingPct} onChange={e => setPbEntryGridSpacingPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Base spacing between entry levels. 0.003 = 0.3%</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Spacing WE Weight</label>
                <input style={inputStyle} type="number" step="0.1" value={pbEntryGridSpacingWeWeight} onChange={e => setPbEntryGridSpacingWeWeight(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>How much wallet exposure widens spacing. 0 = fixed, 1 = fully dynamic</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>TP Markup Start</label>
                  <input style={inputStyle} type="number" step="0.0001" value={pbCloseGridMarkupStart} onChange={e => setPbCloseGridMarkupStart(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First TP above avg entry. 0.001 = 0.1%</p>
                </div>
                <div>
                  <label style={labelStyle}>TP Markup End</label>
                  <input style={inputStyle} type="number" step="0.0001" value={pbCloseGridMarkupEnd} onChange={e => setPbCloseGridMarkupEnd(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Last TP level. 0.003 = 0.3%</p>
                </div>
                <div>
                  <label style={labelStyle}>TP Qty %</label>
                  <input style={inputStyle} type="number" step="0.01" value={pbCloseGridQtyPct} onChange={e => setPbCloseGridQtyPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>% of position per TP. 0.05 = 5%</p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="pb-trailing-edit" checked={pbTrailingEnabled} onChange={e => setPbTrailingEnabled(e.target.checked)}
                  style={{ accentColor: '#ec4899', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="pb-trailing-edit" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Trailing Entry Mode
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Wait for retracement before placing each DCA entry</p>
                </div>
              </div>
              {pbTrailingEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Trailing Threshold %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbTrailingThresholdPct} onChange={e => setPbTrailingThresholdPct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Price must move this % from entry to arm trailing. 0.02 = 2%</p>
                  </div>
                  <div>
                    <label style={labelStyle}>Trailing Retracement %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbTrailingRetracementPct} onChange={e => setPbTrailingRetracementPct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Retracement from extreme to trigger entry. 0.005 = 0.5%</p>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e' }}>
                <input type="checkbox" id="pb-unstuck-edit" checked={pbUnstuckEnabled} onChange={e => setPbUnstuckEnabled(e.target.checked)}
                  style={{ accentColor: '#ec4899', width: 16, height: 16, cursor: 'pointer' }} />
                <div>
                  <label htmlFor="pb-unstuck-edit" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer', color: '#9ca3af' }}>
                    Auto-Unstuck
                  </label>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 1 }}>Gradually close stuck positions at a small loss to free capital</p>
                </div>
              </div>
              {pbUnstuckEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Unstuck Loss Allowance</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbUnstuckLossAllowancePct} onChange={e => setPbUnstuckLossAllowancePct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Max loss for unstucking as % of balance. 0.02 = 2%</p>
                  </div>
                  <div>
                    <label style={labelStyle}>Unstuck Close %</label>
                    <input style={inputStyle} type="number" step="0.001" value={pbUnstuckClosePct} onChange={e => setPbUnstuckClosePct(e.target.value)} />
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>% of stuck position to close per tick. 0.02 = 2%</p>
                  </div>
                </div>
              )}
              <div>
                <label style={labelStyle}>Leverage</label>
                <input style={inputStyle} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage. Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleUpdate}
            disabled={saving}
            className="w-full py-3 rounded-lg font-bold text-sm disabled:opacity-50"
            style={{ backgroundColor: BOT_TYPES[bot.bot_type as keyof typeof BOT_TYPES]?.color ?? '#00d4aa', color: '#000' }}>
            {saving ? 'Updating...' : 'Update Bot'}
          </button>
        </div>
      </div>
    </div>
  )
}

function OrderErrorAlertModal({ botName, message, onClose }: { botName: string, message: string, onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, padding: 24, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f59e0b18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ color: '#f59e0b', fontSize: 18, fontWeight: 700 }}>!</span>
          </div>
          <h3 style={{ color: 'white', fontSize: 15, fontWeight: 700 }}>Order Rejected — {botName}</h3>
        </div>
        <p style={{ color: '#9ca3af', fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
          Hyperliquid rejected an order from this bot:
        </p>
        <div style={{ padding: '10px 12px', background: '#f59e0b0d', border: '1px solid #f59e0b33', borderRadius: 6, marginBottom: 16 }}>
          <p style={{ color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>{message}</p>
        </div>
        <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 20 }}>
          Edit this bot and increase its allocation, or reduce the number of active levels, then restart it.
        </p>
        <button onClick={onClose} style={{ width: '100%', padding: '10px', borderRadius: 8, background: '#00d4aa', color: '#0a0a0f', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
          Got it
        </button>
      </div>
    </div>
  )
}

function ConfirmModal({ message, onConfirm, onCancel }: { message: string, onConfirm: () => void, onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, padding: 24, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: '#ef444418', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ color: '#ef4444', fontSize: 18, fontWeight: 700 }}>!</span>
          </div>
          <h3 style={{ color: 'white', fontSize: 15, fontWeight: 700 }}>Confirm Action</h3>
        </div>
        <p style={{ color: '#9ca3af', fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>{message}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '10px', borderRadius: 8, background: '#13131f', color: '#9ca3af', border: '1px solid #1a1a2e', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 1, padding: '10px', borderRadius: 8, background: '#ef4444', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
