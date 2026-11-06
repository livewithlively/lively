// lib/doc-title.ts: 브라우저 탭 제목 한 벌 (#5301).
//
//  세션 창을 여럿 띄워 두면 브라우저 탭이 전부 «Lively Context» 였다. public/index.html 의 고정 제목을 셸이 한 번도
//   바꾸지 않았기 때문이다. 탭 줄만 보고는 어느 창이 어느 세션인지 고를 수 없었다.
//  그래서 셸(v2/main.ts)이 **지금 보는 화면의 이름**을 제목 앞에 둔다. 이름은 셸 탭 기계가 이미 매기는 값
//   (tabs.ts paint → main.ts titleFor)이라 사이드바 · 세션 머리줄과 같은 규칙(lib/sess-name.ts)을 탄다.
//  ★ 이름이 앞이다. 브라우저 탭은 폭이 좁아 앞 몇 글자만 보인다. 뒤의 제품 이름은 창 목록 · 방문 기록에서 출처를 말한다.
//  단독 터미널 탭(standalone/terminal.ts setTitle)도 같은 꼴(`이름 · Lively`)이다. 그쪽은 번들이 따로라 이 파일을
//   불러 쓰지 못하고 같은 글자를 따로 적는다.
//  시험: scripts/doc-title.test.mjs(값 · 배선 · 실제 탭 엔진을 헤드리스 크롬에서).

/** 제목 뒤에 붙는 제품 이름. 이름이 없는 화면은 이것만 쓴다. */
export const DOC_TITLE_APP = 'Lively';

/** 화면 이름 → 브라우저 탭 제목. 이름이 비면 제품 이름만 돌려준다.
 *  공백(줄바꿈 포함)은 한 칸으로 접는다. 첫 지시가 그대로 이름이 된 세션은 줄바꿈을 품는데, 탭은 한 줄만 보인다. */
export function docTitle(name: string | null | undefined): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  return n ? n + ' · ' + DOC_TITLE_APP : DOC_TITLE_APP;
}

/**
 * 지금 보이는 탭의 이름으로 문서 제목을 맞춘다. 셸 탭 기계가 이름을 다시 매길 때마다 부른다(tabs.ts onRetitled).
 *  · 탭이 없으면(부팅 중 · 아직 아무 탭도 안 켰다) 손대지 않는다. index.html 의 제목이 그대로 남는다.
 *  · 이름은 탭 기계가 방금 매긴 tab.title 을 쓴다. 목록이 오기 전에는 셸의 titleFor 가 id 꼬리(`세션 1d14b3`)를 돌려주는데,
 *    탭 기계는 그 값으로 저장해 둔 이름을 덮지 않는다(tabs.ts paint · #2022). 걸러진 그 값을 받아야 켠 직후에도 알던 이름이 선다.
 *  · 값이 같으면 쓰지 않는다. 셸은 8초 틱마다 이름을 다시 매긴다.
 */
export function syncDocTitle(doc: { title: string }, tab: { title: string } | null | undefined): void {
  if (!tab) return;
  const next = docTitle(tab.title);
  if (doc.title !== next) doc.title = next;
}

// ── 숨은 창에 새 이름 알리기 ────────────────────────────────────────────────
//  숨은 창은 목록을 새로 받지 않는다(main.ts 8초 틱 · 스트림 · refreshSideSoon 모두 document.hidden 이면 쉰다). 그래서 다른 창을 보는
//   동안 그 창이 보던 세션의 이름이 정해지거나 바뀌면(첫 턴에 AI 가 짓는 이름 · 사람이 고친 이름) 제목이 옛 이름에 머문다.
//  보이는 창이 **서버 목록에서** 새 이름을 알게 된 그 순간, 그 세션 하나의 이름만 같은 브라우저의 다른 창에 알린다(BroadcastChannel).
//  ⚠ 이름 기억 저장본(localStorage)의 storage 사건을 쓰지 않는 이유: 창마다 제 사본 통째로 저장본을 덮어써서(나중에 쓴 창이 이긴다)
//   새 값이 더 오래된 이름일 수 있다. 알림은 «방금 목록에서 본 값» 하나만 실어 그 문제가 없다.

/** 알림 통로 이름. 같은 브라우저의 같은 출처 창끼리만 닿는다. */
export const SESS_TITLE_CHANNEL = 'lively-v2-sess-title';
const SESS_TITLE_TYPE = 'sess-title';

/** 알릴 말 한 통 — 세션(박스 id) 하나의 지금 이름. */
export function sessTitleMsg(id: string, name: string): { type: string; id: string; name: string } {
  return { type: SESS_TITLE_TYPE, id, name };
}

/** 받은 말을 읽는다. 모양이 맞지 않거나 비었으면 null(다른 판의 창 · 엉뚱한 말은 버린다). */
export function readSessTitleMsg(data: unknown): { id: string; name: string } | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { type?: unknown; id?: unknown; name?: unknown };
  if (m.type !== SESS_TITLE_TYPE || typeof m.id !== 'string' || typeof m.name !== 'string') return null;
  const id = m.id.trim(); const name = m.name.trim();
  return id && name ? { id, name } : null;
}

/**
 * 받은 알림을 이 창에 적용한다 — **숨어 있고 · 지금 그 세션을 보고 있을 때만** 탭 이름과 문서 제목을 그 이름으로 맞춘다.
 *  · 보이는 창은 무시한다. 제 목록으로 8초마다 맞추고 있어서, 앞질러 바꾸면 다음 틱이 옛 값으로 되돌렸다가 다시 바꾼다.
 *  · 탭 이름(tab.title)도 함께 고친다. 문서 제목은 탭 이름에서 나오므로 둘이 어긋나지 않게(같은 말이 다시 와도 한 번만 쓴다).
 *    숨은 동안 셸이 옛 목록으로 이름을 다시 매기면 옛 이름으로 돌아갈 수 있다 — 창이 보이면 새 목록을 받아 맞는다.
 *    이 창의 이름 기억(main.ts sessNames)에는 넣지 않는다 — 기억은 이 창이 제 목록에서 본 값만 담는다.
 *  sessionId = 지금 탭이 보는 세션의 박스 id(세션 화면이 아니면 '').
 * @returns 적용했나
 */
export function applySessTitleMsg(data: unknown, view: { hidden: boolean; tab: { title: string } | null | undefined; sessionId: string; doc: { title: string } }): boolean {
  const { hidden, tab, sessionId, doc } = view;
  if (!hidden || !tab || !sessionId) return false;
  const m = readSessTitleMsg(data);
  if (!m || m.id !== sessionId || m.name === tab.title) return false;
  tab.title = m.name;
  syncDocTitle(doc, tab);
  return true;
}
