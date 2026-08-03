'use client';

import { useEffect, useMemo, useState } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fill {
  coin: string;
  side: string;   // "B" | "S"
  dir: string;    // "Open Long" | "Close Long" | "Open Short" | "Close Short"
  px: number;
  sz: number;
  fee: number;
  closedPnl: number;
  time: number;   // epoch ms
  hash?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt2(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPnl(n: number) {
  const s = (n >= 0 ? '+' : '') + fmt2(n);
  return { text: s, color: n > 0 ? '#10b981' : n < 0 ? '#ef4444' : '#9ca3af' };
}

function fmtTime(epochMs: number): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function dirLabel(fill: Fill): string {
  if (fill.dir) return fill.dir;
  return fill.side === 'B' ? 'Buy' : 'Sell';
}

function dirColor(fill: Fill): string {
  const d = (fill.dir || '').toLowerCase();
  if (d.includes('long') && d.includes('open')) return '#10b981';
  if (d.includes('short') && d.includes('open')) return '#ef4444';
  if (d.includes('long') && d.includes('close')) return '#ef4444';
  if (d.includes('short') && d.includes('close')) return '#10b981';
  return fill.side === 'B' ? '#10b981' : '#ef4444';
}

/** Return YYYY-MM-DD in local timezone */
function localDay(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const PAGE_SIZE = 50;

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ w = '100%', h = 16 }: { w?: string | number; h?: number }) {
  return (
    <div
      className="animate-pulse rounded"
      style={{ width: w, height: h, backgroundColor: '#1a1a2e' }}
    />
  );
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

interface CalendarProps {
  fills: Fill[];
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
}

function Calendar({ fills, selectedDay, onSelectDay }: CalendarProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed

  // Aggregate pnl per local day
  const dayPnl = useMemo(() => {
    const map: Record<string, number> = {};
    for (const f of fills) {
      if (!f.time) continue;
      const d = new Date(f.time);
      if (d.getFullYear() !== year || d.getMonth() !== month) continue;
      const key = localDay(f.time);
      map[key] = (map[key] ?? 0) + f.closedPnl;
    }
    return map;
  }, [fills, year, month]);

  // Monthly summary
  const monthlyTotals = useMemo(() => {
    let total = 0, profitable = 0, losing = 0;
    for (const v of Object.values(dayPnl)) {
      total += v;
      if (v > 0) profitable++;
      else if (v < 0) losing++;
    }
    return { total, profitable, losing };
  }, [dayPnl]);

  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }
  function goToday() {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  }

  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad to complete final row
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = localDay(today.getTime());

  return (
    <div
      className="rounded-xl border"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: '#1a1a2e' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={prevMonth}
            style={{ color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >‹</button>
          <span className="font-semibold text-white text-sm">
            {MONTHS[month]} {year}
          </span>
          <button
            onClick={nextMonth}
            style={{ color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
          >›</button>
          <button
            onClick={goToday}
            style={{
              color: '#00d4aa', background: 'none', border: '1px solid #00d4aa',
              borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 8px',
            }}
          >Today</button>
        </div>

        {/* Monthly summary */}
        <div className="flex items-center gap-4 text-xs">
          <span style={{ color: '#9ca3af' }}>
            Monthly PnL:{' '}
            <span style={{ color: monthlyTotals.total >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
              {monthlyTotals.total >= 0 ? '+' : ''}{fmt2(monthlyTotals.total)} USDC
            </span>
          </span>
          <span style={{ color: '#10b981' }}>{monthlyTotals.profitable} ▲</span>
          <span style={{ color: '#ef4444' }}>{monthlyTotals.losing} ▼</span>
        </div>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 px-4 pt-3 pb-1">
        {DOW.map(d => (
          <div key={d} style={{ textAlign: 'center', color: '#6b7280', fontSize: 11, fontWeight: 600 }}>
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1 px-4 pb-4">
        {cells.map((day, i) => {
          if (!day) return <div key={`empty-${i}`} />;
          const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const pnl = dayPnl[key];
          const hasTrades = pnl !== undefined;
          const isToday = key === todayStr;
          const isSelected = key === selectedDay;

          let bg = 'transparent';
          let border = 'transparent';
          if (isSelected) { bg = '#1e2d3d'; border = '#00d4aa'; }
          else if (hasTrades && pnl > 0) { bg = 'rgba(16,185,129,0.08)'; border = 'rgba(16,185,129,0.25)'; }
          else if (hasTrades && pnl < 0) { bg = 'rgba(239,68,68,0.08)'; border = 'rgba(239,68,68,0.25)'; }
          else if (hasTrades) { bg = 'rgba(156,163,175,0.05)'; border = 'rgba(156,163,175,0.2)'; }

          return (
            <button
              key={key}
              onClick={() => onSelectDay(isSelected ? null : key)}
              style={{
                borderRadius: 6,
                border: `1px solid ${border}`,
                backgroundColor: bg,
                cursor: hasTrades ? 'pointer' : 'default',
                padding: '4px 2px',
                minHeight: 44,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: 2,
              }}
            >
              <span style={{
                fontSize: 11,
                fontWeight: isToday ? 700 : 400,
                color: isToday ? '#00d4aa' : '#9ca3af',
              }}>
                {day}
              </span>
              {hasTrades && (
                <span style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : '#6b7280',
                  lineHeight: 1,
                }}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Trade table ──────────────────────────────────────────────────────────────

interface TradeTableProps {
  fills: Fill[];
  selectedDay: string | null;
}

function TradeTable({ fills, selectedDay }: TradeTableProps) {
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!selectedDay) return fills;
    return fills.filter(f => f.time && localDay(f.time) === selectedDay);
  }, [fills, selectedDay]);

  // Reset to page 0 when filter changes
  useEffect(() => setPage(0), [selectedDay]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th style={{
      padding: '10px 12px',
      textAlign: right ? 'right' : 'left',
      fontSize: 11,
      fontWeight: 600,
      color: '#6b7280',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  );

  const TD = ({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) => (
    <td style={{
      padding: '10px 12px',
      fontSize: 12,
      textAlign: right ? 'right' : 'left',
      fontFamily: mono ? 'monospace' : undefined,
      borderTop: '1px solid #1a1a2e',
    }}>
      {children}
    </td>
  );

  return (
    <div
      className="rounded-xl border"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
    >
      {/* Section header */}
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: '#1a1a2e' }}
      >
        <span className="text-sm font-semibold text-white">
          {selectedDay ? `Trades on ${selectedDay}` : 'All Trades'}
          <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 400, fontSize: 12 }}>
            ({filtered.length})
          </span>
        </span>
        {selectedDay && (
          <button
            onClick={() => {}}
            style={{
              color: '#00d4aa', background: 'none', border: '1px solid #00d4aa',
              borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 8px',
            }}
          >
            Clear filter
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6b7280', fontSize: 13 }}>
          {selectedDay ? 'No trades on this day.' : 'No trades found. Execute your first trade to see history here.'}
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: '#0a0a0f' }}>
                  <TH>Time</TH>
                  <TH>Coin</TH>
                  <TH>Direction</TH>
                  <TH right>Size</TH>
                  <TH right>Price</TH>
                  <TH right>Fee</TH>
                  <TH right>Closed PnL</TH>
                </tr>
              </thead>
              <tbody>
                {slice.map((f, idx) => {
                  const pnl = fmtPnl(f.closedPnl);
                  return (
                    <tr
                      key={f.hash ?? `${f.time}-${idx}`}
                      style={{ transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#111119')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                    >
                      <TD><span style={{ color: '#9ca3af' }}>{fmtTime(f.time)}</span></TD>
                      <TD><span style={{ color: '#ffffff', fontWeight: 600 }}>{f.coin}</span></TD>
                      <TD>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: dirColor(f),
                          backgroundColor: `${dirColor(f)}18`,
                          border: `1px solid ${dirColor(f)}44`,
                          borderRadius: 4,
                          padding: '2px 6px',
                        }}>
                          {dirLabel(f)}
                        </span>
                      </TD>
                      <TD right mono><span style={{ color: '#e5e7eb' }}>{f.sz}</span></TD>
                      <TD right mono><span style={{ color: '#e5e7eb' }}>${fmt2(f.px)}</span></TD>
                      <TD right mono><span style={{ color: '#9ca3af' }}>-{fmt2(f.fee)}</span></TD>
                      <TD right mono>
                        <span style={{ color: pnl.color, fontWeight: 600 }}>{pnl.text}</span>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              className="flex items-center justify-between px-5 py-3 border-t"
              style={{ borderColor: '#1a1a2e' }}
            >
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  background: 'none', border: '1px solid #1a1a2e', borderRadius: 4,
                  color: page === 0 ? '#374151' : '#9ca3af',
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                  padding: '4px 12px', fontSize: 12,
                }}
              >
                ← Prev
              </button>
              <span style={{ color: '#6b7280', fontSize: 12 }}>
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                style={{
                  background: 'none', border: '1px solid #1a1a2e', borderRadius: 4,
                  color: page === totalPages - 1 ? '#374151' : '#9ca3af',
                  cursor: page === totalPages - 1 ? 'not-allowed' : 'pointer',
                  padding: '4px 12px', fontSize: 12,
                }}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  walletAddress: string;
}

export default function HistoryPanel({ walletAddress }: HistoryPanelProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'loaded'>('loading');
  const [fills, setFills] = useState<Fill[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    setStatus('loading');

    async function load() {
      try {
        const res = await fetch(
          `${API_URL}/account/fills?wallet_address=${encodeURIComponent(walletAddress)}`
        );
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.detail ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setFills(Array.isArray(data.fills) ? data.fills : []);
          setStatus('loaded');
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [walletAddress]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div className="p-6 space-y-4">
        <div
          className="rounded-xl border p-5 space-y-3"
          style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        >
          <Skeleton h={24} w={200} />
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} h={44} />
            ))}
          </div>
        </div>
        <div
          className="rounded-xl border p-5 space-y-3"
          style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} h={18} />
          ))}
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="p-6">
        <div
          className="rounded-xl border px-6 py-5 text-sm"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14', color: '#ef4444' }}
        >
          Could not load trade history: {errorMsg}
        </div>
      </div>
    );
  }

  // ── Loaded ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-4">
      <Calendar
        fills={fills}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
      />
      <TradeTable
        fills={fills}
        selectedDay={selectedDay}
      />
    </div>
  );
}
