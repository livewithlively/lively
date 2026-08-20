// 인증 흐름의 **서버 렌더 페이지 셸** — OAuth 동의 화면(#1473 T2)과 OIDC 계정 연결 화면(#1520)이 공유한다.
//  원래 org/auth/oauth-consent.ts 안에 있던 esc/STYLE/page/errorPage 를 **verbatim 이동**한 것이다(문구·CSS 무변경).
//  왜 나눴나: 로그인 전에 뜨는 화면이 둘이 됐는데 셸이 한쪽에만 있으면 스타일이 갈라진다 — 같은 흐름 안에서
//   화면 생김새가 바뀌면 사람은 '다른 사이트로 넘어갔나' 하고 멈춘다(그 순간이 피싱 의심 지점이기도 하다).
//  왜 SPA 가 아니라 서버 렌더인가: 이 화면들은 **세션을 얻기 전**에 떠야 한다. 프런트 빌드와 결합하지 않으면
//   백엔드만으로 흐름을 닫을 수 있다(oauth-consent.ts 헤더의 판단을 그대로 잇는다).

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));

const STYLE = `
  /* 색은 토큰 한 벌로 두고 테마별로 값만 뒤집는다(#1683) — 웹 앱(public/styles/01-base.css·90-dark.css)과 같은
     브랜드 네이비 축이라, 로그인 전 화면과 로그인 후 화면이 한 제품으로 보인다. */
  :root{
    color-scheme:light;
    --p-bg:#F6F7F9; --p-surface:#FFFFFF; --p-ink:#16181D; --p-sub:#5B6270; --p-foot:#79808D;
    --p-line:#E3E6EA; --p-line-2:#E8EBEF; --p-field-line:#D5D9DF; --p-box:#F6F7F9;
    --p-blue:#1F6FEB; --p-ghost-ink:#3A4150;
    --p-warn-bg:#FFF8E6; --p-warn-line:#F2E2B5; --p-warn-ink:#6B5518;
    --p-err-bg:#FDECEC; --p-err-line:#F3C9C9; --p-err-ink:#8C2020;
  }
  /* 다크 값 — 명시 선택(data-theme)과 시스템 설정 두 경로. 본문 대비 15:1, 보조 9:1(웹 앱과 같은 기준). */
  :root[data-theme=dark]{
    color-scheme:dark;
    --p-bg:#0C111D; --p-surface:#1A2336; --p-ink:#EAF0FA; --p-sub:#B0BDD5; --p-foot:#8D9CB8;
    --p-line:#273349; --p-line-2:#202B3E; --p-field-line:#33425C; --p-box:#111726;
    --p-blue:#6E9AF8; --p-ghost-ink:#B0BDD5;
    --p-warn-bg:#33270F; --p-warn-line:#57431A; --p-warn-ink:#F0C97E;
    --p-err-bg:#3A1B1E; --p-err-line:#5C2B2F; --p-err-ink:#F49B91;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme=light]){
      color-scheme:dark;
      --p-bg:#0C111D; --p-surface:#1A2336; --p-ink:#EAF0FA; --p-sub:#B0BDD5; --p-foot:#8D9CB8;
      --p-line:#273349; --p-line-2:#202B3E; --p-field-line:#33425C; --p-box:#111726;
      --p-blue:#6E9AF8; --p-ghost-ink:#B0BDD5;
      --p-warn-bg:#33270F; --p-warn-line:#57431A; --p-warn-ink:#F0C97E;
      --p-err-bg:#3A1B1E; --p-err-line:#5C2B2F; --p-err-ink:#F49B91;
    }
  }
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:2.5rem 1rem;
       background:var(--p-bg);color:var(--p-ink);line-height:1.6}
  main{max-width:30rem;margin:0 auto;background:var(--p-surface);border:1px solid var(--p-line);border-radius:14px;padding:1.75rem}
  h1{font-size:1.15rem;margin:0 0 .25rem}
  .sub{color:var(--p-sub);font-size:.875rem;margin:0 0 1.25rem}
  .box{background:var(--p-box);border:1px solid var(--p-line-2);border-radius:10px;padding:.85rem 1rem;margin:0 0 1rem;font-size:.875rem}
  .box dt{color:var(--p-sub);font-size:.78rem;margin-top:.55rem}
  .box dt:first-child{margin-top:0}
  .box dd{margin:.1rem 0 0;word-break:break-all}
  ul.scopes{margin:.35rem 0 0;padding-left:1.1rem}
  ul.scopes li{margin:.15rem 0}
  .warn{background:var(--p-warn-bg);border-color:var(--p-warn-line);color:var(--p-warn-ink)}
  .err{background:var(--p-err-bg);border-color:var(--p-err-line);color:var(--p-err-ink)}
  label{display:block;font-size:.8rem;color:var(--p-sub);margin:.75rem 0 .25rem}
  input[type=email],input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid var(--p-field-line);border-radius:8px;
       font-size:.95rem;background:var(--p-surface);color:inherit}
  .row{display:flex;gap:.6rem;margin-top:1.25rem}
  button{flex:1;padding:.65rem 1rem;border-radius:8px;border:1px solid transparent;font-size:.925rem;
       font-weight:600;cursor:pointer}
  button.primary{background:#1F6FEB;color:#fff}
  button.ghost{background:var(--p-surface);border-color:var(--p-field-line);color:var(--p-ghost-ink)}
  .foot{margin-top:1.1rem;font-size:.78rem;color:var(--p-foot)}
  a{color:var(--p-blue)}`;

// 테마 pre-paint — 웹 앱이 저장한 선택(localStorage lv:theme)을 첫 페인트 전에 반영한다(#1683).
//  같은 출처라 그 키가 그대로 보인다. 없으면 속성을 안 붙이고 시스템 설정을 따른다(종전 동작 그대로).
//  ⚠ 이 페이지는 세션 이전에 뜨므로 프런트 번들에 기대지 않는다 — 키 이름 하나만 공유하는 얕은 결합이다.
const THEME_BOOT = `<script>try{var t=localStorage.getItem('lv:theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>`;

export const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="referrer" content="no-referrer">` + // rid·연결코드가 외부로 새지 않게(이 페이지의 링크·리다이렉트 모두)
  `<title>${esc(title)}</title><style>${STYLE}</style>${THEME_BOOT}</head><body><main>${body}</main></body></html>`;

// 흐름별 제목을 받되 본문 형식은 공통 — '무엇을 할 수 없다'를 먼저 말하고 다음 행동을 알려준다.
export const errorPage = (msg: string, title = "연결 승인 — Lively", foot = "이 창을 닫고 연결을 처음부터 다시 시도해 주세요."): string =>
  page(title, `<h1>연결을 진행할 수 없습니다</h1><div class="box err">${esc(msg)}</div>` +
    `<p class="foot">${esc(foot)}</p>`);
