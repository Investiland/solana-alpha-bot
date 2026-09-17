import { config } from './config.js';
import {
  clamp01,
  logValue,
  median,
  percentChange,
  percentileRank,
  ratio,
  robustZ,
} from './stats.js';
import type {
  BaseFeatures,
  Evaluation,
  Families,
  FamilyKey,
  FlowInfo,
  HistoryPoint,
  Level,
  MarketContext,
  MarketSnapshot,
  SecurityInfo,
} from './types.js';

const POINTS_PER_HOUR = 12;

// Poids des familles dans le score final (total = 1)
const FAMILY_WEIGHTS: Record<FamilyKey, number> = {
  flux: 0.25,
  participation: 0.2,
  activite: 0.2,
  momentum: 0.2,
  relatif: 0.15,
};

const FAMILY_LABELS: Record<FamilyKey, string> = {
  flux: 'pression acheteuse',
  participation: 'nouveaux participants',
  activite: 'activité',
  momentum: 'hausse soutenue',
  relatif: 'surperformance',
};

function fmt(value: number, digits = 1): string {
  return value.toLocaleString('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${fmt(value, digits)}`;
}

/** Un point sur 12 en partant du plus récent : évite les fenêtres 1 h qui se chevauchent. */
function hourlySample<T>(points: T[]): T[] {
  const sampled: T[] = [];
  for (let i = points.length - 1; i >= 0; i -= POINTS_PER_HOUR) {
    sampled.push(points[i]);
  }
  return sampled.reverse();
}

// ============================================================
// 1. Mesures calculées à partir de l'historique
// ============================================================

export function computeBaseFeatures(
  snap: MarketSnapshot,
  history: HistoryPoint[]
): BaseFeatures {
  const n = history.length;
  const empty: BaseFeatures = {
    historyLength: n,
    ready: false,
    zVolume5m: 0,
    zTrades5m: 0,
    zVolume1h: 0,
    zPrice5m: 0,
    zPrice1h: 0,
    volumeRatio5m: null,
    tradesRatio5m: null,
    acceleration: null,
    greenCandles: 0,
    candlesChecked: 0,
    priceAbove30mAgo: false,
    holderGrowth1hPercent: null,
    liquidityChange1hPercent: null,
    avgTradeSizeRatio: null,
    maxPrice24h: null,
  };

  if (n < config.minHistoryPoints) return empty;

  // Référence = historique SANS les 30 dernières minutes,
  // pour qu'un mouvement en cours ne gonfle pas sa propre référence.
  const baseline = history.slice(0, n - config.baselineExcludeRecent);
  const recent = history.slice(n - config.baselineExcludeRecent);

  const baseVolumes = baseline.map(p => p.volume5m);
  const baseTrades = baseline.map(p => p.trades5m);

  const zVolume5m = robustZ(logValue(snap.volume5m), baseVolumes.map(logValue));
  const zTrades5m = robustZ(logValue(snap.trades5m), baseTrades.map(logValue));

  // Mouvement de prix : valeurs signées (une chute ne compte pas comme une hausse)
  const zPrice5m = robustZ(snap.priceChange5m, baseline.map(p => p.priceChange5m));

  const hourly = hourlySample(baseline);
  const zVolume1h = robustZ(logValue(snap.volume1h), hourly.map(p => logValue(p.volume1h)), 6);
  const zPrice1h = robustZ(snap.priceChange1h, hourly.map(p => p.priceChange1h), 6);

  const medianVolume = median(baseVolumes);
  const medianTrades = median(baseTrades);

  // Accélération : volume actuel comparé à la moyenne des 30 dernières minutes
  const recentVolumeAvg =
    recent.reduce((sum, p) => sum + p.volume5m, 0) / Math.max(1, recent.length);

  // Bougies vertes sur les 30 dernières minutes + maintenant
  const window = [...recent.map(p => p.priceChange5m), snap.priceChange5m];
  const greenCandles = window.filter(change => change > 0).length;
  const price30mAgo = recent[0]?.price ?? 0;

  // Croissance des holders sur 1 h
  const hourAgo = history[n - POINTS_PER_HOUR];
  const holderGrowth1hPercent =
    snap.holders !== null && hourAgo?.holders != null
      ? percentChange(snap.holders, hourAgo.holders)
      : null;

  const liquidityChange1hPercent = hourAgo
    ? percentChange(snap.liquidity, hourAgo.liquidity)
    : null;

  // Taille moyenne d'une transaction vs habituel (effondrement = souvent des bots)
  const avgTradeNow = ratio(snap.volume5m, snap.trades5m);
  const avgTradeBase = median(
    baseline
      .filter(p => p.trades5m > 0)
      .map(p => p.volume5m / p.trades5m)
  );
  const avgTradeSizeRatio =
    avgTradeNow !== null && avgTradeBase > 0 ? avgTradeNow / avgTradeBase : null;

  const last24h = history.slice(-config.maxHistoryPoints);
  const maxPrice24h = last24h.length > 0 ? Math.max(...last24h.map(p => p.price)) : null;

  return {
    historyLength: n,
    ready: true,
    zVolume5m,
    zTrades5m,
    zVolume1h,
    zPrice5m,
    zPrice1h,
    volumeRatio5m: ratio(snap.volume5m, medianVolume),
    tradesRatio5m: ratio(snap.trades5m, medianTrades),
    acceleration: ratio(snap.volume5m, recentVolumeAvg),
    greenCandles,
    candlesChecked: window.length,
    priceAbove30mAgo: price30mAgo > 0 && snap.price > price30mAgo,
    holderGrowth1hPercent,
    liquidityChange1hPercent,
    avgTradeSizeRatio,
    maxPrice24h,
  };
}

/** Indice d'activité utilisé pour comparer les tokens entre eux. */
export function activityIndex(f: BaseFeatures): number {
  return f.ready ? Math.max(0, f.zVolume5m) + Math.max(0, f.zPrice5m) : 0;
}

export function buildMarketContext(
  snapshots: MarketSnapshot[],
  features: Map<string, BaseFeatures>
): MarketContext {
  return {
    medianPriceChange1h: median(snapshots.map(s => s.priceChange1h)),
    activityScores: [...features.values()]
      .filter(f => f.ready)
      .map(activityIndex)
      .sort((a, b) => a - b),
  };
}

// ============================================================
// 2. Pré-sélection (sans appel API) : ce token mérite-t-il
//    qu'on dépense des crédits Birdeye pour l'analyser ?
// ============================================================

export interface PreScreen {
  candidate: boolean;
  priority: number;
}

export function preScreen(snap: MarketSnapshot, f: BaseFeatures): PreScreen {
  if (!f.ready) return { candidate: false, priority: 0 };

  const movingUp =
    snap.priceChange1h > 0 &&
    snap.priceChange5m > -1 &&
    (snap.priceChange5m >= config.minMove5mPercent ||
      snap.priceChange1h >= config.minMove1hPercent);

  const activityUp =
    f.zVolume5m >= config.minActivityZ ||
    (f.acceleration ?? 0) >= config.minAcceleration;

  const notOverextended = snap.priceChange1h <= config.maxPump1hPercent;
  const liquidityOk =
    snap.liquidity / Math.max(1, snap.marketCap) >= config.minLiquidityToMcap;

  const candidate = movingUp && activityUp && notOverextended && liquidityOk;
  return { candidate, priority: activityIndex(f) };
}

// ============================================================
// 3. Évaluation complète
// ============================================================

export interface EvaluationInput {
  snap: MarketSnapshot;
  features: BaseFeatures;
  context: MarketContext;
  security: SecurityInfo | null;
  flow: FlowInfo | null;
  createdAtMs: number | null;
}

function computeFamilies(
  input: EvaluationInput,
  reasons: string[]
): { families: Families; buyRatio5m: number | null } {
  const { snap, features: f, context, flow } = input;
  const families: Families = {
    flux: null,
    participation: null,
    activite: null,
    momentum: null,
    relatif: null,
  };

  // --- Activité : volume, transactions, accélération
  families.activite =
    0.45 * clamp01(f.zVolume5m / 4) +
    0.2 * clamp01(f.zTrades5m / 4) +
    0.15 * clamp01(f.zVolume1h / 3) +
    0.2 * clamp01(((f.acceleration ?? 1) - 1) / 3);

  if (f.volumeRatio5m !== null && f.zVolume5m >= 2) {
    reasons.push(`Volume sur 5 min ×${fmt(f.volumeRatio5m)} par rapport à d'habitude`);
  }
  if (f.acceleration !== null && f.acceleration >= 2) {
    reasons.push(`Le volume accélère : ×${fmt(f.acceleration)} vs les 30 dernières minutes`);
  }

  // --- Momentum : hausse de prix inhabituelle ET soutenue
  const persistence =
    f.candlesChecked > 0
      ? 0.75 * (f.greenCandles / f.candlesChecked) + 0.25 * (f.priceAbove30mAgo ? 1 : 0)
      : 0;
  families.momentum =
    0.35 * clamp01(f.zPrice5m / 3.5) +
    0.25 * clamp01(snap.priceChange1h / 20) +
    0.4 * persistence;

  if (f.zPrice5m >= 2) {
    reasons.push(`Prix ${signed(snap.priceChange5m)} % en 5 min (inhabituel pour ce token)`);
  }
  if (f.greenCandles >= 5) {
    reasons.push(`Hausse régulière : ${f.greenCandles} bougies 5 min vertes sur ${f.candlesChecked}`);
  }

  // --- Relatif : se distingue-t-il des autres tokens en ce moment ?
  const rank = percentileRank(context.activityScores, activityIndex(f));
  const excess1h = snap.priceChange1h - context.medianPriceChange1h;
  families.relatif = 0.5 * rank + 0.5 * clamp01(excess1h / 15);
  if (excess1h >= 8) {
    reasons.push(`Fait ${signed(excess1h, 0)} points de mieux que le marché sur 1 h`);
  }

  // --- Flux et participation (nécessitent token_overview)
  let buyRatio5m: number | null = null;
  if (flow) {
    const total5m = flow.buyVolume5m + flow.sellVolume5m;
    const total1h = flow.buyVolume1h + flow.sellVolume1h;
    buyRatio5m = total5m > 0 ? flow.buyVolume5m / total5m : null;
    const buyRatio1h = total1h > 0 ? flow.buyVolume1h / total1h : null;

    if (buyRatio5m !== null) {
      // Si le volume 5 min est minuscule, le ratio est peu fiable
      const reliability = clamp01(total5m / 5_000);
      families.flux =
        reliability *
        (0.6 * clamp01((buyRatio5m - 0.5) / 0.2) +
          0.4 * clamp01(((buyRatio1h ?? 0.5) - 0.5) / 0.15));
      if (buyRatio5m >= 0.6) {
        reasons.push(`Les achats font ${Math.round(buyRatio5m * 100)} % du volume sur 5 min`);
      }
    }

    const walletGrowth = percentChange(flow.uniqueWallets5m, flow.uniqueWalletsPrev5m);
    const walletPart = walletGrowth === null ? 0 : clamp01(walletGrowth / 150);
    const holderPart =
      f.holderGrowth1hPercent === null ? walletPart : clamp01(f.holderGrowth1hPercent / 3);
    families.participation = 0.6 * walletPart + 0.4 * holderPart;

    if (walletGrowth !== null && walletGrowth >= 50) {
      reasons.push(
        `${flow.uniqueWallets5m} wallets actifs sur 5 min (${signed(walletGrowth, 0)} % vs les 5 min d'avant)`
      );
    }
  } else if (f.holderGrowth1hPercent !== null) {
    families.participation = clamp01(f.holderGrowth1hPercent / 3);
  }

  if (f.holderGrowth1hPercent !== null && f.holderGrowth1hPercent >= 1) {
    reasons.push(`Holders ${signed(f.holderGrowth1hPercent)} % en 1 h`);
  }

  return { families, buyRatio5m };
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { snap, features: f, security, flow, createdAtMs } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // ---------- Âge ----------
  const ageSource = createdAtMs ?? security?.creationTimeMs ?? snap.listingTimeMs;
  const ageHours = ageSource ? (snap.timestamp - ageSource) / 3_600_000 : null;
  if (ageHours === null) {
    blockers.push('Âge inconnu');
  } else if (ageHours < config.minAgeHours) {
    blockers.push(`Trop récent (${fmt(ageHours, 0)} h, minimum ${config.minAgeHours} h)`);
  }

  // ---------- Sécurité ----------
  if (!security) {
    blockers.push('Sécurité non vérifiée');
  } else if (!security.ok) {
    blockers.push(`Sécurité : ${security.hardFlags.join(', ').replace(/_/g, ' ')}`);
  } else if (security.softFlags.length > 0) {
    warnings.push(`À surveiller : ${security.softFlags.join(', ').replace(/_/g, ' ')}`);
  }

  // ---------- Liquidité ----------
  const liqShare = snap.liquidity / Math.max(1, snap.marketCap);
  if (liqShare < config.minLiquidityToMcap) {
    blockers.push(
      `Liquidité faible : ${fmt(liqShare * 100)} % du market cap (minimum ${fmt(config.minLiquidityToMcap * 100)} %)`
    );
  }
  if (
    f.liquidityChange1hPercent !== null &&
    f.liquidityChange1hPercent <= -config.maxLiquidityDrop1hPercent
  ) {
    blockers.push(`Liquidité retirée : ${fmt(f.liquidityChange1hPercent)} % en 1 h`);
  }

  // ---------- Prix ----------
  if (snap.priceChange1h > config.maxPump1hPercent) {
    blockers.push(`Déjà ${signed(snap.priceChange1h, 0)} % en 1 h (risque de manipulation)`);
  }
  if (snap.priceChange1h <= 0 || snap.priceChange5m <= -1) {
    blockers.push('Le prix ne monte pas en ce moment');
  }

  if (!f.ready) {
    blockers.push(`Historique insuffisant (${f.historyLength}/${config.minHistoryPoints} points)`);
  }

  // ---------- Familles de signaux ----------
  const { families, buyRatio5m } = f.ready
    ? computeFamilies(input, reasons)
    : {
        families: {
          flux: null,
          participation: null,
          activite: null,
          momentum: null,
          relatif: null,
        } as Families,
        buyRatio5m: null,
      };

  let weightSum = 0;
  let weighted = 0;
  let available = 0;
  let lit = 0;
  for (const key of Object.keys(FAMILY_WEIGHTS) as FamilyKey[]) {
    const value = families[key];
    if (value === null) continue;
    available++;
    weightSum += FAMILY_WEIGHTS[key];
    weighted += FAMILY_WEIGHTS[key] * value;
    if (value >= 0.5) lit++;
  }
  let score = weightSum > 0 ? (100 * weighted) / weightSum : 0;
  const requiredLit = Math.min(3, Math.max(2, Math.ceil(available * 0.6)));

  // ---------- Pénalités ----------
  if (flow && flow.uniqueWallets5m > 0) {
    const tradesPerWallet = flow.trades5m / flow.uniqueWallets5m;
    if (tradesPerWallet > config.maxTradesPerWallet) {
      score *= 0.6;
      warnings.push(`Suspicion de bots : ${fmt(tradesPerWallet)} transactions par wallet sur 5 min`);
    }
  }
  if (f.avgTradeSizeRatio !== null && f.avgTradeSizeRatio < 0.35 && f.zTrades5m >= 3) {
    score *= 0.7;
    warnings.push('Beaucoup de petites transactions : possible activité de bots');
  }
  if (snap.priceChange24h > config.latePump24hPercent) {
    score *= 0.7;
    warnings.push(`Entrée tardive : déjà ${signed(snap.priceChange24h, 0)} % sur 24 h`);
  } else if (
    snap.priceChange24h > 150 &&
    f.maxPrice24h !== null &&
    snap.price >= f.maxPrice24h * 0.97
  ) {
    score *= 0.85;
    warnings.push(`Proche du plus haut après ${signed(snap.priceChange24h, 0)} % sur 24 h`);
  }
  if (families.flux === null && f.ready) {
    warnings.push("Flux d'achats non mesuré ce scan");
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  // ---------- Niveau ----------
  let level: Level = 'watch';
  if (blockers.length === 0 && lit >= requiredLit) {
    if (score >= config.criticalScore) level = 'critical';
    else if (score >= config.alertScore) level = 'alert';
  }

  if (level !== 'watch' && lit > 0) {
    const litNames = (Object.keys(families) as FamilyKey[])
      .filter(k => (families[k] ?? 0) >= 0.5)
      .map(k => FAMILY_LABELS[k]);
    reasons.unshift(`Signaux concordants : ${litNames.join(', ')}`);
  }

  return {
    snapshot: snap,
    features: f,
    families,
    score,
    litFamilies: lit,
    requiredLit,
    blockers,
    reasons: reasons.slice(0, 7),
    warnings,
    level,
    ageHours,
    security,
    flow,
    buyRatio5m,
  };
}

/** Des blocages qui imposent d'arrêter une détection en cours. */
export function hasHardBlocker(evaluation: Evaluation): boolean {
  return evaluation.blockers.some(
    b => b.startsWith('Sécurité :') || b.startsWith('Liquidité retirée')
  );
}
