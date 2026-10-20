// 앱 서버가 만든 화면 문서에 라이블리 SDK 런타임 넣기(#4485 후속, 상민 2026-10-20) — 순수 조각 + 조각 흐름 끼우개 · 압축기. 시험 app-server-page.test.ts.
//
//  왜: 라이블리 화면은 앱 주소로 띄운 문서가 8초 안에 `ui/initialize` 로 인사하지 않으면 종전 화면(srcdoc)으로 바꾼다(web/v2/app-ui.ts).
//   정적 · 여러 파일 앱의 문서에는 게이트웨이가 런타임을 머리에 넣어(app-front-page.ts buildAppPageHtml) 늘 인사하지만, 앱 서버가 만든 문서는
//   그대로 흘려 보내 런타임이 없었다 → 서버 앱이 라이블리 안에서 8초 뒤 정적 화면으로 바뀌었다(2026-10-19 매니지드 실측 · 시험 앱 v26-check).
//  무엇을:
//   · 문서 요청(브라우저가 문서로 여는 것 — Sec-Fetch-Dest document · iframe · frame, 그 머리가 없으면 Accept 의 text/html + navigate)의 HTML 답에만.
//     fetch 로 받는 HTML 조각 · JSON · 파일 · 내려받기(Content-Disposition: attachment) · 압축된 답 · 본문 없는 답(204 · 205 · 304) ·
//     옮기기(3xx) · 부분 답(206) · 앱이 «바꾸지 말라» 고 한 답(Cache-Control: no-transform)은 손대지 않는다.
//   · 자리는 정적 화면과 같다 — doctype 바로 뒤(없으면 맨 앞 · BOM 뒤). 본문이 조각으로 오므로 doctype 이 끝날 때까지만(1KB 안) 모았다 보낸다.
//   · 모양은 같은 주소의 파일(/_lively/sdk.js — 판마다 한 번 받고 1년 캐시 · 문서는 짧다)이 기본이다. 앱의 CSP 가 그 파일을 막고(‘self’ 없음)
//     인라인만 받으면 인라인, nonce 를 쓰면 그 nonce 를 단다. 문서 안 <meta> CSP 는 그보다 뒤의 것에만 걸린다(우리 것은 그 앞에 선다).
//   · 문서 요청은 압축 머리를 빼고 함수로 넘기므로(넣으려면 날 HTML 이 필요하다) 압축은 게이트웨이가 다시 한다(gzip · 조각마다 흘려 보냄).
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { inlineSafe } from "./app-front-page.js";
import { compressible } from "./app-front-files.js";

/** 같은 주소의 런타임 · 탐침 파일(앞단이 `/_lively/*` 를 코어 /api/app-front/lively 로 넘긴다 — 앱 서버로 가지 않는 우리 자리). */
export const SDK_PATH = "/_lively/sdk.js";
export const PROBE_PATH = "/_lively/probe.js";

type HeaderMap = Record<string, string | string[] | undefined>;
const one = (h: HeaderMap, k: string): string => { const v = h[k]; return String((Array.isArray(v) ? v[0] : v) ?? "").trim(); };

const DOC_DESTS = new Set(["document", "iframe", "frame"]);

