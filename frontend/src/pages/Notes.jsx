import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Pin, PinOff, Search, X, StickyNote, Save, Tag, Clock,
} from 'lucide-react'

import { getNotes, createNote, updateNote, deleteNote } from '../api/client'
import { Btn, Spinner, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

// Apple-style soft pastel colors
const NOTE_COLORS = [
  { value: '',         label: 'Стандартний',  bg: 'var(--bg2)',                                 border: 'var(--border)' },
  { value: '#ffd60a',  label: 'Жовтий',       bg: 'color-mix(in srgb, #ffd60a 14%, var(--bg2))', border: 'rgba(255,214,10,0.4)' },
  { value: '#ff9f0a',  label: 'Помаранчевий', bg: 'color-mix(in srgb, #ff9f0a 14%, var(--bg2))', border: 'rgba(255,159,10,0.4)' },
  { value: '#ff453a',  label: 'Червоний',     bg: 'color-mix(in srgb, #ff453a 14%, var(--bg2))', border: 'rgba(255,69,58,0.4)' },
  { value: '#bf5af2',  label: 'Фіолетовий',   bg: 'color-mix(in srgb, #bf5af2 14%, var(--bg2))', border: 'rgba(191,90,242,0.4)' },
  { value: '#0a84ff',  label: 'Синій',        bg: 'color-mix(in srgb, #0a84ff 14%, var(--bg2))', border: 'rgba(10,132,255,0.4)' },
  { value: '#30d158',  label: 'Зелений',      bg: 'color-mix(in srgb, #30d158 14%, var(--bg2))', border: 'rgba(48,209,88,0.4)' },
  { value: '#64d2ff',  label: 'Блакитний',    bg: 'color-mix(in srgb, #64d2ff 14%, var(--bg2))', border: 'rgba(100,210,255,0.4)' },
]
const colorStyle = (value) => NOTE_COLORS.find(c => c.value === value) || NOTE_COLORS[0]

export default function NotesPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState(null)

  // Debounced server search for big collections; client filter is also fine
  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['notes', search],
    queryFn: () => getNotes(search).then(r => r.data),
  })

  const active = useMemo(() => notes.find(n => n.id === activeId), [notes, activeId])

  const createMut = useMutation({
    mutationFn: createNote,
    onSuccess: (r) => { qc.invalidateQueries(['notes']); setActiveId(r.data.id) },
  })
  const delMut = useMutation({
    mutationFn: deleteNote,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['notes']); setActiveId(null) },
  })
  const pinMut = useMutation({
    mutationFn: ({ id, pinned }) => updateNote(id, { pinned }),
    onSuccess: () => qc.invalidateQueries(['notes']),
  })

  function newNote() {
    createMut.mutate({ title: '', body: '', color: '' })
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside style={{
        width: 300, flexShrink: 0,
        background: 'var(--bg2)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <StickyNote size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Нотатки</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{notes.length}</span>
        </div>
        <div style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
          <Btn size="sm" onClick={newNote} loading={createMut.isPending} style={{ flex: 1, justifyContent: 'center' }}>
            <Plus size={12} /> Нова
          </Btn>
        </div>
        <div style={{ padding: '0 10px 8px', position: 'relative' }}>
          <Search size={11} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Пошук по нотатках…"
            style={{ paddingLeft: 26, fontSize: 12, height: 28 }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 2 }}>
              <X size={11} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
            : notes.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                {search ? 'Нічого не знайдено' : 'Створіть першу нотатку'}
              </div>
            ) : notes.map(n => (
              <NoteRow key={n.id} note={n}
                active={n.id === activeId}
                onClick={() => setActiveId(n.id)}
                onTogglePin={() => pinMut.mutate({ id: n.id, pinned: !n.pinned })}
              />
            ))
          }
        </div>
      </aside>

      {/* Editor */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {active
          ? <NoteEditor key={active.id} note={active}
              onDelete={() => gateDelete(() => delMut.mutateAsync(active.id)).catch(() => {})}
            />
          : <EmptyEditor onCreate={newNote} loading={createMut.isPending} />}
      </main>
    </div>
  )
}

