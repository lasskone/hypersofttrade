'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const API_URL = process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app'

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
const EMA_PRESETS = [9, 20, 50, 100, 200]
const RSI_PRESETS = [7, 14, 21]
const RSI_HEIGHT = 120

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface Props {
  symbol: string
  height?: number
}

export default function HLChart({ symbol, height = 420 }: Props) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const chartRef        = useRef<any>(null)
  const rsiContainerRef = useRef<HTMLDivElement>(null)
  const rsiChartRef     = useRef<any>(null)
  const loadingRef      = useRef(false)

  const [selectedInterval, setSelectedInterval]     = useState('15m')
  const [showEMA, setShowEMA]                       = useState(true)
  const [emaPeriod, setEmaPeriod]                   = useState(20)
  const [showPeriodInput, setShowPeriodInput]       = useState(false)
  const emaBtnRef = useRef<HTMLDivElement>(null)
  const rsiBtnRef = useRef<HTMLDivElement>(null)
  const [emaBtnRect, setEmaBtnRect] = useState<DOMRect | null>(null)
  const [rsiBtnRect, setRsiBtnRect] = useState<DOMRect | null>(null)
  const [showVolume, setShowVolume]                 = useState(true)
  const [showRSI, setShowRSI]                       = useState(false)
  const [rsiPeriod, setRsiPeriod]                   = useState(14)
  const [showRSIPeriodInput, setShowRSIPeriodInput] = useState(false)
  const [loading, setLoading]                       = useState(true)
  const [ohlc, setOhlc]                             = useState<Candle | null>(null)

  // Close EMA period dropdown on outside click
  useEffect(() => {
    if (!showPeriodInput) return
    const handler = () => setShowPeriodInput(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPeriodInput])

  // Close RSI period dropdown on outside click
  useEffect(() => {
    if (!showRSIPeriodInput) return
    const handler = () => setShowRSIPeriodInput(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showRSIPeriodInput])

  const calcEMA = (data: Candle[], period: number) => {
    const k = 2 / (period + 1)
    let prev = data[0]?.close || 0
    return data.map(d => {
      prev = d.close * k + prev * (1 - k)
      return { time: d.time as any, value: prev }
    })
  }

  const calcRSI = (data: Candle[], period: number) => {
    const rsi: { time: any; value: number }[] = []
    if (data.length < period + 1) return rsi

    let gains = 0, losses = 0
    for (let i = 1; i <= period; i++) {
      const change = data[i].close - data[i - 1].close
      if (change > 0) gains += change
      else losses -= change
    }
    let avgGain = gains / period
    let avgLoss = losses / period

    for (let i = period + 1; i < data.length; i++) {
      const change = data[i].close - data[i - 1].close
      const gain = change > 0 ? change : 0
      const loss = change < 0 ? -change : 0
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
      rsi.push({ time: data[i].time as any, value: 100 - 100 / (1 + rs) })
    }
    return rsi
  }

  // Main chart height: subtract toolbar (50px) and RSI pane if visible
  const mainChartH = height - 50 - (showRSI ? RSI_HEIGHT + 1 : 0)

  useEffect(() => {
    if (loadingRef.current) return
    loadingRef.current = true

    let cancelled = false

    const init = async () => {
      if (!containerRef.current) { loadingRef.current = false; return }

      // Destroy existing charts
      if (chartRef.current) {
        try { chartRef.current.remove() } catch {}
        chartRef.current = null
      }
      if (rsiChartRef.current) {
        try { rsiChartRef.current.remove() } catch {}
        rsiChartRef.current = null
      }

      setLoading(true)

      try {
        const {
          createChart,
          CandlestickSeries,
          LineSeries,
          HistogramSeries,
          ColorType,
          CrosshairMode,
        } = await import('lightweight-charts')

        if (cancelled) { loadingRef.current = false; return }

        const res = await fetch(
          `${API_URL}/market/candles/${encodeURIComponent(symbol)}?interval=${selectedInterval}&limit=500`
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const candles: Candle[] = await res.json()

        if (cancelled || !containerRef.current) { loadingRef.current = false; return }
        if (!candles || candles.length === 0) {
          setLoading(false)
          loadingRef.current = false
          return
        }

        setOhlc(candles[candles.length - 1])

        // ── Main chart ────────────────────────────────────────────────
        const chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: mainChartH,
          layout: {
            background: { type: ColorType.Solid, color: '#0a0a0f' },
            textColor: '#9ca3af',
          },
          grid: {
            vertLines: { color: 'rgba(26,26,46,0.6)' },
            horzLines: { color: 'rgba(26,26,46,0.6)' },
          },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: '#1a1a2e' },
          timeScale: {
            borderColor: '#1a1a2e',
            timeVisible: true,
            secondsVisible: false,
          },
        })
        chartRef.current = chart

        // Candlesticks
        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#00d4aa', downColor: '#ef4444',
          borderUpColor: '#00d4aa', borderDownColor: '#ef4444',
          wickUpColor: '#00d4aa', wickDownColor: '#ef4444',
        })
        candleSeries.setData(candles.map(c => ({
          time: c.time as any, open: c.open, high: c.high, low: c.low, close: c.close,
        })))

        // Volume histogram
        if (showVolume) {
          const volSeries = chart.addSeries(HistogramSeries, {
            color: 'rgba(0,212,170,0.3)',
            priceFormat: { type: 'volume' as const },
            priceScaleId: 'vol',
          })
          chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
          volSeries.setData(candles.map(c => ({
            time: c.time as any,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(0,212,170,0.3)' : 'rgba(239,68,68,0.3)',
          })))
        }

        // EMA
        if (showEMA) {
          const emaSeries = chart.addSeries(LineSeries, {
            color: '#f59e0b', lineWidth: 1 as const, priceLineVisible: false,
          })
          emaSeries.setData(calcEMA(candles, emaPeriod))
        }

        // Crosshair OHLC
        chart.subscribeCrosshairMove((param: any) => {
          if (!param.time) return
          const data = param.seriesData?.get(candleSeries)
          if (data && data.open !== undefined) {
            setOhlc({ time: param.time, open: data.open, high: data.high, low: data.low, close: data.close, volume: 0 })
          }
        })

        chart.timeScale().fitContent()

        // ── RSI chart ─────────────────────────────────────────────────
        if (showRSI && rsiContainerRef.current) {
          const rsiChart = createChart(rsiContainerRef.current, {
            width: rsiContainerRef.current.clientWidth,
            height: RSI_HEIGHT,
            layout: {
              background: { type: ColorType.Solid, color: '#0a0a0f' },
              textColor: '#9ca3af',
            },
            grid: {
              vertLines: { color: 'rgba(26,26,46,0.4)' },
              horzLines: { color: 'rgba(26,26,46,0.4)' },
            },
            rightPriceScale: {
              borderColor: '#1a1a2e',
              scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: { borderColor: '#1a1a2e', visible: false },
            crosshair: { mode: CrosshairMode.Normal },
          })
          rsiChartRef.current = rsiChart

          // RSI line
          const rsiSeries = rsiChart.addSeries(LineSeries, {
            color: '#a78bfa', lineWidth: 1 as const, priceLineVisible: false,
          })
          rsiSeries.setData(calcRSI(candles, rsiPeriod))

          // Overbought (70)
          const ob = rsiChart.addSeries(LineSeries, {
            color: 'rgba(239,68,68,0.5)', lineWidth: 1 as const,
            lineStyle: 2, priceLineVisible: false,
          })
          ob.setData(candles.slice(rsiPeriod + 1).map(c => ({ time: c.time as any, value: 70 })))

          // Oversold (30)
          const os = rsiChart.addSeries(LineSeries, {
            color: 'rgba(0,212,170,0.5)', lineWidth: 1 as const,
            lineStyle: 2, priceLineVisible: false,
          })
          os.setData(candles.slice(rsiPeriod + 1).map(c => ({ time: c.time as any, value: 30 })))

          // Sync time scales bidirectionally
          chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (range) rsiChart.timeScale().setVisibleLogicalRange(range)
          })
          rsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (range) chart.timeScale().setVisibleLogicalRange(range)
          })

          // RSI resize observer
          const rsiRO = new ResizeObserver(() => {
            if (rsiContainerRef.current && rsiChartRef.current) {
              rsiChartRef.current.applyOptions({ width: rsiContainerRef.current.clientWidth })
            }
          })
          rsiRO.observe(rsiContainerRef.current)
        }

        // Main chart resize observer
        const observer = new ResizeObserver(() => {
          if (containerRef.current && chartRef.current) {
            chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
          }
        })
        observer.observe(containerRef.current)

      } catch (e) {
        console.error('HLChart error:', e)
      } finally {
        setLoading(false)
        loadingRef.current = false
      }
    }

    init()

    return () => {
      cancelled = true
      if (chartRef.current) {
        try { chartRef.current.remove() } catch {}
        chartRef.current = null
      }
      if (rsiChartRef.current) {
        try { rsiChartRef.current.remove() } catch {}
        rsiChartRef.current = null
      }
      loadingRef.current = false
    }
  }, [symbol, selectedInterval, showEMA, emaPeriod, showVolume, showRSI, rsiPeriod, mainChartH])

  const fmtPrice = (n: number) =>
    n?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) || '—'

  return (
    <div style={{ background: '#0a0a0f', borderRadius: '8px', overflow: 'hidden' }}>
      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 12px', borderBottom: '1px solid #1a1a2e',
        gap: '12px', minHeight: '44px', boxSizing: 'border-box',
      }}>
        {/* Left: symbol + OHLC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span style={{ color: 'white', fontWeight: '700', fontSize: '13px' }}>{symbol}</span>
          {ohlc && (
            <span style={{ fontSize: '11px', color: '#6b7280', display: 'flex', gap: '6px' }}>
              <span>O<span style={{ color: 'white' }}>{fmtPrice(ohlc.open)}</span></span>
              <span>H<span style={{ color: '#00d4aa' }}>{fmtPrice(ohlc.high)}</span></span>
              <span>L<span style={{ color: '#ef4444' }}>{fmtPrice(ohlc.low)}</span></span>
              <span>C<span style={{ color: ohlc.close >= ohlc.open ? '#00d4aa' : '#ef4444' }}>
                {fmtPrice(ohlc.close)}
              </span></span>
            </span>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Interval buttons */}
        <div style={{ display: 'flex', gap: '2px' }}>
          {INTERVALS.map(iv => (
            <button key={iv} onClick={() => setSelectedInterval(iv)} style={{
              padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
              background: selectedInterval === iv ? '#00d4aa' : 'transparent',
              color: selectedInterval === iv ? '#0a0a0f' : '#6b7280',
              border: 'none', borderRadius: '4px', fontWeight: '600',
            }}>{iv}</button>
          ))}
        </div>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', background: '#1a1a2e', flexShrink: 0 }} />

        {/* Indicators */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>

          {/* EMA with period dropdown */}
          <div ref={emaBtnRef} style={{ position: 'relative' }} onMouseDown={e => e.stopPropagation()}>
            <button onClick={() => {
              if (emaBtnRef.current) setEmaBtnRect(emaBtnRef.current.getBoundingClientRect())
              setShowPeriodInput(v => !v)
            }} style={{
              padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
              background: showEMA ? 'rgba(245,158,11,0.15)' : 'transparent',
              color: showEMA ? '#f59e0b' : '#6b7280',
              border: `1px solid ${showEMA ? '#f59e0b' : '#374151'}`,
              borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px',
            }}>
              <span onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
                onClick={e => { e.stopPropagation(); setShowEMA(v => !v) }}>
                EMA
              </span>
              <span style={{
                background: showEMA ? '#f59e0b' : '#374151',
                color: showEMA ? '#0a0a0f' : '#6b7280',
                borderRadius: '3px', padding: '0 4px', fontSize: '10px', fontWeight: '700',
              }}>{emaPeriod}</span>
            </button>
            {null}
          </div>

          {/* VOL toggle */}
          <button onClick={() => setShowVolume(v => !v)} style={{
            padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
            background: showVolume ? 'rgba(0,212,170,0.1)' : 'transparent',
            color: showVolume ? '#00d4aa' : '#6b7280',
            border: `1px solid ${showVolume ? '#00d4aa' : '#374151'}`, borderRadius: '4px',
          }}>VOL</button>

          {/* RSI with period dropdown */}
          <div ref={rsiBtnRef} style={{ position: 'relative' }} onMouseDown={e => e.stopPropagation()}>
            <button onClick={() => {
              if (rsiBtnRef.current) setRsiBtnRect(rsiBtnRef.current.getBoundingClientRect())
              setShowRSIPeriodInput(v => !v)
            }} style={{
              padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
              background: showRSI ? 'rgba(167,139,250,0.15)' : 'transparent',
              color: showRSI ? '#a78bfa' : '#6b7280',
              border: `1px solid ${showRSI ? '#a78bfa' : '#374151'}`,
              borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px',
            }}>
              <span onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
                onClick={e => { e.stopPropagation(); setShowRSI(v => !v) }}>
                RSI
              </span>
              <span style={{
                background: showRSI ? '#a78bfa' : '#374151',
                color: showRSI ? '#0a0a0f' : '#6b7280',
                borderRadius: '3px', padding: '0 4px', fontSize: '10px', fontWeight: '700',
              }}>{rsiPeriod}</span>
            </button>
            {null}
          </div>
        </div>
      </div>

      {/* ── Chart area ────────────────────────────────────────────────── */}
      <div style={{ position: 'relative' }}>
        {loading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0a0a0f',
          }}>
            <span style={{ color: '#6b7280', fontSize: '13px' }}>Loading chart…</span>
          </div>
        )}
        <div ref={containerRef} style={{ width: '100%', height: `${mainChartH}px` }} />
      </div>

      {/* ── RSI pane ──────────────────────────────────────────────────── */}
      {showRSI && (
        <div style={{ borderTop: '1px solid #1a1a2e' }}>
          <div style={{
            padding: '3px 12px', fontSize: '10px', color: '#a78bfa',
            background: '#0a0a0f', display: 'flex', justifyContent: 'space-between',
          }}>
            <span>RSI ({rsiPeriod})</span>
            <span style={{ color: '#4b5563' }}>70 / 30</span>
          </div>
          <div ref={rsiContainerRef} style={{ width: '100%', height: `${RSI_HEIGHT}px` }} />
        </div>
      )}

      {/* ── EMA period portal ─────────────────────────────────────────── */}
      {showPeriodInput && emaBtnRect && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: emaBtnRect.bottom + 4,
            left: emaBtnRect.left,
            zIndex: 99999,
            background: '#0d0d14',
            border: '1px solid #1a1a2e',
            borderRadius: '6px',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            minWidth: '160px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
          <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 600 }}>EMA Period</span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {EMA_PRESETS.map(p => (
              <button key={p}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => { setEmaPeriod(p); setShowPeriodInput(false) }}
                style={{
                  padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
                  background: emaPeriod === p ? '#f59e0b' : '#1a1a2e',
                  color: emaPeriod === p ? '#0a0a0f' : '#9ca3af',
                  border: 'none', borderRadius: '4px',
                }}>{p}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="number" min="2" max="500" value={emaPeriod}
              onMouseDown={e => e.stopPropagation()}
              onChange={e => setEmaPeriod(parseInt(e.target.value) || 20)}
              style={{
                width: '60px', background: '#0a0a0f', border: '1px solid #1a1a2e',
                borderRadius: '4px', color: 'white', padding: '3px 6px', fontSize: '12px', outline: 'none',
              }}
            />
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setShowPeriodInput(false)}
              style={{
                padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
                background: '#00d4aa', color: '#0a0a0f', border: 'none', borderRadius: '4px',
              }}>OK</button>
          </div>
        </div>,
        document.body
      )}

      {/* ── RSI period portal ─────────────────────────────────────────── */}
      {showRSIPeriodInput && rsiBtnRect && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: rsiBtnRect.bottom + 4,
            left: rsiBtnRect.left,
            zIndex: 99999,
            background: '#0d0d14',
            border: '1px solid #1a1a2e',
            borderRadius: '6px',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            minWidth: '160px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
          <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 600 }}>RSI Period</span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {RSI_PRESETS.map(p => (
              <button key={p}
                onMouseDown={e => e.stopPropagation()}
                onClick={() => { setRsiPeriod(p); setShowRSIPeriodInput(false) }}
                style={{
                  padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
                  background: rsiPeriod === p ? '#a78bfa' : '#1a1a2e',
                  color: rsiPeriod === p ? '#0a0a0f' : '#9ca3af',
                  border: 'none', borderRadius: '4px',
                }}>{p}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <input
              type="number" min="2" max="100" value={rsiPeriod}
              onMouseDown={e => e.stopPropagation()}
              onChange={e => setRsiPeriod(parseInt(e.target.value) || 14)}
              style={{
                width: '60px', background: '#0a0a0f', border: '1px solid #1a1a2e',
                borderRadius: '4px', color: 'white', padding: '3px 6px', fontSize: '12px', outline: 'none',
              }}
            />
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setShowRSIPeriodInput(false)}
              style={{
                padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
                background: '#a78bfa', color: '#0a0a0f', border: 'none', borderRadius: '4px',
              }}>OK</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
