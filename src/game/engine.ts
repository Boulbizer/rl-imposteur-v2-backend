// game/engine.ts
// Moteur de jeu PUR : aucune dépendance au réseau, au stockage ou à l'horloge
// globale. Chaque action vérifie la transition d'état et les droits, puis
// modifie la salle. Testé unitairement dans test/engine.test.ts.
//
//   lobby ─start─▶ playing ─endMatch─▶ debate ─(chrono ou hôte)─▶ voting ─(tous / chrono)─▶ reveal
//     ▲                         └──────── (débat désactivé) ────────┘                         │
//     └──────────────────────────────────── nextRound ──────────────────────────────────────────┘

import crypto from 'node:crypto'
import type {
  Player,
  PrivateView,
  PublicRoom,
  RlMode,
  Role,
  Room,
  RoomSettings,
  RoomStatus,
  RoundResults,
} from '../types'

export const MAX_PLAYERS = 10
export const MAX_NAME_LENGTH = 20
export const MAX_REASON_LENGTH = 80
/** Pas de I ni de O : pas de confusion avec 1 et 0. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 4
/** Nombre minimal de joueurs connectés pour que le rôle soit distribué. */
export const MIN_PLAYERS_FOR = { jester: 4, detective: 5 } as const
export const RL_MODES: readonly RlMode[] = ['1v1', '2v2', '3v3', 'hoops', 'rumble', 'dropshot']

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: '3v3',
  jester: true,
  detective: true,
  debateSeconds: 60,
  voteSeconds: 60,
}

/** Barème. */
export const POINTS = {
  impostorUndetected: 3,
  goodVote: 2,
  detectiveGoodVote: 3,
  jesterAccused: 4,
} as const

/** Source d'aléa injectable (déterministe dans les tests). */
export type RandomInt = (maxExclusive: number) => number
export const cryptoRandomInt: RandomInt = max => crypto.randomInt(max)

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  lobby: ['playing'],
  playing: ['debate', 'voting'],
  debate: ['voting'],
  voting: ['reveal'],
  reveal: ['lobby'],
}

export function canTransition(from: RoomStatus, to: RoomStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

function transition(room: Room, to: RoomStatus, now: number, durationSeconds = 0): void {
  if (!canTransition(room.status, to)) {
    throw new Error(`Transition interdite : ${room.status} → ${to}`)
  }
  room.status = to
  room.phaseEndsAt = durationSeconds > 0 ? now + durationSeconds * 1000 : null
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

function shuffle<T>(items: T[], random: RandomInt): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
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
const roleOf = (room: Room, playerId: string): Role | undefined => room.roles[playerId]
const playerWithRole = (room: Room, role: Role) =>
  Object.keys(room.roles).find(id => room.roles[id] === role) ?? null

// ─── Vues ───────────────────────────────────────────────────────

/** Ce que TOUS les joueurs ont le droit de voir : ni rôles, ni missions, ni votes, ni jetons. */
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
    settings: { ...room.settings },
    phaseEndsAt: room.phaseEndsAt,
    accusations: room.accusations.map(a => ({ ...a })),
  }
}

/** Ce que seul `player` a le droit de voir. */
export function privateView(room: Room, player: Player): PrivateView {
  const inRound = room.status !== 'lobby'
  return {
    you: { playerId: player.id, token: player.token, name: player.name },
    isImpostor: inRound && room.impostorId === player.id,
    role: inRound ? (roleOf(room, player.id) ?? null) : null,
    mission: inRound ? (room.missions[player.id] ?? null) : null,
    clue: inRound ? (room.clues[player.id] ?? null) : null,
  }
}

// ─── Salle et joueurs ───────────────────────────────────────────

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
    roles: {},
    missions: {},
    clues: {},
    accusations: [],
    settings: { ...DEFAULT_SETTINGS },
    phaseEndsAt: null,
    round: 1,
    updatedAt: now,
  }
  return { ok: true, room, player: host }
}