function NoteRow({ note, active, onClick, onTogglePin }) {
  const c = colorStyle(note.color)
  const preview = (note.body || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const date = note.updated_at || note.created_at

  return (
    <div onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
      background: active ? c.bg : 'transparent',
      border: '1px solid', borderColor: active ? c.border : 'transparent',
      transition: 'all 0.12s', position: 'relative',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {/* Color accent stripe on the left */}
      {note.color && (
        <span style={{
          position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2,
          background: note.color,
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: note.color ? 8 : 0 }}>
        <span style={{
          flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {note.title || preview.slice(0, 40) || '(без назви)'}
        </span>
        {note.pinned && (
          <button onClick={e => { e.stopPropagation(); onTogglePin() }} title="Відкріпити"
            style={{ background: 'none', border: 'none', color: 'var(--yellow)', cursor: 'pointer', padding: 0 }}>
            <Pin size={11} fill="currentColor" />
          </button>
        )}
      </div>
      {(preview || date) && (
        <div style={{ fontSize: 11, color: 'var(--text3)', paddingLeft: note.color ? 8 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview || '—'}
        </div>
      )}
      {note.tags && (
        <div style={{ fontSize: 10, color: 'var(--text3)', paddingLeft: note.color ? 8 : 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Tag size={9} /> {note.tags}
        </div>
      )}
    </div>
  )
}

function EmptyEditor({ onCreate, loading }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text3)' }}>
      <StickyNote size={48} style={{ opacity: 0.4 }} />
      <span style={{ fontSize: 13 }}>Оберіть нотатку зліва або створіть нову</span>
      <Btn onClick={onCreate} loading={loading}><Plus size={14} /> Створити</Btn>
    </div>
  )
}

function NoteEditor({ note, onDelete }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(note.title || '')
  const [body, setBody] = useState(note.body || '')
  const [color, setColor] = useState(note.color || '')
  const [tags, setTags] = useState(note.tags || '')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const initial = useRef({ title: note.title || '', body: note.body || '', color: note.color || '', tags: note.tags || '' })

  // Auto-save with debounce
  useEffect(() => {
    initial.current = { title: note.title || '', body: note.body || '', color: note.color || '', tags: note.tags || '' }
    setTitle(note.title || ''); setBody(note.body || ''); setColor(note.color || ''); setTags(note.tags || '')
    setSavedAt(null)
  }, [note.id])

  useEffect(() => {
    const cur = { title, body, color, tags }
    const dirty = Object.keys(cur).some(k => cur[k] !== initial.current[k])
    if (!dirty) return

    const t = setTimeout(async () => {
      setSaving(true)
      try {
        await updateNote(note.id, { title, body, color, tags })
        initial.current = { ...cur }
        setSavedAt(new Date())
        qc.invalidateQueries(['notes'])
      } catch (e) {
        toast.error('Помилка збереження')
      } finally { setSaving(false) }
    }, 600)
    return () => clearTimeout(t)
  }, [title, body, color, tags, note.id, qc])

  const c = colorStyle(color)

  async function togglePin() {
    try {
      await updateNote(note.id, { pinned: !note.pinned })
      qc.invalidateQueries(['notes'])
    } catch { toast.error('Помилка') }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: c.bg, transition: 'background 0.2s' }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 20px', borderBottom: '1px solid', borderColor: c.border,
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      }}>
        <div style={{ flex: 1, fontSize: 11, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Clock size={11} />
          {saving ? 'Збереження…'
            : savedAt ? `Збережено ${savedAt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`
            : note.updated_at ? `Останнє: ${new Date(note.updated_at).toLocaleString('uk-UA')}`
            : 'Нова'}
        </div>

        {/* Color picker pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {NOTE_COLORS.map(c => (
            <button key={c.value} onClick={() => setColor(c.value)} title={c.label}
              style={{
                width: 18, height: 18, borderRadius: '50%',
                background: c.value || 'transparent',
                border: '2px solid', borderColor: color === c.value ? 'var(--text)' : c.value || 'var(--border)',
                cursor: 'pointer', padding: 0,
              }} />
          ))}
        </div>

        <Btn size="sm" variant="ghost" onClick={togglePin}>
          {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
          {note.pinned ? 'Відкріпити' : 'Закріпити'}
        </Btn>
        <Btn size="sm" variant="danger" onClick={onDelete}><Trash2 size={11} /></Btn>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Назва"
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              fontSize: 28, fontWeight: 800, color: 'var(--text)',
              padding: 0, fontFamily: 'var(--font)',
            }}
          />
          <input
            value={tags} onChange={e => setTags(e.target.value)}
            placeholder="Теги (через кому)"
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--text3)', padding: 0,
              fontFamily: 'var(--font)',
            }}
          />
          <textarea
            value={body} onChange={e => setBody(e.target.value)}
            placeholder="Напишіть що-небудь…"
            style={{
              background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              fontSize: 14, lineHeight: 1.7, color: 'var(--text)',
              fontFamily: 'var(--font)', padding: 0, minHeight: 400,
            }}
          />
        </div>
      </div>
    </div>
  )
}
