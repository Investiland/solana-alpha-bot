import 'dotenv/config';

// ============================================================
// Lecture des variables d'environnement
// Toutes les valeurs ont un défaut raisonnable : tu peux les
// ajuster depuis Render (Environment) sans toucher au code.
// ============================================================

function envString(name: string, fallback = ''): string {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`⚠️ ${name}="${raw}" n'est pas un nombre, valeur par défaut ${fallback} utilisée`);
    return fallback;
  }
  return parsed;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'oui'].includes(raw.trim().toLowerCase());
}

const supabaseServiceKey = envString('SUPABASE_SERVICE_ROLE_KEY');
const supabaseAnonKey = envString('SUPABASE_ANON_KEY');

export const secrets = {
  supabaseUrl: envString('SUPABASE_URL'),
  // Le backend doit utiliser la clé service_role (jamais dans le front).
  // Repli temporaire sur la clé anon pour ne pas casser un déploiement en cours.
  supabaseKey: supabaseServiceKey || supabaseAnonKey,
  usingServiceKey: supabaseServiceKey.length > 0,
  telegramToken: envString('TELEGRAM_BOT_TOKEN'),
  telegramChatId: envString('TELEGRAM_CHAT_ID'),
  birdeyeKey: envString('BIRDEYE_API_KEY'),
};

export function assertSecrets(dryRun: boolean): void {
  const missing: string[] = [];
  if (!secrets.birdeyeKey) missing.push('BIRDEYE_API_KEY');
  if (!dryRun) {
    if (!secrets.supabaseUrl) missing.push('SUPABASE_URL');
    if (!secrets.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!secrets.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!secrets.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  }
  if (missing.length > 0) {
    throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')}`);
  }
}

export const config = {
  // Mode test : aucune écriture en base, aucun message Telegram
  dryRun: envBoolean('DRY_RUN', false),

  // ---------- Univers de tokens ----------
  minMarketCap: envNumber('MIN_MARKET_CAP', 500_000),
  maxMarketCap: envNumber('MAX_MARKET_CAP', 10_000_000),
  minLiquidity: envNumber('MIN_LIQUIDITY', 50_000),
  // Liquidité minimale en proportion du market cap (0.08 = 8 %)
  minLiquidityToMcap: envNumber('MIN_LIQUIDITY_TO_MCAP', 0.08),
  minVolume24h: envNumber('MIN_VOLUME_24H', 50_000),
  // Tri Birdeye : les tokens les plus actifs de la tranche (stable d'un scan à l'autre)
  universeSortBy: envString('UNIVERSE_SORT_BY', 'volume_24h_usd'),
  // Nombre de pages de 100 tokens par scan (chaque page coûte des CU Birdeye)
  universePages: Math.max(1, Math.min(5, envNumber('UNIVERSE_PAGES', 1))),

  // ---------- Rythme ----------
  scanIntervalMinutes: envNumber('SCAN_INTERVAL_MINUTES', 5),

  // ---------- Historique / statistiques ----------
  maxHistoryPoints: 288, // 24 h à 5 min
  minHistoryPoints: envNumber('MIN_HISTORY_POINTS', 36), // 3 h
  baselineExcludeRecent: 6, // on exclut les 30 dernières minutes de la référence
  snapshotRetentionDays: envNumber('SNAPSHOT_RETENTION_DAYS', 3),

  // ---------- Filtres éliminatoires ----------
  minAgeHours: envNumber('MIN_AGE_HOURS', 48),
  maxTop10HolderShare: envNumber('MAX_TOP10_SHARE', 0.4),
  maxPump1hPercent: envNumber('MAX_PUMP_1H', 60),
  maxLiquidityDrop1hPercent: envNumber('MAX_LIQUIDITY_DROP_1H', 15),
  minMove5mPercent: envNumber('MIN_MOVE_5M', 2),
  minMove1hPercent: envNumber('MIN_MOVE_1H', 5),
  // Il faut au moins une vraie hausse d'activité pour devenir candidat
  minActivityZ: envNumber('MIN_ACTIVITY_Z', 2),
  minAcceleration: envNumber('MIN_ACCELERATION', 2),

  // ---------- Seuils de niveau (score 0-100) ----------
  alertScore: envNumber('ALERT_SCORE', 58),
  criticalScore: envNumber('CRITICAL_SCORE', 72),
  // Anti-clignotement : on ne sort qu'en dessous de ce score…
  exitScore: envNumber('EXIT_SCORE', 40),
  // …pendant ce nombre de scans consécutifs
  exitScans: envNumber('EXIT_SCANS', 2),
  // Une détection terminée depuis moins longtemps est rouverte au lieu d'en créer une nouvelle
  reopenWindowMinutes: envNumber('REOPEN_WINDOW_MINUTES', 60),

  // ---------- Pénalités ----------
  maxTradesPerWallet: envNumber('MAX_TRADES_PER_WALLET', 6),
  latePump24hPercent: envNumber('LATE_PUMP_24H', 300),

  // ---------- Suivi des performances ----------
  winThresholdPercent: envNumber('WIN_THRESHOLD', 20),
  lossThresholdPercent: envNumber('LOSS_THRESHOLD', 15),
  outcomeWindowHours: 4,
  trackingHours: 24,

  // ---------- Budget d'appels Birdeye ----------
  maxOverviewPerScan: envNumber('MAX_OVERVIEW_PER_SCAN', 6),
  maxSecurityPerScan: envNumber('MAX_SECURITY_PER_SCAN', 8),
  securityCacheHours: envNumber('SECURITY_CACHE_HOURS', 24),
  birdeyeMinDelayMs: envNumber('BIRDEYE_MIN_DELAY_MS', 250),
  requestTimeoutMs: 15_000,

  // ---------- Telegram ----------
  // 'alert' = alertes + critiques, 'critical' = critiques uniquement
  telegramMinLevel: envString('TELEGRAM_MIN_LEVEL', 'alert') === 'critical' ? 'critical' : 'alert',
} as const;

export type Config = typeof config;
