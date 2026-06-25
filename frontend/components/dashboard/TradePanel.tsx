'use client'
import { useState, useEffect, useRef } from 'react'
import HLChart from './HLChart'
import { PositionModal } from './OverviewPanel'

const API_URL = process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app'

interface Market {
  name: string
  display_name: string
  max_leverage: number
  sz_decimals: number
  mark_price: number
  dex: string
  only_isolated: boolean
  prev_day_px: number
  funding: number
}

interface Props {
  walletAddress: string
  openPositions?: any[]
  openOrders?: any[]
  spotBalances?: any[]
  recentTrades?: any[]
  initialMarket?: { symbol: string, dex: string } | null
  initialInterval?: string
  onMarketConsumed?: () => void
  onRefresh?: () => void
}

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt = (val: unknown, dec = 2): string => {
  const n = parseFloat(String(val ?? 0))
  if (isNaN(n)) return '0.00'
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) })
}
const fmtPnl = (val: unknown): string => {
  const n = parseFloat(String(val ?? 0))
  if (isNaN(n)) return '+$0.00'
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const fmtQty = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)
const fmtTime = (val: unknown): string => {
  const ms = parseInt(String(val ?? 0))
  if (!ms || isNaN(ms)) return '—'
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const fmtOpened = (val: unknown): string => {
  if (!val) return '—'
  const d = new Date(String(val))
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const isBuySide = (side: unknown): boolean => {
  const s = String(side ?? '').toUpperCase()
  return s === 'B' || s === 'BUY'
}
const fmtOrderType = (raw: unknown): string => {
  const s = String(raw ?? '')
  if (s === 'Take Profit Market' || s === 'Take Profit Limit') return 'Take Profit'
  if (s === 'Stop Market' || s === 'Stop Limit') return 'Stop Loss'
  if (s === 'Market') return 'Market'
  if (s === 'Limit') return 'Limit'
  return s || 'Limit'
}

const LEVERAGE_TICKS = [1, 5, 10, 25, 50]

// ── Table helpers ─────────────────────────────────────────────────────────────
function TH({ children }: { children?: React.ReactNode }) {
  return <th className="px-5 py-3 text-left font-medium text-xs text-gray-500">{children}</th>
}
function TD({ children, color }: { children: React.ReactNode; color?: string }) {
  return <td className="px-5 py-3 text-sm text-gray-300" style={color ? { color } : undefined}>{children}</td>
}
function Tooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 4, verticalAlign: 'middle' }}
      onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <span style={{ fontSize: 10, color: '#4b5563', cursor: 'default', userSelect: 'none', lineHeight: 1 }}>ⓘ</span>
      {visible && (
        <span style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
          width: 248, padding: '8px 10px', borderRadius: 8, backgroundColor: '#13131f',
          border: '1px solid #2a2a3e', color: '#9ca3af', fontSize: 11, lineHeight: '1.55', fontWeight: 400,
          zIndex: 9999, pointerEvents: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.7)', whiteSpace: 'normal', display: 'block',
        }}>{text}</span>
      )}
    </span>
  )
}

