// 링크 미리보기(#4769) — 앱 화면이 붙인 링크의 제목 · 설명 · 그림을 서버가 대신 읽어 준다(슬랙의 unfurl).
//
//  앱 화면은 샌드박스(CSP)라 남의 사이트를 못 읽고 남의 그림도 못 싣는다 — 그래서 그림까지 data URL 로 넘긴다.
//  ⚠ SSRF: 풀린 IP 가 사설 · 루프백 · 링크로컬 · 메타데이터 주소면 나가지 않는다(apps/link-preview isForbiddenAddress). 리다이렉트 홉마다 다시 푼다.
//   크기 · 시간 상한(HTML 512KB · 그림 1.5MB · 아이콘 64KB · 6초) — 남의 서버가 우리 메모리를 못 먹게.
//  같은 주소는 10분 기억한다(한 채널에 같은 링크가 여러 번 붙어도 한 번만 나간다). 앱은 받은 것을 제 표에 적어 두는 것이 맞다(여기는 짧은 기억).
import { z } from "zod";
import { lookup } from "node:dns/promises";
import type { LivelyUser } from "../context.js";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { RateWindow } from "../apps/app-chat-send.js";
import {
  LINK_PREVIEW_HTML_MAX, LINK_PREVIEW_ICON_MAX, LINK_PREVIEW_IMAGE_MAX, LINK_PREVIEW_REDIRECTS, LINK_PREVIEW_TIMEOUT_MS,
  isForbiddenAddress, normalizePreviewUrl, parseLinkMeta,
} from "../apps/link-preview.js";

export const LINK_PREVIEW_PER_MINUTE = 60;
const rate = new RateWindow(LINK_PREVIEW_PER_MINUTE);
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const UA = "Mozilla/5.0 (compatible; LivelyLinkPreview/1.0; +https://lvly.io)";

export interface LinkPreviewResult {
  url: string;             // 청한 주소(정규화)
  final_url: string;       // 리다이렉트를 따라간 끝
  kind: "page" | "image";  // 주소 자체가 그림이면 image
  title: string | null;
  description: string | null;
  site_name: string | null;
  image: string | null;    // data URL(없으면 null)
  favicon: string | null;  // data URL(없으면 null)
  ok: boolean;             // false = 못 읽음(사유는 error)
  error?: string;
}

const cache = new Map<string, { at: number; value: LinkPreviewResult }>();
function remember(key: string, value: LinkPreviewResult): LinkPreviewResult {
  if (cache.size >= CACHE_MAX) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first); }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** 호스트를 IP 로 풀어 막힌 자리인지 본다 — 하나라도 막힌 IP 면 나가지 않는다(리졸버가 여럿을 줄 때 한쪽만 사설인 속임수). */
async function assertSafeHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("forbidden-host");
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("unresolved");
  for (const a of addrs) if (isForbiddenAddress(a.address)) throw new Error("forbidden-address");
}

/** 상한까지만 읽는다 — 그 이상은 끊는다(헤더의 content-length 는 믿지 않는다). */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { parts.push(value); total += value.byteLength; if (total >= max) { await reader.cancel().catch(() => {}); break; } }
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).subarray(0, max);
}

