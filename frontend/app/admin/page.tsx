'use client'
import { useState, useEffect } from 'react'

const ADMIN_PASSWORD = 'hypersofttrade_admin_2024'
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

export default function AdminPage() {
  const [authed, setAuthed] = useState(false)
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [bots, setBots] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  const fetchAllBots = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/admin/bots`)
      const data = await res.json()
      setBots(data.bots ?? [])
    } catch { showToast('Failed to load bots') }
    finally { setLoading(false) }
  }

  useEffect(() => { if (authed) fetchAllBots() }, [authed])

  const handleLogin = () => {
    if (pw === ADMIN_PASSWORD) { setAuthed(true); setPwError('') }
    else setPwError('Invalid password')
  }

  const handleAction = async (botId: string, action: 'start' | 'stop' | 'delete') => {
    try {
      if (action === 'delete') {
        await fetch(`${API_URL}/bots/${botId}`, { method: 'DELETE' })
        showToast('Bot deleted')
      } else {
        await fetch(`${API_URL}/bots/${botId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: bots.find(b => b.id === botId)?.wallet_address ?? '' })
        })
        showToast(`Bot ${action}ed`)
      }
      fetchAllBots()
    } catch { showToast('Action failed') }
  }

  const statusColor = (s: string) => s === 'running' ? '#00d4aa' : s === 'error' ? '#ef4444' : '#6b7280'

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
        <div className="w-full max-w-sm rounded-2xl border p-8" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
          <h1 className="text-xl font-bold text-white mb-2">HyperSoftTrade</h1>
          <p className="text-sm text-gray-500 mb-6">Super Admin Panel</p>
          <input
            type="password"
            placeholder="Admin password"
            value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            className="w-full rounded-lg px-4 py-3 text-sm text-white mb-3 outline-none"
            style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}
          />
          {pwError && <p className="text-xs text-red-400 mb-3">{pwError}</p>}
          <button
            onClick={handleLogin}
            className="w-full py-3 rounded-lg font-bold text-sm"
            style={{ backgroundColor: '#00d4aa', color: '#000' }}>
            Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-6" style={{ backgroundColor: '#0a0a0f' }}>
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium"
          style={{ backgroundColor: '#1a1a2e', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
          {toast}
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-black text-white">Super Admin</h1>
            <p className="text-sm text-gray-500">HyperSoftTrade Bot Management</p>
          </div>
          <button onClick={fetchAllBots} className="text-xs px-4 py-2 rounded-lg" style={{ backgroundColor: '#1a1a2e', color: '#6b7280' }}>
            Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Total Bots', value: bots.length },
            { label: 'Running', value: bots.filter(b => b.is_running).length },
            { label: 'Errors', value: bots.filter(b => b.status === 'error').length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl p-5 border" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className="text-3xl font-black text-white">{value}</p>
            </div>
          ))}
        </div>

        {/* Bots table */}
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
          <div className="px-5 py-4 border-b" style={{ borderColor: '#1a1a2e' }}>
            <h2 className="text-sm font-bold text-white">All Bots</h2>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : bots.length === 0 ? (
            <p className="text-center text-gray-600 py-12 text-sm">No bots created yet</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  {['Name', 'Type', 'Symbol', 'Allocation', 'Status', 'Created', 'Actions'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bots.map((bot: any) => (
                  <tr key={bot.id} className="border-b last:border-0 hover:bg-white/5" style={{ borderColor: '#1a1a2e' }}>
                    <td className="px-5 py-3 text-sm font-semibold text-white">{bot.name}</td>
                    <td className="px-5 py-3">
                      <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                        {bot.bot_type}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-300">{bot.symbol}</td>
                    <td className="px-5 py-3 text-sm text-gray-300">${bot.allocated_usdc}</td>
                    <td className="px-5 py-3">
                      <span className="text-xs font-semibold" style={{ color: statusColor(bot.is_running ? 'running' : bot.status) }}>
                        ● {bot.is_running ? 'Running' : bot.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {new Date(bot.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-2">
                        {bot.is_running ? (
                          <button onClick={() => handleAction(bot.id, 'stop')}
                            className="text-xs px-3 py-1 rounded font-semibold"
                            style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                            Stop
                          </button>
                        ) : (
                          <button onClick={() => handleAction(bot.id, 'start')}
                            className="text-xs px-3 py-1 rounded font-semibold"
                            style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                            Start
                          </button>
                        )}
                        <button onClick={() => handleAction(bot.id, 'delete')}
                          className="text-xs px-3 py-1 rounded font-semibold"
                          style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
