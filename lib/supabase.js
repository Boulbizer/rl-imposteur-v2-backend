// lib/supabase.js
// Connexion à Supabase depuis le backend
// La "service key" a tous les droits — ne jamais l'exposer côté frontend

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = supabase
