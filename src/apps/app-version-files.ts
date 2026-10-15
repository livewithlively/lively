// 판 파일 읽기·쓰기 한 자리(#4481 앱 v2-2) — org_app_version 의 bundle(파일 목록 · 정본)과 files(옛 판 · 옛 코어 호환 사본)를 여기서만 다룬다.
//
//  판 쓰기(recordVersion · refreshOrigin): 파일을 저장소에 먼저 두고(장부 «방금 씀» → 올리기 · app-blob-store) 그 뒤에 판 행을 쓴다 —
//   판 행이 없는 파일을 가리키는 순간이 없게. 상한은 워크스페이스 설정(app_bundle_policy)으로 본다.
//  판 읽기(versionFiles · stageVersion): bundle 이 있으면 저장소에서, 없으면(아직 안 옮긴 옛 판) files 에서.
//  ⓘ 옛 코어 호환 사본은 옛 상한(8MiB · 200개) 안의 판에, 워크스페이스 사본 합이 옛 총량(64MiB) 안일 때만 남긴다 — 30일 뒤 하우스키핑이 비운다.
import * as store from "../org/store/apps.js";
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { audit } from "../org/store/audit.js";
import { HttpError } from "../http-error.js";
import { parseAppSource, stageAppSource, type StagedSource } from "./install-source.js";
import { filesToInline, isTextPath, type AppFile, type AppVersionOrigin } from "./app-versions.js";
import { defaultBlobStoreKind, referencedBytes, sha256Hex, type BlobStoreKind } from "./app-blob-store.js";
import {
  COMPAT_MAX_BYTES, COMPAT_MAX_FILES, COMPAT_TOTAL_MAX_BYTES, bundleBytes, compatFilesFor, materializeBundle, parseBundle, persistBundle, stageBundle,
  type AppBundle, type PreparedBundle,
} from "./app-bundle.js";
import { resolveAppBundlePolicy, type AppBundlePolicy } from "./app-bundle-policy.js";
import { managedMode } from "../org/tenancy/state.js";

/** 이 워크스페이스의 판 묶음 상한 — DB(관리자 app_bundle_limits) → env → 코드 기본값. 칸이 없는 옛 DB 면 기본값. */
export async function appBundlePolicy(): Promise<AppBundlePolicy> {
  const r = await itemsPool.query(`SELECT app_bundle_policy FROM org_runtime_config WHERE id=1`)
    .catch((err) => { logger.warn({ err: String(err) }, "앱 판 묶음 상한을 읽지 못해 기본값을 쓴다(#4481)"); return { rows: [] as Array<Record<string, unknown>> }; });
  const row = r.rows[0]?.app_bundle_policy;
  return resolveAppBundlePolicy(row && typeof row === "object" && Object.keys(row as object).length ? row : null);
}

