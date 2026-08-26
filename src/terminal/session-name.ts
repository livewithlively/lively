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
// 규칙: 재료가 안 되는 줄을 버리고 · **첫 문장**에서 끊고 · 끝의 문장부호를 떼고 · 28자에서 자른다.
//  그 이상은 목록 어디서도 안 보인다(사이드바 · 탭 · 카드).

const MAX = 28;

// ⭐ **이름의 값어치는 길이가 아니라 경계다**(#2116, 2026-08-26 실측).
//  종전엔 입력 전체를 한 줄로 접고 28자에서 잘랐다. 그래서 첫 지시가 「문장 + 붙여넣은 URL·스택트레이스」면
//  이름이 문장 한복판이 아니라 **URL 한복판**에서 끊겼다 — dev 실측:
//    `내가 원준이 세션 열려니까 안열려. https:/…`   ← 첫 문장은 16자라 다 들어갈 수 있었다
//    `잡다하고 간단한 여러 버그들 수정 좀 하자. 지금…`  ← 첫 문장은 22자
//  28자를 다 쓰는 것보다 **말이 끝나는 데서 끊는 것**이 낫다.

/** 이름 재료가 못 되는 줄 — 사람이 붙여넣은 **증거**지 지시가 아니다. */
const URL_ONLY = /^<?https?:\/\/\S+>?$/;
const STACK = /^\s*(at\s|\S+\s@\s\S+:\d|\S+\.(?:m?[jt]s|jsx|tsx)\??\S*:\d)/;
const FENCE = /^\s*(```|~~~)/;

/** 문장 끝 — 부호 **뒤에 공백이나 줄끝**이 와야 한다. `v1.2`·`main.js:10` 처럼 글자가 이어지면 문장이 아니다. */
const SENTENCE_END = /[.。!?？]+(?=\s|$)/;
const MIN_SENTENCE = 4;   // `ㅇㅇ.` 하나로 이름을 만들지 않는다 — 그보다 짧으면 경계로 안 친다

const squeeze = (s: string): string => s.replace(/\s+/g, " ").trim();
const trimEndPunct = (s: string): string => s.replace(/[.。!?？…]+$/, "").trim();
const cut = (s: string): string => (s.length > MAX ? s.slice(0, MAX - 1) + "…" : s);

/** 붙여넣은 증거를 걷어낸 '지시로 읽히는 줄'들. 코드펜스 안은 통째로 건너뛴다. */
function promptLines(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    if (URL_ONLY.test(line) || STACK.test(line)) continue;
    out.push(line);
  }
  return out;
}

/** 첫 지시 → 세션 이름. 이름으로 쓸 게 없으면 빈 문자열(호출자가 폴백을 정한다). */
export function sessionNameFromPrompt(text: string): string {
  const whole = squeeze(String(text || ""));
  if (!whole) return "";
  // ⚠ 폴백은 **종전 동작을 글자 그대로** 재현한다 — 줄 필터가 다 걷어냈을 때만 쓴다.
  //  (여기서 "빈 이름 금지" 같은 개선을 슬쩍 끼우지 않는다: 부호만 친 입력은 종전대로 ""이고, 그게 계약이다.)
  const stripped = trimEndPunct(whole);
  const fallback = stripped ? cut(stripped) : "";

  // ⚠ **줄바꿈은 문장의 끝이 아니다** — 한 지시가 두 줄에 걸쳐 있으면 이어 붙여야 한다("랜딩 카피를\n고쳐 줘").
  //  그래서 '첫 줄'이 아니라 '살아남은 줄을 이은 것'에서 첫 문장을 찾는다. URL·스택은 이미 위에서 빠졌다.
  const joined = squeeze(promptLines(text).join(" "));
  if (!joined) return fallback;

  const m = SENTENCE_END.exec(joined);
  // 문장 경계가 없거나(부호 없는 지시) 너무 짧으면 이은 것 전체를 쓴다.
  const head = m && m.index >= MIN_SENTENCE ? joined.slice(0, m.index) : joined;
  // head 는 joined 이거나 그 앞 4자 이상 조각이라 여기서 다시 빌 수 없다 — 부호만 친 입력이면 ""가 맞다(종전과 같다).
  return cut(trimEndPunct(squeeze(head)));
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
