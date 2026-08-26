// 순수 단위 체크(node:assert) — 복원이 대화 매핑을 잃지 않게 하는 두 규칙(#2122).
//  라우트(terminal/routes.ts)는 여기서 안 띄운다 — 두 순수 규칙만 표로 못박는다.
//  사양: ① 매핑이 비었어도 저장된 대화 파일 경로가 있으면 그 id 를 **재독**한다(추측 금지 — 규약에 맞는 것만).
//        ② 매핑이 어딘가에 확실히 남았을 때만 옛 desired-state 를 지운다(박스 세션엔 옛 행이 유일한 사본).
// 실행: npm run build && node dist/sessions/conv-mapping.test.js
import assert from "node:assert/strict";
import { convIdFromTranscriptPath, mayForgetOldState } from "./conv-mapping.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const UUID = "01985b13-2f4c-4a1e-9c7d-6b0e2a5d8f31";

// ── ① 저장된 경로에서 대화 id 재독 ─────────────────────────────────────────────────
t("[1] claude 대화 파일 경로 → 파일명의 UUID 를 재독한다", () => {
  assert.equal(convIdFromTranscriptPath("claude", `/home/box_yoon/.claude/projects/-srv-work/${UUID}.jsonl`), UUID);
});

t("[2] 뿌리가 달라도(격리 홈·테넌트 홈) 같은 규약으로 재독한다", () => {
  assert.equal(convIdFromTranscriptPath("claude", `/var/lib/lvly/tenants/lively-46e3/homes/box_yoon/.claude/projects/-x/${UUID}.jsonl`), UUID);
});

t("[3] 윈도우 경로(역슬래시)도 같은 규약", () => {
  assert.equal(convIdFromTranscriptPath("claude", `C:\\Users\\yoon\\.claude\\projects\\-x\\${UUID}.jsonl`), UUID);
});

t("[4] 경로가 비면 → null (재독할 사실이 없다)", () => {
  assert.equal(convIdFromTranscriptPath("claude", null), null);
  assert.equal(convIdFromTranscriptPath("claude", undefined), null);
  assert.equal(convIdFromTranscriptPath("claude", ""), null);
  assert.equal(convIdFromTranscriptPath("claude", "   "), null);
});

t("[5] 파일명이 그 하네스의 id 규약이 아니면 → null (추측하지 않는다)", () => {
  assert.equal(convIdFromTranscriptPath("claude", "/home/u/.claude/projects/-x/notauuid.jsonl"), null);
  assert.equal(convIdFromTranscriptPath("claude", "/home/u/.claude/projects/-x/s7.jsonl"), null);
});

t("[6] 경계 — 잘린 UUID 는 통과시키지 않는다", () => {
  assert.equal(convIdFromTranscriptPath("claude", "/home/u/.claude/projects/-x/01985b13-2f4c.jsonl"), null);
  assert.equal(convIdFromTranscriptPath("claude", `/home/u/.claude/projects/-x/${UUID.slice(0, -1)}.jsonl`), null);
});

t("[7] 규약 미확정 하네스(codex·grok·antigravity·shell)는 아무것도 하지 않는다 — 모르면 안 한다", () => {
  assert.equal(convIdFromTranscriptPath("codex", "/home/u/.codex/sessions/2026/08/26/rollout-2026-08-26T09-00-00-abc.jsonl"), null);
  assert.equal(convIdFromTranscriptPath("grok", `/home/u/.grok/${UUID}/updates.jsonl`), null);
  assert.equal(convIdFromTranscriptPath("antigravity", `/home/u/.ag/${UUID}/.system_generated/logs/transcript_full.jsonl`), null);
  assert.equal(convIdFromTranscriptPath("shell", `/tmp/${UUID}.jsonl`), null);
});

t("[8] 하네스 키가 비면 claude 규약으로 본다(매핑 컬럼의 기본값과 같은 규칙)", () => {
  assert.equal(convIdFromTranscriptPath(null, `/home/u/.claude/projects/-x/${UUID}.jsonl`), UUID);
  assert.equal(convIdFromTranscriptPath(undefined, `/home/u/.claude/projects/-x/${UUID}.jsonl`), UUID);
  assert.equal(convIdFromTranscriptPath("", `/home/u/.claude/projects/-x/${UUID}.jsonl`), UUID);
});

t("[9] 파일명이 먼저다 — 부모 디렉터리가 UUID 꼴이어도 파일명이 규약에 맞으면 그걸 쓴다", () => {
  const other = "11111111-2222-3333-4444-555555555555";
  assert.equal(convIdFromTranscriptPath("claude", `/home/u/.claude/projects/${other}/${UUID}.jsonl`), UUID);
});

t("[10] 경계 — 확장자가 두 겹이면(백업본 등) 규약에 안 맞으므로 안 쓴다", () => {
  assert.equal(convIdFromTranscriptPath("claude", `/home/u/.claude/projects/-x/${UUID}.jsonl.bak`), null);
});

t("[11] 대문자 UUID 도 같은 대화다(대소문자 무시)", () => {
  const upper = UUID.toUpperCase();
  assert.equal(convIdFromTranscriptPath("claude", `/home/u/.claude/projects/-x/${upper}.jsonl`), upper);
});

// ── ② 옛 desired-state 를 지워도 되는가 ──────────────────────────────────────────
t("[12] 이관할 매핑이 없으면 지워도 된다(잃을 것이 없다 — 종전 동작)", () => {
  assert.equal(mayForgetOldState(null, false, false), true);
  assert.equal(mayForgetOldState(undefined, false, false), true);
  assert.equal(mayForgetOldState("", false, false), true);
});

t("[13] 새 행에 남았으면 지워도 된다", () => {
  assert.equal(mayForgetOldState(UUID, true, false), true);
});

t("[14] 내구 맵에만 남았어도 지워도 된다(노드 세션 — org_node_session_map)", () => {
  assert.equal(mayForgetOldState(UUID, false, true), true);
});

t("[15] ★ 매핑은 있는데 어디에도 못 남겼으면 **지우지 않는다** — 옛 행이 마지막 사본이다", () => {
  assert.equal(mayForgetOldState(UUID, false, false), false);
});

t("[16] 둘 다 성공이면 당연히 지워도 된다", () => {
  assert.equal(mayForgetOldState(UUID, true, true), true);
});

console.log(`\n${pass} passed`);
