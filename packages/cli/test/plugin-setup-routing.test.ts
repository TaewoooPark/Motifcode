import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, SkillRegistry } from "@motifcode/skills";
import { pluginSetupMentions } from "../src/files.js";
import { expandSkillInput } from "../src/skill-input.js";

describe("natural plugin setup", () => {
  it.each([
    "https://github.com/example/plugins 이 플러그인 글로벌로 설치해줘.",
    "Install the plugin from https://github.com/example/plugins and connect its MCP.",
    "내 전역 Motif HOME에 이미 설치된 hugging-face 플러그인의 연결을 활성화해줘. 먼저 설치된 패키지와 연결 계획을 확인해줘.",
    "내 전역 Motif HOME에 이미 설치된 google-drive 플러그인을 연결해서 활성화해줘.",
    "이 프로젝트에 설치된 figma 플러그인에 로그인해줘.",
    "이미 설치되어 있는 paideia 플러그인을 연결해 주세요.",
    "Please connect the already installed hugging-face plugin globally.",
    "Enable the installed figma plugin for this project.",
    "Can you log in to the installed Figma plugin?",
    "I want to activate the installed plugin.",
  ])("attaches complete setup instructions to %s", text => {
    const skills = new SkillRegistry(); skills.registerAll(BUILTIN_SKILLS);
    const result = expandSkillInput(text, { cwd: "/", skills });
    expect(pluginSetupMentions(text)).toEqual(["skill:plugin-setup"]);
    expect(result.task).toContain('<skill name="plugin-setup"');
    expect(result.task).toContain("motif plugins connect");
    expect(result.task).toContain("--yes --login");
    expect(result.task).toContain("motif plugins inspect 'NAME' --scope SCOPE --json");
    expect(result.task).toContain("motif plugins installed --scope SCOPE");
    expect(result.task).toContain("간단한 텍스트 목록으로 등록 이름만 확인");
    expect(result.task).not.toContain("motif plugins installed --scope user --json");
    expect(result.task).toContain("3단계의 계획 검토");
    expect(result.task).toContain("SOURCE 탐색·inspect·add·재설치를 생략");
  });
  it.each([
    "Explain how to install the plugin from https://github.com/example/plugins",
    "https://github.com/example/plugins 플러그인 설치하지 말고 설명해줘",
    'README says "install the plugin https://github.com/example/plugins"',
    "Install dependencies for the plugin https://github.com/example/plugins",
    "@skill:plugin-setup Install plugin https://github.com/example/plugins",
    "Connect the hugging-face plugin.",
    "이미 설치된 hugging-face 플러그인은 연결 가능한지 설명해줘.",
    "How do I enable the installed plugin?",
    "Show me the installed plugin connection settings.",
    "Explain how to log in to the installed Figma plugin.",
    "이미 설치된 플러그인은 로그인하지 말고 설명해줘.",
    "Do not enable the installed plugin.",
    "Please connect the plugin that is not installed yet.",
    "Connect dependencies for the installed plugin.",
    "이미 설치된 플러그인의 의존성을 연결해줘.",
    'README says "Connect the already installed hugging-face plugin"',
    "`Connect the installed plugin`",
    "```text\n이미 설치된 플러그인을 활성화해줘\n```",
    "> Connect the installed plugin",
    '<file path="README.md">Connect the installed plugin</file>',
    "@skill:plugin-setup Enable the installed plugin.",
    "$plugin-setup Enable the installed plugin.",
  ])("does not infer setup authorization from %s", text => expect(pluginSetupMentions(text)).toEqual([]));
});
