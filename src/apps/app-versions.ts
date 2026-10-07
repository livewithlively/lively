// 앱 판(版) — 소스 내려받기 · 워크스페이스 판 덮어쓰기 · 판 이력 · 되돌리기 (#4600, 프로젝트 #4592 「장표 수정 앱」).
//
//  왜 — 원준(2026-10-07): «개개인도 AI 에게 시켜 앱의 디자인·배치·기능을 고칠 수 있어야 한다. 커스텀 되는 앱.»
//   그런데 빌트인 앱은 릴리스로만 바뀌고(member-app.ts 종전 규칙) 화면 코드는 org_app_ui_asset 에 한 벌뿐이라 판 이력도
//   되돌리기도 없었다. 그래서 앱 코드를 **세 겹**으로 본다 — ① 릴리스 원본 → ② 워크스페이스 판(처음 고치는 순간 생긴다) →
//   ③ 내 판(2차). 데이터(표)는 한 벌이고 화면 코드만 겹이 진다.
//
//  ★ 덮어쓴 빌트인의 source 는 **kind 를 'builtin' 으로 유지**하고 `overrides_builtin: true` 를 단다(명세 초안은 kind 'inline' 이었다).
//   데이터 표가 사는 스키마·자유 SQL 역할·떠 두기·제거 금지가 전부 isBuiltinSource(source) 로 갈리기 때문이다
//   (capabilities/app-store.ts:65 · app-snapshot.ts · remove-run.ts). kind 를 바꾸면 고친 순간 표가 다른 스키마로 가서
//   «데이터는 한 벌» 이 깨진다. 빌트인 여부를 묻는 자리는 그대로 두고, «덮어썼나» 는 isOverrideSource 로 따로 묻는다.
//
//  여기는 **순수 판정 + 파일 묶음 재구성** 만 — DB 는 org/store/apps.ts, 설치는 install-run.ts, 노출은 capabilities/apps.ts.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { isBuiltinSource } from "./store-ddl.js";

/** 앱당 보관하는 구성원 판 수. 원본(origin 'builtin') 판은 세지 않고 지우지 않는다 — 「원본으로」 의 목적지라서. */
export const APP_VERSION_KEEP = 20;
/** 워크스페이스 전체 판 묶음(files) 합의 상한 — 넘으면 앱을 가리지 않고 오래된 구성원 판부터 더 지운다(앱당 20 과 별개). 지금 서빙 중인 판은 안 지운다. */
export const APP_VERSION_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

export type AppVersionOrigin = "builtin" | "member";
export interface AppFile { path: string; content: string; encoding?: "utf8" | "base64" }

/** 이 앱이 **빌트인을 워크스페이스가 덮어쓴 것**인가. 빌트인 여부(isBuiltinSource)와는 다른 질문 — 둘 다 true 일 수 있다. */
export function isOverrideSource(source: unknown): boolean {
  return isBuiltinSource(source) && (source as { overrides_builtin?: unknown }).overrides_builtin === true;
}

/**
 * 덮어쓰기 설치의 출처 기록(순수). 스테이지 메타(파일 수·바이트)는 살리되 kind 는 'builtin' 으로 — 위 머리 주석의 이유.
 *  builtin_id 는 어느 빌트인에서 갈라졌나(지금은 늘 자기 id — 나중에 다른 id 로 복제하는 길이 생겨도 뿌리를 안다).
 */
export function overrideSourceMeta(stageMeta: Record<string, unknown>, builtinId: string): Record<string, unknown> {
  const { kind: _kind, ...rest } = stageMeta;
  return { ...rest, kind: "builtin", overrides_builtin: true, builtin_id: builtinId };
}

/**
 * 지울 판(순수) — 구성원 판 가운데 최신 keep 개 밖의 것. 원본 판은 절대 안 지운다.
 *  rows 의 순서는 가리지 않는다(version_no 로 정렬해서 본다).
 */
export function versionsToPrune(rows: ReadonlyArray<{ version_no: number; origin: AppVersionOrigin | string }>, keep: number = APP_VERSION_KEEP): number[] {
  const members = rows.filter((r) => r.origin !== "builtin").map((r) => r.version_no).sort((a, b) => b - a);
  return members.slice(Math.max(0, keep));
}

