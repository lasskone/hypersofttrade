'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

// ─── Safe formatters ──────────────────────────────────────────────────────────
const fmt = (val: unknown, decimals = 2): string => {
  const n = parseFloat(String(val ?? 0));
  if (isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const fmtPnl = (val: unknown): string => {
  const n = parseFloat(String(val ?? 0));
  if (isNaN(n)) return '+$0.00';
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const fmtTime = (val: unknown): string => {
  const ms = parseInt(String(val ?? 0));
  if (!ms || isNaN(ms)) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const fmtOpened = (val: unknown): string => {
  if (!val) return '—';
  const d = new Date(String(val));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const isBuySide = (side: unknown): boolean => {
  const s = String(side ?? '').toUpperCase();
  return s === 'B' || s === 'BUY';
};

const fmtOrderType = (raw: unknown): string => {
  const s = String(raw ?? '');
  if (s === 'Take Profit Market' || s === 'Take Profit Limit') return 'Take Profit';
  if (s === 'Stop Market' || s === 'Stop Limit') return 'Stop Loss';
  if (s === 'Market') return 'Market';
  if (s === 'Limit') return 'Limit';
  return s || 'Limit';
};

// ─── Sub-components ───────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="rounded-xl p-5 border animate-pulse"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
      <div className="h-3 w-24 rounded mb-3" style={{ backgroundColor: '#1a1a2e' }} />
      <div className="h-7 w-32 rounded" style={{ backgroundColor: '#222236' }} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border overflow-hidden mb-4"
      style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
      <div className="px-5 py-3 border-b" style={{ borderColor: '#1a1a2e' }}>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function TH({ children }: { children?: React.ReactNode }) {
  return <th className="px-5 py-3 text-left font-medium text-xs text-gray-500">{children}</th>;
}

function TD({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <td className="px-5 py-3 text-sm text-gray-300" style={color ? { color } : undefined}>
      {children}
    </td>
  );
}

function LiveDot() {
  return (
    <span style={{
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#00d4aa',
      marginLeft: '6px',
      animation: 'pulse 2s infinite',
      verticalAlign: 'middle',
    }} />
  );
}

function Tooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-block', marginLeft: 4, verticalAlign: 'middle' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span style={{ fontSize: 10, color: '#4b5563', cursor: 'default', userSelect: 'none', lineHeight: 1 }}>ⓘ</span>
      {visible && (
        <span style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 248,
          padding: '8px 10px',
          borderRadius: 8,
          backgroundColor: '#13131f',
          border: '1px solid #2a2a3e',
          color: '#9ca3af',
          fontSize: 11,
          lineHeight: '1.55',
          fontWeight: 400,
          zIndex: 9999,
          pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,0.7)',
          whiteSpace: 'normal',
          display: 'block',
        }}>
          {text}
        </span>
      )}
    </span>
  );
}

