import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Server, Plus, Trash2, Terminal as TermIcon, Globe, Wifi, X, Edit3,
  ChevronRight, Info, AlertTriangle, Loader, CheckCircle2, Circle,
  FolderTree, Folder, FolderPlus, File as FileIcon, Upload, Download,
  ArrowUp, RefreshCw, Pencil, Copy, Eye, EyeOff, Search,
} from 'lucide-react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

import api from '../api/client'
import { Btn, Modal, Spinner, Field } from '../components/ui/index'
import { useAuthStore } from '../store/auth'


// ─── Hooks ──────────────────────────────────────────────────────────────

const useServers = () => useQuery({
  queryKey: ['servers'],
  queryFn: () => api.get('/servers').then(r => r.data),
})
const useProxies = () => useQuery({
  queryKey: ['proxies'],
  queryFn: () => api.get('/proxies').then(r => r.data),
})


// ─── Form modal ─────────────────────────────────────────────────────────

function ServerFormModal({ open, onClose, editing }) {
  const qc = useQueryClient()
  const { data: proxies = [] } = useProxies()
  const [form, setForm] = useState({})

  useEffect(() => {
    if (editing) {
      setForm({
        label: editing.label || '', host: editing.host || '',
        port: editing.port || 22, username: editing.username || 'root',
        auth_kind: editing.auth_kind || 'password',
        password: '', private_key: '',
        proxy_id: editing.proxy_id ? String(editing.proxy_id) : '',
        web_url: editing.web_url || '', tags: editing.tags || '',
        notes: editing.notes || '',
      })
    } else {
      setForm({
        label: '', host: '', port: 22, username: 'root',
        auth_kind: 'password', password: '', private_key: '',
        proxy_id: '', web_url: '', tags: '', notes: '',
      })
    }
  }, [editing, open])

  const save = useMutation({
    mutationFn: async () => {
      const payload = { ...form, port: Number(form.port) || 22 }
      payload.proxy_id = form.proxy_id ? Number(form.proxy_id) : null
      if (!payload.password) delete payload.password
      if (!payload.private_key) delete payload.private_key
      if (editing) return (await api.patch(`/servers/${editing.id}`, payload)).data
      return (await api.post('/servers', payload)).data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] })
      toast.success(editing ? 'Сервер оновлено' : 'Сервер додано')
      onClose()
    },
    onError: e => toast.error(e?.response?.data?.detail || 'Помилка'),
  })

  if (!open) return null
  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Редагувати сервер' : 'Додати сервер'}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
        <Field label="Назва">
          <input value={form.label || ''} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="prod-web-1" />
        </Field>
        <Field label="Тег(и)">
          <input value={form.tags || ''} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="prod, eu" />
        </Field>
        <Field label="Host / IP">
          <input value={form.host || ''} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="1.2.3.4" />
        </Field>
        <Field label="Port">
          <input type="number" value={form.port || 22} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} />
        </Field>
        <Field label="Користувач">
          <input value={form.username || ''} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
        </Field>
        <Field label="Тип авторизації">
          <select value={form.auth_kind || 'password'} onChange={e => setForm(f => ({ ...f, auth_kind: e.target.value }))}>
            <option value="password">Пароль</option>
            <option value="key">Приватний ключ</option>
          </select>
        </Field>
        {form.auth_kind === 'password' ? (
          <Field label={editing ? 'Новий пароль (пусто = без змін)' : 'Пароль'} style={{ gridColumn: '1 / -1' }}>
            <input type="password" value={form.password || ''} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          </Field>
        ) : (
          <Field label={editing ? 'Новий ключ (PEM)' : 'Приватний ключ (PEM)'} style={{ gridColumn: '1 / -1' }}>
            <textarea rows={5} value={form.private_key || ''} onChange={e => setForm(f => ({ ...f, private_key: e.target.value }))}
              style={{ fontFamily: 'var(--mono)', fontSize: 11 }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </Field>
        )}
        <Field label="Проксі (опційно — для SSH і Web-тунелю)" style={{ gridColumn: '1 / -1' }}>
          <select value={form.proxy_id || ''} onChange={e => setForm(f => ({ ...f, proxy_id: e.target.value }))}>
            <option value="">— без проксі (прямий вихід) —</option>
            {proxies.map(p => (
              <option key={p.id} value={p.id}>{p.label || `${p.host}:${p.port}`} ({p.type})</option>
            ))}
          </select>
        </Field>
        <Field label="Web-панель URL">
          <input value={form.web_url || ''} onChange={e => setForm(f => ({ ...f, web_url: e.target.value }))} placeholder="https://1.2.3.4:9090" />
        </Field>
        <Field label="Нотатки">
          <textarea rows={3} value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Btn onClick={onClose}>Скасувати</Btn>
        <Btn variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !form.host || !form.label}>
          {save.isPending ? <Spinner size={14} /> : 'Зберегти'}
        </Btn>
      </div>
    </Modal>
  )
}


