// game/missions.ts
// Missions secrètes de chaque manche.
//
// - ClaudeMissionProvider : génère des missions inédites via l'API Claude.
//   Seuls le mode de jeu et la liste des rôles sont envoyés : jamais de pseudo.
// - OfflineMissionProvider : banque de missions locale, toujours disponible.
// - withFallback : Claude d'abord, banque locale si pas de clé, erreur,
//   refus du modèle, réponse invalide ou délai dépassé. La partie ne
//   dépend jamais de la disponibilité de l'API.

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { RlMode, Role } from '../types'
import { cryptoRandomInt, type RandomInt } from './engine'

export interface MissionRequest {
  mode: RlMode
  /** Rôle de chaque emplacement ; la réponse suit le même ordre. */
  roles: Role[]
}

export interface MissionProvider {
  readonly name: string
  generate(req: MissionRequest): Promise<string[]>
}

// ─── Banque hors ligne ──────────────────────────────────────────

const OFFLINE: Record<Role, string[]> = {
  impostor: [
    'Rate au moins 2 dégagements faciles devant ton propre but.',
    'Fais un faux kickoff une fois : recule au lieu d’aller au ballon.',
    'Ne prends aucun gros boost (100) pendant toute la première minute.',
    'Touche le ballon vers ton propre camp au moins 3 fois.',
    'Laisse passer un tir cadré que tu pouvais arrêter, sans que ça se voie.',
    'Écrase-toi contre le mur au moins une fois au moment d’une action décisive.',
    'Vole le boost d’un coéquipier qui en a besoin, au moins deux fois.',
    'Reste en attaque quand ton équipe a besoin d’un défenseur, au moins une fois.',
  ],
  jester: [
    'Fais-toi soupçonner : rate un tir immanquable de façon bien visible.',
    'Joue de façon étrange mais pas nuisible : saute sans raison avant chaque kickoff.',
    'Accuse quelqu’un très tôt dans le débat, avec beaucoup d’aplomb.',
    'Défends-toi mal si on t’accuse : plus tu es suspect, mieux c’est.',
  ],
  detective: [
    'Observe qui touche le ballon vers son propre camp et note-le.',
    'Compte les dégagements ratés de chaque joueur.',
    'Surveille qui prend les gros boosts et à quel moment.',
  ],
  teammate: [
    'Compte qui rate ses dégagements.',
    'Observe qui se trouve hors position quand l’adversaire marque.',
    'Repère qui ne va jamais au kickoff.',
    'Note qui prend le boost d’un coéquipier.',
    'Surveille les tirs ratés devant un but vide.',
    'Observe qui reste en attaque pendant les contre-attaques adverses.',
  ],
}

export class OfflineMissionProvider implements MissionProvider {
  readonly name = 'offline'
  constructor(private random: RandomInt = cryptoRandomInt) {}

  async generate(req: MissionRequest): Promise<string[]> {
    const used = new Set<string>()
    return req.roles.map(role => {
      const pool = OFFLINE[role].filter(m => !used.has(m))
      const choices = pool.length ? pool : OFFLINE[role]
      const mission = choices[this.random(choices.length)]
      used.add(mission)
      return mission
    })
  }
}

// ─── Claude ─────────────────────────────────────────────────────

const MODE_LABELS: Record<RlMode, string> = {
  '1v1': '1 contre 1 (Duel)',
  '2v2': '2 contre 2 (Doubles)',
  '3v3': '3 contre 3 (Standard)',
  hoops: 'Hoops (basket)',
  rumble: 'Rumble (pouvoirs aléatoires)',
  dropshot: 'Dropshot (sol qui se brise)',
}

