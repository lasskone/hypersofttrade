'use client'
import { useEffect, useRef } from 'react'

interface Props {
  symbol: string  // e.g. "BTC", "ETH", "XYZ100"
  dex: string     // "main" or "xyz" etc.
}

export default function TradingViewChart({ symbol, dex }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    containerRef.current.innerHTML = ''

    // Only show TradingView for main DEX coins that exist on TradingView
    const tvSymbol = dex === 'main'
      ? `HYPERLIQUID:${symbol}USDC`
      : `BITSTAMP:${symbol}USD`  // fallback for HIP-3

    const container = document.createElement('div')
    container.className = 'tradingview-widget-container__widget'
    containerRef.current.appendChild(container)

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
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      hide_volume: false,
    })
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [symbol, dex])

  return (
    <div
      ref={containerRef}
      className="tradingview-widget-container"
      style={{ height: '400px', width: '100%' }}
    />
  )
}
