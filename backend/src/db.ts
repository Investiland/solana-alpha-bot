import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, secrets } from './config.js';
import type {
  DetectionState,
  Evaluation,
  Families,
  HistoryPoint,
  SecurityInfo,
  TokenMeta,
} from './types.js';

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeOrNull(value: unknown): number | null {
  if (!value) return null;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// Colonnes strictement nécessaires : on ne fait plus jamais de select('*')
const HISTORY_COLUMNS =
  'token_address,created_at,price,volume_5m,volume_1h,trades_5m,price_change_5m,price_change_1h,liquidity,holders';

export class Database {
  private client: SupabaseClient | null;

  constructor() {
    this.client = config.dryRun
      ? null
      : createClient(secrets.supabaseUrl, secrets.supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Charge l'historique récent d'un ensemble de tokens, UNE seule fois
   * (au démarrage ou quand un nouveau token apparaît). Ensuite tout se
   * passe en mémoire : c'est ce qui supprime le problème d'egress.
   */
  async loadHistory(addresses: string[], sinceMs: number): Promise<Map<string, HistoryPoint[]>> {
    const result = new Map<string, HistoryPoint[]>();
    if (!this.client || addresses.length === 0) return result;

    const pageSize = 1000;
    for (let i = 0; i < addresses.length; i += 50) {
      const chunk = addresses.slice(i, i + 50);
      let from = 0;
      while (true) {
        const { data, error } = await this.client
          .from('token_snapshots')
          .select(HISTORY_COLUMNS)
          .in('token_address', chunk)
          .gte('created_at', new Date(sinceMs).toISOString())
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('❌ Lecture historique :', error.message);
          break;
        }
        const rows = data ?? [];
        for (const row of rows as any[]) {
          const list = result.get(row.token_address) ?? [];
          list.push({
            t: timeOrNull(row.created_at) ?? 0,
            price: num(row.price),
            volume5m: num(row.volume_5m),
            volume1h: num(row.volume_1h),
            trades5m: num(row.trades_5m),
            priceChange5m: num(row.price_change_5m),
            priceChange1h: num(row.price_change_1h),
            liquidity: num(row.liquidity),
            holders: numOrNull(row.holders),
          });
          result.set(row.token_address, list);
        }
        if (rows.length < pageSize) break;
        from += pageSize;
      }
    }
    return result;
  }

  async loadTokenMeta(addresses: string[]): Promise<Map<string, TokenMeta>> {
    const result = new Map<string, TokenMeta>();
    if (!this.client || addresses.length === 0) return result;

    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const { data, error } = await this.client
        .from('tokens')
        .select(
          'token_address,created_at,listing_time,security_checked_at,security_ok,security_flags,security_soft_flags,top10_percent'
        )
        .in('token_address', chunk);

      if (error) {
        console.error('❌ Lecture tokens :', error.message);
        continue;
      }
      for (const row of (data ?? []) as any[]) {
        const checkedAt = timeOrNull(row.security_checked_at);
        const security: SecurityInfo | null =
          checkedAt !== null && row.security_ok !== null
            ? {
                checkedAt,
                ok: Boolean(row.security_ok),
                hardFlags: Array.isArray(row.security_flags) ? row.security_flags : [],
                softFlags: Array.isArray(row.security_soft_flags) ? row.security_soft_flags : [],
                top10Share: numOrNull(row.top10_percent),
                creationTimeMs: timeOrNull(row.created_at),
              }
            : null;
        result.set(row.token_address, {
          createdAtMs: timeOrNull(row.created_at),
          listingTimeMs: timeOrNull(row.listing_time),
          security,
        });
      }
    }
    return result;
  }

  async upsertTokens(
    rows: Array<{
      address: string;
      name: string;
      symbol: string;
      createdAtMs: number | null;
      listingTimeMs: number | null;
      security: SecurityInfo | null;
    }>
  ): Promise<void> {
    if (!this.client || rows.length === 0) return;
    const now = new Date().toISOString();

    // On n'envoie jamais une valeur vide qui écraserait une info déjà connue.
    // Les lignes sont regroupées par ensemble de colonnes identique.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const payload: Record<string, unknown> = {
        token_address: r.address,
        token_name: r.name,
        token_symbol: r.symbol,
        last_seen_at: now,
      };
      if (r.createdAtMs !== null) {
        payload.created_at = iso(r.createdAtMs);
        payload.creation_status = 'enriched';
      }
      if (r.listingTimeMs !== null) payload.listing_time = iso(r.listingTimeMs);
      if (r.security) {
        payload.security_checked_at = iso(r.security.checkedAt);
        payload.security_ok = r.security.ok;
        payload.security_flags = r.security.hardFlags;
        payload.security_soft_flags = r.security.softFlags;
        payload.top10_percent = r.security.top10Share;
      }
      const signature = Object.keys(payload).sort().join(',');
      const group = groups.get(signature) ?? [];
      group.push(payload);
      groups.set(signature, group);
    }

    for (const group of groups.values()) {
      const { error } = await this.client
        .from('tokens')
        .upsert(group, { onConflict: 'token_address' });
      if (error) console.error('❌ Écriture tokens :', error.message);
    }
  }

  async insertSnapshots(evaluations: Evaluation[]): Promise<void> {
    if (!this.client || evaluations.length === 0) return;
    const rows = evaluations.map(e => {
      const s = e.snapshot;
      const f = e.features;
      return {
        token_address: s.address,
        token_name: s.name,
        token_symbol: s.symbol,
        price: s.price,
        volume_24h: s.volume24h,
        volume_5m: s.volume5m,
        volume_1h: s.volume1h,
        market_cap: s.marketCap,
        liquidity: s.liquidity,
        price_change_24h: s.priceChange24h,
        price_change_5m: s.priceChange5m,
        price_change_1h: s.priceChange1h,
        trades_5m: s.trades5m,
        trades_1h: s.trades1h,
        holders: s.holders,
        buy_ratio_5m: e.buyRatio5m,
        unique_wallets_5m: e.flow?.uniqueWallets5m ?? null,
        z_score_volume_5m: round(f.zVolume5m),
        z_score_volume_1h: round(f.zVolume1h),
        z_score_price_5m: round(f.zPrice5m),
        z_score_price_1h: round(f.zPrice1h),
        z_score_trades_5m: round(f.zTrades5m),
        max_z_score: round(Math.max(f.zVolume5m, f.zVolume1h, f.zPrice5m, f.zTrades5m)),
        opportunity_score: e.score,
        anomaly_level: e.level,
        anomalies: e.level === 'watch' ? null : e.reasons.join(' | '),
        token_created_at: e.ageHours !== null
          ? new Date(s.timestamp - e.ageHours * 3_600_000).toISOString()
          : null,
        created_at: new Date(s.timestamp).toISOString(),
      };
    });

    const { error } = await this.client.from('token_snapshots').insert(rows);
    if (error) console.error('❌ Écriture snapshots :', error.message);
  }

  async loadRecentDetections(sinceMs: number): Promise<DetectionState[]> {
    if (!this.client) return [];
    const { data, error } = await this.client
      .from('detections')
      .select('*')
      .or(`status.eq.active,detected_at.gte.${new Date(sinceMs).toISOString()}`)
      .order('detected_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('❌ Lecture détections :', error.message);
      return [];
    }
    return ((data ?? []) as any[]).map(row => fromDetectionRow(row));
  }

  async saveDetection(d: DetectionState): Promise<boolean> {
    if (!this.client) return true;
    const row = toDetectionRow(d);

    if (d.id === null) {
      const { data, error } = await this.client
        .from('detections')
        .insert(row)
        .select('id')
        .single();
      if (error) {
        console.error(`❌ Création détection ${d.symbol} :`, error.message);
        return false;
      }
      d.id = Number(data.id);
      return true;
    }

    const { error } = await this.client.from('detections').update(row).eq('id', d.id);
    if (error) {
      console.error(`❌ Mise à jour détection ${d.symbol} :`, error.message);
      return false;
    }
    return true;
  }

  async purgeOldSnapshots(): Promise<void> {
    if (!this.client) return;
    const { data, error } = await this.client.rpc('purge_old_snapshots', {
      keep_days: config.snapshotRetentionDays,
    });
    if (error) {
      console.error('❌ Nettoyage des anciens snapshots :', error.message);
    } else {
      console.log(`🧹 ${data ?? 0} anciens snapshots supprimés (conservation ${config.snapshotRetentionDays} j)`);
    }
  }
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function toDetectionRow(d: DetectionState) {
  return {
    token_address: d.address,
    token_symbol: d.symbol,
    token_name: d.name,
    status: d.status,
    level: d.level,
    peak_level: d.peakLevel,
    score: d.score,
    peak_score: d.peakScore,
    detected_at: iso(d.detectedAt),
    last_active_at: iso(d.lastActiveAt),
    ended_at: iso(d.endedAt),
    below_count: d.belowCount,
    reentries: d.reentries,
    price_at_detection: d.priceAtDetection,
    last_price: d.lastPrice,
    max_price: d.maxPrice,
    min_price: d.minPrice,
    price_15m: d.price15m,
    price_1h: d.price1h,
    price_4h: d.price4h,
    price_24h: d.price24h,
    hit_up_at: iso(d.hitUpAt),
    hit_down_at: iso(d.hitDownAt),
    outcome: d.outcome,
    market_cap: d.marketCap,
    liquidity: d.liquidity,
    token_age_hours: d.ageHours === null ? null : round(d.ageHours, 1),
    security_ok: d.securityOk,
    security_flags: d.securityFlags,
    families: roundFamilies(d.families),
    reasons: d.reasons,
    warnings: d.warnings,
    updated_at: new Date().toISOString(),
  };
}

