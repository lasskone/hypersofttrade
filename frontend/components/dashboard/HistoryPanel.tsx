'use client';

import { useEffect, useMemo, useState } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fill {
  coin: string;
  side: string;   // "B" | "A"
  dir: string;    // "Open Long" | "Close Long" | "Open Short" | "Close Short"
  px: number;
  sz: number;
  fee: number;
  closedPnl: number;
  time: number;   // epoch ms
  hash?: string;
  oid?: number;   // Hyperliquid order ID — present on fills returned by /account/fills
}

type SourceMap = Record<string, { type: string; bot_name?: string }>;

// ─── Formatters ───────────────────────────────────────────────────────────────

/** Dollar amount with explicit sign: "+$1,284.50" / "-$342.10" / "$0.00" */
function fmtAmt(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n > 0) return `+$${abs}`;
  if (n < 0) return `-$${abs}`;
  return `$${abs}`;
}

/** Plain unsigned number, 2 dp, thousands separator */
function fmt2(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPnl(n: number) {
  return { text: fmtAmt(n), color: n > 0 ? '#10b981' : n < 0 ? '#ef4444' : '#9ca3af' };
}

/** Abbreviated PnL for narrow mobile calendar cells: "+1.3k", "-342", "+0" */
function fmtPnlShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
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
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  // Aggregate pnl per local day (data logic unchanged)
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

  // Monthly summary (data logic unchanged)
  const monthlyTotals = useMemo(() => {
    let total = 0, profitable = 0, losing = 0;
    for (const v of Object.values(dayPnl)) {
      total += v;
      if (v > 0) profitable++;
      else if (v < 0) losing++;
    }
    return { total, profitable, losing };
  }, [dayPnl]);

  const firstDay = new Date(year, month, 1).getDay();
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
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = localDay(today.getTime());

  return (
    <>
    <style>{`
      .hp-pnl-short { display: none; }
      .hp-hist-table { display: block; }
      .hp-hist-cards { display: none; }
      @media (max-width: 767px) {
        .hp-pnl-full { display: none !important; }
        .hp-pnl-short { display: inline !important; }
        .hp-monthly-cell { padding-left: 8px !important; padding-right: 8px !important; }
        .hp-monthly-val { font-size: 14px !important; }
        .hp-hist-table { display: none !important; }
        .hp-hist-cards { display: flex !important; }
      }
    `}</style>
    <div
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
    >
      {/* ── Toolbar ── */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: '#1a1a2e' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            aria-label="Previous month"
            style={{
              background: 'none', border: '1px solid #1a1a2e', borderRadius: 6,
              color: '#9ca3af', cursor: 'pointer', width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, lineHeight: 1, flexShrink: 0,
            }}
          >‹</button>

          <span
            style={{
              fontWeight: 600, fontSize: 14, color: '#e5e7eb',
              minWidth: 148, textAlign: 'center',
            }}
          >
            {MONTHS[month]} {year}
          </span>

          <button
            onClick={nextMonth}
            aria-label="Next month"
            style={{
              background: 'none', border: '1px solid #1a1a2e', borderRadius: 6,
              color: '#9ca3af', cursor: 'pointer', width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, lineHeight: 1, flexShrink: 0,
            }}
          >›</button>

          <button
            onClick={goToday}
            style={{
              background: 'none', border: '1px solid #00d4aa', borderRadius: 6,
              color: '#00d4aa', cursor: 'pointer', fontSize: 11,
              fontWeight: 600, padding: '3px 10px', lineHeight: '20px',
            }}
          >
            Today
          </button>
        </div>
      </div>

      {/* ── Summary stats ── */}
      <div
        className="grid grid-cols-3 border-b"
        style={{ borderColor: '#1a1a2e' }}
      >
        {/* Monthly PnL */}
        <div className="hp-monthly-cell px-5 py-4 border-r" style={{ borderColor: '#1a1a2e' }}>
          <div
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: '#6b7280', marginBottom: 6,
            }}
          >
            Monthly PnL
          </div>
          <div
            className="hp-monthly-val"
            style={{
              fontSize: 18, fontWeight: 700,
              color: monthlyTotals.total > 0 ? '#10b981' : monthlyTotals.total < 0 ? '#ef4444' : '#9ca3af',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
            }}
          >
            {fmtAmt(monthlyTotals.total)}
          </div>
        </div>

        {/* Profitable days */}
        <div className="px-5 py-4 border-r" style={{ borderColor: '#1a1a2e' }}>
          <div
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: '#6b7280', marginBottom: 6,
            }}
          >
            Profitable Days
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981' }}>
            {monthlyTotals.profitable}
          </div>
        </div>

        {/* Losing days */}
        <div className="px-5 py-4">
          <div
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: '#6b7280', marginBottom: 6,
            }}
          >
            Losing Days
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444' }}>
            {monthlyTotals.losing}
          </div>
        </div>
      </div>

      {/* ── Weekday header row ── */}
      <div className="grid grid-cols-7 px-4 pt-4 pb-2">
        {DOW.map(d => (
          <div
            key={d}
            style={{
              textAlign: 'center',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#6b7280',
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* ── Day grid ── */}
      <div className="grid grid-cols-7 px-4 pb-4" style={{ gap: 6 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`empty-${i}`} />;

          const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const pnl = dayPnl[key];
          const hasTrades = pnl !== undefined;
          const isToday = key === todayStr;
          const isSelected = key === selectedDay;

          // Color palette
          let bg = 'transparent';
          let borderCol = '#1a1a2e';
          let hoverBorderCol = '#2a2a3e';
          let pnlColor = '#9ca3af';

          if (isSelected) {
            bg = 'rgba(0,212,170,0.09)';
            borderCol = '#00d4aa';
            hoverBorderCol = '#00d4aa';
          } else if (hasTrades && (pnl ?? 0) > 0) {
            bg = 'rgba(16,185,129,0.08)';
            borderCol = 'rgba(16,185,129,0.22)';
            hoverBorderCol = 'rgba(16,185,129,0.55)';
            pnlColor = '#10b981';
          } else if (hasTrades && (pnl ?? 0) < 0) {
            bg = 'rgba(239,68,68,0.08)';
            borderCol = 'rgba(239,68,68,0.22)';
            hoverBorderCol = 'rgba(239,68,68,0.55)';
            pnlColor = '#ef4444';
          } else if (hasTrades) {
            bg = 'rgba(156,163,175,0.05)';
            borderCol = 'rgba(156,163,175,0.18)';
            hoverBorderCol = 'rgba(156,163,175,0.4)';
          }

          return (
            <button
              key={key}
              onClick={() => hasTrades && onSelectDay(isSelected ? null : key)}
              style={{
                position: 'relative',
                borderRadius: 8,
                border: `1px solid ${borderCol}`,
                backgroundColor: bg,
                cursor: hasTrades ? 'pointer' : 'default',
                padding: '6px 4px 8px',
                minHeight: 72,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'border-color 0.12s, background-color 0.12s',
              }}
              onMouseEnter={e => {
                if (!hasTrades) return;
                e.currentTarget.style.borderColor = hoverBorderCol;
              }}
              onMouseLeave={e => {
                if (!hasTrades) return;
                e.currentTarget.style.borderColor = borderCol;
              }}
            >
              {/* Day number — top-left, clearly readable */}
              <span
                style={{
                  position: 'absolute',
                  top: 5,
                  left: 7,
                  fontSize: 13,
                  fontWeight: isToday ? 700 : 500,
                  color: isToday ? '#00d4aa' : '#9ca3af',
                  lineHeight: 1,
                }}
              >
                {day}
              </span>

              {/* PnL — dominant, centered below day number */}
              {hasTrades && (
                <>
                  <span
                    className="hp-pnl-full"
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: pnlColor,
                      fontVariantNumeric: 'tabular-nums',
                      letterSpacing: '-0.01em',
                      lineHeight: 1,
                      marginTop: 14,
                    }}
                  >
                    {fmtAmt(pnl ?? 0)}
                  </span>
                  <span
                    className="hp-pnl-short"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: pnlColor,
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: 1,
                      marginTop: 14,
                    }}
                  >
                    {fmtPnlShort(pnl ?? 0)}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
    </>
  );
}

// ─── Trade table ──────────────────────────────────────────────────────────────

interface TradeTableProps {
  fills: Fill[];
  selectedDay: string | null;
  onClearDay: () => void;
  sources?: SourceMap;
}

function TradeTable({ fills, selectedDay, onClearDay, sources = {} }: TradeTableProps) {
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!selectedDay) return fills;
    return fills.filter(f => f.time && localDay(f.time) === selectedDay);
  }, [fills, selectedDay]);

  useEffect(() => setPage(0), [selectedDay]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th
      style={{
        padding: '10px 16px',
        textAlign: right ? 'right' : 'left',
        fontSize: 10,
        fontWeight: 600,
        color: '#6b7280',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        whiteSpace: 'nowrap',
        borderBottom: '1px solid #1a1a2e',
      }}
    >
      {children}
    </th>
  );

  const TD = ({
    children, right, mono,
  }: { children: React.ReactNode; right?: boolean; mono?: boolean }) => (
    <td
      style={{
        padding: '10px 16px',
        fontSize: 13,
        textAlign: right ? 'right' : 'left',
        fontFamily: mono ? "'Fira Mono', 'Roboto Mono', monospace" : undefined,
        fontVariantNumeric: mono ? 'tabular-nums' : undefined,
        borderTop: '1px solid #1a1a2e',
        color: '#d1d5db',
      }}
    >
      {children}
    </td>
  );

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
    >
      {/* Section header */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b"
        style={{ borderColor: '#1a1a2e' }}
      >
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {selectedDay ? `Trades — ${selectedDay}` : 'All Trades'}
          <span style={{ marginLeft: 8, color: '#4b5563', fontWeight: 400, textTransform: 'none', fontSize: 12, letterSpacing: 0 }}>
            ({filtered.length})
          </span>
        </h2>
        {selectedDay && (
          <button
            onClick={onClearDay}
            style={{
              background: 'none', border: '1px solid #1a1a2e', borderRadius: 6,
              color: '#9ca3af', cursor: 'pointer', fontSize: 11,
              fontWeight: 500, padding: '3px 10px',
            }}
          >
            Clear filter
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6b7280', fontSize: 13 }}>
          {selectedDay
            ? 'No trades on this day.'
            : 'No trades yet. Execute your first trade to see history here.'}
        </div>
      ) : (
        <>
          <div className="hp-hist-table" style={{ overflowX: 'auto' }}>
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
                  <TH>Source</TH>
                </tr>
              </thead>
              <tbody>
                {slice.map((f, idx) => {
                  const pnl = fmtPnl(f.closedPnl);
                  const dc = dirColor(f);
                  return (
                    <tr
                      key={f.hash ?? `${f.time}-${idx}`}
                      style={{ transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#0f0f1a')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                    >
                      <TD>
                        <span style={{ color: '#9ca3af', fontSize: 12 }}>{fmtTime(f.time)}</span>
                      </TD>
                      <TD>
                        <span style={{ color: '#ffffff', fontWeight: 600 }}>{f.coin}</span>
                      </TD>
                      <TD>
                        <span style={{
                          fontSize: 11, fontWeight: 600, color: dc,
                          backgroundColor: `${dc}18`,
                          border: `1px solid ${dc}44`,
                          borderRadius: 4, padding: '2px 7px',
                        }}>
                          {dirLabel(f)}
                        </span>
                      </TD>
                      <TD right mono>
                        <span style={{ color: '#e5e7eb' }}>{f.sz}</span>
                      </TD>
                      <TD right mono>
                        <span style={{ color: '#e5e7eb' }}>${fmt2(f.px)}</span>
                      </TD>
                      <TD right mono>
                        <span style={{ color: '#6b7280' }}>-${fmt2(f.fee)}</span>
                      </TD>
                      <TD right mono>
                        <span style={{ color: pnl.color, fontWeight: 600 }}>{pnl.text}</span>
                      </TD>
                      <TD>
                        {(() => {
                          const src = f.oid != null ? sources[String(f.oid)] : undefined;
                          if (src?.type === 'bot') {
                            return (
                              <span style={{
                                fontSize: 11, fontWeight: 600,
                                color: '#8b5cf6',
                                backgroundColor: '#8b5cf618',
                                border: '1px solid #8b5cf644',
                                borderRadius: 4, padding: '2px 7px',
                              }}>
                                {src.bot_name ?? 'Bot'}
                              </span>
                            );
                          }
                          return (
                            <span style={{
                              fontSize: 11, fontWeight: 500,
                              color: '#6b7280',
                              backgroundColor: '#1a1a2e',
                              borderRadius: 4, padding: '2px 7px',
                            }}>
                              Manual
                            </span>
                          );
                        })()}
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="hp-hist-cards" style={{ flexDirection: 'column', gap: 8, padding: 12 }}>
            {slice.map((f, idx) => {
              const pnl = fmtPnl(f.closedPnl)
              const dc  = dirColor(f)
              const src = f.oid != null ? sources[String(f.oid)] : undefined
              const lbl: React.CSSProperties = { fontSize: 10, color: '#6b7280', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }
              const val: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#e5e7eb', fontVariantNumeric: 'tabular-nums', margin: 0 }
              return (
                <div key={f.hash ?? `${f.time}-${idx}`} style={{ background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{f.coin}</span>
                      <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, fontWeight: 600, backgroundColor: `${dc}18`, border: `1px solid ${dc}44`, color: dc }}>{dirLabel(f)}</span>
                    </div>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtTime(f.time)}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
                    <div><p style={lbl}>Price</p><p style={val}>${fmt2(f.px)}</p></div>
                    <div><p style={lbl}>Size</p><p style={val}>{f.sz}</p></div>
                    <div><p style={lbl}>Closed PnL</p><p style={{ ...val, color: pnl.color, fontWeight: 700 }}>{pnl.text}</p></div>
                    <div><p style={lbl}>Fee</p><p style={{ ...val, color: '#6b7280' }}>-${fmt2(f.fee)}</p></div>
                    <div><p style={lbl}>Source</p>
                      {src?.type === 'bot' ? (
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#8b5cf6', backgroundColor: '#8b5cf618', border: '1px solid #8b5cf644', borderRadius: 4, padding: '2px 7px' }}>{src.bot_name ?? 'Bot'}</span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#6b7280', backgroundColor: '#1a1a2e', borderRadius: 4, padding: '2px 7px' }}>Manual</span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination — always visible when there are results */}
          <div
            className="flex items-center justify-between px-5 py-3 border-t"
            style={{ borderColor: '#1a1a2e' }}
          >
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              style={{
                background: 'none',
                border: `1px solid ${page === 0 ? '#1a1a2e' : '#2a2a3e'}`,
                borderRadius: 6,
                color: page === 0 ? '#374151' : '#9ca3af',
                cursor: page === 0 ? 'not-allowed' : 'pointer',
                width: 28, height: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, lineHeight: 1, flexShrink: 0,
                opacity: page === 0 ? 0.4 : 1,
              }}
            >
              ‹
            </button>
            <span style={{ color: '#6b7280', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              aria-label="Next page"
              style={{
                background: 'none',
                border: `1px solid ${page === totalPages - 1 ? '#1a1a2e' : '#2a2a3e'}`,
                borderRadius: 6,
                color: page === totalPages - 1 ? '#374151' : '#9ca3af',
                cursor: page === totalPages - 1 ? 'not-allowed' : 'pointer',
                width: 28, height: 28,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, lineHeight: 1, flexShrink: 0,
                opacity: page === totalPages - 1 ? 0.4 : 1,
              }}
            >
              ›
            </button>
          </div>
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
  const [fillSources, setFillSources] = useState<SourceMap>({});

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
        const loadedFills: Fill[] = Array.isArray(data.fills) ? data.fills : [];
        if (!cancelled) {
          setFills(loadedFills);
          setStatus('loaded');
        }

        // Non-blocking source lookup — failures fall back to "Manual" silently
        const oids = loadedFills
          .map(f => f.oid)
          .filter((id): id is number => id != null);
        if (oids.length > 0 && !cancelled) {
          fetch(
            `${API_URL}/orders/source-lookup?wallet_address=${encodeURIComponent(walletAddress)}&oids=${oids.join(',')}`
          )
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(d => { if (!cancelled) setFillSources(d?.sources ?? {}); })
            .catch(() => {});
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
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton h={10} w={80} />
                <Skeleton h={24} w={120} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5 pt-2">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} h={72} />
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
        onClearDay={() => setSelectedDay(null)}
        sources={fillSources}
      />
    </div>
  );
}
