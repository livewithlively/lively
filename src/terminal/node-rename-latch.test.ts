// 사람이 지은 세션 이름은 되돌아가지 않는다 — 특히 **노드 세션**에서 (#2251).
//
// 신고(장원준 2026-08-28): "호버해서 세션 이름 수도 없이 수정했는데 계속 이름이 다시 바뀌어서 원래대로 돌아가.
//  사용자가 수정하면 세션 이름 픽스하도록 제대로 되어있어?" — 화면은 프로젝트 상세의 세션 카드,
//  노드 `laibeulliui-macmini` 에서 도는 세션이었다.
//
// 사양(행위): 이름을 **누가 지었는가**가 정본을 정한다 — 사람이 지었으면 AI 는 못 덮고(P1), 사람은 몇 번이고
//  다시 짓는다(P2), 아무도 안 지은 자동 이름은 AI 가 한 번 다듬는다(P3). **세션이 어디서 도는지는 이 정책에
//  영향을 주지 않고**(P4), 이름을 고쳤다는 사실은 세션이 살아 있는지와 무관하게 남는다(P5·P8).
//
// 두 층을 함께 건다:
//  ⓐ 정책 표 자체(canRelabel) — 값으로 잰다.
//  ⓑ 그 표에 **닿는가** — 노드 세션의 개명은 종전에 그 노드의 tmux 에만 적히고 조직 기록에는 아예 안 닿았다.
//     그래서 출처가 영영 'rule' 에 머물러 E3 분기를 타고, AI 가 사람 이름을 덮었다. 이 결함의 정체가
//     '분기 안에 그 호출이 통째로 없었다' 라서 값 테스트로는 잡히지 않는다 — **그 줄의 존재가 곧 명제**다
//     (session-workspace-isolation.test.ts 의 E6~E8 과 같은 형식).
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canRelabel } from "../sessions/session-label-source.js";

const readSafe = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (readSafe(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");
/** 노드 edit 릴레이 분기의 본문 — 이 안에서 무슨 일이 일어나는지가 P4·P5·P6 의 자리다. */
function nodeEditBranch(): { src: string; relayAt: number; branch: string } {
  const src = readSrc("src/terminal/routes.ts");
  const relayAt = src.indexOf('relayNodeOp(nodeId, "edit"');
  assert.ok(relayAt > 0, "노드 edit 릴레이 분기를 찾지 못했다 — 이 테스트의 전제가 깨졌다");
  return { src, relayAt, branch: src.slice(relayAt, relayAt + 2200) };
}

// ── ⓐ 정책 표 ────────────────────────────────────────────────────────────────
test("E1 사람 이름은 AI 가 못 덮는다 — 신고의 핵심 명제", () => {
  assert.equal(canRelabel("human", "agent"), false);
  assert.equal(canRelabel("human", "rule"), false);
});

test("E2 사람은 몇 번이고 다시 짓는다", () => {
  assert.equal(canRelabel("human", "human"), true);
  assert.equal(canRelabel("agent", "human"), true);
  assert.equal(canRelabel("rule", "human"), true);
});

test("E3 자동 이름은 AI 가 **한 번** 다듬는다", () => {
  assert.equal(canRelabel("rule", "agent"), true);    // 한 번은 이긴다
  assert.equal(canRelabel("agent", "agent"), false);  // 두 번은 못 이긴다
});

// ── ⓑ 노드 세션도 그 표에 닿는가 (P4·P5) ────────────────────────────────────────
test("★ E4 노드 세션의 개명이 '사람이 지었다'로 조직에 남는다 — 없으면 AI 가 사람 이름을 덮는다", () => {
  const { branch } = nodeEditBranch();
  assert.match(branch, /claimSessionLabel\([\s\S]{0,160}?"human"/,
    "노드 개명이 사람 출처로 기록되지 않는다 — 이름이 그 노드의 터미널에만 남아, 복원·AI 개명에 되돌아간다");
});

test("E5 노드 세션의 초대 변경도 조직에 남는다 — 복원이 그 값을 쓴다 (P6)", () => {
  const { branch } = nodeEditBranch();
  assert.match(branch, /updateSessionStateMeta\([\s\S]{0,160}?invites/,
    "노드 초대 변경이 기록되지 않는다 — 복원 한 번에 초대가 사라진다");
});

test("★ E6 기록은 **거부 뒤**다 — 남의 세션 이름이 먼저 기록되지 않는다 (P7)", () => {
  const { src, relayAt } = nodeEditBranch();
  const claimAt = src.indexOf("claimSessionLabel(", relayAt);
  assert.ok(claimAt > relayAt,
    "소유권 확인(노드 릴레이)보다 기록이 먼저다 — 거부된 개명이 조직에 남는다");
});

// ── ⓑ 기록만 남은 세션도 지어진 이름을 쓴다 (P8) ────────────────────────────────
test("★ E7 이력 목록이 '지어진 이름'을 자동 이름보다 먼저 쓴다", () => {
  const src = readSrc("src/v6/session-log-store.ts");
  assert.match(src, /label_source IN \('human','agent'\)/,
    "이력 목록이 지어진 이름을 안 본다 — 박스가 정리되면 사람이 고친 이름이 첫 지시 자동 이름으로 되돌아간다");
  assert.match(src, /withNamedLabels\(/, "내 세션 목록이 그 조회를 거치지 않는다");
  // 왕복을 행 수에 비례시키지 않는다(#2234 의 교훈) — 대화 id 배열 하나로 한 번만 묻는다.
  assert.match(src, /claude_session_id = ANY\(\$2::text\[\]\)/, "이름 조회가 건별 왕복이다");
  // 남의 이름이 실리지 않게 소유자로 잠근다.
  assert.match(src, /WHERE owner = \$1 AND claude_session_id/, "이름 조회가 소유자로 잠겨 있지 않다");
});
