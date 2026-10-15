// 앱 판 묶음(#4481 앱 v2-2) — 판 하나의 «파일 목록»(경로 · 지문 · 크기)과 그 목록을 만들고·풀고·저장하는 일.
//
//  판 메타 정본은 org_app_version 이고(설계 §3-F), 거기 bundle 칸에 이 목록이 들어간다: {v:1, files:[{p, h, s}]}.
//   파일 내용은 app-blob-store(S3 · 자가호스팅은 DB)에 지문 이름으로 한 벌씩. 옛 판(#4600)은 files JSONB 에 내용을 통째로 담았다 —
//   여러 파일 · dist/ · 서버 zip(250MB)은 DB 에 못 담는다. 옛 판은 하우스키핑이 이 꼴로 옮긴다(app-bundle-migrate.ts).
//  ★ 옛 코어 호환 사본(compat): 이 판을 만든 뒤 옛 코어로 급히 되돌려도 되돌리기 · 공개 판 화면이 돌게, 옛 상한(묶음 8MiB · 200개) 안의
//   판은 files JSONB 에도 한 벌 남긴다. 한 달 뒤(bundle_at + 30일) 하우스키핑이 지운다(상민 2026-10-15 «한 달 뒤 지움»).
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { isTextPath, type AppFile } from "./app-versions.js";
import { getBlob, sha256Hex, storeBlobs, type BlobStoreKind, type BlobToStore, type StoreBlobsResult } from "./app-blob-store.js";
import { bundleLimitDenial, workspaceLimitDenial, type AppBundlePolicy } from "./app-bundle-policy.js";

export interface BundleEntry { p: string; h: string; s: number }
export interface AppBundle { v: 1; files: BundleEntry[] }

/** 옛 코어 호환 사본을 남기는 상한 — 옛 inline 설치 상한(install-source INLINE_MAX_*)과 같아야 옛 코어가 되돌릴 수 있다. */
export const COMPAT_MAX_BYTES = 8 * 1024 * 1024;
export const COMPAT_MAX_FILES = 200;
/** 워크스페이스 전체 호환 사본 합 상한 — 옛 판 총량 상한(#4600 7d, 64MiB)과 같다. 넘으면 그 판은 사본 없이 간다. */
export const COMPAT_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const COMPAT_KEEP_DAYS = 30;

/** 묶음 경로 정규화(순수) — 상대경로 · `/` 구분 · `.`·빈 조각 제거. `..` · 절대 · 역슬래시 · NUL 은 null. */
export function normalizeBundlePath(raw: unknown): string | null {
  const s = String(raw ?? "");
  if (!s || s.includes("\\") || s.includes("\0") || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length || parts.some((x) => x === "..")) return null;
  return parts.join("/");
}

/** DB 의 bundle 칸 → 목록(모양이 틀리면 null — 호출부가 옛 files 로 간다). */
export function parseBundle(raw: unknown): AppBundle | null {
  const b = raw as { v?: unknown; files?: unknown } | null;
  if (!b || b.v !== 1 || !Array.isArray(b.files)) return null;
  const files: BundleEntry[] = [];
  for (const f of b.files as Array<Record<string, unknown>>) {
    const p = normalizeBundlePath(f?.p);
    const h = String(f?.h ?? "");
    const s = Number(f?.s);
    if (!p || !/^[0-9a-f]{64}$/.test(h) || !Number.isFinite(s) || s < 0) return null;
    files.push({ p, h, s });
  }
  return { v: 1, files };
}

export const bundleBytes = (b: AppBundle): number => b.files.reduce((n, f) => n + f.s, 0);

/** 만들어 둔 묶음 — 목록 + 파일마다 내용을 읽는 길(올릴 때만 읽는다). */
export interface PreparedBundle { bundle: AppBundle; readers: Map<string, () => Promise<Buffer>> }

