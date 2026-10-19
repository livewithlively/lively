// 링크 미리보기(#4769) — 순수 판정 · 파싱. 네트워크는 capabilities/link-preview.ts 가 한다.
//
//  왜 서버가 하나: 앱 화면은 샌드박스(CSP connect-src 가 제 앱 폴더뿐)라 남의 사이트를 못 읽는다. 슬랙이 링크를 붙이면
//  제목 · 설명 · 그림 카드(unfurl)를 그리는 것은 슬랙 서버가 그 주소를 대신 읽기 때문이다. 우리도 같은 자리에 둔다.
//
//  ⚠ 서버가 남이 준 주소로 나가는 것은 SSRF 다 — 사설망 · 루프백 · 링크로컬 · 메타데이터 주소(169.254.169.254)로는 절대 나가지 않는다.
//   주소(호스트 이름)가 아니라 **풀린 IP** 로 판정한다(DNS 가 사설 IP 를 가리킬 수 있다 — DNS 리바인딩). 리다이렉트도 홉마다 다시 판정한다.
import { isIP } from "node:net";

export const LINK_PREVIEW_URL_MAX = 2048;
export const LINK_PREVIEW_HTML_MAX = 512 * 1024;      // 머리(meta)는 앞쪽에 있다 — 그 이상은 읽지 않는다
export const LINK_PREVIEW_IMAGE_MAX = 1536 * 1024;    // 카드 그림 — data URL 로 앱에 준다(앱이 남의 사이트 그림을 못 싣는다)
export const LINK_PREVIEW_ICON_MAX = 64 * 1024;
export const LINK_PREVIEW_REDIRECTS = 3;
export const LINK_PREVIEW_TIMEOUT_MS = 6000;

export interface LinkMeta {
  title: string | null;
  description: string | null;
  image: string | null;       // 절대 주소(아직 안 받은 상태)
  site_name: string | null;
  favicon: string | null;     // 절대 주소
}

/** http · https 만, 2048자 안, 조각(#…)은 뗀다. 아니면 null. */
export function normalizePreviewUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > LINK_PREVIEW_URL_MAX) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;   // 자격이 든 주소는 밖으로 안 보낸다
  u.hash = "";
  return u.toString();
}

/** 이 IP 로는 나가지 않는다 — 사설 · 루프백 · 링크로컬 · 멀티캐스트 · 미지정 · 공유 주소(100.64/10) · IPv4 매핑 IPv6 도 같은 잣대. */
export function isForbiddenAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return forbiddenV4(ip);
  if (kind === 6) {
    const low = ip.toLowerCase();
    const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return forbiddenV4(mapped[1]);
    if (low === "::" || low === "::1") return true;
    if (/^fe[89ab]/.test(low)) return true;        // 링크로컬 fe80::/10
    if (/^f[cd]/.test(low)) return true;           // 고유 로컬 fc00::/7
    if (/^ff/.test(low)) return true;              // 멀티캐스트
    if (/^64:ff9b:/.test(low)) return true;        // NAT64 — 안의 v4 가 사설일 수 있다
    return false;
  }
  return true;   // IP 가 아니면(이름) 판정 불가 → 막는다. 호출자는 먼저 풀어서 넘긴다.
}
function forbiddenV4(ip: string): boolean {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                 // 링크로컬 · 클라우드 메타데이터
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 공유
  if (a >= 224) return true;                               // 멀티캐스트 · 예약 · 브로드캐스트
  return false;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[k] ?? m;
  });
}
const clean = (s: string | null | undefined, max: number): string | null => {
  const t = decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}
function abs(href: string | null | undefined, base: string): string | null {
  const h = String(href ?? "").trim();
  if (!h) return null;
  try { const u = new URL(h, base); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}

/**
 * HTML 머리에서 카드 재료를 읽는다 — og:* > twitter:* > <title> · meta description 차례. 주소는 base 로 절대화한다.
 *  <head> 가 없어도 본문 앞 512KB 안에서 찾는다(파서 없이 정규식 — meta 는 꼴이 단순하다).
 */
export function parseLinkMeta(html: string, base: string): LinkMeta {
  const src = String(html ?? "").slice(0, LINK_PREVIEW_HTML_MAX).replace(/<!--[\s\S]*?-->/g, "");
  const meta: Record<string, string> = {};
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (!key || a.content == null) continue;
    if (!(key in meta)) meta[key] = a.content;   // 같은 키는 첫 것(og 는 첫 그림이 대표)
  }
  let favicon: string | null = null, touch: string | null = null;
  for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel || "").toLowerCase().split(/\s+/);
    if (rel.includes("icon") && !favicon) favicon = abs(a.href, base);
    if (rel.includes("apple-touch-icon") && !touch) touch = abs(a.href, base);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? null;
  const site = clean(meta["og:site_name"], 80);
  const image = abs(meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"], base);
  return {
    title: clean(meta["og:title"] || meta["twitter:title"] || titleTag, 200),
    description: clean(meta["og:description"] || meta["twitter:description"] || meta["description"], 400),
    image,
    site_name: site,
    favicon: favicon || touch || abs("/favicon.ico", base),
  };
}
