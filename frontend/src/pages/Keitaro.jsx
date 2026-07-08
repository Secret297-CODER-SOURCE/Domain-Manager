import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { RefreshCw, Plus, Trash2, ArrowRight, X, Zap, ChevronDown, ChevronRight, Copy, Search, Activity, BarChart2, CheckCircle2, AlertTriangle, Clock, Info } from 'lucide-react'
import {
  getKTDomains, getKTGroups,
  addDomainToKT, moveDomainInKT, deleteDomainFromKT,
  getDomains, getTeams, getKTInstances, getKTGroupsByInstance, getKTTree, syncKTGroups,
  getKTInstances_all, bulkTransferKT,
} from '../api/client'
import { Btn, Badge, Modal, Table, Spinner, Field } from '../components/ui/index'
import { useAuthStore } from '../store/auth'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function KeitaroPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()
  const [addModal, setAddModal] = useState(false)
  const [transferModal, setTransferModal] = useState(false)
  const [tab, setTab] = useState('tree') // 'tree' | 'live'

  const tabStyle = (active) => ({
    padding: '6px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', border: 'none',
    background: active ? 'var(--accent)' : 'var(--bg3)',
    color: active ? '#fff' : 'var(--text3)',
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Keitaro</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>Управління доменами в трекері</p>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" onClick={() => setTransferModal(true)}><ArrowRight size={14} /> Масовий перенос</Btn>
            <Btn onClick={() => setAddModal(true)}><Plus size={14} /> Додати домен в KT</Btn>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button style={tabStyle(tab === 'tree')} onClick={() => setTab('tree')}>
          <BarChart2 size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />Групи / Домени
        </button>
        <button style={tabStyle(tab === 'live')} onClick={() => setTab('live')}>
          <Activity size={12} style={{ verticalAlign: '-2px', marginRight: 6 }} />Live перегляд
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'tree' ? <KTTreeView isAdmin={isAdmin} /> : <KTDomainsTable isAdmin={isAdmin} />}
      </div>

      {isAdmin && (
        <AddToKTModal
          open={addModal}
          onClose={() => setAddModal(false)}
          onSuccess={() => { qc.invalidateQueries(['kt-domains-live']); setAddModal(false) }}
        />
      )}
      {isAdmin && (
        <BulkTransferModal
          open={transferModal}
          onClose={() => setTransferModal(false)}
          onSuccess={() => { qc.invalidateQueries(['kt-tree']); qc.invalidateQueries(['kt-domains-live']); setTransferModal(false) }}
        />
      )}
    </div>
  )
}

