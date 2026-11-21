// lib/ui-link.ts — AI 가 준 **우리 화면 링크**(같은 게이트웨이의 `/ui/#/…`) 가운데 곁칸에서 열 것을 가린다(#5583).
//
//  원준 2026-11-22 «자료를 링크로 줄 때 새 탭에서 열려서 세션이랑 한 번에 보기 힘듦 — 경로로 주는 것 눌렀을 때처럼 곁칸에서 보이게».
//   · 파일 경로(`/…/project/<번호>/a.md`)는 #4562 부터 곁칸 [자료] + 뷰어 탭으로 열렸다.
//   · 같은 파일을 **링크**(`<게이트웨이>/ui/#/f?root=shared&path=project%2F<번호>%2Fa.md` — file_url 이 주는 꼴)로 주면
//     #4083 의 «우리 화면 링크 = 브라우저 새 탭» 규칙을 타 새 탭으로 열렸다. 대화창에선 셸 해시가 바뀌어 셸 탭이 하나 늘었다.
//  그래서 링크가 가리키는 것이 **자료**(파일 보기 `#/f` · 지식 `#/k/`)면 곁칸으로 보낸다. 그 밖의 우리 화면(프로젝트·세션·관리 …)은
//   종전 규칙 그대로다 — 그건 «보면서 말할 자료» 가 아니라 «옮겨 갈 화면» 이다.
//
//  돌려주는 것:
//   · file — 프로젝트 자료의 **파일**. 경로 링크와 같은 길로 연다([자료] 탭 + 뷰어 탭). 이 곁칸의 프로젝트가 아니면 url 로 웹 칸에.
//   · web  — 그 밖의 자료 보기(폴더 · 공유 폴더 · 개인 · 앱 폴더)와 지식 문서. 곁칸 웹 칸에 그 화면을 싣는다(우리 화면이라 ?embed=1).
//
//  ⚠ 단독 터미널 번들은 의존 0 이라 이 파일을 못 싣는다 — web/standalone/ui-link.ts 가 **사본**이다.
//   scripts/ui-pane-link.test.mjs 가 두 사본을 같은 표로 돌린다 — 한쪽만 고치지 마라.

export type UiPaneLink =
  | { kind: 'file'; path: string; url: string }
  | { kind: 'web'; url: string };

/** 대화창 → 곁칸 알림(같은 문서 안 — 터미널은 iframe 이라 postMessage 를 쓴다). detail = { link: UiPaneLink, handled: false } — 받은 곁칸이 handled 를 켠다. */
export const PANE_LINK_EVENT = 'lively:pane-link';

/** 파일 이름 끝 — 확장자(글자로 시작, 10자 이내). 터미널 경로 링크(pathLinkTarget)와 같은 규칙. */
const FILE_END = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** href(절대·상대 모두) → 곁칸에서 열 것. here = 이 문서의 주소(셸 `/ui/` · 터미널 `/ui/terminal.html`). 곁칸 몫이 아니면 null. */
export function uiPaneLink(href: string, here: string): UiPaneLink | null {
  let u: URL, h: URL;
  try { u = new URL(String(href || ''), here); h = new URL(here); } catch (_) { return null; }
  if (u.origin !== h.origin) return null;
  //  우리 화면 = 이 문서와 같은 폴더(`/ui/`)의 첫 페이지 — 터미널 문서(`/ui/terminal.html`)에서도 셸(`/ui/`)을 가리킨다.
  const dir = h.pathname.replace(/[^/]*$/, '');
  if (u.pathname !== dir && u.pathname !== dir + 'index.html') return null;
  const m = /^#\/([^?#]*)(?:\?([^#]*))?/.exec(u.hash);
  if (!m) return null;
  const seg = m[1];
  if (seg === 'f') {
    const q = new URLSearchParams(m[2] || '');
    const root = q.get('root') || '', path = (q.get('path') || '').replace(/^\/+/, '');
    if (!root) return null;
    const pm = root === 'shared' ? /^project\/(\d+)\/(.+)$/.exec(path) : null;
    const safe = !!pm && Number(pm[1]) > 0 && !pm[2].split('/').some((x) => x === '' || x === '.' || x === '..');
    if (pm && safe && FILE_END.test(pm[2])) return { kind: 'file', path: 'project/' + Number(pm[1]) + '/' + pm[2], url: u.href };
    return { kind: 'web', url: u.href };
  }
  if (/^k\/[^/]+/.test(seg)) return { kind: 'web', url: u.href };
  return null;
}
