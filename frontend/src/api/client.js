import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

// In-memory delete token (valid 5 min, cleared on page reload — intentional)
let _deleteToken = null
let _deleteTokenExpiry = 0

export function setDeleteToken(token) {
  _deleteToken = token
  _deleteTokenExpiry = Date.now() + 5 * 60 * 1000
}

export function hasValidDeleteToken() {
  return !!_deleteToken && Date.now() < _deleteTokenExpiry
}

export function clearDeleteToken() {
  _deleteToken = null
  _deleteTokenExpiry = 0
}

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  if (cfg.method === 'delete' && _deleteToken && Date.now() < _deleteTokenExpiry) {
    cfg.headers['X-Delete-Token'] = _deleteToken
  }
  return cfg
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

// Delete OTP
export const requestDeleteOtp = () => api.post('/auth/delete-otp/request')
export const verifyDeleteOtp = (code) => api.post('/auth/delete-otp/verify', { code })

// Telegram admins
export const getTgAdmins = () => api.get('/auth/tg-admins')
export const addTgAdmin = (data) => api.post('/auth/tg-admins', data)
export const deleteTgAdmin = (id) => api.delete(`/auth/tg-admins/${id}`)

// Auth
export const login = (username, password) => {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)
  return api.post('/auth/login', form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
}
export const getMe = () => api.get('/auth/me')
export const getUsers = () => api.get('/auth/users')
export const createUser = (data) => api.post('/auth/users', data)
export const deleteUser = (id) => api.delete(`/auth/users/${id}`)

// Teams
export const getTeams = () => api.get('/teams')
export const createTeam = (data) => api.post('/teams', data)
export const updateTeam = (id, data) => api.patch(`/teams/${id}`, data)
export const deleteTeam = (id) => api.delete(`/teams/${id}`)

// CF Accounts
export const getCFAccounts = (teamId) => api.get(`/teams/${teamId}/cf-accounts`)
export const getAllCFAccounts = () => api.get('/teams/cf-accounts-all')
export const createCFAccount = (teamId, data) => api.post(`/teams/${teamId}/cf-accounts`, data)
export const updateCFAccount = (teamId, id, data) => api.patch(`/teams/${teamId}/cf-accounts/${id}`, data)
export const deleteCFAccount = (teamId, id) => api.delete(`/teams/${teamId}/cf-accounts/${id}`)

// KT Instances
export const getKTInstances = (teamId) => api.get(`/teams/${teamId}/kt-instances`)
export const createKTInstance = (teamId, data) => api.post(`/teams/${teamId}/kt-instances`, data)
export const deleteKTInstance = (teamId, id) => api.delete(`/teams/${teamId}/kt-instances/${id}`)
export const updateKTInstance = (teamId, id, data) => api.patch(`/teams/${teamId}/kt-instances/${id}`, data)

// Domains
export const getDomains = (params) => api.get('/domains', { params })
export const deleteDomainFromCF = (id) => api.delete(`/domains/${id}/full-delete`)
export const bulkAbuseDelete = (domains) => api.post('/domains/bulk-abuse-delete', { domains })
export const getTeamStats = () => api.get('/domains/team-stats')
export const syncCFAccount = (cfAccountId) => api.post(`/domains/sync/${cfAccountId}`)
export const syncAll = () => api.post('/domains/sync-all')
export const bulkUpdateDns = (data) => api.post('/domains/bulk-dns', data)
export const addDomainsToCF = (data) => api.post('/domains/add-to-cf', data)
export const bulkDnsByName = (data) => api.post('/domains/bulk-dns-by-name', data)
export const getDnsRecords = (domainId) => api.get(`/domains/${domainId}/dns`)
export const createDnsRecord = (domainId, data) => api.post(`/domains/${domainId}/dns`, data)
export const deleteDnsRecord = (domainId, recordId) => api.delete(`/domains/${domainId}/dns/${recordId}`)
export const quickAddDomains = (data) => api.post('/domains/quick-add', data)
export const getAbuseAlerts = (limit = 50) => api.get('/domains/abuse-alerts', { params: { limit } })

// Logs
export const getLogs = (params) => api.get('/domains/logs', { params })
export const getCFAbuseReports = () => api.get('/domains/cf-abuse-reports')
export const getDeletedDomains = (limit) => api.get('/domains/deleted-domains', { params: { limit } })

// Keitaro
export const getKTInstances_all = () => api.get('/keitaro/instances')
export const getKTTree = () => api.get('/keitaro/tree')
export const bulkTransferKT = (data) => api.post('/keitaro/bulk-transfer', data)
export const getKTDomains = () => api.get('/keitaro/domains')
export const getKTGroups = () => api.get('/keitaro/groups')
export const getKTGroupsByInstance = (instanceId) => api.get(`/keitaro/groups/by-instance/${instanceId}`)
export const syncKTGroups = (instanceId) => api.post(`/keitaro/groups/sync/${instanceId}`)
export const syncAllKTGroups = () => api.post('/keitaro/groups/sync-all')
export const addDomainToKT = (data) => api.post('/keitaro/domain/add', data)
export const bulkAddToKT = (data) => api.post('/keitaro/bulk-add', data)
export const moveDomainInKT = (data) => api.post('/keitaro/domain/move', data)
export const deleteDomainFromKT = (domainId) => api.delete(`/keitaro/domain/${domainId}`)
export const getOrphanDomains = (params) => api.get('/keitaro/orphan-domains', { params })

