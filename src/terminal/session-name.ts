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
