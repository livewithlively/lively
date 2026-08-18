#!/usr/bin/env node
// SessionStart 훅 — 조직 하네스 자산(스킬·서브에이전트·슬래시커맨드)을 게이트웨이에서 받아 멤버 하네스
// 디스크에 **비파괴 materialize** 한다. 훅(run-custom)과 결정적으로 다른 점: 하네스가 디스크를 '스캔'해야
// 자산을 발견하므로(name+description 상시광고, 본문 온디맨드) 본문을 파일로 굳힌다 — 훅처럼 임시실행·삭제가 아니다.
//
//   Claude:  skill→ ~/.claude/skills/<id>/SKILL.md · subagent→ ~/.claude/agents/<id>.md · command→ ~/.claude/commands/<id>.md
//   Codex:   skill→ ~/.codex/skills/<id>/SKILL.md (Agent Skills 오픈표준 = Claude 와 **같은 파일**)
//            subagent→ ~/.codex/agents/<id>.toml (포맷이 다르다 — composeCodexSubagent 가 변환)
//            command→ ~/.codex/prompts/<id>.md  (커스텀 프롬프트 `/prompts:<id>` — 최상위 .md 만 스캔됨)
//
// 동기화 모델(session-preload 의 auto-approve reconcile 와 동형): ~/.lively/managed-harness-assets.json 매니페스트로
//  'lively 가 심은 것'만 추적 → 멤버 본인 스킬은 절대 안 건드리고, lively 가 더는 원치 않는 것만 회수한다.
//  content_hash 로 변경분만 재작성(불필요 write skip). Claude 는 reloadSkills:true 로 같은 세션 즉시 반영.
//
// **회수 정책(설계): fail-OPEN(last-known-good).** 훅(run-custom)은 control 이라 fail-CLOSED(게이트웨이 미도달→무실행)지만,
//  자산은 capability 라 게이트웨이 블립에 스킬을 잃으면 안 된다 → fetch 실패 시 디스크 현상 유지(prune 안 함).
//  위험 자산의 즉시 무력화는 짝훅(paired_hook, fail-CLOSED 런너)이 담당한다(그 액션을 차단).
//
// 보안: id 슬러그 재검증 + 경로 containment(대상 디렉터리 밖이면 skip) + 심링크 통과 거부(멤버 파일 탈취 방지).
// 페일오픈: 어떤 실패든 조용히 exit 0 — 실제 작업 세션을 절대 막지 않는다. 토큰 값은 절대 출력/로깅하지 않는다.
// 비활성화(incognito): LIVELY_OFF=1 → no-op. 어드민 토글: hooks-config.json hooks.sync_harness_assets===false.
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { join, dirname, relative, isAbsolute } from "node:path";
// 하네스별 규약(경로·확장자·본문형식·재로드)은 **표 한 벌**에서 온다 — 종전엔 placement()·assetDirs() 두 곳이
//  따로 하드코딩돼 어긋날 수 있었다(어긋나면 관측·로컬토글에서 그 종류가 통째로 안 보인다).
//  ⚠ 이 import 가 성립하려면 harness-registry.mjs 가 이 파일과 **같은 디렉터리**로 설치돼야 한다
//   (설치 시 ~/.lively/hooks/ 로 평평하게 복사되므로) → user-install 의 HOOK_SCRIPTS 에 등재돼 있다.
import { resolveHarness, harness, placementFor, assetDirsFor, assetDirNames, isForeignGrokInvocation } from "./harness-registry.mjs";

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다 — dev '다온' 실측이 정확히 그 사고다.
const SCOPE_HDRS = {
  ...(String(process.env.LIVELY_SESSION_ID || "").trim() ? { "x-lively-session": String(process.env.LIVELY_SESSION_ID).trim() } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
};


// grok compat 이중발화 가드(#1701) — grok 이 ~/.claude/settings.json 의 우리 훅을 그대로 실행한 사본이면
//  비켜선다(사본은 --harness 없이 돌아 claude 자리에 sync 하므로 grok 세션에서 무의미 + 이중 fetch).
if (isForeignGrokInvocation()) process.exit(0);

const OFF = process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1";
if (OFF) process.exit(0);

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CODEX_DIR = join(HOME, ".codex");
const FETCH_MS = 3000;
const HARD_MS = 4000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MANIFEST = join(LIVELY, "managed-harness-assets.json");

const readLocal = (rel) => { try { return readFileSync(join(LIVELY, rel), "utf8").trim() || null; } catch { return null; } };

// machine-id(#891) — 한 멤버의 여러 PC 를 구분. ~/.lively/machine-id 에 1회 생성(UUID), 이후 재사용.
//  이게 있어야 집·회사 PC 의 로컬 관측·토글이 서로 안 덮어쓴다. 실패는 조용히(관측이라 비치명 — 서버가 host 폴백).
function machineId() {
  try {
    const p = join(LIVELY, "machine-id");
    const cur = readFileSync(p, "utf8").trim();
    if (/^[a-f0-9-]{8,64}$/i.test(cur)) return cur;
  } catch { /* 없음 → 생성 */ }
  try { const id = randomUUID(); writeFileSync(join(LIVELY, "machine-id"), id + "\n", { mode: 0o600 }); return id; }
  catch { return ""; } // 못 쓰면 서버가 host 로 폴백
}

const HARNESS = resolveHarness(process.argv, process.env); // 미설정=claude 기본(session-preload 와 동일 규약)

function hookDisabled() {
  try {
    const c = JSON.parse(readFileSync(join(LIVELY, "hooks-config.json"), "utf8"));
    return !!(c && c.hooks && c.hooks.sync_harness_assets === false);
  } catch { return false; }
}

const TOKEN = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
const GW = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080").replace(/\/$/, "");

// ── 대상 하네스별 자산 배치 규약 ──
// 반환: { root(자산 루트), file(절대경로), skillDir?(스킬 디렉터리) } 또는 null(미지원=skip).
//  규약 자체는 harness-registry 의 표에 있다 — 여기선 위임만 한다(경로 하드코딩을 두 곳에 두지 않는다).
function placement(kind, id) {
  return placementFor(HARNESS, kind, id, HOME);
}

// YAML frontmatter 방출 — 값은 문자열(JSON 이중따옴표=유효 YAML flow scalar)·불리언·숫자·문자열배열.
//  항상 JSON.stringify 문자열 → `:`·개행·한글 등 특수문자 안전(모호성 0). 관리 파일이라 가독성보다 정확성 우선.
function yamlValue(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map((e) => JSON.stringify(String(e))).join(", ") + "]";
  return JSON.stringify(String(v ?? ""));
}
// provenance 한 줄(#932) — 이 파일은 중앙 asset 의 사본이라 손으로 만든 로컬 자산과 겉이 같다.
const PROVENANCE = "라이블리가 materialize 한 사본입니다. 편집은 MCP org_harness_asset_upsert(또는 관리탭 ▸ 하네스) — 이 파일 직접 수정은 다음 sync 에 덮어써집니다.";

// codex 서브에이전트 = **TOML**(md 아님). 필수 키 name·description·developer_instructions(본문=시스템 프롬프트).
//  값은 전부 TOML basic 문자열(JSON.stringify) — 개행·따옴표·한글이 그대로 escape 된다. multi-line `"""` 를 쓰면
//  본문에 `"""` 나 끝나는 따옴표가 있을 때 파일 전체가 깨지므로 쓰지 않는다(yamlValue 와 같은 철학: 가독성보다 정확성).
//  ⚠ claude frontmatter 의 model·tools 는 **옮기지 않는다** — 모델 슬러그("sonnet")도 툴 이름도 하네스마다 달라
//   그대로 넣으면 codex 가 뜨지 않거나 조용히 무시한다. 넘기는 건 이식 가능한 셋(name·description·본문)뿐이다.
function composeCodexSubagent(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const name = fm.name != null ? String(fm.name) : String(asset.id || "");
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  return [
    `# ${PROVENANCE}`,
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(desc)}`,
    `developer_instructions = ${JSON.stringify(String(asset.body || ""))}`,
    "",
  ].join("\n");
}

// codex 커스텀 프롬프트(`/prompts:<name>`) = **본문 그대로의 markdown**. claude command 의 frontmatter
//  (description·argument-hint 등)는 codex 가 해석하지 않아 그대로 프롬프트 텍스트로 새어 들어가므로 싣지 않는다.
function composeCodexPrompt(asset) {
  return `<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

// 본문 변환기 — 어느 형식으로 쓸지는 표의 assets[kind].compose 가 정한다(하네스 이름으로 분기하지 않는다).
//  "markdown" = frontmatter + 본문(claude 계열 공통, 스킬은 오픈표준이라 어느 하네스든 여기로 온다).
const COMPOSERS = {
  "codex-toml": composeCodexSubagent,
  "codex-prompt": composeCodexPrompt,
  "opencode-agent": composeOpencodeAgent,
  "opencode-command": composeOpencodeCommand,
  "antigravity-agent": composeAntigravityAgent,
  "antigravity-workflow": composeAntigravityWorkflow,
  "grok-agent": composeGrokAgent,
};
// opencode 서브에이전트 = md 지만 **frontmatter 스키마가 claude 와 다르다.**
//  실측(1.18.12): `tools` 는 배열이 아니라 객체 · `color` 는 hex 또는 지정 enum · `model` 은 `provider/model` 형식.
//  claude 값을 그대로 넣으면 `Configuration is invalid` 로 거부되고 — 여기가 중요하다 — **그 파일만 빠지는 게
//  아니라 설정 로드가 통째로 실패해 스킬까지 0개가 된다**(실측). 그래서 이식 가능한 셋만 넘긴다:
//  description + mode(subagent) + 본문. 나머지(color·model·tools)는 하네스가 알아서 기본값을 쓴다.
function composeOpencodeAgent(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  return `---\ndescription: ${yamlValue(desc)}\nmode: "subagent"\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

// opencode 커맨드 — 같은 이유로 description 만 넘긴다(claude 의 argument-hint·allowed-tools 는 opencode 스키마에 없다).
//  본문은 `template` 이 된다.
function composeOpencodeCommand(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  return `---\ndescription: ${yamlValue(desc)}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

// antigravity 서브에이전트(agents/<n>/agent.md) — 실측(#1689)으로 안전 확인된 name·description 만 이식한다.
//  claude 의 tools·color·model 은 antigravity 스키마 미확인이라 싣지 않는다(codex·opencode 와 같은 판단 —
//  잘못된 frontmatter 의 폭발 반경이 하네스마다 달라도, 이식 가능 최소셋만 넘기는 규칙은 같다).
function composeAntigravityAgent(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  const name = fm.name != null ? String(fm.name) : String(asset.id || "");
  return `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(desc)}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

// antigravity 워크플로우(workflows/<n>.md — 슬래시커맨드 등가, `/<이름>` 으로 호출) — description + 본문만.
//  실측(#1689): description frontmatter 워크플로우가 print 모드 포함 정상 실행. argument-hint 류는 미지원이라 제외.
function composeAntigravityWorkflow(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  return `---\ndescription: ${yamlValue(desc)}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

// grok 서브에이전트(agents/<id>.md) — frontmatter 파서는 관용(#1701 실측: 미지 필드·claude 필드 로드됨,
//  이웃 무해)이지만, claude 의 model 슬러그("sonnet")·tools 이름의 **런타임 의미**는 미실측이다.
//  codex·opencode·antigravity 와 같은 판단으로 이식 가능 최소셋(name·description·본문)만 넘긴다.
function composeGrokAgent(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const desc = asset.description != null ? String(asset.description) : String(fm.description ?? "");
  const name = fm.name != null ? String(fm.name) : String(asset.id || "");
  return `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(desc)}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

function composeFile(asset) {
  const spec = harness(HARNESS).assets[asset.kind];
  const custom = spec && COMPOSERS[spec.compose];
  if (custom) return custom(asset);
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const ordered = [];
  const seen = new Set();
  const push = (k, v) => { if (!seen.has(k)) { ordered.push([k, v]); seen.add(k); } };
  push("name", fm.name != null ? fm.name : asset.id);          // frontmatter.name 우선, 없으면 id
  push("description", asset.description != null ? asset.description : (fm.description ?? "")); // description 컬럼이 진실원천
  for (const k of Object.keys(fm)) if (k !== "name" && k !== "description") push(k, fm[k]);
  const lines = ordered.map(([k, v]) => `${k}: ${yamlValue(v)}`);
  // 세션이 파일만 봐도 '사본이니 중앙을 고쳐라'를 알게 마커를 박는다
  //  (frontmatter 뒤 = 로더 무영향, HTML 주석 = 렌더 무영향, 한 줄 = 노이즈 최소).
  return `---\n${lines.join("\n")}\n---\n\n<!-- ${PROVENANCE} -->\n\n${asset.body || ""}\n`;
}

async function fetchAssets() {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/assets?harness=${encodeURIComponent(HARNESS)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}`, ...SCOPE_HDRS } });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.assets) ? j.assets : [];
  } catch { return null; }
  finally { clearTimeout(t); }
}

