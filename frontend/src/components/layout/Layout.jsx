import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Globe, Settings, Users, LogOut, Database, Search, BarChart2, Home, ScrollText, FileSpreadsheet, ShieldCheck, Network, Archive, ShoppingBag, Activity, Sparkles, Inbox } from 'lucide-react'
import { useAuthStore } from '../../store/auth'
import toast from 'react-hot-toast'

export default function Layout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

  function handleLogout() {
    logout()
    navigate('/login')
    toast.success('Вийшли з системи')
  }

  const nav = [
    { to: '/dashboard', icon: Home,            label: 'Головна' },
    { to: '/domains',   icon: Globe,           label: 'Домени' },
    { to: '/keitaro',   icon: BarChart2,       label: 'Keitaro' },
    { to: '/search',    icon: Search,          label: 'Пошук' },
    { to: '/sheets',    icon: FileSpreadsheet, label: 'Таблиці' },
    { to: '/proxies',   icon: Network,         label: 'Проксі' },
    { to: '/purchases', icon: ShoppingBag,     label: 'Закупки' },
    { to: '/kuma',      icon: Activity,        label: 'Uptime Kuma' },
    { to: '/identities', icon: Sparkles,       label: 'Особистості' },
    { to: '/mail',       icon: Inbox,          label: 'Пошта' },
  ]
  const adminNav = [
    { to: '/passwords', icon: ShieldCheck, label: 'Паролі' },
    { to: '/backup',    icon: Archive,     label: 'Бекапи' },
    { to: '/settings',  icon: Settings,    label: 'Налаштування' },
    { to: '/users',     icon: Users,       label: 'Користувачі' },
    { to: '/logs',      icon: ScrollText,  label: 'Логи' },
  ]

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside style={{ width: 220, flexShrink: 0, background: 'var(--bg2)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, background: 'var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Database size={16} color="#fff" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>DomainMgr</div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>v1.0</div>
            </div>
          </div>
        </div>

        <nav style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500,
              color: isActive ? '#fff' : 'var(--text2)',
              background: isActive ? 'var(--accent)' : 'transparent',
              transition: 'all 0.15s', textDecoration: 'none',
            })}>
              <Icon size={15} />{label}
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <div style={{ margin: '8px 0 4px 12px', fontSize: 10, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Адмін
              </div>
              {adminNav.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500,
                  color: isActive ? '#fff' : 'var(--text2)',
                  background: isActive ? 'var(--accent)' : 'transparent',
                  transition: 'all 0.15s', textDecoration: 'none',
                })}>
                  <Icon size={15} />{label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--accent-dim)', border: '1px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>
            {user?.username?.[0]?.toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{user?.username}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{user?.role}</div>
          </div>
          <button onClick={handleLogout} title="Вийти" style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        <Outlet />
      </main>
    </div>
  )
}
