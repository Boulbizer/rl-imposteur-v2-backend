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
