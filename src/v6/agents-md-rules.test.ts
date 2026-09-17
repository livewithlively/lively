// AGENTS.md «사람 규칙»·CLAUDE.md 갱신 판정 (#4064) — 사양 표 S4(R1~R10)·S5(C1~C8)를 행마다 잠근다.
//
// 왜: 매니지드에서 AGENTS.md·CLAUDE.md 가 **세션이 일하는 폴더**(멤버 저장소)에 쓰이게 됐다. 그 폴더엔 세션이
//  직접 만든 CLAUDE.md(`/init`)·AGENTS.md 가 있을 수 있고, 종전 판정은 CLAUDE.md 를 무조건 import 한 줄로 덮었다
//  — 사람이 쓴 문서가 조용히 사라진다. 저장소를 옮기는 동안엔 사람 규칙이 옛 자리(게이트웨이 로컬)에만 있을 수 있다.
// 실행: npm run build && node --test dist/v6/agents-md-rules.test.js
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  RULES_MARK, RULES_PLACEHOLDER, CLAUDE_IMPORT, GENERATED_BANNER, pickRules, nextClaudeMd, sameRules,
  agentsMdHeader, isAgentsMdOf,
} from "./agents-md-rules.js";

// 생성기가 쓰는 모양 그대로 — digest(자동) + 표식 + 규칙.
const generated = (rules: string, digest = `# 프로젝트   (프로젝트 #1)\n\n${GENERATED_BANNER}(아래 '규칙'만 사람이 편집).`): string =>
  `${digest}\n\n${RULES_MARK}\n## 규칙\n${rules || RULES_PLACEHOLDER}\n`;
const HUMAN_CLAUDE = "# 내 메모\n\n- 답은 짧게\n";

test("R1 표식 아래 규칙이 정본이다", () => {
  assert.deepEqual(pickRules({ agents: generated("존댓말로 답한다"), original: null, claude: null }),
    { rules: "존댓말로 답한다", from: "agents" });
});

test("R2 표식이 있고 규칙이 비었으면 빈 규칙이다 — 옛 원본·CLAUDE.md 로 넘어가지 않는다", () => {
  assert.deepEqual(pickRules({ agents: generated(""), original: generated("옛 규칙"), claude: HUMAN_CLAUDE }),
    { rules: "", from: "agents" }, "사람이 규칙을 지운 것을 옛 자리의 규칙으로 되살리면 안 된다");
});

test("R3 AGENTS.md 가 아직 없으면 옛 자리 원본의 규칙을 쓴다(저장소를 옮기는 중)", () => {
  assert.deepEqual(pickRules({ agents: null, original: generated("옛 자리 규칙"), claude: null }),
    { rules: "옛 자리 규칙", from: "agents" });
});

test("R4 AGENTS.md·원본이 없으면 구 CLAUDE.md 의 사람 글을 규칙으로 1회 옮긴다", () => {
  assert.deepEqual(pickRules({ agents: null, original: null, claude: HUMAN_CLAUDE }),
    { rules: HUMAN_CLAUDE.trim(), from: "claude" });
});

test("R5 우리가 쓴 import 한 줄은 규칙이 아니다", () => {
  assert.deepEqual(pickRules({ agents: null, original: null, claude: `${CLAUDE_IMPORT}\n` }), { rules: "", from: "none" });
  assert.deepEqual(pickRules({ agents: null, original: null, claude: null }), { rules: "", from: "none" });
});

test("R6 표식도 생성 문장도 없는 AGENTS.md 는 사람 글이다 — 통째로 규칙 자리로 옮겨 잃지 않는다", () => {
  const human = "# 코덱스 메모\n\n테스트부터 돌린다\n";
  assert.deepEqual(pickRules({ agents: human, original: generated("옛 규칙"), claude: HUMAN_CLAUDE }),
    { rules: human.trim(), from: "agents" });
});

