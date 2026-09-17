import axios, { AxiosInstance } from 'axios';
import { config, secrets } from './config.js';
import type { FlowInfo, MarketSnapshot, SecurityInfo } from './types.js';

// Coût en CU (compute units) indiqué par la documentation Birdeye.
// Sert uniquement à afficher une estimation de consommation dans les logs.
const CU_COST = {
  list: 50,
  overview: 15,
  security: 25,
  multiPrice: 10,
} as const;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Les pourcentages Birdeye sont des fractions (0.30 = 30 %) ; on accepte aussi 30. */
function toShare(value: unknown): number | null {
  const n = numOrNull(value);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

export class BirdeyeClient {
  private http: AxiosInstance;
  private lastCallAt = 0;
  private cuToday = 0;
  private cuDay = new Date().toISOString().slice(0, 10);
  private rateLimitedUntil = 0;
  private loggedListShape = false;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.BIRDEYE_BASE_URL || 'https://public-api.birdeye.so',
      timeout: config.requestTimeoutMs,
      headers: {
        'X-API-KEY': secrets.birdeyeKey,
        'x-chain': 'solana',
        accept: 'application/json',
      },
    });
  }

  get estimatedCuToday(): number {
    return this.cuToday;
  }

  private addCu(amount: number): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.cuDay) {
      console.log(`💳 Birdeye : environ ${this.cuToday} CU consommés le ${this.cuDay}`);
      this.cuDay = today;
      this.cuToday = 0;
    }
    this.cuToday += amount;
  }

  private async get<T = any>(path: string, params: Record<string, unknown>, cu: number): Promise<T | null> {
    if (Date.now() < this.rateLimitedUntil) return null;

    const wait = this.lastCallAt + config.birdeyeMinDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();

    try {
      const response = await this.http.get(path, { params });
      this.addCu(cu);
      if (response.data?.success === false) {
        console.warn(`⚠️ Birdeye ${path} : ${response.data?.message ?? 'réponse en échec'}`);
        return null;
      }
      return response.data?.data ?? null;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 429) {
          const retryAfter = Number(error.response?.headers?.['retry-after']);
          const pauseMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
          this.rateLimitedUntil = Date.now() + pauseMs;
          console.error(`⛔ Birdeye limite atteinte (429) sur ${path}, pause ${Math.round(pauseMs / 1000)} s`);
        } else if (status === 401 || status === 403) {
          console.error(`⛔ Birdeye refuse l'accès à ${path} (${status}) : clé invalide ou endpoint hors de ton plan`);
        } else {
          console.error(`❌ Birdeye ${path} : ${status ?? ''} ${error.message}`);
        }
      } else {
        console.error(`❌ Birdeye ${path} :`, error);
      }
      return null;
    }
  }

  /** Univers de tokens : les plus actifs de la tranche de market cap. */
  async listUniverse(): Promise<MarketSnapshot[]> {
    const results: MarketSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < config.universePages; page++) {
      const data = await this.get<any>(
        '/defi/v3/token/list',
        {
          sort_by: config.universeSortBy,
          sort_type: 'desc',
          min_market_cap: config.minMarketCap,
          max_market_cap: config.maxMarketCap,
          min_liquidity: config.minLiquidity,
          min_volume_24h_usd: config.minVolume24h,
          limit: 100,
          offset: page * 100,
        },
        CU_COST.list
      );

      const items: any[] = Array.isArray(data?.items) ? data.items : [];

      if (!this.loggedListShape && items.length > 0) {
        this.loggedListShape = true;
        const keys = Object.keys(items[0]).sort().join(', ');
        console.log(`🧾 Champs reçus de Birdeye (une seule fois) : ${keys}`);
      }

      const now = Date.now();
      for (const item of items) {
        const address = typeof item.address === 'string' ? item.address : '';
        if (!address || seen.has(address)) continue;
        seen.add(address);

        const listingSeconds = numOrNull(item.recent_listing_time);

        results.push({
          address,
          name: typeof item.name === 'string' ? item.name : 'Unknown',
          symbol: typeof item.symbol === 'string' ? item.symbol : 'UNKNOWN',
          price: num(item.price),
          marketCap: num(item.market_cap),
          liquidity: num(item.liquidity),
          volume5m: num(item.volume_5m_usd),
          volume1h: num(item.volume_1h_usd),
          volume24h: num(item.volume_24h_usd),
          priceChange5m: num(item.price_change_5m_percent),
          priceChange1h: num(item.price_change_1h_percent),
          priceChange24h: num(item.price_change_24h_percent),
          trades5m: Math.trunc(num(item.trade_5m_count)),
          trades1h: Math.trunc(num(item.trade_1h_count)),
          holders: numOrNull(item.holder),
          listingTimeMs: listingSeconds && listingSeconds > 0 ? listingSeconds * 1000 : null,
          uniqueWallets24h: numOrNull(item.unique_wallet_24h),
          timestamp: now,
        });
      }

      const hasNext = Boolean(data?.has_next ?? data?.hasNext);
      if (!hasNext) break;
    }

    // Filet de sécurité : on revalide les filtres côté code
    return results.filter(
      t =>
        t.price > 0 &&
        t.marketCap >= config.minMarketCap &&
        t.marketCap <= config.maxMarketCap &&
        t.liquidity >= config.minLiquidity &&
        t.volume24h >= config.minVolume24h
    );
  }

  /** Achats/ventes et wallets uniques sur 5 min et 1 h. */
  async getFlow(address: string): Promise<FlowInfo | null> {
    const d = await this.get<any>(
      '/defi/token_overview',
      { address, frames: '5m,1h' },
      CU_COST.overview
    );
    if (!d) return null;

    const buy5m = numOrNull(d.vBuy5mUSD);
    const sell5m = numOrNull(d.vSell5mUSD);
    if (buy5m === null || sell5m === null) {
      console.warn(`⚠️ token_overview sans volumes achat/vente pour ${address}`);
      return null;
    }

    return {
      fetchedAt: Date.now(),
      buyVolume5m: buy5m,
      sellVolume5m: sell5m,
      buyVolume1h: num(d.vBuy1hUSD),
      sellVolume1h: num(d.vSell1hUSD),
      trades5m: num(d.trade5m),
      uniqueWallets5m: num(d.uniqueWallet5m),
      uniqueWalletsPrev5m: num(d.uniqueWalletHistory5m),
      uniqueWallets1h: num(d.uniqueWallet1h),
      uniqueWalletsPrev1h: num(d.uniqueWalletHistory1h),
    };
  }

  /** Contrôle de sécurité : autorités, concentration, faux token… */
  async getSecurity(address: string): Promise<SecurityInfo | null> {
    const d = await this.get<any>('/defi/token_security', { address }, CU_COST.security);
    if (!d) return null;

    const hardFlags: string[] = [];
    const softFlags: string[] = [];

    if (d.freezeable === true || (typeof d.freezeAuthority === 'string' && d.freezeAuthority)) {
      hardFlags.push('gel_des_comptes_possible');
    }
    if (typeof d.ownerAddress === 'string' && d.ownerAddress) {
      hardFlags.push('creation_de_tokens_possible');
    }
    if (d.transferFeeEnable === true) hardFlags.push('frais_de_transfert');
    if (d.nonTransferable === true) hardFlags.push('non_transferable');
    if (d.fakeToken === true) hardFlags.push('faux_token');

    const top10Share = toShare(d.top10UserPercent) ?? toShare(d.top10HolderPercent);
    if (top10Share !== null && top10Share > config.maxTop10HolderShare) {
      hardFlags.push(`top10_detient_${Math.round(top10Share * 100)}pct`);
    }

    if (d.mutableMetadata === true) softFlags.push('metadonnees_modifiables');
    const creatorShare = toShare(d.creatorPercentage);
    if (creatorShare !== null && creatorShare > 0.05) {
      softFlags.push(`createur_detient_${Math.round(creatorShare * 100)}pct`);
    }

    const creationSeconds = numOrNull(d.creationTime);

    return {
      checkedAt: Date.now(),
      ok: hardFlags.length === 0,
      hardFlags,
      softFlags,
      top10Share,
      creationTimeMs: creationSeconds && creationSeconds > 0 ? creationSeconds * 1000 : null,
    };
  }

  /** Prix de plusieurs tokens (sert au suivi des tokens sortis de la liste). */
  async getPrices(addresses: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const data = await this.get<any>(
        '/defi/multi_price',
        { list_address: chunk.join(',') },
        CU_COST.multiPrice * chunk.length
      );
      if (!data || typeof data !== 'object') continue;
      for (const address of chunk) {
        const entry = data[address];
        const value = numOrNull(entry?.value ?? entry?.price);
        if (value !== null && value > 0) prices.set(address, value);
      }
    }
    return prices;
  }
}
