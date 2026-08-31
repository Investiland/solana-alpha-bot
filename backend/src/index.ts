import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

// ============================================================
// CLIENTS
// ============================================================

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const bot = new TelegramBot(
  process.env.TELEGRAM_BOT_TOKEN!,
  { polling: false }
);

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY!;

const BIRDEYE_TOKEN_LIST =
  'https://public-api.birdeye.so/defi/v3/token/list';

// ============================================================
// CONFIG
// ============================================================

const config = {
  minMarketCap: 1_000_000,
  maxMarketCap: 10_000_000,

  minLiquidity: 100_000,
  minVolume24h: 50_000,

  // On commence avec 100.
  // On augmentera uniquement si nécessaire.
  maxTokensPerScan: 100,

  snapshotIntervalMinutes: 5,

  // 24h d'historique à raison d'un snapshot / 5 min
  maxHistorySnapshots: 288,

  // Z-score
  watchZ: 2.0,
  alertZ: 2.5,
  criticalZ: 3.0,

  // Anti-spam Telegram
  minAlertRepeatMinutes: 30,
};

// ============================================================
// TYPES
// ============================================================

interface TokenSnapshot {
  address: string;
  name: string;
  symbol: string;

  price: number;
  marketCap: number;
  liquidity: number;

  volume24h: number;
  volume5m: number;
  volume1h: number;

  priceChange24h: number;
  priceChange5m: number;
  priceChange1h: number;

  trades5m: number;
  trades1h: number;

  timestamp: number;
}

interface AnomalyDetection {
  token: TokenSnapshot;

  zScores: {
    volume5m: number;
    volume1h: number;
    price5m: number;
    price1h: number;
    trades5m: number;
  };

  maxZScore: number;

  // Score global 0-100
  opportunityScore: number;

  level: 'watch' | 'alert' | 'critical';

  anomalies: string[];

  health: {
    liquidityOk: boolean;
    volumeOk: boolean;
    marketCapOk: boolean;
  };
}

// ============================================================
// STATE
// ============================================================

// Evite de renvoyer 15 fois la même alerte
const lastAlertAt = new Map<string, number>();

let processingCount = 0;
let alertCount = 0;

// ============================================================
// HELPERS
// ============================================================

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function getNested(obj: any, paths: string[]): number {
  for (const path of paths) {
    const parts = path.split('.');
    let value = obj;

    for (const part of parts) {
      value = value?.[part];
    }

    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return 0;
}

// ============================================================
// BIRDEYE DISCOVERY
// ============================================================

async function fetchSolanaTokens(): Promise<TokenSnapshot[]> {
  try {
    console.log('🔍 Birdeye: scanning Solana token universe...');

    const response = await axios.get(BIRDEYE_TOKEN_LIST, {
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'x-chain': 'solana',
      },

      params: {
        sort_by: 'market_cap',
        sort_type: 'desc',

        min_market_cap: config.minMarketCap,
        max_market_cap: config.maxMarketCap,

        min_liquidity: config.minLiquidity,

        min_volume_24h_usd: config.minVolume24h,

        limit: config.maxTokensPerScan,
        offset: 0,

        ui_amount_mode: 'scaled',
      },

      timeout: 15_000,
    });

    const rawTokens =
      response.data?.data?.tokens ??
      response.data?.data?.items ??
      response.data?.data ??
      [];

    if (!Array.isArray(rawTokens)) {
      console.error('❌ Unexpected Birdeye response structure');
      console.error(
        JSON.stringify(response.data, null, 2).slice(0, 5000)
      );
      return [];
    }

    console.log(
      `📦 Birdeye returned ${rawTokens.length} candidates`
    );

    // Affiche UNE fois le JSON réel.
    // Très important pour vérifier les champs retournés
    // par ton abonnement Birdeye.
    if (rawTokens.length > 0) {
      console.log('📋 SAMPLE BIRDEYE TOKEN:');
      console.log(
        JSON.stringify(rawTokens[0], null, 2)
      );
    }

    const tokens: TokenSnapshot[] = rawTokens
      .map((token: any) => {
        /*
         * Birdeye peut faire évoluer certains noms de champs.
         * On accepte plusieurs variantes sans inventer de données.
         */

        const volume24h = getNested(token, [
          'volume24hUsd',
          'volume_24h_usd',
          'v24hUSD',
        ]);

        const volume5m = getNested(token, [
          'volume5mUsd',
          'volume_5m_usd',
          'v5mUSD',
        ]);

        const volume1h = getNested(token, [
          'volume1hUsd',
          'volume_1h_usd',
          'v1hUSD',
        ]);

        const priceChange24h = getNested(token, [
          'priceChange24hPercent',
          'price_change_24h_percent',
          'priceChange24h',
        ]);

        const priceChange5m = getNested(token, [
          'priceChange5mPercent',
          'price_change_5m_percent',
          'priceChange5m',
        ]);

        const priceChange1h = getNested(token, [
          'priceChange1hPercent',
          'price_change_1h_percent',
          'priceChange1h',
        ]);

        const trades5m = getNested(token, [
          'trade5m',
          'trade_5m',
          'trades5m',
          'trade5mCount',
          'trade_5m_count',
        ]);

        const trades1h = getNested(token, [
          'trade1h',
          'trade_1h',
          'trades1h',
          'trade1hCount',
          'trade_1h_count',
        ]);

        return {
          address: token.address ?? '',
          name: token.name ?? 'Unknown',
          symbol: token.symbol ?? 'UNKNOWN',

          price: num(token.price),

          marketCap: getNested(token, [
            'marketCap',
            'marketcap',
            'mc',
          ]),

          liquidity: num(token.liquidity),

          volume24h,
          volume5m,
          volume1h,

          priceChange24h,
          priceChange5m,
          priceChange1h,

          trades5m: int(trades5m),
          trades1h: int(trades1h),

          timestamp: Date.now(),
        };
      })
      .filter((token: TokenSnapshot) => {
        return (
          token.address &&
          token.price > 0 &&
          token.marketCap >= config.minMarketCap &&
          token.marketCap <= config.maxMarketCap &&
          token.liquidity >= config.minLiquidity &&
          token.volume24h >= config.minVolume24h
        );
      });

    console.log(
      `✅ ${tokens.length} tokens after local validation`
    );

    return tokens;

  } catch (error) {
    console.error(
      '❌ Birdeye discovery error:',
      error
    );

    if (axios.isAxiosError(error)) {
      console.error('HTTP:', error.response?.status);
      console.error(
        'Response:',
        JSON.stringify(
          error.response?.data,
          null,
          2
        )
      );
    }

    return [];
  }
}

