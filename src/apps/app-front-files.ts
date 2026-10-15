// 앱 주소에서 여러 파일 앱을 낸다(#4481 앱 v2-2) — 주소 → 판 묶음의 파일 · 응답 머리(종류 · 캐시 · 지문). 순수 조각(app-front-files.test.ts).
//
//  누가 보나: 앱 주소 앞단(CP 라우터)이 `/api/app-front/page?path=<경로+쿼리>` 로 넘긴 것을 app-front-routes 가 받는다. 그 사람이 보는 판(#4667 —
//   초안을 만든 사람은 설치된 판, 나머지는 공개 판)의 묶음에서 매니페스트 web.root 폴더를 주소 맨 앞(/)으로 본다.
//  주소 → 파일 규칙(정적 호스팅이 흔히 따르는 것 — Cloudflare Pages 와 같은 꼴, 특수 규칙을 늘리지 않는다):
//   ① 정확히 그 파일 ② `/` 로 끝나면 그 폴더의 index.html ③ 파일 주소가 아니면(아는 확장자로 안 끝남) `<주소>.html`, 폴더면 `<주소>/` 로
//      보낸다(308 — 상대 경로가 그 폴더 기준으로 풀리게) ④ 없으면: 맨 위 404.html 이 있으면 그것(404), 없으면 파일 주소가 아닌 것은
//      맨 위 index.html(한 페이지 앱 화면 이동 — 200 · `/u/john.doe` 도), 아는 확장자(.js · .png …)면 404(깨진 스크립트 주소가 HTML 을 받아
//      엉뚱한 오류가 나지 않게).
//   `/?page=<키>` 는 라이블리 화면이 화면을 고를 때 쓰는 꼴(v1 과 같은 쿼리) — 그 화면 entry 로 보낸다.
//  캐시: 이름에 내용 지문이 든 파일(빌드 도구의 `index-BxAbCdEf.js` 꼴 · `_next/static/`)은 1년 · 나머지는 매번 지문(ETag)으로 확인.
//   로그인한 사람만 받는 응답이라 늘 private(중간 캐시 금지).
import type { AppBundle, BundleEntry } from "./app-bundle.js";

/** 앞단이 넘긴 경로+쿼리 → 풀린 경로(앞의 `/` 없음 · 조각마다 퍼센트 디코드)와 쿼리. 틀린 꼴이면 null. */
export function parseFrontUrl(raw: unknown): { path: string; trailingSlash: boolean; search: URLSearchParams } | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.length > 2048) return null;
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw, "https://app.invalid"); } catch { return null; }
  const segs: string[] = [];
  for (const enc of u.pathname.split("/").slice(1)) {
    if (enc === "") continue;
    let seg: string;
    try { seg = decodeURIComponent(enc); } catch { return null; }
    if (seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    segs.push(seg);
  }
  return { path: segs.join("/"), trailingSlash: u.pathname.endsWith("/"), search: u.searchParams };
}

/** 판 묶음의 web.root 아래 파일 → (root 기준 경로 → 파일) 표. */
export function indexUnderRoot(bundle: AppBundle, rootRel: string): Map<string, BundleEntry> {
  const pre = rootRel ? rootRel + "/" : "";
  const m = new Map<string, BundleEntry>();
  for (const f of bundle.files) if (!pre || f.p.startsWith(pre)) m.set(f.p.slice(pre.length), f);
  return m;
}

const lastSeg = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const extOf = (p: string): string | null => { const m = /\.([A-Za-z0-9]+)$/.exec(lastSeg(p)); return m ? m[1].toLowerCase() : null; };
/** 내는 종류(TYPES)엔 없지만 파일 주소로 보는 확장자 — 빌드 전 소스 · 설정 꼴(없으면 HTML 대신 404 — 스크립트 주소가 HTML 을 받지 않게). */
const SOURCE_EXTS = new Set(["ts", "tsx", "jsx", "mts", "cts", "vue", "svelte", "scss", "sass", "less", "yml", "yaml", "toml", "lock", "php", "py", "rb", "sh"]);
/**
 * 파일을 가리키는 주소인가 — 아는 파일 확장자(아래 TYPES · SOURCE_EXTS — 스크립트 · 그림 · 폰트 · 소스 …)로 끝나야 그렇게 본다.
 *  `/u/john.doe` · `/v/1.2` 처럼 점이 든 한 페이지 앱 주소는 화면 주소로 본다(맨 위 index.html 로 간다).
 */
const looksLikeFile = (p: string): boolean => { const e = extOf(p); return e !== null && (Object.hasOwn(TYPES, e) || SOURCE_EXTS.has(e)); };

export type FrontResolve =
  | { kind: "file"; rel: string; entry: BundleEntry; status: 200 | 404 }
  | { kind: "redirect"; location: string }
  | { kind: "notfound" };

/**
 * 주소 → 무엇을 낼까(순수). pages = 화면 키 → root 기준 entry 경로(`/?page=` 를 풀 때).
 *  쿼리는 파일을 고르는 데 쓰지 않는다(page · 탐침 표시 말고는 앱의 것이다) — 다시 보낼 때는 그대로 붙인다.
 */
