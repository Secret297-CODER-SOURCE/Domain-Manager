import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, RefreshCw, Pencil, Cloud, Globe, CheckCircle2, AlertTriangle, Search,
  X, ScrollText, ShieldOff, Eye, Layers, ChevronRight, Sparkles, FileText, AlertCircle,
} from 'lucide-react'
import {
  getTeams,
  getAllCFAccounts, createCFAccount, updateCFAccount, deleteCFAccount,
  getDynadotAccounts, createDynadotAccount, updateDynadotAccount, deleteDynadotAccount,
  syncDynadotAccount,
  syncCFAccount, syncAll,
  getCFAccountDetail, cfAccountCleanup,
  getDomains, getDnsRecords, deleteDomainFromCF,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import AnimatedIcon from '../components/ui/AnimatedIcon'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const TABS = [
  { key: 'cf',  label: 'Cloudflare', icon: Cloud,  color: '#f48120' },
  { key: 'dyn', label: 'Dynadot',    icon: Globe,  color: '#2e9cee' },
]

export default function CloudflarePage() {
  const [tab, setTab] = useState('cf')
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [detailId, setDetailId] = useState(null)

  const { data: teams = [], isLoading: teamsLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
  })

  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()

  function refresh() {
    qc.invalidateQueries({ queryKey: ['cf-all'] })
    qc.invalidateQueries({ queryKey: ['dyn-all'] })
  }

  // Global sync: hits backend sync_all_accounts → pulls zones + full DNS
  // for every active CF account in parallel-ish chain.
  const syncAllMut = useMutation({
    mutationFn: () => syncAll().then(r => r.data),
    onSuccess: (data) => {
      const s = data?.stats || {}
      toast.success(
        `Синхронізовано ${s.accounts ?? '?'} CF акаунтів: +${s.created ?? 0} нових, ~${s.updated ?? 0} оновлено${s.errors ? ` · ${s.errors} помилок` : ''}`,
        { duration: 6000 },
      )
      refresh()
    },
    onError: (e) => toast.error('Sync-all error: ' + (e.response?.data?.detail || e.message)),
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Cloud size={22} style={{ color: '#f48120' }} /> Cloudflare & Реєстратори
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Усі API-акаунти Cloudflare та Dynadot в одному місці. Команду обираєш при додаванні — не потрібно лазити по «Налаштування → команда → +».
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'cf' && (
            <Btn variant="ghost" loading={syncAllMut.isPending}
              onClick={() => syncAllMut.mutate()}
              title="Запустити повну синхронізацію всіх активних CF акаунтів">
              <RefreshCw size={14} /> Sync all
            </Btn>
          )}
          <Btn onClick={() => setAddOpen(true)} disabled={teams.length === 0}>
            <Plus size={14} /> Додати {tab === 'cf' ? 'CF акаунт' : 'Dynadot акаунт'}
          </Btn>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', background: 'none',
                border: 'none', borderBottom: `2px solid ${active ? t.color : 'transparent'}`,
                color: active ? 'var(--text)' : 'var(--text3)',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
              <Icon size={14} style={{ color: t.color }} /> {t.label}
            </button>
          )
        })}
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text3)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук за назвою або email…"
          style={{ width: '100%', paddingLeft: 32 }} />
      </div>

      {teamsLoading ? <Spinner /> : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'cf'
            ? <CFList teams={teams} search={search} onEdit={setEditing} onOpen={setDetailId} gateDelete={gateDelete} />
            : <DynList teams={teams} search={search} onEdit={setEditing} gateDelete={gateDelete} />}
        </div>
      )}

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} teams={teams}
        kind={tab} onSaved={refresh} />
      <EditAccountModal open={!!editing} onClose={() => setEditing(null)} teams={teams}
        kind={tab} account={editing} onSaved={refresh} />
      <CFDetailPanel accountId={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  )
}

// ── Cloudflare list ──────────────────────────────────────────────────────

