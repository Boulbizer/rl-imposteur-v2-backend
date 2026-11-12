// socket.ts
// Couche temps réel : traduit les messages socket en actions du moteur,
// persiste la salle, puis diffuse les vues publiques / privées.
//
// Règle de sécurité : on n'envoie JAMAIS l'objet Room. Tout le monde reçoit
// publicRoom(room) ; le rôle de chacun part dans un message privé.

import type { Server, Socket } from 'socket.io'
import * as engine from './game/engine'
import type { RoomRegistry } from './store/registry'
import type { ClientToServerEvents, Player, Room, ServerToClientEvents } from './types'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents>

export interface GameServerOptions {
  /** Délai avant retrait d'un joueur déconnecté. */
  graceMs: number
  now?: () => number
}

export class GameSockets {
  private pendingRemovals = new Map<string, NodeJS.Timeout>()
  private now: () => number

  constructor(private io: IO, private registry: RoomRegistry, private opts: GameServerOptions) {
    this.now = opts.now ?? Date.now
    io.on('connection', socket => this.bind(socket))
  }

  // ─── Diffusion ────────────────────────────────────────────────

  private broadcast(room: Room) {
    this.io.to(room.id).emit('room:updated', { room: engine.publicRoom(room) })
  }

  private sendJoin(socket: ClientSocket, event: 'room:joined' | 'room:rejoined', room: Room, player: Player) {
    socket.join(room.id)
    socket.emit(event, { room: engine.publicRoom(room), ...engine.privateView(room, player) })
    socket.to(room.id).emit('room:updated', { room: engine.publicRoom(room) })
  }

  private error(socket: ClientSocket, message: string) {
    socket.emit('room:error', { message })
  }

  // ─── Retrait différé des joueurs déconnectés ──────────────────

  cancelRemoval(playerId: string) {
    const timer = this.pendingRemovals.get(playerId)
    if (timer) clearTimeout(timer)
    this.pendingRemovals.delete(playerId)
  }

