// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=SessionStart, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 프로젝트 세션이면 공유폴더를 게이트웨이에서 pull(단방향). 마커 없으면 no-op(비프로젝트 세션).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만 — 컨텍스트 주입 안 함).
//  ⚠ 이 훅은 **찾은 폴더에 서버 파일을 덮어쓴다** — 그래서 '어느 폴더에 써도 되는가' 게이트가 생명이다(아래 syncMode).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다 — dev '다온' 실측이 정확히 그 사고다.
const SCOPE_HDRS = {
  ...(String(process.env.LIVELY_SESSION_ID || "").trim() ? { "x-lively-session": String(process.env.LIVELY_SESSION_ID).trim() } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
};


// ── 프로젝트 폴더·동기화 모드 해석(#3787) — **서버가 권위, 마커는 캐시**. ──
//  종전엔 로컬 마커(.lively/project.json)가 권위였고, 마커에 sync 가 없으면 경로 모양 추측
//  (livelyOwnedDir: 조부모가 'lively' 인가)으로 폴백했다. 그런데 노드(멤버 노트북)의 프로젝트 폴더는
//  `<shared root>/project/<id>` 라 그 추측이 **항상 거짓**이었고, 마커를 쓰는 유일한 노드측 writer
//  (writeProvisionMarker)는 **레포 프로비저닝 때만** 돌면서 sync 를 안 썼다. 그래서 pull·pull-turn·push
//  셋이 전부 같은 관문에서 죽어 있었다 — 로컬 세션은 공유폴더를 영영 못 받고, 만든 것도 못 올렸다.
//  (#3787 실측: 웹 컴포저에 붙여넣은 스크린샷이 세션에 안 가서 AI 가 근처 다른 파일을 읽고 세 번 연속 오답)
//
//  왜 서버로 옮기는 게 안전한가: 「권위를 서버로 옮기면 오프라인에서 fail-open」 이 마커 설계의 근거였는데,
//  이 훅들은 **어차피 매니페스트 fetch 에 실패하면 즉시 return** 한다. 덮어쓰기·업로드는 전부 네트워크를
//  전제하므로 네트워크가 없으면 게이트가 뭐라 답하든 아무 일도 안 일어난다 — 새 실패모드가 없다.
//
//  해석 순서: ① 서버(execution_session → project_folder_binding) ② 마커 캐시(서버가 저술한 값만) ③ 없으면 no-op.
//  ⚠ **cwd 에서 위로 마커를 찾아 올라가지 않는다.** 그 탐색이 `lively init` 이후 사용자 폴더를 삼킬 수 있던
//   원래 위험원이었다. 이제 대상은 서버가 지목한 한 곳뿐이다.
const SYNC_MODES = ["none", "pull", "both"];
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 이 노드의 공유 워크스페이스 루트 — 노드 에이전트 roots() 와 **같은 계산**이어야 한다(다르면 엉뚱한 자리에 쏟는다). */
function sharedRoot() {
  return process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace");
}

/** 실행 세션 id — project-agents-inject 와 **같은 규약**(그 훅이 이미 프로덕션에서 이 축으로 돌고 있다). */
function executionSessionId(input, env = process.env) {
  const direct = String(env.LIVELY_SESSION_ID || "").trim();
  if (direct && SID_RE.test(direct)) return direct;
  const native = String((input && (input.session_id || input.sessionId)) || "").trim();
  const harness = String(env.LIVELY_HARNESS || "claude").trim().toLowerCase();
  if (native && harness === "codex" && SID_RE.test(`codex-${native}`)) return `codex-${native}`;
  if (native && harness === "claude" && SID_RE.test(`claude-${native}`)) return `claude-${native}`;
  const codex = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "").trim();
  if (codex && SID_RE.test(`codex-${codex}`)) return `codex-${codex}`;
  const claude = String(env.CLAUDE_SESSION_ID || "").trim();
  if (claude && SID_RE.test(`claude-${claude}`)) return `claude-${claude}`;
  return null;
}

/** 구 `work.mjs` 폴더(`~/lively/projects/<id>`) 인가 — **레거시 마커 전용 폴백**(#905 P1-② 의 잔존 경로).
 *  왜 남기나: 그 시절 work.mjs 는 마커에 sync 를 안 적었다. 이걸 빼면 아직 그 설치를 쓰는 멤버의 동기화가
 *  조용히 끊긴다(project-pull-gate.test.mjs ②가 그 무회귀를 강제한다). 이 한 꼴만 인정한다 — 넓히면
 *  흔한 사용자 경로 `~/projects/<무언가>` 가 걸려 무음 파괴가 난다. work.mjs 가 canonical 슬롯으로 수렴하면 삭제한다.
 *  ⚠ 이건 **위치** 폴백이지 권한 폴백이 아니다: 모드는 여전히 서버가 답하거나 마커에 명시돼 있어야 한다. */
