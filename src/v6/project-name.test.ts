// 프로젝트 이름 규칙·걸쇠 (#2031) — 이 표가 틀렸을 때 나는 일:
//  🔴 걸쇠가 느슨하면 **사람이 지은 프로젝트 이름을 에이전트가 갈아치운다**(실측 662건 중 599건이 사람·커넥터 것).
//  🔴 걸쇠가 너무 빡빡하면 자동 생성 껍데기가 영영 "지금 그냥 새 작업으로 시키면 프로젝트가 붙는데…" 로 남는다.
//  🔴 임시 이름 상한이 풀리면 그게 곧 이번 신고 내용이다 — 보드·사이드바에 지시문 한 문장이 그대로 걸린다.
//  사양·엣지표: 이 파일의 표 A~D 가 곧 사양이다(입력 조합 × 기대). 경계값 행(28·29자, 30·31자)과
//   "새로 도입한 값이 없을 때"(name_source NULL) 행을 반드시 포함한다 — 그 행이 없으면 그 버그는 영영 안 잡힌다.
//  실행: node dist/v6/project-name.test.js
import assert from "node:assert/strict";
import {
  canRenameProject, normalizeProjectNameSource, projectNameFromAgent, shellNameFromPrompt,
} from "./project-name.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

// ── 표 A: 걸쇠 — (지금 출처 × 새 출처) → 덮어도 되나 [사양 S1] ──────────────
{
  const T: Array<[unknown, "rule" | "session" | "agent" | "human", boolean, string]> = [
    ["rule",  "agent", true,  "기계값을 세션이 한 번 다듬는다 — 이 기능의 본체"],
    ["rule",  "session", true, "세션이 자기 이름을 지으며 껍데기에 승계한다(기계값보다 낫다)"],
    ["session", "session", false, "★두 번째 세션이 자기 이름으로 같은 프로젝트를 또 개명하지 못한다"],
    ["session", "agent", true, "이 일의 이름으로 따로 지으면(project_rename_v6) 세션 이름 승계를 이긴다"],
    ["agent", "session", false, "★세션 이름 승계가 이미 지어진 이름을 갈아치우지 못한다"],
    ["human", "session", false, "★사람이 지은 이름은 승계가 못 덮는다"],
    [null,    "session", false, "구 행·커넥터 미러도 승계 대상이 아니다"],
    ["agent", "agent", false, "★두 번째 세션이 같은 프로젝트를 또 개명하지 못한다(한 번만 지어진다)"],
    ["human", "agent", false, "★사람이 지은 이름은 에이전트가 못 덮는다"],
    ["human", "human", true,  "사람의 개명은 몇 번이고 된다"],
    ["agent", "human", true,  "사람은 에이전트 이름을 고칠 수 있다"],
    ["rule",  "human", true,  "웹 인라인 편집"],
    ["agent", "rule",  false, "기계값이 지어진 이름을 되돌리지 못한다"],
    ["rule",  "rule",  false, "같은 순위 재작성 금지"],
    [null,    "agent", false, "★NULL(구 행·커넥터 미러)은 human 으로 읽는다 — 남의 이름을 지키는 쪽"],
    [undefined, "agent", false, "값 자체가 없는 경우도 같다"],
    ["",      "agent", false, "빈 값도 human"],
    ["Human", "agent", false, "대소문자 무관"],
    ["  rule  ", "agent", true, "앞뒤 공백은 다듬어 읽는다"],
    ["소문자아님", "agent", false, "모르는 값도 human(안전한 쪽)"],
    [null,    "human", true,  "사람은 구 행도 고칠 수 있다"],
  ];
  for (const [cur, next, want, why] of T) {
    assert.equal(canRenameProject(cur, next), want, `canRenameProject(${JSON.stringify(cur)}, ${next}) — ${why}`);
  }
  ok(`걸쇠 표 ${T.length}행 — agent 는 agent·human 을 못 덮고, NULL 은 human 으로 읽는다`);

  assert.equal(normalizeProjectNameSource(undefined), "human");
  assert.equal(normalizeProjectNameSource(null), "human");
  assert.equal(normalizeProjectNameSource("rule"), "rule");
  assert.equal(normalizeProjectNameSource(" AGENT "), "agent");
  assert.equal(normalizeProjectNameSource("session"), "session");
  ok("normalizeProjectNameSource — 알려진 값만 그대로, 나머지는 human");

  // 배선 확인 — 표가 참·거짓을 둘 다 만든다(한쪽으로만 나오면 아무것도 안 가르는 것이다).
  const trues = T.filter(([cur, next]) => canRenameProject(cur, next)).length;
  assert.ok(trues > 0 && trues < T.length, `표가 한쪽으로만 나온다(true ${trues}/${T.length})`);
  ok("배선 확인 — 걸쇠 표가 허용/차단을 실제로 둘 다 만든다");
}

