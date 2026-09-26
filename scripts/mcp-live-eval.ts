#!/usr/bin/env node
/** Opt-in live evaluation. Credentials and reasoning text are never written to evidence. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { HttpTransport, defaultDotenvPaths, resolveEndpointConfig, withholdSecrets, runLoop, type LoopEvent, type Transport } from "../packages/core/src/index.js";
import { CORE_TOOLS, CORE_TOOL_NAMES } from "../packages/tools/src/index.js";
import { ToolExecutor } from "../packages/cli/src/executor.js";
import { policyForAgent } from "../packages/cli/src/policy.js";
import { buildSystemPrompt } from "../packages/cli/src/prompt.js";
import { McpSession, parseMcpConfig, HOST_SERVER_ID } from "../packages/mcp/src/index.js";

interface GradeSpec {
  files?: { path: string; equals: string }[];
  requiredMcpMethods?: { server: string; method: string }[];
  forbiddenCoreTools?: string[];
  forbiddenMcpMethods?: { server: string; method: string }[];
  finalIncludes?: string[];
  finalIncludesAny?: string[][];
  memory?: { file: string; entities?: Record<string, unknown>[]; relations?: Record<string, unknown>[] };
}
interface ToolTrace {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  repaired: boolean;
  validated: boolean;
  ok?: boolean;
  output?: string;
  elapsedMs?: number;
}

let redact = (text: string): string => text;
function argsFor(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--help") { flags.set("help", "true"); continue; }
    if (!key.startsWith("--") || argv[i + 1] === undefined) throw new Error(`Expected --flag value, got ${key}`);
    flags.set(key.slice(2), argv[++i]!);
  }
  return flags;
}
function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return value;
}
function within(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Ground-truth files must be inside the evaluation working directory.");
  return absolute;
}
function sourceFingerprint(): { sha256: string; files: Record<string, string> } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = ["scripts/mcp-live-eval.ts", "packages/cli/src/executor.ts", "packages/cli/src/policy.ts", "packages/cli/src/prompt.ts", "packages/core/src/loop.ts", "packages/core/src/transport.ts", "packages/tools/src/schemas.ts", "packages/protocol/src/codec.ts", "packages/protocol/src/channel.ts"];
  for (const file of readdirSync(resolve(root, "packages/mcp/src"))) if (file.endsWith(".ts")) paths.push(`packages/mcp/src/${file}`);
  const files: Record<string, string> = {};
  for (const path of paths.sort()) files[path] = createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
function grade(spec: GradeSpec, cwd: string, tools: ToolTrace[], final: string): { passed: boolean; checks: { name: string; passed: boolean; detail?: string }[] } {
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  const successfulMcp = tools.filter((tool) => tool.name === "mcp" && tool.ok && tool.arguments.server !== HOST_SERVER_ID);
  checks.push({ name: "at least one successful remote MCP call", passed: successfulMcp.length > 0 });
  for (const expected of spec.requiredMcpMethods ?? []) checks.push({ name: `MCP ${expected.server}/${expected.method}`, passed: successfulMcp.some((tool) => tool.arguments.server === expected.server && tool.arguments.method === expected.method) });
  for (const forbidden of spec.forbiddenCoreTools ?? ["bash", "write", "apply_patch", "read", "term", "task", "skill"]) checks.push({ name: `no native ${forbidden} shortcut`, passed: !tools.some((tool) => tool.name === forbidden) });
  for (const forbidden of spec.forbiddenMcpMethods ?? []) checks.push({ name: `no MCP ${forbidden.server}/${forbidden.method} shortcut`, passed: !tools.some((tool) => tool.name === "mcp" && tool.arguments.server === forbidden.server && tool.arguments.method === forbidden.method) });
  for (const expected of spec.files ?? []) {
    const file = within(cwd, expected.path);
    const actual = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    checks.push({ name: `exact file ${expected.path}`, passed: actual === expected.equals, detail: actual === undefined ? "missing" : `${Buffer.byteLength(actual)} UTF-8 bytes` });
  }
  for (const expected of spec.finalIncludes ?? []) checks.push({ name: `final answer includes ${expected}`, passed: final.includes(expected) });
  for (const alternatives of spec.finalIncludesAny ?? []) checks.push({ name: `final answer includes one of ${alternatives.join(" | ")}`, passed: alternatives.some((expected) => final.includes(expected)) });
  if (spec.memory) {
    const file = within(cwd, spec.memory.file);
    let records: Record<string, unknown>[] = [];
    try { records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
    catch { checks.push({ name: "memory store readable JSONL", passed: false }); }
    for (const expected of spec.memory.entities ?? []) checks.push({ name: `memory entity ${String(expected.name)}`, passed: records.some((record) => record.type === "entity" && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(record[key], value))) });
    for (const expected of spec.memory.relations ?? []) checks.push({ name: `memory relation ${String(expected.from)} -> ${String(expected.to)}`, passed: records.some((record) => record.type === "relation" && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(record[key], value))) });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

async function main(): Promise<void> {
  const flags = argsFor(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write("Usage: pnpm exec tsx scripts/mcp-live-eval.ts --config FILE --cwd SCRATCH --task-file FILE --output FILE [--grade-file FILE] [--mode prefetch|catalog|search] [--seed 101] [--max-turns 6] [--timeout-ms 300000] [--max-output-tokens 4096] [--replay-first-content FILE]\nThe replay option injects one recorded prose response, then uses the live model. Evidence labels it separately; it is not a natural live trial.\n");
    return;
  }
  for (const required of ["config", "cwd", "output"]) if (!flags.has(required)) throw new Error(`--${required} is required`);
  const cwd = resolve(flags.get("cwd")!);
  const output = resolve(flags.get("output")!);
  const configPath = resolve(flags.get("config")!);
  const mode = flags.get("mode") ?? "prefetch";
  if (!["prefetch", "catalog", "search"].includes(mode)) throw new Error("--mode must be prefetch, catalog, or search");
  const task = flags.has("task-file") ? readFileSync(resolve(flags.get("task-file")!), "utf8") : flags.get("task");
  if (!task?.trim()) throw new Error("--task or --task-file must provide a non-empty task");
  const maxTurns = boundedNumber(flags.get("max-turns"), 6, 1, 30);
  const seed = boundedNumber(flags.get("seed"), 101, 0, 2147483647);
  const timeout = boundedNumber(flags.get("timeout-ms"), 300000, 1000, 900000);
  const maxOutputTokens = boundedNumber(flags.get("max-output-tokens"), 4096, 128, 16384);
  const replayContent = flags.has("replay-first-content") ? readFileSync(resolve(flags.get("replay-first-content")!), "utf8") : undefined;
  if (replayContent !== undefined && (!replayContent.trim() || replayContent.length > 65_536)) throw new Error("Replay content must be non-empty and at most 65536 characters");
  const spec: GradeSpec = flags.has("grade-file") ? JSON.parse(readFileSync(resolve(flags.get("grade-file")!), "utf8")) as GradeSpec : {};
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const configText = readFileSync(configPath, "utf8");
  const config = parseMcpConfig(configText, configPath);
  if (config.diagnostics.some((item) => item.severity === "error")) throw new Error(`Invalid MCP configuration: ${config.diagnostics.map((item) => item.code).join(", ")}`);
  // The explicit fixture config is the harness operator's authorization; credentials remain late-bound.
  const connection = resolveEndpointConfig({
    flags: { ...(flags.has("endpoint") ? { endpoint: flags.get("endpoint")! } : {}), ...(flags.has("model") ? { model: flags.get("model")! } : {}) },
    dotenvPaths: defaultDotenvPaths(cwd),
  });
  if (!connection.apiKey && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/u.test(connection.endpoint)) throw new Error("No model API credential configured");
  const secret = connection.apiKey;
  redact = (text) => secret ? text.split(secret).join("[REDACTED]") : text;
  withholdSecrets(process.env);
  const session = new McpSession(config, { exposure: mode as "prefetch" | "catalog" | "search" });
  const source = sourceFingerprint();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  const requests: Record<string, unknown>[] = [];
  const usages: Record<string, unknown>[] = [];
  const toolTrace: ToolTrace[] = [];
  const failures: Record<string, unknown>[] = [];
  let currentTurn = 0;
  let reasoningCharacters = 0;
  const http = new HttpTransport({ endpoint: connection.endpoint, model: connection.model, ...(secret ? { apiKey: secret } : {}), requestTimeoutMs: timeout });
  const transport: Transport = {
    endpoint: http.endpoint, model: http.model,
    complete: async (request) => {
      const at = Date.now();
      const index = requests.length + 1;
      if (index > maxTurns) throw new Error("Evaluation request budget exceeded");
      const replay = index === 1 && replayContent !== undefined;
      const item: Record<string, unknown> = { index, startedMs: at - started, source: replay ? "replayed_content" : "live_model" };
      requests.push(item);
      if (replay) {
        Object.assign(item, { elapsedMs: 0, finishReason: "stop", contentCharacters: replayContent.length, nativeToolCallCount: 0 });
        return { content: replayContent, reasoningContent: "", rawText: replayContent, ms: 0, finishReason: "stop" };
      }
      try {
        const response = await http.complete({ ...request, onDelta: (delta) => {
          if (item.firstDeltaMs === undefined && (delta.reasoning || delta.content || delta.tool)) item.firstDeltaMs = Date.now() - at;
          if (item.firstMeaningfulDeltaMs === undefined && (delta.content || delta.tool)) item.firstMeaningfulDeltaMs = Date.now() - at;
          request.onDelta?.(delta);
        } });
        Object.assign(item, { elapsedMs: Date.now() - at, finishReason: response.finishReason, reasoningCharacters: response.reasoningContent?.length ?? 0, contentCharacters: response.content.length, nativeToolCallCount: response.toolCalls?.length ?? 0, usage: response.usage });
        return response;
      } catch (err) { Object.assign(item, { elapsedMs: Date.now() - at, error: redact(err instanceof Error ? err.message : String(err)) }); throw err; }
    },
  };
  const emit = (event: LoopEvent): void => {
    if (event.type === "turn_start") currentTurn = event.turn;
    else if (event.type === "usage") usages.push({ turn: currentTurn, ...event });
    else if (event.type === "reasoning_end") reasoningCharacters += event.chars;
    else if (event.type === "tool_start") toolTrace.push({ ...event.call });
    else if (event.type === "tool_end") {
      const tool = toolTrace.find((candidate) => candidate.id === event.id);
      if (tool) Object.assign(tool, { ok: event.ok, output: event.output, elapsedMs: event.ms });
    } else if (event.type === "parse_failure") failures.push({ type: event.type, kind: event.kind, sampleCharacters: event.sample.length });
    else if (event.type === "repair") failures.push({ type: event.type, kind: event.kind, attempt: event.attempt });
    else if (event.type === "notice" && event.level === "error") failures.push({ type: event.type, text: event.text });
    // No stream, reasoning_delta, plan, transcript, or compaction text is persisted.
  };
  const executor = new ToolExecutor({
    cwd,
    policy: policyForAgent({ root: cwd, tools: [...CORE_TOOL_NAMES], readOnly: false }),
    callMcp: (server, method, values, signal, observe) => session.invoke(server, method, values, { scopeId: "evaluation-root", signal, observe }),
  });
  let summary = "", reason = "harness_error", turns = 0, fatal: string | undefined;
  let contextBytes = 0;
  try {
    const context = await session.prepare(task, controller.signal, "evaluation-root");
    contextBytes = Buffer.byteLength(context);
    const result = await runLoop({
      transport, tools: [...CORE_TOOLS],
      system: (channel) => buildSystemPrompt({ mode: "chat", channel, tools: [...CORE_TOOLS], cwd }),
      userTask: task, context, executor, emit,
      replyRecovery: (content) => session.replyRecovery(content),
      scopeId: "evaluation-root", repo: { cwd }, channel: "toolcall", channelPolicy: "fixed",
      maxTurns, maxServerRetries: 0, maxOutputTokens, seed, temperature: 1, topP: 0.95,
      replyEnds: true, confirmDone: false, stream: true, signal: controller.signal,
    });
    summary = result.summary ?? ""; reason = result.reason; turns = result.turns;
  } catch (err) { fatal = redact(err instanceof Error ? err.message : String(err)); }
  finally { clearTimeout(timeoutId); executor.close(); await session.close(); }
  const grading = grade(spec, cwd, toolTrace, summary);
  const totals = {
    promptTokens: usages.reduce((sum, entry) => sum + Number(entry.promptTokens ?? 0), 0),
    completionTokens: usages.reduce((sum, entry) => sum + Number(entry.completionTokens ?? 0), 0),
    cachedTokens: usages.reduce((sum, entry) => sum + Number(entry.cachedTokens ?? 0), 0),
  };
  const report = {
    version: 1, timestamp: new Date().toISOString(), model: connection.model, node: process.version, source,
    mode, seed, task, configSha256: createHash("sha256").update(configText).digest("hex"),
    ...(replayContent !== undefined ? { faultInjection: { kind: "replay_first_content", sha256: createHash("sha256").update(replayContent).digest("hex"), characters: replayContent.length } } : {}),
    servers: config.servers.map((server) => ({ id: server.id, transport: server.transport, protocol: server.protocol, ...(server.profile ? { profile: server.profile } : {}) })),
    nativeTools: CORE_TOOL_NAMES, maxTurns, maxOutputTokens, timeoutMs: timeout,
    elapsedMs: Date.now() - started, contextBytes, requests, liveModelRequests: requests.filter((request) => request.source === "live_model").length, usage: { ...totals, perTurn: usages },
    reasoningCharacters, toolTrace, failures, finalAnswer: summary, reason, turns,
    ...(fatal ? { fatal } : {}), grade: { ...grading, passed: reason === "done" && !fatal && grading.passed },
    limitations: ["No reasoning text is recorded.", "A successful model answer alone is insufficient: grade checks remote MCP tool traces and supplied ground truth.", "Usage totals include only reported successful response usage; absent usage is not proven zero cost."],
  };
  writeFileSync(output, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ output, reason, requests: requests.length, modelMcpDispatches: toolTrace.filter((call) => call.name === "mcp" && call.arguments.server !== HOST_SERVER_ID).length, passed: report.grade.passed, elapsedMs: report.elapsedMs }) + "\n");
  if (!report.grade.passed) process.exitCode = 1;
}

main().catch((err: unknown) => { process.stderr.write(redact(err instanceof Error ? err.message : String(err)) + "\n"); process.exitCode = 1; });
