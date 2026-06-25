'use client'
import { useState, useEffect, useRef } from 'react'
import { CreateBotModal } from '@/components/dashboard/BotsPanel'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

interface Market {
  name: string
  display_name: string
  dex: string
  mark_price: number
  sz_decimals: number
  max_leverage: number
}

const INTERVALS = [
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '4h', ms: 14_400_000 },
  { label: '8h', ms: 28_800_000 },
  { label: '12h', ms: 43_200_000 },
  { label: '1d', ms: 86_400_000 },
]

const PERIOD_PRESETS = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
]

const BOT_CONFIGS: Record<string, { label: string; emoji: string; description: string; color: string; fields: { key: string; label: string; default: number; hint: string }[] }> = {
  grid: {
    label: 'Grid Bot',
    emoji: '⚡',
    description: 'Fixed price levels, buys dips / sells rallies',
    color: '#00d4aa',
    fields: [
      { key: 'levels', label: 'Grid Levels', default: 10, hint: 'Number of buy/sell order pairs. More levels = more trades, smaller profit per trade.' },
      { key: 'range_pct', label: 'Price Range %', default: 5, hint: 'Total price range around entry. e.g. 5% on BTC at $60k = $57k–$63k grid.' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 10, hint: 'Exit all positions if portfolio drops by this %. Set 0 to disable.' },
      { key: 'take_profit_pct', label: 'Take Profit %', default: 30, hint: 'Stop bot and lock profits if portfolio gains this %. Set 0 to disable.' },
    ],
  },
  envelope_dca: {
    label: 'Envelope DCA Bot',
    emoji: '📈',
    description: 'SMA envelope with multi-level DCA entries',
    color: '#8b5cf6',
    fields: [
      { key: 'ma_period', label: 'MA Period', default: 20, hint: 'Moving average window. Higher = smoother signal, fewer trades.' },
      { key: 'envelope_1_pct', label: 'Envelope 1 %', default: 7, hint: 'First buy level below MA. e.g. 7 = buy when price is 7% under MA.' },
      { key: 'envelope_2_pct', label: 'Envelope 2 %', default: 10, hint: 'Second buy level. Set 0 to disable this level.' },
      { key: 'envelope_3_pct', label: 'Envelope 3 %', default: 15, hint: 'Third buy level. Set 0 to disable this level.' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 10, hint: 'Exit all positions if portfolio drops by this %. Set 0 to disable.' },
      { key: 'leverage', label: 'Leverage', default: 1, hint: '1 = no leverage. Amplifies both gains and losses.' },
    ],
  },
  bb_rsi: {
    label: 'BB + RSI Bot',
    emoji: '🎯',
    description: 'Mean reversion on Bollinger Band breakouts',
    color: '#3b82f6',
    fields: [
      { key: 'bb_period', label: 'BB Period', default: 20, hint: 'Bollinger Band period' },
      { key: 'bb_std', label: 'BB Std Dev', default: 2.0, hint: '2.0 = standard bands' },
      { key: 'rsi_period', label: 'RSI Period', default: 14, hint: 'RSI calculation period' },
      { key: 'rsi_oversold', label: 'RSI Oversold', default: 30, hint: 'Long entry below this' },
      { key: 'rsi_overbought', label: 'RSI Overbought', default: 70, hint: 'Short entry above this' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 5, hint: '0 = disabled' },
      { key: 'leverage', label: 'Leverage', default: 1, hint: '1 = no leverage' },
    ],
  },
  ema_cross: {
    label: 'EMA Cross Bot',
    emoji: '✂️',
    description: 'Golden/death cross trend following',
    color: '#10b981',
    fields: [
      { key: 'ema_fast', label: 'Fast EMA', default: 9, hint: 'Fast EMA period' },
      { key: 'ema_slow', label: 'Slow EMA', default: 21, hint: 'Slow EMA period (must be > fast)' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 5, hint: '0 = disabled' },
      { key: 'leverage', label: 'Leverage', default: 1, hint: '1 = no leverage' },
    ],
  },
  passivbot_dca: {
    label: 'Passivbot DCA',
    emoji: '🤖',
    description: 'Martingale DCA grid, contrarian market maker',
    color: '#ec4899',
    fields: [
      { key: 'wallet_exposure_limit', label: 'Wallet Exposure Limit', default: 0.1, hint: 'Max fraction of balance to expose. 0.1 = 10%' },
      { key: 'entry_initial_qty_pct', label: 'Initial Entry Qty %', default: 0.01, hint: 'First entry size as fraction of allocation. 0.01 = 1%' },
      { key: 'double_down_factor', label: 'Double Down Factor', default: 0.9, hint: 'DCA size multiplier. 0.9 = each DCA adds 90% of current position' },
      { key: 'entry_grid_spacing_pct', label: 'Grid Spacing %', default: 0.003, hint: 'Base spacing between entries. 0.003 = 0.3%' },
      { key: 'entry_grid_spacing_we_weight', label: 'Spacing Exposure Weight', default: 0.5, hint: 'How much wallet exposure widens spacing. 0 = fixed, 1 = fully dynamic' },
      { key: 'close_grid_markup_start', label: 'Close Markup Start', default: 0.001, hint: 'First TP level above avg entry. 0.001 = 0.1%' },
      { key: 'close_grid_markup_end', label: 'Close Markup End', default: 0.003, hint: 'Last TP level. 0.003 = 0.3%' },
      { key: 'close_grid_qty_pct', label: 'Close Qty per TP %', default: 0.05, hint: 'Fraction of position to close per TP. 0.05 = 5% per level' },
    ],
  },
  golden_trap: {
    label: 'Golden Trap',
    emoji: '🪤',
    description: 'Fibonacci DCA + MA200 trend filter + trailing stop',
    color: '#f97316',
    fields: [
      { key: 'ma_period', label: 'MA Period', default: 5, hint: 'Moving average window for envelope midline. Lower = more reactive.' },
      { key: 'envelope_1_pct', label: 'Envelope 1 %', default: 7, hint: 'First DCA level below MA. Smallest position (Fibonacci weighted).' },
      { key: 'envelope_2_pct', label: 'Envelope 2 %', default: 10, hint: 'Second DCA level. Medium position.' },
      { key: 'envelope_3_pct', label: 'Envelope 3 %', default: 15, hint: 'Third DCA level. Largest position (deepest dip).' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 10, hint: 'Hard stop loss below entry. 0 = disabled.' },
      { key: 'leverage', label: 'Leverage', default: 1, hint: '1 = no leverage. Amplifies both gains and losses.' },
      { key: 'trailing_stop_pct', label: 'Trailing Stop %', default: 2.0, hint: 'Trailing stop distance from peak price (Fixed mode).' },
      { key: 'trailing_stop_atr_mult', label: 'ATR Multiplier', default: 1.5, hint: 'ATR14 multiplier for trailing stop distance (ATR mode).' },
    ],
  },
}