function CFList({ teams, search, onEdit, onOpen, gateDelete }) {
  const qc = useQueryClient()
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['cf-all'],
    queryFn: () => getAllCFAccounts().then(r => r.data),
  })
  const delMut = useMutation({
    mutationFn: ({ teamId, id }) => deleteCFAccount(teamId, id),
    onSuccess: () => { toast.success('CF акаунт видалено'); qc.invalidateQueries({ queryKey: ['cf-all'] }) },
  })
  const syncMut = useMutation({
    mutationFn: (id) => syncCFAccount(id),
    onSuccess: (r) => toast.success(`Синхронізовано: +${r.data.stats.created} доменів`),
    onError: () => toast.error('Помилка синхронізації'),
  })
  const teamName = (id) => teams.find(t => t.id === id)?.name || `#${id}`
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter(a =>
      !q || a.name.toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q)
    )
  }, [accounts, search])

  if (isLoading) return <Spinner />
  if (!filtered.length) return <Empty label="Немає CF акаунтів" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {filtered.map(a => (
        <AccountRow key={a.id}
          color="#f48120" icon={Cloud}
          title={a.name}
          subtitle={[a.email, a.created_by_username && `by ${a.created_by_username}`].filter(Boolean).join(' · ')}
          team={teamName(a.team_id)}
          active={a.is_active}
          extra={<>
            <Badge color={a.domains_count > 0 ? 'blue' : 'default'}>
              {a.domains_count.toLocaleString('uk-UA')} {a.domains_count === 1 ? 'домен' : 'доменів'}
            </Badge>
            {a.account_id && <Badge color="default">{a.account_id.slice(0, 8)}</Badge>}
          </>}
          onClick={() => onOpen?.(a.id)}
          onSync={() => syncMut.mutate(a.id)}
          onEdit={() => onEdit(a)}
          onDelete={() => gateDelete(() => delMut.mutateAsync({ teamId: a.team_id, id: a.id })).catch(() => {})}
        />
      ))}
    </div>
  )
}

// ── Dynadot list ─────────────────────────────────────────────────────────

function DynList({ teams, search, onEdit, gateDelete }) {
  const qc = useQueryClient()
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['dyn-all'],
    queryFn: () => getDynadotAccounts().then(r => r.data),
  })
  const delMut = useMutation({
    mutationFn: (id) => deleteDynadotAccount(id),
    onSuccess: () => { toast.success('Dynadot акаунт видалено'); qc.invalidateQueries({ queryKey: ['dyn-all'] }) },
  })
  const syncMut = useMutation({
    mutationFn: (id) => syncDynadotAccount(id),
    onSuccess: (r) => { toast.success(`Dynadot: ${r.data.domains_count} доменів`); qc.invalidateQueries({ queryKey: ['dyn-all'] }) },
    onError: (e) => toast.error('Dynadot: ' + (e.response?.data?.detail || 'помилка')),
  })
  const teamName = (id) => teams.find(t => t.id === id)?.name || `#${id}`
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter(a => !q || a.name.toLowerCase().includes(q))
  }, [accounts, search])

  if (isLoading) return <Spinner />
  if (!filtered.length) return <Empty label="Немає Dynadot акаунтів" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {filtered.map(a => (
        <AccountRow key={a.id}
          color="#2e9cee" icon={Globe}
          title={a.name}
          subtitle={[
            a.last_error
              ? a.last_error
              : (a.domains_count != null ? `${a.domains_count} доменів` : 'ще не синхронізовано'),
            a.created_by_username && `by ${a.created_by_username}`,
          ].filter(Boolean).join(' · ')}
          subtitleColor={a.last_error ? 'var(--red)' : undefined}
          team={teamName(a.team_id)}
          active={a.is_active}
          onSync={() => syncMut.mutate(a.id)}
          onEdit={() => onEdit(a)}
          onDelete={() => gateDelete(() => delMut.mutateAsync(a.id)).catch(() => {})}
        />
      ))}
    </div>
  )
}

// ── Shared row ───────────────────────────────────────────────────────────

