'use client'
import { useState, useEffect, useRef } from 'react'
import HLChart from './HLChart'

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
  initialMarket?: { symbol: string, dex: string } | null
  initialInterval?: string
}

const fmt = (n: number, dec = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) })

const LEVERAGE_TICKS = [1, 5, 10, 25, 50]

export function TradePanel({ walletAddress, openPositions = [], initialMarket = null, initialInterval }: Props) {
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
  const [recentTrades, setRecentTrades] = useState<any[]>([])
  const [markPrice, setMarkPrice] = useState(0)
  const [prevMarkPrice, setPrevMarkPrice] = useState(0)

  // Chart resize
  const [chartHeight, setChartHeight] = useState(420)
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<HTMLDivElement>(null)
  const marketSelectorRef = useRef<HTMLDivElement>(null)

  // Load all markets on mount
  useEffect(() => {
    const loadMarkets = async () => {
      try {
        const res = await fetch(`${API_URL}/market/all`)
        const data: Market[] = await res.json()
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
        // Derive mid price from orderbook (works for ALL assets including HIP-3)
        let newPrice: string | undefined
        if (ob?.bids?.length && ob?.asks?.length) {
          const bestBid = parseFloat(ob.bids[0]?.[0] || '0')
          const bestAsk = parseFloat(ob.asks[0]?.[0] || '0')
          if (bestBid > 0 && bestAsk > 0) {
            newPrice = ((bestBid + bestAsk) / 2).toString()
          }
        }
        // Fallback to /market/prices for top 10 assets if orderbook mid unavailable
        if (!newPrice) {
          newPrice = prices.prices?.[selectedMarket.name] ||
            prices.prices?.[selectedMarket.display_name]
        }

        // Final fallback: stale market price
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

  // Poll recent trades every 5 seconds
  useEffect(() => {
    if (!selectedMarket) return
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/market/trades/${encodeURIComponent(selectedMarket.name)}`)
        const data = await res.json()
        setRecentTrades(data)
      } catch { /* silent */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
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

    // Round size client-side to catch zero-size before hitting the API
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
      // Set leverage on Hyperliquid before placing order
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
        // non-blocking — proceed even if leverage set fails
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
      // Check for Hyperliquid-level order rejection (HTTP 200 but error in payload)
      const statuses = data?.result?.response?.data?.statuses
      const firstStatus = Array.isArray(statuses) ? statuses[0] : null
      if (firstStatus?.error) {
        setOrderMessage({ type: 'error', text: firstStatus.error })
        return
      }
      // Genuine success
      setOrderMessage({ type: 'success', text: 'Order placed successfully!' })
      setSize('')
      // Place TP/SL if set
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

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    const startY = e.clientY
    const startHeight = chartHeight

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY
      const newHeight = Math.max(200, Math.min(700, startHeight + delta))
      setChartHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

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

        {/* Divider */}
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
      <div style={{ flex: 1, display: 'flex', gap: '16px',
        padding: '16px', overflow: 'hidden' }}>

        {/* ── LEFT COLUMN — Order Form (320px) ─────────────────────────── */}
        <div style={{ width: '320px', flexShrink: 0, display: 'flex',
          flexDirection: 'column', gap: '12px', overflowY: 'auto', paddingBottom: '20px' }}>

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
              {/* Display vs search toggle */}
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
                  width: marketSelectorRef.current ? marketSelectorRef.current.getBoundingClientRect().width : 320,
                  background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: '6px',
                  maxHeight: '300px', overflowY: 'auto', zIndex: 9999, marginTop: '0px' }}>
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
              {/* Tick marks */}
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

        {/* ── RIGHT COLUMN — Chart + Orderbook ─────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', minWidth: 0,
          cursor: isResizing ? 'row-resize' : 'default' }}>

          {/* Chart */}
          {selectedMarket && (
            <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e',
              borderRadius: '8px', overflow: 'hidden', flexShrink: 0,
              height: chartHeight }}>
              <HLChart symbol={selectedMarket.name} height={chartHeight} positions={openPositions} initialInterval={initialInterval} />
            </div>
          )}

          {/* Drag-to-resize handle */}
          <div
            ref={resizeRef}
            onMouseDown={handleMouseDown}
            style={{ height: '6px', background: '#1a1a2e', cursor: 'row-resize',
              borderRadius: '3px', margin: '6px 0', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <div style={{ width: '40px', height: '3px',
              background: '#374151', borderRadius: '2px' }} />
          </div>

          {/* Orderbook + Recent Trades */}
          <div style={{ display: 'flex', gap: '12px', flex: 1, minHeight: '200px',
            overflow: 'hidden' }}>

            {/* Orderbook */}
            <div style={{ flex: 1, background: '#0d0d14', border: '1px solid #1a1a2e',
              borderRadius: '8px', padding: '12px', overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600',
                  textTransform: 'uppercase', letterSpacing: '1px' }}>
                  Order Book
                </span>
                {orderbook.bids.length > 0 && orderbook.asks.length > 0 && (
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>
                    Spread: ${(
                      parseFloat(orderbook.asks[0]?.[0] || '0') -
                      parseFloat(orderbook.bids[0]?.[0] || '0')
                    ).toFixed(2)}
                  </span>
                )}
              </div>

              {/* Cumulative depth */}
              <div style={{ display: 'flex', justifyContent: 'space-between',
                padding: '3px 6px', marginBottom: '6px', fontSize: '11px',
                background: '#0a0a0f', borderRadius: '4px' }}>
                <span style={{ color: '#00d4aa' }}>
                  B: ${orderbook.bids.slice(0, 12).reduce((sum: number, b: any) =>
                    sum + parseFloat(b[1]) * parseFloat(b[0]), 0).toFixed(0)}
                </span>
                <span style={{ color: '#ef4444' }}>
                  A: ${orderbook.asks.slice(0, 12).reduce((sum: number, a: any) =>
                    sum + parseFloat(a[1]) * parseFloat(a[0]), 0).toFixed(0)}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {/* Bids */}
                {(() => {
                  const maxBidSize = Math.max(...orderbook.bids.slice(0, 12).map((b: any) => parseFloat(b[1])))
                  return (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                        fontSize: '10px', color: '#4b5563', marginBottom: '4px',
                        paddingBottom: '3px', borderBottom: '1px solid #1a1a2e' }}>
                        <span>Price</span><span style={{ textAlign: 'right' }}>Size</span>
                      </div>
                      {orderbook.bids.slice(0, 12).map((bid: any, i: number) => (
                        <div key={i} style={{ position: 'relative', padding: '2px 0' }}>
                          <div style={{
                            position: 'absolute', right: 0, top: 0, bottom: 0,
                            width: `${(parseFloat(bid[1]) / maxBidSize) * 100}%`,
                            background: 'rgba(0,212,170,0.12)', borderRadius: '2px',
                          }} />
                          <div style={{
                            position: 'relative', zIndex: 1,
                            display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: '12px',
                          }}>
                            <span style={{ color: '#00d4aa', fontVariantNumeric: 'tabular-nums' }}>
                              {parseFloat(bid[0]).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ color: '#9ca3af', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                              {parseFloat(bid[1]).toFixed(4)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {/* Asks */}
                {(() => {
                  const maxAskSize = Math.max(...orderbook.asks.slice(0, 12).map((a: any) => parseFloat(a[1])))
                  return (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                        fontSize: '10px', color: '#4b5563', marginBottom: '4px',
                        paddingBottom: '3px', borderBottom: '1px solid #1a1a2e' }}>
                        <span>Price</span><span style={{ textAlign: 'right' }}>Size</span>
                      </div>
                      {orderbook.asks.slice(0, 12).map((ask: any, i: number) => (
                        <div key={i} style={{ position: 'relative', padding: '2px 0' }}>
                          <div style={{
                            position: 'absolute', left: 0, top: 0, bottom: 0,
                            width: `${(parseFloat(ask[1]) / maxAskSize) * 100}%`,
                            background: 'rgba(239,68,68,0.12)', borderRadius: '2px',
                          }} />
                          <div style={{
                            position: 'relative', zIndex: 1,
                            display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: '12px',
                          }}>
                            <span style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                              {parseFloat(ask[0]).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ color: '#9ca3af', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                              {parseFloat(ask[1]).toFixed(4)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            </div>

            {/* Recent Trades */}
            <div style={{ width: '220px', flexShrink: 0, background: '#0d0d14',
              border: '1px solid #1a1a2e', borderRadius: '8px', padding: '12px',
              overflow: 'hidden' }}>
              <div style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600',
                textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>
                Recent Trades
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                fontSize: '10px', color: '#4b5563', marginBottom: '4px',
                paddingBottom: '3px', borderBottom: '1px solid #1a1a2e' }}>
                <span>Price</span><span>Size</span><span>Time</span>
              </div>
              {recentTrades.slice(0, 15).map((trade: any, i: number) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                  fontSize: '11px', padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: trade.side === 'B' ? '#00d4aa' : '#ef4444' }}>
                    {parseFloat(trade.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                  <span style={{ color: '#6b7280' }}>
                    {parseFloat(trade.size).toFixed(3)}
                  </span>
                  <span style={{ color: '#4b5563' }}>
                    {new Date(trade.time).toLocaleTimeString('en-US',
                      { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
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
    </div>
  )
}
