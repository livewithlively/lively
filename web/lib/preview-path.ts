// lib/preview-path.ts — 미리보기 주소(`/preview/<id>/…`)를 읽고 같은 화면의 실제 워크스페이스 주소로 바꾼다(#5581).
//  순수 함수만 둔다 — 화면(v2/preview-strip.ts)과 시험(scripts/preview-strip.test.mjs)이 같이 쓴다.
//  id 모양은 서버 라우트(src/preview/routes.ts ID_CAP)와 같다.

const PREVIEW_PATH = /^(.*?)\/preview\/([a-z0-9][a-z0-9_-]{0,63})(\/.*)?$/i;

/** 이 경로가 미리보기 안인가 — 그렇다면 미리보기 id, 아니면 null. */
export function previewIdOf(pathname: string): string | null {
  const m = PREVIEW_PATH.exec(String(pathname || ''));
  return m ? m[2] : null;
}

/** 미리보기 주소 → 같은 화면의 실제 워크스페이스 주소(같은 출처 상대). 미리보기가 아니면 null.
 *  `embed` 표는 떼고(곁칸 표 — 바깥 창에선 뜻이 없다) 나머지 쿼리·해시는 그대로 둔다. */
export function liveUrlOf(loc: { pathname: string; search: string; hash: string }): string | null {
  const m = PREVIEW_PATH.exec(String(loc.pathname || ''));
  if (!m) return null;
  const q = new URLSearchParams(loc.search || '');
  q.delete('embed');
  const qs = q.toString();
  return (m[1] || '') + (m[3] || '/') + (qs ? '?' + qs : '') + (loc.hash || '');
}
