// 앱 세션 물질화 (#1780, design D3·D4) — cwd와 분리된 private app runtime home(<personal>/sessions/<id>)에 두 가지를 깐다:
//  ① 앱 홈(D3, 앱 홈 레일): <sessionHome>/.lively/{token,gateway-url} — stdio 프록시(lively-mcp-gateway.mjs 가
//     LIVELY_HOME 존중)가 이 파일로 앱 토큰을 읽는다. 토큰을 env 가 아니라 **파일**로 주는 게 핵심(#916 파일-우선 불변식).
//  ② 앱 하네스 자산(D4): <sessionHome>/plugin/{skills,agents,commands}/… + plugin/.claude-plugin/plugin.json.
//     Claude Code 에는 세션 argv `--plugin-dir <sessionHome>/plugin` 으로만 싣는다(#1867). 그래서 사용자가 고른 cwd 에는
//     아무 파일도 쓰지 않으면서 앱 자산은 그 세션에만 적용된다. 종전(cwd `.claude/`)은 같은 cwd 를 공유하는 세션끼리
//     자산·토큰이 섞이고, 사용자 폴더를 오염시켰다. 파일 형식은 멤버 materializer(kit/hooks/sync-harness-assets.mjs)와
//     같은 규약(frontmatter + 본문 + provenance 마커).
//
//  createSession(input.appId) 이 grant 검사·앱 토큰 발급 후 이 모듈을 호출한다. 격리(멤버 uid) vs 비격리(게이트웨이
//   직접 fs)는 **AppFsWriter** 주입으로 갈린다 — 순수 경로 로직(assetDiskPath·composeAssetFile)은 writer 와 무관하다.
//  원격 노드(DB 없음)는 게이트웨이가 prepareAppAssets 로 만든 봉투(PreparedAppAsset[])를 받아 materializePreparedAppAssets 로 쓴다.
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { STRICT_SLUG } from "../org/asset-id.js";
import { listComponents } from "../org/store/apps.js";
import { getOrgHarnessAsset, type OrgHarnessAsset } from "../org/store/harness-assets.js";

// provenance 한 줄 — 이 파일은 중앙 자산의 실행 사본이라 손으로 만든 로컬 자산과 겉이 같다(kit sync-harness-assets 와 같은 취지).
const PROVENANCE =
  "라이블리 앱이 실행 홈에 물질화한 사본입니다. 편집은 앱 패키지(매니페스트) — 이 파일 직접 수정은 다음 스폰에 덮어써집니다.";
/** private session_home 아래 Claude local plugin 디렉터리 이름 — `--plugin-dir <sessionHome>/plugin`. */
export const APP_PLUGIN_SUBDIR = "plugin";
/** plugin 매니페스트의 plugin 루트 기준 상대경로(POSIX) — Claude Code local plugin 규약(.claude-plugin/plugin.json). */
export const APP_PLUGIN_MANIFEST_REL = path.posix.join(APP_PLUGIN_SUBDIR, ".claude-plugin", "plugin.json");

// 파일 쓰기 추상화 — 비격리(게이트웨이 직접 fs)와 격리(멤버 uid 로 spawn)를 호출부가 주입한다.
//  private app home 이 멤버 700 홈 안이면 게이트웨이(비-멤버)가 직접 못 쓰므로, 격리 세션은 멤버 백엔드 writer 를 넘긴다.
export interface AppFsWriter {
  mkdirp(absDir: string): Promise<void>;
  writeFile(absPath: string, data: string, mode: number): Promise<void>;
}

