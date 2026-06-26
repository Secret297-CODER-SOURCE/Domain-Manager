import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { RefreshCw, Zap, Plus, X, Cloud, BarChart2, Copy, Globe, AlertTriangle, Search, CheckCircle2, Clock, ShieldOff, Link2Off, ArrowRight } from 'lucide-react'
import {
  getDomains, getTeams, syncAll, bulkUpdateDns, getDnsRecords, createDnsRecord, deleteDnsRecord,
  getAllCFAccounts, addDomainsToCF, bulkDnsByName, getKTInstances_all, getKTGroupsByInstance, bulkAddToKT, syncKTGroups,
  deleteDomainFromCF, getTeamStats,
} from '../api/client'
import { Trash2 } from 'lucide-react'
import { Btn, Badge, Modal, Table, Spinner, Field } from '../components/ui/index'
import { useAuthStore } from '../store/auth'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const HTTP_CODE = { active: 200, suspended: 403, pending: 202, unknown: 0 }
const HTTP_COLOR = { 200: 'green', 403: 'red', 202: 'yellow', 0: 'default' }

// Derive a concrete, human-readable health state from the data we already have.
// Returns: { color, icon, label, hint } so the UI doesn't depend on raw zone_status alone.
function deriveDomainState(d) {
  const now = Date.now()
  const expiresMs = d.expires_at ? new Date(d.expires_at).getTime() : null
  const daysLeft = expiresMs ? Math.round((expiresMs - now) / 86400000) : null

  if (d.zone_status === 'suspended') {
    return { color: 'red', Icon: ShieldOff, label: 'Заблоковано', hint: 'CF деактивував зону (часто — abuse)' }
  }
  if (d.zone_status === 'pending') {
    return { color: 'yellow', Icon: Clock, label: 'Очікує NS', hint: 'NS ще не делеговано на Cloudflare' }
  }
  if (!d.name_servers) {
    return { color: 'yellow', Icon: AlertTriangle, label: 'Без NS', hint: 'Запустіть синхронізацію CF' }
  }
  if (!d.main_record_type) {
    return { color: 'yellow', Icon: Link2Off, label: 'Без DNS', hint: 'Кореневого запису не знайдено' }
  }
  if (daysLeft !== null && daysLeft <= 30 && daysLeft >= 0) {
    return { color: 'yellow', Icon: Clock, label: `Закінчується ${daysLeft}д`, hint: `expires ${new Date(d.expires_at).toLocaleDateString('uk-UA')}` }
  }
  if (daysLeft !== null && daysLeft < 0) {
    return { color: 'red', Icon: AlertTriangle, label: 'Прострочено', hint: 'Реєстрація доменного імені закінчилась' }
  }
  if (d.zone_status === 'active') {
    return { color: 'green', Icon: CheckCircle2, label: 'Активний', hint: 'Зона активна, DNS налаштовано' }
  }
  return { color: 'default', Icon: AlertTriangle, label: 'Невідомо', hint: 'Стан не визначено' }
}

