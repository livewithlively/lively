// 앱 세션 물질화 (#1780, design D3·D4) — cwd와 분리된 private app runtime home에 두 가지를 깐다:
//  ① 앱 홈(D3, 앱 홈 레일): <sessionHome>/.lively/{token,gateway-url} — stdio 프록시(lively-mcp-gateway.mjs 가
//     LIVELY_HOME 존중)가 이 파일로 앱 토큰을 읽는다. 토큰을 env 가 아니라 **파일**로 주는 게 핵심(#916 파일-우선 불변식).
//  ② 앱 하네스 자산(D4): <sessionHome>/plugin/{skills,agents,commands}/… + .claude-plugin/plugin.json.
//     Claude Code에는 세션 argv `--plugin-dir <sessionHome>/plugin`으로만 싣는다. 그래서 사용자가 고른 cwd를 쓰지 않으면서
//     앱 자산은 같은 세션에만 적용된다. 파일 형식은 멤버 materializer와 같은 규약(frontmatter + 본문 + provenance 마커).
//
//  createSession(input.appId) 이 grant 검사·앱 토큰 발급 후 이 모듈을 호출한다. 격리(멤버 uid) vs 비격리(게이트웨이
//   직접 fs)는 **AppFsWriter** 주입으로 갈린다 — 순수 경로 로직(assetDiskPath·composeAssetFile)은 writer 와 무관하다.
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { STRICT_SLUG } from "../org/asset-id.js";
import { listComponents } from "../org/store/apps.js";
import { getOrgHarnessAsset, type OrgHarnessAsset } from "../org/store/harness-assets.js";

// provenance 한 줄 — 이 파일은 중앙 자산의 실행 사본이라 손으로 만든 로컬 자산과 겉이 같다(kit sync-harness-assets 와 같은 취지).
const PROVENANCE =
  "라이블리 앱이 실행 홈에 물질화한 사본입니다. 편집은 앱 패키지(매니페스트) — 이 파일 직접 수정은 다음 스폰에 덮어써집니다.";
export const APP_PLUGIN_SUBDIR = "plugin";

// 파일 쓰기 추상화 — 비격리(게이트웨이 직접 fs)와 격리(멤버 uid 로 spawn)를 호출부가 주입한다.
//  private app home이 멤버 700 홈 안이면 게이트웨이(비-멤버)가 직접 못 쓰므로, 격리 세션은 멤버 백엔드 writer를 넘긴다.
export interface AppFsWriter {
  mkdirp(absDir: string): Promise<void>;
  writeFile(absPath: string, data: string, mode: number): Promise<void>;
}

// 기본 writer — 게이트웨이 프로세스가 직접 쓴다(비격리 세션·단위/통합 테스트).
export const directFsWriter: AppFsWriter = {
  mkdirp: async (d) => { await fsp.mkdir(d, { recursive: true, mode: 0o700 }); },   // mkdir 은 created path 를 반환 → void 로 삼킨다
  writeFile: (p, data, mode) => fsp.writeFile(p, data, { mode }),
};

// YAML frontmatter 값 방출 — kit/hooks/sync-harness-assets.mjs 의 yamlValue 와 **글자 그대로 같은 규약**(정확성 우선:
//  JSON.stringify 로 `:`·개행·한글 등 특수문자 모호성 0). 한쪽만 바꾸면 같은 자산이 멤버 디스크와 세션 디스크에서 갈린다.
function yamlValue(v: unknown): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map((e) => JSON.stringify(String(e))).join(", ") + "]";
  return JSON.stringify(String(v ?? ""));
}

/**
 * 순수 — 자산 종류 → private app home의 Claude plugin **상대경로**(POSIX). 단위테스트 대상.
 *   skill → plugin/skills/<name>/SKILL.md · subagent → plugin/agents/<name>.md · command → plugin/commands/<name>.md
 *  디스크 대상이 아닌 종류(하위 방어)는 null → 호출부가 skip.
 */
export function assetDiskPath(kind: string, origName: string): string | null {
  switch (kind) {
    case "skill":    return path.posix.join(APP_PLUGIN_SUBDIR, "skills", origName, "SKILL.md");
    case "subagent": return path.posix.join(APP_PLUGIN_SUBDIR, "agents", `${origName}.md`);
    case "command":  return path.posix.join(APP_PLUGIN_SUBDIR, "commands", `${origName}.md`);
    default:         return null;
  }
}

/**
 * 순수 — orig_name 경로안전 검증. STRICT_SLUG(`/`·`.`·`..`·절대경로·공백 원천차단)가 아니면 HttpError(500).
 *  정규화(trim·소문자)한 이름을 돌려준다 — materializer 가 디스크 경로에 넣기 전 traversal 2차 방어(1차는 자산 id 검증).
 */
