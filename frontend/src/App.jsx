import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { useEffect } from 'react'
import { useAuthStore } from './store/auth'
import { getMe } from './api/client'
import Layout from './components/layout/Layout'
import LoginPage from './pages/Login'
import { DeleteOtpProvider } from './context/DeleteOtpContext'
import DashboardPage from './pages/Dashboard'
import DomainsPage from './pages/Domains'
import SettingsPage from './pages/Settings'
import SearchPage from './pages/Search'
import UsersPage from './pages/Users'
import KeitaroPage from './pages/Keitaro'
import LogsPage from './pages/Logs'
import SheetsPage from './pages/Sheets'
import PasswordsPage from './pages/Passwords'
import ProxiesPage from './pages/Proxies'
import BackupPage from './pages/Backup'
import PurchasesPage from './pages/Purchases'
import KumaPage from './pages/Kuma'
import IdentitiesPage from './pages/Identities'
import MailPage from './pages/Mail'
import ServicesPage from './pages/Services'
import CloudflarePage from './pages/Cloudflare'
import CheckPage from './pages/Check'
import NotesPage from './pages/Notes'
import ServersPage from './pages/Servers'
import PaymentsPage from './pages/Payments'

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30000 } } })

function RequireAuth({ children }) {
  const { token } = useAuthStore()
  return token ? children : <Navigate to="/check" replace />
}

function RequireAdmin({ children }) {
  const { user, token } = useAuthStore()
  if (token && !user) return null
  return user?.role === 'admin' ? children : <Navigate to="/domains" replace />
}

export default function App() {
  const { token, user, setUser, logout } = useAuthStore()

  useEffect(() => {
    if (!token || user) return
    getMe()
      .then(res => setUser(res.data))
      .catch(() => logout())
  }, [token])

  return (
    <QueryClientProvider client={qc}>
      <DeleteOtpProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/check" element={<CheckPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="domains"   element={<DomainsPage />} />
              <Route path="keitaro"   element={<KeitaroPage />} />
              <Route path="search"    element={<SearchPage />} />
              <Route path="sheets"    element={<SheetsPage />} />
              <Route path="proxies"   element={<ProxiesPage />} />
              <Route path="purchases" element={<PurchasesPage />} />
              <Route path="kuma"      element={<KumaPage />} />
              <Route path="identities" element={<IdentitiesPage />} />
              <Route path="mail"       element={<MailPage />} />
              <Route path="services"   element={<ServicesPage />} />
              <Route path="cloudflare" element={<CloudflarePage />} />
              <Route path="servers"    element={<ServersPage />} />
              <Route path="payments"   element={<PaymentsPage />} />
              <Route path="notes"      element={<NotesPage />} />
              <Route path="passwords" element={<RequireAdmin><PasswordsPage /></RequireAdmin>} />
              <Route path="backup"    element={<RequireAdmin><BackupPage /></RequireAdmin>} />
              <Route path="settings"  element={<RequireAdmin><SettingsPage /></RequireAdmin>} />
              <Route path="users"     element={<RequireAdmin><UsersPage /></RequireAdmin>} />
              <Route path="logs"      element={<RequireAdmin><LogsPage /></RequireAdmin>} />
            </Route>
            <Route path="*" element={<Navigate to="/check" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            style: { background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', fontFamily: 'var(--font)', fontSize: 13 },
            success: { iconTheme: { primary: 'var(--green)', secondary: 'var(--bg3)' } },
            error:   { iconTheme: { primary: 'var(--red)',   secondary: 'var(--bg3)' } },
          }}
        />
      </DeleteOtpProvider>
    </QueryClientProvider>
  )
}
