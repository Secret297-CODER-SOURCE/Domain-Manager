import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Cloud, BarChart2 } from 'lucide-react'
import { getDomains, getOrphanDomains } from '../api/client'
import { Badge, Spinner } from '../components/ui/index'

const STATUS_COLOR = { active: 'green', suspended: 'red', pending: 'yellow', unknown: 'default' }
const STATUS_UA = { active: 'Активний', suspended: 'Заблоковано', pending: 'Очікує', unknown: 'Невідомо' }

export default function SearchPage() {
  const [query, setQuery] = useState('')

  // CF domains — fast DB search
  const { data: cfResults = [], isLoading: cfLoading } = useQuery({
    queryKey: ['search-cf', query],
    queryFn: () => getDomains({ search: query, page_size: 50 }).then(r => r.data),
    enabled: query.length >= 2,
  })

  // KT-only domains — live search across all KT instances (parallel)
  const { data: ktResults = [], isLoading: ktLoading } = useQuery({
    queryKey: ['search-kt', query],
    queryFn: () => getOrphanDomains({ search: query }).then(r => r.data),
    enabled: query.length >= 3,
  })

  const isLoading = cfLoading || ktLoading
  const total = cfResults.length + ktResults.length

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ fontWeight: 800, fontSize: 22, marginBottom: 4 }}>Пошук</h1>
      <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 24 }}>
        Знайдіть домен — шукає по всіх CF акаунтах та всіх KT інстансах
      </p>

      <div style={{ position: 'relative', marginBottom: 24 }}>
        <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Введіть домен або частину домену..."
          autoFocus
          style={{ paddingLeft: 40, fontSize: 15, padding: '12px 16px 12px 40px' }}
        />
      </div>

      {isLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>}

      {!isLoading && query.length >= 2 && total === 0 && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)' }}>
          Домен «{query}» не знайдено ні в CF, ні в KT
        </div>
      )}

      {/* CF results */}
      {cfResults.length > 0 && (
        <>
          {ktResults.length > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)', marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Cloud size={12} /> Cloudflare ({cfResults.length})
            </div>
          )}
          {cfResults.map(d => (
            <DomainCard key={`cf-${d.id}`} d={d} source="cf" />
          ))}
        </>
      )}

      {/* KT-only results */}
      {ktResults.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)', margin: '16px 0 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <BarChart2 size={12} /> Тільки в Keitaro ({ktResults.length})
          </div>
          {ktResults.map(d => (
            <DomainCard key={`kt-${d.kt_domain_id}`} d={d} source="kt" />
          ))}
        </>
      )}

      {query.length < 2 && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text3)' }}>
          Введіть мінімум 2 символи для пошуку
        </div>
      )}
    </div>
  )
}

function DomainCard({ d, source }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 18px', marginBottom: 8,
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      borderLeft: source === 'kt' ? '3px solid var(--accent)' : '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
          {d.name || d.domain}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            <span style={{ color: 'var(--text2)' }}>{d.team_name}</span>
          </span>
          {source === 'cf' && d.cf_account_name && (
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Cloud size={11} /> <span style={{ color: 'var(--text2)' }}>{d.cf_account_name}</span>
            </span>
          )}
          {(d.keitaro_instance_name || d.instance_name) && (
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <BarChart2 size={11} /> <span style={{ color: 'var(--text2)' }}>{d.keitaro_instance_name || d.instance_name}</span>
              {(d.keitaro_group_name || d.group_name) && (
                <span style={{ color: 'var(--text3)' }}> / {d.keitaro_group_name || d.group_name}</span>
              )}
            </span>
          )}
          {source === 'kt' && (
            <Badge color="blue" style={{ fontSize: 10 }}>Тільки KT</Badge>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        {source === 'cf' && d.zone_status && (
          <Badge color={STATUS_COLOR[d.zone_status]}>{STATUS_UA[d.zone_status]}</Badge>
        )}
        {source === 'cf' && d.main_record_type && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>
            {d.main_record_type} → {d.main_record_value}
          </span>
        )}
      </div>
    </div>
  )
}
