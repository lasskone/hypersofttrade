'use client'
import { useEffect, useRef, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app'

const INTERVALS = ['1m','5m','15m','30m','1h','4h','1d']

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
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)
  const [selectedInterval, setSelectedInterval] = useState('15m')
  const [showEMA, setShowEMA] = useState(true)
  const [showVolume, setShowVolume] = useState(true)
  const [loading, setLoading] = useState(true)
  const [ohlc, setOhlc] = useState<Candle | null>(null)
  const loadingRef = useRef(false)

  const calcEMA = (data: Candle[], period: number) => {
    const k = 2 / (period + 1)
    let prev = data[0]?.close || 0
    return data.map(d => {
      prev = d.close * k + prev * (1 - k)
      return { time: d.time as any, value: prev }
    })
  }

  useEffect(() => {
    // Prevent concurrent loads
    if (loadingRef.current) return
    loadingRef.current = true

    let cancelled = false

    const init = async () => {
      if (!containerRef.current) {
        loadingRef.current = false
        return
      }

      // Destroy existing chart
      if (chartRef.current) {
        try { chartRef.current.remove() } catch {}
        chartRef.current = null
      }

      setLoading(true)

      try {
        const { createChart, ColorType, CrosshairMode } = await import('lightweight-charts')

        if (cancelled) { loadingRef.current = false; return }

        const res = await fetch(
          `${API_URL}/market/candles/${encodeURIComponent(symbol)}?interval=${selectedInterval}&limit=500`
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const candles: Candle[] = await res.json()

        if (cancelled || !containerRef.current) { loadingRef.current = false; return }
        if (!candles || candles.length === 0) { setLoading(false); loadingRef.current = false; return }

        setOhlc(candles[candles.length - 1])

        const chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: height - 50,
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

        // Candlestick series
        const candleSeries = chart.addCandlestickSeries({
          upColor: '#00d4aa',
          downColor: '#ef4444',
          borderUpColor: '#00d4aa',
          borderDownColor: '#ef4444',
          wickUpColor: '#00d4aa',
          wickDownColor: '#ef4444',
        })
        candleSeries.setData(candles.map(c => ({
          time: c.time as any,
          open: c.open, high: c.high,
          low: c.low, close: c.close,
        })))

        // Volume
        if (showVolume) {
          const volSeries = chart.addHistogramSeries({
            color: 'rgba(0,212,170,0.3)',
            priceFormat: { type: 'volume' as const },
            priceScaleId: 'vol',
          })
          chart.priceScale('vol').applyOptions({
            scaleMargins: { top: 0.85, bottom: 0 },
          })
          volSeries.setData(candles.map(c => ({
            time: c.time as any,
            value: c.volume,
            color: c.close >= c.open
              ? 'rgba(0,212,170,0.3)'
              : 'rgba(239,68,68,0.3)',
          })))
        }

        // EMA20
        if (showEMA) {
          const emaSeries = chart.addLineSeries({
            color: '#f59e0b',
            lineWidth: 1 as const,
            priceLineVisible: false,
          })
          emaSeries.setData(calcEMA(candles, 20))
        }

        // Crosshair tooltip
        chart.subscribeCrosshairMove((param: any) => {
          if (!param.time) return
          const data = param.seriesData?.get(candleSeries)
          if (data && data.open !== undefined) {
            setOhlc({
              time: param.time,
              open: data.open, high: data.high,
              low: data.low, close: data.close,
              volume: 0,
            })
          }
        })

        chart.timeScale().fitContent()

        // Resize
        const observer = new ResizeObserver(() => {
          if (containerRef.current && chartRef.current) {
            chartRef.current.applyOptions({
              width: containerRef.current.clientWidth
            })
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
      loadingRef.current = false
    }
  }, [symbol, selectedInterval, showEMA, showVolume, height])
  // height is stable, symbol/interval/toggles only change on user action

  const fmtPrice = (n: number) => n?.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 4
  }) || '—'

  return (
    <div style={{ background: '#0a0a0f', borderRadius: '8px', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '8px 12px', borderBottom: '1px solid #1a1a2e',
        gap: '12px', minHeight: '44px', overflow: 'hidden'
      }}>
        {/* Symbol + OHLC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span style={{ color: 'white', fontWeight: '700', fontSize: '13px' }}>
            {symbol}
          </span>
          {ohlc && (
            <span style={{ fontSize: '11px', color: '#6b7280', display: 'flex', gap: '6px' }}>
              <span>O<span style={{ color: 'white' }}>{fmtPrice(ohlc.open)}</span></span>
              <span>H<span style={{ color: '#00d4aa' }}>{fmtPrice(ohlc.high)}</span></span>
              <span>L<span style={{ color: '#ef4444' }}>{fmtPrice(ohlc.low)}</span></span>
              <span>C<span style={{
                color: ohlc.close >= ohlc.open ? '#00d4aa' : '#ef4444'
              }}>{fmtPrice(ohlc.close)}</span></span>
            </span>
          )}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Intervals */}
        <div style={{ display: 'flex', gap: '2px' }}>
          {INTERVALS.map(i => (
            <button key={i} onClick={() => setSelectedInterval(i)} style={{
              padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
              background: selectedInterval === i ? '#00d4aa' : 'transparent',
              color: selectedInterval === i ? '#0a0a0f' : '#6b7280',
              border: 'none', borderRadius: '4px', fontWeight: '600',
            }}>{i}</button>
          ))}
        </div>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', background: '#1a1a2e', flexShrink: 0 }} />

        {/* Indicators */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => setShowEMA(v => !v)} style={{
            padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
            background: showEMA ? 'rgba(245,158,11,0.15)' : 'transparent',
            color: showEMA ? '#f59e0b' : '#6b7280',
            border: `1px solid ${showEMA ? '#f59e0b' : '#374151'}`,
            borderRadius: '4px',
          }}>EMA20</button>
          <button onClick={() => setShowVolume(v => !v)} style={{
            padding: '3px 8px', fontSize: '11px', cursor: 'pointer',
            background: showVolume ? 'rgba(0,212,170,0.1)' : 'transparent',
            color: showVolume ? '#00d4aa' : '#6b7280',
            border: `1px solid ${showVolume ? '#00d4aa' : '#374151'}`,
            borderRadius: '4px',
          }}>VOL</button>
        </div>
      </div>

      {/* Chart area */}
      <div style={{ position: 'relative' }}>
        {loading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0a0a0f',
          }}>
            <span style={{ color: '#6b7280', fontSize: '13px' }}>Loading chart...</span>
          </div>
        )}
        <div ref={containerRef} style={{ width: '100%', height: `${height - 50}px` }} />
      </div>
    </div>
  )
}
