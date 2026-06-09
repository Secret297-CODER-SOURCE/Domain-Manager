// AES-GCM encryption for spreadsheet payloads.
// Format stored in `data` column: `ENC1:<saltB64>:<ivB64>:<ciphertextB64>`
// Master password never leaves the browser.

const ENC_PREFIX = 'ENC1:'

export function isEncrypted(data) {
  return typeof data === 'string' && data.startsWith(ENC_PREFIX)
}

function b64encode(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function b64decode(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(password, salt) {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptData(plain, password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain))
  return `${ENC_PREFIX}${b64encode(salt)}:${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`
}

export async function decryptData(payload, password) {
  if (!isEncrypted(payload)) throw new Error('Not an encrypted payload')
  const [, saltB64, ivB64, ctB64] = payload.split(':')
  if (!saltB64 || !ivB64 || !ctB64) throw new Error('Malformed payload')
  const salt = b64decode(saltB64)
  const iv = b64decode(ivB64)
  const ct = b64decode(ctB64)
  const key = await deriveKey(password, salt)
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error('Невірний пароль')
  }
}
