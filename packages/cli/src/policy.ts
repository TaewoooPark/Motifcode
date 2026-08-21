/**
 * What an agent is allowed to do, enforced where the doing happens.
 *
 * The explorer and reviewer subagents were described as read-only in their
 * instructions and given `bash`. Their read-only-ness was therefore a request,
 * not a property: `touch`, `sed -i`, `rm`, `curl | sh` and `git push` were all
 * available, and the only thing standing between a review and a modified
 * working tree was the model choosing to comply. The same applied to `read`,
 * which resolved any path it was given — including `../../.ssh/id_rsa`.
 *
 * A policy object is not the strongest possible answer. Real isolation is an
 * OS-level read-only mount or a container, and for benchmark runs that is what
 * should be used; this layer cannot stop a determined process. What it does do
 * is make the boundary a property of the executor rather than of the prompt, so
 * a read-only agent stays read-only when the model does something unexpected —
 * which is the case that actually happens.
 *
 * Command-pattern matching is deliberately *not* how write access is decided.
 * Blocking `rm` and allowing everything else is a game the blocklist loses:
 * `python -c`, `>`, `tee`, `install`, `cp`, and a hundred others all write.
 * Read-only agents run their commands inside an OS-level read-only view of the
 * filesystem instead, and lose the tool entirely on a host that cannot provide
 * one — see `sandbox.ts`.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolInvocation } from "@motifcode/core";

export interface ExecutionPolicy {
  /** The only directory this agent may touch. Canonical and symlink-resolved. */
  root: string;
  allowWrite: boolean;
  allowNetwork: boolean;
  allowedTools: ReadonlySet<string>;
}

export type Approval = { allowed: true } | { allowed: false; reason: string };

/**
 * Tools a read-only agent cannot have at all.
 *
 * `write` and `apply_patch` write by definition. `term` is a shell that outlives
 * the call, which no per-call sandbox can contain. `task` and `mcp` hand the
 * work to something else, and the something else has its own permissions.
 *
 * `bash` is deliberately not on this list. Taking it away would leave the
 * explorer unable to run `rg`, which is most of what it exists to do; instead
 * the executor runs it inside a read-only sandbox, and refuses when the host
 * cannot provide one. That is the difference between a boundary and a
 * blocklist: the sandbox stops `python -c 'open("x","w")'` without anyone
 * having thought of it.
 */
const DENIED_TO_READONLY = new Set(["write", "term", "apply_patch", "task", "mcp"]);

export function readOnlyPolicy(root: string, tools: readonly string[]): ExecutionPolicy {
  return {
    root: canonical(root),
    allowWrite: false,
    allowNetwork: false,
    // Intersect rather than trust the caller: an agent declared read-only that
    // was also handed `apply_patch` is a contradiction, and this is where it
    // gets resolved rather than in the prompt.
    allowedTools: new Set(tools.filter((t) => !DENIED_TO_READONLY.has(t))),
  };
}

export function fullPolicy(root: string, tools: readonly string[]): ExecutionPolicy {
  return {
    root: canonical(root),
    allowWrite: true,
    allowNetwork: true,
    allowedTools: new Set(tools),
  };
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Is this path inside the root?
 *
 * Resolved through symlinks first. A workspace containing a symlink to `/etc`
 * is inside the workspace by every textual test and outside it by every test
 * that matters. Non-existent paths fall back to lexical resolution, which is
 * correct for a file about to be created and cannot be tricked by a symlink
 * that does not exist yet.
 */
export function isInside(root: string, path: string): boolean {
  const target = canonical(isAbsolute(path) ? path : resolve(root, path));
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Approve or refuse one validated call.
 *
 * Runs after schema validation, so the arguments are known to have the right
 * shape. This asks a different question: not "is this well-formed" but "is this
 * agent allowed to do it".
 */
export function approve(policy: ExecutionPolicy, call: ToolInvocation): Approval {
  if (!policy.allowedTools.has(call.name)) {
    return {
      allowed: false,
      reason:
        `this agent does not have the \`${call.name}\` tool` +
        (DENIED_TO_READONLY.has(call.name) && !policy.allowWrite
          ? " — it is read-only, and this tool changes things or escapes the sandbox"
          : ""),
    };
  }

  // `write` is confined the same way `read` is, and for a stronger reason: a
  // read that escapes leaks, a write that escapes damages. Both go through one
  // check so the two cannot drift apart.
  if (call.name === "read" || call.name === "write") {
    const path = call.arguments["path"];
    if (typeof path !== "string") {
      return { allowed: false, reason: `${call.name} needs a string path` };
    }
    if (!isInside(policy.root, path)) {
      const verb = call.name === "read" ? "reads" : "writes";
      return {
        allowed: false,
        reason: `${path} resolves outside ${policy.root}; ${verb} are confined to the working directory`,
      };
    }
  }

  return { allowed: true };
}

/** The policy an agent gets from its declared role. */
export function policyForAgent(
  opts: { root: string; tools: readonly string[]; readOnly: boolean },
): ExecutionPolicy {
  return opts.readOnly
    ? readOnlyPolicy(opts.root, opts.tools)
    : fullPolicy(opts.root, opts.tools);
}