export function resolveFrontPath(index: ReadonlyMap<string, BundleEntry>, url: { path: string; trailingSlash: boolean; search: URLSearchParams },
  pages: ReadonlyMap<string, string> = new Map()): FrontResolve {
  const keep = (drop: string[] = []): string => {
    const q = new URLSearchParams(url.search);
    for (const k of drop) q.delete(k);
    const s = q.toString();
    return s ? "?" + s : "";
  };
  const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
  const page = url.search.get("page");
  if (url.path === "" && page && pages.has(page)) {
    const entry = pages.get(page) as string;
    if (entry !== "index.html") return { kind: "redirect", location: "/" + enc(entry) + keep(["page"]) };
  }
  const file = (rel: string, status: 200 | 404 = 200): FrontResolve | null => { const e = index.get(rel); return e ? { kind: "file", rel, entry: e, status } : null; };
  if (url.path === "" || url.trailingSlash) {
    const hit = file(url.path ? url.path + "/index.html" : "index.html");
    if (hit) return hit;
    //  `/` 인데 맨 위 index.html 이 없으면 첫 화면 entry 로(빌드 산출물 이름이 index.html 이 아닌 앱).
    if (url.path === "" && pages.size) {
      const first = [...pages.values()][0];
      if (index.has(first)) return { kind: "redirect", location: "/" + enc(first) + keep(["page"]) };
    }
  } else {
    const hit = file(url.path);
    if (hit) return hit;
    if (!looksLikeFile(url.path)) {
      const html = file(url.path + ".html");
      if (html) return html;
      if (index.has(url.path + "/index.html")) return { kind: "redirect", location: "/" + enc(url.path) + "/" + keep() };
    }
  }
  const nf = file("404.html", 404);
  if (nf) return nf;
  if (!looksLikeFile(url.path)) { const spa = file("index.html"); if (spa) return spa; }
  return { kind: "notfound" };
}

// ── 응답 머리 ─────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  ogg: "audio/ogg", m4a: "audio/mp4", zip: "application/zip", gz: "application/gzip",
};
/** 확장자 → Content-Type. 모르는 것은 application/octet-stream(nosniff 와 함께 — 브라우저가 내용을 보고 짐작하지 않게). */
export function contentTypeFor(p: string): string {
  const e = extOf(p);
  //  hasOwn — `x.constructor` · `x.toString` 같은 이름이 Object 의 함수를 집어 머리에 들어가지 않게.
  return e !== null && Object.hasOwn(TYPES, e) ? TYPES[e] : "application/octet-stream";
}
export const isHtmlPath = (p: string): boolean => /\.html?$/i.test(lastSeg(p));
/** gzip 으로 줄일 만한 종류(글 · 벡터 · wasm). 이미 압축된 그림·영상·폰트(woff2)는 건드리지 않는다. */
export const compressible = (type: string): boolean => /^(text\/|application\/(json|javascript|xml|manifest\+json|wasm)|image\/svg\+xml)/.test(type);

/**
 * 이름에 내용 지문이 들었나 — 빌드 도구가 지문을 붙여 내는 자리·꼴만 1년 캐시한다(지문이 아닌 이름을 1년 캐시하면 새 판에서 그 파일을
 *  바꿔도 사람들 브라우저가 옛 것을 쓴다 — 놓친 지문은 매번 확인으로 갈 뿐이라 좁게 잡는 쪽이 안전하다).
 *  ① 늘 지문 폴더: `_next/static/`(Next) · `_app/immutable/`(SvelteKit) · `_astro/`(Astro)
 *  ② `assets/` · `static/` 폴더 아래 + 이름 꼴: Vite·Rollup `이름-XXXXXXXX.확장자`(8자 · 영문·숫자·-·_ — 실측 `index-MUbec-0l.js`
 *     `index-XlyKSLnJ.css`) 또는 webpack `이름.16진8자이상[.chunk].확장자`(`main.3f2a1b9c.js`).
 *     8자 조각이 소문자 낱말(`icon-settings`) · 숫자만(`photo-20240101`) · 첫 글자만 대문자인 낱말(`logo-Settings`)이면 지문으로 안 본다.
 *  맨 위 파일(public/ 에서 그대로 복사된 `vite.svg` 같은 것)은 이름이 무엇이든 매번 확인.
 */
export function isHashedAssetName(p: string): boolean {
  if (/(^|\/)(_next\/static|_app\/immutable|_astro)\//.test(p)) return true;
  if (!/(^|\/)(assets|static)\//.test(p)) return false;
  const seg = lastSeg(p);
  const rollup = /^.+-([A-Za-z0-9_-]{8})\.[A-Za-z0-9]+$/.exec(seg);
  if (rollup) {
    const t = rollup[1];
    if (!/^[a-z]+$/.test(t) && !/^[0-9]+$/.test(t) && !/^[A-Z][a-z]+$/.test(t)) return true;
  }
  return /\.[0-9a-f]{8,}(\.chunk)?\.[A-Za-z0-9]+$/.test(seg);
}

export const IMMUTABLE = "private, max-age=31536000, immutable";
export const REVALIDATE = "private, no-cache";
/** 캐시 머리 — HTML 은 늘 다시 확인(새 판의 스크립트 이름을 바로 받게), 지문 이름은 1년, 나머지는 다시 확인. */
export const cacheControlFor = (p: string): string => (!isHtmlPath(p) && isHashedAssetName(p) ? IMMUTABLE : REVALIDATE);

/** If-None-Match 가 이 지문을 담았나(쉼표 목록 · W/ 약한 표시 · * 허용). */
export function etagMatches(header: unknown, etag: string): boolean {
  const h = Array.isArray(header) ? header.join(",") : typeof header === "string" ? header : "";
  if (!h) return false;
  if (h.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return h.split(",").map((x) => x.trim().replace(/^W\//, "")).includes(bare);
}