const ROLE_BRIEFS: Record<Role, string> = {
  impostor: "Imposteur : doit faire perdre son équipe discrètement. Mission = un sabotage précis, observable mais déguisable en erreur de jeu.",
  jester: 'Bouffon : veut être désigné comme imposteur au vote. Mission = un comportement étrange mais inoffensif qui attire les soupçons.',
  detective: 'Détective : enquête. Mission = une observation précise à mener pendant le match.',
  teammate: 'Équipier : joue normalement. Mission = une observation précise à mener pendant le match.',
}

const MissionsSchema = z.object({
  missions: z.array(z.object({
    slot: z.number().int(),
    text: z.string(),
  })),
})

const SYSTEM_PROMPT = `Tu écris les missions secrètes d'un jeu de soirée entre amis joué pendant des matchs de Rocket League : chaque joueur reçoit un rôle secret, puis tout le monde vote pour démasquer l'imposteur.

Règles d'écriture :
- Français, tutoiement, une seule phrase par mission, 120 caractères maximum.
- Concrète et vérifiable pendant UN match : un geste de jeu précis (kickoff, boost, dégagement, rotation, tir, démo, mur, plafond), avec un nombre ou un moment quand c'est utile.
- Adaptée au mode de jeu indiqué (par exemple pas de rotation à trois en 1v1, des paniers en Hoops, des pouvoirs en Rumble).
- Réalisable par un joueur de niveau moyen, sans triche ni comportement toxique envers qui que ce soit.
- Toutes les missions d'une même manche sont différentes.`

export interface ClaudeMissionOptions {
  client?: Anthropic
  model?: string
  timeoutMs?: number
}

export class ClaudeMissionProvider implements MissionProvider {
  readonly name = 'claude'
  private client: Anthropic
  private model: string

  constructor(opts: ClaudeMissionOptions = {}) {
    this.client = opts.client ?? new Anthropic({ timeout: opts.timeoutMs ?? 15_000, maxRetries: 1 })
    this.model = opts.model ?? 'claude-opus-5-5'
  }

  async generate(req: MissionRequest): Promise<string[]> {
    const slots = req.roles.map((role, slot) => `- emplacement ${slot} : ${ROLE_BRIEFS[role]}`).join('\n')
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      // Tâche courte et créative : effort bas pour répondre vite pendant que les joueurs attendent
      output_config: { effort: 'low', format: zodOutputFormat(MissionsSchema) },
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Mode de jeu : ${MODE_LABELS[req.mode]}.\nÉcris une mission pour chacun des ${req.roles.length} emplacements :\n${slots}`,
      }],
    })

    if (response.stop_reason === 'refusal') throw new Error('Génération refusée par le modèle')
    const parsed = response.parsed_output
    if (!parsed) throw new Error('Réponse de Claude illisible')

    return req.roles.map((_, slot) => {
      const text = parsed.missions.find(m => m.slot === slot)?.text.trim()
      if (!text) throw new Error(`Mission manquante pour l'emplacement ${slot}`)
      return text.slice(0, 160)
    })
  }
}

/** Essaie `primary`, puis `fallback` en cas d'échec ou de dépassement du délai. */
export function withFallback(primary: MissionProvider, fallback: MissionProvider, timeoutMs = 12_000): MissionProvider {
  return {
    name: `${primary.name}+${fallback.name}`,
    async generate(req) {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          primary.generate(req),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('délai dépassé')), timeoutMs)
          }),
        ])
      } catch (err) {
        console.warn(`Missions ${primary.name} indisponibles (${(err as Error).message}) : banque locale utilisée`)
        return fallback.generate(req)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Claude si une clé est configurée, sinon la banque locale seule. */
export function missionProviderFromEnv(env: NodeJS.ProcessEnv = process.env): MissionProvider {
  const offline = new OfflineMissionProvider()
  if (env.MISSIONS_PROVIDER === 'offline') return offline
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('ℹ️  Pas de clé API Claude : missions tirées de la banque locale')
    return offline
  }
  const claude = new ClaudeMissionProvider({ model: env.CLAUDE_MODEL || undefined })
  return withFallback(claude, offline)
}
