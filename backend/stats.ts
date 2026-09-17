// ============================================================
// Statistiques robustes
// Les volumes de memecoins ont des pics énormes : la moyenne et
// l'écart-type classiques sont faussés par ces pics. La médiane
// et la MAD (écart absolu médian) y sont insensibles.
// ============================================================

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Z-score robuste : (valeur - médiane) / (1.4826 × MAD).
 * Le facteur 1.4826 rend la MAD comparable à un écart-type.
 * Retourne 0 s'il n'y a pas assez de points ou si la série est plate.
 */
export function robustZ(current: number, history: number[], minPoints = 8): number {
  const values = history.filter(Number.isFinite);
  if (values.length < minPoints || !Number.isFinite(current)) return 0;

  const center = median(values);
  let scale = 1.4826 * median(values.map(v => Math.abs(v - center)));

  if (scale < 1e-9) {
    // Série très plate (beaucoup de valeurs identiques) : repli sur l'écart moyen
    scale = 1.2533 * mean(values.map(v => Math.abs(v - center)));
  }
  if (scale < 1e-9) return 0;

  const z = (current - center) / scale;
  return Math.max(-10, Math.min(10, z));
}

/** Transformation log pour les volumes et les nombres de transactions. */
export function logValue(value: number): number {
  return Math.log1p(Math.max(0, value));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Rang percentile (0 à 1) de `value` dans `sortedValues` (triées croissant). */
export function percentileRank(sortedValues: number[], value: number): number {
  if (sortedValues.length === 0) return 0.5;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below++;
    else break;
  }
  return below / sortedValues.length;
}

export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

export function percentChange(current: number, previous: number): number | null {
  const r = ratio(current, previous);
  return r === null ? null : (r - 1) * 100;
}
