'use client'
import { useState, useEffect } from 'react'
import TradingViewChart from './TradingViewChart'

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
}

const fmt = (n: number, dec = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) })

const LEVERAGE_TICKS = [1, 5, 10, 25, 50]

export function TradePanel({ walletAddress }: Props) {
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

  // Market data
  const [orderbook, setOrderbook] = useState<{ bids: string[][]; asks: string[][] }>({ bids: [], asks: [] })
  const [recentTrades, setRecentTrades] = useState<any[]>([])
  const [markPrice, setMarkPrice] = useState(0)
  const [prevMarkPrice, setPrevMarkPrice] = useState(0)

  // Load all markets on mount
  useEffect(() => {
    const loadMarkets = async () => {
      try {
        const res = await fetch(`${API_URL}/market/all`)
        const data: Market[] = await res.json()
        setMarkets(data)
        const btc = data.find(m => m.name === 'BTC')
        if (btc) {
          setSelectedMarket(btc)
          setMarkPrice(btc.mark_price)
          setLeverage(Math.min(10, btc.max_leverage))
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
        const newPrice =
          prices.prices?.[selectedMarket.name] ||
          prices.prices?.[selectedMarket.display_name] ||
          selectedMarket.mark_price
        if (newPrice) {
          setPrevMarkPrice(p => p || parseFloat(newPrice))
          setMarkPrice(prev => { setPrevMarkPrice(prev || parseFloat(newPrice)); return parseFloat(newPrice) })
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
  const assetSize = entryPrice > 0 ? sizeNum / entryPrice : 0
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
  const dexGroups = [...new Set(markets.map(m => m.dex))]

  const filteredMarkets = markets.filter(m =>
    m.name.toLowerCase().includes(marketSearch.toLowerCase()) ||
    m.display_name.toLowerCase().includes(marketSearch.toLowerCase())
  )

  const handleSelectMarket = (market: Market) => {
    setSelectedMarket(market)
    setMarkPrice(market.mark_price)
    setPrevMarkPrice(market.mark_price)
    setLeverage(Math.min(leverage, market.max_leverage))
    setShowSearch(false)
    setMarketSearch('')
  }

  const handlePlaceOrder = async () => {
    if (!selectedMarket || sizeNum <= 0) return
    setPlacing(true)
    setOrderMessage(null)
    try {
      const res = await fetch(`${API_URL}/orders/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: selectedMarket.name,
          is_buy: side === 'buy',
          size: assetSize,
          price: markPrice,
          order_type: orderType,
          limit_price: parseFloat(limitPrice) || markPrice,
          leverage,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setOrderMessage({ type: 'success', text: 'Order placed successfully!' })
        setSize('')
      } else {
        setOrderMessage({ type: 'error', text: data.detail || 'Order failed' })
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
          flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>

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

            <div style={{ position: 'relative' }}>
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
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0,
                  background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: '6px',
                  maxHeight: '300px', overflowY: 'auto', zIndex: 200, marginTop: '4px' }}>
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
            border: '1px solid #1a1a2e', borderRadius: '8px', overflow: 'hidden' }}>
            {(['market', 'limit'] as const).map(type => (
              <button key={type} onClick={() => setOrderType(type)} style={{
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
            <button onClick={() => setSide('buy')} style={{
              flex: 1, padding: '12px', cursor: 'pointer',
              borderRadius: '8px', fontWeight: '700', fontSize: '14px',
              background: side === 'buy' ? '#00d4aa' : '#0d0d14',
              color: side === 'buy' ? '#0a0a0f' : '#6b7280',
              border: `1px solid ${side === 'buy' ? '#00d4aa' : '#1a1a2e'}`,
            }}>
              Buy / Long
            </button>
            <button onClick={() => setSide('sell')} style={{
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
          gap: '12px', overflowY: 'auto', minWidth: 0 }}>

          {/* TradingView Chart */}
          {selectedMarket && (
            <div style={{ background: '#0d0d14', border: '1px solid #1a1a2e',
              borderRadius: '8px', overflow: 'hidden', flexShrink: 0 }}>
              <TradingViewChart
                symbol={selectedMarket.display_name}
                dex={selectedMarket.dex}
              />
            </div>
          )}

          {/* Orderbook + Recent Trades */}
          <div style={{ display: 'flex', gap: '12px', flex: 1, minHeight: '280px' }}>

            {/* Orderbook */}
            <div style={{ flex: 1, background: '#0d0d14', border: '1px solid #1a1a2e',
              borderRadius: '8px', padding: '12px', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                marginBottom: '10px' }}>
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {/* Bids */}
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                    fontSize: '10px', color: '#4b5563', marginBottom: '4px',
                    paddingBottom: '3px', borderBottom: '1px solid #1a1a2e' }}>
                    <span>Price</span><span style={{ textAlign: 'right' }}>Size</span>
                  </div>
                  {orderbook.bids.slice(0, 12).map((bid, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                      fontSize: '12px', padding: '2px 0' }}>
                      <span style={{ color: '#00d4aa', fontVariantNumeric: 'tabular-nums' }}>
                        {parseFloat(bid[0]).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                      <span style={{ color: '#6b7280', textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums' }}>
                        {parseFloat(bid[1]).toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Asks */}
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                    fontSize: '10px', color: '#4b5563', marginBottom: '4px',
                    paddingBottom: '3px', borderBottom: '1px solid #1a1a2e' }}>
                    <span>Price</span><span style={{ textAlign: 'right' }}>Size</span>
                  </div>
                  {orderbook.asks.slice(0, 12).map((ask, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                      fontSize: '12px', padding: '2px 0' }}>
                      <span style={{ color: '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                        {parseFloat(ask[0]).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                      <span style={{ color: '#6b7280', textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums' }}>
                        {parseFloat(ask[1]).toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
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
