import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, AlertTriangle, CheckCircle, Clock, RefreshCw, Copy, Trash2, Cloud, ShieldOff, Info, FileText, Sparkles } from 'lucide-react'
import {
  getTeams, getCFAccounts, getKTInstances, getKTGroupsByInstance,
  quickAddDomains, getAbuseAlerts, syncKTGroups, getCFAbuseReports, bulkAbuseDelete, getDeletedDomains,
} from '../api/client'
import { Btn, Badge, Spinner, Field, Modal } from '../components/ui/index'
import { useAuthStore } from '../store/auth'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function DashboardPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, height: '100%', overflow: 'auto' }}>
      <div>
        <h1 style={{ fontWeight: 800, fontSize: 22 }}>Головна</h1>
        <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>Швидке додавання доменів та моніторинг</p>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {isAdmin
          ? <QuickAddCard />
          : <div style={{ flex: 2, minWidth: 320, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, color: 'var(--text3)', fontSize: 13 }}>
              Додавання доменів доступне тільки адміністраторам.
            </div>
        }
        <AbuseWidget />
      </div>

      {isAdmin && (
        <AutoDeletedCard />
      )}
    </div>
  )
}

// ── Quick Add Card ────────────────────────────────────────────────────────
function QuickAddCard() {
  const qc = useQueryClient()
  const [teamId, setTeamId] = useState('')
  const [cfAccountId, setCfAccountId] = useState('')
  const [ktInstanceId, setKtInstanceId] = useState('')
  const [ktGroupId, setKtGroupId] = useState('')
  const [text, setText] = useState('')
  const [results, setResults] = useState(null)
  const [nsModal, setNsModal] = useState(null)
  const [syncingGroups, setSyncingGroups] = useState(false)

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
  })
  const { data: cfAccounts = [] } = useQuery({
    queryKey: ['cf-accounts', teamId],
    queryFn: () => getCFAccounts(teamId).then(r => r.data),
    enabled: !!teamId,
  })
  const { data: ktInstances = [] } = useQuery({
    queryKey: ['kt-inst', teamId],
    queryFn: () => getKTInstances(teamId).then(r => r.data),
    enabled: !!teamId,
  })
  const { data: ktGroups = [], isLoading: ktGroupsLoading } = useQuery({
    queryKey: ['kt-grp', ktInstanceId],
    queryFn: () => getKTGroupsByInstance(ktInstanceId).then(r => r.data),
    enabled: !!ktInstanceId,
    staleTime: 300000,
  })

  // Auto-select lowest-ID (primary) CF account when team changes
  function handleTeamChange(id) {
    setTeamId(id)
    setCfAccountId('')
    setKtInstanceId('')
    setKtGroupId('')
    setResults(null)
  }

  // After CF accounts load, auto-select the first one
  useMemo(() => {
    if (cfAccounts.length > 0 && !cfAccountId) {
      const primary = [...cfAccounts].sort((a, b) => a.id - b.id)[0]
      setCfAccountId(String(primary.id))
    }
  }, [cfAccounts])

  const selectedInst = ktInstances.find(i => i.id === parseInt(ktInstanceId))

  const addMut = useMutation({
    mutationFn: (payload) => quickAddDomains(payload).then(r => r.data),
    onSuccess: (data) => {
      setResults(data.results)
      const added = data.results.filter(r => r.cf_status === 'added').length
      const errors = data.results.filter(r => r.cf_status === 'error').length
      if (added > 0) toast.success(`Додано ${added} доменів`)
      if (errors > 0) toast.error(`${errors} помилок`)
      qc.invalidateQueries(['kt-domains-live'])
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Помилка'),
  })

  const domainLines = text.split('\n').map(s => s.trim()).filter(Boolean)

  function submit() {
    if (!cfAccountId || domainLines.length === 0) return
    addMut.mutate({
      domains: domainLines,
      cf_account_id: parseInt(cfAccountId),
      kt_instance_id: ktInstanceId ? parseInt(ktInstanceId) : null,
      kt_group_id: ktGroupId ? parseInt(ktGroupId) : null,
    })
  }

  // Collect all unique NS pairs from results for NS modal
  const allNs = useMemo(() => {
    if (!results) return []
    const added = results.filter(r => r.cf_status === 'added' && r.name_servers?.length)
    const nsMap = new Map()
    added.forEach(r => {
      const key = r.name_servers.join(',')
      if (!nsMap.has(key)) nsMap.set(key, { ns: r.name_servers, domains: [] })
      nsMap.get(key).domains.push(r.domain)
    })
    return [...nsMap.values()]
  }, [results])

  return (
    <div style={{ flex: 2, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Form card */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>
          <Plus size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Швидке додавання доменів
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Команда">
            <select value={teamId} onChange={e => handleTeamChange(e.target.value)}>
              <option value="">Оберіть команду...</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>

          <Field label="Cloudflare акаунт (основний)">
            <select value={cfAccountId} onChange={e => setCfAccountId(e.target.value)} disabled={!teamId}>
              <option value="">Оберіть акаунт...</option>
              {[...cfAccounts].sort((a, b) => a.id - b.id).map((a, i) => (
                <option key={a.id} value={a.id}>{a.name}{i === 0 ? ' ★' : ''}</option>
              ))}
            </select>
          </Field>

          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="KT інстанс (необов'язково)" style={{ flex: 1 }}>
              <select value={ktInstanceId} onChange={e => { setKtInstanceId(e.target.value); setKtGroupId('') }} disabled={!teamId}>
                <option value="">Без KT</option>
                {ktInstances.map(i => <option key={i.id} value={i.id}>{i.name}{i.cname ? ` → ${i.cname}` : ' — без CNAME'}</option>)}
              </select>
            </Field>
            <Field label={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Група KT (необов'язково)</span>
                {ktInstanceId && (
                  <Btn size="sm" variant="ghost" loading={syncingGroups} style={{ fontSize: 10, padding: '1px 6px' }}
                    onClick={async () => {
                      setSyncingGroups(true)
                      try {
                        await syncKTGroups(parseInt(ktInstanceId))
                        qc.invalidateQueries(['kt-grp', ktInstanceId])
                        toast.success('Групи синхронізовано')
                      } catch { toast.error('Помилка синхронізації') }
                      finally { setSyncingGroups(false) }
                    }}>
                    <RefreshCw size={10} /> Синхронізувати
                  </Btn>
                )}
              </div>
            } style={{ flex: 1 }}>
              {ktInstanceId && ktGroupsLoading ? (
                <div style={{ fontSize: 11, color: 'var(--text3)', padding: '7px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={11} /> Завантаження груп…</div>
              ) : ktInstanceId && ktGroups.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text3)', padding: '7px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={11} style={{ color: 'var(--yellow)' }} /> Немає груп — натисніть «Синхронізувати»
                </div>
              ) : (
                <select value={ktGroupId} onChange={e => setKtGroupId(e.target.value)} disabled={!ktInstanceId || ktGroupsLoading}>
                  <option value="">Без групи</option>
                  {ktGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
            </Field>
          </div>

          {selectedInst?.cname && (
            <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(79,110,247,0.25)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
              CNAME буде встановлено: <strong style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{selectedInst.cname}</strong>
            </div>
          )}
          {ktInstanceId && !selectedInst?.cname && (
            <div style={{ background: 'var(--yellow-dim)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--yellow)' }}>
              У цього KT інстансу не вказано CNAME — DNS не буде встановлено. Додай його в Налаштуваннях.
            </div>
          )}

          <Field label={`Домени (${domainLines.length}) — по одному на рядок`}>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={10}
              placeholder={'example.com\ndomain2.net\nmydomain.org'}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
            />
          </Field>

          {ktInstanceId && !ktGroupId && (
            <div style={{ fontSize: 11, color: 'var(--text3)', padding: '4px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Info size={11} /> Група не вибрана — домени додадуться в KT без групи
            </div>
          )}
          <Btn
            loading={addMut.isPending}
            disabled={!cfAccountId || domainLines.length === 0 || (!!ktInstanceId && ktGroupsLoading)}
            onClick={submit}
          >
            <Plus size={14} /> Додати {domainLines.length > 0 ? `(${domainLines.length})` : ''}
          </Btn>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              Результат: {results.filter(r => r.cf_status === 'added').length} додано /&nbsp;
              {results.filter(r => r.cf_status === 'exists').length} вже є /&nbsp;
              {results.filter(r => r.cf_status === 'error').length} помилок
            </span>
            {allNs.length > 0 && (
              <Btn size="sm" variant="ghost" onClick={() => setNsModal(allNs)}>
                NS-записи для реєстратора
              </Btn>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Домен', 'CF', 'CNAME', 'KT', 'NS сервери'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.domain} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.domain}</td>
                    <td style={{ padding: '6px 10px' }}>
                      {r.cf_status === 'added'  && <Badge color="green">Додано</Badge>}
                      {r.cf_status === 'exists' && <Badge color="default">Існує</Badge>}
                      {r.cf_status === 'error'  && <Badge color="red" title={r.cf_error}>Помилка</Badge>}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      {r.cname_set ? <Badge color="green">✓</Badge> : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      {r.kt_added
                        ? <Badge color="green">✓</Badge>
                        : r.kt_error
                          ? <span style={{ color: 'var(--red)', fontSize: 11 }} title={r.kt_error}>✗</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--accent)' }}>
                      {r.name_servers?.length > 0
                        ? r.name_servers.join(', ')
                        : <span style={{ color: 'var(--text3)' }}>—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* NS Modal */}
      <NSModal data={nsModal} onClose={() => setNsModal(null)} />
    </div>
  )
}

// ── NS Modal ──────────────────────────────────────────────────────────────
function NSModal({ data, onClose }) {
  if (!data) return null

  function copyAll(ns) {
    navigator.clipboard.writeText(ns.join('\n'))
    toast.success('NS скопійовано')
  }

  return (
    <Modal open={!!data} onClose={onClose} title="NS-записи для реєстратора" width={540}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
          Вкажіть ці NS-записи у реєстратора для кожного домену. Зазвичай всі домени одного CF акаунту мають однакові NS.
        </p>
        {data.map((group, i) => (
          <div key={i} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>
                {group.domains.length} домен{group.domains.length > 1 ? 'ів' : ''}
              </span>
              <Btn size="sm" variant="ghost" onClick={() => copyAll(group.ns)}>
                <Copy size={11} /> Копіювати NS
              </Btn>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {group.ns.map(ns => (
                <div key={ns} style={{
                  flex: 1, background: 'var(--bg2)', border: '1px solid var(--accent)',
                  borderRadius: 6, padding: '8px 12px', fontFamily: 'var(--mono)',
                  fontSize: 13, fontWeight: 700, color: 'var(--accent)', textAlign: 'center',
                }}>
                  {ns}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', maxHeight: 80, overflowY: 'auto' }}>
              {group.domains.join(', ')}
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

// ── Abuse Widget ──────────────────────────────────────────────────────────
function AbuseWidget() {
  const [tab, setTab] = useState('cf') // 'cf' | 'internal'

  const { data: alerts = [], isLoading: internalLoading, refetch: refetchInternal } = useQuery({
    queryKey: ['abuse-alerts'],
    queryFn: () => getAbuseAlerts(50).then(r => r.data),
    staleTime: 120000,
  })

  const { data: cfReports = [], isLoading: cfLoading, refetch: refetchCF } = useQuery({
    queryKey: ['cf-abuse-reports'],
    queryFn: () => getCFAbuseReports().then(r => r.data),
    staleTime: 300000,
  })

  const suspended = alerts.filter(a => a.new_status === 'suspended' && !a.resolved)

  const tabStyle = (active) => ({
    padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', border: 'none',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text3)',
  })

  return (
    <div style={{ flex: 1, minWidth: 280, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        <StatCard label="CF Абузи" value={cfReports.length} color="red" icon={<AlertTriangle size={16} />} />
        <StatCard label="Suspended" value={suspended.length} color="red" icon={<AlertTriangle size={16} />} />
      </div>

      {/* Panel */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg3)', borderRadius: 8, padding: 3 }}>
            <button style={tabStyle(tab === 'cf')} onClick={() => setTab('cf')}>
              <Cloud size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
              CF Абузи {cfReports.length > 0 && `(${cfReports.length})`}
            </button>
            <button style={tabStyle(tab === 'internal')} onClick={() => setTab('internal')}>
              <ShieldOff size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
              Suspended {alerts.length > 0 && `(${alerts.length})`}
            </button>
          </div>
          <Btn size="sm" variant="ghost" loading={tab === 'cf' ? cfLoading : internalLoading}
            onClick={() => tab === 'cf' ? refetchCF() : refetchInternal()}>
            <RefreshCw size={11} />
          </Btn>
        </div>

        {/* CF Abuse tab */}
        {tab === 'cf' && (
          cfLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            : cfReports.length === 0
              ? <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text3)', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}><Sparkles size={13} style={{ color: 'var(--green)' }} /> Абуз немає</div>
              : <>
                  <BulkAbuseDeleteBtn reports={cfReports} onDone={refetchCF} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                    {cfReports.map((r, i) => <CFAbuseRow key={r.id || i} report={r} onDeleted={refetchCF} />)}
                  </div>
                </>
        )}

        {/* Internal (suspended) tab */}
        {tab === 'internal' && (
          internalLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            : alerts.length === 0
              ? <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text3)', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}><Sparkles size={13} style={{ color: 'var(--green)' }} /> Змін статусу немає</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 460, overflowY: 'auto' }}>
                  {alerts.map(a => <AbuseRow key={a.id} alert={a} />)}
                </div>
        )}
      </div>
    </div>
  )
}

function BulkAbuseDeleteBtn({ reports, onDone }) {
  const [loading, setLoading] = useState(false)
  const domains = [...new Set(reports.map(r => r.domain))]

  async function deleteAll() {
    if (!window.confirm(`Видалити всі ${domains.length} доменів з CF?`)) return
    setLoading(true)
    try {
      const r = await bulkAbuseDelete(domains)
      const ok = r.data.results.filter(x => x.ok).length
      const fail = r.data.results.filter(x => !x.ok).length
      toast.success(`Видалено: ${ok}${fail ? ` · не знайдено в БД: ${fail}` : ''}`)
      onDone?.()
    } catch { toast.error('Помилка видалення') }
    finally { setLoading(false) }
  }

  return (
    <Btn variant="danger" size="sm" loading={loading} onClick={deleteAll}
      style={{ alignSelf: 'flex-start', marginBottom: 4 }}>
      <Trash2 size={12} /> Видалити всі ({domains.length})
    </Btn>
  )
}

function CFAbuseRow({ report, onDeleted }) {
  const [deleting, setDeleting] = useState(false)
  const statusColor = { open: 'red', closed: 'default', resolved: 'green', 'in-review': 'yellow' }
  const mit = report.mitigation

  async function handleDelete() {
    setDeleting(true)
    try {
      await bulkAbuseDelete([report.domain])
      toast.success(`${report.domain} видалено`)
      onDeleted?.()
    } catch (e) {
      const detail = e.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Помилка видалення')
    } finally { setDeleting(false) }
  }

  return (
    <div style={{
      background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
      borderRadius: 7, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {report.domain}
        </span>
        <Badge color={statusColor[report.status] || 'default'}>{report.status || '?'}</Badge>
        <Btn size="sm" variant="danger" loading={deleting} onClick={handleDelete} title="Видалити з CF">
          <Trash2 size={11} />
        </Btn>
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text3)', flexWrap: 'wrap' }}>
        {report.type && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={10} /> {report.type}</span>}
        {report.cf_account && <span>· {report.cf_account}</span>}
        {report.created_at && <span>· {new Date(report.created_at).toLocaleDateString('uk-UA')}</span>}
      </div>
      {mit && typeof mit === 'object' && (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
          active: {mit.active_count ?? 0} · pending: {mit.pending_count ?? 0} · review: {mit.in_review_count ?? 0}
        </div>
      )}
    </div>
  )
}

function AbuseRow({ alert }) {
  const isSuspended = alert.new_status === 'suspended'
  const isRecovered = alert.new_status === 'active'
  const date = new Date(alert.created_at)
  const dateStr = date.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      background: isSuspended
        ? 'rgba(239,68,68,0.06)'
        : isRecovered ? 'rgba(34,197,94,0.06)' : 'var(--bg3)',
      border: `1px solid ${isSuspended ? 'rgba(239,68,68,0.2)' : isRecovered ? 'rgba(34,197,94,0.2)' : 'var(--border)'}`,
      borderRadius: 7, padding: '8px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {alert.domain_name}
        </span>
        <Badge color={isSuspended ? 'red' : isRecovered ? 'green' : 'default'}>
          {alert.new_status === 'suspended' ? '403' : alert.new_status === 'active' ? '200' : alert.new_status}
        </Badge>
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text3)', flexWrap: 'wrap' }}>
        <span><Clock size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />{dateStr}</span>
        {alert.team_name && <span>· {alert.team_name}</span>}
        {alert.dns_deleted && <Badge color="red">🗑 DNS видалено</Badge>}
      </div>
    </div>
  )
}

function StatCard({ label, value, color, icon }) {
  const colors = {
    red: { bg: 'var(--red-dim)', border: 'rgba(239,68,68,0.25)', text: 'var(--red)' },
    green: { bg: 'var(--green-dim)', border: 'rgba(34,197,94,0.25)', text: 'var(--green)' },
  }
  const c = colors[color] || colors.red
  return (
    <div style={{
      flex: 1, background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: c.text, marginBottom: 4 }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: c.text }}>{value}</div>
    </div>
  )
}

// ── Auto-Deleted Domains Card ─────────────────────────────────────────────
function AutoDeletedCard() {
  const [filterTeam, setFilterTeam] = useState('')

  const { data: deleted = [], isLoading, refetch } = useQuery({
    queryKey: ['deleted-domains'],
    queryFn: () => getDeletedDomains(500).then(r => r.data),
    staleTime: 30000,
  })

  // Group by team
  const byTeam = deleted.reduce((acc, d) => {
    const t = d.team || '—'
    if (!acc[t]) acc[t] = []
    acc[t].push(d)
    return acc
  }, {})
  const teams = Object.keys(byTeam).sort()
  const displayed = filterTeam ? (byTeam[filterTeam] || []) : deleted

  return (
    <div style={{ flex: 2, minWidth: 300, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          🗑 Видалені домени ({deleted.length})
        </div>
        <Btn size="sm" variant="ghost" loading={isLoading} onClick={() => refetch()}><RefreshCw size={11} /></Btn>
      </div>

      {/* Team filter */}
      {teams.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            onClick={() => setFilterTeam('')}
            style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: !filterTeam ? 'var(--accent)' : 'var(--bg3)', color: !filterTeam ? '#fff' : 'var(--text3)' }}>
            Всі
          </button>
          {teams.map(t => (
            <button key={t}
              onClick={() => setFilterTeam(t === filterTeam ? '' : t)}
              style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: filterTeam === t ? 'var(--accent)' : 'var(--bg3)', color: filterTeam === t ? '#fff' : 'var(--text3)' }}>
              {t} ({byTeam[t].length})
            </button>
          ))}
        </div>
      )}

      {isLoading ? <Spinner /> : deleted.length === 0 ? (
        <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>Видалень ще не було</p>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg2)' }}>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Домен', 'Команда', 'CF Акаунт', 'Дата'].map(h => (
                  <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 10px', fontWeight: 600, color: 'var(--red)' }}>{d.domain}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text2)' }}>{d.team}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text3)', fontSize: 11 }}>{d.cf_account}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text3)', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {new Date(d.deleted_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
