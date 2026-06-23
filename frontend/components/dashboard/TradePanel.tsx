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
  initialMarket?: { symbol: string, dex: string } | null
  initialInterval?: string
  onMarketConsumed?: () => void
}

const fmt = (n: number, dec = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) })

const fmtPnl = (n: number) =>
  (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtQty = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)

const LEVERAGE_TICKS = [1, 5, 10, 25, 50]

export function TradePanel({ walletAddress, openPositions = [], openOrders = [], initialMarket = null, initialInterval, onMarketConsumed }: Props) {
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
  const [posCollapsed, setPosCollapsed] = useState(false)
  const [managingPos, setManagingPos] = useState<any>(null)

  const marketSelectorRef = useRef<HTMLDivElement>(null)

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
          if (btc) {
            setSelectedMarket(btc)
            setMarkPrice(btc.mark_price)
            setLeverage(Math.min(10, btc.max_leverage))
          }
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
          if (bestBid > 0 && bestAsk > 0) {
            newPrice = ((bestBid + bestAsk) / 2).toString()
          }
        }
        if (!newPrice) {
          newPrice = prices.prices?.[selectedMarket.name] ||
            prices.prices?.[selectedMarket.display_name]
        }
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
  const liqPrice = side === 'buy'
    ? entryPrice * (1 - 1 / leverage)
    : entryPrice * (1 + 1 / leverage)
  const fee = orderType === 'market' ? sizeNum * 0.00035 : sizeNum * 0.0001
  const priceColor = markPrice >= prevMarkPrice ? '#00d4aa' : '#ef4444'

  const change24h = selectedMarket?.prev_day_px && markPrice
    ? ((markPrice - selectedMarket.prev_day_px) / selectedMarket.prev_day_px) * 100
    : 0
  const change24hColor = change24h >= 0 ? '#00d4aa' : '#ef4444'
  const fundingPct = selectedMarket ? (selectedMarket.funding * 100).toFixed(4) : '0.0000'

  const spread = orderbook.bids.length > 0 && orderbook.asks.length > 0
    ? parseFloat(orderbook.asks[0]?.[0] || '0') - parseFloat(orderbook.bids[0]?.[0] || '0')
    : 0

  // Unique DEX groups (in order of first appearance)
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
    if (roundedSize <= 0) {
      setOrderMessage({ type: 'error', text: `Order size too small. Increase USD amount.` })
      return
    }

    setPlacing(true)
    setOrderMessage(null)
    try {
      try {
        await fetch(`${API_URL}/orders/set-leverage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wallet_address: walletAddress,
            coin: selectedMarket.name,
            leverage: leverage,
            is_cross: !selectedMarket.only_isolated,
          }),
        })
      } catch {
        // non-blocking
      }
      const res = await fetch(`${API_URL}/orders/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: selectedMarket.name,
          is_buy: side === 'buy',
          size: roundedSize,
          price: markPrice,
          order_type: orderType,
          limit_price: parseFloat(limitPrice) || markPrice,
          leverage,
          sz_decimals: szDec,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setOrderMessage({ type: 'error', text: data.detail || 'Order failed' })
        return
      }
      const statuses = data?.result?.response?.data?.statuses
      const firstStatus = Array.isArray(statuses) ? statuses[0] : null
      if (firstStatus?.error) {
        setOrderMessage({ type: 'error', text: firstStatus.error })
        return
      }
      setOrderMessage({ type: 'success', text: 'Order placed successfully!' })
      setSize('')
      const tpVal = parseFloat(tpPrice)
      const slVal = parseFloat(slPrice)
      if ((tpVal > 0 || slVal > 0) && selectedMarket) {
        try {
          await fetch(`${API_URL}/orders/tp-sl`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wallet_address: walletAddress,
              coin: selectedMarket.name,
              is_long: side === 'buy',
              size: roundedSize,
              sz_decimals: selectedMarket.sz_decimals || 5,
              tp_price: tpVal > 0 ? tpVal : null,
              sl_price: slVal > 0 ? slVal : null,
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

  const maxLev = selectedMarket?.max_leverage || 50

  return (
    <div style={{ display: 'flex', flexDirection: 'column',
      height: 'calc(100vh - 60px)', overflow: 'hidden' }}>

      {/* ── TOP BAR ──────────────────────────────────────────────────────── */}
      <div style={{ background: '#0d0d14', borderBottom: '1px solid #1a1a2e',
        padding: '10px 20px', display: 'flex', alignItems: 'center',
        gap: '28px', flexShrink: 0 }}>

        {/* Market name + DEX badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: 'white', fontWeight: '700', fontSize: '16px' }}>
            {selectedMarket?.name || '—'}
          </span>
          {selectedMarket && (
            <span style={{ fontSize: '10px', color: '#6b7280',
              background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px',
              fontWeight: '600', letterSpacing: '0.5px' }}>
              {selectedMarket.dex === 'main' ? 'HL' : selectedMarket.dex.toUpperCase()}
            </span>
          )}
        </div>

        <div style={{ width: '1px', height: '28px', background: '#1a1a2e' }} />

        {/* Mark price */}
        <div>
          <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Mark Price</div>
          <div style={{ color: priceColor, fontWeight: '700', fontSize: '18px', fontVariantNumeric: 'tabular-nums' }}>
            ${markPrice > 0 ? fmt(markPrice) : '—'}
          </div>
        </div>

        {/* 24h change */}
        <div>
          <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>24h Change</div>
          <div style={{ color: change24hColor, fontWeight: '600', fontSize: '14px' }}>
            {change24h !== 0 ? `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%` : '—'}
          </div>
        </div>

        {/* Funding rate */}
        <div>
          <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Funding (8h)</div>
          <div style={{ color: parseFloat(fundingPct) >= 0 ? '#00d4aa' : '#ef4444',
            fontWeight: '600', fontSize: '14px' }}>
            {selectedMarket ? `${parseFloat(fundingPct) >= 0 ? '+' : ''}${fundingPct}%` : '—'}
          </div>
        </div>

        {/* Max leverage */}
        {selectedMarket && (
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '1px' }}>Max Leverage</div>
            <div style={{ color: 'white', fontWeight: '600', fontSize: '14px' }}>
              {selectedMarket.max_leverage}x
            </div>
          </div>
        )}
      </div>

      {/* ── CONTENT ROW ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── LEFT COLUMN — Order Form (280px) ─────────────────────────── */}
        <div style={{ width: '280px', flexShrink: 0, display: 'flex',
          flexDirection: 'column', gap: '12px', overflowY: 'auto',
          padding: '12px', paddingBottom: '20px',
          borderRight: '1px solid #1a1a2e' }}>

          {/* Market Selector */}
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: '8px', padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600',
                letterSpacing: '1px' }}>
                MARKET
              </span>
              {!marketsLoading && (
                <span style={{ fontSize: '10px', color: '#4b5563' }}>
                  {markets.length} markets
                </span>
              )}
            </div>

            <div ref={marketSelectorRef} style={{ position: 'relative' }}>
              {showSearch ? (
                <input
                  autoFocus
                  type="text"
                  value={marketSearch}
                  onChange={e => setMarketSearch(e.target.value)}
                  placeholder="Search markets…"
                  style={{ width: '100%', background: '#0a0a0f', border: '1px solid #00d4aa',
                    borderRadius: '6px', padding: '10px 12px', color: 'white',
                    fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                />
              ) : (
                <div
                  onClick={() => setShowSearch(true)}
                  style={{ background: '#0a0a0f', border: '1px solid #1a1a2e',
                    borderRadius: '6px', padding: '10px 12px', cursor: 'pointer',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ color: marketsLoading ? '#6b7280' : 'white',
                      fontWeight: '700', fontSize: '15px' }}>
                      {marketsLoading ? 'Loading markets…' : (selectedMarket?.name || 'Select Market')}
                    </span>
                    {selectedMarket && (
                      <span style={{ fontSize: '10px', color: '#6b7280',
                        background: '#1a1a2e', padding: '2px 6px', borderRadius: '4px' }}>
                        {selectedMarket.dex === 'main' ? 'HL' : selectedMarket.dex.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span style={{ color: '#6b7280', fontSize: '10px' }}>▼</span>
                </div>
              )}

              {/* Dropdown */}
              {showSearch && (
                <div style={{ position: 'fixed',
                  top: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().bottom + 4 : 0,
                  left: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().left : 0,
                  width: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().width : 280,
                  background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: '6px',
                  maxHeight: '300px', overflowY: 'auto', zIndex: 9999 }}>
                  {dexGroups.map(dexName => {
                    const dexMarkets = filteredMarkets.filter(m => m.dex === dexName)
                    if (dexMarkets.length === 0) return null
                    return (
                      <div key={dexName}>
                        <div style={{ padding: '4px 12px', fontSize: '10px', color: '#6b7280',
                          background: '#0a0a0f', textTransform: 'uppercase', letterSpacing: '1px',
                          position: 'sticky', top: 0 }}>
                          {dexName === 'main' ? 'Hyperliquid' : dexName.toUpperCase() + ' DEX'}
                          <span style={{ marginLeft: '6px', color: '#374151' }}>
                            ({dexMarkets.length})
                          </span>
                        </div>
                        {dexMarkets.map(market => (
                          <div
                            key={market.name}
                            onClick={() => handleSelectMarket(market)}
                            style={{ padding: '8px 12px', cursor: 'pointer',
                              display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center',
                              background: selectedMarket?.name === market.name
                                ? '#1a1a2e' : 'transparent' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                            onMouseLeave={e => (e.currentTarget.style.background =
                              selectedMarket?.name === market.name ? '#1a1a2e' : 'transparent')}
                          >
                            <span style={{ color: 'white', fontSize: '13px', fontWeight: '500' }}>
                              {market.name}
                            </span>
                            <span style={{ color: '#6b7280', fontSize: '12px',
                              fontVariantNumeric: 'tabular-nums' }}>
                              {market.mark_price > 0
                                ? `$${fmt(market.mark_price)}`
                                : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                  {filteredMarkets.length === 0 && (
                    <div style={{ padding: '16px', textAlign: 'center',
                      fontSize: '13px', color: '#6b7280' }}>
                      No markets found
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Order Type */}
          <div style={{ display: 'flex', background: '#0d0d14',
            border: '1px solid #1a1a2e', borderRadius: '8px', overflow: 'hidden',
            position: 'relative', zIndex: 1, flexShrink: 0 }}>
            {(['market', 'limit'] as const).map(type => (
              <button key={type} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSearch(false); setMarketSearch(''); setOrderType(type) }} style={{
                flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
                background: orderType === type ? '#1a1a2e' : 'transparent',
                color: orderType === type ? '#00d4aa' : '#6b7280',
                fontSize: '13px', fontWeight: '600', textTransform: 'capitalize',
              }}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>

          {/* Side */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setShowSearch(false); setMarketSearch(''); setSide('buy') }} style={{
              flex: 1, padding: '12px', cursor: 'pointer',
              borderRadius: '8px', fontWeight: '700', fontSize: '14px',
              background: side === 'buy' ? '#00d4aa' : '#0d0d14',
              color: side === 'buy' ? '#0a0a0f' : '#6b7280',
              border: `1px solid ${side === 'buy' ? '#00d4aa' : '#1a1a2e'}`,
            }}>
              Buy / Long
            </button>
            <button onClick={() => { setShowSearch(false); setMarketSearch(''); setSide('sell') }} style={{
              flex: 1, padding: '12px', cursor: 'pointer',
              borderRadius: '8px', fontWeight: '700', fontSize: '14px',
              background: side === 'sell' ? '#ef4444' : '#0d0d14',
              color: side === 'sell' ? 'white' : '#6b7280',
              border: `1px solid ${side === 'sell' ? '#ef4444' : '#1a1a2e'}`,
            }}>
              Sell / Short
            </button>
          </div>

          {/* Inputs */}
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: '8px', padding: '12px', display: 'flex',
            flexDirection: 'column', gap: '12px' }}>

            {orderType === 'limit' && (
              <div>
                <label style={{ fontSize: '11px', color: '#6b7280',
                  display: 'block', marginBottom: '4px', letterSpacing: '0.5px' }}>
                  LIMIT PRICE (USD)
                </label>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={e => setLimitPrice(e.target.value)}
                  placeholder={markPrice > 0 ? markPrice.toFixed(2) : '0.00'}
                  style={{ width: '100%', background: '#0a0a0f', border: '1px solid #1a1a2e',
                    borderRadius: '6px', padding: '8px 12px', color: 'white',
                    fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
                />
              </div>
            )}

            <div>
              <label style={{ fontSize: '11px', color: '#6b7280',
                display: 'block', marginBottom: '4px', letterSpacing: '0.5px' }}>
                SIZE (USD)
              </label>
              <input
                type="number"
                value={size}
                onChange={e => setSize(e.target.value)}
                placeholder="0.00"
                style={{ width: '100%', background: '#0a0a0f', border: '1px solid #1a1a2e',
                  borderRadius: '6px', padding: '8px 12px', color: 'white',
                  fontSize: '14px', boxSizing: 'border-box', outline: 'none' }}
                onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
              />
              {sizeNum > 0 && selectedMarket && (
                <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                  ≈ {assetSize.toFixed(selectedMarket.sz_decimals)} {selectedMarket.display_name}
                </div>
              )}
            </div>

            {/* Leverage */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <label style={{ fontSize: '11px', color: '#6b7280', letterSpacing: '0.5px' }}>
                  LEVERAGE
                </label>
                <span style={{ fontSize: '13px', color: '#00d4aa', fontWeight: '700' }}>
                  {leverage}x
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={maxLev}
                value={leverage}
                onChange={e => setLeverage(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#00d4aa', margin: '4px 0' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                {LEVERAGE_TICKS.filter(v => v <= maxLev).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setLeverage(v)}
                    style={{
                      fontSize: '10px', padding: '2px 4px', border: 'none',
                      borderRadius: '3px', cursor: 'pointer',
                      background: leverage === v ? '#00d4aa22' : 'transparent',
                      color: leverage === v ? '#00d4aa' : '#4b5563',
                      fontWeight: leverage === v ? '700' : '400',
                    }}
                  >
                    {v}x
                  </button>
                ))}
                {maxLev > 50 && (
                  <button
                    type="button"
                    onClick={() => setLeverage(maxLev)}
                    style={{
                      fontSize: '10px', padding: '2px 4px', border: 'none',
                      borderRadius: '3px', cursor: 'pointer',
                      background: leverage === maxLev ? '#00d4aa22' : 'transparent',
                      color: leverage === maxLev ? '#00d4aa' : '#4b5563',
                    }}
                  >
                    {maxLev}x
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Order Summary */}
          <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e',
            borderRadius: '8px', padding: '12px' }}>
            {([
              ['Entry Price', entryPrice > 0 ? `$${fmt(entryPrice)}` : '—'],
              ['Size', sizeNum > 0 ? `$${sizeNum.toFixed(2)}` : '—'],
              ['Leverage', `${leverage}x`],
              ['Est. Liq. Price', sizeNum > 0 && entryPrice > 0 ? `$${fmt(liqPrice)}` : '—'],
              [`Fee (${orderType === 'market' ? '0.035%' : '0.01%'})`, sizeNum > 0 ? `$${fee.toFixed(4)}` : '—'],
              ['Funding Rate (8h)', `${parseFloat(fundingPct) >= 0 ? '+' : ''}${fundingPct}%`],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between',
                padding: '4px 0', borderBottom: '1px solid #0a0a0f' }}>
                <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}</span>
                <span style={{ fontSize: '11px', color: 'white' }}>{value}</span>
              </div>
            ))}
          </div>

          {/* TP / SL */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em' }}>TAKE PROFIT / STOP LOSS <span style={{ fontWeight: 400, color: '#4b5563' }}>(optional)</span></p>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>Take Profit (USD)</p>
                <input
                  type="number"
                  placeholder="TP Price"
                  value={tpPrice}
                  onChange={e => setTpPrice(e.target.value)}
                  style={{ width: '100%', background: '#13131f', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#10b981', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 3 }}>Stop Loss (USD)</p>
                <input
                  type="number"
                  placeholder="SL Price"
                  value={slPrice}
                  onChange={e => setSlPrice(e.target.value)}
                  style={{ width: '100%', background: '#13131f', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#ef4444', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            </div>
          </div>

          {/* Order Message */}
          {orderMessage && (
            <div style={{
              padding: '10px', borderRadius: '6px', fontSize: '13px', textAlign: 'center',
              background: orderMessage.type === 'success'
                ? 'rgba(0,212,170,0.1)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${orderMessage.type === 'success' ? '#00d4aa' : '#ef4444'}`,
              color: orderMessage.type === 'success' ? '#00d4aa' : '#ef4444',
            }}>
              {orderMessage.text}
            </div>
          )}

          {/* Place Order Button */}
          <button
            onClick={handlePlaceOrder}
            disabled={placing || sizeNum <= 0 || !selectedMarket}
            style={{
              width: '100%', padding: '14px', border: 'none', cursor: 'pointer',
              borderRadius: '8px', fontWeight: '700', fontSize: '15px',
              background: placing || sizeNum <= 0
                ? '#1a1a2e'
                : side === 'buy' ? '#00d4aa' : '#ef4444',
              color: placing || sizeNum <= 0
                ? '#6b7280'
                : side === 'buy' ? '#0a0a0f' : 'white',
            }}
          >
            {placing ? 'Placing…' : `Place ${side === 'buy' ? 'Buy' : 'Sell'} Order`}
          </button>
        </div>

        {/* ── MIDDLE COLUMN — Order Book (collapsible ~180px) ─────────── */}
        <div style={{
          width: obCollapsed ? '28px' : '180px', flexShrink: 0,
          borderRight: '1px solid #1a1a2e',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width 0.15s ease',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center',
            justifyContent: obCollapsed ? 'center' : 'space-between',
            padding: obCollapsed ? '10px 0' : '6px 8px',
            borderBottom: '1px solid #1a1a2e', flexShrink: 0, minHeight: '32px',
          }}>
            {!obCollapsed && (
              <div style={{ overflow: 'hidden' }}>
                <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600' }}>
                  Order Book
                </span>
                {spread > 0 && markPrice > 0 && (
                  <span style={{ fontSize: '9px', color: '#4b5563', marginLeft: '5px',
                    whiteSpace: 'nowrap' }}>
                    {spread.toFixed(2)} | {((spread / markPrice) * 100).toFixed(3)}%
                  </span>
                )}
              </div>
            )}
            <button
              onClick={() => setObCollapsed(v => !v)}
              style={{ background: 'none', border: 'none', cursor: 'pointer',
                color: '#6b7280', fontSize: '14px', padding: '0', lineHeight: 1,
                flexShrink: 0 }}
            >
              {obCollapsed ? '›' : '‹'}
            </button>
          </div>

          {/* Book content */}
          {!obCollapsed && (
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex',
              flexDirection: 'column',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>

              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr',
                padding: '3px 6px', fontSize: '9px', color: '#4b5563', flexShrink: 0,
                borderBottom: '1px solid #0d0d14' }}>
                <span>Price</span>
                <span style={{ textAlign: 'right' }}>Size</span>
                <span style={{ textAlign: 'right' }}>Total</span>
              </div>

              {/* Asks — lowest ask at bottom, cumulative depth bars */}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex',
                flexDirection: 'column', justifyContent: 'flex-end' }}>
                {(() => {
                  const asks = orderbook.asks.slice(0, 10)
                  let cum = 0
                  const withCum = asks.map((a: any) => {
                    cum += parseFloat(a[0]) * parseFloat(a[1])
                    return { price: a[0], size: a[1], total: cum }
                  })
                  const maxCum = cum || 1
                  return [...withCum].reverse().map((ask, i) => (
                    <div key={i} style={{ position: 'relative', height: '22px',
                      display: 'flex', alignItems: 'center' }}>
                      <div style={{
                        position: 'absolute', right: 0, top: 0, bottom: 0,
                        width: `${(ask.total / maxCum) * 100}%`,
                        background: 'rgba(239,68,68,0.10)',
                      }} />
                      <div style={{ position: 'relative', width: '100%',
                        display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr',
                        padding: '0 6px', fontSize: '11px' }}>
                        <span style={{ color: '#f87171', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(ask.price).toLocaleString('en-US',
                            { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ color: '#9ca3af', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(ask.size).toFixed(3)}
                        </span>
                        <span style={{ color: '#6b7280', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums', fontSize: '10px' }}>
                          {fmtQty(ask.total)}
                        </span>
                      </div>
                    </div>
                  ))
                })()}
              </div>

              {/* Mark price / spread divider */}
              <div style={{ padding: '4px 6px', background: '#0a0a0f', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderTop: '1px solid #1a1a2e', borderBottom: '1px solid #1a1a2e' }}>
                <span style={{ fontSize: '12px', color: priceColor, fontWeight: '700',
                  fontVariantNumeric: 'tabular-nums' }}>
                  {markPrice > 0 ? fmt(markPrice) : '—'}
                </span>
                {spread > 0 && markPrice > 0 && (
                  <span style={{ fontSize: '9px', color: '#4b5563' }}>
                    {((spread / markPrice) * 100).toFixed(3)}%
                  </span>
                )}
              </div>

              {/* Bids — highest bid at top, cumulative depth bars */}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {(() => {
                  const bids = orderbook.bids.slice(0, 10)
                  let cum = 0
                  const withCum = bids.map((b: any) => {
                    cum += parseFloat(b[0]) * parseFloat(b[1])
                    return { price: b[0], size: b[1], total: cum }
                  })
                  const maxCum = cum || 1
                  return withCum.map((bid, i) => (
                    <div key={i} style={{ position: 'relative', height: '22px',
                      display: 'flex', alignItems: 'center' }}>
                      <div style={{
                        position: 'absolute', right: 0, top: 0, bottom: 0,
                        width: `${(bid.total / maxCum) * 100}%`,
                        background: 'rgba(0,212,170,0.10)',
                      }} />
                      <div style={{ position: 'relative', width: '100%',
                        display: 'grid', gridTemplateColumns: '2fr 1.5fr 2fr',
                        padding: '0 6px', fontSize: '11px' }}>
                        <span style={{ color: '#34d399', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(bid.price).toLocaleString('en-US',
                            { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ color: '#9ca3af', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(bid.size).toFixed(3)}
                        </span>
                        <span style={{ color: '#6b7280', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums', fontSize: '10px' }}>
                          {fmtQty(bid.total)}
                        </span>
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN — Chart + Open Positions ────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', minWidth: 0 }}>

          {/* Chart */}
          <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            {selectedMarket && (
              <HLChart
                symbol={selectedMarket.name}
                height={undefined}
                positions={openPositions}
                openOrders={openOrders}
                initialInterval={initialInterval}
              />
            )}
          </div>

          {/* Open Positions */}
          <div style={{ borderTop: '1px solid #1a1a2e', flexShrink: 0,
            background: '#0d0d14' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '5px 12px', borderBottom: posCollapsed ? 'none' : '1px solid #0a0a0f',
              userSelect: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px',
                cursor: 'pointer', flex: 1 }}
                onClick={() => setPosCollapsed(v => !v)}>
                <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600' }}>
                  Positions
                </span>
                {openPositions.length > 0 && (
                  <span style={{ fontSize: '10px', color: '#00d4aa',
                    background: 'rgba(0,212,170,0.1)', padding: '1px 6px',
                    borderRadius: '10px' }}>
                    {openPositions.length}
                  </span>
                )}
                <span style={{ color: '#4b5563', fontSize: '10px', marginLeft: '4px' }}>
                  {posCollapsed ? '▲' : '▼'}
                </span>
              </div>
              {openPositions.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setManagingPos('close-all') }}
                  style={{ fontSize: '10px', padding: '2px 10px',
                    border: '1px solid #ef4444', borderRadius: '4px',
                    background: 'transparent', color: '#ef4444',
                    cursor: 'pointer', flexShrink: 0 }}
                >
                  Close All
                </button>
              )}
            </div>

            {!posCollapsed && (
              <div style={{ maxHeight: '200px', overflowY: 'auto', overflowX: 'auto' }}>
                {openPositions.length === 0 ? (
                  <div style={{ padding: '12px', textAlign: 'center',
                    fontSize: '12px', color: '#4b5563' }}>
                    No open positions
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse',
                    fontSize: '11px',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    minWidth: '900px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #1a1a2e' }}>
                        {['Coin', 'Size', 'Value', 'Entry Px', 'Mark Px',
                          'PnL (ROE%)', 'Liq. Px', 'Margin', 'Funding', 'Actions'].map(h => (
                          <th key={h} style={{ padding: '4px 10px', color: '#6b7280',
                            fontWeight: '500', textAlign: 'left', whiteSpace: 'nowrap',
                            fontSize: '10px', letterSpacing: '0.3px',
                            fontFamily: 'system-ui, sans-serif' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {openPositions.map((pos: any, i: number) => {
                        const coin = pos.coin || pos.symbol || '?'
                        const szi = parseFloat(pos.szi || pos.size || '0')
                        const isLong = szi > 0
                        const absSzi = Math.abs(szi)
                        const entryPx = parseFloat(pos.entryPx || pos.entry_price || '0')
                        const posMarkPx = parseFloat(pos.markPx || '0') ||
                          (coin === selectedMarket?.name ? markPrice : 0)
                        const pnl = parseFloat(pos.unrealizedPnl || pos.pnl || '0')
                        const levVal = pos.leverage?.value || pos.leverage || 1
                        const margin = parseFloat(pos.marginUsed || '0') ||
                          (entryPx > 0 ? (absSzi * entryPx) / levVal : 0)
                        const roe = margin > 0 ? (pnl / margin) * 100 : 0
                        const liqPx = parseFloat(pos.liquidationPx || pos.liq_price || '0')
                        const posValue = absSzi * (posMarkPx || entryPx)
                        const funding = parseFloat(
                          pos.cumFunding?.sinceOpen || pos.cumFunding?.allTime ||
                          pos.funding || '0'
                        )
                        const levColor = levVal >= 20 ? '#f87171'
                          : levVal >= 10 ? '#fb923c' : '#a3e635'
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #0a0a0f' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#0f0f1a')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            {/* Coin + Leverage badge */}
                            <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px',
                                fontFamily: 'system-ui, sans-serif' }}>
                                <span style={{ color: 'white', fontWeight: '600' }}>{coin}</span>
                                <span style={{ fontSize: '9px', fontWeight: '700',
                                  background: `${levColor}22`, color: levColor,
                                  padding: '1px 4px', borderRadius: '3px' }}>
                                  {levVal}x
                                </span>
                              </div>
                              <div style={{ fontSize: '9px',
                                color: isLong ? '#34d399' : '#f87171',
                                fontFamily: 'system-ui, sans-serif', marginTop: '1px' }}>
                                {isLong ? 'Long' : 'Short'}
                              </div>
                            </td>
                            {/* Size */}
                            <td style={{ padding: '5px 10px',
                              color: isLong ? '#34d399' : '#f87171',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {isLong ? '+' : '-'}{absSzi.toFixed(4)}
                            </td>
                            {/* Position Value */}
                            <td style={{ padding: '5px 10px', color: '#9ca3af',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {posValue > 0 ? `$${fmtQty(posValue)}` : '—'}
                            </td>
                            {/* Entry Px */}
                            <td style={{ padding: '5px 10px', color: '#9ca3af',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {entryPx > 0 ? `$${fmt(entryPx)}` : '—'}
                            </td>
                            {/* Mark Px */}
                            <td style={{ padding: '5px 10px', color: 'white',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {posMarkPx > 0 ? `$${fmt(posMarkPx)}` : '—'}
                            </td>
                            {/* PnL + ROE */}
                            <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>
                              <div style={{ color: pnl >= 0 ? '#34d399' : '#f87171',
                                fontVariantNumeric: 'tabular-nums', fontWeight: '600' }}>
                                {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                              </div>
                              <div style={{ fontSize: '9px',
                                color: roe >= 0 ? '#34d399' : '#f87171',
                                fontVariantNumeric: 'tabular-nums' }}>
                                ({roe >= 0 ? '+' : ''}{roe.toFixed(2)}%)
                              </div>
                            </td>
                            {/* Liq Px */}
                            <td style={{ padding: '5px 10px', color: '#f87171',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {liqPx > 0 ? `$${fmt(liqPx)}` : '—'}
                            </td>
                            {/* Margin */}
                            <td style={{ padding: '5px 10px', color: '#9ca3af',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {margin > 0 ? `$${margin.toFixed(2)}` : '—'}
                            </td>
                            {/* Funding */}
                            <td style={{ padding: '5px 10px',
                              color: funding >= 0 ? '#34d399' : '#f87171',
                              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {funding !== 0
                                ? `${funding >= 0 ? '+' : ''}${funding.toFixed(4)}`
                                : '—'}
                            </td>
                            {/* Actions */}
                            <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button
                                  onClick={() => setManagingPos(pos)}
                                  style={{ fontSize: '10px', padding: '2px 6px',
                                    border: '1px solid #374151', borderRadius: '3px',
                                    background: 'transparent', color: '#9ca3af',
                                    cursor: 'pointer',
                                    fontFamily: 'system-ui, sans-serif' }}
                                >
                                  TP/SL
                                </button>
                                <button
                                  onClick={() => setManagingPos(pos)}
                                  style={{ fontSize: '10px', padding: '2px 6px',
                                    border: '1px solid #ef4444', borderRadius: '3px',
                                    background: 'transparent', color: '#ef4444',
                                    cursor: 'pointer',
                                    fontFamily: 'system-ui, sans-serif' }}
                                >
                                  Close
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Click outside to close market search */}
      {showSearch && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 100 }}
          onClick={() => { setShowSearch(false); setMarketSearch('') }}
        />
      )}

      {/* Position Manager Modal */}
      {managingPos && selectedMarket && (
        <PositionModal
          pos={managingPos}
          walletAddress={walletAddress}
          onClose={() => setManagingPos(null)}
          onAction={() => setManagingPos(null)}
        />
      )}
    </div>
  )
}