// Spreadsheets
export const getSheets = () => api.get('/sheets')
export const createSheet = (data) => api.post('/sheets', data)
export const getSheet = (id) => api.get(`/sheets/${id}`)
export const updateSheet = (id, data) => api.patch(`/sheets/${id}`, data)
export const deleteSheet = (id) => api.delete(`/sheets/${id}`)
export const renameSheet = (id, name) => api.patch(`/sheets/${id}`, { name })

// KeePass vaults
export const getVaults = () => api.get('/keepass')
export const uploadVault = (name, file, rememberMaster) => {
  const fd = new FormData()
  fd.append('name', name)
  fd.append('file', file)
  if (rememberMaster) fd.append('remember_master', rememberMaster)
  return api.post('/keepass', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const getStoredMaster = (vaultId) => api.get(`/keepass/${vaultId}/master`)
export const setStoredMaster = (vaultId, password) => api.post(`/keepass/${vaultId}/master`, { password })
export const clearStoredMaster = (vaultId) => api.delete(`/keepass/${vaultId}/master`)
export const updateVaultBlob = (id, file) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.put(`/keepass/${id}/blob`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const downloadVaultBlob = (id) =>
  api.get(`/keepass/${id}/blob`, { responseType: 'arraybuffer' })
export const renameVault = (id, name) => api.patch(`/keepass/${id}`, { name })
export const deleteVault = (id) => api.delete(`/keepass/${id}`)
export const shareVault = (vaultId, userId, canEdit) =>
  api.post(`/keepass/${vaultId}/shares`, { user_id: userId, can_edit: canEdit })
export const unshareVault = (vaultId, userId) =>
  api.delete(`/keepass/${vaultId}/shares/${userId}`)

// Proxies
export const getProxies = () => api.get('/proxies')
export const createProxy = (data) => api.post('/proxies', data)
export const updateProxy = (id, data) => api.patch(`/proxies/${id}`, data)
export const deleteProxy = (id) => api.delete(`/proxies/${id}`)
export const bulkDeleteProxies = (ids) => api.post('/proxies/bulk-delete', { ids })
export const importProxies = (data) => api.post('/proxies/import', data)
export const testProxy = (id) => api.post(`/proxies/${id}/test`)
export const bulkTestProxies = (ids) => api.post('/proxies/bulk-test', { ids })

// Backup
export const getBackupConfig = () => api.get('/backup/config')
export const saveBackupConfig = (data) => api.put('/backup/config', data)
export const listBackupRuns = () => api.get('/backup/runs')
export const deleteBackupRun = (id) => api.delete(`/backup/runs/${id}`)
export const runBackup = (destinations) =>
  api.post(`/backup/run?destinations=${encodeURIComponent(destinations.join(','))}`, null, {
    responseType: destinations.includes('download') ? 'blob' : 'json',
  })
export const previewBackupRestore = (file, password) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('password', password || '')
  return api.post('/backup/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const doBackupRestore = (file, password, mode) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('password', password || '')
  fd.append('mode', mode)
  return api.post('/backup/restore', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
}

// Purchases
export const getPurchases = () => api.get('/purchases')
export const createPurchase = (data) => api.post('/purchases', data)
export const updatePurchase = (id, data) => api.patch(`/purchases/${id}`, data)
export const deletePurchase = (id) => api.delete(`/purchases/${id}`)

// Identities (fake-identity generator)
export const getIdentityLocations = () => api.get('/identities/locations')
export const generateIdentity = (loc = 'random') => api.post(`/identities/generate?loc=${encodeURIComponent(loc)}`)
export const generateIdentityBulk = (loc = 'random', count = 5) =>
  api.post(`/identities/generate-bulk?loc=${encodeURIComponent(loc)}&count=${count}`)
export const listSavedIdentities = () => api.get('/identities/saved')
export const saveIdentity = (data) => api.post('/identities/saved', data)
export const patchSavedIdentity = (id, data) => api.patch(`/identities/saved/${id}`, data)
export const deleteSavedIdentity = (id) => api.delete(`/identities/saved/${id}`)

// Uptime Kuma
export const getKumaInstances = () => api.get('/kuma')
export const createKumaInstance = (data) => api.post('/kuma', data)
export const updateKumaInstance = (id, data) => api.patch(`/kuma/${id}`, data)
export const deleteKumaInstance = (id) => api.delete(`/kuma/${id}`)

export default api