// ─── Position management modal ───────────────────────────────────────────────
export function PositionModal({ pos, walletAddress, onClose, onAction, onRefresh }: {
  pos: any;
  walletAddress: string;
  onClose: () => void;
  onAction: () => void;
  onRefresh: () => void;
}) {
  const [closePercent, setClosePercent] = useState(100);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [tpSlLoading, setTpSlLoading] = useState(false);
  const [inputMode, setInputMode] = useState<'usd' | 'pct'>('usd');
  const [editingOid, setEditingOid] = useState<number | null>(null);
  const [editPx, setEditPx] = useState('');
  const [confirmCancelOid, setConfirmCancelOid] = useState<number | null>(null);
  const [orderActionLoading, setOrderActionLoading] = useState<number | null>(null);
  const [existingTs, setExistingTs] = useState<any>(null);
  const [tsActivationPct, setTsActivationPct] = useState('');
  const [tsTrailPct, setTsTrailPct] = useState('');
  const [tsLoading, setTsLoading] = useState(false);

  const isLong =
    pos.side?.toLowerCase().includes('long') ||
    pos.side === 'Buy' ||
    parseFloat(pos.size || '0') > 0;
  const absSize = Math.abs(parseFloat(pos.size));
  const entryPx = parseFloat(String(pos.entry_price ?? 0));
  const direction = isLong ? 1 : -1;
  const tpUsdPreview = inputMode === 'pct' && parseFloat(tpPrice) > 0
    ? entryPx * (1 + direction * parseFloat(tpPrice) / 100) : null;
  const slUsdPreview = inputMode === 'pct' && parseFloat(slPrice) > 0
    ? entryPx * (1 - direction * parseFloat(slPrice) / 100) : null;
  const markPrice = parseFloat(pos.mark_price ?? pos.entry_price ?? 0);
  const upnl = parseFloat(pos.unrealized_pnl ?? 0);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Fetch any existing trailing stop for this position on mount
  useEffect(() => {
    if (!walletAddress || !pos.symbol) return;
    fetch(`${API_URL}/orders/trailing-stops?wallet_address=${encodeURIComponent(walletAddress)}`)
      .then(r => r.json())
      .then(d => {
        const ts = (d.trailing_stops ?? []).find((t: any) => t.coin === pos.symbol);
        setExistingTs(ts ?? null);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, pos.symbol]);

  const handleSetTrailingStop = async () => {
    const actPct = parseFloat(tsActivationPct);
    const trailPct = parseFloat(tsTrailPct);
    if (!(actPct > 0) || !(trailPct > 0)) return;
    setTsLoading(true);
    try {
      const res = await fetch(`${API_URL}/orders/trailing-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          dex: pos.dex === 'main' ? '' : (pos.dex ?? ''),
          side: isLong ? 'long' : 'short',
          entry_price: entryPx,
          activation_pct: actPct,
          trail_pct: trailPct,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      setExistingTs(data.trailing_stop);
      setTsActivationPct('');
      setTsTrailPct('');
      showToast(`✅ Trailing stop set — activates at ${isLong ? '+' : '-'}${actPct}%, trails ${trailPct}%`);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setTsLoading(false);
    }
  };

  const handleCancelTrailingStop = async () => {
    if (!existingTs) return;
    setTsLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/orders/trailing-stop/${existingTs.id}?wallet_address=${encodeURIComponent(walletAddress)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      setExistingTs(null);
      showToast('✅ Trailing stop cancelled');
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setTsLoading(false);
    }
  };

  const handleClose = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/orders/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          is_long: isLong,
          size: absSize,
          sz_decimals: pos.sz_decimals ?? 5,
          percentage: closePercent,
          mark_price: markPrice,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      showToast(`✅ Position closed (${closePercent}%)`);
      setTimeout(onAction, 1500);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSetTpSl = async () => {
    let tpVal: number | null = null;
    let slVal: number | null = null;
    if (inputMode === 'pct') {
      const tpPct = parseFloat(tpPrice);
      const slPct = parseFloat(slPrice);
      if (tpPct > 0) tpVal = entryPx * (1 + direction * tpPct / 100);
      if (slPct > 0) slVal = entryPx * (1 - direction * slPct / 100);
    } else {
      const tp = parseFloat(tpPrice);
      const sl = parseFloat(slPrice);
      if (tp > 0) tpVal = tp;
      if (sl > 0) slVal = sl;
    }
    if (!tpVal && !slVal) return;
    setTpSlLoading(true);
    try {
      const res = await fetch(`${API_URL}/orders/tp-sl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          is_long: isLong,
          size: absSize,
          sz_decimals: pos.sz_decimals ?? 5,
          tp_price: tpVal,
          sl_price: slVal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      const msg = [tpVal ? `TP: $${tpVal.toFixed(2)}` : '', slVal ? `SL: $${slVal.toFixed(2)}` : ''].filter(Boolean).join(' | ');
      showToast(`✅ Set ${msg}`);
      setTpPrice('');
      setSlPrice('');
      setTimeout(onAction, 1500);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setTpSlLoading(false);
    }
  };

  const handleModifyTpSl = async (oid: number, newPx: number, sz: number, tpsl: 'tp' | 'sl') => {
    setOrderActionLoading(oid);
    try {
      const res = await fetch(`${API_URL}/orders/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          oid,
          new_trigger_px: newPx,
          is_buy: !isLong,
          sz,
          sz_decimals: pos.sz_decimals ?? 5,
          tpsl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      showToast(`✅ Order updated`);
      setEditingOid(null);
      setEditPx('');
      setTimeout(onRefresh, 800);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setOrderActionLoading(null);
    }
  };

  const handleCancelTpSl = async (oid: number) => {
    setOrderActionLoading(oid);
    try {
      const res = await fetch(`${API_URL}/orders/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          order_id: oid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      showToast(`✅ Order cancelled`);
      setConfirmCancelOid(null);
      setTimeout(onRefresh, 800);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setOrderActionLoading(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}>
      <div
        className="relative w-full max-w-md rounded-2xl border p-6 shadow-2xl overflow-y-auto max-h-[90vh]"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        onClick={e => e.stopPropagation()}>

        {/* Toast */}
        {toast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 text-xs px-4 py-2 rounded-lg font-medium z-10"
            style={{ backgroundColor: '#1a1a2e', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">{pos.symbol}</h2>
            <span className="text-xs px-2 py-0.5 rounded font-semibold"
              style={{ backgroundColor: isLong ? '#00d4aa18' : '#ef444418', color: isLong ? '#00d4aa' : '#ef4444' }}>
              {isLong ? 'LONG' : 'SHORT'}
            </span>
            <span className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
              {pos.dex}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Position summary */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: 'Size', value: `${absSize}` },
            { label: 'Entry Price', value: `$${fmt(pos.entry_price)}` },
            { label: 'Unrealized PnL', value: `${upnl >= 0 ? '+' : ''}$${fmt(upnl)}`, color: upnl >= 0 ? '#10b981' : '#ef4444' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-lg p-3 text-center" style={{ backgroundColor: '#13131f' }}>
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className="text-sm font-bold" style={{ color: color ?? '#fff' }}>{value}</p>
            </div>
          ))}
        </div>

        {/* Close Position */}
        <div className="rounded-xl p-4 mb-4" style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}>
          <p className="text-sm font-semibold text-white mb-3">Close Position</p>

          {/* Percentage presets */}
          <div className="flex gap-2 mb-3">
            {[25, 50, 75, 100].map(p => (
              <button
                key={p}
                onClick={() => setClosePercent(p)}
                className="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all"
                style={{
                  backgroundColor: closePercent === p ? '#00d4aa' : '#1a1a2e',
                  color: closePercent === p ? '#000' : '#9ca3af',
                  border: '1px solid #1a1a2e',
                }}>
                {p}%
              </button>
            ))}
          </div>

          {/* Close summary */}
          <p className="text-xs text-gray-500 mb-3">
            Closing {closePercent}% → {fmt(absSize * closePercent / 100, 5)} {pos.symbol?.replace('-USD', '')} at market
          </p>

          <button
            onClick={handleClose}
            disabled={loading}
            className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ backgroundColor: '#ef4444', color: '#fff' }}>
            {loading ? 'Processing...' : `Close ${closePercent}% of Position`}
          </button>
        </div>

        {/* TP / SL */}
        <div className="rounded-xl p-4 mb-4" style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-white">Take Profit / Stop Loss</p>
            <div style={{ display: 'flex', background: '#0d0d14', borderRadius: 6, border: '1px solid #1a1a2e', overflow: 'hidden' }}>
              {(['usd', 'pct'] as const).map(mode => (
                <button key={mode} onClick={() => { setInputMode(mode); setTpPrice(''); setSlPrice(''); }}
                  style={{
                    padding: '3px 10px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                    background: inputMode === mode ? '#1a1a2e' : 'transparent',
                    color: inputMode === mode ? '#00d4aa' : '#6b7280',
                  }}>
                  {mode === 'usd' ? '$ USD' : '% Entry'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mb-3">
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
                Take Profit {inputMode === 'pct' ? '(% from entry)' : '(USD price)'}
              </p>
              <input
                type="number"
                placeholder={inputMode === 'pct' ? 'e.g. 5 (%)' : 'TP Price'}
                value={tpPrice}
                onChange={e => setTpPrice(e.target.value)}
                style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#10b981', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
              {tpUsdPreview !== null && (
                <p style={{ fontSize: 10, color: '#10b981', marginTop: 3 }}>≈ ${tpUsdPreview.toFixed(2)}</p>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
                Stop Loss {inputMode === 'pct' ? '(% from entry)' : '(USD price)'}
              </p>
              <input
                type="number"
                placeholder={inputMode === 'pct' ? 'e.g. 3 (%)' : 'SL Price'}
                value={slPrice}
                onChange={e => setSlPrice(e.target.value)}
                style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#ef4444', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
              {slUsdPreview !== null && (
                <p style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}>≈ ${slUsdPreview.toFixed(2)}</p>
              )}
            </div>
          </div>
          <button
            onClick={handleSetTpSl}
            disabled={tpSlLoading || (!(parseFloat(tpPrice) > 0) && !(parseFloat(slPrice) > 0))}
            className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ backgroundColor: '#00d4aa', color: '#000' }}>
            {tpSlLoading ? 'Setting...' : 'Set TP / SL'}
          </button>

          {/* Active TP/SL Orders */}
          {((pos.tp_orders && pos.tp_orders.length > 0) || (pos.sl_orders && pos.sl_orders.length > 0)) && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #1a1a2e' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Active TP/SL Orders
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  ...(pos.tp_orders ?? []).map((o: any) => ({ ...o, kind: 'TP' as const })),
                  ...(pos.sl_orders ?? []).map((o: any) => ({ ...o, kind: 'SL' as const })),
                ].map((o: any, i: number) => {
                  const sz = parseFloat(String(o.sz ?? 0));
                  const origSz = parseFloat(String(o.orig_sz ?? 0));
                  const pct = absSize > 0 ? Math.round((sz / absSize) * 100) : null;
                  const oid: number | null = o.oid ?? null;
                  const tpsl = o.kind === 'TP' ? 'tp' : 'sl';
                  const kindColor = o.kind === 'TP' ? '#10b981' : '#ef4444';
                  const isEditing = oid !== null && editingOid === oid;
                  const isConfirmingCancel = oid !== null && confirmCancelOid === oid;
                  const isLoading = oid !== null && orderActionLoading === oid;

                  return (
                    <div key={oid ?? i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, backgroundColor: '#0d0d14', minHeight: 32 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: kindColor, minWidth: 24 }}>{o.kind}</span>

                      {isConfirmingCancel ? (
                        <>
                          <span style={{ fontSize: 11, color: '#9ca3af', flex: 1 }}>Cancel this order?</span>
                          <button
                            onClick={() => { if (!isLoading && oid !== null) handleCancelTpSl(oid); }}
                            disabled={isLoading}
                            style={{ fontSize: 11, fontWeight: 600, color: '#ef4444', background: '#ef444418', border: '1px solid #ef444433', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', opacity: isLoading ? 0.5 : 1 }}>
                            {isLoading ? '…' : 'Yes'}
                          </button>
                          <button
                            onClick={() => setConfirmCancelOid(null)}
                            disabled={isLoading}
                            style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', background: 'transparent', border: '1px solid #2a2a3e', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
                            No
                          </button>
                        </>
                      ) : isEditing ? (
                        <>
                          <input
                            type="number"
                            value={editPx}
                            onChange={e => setEditPx(e.target.value)}
                            autoFocus
                            style={{ flex: 1, background: '#13131f', border: `1px solid ${kindColor}44`, borderRadius: 5, padding: '3px 7px', color: kindColor, fontSize: 12, outline: 'none', minWidth: 0, boxSizing: 'border-box' }}
                          />
                          <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                            {fmt(sz, 4)}{pct !== null ? ` (${pct}%)` : ''}
                          </span>
                          <button
                            onClick={() => { const v = parseFloat(editPx); if (v > 0 && oid !== null) handleModifyTpSl(oid, v, sz, tpsl as 'tp' | 'sl'); }}
                            disabled={isLoading || !(parseFloat(editPx) > 0)}
                            title="Confirm new price"
                            style={{ fontSize: 14, color: '#00d4aa', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', opacity: (isLoading || !(parseFloat(editPx) > 0)) ? 0.4 : 1, lineHeight: 1 }}>
                            {isLoading ? '…' : '✓'}
                          </button>
                          <button
                            onClick={() => { setEditingOid(null); setEditPx(''); }}
                            disabled={isLoading}
                            title="Cancel edit"
                            style={{ fontSize: 15, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}>
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 12, color: '#e5e7eb', flex: 1 }}>${fmt(o.trigger_px)}</span>
                          <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                            {fmt(sz, 4)} / {fmt(origSz, 4)}{pct !== null ? ` (${pct}%)` : ''}
                          </span>
                          {oid !== null && (
                            <>
                              <button
                                onClick={() => { setEditingOid(oid); setEditPx(String(o.trigger_px)); setConfirmCancelOid(null); }}
                                title="Edit trigger price"
                                style={{ fontSize: 13, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}
                                onMouseEnter={e => (e.currentTarget.style.color = '#00d4aa')}
                                onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}>
                                ✏
                              </button>
                              <button
                                onClick={() => { setConfirmCancelOid(oid); setEditingOid(null); setEditPx(''); }}
                                title="Cancel this order"
                                style={{ fontSize: 16, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}
                                onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                                onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}>
                                ×
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Trailing Stop */}
        <div className="rounded-xl p-4" style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}>
          <div className="flex items-center gap-2 mb-3">
            <p className="text-sm font-semibold text-white">Trailing Stop</p>
            <Tooltip text="Waits until price reaches the activation level, then places a stop-loss that trails peak price by the trail gap %. SL never drops below break-even." />
          </div>

          {existingTs ? (
            <div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                  <span>Status</span>
                  <span style={{ color: existingTs.status === 'active' ? '#00d4aa' : '#f59e0b', fontWeight: 600 }}>
                    {existingTs.status === 'waiting' ? 'Waiting for activation' : 'Active — trailing'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                  <span>Activates at</span>
                  <span style={{ color: '#e5e7eb' }}>${Number(existingTs.activation_price ?? 0).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                  <span>Trail gap</span>
                  <span style={{ color: '#e5e7eb' }}>{existingTs.trail_pct}%</span>
                </div>
                {existingTs.current_sl_price && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                    <span>Current SL</span>
                    <span style={{ color: '#ef4444' }}>${Number(existingTs.current_sl_price).toFixed(2)}</span>
                  </div>
                )}
                {existingTs.peak_price && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                    <span>Peak price</span>
                    <span style={{ color: '#10b981' }}>${Number(existingTs.peak_price).toFixed(2)}</span>
                  </div>
                )}
              </div>
              <button
                onClick={handleCancelTrailingStop}
                disabled={tsLoading}
                className="w-full py-2 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                {tsLoading ? 'Cancelling...' : 'Cancel Trailing Stop'}
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>Activation (% from entry)</p>
                  <input
                    type="number"
                    placeholder="e.g. 1"
                    value={tsActivationPct}
                    onChange={e => setTsActivationPct(e.target.value)}
                    style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#00d4aa', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>Trail gap (%)</p>
                  <input
                    type="number"
                    placeholder="e.g. 1"
                    value={tsTrailPct}
                    onChange={e => setTsTrailPct(e.target.value)}
                    style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#f59e0b', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                  />
                </div>
              </div>
              {parseFloat(tsActivationPct) > 0 && parseFloat(tsTrailPct) > 0 && (
                <p style={{ fontSize: 10, color: '#9ca3af', marginBottom: 8 }}>
                  Activates at ${(isLong
                    ? entryPx * (1 + parseFloat(tsActivationPct) / 100)
                    : entryPx * (1 - parseFloat(tsActivationPct) / 100)
                  ).toFixed(2)} · Initial SL: ${entryPx.toFixed(2)} (break-even) · Trails {tsTrailPct}% from peak
                </p>
              )}
              <button
                onClick={handleSetTrailingStop}
                disabled={tsLoading || !(parseFloat(tsActivationPct) > 0) || !(parseFloat(tsTrailPct) > 0)}
                className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{ backgroundColor: '#f59e0b', color: '#000' }}>
                {tsLoading ? 'Setting...' : 'Set Trailing Stop'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function OverviewPanel({
  walletAddress,
  onNavigate,
  onSelectMarket,
}: {
  walletAddress: string;
  onNavigate?: (section: string) => void;
  onSelectMarket?: (symbol: string, dex: string, interval?: string) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<'loading' | 'no_api_key' | 'error' | 'loaded'>('loading');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [managingPos, setManagingPos] = useState<any>(null);
  const [selectedOrders, setSelectedOrders] = useState<Set<number>>(new Set());
  const [confirmingOrderIdx, setConfirmingOrderIdx] = useState<number | null>(null)
  const [confirmingBulkCancel, setConfirmingBulkCancel] = useState(false)
  const [tradesPage, setTradesPage] = useState(1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bots, setBots] = useState<any[]>([]);

  // ── Fetch portfolio (extracted so it can be called from onAction) ─────────────
  const fetchPortfolio = async () => {
    if (!walletAddress) return;
    setStatus('loading');
    setData(null);
    try {
      const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error === 'no_api_key') { setStatus('no_api_key'); return; }
      setData(json);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  };

  const handleCancelSelected = async () => {
    if (!walletAddress || selectedOrders.size === 0) return
    const ordersToCancel = (data?.open_orders ?? []).filter((o: any) => selectedOrders.has(o?.order_id))
    try {
      await Promise.all(ordersToCancel.map((o: any) =>
        fetch(`${API_URL}/orders/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: walletAddress, coin: o?.coin, order_id: o?.order_id }),
        })
      ))
      setSelectedOrders(new Set())
      setConfirmingBulkCancel(false)
      fetchPortfolio()
    } catch (e: any) {
      console.error('Cancel selected failed:', e)
    }
  }

  const handleCancelOrder = async (coin: string, orderId: number) => {
    if (!walletAddress) return
    try {
      const res = await fetch(`${API_URL}/orders/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, coin, order_id: orderId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Cancel failed')
      fetchPortfolio()
    } catch (e: any) {
      console.error('Cancel order failed:', e.message)
    }
  }

  // ── Fetch bots for allocation summary ────────────────────────────────────────
  useEffect(() => {
    if (!walletAddress) return;
    fetch(`${API_URL}/bots/?wallet_address=${walletAddress}`)
      .then(r => r.json())
      .then(d => setBots(Array.isArray(d?.bots) ? d.bots : []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Reset bulk cancel confirmation when selection changes ─────────────────────
  useEffect(() => {
    setConfirmingBulkCancel(false)
  }, [selectedOrders]);

  // ── Initial load + reset trades pagination on wallet change ──────────────────
  useEffect(() => {
    setTradesPage(1);
    fetchPortfolio();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Live PnL polling (every 10s) ─────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'loaded' || !walletAddress) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
        if (!res.ok) return;
        const json = await res.json();
        if (!json || typeof json !== 'object' || Array.isArray(json)) return;
        if (json.error) return;
        setData((prev: any) => ({
          ...prev,
          unrealized_pnl:       json.unrealized_pnl,
          open_positions:       json.open_positions,
          open_positions_count: json.open_positions_count,
          account_value:        json.account_value,
          usdc_spot_balance:    json.usdc_spot_balance,
          available_to_trade:   json.available_to_trade,
        }));
      } catch {
        // silently ignore poll errors
      }
    }, 10_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, walletAddress]);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (status === 'loading' || data === null) {
    return (
      <div className="p-6">
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }
        `}</style>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
        <div className="rounded-xl border animate-pulse h-40"
          style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }} />
      </div>
    );
  }

  // ── No API key ───────────────────────────────────────────────────────────────
  if (status === 'no_api_key') {
    return (
      <div className="p-6">
        <div className="rounded-xl border px-6 py-5"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
          <p className="text-sm font-medium text-gray-400 mb-1">No API key connected</p>
          <p className="text-xs text-gray-600">
            Add your API key in <span style={{ color: '#00d4aa' }}>Settings</span> to see live portfolio data.
          </p>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="p-6">
        <div className="rounded-xl border px-6 py-5 text-sm text-red-400"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
          Could not load portfolio data. Please try again.
        </div>
      </div>
    );
  }

  // ── Loaded — safely destructure with defaults ─────────────────────────────────
  const accountValue      = data?.account_value ?? 0;
  const unrealizedPnl     = data?.unrealized_pnl ?? 0;
  const usdcSpot          = data?.usdc_spot_balance ?? 0;
  const availableToTrade  = data?.available_to_trade ?? 0;
  const openPositions     = data?.open_positions ?? [];
  const openPositionsCnt  = data?.open_positions_count ?? openPositions.length;
  const spotBalances      = data?.spot_balances ?? [];
  const recentFills         = data?.recent_fills ?? [];
  const openOrders          = data?.open_orders ?? [];
  const totalTradesPages    = Math.ceil(recentFills.length / 10) || 1;
  const pagedFills          = recentFills.slice((tradesPage - 1) * 10, tradesPage * 10);

  const pnlPos = parseFloat(String(unrealizedPnl)) >= 0;

  const activeBots = bots.filter(b => b.desired_status === 'running' || b.status === 'running');
  const totalAllocated = activeBots.reduce((sum, b) => sum + (parseFloat(String(b.allocated_usdc ?? 0))), 0);
  const freeBalance = parseFloat(String(availableToTrade)) - totalAllocated;

  const stats: { label: string; subtitle: string; value: string; color: string; live: boolean; tooltip?: string }[] = [
    {
      label: 'Account Value',
      subtitle: 'Perp equity + USDC spot (unified)',
      value: `$${fmt(accountValue)}`,
      color: '#ffffff',
      live: false,
      tooltip: 'Total unified account value — perp margin equity (marginSummary.accountValue) plus USDC spot balance. Matches Hyperliquid\'s "Portfolio Value" display.',
    },
    {
      label: 'Available to Trade',
      subtitle: 'Withdrawable perp balance',
      value: `$${fmt(availableToTrade)}`,
      color: '#ffffff',
      live: false,
      tooltip: 'Withdrawable balance — what you could actually use for a new trade or withdraw right now.',
    },
    {
      label: 'Open Positions',
      subtitle: 'Active trades currently running',
      value: String(openPositionsCnt),
      color: '#ffffff',
      live: false,
    },
    {
      label: 'Unrealized PnL',
      subtitle: 'Updates every 10s',
      value: fmtPnl(unrealizedPnl),
      color: pnlPos ? '#10b981' : '#ef4444',
      live: true,
    },
  ];

  return (
    <div className="p-6">
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {stats.map(({ label, subtitle, value, color, live, tooltip }) => (
          <div key={label} className="rounded-xl p-5 border transition-colors"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#00d4aa44')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}>
            <div className="flex items-center mb-1">
              <p className="text-xs text-gray-500">
                {label}
                {tooltip && <Tooltip text={tooltip} />}
              </p>
              {live && <LiveDot />}
            </div>
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 2, marginBottom: 8 }}>{subtitle}</p>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Bot Allocation Summary */}
      {activeBots.length > 0 && (
        <Section title={`Bot Allocations (${activeBots.length} active)`}>
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-px border-b" style={{ borderColor: '#1a1a2e', backgroundColor: '#1a1a2e' }}>
            {[
              {
                label: 'Total Allocated',
                value: `$${fmt(totalAllocated)}`,
                color: '#ffffff' as string,
                tip: 'Sum of the USDC allocation set on each of your currently active (running) bots.',
              },
              {
                label: 'Free / Unallocated',
                value: `$${fmt(freeBalance)}`,
                color: freeBalance < 0 ? '#ef4444' : freeBalance < totalAllocated * 0.2 ? '#f59e0b' : '#10b981',
                tip: "Available to Trade minus Total Allocated. If negative, your bots are configured to use more capital than is actually free in your account right now — a likely cause of 'insufficient minimum value' order rejections.",
              },
              {
                label: 'Available to Trade',
                value: `$${fmt(availableToTrade)}`,
                color: '#ffffff' as string,
                tip: 'Withdrawable balance — what you could actually use for a new trade or withdraw right now.',
              },
            ].map(({ label, value, color, tip }) => (
              <div key={label} className="px-5 py-3" style={{ backgroundColor: '#0d0d14' }}>
                <p className="text-xs text-gray-500 mb-1">
                  {label}
                  <Tooltip text={tip} />
                </p>
                <p className="text-sm font-bold" style={{ color }}>{value}</p>
              </div>
            ))}
          </div>
          {/* Per-bot table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Bot</TH><TH>Symbol</TH><TH>Allocated</TH><TH>Leverage</TH>
                  <TH>Buying Power <Tooltip text="Allocated capital × leverage — the maximum position size this bot's allocation can theoretically open." /></TH>
                  <TH>Status</TH>
                </tr>
              </thead>
              <tbody>
                {activeBots.map((b: any) => {
                  const allocated = parseFloat(String(b.allocated_usdc ?? 0));
                  // Prefer the configured leverage from config.
                  // If it was never stored (older bot or missing field), fall back to the
                  // matching open position's actual exchange leverage so the display stays
                  // accurate even when the stored config is stale or absent.
                  const configLev: number | null = b.config?.leverage != null
                    ? parseFloat(String(b.config.leverage))
                    : null;
                  const matchingPosLev = parseFloat(String(
                    openPositions.find((p: any) => p.symbol === b.symbol)?.leverage ?? 0
                  ));
                  const leverage = configLev != null ? Math.max(configLev, 1) : Math.max(matchingPosLev, 1);
                  const buyingPower = allocated * leverage;
                  const isRunning = b.status === 'running';
                  const isStopping = b.status === 'running' && b.desired_status === 'stopped';
                  const statusColor = isStopping ? '#f59e0b' : isRunning ? '#00d4aa' : '#f59e0b';
                  const statusText  = isStopping ? 'Stopping...' : isRunning ? 'Running' : 'Starting...';
                  return (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3">
                        <p className="text-sm font-semibold text-white">{b.name}</p>
                        <p className="text-xs text-gray-500">{b.bot_type}</p>
                      </td>
                      <TD>{b.symbol ?? '—'}</TD>
                      <TD>${fmt(allocated)}</TD>
                      <TD>{`${fmt(leverage, 0)}x`}</TD>
                      <TD color={leverage > 1 ? '#00d4aa' : undefined}>${fmt(buyingPower)}</TD>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ backgroundColor: `${statusColor}18`, color: statusColor }}>
                          {statusText}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Open Positions */}
      <Section title={`Open Positions (${openPositions.length})`}>
        {openPositions.length === 0 ? (
          <div className="px-5 py-8 flex flex-col items-center gap-3">
            <p className="text-sm text-gray-600">No open positions — Start trading in the Trade tab</p>
            {onNavigate && (
              <button
                onClick={() => onNavigate('trade')}
                className="text-sm font-semibold px-4 py-2 rounded-lg transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                Go to Trade →
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>DEX</TH><TH>Symbol</TH><TH>Side</TH><TH>Size</TH><TH>Entry Price</TH>
                  <TH>Mark Price</TH>
                  <TH>Notional <Tooltip text="Full leveraged exposure of this position — size × mark price." /></TH>
                  <TH>Margin <Tooltip text="Real cash committed to this position — reported directly by Hyperliquid (marginUsed field)." /></TH>
                  <TH>PnL / ROE%</TH><TH>TP / SL</TH><TH>Leverage</TH>
                  <TH>Liq. Price</TH><TH>Opened</TH><TH>Actions</TH>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos: any, i: number) => {
                  const upnl   = parseFloat(String(pos?.unrealized_pnl ?? 0));
                  const posPos = upnl >= 0;
                  const liqPx  = parseFloat(String(pos?.liquidation_price ?? 0));
                  const roe    = parseFloat(String(pos?.roe_pct ?? 0));
                  const tpPx   = pos?.tp_price ? parseFloat(String(pos.tp_price)) : null;
                  const slPx   = pos?.sl_price ? parseFloat(String(pos.sl_price)) : null;
                  const notional = parseFloat(String(pos?.position_value ?? 0));
                  const margin   = parseFloat(String(pos?.margin_used ?? 0));
                  return (
                    <tr key={i}
                      className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e', cursor: onSelectMarket ? 'pointer' : undefined }}
                      onClick={() => {
                        if (onSelectMarket) {
                          const matchingBot = bots.find((b: any) =>
                            b.symbol === pos?.symbol && (b.status === 'running' || b.desired_status === 'running')
                          )
                          const interval = matchingBot?.config?.interval ?? '15m'
                          onSelectMarket(pos?.symbol ?? '', pos?.dex === 'main' ? '' : (pos?.dex ?? ''), interval)
                        }
                        if (onNavigate) onNavigate('trade')
                      }}>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                          {pos?.dex ?? '—'}
                        </span>
                      </td>
                      <TD><span className="font-semibold text-white">{pos?.symbol ?? '—'}</span></TD>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-semibold"
                          style={{
                            backgroundColor: parseFloat(pos?.size) > 0 ? '#00d4aa18' : '#ef444418',
                            color: parseFloat(pos?.size) > 0 ? '#00d4aa' : '#ef4444'
                          }}>
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
                        <p className="text-xs mt-0.5" style={{ color: roe >= 0 ? '#10b981' : '#ef4444' }}>
                          {roe >= 0 ? '+' : ''}{fmt(roe, 2)}%
                        </p>
                      </td>
                      <td className="px-5 py-3">
                        {tpPx ? (
                          <p className="text-xs" style={{ color: '#10b981' }}>TP ${fmt(tpPx)}</p>
                        ) : null}
                        {slPx ? (
                          <p className="text-xs mt-0.5" style={{ color: '#ef4444' }}>SL ${fmt(slPx)}</p>
                        ) : null}
                        {!tpPx && !slPx ? <span className="text-xs text-gray-600">—</span> : null}
                      </td>
                      <TD>{fmt(pos?.leverage, 0)}x {pos?.leverage_type ?? ''}</TD>
                      <TD>{liqPx > 0 ? `$${fmt(liqPx)}` : '—'}</TD>
                      <td className="px-5 py-3">
                        <p className="text-xs text-gray-400">{fmtOpened(pos?.opened_at)}</p>
                      </td>
                      <td className="px-5 py-3">
                        <button
                          onClick={(e) => { e.stopPropagation(); setManagingPos(pos); }}
                          className="text-xs font-semibold px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
                          style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                          Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Open Orders */}
      {openOrders.length > 0 && (
        <Section title={`Open Orders (${openOrders.length})`}>
          {openOrders.length > 0 && (
            <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: '#1a1a2e' }}>
              <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={selectedOrders.size === openOrders.length && openOrders.length > 0}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelectedOrders(new Set(openOrders.map((o: any) => o?.order_id)))
                    } else {
                      setSelectedOrders(new Set())
                    }
                  }}
                  style={{ accentColor: '#00d4aa', width: 14, height: 14 }}
                />
                Select all
              </label>
              {selectedOrders.size > 0 && (
                confirmingBulkCancel ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                      Cancel {selectedOrders.size} order{selectedOrders.size > 1 ? 's' : ''}?
                    </span>
                    <button
                      onClick={handleCancelSelected}
                      style={{ background: '#ef4444', color: 'white', borderRadius: 4, padding: '2px 8px', fontSize: 12, border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmingBulkCancel(false)}
                      style={{ background: 'rgba(255,255,255,0.1)', color: '#9ca3af', borderRadius: 4, padding: '2px 8px', fontSize: 12, border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingBulkCancel(true)}
                    className="text-xs px-3 py-1.5 rounded font-semibold"
                    style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                    Cancel {selectedOrders.size} order{selectedOrders.size > 1 ? 's' : ''}
                  </button>
                )
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH> </TH><TH>Coin</TH><TH>Side</TH><TH>Type</TH><TH>Price</TH><TH>Size</TH><TH>Time</TH><TH>Source</TH><TH>Action</TH>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o: any, i: number) => {
                  const buy = isBuySide(o?.side);
                  const orderTime = o?.time ? new Date(o.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';
                  const orderDate = o?.time ? new Date(o.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                  const isTrigger = o?.is_trigger || o?.is_position_tpsl;
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(o?.order_id)}
                          onChange={e => {
                            const next = new Set(selectedOrders)
                            if (e.target.checked) next.add(o?.order_id)
                            else next.delete(o?.order_id)
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
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ backgroundColor: '#1a1a2e', color: '#6b7280' }}>
                          Manual
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {confirmingOrderIdx === i ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Cancel order?</span>
                            <button
                              onClick={() => { handleCancelOrder(o?.coin, o?.order_id); setConfirmingOrderIdx(null) }}
                              style={{ background: '#ef4444', color: 'white', borderRadius: 4, padding: '2px 8px', fontSize: 12, border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                              Yes
                            </button>
                            <button
                              onClick={() => setConfirmingOrderIdx(null)}
                              style={{ background: 'rgba(255,255,255,0.1)', color: '#9ca3af', borderRadius: 4, padding: '2px 8px', fontSize: 12, border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmingOrderIdx(i)}
                            className="text-xs px-3 py-1 rounded font-semibold transition-opacity hover:opacity-80"
                            style={{ backgroundColor: '#ef444418', color: '#ef4444', border: '1px solid #ef444444' }}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Spot Balances */}
      {spotBalances.length > 0 && (
        <Section title="Spot Balances">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Total</TH><TH>Hold</TH>
                </tr>
              </thead>
              <tbody>
                {spotBalances.map((b: any, i: number) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                    style={{ borderColor: '#1a1a2e' }}>
                    <td className="px-5 py-3 font-semibold text-white text-sm">{b?.coin ?? '—'}</td>
                    <TD>{fmt(b?.total, 6)}</TD>
                    <TD>{parseFloat(String(b?.hold ?? 0)) > 0 ? fmt(b?.hold, 6) : '—'}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Recent Trades */}
      {recentFills.length > 0 && (
        <Section title={`Recent Trades (${recentFills.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Side</TH><TH>Price</TH><TH>Size</TH>
                  <TH>Closed PnL</TH><TH>Fee</TH><TH>Time</TH>
                </tr>
              </thead>
              <tbody>
                {pagedFills.map((f: any, i: number) => {
                  const buy  = isBuySide(f?.side);
                  const cpnl = parseFloat(String(f?.closed_pnl ?? 0));
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3 font-semibold text-white text-sm">{f?.coin ?? '—'}</td>
                      <TD color={buy ? '#10b981' : '#ef4444'}>{buy ? 'Buy' : 'Sell'}</TD>
                      <TD>${fmt(f?.price)}</TD>
                      <TD>{fmt(f?.size, 4)}</TD>
                      <TD color={cpnl > 0 ? '#10b981' : cpnl < 0 ? '#ef4444' : '#6b7280'}>
                        {cpnl === 0 ? '—' : fmtPnl(cpnl)}
                      </TD>
                      <TD color="#6b7280">${fmt(f?.fee)}</TD>
                      <TD color="#6b7280">{fmtTime(f?.time)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {recentFills.length > 10 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: '1px solid #1a1a2e' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {totalTradesPages > 5 && (
                  <button onClick={() => setTradesPage(1)} disabled={tradesPage === 1}
                    style={{ padding: '5px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: tradesPage === 1 ? 'not-allowed' : 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: tradesPage === 1 ? '#374151' : '#6b7280', opacity: tradesPage === 1 ? 0.4 : 1 }}>
                    «
                  </button>
                )}
                <button onClick={() => setTradesPage(p => Math.max(1, p - 1))} disabled={tradesPage === 1}
                  style={{ padding: '5px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: tradesPage === 1 ? 'not-allowed' : 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: tradesPage === 1 ? '#374151' : '#9ca3af', opacity: tradesPage === 1 ? 0.4 : 1 }}>
                  ← Prev
                </button>
              </div>
              <span style={{ fontSize: 12, color: '#00d4aa', fontWeight: 600 }}>
                {(tradesPage - 1) * 10 + 1}–{Math.min(tradesPage * 10, recentFills.length)} of {recentFills.length} trades
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => setTradesPage(p => Math.min(totalTradesPages, p + 1))} disabled={tradesPage === totalTradesPages}
                  style={{ padding: '5px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: tradesPage === totalTradesPages ? 'not-allowed' : 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: tradesPage === totalTradesPages ? '#374151' : '#9ca3af', opacity: tradesPage === totalTradesPages ? 0.4 : 1 }}>
                  Next →
                </button>
                {totalTradesPages > 5 && (
                  <button onClick={() => setTradesPage(totalTradesPages)} disabled={tradesPage === totalTradesPages}
                    style={{ padding: '5px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: tradesPage === totalTradesPages ? 'not-allowed' : 'pointer', border: '1px solid #1a1a2e', background: '#13131f', color: tradesPage === totalTradesPages ? '#374151' : '#6b7280', opacity: tradesPage === totalTradesPages ? 0.4 : 1 }}>
                    »
                  </button>
                )}
              </div>
            </div>
          )}
        </Section>
      )}

      {managingPos && (
        <PositionModal
          pos={managingPos}
          walletAddress={walletAddress}
          onClose={() => setManagingPos(null)}
          onAction={() => { setManagingPos(null); fetchPortfolio(); }}
          onRefresh={fetchPortfolio}
        />
      )}
    </div>
  );
}
