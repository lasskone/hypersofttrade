'use client'
import { useState, useEffect, useRef } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

const BOT_TYPES = {
  trend_magic: {
    name: 'Trend Magic',
    emoji: '🔮',
    tagline: 'RSI + EMA200 trend filter with Fibonacci DCA and trailing stop',
    description: 'Enters trends confirmed by both RSI momentum and EMA(200) direction. Goes long when RSI is above the overbought threshold AND price is above EMA200; shorts when RSI is below oversold AND price is below EMA200. Uses Fibonacci-weighted DCA entries (15/35/50%) and a trailing stop to lock in profits.',
    howItWorks: [
      'Long signal: RSI > overbought threshold AND close above EMA(200)',
      'Short signal: RSI < oversold threshold AND close below EMA(200)',
      'Fibonacci DCA: initial 15%, DCA1 35%, DCA2 50% of allocation',
      'Trailing stop follows price peak — locks in profits as trend extends',
    ],
    bestFor: 'Strong trending markets (bull or bear)',
    risk: 'Medium',
    riskColor: '#f59e0b',
    params: {
      rsi_period: { label: 'RSI Period', hint: 'RSI calculation period. Default 14.' },
      rsi_overbought: { label: 'RSI Overbought', hint: 'RSI above this confirms uptrend strength. Default 70.' },
      rsi_oversold: { label: 'RSI Oversold', hint: 'RSI below this confirms downtrend strength. Default 30.' },
      ema_period: { label: 'EMA Period', hint: 'EMA trend filter period. Default 200.' },
      dca_level_1_pct: { label: 'DCA Level 1 %', hint: 'First DCA buy % below/above entry. Default 7%.' },
      dca_level_2_pct: { label: 'DCA Level 2 %', hint: 'Second DCA buy % below/above entry. Default 14%.' },
      tp_pct: { label: 'Take Profit %', hint: 'Take profit % from average entry. Default 5%.' },
      trailing_stop_pct: { label: 'Trailing Stop %', hint: 'Trailing stop % below/above peak price. Default 1%.' },
    },
    minAllocation: 100,
    color: '#8b5cf6',
  },
}