export default function DomainsPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()

  const [filters, setFilters] = useState({ search: '', team_id: '', status: '', zone: '' })
  // Debounced version — drives the actual query so typing doesn't fire a
  // refetch per keystroke. Selects (team/status) bypass debounce via direct merge.
  const [debouncedFilters, setDebouncedFilters] = useState(filters)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 250)
    return () => clearTimeout(t)
  }, [filters])
  const [selected, setSelected] = useState([])

  const [bulkModal, setBulkModal] = useState(false)
  const [bulkByNameModal, setBulkByNameModal] = useState(null) // null | 'A' | 'CNAME'
  const [addToCFModal, setAddToCFModal] = useState(false)
  const [addToKTModal, setAddToKTModal] = useState(false)
  const [dnsModal, setDnsModal] = useState(null)
  const [addDnsModal, setAddDnsModal] = useState(null)
  const [nsModal, setNsModal] = useState(false)

  const { data: teams = [] } = useQuery({ queryKey: ['teams'], queryFn: () => getTeams().then(r => r.data) })

  const hasFilter = Object.values(filters).some(Boolean)

  const { data: domains = [], isLoading, isFetching } = useQuery({
    queryKey: ['domains', debouncedFilters],
    queryFn: () => getDomains({ ...debouncedFilters, page: 1, page_size: 10000 }).then(r => r.data),
    keepPreviousData: true,
    // Keep tabs consistent: always re-fetch when the tab regains focus
    // so two open tabs converge to the same backend state.
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
  })

  const { data: dnsRecords = [], isLoading: dnsLoading } = useQuery({
    queryKey: ['dns', dnsModal?.id],
    queryFn: () => getDnsRecords(dnsModal.id).then(r => r.data),
    enabled: !!dnsModal,
  })

  const syncMut = useMutation({
    mutationFn: syncAll,
    onSuccess: (r) => {
      toast.success(`Синхронізовано: +${r.data.stats.created} нових, оновлено ${r.data.stats.updated}`)
      qc.invalidateQueries(['domains'])
    },
    onError: () => toast.error('Помилка синхронізації'),
  })

  const bulkDnsMut = useMutation({
    mutationFn: bulkUpdateDns,
    onSuccess: (r) => {
      const ok = r.data.results.filter(x => x.status !== 'error').length
      toast.success(`Оновлено ${ok} доменів`)
      setBulkModal(false)
      setSelected([])
      qc.invalidateQueries(['domains'])
    },
  })

  const deleteDnsMut = useMutation({
    mutationFn: ({ domainId, recordId }) => deleteDnsRecord(domainId, recordId),
    onSuccess: () => { toast.success('Запис видалено'); qc.invalidateQueries(['dns', dnsModal?.id]) },
  })

  const deleteFromCFMut = useMutation({
    mutationFn: (id) => deleteDomainFromCF(id),
    onSuccess: (_, id) => {
      toast.success('Домен видалено з CF')
      qc.invalidateQueries(['domains'])
      qc.invalidateQueries(['team-stats'])
    },
    onError: () => toast.error('Помилка видалення'),
  })

  function setFilter(key, val) { setFilters(f => ({ ...f, [key]: val })); setShowAll(false) }

  const columns = [
    { key: 'name', label: 'Домен', render: v => <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 500 }}>{v}</span> },
    { key: 'team_name', label: 'Команда', render: v => <span style={{ color: 'var(--text2)' }}>{v}</span> },
    { key: 'cf_account_name', label: 'CF Акаунт', render: v => <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11 }}>{v}</span> },
    {
      key: 'name_servers', label: 'NS',
      render: (v, row) => v
        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {v.split(',').map(ns => (
              <span key={ns} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{ns}</span>
            ))}
          </div>
        : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
    },
    {
      key: 'main_record_type', label: 'DNS',
      render: (type, row) => type
        ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
            <Badge color="blue">{type}</Badge>{' '}
            <span style={{ color: 'var(--text2)' }}>{row.main_record_value}</span>
          </span>
        : <span style={{ color: 'var(--text3)' }}>—</span>
    },
    {
      key: 'zone_status', label: 'HTTP',
      render: v => {
        const code = HTTP_CODE[v] ?? 0
        return <Badge color={HTTP_COLOR[code]} dot>{code}</Badge>
      }
    },
    {
      key: '_state', label: 'Стан',
      render: (_, row) => {
        const s = deriveDomainState(row)
        return (
          <span title={s.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Badge color={s.color}>
              <s.Icon size={11} strokeWidth={2.4} />
              {s.label}
            </Badge>
          </span>
        )
      }
    },
    { key: 'expires_at', label: 'Закінчення', render: v => v ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{new Date(v).toLocaleDateString('uk-UA')}</span> : '—' },
    {
      key: 'added_by_username', label: 'Додав',
      render: v => v
        ? <Badge color="default">{v}</Badge>
        : <span style={{ color: 'var(--text3)', fontSize: 11 }}>sync</span>,
    },
    {
      key: 'id', label: '', render: (id, row) => (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          <Btn size="sm" variant="ghost" onClick={() => setDnsModal(row)}>DNS</Btn>
          {isAdmin && (
            <Btn size="sm" variant="danger"
              loading={deleteFromCFMut.isPending && deleteFromCFMut.variables === id}
              onClick={() => gateDelete(() => deleteFromCFMut.mutateAsync(id)).catch(() => {})}>
              <Trash2 size={11} />
            </Btn>
          )}
        </div>
      )
    },
  ]

  return (
    <div style={{ padding: 24, display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontWeight: 800, fontSize: 22 }}>Домени</h1>
            <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
              {isLoading ? 'Завантаження…' : `${domains.length.toLocaleString('uk-UA')} ${hasFilter ? 'за фільтром' : 'всього'}`}
              {isFetching && !isLoading && ' · оновлення…'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {selected.length > 0 && (
              <Btn variant="ghost" onClick={() => {
                const names = domains.filter(d => selected.includes(d.id)).map(d => d.name).join('\n')
                navigator.clipboard.writeText(names)
                toast.success(`Скопійовано ${selected.length} доменів`)
              }}>
                <Copy size={14} /> Копіювати ({selected.length})
              </Btn>
            )}
            {isAdmin && selected.length > 0 && (
              <Btn variant="success" onClick={() => setBulkModal(true)}>
                <Zap size={14} /> Змінити DNS ({selected.length})
              </Btn>
            )}
            {domains.some(d => d.name_servers) && (
              <Btn variant="ghost" onClick={() => setNsModal(true)}>
                <Globe size={14} /> NS записи
              </Btn>
            )}
            {isAdmin && (
              <Btn variant="ghost" loading={syncMut.isPending} onClick={() => syncMut.mutate()}>
                <RefreshCw size={14} /> Синхронізувати всі
              </Btn>
            )}
          </div>
        </div>

        {/* Filters */}
        <div style={{
          display: 'flex', gap: 10, flexWrap: 'wrap',
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 12,
        }}>
          <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
            <Search size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--text3)', pointerEvents: 'none'
            }} />
            <input
              placeholder="Пошук домену..."
              value={filters.search} onChange={e => setFilter('search', e.target.value)}
              style={{ paddingLeft: 30, width: '100%' }}
            />
          </div>
          <select value={filters.team_id} onChange={e => setFilter('team_id', e.target.value)} style={{ flex: '1 1 140px' }}>
            <option value="">Всі команди</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={filters.status} onChange={e => setFilter('status', e.target.value)} style={{ flex: '1 1 130px' }}>
            <option value="">Всі HTTP</option>
            <option value="active">200 — OK</option>
            <option value="pending">202 — Pending</option>
            <option value="suspended">403 — Suspended</option>
          </select>
          <input
            placeholder=".com / .net / зона"
            value={filters.zone} onChange={e => setFilter('zone', e.target.value)}
            style={{ flex: '0 1 130px' }}
          />
          {hasFilter && (
            <Btn size="sm" variant="ghost" onClick={() => setFilters({ search: '', team_id: '', status: '', zone: '' })}>
              <X size={13} /> Очистити
            </Btn>
          )}
        </div>

        {/* Table */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', flex: 1 }}>
          {isLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
            : domains.length === 0
              ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 64, gap: 12, color: 'var(--text3)' }}>
                  <Globe size={28} style={{ opacity: 0.4 }} />
                  <span style={{ fontSize: 13 }}>
                    {hasFilter ? 'Нічого не знайдено за фільтром' : 'Доменів ще немає'}
                  </span>
                </div>
              : <Table columns={columns} data={domains} selected={selected} onSelect={setSelected} />
          }
        </div>
      </div>

      {/* Right sidebar */}
      {isAdmin && (
        <div style={{ width: 244, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 52 }}>
          <ActionCard
            icon={<Cloud size={16} />} accent="var(--accent)"
            title="Додати домени"
            desc="Створення зони в Cloudflare + SSL Flexible. Опційно — одразу CNAME на Keitaro."
            actions={[
              { label: 'До Cloudflare', icon: <Cloud size={13} />, onClick: () => setAddToCFModal(true), variant: 'primary' },
              { label: 'До Keitaro', icon: <BarChart2 size={13} />, onClick: () => setAddToKTModal(true), variant: 'ghost' },
            ]}
          />

          <ActionCard
            icon={<Zap size={16} />} accent="var(--green)"
            title="Прив'язати A-запис"
            desc="Apex A → IP, proxied. Перевикористовує існуючу зону у CF."
            actions={[
              { label: 'Вставити список + IP', icon: <Zap size={13} />, onClick: () => setBulkByNameModal('A'), variant: 'success' },
            ]}
          />

          <ActionCard
            icon={<ArrowRight size={16} />} accent="var(--yellow)"
            title="Прив'язати CNAME"
            desc="Очищає DNS і ставить CNAME @ → target, proxied. Зручно для linktree / KT cname."
            actions={[
              { label: 'Вставити список + хост', icon: <ArrowRight size={13} />, onClick: () => setBulkByNameModal('CNAME'), variant: 'ghost' },
            ]}
          />

          {/* Team stats */}
          <TeamStatsPanel />
        </div>
      )}

      {/* NS Modal */}
      <NSModal open={nsModal} onClose={() => setNsModal(false)} domains={domains} selected={selected} />

      {/* Bulk DNS Modal (by selection) */}
      <BulkDnsModal
        open={bulkModal} onClose={() => setBulkModal(false)}
        count={selected.length}
        onConfirm={(type, value) => bulkDnsMut.mutate({ domain_ids: selected, record_type: type, value })}
        loading={bulkDnsMut.isPending}
      />

      {/* Bulk DNS by name (paste) */}
      <BulkDnsByNameModal
        open={!!bulkByNameModal} onClose={() => setBulkByNameModal(null)}
        defaultType={bulkByNameModal || 'A'}
        onSuccess={() => qc.invalidateQueries(['domains'])}
      />

      {/* Add to CF */}
      <AddToCFModal
        open={addToCFModal} onClose={() => setAddToCFModal(false)}
        onSuccess={() => qc.invalidateQueries(['domains'])}
      />

      {/* Add to KT */}
      <AddToKTModal
        open={addToKTModal} onClose={() => setAddToKTModal(false)}
        onSuccess={() => qc.invalidateQueries(['domains'])}
      />

      {/* DNS Records Modal */}
      <Modal open={!!dnsModal} onClose={() => setDnsModal(null)} title={`DNS: ${dnsModal?.name}`} width={640}>
        {dnsModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {isAdmin && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Btn size="sm" onClick={() => { setAddDnsModal(dnsModal); setDnsModal(null) }}>
                  <Plus size={13} /> Додати запис
                </Btn>
              </div>
            )}
            {dnsLoading ? <div style={{ textAlign: 'center', padding: 24 }}><Spinner /></div> : (
              <Table
                columns={[
                  { key: 'record_type', label: 'Тип', render: v => <Badge color="blue">{v}</Badge> },
                  { key: 'name', label: 'Ім\'я', render: v => <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{v}</span> },
                  { key: 'value', label: 'Значення', render: v => <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{v}</span> },
                  { key: 'ttl', label: 'TTL' },
                  ...(isAdmin ? [{ key: 'id', label: '', render: (_, row) => (
                    <Btn size="sm" variant="danger" onClick={() =>
                      gateDelete(() => deleteDnsMut.mutateAsync({ domainId: dnsModal.id, recordId: row.id })).catch(() => {})
                    }>
                      Видалити
                    </Btn>
                  )}] : []),
                ]}
                data={dnsRecords}
              />
            )}
          </div>
        )}
      </Modal>

      {/* Add DNS Record Modal */}
      <AddDnsModal
        open={!!addDnsModal} onClose={() => setAddDnsModal(null)}
        domain={addDnsModal}
        onSuccess={() => { qc.invalidateQueries(['dns']); setAddDnsModal(null); toast.success('Запис додано') }}
      />
    </div>
  )
}

