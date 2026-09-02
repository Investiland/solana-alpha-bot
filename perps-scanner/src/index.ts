import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

// ============================================================
// ENVIRONMENT
// ============================================================

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
} = process.env;

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY
) {
  throw new Error(
    'Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY'
  );
}

// ============================================================
// CLIENTS
// ============================================================

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const HYPERLIQUID_API =
  'https://api.hyperliquid.xyz/info';

// ============================================================
// CONFIG
// ============================================================

const config = {
  snapshotIntervalMinutes: 5,

  maxHistorySnapshots: 288,

  minimumHistoryForZScore: 10,

  watchZ: 2.0,
  alertZ: 2.5,
  criticalZ: 3.0,

  requestTimeoutMs: 15_000,

  // Crypto asset types to include
  allowedAssetTypes: [
    'Spot',
    'Perpetual',
  ],
};

// ============================================================
// TYPES
// ============================================================

interface PerpSnapshot {
  address: string;
  symbol: string;

  price: number;
  markPrice: number;

  volume24h: number;
  volume5m: number;
  volume1h: number;

  openInterest: number;
  oiChange5m: number;
  oiChange1h: number;
  oiChange24h: number;

  fundingRate: number;

  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;

  timestamp: number;
}

interface ZScores {
  price5m: number;
  price1h: number;
  volume5m: number;
  volume1h: number;
  oi5m: number;
  oi1h: number;
  funding: number;
}

interface AnomalyDetection {
  snapshot: PerpSnapshot;
  zScores: ZScores;
  maxZScore: number;
  opportunityScore: number;
  level: 'watch' | 'alert' | 'critical';
  anomalies: string[];
}

// ============================================================
// STATE
// ============================================================

let scanRunning = false;
let totalScans = 0;
let totalMarketsProcessed = 0;
let totalAnomaliesDetected = 0;

// ============================================================
// HELPERS
// ============================================================

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

// ============================================================
// Z-SCORE
// ============================================================

function calculateZScore(
  current: number,
  historical: number[]
): number {
  if (
    historical.length <
    config.minimumHistoryForZScore
  ) {
    return 0;
  }

  if (!historical.every(Number.isFinite)) {
    return 0;
  }

  const mean =
    historical.reduce(
      (sum, value) => sum + value,
      0
    ) / historical.length;

  const variance =
    historical.reduce(
      (sum, value) =>
        sum + Math.pow(value - mean, 2),
      0
    ) / historical.length;

  const standardDeviation =
    Math.sqrt(variance);

  if (
    !Number.isFinite(standardDeviation) ||
    standardDeviation === 0
  ) {
    return 0;
  }

  return (
    (current - mean) /
    standardDeviation
  );
}

// ============================================================
// HYPERLIQUID API
// ============================================================

async function fetchAllMarkets(): Promise<
  Array<{ name: string; assetType: string }>
> {
  try {
    console.log(
      '🌐 Hyperliquid: fetching all crypto markets...'
    );

    const response = await axios.post(
      HYPERLIQUID_API,
      {
        type: 'metaAndAssetCtxs',
      },
      {
        timeout: config.requestTimeoutMs,
      }
    );

    const metaData = response.data[0];

    if (!metaData || !metaData.universe) {
      console.error(
        '❌ Unexpected Hyperliquid response structure'
      );
      return [];
    }

    // Filter for crypto only
    const cryptoMarkets = metaData.universe
      .filter((market: any) => {
        const assetType = market.name
          ? market.name.split('-')[0]
          : '';

        // Include only crypto (exclude stocks, fx, commodities)
        // Heuristic: crypto symbols are short (SOL, BTC, ETH)
        // Stocks are longer (AAPL, GOOGL, TSLA)
        return (
          market.name &&
          market.name.length <= 10 &&
          !market.name.includes('USD') &&
          assetType.length <= 5
        );
      })
      .map((market: any) => ({
        name: market.name,
        assetType: market.assetType || 'Perpetual',
      }));

    console.log(
      `📦 Hyperliquid returned ${cryptoMarkets.length} crypto markets`
    );

    return cryptoMarkets;
  } catch (error) {
    console.error(
      '❌ Hyperliquid fetch error:',
      error
    );
    return [];
  }
}

