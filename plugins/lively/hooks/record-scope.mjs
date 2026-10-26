// ═══════════════════════════════════════════════════════════════════════════
// 기록 범위 (#5016) — «이 세션을 연 폴더에서 라이블리를 켤까» 를 정하는 **단 한 곳**.
// ═══════════════════════════════════════════════════════════════════════════
//
// 왜 (#5016, 알파컷 요청 2026-10-26): 훅·MCP 가 사용자 범위로 깔려 있어 **어느 폴더에서 켠 AI 든** 라이블리가 붙었다.
//  팀원이 개인 폴더에서 한 말이 첫 지시 프로젝트·지식·대화 기록으로 팀 워크스페이스에 올라갔다. 그래서 컴퓨터마다
//  «작업 폴더에서만(기본) | 어디서나» 를 고르고, 작업 폴더 밖에서 켠 세션은 인코그니토와 똑같이 둔다.
//
// 누가 쓰나 — 판정이 갈리면 «도구는 있는데 훅은 꺼진» 반쪽 세션이 생기므로 전부 이 파일을 쓴다:
//   훅: session-preload(설정 받기·알림) · run-custom · work-flag · stop-writeback-gate · sync-harness-assets
//   MCP 프록시: `lively mcp`(lively-mcp-gateway.mjs) · `lively mcp-local` — ../hooks/record-scope.mjs 로 찾아온다
//   CLI: `lively work-root` · `lively scope` · 설치기(user-install 의 사본 시드) · 플러그인 헤더 도우미
//  설치 자리는 ~/.lively/hooks/record-scope.mjs 하나다(키트 HOOK_SCRIPTS). 프록시(~/.lively/lib/)는 상대경로로 온다.
//
// 판정(위에서부터 처음 맞는 것):
//   ① 라이블리가 띄운 세션 — 켬. 웹·노드가 띄운 것(LIVELY_SESSION_ID — 폴더는 게이트웨이가 골랐다)과 사람이 `lively run` 으로
//      띄운 것(LIVELY_RUN=1 — 라이블리로 켜겠다고 고른 것, 상민님 2026-10-26). 모드(읽기만·인코그니토)는 띄울 때 정한 대로 간다.
//   ② 이 컴퓨터 설정 사본이 아직 없다 — 켬(종전 동작). 아래 «설정 사본» 참고.
//   ③ 이 컴퓨터의 기록 범위가 «어디서나» — 켬.
//   ④ 세션 폴더나 그 위에 라이블리 프로젝트 표식(.lively/project.json — project_id 가 든 것)이 있다 — 켬.
//      `lively work` 의 ~/lively/projects/<번호> · 노드가 받은 공유폴더 ~/workspace/project/<번호> · `lively project init` 한 폴더.
//   ⑤ 세션 폴더가 등록한 작업 폴더와 같거나 그 아래 — 켬. 목록 = 이 컴퓨터 설정 ∪ ~/.lively/work-roots(설치 시드·손 편집) ∪ env.
//   ⑥ 그 밖 — 끔.
//
// 설정 사본: ~/.lively/record-scope.json — 이 컴퓨터 설정의 **로컬 사본**(정본은 서버 org_member.local_scope_pref[machine_id]).
//   설치기·세션 시작 훅(session-preload)이 서버와 맞추고(syncScopeSettings), 나머지는 이 파일만 읽는다(네트워크 0).
//   ⚠ 사본이 **없으면**(설치 시드가 오프라인이었음 · 구 게이트웨이 · 테스트) 종전 동작이다. 서버 기본값이 «작업 폴더에서만» 이라
//    한 번이라도 받아 오면 그때부터 판정이 걸린다 — 받기 전에 전부 끄면 오프라인 한 번에 라이블리가 영영 안 붙는 세션이 생기고,
//    그걸 되살릴 길(이 파일)을 받는 것도 그 세션이다.
//   ⚠ 사본이 **깨졌으면**(읽히지만 모양이 틀림) «작업 폴더에서만» 으로 본다 — 한 번 받은 적이 있다는 뜻이라 닫는 쪽이 맞고,
//    다음 세션 시작이 서버 값으로 덮는다.
//   바꾼 것은 먼저 pending 에 합치고(같은 키는 나중 것이 이긴다) 그 묶음을 서버에 올린다 — 올리기 성공분만 pending 에서 걷는다.
//
// 세션 폴더(sessionDirOf): «AI 를 켠 자리» 다. 세션 중에 AI 가 cd 해도 바뀌지 않아야 판정이 흔들리지 않는다.
//   LIVELY_SESSION_DIR(어댑터가 실음) > CLAUDE_PROJECT_DIR(클로드가 훅·MCP 에 싣는 시작 폴더) > 훅 입력 cwd > 프로세스 cwd.
//
// 이 파일은 네트워크를 직접 부르지 않는다 — 서버 왕복은 호출자가 넘긴 send(HostEffects fetch)로만 한다(kit R5).
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, sep, delimiter, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export const SCOPES = ["work_folders", "anywhere"];
export const DEFAULT_SCOPE = "work_folders";
export const SETTINGS_FILE = "record-scope.json";
const LEGACY_ROOTS_FILE = "work-roots";
const WIN = process.platform === "win32";
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// 작업 폴더 경로 한 줄·한 컴퓨터 목록의 상한 — 서버(src/org/store/members.ts MAX_WORK_ROOT_LEN · MAX_WORK_ROOTS)와 같은 값이어야
//  한다(record-scope.test.mjs 가 두 파일을 읽어 맞춰 본다).
export const MAX_ROOT_LEN = 1000;
export const MAX_ROOTS = 200;
// 프로젝트 표식을 찾아 올라가는 깊이 — kit/cli/repo-worktree-core.mjs findProjectMarkerUp 과 같은 계약(40).
const MARKER_DEPTH = 40;

