import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  AlertTriangle, CheckCircle, Clock, RefreshCw, Copy, Trash2, Cloud, ShieldOff,
  Info, FileText, Sparkles, BarChart3, TrendingDown, TrendingUp, Users, Globe,
  Activity, Flame, ShoppingBag, Layers, Calendar, Inbox, Network, Server,
  Wallet, CalendarClock, Award, Skull, LineChart,
} from 'lucide-react'
import {
  getAbuseAlerts, getCFAbuseReports, bulkAbuseDelete, getDeletedDomains,
  getStatsOverview, getBanReasons,
} from '../api/client'
import { Btn, Badge, Spinner } from '../components/ui/index'
import AnimatedIcon from '../components/ui/AnimatedIcon'
import { useAuthStore } from '../store/auth'

export default function DashboardPage() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, height: '100%', overflow: 'auto' }}>
      <StatisticsSection />

      <AbuseWidget />

      {isAdmin && (
        <AutoDeletedCard />
      )}
    </div>
  )
}


// ── Abuse Widget ──────────────────────────────────────────────────────────
// Unified feed: live CF abuse-reports + auto-detected "suspended" /
// "recovered" transitions, merged into one chronological list so there's
// a single place to see & act on abuse instead of two disconnected tabs.
function AbuseWidget() {
  const { data: alerts = [], isLoading: internalLoading, refetch: refetchInternal } = useQuery({
    queryKey: ['abuse-alerts'],
    queryFn: () => getAbuseAlerts(50).then(r => r.data),
    staleTime: 120000,
  })

  const { data: cfReports = [], isLoading: cfLoading, refetch: refetchCF } = useQuery({
    queryKey: ['cf-abuse-reports'],
    queryFn: () => getCFAbuseReports().then(r => r.data),
    staleTime: 300000,
  })

  const suspendedCount = alerts.filter(a => a.new_status === 'suspended').length
  const loading = internalLoading || cfLoading

  function refetchAll() { refetchCF(); refetchInternal() }

  const items = [
    ...cfReports.map((r, i) => ({
      key: `cf-${r.id ?? i}`, kind: 'cf', domain: r.domain, ts: r.created_at,
      cf_account: r.cf_account, type: r.type, status: r.status, mitigation: r.mitigation,
    })),
    ...alerts.filter(a => a.new_status === 'suspended').map(a => ({
      key: `sus-${a.id}`, kind: 'suspended', domain: a.domain_name, ts: a.created_at,
      team: a.team_name, dns_deleted: a.dns_deleted,
    })),
    ...alerts.filter(a => a.new_status === 'active').map(a => ({
      key: `rec-${a.id}`, kind: 'recovered', domain: a.domain_name, ts: a.created_at,
      team: a.team_name,
    })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts))

  // Domains still actionable (present in CF or still suspended) — de-duped
  // for the bulk-delete button. Recovered domains don't need cleanup.
  const actionableDomains = [...new Set(
    items.filter(it => it.kind !== 'recovered').map(it => it.domain)
  )]

  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        <StatCard label="CF Абузи" value={cfReports.length} color="red" icon={<AnimatedIcon icon={AlertTriangle} size={14} anim="flash" />} />
        <StatCard label="Suspended" value={suspendedCount} color="red" icon={<AnimatedIcon icon={ShieldOff} size={14} anim="pulse" />} />
      </div>

      {/* Panel */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>
            <ShieldOff size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--red)' }} />
            Абузи та бани {items.length > 0 && `(${items.length})`}
          </span>
          <Btn size="sm" variant="ghost" loading={loading} onClick={refetchAll}>
            <RefreshCw size={11} />
          </Btn>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner /></div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text3)', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}>
            <Sparkles size={13} style={{ color: 'var(--green)' }} /> Абуз і банів немає
          </div>
        ) : (
          <>
            {actionableDomains.length > 0 && (
              <BulkAbuseDeleteBtn domains={actionableDomains} onDone={refetchAll} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 460, overflowY: 'auto' }}>
              {items.map(it => <AbuseRow key={it.key} item={it} onDeleted={refetchAll} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function BulkAbuseDeleteBtn({ domains, onDone }) {
  const [loading, setLoading] = useState(false)

  async function deleteAll() {
    if (!window.confirm(`Видалити всі ${domains.length} доменів з CF?`)) return
    setLoading(true)
    try {
      const r = await bulkAbuseDelete(domains)
      const ok = r.data.results.filter(x => x.ok).length
      const fail = r.data.results.filter(x => !x.ok).length
      toast.success(`Видалено: ${ok}${fail ? ` · не знайдено в БД: ${fail}` : ''}`)
      onDone?.()
    } catch { toast.error('Помилка видалення') }
    finally { setLoading(false) }
  }

  return (
    <Btn variant="danger" size="sm" loading={loading} onClick={deleteAll}
      style={{ alignSelf: 'flex-start', marginBottom: 4 }}>
      <Trash2 size={12} /> Видалити всі ({domains.length})
    </Btn>
  )
}

function AbuseRow({ item, onDeleted }) {
  const [deleting, setDeleting] = useState(false)
  const statusColor = { open: 'red', closed: 'default', resolved: 'green', 'in-review': 'yellow' }
  const date = new Date(item.ts)
  const dateStr = date.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const deletable = item.kind === 'cf' || item.kind === 'suspended'
  const tone = item.kind === 'recovered' ? 'green' : 'red'

  async function handleDelete() {
    setDeleting(true)
    try {
      await bulkAbuseDelete([item.domain])
      toast.success(`${item.domain} видалено`)
      onDeleted?.()
    } catch (e) {
      const detail = e.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Помилка видалення')
    } finally { setDeleting(false) }
  }

  return (
    <div style={{
      background: tone === 'red' ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
      border: `1px solid ${tone === 'red' ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
      borderRadius: 7, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.domain}
        </span>
        {item.kind === 'cf' && <Badge color={statusColor[item.status] || 'default'}>CF: {item.status || '?'}</Badge>}
        {item.kind === 'suspended' && <Badge color="red">403 suspended</Badge>}
        {item.kind === 'recovered' && <Badge color="green">200 recovered</Badge>}
        {deletable && (
          <Btn size="sm" variant="danger" loading={deleting} onClick={handleDelete} title="Видалити з CF">
            <Trash2 size={11} />
          </Btn>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text3)', flexWrap: 'wrap' }}>
        <span><Clock size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />{dateStr}</span>
        {item.team && <span>· {item.team}</span>}
        {item.cf_account && <span>· {item.cf_account}</span>}
        {item.type && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={10} /> {item.type}</span>}
        {item.dns_deleted && (
          <Badge color="red">
            <AnimatedIcon icon={Trash2} size={10} anim="shake" /> DNS видалено
          </Badge>
        )}
      </div>
    </div>
  )
}

// ── Statistics Section ────────────────────────────────────────────────────

function StatisticsSection() {
  const [days, setDays] = useState(30)
  const { data: stats, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['stats-overview', days],
    queryFn: () => getStatsOverview(days).then(r => r.data),
    staleTime: 60000,
  })
  const { data: reasons } = useQuery({
    queryKey: ['ban-reasons'],
    queryFn: () => getBanReasons().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
            color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <AnimatedIcon icon={BarChart3} size={18} anim="glow" />
          </div>
          <div>
            <h1 style={{ fontWeight: 800, fontSize: 22, margin: 0, lineHeight: 1.1 }}>Огляд</h1>
            <div style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
              Бани, домени, команди та закупки — за вікно {days} днів
            </div>
          </div>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                border: 'none', cursor: 'pointer',
                background: d === days ? 'var(--accent)' : 'transparent',
                color: d === days ? '#fff' : 'var(--text3)',
                transition: 'all 0.15s',
              }}>{d}д</button>
          ))}
          <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
          <Btn size="sm" variant="ghost" loading={isFetching} onClick={() => refetch()}>
            <RefreshCw size={12} />
          </Btn>
        </div>
      </div>

      {isLoading || !stats ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : (
        <>
          {/* Hero stats row: donut + big numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2fr)', gap: 14 }}>
            <DomainStatusDonutCard totals={stats.totals} />
            <TopStatsGrid stats={stats} />
          </div>
          {/* Domains analytics */}
          <SectionTitle icon={Globe} label="Домени" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
            <BanTimelineCard timeline={stats.timeline} days={days} />
            <DomainGrowthCard growth={stats.domain_growth} />
            <BanReasonsCard reasons={reasons} />
            <TopSuspendedCard items={stats.top_suspended} />
            <CFAccountsCard accounts={stats.by_cf_account} />
            <TLDCard tlds={stats.by_tld} />
          </div>

          {/* Teams analytics */}
          <SectionTitle icon={Users} label="Команди" />
          <TeamLeaderboardCard teams={stats.by_team} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            {stats.by_team.map(t => <TeamDetailCard key={t.id} team={t} days={days} />)}
          </div>

          {/* Purchases analytics */}
          <SectionTitle icon={ShoppingBag} label="Закупки" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
            <PurchasesCard purchases={stats.purchases} />
            <SpendByMonthCard months={stats.purchases.spend_by_month} />
            <SpendBreakdownCard purchases={stats.purchases} />
          </div>

          {/* Infrastructure */}
          <SectionTitle icon={Network} label="Інфраструктура" />
          <InfraGrid infra={stats.infra} totals={stats.totals} />
        </>
      )}
    </div>
  )
}

function TopStatsGrid({ stats }) {
  const { totals, bans, deletions } = stats
  const items = [
    { label: 'Домени', value: totals.domains, icon: Globe,    color: 'blue',  anim: 'glow' },
    { label: 'Команди', value: totals.teams, sub: `CF: ${totals.cf_accounts} · Dyn: ${totals.dynadot_accounts}`, icon: Users, color: 'purple', anim: 'pulse' },
    { label: `Банів за ${stats.window_days}д`, value: bans.last_30d, sub: `24г: ${bans.last_24h} · 7д: ${bans.last_7d}`, icon: Flame, color: 'red', anim: 'shake' },
    { label: `Видалено за ${stats.window_days}д`, value: deletions.last_30d, sub: `24г: ${deletions.last_24h}`, icon: Trash2, color: 'orange', anim: 'bounce' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, alignContent: 'stretch' }}>
      {items.map((it, i) => <BigStatCard key={i} {...it} delay={i * 120} />)}
    </div>
  )
}

// ── Domain status donut chart ────────────────────────────────────────────

function DomainStatusDonutCard({ totals }) {
  const segments = [
    { label: 'Active',    value: totals.active,    color: 'var(--green)' },
    { label: 'Suspended', value: totals.suspended, color: 'var(--red)' },
    { label: 'Pending',   value: totals.pending,   color: 'var(--yellow)' },
  ]
  const sum = segments.reduce((s, x) => s + x.value, 0) || 1
  // SVG arc geometry
  const R = 60, CX = 80, CY = 80, STROKE = 18
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = segments.map(s => {
    const frac = s.value / sum
    const dash = frac * C
    const node = {
      ...s,
      pct: Math.round((s.value / (totals.domains || 1)) * 100),
      dasharray: `${dash} ${C - dash}`,
      dashoffset: -offset,
    }
    offset += dash
    return node
  })

  const healthy = totals.domains
    ? Math.round((totals.active / totals.domains) * 100)
    : 0
  const healthColor = healthy >= 90 ? 'var(--green)' : healthy >= 70 ? 'var(--yellow)' : 'var(--red)'

  return (
    <PanelCard title="Статус доменів" icon={Sparkles} anim="glow">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <svg width="160" height="160" viewBox="0 0 160 160" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--bg3)" strokeWidth={STROKE} />
            {totals.domains > 0 && arcs.map((a, i) => (
              <circle key={i}
                cx={CX} cy={CY} r={R} fill="none"
                stroke={a.color} strokeWidth={STROKE} strokeLinecap="butt"
                strokeDasharray={a.dasharray} strokeDashoffset={a.dashoffset}
                style={{ transition: 'stroke-dasharray 0.8s ease-out, stroke-dashoffset 0.8s ease-out' }}
              />
            ))}
          </svg>
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexDirection: 'column', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: healthColor, lineHeight: 1 }}>
              {totals.domains > 0 ? `${healthy}%` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
              healthy
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segments.map(s => {
            const pct = totals.domains ? Math.round((s.value / totals.domains) * 100) : 0
            return (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0,
                  boxShadow: `0 0 6px ${s.color}` }} />
                <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{s.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{pct}%</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: s.color, minWidth: 36, textAlign: 'right' }}>{s.value}</span>
              </div>
            )
          })}
          <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
            <span>Всього</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 700 }}>{totals.domains}</span>
          </div>
        </div>
      </div>
    </PanelCard>
  )
}

function BigStatCard({ label, value, sub, icon, color, anim, delay }) {
  const palette = {
    blue:   { bg: 'rgba(79,110,247,0.10)',  border: 'rgba(79,110,247,0.30)',  fg: 'var(--accent)' },
    green:  { bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)',   fg: 'var(--green)' },
    red:    { bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)',   fg: 'var(--red)' },
    orange: { bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)',  fg: 'var(--yellow)' },
    purple: { bg: 'rgba(168,85,247,0.10)',  border: 'rgba(168,85,247,0.25)',  fg: '#a855f7' },
  }
  const c = palette[color] || palette.blue
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.fg }}>
        <AnimatedIcon icon={icon} size={14} anim={anim} delay={delay} />
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: c.fg, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

function PanelCard({ title, icon: Icon, anim, children, action }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 220,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AnimatedIcon icon={Icon} size={14} color="var(--accent)" anim={anim || 'pulse'} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function BanTimelineCard({ timeline, days }) {
  // Fill in zero days so the chart shows a real timeline.
  const map = new Map(timeline.map(t => [t.date, t]))
  const filled = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const t = map.get(key) || { date: key, suspended: 0, recovered: 0, deleted: 0 }
    filled.push(t)
  }
  const max = Math.max(1, ...filled.map(t => Math.max(t.suspended, t.deleted)))
  const w = 100 / filled.length

  return (
    <PanelCard title={`Бани & видалення за ${days}д`} icon={Activity} anim="pulse">
      {filled.every(t => !t.suspended && !t.deleted) ? (
        <Empty text="Немає банів за цей період" icon={CheckCircle} color="var(--green)" />
      ) : (
        <>
          <svg viewBox="0 0 100 50" preserveAspectRatio="none" style={{ width: '100%', height: 120 }}>
            {filled.map((t, i) => {
              const h1 = (t.suspended / max) * 45
              const h2 = (t.deleted / max) * 45
              return (
                <g key={i}>
                  <rect x={i * w + w * 0.1} y={50 - h1} width={w * 0.4}
                    height={h1} fill="var(--red)" opacity="0.85">
                    <title>{t.date}: {t.suspended} банів</title>
                  </rect>
                  <rect x={i * w + w * 0.5} y={50 - h2} width={w * 0.4}
                    height={h2} fill="var(--yellow)" opacity="0.7">
                    <title>{t.date}: {t.deleted} видалено</title>
                  </rect>
                </g>
              )
            })}
          </svg>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text3)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--red)', borderRadius: 2 }} /> бани
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--yellow)', borderRadius: 2 }} /> видалено
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Calendar size={11} /> {filled[0].date} → {filled.at(-1).date}
            </span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

function BanReasonsCard({ reasons }) {
  return (
    <PanelCard title="Причини банів (CF abuse reports)" icon={Flame} anim="flash">
      {!reasons ? <Spinner /> : reasons.total === 0 ? (
        <Empty text="Жодного відкритого abuse-репорту" icon={CheckCircle} color="var(--green)" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            Всього abuse-репортів: <strong style={{ color: 'var(--red)' }}>{reasons.total}</strong>
          </div>
          {reasons.by_type.map((r, i) => (
            <RankBar key={r.type} label={r.type} value={r.count} max={reasons.by_type[0].count} color="var(--red)" delay={i * 80} />
          ))}
          {reasons.by_cf_account.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
                По CF акаунтах
              </div>
              {reasons.by_cf_account.slice(0, 5).map((r, i) => (
                <RankBar key={r.name} label={r.name} value={r.count} max={reasons.by_cf_account[0].count} color="var(--accent)" delay={i * 80} />
              ))}
            </>
          )}
        </div>
      )}
    </PanelCard>
  )
}

function TeamLeaderboardCard({ teams }) {
  const sorted = [...teams].sort((a, b) => b.bans_in_window - a.bans_in_window)
  return (
    <PanelCard title="Команди — де банить найбільше" icon={Users} anim="pulse">
      {!teams.length ? <Empty text="Немає команд" icon={Info} /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {['Команда', 'Всього', 'Suspended', 'Бани', 'Ban %'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(t => (
                <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{t.name}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)' }}>{t.total}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)', color: t.suspended ? 'var(--red)' : 'var(--text3)' }}>{t.suspended}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {t.bans_in_window > 0
                      ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>{t.bans_in_window}</span>
                      : <span style={{ color: 'var(--text3)' }}>0</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <Heat pct={t.ban_rate_pct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  )
}

function CFAccountsCard({ accounts }) {
  // Include any account with suspended OR live abuse-reports — otherwise the
  // panel is empty even when CF has open reports against our domains.
  const top = accounts
    .filter(a => (a.suspended || 0) > 0 || (a.abuse_reports || 0) > 0)
    .slice(0, 8)
  return (
    <PanelCard title="CF акаунти — проблемні" icon={Cloud} anim="pulse">
      {top.length === 0 ? <Empty text="Жоден CF акаунт без проблемних зон" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {top.map((a) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {a.team || '—'} · {a.total} доменів
                </div>
              </div>
              {a.suspended > 0 && (
                <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700 }}>
                  {a.suspended} susp
                </span>
              )}
              {a.abuse_reports > 0 && (
                <span style={{ fontSize: 12, color: 'var(--yellow)', fontWeight: 700 }}>
                  {a.abuse_reports} abuse
                </span>
              )}
              <Heat pct={a.ban_rate_pct} />
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  )
}

function TLDCard({ tlds }) {
  const banned = tlds.filter(t => t.suspended > 0).slice(0, 10)
  return (
    <PanelCard title="TLD з найвищою ban-rate" icon={Layers} anim="pulse">
      {banned.length === 0 ? <Empty text="Немає банів по TLD" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {banned.map((t, i) => (
            <RankBar key={t.tld} label={`.${t.tld}`}
              value={t.suspended} max={banned[0].suspended}
              right={<span style={{ fontSize: 11, color: 'var(--text3)' }}>{t.ban_rate_pct}% ({t.total})</span>}
              color="var(--red)" delay={i * 80} />
          ))}
        </div>
      )}
    </PanelCard>
  )
}

function PurchasesCard({ purchases }) {
  const total = purchases.total
  return (
    <PanelCard title="Закупки" icon={ShoppingBag} anim="bounce">
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>Всього</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{total}</div>
        </div>
        <div style={{ flex: 1, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>За вікно</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>{purchases.recent}</div>
        </div>
      </div>
      {purchases.by_category.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>По категоріях</div>
          {purchases.by_category.map((c, i) => (
            <RankBar key={c.category} label={c.category} value={c.count}
              max={purchases.by_category[0].count} color="var(--accent)" delay={i * 60} />
          ))}
        </div>
      )}
      {purchases.by_status.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {purchases.by_status.map(s => {
            const tone = s.status === 'active' ? 'green' : s.status === 'expired' ? 'red' : 'default'
            return <Badge key={s.status} color={tone}>{s.status}: {s.count}</Badge>
          })}
        </div>
      )}
    </PanelCard>
  )
}

function RankBar({ label, value, max, color, right, delay = 0 }) {
  const pct = max ? Math.max(4, (value / max) * 100) : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {right || <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{value}</span>}
      </div>
      <div style={{ background: 'var(--bg3)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color,
          borderRadius: 4, transition: `width 0.6s ${delay}ms ease-out`,
        }} />
      </div>
    </div>
  )
}

function Heat({ pct }) {
  const p = pct || 0
  const color = p > 30 ? 'var(--red)' : p > 10 ? 'var(--yellow)' : p > 0 ? 'var(--accent)' : 'var(--text3)'
  return (
    <span style={{
      fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color,
      padding: '2px 8px', borderRadius: 4,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      minWidth: 50, textAlign: 'center', display: 'inline-block',
    }}>{p}%</span>
  )
}

function Empty({ text, icon: Icon = Info, color = 'var(--text3)' }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 8, padding: 24, color: 'var(--text3)',
      fontSize: 12, flex: 1,
    }}>
      <AnimatedIcon icon={Icon} size={22} color={color} anim="pulse" />
      {text}
    </div>
  )
}

// ── Section title ─────────────────────────────────────────────────────────

function SectionTitle({ icon: Icon, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginTop: 4,
      paddingTop: 8,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
        color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <AnimatedIcon icon={Icon} size={14} anim="pulse" />
      </div>
      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  )
}

// ── Domain growth (12-mo line chart) ─────────────────────────────────────

function DomainGrowthCard({ growth }) {
  // Fill missing months with zero
  const map = new Map(growth.map(g => [g.month, g.count]))
  const now = new Date()
  const series = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    series.push({ key, label: d.toLocaleString('uk-UA', { month: 'short' }), v: map.get(key) || 0 })
  }
  const max = Math.max(1, ...series.map(s => s.v))
  const total = series.reduce((a, b) => a + b.v, 0)

  // Build smooth line path
  const W = 320, H = 90, P = 4
  const xStep = (W - P * 2) / Math.max(1, series.length - 1)
  const points = series.map((s, i) => ({
    x: P + i * xStep,
    y: H - P - (s.v / max) * (H - P * 2),
  }))
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${points.at(-1).x} ${H - P} L${points[0].x} ${H - P} Z`

  return (
    <PanelCard title="Зростання доменів (12 міс)" icon={LineChart} anim="glow">
      {total === 0 ? <Empty text="Ще немає доменів" icon={Info} /> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 110 }}>
            <defs>
              <linearGradient id="grad-grow" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.42" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#grad-grow)" />
            <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={series[i].v > 0 ? 2.5 : 0} fill="var(--accent)">
                <title>{series[i].key}: {series[i].v}</title>
              </circle>
            ))}
          </svg>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: -4 }}>
            {series.filter((_, i) => i % 2 === 0).map(s => <span key={s.key}>{s.label}</span>)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span>Додано за рік</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700 }}>{total}</span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

// ── Top suspended ─────────────────────────────────────────────────────────

function TopSuspendedCard({ items }) {
  return (
    <PanelCard title="Проблемні домени" icon={Skull} anim="shake">
      {items.length === 0 ? <Empty text="Нічого не забанено" icon={CheckCircle} color="var(--green)" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
          {items.map((it, i) => {
            const isReport = (it.source || '').startsWith('abuse-report')
            const reportType = isReport ? it.source.split(':')[1] : null
            return (
              <div key={it.id ?? i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: isReport ? 'rgba(245,158,11,0.06)' : 'rgba(239,68,68,0.06)',
                border: `1px solid ${isReport ? 'rgba(245,158,11,0.20)' : 'rgba(239,68,68,0.18)'}`,
                borderRadius: 7, padding: '7px 10px',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                    color: isReport ? 'var(--yellow)' : 'var(--red)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.domain}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    {it.team || '—'} · {it.cf_account || '—'}
                  </div>
                </div>
                {reportType && (
                  <Badge color="yellow">{reportType}</Badge>
                )}
                {!isReport && <Badge color="red">suspended</Badge>}
                <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                  {it.suspended_at ? new Date(it.suspended_at).toLocaleString('uk-UA',
                    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </PanelCard>
  )
}

// ── Per-team detail (sparkline + counts) ─────────────────────────────────

function TeamDetailCard({ team, days }) {
  const max = Math.max(1, ...team.sparkline)
  const W = 220, H = 36, P = 2
  const xStep = (W - P * 2) / Math.max(1, team.sparkline.length - 1)
  const pts = team.sparkline.map((v, i) => ({
    x: P + i * xStep,
    y: H - P - (v / max) * (H - P * 2),
  }))
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const heatColor = team.ban_rate_pct > 30 ? 'var(--red)'
    : team.ban_rate_pct > 10 ? 'var(--yellow)'
    : team.ban_rate_pct > 0 ? 'var(--accent)' : 'var(--green)'

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: heatColor,
      }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingLeft: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{team.name}</span>
        <Heat pct={team.ban_rate_pct} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, paddingLeft: 6 }}>
        <MiniStat label="Домени" value={team.total} />
        <MiniStat label="Suspended" value={team.suspended} color="var(--red)" />
        <MiniStat label={`Бани ${days}д`} value={team.bans_in_window} color="var(--red)" />
        <MiniStat label="Active" value={team.active} color="var(--green)" />
        <MiniStat label="CF" value={team.cf_accounts} color="var(--accent)" />
        <MiniStat label="KT" value={team.kt_instances} color="var(--accent)" />
      </div>
      <div>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em',
          marginBottom: 4, paddingLeft: 6 }}>
          Бани за {days}д
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 36 }}>
          <path d={linePath} fill="none" stroke={team.bans_in_window > 0 ? 'var(--red)' : 'var(--text3)'} strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  )
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 800, color: color || 'var(--text)', lineHeight: 1.1 }}>{value}</span>
    </div>
  )
}

