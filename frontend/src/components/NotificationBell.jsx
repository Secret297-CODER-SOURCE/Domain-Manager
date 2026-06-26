import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bell, Server, Globe, X } from 'lucide-react'
import { getNotifications } from '../api/client'

const LS_KEY = 'dm.notifications.last_seen_at'

// One-stop bell for end-of-month server payments + domain expiries.
// Polls every 60s, badge counts items newer than the user's last-seen
// timestamp (stored in localStorage). Click opens a popover list.
export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const { data: items = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => getNotifications(7, 100).then(r => r.data),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // Persist last-seen-at so badge clears when popover opens.
  const [lastSeen, setLastSeen] = useState(() => {
    try { return Number(localStorage.getItem(LS_KEY)) || 0 } catch { return 0 }
  })
  function markSeen() {
    const now = Date.now()
    setLastSeen(now)
    try { localStorage.setItem(LS_KEY, String(now)) } catch {}
  }

  const unread = items.filter(n => new Date(n.created_at).getTime() > lastSeen).length

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => { setOpen(o => !o); if (!open) markSeen() }}
        title="Нагадування"
        style={{
          position: 'relative', background: 'none', border: 'none',
          color: unread > 0 ? 'var(--yellow)' : 'var(--text2)',
          cursor: 'pointer', padding: 6, display: 'flex',
        }}>
        <Bell size={16} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 14, height: 14, padding: '0 4px',
            background: 'var(--red)', color: '#fff',
            fontSize: 9, fontWeight: 800, borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 1,
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 32, right: 0, width: 340, maxHeight: 480,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 10px 32px rgba(0,0,0,0.30)',
          zIndex: 50, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Нагадування</span>
            <button onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={14} />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                Немає активних нагадувань
              </div>
            ) : (
              items.map(n => <NotificationRow key={n.id} n={n} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NotificationRow({ n }) {
  const kindMeta = {
    server_payment: { Icon: Server, color: '#7da3ff' },
    domain_expiry:  { Icon: Globe,  color: '#fbbf24' },
  }[n.kind] || { Icon: Bell, color: 'var(--text3)' }
  const Icon = kindMeta.Icon
  const dt = new Date(n.created_at)
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '10px 14px', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
        background: `color-mix(in srgb, ${kindMeta.color} 18%, transparent)`,
        color: kindMeta.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {n.title}
        </div>
        {n.detail && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
            {n.detail}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
          {dt.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}
