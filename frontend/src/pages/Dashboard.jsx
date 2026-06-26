import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, AlertTriangle, CheckCircle, Clock, RefreshCw, Copy, Trash2, Cloud, ShieldOff,
  Info, FileText, Sparkles, BarChart3, TrendingDown, TrendingUp, Users, Globe,
  Activity, Flame, ShoppingBag, Layers, Calendar, Inbox, Network, Server,
  Wallet, CalendarClock, Award, Skull, LineChart,
} from 'lucide-react'
import {
  getTeams, getCFAccounts, getKTInstances, getKTGroupsByInstance,
  quickAddDomains, getAbuseAlerts, syncKTGroups, getCFAbuseReports, bulkAbuseDelete, getDeletedDomains,
  getStatsOverview, getBanReasons,
} from '../api/client'
import { Btn, Badge, Spinner, Field, Modal } from '../components/ui/index'
import AnimatedIcon from '../components/ui/AnimatedIcon'
import { useAuthStore } from '../store/auth'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function DashboardPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, height: '100%', overflow: 'auto' }}>
      <StatisticsSection />

      {/* Quick-add (left) + Abuse widget (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 20, alignItems: 'flex-start' }}>
        {isAdmin
          ? <QuickAddCard />
          : <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, color: 'var(--text3)', fontSize: 13 }}>
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
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Form card */}
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9,
            background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
            color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <AnimatedIcon icon={Plus} size={16} anim="pulse" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Швидке додавання доменів</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>CF зона → CNAME → KT — одним кліком</div>
          </div>
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
                <option key={a.id} value={a.id}>{a.name}{i === 0 ? ' (основний)' : ''}</option>
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
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        <StatCard label="CF Абузи" value={cfReports.length} color="red" icon={<AnimatedIcon icon={AlertTriangle} size={14} anim="flash" />} />
        <StatCard label="Suspended" value={suspended.length} color="red" icon={<AnimatedIcon icon={ShieldOff} size={14} anim="pulse" />} />
      </div>

      {/* Panel */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
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
        {alert.dns_deleted && (
          <Badge color="red">
            <AnimatedIcon icon={Trash2} size={10} anim="shake" /> DNS видалено
          </Badge>
        )}
      </div>
    </div>
  )
}

// ── Statistics Section ────────────────────────────────────────────────────

function StatisticsSection() {
  const [days, setDays] = useState(30)
  const { data: stats, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['stats-overview', days],
    queryFn: () => getStatsOverview(days).then(r => r.data),
    staleTime: 60000,
  })
  const { data: reasons } = useQuery({
    queryKey: ['ban-reasons'],
    queryFn: () => getBanReasons().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
            color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <AnimatedIcon icon={BarChart3} size={18} anim="glow" />
          </div>
          <div>
            <h1 style={{ fontWeight: 800, fontSize: 22, margin: 0, lineHeight: 1.1 }}>Огляд</h1>
            <div style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
              Бани, домени, команди та закупки — за вікно {days} днів
            </div>
          </div>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                border: 'none', cursor: 'pointer',
                background: d === days ? 'var(--accent)' : 'transparent',
                color: d === days ? '#fff' : 'var(--text3)',
                transition: 'all 0.15s',
              }}>{d}д</button>
          ))}
          <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
          <Btn size="sm" variant="ghost" loading={isFetching} onClick={() => refetch()}>
            <RefreshCw size={12} />
          </Btn>
        </div>
      </div>

      {isLoading || !stats ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : (
        <>
          {/* Hero stats row: donut + big numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2fr)', gap: 14 }}>
            <DomainStatusDonutCard totals={stats.totals} />
            <TopStatsGrid stats={stats} />
          </div>
          {/* Domains analytics */}
          <SectionTitle icon={Globe} label="Домени" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
            <BanTimelineCard timeline={stats.timeline} days={days} />
            <DomainGrowthCard growth={stats.domain_growth} />
            <BanReasonsCard reasons={reasons} />
            <TopSuspendedCard items={stats.top_suspended} />
            <CFAccountsCard accounts={stats.by_cf_account} />
            <TLDCard tlds={stats.by_tld} />
          </div>

          {/* Teams analytics */}
          <SectionTitle icon={Users} label="Команди" />
          <TeamLeaderboardCard teams={stats.by_team} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            {stats.by_team.map(t => <TeamDetailCard key={t.id} team={t} days={days} />)}
          </div>

          {/* Purchases analytics */}
          <SectionTitle icon={ShoppingBag} label="Закупки" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
            <PurchasesCard purchases={stats.purchases} />
            <SpendByMonthCard months={stats.purchases.spend_by_month} />
            <SpendBreakdownCard purchases={stats.purchases} />
          </div>

          {/* Infrastructure */}
          <SectionTitle icon={Network} label="Інфраструктура" />
          <InfraGrid infra={stats.infra} totals={stats.totals} />
        </>
      )}
    </div>
  )
}

