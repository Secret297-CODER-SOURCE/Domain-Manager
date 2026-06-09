import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  User as UserIcon, MapPin, CreditCard, Copy, RefreshCw, Save, Trash2,
  Shuffle, Globe, Phone, Calendar, IdCard, Sparkles, Tag, Edit3, X, Search,
  Mail, AtSign, KeyRound,
} from 'lucide-react'

import {
  getIdentityLocations, generateIdentity, listSavedIdentities,
  saveIdentity, patchSavedIdentity, deleteSavedIdentity,
} from '../api/client'
import { Btn, Modal, Spinner, Field, Badge } from '../components/ui/index'
import { useDeleteOtp } from '../context/DeleteOtpContext'

const FLAG = {
  ar: '🇦🇷', au: '🇦🇺', bd: '🇧🇩', be: '🇧🇪', br: '🇧🇷', ca: '🇨🇦', cn: '🇨🇳', cz: '🇨🇿',
  fr: '🇫🇷', de: '🇩🇪', gr: '🇬🇷', hu: '🇭🇺', in: '🇮🇳', id: '🇮🇩', ir: '🇮🇷', it: '🇮🇹',
  jp: '🇯🇵', my: '🇲🇾', mx: '🇲🇽', nl: '🇳🇱', ng: '🇳🇬', pe: '🇵🇪', ph: '🇵🇭', pl: '🇵🇱',
  pt: '🇵🇹', ro: '🇷🇴', ru: '🇷🇺', sa: '🇸🇦', sg: '🇸🇬', za: '🇿🇦', kr: '🇰🇷', es: '🇪🇸',
  se: '🇸🇪', th: '🇹🇭', tr: '🇹🇷', ug: '🇺🇬', ua: '🇺🇦', uk: '🇬🇧', us: '🇺🇸', vn: '🇻🇳',
}

const COUNTRY_NAME = {
  ar: 'Argentina', au: 'Australia', bd: 'Bangladesh', be: 'Belgium', br: 'Brazil',
  ca: 'Canada', cn: 'China', cz: 'Czech Rep.', fr: 'France', de: 'Germany',
  gr: 'Greece', hu: 'Hungary', in: 'India', id: 'Indonesia', ir: 'Iran',
  it: 'Italy', jp: 'Japan', my: 'Malaysia', mx: 'Mexico', nl: 'Netherlands',
  ng: 'Nigeria', pe: 'Peru', ph: 'Philippines', pl: 'Poland', pt: 'Portugal',
  ro: 'Romania', ru: 'Russia', sa: 'Saudi Arabia', sg: 'Singapore', za: 'South Africa',
  kr: 'South Korea', es: 'Spain', se: 'Sweden', th: 'Thailand', tr: 'Türkiye',
  ug: 'Uganda', ua: 'Ukraine', uk: 'United Kingdom', us: 'USA', vn: 'Vietnam',
}