/** 파일 묶음(AppFile — 내용을 손에 쥔 것)에서. 같은 경로가 두 번이면 400. */
export function bundleFromFiles(files: ReadonlyArray<AppFile>): PreparedBundle {
  const seen = new Set<string>();
  const entries: BundleEntry[] = [];
  const readers = new Map<string, () => Promise<Buffer>>();
  for (const f of files) {
    const p = normalizeBundlePath(f.path);
    if (!p) throw new HttpError(400, `판 파일 경로가 틀렸습니다: ${String(f.path).slice(0, 200)}`);
    if (seen.has(p)) throw new HttpError(400, `판 파일 경로가 중복입니다: ${p}`);
    seen.add(p);
    const bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
    const h = sha256Hex(bytes);
    entries.push({ p, h, s: bytes.length });
    readers.set(h, async () => bytes);
  }
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { bundle: { v: 1, files: entries }, readers };
}

/**
 * 폴더(설치 스테이지)에서 — 일반 파일만, 심링크·특수 파일은 400(package-hash 와 같은 규칙). 숨김 파일도 담는다(스테이지는 우리가 쓴 것).
 *  내용은 지문을 셀 때 한 번 읽고 버린다 — 올릴 때 다시 읽는다(큰 판을 메모리에 붙들지 않게).
 */
export async function bundleFromDir(dir: string): Promise<PreparedBundle> {
  const root = path.resolve(dir);
  const rels: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(rel ? path.join(root, rel) : root, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = await lstat(path.join(root, r));
      if (st.isSymbolicLink()) throw new HttpError(400, `판 묶음에 심링크가 있습니다(허용 안 됨): ${r}`);
      if (st.isDirectory()) await walk(r);
      else if (st.isFile()) rels.push(r);
      else throw new HttpError(400, `판 묶음에 일반 파일이 아닌 항목이 있습니다: ${r}`);
    }
  };
  await walk("");
  rels.sort();
  const entries: BundleEntry[] = [];
  const readers = new Map<string, () => Promise<Buffer>>();
  for (const r of rels) {
    const abs = path.join(root, r);
    const bytes = await readFile(abs);
    const h = sha256Hex(bytes);
    entries.push({ p: r, h, s: bytes.length });
    if (!readers.has(h)) readers.set(h, () => readFile(abs));
  }
  return { bundle: { v: 1, files: entries }, readers };
}

/**
 * 묶음을 저장소에 둔다 — 판 상한(판 하나 · 파일 하나 · 파일 수)을 먼저, 새로 올릴 바이트로 워크스페이스 상한을 본다.
 *  used — 워크스페이스가 지금 쓰는 양(blobBytesUsed). 판 행은 이것이 끝난 **뒤에** 쓴다(가리키는 파일이 먼저 있어야 한다).
 */
export async function persistBundle(kind: BlobStoreKind, prep: PreparedBundle, policy: AppBundlePolicy, used: () => Promise<number>): Promise<StoreBlobsResult> {
  const deny = bundleLimitDenial(policy, prep.bundle.files.map((f) => ({ path: f.p, size: f.s })));
  if (deny) throw new HttpError(413, deny);
  const items: BlobToStore[] = [];
  const seen = new Set<string>();
  for (const f of prep.bundle.files) {
    if (seen.has(f.h)) continue;
    seen.add(f.h);
    const read = prep.readers.get(f.h);
    if (!read) throw new HttpError(500, `판 파일 내용을 읽을 길이 없습니다: ${f.p}`);
    items.push({ h: f.h, size: f.s, read });
  }
  return storeBlobs(kind, items, {
    beforeUpload: async (newBytes) => {
      if (newBytes <= 0) return;
      const why = workspaceLimitDenial(policy, await used(), newBytes);
      if (why) throw new HttpError(413, why);
    },
  });
}