export function assertOrigNameSafe(appId: string, origName: string | null | undefined): string {
  const s = String(origName ?? "").trim().toLowerCase();
  if (!STRICT_SLUG.test(s)) throw new HttpError(500, `앱 '${appId}' 자산 orig_name 형식 오류(경로안전 위반): '${origName ?? ""}'`);
  return s;
}

/** Claude plugin 최소 manifest. 앱 id는 설치 단계에서 이미 STRICT_SLUG로 검증되며 여기서도 다시 검증한다. */
export function appPluginManifest(appId: string): string {
  const name = assertOrigNameSafe(appId, appId);
  return JSON.stringify({ name, description: `Lively app session assets for ${name}`, version: "1.0.0" }, null, 2) + "\n";
}

/** 세션별 앱 자산은 Claude의 공식 local plugin 표면으로만 주입한다. 다른 하네스에는 Claude argv를 섞지 않는다. */
export function appPluginArgs(harnessKey: string, sessionHome: string): string[] {
  return harnessKey === "claude" ? ["--plugin-dir", path.join(sessionHome, APP_PLUGIN_SUBDIR)] : [];
}

/**
 * 순수 — 자산 본문 조립(claude frontmatter + 본문 + provenance). name 은 **origName(앱 슬러그)로 강제**한다:
 *  중앙 저장 id 는 app-<hash>-<slug> 라, 그걸 name 으로 두면 앱 내부에서 `@<slug>` 상호참조가 안 맞물린다.
 *  frontmatter 의 나머지 키(model·tools 등)는 순서 보존해 그대로 옮긴다(kit composeFile 과 동형).
 */
export function composeAssetFile(asset: Pick<OrgHarnessAsset, "description" | "body" | "frontmatter">, origName: string): string {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter))
    ? asset.frontmatter : {};
  const ordered: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  const push = (k: string, v: unknown): void => { if (!seen.has(k)) { ordered.push([k, v]); seen.add(k); } };
  push("name", origName);                                                       // 앱 슬러그 강제(내부 상호참조)
  push("description", asset.description != null && asset.description !== "" ? asset.description : (fm.description ?? ""));
  for (const k of Object.keys(fm)) if (k !== "name" && k !== "description") push(k, fm[k]);
  const lines = ordered.map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

/**
 * 앱 홈 물질화(D3) — <sessionHome>/.lively/{token,gateway-url}. token 은 0600(자격 파일).
 *  gatewayUrl 이 null(미해소)이면 gateway-url 파일은 생략한다 — 프록시가 로컬 기본(localhost:8080)으로 폴백한다.
 */
export async function writeAppHome(sessionHome: string, token: string, gatewayUrl: string | null, writer: AppFsWriter = directFsWriter): Promise<void> {
  const dir = path.join(sessionHome, ".lively");
  await writer.mkdirp(dir);
  await writer.writeFile(path.join(dir, "token"), token, 0o600);
  if (gatewayUrl) await writer.writeFile(path.join(dir, "gateway-url"), `${gatewayUrl}\n`, 0o600);
}

/**
 * 앱 하네스 자산 물질화(D4) — listComponents(appId) 중 kind='harness_asset' 을 골라 각 org_harness_asset 을 읽어
 *  private app home의 session-local plugin에 원명(orig_name)으로 기록한다. **앱 세션 hard-fail**: 자산 없는 앱 세션은 틀린 상태다.
 *  경로안전: orig_name 이 STRICT_SLUG(`/`·`.`·`..`·절대경로·공백 원천차단)가 아니면 거부(traversal 2차 방어).
 */
export async function materializeAppAssets(sessionHome: string, appId: string, writer: AppFsWriter = directFsWriter): Promise<void> {
  const manifest = path.join(sessionHome, APP_PLUGIN_SUBDIR, ".claude-plugin", "plugin.json");
  await writer.mkdirp(path.dirname(manifest));
  await writer.writeFile(manifest, appPluginManifest(appId), 0o644);
  const comps = (await listComponents(appId)).filter((c) => c.kind === "harness_asset");
  for (const c of comps) {
    const origName = assertOrigNameSafe(appId, c.orig_name);
    const asset = await getOrgHarnessAsset(c.ref);
    if (!asset) throw new HttpError(500, `앱 '${appId}' 자산 행 없음: ${c.ref}`);
    const rel = assetDiskPath(asset.kind, origName);
    if (!rel) continue; // harness_asset 인데 kind 가 skill/subagent/command 가 아님(있을 수 없지만 방어) — skip
    const abs = path.join(sessionHome, rel);
    await writer.mkdirp(path.dirname(abs));
    await writer.writeFile(abs, composeAssetFile(asset, origName), 0o644);
  }
}
