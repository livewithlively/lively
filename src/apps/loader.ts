// 앱 패키지 로더 — 스테이지 디렉터리 → {manifest, content_hash, DeployItem[]} (#1780, design D2/D4).
//  builtin(코드 내장 디렉터리)·git clone·tar 업로드 모두 **추출 후 같은 스테이지 디렉터리**로 수렴하므로 로더는 하나다.
//  로더는 매니페스트 선언(planDeclaredComponents) + 플러그인 트리 FS 스캔(harness_asset)을 결합해 전개 계획을 완성한다.
//
// payload 계약(deploy 실행기가 kind 별로 해석):
//  - harness_asset: { kind:'skill'|'subagent'|'command', harness:'claude', body, label }  ← 실전개(스토어 upsert)
//  - cron:          { schedule, run }                                                       ← 실전개
//  - mcp_server:    <매니페스트 tools.mcp_servers[] 항목>                                    ← 실전개
//  - tool:          <매니페스트 tools.http_tools[] 항목>                                     ← 실전개
//  - host:          null                                                                     ← 실전개(url_allowlist 병합)
//  - ui_page/ui_widget/section/data_table: null                                              ← 저널만(surfaces 는 manifest 에서 읽음, DDL 은 부팅자식)
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { parseAppManifest, assertInstallableManifest, appAssetId, type LivelyAppManifest } from "./manifest.js";
import { planDeclaredComponents, type AppComponentRef } from "./install-plan.js";
import { hashAppPackage } from "./package-hash.js";
import type { DeployItem } from "./install.js";

export interface LoadedUiAsset { page_key: string; kind: "page" | "widget"; title: string; entry: string; html: string }
export interface LoadedRuntimeAsset { entry: string; code: Buffer; code_hash: string }

export interface LoadedApp {
  manifest: LivelyAppManifest;
  contentHash: string;
  items: DeployItem[];
  uiAssets: LoadedUiAsset[];   // #1780 PR5 — ui.pages/widgets entry HTML(설치 시 보존 대상). 없으면 [].
  runtimeAsset: LoadedRuntimeAsset | null; // Stage B — 임시 stage가 사라져도 실행할 정확한 단일 ESM 번들.
}

// 하네스 자산 종류 → 디스크 레이아웃(Claude 플러그인 트리 규약).
const ASSET_DIRS: Array<{ dir: string; kind: "skill" | "subagent" | "command"; layout: "dir" | "file" }> = [
  { dir: "skills", kind: "skill", layout: "dir" },    // skills/<slug>/SKILL.md
  { dir: "agents", kind: "subagent", layout: "file" }, // agents/<slug>.md
  { dir: "commands", kind: "command", layout: "file" }, // commands/<slug>.md
];

/** 스테이지 디렉터리를 읽어 설치 계획을 완성한다. 결정론적(FS 읽기). */
export async function loadAppPackage(stageDir: string): Promise<LoadedApp> {
  const root = path.resolve(stageDir);
  const manifestPath = path.join(root, "lively-app.json");
  let manifest: LivelyAppManifest;
  try {
    manifest = parseAppManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    assertInstallableManifest(manifest); // 설치 경로에서만 — 재파싱(grant)은 버전 불문(롤백 안전)
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new HttpError(400, "lively-app.json 이 없습니다");
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `lively-app.json 파싱 오류: ${(e as Error).message}`);
  }

  const contentHash = (await hashAppPackage(root)).hash;

  // runtime.entry 는 실행 시점이 아니라 설치 시점에 패키지 안의 실제 파일로 확정한다.
  // 스테이지가 사라진 뒤에야 "파일 없음"을 발견하면 active 앱이 실행 불능이 되므로 앞에서 거부한다.
  const runtimeAsset = await readRuntimeEntry(manifest, root);

  // 1) 매니페스트 선언 component(ui·host·section·data·cron·mcp_server·tool).
  const declared = planDeclaredComponents(manifest);
  const items: DeployItem[] = declared.map((comp) => ({ comp, payload: payloadForDeclared(manifest, comp, runtimeAsset, contentHash) }));

  // 2) 플러그인 트리 harness_asset 스캔(skills·agents·commands).
  const pluginRel = manifest.harness?.plugin ?? "./";
  const pluginRoot = path.resolve(root, pluginRel);
  if (!pluginRoot.startsWith(root)) throw new HttpError(400, "harness.plugin 경로가 패키지 밖을 가리킵니다");
  for (const asset of await scanHarnessAssets(manifest, pluginRoot)) items.push(asset);

  // 3) UI entry HTML 보존 — ui.pages/widgets 의 entry 파일을 읽어 담는다(소스 무관 서빙 대비, PR5).
  const uiAssets = await readUiAssets(manifest, root);

  return { manifest, contentHash, items, uiAssets, runtimeAsset };
}

const RUNTIME_MAX_BYTES = 8 * 1024 * 1024; // v2.1 worker entry 는 의존성을 포함한 단일 ESM 번들이다.

