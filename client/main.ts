import type { ChatMessage, Person, ServerEvent } from '../server/protocol.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const script = $<HTMLOListElement>('script')
const text = $<HTMLTextAreaElement>('text')

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' })

interface Pending {
  clientId: string
  text: string
  el: HTMLLIElement
}

const state = {
  socket: null as WebSocket | null,
  room: '',
  name: '',
  me: null as Person | null,
  people: new Map<string, Person>(),
  outbox: [] as Pending[],
  seen: new Set<number>(),
  lastAuthor: '' as string,
  lastDay: '',
  retry: 0,
  typingTimers: new Map<string, number>(),
}

// ── join ────────────────────────────────────────────────────────────────

const fromPath = decodeURIComponent(location.pathname.match(/^\/r\/([^/]+)/)?.[1] ?? '')
try {
  $<HTMLInputElement>('name').value = localStorage.getItem('chat:name') ?? ''
} catch {}
$<HTMLInputElement>('room').value = fromPath
;($<HTMLInputElement>(fromPath ? 'name' : 'room')).focus()

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  state.name = $<HTMLInputElement>('name').value.trim()
  state.room = $<HTMLInputElement>('room').value.trim().toLowerCase().replace(/\s+/g, '-')
  try {
    localStorage.setItem('chat:name', state.name)
  } catch {}
  history.replaceState(null, '', `/r/${encodeURIComponent(state.room)}`)
  connect()
})

// ── connection ──────────────────────────────────────────────────────────

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${proto}://${location.host}/ws`)
  state.socket = socket
  socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'join', room: state.room, name: state.name })))
  socket.addEventListener('message', (e) => handle(JSON.parse(e.data) as ServerEvent))
  socket.addEventListener('close', () => {
    if (state.socket !== socket || !state.me) return
    // Exponential backoff with jitter: 0.5s, 1s, 2s … up to 15s.
    const delay = Math.min(15_000, 500 * 2 ** state.retry) * (0.75 + Math.random() / 2)
    state.retry++
    offline(`Нет связи — переподключаюсь через ${Math.ceil(delay / 1000)} с.${state.outbox.length ? ' Неотправленное уйдёт само.' : ''}`)
    setTimeout(connect, delay)
  })
}

function offline(message: string | null): void {
  $('offline').hidden = !message
  $('offline').textContent = message ?? ''
}

function handle(e: ServerEvent): void {
  switch (e.t) {
    case 'welcome': {
      const first = !state.me
      state.me = e.you
      state.retry = 0
      offline(null)
      state.people = new Map(e.people.map((p) => [p.id, p]))
      if (first) {
        $('join').hidden = true
        $('chat').hidden = false
        document.title = `${e.room} — комната`
        $('room-title').textContent = e.room
        e.history.forEach((m) => addMessage(m))
        direction(e.history.length ? 'Это была история комнаты. Дальше — новые сообщения.' : `Комната «${e.room}» пустая. Скопируй ссылку и позови группу.`)
        text.focus()
      } else {
        e.history.filter((m) => !state.seen.has(m.id)).forEach((m) => addMessage(m))
      }
      // After a reconnect: resend whatever didn't get an echo.
      for (const p of state.outbox) state.socket?.send(JSON.stringify({ t: 'say', text: p.text, clientId: p.clientId }))
      renderPeople()
      break
    }
    case 'msg': {
      const pending = state.outbox.find((p) => p.clientId === e.msg.clientId)
      if (pending) {
        state.outbox = state.outbox.filter((p) => p !== pending)
        pending.el.classList.remove('pending')
        pending.el.querySelector('.time')!.textContent = timeFmt.format(e.msg.at)
        state.seen.add(e.msg.id)
      } else addMessage(e.msg)
      clearTyping(e.msg.from.id)
      break
    }
    case 'joined':
      if (!state.people.has(e.person.id)) direction(`Входит ${e.person.name}.`)
      state.people.set(e.person.id, e.person)
      renderPeople()
      break
    case 'left':
      state.people.delete(e.person.id)
      clearTyping(e.person.id)
      direction(`${e.person.name} уходит.`)
      renderPeople()
      break
    case 'typing':
      showTyping(e.person)
      break
    case 'error':
      if (!state.me) {
        $('join-error').textContent = e.text
        state.socket?.close()
        state.socket = null
      } else direction(e.text)
      break
  }
}

