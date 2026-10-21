import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { LIMITS, normalizeName, normalizeRoom, parseClientEvent, type Person, type ServerEvent } from './protocol.ts'
import type { Store } from './store.ts'

interface Client {
  socket: WebSocket
  person: Person
  room: string | null
  sent: number[] // timestamps of recent messages, for the rate limit
  lastTyping: number
}

/**
 * Rooms, presence and fan-out. A room exists while someone is in it;
 * its history lives on in the store.
 */
export class Hub {
  private readonly rooms = new Map<string, Set<Client>>()
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  connect(socket: WebSocket): void {
    const client: Client = { socket, person: { id: randomUUID(), name: '' }, room: null, sent: [], lastTyping: 0 }
    socket.on('message', (data) => this.receive(client, String(data)))
    socket.on('close', () => this.leave(client))
  }

  peopleIn(room: string): Person[] {
    const seen = new Map<string, Person>()
    for (const c of this.rooms.get(room) ?? []) seen.set(c.person.id, c.person)
    return [...seen.values()]
  }

  private send(client: Client, event: ServerEvent): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(event))
  }

  private broadcast(room: string, event: ServerEvent, except?: Client): void {
    const payload = JSON.stringify(event)
    for (const c of this.rooms.get(room) ?? []) {
      if (c !== except && c.socket.readyState === c.socket.OPEN) c.socket.send(payload)
    }
  }

  private receive(client: Client, data: string): void {
    if (data.length > LIMITS.text * 4) return this.send(client, { t: 'error', text: 'Слишком большое сообщение' })
    const event = parseClientEvent(data)
    if (!event) return this.send(client, { t: 'error', text: 'Непонятная команда' })

    if (event.t === 'join') {
      const room = normalizeRoom(event.room)
      const name = normalizeName(event.name)
      if (!room) return this.send(client, { t: 'error', text: 'Название комнаты: 2–32 буквы, цифры или дефис' })
      if (!name) return this.send(client, { t: 'error', text: `Имя: от 1 до ${LIMITS.name} символов` })
      this.leave(client)
      client.person = { id: client.person.id, name }
      client.room = room
      if (!this.rooms.has(room)) this.rooms.set(room, new Set())
      this.rooms.get(room)!.add(client)
      this.send(client, { t: 'welcome', you: client.person, room, history: this.store.history(room), people: this.peopleIn(room) })
      this.broadcast(room, { t: 'joined', person: client.person }, client)
      return
    }

    if (!client.room) return this.send(client, { t: 'error', text: 'Сначала зайди в комнату' })

    if (event.t === 'typing') {
      // At most one "печатает…" per second per person, however fast they type.
      if (this.now() - client.lastTyping < 1000) return
      client.lastTyping = this.now()
      return this.broadcast(client.room, { t: 'typing', person: client.person }, client)
    }

    const text = event.text.replace(/\r\n/g, '\n').trim()
    if (!text) return
    if (text.length > LIMITS.text) return this.send(client, { t: 'error', text: `Сообщение длиннее ${LIMITS.text} символов` })
    const now = this.now()
    client.sent = client.sent.filter((t) => now - t < 10_000)
    if (client.sent.length >= LIMITS.burst) return this.send(client, { t: 'error', text: 'Слишком часто — подожди пару секунд' })
    client.sent.push(now)

    const { msg, fresh } = this.store.add(client.room, event.clientId, client.person, text, now)
    // A resend of something already stored: confirm to the sender only.
    if (!fresh) return this.send(client, { t: 'msg', msg })
    // Everyone including the sender: the echo is the sender's delivery receipt.
    this.broadcast(client.room, { t: 'msg', msg })
  }

  private leave(client: Client): void {
    const room = client.room
    if (!room) return
    const members = this.rooms.get(room)
    members?.delete(client)
    client.room = null
    if (members && members.size === 0) this.rooms.delete(room)
    // Two tabs of one person: only announce when the last one closes.
    else if (!this.peopleIn(room).some((p) => p.id === client.person.id)) this.broadcast(room, { t: 'left', person: client.person })
  }
}