/** ~/.lively 자리. 훅마다 HOME 계산이 조금씩 달라(LIVELY_HOME 을 보는 것·안 보는 것) 호출자가 넘기는 게 정본이다. */
export const livelyDirOf = (env = process.env) => join(env.LIVELY_HOME || homedir(), ".lively");

/** 세션 폴더 — 위 머리말의 우선순위. harness 는 훅 인자(--harness) 또는 LIVELY_HARNESS(없으면 claude). */
export function sessionDirOf({ env = process.env, input = null, cwd = process.cwd(), harness = "" } = {}) {
  const pick = (v) => String(v ?? "").trim();
  const h = (pick(harness) || pick(env.LIVELY_HARNESS) || "claude").toLowerCase();
  if (pick(env.LIVELY_SESSION_DIR)) return pick(env.LIVELY_SESSION_DIR);
  //  클로드가 아닌 하네스가 클로드 세션 안에서 떴으면 CLAUDE_PROJECT_DIR 는 부모의 것이다 — 클로드일 때만 먼저 본다.
  if (h === "claude" && pick(env.CLAUDE_PROJECT_DIR)) return pick(env.CLAUDE_PROJECT_DIR);
  if (input && typeof input === "object" && pick(input.cwd)) return pick(input.cwd);
  if (h === "cursor" && pick(env.CURSOR_PROJECT_DIR)) return pick(env.CURSOR_PROJECT_DIR);
  return pick(cwd);
}