function TopStatsGrid({ stats }) {
  const { totals, bans, deletions } = stats
  const items = [
    { label: 'Домени', value: totals.domains, icon: Globe,    color: 'blue',  anim: 'glow' },
    { label: 'Команди', value: totals.teams, sub: `CF: ${totals.cf_accounts} · Dyn: ${totals.dynadot_accounts}`, icon: Users, color: 'purple', anim: 'pulse' },
    { label: `Банів за ${stats.window_days}д`, value: bans.last_30d, sub: `24г: ${bans.last_24h} · 7д: ${bans.last_7d}`, icon: Flame, color: 'red', anim: 'shake' },
    { label: `Видалено за ${stats.window_days}д`, value: deletions.last_30d, sub: `24г: ${deletions.last_24h}`, icon: Trash2, color: 'orange', anim: 'bounce' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, alignContent: 'stretch' }}>
      {items.map((it, i) => <BigStatCard key={i} {...it} delay={i * 120} />)}
    </div>
  )
}

// ── Domain status donut chart ────────────────────────────────────────────

function DomainStatusDonutCard({ totals }) {
  const segments = [
    { label: 'Active',    value: totals.active,    color: 'var(--green)' },
    { label: 'Suspended', value: totals.suspended, color: 'var(--red)' },
    { label: 'Pending',   value: totals.pending,   color: 'var(--yellow)' },
  ]
  const sum = segments.reduce((s, x) => s + x.value, 0) || 1
  // SVG arc geometry
  const R = 60, CX = 80, CY = 80, STROKE = 18
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = segments.map(s => {
    const frac = s.value / sum
    const dash = frac * C
    const node = {
      ...s,
      pct: Math.round((s.value / (totals.domains || 1)) * 100),
      dasharray: `${dash} ${C - dash}`,
      dashoffset: -offset,
    }
    offset += dash
    return node
  })

  const healthy = totals.domains
    ? Math.round((totals.active / totals.domains) * 100)
    : 0
  const healthColor = healthy >= 90 ? 'var(--green)' : healthy >= 70 ? 'var(--yellow)' : 'var(--red)'

  return (
    <PanelCard title="Статус доменів" icon={Sparkles} anim="glow">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <svg width="160" height="160" viewBox="0 0 160 160" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--bg3)" strokeWidth={STROKE} />
            {totals.domains > 0 && arcs.map((a, i) => (
              <circle key={i}
                cx={CX} cy={CY} r={R} fill="none"
                stroke={a.color} strokeWidth={STROKE} strokeLinecap="butt"
                strokeDasharray={a.dasharray} strokeDashoffset={a.dashoffset}
                style={{ transition: 'stroke-dasharray 0.8s ease-out, stroke-dashoffset 0.8s ease-out' }}
              />
            ))}
          </svg>
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexDirection: 'column', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: healthColor, lineHeight: 1 }}>
              {totals.domains > 0 ? `${healthy}%` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
              healthy
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segments.map(s => {
            const pct = totals.domains ? Math.round((s.value / totals.domains) * 100) : 0
            return (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0,
                  boxShadow: `0 0 6px ${s.color}` }} />
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{s.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{pct}%</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: s.color, minWidth: 36, textAlign: 'right' }}>{s.value}</span>
              </div>
            )
          })}
          <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
            <span>Всього</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 700 }}>{totals.domains}</span>
          </div>
        </div>
      </div>
    </PanelCard>
  )
}

