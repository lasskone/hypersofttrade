'use client'
import { useState, useEffect, useRef } from 'react'
import {
  RSI_DCA_FIELDS, RSI_DCA_META, RSI_DCA_DEFAULTS,
  MOMENTUM_SCALPER_FIELDS, MOMENTUM_SCALPER_META, MOMENTUM_SCALPER_DEFAULTS,
  FADE_SCALPER_FIELDS, FADE_SCALPER_META, FADE_SCALPER_DEFAULTS,
  type BotField,
} from '@/lib/botFieldSchemas'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

const BOT_TYPES: Record<string, {
  name: string; emoji: string; tagline: string; description: string;
  howItWorks: string[]; bestFor: string; risk: string; riskColor: string;
  params: Record<string, { label: string; hint: string }>;
  minAllocation: number; color: string;
}> = {
  rsi_dca: {
    name:        RSI_DCA_META.name,
    emoji:       RSI_DCA_META.emoji,
    tagline:     RSI_DCA_META.tagline,
    description: RSI_DCA_META.description,
    howItWorks:  RSI_DCA_META.howItWorks,
    bestFor:     RSI_DCA_META.bestFor,
    risk:        RSI_DCA_META.risk,
    riskColor:   RSI_DCA_META.riskColor,
    minAllocation: RSI_DCA_META.minAllocation,
    color:       RSI_DCA_META.color,
    params:      Object.fromEntries(RSI_DCA_FIELDS.map(f => [f.key, { label: f.label, hint: f.hint }])),
  },
  momentum_scalper: {
    name:        MOMENTUM_SCALPER_META.name,
    emoji:       MOMENTUM_SCALPER_META.emoji,
    tagline:     MOMENTUM_SCALPER_META.tagline,
    description: MOMENTUM_SCALPER_META.description,
    howItWorks:  MOMENTUM_SCALPER_META.howItWorks,
    bestFor:     MOMENTUM_SCALPER_META.bestFor,
    risk:        MOMENTUM_SCALPER_META.risk,
    riskColor:   MOMENTUM_SCALPER_META.riskColor,
    minAllocation: MOMENTUM_SCALPER_META.minAllocation,
    color:       MOMENTUM_SCALPER_META.color,
    params:      Object.fromEntries(MOMENTUM_SCALPER_FIELDS.map(f => [f.key, { label: f.label, hint: f.hint }])),
  },
  momentum_fade_scalper: {
    name:        FADE_SCALPER_META.name,
    emoji:       FADE_SCALPER_META.emoji,
    tagline:     FADE_SCALPER_META.tagline,
    description: FADE_SCALPER_META.description,
    howItWorks:  FADE_SCALPER_META.howItWorks,
    bestFor:     FADE_SCALPER_META.bestFor,
    risk:        FADE_SCALPER_META.risk,
    riskColor:   FADE_SCALPER_META.riskColor,
    minAllocation: FADE_SCALPER_META.minAllocation,
    color:       FADE_SCALPER_META.color,
    params:      Object.fromEntries(FADE_SCALPER_FIELDS.map(f => [f.key, { label: f.label, hint: f.hint }])),
  },
}

const BOT_TYPE_DEFAULTS: Record<string, Record<string, any>> = {
  rsi_dca:                RSI_DCA_DEFAULTS,
  momentum_scalper:       MOMENTUM_SCALPER_DEFAULTS,
  momentum_fade_scalper:  FADE_SCALPER_DEFAULTS,
}

