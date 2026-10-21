// Messages on the wire. Both sides import these types; the server also
// validates everything it receives, because a WebSocket accepts any bytes.

export interface Person {
  id: string
  name: string
}

export interface ChatMessage {
  id: number
  /** Set by the sender; lets the client match the echo to its pending copy. */
  clientId: string
  room: string
  from: Person
  text: string
  at: number
}

export type ClientEvent =
  | { t: 'join'; room: string; name: string }
  | { t: 'say'; text: string; clientId: string }
  | { t: 'typing' }

export type ServerEvent =
  | { t: 'welcome'; you: Person; room: string; history: ChatMessage[]; people: Person[] }
  | { t: 'msg'; msg: ChatMessage }
  | { t: 'joined'; person: Person }
  | { t: 'left'; person: Person }
  | { t: 'typing'; person: Person }
  | { t: 'error'; text: string }

export const LIMITS = {
  text: 2000,
  name: 32,
  /** Messages per connection in a sliding 10-second window. */
  burst: 12,
} as const

const ROOM = /^[a-z0-9а-яё-]{2,32}$/

export function normalizeRoom(raw: string): string | null {
  const room = raw.trim().toLowerCase().replace(/\s+/g, '-')
  return ROOM.test(room) ? room : null
}

export function normalizeName(raw: string): string | null {
  // Collapse whitespace and strip control characters someone could paste in.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  return name.length >= 1 && name.length <= LIMITS.name ? name : null
}

export function parseClientEvent(data: string): ClientEvent | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  if (e.t === 'join' && typeof e.room === 'string' && typeof e.name === 'string') return { t: 'join', room: e.room, name: e.name }
  if (e.t === 'say' && typeof e.text === 'string' && typeof e.clientId === 'string' && e.clientId.length <= 64) {
    return { t: 'say', text: e.text, clientId: e.clientId }
  }
  if (e.t === 'typing') return { t: 'typing' }
  return null
}
