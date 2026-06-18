'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

const ASSETS = ['BTC', 'ETH', 'SOL', 'AVAX', 'ARB', 'OP', 'DOGE', 'LINK', 'UNI', 'xyz:XYZ100'];

interface BookLevel { px: string; sz: string; }
interface Orderbook { bids: BookLevel[]; asks: BookLevel[]; }

const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt4 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function TradePanel({ walletAddress }: { walletAddress: string }) {
  const [asset, setAsset]           = useState('BTC');
  const [orderType, setOrderType]   = useState<'market' | 'limit'>('market');
  const [side, setSide]             = useState<'buy' | 'sell'>('buy');
  const [size, setSize]             = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [leverage, setLeverage]     = useState(1);

  const [markPrice, setMarkPrice]   = useState<number | null>(null);
  const [prevPrice, setPrevPrice]   = useState<number | null>(null);
  const [book, setBook]             = useState<Orderbook | null>(null);

  const [placing, setPlacing]       = useState(false);
  const [toast, setToast]           = useState<{ msg: string; ok: boolean } | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mark price + orderbook polling ──────────────────────────────────────────
  const fetchAll = async (sym: string) => {
    try {
      const [priceRes, bookRes] = await Promise.all([
        fetch(`${API_URL}/market/prices`),
        fetch(`${API_URL}/market/orderbook/${sym}`),
      ]);
      if (priceRes.ok) {
        const pd = await priceRes.json();
        const raw = pd.prices?.[sym];
        if (raw != null) {
          const n = parseFloat(String(raw));
          setMarkPrice(prev => { setPrevPrice(prev); return n; });
        }
      }
      if (bookRes.ok) {
        const bd = await bookRes.json();
        setBook({ bids: bd.bids ?? [], asks: bd.asks ?? [] });
      }
    } catch { /* silent */ }
  };

  useEffect(() => {
    setMarkPrice(null);
    setPrevPrice(null);
    setBook(null);
    fetchAll(asset);
    const id = setInterval(() => fetchAll(asset), 3000);
    return () => clearInterval(id);
  }, [asset]);

  // ── Derived values ───────────────────────────────────────────────────────────
  const sizeNum       = parseFloat(size) || 0;
  const entryPrice    = orderType === 'limit' ? (parseFloat(limitPrice) || 0) : (markPrice ?? 0);
  const assetUnits    = entryPrice > 0 ? sizeNum / entryPrice : 0;
  const liqPrice      = entryPrice > 0 && leverage > 0
    ? side === 'buy'
      ? entryPrice * (1 - 1 / leverage)
      : entryPrice * (1 + 1 / leverage)
    : 0;
  const fee           = orderType === 'market' ? sizeNum * 0.00035 : sizeNum * 0.0001;
  const spread        = book && book.bids[0] && book.asks[0]
    ? parseFloat(book.asks[0].px) - parseFloat(book.bids[0].px)
    : null;
  const spreadPct     = spread != null && book?.asks[0]
    ? (spread / parseFloat(book.asks[0].px)) * 100
    : null;

  const priceColor = markPrice != null && prevPrice != null
    ? markPrice >= prevPrice ? '#10b981' : '#ef4444'
    : '#ffffff';

  // ── Show toast ───────────────────────────────────────────────────────────────
  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // ── Place order ──────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sizeNum || !walletAddress) return;
    if (orderType === 'limit' && !parseFloat(limitPrice)) return;
    setPlacing(true);
    try {
      const res = await fetch(`${API_URL}/orders/place`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: asset,
          is_buy: side === 'buy',
          size: sizeNum,
          price: markPrice ?? 0,
          order_type: orderType,
          limit_price: parseFloat(limitPrice) || 0,
          leverage,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      showToast('Order placed successfully!', true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Order failed', false);
    } finally {
      setPlacing(false);
    }
  };

  const displayAsset = asset.includes(':') ? asset.split(':')[1] : asset;

  return (
    <div className="p-6 flex gap-6 flex-col xl:flex-row min-h-0">

      {/* ── LEFT: Order form ─────────────────────────────────────────────────── */}
      <div
        className="rounded-xl border p-5 flex-shrink-0 flex flex-col gap-4"
        style={{ width: 340, backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        {/* Mark price */}
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-gray-500">{displayAsset} Mark Price</span>
          <span className="text-lg font-black" style={{ color: priceColor }}>
            {markPrice != null ? `$${fmt2(markPrice)}` : '—'}
          </span>
        </div>

        {/* Asset selector */}
        <div>
          <label className="text-xs text-gray-500 mb-1.5 block">Asset</label>
          <select
            value={asset}
            onChange={e => { setAsset(e.target.value); setSize(''); setLimitPrice(''); }}
            className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
            style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
          >
            {ASSETS.map(a => (
              <option key={a} value={a}>{a.includes(':') ? a.split(':')[1] : a}</option>
            ))}
          </select>
        </div>

        {/* Order type tabs */}
        <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: '#1a1a2e' }}>
          {(['market', 'limit'] as const).map(t => (
            <button
              key={t}
              type="button"
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
        <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: '#1a1a2e' }}>
          <button
            type="button"
            onClick={() => setSide('buy')}
            className="flex-1 py-2 text-xs font-bold transition-colors"
            style={{ backgroundColor: side === 'buy' ? '#10b981' : 'transparent', color: side === 'buy' ? '#fff' : '#6b7280' }}
          >
            Buy / Long
          </button>
          <button
            type="button"
            onClick={() => setSide('sell')}
            className="flex-1 py-2 text-xs font-bold transition-colors"
            style={{ backgroundColor: side === 'sell' ? '#ef4444' : 'transparent', color: side === 'sell' ? '#fff' : '#6b7280' }}
          >
            Sell / Short
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Size */}
          <div>
            <label className="text-xs text-gray-500 mb-1.5 block">Size (USD)</label>
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={size}
              onChange={e => setSize(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
              style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
              onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
              onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
            />
            {assetUnits > 0 && (
              <p className="text-xs mt-1" style={{ color: '#6b7280' }}>
                ≈ {fmt4(assetUnits)} {displayAsset}
              </p>
            )}
          </div>

          {/* Limit price */}
          {orderType === 'limit' && (
            <div>
              <label className="text-xs text-gray-500 mb-1.5 block">Limit Price</label>
              <input
                type="number"
                min="0"
                step="any"
                placeholder="0.00"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none"
                style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
                onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
              />
            </div>
          )}

          {/* Leverage */}
          <div>
            <label className="text-xs text-gray-500 mb-1.5 flex justify-between">
              <span>Leverage</span>
              <span style={{ color: '#00d4aa' }}>{leverage}x</span>
            </label>
            <input
              type="range" min={1} max={50} value={leverage}
              onChange={e => setLeverage(Number(e.target.value))}
              className="w-full accent-teal-400"
            />
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>1x</span><span>50x</span>
            </div>
          </div>

          {/* Order summary */}
          <div className="rounded-lg p-3 flex flex-col gap-1.5 text-xs"
            style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}>
            <div className="flex justify-between">
              <span style={{ color: '#6b7280' }}>Entry Price</span>
              <span className="text-white">{entryPrice > 0 ? `$${fmt2(entryPrice)}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6b7280' }}>Size</span>
              <span className="text-white">
                {sizeNum > 0 ? `$${fmt2(sizeNum)} = ${fmt4(assetUnits)} ${displayAsset}` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6b7280' }}>Leverage</span>
              <span className="text-white">{leverage}x</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6b7280' }}>Est. Liq. Price</span>
              <span style={{ color: '#ef4444' }}>{liqPrice > 0 ? `$${fmt2(liqPrice)}` : '—'}</span>
            </div>
            <div className="flex justify-between border-t pt-1.5 mt-0.5" style={{ borderColor: '#1a1a2e' }}>
              <span style={{ color: '#6b7280' }}>
                Fee ({orderType === 'market' ? '0.035% taker' : '0.01% maker'})
              </span>
              <span className="text-white">{sizeNum > 0 ? `$${fee.toFixed(4)}` : '—'}</span>
            </div>
          </div>

          {/* Toast */}
          {toast && (
            <div className="rounded-lg px-3 py-2 text-xs font-medium" style={{
              backgroundColor: toast.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${toast.ok ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
              color: toast.ok ? '#10b981' : '#ef4444',
            }}>
              {toast.msg}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={placing || !sizeNum || (orderType === 'limit' && !parseFloat(limitPrice))}
            className="w-full py-3 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: side === 'buy' ? '#10b981' : '#ef4444', color: '#fff' }}
          >
            {placing ? 'Placing order…' : `Place ${side === 'buy' ? 'Buy' : 'Sell'} Order`}
          </button>
        </form>
      </div>

      {/* ── RIGHT: Orderbook ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border flex-1 overflow-hidden flex flex-col"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>

        {/* Header */}
        <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: '#1a1a2e' }}>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Order Book — {displayAsset}
          </h2>
          {spread != null && spreadPct != null && (
            <span className="text-xs" style={{ color: '#6b7280' }}>
              Spread: ${fmt2(spread)} ({spreadPct.toFixed(3)}%)
            </span>
          )}
        </div>

        {!book ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-700 border-t-teal-400" />
          </div>
        ) : (
          <div className="grid grid-cols-2 divide-x divide-[#1a1a2e] flex-1 overflow-hidden">
            {/* Bids */}
            <div className="overflow-auto">
              <div className="px-4 py-2 border-b sticky top-0" style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
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
                  {book.bids.slice(0, 12).map((b, i) => (
                    <tr key={i} className="hover:bg-emerald-500/5 transition-colors">
                      <td className="px-4 py-1 text-emerald-400">{parseFloat(b.px).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-4 py-1 text-right text-gray-400">{parseFloat(b.sz).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Asks */}
            <div className="overflow-auto">
              <div className="px-4 py-2 border-b sticky top-0" style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
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
                  {book.asks.slice(0, 12).map((a, i) => (
                    <tr key={i} className="hover:bg-red-500/5 transition-colors">
                      <td className="px-4 py-1 text-red-400">{parseFloat(a.px).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
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
