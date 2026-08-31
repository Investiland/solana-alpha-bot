import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

// Init clients
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/search?q=solana&order=volume&limit=100';

interface TokenSnapshot {
  address: string;
  name: string;
  symbol: string;
  price: number;
  volume24h: number;
  marketCap: number;
  liquidity: number;
  priceChange24h: number;
  timestamp: number;
}

interface AnomalyDetection {
  token: TokenSnapshot;
  zScores: {
    volume: number;
    price: number;
    marketCap: number;
    liquidity: number;
  };
  maxZScore: number;
  level: 'watch' | 'alert' | 'critical';
  anomalies: string[];
}

interface TokenMetadata {
  holders?: number;
  top5HoldersPct?: number;
  isMintable?: boolean;
  isFreezeEnabled?: boolean;
}

let lastSnapshots: Map<string, TokenSnapshot[]> = new Map();
let processingCount = 0;
let alertCount = 0;

// Fetch top 100 Solana tokens from Dexscreener
async function fetchTopTokens(): Promise<TokenSnapshot[]> {
  try {
    const response = await axios.get(DEXSCREENER_API);
    
    if (!response.data?.pairs) {
      console.log('❌ No pairs found in Dexscreener response');
      return [];
    }

    const tokens: TokenSnapshot[] = response.data.pairs
      .filter((pair: any) => pair.baseToken && pair.quoteToken?.symbol === 'WSOL')
      .map((pair: any) => ({
        address: pair.baseToken.address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        price: parseFloat(pair.priceUsd || 0),
        volume24h: parseFloat(pair.volume?.h24 || 0),
        marketCap: parseFloat(pair.marketCap || 0),
        liquidity: parseFloat(pair.liquidity?.usd || 0),
        priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
        timestamp: Date.now(),
      }))
      .slice(0, 100); // Top 100

    return tokens;
  } catch (error) {
    console.error('❌ Error fetching tokens:', error);
    return [];
  }
}

// Calculate Z-score for a metric
function calculateZScore(current: number, historical: number[]): number {
  if (historical.length === 0) return 0;
  
  const mean = historical.reduce((a, b) => a + b, 0) / historical.length;
  const variance = historical.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / historical.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;
  return (current - mean) / stdDev;
}

// Detect anomalies in token
function detectAnomalies(token: TokenSnapshot, history: TokenSnapshot[]): AnomalyDetection {
  const anomalies: string[] = [];

  // Calculate Z-scores based on token's own history (not global)
  const volumes = history.map(t => t.volume24h);
  const prices = history.map(t => t.price);
  const marketCaps = history.map(t => t.marketCap);
  const liquidities = history.map(t => t.liquidity);

  const volumeZScore = calculateZScore(token.volume24h, volumes);
  const priceZScore = calculateZScore(token.price, prices);
  const marketCapZScore = calculateZScore(token.marketCap, marketCaps);
  const liquidityZScore = calculateZScore(token.liquidity, liquidities);

  // Detect anomalies
  if (volumeZScore >= 2.0) anomalies.push(`Volume spike: Z=${volumeZScore.toFixed(2)}`);
  if (priceZScore >= 2.0) anomalies.push(`Price anomaly: Z=${priceZScore.toFixed(2)}`);
  if (marketCapZScore >= 2.0) anomalies.push(`Market cap change: Z=${marketCapZScore.toFixed(2)}`);
  if (liquidityZScore >= 2.0) anomalies.push(`Liquidity anomaly: Z=${liquidityZScore.toFixed(2)}`);

  // Determine level
  const maxZScore = Math.max(volumeZScore, priceZScore, marketCapZScore, liquidityZScore);
  let level: 'watch' | 'alert' | 'critical' = 'watch';
  if (maxZScore >= 3.0) level = 'critical';
  else if (maxZScore >= 2.5) level = 'alert';

  return {
    token,
    zScores: { volume: volumeZScore, price: priceZScore, marketCap: marketCapZScore, liquidity: liquidityZScore },
    maxZScore,
    level,
    anomalies,
  };
}

// Save snapshot to database
async function saveSnapshot(token: TokenSnapshot, detection: AnomalyDetection) {
  try {
    await supabase.from('token_snapshots').insert({
      token_address: token.address,
      token_name: token.name,
      token_symbol: token.symbol,
      price: token.price,
      volume_24h: token.volume24h,
      market_cap: token.marketCap,
      liquidity: token.liquidity,
      price_change_24h: token.priceChange24h,
      z_score_volume: detection.zScores.volume,
      z_score_price: detection.zScores.price,
      z_score_market_cap: detection.zScores.marketCap,
      z_score_liquidity: detection.zScores.liquidity,
      max_z_score: detection.maxZScore,
      anomaly_level: detection.level,
      anomalies: detection.anomalies.join(' | '),
      created_at: new Date(token.timestamp).toISOString(),
    });
  } catch (error) {
    console.error('Error saving snapshot:', error);
  }
}