interface BacktestResult {
  pnl_pct: number
  pnl_usd: number
  final_equity: number
  total_trades: number
  win_rate: number
  max_drawdown_pct: number
  bnh_pct: number
  equity_curve: { time: number; value: number }[]
  candles_used: number
  symbol: string
  interval: string
  bot_type: string
}

interface SavedBacktestConfig {
  bot_type: string
  symbol: string
  dex: string
  interval: string
  allocation: number
  start_date: string
  end_date: string
  active_period: string
  params: Record<string, any>
}

interface SavedBacktest {
  id: string
  name: string
  bot_type: string
  symbol: string
  dex: string
  full_config: SavedBacktestConfig
  results: BacktestResult
  created_at: string
}

const fmt = (n: number, dec = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) })

function EquityChart({ data, allocation, color }: { data: { time: number; value: number }[], allocation: number, color: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) setWidth(containerRef.current.offsetWidth)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  if (!data.length) return null
  const W = width, H = 260, pad = { top: 16, right: 16, bottom: 36, left: 72 }
  const iW = W - pad.left - pad.right
  const iH = H - pad.top - pad.bottom
  const values = data.map(d => d.value)
  const minV = Math.min(...values, allocation) * 0.995
  const maxV = Math.max(...values, allocation) * 1.005
  const xS = (i: number) => (i / (data.length - 1)) * iW
  const yS = (v: number) => iH - ((v - minV) / (maxV - minV)) * iH
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xS(i).toFixed(1)} ${yS(d.value).toFixed(1)}`).join(' ')
  const bnhEnd = data[data.length - 1].value
  const bnhEndPrice = (bnhEnd / data[0].value) * allocation
  const bnhPath = `M 0 ${yS(allocation).toFixed(1)} L ${iW} ${yS(bnhEndPrice).toFixed(1)}`
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const i = Math.floor(t * (data.length - 1))
    const d = new Date(data[i].time * 1000)
    return { x: xS(i), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  })
  const yTicks = 5
  const yLabels = Array.from({ length: yTicks }, (_, i) => {
    const v = minV + (maxV - minV) * (i / (yTicks - 1))
    return { y: yS(v), label: `$${v.toFixed(0)}` }
  })
  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg width={W} height={H} style={{ display: 'block', width: '100%' }}>
        <g transform={`translate(${pad.left},${pad.top})`}>
          {yLabels.map((l, i) => (
            <line key={i} x1={0} y1={l.y} x2={iW} y2={l.y} stroke="#1a1a2e" strokeWidth={1} />
          ))}
          <path d={bnhPath} fill="none" stroke="#374151" strokeWidth={1.5} strokeDasharray="5 4" />
          <path d={`${path} L ${iW} ${iH} L 0 ${iH} Z`} fill={color} fillOpacity={0.08} />
          <path d={path} fill="none" stroke={color} strokeWidth={2} />
          {yLabels.map((l, i) => (
            <text key={i} x={-8} y={l.y + 4} textAnchor="end" fontSize={10} fill="#6b7280" fontFamily="monospace">{l.label}</text>
          ))}
          {xLabels.map((l, i) => (
            <text key={i} x={l.x} y={iH + 22} textAnchor="middle" fontSize={10} fill="#6b7280">{l.label}</text>
          ))}
          <g transform={`translate(${iW - 130}, 8)`}>
            <line x1={0} y1={6} x2={20} y2={6} stroke={color} strokeWidth={2} />
            <text x={26} y={10} fontSize={10} fill="#9ca3af">Strategy</text>
            <line x1={0} y1={22} x2={20} y2={22} stroke="#374151" strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={26} y={26} fontSize={10} fill="#9ca3af">Buy & Hold</text>
          </g>
        </g>
      </svg>
    </div>
  )
}

export default function BacktestPanel({ walletAddress }: { walletAddress?: string }) {
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsLoading, setMarketsLoading] = useState(true)
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  const [botType, setBotType] = useState('grid')
  const [pbDirection, setPbDirection] = useState('long')
  const [envelopeSides, setEnvelopeSides] = useState<string[]>(['long'])
  const [gtSides, setGtSides] = useState<string[]>(['long'])
  const [gtTrailingType, setGtTrailingType] = useState('fixed')
  const [interval, setInterval] = useState('4h')
  const [allocation, setAllocation] = useState('1000')
  const [params, setParams] = useState<Record<string, number>>({})

  // Date range
  const [useCustomDates, setUseCustomDates] = useState(false)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().split('T')[0]
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0])
  const [activePeriod, setActivePeriod] = useState('3M')

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')
  const [showDeploy, setShowDeploy] = useState(false)

  // Sub-tabs
  const [activeMainTab, setActiveMainTab] = useState<'run' | 'saved'>('run')

  // Save modal
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Saved backtests list
  const [savedBacktests, setSavedBacktests] = useState<SavedBacktest[]>([])
  const [savedLoading, setSavedLoading] = useState(false)

  // Delete confirmation
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<{ id: string; name: string } | null>(null)

  const config = BOT_CONFIGS[botType]

  // Load markets
  useEffect(() => {
    fetch(`${API_URL}/market/all`)
      .then(r => r.json())
      .then((data: Market[]) => {
        setMarkets(data)
        const btc = data.find(m => m.name === 'BTC')
        if (btc) setSelectedMarket(btc)
        setMarketsLoading(false)
      })
      .catch(() => setMarketsLoading(false))
  }, [])

  // Load saved backtests on mount and when wallet changes
  useEffect(() => {
    if (walletAddress) fetchSavedBacktests()
  }, [walletAddress])

  // Close dropdown on outside click
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

  const getParam = (key: string, def: number) => params[key] ?? def

  const dexGroups = [...new Set(markets.map(m => m.dex))]
  const filteredMarkets = markets.filter(m =>
    m.name.toLowerCase().includes(marketSearch.toLowerCase()) ||
    m.display_name?.toLowerCase().includes(marketSearch.toLowerCase())
  )

  const handleSelectMarket = (market: Market) => {
    setSelectedMarket(market)
    setShowSearch(false)
    setMarketSearch('')
    setResult(null)
  }

  const handlePeriodPreset = (preset: typeof PERIOD_PRESETS[0]) => {
    setActivePeriod(preset.label)
    setUseCustomDates(false)
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - preset.days)
    setStartDate(start.toISOString().split('T')[0])
    setEndDate(end.toISOString().split('T')[0])
  }

  const computeLimit = (iv: string, sd: string, ed: string) => {
    const intervalMs = INTERVALS.find(i => i.label === iv)?.ms ?? 14_400_000
    const start = new Date(sd).getTime()
    const end = new Date(ed).getTime()
    return Math.min(Math.ceil((end - start) / intervalMs), 5000)
  }

  // ── Core backtest runner — takes all params explicitly (safe for auto-run after load) ──
  const runBacktestWithConfig = async (cfg: {
    market: Market
    bot_type: string
    iv: string
    alloc: number
    sd: string
    ed: string
    fieldParams: Record<string, any>
  }) => {
    setLoading(true); setError(''); setResult(null)
    try {
      const date_range_days = Math.max(1, Math.ceil(
        (new Date(cfg.ed).getTime() - new Date(cfg.sd).getTime()) / (1000 * 60 * 60 * 24)
      ))
      const body: Record<string, any> = {
        bot_type: cfg.bot_type,
        symbol: cfg.market.name,
        dex: cfg.market.dex === 'main' ? '' : cfg.market.dex,
        interval: cfg.iv,
        limit: computeLimit(cfg.iv, cfg.sd, cfg.ed),
        date_range_days,
        allocation: cfg.alloc,
        start_date: cfg.sd,
        end_date: cfg.ed,
        ...cfg.fieldParams,
      }
      const res = await fetch(`${API_URL}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Backtest failed')
      setResult(data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  const handleRun = async () => {
    if (!selectedMarket) { setError('Please select a market'); return }
    const fieldParams: Record<string, any> = {}
    config.fields.forEach(f => { fieldParams[f.key] = getParam(f.key, f.default) })
    if (botType === 'passivbot_dca') fieldParams['direction'] = pbDirection
    if (botType === 'envelope_dca') fieldParams['sides'] = envelopeSides
    if (botType === 'golden_trap') { fieldParams['sides'] = gtSides; fieldParams['trailing_stop_type'] = gtTrailingType }
    await runBacktestWithConfig({
      market: selectedMarket,
      bot_type: botType,
      iv: interval,
      alloc: parseFloat(allocation),
      sd: startDate,
      ed: endDate,
      fieldParams,
    })
  }

  // ── Build the full config snapshot to save ──
  const buildFullConfig = (): SavedBacktestConfig => {
    const fieldParams: Record<string, any> = {}
    config.fields.forEach(f => { fieldParams[f.key] = getParam(f.key, f.default) })
    if (botType === 'passivbot_dca') fieldParams['direction'] = pbDirection
    if (botType === 'envelope_dca') fieldParams['sides'] = envelopeSides
    if (botType === 'golden_trap') { fieldParams['sides'] = gtSides; fieldParams['trailing_stop_type'] = gtTrailingType }
    return {
      bot_type: botType,
      symbol: selectedMarket?.name ?? '',
      dex: selectedMarket ? (selectedMarket.dex === 'main' ? '' : selectedMarket.dex) : '',
      interval,
      allocation: parseFloat(allocation),
      start_date: startDate,
      end_date: endDate,
      active_period: activePeriod,
      params: fieldParams,
    }
  }

  // ── Save ──
  const handleSaveClick = () => {
    if (!result || !selectedMarket) return
    const cfgLabel = BOT_CONFIGS[botType]?.label ?? botType
    setSaveName(`${cfgLabel} — ${selectedMarket.name} ${interval}`)
    setSaveError('')
    setShowSaveModal(true)
  }

  const handleSaveConfirm = async () => {
    if (!result || !walletAddress) return
    setSaving(true); setSaveError('')
    try {
      // Separate fetch() network errors from HTTP error responses so the modal
      // always shows the REAL cause instead of the generic "Failed to fetch".
      let res: Response
      try {
        res = await fetch(`${API_URL}/backtest/saved`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet_address: walletAddress,
            name: saveName.trim() || 'Saved Backtest',
            full_config: buildFullConfig(),
            results: result,
          }),
        })
      } catch (networkErr: any) {
        // fetch() itself threw — no response received at all (server down, CORS
        // preflight blocked, no network, etc.)
        throw new Error(`No response from server — ${networkErr.message}. Check that the API is reachable and the backend has been deployed.`)
      }
      if (!res.ok) {
        // Server responded but with an error status — read the body as text first
        // so we handle both JSON and HTML error pages safely.
        const text = await res.text().catch(() => '')
        let detail = text
        try { detail = (JSON.parse(text) as any)?.detail ?? text } catch { /* not JSON */ }
        throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`)
      }
      setShowSaveModal(false)
      await fetchSavedBacktests()
    } catch (e: any) { setSaveError(e.message) }
    finally { setSaving(false) }
  }

  // ── Fetch saved list ──
  const fetchSavedBacktests = async () => {
    if (!walletAddress) return
    setSavedLoading(true)
    try {
      const res = await fetch(`${API_URL}/backtest/saved?wallet_address=${encodeURIComponent(walletAddress)}`)
      if (res.ok) setSavedBacktests(await res.json())
    } catch {}
    finally { setSavedLoading(false) }
  }

  // ── Load saved config back into form and auto-run ──
  const loadSavedBacktest = async (saved: SavedBacktest) => {
    const cfg = saved.full_config
    const dexSearch = cfg.dex || 'main'
    const market = markets.find(m => m.name === cfg.symbol && m.dex === dexSearch)
    if (!market) { setError(`Market "${cfg.symbol}" not found in loaded markets`); return }

    // Restore all form state
    setBotType(cfg.bot_type)
    setSelectedMarket(market)
    setInterval(cfg.interval)
    setAllocation(String(cfg.allocation))
    setStartDate(cfg.start_date)
    setEndDate(cfg.end_date)
    setActivePeriod(cfg.active_period ?? '')
    setUseCustomDates(!cfg.active_period)
    const savedParams = cfg.params ?? {}
    if (cfg.bot_type === 'passivbot_dca' && savedParams['direction']) {
      setPbDirection(String(savedParams['direction']))
    }
    if (cfg.bot_type === 'envelope_dca' && savedParams['sides']) {
      setEnvelopeSides(Array.isArray(savedParams['sides']) ? savedParams['sides'] : ['long'])
    }
    if (cfg.bot_type === 'golden_trap') {
      setGtSides(Array.isArray(savedParams['sides']) ? savedParams['sides'] : ['long'])
      setGtTrailingType(String(savedParams['trailing_stop_type'] ?? 'fixed'))
    }
    setParams(savedParams)

    // Switch to run tab
    setActiveMainTab('run')

    // Auto-run immediately with explicit params (no state timing issue)
    await runBacktestWithConfig({
      market,
      bot_type: cfg.bot_type,
      iv: cfg.interval,
      alloc: cfg.allocation,
      sd: cfg.start_date,
      ed: cfg.end_date,
      fieldParams: cfg.params ?? {},
    })
  }

  // ── Delete ──
  const handleDeleteConfirm = async (id: string) => {
    if (!walletAddress) return
    try {
      await fetch(`${API_URL}/backtest/saved/${id}?wallet_address=${encodeURIComponent(walletAddress)}`, { method: 'DELETE' })
      setConfirmDeleteItem(null)
      await fetchSavedBacktests()
    } catch {}
  }

  const s = {
    input: { width: '100%', background: '#0a0a0f', border: '1px solid #1a1a2e', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const },
    label: { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block' as const, fontWeight: 600, letterSpacing: '0.05em' as const },
  }
  const pnlColor = (v: number) => v >= 0 ? '#10b981' : '#ef4444'

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0f', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, color: 'white', margin: 0 }}>Backtest Console</h2>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Simulate any strategy on historical Hyperliquid data before deploying real capital</p>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {([
          { key: 'run' as const, label: '▶  Run Backtest' },
          { key: 'saved' as const, label: `Saved${savedBacktests.length ? ` (${savedBacktests.length})` : ''}` },
        ] as const).map(tab => (
          <button key={tab.key} onClick={() => { setActiveMainTab(tab.key); if (tab.key === 'saved') fetchSavedBacktests() }}
            style={{ padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none',
              background: activeMainTab === tab.key ? '#00d4aa22' : '#0d0d14',
              color: activeMainTab === tab.key ? '#00d4aa' : '#6b7280',
              outline: activeMainTab === tab.key ? '1px solid #00d4aa44' : '1px solid #1a1a2e',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── RUN tab ── */}
      {activeMainTab === 'run' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Strategy selector — full width card grid */}
          <div>
            <label style={s.label}>STRATEGY</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))', gap: 8 }}>
              {Object.entries(BOT_CONFIGS).map(([k, v]) => (
                <button key={k} onClick={() => { setBotType(k); setResult(null) }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '12px 14px', borderRadius: 8, cursor: 'pointer', border: '1px solid', textAlign: 'left', transition: 'all 0.15s',
                    borderColor: botType === k ? v.color : '#1a1a2e',
                    background: botType === k ? v.color + '14' : '#0d0d14',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>{v.emoji}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: botType === k ? v.color : 'white' }}>{v.label}</span>
                  </div>
                  <p style={{ fontSize: 11, color: botType === k ? v.color + 'cc' : '#6b7280', margin: 0, lineHeight: 1.4 }}>{v.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Config + Results two-column grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

          {/* LEFT — Config */}
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Market selector */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={s.label}>MARKET</label>
                {!marketsLoading && <span style={{ fontSize: 10, color: '#4b5563' }}>{markets.length} markets</span>}
              </div>
              <div ref={dropdownRef} style={{ position: 'relative' }}>
                {showSearch ? (
                  <input autoFocus type="text" value={marketSearch}
                    onChange={e => setMarketSearch(e.target.value)}
                    placeholder="Search markets…"
                    style={{ ...s.input, border: '1px solid #00d4aa', padding: '10px 12px' }}
                  />
                ) : (
                  <div onClick={() => setShowSearch(true)}
                    style={{ ...s.input, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: marketsLoading ? '#6b7280' : 'white', fontWeight: 700, fontSize: 14 }}>
                        {marketsLoading ? 'Loading…' : (selectedMarket?.name ?? 'Select Market')}
                      </span>
                      {selectedMarket && (
                        <span style={{ fontSize: 10, color: '#6b7280', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
                          {selectedMarket.dex === 'main' ? 'HL' : selectedMarket.dex.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span style={{ color: '#6b7280', fontSize: 10 }}>▼</span>
                  </div>
                )}
                {showSearch && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, maxHeight: 280, overflowY: 'auto', zIndex: 300, marginTop: 4 }}>
                    {dexGroups.map(dexName => {
                      const dexMarkets = filteredMarkets.filter(m => m.dex === dexName)
                      if (!dexMarkets.length) return null
                      return (
                        <div key={dexName}>
                          <div style={{ padding: '4px 12px', fontSize: 10, color: '#6b7280', background: '#0a0a0f', textTransform: 'uppercase', letterSpacing: 1, position: 'sticky', top: 0 }}>
                            {dexName === 'main' ? 'Hyperliquid' : dexName.toUpperCase() + ' DEX'} ({dexMarkets.length})
                          </div>
                          {dexMarkets.map(m => (
                            <div key={m.name} onClick={() => handleSelectMarket(m)}
                              style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: selectedMarket?.name === m.name ? '#1a1a2e' : 'transparent' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                              onMouseLeave={e => (e.currentTarget.style.background = selectedMarket?.name === m.name ? '#1a1a2e' : 'transparent')}>
                              <span style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                              <span style={{ color: '#6b7280', fontSize: 12 }}>{m.mark_price > 0 ? `$${fmt(m.mark_price)}` : '—'}</span>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                    {!filteredMarkets.length && <div style={{ padding: 16, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No markets found</div>}
                  </div>
                )}
              </div>
            </div>

            {/* Interval */}
            <div>
              <label style={s.label}>INTERVAL</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {INTERVALS.map(iv => (
                  <button key={iv.label} onClick={() => setInterval(iv.label)}
                    style={{ padding: '5px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                      background: interval === iv.label ? '#00d4aa22' : '#13131f',
                      color: interval === iv.label ? '#00d4aa' : '#6b7280',
                      outline: interval === iv.label ? '1px solid #00d4aa44' : '1px solid #1a1a2e',
                    }}>
                    {iv.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Period */}
            <div>
              <label style={s.label}>PERIOD</label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                {PERIOD_PRESETS.map(p => (
                  <button key={p.label} onClick={() => handlePeriodPreset(p)}
                    style={{ flex: 1, padding: '6px 4px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                      background: activePeriod === p.label && !useCustomDates ? '#00d4aa22' : '#13131f',
                      color: activePeriod === p.label && !useCustomDates ? '#00d4aa' : '#6b7280',
                      outline: activePeriod === p.label && !useCustomDates ? '1px solid #00d4aa44' : '1px solid #1a1a2e',
                    }}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ ...s.label, marginBottom: 2 }}>FROM</p>
                  <input type="date" value={startDate}
                    onChange={e => { setStartDate(e.target.value); setUseCustomDates(true); setActivePeriod('') }}
                    style={{ ...s.input, colorScheme: 'dark' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ ...s.label, marginBottom: 2 }}>TO</p>
                  <input type="date" value={endDate}
                    onChange={e => { setEndDate(e.target.value); setUseCustomDates(true); setActivePeriod('') }}
                    style={{ ...s.input, colorScheme: 'dark' }} />
                </div>
              </div>
            </div>

            {/* Allocation */}
            <div>
              <label style={s.label}>ALLOCATION (USDC)</label>
              <input style={s.input} type="number" value={allocation} onChange={e => setAllocation(e.target.value)} />
            </div>

            {/* Strategy params */}
            <div style={{ borderTop: '1px solid #1a1a2e', paddingTop: 14 }}>
              <label style={{ ...s.label, marginBottom: 10 }}>STRATEGY PARAMETERS</label>
              {botType === 'passivbot_dca' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={s.label}>DIRECTION</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['long', 'short'].map(dir => (
                      <button key={dir} type="button" onClick={() => setPbDirection(dir)}
                        style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                          borderColor: pbDirection === dir ? '#ec4899' : '#1a1a2e',
                          backgroundColor: pbDirection === dir ? '#ec489918' : '#0a0a0f',
                          color: pbDirection === dir ? '#ec4899' : '#6b7280',
                        }}>
                        {dir.charAt(0).toUpperCase() + dir.slice(1)}
                      </button>
                    ))}
                  </div>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys dips below price. Short: sells rallies above price.</p>
                </div>
              )}
              {botType === 'envelope_dca' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={s.label}>SIDES</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {([
                      { label: 'Long only', value: ['long'] },
                      { label: 'Short only', value: ['short'] },
                      { label: 'Both', value: ['long', 'short'] },
                    ] as const).map(opt => {
                      const active = JSON.stringify(envelopeSides.slice().sort()) === JSON.stringify(opt.value.slice().sort())
                      return (
                        <button key={opt.label} type="button" onClick={() => setEnvelopeSides([...opt.value])}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                            borderColor: active ? '#8b5cf6' : '#1a1a2e',
                            backgroundColor: active ? '#8b5cf618' : '#0a0a0f',
                            color: active ? '#8b5cf6' : '#6b7280',
                          }}>
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long: buys envelope dips. Short: sells envelope rallies.</p>
                </div>
              )}
              {botType === 'golden_trap' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <label style={s.label}>SIDES</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([
                        { label: 'Long only', value: ['long'] },
                        { label: 'Short only', value: ['short'] },
                        { label: 'Both', value: ['long', 'short'] },
                      ] as const).map(opt => {
                        const active = JSON.stringify(gtSides.slice().sort()) === JSON.stringify(opt.value.slice().sort())
                        return (
                          <button key={opt.label} type="button" onClick={() => setGtSides([...opt.value])}
                            style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                              borderColor: active ? '#f97316' : '#1a1a2e',
                              backgroundColor: active ? '#f9731618' : '#0a0a0f',
                              color: active ? '#f97316' : '#6b7280',
                            }}>
                            {opt.label}
                          </button>
                        )
                      })}
                    </div>
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>MA200 trend filter: long above MA200, short below, both always active.</p>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={s.label}>TRAILING STOP TYPE</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([
                        { label: 'Fixed %', value: 'fixed' },
                        { label: 'ATR', value: 'atr' },
                        { label: 'None', value: 'none' },
                      ] as const).map(opt => (
                        <button key={opt.value} type="button" onClick={() => setGtTrailingType(opt.value)}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                            borderColor: gtTrailingType === opt.value ? '#f97316' : '#1a1a2e',
                            backgroundColor: gtTrailingType === opt.value ? '#f9731618' : '#0a0a0f',
                            color: gtTrailingType === opt.value ? '#f97316' : '#6b7280',
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Fixed: trails by % from peak. ATR: trails by ATR14 × multiplier. None: hard SL only.</p>
                  </div>
                </>
              )}
              {config.fields.map(f => (
                <div key={f.key} style={{ marginBottom: 12 }}>
                  <label style={s.label}>{f.label.toUpperCase()}</label>
                  <input style={s.input} type="number" value={getParam(f.key, f.default)}
                    onChange={e => setParams(p => ({ ...p, [f.key]: parseFloat(e.target.value) || 0 }))} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>{f.hint}</p>
                </div>
              ))}
            </div>

            {error && <p style={{ fontSize: 12, color: '#ef4444' }}>{error}</p>}

            <button onClick={handleRun} disabled={loading || !selectedMarket}
              style={{ width: '100%', padding: '13px 0', borderRadius: 8, fontWeight: 800, fontSize: 14,
                cursor: loading ? 'wait' : (!selectedMarket ? 'not-allowed' : 'pointer'),
                border: 'none',
                opacity: (loading || !selectedMarket) ? 0.5 : 1,
                transition: 'opacity 0.2s',
                background: (loading || !selectedMarket) ? '#1a1a2e' : config.color,
                color: (loading || !selectedMarket) ? '#6b7280' : (botType === 'grid' ? '#000' : '#fff'),
              }}>
              {loading ? '⏳ Running simulation...' : (!selectedMarket ? 'Select a market first' : '▶  Run Backtest')}
            </button>
          </div>

          {/* RIGHT — Results */}
          <div>
            {!result && !loading && (
              <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
                  <p style={{ color: '#6b7280', fontSize: 14 }}>Configure your strategy and click Run Backtest</p>
                  <p style={{ color: '#374151', fontSize: 12, marginTop: 4 }}>Results and equity curve will appear here</p>
                </div>
              </div>
            )}

            {loading && (
              <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ width: 36, height: 36, border: `2px solid ${config.color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                  <p style={{ color: '#6b7280', fontSize: 13 }}>Fetching data & running simulation...</p>
                  <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                </div>
              </div>
            )}

            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  {[
                    { label: 'Total PnL', value: `${result.pnl_pct >= 0 ? '+' : ''}${result.pnl_pct}%`, sub: `${result.pnl_usd >= 0 ? '+' : ''}$${result.pnl_usd}`, color: pnlColor(result.pnl_pct) },
                    { label: 'vs Buy & Hold', value: `${result.bnh_pct >= 0 ? '+' : ''}${result.bnh_pct}%`, sub: result.pnl_pct >= result.bnh_pct ? '✅ Strategy wins' : '❌ B&H wins', color: pnlColor(result.pnl_pct - result.bnh_pct) },
                    { label: 'Win Rate', value: `${result.win_rate}%`, sub: `${result.total_trades} trades`, color: result.win_rate >= 50 ? '#10b981' : '#ef4444' },
                    { label: 'Max Drawdown', value: `-${result.max_drawdown_pct}%`, sub: 'Peak to trough', color: '#ef4444' },
                    { label: 'Final Equity', value: `$${result.final_equity.toFixed(2)}`, sub: `Started at $${allocation}`, color: 'white' },
                    { label: 'Data', value: `${result.candles_used}`, sub: `${result.interval} candles · ${result.symbol}`, color: '#6b7280' },
                  ].map(({ label, value, sub, color }) => (
                    <div key={label} style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 10, padding: '14px 16px' }}>
                      <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</p>
                      <p style={{ fontSize: 22, fontWeight: 900, color, margin: '0 0 2px' }}>{value}</p>
                      <p style={{ fontSize: 11, color: '#4b5563' }}>{sub}</p>
                    </div>
                  ))}
                </div>

                {/* Chart */}
                <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, padding: 20 }}>
                  <p style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 16 }}>EQUITY CURVE</p>
                  <EquityChart data={result.equity_curve} allocation={parseFloat(allocation)} color={config.color} />
                </div>

                {/* Action row */}
                <div style={{ background: '#0d0d14', border: `1px solid ${config.color}44`, borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <p style={{ fontWeight: 800, color: 'white', fontSize: 14, margin: '0 0 2px' }}>Like these results?</p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Save this configuration or deploy it with real capital</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {walletAddress && (
                      <button onClick={handleSaveClick}
                        style={{ padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        Save Config
                      </button>
                    )}
                    <button onClick={() => setShowDeploy(true)}
                      style={{ padding: '10px 20px', borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', background: config.color, color: botType === 'grid' ? '#000' : '#fff' }}>
                      Deploy Strategy →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      {/* ── SAVED tab ── */}
      {activeMainTab === 'saved' && (
        <div>
          {savedLoading ? (
            <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
              <p style={{ color: '#6b7280', fontSize: 13 }}>Loading saved backtests...</p>
            </div>
          ) : savedBacktests.length === 0 ? (
            <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 260, gap: 8 }}>
              <div style={{ fontSize: 40, marginBottom: 4 }}>📂</div>
              <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>No saved backtests yet</p>
              <p style={{ color: '#374151', fontSize: 12, margin: 0 }}>Run a backtest and click "Save Config" to save it here</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {savedBacktests.map(saved => {
                const botColor = BOT_CONFIGS[saved.bot_type]?.color ?? '#6b7280'
                const botLabel = BOT_CONFIGS[saved.bot_type]?.label ?? saved.bot_type
                const pnl = saved.results?.pnl_pct ?? 0
                const dd = saved.results?.max_drawdown_pct ?? 0
                const cfg = saved.full_config
                const savedDate = new Date(saved.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                return (
                  <div key={saved.id}
                    onClick={() => loadSavedBacktest(saved)}
                    style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 10, padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16, transition: 'border-color 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = botColor + '55')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}>

                    {/* Color stripe */}
                    <div style={{ width: 4, height: 48, borderRadius: 2, background: botColor, flexShrink: 0 }} />

                    {/* Name + badges */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ color: 'white', fontWeight: 700, fontSize: 14 }}>{saved.name}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: botColor + '22', color: botColor }}>
                          {botLabel}
                        </span>
                      </div>
                      <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>
                        {cfg.symbol}{cfg.dex ? ` (${cfg.dex.toUpperCase()})` : ''} · {cfg.interval} · {cfg.start_date} → {cfg.end_date}
                      </p>
                    </div>

                    {/* Metrics */}
                    <div style={{ display: 'flex', gap: 20, flexShrink: 0, alignItems: 'center' }}>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: 10, color: '#6b7280', margin: '0 0 2px' }}>Total PnL</p>
                        <p style={{ fontSize: 16, fontWeight: 900, color: pnlColor(pnl), margin: 0 }}>
                          {pnl >= 0 ? '+' : ''}{pnl}%
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: 10, color: '#6b7280', margin: '0 0 2px' }}>Max DD</p>
                        <p style={{ fontSize: 16, fontWeight: 900, color: '#ef4444', margin: 0 }}>-{dd}%</p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: 10, color: '#6b7280', margin: '0 0 2px' }}>Saved</p>
                        <p style={{ fontSize: 12, color: '#4b5563', margin: 0 }}>{savedDate}</p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        title="Re-run this backtest"
                        onClick={e => { e.stopPropagation(); loadSavedBacktest(saved) }}
                        style={{ padding: '6px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: '#9ca3af' }}>
                        ↺
                      </button>
                      <button
                        title="Delete"
                        onClick={e => { e.stopPropagation(); setConfirmDeleteItem({ id: saved.id, name: saved.name }) }}
                        style={{ padding: '6px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer', border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.07)', color: '#ef4444' }}>
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Deploy modal ── */}
      {showDeploy && walletAddress && (
        <CreateBotModal
          walletAddress={walletAddress}
          botType={botType}
          initialSymbol={selectedMarket?.name}
          initialDex={selectedMarket?.dex === 'main' ? '' : (selectedMarket?.dex ?? '')}
          initialParams={params}
          initialInterval={interval}
          onClose={() => setShowDeploy(false)}
          onCreated={() => setShowDeploy(false)}
        />
      )}

      {/* ── Save name modal ── */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={() => setShowSaveModal(false)}>
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 16, padding: 24, width: 400 }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ color: 'white', fontWeight: 800, fontSize: 16, margin: '0 0 16px' }}>Save Backtest Configuration</h3>
            <label style={s.label}>NAME</label>
            <input
              autoFocus
              style={{ ...s.input, marginBottom: 0 }}
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSaveConfirm()}
              placeholder="e.g. Grid BTC 4h"
            />
            {saveError && <p style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{saveError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => setShowSaveModal(false)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', border: '1px solid #1a1a2e', background: 'transparent', color: '#6b7280' }}>
                Cancel
              </button>
              <button onClick={handleSaveConfirm} disabled={saving || !saveName.trim()}
                style={{ flex: 2, padding: '10px 0', borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: saving ? 'wait' : 'pointer', border: 'none',
                  background: config.color, color: botType === 'grid' ? '#000' : '#fff', opacity: (saving || !saveName.trim()) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm modal ── */}
      {confirmDeleteItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          onClick={() => setConfirmDeleteItem(null)}>
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 16, padding: 24, width: 380 }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ color: 'white', fontWeight: 800, fontSize: 16, margin: '0 0 8px' }}>Delete Saved Backtest</h3>
            <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
              Delete <span style={{ color: 'white', fontWeight: 700 }}>"{confirmDeleteItem.name}"</span>?{' '}
              This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirmDeleteItem(null)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', border: '1px solid #1a1a2e', background: 'transparent', color: '#6b7280' }}>
                Cancel
              </button>
              <button onClick={() => handleDeleteConfirm(confirmDeleteItem.id)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: 'pointer', border: 'none', background: '#ef4444', color: 'white' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
