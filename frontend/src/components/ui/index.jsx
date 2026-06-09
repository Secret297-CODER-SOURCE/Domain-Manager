import { useState } from 'react'
import clsx from 'clsx'

// ── Button ────────────────────────────────────────────────────────────────
export function Btn({ children, variant = 'primary', size = 'md', loading, className, ...props }) {
  const base = 'inline-flex items-center gap-2 font-semibold rounded border transition-all duration-150 whitespace-nowrap'
  const variants = {
    primary: 'bg-accent text-white border-transparent hover:bg-accent2 disabled:opacity-50',
    ghost:   'bg-transparent text-text2 border-border hover:border-border2 hover:text-text',
    danger:  'bg-red-dim text-red border-red/30 hover:bg-red/20',
    success: 'bg-green-dim text-green border-green/30 hover:bg-green/20',
  }
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-6 py-2.5 text-base' }

  return (
    <button
      className={clsx(base, variants[variant], sizes[size], className)}
      style={{ fontFamily: 'var(--font)', cursor: props.disabled ? 'not-allowed' : 'pointer' }}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <Spinner size={14} /> : null}
      {children}
    </button>
  )
}

// ── Badge ─────────────────────────────────────────────────────────────────
export function Badge({ children, color = 'default', dot = false }) {
  const vars = colorVars(color)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '2px 10px', borderRadius: 999, fontSize: 11,
      fontFamily: 'var(--font)', fontWeight: 600, letterSpacing: '0.01em',
      border: '1px solid', lineHeight: 1.6,
      ...vars
    }}>
      {dot && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'currentColor', flexShrink: 0,
          boxShadow: '0 0 0 2px ' + (vars.background || 'transparent'),
        }} />
      )}
      {children}
    </span>
  )
}

function colorVars(color) {
  const map = {
    default: { background: 'var(--bg4)', color: 'var(--text2)', borderColor: 'var(--border)' },
    green:   { background: 'var(--green-dim)', color: 'var(--green)', borderColor: 'rgba(34,197,94,0.2)' },
    red:     { background: 'var(--red-dim)', color: 'var(--red)', borderColor: 'rgba(239,68,68,0.2)' },
    yellow:  { background: 'var(--yellow-dim)', color: 'var(--yellow)', borderColor: 'rgba(245,158,11,0.2)' },
    blue:    { background: 'var(--accent-dim)', color: 'var(--accent)', borderColor: 'rgba(79,110,247,0.2)' },
  }
  return map[color] || map.default
}

