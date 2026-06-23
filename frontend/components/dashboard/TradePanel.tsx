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

  const matchingPositions = openPositions.filter(p =>
    (p.coin || p.symbol) === selectedMarket?.name
  )

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

        {/* ── MIDDLE COLUMN — Order Book (collapsible) ─────────────────── */}
        <div style={{
          width: obCollapsed ? '28px' : '160px', flexShrink: 0,
          borderRight: '1px solid #1a1a2e',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width 0.15s ease',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center',
            justifyContent: obCollapsed ? 'center' : 'space-between',
            padding: obCollapsed ? '10px 0' : '8px 10px',
            borderBottom: '1px solid #1a1a2e', flexShrink: 0,
          }}>
            {!obCollapsed && (
              <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600',
                letterSpacing: '1px', whiteSpace: 'nowrap' }}>
                ORDER BOOK
              </span>
            )}
            <button
              onClick={() => setObCollapsed(v => !v)}
              style={{ background: 'none', border: 'none', cursor: 'pointer',
                color: '#6b7280', fontSize: '14px', padding: '0', lineHeight: 1 }}
            >
              {obCollapsed ? '›' : '‹'}
            </button>
          </div>

          {/* Book content */}
          {!obCollapsed && (
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Column headers */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                padding: '4px 10px', fontSize: '9px', color: '#4b5563', flexShrink: 0 }}>
                <span>Price</span>
                <span style={{ textAlign: 'right' }}>Size</span>
              </div>

              {/* Asks (reversed — lowest ask at bottom, near spread) */}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex',
                flexDirection: 'column', justifyContent: 'flex-end' }}>
                {(() => {
                  const asks = orderbook.asks.slice(0, 10)
                  const maxAsk = asks.length > 0
                    ? Math.max(...asks.map((a: any) => parseFloat(a[1])))
                    : 1
                  return [...asks].reverse().map((ask: any, i: number) => (
                    <div key={i} style={{ position: 'relative', padding: '1px 10px' }}>
                      <div style={{
                        position: 'absolute', left: 0, top: 0, bottom: 0,
                        width: `${(parseFloat(ask[1]) / maxAsk) * 100}%`,
                        background: 'rgba(239,68,68,0.12)',
                      }} />
                      <div style={{ position: 'relative', display: 'grid',
                        gridTemplateColumns: '1fr 1fr', fontSize: '11px' }}>
                        <span style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(ask[0]).toLocaleString('en-US',
                            { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ color: '#6b7280', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(ask[1]).toFixed(3)}
                        </span>
                      </div>
                    </div>
                  ))
                })()}
              </div>

              {/* Spread row */}
              <div style={{ padding: '4px 10px', background: '#0a0a0f', flexShrink: 0,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderTop: '1px solid #1a1a2e', borderBottom: '1px solid #1a1a2e' }}>
                <span style={{ fontSize: '11px', color: 'white', fontWeight: '600',
                  fontVariantNumeric: 'tabular-nums' }}>
                  ${markPrice > 0 ? fmt(markPrice) : '—'}
                </span>
                {spread > 0 && (
                  <span style={{ fontSize: '9px', color: '#4b5563',
                    fontVariantNumeric: 'tabular-nums' }}>
                    {spread.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Bids */}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {(() => {
                  const bids = orderbook.bids.slice(0, 10)
                  const maxBid = bids.length > 0
                    ? Math.max(...bids.map((b: any) => parseFloat(b[1])))
                    : 1
                  return bids.map((bid: any, i: number) => (
                    <div key={i} style={{ position: 'relative', padding: '1px 10px' }}>
                      <div style={{
                        position: 'absolute', right: 0, top: 0, bottom: 0,
                        width: `${(parseFloat(bid[1]) / maxBid) * 100}%`,
                        background: 'rgba(0,212,170,0.12)',
                      }} />
                      <div style={{ position: 'relative', display: 'grid',
                        gridTemplateColumns: '1fr 1fr', fontSize: '11px' }}>
                        <span style={{ color: '#00d4aa', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(bid[0]).toLocaleString('en-US',
                            { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ color: '#6b7280', textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(bid[1]).toFixed(3)}
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
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 12px', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setPosCollapsed(v => !v)}
            >
              <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600',
                letterSpacing: '1px' }}>
                OPEN POSITIONS
                {matchingPositions.length > 0 && (
                  <span style={{ color: '#00d4aa', marginLeft: '6px' }}>
                    ({matchingPositions.length})
                  </span>
                )}
                {selectedMarket && (
                  <span style={{ color: '#374151', marginLeft: '6px', fontWeight: '400' }}>
                    — {selectedMarket.name}
                  </span>
                )}
              </span>
              <span style={{ color: '#6b7280', fontSize: '10px' }}>
                {posCollapsed ? '▲' : '▼'}
              </span>
            </div>

            {!posCollapsed && (
              <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                {matchingPositions.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: '12px',
                    color: '#4b5563', textAlign: 'center' }}>
                    No open positions for {selectedMarket?.name || '—'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #1a1a2e' }}>
                        {['Side', 'Size', 'Entry', 'Mark', 'PnL', ''].map(h => (
                          <th key={h} style={{ padding: '4px 8px', color: '#4b5563',
                            fontWeight: '500', textAlign: h === '' ? 'right' : 'left' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matchingPositions.map((pos: any, i: number) => {
                        const isLong = parseFloat(pos.szi || pos.size || '0') > 0
                        const pnl = parseFloat(pos.unrealizedPnl || pos.pnl || '0')
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #0a0a0f' }}>
                            <td style={{ padding: '5px 8px',
                              color: isLong ? '#00d4aa' : '#ef4444', fontWeight: '600' }}>
                              {isLong ? 'Long' : 'Short'}
                            </td>
                            <td style={{ padding: '5px 8px', color: 'white',
                              fontVariantNumeric: 'tabular-nums' }}>
                              {Math.abs(parseFloat(pos.szi || pos.size || '0')).toFixed(4)}
                            </td>
                            <td style={{ padding: '5px 8px', color: '#9ca3af',
                              fontVariantNumeric: 'tabular-nums' }}>
                              ${fmt(parseFloat(pos.entryPx || pos.entry_price || '0'))}
                            </td>
                            <td style={{ padding: '5px 8px', color: '#9ca3af',
                              fontVariantNumeric: 'tabular-nums' }}>
                              ${fmt(markPrice)}
                            </td>
                            <td style={{ padding: '5px 8px',
                              color: pnl >= 0 ? '#00d4aa' : '#ef4444',
                              fontVariantNumeric: 'tabular-nums' }}>
                              {fmtPnl(pnl)}
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                              <button
                                onClick={() => setManagingPos(pos)}
                                style={{ fontSize: '10px', padding: '2px 8px',
                                  border: '1px solid #374151', borderRadius: '4px',
                                  background: 'transparent', color: '#9ca3af',
                                  cursor: 'pointer' }}
                              >
                                Manage
                              </button>
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
