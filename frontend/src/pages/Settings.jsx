import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, Check, X, Pencil, BarChart2, Cloud, Lock, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  getTeams, createTeam, updateTeam, deleteTeam,
  getKTInstances, createKTInstance, deleteKTInstance, syncKTGroups, updateKTInstance,
  getFrontendCodeword, setFrontendCodeword,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function SettingsPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [expanded, setExpanded] = useState({})
  const [addTeamModal, setAddTeamModal] = useState(false)
  const [addKTModal, setAddKTModal] = useState(null)   // teamId
  const [editKTModal, setEditKTModal] = useState(null) // { teamId, instance }

  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: () => getTeams().then(r => r.data),
  })

  const deleteMut = useMutation({
    mutationFn: deleteTeam,
    onSuccess: () => { toast.success('Команду видалено'); qc.invalidateQueries(['teams']) },
  })

  function toggle(id) { setExpanded(e => ({ ...e, [id]: !e[id] })) }

  return (
    <div style={{ padding: 24, maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Налаштування</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>Команди та Keitaro інстанси</p>
        </div>
        <Btn onClick={() => setAddTeamModal(true)}><Plus size={14} /> Нова команда</Btn>
      </div>

      <Link to="/cloudflare" style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '12px 14px', textDecoration: 'none', color: 'var(--text)',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: 'color-mix(in srgb, #f48120 18%, transparent)', color: '#f48120',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Cloud size={16} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Cloudflare & Dynadot</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            API-акаунти реєстраторів переїхали в окрему вкладку «Cloudflare» — там зручніше додавати з вибором команди.
          </div>
        </div>
        <Badge color="blue">Відкрити →</Badge>
      </Link>

      <FrontendCodewordCard />

      {isLoading ? <Spinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {teams.length === 0 && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)' }}>
              Ще немає команд. Натисніть «Нова команда» щоб почати.
            </div>
          )}
          {teams.map(team => (
            <TeamCard
              key={team.id}
              team={team}
              expanded={expanded[team.id]}
              onToggle={() => toggle(team.id)}
              onDelete={() => gateDelete(() => deleteMut.mutateAsync(team.id)).catch(() => {})}
              onAddKT={() => setAddKTModal(team.id)}
              onEditKT={(inst) => setEditKTModal({ teamId: team.id, instance: inst })}
            />
          ))}
        </div>
      )}

      <AddTeamModal open={addTeamModal} onClose={() => setAddTeamModal(false)}
        onSuccess={() => { qc.invalidateQueries(['teams']); setAddTeamModal(false) }} />

      <AddKTModal open={!!addKTModal} onClose={() => setAddKTModal(null)} teamId={addKTModal}
        onSuccess={() => { qc.invalidateQueries(['kt', addKTModal]); setAddKTModal(null) }} />

      <EditKTModal
        open={!!editKTModal}
        onClose={() => setEditKTModal(null)}
        teamId={editKTModal?.teamId}
        instance={editKTModal?.instance}
        onSuccess={() => { qc.invalidateQueries(['kt', editKTModal?.teamId]); setEditKTModal(null) }}
      />
    </div>
  )
}

