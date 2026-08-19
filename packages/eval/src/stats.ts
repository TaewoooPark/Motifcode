/**
 * Paired non-inferiority, because "no statistically significant loss" is not a
 * finding.
 *
 * Failing to reject a difference proves nothing about equivalence. With a small
 * sample and a noisy metric it is the *expected* outcome even when the loss is
 * large, so a gate phrased that way passes most readily exactly when the
 * evidence is weakest — and a pruned model that dropped five points on a
 * hundred instances sails through it.
 *
 * The question worth asking is the other way round: is the candidate no worse
 * than the baseline by more than a margin someone committed to in advance? That
 * has an answer, and the answer can be no.
 *
 *     d_i = pass(candidate_i) - pass(baseline_i)   for each paired instance
 *     Δ   = mean(d_i)
 *     pass  iff  lower bound of the one-sided CI for Δ  >  -δ
 *
 * The margin δ is an input. This module will not invent one: without it, it
 * reports the difference and its interval and explicitly declines to say
 * whether quality was retained.
 */

export interface PairedOutcome {
  instanceId: string;
  seed: number;
  baseline: boolean;
  candidate: boolean;
}

export interface DiscordantCounts {
  bothPass: number;
  baselineOnly: number;
  candidateOnly: number;
  bothFail: number;
}

export interface PairedResult {
  n: number;
  baselineRate: number;
  candidateRate: number;
  /** Mean paired difference, candidate minus baseline, in proportion. */
  delta: number;
  /** One-sided lower bound at the requested confidence level, in proportion. */
  lowerBound: number;
  upperBound: number;
  confidenceLevel: number;
  counts: DiscordantCounts;
  bootstrapReplicates: number;
  bootstrapSeed: number;
}

export type Verdict =
  | { decided: true; nonInferior: boolean; marginPp: number; reason: string }
  | { decided: false; reason: string };

/** Deterministic PRNG. A bootstrap nobody can reproduce is not evidence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function discordant(pairs: readonly PairedOutcome[]): DiscordantCounts {
  const counts: DiscordantCounts = { bothPass: 0, baselineOnly: 0, candidateOnly: 0, bothFail: 0 };
  for (const p of pairs) {
    if (p.baseline && p.candidate) counts.bothPass++;
    else if (p.baseline && !p.candidate) counts.baselineOnly++;
    else if (!p.baseline && p.candidate) counts.candidateOnly++;
    else counts.bothFail++;
  }
  return counts;
}

export interface PairedOptions {
  confidenceLevel?: number;
  bootstrapReplicates?: number;
  bootstrapSeed?: number;
}

/**
 * Instance-level paired bootstrap.
 *
 * Resampling instances rather than observations, because the instances are the
 * independent unit: two seeds on the same SWE-bench task are two attempts at
 * one problem, and treating them as two independent data points understates the
 * uncertainty by roughly the square root of the number of seeds.
 */
export function pairedBootstrap(
  pairs: readonly PairedOutcome[],
  opts: PairedOptions = {},
): PairedResult {
  const confidenceLevel = opts.confidenceLevel ?? 0.95;
  const replicates = opts.bootstrapReplicates ?? 10_000;
  const seed = opts.bootstrapSeed ?? 20260820;

  // Cluster by instance first; seeds within an instance are averaged.
  const byInstance = new Map<string, PairedOutcome[]>();
  for (const p of pairs) {
    const list = byInstance.get(p.instanceId) ?? [];
    list.push(p);
    byInstance.set(p.instanceId, list);
  }
  const clusters = [...byInstance.values()].map((group) => {
    const b = group.filter((g) => g.baseline).length / group.length;
    const c = group.filter((g) => g.candidate).length / group.length;
    return { baseline: b, candidate: c, diff: c - b };
  });

  const n = clusters.length;
  const mean = (xs: readonly number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const delta = mean(clusters.map((c) => c.diff));
  const counts = discordant(pairs);

  if (n === 0) {
    return {
      n: 0,
      baselineRate: 0,
      candidateRate: 0,
      delta: 0,
      lowerBound: 0,
      upperBound: 0,
      confidenceLevel,
      counts,
      bootstrapReplicates: replicates,
      bootstrapSeed: seed,
    };
  }

  const rand = mulberry32(seed);
  const deltas: number[] = [];
  for (let r = 0; r < replicates; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += clusters[Math.floor(rand() * n)]!.diff;
    }
    deltas.push(sum / n);
  }
  deltas.sort((a, b) => a - b);

  const alpha = 1 - confidenceLevel;
  const at = (q: number) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(q * deltas.length)))]!;

  return {
    n,
    baselineRate: mean(clusters.map((c) => c.baseline)),
    candidateRate: mean(clusters.map((c) => c.candidate)),
    delta,
    // One-sided: the question is only whether the candidate is *worse*.
    lowerBound: at(alpha),
    upperBound: at(1 - alpha),
    confidenceLevel,
    counts,
    bootstrapReplicates: replicates,
    bootstrapSeed: seed,
  };
}

/**
 * Apply the pre-registered margin.
 *
 * A null margin is not zero and not a default. It means nobody committed to how
 * much loss is acceptable, and no amount of arithmetic here can supply that.
 * Equality at the boundary is a fail: a margin that is exactly met has not been
 * beaten, and rounding in the candidate's favour is the one direction this
 * decision must never lean.
 */
export function judgeNonInferiority(
  result: PairedResult,
  marginPp: number | null,
): Verdict {
  if (marginPp === null) {
    return {
      decided: false,
      reason:
        "no non-inferiority margin was pre-registered, so there is nothing to test against. " +
        `The paired difference is ${(result.delta * 100).toFixed(2)}pp ` +
        `(one-sided ${(result.confidenceLevel * 100).toFixed(0)}% lower bound ` +
        `${(result.lowerBound * 100).toFixed(2)}pp).`,
    };
  }
  const margin = marginPp / 100;
  const nonInferior = result.lowerBound > -margin;
  return {
    decided: true,
    nonInferior,
    marginPp,
    reason: nonInferior
      ? `lower bound ${(result.lowerBound * 100).toFixed(2)}pp is above the -${marginPp}pp margin`
      : `lower bound ${(result.lowerBound * 100).toFixed(2)}pp is not above the -${marginPp}pp margin`,
  };
}

/**
 * Holm correction, for when several candidates genuinely must be compared.
 *
 * Present so that the honest path exists. The intended design is one primary
 * candidate on the sealed set, chosen on a dev split; comparing several and
 * reporting the best is how a selection effect becomes a headline number.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const out = new Array<number>(m);
  let running = 0;
  indexed.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  });
  return out;
}

export function formatPaired(result: PairedResult, verdict: Verdict): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const pp = (x: number) => `${(x * 100).toFixed(2)}pp`;
  return [
    `instances       ${result.n}`,
    `baseline        ${pct(result.baselineRate)}`,
    `candidate       ${pct(result.candidateRate)}`,
    `difference      ${pp(result.delta)}  (one-sided ${(result.confidenceLevel * 100).toFixed(0)}% CI lower ${pp(result.lowerBound)})`,
    `discordant      baseline-only ${result.counts.baselineOnly} · candidate-only ${result.counts.candidateOnly} · both pass ${result.counts.bothPass} · both fail ${result.counts.bothFail}`,
    `bootstrap       ${result.bootstrapReplicates} replicates, seed ${result.bootstrapSeed}`,
    verdict.decided
      ? `verdict         ${verdict.nonInferior ? "non-inferior" : "INFERIOR"} — ${verdict.reason}`
      : `verdict         undecided — ${verdict.reason}`,
  ].join("\n");
}
