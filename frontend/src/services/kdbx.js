// kdbxweb glue: loads kdbx files, wires argon2 (required for KDBX4 default KDF),
// and exposes a small API for the UI: open, save, list, CRUD on groups/entries.
import * as kdbxweb from 'kdbxweb'

let _argonReady = false
let _argonLoading = null

// argon2-browser is published as a UMD bundle that expects to assign to
// `this.argon2` / `window.argon2`. When Vite imports it as an ES module the
// outer `this` is `undefined` (strict mode), so the UMD wrapper throws
// "Cannot set properties of undefined (setting 'argon2')".
// Inject as a classic <script> tag instead — that runs in non-strict global
// context and lets the UMD wrapper resolve `window` correctly.
import argonScriptUrl from 'argon2-browser/dist/argon2-bundled.min.js?url'

function loadScriptOnce(url) {
  if (_argonLoading) return _argonLoading
  _argonLoading = new Promise((resolve, reject) => {
    if (window.argon2) return resolve()
    const s = document.createElement('script')
    s.src = url
    s.async = true
    s.onload = () => window.argon2 ? resolve() : reject(new Error('argon2 script loaded but window.argon2 is missing'))
    s.onerror = () => reject(new Error('Failed to load argon2-browser'))
    document.head.appendChild(s)
  })
  return _argonLoading
}

async function ensureArgon2() {
  if (_argonReady) return
  await loadScriptOnce(argonScriptUrl)
  const argon2 = window.argon2
  if (!argon2) throw new Error('argon2-browser failed to load')
  kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
    const res = await argon2.hash({
      pass: new Uint8Array(password),
      salt: new Uint8Array(salt),
      time: iterations,
      mem: memory,
      hashLen: length,
      parallelism,
      type, // 0=Argon2d, 1=Argon2i, 2=Argon2id
      version,
    })
    return res.hash
  })
  _argonReady = true
}

export async function openKdbx(arrayBuffer, password) {
  await ensureArgon2()
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password))
  return kdbxweb.Kdbx.load(arrayBuffer, credentials)
}

export async function createBlankKdbx(name, password) {
  await ensureArgon2()
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password))
  const db = kdbxweb.Kdbx.create(credentials, name)
  return db
}

export async function saveKdbx(db) {
  return db.save() // returns ArrayBuffer
}

// ── Tree walking ──────────────────────────────────────────────────────────

export function listGroups(db) {
  const root = db.getDefaultGroup()
  const out = []
  function walk(group, depth = 0) {
    out.push({
      id: group.uuid.id,
      uuid: group.uuid,
      name: group.name,
      depth,
      entryCount: group.entries.length,
      group,
    })
    for (const g of group.groups) walk(g, depth + 1)
  }
  walk(root)
  return out
}

export function listEntries(group) {
  return group.entries.map(e => ({
    id: e.uuid.id,
    uuid: e.uuid,
    title: getField(e, 'Title'),
    username: getField(e, 'UserName'),
    url: getField(e, 'URL'),
    notes: getField(e, 'Notes'),
    password: getField(e, 'Password'), // ProtectedValue
    modified: e.times?.lastModTime,
    entry: e,
  }))
}

export function getField(entry, key) {
  const v = entry.fields.get(key)
  if (!v) return ''
  if (typeof v === 'string') return v
  if (v.getText) return v.getText() // ProtectedValue
  return String(v)
}

export function setField(entry, key, value, protect = false) {
  if (protect) {
    entry.fields.set(key, kdbxweb.ProtectedValue.fromString(value || ''))
  } else {
    entry.fields.set(key, value || '')
  }
  entry.times.update()
}

export function createEntry(db, parentGroup, fields) {
  const entry = db.createEntry(parentGroup)
  setField(entry, 'Title', fields.title || 'Без назви')
  setField(entry, 'UserName', fields.username || '')
  setField(entry, 'URL', fields.url || '')
  setField(entry, 'Notes', fields.notes || '')
  setField(entry, 'Password', fields.password || '', true)
  return entry
}

export function updateEntry(entry, fields) {
  if ('title' in fields) setField(entry, 'Title', fields.title)
  if ('username' in fields) setField(entry, 'UserName', fields.username)
  if ('url' in fields) setField(entry, 'URL', fields.url)
  if ('notes' in fields) setField(entry, 'Notes', fields.notes)
  if ('password' in fields) setField(entry, 'Password', fields.password, true)
}

export function deleteEntry(db, entry) {
  db.remove(entry)
}

export function createGroup(db, parent, name) {
  return db.createGroup(parent, name || 'Нова група')
}

export function renameGroup(group, name) {
  group.name = name
  group.times.update()
}

export function deleteGroup(db, group) {
  db.remove(group)
}

export function generatePassword(length = 20) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{};:,.<>?'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) out += charset[arr[i] % charset.length]
  return out
}
