// 앱 주소에서 v1 앱 화면을 «문서로» 내는 조각(#4480 v2-1). 순수 + 준비물 읽기 — app-front-page.test.ts.
//
//  v1 앱은 화면 한 장(HTML)을 DB(org_app_ui_asset)에 두고, 라이블리 화면이 받아 srcdoc 으로 띄웠다(web/v2/app-ui.ts).
//   앱 주소(<앱>-<워크스페이스>.lvly.app)로 옮기면 그 HTML 을 **그 주소의 문서**로 내야 한다 — 같은 앱이 두 길(옛 srcdoc · 앱 주소)
//   어느 쪽으로 떠도 똑같이 돌게, 넣는 것은 srcdoc 때와 같다:
//   · SDK 런타임(window.lively) — 원본은 web/v2/app-ui-runtime.ts **한 벌**. 서버는 웹 빌드 산출물(public/app/…)을 읽는다.
//   · 앱 만들기 탐침(PROBE_JS, 「찍어서 의견」) — 원본은 web/lib/studio-flow.ts 한 벌. 앱 주소 쿼리 `__lively_probe=1` 일 때만.
//   · CSP — srcdoc 은 meta 로만 실을 수 있었다. 여기서는 HTTP 헤더로 싣는다. 규칙은 app-ui.ts buildCsp 와 같고
//     connect-src 에 'self' 하나만 더한다(같은 주소의 /_lively/* 를 부를 수 있게 — 바깥 연결은 여전히 매니페스트 선언만).
//     #4482 v2-3 — 폼은 **제 주소로만** 보낸다(form-action 'self'): 앱 화면 iframe 이 allow-forms 를 받아 평범한 <form> 이 돈다.
//     바깥 주소로 보내는 폼(피싱 · 데이터 반출)은 여전히 막힌다. srcdoc(옛 길)은 제 주소가 없어 'none' 그대로(제출 이벤트는 돈다).
//  frame-ancestors(그 워크스페이스 라이블리 주소 안에서만 iframe)는 앞단(CP 라우터)이 모든 응답에 붙인다.

export interface AppCsp {
  connect_domains?: string[]; resource_domains?: string[]; frame_domains?: string[];
  /** #4673 — 앱 폴더를 선언한 앱의 서명 주소 자리(`<게이트웨이>/api/files/s/` — files/app-screen-csp). 매니페스트 칸이 아니라 서버가 채운다. */
  files?: string | null;
}

// 서명 주소 자리 출처 식의 모양 — 헤더에 그대로 들어가므로 ; · 공백이 끼면 지시문이 는다. 모양이 아니면 버린다.
const FILES_SRC_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/api\/files\/s\/$/;
/** 지시문 값 뒤에 서명 주소 자리를 붙인다('none' 이면 그 자리로 바꾼다). */
function withFiles(list: string, files: string | null | undefined): string {
  if (!files || !FILES_SRC_RE.test(files)) return list;
  return list === "'none'" ? files : `${list} ${files}`;
}

const CSP_HOST_RE = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/;

/** 선언 도메인 → CSP 소스(app-ui.ts srcList 와 같은 뜻). 꼴이 이상한 값은 버린다(헤더에 ; 가 끼면 지시문이 늘어난다). */
function srcList(domains: unknown, extra?: string): string {
  const list = (Array.isArray(domains) ? domains : []).map((d) => String(d).trim().toLowerCase()).filter((d) => d && CSP_HOST_RE.test(d));
  const base = extra ? [extra] : [];
  if (!list.length) return base.length ? base.join(" ") : "'none'";
  if (list.includes("*")) return [...base, "https:"].join(" ");
  return [...base, ...list.map((d) => "https://" + d)].join(" ");
}

