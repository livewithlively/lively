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
 *  ⚠ 여는 순간의 값이다(pane env 는 exec 때 고정) — 그 뒤 AI 가 이름을 짓거나 웹에서 사람이 바꿔도 안 바뀐다. 그래서
 *   이 값은 **폴백**이다(#5552): 훅은 서버가 이번 턴에 답한 지금 값(agentNamingOpen — 프로젝트 맥락 응답의 naming_open 을
 *   project-agents-inject 가 로컬에 받아 둔다)을 먼저 보고, 그 값이 없을 때만 이 env 를 본다. 훅 자신은 여전히 네트워크를 안 쓴다.
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
 * 에이전트의 세션 이름짓기(`session_rename`)가 **지금 이 세션에 적용될 수 있나**(#5552) — 이름짓기 안내 훅이 묻는다.
 *
 *  ── 왜 필요한가 ───────────────────────────────────────────────────────────
 *  훅은 종전에 pane env(SESSION_LABEL_SOURCE_ENV)만 봤는데 그 값은 **세션을 연 순간의 스냅샷**이다. 그래서 이미 이름이
 *  정해진 세션에 세션 이름짓기(①) 안내가 샜다 — 그 턴마다 헛 툴콜 하나와 «적용되지 않았습니다(applied:false)» 보고가 붙는다:
 *   ⓐ AI 가 첫 턴에 이름을 지은 뒤 «세션당 1회» tmp 플래그가 사라진 pane(재부팅 · OS 의 tmp 청소) — env 는 여전히 id·rule
 *   ⓑ 안내가 나가기 전에 사람이 웹에서 이름을 고친 세션 — env 는 여전히 id·rule
 *   ⓒ env 가 아예 없는 세션(라이블리가 띄우지 않은 외부 실행 세션 · 옛 노드 · env_keep 을 다시 안 깐 sudo 박스)
 *  답은 걸쇠(claimSessionLabel)가 실제로 내릴 판정과 **같은 표**(canRelabel)에서 나온다 — 안내와 집행이 갈리지 않게.
 *
 *  ── 어떻게 훅에 닿나(훅은 네트워크를 안 쓴다는 #1979 의 원칙을 지킨 채로) ───────────────
 *  이름짓기 안내 훅(sort 30)은 혼자 도는 묶음이라 거기서 서버를 부르면 그 왕복만큼 첫 응답이 늦어진다. 그래서 묻지 않는다.
 *  대신 **앞 묶음**(sort 10)의 project-agents-inject 가 매 턴 이미 받는 프로젝트 맥락 응답에 이 값을 싣고
 *  (sessionProjectContext 의 naming_open), 그 훅이 로컬 파일(`<tmp>/lively-hooks/<세션>.naming`)에 받아 둔다. 러너는 묶음을
 *  sort 순서로 **차례로** 돌리므로 안내 훅이 읽을 때 그 파일은 같은 턴의 값이다. 추가 왕복 0회.
 *
 *   true  — 이름짓기가 먹힌다(id·rule·출처 없는 옛 행). ① 을 안내한다.
 *   false — 안 먹힌다. 이미 agent·human 이 지었거나, **행이 없는 외부 실행 세션**(`claude-…`·`codex-…` — 이름을 담을
 *           org_session_state 행이 없어 session_rename 이 늘 applied:false·unknown 이다). ① 을 뺀다.
 *   null  — 모른다. 라이블리가 띄운 세션인데 행이 (아직) 없다 — 노드 세션의 생성 기록이 첫 지시보다 늦게 닿는 틈일 수 있어
 *           «안 먹힌다» 로 단정하면 그 세션은 영영 이름을 못 얻는다. 응답에 싣지 않고, 훅은 종전 판정(env)으로 물러난다.
 */
export function agentNamingOpen(row: { label_source?: unknown } | null | undefined, external: boolean): boolean | null {
  if (!row) return external ? false : null;
  return canRelabel(row.label_source, "agent");
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