/** 게이트웨이가 DB에서 준비해 원격 ExecutionHost에 넘길 수 있는 자산. 절대경로·자격은 싣지 않는다. */
export interface PreparedAppAsset { path: string; body: string; mode: number }

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
 * 순수 — 자산 종류 → private app home 의 Claude plugin **상대경로**(POSIX). 단위테스트 대상.
 *   skill → plugin/skills/<name>/SKILL.md · subagent → plugin/agents/<name>.md · command → plugin/commands/<name>.md
 *  (Claude local plugin 배치 규약 — kit sync-harness-assets 의 `.claude/…` 배치와 하위 구조가 같다.)
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
 * body 앞머리의 frontmatter 블록을 떼어낸다(순수) — 떼어낸 스칼라 키/값도 함께 돌려준다.
 *
 *  왜: 자산을 올리는 경로 중에 **파일 전문(frontmatter 포함)을 body 에 통째로** 넣은 것이 실재한다(킷 쪽 #278 과 같은 뿌리).
 *   그대로 심으면 frontmatter 가 두 벌인 파일이 되고, 로더는 첫 블록만 먹으므로 두 번째 블록이 본문 첫 단락으로 샌다.
 *  ⚠ 실측(#1867, 2026-08-25 dev): 앱 `hello` 의 greet 스킬이 `description: ""` + 이중 frontmatter 로 깔려
 *   **Claude 가 그 스킬을 아예 싣지 않았다**(세션의 호출 가능 스킬 목록에 부재). description 이 빈 스킬은 무효다.
 *   그래서 컬럼이 비었을 때만 body 블록의 값을 **폴백**으로 쓴다(컬럼이 있으면 컬럼이 진실원천 — 중앙 편집이 이긴다).
 *
 *  YAML 파서를 들이지 않는다. 블록의 **첫 비공백 줄**이 `key:` 꼴일 때만 frontmatter 로 본다 — 본문이 `---`
 *   수평선으로 시작하는 마크다운을 잘라먹지 않기 위한 조건이다(kit stripLeadingFrontmatter 와 같은 규약).
 */
export function splitLeadingFrontmatter(body: string | null | undefined): { body: string; fields: Record<string, string> } {
  const t = String(body ?? "");
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { body: t, fields: {} };
  const lines = m[1].split(/\r?\n/);
  const head = lines.find((l) => l.trim() !== "");
  if (!head || !/^[ \t]*[A-Za-z_][\w-]*[ \t]*:(?:[ \t]|$)/.test(head)) return { body: t, fields: {} };
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const kv = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;                                   // 중첩·리스트 줄은 폴백 대상이 아니다(스칼라만 본다)
    const raw = kv[2].trim().replace(/^["']|["']$/g, "");
    if (raw) fields[kv[1]] = raw;
  }
  return { body: t.slice(m[0].length).replace(/^\s*\n/, ""), fields };
}

/**
 * 순수 — 자산 본문 조립(claude frontmatter + 본문 + provenance). name 은 **origName(앱 슬러그)로 강제**한다:
 *  중앙 저장 id 는 app-<hash>-<slug> 라, 그걸 name 으로 두면 앱 내부에서 `@<slug>` 상호참조가 안 맞물린다.
 *  frontmatter 의 나머지 키(model·tools 등)는 순서 보존해 그대로 옮긴다(kit composeFile 과 동형).
 */
export function composeAssetFile(asset: Pick<OrgHarnessAsset, "description" | "body" | "frontmatter">, origName: string): string {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter))
    ? asset.frontmatter : {};
  // body 가 파일 전문(frontmatter 포함)이면 그 블록을 떼어낸다 — 안 떼면 두 벌이 되어 로더가 두 번째를 본문으로 읽는다.
  const split = splitLeadingFrontmatter(asset.body);
  const ordered: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  const push = (k: string, v: unknown): void => { if (!seen.has(k)) { ordered.push([k, v]); seen.add(k); } };
  push("name", origName);                                                       // 앱 슬러그 강제(내부 상호참조)
  // description 우선순위: 컬럼 > frontmatter 컬럼 > body 블록. 빈 description 스킬은 하네스가 싣지 않는다(#1867 실측).
  const desc = [asset.description, fm.description, split.fields.description]
    .find((v) => typeof v === "string" && v.trim() !== "");
  push("description", desc ?? "");
  for (const k of Object.keys(fm)) if (k !== "name" && k !== "description") push(k, fm[k]);
  const lines = ordered.map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n<!-- ${PROVENANCE} -->\n\n${split.body || ""}\n`;
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
 *  private app home 의 session-local plugin 에 원명(orig_name)으로 기록한다. **앱 세션 hard-fail**: 자산 없는 앱 세션은 틀린 상태다.
 *  경로안전: orig_name 이 STRICT_SLUG(`/`·`.`·`..`·절대경로·공백 원천차단)가 아니면 거부(traversal 2차 방어).
 */
export async function materializeAppAssets(sessionHome: string, appId: string, writer: AppFsWriter = directFsWriter): Promise<void> {
  await materializePreparedAppAssets(sessionHome, await prepareAppAssets(appId), writer);
}

/** 정책/DB 쪽(게이트웨이)이 앱 자산을 직렬화 가능한 번들로 준비한다. plugin manifest 가 첫 항목이다. */
export async function prepareAppAssets(appId: string): Promise<PreparedAppAsset[]> {
  const out: PreparedAppAsset[] = [{ path: APP_PLUGIN_MANIFEST_REL, body: appPluginManifest(appId), mode: 0o644 }];
  const comps = (await listComponents(appId)).filter((c) => c.kind === "harness_asset");
  for (const c of comps) {
    const origName = assertOrigNameSafe(appId, c.orig_name);
    const asset = await getOrgHarnessAsset(c.ref);
    if (!asset) throw new HttpError(500, `앱 '${appId}' 자산 행 없음: ${c.ref}`);
    const rel = assetDiskPath(asset.kind, origName);
    if (!rel) continue; // harness_asset 인데 kind 가 skill/subagent/command 가 아님(있을 수 없지만 방어) — skip
    out.push({ path: rel, body: composeAssetFile(asset, origName), mode: 0o644 });
  }
  return out;
}

/** 실행 호스트가 준비된 번들을 자기 private app home 에 쓴다. 네트워크 입력이라 상대경로를 다시 봉쇄한다. */
export async function materializePreparedAppAssets(sessionHome: string, assets: PreparedAppAsset[], writer: AppFsWriter = directFsWriter): Promise<void> {
  const root = path.resolve(sessionHome);
  for (const asset of assets) {
    // 봉투 경로는 게이트웨이가 만든 POSIX 정본 형식(plugin/… 아래)만 받는다. 단순 prefix 검사는
    // `plugin/skills/../../.lively/token`도 통과시키므로, 종류별 최종 모양과 slug를 모두 확인한다.
    //  종전 cwd 배치(`.claude/…`)는 더 이상 받지 않는다 — 사용자 workspace 에 파일을 쓰는 경로다.
    const rel = String(asset.path ?? "");
    const parts = rel.split("/");
    const manifest = rel === APP_PLUGIN_MANIFEST_REL;
    const skill = parts.length === 4 && parts[0] === APP_PLUGIN_SUBDIR && parts[1] === "skills" && parts[3] === "SKILL.md" ? parts[2] : null;
    const leaf = parts.length === 3 && parts[0] === APP_PLUGIN_SUBDIR && (parts[1] === "agents" || parts[1] === "commands") && parts[2].endsWith(".md")
      ? parts[2].slice(0, -3) : null;
    if (rel.includes("\\") || !(manifest ? true : skill ? STRICT_SLUG.test(skill) : leaf ? STRICT_SLUG.test(leaf) : false)) {
      throw new HttpError(400, `허용되지 않은 앱 자산 경로입니다: ${asset.path}`);
    }
    const abs = path.resolve(root, asset.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, `앱 자산 경로가 세션 밖을 가리킵니다: ${asset.path}`);
    await writer.mkdirp(path.dirname(abs));
    await writer.writeFile(abs, asset.body, asset.mode === 0o600 ? 0o600 : 0o644);
  }
}
