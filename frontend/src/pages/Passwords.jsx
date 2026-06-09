import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { saveAs } from 'file-saver'
import {
  Plus, Upload, Download, Trash2, Lock, Unlock, ShieldCheck, Share2,
  KeyRound, Eye, EyeOff, Copy, FolderPlus, Folder,
  ArrowLeft, Save, Search, Edit3, RefreshCw,
} from 'lucide-react'

import {
  getVaults, uploadVault, downloadVaultBlob, updateVaultBlob, renameVault, deleteVault,
  shareVault, unshareVault, getUsers,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'
import {
  openKdbx, createBlankKdbx, saveKdbx,
  listGroups, listEntries, getField,
  createEntry, updateEntry, deleteEntry,
  createGroup, renameGroup, deleteGroup, generatePassword,
} from '../services/kdbx'

export default function PasswordsPage() {
  const [openVault, setOpenVault] = useState(null) // { meta, db, masterPwd }
  if (openVault) return <VaultEditor vault={openVault} onClose={() => setOpenVault(null)} />
  return <VaultList onOpen={setOpenVault} />
}

// ── Vault list ──────────────────────────────────────────────────────────

function VaultList({ onOpen }) {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [uploadModal, setUploadModal] = useState(false)
  const [createModal, setCreateModal] = useState(false)
  const [openModal, setOpenModal] = useState(null) // vault meta to prompt password
  const [shareModal, setShareModal] = useState(null)

  const { data: vaults = [], isLoading } = useQuery({
    queryKey: ['vaults'],
    queryFn: () => getVaults().then(r => r.data),
  })

  const delMut = useMutation({
    mutationFn: deleteVault,
    onSuccess: () => { toast.success('Сейф видалено'); qc.invalidateQueries(['vaults']) },
  })

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <ShieldCheck size={22} style={{ color: 'var(--accent)' }} /> Паролі
          </h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            KeePass-сумісні сейфи. Шифрування у браузері — мастер-пароль ніколи не йде на сервер.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="ghost" onClick={() => setUploadModal(true)}><Upload size={14} /> Завантажити .kdbx</Btn>
          <Btn onClick={() => setCreateModal(true)}><Plus size={14} /> Новий сейф</Btn>
        </div>
      </div>

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, flex: 1, overflowY: 'auto', padding: 8 }}>
        {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
          : vaults.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)', fontSize: 13 }}>
              Немає сейфів. Створіть новий або завантажте .kdbx.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10, padding: 8 }}>
              {vaults.map(v => (
                <VaultCard key={v.id} vault={v}
                  onOpen={() => setOpenModal(v)}
                  onShare={() => setShareModal(v)}
                  onDelete={() => gateDelete(() => delMut.mutateAsync(v.id)).catch(() => {})}
                />
              ))}
            </div>
          )
        }
      </div>

      <UploadVaultModal open={uploadModal} onClose={() => setUploadModal(false)} onDone={() => qc.invalidateQueries(['vaults'])} />
      <CreateVaultModal open={createModal} onClose={() => setCreateModal(false)} onDone={() => qc.invalidateQueries(['vaults'])} />
      <OpenVaultModal vault={openModal} onClose={() => setOpenModal(null)} onOpened={onOpen} />
      <ShareModal vault={shareModal} onClose={() => setShareModal(null)} onChanged={() => qc.invalidateQueries(['vaults'])} />
    </div>
  )
}

