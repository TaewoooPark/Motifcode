/**
 * Breakage budget and loop detection.
 *
 * Two guards, both of which exist because of something specific about this
 * model rather than general prudence.
 *
 * The breakage budget counts how often the model's action syntax fails to
 * parse. That is a first-class number here, not an error log: the vendor
 * documents malformed tool-call JSON as frequent, and the failure is silent —
 * a dropped turn looks exactly like a final answer. When the rate crosses a
 * threshold the session moves to a channel that cannot suffer the failure being
 * observed, rather than continuing to lose turns.
 *
 * Loop detection guards the other direction. Motif's chat teacher was trained
 * against "repetition or degeneration" as an explicit anti-pattern, which means
 * it is a real failure mode of the base behaviour, and pruning the expert bank
 * can only make it more likely.
 */

import { DOWNGRADE, type ChannelId } from "@motifcode/protocol";

export interface BudgetOptions {
  /** Consecutive parse failures before downgrading. */
  consecutiveLimit?: number;
  /** Failure rate over the window that triggers a downgrade. */
  rateLimit?: number;
  /** How many attempts the rate is measured over. */
  window?: number;
  /** Total failures before the session gives up. */
  hardLimit?: number;
}

export interface BudgetState {
  attempts: number;
  failures: number;
  repairs: number;
  consecutive: number;
}

export interface BudgetSnapshot {
  options: Required<BudgetOptions>;
  state: BudgetState;
  recent: boolean[];
}

export class BreakageBudget {
  private readonly consecutiveLimit: number;
  private readonly rateLimit: number;
  private readonly window: number;
  private readonly hardLimit: number;
  private recent: boolean[] = [];
  private state: BudgetState = { attempts: 0, failures: 0, repairs: 0, consecutive: 0 };

  constructor(opts: BudgetOptions = {}) {
    this.consecutiveLimit = opts.consecutiveLimit ?? 2;
    this.rateLimit = opts.rateLimit ?? 0.25;
    this.window = opts.window ?? 12;
    this.hardLimit = opts.hardLimit ?? 20;
  }

  get snapshot(): Readonly<BudgetState> {
    return { ...this.state };
  }

  /**
   * Everything needed to continue counting after a crash.
   *
   * The options travel with the state on purpose: a budget restored under
   * different limits is a different budget, and the mismatch would only show up
   * as a downgrade that fires at the wrong time.
   */
  capture(): BudgetSnapshot {
    return {
      options: {
        consecutiveLimit: this.consecutiveLimit,
        rateLimit: this.rateLimit,
        window: this.window,
        hardLimit: this.hardLimit,
      },
      state: { ...this.state },
      recent: [...this.recent],
    };
  }

  static restore(snap: BudgetSnapshot): BreakageBudget {
    const b = new BreakageBudget(snap.options);
    b.state = { ...snap.state };
    b.recent = [...snap.recent];
    return b;
  }

  /** A turn whose actions parsed. `repaired` still counts as a success. */
  recordSuccess(repaired: boolean): void {
    this.state.attempts++;
    if (repaired) this.state.repairs++;
    this.state.consecutive = 0;
    this.push(false);
  }

  recordFailure(): void {
    this.state.attempts++;
    this.state.failures++;
    this.state.consecutive++;
    this.push(true);
  }

  private push(failed: boolean): void {
    this.recent.push(failed);
    if (this.recent.length > this.window) this.recent.shift();
  }

  private get recentRate(): number {
    if (this.recent.length < Math.min(this.window, 4)) return 0;
    return this.recent.filter(Boolean).length / this.recent.length;
  }

  /** Why the channel should change, or null to stay put. */
  downgradeReason(): string | null {
    if (this.state.consecutive >= this.consecutiveLimit) {
      return `${this.state.consecutive} consecutive parse failures`;
    }
    if (this.recentRate > this.rateLimit) {
      return `${Math.round(this.recentRate * 100)}% of recent turns failed to parse`;
    }
    return null;
  }

  get exhausted(): boolean {
    return this.state.failures >= this.hardLimit;
  }

  /** Reset the streak after a channel change; the new channel deserves a fresh look. */
  onChannelChange(): void {
    this.state.consecutive = 0;
    this.recent = [];
  }
}

export function nextChannel(current: ChannelId): ChannelId | null {
  return DOWNGRADE[current];
}

/* ------------------------------------------------------------------ */

export interface LoopGuardOptions {
  /** Identical action signatures in a row before we stop. */
  repeatLimit?: number;
  /** Turns with no tool output change before we stop. */
  stallLimit?: number;
}

export interface LoopVerdict {
  tripped: boolean;
  signature: string;
  repeats: number;
}

export interface LoopGuardSnapshot {
  options: Required<LoopGuardOptions>;
  lastSignature: string;
  repeats: number;
  lastOutput: string;
  stalls: number;
}

export class LoopGuard {
  private readonly repeatLimit: number;
  private readonly stallLimit: number;
  private lastSignature = "";
  private repeats = 0;
  private lastOutput = "";
  private stalls = 0;

  constructor(opts: LoopGuardOptions = {}) {
    this.repeatLimit = opts.repeatLimit ?? 3;
    this.stallLimit = opts.stallLimit ?? 4;
  }

  /** Signature of a turn's actions — name plus arguments, order preserved. */
  static signature(actions: { name: string; arguments: Record<string, unknown> }[]): string {
    return actions.map((a) => `${a.name}(${JSON.stringify(a.arguments)})`).join("|");
  }

  observe(signature: string, output: string): LoopVerdict {
    if (signature !== "" && signature === this.lastSignature) this.repeats++;
    else {
      this.lastSignature = signature;
      this.repeats = 1;
    }

    if (output === this.lastOutput && output !== "") this.stalls++;
    else {
      this.lastOutput = output;
      this.stalls = 0;
    }

    const tripped = this.repeats >= this.repeatLimit || this.stalls >= this.stallLimit;
    return { tripped, signature, repeats: this.repeats };
  }

  reset(): void {
    this.lastSignature = "";
    this.repeats = 0;
    this.lastOutput = "";
    this.stalls = 0;
  }

  capture(): LoopGuardSnapshot {
    return {
      options: { repeatLimit: this.repeatLimit, stallLimit: this.stallLimit },
      lastSignature: this.lastSignature,
      repeats: this.repeats,
      lastOutput: this.lastOutput,
      stalls: this.stalls,
    };
  }

  static restore(snap: LoopGuardSnapshot): LoopGuard {
    const g = new LoopGuard(snap.options);
    g.lastSignature = snap.lastSignature;
    g.repeats = snap.repeats;
    g.lastOutput = snap.lastOutput;
    g.stalls = snap.stalls;
    return g;
  }
}