/** 관리자가 고친 상한을 적는다(빈 객체 = 플랫폼 기본으로 되돌리기). 이 칸만 쓴다 — 런타임 설정의 다른 칸·판 번호(훅이 내려받는 기준)를 흔들지 않는다. */
export async function setAppBundlePolicy(next: Record<string, number>, ctx: { actor?: string; source?: string }): Promise<void> {
  const before = await appBundlePolicyRow();
  await itemsPool.query(`UPDATE org_runtime_config SET app_bundle_policy=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
  await audit("org_runtime_config", "1", "app_bundle_policy", before, next, ctx.actor, ctx.source);
}
export async function appBundlePolicyRow(): Promise<Record<string, unknown>> {
  const r = await itemsPool.query(`SELECT app_bundle_policy FROM org_runtime_config WHERE id=1`).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const row = r.rows[0]?.app_bundle_policy;
  return row && typeof row === "object" ? row as Record<string, unknown> : {};
}

export interface VersionMetaWrite { origin: AppVersionOrigin; version: string; manifest: unknown; content_hash: string | null; note: string | null; saved_by: string | null }

/** 옛 코어 호환 사본 — 판이 옛 상한 안이고 워크스페이스 사본 합이 옛 총량 안이면 그 내용, 아니면 null(사본 없이 간다). */
async function compatCopy(prep: PreparedBundle): Promise<AppFile[] | null> {
  const files = await compatFilesFor(prep);
  if (!files) return null;
  const add = Buffer.byteLength(JSON.stringify(files));
  return (await store.compatBytesTotal()) + add > COMPAT_TOTAL_MAX_BYTES ? null : files;
}

/** 저장소에 둔 묶음 — 판 행을 쓰기 전에(상한·업로드를 먼저 끝내 둔다 · app_save 는 초안 표식을 걸기 전에 이걸 부른다). */
export interface StoredBundle { prep: PreparedBundle; kind: BlobStoreKind }

/**
 * 매니지드인데 S3 설정이 없으면(cp.env 에 버킷을 적기 전 롤) 새 판도 DB 저장소로 간다 — 그 DB 는 워크스페이스가 함께 쓰는 공용 DB 라
 *  옛 상한(8MiB · 200개)을 넘는 판은 받지 않는다(503 — 설정이 들어오면 상한이 원래대로 돌아온다). 자가호스팅 DB 저장소는 상한 그대로.
 */
export function sharedDbStoreDenial(kind: BlobStoreKind, prep: PreparedBundle, env: NodeJS.ProcessEnv = process.env): string | null {
  if (kind !== "db" || !managedMode(env)) return null;
  if (bundleBytes(prep.bundle) <= COMPAT_MAX_BYTES && prep.bundle.files.length <= COMPAT_MAX_FILES) return null;
  return `앱 파일 저장소(S3)가 아직 준비되지 않아 ${COMPAT_MAX_BYTES / 1024 / 1024}MB · ${COMPAT_MAX_FILES}개를 넘는 판은 지금 저장할 수 없습니다 — 운영자에게 알려 주세요(LIVELY_APP_BUNDLE_BUCKET)`;
}

async function persistChecked(kind: BlobStoreKind, prep: PreparedBundle): Promise<void> {
  const why = sharedDbStoreDenial(kind, prep);
  if (why) throw new HttpError(503, why);
  await persistBundle(kind, prep, await appBundlePolicy(), referencedBytes);
}

/** 묶음을 저장소에 둔다(판 상한 · 워크스페이스 상한 판정 포함). 판 행은 아직 안 쓴다 — insertVersion 이 쓴다. */
export async function storeVersionBundle(prep: PreparedBundle, kind: BlobStoreKind = defaultBlobStoreKind()): Promise<StoredBundle> {
  await persistChecked(kind, prep);
  return { prep, kind };
}

/** 저장소에 둔 묶음으로 판 행을 하나 더 적는다. 반환 = 판 번호. 호출부가 설치 락 안에서 부른다(번호 경쟁 없음). */
export async function insertVersion(appId: string, meta: VersionMetaWrite, sb: StoredBundle): Promise<number> {
  const compat = await compatCopy(sb.prep);
  return store.insertAppVersion(appId, { ...meta, files: compat ?? [], bundle: sb.prep.bundle, bundle_store: sb.kind, bundle_bytes: bundleBytes(sb.prep.bundle) });
}

/** 판을 하나 더 적는다 — 파일을 저장소에 둔 뒤 판 행(둘을 한 번에). 반환 = 판 번호. */
export async function recordVersion(appId: string, meta: VersionMetaWrite, prep: PreparedBundle, kind: BlobStoreKind = defaultBlobStoreKind()): Promise<number> {
  return insertVersion(appId, meta, await storeVersionBundle(prep, kind));
}

/** 「원본 · 릴리스」 판을 지금 깐 릴리스로 고친다(번호 그대로 — store.refreshOriginVersion 머리말). */
export async function refreshOrigin(appId: string, versionNo: number, meta: Omit<VersionMetaWrite, "origin" | "saved_by">, prep: PreparedBundle): Promise<boolean> {
  const kind = defaultBlobStoreKind();
  await persistChecked(kind, prep);
  const compat = await compatCopy(prep);
  return store.refreshOriginVersion(appId, versionNo, { ...meta, files: compat ?? [], bundle: prep.bundle, bundle_store: kind, bundle_bytes: bundleBytes(prep.bundle) });
}

/** 판 행의 파일 목록과 저장소 — 옛 판이면 null. */
export function versionBundle(row: { bundle?: unknown; bundle_store?: string | null }): { kind: BlobStoreKind; bundle: AppBundle } | null {
  if (row.bundle == null) return null;
  const b = parseBundle(row.bundle);
  if (!b) { logger.error({ store: row.bundle_store }, "판 행의 파일 목록 모양이 틀렸다(#4481)"); throw new HttpError(500, "판의 파일 목록을 읽지 못했습니다"); }
  return { kind: row.bundle_store === "db" ? "db" : "s3", bundle: b };
}

const norm = (p: string): string => p.split("/").filter((x) => x && x !== ".").join("/");

/** 판의 파일(AppFile[]). paths 를 주면 그 경로만(공개 판 화면은 entry HTML 만 읽는다). */
export async function versionFiles(row: { bundle?: unknown; bundle_store?: string | null; files: ReadonlyArray<AppFile> }, paths?: ReadonlyArray<string>): Promise<AppFile[]> {
  const vb = versionBundle(row);
  if (vb) return materializeBundle(vb.kind, vb.bundle, paths);
  const want = paths ? new Set(paths.map(norm)) : null;
  return (row.files as AppFile[]).filter((f) => !want || want.has(norm(f.path)));
}

/** 판을 설치 스테이지로 푼다(되돌리기) — 판 묶음은 옛 inline 상한을 지나지 않는다. 옛 판은 종전 inline 길. cleanup 을 반드시 부를 것. */
export async function stageVersion(row: { bundle?: unknown; bundle_store?: string | null; files: ReadonlyArray<AppFile> }): Promise<StagedSource> {
  const vb = versionBundle(row);
  if (!vb) return stageAppSource(parseAppSource({ kind: "inline", files: filesToInline(row.files as AppFile[]) }));
  const st = await stageBundle(vb.kind, vb.bundle);
  return { dir: st.dir, meta: { kind: "inline", files: vb.bundle.files.length, bytes: bundleBytes(vb.bundle) }, cleanup: st.cleanup };
}

// ── 내려받기(app_pull) ─────────────────────────────────────────────────────────

/** 내려받기 응답에 내용을 다 싣는 판의 상한 — 그대로 다시 올릴 수 있는 크기(REST 저장 본문 4MB 안 · base64 여유). 넘으면 지문으로. */
export const PULL_INLINE_MAX_BYTES = 2 * 1024 * 1024;
/** 큰 판에서도 내용을 싣는 글 파일 하나의 상한 — 매니페스트 · 화면 HTML 처럼 고쳐 올릴 것. */
export const PULL_TEXT_FILE_MAX_BYTES = 256 * 1024;
/** 큰 판에서 내용을 싣는 글 파일들의 합 상한 — 파일이 수천 개면 하나하나 작아도 응답이 커진다(도구 응답 · 대화 맥락). */
export const PULL_TEXT_TOTAL_MAX_BYTES = 1024 * 1024;

/**
 * 큰 판에서 내용을 실을 글 파일 고르기(순수) — 매니페스트 → HTML → 작은 것 순으로 합 상한까지. 반환 = 고른 경로.
 *  매니페스트가 맨 앞인 까닭: 고쳐 저장할 때 가장 먼저 손대는 파일이다(나머지는 지문 줄 그대로 되보내면 된다).
 */
export function pickPullInline(files: ReadonlyArray<{ p: string; s: number }>, perFile = PULL_TEXT_FILE_MAX_BYTES, total = PULL_TEXT_TOTAL_MAX_BYTES): string[] {
  const rank = (p: string): number => (p === "lively-app.json" ? 0 : /\.html?$/i.test(p) ? 1 : 2);
  const cands = files.filter((f) => isTextPath(f.p) && f.s <= perFile)
    .sort((a, b) => rank(a.p) - rank(b.p) || a.s - b.s || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const out: string[] = [];
  let sum = 0;
  for (const f of cands) {
    if (sum + f.s > total) continue;
    sum += f.s;
    out.push(f.p);
  }
  return out;
}

export interface PulledFile { path: string; size: number; sha256: string; content?: string; encoding?: "utf8" | "base64" }

/**
 * 판의 파일 묶음을 내려받기 꼴로 — 작은 판은 내용까지(종전과 같은 모양 + sha256 · size), 큰 판은 작은 글 파일만 내용(합 1MB 까지 ·
 *  pickPullInline), 나머지는 지문만.
 *  지문만 받은 줄은 그대로 app_save files 에 다시 넣으면 된다(content 없이 sha256 — 이 워크스페이스 저장소에서 꺼낸다).
 */
export async function pullFiles(row: { bundle?: unknown; bundle_store?: string | null; files: ReadonlyArray<AppFile> }): Promise<{ files: PulledFile[]; refs: number }> {
  const vb = versionBundle(row);
  if (!vb) {
    return { files: (row.files as AppFile[]).map((f) => { const b = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8"); return { ...f, size: b.length, sha256: sha256Hex(b) }; }), refs: 0 };
  }
  const small = bundleBytes(vb.bundle) <= PULL_INLINE_MAX_BYTES;
  const want = small ? vb.bundle.files.map((f) => f.p) : pickPullInline(vb.bundle.files);
  const got = new Map((await materializeBundle(vb.kind, vb.bundle, want)).map((f) => [f.path, f]));
  let refs = 0;
  const files = vb.bundle.files.map((f): PulledFile => {
    const c = got.get(f.p);
    if (!c) { refs++; return { path: f.p, size: f.s, sha256: f.h }; }
    return c.encoding === "base64" ? { path: f.p, size: f.s, sha256: f.h, content: c.content, encoding: "base64" } : { path: f.p, size: f.s, sha256: f.h, content: c.content };
  });
  return { files, refs };
}
