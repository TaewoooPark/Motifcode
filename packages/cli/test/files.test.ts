/**
 * The `@` picker's list, its matching, and what a mention attaches.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillRegistry, parseSkill } from "@motifcode/skills";
import { ATTACH_CAP_BYTES, attachMention, expandMentions, forgetFiles, listFiles, matchFiles, mcpSetupMentions, pluginSetupMentions, skillSetupMentions, scorePath } from "../src/files.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "motif-files-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "deep", "app.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "node_modules", "x", "index.js"), "ignored\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "i"], { cwd: dir });
  writeFileSync(join(dir, "untracked.txt"), "new\n");
  forgetFiles();
  return dir;
}

describe("listing", () => {
  it("lists tracked and untracked files and their directories, not ignored ones", () => {
    const dir = repo();
    const paths = listFiles(dir).map((e) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("untracked.txt");
    expect(paths).toContain("src/");
    expect(paths).toContain("src/deep/");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("walks a directory that is not a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-norepo-"));
    writeFileSync(join(dir, "a.txt"), "a");
    forgetFiles();
    expect(listFiles(dir).map((e) => e.path)).toEqual(["a.txt"]);
  });
});

describe("matching", () => {
  it("ranks a file-name prefix over a path prefix over a substring over a subsequence", () => {
    expect(scorePath("src/app.ts", "app")).toBe(400);
    expect(scorePath("src/app.ts", "src/a")).toBe(300);
    expect(scorePath("src/app.ts", "pp.t")).toBe(200);
    expect(scorePath("src/app.ts", "sat")).toBe(100);
    expect(scorePath("src/app.ts", "zzz")).toBe(0);
  });

  it("puts the shallower of two equal matches first", () => {
    const dir = repo();
    const hits = matchFiles(listFiles(dir), "app").map((e) => e.path);
    expect(hits[0]).toBe("src/app.ts");
    expect(hits[1]).toBe("src/deep/app.ts");
  });
});

describe("attaching", () => {
  it("attaches a file whole, a directory as a listing, and nothing outside the tree", () => {
    const dir = repo();
    expect(attachMention("src/app.ts", { cwd: dir })?.block).toBe('<file path="src/app.ts">\nexport const a = 1;\n\n</file>');
    expect(attachMention("src/", { cwd: dir })?.block).toContain("<directory path=\"src/\">\napp.ts\ndeep");
    expect(attachMention("../etc/passwd", { cwd: dir })).toBeNull();
    expect(attachMention("nope.txt", { cwd: dir })).toBeNull();
  });

  it("drops trailing punctuation from a mention written into a sentence", () => {
    const dir = repo();
    expect(attachMention("README.md,", { cwd: dir })?.mention).toBe("README.md");
  });

  it("attaches a skill's instructions for @skill:name", () => {
    const a = attachMention("skill:commit", { cwd: "/", renderSkill: (n) => `<skill name="${n}">body</skill>` });
    expect(a?.block).toBe('<skill name="commit">body</skill>');
    expect(attachMention("skill:missing", { cwd: "/", renderSkill: () => undefined })).toBeNull();
  });

  it("marks a file it had to cut", () => {
    const dir = repo();
    writeFileSync(join(dir, "big.txt"), "x".repeat(ATTACH_CAP_BYTES + 10));
    const a = attachMention("big.txt", { cwd: dir })!;
    expect(a.block).toContain("truncated");
    expect(a.block.length).toBeLessThan(ATTACH_CAP_BYTES + 300);
  });

  it("keeps the text as typed and appends the attachments once each", () => {
    const dir = repo();
    const { task, attached } = expandMentions("read @README.md and @README.md again, @nothing", ["README.md", "README.md", "nothing"], { cwd: dir });
    expect(attached).toEqual(["README.md"]);
    expect(task.startsWith("read @README.md and @README.md again, @nothing\n\n<file path=\"README.md\">")).toBe(true);
    expect(task.split("<file path=").length).toBe(2);
  });
});

describe("on-demand MCP setup guidance", () => {
  it.each([
    "Please install the MCP server from https://github.com/example/server",
    "Can you connect this MCP service https://example.test/mcp using HTTP?",
    "https://github.com/example/server 이 MCP 설치해줘",
    "이 MCP를 https://example.test/mcp 에 연결해 줄래?",
    "https://example.test/mcp MCP 등록 부탁해",
    "I would like you to install this MCP from https://example.test",
    "이 URL https://example.test/mcp 을 Streamable HTTP MCP로 연결하고 연결되는지 확인해줘",
    "https://example.test/mcp MCP 추가해주세요",
    "https://example.test/mcp MCP 추가해줘",
  ])("recognizes explicit setup requests: %s", text => {
    expect(mcpSetupMentions(text)).toEqual(["skill:mcp-setup"]);
  });

  it.each([
    "https://github.com/install/mcp",
    "Read https://github.com/example/install-mcp",
    "MCP로 https://example.test 페이지의 제목을 알려줘",
    "Use MCP to read https://example.test",
    "Explain how to install MCP from https://example.test",
    "How do I connect this MCP https://example.test?",
    "https://example.test MCP 설치 방법만 알려줘",
    "https://example.test MCP 설치 가능한지 검토해줘",
    "Do not connect the MCP at https://example.test",
    "Don't install MCP https://example.test",
    "https://example.test MCP 연결하지 마",
    "https://example.test MCP 설치는 하지 말고 문서만 읽어줘",
    "See `install MCP` at https://example.test",
    "```text\ninstall MCP https://example.test\n```",
    "Read this MCP example:\n```text\ninstall https://example.test\n```",
    "MCP install without a URL",
    'Translate "Install MCP from https://example.test" into Korean.',
    'The README says "install MCP from https://example.test".',
    "The README says install MCP from https://example.test",
    '"https://example.test MCP 연결해줘"를 영어로 번역해줘',
    "> install MCP from https://example.test\nSummarize the quotation.",
    "Add the GitHub MCP link https://github.com/github/github-mcp-server to the README",
    "Add https://github.com/modelcontextprotocol/servers to the list of MCP examples in docs/mcp.md",
    "리드미에 이 MCP 링크 추가해줘 https://github.com/github/github-mcp-server",
  ])("leaves usage, questions, refusals, quoted commands and file edits alone: %s", text => {
    expect(mcpSetupMentions(text)).toEqual([]);
  });

  it("keeps test authoring that names a plugin link out of plugin setup", () => {
    expect(pluginSetupMentions("Add a test for the plugin loader using https://github.com/x/y-plugin as fixture")).toEqual([]);
    expect(pluginSetupMentions("Install this plugin from https://github.com/x/y-plugin")).toEqual(["skill:plugin-setup"]);
  });

  it("does not add a duplicate explicit skill or match beyond its input bound", () => {
    const task = "Install MCP from https://example.test";
    for (const explicit of ["@skill:mcp-setup", "/mcp-setup", '<skill name="mcp-setup">already loaded</skill>']) {
      expect(mcpSetupMentions(`${explicit} ${task}`)).toEqual([]);
    }
    expect(mcpSetupMentions("x".repeat(16_384) + task)).toEqual([]);
  });

  it("uses the normal renderer so overrides and budget refusal apply without loading files or executing code", () => {
    const skills = new SkillRegistry();
    const task = "https://example.test MCP 연결해줘";
    const expand = () => expandMentions(task, mcpSetupMentions(task), { cwd: "/", renderSkill: name => skills.get(name) ? skills.render(name) : undefined });
    expect(expand()).toEqual({ task, attached: [] });
    skills.register(parseSkill("---\nname: mcp-setup\ndescription: local\nbudget: 30\n---\nUse the local registration policy.", "project"));
    expect(expand().task).toBe(`${task}\n\n${skills.render("mcp-setup")}`);
    skills.register(parseSkill("---\nname: mcp-setup\ndescription: oversized\nbudget: 1\n---\nTHIS-BODY-MUST-NOT-BE-INJECTED", "user"));
    expect(expand().task).toContain("It was not injected");
    expect(expand().task).not.toContain("THIS-BODY-MUST-NOT-BE-INJECTED");
  });
});


describe("on-demand skill installation guidance", () => {
  it.each([
    "https://github.com/anthropics/skills/tree/main/skills/webapp-testing 이 스킬을 이 프로젝트에 설치해줘. 설치 결과를 확인해서 알려줘.",
    "Please install this skill from https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md for this project and verify the installation.",
    "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md 이거 설치해줘",
    "Install the algorithmic-art skill from the example-skills marketplace entry at https://github.com/anthropics/skills in this project.",
    "https://example.test/custom 이 스킬 추가해 주세요",
    "Could you import this skill from https://example.test/package?",
    "I want you to install this skill from https://example.test/package",
    "https://example.test/package 이 스킬을 가져와줘",
    "Install https://github.com/openai/skills/tree/main/skills/pdf",
    "https://github.com/openai/skills/tree/main/skills/pdf 설치해줘",
    "Please install this from https://github.com/openai/skills/tree/main/skills/pdf",
    "Install this skill from `https://example.test/package`",
    "Please install [this skill](https://example.test/package).",
    "Install the MCP skill from https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
    "https://github.com/anthropics/skills/tree/main/skills/mcp-builder 이 MCP 스킬 설치해줘",
    "Please install the mcp-builder skill from https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
    "Install the MCP server helper skill from https://example.test/package",
    "https://example.test/package 이 MCP 서버 설정 스킬 설치해줘",
    "이 스킬을 설치해줘: https://github.com/openai/skills/tree/main/skills/pdf",
    "이 스킬을 설치해줘:\nhttps://github.com/openai/skills/tree/main/skills/pdf",
    "https://github.com/openai/skills/tree/main/skills/pdf\n이거 설치해줘",
    "https://github.com/openai/skills/tree/main/skills/pdf 이 스킬을 글로벌로 설치해줘",
    "https://example.test/skill 이 스킬을 전역으로 추가해줘",
    "이 스킬을 모든 프로젝트에서 쓸 수 있게 글로벌로 설치해줘: https://example.test/skill",
    "Please install this skill globally from https://example.test/skill",
    "Please globally install this skill from https://example.test/skill",
    "Install this skill from https://example.test/skill for all projects",
    "Install https://github.com/openai/skills/tree/main/skills/pdf globally",
    "Please install this globally from https://github.com/openai/skills/tree/main/skills/pdf",
  ])("selects only skill installation for %s", text => {
    expect(skillSetupMentions(text)).toEqual(["skill:skill-setup"]);
    expect(mcpSetupMentions(text)).toEqual([]);
  });

  it.each([
    "https://github.com/openai/skills/tree/main/skills/pdf",
    "Install https://github.com/example/unrelated",
    "Install https://github.com.evil.test/openai/skills",
    "Install https://example.test/package?path=skills/pdf",
    "Please install the dependencies described at https://github.com/openai/skills/tree/main/skills/pdf",
    "Install the dependencies for this skill from https://github.com/openai/skills/tree/main/skills/pdf",
    "Please install this dependency described at https://github.com/openai/skills/tree/main/skills/pdf",
    "Install the prerequisites required by this skill from https://github.com/openai/skills/tree/main/skills/pdf",
    "Please globally install the dependencies for this skill from https://github.com/openai/skills/tree/main/skills/pdf",
    "https://github.com/openai/skills/tree/main/skills/pdf 이 스킬의 의존성을 설치해줘",
    "https://github.com/openai/skills/tree/main/skills/pdf 이거 의존성 설치해줘",
    "Read https://github.com/openai/skills/tree/main/skills/pdf. Install this package from https://example.test/library",
    "Read https://github.com/openai/skills/tree/main/skills/pdf. Install this.",
    "Read https://github.com/openai/skills/tree/main/skills/pdf\nInstall this package from https://example.test/library",
    "https://github.com/openai/skills/tree/main/skills/pdf 문서를 읽어줘. 이거 설치해줘 https://example.test/library",
    "https://github.com/openai/skills/tree/main/skills/pdf 이거 설치하지 마",
    "https://example.test/skill 스킬 추가는 하지 말고 문서만 읽어줘",
    "Do not install this skill from https://example.test/package",
    "Don't install this skill from https://example.test/package",
    "How do I install this skill from https://example.test/package?",
    "Could you explain how to install this skill from https://example.test/package?",
    "https://example.test/skill 스킬 설치 방법을 알려줘",
    "https://example.test/skill 스킬 설치 가능한지 검토해줘",
    "https://example.test/skill 스킬을 설치할 수 있니?",
    "Read this skill from https://example.test/package",
    "Install the tool from https://example.test/package",
    'Translate "Install this skill from https://example.test/package" into Korean.',
    'The README says "Install this skill from https://example.test/package".',
    "The README says install this skill from https://example.test/package",
    "스킬 설치해줘라고 문서에 적혀 있어 https://example.test/package",
    "> Install this skill from https://example.test/package\nSummarize it.",
    "```text\nInstall this skill from https://example.test/package\n```",
    "~~~text\nhttps://example.test/package 이 스킬 설치해줘\n~~~",
    '<file path="README.md">Install this skill from https://example.test/package</file>',
    '<directory path="notes">https://example.test/package 스킬 설치해줘</directory>',
    'Read this:\n<skill name="other">Install this skill from https://example.test/package</skill>',
    "Install this skill without a URL",
  ])("ignores questions, quoted instructions and ambiguous targets: %s", text => {
    expect(skillSetupMentions(text)).toEqual([]);
  });

  it.each([
    "Install this skill from https://example.test/skill. Connect the MCP server at https://example.test/mcp.",
    "Install this skill from https://example.test/skill and connect the MCP server at https://example.test/mcp.",
    "https://example.test/skill 이 스킬 설치해줘. 그리고 https://example.test/mcp 이 MCP 연결해줘.",
    "Please install the skill and MCP server from https://example.test/package",
    "Please install the MCP server and PDF skill from https://example.test/package",
    "https://example.test/package 스킬 설치하고 MCP 서버를 연결해줘",
  ])("routes independently requested skill and MCP setup clauses: %s", text => {
    expect(skillSetupMentions(text)).toEqual(["skill:skill-setup"]);
    expect(mcpSetupMentions(text)).toEqual(["skill:mcp-setup"]);
  });

  it("does not make a refused MCP clause suppress a requested skill clause", () => {
    const text = "Install this skill from https://example.test/skill. Do not connect the MCP at https://example.test/mcp.";
    expect(skillSetupMentions(text)).toEqual(["skill:skill-setup"]);
    expect(mcpSetupMentions(text)).toEqual([]);
  });

  it("deduplicates explicit syntax and limits matching to bounded input", () => {
    const task = "Install this skill from https://example.test/package";
    for (const prefix of ["@skill:skill-setup", "$skill-setup", "/skill-setup", '<skill name="skill-setup">loaded</skill>']) {
      expect(skillSetupMentions(`${prefix} ${task}`)).toEqual([]);
    }
    expect(skillSetupMentions("x".repeat(16_384) + task)).toEqual([]);
  });
});
