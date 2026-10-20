// 앱 서버가 만든 화면 문서에 라이블리 SDK 런타임 넣기(#4485 후속, 상민 2026-10-20) — 순수 조각 + 조각 흐름 끼우개. 시험 app-server-page.test.ts.
//
//  왜: 라이블리 화면은 앱 주소로 띄운 문서가 8초 안에 `ui/initialize` 로 인사하지 않으면 종전 화면(srcdoc)으로 바꾼다(web/v2/app-ui.ts).
//   정적 · 여러 파일 앱의 문서에는 게이트웨이가 런타임을 머리에 넣어(app-front-page.ts buildAppPageHtml) 늘 인사하지만, 앱 서버가 만든 문서는
//   그대로 흘려 보내 런타임이 없었다 → 서버 앱이 라이블리 안에서 8초 뒤 정적 화면으로 바뀌었다(2026-10-19 매니지드 실측 · 시험 앱 v26-check).
//  무엇을:
//   · 문서 요청(브라우저가 문서로 여는 것 — Sec-Fetch-Dest document · iframe · frame, 그 머리가 없으면 Accept 의 text/html + navigate)의 HTML 답에만.
//     fetch 로 받는 HTML 조각 · JSON · 파일 · 압축된 답 · 본문 없는 답(204 · 205 · 304) · 옮기기(3xx) · 부분 답(206)은 손대지 않는다.
//   · 자리는 정적 화면과 같다 — doctype 바로 뒤(없으면 맨 앞 · BOM 뒤). 본문이 조각으로 오므로 doctype 이 끝날 때까지만(1KB 안) 모았다 보낸다.
//   · 모양은 앱의 CSP 를 보고 고른다 — 스크립트를 막지 않으면 인라인, nonce 를 쓰면 그 nonce 를 단 인라인, 인라인이 막혔으면 같은 주소의 파일
//     (/_lively/sdk.js — 'self' 로 열린다 · app-front-routes.ts 가 낸다). 문서 안 <meta> CSP 는 그보다 뒤의 것에만 걸린다(우리 것은 그 앞에 선다).
//   · 인라인은 ASCII 로만 쓴다 — 문서의 문자 집합이 UTF-8 이 아니어도 런타임 안의 한글 글이 깨지지 않게.
import { createHash } from "node:crypto";

/** 같은 주소의 런타임 · 탐침 파일(앞단이 `/_lively/*` 를 코어 /api/app-front/lively 로 넘긴다 — 앱 서버로 가지 않는 우리 자리). */
export const SDK_PATH = "/_lively/sdk.js";
export const PROBE_PATH = "/_lively/probe.js";

type Headers = Record<string, string | string[] | undefined>;
const one = (h: Headers, k: string): string => { const v = h[k]; return String((Array.isArray(v) ? v[0] : v) ?? "").trim(); };

const DOC_DESTS = new Set(["document", "iframe", "frame"]);

/** 브라우저가 이 답을 문서로 여나(순수) — 폼 제출 결과 화면(POST)도 문서다. HEAD 는 본문이 없다. */
export function isDocumentRequest(method: string, headers: Headers): boolean {
  const m = method.toUpperCase();
  if (m === "HEAD" || m === "OPTIONS") return false;
  const dest = one(headers, "sec-fetch-dest").toLowerCase();
  if (dest) return DOC_DESTS.has(dest);
  //  Sec-Fetch-* 를 안 보내는 옛 브라우저 — 앞단(appfront.ts navigating)과 같은 규칙.
  const mode = one(headers, "sec-fetch-mode").toLowerCase();
  return /text\/html/i.test(one(headers, "accept")) && (mode === "navigate" || !mode);
}

