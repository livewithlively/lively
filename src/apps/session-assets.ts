// 앱 세션 물질화 (#1780, design D3·D4) — 앱으로 뜨는 세션의 폴더에 두 가지를 깐다:
//  ① 앱 홈(D3, 앱 홈 레일): <sessionDir>/.lively/{token,gateway-url} — stdio 프록시(lively-mcp-gateway.mjs 가
//     LIVELY_HOME 존중)가 이 파일로 앱 토큰을 읽는다. 토큰을 env 가 아니라 **파일**로 주는 게 핵심(#916 파일-우선 불변식).
//  ② 앱 하네스 자산(D4): <sessionDir>/.claude/{skills,agents,commands}/… — 그 앱 소속 자산만, **원명(orig_name)**으로
//     복원해 앱 내부 상호참조가 맞물리게 한다. Claude Code 는 cwd `.claude/{skills,agents,commands}` 를 신뢰 승인 없이
//     인식한다(공식 문서 claude-directory.md — design D4 확정). 파일 형식은 멤버 materializer(kit/hooks/sync-harness-assets.mjs)와
//     같은 규약(frontmatter + 본문 + provenance 마커).
//
//  createSession(input.appId) 이 grant 검사·앱 토큰 발급 후 이 모듈을 호출한다. 격리(멤버 uid) vs 비격리(게이트웨이
//   직접 fs)는 **AppFsWriter** 주입으로 갈린다 — 순수 경로 로직(assetDiskPath·composeAssetFile)은 writer 와 무관하다.
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { STRICT_SLUG } from "../org/asset-id.js";
import { listComponents } from "../org/store/apps.js";
import { getOrgHarnessAsset, type OrgHarnessAsset } from "../org/store/harness-assets.js";

// provenance 한 줄 — 이 파일은 중앙 자산의 세션 사본이라 손으로 만든 로컬 자산과 겉이 같다(kit sync-harness-assets 와 같은 취지).
const PROVENANCE =
  "라이블리 앱이 세션에 물질화한 사본입니다. 편집은 앱 패키지(매니페스트) — 이 파일 직접 수정은 다음 스폰에 덮어써집니다.";

// 파일 쓰기 추상화 — 비격리(게이트웨이 직접 fs)와 격리(멤버 uid 로 spawn)를 호출부가 주입한다.
//  세션 폴더가 멤버 700 홈 안이면 게이트웨이(비-멤버)가 직접 못 쓰므로, 격리 세션은 멤버 백엔드 writer 를 넘긴다.
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
 * 순수 — 자산 종류 → 세션 폴더 **상대경로**(POSIX). 단위테스트 대상.
 *  Claude 배치 규약(kit sync-harness-assets placement 과 동일):
 *   skill → .claude/skills/<name>/SKILL.md · subagent → .claude/agents/<name>.md · command → .claude/commands/<name>.md
 *  디스크 대상이 아닌 종류(하위 방어)는 null → 호출부가 skip.
 */
export function assetDiskPath(kind: string, origName: string): string | null {
  switch (kind) {
    case "skill":    return path.posix.join(".claude", "skills", origName, "SKILL.md");
    case "subagent": return path.posix.join(".claude", "agents", `${origName}.md`);
    case "command":  return path.posix.join(".claude", "commands", `${origName}.md`);
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
 * 앱 홈 물질화(D3) — <sessionDir>/.lively/{token,gateway-url}. token 은 0600(자격 파일).
 *  gatewayUrl 이 null(미해소)이면 gateway-url 파일은 생략한다 — 프록시가 로컬 기본(localhost:8080)으로 폴백한다.
 */
export async function writeAppHome(sessionDir: string, token: string, gatewayUrl: string | null, writer: AppFsWriter = directFsWriter): Promise<void> {
  const dir = path.join(sessionDir, ".lively");
  await writer.mkdirp(dir);
  await writer.writeFile(path.join(dir, "token"), token, 0o600);
  if (gatewayUrl) await writer.writeFile(path.join(dir, "gateway-url"), `${gatewayUrl}\n`, 0o600);
}

/**
 * 앱 하네스 자산 물질화(D4) — listComponents(appId) 중 kind='harness_asset' 을 골라 각 org_harness_asset 을 읽어
 *  세션 폴더 .claude/ 에 원명(orig_name)으로 기록한다. **앱 세션 hard-fail**: 스킬 없는 앱 세션은 틀린 상태다.
 *  경로안전: orig_name 이 STRICT_SLUG(`/`·`.`·`..`·절대경로·공백 원천차단)가 아니면 거부(traversal 2차 방어).
 */
export async function materializeAppAssets(sessionDir: string, appId: string, writer: AppFsWriter = directFsWriter): Promise<void> {
  await materializePreparedAppAssets(sessionDir, await prepareAppAssets(appId), writer);
}

/** 정책/DB 쪽(게이트웨이)이 앱 자산을 직렬화 가능한 번들로 준비한다. */
export async function prepareAppAssets(appId: string): Promise<PreparedAppAsset[]> {
  const out: PreparedAppAsset[] = [];
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

/** 실행 호스트가 준비된 번들을 자기 세션 디렉터리에 쓴다. 네트워크 입력이라 상대경로를 다시 봉쇄한다. */
export async function materializePreparedAppAssets(sessionDir: string, assets: PreparedAppAsset[], writer: AppFsWriter = directFsWriter): Promise<void> {
  const root = path.resolve(sessionDir);
  for (const asset of assets) {
    // 봉투 경로는 게이트웨이가 만든 POSIX 정본 형식만 받는다. 단순 prefix 검사는
    // `.claude/skills/../../.lively/token`도 통과시키므로, 종류별 최종 모양과 slug를 모두 확인한다.
    const rel = String(asset.path ?? "");
    const parts = rel.split("/");
    const skill = parts.length === 4 && parts[0] === ".claude" && parts[1] === "skills" && parts[3] === "SKILL.md" ? parts[2] : null;
    const leaf = parts.length === 3 && parts[0] === ".claude" && (parts[1] === "agents" || parts[1] === "commands") && parts[2].endsWith(".md")
      ? parts[2].slice(0, -3) : null;
    if (rel.includes("\\") || !(skill ? STRICT_SLUG.test(skill) : leaf ? STRICT_SLUG.test(leaf) : false)) {
      throw new HttpError(400, `허용되지 않은 앱 자산 경로입니다: ${asset.path}`);
    }
    const abs = path.resolve(root, asset.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, `앱 자산 경로가 세션 밖을 가리킵니다: ${asset.path}`);
    await writer.mkdirp(path.dirname(abs));
    await writer.writeFile(abs, asset.body, asset.mode === 0o600 ? 0o600 : 0o644);
  }
}
