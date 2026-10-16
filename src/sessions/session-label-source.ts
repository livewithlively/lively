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

/**
 * pane env 이름 — 세션을 열 때 이 세션 이름의 출처를 훅에 알린다(#4418). 값은 LabelSource 그대로.
 *  이름짓기 안내 훅(session-name-ask)이 human·agent 면 세션 이름짓기(①)를 안내하지 않는다 — 이미 정해진 이름은 걸쇠상 AI 가
 *  못 바꾸므로, 안내해 봐야 첫 턴에 헛 툴콜 하나(사람이 기다리는 시간)만 는다. 자동 생성 프로젝트의 이름(②)은 그대로 안내한다.
 *  훅은 네트워크를 안 쓰므로 이 값이 유일한 신호다.
 *  ⚠ 여는 순간의 값이다(pane env 는 exec 때 고정) — 그 뒤 웹에서 사람이 이름을 바꿔도 안 바뀐다. 그 경우 안내가 나가도
 *   서버 걸쇠가 applied:false 로 흡수한다(해가 없다).
 */
export const SESSION_LABEL_SOURCE_ENV = "LIVELY_SESSION_LABEL_SOURCE";

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

/**
 * 세션을 열 때 **이름을 받아 왔다면** 그 이름의 출처(#4418). 이름을 안 받았으면 null — 그때 출처는 세션을 띄우는 쪽이
 *  이름을 짓는 규칙(rule·id)으로 정한다(openingLabelSource).
 *
 *  받아 온 이름은 기본이 사람 것이다(새 작업 창·태스크에서 열기·앱 만들기가 싣는 이름). 단 **있던 세션을 잇는 길**
 *  (복원·다른 AI 로 전환)은 그 세션의 저장된 이름을 싣고 오므로, 함께 실어 온 원래 출처(carried)를 그대로 쓴다.
 *  종전엔 그 이름도 «받아 온 이름» 이라 human 으로 올라갔다 — 새 id 로 뜨는 복원 한 번에 규칙 이름이 사람 이름으로 굳었다.
 */
export function carriedLabelSource(givenLabel: unknown, carried?: unknown): LabelSource | null {
  if (!String(givenLabel ?? "").trim()) return null;
  return carried == null || String(carried).trim() === "" ? "human" : normalizeLabelSource(carried);
}

/**
 * 저장된 출처 → 복원·전환이 실어 갈 값(CreateInput.labelSource). **비어 있으면 undefined** — 이 칸 이전의 행이거나
 *  노드 경합으로 출처를 못 적은 행이라 그 이름을 누가 지었는지 모른다(사람이 준 태스크 이름일 수도 있다). 모르면
 *  종전처럼 «받아 온 이름 = 사람 것» 으로 연다 — 되살린 세션의 이름이 AI 이름짓기로 갑자기 바뀌지 않게.
 */
export function carriedSourceOf(stored: unknown): LabelSource | undefined {
  return String(stored ?? "").trim() ? normalizeLabelSource(stored) : undefined;
}

/** 세션을 여는 자리의 출처 — 받아 온 이름이 있으면 carriedLabelSource, 없으면 첫 지시로 지었나(rule) id 그대로인가(id). */
export function openingLabelSource(givenLabel: unknown, label: string, id: string, carried?: unknown): LabelSource {
  return carriedLabelSource(givenLabel, carried) ?? (label === id ? "id" : "rule");
}