/** Complète une salle sauvegardée par une version antérieure du serveur. */
export function upgradeRoom(room: Room): Room {
  room.roles ??= {}
  room.missions ??= {}
  room.clues ??= {}
  room.accusations ??= []
  room.settings = { ...DEFAULT_SETTINGS, ...(room.settings ?? {}) }
  room.phaseEndsAt ??= null
  if (room.impostorId && !room.roles[room.impostorId]) {
    for (const p of room.players) room.roles[p.id] = p.id === room.impostorId ? 'impostor' : 'teammate'
  }
  return room
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
  room.accusations = room.accusations.filter(a => a.fromId !== playerId && a.targetId !== playerId)
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

// ─── Réglages ───────────────────────────────────────────────────

const clampSeconds = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : undefined

export function updateSettings(room: Room, actorId: string, patch: unknown, now: number): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut modifier les réglages")
  if (room.status !== 'lobby') return fail('Réglages modifiables uniquement dans le salon')
  if (!patch || typeof patch !== 'object') return fail('Réglages invalides')
  const p = patch as Record<string, unknown>
  const next = { ...room.settings }
  if (p.mode !== undefined) {
    if (!RL_MODES.includes(p.mode as RlMode)) return fail('Mode de jeu inconnu')
    next.mode = p.mode as RlMode
  }
  if (typeof p.jester === 'boolean') next.jester = p.jester
  if (typeof p.detective === 'boolean') next.detective = p.detective
  const debate = clampSeconds(p.debateSeconds, 300)
  if (debate !== undefined) next.debateSeconds = debate
  const vote = clampSeconds(p.voteSeconds, 300)
  if (vote !== undefined) next.voteSeconds = vote
  room.settings = next
  room.updatedAt = now
  return { ok: true }
}

// ─── Manche ─────────────────────────────────────────────────────

/** Rôles effectivement distribués pour `count` joueurs connectés. */
export function rolesFor(count: number, settings: RoomSettings): Role[] {
  const roles: Role[] = ['impostor']
  if (settings.jester && count >= MIN_PLAYERS_FOR.jester) roles.push('jester')
  if (settings.detective && count >= MIN_PLAYERS_FOR.detective) roles.push('detective')
  while (roles.length < count) roles.push('teammate')
  return roles
}

/**
 * Lance la manche : distribue les rôles (et l'indice du Détective).
 * Les missions arrivent ensuite via `assignMissions` (génération asynchrone).
 */
export function start(room: Room, actorId: string, now: number, random: RandomInt = cryptoRandomInt): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut lancer la partie")
  if (room.status !== 'lobby') return fail('La partie est déjà lancée')
  const connected = connectedPlayers(room)
  if (connected.length < 2) return fail('Il faut au moins 2 joueurs connectés')

  const players = shuffle(connected, random)
  const roles = rolesFor(players.length, room.settings)
  room.roles = {}
  players.forEach((p, i) => { room.roles[p.id] = roles[i] })
  room.impostorId = playerWithRole(room, 'impostor')
  room.votes = {}
  room.missions = {}
  room.clues = {}
  room.accusations = []

  const detectiveId = playerWithRole(room, 'detective')
  if (detectiveId) {
    const innocents = players.filter(p => room.roles[p.id] !== 'impostor' && p.id !== detectiveId)
    const innocent = innocents[random(innocents.length)]
    room.clues[detectiveId] = `${innocent.name} n'est pas l'imposteur.`
  }

  transition(room, 'playing', now)
  return { ok: true }
}

/** Liste des rôles de la manche, dans un ordre stable, pour générer les missions. */
export function missionSlots(room: Room): { playerId: string; role: Role }[] {
  return room.players
    .filter(p => room.roles[p.id])
    .map(p => ({ playerId: p.id, role: room.roles[p.id] }))
}

export function assignMissions(room: Room, missions: Record<string, string>, now: number): void {
  for (const [playerId, text] of Object.entries(missions)) {
    if (room.roles[playerId]) room.missions[playerId] = text
  }
  room.updatedAt = now
}

