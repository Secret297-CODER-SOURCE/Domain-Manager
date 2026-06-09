import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, X, Search } from 'lucide-react'
import { getLogs } from '../api/client'
import { Btn, Badge, Spinner } from '../components/ui/index'

const ACTION_LABELS = {
  cf_add_zone:    { label: 'Додано до CF',      color: 'green' },
  add_dns:        { label: 'DNS додано',         color: 'blue' },
  delete_dns:     { label: 'DNS видалено',       color: 'red' },
  delete_all_dns: { label: 'Всі DNS видалено',   color: 'red' },
  full_delete_cf: { label: 'Видалено з CF',      color: 'red' },
  bulk_dns:       { label: 'Масова зміна DNS',   color: 'yellow' },
  bulk_dns_by_name: { label: 'Масова DNS (ім\'я)', color: 'yellow' },
  kt_add:         { label: 'Додано до KT',       color: 'blue' },
  kt_move:        { label: 'Переміщено в KT',    color: 'yellow' },
  kt_delete:      { label: 'Видалено з KT',      color: 'red' },
}

const ALL_ACTIONS = Object.keys(ACTION_LABELS)

export default function LogsPage() {
  const [filters, setFilters] = useState({ domain: '', action: '', page: 1 })

  const { data: logs = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['logs', filters],
    queryFn: () => getLogs({ ...filters, page_size: 100 }).then(r => r.data),
    keepPreviousData: true,
  })

  function setFilter(key, val) {
    setFilters(f => ({ ...f, [key]: val, page: 1 }))
  }

  const hasFilters = filters.domain || filters.action

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontWeight: 800, fontSize: 22 }}>Логи дій</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>
            Зберігаються 7 днів · {logs.length} записів
          </p>
        </div>
        <Btn variant="ghost" onClick={() => refetch()} loading={isFetching}>
          <RefreshCw size={14} /> Оновити
        </Btn>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap',
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 12,
      }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', pointerEvents: 'none' }} />
          <input
            placeholder="Домен..."
            value={filters.domain}
            onChange={e => setFilter('domain', e.target.value)}
            style={{ paddingLeft: 30, width: '100%' }}
          />
        </div>
        <select
          value={filters.action}
          onChange={e => setFilter('action', e.target.value)}
          style={{ flex: '1 1 180px' }}
        >
          <option value="">Всі дії</option>
          {ALL_ACTIONS.map(a => (
            <option key={a} value={a}>{ACTION_LABELS[a]?.label || a}</option>
          ))}
        </select>
        {hasFilters && (
          <Btn size="sm" variant="ghost" onClick={() => setFilters({ domain: '', action: '', page: 1 })}>
            <X size={13} /> Очистити
          </Btn>
        )}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', flex: 1 }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
        ) : logs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text3)', fontSize: 13 }}>
            Логів немає
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Час', 'Дія', 'Домен', 'Користувач', 'Деталі'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <LogRow key={log.id} log={log} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function LogRow({ log }) {
  const meta = ACTION_LABELS[log.action]
  const date = new Date(log.created_at)
  const dateStr = date.toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <td style={{ padding: '7px 12px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{dateStr}</td>
      <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
        {meta
          ? <Badge color={meta.color}>{meta.label}</Badge>
          : <Badge color="default">{log.action}</Badge>
        }
      </td>
      <td style={{ padding: '7px 12px', fontWeight: 600, color: 'var(--text)' }}>
        {log.domain || <span style={{ color: 'var(--text3)' }}>—</span>}
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text2)' }}>
        {log.user || <span style={{ color: 'var(--text3)' }}>system</span>}
      </td>
      <td style={{ padding: '7px 12px', color: 'var(--text3)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {log.details || '—'}
      </td>
    </tr>
  )
}
