'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

const ASSETS = ['BTC', 'ETH', 'SOL', 'AVAX', 'ARB', 'OP', 'DOGE', 'LINK'];

interface BookLevel {
  px: string;
  sz: string;
}

interface Orderbook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export function TradePanel() {
  const [asset, setAsset] = useState('BTC');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [leverage, setLeverage] = useState(1);
  const [book, setBook] = useState<Orderbook | null>(null);

  const fetchBook = async (sym: string) => {
    try {
      const res = await fetch(`${API_URL}/orders/market/orderbook/${sym}`);
      if (!res.ok) return;
      const data = await res.json();
      setBook(data);
    } catch {
      // silently ignore — orderbook is best-effort
    }
  };

  useEffect(() => {
    fetchBook(asset);
    const id = setInterval(() => fetchBook(asset), 3000);
    return () => clearInterval(id);
  }, [asset]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Order execution not yet implemented — requires API key in Settings
    alert('Order execution requires your Hyperliquid API key. Please add it in Settings first.');
  };

  return (
    <div className="p-6 flex gap-6 flex-col xl:flex-row">
      {/* Order form */}
      <div
        className="rounded-xl border p-5 flex-shrink-0"
        style={{ width: 340, backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        {/* Asset selector */}
        <div className="mb-5">
          <label className="text-xs text-gray-500 mb-1.5 block">Asset</label>
          <select
            value={asset}
            onChange={e => setAsset(e.target.value)}
            className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
            style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
          >
            {ASSETS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Order type tabs */}
        <div className="flex rounded-lg overflow-hidden mb-5 border" style={{ borderColor: '#1a1a2e' }}>
          {(['market', 'limit'] as const).map(t => (
            <button
              key={t}
              onClick={() => setOrderType(t)}
              className="flex-1 py-2 text-xs font-semibold capitalize transition-colors"
              style={{
                backgroundColor: orderType === t ? '#00d4aa' : 'transparent',
                color: orderType === t ? '#0a0a0f' : '#6b7280',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Side toggle */}
        <div className="flex rounded-lg overflow-hidden mb-5 border" style={{ borderColor: '#1a1a2e' }}>
          <button
            onClick={() => setSide('buy')}
            className="flex-1 py-2 text-xs font-bold transition-colors"
            style={{
              backgroundColor: side === 'buy' ? '#10b981' : 'transparent',
              color: side === 'buy' ? '#fff' : '#6b7280',
            }}
          >
            Buy
          </button>
          <button
            onClick={() => setSide('sell')}
            className="flex-1 py-2 text-xs font-bold transition-colors"
            style={{
              backgroundColor: side === 'sell' ? '#ef4444' : 'transparent',
              color: side === 'sell' ? '#fff' : '#6b7280',
            }}
          >
            Sell
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Size */}
          <div>
            <label className="text-xs text-gray-500 mb-1.5 block">Size (USD)</label>
            <input
              type="number"
              min="0"
              placeholder="0.00"
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
              style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
            />
          </div>

          {/* Price (limit only) */}
          {orderType === 'limit' && (
            <div>
              <label className="text-xs text-gray-500 mb-1.5 block">Limit Price</label>
              <input
                type="number"
                min="0"
                placeholder="0.00"
                value={price}
                onChange={e => setPrice(e.target.value)}
                className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
                style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
              />
            </div>
          )}

          {/* Leverage slider */}
          <div>
            <label className="text-xs text-gray-500 mb-1.5 flex justify-between">
              <span>Leverage</span>
              <span style={{ color: '#00d4aa' }}>{leverage}x</span>
            </label>
            <input
              type="range"
              min={1}
              max={50}
              value={leverage}
              onChange={e => setLeverage(Number(e.target.value))}
              className="w-full accent-teal-400"
            />
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>1x</span><span>50x</span>
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            className="w-full py-3 rounded-lg text-sm font-bold transition-opacity hover:opacity-80"
            style={{
              backgroundColor: side === 'buy' ? '#10b981' : '#ef4444',
              color: '#fff',
            }}
          >
            Place {side === 'buy' ? 'Buy' : 'Sell'} Order
          </button>

          <p className="text-xs text-gray-600 text-center leading-relaxed">
            Orders execute directly on Hyperliquid. You need to add your API key in Settings first.
          </p>
        </form>
      </div>

      {/* Orderbook */}
      <div
        className="rounded-xl border flex-1 overflow-hidden"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        <div className="px-5 py-3 border-b" style={{ borderColor: '#1a1a2e' }}>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            {asset} Orderbook
          </h2>
        </div>

        {!book ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-700 border-t-teal-400" />
          </div>
        ) : (
          <div className="grid grid-cols-2 divide-x" style={{ borderColor: '#1a1a2e' }}>
            {/* Bids */}
            <div>
              <div className="px-4 py-2 border-b" style={{ borderColor: '#1a1a2e' }}>
                <span className="text-xs font-semibold text-emerald-400">Bids</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-4 py-1.5 text-left font-normal">Price</th>
                    <th className="px-4 py-1.5 text-right font-normal">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {(book.bids.slice(0, 8)).map((b, i) => (
                    <tr key={i} className="hover:bg-emerald-500/5 transition-colors">
                      <td className="px-4 py-1 text-emerald-400">{parseFloat(b.px).toLocaleString()}</td>
                      <td className="px-4 py-1 text-right text-gray-400">{parseFloat(b.sz).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Asks */}
            <div>
              <div className="px-4 py-2 border-b" style={{ borderColor: '#1a1a2e' }}>
                <span className="text-xs font-semibold text-red-400">Asks</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-4 py-1.5 text-left font-normal">Price</th>
                    <th className="px-4 py-1.5 text-right font-normal">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {(book.asks.slice(0, 8)).map((a, i) => (
                    <tr key={i} className="hover:bg-red-500/5 transition-colors">
                      <td className="px-4 py-1 text-red-400">{parseFloat(a.px).toLocaleString()}</td>
                      <td className="px-4 py-1 text-right text-gray-400">{parseFloat(a.sz).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