function BigStatCard({ label, value, sub, icon, color, anim, delay }) {
  const palette = {
    blue:   { bg: 'rgba(79,110,247,0.10)',  border: 'rgba(79,110,247,0.30)',  fg: 'var(--accent)' },
    green:  { bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)',   fg: 'var(--green)' },
    red:    { bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)',   fg: 'var(--red)' },
    orange: { bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)',  fg: 'var(--yellow)' },
    purple: { bg: 'rgba(168,85,247,0.10)',  border: 'rgba(168,85,247,0.25)',  fg: '#a855f7' },
  }
  const c = palette[color] || palette.blue
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.fg }}>
        <AnimatedIcon icon={icon} size={14} anim={anim} delay={delay} />
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: c.fg, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

function PanelCard({ title, icon: Icon, anim, children, action }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 220,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AnimatedIcon icon={Icon} size={14} color="var(--accent)" anim={anim || 'pulse'} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function BanTimelineCard({ timeline, days }) {
  // Fill in zero days so the chart shows a real timeline.
  const map = new Map(timeline.map(t => [t.date, t]))
  const filled = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const t = map.get(key) || { date: key, suspended: 0, recovered: 0, deleted: 0 }
    filled.push(t)
  }
  const max = Math.max(1, ...filled.map(t => Math.max(t.suspended, t.deleted)))
  const w = 100 / filled.length

  return (
    <PanelCard title={`Бани & видалення за ${days}д`} icon={Activity} anim="pulse">
      {filled.every(t => !t.suspended && !t.deleted) ? (
        <Empty text="Немає банів за цей період" icon={CheckCircle} color="var(--green)" />
      ) : (
        <>
          <svg viewBox="0 0 100 50" preserveAspectRatio="none" style={{ width: '100%', height: 120 }}>
            {filled.map((t, i) => {
              const h1 = (t.suspended / max) * 45
              const h2 = (t.deleted / max) * 45
              return (
                <g key={i}>
                  <rect x={i * w + w * 0.1} y={50 - h1} width={w * 0.4}
                    height={h1} fill="var(--red)" opacity="0.85">
                    <title>{t.date}: {t.suspended} банів</title>
                  </rect>
                  <rect x={i * w + w * 0.5} y={50 - h2} width={w * 0.4}
                    height={h2} fill="var(--yellow)" opacity="0.7">
                    <title>{t.date}: {t.deleted} видалено</title>
                  </rect>
                </g>
              )
            })}
          </svg>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text3)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--red)', borderRadius: 2 }} /> бани
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--yellow)', borderRadius: 2 }} /> видалено
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Calendar size={11} /> {filled[0].date} → {filled.at(-1).date}
            </span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

function BanReasonsCard({ reasons }) {
  return (
    <PanelCard title="Причини банів (CF abuse reports)" icon={Flame} anim="flash">
      {!reasons ? <Spinner /> : reasons.total === 0 ? (
        <Empty text="Жодного відкритого abuse-репорту" icon={CheckCircle} color="var(--green)" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            Всього abuse-репортів: <strong style={{ color: 'var(--red)' }}>{reasons.total}</strong>
          </div>
          {reasons.by_type.map((r, i) => (
            <RankBar key={r.type} label={r.type} value={r.count} max={reasons.by_type[0].count} color="var(--red)" delay={i * 80} />
          ))}
          {reasons.by_cf_account.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
                По CF акаунтах
              </div>
              {reasons.by_cf_account.slice(0, 5).map((r, i) => (
                <RankBar key={r.name} label={r.name} value={r.count} max={reasons.by_cf_account[0].count} color="var(--accent)" delay={i * 80} />
              ))}
            </>
          )}
        </div>
      )}
    </PanelCard>
  )
}