test("R7 생성 문장은 있는데 표식이 깨진 AGENTS.md 는 규칙으로 삼지 않는다(디제스트가 규칙에 복제되지 않게)", () => {
  const broken = `# 프로젝트   (프로젝트 #1)\n\n${GENERATED_BANNER}.\n\n## 메타데이터\n- 상태: active\n`;
  assert.deepEqual(pickRules({ agents: broken, original: null, claude: HUMAN_CLAUDE }),
    { rules: HUMAN_CLAUDE.trim(), from: "claude" });
});

test("R8 AGENTS.md 에 규칙이 있으면 옛 원본은 보지 않는다", () => {
  assert.deepEqual(pickRules({ agents: generated("지금 규칙"), original: generated("옛 규칙"), claude: null }),
    { rules: "지금 규칙", from: "agents" });
});

test("R9 구 CLAUDE.md 는 자동블록 앞까지만 사람 글이다", () => {
  const legacy = "사람 규칙 한 줄\n\n<!-- LIVELY:REFS 자동 -->\n- 참고 지식\n";
  assert.deepEqual(pickRules({ agents: null, original: null, claude: legacy }), { rules: "사람 규칙 한 줄", from: "claude" });
});

test("R10 표식 없는 옛 원본은 규칙이 아니다 — 다음 단계로 간다", () => {
  assert.deepEqual(pickRules({ agents: null, original: "그냥 문서\n", claude: HUMAN_CLAUDE }),
    { rules: HUMAN_CLAUDE.trim(), from: "claude" });
  assert.deepEqual(pickRules({ agents: null, original: "그냥 문서\n", claude: null }), { rules: "", from: "none" });
});

test("C1 CLAUDE.md 가 없으면 import 한 줄을 만든다", () => {
  for (const from of ["agents", "claude", "none"] as const) assert.equal(nextClaudeMd(null, from), `${CLAUDE_IMPORT}\n`);
});

test("C2·C7 이미 import 한 줄이면(공백이 둘러 있어도) 쓰지 않는다", () => {
  assert.equal(nextClaudeMd(`${CLAUDE_IMPORT}\n`, "agents"), null);
  assert.equal(nextClaudeMd(`  ${CLAUDE_IMPORT}  \n\n`, "agents"), null);
  assert.equal(nextClaudeMd(`${CLAUDE_IMPORT}\n`, "claude"), null, "옮겨 온 경우라도 이미 한 줄이면 다시 쓸 일이 없다");
});

test("C3 ★ 사람이 쓴 CLAUDE.md 는 덮지 않는다 — import 줄만 맨 위에 보탠다", () => {
  const next = nextClaudeMd(HUMAN_CLAUDE, "agents");
  assert.ok(next, "import 줄이 없으면 보태야 한다");
  assert.ok(next.startsWith(`${CLAUDE_IMPORT}\n`), "import 줄이 맨 위에 와야 한다");
  assert.ok(next.endsWith(HUMAN_CLAUDE), "사람이 쓴 글이 한 글자도 빠지지 않아야 한다");
  assert.equal(nextClaudeMd(HUMAN_CLAUDE, "none"), next, "규칙 출처가 없음이어도 사람 글은 보존한다");
});

test("C4 사람 글 안에 import 줄이 이미 섞여 있으면 손대지 않는다", () => {
  assert.equal(nextClaudeMd(`# 메모\n${CLAUDE_IMPORT}\n- 답은 짧게\n`, "agents"), null);
  assert.equal(nextClaudeMd(`# 메모\r\n${CLAUDE_IMPORT}\r\n`, "agents"), null, "CRLF 줄바꿈도 같은 줄로 본다");
});

test("C5 규칙을 방금 CLAUDE.md 에서 옮겨 왔으면 import 한 줄로 정리한다(내용은 AGENTS.md 에 있다)", () => {
  assert.equal(nextClaudeMd(HUMAN_CLAUDE, "claude"), `${CLAUDE_IMPORT}\n`);
});

test("C6 구 자동블록 형식이면 import 한 줄로 정리한다", () => {
  assert.equal(nextClaudeMd("옛 규칙\n<!-- LIVELY:REFS -->\n- x\n", "agents"), `${CLAUDE_IMPORT}\n`);
});