function BulkDnsModal({ open, onClose, count, onConfirm, loading }) {
  const [type, setType] = useState('A')
  const [value, setValue] = useState('')

  return (
    <Modal open={open} onClose={onClose} title={`Масова зміна DNS (${count} доменів)`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Тип запису">
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="A">A — IP адреса</option>
            <option value="CNAME">CNAME — hostname</option>
          </select>
        </Field>
        <Field label={type === 'A' ? 'IP адреса' : 'Hostname'}>
          <input value={value} onChange={e => setValue(e.target.value)}
            placeholder={type === 'A' ? '1.2.3.4' : 'target.example.com'} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!value} onClick={() => onConfirm(type, value)}>
            <Zap size={13} /> Застосувати
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function BulkDnsByNameModal({ open, onClose, onSuccess, defaultType = 'A' }) {
  const [domainsText, setDomainsText] = useState('')
  const [type, setType] = useState(defaultType)
  const [value, setValue] = useState('')
  useEffect(() => { if (open) setType(defaultType) }, [open, defaultType])
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)

  async function submit() {
    setLoading(true)
    try {
      const domains = domainsText.split('\n').map(d => d.trim()).filter(Boolean)
      const r = await bulkDnsByName({ domains, record_type: type, value, proxied: true })
      setResults(r.data.results || [])
      onSuccess()
      if (r.data.warnings?.length) r.data.warnings.forEach(w => toast(w, { icon: <AlertTriangle size={16} style={{ color: 'var(--yellow)' }} /> }))
    } catch {
      toast.error('Помилка зміни DNS')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() { setResults(null); setDomainsText(''); setValue(''); onClose() }

  return (
    <Modal open={open} onClose={handleClose} title="Масова зміна DNS — список доменів" width={560}>
      {results ? (
        <ResultsList results={results.map(r => ({ domain: r.domain, status: r.status === 'ok' ? 'ok' : 'error', error: r.error }))} onClose={handleClose} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Домени (по одному на рядок)">
            <textarea value={domainsText} onChange={e => setDomainsText(e.target.value)}
              placeholder={'domain1.com\ndomain2.net\ndomain3.io'} rows={8}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <Field label="Тип запису">
            <select value={type} onChange={e => setType(e.target.value)}>
              <option value="A">A — IP адреса</option>
              <option value="CNAME">CNAME — hostname</option>
            </select>
          </Field>
          <Field label={type === 'A' ? 'IP адреса' : 'Hostname'}>
            <input value={value} onChange={e => setValue(e.target.value)}
              placeholder={type === 'A' ? '1.2.3.4' : 'target.example.com'} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={!domainsText.trim() || !value} onClick={submit}>
              <Zap size={13} /> Застосувати
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

function AddToCFModal({ open, onClose, onSuccess }) {
  const [cfAccountId, setCfAccountId] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)

  const { data: cfAccounts = [] } = useQuery({
    queryKey: ['cf-accounts-all'],
    queryFn: () => getAllCFAccounts().then(r => r.data),
    enabled: open,
  })

  async function submit() {
    setLoading(true)
    try {
      const domains = domainsText.split('\n').map(d => d.trim()).filter(Boolean)
      const r = await addDomainsToCF({ cf_account_id: parseInt(cfAccountId), domains })
      setResults(r.data.results)
      onSuccess()
    } catch {
      toast.error('Помилка додавання доменів до CF')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() { setResults(null); setDomainsText(''); setCfAccountId(''); onClose() }

  return (
    <Modal open={open} onClose={handleClose} title="Додати домени до Cloudflare" width={520}>
      {results ? (
        <ResultsList
          results={results.map(r => ({
            domain: r.domain,
            status: r.status === 'added' ? 'ok' : r.status === 'exists' ? 'warn' : 'error',
            label: r.status === 'added' ? 'Додано' : r.status === 'exists' ? 'Вже є' : 'Помилка',
            error: r.error,
          }))}
          onClose={handleClose}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="CF Акаунт">
            <select value={cfAccountId} onChange={e => setCfAccountId(e.target.value)}>
              <option value="">-- Виберіть акаунт --</option>
              {cfAccounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.email ? ` (${a.email})` : ''}</option>)}
            </select>
          </Field>
          <Field label="Домени (по одному на рядок)">
            <textarea value={domainsText} onChange={e => setDomainsText(e.target.value)}
              placeholder={'domain1.com\ndomain2.net\ndomain3.io'} rows={8}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={!cfAccountId || !domainsText.trim()} onClick={submit}>
              <Plus size={13} /> Додати
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

function AddToKTModal({ open, onClose, onSuccess }) {
  const qc = useQueryClient()
  const [instanceId, setInstanceId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState(null)

  // All KT instances (even without groups)
  const { data: instances = [] } = useQuery({
    queryKey: ['kt-instances-all'],
    queryFn: () => getKTInstances_all().then(r => r.data),
    enabled: open,
  })

  // Groups for selected instance only
  const { data: groups = [], isFetching: groupsLoading } = useQuery({
    queryKey: ['kt-groups-by-instance', instanceId],
    queryFn: () => getKTGroupsByInstance(instanceId).then(r => r.data),
    enabled: !!instanceId,
  })

  async function syncGroups() {
    setSyncing(true)
    try {
      await syncKTGroups(parseInt(instanceId))
      qc.invalidateQueries(['kt-groups-by-instance', instanceId])
      toast.success('Групи синхронізовано')
    } catch {
      toast.error('Помилка синхронізації груп')
    } finally { setSyncing(false) }
  }

  async function submit() {
    setLoading(true)
    try {
      const domains = domainsText.split('\n').map(d => d.trim()).filter(Boolean)
      const r = await bulkAddToKT({ domains, kt_instance_id: parseInt(instanceId), kt_group_id: parseInt(groupId) })
      setResults(r.data.results)
      onSuccess()
    } catch {
      toast.error('Помилка додавання доменів до Keitaro')
    } finally { setLoading(false) }
  }

  function handleClose() { setResults(null); setDomainsText(''); setInstanceId(''); setGroupId(''); onClose() }

  return (
    <Modal open={open} onClose={handleClose} title="Додати домени до Keitaro" width={520}>
      {results ? (
        <ResultsList
          results={results.map(r => ({ domain: r.domain, status: r.status === 'ok' ? 'ok' : 'error', error: r.detail }))}
          onClose={handleClose}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Keitaro інстанс">
            <select value={instanceId} onChange={e => { setInstanceId(e.target.value); setGroupId('') }}>
              <option value="">-- Виберіть інстанс --</option>
              {instances.map(i => <option key={i.id} value={i.id}>{i.name} ({i.team_name})</option>)}
            </select>
          </Field>

          {instanceId && (
            <Field label={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Група</span>
                <Btn size="sm" variant="ghost" loading={syncing} onClick={syncGroups} title="Синхронізувати групи з KT">
                  <RefreshCw size={11} /> Синхронізувати
                </Btn>
              </div>
            }>
              {groupsLoading ? (
                <div style={{ padding: '6px 0', color: 'var(--text3)', fontSize: 12 }}>Завантаження...</div>
              ) : groups.length === 0 ? (
                <div style={{ padding: '6px 0', color: 'var(--text3)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={12} style={{ color: 'var(--yellow)' }} />
                  Груп не знайдено — натисніть «Синхронізувати» щоб завантажити з KT
                </div>
              ) : (
                <select value={groupId} onChange={e => setGroupId(e.target.value)}>
                  <option value="">-- Виберіть групу --</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
            </Field>
          )}

          <Field label="Домени (по одному на рядок)">
            <textarea value={domainsText} onChange={e => setDomainsText(e.target.value)}
              placeholder={'domain1.com\ndomain2.net'} rows={8}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={!instanceId || !groupId || !domainsText.trim()} onClick={submit}>
              <Plus size={13} /> Додати
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ResultsList({ results, onClose }) {
  const colorMap = { ok: 'green', warn: 'yellow', error: 'red' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {results.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.domain}
            </span>
            <Badge color={colorMap[r.status] || 'default'}>{r.label || (r.status === 'ok' ? 'OK' : 'Помилка')}</Badge>
            {r.error && <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error}</span>}
          </div>
        ))}
      </div>
      <Btn onClick={onClose} style={{ alignSelf: 'flex-end' }}>Закрити</Btn>
    </div>
  )
}

function AddDnsModal({ open, onClose, domain, onSuccess }) {
  const [form, setForm] = useState({ record_type: 'A', name: '@', value: '', ttl: 1, proxied: false })
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    try {
      await createDnsRecord(domain.id, form)
      onSuccess()
      setForm({ record_type: 'A', name: '@', value: '', ttl: 1, proxied: false })
    } catch {
      toast.error('Помилка додавання запису')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Додати DNS запис: ${domain?.name}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Тип">
          <select value={form.record_type} onChange={e => setForm(f => ({ ...f, record_type: e.target.value }))}>
            {['A','CNAME','MX','TXT','AAAA'].map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Ім'я (@ для кореневого)">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="@ або subdomain" />
        </Field>
        <Field label="Значення">
          <input value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} placeholder="IP або hostname" />
        </Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="TTL">
            <input type="number" value={form.ttl} onChange={e => setForm(f => ({ ...f, ttl: +e.target.value }))} />
          </Field>
          <Field label="Proxied (CF)">
            <select value={form.proxied} onChange={e => setForm(f => ({ ...f, proxied: e.target.value === 'true' }))}>
              <option value="false">Ні</option>
              <option value="true">Так</option>
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.value} onClick={submit}><Plus size={13} /> Додати</Btn>
        </div>
      </div>
    </Modal>
  )
}

function TeamStatsPanel() {
  const { data: stats = [], isLoading, refetch } = useQuery({
    queryKey: ['team-stats'],
    queryFn: () => getTeamStats().then(r => r.data),
    staleTime: 120000,
  })

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)' }}>
          Статистика команд
        </span>
        <Btn size="sm" variant="ghost" loading={isLoading} onClick={() => refetch()}>
          <RefreshCw size={10} />
        </Btn>
      </div>
      {isLoading
        ? <Spinner />
        : stats.length === 0
          ? <p style={{ fontSize: 12, color: 'var(--text3)' }}>Немає даних</p>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {stats.map(t => (
                <div key={t.id} style={{ fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }} title={t.name}>{t.name}</span>
                    <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{t.total}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--bg3)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      background: t.suspended > 0 ? 'var(--red)' : 'var(--green)',
                      width: `${Math.min(100, (t.active / (t.total || 1)) * 100)}%`,
                      transition: 'width 0.3s',
                    }} />
                  </div>
                  {t.suspended > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--red)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <ShieldOff size={10} /> {t.suspended} suspended
                    </span>
                  )}
                </div>
              ))}
            </div>
      }
    </div>
  )
}

function ActionCard({ icon, accent, title, desc, actions }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: `color-mix(in srgb, ${accent} 18%, transparent)`,
          color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>{desc}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {actions.map((a, i) => (
          <Btn key={i} size="sm" variant={a.variant || 'ghost'} onClick={a.onClick}
            style={{ width: '100%', justifyContent: 'flex-start' }}>
            {a.icon} {a.label}
          </Btn>
        ))}
      </div>
    </div>
  )
}

function NSModal({ open, onClose, domains, selected }) {
  // Use selected domains if any, otherwise all domains with NS
  const source = selected.length > 0
    ? domains.filter(d => selected.includes(d.id) && d.name_servers)
    : domains.filter(d => d.name_servers)

  // Group by NS pair
  const byNS = source.reduce((acc, d) => {
    const key = d.name_servers
    if (!acc[key]) acc[key] = { ns: d.name_servers.split(','), domains: [] }
    acc[key].domains.push(d.name)
    return acc
  }, {})
  const groups = Object.values(byNS)

  return (
    <Modal open={open} onClose={onClose} title={`NS записи (${source.length} доменів)`} width={600}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.length === 0 && (
          <p style={{ color: 'var(--text3)', textAlign: 'center', padding: 24 }}>
            NS записи ще не збережені — запустіть синхронізацію CF акаунтів
          </p>
        )}
        {groups.map((g, i) => (
          <div key={i} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                {g.ns.map(ns => (
                  <div key={ns} style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: 'var(--accent)' }}>{ns}</div>
                ))}
              </div>
              <Btn size="sm" variant="ghost" onClick={() => {
                navigator.clipboard.writeText(g.ns.join('\n'))
                toast.success('NS скопійовано')
              }}>
                <Copy size={12} /> Копіювати NS
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => {
                navigator.clipboard.writeText(g.domains.join('\n'))
                toast.success(`${g.domains.length} доменів скопійовано`)
              }}>
                <Copy size={12} /> Домени ({g.domains.length})
              </Btn>
            </div>
            <div style={{ maxHeight: 150, overflowY: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', lineHeight: 1.8 }}>
              {g.domains.join(' · ')}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Закрити</Btn>
        </div>
      </div>
    </Modal>
  )
}