/** 브라우저가 이 답을 문서로 여나(순수) — 폼 제출 결과 화면(POST)도 문서다. HEAD 는 본문이 없다. */
export function isDocumentRequest(method: string, headers: HeaderMap): boolean {
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
export function documentRequestHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(headers)) if (!DOC_DROP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** 본문을 손댈 수 있는 상태인가 — 본문 없음(204 · 205 · 304) · 옮기기(3xx) · 부분 답(206) · 1xx 는 아니다. */
const bodyStatus = (status: number): boolean => (status >= 200 && status < 300 && status !== 204 && status !== 205 && status !== 206) || status >= 400;
const isAttachment = (headers: Record<string, string>): boolean => /^\s*attachment\b/i.test(headers["content-disposition"] ?? "");
const encoded = (headers: Record<string, string>): boolean => { const e = (headers["content-encoding"] ?? "").trim().toLowerCase(); return !!e && e !== "identity"; };
/** 앱이 «중간에서 바꾸지 말라» 고 했다(Cache-Control: no-transform · RFC 9111 §5.2.2.6) — 넣지도 다시 압축하지도 않는다. */
const noTransform = (headers: Record<string, string>): boolean => /(^|,)\s*no-transform\s*(,|$)/i.test(headers["cache-control"] ?? "");

/** 이 답에 런타임을 넣나(순수) — 머리 이름은 소문자(responseHeadersOf). 문서 요청인지는 부르는 쪽이 본다. */
export function injectableResponse(status: number, headers: Record<string, string>): boolean {
  if (!bodyStatus(status)) return false;
  const [type, ...params] = (headers["content-type"] ?? "").split(";").map((s) => s.trim().toLowerCase());
  if (type !== "text/html") return false;
  //  ASCII 를 품지 않는 문자 집합(UTF-16 · UTF-32)엔 ASCII 바이트를 끼울 수 없다.
  if (params.some((p) => /^charset\s*=\s*"?utf-(16|32)/.test(p))) return false;
  //  내려받기(보고서 · 내보내기 HTML) — 브라우저는 응답을 보기 전에 문서 요청으로 보낸다. 파일은 앱이 보낸 바이트 그대로여야 한다(격리 리뷰).
  if (isAttachment(headers) || noTransform(headers)) return false;
  return !encoded(headers);
}

/** 문서 요청의 이 답을 게이트웨이가 압축하나(순수) — 압축 머리를 빼고 넘겼으니 앱이 압축하지 않았다. 압축이 듣는 종류만 · 이미 압축된 것 · 내려받기는 그대로. */
export function gzipDocResponse(status: number, headers: Record<string, string>, request: HeaderMap): boolean {
  if (!bodyStatus(status) || encoded(headers)) return false;
  if (isAttachment(headers)) return false;   // 내려받기는 앱이 보낸 그대로(길이 머리가 남아 내려받기 진행이 보인다)
  if (noTransform(headers)) return false;
  if (!/\bgzip\b/i.test(one(request, "accept-encoding"))) return false;
  return compressible((headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase());
}

/** Vary 에 낱말을 더한다(대소문자 무시 · 이미 있으면 그대로 · `*` 면 그대로). */
export function addVary(headers: Record<string, string>, token: string): void {
  const cur = (headers.vary ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (cur.includes("*") || cur.some((t) => t.toLowerCase() === token.toLowerCase())) return;
  headers.vary = [...cur, token].join(", ");
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
/** 그 정책이 같은 주소의 파일을 받나 — 'self' · `*` · `https:` (‘strict-dynamic’ 이면 출처 목록은 무시된다 — nonce 로만). */
function selfFile(src: string[]): boolean {
  const low = src.map((t) => t.toLowerCase());
  if (low.includes("'strict-dynamic'")) return false;
  return low.some((t) => t === "'self'" || t === "*" || t === "https:");
}

export interface ScriptMode { kind: "inline" | "external"; nonce: string | null }
/**
 * 앱의 CSP(frame-ancestors 를 뺀 것)를 보고 넣는 모양을 고른다(순수).
 *  같은 주소 파일이 기본 — 모든 정책이 그 파일을 받으면(‘self’ · 같은 nonce · CSP 없음) 파일. 아니고 모든 정책이 인라인을 받으면 인라인(필요하면 nonce).
 *  둘 다 아니면 파일(막히지만 할 수 있는 최선). nonce 가 하나로 정해지면 늘 단다(그 nonce 로만 여는 정책 · 'strict-dynamic').
 */
export function scriptModeFor(csp: string | undefined): ScriptMode {
  const pols = scriptPolicies(csp);
  const all = new Set(pols.flatMap(noncesOf));
  //  nonce 가 여럿이면 태그 하나로는 다 못 맞춘다 · 꼴이 이상한 값은 속성을 깨지 않게 쓰지 않는다.
  const nonce = all.size === 1 && NONCE_RE.test([...all][0]!) ? [...all][0]! : null;
  const byNonce = (p: string[]): boolean => nonce !== null && noncesOf(p).includes(nonce);
  if (pols.every((p) => selfFile(p) || byNonce(p))) return { kind: "external", nonce };
  if (pols.every((p) => plainInline(p) || byNonce(p))) return { kind: "inline", nonce: pols.every(plainInline) ? null : nonce };
  return { kind: "external", nonce };
}

// ── 넣는 글 ─────────────────────────────────────────────────────────────────────

/**
 * JS 를 ASCII 로만(순수) — 0x7F 밖 글자를 \uXXXX 로. 런타임 · 탐침(우리 코드)은 그 글자를 문자열 · 주석 안에만 둔다 —
 *  그 자리의 \u 이스케이프는 같은 글자다(시험이 실제 런타임으로 «백슬래시 바로 뒤의 비ASCII · String.raw 없음 · 바꾼 것이 JS» 를 본다).
 */
export function asciiJs(js: string): string {
  return js.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const memo = new Map<string, { ascii: string; v: string }>();
function prepared(js: string): { ascii: string; v: string } {
  let p = memo.get(js);
  if (!p) {
    if (memo.size > 8) memo.clear();   // 판이 바뀔 때만 새 글 — 많이 쌓일 일이 없다
    p = { ascii: inlineSafe(asciiJs(js)), v: createHash("sha256").update(js).digest("hex").slice(0, 16) };
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
const BOMS = [BOM, "\xFE\xFF", "\xFF\xFE"];

/**
 * 모은 머리(latin1 — 글자 = 바이트) → 넣을 자리(순수). number = 그 바이트 자리 · "wait" = 더 받아 봐야 안다 · "skip" = 넣지 않는다.
 *  final — 흐름이 끝났거나 HEAD_WAIT_LIMIT 를 넘었다(더 기다리지 않는다).
 *  앞의 공백 · 주석 · `<?…>` 는 건너 doctype 을 찾는다(정적 화면은 문서 어디든 첫 doctype 뒤 — 여기선 맨 앞 것만 본다).
 */
export function insertAt(head: string, final: boolean): number | "wait" | "skip" {
  if (!final && head.length < 3 && BOMS.some((b) => b.startsWith(head))) return "wait";   // BOM 이 조각 경계에 걸렸다
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

// ── 다시 압축 ───────────────────────────────────────────────────────────────────

export interface GzipStream {
  /** 조각 → 지금 내보낼 압축 바이트(조각마다 SYNC_FLUSH — 받는 쪽이 그 조각까지 바로 푼다 · 흘려 보내기가 산다). */
  push(chunk: Buffer): Promise<Buffer>;
  /** 끝 — 남은 바이트와 gzip 꼬리. */
  end(): Promise<Buffer>;
  /** 중간에 그만둠(브라우저가 떠남 · 앱 실패) — zlib 자원을 걷는다. */
  destroy(): void;
}
export function gzipStream(): GzipStream {
  const z = zlib.createGzip();
  const out: Buffer[] = [];
  z.on("data", (c: Buffer) => out.push(c));
  z.on("error", () => undefined);
  const take = (): Buffer => { const b = out.length === 1 ? out[0]! : Buffer.concat(out); out.length = 0; return b; };
  return {
    push: (chunk) => new Promise((resolve) => {
      if (!chunk.length) { resolve(EMPTY); return; }
      z.write(chunk);
      z.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve(take()));
    }),
    end: () => new Promise((resolve) => { z.once("end", () => resolve(take())); z.end(); }),
    destroy: () => { z.destroy(); },
  };
}