/**
 * 워크스페이스 총량 상한을 넘겼을 때 지울 판(순수) — 오래된 것부터(rows 는 오래된 순), 지금 서빙 중인 판(is_current)은 건너뛰며,
 *  합이 limit 이하가 될 때까지. 원본 판은 rows 에 넣지 않는다(호출부가 origin 'member' 만 준다).
 */
export function versionsToPruneForQuota(
  rows: ReadonlyArray<{ app_id: string; version_no: number; bytes: number; is_current: boolean }>, total: number, limit: number = APP_VERSION_TOTAL_MAX_BYTES,
): Array<{ app_id: string; version_no: number }> {
  const out: Array<{ app_id: string; version_no: number }> = [];
  let left = total;
  for (const r of rows) {
    if (left <= limit) break;
    if (r.is_current) continue;
    out.push({ app_id: r.app_id, version_no: r.version_no });
    left -= Math.max(0, r.bytes);
  }
  return out;
}

/**
 * 덮어쓴 빌트인이 **새로 선언한** 표(순수) — 릴리스 매니페스트에 없던 이름. 설치 코어가 이 표들에만 워크스페이스 앱과 같은 관문
 *  (이름 사전검증 · 퓨즈)을 지나게 한다. 기존 표(릴리스가 만든 것)는 그대로. 모양이 어긋나도 던지지 않는다.
 */
export function newTablesForOverride(existingManifest: unknown, declared: ReadonlyArray<string>): string[] {
  const t = (existingManifest as { data?: { tables?: Array<{ name?: unknown }> } } | null)?.data?.tables;
  const prev = new Set((Array.isArray(t) ? t : []).map((x) => String(x?.name ?? "")).filter(Boolean));
  return declared.filter((n) => !prev.has(n));
}

/** 매니페스트의 화면 entry 들(페이지·위젯) — DB 에 보존된 UI 자산을 패키지 파일 경로로 되돌릴 때 쓴다. 모양이 어긋나도 던지지 않는다. */
export function entriesOfManifest(manifest: unknown): Array<{ key: string; kind: "page" | "widget"; entry: string }> {
  const ui = (manifest as { ui?: { pages?: Array<{ key?: unknown; entry?: unknown }>; widgets?: Array<{ key?: unknown; entry?: unknown }> } } | null)?.ui;
  const out: Array<{ key: string; kind: "page" | "widget"; entry: string }> = [];
  for (const p of Array.isArray(ui?.pages) ? ui!.pages! : []) if (p?.key && p?.entry) out.push({ key: String(p.key), kind: "page", entry: String(p.entry) });
  for (const w of Array.isArray(ui?.widgets) ? ui!.widgets! : []) if (w?.key && w?.entry) out.push({ key: String(w.key), kind: "widget", entry: String(w.entry) });
  return out;
}

/**
 * DB 에 보존된 것(매니페스트 + UI 자산)으로 패키지 파일 묶음을 재구성한다(순수).
 *  빌트인 폴더가 없는 앱(세션이 app_save 로 만든 앱)은 이것이 곧 전부다 — 설치가 보존하는 것이 이 둘뿐이라서
 *  (bin/·README 같은 그 밖 파일은 inline 묶음에 있었어도 DB 에 남지 않는다. 그래서 판 이력은 files 를 통째로 적어 둔다).
 */
export function filesFromStored(manifest: unknown, ui: ReadonlyArray<{ page_key: string; html: string }>): AppFile[] {
  const files: AppFile[] = [{ path: "lively-app.json", content: JSON.stringify(manifest ?? {}, null, 2) + "\n" }];
  const entries = entriesOfManifest(manifest);
  for (const u of ui) {
    const e = entries.find((x) => x.key === u.page_key);
    if (e) files.push({ path: normalizeRel(e.entry), content: u.html });
  }
  return files;
}

/** base 위에 top 을 덮는다(같은 path 는 top 이 이긴다 · 순서는 base 차례 뒤에 새 path). 순수. */
export function overlayFiles(base: ReadonlyArray<AppFile>, top: ReadonlyArray<AppFile>): AppFile[] {
  const out = base.map((f) => ({ ...f }));
  for (const t of top) {
    const i = out.findIndex((f) => f.path === t.path);
    if (i >= 0) out[i] = { ...t }; else out.push({ ...t });
  }
  return out;
}

function normalizeRel(p: string): string {
  return p.split("/").filter((x) => x && x !== ".").join("/");
}