function loadManifest() {
  try { const m = JSON.parse(readFileSync(MANIFEST, "utf8")); return (m && typeof m === "object") ? m : {}; }
  catch { return {}; }
}
function saveManifest(m) {
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(MANIFEST, JSON.stringify(m, null, 2), { mode: 0o600 }); } catch { /* fail-soft */ }
}

// 경로가 root 아래인지(containment). 심링크 통과는 별도 lstat 로 거부.
//  ⚠ 문자열 prefix 검사(`root + "/"`)를 쓰면 **윈도우에서 항상 false** 다 — path.join 이 `\` 로 만드는데
//   `/` 로 끝나는 접두사를 찾기 때문. 그러면 writeAsset 이 전부 조기 반환해 **조직 자산이 한 개도 안 깔린다**
//   (게다가 그 분기는 stderr 도 안 내서 매 세션 조용히 실패한다 — 윈도우 실기기에서 자산 0개로 실측).
//   path.relative 로 판정하면 구분자·드라이브 문자·대소문자를 path 모듈이 플랫폼에 맞게 처리한다.
export function within(root, p) {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
// 대상 파일/디렉터리 경로 중 하나라도 심링크면 true(멤버 파일 탈취·트리 밖 write 방지).
function anySymlink(paths) {
  for (const p of paths) { try { if (lstatSync(p).isSymbolicLink()) return true; } catch { /* 없음=OK */ } }
  return false;
}

// 자산 1개 materialize(변경 시에만 write). prevEntry=이전에 lively 가 심은 매니페스트 엔트리(있으면). 반환: {ok, changed, entry} | {ok:false}(skip).
function writeAsset(asset, prevEntry) {
  const id = String(asset.id || "").trim().toLowerCase();
  if (!SLUG.test(id)) return { ok: false }; // 서버가 검증하지만 2차 방어(경로 traversal 차단)
  const kind = asset.kind;
  const place = placement(kind, id);
  if (!place) return { ok: false, unsupported: true, id, kind }; // codex subagent/command 등 미지원
  const file = place.file;
  const root = place.root;
  if (!within(root, file)) return { ok: false }; // containment 위반(있을 수 없지만 방어)
  // 심링크 거부 — 파일 자신 + 스킬 디렉터리(있으면)
  if (anySymlink([file, place.skillDir].filter(Boolean))) return { ok: false, symlink: true, id };
  // ★ 비파괴① — lively 가 심지 않은 기존 파일(멤버 본인 자산)은 절대 덮지 않는다. 슬러그 충돌(admin id == 멤버 로컬 스킬 id)
  //  시 org 자산을 그 멤버엔 미배포하고 멤버 파일을 보존한다(managed=매니페스트에 이 id 가 있었나 = lively 소유였나).
  const managed = !!prevEntry;
  if (!managed && existsSync(file)) return { ok: false, collision: true, id };

  const content = composeFile(asset);
  const entry = { kind, hash: asset.content_hash || "", file };
  // content_hash 동일 + 파일 존재 = 변경 없음(재작성 skip)
  if (prevEntry?.hash && prevEntry.hash === entry.hash && existsSync(file)) return { ok: true, changed: false, entry };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o644 });
    return { ok: true, changed: true, entry };
  } catch { return { ok: false }; }
}

