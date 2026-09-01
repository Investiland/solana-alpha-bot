import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

// ============================================================
// ENVIRONMENT
// ============================================================

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  BIRDEYE_API_KEY,
} = process.env;

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !TELEGRAM_BOT_TOKEN ||
  !TELEGRAM_CHAT_ID ||
  !BIRDEYE_API_KEY
) {
  throw new Error(
    'Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BIRDEYE_API_KEY'
  );
}

// ============================================================
// CLIENTS
// ============================================================

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

const bot = new TelegramBot(
  TELEGRAM_BOT_TOKEN,
  {
    polling: false,
  }
);

const BIRDEYE_API =
  'https://public-api.birdeye.so/defi/v3/token/list';

const BIRDEYE_TOKEN_CREATION_INFO =
  'https://public-api.birdeye.so/defi/token_creation_info';

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

  minimumHistoryForZScore: 10,

  minAgeHours: 7 * 24,

  watchZ: 2.0,
  alertZ: 2.5,
  criticalZ: 3.0,

  minAlertRepeatMinutes: 30,

  requestTimeoutMs: 15_000,
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

  createdAt?: number;
}

interface ZScores {
  volume5m: number;
  volume1h: number;
  price5m: number;
  price1h: number;
  trades5m: number;
}

interface Health {
  liquidityOk: boolean;
  volumeOk: boolean;
  marketCapOk: boolean;
}

interface AnomalyDetection {
  token: TokenSnapshot;

  zScores: ZScores;

  maxZScore: number;

  opportunityScore: number;

  level: 'watch' | 'alert' | 'critical';

  anomalies: string[];

  health: Health;
}

// ============================================================
// STATE
// ============================================================

const lastAlertAt = new Map<string, number>();

let scanRunning = false;

let totalScans = 0;
let totalTokensProcessed = 0;
let totalAlertsSent = 0;
let birdeyeRequestCount = 0;

// ============================================================
// HELPERS
// ============================================================

