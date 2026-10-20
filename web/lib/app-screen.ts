// 화면 앱인가(#4485 후속) — 순수 판정 한 벌. 서버 짝: src/apps/app-server-config.ts serverDeclOf(web.server 선언) · 시험 scripts/app-screen.test.mjs.
//  화면 앱 = 화면 파일(ui.pages)이 있거나, 서버가 화면을 만드는 앱(web.server — 앱 주소의 모든 경로를 그 앱의 서버가 답한다).
//  아니면 세션 앱(그 앱 전용 AI 세션으로 연다). 앱 찾기 · 곁칸 앱 · 독 · 서랍 · 레일 · 앱빌더가 같은 자로 가른다.

/** 매니페스트가 앱 서버를 선언했나 — web.server 가 true 거나 객체(배열 · 거짓 값은 선언이 아니다). */
export function declaresServer(manifest: unknown): boolean {
  const web = manifest && typeof manifest === 'object' ? (manifest as { web?: unknown }).web : undefined;
  const s = web && typeof web === 'object' ? (web as { server?: unknown }).server : undefined;
  return s === true || (!!s && typeof s === 'object' && !Array.isArray(s));
}

/** 화면 앱인가 — 화면 파일이 있거나 서버가 화면을 만든다. */
export function hasAppScreen(a: { pages: ReadonlyArray<unknown>; server?: boolean }): boolean {
  return a.pages.length > 0 || a.server === true;
}