// 회수 허용 경로 — 전 하네스의 자산 디렉터리명 합집합(skills·agents·commands·prompts·skill·agent·command …).
const ASSET_DIR_RE = new RegExp(`[/\\\\](${[...assetDirNames()].join("|")})[/\\\\]`);

// 자산 제거(매니페스트에 있으나 desired 에 없음) — 그 파일만 삭제, 빈 스킬 디렉터리 정리.
function removeAsset(entry) {
  try {
    const f = entry.file;
    // 방어 — 매니페스트가 변조돼도 자산 디렉터리 밖 파일은 절대 삭제하지 않는다.
    //  ⚠ 목록은 **표에서 파생**한다(손으로 적지 않는다) — 새 하네스의 디렉터리명을 빠뜨리면 회수(prune)가
    //   조용히 안 돌아 '중앙에서 지운 자산이 멤버 디스크에 영원히 남는' 결함이 된다.
    if (!f || !ASSET_DIR_RE.test(f)) return;
    if (!lstatSyncIsSymlink(f)) { try { rmSync(f, { force: true }); } catch { /* */ } }
    // 스킬은 <root>/<id>/SKILL.md 구조 → 부모 디렉터리가 비면 제거(rmdirSync=빈 디렉터리 전용, 비었을 때만 성공)
    if (entry.kind === "skill") {
      const d = dirname(f);
      try { if (existsSync(d) && !lstatSync(d).isSymbolicLink() && readdirSync(d).length === 0) rmdirSync(d); } catch { /* 비-빈/경합 시 보존 */ }
    }
  } catch { /* fail-soft */ }
}
function lstatSyncIsSymlink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