/** 옛 코어 호환 사본(AppFile[]) — 옛 상한 안이면 내용을 담아, 넘으면 null(사본 없이 간다). */
export async function compatFilesFor(prep: PreparedBundle): Promise<AppFile[] | null> {
  const files = prep.bundle.files;
  if (files.length > COMPAT_MAX_FILES || bundleBytes(prep.bundle) > COMPAT_MAX_BYTES) return null;
  const out: AppFile[] = [];
  for (const f of files) {
    const read = prep.readers.get(f.h);
    if (!read) return null;
    out.push(toAppFile(f.p, await read()));
  }
  return out;
}

/** 바이트 → AppFile(글 파일은 utf8, 나머지는 base64 — app-versions readPackageDir 와 같은 규칙). */
export function toAppFile(p: string, bytes: Buffer): AppFile {
  return isTextPath(p) ? { path: p, content: bytes.toString("utf8") } : { path: p, content: bytes.toString("base64"), encoding: "base64" };
}

/** 저장소에서 판 파일을 읽을 때 동시에 읽는 수 — 판 하나가 5,000개일 수 있어 하나씩이면 S3 왕복이 쌓이고, 한꺼번이면 연결·메모리가 튄다. */
export const BUNDLE_READ_CONCURRENCY = 8;

/**
 * items 를 동시 n 개까지 — 하나가 실패하면 새로 꺼내지 않고, 돌던 것이 다 끝난 뒤 첫 실패를 던진다
 *  (스테이지 정리(rm)가 아직 쓰는 중인 파일과 엇갈리지 않게).
 */
async function eachLimit<T>(items: ReadonlyArray<T>, n: number, fn: (it: T, i: number) => Promise<void>): Promise<void> {
  const st: { next: number; failed: { e: unknown } | null } = { next: 0, failed: null };
  const worker = async (): Promise<void> => {
    while (!st.failed && st.next < items.length) {
      const i = st.next++;
      try { await fn(items[i] as T, i); } catch (e) { st.failed ??= { e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (st.failed) throw st.failed.e;
}

/** 저장소에서 판 파일을 읽어 AppFile 로(되돌리기 · 내려받기 · 공개 판 화면). paths 를 주면 그것만. 없는 파일은 503(저장소가 상했다). 순서는 묶음 순서. */
export async function materializeBundle(kind: BlobStoreKind, b: AppBundle, paths?: ReadonlyArray<string>): Promise<AppFile[]> {
  const want = paths ? new Set(paths.map((p) => normalizeBundlePath(p)).filter((p): p is string => !!p)) : null;
  const pick = want ? b.files.filter((f) => want.has(f.p)) : b.files;
  const out: AppFile[] = new Array<AppFile>(pick.length);
  await eachLimit(pick, BUNDLE_READ_CONCURRENCY, async (f, i) => {
    const bytes = await getBlob(kind, f.h);
    if (!bytes) throw new HttpError(503, `판 파일을 저장소에서 찾지 못했습니다: ${f.p}`);
    out[i] = toAppFile(f.p, bytes);
  });
  return out;
}

/** 판 묶음을 임시 폴더에 푼다(설치 스테이지 — 되돌리기는 옛 inline 상한 8MiB 를 지나지 않고 여기서 깐다). cleanup 을 반드시 부를 것. */
export async function stageBundle(kind: BlobStoreKind, b: AppBundle): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lively-app-bundle-"));
  const cleanup = async (): Promise<void> => { await rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ }); };
  try {
    const plan = b.files.map((f) => {
      const abs = path.resolve(tmp, f.p);
      if (!abs.startsWith(tmp + path.sep)) throw new HttpError(400, `판 파일 경로가 묶음 밖을 가리킵니다: ${f.p}`);
      return { f, abs };
    });
    await eachLimit(plan, BUNDLE_READ_CONCURRENCY, async ({ f, abs }) => {
      const bytes = await getBlob(kind, f.h);
      if (!bytes) throw new HttpError(503, `판 파일을 저장소에서 찾지 못했습니다: ${f.p}`);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes, { flag: "wx" });
    });
  } catch (e) { await cleanup(); throw e; }
  return { dir: tmp, cleanup };
}
