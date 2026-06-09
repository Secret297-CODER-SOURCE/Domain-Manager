import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Trash2, Edit3, ExternalLink, RefreshCw, Activity, AlertTriangle, Settings as SettingsIcon } from 'lucide-react'

import {
  getKumaInstances, createKumaInstance, updateKumaInstance, deleteKumaInstance,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const DEFAULT_COLORS = ['#0a84ff', '#30d158', '#ffd60a', '#ff453a', '#bf5af2', '#ff9f0a', '#64d2ff']

export default function KumaPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [active, setActive] = useState(null)
  const [editModal, setEditModal] = useState(null) // 'new' | instance
  const [reloadKey, setReloadKey] = useState(0)

  const { data: instances = [], isLoading } = useQuery({
    queryKey: ['kuma'],
    queryFn: () => getKumaInstances().then(r => r.data),
  })

  // Default-select first instance when list loads / active gets removed
  useEffect(() => {
    if (instances.length === 0) { setActive(null); return }
    if (!active || !instances.find(i => i.id === active.id)) {
      setActive(instances[0])
    }
  }, [instances, active])

  const delMut = useMutation({
    mutationFn: deleteKumaInstance,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['kuma']) },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, background: 'var(--bg2)',
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, background: 'var(--accent-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Activity size={18} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontWeight: 800, fontSize: 17 }}>Uptime Kuma</h1>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            {instances.length} інстансів — {active ? active.url : 'оберіть інстанс'}
          </div>
        </div>
        {active && (
          <>
            <Btn size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} title="Перезавантажити iframe">
              <RefreshCw size={13} />
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => window.open(active.url, '_blank')} title="Відкрити у новій вкладці">
              <ExternalLink size={13} /> Open
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setEditModal(active)}>
              <Edit3 size={13} /> Редагувати
            </Btn>
          </>
        )}
        <Btn size="sm" onClick={() => setEditModal('new')}><Plus size={13} /> Інстанс</Btn>
      </div>

      {/* Pills row — instances switcher */}
      {instances.length > 0 && (
        <div style={{
          padding: '10px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
          display: 'flex', gap: 6, flexShrink: 0, overflowX: 'auto',
        }}>
          {instances.map((k, i) => {
            const color = k.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
            const isActive = active?.id === k.id
            return (
              <button key={k.id} onClick={() => setActive(k)}
                onContextMenu={e => { e.preventDefault(); setEditModal(k) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
                  border: '1px solid',
                  borderColor: isActive ? color : 'var(--border)',
                  background: isActive ? `color-mix(in srgb, ${color} 18%, transparent)` : 'var(--bg3)',
                  color: isActive ? color : 'var(--text2)',
                  fontWeight: 600, fontSize: 12,
                  transition: 'all 0.15s', whiteSpace: 'nowrap',
                }}
                title="ПКМ — редагувати"
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                {k.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0a0a0f' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner /></div>
        ) : instances.length === 0 ? (
          <EmptyState onAdd={() => setEditModal('new')} />
        ) : active ? (
          <KumaFrame key={active.id + ':' + reloadKey} instance={active} />
        ) : null}
      </div>

      <EditModal modal={editModal} onClose={() => setEditModal(null)}
        onSaved={() => qc.invalidateQueries(['kuma'])}
        onDelete={(id) => gateDelete(() => delMut.mutateAsync(id)).then(() => setEditModal(null)).catch(() => {})}
      />
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text3)',
    }}>
      <Activity size={48} style={{ opacity: 0.4 }} />
      <div style={{ fontSize: 14 }}>Ще немає Uptime Kuma інстансів</div>
      <Btn onClick={onAdd}><Plus size={14} /> Додати перший</Btn>
    </div>
  )
}

function KumaFrame({ instance }) {
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)

  // Most Kuma instances send X-Frame-Options: SAMEORIGIN — we can't always know upfront.
  // Show a fallback overlay if iframe fails or takes too long, but keep the iframe visible if it loads.
  useEffect(() => {
    setFailed(false); setLoading(true)
    const t = setTimeout(() => setLoading(false), 1500)
    return () => clearTimeout(t)
  }, [instance.id])

  return (
    <>
      <iframe
        src={instance.url}
        title={instance.name}
        style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
        onLoad={() => setLoading(false)}
        onError={() => setFailed(true)}
        // sandbox left unset — Kuma needs cookies/storage for auth
        referrerPolicy="no-referrer-when-downgrade"
      />
      {failed && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text2)',
          background: 'var(--bg)',
        }}>
          <AlertTriangle size={36} style={{ color: 'var(--yellow)' }} />
          <div>Не вдалось завантажити iframe (X-Frame-Options блокує)</div>
          <Btn onClick={() => window.open(instance.url, '_blank')}>
            <ExternalLink size={14} /> Відкрити у новій вкладці
          </Btn>
        </div>
      )}
    </>
  )
}

function EditModal({ modal, onClose, onSaved, onDelete }) {
  const isNew = modal === 'new'
  const inst = !isNew && modal ? modal : null
  const [form, setForm] = useState(blank())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!modal) return
    if (isNew) setForm(blank())
    else setForm({
      name: inst.name, url: inst.url,
      color: inst.color || DEFAULT_COLORS[0],
      sort_order: inst.sort_order, notes: inst.notes || '',
    })
  }, [modal])

  async function submit() {
    if (!form.name.trim() || !form.url.trim()) return toast.error('Назва і URL обовʼязкові')
    setLoading(true)
    try {
      if (isNew) await createKumaInstance(form)
      else await updateKumaInstance(inst.id, form)
      toast.success(isNew ? 'Додано' : 'Збережено')
      onSaved(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={!!modal} onClose={onClose} title={isNew ? 'Новий Uptime Kuma' : 'Редагувати інстанс'} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Назва">
          <input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Prod monitor" />
        </Field>
        <Field label="URL (включаючи https://)">
          <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://kuma.example.com" />
        </Field>
        <Field label="Колір">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DEFAULT_COLORS.map(c => (
              <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
                style={{
                  width: 26, height: 26, borderRadius: '50%', background: c,
                  border: '2px solid', borderColor: form.color === c ? 'var(--text)' : 'transparent',
                  cursor: 'pointer',
                }} />
            ))}
          </div>
        </Field>
        <Field label="Порядок (менше = вище)">
          <input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: +e.target.value || 0 }))} />
        </Field>
        <Field label="Нотатки">
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          {!isNew && <Btn variant="danger" onClick={() => onDelete(inst.id)}><Trash2 size={13} /> Видалити</Btn>}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
            <Btn loading={loading} onClick={submit}>{isNew ? 'Додати' : 'Зберегти'}</Btn>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function blank() { return { name: '', url: '', color: DEFAULT_COLORS[0], sort_order: 0, notes: '' } }
