'use client'
import { useState, useEffect, useCallback } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

// ── constants ────────────────────────────────────────────────────────────────

const BOT_TYPE_LABELS: Record<string, string> = {
  grid:          'Grid Bot',
  envelope_dca:  'Envelope DCA',
  funding_rate:  'Funding Rate',
  bb_rsi:        'BB + RSI',
  ema_cross:     'EMA Cross',
  passivbot_dca: 'Passivbot DCA',
}

const BOT_TYPE_COLORS: Record<string, string> = {
  grid:          '#00d4aa',
  envelope_dca:  '#8b5cf6',
  funding_rate:  '#f59e0b',
  bb_rsi:        '#3b82f6',
  ema_cross:     '#10b981',
  passivbot_dca: '#ec4899',
}

// Keys shown in the header already — skip in config grid
const SKIP_CONFIG_KEYS = new Set(['bot_type', 'symbol', 'allocated_usdc', 'name'])

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(ts: string | number) {
  if (!ts) return '—'
  const d = new Date(typeof ts === 'number' ? ts : ts)
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  )
}

function fmtPnl(v: number, decimals = 4) {
  const sign = v >= 0 ? '+' : ''
  return `${sign}$${Math.abs(v).toFixed(decimals)}`
}

function formatConfigKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bPct\b/g, '%')
    .replace(/\bUsdc\b/g, 'USDC')
    .replace(/\bMa\b/g, 'MA')
    .replace(/\bEma\b/g, 'EMA')
    .replace(/\bBb\b/g, 'BB')
    .replace(/\bRsi\b/g, 'RSI')
    .replace(/\bSl\b/g, 'SL')
    .replace(/\bTp\b/g, 'TP')
    .replace(/\bWe\b/g, 'WE')
    .replace(/\bDca\b/g, 'DCA')
    .replace(/\bAtr\b/g, 'ATR')
}

function formatConfigValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function statusColor(status: string, desired: string) {
  if (status === 'error') return '#ef4444'
  if (status === 'running' && desired === 'stopped') return '#f59e0b'
  if (status === 'running') return '#00d4aa'
  if (desired === 'running') return '#f59e0b'
  return '#6b7280'
}

function statusLabel(status: string, desired: string) {
  if (status === 'error') return 'Error'
  if (status === 'running' && desired === 'stopped') return 'Stopping...'
  if (status === 'running') return 'Running'
  if (desired === 'running') return 'Starting...'
  return 'Stopped'
}

// ── sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      backgroundColor: '#13131f', borderRadius: 8, padding: '12px 16px',
      border: '1px solid #1a1a2e',
    }}>
      <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </p>
      <p style={{ fontSize: 15, fontWeight: 700, color: color ?? '#e5e7eb', margin: 0 }}>{value}</p>
    </div>
  )
}

// ── main component ───────────────────────────────────────────────────────────

interface Props {
  botId: string
  walletAddress: string
  onBack: () => void
}