// ============================================================
// Z-SCORE
// ============================================================

function calculateZScore(
  current: number,
  historical: number[]
): number {

  if (historical.length < 10) {
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

  const stdDev = Math.sqrt(variance);

  if (!Number.isFinite(stdDev) || stdDev === 0) {
    return 0;
  }

  return (current - mean) / stdDev;
}

// ============================================================
// HISTORY
// ============================================================

async function getTokenHistory(
  tokenAddress: string
): Promise<TokenSnapshot[]> {

  try {

    const { data, error } = await supabase
      .from('token_snapshots')
      .select('*')
      .eq('token_address', tokenAddress)
      .order('created_at', {
        ascending: false,
      })
      .limit(config.maxHistorySnapshots);

    if (error) {
      throw error;
    }

    if (!data?.length) {
      return [];
    }

    return data
      .reverse()
      .map((row: any) => ({
        address: row.token_address,
        name: row.token_name,
        symbol: row.token_symbol,

        price: num(row.price),
        marketCap: num(row.market_cap),
        liquidity: num(row.liquidity),

        volume24h: num(row.volume_24h),
        volume5m: num(row.volume_5m),
        volume1h: num(row.volume_1h),

        priceChange24h: num(row.price_change_24h),
        priceChange5m: num(row.price_change_5m),
        priceChange1h: num(row.price_change_1h),

        trades5m: int(row.trades_5m),
        trades1h: int(row.trades_1h),

        timestamp:
          new Date(row.created_at).getTime(),
      }));

  } catch (error) {

    console.error(
      `❌ History error for ${tokenAddress}:`,
      error
    );

    return [];
  }
}

// ============================================================
// ANOMALY ENGINE
// ============================================================

function detectAnomalies(
  token: TokenSnapshot,
  history: TokenSnapshot[]
): AnomalyDetection {

  const anomalies: string[] = [];

  const health = {
    liquidityOk:
      token.liquidity >= config.minLiquidity,

    volumeOk:
      token.volume24h >= config.minVolume24h,

    marketCapOk:
      token.marketCap >= config.minMarketCap &&
      token.marketCap <= config.maxMarketCap,
  };

  if (history.length < 10) {

    return {
      token,

      zScores: {
        volume5m: 0,
        volume1h: 0,
        price5m: 0,
        price1h: 0,
        trades5m: 0,
      },

      maxZScore: 0,

      opportunityScore: 0,

      level: 'watch',

      anomalies: [
        `Building baseline (${history.length}/10 snapshots)`,
      ],

      health,
    };
  }

  const volume5mHistory =
    history.map(t => t.volume5m || 0);

  const volume1hHistory =
    history.map(t => t.volume1h || 0);

  const price5mHistory =
    history.map(t =>
      Math.abs(t.priceChange5m || 0)
    );

  const price1hHistory =
    history.map(t =>
      Math.abs(t.priceChange1h || 0)
    );

  const trades5mHistory =
    history.map(t => t.trades5m || 0);

  const volume5mZ =
    calculateZScore(
      token.volume5m,
      volume5mHistory
    );

  const volume1hZ =
    calculateZScore(
      token.volume1h,
      volume1hHistory
    );

  const price5mZ =
    calculateZScore(
      Math.abs(token.priceChange5m),
      price5mHistory
    );

  const price1hZ =
    calculateZScore(
      Math.abs(token.priceChange1h),
      price1hHistory
    );

  const trades5mZ =
    calculateZScore(
      token.trades5m,
      trades5mHistory
    );

  // ----------------------------------------------------------
  // ANOMALIES
  // ----------------------------------------------------------

  if (volume5mZ >= config.watchZ) {
    anomalies.push(
      `5m volume spike Z=${volume5mZ.toFixed(2)}`
    );
  }

  if (volume1hZ >= config.watchZ) {
    anomalies.push(
      `1h volume spike Z=${volume1hZ.toFixed(2)}`
    );
  }

  if (price5mZ >= config.watchZ) {
    anomalies.push(
      `5m price movement Z=${price5mZ.toFixed(2)}`
    );
  }

  if (price1hZ >= config.watchZ) {
    anomalies.push(
      `1h price movement Z=${price1hZ.toFixed(2)}`
    );
  }

  if (trades5mZ >= config.watchZ) {
    anomalies.push(
      `5m trade spike Z=${trades5mZ.toFixed(2)}`
    );
  }

  const maxZScore = Math.max(
    volume5mZ,
    volume1hZ,
    price5mZ,
    price1hZ,
    trades5mZ
  );

  // ----------------------------------------------------------
  // OPPORTUNITY SCORE
  // ----------------------------------------------------------

  let score = 0;

  // Volume = signal principal
  score += Math.min(
    30,
    Math.max(0, volume5mZ * 10)
  );

  // Trades = confirmation
  score += Math.min(
    20,
    Math.max(0, trades5mZ * 7)
  );

  // Prix = confirmation
  score += Math.min(
    20,
    Math.max(0, price5mZ * 7)
  );

  // 1h momentum
  score += Math.min(
    15,
    Math.max(0, price1hZ * 5)
  );

  // Health
  if (health.liquidityOk) {
    score += 10;
  }

  if (health.volumeOk) {
    score += 5;
  }

  score = Math.min(
    100,
    Math.round(score)
  );

  // ----------------------------------------------------------
  // LEVEL
  // ----------------------------------------------------------

  let level:
    | 'watch'
    | 'alert'
    | 'critical' = 'watch';

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
    token,

    zScores: {
      volume5m: volume5mZ,
      volume1h: volume1hZ,
      price5m: price5mZ,
      price1h: price1hZ,
      trades5m: trades5mZ,
    },

    maxZScore,

    opportunityScore: score,

    level,

    anomalies,

    health,
  };
}

