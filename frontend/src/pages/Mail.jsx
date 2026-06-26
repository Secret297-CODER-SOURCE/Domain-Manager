import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Edit3, RefreshCw, Mail as MailIcon, Inbox, Send, Search,
  Paperclip, ChevronLeft, AlertTriangle, CheckCircle2, Clock, Upload, Download,
  ChevronDown, ChevronRight, Sparkles, X, Copy,
} from 'lucide-react'
import { saveAs } from 'file-saver'

import {
  getMailPresets, detectMailDomain, getMailAccounts, createMailAccount, updateMailAccount, deleteMailAccount,
  bulkDeleteMailAccounts,
  refreshMailAccount, refreshAllMail, testMailAccount,
  listMailMessages, getMailMessage, revealMailCredentials, grantMailWebProxy, protonConnect, protonBulkConnect,
  importMailAccounts, exportMailAccounts,
  getProxies,
} from '../api/client'

// Domains where IMAP cannot work without a separate bridge/desktop app.
// We treat these as a credential vault — show email+password, no IMAP attempt.
const CREDENTIAL_ONLY_DOMAINS = [
  'protonmail.com', 'proton.me', 'pm.me', 'protonmail.ch',
  'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com', 'keemail.me', 'tutamail.com',
]

// Short labels for provider picker grid (avoid awkward truncation like "Outlook / Li…")
const SHORT_PROVIDER_LABEL = {
  gmail:    'Gmail',
  outlook:  'Outlook',
  yahoo:    'Yahoo',
  icloud:   'iCloud',
  yandex:   'Yandex',
  mailru:   'Mail.ru',
  zoho:     'Zoho',
  fastmail: 'FastMail',
  proton:   'Proton',
  tutanota: 'Tuta',
  custom:   'Свій',
}
const isCredentialOnly = (account) => {
  const email = (account?.email || '').toLowerCase()
  // If a Proton account is wired up via hydroxide, it has real IMAP — not credential-only any more
  if ((account?.imap_host || '').includes('hydroxide')) return false
  return CREDENTIAL_ONLY_DOMAINS.some(d => email.endsWith('@' + d))
}
// Webmail entry points so user can open the account directly
const WEBMAIL = {
  'protonmail.com': 'https://mail.proton.me/login',
  'proton.me': 'https://mail.proton.me/login',
  'pm.me': 'https://mail.proton.me/login',
  'protonmail.ch': 'https://mail.proton.me/login',
  // Tutanota (now Tuta Mail) — new domain app.tuta.com; old app.tutanota.com still works
  'tutanota.com': 'https://app.tuta.com/login',
  'tutanota.de': 'https://app.tuta.com/login',
  'tuta.io': 'https://app.tuta.com/login',
  'tuta.com': 'https://app.tuta.com/login',
  'keemail.me': 'https://app.tuta.com/login',
  'tutamail.com': 'https://app.tuta.com/login',
  'gmail.com': 'https://mail.google.com/',
  'googlemail.com': 'https://mail.google.com/',
  'outlook.com': 'https://outlook.live.com/',
  'hotmail.com': 'https://outlook.live.com/',
  'live.com': 'https://outlook.live.com/',
  'yahoo.com': 'https://mail.yahoo.com/',
  'icloud.com': 'https://www.icloud.com/mail',
  'me.com': 'https://www.icloud.com/mail',
  'yandex.ru': 'https://mail.yandex.ru/',
  'yandex.com': 'https://mail.yandex.com/',
  'mail.ru': 'https://e.mail.ru/',
}
function webmailFor(email) {
  if (!email || !email.includes('@')) return null
  const domain = email.split('@')[1].toLowerCase()
  return WEBMAIL[domain] || null
}
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'
import { useWebmailStore } from '../store/webmail'
import { useMailNotifications } from '../store/mailNotifications'

const PRESET_COLORS = ['#0a84ff', '#30d158', '#ff453a', '#ffd60a', '#bf5af2', '#ff9f0a', '#64d2ff']