// ── Modal ─────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 480 }) {
  if (!open) return null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16, backdropFilter: 'blur(4px)'
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 12, width: '100%', maxWidth: width,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          animation: 'modalIn 0.18s ease'
        }}
      >
        {title && (
          <div style={{
            padding: '16px 20px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
            <button onClick={onClose} aria-label="Закрити" style={{
              background: 'var(--bg3)', color: 'var(--text2)',
              cursor: 'pointer', border: 'none', lineHeight: 0,
              width: 28, height: 28, borderRadius: '50%',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg4)'; e.currentTarget.style.color = 'var(--text)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg3)'; e.currentTarget.style.color = 'var(--text2)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        )}
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────
export function Spinner({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4 31.4" strokeLinecap="round" />
    </svg>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────
export function Table({ columns, data, onRowClick, selected = [], onSelect, rowKey = 'id' }) {
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = sortKey ? [...data].sort((a, b) => {
    const av = a[sortKey] ?? ''
    const bv = b[sortKey] ?? ''
    const cmp = String(av).localeCompare(String(bv), 'uk', { numeric: true, sensitivity: 'base' })
    return sortDir === 'asc' ? cmp : -cmp
  }) : data

  const rowId = row => row[rowKey] ?? row.id

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {onSelect && (
              <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text3)', fontWeight: 500, width: 40 }}>
                <input type="checkbox" onChange={e => onSelect(e.target.checked ? data.map(r => rowId(r)) : [])}
                  checked={selected.length === data.length && data.length > 0}
                  style={{ width: 'auto', cursor: 'pointer' }} />
              </th>
            )}
            {columns.map(col => (
              <th
                key={col.key}
                onClick={() => col.label && handleSort(col.key)}
                style={{
                  padding: '8px 12px', textAlign: 'left', color: sortKey === col.key ? 'var(--accent)' : 'var(--text3)',
                  fontWeight: 600, whiteSpace: 'nowrap',
                  cursor: col.label ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {col.label}
                  {col.label && (
                    <span style={{ fontSize: 10, opacity: sortKey === col.key ? 1 : 0.3 }}>
                      {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const id = rowId(row)
            const isSelected = selected.includes(id)
            return (
              <tr
                key={id ?? i}
                onClick={() => {
                  if (onSelect) onSelect(isSelected ? selected.filter(x => x !== id) : [...selected, id])
                  onRowClick?.(row)
                }}
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: isSelected ? 'var(--accent-dim)' : 'transparent',
                  cursor: onRowClick || onSelect ? 'pointer' : 'default',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg3)' }}
                onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'var(--accent-dim)' : 'transparent' }}
              >
                {onSelect && (
                  <td style={{ padding: '8px 12px' }}>
                    <input type="checkbox" checked={isSelected}
                      onChange={e => {
                        e.stopPropagation()
                        onSelect(e.target.checked ? [...selected, id] : selected.filter(x => x !== id))
                      }}
                      style={{ width: 'auto', cursor: 'pointer' }} />
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '8px 12px', color: 'var(--text)', ...col.style }}>
                    {col.render ? col.render(row[col.key], row) : row[col.key] ?? '—'}
                  </td>
                ))}
              </tr>
            )
          })}
          {data.length === 0 && (
            <tr>
              <td colSpan={columns.length + (onSelect ? 1 : 0)}
                style={{ padding: '32px', textAlign: 'center', color: 'var(--text3)' }}>
                Немає даних
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── FormField ─────────────────────────────────────────────────────────────
export function Field({ label, children, error }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label && <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>}
      {children}
      {error && <span style={{ fontSize: 11, color: 'var(--red)' }}>{error}</span>}
    </div>
  )
}

// Inject keyframes
const style = document.createElement('style')
style.textContent = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes modalIn { from { opacity:0; transform:translateY(-12px) scale(0.97); } to { opacity:1; transform:none; } }
  .bg-accent { background: var(--accent) !important; }
  .hover\\:bg-accent2:hover { background: var(--accent2) !important; }
  .bg-red-dim { background: var(--red-dim) !important; }
  .text-red { color: var(--red) !important; }
  .bg-green-dim { background: var(--green-dim) !important; }
  .text-green { color: var(--green) !important; }
  .bg-accent-dim { background: var(--accent-dim) !important; }
  .text-accent { color: var(--accent) !important; }
  .bg-yellow-dim { background: var(--yellow-dim) !important; }
  .text-yellow { color: var(--yellow) !important; }
  .bg-bg4 { background: var(--bg4) !important; }
  .text-text2 { color: var(--text2) !important; }
  .text-text3 { color: var(--text3) !important; }
  .border-border { border-color: var(--border) !important; }
  .border-border2 { border-color: var(--border2) !important; }
  .hover\\:border-border2:hover { border-color: var(--border2) !important; }
  .hover\\:text-text:hover { color: var(--text) !important; }
  .text-white { color: #fff !important; }
  .border-transparent { border-color: transparent !important; }
  .bg-transparent { background: transparent !important; }
  .disabled\\:opacity-50:disabled { opacity: 0.5 !important; }
  .inline-flex { display: inline-flex; }
  .items-center { align-items: center; }
  .gap-2 { gap: 8px; }
  .font-semibold { font-weight: 600; }
  .rounded { border-radius: var(--radius); }
  .border { border: 1px solid; }
  .transition-all { transition: all var(--transition); }
  .duration-150 { transition-duration: 0.15s; }
  .whitespace-nowrap { white-space: nowrap; }
  .px-3 { padding-left: 12px; padding-right: 12px; }
  .py-1\\.5 { padding-top: 6px; padding-bottom: 6px; }
  .px-4 { padding-left: 16px; padding-right: 16px; }
  .py-2 { padding-top: 8px; padding-bottom: 8px; }
  .px-6 { padding-left: 24px; padding-right: 24px; }
  .py-2\\.5 { padding-top: 10px; padding-bottom: 10px; }
  .text-xs { font-size: 11px; }
  .text-sm { font-size: 13px; }
  .text-base { font-size: 14px; }
`
document.head.appendChild(style)
