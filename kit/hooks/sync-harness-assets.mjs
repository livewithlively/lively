#!/usr/bin/env node
// SessionStart 훅 — 조직 하네스 자산(스킬·서브에이전트·슬래시커맨드)을 게이트웨이에서 받아 멤버 하네스
// 디스크에 **비파괴 materialize** 한다. 훅(run-custom)과 결정적으로 다른 점: 하네스가 디스크를 '스캔'해야
// 자산을 발견하므로(name+description 상시광고, 본문 온디맨드) 본문을 파일로 굳힌다 — 훅처럼 임시실행·삭제가 아니다.
//
//   Claude:  skill→ ~/.claude/skills/<id>/SKILL.md · subagent→ ~/.claude/agents/<id>.md · command→ ~/.claude/commands/<id>.md
//   Codex:   skill→ ~/.codex/skills/<id>/SKILL.md (스킬은 Agent Skills 오픈표준 = Claude 와 동일 파일).
//            subagent(.toml translator)·command(prompts deprecated)는 후속 — 이 스크립트는 skip+경고 로깅.
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
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";

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

const HARNESS = (() => {
  const i = process.argv.indexOf("--harness");
  return ((i > -1 ? process.argv[i + 1] : "") || process.env.LIVELY_HARNESS || "").toLowerCase();
})() || "claude"; // 미설정=claude 기본(session-preload 와 동일 규약)

function hookDisabled() {
  try {
    const c = JSON.parse(readFileSync(join(LIVELY, "hooks-config.json"), "utf8"));
    return !!(c && c.hooks && c.hooks.sync_harness_assets === false);
  } catch { return false; }
}

const TOKEN = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
const GW = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080").replace(/\/$/, "");

// ── 대상 하네스별 자산 배치 규약 ──
// 반환: { dir(자산 루트), file(절대경로), extraDirs(정리 대상 상위 디렉터리) } 또는 null(미지원=skip).
function placement(kind, id) {
  if (HARNESS === "codex") {
    if (kind === "skill") return { file: join(CODEX_DIR, "skills", id, "SKILL.md"), skillDir: join(CODEX_DIR, "skills", id), root: join(CODEX_DIR, "skills") };
    return null; // codex subagent(.toml)·command(prompts deprecated) — 후속과업
  }
  // claude(및 미설정 기본)
  if (kind === "skill") return { file: join(CLAUDE_DIR, "skills", id, "SKILL.md"), skillDir: join(CLAUDE_DIR, "skills", id), root: join(CLAUDE_DIR, "skills") };
  if (kind === "subagent") return { file: join(CLAUDE_DIR, "agents", `${id}.md`), root: join(CLAUDE_DIR, "agents") };
  if (kind === "command") return { file: join(CLAUDE_DIR, "commands", `${id}.md`), root: join(CLAUDE_DIR, "commands") };
  return null;
}

// YAML frontmatter 방출 — 값은 문자열(JSON 이중따옴표=유효 YAML flow scalar)·불리언·숫자·문자열배열.
//  항상 JSON.stringify 문자열 → `:`·개행·한글 등 특수문자 안전(모호성 0). 관리 파일이라 가독성보다 정확성 우선.
function yamlValue(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map((e) => JSON.stringify(String(e))).join(", ") + "]";
  return JSON.stringify(String(v ?? ""));
}
function composeFile(asset) {
  const fm = (asset.frontmatter && typeof asset.frontmatter === "object" && !Array.isArray(asset.frontmatter)) ? asset.frontmatter : {};
  const ordered = [];
  const seen = new Set();
  const push = (k, v) => { if (!seen.has(k)) { ordered.push([k, v]); seen.add(k); } };
  push("name", fm.name != null ? fm.name : asset.id);          // frontmatter.name 우선, 없으면 id
  push("description", asset.description != null ? asset.description : (fm.description ?? "")); // description 컬럼이 진실원천
  for (const k of Object.keys(fm)) if (k !== "name" && k !== "description") push(k, fm[k]);
  const lines = ordered.map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${asset.body || ""}\n`;
}

async function fetchAssets() {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/assets?harness=${encodeURIComponent(HARNESS)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}` } });
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

// 경로가 root 아래인지(containment) — 정규화 후 prefix 검사. 심링크 통과는 별도 lstat 로 거부.
function within(root, p) {
  const r = root.endsWith("/") ? root : root + "/";
  return p === root || p.startsWith(r);
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

// 자산 제거(매니페스트에 있으나 desired 에 없음) — 그 파일만 삭제, 빈 스킬 디렉터리 정리.
function removeAsset(entry) {
  try {
    const f = entry.file;
    // 방어 — 매니페스트가 변조돼도 자산 경로 패턴(.../{skills,agents,commands}/...) 밖 파일은 절대 삭제하지 않는다.
    if (!f || !/[/\\](skills|agents|commands)[/\\]/.test(f)) return;
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
  if (HARNESS === "codex") return; // Codex 는 reloadSkills 미지원(재시작/자체 감지) — 무출력
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true } }) + "\n");
}

// ── 로컬 하네스 인벤토리 관측·보고(#891 온보딩 C) — 웹에서 로컬↔라이블리 하네스를 한눈에 보게 한다. ──
//  ⚠ **메타만**(id·kind·managed) push — 스킬 본문·메모리는 절대 안 읽는다(사생활·용량). managed = 매니페스트에
//   이 id 가 있나(=라이블리가 심음). 매니페스트에 없는 = 그 사람 자산(shadow 후보). 실패는 조용히 삼킨다(관측이라 비치명).
function scanLocalAssets(managedIds) {
  const out = [];
  const dirs = HARNESS === "codex"
    ? [["skill", join(CODEX_DIR, "skills"), true]]
    : [["skill", join(CLAUDE_DIR, "skills"), true], ["subagent", join(CLAUDE_DIR, "agents"), false], ["command", join(CLAUDE_DIR, "commands"), false]];
  for (const [kind, root, isDir] of dirs) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; } // 디렉터리 없음 = 자산 0
    for (const e of entries) {
      // skill = <root>/<id>/SKILL.md(디렉터리) · subagent·command = <root>/<id>.md(파일). .disabled 접미사는 무시(비활성분).
      let id = null;
      if (isDir) { if (e.isDirectory() && !e.name.endsWith(".disabled")) id = e.name; }
      else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md")) id = e.name.slice(0, -3);
      if (!id || !SLUG.test(id)) continue;
      out.push({ id, kind, managed: managedIds.has(id) });
    }
  }
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
      headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ harness: HARNESS, host, assets }),
    }).catch(() => {});
    clearTimeout(t);
  } catch { /* 관측 실패는 비치명 — 배포/정리에 영향 없음 */ }
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

  // 배포·정리가 끝난 뒤 로컬 인벤토리를 관측·보고(#891) — managed = 방금 확정한 매니페스트 소유분.
  //  이 자산 종류들(claude 하네스 파일 자산)만 push; org_hook(파일 아님)은 서버가 이미 안다.
  await reportLocalInventory(new Set(Object.keys(next)));
}

try { await Promise.race([main(), new Promise((r) => setTimeout(r, HARD_MS + 500))]); } catch { /* fail-open */ }
process.exit(0);
