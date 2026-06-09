import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Edit3, RefreshCw, Mail as MailIcon, Inbox, Send, Search,
  Paperclip, ChevronLeft, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react'

import {
  getMailPresets, getMailAccounts, createMailAccount, updateMailAccount, deleteMailAccount,
  refreshMailAccount, refreshAllMail, testMailAccount,
  listMailMessages, getMailMessage,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const PRESET_COLORS = ['#0a84ff', '#30d158', '#ff453a', '#ffd60a', '#bf5af2', '#ff9f0a', '#64d2ff']

export default function MailPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [active, setActive] = useState(null)
  const [editModal, setEditModal] = useState(null) // 'new' | account
  const [openMsg, setOpenMsg] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => getMailAccounts().then(r => r.data),
    refetchInterval: 60000, // refresh meta every minute
  })

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

  const totalUnread = accounts.reduce((s, a) => s + (a.last_unread || 0), 0)

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
        <div style={{ padding: '8px 10px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
          <Btn size="sm" loading={refreshing} onClick={refreshAll} title="Оновити всі"
            style={{ flex: 1, justifyContent: 'center' }}>
            <RefreshCw size={12} />
          </Btn>
          <Btn size="sm" onClick={() => setEditModal('new')} style={{ flex: 1, justifyContent: 'center' }}>
            <Plus size={12} /> Додати
          </Btn>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {isLoading ? <Spinner /> : accounts.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              Додайте першу скриньку
            </div>
          ) : accounts.map((a, i) => (
            <AccountRow key={a.id} account={a} active={active?.id === a.id} color={PRESET_COLORS[i % PRESET_COLORS.length]}
              onClick={() => setActive(a)}
              onEdit={() => setEditModal(a)}
              onDelete={() => gateDelete(() => delMut.mutateAsync(a.id)).catch(() => {})}
            />
          ))}
        </div>
      </aside>

      {/* Main pane */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!active ? (
          <EmptyState onAdd={() => setEditModal('new')} />
        ) : openMsg ? (
          <MessageView accountId={active.id} uid={openMsg} onBack={() => setOpenMsg(null)} />
        ) : (
          <MessageList account={active} onOpen={setOpenMsg} />
        )}
      </div>

      <EditAccountModal modal={editModal} onClose={() => setEditModal(null)}
        onSaved={() => qc.invalidateQueries(['mail-accounts'])} />
    </div>
  )
}

function AccountRow({ account, active, color, onClick, onEdit, onDelete }) {
  const unread = account.last_unread ?? 0
  const hasError = !!account.last_error
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

function MessageList({ account, onOpen }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

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
        <Btn size="sm" variant="ghost" loading={refreshing} onClick={doRefresh}>
          <RefreshCw size={13} />
        </Btn>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : isError ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--red)', fontSize: 13 }}>
              <AlertTriangle size={24} style={{ marginBottom: 8 }} />
              <div>{error?.response?.data?.detail || 'Помилка завантаження'}</div>
            </div>
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

  const { data: presets } = useQuery({
    queryKey: ['mail-presets'], queryFn: () => getMailPresets().then(r => r.data),
    staleTime: Infinity, enabled: !!modal,
  })

  const [presetKey, setPresetKey] = useState('custom')
  const [form, setForm] = useState(blank())
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!modal) return
    if (isNew) {
      setPresetKey('gmail')
      setForm(blank())
    } else {
      // Detect preset by host
      let key = 'custom'
      if (presets) {
        for (const [k, p] of Object.entries(presets)) {
          if (p.host && p.host === a.imap_host) { key = k; break }
        }
      }
      setPresetKey(key)
      setForm({
        label: a.label || '', email: a.email, imap_host: a.imap_host,
        imap_port: a.imap_port, imap_ssl: a.imap_ssl, username: a.username,
        password: '', color: a.color || '',
      })
    }
  }, [modal, presets])

  function applyPreset(key) {
    setPresetKey(key)
    if (presets?.[key] && key !== 'custom') {
      setForm(f => ({ ...f, imap_host: presets[key].host, imap_port: presets[key].port, imap_ssl: presets[key].ssl }))
    }
  }

  async function test() {
    setTesting(true)
    try {
      const r = await testMailAccount(form)
      toast.success(`OK — ${r.data.unread} нових з ${r.data.total}`)
    } catch (e) { toast.error(e.response?.data?.detail || 'Помилка перевірки') }
    finally { setTesting(false) }
  }

  async function submit() {
    if (!form.email || !form.imap_host || !form.username || (isNew && !form.password)) {
      return toast.error('Заповніть обовʼязкові поля')
    }
    setLoading(true)
    try {
      const payload = { ...form }
      if (!isNew && !payload.password) delete payload.password
      if (isNew) await createMailAccount(payload)
      else await updateMailAccount(a.id, payload)
      toast.success(isNew ? 'Додано' : 'Збережено')
      onSaved(); onClose()
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message)
    } finally { setLoading(false) }
  }

  const hint = presets?.[presetKey]?.hint
  return (
    <Modal open={!!modal} onClose={onClose} title={isNew ? 'Додати поштову скриньку' : 'Редагувати'} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Провайдер">
          <select value={presetKey} onChange={e => applyPreset(e.target.value)}>
            {presets && Object.entries(presets).map(([k, p]) => (
              <option key={k} value={k}>{p.label}</option>
            ))}
          </select>
        </Field>
        {hint && (
          <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(10,132,255,0.3)', borderRadius: 8, padding: 10, fontSize: 11, color: 'var(--text2)' }}>
            ℹ {hint}
          </div>
        )}
        <Field label="Підпис (для боковій панелі)">
          <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Робоча Gmail" />
        </Field>
        <Field label="Email *">
          <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value, username: f.username || e.target.value }))} placeholder="me@example.com" />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 2 }}>
            <Field label="IMAP host *">
              <input value={form.imap_host} onChange={e => setForm(f => ({ ...f, imap_host: e.target.value }))} placeholder="imap.example.com"
                disabled={presetKey !== 'custom'} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Port">
              <input type="number" value={form.imap_port} onChange={e => setForm(f => ({ ...f, imap_port: +e.target.value || 993 }))}
                disabled={presetKey !== 'custom'} />
            </Field>
          </div>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.imap_ssl} onChange={e => setForm(f => ({ ...f, imap_ssl: e.target.checked }))} style={{ width: 'auto' }} disabled={presetKey !== 'custom'} />
          SSL / TLS
        </label>
        <Field label="Username *">
          <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="зазвичай той самий, що email" />
        </Field>
        <Field label={isNew ? 'Password *' : 'Password (порожньо = не змінювати)'}>
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <Btn size="sm" variant="ghost" loading={testing} onClick={test}
            disabled={!form.imap_host || !form.username || !form.password}>
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
  return { label: '', email: '', imap_host: '', imap_port: 993, imap_ssl: true, username: '', password: '', color: '' }
}
