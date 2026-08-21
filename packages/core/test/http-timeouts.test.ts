/**
 * Node's own HTTP idle timeouts, and why this harness turns them off.
 *
 * The bug this covers is not hypothetical: served locally at roughly 12 tok/s,
 * a single agent step outlived Node's 300 s header timeout and the session
 * ended in `transport_error` while the server was still generating happily.
 *
 * It then came back, which is why the third test below exists. The fix read
 * the global dispatcher at startup — before any request, so before Node had
 * loaded the undici that installs it — found nothing, and returned false into
 * a discarded value. A function that silently does nothing looks exactly like
 * a function that works. The regression test is the ordering, not the swap.
 */

import { describe, expect, it } from "vitest";
import { relaxNodeHttpTimeouts } from "../src/transport.js";

const KEY = Symbol.for("undici.globalDispatcher.1");
const holder = globalThis as unknown as Record<symbol, unknown>;

describe("relaxNodeHttpTimeouts", () => {
  it("replaces the global dispatcher with one that has no idle timeouts", async () => {
    const saved = holder[KEY];
    const seen: unknown[] = [];
    class FakeAgent {
      constructor(opts: unknown) {
        seen.push(opts);
      }
    }
    holder[KEY] = new FakeAgent(undefined);
    try {
      await expect(relaxNodeHttpTimeouts()).resolves.toBe(true);
      // The first entry is our own setup; the call under test made the second.
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
      expect(holder[KEY]).toBeInstanceOf(FakeAgent);
    } finally {
      holder[KEY] = saved;
    }
  });

  it("does not spend a request when a dispatcher is already installed", async () => {
    const saved = holder[KEY];
    const savedFetch = globalThis.fetch;
    class FakeAgent {}
    holder[KEY] = new FakeAgent();
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("");
    }) as typeof fetch;
    try {
      await expect(relaxNodeHttpTimeouts()).resolves.toBe(true);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      holder[KEY] = saved;
    }
  });

  it("forces undici to load when the dispatcher is not installed yet", async () => {
    const saved = holder[KEY];
    const savedFetch = globalThis.fetch;
    const seen: unknown[] = [];
    class FakeAgent {
      constructor(opts: unknown) {
        seen.push(opts);
      }
    }
    // Assignment, not `delete`: undici defines the symbol non-configurable, so
    // it cannot be removed once installed. At real startup the property is
    // simply absent, which reads the same way.
    holder[KEY] = undefined;
    let requested: string | undefined;
    // Stands in for Node's lazy loader: the dispatcher exists only once fetch
    // has actually been called. Reading the symbol first finds nothing, which
    // is the bug.
    globalThis.fetch = (async (input: unknown) => {
      requested = String(input);
      holder[KEY] = new FakeAgent(undefined);
      return new Response("");
    }) as typeof fetch;
    try {
      await expect(relaxNodeHttpTimeouts()).resolves.toBe(true);
      // No socket and no name resolution — the load is the only side effect
      // being paid for.
      expect(requested).toMatch(/^data:/);
      expect(seen[1]).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    } finally {
      globalThis.fetch = savedFetch;
      holder[KEY] = saved;
    }
  });

  it("reports failure rather than throwing when Node has no dispatcher to swap", async () => {
    const saved = holder[KEY];
    const savedFetch = globalThis.fetch;
    holder[KEY] = undefined;
    // A loader that installs nothing: the platform is not the one we know.
    globalThis.fetch = (async () => new Response("")) as typeof fetch;
    try {
      await expect(relaxNodeHttpTimeouts()).resolves.toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
      holder[KEY] = saved;
    }
  });

  it("reports failure rather than throwing when the constructor rejects the options", async () => {
    const saved = holder[KEY];
    class Hostile {
      constructor() {
        throw new Error("nope");
      }
    }
    // An instance whose constructor throws when called again.
    holder[KEY] = Object.create(Hostile.prototype);
    try {
      await expect(relaxNodeHttpTimeouts()).resolves.toBe(false);
    } finally {
      holder[KEY] = saved;
    }
  });
});
