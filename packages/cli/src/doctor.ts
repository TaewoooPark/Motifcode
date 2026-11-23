/**
 * `motif doctor`.
 *
 * Bad output from this model is very often the endpoint rather than the model,
 * and the failure is silent in every case: a server without the vendor's
 * tool-call parser leaves `<tool_call>` text in the body, reasoning that is
 * not separated ends up in the transcript, near-greedy sampling quietly puts
 * you in a different regime from the published numbers. A user who hits any of
 * those blames the weights.
 *
 * On a hosted endpoint the flags are not the user's to set, so this does not
 * recite them. It checks native chat and text completions. For the OpenRouter
 * preset it also verifies each experimental body format with an in-memory tool.
 */

import { apiKeyEnvForEndpoint, HttpTransport, normalizeEndpoint, providerForEndpoint, runLoop, TransportError } from "@motifcode/core";
import { getCodec, MAX_CONTEXT, renderFor, SAMPLING_DEFAULTS, unwrapTool, type Message } from "@motifcode/protocol";
import { CORE_TOOLS } from "@motifcode/tools";
import { detectSandbox } from "./sandbox.js";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it. Absent when there is nothing to do. */
  fix?: string;
}

export interface DoctorOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Where the key came from, so a wrong file is findable from the output. */
  apiKeySource?: string;
  fetchImpl?: typeof fetch;
}

/** One entry of `/v1/models`, in the fields either vLLM or a router fills in. */
interface ModelRecord {
  id?: string;
  max_model_len?: number;
  context_length?: number;
  supports_function_calling?: boolean;
  supported_parameters?: string[];
  min_prompt_price?: number;
  min_completion_price?: number;
  providers?: { provider_slug?: string }[];
}

interface ModelsResponse {
  data?: ModelRecord[];
}

interface ProbeChoice {
  message?: {
    content?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: unknown[] | null;
  };
}

interface ProbeResponse {
  choices?: ProbeChoice[];
  usage?: { prompt_tokens_details?: { cached_tokens?: number } };
}

/** The one tool the probe registers: enough to see whether calls come back structured. */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "done",
    description: "Finish the task.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "One line." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
};

/** Decode and validate a single body turn without giving it a terminal. */
async function probeBodyChannel(
  channel: "object" | "raw",
  transport: HttpTransport,
): Promise<{ check: Check; routeAvailable?: boolean; status?: number }> {
  const name = `${channel} channel`;
  const tools = CORE_TOOLS.filter((tool) => unwrapTool(tool).name === "term");
  const codec = getCodec(channel);
  const system = codec.systemFragment(tools);
  const userTask = 'Propose one terminal input with the two keystrokes "OK", no newline, duration 0.1 seconds. The task is not complete.';
  const messages: Message[] = [{ role: "system", content: system }, { role: "user", content: userTask }];
  const request = codec.buildRequest(
    { messages, render: () => renderFor(channel, messages, tools) },
    tools,
    { maxTokens: 768 },
  );
  try {
    const response = await transport.complete(request);
    let count = 0;
    let exact = false;
    // Replay the one recorded response so even the loop's retry paths cannot
    // trigger more inference. Only actions past its normal gates reach run().
    await runLoop({
      channel,
      channelPolicy: "fixed",
      tools,
      system: () => system,
      userTask,
      maxTurns: 1,
      emit: () => {},
      transport: { endpoint: transport.endpoint, model: transport.model, complete: async () => response },
      executor: {
        run: async (call) => {
          count++;
          exact = call.name === "term" && call.arguments.keystrokes === "OK" && call.arguments.duration_s === 0.1;
          return { ok: true, output: "" };
        },
      },
    });
    let check: Check = { name, state: "unknown", detail: "the response yielded no validated action" };
    if (count === 1 && exact) {
      check = { name, state: "ok", detail: "the harness decoded and validated the requested action" };
    } else if (response.finishReason === "length") {
      check.detail = "the probe reached its output limit before a usable action";
    } else if (count > 0) {
      check = { name, state: "warn", detail: "the decoded actions did not match the requested input" };
    }
    return { check, routeAvailable: true };
  } catch (error) {
    const status = TransportError.is(error) ? error.status : undefined;
    const check: Check = { name, state: "unknown", detail: "probe request failed" };
    if (status === 404 || status === 405 || status === 501) {
      return { check: { ...check, detail: "completions unavailable for this model" }, routeAvailable: false, status };
    }
    if (TransportError.is(error) && error.kind === "protocol") {
      return { check: { ...check, detail: "invalid completion response" }, routeAvailable: true };
    }
    if (status) check.detail = `probe returned HTTP ${status}`;
    return { check, status };
  }
}