function num(value: unknown): number {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function int(value: unknown): number {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? Math.trunc(parsed)
    : 0;
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

async function upsertToken(
  token: TokenSnapshot
): Promise<void> {
  try {
    const { error } = await supabase
      .from('tokens')
      .upsert({
        token_address: token.address,
        token_name: token.name,
        token_symbol: token.symbol,
        created_at: token.createdAt
          ? new Date(token.createdAt).toISOString()
          : null,
        creation_status: token.createdAt
          ? 'enriched'
          : 'new',
        creation_last_attempt_at:
          new Date().toISOString(),
      });

    if (error) {
      console.error(
        `❌ Upsert token error for ${token.symbol}:`,
        error
      );
    }
  } catch (error) {
    console.error(
      `❌ Token upsert error:`,
      error
    );
  }
}

// ============================================================
// TOKEN CREATION INFO
// ============================================================

async function fetchTokenCreationTime(
  tokenAddress: string
): Promise<number | null> {
  try {
    console.log(
      `🕐 Fetching creation time for ${tokenAddress}...`
    );

    const response = await axios.get(
      BIRDEYE_TOKEN_CREATION_INFO,
      {
        headers: {
          'X-API-KEY': BIRDEYE_API_KEY,
          'x-chain': 'solana',
        },

        params: {
          address: tokenAddress,
        },

        timeout: config.requestTimeoutMs,
      }
    );

    const blockUnixTime = response.data?.data?.blockUnixTime;

    if (!blockUnixTime) {
      console.warn(
        `⚠️ No blockUnixTime for ${tokenAddress}`
      );
      console.log(
        `📄 Response: ${JSON.stringify(response.data, null, 2).slice(0, 1000)}`
      );
      return null;
    }

    const createdAtMs = blockUnixTime * 1000;

    console.log(
      `✅ Token created at: ${new Date(createdAtMs).toISOString()}`
    );

    return createdAtMs;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      console.error(
        `❌ Rate limited on creation info for ${tokenAddress}. Skipping.`
      );
    } else {
      console.error(
        `❌ Creation time fetch error for ${tokenAddress}:`,
        error
      );
    }

    return null;
  }
}

// ============================================================
// BIRDEYE
// ============================================================

async function fetchSolanaTokens(): Promise<TokenSnapshot[]> {
  try {
    birdeyeRequestCount++;
    const requestNum = birdeyeRequestCount;
    
    console.log(
      `🌐 Birdeye request #${requestNum} at [${new Date().toISOString()}]`
    );
    
    console.log(
      '🔍 Birdeye: scanning Solana token universe...'
    );

    const response = await axios.get(
      BIRDEYE_API,
      {
        headers: {
          'X-API-KEY': BIRDEYE_API_KEY,
          'x-chain': 'solana',
        },

        params: {
          sort_by: 'market_cap',
          sort_type: 'desc',

          min_market_cap:
            config.minMarketCap,

          max_market_cap:
            config.maxMarketCap,

          min_liquidity:
            config.minLiquidity,

          min_volume_24h_usd:
            config.minVolume24h,

          limit:
            config.maxTokensPerScan,

          offset: 0,
        },

        timeout:
          config.requestTimeoutMs,
      }
    );

    // Log rate limit headers
    const rateLimit = {
      limit: response.headers['x-ratelimit-limit'],
      remaining: response.headers['x-ratelimit-remaining'],
      reset: response.headers['x-ratelimit-reset'],
    };

    console.log(
      `✅ Birdeye request #${requestNum} succeeded | Rate limit: ${rateLimit.remaining}/${rateLimit.limit} | Reset at: ${rateLimit.reset}`
    );

    console.log(
      '📦 BIRDEYE RAW RESPONSE:',
      JSON.stringify(response.data, null, 2).slice(0, 5000)
    );

    const rawTokens =
      response.data?.data?.items ?? [];

    if (!Array.isArray(rawTokens)) {
      console.error(
        '❌ Unexpected Birdeye response structure'
      );

      return [];
    }

    console.log(
      `📦 Birdeye returned ${rawTokens.length} candidates`
    );

    const tokens: TokenSnapshot[] =
      rawTokens
        .map((token: any) => {
          return {
            address:
              typeof token.address === 'string'
                ? token.address
                : '',

            name:
              typeof token.name === 'string'
                ? token.name
                : 'Unknown',

            symbol:
              typeof token.symbol === 'string'
                ? token.symbol
                : 'UNKNOWN',

            price: num(token.price),

            marketCap:
              num(token.market_cap),

            liquidity:
              num(token.liquidity),

            volume24h:
              num(token.volume_24h_usd),

            volume5m:
              num(token.volume_5m_usd),

            volume1h:
              num(token.volume_1h_usd),

            priceChange24h:
              num(
                token.price_change_24h_percent
              ),

            priceChange5m:
              num(
                token.price_change_5m_percent
              ),

            priceChange1h:
              num(
                token.price_change_1h_percent
              ),

            trades5m:
              int(token.trade_5m_count),

            trades1h:
              int(token.trade_1h_count),

            timestamp: Date.now(),
          };
        })

        .filter((token: TokenSnapshot) => {
          return (
            token.address.length > 0 &&
            token.price > 0 &&
            token.marketCap >=
              config.minMarketCap &&
            token.marketCap <=
              config.maxMarketCap &&
            token.liquidity >=
              config.minLiquidity &&
            token.volume24h >=
              config.minVolume24h
          );
        });

    console.log(
      `✅ ${tokens.length} tokens after validation`
    );

    // Enrich tokens with creation time
    // Check DB first, only call Birdeye for new tokens
    // Limit concurrent API calls to avoid rate limiting
    const maxConcurrentCalls = 2;
    let activeRequests = 0;
    const queue: Array<() => Promise<void>> = [];

    const enrichedTokens = await Promise.all(
      tokens.map(async (token) => {
        return new Promise<TokenSnapshot>(
          (resolve) => {
            const task = async () => {
              if (!token.createdAt) {
                // Check tokens table in DB first
                try {
                  const { data: existingToken } =
                    await supabase
                      .from('tokens')
                      .select(
                        'created_at'
                      )
                      .eq(
                        'token_address',
                        token.address
                      )
                      .single();

                  if (
                    existingToken &&
                    existingToken.created_at
                  ) {
                    // Use cached date
                    token.createdAt = new Date(
                      existingToken.created_at
                    ).getTime();
                    console.log(
                      `📦 Using cached created_at for ${token.symbol}`
                    );
                  } else {
                    // Truly new token, fetch from Birdeye
                    const createdAt =
                      await fetchTokenCreationTime(
                        token.address
                      );
                    if (createdAt) {
                      token.createdAt = createdAt;
                    }
                  }
                } catch (error) {
                  console.error(
                    `❌ Error checking token DB:`,
                    error
                  );
                }
              }
              resolve(token);
              activeRequests--;
              processQueue();
            };

            const processQueue = () => {
              while (
                activeRequests <
                maxConcurrentCalls &&
                queue.length > 0
              ) {
                activeRequests++;
                const nextTask =
                  queue.shift();
                if (nextTask) {
                  nextTask().catch(
                    console.error
                  );
                }
              }
            };

            if (
              activeRequests <
              maxConcurrentCalls
            ) {
              activeRequests++;
              task().catch(console.error);
            } else {
              queue.push(task);
            }
          }
        );
      })
    );

    console.log(
      `📦 Enriched tokens with creation times`
    );

    return enrichedTokens;
  } catch (error) {
    console.error(
      `❌ Birdeye request #${birdeyeRequestCount} FAILED`
    );

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const headers = error.response?.headers;
      
      console.error(
        `HTTP status: ${status}`
      );

      if (status === 429) {
        console.error(
          '⚠️ RATE LIMIT HIT (429)'
        );
        console.error(
          `x-ratelimit-limit: ${headers['x-ratelimit-limit']}`
        );
        console.error(
          `x-ratelimit-remaining: ${headers['x-ratelimit-remaining']}`
        );
        console.error(
          `x-ratelimit-reset: ${headers['x-ratelimit-reset']}`
        );
        console.error(
          `retry-after: ${headers['retry-after']}`
        );
      }

      console.error(
        'Response data:',
        error.response?.data
      );
    } else {
      console.error(
        'Error details:',
        error
      );
    }

    return [];
  }
}

