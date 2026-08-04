// 인증 흐름의 **서버 렌더 페이지 셸** — OAuth 동의 화면(#1473 T2)과 OIDC 계정 연결 화면(#1520)이 공유한다.
//  원래 org/auth/oauth-consent.ts 안에 있던 esc/STYLE/page/errorPage 를 **verbatim 이동**한 것이다(문구·CSS 무변경).
//  왜 나눴나: 로그인 전에 뜨는 화면이 둘이 됐는데 셸이 한쪽에만 있으면 스타일이 갈라진다 — 같은 흐름 안에서
//   화면 생김새가 바뀌면 사람은 '다른 사이트로 넘어갔나' 하고 멈춘다(그 순간이 피싱 의심 지점이기도 하다).
//  왜 SPA 가 아니라 서버 렌더인가: 이 화면들은 **세션을 얻기 전**에 떠야 한다. 프런트 빌드와 결합하지 않으면
//   백엔드만으로 흐름을 닫을 수 있다(oauth-consent.ts 헤더의 판단을 그대로 잇는다).

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));

const STYLE = `
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:2.5rem 1rem;
       background:#f6f7f9;color:#16181d;line-height:1.6}
  main{max-width:30rem;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:1.75rem}
  h1{font-size:1.15rem;margin:0 0 .25rem}
  .sub{color:#5b6270;font-size:.875rem;margin:0 0 1.25rem}
  .box{background:#f6f7f9;border:1px solid #e8ebef;border-radius:10px;padding:.85rem 1rem;margin:0 0 1rem;font-size:.875rem}
  .box dt{color:#5b6270;font-size:.78rem;margin-top:.55rem}
  .box dt:first-child{margin-top:0}
  .box dd{margin:.1rem 0 0;word-break:break-all}
  ul.scopes{margin:.35rem 0 0;padding-left:1.1rem}
  ul.scopes li{margin:.15rem 0}
  .warn{background:#fff8e6;border-color:#f2e2b5;color:#6b5518}
  .err{background:#fdecec;border-color:#f3c9c9;color:#8c2020}
  label{display:block;font-size:.8rem;color:#5b6270;margin:.75rem 0 .25rem}
  input[type=email],input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid #d5d9df;border-radius:8px;
       font-size:.95rem;background:#fff;color:inherit}
  .row{display:flex;gap:.6rem;margin-top:1.25rem}
  button{flex:1;padding:.65rem 1rem;border-radius:8px;border:1px solid transparent;font-size:.925rem;
       font-weight:600;cursor:pointer}
  button.primary{background:#1f6feb;color:#fff}
  button.ghost{background:#fff;border-color:#d5d9df;color:#3a4150}
  .foot{margin-top:1.1rem;font-size:.78rem;color:#79808d}
  a{color:#1f6feb}
  @media (prefers-color-scheme:dark){
    body{background:#0f1115;color:#e6e8ec}
    main{background:#171a20;border-color:#272b33}
    .box{background:#12141a;border-color:#272b33}
    .box dt,.sub,.foot{color:#9aa1ad}
    input[type=email],input[type=password]{background:#0f1115;border-color:#333946;color:#e6e8ec}
    button.ghost{background:#171a20;border-color:#333946;color:#c8ccd4}
    .warn{background:#2a2413;border-color:#4a3f1c;color:#e3cd8a}
    .err{background:#2b1616;border-color:#4d2222;color:#f0b4b4}
  }`;

export const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="referrer" content="no-referrer">` + // rid·연결코드가 외부로 새지 않게(이 페이지의 링크·리다이렉트 모두)
  `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

// 흐름별 제목을 받되 본문 형식은 공통 — '무엇을 할 수 없다'를 먼저 말하고 다음 행동을 알려준다.
export const errorPage = (msg: string, title = "연결 승인 — Lively", foot = "이 창을 닫고 연결을 처음부터 다시 시도해 주세요."): string =>
  page(title, `<h1>연결을 진행할 수 없습니다</h1><div class="box err">${esc(msg)}</div>` +
    `<p class="foot">${esc(foot)}</p>`);
