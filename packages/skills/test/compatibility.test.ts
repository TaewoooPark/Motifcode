import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkill, parseSkill, SkillRegistry, MAX_SKILL_BYTES, substituteSkillArguments } from "../src/index.js";

const parse = (meta: string, body = "THE_BODY") => parseSkill(`---\nname: probe\ndescription: probe description\n${meta}\n---\n${body}`);
function bundle(): string { const path = mkdtempSync(join(tmpdir(), "motif-skill-")); mkdirSync(join(path, "agents")); return path; }

describe("upstream skill compatibility", () => {
  it("parses real YAML without treating nested metadata as root fields", () => {
    const skill = parseSkill('\uFEFF---\r\nname: example\r\ndescription: >-\r\n  Explain quoted "words":\r\n  and this second line.\r\ntags: [alpha, beta]\r\nmetadata:\r\n  name: keep-nested\r\nlicense: MIT\r\n---\r\nBODY\r\n');
    expect(skill.name).toBe("example");
    expect(skill.description).toBe('Explain quoted "words": and this second line.');
    expect(skill.tags).toEqual(["alpha", "beta"]);
    expect(skill.metadata).toMatchObject({ license: "MIT", metadata: { name: "keep-nested" } });
    expect(skill.body).toBe("BODY\r\n");
  });

  it("rejects malformed YAML, duplicate keys and invalid invocation flags", () => {
    expect(() => parse('description: duplicate')).toThrow(/unique|already|duplicate/i);
    expect(() => parse('metadata: [broken')).toThrow();
    expect(() => parse('disable-model-invocation: someday')).toThrow(/boolean/);
    expect(() => parse('budget: -1')).toThrow(/positive/);
  });

  it("loads folder-name fallbacks and Codex sibling metadata", () => {
    const dir = bundle();
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: plain skill\n---\nBODY");
    writeFileSync(join(dir, "agents/openai.yaml"), 'interface:\n  display_name: Helpful Skill\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: example\n');
    const skill = loadSkill(join(dir, "SKILL.md"), "user");
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.userInvocable).toBe(true);
    expect(skill.baseDir).toBe(realpathSync(dir));
    expect(skill.openai?.interface).toEqual({ display_name: "Helpful Skill" });
    expect(skill.diagnostics.map(d => d.code)).toContain("tool-dependencies");
    const reg = new SkillRegistry(); reg.register(skill);
    expect(reg.index()).not.toContain(skill.name);
    expect(reg.load(skill.name, { invocation: "model" }).ok).toBe(false);
    expect(reg.load(skill.name, { invocation: "user" }).output).toContain("BODY");
  });

  it("rejects optional metadata that escapes the skill package", () => {
    const dir = bundle(); const external = bundle();
    writeFileSync(join(dir, "SKILL.md"), "---\nname: probe\ndescription: d\n---\nBODY");
    writeFileSync(join(external, "private.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    symlinkSync(join(external, "private.yaml"), join(dir, "agents/openai.yaml"));
    expect(() => loadSkill(join(dir, "SKILL.md"))).toThrow(/escapes/);
  });

  it("normalizes a real-world YAML sequence argument hint", () => {
    expect(parse("argument-hint: [topic]").argumentHint).toBe("[topic]");
  });

  it.each(['allowed-tools: Read Bash(git status *)', 'allowed-tools: [Read, Bash]', 'allowed-tools:\n  - Read\n  - Bash'])('retains requested tools without changing invocation capability: %s', metadata => {
    const skill = parse(metadata);
    expect(skill.allowedTools.length).toBeGreaterThan(0);
    expect(skill.diagnostics).toContainEqual(expect.objectContaining({ code: "tool-preapproval", severity: "warning" }));
    const registry = new SkillRegistry(); registry.register(skill);
    expect(registry.load("probe", { invocation: "model" }).ok).toBe(true);
  });

  it.each(['context: fork', 'agent: Explore', 'model: opus', 'hooks:\n  PreToolUse: []', 'disallowed-tools: Bash'])('keeps unsupported behavior explicit and refuses silent downgrade: %s', metadata => {
    const reg = new SkillRegistry(); reg.register(parse(metadata));
    expect(reg.index()).not.toContain("probe");
    const result = reg.load("probe", { invocation: "user" });
    expect(result.ok).toBe(false); expect(result.output).toContain("compatibility changes");
  });

  it("blocks executable preprocessing without ever running it", () => {
    const reg = new SkillRegistry(); reg.register(parse("", 'Read this !`touch /should-never-exist`'));
    expect(reg.load("probe", { invocation: "user" })).toMatchObject({ ok: false, output: expect.stringContaining("never run") });
  });

  it("separates model and user discovery and invocation", () => {
    const reg = new SkillRegistry();
    reg.register(parse('disable-model-invocation: true'));
    expect(reg.listFor("user").map(s=>s.name)).toEqual(["probe"]);
    expect(reg.index()).toBe("");
    expect(reg.load("probe", { invocation: "model" }).ok).toBe(false);
    expect(reg.load("probe", { invocation: "user" }).ok).toBe(true);
    reg.register(parse('user-invocable: false'));
    expect(reg.listFor("user")).toEqual([]);
    expect(reg.index()).toContain("probe");
    expect(reg.load("probe", { invocation: "user" }).ok).toBe(false);
    expect(reg.load("probe", { invocation: "model" }).ok).toBe(true);
  });

  it("substitutes quoted positional, whole and named arguments in one pass", () => {
    const input = '"hello world" \'$ARGUMENTS literal\' tail';
    expect(substituteSkillArguments('all=$ARGUMENTS; first=$0; second=$ARGUMENTS[1]; named=$issue; absent=$9; escaped=\\$0', input, ["issue"])).toBe(`all=${input}; first=hello world; second=$ARGUMENTS literal; named=hello world; absent=$9; escaped=$0`);
    expect(substituteSkillArguments("unchanged", "hello")).toBe("unchanged\n\nInput from the person:\nhello");
    expect(()=>substituteSkillArguments("$0", '\"unfinished')).toThrow(/unterminated/);
  });

  it("includes source and bundle roots, resolves host variables, and preserves literal input", () => {
    const dir = bundle(); const child = join(dir,"skills/probe"); mkdirSync(child,{recursive:true});
    writeFileSync(join(child,"SKILL.md"), '---\nname: probe\ndescription: d\n---\n${CLAUDE_SKILL_DIR}/scripts/check.py\n${CLAUDE_PLUGIN_ROOT}/references/manual.md\n${CLAUDE_PROJECT_DIR}\n$ARGUMENTS');
    const skill = loadSkill(join(child,"SKILL.md"), "user", {packageRoot:dir,registrationName:"plugin:probe"});
    expect(skill.originalName).toBe("probe");
    const reg = new SkillRegistry();reg.register(skill);
    const result=reg.load(skill.name,{invocation:"user",arguments:"${CLAUDE_PROJECT_DIR}",cwd:"/project"});
    expect(result.ok).toBe(true);expect(result.output).toContain(`${realpathSync(child)}/scripts/check.py`);
    expect(result.output).toContain(`${realpathSync(dir)}/references/manual.md`);
    expect(result.output).toContain("/project\n${CLAUDE_PROJECT_DIR}");
  });

  it("grants only invoked bundle reads and does not follow resource escapes", () => {
    const dir=bundle();const outside=bundle();writeFileSync(join(dir,"SKILL.md"),'---\nname: probe\ndescription: d\n---\nbody');
    writeFileSync(join(dir,"reference.md"),"RESOURCE");writeFileSync(join(outside,"secret.md"),"SECRET");symlinkSync(join(outside,"secret.md"),join(dir,"escape.md"));
    const reg=new SkillRegistry();reg.register(loadSkill(join(dir,"SKILL.md"),"user"));
    expect(reg.canReadResource(join(dir,"reference.md"),"/")).toBe(false);
    expect(reg.load("probe",{invocation:"user"}).ok).toBe(true);
    expect(reg.canReadResource(join(dir,"reference.md"),"/")).toBe(true);
    expect(reg.canReadResource(join(dir,"escape.md"),"/")).toBe(false);
    expect(reg.canReadResource(join(outside,"secret.md"),"/")).toBe(false);
  });

  it("restores only complete source-matched resource context from checkpoints", () => {
    const dir=bundle();writeFileSync(join(dir,"SKILL.md"),'---\nname: probe\ndescription: d\n---\nBODY');writeFileSync(join(dir,"reference.md"),"R");
    const skill=loadSkill(join(dir,"SKILL.md"));const original=new SkillRegistry();original.register(skill);
    const output=original.load("probe",{invocation:"user"}).output;
    const resumed=new SkillRegistry();resumed.register(skill);
    resumed.restoreResourceAccess([{role:"assistant",content:output},{role:"user",content:"I used probe"},{role:"tool",content:output},{role:"tool",content:output.replace(skill.filePath!,"/different/SKILL.md")},{role:"user",content:output.replace("</skill>","")}]);
    expect(resumed.resourceRoots()).toEqual([]);
    resumed.restoreResourceAccess([{role:"user",content:output}]);
    expect(resumed.canReadResource(join(dir,"reference.md"),"/")).toBe(true);
    const modelResume=new SkillRegistry();modelResume.register(skill);
    modelResume.restoreResourceAccess([{role:"assistant",tool_calls:[{id:"load-1",function:{name:"skill",arguments:{name:"probe"}}}]},{role:"tool",tool_call_id:"load-1",content:output}]);
    expect(modelResume.canReadResource(join(dir,"reference.md"),"/")).toBe(true);
  });

  it("rejects unknown, over-budget and oversized expansions without partial instructions", () => {
    const reg = new SkillRegistry();reg.register(parse("budget: 1", "LONG_BODY"));
    expect(reg.load("unknown").ok).toBe(false);expect(reg.load("probe").ok).toBe(false);
    reg.register(parse("", "$ARGUMENTS"));
    const result = reg.load("probe", {invocation:"user",arguments:"큰".repeat(MAX_SKILL_BYTES)});
    expect(result.ok).toBe(false);expect(result.output).not.toContain("<skill");
    expect(result.output).toContain("injection limit");
  });
});