// ── Resize Divider ────────────────────────────────────────────────────────────
function ResizeDivider({
  direction,
  onStart,
}: {
  direction: 'vertical' | 'horizontal'
  onStart: (e: React.MouseEvent) => void
}) {
  const isV = direction === 'vertical'
  return (
    <div
      className={isV ? 'tp-resize-v' : 'tp-resize-h'}
      style={{
        ...(isV
          ? { width: 4, cursor: 'col-resize' }
          : { height: 4, width: '100%', cursor: 'row-resize' }),
        flexShrink: 0,
        background: 'rgba(255,255,255,0.06)',
        transition: 'background 0.15s',
        zIndex: 1,
      }}
      onMouseDown={onStart}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(38,166,154,0.5)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
    />
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export function TradePanel({
  walletAddress, openPositions = [], openOrders = [], spotBalances = [], recentTrades = [],
  initialMarket = null, initialInterval, onMarketConsumed, onRefresh,
}: Props) {
  // Markets
  const [markets, setMarkets] = useState<Market[]>([])
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null)
  const [marketSearch, setMarketSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [marketsLoading, setMarketsLoading] = useState(true)

  // Order form
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [size, setSize] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [leverage, setLeverage] = useState(1)
  const [placing, setPlacing] = useState(false)
  const [orderMessage, setOrderMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [tpPrice, setTpPrice] = useState('')
  const [slPrice, setSlPrice] = useState('')

  // Market data
  const [orderbook, setOrderbook] = useState<{ bids: string[][]; asks: string[][] }>({ bids: [], asks: [] })
  const [markPrice, setMarkPrice] = useState(0)
  const [prevMarkPrice, setPrevMarkPrice] = useState(0)

  // UI state
  const [obCollapsed, setObCollapsed] = useState(false)
  const [managingPos, setManagingPos] = useState<any>(null)
  const [selectedOrders, setSelectedOrders] = useState<Set<number>>(new Set())
  const [confirmingOrderIdx, setConfirmingOrderIdx] = useState<number | null>(null)
  const [confirmingBulk, setConfirmingBulk] = useState(false)
  const [activeTab, setActiveTab] = useState<'positions' | 'orders' | 'spot' | 'trades'>('positions')
  const [tradesPage, setTradesPage] = useState(1)
  const [chartInterval, setChartInterval] = useState(initialInterval ?? '15m')

  // ── Resize state ────────────────────────────────────────────────────────────
  const [formWidth, setFormWidth] = useState(280)
  const [obWidth, setObWidth] = useState(160)
  const [bottomHeight, setBottomHeight] = useState(220)

  // ── Refs ────────────────────────────────────────────────────────────────────
  const marketSelectorRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    type: 'form-ob' | 'ob-chart' | 'chart-panel' | null
    startX: number
    startY: number
    startVal: number
  }>({ type: null, startX: 0, startY: 0, startVal: 0 })

  // ── Load saved sizes on mount ────────────────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('tradepanel_sizes')
      if (saved) {
        const s = JSON.parse(saved)
        if (typeof s.formWidth === 'number') setFormWidth(Math.min(400, Math.max(200, s.formWidth)))
        if (typeof s.obWidth === 'number') setObWidth(Math.min(250, Math.max(120, s.obWidth)))
        if (typeof s.bottomHeight === 'number') setBottomHeight(Math.min(500, Math.max(120, s.bottomHeight)))
      }
    } catch {}
  }, [])

  // ── Reset trades pagination on wallet change ─────────────────────────────────
  useEffect(() => { setTradesPage(1) }, [walletAddress])

  // ── Drag event listeners (registered once) ──────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.type) return
      if (d.type === 'form-ob') {
        setFormWidth(Math.min(400, Math.max(200, d.startVal + (e.clientX - d.startX))))
      } else if (d.type === 'ob-chart') {
        setObWidth(Math.min(250, Math.max(120, d.startVal + (e.clientX - d.startX))))
      } else if (d.type === 'chart-panel') {
        // drag up → bottomHeight increases; drag down → decreases
        setBottomHeight(Math.min(500, Math.max(120, d.startVal - (e.clientY - d.startY))))
      }
    }
    const onMouseUp = () => {
      if (!dragRef.current.type) return
      dragRef.current.type = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Persist sizes to localStorage (debounced 300 ms) ─────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem('tradepanel_sizes', JSON.stringify({ formWidth, obWidth, bottomHeight }))
      } catch {}
    }, 300)
    return () => clearTimeout(t)
  }, [formWidth, obWidth, bottomHeight])

  const startDrag = (
    type: 'form-ob' | 'ob-chart' | 'chart-panel',
    e: React.MouseEvent,
    startVal: number,
  ) => {
    e.preventDefault()
    dragRef.current = { type, startX: e.clientX, startY: e.clientY, startVal }
    document.body.style.cursor = type === 'chart-panel' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Load all markets on mount
  useEffect(() => {
    const loadMarkets = async () => {
      try {
        const res = await fetch(`${API_URL}/market/all`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: Market[] = await res.json()
        if (!Array.isArray(data)) throw new Error('Invalid market data')
        setMarkets(data)
        if (initialMarket) {
          const match = data.find((m: Market) =>
            m.name === initialMarket.symbol &&
            (m.dex === initialMarket.dex || (!initialMarket.dex && m.dex === 'main'))
          )
          if (match) {
            handleSelectMarket(match)
          } else {
            const btc = data.find((m: Market) => m.name === 'BTC')
            if (btc) { setSelectedMarket(btc); setMarkPrice(btc.mark_price); setLeverage(Math.min(10, btc.max_leverage)) }
          }
          onMarketConsumed?.()
        } else {
          const btc = data.find((m: Market) => m.name === 'BTC')
          if (btc) { setSelectedMarket(btc); setMarkPrice(btc.mark_price); setLeverage(Math.min(10, btc.max_leverage)) }
        }
      } catch (e) {
        console.error('Failed to load markets:', e)
      } finally {
        setMarketsLoading(false)
      }
    }
    loadMarkets()
  }, [])

  // Poll orderbook + mark price every 3 seconds
  useEffect(() => {
    if (!selectedMarket) return
    const poll = async () => {
      try {
        const [obRes, pricesRes] = await Promise.all([
          fetch(`${API_URL}/market/orderbook/${encodeURIComponent(selectedMarket.name)}`),
          fetch(`${API_URL}/market/prices`),
        ])
        const ob = await obRes.json()
        const prices = await pricesRes.json()
        setOrderbook(ob)
        let newPrice: string | undefined
        if (ob?.bids?.length && ob?.asks?.length) {
          const bestBid = parseFloat(ob.bids[0]?.[0] || '0')
          const bestAsk = parseFloat(ob.asks[0]?.[0] || '0')
          if (bestBid > 0 && bestAsk > 0) newPrice = ((bestBid + bestAsk) / 2).toString()
        }
        if (!newPrice) newPrice = prices.prices?.[selectedMarket.name] || prices.prices?.[selectedMarket.display_name]
        if (!newPrice) newPrice = selectedMarket.mark_price?.toString()
        if (newPrice) {
          const parsed = parseFloat(newPrice)
          if (parsed > 0) {
            setPrevMarkPrice(prev => prev || parsed)
            setMarkPrice(prev => { setPrevMarkPrice(prev || parsed); return parsed })
          }
        }
      } catch { /* silent */ }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [selectedMarket])

  // Derived values
  const sizeNum = parseFloat(size) || 0
  const entryPrice = orderType === 'limit' ? (parseFloat(limitPrice) || markPrice) : markPrice
  const assetSize = entryPrice > 0 ? (sizeNum * leverage) / entryPrice : 0
  const liqPrice = side === 'buy' ? entryPrice * (1 - 1 / leverage) : entryPrice * (1 + 1 / leverage)
  const fee = orderType === 'market' ? sizeNum * 0.00035 : sizeNum * 0.0001
  const priceColor = markPrice >= prevMarkPrice ? '#00d4aa' : '#ef4444'
  const change24h = selectedMarket?.prev_day_px && markPrice
    ? ((markPrice - selectedMarket.prev_day_px) / selectedMarket.prev_day_px) * 100 : 0
  const change24hColor = change24h >= 0 ? '#00d4aa' : '#ef4444'
  const fundingPct = selectedMarket ? (selectedMarket.funding * 100).toFixed(4) : '0.0000'
  const spread = orderbook.bids.length > 0 && orderbook.asks.length > 0
    ? parseFloat(orderbook.asks[0]?.[0] || '0') - parseFloat(orderbook.bids[0]?.[0] || '0') : 0

  const dexGroupsSet: { [key: string]: boolean } = {}
  markets.forEach(m => { dexGroupsSet[m.dex] = true })
  const dexGroups = Object.keys(dexGroupsSet)
  const filteredMarkets = markets.filter(m =>
    m.name.toLowerCase().includes(marketSearch.toLowerCase()) ||
    m.display_name.toLowerCase().includes(marketSearch.toLowerCase())
  )

  const handleSelectMarket = (market: Market) => {
    setSelectedMarket(market)
    setMarkPrice(market.mark_price || 0)
    setPrevMarkPrice(market.mark_price || 0)
    setLeverage(Math.min(leverage, market.max_leverage))
    setShowSearch(false)
    setMarketSearch('')
  }

  const handlePlaceOrder = async () => {
    if (!selectedMarket || sizeNum <= 0) return
    const szDec = selectedMarket.sz_decimals || 5
    const factor = Math.pow(10, szDec)
    const roundedSize = Math.floor(assetSize * factor) / factor
    if (roundedSize <= 0) { setOrderMessage({ type: 'error', text: 'Order size too small. Increase USD amount.' }); return }
    setPlacing(true)
    setOrderMessage(null)
    try {
      try {
        await fetch(`${API_URL}/orders/set-leverage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: walletAddress, coin: selectedMarket.name, leverage, is_cross: !selectedMarket.only_isolated }),
        })
      } catch { /* non-blocking */ }
      const res = await fetch(`${API_URL}/orders/place`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress, coin: selectedMarket.name, is_buy: side === 'buy',
          size: roundedSize, price: markPrice, order_type: orderType,
          limit_price: parseFloat(limitPrice) || markPrice, leverage, sz_decimals: szDec,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setOrderMessage({ type: 'error', text: data.detail || 'Order failed' }); return }
      const statuses = data?.result?.response?.data?.statuses
      const firstStatus = Array.isArray(statuses) ? statuses[0] : null
      if (firstStatus?.error) { setOrderMessage({ type: 'error', text: firstStatus.error }); return }
      setOrderMessage({ type: 'success', text: 'Order placed successfully!' })
      setSize('')
      const tpVal = parseFloat(tpPrice)
      const slVal = parseFloat(slPrice)
      if ((tpVal > 0 || slVal > 0) && selectedMarket) {
        try {
          await fetch(`${API_URL}/orders/tp-sl`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wallet_address: walletAddress, coin: selectedMarket.name, is_long: side === 'buy',
              size: roundedSize, sz_decimals: selectedMarket.sz_decimals || 5,
              tp_price: tpVal > 0 ? tpVal : null, sl_price: slVal > 0 ? slVal : null,
            }),
          })
          const tpSlMsg = [tpVal > 0 ? `TP: $${tpVal}` : '', slVal > 0 ? `SL: $${slVal}` : ''].filter(Boolean).join(' | ')
          setOrderMessage({ type: 'success', text: `Order placed! ${tpSlMsg}` })
        } catch {
          setOrderMessage({ type: 'success', text: 'Order placed! TP/SL may not have been set.' })
        }
        setTpPrice('')
        setSlPrice('')
      }
    } catch {
      setOrderMessage({ type: 'error', text: 'Network error. Please try again.' })
    } finally {
      setPlacing(false)
    }
  }

  const handleCancelOrder = async (coin: string, orderId: number) => {
    if (!walletAddress) return
    try {
      await fetch(`${API_URL}/orders/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, coin, order_id: orderId }),
      })
    } catch (e: any) { console.error('Cancel order failed:', e.message) }
  }

  const handleCancelSelected = async () => {
    if (!walletAddress || selectedOrders.size === 0) return
    const toCancel = openOrders.filter((o: any) => selectedOrders.has(o?.order_id))
    try {
      await Promise.all(toCancel.map((o: any) =>
        fetch(`${API_URL}/orders/cancel`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: walletAddress, coin: o?.coin, order_id: o?.order_id }),
        })
      ))
      setSelectedOrders(new Set())
    } catch (e: any) { console.error('Cancel selected failed:', e) }
  }

  const handlePositionRowClick = async (pos: any) => {
    const posSymbol: string = pos?.symbol ?? ''
    const posDex: string = pos?.dex ?? 'main'
    // Switch chart to clicked position's market
    const market = markets.find(m => m.name === posSymbol && m.dex === (posDex || 'main'))
    if (market) handleSelectMarket(market)
    // Look up the bot's configured interval for this symbol; fall back to 15m
    let interval = '15m'
    try {
      const res = await fetch(`${API_URL}/bots/?wallet_address=${walletAddress}`)
      if (res.ok) {
        const data = await res.json()
        const bots: any[] = data.bots ?? []
        const bot =
          bots.find((b: any) => b.symbol === posSymbol && (b.status === 'running' || b.desired_status === 'running')) ??
          bots.find((b: any) => b.symbol === posSymbol)
        if (bot?.config?.interval) interval = bot.config.interval
      }
    } catch { /* non-blocking */ }
    setChartInterval(interval)
  }

  const maxLev = selectedMarket?.max_leverage || 50

  return (
    <>
      <style>{`
        .tp-wrapper {
          display: flex; flex-direction: column;
          height: calc(100vh - 60px); overflow: hidden;
        }
        .tp-content-row {
          flex: 1; display: flex; overflow: hidden;
        }
        /* Right section: flex-column containing top-row + hhandle + bottom panel */
        .tp-right-col {
          flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0;
        }
        /* Top row: OB and Chart side by side */
        .tp-top-row {
          display: flex; flex-direction: row; overflow: hidden; min-height: 0;
        }
        /* Chart fills remaining width in top row */
        .tp-chart-col {
          flex: 1; overflow: hidden; min-height: 0;
        }
        .tp-resize-v:hover { background: rgba(38,166,154,0.5) !important; }
        .tp-resize-h:hover { background: rgba(38,166,154,0.5) !important; }

        /* Tablet: OB stacks above chart; hide resize handles */
        @media (max-width: 1023px) and (min-width: 768px) {
          .tp-form-col { width: 280px !important; }
          .tp-top-row { flex-direction: column !important; }
          .tp-ob-col { width: 100% !important; height: 260px !important; border-right: none !important; border-bottom: 1px solid rgba(255,255,255,0.08) !important; }
          .tp-resize-v { display: none !important; }
          .tp-resize-h { display: none !important; }
        }

        /* Mobile: single column — chart first, then OB, then form, then panel */
        @media (max-width: 767px) {
          .tp-wrapper { height: auto !important; overflow-y: auto !important; }
          .tp-content-row { flex-direction: column !important; overflow: visible !important; flex: none !important; }
          .tp-right-col { order: 1; flex: none !important; }
          .tp-form-col { order: 2; width: 100% !important; border-right: none !important; border-bottom: 1px solid rgba(255,255,255,0.08) !important; }
          .tp-top-row { flex-direction: column !important; flex: none !important; height: auto !important; }
          .tp-chart-col { order: 1; min-height: 300px; }
          .tp-ob-col { order: 2; width: 100% !important; border-right: none !important; height: 260px !important; }
          .tp-resize-v { display: none !important; }
          .tp-resize-h { display: none !important; }
          .tp-bottom-panel { max-height: none !important; flex: none !important; }
        }
      `}</style>

      <div className="tp-wrapper">

        {/* ── TOP BAR ──────────────────────────────────────────────────────── */}
        <div style={{ background: '#0d0d14', borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'white', fontWeight: '700', fontSize: '16px' }}>{selectedMarket?.name || '—'}</span>
            {selectedMarket && (
              <span style={{ fontSize: '10px', color: '#6b7280', background: '#1a1a2e',
                padding: '2px 6px', borderRadius: '4px', fontWeight: '600', letterSpacing: '0.5px' }}>
                {selectedMarket.dex === 'main' ? 'HL' : selectedMarket.dex.toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ width: '1px', height: '28px', background: 'rgba(255,255,255,0.08)' }} />
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Mark Price</div>
            <div style={{ color: priceColor, fontWeight: '700', fontSize: '18px', fontVariantNumeric: 'tabular-nums' }}>
              ${markPrice > 0 ? fmt(markPrice) : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>24h Change</div>
            <div style={{ color: change24hColor, fontWeight: '600', fontSize: '14px' }}>
              {change24h !== 0 ? `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Funding (8h)</div>
            <div style={{ color: parseFloat(fundingPct) >= 0 ? '#00d4aa' : '#ef4444', fontWeight: '600', fontSize: '14px' }}>
              {selectedMarket ? `${parseFloat(fundingPct) >= 0 ? '+' : ''}${fundingPct}%` : '—'}
            </div>
          </div>
          {selectedMarket && (
            <div>
              <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Max Leverage</div>
              <div style={{ color: 'white', fontWeight: '600', fontSize: '14px' }}>{selectedMarket.max_leverage}x</div>
            </div>
          )}
        </div>

        {/* ── CONTENT ROW ──────────────────────────────────────────────────── */}
        <div className="tp-content-row">

          {/* ── ORDER FORM — left column, full height ────────────────────── */}
          <div className="tp-form-col" style={{
            width: formWidth, flexShrink: 0, display: 'flex', flexDirection: 'column',
            gap: '12px', overflowY: 'auto', padding: '12px', paddingBottom: '20px',
            borderRight: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.01)',
          }}>
            {/* Market Selector */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', letterSpacing: '1px' }}>MARKET</span>
                {!marketsLoading && <span style={{ fontSize: '10px', color: '#4b5563' }}>{markets.length} markets</span>}
              </div>
              <div ref={marketSelectorRef} style={{ position: 'relative' }}>
                {showSearch ? (
                  <input autoFocus type="text" value={marketSearch} onChange={e => setMarketSearch(e.target.value)}
                    placeholder="Search markets…"
                    style={{ width: '100%', background: '#0a0a0f', border: '1px solid #00d4aa', borderRadius: '6px',
                      padding: '10px 12px', color: 'white', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                  />
                ) : (
                  <div onClick={() => setShowSearch(true)}
                    style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px',
                      padding: '10px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ color: marketsLoading ? '#6b7280' : 'white', fontWeight: '700', fontSize: '15px' }}>
                        {marketsLoading ? 'Loading markets…' : (selectedMarket?.name || 'Select Market')}
                      </span>
                      {selectedMarket && (
                        <span style={{ fontSize: '10px', color: '#6b7280', background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px' }}>
                          {selectedMarket.dex === 'main' ? 'HL' : selectedMarket.dex.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span style={{ color: '#6b7280', fontSize: '10px' }}>▼</span>
                  </div>
                )}
                {showSearch && (
                  <div style={{ position: 'fixed',
                    top: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().bottom + 4 : 0,
                    left: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().left : 0,
                    width: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().width : 280,
                    background: '#0d0d14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px',
                    maxHeight: '300px', overflowY: 'auto', zIndex: 9999 }}>
                    {dexGroups.map(dexName => {
                      const dexMarkets = filteredMarkets.filter(m => m.dex === dexName)
                      if (dexMarkets.length === 0) return null
                      return (
                        <div key={dexName}>
                          <div style={{ padding: '4px 12px', fontSize: '10px', color: '#6b7280', background: '#0a0a0f',
                            textTransform: 'uppercase', letterSpacing: '1px', position: 'sticky', top: 0 }}>
                            {dexName === 'main' ? 'Hyperliquid' : dexName.toUpperCase() + ' DEX'}
                            <span style={{ marginLeft: '6px', color: '#374151' }}>({dexMarkets.length})</span>
                          </div>
                          {dexMarkets.map(market => (
                            <div key={market.name} onClick={() => handleSelectMarket(market)}
                              style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex',
                                justifyContent: 'space-between', alignItems: 'center',
                                background: selectedMarket?.name === market.name ? '#1a1a2e' : 'transparent' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                              onMouseLeave={e => (e.currentTarget.style.background =
                                selectedMarket?.name === market.name ? '#1a1a2e' : 'transparent')}>
                              <span style={{ color: 'white', fontSize: '13px', fontWeight: '500' }}>{market.name}</span>
                              <span style={{ color: '#6b7280', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                                {market.mark_price > 0 ? `$${fmt(market.mark_price)}` : '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                    {filteredMarkets.length === 0 && (
                      <div style={{ padding: '16px', textAlign: 'center', fontSize: '13px', color: '#6b7280' }}>No markets found</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Order Type */}
            <div style={{ display: 'flex', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px', overflow: 'hidden', position: 'relative', zIndex: 1, flexShrink: 0 }}>
              {(['market', 'limit'] as const).map(type => (
                <button key={type}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setShowSearch(false); setMarketSearch(''); setOrderType(type) }}
                  style={{ flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
                    background: orderType === type ? '#1a1a2e' : 'transparent',
                    color: orderType === type ? '#00d4aa' : '#6b7280', fontSize: '13px', fontWeight: '600', textTransform: 'capitalize' }}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>

            {/* Side */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => { setShowSearch(false); setMarketSearch(''); setSide('buy') }}
                style={{ flex: 1, padding: '12px', cursor: 'pointer', borderRadius: '8px', fontWeight: '700', fontSize: '14px',
                  background: side === 'buy' ? '#00d4aa' : '#0d0d14', color: side === 'buy' ? '#0a0a0f' : '#6b7280',
                  border: `1px solid ${side === 'buy' ? '#00d4aa' : 'rgba(255,255,255,0.08)'}` }}>
                Buy / Long
              </button>
              <button onClick={() => { setShowSearch(false); setMarketSearch(''); setSide('sell') }}
                style={{ flex: 1, padding: '12px', cursor: 'pointer', borderRadius: '8px', fontWeight: '700', fontSize: '14px',
                  background: side === 'sell' ? '#ef4444' : '#0d0d14', color: side === 'sell' ? 'white' : '#6b7280',
                  border: `1px solid ${side === 'sell' ? '#ef4444' : 'rgba(255,255,255,0.08)'}` }}>
                Sell / Short
              </button>
            </div>

            {/* Inputs */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'hidden' }}>
              {orderType === 'limit' && (
                <div>
                  <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px', letterSpacing: '0.5px' }}>LIMIT PRICE (USD)</label>
                  <input type="number" value={limitPrice} onChange={e => setLimitPrice(e.target.value)}
                    placeholder={markPrice > 0 ? markPrice.toFixed(2) : '0.00'}
                    style={{ width: '100%', background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '6px', padding: '8px 12px', color: 'white', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                    onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
                  />
                </div>
              )}
              <div>
                <label style={{ fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px', letterSpacing: '0.5px' }}>SIZE (USD)</label>
                <input type="number" value={size} onChange={e => setSize(e.target.value)} placeholder="0.00"
                  style={{ width: '100%', background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '6px', padding: '8px 12px', color: 'white', fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                  onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
                />
                {sizeNum > 0 && selectedMarket && (
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                    ≈ {assetSize.toFixed(selectedMarket.sz_decimals)} {selectedMarket.display_name}
                  </div>
                )}
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#6b7280', letterSpacing: '0.5px' }}>LEVERAGE</label>
                  <span style={{ fontSize: '13px', color: '#00d4aa', fontWeight: '700' }}>{leverage}x</span>
                </div>
                <input type="range" min={1} max={maxLev} value={leverage}
                  onChange={e => setLeverage(parseInt(e.target.value))}
                  style={{ width: '100%', accentColor: '#00d4aa', margin: '4px 0' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  {LEVERAGE_TICKS.filter(v => v <= maxLev).map(v => (
                    <button key={v} type="button" onClick={() => setLeverage(v)}
                      style={{ fontSize: '10px', padding: '2px 4px', border: 'none', borderRadius: '3px', cursor: 'pointer',
                        background: leverage === v ? '#00d4aa22' : 'transparent',
                        color: leverage === v ? '#00d4aa' : '#4b5563', fontWeight: leverage === v ? '700' : '400' }}>
                      {v}x
                    </button>
                  ))}
                  {maxLev > 50 && (
                    <button type="button" onClick={() => setLeverage(maxLev)}
                      style={{ fontSize: '10px', padding: '2px 4px', border: 'none', borderRadius: '3px', cursor: 'pointer',
                        background: leverage === maxLev ? '#00d4aa22' : 'transparent',
                        color: leverage === maxLev ? '#00d4aa' : '#4b5563' }}>
                      {maxLev}x
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Order Summary */}
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', overflow: 'hidden' }}>
              {([
                ['Entry Price', entryPrice > 0 ? `$${fmt(entryPrice)}` : '—'],
                ['Size', sizeNum > 0 ? `$${sizeNum.toFixed(2)}` : '—'],
                ['Leverage', `${leverage}x`],
                ['Est. Liq. Price', sizeNum > 0 && entryPrice > 0 ? `$${fmt(liqPrice)}` : '—'],
                [`Fee (${orderType === 'market' ? '0.035%' : '0.01%'})`, sizeNum > 0 ? `$${fee.toFixed(4)}` : '—'],
                ['Funding Rate (8h)', `${parseFloat(fundingPct) >= 0 ? '+' : ''}${fundingPct}%`],
              ] as [string, string][]).map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}</span>
                  <span style={{ fontSize: '11px', color: 'white' }}>{value}</span>
                </div>
              ))}
            </div>

            {/* TP / SL */}
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em' }}>
                TAKE PROFIT / STOP LOSS <span style={{ fontWeight: 400, color: '#4b5563' }}>(optional)</span>
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>Take Profit (USD)</p>
                  <input type="number" placeholder="TP Price" value={tpPrice} onChange={e => setTpPrice(e.target.value)}
                    style={{ width: '100%', background: '#13131f', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 6, padding: '6px 10px', color: '#10b981', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>Stop Loss (USD)</p>
                  <input type="number" placeholder="SL Price" value={slPrice} onChange={e => setSlPrice(e.target.value)}
                    style={{ width: '100%', background: '#13131f', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 6, padding: '6px 10px', color: '#ef4444', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              </div>
            </div>

            {orderMessage && (
              <div style={{ padding: '10px', borderRadius: '6px', fontSize: '13px', textAlign: 'center',
                background: orderMessage.type === 'success' ? 'rgba(0,212,170,0.1)' : 'rgba(239,68,68,0.1)',
                border: `1px solid ${orderMessage.type === 'success' ? '#00d4aa' : '#ef4444'}`,
                color: orderMessage.type === 'success' ? '#00d4aa' : '#ef4444' }}>
                {orderMessage.text}
              </div>
            )}

            <button onClick={handlePlaceOrder} disabled={placing || sizeNum <= 0 || !selectedMarket}
              style={{ width: '100%', padding: '14px', border: 'none', cursor: 'pointer', borderRadius: '8px', fontWeight: '700', fontSize: '15px',
                background: placing || sizeNum <= 0 ? '#1a1a2e' : side === 'buy' ? '#00d4aa' : '#ef4444',
                color: placing || sizeNum <= 0 ? '#6b7280' : side === 'buy' ? '#0a0a0f' : 'white' }}>
              {placing ? 'Placing…' : `Place ${side === 'buy' ? 'Buy' : 'Sell'} Order`}
            </button>
          </div>{/* /.tp-form-col */}

          {/* ── RESIZE HANDLE: Form | right section ──────────────────────── */}
          <ResizeDivider direction="vertical" onStart={e => startDrag('form-ob', e, formWidth)} />

          {/* ── RIGHT SECTION: [OB | Chart] top row + bottom panel ─────── */}
          <div className="tp-right-col">

            {/* TOP ROW — OB and Chart side by side */}
            <div className="tp-top-row" style={{ flex: 1, minHeight: 0 }}>

              {/* ── ORDER BOOK ───────────────────────────────────────────── */}
              <div className="tp-ob-col" style={{
                width: obCollapsed ? 28 : obWidth, flexShrink: 0, display: 'flex', flexDirection: 'column',
                overflow: 'hidden', background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)', height: '100%',
              }}>
                {/* OB Header */}
                <div style={{ display: 'flex', alignItems: 'center',
                  justifyContent: obCollapsed ? 'center' : 'space-between',
                  padding: obCollapsed ? '10px 0' : '6px 8px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, minHeight: '32px' }}>
                  {!obCollapsed && (
                    <div style={{ overflow: 'hidden' }}>
                      <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600' }}>Order Book</span>
                      {spread > 0 && markPrice > 0 && (
                        <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: '5px', whiteSpace: 'nowrap' }}>
                          {spread.toFixed(2)} | {((spread / markPrice) * 100).toFixed(3)}%
                        </span>
                      )}
                    </div>
                  )}
                  <button onClick={() => setObCollapsed(v => !v)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '14px', padding: '0', lineHeight: 1, flexShrink: 0 }}>
                    {obCollapsed ? '›' : '‹'}
                  </button>
                </div>

                {!obCollapsed && (
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr', padding: '3px 6px',
                      fontSize: '9px', color: '#4b5563', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <span>Price</span>
                      <span style={{ textAlign: 'right' }}>Size</span>
                      <span style={{ textAlign: 'right' }}>Total</span>
                    </div>

                    {/* Asks — lowest at bottom */}
                    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                      {(() => {
                        const asks = orderbook.asks.slice(0, 10)
                        let cum = 0
                        const withCum = asks.map((a: any) => { cum += parseFloat(a[0]) * parseFloat(a[1]); return { price: a[0], size: a[1], total: cum } })
                        const maxCum = cum || 1
                        return [...withCum].reverse().map((ask, i) => (
                          <div key={i} style={{ position: 'relative', height: '22px', display: 'flex', alignItems: 'center' }}>
                            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(ask.total / maxCum) * 100}%`, background: 'rgba(239,68,68,0.10)' }} />
                            <div style={{ position: 'relative', width: '100%', display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr', padding: '0 6px', fontSize: '11px' }}>
                              <span style={{ color: '#f87171', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(ask.price).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}</span>
                              <span style={{ color: '#9ca3af', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(ask.size).toFixed(3)}</span>
                              <span style={{ color: '#6b7280', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '10px' }}>{fmtQty(ask.total)}</span>
                            </div>
                          </div>
                        ))
                      })()}
                    </div>

                    {/* Spread divider */}
                    <div style={{ padding: '4px 6px', background: 'rgba(0,0,0,0.3)', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      borderTop: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      <span style={{ fontSize: '12px', color: priceColor, fontWeight: '700', fontVariantNumeric: 'tabular-nums' }}>
                        {markPrice > 0 ? fmt(markPrice) : '—'}
                      </span>
                      {spread > 0 && markPrice > 0 && (
                        <span style={{ fontSize: '9px', color: '#4b5563' }}>{((spread / markPrice) * 100).toFixed(3)}%</span>
                      )}
                    </div>

                    {/* Bids — highest at top */}
                    <div style={{ flex: 1, overflowY: 'auto' }}>
                      {(() => {
                        const bids = orderbook.bids.slice(0, 10)
                        let cum = 0
                        const withCum = bids.map((b: any) => { cum += parseFloat(b[0]) * parseFloat(b[1]); return { price: b[0], size: b[1], total: cum } })
                        const maxCum = cum || 1
                        return withCum.map((bid, i) => (
                          <div key={i} style={{ position: 'relative', height: '22px', display: 'flex', alignItems: 'center' }}>
                            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(bid.total / maxCum) * 100}%`, background: 'rgba(0,212,170,0.10)' }} />
                            <div style={{ position: 'relative', width: '100%', display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr', padding: '0 6px', fontSize: '11px' }}>
                              <span style={{ color: '#34d399', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(bid.price).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}</span>
                              <span style={{ color: '#9ca3af', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(bid.size).toFixed(3)}</span>
                              <span style={{ color: '#6b7280', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '10px' }}>{fmtQty(bid.total)}</span>
                            </div>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}
              </div>{/* /.tp-ob-col */}

              {/* ── RESIZE HANDLE: OB | Chart (hidden when OB collapsed) ── */}
              {!obCollapsed && (
                <ResizeDivider direction="vertical" onStart={e => startDrag('ob-chart', e, obWidth)} />
              )}

              {/* ── CHART ────────────────────────────────────────────────── */}
              <div className="tp-chart-col">
                {selectedMarket && (
                  <HLChart
                    symbol={selectedMarket.name}
                    height={undefined}
                    positions={openPositions}
                    openOrders={openOrders}
                    initialInterval={chartInterval}
                  />
                )}
              </div>

            </div>{/* /.tp-top-row */}

            {/* ── RESIZE HANDLE: top row | bottom panel ────────────────── */}
            <ResizeDivider direction="horizontal" onStart={e => startDrag('chart-panel', e, bottomHeight)} />

            {/* ── BOTTOM PANEL — spans full width of OB + Chart ────────── */}
            <div className="tp-bottom-panel" style={{
              height: bottomHeight,
              flexShrink: 0,
              minHeight: 120,
              maxHeight: 500,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              overflowY: 'auto',
            }}>

              {/* Tab bar */}
              <div style={{
                display: 'flex', alignItems: 'center',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                position: 'sticky', top: 0, background: 'rgba(10,10,15,0.96)', zIndex: 2, padding: '0 6px',
              }}>
                {([
                  ['positions', `Open Positions (${openPositions.length})`],
                  ['orders',    `Open Orders (${openOrders.length})`],
                  ['spot',      'Spot Balances'],
                  ['trades',    `Recent Trades (${recentTrades.length})`],
                ] as const).map(([tab, label]) => (
                  <button key={tab} onClick={() => { setActiveTab(tab); setConfirmingOrderIdx(null); setConfirmingBulk(false) }}
                    style={{
                      fontSize: '11px', fontWeight: '600', padding: '10px 14px',
                      border: 'none', cursor: 'pointer', background: 'transparent',
                      color: activeTab === tab ? '#00d4aa' : '#6b7280',
                      borderBottom: activeTab === tab ? '2px solid #00d4aa' : '2px solid transparent',
                      marginBottom: '-1px', transition: 'color 0.15s', whiteSpace: 'nowrap',
                    }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Tab: Open Positions */}
              {activeTab === 'positions' && (
                openPositions.length === 0 ? (
                  <div style={{ padding: '10px 20px', fontSize: '12px', color: '#4b5563' }}>No open positions</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                          <TH>DEX</TH><TH>Symbol</TH><TH>Side</TH><TH>Size</TH>
                          <TH>Entry Price</TH><TH>Mark Price</TH>
                          <TH>Notional <Tooltip text="Full leveraged exposure — size × mark price." /></TH>
                          <TH>Margin <Tooltip text="Cash committed — marginUsed from Hyperliquid." /></TH>
                          <TH>PnL / ROE%</TH><TH>TP / SL</TH><TH>Leverage</TH>
                          <TH>Liq. Price</TH><TH>Opened</TH><TH>Actions</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {openPositions.map((pos: any, i: number) => {
                          const upnl = parseFloat(String(pos?.unrealized_pnl ?? 0))
                          const posPos = upnl >= 0
                          const liqPx = parseFloat(String(pos?.liquidation_price ?? 0))
                          const roe = parseFloat(String(pos?.roe_pct ?? 0))
                          const tpPx = pos?.tp_price ? parseFloat(String(pos.tp_price)) : null
                          const slPx = pos?.sl_price ? parseFloat(String(pos.sl_price)) : null
                          const notional = parseFloat(String(pos?.position_value ?? 0))
                          const margin = parseFloat(String(pos?.margin_used ?? 0))
                          return (
                            <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                              style={{ borderColor: 'rgba(255,255,255,0.08)', cursor: 'pointer' }}
                              onClick={() => handlePositionRowClick(pos)}
                              title="Click to switch chart to this symbol">
                              <td className="px-5 py-3">
                                <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>{pos?.dex ?? '—'}</span>
                              </td>
                              <TD><span className="font-semibold text-white">{pos?.symbol ?? '—'}</span></TD>
                              <td className="px-5 py-3">
                                <span className="text-xs px-2 py-0.5 rounded font-semibold"
                                  style={{ backgroundColor: parseFloat(pos?.size) > 0 ? '#00d4aa18' : '#ef444418', color: parseFloat(pos?.size) > 0 ? '#00d4aa' : '#ef4444' }}>
                                  {parseFloat(pos?.size) > 0 ? 'Buy' : 'Sell'}
                                </span>
                              </td>
                              <TD>{fmt(pos?.size, 4)}</TD>
                              <TD>${fmt(pos?.entry_price)}</TD>
                              <TD>${fmt(pos?.mark_price ?? 0)}</TD>
                              <TD>${fmt(notional)}</TD>
                              <TD color="#9ca3af">${fmt(margin)}</TD>
                              <td className="px-5 py-3">
                                <p className="text-sm" style={{ color: posPos ? '#10b981' : '#ef4444' }}>{fmtPnl(upnl)}</p>
                                <p className="text-xs mt-0.5" style={{ color: roe >= 0 ? '#10b981' : '#ef4444' }}>{roe >= 0 ? '+' : ''}{fmt(roe, 2)}%</p>
                              </td>
                              <td className="px-5 py-3">
                                {tpPx ? <p className="text-xs" style={{ color: '#10b981' }}>TP ${fmt(tpPx)}</p> : null}
                                {slPx ? <p className="text-xs mt-0.5" style={{ color: '#ef4444' }}>SL ${fmt(slPx)}</p> : null}
                                {!tpPx && !slPx ? <span className="text-xs text-gray-600">—</span> : null}
                              </td>
                              <TD>{fmt(pos?.leverage, 0)}x {pos?.leverage_type ?? ''}</TD>
                              <TD>{liqPx > 0 ? `$${fmt(liqPx)}` : '—'}</TD>
                              <td className="px-5 py-3"><p className="text-xs text-gray-400">{fmtOpened(pos?.opened_at)}</p></td>
                              <td className="px-5 py-3">
                                <button onClick={e => { e.stopPropagation(); setManagingPos(pos) }}
                                  className="text-xs font-semibold px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
                                  style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                                  Manage
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {/* Tab: Open Orders */}
              {activeTab === 'orders' && (
                openOrders.length === 0 ? (
                  <div style={{ padding: '10px 20px', fontSize: '12px', color: '#4b5563' }}>No open orders</div>
                ) : (
                  <>
                    <div className="flex items-center justify-between px-5 py-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                      <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-500">
                        <input type="checkbox"
                          checked={selectedOrders.size === openOrders.length && openOrders.length > 0}
                          onChange={e => {
                            if (e.target.checked) setSelectedOrders(new Set(openOrders.map((o: any) => o?.order_id)))
                            else setSelectedOrders(new Set())
                          }}
                          style={{ accentColor: '#00d4aa', width: 14, height: 14 }}
                        />
                        Select all
                      </label>
                      {selectedOrders.size > 0 && (
                        confirmingBulk ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                            <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
                              Cancel {selectedOrders.size} order{selectedOrders.size > 1 ? 's' : ''}?
                            </span>
                            <button
                              onClick={async () => { setConfirmingBulk(false); await handleCancelSelected(); onRefresh?.() }}
                              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, fontWeight: 700, cursor: 'pointer', border: 'none', background: '#ef4444', color: 'white' }}>
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmingBulk(false)}
                              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, fontWeight: 700, cursor: 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: '#6b7280' }}>
                              No
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => { setConfirmingBulk(true); setConfirmingOrderIdx(null) }}
                            className="text-xs px-3 py-1.5 rounded font-semibold"
                            style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                            Cancel {selectedOrders.size} order{selectedOrders.size > 1 ? 's' : ''}
                          </button>
                        )
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                            <TH> </TH><TH>Coin</TH><TH>Side</TH><TH>Type</TH>
                            <TH>Price</TH><TH>Size</TH><TH>Time</TH><TH>Source</TH><TH>Action</TH>
                          </tr>
                        </thead>
                        <tbody>
                          {openOrders.map((o: any, i: number) => {
                            const buy = isBuySide(o?.side)
                            const orderTime = o?.time ? new Date(o.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'
                            const orderDate = o?.time ? new Date(o.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
                            const isTrigger = o?.is_trigger || o?.is_position_tpsl
                            return (
                              <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                                <td className="px-4 py-3">
                                  <input type="checkbox" checked={selectedOrders.has(o?.order_id)}
                                    onChange={e => {
                                      const next = new Set(selectedOrders)
                                      if (e.target.checked) next.add(o?.order_id); else next.delete(o?.order_id)
                                      setSelectedOrders(next)
                                    }}
                                    style={{ accentColor: '#00d4aa', width: 14, height: 14 }}
                                  />
                                </td>
                                <td className="px-5 py-3 font-semibold text-white text-sm">{o?.coin ?? '—'}</td>
                                <TD color={buy ? '#10b981' : '#ef4444'}>{buy ? 'Buy' : 'Sell'}</TD>
                                <td className="px-5 py-3">
                                  <span className="text-xs px-2 py-0.5 rounded font-medium"
                                    style={{ backgroundColor: isTrigger ? '#f59e0b18' : '#00d4aa18', color: isTrigger ? '#f59e0b' : '#00d4aa' }}>
                                    {fmtOrderType(o?.order_type)}
                                  </span>
                                </td>
                                <TD>${fmt(o?.price)}</TD>
                                <TD>{fmt(o?.size, 4)}</TD>
                                <td className="px-5 py-3">
                                  <p className="text-xs text-gray-300">{orderTime}</p>
                                  <p className="text-xs text-gray-600">{orderDate}</p>
                                </td>
                                <td className="px-5 py-3">
                                  <span className="text-xs px-2 py-0.5 rounded font-medium" style={{ backgroundColor: '#1a1a2e', color: '#6b7280' }}>Manual</span>
                                </td>
                                <td className="px-5 py-3">
                                  {confirmingOrderIdx === i ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} onClick={e => e.stopPropagation()}>
                                      <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>Cancel order?</span>
                                      <button
                                        onClick={async () => { setConfirmingOrderIdx(null); await handleCancelOrder(o?.coin, o?.order_id); onRefresh?.() }}
                                        style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, fontWeight: 700, cursor: 'pointer', border: 'none', background: '#ef4444', color: 'white' }}>
                                        Yes
                                      </button>
                                      <button
                                        onClick={() => setConfirmingOrderIdx(null)}
                                        style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, fontWeight: 700, cursor: 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: '#6b7280' }}>
                                        No
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => { setConfirmingOrderIdx(i); setConfirmingBulk(false) }}
                                      className="text-xs px-3 py-1 rounded font-semibold transition-opacity hover:opacity-80"
                                      style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                                      Cancel
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              )}

              {/* Tab: Spot Balances */}
              {activeTab === 'spot' && (
                spotBalances.length === 0 ? (
                  <div style={{ padding: '10px 20px', fontSize: '12px', color: '#4b5563' }}>No spot balances</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                          <TH>Coin</TH><TH>Total</TH><TH>Hold</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {spotBalances.map((b: any, i: number) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                            <td className="px-5 py-3 font-semibold text-white text-sm">{b?.coin ?? '—'}</td>
                            <TD>{fmt(b?.total, 6)}</TD>
                            <TD>{parseFloat(String(b?.hold ?? 0)) > 0 ? fmt(b?.hold, 6) : '—'}</TD>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {/* Tab: Recent Trades */}
              {activeTab === 'trades' && (() => {
                const totalTradePgs = Math.ceil(recentTrades.length / 10) || 1
                const pagedTrades = recentTrades.slice((tradesPage - 1) * 10, tradesPage * 10)
                return recentTrades.length === 0 ? (
                  <div style={{ padding: '10px 20px', fontSize: '12px', color: '#4b5563' }}>No recent trades</div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                            <TH>Coin</TH><TH>Side</TH><TH>Price</TH><TH>Size</TH>
                            <TH>Closed PnL</TH><TH>Fee</TH><TH>Time</TH>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedTrades.map((f: any, i: number) => {
                            const buy = isBuySide(f?.side)
                            const cpnl = parseFloat(String(f?.closed_pnl ?? 0))
                            return (
                              <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                                <td className="px-5 py-3 font-semibold text-white text-sm">{f?.coin ?? '—'}</td>
                                <TD color={buy ? '#10b981' : '#ef4444'}>{buy ? 'Buy' : 'Sell'}</TD>
                                <TD>${fmt(f?.price)}</TD>
                                <TD>{fmt(f?.size, 4)}</TD>
                                <TD color={cpnl > 0 ? '#10b981' : cpnl < 0 ? '#ef4444' : '#6b7280'}>{cpnl === 0 ? '—' : fmtPnl(cpnl)}</TD>
                                <TD color="#6b7280">${fmt(f?.fee)}</TD>
                                <TD color="#6b7280">{fmtTime(f?.time)}</TD>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {recentTrades.length > 10 && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {totalTradePgs > 5 && (
                            <button onClick={() => setTradesPage(1)} disabled={tradesPage === 1}
                              style={{ padding: '4px 7px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: tradesPage === 1 ? 'not-allowed' : 'pointer', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: tradesPage === 1 ? '#374151' : '#6b7280', opacity: tradesPage === 1 ? 0.4 : 1 }}>
                              «
                            </button>
                          )}
                          <button onClick={() => setTradesPage(p => Math.max(1, p - 1))} disabled={tradesPage === 1}
                            style={{ padding: '4px 9px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: tradesPage === 1 ? 'not-allowed' : 'pointer', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: tradesPage === 1 ? '#374151' : '#9ca3af', opacity: tradesPage === 1 ? 0.4 : 1 }}>
                            ← Prev
                          </button>
                        </div>
                        <span style={{ fontSize: 11, color: '#00d4aa', fontWeight: 600 }}>
                          {(tradesPage - 1) * 10 + 1}–{Math.min(tradesPage * 10, recentTrades.length)} of {recentTrades.length} trades
                        </span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => setTradesPage(p => Math.min(totalTradePgs, p + 1))} disabled={tradesPage === totalTradePgs}
                            style={{ padding: '4px 9px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: tradesPage === totalTradePgs ? 'not-allowed' : 'pointer', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: tradesPage === totalTradePgs ? '#374151' : '#9ca3af', opacity: tradesPage === totalTradePgs ? 0.4 : 1 }}>
                            Next →
                          </button>
                          {totalTradePgs > 5 && (
                            <button onClick={() => setTradesPage(totalTradePgs)} disabled={tradesPage === totalTradePgs}
                              style={{ padding: '4px 7px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: tradesPage === totalTradePgs ? 'not-allowed' : 'pointer', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: tradesPage === totalTradePgs ? '#374151' : '#6b7280', opacity: tradesPage === totalTradePgs ? 0.4 : 1 }}>
                              »
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}

            </div>{/* /.tp-bottom-panel */}
          </div>{/* /.tp-right-col */}
        </div>{/* /.tp-content-row */}

        {/* Click outside to close market search */}
        {showSearch && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 100 }}
            onClick={() => { setShowSearch(false); setMarketSearch('') }}
          />
        )}

        {/* Position Manager Modal */}
        {managingPos && typeof managingPos === 'object' && (
          <PositionModal
            pos={managingPos}
            walletAddress={walletAddress}
            onClose={() => setManagingPos(null)}
            onAction={() => { setManagingPos(null); onRefresh?.(); }}
            onRefresh={() => onRefresh?.()}
          />
        )}
      </div>{/* /.tp-wrapper */}
    </>
  )
}
