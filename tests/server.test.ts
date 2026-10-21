import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startServer } from '../server/index.ts'
import { normalizeName, normalizeRoom, type ServerEvent } from '../server/protocol.ts'

let server: Awaited<ReturnType<typeof startServer>>

beforeEach(async () => {
  server = await startServer({ port: 0 })
})
afterEach(async () => {
  await server.close()
})

/** A test client that records every event and can wait for a specific one. */
async function client(room?: string, name?: string) {
  const socket = new WebSocket(`ws://localhost:${server.port}/ws`)
  const events: ServerEvent[] = []
  const waiters: { match: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = []
  socket.on('message', (raw) => {
    const e = JSON.parse(String(raw)) as ServerEvent
    events.push(e)
    for (const w of [...waiters]) if (w.match(e)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(e)
    }
  })
  await new Promise((r) => socket.once('open', r))
  const c = {
    socket,
    events,
    send: (e: object) => socket.send(JSON.stringify(e)),
    next: <T extends ServerEvent['t']>(t: T, match: (e: Extract<ServerEvent, { t: T }>) => boolean = () => true) => {
      const found = events.find((e) => e.t === t && match(e as Extract<ServerEvent, { t: T }>))
      if (found) {
        events.splice(events.indexOf(found), 1)
        return Promise.resolve(found as Extract<ServerEvent, { t: T }>)
      }
      return new Promise<Extract<ServerEvent, { t: T }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${t} event`)), 1500)
        waiters.push({
          match: (e) => e.t === t && match(e as Extract<ServerEvent, { t: T }>),
          resolve: (e) => {
            clearTimeout(timer)
            events.splice(events.indexOf(e), 1)
            resolve(e as Extract<ServerEvent, { t: T }>)
          },
        })
      })
    },
  }
  if (room && name) {
    c.send({ t: 'join', room, name })
    await c.next('welcome')
  }
  return c
}

describe('protocol helpers', () => {
  it('normalises rooms and names', () => {
    expect(normalizeRoom('  ВИ14 Матан ')).toBe('ви14-матан')
    expect(normalizeRoom('a')).toBeNull()
    expect(normalizeRoom('../etc')).toBeNull()
    expect(normalizeName('  Аня \n Петрова ')).toBe('Аня Петрова')
    expect(normalizeName('\u0007')).toBeNull()
  })
})

describe('chat server', () => {
  it('welcomes with history and the people already in the room', async () => {
    const anya = await client('vi14', 'Аня')
    anya.send({ t: 'say', text: 'кто идёт на матан?', clientId: 'c1' })
    await anya.next('msg')

    const borya = await client()
    borya.send({ t: 'join', room: 'VI14', name: 'Боря' })
    const welcome = await borya.next('welcome')
    expect(welcome.room).toBe('vi14')
    expect(welcome.history.map((m) => m.text)).toEqual(['кто идёт на матан?'])
    expect(welcome.people.map((p) => p.name).sort()).toEqual(['Аня', 'Боря'])
    expect((await anya.next('joined')).person.name).toBe('Боря')
  })

  it('delivers a message to everyone, sender included, with its clientId', async () => {
    const anya = await client('vi14', 'Аня')
    const borya = await client('vi14', 'Боря')
    anya.send({ t: 'say', text: '  я!  ', clientId: 'local-42' })
    const [own, theirs] = await Promise.all([anya.next('msg'), borya.next('msg')])
    expect(own.msg).toMatchObject({ clientId: 'local-42', text: 'я!', from: { name: 'Аня' } })
    expect(theirs.msg.id).toBe(own.msg.id)
  })

  it('a resent message (same clientId) is stored once and not re-broadcast', async () => {
    const anya = await client('vi14', 'Аня')
    const borya = await client('vi14', 'Боря')
    anya.send({ t: 'say', text: 'один раз', clientId: 'same' })
    const first = await anya.next('msg')
    await borya.next('msg')
    anya.send({ t: 'say', text: 'один раз', clientId: 'same' })
    expect((await anya.next('msg')).msg.id).toBe(first.msg.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(borya.events.filter((e) => e.t === 'msg')).toEqual([])
  })

  it('keeps rooms apart', async () => {
    const a = await client('vi14', 'Аня')
    const b = await client('vi15', 'Вика')
    a.send({ t: 'say', text: 'только для vi14', clientId: 'x' })
    await a.next('msg')
    await new Promise((r) => setTimeout(r, 100))
    expect(b.events.filter((e) => e.t === 'msg')).toEqual([])
  })

  it('announces who left', async () => {
    const anya = await client('vi14', 'Аня')
    const borya = await client('vi14', 'Боря')
    await anya.next('joined')
    borya.socket.close()
    expect((await anya.next('left')).person.name).toBe('Боря')
  })

  it('forwards typing to others, not to the typist, at most once a second', async () => {
    const anya = await client('vi14', 'Аня')
    const borya = await client('vi14', 'Боря')
    for (let i = 0; i < 5; i++) anya.send({ t: 'typing' })
    expect((await borya.next('typing')).person.name).toBe('Аня')
    await new Promise((r) => setTimeout(r, 150))
    expect(borya.events.filter((e) => e.t === 'typing')).toHaveLength(0)
    expect(anya.events.filter((e) => e.t === 'typing')).toHaveLength(0)
  })

  it('rate-limits floods', async () => {
    const anya = await client('vi14', 'Аня')
    for (let i = 0; i < 20; i++) anya.send({ t: 'say', text: `спам ${i}`, clientId: String(i) })
    const error = await anya.next('error')
    expect(error.text).toContain('Слишком часто')
  })

  it('rejects bad input with a readable error', async () => {
    const c = await client()
    c.send({ t: 'say', text: 'привет', clientId: '1' })
    expect((await c.next('error')).text).toContain('Сначала зайди')
    c.send({ t: 'join', room: '!', name: 'Аня' })
    expect((await c.next('error')).text).toContain('Название комнаты')
    c.socket.send('не json')
    expect((await c.next('error')).text).toBe('Непонятная команда')
  })

  it('stores text as text — HTML is not interpreted anywhere on the server', async () => {
    const anya = await client('vi14', 'Аня')
    anya.send({ t: 'say', text: '<img src=x onerror=alert(1)>', clientId: 'x' })
    expect((await anya.next('msg')).msg.text).toBe('<img src=x onerror=alert(1)>')
  })
})
