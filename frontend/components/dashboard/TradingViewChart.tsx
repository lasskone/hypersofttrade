'use client'
import { useEffect, useRef } from 'react'

interface Props {
  symbol: string   // display name e.g. "BTC", "XYZ100"
  dex: string      // "main" or "xyz" etc.
  height?: number  // chart height in px, defaults to 420
}

// Map Hyperliquid symbols to TradingView symbols
const TV_SYMBOL_MAP: Record<string, string> = {
  'BTC':   'BINANCE:BTCUSDT',
  'ETH':   'BINANCE:ETHUSDT',
  'SOL':   'BINANCE:SOLUSDT',
  'AVAX':  'BINANCE:AVAXUSDT',
  'ARB':   'BINANCE:ARBUSDT',
  'OP':    'BINANCE:OPUSDT',
  'DOGE':  'BINANCE:DOGEUSDT',
  'LINK':  'BINANCE:LINKUSDT',
  'UNI':   'BINANCE:UNIUSDT',
  'MATIC': 'BINANCE:MATICUSDT',
  'ATOM':  'BINANCE:ATOMUSDT',
  'DOT':   'BINANCE:DOTUSDT',
  'ADA':   'BINANCE:ADAUSDT',
  'XRP':   'BINANCE:XRPUSDT',
  'LTC':   'BINANCE:LTCUSDT',
  'BCH':   'BINANCE:BCHUSDT',
  'FIL':   'BINANCE:FILUSDT',
  'NEAR':  'BINANCE:NEARUSDT',
  'APT':   'BINANCE:APTUSDT',
  'SUI':   'BINANCE:SUIUSDT',
  'TRX':   'BINANCE:TRXUSDT',
  'INJ':   'BINANCE:INJUSDT',
  'HYPE':  'BINANCE:HYPEUSDT',
}

function getTVSymbol(symbol: string, dex: string): string | null {
  if (dex !== 'main') return null  // HIP-3 not on TradingView
  return TV_SYMBOL_MAP[symbol] || `BINANCE:${symbol}USDT`
}

export default function TradingViewChart({ symbol, dex, height = 420 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const tvSymbol = getTVSymbol(symbol, dex)

  useEffect(() => {
    if (!containerRef.current) return
    containerRef.current.innerHTML = ''

    if (!tvSymbol) {
      containerRef.current.innerHTML = `
        <div style="height:${height}px;display:flex;align-items:center;
          justify-content:center;flex-direction:column;gap:8px;
          color:#6b7280;font-size:13px;">
          <span style="font-size:24px;">📊</span>
          <span>Chart not available for ${symbol}</span>
          <span style="font-size:11px;">HIP-3 DEX assets are not listed on TradingView</span>
        </div>
      `
      return
    }

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.async = true
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#0a0a0f',
      gridColor: 'rgba(26,26,46,0.5)',
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      hide_volume: false,
      support_host: 'https://www.tradingview.com',
    })
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [tvSymbol])

  return (
    <div
      ref={containerRef}
      style={{ height: `${height}px`, width: '100%' }}
    />
  )
}
