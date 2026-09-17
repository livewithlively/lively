// Notion 첨부(자산) 다운로드(#1313 R22 분할 — 구 notion.ts 219-318).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { notionFetch, paginate, PAGE_SIZE, sleep } from "./client.js";
import type { Rec } from "./client.js";
import type { NotionRunStats, Traversal } from "./state.js";

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

// 한 번 받기의 한도 — 한 바이트도 안 오는 시간(유휴)으로 끊는다. 큰 영상은 몇 분씩 걸리니 전체 시간으로 자르지 않고
//  폭주 방지 상한만 둔다. (종전: 전체 5분 고정 — 느린 대용량은 매번 잘리고, 멈춘 연결은 5분×3회를 무출력으로 기다렸다)
const ASSET_IDLE_MS = 60_000;
const ASSET_ATTEMPT_CAP_MS = 60 * 60_000;

/**
 * 한 번 받기 — 본문을 **디스크로 흘려** 쓴다. 성공하면 최종 이름으로 원자적 교체, 실패하면 조각을 지운다.
 *  ★ 본문을 메모리에 통째로 올리지 않는다(#4059 사고): 노션 첨부에는 1GB 넘는 영상이 있고, 매니지드는 수집 자식이
 *   게이트웨이와 같은 cgroup(MemoryMax 2GiB)에서 돈다. 2026-09-17 20:06 KST 1.6GB .mov 뒤의 다운로드가 그 한도를 넘겨
 *   OOM 이 났고, systemd(OOMPolicy=stop)가 중앙 게이트웨이를 통째로 재시작했다.
 *  받은 바이트는 `stats.assetBytes` 에 센다 — 요청 없이 파일만 받는 구간도 «움직이고 있다» 를 알려야 추적기의
 *  무출력 정체 킬(15분)에 멀쩡한 run 이 끊기지 않는다(state.ts progressTick).
 * @returns 응답 상태 — 2xx 가 아니면 본문을 버리고 상태만 돌려준다(재발급 판단은 호출부).
 */
async function saveBody(url: string, dest: string, idleMs: number, stats: Pick<NotionRunStats, "assetBytes">): Promise<number> {
  const ac = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new Error(`첨부 수신이 ${idleMs / 1000}초 동안 멈춤`)), idleMs);
  };
  const cap = setTimeout(() => ac.abort(new Error("첨부 한 번 받기 상한(60분) 초과")), ASSET_ATTEMPT_CAP_MS);
  const tmp = `${dest}.${process.pid}.part`; // 같은 파일을 두 수집기가 동시에 받아도 조각이 섞이지 않게
  try {
    arm(); // 연결·헤더 대기도 유휴로 친다
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return res.status; }
    if (!res.body) throw new Error("빈 응답");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let got = 0;
    const count = new Transform({
      transform(chunk: Uint8Array, _enc, cb) { arm(); got += chunk.length; stats.assetBytes += chunk.length; cb(null, chunk); },
    });
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), count, fs.createWriteStream(tmp), { signal: ac.signal });
    if (!got) throw new Error("빈 응답");
    fs.renameSync(tmp, dest); // 원자적 교체 — 서빙 중 반쪽 파일 방지 · 실패한 재다운로드는 기존 파일을 건드리지 않는다
    return res.status;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 정리 실패가 원래 사유를 가리지 않게 */ }
    // 본문 도중의 중단은 pipeline 이 일반 AbortError 로 감싼다 — 로그에 «왜» 가 남도록 우리가 건 사유를 그대로 던진다.
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
  } finally {
    clearTimeout(idle);
    clearTimeout(cap);
  }
}

export async function downloadAsset(t: Traversal, job: AssetJob, dir: string, opts: { idleMs?: number } = {}): Promise<void> {
  const dest = path.join(dir, job.file);
  let url = job.url;
  // 선제 재발급 — 만료시각(expiry_time)이 지났으면 죽은 요청을 시도조차 하지 않는다(대형 워크스페이스 기본 경로).
  if (job.expiry && Date.parse(job.expiry) < Date.now() + 30_000) {
    url = (await refreshAssetUrl(t, job)) ?? url;
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const status = await saveBody(url, dest, opts.idleMs ?? ASSET_IDLE_MS, t.stats);
      if (status >= 200 && status < 300) return;
      // 403/400 = 서명 만료(수집~다운로드 사이 1h 초과) — 소유 객체 재조회로 새 URL 발급 후 재시도.
      if ((status === 403 || status === 400) && !refreshed) {
        refreshed = true;
        const fresh = await refreshAssetUrl(t, job);
        if (fresh) { url = fresh; throw new Error(`HTTP ${status} — 재발급 후 재시도`); }
      }
      throw new Error(`HTTP ${status}`);
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
}
