// server.js
// Point d'entrée du serveur — Express + Socket.io

require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { registerSocketEvents } = require('./socket')

const app = express()
const server = http.createServer(app)

// Configuration Socket.io avec CORS pour autoriser le frontend
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
})

// Route de santé (Railway et toi pouvez vérifier que le serveur tourne)
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'RL Imposteur 2.0 — Backend opérationnel 🚀' })
})

// Enregistre tous les événements Socket.io
registerSocketEvents(io)

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`)
})