// ── 표 B: 에이전트가 준 이름 다듬기 — **거절하지 않고 자른다** [사양 S2] ────
{
  const T: Array<[string | null | undefined, string, string]> = [
    ["프로젝트 자동 이름짓기", "프로젝트 자동 이름짓기", "통상 — 그대로 통과"],
    ['"프로젝트 자동 이름짓기".', "프로젝트 자동 이름짓기", "따옴표+마침표가 섞여도 한 번에 벗긴다"],
    ["「앱 한글 자모분리」", "앱 한글 자모분리", "한국어 따옴표"],
    ["(임시 이름 정리)", "임시 이름 정리", "괄호"],
    ["첫 줄만 쓴다\n설명은 버린다", "첫 줄만 쓴다", "여러 줄이면 첫 줄"],
    ["  \n  들여쓴 첫 줄  ", "들여쓴 첫 줄", "앞의 빈 줄·공백"],
    ["가".repeat(30), "가".repeat(30), "★경계 — 정확히 30자는 그대로"],
    ["가".repeat(31), "가".repeat(30), "★경계 — 31자는 30자로 자른다(거절 아님)"],
    ["", "", "빈 값 — 호출자가 지금 이름을 그대로 둔다"],
    ["...", "", "다듬으니 남는 게 없다"],
    ['""', "", "따옴표만"],
    [null, "", "null 에도 던지지 않는다"],
    [undefined, "", "undefined 에도 던지지 않는다"],
  ];
  for (const [input, want, why] of T) {
    assert.equal(projectNameFromAgent(input), want, `projectNameFromAgent(${JSON.stringify(input)}) — ${why}`);
  }
  ok(`에이전트 이름 표 ${T.length}행 — 다듬기만 하고 던지지 않는다(경계 30/31자 포함)`);
}

// ── 표 C: 기계가 짓는 임시 이름 — 이번 신고의 그 문장 [사양 S3] ─────────────
//  ⚠ 여기 기대값이 곧 사용자가 보드에서 보는 글자다.
{
  const REPORTED = "지금 그냥 새 작업으로 시키면 프로젝트가 붙는데, 프로젝트가 자동생성되는건 좋아 그런데 프로젝트 명이 어색해. 해결해줘.";
  const name = shellNameFromPrompt(REPORTED);
  assert.ok(name.length <= 28, `임시 이름이 28자를 넘었다: ${name.length}자 — ${name}`);
  assert.ok(REPORTED.startsWith(name.slice(0, -1)), "임시 이름은 첫 지시의 머리글자여야 한다(원문 보존은 본문이 한다)");
  ok(`신고된 그 지시 → «${name}» (${name.length}자 · 종전 규칙이면 70자)`);

  const T: Array<[string, string, string]> = [
    ["앱 알림 고쳐줘.", "앱 알림 고쳐줘", "짧으면 그대로 — 끝의 마침표만 뗀다"],
    ["세션 이름이 안 떠?", "세션 이름이 안 떠", "물음표도 뗀다(이름에 문장부호는 문장의 흔적일 뿐)"],
    ["첫 줄만 이름이 된다\n둘째 줄은 본문에만 남는다", "첫 줄만 이름이 된다", "첫 줄만"],
    ["  \n\n  앞이 비어 있어도 첫 실질 줄  ", "앞이 비어 있어도 첫 실질 줄", "빈 줄 건너뜀"],
    ["여러   공백은    한 칸으로", "여러 공백은 한 칸으로", "공백 접기"],
    ["가".repeat(28), "가".repeat(28), "★경계 — 정확히 28자는 자르지 않는다(… 없음)"],
    ["가".repeat(29), "가".repeat(27) + "…", "★경계 — 29자는 27자+… (총 28자)"],
    ["", "", "빈 지시 — 호출자가 «새 작업» 으로 폴백"],
    ["   \n  ", "", "공백뿐"],
    ["???", "", "문장부호뿐 — 다듬으니 남는 게 없다"],
  ];
  for (const [input, want, why] of T) {
    assert.equal(shellNameFromPrompt(input), want, `shellNameFromPrompt(${JSON.stringify(input).slice(0, 40)}) — ${why}`);
  }
  ok(`임시 이름 표 ${T.length}행 — 첫 줄 · 공백 접기 · 끝 문장부호 · 경계 28/29자`);

  // 배선 확인 — 자르는 경로와 안 자르는 경로가 **둘 다** 산다.
  assert.equal(shellNameFromPrompt("가".repeat(40)).length, 28, "자른 뒤 길이는 정확히 28(… 포함)");
  assert.ok(!shellNameFromPrompt("짧은 지시").endsWith("…"), "짧은 지시엔 … 가 붙지 않는다");
  ok("배선 확인 — 자름/안 자름 경로가 둘 다 산다");
}

// ── 표 D: 두 입구가 같은 이름을 낸다 [사양 S4] ──────────────────────────────
//  서버 선생성(shellNameFromPrompt)과 외부 하네스 훅(project-auto-bind.titleFrom)은 같은 계약이다.
{
  const hook = new URL("../../kit/hooks/examples/project-auto-bind.org-hook.mjs", import.meta.url);
  const { titleFrom } = await import(hook.href) as { titleFrom: (p: string) => string };
  const SAMPLES = [
    "지금 그냥 새 작업으로 시키면 프로젝트가 붙는데, 프로젝트가 자동생성되는건 좋아 그런데 이름이 어색해.",
    "앱 알림 고쳐줘.",
    "세션 이름이 안 떠?",
    "첫 줄만 이름이 된다\n둘째 줄은 본문에만",
    "가".repeat(28),
    "가".repeat(29),
    "여러   공백은    한 칸으로",
  ];
  for (const p of SAMPLES) {
    assert.equal(titleFrom(p), shellNameFromPrompt(p), `훅과 서버의 임시 이름이 다르다: ${JSON.stringify(p).slice(0, 30)}`);
  }
  // 배선 확인 — 훅을 실제로 불렀고 빈 값만 비교한 게 아니다.
  assert.ok(titleFrom(SAMPLES[0]).length > 0, "훅 titleFrom 이 아무것도 안 돌려준다(비교가 공허하다)");
  ok(`훅 project-auto-bind.titleFrom == 서버 shellNameFromPrompt — 표본 ${SAMPLES.length}건`);
}

console.log(`\n${pass} passed`);