async function readRuntimeEntry(m: LivelyAppManifest, root: string): Promise<LoadedRuntimeAsset | null> {
  if (!m.runtime) return null;
  const abs = path.resolve(root, m.runtime.entry);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new HttpError(400, `runtime entry 가 패키지 밖을 가리킵니다: ${m.runtime.entry}`);
  }
  let st;
  try { st = await stat(abs); } catch { throw new HttpError(400, `runtime entry 파일이 없습니다: ${m.runtime.entry}`); }
  if (!st.isFile()) throw new HttpError(400, `runtime entry 가 파일이 아닙니다: ${m.runtime.entry}`);
  if (st.size > RUNTIME_MAX_BYTES) {
    throw new HttpError(400, `runtime entry 가 너무 큽니다(${m.runtime.entry}, ${st.size}B > ${RUNTIME_MAX_BYTES}B)`);
  }
  const code = await readFile(abs);
  return { entry: m.runtime.entry, code, code_hash: createHash("sha256").update(code).digest("hex") };
}

const UI_MAX_BYTES = 2 * 1024 * 1024; // entry HTML 상한(자체완결 HTML 가정 — 초과는 거부).

// ui.pages/widgets 의 entry 파일을 읽는다. entry 는 패키지 밖을 가리킬 수 없고(경로탈출 거부), 파일이어야 하며 상한 이하.
async function readUiAssets(m: LivelyAppManifest, root: string): Promise<LoadedUiAsset[]> {
  const out: LoadedUiAsset[] = [];
  const specs: Array<{ key: string; kind: "page" | "widget"; title: string; entry: string }> = [
    ...m.ui.pages.map((p) => ({ key: p.key, kind: "page" as const, title: p.title, entry: p.entry })),
    ...m.ui.widgets.map((w) => ({ key: w.key, kind: "widget" as const, title: w.title, entry: w.entry })),
  ];
  for (const spec of specs) {
    const abs = path.resolve(root, spec.entry);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, `ui entry 가 패키지 밖을 가리킵니다: ${spec.entry}`);
    let st;
    try { st = await stat(abs); } catch { throw new HttpError(400, `ui entry 파일이 없습니다: ${spec.entry}`); }
    if (!st.isFile()) throw new HttpError(400, `ui entry 가 파일이 아닙니다: ${spec.entry}`);
    if (st.size > UI_MAX_BYTES) throw new HttpError(400, `ui entry 가 너무 큽니다(${spec.entry}, ${st.size}B > ${UI_MAX_BYTES}B)`);
    out.push({ page_key: spec.key, kind: spec.kind, title: spec.title, entry: spec.entry, html: await readFile(abs, "utf8") });
  }
  return out;
}

// 선언 component 의 payload — 실전개 kind 는 매니페스트 조각, 저널 kind 는 null.
function payloadForDeclared(m: LivelyAppManifest, comp: AppComponentRef, runtime: LoadedRuntimeAsset | null, packageHash: string): unknown {
  if (comp.kind === "runtime_worker") return runtime ? { ...runtime, package_hash: packageHash } : null;
  if (comp.kind === "cron") {
    const job = m.jobs.find((j) => j.key === comp.orig_name);
    return job ? { schedule: job.schedule, run: job.run } : null;
  }
  if (comp.kind === "mcp_server") return m.tools.mcp_servers.find((s) => (s as { name?: string }).name === comp.orig_name) ?? null;
  if (comp.kind === "tool") return m.tools.http_tools.find((t) => (t as { name?: string }).name === comp.orig_name) ?? null;
  return null; // host / ui_page / ui_widget / section / data_table
}

async function scanHarnessAssets(m: LivelyAppManifest, pluginRoot: string): Promise<DeployItem[]> {
  const out: DeployItem[] = [];
  for (const spec of ASSET_DIRS) {
    const base = path.join(pluginRoot, spec.dir);
    let entries: string[];
    try { entries = await readdir(base); } catch { continue; } // 없으면 스킵
    for (const name of entries) {
      let slug: string; let body: string;
      if (spec.layout === "dir") {
        const skillMd = path.join(base, name, "SKILL.md");
        try { const s = await stat(skillMd); if (!s.isFile()) continue; } catch { continue; }
        slug = name; body = await readFile(skillMd, "utf8");
      } else {
        if (!name.endsWith(".md")) continue;
        slug = name.slice(0, -3); body = await readFile(path.join(base, name), "utf8");
      }
      out.push({
        comp: { kind: "harness_asset", ref: appAssetId(m.id, slug), orig_name: slug },
        payload: { kind: spec.kind, harness: "claude", body, label: slug },
      });
    }
  }
  // 같은 ref 가 두 번 나오면(예: skills/x 와 commands/x 가 같은 slug) 거부 — 물질화 충돌.
  const seen = new Set<string>();
  for (const it of out) {
    if (seen.has(it.comp.ref)) throw new HttpError(400, `하네스 자산 id 충돌: ${it.comp.orig_name}`);
    seen.add(it.comp.ref);
  }
  return out;
}
