import { createContext, useContext, useRef, useState, useCallback } from 'react'
import toast from 'react-hot-toast'
import { requestDeleteOtp, verifyDeleteOtp, setDeleteToken, hasValidDeleteToken } from '../api/client'
import { Btn, Modal } from '../components/ui/index'

const DeleteOtpContext = createContext(null)

export function DeleteOtpProvider({ children }) {
  const [state, setState] = useState({
    open: false,
    sending: false,
    verifying: false,
    code: '',
    error: null,
  })
  const pendingRef = useRef(null)
  const resolveRef = useRef(null)
  const rejectRef = useRef(null)

  // gateDelete(action) — returns a promise.
  // If token is fresh: runs action immediately.
  // Otherwise: shows OTP modal, waits for user to verify, then runs action.
  const gateDelete = useCallback(async (action) => {
    if (hasValidDeleteToken()) {
      return action()
    }
    return new Promise((resolve, reject) => {
      pendingRef.current = action
      resolveRef.current = resolve
      rejectRef.current = reject
      setState({ open: true, sending: true, verifying: false, code: '', error: null })
      requestDeleteOtp()
        .then(() => setState(s => ({ ...s, sending: false })))
        .catch(() => {
          setState({ open: false, sending: false, verifying: false, code: '', error: null })
          reject(new Error('Не вдалося надіслати OTP'))
          toast.error('Не вдалося надіслати код в Telegram')
        })
    })
  }, [])

  async function handleVerify() {
    const code = state.code.trim().replace(/\s/g, '')
    if (code.length < 6) return
    setState(s => ({ ...s, verifying: true, error: null }))
    try {
      const { data } = await verifyDeleteOtp(code)
      setDeleteToken(data.delete_token)
      const action = pendingRef.current
      pendingRef.current = null
      setState({ open: false, sending: false, verifying: false, code: '', error: null })
      const result = await action()
      resolveRef.current?.(result)
    } catch (e) {
      const msg = e.response?.data?.detail || 'Невірний код'
      setState(s => ({ ...s, verifying: false, error: msg }))
    }
  }

  function handleClose() {
    setState({ open: false, sending: false, verifying: false, code: '', error: null })
    pendingRef.current = null
    rejectRef.current?.(new Error('cancelled'))
    resolveRef.current = null
    rejectRef.current = null
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleVerify()
  }

  return (
    <DeleteOtpContext.Provider value={{ gateDelete }}>
      {children}
      <Modal open={state.open} onClose={handleClose} title="🔐 Підтвердження видалення" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {state.sending ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px',
              fontSize: 13, color: 'var(--text2)',
            }}>
              <span style={{ fontSize: 20 }}>📨</span>
              <span>Надсилаємо код в Telegram...</span>
            </div>
          ) : (
            <div style={{
              background: 'var(--accent-dim)', border: '1px solid rgba(10,132,255,0.3)',
              borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--text2)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
              Код надіслано в Telegram. Введіть його нижче.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Код підтвердження
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="XXX XXX"
              maxLength={7}
              value={state.code}
              onChange={e => setState(s => ({ ...s, code: e.target.value, error: null }))}
              onKeyDown={handleKeyDown}
              autoFocus={!state.sending}
              disabled={state.sending}
              style={{
                fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700,
                letterSpacing: '0.3em', textAlign: 'center', padding: '10px 16px',
                border: state.error ? '2px solid var(--red)' : '1px solid var(--border)',
              }}
            />
            {state.error && (
              <span style={{ fontSize: 12, color: 'var(--red)', textAlign: 'center' }}>{state.error}</span>
            )}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0, textAlign: 'center' }}>
            Код дійсний 5 хвилин. Після підтвердження можна виконати кілька видалень без повторного введення.
          </p>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={handleClose}>Скасувати</Btn>
            <Btn
              variant="danger"
              loading={state.verifying}
              disabled={state.sending || state.code.replace(/\s/g, '').length < 6}
              onClick={handleVerify}
            >
              Підтвердити видалення
            </Btn>
          </div>
        </div>
      </Modal>
    </DeleteOtpContext.Provider>
  )
}

export function useDeleteOtp() {
  const ctx = useContext(DeleteOtpContext)
  if (!ctx) throw new Error('useDeleteOtp must be used inside DeleteOtpProvider')
  return ctx
}