export default function MailPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [active, setActive] = useState(null)
  const [editModal, setEditModal] = useState(null) // 'new' | account
  const [importOpen, setImportOpen] = useState(false)
  const [openMsg, setOpenMsg] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [accountSearch, setAccountSearch] = useState('')
  const [bulkProtonOpen, setBulkProtonOpen] = useState(false)

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => getMailAccounts().then(r => r.data),
    refetchInterval: 60000, // refresh meta every minute
  })

  // Pump accounts into notifications store on every update — it diffs and fires Notifications
  const notifProcess = useMailNotifications(s => s.process)
  useEffect(() => { notifProcess(accounts) }, [accounts, notifProcess])

  useEffect(() => {
    if (accounts.length === 0) { setActive(null); return }
    if (!active || !accounts.find(a => a.id === active.id)) setActive(accounts[0])
    else setActive(accounts.find(a => a.id === active.id))
  }, [accounts])

  const delMut = useMutation({
    mutationFn: deleteMailAccount,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['mail-accounts']) },
  })

  async function refreshAll() {
    setRefreshing(true)
    try { await refreshAllMail(); qc.invalidateQueries(['mail-accounts']); toast.success('Оновлено') }
    catch { toast.error('Помилка') }
    finally { setRefreshing(false) }
  }

  async function doDeleteAll() {
    if (accounts.length === 0) return
    if (!window.confirm(`Видалити ВСІ ${accounts.length} скриньок? Це не можна відмінити.`)) return
    try {
      const r = await bulkDeleteMailAccounts(null) // null = all
      toast.success(`Видалено ${r.data.deleted}`)
      qc.invalidateQueries(['mail-accounts'])
    } catch (e) {
      toast.error('Помилка видалення')
    }
  }

  async function doExport() {
    if (accounts.length === 0) {
      toast.error('Немає скриньок для експорту — додайте або імпортуйте спочатку')
      return
    }
    try {
      const r = await exportMailAccounts()
      // Force a real blob (axios sometimes returns string with responseType:'blob' if response is text/plain)
      const blob = r.data instanceof Blob ? r.data : new Blob([r.data], { type: 'text/plain;charset=utf-8' })
      saveAs(blob, `mail-accounts-${new Date().toISOString().slice(0,10)}.txt`)
      toast.success(`Експортовано ${accounts.length} скриньок`)
    } catch (e) {
      const detail = e.response?.data
      // If responseType blob, detail is also blob — read it
      if (detail instanceof Blob) {
        try {
          const txt = await detail.text()
          toast.error('Помилка експорту: ' + txt.slice(0, 200))
          return
        } catch {}
      }
      toast.error('Помилка експорту: ' + (e.message || 'unknown'))
    }
  }

  const totalUnread = accounts.reduce((s, a) => s + (a.last_unread || 0), 0)

  const visibleAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase()
    if (!q) return accounts
    return accounts.filter(a =>
      (a.email || '').toLowerCase().includes(q) ||
      (a.label || '').toLowerCase().includes(q) ||
      (a.username || '').toLowerCase().includes(q)
    )
  }, [accounts, accountSearch])

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Accounts sidebar */}
      <aside style={{
        width: 270, flexShrink: 0, background: 'var(--bg2)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Inbox size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Пошта</span>
          {totalUnread > 0 && (
            <span style={{
              background: 'var(--accent)', color: '#fff', borderRadius: 999,
              padding: '2px 8px', fontSize: 10, fontWeight: 700,
            }}>{totalUnread}</span>
          )}
        </div>
        <NotificationBar />
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn size="sm" loading={refreshing} onClick={refreshAll} title="Оновити всі"
              style={{ flex: 1, justifyContent: 'center' }}>
              <RefreshCw size={12} />
            </Btn>
            <Btn size="sm" onClick={() => setEditModal('new')} style={{ flex: 2, justifyContent: 'center' }}>
              <Plus size={12} /> Додати
            </Btn>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn size="sm" variant="ghost" onClick={() => setImportOpen(true)} style={{ flex: 1, justifyContent: 'center' }}>
              <Upload size={12} /> Імпорт
            </Btn>
            <Btn size="sm" variant="ghost" onClick={doExport}
              title={accounts.length === 0 ? 'Немає скриньок для експорту' : `Експортувати ${accounts.length} скриньок`}
              style={{ flex: 1, justifyContent: 'center', opacity: accounts.length === 0 ? 0.5 : 1 }}>
              <Download size={12} /> Експорт
            </Btn>
          </div>
          {accounts.length > 0 && (
            <Btn size="sm" variant="danger" onClick={doDeleteAll} style={{ width: '100%', justifyContent: 'center' }}>
              <Trash2 size={11} /> Видалити всі ({accounts.length})
            </Btn>
          )}
          {/* Bulk-connect all Proton accounts at once through a chosen proxy */}
          {accounts.some(a => /(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/i.test(a.email)
                            && !(a.imap_host || '').includes('hydroxide')) && (
            <Btn size="sm" variant="success" onClick={() => setBulkProtonOpen(true)}
              style={{ width: '100%', justifyContent: 'center' }}>
              <Sparkles size={11} /> Підключити всі Proton
            </Btn>
          )}
        </div>

        {accounts.length > 0 && (
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
            <Search size={11} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
            <input
              value={accountSearch}
              onChange={e => setAccountSearch(e.target.value)}
              placeholder="Пошук по пошті / імені…"
              style={{ paddingLeft: 26, fontSize: 12, height: 28 }}
            />
            {accountSearch && (
              <button
                onClick={() => setAccountSearch('')}
                style={{
                  position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 2,
                }}
                title="Очистити"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {isLoading ? <Spinner /> : accounts.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              Додайте першу скриньку
            </div>
          ) : visibleAccounts.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              Нічого не знайдено за «{accountSearch}»
            </div>
          ) : visibleAccounts.map((a, i) => (
            <AccountRow key={a.id} account={a} active={active?.id === a.id} color={PRESET_COLORS[i % PRESET_COLORS.length]}
              onClick={() => setActive(a)}
              onEdit={() => setEditModal(a)}
              onDelete={() => gateDelete(() => delMut.mutateAsync(a.id)).catch(() => {})}
            />
          ))}
        </div>
      </aside>

      {/* Main pane — embedded webmail by default; per-tab toggle to creds vault */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!active ? (
          <EmptyState onAdd={() => setEditModal('new')} />
        ) : (
          <AccountPane account={active} openMsg={openMsg} onOpenMsg={setOpenMsg} />
        )}
      </div>

      <EditAccountModal modal={editModal} onClose={() => setEditModal(null)}
        onSaved={() => qc.invalidateQueries(['mail-accounts'])} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)}
        onDone={() => qc.invalidateQueries(['mail-accounts'])} />
      <ProtonBulkConnectModal open={bulkProtonOpen} onClose={() => setBulkProtonOpen(false)}
        accounts={accounts}
        onDone={() => qc.invalidateQueries(['mail-accounts'])} />
    </div>
  )
}

function ProtonBulkConnectModal({ open, onClose, accounts, onDone }) {
  const [proxyId, setProxyId] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)

  const { data: proxies = [] } = useQuery({
    queryKey: ['proxies'], queryFn: () => getProxies().then(r => r.data),
    enabled: open, staleTime: 60000,
  })
  const usableProxies = proxies.filter(p => p.is_active !== false && p.last_check_ok !== false)
  const protonToConnect = accounts.filter(a =>
    /(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/i.test(a.email) &&
    !(a.imap_host || '').includes('hydroxide')
  )

  useEffect(() => { if (open) { setProxyId(''); setResults(null) } }, [open])

  async function run() {
    setLoading(true); setResults(null)
    try {
      const r = await protonBulkConnect(proxyId || null, true)
      setResults(r.data)
      if (r.data.ok > 0) onDone()
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message)
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Масове підключення Proton (${protonToConnect.length})`} width={580}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!results ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>
              Спробуємо автоматично підключити {protonToConnect.length} Proton-акаунтів через hydroxide. Використовуються паролі з vault'у. <b>Проксі обовʼязковий для residential IP</b> — інакше Proton майже завжди дасть CAPTCHA.
            </div>
            <Field label="Проксі (residential / mobile)">
              <select value={proxyId} onChange={e => setProxyId(e.target.value)}>
                <option value="">— Без проксі (IP сервера, ризик CAPTCHA) —</option>
                {usableProxies.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.label || `${p.host}:${p.port}`)} · {p.type.toUpperCase()}
                    {p.country ? ` · ${p.country.toUpperCase()}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.55 }}>
              Підключення робиться послідовно — кожен акаунт займає 20–60 секунд. 2FA-захищені пропускаються (їх треба підключати по одному з кодом).
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" onClick={onClose} disabled={loading}>Скасувати</Btn>
              <Btn variant="success" loading={loading} onClick={run}>
                <Sparkles size={13} /> Запустити
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div style={{
              background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10,
              padding: 14, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, textAlign: 'center',
            }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--green)' }}>
                  {results.results.filter(r => r.status === 'ok').length}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>OK</div>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--yellow)' }}>
                  {results.results.filter(r => r.status === 'captcha').length}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>CAPTCHA</div>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
                  {results.results.filter(r => r.status === '2fa').length}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>2FA</div>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--red)' }}>
                  {results.results.filter(r => !['ok','captcha','2fa'].includes(r.status)).length}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>Помилок</div>
              </div>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {results.results.map(r => (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  background: 'var(--bg3)', borderRadius: 6, fontSize: 11,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: r.status === 'ok' ? 'var(--green)'
                              : r.status === 'captcha' ? 'var(--yellow)'
                              : r.status === '2fa' ? 'var(--accent)'
                              : 'var(--red)',
                  }} />
                  <span style={{ flex: 1, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.email}
                  </span>
                  <span style={{ color: 'var(--text3)' }}>{r.status}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Btn onClick={onClose}>Готово</Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function AccountRow({ account, active, color, onClick, onEdit, onDelete }) {
  const unread = account.last_unread ?? 0
  const hasError = !!account.last_error
  const winIsOpen = useWebmailStore(s => !!s.windows[account.id] && !s.windows[account.id].win.closed)
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
      background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : 'transparent',
      border: '1px solid', borderColor: active ? `color-mix(in srgb, ${color} 40%, transparent)` : 'transparent',
      transition: 'all 0.12s',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: `color-mix(in srgb, ${color} 22%, transparent)`,
        color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <MailIcon size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {account.label || account.email}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {account.email}
        </div>
      </div>
      {hasError && <AlertTriangle size={12} style={{ color: 'var(--red)', flexShrink: 0 }} title={account.last_error} />}
      {winIsOpen && (
        <span title="Активне вікно вебпошти" style={{
          width: 7, height: 7, borderRadius: '50%', background: 'var(--green)',
          flexShrink: 0, boxShadow: '0 0 0 2px rgba(48,209,88,0.25)',
        }} />
      )}
      {unread > 0 && (
        <span style={{
          background: color, color: '#fff', borderRadius: 999,
          padding: '2px 7px', fontSize: 10, fontWeight: 700, flexShrink: 0, minWidth: 18, textAlign: 'center',
        }}>{unread > 99 ? '99+' : unread}</span>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }} onClick={e => e.stopPropagation()}>
        <button onClick={onEdit} title="Редагувати"
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 1 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><Edit3 size={10} /></button>
        <button onClick={onDelete} title="Видалити"
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 1 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><Trash2 size={10} /></button>
      </div>
    </div>
  )
}

// Persist per-account view mode across SPA navigation
const VIEW_MODE_KEY = 'dm.mail.viewMode.v1'
function loadViewModes() {
  try { return JSON.parse(localStorage.getItem(VIEW_MODE_KEY) || '{}') } catch { return {} }
}
function saveViewMode(accountId, mode) {
  const m = loadViewModes(); m[accountId] = mode
  try { localStorage.setItem(VIEW_MODE_KEY, JSON.stringify(m)) } catch {}
}

function AccountPane({ account, openMsg, onOpenMsg }) {
  // Default view depends on account capability:
  //   - Proton (E2E-crypto blocks iframe embedding) → credential vault + popup window
  //   - IMAP-enabled (Gmail etc.) → IMAP messages list
  //   - other credential-only → embedded webmail
  const isCredOnly = isCredentialOnly(account)
  const stored = loadViewModes()[account.id]
  const defaultMode = isCredOnly ? 'creds' : 'imap'
  const [mode, setMode] = useState(stored || defaultMode)

  useEffect(() => {
    const s = loadViewModes()[account.id]
    setMode(s || defaultMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, isCredOnly])

  function changeMode(m) { setMode(m); saveViewMode(account.id, m) }

  // For IMAP accounts, if user opens a message we keep using the IMAP message view
  if (mode === 'imap' && !isCredOnly) {
    if (openMsg) return <MessageView accountId={account.id} uid={openMsg} onBack={() => onOpenMsg(null)} />
    return <MessageList account={account} onOpen={onOpenMsg}
      onSwitchToWebmail={() => changeMode('webmail')}
      onSwitchToCreds={() => changeMode('creds')} />
  }
  if (mode === 'webmail') {
    return <EmbeddedWebmail account={account}
      isCredOnly={isCredOnly}
      onSwitchToCreds={() => changeMode('creds')}
      onSwitchToImap={!isCredOnly ? () => changeMode('imap') : null}
    />
  }
  // Default for Proton: credentials vault with popup option
  return <CredentialVaultView account={account}
    onSwitchToWebmail={() => changeMode('webmail')}
    onSwitchToImap={!isCredOnly ? () => changeMode('imap') : null}
  />
}

// ── Embedded webmail (iframe with backend proxy) ──────────────────────────

function EmbeddedWebmail({ account, isCredOnly, onSwitchToCreds, onSwitchToImap }) {
  const wm = useWebmailStore()
  const winIsOpen = wm.windows[account.id] && !wm.windows[account.id].win.closed
  const [state, setState] = useState('idle')  // idle | granting | loading | ready | error
  const [error, setError] = useState(null)
  const [base, setBase] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [hideBanner, setHideBanner] = useState(false)
  const [stuck, setStuck] = useState(false)
  const webmail = webmailFor(account.email)
  const isProton = (account.email || '').toLowerCase().match(/@(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/)
  const isTuta = (account.email || '').toLowerCase().match(/@(tutanota\.com|tutanota\.de|tuta\.io|tuta\.com|keemail\.me|tutamail\.com)$/)

  // ProtonMail in iframe is genuinely impossible (Service Worker + E2E crypto +
  // their app actively detects iframe context and refuses to render).
  // We try iframe for Tutanota and other credential-only providers via our proxy
  // (which strips X-Frame-Options/CSP) — if it fails, a 30s "stuck" timer
  // surfaces the popup launcher as a fallback.
  if (isProton && webmail) {
    return <WebmailWindowLauncher account={account} webmail={webmail}
      onSwitchToCreds={onSwitchToCreds}
      onSwitchToImap={onSwitchToImap}
    />
  }

  // Show "stuck" overlay after 30s for any credential-only provider (Tuta, etc.)
  // — iframe may render their login page but fail later at the Service Worker step.
  useEffect(() => {
    if (state !== 'ready' || !(isProton || isTuta || isCredOnly)) return
    setStuck(false)
    const t = setTimeout(() => setStuck(true), 30000)
    return () => clearTimeout(t)
  }, [state, isProton, isTuta, isCredOnly, reloadKey])

  useEffect(() => {
    setState('granting'); setError(null); setBase(null)
    grantMailWebProxy(account.id)
      .then(r => { setBase(r.data.base); setState('ready') })
      .catch(e => { setError(e.response?.data?.detail || 'Не вдалось підключити проксі'); setState('error') })
  }, [account.id])

  const iframeSrc = `/api/mail/${account.id}/web-proxy/`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{account.label || account.email}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge color="blue">Вбудована вебпошта</Badge>
            <span style={{ fontFamily: 'var(--mono)' }}>{base || '…'}</span>
          </div>
        </div>
        <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} title="Перезавантажити">
          <RefreshCw size={13} />
        </Btn>
        {webmail && (
          <Btn size="sm" variant={winIsOpen ? 'success' : 'ghost'}
            onClick={() => {
              if (winIsOpen) wm.focus(account.id)
              else {
                const win = wm.open(account.id, webmail)
                if (!win) toast.error('Браузер заблокував попап')
                else useMailNotifications.getState().requestPermission()
              }
            }}
            title={winIsOpen ? 'Сфокусувати окреме вікно' : 'Відкрити в окремому вікні (надійніше для Proton)'}>
            <MailIcon size={13} /> {winIsOpen ? 'Активно' : 'У вікні'}
          </Btn>
        )}
        <Btn size="sm" variant="ghost" onClick={onSwitchToCreds}>
          Учетка
        </Btn>
        {onSwitchToImap && (
          <Btn size="sm" variant="ghost" onClick={onSwitchToImap}>
            IMAP
          </Btn>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff' }}>
        {state === 'granting' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text3)' }}>
            <Spinner /> <span style={{ fontSize: 12 }}>Підготовка проксі…</span>
          </div>
        )}
        {state === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text2)', padding: 32, textAlign: 'center' }}>
            <AlertTriangle size={32} style={{ color: 'var(--red)' }} />
            <div style={{ color: 'var(--red)' }}>{error}</div>
            <Btn variant="ghost" onClick={onSwitchToCreds}>Перейти у режим учеток</Btn>
          </div>
        )}
        {state === 'ready' && (
          <>
            <iframe
              key={reloadKey}
              src={iframeSrc}
              title={account.email}
              style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
              referrerPolicy="no-referrer-when-downgrade"
              allow="clipboard-read; clipboard-write; encrypted-media; geolocation; microphone; camera"
            />
            {(isProton || isTuta) && !hideBanner && !stuck && (
              <div style={{
                position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
                background: 'var(--bg2)', border: '1px solid var(--yellow)', borderRadius: 10,
                padding: '10px 14px', fontSize: 12, color: 'var(--text)', maxWidth: 520,
                display: 'flex', alignItems: 'flex-start', gap: 10, lineHeight: 1.4,
                boxShadow: '0 6px 24px rgba(0,0,0,0.4)', zIndex: 5,
              }}>
                <AlertTriangle size={16} style={{ color: 'var(--yellow)', flexShrink: 0, marginTop: 2 }} />
                <span style={{ flex: 1 }}>
                  {isProton ? 'Proton' : 'Tuta'} може повільно вантажитись — патчимо їхні Service Worker / URL виклики на льоту. Якщо застрягне — кнопка нижче.
                </span>
                <button onClick={() => setHideBanner(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0, marginTop: 2 }}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Stuck overlay — appears after a timeout if iframe doesn't progress */}
            {(isProton || isTuta) && stuck && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 10, padding: 40,
              }}>
                <div style={{
                  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
                  padding: 28, maxWidth: 480, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 14,
                }}>
                  <AlertTriangle size={36} style={{ color: 'var(--yellow)', margin: '0 auto' }} />
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {isProton ? 'Proton' : 'Tuta'} не довантажився за 30 секунд
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>
                    {isProton
                      ? 'Зазвичай це через Service Worker E2E-крипти, який не може зареєструватися в iframe.'
                      : 'Tuta теж використовує E2E через Service Worker — у iframe сесія часто зависає.'}
                    {' '}У повноцінному вікні все працює нативно.
                  </div>
                  <Btn variant="primary" onClick={() => {
                      const win = wm.open(account.id, webmail)
                      if (!win) toast.error('Браузер заблокував попап')
                      else useMailNotifications.getState().requestPermission()
                    }}>
                    <MailIcon size={14} /> Відкрити у вікні
                  </Btn>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <Btn size="sm" variant="ghost" onClick={() => { setStuck(false); setReloadKey(k => k + 1) }}>
                      <RefreshCw size={12} /> Спробувати ще раз
                    </Btn>
                    {onSwitchToCreds && (
                      <Btn size="sm" variant="ghost" onClick={onSwitchToCreds}>Назад до учеток</Btn>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Universal popup-window launcher for credential-only providers (Tutanota, Proton).
// Replaces the previous Proton-specific pane. Works for ANY service whose webmail
// can't survive being iframed (Service Worker / E2E crypto / strict X-Frame-Options).
function WebmailWindowLauncher({ account, webmail, onSwitchToCreds, onSwitchToImap }) {
  const wm = useWebmailStore()
  const isOpen = wm.windows[account.id] && !wm.windows[account.id].win.closed
  const autoOpenedRef = useRef(false)

  const domain = (account.email || '').toLowerCase().split('@')[1] || ''
  const isProton = /(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/i.test(domain)
  const isTuta = /(tutanota\.com|tutanota\.de|tuta\.io|tuta\.com|keemail\.me|tutamail\.com)$/i.test(domain)
  const providerName = isProton ? 'ProtonMail' : isTuta ? 'Tuta Mail' : 'Веб-пошта'
  const providerColor = isProton ? '#6d4aff' : isTuta ? '#840010' : 'var(--accent)'

  function openWindow() {
    const win = wm.open(account.id, webmail)
    if (!win) {
      toast.error('Браузер заблокував попап — дозвольте попапи для localhost і клацніть ще раз')
      return false
    }
    useMailNotifications.getState().requestPermission()
    return true
  }

  // Auto-open popup once per mount (best-effort — usually allowed because it
  // follows a click that switched into this view)
  useEffect(() => {
    if (!isOpen && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      openWindow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{account.label || account.email}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge color={isOpen ? 'green' : 'blue'}>{isOpen ? 'Окно активне' : 'Готове до відкриття'}</Badge>
            <span style={{ fontFamily: 'var(--mono)' }}>{webmail}</span>
          </div>
        </div>
        {onSwitchToCreds && <Btn size="sm" variant="ghost" onClick={onSwitchToCreds}>Учетка</Btn>}
        {onSwitchToImap && <Btn size="sm" variant="ghost" onClick={onSwitchToImap}>IMAP</Btn>}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          maxWidth: 560, width: '100%',
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16,
          padding: 32, display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center', textAlign: 'center',
        }}>
          {/* Icon */}
          <div style={{
            width: 80, height: 80, borderRadius: 20,
            background: isOpen
              ? 'linear-gradient(135deg, var(--green-dim), rgba(48,209,88,0.05))'
              : `linear-gradient(135deg, color-mix(in srgb, ${providerColor} 22%, transparent), color-mix(in srgb, ${providerColor} 4%, transparent))`,
            border: '1px solid', borderColor: isOpen ? 'rgba(48,209,88,0.4)' : `color-mix(in srgb, ${providerColor} 40%, transparent)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <MailIcon size={38} style={{ color: isOpen ? 'var(--green)' : providerColor }} />
            {isOpen && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                width: 18, height: 18, borderRadius: '50%',
                background: 'var(--green)', border: '3px solid var(--bg2)',
                animation: 'pulse 2s ease-in-out infinite',
              }} />
            )}
          </div>

          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
              {isOpen ? `${providerName} працює у вікні` : `Готуємо вікно ${providerName}…`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.55, maxWidth: 420, margin: '6px auto 0' }}>
              {isOpen
                ? 'Натисніть «Сфокусувати», щоб вивести вікно поверх. Воно живе доки відкрита платформа — переключайтесь між вкладками без втрати сесії.'
                : 'Якщо браузер заблокував попап — дозвольте попапи для цього сайту і клацніть «Відкрити».'}
            </div>
          </div>

          {/* Actions */}
          {isOpen ? (
            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <Btn variant="primary" style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => wm.focus(account.id)}>
                <MailIcon size={14} /> Сфокусувати вікно
              </Btn>
              <Btn variant="ghost" style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => wm.close(account.id)}>
                <X size={13} /> Закрити вікно
              </Btn>
            </div>
          ) : (
            <Btn variant="primary" style={{ width: '100%', justifyContent: 'center' }}
              onClick={openWindow}>
              <MailIcon size={14} /> Відкрити {providerName} у вікні
            </Btn>
          )}

          {/* Disclosure */}
          <details style={{ width: '100%', textAlign: 'left', fontSize: 11, color: 'var(--text3)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text2)', userSelect: 'none' }}>
              Чому не вбудовано прямо тут?
            </summary>
            <div style={{ marginTop: 8, padding: 12, background: 'var(--bg3)', borderRadius: 8, lineHeight: 1.55 }}>
              {isProton && <>ProtonMail використовує E2E-крипту через <b>Service Worker</b>, який не реєструється у iframe чужого origin'у — без нього дешифрування пошти не запускається. Окреме вікно браузера працює нативно.</>}
              {isTuta && <>Tuta (раніше Tutanota) — також E2E з Service Worker'ами, плюс у них немає IMAP взагалі. Тільки окреме вікно дозволяє повноцінне читання пошти.</>}
              {!isProton && !isTuta && <>Цей провайдер має E2E-крипту або жорсткі X-Frame-Options — iframe не пускає. Вікно браузера працює як нативно.</>}
            </div>
          </details>
        </div>
      </div>

      {/* Pulse keyframes */}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }`}</style>
    </div>
  )
}

// Kept for reference but not used — kept to avoid breaking any stale references.
// eslint-disable-next-line no-unused-vars
function ProtonWindowPane({ account, webmail, onSwitchToCreds, onSwitchToImap }) {
  const wm = useWebmailStore()
  const isOpen = wm.windows[account.id] && !wm.windows[account.id].win.closed
  const autoOpenedRef = useRef(false)

  function openWindow() {
    const win = wm.open(account.id, webmail)
    if (!win) {
      toast.error('Браузер заблокував попап — дозвольте попапи для localhost і клацніть ще раз')
      return false
    }
    useMailNotifications.getState().requestPermission()
    return true
  }

  // Auto-open popup once when user lands on this view (best-effort — popup
  // blockers usually allow it because it follows the click that switched tabs)
  useEffect(() => {
    if (!isOpen && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      openWindow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{account.label || account.email}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Badge color={isOpen ? 'green' : 'blue'}>{isOpen ? 'Окно активне' : 'Готове до відкриття'}</Badge>
            <span style={{ fontFamily: 'var(--mono)' }}>{webmail}</span>
          </div>
        </div>
        {onSwitchToCreds && <Btn size="sm" variant="ghost" onClick={onSwitchToCreds}>Учетка</Btn>}
        {onSwitchToImap && <Btn size="sm" variant="ghost" onClick={onSwitchToImap}>IMAP</Btn>}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          maxWidth: 560, width: '100%',
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16,
          padding: 32, display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center', textAlign: 'center',
        }}>
          {/* Icon */}
          <div style={{
            width: 80, height: 80, borderRadius: 20,
            background: isOpen
              ? 'linear-gradient(135deg, var(--green-dim), rgba(48,209,88,0.05))'
              : 'linear-gradient(135deg, var(--accent-dim), rgba(10,132,255,0.05))',
            border: '1px solid', borderColor: isOpen ? 'rgba(48,209,88,0.4)' : 'rgba(10,132,255,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <MailIcon size={38} style={{ color: isOpen ? 'var(--green)' : 'var(--accent)' }} />
            {isOpen && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                width: 18, height: 18, borderRadius: '50%',
                background: 'var(--green)', border: '3px solid var(--bg2)',
                animation: 'pulse 2s ease-in-out infinite',
              }} />
            )}
          </div>

          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
              {isOpen ? 'Proton працює у вікні' : 'Готуємо вікно Proton…'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.55, maxWidth: 420, margin: '6px auto 0' }}>
              {isOpen
                ? 'Натисніть «Сфокусувати», щоб вивести вікно поверх. Воно живе доки відкрита платформа — переключайтесь між вкладками без втрати сесії.'
                : 'Якщо браузер заблокував попап — дозвольте попапи для цього сайту і клацніть «Відкрити».'}
            </div>
          </div>

          {/* Actions */}
          {isOpen ? (
            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <Btn variant="primary" style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => wm.focus(account.id)}>
                <MailIcon size={14} /> Сфокусувати вікно
              </Btn>
              <Btn variant="ghost" style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => wm.close(account.id)}>
                <X size={13} /> Закрити вікно
              </Btn>
            </div>
          ) : (
            <Btn variant="primary" style={{ width: '100%', justifyContent: 'center' }}
              onClick={openWindow}>
              <MailIcon size={14} /> Відкрити Proton у вікні
            </Btn>
          )}

          {/* Disclosure */}
          <details style={{ width: '100%', textAlign: 'left', fontSize: 11, color: 'var(--text3)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text2)', userSelect: 'none' }}>
              Чому не вбудовано в iframe прямо тут?
            </summary>
            <div style={{
              marginTop: 8, padding: 12, background: 'var(--bg3)', borderRadius: 8,
              lineHeight: 1.55,
            }}>
              ProtonMail використовує E2E-крипту через <b>Service Worker</b>, який браузер відмовляється реєструвати у iframe чужого origin'у. Без SW дешифрування пошти просто не запускається — Proton зависає на «Loading». Архітектурне обмеження їхнього клієнта + браузерні політики безпеки. Окреме вікно браузера працює як нативно: своя cookie-сесія, своя SW-реєстрація, нативні push-нотифікації.
            </div>
          </details>
        </div>
      </div>

      {/* Pulse keyframes — inject once */}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }`}</style>
    </div>
  )
}

function NotificationBar() {
  const permission = useMailNotifications(s => s.permission)
  const request = useMailNotifications(s => s.requestPermission)
  const openCount = useWebmailStore(s => Object.values(s.windows).filter(w => !w.win.closed).length)

  // Hide if nothing to show
  if (permission === 'granted' && openCount === 0) return null

  return (
    <div style={{
      padding: '8px 12px', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
      background: permission === 'granted' ? 'var(--green-dim)' : 'var(--bg3)',
    }}>
      {permission !== 'granted' && (
        <button onClick={request} style={{
          background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
          padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <Sparkles size={11} /> Увімкнути сповіщення
        </button>
      )}
      {permission === 'granted' && openCount > 0 && (
        <span style={{ color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <CheckCircle2 size={12} /> {openCount} {openCount === 1 ? 'вікно' : 'вікон'} активно
        </span>
      )}
    </div>
  )
}

function CredentialVaultView({ account, onSwitchToWebmail, onSwitchToImap }) {
  const qc = useQueryClient()
  const [creds, setCreds] = useState(null)
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hydroOpen, setHydroOpen] = useState(false)
  const wm = useWebmailStore()
  const winIsOpen = wm.windows[account.id] && !wm.windows[account.id].win.closed
  // For Proton: auto-open the hydroxide connect modal on first land,
  // so user sees the flow that ACTUALLY makes mail work inline.
  const protonAutoOpenRef = useRef(false)
  const isProtonAcc = (account.email || '').toLowerCase().match(/@(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/)
  useEffect(() => {
    if (isProtonAcc && !protonAutoOpenRef.current) {
      protonAutoOpenRef.current = true
      // Defer so creds load first
      const t = setTimeout(() => setHydroOpen(true), 350)
      return () => clearTimeout(t)
    }
  }, [account.id, isProtonAcc])

  useEffect(() => {
    setLoading(true); setCreds(null); setShowPwd(false)
    revealMailCredentials(account.id)
      .then(r => setCreds(r.data))
      .catch(e => toast.error(e.response?.data?.detail || 'Помилка отримання даних'))
      .finally(() => setLoading(false))
  }, [account.id])

  function copy(text, label) {
    navigator.clipboard.writeText(text || '')
    toast.success(`${label} скопійовано`)
  }

  const webmail = webmailFor(account.email)
  const isProton = (account.email || '').toLowerCase().match(/@(protonmail\.com|proton\.me|pm\.me|protonmail\.ch)$/)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{account.label || account.email}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{account.email}</div>
        </div>
        <Badge color="blue">Сховище учеток</Badge>
        {onSwitchToImap && (
          <Btn size="sm" variant="ghost" onClick={onSwitchToImap}>IMAP</Btn>
        )}
        {onSwitchToWebmail && (
          <Btn size="sm" variant="ghost" onClick={onSwitchToWebmail}
            title="Вбудована вебпошта (для Proton працює нестабільно через E2E)">
            <MailIcon size={13} /> Веб
          </Btn>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 32, display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Info banner — pushes user to connect via hydroxide for inline mail */}
          {isProton && (
            <div style={{
              background: 'linear-gradient(135deg, var(--green-dim), var(--accent-dim))',
              border: '1px solid var(--green)', borderRadius: 14, padding: 18,
              fontSize: 13, color: 'var(--text)', lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 800, marginBottom: 8, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sparkles size={18} style={{ color: 'var(--green)' }} />
                Підключити Proton — пошта буде прямо тут
              </div>
              <div style={{ color: 'var(--text2)' }}>
                Натисніть кнопку нижче, введіть свій пароль Proton — далі пошта відобразиться у звичайному списку як Gmail. Без вікон, без iframe, без «Something went wrong». Працює через локальний open-source bridge (hydroxide), що говорить по Proton API.
              </div>
              <Btn variant="success" style={{ marginTop: 12, width: '100%', justifyContent: 'center', fontSize: 14, padding: '12px' }}
                onClick={() => setHydroOpen(true)}>
                <Sparkles size={16} /> Підключити цей акаунт зараз
              </Btn>
            </div>
          )}

          {/* Email */}
          <CredRow
            label="Email" value={account.email} mono
            onCopy={() => copy(account.email, 'Email')}
          />

          {/* Username (if different from email) */}
          {account.username && account.username !== account.email && (
            <CredRow
              label="Username" value={account.username} mono
              onCopy={() => copy(account.username, 'Username')}
            />
          )}

          {/* Password */}
          {loading ? <Spinner /> : (
            <CredRow
              label="Пароль"
              value={showPwd ? (creds?.password || '') : '•'.repeat(Math.min((creds?.password || '').length, 18))}
              mono
              onCopy={() => copy(creds?.password, 'Пароль')}
              extra={
                <button onClick={() => setShowPwd(s => !s)}
                  style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0 }}
                  title={showPwd ? 'Сховати' : 'Показати'}>
                  {showPwd ? '🙈' : '👁'}
                </button>
              }
            />
          )}

          {/* No popup-window UI for Proton accounts — connection happens inline via hydroxide.
              For non-Proton credential-only accounts, still allow the popup as a convenience. */}
          {webmail && !isProton && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn variant="ghost" size="sm"
                onClick={() => window.open(webmail, '_blank', 'noopener')}
                style={{ width: '100%', justifyContent: 'center' }}>
                Відкрити у новій вкладці
              </Btn>
            </div>
          )}

          {/* Hydroxide connect modal */}
          <HydroxideConnectModal open={hydroOpen} onClose={() => setHydroOpen(false)}
            account={account} initialPassword={creds?.password}
            onConnected={() => {
              setHydroOpen(false)
              qc.invalidateQueries(['mail-accounts'])
              toast.success('Proton підключено! Завантажую вхідні…')
              // Reset stored view mode so AccountPane picks the new default (IMAP)
              try {
                const m = JSON.parse(localStorage.getItem('dm.mail.viewMode.v1') || '{}')
                delete m[account.id]
                localStorage.setItem('dm.mail.viewMode.v1', JSON.stringify(m))
              } catch {}
            }}
          />

          {/* Quick fill block — copy both */}
          <button
            onClick={() => {
              if (!creds) return
              navigator.clipboard.writeText(`${account.email}\t${creds.password}`)
              toast.success('Email + пароль скопійовано (tab-separated)')
            }}
            style={{
              background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '10px 14px', color: 'var(--text2)', cursor: 'pointer', fontSize: 12,
              transition: 'all 0.15s', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
            <Copy size={12} /> Скопіювати email + пароль для авто-заповнення
          </button>
        </div>
      </div>
    </div>
  )
}

function HydroxideConnectModal({ open, onClose, account, initialPassword, onConnected }) {
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [need2fa, setNeed2fa] = useState(false)
  const [proxyId, setProxyId] = useState('')
  const [showProxy, setShowProxy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState('idle')  // idle | connecting | done
  const [lastError, setLastError] = useState(null)

  // Load user's proxies — we route hydroxide through one of them if Proton CAPTCHAs.
  const { data: proxies = [] } = useQuery({
    queryKey: ['proxies'], queryFn: () => getProxies().then(r => r.data),
    enabled: open, staleTime: 60000,
  })

  useEffect(() => {
    if (open) {
      setPassword(initialPassword || ''); setTotp(''); setNeed2fa(false)
      setProxyId(''); setShowProxy(false); setStage('idle'); setLastError(null)
    }
  }, [open, initialPassword])

  async function submit() {
    if (!password) return toast.error('Введіть пароль Proton')
    setLoading(true); setStage('connecting'); setLastError(null)
    try {
      const r = await protonConnect(account.email, password, need2fa ? totp : null, proxyId || null)
      setStage('done')
      setTimeout(() => onConnected(r.data), 600)
    } catch (e) {
      const detail = e.response?.data?.detail || e.message
      setLastError(detail)
      if (/2FA|totp/i.test(detail) && !need2fa) {
        setNeed2fa(true)
        toast('Введіть 2FA код', { icon: '🔐' })
      } else if (/captcha/i.test(detail) && !showProxy) {
        // Auto-expand proxy section after first CAPTCHA error
        setShowProxy(true)
      } else {
        toast.error(detail)
      }
      setStage('idle')
    } finally { setLoading(false) }
  }

  // Only show proxies that look usable (recently OK or never tested)
  const usableProxies = proxies.filter(p => p.is_active !== false && p.last_check_ok !== false)

  return (
    <Modal open={open} onClose={onClose} title="Підключити Proton через hydroxide" width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 12, fontSize: 11, color: 'var(--text2)', lineHeight: 1.5,
        }}>
          <b style={{ color: 'var(--text)' }}>Як це працює:</b> ваші креди підуть локально через
          {' '}<code style={{ fontFamily: 'var(--mono)' }}>hydroxide</code> (open-source ProtonMail-bridge від emersion).
          Він автентифікується через Proton API, кешує приватний ключ локально, далі піднімає IMAP
          на dm_hydroxide:1143. Bridge-пароль зберігається зашифрованим Fernet'ом.
        </div>

        <Field label="Email">
          <input value={account.email} disabled style={{ fontFamily: 'var(--mono)' }} />
        </Field>
        <Field label="Пароль Proton (від веб-інтерфейсу)">
          <input autoFocus type="password" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && submit()} />
        </Field>
        {need2fa && (
          <Field label="2FA код (TOTP, 6 цифр)">
            <input value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456" inputMode="numeric"
              style={{ fontFamily: 'var(--mono)', fontSize: 16, letterSpacing: '0.3em', textAlign: 'center' }}
              onKeyDown={e => e.key === 'Enter' && submit()} />
          </Field>
        )}

        {/* Last error banner */}
        {lastError && stage === 'idle' && (
          <div style={{
            background: 'var(--red-dim)', border: '1px solid rgba(255,69,58,0.3)', borderRadius: 8,
            padding: 10, fontSize: 11, color: 'var(--text)', lineHeight: 1.5,
          }}>
            <AlertTriangle size={12} style={{ color: 'var(--red)', verticalAlign: -1, marginRight: 4 }} />
            {lastError}
          </div>
        )}

        {/* Proxy section — collapsed by default, auto-expands after CAPTCHA error */}
        <button onClick={() => setShowProxy(s => !s)}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', textAlign: 'left', padding: 0, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {showProxy ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Через проксі {proxyId ? '(обрано)' : '(якщо є CAPTCHA)'}
        </button>
        {showProxy && (
          <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label="Проксі">
              <select value={proxyId} onChange={e => setProxyId(e.target.value)}>
                <option value="">— Без проксі (з IP сервера) —</option>
                {usableProxies.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.label || `${p.host}:${p.port}`)} · {p.type.toUpperCase()}
                    {p.country ? ` · ${p.country.toUpperCase()}` : ''}
                    {p.last_check_ok ? ' [OK]' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              Hydroxide піде через цей проксі (<code>HTTPS_PROXY</code>) при запиті до Proton API.
              Residential/mobile IP обходять CAPTCHA. Datacenter IP'и (DigitalOcean, Hetzner, тощо) Proton зазвичай блокує.
              {usableProxies.length === 0 && (
                <div style={{ marginTop: 6, color: 'var(--yellow)' }}>
                  У вас немає доступних проксі. Додайте у вкладці «Проксі» спочатку.
                </div>
              )}
            </div>
          </div>
        )}

        {stage === 'connecting' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: 'var(--bg3)', borderRadius: 8, fontSize: 12, color: 'var(--text2)' }}>
            <Spinner size={14} />
            <span>Hydroxide звертається до Proton API… (15–40 с)</span>
          </div>
        )}
        {stage === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: 'var(--green-dim)', borderRadius: 8, fontSize: 12, color: 'var(--green)' }}>
            <CheckCircle2 size={14} />
            <span>Підключено! Зараз перейдемо в IMAP-режим…</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose} disabled={loading}>Скасувати</Btn>
          <Btn loading={loading} disabled={!password || (need2fa && totp.length !== 6)} onClick={submit}>
            <Sparkles size={13} /> Підключити
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function CredRow({ label, value, mono, onCopy, extra }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
        <span style={{ flex: 1, fontFamily: mono ? 'var(--mono)' : 'var(--font)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
        {extra}
        {onCopy && (
          <button onClick={onCopy}
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
            title="Копіювати">
            <Copy size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

function ImapErrorPanel({ account, error }) {
  const detail = error?.response?.data?.detail || error?.message || 'Невідома помилка'
  const detailStr = String(detail).toLowerCase()
  // Network-layer failures: refused / unreachable / no route / timeout / no such host
  const isNetworkFail = /connection refused|errno 111|errno 101|errno 113|10061|network is unreachable|no route to host|host is down|name or service not known|temporary failure in name resolution|timeout|timed out/i.test(detailStr)
  const isAuthFailed = /auth|login|password|invalid credentials|bad credentials/i.test(detailStr)
  const isProton = (account?.email || '').toLowerCase().endsWith('@protonmail.com')
    || (account?.email || '').toLowerCase().endsWith('@proton.me')
    || (account?.email || '').toLowerCase().endsWith('@pm.me')
    || (account?.imap_host || '').includes('host.docker.internal')

  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, height: '100%', textAlign: 'center' }}>
      <AlertTriangle size={36} style={{ color: 'var(--red)' }} />
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>{detail}</div>

      {isProton && isNetworkFail && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, maxWidth: 580, textAlign: 'left', fontSize: 12, lineHeight: 1.55, color: 'var(--text2)' }}>
          <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13, marginBottom: 8 }}>ProtonMail Bridge не доступний</div>
          <div>Для IMAP до Proton треба запущений <b>ProtonMail Bridge</b> на вашому хості:</div>
          <ol style={{ marginTop: 8, marginBottom: 8, paddingLeft: 18 }}>
            <li>Платний Proton акаунт (Plus / Unlimited / Business)</li>
            <li>Завантажити <a href="https://proton.me/mail/bridge" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>ProtonMail Bridge</a> для macOS/Windows</li>
            <li>Залогінитись у Bridge своїм Proton акаунтом і дозволити IMAP</li>
            <li>Bridge видає <b>окремий IMAP-пароль</b> (НЕ той що для вебінтерфейсу) — копіюйте його з налаштувань Bridge у поле «Пароль»</li>
          </ol>
          <div style={{ marginTop: 8, color: 'var(--text3)' }}>
            Bridge створює IMAP на <code style={{ fontFamily: 'var(--mono)' }}>127.0.0.1:1143</code> вашого хоста. З Docker-контейнера ми звертаємось через <code style={{ fontFamily: 'var(--mono)' }}>host.docker.internal</code>. Якщо запускаєте на Linux без Docker Desktop — можете відредагувати скриньку і вказати реальний IP.
          </div>
        </div>
      )}

      {!isProton && isNetworkFail && (
        <div style={{ fontSize: 12, color: 'var(--text3)', maxWidth: 480 }}>
          IMAP сервер не відповідає або недосяжний з мережі. Перевірте host/port та чи з контейнера бекенду є доступ.
        </div>
      )}

      {isAuthFailed && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, maxWidth: 480, fontSize: 12, color: 'var(--text2)' }}>
          Невдала автентифікація. Для Gmail/Yahoo/iCloud потрібен <b>App Password</b>, а не звичайний пароль. Для Proton — пароль з Bridge.
        </div>
      )}
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text3)' }}>
      <Inbox size={48} style={{ opacity: 0.4 }} />
      <span style={{ fontSize: 13 }}>Немає підключених скриньок</span>
      <Btn onClick={onAdd}><Plus size={14} /> Додати першу</Btn>
    </div>
  )
}

// ── Message list ────────────────────────────────────────────────────────

function MessageList({ account, onOpen, onSwitchToWebmail, onSwitchToCreds }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const wm = useWebmailStore()
  const winIsOpen = wm.windows[account.id] && !wm.windows[account.id].win.closed
  const webmail = webmailFor(account.email)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['mail-messages', account.id],
    queryFn: () => listMailMessages(account.id).then(r => r.data),
    refetchOnWindowFocus: false,
  })

  const messages = data?.messages || []
  const filtered = useMemo(() => {
    if (!search) return messages
    const q = search.toLowerCase()
    return messages.filter(m =>
      (m.subject || '').toLowerCase().includes(q) ||
      (m.from || '').toLowerCase().includes(q)
    )
  }, [messages, search])

  async function doRefresh() {
    setRefreshing(true)
    try {
      await refreshMailAccount(account.id)
      qc.invalidateQueries(['mail-accounts'])
      await refetch()
    } finally { setRefreshing(false) }
  }

  return (
    <>
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{account.label || account.email}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {account.email} · {account.imap_host}
            {account.last_check_at && ` · оновлено ${new Date(account.last_check_at).toLocaleTimeString('uk-UA')}`}
          </div>
        </div>
        {account.last_unread != null && account.last_unread > 0 && (
          <Badge color="blue">{account.last_unread} нових</Badge>
        )}
        <div style={{ position: 'relative', width: 220 }}>
          <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук..." style={{ paddingLeft: 28 }} />
        </div>
        {webmail && (
          <Btn size="sm" variant={winIsOpen ? 'success' : 'ghost'}
            onClick={() => {
              if (winIsOpen) wm.focus(account.id)
              else {
                const win = wm.open(account.id, webmail)
                if (!win) toast.error('Браузер заблокував попап')
                else useMailNotifications.getState().requestPermission()
              }
            }}
            title={winIsOpen ? 'Сфокусувати вікно вебпошти' : 'Тримати вебпошту відкритою'}>
            <MailIcon size={12} /> {winIsOpen ? 'Активно' : 'У вікні'}
          </Btn>
        )}
        <Btn size="sm" variant="ghost" loading={refreshing} onClick={doRefresh}>
          <RefreshCw size={13} />
        </Btn>
        {onSwitchToWebmail && (
          <Btn size="sm" variant="ghost" onClick={onSwitchToWebmail} title="Вбудована вебпошта">
            <MailIcon size={13} /> Веб
          </Btn>
        )}
        {onSwitchToCreds && (
          <Btn size="sm" variant="ghost" onClick={onSwitchToCreds}>Учетка</Btn>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : isError ? (
            <ImapErrorPanel account={account} error={error} />
          ) : filtered.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              {search ? 'Нічого не знайдено' : 'Папка порожня'}
            </div>
          ) : filtered.map(m => <MessageRow key={m.uid} msg={m} onClick={() => onOpen(m.uid)} />)
        }
      </div>
    </>
  )
}

function MessageRow({ msg, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 20px', borderBottom: '1px solid var(--border)',
      cursor: 'pointer', background: msg.unread ? 'var(--bg2)' : 'transparent',
      borderLeft: '3px solid', borderLeftColor: msg.unread ? 'var(--accent)' : 'transparent',
      transition: 'background 0.1s',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
      onMouseLeave={e => e.currentTarget.style.background = msg.unread ? 'var(--bg2)' : 'transparent'}
    >
      <div style={{ flex: '0 0 200px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: msg.unread ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {msg.from || '(без відправника)'}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: msg.unread ? 700 : 400, color: msg.unread ? 'var(--text)' : 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {msg.subject || '(без теми)'}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>
        {msg.date ? new Date(msg.date).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
      </div>
    </div>
  )
}

// ── Message view ────────────────────────────────────────────────────────

function MessageView({ accountId, uid, onBack }) {
  const { data: msg, isLoading } = useQuery({
    queryKey: ['mail-message', accountId, uid],
    queryFn: () => getMailMessage(accountId, uid).then(r => r.data),
  })

  return (
    <>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <Btn size="sm" variant="ghost" onClick={onBack}><ChevronLeft size={13} /> Назад</Btn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {msg?.subject || '...'}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {isLoading ? <Spinner /> : !msg ? <div>Не знайдено</div> : (
          <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{msg.subject || '(без теми)'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 12px', fontSize: 12 }}>
                <span style={{ color: 'var(--text3)' }}>Від</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{msg.from}</span>
                <span style={{ color: 'var(--text3)' }}>Кому</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{msg.to}</span>
                {msg.cc && <>
                  <span style={{ color: 'var(--text3)' }}>Cc</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{msg.cc}</span>
                </>}
                <span style={{ color: 'var(--text3)' }}>Дата</span>
                <span>{msg.date ? new Date(msg.date).toLocaleString('uk-UA') : ''}</span>
              </div>
            </div>

            {msg.attachments?.length > 0 && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {msg.attachments.map((a, i) => (
                  <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg3)', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
                    <Paperclip size={11} />
                    <span>{a.filename}</span>
                    <span style={{ color: 'var(--text3)' }}>{(a.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ background: '#fff', borderRadius: 12, padding: 16, color: '#000', minHeight: 200 }}>
              {msg.html ? (
                <iframe
                  srcDoc={msg.html}
                  title="message"
                  style={{ width: '100%', minHeight: 400, border: 'none' }}
                  sandbox="allow-same-origin"
                />
              ) : msg.text ? (
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font)', fontSize: 13, margin: 0 }}>{msg.text}</pre>
              ) : (
                <em style={{ color: '#888' }}>(пусте тіло)</em>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ── Edit / add modal ────────────────────────────────────────────────────

function EditAccountModal({ modal, onClose, onSaved }) {
  const isNew = modal === 'new'
  const a = !isNew && modal ? modal : null

  const [form, setForm] = useState(blank())
  const [advanced, setAdvanced] = useState(false)
  const [autoDetected, setAutoDetected] = useState(null) // { label, hint }
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [providerKey, setProviderKey] = useState('')

  // Load all provider presets so user can explicitly pick one
  const { data: presets = {} } = useQuery({
    queryKey: ['mail-presets'], queryFn: () => getMailPresets().then(r => r.data),
    staleTime: Infinity, enabled: !!modal,
  })

  useEffect(() => {
    if (!modal) return
    if (isNew) { setForm(blank()); setAdvanced(false); setAutoDetected(null); setProviderKey('') }
    else {
      setForm({
        label: a.label || '', email: a.email,
        imap_host: a.imap_host, imap_port: a.imap_port, imap_ssl: a.imap_ssl,
        username: a.username, password: '',
      })
      setAdvanced(true)
      setAutoDetected(null)
      // Detect which preset the existing host matches
      const match = Object.entries(presets).find(([_, p]) => p.host && p.host === a.imap_host)
      setProviderKey(match ? match[0] : 'custom')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal])

  function pickProvider(key) {
    setProviderKey(key)
    const p = presets[key]
    if (!p) return
    if (key === 'custom') {
      setAdvanced(true)
      return
    }
    setForm(f => ({
      ...f,
      imap_host: p.host || '',
      imap_port: p.port || 993,
      imap_ssl: !!p.ssl,
    }))
    // Show hint via autoDetected slot
    setAutoDetected({ label: p.label, hint: p.hint, app_password_url: p.app_password_url })
  }

  // Auto-detect IMAP settings based on email domain — only when user hasn't picked a provider explicitly
  useEffect(() => {
    if (!isNew || !form.email || !form.email.includes('@')) {
      setAutoDetected(null); return
    }
    if (providerKey && providerKey !== '') return  // user picked manually, don't override
    const handle = setTimeout(async () => {
      try {
        const r = await detectMailDomain(form.email)
        if (r.data.detected) {
          const k = r.data.key || ''
          const url = presets[k]?.app_password_url
          setAutoDetected({ label: r.data.label, hint: r.data.hint, host: r.data.host, app_password_url: url })
          setProviderKey(k)
          setForm(f => ({ ...f, imap_host: r.data.host, imap_port: r.data.port, imap_ssl: r.data.ssl }))
        } else {
          setAutoDetected({ label: null, hint: null })
        }
      } catch { /* ignore */ }
    }, 300)
    return () => clearTimeout(handle)
  }, [form.email, isNew, providerKey])

  async function test() {
    setTesting(true)
    try {
      const r = await testMailAccount({ email: form.email, password: form.password,
        ...(advanced ? { imap_host: form.imap_host, imap_port: form.imap_port, imap_ssl: form.imap_ssl, username: form.username || null } : {}),
      })
      toast.success(`OK — ${r.data.unread} нових з ${r.data.total}`)
    } catch (e) { toast.error(e.response?.data?.detail || 'Помилка перевірки') }
    finally { setTesting(false) }
  }

  async function submit() {
    if (!form.email || (isNew && !form.password)) {
      return toast.error('Email і пароль обовʼязкові')
    }
    setLoading(true)
    try {
      // Backend autodetects host/port/ssl/username from email when omitted
      const payload = {
        label: form.label || null,
        email: form.email,
        password: form.password,
      }
      if (advanced) {
        if (form.imap_host) payload.imap_host = form.imap_host
        if (form.imap_port) payload.imap_port = form.imap_port
        if (form.imap_ssl !== undefined) payload.imap_ssl = form.imap_ssl
        if (form.username) payload.username = form.username
      }
      if (!isNew && !payload.password) delete payload.password
      if (isNew) await createMailAccount(payload)
      else await updateMailAccount(a.id, payload)
      toast.success(isNew ? 'Додано' : 'Збережено')
      onSaved(); onClose()
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message)
    } finally { setLoading(false) }
  }

  return (
    <Modal open={!!modal} onClose={onClose} title={isNew ? 'Додати поштову скриньку' : 'Редагувати'} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Explicit provider picker with short labels + icons.
            Auto-fit grid so labels never truncate awkwardly. */}
        <Field label="Провайдер пошти">
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
            gap: 6,
          }}>
            {Object.entries(presets).map(([k, p]) => {
              const short = SHORT_PROVIDER_LABEL[k] || p.label
              const active = providerKey === k
              return (
                <button key={k} onClick={() => pickProvider(k)} type="button"
                  title={p.label}
                  style={{
                    padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                    background: active ? 'var(--accent-dim)' : 'var(--bg3)',
                    border: '1px solid', borderColor: active ? 'var(--accent)' : 'var(--border)',
                    color: active ? 'var(--accent)' : 'var(--text2)',
                    fontSize: 11, fontWeight: 600, transition: 'all 0.12s',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    minWidth: 0,
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border2)' }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border)' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                    {short}
                  </span>
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Email *">
          <input autoFocus value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="me@gmail.com" />
        </Field>

        {/* Auto-detect status */}
        {isNew && form.email && form.email.includes('@') && (
          autoDetected?.label ? (
            <div style={{ background: 'var(--green-dim)', border: '1px solid rgba(48,209,88,0.3)', borderRadius: 8, padding: 10, fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={13} style={{ color: 'var(--green)' }} />
              <span>Автоматично: <b>{autoDetected.label}</b></span>
            </div>
          ) : autoDetected && !autoDetected.label ? (
            <div style={{ background: 'var(--yellow-dim)', border: '1px solid rgba(255,214,10,0.3)', borderRadius: 8, padding: 10, fontSize: 11, color: 'var(--text2)' }}>
              Невідомий домен — увімкніть «Розширено» і вкажіть IMAP вручну.
            </div>
          ) : null
        )}
        {autoDetected?.hint && (
          <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(10,132,255,0.3)', borderRadius: 8, padding: 10, fontSize: 11, color: 'var(--text2)', lineHeight: 1.45 }}>
            ℹ {autoDetected.hint}
            {autoDetected.app_password_url && (
              <div style={{ marginTop: 6 }}>
                <a href={autoDetected.app_password_url} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--accent)', textDecoration: 'underline', fontWeight: 600 }}>
                  → Створити App Password
                </a>
              </div>
            )}
          </div>
        )}

        <Field label={isNew ? 'Пароль *' : 'Пароль (порожньо = не змінювати)'}>
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && submit()} />
        </Field>

        <Field label="Підпис (опційно)">
          <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder={form.email ? form.email.split('@')[0] : 'Робоча Gmail'} />
        </Field>

        {/* Advanced toggle */}
        <button onClick={() => setAdvanced(s => !s)}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: 0 }}>
          {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Розширено (IMAP host/port/SSL)
        </button>

        {advanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '2px solid var(--border)', paddingLeft: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 2 }}>
                <Field label="IMAP host">
                  <input value={form.imap_host || ''} onChange={e => setForm(f => ({ ...f, imap_host: e.target.value }))} placeholder="auto" />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Port">
                  <input type="number" value={form.imap_port || ''} onChange={e => setForm(f => ({ ...f, imap_port: +e.target.value || null }))} placeholder="993" />
                </Field>
              </div>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.imap_ssl} onChange={e => setForm(f => ({ ...f, imap_ssl: e.target.checked }))} style={{ width: 'auto' }} />
              SSL / TLS
            </label>
            <Field label="Username">
              <input value={form.username || ''} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder={form.email || 'як email'} />
            </Field>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          <Btn size="sm" variant="ghost" loading={testing} onClick={test}
            disabled={!form.email || !form.password}>
            <CheckCircle2 size={13} /> Перевірити
          </Btn>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
            <Btn loading={loading} onClick={submit}>{isNew ? 'Додати' : 'Зберегти'}</Btn>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function blank() {
  return { label: '', email: '', imap_host: '', imap_port: null, imap_ssl: true, username: '', password: '' }
}

// ── Import modal ─────────────────────────────────────────────────────────

function ImportModal({ open, onClose, onDone }) {
  const [text, setText] = useState('')
  const [validate, setValidate] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => { if (open) { setText(''); setValidate(false); setResult(null) } }, [open])

  // Live preview of what we'll parse
  const previewCount = useMemo(() => {
    const re = /([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\s*:\s*(\S+)/g
    return (text.match(re) || []).length
  }, [text])

  async function submit() {
    setLoading(true)
    try {
      const r = await importMailAccounts(text, validate)
      setResult(r.data)
      if (r.data.created > 0) onDone()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка імпорту')
    } finally { setLoading(false) }
  }

  function handleClose() {
    setResult(null); setText(''); onClose()
  }

  return (
    <Modal open={open} onClose={handleClose} title="Імпорт пошт" width={600}>
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{
            background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10,
            padding: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, textAlign: 'center',
          }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--green)' }}>{result.created}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Додано</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--yellow)' }}>{result.skipped}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Пропущено</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--red)' }}>{result.errors.length}</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Помилок</div>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.errors.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '4px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                  <span style={{ fontFamily: 'var(--mono)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.email}</span>
                  <span style={{ color: 'var(--red)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.error}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn onClick={handleClose}>Готово</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
            Вставте текст з пошту:пароль на кожному рядку. Все інше (заголовки, банери, прикраси) ігнорується. IMAP-сервер визначається автоматично по домену.
          </p>
          <Field label={`Текст ${previewCount > 0 ? `· знайдено ${previewCount} пар` : ''}`}>
            <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={12}
              placeholder={'user1@gmail.com:Password123\nuser2@protonmail.com:Secret456\n\nможна вставити цілий блок із замовлення — паттерн email:password витягнеться сам'}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={validate} onChange={e => setValidate(e.target.checked)} style={{ width: 'auto' }} />
            Перевіряти кожну (повільно, але одразу видно биті)
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={previewCount === 0} onClick={submit}>
              <Upload size={14} /> Імпортувати {previewCount > 0 ? `(${previewCount})` : ''}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}
