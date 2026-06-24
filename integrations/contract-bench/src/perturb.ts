// perturb — deterministic, type-preserving substitution of measured values
// (durations, amounts, percentages) so the benchmark forces resolution FROM the
// documents rather than recall from pretraining. Same seed -> same output
// (regenerable); each distinct original value maps to one fake of the same type
// (cross-document references stay consistent). The mapping is returned so ground
// truth can be labeled against the fakes.

export interface PerturbResult {
  text: string;
  mapping: Record<string, string>;
}

// FNV-1a — a small deterministic string hash (no Date/random).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const DURATION = /\b(\d+)\s+(days?|months?|years?)\b/g;
const CURRENCY = /\$\d[\d,]*/g;

function perturbDurations(text: string, seed: number, mapping: Record<string, string>): string {
  return text.replace(DURATION, (m, num: string, unit: string) => {
    if (!mapping[m]) {
      const h = hashStr(`${m}:${seed}`);
      let n = 1 + (h % 240);
      if (n === Number(num)) n = n === 240 ? 1 : n + 1;
      mapping[m] = `${n} ${unit}`;
    }
    return mapping[m];
  });
}

function perturbCurrency(text: string, seed: number, mapping: Record<string, string>): string {
  return text.replace(CURRENCY, (m) => {
    if (!mapping[m]) {
      const digits = m.replace(/[$,]/g, "");
      const d = digits.length;
      const lo = d === 1 ? 0 : 10 ** (d - 1);
      const span = 10 ** d - lo; // keeps the digit count (magnitude) fixed
      const h = hashStr(`${m}:${seed}`);
      let n = lo + (h % span);
      if (String(n) === digits) n = n + 1 < lo + span ? n + 1 : lo;
      mapping[m] = `$${groupDigits(String(n))}`;
    }
    return mapping[m];
  });
}

export function perturbValues(
  text: string,
  seed: number,
  existing: Record<string, string> = {},
): PerturbResult {
  const mapping: Record<string, string> = { ...existing };
  let out = perturbDurations(text, seed, mapping);
  out = perturbCurrency(out, seed, mapping);
  return { text: out, mapping };
}
