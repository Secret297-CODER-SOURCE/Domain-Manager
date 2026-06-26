import { useState } from 'react'
import { Search, Database, CheckCircle2, XCircle, Lock, Users, Cloud, AlertCircle, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { checkPublicDomain } from '../api/client'
import AnimatedIcon from '../components/ui/AnimatedIcon'
import { Btn } from '../components/ui/index'

export default function CheckPage() {
  const [name, setName] = useState('')
  const [feMode, setFeMode] = useState(false)
  const [codeword, setCodeword] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function submit(e) {
    e?.preventDefault?.()
    if (!name.trim()) return
    setLoading(true); setError(null); setResult(null)
    try {
      const r = await checkPublicDomain(name.trim(), feMode ? codeword.trim() : null)
      setResult(r)
    } catch (err) {
      setError(err.response?.data?.detail || 'Помилка перевірки')
    } finally { setLoading(false) }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 24, background:
        'radial-gradient(circle at 20% 10%, rgba(79,110,247,0.18), transparent 50%), ' +
        'radial-gradient(circle at 80% 80%, rgba(168,85,247,0.15), transparent 55%), ' +
        'var(--bg)',
    }}>
      <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* Hero */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
          <div style={{
            width: 76, height: 76, borderRadius: 18,
            background: 'linear-gradient(135deg, var(--accent), #a855f7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 12px 40px rgba(79,110,247,0.40)',
          }}>
            <AnimatedIcon icon={Database} size={36} color="#fff" anim="glow" />
          </div>
          <div>
            <h1 style={{
              fontWeight: 900, fontSize: 38, margin: 0, lineHeight: 1.1,
              background: 'linear-gradient(120deg, var(--text), color-mix(in srgb, var(--accent) 70%, var(--text)))',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>
              Domain Manager
            </h1>
            <p style={{ color: 'var(--text3)', fontSize: 14, marginTop: 8, maxWidth: 460 }}>
              Перевір, чи належить домен нашій компанії. Для фронтендерів — додатковий режим із кодовим словом для отримання назви команди.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={submit} style={{
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16,
          padding: 22, display: 'flex', flexDirection: 'column', gap: 14,
          boxShadow: '0 8px 32px rgba(0,0,0,0.20)',
        }}>
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{
              position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--text3)', pointerEvents: 'none',
            }} />
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="example.com"
              style={{
                width: '100%', padding: '14px 14px 14px 42px',
                fontSize: 16, fontFamily: 'var(--mono)',
                borderRadius: 12, border: '1px solid var(--border)',
                background: 'var(--bg3)', color: 'var(--text)',
              }}
            />
          </div>

          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer',
            padding: '8px 12px', borderRadius: 10,
            background: feMode ? 'rgba(168,85,247,0.10)' : 'transparent',
            border: `1px solid ${feMode ? 'rgba(168,85,247,0.35)' : 'var(--border)'}`,
            transition: 'all 0.15s',
          }}>
            <input type="checkbox" checked={feMode} onChange={e => setFeMode(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: '#a855f7', cursor: 'pointer' }} />
            <AnimatedIcon icon={Lock} size={13} color="#a855f7" anim={feMode ? 'pulse' : 'pulse'} paused={!feMode} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Front-end режим</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>(показати команду — потрібне кодове слово)</span>
          </label>

          {feMode && (
            <input
              type="password"
              value={codeword}
              onChange={e => setCodeword(e.target.value)}
              placeholder="Кодове слово"
              autoComplete="off"
              style={{
                padding: '12px 14px', fontSize: 14, fontFamily: 'var(--mono)',
                borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--bg3)', color: 'var(--text)',
              }}
            />
          )}

          <Btn type="submit" loading={loading} disabled={!name.trim() || (feMode && !codeword.trim())}
            style={{ justifyContent: 'center', padding: '12px 16px', fontSize: 14 }}>
            <Search size={15} /> Перевірити
          </Btn>
        </form>

        {/* Result */}
        {error && (
          <ResultCard color="var(--red)" Icon={AlertCircle} title="Помилка" detail={error} />
        )}
        {result && !error && <Result data={result} />}

        {/* Footer link to admin login */}
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
          <Link to="/login" style={{ color: 'var(--text3)', textDecoration: 'none' }}>
            Адмін-панель <ArrowRight size={11} style={{ verticalAlign: 'middle' }} />
          </Link>
        </div>
      </div>
    </div>
  )
}

function Result({ data }) {
  const owned = data.owned
  return (
    <div style={{
      background: 'var(--bg2)', borderRadius: 16,
      border: `1px solid ${owned ? 'rgba(34,197,94,0.30)' : 'rgba(239,68,68,0.30)'}`,
      padding: 22, display: 'flex', flexDirection: 'column', gap: 14,
      boxShadow: `0 6px 24px ${owned ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          background: owned ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
          color: owned ? 'var(--green)' : 'var(--red)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AnimatedIcon icon={owned ? CheckCircle2 : XCircle} size={28}
            anim={owned ? 'pulse' : 'shake'} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700 }}>{data.domain}</div>
          <div style={{
            fontSize: 14, fontWeight: 700, marginTop: 4,
            color: owned ? 'var(--green)' : 'var(--red)',
          }}>
            {owned ? 'Цей домен належить нашій компанії' : 'Домен не знайдено в системі'}
          </div>
        </div>
      </div>

      {owned && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <Pill icon={CheckCircle2} label="Статус" value={data.status || '—'} color={
            data.status === 'active' ? 'var(--green)'
              : data.status === 'suspended' ? 'var(--red)'
              : 'var(--yellow)'
          } />
          {data.team
            ? <Pill icon={Users} label="Команда" value={data.team} color="#a855f7" />
            : null}
          {data.cf_account
            ? <Pill icon={Cloud} label="CF акаунт" value={data.cf_account} color="#f48120" />
            : null}
        </div>
      )}

      {data.detail && (
        <div style={{
          fontSize: 12, color: 'var(--yellow)', display: 'inline-flex', alignItems: 'center', gap: 8,
        }}>
          <AnimatedIcon icon={AlertCircle} size={13} color="var(--yellow)" anim="pulse" />
          {data.detail === 'wrong codeword'
            ? 'Неправильне кодове слово — назва команди прихована.'
            : data.detail}
        </div>
      )}
    </div>
  )
}

function ResultCard({ color, Icon, title, detail }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: `1px solid ${color}40`, borderRadius: 14,
      padding: 16, display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <AnimatedIcon icon={Icon} size={22} color={color} anim="shake" />
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>{detail}</div>
      </div>
    </div>
  )
}

function Pill({ icon: Icon, label, value, color }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      borderRadius: 10, padding: '6px 12px',
    }}>
      <Icon size={13} style={{ color }} />
      <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}:</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}