// ── 패키지 폴더 읽기(빌트인) ─────────────────────────────────────────────────────
//  app_pull 이 «지금 서빙 중인 판의 파일 묶음» 을 돌려줄 때 빌트인은 폴더 전체를 준다 — bin/(세션 스크립트)·README 가
//  거기 있어서다(장표 수정 앱의 deck-push.mjs). DB 에는 매니페스트와 화면만 있다.
export const PACKAGE_FILE_MAX_BYTES = 2 * 1024 * 1024;    // 파일 하나(화면 HTML 상한 loader.ts UI_MAX_BYTES 와 같다)
export const PACKAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;   // 묶음 합(install-source.ts INLINE_MAX_BYTES 와 같다 — 되돌려 넣을 수 있는 크기)
const TEXT_EXT = new Set([".json", ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".md", ".txt", ".svg", ".toml", ".yaml", ".yml", ".csv", ".xml", ".sh"]);

/** 확장자로 글 파일인지(순수). 모르는 확장자는 base64 로 싣는다 — 바이너리를 utf8 로 읽어 깨뜨리지 않게. */
export function isTextPath(p: string): boolean {
  return TEXT_EXT.has(path.posix.extname(p).toLowerCase());
}

/**
 * 패키지 폴더를 재귀로 읽어 파일 묶음으로. 숨김 파일·.git·node_modules 는 뺀다. 경로는 POSIX 상대경로.
 *  상한을 넘으면 400 — 되돌려 넣을 수 없는 묶음을 내려주지 않는다.
 */
export async function readPackageDir(dir: string): Promise<AppFile[]> {
  const root = path.resolve(dir);
  const rels: string[] = [];
  await collect(root, "", rels);
  rels.sort();
  const out: AppFile[] = [];
  let total = 0;
  for (const rel of rels) {
    const abs = path.join(root, rel);
    const st = await stat(abs);
    if (st.size > PACKAGE_FILE_MAX_BYTES) throw new HttpError(400, `앱 패키지 파일이 너무 큽니다(${rel}, ${st.size}B > ${PACKAGE_FILE_MAX_BYTES}B)`);
    total += st.size;
    if (total > PACKAGE_TOTAL_MAX_BYTES) throw new HttpError(400, `앱 패키지가 너무 큽니다(> ${PACKAGE_TOTAL_MAX_BYTES}B)`);
    const buf = await readFile(abs);
    out.push(isTextPath(rel) ? { path: rel, content: buf.toString("utf8") } : { path: rel, content: buf.toString("base64"), encoding: "base64" });
  }
  return out;
}

async function collect(root: string, rel: string, out: string[]): Promise<void> {
  const dir = rel ? path.join(root, rel) : root;
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "node_modules") continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) await collect(root, r, out);
    else if (d.isFile()) out.push(r);
  }
}

/** 폴더가 있고 매니페스트가 있나 — 「원본으로 되돌리기」 와 app_pull 이 폴더를 쓸지 DB 로 갈지 가르는 판정. */
export async function hasPackageDir(dir: string): Promise<boolean> {
  try { return (await stat(path.join(dir, "lively-app.json"))).isFile(); } catch { return false; }
}

/** 판 묶음의 파일을 inline 설치 입력으로(순수) — 저장해 둔 모양 그대로다. */
export function filesToInline(files: ReadonlyArray<AppFile>): Array<{ path: string; content: string; encoding?: "utf8" | "base64" }> {
  return files.map((f) => (f.encoding === "base64" ? { path: f.path, content: f.content, encoding: "base64" as const } : { path: f.path, content: f.content }));
}

/**
 * 시더가 이 앱을 건너뛰어야 하나(순수) — 워크스페이스가 덮어쓴 빌트인은 부팅 시딩이 덮지 않는다.
 *  (덮으면 사람이 고친 판이 릴리스 원본으로 조용히 돌아간다.) 대신 폴더의 릴리스 판 번호만 적어 「원본에 새 판」 을 알린다.
 */
export function seedShouldSkipOverride(existing: { source?: unknown } | null | undefined): boolean {
  return !!existing && isOverrideSource(existing.source);
}

/** 저장할 판의 origin(순수) — 지금 상태가 릴리스 그대로(빌트인 · 덮어쓰기 없음)면 'builtin', 아니면 'member'. */
export function originOfCurrent(source: unknown): AppVersionOrigin {
  return isBuiltinSource(source) && !isOverrideSource(source) ? "builtin" : "member";
}