function TeamCard({ team, expanded, onToggle, onDelete, onAddKT, onEditKT }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(team.name)

  async function saveName() {
    if (!nameVal.trim() || nameVal.trim() === team.name) { setEditingName(false); return }
    try {
      await updateTeam(team.id, { name: nameVal.trim() })
      qc.invalidateQueries(['teams'])
      toast.success('Назву оновлено')
    } catch { toast.error('Помилка оновлення') }
    setEditingName(false)
  }
  function cancelName() { setNameVal(team.name); setEditingName(false) }

  const { data: ktInstances = [] } = useQuery({
    queryKey: ['kt', team.id], enabled: expanded,
    queryFn: () => getKTInstances(team.id).then(r => r.data),
  })

  const delKT = useMutation({ mutationFn: (id) => deleteKTInstance(team.id, id), onSuccess: () => qc.invalidateQueries(['kt', team.id]) })
  const syncKT = useMutation({
    mutationFn: (id) => syncKTGroups(id),
    onSuccess: (r) => toast.success(`Групи синхронізовано: ${r.data.synced} для ${r.data.instance}`),
    onError: () => toast.error('Помилка синхронізації груп KT'),
  })
  const updateKT = useMutation({
    mutationFn: ({ id, cname }) => updateKTInstance(team.id, id, { cname }),
    onSuccess: () => { toast.success('CNAME оновлено'); qc.invalidateQueries(['kt', team.id]) },
    onError: () => toast.error('Помилка оновлення'),
  })

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
          cursor: 'pointer', userSelect: 'none',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {expanded ? <ChevronDown size={16} color="var(--text3)" /> : <ChevronRight size={16} color="var(--text3)" />}
        {editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
            <input
              value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') cancelName() }}
              autoFocus
              style={{ fontWeight: 700, fontSize: 15, padding: '2px 8px', borderRadius: 4, background: 'var(--bg3)', border: '1px solid var(--accent)', width: 200 }}
            />
            <Btn size="sm" variant="ghost" onClick={saveName}><Check size={12} /></Btn>
            <Btn size="sm" variant="ghost" onClick={cancelName}><X size={12} /></Btn>
          </div>
        ) : (
          <>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{team.name}</span>
            {team.description && <span style={{ color: 'var(--text3)', fontSize: 12 }}>{team.description}</span>}
          </>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!editingName && (
            <Btn size="sm" variant="ghost" onClick={e => { e.stopPropagation(); setEditingName(true) }} title="Перейменувати">
              <Pencil size={12} />
            </Btn>
          )}
          <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); onDelete() }}>
            <Trash2 size={12} />
          </Btn>
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <BarChart2 size={12} /> Keitaro інстанси ({ktInstances.length})
            </span>
            <Btn size="sm" variant="ghost" onClick={onAddKT}><Plus size={12} /> Додати</Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ktInstances.map(kt => (
              <KTInstanceRow key={kt.id} kt={kt}
                onSync={() => syncKT.mutate(kt.id)} syncLoading={syncKT.isPending}
                onDelete={() => gateDelete(() => delKT.mutateAsync(kt.id)).catch(() => {})}
                onSaveCname={(cname) => updateKT.mutate({ id: kt.id, cname })}
                onEdit={() => onEditKT(kt)}
              />
            ))}
            {ktInstances.length === 0 && <p style={{ color: 'var(--text3)', fontSize: 12 }}>Немає інстансів</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function KTInstanceRow({ kt, onSync, syncLoading, onDelete, onSaveCname, onEdit }) {
  const [editingCname, setEditingCname] = useState(false)
  const [cnameVal, setCnameVal] = useState(kt.cname || '')

  function save() { onSaveCname(cnameVal); setEditingCname(false) }
  function cancel() { setCnameVal(kt.cname || ''); setEditingCname(false) }

  return (
    <div style={{
      background: 'var(--bg3)', borderRadius: 6, padding: '8px 12px',
      border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{kt.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kt.url}</div>
        </div>
        <Btn size="sm" variant="ghost" loading={syncLoading} onClick={onSync} title="Синхронізувати групи">
          <RefreshCw size={12} />
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onEdit} title="Редагувати">
          <Pencil size={12} />
        </Btn>
        <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={12} /></Btn>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>CNAME:</span>
        {editingCname ? (
          <>
            <input
              value={cnameVal} onChange={e => setCnameVal(e.target.value)}
              placeholder="tracker.example.com"
              style={{ flex: 1, fontSize: 11, fontFamily: 'var(--mono)', padding: '2px 6px' }}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
              autoFocus
            />
            <Btn size="sm" variant="ghost" onClick={save}><Check size={11} /></Btn>
            <Btn size="sm" variant="ghost" onClick={cancel}><X size={11} /></Btn>
          </>
        ) : (
          <span
            onClick={() => setEditingCname(true)}
            style={{
              fontSize: 11, fontFamily: 'var(--mono)', color: kt.cname ? 'var(--accent)' : 'var(--text3)',
              cursor: 'pointer', flex: 1,
              padding: '2px 6px', borderRadius: 4,
              border: '1px dashed var(--border)',
            }}
            title="Клікни щоб редагувати"
          >
            {kt.cname || '— не вказано —'}
          </span>
        )}
      </div>
    </div>
  )
}

function AddTeamModal({ open, onClose, onSuccess }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    try { await createTeam({ name, description: desc }); onSuccess(); setName(''); setDesc('') }
    catch { toast.error('Помилка створення команди') }
    finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Нова команда">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва команди"><input value={name} onChange={e => setName(e.target.value)} placeholder="Team Alpha" /></Field>
        <Field label="Опис (необов'язково)"><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="..." /></Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!name} onClick={submit}><Plus size={13} /> Створити</Btn>
        </div>
      </div>
    </Modal>
  )
}

