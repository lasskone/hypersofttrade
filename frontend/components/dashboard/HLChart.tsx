'use client'
import { useEffect, useRef, useState } from 'react'
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
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [interval, setIntervalVal] = useState('15m')
  const [loading, setLoading] = useState(true)
  const [showEMA, setShowEMA] = useState(true)
  const [showVolume, setShowVolume] = useState(true)
  const [lastCandle, setLastCandle] = useState<Candle | null>(null)
  const [error, setError] = useState('')

  // Keep latest values accessible inside async callback without re-triggering effect
  const showEMARef = useRef(showEMA)
  const showVolumeRef = useRef(showVolume)
  showEMARef.current = showEMA
  showVolumeRef.current = showVolume

  const toolbarH = 44
  const chartH = height - toolbarH

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      if (!containerRef.current) return

      // Always destroy existing chart + observer first
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
        candleSeriesRef.current = null
      }

      setLoading(true)
      setError('')

      try {
        const { createChart, ColorType, CrosshairMode } = await import('lightweight-charts')
        if (cancelled || !containerRef.current) return

        const res = await fetch(
          `${API_URL}/market/candles/${encodeURIComponent(symbol)}?interval=${interval}&limit=500`
        )
        if (cancelled) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const candles: Candle[] = await res.json()

        if (!candles || candles.length === 0) {
          setError('No candle data available for this market.')
          setLoading(false)
          return
        }

        if (cancelled || !containerRef.current) return

        setLastCandle(candles[candles.length - 1])

        const chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: chartH,
          layout: {
            background: { type: ColorType.Solid, color: '#0a0a0f' },
            textColor: '#9ca3af',
          },
          grid: {
            vertLines: { color: 'rgba(26,26,46,0.5)' },
            horzLines: { color: 'rgba(26,26,46,0.5)' },
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
        candleSeriesRef.current = candleSeries

        // Volume histogram — 15% of chart height
        if (showVolumeRef.current) {
          const volSeries = chart.addHistogramSeries({
            color: 'rgba(0,212,170,0.3)',
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
          })
          chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.85, bottom: 0 },
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
        if (showEMARef.current) {
          const emaSeries = chart.addLineSeries({
            color: '#f59e0b',
            lineWidth: 1,
            priceLineVisible: false,
          })
          emaSeries.setData(calcEMA(candles, 20) as any)
        }

        chart.timeScale().fitContent()

        // Crosshair hover → update OHLC display
        chart.subscribeCrosshairMove((param) => {
          if (!param.time || !candleSeriesRef.current) return
          const data = param.seriesData.get(candleSeriesRef.current)
          if (data && 'open' in data) {
            setLastCandle(data as Candle)
          }
        })

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
        if (!cancelled) {
          console.error('HLChart error:', e)
          setError(e?.message || 'Failed to load chart.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()

    return () => {
      cancelled = true
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
        candleSeriesRef.current = null
      }
    }
  }, [symbol, interval, showEMA, showVolume, chartH])

  const ohlcColor = lastCandle
    ? lastCandle.close >= lastCandle.open ? '#00d4aa' : '#ef4444'
    : '#9ca3af'

  return (
    <div style={{ background: '#0a0a0f', position: 'relative' }}>
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', minHeight: `${toolbarH}px`,
        padding: '0 12px', borderBottom: '1px solid #1a1a2e',
        boxSizing: 'border-box', gap: '10px', overflowX: 'auto',
      }}>
        {/* Left: symbol + OHLC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <span style={{ color: 'white', fontWeight: '700', fontSize: '13px' }}>
            {symbol}
          </span>
          {lastCandle && (
            <span style={{ fontSize: '11px', color: ohlcColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              O:{lastCandle.open.toFixed(2)}&nbsp;
              H:{lastCandle.high.toFixed(2)}&nbsp;
              L:{lastCandle.low.toFixed(2)}&nbsp;
              C:{lastCandle.close.toFixed(2)}
            </span>
          )}
        </div>

        {/* Right: timeframe buttons | indicator toggles */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {/* Group 1: timeframes */}
          {INTERVALS.map(iv => (
            <button key={iv} onClick={() => setIntervalVal(iv)} style={{
              padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
              border: 'none', borderRadius: '4px',
              background: interval === iv ? '#00d4aa' : '#1a1a2e',
              color: interval === iv ? '#0a0a0f' : '#6b7280',
              fontWeight: interval === iv ? '700' : '400',
            }}>{iv}</button>
          ))}

          {/* Divider */}
          <div style={{ width: '1px', height: '18px', background: '#1a1a2e', margin: '0 4px' }} />

          {/* Group 2: indicators */}
          <button onClick={() => setShowEMA(v => !v)} style={{
            padding: '4px 10px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px',
            background: showEMA ? 'rgba(245,158,11,0.15)' : 'transparent',
            color: showEMA ? '#f59e0b' : '#6b7280',
            border: `1px solid ${showEMA ? '#f59e0b' : '#374151'}`,
          }}>EMA20</button>

          <button onClick={() => setShowVolume(v => !v)} style={{
            padding: '4px 10px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px',
            background: showVolume ? 'rgba(0,212,170,0.1)' : 'transparent',
            color: showVolume ? '#00d4aa' : '#6b7280',
            border: `1px solid ${showVolume ? '#00d4aa' : '#374151'}`,
          }}>VOL</button>
        </div>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: `${toolbarH}px`, bottom: 0,
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
