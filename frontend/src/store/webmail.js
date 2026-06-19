import { create } from 'zustand'

/**
 * Persistent webmail popup windows that survive SPA navigation.
 * The platform stays a single page; popup windows are real browser windows
 * controlled by JS refs kept in this store.
 *
 * Open a popup → store the window ref. Across navigation, the ref stays valid
 * (no React mount/unmount affects the store). Click 'focus' → window.focus().
 * Poll closure: every 1.5s check `.closed`, cleanup if user closed it manually.
 */
export const useWebmailStore = create((set, get) => ({
  windows: {},  // { [accountId]: { win, url } }
  pollerStarted: false,

  open(accountId, url) {
    const existing = get().windows[accountId]
    if (existing && !existing.win.closed) {
      try { existing.win.focus() } catch {}
      return existing.win
    }
    const features = [
      'width=1200', 'height=820', 'resizable=yes',
      'scrollbars=yes', 'menubar=no', 'toolbar=no', 'location=yes',
    ].join(',')
    const win = window.open(url, `dm-mail-${accountId}`, features)
    if (!win) return null
    set(s => ({ windows: { ...s.windows, [accountId]: { win, url } } }))
    get()._ensurePoller()
    return win
  },

  focus(accountId) {
    const existing = get().windows[accountId]
    if (existing && !existing.win.closed) {
      try { existing.win.focus() } catch {}
      return true
    }
    return false
  },

  close(accountId) {
    const existing = get().windows[accountId]
    if (existing) {
      try { existing.win.close() } catch {}
      set(s => {
        const next = { ...s.windows }
        delete next[accountId]
        return { windows: next }
      })
    }
  },

  isOpen(accountId) {
    const existing = get().windows[accountId]
    return !!(existing && !existing.win.closed)
  },

  countOpen() {
    const ws = get().windows
    return Object.values(ws).filter(w => !w.win.closed).length
  },

  // Poll for windows that the user closed manually, clean up the store
  _ensurePoller() {
    if (get().pollerStarted) return
    set({ pollerStarted: true })
    setInterval(() => {
      const cur = get().windows
      let changed = false
      const next = {}
      for (const [id, entry] of Object.entries(cur)) {
        if (entry.win.closed) { changed = true; continue }
        next[id] = entry
      }
      if (changed) set({ windows: next })
    }, 1500)
  },
}))
