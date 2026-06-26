// metrics — per-arm, per-bucket accuracy scoring and arm comparison.
//
// scoreArms takes the ground-truth QAs and a list of arm answer maps, and
// returns per-arm bucket accuracy, fabrication rate on no-value probes, and a
// pairwise verdict comparing two named arms on the scoped-current bucket.

import type { ContractQA, Bucket } from "./qa-build.js";

export interface ArmAnswers {
  arm: string; // arm identifier (e.g. "recency", "daftari")
  byClauseId: Record<string, string>; // qa.id -> answer string
}

export interface BucketStats {
  bucket: Bucket;
  total: number;
  correct: number;
  accuracy: number; // correct / total, or NaN if total === 0
}

export interface ArmResult {
  arm: string;
  buckets: BucketStats[];
  fabricationRate: number; // fraction of no-value probes where arm returned != "NOT_PRESENT"
  noValueTotal: number;
  noValueFabricated: number;
}

// "WIN" if armC is ≥ WIN_THRESHOLD better than armA on scoped-current accuracy;
// "INCONCLUSIVE" if the difference is < threshold but armC >= armA;
// "KILL" if armA >= armC (recency beats or ties daftari on the key bucket).
export const WIN_THRESHOLD = 0.2;

export type Verdict = "WIN" | "INCONCLUSIVE" | "KILL";

export interface PairwiseVerdict {
  armC: string;
  armA: string;
  armCAccuracy: number;
  armAAAccuracy: number;
  delta: number; // armC - armA on scoped-current
  verdict: Verdict;
}

export interface Summary {
  arms: ArmResult[];
  verdict: PairwiseVerdict | null; // null if fewer than 2 arms named
}

const BUCKETS: Bucket[] = ["scoped-current", "latest-current", "unamended", "no-value"];

function computeArmResult(arm: ArmAnswers, qas: ContractQA[]): ArmResult {
  const bucketMap = new Map<Bucket, { total: number; correct: number }>();
  for (const b of BUCKETS) bucketMap.set(b, { total: 0, correct: 0 });

  let noValueFabricated = 0;
  let noValueTotal = 0;

  for (const qa of qas) {
    const given = arm.byClauseId[qa.id] ?? "NOT_PRESENT";
    const bkt = bucketMap.get(qa.bucket)!;
    bkt.total += 1;
    if (given === qa.answer) bkt.correct += 1;

    if (qa.bucket === "no-value") {
      noValueTotal += 1;
      if (given !== "NOT_PRESENT") noValueFabricated += 1;
    }
  }

  const buckets: BucketStats[] = BUCKETS.map((b) => {
    const { total, correct } = bucketMap.get(b)!;
    return { bucket: b, total, correct, accuracy: total === 0 ? NaN : correct / total };
  });

  return {
    arm: arm.arm,
    buckets,
    fabricationRate: noValueTotal === 0 ? NaN : noValueFabricated / noValueTotal,
    noValueTotal,
    noValueFabricated,
  };
}

function scopedAccuracy(result: ArmResult): number {
  const s = result.buckets.find((b) => b.bucket === "scoped-current")!;
  return s.accuracy; // NaN if no scoped-current QAs
}

// Compare armC (Arm C, daftari) vs armA (Arm A, recency) on scoped-current.
// armCName / armAName are the `arm` identifier strings in the provided arms list.
export function compareArms(
  summary: Summary,
  armCName: string,
  armAName: string,
): PairwiseVerdict {
  const resC = summary.arms.find((a) => a.arm === armCName);
  const resA = summary.arms.find((a) => a.arm === armAName);
  if (!resC || !resA) throw new Error(`arm not found: ${armCName}, ${armAName}`);

  const accC = scopedAccuracy(resC);
  const accA = scopedAccuracy(resA);
  const delta = accC - accA;

  let verdict: Verdict;
  if (delta >= WIN_THRESHOLD) verdict = "WIN";
  else if (delta >= 0) verdict = "INCONCLUSIVE";
  else verdict = "KILL";

  return { armC: armCName, armA: armAName, armCAccuracy: accC, armAAAccuracy: accA, delta, verdict };
}

// Score all arms and (optionally) produce a pairwise verdict if armCName and
// armAName are provided and both appear in the arms list.
export function scoreArms(
  qas: ContractQA[],
  arms: ArmAnswers[],
  opts: { armC?: string; armA?: string } = {},
): Summary {
  const results = arms.map((a) => computeArmResult(a, qas));
  const summary: Summary = { arms: results, verdict: null };

  if (opts.armC && opts.armA) {
    const hasC = results.some((r) => r.arm === opts.armC);
    const hasA = results.some((r) => r.arm === opts.armA);
    if (hasC && hasA) {
      summary.verdict = compareArms(summary, opts.armC, opts.armA);
    }
  }

  return summary;
}
