import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Trash2, Send, CheckCircle2, Clock } from 'lucide-react'
import { getUsers, createUser, deleteUser, getTgAdmins, addTgAdmin, deleteTgAdmin } from '../api/client'
import { Btn, Modal, Badge, Table, Field, Spinner } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

export default function UsersPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [modal, setModal] = useState(false)

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => getUsers().then(r => r.data) })

  const delMut = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => { toast.success('Користувача видалено'); qc.invalidateQueries(['users']) },
  })

  const columns = [
    { key: 'username', label: 'Логін', render: v => <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{v}</span> },
    { key: 'role', label: 'Роль', render: v => <Badge color={v === 'admin' ? 'blue' : 'default'}>{v}</Badge> },
    { key: 'is_active', label: 'Статус', render: v => <Badge color={v ? 'green' : 'red'}>{v ? 'Активний' : 'Вимкнено'}</Badge> },
    {
      key: 'id', label: '', render: (id, row) => (
        <Btn size="sm" variant="danger" onClick={() =>
          gateDelete(() => delMut.mutateAsync(id)).catch(() => {})
        }>
          <Trash2 size={12} />
        </Btn>
      )
    },
  ]

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Користувачі</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>Управління доступом</p>
        </div>
        <Btn onClick={() => setModal(true)}><Plus size={14} /> Новий користувач</Btn>
      </div>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        <Table columns={columns} data={users} />
      </div>

      <TelegramAdminsCard />

      <AddUserModal open={modal} onClose={() => setModal(false)}
        onSuccess={() => { qc.invalidateQueries(['users']); setModal(false) }} />
    </div>
  )
}

function TelegramAdminsCard() {
  const qc = useQueryClient()
  const [form, setForm] = useState({ username: '', display_name: '' })

  const { data: admins = [], isLoading } = useQuery({
    queryKey: ['tg-admins'],
    queryFn: () => getTgAdmins().then(r => r.data),
  })

  const addMut = useMutation({
    mutationFn: addTgAdmin,
    onSuccess: () => {
      toast.success('Додано — попросіть адміна написати боту /start')
      qc.invalidateQueries(['tg-admins'])
      setForm({ username: '', display_name: '' })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Помилка'),
  })

  const delMut = useMutation({
    mutationFn: deleteTgAdmin,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['tg-admins']) },
  })

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
        <Send size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
        Telegram адміни
      </div>
      <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 14 }}>
        Отримують OTP коди та сповіщення про абузи. Після додавання — попросіть людину написати боту <strong>/start</strong>.
      </p>

      {isLoading ? <Spinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {admins.length === 0 && (
            <p style={{ color: 'var(--text3)', fontSize: 12 }}>Ще нікого немає.</p>
          )}
          {admins.map(a => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '7px 10px',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', color: a.chat_id ? 'var(--green)' : 'var(--yellow)' }}>
                {a.chat_id ? <CheckCircle2 size={14} /> : <Clock size={14} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>
                  {a.display_name || (a.username ? `@${a.username}` : `ID: ${a.chat_id}`)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                  {a.username && <span>@{a.username}</span>}
                  {a.chat_id
                    ? <span style={{ marginLeft: a.username ? 8 : 0, color: 'var(--green)' }}>• активний</span>
                    : <span style={{ marginLeft: a.username ? 8 : 0, color: 'var(--yellow)' }}>• очікує /start</span>
                  }
                </div>
              </div>
              <Btn size="sm" variant="danger" onClick={() => delMut.mutate(a.id)}>
                <Trash2 size={11} />
              </Btn>
            </div>
          ))}
        </div>
      )}

      <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Додати по @username
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            placeholder="@username або username"
            value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            style={{ flex: '1 1 130px', minWidth: 120 }}
          />
          <input
            placeholder="Ім'я (необов'язково)"
            value={form.display_name}
            onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
            style={{ flex: '1 1 120px', minWidth: 100 }}
          />
          <Btn
            loading={addMut.isPending}
            disabled={!form.username.trim()}
            onClick={() => addMut.mutate({ username: form.username, display_name: form.display_name || null })}
          >
            <Plus size={13} /> Додати
          </Btn>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
          Щоб дізнатись свій ID — напишіть боту <code>/myid</code>
        </p>
      </div>
    </div>
  )
}

function AddUserModal({ open, onClose, onSuccess }) {
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' })
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    try { await createUser(form); toast.success('Користувача створено'); onSuccess(); setForm({ username: '', password: '', role: 'viewer' }) }
    catch (e) { toast.error(e.response?.data?.detail || 'Помилка') }
    finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Новий користувач">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Логін"><input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="username" /></Field>
        <Field label="Пароль"><input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••••" /></Field>
        <Field label="Роль">
          <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="viewer">Viewer — тільки перегляд</option>
            <option value="admin">Admin — повний доступ</option>
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!form.username || !form.password} onClick={submit}><Plus size={13} /> Створити</Btn>
        </div>
      </div>
    </Modal>
  )
}
