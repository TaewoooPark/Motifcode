#!/usr/bin/env node
/**
 * `motif` — the command line.
 *
 * Ties the packages together: transport, loop, executor, skills, agents, hooks,
 * journal and screen. Everything below it is pure or testable in isolation;
 * this file is the wiring and the argument parsing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, AgentScheduler, BUILTIN_AGENTS, concurrencyFor } from "@motifcode/agents";
import { HttpTransport, runLoop, type LoopEvent } from "@motifcode/core";
import { DEFAULT_HOOKS, type HookConfig } from "@motifcode/hooks";
import {
  Journal,
  checkResumable,
  listSessions,
  loadResume,
  newHeader,
  type ResumeState,
  type ScopeIdentity,
} from "@motifcode/journal";
import {
  SAMPLING_DEFAULTS,
  systemPromptHash,
  toolSchemaHash,
  type ChannelId,
} from "@motifcode/protocol";
import { BUILTIN_SKILLS, SkillRegistry, parseSkill } from "@motifcode/skills";
import { CORE_TOOLS, CORE_TOOL_NAMES, lintTools, formatFindings } from "@motifcode/tools";
import { Screen } from "@motifcode/tui";
import { doctor, formatChecks, worstState } from "./doctor.js";
import { ToolExecutor } from "./executor.js";
import { buildAgentPrompt, buildSystemPrompt } from "./prompt.js";

const VERSION = "0.0.1";

interface Args {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command = "run";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (rest.length === 0 && ["doctor", "sessions", "resume", "skills", "agents", "lint", "distil", "help", "version"].includes(a)) {
      command = a;
    } else {
      rest.push(a);
    }
  }
  return { command, rest, flags };
}

function flagStr(flags: Args["flags"], key: string, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

/** Raised for bad usage. Reported as one line and exit 2, never as a stack. */
class UsageError extends Error {}

function flagEnum<T extends string>(
  flags: Args["flags"],
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = flags[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new UsageError(`--${key} must be one of ${allowed.join(", ")}; got ${String(v)}`);
  }
  return v as T;
}

function flagInt(flags: Args["flags"], key: string, fallback: number, min: number): number {
  const v = flags[key];
  if (v === undefined) return fallback;
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`--${key} must be an integer >= ${min}; got ${String(v)}`);
  }
  return n;
}

const CHANNELS = ["toolcall", "object", "raw"] as const;
const CHANNEL_POLICIES = ["fixed", "adaptive"] as const;