/** Fin du match RL : débat si activé, sinon vote direct. */
export function endMatch(room: Room, actorId: string, now: number): Result<{ next: 'debate' | 'voting' }> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut terminer le match")
  if (room.status !== 'playing') return fail("La partie n'est pas en cours")
  room.votes = {}
  if (room.settings.debateSeconds > 0) {
    transition(room, 'debate', now, room.settings.debateSeconds)
    return { ok: true, next: 'debate' }
  }
  transition(room, 'voting', now, room.settings.voteSeconds)
  return { ok: true, next: 'voting' }
}

/** Accusation publique pendant le débat (une par joueur, remplaçable). */
export function accuse(room: Room, playerId: string, targetId: unknown, reason: unknown, now: number): Result<{}> {
  if (room.status !== 'debate') return fail("Le débat n'est pas ouvert")
  const player = room.players.find(p => p.id === playerId)
  if (!player || player.disconnected) return fail('Joueur non connecté à cette salle')
  if (targetId === playerId) return fail('Tu ne peux pas t’accuser toi-même')
  if (typeof targetId !== 'string' || !room.players.some(p => p.id === targetId)) {
    return fail('Joueur accusé introuvable')
  }
  const text = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_LENGTH) : ''
  if (!text) return fail('Donne une raison')
  room.accusations = room.accusations.filter(a => a.fromId !== playerId)
  room.accusations.push({ fromId: playerId, targetId, reason: text })
  room.updatedAt = now
  return { ok: true }
}

/** Passage au vote : à la fin du chrono (actorId null) ou par l'hôte. */
export function startVoting(room: Room, actorId: string | null, now: number): Result<{}> {
  if (actorId !== null && !isHost(room, actorId)) return fail("Seul l'hôte peut écourter le débat")
  if (room.status !== 'debate') return fail("Le débat n'est pas en cours")
  transition(room, 'voting', now, room.settings.voteSeconds)
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
 * Dépouille le vote et passe en révélation (aussi appelé à la fin du chrono,
 * avec les votes déjà émis).
 *
 * Désignation : le plus voté. En cas d'égalité, l'imposteur est démasqué s'il
 * est parmi les ex-aequo ; sinon le Bouffon l'emporte s'il y est.
 *
 * Barème : imposteur non démasqué +3 ; Bouffon désigné +4 ;
 * bon vote +2 (Détective +3).
 */
export function reveal(room: Room, now: number): RoundResults {
  const tally: Record<string, number> = {}
  for (const targetId of Object.values(room.votes)) tally[targetId] = (tally[targetId] ?? 0) + 1

  const maxVotes = Math.max(0, ...Object.values(tally))
  const tied = Object.keys(tally).filter(id => tally[id] === maxVotes)
  const impostorId = room.impostorId ?? ''
  const jesterId = playerWithRole(room, 'jester')
  const accusedId = tied.includes(impostorId)
    ? impostorId
    : jesterId && tied.includes(jesterId) ? jesterId : (tied[0] ?? null)
  const impostorFound = accusedId === impostorId
  const jesterWon = !!jesterId && accusedId === jesterId

  const pointsAwarded: Record<string, number> = {}
  for (const p of room.players) {
    const role = room.roles[p.id] ?? 'teammate'
    const goodVote = room.votes[p.id] === impostorId
    let pts = 0
    if (role === 'impostor') pts = impostorFound ? 0 : POINTS.impostorUndetected
    else if (role === 'jester') pts = jesterWon ? POINTS.jesterAccused : 0
    else if (role === 'detective') pts = goodVote ? POINTS.detectiveGoodVote : 0
    else pts = goodVote ? POINTS.goodVote : 0
    pointsAwarded[p.id] = pts
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
    roles: { ...room.roles },
    missions: { ...room.missions },
    accusations: room.accusations.map(a => ({ ...a })),
    jesterId,
    jesterWon,
  }
}

export function nextRound(room: Room, actorId: string, now: number): Result<{}> {
  if (!isHost(room, actorId)) return fail("Seul l'hôte peut lancer la manche suivante")
  if (room.status !== 'reveal') return fail("La manche n'est pas terminée")
  room.votes = {}
  room.impostorId = null
  room.roles = {}
  room.missions = {}
  room.clues = {}
  room.accusations = []
  room.round += 1
  transition(room, 'lobby', now)
  return { ok: true }
}