// ── rendering ───────────────────────────────────────────────────────────

function nearBottom(): boolean {
  return script.scrollHeight - script.scrollTop - script.clientHeight < 80
}

function append(el: HTMLElement): void {
  const stick = nearBottom()
  script.append(el)
  if (stick) script.scrollTop = script.scrollHeight
}

function direction(textContent: string): void {
  const li = document.createElement('li')
  li.className = 'direction'
  li.textContent = `(${textContent})`
  append(li)
  state.lastAuthor = ''
}

function lineEl(author: Person, body: string, at: number | null): HTMLLIElement {
  const day = dayFmt.format(at ?? Date.now())
  if (day !== state.lastDay) {
    const d = document.createElement('li')
    d.className = 'day'
    d.textContent = day[0].toUpperCase() + day.slice(1)
    append(d)
    state.lastDay = day
    state.lastAuthor = ''
  }
  const li = document.createElement('li')
  const mine = author.id === state.me?.id
  li.className = `line${mine ? ' mine' : ''}${state.lastAuthor === author.id ? ' cont' : ''}`
  const who = document.createElement('span')
  who.className = 'who'
  who.textContent = mine ? 'Я' : author.name
  const said = document.createElement('span')
  said.className = 'said'
  // Text goes in as text; only "@name" mentions get wrapped, by DOM nodes.
  for (const part of body.split(/(@[\p{L}\d_-]+)/u)) {
    if (part.startsWith('@')) {
      const m = document.createElement('span')
      m.className = 'mention'
      m.textContent = part
      said.append(m)
    } else said.append(part)
  }
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = at ? timeFmt.format(at) : 'отправляется'
  li.append(who, said, time)
  state.lastAuthor = author.id
  return li
}

function addMessage(m: ChatMessage): void {
  if (state.seen.has(m.id)) return
  state.seen.add(m.id)
  append(lineEl(m.from, m.text, m.at))
}

function renderPeople(): void {
  const names = [...state.people.values()].filter((p) => p.id !== state.me?.id).map((p) => p.name)
  $('people').textContent = names.length ? `Сейчас здесь: ты, ${names.join(', ')}` : 'Пока здесь только ты'
}

// ── typing indicator ────────────────────────────────────────────────────

const typingEl = document.createElement('p')
typingEl.className = 'typing'
$('composer').before(typingEl)
const typingNames = new Map<string, string>()

function showTyping(p: Person): void {
  typingNames.set(p.id, p.name)
  clearTimeout(state.typingTimers.get(p.id))
  state.typingTimers.set(p.id, window.setTimeout(() => clearTyping(p.id), 3000))
  renderTyping()
}

function clearTyping(id: string): void {
  typingNames.delete(id)
  renderTyping()
}

function renderTyping(): void {
  const names = [...typingNames.values()]
  typingEl.textContent =
    names.length === 0 ? '' : names.length === 1 ? `(${names[0]} печатает…)` : names.length === 2 ? `(${names[0]} и ${names[1]} печатают…)` : '(Печатают несколько человек…)'
}

// ── composer ────────────────────────────────────────────────────────────

let lastTypingSent = 0

text.addEventListener('input', () => {
  text.style.height = 'auto'
  text.style.height = text.scrollHeight + 'px'
  if (Date.now() - lastTypingSent > 1500 && state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ t: 'typing' }))
    lastTypingSent = Date.now()
  }
})

text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $<HTMLFormElement>('composer').requestSubmit()
  }
})

$('composer').addEventListener('submit', (e) => {
  e.preventDefault()
  const body = text.value.trim()
  if (!body || !state.me) return
  const clientId = crypto.randomUUID()
  const el = lineEl(state.me, body, null)
  el.classList.add('pending')
  append(el)
  script.scrollTop = script.scrollHeight
  state.outbox.push({ clientId, text: body, el })
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ t: 'say', text: body, clientId }))
  text.value = ''
  text.style.height = 'auto'
})

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href)
    $('copy').textContent = 'Ссылка скопирована'
  } catch {
    prompt('Ссылка на комнату:', location.href)
  }
  setTimeout(() => ($('copy').textContent = 'Скопировать ссылку'), 2000)
})