// ============================================================
// HISTORY
// ============================================================

async function getTokenCreatedAt(
  tokenAddress: string
): Promise<number | null> {
  try {
    const { data, error } =
      await supabase
        .from('token_snapshots')
        .select('token_created_at')
        .eq('token_address', tokenAddress)
        .limit(1)
        .single();

    if (error || !data) return null;

    const createdAt = data.token_created_at;
    if (!createdAt) return null;

    return new Date(createdAt).getTime();
  } catch (error) {
    console.error(
      `❌ Get created_at error for ${tokenAddress}:`,
      error
    );
    return null;
  }
}

async function getTokenHistory(
  tokenAddress: string
): Promise<TokenSnapshot[]> {
  try {
    const { data, error } =
      await supabase
        .from('token_snapshots')
        .select('*')
        .eq('token_address', tokenAddress)
        .order('created_at', {
          ascending: false,
        })
        .limit(config.maxHistorySnapshots);

    if (error) throw error;

    if (!data || data.length === 0) {
      return [];
    }

    return data.reverse().map(
      (row: any) => ({
        address: row.token_address,
        name: row.token_name,
        symbol: row.token_symbol,

        price: num(row.price),

        marketCap: num(row.market_cap),
        liquidity: num(row.liquidity),

        volume24h: num(row.volume_24h),
        volume5m: num(row.volume_5m),
        volume1h: num(row.volume_1h),

        priceChange24h: num(
          row.price_change_24h
        ),
        priceChange5m: num(
          row.price_change_5m
        ),
        priceChange1h: num(
          row.price_change_1h
        ),

        trades5m: int(row.trades_5m),
        trades1h: int(row.trades_1h),

        timestamp: new Date(
          row.created_at
        ).getTime(),

        createdAt: row.token_created_at
          ? new Date(row.token_created_at).getTime()
          : undefined,
      })
    );
  } catch (error) {
    console.error(
      `❌ History error for ${tokenAddress}:`,
      error
    );

    return [];
  }
}

// ============================================================
// ANOMALY DETECTION
// ============================================================