/** 앱 문서의 CSP(헤더 값). 외부 스크립트는 어떤 선언으로도 열지 않는다 — 앱 안에서 도는 코드는 그 앱의 것과 우리가 넣는 것뿐. */
export function appPageCsp(csp?: AppCsp | null): string {
  const c = csp ?? {};
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src " + withFiles(srcList(c.resource_domains, "data:"), c.files),
    "font-src " + srcList(c.resource_domains, "data:"),
    "media-src " + withFiles(srcList(c.resource_domains), c.files),
    "connect-src " + withFiles(srcList(c.connect_domains, "'self'"), c.files),
    "frame-src " + srcList(c.frame_domains),
    "form-action 'self'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * #4481 여러 파일 앱(web.root)의 문서 CSP — 위(v1)와 같은 선언(connect · resource · frame)을 따르되 **제 주소('self')의 파일**을 연다:
 *  빌드 도구가 만든 `<script type="module" src="/assets/…">` · 스타일 · 그림 · 폰트 · 워커 · 매니페스트. 외부 스크립트는 여전히 어떤 선언으로도 못 연다.
 *  'wasm-unsafe-eval' 은 WebAssembly 컴파일만 허락한다(JS eval 은 아니다 — 같은 샌드박스 안이라 새 권한이 아니다).
 *  form-action 'self' — #4482 v2-3: 폼은 제 주소로만(서버 없는 앱의 POST 는 앞단이 405, v2-6 부터 앱 서버로).
 */
export function appPageCspMulti(csp?: AppCsp | null): string {
  const c = csp ?? {};
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src " + withFiles(srcList(c.resource_domains, "'self' data: blob:"), c.files),
    "font-src " + srcList(c.resource_domains, "'self' data:"),
    "media-src " + withFiles(srcList(c.resource_domains, "'self' blob:"), c.files),
    "connect-src " + withFiles(srcList(c.connect_domains, "'self'"), c.files),
    "frame-src " + srcList(c.frame_domains),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * #4481 여러 파일 앱을 srcdoc(종전 길)으로 열게 됐을 때 — 이 브라우저가 앱 주소 로그인 쿠키를 막은 경우. 까닭과 할 일을 보인다.
 *  #4482 — 앱 주소를 알면 «새 탭에서 열기» 단추를 단다: 새 탭은 맨 위 페이지라 쿠키가 막히지 않고, 앱은 /_lively/* 로 그대로 돈다.
 *   srcdoc 은 팝업이 막혀 있어 호스트가 대신 연다(SDK lively.ui.openExternal — 이 문서에도 런타임이 들어간다).
 */
export function multiFileFallbackHtml(title: string, appUrl?: string | null): string {
  const base = appErrorHtml(`「${title}」 은(는) 이 브라우저의 라이블리 화면 안에서 열 수 없습니다`,
    "이 앱은 여러 파일로 된 앱이라 앱 주소(lvly.app)에서만 열립니다. 이 브라우저가 라이블리 화면 안에서는 앱 주소의 로그인 쿠키를 막고 있어요 — "
    + (appUrl ? "새 탭에서 열면 그대로 쓸 수 있어요." : "크롬 · 파이어폭스 · 최신 사파리(26.2 이상) · 라이블리 데스크톱 앱에서 열어 주세요."));
  //  주소는 서버가 만든 앱 주소다 — 그래도 HTML 속성 · 스크립트를 깰 글자(따옴표 · 꺾쇠 · 역슬래시 · 공백 · 백틱)가 있으면 단추를 달지 않는다.
  if (!appUrl || !/^https:\/\/[a-z0-9.-]+\/[^"'`<>\\\s]*$/.test(appUrl)) return base;
  const js = "window.lively&&window.lively.ui.openExternal(" + JSON.stringify(appUrl).replace(/</g, "\\u003c") + ")";
  const button = "<p><button type=\"button\" onclick='" + js.replace(/&/g, "&amp;").replace(/'/g, "&#39;") + "' style=\"font:inherit;padding:6px 14px;border-radius:8px;border:1px solid #ccd;background:#fff;cursor:pointer\">새 탭에서 열기</button></p></body>";
  //  함수 치환 — 문자열 치환이면 주소의 `$&` · `$'` 같은 글자가 치환 패턴으로 읽혀 문서가 깨진다(격리 리뷰 9).
  return base.replace("</body>", () => button);
}

/** HTML 안에 넣는 스크립트가 문서를 깨지 않게 — `</script` 를 끊는다(원본 둘 다 우리 코드지만 한 번 더 막는다). */
const inlineSafe = (js: string): string => js.replace(/<\/script/gi, "<\\/script");

/** SDK 런타임(+ 탐침)을 문서 머리에 끼운다(doctype 뒤 · 없으면 맨 앞). app-ui.ts wrapAppHtml 과 같은 자리. */
export function buildAppPageHtml(html: string, scripts: { runtime: string; probe?: string | null }): string {
  const head = "<script>" + inlineSafe(scripts.runtime) + "</script>" + (scripts.probe ? "<script>" + inlineSafe(scripts.probe) + "</script>" : "");
  const m = /<!doctype[^>]*>/i.exec(html);
  if (m) { const i = m.index + m[0].length; return html.slice(0, i) + head + html.slice(i); }
  return head + html;
}

/** 오류 화면 — 앱 주소 iframe 안에 JSON 이 그대로 보이지 않게 짧은 문서로 답한다. */
export function appErrorHtml(title: string, detail: string): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
  return "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + esc(title) + "</title>"
    + "<body style=\"font:14px/1.6 system-ui,sans-serif;color:#333;margin:0;padding:24px\"><b>" + esc(title) + "</b><p>" + esc(detail) + "</p></body>";
}

// ── 준비물 읽기 — 웹 빌드 산출물(public/app)의 원본 두 벌. 한 번 읽어 둔다(실패하면 다음 요청에 다시). ──
export interface AppScripts { runtime: string; probe: string }
let cached: Promise<AppScripts> | null = null;
export function loadAppScripts(base: URL = new URL("../../public/app/", import.meta.url)): Promise<AppScripts> {
  if (!cached) {
    cached = (async () => {
      const rt = await import(new URL("v2/app-ui-runtime.js", base).href) as { APP_RUNTIME_JS?: unknown };
      const sf = await import(new URL("lib/studio-flow.js", base).href) as { PROBE_JS?: unknown };
      if (typeof rt.APP_RUNTIME_JS !== "string" || !rt.APP_RUNTIME_JS.includes("window.lively")) throw new Error("SDK 런타임을 읽지 못했습니다");
      if (typeof sf.PROBE_JS !== "string" || !sf.PROBE_JS) throw new Error("앱 만들기 탐침을 읽지 못했습니다");
      return { runtime: rt.APP_RUNTIME_JS, probe: sf.PROBE_JS };
    })();
    cached.catch(() => { cached = null; });
  }
  return cached;
}
