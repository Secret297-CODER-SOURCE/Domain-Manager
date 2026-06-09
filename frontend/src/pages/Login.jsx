import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, getMe } from '../api/client'
import { useAuthStore } from '../store/auth'
import toast from 'react-hot-toast'
import { Database } from 'lucide-react'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { setAuth, setUser } = useAuthStore()
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      const { data } = await login(username, password)
      setAuth(data.access_token, { username: data.username, role: data.role })
      const me = await getMe()
      setUser(me.data)
      navigate('/domains')
      toast.success(`Ласкаво просимо, ${data.username}!`)
    } catch {
      toast.error('Невірний логін або пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
      backgroundImage: 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(79,110,247,0.08), transparent)',
    }}>
      <div style={{ width: '100%', maxWidth: 380, padding: '0 16px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{
            width: 56, height: 56, background: 'var(--accent)',
            borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', boxShadow: '0 0 32px rgba(79,110,247,0.4)'
          }}>
            <Database size={26} color="#fff" />
          </div>
          <h1 style={{ fontWeight: 800, fontSize: 24, marginBottom: 4 }}>Domain Manager</h1>
          <p style={{ color: 'var(--text3)', fontSize: 13 }}>Увійдіть в систему</p>
        </div>

        {/* Form */}
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 28, boxShadow: 'var(--shadow)'
        }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Логін
              </label>
              <input
                value={username} onChange={e => setUsername(e.target.value)}
                placeholder="username" autoFocus required
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Пароль
              </label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••" required
              />
            </div>
            <button
              type="submit" disabled={loading}
              style={{
                marginTop: 4, padding: '11px 0', background: 'var(--accent)',
                color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700,
                fontSize: 14, fontFamily: 'var(--font)', cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1, transition: 'all 0.15s',
              }}
            >
              {loading ? 'Вхід...' : 'Увійти'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
