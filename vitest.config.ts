import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Mirrors tsconfig.json `paths`. Kept in sync by hand rather than by a plugin
  // so there is exactly one place to look when a workspace import fails.
  resolve: {
    alias: {
      "@motifcode/protocol": pkg("protocol"),
      "@motifcode/tools": pkg("tools"),
      "@motifcode/core": pkg("core"),
      "@motifcode/replay": pkg("replay"),
      "@motifcode/tui": pkg("tui"),
      "@motifcode/skills": pkg("skills"),
      "@motifcode/agents": pkg("agents"),
      "@motifcode/hooks": pkg("hooks"),
      "@motifcode/journal": pkg("journal"),
      "@motifcode/cli": pkg("cli"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
    environment: "node",
  },
});