// Send Telegram alert
async function sendAlert(detection: AnomalyDetection) {
  const emoji = detection.level === 'critical' ? '🔴' : detection.level === 'alert' ? '🟡' : '🔵';
  
  const message = `
${emoji} ${detection.level.toUpperCase()} ANOMALY DETECTED

Token: ${detection.token.name} ($${detection.token.symbol})
Address: \`${detection.token.address}\`

📊 Metrics:
- Price: $${detection.token.price.toFixed(6)}
- Volume 24h: $${(detection.token.volume24h / 1000000).toFixed(2)}M
- Market Cap: $${(detection.token.marketCap / 1000000).toFixed(2)}M
- Liquidity: $${(detection.token.liquidity / 1000).toFixed(2)}K
- Price Change 24h: ${detection.token.priceChange24h.toFixed(2)}%

📈 Z-Scores:
- Volume: ${detection.zScores.volume.toFixed(2)}
- Price: ${detection.zScores.price.toFixed(2)}
- Market Cap: ${detection.zScores.marketCap.toFixed(2)}
- Liquidity: ${detection.zScores.liquidity.toFixed(2)}

🎯 Anomalies:
${detection.anomalies.map(a => `• ${a}`).join('\n')}

🔗 [Dexscreener](https://dexscreener.com/solana/${detection.token.address}) | [Raydium](https://raydium.io/swap/?inputCurrency=${detection.token.address}) | [Solscan](https://solscan.io/token/${detection.token.address})
`;

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Alert sent for ${detection.token.symbol} (Level: ${detection.level}, Z: ${detection.maxZScore.toFixed(2)})`);
  } catch (error) {
    console.error('Error sending Telegram alert:', error);
  }
}

// Main listener cycle
async function runListener() {
  try {
    console.log(`⏰ [${new Date().toISOString()}] Starting scan...`);
    
    // Fetch current tokens
    const currentTokens = await fetchTopTokens();
    
    if (currentTokens.length === 0) {
      console.log('❌ No tokens fetched');
      return;
    }

    console.log(`✅ Fetched ${currentTokens.length} tokens`);

    let watchCount = 0;
    let alertsSent = 0;

    for (const token of currentTokens) {
      try {
        // Get historical data for this specific token
        const history = lastSnapshots.get(token.address) || [];
        
        // If we have history, detect anomalies
        if (history.length > 0) {
          const detection = detectAnomalies(token, history);
          
          // Save snapshot
          await saveSnapshot(token, detection);

          // Log all Z-scores for backtesting
          if (detection.maxZScore >= 2.0) {
            console.log(`  📊 ${token.symbol}: Z=${detection.maxZScore.toFixed(2)} (${detection.level})`);
            watchCount++;
          }

          // Send alert if notable or critical
          if (detection.level === 'alert' || detection.level === 'critical') {
            await sendAlert(detection);
            alertsSent++;
            alertCount++;
          }
        } else {
          // First time seeing this token, just save it
          const initialDetection: AnomalyDetection = {
            token,
            zScores: { volume: 0, price: 0, marketCap: 0, liquidity: 0 },
            maxZScore: 0,
            level: 'watch',
            anomalies: ['Initial snapshot'],
          };
          await saveSnapshot(token, initialDetection);
        }

        // Keep last 10 snapshots for this token
        const tokenHistory = lastSnapshots.get(token.address) || [];
        tokenHistory.push(token);
        if (tokenHistory.length > 10) tokenHistory.shift();
        lastSnapshots.set(token.address, tokenHistory);

        processingCount++;
      } catch (error) {
        console.error(`Error processing ${token.symbol}:`, error);
      }
    }

    console.log(`✅ Cycle complete. Watched: ${watchCount}, Alerts sent: ${alertsSent}, Total processed: ${processingCount}`);
  } catch (error) {
    console.error('❌ Listener error:', error);
  }
}

// Startup
console.log('🚀 Solana Anomaly Detector Starting...');
console.log(`⚙️ Interval: ${process.env.LISTENER_INTERVAL_MS}ms (${parseInt(process.env.LISTENER_INTERVAL_MS || '300000') / 1000 / 60} minutes)`);
console.log('📊 Tracking: Top 100 Solana tokens by volume');
console.log('🎯 Z-Score Levels:');
console.log('   - Z ≥ 2.0: Watch (log only)');
console.log('   - Z ≥ 2.5: Alert (analysis + Telegram)');
console.log('   - Z ≥ 3.0: Critical (high priority)');
console.log('');

// Run immediately
runListener().catch(console.error);

// Schedule recurring cycles
const interval = parseInt(process.env.LISTENER_INTERVAL_MS || '300000');
const minutes = Math.floor(interval / 1000 / 60);
const cronExpression = `*/${minutes} * * * *`;

cron.schedule(cronExpression, () => {
  runListener().catch(console.error);
});

console.log(`✅ Listener scheduled. Runs every ${minutes} minutes`);