export default function IdentitiesPage() {
  const qc = useQueryClient()
  const { gateDelete } = useDeleteOtp()
  const [loc, setLoc] = useState(() => localStorage.getItem('dm.identity.lastLoc') || 'random')
  const [current, setCurrent] = useState(null)
  const [genLoading, setGenLoading] = useState(false)
  const [saveModal, setSaveModal] = useState(false)
  const [search, setSearch] = useState('')

  const { data: locs } = useQuery({
    queryKey: ['identity-locations'],
    queryFn: () => getIdentityLocations().then(r => r.data.locations),
    staleTime: Infinity,
  })

  const { data: saved = [], isLoading: savedLoading } = useQuery({
    queryKey: ['identities-saved'],
    queryFn: () => listSavedIdentities().then(r => r.data),
  })

  const filteredSaved = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return saved
    return saved.filter(s =>
      [s.label, s.full_name, s.country_code, s.country_full, s.city, s.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    )
  }, [saved, search])

  async function gen() {
    setGenLoading(true)
    try {
      localStorage.setItem('dm.identity.lastLoc', loc)
      const r = await generateIdentity(loc)
      setCurrent(r.data)
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Помилка генерації')
    } finally { setGenLoading(false) }
  }

  // Auto-generate first one on page load
  useEffect(() => { gen() /* eslint-disable-next-line */ }, [])

  const delMut = useMutation({
    mutationFn: deleteSavedIdentity,
    onSuccess: () => { toast.success('Видалено'); qc.invalidateQueries(['identities-saved']) },
  })

  return (
    <div style={{ padding: 24, display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Left — generator */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h1 style={{ fontWeight: 800, fontSize: 22, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <Sparkles size={22} style={{ color: 'var(--accent)' }} /> Генератор особистостей
            </h1>
            <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
              Тестові ПІБ, адреси, картки, телефони. Дані з fakexy.com. Не є реальними людьми.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={loc} onChange={e => setLoc(e.target.value)} style={{ minWidth: 180 }}>
              <option value="random">🎲 Випадкова країна</option>
              {(locs || []).map(c => (
                <option key={c} value={c}>{FLAG[c] || '🏳'} {COUNTRY_NAME[c] || c.toUpperCase()}</option>
              ))}
            </select>
            <Btn loading={genLoading} onClick={gen}>
              <RefreshCw size={14} /> Згенерувати
            </Btn>
            {current && (
              <Btn variant="success" onClick={() => setSaveModal(true)}>
                <Save size={14} /> Зберегти
              </Btn>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!current && !genLoading && (
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 48, textAlign: 'center', color: 'var(--text3)' }}>
              Натисніть «Згенерувати» щоб створити особистість
            </div>
          )}
          {genLoading && !current && <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>}
          {current && <IdentityCard data={current} />}
        </div>
      </div>

      {/* Right — history */}
      <aside style={{
        width: 320, flexShrink: 0,
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <UserIcon size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Збережені</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{saved.length}</span>
        </div>
        <div style={{ padding: 10, borderBottom: '1px solid var(--border)', position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Пошук…" style={{ paddingLeft: 28 }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {savedLoading ? <Spinner /> : filteredSaved.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Порожньо</div>
          ) : filteredSaved.map(s => (
            <SavedRow key={s.id} item={s}
              onOpen={() => setCurrent(s)}
              onDelete={() => gateDelete(() => delMut.mutateAsync(s.id)).catch(() => {})}
            />
          ))}
        </div>
      </aside>

      <SaveModal open={saveModal} onClose={() => setSaveModal(false)} data={current}
        onSaved={() => { qc.invalidateQueries(['identities-saved']); setSaveModal(false); toast.success('Збережено') }} />
    </div>
  )
}

function SavedRow({ item, onOpen, onDelete }) {
  const cc = item.country_code

  function copyAll(e) {
    e.stopPropagation()
    const text = [
      `Full Name: ${item.full_name || ''}`,
      `Gender: ${item.gender || ''}`,
      `Birthday: ${item.birthday || ''}`,
      `SSN: ${item.ssn || ''}`,
      `Phone: ${item.phone || ''}`,
      ``,
      `Card: ${item.card_brand || ''} ${item.card_number || ''}`,
      `Expire: ${item.card_expire || ''}  CVV: ${item.card_cvv || ''}`,
      ``,
      `Street: ${item.street || ''}`,
      `City: ${item.city || ''}, ${item.region || ''} ${item.zip_code || ''}`,
      `Country: ${item.country_full || ''}`,
    ].join('\n')
    navigator.clipboard.writeText(text)
    toast.success('Скопійовано')
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', gap: 10, alignItems: 'center',
      padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8,
      cursor: 'pointer', border: '1px solid var(--border)',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      <span style={{ fontSize: 18, flexShrink: 0 }}>{FLAG[cc] || '🏳'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label || item.full_name || '(без імені)'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)' }}>
          {item.city ? `${item.city}, ` : ''}{cc.toUpperCase()} · {new Date(item.created_at).toLocaleDateString('uk-UA')}
        </div>
      </div>
      <button onClick={copyAll} title="Копіювати все"
        style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
      ><Copy size={12} /></button>
      <button onClick={e => { e.stopPropagation(); onDelete() }} title="Видалити"
        style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
      ><Trash2 size={12} /></button>
    </div>
  )
}

// ── Identity card ───────────────────────────────────────────────────────

function IdentityCard({ data }) {
  const personText = [
    `Full Name: ${data.full_name || ''}`,
    `Gender: ${data.gender || ''}`,
    `Birthday: ${data.birthday || ''}`,
    `SSN: ${data.ssn || ''}`,
    `Phone: ${data.phone || ''}`,
  ].join('\n')
  const accountText = [
    `Email: ${data.email || ''}`,
    `Username: ${data.username || ''}`,
    `Password: ${data.password || ''}`,
  ].join('\n')
  const cardText = [
    `Brand: ${data.card_brand || ''}`,
    `Number: ${data.card_number || ''}`,
    `Expire: ${data.card_expire || ''}`,
    `CVV: ${data.card_cvv || ''}`,
  ].join('\n')
  const addressText = [
    `Street: ${data.street || ''}`,
    `City: ${data.city || ''}`,
    `Region: ${data.region || ''}`,
    `Zip: ${data.zip_code || ''}`,
    `Country: ${data.country_full || ''}`,
    `Lat/Lon: ${data.latitude || ''}, ${data.longitude || ''}`,
  ].join('\n')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data.picture && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 4px' }}>
          <img src={data.picture} alt="" style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid var(--border)' }} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{data.full_name || '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              {[data.gender, data.country_full].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
      )}

      <Section icon={<UserIcon size={15} />} color="var(--accent)" title="Особа"
        copyText={personText} copyLabel="Особу">
        <Row label="Імʼя"      value={data.full_name} mono />
        <Row label="Стать"     value={data.gender} />
        <Row label="День нар." value={data.birthday} icon={<Calendar size={11} />} />
        <Row label="SSN"       value={data.ssn} mono icon={<IdCard size={11} />} />
        <Row label="Телефон"   value={data.phone} mono icon={<Phone size={11} />} />
      </Section>

      {(data.email || data.username || data.password) && (
        <Section icon={<AtSign size={15} />} color="#ff9f0a" title="Акаунт"
          copyText={accountText} copyLabel="Акаунт">
          <Row label="Email"    value={data.email} mono icon={<Mail size={11} />} />
          <Row label="Username" value={data.username} mono icon={<AtSign size={11} />} />
          <Row label="Password" value={data.password} mono icon={<KeyRound size={11} />} protect />
        </Section>
      )}

      <Section icon={<CreditCard size={15} />} color="#bf5af2" title="Картка"
        copyText={cardText} copyLabel="Картку">
        <Row label="Бренд"   value={data.card_brand} />
        <Row label="Номер"   value={data.card_number} mono large />
        <Row label="Expire"  value={data.card_expire} mono />
        <Row label="CVV"     value={data.card_cvv} mono protect />
      </Section>

      <Section icon={<MapPin size={15} />} color="var(--green)" title="Адреса"
        copyText={addressText} copyLabel="Адресу">
        <Row label="Вулиця"  value={data.street} mono />
        <Row label="Місто"   value={data.city} />
        <Row label="Регіон"  value={data.region} />
        <Row label="Індекс"  value={data.zip_code} mono />
        <Row label="Країна"  value={data.country_full} icon={<Globe size={11} />} />
        <Row label="Lat"     value={data.latitude} mono />
        <Row label="Lon"     value={data.longitude} mono />
      </Section>

      {/* Copy-all card */}
      <CopyAll data={data} />
    </div>
  )
}

function Section({ icon, color, title, copyText, copyLabel, children }) {
  function copy() {
    navigator.clipboard.writeText(copyText)
    toast.success(`${copyLabel} скопійовано`)
  }
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: `color-mix(in srgb, ${color} 18%, transparent)`, color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {icon}
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text2)' }}>{title}</span>
        {copyText && (
          <button onClick={copy} title={`Копіювати ${copyLabel.toLowerCase()}`}
            style={{
              marginLeft: 'auto', background: 'var(--bg3)', border: '1px solid var(--border)',
              color: 'var(--text2)', cursor: 'pointer', padding: '4px 10px', borderRadius: 6,
              fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = color; e.currentTarget.style.borderColor = color }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text2)'; e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            <Copy size={11} /> Копіювати
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, value, mono, large, icon, protect }) {
  const [shown, setShown] = useState(!protect)
  if (!value) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.4 }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {icon}{icon && ' '}{label}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text3)' }}>—</span>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {icon} {label}
      </span>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8,
        padding: large ? '8px 10px' : '6px 10px',
      }}>
        <span style={{
          flex: 1, fontFamily: mono ? 'var(--mono)' : 'var(--font)',
          fontSize: large ? 14 : 12, fontWeight: large ? 600 : 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--text)',
        }}>{shown ? value : '•'.repeat(value.length)}</span>
        {protect && (
          <button onClick={() => setShown(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0 }}>
            {shown ? '🙈' : '👁'}
          </button>
        )}
        <button onClick={() => { navigator.clipboard.writeText(value); toast.success('Скопійовано') }}
          style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        ><Copy size={12} /></button>
      </div>
    </div>
  )
}

