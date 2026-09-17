import cron from 'node-cron';
import { assertSecrets, config, secrets } from './config.js';
import { BirdeyeClient } from './birdeye.js';
import { Database } from './db.js';
import { DetectionManager } from './detections.js';
import {
  buildMarketContext,
  computeBaseFeatures,
  evaluate,
  preScreen,
} from './scoring.js';
import { TelegramNotifier } from './telegram.js';
import type {
  BaseFeatures,
  Evaluation,
  FlowInfo,
  HistoryPoint,
  MarketSnapshot,
  SecurityInfo,
  TokenMeta,
} from './types.js';

const HOUR = 3_600_000;

assertSecrets(config.dryRun);

const birdeye = new BirdeyeClient();
const db = new Database();
const detections = new DetectionManager();
const telegram = new TelegramNotifier();

// ------------------------------------------------------------
// État en mémoire (le worker Render tourne en continu)
// ------------------------------------------------------------
const history = new Map<string, HistoryPoint[]>();
const historyLoaded = new Set<string>();
const tokenMeta = new Map<string, TokenMeta>();
const flowCache = new Map<string, FlowInfo>();
const lastSeen = new Map<string, number>();

let scanRunning = false;
let scanCount = 0;
let alertsSent = 0;
let lastPurgeAt = 0;
let detectionsLoaded = false;

function snapshotToPoint(s: MarketSnapshot): HistoryPoint {
  return {
    t: s.timestamp,
    price: s.price,
    volume5m: s.volume5m,
    volume1h: s.volume1h,
    trades5m: s.trades5m,
    priceChange5m: s.priceChange5m,
    priceChange1h: s.priceChange1h,
    liquidity: s.liquidity,
    holders: s.holders,
  };
}

async function ensureStateLoaded(addresses: string[]): Promise<void> {
  if (!detectionsLoaded) {
    detections.load(await db.loadRecentDetections(Date.now() - 25 * HOUR));
    detectionsLoaded = true;
    console.log(`📂 ${detections.all.length} détection(s) récente(s) rechargée(s)`);
  }

  const missing = addresses.filter(a => !historyLoaded.has(a));
  if (missing.length === 0) return;

  const [loadedHistory, loadedMeta] = await Promise.all([
    db.loadHistory(missing, Date.now() - 24 * HOUR),
    db.loadTokenMeta(missing),
  ]);

  for (const address of missing) {
    const points = loadedHistory.get(address) ?? [];
    const current = history.get(address) ?? [];
    history.set(address, [...points, ...current].slice(-config.maxHistoryPoints));
    historyLoaded.add(address);
    const meta = loadedMeta.get(address);
    if (meta) tokenMeta.set(address, meta);
  }

  const totalPoints = missing.reduce((sum, a) => sum + (loadedHistory.get(a)?.length ?? 0), 0);
  console.log(`📂 Historique chargé pour ${missing.length} token(s) (${totalPoints} points)`);
}

function forgetStaleTokens(now: number): void {
  for (const [address, seenAt] of lastSeen) {
    if (now - seenAt > 24 * HOUR && !detections.isActive(address)) {
      history.delete(address);
      historyLoaded.delete(address);
      flowCache.delete(address);
      tokenMeta.delete(address);
      lastSeen.delete(address);
    }
  }
}

