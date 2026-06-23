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
  initialInterval?: string
  positions?: Array<{
    symbol: string
    side: string
    entry_price: number
    size: number
    unrealized_pnl: number
    mark_price: number
    tp_price?: number
    sl_price?: number
  }>
  openOrders?: Array<{
    coin: string
    side: string
    price?: number
    limitPx?: number
    sz?: number
    size?: number
    order_type?: string
    type?: string
    isTrigger?: boolean
  }>
}

export default function HLChart({ symbol, height = 420, initialInterval, positions = [], openOrders = [] }: Props) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const chartRef        = useRef<any>(null)
  const rsiContainerRef = useRef<HTMLDivElement>(null)
  const rsiChartRef     = useRef<any>(null)
  const loadingRef      = useRef(false)
  const candleSeriesRef = useRef<any>(null)
  const emaSeriesRef    = useRef<any>(null)
  const volSeriesRef    = useRef<any>(null)
  const rsiSeriesRef    = useRef<any>(null)
  const candleDataRef   = useRef<any[]>([])
  const priceLineRefs      = useRef<any[]>([])
  const tpslOrderLinesRef  = useRef<any[]>([])
  const wsRef              = useRef<WebSocket | null>(null)
  const wsReconnectRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveDebounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isProgrammaticRef  = useRef(false)

  const [selectedInterval, setSelectedInterval]     = useState(initialInterval ?? '15m')

  // When a position is clicked in Overview, initialInterval prop updates — sync it
  useEffect(() => {
    if (initialInterval) setSelectedInterval(initialInterval)
  }, [initialInterval])
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
  const [chartReady, setChartReady]                 = useState(false)
  const [timeRemaining, setTimeRemaining]           = useState('')

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
        if (!Array.isArray(candles) || candles.length === 0) {
          setLoading(false)
          loadingRef.current = false
          return
        }

        setOhlc(candles[candles.length - 1])
        candleDataRef.current = candles

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
        candleSeriesRef.current = candleSeries

        // Crosshair OHLC
        chart.subscribeCrosshairMove((param: any) => {
          if (!param.time) return
          const data = param.seriesData?.get(candleSeries)
          if (data && data.open !== undefined) {
            setOhlc({ time: param.time, open: data.open, high: data.high, low: data.low, close: data.close, volume: 0 })
          }
        })

        // ── Restore saved viewport or fit all candles ────────────────
        const rangeKey = `hlchart_range_${symbol}_${selectedInterval}`
        let restored = false
        try {
          const saved = localStorage.getItem(rangeKey)
          console.log('[HLChart restore] key:', rangeKey, '| raw localStorage value:', saved)
          if (saved) {
            const r = JSON.parse(saved)
            if (typeof r.from === 'number' && typeof r.to === 'number' &&
                isFinite(r.from) && isFinite(r.to) && r.from < r.to) {
              const clampedFrom = Math.max(0, r.from)
              const clampedTo   = Math.min(candles.length - 1, r.to)
              if (clampedTo - clampedFrom >= 10) {
                isProgrammaticRef.current = true
                chart.timeScale().setVisibleLogicalRange({ from: clampedFrom, to: clampedTo })
                setTimeout(() => { isProgrammaticRef.current = false }, 0)
                restored = true
                console.log('[HLChart restore] ✅ applied range:', { from: clampedFrom, to: clampedTo })
              } else {
                console.log('[HLChart restore] ❌ range too narrow after clamp:', { clampedFrom, clampedTo })
              }
            } else {
              console.log('[HLChart restore] ❌ invalid range values in storage:', r)
            }
          }
        } catch (e) {
          console.log('[HLChart restore] ❌ parse error:', e)
        }
        if (!restored) {
          isProgrammaticRef.current = true
          chart.timeScale().fitContent()
          setTimeout(() => { isProgrammaticRef.current = false }, 0)
          console.log('[HLChart restore] → fallback: fitContent()')
        }

        // Save viewport on scroll/zoom — debounced 500ms
        const saveRangeHandler = (range: any) => {
          console.log('[HLChart save] subscribeVisibleLogicalRangeChange fired, range arg:', range,
            '| getVisibleLogicalRange():', chart.timeScale().getVisibleLogicalRange?.())
          if (!range) return
          if (isProgrammaticRef.current) return  // skip saves triggered by fitContent/setVisibleLogicalRange
          if (saveDebounceRef.current !== null) clearTimeout(saveDebounceRef.current)
          saveDebounceRef.current = setTimeout(() => {
            try { localStorage.setItem(rangeKey, JSON.stringify(range)) } catch {}
          }, 500)
        }
        chart.timeScale().subscribeVisibleLogicalRangeChange(saveRangeHandler)

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
          rsiSeriesRef.current = rsiSeries

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
        setChartReady(true)
        setLoading(false)
        loadingRef.current = false
      }
    }

    init()

    return () => {
      cancelled = true
      // Synchronously flush the current range before debounce is cancelled and chart destroyed
      try {
        if (chartRef.current) {
          const rangeToSave = chartRef.current.timeScale().getVisibleLogicalRange()
          if (rangeToSave && isFinite(rangeToSave.from) && isFinite(rangeToSave.to)) {
            localStorage.setItem(
              `hlchart_range_${symbol}_${selectedInterval}`,
              JSON.stringify(rangeToSave)
            )
          }
        }
      } catch {}
      if (saveDebounceRef.current !== null) {
        clearTimeout(saveDebounceRef.current)
        saveDebounceRef.current = null
      }
      setChartReady(false)
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
  }, [symbol, selectedInterval])

  // EMA series — add/remove without rebuilding chart
  useEffect(() => {
    if (!chartReady || !chartRef.current || !candleDataRef.current.length) return

    if (emaSeriesRef.current) {
      try { chartRef.current.removeSeries(emaSeriesRef.current) } catch {}
      emaSeriesRef.current = null
    }

    if (showEMA) {
      import('lightweight-charts').then(({ LineSeries }) => {
        if (!chartRef.current) return
        const s = chartRef.current.addSeries(LineSeries, {
          color: '#f59e0b', lineWidth: 1, priceLineVisible: false,
        })
        s.setData(calcEMA(candleDataRef.current, emaPeriod))
        emaSeriesRef.current = s
      })
    }
  }, [showEMA, emaPeriod, chartReady])

  // Volume series — add/remove without rebuilding chart
  useEffect(() => {
    if (!chartReady || !chartRef.current || !candleDataRef.current.length) return

    if (volSeriesRef.current) {
      try { chartRef.current.removeSeries(volSeriesRef.current) } catch {}
      volSeriesRef.current = null
    }

    if (showVolume) {
      import('lightweight-charts').then(({ HistogramSeries }) => {
        if (!chartRef.current) return
        const s = chartRef.current.addSeries(HistogramSeries, {
          color: 'rgba(0,212,170,0.3)',
          priceFormat: { type: 'volume' },
          priceScaleId: 'vol',
        })
        chartRef.current.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
        s.setData(candleDataRef.current.map((c: any) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(0,212,170,0.3)' : 'rgba(239,68,68,0.3)',
        })))
        volSeriesRef.current = s
      })
    }
  }, [showVolume, chartReady])

  // RSI period — update data without rebuilding
  useEffect(() => {
    if (!rsiChartRef.current || !candleDataRef.current.length || !rsiSeriesRef.current) return
    rsiSeriesRef.current.setData(calcRSI(candleDataRef.current, rsiPeriod))
  }, [rsiPeriod, chartReady])

  // Height — resize without rebuilding
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.applyOptions({ height: mainChartH })
    }
  }, [mainChartH])

  // showRSI — create/destroy RSI chart without rebuilding main chart
  useEffect(() => {
    if (!chartReady || !chartRef.current) return
    if (candleDataRef.current.length > 0) {
      if (rsiChartRef.current) {
        try { rsiChartRef.current.remove() } catch {}
        rsiChartRef.current = null
        rsiSeriesRef.current = null
      }
      if (showRSI && rsiContainerRef.current) {
        import('lightweight-charts').then(({ createChart, LineSeries, ColorType, CrosshairMode }) => {
          if (!rsiContainerRef.current || !chartRef.current) return
          const rsiChart = createChart(rsiContainerRef.current, {
            width: rsiContainerRef.current.clientWidth,
            height: RSI_HEIGHT,
            layout: { background: { type: ColorType.Solid, color: '#0a0a0f' }, textColor: '#9ca3af' },
            grid: { vertLines: { color: 'rgba(26,26,46,0.4)' }, horzLines: { color: 'rgba(26,26,46,0.4)' } },
            rightPriceScale: { borderColor: '#1a1a2e', scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { borderColor: '#1a1a2e', visible: false },
            crosshair: { mode: CrosshairMode.Normal },
          })
          rsiChartRef.current = rsiChart
          const s = rsiChart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 1, priceLineVisible: false })
          s.setData(calcRSI(candleDataRef.current, rsiPeriod))
          rsiSeriesRef.current = s
          const ob = rsiChart.addSeries(LineSeries, { color: 'rgba(239,68,68,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false })
          ob.setData(candleDataRef.current.slice(rsiPeriod + 1).map((c: any) => ({ time: c.time, value: 70 })))
          const os = rsiChart.addSeries(LineSeries, { color: 'rgba(0,212,170,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false })
          os.setData(candleDataRef.current.slice(rsiPeriod + 1).map((c: any) => ({ time: c.time, value: 30 })))
          chartRef.current.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
            if (range) rsiChart.timeScale().setVisibleLogicalRange(range)
          })
          rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
            if (range && chartRef.current) chartRef.current.timeScale().setVisibleLogicalRange(range)
          })
        })
      }
    }
  }, [showRSI, chartReady])

  // ── Position lines ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartReady || !chartRef.current || !candleSeriesRef.current) return

    // Remove ALL existing price lines
    priceLineRefs.current.forEach(pl => {
      try { candleSeriesRef.current?.removePriceLine(pl) } catch {}
    })
    priceLineRefs.current = []

    if (!positions || positions.length === 0) return

    // Filter positions matching current symbol (handle both "BTC" and "xyz:XYZ100")
    const matchingPositions = positions.filter(p => {
      const posSymbol = String(p.symbol ?? '')
      const chartSymbol = String(symbol ?? '')
      return posSymbol === chartSymbol ||
        posSymbol.split(':').pop() === chartSymbol ||
        chartSymbol.split(':').pop() === posSymbol
    })

    matchingPositions.forEach(pos => {
      const isLong = parseFloat(String(pos.size)) > 0
      const entryPrice = parseFloat(String(pos.entry_price))
      const pnl = parseFloat(String(pos.unrealized_pnl ?? 0))
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`

      if (!entryPrice || entryPrice <= 0) return

      const pnlColor = pnl >= 0 ? '#10b981' : '#ef4444'
      const pl = candleSeriesRef.current.createPriceLine({
        price: entryPrice,
        color: pnlColor,
        lineWidth: 1,
        lineStyle: 1,
        axisLabelVisible: true,
        title: `${isLong ? '▲ LONG' : '▼ SHORT'} ${pnlStr}`,
      })
      priceLineRefs.current.push(pl)
    })
  }, [chartReady, positions, symbol])

  // ── TP / SL / limit order lines ────────────────────────────────────────────
  useEffect(() => {
    if (!chartReady || !chartRef.current || !candleSeriesRef.current) return

    tpslOrderLinesRef.current.forEach(pl => {
      try { candleSeriesRef.current?.removePriceLine(pl) } catch {}
    })
    tpslOrderLinesRef.current = []

    const coinShort = (s: string) => s.split(':').pop() ?? s
    const matches = (coin: string) => {
      const c = String(coin ?? '')
      const s = String(symbol ?? '')
      return c === s || coinShort(c) === s || c === coinShort(s)
    }

    // TP / SL from positions
    positions.forEach(pos => {
      if (!matches(pos.symbol)) return
      if (pos.tp_price && pos.tp_price > 0) {
        const pl = candleSeriesRef.current.createPriceLine({
          price: pos.tp_price,
          color: '#26a69a',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `TP ${coinShort(pos.symbol)} $${pos.tp_price}`,
        })
        tpslOrderLinesRef.current.push(pl)
      }
      if (pos.sl_price && pos.sl_price > 0) {
        const pl = candleSeriesRef.current.createPriceLine({
          price: pos.sl_price,
          color: '#ef5350',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `SL ${coinShort(pos.symbol)} $${pos.sl_price}`,
        })
        tpslOrderLinesRef.current.push(pl)
      }
    })

    // Resting limit orders
    openOrders.forEach(o => {
      if (!matches(o.coin)) return
      if (o.isTrigger) return
      const price = parseFloat(String(o.price ?? o.limitPx ?? 0))
      if (!price || price <= 0) return
      const size = parseFloat(String(o.sz ?? o.size ?? 0))
      const side = String(o.side ?? '').toUpperCase()
      const isBuy = side === 'B' || side === 'BUY' || side === 'LONG'
      const pl = candleSeriesRef.current.createPriceLine({
        price,
        color: isBuy ? '#26a69a' : '#ef5350',
        lineWidth: 1,
        lineStyle: 1,
        axisLabelVisible: true,
        title: `${isBuy ? 'Buy' : 'Sell'} ${coinShort(o.coin)} ${size} @ $${price}`,
      })
      tpslOrderLinesRef.current.push(pl)
    })
  }, [chartReady, positions, openOrders, symbol])

  // ── Candle countdown timer ────────────────────────────────────────────────
  useEffect(() => {
    const intervalMs: Record<string, number> = {
      '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '4h': 14400000, '8h': 28800000, '12h': 43200000, '1d': 86400000,
    }
    const ms = intervalMs[selectedInterval] ?? 900000

    const computeRemaining = () => {
      const now = Date.now()
      const candleOpen = Math.floor(now / ms) * ms
      const nextCandle = candleOpen + ms
      const remaining = Math.max(0, nextCandle - now)
      const totalSec = Math.floor(remaining / 1000)
      const hours = Math.floor(totalSec / 3600)
      const mins = Math.floor((totalSec % 3600) / 60)
      const secs = totalSec % 60
      const pad = (n: number) => String(n).padStart(2, '0')
      return ms >= 3600000
        ? `${hours}:${pad(mins)}:${pad(secs)}`
        : `${pad(mins)}:${pad(secs)}`
    }

    setTimeRemaining(computeRemaining())
    const timer = setInterval(() => setTimeRemaining(computeRemaining()), 1000)
    return () => clearInterval(timer)
  }, [selectedInterval])

  // ── Real-time candle updates via Hyperliquid WebSocket ───────────────────
  useEffect(() => {
    if (!chartReady) return

    let destroyed = false

    const connect = () => {
      if (destroyed) return

      const ws = new WebSocket('wss://api.hyperliquid.xyz/ws')
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'candle', coin: symbol, interval: selectedInterval },
        }))
      }

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.channel !== 'candle') return
          const data = msg.data
          if (!data || data.isSnapshot === true) return

          const barTime = data.t / 1000
          const bar = {
            time: barTime as any,
            open:  Number(data.o),
            high:  Number(data.h),
            low:   Number(data.l),
            close: Number(data.c),
          }

          if (candleSeriesRef.current) {
            candleSeriesRef.current.update(bar)
          }

          // Keep candleDataRef in sync: replace last if same candle, else append
          const arr = candleDataRef.current
          if (arr.length > 0 && arr[arr.length - 1].time === barTime) {
            arr[arr.length - 1] = {
              ...arr[arr.length - 1],
              open: bar.open, high: bar.high, low: bar.low, close: bar.close,
              volume: Number(data.v),
            }
          } else {
            arr.push({ time: barTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: Number(data.v) })
          }

          setOhlc({ time: barTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: Number(data.v) })
        } catch {}
      }

      ws.onerror = () => { ws.close() }

      ws.onclose = () => {
        if (destroyed) return
        wsReconnectRef.current = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (wsReconnectRef.current !== null) {
        clearTimeout(wsReconnectRef.current)
        wsReconnectRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [symbol, selectedInterval, chartReady])

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

        {/* Candle countdown timer */}
        {timeRemaining && (
          <div style={{
            background: 'rgba(30,30,30,0.85)',
            border: '1px solid rgba(38,166,154,0.4)',
            color: '#26a69a',
            fontFamily: 'monospace', fontSize: '13px', fontWeight: 600,
            padding: '4px 10px', borderRadius: '6px', flexShrink: 0,
          }}>
            ⏱ {selectedInterval} {timeRemaining}
          </div>
        )}

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
            right: typeof window !== 'undefined' ? window.innerWidth - emaBtnRect.right : 0,
            left: 'auto',
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
            right: typeof window !== 'undefined' ? window.innerWidth - rsiBtnRect.right : 0,
            left: 'auto',
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
