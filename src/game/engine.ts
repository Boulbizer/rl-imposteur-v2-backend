// game/engine.ts
// Moteur de jeu PUR : aucune dépendance au réseau, au stockage ou à l'horloge
// globale. Chaque action vérifie la transition d'état et les droits, puis
// modifie la salle. Testé unitairement dans test/engine.test.ts.
//
//   lobby ──start──▶ playing ──endMatch──▶ voting ──(tous ont voté)──▶ reveal
//     ▲                                                                  │
//     └──────────────────────────── nextRound ───────────────────────────┘

import crypto from 'node:crypto'
import type {
  Player,
  PrivateView,
  PublicRoom,
  Room,
  RoomStatus,
  RoundResults,
} from '../types'

export const MAX_PLAYERS = 10
export const MAX_NAME_LENGTH = 20
/** Pas de I ni de O : pas de confusion avec 1 et 0. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 4

/** Source d'aléa injectable (déterministe dans les tests). */
export type RandomInt = (maxExclusive: number) => number
export const cryptoRandomInt: RandomInt = max => crypto.randomInt(max)

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  lobby: ['playing'],
  playing: ['voting'],
  voting: ['reveal'],
  reveal: ['lobby'],
}

export function canTransition(from: RoomStatus, to: RoomStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

function transition(room: Room, to: RoomStatus, now: number): void {
  if (!canTransition(room.status, to)) {
    throw new Error(`Transition interdite : ${room.status} → ${to}`)
  }
  room.status = to
  room.updatedAt = now
}

// ─── Utilitaires ────────────────────────────────────────────────

export function randomCode(random: RandomInt = cryptoRandomInt): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)]
  return code
}

export function normalizeCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : ''
}

export function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : ''
}

function newPlayer(socketId: string, name: string): Player {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString('base64url'),
    socketId,
    name,
    disconnected: false,
  }
}

const connectedPlayers = (room: Room) => room.players.filter(p => !p.disconnected)
const isHost = (room: Room, playerId: string) => room.hostId === playerId

// ─── Vues ───────────────────────────────────────────────────────

/** Ce que TOUS les joueurs ont le droit de voir : ni imposteur, ni votes, ni jetons. */
export function publicRoom(room: Room): PublicRoom {
  return {
    id: room.id,
    hostId: room.hostId,
    hostName: room.hostName,
    status: room.status,
    round: room.round,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      disconnected: p.disconnected,
      hasVoted: room.status === 'voting' && room.votes[p.id] !== undefined,
    })),
    votesCount: connectedPlayers(room).filter(p => room.votes[p.id] !== undefined).length,
  }
}

/** Ce que seul `player` a le droit de voir. */
export function privateView(room: Room, player: Player): PrivateView {
  return {
    you: { playerId: player.id, token: player.token, name: player.name },
    isImpostor: room.status !== 'lobby' && room.impostorId === player.id,
  }
}

// ─── Actions ────────────────────────────────────────────────────

export function createRoom(
  code: string,
  scoreKey: string,
  socketId: string,
  hostName: unknown,
  now: number,
): Result<{ room: Room; player: Player }> {
  const name = cleanName(hostName)
  if (!name) return fail('Pseudo requis')
  if (name.length > MAX_NAME_LENGTH) return fail(`Pseudo trop long (${MAX_NAME_LENGTH} caractères max)`)
  const host = newPlayer(socketId, name)
  const room: Room = {
    id: code,
    scoreKey,
    hostId: host.id,
    hostName: name,
    players: [host],
    status: 'lobby',
    impostorId: null,
    votes: {},
    round: 1,
    updatedAt: now,
  }
  return { ok: true, room, player: host }
}

/**
 * Entrée dans une salle. Avec un jeton valide : reconnexion du même joueur
 * (à n'importe quelle phase). Sans jeton : nouveau joueur, en lobby seulement.
 */
export function join(
  room: Room,
  socketId: string,
  playerName: unknown,
  token: unknown,
  now: number,
): Result<{ player: Player; reconnected: boolean }> {
  if (typeof token === 'string' && token) {
    const player = room.players.find(p => p.token === token)
    if (player) {
      player.socketId = socketId
      player.disconnected = false
      room.updatedAt = now
      return { ok: true, player, reconnected: true }
    }
  }

  const name = cleanName(playerName)
  if (!name) return fail('Pseudo requis')
  if (name.length > MAX_NAME_LENGTH) return fail(`Pseudo trop long (${MAX_NAME_LENGTH} caractères max)`)
  if (room.status !== 'lobby') return fail('La partie a déjà commencé')
  if (room.players.length >= MAX_PLAYERS) return fail(`Salle pleine (${MAX_PLAYERS} joueurs max)`)
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return fail('Ce pseudo est déjà pris dans cette salle')
  }

  const player = newPlayer(socketId, name)
  room.players.push(player)
  room.updatedAt = now
  return { ok: true, player, reconnected: false }
}