async function runScan(): Promise<void> {
  if (scanRunning) {
    console.log('⚠️ Scan précédent encore en cours, on passe ce cycle');
    return;
  }
  scanRunning = true;
  scanCount++;
  const startedAt = Date.now();

  try {
    // ---------- 1. Univers ----------
    const snapshots = await birdeye.listUniverse();
    if (snapshots.length === 0) {
      console.log('⚠️ Aucun token reçu de Birdeye ce cycle');
      return;
    }
    const now = snapshots[0].timestamp;
    const addresses = snapshots.map(s => s.address);
    for (const a of addresses) lastSeen.set(a, now);

    await ensureStateLoaded(addresses);

    // ---------- 2. Mesures sans appel API ----------
    const features = new Map<string, BaseFeatures>();
    for (const snap of snapshots) {
      features.set(snap.address, computeBaseFeatures(snap, history.get(snap.address) ?? []));
    }
    const context = buildMarketContext(snapshots, features);

    // ---------- 3. Candidats à analyser en profondeur ----------
    const candidates = snapshots
      .map(snap => {
        const screen = preScreen(snap, features.get(snap.address)!);
        const active = detections.isActive(snap.address);
        return { snap, active, include: screen.candidate || active, priority: screen.priority + (active ? 100 : 0) };
      })
      .filter(c => c.include)
      .sort((a, b) => b.priority - a.priority);

    let securityCalls = 0;
    let overviewCalls = 0;
    const newTokenRows: Parameters<Database['upsertTokens']>[0] = [];

    for (const { snap } of candidates) {
      const meta: TokenMeta = tokenMeta.get(snap.address) ?? {
        createdAtMs: null,
        listingTimeMs: snap.listingTimeMs,
        security: null,
      };

      // Sécurité (cache 24 h)
      const securityStale =
        !meta.security ||
        now - meta.security.checkedAt > config.securityCacheHours * HOUR;
      if (securityStale && securityCalls < config.maxSecurityPerScan) {
        securityCalls++;
        const security = await birdeye.getSecurity(snap.address);
        if (security) {
          meta.security = security;
          if (!meta.createdAtMs && security.creationTimeMs) meta.createdAtMs = security.creationTimeMs;
          tokenMeta.set(snap.address, meta);
          newTokenRows.push({
            address: snap.address,
            name: snap.name,
            symbol: snap.symbol,
            createdAtMs: meta.createdAtMs,
            listingTimeMs: snap.listingTimeMs,
            security,
          });
        }
      }

      // Flux d'achats (seulement si la sécurité ne bloque pas déjà)
      if (meta.security?.ok && overviewCalls < config.maxOverviewPerScan) {
        overviewCalls++;
        const flow = await birdeye.getFlow(snap.address);
        if (flow) flowCache.set(snap.address, flow);
      }
    }

    // ---------- 4. Évaluation ----------
    const evaluations = new Map<string, Evaluation>();
    for (const snap of snapshots) {
      const meta = tokenMeta.get(snap.address);
      const cachedFlow = flowCache.get(snap.address);
      // Un flux de plus de 6 minutes ne décrit plus le scan actuel
      const flow = cachedFlow && now - cachedFlow.fetchedAt <= 6 * 60_000 ? cachedFlow : null;

      evaluations.set(
        snap.address,
        evaluate({
          snap,
          features: features.get(snap.address)!,
          context,
          security: meta?.security ?? null,
          flow,
          createdAtMs: meta?.createdAtMs ?? null,
        })
      );
    }

    // ---------- 5. Détections et suivi des prix ----------
    const prices = new Map<string, number>(snapshots.map(s => [s.address, s.price]));
    const missingPrices = detections
      .trackedAddresses(now)
      .filter(a => !prices.has(a));
    if (missingPrices.length > 0) {
      const extra = await birdeye.getPrices(missingPrices);
      for (const [a, p] of extra) prices.set(a, p);
    }

    const notifications = detections.process(evaluations, prices, now);

    // ---------- 6. Écritures (groupées) ----------
    await db.insertSnapshots([...evaluations.values()]);

    for (const snap of snapshots) {
      const list = history.get(snap.address) ?? [];
      list.push(snapshotToPoint(snap));
      if (list.length > config.maxHistoryPoints) list.splice(0, list.length - config.maxHistoryPoints);
      history.set(snap.address, list);
    }

    // Tokens jamais vus : on les enregistre une fois
    for (const snap of snapshots) {
      if (!tokenMeta.has(snap.address)) {
        tokenMeta.set(snap.address, {
          createdAtMs: null,
          listingTimeMs: snap.listingTimeMs,
          security: null,
        });
        newTokenRows.push({
          address: snap.address,
          name: snap.name,
          symbol: snap.symbol,
          createdAtMs: null,
          listingTimeMs: snap.listingTimeMs,
          security: null,
        });
      }
    }
    await db.upsertTokens(newTokenRows);

    let writes = 0;
    for (const d of detections.pendingWrites(now)) {
      if (await db.saveDetection(d)) {
        detections.markPersisted(d, now);
        writes++;
      }
    }

    // Les notifications partent après l'écriture pour que le dashboard soit déjà à jour
    alertsSent += await telegram.send(notifications);

    // ---------- 7. Entretien ----------
    if (now - lastPurgeAt > HOUR) {
      lastPurgeAt = now;
      await db.purgeOldSnapshots();
      forgetStaleTokens(now);
    }

    // ---------- Résumé ----------
    const levels = [...evaluations.values()];
    const ready = levels.filter(e => e.features.ready).length;
    const alerts = levels.filter(e => e.level === 'alert').length;
    const criticals = levels.filter(e => e.level === 'critical').length;
    const active = detections.all.filter(d => d.status === 'active').length;
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(
      `✅ Scan #${scanCount} en ${duration} s | ${snapshots.length} tokens (${ready} avec historique) | ` +
        `${candidates.length} candidats | ${alerts} alerte(s), ${criticals} critique(s) | ` +
        `${active} détection(s) active(s) | ${writes} écriture(s) | ${notifications.length} notif.`
    );
    console.log(
      `   Birdeye : ${securityCalls} sécurité, ${overviewCalls} flux, ~${birdeye.estimatedCuToday} CU aujourd'hui | Telegram total : ${alertsSent}`
    );
  } catch (error) {
    console.error('❌ Erreur pendant le scan :', error);
  } finally {
    scanRunning = false;
  }
}

// ------------------------------------------------------------
// Démarrage
// ------------------------------------------------------------
console.log('🚀 Détecteur d’opportunités Solana');
console.log(
  `   Market cap $${config.minMarketCap.toLocaleString('fr-FR')} → $${config.maxMarketCap.toLocaleString('fr-FR')} | ` +
    `liquidité ≥ $${config.minLiquidity.toLocaleString('fr-FR')} et ≥ ${config.minLiquidityToMcap * 100} % du market cap | âge ≥ ${config.minAgeHours} h`
);
console.log(
  `   Seuils : alerte ${config.alertScore}, critique ${config.criticalScore}, sortie < ${config.exitScore} pendant ${config.exitScans} scans`
);
if (config.dryRun) {
  console.log('🧪 Mode test (DRY_RUN) : aucune écriture Supabase, aucun message Telegram');
} else if (!secrets.usingServiceKey) {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY absente : utilisation temporaire de la clé anon. Ajoute la clé service_role dans Render.');
}

const schedule = `*/${config.scanIntervalMinutes} * * * *`;
const task = cron.schedule(schedule, () => {
  void runScan();
});
void runScan();
console.log(`⏱️ Scan toutes les ${config.scanIntervalMinutes} minutes`);

function shutdown(signal: string): void {
  console.log(`👋 Arrêt demandé (${signal})`);
  task.stop();
  const waitForScan = setInterval(() => {
    if (!scanRunning) {
      clearInterval(waitForScan);
      process.exit(0);
    }
  }, 500);
  setTimeout(() => process.exit(0), 20_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
