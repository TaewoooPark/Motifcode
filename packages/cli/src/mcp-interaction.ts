import type { McpElicitationRequest, McpElicitationResponse } from "@motifcode/mcp";
import { externalUrl, openExternalUrl } from "./browser-open.js";

export interface McpHumanUi {
  choose(title: string, lines: string[], options: string[]): Promise<number | null>;
  input(title: string, lines: string[], prompt: string): Promise<string | null>;
  openBrowser?: (url: URL) => Promise<void>;
}
const label = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);

/** Values go directly from the human to the server, never through a model prompt. */
export async function requestMcpInteraction(request: McpElicitationRequest, ui: McpHumanUi): Promise<McpElicitationResponse> {
  if (request.signal.aborted) return { action: "cancel" };
  const title = `${label(request.server)} needs your input`;
  if (request.mode === "url") {
    let url: URL;
    try { url = externalUrl(request.url); } catch { return { action: "decline" }; }
    const open = await ui.choose(title, [label(request.message), `Open ${url.origin} in your browser?`, "Complete authorization there. No credentials are sent to the model."], ["1. Open browser", "2. Decline"]);
    if (request.signal.aborted || open === null) return { action: "cancel" };
    if (open !== 0) return { action: "decline" };
    try { await (ui.openBrowser ?? openExternalUrl)(url); } catch { return { action: "cancel" }; }
    if (request.signal.aborted) return { action: "cancel" };
    const done = await ui.choose(title, ["Finish the provider's authorization in the browser first.", "Only continue when it reports success."], ["1. Authorization completed", "2. Cancel"]);
    return { action: !request.signal.aborted && done === 0 ? "accept" : "cancel" };
  }
  const schema = request.requestedSchema;
  const fields = Object.entries(schema.properties ?? {});
  if (fields.length > 16 || fields.some(([name, value]) => /password|secret|access.?token|api.?key/i.test(name) || ("format" in value && String(value.format) === "password"))) return { action: "decline" };
  const accepted = await ui.choose(title, [label(request.message), "Your response is sent directly to this MCP server."], ["1. Continue", "2. Decline"]);
  if (request.signal.aborted || accepted === null) return { action: "cancel" };
  if (accepted !== 0) return { action: "decline" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [name, field] of fields) {
    if (request.signal.aborted) return { action: "cancel" };
    const lines = [label(field.description ?? name), schema.required?.includes(name) ? "Required" : "Optional: leave empty to skip"];
    if (field.type === "boolean") {
      const answer = await ui.choose(label(field.title ?? name), lines, ["1. Yes", "2. No", ...(!schema.required?.includes(name) ? ["3. Skip"] : [])]);
      if (answer === null || request.signal.aborted) return { action: "cancel" };
      if (answer < 2) content[name] = answer === 0;
    } else {
      const raw = await ui.input(label(field.title ?? name), [...lines, ...("enum" in field && Array.isArray(field.enum) ? [`Choices: ${field.enum.map(String).map(label).join(", ")}`] : []), ...(field.type === "array" ? ['Enter a JSON array of choices, e.g. ["first"].'] : [])], "response › ");
      if (raw === null || request.signal.aborted) return { action: "cancel" };
      if (!raw && !schema.required?.includes(name)) continue;
      if (field.type === "number" || field.type === "integer") {
        const number = Number(raw);
        if (!raw.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) return { action: "decline" };
        content[name] = number;
      } else if (field.type === "array") {
        try { const values: unknown = JSON.parse(raw); if (!Array.isArray(values) || !values.every(value => typeof value === "string")) return { action: "decline" }; content[name] = values; } catch { return { action: "decline" }; }
      } else if (field.type === "string") content[name] = raw;
      else return { action: "decline" };
    }
  }
  return request.signal.aborted ? { action: "cancel" } : { action: "accept", content };
}
