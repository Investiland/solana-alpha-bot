import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import { Anthropic } from '@anthropic-ai/sdk';
import cron from 'node-cron';

// Init clients
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HELIUS_API_KEY = process.env.HELIUS_API_KEY!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const RPC_ENDPOINT = `https://api.helius.xyz/v0?api-key=${HELIUS_API_KEY}`;
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';

interface Token {
  address: string;
  name: string;
  symbol: string;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  holders: number;
  ageHours: number;
  top5HoldersPct: number;
  isMintable: boolean;
  isFreezeEnabled: boolean;
}

interface ScoringResult {
  totalScore: number;
  metrics: { velocityScore: number; holderScore: number; liquidityScore: number; volumeScore: number };
  risks: { rugRisk: string; mintableRisk: string; freezeRisk: string; concentrationRisk: string };
  recommendation: string;
}

// Config
const config = {
  minMarketCap: parseInt(process.env.MIN_MARKET_CAP || '1000000'),
  maxMarketCap: parseInt(process.env.MAX_MARKET_CAP || '10000000'),
  minLiquidity: parseInt(process.env.MIN_LIQUIDITY || '100000'),
  minHolders: parseInt(process.env.MIN_HOLDERS || '300'),
  minAgeHours: parseInt(process.env.MIN_AGE_HOURS || '48'),
  alertScoreThreshold: parseInt(process.env.ALERT_SCORE_THRESHOLD || '65'),
};

let processingCount = 0;
let alertCount = 0;

// Solana service
async function getSolanaTokens(): Promise<Token[]> {
  try {
    const response = await axios.post(RPC_ENDPOINT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'searchAssets',
      params: { page: 1, limit: 100, sortBy: 'created', sortDirection: 'desc' },
    });

    if (!response.data.result?.items) return [];

    const tokens: Token[] = [];
    for (const item of response.data.result.items.slice(0, 20)) {
      const dexData = await getDexData(item.id);
      const holderInfo = await getHolderInfo(item.id);
      const ageHours = await getTokenAge(item.id);

      if (dexData && holderInfo) {
        tokens.push({
          address: item.id,
          name: item.content?.metadata?.name || 'Unknown',
          symbol: item.content?.metadata?.symbol || 'Unknown',
          marketCap: dexData.marketCap || 0,
          liquidity: dexData.liquidity || 0,
          volume24h: dexData.volume24h || 0,
          holders: holderInfo.holders,
          ageHours,
          top5HoldersPct: holderInfo.top5Pct,
          isMintable: item.token_info?.is_mintable || false,
          isFreezeEnabled: item.token_info?.is_freezeable || false,
        });
      }
    }

    return tokens;
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return [];
  }
}

