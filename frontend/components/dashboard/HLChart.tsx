'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'

const API_URL = process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app'

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

interface Props {
  symbol: string   // full name e.g. "BTC" or "xyz:XYZ100"
  height?: number
}

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function calcEMA(data: Candle[], period: number): { time: number; value: number }[] {
  const k = 2 / (period + 1)
  const ema: { time: number; value: number }[] = []
  let prev = data[0]?.close ?? 0
  for (const d of data) {
    const val = d.close * k + prev * (1 - k)
    prev = val
    ema.push({ time: d.time, value: val })
  }
  return ema
}

export default function HLChart({ symbol, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [interval, setIntervalVal] = useState('15m')
  const [loading, setLoading] = useState(true)
  const [showEMA, setShowEMA] = useState(true)
  const [showVolume, setShowVolume] = useState(true)
  const [lastCandle, setLastCandle] = useState<Candle | null>(null)
  const [error, setError] = useState('')

  const chartH = height - 60  // subtract toolbar height

  const loadChart = useCallback(async () => {
    if (!containerRef.current) return
    setLoading(true)
    setError('')

    // Tear down previous chart + observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    try {
      const { createChart, ColorType, CrosshairMode } = await import('lightweight-charts')

      const res = await fetch(
        `${API_URL}/market/candles/${encodeURIComponent(symbol)}?interval=${interval}&limit=500`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const candles: Candle[] = await res.json()

      if (!candles || candles.length === 0) {
        setError('No candle data available for this market.')
        setLoading(false)
        return
      }

      setLastCandle(candles[candles.length - 1])

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: chartH,
        layout: {
          background: { type: ColorType.Solid, color: '#0a0a0f' },
          textColor: '#9ca3af',
        },
        grid: {
          vertLines: { color: 'rgba(26,26,46,0.8)' },
          horzLines: { color: 'rgba(26,26,46,0.8)' },
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
      candleSeries.setData(candles as any)

      // Volume histogram
      if (showVolume) {
        const volSeries = chart.addHistogramSeries({
          color: 'rgba(0,212,170,0.3)',
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
        })
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
        })
        volSeries.setData(
          candles.map(c => ({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(0,212,170,0.3)' : 'rgba(239,68,68,0.3)',
          })) as any
        )
      }

      // EMA 20
      if (showEMA) {
        const emaSeries = chart.addLineSeries({
          color: '#f59e0b',
          lineWidth: 1,
          priceLineVisible: false,
        })
        emaSeries.setData(calcEMA(candles, 20) as any)
      }

      chart.timeScale().fitContent()

      // Resize observer
      const ro = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({
            width: containerRef.current.clientWidth,
          })
        }
      })
      ro.observe(containerRef.current)
      resizeObserverRef.current = ro
    } catch (e: any) {
      console.error('HLChart error:', e)
      setError(e?.message || 'Failed to load chart.')
    } finally {
      setLoading(false)
    }
  }, [symbol, interval, chartH, showEMA, showVolume])

  useEffect(() => {
    loadChart()
    return () => {
      resizeObserverRef.current?.disconnect()
      chartRef.current?.remove()
      chartRef.current = null
    }
  }, [loadChart])

  const ohlcColor = lastCandle
    ? lastCandle.close >= lastCandle.open ? '#00d4aa' : '#ef4444'
    : '#9ca3af'

  return (
    <div style={{ background: '#0a0a0f', position: 'relative' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '8px 12px', borderBottom: '1px solid #1a1a2e', height: '44px',
        boxSizing: 'border-box',
      }}>
        <span style={{ color: 'white', fontWeight: '700', fontSize: '13px' }}>
          {symbol}
        </span>

        {lastCandle && (
          <span style={{ fontSize: '11px', color: ohlcColor, fontVariantNumeric: 'tabular-nums' }}>
            O:{lastCandle.open.toFixed(2)}&nbsp;
            H:{lastCandle.high.toFixed(2)}&nbsp;
            L:{lastCandle.low.toFixed(2)}&nbsp;
            C:{lastCandle.close.toFixed(2)}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {INTERVALS.map(iv => (
            <button key={iv} onClick={() => setIntervalVal(iv)} style={{
              padding: '2px 7px', fontSize: '11px', cursor: 'pointer', border: 'none',
              borderRadius: '4px',
              background: interval === iv ? '#00d4aa' : '#1a1a2e',
              color: interval === iv ? '#0a0a0f' : '#6b7280',
            }}>{iv}</button>
          ))}

          <button onClick={() => setShowEMA(v => !v)} style={{
            padding: '2px 7px', fontSize: '11px', cursor: 'pointer', borderRadius: '4px',
            background: showEMA ? 'rgba(245,158,11,0.2)' : '#1a1a2e',
            color: showEMA ? '#f59e0b' : '#6b7280',
            border: `1px solid ${showEMA ? '#f59e0b' : '#1a1a2e'}`,
          }}>EMA20</button>

          <button onClick={() => setShowVolume(v => !v)} style={{
            padding: '2px 7px', fontSize: '11px', cursor: 'pointer', borderRadius: '4px',
            background: showVolume ? 'rgba(0,212,170,0.1)' : '#1a1a2e',
            color: showVolume ? '#00d4aa' : '#6b7280',
            border: `1px solid ${showVolume ? '#00d4aa' : '#1a1a2e'}`,
          }}>VOL</button>
        </div>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: '44px', bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0a0a0f', zIndex: 10,
        }}>
          <span style={{ color: '#6b7280', fontSize: '13px' }}>Loading chart…</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div style={{
          height: chartH, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: '6px',
        }}>
          <span style={{ fontSize: '20px' }}>📊</span>
          <span style={{ color: '#6b7280', fontSize: '13px' }}>{error}</span>
        </div>
      )}

      {/* Chart canvas */}
      <div ref={containerRef} style={{ width: '100%', height: `${chartH}px` }} />
    </div>
  )
}