function AddKTModal({ open, onClose, teamId, onSuccess }) {
  const [form, setForm] = useState({ name: '', url: '', api_key: '' })
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    try { await createKTInstance(teamId, form); onSuccess(); setForm({ name: '', url: '', api_key: '' }) }
    catch { toast.error('Помилка додавання KT інстансу') }
    finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Додати Keitaro інстанс">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="KT Team Alpha" /></Field>
        <Field label="URL"><input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://tracker.example.com" /></Field>
        <Field label="API Key"><input autoComplete="off" data-lpignore="true" data-1p-ignore style={{ fontFamily: 'var(--mono)', fontSize: 12 }} value={form.api_key} onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} placeholder="KT API Key" /></Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.name || !form.url || !form.api_key} onClick={submit}><Plus size={13} /> Додати</Btn>
        </div>
      </div>
    </Modal>
  )
}

function EditKTModal({ open, onClose, teamId, instance, onSuccess }) {
  const [form, setForm] = useState({ name: '', url: '', api_key: '' })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && instance) {
      setForm({ name: instance.name || '', url: instance.url || '', api_key: '' })
    }
  }, [open, instance?.id])

  function handleClose() {
    setForm({ name: '', url: '', api_key: '' })
    onClose()
  }

  async function submit() {
    setLoading(true)
    try {
      const payload = {}
      if (form.name !== instance.name) payload.name = form.name
      if (form.url !== instance.url) payload.url = form.url
      if (form.api_key.trim()) payload.api_key = form.api_key
      await updateKTInstance(teamId, instance.id, payload)
      toast.success('KT інстанс оновлено')
      onSuccess()
      setForm({ name: '', url: '', api_key: '' })
    } catch (err) {
      const detail = err.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Помилка оновлення')
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Редагувати: ${instance?.name || ''}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Назва інстансу" />
        </Field>
        <Field label="URL">
          <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://tracker.example.com" />
        </Field>
        <Field label="Новий API Key (залиш пустим щоб не міняти)">
          <input
            type="text"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={form.api_key}
            onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
            placeholder="Новий KT API Key"
            style={{ fontFamily: form.api_key ? 'var(--mono)' : undefined }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.name || !form.url} onClick={submit}><Check size={13} /> Зберегти</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Front-end codeword card ─────────────────────────────────────────────

function FrontendCodewordCard() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['fe-codeword'],
    queryFn: () => getFrontendCodeword().then(r => r.data),
    staleTime: 60000,
  })
  const [val, setVal] = useState('')
  const [editing, setEditing] = useState(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (data?.codeword != null) setVal(data.codeword)
  }, [data?.codeword])

  const saveMut = useMutation({
    mutationFn: (v) => setFrontendCodeword(v),
    onSuccess: () => {
      toast.success('Кодове слово збережено')
      qc.invalidateQueries({ queryKey: ['fe-codeword'] })
      setEditing(false)
    },
    onError: () => toast.error('Помилка збереження'),
  })

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8,
          background: 'color-mix(in srgb, #a855f7 18%, transparent)', color: '#a855f7',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Lock size={16} /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Кодове слово для /check</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            Фронтендер вводить це слово на публічній сторінці перевірки доменів — у відповідь отримує назву команди.
          </div>
        </div>
        <a href="/check" target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
          Відкрити /check <ExternalLink size={11} />
        </a>
      </div>

      {isLoading ? <Spinner /> : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              type={show ? 'text' : 'password'}
              value={val}
              onChange={e => { setVal(e.target.value); setEditing(true) }}
              placeholder={data?.is_set ? '••••••••' : 'Задайте кодове слово…'}
              autoComplete="off" data-lpignore="true" data-1p-ignore
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 13, paddingRight: 56 }}
            />
            <button type="button" onClick={() => setShow(s => !s)}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: 'var(--text3)',
                fontSize: 10, cursor: 'pointer', padding: 4,
              }}>{show ? 'сховати' : 'показати'}</button>
          </div>
          <Btn size="sm" loading={saveMut.isPending} disabled={!editing}
            onClick={() => saveMut.mutate(val)}>
            <Check size={12} /> Зберегти
          </Btn>
          {data?.is_set && (
            <Btn size="sm" variant="danger"
              onClick={() => { setVal(''); saveMut.mutate('') }}
              title="Очистити (вимкне Front-end режим)">
              <X size={12} />
            </Btn>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        Статус: <strong style={{ color: data?.is_set ? 'var(--green)' : 'var(--text3)' }}>
          {data?.is_set ? 'встановлено' : 'не задано'}
        </strong>
        {!data?.is_set && ' — Front-end режим недоступний, поки не задано слово'}
      </div>
    </div>
  )
}
