// lib/sess-name.ts: 세션을 화면에 부를 이름 한 벌 (#3870, 원준 2026-09-30).
//
//  사이드바 행(v2/side.ts sessText)과 세션 머리줄(session-chat.ts paintTitle)이 **같은 세션을 다른 이름으로** 불렀다
//  («사이드바엔 "우측 곁칸 AI세션 창 크기 및 상태 개선", 세션 위엔 첫 지시 60자»). 머리줄이 이 규칙을 약하게 베껴
//  썼기 때문이다 — 이름 없는(id 꼴) 세션에 첫 지시를 이름으로 박아 두고, 그 값이 pane 제목을 이겼다.
//  그래서 규칙을 여기 하나로 두고 둘 다 이것만 부른다. 순수 함수(DOM·상태 없음)라 시험이 값으로 지킨다
//  (scripts/sess-name.test.mjs).

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// 하네스가 pane 제목에 자기 이름만 써 둔 것 — '지금 하는 일'이 아니다(정보 0).
const HARNESS_TITLES = new Set(['claude code', 'claude', 'codex', 'opencode', 'antigravity', 'grok', 'shell', 'bash', 'zsh', 'tmux', 'node']);
// 기계가 붙인 세션 이름 — 사람이 읽을 게 없다('이어보기 · 3e1ca8f2', '위탁 #t501ac…').
// 이름 자리에서 걷어낼 자동 생성 이름. ⚠ **id 꼴은 따로 본다**(#1744) — '위탁 #41'·'이어보기 · 3e1ca8f2' 는
//  pane 제목이 없을 때 마지막 폴백으로 쓸 값은 되지만(무슨 세션인지는 말해 준다), `box-yoon-40096683` 은 아무것도
//  말해 주지 않아 폴백으로도 못 쓴다. 이름을 안 주고 만든 세션이 그 꼴이 된다(sessions.ts: label = … || id).
export const isIdLabel = (s: string) => /^box-/i.test(s) || /^[0-9a-f-]{20,}$/i.test(s);
export const isMachineLabel = (s: string) => /^이어보기\s*[·:]/.test(s) || /^위탁\s*#/.test(s) || isIdLabel(s);

/** 이 이름이 프로젝트명의 되풀이인가. 세 모양을 다 잡는다(실측):
 *   ① 그대로              "APP. lvly. io 셀프서브 방식 와이어프레임"
 *   ② 만들 때 잘린 것      "라이블리 키트, cli, 노드 등록을 지금 다 cli에서 해야하는데, 이거 윈도…"(프로젝트명의 앞부분)
 *   ③ 조각만 이어붙인 변형  "app.lvly.io 와이어프레임" ⊂ "APP. lvly. io 셀프서브 방식 와이어프레임"
 *  ③은 글자·숫자만 남긴 뒤 공통 앞머리 + 공통 꼬리가 이름 전체를 덮으면 되풀이로 본다(우연 일치를 막으려 6자 미만은 제외). */
function echoesProject(label: string, proj: string): boolean {
  const a = norm(label); const b = norm(proj);
  if (!a || !b) return false;
  if (a === b || b.startsWith(a) || a.startsWith(b)) return true;
  const ca = a.replace(/[^\p{L}\p{N}]/gu, ''); const cb = b.replace(/[^\p{L}\p{N}]/gu, '');
  if (ca.length < 6 || !cb) return false;
  let head = 0; while (head < ca.length && head < cb.length && ca[head] === cb[head]) head++;
  let tail = 0; while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail]) tail++;
  return head + tail >= ca.length;
}

/** '하던 일'이 이름을 **되풀이만** 하는가 — 그러면 둘째 줄에 쓸 값이 아니다.
 *  종전엔 완전 일치만 봤는데, 기록 행의 이름은 대화 제목의 앞머리(28자 규칙)라 늘 '앞부분만 같다'가 된다(#2234).
 *  꼬리 말줄임(…)은 자른 자리 표시일 뿐이므로 떼고 잰다. */
function restates(work: string, name: string): boolean {
  const w = norm(work); const n = norm(name).replace(/…+$/, '').trim();
  return !!n && (w === n || w.startsWith(n));
}

/** 이름 규칙의 재료 — label = 세션 이름(서버 label, 없으면 id), work = 그 세션이 '하던 일'(pane 제목 → 없으면 대화 제목), harness = 하네스 이름. */
export interface SessNameInput { label?: string | null; work?: string | null; harness?: string | null }
export interface SessFace { main: string; sub: string; named: boolean; untitled: boolean }

/** 세션 행에 쓸 글 — ★프로젝트명 반복을 걷어낸다.
 *  프로젝트에서 연 세션은 이름이 **프로젝트명 그대로**인 게 대다수(dev 실측 2026-08-18: 25건 중 14건) — 그 이름은 바로 위
 *  프로젝트 행이 이미 말하고 있다. 같은 제목이 한 화면에 대여섯 번 반복돼 목록이 통째로 안 읽히던 원인이라 지운다.
 *  대신 하네스가 pane 제목에 써 두는 '지금 하는 일'이 그 자리를 받는다 — 실제로 세션을 구분해 주던 건 그 줄이었다.
 *  이름이 따로 있는 세션(사람이 지은 것)만 두 줄이 된다. 원래 이름은 툴팁에 남는다(정보를 버리지는 않는다). */
export function sessNameFace(s: SessNameInput, projName: string): SessFace {
  const label = String(s.label || '').trim();
  //  멈춘 세션엔 pane 제목이 없다(박스가 없으니 훔쳐볼 화면도 없다) — 그 자리를 **중앙 기록의 대화 제목**
  //  (= 그 세션에 처음 시킨 말)이 받는다. 없으면 종전대로 이름만 남는다.
  const work = String(s.work || '').trim();
  let name = label;
  // '프로젝트명 + 꼬리'(예: "… 와이어프레임 - 3열")면 꼬리만 남기고, 그 밖의 되풀이는 통째로 지운다.
  if (projName && label.startsWith(projName)) name = label.slice(projName.length).replace(/^[\s·:\-–—_/|]+/, '').trim();
  if (projName && name && echoesProject(name, projName)) name = '';
  if (isMachineLabel(name)) name = '';
  const job = work && !HARNESS_TITLES.has(norm(work)) && !restates(work, name) ? work : '';
  //  named = 이 이름이 **그 세션의 이름**에서 나왔나(라벨). false 면 pane 제목·대화 제목을 빌려 온 것이라
  //   화면에 쓰기는 해도 **기억해 두지는 않는다**(main.ts rememberSessName · #2028 이 세운 규칙의 나머지 반쪽).
  if (name && job) return { main: name, sub: job, named: true, untitled: false };
  if (name || job) return { main: name || job, sub: '', named: !!name, untitled: false };
  const last = (isIdLabel(label) ? '' : label);
  //  untitled = 이름 · 작업 제목 · 대화 제목이 다 없어 하네스 이름이나 «이름 없는 세션»으로 떨어졌다(#4233 — [AI 세션] 목록이 묶음마다 한 줄로 접는다).
  return { main: last || String(s.harness || '') || '이름 없는 세션', sub: '', named: !!last, untitled: !last };
}
