import { config } from './config.js';
import { hasHardBlocker } from './scoring.js';
import type {
  AlertLevel,
  DetectionState,
  Evaluation,
  Notification,
} from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const levelRank = (level: AlertLevel): number => (level === 'critical' ? 2 : 1);

/**
 * Gère le cycle de vie des détections :
 * - une détection s'ouvre quand un token atteint le niveau alerte ou critique ;
 * - elle reste active tant que le score ne retombe pas durablement (anti-clignotement) ;
 * - une fois terminée, elle reste suivie 24 h pour mesurer ce que le prix a fait ensuite.
 */
export class DetectionManager {
  private byAddress = new Map<string, DetectionState>();

  load(states: DetectionState[]): void {
    for (const state of states) {
      const existing = this.byAddress.get(state.address);
      if (!existing || state.detectedAt > existing.detectedAt) {
        this.byAddress.set(state.address, state);
      }
    }
  }

  get all(): DetectionState[] {
    return [...this.byAddress.values()];
  }

  isActive(address: string): boolean {
    return this.byAddress.get(address)?.status === 'active';
  }

  /** Tokens dont on doit connaître le prix (détections de moins de 24 h). */
  trackedAddresses(now: number): string[] {
    return this.all
      .filter(d => now - d.detectedAt <= config.trackingHours * HOUR)
      .map(d => d.address);
  }

  process(
    evaluations: Map<string, Evaluation>,
    prices: Map<string, number>,
    now: number
  ): Notification[] {
    const notifications: Notification[] = [];

    // 1. Entrées et maintiens
    for (const [address, evaluation] of evaluations) {
      const existing = this.byAddress.get(address);
      const entering = evaluation.level === 'alert' || evaluation.level === 'critical';

      if (entering) {
        const level = evaluation.level as AlertLevel;

        if (existing?.status === 'active') {
          const upgraded = levelRank(level) > levelRank(existing.peakLevel);
          this.refresh(existing, evaluation, now, level);
          if (upgraded) notifications.push({ kind: 'upgrade', detection: existing });
          continue;
        }

        const canReopen =
          existing?.status === 'ended' &&
          existing.endedAt !== null &&
          now - existing.endedAt <= config.reopenWindowMinutes * MINUTE;

        if (existing && canReopen) {
          const upgraded = levelRank(level) > levelRank(existing.peakLevel);
          existing.status = 'active';
          existing.endedAt = null;
          existing.reentries += 1;
          this.refresh(existing, evaluation, now, level);
          if (upgraded) notifications.push({ kind: 'reopen', detection: existing });
          continue;
        }

        const created = this.create(evaluation, level, now);
        this.byAddress.set(address, created);
        notifications.push({ kind: 'new', detection: created });
        continue;
      }

      // Pas de nouvelle entrée : la détection active tient-elle encore ?
      if (existing?.status === 'active') {
        const stillStrong =
          evaluation.score >= config.exitScore && !hasHardBlocker(evaluation);
        if (stillStrong) {
          existing.belowCount = 0;
          existing.score = evaluation.score;
          existing.lastActiveAt = now;
          existing.marketCap = evaluation.snapshot.marketCap;
          existing.liquidity = evaluation.snapshot.liquidity;
          existing.dirty = true;
        } else {
          existing.score = evaluation.score;
          this.markBelow(existing, now, hasHardBlocker(evaluation));
        }
      }
    }

    // 2. Détections actives dont le token n'a pas été évalué (sorti de la liste)
    for (const detection of this.all) {
      if (detection.status === 'active' && !evaluations.has(detection.address)) {
        this.markBelow(detection, now, false);
      }
    }

    // 3. Suivi des prix après détection
    for (const detection of this.all) {
      const price = prices.get(detection.address);
      if (price !== undefined) this.trackPrice(detection, price, now);
    }

    // 4. Nettoyage mémoire
    for (const detection of this.all) {
      const tooOld = now - detection.detectedAt > (config.trackingHours + 1) * HOUR;
      if (detection.status === 'ended' && tooOld && !detection.dirty) {
        this.byAddress.delete(detection.address);
      }
    }

    return notifications;
  }

  /** Détections à écrire en base à ce scan. */
  pendingWrites(now: number): DetectionState[] {
    return this.all.filter(d => {
      if (!d.dirty) return false;
      if (d.id === null || d.status === 'active') return true;
      // Détections terminées : on limite les écritures (et donc l'egress) à une toutes les 15 min
      return now - d.lastPersistAt >= 15 * MINUTE;
    });
  }

  markPersisted(detection: DetectionState, now: number): void {
    detection.dirty = false;
    detection.lastPersistAt = now;
  }

  // ----------------------------------------------------------

