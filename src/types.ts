// types.ts
// Modèle de données du jeu et protocole socket (source de vérité).
// Le frontend en garde une copie dans src/shared/protocol.ts : toute
// modification ici doit y être reportée.

export type RoomStatus = 'lobby' | 'playing' | 'voting' | 'reveal'

/** Joueur tel que stocké côté serveur (contient des secrets). */
export interface Player {
  id: string
  /** Secret connu uniquement du navigateur du joueur. */
  token: string
  socketId: string | null
  name: string
  disconnected: boolean
}

/** Salle telle que stockée côté serveur. Ne JAMAIS l'envoyer telle quelle. */
export interface Room {
  /** Code court à 4 lettres. */
  id: string
  /** Clé unique pour les scores (un code peut être réutilisé plus tard). */
  scoreKey: string
  hostId: string
  hostName: string
  players: Player[]
  status: RoomStatus
  impostorId: string | null
  /** voterId → targetId */
  votes: Record<string, string>
  round: number
  /** Horodatage (ms) de la dernière modification. */
  updatedAt: number
}

// ─── Vues envoyées aux clients ───────────────────────────────────

export interface PublicPlayer {
  id: string
  name: string
  disconnected: boolean
  hasVoted: boolean
}

export interface PublicRoom {
  id: string
  hostId: string
  hostName: string
  status: RoomStatus
  round: number
  players: PublicPlayer[]
  votesCount: number
}

export interface You {
  playerId: string
  token: string
  name: string
}

export interface PrivateView {
  you: You
  isImpostor: boolean
}

export interface ScoreLine {
  name: string
  total: number
}

export interface RoundResults {
  impostorFound: boolean
  impostorId: string
  impostorName: string | undefined
  accusedId: string | null
  accusedName: string | undefined
  tally: Record<string, number>
  pointsAwarded: Record<string, number>
  players: PublicPlayer[]
  votes: Record<string, string>
  cumulativeScores?: ScoreLine[]
}

// ─── Protocole socket ────────────────────────────────────────────

export interface ClientToServerEvents {
  'room:create': (p: { playerName: string }) => void
  'room:join': (p: { roomId: string; playerName?: string; token?: string }) => void
  'room:rejoin': (p: { roomId: string; token: string }) => void
  'game:start': (p: { roomId: string }) => void
  'game:end': (p: { roomId: string }) => void
  'vote:cast': (p: { roomId: string; targetId: string }) => void
  'scores:request': (p: { roomId: string }) => void
  'round:next': (p: { roomId: string }) => void
}

export interface ServerToClientEvents {
  'room:created': (p: { room: PublicRoom } & PrivateView) => void
  'room:joined': (p: { room: PublicRoom } & PrivateView) => void
  'room:rejoined': (p: { room: PublicRoom } & PrivateView) => void
  'room:updated': (p: { room: PublicRoom }) => void
  'room:error': (p: { message: string }) => void
  'room:session-lost': (p: { message: string }) => void
  'host:changed': (p: { newHostId: string }) => void
  'game:started': (p: { room: PublicRoom; isImpostor: boolean }) => void
  'voting:started': (p: { room: PublicRoom }) => void
  'vote:registered': (p: { votesCount: number; totalPlayers: number }) => void
  'reveal:result': (p: { results: RoundResults; room: PublicRoom }) => void
  'scores:data': (p: { scores: ScoreLine[]; room: PublicRoom }) => void
  'round:next': (p: { room: PublicRoom }) => void
}