test("C8 빈 CLAUDE.md(공백뿐)는 없는 것과 같다", () => {
  assert.equal(nextClaudeMd("", "agents"), `${CLAUDE_IMPORT}\n`);
  assert.equal(nextClaudeMd(" \n\n", "none"), `${CLAUDE_IMPORT}\n`);
});

test("같은 사람 규칙인지 — 자동 영역이 달라도 규칙이 같으면 같다 · 한쪽이라도 표식이 없으면 다르다", () => {
  assert.equal(sameRules(generated("A", "# 옛 digest"), generated("A", "# 새 digest")), true);
  assert.equal(sameRules(generated("A"), generated("B")), false);
  assert.equal(sameRules(generated(""), generated("")), true, "둘 다 빈 규칙이면 같다");
  assert.equal(sameRules(generated("A"), "A"), false, "표식 없는 문서는 규칙을 비교할 수 없다");
  assert.equal(sameRules("A", "A"), false);
});

test("H1·H5 이 프로젝트 머리로 시작하면 이 프로젝트의 AGENTS.md 다(CRLF 도)", () => {
  const p = { id: 4064, name: "자료탭 표시 확인" };
  assert.equal(agentsMdHeader(p), "# 자료탭 표시 확인   (프로젝트 #4064)", "생성기가 쓰는 머리와 글자까지 같아야 한다");
  assert.equal(isAgentsMdOf(`${agentsMdHeader(p)}\n\n본문`, p), true);
  assert.equal(isAgentsMdOf(`${agentsMdHeader(p)}\r\n\r\n본문`, p), true);
});

test("H2·H3·H4 ★ 이름·번호 중 하나라도 다르거나 이름을 모르면 남의 것일 수 있다 — 거짓", () => {
  const p = { id: 7, name: "우리 프로젝트" };
  assert.equal(isAgentsMdOf(`${agentsMdHeader({ id: 7, name: "남의 프로젝트" })}\n`, p), false, "같은 번호의 다른 워크스페이스 프로젝트");
  assert.equal(isAgentsMdOf(`${agentsMdHeader({ id: 8, name: "우리 프로젝트" })}\n`, p), false);
  assert.equal(isAgentsMdOf(`${agentsMdHeader(p)}\n`, { id: 7 }), false, "이름을 모르면 증명할 수 없다");
  assert.equal(isAgentsMdOf(`${agentsMdHeader(p)}\n`, { id: 7, name: "" }), false);
  assert.equal(isAgentsMdOf(`\n${agentsMdHeader(p)}\n`, p), false, "첫 줄이어야 한다");
});

test("W8 생성기는 머리를 한 함수로 만들고, 규칙 폴백은 그 머리와 맞을 때만 옛 원본을 쓴다", () => {
  const gen = fs.readFileSync(new URL("./agents-md.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(gen, /L\.push\(agentsMdHeader\(p\), ""\)/, "생성기 머리가 대조 함수와 다른 글자로 쓰이면 이관이 제 AGENTS.md 를 못 알아본다");
  assert.match(gen, /const writtenAt = raw != null \? await fsp\.stat\(localAgents\)\.then\(\(st\) => Math\.floor\(st\.mtimeMs\), \(\) => 0\) : 0;/,
    "규칙 폴백이 그 원본이 쓰인 시각으로 묻지 않는다");
  assert.match(gen, /const original = raw != null && project && \(await ownsAgentsMd\(raw, project, writtenAt\)\.catch\(\(\) => false\)\) \? raw : null;/,
    "옛 원본을 대조 없이 쓰면 같은 번호를 가진 남의 워크스페이스 규칙이 섞인다(W8b — 이관과 같은 판정, 실패하면 안 쓴다)");
  assert.doesNotMatch(gen, /isAgentsMdOf\(/, "규칙 폴백이 이관과 다른 판정(지금 이름만)을 쓰면 이름을 바꾼 프로젝트의 규칙이 빠진다");
});