// Claude 는 SessionStart 훅 완료 후 skills/commands 재스캔(같은 세션 반영). 변경 시에만 발화.
function emitReload() {
  if (!harness(HARNESS).reloadAssets) return; // 동적 재로드 미지원(codex·opencode 는 재시작) — 무출력
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true } }) + "\n");
}

// ── 로컬 하네스 인벤토리 관측·보고(#891 온보딩 C) — 웹에서 로컬↔라이블리 하네스를 한눈에 보게 한다. ──
//  ⚠ **메타만**(id·kind·managed) push — 스킬 본문·메모리는 절대 안 읽는다(사생활·용량). managed = 매니페스트에
//   이 id 가 있나(=라이블리가 심음). 매니페스트에 없는 = 그 사람 자산(shadow 후보). 실패는 조용히 삼킨다(관측이라 비치명).
// 사용자 **자체** 훅 관측(#893 후속) — ~/.claude/settings.json 의 hooks 중 라이블리 배선(.lively/) 아닌 것만.
//  라이블리 훅은 파일이 아니라 run-custom 중앙 디스패치라 여기선 안 센다(웹은 '배선된 PC=전부 실행'으로 다룬다).
//  훅은 settings.json 항목이지 파일이 아니므로 managed=false 표시전용(비파괴 .disabled 토글 대상 아님).
// codex 자체 훅 관측 — ~/.codex/config.toml 의 [[hooks.<E>.hooks]] 중 **라이블리 배선이 아닌 것**만.
//  라이블리 배선은 ① 관리 센티넬 블록 안이거나 ② command 가 .lively/hooks 를 가리킨다 — 둘 다 뺀다.
//  TOML 파서를 들이지 않는다(이 훅의 계약 = 런타임 의존 0). 관측·표시 전용이라 정규식으로 충분하고, 틀려도
//  웹 목록에 한 줄이 더/덜 보일 뿐 배포·회수엔 영향이 없다(claude 쪽 scanLocalHooks 와 같은 성격).
//  ⚠ 센티넬 리터럴은 setup/user-install.mjs·user-uninstall.mjs 와 **정확히 같아야** 한다.
const CDX_BEGIN = "# >>> lively-managed (auto-generated by workflow-std/adapters/codex — do not edit) >>>";
const CDX_END = "# <<< lively-managed <<<";
function scanLocalHooksCodex() {
  let raw;
  try { raw = readFileSync(join(CODEX_DIR, "config.toml"), "utf8"); } catch { return []; }
  const bi = raw.indexOf(CDX_BEGIN);
  if (bi !== -1) {
    const ei = raw.indexOf(CDX_END, bi);
    raw = raw.slice(0, bi) + (ei === -1 ? "" : raw.slice(ei + CDX_END.length));
  }
  const out = [], seen = new Set();
  // [[hooks.<E>.hooks]] 헤더부터 다음 테이블 헤더 전까지가 한 핸들러 블록.
  const blocks = /\[\[hooks\.([A-Za-z]+)\.hooks\]\]([\s\S]*?)(?=\n[ \t]*\[|$)/g;
  let m;
  while ((m = blocks.exec(raw))) {
    const event = m[1];
    const cm = /(^|\n)[ \t]*command[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(m[2]);
    if (!cm) continue;
    const lit = cm[2];
    let cmd = lit;
    try { cmd = lit.startsWith("'") ? lit.slice(1, -1) : JSON.parse(lit); } catch { /* 원문 그대로 */ }
    if (!cmd || cmd.includes(".lively/") || cmd.includes(".lively\\")) continue; // 라이블리 배선분 제외 = 내 것만
    const tok = cmd.replace(/["']/g, "").split(/\s+/).find((t) => /[\\/]/.test(t) && !t.startsWith("-")) || cmd.split(/\s+/)[0] || "hook";
    const base = (tok.split(/[\\/]/).pop() || tok).slice(0, 40);
    let id = `${event}:${base}`.slice(0, 60);
    while (seen.has(id)) id = id.length < 62 ? id + "~" : id.slice(0, -1) + "~";
    seen.add(id);
    out.push({ id, kind: "hook", managed: false });
  }
  return out;
}

function scanLocalHooks() {
  if (HARNESS === "codex") return scanLocalHooksCodex();
  // settings-merge(claude) 가 아닌 하네스(opencode·antigravity)는 claude settings 를 읽으면 **남의 하네스 훅**을
  //  이 하네스 것으로 잘못 보고한다 — 로컬 훅 스캐너가 없는 하네스는 정직하게 빈 목록(#1689, 종전엔 opencode 가
  //  이 폴스루로 claude settings 를 읽었다).
  if (harness(HARNESS).wiring !== "settings-merge") return [];
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8")); } catch { return []; }
  const hooksCfg = cfg && typeof cfg === "object" ? cfg.hooks : null;
  if (!hooksCfg || typeof hooksCfg !== "object") return [];
  const out = [], seen = new Set();
  for (const [event, groups] of Object.entries(hooksCfg)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const hs = g && Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of hs) {
        const cmd = h && typeof h.command === "string" ? h.command : "";
        if (!cmd || cmd.includes(".lively/")) continue; // 라이블리 배선분 제외 = 내 것만
        // 읽기 쉬운 id: <event>:<명령 요약(스크립트 basename)>. 길이/중복 가드.
        const tok = cmd.replace(/["']/g, "").split(/\s+/).find((t) => /[\\/]/.test(t) && !t.startsWith("-")) || cmd.split(/\s+/)[0] || "hook";
        const base = (tok.split(/[\\/]/).pop() || tok).slice(0, 40);
        let id = `${event}:${base}`.slice(0, 60);
        while (seen.has(id)) id = id.length < 62 ? id + "~" : id.slice(0, -1) + "~";
        seen.add(id);
        out.push({ id, kind: "hook", managed: false });
      }
    }
  }
  return out;
}

// 하네스별 자산 디렉터리 — [kind, root, isDir, ext]. isDir=true 면 <root>/<id>/(스킬), 아니면 <root>/<id><ext>.
//  ⚠ placement() 와 **짝을 맞춰야** 한다 — 여기 빠진 종류는 관측(#891)·로컬토글에서 통째로 안 보이고,
//   claude 는 전부 .md 지만 codex 서브에이전트만 .toml 이라 확장자를 하드코딩하면 스캔이 조용히 0건이 된다.
function assetDirs() {
  return assetDirsFor(HARNESS, HOME);
}

function scanLocalAssets(managedIds) {
  const out = [];
  for (const [kind, root, isDir, ext] of assetDirs()) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; } // 디렉터리 없음 = 자산 0
    for (const e of entries) {
      // skill = <root>/<id>/SKILL.md(디렉터리) · 그 외 = <root>/<id><ext>(파일). .disabled 접미사는 무시(비활성분).
      let id = null;
      if (isDir) { if (e.isDirectory() && !e.name.endsWith(".disabled")) id = e.name; }
      else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(ext)) id = e.name.slice(0, -ext.length);
      if (!id || !SLUG.test(id)) continue;
      out.push({ id, kind, managed: managedIds.has(id) });
    }
  }
  for (const h of scanLocalHooks()) out.push(h); // 자체 훅(표시전용)
  return out;
}

async function reportLocalInventory(managedIds) {
  try {
    const assets = scanLocalAssets(managedIds);
    let host; try { host = hostname(); } catch { /* 무명 */ }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch(`${GW}/api/ui/me/harness-report`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Authorization": `Bearer ${TOKEN}`, ...SCOPE_HDRS, "Content-Type": "application/json" },
      body: JSON.stringify({ harness: HARNESS, host, machine_id: machineId(), assets }),
    }).catch(() => {});
    clearTimeout(t);
  } catch { /* 관측 실패는 비치명 — 배포/정리에 영향 없음 */ }
}