// ============================================================
// SAVE
// ============================================================

async function saveSnapshot(
  token: TokenSnapshot,
  detection: AnomalyDetection
) {

  const { error } = await supabase
    .from('token_snapshots')
    .insert({

      token_address: token.address,
      token_name: token.name,
      token_symbol: token.symbol,

      price: token.price,

      volume_24h: token.volume24h,
      volume_5m: token.volume5m,
      volume_1h: token.volume1h,

      market_cap: token.marketCap,
      liquidity: token.liquidity,

      price_change_24h:
        token.priceChange24h,

      price_change_5m:
        token.priceChange5m,

      price_change_1h:
        token.priceChange1h,

      trades_5m:
        token.trades5m,

      trades_1h:
        token.trades1h,

      z_score_volume_5m:
        detection.zScores.volume5m,

      z_score_volume_1h:
        detection.zScores.volume1h,

      z_score_price_5m:
        detection.zScores.price5m,

      z_score_price_1h:
        detection.zScores.price1h,

      z_score_trades_5m:
        detection.zScores.trades5m,

      max_z_score:
        detection.maxZScore,

      opportunity_score:
        detection.opportunityScore,

      anomaly_level:
        detection.level,

      anomalies:
        detection.anomalies.join(' | '),

      created_at:
        new Date(token.timestamp).toISOString(),
    });

  if (error) {
    console.error(
      '❌ Supabase insert error:',
      error
    );
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendAlert(
  detection: AnomalyDetection
) {

  const now = Date.now();

  const previous =
    lastAlertAt.get(
      detection.token.address
    ) || 0;

  const cooldown =
    config.minAlertRepeatMinutes *
    60 *
    1000;

  if (now - previous < cooldown) {
    return;
  }

  lastAlertAt.set(
    detection.token.address,
    now
  );

  const emoji =
    detection.level === 'critical'
      ? '🔴'
      : '🟡';

  const message = `
${emoji} ${detection.level.toUpperCase()}

🎯 Opportunity Score: ${detection.opportunityScore}/100

Token: ${detection.token.name} ($${detection.token.symbol})
Address: \`${detection.token.address}\`

💰 Market Cap: $${(
    detection.token.marketCap / 1_000_000
  ).toFixed(2)}M

💧 Liquidity: $${(
    detection.token.liquidity / 1_000
  ).toFixed(0)}K

📊 Volume:
• 5m: $${(
    detection.token.volume5m / 1_000
  ).toFixed(1)}K
• 1h: $${(
    detection.token.volume1h / 1_000
  ).toFixed(1)}K
• 24h: $${(
    detection.token.volume24h / 1_000_000
  ).toFixed(2)}M

📈 Price:
• 5m: ${detection.token.priceChange5m.toFixed(2)}%
• 1h: ${detection.token.priceChange1h.toFixed(2)}%
• 24h: ${detection.token.priceChange24h.toFixed(2)}%

🔢 Trades:
• 5m: ${detection.token.trades5m}
• 1h: ${detection.token.trades1h}

📐 Z-Scores:
• Volume 5m: ${detection.zScores.volume5m.toFixed(2)}
• Volume 1h: ${detection.zScores.volume1h.toFixed(2)}
• Price 5m: ${detection.zScores.price5m.toFixed(2)}
• Price 1h: ${detection.zScores.price1h.toFixed(2)}
• Trades 5m: ${detection.zScores.trades5m.toFixed(2)}

🚨 Signals:
${detection.anomalies.length
      ? detection.anomalies.map(x => `• ${x}`).join('\n')
      : '• No major anomaly'}

🔗 https://dexscreener.com/solana/${detection.token.address}
`;

  try {

    await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      message,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }
    );

    console.log(
      `📨 Alert sent: ${detection.token.symbol} | Score ${detection.opportunityScore}`
    );

  } catch (error) {

    console.error(
      '❌ Telegram error:',
      error
    );
  }
}

