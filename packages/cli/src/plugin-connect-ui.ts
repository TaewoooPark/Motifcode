import { createInterface } from "node:readline/promises";
import type { SkillsCommandOptions } from "./skills-command.js";
import { connectMcpServers } from "./mcp-connect.js";

/** Shared by standalone skills/plugins commands; a model's pipe cannot answer prompts. */
export function pluginConnectionUi(signal?: AbortSignal): NonNullable<SkillsCommandOptions["connectionOptions"]> {
  return {
    signal,
    confirm: async plan => {
      if (!process.stdin.isTTY || !process.stderr.isTTY || signal?.aborted) return false;
      // The inspected plan contains no resolved credentials. Control characters
      // from a package cannot become terminal escape sequences.
      process.stderr.write(JSON.stringify(plan, null, 2).replace(/[\x1b\x7f-\x9f]/g, "") + "\n");
      const input = createInterface({ input: process.stdin, output: process.stderr });
      try { return /^(?:y|yes)$/i.test((await input.question("Register and start these reviewed connections? [y/N] ", { signal })).trim()); }
      catch { return false; }
      finally { input.close(); }
    },
    activate: (config, context) => connectMcpServers(config, { home: context.home, signal: context.signal, login: context.login, onProgress: message => process.stderr.write(message + "\n") }),
  };
}