// ─── Inline SSH terminal (persistent xterm tied to server.id) ───────────

function InlineTerminal({ server }) {
  const containerRef = useRef(null)
  const wsRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const { token } = useAuthStore()
  const [status, setStatus] = useState('connecting')
  const [errorText, setErrorText] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      fontSize: 13, lineHeight: 1.25,
      theme: {
        background: '#0a0e16', foreground: '#e7ecf3', cursor: '#7da3ff',
        cursorAccent: '#0a0e16', selectionBackground: '#2d3a55',
        black: '#0a0e16', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#7da3ff', magenta: '#c084fc', cyan: '#22d3ee', white: '#cbd5e1',
        brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fde68a', brightBlue: '#a5b4fc', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#f1f5f9',
      },
      cursorBlink: true, convertEol: true, scrollback: 8000, allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // Initial sizing — delay so the layout is final
    requestAnimationFrame(() => { try { fit.fit() } catch {} })
    termRef.current = term
    fitRef.current = fit

    term.write(`\x1b[2J\x1b[H\x1b[36m▌ ${server.label}\x1b[0m\r\n`)
    term.write(`\x1b[90m  Підключення до ${server.username}@${server.host}:${server.port}`)
    if (server.proxy_id) term.write(`  через проксі #${server.proxy_id}`)
    term.write(` …\x1b[0m\r\n\r\n`)

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/servers/ws/${server.id}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('ready')
      try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch {}
    }
    ws.onmessage = ev => {
      const d = ev.data
      if (typeof d === 'string' && d.length > 1 && d[0] === '{' && d.indexOf('"type"') > 0) {
        try {
          const j = JSON.parse(d)
          if (j.type === 'closed') {
            setStatus('error')
            const msg = j.error || 'сесію закрито'
            setErrorText(msg)
            term.write(`\r\n\x1b[31m✘ ${msg}\x1b[0m\r\n`)
            return
          }
        } catch {}
      }
      term.write(d)
    }
    ws.onerror = () => { setStatus('error'); setErrorText('WebSocket помилка') }
    ws.onclose = () => setStatus(s => s === 'connecting' ? 'error' : s === 'ready' ? 'closed' : s)

    term.onData(data => {
      if (ws.readyState === 1) ws.send(data)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch {}
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      setTimeout(() => {
        try { ws.close() } catch {}
        try { term.dispose() } catch {}
      }, 60)
    }
  }, [server.id, reloadKey])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', borderBottom: '1px solid var(--border)',
        background: '#0a0e16', flexShrink: 0,
      }}>
        <TermIcon size={14} color="#7da3ff" />
        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
          {server.username}@{server.host}:{server.port}
        </div>
        <StatusBadge status={status} />
        <div style={{ flex: 1 }} />
        {status === 'error' && (
          <button onClick={() => { setErrorText(null); setStatus('connecting'); setReloadKey(k => k + 1) }}
            style={{ background: 'rgba(125,163,255,0.12)', border: '1px solid #7da3ff', color: '#7da3ff',
              padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
            Перепідключити
          </button>
        )}
      </div>
      <div ref={containerRef} style={{ flex: 1, padding: 8, background: '#0a0e16', minHeight: 0, overflow: 'hidden' }} />
      {errorText && status === 'error' && (
        <div style={{
          padding: '8px 14px', background: 'rgba(248,113,113,0.08)',
          borderTop: '1px solid rgba(248,113,113,0.3)', fontSize: 11, color: '#fca5a5',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={12} />
          <span style={{ flex: 1 }}>{errorText}</span>
          {!server.proxy_id && /тайм-аут|timeout|unreachable/i.test(errorText) && (
            <span style={{ color: '#fbbf24' }}>↳ Можна спробувати через SOCKS5-проксі</span>
          )}
        </div>
      )}
    </div>
  )
}


// ─── Inline SFTP file browser ──────────────────────────────────────────

function joinPath(dir, name) {
  if (!dir || dir === '/') return '/' + name
  return dir.replace(/\/+$/, '') + '/' + name
}
function parentPath(p) {
  if (!p || p === '/') return '/'
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i)
}
function fmtSize(n) {
  if (!n) return '—'
  const u = ['B', 'K', 'M', 'G', 'T']
  let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? v : v.toFixed(1)) + u[i]
}

