// Notion 첨부(자산) 다운로드(#1313 R22 분할 — 구 notion.ts 219-318).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { notionFetch, paginate, PAGE_SIZE, sleep } from "./client.js";
import type { Rec } from "./client.js";
import type { Traversal } from "./state.js";

// ── 자산(asset) 다운로드 ──────────────────────────────────────────────────────
//  ⚠ 화면·로그에 내보내는 말은 **'첨부 파일'** 이다(#859) — '자산'은 관리탭에서 스킬·서브에이전트·커맨드를
//  가리키는 다른 뜻으로 이미 쓰였다. 여기 식별자(assetDir·assetJobs·stats.assets)는 그대로 둔다.
//  노션 파일 URL 은 발급 후 1시간 만료 — 대형 워크스페이스는 수집만 2시간+라 다운로드 시점(맨 끝)엔 초반
//  URL 이 전부 죽는다(고객사 A 실배포: 자산 403 48건 → 커서 동결 → 125분 full 무한 반복). 소유 블록/페이지를
//  재조회하면 같은 S3 경로에 새 서명이 발급되므로(경로는 파일 버전당 안정), 만료·403 시 재조회로 치유한다.
export interface AssetJob { url: string; file: string; blockId?: string; pageId?: string; kind?: string; expiry?: string }

export function assetFileName(hint: { blockId?: string; pageId?: string; kind: string; name?: string }, url: string): string {
  let base = "";
  try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { /* 무시 */ }
  const name = (hint.name || base || "asset").slice(-80);
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  let urlPath = "";
  try { urlPath = new URL(url).pathname; } catch { /* 무시 */ }
  // URL 경로를 키에 포함 — 같은 페이지에서 동명 파일 2개(files 속성·댓글 첨부 등)가 서로를 덮어쓰는 충돌 방지.
  //  S3 키 경로는 파일 버전당 안정(서명 쿼리만 변동)이라 재싱크에도 파일명이 결정적.
  const key = crypto.createHash("sha1")
    .update(`${hint.pageId ?? ""}|${hint.blockId ?? ""}|${hint.kind}|${name}|${urlPath}`)
    .digest("hex").slice(0, 24);
  return ext ? `${key}.${ext}` : key;
}

/** JSON 을 깊이 걷어 원본과 같은 S3 경로(pathname)를 가진 새 presigned URL 을 찾는다. */
export function findUrlByPath(node: unknown, targetPath: string): string | null {
  if (typeof node === "string") {
    if (node.startsWith("http")) {
      try { if (new URL(node).pathname === targetPath) return node; } catch { /* URL 아님 */ }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const v of node) { const r = findUrlByPath(v, targetPath); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Rec)) { const r = findUrlByPath(v, targetPath); if (r) return r; }
  }
  return null;
}

/** 만료된 자산 URL 재발급 — 소유 블록 → 페이지 → (댓글 첨부) 순으로 재조회해 같은 경로의 새 서명을 찾는다. */
export async function refreshAssetUrl(t: Traversal, job: AssetJob): Promise<string | null> {
  let targetPath = "";
  try { targetPath = new URL(job.url).pathname; } catch { return null; }
  const sources: Array<() => Promise<unknown>> = [];
  if (job.blockId) sources.push(() => notionFetch(t.cfg, `/blocks/${job.blockId}`));
  if (job.pageId) sources.push(() => notionFetch(t.cfg, `/pages/${job.pageId}`));
  if (job.kind === "comment_attachment" && job.pageId) {
    sources.push(async () => {
      const out: unknown[] = [];
      for await (const cr of paginate(t.cfg, (cursor) => ({
        path: `/comments?block_id=${encodeURIComponent(job.pageId!)}&page_size=${PAGE_SIZE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      }))) out.push(cr);
      return out;
    });
  }
  for (const src of sources) {
    try {
      const fresh = findUrlByPath(await src(), targetPath);
      if (fresh) return fresh;
    } catch { /* 다음 소스 */ }
  }
  return null;
}

export async function downloadAsset(t: Traversal, job: AssetJob, dir: string): Promise<void> {
  const dest = path.join(dir, job.file);
  let url = job.url;
  // 선제 재발급 — 만료시각(expiry_time)이 지났으면 죽은 요청을 시도조차 하지 않는다(대형 워크스페이스 기본 경로).
  if (job.expiry && Date.parse(job.expiry) < Date.now() + 30_000) {
    url = (await refreshAssetUrl(t, job)) ?? url;
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 자산은 파일 크기가 커 API 보다 넉넉한 타임아웃(5분) — 무한 대기(행)만 차단.
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) {
        // 403/400 = 서명 만료(수집~다운로드 사이 1h 초과) — 소유 객체 재조회로 새 URL 발급 후 재시도.
        if ((res.status === 403 || res.status === 400) && !refreshed) {
          refreshed = true;
          const fresh = await refreshAssetUrl(t, job);
          if (fresh) { url = fresh; throw new Error(`HTTP ${res.status} — 재발급 후 재시도`); }
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("빈 응답");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = dest + ".part";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest); // 원자적 교체 — 서빙 중 반쪽 파일 방지
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
}