function TeamLeaderboardCard({ teams }) {
  const sorted = [...teams].sort((a, b) => b.bans_in_window - a.bans_in_window)
  return (
    <PanelCard title="Команди — де банить найбільше" icon={Users} anim="pulse">
      {!teams.length ? <Empty text="Немає команд" icon={Info} /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {['Команда', 'Всього', 'Suspended', 'Бани', 'Ban %'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(t => (
                <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{t.name}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)' }}>{t.total}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)', color: t.suspended ? 'var(--red)' : 'var(--text3)' }}>{t.suspended}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {t.bans_in_window > 0
                      ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>{t.bans_in_window}</span>
                      : <span style={{ color: 'var(--text3)' }}>0</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <Heat pct={t.ban_rate_pct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  )
}

function CFAccountsCard({ accounts }) {
  const top = accounts.filter(a => a.suspended > 0).slice(0, 8)
  return (
    <PanelCard title="CF акаунти з найбільшою ban-rate" icon={Cloud} anim="pulse">
      {top.length === 0 ? <Empty text="Жоден CF акаунт без проблемних зон" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {top.map((a, i) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {a.team || '—'} · {a.total} доменів
                </div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700 }}>
                {a.suspended} susp
              </span>
              <Heat pct={a.ban_rate_pct} />
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  )
}

function TLDCard({ tlds }) {
  const banned = tlds.filter(t => t.suspended > 0).slice(0, 10)
  return (
    <PanelCard title="TLD з найвищою ban-rate" icon={Layers} anim="pulse">
      {banned.length === 0 ? <Empty text="Немає банів по TLD" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {banned.map((t, i) => (
            <RankBar key={t.tld} label={`.${t.tld}`}
              value={t.suspended} max={banned[0].suspended}
              right={<span style={{ fontSize: 11, color: 'var(--text3)' }}>{t.ban_rate_pct}% ({t.total})</span>}
              color="var(--red)" delay={i * 80} />
          ))}
        </div>
      )}
    </PanelCard>
  )
}

function PurchasesCard({ purchases }) {
  const total = purchases.total
  return (
    <PanelCard title="Закупки" icon={ShoppingBag} anim="bounce">
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>Всього</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{total}</div>
        </div>
        <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>За вікно</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>{purchases.recent}</div>
        </div>
      </div>
      {purchases.by_category.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>По категоріях</div>
          {purchases.by_category.map((c, i) => (
            <RankBar key={c.category} label={c.category} value={c.count}
              max={purchases.by_category[0].count} color="var(--accent)" delay={i * 60} />
          ))}
        </div>
      )}
      {purchases.by_status.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {purchases.by_status.map(s => {
            const tone = s.status === 'active' ? 'green' : s.status === 'expired' ? 'red' : 'default'
            return <Badge key={s.status} color={tone}>{s.status}: {s.count}</Badge>
          })}
        </div>
      )}
    </PanelCard>
  )
}

function RankBar({ label, value, max, color, right, delay = 0 }) {
  const pct = max ? Math.max(4, (value / max) * 100) : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {right || <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{value}</span>}
      </div>
      <div style={{ background: 'var(--bg3)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color,
          borderRadius: 4, transition: `width 0.6s ${delay}ms ease-out`,
        }} />
      </div>
    </div>
  )
}

function Heat({ pct }) {
  const p = pct || 0
  const color = p > 30 ? 'var(--red)' : p > 10 ? 'var(--yellow)' : p > 0 ? 'var(--accent)' : 'var(--text3)'
  return (
    <span style={{
      fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color,
      padding: '2px 8px', borderRadius: 4,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      minWidth: 50, textAlign: 'center', display: 'inline-block',
    }}>{p}%</span>
  )
}

function Empty({ text, icon: Icon = Info, color = 'var(--text3)' }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 8, padding: 24, color: 'var(--text3)',
      fontSize: 12, flex: 1,
    }}>
      <AnimatedIcon icon={Icon} size={22} color={color} anim="pulse" />
      {text}
    </div>
  )
}

// ── Section title ─────────────────────────────────────────────────────────

function SectionTitle({ icon: Icon, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
      paddingTop: 8,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
        color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <AnimatedIcon icon={Icon} size={14} anim="pulse" />
      </div>
      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  )
}

