export type Level = 'watch' | 'alert' | 'critical';
export type AlertLevel = 'alert' | 'critical';

/** Une ligne de la liste Birdeye (état actuel d'un token). */
export interface MarketSnapshot {
  address: string;
  name: string;
  symbol: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume5m: number;
  volume1h: number;
  volume24h: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  trades5m: number;
  trades1h: number;
  holders: number | null;
  listingTimeMs: number | null;
  uniqueWallets24h: number | null;
  timestamp: number;
}

/** Point d'historique gardé en mémoire (un par scan). */
export interface HistoryPoint {
  t: number;
  price: number;
  volume5m: number;
  volume1h: number;
  trades5m: number;
  priceChange5m: number;
  priceChange1h: number;
  liquidity: number;
  holders: number | null;
}

/** Résultat du contrôle de sécurité Birdeye (mis en cache). */
export interface SecurityInfo {
  checkedAt: number;
  ok: boolean;
  hardFlags: string[];
  softFlags: string[];
  top10Share: number | null;
  creationTimeMs: number | null;
}

/** Flux d'achats/ventes et wallets sur 5 min et 1 h (token_overview). */
export interface FlowInfo {
  fetchedAt: number;
  buyVolume5m: number;
  sellVolume5m: number;
  buyVolume1h: number;
  sellVolume1h: number;
  trades5m: number;
  uniqueWallets5m: number;
  uniqueWalletsPrev5m: number;
  uniqueWallets1h: number;
  uniqueWalletsPrev1h: number;
}

/** Métadonnées d'un token conservées en base (table tokens). */
export interface TokenMeta {
  createdAtMs: number | null;
  listingTimeMs: number | null;
  security: SecurityInfo | null;
}

/** Mesures calculées uniquement à partir de l'historique. */
export interface BaseFeatures {
  historyLength: number;
  ready: boolean;
  zVolume5m: number;
  zTrades5m: number;
  zVolume1h: number;
  zPrice5m: number;
  zPrice1h: number;
  volumeRatio5m: number | null;
  tradesRatio5m: number | null;
  acceleration: number | null;
  greenCandles: number;
  candlesChecked: number;
  priceAbove30mAgo: boolean;
  holderGrowth1hPercent: number | null;
  liquidityChange1hPercent: number | null;
  avgTradeSizeRatio: number | null;
  maxPrice24h: number | null;
}

export type FamilyKey = 'flux' | 'participation' | 'activite' | 'momentum' | 'relatif';
export type Families = Record<FamilyKey, number | null>;

export interface MarketContext {
  medianPriceChange1h: number;
  activityScores: number[];
}

export interface Evaluation {
  snapshot: MarketSnapshot;
  features: BaseFeatures;
  families: Families;
  score: number;
  litFamilies: number;
  requiredLit: number;
  blockers: string[];
  reasons: string[];
  warnings: string[];
  level: Level;
  ageHours: number | null;
  security: SecurityInfo | null;
  flow: FlowInfo | null;
  buyRatio5m: number | null;
}

export type DetectionStatus = 'active' | 'ended';
export type Outcome = 'pending' | 'win' | 'loss' | 'flat';

export interface DetectionState {
  id: number | null;
  address: string;
  symbol: string;
  name: string;
  status: DetectionStatus;
  level: AlertLevel;
  peakLevel: AlertLevel;
  score: number;
  peakScore: number;
  detectedAt: number;
  lastActiveAt: number;
  endedAt: number | null;
  belowCount: number;
  reentries: number;
  priceAtDetection: number;
  lastPrice: number;
  maxPrice: number;
  minPrice: number;
  price15m: number | null;
  price1h: number | null;
  price4h: number | null;
  price24h: number | null;
  hitUpAt: number | null;
  hitDownAt: number | null;
  outcome: Outcome;
  marketCap: number;
  liquidity: number;
  ageHours: number | null;
  securityOk: boolean | null;
  securityFlags: string[];
  families: Families;
  reasons: string[];
  warnings: string[];
  // Interne : faut-il écrire en base ?
  dirty: boolean;
  lastPersistAt: number;
}

export interface Notification {
  kind: 'new' | 'upgrade' | 'reopen';
  detection: DetectionState;
}