// ── Tree View: Instance → Group → Domains ─────────────────────────────────
function KTTreeView({ isAdmin }) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState({})
  const [search, setSearch] = useState('')
  const [syncing, setSyncing] = useState(null)

  const { data: tree = [], isLoading, refetch } = useQuery({
    queryKey: ['kt-tree'],
    queryFn: () => getKTTree().then(r => r.data),
    staleTime: 60000,
  })

  function toggle(key) { setExpanded(e => ({ ...e, [key]: !e[key] })) }

  async function syncInstance(instId, instName) {
    setSyncing(instId)
    try {
      await syncKTGroups(instId)
      qc.invalidateQueries(['kt-tree'])
      toast.success(`Групи синхронізовано: ${instName}`)
    } catch { toast.error('Помилка синхронізації') }
    finally { setSyncing(null) }
  }

  const searchLow = search.toLowerCase()
  const filtered = tree.map(inst => ({
    ...inst,
    groups: inst.groups.map(g => ({
      ...g,
      domains: searchLow ? g.domains.filter(d => d.includes(searchLow)) : g.domains,
    })).filter(g => !searchLow || g.domains.length > 0 || g.name.toLowerCase().includes(searchLow)),
  })).filter(inst => !searchLow || inst.groups.length > 0 || inst.name.toLowerCase().includes(searchLow))

  const totalDomains = tree.reduce((s, i) => s + i.domain_count, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>
      {/* Search bar */}
      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input placeholder="Пошук домену або групи..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: 30, width: '100%' }} />
        </div>
        <Btn variant="ghost" loading={isLoading} onClick={() => refetch()}>
          <RefreshCw size={13} />
        </Btn>
        <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center' }}>
          {totalDomains} доменів у {tree.length} інстансах
        </span>
      </div>

      {/* Tree */}
      <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {isLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>}
        {!isLoading && filtered.map(inst => (
          <div key={inst.id} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            {/* Instance header */}
            <div onClick={() => toggle(`inst-${inst.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              {expanded[`inst-${inst.id}`] ? <ChevronDown size={15} color="var(--text3)" /> : <ChevronRight size={15} color="var(--text3)" />}
              <span style={{ fontWeight: 700, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <BarChart2 size={14} style={{ color: 'var(--accent)' }} /> {inst.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{inst.team}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                <Badge color="blue">{inst.group_count} груп</Badge>
                <Badge color="green">{inst.domain_count} доменів</Badge>
                {isAdmin && (
                  <Btn size="sm" variant="ghost" loading={syncing === inst.id}
                    onClick={e => { e.stopPropagation(); syncInstance(inst.id, inst.name) }}
                    title="Синхронізувати групи">
                    <RefreshCw size={11} />
                  </Btn>
                )}
              </div>
            </div>

            {/* Groups */}
            {expanded[`inst-${inst.id}`] && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {inst.groups.length === 0 && (
                  <p style={{ color: 'var(--text3)', fontSize: 12, padding: '4px 0' }}>Груп немає — синхронізуйте ↑</p>
                )}
                {inst.groups.map(g => (
                  <div key={g.id}>
                    <div onClick={() => toggle(`grp-${g.id}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', userSelect: 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      {expanded[`grp-${g.id}`] ? <ChevronDown size={12} color="var(--text3)" /> : <ChevronRight size={12} color="var(--text3)" />}
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{g.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>({g.domain_count} доменів)</span>
                      {g.domain_count > 0 && (
                        <Btn size="sm" variant="ghost" style={{ marginLeft: 'auto', padding: '1px 6px' }}
                          onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(g.domains.join('\n')); toast.success(`${g.domain_count} доменів скопійовано`) }}>
                          <Copy size={10} /> Копіювати
                        </Btn>
                      )}
                    </div>
                    {expanded[`grp-${g.id}`] && g.domains.length > 0 && (
                      <div style={{ marginLeft: 24, padding: '4px 0 6px', display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
                        {g.domains.map(d => (
                          <span key={d} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{d}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main table ────────────────────────────────────────────────────────────
function KTDomainsTable({ isAdmin }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [instanceId, setInstanceId] = useState('')
  const [groupName, setGroupName] = useState('')
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('')
  const [selected, setSelected] = useState([])
  const [moveModal, setMoveModal] = useState(null)
  const [bulkMoveModal, setBulkMoveModal] = useState(false)
  const [bulkByNameModal, setBulkByNameModal] = useState(false)

  const [showData, setShowData] = useState(false)

  const { data: allDomains = [], isLoading, refetch } = useQuery({
    queryKey: ['kt-domains-live'],
    queryFn: () => getKTDomains().then(r => r.data),
    staleTime: 60000,
    enabled: showData,
  })

  async function handleDeleteSelected() {
    gateDelete(async () => {
      await Promise.all(selected.map(id => deleteDomainFromKT(id)))
      toast.success(`Видалено ${selected.length} доменів з KT`)
      setSelected([])
      qc.invalidateQueries(['kt-domains-live'])
    }).catch(e => {
      if (e?.message !== 'cancelled') toast.error(e.response?.data?.detail || 'Помилка видалення')
    })
  }

  function handleMoveSelected() {
    if (selected.length === 1) {
      const domain = allDomains.find(d => d.kt_domain_id === selected[0])
      setMoveModal(domain)
    } else {
      setBulkMoveModal(true)
    }
  }

  const instances = [...new Map(
    allDomains.map(d => [d.instance_id, { id: d.instance_id, name: d.instance_name, team: d.team_name }])
  ).values()]

  const groupsForInstance = [...new Set(
    allDomains
      .filter(d => !instanceId || d.instance_id === parseInt(instanceId))
      .map(d => d.group_name).filter(Boolean)
  )].sort()

  const filtered = allDomains.filter(d => {
    if (instanceId && d.instance_id !== parseInt(instanceId)) return false
    if (groupName && d.group_name !== groupName) return false
    if (search && !d.domain.includes(search.toLowerCase())) return false
    if (providerFilter === 'cf' && !d.in_cf) return false
    if (providerFilter === 'custom' && d.in_cf) return false
    return true
  })

  const columns = [
    {
      key: 'domain', label: 'Домен',
      render: v => <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{v}</span>
    },
    {
      key: 'instance_name', label: 'Keitaro',
      render: (v, row) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{v}</div>
          <div style={{ color: 'var(--text3)', fontSize: 11 }}>{row.team_name}</div>
        </div>
      )
    },
    {
      key: 'group_name', label: 'Група',
      render: v => v ? <Badge color="blue">{v}</Badge> : <span style={{ color: 'var(--text3)' }}>—</span>
    },
    {
      key: 'in_cf', label: 'Провайдер',
      render: (inCf, row) => inCf
        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Badge color="blue">☁ Cloudflare</Badge>
            <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{row.cf_account_name}</span>
          </div>
        : <Badge color="default">Custom DNS</Badge>
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'hidden' }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0,
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 12,
      }}>
        <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 140 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input
            placeholder="Пошук домену..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: 30, width: '100%' }}
          />
        </div>
        <select value={instanceId} onChange={e => { setInstanceId(e.target.value); setGroupName('') }} style={{ flex: '1 1 180px' }}>
          <option value="">Всі KT інстанси</option>
          {instances.map(i => <option key={i.id} value={i.id}>{i.name} ({i.team})</option>)}
        </select>
        <select value={groupName} onChange={e => setGroupName(e.target.value)} disabled={!instanceId} style={{ flex: '1 1 160px' }}>
          <option value="">Всі групи</option>
          {groupsForInstance.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={providerFilter} onChange={e => setProviderFilter(e.target.value)} style={{ flex: '0 1 150px' }}>
          <option value="">Всі провайдери</option>
          <option value="cf">☁ Cloudflare</option>
          <option value="custom">Custom DNS</option>
        </select>
        {(instanceId || groupName || search || providerFilter) && (
          <Btn size="sm" variant="ghost" onClick={() => { setInstanceId(''); setGroupName(''); setSearch(''); setProviderFilter('') }}>
            <X size={13} /> Очистити
          </Btn>
        )}
        <Btn size="sm" variant="ghost" loading={isLoading} onClick={() => { setShowData(true); refetch() }} title="Завантажити / Оновити">
          <RefreshCw size={12} />
        </Btn>
        <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center', marginLeft: 4 }}>
          {!showData ? 'не завантажено' : isLoading ? '...' : `${filtered.length} / ${allDomains.length}`}
        </span>
        {isAdmin && (
          <Btn size="sm" variant="ghost" onClick={() => setBulkByNameModal(true)}>
            <Zap size={12} /> Масові дії
          </Btn>
        )}
      </div>

      {/* Selection action bar */}
      {isAdmin && selected.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
          background: 'var(--accent-dim)', border: '1px solid rgba(79,110,247,0.3)',
          borderRadius: 8, padding: '8px 14px',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', flex: 1 }}>
            Вибрано: {selected.length}
          </span>
          <Btn size="sm" onClick={handleMoveSelected}>
            <ArrowRight size={12} /> Перенести{selected.length > 1 ? ` (${selected.length})` : ''}
          </Btn>
          <Btn size="sm" variant="danger" onClick={handleDeleteSelected}>
            <Trash2 size={12} /> Видалити{selected.length > 1 ? ` (${selected.length})` : ''}
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected([])}>
            <X size={12} /> Скасувати
          </Btn>
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', flex: 1 }}>
        {!showData
          ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 64, gap: 16, color: 'var(--text3)' }}>
              <span style={{ fontSize: 14 }}>Дані не завантажені — live запит до всіх KT інстансів</span>
              <Btn onClick={() => setShowData(true)}><RefreshCw size={14} /> Завантажити</Btn>
            </div>
          : isLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
            : <Table
              columns={columns}
              data={filtered}
              rowKey="kt_domain_id"
              selected={isAdmin ? selected : undefined}
              onSelect={isAdmin ? setSelected : undefined}
            />
        }
      </div>

      {/* Modals */}
      {isAdmin && moveModal && (
        <MoveDomainModal
          domain={moveModal}
          onClose={() => setMoveModal(null)}
          onSuccess={() => { qc.invalidateQueries(['kt-domains-live']); setMoveModal(null); setSelected([]) }}
        />
      )}
      {isAdmin && (
        <BulkMoveModal
          open={bulkMoveModal}
          domainIds={selected}
          onClose={() => setBulkMoveModal(false)}
          onSuccess={() => { qc.invalidateQueries(['kt-domains-live']); setBulkMoveModal(false); setSelected([]) }}
        />
      )}
      {isAdmin && (
        <BulkByNameModal
          open={bulkByNameModal}
          allDomains={allDomains}
          onClose={() => setBulkByNameModal(false)}
          onSuccess={() => { qc.invalidateQueries(['kt-domains-live']); setBulkByNameModal(false) }}
        />
      )}
    </div>
  )
}

// ── Modal: Bulk actions by pasting domain names ───────────────────────────
function BulkByNameModal({ open, allDomains, onClose, onSuccess }) {
  const { gateDelete } = useDeleteOtp()
  const [text, setText] = useState('')
  const [action, setAction] = useState('delete')
  const [teamId, setTeamId] = useState('')
  const [instanceId, setInstanceId] = useState('')
  const [newGroupId, setNewGroupId] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
    enabled: open,
  })
  const { data: instances = [] } = useQuery({
    queryKey: ['kt-inst', teamId],
    queryFn: () => getKTInstances(teamId).then(r => r.data),
    enabled: !!teamId,
  })
  const { data: groups = [] } = useQuery({
    queryKey: ['kt-grp', instanceId],
    queryFn: () => getKTGroupsByInstance(instanceId).then(r => r.data),
    enabled: !!instanceId,
  })

  const names = text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)
  const found = allDomains.filter(d => names.includes(d.domain.toLowerCase()))
  const notFound = names.filter(n => !allDomains.some(d => d.domain.toLowerCase() === n))

  async function submit() {
    if (found.length === 0) return
    if (action === 'delete') {
      gateDelete(async () => {
        await Promise.all(found.map(d => deleteDomainFromKT(d.kt_domain_id)))
        toast.success(`Видалено ${found.length} доменів з KT`)
        onSuccess()
      }).catch(e => {
        if (e?.message !== 'cancelled') toast.error(e.response?.data?.detail || 'Помилка')
      })
      return
    }
    setLoading(true)
    try {
      await Promise.all(found.map(d => moveDomainInKT({ domain_id: d.kt_domain_id, new_kt_group_id: +newGroupId })))
      toast.success(`Перенесено ${found.length} доменів`)
      onSuccess()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() {
    setText(''); setAction('delete'); setTeamId(''); setInstanceId(''); setNewGroupId('')
    onClose()
  }

  const canSubmit = found.length > 0 && (action === 'delete' || newGroupId)

  return (
    <Modal open={open} onClose={handleClose} title="Масові дії" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Домени (по одному на рядок)">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={8}
            placeholder={'domain1.com\ndomain2.com\ndomain3.com'}
            style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
          />
        </Field>

        {names.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Знайдено: <strong style={{ color: 'var(--green)' }}>{found.length}</strong> / {names.length}</span>
            {notFound.length > 0 && (
              <span style={{ color: 'var(--red)' }}>
                Не знайдено: {notFound.slice(0, 3).join(', ')}{notFound.length > 3 ? ` +${notFound.length - 3}` : ''}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          {[['delete', 'Видалити з KT'], ['move', 'Перенести в групу']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => { setAction(val); setTeamId(''); setInstanceId(''); setNewGroupId('') }}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 6,
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: action === val ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: action === val ? 'var(--accent-dim)' : 'var(--bg3)',
                color: action === val ? 'var(--accent)' : 'var(--text2)',
                fontFamily: 'var(--font)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {action === 'move' && (
          <>
            <Field label="Команда">
              <select value={teamId} onChange={e => { setTeamId(e.target.value); setInstanceId(''); setNewGroupId('') }}>
                <option value="">Оберіть команду...</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="KT Інстанс">
              <select value={instanceId} onChange={e => { setInstanceId(e.target.value); setNewGroupId('') }} disabled={!teamId}>
                <option value="">Оберіть інстанс...</option>
                {instances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Група">
              <select value={newGroupId} onChange={e => setNewGroupId(e.target.value)} disabled={!instanceId}>
                <option value="">Оберіть групу...</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn
            loading={loading}
            disabled={!canSubmit}
            variant={action === 'delete' ? 'danger' : 'primary'}
            onClick={submit}
          >
            {action === 'delete'
              ? <><Trash2 size={13} /> Видалити ({found.length})</>
              : <><ArrowRight size={13} /> Перенести ({found.length})</>}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Modal: Bulk move selected domains ────────────────────────────────────
function BulkMoveModal({ open, domainIds, onClose, onSuccess }) {
  const [newGroupId, setNewGroupId] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: groups = [] } = useQuery({
    queryKey: ['kt-groups'],
    queryFn: () => getKTGroups().then(r => r.data),
    enabled: open,
  })

  async function submit() {
    setLoading(true)
    try {
      await Promise.all(domainIds.map(id => moveDomainInKT({ domain_id: id, new_kt_group_id: +newGroupId })))
      toast.success(`Перенесено ${domainIds.length} доменів`)
      onSuccess()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() { setNewGroupId(''); onClose() }

  return (
    <Modal open={open} onClose={handleClose} title={`Перенести ${domainIds.length} доменів`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Нова група">
          <select value={newGroupId} onChange={e => setNewGroupId(e.target.value)}>
            <option value="">Оберіть групу...</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.team_name} / {g.instance_name} / {g.name}</option>
            ))}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!newGroupId} onClick={submit}>
            <ArrowRight size={13} /> Перенести
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Modal: Move single domain ─────────────────────────────────────────────
function MoveDomainModal({ domain, onClose, onSuccess }) {
  const [mode, setMode] = useState('group')
  const [newGroupId, setNewGroupId] = useState('')
  const [newTeamId, setNewTeamId] = useState('')
  const [newInstanceId, setNewInstanceId] = useState('')
  const [loading, setLoading] = useState(false)

  const { data: allGroups = [] } = useQuery({
    queryKey: ['kt-groups'],
    queryFn: () => getKTGroups().then(r => r.data),
  })
  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
  })
  const { data: newInstances = [] } = useQuery({
    queryKey: ['kt-inst', newTeamId], enabled: !!newTeamId,
    queryFn: () => getKTInstances(newTeamId).then(r => r.data),
  })
  const { data: newGroups = [] } = useQuery({
    queryKey: ['kt-grp', newInstanceId], enabled: !!newInstanceId,
    queryFn: () => getKTGroupsByInstance(newInstanceId).then(r => r.data),
  })

  const sameInstanceGroups = allGroups.filter(g =>
    g.keitaro_instance_id === domain?.instance_id && g.id !== domain?.group_id
  )

  const selectedNewInst = newInstances.find(i => i.id === parseInt(newInstanceId))

  async function submit() {
    if (!domain?.cf_domain_id) return
    setLoading(true)
    try {
      if (mode === 'group') {
        await moveDomainInKT({ domain_id: domain.cf_domain_id, new_kt_group_id: +newGroupId })
      } else {
        const cname = selectedNewInst?.cname
        if (!cname) { toast.error('У нового KT інстансу не вказано CNAME'); setLoading(false); return }
        await import('../api/client').then(m => m.default.post('/api/keitaro/domain/move-instance', {
          domain_id: domain.cf_domain_id,
          new_kt_instance_id: +newInstanceId,
          new_kt_group_id: +newGroupId,
          new_cname_target: cname,
        }))
      }
      toast.success(`${domain.domain} перенесено`)
      onSuccess()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() { setMode('group'); setNewGroupId(''); setNewTeamId(''); setNewInstanceId(''); onClose() }

  const canSubmit = domain?.cf_domain_id && newGroupId && (mode === 'group' || (newInstanceId && selectedNewInst?.cname))

  return (
    <Modal open={!!domain} onClose={handleClose} title={`Перенести: ${domain?.domain}`} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!domain?.cf_domain_id && (
          <div style={{ background: 'var(--yellow-dim)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--yellow)' }}>
            Цей домен тільки в Keitaro (не в CF) — перенесення недоступне.
          </div>
        )}

        <p style={{ color: 'var(--text2)', fontSize: 13, margin: 0 }}>
          Зараз: <strong>{domain?.group_name || '—'}</strong>
          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>({domain?.instance_name})</span>
        </p>

        <div style={{ display: 'flex', gap: 8 }}>
          {[['group', 'В іншу групу (той самий KT)'], ['instance', 'В інший KT']].map(([val, label]) => (
            <button key={val} onClick={() => { setMode(val); setNewGroupId(''); setNewTeamId(''); setNewInstanceId('') }}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 6, fontFamily: 'var(--font)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: mode === val ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: mode === val ? 'var(--accent-dim)' : 'var(--bg3)',
                color: mode === val ? 'var(--accent)' : 'var(--text2)',
              }}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'group' && (
          <Field label="Нова група (той самий KT)">
            <select value={newGroupId} onChange={e => setNewGroupId(e.target.value)}>
              <option value="">Оберіть групу...</option>
              {sameInstanceGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
        )}

        {mode === 'instance' && (
          <>
            <Field label="Команда нового KT">
              <select value={newTeamId} onChange={e => { setNewTeamId(e.target.value); setNewInstanceId(''); setNewGroupId('') }}>
                <option value="">Оберіть команду...</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Новий KT інстанс">
              <select value={newInstanceId} onChange={e => { setNewInstanceId(e.target.value); setNewGroupId('') }} disabled={!newTeamId}>
                <option value="">Оберіть інстанс...</option>
                {newInstances.filter(i => i.id !== domain?.instance_id).map(i => (
                  <option key={i.id} value={i.id}>{i.name}{i.cname ? ` → ${i.cname}` : ' — без CNAME'}</option>
                ))}
              </select>
            </Field>
            {newInstanceId && !selectedNewInst?.cname && (
              <div style={{ background: 'var(--yellow-dim)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--yellow)' }}>
                У цього KT інстансу не вказано CNAME. Додай його в Налаштуваннях.
              </div>
            )}
            {selectedNewInst?.cname && (
              <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
                CF CNAME буде змінено на: <strong style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{selectedNewInst.cname}</strong>
              </div>
            )}
            <Field label="Група в новому KT">
              <select value={newGroupId} onChange={e => setNewGroupId(e.target.value)} disabled={!newInstanceId}>
                <option value="">Оберіть групу...</option>
                {newGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!canSubmit} onClick={submit}>
            <ArrowRight size={13} /> Перенести
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Modal: Add domain to KT ───────────────────────────────────────────────
function AddToKTModal({ open, onClose, onSuccess }) {
  const [form, setForm] = useState({ domain_id: '', kt_instance_id: '', kt_group_id: '' })
  const [loading, setLoading] = useState(false)
  const [teamId, setTeamId] = useState('')

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => import('../api/client').then(m => m.getTeams()).then(r => r.data),
    enabled: open,
  })
  const { data: domains = [] } = useQuery({
    queryKey: ['domains-nkt'],
    queryFn: () => getDomains({ no_keitaro: true, page_size: 2000 }).then(r => r.data),
    enabled: open,
  })
  const { data: ktInstances = [] } = useQuery({
    queryKey: ['kt-inst', teamId], enabled: !!teamId,
    queryFn: () => getKTInstances(teamId).then(r => r.data),
  })
  const { data: ktGroups = [] } = useQuery({
    queryKey: ['kt-grp', form.kt_instance_id], enabled: !!form.kt_instance_id,
    queryFn: () => getKTGroupsByInstance(form.kt_instance_id).then(r => r.data),
  })

  async function submit() {
    setLoading(true)
    try {
      await addDomainToKT({ domain_id: +form.domain_id, kt_instance_id: +form.kt_instance_id, kt_group_id: +form.kt_group_id })
      toast.success('Домен додано в KT')
      onSuccess()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка')
    } finally {
      setLoading(false)
    }
  }

  function handleClose() { setForm({ domain_id: '', kt_instance_id: '', kt_group_id: '' }); setTeamId(''); onClose() }

  return (
    <Modal open={open} onClose={handleClose} title="Додати домен в Keitaro">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Домен (не в KT)">
          <select value={form.domain_id} onChange={e => setForm(f => ({ ...f, domain_id: e.target.value }))}>
            <option value="">Оберіть домен...</option>
            {domains.map(d => <option key={d.id} value={d.id}>{d.name} ({d.team_name})</option>)}
          </select>
        </Field>
        <Field label="Команда">
          <select value={teamId} onChange={e => { setTeamId(e.target.value); setForm(f => ({ ...f, kt_instance_id: '', kt_group_id: '' })) }}>
            <option value="">Оберіть команду...</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="KT Інстанс">
          <select value={form.kt_instance_id} onChange={e => setForm(f => ({ ...f, kt_instance_id: e.target.value, kt_group_id: '' }))} disabled={!teamId}>
            <option value="">Оберіть інстанс...</option>
            {ktInstances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </Field>
        <Field label="Група">
          <select value={form.kt_group_id} onChange={e => setForm(f => ({ ...f, kt_group_id: e.target.value }))} disabled={!form.kt_instance_id}>
            <option value="">Оберіть групу...</option>
            {ktGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.domain_id || !form.kt_instance_id || !form.kt_group_id} onClick={submit}>
            <Plus size={13} /> Додати
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Bulk Transfer Modal ───────────────────────────────────────────────────
function BulkTransferModal({ open, onClose, onSuccess }) {
  const qc = useQueryClient()
  const [instanceId, setInstanceId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [removeOld, setRemoveOld] = useState(true)
  const [updateCname, setUpdateCname] = useState(true)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState(null)

  const { data: instances = [] } = useQuery({
    queryKey: ['kt-instances-all'],
    queryFn: () => getKTInstances_all().then(r => r.data),
    enabled: open,
  })
  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ['kt-grp', instanceId],
    queryFn: () => getKTGroupsByInstance(instanceId).then(r => r.data),
    enabled: !!instanceId,
    staleTime: 0,
  })

  async function syncGroups() {
    if (!instanceId) return
    setSyncing(true)
    try {
      await syncKTGroups(parseInt(instanceId))
      qc.invalidateQueries(['kt-grp', instanceId])
      toast.success('Групи синхронізовано')
    } catch { toast.error('Помилка синхронізації') }
    finally { setSyncing(false) }
  }

  async function submit() {
    const domains = domainsText.split('\n').map(d => d.trim()).filter(Boolean)
    if (!instanceId || domains.length === 0) return
    setLoading(true)
    try {
      const r = await bulkTransferKT({
        domains,
        target_instance_id: parseInt(instanceId),
        target_group_id: groupId ? parseInt(groupId) : null,
        remove_from_old: removeOld,
        update_cname: updateCname,
      })
      setResults(r.data)
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка переносу')
    } finally { setLoading(false) }
  }

  function handleClose() {
    setResults(null); setDomainsText(''); setInstanceId(''); setGroupId('')
    onClose()
  }

  const domains = domainsText.split('\n').map(d => d.trim()).filter(Boolean)

  return (
    <Modal open={open} onClose={handleClose} title="Масовий перенос доменів в KT" width={560}>
      {results ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={15} style={{ color: 'var(--green)' }} />
            {results.ok} / {results.total} успішно
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {results.results.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                <span style={{ fontFamily: 'var(--mono)', flex: 1 }}>{r.domain}</span>
                <span style={{ color: r.status === 'ok' ? 'var(--green)' : 'var(--red)', fontWeight: 600, minWidth: 100, fontSize: 11 }}>
                  {r.status === 'ok'
                    ? r.action === 'already_exists' ? '= вже є'
                    : r.action === 'moved_group' ? '→ група змінена'
                    : '+ додано'
                    : 'помилка: ' + (r.detail || '—')}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={() => { onSuccess(); handleClose() }}>Готово</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Цільовий KT інстанс">
            <select value={instanceId} onChange={e => { setInstanceId(e.target.value); setGroupId('') }}>
              <option value="">— Виберіть інстанс —</option>
              {instances.map(i => <option key={i.id} value={i.id}>{i.name} ({i.team_name})</option>)}
            </select>
          </Field>
          {instanceId && (
            <Field label={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Група (необов'язково)</span>
                <Btn size="sm" variant="ghost" loading={syncing} onClick={syncGroups} style={{ fontSize: 10, padding: '1px 6px' }}>
                  <RefreshCw size={10} /> Синхронізувати групи
                </Btn>
              </div>
            }>
              {groupsLoading || syncing
                ? <div style={{ fontSize: 11, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={11} /> Завантаження…</div>
                : groups.length === 0
                  ? <div style={{ fontSize: 11, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={11} style={{ color: 'var(--yellow)' }} /> Немає груп — натисніть «Синхронізувати групи»</div>
                  : <select value={groupId} onChange={e => setGroupId(e.target.value)}>
                      <option value="">Без групи</option>
                      {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
              }
            </Field>
          )}
          <Field label={`Домени (${domains.length}) — по одному на рядок`}>
            <textarea value={domainsText} onChange={e => setDomainsText(e.target.value)}
              rows={10} placeholder={'domain1.com\ndomain2.net\n...'}
              style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={updateCname} onChange={e => setUpdateCname(e.target.checked)} />
              Оновити CNAME на CF
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={removeOld} onChange={e => setRemoveOld(e.target.checked)} />
              Видалити зі старого KT
            </label>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', background: 'var(--bg3)', borderRadius: 6, padding: '8px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Info size={11} /> Якщо домен вже є в цільовому KT — тільки змінить групу. Нові — додадуться.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn loading={loading} disabled={!instanceId || domains.length === 0} onClick={submit}>
              <ArrowRight size={13} /> Перенести ({domains.length})
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}