// ── Domain growth (12-mo line chart) ─────────────────────────────────────

function DomainGrowthCard({ growth }) {
  // Fill missing months with zero
  const map = new Map(growth.map(g => [g.month, g.count]))
  const now = new Date()
  const series = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    series.push({ key, label: d.toLocaleString('uk-UA', { month: 'short' }), v: map.get(key) || 0 })
  }
  const max = Math.max(1, ...series.map(s => s.v))
  const total = series.reduce((a, b) => a + b.v, 0)

  // Build smooth line path
  const W = 320, H = 90, P = 4
  const xStep = (W - P * 2) / Math.max(1, series.length - 1)
  const points = series.map((s, i) => ({
    x: P + i * xStep,
    y: H - P - (s.v / max) * (H - P * 2),
  }))
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${points.at(-1).x} ${H - P} L${points[0].x} ${H - P} Z`

  return (
    <PanelCard title="Зростання доменів (12 міс)" icon={LineChart} anim="glow">
      {total === 0 ? <Empty text="Ще немає доменів" icon={Info} /> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 110 }}>
            <defs>
              <linearGradient id="grad-grow" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.42" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#grad-grow)" />
            <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={series[i].v > 0 ? 2.5 : 0} fill="var(--accent)">
                <title>{series[i].key}: {series[i].v}</title>
              </circle>
            ))}
          </svg>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: -4 }}>
            {series.filter((_, i) => i % 2 === 0).map(s => <span key={s.key}>{s.label}</span>)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span>Додано за рік</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700 }}>{total}</span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

// ── Top suspended ─────────────────────────────────────────────────────────

function TopSuspendedCard({ items }) {
  return (
    <PanelCard title="Останні забанені домени" icon={Skull} anim="shake">
      {items.length === 0 ? <Empty text="Нічого не забанено" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
          {items.map(it => (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)',
              borderRadius: 7, padding: '7px 10px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--red)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.domain}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {it.team || '—'} · {it.cf_account || '—'}
                </div>
              </div>
              <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                {it.suspended_at ? new Date(it.suspended_at).toLocaleString('uk-UA',
                  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  )
}

// ── Per-team detail (sparkline + counts) ─────────────────────────────────

function TeamDetailCard({ team, days }) {
  const max = Math.max(1, ...team.sparkline)
  const W = 220, H = 36, P = 2
  const xStep = (W - P * 2) / Math.max(1, team.sparkline.length - 1)
  const pts = team.sparkline.map((v, i) => ({
    x: P + i * xStep,
    y: H - P - (v / max) * (H - P * 2),
  }))
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const heatColor = team.ban_rate_pct > 30 ? 'var(--red)'
    : team.ban_rate_pct > 10 ? 'var(--yellow)'
    : team.ban_rate_pct > 0 ? 'var(--accent)' : 'var(--green)'

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: heatColor,
      }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingLeft: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{team.name}</span>
        <Heat pct={team.ban_rate_pct} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, paddingLeft: 6 }}>
        <MiniStat label="Домени" value={team.total} />
        <MiniStat label="Suspended" value={team.suspended} color="var(--red)" />
        <MiniStat label={`Бани ${days}д`} value={team.bans_in_window} color="var(--red)" />
        <MiniStat label="Active" value={team.active} color="var(--green)" />
        <MiniStat label="CF" value={team.cf_accounts} color="var(--accent)" />
        <MiniStat label="KT" value={team.kt_instances} color="var(--accent)" />
      </div>
      <div>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em',
          marginBottom: 4, paddingLeft: 6 }}>
          Бани за {days}д
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 36 }}>
          <path d={linePath} fill="none" stroke={team.bans_in_window > 0 ? 'var(--red)' : 'var(--text3)'} strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  )
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 800, color: color || 'var(--text)', lineHeight: 1.1 }}>{value}</span>
    </div>
  )
}

// ── Spend by month ───────────────────────────────────────────────────────

function SpendByMonthCard({ months }) {
  // Fill last 6 months
  const map = new Map(months.map(m => [m.month, m.amount]))
  const now = new Date()
  const series = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    series.push({ key, label: d.toLocaleString('uk-UA', { month: 'short' }), v: map.get(key) || 0 })
  }
  const max = Math.max(1, ...series.map(s => s.v))
  const total = series.reduce((a, b) => a + b.v, 0)

  return (
    <PanelCard title="Витрати за 6 місяців" icon={TrendingUp} anim="bounce">
      {total === 0 ? <Empty text="Витрат ще не записано" icon={Wallet} /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
            {series.map((s, i) => {
              const h = (s.v / max) * 100
              return (
                <div key={s.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: '100%', flex: 1,
                    display: 'flex', alignItems: 'flex-end',
                  }}>
                    <div style={{
                      width: '100%',
                      height: `${h}%`,
                      background: `linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 30%, transparent))`,
                      borderRadius: '6px 6px 2px 2px',
                      transition: `height 0.6s ${i * 90}ms ease-out`,
                      minHeight: s.v > 0 ? 4 : 0,
                    }} title={`${s.key}: ${s.v.toFixed(2)}`} />
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{s.label}</span>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11,
            borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span style={{ color: 'var(--text3)' }}>Сума за 6 міс</span>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--accent)' }}>
              {total.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

// ── Spend breakdown (currency + category) ────────────────────────────────

function SpendBreakdownCard({ purchases }) {
  const cur = purchases.spend_by_currency || []
  const cat = purchases.spend_by_category || []
  const empty = cur.length === 0 && cat.length === 0
  return (
    <PanelCard title="Витрати — деталізація" icon={Wallet} anim="glow">
      {empty ? <Empty text="Витрат не записано" icon={Wallet} /> : (
        <>
          {cur.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                По валютах
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {cur.map(c => (
                  <div key={c.currency} style={{
                    background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{c.currency}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>
                      {c.amount.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {cat.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6 }}>
                По категоріях
              </div>
              {cat.map((c, i) => (
                <RankBar key={c.category} label={c.category} value={c.amount}
                  max={cat[0].amount} color="var(--accent)"
                  right={<span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                    {c.amount.toFixed(2)}
                  </span>}
                  delay={i * 60} />
              ))}
            </>
          )}
          {purchases.expiring_soon_30d > 0 && (
            <div style={{
              marginTop: 4, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <AnimatedIcon icon={CalendarClock} size={14} color="var(--yellow)" anim="pulse" />
              <span style={{ fontSize: 12 }}>
                <strong style={{ color: 'var(--yellow)' }}>{purchases.expiring_soon_30d}</strong> закупок завершуються у наступні 30 днів
              </span>
            </div>
          )}
        </>
      )}
    </PanelCard>
  )
}

// ── Infrastructure grid ──────────────────────────────────────────────────

function InfraGrid({ infra, totals }) {
  const items = [
    { label: 'Mail акаунти', value: infra.mail_total, icon: Inbox, color: 'blue', anim: 'pulse' },
    { label: 'Проксі', value: infra.proxies_total, sub: `активні: ${infra.proxies_active} · ok: ${infra.proxies_ok}`, icon: Network, color: 'purple', anim: 'glow' },
    { label: 'Сервери', value: infra.servers_total, sub: `ok: ${infra.servers_ok}`, icon: Server, color: 'green', anim: 'pulse' },
    { label: 'Особистості', value: infra.identities_total, icon: Sparkles, color: 'purple', anim: 'pulse' },
    { label: 'KT інстанси', value: infra.kt_instances, icon: BarChart3, color: 'orange', anim: 'pulse' },
    { label: 'CF акаунти', value: totals.cf_accounts, icon: Cloud, color: 'orange', anim: 'glow' },
    { label: 'Dynadot акаунти', value: totals.dynadot_accounts, icon: Globe, color: 'blue', anim: 'pulse' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      {items.map((it, i) => <BigStatCard key={i} {...it} delay={i * 100} />)}
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
        <div style={{ fontWeight: 700, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AnimatedIcon icon={Trash2} size={14} color="var(--red)" anim="pulse" />
          Видалені домени ({deleted.length})
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
