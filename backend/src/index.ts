```typescript
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

  maxTokensPerScan: 100,

  snapshotIntervalMinutes: 5,
  maxHistorySnapshots: 288,

  watchZ: 2.0,
  alertZ: 2.5,
  criticalZ: 3.0,

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

const lastAlertAt = new Map<string, number>();

let isScanning = false;

// ============================================================
// HELPERS
// ============================================================

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ============================================================
// BIRDEYE
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
      },

      timeout: 15_000,
    });

    const rawTokens = response.data?.data?.tokens ?? [];

    if (!Array.isArray(rawTokens)) {
      console.error('❌ Unexpected Birdeye response structure');
      return [];
    }

    console.log(
      `📦 Birdeye returned ${rawTokens.length} candidates`
    );

    const tokens: TokenSnapshot[] = rawTokens
      .map((token: any): TokenSnapshot => ({
        address: String(token.address ?? ''),
        name: String(token.name ?? 'Unknown'),
        symbol: String(token.symbol ?? 'UNKNOWN'),

        price: num(token.price),

        marketCap: num(token.market_cap),

        liquidity: num(token.liquidity),

        // IMPORTANT:
        // Birdeye V3 returns snake_case fields.
        volume24h: num(token.volume_24h_usd),
        volume5m: num(token.volume_5m_usd),
        volume1h: num(token.volume_1h_usd),

        priceChange24h: num(
          token.price_change_24h_percent
        ),

        priceChange5m: num(
          token.price_change_5m_percent
        ),

        priceChange1h: num(
          token.price_change_1h_percent
        ),

        trades5m: int(
          token.trade_5m_count
        ),

        trades1h: int(
          token.trade_1h_count
        ),

        timestamp: Date.now(),
      }))
      .filter((token) => {
        return (
          token.address.length > 0 &&
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
      console.error(
        'HTTP:',
        error.response?.status
      );

      console.error(
        'Response:',
        error.response?.data
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

  if (
    !Number.isFinite(stdDev) ||
    stdDev === 0
  ) {
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

    if (!data || data.length === 0) {
      return [];
    }

    return data
      .reverse()
      .map((row: any): TokenSnapshot => ({
        address: String(
          row.token_address ?? ''
        ),

        name: String(
          row.token_name ?? 'Unknown'
        ),

        symbol: String(
          row.token_symbol ?? 'UNKNOWN'
        ),

        price: num(row.price),

        marketCap: num(
          row.market_cap
        ),

        liquidity: num(
          row.liquidity
        ),

        volume24h: num(
          row.volume_24h
        ),

        volume5m: num(
          row.volume_5m
        ),

        volume1h: num(
          row.volume_1h
        ),

        priceChange24h: num(
          row.price_change_24h
        ),

        priceChange5m: num(
          row.price_change_5m
        ),

        priceChange1h: num(
          row.price_change_1h
        ),

        trades5m: int(
          row.trades_5m
        ),

        trades1h: int(
          row.trades_1h
        ),

        timestamp: new Date(
          row.created_at
        ).getTime(),
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

  // ----------------------------------------------------------
  // Not enough history
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // HISTORICAL DATA
  // ----------------------------------------------------------

  const volume5mHistory = history.map(
    (t) => t.volume5m
  );

  const volume1hHistory = history.map(
    (t) => t.volume1h
  );

  const price5mHistory = history.map(
    (t) => Math.abs(t.priceChange5m)
  );

  const price1hHistory = history.map(
    (t) => Math.abs(t.priceChange1h)
  );

  const trades5mHistory = history.map(
    (t) => t.trades5m
  );

  // ----------------------------------------------------------
  // Z-SCORES
  // ----------------------------------------------------------

  const volume5mZ = calculateZScore(
    token.volume5m,
    volume5mHistory
  );

  const volume1hZ = calculateZScore(
    token.volume1h,
    volume1hHistory
  );

  const price5mZ = calculateZScore(
    Math.abs(token.priceChange5m),
    price5mHistory
  );

  const price1hZ = calculateZScore(
    Math.abs(token.priceChange1h),
    price1hHistory
  );

  const trades5mZ = calculateZScore(
    token.trades5m,
    trades5mHistory
  );

  // ----------------------------------------------------------
  // ANOMALIES
  // ----------------------------------------------------------

  if (volume5mZ >= config.watchZ) {
    anomalies.push(
      `5m volume spike Z=${volume5mZ.toFixed(2)} ($${(
        token.volume5m / 1000
      ).toFixed(1)}K)`
    );
  }

  if (volume1hZ >= config.watchZ) {
    anomalies.push(
      `1h volume spike Z=${volume1hZ.toFixed(2)} ($${(
        token.volume1h / 1000
      ).toFixed(1)}K)`
    );
  }

  if (price5mZ >= config.watchZ) {
    anomalies.push(
      `5m price move Z=${price5mZ.toFixed(2)} (${token.priceChange5m.toFixed(
        2
      )}%)`
    );
  }

  if (price1hZ >= config.watchZ) {
    anomalies.push(
      `1h price move Z=${price1hZ.toFixed(2)} (${token.priceChange1h.toFixed(
        2
      )}%)`
    );
  }

  if (trades5mZ >= config.watchZ) {
    anomalies.push(
      `5m trades spike Z=${trades5mZ.toFixed(2)} (${token.trades5m} trades)`
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

  score += Math.min(
    30,
    Math.max(0, volume5mZ * 10)
  );

  score += Math.min(
    20,
    Math.max(0, trades5mZ * 7)
  );

  score += Math.min(
    20,
    Math.max(0, price5mZ * 7)
  );

  score += Math.min(
    15,
    Math.max(0, price1hZ * 5)
  );

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
// SUPABASE
// ============================================================

async function saveSnapshot(
  token: TokenSnapshot,
  detection: AnomalyDetection
): Promise<void> {
  try {
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
          new Date(
            token.timestamp
          ).toISOString(),
      });

    if (error) {
      console.error(
        '❌ Supabase insert error:',
        error
      );
    }
  } catch (error) {
    console.error(
      '❌ Supabase save error:',
      error
    );
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendAlert(
  detection: AnomalyDetection
): Promise<boolean> {
  const now = Date.now();

  const previous =
    lastAlertAt.get(
      detection.token.address
    ) ?? 0;

  const cooldown =
    config.minAlertRepeatMinutes *
    60 *
    1000;

  if (now - previous < cooldown) {
    return false;
  }

  const emoji =
    detection.level === 'critical'
      ? '🔴'
      : '🟡';

  const signals =
    detection.anomalies.length > 0
      ? detection.anomalies
          .map((x) => `• ${x}`)
          .join('\n')
      : '• No major anomaly';

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
${signals}

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

    lastAlertAt.set(
      detection.token.address,
      now
    );

    console.log(
      `📨 Alert sent: ${detection.token.symbol} | Score ${detection.opportunityScore}`
    );

    return true;
  } catch (error) {
    console.error(
      '❌ Telegram error:',
      error
    );

    return false;
  }
}

// ============================================================
// MAIN SCAN
// ============================================================

async function runListener(): Promise<void> {
  if (isScanning) {
    console.log(
      '⚠️ Previous scan still running. Skipping this cycle.'
    );

    return;
  }

  isScanning = true;

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

    let anomalies = 0;
    let alerts = 0;

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
            `📊 ${token.symbol} | Z=${detection.maxZScore.toFixed(
              2
            )} | Score=${detection.opportunityScore} | ${detection.level} | history=${history.length}`
          );
        }

        if (
          detection.level === 'alert' ||
          detection.level === 'critical'
        ) {
          const sent =
            await sendAlert(
              detection
            );

          if (sent) {
            alerts++;
          }
        }
      } catch (error) {
        console.error(
          `❌ Error processing ${token.symbol}:`,
          error
        );
      }
    }

    const duration =
      (
        (Date.now() - startedAt) /
        1000
      ).toFixed(1);

    console.log(
      `✅ Scan complete | ${tokens.length} tokens | ${anomalies} anomalies | ${alerts} alerts | ${duration}s\n`
    );
  } catch (error) {
    console.error(
      '❌ Listener error:',
      error
    );
  } finally {
    isScanning = false;
  }
}

// ============================================================
// STARTUP
// ============================================================

console.log(
  '🚀 Solana Opportunity Detector'
);

console.log(
  `💰 Market cap: $${config.minMarketCap / 1_000_000}M → $${config.maxMarketCap / 1_000_000}M`
);

console.log(
  `💧 Min liquidity: $${config.minLiquidity / 1_000}K`
);

console.log(
  `📊 Min 24h volume: $${config.minVolume24h / 1_000}K`
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

void runListener();

cron.schedule(
  `*/${config.snapshotIntervalMinutes} * * * *`,
  () => {
    void runListener();
  }
);

console.log(
  `✅ Scheduled every ${config.snapshotIntervalMinutes} minutes`
);
```
