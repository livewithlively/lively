// 프리뷰 화면의 파비콘을 **미리보기 전용 아이콘**으로 바꾼다(#1572).
//  왜: 프리뷰(`/preview/<id>/ui/`)는 라이브(`/ui/`)와 같은 코드·같은 화면이라 탭에 나란히 떠 있으면 구분이 안 된다.
//  탭 제목까지 같으니 사람이 "지금 보는 게 라이브인가 미리보기인가"를 판단할 단서가 없고, 실제로 라이브를 미리보기로
//  착각한 채 화면을 확인하는 사고가 난다. 파비콘은 탭이 좁아져 제목이 잘려도 끝까지 남는 유일한 표식이라 여기에 건다.
//  어디서: HTML 응답이 프리뷰 라우트를 통과할 때 런타임 치환한다 — public/*.html 원본은 그대로 둔다.
//  (원본을 고치면 라이브까지 바뀐다. 또 프리뷰의 실체는 "어떤 브랜치의 워크트리든" 이라 원본에 손댈 수도 없다.)

// 미리보기 아이콘 — 어두운 사각 배경 + 민트 뷰파인더 모서리.
//  · 뷰파인더(카메라 모서리) = 프레이밍해서 확인하는 중 = 미리보기 · 민트 = 라이블리 시그니처(주역)
//  · 어두운 배경(#1E2A26)이 민트를 가장 세게 받쳐 16px 에서 또렷하고, 라이브(밝은 민트 **채움원**)와
//    명도·형태가 모두 달라 나란히 떠 있어도 갈린다. 터미널 파비콘(어두운 사각 + 민트 심볼)과 같은 형식이다.
//  ⚠ 모서리 팔의 길이(3)·굵기(2.4)가 이 아이콘의 생명이다 — 처음엔 팔이 짧고 얇아서(1.6/1.5)
//    16px 에서 **점 네 개로 뭉갰다**. 값을 줄이면 그 상태로 돌아간다. 바꾸려면 16px 렌더를 직접 보고 정해라.
const PREVIEW_ICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3E" +
  "%3Crect%20width='16'%20height='16'%20rx='4'%20fill='%231E2A26'/%3E" +
  "%3Cpath%20d='M3.6%206.6V3.6h3M12.4%206.6V3.6h-3M3.6%209.4V12.4h3M12.4%209.4V12.4h-3'" +
  "%20stroke='%2316C79A'%20stroke-width='2.4'%20fill='none'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E";

const ICON_LINK = `<link rel="icon" href="${PREVIEW_ICON}">`;
// 기존 아이콘 선언 제거용 — rel 이 href 앞/뒤 어디에 오든, 따옴표가 있든 없든 잡는다.
//  apple-touch-icon 까지 포함: 홈화면에 담을 때도 미리보기가 라이브 행세를 하면 안 된다.
const ICON_LINK_RE = /<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bicon\b[^"]*"|'[^']*\bicon\b[^']*'|[^\s"'>]*icon[^\s"'>]*)[^>]*>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;

/** HTML 의 파비콘 선언을 미리보기 아이콘 하나로 교체한다. head 가 없으면 문서 앞에 붙인다(브라우저가 암묵 head 로 넣는다). */
export function withPreviewFavicon(html: string): string {
  const stripped = html.replace(ICON_LINK_RE, "");
  const m = HEAD_OPEN_RE.exec(stripped);
  if (m) return stripped.slice(0, m.index + m[0].length) + ICON_LINK + stripped.slice(m.index + m[0].length);
  return ICON_LINK + stripped;
}

/** 이 응답 바디를 치환해도 되는지 — HTML(utf-8) 이고 인코딩(gzip 등)이 안 걸려 있어야 한다. 하나라도 어긋나면 손대지 않고 흘린다. */
export function isRewritableHtml(contentType: unknown, contentEncoding: unknown): boolean {
  if (typeof contentType !== "string" || !/^\s*text\/html\b/i.test(contentType)) return false;
  const cs = /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType); // 미명시는 통과(우리 화면은 utf-8), 명시됐으면 utf-8 만
  if (cs && !/^utf-?8$/i.test(cs[1])) return false;
  if (typeof contentEncoding === "string" && contentEncoding.trim() !== "" && !/^identity$/i.test(contentEncoding.trim())) return false;
  return true;
}
