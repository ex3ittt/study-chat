import { DatabaseSync } from 'node:sqlite'
import type { ChatMessage, Person } from './protocol.ts'

/** Message history in SQLite (Node's built-in driver — nothing to compile). */
export class Store {
  private readonly db: DatabaseSync
  private readonly insert
  private readonly recent
  private readonly byClientId

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        room      TEXT NOT NULL,
        client_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author    TEXT NOT NULL,
        text      TEXT NOT NULL,
        at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_messages_room ON messages(room, id);
      -- A client resends its outbox after a reconnect; the same clientId must
      -- not become a second message.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_client ON messages(room, client_id);
    `)
    this.insert = this.db.prepare('INSERT OR IGNORE INTO messages (room, client_id, author_id, author, text, at) VALUES (?, ?, ?, ?, ?, ?)')
    this.byClientId = this.db.prepare('SELECT * FROM messages WHERE room = ? AND client_id = ?')
    this.recent = this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
  }

  /** Returns the stored message and whether it is new (false for a resend). */
  add(room: string, clientId: string, from: Person, text: string, at: number): { msg: ChatMessage; fresh: boolean } {
    const { changes } = this.insert.run(room, clientId, from.id, from.name, text, at)
    return { msg: toMessage(this.byClientId.get(room, clientId) as Row), fresh: changes > 0 }
  }

  history(room: string, limit = 100): ChatMessage[] {
    return (this.recent.all(room, limit) as Row[]).map(toMessage)
  }

  close(): void {
    this.db.close()
  }
}

type Row = Record<string, string | number>

function toMessage(r: Row): ChatMessage {
  return {
    id: Number(r.id),
    clientId: String(r.client_id),
    room: String(r.room),
    from: { id: String(r.author_id), name: String(r.author) },
    text: String(r.text),
    at: Number(r.at),
  }
}
