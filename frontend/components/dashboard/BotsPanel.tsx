'use client'
import { useState, useEffect } from 'react'

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
}

interface Bot {
  id: string
  name: string
  bot_type: string
  symbol: string
  allocated_usdc: number
  status: string
  is_running: boolean
  pnl: number
  total_trades: number
  error_message?: string
  config: any
  created_at: string
}

interface Props {
  walletAddress: string
}

const statusColor = (b: Bot) => b.is_running ? '#00d4aa' : b.status === 'error' ? '#ef4444' : '#6b7280'
const statusLabel = (b: Bot) => b.is_running ? 'Running' : b.status === 'error' ? 'Error' : 'Stopped'

export default function BotsPanel({ walletAddress }: Props) {
  const [bots, setBots] = useState<Bot[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createType, setCreateType] = useState('grid')
  const [toast, setToast] = useState('')
  const [logsBot, setLogsBot] = useState<Bot | null>(null)
  const [logs, setLogs] = useState<any[]>([])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  const fetchBots = async () => {
    try {
      const res = await fetch(`${API_URL}/bots/?wallet_address=${walletAddress}`)
      const data = await res.json()
      setBots(data.bots ?? [])
    } catch { showToast('Failed to load bots') }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchBots() }, [walletAddress])

  const handleAction = async (bot: Bot, action: 'start' | 'stop' | 'delete') => {
    try {
      if (action === 'delete') {
        if (!confirm(`Delete bot "${bot.name}"?`)) return
        await fetch(`${API_URL}/bots/${bot.id}`, { method: 'DELETE' })
        showToast('Bot deleted')
      } else {
        await fetch(`${API_URL}/bots/${bot.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: walletAddress })
        })
        showToast(`Bot ${action === 'start' ? 'started' : 'stopped'}`)
      }
      fetchBots()
    } catch { showToast('Action failed') }
  }

  const fetchLogs = async (bot: Bot) => {
    setLogsBot(bot)
    try {
      const res = await fetch(`${API_URL}/bots/${bot.id}/logs?limit=50`)
      const data = await res.json()
      setLogs(data.logs ?? [])
    } catch { setLogs([]) }
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-white">{bot.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                      {BOT_TYPES[bot.bot_type as keyof typeof BOT_TYPES]?.name ?? bot.bot_type}
                    </span>
                    <span className="text-xs font-semibold" style={{ color: statusColor(bot) }}>
                      ● {statusLabel(bot)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3 mt-1">
                    {[
                      { label: 'Symbol', value: bot.symbol },
                      { label: 'Allocation', value: `$${bot.allocated_usdc}` },
                      bot.bot_type === 'grid' ? { label: 'Levels', value: `${bot.config?.levels ?? '—'}` } : null,
                      bot.bot_type === 'grid' ? { label: 'Range', value: `±${bot.config?.range_pct ?? '—'}%` } : null,
                      { label: 'Stop Loss', value: `${bot.config?.stop_loss_pct ?? '—'}%` },
                      { label: 'Take Profit', value: `${bot.config?.take_profit_pct ?? '—'}%` },
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
                  {bot.is_running ? (
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

function CreateBotModal({ walletAddress, botType, onClose, onCreated }: { walletAddress: string, botType: string, onClose: () => void, onCreated: () => void }) {
  const [name, setName] = useState(`My ${BOT_TYPES[botType as keyof typeof BOT_TYPES]?.name ?? 'Bot'}`)
  const [symbol, setSymbol] = useState('BTC')
  const [dex, setDex] = useState('')
  const [allocatedUsdc, setAllocatedUsdc] = useState('100')
  const [levels, setLevels] = useState('10')
  const [rangePct, setRangePct] = useState('5')
  const [stopLossPct, setStopLossPct] = useState('10')
  const [takeProfitPct, setTakeProfitPct] = useState('30')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
          config: {
            dex,
            levels: parseInt(levels),
            range_pct: parseFloat(rangePct),
            stop_loss_pct: parseFloat(stopLossPct),
            take_profit_pct: parseFloat(takeProfitPct),
            allocated_usdc: parseFloat(allocatedUsdc),
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Symbol (e.g. BTC)</label>
              <input style={inputStyle} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} />
            </div>
            <div>
              <label style={labelStyle}>DEX (blank = main)</label>
              <input style={inputStyle} placeholder="xyz, flx..." value={dex} onChange={e => setDex(e.target.value.toLowerCase())} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Allocation (USDC)</label>
            <input style={inputStyle} type="number" value={allocatedUsdc} onChange={e => setAllocatedUsdc(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Grid Levels</label>
              <input style={inputStyle} type="number" value={levels} onChange={e => setLevels(e.target.value)} />
              <p style={hintStyle}>{BOT_TYPES.grid.params.levels.hint}</p>
            </div>
            <div>
              <label style={labelStyle}>Price Range %</label>
              <input style={inputStyle} type="number" value={rangePct} onChange={e => setRangePct(e.target.value)} />
              <p style={hintStyle}>{BOT_TYPES.grid.params.range_pct.hint}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Stop Loss %</label>
              <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
              <p style={hintStyle}>{BOT_TYPES.grid.params.stop_loss_pct.hint}</p>
            </div>
            <div>
              <label style={labelStyle}>Take Profit %</label>
              <input style={inputStyle} type="number" value={takeProfitPct} onChange={e => setTakeProfitPct(e.target.value)} />
              <p style={hintStyle}>{BOT_TYPES.grid.params.take_profit_pct.hint}</p>
            </div>
          </div>

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