function AccountRow({ color, icon: Icon, title, subtitle, subtitleColor, team, active, extra, onClick, onSync, onEdit, onDelete }) {
  return (
    <div onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '12px 14px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => onClick && (e.currentTarget.style.borderColor = color)}
      onMouseLeave={e => onClick && (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 8,
        background: `color-mix(in srgb, ${color} 18%, transparent)`, color,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11, color: subtitleColor || 'var(--text3)', fontFamily: 'var(--mono)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>
      <Badge color="blue">{team}</Badge>
      <Badge color={active ? 'green' : 'red'}>
        {active ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
        {active ? ' OK' : ' Off'}
      </Badge>
      {extra}
      <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
        <Btn size="sm" variant="ghost" onClick={onSync} title="Синхронізувати"><RefreshCw size={12} /></Btn>
        <Btn size="sm" variant="ghost" onClick={onEdit} title="Редагувати"><Pencil size={12} /></Btn>
        <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={12} /></Btn>
      </div>
      {onClick && <ChevronRight size={14} color="var(--text3)" />}
    </div>
  )
}

function Empty({ label }) {
  return (
    <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)', fontSize: 13 }}>
      {label}
    </div>
  )
}

// ── Add / Edit modal ─────────────────────────────────────────────────────

function AddAccountModal({ open, onClose, teams, kind, onSaved }) {
  const [form, setForm] = useState({ team_id: '', name: '', api_key: '', email: '' })
  const [loading, setLoading] = useState(false)

  function reset() { setForm({ team_id: '', name: '', api_key: '', email: '' }) }
  function handleClose() { reset(); onClose() }

  async function submit() {
    if (!form.team_id) return toast.error('Оберіть команду')
    if (!form.name.trim() || !form.api_key.trim()) return toast.error('Назва і API key обовʼязкові')
    setLoading(true)
    try {
      if (kind === 'cf') {
        await createCFAccount(form.team_id, {
          name: form.name.trim(), api_key: form.api_key.trim(), email: form.email.trim() || null,
        })
      } else {
        await createDynadotAccount(form.team_id, {
          name: form.name.trim(), api_key: form.api_key.trim(),
        })
      }
      toast.success('Додано')
      onSaved(); handleClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  const isCF = kind === 'cf'
  return (
    <Modal open={open} onClose={handleClose} title={`Новий ${isCF ? 'Cloudflare' : 'Dynadot'} акаунт`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Команда">
          <select value={form.team_id} onChange={e => setForm(f => ({ ...f, team_id: e.target.value }))}>
            <option value="">— Оберіть команду —</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Назва акаунту">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={isCF ? 'CF Team Alpha' : 'Dynadot main'} />
        </Field>
        {isCF && (
          <Field label="Email">
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="cf@example.com" />
          </Field>
        )}
        <Field label={isCF ? 'CF Global API Key' : 'Dynadot API Key'}>
          <input autoComplete="off" data-1p-ignore data-lpignore="true"
            style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            value={form.api_key} onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
            placeholder="API Key" />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} onClick={submit}><Plus size={13} /> Додати</Btn>
        </div>
      </div>
    </Modal>
  )
}

function EditAccountModal({ open, onClose, teams, kind, account, onSaved }) {
  const [form, setForm] = useState({ name: '', api_key: '', email: '' })
  const [loading, setLoading] = useState(false)
  const isCF = kind === 'cf'

  useEffect(() => {
    if (open && account) {
      setForm({ name: account.name || '', api_key: '', email: account.email || '' })
    }
  }, [open, account?.id])

  function handleClose() { setForm({ name: '', api_key: '', email: '' }); onClose() }

  async function submit() {
    setLoading(true)
    try {
      const payload = {}
      if (form.name !== account.name) payload.name = form.name
      if (isCF && form.email !== (account.email || '')) payload.email = form.email
      if (form.api_key.trim()) payload.api_key = form.api_key.trim()
      if (isCF) await updateCFAccount(account.team_id, account.id, payload)
      else await updateDynadotAccount(account.id, payload)
      toast.success('Збережено')
      onSaved(); handleClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  if (!account) return null
  const teamName = teams.find(t => t.id === account.team_id)?.name || `#${account.team_id}`

  return (
    <Modal open={open} onClose={handleClose} title={`Редагувати: ${account.name}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Команда">
          <input value={teamName} disabled />
        </Field>
        <Field label="Назва">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </Field>
        {isCF && (
          <Field label="Email">
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          </Field>
        )}
        <Field label="Новий API Key (порожньо — не міняти)">
          <input autoComplete="off" data-1p-ignore data-lpignore="true"
            style={{ fontFamily: form.api_key ? 'var(--mono)' : undefined, fontSize: 12 }}
            value={form.api_key} onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.name} onClick={submit}>Зберегти</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── CF detail panel (drawer-style modal) ─────────────────────────────────

function CFDetailPanel({ accountId, onClose, onChanged }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [tab, setTab] = useState('overview')
  const [expandedDomain, setExpandedDomain] = useState(null)

  const open = !!accountId
  const { data: detail, isLoading, refetch } = useQuery({
    queryKey: ['cf-detail', accountId],
    queryFn: () => getCFAccountDetail(accountId).then(r => r.data),
    enabled: open,
    staleTime: 30000,
  })
  const { data: domains = [], isLoading: domLoading, refetch: refetchDomains } = useQuery({
    queryKey: ['cf-domains', accountId],
    queryFn: () => getDomains({ cf_account_id: accountId }).then(r => r.data),
    enabled: open,
    staleTime: 30000,
  })

  const cleanupMut = useMutation({
    mutationFn: ({ mode, dry_run }) => cfAccountCleanup(accountId, { mode, dry_run }).then(r => r.data),
  })

  const syncMut = useMutation({
    mutationFn: () => syncCFAccount(accountId),
    onSuccess: (r) => {
      const s = r.data.stats || {}
      toast.success(`Синхронізовано: +${s.created || 0} нових, ${s.updated || 0} оновлено`)
      refetch(); refetchDomains(); onChanged?.()
    },
    onError: (e) => toast.error('Sync error: ' + (e.response?.data?.detail || e.message)),
  })

  const delDomainMut = useMutation({
    mutationFn: (id) => deleteDomainFromCF(id),
    onSuccess: () => { toast.success('Домен видалено з CF'); refetchDomains(); refetch(); onChanged?.() },
    onError: () => toast.error('Помилка видалення'),
  })

  async function runCleanup(mode) {
    const preview = await cleanupMut.mutateAsync({ mode, dry_run: true })
    if (!preview.count) { toast('Немає що чистити'); return }
    const ok = window.confirm(
      `Знайдено ${preview.count} доменів до видалення (режим: ${mode}).\n\n` +
      preview.candidates.slice(0, 15).map(c => '• ' + c.name).join('\n') +
      (preview.candidates.length > 15 ? `\n…і ще ${preview.candidates.length - 15}` : '') +
      `\n\nВидалити з Cloudflare?`
    )
    if (!ok) return
    const r = await cleanupMut.mutateAsync({ mode, dry_run: false })
    toast.success(`Видалено: ${r.results.filter(x => x.ok).length} / ${r.count}`)
    refetch(); refetchDomains(); onChanged?.()
  }

  if (!open) return null

  return (
    <Modal open={open} onClose={onClose}
      title={detail ? `Cloudflare: ${detail.account.name}` : 'Завантаження…'}
      width={920}>
      {isLoading || !detail ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DetailHeader detail={detail} onRefresh={refetch}
            onSync={() => syncMut.mutate()} syncing={syncMut.isPending} />

          <TabBar tab={tab} setTab={setTab} counts={{
            overview: null,
            domains: domains.length,
            abuse: detail.abuse_reports.length,
            logs: detail.logs.length,
            cleanup: null,
          }} />

          <div style={{ maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tab === 'overview' && <OverviewTab detail={detail} onSync={() => syncMut.mutate()} syncing={syncMut.isPending} />}
            {tab === 'domains' && (
              <DomainsTab domains={domains} loading={domLoading}
                expanded={expandedDomain} setExpanded={setExpandedDomain}
                onSync={() => syncMut.mutate()} syncing={syncMut.isPending}
                onDelete={(id) => gateDelete(() => delDomainMut.mutateAsync(id)).catch(() => {})} />
            )}
            {tab === 'abuse' && <AbuseTab reports={detail.abuse_reports} />}
            {tab === 'logs' && <LogsTab logs={detail.logs} />}
            {tab === 'cleanup' && (
              <CleanupTab onRun={runCleanup} stats={detail.stats}
                abuseCount={detail.abuse_reports.length}
                loading={cleanupMut.isPending} />
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function DetailHeader({ detail, onRefresh, onSync, syncing }) {
  const a = detail.account
  const s = detail.stats
  const healthy = s.total ? Math.round((s.active / s.total) * 100) : 0
  return (
    <div style={{
      background: 'linear-gradient(120deg, rgba(244,129,32,0.10), rgba(244,129,32,0.02))',
      border: '1px solid rgba(244,129,32,0.20)', borderRadius: 10,
      padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: 'rgba(244,129,32,0.20)', color: '#f48120',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <AnimatedIcon icon={Cloud} size={20} anim="glow" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{a.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
          {a.email || '—'} · {a.account_id ? a.account_id.slice(0, 14) : 'no acc_id'} · team: {a.team.name || '—'}
          {a.created_by ? ` · додав: ${a.created_by}` : ''}
        </div>
      </div>
      <MiniCount label="Total" value={s.total} />
      <MiniCount label="Active" value={s.active} color="var(--green)" />
      <MiniCount label="Suspended" value={s.suspended} color="var(--red)" />
      <MiniCount label="Pending" value={s.pending} color="var(--yellow)" />
      <div style={{ width: 1, height: 36, background: 'var(--border)' }} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>Healthy</div>
        <div style={{ fontSize: 18, fontWeight: 800,
          color: healthy >= 90 ? 'var(--green)' : healthy >= 70 ? 'var(--yellow)' : 'var(--red)' }}>
          {s.total ? `${healthy}%` : '—'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Btn size="sm" loading={syncing} onClick={onSync} title="Підтягнути зони з Cloudflare">
          <RefreshCw size={12} /> Sync
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onRefresh} title="Оновити панель">
          <RefreshCw size={12} />
        </Btn>
      </div>
    </div>
  )
}

function MiniCount({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 50 }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || 'var(--text)' }}>{value}</div>
    </div>
  )
}

function TabBar({ tab, setTab, counts }) {
  const tabs = [
    { k: 'overview', label: 'Огляд',    icon: Sparkles },
    { k: 'domains',  label: 'Домени',   icon: Globe },
    { k: 'abuse',    label: 'Абузи',    icon: ShieldOff },
    { k: 'logs',     label: 'Логи',     icon: ScrollText },
    { k: 'cleanup',  label: 'Очистка',  icon: Trash2 },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
      {tabs.map(t => {
        const active = tab === t.k
        const c = counts[t.k]
        const Icon = t.icon
        return (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', background: 'none', border: 'none',
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              color: active ? 'var(--text)' : 'var(--text3)',
              cursor: 'pointer', fontSize: 12, fontWeight: 700,
            }}>
            <Icon size={13} /> {t.label}
            {c != null && c > 0 && (
              <span style={{
                background: active ? 'var(--accent)' : 'var(--bg3)',
                color: active ? '#fff' : 'var(--text3)',
                fontSize: 10, padding: '0 6px', borderRadius: 8, fontFamily: 'var(--mono)',
              }}>{c}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Overview tab ─────────────────────────────────────────────────────────

function OverviewTab({ detail, onSync, syncing }) {
  const a = detail.account
  const lastSync = a.last_synced_at ? new Date(a.last_synced_at).toLocaleString('uk-UA') : 'ніколи'
  const created = a.created_at ? new Date(a.created_at).toLocaleString('uk-UA') : '—'
  const topActions = detail.logs.slice(0, 5)
  const neverSynced = !a.last_synced_at
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {neverSynced && (
        <div style={{
          background: 'rgba(244,129,32,0.10)', border: '1px solid rgba(244,129,32,0.30)',
          borderRadius: 10, padding: '12px 14px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <AnimatedIcon icon={AlertCircle} size={18} color="#f48120" anim="pulse" />
          <div style={{ flex: 1, fontSize: 12 }}>
            Цей акаунт ще не синхронізовано. Запусти sync — підтягнемо всі зони з CF в БД.
          </div>
          <Btn loading={syncing} onClick={onSync}>
            <RefreshCw size={13} /> Синхронізувати
          </Btn>
        </div>
      )}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Card title="Інфо акаунту" icon={Cloud}>
        <InfoRow label="Email" value={a.email || '—'} mono />
        <InfoRow label="Account ID" value={a.account_id || '—'} mono />
        <InfoRow label="Команда" value={a.team.name || '—'} />
        <InfoRow label="Статус" value={
          <Badge color={a.is_active ? 'green' : 'red'}>{a.is_active ? 'Активний' : 'Неактивний'}</Badge>
        } />
        <InfoRow label="Створено" value={created} />
        <InfoRow label="Додав" value={a.created_by || '—'} />
        <InfoRow label="Last sync" value={lastSync} />
      </Card>
      <Card title="Останні дії" icon={ScrollText}>
        {topActions.length === 0
          ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>Логів ще немає</div>
          : topActions.map(l => <LogRow key={l.id} log={l} compact />)}
      </Card>
    </div>
    </div>
  )
}

function Card({ title, icon: Icon, children }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Icon size={13} /> {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: mono ? 'var(--mono)' : undefined, textAlign: 'right',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
        {value}
      </span>
    </div>
  )
}

// ── Domains tab ──────────────────────────────────────────────────────────

function DomainsTab({ domains, loading, expanded, setExpanded, onDelete, onSync, syncing }) {
  const [filter, setFilter] = useState('')
  if (loading) return <Spinner />
  const filtered = domains.filter(d => !filter.trim() || d.name.toLowerCase().includes(filter.toLowerCase()))
  if (!domains.length) return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 14, padding: 40, textAlign: 'center',
    }}>
      <AnimatedIcon icon={Globe} size={32} color="var(--text3)" anim="pulse" />
      <div style={{ fontSize: 13, color: 'var(--text2)' }}>Домени ще не підтягнуті</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', maxWidth: 360 }}>
        Натисни «Синхронізувати» — підтягнемо зони з Cloudflare API в БД та покажемо їх тут.
      </div>
      <Btn loading={syncing} onClick={onSync}>
        <RefreshCw size={14} /> Синхронізувати з Cloudflare
      </Btn>
    </div>
  )

  return (
    <>
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Фільтр за іменем…"
        style={{ width: '100%' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map(d => (
          <DomainRow key={d.id} domain={d}
            expanded={expanded === d.id}
            onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
            onDelete={() => onDelete(d.id)} />
        ))}
      </div>
    </>
  )
}

function DomainRow({ domain, expanded, onToggle, onDelete }) {
  const statusColor = {
    active: 'green', suspended: 'red', pending: 'yellow', unknown: 'default',
  }[domain.zone_status] || 'default'

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
      overflow: 'hidden',
    }}>
      <div onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
          cursor: 'pointer',
        }}>
        <ChevronRight size={12} style={{
          color: 'var(--text3)',
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
        }} />
        <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600 }}>{domain.name}</span>
        <Badge color={statusColor}>{domain.zone_status}</Badge>
        {domain.main_record_type && (
          <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {domain.main_record_type}: {(domain.main_record_value || '').slice(0, 30)}
          </span>
        )}
        {domain.registered_at && (
          <span title={`Додано в CF: ${new Date(domain.registered_at).toLocaleString('uk-UA')}`}
            style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
            {new Date(domain.registered_at).toLocaleDateString('uk-UA')}
          </span>
        )}
        <div onClick={e => e.stopPropagation()}>
          <Btn size="sm" variant="danger" onClick={onDelete} title="Видалити з CF + БД">
            <Trash2 size={11} />
          </Btn>
        </div>
      </div>
      {expanded && <DnsRecords domainId={domain.id} />}
    </div>
  )
}

function DnsRecords({ domainId }) {
  const { data: records = [], isLoading } = useQuery({
    queryKey: ['dns', domainId],
    queryFn: () => getDnsRecords(domainId).then(r => r.data),
    staleTime: 60000,
  })
  if (isLoading) return <div style={{ padding: 14 }}><Spinner /></div>
  if (!records.length) return (
    <div style={{ padding: 14, fontSize: 11, color: 'var(--text3)' }}>Немає DNS записів</div>
  )
  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg3)', padding: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' }}>
        <thead>
          <tr style={{ color: 'var(--text3)' }}>
            {['Type', 'Name', 'Value', 'TTL', 'Proxied'].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map(r => (
            <tr key={r.id || r.cf_record_id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '4px 8px', color: 'var(--accent)', fontWeight: 700 }}>{r.record_type}</td>
              <td style={{ padding: '4px 8px' }}>{r.name}</td>
              <td style={{ padding: '4px 8px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.value}
              </td>
              <td style={{ padding: '4px 8px', color: 'var(--text3)' }}>{r.ttl === 1 ? 'auto' : r.ttl}</td>
              <td style={{ padding: '4px 8px' }}>
                {r.proxied ? <Badge color="green">on</Badge> : <span style={{ color: 'var(--text3)' }}>off</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Abuse tab ────────────────────────────────────────────────────────────

function AbuseTab({ reports }) {
  if (!reports.length) return <EmptyState text="Активних abuse-репортів немає" icon={CheckCircle2} color="var(--green)" />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {reports.map((r, i) => (
        <div key={r.id || i} style={{
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: 8, padding: '10px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--red)' }}>
              {r.domain}
            </span>
            {r.type && <Badge color="red">{r.type}</Badge>}
            {r.status && <Badge color="default">{r.status}</Badge>}
          </div>
          {r.created_at && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
              {new Date(r.created_at).toLocaleString('uk-UA')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Logs tab ─────────────────────────────────────────────────────────────

function LogsTab({ logs }) {
  if (!logs.length) return <EmptyState text="Логів ще немає" icon={ScrollText} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {logs.map(l => <LogRow key={l.id} log={l} />)}
    </div>
  )
}

const ACTION_META = {
  full_delete_cf:  { color: 'var(--red)',    label: 'Видалення зони',     icon: Trash2 },
  cf_add_zone:     { color: 'var(--green)',  label: 'Додано зону',        icon: Plus },
  dns_create:      { color: 'var(--accent)', label: 'Створено DNS',       icon: FileText },
  dns_update:      { color: 'var(--accent)', label: 'Зміна DNS',          icon: Pencil },
  dns_delete:      { color: 'var(--red)',    label: 'Видалено DNS',       icon: Trash2 },
  bulk_swap:       { color: 'var(--accent)', label: 'Заміна записів',     icon: RefreshCw },
  ssl_mode:        { color: 'var(--yellow)', label: 'Зміна SSL',          icon: AlertCircle },
}

function LogRow({ log, compact }) {
  const m = ACTION_META[log.action] || { color: 'var(--text3)', label: log.action, icon: ScrollText }
  const Icon = m.icon
  const dateStr = log.created_at
    ? new Date(log.created_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--bg3)', borderRadius: 7, padding: '6px 10px', fontSize: 12,
    }}>
      <Icon size={12} color={m.color} />
      <span style={{ color: m.color, fontWeight: 700, minWidth: compact ? 'auto' : 110 }}>
        {m.label}
      </span>
      <span style={{ flex: 1, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {log.domain || '—'}
      </span>
      {!compact && log.details && (
        <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)',
          maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={log.details}>
          {log.details}
        </span>
      )}
      <span style={{ fontSize: 10, color: 'var(--text3)' }}>{dateStr}</span>
    </div>
  )
}

// ── Cleanup tab ──────────────────────────────────────────────────────────

function CleanupTab({ onRun, stats, abuseCount, loading }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <AnimatedIcon icon={AlertCircle} size={18} color="var(--yellow)" anim="pulse" />
        <div style={{ flex: 1, fontSize: 12 }}>
          Очистка <strong>видаляє домени з Cloudflare і з БД</strong> (з логуванням).
          Перед видаленням показується preview-список — операція безповоротна.
        </div>
      </div>

      <CleanupOption
        title="Тільки suspended" icon={ShieldOff} color="var(--red)"
        desc="Видаляє всі домени з цього CF акаунту зі статусом suspended."
        badge={stats.suspended}
        disabled={loading || stats.suspended === 0}
        onClick={() => onRun('suspended')}
      />
      <CleanupOption
        title="З CF abuse-репортами" icon={AlertTriangle} color="var(--red)"
        desc="Видаляє домени, які зараз у відкритому abuse-репорті на Cloudflare."
        badge={abuseCount}
        disabled={loading || abuseCount === 0}
        onClick={() => onRun('cf_abuse')}
      />
      <CleanupOption
        title="Suspended + Abuse" icon={Layers} color="var(--red)"
        desc="Обидва критерії одночасно. Найбільш агресивний варіант."
        badge={Math.max(stats.suspended, abuseCount)}
        disabled={loading || (stats.suspended === 0 && abuseCount === 0)}
        onClick={() => onRun('both')}
      />
    </div>
  )
}

function CleanupOption({ title, icon: Icon, color, desc, badge, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '14px 16px', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        textAlign: 'left', color: 'var(--text)',
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.borderColor = color; e.currentTarget.style.transform = 'translateY(-1px)' } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: `color-mix(in srgb, ${color} 18%, transparent)`, color,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{desc}</div>
      </div>
      <Badge color={badge > 0 ? 'red' : 'default'}>{badge} доменів</Badge>
    </button>
  )
}

function EmptyState({ text, icon: Icon, color = 'var(--text3)' }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 10, padding: 32, color: 'var(--text3)', fontSize: 12,
    }}>
      <AnimatedIcon icon={Icon} size={26} color={color} anim="pulse" />
      {text}
    </div>
  )
}