// Returns the right field list for a given bot type.
function getSchemaFields(botType: string): BotField[] {
  if (botType === 'rsi_dca') return RSI_DCA_FIELDS
  if (botType === 'momentum_scalper') return MOMENTUM_SCALPER_FIELDS
  if (botType === 'momentum_fade_scalper') return FADE_SCALPER_FIELDS
  return []
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
  const [createType, setCreateType] = useState('')
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
      // FIX 3: Clearer warning when the bot is actively running.
      const isActive = bot.status === 'running'
      const message = isActive
        ? `"${bot.name}" is currently running. Deleting it will stop and permanently remove it. Continue?`
        : `Delete bot "${bot.name}"? This cannot be undone.`
      setConfirmAction({
        message,
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
        // FIX 2: Use Promise.allSettled so partial failures are visible by bot name.
        const botIds = Array.from(selectedBots)
        const results = await Promise.allSettled(
          botIds.map(botId =>
            fetch(`${API_URL}/bots/${botId}`, { method: 'DELETE' }).then(async res => {
              if (!res.ok) {
                const text = await res.text().catch(() => '')
                let detail = text
                try { detail = (JSON.parse(text) as any)?.detail ?? text } catch { /* not JSON */ }
                throw new Error(`HTTP ${res.status}: ${detail}`)
              }
            })
          )
        )
        const succeededIds = new Set(botIds.filter((_, i) => results[i].status === 'fulfilled'))
        const failedEntries = botIds
          .map((id, i) => ({ id, result: results[i] }))
          .filter(({ result }) => result.status === 'rejected')
          .map(({ id, result }) => {
            const botName = bots.find(b => b.id === id)?.name ?? id
            const reason = (result as PromiseRejectedResult).reason?.message ?? 'unknown error'
            return `${botName} (${reason})`
          })

        if (failedEntries.length === 0) {
          showToast(`${succeededIds.size} bot${succeededIds.size !== 1 ? 's' : ''} deleted`)
        } else {
          showToast(
            `Deleted ${succeededIds.size} of ${botIds.length} bots. Failed: ${failedEntries.join(', ')}`
          )
        }
        setSelectedBots(prev => {
          const next = new Set(prev)
          succeededIds.forEach(id => next.delete(id))
          return next
        })
        fetchBots()
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
        {Object.keys(BOT_TYPES).length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center' as const }}>
            <p style={{ fontSize: 13, color: '#6b7280' }}>No bot strategies available yet — check back soon</p>
          </div>
        ) : (
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
        )}
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

// ── Shared helper: renders number inputs for every schema field ───────────────
function renderSchemaFields(
  fields: BotField[],
  params: Record<string, number>,
  setParams: React.Dispatch<React.SetStateAction<Record<string, number>>>,
  inputStyle: React.CSSProperties,
  labelStyle: React.CSSProperties,
  skip: string[] = [],
) {
  return fields
    .filter(f => !skip.includes(f.key))
    .map(f => (
      <div key={f.key}>
        <label style={labelStyle}>{f.label.toUpperCase()}</label>
        <input
          style={inputStyle}
          type="number"
          value={params[f.key] ?? f.default}
          onChange={e => setParams(p => ({ ...p, [f.key]: parseFloat(e.target.value) || 0 }))}
        />
        <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>{f.hint}</p>
      </div>
    ))
}

export function CreateBotModal({ walletAddress, botType, onClose, onCreated, initialSymbol, initialDex, initialParams, initialInterval }: { walletAddress: string, botType: string, onClose: () => void, onCreated: () => void, initialSymbol?: string, initialDex?: string, initialParams?: Record<string, number>, initialInterval?: string }) {
  const ip = initialParams ?? {}
  const typeDefaults = BOT_TYPE_DEFAULTS[botType] ?? {}
  const isMomentumScalper = botType === 'momentum_scalper'
  const isFadeScalper = botType === 'momentum_fade_scalper'
  const isMultiSymbol = isMomentumScalper || isFadeScalper
  const chipColor = isFadeScalper ? '#06b6d4' : '#f97316'
  const [name, setName] = useState(`My ${BOT_TYPES[botType as keyof typeof BOT_TYPES]?.name ?? 'Bot'}`)
  const [symbol, setSymbol] = useState(initialSymbol ?? 'BTC')
  const [dex, setDex] = useState(initialDex ?? '')
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(
    isFadeScalper ? ['BTC', 'ETH', 'SOL'] : ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE']
  )
  const [symbolInput, setSymbolInput] = useState('')
  const [allocatedUsdc, setAllocatedUsdc] = useState('100')
  const [leverage, setLeverage] = useState(String(ip.leverage ?? typeDefaults.leverage ?? 1))
  const [params, setParams] = useState<Record<string, number>>({ ...typeDefaults, ...ip })
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
          symbol: isMultiSymbol ? selectedSymbols.join(',') : symbol,
          allocated_usdc: parseFloat(allocatedUsdc),
          config: {
            ...params,
            ...(isMultiSymbol ? { symbols: selectedSymbols } : { dex }),
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
          {/* Market picker — single symbol for RSI DCA; dynamic chip multi-select for multi-symbol bots */}
          {isMultiSymbol ? (
            <div>
              <label style={labelStyle}>SYMBOLS TO SCAN</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginBottom: 8 }}>
                {selectedSymbols.map(sym => (
                  <span key={sym} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 700,
                    background: `${chipColor}18`, color: chipColor, border: `1px solid ${chipColor}44`,
                  }}>
                    {sym}
                    <button type="button" onClick={() => setSelectedSymbols(prev => prev.filter(s => s !== sym))}
                      style={{ background: 'none', border: 'none', color: chipColor, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.7 }}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text" value={symbolInput}
                  onChange={e => setSymbolInput(e.target.value.toUpperCase().replace(/[^A-Z0-9:]/g, ''))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const s = symbolInput.trim()
                      if (s && !selectedSymbols.includes(s)) setSelectedSymbols(prev => [...prev, s])
                      setSymbolInput('')
                    }
                  }}
                  placeholder="e.g. DOGE"
                  style={{ ...inputStyle, flex: 1, textTransform: 'uppercase' as const }}
                />
                <button type="button"
                  onClick={() => {
                    const s = symbolInput.trim()
                    if (s && !selectedSymbols.includes(s)) setSelectedSymbols(prev => [...prev, s])
                    setSymbolInput('')
                  }}
                  style={{ padding: '0 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: `${chipColor}18`, color: chipColor, border: `1px solid ${chipColor}44` }}>
                  Add
                </button>
              </div>
              <p style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>
                Type any Hyperliquid perp symbol and press Enter or Add. Click × to remove. At least one required.
              </p>
            </div>
          ) : (
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
          <div>
            <label style={labelStyle}>Leverage</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
              {[1, 2, 3, 5, 10].map(lv => (
                <button key={lv} type="button" onClick={() => setLeverage(String(lv))}
                  style={{ padding: '6px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                    background: leverage === String(lv) ? '#00d4aa22' : '#13131f',
                    color: leverage === String(lv) ? '#00d4aa' : '#6b7280',
                  }}>
                  {lv}x
                </button>
              ))}
              <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
            </div>
            <p style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>1x = no leverage (spot-like). Higher leverage amplifies both gains and losses.</p>
          </div>

          {/* Strategy-specific parameters from schema */}
          {BOT_TYPES[botType] && (
            <div style={{ borderTop: '1px solid #1a1a2e', paddingTop: 14 }}>
              <p style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: '0.05em', marginBottom: 12 }}>STRATEGY PARAMETERS</p>
              {renderSchemaFields(
                getSchemaFields(botType),
                params,
                setParams,
                inputStyle,
                labelStyle,
                ['leverage'],   // handled above by the dedicated button UI
              )}
            </div>
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
  // Read bot config fresh each open — bot.config takes priority; fall back to type defaults
  const def = BOT_TYPE_DEFAULTS[bot.bot_type] ?? {}
  const cfg: any = bot.config ?? {}
  const isMomentumScalper = bot.bot_type === 'momentum_scalper'
  const isFadeScalper = bot.bot_type === 'momentum_fade_scalper'
  const isMultiSymbol = isMomentumScalper || isFadeScalper
  const chipColor = isFadeScalper ? '#06b6d4' : '#f97316'
  const [name, setName] = useState(bot.name ?? '')
  const [symbol, setSymbol] = useState<string>(String(cfg.symbol ?? bot.symbol ?? ''))
  const [dex, setDex] = useState<string>(String(cfg.dex ?? ''))
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(
    cfg.symbols && Array.isArray(cfg.symbols) ? cfg.symbols :
    isFadeScalper ? ['BTC', 'ETH', 'SOL'] : ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE']
  )
  const [symbolInput, setSymbolInput] = useState('')
  const [allocatedUsdc, setAllocatedUsdc] = useState(String(cfg.allocated_usdc ?? bot.allocated_usdc ?? '100'))
  const [leverage, setLeverage] = useState(String(cfg.leverage ?? def.leverage ?? 1))
  // Initialise strategy params from saved config, filling gaps with schema defaults
  const [params, setParams] = useState<Record<string, number>>(() => {
    const merged: Record<string, number> = { ...def }
    for (const [k, v] of Object.entries(cfg)) {
      // allocated_usdc and leverage have dedicated state variables — exclude
      // them here so ...params never overwrites those inputs in handleUpdate.
      if (typeof v === 'number' && k !== 'allocated_usdc' && k !== 'leverage') merged[k] = v
    }
    return merged
  })
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
      const finalConfig = {
        bot_type:      bot.bot_type,
        ...params,
        ...(isMultiSymbol ? { symbols: selectedSymbols } : { symbol, dex }),
        allocated_usdc: parseFloat(allocatedUsdc),
        leverage:       parseInt(leverage),
      }
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

          {/* Market picker — single symbol for RSI DCA; dynamic chip multi-select for multi-symbol bots */}
          {isMultiSymbol ? (
            <div>
              <label style={labelStyle}>SYMBOLS TO SCAN</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginBottom: 8 }}>
                {selectedSymbols.map(sym => (
                  <span key={sym} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 700,
                    background: `${chipColor}18`, color: chipColor, border: `1px solid ${chipColor}44`,
                  }}>
                    {sym}
                    <button type="button" onClick={() => setSelectedSymbols(prev => prev.filter(s => s !== sym))}
                      style={{ background: 'none', border: 'none', color: chipColor, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.7 }}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text" value={symbolInput}
                  onChange={e => setSymbolInput(e.target.value.toUpperCase().replace(/[^A-Z0-9:]/g, ''))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const s = symbolInput.trim()
                      if (s && !selectedSymbols.includes(s)) setSelectedSymbols(prev => [...prev, s])
                      setSymbolInput('')
                    }
                  }}
                  placeholder="e.g. DOGE"
                  style={{ ...inputStyle, flex: 1, textTransform: 'uppercase' as const }}
                />
                <button type="button"
                  onClick={() => {
                    const s = symbolInput.trim()
                    if (s && !selectedSymbols.includes(s)) setSelectedSymbols(prev => [...prev, s])
                    setSymbolInput('')
                  }}
                  style={{ padding: '0 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: `${chipColor}18`, color: chipColor, border: `1px solid ${chipColor}44` }}>
                  Add
                </button>
              </div>
              <p style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>
                Type any Hyperliquid perp symbol and press Enter or Add. Click × to remove. At least one required.
              </p>
            </div>
          ) : (
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

          <div>
            <label style={labelStyle}>Leverage</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
              {[1, 2, 3, 5, 10].map(lv => (
                <button key={lv} type="button" onClick={() => setLeverage(String(lv))}
                  style={{ padding: '6px 12px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none',
                    background: leverage === String(lv) ? '#00d4aa22' : '#13131f',
                    color: leverage === String(lv) ? '#00d4aa' : '#6b7280',
                  }}>
                  {lv}x
                </button>
              ))}
              <input style={{ ...inputStyle, width: 70 }} type="number" min="1" max="50" value={leverage} onChange={e => setLeverage(e.target.value)} />
            </div>
          </div>

          {/* Strategy-specific parameters from schema */}
          {BOT_TYPES[bot.bot_type] && (
            <div style={{ borderTop: '1px solid #1a1a2e', paddingTop: 14 }}>
              <p style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: '0.05em', marginBottom: 12 }}>STRATEGY PARAMETERS</p>
              {renderSchemaFields(
                getSchemaFields(bot.bot_type),
                params,
                setParams,
                inputStyle,
                labelStyle,
                ['leverage'],
              )}
            </div>
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
