/**
 * Two-region streaming.
 *
 * Rendered output splits into a *stable* region, committed to scrollback and
 * never touched again, and a *tail*, which is mutable and repainted. Codex's
 * TUI is built this way and the invariant it enforces — committed content is
 * append-only — is the same one the context ledger uses. Keeping both on one
 * rule means one thing to reason about.
 *
 * The subtlety is structures that cannot be rendered incrementally. A markdown
 * table reflows every earlier row when a new one arrives, so committing rows as
 * they stream produces a stale render locked into scrollback. Such structures
 * are held in the tail until they are complete.
 */

export interface StreamRegions {
  /** Safe to print and forget. */
  stable: string[];
  /** Repainted every frame until it stabilises. */
  tail: string[];
}

const FENCE = /^\s*(```|~~~)/;
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Accumulates streamed text and decides how much of it has settled.
 *
 * Held back, in order of precedence:
 *   - anything inside an unterminated code fence;
 *   - a table from its header row onward, until the stream ends;
 *   - the final line, which may still be growing.
 */
export class StreamSplitter {
  private source = "";

  push(delta: string): void {
    this.source += delta;
  }

  get text(): string {
    return this.source;
  }

  reset(): void {
    this.source = "";
  }

  /** Split at the current moment. `final` releases everything. */
  split(final = false): StreamRegions {
    const lines = this.source.split("\n");
    if (final) return { stable: lines, tail: [] };

    let holdFrom = lines.length - 1; // the last line is always still growing

    let fenceOpenAt = -1;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE.test(lines[i]!)) {
        if (inFence) {
          inFence = false;
          fenceOpenAt = -1;
        } else {
          inFence = true;
          fenceOpenAt = i;
        }
      }
    }
    if (inFence && fenceOpenAt >= 0) holdFrom = Math.min(holdFrom, fenceOpenAt);

    // A table is only a table once its delimiter row lands; the header above it
    // must then be held too, because column widths are about to change.
    if (!inFence) {
      for (let i = 1; i < lines.length; i++) {
        if (TABLE_DELIM.test(lines[i]!) && TABLE_ROW.test(lines[i - 1]!)) {
          holdFrom = Math.min(holdFrom, i - 1);
          break;
        }
      }
    }

    holdFrom = Math.max(0, holdFrom);
    return { stable: lines.slice(0, holdFrom), tail: lines.slice(holdFrom) };
  }
}

/**
 * Tracks which stable lines have already been committed, so a repaint never
 * prints the same line twice.
 */
export class CommitTracker {
  private committed = 0;

  /** Lines that are newly stable and have not been printed yet. */
  take(stable: string[]): string[] {
    if (stable.length <= this.committed) return [];
    const fresh = stable.slice(this.committed);
    this.committed = stable.length;
    return fresh;
  }

  get count(): number {
    return this.committed;
  }

  /**
   * A width change invalidates every wrapped line, so the stable region has to
   * be rebuilt rather than appended to.
   */
  reset(): void {
    this.committed = 0;
  }
}
