// Lightweight animated-icon wrapper. Drop-in replacement for an emoji:
// pass a lucide-react icon component and an animation style. CSS keyframes
// are injected once into the head so callers don't need to import a stylesheet.
import { useEffect } from 'react'

const KEYFRAMES_ID = 'animated-icon-keyframes'
const KEYFRAMES_CSS = `
@keyframes ai-pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.18); opacity: 0.75 } }
@keyframes ai-spin  { to { transform: rotate(360deg) } }
@keyframes ai-bounce { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-3px) } }
@keyframes ai-shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-2px) } 75% { transform: translateX(2px) } }
@keyframes ai-flash { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
@keyframes ai-glow  { 0%,100% { filter: drop-shadow(0 0 0 currentColor) } 50% { filter: drop-shadow(0 0 6px currentColor) } }
`

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID)) return
  const s = document.createElement('style')
  s.id = KEYFRAMES_ID
  s.textContent = KEYFRAMES_CSS
  document.head.appendChild(s)
}

const ANIMS = {
  pulse:  'ai-pulse 1.6s ease-in-out infinite',
  spin:   'ai-spin 1.4s linear infinite',
  bounce: 'ai-bounce 1.4s ease-in-out infinite',
  shake:  'ai-shake 0.6s ease-in-out infinite',
  flash:  'ai-flash 1.2s ease-in-out infinite',
  glow:   'ai-glow 2s ease-in-out infinite',
}

export default function AnimatedIcon({
  icon: Icon,
  size = 14,
  color,
  anim = 'pulse',
  delay = 0,
  paused = false,
  title,
  style: extraStyle,
  ...rest
}) {
  useEffect(() => { ensureStyles() }, [])
  const animation = ANIMS[anim] || ANIMS.pulse
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color, lineHeight: 0,
      animation: paused ? 'none' : animation,
      animationDelay: delay ? `${delay}ms` : undefined,
      ...extraStyle,
    }} {...rest}>
      <Icon size={size} />
    </span>
  )
}
