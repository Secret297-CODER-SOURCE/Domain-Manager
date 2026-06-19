import { create } from 'zustand'

const STORAGE_KEY = 'dm.mail.lastUnread.v1'

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}
function saveSnapshot(snap) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)) } catch {}
}

/**
 * Tracks last-known unread counts per account. When a new mail arrives,
 * compares against prior snapshot and shows a browser Notification.
 *
 * We don't poll here — the Mail page already refetches accounts every minute
 * via react-query. We just subscribe to the data and diff.
 */
export const useMailNotifications = create((set, get) => ({
  permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  snapshot: loadSnapshot(),

  async requestPermission() {
    if (typeof Notification === 'undefined') return 'denied'
    if (Notification.permission === 'granted') {
      set({ permission: 'granted' }); return 'granted'
    }
    const r = await Notification.requestPermission()
    set({ permission: r })
    return r
  },

  /** Process the latest accounts list, fire notifications when unread grew. */
  process(accounts) {
    if (!accounts || accounts.length === 0) return
    const prev = get().snapshot
    const next = {}
    for (const a of accounts) {
      const unread = typeof a.last_unread === 'number' ? a.last_unread : null
      next[a.id] = unread

      const prevUnread = prev[a.id]
      const grew = prevUnread != null && unread != null && unread > prevUnread
      if (grew && get().permission === 'granted') {
        const diff = unread - prevUnread
        try {
          const n = new Notification(`${diff} new ${diff === 1 ? 'mail' : 'mails'}`, {
            body: `${a.label || a.email} — total ${unread} unread`,
            tag: `dm-mail-${a.id}`,
            icon: '/favicon.ico',
            silent: false,
          })
          n.onclick = () => { window.focus() }
        } catch {}
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      set({ snapshot: next })
      saveSnapshot(next)
    }
  },
}))
