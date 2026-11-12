// store/storage.ts
// Persistance des salles et des scores derrière une interface unique.
// - SupabaseStorage : production (tables `rooms` et `scores`)
// - MemoryStorage   : développement et tests ; un même objet peut être
//   réutilisé par un second serveur pour simuler un redémarrage.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Room, ScoreLine } from '../types'

export interface ScoreRow {
  room_id: string
  player_name: string
  points: number
}

export interface Storage {
  loadRooms(): Promise<Room[]>
  saveRoom(room: Room): Promise<void>
  deleteRoom(code: string): Promise<void>
  addScores(rows: ScoreRow[]): Promise<void>
  totalScores(scoreKey: string): Promise<ScoreLine[]>
}

function aggregate(rows: Pick<ScoreRow, 'player_name' | 'points'>[]): ScoreLine[] {
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.player_name] = (totals[row.player_name] ?? 0) + row.points
  return Object.entries(totals)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
}

export class MemoryStorage implements Storage {
  private rooms = new Map<string, string>() // JSON : on ne partage jamais d'objet vivant
  private scores: ScoreRow[] = []

  async loadRooms(): Promise<Room[]> {
    return [...this.rooms.values()].map(json => JSON.parse(json) as Room)
  }
  async saveRoom(room: Room): Promise<void> {
    this.rooms.set(room.id, JSON.stringify(room))
  }
  async deleteRoom(code: string): Promise<void> {
    this.rooms.delete(code)
  }
  async addScores(rows: ScoreRow[]): Promise<void> {
    this.scores.push(...rows)
  }
  async totalScores(scoreKey: string): Promise<ScoreLine[]> {
    return aggregate(this.scores.filter(r => r.room_id === scoreKey))
  }
  allScores(): ScoreRow[] {
    return [...this.scores]
  }
}

export class SupabaseStorage implements Storage {
  constructor(private db: SupabaseClient) {}

  async loadRooms(): Promise<Room[]> {
    const { data, error } = await this.db.from('rooms').select('state')
    if (error) throw new Error(`Supabase loadRooms : ${error.message}`)
    return (data ?? []).map(row => row.state as Room)
  }
  async saveRoom(room: Room): Promise<void> {
    const { error } = await this.db.from('rooms').upsert({
      code: room.id,
      state: room,
      updated_at: new Date(room.updatedAt).toISOString(),
    })
    if (error) console.error('Supabase saveRoom :', error.message)
  }
  async deleteRoom(code: string): Promise<void> {
    const { error } = await this.db.from('rooms').delete().eq('code', code)
    if (error) console.error('Supabase deleteRoom :', error.message)
  }
  async addScores(rows: ScoreRow[]): Promise<void> {
    const { error } = await this.db.from('scores').insert(rows)
    if (error) console.error('Supabase addScores :', error.message)
  }
  async totalScores(scoreKey: string): Promise<ScoreLine[]> {
    const { data, error } = await this.db
      .from('scores')
      .select('player_name, points')
      .eq('room_id', scoreKey)
    if (error) {
      console.error('Supabase totalScores :', error.message)
      return []
    }
    return aggregate(data ?? [])
  }
}

/**
 * Stockage dans un fichier JSON local : développement sans Supabase et tests
 * de redémarrage (le fichier survit au processus). Pas pour la production.
 */
export class FileStorage implements Storage {
  private memory = new MemoryStorage()
  private loaded = false
  /** Les écritures du fichier sont sérialisées : jamais deux à la fois. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private path: string) {}

  private async load() {
    if (this.loaded) return
    this.loaded = true
    const { readFile } = await import('node:fs/promises')
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as { rooms: Room[]; scores: ScoreRow[] }
      for (const room of data.rooms) await this.memory.saveRoom(room)
      await this.memory.addScores(data.scores)
    } catch {
      // fichier absent ou illisible : on part de zéro
    }
  }

  private write(): Promise<void> {
    const run = async () => {
      const { writeFile, rename } = await import('node:fs/promises')
      const data = { rooms: await this.memory.loadRooms(), scores: this.memory.allScores() }
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, JSON.stringify(data))
      await rename(tmp, this.path)
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  async loadRooms() { await this.load(); return this.memory.loadRooms() }
  async saveRoom(room: Room) { await this.load(); await this.memory.saveRoom(room); await this.write() }
  async deleteRoom(code: string) { await this.load(); await this.memory.deleteRoom(code); await this.write() }
  async addScores(rows: ScoreRow[]) { await this.load(); await this.memory.addScores(rows); await this.write() }
  async totalScores(scoreKey: string) { await this.load(); return this.memory.totalScores(scoreKey) }
}