export function markDisconnected(room: Room, playerId: string, now: number): void {
  const player = room.players.find(p => p.id === playerId)
  if (!player) return
  player.disconnected = true
  player.socketId = null
  room.updatedAt = now
}

/** Retrait définitif. `empty` = la salle n'a plus personne et doit être supprimée. */
export function removePlayer(
  room: Room,
  playerId: string,
  now: number,
): { removed: boolean; empty: boolean; wasHost: boolean } {
  const index = room.players.findIndex(p => p.id === playerId)
  if (index === -1) return { removed: false, empty: false, wasHost: false }

  room.players.splice(index, 1)
  delete room.votes[playerId]
  for (const [voterId, targetId] of Object.entries(room.votes)) {
    if (targetId === playerId) delete room.votes[voterId]
  }
  room.updatedAt = now
  if (room.players.length === 0) return { removed: true, empty: true, wasHost: false }

  const wasHost = room.hostId === playerId
  if (wasHost) {
    const next = room.players.find(p => !p.disconnected) ?? room.players[0]
    room.hostId = next.id
    room.hostName = next.name
  }
  return { removed: true, empty: false, wasHost }
}

export function start(room: Room, actorId: string, now: number, random: RandomInt = cryptoRandomInt): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut lancer la partie")
  if (room.status !== 'lobby') return fail('La partie est déjà lancée')
  const connected = connectedPlayers(room)
  if (connected.length < 2) return fail('Il faut au moins 2 joueurs connectés')
  room.impostorId = connected[random(connected.length)].id
  room.votes = {}
  transition(room, 'playing', now)
  return { ok: true }
}

export function endMatch(room: Room, actorId: string, now: number): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut terminer le match")
  if (room.status !== 'playing') return fail("La partie n'est pas en cours")
  room.votes = {}
  transition(room, 'voting', now)
  return { ok: true }
}

export function vote(room: Room, voterId: string, targetId: unknown, now: number): Result<{}> {
  if (room.status !== 'voting') return fail("Le vote n'est pas ouvert")
  const voter = room.players.find(p => p.id === voterId)
  if (!voter || voter.disconnected) return fail('Joueur non connecté à cette salle')
  if (targetId === voterId) return fail('Tu ne peux pas voter pour toi-même')
  if (typeof targetId !== 'string' || !room.players.some(p => p.id === targetId)) {
    return fail('Joueur ciblé introuvable')
  }
  room.votes[voterId] = targetId
  room.updatedAt = now
  return { ok: true }
}

/** Tous les joueurs connectés ont-ils voté ? */
export function allVoted(room: Room): boolean {
  if (room.status !== 'voting') return false
  const connected = connectedPlayers(room)
  return connected.length > 0 && connected.every(p => room.votes[p.id] !== undefined)
}

/**
 * Dépouille le vote et passe en révélation.
 * Barème : imposteur non démasqué +3 ; bon vote +2.
 * Égalité : l'imposteur est démasqué s'il fait partie des ex-aequo.
 */
export function reveal(room: Room, now: number): RoundResults {
  const tally: Record<string, number> = {}
  for (const targetId of Object.values(room.votes)) tally[targetId] = (tally[targetId] ?? 0) + 1

  const maxVotes = Math.max(0, ...Object.values(tally))
  const tied = Object.keys(tally).filter(id => tally[id] === maxVotes)
  const impostorId = room.impostorId ?? ''
  const accusedId = tied.includes(impostorId) ? impostorId : (tied[0] ?? null)
  const impostorFound = accusedId === impostorId

  const pointsAwarded: Record<string, number> = {}
  for (const p of room.players) {
    pointsAwarded[p.id] = p.id === impostorId
      ? (impostorFound ? 0 : 3)
      : (room.votes[p.id] === impostorId ? 2 : 0)
  }

  transition(room, 'reveal', now)
  return {
    impostorFound,
    impostorId,
    impostorName: room.players.find(p => p.id === impostorId)?.name,
    accusedId,
    accusedName: room.players.find(p => p.id === accusedId)?.name,
    tally,
    pointsAwarded,
    players: publicRoom(room).players,
    votes: { ...room.votes },
  }
}

export function nextRound(room: Room, actorId: string, now: number): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut lancer la manche suivante")
  if (room.status !== 'reveal') return fail("La manche n'est pas terminée")
  room.votes = {}
  room.impostorId = null
  room.round += 1
  transition(room, 'lobby', now)
  return { ok: true }
}