function detectAnomalies(
  token: TokenSnapshot,
  history: TokenSnapshot[]
): AnomalyDetection {
  const anomalies: string[] = [];

  const health: Health = {
    liquidityOk:
      token.liquidity >=
      config.minLiquidity,

    volumeOk:
      token.volume24h >=
      config.minVolume24h,

    marketCapOk:
      token.marketCap >=
      config.minMarketCap &&
      token.marketCap <=
      config.maxMarketCap,
  };

  if (
    history.length <
    config.minimumHistoryForZScore
  ) {
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
        `Building baseline (${history.length}/${config.minimumHistoryForZScore} snapshots)`,
      ],

      health,
    };
  }

  const volume5mChangeHistory =
    history.map(t => t.priceChange5m || 0);

  const volume1hChangeHistory =
    history.map(t => t.priceChange1h || 0);

  const price5mChangeHistory =
    history.map(
      t => Math.abs(t.priceChange5m || 0)
    );

  const price1hChangeHistory =
    history.map(
      t => Math.abs(t.priceChange1h || 0)
    );

  const trades5mHistory =
    history.map(t => t.trades5m || 0);

  const volume5mZ = calculateZScore(
    token.priceChange5m,
    volume5mChangeHistory
  );

  const volume1hZ = calculateZScore(
    token.priceChange1h,
    volume1hChangeHistory
  );

  const price5mZ = calculateZScore(
    Math.abs(token.priceChange5m),
    price5mChangeHistory
  );

  const price1hZ = calculateZScore(
    Math.abs(token.priceChange1h),
    price1hChangeHistory
  );

  const trades5mZ = calculateZScore(
    token.trades5m,
    trades5mHistory
  );

  if (
    volume5mZ >=
    config.watchZ
  ) {
    anomalies.push(
      `5m volume change Z=${volume5mZ.toFixed(2)} (${token.priceChange5m.toFixed(1)}%)`
    );
  }

  if (
    volume1hZ >=
    config.watchZ
  ) {
    anomalies.push(
      `1h volume change Z=${volume1hZ.toFixed(2)} (${token.priceChange1h.toFixed(1)}%)`
    );
  }

  if (
    price5mZ >=
    config.watchZ &&
    token.priceChange5m > 0
  ) {
    anomalies.push(
      `5m price move Z=${price5mZ.toFixed(2)} (${token.priceChange5m.toFixed(2)}%)`
    );
  }

  if (
    price1hZ >=
    config.watchZ &&
    token.priceChange1h > 0
  ) {
    anomalies.push(
      `1h price move Z=${price1hZ.toFixed(2)} (${token.priceChange1h.toFixed(2)}%)`
    );
  }

  if (
    trades5mZ >=
    config.watchZ
  ) {
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

  let score = 0;

  score += Math.min(
    30,
    Math.max(0, Math.abs(volume5mZ) * 10)
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

  if (health.liquidityOk) score += 10;
  if (health.volumeOk) score += 5;

  score = Math.min(
    100,
    Math.round(score)
  );

  let level: 'watch' | 'alert' | 'critical' =
    'watch';

  // Filtres pour opportunités haussières
  const tokenAgeHours = token.createdAt 
    ? (Date.now() - token.createdAt) / (1000 * 60 * 60)
    : Infinity;

  const isOldEnough = tokenAgeHours >= config.minAgeHours;
  const hasPositiveMove = token.priceChange5m > 0 || token.priceChange1h > 0;
  const hasSufficientMove = token.priceChange5m >= 5 || token.priceChange1h >= 5;

  const meetsOpportunityRequirements = 
    isOldEnough && hasPositiveMove && hasSufficientMove;

  if (meetsOpportunityRequirements) {
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
// SAVE SNAPSHOT
// ============================================================

async function saveSnapshot(
  token: TokenSnapshot,
  detection: AnomalyDetection
): Promise<void> {
  try {
    const { error } =
      await supabase
        .from('token_snapshots')
        .insert({
          token_address:
            token.address,

          token_name:
            token.name,

          token_symbol:
            token.symbol,

          price:
            token.price,

          volume_24h:
            token.volume24h,

          volume_5m:
            token.volume5m,

          volume_1h:
            token.volume1h,

          market_cap:
            token.marketCap,

          liquidity:
            token.liquidity,

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
            detection.anomalies.join(
              ' | '
            ),

          token_created_at:
            token.createdAt
              ? new Date(token.createdAt).toISOString()
              : null,

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
      '❌ Snapshot save error:',
      error
    );
  }
}

// ============================================================
// TELEGRAM ALERT
// ============================================================

async function sendAlert(
  detection: AnomalyDetection
): Promise<boolean> {
  const address =
    detection.token.address;

  const now =
    Date.now();

  const previousAlert =
    lastAlertAt.get(address) || 0;

  const cooldown =
    config.minAlertRepeatMinutes *
    60 *
    1000;

  if (
    now - previousAlert <
    cooldown
  ) {
    return false;
  }

  const emoji =
    detection.level ===
    'critical'
      ? '🔴'
      : '🟡';

  const message = `
${emoji} ${detection.level.toUpperCase()} ANOMALY

🎯 Opportunity Score: ${detection.opportunityScore}/100

🪙 Token: ${detection.token.name} ($${detection.token.symbol})
Address: \`${address}\`

💰 Market Cap: ${formatUsd(detection.token.marketCap)}
💧 Liquidity: ${formatUsd(detection.token.liquidity)}

📊 Volume
• 5m: ${formatUsd(detection.token.volume5m)}
• 1h: ${formatUsd(detection.token.volume1h)}
• 24h: ${formatUsd(detection.token.volume24h)}

📈 Price
• 5m: ${detection.token.priceChange5m.toFixed(2)}%
• 1h: ${detection.token.priceChange1h.toFixed(2)}%
• 24h: ${detection.token.priceChange24h.toFixed(2)}%

🔢 Trades
• 5m: ${detection.token.trades5m}
• 1h: ${detection.token.trades1h}

📐 Z-Scores
• Volume 5m: ${detection.zScores.volume5m.toFixed(2)}
• Volume 1h: ${detection.zScores.volume1h.toFixed(2)}
• Price 5m: ${detection.zScores.price5m.toFixed(2)}
• Price 1h: ${detection.zScores.price1h.toFixed(2)}
• Trades 5m: ${detection.zScores.trades5m.toFixed(2)}

🚨 Signals
${
  detection.anomalies.length > 0
    ? detection.anomalies
        .map(signal => `• ${signal}`)
        .join('\n')
    : '• No major anomaly'
}

🔗 https://dexscreener.com/solana/${address}
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
      address,
      now
    );

    totalAlertsSent++;

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
// CLEANUP ALERT CACHE
// ============================================================

function cleanupAlertCache(): void {
  const now =
    Date.now();

  const expiration =
    config.minAlertRepeatMinutes *
    60 *
    1000 *
    2;

  for (
    const [
      address,
      timestamp,
    ] of lastAlertAt.entries()
  ) {
    if (
      now - timestamp >
      expiration
    ) {
      lastAlertAt.delete(
        address
      );
    }
  }
}

// ============================================================
// MAIN SCAN
// ============================================================

async function runListener(): Promise<void> {
  if (scanRunning) {
    console.log(
      '⚠️ Previous scan still running. Skipping this cycle.'
    );

    return;
  }

  scanRunning = true;

  const startedAt =
    Date.now();

  totalScans++;

  try {
    console.log(
      `\n⏰ [${new Date().toISOString()}] Starting scan #${totalScans}...`
    );

    const tokens =
      await fetchSolanaTokens();

    if (
      tokens.length === 0
    ) {
      console.log(
        '⚠️ No tokens found.'
      );

      return;
    }

    let anomalyCount = 0;
    let alertCountThisScan = 0;

    for (
      const token of tokens
    ) {
      try {
        const history =
          await getTokenHistory(
            token.address
          );

        // Get createdAt from DB cache if not in current token
        if (!token.createdAt) {
          const cachedCreatedAt =
            await getTokenCreatedAt(
              token.address
            );
          if (cachedCreatedAt) {
            token.createdAt = cachedCreatedAt;
          }
        }

        const detection =
          detectAnomalies(
            token,
            history
          );

        await upsertToken(token);

        await saveSnapshot(
          token,
          detection
        );

        totalTokensProcessed++;

        if (
          detection.maxZScore >=
          config.watchZ
        ) {
          anomalyCount++;

          console.log(
            `📊 ${token.symbol} | Z=${detection.maxZScore.toFixed(2)} | Score=${detection.opportunityScore} | ${detection.level} | history=${history.length}`
          );
        }

        if (
          detection.level ===
            'alert' ||
          detection.level ===
            'critical'
        ) {
          const sent =
            await sendAlert(
              detection
            );

          if (sent) {
            alertCountThisScan++;
          }
        }
      } catch (error) {
        console.error(
          `❌ Error processing ${token.symbol}:`,
          error
        );
      }
    }

    cleanupAlertCache();

    const duration =
      (
        (Date.now() -
          startedAt) /
        1000
      ).toFixed(1);

    console.log(
      `✅ Scan complete | ${tokens.length} tokens | ${anomalyCount} anomalies | ${alertCountThisScan} alerts | ${duration}s`
    );

    console.log(
      `📈 Total stats | scans=${totalScans} | processed=${totalTokensProcessed} | alerts=${totalAlertsSent} | birdeye_requests=${birdeyeRequestCount}`
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

console.log(
  '🚀 Solana Opportunity Detector'
);

console.log(
  `💰 Market cap: $${config.minMarketCap / 1_000_000}M → $${config.maxMarketCap / 1_000_000}M`
);

console.log(
  `💧 Min liquidity: ${formatUsd(config.minLiquidity)}`
);

console.log(
  `📊 Min 24h volume: ${formatUsd(config.minVolume24h)}`
);

console.log(
  `⏱️ Snapshot: every ${config.snapshotIntervalMinutes} minutes`
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

console.log(
  `🔕 Alert cooldown: ${config.minAlertRepeatMinutes} minutes`
);

console.log('');

runListener().catch(error => {
  console.error(
    '❌ Startup scan error:',
    error
  );
});

cron.schedule(
  `*/${config.snapshotIntervalMinutes} * * * *`,
  () => {
    runListener().catch(error => {
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
