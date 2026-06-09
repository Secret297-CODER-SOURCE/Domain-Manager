import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { RefreshCw, Copy, Check, Eye, EyeOff } from 'lucide-react'
import { Btn, Modal, Field } from './ui/index'

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGIT = '0123456789'
const SYM   = '!@#$%^&*()-_=+[]{};:,.<>?'
const AMBIG = 'Il1O0'

function buildCharset(opt) {
  let s = ''
  if (opt.upper)   s += UPPER
  if (opt.lower)   s += LOWER
  if (opt.digits)  s += DIGIT
  if (opt.symbols) s += SYM
  if (!opt.ambiguous) s = s.split('').filter(c => !AMBIG.includes(c)).join('')
  return s
}

export function generatePassword(opt = {}) {
  const o = { length: 20, upper: true, lower: true, digits: true, symbols: true, ambiguous: false, ...opt }
  const charset = buildCharset(o)
  if (!charset) return ''
  const arr = new Uint32Array(o.length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < o.length; i++) out += charset[arr[i] % charset.length]
  return out
}

function entropyBits(pwd, opt) {
  const charset = buildCharset(opt)
  if (!charset.length || !pwd) return 0
  return Math.round(pwd.length * Math.log2(charset.length))
}

function strengthLabel(bits) {
  if (bits < 40)  return { label: 'Слабкий',     color: 'var(--red)' }
  if (bits < 70)  return { label: 'Помірний',    color: 'var(--yellow)' }
  if (bits < 100) return { label: 'Сильний',     color: 'var(--accent)' }
  return                  { label: 'Дуже сильний', color: 'var(--green)' }
}

/**
 * Reusable password generator modal.
 * Props:
 *   open, onClose
 *   onUse?(password) — if provided, shows "Використати" button which calls this and closes the modal
 *   initial? — initial options
 */
export default function PasswordGeneratorModal({ open, onClose, onUse, initial }) {
  const [opt, setOpt] = useState({ length: 20, upper: true, lower: true, digits: true, symbols: true, ambiguous: false, ...(initial || {}) })
  const [pwd, setPwd] = useState('')
  const [show, setShow] = useState(true)
  const [copied, setCopied] = useState(false)

  const regenerate = useCallback(() => setPwd(generatePassword(opt)), [opt])

  useEffect(() => { if (open) regenerate() }, [open])
  useEffect(() => { if (open) regenerate() }, [opt.length, opt.upper, opt.lower, opt.digits, opt.symbols, opt.ambiguous])

  const bits = useMemo(() => entropyBits(pwd, opt), [pwd, opt])
  const strength = strengthLabel(bits)

  function copy() {
    navigator.clipboard.writeText(pwd)
    setCopied(true); toast.success('Пароль скопійовано')
    setTimeout(() => setCopied(false), 1500)
  }

  function setOptKey(k, v) { setOpt(o => ({ ...o, [k]: v })) }

  return (
    <Modal open={open} onClose={onClose} title="Генератор паролів" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Output */}
        <div style={{
          background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{
            flex: 1, fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: 'var(--text)', letterSpacing: '0.02em',
          }}>
            {show ? pwd : '•'.repeat(pwd.length)}
          </span>
          <button onClick={() => setShow(s => !s)} title={show ? 'Сховати' : 'Показати'}
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button onClick={regenerate} title="Згенерувати інший"
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}>
            <RefreshCw size={15} />
          </button>
          <button onClick={copy} title="Копіювати"
            style={{ background: 'none', border: 'none', color: copied ? 'var(--green)' : 'var(--text3)', cursor: 'pointer', padding: 4 }}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>

        {/* Strength */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, height: 6, background: 'var(--bg4)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.min(100, (bits / 128) * 100)}%`,
              background: strength.color, transition: 'all 0.2s',
            }} />
          </div>
          <span style={{ fontSize: 12, color: strength.color, fontWeight: 600, minWidth: 110, textAlign: 'right' }}>
            {strength.label} · {bits} bits
          </span>
        </div>

        {/* Length slider */}
        <Field label={`Довжина: ${opt.length}`}>
          <input type="range" min="6" max="80" value={opt.length}
            onChange={e => setOptKey('length', +e.target.value)}
            style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </Field>

        {/* Charset toggles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          <Toggle label="A–Z (великі)"   checked={opt.upper}     onChange={v => setOptKey('upper', v)} />
          <Toggle label="a–z (малі)"     checked={opt.lower}     onChange={v => setOptKey('lower', v)} />
          <Toggle label="0–9 (цифри)"    checked={opt.digits}    onChange={v => setOptKey('digits', v)} />
          <Toggle label="!@#$ (символи)" checked={opt.symbols}   onChange={v => setOptKey('symbols', v)} />
          <Toggle label="Дозволити схожі (Il1O0)" checked={opt.ambiguous} onChange={v => setOptKey('ambiguous', v)} full />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Закрити</Btn>
          <Btn variant="ghost" onClick={copy}><Copy size={13} /> Копіювати</Btn>
          {onUse && <Btn onClick={() => { onUse(pwd); onClose() }}><Check size={13} /> Використати</Btn>}
        </div>
      </div>
    </Modal>
  )
}

function Toggle({ label, checked, onChange, full }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
      fontSize: 12, gridColumn: full ? 'span 2' : undefined,
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 'auto' }} />
      {label}
    </label>
  )
}