function roundFamilies(f: Families): Families {
  const out = { ...f };
  for (const key of Object.keys(out) as Array<keyof Families>) {
    const v = out[key];
    out[key] = v === null ? null : round(v, 2);
  }
  return out;
}

function fromDetectionRow(row: any): DetectionState {
  const families: Families = {
    flux: null,
    participation: null,
    activite: null,
    momentum: null,
    relatif: null,
    ...(row.families ?? {}),
  };
  const lastPersistAt = timeOrNull(row.updated_at) ?? Date.now();
  return {
    id: Number(row.id),
    address: row.token_address,
    symbol: row.token_symbol ?? '',
    name: row.token_name ?? '',
    status: row.status === 'active' ? 'active' : 'ended',
    level: row.level === 'critical' ? 'critical' : 'alert',
    peakLevel: row.peak_level === 'critical' ? 'critical' : 'alert',
    score: num(row.score),
    peakScore: num(row.peak_score),
    detectedAt: timeOrNull(row.detected_at) ?? Date.now(),
    lastActiveAt: timeOrNull(row.last_active_at) ?? Date.now(),
    endedAt: timeOrNull(row.ended_at),
    belowCount: num(row.below_count),
    reentries: num(row.reentries),
    priceAtDetection: num(row.price_at_detection),
    lastPrice: num(row.last_price ?? row.price_at_detection),
    maxPrice: num(row.max_price ?? row.price_at_detection),
    minPrice: num(row.min_price ?? row.price_at_detection),
    price15m: numOrNull(row.price_15m),
    price1h: numOrNull(row.price_1h),
    price4h: numOrNull(row.price_4h),
    price24h: numOrNull(row.price_24h),
    hitUpAt: timeOrNull(row.hit_up_at),
    hitDownAt: timeOrNull(row.hit_down_at),
    outcome: ['win', 'loss', 'flat'].includes(row.outcome) ? row.outcome : 'pending',
    marketCap: num(row.market_cap),
    liquidity: num(row.liquidity),
    ageHours: numOrNull(row.token_age_hours),
    securityOk: row.security_ok ?? null,
    securityFlags: Array.isArray(row.security_flags) ? row.security_flags : [],
    families,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    dirty: false,
    lastPersistAt,
  };
}
