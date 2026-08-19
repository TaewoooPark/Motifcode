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
import { Journal, checkResumable, listSessions, loadResume, newHeader, toTrajectory } from "@motifcode/journal";
import type { ChannelId } from "@motifcode/protocol";
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
  --max-turns <n>           turn ceiling (default 100)
  --cwd <path>              working directory
  --no-hero                 skip the splash
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = flagStr(args.flags, "cwd", process.cwd());
  const endpoint = flagStr(args.flags, "endpoint", process.env["MOTIF_ENDPOINT"] ?? "http://127.0.0.1:8080");
  const model = flagStr(args.flags, "model", process.env["MOTIF_MODEL"] ?? "Motif-Technologies/Motif-3");

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
        process.stdout.write(
          `${s.header.startedAt}  ${String(s.outcome ?? "?").padEnd(12)} ${s.events} events  ${s.path}\n`,
        );
      }
      return 0;
    }

    case "distil": {
      const dir = args.rest[0] ?? join(cwd, CONFIG_DIR, "sessions");
      const kept: unknown[] = [];
      for (const s of listSessions(dir)) {
        const t = toTrajectory(loadResume(s.path));
        if (t) kept.push(t);
      }
      process.stdout.write(JSON.stringify(kept, null, 2) + "\n");
      process.stderr.write(`${kept.length} successful trajector${kept.length === 1 ? "y" : "ies"}\n`);
      return 0;
    }

    case "resume": {
      const file = args.rest[0];
      if (!file) {
        process.stderr.write("resume needs a session file — see `motif sessions`\n");
        return 2;
      }
      const state = loadResume(file);
      const blocker = checkResumable(state, toolsHash(CORE_TOOL_NAMES));
      if (blocker) {
        process.stderr.write(`cannot resume: ${blocker}\n`);
        return 2;
      }
      process.stdout.write(
        `resuming ${state.header.sessionId} (${state.events.length} events, ${state.interrupted ? "interrupted" : "complete"})\n`,
      );
      // The conversation is rebuilt from the recorded user turns; the loop then
      // continues normally.
      args.rest = state.userTurns.slice(-1);
      break;
    }

    default:
      break;
  }

  const task = args.rest.join(" ").trim();
  if (!task) {
    process.stdout.write(HELP);
    return 2;
  }

  const channel = flagStr(args.flags, "channel", "toolcall") as ChannelId;
  const skills = loadSkills(cwd);
  const agents = new AgentRegistry();
  agents.registerAll(BUILTIN_AGENTS);
  const hooks = loadHooks(cwd);

  const transport = new HttpTransport({ endpoint, model });
  const screen = new Screen();
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const journal = new Journal(
    join(cwd, CONFIG_DIR, "sessions", `${sessionId}.jsonl`),
    newHeader({
      sessionId,
      cwd,
      model,
      endpoint,
      tools: [...CORE_TOOL_NAMES],
      toolsHash: toolsHash(CORE_TOOL_NAMES),
    }),
  );

  if (args.flags["no-hero"] !== true) {
    screen.splash({ model, endpoint, channel, maxTokens: 262_144 });
  }
  journal.user(task);

  const emit = (e: LoopEvent) => {
    journal.record(e);
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
    runAgent: (name, prompt) =>
      scheduler.submit(name, prompt, async () => {
        const def = agents.get(name);
        if (!def) return `no such subagent: ${name}. Available: ${agents.list().map((a) => a.name).join(", ")}`;
        const sub = await runLoop({
          transport,
          tools: def.tools,
          system: buildAgentPrompt({
            name: def.name,
            instructions: def.instructions,
            tools: def.tools,
            channel,
            cwd,
          }),
          executor: new ToolExecutor({ cwd, skills }),
          // Subagent events are journalled but not painted: the parent's screen
          // shows the queue, not the child's transcript.
          emit: (e) => journal.record(e),
          channel,
          maxTurns: def.maxTurns ?? 25,
        });
        return sub.summary ?? `(subagent ended: ${sub.reason})`;
      }),
  });

  try {
    const result = await runLoop({
      transport,
      tools: [...CORE_TOOLS],
      system: buildSystemPrompt({
        channel,
        tools: [...CORE_TOOLS],
        skills,
        agents,
        projectNotes: loadProjectNotes(cwd),
        cwd,
      }),
      executor,
      emit,
      channel,
      maxTurns: Number(flagStr(args.flags, "max-turns", "100")),
    });
    return result.reason === "done" ? 0 : 1;
  } finally {
    executor.close();
    screen.finish();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