function VaultCard({ vault, onOpen, onShare, onDelete }) {
  return (
    <div onClick={onOpen} style={{
      background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'all 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Lock size={17} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          {vault.is_owner && (
            <button onClick={onShare} title="Поділитися"
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
            ><Share2 size={13} /></button>
          )}
          {vault.is_owner && (
            <button onClick={onDelete} title="Видалити"
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
            ><Trash2 size={13} /></button>
          )}
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {vault.name}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {!vault.is_owner && <Badge color="blue">Спільний від {vault.owner_username}</Badge>}
        {!vault.can_edit && !vault.is_owner && <Badge color="default">Read-only</Badge>}
        {vault.shared_with?.length > 0 && vault.is_owner && (
          <Badge color="default">{vault.shared_with.length} спільних</Badge>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        {(vault.size_bytes / 1024).toFixed(1)} KB · {vault.updated_at ? new Date(vault.updated_at).toLocaleString('uk-UA') : '—'}
      </div>
    </div>
  )
}

// ── Modals ──────────────────────────────────────────────────────────────

function UploadVaultModal({ open, onClose, onDone }) {
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (open) { setName(''); setFile(null) } }, [open])

  async function submit() {
    if (!file || !name.trim()) return
    setLoading(true)
    try { await uploadVault(name.trim(), file); toast.success('Сейф завантажено'); onDone(); onClose() }
    catch (e) { toast.error('Помилка: ' + (e.response?.data?.detail || e.message)) }
    finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Завантажити .kdbx">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва сейфа">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Робочі акаунти" />
        </Field>
        <Field label="Файл .kdbx">
          <input type="file" accept=".kdbx" onChange={e => setFile(e.target.files?.[0] || null)} />
        </Field>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
          Файл уже зашифрований мастер-паролем. Сервер зберігає його як є.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!file || !name.trim()} onClick={submit}><Upload size={14} /> Завантажити</Btn>
        </div>
      </div>
    </Modal>
  )
}

function CreateVaultModal({ open, onClose, onDone }) {
  const [name, setName] = useState('')
  const [pwd, setPwd] = useState('')
  const [pwd2, setPwd2] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (open) { setName(''); setPwd(''); setPwd2('') } }, [open])

  async function submit() {
    if (pwd !== pwd2) return toast.error('Паролі не співпадають')
    if (pwd.length < 8) return toast.error('Мастер-пароль мінімум 8 символів')
    setLoading(true)
    try {
      const db = await createBlankKdbx(name, pwd)
      const buf = await saveKdbx(db)
      const file = new File([buf], `${name}.kdbx`, { type: 'application/octet-stream' })
      await uploadVault(name.trim(), file)
      toast.success('Сейф створено')
      onDone(); onClose()
    } catch (e) {
      toast.error('Помилка: ' + (e.message || e))
    } finally { setLoading(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Новий сейф">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Назва">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Особисті" />
        </Field>
        <Field label="Мастер-пароль">
          <input type="password" value={pwd} onChange={e => setPwd(e.target.value)} />
        </Field>
        <Field label="Повторіть мастер-пароль">
          <input type="password" value={pwd2} onChange={e => setPwd2(e.target.value)} />
        </Field>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
          Мастер-пароль не відновлюється. Запам'ятайте або збережіть у надійному місці.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!name.trim() || !pwd} onClick={submit}><Plus size={14} /> Створити</Btn>
        </div>
      </div>
    </Modal>
  )
}

function OpenVaultModal({ vault, onClose, onOpened }) {
  const [pwd, setPwd] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (vault) setPwd('') }, [vault])

  async function submit() {
    if (!pwd) return
    setLoading(true)
    try {
      const r = await downloadVaultBlob(vault.id)
      const db = await openKdbx(r.data, pwd)
      onOpened({ meta: vault, db, masterPwd: pwd })
      onClose()
    } catch (e) {
      toast.error('Невірний пароль або пошкоджений файл')
    } finally { setLoading(false) }
  }

  return (
    <Modal open={!!vault} onClose={onClose} title={vault ? `Відкрити: ${vault.name}` : ''}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Мастер-пароль">
          <input autoFocus type="password" value={pwd} onChange={e => setPwd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} disabled={!pwd} onClick={submit}><Unlock size={14} /> Відкрити</Btn>
        </div>
      </div>
    </Modal>
  )
}