function CopyAll({ data }) {
  function copyAll() {
    const text = [
      `Full Name: ${data.full_name || ''}`,
      `Gender: ${data.gender || ''}`,
      `Birthday: ${data.birthday || ''}`,
      `SSN: ${data.ssn || ''}`,
      `Phone: ${data.phone || ''}`,
      ``,
      `Card: ${data.card_brand || ''} ${data.card_number || ''}`,
      `Expire: ${data.card_expire || ''}  CVV: ${data.card_cvv || ''}`,
      ``,
      `Street: ${data.street || ''}`,
      `City: ${data.city || ''}, ${data.region || ''} ${data.zip_code || ''}`,
      `Country: ${data.country_full || ''}`,
      `Coordinates: ${data.latitude || ''}, ${data.longitude || ''}`,
    ].join('\n')
    navigator.clipboard.writeText(text)
    toast.success('Скопійовано всі поля')
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <Btn variant="ghost" size="sm" onClick={copyAll}>
        <Copy size={13} /> Копіювати все
      </Btn>
    </div>
  )
}

// ── Save modal ──────────────────────────────────────────────────────────

function SaveModal({ open, onClose, data, onSaved }) {
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (open) { setLabel(data?.full_name || ''); setNotes('') } }, [open, data])

  async function submit() {
    setLoading(true)
    try {
      await saveIdentity({ ...data, label: label || null, notes: notes || null })
      onSaved()
    } catch { toast.error('Помилка') }
    finally { setLoading(false) }
  }

  if (!data) return null
  return (
    <Modal open={open} onClose={onClose} title="Зберегти особистість">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Підпис (зрозуміла назва для історії)">
          <input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder={data.full_name || ''} />
        </Field>
        <Field label="Нотатки">
          <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} style={{ resize: 'vertical' }}
            placeholder="Для якого акаунта / тесту…" />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Скасувати</Btn>
          <Btn loading={loading} onClick={submit}><Save size={13} /> Зберегти</Btn>
        </div>
      </div>
    </Modal>
  )
}