  scheduleRemoval(room: Room, player: Player, delayMs: number) {
    this.cancelRemoval(player.id)
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(player.id)
      if (!player.disconnected || this.registry.get(room.id) !== room) return
      const result = engine.removePlayer(room, player.id, this.now())
      if (!result.removed) return
      if (result.empty) {
        void this.registry.remove(room.id)
        console.log(`🗑️ Salle ${room.id} supprimée (vide)`)
        return
      }
      void this.registry.persist(room)
      this.broadcast(room)
      if (result.wasHost) this.io.to(room.id).emit('host:changed', { newHostId: room.hostId })
      void this.finishVoteIfComplete(room)
    }, delayMs)
    timer.unref()
    this.pendingRemovals.set(player.id, timer)
  }

  stopTimers() {
    for (const timer of this.pendingRemovals.values()) clearTimeout(timer)
    this.pendingRemovals.clear()
  }

  // ─── Fin de vote ───────────────────────────────────────────────

  private async finishVoteIfComplete(room: Room) {
    if (!engine.allVoted(room)) return
    const results = engine.reveal(room, this.now())
    const persisted = this.registry.persist(room)
    await this.registry.storage.addScores(room.players.map(p => ({
      room_id: room.scoreKey,
      player_name: p.name,
      points: results.pointsAwarded[p.id] ?? 0,
    })))
    results.cumulativeScores = await this.registry.storage.totalScores(room.scoreKey)
    await persisted
    this.io.to(room.id).emit('reveal:result', { results, room: engine.publicRoom(room) })
  }

  // ─── Événements ────────────────────────────────────────────────

  private bind(socket: ClientSocket) {
    /** Salle + joueur de ce socket, si le socket est bien dans la salle demandée. */
    const member = (roomId: unknown) => {
      const room = this.registry.get(roomId)
      const found = this.registry.bySocket(socket.id)
      if (!room || !found || found.room !== room) return undefined
      return found
    }

    /** Un socket n'appartient qu'à une salle : on le détache de l'ancienne. */
    const leaveCurrent = (except?: Room) => {
      const current = this.registry.bySocket(socket.id)
      if (!current || current.room === except) return
      socket.leave(current.room.id)
      engine.markDisconnected(current.room, current.player.id, this.now())
      void this.registry.persist(current.room)
      this.broadcast(current.room)
    }

    socket.on('room:create', async ({ playerName } = { playerName: '' }) => {
      const now = this.now()
      const result = engine.createRoom(this.registry.newCode(), this.registry.newScoreKey(now), socket.id, playerName, now)
      if (!result.ok) return this.error(socket, result.error)
      leaveCurrent()
      await this.registry.add(result.room)
      socket.join(result.room.id)
      socket.emit('room:created', {
        room: engine.publicRoom(result.room),
        ...engine.privateView(result.room, result.player),
      })
      console.log(`🏠 Salle ${result.room.id} créée`)
    })

    socket.on('room:join', async ({ roomId, playerName, token } = { roomId: '' }) => {
      const room = this.registry.get(roomId)
      if (!room) return this.error(socket, 'Salle introuvable')
      const result = engine.join(room, socket.id, playerName, token, this.now())
      if (!result.ok) return this.error(socket, result.error)
      leaveCurrent(room)
      this.cancelRemoval(result.player.id)
      await this.registry.persist(room)
      this.sendJoin(socket, result.reconnected ? 'room:rejoined' : 'room:joined', room, result.player)
    })

    socket.on('room:rejoin', async ({ roomId, token } = { roomId: '', token: '' }) => {
      const room = this.registry.get(roomId)
      const result = room && token ? engine.join(room, socket.id, null, token, this.now()) : undefined
      if (!room || !result?.ok || !result.reconnected) {
        socket.emit('room:session-lost', { message: 'Session expirée, rejoins la salle à nouveau' })
        return
      }
      leaveCurrent(room)
      this.cancelRemoval(result.player.id)
      await this.registry.persist(room)
      this.sendJoin(socket, 'room:rejoined', room, result.player)
    })

    socket.on('game:start', async ({ roomId } = { roomId: '' }) => {
      const m = member(roomId)
      if (!m) return
      const result = engine.start(m.room, m.player.id, this.now())
      if (!result.ok) return this.error(socket, result.error)
      await this.registry.persist(m.room)
      const room = engine.publicRoom(m.room)
      for (const p of m.room.players) {
        if (p.socketId) this.io.to(p.socketId).emit('game:started', { room, isImpostor: p.id === m.room.impostorId })
      }
    })

    socket.on('game:end', async ({ roomId } = { roomId: '' }) => {
      const m = member(roomId)
      if (!m) return
      const result = engine.endMatch(m.room, m.player.id, this.now())
      if (!result.ok) return this.error(socket, result.error)
      await this.registry.persist(m.room)
      this.io.to(m.room.id).emit('voting:started', { room: engine.publicRoom(m.room) })
    })

    socket.on('vote:cast', async ({ roomId, targetId } = { roomId: '', targetId: '' }) => {
      const m = member(roomId)
      if (!m) return
      const result = engine.vote(m.room, m.player.id, targetId, this.now())
      if (!result.ok) return this.error(socket, result.error)
      const pub = engine.publicRoom(m.room)
      this.io.to(m.room.id).emit('vote:registered', {
        votesCount: pub.votesCount,
        totalPlayers: pub.players.filter(p => !p.disconnected).length,
      })
      this.broadcast(m.room)
      if (engine.allVoted(m.room)) await this.finishVoteIfComplete(m.room)
      else await this.registry.persist(m.room)
    })

    socket.on('scores:request', async ({ roomId } = { roomId: '' }) => {
      const m = member(roomId)
      if (!m) return
      const scores = await this.registry.storage.totalScores(m.room.scoreKey)
      socket.emit('scores:data', { scores, room: engine.publicRoom(m.room) })
    })

    socket.on('round:next', async ({ roomId } = { roomId: '' }) => {
      const m = member(roomId)
      if (!m) return
      const result = engine.nextRound(m.room, m.player.id, this.now())
      if (!result.ok) return this.error(socket, result.error)
      await this.registry.persist(m.room)
      this.io.to(m.room.id).emit('round:next', { room: engine.publicRoom(m.room) })
    })

    socket.on('disconnect', () => {
      const found = this.registry.bySocket(socket.id)
      if (!found) return
      const { room, player } = found
      engine.markDisconnected(room, player.id, this.now())
      void this.registry.persist(room)
      this.broadcast(room)
      void this.finishVoteIfComplete(room)
      this.scheduleRemoval(room, player, this.opts.graceMs)
    })
  }
}