function legacyWorkDir(projDir, projectId) {
  const parent = path.dirname(projDir);
  return path.basename(projDir) === String(projectId)
    && path.basename(parent) === "projects"
    && path.basename(path.dirname(parent)) === "lively";
}

/** 서버가 canonical 슬롯을 지목했을 때, cwd 가 **이미 이 프로젝트의 다른 라이블리 폴더 안**이면 그쪽이 이긴다.
 *  (구 work.mjs 설치 — 사람이 실제로 그 폴더에서 일하고 있는데 슬롯에 쏟으면 아무 데도 안 맞는다.) */
function legacyDirForCwd(cwd, projectId) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (legacyWorkDir(dir, projectId)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 마커 — 이제 **서버 응답의 사본**이다(판정 근거가 아니라 오프라인 폴백·워터마크 보관소). */
function readMarker(projDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "project.json"), "utf8")); } catch { return null; }
}
function writeMarker(projDir, patch) {
  try {
    const file = path.join(projDir, ".lively", "project.json");
    const prev = readMarker(projDir) || {};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...prev, ...patch }, null, 2) + "\n");
  } catch { /* 캐시 실패는 무해 — 다음 턴에 서버가 다시 답한다 */ }
}

/** 서버에 "이 노드에서 이 프로젝트 폴더는 어디고 모드는 뭔가" 를 묻는다. 실패 → null(호출자가 캐시로 폴백). */
async function askServer(jfetch, execId, nodeId) {
  if (!execId) return null;
  try {
    // content=0 — 동기화 훅은 AGENTS.md 본문이 필요 없다(최대 128KB). 폴더·모드만 받는다.
    const r = await jfetch(`/api/ui/execution-sessions/${encodeURIComponent(execId)}/project-context`
      + `?content=0&knownRevision=-1&node=${encodeURIComponent(nodeId || "")}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.found !== true) return null;
    const pid = Number(j.project_id || 0);
    // 소속 없음 = 동기화 대상 아님. **캐시 폴백도 하지 않는다** — 서버가 "뗐다"고 말한 것이라 확실한 음답이다.
    if (!Number.isInteger(pid) || pid <= 0) return { projectId: null };
    if (j.sync === undefined) return null;          // 구 서버(node 파라미터 미지원) → 캐시로 폴백
    const folder = String(j.folder || "").trim();
    const mode = SYNC_MODES.includes(String(j.sync || "")) ? String(j.sync) : "none";
    // folder_abs_path = 사람이 `lively init` 으로 명시 바인딩한 절대경로. 없으면 이 노드의 canonical 슬롯.
    const abs = j.folder_abs_path ? String(j.folder_abs_path) : (folder ? path.join(sharedRoot(), folder) : null);
    if (!abs) return { projectId: null };
    // slot = 라이블리가 소유하는 자리(없으면 만들어도 된다). false = 사람이 init 한 자기 폴더 — 없으면 만들지 않는다
    //  (지운 폴더를 빈 껍데기로 되살리면 "여기 프로젝트가 산다"는 거짓 신호가 남는다).
    return { projectId: pid, projDir: abs, mode, slot: !j.folder_abs_path };
  } catch { return null; }
}

/** 서버가 안 잡힐 때의 폴백 — cwd 위로 **한 번만** 훑어 캐시 마커를 찾는다. 캐시의 sync 는 서버가 저술한 값이다.
 *  ⚠ 경로 모양 추측은 하지 않는다. 캐시에 sync 가 없으면(구 마커·수동 생성) 판정 불가 → none. */
function fromCache(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const meta = readMarker(dir);
    if (meta) {
      if (meta.kind === "session") {                                   // 세션 폴더 마커 → 프로젝트 폴더로 건너뛴다(#1856)
        const pd = typeof meta.project_dir === "string" ? meta.project_dir : null;
        if (!pd) return null;
        const pm = readMarker(pd);
        if (!pm || pm.kind === "session") return null;
        const m = String(pm.sync || "").trim().toLowerCase();
        if (!SYNC_MODES.includes(m) || m === "none") return null;
        return { projectId: Number(pm.project_id) || null, projDir: pd, mode: m, slot: false };
      }
      const pid = Number(meta.project_id) || null;
      let m = String(meta.sync || "").trim().toLowerCase();
      // 구 work.mjs 마커(sync 미기재) 무회귀 — 그 한 꼴에서만 pull 로 본다. 그 밖엔 "모르면 안 쓴다".
      if (!SYNC_MODES.includes(m)) m = (pid && legacyWorkDir(dir, pid)) ? "pull" : "none";
      if (m === "none") return null;
      return { projectId: pid, projDir: dir, mode: m, slot: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── 싱크 원장(#905 C3) — "서버에서 받아 지금 보유 중인 파일"의 기준선. sync="both" 전용. ──
//  왜 pull 이 이걸 쓰는가: both 폴더에선 로컬도 정본 작성자다. 원장이 없으면 pull 은 '크기가 다르다'는 이유로
//   **아직 안 올라간 로컬 편집을 덮어써** 없앤다(pull 이 push 보다 먼저 돈다 — UserPromptSubmit → Stop).
//   원장과 로컬이 정확히 일치 = 받은 뒤 손 안 댔다 → 서버본으로 갱신해도 잃을 게 없다. 다르면 = 우리가 고쳤다
//   → 건드리지 않고 push 훅에 맡긴다(거기서 올리거나 충돌로 보고한다).
//  pull 모드는 서버가 정본이므로 이 보호가 없다(기존 동작 그대로 — 원장도 안 만든다).
// 동기화 비교 키는 **NFC 정본**이다(#1278b). 맥은 로컬에 NFD 로 저장된 이름을 readdir 로 그대로 돌려주므로
//  (실측: NFC 로 써도 readdir 은 NFD 반환) 서버 경로와 바이트 비교하면 같은 파일이 매번 '새 파일'로 보인다
//  → 전량 재업로드·중복. 원장 키·서버 조회 키를 전부 이걸로 접는다. 디스크 접근 경로는 접지 않는다(실제 이름 필요).
const nk = (p) => String(p ?? "").normalize("NFC");

function readLedger(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "sync-ledger.json"), "utf8"));
    const files = (o && o.files && typeof o.files === "object" && !Array.isArray(o.files)) ? o.files : {};
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [nk(k), v]));   // 구 원장(NFD 키)도 여기서 접힌다
  } catch { return {}; }   // 없음·깨짐 → 빈 원장 = 보호도 삭제전파도 안 함(fail-safe)
}
function writeLedger(projDir, files) {
  try {
    fs.writeFileSync(path.join(projDir, ".lively", "sync-ledger.json"),
      JSON.stringify({ v: 1, at: new Date().toISOString(), files }, null, 2) + "\n");
  } catch { /* 실패는 무해 — 원장 없음은 fail-safe 쪽이다 */ }
}
// 받은 그대로인가 — pull 이 utimes 로 서버 mtime 을 찍으므로 무손상 로컬은 기준선과 **정확히** 일치한다.
function untouched(st, base) {
  // st=null 방어: 이 훅은 모든 예외를 삼키고 exit 0 하므로(무음 계약) TypeError 하나가 곧 '싱크가 조용히 멈춤'이다.
  return !!base && !!st && st.size === base.size && Math.floor(st.mtimeMs) === base.mtime;
}

(async () => {
  // ── 저장 지역성 게이트 (#2258 Phase 4) ──────────────────────────────────────
  //  ★ 세션 파일이 **게이트웨이와 같은 저장소**면 동기화할 것이 없다. 매니지드에서 세션과
  //   게이트웨이는 JuiceFS 위 **같은 바이트**를 본다 — 받아 오고 올려 보내는 게 전부 낭비다
  //   (실측: 턴당 ~50ms, 파일 수에 거의 비례하지 않음 — 2파일 46ms · 237파일 54ms).
  //  ⚠ **`colocated` 라고 명시했을 때만** 건너뛴다. 미설정·오타·모르는 값은 종전대로 동기화한다 —
  //   잘못 건너뛰면 **파일이 영영 안 오고**(조용한 데이터 부재), 잘못 동기화하면 낭비일 뿐이다.
  //   값을 넣는 쪽은 세션을 만드는 자리다(control/src/sessionbroker.ts storageLocality).
  if (String(process.env.LVLY_STORAGE_LOCALITY || "").trim().toLowerCase() === "colocated") return;
  // 1) 훅 입력(stdin JSON) — cwd 는 폴백 해석에만 쓴다(대상은 서버가 지목한다).
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { /* */ }
  const cwd = (input && typeof input.cwd === "string" && input.cwd) ? input.cwd : process.cwd();

  // 2) 게이트웨이 base + 토큰 (session-preload/run-custom 와 동일 출처) — 해석보다 먼저다(서버에 물어야 하므로).
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  const jfetch = async (p) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    try { return await fetch(base + p, { signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } }); }
    finally { clearTimeout(t); }
  };

  // 3) 🔴 대상 해석 — 서버가 권위, 실패 시 마커 캐시. 둘 다 못 답하면 여기서 끝(아무 폴더도 안 건드린다).
  const target = (await askServer(jfetch, executionSessionId(input), process.env.LIVELY_NODE_ID)) ?? fromCache(cwd);
  if (!target || !target.projectId || !target.projDir) return;
  // 서버가 canonical 슬롯을 지목했는데 cwd 가 이미 이 프로젝트의 구 work.mjs 폴더 안이면 그쪽이 이긴다.
  if (target.slot) { const legacy = legacyDirForCwd(cwd, target.projectId); if (legacy) { target.projDir = legacy; target.slot = false; } }
  const { projectId, projDir } = target;
  const mode = target.mode;
  if (!SYNC_MODES.includes(mode) || mode === "none") return;
  // 슬롯은 없으면 만든다(라이블리 소유). 명시 바인딩인데 폴더가 없으면 사람이 지운 것 → 건드리지 않는다.
  if (!fs.existsSync(projDir)) { if (!target.slot) return; try { fs.mkdirSync(projDir, { recursive: true }); } catch { return; } }
  // 캐시 갱신 — 다음 턴에 서버가 안 잡혀도 같은 판정이 나오게(서버가 저술한 값만 적는다).
  writeMarker(projDir, { project_id: projectId, sync: mode });
  const lastPull = Number((readMarker(projDir) || {}).last_pull) || 0;

  // 4) 매니페스트 → newest <= last_pull 이면 skip(박스가 안 바뀜)
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if ((manifest.newest || 0) <= lastPull) return; // pull 불필요

  // 5) 변경분만 다운로드(단방향 — 삭제·worktree 미관여: 매니페스트에 없는 로컬 파일은 안 건드림)
  const ledger = mode === "both" ? readLedger(projDir) : null;   // both 전용 — pull 모드는 기존 동작 그대로
  const held = {};          // 이번 실행에서 '보유'가 확인된 서버 파일 → 새 원장
  let completed = true;     // 서버 스냅샷에 **전량 수렴**했는가. last_pull 은 이때만 올린다(아래 6·7 참조).
  // 🔴 매니페스트가 상한에 잘렸으면 **전량 수렴을 주장할 수 없다** — newest 는 목록 밖 파일의 mtime 까지 반영할 수
  //  있어, last_pull 을 올리면 "s.mtime <= last_pull ⟹ 우리가 그 버전을 갖고 있다"(push 충돌검사의 근거)가 거짓이 된다.
  if (manifest.truncated) completed = false;
  for (const f of files) {
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    let local = null;
    try { local = fs.statSync(dest); } catch { /* 로컬 없음 */ }
    const key = nk(f.path);                      // 비교·원장 키(정본) — dest 는 서버가 준 실제 이름을 쓴다
    const base = ledger ? ledger[key] : null;
    if (ledger && !base) {
      // ── 기준선이 없다 = 이 경로의 서버본을 **받은 적이 없다**(원장은 받은 것만 적는다). ──
      //  🔴 여기서 "크기 같고 로컬이 더 최신이면 이미 받은 것"이라 **추측하면 안 된다**: 원장이 거짓이 되고,
      //   원장은 삭제 전파의 유일한 근거라 사용자가 자기 파일을 지우는 순간 **남의 서버 문서가 지워진다**
      //   (0바이트 TODO.md 처럼 이름·크기 충돌은 흔하다 — 파일이 이미 있는 폴더를 바인딩하는 게 이 기능의 목적이다).
      if (local && local.size === f.size && Math.floor(local.mtimeMs) === f.mtime) {
        // mtime 이 **밀리초까지 정확히** 서버와 같고 크기도 같다 = pull 이 utimes 로 찍어둔 것 = 우리가 받은 것이다.
        //  (원장만 유실된 경우의 자기치유 경로. `>=` 가 아니라 `===` 인 게 핵심 — 우연히 일치할 값이 아니다.)
        held[key] = { mtime: f.mtime, size: f.size };
        continue;
      }
      if (local) {
        // 🔴 양쪽에 다 있는데 공통 조상이 없다 = **독립적으로 만들어진 두 판본**. 어느 쪽이 옳은지 알 방법이 없다.
        //  받으면 사용자 파일이 사라지고, 올리면 서버 문서가 사라진다 → **아무것도 안 한다**. push 가 충돌로 보고한다
        //  (기준선이 없으면 s.mtime > last_pull 이 성립해 그쪽 검사에 걸린다).
        completed = false;   // 워터마크를 올리면 push 가 '서버 안 바뀜'으로 오판해 올려버린다
        continue;
      }
      // 로컬에 없다 → 잃을 게 없다. 받아서 기준선을 세운다.
    } else if (base) {
      // ── 3-way(기준선·로컬·서버) — 기준선이 있으면 **동일성을 추측하지 않는다**. ──
      //  🔴 왜 크기·시각 추측을 버렸나: 예전 판정은 "크기 같고 로컬이 더 최신 ⟹ 동일"이었는데, **같은 바이트 크기의
      //   다른 내용**(날짜 한 글자 수정 등)이 흔하다. 그러면 pull 이 '동일'로 오판해 기준선을 서버 최신으로 옮기고
      //   last_pull 을 올린다 → 그다음 push 의 충돌검사(s.mtime > last_pull)가 뚫려 **남의 최신본이 우리 로컬본으로
      //   덮인다**. 기준선은 우리가 받은 서버 버전의 신원이라 추측이 필요 없다.
      const serverChanged = base.mtime !== f.mtime || base.size !== f.size;
      if (!local) {
        // 원장에 있는데 로컬에 없다 = **우리가 지웠다**(원장은 받은 것만 적으므로 '못 받음'이 아니다).
        //  서버가 우리가 받은 그대로면 push 가 이번 턴 끝에 삭제를 전파한다 → **다시 받지 않는다**(받으면
        //  사용자의 삭제를 매 턴 되돌린다).
        if (!serverChanged) { held[key] = base; continue; }
        // 서버가 그 사이 바뀌었으면 우리 삭제는 push 에서 충돌로 막히고 **보고된다**. 그 최신본은 받아준다 —
        //  안 받으면 사용자는 그 파일을 영영 못 보고 충돌만 남는다(되돌릴 방법 없음). 받은 뒤 다시 지우면
        //  그땐 기준선이 서버와 같으므로 삭제가 정상 전파된다.
      } else if (!untouched(local, base)) {
        // 🔴 받은 뒤 로컬에서 고쳤다 → **덮지 않는다**(아직 안 올라간 편집 — push 가 올리거나 충돌로 보고).
        held[key] = base;
        if (serverChanged) completed = false;   // 양쪽 다 바뀜 = 충돌. 워터마크를 올리면 push 검사가 뚫린다.
        continue;
      } else if (!serverChanged) { held[key] = base; continue; }   // 셋 다 같다 — 할 일 없음
      // 로컬은 받은 그대로 · 서버만 바뀜 → 잃을 게 없다. 받는다.
    } else {
      // 원장 없음(pull 모드) → 종전 휴리스틱 그대로. 서버가 정본이고 삭제 전파도 없어 추측이 무해하다.
      if (local && local.size === f.size && Math.floor(local.mtimeMs) >= f.mtime) continue;
    }
    try {
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`);
      if (!r.ok) { completed = false; continue; }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      if (f.mtime) { try { const tt = new Date(f.mtime); fs.utimesSync(dest, tt, tt); } catch { /* */ } }
      if (ledger) held[key] = { mtime: f.mtime, size: f.size };
    } catch { completed = false; } // 개별 파일 실패 → last_pull 미갱신 → 다음 세션 재시도
  }

  // 6) 원장 갱신(both 전용) — 완주했으면 통째 교체(서버에서 사라진 항목은 자연히 빠진다), 끊겼으면 도달분만 병합.
  //    "안 받은 걸 받았다고 주장하지 않는다" — 원장은 삭제 전파의 유일한 근거라 과다 주장이 곧 파괴다.
  if (ledger) writeLedger(projDir, completed ? held : { ...ledger, ...held });

  // 7) 마커 last_pull 갱신 — **전량 수렴했을 때만**(UserPromptSubmit 판과 동일 규칙). 실패분이 있는데 올리면
  //    그 파일은 서버가 또 바뀔 때까지 영구 누락되고, 더 나쁘게는 push 의 충돌검사 기준선이 거짓이 된다.
  if (completed) writeMarker(projDir, { project_id: projectId, sync: mode, last_pull: manifest.newest || lastPull });
})().then(() => process.exit(0)).catch(() => process.exit(0));
