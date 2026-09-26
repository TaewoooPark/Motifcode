import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkill, parseSkill, SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS, toolPrefix } from "@motifcode/tools";
import { ToolExecutor } from "../src/executor.js";
import { fullPolicy, readOnlyPolicy } from "../src/policy.js";
import { expandSkillInput } from "../src/skill-input.js";
import { buildAgentPrompt, buildSystemPrompt } from "../src/prompt.js";

function registry(name = "probe", metadata = "", body = "BODY $0 / $ARGUMENTS[1] / $ARGUMENTS") {
  const skills = new SkillRegistry(); skills.register(parseSkill(`---\nname: ${name}\ndescription: discovery\n${metadata}\n---\n${body}`)); return skills;
}
const call=(name:string,args:Record<string,unknown>)=>({id:"1",name,arguments:args,repaired:false,validated:true as const});

describe("skill runtime boundaries", () => {
  it.each(['/probe "hello world" next','@skill:probe "hello world" next','$probe "hello world" next'])("shares complete argument expansion for %s", input => {
    const expanded=expandSkillInput(input,{cwd:"/",skills:registry()});
    expect(expanded.errors).toEqual([]);expect(expanded.task).toContain('BODY hello world / next / "hello world" next');
    expect(expanded.task.match(/<skill name="probe">/g)).toHaveLength(1);
  });

  it.each(["/probe it doesn't start", "@skill:probe it doesn't start", "$probe it doesn't start"])("accepts apostrophes in %s", input => {
    const expanded=expandSkillInput(input,{cwd:"/",skills:registry("probe","","Debug this.")});
    expect(expanded.errors).toEqual([]);expect(expanded.task).toContain("it doesn't start");
  });

  it("does not remove an invoked name's prefix from other argument tokens", () => {
    const expanded=expandSkillInput('$probe $probelong @skill:probelong',{cwd:"/",skills:registry()});
    expect(expanded.errors).toContainEqual(expect.stringContaining('No skill named "probelong"'));
    const ordinary=expandSkillInput('$probe $probelong',{cwd:"/",skills:registry()});
    expect(ordinary.task).toContain('BODY $probelong / $ARGUMENTS[1] / $probelong');
  });

  it("blocks explicit hidden skills and honors manual MCP setup policy", () => {
    const hidden=expandSkillInput('/probe x',{cwd:"/",skills:registry("probe","user-invocable: false")});
    expect(hidden.errors).toContainEqual(expect.stringContaining("user-invocable: false"));
    const manual=registry("mcp-setup","disable-model-invocation: true");
    const prompt="Install MCP from https://example.test/mcp";
    expect(expandSkillInput(prompt,{cwd:"/",skills:manual}).task).toBe(prompt);
    expect(expandSkillInput('/mcp-setup hi',{cwd:"/",skills:manual}).errors).toEqual([]);
  });


  it.each(["", "@skill:skill-setup ", "$skill-setup ", "/skill-setup "])("attaches the selected project setup guidance once for %s", prefix => {
    const skills = registry("skill-setup", "", "DEFAULT-SETUP");
    skills.register(parseSkill("---\nname: skill-setup\ndescription: project policy\nbudget: 40\n---\nPROJECT-SETUP", "project"));
    skills.register(parseSkill("---\nname: mcp-setup\ndescription: mcp policy\n---\nMCP-POLICY", "builtin"));
    const task = "Install the mcp-builder skill from https://github.com/anthropics/skills/tree/main/skills/mcp-builder";
    const result = expandSkillInput(prefix + task, { cwd: "/", skills });
    expect(result.errors).toEqual([]);
    expect(result.attached).toEqual(["skill:skill-setup"]);
    expect(result.task.match(/<skill name="skill-setup">/g)).toHaveLength(1);
    expect(result.task).toContain("PROJECT-SETUP");
    expect(result.task).not.toContain("DEFAULT-SETUP");
    expect(result.task).not.toContain("MCP-POLICY");
  });

  it("honors automatic capability, model-invocation policy and budget for skill setup", () => {
    const task = "https://example.test/skill 이 스킬 설치해줘";
    const automatic = registry("skill-setup", "", "SETUP-GUIDANCE");
    expect(expandSkillInput(task, { cwd: "/", skills: automatic, automatic: false })).toEqual({ task, attached: [], errors: [] });
    for (const metadata of ["disable-model-invocation: true", "budget: 1"]) {
      const skills = registry("skill-setup", metadata, "THIS-BODY-MUST-NOT-BE-INJECTED");
      expect(expandSkillInput(task, { cwd: "/", skills })).toEqual({ task, attached: [], errors: [] });
    }
    const manual = registry("skill-setup", "disable-model-invocation: true", "MANUAL-SETUP");
    expect(expandSkillInput("/skill-setup " + task, { cwd: "/", skills: manual }).task).toContain("MANUAL-SETUP");
    const hidden = registry("skill-setup", "user-invocable: false", "MODEL-ONLY-SETUP");
    expect(expandSkillInput(task, { cwd: "/", skills: hidden }).task).toContain("MODEL-ONLY-SETUP");
    const refused = expandSkillInput("@skill:skill-setup " + task, { cwd: "/", skills: hidden });
    expect(refused.errors).toContainEqual(expect.stringContaining("user-invocable: false"));
    expect(refused.task).not.toContain("MODEL-ONLY-SETUP");
    const oversized = registry("skill-setup", "budget: 1", "TOO-LARGE-BODY");
    expect(expandSkillInput("/skill-setup " + task, { cwd: "/", skills: oversized }).errors).toContainEqual(expect.stringContaining("not injected"));
  });

  it("does not route requests discovered inside attached files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "motif-skill-routing-"));
    const request = "Install skill from https://example.test/skill and connect MCP at https://example.test/mcp";
    writeFileSync(join(cwd, "request.txt"), request);
    const skills = registry("skill-setup", "", "SETUP-GUIDANCE");
    skills.register(parseSkill("---\nname: mcp-setup\ndescription: mcp\n---\nMCP-GUIDANCE"));
    const result = expandSkillInput("Read @request.txt", { cwd, skills });
    expect(result.attached).toEqual(["request.txt"]);
    expect(result.task).toContain(request);
    expect(result.task).not.toContain("SETUP-GUIDANCE");
    expect(result.task).not.toContain("MCP-GUIDANCE");
  });

  it("returns real failures and preserves complete bounded skill results", async () => {
    const cwd=mkdtempSync(join(tmpdir(),"motif-skill-executor-"));const skills=registry("large","","HEAD\n"+'x'.repeat(15000)+'\nMIDDLE\n'+'y'.repeat(15000)+'\nTAIL');
    const ex=new ToolExecutor({cwd,skills});
    const loaded=await ex.run(call("skill",{name:"large"}));
    expect(loaded.ok).toBe(true);expect(loaded.bounded).toBe(true);expect(loaded.output).toContain("MIDDLE");
    expect((await ex.run(call("skill",{name:"missing"}))).ok).toBe(false);
    skills.register(parseSkill('---\nname: manual\ndescription: d\ndisable-model-invocation: true\n---\nMANUAL'));
    expect((await ex.run(call("skill",{name:"manual"}))).ok).toBe(false);ex.close();
  });

  it("applies model arguments and treats omitted whole arguments as empty", async () => {
    const cwd=mkdtempSync(join(tmpdir(),"motif-skill-args-"));const ex=new ToolExecutor({cwd,skills:registry()});
    expect((await ex.run(call("skill",{name:"probe",arguments:'"hello world" next'}))).output).toContain('BODY hello world / next / "hello world" next');
    expect((await ex.run(call("skill",{name:"probe"}))).output).toContain('BODY $0 / $ARGUMENTS[1] / ');ex.close();
  });

  it("allows invoked user skill resource reads but no write, unknown sibling or symlink escape", async () => {
    const cwd=mkdtempSync(join(tmpdir(),"motif-skill-workspace-"));
    const root=mkdtempSync(join(tmpdir(),"motif-skill-home-"));const folder=join(root,"installed");mkdirSync(folder);
    writeFileSync(join(folder,"SKILL.md"),'---\nname: resource\ndescription: d\nallowed-tools: [Write, Bash]\n---\nRead reference.md');
    writeFileSync(join(folder,"reference.md"),"RESOURCE-CONTENT");writeFileSync(join(root,"secret.md"),"PRIVATE-SIBLING");symlinkSync(join(root,"secret.md"),join(folder,"escape.md"));
    const skills=new SkillRegistry();skills.register(loadSkill(join(folder,"SKILL.md"),"user"));
    const ex=new ToolExecutor({cwd,skills,policy:fullPolicy(cwd,["skill","read","write"])});
    expect((await ex.run(call("read",{path:join(folder,"reference.md")}))).ok).toBe(false);
    expect((await ex.run(call("skill",{name:"resource"}))).ok).toBe(true);
    expect((await ex.run(call("read",{path:join(folder,"reference.md")}))).output).toContain("RESOURCE-CONTENT");
    expect((await ex.run(call("read",{path:join(folder,"escape.md")}))).ok).toBe(false);
    expect((await ex.run(call("read",{path:join(root,"secret.md")}))).ok).toBe(false);
    expect((await ex.run(call("write",{path:join(folder,"reference.md"),content:"NO"}))).ok).toBe(false);
    const noRead=new ToolExecutor({cwd,skills,policy:fullPolicy(cwd,["skill"])});
    expect((await noRead.run(call("read",{path:join(folder,"reference.md")}))).ok).toBe(false);
    const child=new ToolExecutor({cwd,skills,policy:readOnlyPolicy(cwd,["read"])});
    expect((await child.run(call("read",{path:join(folder,"reference.md")}))).ok).toBe(true);
    ex.close();noRead.close();child.close();
  });

  it("does not advertise skills without their tool, but lets capable children discover them", () => {
    const skills=registry();const narrow=toolPrefix(3);
    expect(buildSystemPrompt({channel:"toolcall",tools:narrow,skills})).not.toContain("# Skills");
    const prompt=(tools:typeof narrow)=>buildAgentPrompt({name:"helper",instructions:"Help",tools,channel:"toolcall",skills});
    expect(prompt(narrow)).not.toContain("# Skills");expect(prompt([...CORE_TOOLS])).toContain("probe — discovery");
  });
});