// ============================================================
// MAIN SCAN
// ============================================================

async function runListener() {

  const startedAt = Date.now();

  try {

    console.log(
      `\n⏰ [${new Date().toISOString()}] Starting scan...`
    );

    const tokens =
      await fetchSolanaTokens();

    if (!tokens.length) {

      console.log(
        '⚠️ No tokens found.'
      );

      return;
    }

    let alerts = 0;
    let anomalies = 0;

    for (const token of tokens) {

      try {

        const history =
          await getTokenHistory(
            token.address
          );

        const detection =
          detectAnomalies(
            token,
            history
          );

        await saveSnapshot(
          token,
          detection
        );

        if (
          detection.maxZScore >=
          config.watchZ
        ) {
          anomalies++;

          console.log(
            `📊 ${token.symbol} | ` +
            `Z=${detection.maxZScore.toFixed(2)} | ` +
            `Score=${detection.opportunityScore} | ` +
            `${detection.level} | ` +
            `history=${history.length}`
          );
        }

        if (
          detection.level === 'alert' ||
          detection.level === 'critical'
        ) {

          await sendAlert(
            detection
          );

          alerts++;
          alertCount++;
        }

        processingCount++;

      } catch (error) {

        console.error(
          `❌ Error processing ${token.symbol}:`,
          error
        );
      }
    }

    const duration =
      ((Date.now() - startedAt) / 1000)
        .toFixed(1);

    console.log(
      `✅ Scan complete | ` +
      `${tokens.length} tokens | ` +
      `${anomalies} anomalies | ` +
      `${alerts} alerts | ` +
      `${duration}s`
    );

  } catch (error) {

    console.error(
      '❌ Listener error:',
      error
    );
  }
}

// ============================================================
// START
// ============================================================

console.log(
  '🚀 Solana Opportunity Detector'
);

console.log(
  `💰 Market cap: $1M → $10M`
);

console.log(
  `💧 Min liquidity: $100K`
);

console.log(
  `📊 Min 24h volume: $50K`
);

console.log(
  `⏱️ Snapshot: every ${config.snapshotIntervalMinutes} min`
);

console.log(
  `📦 Max tokens/scan: ${config.maxTokensPerScan}`
);

console.log(
  `📚 History: ${config.maxHistorySnapshots} snapshots`
);

console.log(
  `🎯 Z-score: ${config.watchZ}/${config.alertZ}/${config.criticalZ}`
);

console.log('');

runListener().catch(console.error);

cron.schedule(
  `*/${config.snapshotIntervalMinutes} * * * *`,
  () => {
    runListener().catch(console.error);
  }
);

console.log(
  `✅ Scheduled every ${config.snapshotIntervalMinutes} minutes`
);