function ShareModal({ vault, onClose, onChanged }) {
  const { data: users = [] } = useQuery({
    queryKey: ['users'], queryFn: () => getUsers().then(r => r.data),
    enabled: !!vault,
  })
  const [userId, setUserId] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(false)

  async function add() {
    if (!userId) return
    setLoading(true)
    try { await shareVault(vault.id, parseInt(userId), canEdit); onChanged(); setUserId('') }
    catch { toast.error('Помилка') }
    finally { setLoading(false) }
  }
  async function remove(uid) {
    try { await unshareVault(vault.id, uid); onChanged() } catch { toast.error('Помилка') }
  }

  if (!vault) return null
  const available = users.filter(u => u.id !== vault.owner_user_id && !vault.shared_with.find(s => s.user_id === u.id))

  return (
    <Modal open={!!vault} onClose={onClose} title={`Поділитися: ${vault.name}`} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
          Користувач отримає доступ до зашифрованого файлу. Мастер-пароль передайте через захищений канал (Telegram, Signal).
        </p>

        {vault.shared_with.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {vault.shared_with.map(s => (
              <div key={s.user_id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px', border: '1px solid var(--border)',
              }}>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{s.username}</span>
                <Badge color={s.can_edit ? 'green' : 'default'}>{s.can_edit ? 'Редагування' : 'Тільки читання'}</Badge>
                <Btn size="sm" variant="danger" onClick={() => remove(s.user_id)}><Trash2 size={11} /></Btn>
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Додати користувача">
            <select value={userId} onChange={e => setUserId(e.target.value)}>
              <option value="">— Виберіть —</option>
              {available.map(u => <option key={u.id} value={u.id}>{u.username} ({u.role})</option>)}
            </select>
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={canEdit} onChange={e => setCanEdit(e.target.checked)} style={{ width: 'auto' }} />
            Дозволити редагування
          </label>
          <Btn loading={loading} disabled={!userId} onClick={add}><Share2 size={13} /> Поділитися</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Vault editor ────────────────────────────────────────────────────────

function VaultEditor({ vault, onClose }) {
  const qc = useQueryClient()
  const { meta, db } = vault
  const [version, setVersion] = useState(0)
  const [selectedGroupId, setSelectedGroupId] = useState(null)
  const [selectedEntryId, setSelectedEntryId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const canEdit = meta.can_edit

  const groups = useMemo(() => listGroups(db), [db, version])

  const currentGroup = useMemo(() => {
    if (!selectedGroupId) return groups[0]?.group
    return groups.find(g => g.id === selectedGroupId)?.group || groups[0]?.group
  }, [groups, selectedGroupId])

  const entries = useMemo(() => currentGroup ? listEntries(currentGroup) : [], [currentGroup, version])
  const filteredEntries = useMemo(() => {
    if (!search) return entries
    const q = search.toLowerCase()
    return entries.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q) ||
      e.url.toLowerCase().includes(q)
    )
  }, [entries, search])

  const currentEntry = useMemo(
    () => entries.find(e => e.id === selectedEntryId) || null,
    [entries, selectedEntryId]
  )

  async function save() {
    if (!canEdit) return toast.error('Доступ тільки для читання')
    setSaving(true)
    try {
      const buf = await saveKdbx(db)
      const file = new File([buf], `${meta.name}.kdbx`, { type: 'application/octet-stream' })
      await updateVaultBlob(meta.id, file)
      setDirty(false)
      qc.invalidateQueries(['vaults'])
      toast.success('Збережено')
    } catch (e) {
      toast.error('Помилка збереження: ' + (e.message || e))
    } finally { setSaving(false) }
  }

  async function downloadFile() {
    const buf = await saveKdbx(db)
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), `${meta.name}.kdbx`)
  }

  function handleClose() {
    if (dirty && !window.confirm('Є незбережені зміни. Точно вийти?')) return
    onClose()
  }

  // Cmd/Ctrl+S
  useEffect(() => {
    const h = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [db, dirty])

  useEffect(() => {
    const h = e => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  function mark() { setDirty(true); setVersion(v => v + 1) }

  // Group ops
  const [renameGroupId, setRenameGroupId] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  function addGroupAction() {
    const name = prompt('Назва нової групи')
    if (!name) return
    createGroup(db, currentGroup || db.getDefaultGroup(), name)
    mark()
  }

  function deleteGroupAction(g) {
    if (g === db.getDefaultGroup()) return toast.error('Не можна видалити кореневу групу')
    if (!window.confirm(`Видалити групу "${g.name}" з усіма записами?`)) return
    deleteGroup(db, g)
    setSelectedGroupId(null)
    mark()
  }

  function startRename(g) { setRenameGroupId(g.uuid.id); setRenameValue(g.name) }
  function commitRename(g) {
    if (renameValue.trim()) { renameGroup(g, renameValue.trim()); mark() }
    setRenameGroupId(null)
  }

  // Entry ops
  const [entryModal, setEntryModal] = useState(null) // {mode:'new'|'edit', entry?}

  function newEntry() {
    if (!canEdit) return
    setEntryModal({ mode: 'new' })
  }
  function editEntry(e) { setEntryModal({ mode: 'edit', entry: e.entry, view: e }) }

  function deleteEntryAction(e) {
    if (!canEdit) return
    if (!window.confirm(`Видалити запис "${e.title}"?`)) return
    deleteEntry(db, e.entry)
    setSelectedEntryId(null)
    mark()
  }

  function saveEntry(values) {
    if (entryModal.mode === 'new') {
      createEntry(db, currentGroup, values)
    } else {
      updateEntry(entryModal.entry, values)
    }
    setEntryModal(null)
    mark()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0,
      }}>
        <Btn size="sm" variant="ghost" onClick={handleClose}><ArrowLeft size={13} /> Назад</Btn>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={16} style={{ color: 'var(--green)' }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>{meta.name}</span>
          {!canEdit && <Badge color="default">Read-only</Badge>}
        </div>
        {dirty && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>● незбережено</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Btn size="sm" variant="ghost" onClick={downloadFile}><Download size={13} /> Завантажити .kdbx</Btn>
          {canEdit && (
            <Btn size="sm" loading={saving} onClick={save}><Save size={13} /> Зберегти</Btn>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Groups sidebar */}
        <aside style={{ width: 240, borderRight: '1px solid var(--border)', background: 'var(--bg2)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)' }}>Групи</span>
            {canEdit && <button onClick={addGroupAction} title="Нова група" style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer' }}><FolderPlus size={14} /></button>}
          </div>
          <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {groups.map(g => {
              const active = (selectedGroupId ?? groups[0]?.id) === g.id
              return (
                <div key={g.id}
                  onClick={() => { setSelectedGroupId(g.id); setSelectedEntryId(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 8px', paddingLeft: 8 + g.depth * 14,
                    borderRadius: 6, cursor: 'pointer',
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#fff' : 'var(--text2)',
                    fontSize: 13,
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  <Folder size={13} />
                  {renameGroupId === g.id ? (
                    <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(g.group)}
                      onKeyDown={e => { if (e.key === 'Enter') commitRename(g.group); if (e.key === 'Escape') setRenameGroupId(null) }}
                      style={{ flex: 1, padding: '2px 4px', fontSize: 12 }} />
                  ) : (
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                  )}
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{g.entryCount}</span>
                  {canEdit && active && (
                    <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', gap: 2 }}>
                      <button onClick={() => startRename(g.group)} title="Перейменувати"
                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}><Edit3 size={11} /></button>
                      <button onClick={() => deleteGroupAction(g.group)} title="Видалити"
                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}><Trash2 size={11} /></button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        {/* Entries list */}
        <section style={{ width: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук…" style={{ paddingLeft: 28, width: '100%' }} />
            </div>
            {canEdit && <Btn size="sm" onClick={newEntry} title="Новий запис"><Plus size={13} /></Btn>}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredEntries.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Записів немає</div>
            )}
            {filteredEntries.map(e => {
              const active = e.id === selectedEntryId
              return (
                <div key={e.id} onClick={() => setSelectedEntryId(e.id)}
                  style={{
                    padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    border: '1px solid', borderColor: active ? 'rgba(10,132,255,0.35)' : 'transparent',
                  }}
                  onMouseEnter={ev => { if (!active) ev.currentTarget.style.background = 'var(--bg3)' }}
                  onMouseLeave={ev => { if (!active) ev.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || '(без назви)'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.username || '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Entry detail */}
        <section style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {!currentEntry ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', gap: 12 }}>
              <KeyRound size={32} />
              <span style={{ fontSize: 13 }}>Виберіть запис зліва</span>
            </div>
          ) : (
            <EntryDetail entry={currentEntry} canEdit={canEdit}
              onEdit={() => editEntry(currentEntry)}
              onDelete={() => deleteEntryAction(currentEntry)}
            />
          )}
        </section>
      </div>

      <EntryModal modal={entryModal} onClose={() => setEntryModal(null)} onSave={saveEntry} />
    </div>
  )
}

function EntryDetail({ entry, canEdit, onEdit, onDelete }) {
  const [showPwd, setShowPwd] = useState(false)
  const pwd = getField(entry.entry, 'Password')

  function copy(text, label) {
    navigator.clipboard.writeText(text || '')
    toast.success(`${label} скопійовано`)
  }

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <KeyRound size={22} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>{entry.title || '(без назви)'}</h2>
          {entry.url && <a href={entry.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent)' }}>{entry.url}</a>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn size="sm" variant="ghost" onClick={onEdit}><Edit3 size={13} /> Редагувати</Btn>
            <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={13} /></Btn>
          </div>
        )}
      </div>

      <DetailRow label="Логін" value={entry.username} onCopy={() => copy(entry.username, 'Логін')} />
      <DetailRow label="Пароль"
        value={showPwd ? pwd : '••••••••••••'}
        mono
        onCopy={() => copy(pwd, 'Пароль')}
        extra={
          <button onClick={() => setShowPwd(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}>
            {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        }
      />
      <DetailRow label="URL" value={entry.url} onCopy={() => copy(entry.url, 'URL')} />
      {entry.notes && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text3)' }}>Нотатки</span>
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13, whiteSpace: 'pre-wrap' }}>{entry.notes}</div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value, mono, onCopy, extra }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text3)' }}>{label}</span>
      <div style={{
        background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ flex: 1, fontFamily: mono ? 'var(--mono)' : 'var(--font)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || <span style={{ color: 'var(--text3)' }}>—</span>}
        </span>
        {extra}
        {value && (
          <button onClick={onCopy} title="Копіювати"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          ><Copy size={13} /></button>
        )}
      </div>
    </div>
  )
}

function EntryModal({ modal, onClose, onSave }) {
  const [form, setForm] = useState({ title: '', username: '', password: '', url: '', notes: '' })
  const [showPwd, setShowPwd] = useState(false)

  useEffect(() => {
    if (!modal) return
    if (modal.mode === 'edit' && modal.view) {
      setForm({
        title: modal.view.title || '',
        username: modal.view.username || '',
        password: modal.view.password || '',
        url: modal.view.url || '',
        notes: modal.view.notes || '',
      })
    } else {
      setForm({ title: '', username: '', password: '', url: '', notes: '' })
    }
    setShowPwd(false)
  }, [modal])

  if (!modal) return null

  return (
    <Modal open={!!modal} onClose={onClose} title={modal.mode === 'new' ? 'Новий запис' : 'Редагувати запис'} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Назва"><input autoFocus value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Логін"><input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></Field>
        <Field label="Пароль">
          <div style={{ display: 'flex', gap: 6 }}>
            <input type={showPwd ? 'text' : 'password'} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} style={{ flex: 1 }} />
            <Btn size="sm" variant="ghost" onClick={() => setShowPwd(s => !s)} title={showPwd ? 'Сховати' : 'Показати'}>
              {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setForm(f => ({ ...f, password: generatePassword(20) }))} title="Згенерувати">
              <RefreshCw size={13} />
            </Btn>
          </div>
        </Field>
        <Field label="URL"><input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://" /></Field>
        <Field label="Нотатки">
          <textarea rows={4} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn disabled={!form.title.trim()} onClick={() => onSave(form)}><Save size={13} /> Зберегти</Btn>
        </div>
      </div>
    </Modal>
  )
}