/** 리다이렉트를 손으로 따라간다 — 홉마다 주소를 다시 판정한다. */
async function fetchSafe(url: string, accept: string, signal: AbortSignal): Promise<{ res: Response; url: string }> {
  let cur = url;
  for (let hop = 0; hop <= LINK_PREVIEW_REDIRECTS; hop++) {
    const u = new URL(cur);
    await assertSafeHost(u);
    const res = await fetch(cur, { redirect: "manual", signal, headers: { "user-agent": UA, accept, "accept-language": "ko,en;q=0.8" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new Error("redirect-without-location");
      const next = normalizePreviewUrl(new URL(loc, cur).toString());
      if (!next) throw new Error("redirect-bad-url");
      cur = next; continue;
    }
    return { res, url: cur };
  }
  throw new Error("too-many-redirects");
}

async function fetchDataUrl(url: string | null, max: number, signal: AbortSignal): Promise<string | null> {
  if (!url) return null;
  try {
    const { res } = await fetchSafe(url, "image/*", signal);
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)$/.test(type)) { await res.body?.cancel().catch(() => {}); return null; }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > max) { await res.body?.cancel().catch(() => {}); return null; }
    const buf = await readCapped(res, max + 1);
    if (!buf.length || buf.length > max) return null;
    //  svg 는 스크립트를 품을 수 있다 — 앱의 CSP(img-src data:) 안에서 <img> 로만 그려지므로 실행되지 않지만, 아이콘 외엔 받지 않는다.
    if (type === "image/svg+xml" && max > LINK_PREVIEW_ICON_MAX) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

export async function previewLink(rawUrl: unknown, now = Date.now()): Promise<LinkPreviewResult> {
  const url = normalizePreviewUrl(rawUrl);
  if (!url) throw new HttpError(400, "http(s) 주소만 미리 볼 수 있습니다");
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const fail = (error: string): LinkPreviewResult => remember(url, { url, final_url: url, kind: "page", title: null, description: null, site_name: null, image: null, favicon: null, ok: false, error });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LINK_PREVIEW_TIMEOUT_MS);
  try {
    const { res, url: finalUrl } = await fetchSafe(url, "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5", ctl.signal);
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return fail(`http-${res.status}`); }
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type.startsWith("image/")) {
      await res.body?.cancel().catch(() => {});
      const image = await fetchDataUrl(finalUrl, LINK_PREVIEW_IMAGE_MAX, ctl.signal);
      const name = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "") || null;
      return remember(url, { url, final_url: finalUrl, kind: "image", title: name, description: null, site_name: new URL(finalUrl).hostname, image, favicon: null, ok: !!image, ...(image ? {} : { error: "image-too-large" }) });
    }
    if (!/html|xml/.test(type)) { await res.body?.cancel().catch(() => {}); return fail(`not-html:${type || "?"}`); }
    const html = (await readCapped(res, LINK_PREVIEW_HTML_MAX)).toString("utf8");
    const meta = parseLinkMeta(html, finalUrl);
    const [image, favicon] = await Promise.all([
      fetchDataUrl(meta.image, LINK_PREVIEW_IMAGE_MAX, ctl.signal),
      fetchDataUrl(meta.favicon, LINK_PREVIEW_ICON_MAX, ctl.signal),
    ]);
    const site = meta.site_name || new URL(finalUrl).hostname.replace(/^www\./, "");
    return remember(url, { url, final_url: finalUrl, kind: "page", title: meta.title, description: meta.description, site_name: site, image, favicon, ok: !!(meta.title || meta.description || image) });
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? "timeout" : String((e as Error)?.message || e).slice(0, 80);
    return fail(msg);
  } finally { clearTimeout(timer); }
}

const input = { url: z.string().min(1).max(2048).describe("미리 볼 링크(http · https)") };

const linkPreview: Capability = {
  name: "link_preview",
  title: "링크 미리보기",
  description: "링크의 제목 · 설명 · 대표 그림 · 사이트 아이콘을 서버가 대신 읽어 준다(슬랙이 링크를 붙이면 뜨는 카드). 앱 화면은 샌드박스라 남의 사이트를 못 읽어 이 도구를 쓴다 — "
    + "매니페스트 permissions.tools 에 link_preview 를 적는다. 그림 · 아이콘은 data URL 로 온다(앱의 img-src data: 안에서 그려진다). 주소가 그림이면 kind=image. "
    + "사설망 · 로컬 주소로는 나가지 않는다. 못 읽으면 ok:false 와 사유(error)로 답한다(던지지 않는다). 같은 주소는 10분 기억한다 — 앱은 받은 것을 제 표에 적어 두어라.",
  scope: null,
  mutates: false,
  input,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/link-preview"], parse: (req) => ({ url: (req.body as Record<string, unknown> | undefined)?.url }) }] },
  handler: async (args: z.infer<z.ZodObject<typeof input>>, user: LivelyUser) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (!rate.take(`${user.userId}\0${user.appId ?? "-"}`, Date.now())) throw new HttpError(429, `링크 미리보기를 너무 자주 청하고 있습니다(분당 ${LINK_PREVIEW_PER_MINUTE}개)`);
    return previewLink(args.url);
  },
};

export const linkPreviewCapabilities: Capability[] = [linkPreview];