//  문서 요청을 함수로 넘길 때 뺄 머리 — 압축(Accept-Encoding)이 없어야 넣을 수 있고, 조건부 요청(304)이면 넣을 본문이 없다.
const DOC_DROP = new Set(["accept-encoding", "if-none-match", "if-modified-since"]);
/** 문서 요청의 머리 → 함수로 넘길 머리(순수 · 원본은 그대로 둔다). */
export function documentRequestHeaders(headers: Headers): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) if (!DOC_DROP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** 이 답에 넣나(순수) — 머리 이름은 소문자(responseHeadersOf). 문서 요청인지는 부르는 쪽이 본다. */
export function injectableResponse(status: number, headers: Record<string, string>): boolean {
  const okStatus = (status >= 200 && status < 300 && status !== 204 && status !== 205 && status !== 206) || status >= 400;
  if (!okStatus) return false;
  const [type, ...params] = (headers["content-type"] ?? "").split(";").map((s) => s.trim().toLowerCase());
  if (type !== "text/html") return false;
  //  ASCII 를 품지 않는 문자 집합(UTF-16 · UTF-32)엔 ASCII 바이트를 끼울 수 없다.
  if (params.some((p) => /^charset\s*=\s*"?utf-(16|32)/.test(p))) return false;
  const enc = (headers["content-encoding"] ?? "").trim().toLowerCase();
  return !enc || enc === "identity";
}

// ── CSP → 넣는 모양 ─────────────────────────────────────────────────────────────

const NONCE_RE = /^[A-Za-z0-9+/_=-]{1,200}$/;

/** CSP 머리(정책 여럿은 쉼표) → 스크립트 요소에 걸리는 정책마다 그 출처 목록. 스크립트를 막지 않는 정책은 빠진다. */
function scriptPolicies(csp: string | undefined): string[][] {
  if (!csp) return [];
  const out: string[][] = [];
  for (const pol of csp.split(",")) {
    const dirs = new Map<string, string[]>();
    for (const d of pol.split(";")) {
      const parts = d.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const name = parts[0]!.toLowerCase();
      if (!dirs.has(name)) dirs.set(name, parts.slice(1));   // 같은 지시가 둘이면 앞의 것만 걸린다(CSP3 §2.2)
    }
    const src = dirs.get("script-src-elem") ?? dirs.get("script-src") ?? dirs.get("default-src");
    if (src) out.push(src);
  }
  return out;
}
const noncesOf = (src: string[]): string[] => src.map((t) => /^'nonce-([^']*)'$/i.exec(t)?.[1]).filter((n): n is string => n !== undefined);
/** 그 정책이 nonce 없는 인라인을 받나 — nonce · 해시가 있거나 'strict-dynamic' 이면 'unsafe-inline' 은 무시된다(CSP3). */
function plainInline(src: string[]): boolean {
  const low = src.map((t) => t.toLowerCase());
  if (low.some((t) => /^'(nonce|sha256|sha384|sha512)-/.test(t)) || low.includes("'strict-dynamic'")) return false;
  return low.includes("'unsafe-inline'");
}

export interface ScriptMode { kind: "inline" | "external"; nonce: string | null }
/**
 * 앱의 CSP(frame-ancestors 를 뺀 것)를 보고 넣는 모양을 고른다(순수).
 *  모든 정책이 받는 인라인이 있으면 인라인(필요하면 nonce) — 아니면 같은 주소의 파일. nonce 가 하나로 정해지면 파일에도 단다('strict-dynamic').
 */
export function scriptModeFor(csp: string | undefined): ScriptMode {
  const pols = scriptPolicies(csp);
  if (!pols.length) return { kind: "inline", nonce: null };
  const all = new Set(pols.flatMap(noncesOf));
  //  nonce 가 여럿이면 태그 하나로는 다 못 맞춘다 · 꼴이 이상한 값은 속성을 깨지 않게 쓰지 않는다.
  const nonce = all.size === 1 && NONCE_RE.test([...all][0]!) ? [...all][0]! : null;
  const inline = pols.every((p) => plainInline(p) || (nonce !== null && noncesOf(p).includes(nonce)));
  if (inline) return { kind: "inline", nonce: pols.every(plainInline) ? null : nonce };
  return { kind: "external", nonce };
}

// ── 넣는 글 ─────────────────────────────────────────────────────────────────────

/**
 * JS 를 ASCII 로만(순수) — 0x7F 밖 글자를 \uXXXX 로. 런타임 · 탐침(우리 코드)은 그 글자를 문자열 · 주석 안에만 둔다 —
 *  그 자리의 \u 이스케이프는 같은 글자다(시험이 «백슬래시 바로 뒤의 비ASCII · String.raw 없음» 을 실제 런타임으로 확인한다).
 */
export function asciiJs(js: string): string {
  return js.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
/** HTML 안의 인라인 스크립트가 문서를 깨지 않게 `</script` 를 끊는다(app-front-page.ts 와 같은 규칙). */
const scriptSafe = (js: string): string => js.replace(/<\/script/gi, "<\\/script");

const memo = new Map<string, { ascii: string; v: string }>();
function prepared(js: string): { ascii: string; v: string } {
  let p = memo.get(js);
  if (!p) {
    if (memo.size > 8) memo.clear();   // 판이 바뀔 때만 새 글 — 많이 쌓일 일이 없다
    p = { ascii: scriptSafe(asciiJs(js)), v: createHash("sha256").update(js).digest("hex").slice(0, 16) };
    memo.set(js, p);
  }
  return p;
}
/** 같은 주소 파일의 판 지문 — `?v=` 가 지금 것과 같으면 1년 캐시(app-front-routes.ts). */
export const scriptVersion = (js: string): string => prepared(js).v;

/** 문서에 넣을 태그(ASCII · 순수). probe 는 앱 만들기 탐침(앱 주소 쿼리 `__lively_probe=1` 일 때만 · 정적 화면과 같다). */
export function sdkTags(mode: ScriptMode, s: { runtime: string; probe?: string | null }): string {
  const n = mode.nonce ? ` nonce="${mode.nonce}"` : "";
  const tagOf = (js: string, path: string): string => mode.kind === "inline"
    ? `<script${n}>${prepared(js).ascii}</script>`
    : `<script${n} src="${path}?v=${prepared(js).v}"></script>`;
  return tagOf(s.runtime, SDK_PATH) + (s.probe ? tagOf(s.probe, PROBE_PATH) : "");
}

// ── 넣는 자리 ───────────────────────────────────────────────────────────────────

/** 이만큼 모아도 doctype 이 끝나지 않으면 더 기다리지 않고 맨 앞에 넣는다(공백만 길게 · 끝나지 않는 주석). */
export const HEAD_WAIT_LIMIT = 1024;
const DOCTYPE = "<!doctype";
const BOM = "\xEF\xBB\xBF";

/**
 * 모은 머리(latin1 — 글자 = 바이트) → 넣을 자리(순수). number = 그 바이트 자리 · "wait" = 더 받아 봐야 안다 · "skip" = 넣지 않는다.
 *  final — 흐름이 끝났거나 HEAD_WAIT_LIMIT 를 넘었다(더 기다리지 않는다).
 *  앞의 공백 · 주석 · `<?…>` 는 건너 doctype 을 찾는다(정적 화면은 문서 어디든 첫 doctype 뒤 — 여기선 맨 앞 것만 본다).
 */
export function insertAt(head: string, final: boolean): number | "wait" | "skip" {
  if (head.startsWith("\xFE\xFF") || head.startsWith("\xFF\xFE")) return "skip";   // UTF-16 BOM — ASCII 를 끼울 수 없다
  const start = head.startsWith(BOM) ? BOM.length : 0;
  const giveUp = (): number | "wait" => (final ? start : "wait");
  let i = start;
  for (;;) {
    while (i < head.length && /[\t\n\f\r ]/.test(head[i]!)) i++;
    const tail = head.slice(i, i + DOCTYPE.length);
    if (!tail) return giveUp();
    if (tail.length < 4 && "<!--".startsWith(tail)) return giveUp();   // 주석이 시작되다 말았다
    if (tail.startsWith("<!--")) {
      const e = head.indexOf("-->", i + 4);
      if (e < 0) return giveUp();
      i = e + 3;
      continue;
    }
    if (tail.startsWith("<?")) {
      const e = head.indexOf(">", i + 2);
      if (e < 0) return giveUp();
      i = e + 1;
      continue;
    }
    const low = tail.toLowerCase();
    if (low.length < DOCTYPE.length && DOCTYPE.startsWith(low)) return giveUp();   // `<!doc` 까지만 왔다
    if (low === DOCTYPE) {
      const e = head.indexOf(">", i + DOCTYPE.length);
      return e < 0 ? giveUp() : e + 1;
    }
    return start;   // doctype 이 아닌 무엇(`<html>` · 글) — 맨 앞(BOM 뒤)
  }
}

export interface DocInjector {
  /** 받은 조각 → 지금 내보낼 바이트(자리를 정하기 전엔 빈 것). */
  push(chunk: Buffer): Buffer;
  /** 흐름이 끝났다 — 모아 둔 머리(자리를 아직 못 정했으면 맨 앞에 넣은 것). 두 번째부터는 빈 것. */
  end(): Buffer;
}
const EMPTY = Buffer.alloc(0);

/** 조각 흐름에 tag 를 한 번 끼운다. 자리를 정한 뒤의 조각은 그대로 지나간다. */
export function docInjector(tag: string): DocInjector {
  const t = Buffer.from(tag, "utf8");
  let held: Buffer[] = [];
  let heldLen = 0;
  let decided = false;
  const decide = (ended: boolean): Buffer | null => {
    const head = held.length === 1 ? held[0]! : Buffer.concat(held, heldLen);
    //  자리를 찾는 데는 머리 앞쪽만 본다(첫 조각이 커도 글자로 다 바꾸지 않게).
    const at = insertAt(head.subarray(0, HEAD_WAIT_LIMIT * 8).toString("latin1"), ended || heldLen >= HEAD_WAIT_LIMIT);
    if (at === "wait") return null;
    decided = true; held = []; heldLen = 0;
    return at === "skip" ? head : Buffer.concat([head.subarray(0, at), t, head.subarray(at)]);
  };
  return {
    push(chunk) {
      if (decided) return chunk;
      if (!chunk.length) return EMPTY;
      held.push(chunk); heldLen += chunk.length;
      return decide(false) ?? EMPTY;
    },
    end() {
      if (decided) return EMPTY;
      return decide(true) ?? EMPTY;
    },
  };
}
