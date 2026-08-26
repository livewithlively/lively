// 세션 이름은 **한 번만 지어지고 그대로 간다** — 그 걸쇠(#1979 · 발의 윤상민 2026-08-25).
//
//  ── 왜 걸쇠가 필요한가 ────────────────────────────────────────────────────
//  종전엔 label 을 쓰는 자리가 넷이었고(생성 시 규칙 이름 · 헤드리스 AI 이름 · 전사 기반 autoname · 사람의 편집)
//   "한 번만"이 **문자열 비교로 흉내내진 것**이었다:
//    · session-autoname.ts — `isUnnamedSession(label, id)` (label 이 비었거나 id 와 같은가)
//    · sessions.ts(구 AI 이름) — `now !== ruleName` ("짓는 사이 사람이 고쳤으면 물러난다")
//   둘 다 '지금 이름이 무엇인가'로 '누가 지었나'를 추측한다. 그래서 ⓐ 규칙 이름과 AI 이름이 우연히 같으면 판정이
//   뒤집히고 ⓑ 새 쓰기 자리가 하나 늘 때마다 다시 깨졌다. 경합이지 불변식이 아니다.
//
//  ── 걸쇠 ──────────────────────────────────────────────────────────────────
//  label 옆에 **누가 지었나**(label_source)를 같이 남기고, 낮은 쪽이 높은 쪽을 못 덮게 한다:
//
//      id(1) < rule(2) < agent(3) < human(4)
//
//   · human 은 **늘 이긴다**(자기 이름은 몇 번이고 다시 짓는다 — 사람의 개명을 막을 이유가 없다).
//   · 그 밖은 **순위가 올라갈 때만** 이긴다. 그래서 agent 는 agent 를 못 덮는다 = "한 번만 지어진다"가
//     문자열 우연이 아니라 **표로 고정된다**. rule(autoname)이 뒤늦게 agent 이름을 덮는 일도 여기서 막힌다.
//
//  ⚠ DB·tmux 를 안 부른다(순수) — 판정을 표로 못박으려고. 집행은 editSession·session-state 가 한다.
export type LabelSource = "id" | "rule" | "agent" | "human";

const RANK: Record<LabelSource, number> = { id: 1, rule: 2, agent: 3, human: 4 };

/** 저장된 값 → LabelSource. 모르는 값·NULL 은 `rule` — 이 컬럼이 생기기 전 행들이 여기로 온다(그 이름은 전부
 *  규칙 이름이거나 사람이 지은 것인데, 둘 중 **낮은 쪽으로 가정**해야 에이전트가 한 번은 다듬을 수 있다). */
export function normalizeLabelSource(v: unknown): LabelSource {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "id" || s === "rule" || s === "agent" || s === "human" ? s : "rule";
}

/** `next` 가 `cur` 를 덮어도 되나. human 은 늘 참, 그 밖은 순위가 **올라갈 때만**(같은 순위 재작성 금지). */
export function canRelabel(cur: unknown, next: LabelSource): boolean {
  if (next === "human") return true;
  return RANK[next] > RANK[normalizeLabelSource(cur)];
}