async function probeOpenRouterBodyChannels(transport: HttpTransport): Promise<Check[]> {
  const objectProbe = await probeBodyChannel("object", transport);
  // A missing route applies to both formats. Other failures can be specific to
  // the prompt or sampled answer, so probe each format independently.
  const rawProbe = objectProbe.routeAvailable === false
    ? { ...objectProbe, check: { ...objectProbe.check, name: "raw channel" } }
    : await probeBodyChannel("raw", transport);
  const probes = [objectProbe, rawProbe];
  const endpointCheck: Check = { name: "completions endpoint", state: "unknown", detail: "could not verify /v1/completions" };
  const missing = probes.find((probe) => probe.routeAvailable === false);
  if (probes.some((probe) => probe.routeAvailable)) {
    endpointCheck.state = "ok";
    endpointCheck.detail = "accepted a request to /v1/completions";
  } else if (missing) {
    endpointCheck.state = "warn";
    endpointCheck.detail = `not available for this model (${missing.status})`;
    endpointCheck.fix = "use the toolcall channel on this endpoint";
  }
  return [endpointCheck, objectProbe.check, rawProbe.check];
}

/** Keep the original one-token route check for Infron, Morphfactory and custom endpoints. */
async function probeCompletionsRoute(
  endpoint: string, model: string, headers: Record<string, string>, fetchImpl: typeof fetch,
): Promise<Check> {
  const name = "completions endpoint";
  try {
    const res = await fetchImpl(`${endpoint}/v1/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "hi", max_tokens: 1, stream: false }),
    });
    if (res.ok) return { name, state: "ok", detail: "available; the object and raw channels can run" };
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return {
        name,
        state: "warn",
        detail: `not available (${res.status})`,
        fix: "only the toolcall channel can run against this endpoint; --channel object|raw will fail on the first request",
      };
    }
    return { name, state: "unknown", detail: `answered ${res.status}` };
  } catch (err) {
    return { name, state: "unknown", detail: `failed: ${String(err)}` };
  }
}

export async function doctor(opts: DoctorOptions): Promise<Check[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const openRouter = providerForEndpoint(opts.endpoint) === "openrouter";
  const endpoint = openRouter ? normalizeEndpoint(opts.endpoint) : opts.endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  const checks: Check[] = [];
  const apiKeyEnv = apiKeyEnvForEndpoint(endpoint);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;

  // Reported whether or not a server is reachable: it decides whether a
  // read-only subagent can run anything at all, and a user who finds out at the
  // moment the explorer refuses will not know why.
  const sandbox = detectSandbox();
  checks.push(
    sandbox.kind === "none"
      ? {
          name: "sandbox",
          state: "warn",
          detail: `no read-only sandbox: ${sandbox.reason ?? "unavailable"}`,
          fix: "read-only subagents cannot run commands here; install bubblewrap on Linux, or use only writing agents",
        }
      : { name: "sandbox", state: "ok", detail: `read-only agents run under ${sandbox.kind}` },
  );

  // Also reported before touching the network. A missing key on a hosted
  // endpoint is the most likely reason nothing below works, and saying so
  // next to the 401 is better than leaving the user to connect the two.
  checks.push(
    opts.apiKey
      ? { name: "api key", state: "ok", detail: `present, from ${opts.apiKeySource ?? "the caller"}` }
      : {
          name: "api key",
          state: "warn",
          detail: "none — requests go out unauthenticated",
          fix: `set ${apiKeyEnv} in the environment or in a .env file (not needed for a local server without auth)`,
        },
  );

  let models: ModelsResponse | null = null;
  try {
    const res = await fetchImpl(`${endpoint}/v1/models`, { method: "GET", headers });
    if (res.ok) {
      models = (await res.json()) as ModelsResponse;
      checks.push({ name: "endpoint", state: "ok", detail: `${endpoint} responded` });
    } else {
      checks.push({
        name: "endpoint",
        state: "fail",
        detail: `${endpoint} returned ${res.status}`,
        fix:
          res.status === 401 || res.status === 403
            ? `the endpoint refused the credentials; check ${apiKeyEnv}`
            : "start the server, or point --endpoint somewhere else",
      });
      return checks;
    }
  } catch (err) {
    checks.push({
      name: "endpoint",
      state: "fail",
      detail: `${endpoint} unreachable (${String(err)})`,
      fix: "check the network, or point --endpoint somewhere else",
    });
    return checks;
  }

  // The requested model, found by id. A router lists hundreds of models and
  // the first one is not ours; reading `data[0]` reported a healthy Motif
  // endpoint as "does not look like Motif" and a wrong id as healthy.
  const listed = models?.data ?? [];
  const served = listed.find((m) => m.id === opts.model);
  if (served) {
    const provider = served.providers?.[0]?.provider_slug;
    const free = served.min_prompt_price === 0 && served.min_completion_price === 0;
    checks.push({
      name: "model",
      state: "ok",
      detail:
        `${opts.model} is listed` +
        (provider ? ` (provider ${provider})` : "") +
        (served.min_prompt_price !== undefined ? (free ? ", free tier" : ", metered") : ""),
    });
  } else {
    checks.push({
      name: "model",
      state: "warn",
      detail: `${opts.model} is not in the endpoint's list of ${listed.length} model(s)`,
      fix: "check --model / MOTIF_MODEL; the request may still route, but the id is not advertised",
    });
  }

  const isMotif = /motif/i.test(opts.model);
  checks.push({
    name: "model family",
    state: isMotif ? "ok" : "warn",
    detail: isMotif ? "a Motif checkpoint" : `"${opts.model}" does not look like Motif`,
    ...(isMotif
      ? {}
      : {
          fix: "this harness is built around Motif-3's template, parser quirks and tool semantics; other models will work badly",
        }),
  });

  const maxLen = served?.max_model_len ?? served?.context_length;
  if (maxLen !== undefined) {
    const full = maxLen >= MAX_CONTEXT;
    checks.push({
      name: "context length",
      state: full ? "ok" : "warn",
      detail: `${maxLen.toLocaleString()} of ${MAX_CONTEXT.toLocaleString()}`,
      ...(full ? {} : { fix: "the endpoint serves less than the native window; long sessions will compact or fail early" }),
    });
  }
  const supportsTools = served?.supports_function_calling ?? (openRouter ? served?.supported_parameters?.includes("tools") : undefined);
  if (supportsTools !== undefined) {
    checks.push(
      supportsTools
        ? { name: "function calling", state: "ok", detail: "advertised by the endpoint" }
        : {
            name: "function calling",
            state: "fail",
            detail: "the endpoint says this model has no function calling",
            fix: "the native channel needs it; this id will not work with the harness",
          },
    );
  }

  // The live probe. One request, one tool, an instruction that is hard to
  // misread. What comes back says whether the server runs a tool-call parser
  // and a reasoning parser — the two things that, absent, make every session
  // look like a model that cannot follow the format.
  // The same body both times, so the second request's prefix is byte-identical
  // to the first's — which is the only way the server has anything to report a
  // cache hit against.
  const probeBody = JSON.stringify({
    model: opts.model,
    temperature: SAMPLING_DEFAULTS.temperature,
    top_p: SAMPLING_DEFAULTS.top_p,
    stream: false,
    max_tokens: 256,
    messages: [
      { role: "system", content: "You are a coding agent. Finish by calling the `done` tool." },
      { role: "user", content: 'Call `done` now with the summary "ok". Do nothing else.' },
    ],
    tools: [PROBE_TOOL],
  });
  try {
    const res = await fetchImpl(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: probeBody,
    });
    if (res.status === 401 || res.status === 403) {
      const text = (await res.text().catch(() => "")).trim().slice(0, 200);
      checks.push({
        name: "authentication",
        state: "fail",
        detail: `the endpoint refused the request (${res.status}${text ? `: ${text}` : ""})`,
        fix: opts.apiKey ? `the key was sent and rejected; check ${apiKeyEnv}` : `set ${apiKeyEnv}`,
      });
      return checks;
    }
    if (res.status === 402 && openRouter) {
      checks.push({ name: "chat probe", state: "fail", detail: "OpenRouter returned 402 (insufficient credits).", fix: "Check the OpenRouter account balance and API key spending limit, then run doctor again." });
      return checks;
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).trim().slice(0, 200);
      checks.push({
        name: "chat probe",
        state: "warn",
        detail: `${res.status}${text ? `: ${text}` : ""}`,
        fix: "the endpoint answered the model list but not a chat request; check the model id and the endpoint's status",
      });
    } else {
      const json = (await res.json()) as ProbeResponse;
      const msg = json.choices?.[0]?.message;
      const content = typeof msg?.content === "string" ? msg.content : "";
      const structured = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      checks.push(
        structured
          ? { name: "tool-call parser", state: "ok", detail: "calls arrive as structured tool_calls" }
          : /<tool_call>/.test(content)
            ? {
                name: "tool-call parser",
                state: "warn",
                detail: "calls arrive as text in the body",
                fix: "the server is not running a tool-call parser; the harness's client-side repair ladder will parse them, but it only sees what is left in the body and the breakage budget will bind sooner",
              }
            : {
                name: "tool-call parser",
                state: "unknown",
                detail: "the probe produced no tool call",
                fix: "sampling is non-deterministic; run doctor again",
              },
      );
      const separated =
        (typeof msg?.reasoning === "string" && msg.reasoning !== "") ||
        (typeof msg?.reasoning_content === "string" && msg.reasoning_content !== "");
      checks.push(
        separated
          ? { name: "reasoning parser", state: "ok", detail: "reasoning arrives as its own field" }
          : /<\/think>/.test(content)
            ? {
                name: "reasoning parser",
                state: "warn",
                detail: "reasoning arrives inline in the content",
                fix: "the harness splits it client-side; that is a fallback, not the design",
              }
            : { name: "reasoning parser", state: "unknown", detail: "no reasoning in the probe response" },
      );
      // A single cold probe always reports zero cached tokens, which reads as
      // "caching is off" when it is merely the first request. So the same body
      // goes out a second time: on a caching server the shared prefix — the
      // tools block and the system turn, the bytes the frozen tool order exists
      // to keep alive — now comes back as a hit. `prompt_tokens_details` absent
      // altogether means the API does not report it at all.
      let cached = json.usage?.prompt_tokens_details?.cached_tokens;
      try {
        const again = await fetchImpl(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: probeBody,
        });
        if (again.ok) {
          const json2 = (await again.json()) as ProbeResponse;
          const c2 = json2.usage?.prompt_tokens_details?.cached_tokens;
          if (typeof c2 === "number") cached = c2;
        }
      } catch {
        // The first probe already answered the questions that matter; a failed
        // warm-up just leaves the cache figure as the cold one.
      }
      const reports = cached !== undefined;
      checks.push(
        typeof cached === "number" && cached > 0
          ? {
              name: "prefix caching",
              state: "ok",
              detail: `the endpoint served ${cached} prompt tokens from its prefix cache on a repeated request`,
            }
          : reports
            ? {
                name: "prefix caching",
                state: "unknown",
                detail: "the endpoint reports cached tokens but served none on this probe",
                fix: "a two-request probe cannot always warm the cache; in a real session the frozen tool order keeps the prefix alive across turns",
              }
            : {
                name: "prefix caching",
                state: "unknown",
                detail: "not reported by the API",
                fix: "the frozen, canonically ordered tool list exists to keep the cached prefix alive; whether the server caches cannot be seen from here",
              },
      );
    }
  } catch (err) {
    checks.push({ name: "chat probe", state: "warn", detail: `failed: ${String(err)}` });
  }

  if (openRouter) {
    const transport = new HttpTransport({ endpoint, model: opts.model, apiKey: opts.apiKey, fetchImpl });
    checks.push(...await probeOpenRouterBodyChannels(transport));
  } else {
    checks.push(await probeCompletionsRoute(endpoint, opts.model, headers, fetchImpl));
  }

  checks.push({
    name: "sampling",
    state: "ok",
    detail: `the harness sends temperature ${SAMPLING_DEFAULTS.temperature}, top_p ${SAMPLING_DEFAULTS.top_p}`,
    fix: "these are the model's published evaluation settings; near-greedy values are a different regime and will not reproduce its numbers",
  });

  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const mark: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗", unknown: "?" };
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${mark[c.state]} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.fix) lines.push(`    ${c.fix}`);
  }
  const bad = checks.filter((c) => c.state === "fail").length;
  const warn = checks.filter((c) => c.state === "warn").length;
  const unknown = checks.filter((c) => c.state === "unknown").length;
  lines.push("");
  lines.push(
    bad > 0
      ? `${bad} problem(s) to fix first.`
      : unknown > 0
        ? `Nothing broken. ${unknown} thing(s) the probe could not determine — see the notes above.`
        : warn > 0
          ? `Nothing broken. ${warn} thing(s) worth knowing — see the notes above.`
          : "All clear.",
  );
  return lines.join("\n");
}

export function worstState(checks: readonly Check[]): CheckState {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "warn")) return "warn";
  if (checks.some((c) => c.state === "unknown")) return "unknown";
  return "ok";
}