  private create(evaluation: Evaluation, level: AlertLevel, now: number): DetectionState {
    const snap = evaluation.snapshot;
    return {
      id: null,
      address: snap.address,
      symbol: snap.symbol,
      name: snap.name,
      status: 'active',
      level,
      peakLevel: level,
      score: evaluation.score,
      peakScore: evaluation.score,
      detectedAt: now,
      lastActiveAt: now,
      endedAt: null,
      belowCount: 0,
      reentries: 0,
      priceAtDetection: snap.price,
      lastPrice: snap.price,
      maxPrice: snap.price,
      minPrice: snap.price,
      price15m: null,
      price1h: null,
      price4h: null,
      price24h: null,
      hitUpAt: null,
      hitDownAt: null,
      outcome: 'pending',
      marketCap: snap.marketCap,
      liquidity: snap.liquidity,
      ageHours: evaluation.ageHours,
      securityOk: evaluation.security?.ok ?? null,
      securityFlags: [
        ...(evaluation.security?.hardFlags ?? []),
        ...(evaluation.security?.softFlags ?? []),
      ],
      families: evaluation.families,
      reasons: evaluation.reasons,
      warnings: evaluation.warnings,
      dirty: true,
      lastPersistAt: 0,
    };
  }

  private refresh(
    detection: DetectionState,
    evaluation: Evaluation,
    now: number,
    level: AlertLevel
  ): void {
    detection.level = level;
    if (levelRank(level) > levelRank(detection.peakLevel)) detection.peakLevel = level;
    detection.score = evaluation.score;
    detection.peakScore = Math.max(detection.peakScore, evaluation.score);
    detection.lastActiveAt = now;
    detection.belowCount = 0;
    detection.marketCap = evaluation.snapshot.marketCap;
    detection.liquidity = evaluation.snapshot.liquidity;
    detection.ageHours = evaluation.ageHours;
    detection.families = evaluation.families;
    detection.reasons = evaluation.reasons;
    detection.warnings = evaluation.warnings;
    if (evaluation.security) {
      detection.securityOk = evaluation.security.ok;
      detection.securityFlags = [
        ...evaluation.security.hardFlags,
        ...evaluation.security.softFlags,
      ];
    }
    detection.dirty = true;
  }

  private markBelow(detection: DetectionState, now: number, immediate: boolean): void {
    detection.belowCount += 1;
    if (immediate || detection.belowCount >= config.exitScans) {
      detection.status = 'ended';
      detection.endedAt = now;
      detection.lastPersistAt = 0; // la fin d'une détection s'écrit tout de suite
    }
    detection.dirty = true;
  }

  private trackPrice(detection: DetectionState, price: number, now: number): void {
    const elapsed = now - detection.detectedAt;
    if (elapsed > (config.trackingHours + 1) * HOUR || price <= 0) return;

    const p0 = detection.priceAtDetection;
    detection.lastPrice = price;
    detection.maxPrice = Math.max(detection.maxPrice, price);
    detection.minPrice = Math.min(detection.minPrice, price);

    // Jalons : premier prix observé après chaque délai (écrits tout de suite)
    const before = `${detection.price15m}|${detection.price1h}|${detection.price4h}|${detection.price24h}|${detection.outcome}`;
    if (detection.price15m === null && elapsed >= 15 * MINUTE) detection.price15m = price;
    if (detection.price1h === null && elapsed >= HOUR) detection.price1h = price;
    if (detection.price4h === null && elapsed >= 4 * HOUR) detection.price4h = price;
    if (detection.price24h === null && elapsed >= 24 * HOUR) detection.price24h = price;

    // Résultat : +20 % atteint avant -15 % dans les 4 heures (réglable)
    if (elapsed <= config.outcomeWindowHours * HOUR) {
      const change = (price / p0 - 1) * 100;
      if (detection.hitUpAt === null && change >= config.winThresholdPercent) {
        detection.hitUpAt = now;
      }
      if (detection.hitDownAt === null && change <= -config.lossThresholdPercent) {
        detection.hitDownAt = now;
      }
    }

    if (detection.outcome === 'pending') {
      if (detection.hitUpAt !== null && (detection.hitDownAt === null || detection.hitUpAt <= detection.hitDownAt)) {
        detection.outcome = 'win';
      } else if (detection.hitDownAt !== null) {
        detection.outcome = 'loss';
      } else if (elapsed > config.outcomeWindowHours * HOUR) {
        detection.outcome = 'flat';
      }
    }

    const after = `${detection.price15m}|${detection.price1h}|${detection.price4h}|${detection.price24h}|${detection.outcome}`;
    if (after !== before) detection.lastPersistAt = 0;
    detection.dirty = true;
  }
}