async function fetchMarketData(
  symbol: string
): Promise<PerpSnapshot | null> {
  try {
    const response = await axios.post(
      HYPERLIQUID_API,
      {
        type: 'assetCtx',
        asset: symbol,
      },
      {
        timeout: config.requestTimeoutMs,
      }
    );

    const ctx = response.data;

    if (!ctx) {
      console.warn(
        `⚠️ No data for ${symbol}`
      );
      return null;
    }

    return {
      address: symbol,
      symbol: symbol,

      price: num(ctx.spotPx || ctx.markPx),
      markPrice: num(ctx.markPx),

      volume24h: num(ctx.dayNtlVlm),
      volume5m: 0, // Will calculate from trades
      volume1h: 0,

      openInterest: num(ctx.openInterest),
      oiChange5m: 0,
      oiChange1h: 0,
      oiChange24h: 0,

      fundingRate: num(ctx.funding),

      priceChange5m: 0, // Will calculate
      priceChange1h: 0,
      priceChange24h: 0,

      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(
      `❌ Error fetching ${symbol}:`,
      error
    );
    return null;
  }
}

// ============================================================
// HISTORY
// ============================================================

async function getMarketHistory(
  symbol: string
): Promise<PerpSnapshot[]> {
  try {
    const { data, error } =
      await supabase
        .from('perpetual_snapshots')
        .select(
          `
          price,
          mark_price,
          volume_24h,
          volume_5m,
          volume_1h,
          open_interest,
          oi_change_5m,
          oi_change_1h,
          oi_change_24h,
          funding_rate,
          price_change_5m,
          price_change_1h,
          price_change_24h,
          timestamp,
          perpetual_markets(symbol)
        `
        )
        .eq('perpetual_markets.symbol', symbol)
        .order('timestamp', {
          ascending: false,
        })
        .limit(config.maxHistorySnapshots);

    if (error || !data || data.length === 0) {
      return [];
    }

    return data
      .reverse()
      .map((row: any) => ({
        address: symbol,
        symbol: symbol,

        price: num(row.price),
        markPrice: num(row.mark_price),

        volume24h: num(row.volume_24h),
        volume5m: num(row.volume_5m),
        volume1h: num(row.volume_1h),

        openInterest: num(
          row.open_interest
        ),
        oiChange5m: num(row.oi_change_5m),
        oiChange1h: num(row.oi_change_1h),
        oiChange24h: num(row.oi_change_24h),

        fundingRate: num(row.funding_rate),

        priceChange5m: num(
          row.price_change_5m
        ),
        priceChange1h: num(
          row.price_change_1h
        ),
        priceChange24h: num(
          row.price_change_24h
        ),

        timestamp: new Date(
          row.timestamp
        ).getTime(),
      }));
  } catch (error) {
    console.error(
      `❌ History error for ${symbol}:`,
      error
    );
    return [];
  }
}

// ============================================================
// ANOMALY DETECTION
// ============================================================

function detectAnomalies(
  snapshot: PerpSnapshot,
  history: PerpSnapshot[]
): AnomalyDetection {
  const anomalies: string[] = [];

  // Need minimum history for Z-scores
  if (
    history.length <
    config.minimumHistoryForZScore
  ) {
    return {
      snapshot,
      zScores: {
        price5m: 0,
        price1h: 0,
        volume5m: 0,
        volume1h: 0,
        oi5m: 0,
        oi1h: 0,
        funding: 0,
      },
      maxZScore: 0,
      opportunityScore: 0,
      level: 'watch',
      anomalies: [
        `Building baseline (${history.length}/${config.minimumHistoryForZScore})`,
      ],
    };
  }

  // Calculate Z-scores
  const price5mHistory = history.map(
    t => Math.abs(t.priceChange5m || 0)
  );
  const price1hHistory = history.map(
    t => Math.abs(t.priceChange1h || 0)
  );
  const volume5mHistory = history.map(
    t => t.volume5m || 0
  );
  const volume1hHistory = history.map(
    t => t.volume1h || 0
  );
  const oi5mHistory = history.map(
    t => Math.abs(t.oiChange5m || 0)
  );
  const oi1hHistory = history.map(
    t => Math.abs(t.oiChange1h || 0)
  );
  const fundingHistory = history.map(
    t => Math.abs(t.fundingRate || 0)
  );

  const price5mZ = calculateZScore(
    Math.abs(snapshot.priceChange5m),
    price5mHistory
  );
  const price1hZ = calculateZScore(
    Math.abs(snapshot.priceChange1h),
    price1hHistory
  );
  const volume5mZ = calculateZScore(
    snapshot.volume5m,
    volume5mHistory
  );
  const volume1hZ = calculateZScore(
    snapshot.volume1h,
    volume1hHistory
  );
  const oi5mZ = calculateZScore(
    Math.abs(snapshot.oiChange5m),
    oi5mHistory
  );
  const oi1hZ = calculateZScore(
    Math.abs(snapshot.oiChange1h),
    oi1hHistory
  );
  const fundingZ = calculateZScore(
    Math.abs(snapshot.fundingRate),
    fundingHistory
  );

  // Detect anomalies
  if (price5mZ >= config.watchZ) {
    anomalies.push(
      `5m price Z=${price5mZ.toFixed(2)} (${snapshot.priceChange5m.toFixed(2)}%)`
    );
  }
  if (price1hZ >= config.watchZ) {
    anomalies.push(
      `1h price Z=${price1hZ.toFixed(2)} (${snapshot.priceChange1h.toFixed(2)}%)`
    );
  }
  if (volume5mZ >= config.watchZ) {
    anomalies.push(
      `5m volume Z=${volume5mZ.toFixed(2)}`
    );
  }
  if (volume1hZ >= config.watchZ) {
    anomalies.push(
      `1h volume Z=${volume1hZ.toFixed(2)}`
    );
  }
  if (oi5mZ >= config.watchZ) {
    anomalies.push(
      `5m OI Z=${oi5mZ.toFixed(2)} (${snapshot.oiChange5m.toFixed(1)}%)`
    );
  }
  if (oi1hZ >= config.watchZ) {
    anomalies.push(
      `1h OI Z=${oi1hZ.toFixed(2)} (${snapshot.oiChange1h.toFixed(1)}%)`
    );
  }
  if (fundingZ >= config.watchZ) {
    anomalies.push(
      `Funding Z=${fundingZ.toFixed(2)} (${(snapshot.fundingRate * 100).toFixed(3)}%)`
    );
  }

  const maxZScore = Math.max(
    price5mZ,
    price1hZ,
    volume5mZ,
    volume1hZ,
    oi5mZ,
    oi1hZ,
    fundingZ
  );

  // Calculate Opportunity Score
  let score = 0;

  score += Math.min(
    30,
    Math.max(0, Math.abs(price5mZ) * 10)
  );
  score += Math.min(
    20,
    Math.max(0, volume5mZ * 7)
  );
  score += Math.min(
    25,
    Math.max(0, Math.abs(oi1hZ) * 8)
  );

  if (
    snapshot.fundingRate > 0.001
  ) {
    score += 15;
  } else if (
    snapshot.fundingRate < -0.001
  ) {
    score += 10;
  }

  score = Math.min(100, Math.round(score));

  // Determine level
  let level: 'watch' | 'alert' | 'critical' =
    'watch';

  if (
    maxZScore >= config.criticalZ &&
    score >= 65
  ) {
    level = 'critical';
  } else if (
    maxZScore >= config.alertZ &&
    score >= 50
  ) {
    level = 'alert';
  }

  return {
    snapshot,
    zScores: {
      price5m: price5mZ,
      price1h: price1hZ,
      volume5m: volume5mZ,
      volume1h: volume1hZ,
      oi5m: oi5mZ,
      oi1h: oi1hZ,
      funding: fundingZ,
    },
    maxZScore,
    opportunityScore: score,
    level,
    anomalies,
  };
}

// ============================================================
// SAVE SNAPSHOT
// ============================================================

async function saveSnapshot(
  detection: AnomalyDetection
): Promise<void> {
  try {
    // Get or create market
    let { data: market } = await supabase
      .from('perpetual_markets')
      .select('id')
      .eq('symbol', detection.snapshot.symbol)
      .single();

    if (!market) {
      const { data: newMarket } =
        await supabase
          .from('perpetual_markets')
          .insert({
            symbol:
              detection.snapshot.symbol,
            hyperliquid_id:
              detection.snapshot.symbol,
            asset_type: 'Perpetual',
          })
          .select('id')
          .single();

      market = newMarket;
    }

    if (!market) {
      console.error(
        `❌ Failed to create market for ${detection.snapshot.symbol}`
      );
      return;
    }

    // Save snapshot
    const { error } = await supabase
      .from('perpetual_snapshots')
      .insert({
        market_id: market.id,
        price: detection.snapshot.price,
        mark_price:
          detection.snapshot.markPrice,
        volume_24h:
          detection.snapshot.volume24h,
        volume_5m:
          detection.snapshot.volume5m,
        volume_1h:
          detection.snapshot.volume1h,
        open_interest:
          detection.snapshot.openInterest,
        oi_change_5m:
          detection.snapshot.oiChange5m,
        oi_change_1h:
          detection.snapshot.oiChange1h,
        oi_change_24h:
          detection.snapshot.oiChange24h,
        funding_rate:
          detection.snapshot.fundingRate,
        price_change_5m:
          detection.snapshot.priceChange5m,
        price_change_1h:
          detection.snapshot.priceChange1h,
        price_change_24h:
          detection.snapshot.priceChange24h,
        z_score_price_5m:
          detection.zScores.price5m,
        z_score_price_1h:
          detection.zScores.price1h,
        z_score_volume_5m:
          detection.zScores.volume5m,
        z_score_volume_1h:
          detection.zScores.volume1h,
        z_score_oi_5m:
          detection.zScores.oi5m,
        z_score_oi_1h:
          detection.zScores.oi1h,
        z_score_funding:
          detection.zScores.funding,
        max_z_score: detection.maxZScore,
        opportunity_score:
          detection.opportunityScore,
        anomaly_level: detection.level,
        anomalies:
          detection.anomalies.join(' | '),
        timestamp: new Date(
          detection.snapshot.timestamp
        ).toISOString(),
      });

    if (error) {
      console.error(
        `❌ Supabase error for ${detection.snapshot.symbol}:`,
        error
      );
    }
  } catch (error) {
    console.error(
      `❌ Save snapshot error:`,
      error
    );
  }
}

// ============================================================
// MAIN SCAN
// ============================================================

async function runPerpsListener(): Promise<void> {
  if (scanRunning) {
    console.log(
      '⚠️ Previous scan still running. Skipping.'
    );
    return;
  }

  scanRunning = true;

  const startedAt = Date.now();
  totalScans++;

  try {
    console.log(
      `\n⏰ [${new Date().toISOString()}] Starting perps scan #${totalScans}...`
    );

    // Fetch all markets
    const markets = await fetchAllMarkets();

    if (markets.length === 0) {
      console.log('⚠️ No markets found.');
      return;
    }

    let anomalyCount = 0;

    // Process each market
    for (const market of markets) {
      try {
        const snapshot = await fetchMarketData(
          market.name
        );

        if (!snapshot) continue;

        const history = await getMarketHistory(
          market.name
        );

        const detection = detectAnomalies(
          snapshot,
          history
        );

        await saveSnapshot(detection);

        totalMarketsProcessed++;

        if (
          detection.maxZScore >=
          config.watchZ
        ) {
          anomalyCount++;

          console.log(
            `📊 ${detection.snapshot.symbol} | Z=${detection.maxZScore.toFixed(2)} | Score=${detection.opportunityScore} | ${detection.level} | history=${history.length}`
          );
        }
      } catch (error) {
        console.error(
          `❌ Error processing ${market.name}:`,
          error
        );
      }

      // Small delay between requests
      await sleep(50);
    }

    totalAnomaliesDetected += anomalyCount;

    const duration = (
      (Date.now() - startedAt) /
      1000
    ).toFixed(1);

    console.log(
      `✅ Scan complete | ${markets.length} markets | ${anomalyCount} anomalies | ${duration}s`
    );

    console.log(
      `📈 Total stats | scans=${totalScans} | processed=${totalMarketsProcessed} | anomalies=${totalAnomaliesDetected}`
    );
  } catch (error) {
    console.error(
      '❌ Listener error:',
      error
    );
  } finally {
    scanRunning = false;
  }
}

// ============================================================
// START
// ============================================================

console.log('🚀 Hyperliquid Perpetuals Scanner');
console.log(
  `⏱️ Snapshot: every ${config.snapshotIntervalMinutes} minutes`
);
console.log(
  `🎯 Z-score: ${config.watchZ}/${config.alertZ}/${config.criticalZ}`
);
console.log('');

runPerpsListener().catch(error => {
  console.error(
    '❌ Startup scan error:',
    error
  );
});

cron.schedule(
  `*/${config.snapshotIntervalMinutes} * * * *`,
  () => {
    runPerpsListener().catch(error => {
      console.error(
        '❌ Scheduled scan error:',
        error
      );
    });
  }
);

console.log(
  `✅ Scheduled every ${config.snapshotIntervalMinutes} minutes`
);