// 웹에서 이 머신에 대해 끄기로 지시한 로컬 파일을 .disabled 로 rename(#891 슬라이스 2) — 비파괴(원본 보존).
//  다시 켜기(지시 해제 or false)면 .disabled 를 원복. 라이블리 managed 자산은 대상 아님(그건 me_asset_pref).
async function applyLocalPref() {
  try {
    const mid = machineId();
    if (!mid) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${GW}/api/ui/me/harness-local-pref/plan?machine_id=${encodeURIComponent(mid)}`, {
      signal: ctrl.signal, headers: { "Authorization": `Bearer ${TOKEN}`, ...SCOPE_HDRS },
    }).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) return; // 계획 못 받으면 아무것도 안 함(fail-safe — 사용자 파일 안 건드림)
    const plan = await res.json().catch(() => null);
    if (!plan || !Array.isArray(plan.disabled)) return;
    const wantDisabled = new Set(plan.disabled.map((x) => `${x.kind}:${x.id}`)); // 꺼야 할 것
    // 현재 로컬을 훑어 지시대로 맞춘다 — 켜진 파일 중 꺼야 할 건 .disabled 로, 꺼진 것 중 켜야 할 건 복원.
    for (const [kind, root, isDir, ext] of assetDirs()) {
      let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const base = e.name.endsWith(".disabled") ? e.name.slice(0, -".disabled".length) : e.name;
        const id = isDir ? base : (base.endsWith(ext) ? base.slice(0, -ext.length) : null);
        if (!id || !SLUG.test(id)) continue;
        const key = `${kind}:${id}`;
        const isOff = e.name.endsWith(".disabled");
        const shouldOff = wantDisabled.has(key);
        if (shouldOff && !isOff) { try { renameSync(join(root, e.name), join(root, e.name + ".disabled")); } catch { /* skip */ } }
        else if (!shouldOff && isOff) { try { renameSync(join(root, e.name), join(root, base)); } catch { /* skip */ } }
      }
    }
  } catch { /* 비치명 */ }
}

async function main() {
  if (hookDisabled()) return;
  if (!TOKEN) return;
  const assets = await Promise.race([fetchAssets(), new Promise((r) => setTimeout(() => r(null), HARD_MS))]);
  if (assets === null) return; // fetch 실패/타임아웃 → fail-OPEN(현상 유지, prune 안 함)

  const manifest = loadManifest();
  const prev = (manifest[HARNESS] && typeof manifest[HARNESS] === "object") ? manifest[HARNESS] : {};
  const next = {};
  let changed = false;
  const desiredIds = new Set();

  for (const a of assets) {
    const id = String(a?.id || "").trim().toLowerCase();
    if (!SLUG.test(id)) continue;
    desiredIds.add(id); // 게이트웨이가 이 멤버에게 원하는 자산(써졌든 아니든)
    const res = writeAsset(a, prev[id]);
    if (res.ok) { next[id] = res.entry; if (res.changed) changed = true; }
    else if (res.collision) process.stderr.write(`[lively] 자산 '${id}' — 동명의 로컬 파일이 이미 있어 배포 생략(멤버 자산 보존)\n`);
    // res.ok=false(미지원 codex·심링크·충돌·일시 write 실패): next 에 안 넣지만 desiredIds 에 있어 prune 안 됨(멤버 파일 보존·다음 세션 재시도).
  }
  // desired 지만 이번에 (재)작성 안 됨(일시 실패 등) → 소유권 유지 위해 이전 매니페스트 엔트리 보존(파일 prune 방지).
  for (const id of Object.keys(prev)) if (desiredIds.has(id) && !next[id]) next[id] = prev[id];
  // prune — 게이트웨이가 더는 원치 않는 것(회수/비활성/타깃 제외)만 제거. fetch 성공했을 때만 도달(fail-OPEN).
  for (const id of Object.keys(prev)) if (!desiredIds.has(id)) { removeAsset(prev[id]); delete next[id]; changed = true; }
  manifest[HARNESS] = next;
  saveManifest(manifest);
  if (changed) emitReload();

  // 웹 토글 지시 반영(#891 슬라이스 2) — 이 머신에서 끄기로 한 로컬 파일을 .disabled rename(비파괴).
  //  ⚠ 관측 push 보다 **먼저** — 그래야 rename 결과가 반영된 상태로 인벤토리가 올라간다(웹이 최신 상태를 봄).
  await applyLocalPref();
  // 배포·정리가 끝난 뒤 로컬 인벤토리를 관측·보고(#891) — managed = 방금 확정한 매니페스트 소유분.
  //  이 자산 종류들(claude 하네스 파일 자산)만 push; org_hook(파일 아님)은 서버가 이미 안다.
  await reportLocalInventory(new Set(Object.keys(next)));
}

try { await Promise.race([main(), new Promise((r) => setTimeout(r, HARD_MS + 500))]); } catch { /* fail-open */ }
process.exit(0);