function InlineSftp({ server }) {
  const [path, setPath] = useState('')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [inputPath, setInputPath] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState(null) // { name, done, total } | null
  const fileInputRef = useRef(null)
  const dragDepth = useRef(0)
  const { token } = useAuthStore()

  async function load(p) {
    setBusy(true); setErr(null)
    try {
      const r = await api.get(`/servers/${server.id}/sftp/ls`, { params: { path: p || '' } })
      setData(r.data); setPath(r.data.path); setInputPath(r.data.path)
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Помилка')
    } finally { setBusy(false) }
  }

  useEffect(() => { load('') }, [server.id])

  function go(p) { load(p) }

  async function uploadOne(file, targetDir, relName) {
    const fd = new FormData()
    fd.append('path', targetDir)
    fd.append('file', file, relName || file.name)
    await api.post(`/servers/${server.id}/sftp/upload`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return
    setBusy(true)
    let ok = 0; let fail = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setProgress({ name: f.name, done: i, total: files.length })
      try { await uploadOne(f, path); ok++ }
      catch (e) {
        fail++
        toast.error(`${f.name}: ${e?.response?.data?.detail || 'помилка'}`)
      }
    }
    setProgress(null); setBusy(false)
    if (ok) toast.success(`Завантажено: ${ok}${fail ? ` (помилок: ${fail})` : ''}`)
    load(path)
  }

  // Recursively walk a webkitGetAsEntry tree, creating dirs and uploading files.
  async function walkEntry(entry, parentRemote, flat) {
    if (entry.isFile) {
      await new Promise((resolve, reject) => entry.file(
        f => { flat.push({ file: f, dir: parentRemote, name: f.name }); resolve() },
        reject,
      ))
    } else if (entry.isDirectory) {
      const remoteDir = joinPath(parentRemote, entry.name)
      try { await api.post(`/servers/${server.id}/sftp/mkdir`, { path: remoteDir }) }
      catch (_) { /* may already exist — ignore */ }
      const reader = entry.createReader()
      // readEntries returns in chunks until empty
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const child of batch) await walkEntry(child, remoteDir, flat)
      }
    }
  }

  async function handleDrop(e) {
    e.preventDefault(); e.stopPropagation()
    setDragOver(false); dragDepth.current = 0
    const items = e.dataTransfer?.items
    const flat = [] // { file, dir, name }
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (const it of items) {
        const entry = it.webkitGetAsEntry?.()
        if (entry) await walkEntry(entry, path, flat)
        else if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f) flat.push({ file: f, dir: path, name: f.name })
        }
      }
    } else {
      for (const f of e.dataTransfer?.files || []) {
        flat.push({ file: f, dir: path, name: f.name })
      }
    }
    if (!flat.length) return
    setBusy(true)
    let ok = 0; let fail = 0
    for (let i = 0; i < flat.length; i++) {
      const { file, dir, name } = flat[i]
      setProgress({ name: name, done: i, total: flat.length })
      try { await uploadOne(file, dir, name); ok++ }
      catch (e) {
        fail++
        toast.error(`${name}: ${e?.response?.data?.detail || 'помилка'}`)
      }
    }
    setProgress(null); setBusy(false)
    if (ok) toast.success(`Завантажено: ${ok}${fail ? ` (помилок: ${fail})` : ''}`)
    load(path)
  }

  function onDragEnter(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepth.current++
    setDragOver(true)
  }
  function onDragLeave(e) {
    dragDepth.current--
    if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false) }
  }
  function onDragOver(e) {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  async function onUpload(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) await uploadFiles(files)
  }

  async function onMkdir() {
    const name = prompt('Назва нової папки:')
    if (!name) return
    try {
      await api.post(`/servers/${server.id}/sftp/mkdir`, { path: joinPath(path, name) })
      load(path)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка mkdir')
    }
  }

  async function onDelete(entry) {
    if (!confirm(`Видалити ${entry.name}${entry.is_dir ? ' (рекурсивно)' : ''}?`)) return
    try {
      await api.delete(`/servers/${server.id}/sftp/rm`, {
        params: { path: joinPath(path, entry.name), recursive: entry.is_dir },
      })
      load(path)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка видалення')
    }
  }

  async function onRename(entry) {
    const next = prompt('Нова назва:', entry.name)
    if (!next || next === entry.name) return
    try {
      await api.post(`/servers/${server.id}/sftp/rename`, {
        src: joinPath(path, entry.name),
        dst: joinPath(path, next),
      })
      load(path)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка перейменування')
    }
  }

  async function onDownload(entry) {
    const full = joinPath(path, entry.name)
    try {
      const r = await api.get(`/servers/${server.id}/sftp/download`, {
        params: { path: full }, responseType: 'blob',
      })
      const url = URL.createObjectURL(r.data)
      const a = document.createElement('a')
      a.href = url; a.download = entry.name
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Помилка скачування')
    }
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={handleDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none',
          background: 'rgba(125,163,255,0.10)',
          border: '2px dashed #7da3ff',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#7da3ff', fontSize: 14, fontWeight: 600,
        }}>
          <Upload size={22} style={{ marginRight: 10 }} />
          Кинь сюди — завантажу в <span style={{ fontFamily: 'var(--mono)', marginLeft: 6 }}>{path || '~'}</span>
        </div>
      )}
      {progress && (
        <div style={{
          position: 'absolute', bottom: 10, right: 10, zIndex: 11,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, color: 'var(--text2)', minWidth: 220,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Loader size={12} className="spin" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress.name}</span>
          </div>
          <div style={{ color: 'var(--text3)' }}>{progress.done + 1} / {progress.total}</div>
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <FolderTree size={14} color="#7da3ff" />
        <button onClick={() => go(parentPath(path))} disabled={!path || path === '/'}
          title="Вгору" style={iconBtnStyle}>
          <ArrowUp size={13} />
        </button>
        <button onClick={() => load(path)} title="Оновити" style={iconBtnStyle}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} />
        </button>
        <input
          value={inputPath}
          onChange={e => setInputPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(inputPath) }}
          placeholder="/path"
          style={{
            flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)',
          }}
        />
        <button onClick={onMkdir} title="Нова папка" style={iconBtnStyle}>
          <FolderPlus size={13} />
        </button>
        <button onClick={() => fileInputRef.current?.click()} title="Завантажити файл" style={iconBtnStyle}>
          <Upload size={13} />
        </button>
        <input ref={fileInputRef} type="file" multiple onChange={onUpload} style={{ display: 'none' }} />
      </div>

      {err ? (
        <div style={{ padding: 20, color: '#fca5a5', fontSize: 13 }}>
          <AlertTriangle size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          {err}
        </div>
      ) : !data ? (
        <div style={{ padding: 20 }}><Spinner /></div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, fontFamily: 'var(--mono)' }}>
          {data.entries.length === 0 && (
            <div style={{ padding: 20, color: 'var(--text3)', textAlign: 'center' }}>порожньо</div>
          )}
          {data.entries.map(en => (
            <div key={en.name}
              onDoubleClick={() => en.is_dir && go(joinPath(path, en.name))}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr 90px 160px auto',
                gap: 10, alignItems: 'center',
                padding: '6px 12px', borderBottom: '1px solid var(--border)',
                cursor: en.is_dir ? 'pointer' : 'default',
              }}>
              {en.is_dir
                ? <Folder size={14} color="#7da3ff" />
                : <FileIcon size={14} color="var(--text3)" />}
              <span
                onClick={() => en.is_dir && go(joinPath(path, en.name))}
                style={{ color: en.is_dir ? 'var(--text)' : 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {en.name}{en.is_link ? ' →' : ''}
              </span>
              <span style={{ color: 'var(--text3)', textAlign: 'right' }}>
                {en.is_dir ? '' : fmtSize(en.size)}
              </span>
              <span style={{ color: 'var(--text3)' }}>
                {en.mtime ? new Date(en.mtime * 1000).toLocaleString('uk-UA') : ''}
              </span>
              <span style={{ display: 'flex', gap: 4 }}>
                {!en.is_dir && (
                  <button onClick={() => onDownload(en)} title="Скачати" style={iconBtnStyle}>
                    <Download size={12} />
                  </button>
                )}
                <button onClick={() => onRename(en)} title="Перейменувати" style={iconBtnStyle}>
                  <Pencil size={12} />
                </button>
                <button onClick={() => onDelete(en)} title="Видалити" style={{ ...iconBtnStyle, color: '#f87171' }}>
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const iconBtnStyle = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text2)', cursor: 'pointer', padding: '4px 6px',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}


// ─── Inline Web panel (iframe via grant cookie) ────────────────────────

function InlineWebPanel({ server }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    setUrl(null); setErr(null)
    api.post(`/servers/${server.id}/web-grant`)
      .then(r => setUrl(r.data.url))
      .catch(e => setErr(e?.response?.data?.detail || 'Помилка'))
  }, [server.id])

  if (err) return (
    <div style={{ padding: 20, color: '#fca5a5', fontSize: 13 }}>
      <AlertTriangle size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
      {err}
    </div>
  )
  if (!url) return <div style={{ padding: 20 }}><Spinner /></div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <Globe size={13} color="#4ade80" />
        <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{server.web_url}</div>
        <div style={{ flex: 1 }} />
        <a href={server.web_url} target="_blank" rel="noopener noreferrer"
           style={{ fontSize: 11, color: 'var(--text3)' }}>напряму ↗</a>
      </div>
      <iframe src={url} title={`web-${server.id}`}
        style={{ flex: 1, border: 'none', background: '#fff' }}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
      />
    </div>
  )
}


