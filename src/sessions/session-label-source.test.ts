// 세션 이름 걸쇠 (#1979) — 이 표가 틀렸을 때 실제로 났던 일:
//  🔴 이름 쓰는 자리가 넷인데(생성 규칙 이름 · 헤드리스 AI 이름 · 전사 autoname · 사람 편집) "한 번만 짓는다"가
//     문자열 비교로만 흉내내져 있었다(`label === id` · `now !== ruleName`). 자리가 하나 늘 때마다 다시 깨졌고,
//     규칙 이름과 AI 이름이 우연히 같으면 판정이 뒤집혔다.
//  실행: npm run build && node dist/sessions/session-label-source.test.js
import assert from "node:assert/strict";
import { canRelabel, normalizeLabelSource, type LabelSource } from "./session-label-source.js";

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };

// ── 표 A — canRelabel(cur, next). 사양의 15행을 그대로 옮긴다(행 하나가 곧 못 잡는 버그다). ──
const TABLE: Array<[cur: LabelSource | null, next: LabelSource, want: boolean, why: string]> = [
  ["agent", "agent", false, "★핵심 — 한 번 지어지면 다시 안 지어진다"],
  ["human", "agent", false, "사람 이름을 에이전트가 못 덮는다"],
  ["human", "rule",  false, "뒤늦은 autoname 이 사람 이름을 못 지운다"],
  ["human", "id",    false, "id 폴백이 사람 이름을 못 지운다"],
  ["human", "human", true,  "★사람의 재개명은 늘 된다(막으면 그게 사고)"],
  ["agent", "human", true,  "사람이 에이전트 이름을 고친다"],
  ["rule",  "human", true,  "사람이 규칙 이름을 고친다"],
  ["id",    "human", true,  "사람이 이름 없는 세션에 이름을 준다"],
  ["rule",  "agent", true,  "주 경로 — 규칙 이름을 세션이 다듬는다"],
  ["id",    "agent", true,  "이름 없던 세션을 세션이 짓는다"],
  ["agent", "rule",  false, "★회귀 — 뒤늦은 autoname 이 agent 이름을 못 덮는다"],
  ["rule",  "rule",  false, "같은 순위 재작성 금지"],
  ["id",    "rule",  true,  "autoname 주 경로"],
  ["id",    "id",    false, "같은 순위 재작성 금지"],
  [null,    "agent", true,  "★label_source 이전 행(NULL)도 한 번은 다듬을 수 있어야 마이그레이션이 산다"],
];
for (const [cur, next, want, why] of TABLE) {
  assert.equal(canRelabel(cur, next), want, `canRelabel(${cur}, ${next}) = ${!want} — ${why}`);
}
ok(`걸쇠 표 ${TABLE.length}행 — agent 는 agent 를 못 덮고, human 은 늘 이기고, rule 은 agent 를 못 지운다`);

// 표가 vacuous 하지 않은지(관측 장치 확인) — 참·거짓이 둘 다 실제로 나와야 표가 무언가를 가르고 있다.
{
  const trues = TABLE.filter(([c, n]) => canRelabel(c, n)).length;
  assert.ok(trues > 0 && trues < TABLE.length, `표가 한쪽으로만 나온다(true ${trues}/${TABLE.length}) — 아무것도 안 가르고 있다`);
  ok("배선 확인 — 표가 허용/거부를 실제로 둘 다 만든다");
}

// ── 표 B — normalizeLabelSource. 저장 값이 흔들려도 판정이 흔들리면 안 된다. ──
for (const v of [null, undefined, "", "   ", "아무거나", "AGENT_X"]) {
  assert.equal(normalizeLabelSource(v), "rule", `${JSON.stringify(v)} 는 rule 로 봐야 한다`);
}
assert.equal(normalizeLabelSource(" HUMAN "), "human");
assert.equal(normalizeLabelSource("Agent"), "agent");
assert.equal(normalizeLabelSource("id"), "id");
ok("미상·NULL 은 rule 로, 값은 트림·소문자로 정규화된다");

// ★ 마이그레이션 안전 — 구 행(NULL)이 human 으로 읽히면 **기존 세션 전부가 영구히 못 다듬는 이름**이 된다.
assert.notEqual(normalizeLabelSource(null), "human");
ok("구 행(NULL)이 human 으로 읽히지 않는다 — 기존 세션이 영구 잠기지 않는다");

console.log(`\n${pass} passed`);
