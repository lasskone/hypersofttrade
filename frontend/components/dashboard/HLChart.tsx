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

interface DragMeta {
  oid: number
  coin: string
  is_buy: boolean
  sz: number
  order_type: 'limit' | 'tp' | 'sl'
  label: string
}

interface Props {
  symbol: string
  height?: number
  initialInterval?: string
  walletAddress?: string
  szDecimals?: number
  onOrderModified?: () => void
  positions?: Array<{
    symbol: string
    side: string
    entry_price: number
    size: number
    unrealized_pnl: number
    mark_price: number
    tp_price?: number
    sl_price?: number
    tp_orders?: any[]
    sl_orders?: any[]
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
    is_trigger?: boolean
    isTrigger?: boolean
    order_id?: number
  }>
}

export default function HLChart({ symbol, height = 420, initialInterval, walletAddress, szDecimals = 5, onOrderModified, positions = [], openOrders = [] }: Props) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const chartRef        = useRef<any>(null)
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
  const indicatorSaveBlockedRef = useRef(true)
  const isDraggingRef      = useRef(false)
  const dragStartYRef      = useRef(0)
  const dragStartHeightRef = useRef(0)

  // Draggable order-line state
  const draggableLinesRef    = useRef<Array<{ priceLine: any; meta: DragMeta; originalPrice: number; color: string }>>([])
  const orderDragActiveRef   = useRef(false)
  const orderDragLineIdxRef  = useRef(-1)

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
  const [chartHeight, setChartHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return height
    try {
      const saved = localStorage.getItem('hlchart_height')
      if (saved) { const n = parseInt(saved); if (!isNaN(n) && n >= 200 && n <= 800) return n }
    } catch {}
    return height
  })
  const [isDragging, setIsDragging] = useState(false)
  const [ohlc, setOhlc]                             = useState<Candle | null>(null)
  const [chartReady, setChartReady]                 = useState(false)
  const [timeRemaining, setTimeRemaining]           = useState('')
  const [dragConfirm, setDragConfirm] = useState<{ meta: DragMeta; newPrice: number; x: number; y: number } | null>(null)

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

  // Load indicator settings from localStorage when symbol changes
  useEffect(() => {
    indicatorSaveBlockedRef.current = true
    try {
      const saved = localStorage.getItem(`hlchart_indicators_${symbol}`)
      if (saved) {
        const s = JSON.parse(saved)
        if (s.showEMA !== undefined) setShowEMA(Boolean(s.showEMA))
        if (s.emaPeriod !== undefined) setEmaPeriod(Number(s.emaPeriod) || 20)
        if (s.showVol !== undefined) setShowVolume(Boolean(s.showVol))
        if (s.showRSI !== undefined) setShowRSI(Boolean(s.showRSI))
        if (s.rsiPeriod !== undefined) setRsiPeriod(Number(s.rsiPeriod) || 14)
      } else {
        setShowEMA(true); setEmaPeriod(20); setShowVolume(true); setShowRSI(false); setRsiPeriod(14)
      }
    } catch {
      setShowEMA(true); setEmaPeriod(20); setShowVolume(true); setShowRSI(false); setRsiPeriod(14)
    }
    const tid = setTimeout(() => { indicatorSaveBlockedRef.current = false }, 0)
    return () => clearTimeout(tid)
  }, [symbol])

  // Save indicator settings to localStorage whenever they change
  useEffect(() => {
    if (indicatorSaveBlockedRef.current) return
    try {
      localStorage.setItem(`hlchart_indicators_${symbol}`, JSON.stringify({
        showEMA, emaPeriod, showVol: showVolume, showRSI, rsiPeriod,
      }))
    } catch {}
  }, [symbol, showEMA, emaPeriod, showVolume, showRSI, rsiPeriod])

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

  // Total chart height — toolbar is 50px; RSI pane lives inside the chart canvas
  const totalChartH = chartHeight - 50

  useEffect(() => {
    if (loadingRef.current) return
    loadingRef.current = true

    let cancelled = false

    const init = async () => {
      if (!containerRef.current) { loadingRef.current = false; return }

      // Destroy existing chart
      if (chartRef.current) {
        try { chartRef.current.remove() } catch {}
        chartRef.current = null
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
          height: totalChartH,
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

        // Crosshair OHLC update
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
              }
            }
          }
        } catch {}
        if (!restored) {
          isProgrammaticRef.current = true
          chart.timeScale().fitContent()
          setTimeout(() => { isProgrammaticRef.current = false }, 0)
        }

        // Save viewport on scroll/zoom — debounced 500ms
        const saveRangeHandler = (range: any) => {
          if (!range) return
          if (isProgrammaticRef.current) return
          if (saveDebounceRef.current !== null) clearTimeout(saveDebounceRef.current)
          saveDebounceRef.current = setTimeout(() => {
            try { localStorage.setItem(rangeKey, JSON.stringify(range)) } catch {}
          }, 500)
        }
        chart.timeScale().subscribeVisibleLogicalRangeChange(saveRangeHandler)

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
      rsiSeriesRef.current = null
      if (chartRef.current) {
        try { chartRef.current.remove() } catch {}
        chartRef.current = null
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
    if (!chartRef.current || !candleDataRef.current.length || !rsiSeriesRef.current) return
    const rsiData = calcRSI(candleDataRef.current, rsiPeriod)
    rsiSeriesRef.current.setData(rsiData)
  }, [rsiPeriod, chartReady])

  // Height — resize without rebuilding; re-pin RSI pane height if present
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.applyOptions({ height: totalChartH })
      try {
        if (chartRef.current.panes().length > 1) {
          chartRef.current.panes()[1].setHeight(RSI_HEIGHT)
        }
      } catch {}
    }
  }, [totalChartH])

  // RSI — add/remove as pane 1 on the main chart (no separate chart instance)
  useEffect(() => {
    if (!chartReady || !chartRef.current || !candleDataRef.current.length) return

    if (showRSI) {
      import('lightweight-charts').then(({ LineSeries }) => {
        if (!chartRef.current) return

        // Clean up any lingering RSI state
        if (rsiSeriesRef.current) {
          try { chartRef.current.removeSeries(rsiSeriesRef.current) } catch {}
          rsiSeriesRef.current = null
        }
        if (chartRef.current.panes().length > 1) {
          try { chartRef.current.removePane(1) } catch {}
        }

        const rsiData = calcRSI(candleDataRef.current, rsiPeriod)

        // Third argument = pane index 1 — auto-created if absent
        const s = chartRef.current.addSeries(LineSeries, {
          color: '#a78bfa', lineWidth: 1, priceLineVisible: false,
        }, 1)
        s.setData(rsiData)
        rsiSeriesRef.current = s

        // Overbought line (70)
        const ob = chartRef.current.addSeries(LineSeries, {
          color: 'rgba(239,68,68,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false,
        }, 1)
        ob.setData(candleDataRef.current.slice(rsiPeriod + 1).map((c: any) => ({ time: c.time, value: 70 })))

        // Oversold line (30)
        const os = chartRef.current.addSeries(LineSeries, {
          color: 'rgba(0,212,170,0.5)', lineWidth: 1, lineStyle: 2, priceLineVisible: false,
        }, 1)
        os.setData(candleDataRef.current.slice(rsiPeriod + 1).map((c: any) => ({ time: c.time, value: 30 })))

        // Pin RSI pane to exact pixel height
        try {
          if (chartRef.current.panes().length > 1) {
            chartRef.current.panes()[1].setHeight(RSI_HEIGHT)
          }
        } catch {}
      })
    } else {
      // Remove RSI pane — also destroys all series inside it
      rsiSeriesRef.current = null
      if (chartRef.current.panes().length > 1) {
        try { chartRef.current.removePane(1) } catch {}
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
    draggableLinesRef.current = []

    const coinShort = (s: string) => s.split(':').pop() ?? s
    const matches = (coin: string) => {
      const c = String(coin ?? '')
      const s = String(symbol ?? '')
      return c === s || coinShort(c) === s || c === coinShort(s)
    }

    // TP / SL from positions
    positions.forEach(pos => {
      if (!matches(pos.symbol)) return
      const isLong = String(pos.side ?? '').toLowerCase() !== 'short'
      const closeSide = !isLong  // closing a long = sell (is_buy=false); closing a short = buy (is_buy=true)

      if (pos.tp_price && pos.tp_price > 0) {
        const color = '#26a69a'
        const label = `TP ${coinShort(pos.symbol)} $${pos.tp_price}`
        const pl = candleSeriesRef.current.createPriceLine({
          price: pos.tp_price, color,
          lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: label,
        })
        tpslOrderLinesRef.current.push(pl)
        const oid = (pos as any).tp_orders?.[0]?.oid
        if (oid != null) {
          draggableLinesRef.current.push({
            priceLine: pl, originalPrice: pos.tp_price, color,
            meta: { oid, coin: pos.symbol, is_buy: closeSide, sz: pos.size, order_type: 'tp', label },
          })
        }
      }
      if (pos.sl_price && pos.sl_price > 0) {
        const color = '#ef5350'
        const label = `SL ${coinShort(pos.symbol)} $${pos.sl_price}`
        const pl = candleSeriesRef.current.createPriceLine({
          price: pos.sl_price, color,
          lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: label,
        })
        tpslOrderLinesRef.current.push(pl)
        const oid = (pos as any).sl_orders?.[0]?.oid
        if (oid != null) {
          draggableLinesRef.current.push({
            priceLine: pl, originalPrice: pos.sl_price, color,
            meta: { oid, coin: pos.symbol, is_buy: closeSide, sz: pos.size, order_type: 'sl', label },
          })
        }
      }
    })

    // Resting limit orders
    openOrders.forEach(o => {
      if (!matches(o.coin)) return
      if (o.is_trigger || o.isTrigger) return
      const price = parseFloat(String(o.price ?? o.limitPx ?? 0))
      if (!price || price <= 0) return
      const size = parseFloat(String(o.sz ?? o.size ?? 0))
      const side = String(o.side ?? '').toUpperCase()
      const isBuy = side === 'B' || side === 'BUY' || side === 'LONG'
      const color = isBuy ? '#26a69a' : '#ef5350'
      const label = `${isBuy ? 'Buy' : 'Sell'} ${coinShort(o.coin)} ${size} @ $${price}`
      const pl = candleSeriesRef.current.createPriceLine({
        price, color,
        lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: label,
      })
      tpslOrderLinesRef.current.push(pl)
      if (o.order_id != null) {
        draggableLinesRef.current.push({
          priceLine: pl, originalPrice: price, color,
          meta: { oid: o.order_id, coin: o.coin, is_buy: isBuy, sz: size, order_type: 'limit', label },
        })
      }
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

  // ── Chart height drag ────────────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientY - dragStartYRef.current
      setChartHeight(Math.min(800, Math.max(200, dragStartHeightRef.current + delta)))
    }
    const onMouseUp = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
      const delta = e.clientY - dragStartYRef.current
      const newH = Math.min(800, Math.max(200, dragStartHeightRef.current + delta))
      setChartHeight(newH)
      try { localStorage.setItem('hlchart_height', String(newH)) } catch {}
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Drag-to-modify order price lines ────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const HIT_PX = 10  // pixels tolerance for detecting a drag target

    const onMouseDown = (e: MouseEvent) => {
      if (!candleSeriesRef.current) return
      const rect = container.getBoundingClientRect()
      const clickY = e.clientY - rect.top

      for (let i = 0; i < draggableLinesRef.current.length; i++) {
        const entry = draggableLinesRef.current[i]
        const lineY = candleSeriesRef.current.priceToCoordinate(entry.priceLine.options().price)
        if (lineY == null) continue
        if (Math.abs(clickY - lineY) <= HIT_PX) {
          orderDragActiveRef.current = true
          orderDragLineIdxRef.current = i
          e.stopPropagation()  // prevent chart pan
          e.preventDefault()
          return
        }
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!orderDragActiveRef.current) return
      const idx = orderDragLineIdxRef.current
      if (idx < 0 || !candleSeriesRef.current) return
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const y = e.clientY - rect.top
      const newPrice = candleSeriesRef.current.coordinateToPrice(y)
      if (newPrice == null || newPrice <= 0) return
      draggableLinesRef.current[idx].priceLine.applyOptions({ price: newPrice })
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!orderDragActiveRef.current) return
      orderDragActiveRef.current = false
      const idx = orderDragLineIdxRef.current
      orderDragLineIdxRef.current = -1
      if (idx < 0 || !candleSeriesRef.current) return
      const entry = draggableLinesRef.current[idx]
      const finalPrice = entry.priceLine.options().price as number
      if (Math.abs(finalPrice - entry.originalPrice) < 0.0001) return  // no real movement
      setDragConfirm({ meta: entry.meta, newPrice: finalPrice, x: e.clientX, y: e.clientY })
    }

    container.addEventListener('mousedown', onMouseDown, { capture: true })
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      container.removeEventListener('mousedown', onMouseDown, { capture: true } as any)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [chartReady])

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

  const handleDragCancel = () => {
    if (!dragConfirm) return
    // Restore original price on the line
    const entry = draggableLinesRef.current.find(e => e.meta.oid === dragConfirm.meta.oid)
    if (entry) entry.priceLine.applyOptions({ price: entry.originalPrice })
    setDragConfirm(null)
  }

  const handleDragConfirm = async () => {
    if (!dragConfirm || !walletAddress) { setDragConfirm(null); return }
    const { meta, newPrice } = dragConfirm
    setDragConfirm(null)
    try {
      const res = await fetch(`${API_URL}/orders/modify-price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: meta.coin,
          oid: meta.oid,
          new_price: newPrice,
          is_buy: meta.is_buy,
          sz: meta.sz,
          sz_decimals: szDecimals,
          order_type: meta.order_type,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        console.error('[drag-modify] failed', err)
      } else {
        onOrderModified?.()
      }
    } catch (err) {
      console.error('[drag-modify] fetch error', err)
    }
  }

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

      {/* ── Chart area (RSI pane lives inside this canvas) ─────────────── */}
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
        <div ref={containerRef} style={{ width: '100%', height: `${totalChartH}px` }} />
      </div>

      {/* ── Drag handle ───────────────────────────────────────────────── */}
      <div
        onMouseDown={e => {
          isDraggingRef.current = true
          setIsDragging(true)
          dragStartYRef.current = e.clientY
          dragStartHeightRef.current = chartHeight
          e.preventDefault()
        }}
        style={{
          height: 6, width: '100%', cursor: 'row-resize',
          background: isDragging ? 'rgba(38,166,154,0.4)' : 'rgba(255,255,255,0.05)',
          transition: 'background 0.15s',
          flexShrink: 0,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(38,166,154,0.4)' }}
        onMouseLeave={e => { if (!isDraggingRef.current) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)' }}
      />

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

      {/* ── Drag-to-modify confirm portal ────────────────────────────── */}
      {dragConfirm && createPortal(
        <div style={{
          position: 'fixed',
          top: Math.min(dragConfirm.y - 10, typeof window !== 'undefined' ? window.innerHeight - 110 : dragConfirm.y),
          left: Math.min(dragConfirm.x + 12, typeof window !== 'undefined' ? window.innerWidth - 220 : dragConfirm.x),
          zIndex: 99999,
          background: '#0d0d14',
          border: '1px solid #374151',
          borderRadius: '8px',
          padding: '10px 14px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          minWidth: '200px',
        }}>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '6px' }}>
            Move <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{dragConfirm.meta.order_type.toUpperCase()}</span> to{' '}
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>${dragConfirm.newPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>?
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleDragConfirm}
              style={{
                flex: 1, padding: '5px 0', fontSize: '12px', cursor: 'pointer',
                background: '#26a69a', color: '#0a0a0f', border: 'none', borderRadius: '5px', fontWeight: 700,
              }}>Confirm</button>
            <button
              onClick={handleDragCancel}
              style={{
                flex: 1, padding: '5px 0', fontSize: '12px', cursor: 'pointer',
                background: '#374151', color: '#9ca3af', border: 'none', borderRadius: '5px',
              }}>Cancel</button>
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