// ─── Server info panel ──────────────────────────────────────────────────

function InfoPanel({ server, proxies, onEdit, onDelete, onTest, testing }) {
  const proxy = proxies.find(p => p.id === server.proxy_id)
  const { data: linked, isLoading: linkedLoading } = useQuery({
    queryKey: ['server-linked', server.id],
    queryFn: () => api.get(`/servers/${server.id}/linked`).then(r => r.data),
    staleTime: 30_000,
  })
  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: 'linear-gradient(135deg, #7da3ff 0%, #c084fc 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Server size={20} color="#fff" />
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{server.label}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
            {server.username}@{server.host}:{server.port}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Btn onClick={onTest} disabled={testing}>
          {testing ? <Spinner size={12} /> : <Wifi size={13} />} Тест
        </Btn>
        <Btn onClick={onEdit}><Edit3 size={13} /></Btn>
        <Btn variant="danger" onClick={onDelete}><Trash2 size={13} /></Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <InfoCard title="Статус" value={
          server.last_status === 'ok' ? <span style={{ color: '#4ade80' }}>● OK</span>
          : server.last_status === 'error' ? <span style={{ color: '#f87171' }}>● error</span>
          : <span style={{ color: 'var(--text3)' }}>○ не перевірено</span>
        } />
        <InfoCard title="Останній тест" value={server.last_status_at ? new Date(server.last_status_at).toLocaleString('uk-UA') : '—'} />
        <InfoCard title="Проксі" value={proxy ? `${proxy.label || proxy.host} (${proxy.type})` : <span style={{ color: 'var(--text3)' }}>direct (без проксі)</span>} />
        <InfoCard title="Web-панель" value={server.web_url ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{server.web_url}</span> : '—'} />
        <InfoCard title="Тип авторизації" value={server.auth_kind === 'password' ? 'Пароль' : 'SSH-ключ'} />
        <InfoCard title="Теги" value={server.tags || '—'} />
      </div>

      {server.last_error && (() => {
        const isErr = server.last_status === 'error'
        return (
          <div style={{
            padding: 12,
            background: isErr ? 'rgba(248,113,113,0.08)' : 'rgba(74,222,128,0.06)',
            border: `1px solid ${isErr ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.25)'}`,
            borderRadius: 8, fontSize: 12, fontFamily: 'var(--mono)',
            color: isErr ? '#fca5a5' : 'var(--text2)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontFamily: 'var(--font)' }}>
              {isErr ? 'Остання помилка:' : 'Останній вивід:'}
            </div>
            {server.last_error}
          </div>
        )
      })()}

      {/* Linked: domains pointing here + sheet rows mentioning this host */}
      {linkedLoading && <div style={{ fontSize: 11, color: 'var(--text3)' }}><Spinner size={11} /> Шукаємо звʼязки…</div>}
      {linked && linked.domains?.length > 0 && (
        <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Globe size={13} color="#4ade80" /> Прив'язані домени ({linked.domains.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
            {linked.domains.map(d => (
              <div key={d.id} style={{
                padding: '6px 10px', background: 'var(--bg)', borderRadius: 6,
                border: '1px solid var(--border)', fontSize: 12,
              }}>
                <div style={{ fontWeight: 600, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{d.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {d.via} · {d.zone_status || '?'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {linked && linked.sheet_rows?.length > 0 && (
        <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <FileIcon size={13} color="#7da3ff" /> Згадки в таблицях ({linked.sheet_rows.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
            {linked.sheet_rows.map((r, i) => (
              <div key={i} style={{
                padding: '8px 10px', background: 'var(--bg)', borderRadius: 6,
                border: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--mono)',
              }}>
                <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 4, fontFamily: 'var(--font)' }}>
                  {r.sheet_name}{r.tab_name ? ` › ${r.tab_name}` : ''}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                  {Object.entries(r.data).filter(([_, v]) => v).map(([k, v]) => (
                    <RowKV key={k} k={k} v={v} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {server.notes && (
        <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text2)' }}>Нотатки</div>
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text2)' }}>{server.notes}</div>
        </div>
      )}
    </div>
  )
}

function RowKV({ k, v }) {
  const [revealed, setRevealed] = useState(false)
  const looksSecret = /pass|pwd|secret/i.test(k)
  const display = looksSecret && !revealed ? '••••••••' : v
  return (
    <>
      <span style={{ color: 'var(--text3)' }}>{k}:</span>
      <span style={{ color: 'var(--text)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1 }}>{display}</span>
        {looksSecret && (
          <button onClick={() => setRevealed(s => !s)} title={revealed ? 'Сховати' : 'Показати'}
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 2, display: 'inline-flex', alignItems: 'center' }}>
            {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        )}
        <button onClick={() => { navigator.clipboard.writeText(v); toast.success('Скопійовано') }} title="Копіювати"
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 2, display: 'inline-flex', alignItems: 'center' }}>
          <Copy size={11} />
        </button>
      </span>
    </>
  )
}

function InfoCard({ title, value }) {
  return (
    <div style={{ padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13 }}>{value}</div>
    </div>
  )
}


// ─── Status badge ───────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    connecting: { c: '#7da3ff', t: 'підключення', i: <Loader size={10} className="spin" /> },
    ready:      { c: '#4ade80', t: 'активна',     i: <CheckCircle2 size={10} /> },
    closed:     { c: '#94a3b8', t: 'закрито',     i: <Circle size={10} /> },
    error:      { c: '#f87171', t: 'помилка',     i: <AlertTriangle size={10} /> },
  }
  const s = map[status] || map.closed
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: `${s.c}1a`, color: s.c, textTransform: 'uppercase',
    }}>{s.i}{s.t}</div>
  )
}


// ─── Main page ──────────────────────────────────────────────────────────

export default function ServersPage() {
  const { data: servers = [], isLoading } = useServers()
  const { data: proxies = [] } = useProxies()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [tab, setTab] = useState('info')      // info | terminal | sftp | web
  const [openTabs, setOpenTabs] = useState({}) // { [serverId]: { terminal: bool, sftp: bool, web: bool } }
  const [search, setSearch] = useState('')

  // Client-side filter — fields commonly searched for: label, host, username,
  // tags, notes. Case-insensitive substring across all.
  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return servers
    return servers.filter(s =>
      (s.label || '').toLowerCase().includes(q) ||
      (s.host || '').toLowerCase().includes(q) ||
      (s.username || '').toLowerCase().includes(q) ||
      (s.tags || '').toLowerCase().includes(q) ||
      (s.notes || '').toLowerCase().includes(q)
    )
  }, [servers, search])

  useEffect(() => {
    if (!selectedId && servers.length) setSelectedId(servers[0].id)
  }, [servers, selectedId])

  const selected = servers.find(s => s.id === selectedId)
  const testMut = useMutation({
    mutationFn: id => api.post(`/servers/${id}/test`),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ['servers'] })
      r.data.last_status === 'ok' ? toast.success('OK') : toast.error(r.data.last_error || 'Помилка')
    },
  })
  const delMut = useMutation({
    mutationFn: id => api.delete(`/servers/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['servers'] }); setSelectedId(null); toast.success('Видалено') },
  })

  function openTerminal() {
    setOpenTabs(t => ({ ...t, [selectedId]: { ...(t[selectedId] || {}), terminal: true } }))
    setTab('terminal')
  }
  function openWeb() {
    setOpenTabs(t => ({ ...t, [selectedId]: { ...(t[selectedId] || {}), web: true } }))
    setTab('web')
  }
  function openSftp() {
    setOpenTabs(t => ({ ...t, [selectedId]: { ...(t[selectedId] || {}), sftp: true } }))
    setTab('sftp')
  }

  return (
    <>
      <style>{`@keyframes dm-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } } .spin { animation: dm-spin 0.9s linear infinite; }`}</style>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* LEFT: server list */}
        <aside style={{
          width: 280, flexShrink: 0, background: 'var(--bg2)',
          borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)' }}>
            <Server size={16} color="#7da3ff" />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Сервери</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>
              · {search ? `${filteredServers.length}/${servers.length}` : servers.length}
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => { setEditing(null); setAddOpen(true) }} title="Додати"
              style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Plus size={14} />
            </button>
          </div>
          {/* Search */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
            <Search size={12} style={{
              position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--text3)', pointerEvents: 'none',
            }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Пошук: ім'я / host / тег…"
              style={{
                width: '100%', padding: '6px 26px 6px 28px', fontSize: 12,
                background: 'var(--bg3)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text)',
              }}
            />
            {search && (
              <button onClick={() => setSearch('')}
                style={{
                  position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: 'var(--text3)',
                  cursor: 'pointer', padding: 0, display: 'flex',
                }}>
                <X size={12} />
              </button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
            {isLoading && <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>}
            {!isLoading && servers.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
                Натисніть «+» щоб додати перший сервер.
              </div>
            )}
            {!isLoading && servers.length > 0 && filteredServers.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
                Нічого не знайдено за «{search}»
              </div>
            )}
            {filteredServers.map(s => (
              <ServerRow key={s.id} server={s} active={s.id === selectedId}
                proxy={proxies.find(p => p.id === s.proxy_id)}
                onClick={() => { setSelectedId(s.id); setTab('info') }} />
            ))}
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text3)' }}>
            SSH через SOCKS5/HTTP · Web-панель вбудована
          </div>
        </aside>

        {/* RIGHT: detail panel */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!selected ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>
              Оберіть сервер ліворуч
            </div>
          ) : (
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <TabBtn icon={<Info size={13} />} label="Інфо" active={tab === 'info'} onClick={() => setTab('info')} />
                <TabBtn icon={<TermIcon size={13} />} label="Термінал" active={tab === 'terminal'} onClick={openTerminal} />
                <TabBtn icon={<FolderTree size={13} />} label="SFTP" active={tab === 'sftp'} onClick={openSftp} />
                <TabBtn icon={<Globe size={13} />} label="Web" active={tab === 'web'} onClick={openWeb} disabled={!selected.web_url} />
                <div style={{ flex: 1 }} />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {tab === 'info' && (
                  <InfoPanel server={selected} proxies={proxies}
                    onEdit={() => { setEditing(selected); setAddOpen(true) }}
                    onDelete={() => confirm(`Видалити ${selected.label}?`) && delMut.mutate(selected.id)}
                    onTest={() => testMut.mutate(selected.id)} testing={testMut.isPending} />
                )}
                {tab === 'terminal' && openTabs[selected.id]?.terminal && (
                  <InlineTerminal key={`term-${selected.id}`} server={selected} />
                )}
                {tab === 'sftp' && openTabs[selected.id]?.sftp && (
                  <InlineSftp key={`sftp-${selected.id}`} server={selected} />
                )}
                {tab === 'web' && openTabs[selected.id]?.web && selected.web_url && (
                  <InlineWebPanel key={`web-${selected.id}`} server={selected} />
                )}
              </div>
            </>
          )}
        </main>

        <ServerFormModal open={addOpen} onClose={() => setAddOpen(false)} editing={editing} />
      </div>
    </>
  )
}


function ServerRow({ server, active, proxy, onClick }) {
  return (
    <div onClick={onClick}
      style={{
        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
        background: active ? 'var(--accent-dim)' : 'transparent',
        border: active ? '1px solid var(--accent)' : '1px solid transparent',
        marginBottom: 4, transition: 'all 0.12s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: server.last_status === 'ok' ? '#4ade80'
                    : server.last_status === 'error' ? '#f87171' : '#475569',
        }} />
        <div style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {server.label}
        </div>
        <ChevronRight size={12} color="var(--text3)" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.host}:{server.port}</span>
        {proxy ? (
          <span style={{ color: '#7da3ff', flexShrink: 0 }}>· via {proxy.label || proxy.host}</span>
        ) : (
          <span style={{ color: 'var(--text3)', flexShrink: 0 }}>· direct</span>
        )}
      </div>
    </div>
  )
}


function TabBtn({ icon, label, active, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
        background: active ? 'var(--bg)' : 'transparent',
        border: active ? '1px solid var(--border)' : '1px solid transparent',
        color: disabled ? 'var(--text3)' : active ? 'var(--text)' : 'var(--text2)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >{icon}{label}</button>
  )
}
