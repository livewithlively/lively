// 세션 이름을 **짓는 규칙** — 한 곳(#1808).
//
// 왜 서버에 두나: 이름을 정하는 자리가 아홉 군데였고(새 세션 폼·프로젝트 생성·홈 입력창·위탁·이어보기·복원·노드…)
//  각자 다르게 지었다. dev 실측 2026-08-20 — 프로젝트 세션 147건 중 **104건(71%)이 이름이 프로젝트명 그대로**였다.
//  그러면 한 프로젝트 아래 세션 예닐곱 개가 전부 같은 이름이라 목록에서 서로 구분이 안 된다(원준님 신고).
//  뿌리는 '새 AI 세션' 폼이 프로젝트에서 열릴 때 이름칸을 프로젝트명으로 **미리 채워 두던 것**이었다 —
//  대다수가 그대로 [생성하기] 를 눌렀다. 그 프리필을 없앴고(web/terminal/session-form.ts), 대신
//  **이름을 안 주면 서버가 첫 지시로 짓는다**. 이름은 '어디에 속하나'가 아니라 '무엇을 시켰나'여야 한다
//  (프로젝트는 이미 트리·칩이 말한다).
//
// 규칙: 한 줄로 접고 · 끝의 문장부호를 떼고 · 28자에서 자른다. 그 이상은 목록 어디서도 안 보인다(사이드바 · 탭 · 카드).

const MAX = 28;

/** 첫 지시 → 세션 이름. 이름으로 쓸 게 없으면 빈 문자열(호출자가 폴백을 정한다). */
export function sessionNameFromPrompt(text: string): string {
  const one = String(text || "").replace(/\s+/g, " ").trim().replace(/[.。!?？…]+$/, "").trim();
  if (!one) return "";
  return one.length > MAX ? one.slice(0, MAX - 1) + "…" : one;
}

/** 이 이름은 '사람이 지은 것'인가 — 아니면 이름을 안 줘서 id 가 그대로 들어간 것인가.
 *  자동 이름만 나중에 덮어쓴다(사람이 지은 이름은 절대 안 건드린다, session-autoname.ts). */
export function isUnnamedSession(label: string, id: string): boolean {
  const l = String(label || "").trim();
  return !l || l === id;
}

// ── 에이전트가 지은 이름 (#1979) ────────────────────────────────────────────
//  누가 짓나: **그 세션 자신**이다. 첫 지시 턴에 훅이 "이 세션의 이름을 지어 session_rename 으로 등록하라"를
//   주입하고, 세션이 자기 맥락(첫 지시 + 주입된 프로젝트 AGENTS.md)으로 지어 툴로 등록한다.
//   종전엔 하네스를 **헤드리스로 따로 스폰**해서 지었는데(구 session-name-ai.ts), 그 서브프로세스가 부모 세션의
//   LIVELY_SESSION_ID·훅 배선을 env 로 상속해 project-auto-bind 가 **이름짓기 프롬프트를 첫 실질 지시로 오인**,
//   쓰레기 프로젝트를 만들어 부모 세션에 붙였다(프로덕션 실측 2026-08-25: #1946·#1957).
//   스폰이 0이면 그 결함은 완화가 아니라 **구조적으로 없다** — 그래서 이름짓기는 더 이상 '세션'이 아니다.
//  ⚠ **거절하지 않는다 — 자른다.** 길이 초과·따옴표·마침표는 전부 여기서 다듬는다. 이름은 화면 장식이고
//   실패 응답을 만들 만한 값이 아니다(모델이 다시 부르느라 사용자 턴만 길어진다). 다듬어서 남는 게 없을 때만 "".
const AGENT_MAX = 12;   // "10자 언더"(원준 #1719) — 사이드바·탭·카드가 그 이상을 안 보여준다

/** 에이전트가 준 이름 → 쓸 수 있는 라벨. 못 쓰면 ""(호출자는 지금 이름을 그대로 둔다). */
export function sessionNameFromAgent(raw: string | null | undefined): string {
  const first = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  // 끝은 **한 번에** 벗긴다 — 따옴표와 마침표가 섞여 있어(`"결제 백오프".`) 순서대로 지우면 하나가 남는다.
  const bare = first.replace(/^[\s"'「『([]+/, "").replace(/[\s"'」』)\].。!?？…]+$/, "").trim();
  if (!bare) return "";
  return bare.length > AGENT_MAX ? bare.slice(0, AGENT_MAX).trimEnd() : bare;
}