/** Distinguishes one delegated run from another in tool output and the journal. */
let runSequence = 0;
function nextRunId(prefix: string): string {
  runSequence += 1;
  return `${prefix}-${String(runSequence).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */

const CONFIG_DIR = ".motif";

function loadSkills(cwd: string): SkillRegistry {
  const reg = new SkillRegistry();
  reg.registerAll(BUILTIN_SKILLS);
  // Project skills shadow built-ins of the same name, which is the precedence
  // every other harness uses.
  for (const [dir, source] of [
    [join(homedir(), CONFIG_DIR, "skills"), "user"],
    [join(cwd, CONFIG_DIR, "skills"), "project"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        reg.register(parseSkill(readFileSync(file, "utf8"), source));
      } catch (err) {
        process.stderr.write(`skipping ${file}: ${String(err)}\n`);
      }
    }
  }
  return reg;
}

function loadHooks(cwd: string): HookConfig {
  const file = join(cwd, CONFIG_DIR, "settings.json");
  if (!existsSync(file)) return DEFAULT_HOOKS;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { hooks?: HookConfig };
    return parsed.hooks ?? DEFAULT_HOOKS;
  } catch (err) {
    process.stderr.write(`ignoring ${file}: ${String(err)}\n`);
    return DEFAULT_HOOKS;
  }
}

function loadProjectNotes(cwd: string): string | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md", join(CONFIG_DIR, "NOTES.md")]) {
    const file = join(cwd, name);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
}

function toolsHash(names: readonly string[]): string {
  let h = 2166136261;
  for (const ch of names.join(" ")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ */

const HELP = `motif ${VERSION} — a coding agent built for Motif-3

  motif "<task>"            run a session
  motif doctor              check the endpoint and the server flags
  motif sessions            list recorded sessions
  motif resume <file>       resume an interrupted session
  motif skills              list available skills
  motif agents              list available subagents
  motif lint                lint the tool schemas
  motif distil <dir>        export successful trajectories for training

Flags
  --endpoint <url>          model server (default http://127.0.0.1:8080)
  --model <name>            model id to request
  --channel <id>            toolcall | object | raw (default toolcall)
  --channel-policy <p>      fixed | adaptive (default fixed)
  --max-turns <n>           turn ceiling (default 100)
  --max-output-tokens <n>   cap on each model step
  --seed <n>                sampling seed, passed to the server
  --cwd <path>              working directory
  --no-hero                 skip the splash

The object and raw channels drive /v1/completions with a locally rendered
prompt. Neither has been measured against Motif-3, so both need
--experimental-channel to run. "fixed" never changes channel mid-session, which
is what any comparable measurement requires; "adaptive" moves to a simpler
channel after repeated parse failures, and that move restarts the conversation
because the transcript formats are not interchangeable.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = flagStr(args.flags, "cwd", process.cwd());
  const endpoint = flagStr(args.flags, "endpoint", process.env["MOTIF_ENDPOINT"] ?? "http://127.0.0.1:8080");
  const model = flagStr(args.flags, "model", process.env["MOTIF_MODEL"] ?? "Motif-Technologies/Motif-3");
  let resumeFrom: ResumeState | undefined;

  switch (args.command) {
    case "help":
      process.stdout.write(HELP);
      return 0;

    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case "lint": {
      const findings = lintTools(CORE_TOOLS);
      process.stdout.write(formatFindings(findings) + "\n");
      return findings.length > 0 ? 1 : 0;
    }

    case "skills": {
      const reg = loadSkills(cwd);
      for (const s of reg.list()) {
        process.stdout.write(`${s.name.padEnd(16)} ${s.description}  (${s.source})\n`);
      }
      return 0;
    }

    case "agents": {
      const reg = new AgentRegistry();
      reg.registerAll(BUILTIN_AGENTS);
      for (const a of reg.list()) {
        const tools = CORE_TOOL_NAMES.slice(0, a.toolCount).join(" ");
        process.stdout.write(`${a.name.padEnd(12)} ${a.description}\n${"".padEnd(12)} tools: ${tools}\n`);
      }
      return 0;
    }

    case "doctor": {
      const checks = await doctor({ endpoint, model });
      process.stdout.write(formatChecks(checks) + "\n");
      return worstState(checks) === "fail" ? 1 : 0;
    }

    case "sessions": {
      const dir = join(cwd, CONFIG_DIR, "sessions");
      const sessions = listSessions(dir);
      if (sessions.length === 0) {
        process.stdout.write(`no sessions in ${dir}\n`);
        return 0;
      }
      for (const s of sessions) {
        // The grade is shown next to the outcome, and only when there is one.
        // `done` is the agent's claim about itself; a grade is a verdict from
        // outside, and conflating them is how a self-report becomes a score.
        const grade = s.grade ? ` grade=${s.grade.status}` : "";
        const partial = s.truncatedTail ? " (truncated)" : "";
        process.stdout.write(
          `${s.header.startedAt}  ${s.outcome.padEnd(12)}${grade} ${s.rootEvents} root events` +
            `${s.childEvents > 0 ? ` +${s.childEvents} child` : ""}${partial}  ${s.path}\n`,
        );
      }
      return 0;
    }

    case "distil": {
      const dir = args.rest[0] ?? join(cwd, CONFIG_DIR, "sessions");
      const sessions = listSessions(dir);
      const graded = sessions.filter((s) => s.grade?.status === "passed");
      const ungraded = sessions.filter((s) => s.grade === undefined);
      // Export is gated on a grader's verdict, not on the model saying `done`.
      // A session that never ran its tests, or hid a failure, would otherwise
      // become training data and profiling corpus on its own say-so.
      for (const s of graded) process.stdout.write(`${s.path}\n`);
      process.stderr.write(
        `${graded.length} of ${sessions.length} sessions passed a grader` +
          (ungraded.length > 0 ? `; ${ungraded.length} were never graded and are excluded` : "") +
          "\n",
      );
      return 0;
    }

    case "resume": {
      const file = args.rest[0];
      if (!file) {
        process.stderr.write("resume needs a session file — see `motif sessions`\n");
        return 2;
      }
      resumeFrom = loadResume(file);
      break;
    }

    default:
      break;
  }

  const channel: ChannelId = flagEnum(args.flags, "channel", CHANNELS, "toolcall");
  const channelPolicy = flagEnum(args.flags, "channel-policy", CHANNEL_POLICIES, "fixed");
  const maxTurns = flagInt(args.flags, "max-turns", 100, 1);
  const maxOutputTokens =
    args.flags["max-output-tokens"] !== undefined
      ? flagInt(args.flags, "max-output-tokens", 0, 1)
      : undefined;
  const seed = args.flags["seed"] !== undefined ? flagInt(args.flags, "seed", 0, 0) : undefined;

  // The two body-parsing channels are implemented end to end but have never
  // been run against Motif-3. Saying so with a flag is more honest than a
  // README note nobody reads at the point of use.
  if (channel !== "toolcall" && args.flags["experimental-channel"] !== true) {
    throw new UsageError(
      `the ${channel} channel has never been measured against Motif-3; pass --experimental-channel to try it`,
    );
  }
  if (channelPolicy === "adaptive" && args.flags["experimental-channel"] !== true) {
    throw new UsageError(
      "adaptive channel policy restarts the conversation on a downgrade and has never been measured; " +
        "pass --experimental-channel to try it",
    );
  }

  const skills = loadSkills(cwd);
  const agents = new AgentRegistry();
  agents.registerAll(BUILTIN_AGENTS);
  const hooks = loadHooks(cwd);
  const projectNotes = loadProjectNotes(cwd);

  const systemFor = (ch: ChannelId): string =>
    buildSystemPrompt({
      channel: ch,
      tools: [...CORE_TOOLS],
      skills,
      agents,
      ...(projectNotes !== undefined ? { projectNotes } : {}),
      cwd,
    });

  const schemaHash = toolSchemaHash(CORE_TOOLS);
  const promptHash = systemPromptHash(systemFor(channel));

  // Resume, or start. A resume keeps the recorded task: continuing someone
  // else's transcript with a different task is a new run wearing the old one's
  // history.
  let task: string;
  if (resumeFrom) {
    const blocker = checkResumable(resumeFrom, {
      systemHash: promptHash,
      toolSchemaHash: schemaHash,
      model,
    });
    if (blocker) {
      process.stderr.write(`cannot resume: ${blocker}\n`);
      return 2;
    }
    task = resumeFrom.task ?? "";
    process.stdout.write(
      `resuming ${resumeFrom.header.runId} from turn ${resumeFrom.checkpoint!.turn}` +
        `${resumeFrom.truncatedTail ? " (last record was truncated)" : ""}\n`,
    );
  } else {
    task = args.rest.join(" ").trim();
  }

  if (!task) {
    process.stdout.write(HELP);
    return 2;
  }

  const transport = new HttpTransport({ endpoint, model });
  const screen = new Screen();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const journal = new Journal(
    join(cwd, CONFIG_DIR, "sessions", `${runId}.jsonl`),
    newHeader({
      runId,
      cwd,
      model,
      endpoint,
      systemHash: promptHash,
      toolSchemaHash: schemaHash,
      harnessVersion: VERSION,
      config: {
        initialChannel: channel,
        channelPolicy,
        temperature: SAMPLING_DEFAULTS.temperature,
        topP: SAMPLING_DEFAULTS.top_p,
        ...(seed !== undefined ? { seed } : {}),
        maxTurns,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        maxRepairs: 2,
      },
    }),
  );

  const rootScope: ScopeIdentity = { scopeId: "root", scopeKind: "root" };
  journal.record(rootScope, {
    t: "scope_start",
    task,
    initialMessages: [{ role: "user", content: task }],
  });
  if (resumeFrom?.checkpoint) {
    journal.record(rootScope, {
      t: "resume",
      fromSeq: resumeFrom.checkpoint.afterSeq,
      previousRunId: resumeFrom.header.runId,
    });
  }

  if (args.flags["no-hero"] !== true) {
    screen.splash({ model, endpoint, channel, maxTokens: 262_144 });
  }

  const rootSink = journal.sinkFor(rootScope);
  const emit = (e: LoopEvent) => {
    rootSink(e);
    screen.apply(e);
  };

  const scheduler = new AgentScheduler(concurrencyFor(endpoint), (entry) =>
    emit({ type: "queue", agent: entry.agent, state: entry.state === "failed" ? "done" : entry.state }),
  );

  const executor = new ToolExecutor({
    cwd,
    hooks,
    skills,
    onHook: (label, ok) => emit({ type: "hook", event: "PostToolUse", label, ok }),
    runAgent: async (name, prompt) => {
      const def = agents.get(name);
      if (!def) {
        // No generation at all for an unknown name: spawning a loop to
        // discover the agent does not exist costs a model round-trip and
        // produces a summary the parent would have to distrust anyway.
        return {
          ok: false,
          reason: "unknown_agent",
          runId: "-",
          summary: `no such subagent: ${name}. Available: ${agents.list().map((a) => a.name).join(", ")}`,
        };
      }
      const childScope: ScopeIdentity = {
        scopeId: nextRunId(`sub-${def.name}`),
        scopeKind: "subagent",
        parentScopeId: rootScope.scopeId,
        agentName: def.name,
      };
      return scheduler.submit(name, prompt, async () => {
        // Its own executor, and its own `close()`. A child that throws or is
        // aborted still leaves a persistent shell behind unless the cleanup is
        // in `finally`.
        const childExecutor = new ToolExecutor({ cwd, skills });
        journal.record(childScope, {
          t: "scope_start",
          task: prompt,
          initialMessages: [{ role: "user", content: prompt }],
        });
        try {
          const sub = await runLoop({
            transport,
            tools: def.tools,
            // The system prompt carries the role. The delegated task is a user
            // turn, exactly as the parent's own task is — a child that only
            // receives its role instructions has been told who it is and never
            // told what to do.
            system: (ch) =>
              buildAgentPrompt({
                name: def.name,
                instructions: def.instructions,
                tools: def.tools,
                channel: ch,
                cwd,
              }),
            userTask: prompt,
            executor: childExecutor,
            // Subagent events are journalled under their own scope but not
            // painted: the parent's screen shows the queue, not the child's
            // transcript. Under one scope they would also have been able to
            // label the parent's run.
            emit: journal.sinkFor(childScope),
            onCheckpoint: journal.checkpointFor(childScope),
            scopeId: childScope.scopeId,
            repo: { cwd },
            channel,
            channelPolicy,
            maxTurns: def.maxTurns ?? 25,
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
          journal.record(childScope, {
            t: "scope_end",
            result: {
              endReason: sub.reason,
              ...(sub.summary !== undefined ? { summary: sub.summary } : {}),
              turns: sub.turns,
            },
          });
          return {
            ok: sub.reason === "done",
            reason: sub.reason,
            runId: childScope.scopeId,
            ...(sub.summary !== undefined ? { summary: sub.summary } : {}),
          };
        } finally {
          childExecutor.close();
        }
      });
    },
  });

  try {
    const result = await runLoop({
      transport,
      tools: [...CORE_TOOLS],
      system: systemFor,
      userTask: task,
      executor,
      emit,
      onCheckpoint: journal.checkpointFor(rootScope),
      scopeId: rootScope.scopeId,
      repo: { cwd },
      channel,
      channelPolicy,
      maxTurns,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(resumeFrom?.checkpoint ? { resume: resumeFrom.checkpoint } : {}),
    });
    journal.record(rootScope, {
      t: "scope_end",
      result: {
        endReason: result.reason,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        turns: result.turns,
      },
    });
    // Exit 0 means the agent finished its own loop cleanly. It is not a claim
    // that the work is correct — that requires a grader, and `motif distil`
    // reads the grade rather than this exit code.
    return result.reason === "done" ? 0 : 1;
  } finally {
    executor.close();
    screen.finish();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Bad usage gets one line and exit 2; anything else is a real failure and
    // keeps its message. Neither prints a stack — a stack trace tells a user
    // nothing about a mistyped flag.
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
