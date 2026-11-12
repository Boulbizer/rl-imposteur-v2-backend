// store/registry.ts
// Salles actives en mémoire (accès rapide) + écriture systématique dans le
// stockage, pour qu'un redémarrage du serveur ne tue aucune partie.

import crypto from 'node:crypto'
import { normalizeCode, randomCode, type RandomInt, cryptoRandomInt } from '../game/engine'
import type { Player, Room } from '../types'
import type { Storage } from './storage'

export class RoomRegistry {
  private rooms = new Map<string, Room>()
  /** Écritures en cours par salle : garantit l'ordre des sauvegardes. */
  private writes = new Map<string, Promise<void>>()

  constructor(readonly storage: Storage, private random: RandomInt = cryptoRandomInt) {}

  /**
   * Recharge les salles sauvegardées. Après un redémarrage, plus aucun socket
   * n'est connecté : tous les joueurs sont marqués déconnectés et devront
   * revenir avec leur jeton. Les salles plus vieilles que `maxAgeMs` sont purgées.
   */
  async restore(now: number, maxAgeMs: number): Promise<Room[]> {
    const restored: Room[] = []
    for (const room of await this.storage.loadRooms()) {
      if (now - room.updatedAt > maxAgeMs) {
        await this.storage.deleteRoom(room.id)
        continue
      }
      for (const p of room.players) {
        p.socketId = null
        p.disconnected = true
      }
      this.rooms.set(room.id, room)
      restored.push(room)
    }
    return restored
  }

  newCode(): string {
    for (let i = 0; i < 100; i++) {
      const code = randomCode(this.random)
      if (!this.rooms.has(code)) return code
    }
    throw new Error('Impossible de générer un code de salle libre')
  }

  newScoreKey(now: number): string {
    return now.toString(36) + crypto.randomBytes(3).toString('hex')
  }

  get(code: unknown): Room | undefined {
    return this.rooms.get(normalizeCode(code))
  }

  bySocket(socketId: string): { room: Room; player: Player } | undefined {
    for (const room of this.rooms.values()) {
      const player = room.players.find(p => p.socketId === socketId)
      if (player) return { room, player }
    }
    return undefined
  }

  add(room: Room): Promise<void> {
    this.rooms.set(room.id, room)
    return this.persist(room)
  }

  persist(room: Room): Promise<void> {
    const snapshot = structuredClone(room)
    const previous = this.writes.get(room.id) ?? Promise.resolve()
    const next = previous
      .then(() => this.storage.saveRoom(snapshot))
      .catch(err => console.error(`Sauvegarde de la salle ${room.id} échouée :`, err))
    this.writes.set(room.id, next)
    return next
  }

  remove(code: string): Promise<void> {
    this.rooms.delete(code)
    const previous = this.writes.get(code) ?? Promise.resolve()
    const next = previous.then(() => this.storage.deleteRoom(code))
    this.writes.set(code, next)
    return next
  }

  /** Attend la fin de toutes les écritures (arrêt propre, tests). */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values())
  }

  all(): Room[] {
    return [...this.rooms.values()]
  }
}
