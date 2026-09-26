const MAX_CONTENT_CHARS = 65_536;
const MAX_FENCES = 8;

const RECOVERY_FEEDBACK = [
  "This response contained MCP arguments but did not dispatch a tool call. Earlier calls may already have run; consult their results.",
  "If the original user authorized an unfinished action, use the registered mcp tool in the current tool-call format with those arguments after schema validation. Respect the original task and constraints.",
  "Do not repeat completed writes or operations whose execution is unknown. Never retry them blindly.",
  "If the JSON was an illustration or explanation, do not execute it; answer in ordinary prose without repeating invocation-shaped JSON.",
].join(" ");

interface Candidate { server: string; method: string }

function candidate(text: string): Candidate | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 3 || !keys.every((key) => key === "server" || key === "method" || key === "args")) return undefined;
  if (typeof object.server !== "string" || object.server.length === 0 || typeof object.method !== "string" || object.method.length === 0) return undefined;
  if (object.args === null || typeof object.args !== "object" || Array.isArray(object.args)) return undefined;
  return { server: object.server, method: object.method };
}

/**
 * Recognize a possible unissued MCP invocation; never turn prose into an action.
 * `knowsTool` must consult only an already-authorized local catalog snapshot.
 * The reply is static: model-supplied arguments never become harness instructions.
 */
export function mcpReplyRecovery(
  content: string,
  knowsTool: (server: string, method: string) => boolean,
): string | undefined {
  // Reject overlong content in full, rather than inventing a complete JSON block
  // by cutting off the rest of a response. All parsing below is bounded by this.
  if (content.length === 0 || content.length > MAX_CONTENT_CHARS) return undefined;
  const matches = (text: string): boolean => {
    const found = candidate(text);
    return found !== undefined && knowsTool(found.server, found.method);
  };
  if (matches(content.trim())) return RECOVERY_FEEDBACK;

  let fence: { ticks: number; json: boolean; lines: string[] } | undefined;
  let fences = 0;
  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]!.length >= fence.ticks) {
        if (fence.json && matches(fence.lines.join("\n"))) return RECOVERY_FEEDBACK;
        fence = undefined;
      } else if (fence.json) {
        fence.lines.push(line);
      }
      continue;
    }
    const opening = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
    if (!opening) continue;
    if (++fences > MAX_FENCES) return undefined;
    const language = opening[2]!.trim();
    fence = { ticks: opening[1]!.length, json: language === "" || language.toLowerCase() === "json", lines: [] };
  }
  return undefined;
}