export default function BotDetailPanel({ botId, walletAddress, onBack }: Props) {
  const [data,      setData]      = useState<any>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [activeTab, setActiveTab] = useState<'fills' | 'logs'>('fills')

  const fetchDetails = useCallback(async () => {
    try {
      const res = await fetch(
        `${API_URL}/bots/${botId}/details?wallet_address=${walletAddress}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setData(d)
      setError('')
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [botId, walletAddress])

  useEffect(() => { fetchDetails() }, [fetchDetails])

  // Auto-refresh every 30 s while the bot is running
  useEffect(() => {
    if (data?.bot?.status !== 'running') return
    const id = setInterval(fetchDetails, 30_000)
    return () => clearInterval(id)
  }, [data?.bot?.status, fetchDetails])

  const bot    = data?.bot
  const stats  = data?.stats  ?? {}
  const fills: any[] = data?.fills ?? []
  const logs:  any[] = data?.logs  ?? []
  const config = bot?.config ?? {}
  const typeColor = BOT_TYPE_COLORS[bot?.bot_type] ?? '#00d4aa'

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Back button ─────────────────────────────────────────────────── */}
      <button
        onClick={onBack}
        style={{
          fontSize: 13, color: '#6b7280', background: 'none', border: 'none',
          cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center',
          gap: 6, marginBottom: 20,
        }}
      >
        <span style={{ fontSize: 16 }}>←</span> Bots
      </button>

      {/* ── Loading ─────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <div
            className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin"
          />
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {!loading && error && (
        <div style={{
          backgroundColor: '#ef444418', border: '1px solid #ef444444',
          borderRadius: 10, padding: '16px 20px', color: '#ef4444', fontSize: 14,
        }}>
          Failed to load bot details: {error}
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────── */}
      {!loading && !error && bot && (
        <>
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: '#fff', margin: 0 }}>{bot.name}</h2>
              <span style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 6, fontWeight: 700,
                backgroundColor: typeColor + '18', color: typeColor,
                border: `1px solid ${typeColor}44`,
              }}>
                {BOT_TYPE_LABELS[bot.bot_type] ?? bot.bot_type}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(bot.status, bot.desired_status ?? '') }}>
                ● {statusLabel(bot.status, bot.desired_status ?? '')}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px' }}>
              {[
                ['Symbol',     bot.symbol],
                ['Allocation', `$${bot.allocated_usdc}`],
                ['Created',    fmtDate(bot.created_at)],
                ['Updated',    fmtDate(bot.updated_at)],
              ].map(([label, value]) => (
                <span key={label as string} style={{ fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>{label}: </span>
                  <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{value}</span>
                </span>
              ))}
            </div>
            {bot.error_message && (
              <div style={{
                marginTop: 8, fontSize: 12, color: '#ef4444',
                backgroundColor: '#ef444418', border: '1px solid #ef444444',
                borderRadius: 6, padding: '6px 12px',
              }}>
                {bot.error_message}
              </div>
            )}
          </div>

          {/* ── Performance stats ────────────────────────────────────────── */}
          <div style={{
            backgroundColor: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: 12, padding: '20px 24px', marginBottom: 20,
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
              Performance
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              <StatCard label="Total Trades" value={String(stats.total_trades ?? 0)} />
              <StatCard
                label="Total PnL"
                value={fmtPnl(stats.total_pnl ?? 0)}
                color={(stats.total_pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'}
              />
              <StatCard
                label="Total Fees"
                value={`$${(stats.total_fees ?? 0).toFixed(4)}`}
                color="#f59e0b"
              />
              <StatCard
                label="Net PnL"
                value={fmtPnl(stats.net_pnl ?? 0)}
                color={(stats.net_pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'}
              />
              <StatCard
                label="Win Rate"
                value={`${(stats.win_rate ?? 0).toFixed(1)}%`}
                color={(stats.win_rate ?? 0) >= 50 ? '#10b981' : '#ef4444'}
              />
              <StatCard
                label="Avg Trade PnL"
                value={fmtPnl(stats.avg_trade_pnl ?? 0)}
                color={(stats.avg_trade_pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'}
              />
              <StatCard label="Best Trade"  value={fmtPnl(stats.best_trade  ?? 0)} color="#10b981" />
              <StatCard label="Worst Trade" value={fmtPnl(stats.worst_trade ?? 0)} color="#ef4444" />
              <StatCard
                label="Total Volume"
                value={`$${(stats.total_volume ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              />
            </div>
          </div>

          {/* ── Configuration ────────────────────────────────────────────── */}
          <div style={{
            backgroundColor: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: 12, padding: '20px 24px', marginBottom: 20,
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
              Configuration
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
              {Object.entries(config)
                .filter(([k]) => !SKIP_CONFIG_KEYS.has(k))
                .map(([k, v]) => (
                  <div key={k} style={{
                    backgroundColor: '#13131f', borderRadius: 8,
                    padding: '10px 14px', border: '1px solid #1a1a2e',
                  }}>
                    <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {formatConfigKey(k)}
                    </p>
                    <p style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', margin: 0 }}>
                      {formatConfigValue(v)}
                    </p>
                  </div>
                ))}
            </div>
          </div>

          {/* ── Fills + Logs tabs ─────────────────────────────────────────── */}
          <div style={{
            backgroundColor: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: 12, overflow: 'hidden',
          }}>
            {/* Tab bar */}
            <div style={{
              display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)',
              padding: '0 6px', position: 'sticky', top: 0,
              backgroundColor: 'rgba(10,10,15,0.96)', zIndex: 2,
            }}>
              {([
                ['fills', `Hyperliquid Fills (${fills.length})`],
                ['logs',  `Bot Logs (${logs.length})`],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: '10px 14px',
                    border: 'none', cursor: 'pointer', background: 'transparent',
                    color: activeTab === tab ? '#00d4aa' : '#6b7280',
                    borderBottom: activeTab === tab ? '2px solid #00d4aa' : '2px solid transparent',
                    marginBottom: -1, transition: 'color 0.15s', whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Fills tab */}
            {activeTab === 'fills' && (
              fills.length === 0 ? (
                <div style={{ padding: 24, fontSize: 12, color: '#4b5563', textAlign: 'center' }}>
                  No fills found for this bot since it was created
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        {['Time', 'Side', 'Price', 'Size', 'Closed PnL', 'Fee', 'Net'].map(h => (
                          <th key={h} style={{
                            padding: '8px 16px', textAlign: 'left',
                            fontSize: 11, fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap',
                          }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fills.map((f: any, i: number) => {
                        const isBuy = f.side === 'B'
                        const pnl   = parseFloat(f.closedPnl ?? '0')
                        const fee   = parseFloat(f.fee       ?? '0')
                        const net   = pnl - fee
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '8px 16px', fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                              {fmtDate(f.time)}
                            </td>
                            <td style={{ padding: '8px 16px' }}>
                              <span style={{
                                fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                                backgroundColor: isBuy ? '#10b98118' : '#ef444418',
                                color:           isBuy ? '#10b981'   : '#ef4444',
                              }}>
                                {isBuy ? 'Buy' : 'Sell'}
                              </span>
                            </td>
                            <td style={{ padding: '8px 16px', fontSize: 12, color: '#e5e7eb' }}>
                              ${parseFloat(f.px ?? '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                            </td>
                            <td style={{ padding: '8px 16px', fontSize: 12, color: '#e5e7eb' }}>
                              {parseFloat(f.sz ?? '0').toFixed(6)}
                            </td>
                            <td style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, color: pnl >= 0 ? '#10b981' : '#ef4444' }}>
                              {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)}
                            </td>
                            <td style={{ padding: '8px 16px', fontSize: 12, color: '#f59e0b' }}>
                              {fee.toFixed(4)}
                            </td>
                            <td style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, color: net >= 0 ? '#10b981' : '#ef4444' }}>
                              {net >= 0 ? '+' : ''}{net.toFixed(4)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Logs tab */}
            {activeTab === 'logs' && (
              logs.length === 0 ? (
                <div style={{ padding: 24, fontSize: 12, color: '#4b5563', textAlign: 'center' }}>
                  No logs yet
                </div>
              ) : (
                <div style={{
                  padding: '12px 16px', display: 'flex', flexDirection: 'column',
                  gap: 2, maxHeight: 500, overflowY: 'auto',
                }}>
                  {logs.map((log: any, i: number) => (
                    <div key={i} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                      <span style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap', paddingTop: 1 }}>
                        {new Date(log.created_at).toLocaleTimeString('en-US', {
                          hour: '2-digit', minute: '2-digit', second: '2-digit',
                        })}
                      </span>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 700, whiteSpace: 'nowrap',
                        backgroundColor: log.level === 'error'   ? '#ef444418'
                                       : log.level === 'warning' ? '#f59e0b18'
                                       : '#00d4aa18',
                        color:           log.level === 'error'   ? '#ef4444'
                                       : log.level === 'warning' ? '#f59e0b'
                                       : '#00d4aa',
                      }}>
                        {(log.level ?? 'info').toUpperCase()}
                      </span>
                      <span style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.5 }}>{log.message}</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  )
}