async function getDexData(tokenAddress: string) {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/tokens/solana/${tokenAddress}`);
    if (response.data?.pairs?.length > 0) {
      const pair = response.data.pairs[0];
      return {
        marketCap: parseFloat(pair.marketCap || 0),
        liquidity: parseFloat(pair.liquidity?.usd || 0),
        volume24h: parseFloat(pair.volume?.h24 || 0),
      };
    }
  } catch (error) {}
  return null;
}

async function getHolderInfo(tokenAddress: string) {
  try {
    const response = await axios.post(RPC_ENDPOINT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [tokenAddress],
    });

    if (response.data.result?.value) {
      const accounts = response.data.result.value;
      const totalSupply = accounts.reduce((sum: number, acc: any) => sum + parseFloat(acc.uiAmount || 0), 0);
      const top5Amount = accounts
        .slice(0, 5)
        .reduce((sum: number, acc: any) => sum + parseFloat(acc.uiAmount || 0), 0);
      const top5Pct = totalSupply > 0 ? (top5Amount / totalSupply) * 100 : 0;

      return { holders: accounts.length, top5Pct };
    }
  } catch (error) {}
  return null;
}

async function getTokenAge(tokenAddress: string): Promise<number> {
  try {
    const response = await axios.post(RPC_ENDPOINT, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [tokenAddress, { limit: 1 }],
    });

    if (response.data.result?.length > 0) {
      const blockTime = response.data.result[0].blockTime;
      const ageMs = Date.now() - blockTime * 1000;
      return Math.floor(ageMs / (1000 * 3600));
    }
  } catch (error) {}
  return 0;
}

// Scoring
function scoreToken(token: Token): ScoringResult {
  const velocityScore = token.volume24h / Math.max(token.liquidity, 1) > 5 ? 100 : token.volume24h / Math.max(token.liquidity, 1) > 3 ? 85 : 50;
  const holderScore = token.holders > 1000 ? 100 : token.holders > 500 ? 90 : token.holders > 300 ? 75 : 50;
  const liquidityScore = token.liquidity > 500000 ? 100 : token.liquidity > 250000 ? 90 : token.liquidity > 100000 ? 70 : 50;
  const volumeScore = token.volume24h > 1000000 ? 100 : token.volume24h > 500000 ? 90 : token.volume24h > 100000 ? 70 : 50;

  let riskScore = 0;
  if (token.top5HoldersPct > 75) riskScore += 40;
  else if (token.top5HoldersPct > 60) riskScore += 25;
  else if (token.top5HoldersPct > 50) riskScore += 15;
  if (token.isMintable) riskScore += 20;
  if (token.isFreezeEnabled) riskScore += 20;
  if (token.ageHours < 72) riskScore += 10;

  const baseScore = Math.round(velocityScore * 0.35 + holderScore * 0.25 + liquidityScore * 0.2 + volumeScore * 0.2 - riskScore * 0.1);
  const totalScore = Math.min(100, Math.max(0, baseScore));

  const rugRisk = token.top5HoldersPct > 70 ? 'HIGH' : token.top5HoldersPct > 50 ? 'MEDIUM' : 'LOW';
  const mintableRisk = token.isMintable ? 'HIGH' : 'LOW';
  const freezeRisk = token.isFreezeEnabled ? 'HIGH' : 'LOW';
  const concentrationRisk = token.top5HoldersPct > 60 ? 'HIGH' : token.top5HoldersPct > 40 ? 'MEDIUM' : 'LOW';

  const recommendation =
    rugRisk === 'HIGH' || mintableRisk === 'HIGH' || freezeRisk === 'HIGH'
      ? 'HIGH_RISK_SKIP'
      : totalScore >= 80
        ? 'STRONG_BUY'
        : totalScore >= 70
          ? 'BUY'
          : totalScore >= 60
            ? 'WATCH'
            : 'CAUTION';

  return {
    totalScore,
    metrics: { velocityScore, holderScore, liquidityScore, volumeScore },
    risks: { rugRisk, mintableRisk, freezeRisk, concentrationRisk },
    recommendation,
  };
}

// Telegram alert
async function sendAlert(token: Token, score: ScoringResult) {
  const message = `
🚀 ALPHA SIGNAL

Token: ${token.name} ($${token.symbol})
Score: ${score.totalScore}/100
Recommendation: ${score.recommendation}

💰 Metrics:
- Market Cap: $${(token.marketCap / 1000000).toFixed(2)}M
- Liquidity: $${(token.liquidity / 1000).toFixed(2)}K
- Volume 24h: $${(token.volume24h / 1000).toFixed(2)}K
- Holders: ${token.holders}
- Age: ${token.ageHours}h

📈 Breakdown:
- Velocity: ${Math.round(score.metrics.velocityScore)}/100
- Holders: ${Math.round(score.metrics.holderScore)}/100
- Liquidity: ${Math.round(score.metrics.liquidityScore)}/100
- Volume: ${Math.round(score.metrics.volumeScore)}/100

⚠️ Risks:
- Rug Risk: ${score.risks.rugRisk}
- Mintable: ${score.risks.mintableRisk}
- Freeze: ${score.risks.freezeRisk}

🔗 [Dexscreener](https://dexscreener.com/solana/${token.address})
`;

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Alert sent for ${token.symbol}`);
  } catch (error) {
    console.error('Error sending Telegram alert:', error);
  }
}

// Main listener
async function runListener() {
  console.log('🔍 Fetching Solana tokens...');
  const tokens = await getSolanaTokens();

  if (tokens.length === 0) {
    console.log('No new tokens found');
    return;
  }

  console.log(`Found ${tokens.length} tokens`);

  for (const token of tokens) {
    try {
      // Filter
      if (
        token.marketCap < config.minMarketCap ||
        token.marketCap > config.maxMarketCap ||
        token.liquidity < config.minLiquidity ||
        token.holders < config.minHolders ||
        token.ageHours < config.minAgeHours
      ) {
        continue;
      }

      // Check if already exists
      const { data: existing } = await supabase.from('alerts').select('id').eq('token_address', token.address).single();
      if (existing) continue;

      // Score
      const score = scoreToken(token);

      // Save to DB
      await supabase.from('alerts').insert({
        token_address: token.address,
        score: score.totalScore,
        on_chain_metrics: score.metrics,
        risks: score.risks,
        status: 'new',
      });

      processingCount++;

      // Alert if score high enough
      if (score.totalScore >= config.alertScoreThreshold && score.recommendation !== 'HIGH_RISK_SKIP') {
        await sendAlert(token, score);
        alertCount++;
      }
    } catch (error) {
      console.error(`Error processing token:`, error);
    }
  }

  console.log(`✅ Cycle complete. Total processed: ${processingCount}, Alerts sent: ${alertCount}`);
}

// Start
console.log('🚀 Solana Alpha Listener Starting...');
console.log(`⚙️ Interval: ${process.env.LISTENER_INTERVAL_MS}ms`);

// Run immediately
runListener().catch(console.error);

// Schedule
const interval = parseInt(process.env.LISTENER_INTERVAL_MS || '300000');
const cronExpression = `*/${Math.floor(interval / 1000 / 60)} * * * *`;

cron.schedule(cronExpression, () => {
  runListener().catch(console.error);
});

console.log('✅ Listener running');
