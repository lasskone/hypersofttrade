'use client'
import { useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

const INTERVALS = ['1m','5m','15m','30m','1h','4h','8h','12h','1d']
const PERIODS = [
  { label: '1 week', interval: '15m', limit: 672 },
  { label: '1 month', interval: '1h', limit: 720 },
  { label: '3 months', interval: '4h', limit: 540 },
  { label: '6 months', interval: '8h', limit: 540 },
  { label: '1 year', interval: '1d', limit: 365 },
]

const BOT_CONFIGS: Record<string, { label: string; color: string; fields: any[] }> = {
  grid: {
    label: 'Grid Bot',
    color: '#00d4aa',
    fields: [
      { key: 'levels', label: 'Grid Levels', default: 10, hint: 'Number of order pairs' },
      { key: 'range_pct', label: 'Price Range %', default: 5, hint: 'Total range around current price' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 10, hint: '0 = disabled' },
      { key: 'take_profit_pct', label: 'Take Profit %', default: 30, hint: '0 = disabled' },
    ],
  },
  envelope_dca: {
    label: 'Envelope DCA Bot',
    color: '#8b5cf6',
    fields: [
      { key: 'ma_period', label: 'MA Period', default: 20, hint: 'Moving average window' },
      { key: 'envelope_1_pct', label: 'Envelope 1 %', default: 7, hint: 'First buy level below MA' },
      { key: 'envelope_2_pct', label: 'Envelope 2 %', default: 10, hint: 'Second buy level (0 = off)' },
      { key: 'envelope_3_pct', label: 'Envelope 3 %', default: 15, hint: 'Third buy level (0 = off)' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', default: 10, hint: '0 = disabled' },
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

function EquityChart({ data, bnh_start, allocation, color }: { data: { time: number; value: number }[], bnh_start: number, allocation: number, color: string }) {
  if (!data.length) return null

  const width = 800
  const height = 280
  const pad = { top: 20, right: 20, bottom: 40, left: 70 }
  const W = width - pad.left - pad.right
  const H = height - pad.top - pad.bottom

  const values = data.map(d => d.value)
  const minV = Math.min(...values) * 0.995
  const maxV = Math.max(...values) * 1.005

  const xScale = (i: number) => (i / (data.length - 1)) * W
  const yScale = (v: number) => H - ((v - minV) / (maxV - minV)) * H

  // Equity line path
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.value)}`).join(' ')

  // Buy & hold line
  const bnh_end = allocation * (1 + (data[data.length - 1].value / data[0].value - 1))
  const bnhPath = `M 0 ${yScale(data[0].value)} L ${W} ${yScale(bnh_end)}`

  // X axis labels (5 evenly spaced dates)
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const i = Math.floor(t * (data.length - 1))
    const d = new Date(data[i].time * 1000)
    return { x: xScale(i), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  })

  // Y axis labels
  const yTicks = 5
  const yLabels = Array.from({ length: yTicks }, (_, i) => {
    const v = minV + (maxV - minV) * (i / (yTicks - 1))
    return { y: yScale(v), label: `$${v.toFixed(0)}` }
  })

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        <g transform={`translate(${pad.left},${pad.top})`}>
          {/* Grid lines */}
          {yLabels.map((l, i) => (
            <line key={i} x1={0} y1={l.y} x2={W} y2={l.y} stroke="#1a1a2e" strokeWidth={1} />
          ))}

          {/* Buy & hold reference line */}
          <path d={bnhPath} fill="none" stroke="#6b7280" strokeWidth={1.5} strokeDasharray="4 4" />

          {/* Equity curve fill */}
          <path
            d={`${path} L ${W} ${H} L 0 ${H} Z`}
            fill={color}
            fillOpacity={0.08}
          />

          {/* Equity curve line */}
          <path d={path} fill="none" stroke={color} strokeWidth={2} />

          {/* Y axis labels */}
          {yLabels.map((l, i) => (
            <text key={i} x={-8} y={l.y + 4} textAnchor="end" fontSize={10} fill="#6b7280">{l.label}</text>
          ))}

          {/* X axis labels */}
          {xLabels.map((l, i) => (
            <text key={i} x={l.x} y={H + 20} textAnchor="middle" fontSize={10} fill="#6b7280">{l.label}</text>
          ))}

          {/* Legend */}
          <line x1={W - 120} y1={10} x2={W - 100} y2={10} stroke={color} strokeWidth={2} />
          <text x={W - 95} y={14} fontSize={10} fill="#9ca3af">Strategy</text>
          <line x1={W - 120} y1={25} x2={W - 100} y2={25} stroke="#6b7280" strokeWidth={1.5} strokeDasharray="4 4" />
          <text x={W - 95} y={29} fontSize={10} fill="#9ca3af">Buy & Hold</text>
        </g>
      </svg>
    </div>
  )
}

export default function BacktestPanel() {
  const [botType, setBotType] = useState('grid')
  const [symbol, setSymbol] = useState('BTC')
  const [dex, setDex] = useState('')
  const [period, setPeriod] = useState(PERIODS[2])
  const [allocation, setAllocation] = useState('1000')
  const [params, setParams] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')

  const config = BOT_CONFIGS[botType]

  const getParam = (key: string, def: number) => params[key] ?? def

  const handleRun = async () => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const body: any = {
        bot_type: botType,
        symbol,
        dex,
        interval: period.interval,
        limit: period.limit,
        allocation: parseFloat(allocation),
      }
      config.fields.forEach(f => { body[f.key] = getParam(f.key, f.default) })

      const res = await fetch(`${API_URL}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Backtest failed')
      setResult(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = { width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }
  const labelStyle = { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block' as const }
  const pnlColor = (v: number) => v >= 0 ? '#10b981' : '#ef4444'

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-black text-white">Backtest Console</h2>
        <p className="text-xs text-gray-500 mt-0.5">Simulate any strategy on historical Hyperliquid data before deploying real capital</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Config panel */}
        <div className="lg:col-span-1 rounded-xl border p-5 space-y-4" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Configuration</p>

          {/* Bot type */}
          <div>
            <label style={labelStyle}>Strategy</label>
            <select value={botType} onChange={e => { setBotType(e.target.value); setResult(null) }}
              style={{ ...inputStyle, cursor: 'pointer' }}>
              {Object.entries(BOT_CONFIGS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>

          {/* Symbol + DEX */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label style={labelStyle}>Symbol</label>
              <input style={inputStyle} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} />
            </div>
            <div>
              <label style={labelStyle}>DEX</label>
              <input style={inputStyle} placeholder="main" value={dex} onChange={e => setDex(e.target.value.toLowerCase())} />
            </div>
          </div>

          {/* Period */}
          <div>
            <label style={labelStyle}>Period</label>
            <select value={period.label} onChange={e => setPeriod(PERIODS.find(p => p.label === e.target.value)!)}
              style={{ ...inputStyle, cursor: 'pointer' }}>
              {PERIODS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
          </div>

          {/* Allocation */}
          <div>
            <label style={labelStyle}>Allocation (USDC)</label>
            <input style={inputStyle} type="number" value={allocation} onChange={e => setAllocation(e.target.value)} />
          </div>

          {/* Strategy params */}
          <div className="pt-2 border-t" style={{ borderColor: '#1a1a2e' }}>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Strategy Parameters</p>
            {config.fields.map(f => (
              <div key={f.key} className="mb-3">
                <label style={labelStyle}>{f.label}</label>
                <input
                  style={inputStyle}
                  type="number"
                  value={getParam(f.key, f.default)}
                  onChange={e => setParams(p => ({ ...p, [f.key]: parseFloat(e.target.value) || 0 }))}
                />
                <p className="text-xs mt-1" style={{ color: '#4b5563' }}>{f.hint}</p>
              </div>
            ))}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleRun}
            disabled={loading}
            className="w-full py-3 rounded-lg font-bold text-sm disabled:opacity-50 transition-opacity hover:opacity-90"
            style={{ backgroundColor: config.color, color: botType === 'grid' ? '#000' : '#fff' }}>
            {loading ? '⏳ Running simulation...' : '▶ Run Backtest'}
          </button>
        </div>

        {/* Results panel */}
        <div className="lg:col-span-2">
          {!result && !loading && (
            <div className="rounded-xl border flex items-center justify-center h-full min-h-64"
              style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
              <div className="text-center">
                <p className="text-4xl mb-3">📊</p>
                <p className="text-gray-500 text-sm">Configure your strategy and click Run Backtest</p>
                <p className="text-gray-600 text-xs mt-1">Results will appear here</p>
              </div>
            </div>
          )}

          {loading && (
            <div className="rounded-xl border flex items-center justify-center h-full min-h-64"
              style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: config.color }} />
                <p className="text-sm text-gray-500">Fetching historical data and running simulation...</p>
              </div>
            </div>
          )}

          {result && (
            <div className="space-y-4">
              {/* Stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: 'Total PnL', value: `${result.pnl_pct >= 0 ? '+' : ''}${result.pnl_pct}%`, sub: `$${result.pnl_usd >= 0 ? '+' : ''}${result.pnl_usd}`, color: pnlColor(result.pnl_pct) },
                  { label: 'vs Buy & Hold', value: `${result.bnh_pct >= 0 ? '+' : ''}${result.bnh_pct}%`, sub: `Strategy ${result.pnl_pct >= result.bnh_pct ? 'outperforms ✅' : 'underperforms ❌'}`, color: pnlColor(result.pnl_pct - result.bnh_pct) },
                  { label: 'Win Rate', value: `${result.win_rate}%`, sub: `${result.total_trades} total trades`, color: result.win_rate >= 50 ? '#10b981' : '#ef4444' },
                  { label: 'Max Drawdown', value: `-${result.max_drawdown_pct}%`, sub: 'Peak to trough', color: '#ef4444' },
                  { label: 'Final Equity', value: `$${result.final_equity.toFixed(2)}`, sub: `Started at $${allocation}`, color: '#fff' },
                  { label: 'Data', value: `${result.candles_used} candles`, sub: `${result.interval} · ${result.symbol}`, color: '#6b7280' },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="rounded-xl border p-4" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
                    <p className="text-xs text-gray-500 mb-1">{label}</p>
                    <p className="text-xl font-black" style={{ color }}>{value}</p>
                    <p className="text-xs mt-1" style={{ color: '#4b5563' }}>{sub}</p>
                  </div>
                ))}
              </div>

              {/* Equity chart */}
              <div className="rounded-xl border p-5" style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Equity Curve</p>
                <EquityChart
                  data={result.equity_curve}
                  bnh_start={parseFloat(allocation)}
                  allocation={parseFloat(allocation)}
                  color={config.color}
                />
              </div>

              {/* Deploy CTA */}
              <div className="rounded-xl border p-4 flex items-center justify-between"
                style={{ backgroundColor: '#0d0d14', borderColor: config.color + '44' }}>
                <div>
                  <p className="text-sm font-bold text-white">Like these results?</p>
                  <p className="text-xs text-gray-500">Deploy this exact strategy with real capital on your account</p>
                </div>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('deploy-bot', { detail: { botType, symbol, dex, ...Object.fromEntries(config.fields.map(f => [f.key, getParam(f.key, f.default)])), allocation: parseFloat(allocation) } }))}
                  className="px-4 py-2 rounded-lg text-sm font-bold shrink-0"
                  style={{ backgroundColor: config.color, color: botType === 'grid' ? '#000' : '#fff' }}>
                  Deploy Strategy →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