// ── Spend by month ───────────────────────────────────────────────────────

function SpendByMonthCard({ months }) {
  // Fill last 6 months
  const map = new Map(months.map(m => [m.month, m.amount]))
  const now = new Date()
  const series = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    series.push({ key, label: d.toLocaleString('uk-UA', { month: 'short' }), v: map.get(key) || 0 })
  }
  const max = Math.max(1, ...series.map(s => s.v))
  const total = series.reduce((a, b) => a + b.v, 0)

  return (
    <PanelCard title="Витрати за 6 місяців" icon={TrendingUp} anim="bounce">
      {total === 0 ? <Empty text="Витрат ще не записано" icon={Wallet} /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
            {series.map((s, i) => {
              const h = (s.v / max) * 100
              return (
                <div key={s.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: '100%', flex: 1,
                    display: 'flex', alignItems: 'flex-end',
                  }}>
                    <div style={{
                      width: '100%',
                      height: `${h}%`,
                      background: `linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 30%, transparent))`,
                      borderRadius: '6px 6px 2px 2px',
                      transition: `height 0.6s ${i * 90}ms ease-out`,
                      minHeight: s.v > 0 ? 4 : 0,
                    }} title={`${s.key}: ${s.v.toFixed(2)}`} />
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{s.label}</span>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11,
            borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span style={{ color: 'var(--text3)' }}>Сума за 6 міс</span>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 800, color: 'var(--accent)' }}>
              {total.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </PanelCard>
  )
}

// ── Spend breakdown (currency + category) ────────────────────────────────

function SpendBreakdownCard({ purchases }) {
  const cur = purchases.spend_by_currency || []
  const cat = purchases.spend_by_category || []
  const empty = cur.length === 0 && cat.length === 0
  return (
    <PanelCard title="Витрати — деталізація" icon={Wallet} anim="glow">
      {empty ? <Empty text="Витрат не записано" icon={Wallet} /> : (
        <>
          {cur.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                По валютах
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {cur.map(c => (
                  <div key={c.currency} style={{
                    background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{c.currency}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>
                      {c.amount.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {cat.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6 }}>
                По категоріях
              </div>
              {cat.map((c, i) => (
                <RankBar key={c.category} label={c.category} value={c.amount}
                  max={cat[0].amount} color="var(--accent)"
                  right={<span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                    {c.amount.toFixed(2)}
                  </span>}
                  delay={i * 60} />
              ))}
            </>
          )}
          {purchases.expiring_soon_30d > 0 && (
            <div style={{
              marginTop: 4, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <AnimatedIcon icon={CalendarClock} size={14} color="var(--yellow)" anim="pulse" />
              <span style={{ fontSize: 12 }}>
                <strong style={{ color: 'var(--yellow)' }}>{purchases.expiring_soon_30d}</strong> закупок завершуються у наступні 30 днів
              </span>
            </div>
          )}
        </>
      )}
    </PanelCard>
  )
}

// ── Infrastructure grid ──────────────────────────────────────────────────

function InfraGrid({ infra, totals }) {
  const items = [
    { label: 'Mail акаунти', value: infra.mail_total, icon: Inbox, color: 'blue', anim: 'pulse' },
    { label: 'Проксі', value: infra.proxies_total, sub: `активні: ${infra.proxies_active} · ok: ${infra.proxies_ok}`, icon: Network, color: 'purple', anim: 'glow' },
    { label: 'Сервери', value: infra.servers_total, sub: `ok: ${infra.servers_ok}`, icon: Server, color: 'green', anim: 'pulse' },
    { label: 'Особистості', value: infra.identities_total, icon: Sparkles, color: 'purple', anim: 'pulse' },
    { label: 'KT інстанси', value: infra.kt_instances, icon: BarChart3, color: 'orange', anim: 'pulse' },
    { label: 'CF акаунти', value: totals.cf_accounts, icon: Cloud, color: 'orange', anim: 'glow' },
    { label: 'Dynadot акаунти', value: totals.dynadot_accounts, icon: Globe, color: 'blue', anim: 'pulse' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      {items.map((it, i) => <BigStatCard key={i} {...it} delay={i * 100} />)}
    </div>
  )
}

function StatCard({ label, value, color, icon }) {
  const colors = {
    red: { bg: 'var(--red-dim)', border: 'rgba(239,68,68,0.25)', text: 'var(--red)' },
    green: { bg: 'var(--green-dim)', border: 'rgba(34,197,94,0.25)', text: 'var(--green)' },
  }
  const c = colors[color] || colors.red
  return (
    <div style={{
      flex: 1, background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: c.text, marginBottom: 4 }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: c.text }}>{value}</div>
    </div>
  )
}

// ── Auto-Deleted Domains Card ─────────────────────────────────────────────
function AutoDeletedCard() {
  const [filterTeam, setFilterTeam] = useState('')

  const { data: deleted = [], isLoading, refetch } = useQuery({
    queryKey: ['deleted-domains'],
    queryFn: () => getDeletedDomains(500).then(r => r.data),
    staleTime: 30000,
  })

  // Group by team
  const byTeam = deleted.reduce((acc, d) => {
    const t = d.team || '—'
    if (!acc[t]) acc[t] = []
    acc[t].push(d)
    return acc
  }, {})
  const teams = Object.keys(byTeam).sort()
  const displayed = filterTeam ? (byTeam[filterTeam] || []) : deleted

  return (
    <div style={{ flex: 2, minWidth: 300, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AnimatedIcon icon={Trash2} size={14} color="var(--red)" anim="pulse" />
          Видалені домени ({deleted.length})
        </div>
        <Btn size="sm" variant="ghost" loading={isLoading} onClick={() => refetch()}><RefreshCw size={11} /></Btn>
      </div>

      {/* Team filter */}
      {teams.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            onClick={() => setFilterTeam('')}
            style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: !filterTeam ? 'var(--accent)' : 'var(--bg3)', color: !filterTeam ? '#fff' : 'var(--text3)' }}>
            Всі
          </button>
          {teams.map(t => (
            <button key={t}
              onClick={() => setFilterTeam(t === filterTeam ? '' : t)}
              style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: filterTeam === t ? 'var(--accent)' : 'var(--bg3)', color: filterTeam === t ? '#fff' : 'var(--text3)' }}>
              {t} ({byTeam[t].length})
            </button>
          ))}
        </div>
      )}

      {isLoading ? <Spinner /> : deleted.length === 0 ? (
        <p style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>Видалень ще не було</p>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg2)' }}>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Домен', 'Команда', 'CF Акаунт', 'Дата'].map(h => (
                  <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 10px', fontWeight: 600, color: 'var(--red)' }}>{d.domain}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text2)' }}>{d.team}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text3)', fontSize: 11 }}>{d.cf_account}</td>
                  <td style={{ padding: '5px 10px', color: 'var(--text3)', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {new Date(d.deleted_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