// ── 경로 ─────────────────────────────────────────────────────────────────────
/** `~`·`~/…` 를 홈으로 편다 — 조직이 사람마다 다른 홈에 같은 한 줄(~/alphacut)을 줄 수 있게. */
export function expandHome(p, home) {
  const s = String(p ?? "").trim();
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
  return s;
}
/** 등록할 수 있는 꼴인가 — 절대경로 또는 `~` 로 시작(그 컴퓨터 홈 기준). 상대경로는 훅·프록시의 cwd 에 묶여 뜻이 흔들린다. */
export function isRootForm(p) {
  const s = String(p ?? "").trim();
  return s === "~" || s.startsWith("~/") || s.startsWith("~\\") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
}
const strip = (p) => (p.length > 1 && (p.endsWith("/") || p.endsWith("\\")) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p);
/** 비교용 정규화 — 절대경로·끝 구분자 제거·윈도우는 대소문자 무시. */
export function normPath(p) {
  const r = strip(resolve(String(p)));
  return WIN ? r.toLowerCase() : r;
}
/** dir 가 root 와 같거나 그 아래인가 — 경계는 구분자(/a/alpha 가 /a/alphacut 을 품지 않는다). */
export function underRoot(dir, root) {
  const c = normPath(dir), r = normPath(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

/** 세션 폴더나 그 위의 라이블리 프로젝트 표식(.lively/project.json). 홈의 .lively 는 키트 자리라 표식으로 안 본다.
 *  표식은 project_id 가 든 JSON 이어야 인정한다(repo-worktree-core 와 같은 계약) — 아니면 계속 위로 간다. */
export function findProjectMarker(dir, home) {
  let d = resolve(String(dir));
  const h = home ? normPath(home) : null;
  for (let i = 0; i < MARKER_DEPTH; i++) {
    if (!(h && normPath(d) === h)) {
      const f = join(d, ".lively", "project.json");
      if (existsSync(f)) {
        try {
          const j = JSON.parse(readFileSync(f, "utf8"));
          const id = j && typeof j === "object" ? j.project_id : null;
          if ((typeof id === "number" && id > 0) || (typeof id === "string" && id.trim())) return f;
        } catch { /* 깨진 표식 — 표식으로 안 보고 위로 */ }
      }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// ── 설정 사본(~/.lively/record-scope.json) ───────────────────────────────────
const isScope = (v) => SCOPES.includes(v);
function cleanRoots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (s && s.length <= MAX_ROOT_LEN && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_ROOTS);
}
function cleanPending(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out = {};
  if (isScope(p.scope)) out.scope = p.scope;
  const add = cleanRoots(p.add), remove = cleanRoots(p.remove);
  if (add.length) out.add = add;
  if (remove.length) out.remove = remove;
  return Object.keys(out).length ? out : null;
}

/** 사본의 상태 — 없음(missing) · 깨짐(corrupt — 읽히지만 모양이 틀림) · 정상(ok). */
export function scopeFileState(lively) {
  let raw;
  try { raw = readFileSync(join(lively, SETTINGS_FILE), "utf8"); }
  catch (e) { return { state: e && e.code === "ENOENT" ? "missing" : "corrupt", file: null }; }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j) || !isScope(j.scope)) return { state: "corrupt", file: null };
    return { state: "ok", file: { scope: j.scope, work_roots: cleanRoots(j.work_roots), updated_at: typeof j.updated_at === "string" ? j.updated_at : "",
      synced_at: typeof j.synced_at === "string" ? j.synced_at : "", pending: cleanPending(j.pending) } };
  } catch { return { state: "corrupt", file: null }; }
}

/** 파일 그대로(서버 상태 + pending). 없거나 깨졌으면 null. */
export const readScopeFile = (lively) => scopeFileState(lively).file;

/** 같은 폴더인지 견줄 열쇠 — `~/x` 와 그 절대경로를 같은 것으로 본다. */
export const rootKey = (p, home) => normPath(expandHome(p, home));

/** 판정에 쓰는 값 — 서버 상태 위에 아직 못 올린 변경(pending)을 얹는다.
 *  사본이 없으면 null(= 종전 동작), 깨졌으면 «작업 폴더에서만 · 빈 목록»(머리말 참고). */
export function effectiveSettings(lively) {
  const st = scopeFileState(lively);
  if (st.state === "missing") return null;
  if (st.state === "corrupt") return { scope: DEFAULT_SCOPE, work_roots: [], updated_at: "", synced_at: "", pending: null, corrupt: true };
  const f = st.file;
  const home = dirname(lively);
  const p = f.pending || {};
  const removed = (x) => (p.remove || []).some((r) => rootKey(r, home) === rootKey(x, home));
  const roots = [...f.work_roots, ...(p.add || [])]
    .filter((x, i, a) => !removed(x) && a.findIndex((y) => rootKey(y, home) === rootKey(x, home)) === i);
  return { scope: p.scope || f.scope, work_roots: roots, updated_at: f.updated_at, synced_at: f.synced_at, pending: f.pending };
}

export function writeScopeFile(lively, data) {
  mkdirSync(lively, { recursive: true });
  const body = { scope: isScope(data.scope) ? data.scope : DEFAULT_SCOPE, work_roots: cleanRoots(data.work_roots),
    updated_at: data.updated_at || "", synced_at: data.synced_at || "", ...(cleanPending(data.pending) ? { pending: cleanPending(data.pending) } : {}) };
  // 쓰는 도중에 다른 훅이 읽어도 반쪽 JSON 을 보지 않게 — 같은 폴더의 임시 파일에 쓰고 이름을 바꾼다.
  const tmp = join(lively, `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, join(lively, SETTINGS_FILE));
  return body;
}

/** 서버 응답 하나를 사본으로 굳힌다. pending 은 호출자가 정한다. */
export function recordServerState(lively, pref, pending = null) {
  return writeScopeFile(lively, { scope: pref.scope, work_roots: pref.work_roots, updated_at: pref.updated_at || "",
    synced_at: new Date().toISOString(), pending });
}

/** 못 올린 변경을 합친다 — 같은 경로를 넣었다 뺐으면 서로 지우고, scope 는 나중 것이 이긴다. 파일이 없으면 기본값 위에 만든다. */
export function addPending(lively, { scope, add = [], remove = [] } = {}) {
  const f = readScopeFile(lively) || { scope: DEFAULT_SCOPE, work_roots: [], updated_at: "", synced_at: "", pending: null };
  return writeScopeFile(lively, { ...f, pending: mergePending(f.pending, { scope, add, remove }, dirname(lively)) });
}
function mergePending(base, { scope, add = [], remove = [] }, home) {
  const p = { ...(base || {}) };
  const same = (a) => (b) => rootKey(a, home) === rootKey(b, home);
  for (const a of add) { p.remove = (p.remove || []).filter((x) => !same(a)(x)); if (!(p.add || []).some(same(a))) p.add = [...(p.add || []), a]; }
  for (const r of remove) { p.add = (p.add || []).filter((x) => !same(r)(x)); if (!(p.remove || []).some(same(r))) p.remove = [...(p.remove || []), r]; }
  if (isScope(scope)) p.scope = scope;
  return cleanPending(p);
}
/** 올리기에 성공한 묶음(posted)을 지금 pending 에서 걷는다 — 그 사이 새로 쌓인 것(다른 프로세스의 CLI)은 남는다. */
function withoutPosted(current, posted, home) {
  if (!current) return null;
  if (!posted) return current;
  const same = (a, b) => rootKey(a, home) === rootKey(b, home);
  const out = { ...current };
  if (posted.scope && out.scope === posted.scope) delete out.scope;
  if (out.add) out.add = out.add.filter((x) => !(posted.add || []).some((y) => same(x, y)));
  if (out.remove) out.remove = out.remove.filter((x) => !(posted.remove || []).some((y) => same(x, y)));
  return cleanPending(out);
}

/** ~/.lively/work-roots(설치 시드·손 편집) 줄 목록. 주석·빈 줄 제외. */
export function legacyRoots(lively) {
  try {
    return readFileSync(join(lively, LEGACY_ROOTS_FILE), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch { return []; }
}

/** 작업 폴더 목록(펼친 절대경로) — 이 컴퓨터 설정 ∪ work-roots 파일 ∪ LIVELY_WORK_ROOTS. 상대경로 줄은 버린다. */
export function workRootsOf(lively, settings, env = process.env) {
  const home = dirname(lively);
  const list = [...(settings?.work_roots || []), ...legacyRoots(lively)];
  //  env 는 PATH 와 같은 꼴(POSIX `:` · 윈도우 `;`) — 윈도우 경로의 `C:` 를 자르지 않게 플랫폼 구분자만 쓴다.
  const e = String(env.LIVELY_WORK_ROOTS || "").trim();
  if (e) list.push(...e.split(delimiter).map((s) => s.trim()).filter(Boolean));
  const out = [];
  for (const r of list) {
    const x = expandHome(r, home);
    if (!isAbsolute(x)) continue;
    if (!out.some((y) => normPath(y) === normPath(x))) out.push(resolve(x));
  }
  return out;
}

/** dir 를 품는 작업 폴더(없으면 null). 심링크로 들어온 경로도 실제 경로로 한 번 더 본다. */
export function matchWorkRoot(dir, roots) {
  const cands = [dir, real(dir)].filter(Boolean);
  for (const r of roots) {
    const rs = [r, real(r)].filter(Boolean);
    if (cands.some((c) => rs.some((x) => underRoot(c, x)))) return r;
  }
  return null;
}

// ── 판정 ─────────────────────────────────────────────────────────────────────
/**
 * @returns {{ inScope: boolean, reason: "spawned"|"unsynced"|"anywhere"|"project"|"work_root"|"outside", dir: string, scope?: string, root?: string }}
 */
export function decideRecordScope({ env = process.env, dir = "", lively = livelyDirOf(env) } = {}) {
  if (String(env.LIVELY_SESSION_ID || "").trim() || String(env.LIVELY_RUN || "").trim() === "1") return { inScope: true, reason: "spawned", dir };
  const s = effectiveSettings(lively);
  if (!s) return { inScope: true, reason: "unsynced", dir };
  if (s.scope === "anywhere") return { inScope: true, reason: "anywhere", dir, scope: s.scope };
  if (dir) {
    const marker = findProjectMarker(dir, dirname(lively));
    if (marker) return { inScope: true, reason: "project", dir, scope: s.scope, root: dirname(dirname(marker)) };
    const root = matchWorkRoot(dir, workRootsOf(lively, s, env));
    if (root) return { inScope: true, reason: "work_root", dir, scope: s.scope, root };
  }
  return { inScope: false, reason: "outside", dir, scope: s.scope };
}

/** 훅·프록시용 한 줄 — 판정만 필요할 때. 판정 자체가 터지면(예상 밖 파일 상태) 종전 동작으로 둔다. */
export function inScopeNow({ env = process.env, input = null, cwd = process.cwd(), harness = "", lively = livelyDirOf(env) } = {}) {
  try { return decideRecordScope({ env, dir: sessionDirOf({ env, input, cwd, harness }), lively }); }
  catch { return { inScope: true, reason: "error", dir: "" }; }
}

// ── 이 컴퓨터 id ─────────────────────────────────────────────────────────────
//  sync-harness-assets.mjs machineId() 와 같은 파일·같은 규칙이다(먼저 뜬 쪽이 만든다).
export function machineIdOf(lively, { create = true } = {}) {
  const p = join(lively, "machine-id");
  try { const cur = readFileSync(p, "utf8").trim(); if (/^[a-f0-9-]{8,64}$/i.test(cur)) return cur; } catch { /* 없음 */ }
  if (!create) return "";
  try { mkdirSync(lively, { recursive: true }); const id = randomUUID(); writeFileSync(p, id + "\n", { mode: 0o600 }); return id; }
  catch { return ""; }
}

// ── 서버와 맞추기(설치기 · 세션 시작 훅 · CLI) ────────────────────────────────
//  보내는 것: 회원 토큰 + 이 컴퓨터 id + (pending 이 있으면) 바꾼 값. **세션 id·폴더·대화는 보내지 않는다** —
//  작업 폴더 밖 세션도 이 조회는 하므로(안 하면 웹에서 새로 등록한 폴더를 그 폴더의 세션이 영영 모른다) 신원 헤더를 싣지 않는다.
const validPref = (j) => !!j && typeof j === "object" && isScope(j.scope) && Array.isArray(j.work_roots);
const newer = (a, b) => { const x = Date.parse(a || ""), y = Date.parse(b || ""); return Number.isFinite(x) && Number.isFinite(y) && x > y; };

async function call(send, url, { method = "GET", body, token, timeoutMs }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await send(url, { method, signal: ctl.signal,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch { return { ok: false, status: 0 }; }
  finally { clearTimeout(t); }
}

/** 지금 쌓인 pending 을 한 번에 올린다. 성공하면 서버 답을 사본으로 굳히고, 올린 몫만 pending 에서 걷는다(그 사이 쌓인 건 남는다). */
async function pushPending({ lively, base, token, send, machineId, timeoutMs }) {
  const posted = readScopeFile(lively)?.pending || null;
  if (!posted) return { ok: true, pushed: false };
  const r = await call(send, `${base}/api/ui/me/local-scope`, { method: "POST", token, timeoutMs,
    body: { machine_id: machineId, ...(posted.scope ? { scope: posted.scope } : {}), ...(posted.add ? { add: posted.add } : {}), ...(posted.remove ? { remove: posted.remove } : {}) } });
  if (!r.ok || !validPref(r.body?.preference)) return { ok: false, pushed: false, status: r.status };
  const now = readScopeFile(lively);
  recordServerState(lively, r.body.preference, withoutPosted(now?.pending || null, posted, dirname(lively)));
  return { ok: true, pushed: true };
}

/** 이 컴퓨터 설정을 서버에 올리고(pending) 받는다. 실패는 조용히 — 사본은 그대로 둔다. */
export async function syncScopeSettings({ lively, gw, token, send, machineId = machineIdOf(lively), timeoutMs = 1500 }) {
  if (!gw || !token || !machineId || typeof send !== "function") return { ok: false };
  const base = String(gw).replace(/\/+$/, "");
  await pushPending({ lively, base, token, send, machineId, timeoutMs });
  const g = await call(send, `${base}/api/ui/me/local-scope?machine_id=${encodeURIComponent(machineId)}`, { token, timeoutMs });
  if (!g.ok || !validPref(g.body?.preference)) return { ok: false, status: g.status };
  //  받는 사이에 CLI 가 더 새 값을 서버에서 받아 굳혔으면(응답이 그보다 옛것) 덮지 않는다. pending 은 쓰기 직전 것을 그대로 둔다.
  const now = readScopeFile(lively);
  if (!(now && newer(now.updated_at, g.body.preference.updated_at))) recordServerState(lively, g.body.preference, now?.pending || null);
  return { ok: true, kit_version: typeof g.body.kit_version === "string" ? g.body.kit_version : null };
}

/** CLI 의 한 번 바꾸기 — 먼저 pending 에 합치고(나중 변경이 이긴다) 그 묶음을 올린다. 못 닿으면 묶음은 그대로 남는다
 *  (다음 세션 시작·다음 CLI 가 올린다). 판정은 어느 쪽이든 곧바로 새 값을 본다. */
export async function changeScopeSettings({ lively, gw, token, send, machineId = machineIdOf(lively), scope, add = [], remove = [], timeoutMs = 2500 }) {
  addPending(lively, { scope, add, remove });
  if (gw && token && machineId && typeof send === "function") {
    const r = await pushPending({ lively, base: String(gw).replace(/\/+$/, ""), token, send, machineId, timeoutMs });
    if (r.ok && r.pushed) return { synced: true, settings: readScopeFile(lively) };
  }
  return { synced: false, settings: readScopeFile(lively) };
}

// ── 범위 밖 알림 ─────────────────────────────────────────────────────────────
/** 이 하네스에서 «여기 연결» 을 부르는 말 — 클로드 슬래시 커맨드 · 코덱스 커스텀 프롬프트 · 그 밖은 CLI.
 *  플러그인만 깐 클로드(키트 없음)엔 커맨드도 CLI 도 없다 — 웹 화면을 가리킨다. */
export function connectHint(harness = "claude", { plugin = false } = {}) {
  const h = String(harness || "claude").toLowerCase();
  if (plugin) return "웹 «내 스킬·훅 ▸ 내 컴퓨터별 연결»에서 이 폴더를 등록";
  if (h === "claude") return "/lively-connect";
  if (h === "codex") return "/prompts:lively-connect";
  return "`lively work-root add`";
}

// 안내문에 그대로 넣어도 되는 폴더 이름인가 — 따옴표·백틱·달러·역슬래시·제어문자가 든 이름은 AI 가 읽는 지시문과
//  셸 명령을 흐트러뜨릴 수 있어(압축을 푼 폴더처럼 이름을 남이 정한 경우) 넣지 않는다.
const safeDir = (d) => !!d && /^[^\u0000-\u001f\u007f"'`$\\]+$/.test(d) && d.length <= MAX_ROOT_LEN;

/** 범위 밖 세션 시작 알림 — 사람에게 한 줄(systemMessage) + AI 에게 안내(additionalContext). */
export function outsideNotice({ dir = "", harness = "claude", plugin = false } = {}) {
  const hint = connectHint(harness, { plugin });
  const user = plugin ? `[라이블리] 작업 폴더가 아니라 꺼져 있습니다 · 여기서 쓰려면 ${hint}하세요` : `[라이블리] 작업 폴더가 아니라 꺼져 있습니다 · 여기서 쓰려면 ${hint}`;
  const where = safeDir(dir) ? `이 세션을 연 폴더(\`${dir}\`)는` : "이 세션을 연 폴더는";
  const how = plugin
    ? `사람이 이 폴더에서 라이블리를 쓰고 싶다고 하면 웹 «내 스킬·훅 ▸ 내 컴퓨터별 연결»에서 이 컴퓨터의 작업 폴더에 등록하라고 안내하라 — 다음 세션부터 연결된다.`
    : `사람이 이 폴더에서 라이블리를 쓰고 싶다고 하면 ${hint} 를 안내하거나, 사람의 요청에 따라 셸에서 ${safeDir(dir) ? `\`lively work-root add "${dir}"\`` : "이 폴더에서 `lively work-root add`"} 를 실행하라 — 이 폴더가 작업 폴더로 등록되고 이 세션도 다음 메시지부터 연결된다.`;
  const ai = [
    "## 라이블리 꺼짐 — 작업 폴더 밖 (#5016)",
    `${where} 이 컴퓨터의 라이블리 작업 폴더가 아니어서 라이블리가 꺼져 있다 — 회사 맥락 주입·기록·대화 업로드·라이블리 도구가 이 세션엔 없다.`,
    "다른 곳(예: ~/.codex/AGENTS.md · ~/.config/opencode/AGENTS.md)에 라이블리 블록이 남아 있어도 그 규칙(기록하라 등)은 이 세션에 적용하지 마라.",
    how,
    "사람이 요청하지 않았는데 등록하지 마라.",
  ].join("\n");
  return { user, ai };
}

// ── 세션 중간 연결(늦은 맥락 주입) ───────────────────────────────────────────
//  범위 밖으로 시작한 세션은 시작 훅이 회사 맥락을 안 넣었다. 그 세션에서 폴더를 등록하면 도구는 프록시가 바로 살리지만
//  맥락은 넣을 자리가 없다 — 그래서 시작 훅이 표식을 남기고, 다음 지시 때 run-custom 이 그 표식을 보고 한 번 넣는다.
//  ⚠ 세션 id 를 시작 훅 입력에서 받는 하네스(클로드·코덱스)만 된다 — 어댑터 하네스는 시작 훅을 빈 입력으로 불러 id 가 없다(다음 세션부터).
export const hookFlagDir = () => join(tmpdir(), "lively-hooks");   // work-flag·stop-writeback-gate 와 같은 per-user tmp
const lateMarker = (sid, flagDir) => join(flagDir, `${sid}.scope-out`);
export function markStartedOutside(sid, flagDir = hookFlagDir()) {
  if (!SID_RE.test(String(sid || ""))) return false;
  try { mkdirSync(flagDir, { recursive: true, mode: 0o700 }); writeFileSync(lateMarker(sid, flagDir), new Date().toISOString() + "\n"); return true; }
  catch { return false; }
}
export function startedOutside(sid, flagDir = hookFlagDir()) {
  return SID_RE.test(String(sid || "")) && existsSync(lateMarker(sid, flagDir));
}
export function clearStartedOutside(sid, flagDir = hookFlagDir()) {
  if (!SID_RE.test(String(sid || ""))) return;
  try { unlinkSync(lateMarker(sid, flagDir)); } catch { /* 없음 */ }
}
