// server.ts
// Point d'entrée du serveur — Express + Socket.io

import 'dotenv/config'
import http from 'node:http'
import express from 'express'
import { Server } from 'socket.io'
import { GameSockets } from './socket'
import { RoomRegistry } from './store/registry'
import type { Storage } from './store/storage'
import { storageFromEnv } from './store/supabase'
import type { ClientToServerEvents, ServerToClientEvents } from './types'

export interface ServerOptions {
  storage?: Storage
  frontendUrl?: string
  /** Délai de grâce après une déconnexion (30 s par défaut). */
  graceMs?: number
  /** Délai laissé aux joueurs pour revenir après un redémarrage (2 min par défaut). */
  restartGraceMs?: number
  /** Âge maximal d'une salle restaurée (12 h par défaut). */
  maxRoomAgeMs?: number
}

export async function createServer(opts: ServerOptions = {}) {
  const env = process.env
  const storage = opts.storage ?? storageFromEnv()
  const graceMs = opts.graceMs ?? (Number(env.GRACE_PERIOD_MS) || 30_000)
  const restartGraceMs = opts.restartGraceMs ?? (Number(env.RESTART_GRACE_MS) || 120_000)
  const maxRoomAgeMs = opts.maxRoomAgeMs ?? 12 * 60 * 60 * 1000

  const app = express()
  const server = http.createServer(app)
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: opts.frontendUrl ?? env.FRONTEND_URL ?? 'http://localhost:5173', methods: ['GET', 'POST'] },
  })

  const registry = new RoomRegistry(storage)
  const restored = await registry.restore(Date.now(), maxRoomAgeMs)
  const sockets = new GameSockets(io, registry, { graceMs })
  for (const room of restored) {
    for (const player of room.players) sockets.scheduleRemoval(room, player, restartGraceMs)
  }
  if (restored.length) console.log(`♻️  ${restored.length} salle(s) restaurée(s)`)

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', message: 'RL Imposteur — Backend opérationnel 🚀', rooms: registry.all().length })
  })

  async function close() {
    sockets.stopTimers()
    await new Promise<void>(resolve => io.close(() => resolve()))
    await registry.flush()
  }

  return { app, server, io, registry, close }
}

// Lancement direct : node dist/server.js
if (require.main === module) {
  createServer().then(({ server }) => {
    const port = Number(process.env.PORT) || 3001
    server.listen(port, () => console.log(`🚀 Serveur lancé sur http://localhost:${port}`))
  }).catch(err => {
    console.error('Démarrage impossible :', err)
    process.exit(1)
  })
}
