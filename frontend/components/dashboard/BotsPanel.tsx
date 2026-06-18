'use client'
import { useState, useEffect } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-black text-white">Bot Library</h2>
          <p className="text-xs text-gray-500 mt-0.5">Automated trading strategies running on your account</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-lg text-sm font-bold"
          style={{ backgroundColor: '#00d4aa', color: '#000' }}>
          + New Bot
        </button>
      </div>

      {/* Bots list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <p className="text-gray-600 text-sm">No bots yet — create your first automated strategy</p>
          <button onClick={() => setShowCreate(true)}
            className="px-6 py-2.5 rounded-lg text-sm font-bold"
            style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
            Create Grid Bot
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {bots.map(bot => (
            <div key={bot.id} className="rounded-xl border p-5" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-white">{bot.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                        {bot.bot_type === 'grid' ? 'Grid' : 'Envelope DCA'}
                      </span>
                      <span className="text-xs font-semibold" style={{ color: statusColor(bot) }}>
                        ● {statusLabel(bot)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{bot.symbol} · ${bot.allocated_usdc} allocated · {bot.config?.levels ?? '—'} levels · ±{bot.config?.range_pct ?? '—'}%</p>
                    {bot.error_message && (
                      <p className="text-xs text-red-400 mt-1">{bot.error_message}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
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

function CreateBotModal({ walletAddress, onClose, onCreated }: { walletAddress: string, onClose: () => void, onCreated: () => void }) {
  const [name, setName] = useState('My Grid Bot')
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
          bot_type: 'grid',
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border p-6 overflow-y-auto max-h-[90vh]"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between mb-6">
          <h3 className="font-bold text-white text-lg">Create Grid Bot</h3>
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
            </div>
            <div>
              <label style={labelStyle}>Price Range %</label>
              <input style={inputStyle} type="number" value={rangePct} onChange={e => setRangePct(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Stop Loss %</label>
              <input style={inputStyle} type="number" value={stopLossPct} onChange={e => setStopLossPct(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Take Profit %</label>
              <input style={inputStyle} type="number" value={takeProfitPct} onChange={e => setTakeProfitPct(e.target.value)} />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full py-3 rounded-lg font-bold text-sm disabled:opacity-50"
            style={{ backgroundColor: '#00d4aa', color: '#000' }}>
            {loading ? 'Creating...' : 'Create Bot'}
          </button>
        </div>
      </div>
    </div>
  )
}