const BOT_TYPE_DEFAULTS: Record<string, Record<string, any>> = {
  trend_magic: {
    rsi_period: 14,
    rsi_overbought: 70,
    rsi_oversold: 30,
    ema_period: 200,
    dca_level_1_pct: 7.0,
    dca_level_2_pct: 14.0,
    tp_pct: 5.0,
    trailing_stop_pct: 1.0,
    stop_loss_pct: 10.0,
    allocated_usdc: 100,
    leverage: 1,
    interval: '1h',
    sides: ['long', 'short'],
  },
  golden_copy: {
    target_wallet: '',
    scale_mode: 'proportional',
    min_position_pct: 0.01,
    poll_interval_seconds: 60,
    copy_longs: true,
    copy_shorts: true,
    blocked_coins: [] as string[],
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
  const [createType, setCreateType] = useState('trend_magic')
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
                      { label: 'Stop Loss', value: `${bot.config?.stop_loss_pct ?? '—'}%` },
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

// ── Searchable multi-select for markets (used by TM scanner and GC blocked coins) ──
function MarketMultiSelect({
  markets, marketsLoading, selected, onSelect, onRemove, accentColor,
  placeholder = 'Search and select pairs…',
}: {
  markets: Market[]
  marketsLoading: boolean
  selected: string[]
  onSelect: (sym: string) => void
  onRemove: (sym: string) => void
  accentColor: string
  placeholder?: string
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const displayName = (m: Market) =>
    m.dex && m.dex !== 'main' ? `${m.name} [${m.dex}]` : m.name

  const filtered = markets.filter(m => {
    if (!search) return true
    const q = search.toLowerCase()
    return m.name.toLowerCase().includes(q) ||
      (m.display_name ?? '').toLowerCase().includes(q) ||
      m.dex.toLowerCase().includes(q)
  })

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 6 }}>
          {selected.map(sym => (
            <span key={sym} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: accentColor + '18', border: `1px solid ${accentColor}44`, borderRadius: 4, padding: '3px 8px', fontSize: 12, color: accentColor }}>
              {sym}
              <span style={{ cursor: 'pointer', lineHeight: 1 }} onClick={() => onRemove(sym)}>×</span>
            </span>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div style={{ fontSize: 11, color: accentColor, marginBottom: 4, opacity: 0.75 }}>
          {selected.length} pair{selected.length !== 1 ? 's' : ''} selected
        </div>
      )}
      <input
        value={search}
        onChange={e => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={marketsLoading ? 'Loading markets…' : placeholder}
        disabled={marketsLoading}
        style={{ width: '100%', background: '#0d0d14', border: `1px solid ${open ? accentColor + '88' : '#1a1a2e'}`, borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }}
      />
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, maxHeight: 220, overflowY: 'auto' as const, zIndex: 3000, marginTop: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center' as const, color: '#6b7280', fontSize: 13 }}>No markets found</div>
          ) : filtered.slice(0, 80).map(m => {
            const isSel = selected.includes(m.name)
            return (
              <div key={m.name}
                onClick={() => { if (!isSel) { onSelect(m.name); setSearch(''); setOpen(false) } }}
                style={{ padding: '8px 12px', cursor: isSel ? 'default' : 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'transparent', opacity: isSel ? 0.35 : 1 }}
                onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = '#1a1a2e' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <span style={{ color: 'white', fontSize: 13 }}>{displayName(m)}</span>
                <span style={{ color: '#4b5563', fontSize: 12 }}>
                  {isSel ? '✓' : m.mark_price > 0 ? `$${m.mark_price.toLocaleString()}` : ''}
                </span>
              </div>
            )
          })}
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
  const [leverage, setLeverage] = useState('1')
  const [tmSides, setTmSides] = useState<string[]>(['long', 'short'])
  const [tmRsiPeriod, setTmRsiPeriod] = useState('14')
  const [tmRsiOverbought, setTmRsiOverbought] = useState('70')
  const [tmRsiOversold, setTmRsiOversold] = useState('30')
  const [tmEmaPeriod, setTmEmaPeriod] = useState('200')
  const [tmDca1Pct, setTmDca1Pct] = useState('7.0')
  const [tmDca2Pct, setTmDca2Pct] = useState('14.0')
  const [tmEntryAmount, setTmEntryAmount] = useState('')
  const [tmDca1Amount, setTmDca1Amount] = useState('')
  const [tmDca2Amount, setTmDca2Amount] = useState('')
  const [tmTpPct, setTmTpPct] = useState('5.0')
  const [tmTrailingPct, setTmTrailingPct] = useState('1.0')
  const [tmStopLossPct, setTmStopLossPct] = useState('10')
  const [tmInterval, setTmInterval] = useState('1h')
  const [tmScanMode, setTmScanMode] = useState<'single' | 'multi'>('single')
  const [tmScanSymbols, setTmScanSymbols] = useState<string[]>([])
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
          symbol: (botType === 'trend_magic' && tmScanMode === 'multi') ? (tmScanSymbols[0] || symbol) : symbol,
          allocated_usdc: parseFloat(allocatedUsdc),
          config: {
            dex,
            rsi_period: parseInt(tmRsiPeriod),
            rsi_overbought: parseFloat(tmRsiOverbought),
            rsi_oversold: parseFloat(tmRsiOversold),
            ema_period: parseInt(tmEmaPeriod),
            dca_level_1_pct: parseFloat(tmDca1Pct),
            dca_level_2_pct: parseFloat(tmDca2Pct),
            ...(tmEntryAmount !== '' && { entry_amount_usdc: parseFloat(tmEntryAmount) }),
            ...(tmDca1Amount !== '' && { dca1_amount_usdc: parseFloat(tmDca1Amount) }),
            ...(tmDca2Amount !== '' && { dca2_amount_usdc: parseFloat(tmDca2Amount) }),
            tp_pct: parseFloat(tmTpPct),
            trailing_stop_pct: parseFloat(tmTrailingPct),
            stop_loss_pct: parseFloat(tmStopLossPct),
            allocated_usdc: parseFloat(allocatedUsdc),
            leverage: parseInt(leverage),
            interval: tmInterval,
            sides: tmSides,
            scan_pairs: tmScanMode === 'multi',
            scan_symbols: tmScanMode === 'multi' ? tmScanSymbols : [],
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
          {!(botType === 'trend_magic' && tmScanMode === 'multi') && (
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
          )}
          <div>
            <label style={labelStyle}>Allocation (USDC)</label>
            <input style={inputStyle} type="number" value={allocatedUsdc} onChange={e => setAllocatedUsdc(e.target.value)} />
          </div>
          <>
              <div>
                <label style={labelStyle}>Mode</label>
                <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #1a1a2e', width: 'fit-content' }}>
                  {(['single', 'multi'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setTmScanMode(mode)}
                      style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: tmScanMode === mode ? '#8b5cf6' : '#13131f',
                        color: tmScanMode === mode ? 'white' : '#6b7280',
                      }}>
                      {mode === 'single' ? 'Single Pair' : 'Multi-Pair Scanner'}
                    </button>
                  ))}
                </div>
              </div>
              {tmScanMode === 'multi' && (
                <div>
                  <label style={labelStyle}>Pairs to scan</label>
                  <MarketMultiSelect
                    markets={markets}
                    marketsLoading={marketsLoading}
                    selected={tmScanSymbols}
                    onSelect={sym => setTmScanSymbols(prev => [...prev, sym])}
                    onRemove={sym => setTmScanSymbols(prev => prev.filter(s => s !== sym))}
                    accentColor="#8b5cf6"
                    placeholder="Search and select pairs…"
                  />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>Select pairs to scan. Allocation is split across all active pairs.</p>
                </div>
              )}
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setTmInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: tmInterval === iv ? '#8b5cf622' : '#13131f',
                        color: tmInterval === iv ? '#8b5cf6' : '#6b7280',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={labelStyle}>Sides</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['long', 'short'].map(s => (
                    <button key={s} type="button" onClick={() => setTmSides(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                      style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: tmSides.includes(s) ? '#8b5cf6' : '#1a1a2e',
                        backgroundColor: tmSides.includes(s) ? '#8b5cf618' : '#0d0d14',
                        color: tmSides.includes(s) ? '#8b5cf6' : '#6b7280',
                      }}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>RSI Period</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiPeriod} onChange={e => setTmRsiPeriod(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>EMA Period</label>
                  <input style={inputStyle} type="number" step="1" value={tmEmaPeriod} onChange={e => setTmEmaPeriod(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>RSI Overbought</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiOverbought} onChange={e => setTmRsiOverbought(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long signal when RSI &gt; this (uptrend momentum)</p>
                </div>
                <div>
                  <label style={labelStyle}>RSI Oversold</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiOversold} onChange={e => setTmRsiOversold(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Short signal when RSI &lt; this (downtrend momentum)</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>DCA Level 1 %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmDca1Pct} onChange={e => setTmDca1Pct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First DCA below/above entry. Default 7%</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA Level 2 %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmDca2Pct} onChange={e => setTmDca2Pct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Second DCA below/above entry. Default 14%</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>Entry Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmEntryAmount} onChange={e => setTmEntryAmount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override entry size. Leave blank for auto (15% of alloc).</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA1 Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmDca1Amount} onChange={e => setTmDca1Amount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override DCA1 size. Leave blank for auto (35% of alloc).</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA2 Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmDca2Amount} onChange={e => setTmDca2Amount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override DCA2 size. Leave blank for auto (50% of alloc).</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Take Profit %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmTpPct} onChange={e => setTmTpPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>TP % above/below avg entry</p>
                </div>
                <div>
                  <label style={labelStyle}>Trailing Stop %</label>
                  <input style={inputStyle} type="number" step="0.1" value={tmTrailingPct} onChange={e => setTmTrailingPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>SL trails % below/above peak</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" step="0.5" value={tmStopLossPct} onChange={e => setTmStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Wide protective stop-loss before trailing activates. Independent from Trailing Stop %.</p>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
                  {[1, 2, 3, 5, 10].map(lv => (
                    <button key={lv} type="button" onClick={() => setLeverage(String(lv))}
                      style={{ padding: '6px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: leverage === String(lv) ? '#8b5cf622' : '#13131f',
                        color: leverage === String(lv) ? '#8b5cf6' : '#6b7280',
                      }}>
                      {lv}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
            </>

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
  // Read bot config fresh each open — bot.config takes priority; fall back to type defaults
  const def = BOT_TYPE_DEFAULTS[bot.bot_type] ?? {}
  const cfg: any = bot.config ?? {}
  const [name, setName] = useState(bot.name ?? '')
  const [symbol, setSymbol] = useState<string>(String(cfg.symbol ?? bot.symbol ?? ''))
  const [dex, setDex] = useState<string>(String(cfg.dex ?? ''))
  const [leverage, setLeverage] = useState(String(cfg.leverage ?? def.leverage ?? 1))
  const [tmSides, setTmSides] = useState<string[]>(Array.isArray(cfg.sides) ? cfg.sides : (Array.isArray(def.sides) ? def.sides : ['long', 'short']))
  const [tmRsiPeriod, setTmRsiPeriod] = useState(String(cfg.rsi_period ?? def.rsi_period ?? 14))
  const [tmRsiOverbought, setTmRsiOverbought] = useState(String(cfg.rsi_overbought ?? def.rsi_overbought ?? 70))
  const [tmRsiOversold, setTmRsiOversold] = useState(String(cfg.rsi_oversold ?? def.rsi_oversold ?? 30))
  const [tmEmaPeriod, setTmEmaPeriod] = useState(String(cfg.ema_period ?? def.ema_period ?? 200))
  const [tmDca1Pct, setTmDca1Pct] = useState(String(cfg.dca_level_1_pct ?? def.dca_level_1_pct ?? 7.0))
  const [tmDca2Pct, setTmDca2Pct] = useState(String(cfg.dca_level_2_pct ?? def.dca_level_2_pct ?? 14.0))
  const [tmEntryAmount, setTmEntryAmount] = useState(cfg.entry_amount_usdc != null ? String(cfg.entry_amount_usdc) : '')
  const [tmDca1Amount, setTmDca1Amount] = useState(cfg.dca1_amount_usdc != null ? String(cfg.dca1_amount_usdc) : '')
  const [tmDca2Amount, setTmDca2Amount] = useState(cfg.dca2_amount_usdc != null ? String(cfg.dca2_amount_usdc) : '')
  const [tmTpPct, setTmTpPct] = useState(String(cfg.tp_pct ?? def.tp_pct ?? 5.0))
  const [tmTrailingPct, setTmTrailingPct] = useState(String(cfg.trailing_stop_pct ?? def.trailing_stop_pct ?? 1.0))
  const [tmStopLossPct, setTmStopLossPct] = useState(String(cfg.stop_loss_pct ?? def.stop_loss_pct ?? 10.0))
  const [tmInterval, setTmInterval] = useState(String(cfg.interval ?? def.interval ?? '1h'))
  const [tmScanMode, setTmScanMode] = useState<'single' | 'multi'>(cfg.scan_pairs ? 'multi' : 'single')
  const [tmScanSymbols, setTmScanSymbols] = useState<string[]>(Array.isArray(cfg.scan_symbols) ? cfg.scan_symbols : [])
  // golden_copy fields
  const [gcTargetWallet, setGcTargetWallet] = useState(String(cfg.target_wallet ?? def.target_wallet ?? ''))
  const [gcScaleMode, setGcScaleMode] = useState(String(cfg.scale_mode ?? def.scale_mode ?? 'proportional'))
  const [gcMinPositionPct, setGcMinPositionPct] = useState(String(cfg.min_position_pct ?? def.min_position_pct ?? 0.01))
  const [gcPollInterval, setGcPollInterval] = useState(String(cfg.poll_interval_seconds ?? def.poll_interval_seconds ?? 60))
  const [gcCopyLongs, setGcCopyLongs] = useState(Boolean(cfg.copy_longs ?? def.copy_longs ?? true))
  const [gcCopyShorts, setGcCopyShorts] = useState(Boolean(cfg.copy_shorts ?? def.copy_shorts ?? true))
  const [gcBlockedCoins, setGcBlockedCoins] = useState<string[]>(Array.isArray(cfg.blocked_coins) ? cfg.blocked_coins : [])
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
      const config = bot.bot_type === 'trend_magic' ? {
        symbol: tmScanMode === 'multi' ? (tmScanSymbols[0] || symbol) : symbol,
        dex: dex,
        rsi_period: parseInt(tmRsiPeriod),
        rsi_overbought: parseFloat(tmRsiOverbought),
        rsi_oversold: parseFloat(tmRsiOversold),
        ema_period: parseInt(tmEmaPeriod),
        dca_level_1_pct: parseFloat(tmDca1Pct),
        dca_level_2_pct: parseFloat(tmDca2Pct),
        ...(tmEntryAmount !== '' && { entry_amount_usdc: parseFloat(tmEntryAmount) }),
        ...(tmDca1Amount !== '' && { dca1_amount_usdc: parseFloat(tmDca1Amount) }),
        ...(tmDca2Amount !== '' && { dca2_amount_usdc: parseFloat(tmDca2Amount) }),
        tp_pct: parseFloat(tmTpPct),
        trailing_stop_pct: parseFloat(tmTrailingPct),
        stop_loss_pct: parseFloat(tmStopLossPct),
        allocated_usdc: parseFloat(String(cfg.allocated_usdc ?? bot.allocated_usdc ?? 100)),
        leverage: parseInt(leverage),
        interval: tmInterval,
        sides: tmSides,
        scan_pairs: tmScanMode === 'multi',
        scan_symbols: tmScanMode === 'multi' ? tmScanSymbols : [],
      } : bot.bot_type === 'golden_copy' ? {
        symbol: symbol,
        dex: dex,
        target_wallet: gcTargetWallet,
        scale_mode: gcScaleMode,
        min_position_pct: parseFloat(gcMinPositionPct),
        poll_interval_seconds: parseInt(gcPollInterval),
        copy_longs: gcCopyLongs,
        copy_shorts: gcCopyShorts,
        blocked_coins: gcBlockedCoins,
        allocated_usdc: parseFloat(String(cfg.allocated_usdc ?? bot.allocated_usdc ?? 100)),
        leverage: parseInt(leverage),
      } : {}
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

          {!(bot.bot_type === 'trend_magic' && tmScanMode === 'multi') && (
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
          )}

          {bot.bot_type === 'trend_magic' ? (
            <>
              <div>
                <label style={labelStyle}>Mode</label>
                <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #1a1a2e', width: 'fit-content' }}>
                  {(['single', 'multi'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setTmScanMode(mode)}
                      style={{ padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: tmScanMode === mode ? '#8b5cf6' : '#13131f',
                        color: tmScanMode === mode ? 'white' : '#6b7280',
                      }}>
                      {mode === 'single' ? 'Single Pair' : 'Multi-Pair Scanner'}
                    </button>
                  ))}
                </div>
              </div>
              {tmScanMode === 'multi' && (
                <div>
                  <label style={labelStyle}>Pairs to scan</label>
                  <MarketMultiSelect
                    markets={markets}
                    marketsLoading={marketsLoading}
                    selected={tmScanSymbols}
                    onSelect={sym => setTmScanSymbols(prev => [...prev, sym])}
                    onRemove={sym => setTmScanSymbols(prev => prev.filter(s => s !== sym))}
                    accentColor="#8b5cf6"
                    placeholder="Search and select pairs…"
                  />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>Select pairs to scan. Allocation is split across all active pairs.</p>
                </div>
              )}
              <div>
                <label style={labelStyle}>Interval</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h', '1d'].map(iv => (
                    <button key={iv} type="button" onClick={() => setTmInterval(iv)}
                      style={{ padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: tmInterval === iv ? '#8b5cf622' : '#13131f',
                        color: tmInterval === iv ? '#8b5cf6' : '#6b7280',
                      }}>
                      {iv}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={labelStyle}>Sides</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['long', 'short'].map(s => (
                    <button key={s} type="button" onClick={() => setTmSides(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                      style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: tmSides.includes(s) ? '#8b5cf6' : '#1a1a2e',
                        backgroundColor: tmSides.includes(s) ? '#8b5cf618' : '#0d0d14',
                        color: tmSides.includes(s) ? '#8b5cf6' : '#6b7280',
                      }}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>RSI Period</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiPeriod} onChange={e => setTmRsiPeriod(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>EMA Period</label>
                  <input style={inputStyle} type="number" step="1" value={tmEmaPeriod} onChange={e => setTmEmaPeriod(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>RSI Overbought</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiOverbought} onChange={e => setTmRsiOverbought(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Long signal when RSI &gt; this (uptrend momentum)</p>
                </div>
                <div>
                  <label style={labelStyle}>RSI Oversold</label>
                  <input style={inputStyle} type="number" step="1" value={tmRsiOversold} onChange={e => setTmRsiOversold(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Short signal when RSI &lt; this (downtrend momentum)</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>DCA Level 1 %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmDca1Pct} onChange={e => setTmDca1Pct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>First DCA below/above entry. Default 7%</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA Level 2 %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmDca2Pct} onChange={e => setTmDca2Pct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Second DCA below/above entry. Default 14%</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>Entry Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmEntryAmount} onChange={e => setTmEntryAmount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override entry size. Leave blank for auto (15% of alloc).</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA1 Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmDca1Amount} onChange={e => setTmDca1Amount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override DCA1 size. Leave blank for auto (35% of alloc).</p>
                </div>
                <div>
                  <label style={labelStyle}>DCA2 Amount USDC</label>
                  <input style={inputStyle} type="number" step="1" value={tmDca2Amount} onChange={e => setTmDca2Amount(e.target.value)} placeholder="auto" />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Override DCA2 size. Leave blank for auto (50% of alloc).</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Take Profit %</label>
                  <input style={inputStyle} type="number" step="0.5" value={tmTpPct} onChange={e => setTmTpPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>TP % above/below avg entry</p>
                </div>
                <div>
                  <label style={labelStyle}>Trailing Stop %</label>
                  <input style={inputStyle} type="number" step="0.1" value={tmTrailingPct} onChange={e => setTmTrailingPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>SL trails % below/above peak</p>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Stop Loss %</label>
                <input style={inputStyle} type="number" step="0.5" value={tmStopLossPct} onChange={e => setTmStopLossPct(e.target.value)} />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Wide protective stop-loss before trailing activates. Independent from Trailing Stop %.</p>
              </div>
              <div>
                <label style={labelStyle}>Leverage</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
                  {[1, 2, 3, 5, 10].map(lv => (
                    <button key={lv} type="button" onClick={() => setLeverage(String(lv))}
                      style={{ padding: '6px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: leverage === String(lv) ? '#8b5cf622' : '#13131f',
                        color: leverage === String(lv) ? '#8b5cf6' : '#6b7280',
                      }}>
                      {lv}x
                    </button>
                  ))}
                  <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          ) : bot.bot_type === 'golden_copy' ? (
            <>
              <div>
                <label style={labelStyle}>Target Wallet Address</label>
                <input style={inputStyle} value={gcTargetWallet} onChange={e => setGcTargetWallet(e.target.value)}
                  placeholder="0x…" />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Hyperliquid wallet address to mirror trades from.</p>
              </div>
              <div>
                <label style={labelStyle}>Scale Mode</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[
                    { label: 'Proportional', value: 'proportional' },
                    { label: 'Fixed', value: 'fixed' },
                    { label: 'Equal', value: 'equal' },
                  ].map(opt => (
                    <button key={opt.value} type="button" onClick={() => setGcScaleMode(opt.value)}
                      style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: gcScaleMode === opt.value ? '#00d4aa' : '#1a1a2e',
                        backgroundColor: gcScaleMode === opt.value ? '#00d4aa18' : '#0d0d14',
                        color: gcScaleMode === opt.value ? '#00d4aa' : '#6b7280',
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Proportional: scale by allocation ratio. Fixed: exact USDC per trade. Equal: split allocation equally.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Min Position %</label>
                  <input style={inputStyle} type="number" step="0.001" value={gcMinPositionPct} onChange={e => setGcMinPositionPct(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>Skip positions smaller than this % of target wallet. 0.01 = 1%</p>
                </div>
                <div>
                  <label style={labelStyle}>Poll Interval (seconds)</label>
                  <input style={inputStyle} type="number" step="10" value={gcPollInterval} onChange={e => setGcPollInterval(e.target.value)} />
                  <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>How often to check target wallet for changes.</p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', flex: 1 }}>
                  <input type="checkbox" id="gc-copy-longs-edit" checked={gcCopyLongs} onChange={e => setGcCopyLongs(e.target.checked)}
                    style={{ accentColor: '#00d4aa', width: 16, height: 16, cursor: 'pointer' }} />
                  <label htmlFor="gc-copy-longs-edit" style={{ fontSize: 12, color: '#9ca3af', fontWeight: 700, cursor: 'pointer' }}>Copy Longs</label>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 6, background: '#13131f', border: '1px solid #1a1a2e', flex: 1 }}>
                  <input type="checkbox" id="gc-copy-shorts-edit" checked={gcCopyShorts} onChange={e => setGcCopyShorts(e.target.checked)}
                    style={{ accentColor: '#00d4aa', width: 16, height: 16, cursor: 'pointer' }} />
                  <label htmlFor="gc-copy-shorts-edit" style={{ fontSize: 12, color: '#9ca3af', fontWeight: 700, cursor: 'pointer' }}>Copy Shorts</label>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Blocked Coins</label>
                <MarketMultiSelect
                  markets={markets}
                  marketsLoading={marketsLoading}
                  selected={gcBlockedCoins}
                  onSelect={coin => setGcBlockedCoins(prev => [...prev, coin])}
                  onRemove={coin => setGcBlockedCoins(prev => prev.filter(c => c !== coin))}
                  accentColor="#ef4444"
                  placeholder="Search coins to block…"
                />
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>Coins to never copy even if target wallet holds them.</p>
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
                <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage. Higher leverage amplifies both gains and losses.</p>
              </div>
            </>
          ) : null}

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
