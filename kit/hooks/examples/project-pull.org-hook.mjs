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
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
    // folder_abs_path = 사람이 `lively init` 으로 명시 바인딩한 절대경로. 없으면 라이블리 소유 슬롯인데, 그 자리는
    //  **서버가 세션 행에서 읽은 session_dir**(이 세션이 실제로 도는 프로젝트 폴더, #4135)이 먼저고, 그것도 없으면
    //  이 노드의 canonical 슬롯(<shared root>/<folder>)을 env 로 조립한다(옛 루트가 env 에 남은 세션이 엉뚱한 폴더를 봤다).
    const abs = j.folder_abs_path ? String(j.folder_abs_path)
      : j.session_dir ? String(j.session_dir)
      : (folder ? path.join(sharedRoot(), folder) : null);
    if (!abs) return { projectId: null };
    // slot = 라이블리가 소유하는 자리(없으면 만들어도 된다 — session_dir 도 여기 든다). false = 사람이 init 한 자기 폴더 —
    //  없으면 만들지 않는다(지운 폴더를 빈 껍데기로 되살리면 "여기 프로젝트가 산다"는 거짓 신호가 남는다).
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

// 동기화 비교 키는 **NFC 정본**이다(#1278b). 맥은 로컬에 NFD 로 저장된 이름을 readdir 로 그대로 돌려주므로
//  (실측: NFC 로 써도 readdir 은 NFD 반환) 서버 경로와 바이트 비교하면 같은 파일이 매번 '새 파일'로 보인다
//  → 전량 재업로드·중복. 원장 키·서버 조회 키를 전부 이걸로 접는다. 디스크 접근 경로는 접지 않는다(실제 이름 필요).
const nk = (p) => String(p ?? "").normalize("NFC");

// ── 싱크 원장 v2 — **base(공통조상)** 이다. 「지금 보유 중」이 아니라 「마지막으로 양쪽이 일치한 상태」. ──
//  🔴 v1 이 진동을 냈다(#3787, 2026-09-14 실측): 원장을 pull 은 「지금 서버에 있는 것」으로, push 는
//   「한때 받은 적 있는 것」으로 읽었다. 그래서 중앙에서 지운 파일을 ①push 가 «되살리지 않는다» 로 막고
//   ②pull 이 원장을 서버 스냅샷으로 통째 교체해 그 기억을 지우고 ③다음 push 가 «진짜 새 문서» 로 재업로드
//   → 사람이 또 지움 → 반복. pull(턴마다)·push(도구마다)라 주기가 초 단위여서 자료함이 눈에 띄게 깜빡였다.
//
//  v2 는 **삭제도 하나의 base 상태**로 적는다:
//    files: { <경로>: {mtime,size} }        — 양쪽이 일치한 서버 버전
//    tombs: { <경로>: {mtime,size,at} }     — **서버에서 사라진 걸 봤다**(사라지기 직전 우리가 갖고 있던 기준선)
//  이러면 push 가 「로컬이 묘비와 같으면 그건 중앙이 지운 그 파일 → 안 올린다 / 다르면 삭제 뒤 새로 쓴 것 → 올린다」
//  를 **추측 없이** 판정한다. 워터마크(last_pull)만으로 푸는 안은 «내가 올린 직후 남이 지운» 경우에 깨진다
//  (그 파일의 mtime 이 last_pull 보다 크다 — project-bidi.test.mjs ⑩ 이 그 자리를 강제한다).
//
//  묘비 수명: 로컬에서도 그 파일이 사라지면 함께 지운다(할 일 끝). 로컬에 남아 있는 한 유지 — 그게 곧
//  「이 파일은 이제 로컬 전용」이라는 사실이고, 그 기억이 없으면 다시 되살아난다.
//  v1 원장은 tombs 없음으로 읽어 그대로 동작한다(하위호환).
function readLedger(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "sync-ledger.json"), "utf8"));
    const pick = (k) => {
      const v = (o && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) ? o[k] : {};
      return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [nk(kk), vv]));   // 구 원장(NFD 키)도 여기서 접힌다
    };
    return { files: pick("files"), tombs: pick("tombs") };
  } catch (e) {
    // 없음·깨짐 → 빈 원장 = 보호도 삭제전파도 안 함(fail-safe). bad = 파일은 있는데 못 읽었다(쓰는 중·깨짐) —
    //  빈 원장 위에 «덧쓰기»를 하면 다른 기준선·묘비가 다 지워지므로, 덧쓰기만 하는 자리(healBaselines)는 이때 쓰지 않는다(#4609).
    return { files: {}, tombs: {}, bad: !(e && e.code === "ENOENT") };
  }
}
function writeLedger(projDir, files, tombs) {
  // 임시 파일 → rename(#4609). 그 자리에 바로 쓰면 같은 폴더의 다른 받기·올리기가 쓰다 만 원장을 읽어 «빈 원장»으로
  //  보고, 그 위에 쓰면서 다른 기준선·묘비를 지운다(묘비가 지워지면 중앙에서 지운 문서를 다시 올린다 — #3787 진동).
  const file = path.join(projDir, ".lively", "sync-ledger.json");
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, at: new Date().toISOString(), files, tombs: tombs || {} }, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* */ } /* 실패는 무해 — 원장 없음은 fail-safe 쪽이다 */ }
}
/** 로컬 파일이 이 기준선과 **바이트 동일한 그 파일**인가 — pull·push 가 mtime 을 서버 값으로 맞추므로 정확히 일치한다. */
function sameAsBaseline(st, base) {
  return !!base && !!st && st.size === base.size && Math.floor(st.mtimeMs) === base.mtime;
}
// 받은 그대로인가 — pull 이 utimes 로 서버 mtime 을 찍으므로 무손상 로컬은 기준선과 **정확히** 일치한다.
function untouched(st, base) {
  // st=null 방어: 이 훅은 모든 예외를 삼키고 exit 0 하므로(무음 계약) TypeError 하나가 곧 '싱크가 조용히 멈춤'이다.
  return !!base && !!st && st.size === base.size && Math.floor(st.mtimeMs) === base.mtime;
}

// ── 받기(#4609) — 크기와 상관없이 받고, 반쪽 파일을 남기지 않고, 실제로 받은 판을 적는다. ──
//  🔴 요청에 `download=1` 을 반드시 싣는다. 없으면 서버는 미리보기 상한(25MB)을 넘는 파일을 413 으로 거절하고
//   (project-routes.ts `/:id/file`), 그 413 은 매 실행 되풀이된다 → completed 가 영영 false → last_pull 이 한 번도
//   안 적힌다. #4609 실측: 웹에서 올린 71MB 영상 하나 때문에 한 프로젝트 폴더가 9/30 이후 한 번도 수렴하지 못했다.
//   (push 는 25MB 넘는 파일을 올리지 않지만, 웹 업로드·중앙 세션이 둔 큰 파일은 서버에 있다.)
//  받은 바이트는 **같은 폴더의 숨김 임시 파일**에 쓰고 판 시각을 찍은 뒤 rename 으로 갈아 끼운다. 제한 시간에 끊겨도
//   제자리에 반쪽 파일이 남지 않는다 — 반쪽 파일은 크기가 달라 «기준선 없는 독립 판본»으로 굳는다. 숨김 이름이라
//   push walk·서버 매니페스트에 안 잡힌다. 강제 종료(SIGKILL)로 남은 것은 이름에 적힌 시각으로 10분 뒤 지운다.
//  받은 판의 신원은 응답 도장(X-File-Mtime · X-File-Size)이다. 매니페스트를 읽은 뒤 서버본이 바뀌었으면 그 새 판을
//   받은 것이라, 매니페스트 값을 찍으면 로컬이 기준선과 어긋나 «내가 고친 파일»로 보호돼 영영 안 바뀐다.
//   도장이 없는 옛 서버면 매니페스트 값을 쓰되, 받은 바이트 수가 그 크기와 다르면 버린다(다음 실행에 다시).
//  크기 제한은 없다 — 턴 판(project-pull-turn)은 25MB 넘는 파일을 이 판에 맡긴다. 진행 중인 받기는 제한 시간의 70% 에
//   끊고, 넉넉히 받고도 끊긴 판은 «받기 보류 기록»으로 한동안 다시 받지 않는다(세션 시작마다 수십 초를 먹지 않게).
const TMP_TAG = ".lively-pull-";   // 임시 파일 이름 머리. 원래 이름은 안 넣는다 — 긴 한글 이름 + 꼬리가 255바이트를 넘으면 못 만든다
const TMP_STALE_MS = 10 * 60_000;
const drop = (p) => { try { fs.unlinkSync(p); } catch { /* 이미 없음 */ } };

/** 판 시각(ms)을 그대로 찍는다. Date 를 넘기면 Node 18~22 에서 절반쯤이 1ms 내려 찍힌다(#4609 실측: 2만 번 중 약 1만 번,
 *  24·26 은 0번). 초 단위 수에 0.5ms 를 더해 넘기면 모든 판에서 정확하다 — «크기·밀리초 시각이 같으면 같은 판» 규칙이 여기에 기댄다. */
function stampMtime(p, ms) { const s = (ms + 0.5) / 1000; fs.utimesSync(p, s, s); }

/** 강제 종료로 남은 옛 임시 파일을 지운다 — 폴더마다 실행당 한 번, 이름에 적힌 시각 기준 10분. 실패는 무해.
 *  (받을 파일마다 폴더를 다시 읽으면 파일 많은 폴더의 첫 동기화가 폴더 크기 × 파일 수만큼 느려진다.) */
const sweptDirs = new Set();
function sweepTemps(dir) {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith(TMP_TAG)) continue;
      const born = Number(n.slice(TMP_TAG.length).split("-")[0]);
      if (Number.isFinite(born) && Date.now() - born > TMP_STALE_MS) drop(path.join(dir, n));
    }
  } catch { /* 폴더 없음 등 — 지울 것도 없다 */ }
}

// 이보다 작은 파일이 끊긴 건 대역폭 탓이 아니다(서버·망이 잠깐 멈춘 것) — «느린 받기»로 보류하지 않고 다음 실행이 바로 다시 받는다.
const SLOW_MIN_BYTES = 1024 * 1024;

/** 서버 파일 하나를 숨김 임시 파일로 받는다 → { tmp, mtime, size }(받은 판) · 느린 받기로 끊김 → { err: "slow" } · 그 밖의 실패 → null.
 *  어느 실패든 임시 파일은 남기지 않는다. */
async function fetchToTemp(getFile, f, dest, hardDeadline) {
  const left = hardDeadline - Date.now();
  if (left <= 0) return null;
  const t0 = Date.now();
  let late = false;
  const ctl = new AbortController(); const t = setTimeout(() => { late = true; ctl.abort(); }, left);
  let tmp = null;
  try {
    const r = await getFile(f.path, ctl.signal);
    if (!r.ok || !r.body) { try { await r.body?.cancel(); } catch { /* */ } return null; }   // 연결을 붙들지 않게 본문을 닫는다
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    sweepTemps(path.dirname(dest));
    tmp = path.join(path.dirname(dest), `${TMP_TAG}${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp, { flags: "wx" }));
    const hm = Number(r.headers.get("x-file-mtime")), hs = Number(r.headers.get("x-file-size"));
    const stamped = r.headers.has("x-file-mtime") && r.headers.has("x-file-size")
      && Number.isFinite(hm) && hm > 0 && Number.isInteger(hs) && hs >= 0;
    const mtime = stamped ? Math.floor(hm) : f.mtime, size = stamped ? hs : f.size;
    if (fs.statSync(tmp).size !== size) { drop(tmp); return null; }   // 받는 사이 판이 바뀌었거나 끊겼다 → 다음 실행에
    if (mtime) stampMtime(tmp, mtime);
    return { tmp, mtime, size };
  } catch {
    let got = 0;
    if (tmp) { try { got = fs.statSync(tmp).size; } catch { /* */ } drop(tmp); }
    // «느린 받기» = 본문이 흐르다가(바이트가 왔다) 마감에 끊겼거나 2초 넘게 받다 끊겼고, 대역폭이 문제일 만큼 크다.
    //  머리도 못 받고 멈춘 것·작은 파일은 그냥 실패다 — 보류하면 작은 문서 하나가 30분 넘게 안 온다(재검토 실측).
    const slow = got > 0 && (f.size || 0) >= SLOW_MIN_BYTES && (late || Date.now() - t0 > 2000);
    return slow ? { err: "slow" } : null;
  }
  finally { clearTimeout(t); }
}

/** 두 파일의 바이트가 같은가 — 스트림 해시라 큰 파일도 메모리에 안 올린다. 못 읽으면 다르다고 본다. */
async function sameBytes(a, b) {
  const digest = async (p) => { const h = crypto.createHash("sha256"); for await (const c of fs.createReadStream(p)) h.update(c); return h.digest("hex"); };
  try { return (await digest(a)) === (await digest(b)); } catch { return false; }
}

/** 받은 임시 파일을 제자리로 옮긴다. 판정 때 본 로컬(seen)과 지금이 다르면 — 받는 사이 사람·AI 가 고쳤다 — 덮지 않는다.
 *  갈아 끼우기라 그 자리 덮어쓰기(종전)와 셋이 다르다: 권한 비트는 아래에서 잇고, 심볼릭 링크는 링크 대상을 고치는 대신
 *  보통 파일로 바뀌며(폴더 밖 대상을 덮던 위험이 사라진다), 읽기 전용 파일도 갈아 끼워진다(종전엔 EACCES 로 영영 실패). */
function placeTemp(got, dest, seen) {
  let now = null; try { now = fs.statSync(dest); } catch { /* 없음 */ }
  const unchanged = now
    ? !!seen && now.size === seen.size && Math.floor(now.mtimeMs) === Math.floor(seen.mtimeMs)
    : !seen;
  if (!unchanged) { drop(got.tmp); return false; }
  // 갈아 끼우면 새 파일의 권한이 된다 — 그 자리 덮어쓰기(종전 writeFile)처럼 기존 권한(실행 비트 등)을 잇는다.
  if (now) { try { fs.chmodSync(got.tmp, now.mode & 0o7777); } catch { /* */ } }
  try { fs.renameSync(got.tmp, dest); return true; } catch { drop(got.tmp); return false; }
}

// ── 받기 보류 기록(#4609) — `.lively/pull-skip.json`. 매 실행 같은 헛수고를 되풀이하지 않게 한다. ──
//  slow:    시간을 넉넉히 받고 시작했는데도 마감에 끊긴 서버 판 — 30분·2시간·8시간·24시간 동안 다시 받지 않는다.
//           느린 회선에서 큰 파일 하나가 프롬프트·도구 호출마다 수 초씩, 세션 시작마다 수십 초씩 먹던 자리다.
//           서버 판이 바뀌면 기록은 무효다(새 판은 다시 시도한다). 서버가 이어받기(Range)를 지원하지 않아 끊긴 만큼은 버려진다.
//  differs: 바이트를 대 보니 달랐던 (서버 판, 로컬 판) 짝 — 둘 다 그대로인 동안 다시 받아 대 보지 않는다.
//  캐시일 뿐이다 — 없거나 깨지거나 동시 실행에 덮여도 한 번 더 받는 것 말고는 일이 없다(원장과 달리 판정 근거가 아니다).
const SKIP_FILE = "pull-skip.json";
const SLOW_BACKOFF_MS = [30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
const sameVer = (v, size, mtime) => Array.isArray(v) && v[0] === size && v[1] === mtime;
function readSkip(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", SKIP_FILE), "utf8"));
    return o && o.items && typeof o.items === "object" && !Array.isArray(o.items) ? o.items : {};
  } catch { return {}; }
}
/** 이번 실행이 바꾼 것만 **다시 읽은** 기록 위에 얹는다(동시 실행의 기록을 덜 덮게). alive 를 주면 서버에 없는 경로는 정리한다. */
function writeSkip(projDir, set, del, alive) {
  if (!Object.keys(set).length && !del.size) return;
  try {
    const items = readSkip(projDir);
    for (const k of del) delete items[k];
    Object.assign(items, set);
    if (alive) for (const k of Object.keys(items)) if (!alive.has(k)) delete items[k];
    fs.writeFileSync(path.join(projDir, ".lively", SKIP_FILE), JSON.stringify({ v: 1, items }, null, 2) + "\n");
  } catch { /* 무해 — 다음에 한 번 더 받을 뿐이다 */ }
}
/** 이 서버 판(과 로컬 판)을 지금 건너뛸까. */
function skipNow(memo, f, local) {
  if (!memo || !sameVer(memo.s, f.size, f.mtime)) return false;   // 기록이 없거나 서버 판이 바뀌었다
  if (memo.why === "slow") {
    const n = Math.min(Math.max(1, Number(memo.n) || 1), SLOW_BACKOFF_MS.length);
    return Date.now() < Number(memo.at || 0) + SLOW_BACKOFF_MS[n - 1];
  }
  if (memo.why === "differs") return !!local && sameVer(memo.l, local.size, Math.floor(local.mtimeMs));
  return false;
}

/** 서버가 안 바뀌어 받을 것이 없는 실행에서도 기준선만 바로잡는다(#4609). 로컬이 서버 판과 크기·밀리초 시각까지 같은데
 *  기준선이 없거나 옛 판인 파일이 대상이다. 원장은 받기·올리기가 저마다 통째로 다시 쓰므로, 같은 폴더에 세션이 둘이면
 *  한쪽 기록이 덮여 기준선이 빠진다(실측: 동시 실행 둘 → 이긴 쪽이 last_pull 을 적고 진 쪽이 그 파일 없는 원장을 씀).
 *  그대로 두면 다음 실행부터 «서버 안 바뀜»으로 바로 끝나 아무도 못 채우고, 서버가 그 파일을 바꾸는 순간 «독립 판본»으로
 *  굳는다. 기준선이 서버 판과 이미 같은 파일은 stat 도 하지 않으므로 평소 비용은 원장 읽기 한 번이다. */
function healBaselines(projDir, files, keyOf) {
  const led = readLedger(projDir), fix = {};
  if (led.bad) return;                                                // 못 읽었다(쓰는 중·깨짐) — 빈 원장 위에 덧쓰면 다 지운다
  for (const f of files) {
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    const k = keyOf(f), b = led.files[k];
    if (b && b.mtime === f.mtime && b.size === f.size) continue;     // 이미 맞다
    let st = null; try { st = fs.statSync(dest); } catch { continue; }
    if (st.size !== f.size) continue;
    const m = Math.floor(st.mtimeMs);
    if (m === f.mtime - 1) { try { stampMtime(dest, f.mtime); } catch { continue; } }   // 옛 훅의 1ms 흔적 — 아래 판정 절 주석
    else if (m !== f.mtime) continue;
    fix[k] = { mtime: f.mtime, size: f.size };
  }
  if (!Object.keys(fix).length) return;
  const cur = readLedger(projDir);                                    // 다시 읽어 그 위에 얹는다(그 사이 쓴 기록을 덮지 않게)
  if (cur.bad) return;
  const next = { ...cur.files }, tombs = { ...cur.tombs };
  let n = 0;
  for (const [k, v] of Object.entries(fix)) {
    const a = led.files[k], c = cur.files[k];
    // 처음 읽은 뒤 다른 실행(예: 방금 올린 push)이 이 키를 고쳤으면 그쪽이 새것이다 — 덮지 않는다.
    if (!(a === c || (a && c && a.mtime === c.mtime && a.size === c.size))) continue;
    next[k] = v; delete tombs[k]; n++;                                // 서버에 다시 있고 로컬도 같다 → 묘비가 아니다
  }
  if (n) writeLedger(projDir, next, tombs);
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
  const startedAt = Date.now();
  // 시간(#4609) — run-custom 이 이 훅을 제한 시간에 SIGKILL 한다(LIVELY_HOOK_TIMEOUT_MS = 그 훅의 timeout_sec).
  //  죽으면 원장도 못 남기므로 70% 지점에서 진행 중인 받기를 끊고 그때까지의 진척을 적는다(project-push 와 같은 자).
  //  모르면 시드 등록값(이 판 120초)으로 본다.
  const HOOK_TIMEOUT_MS = Number(process.env.LIVELY_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.LIVELY_HOOK_TIMEOUT_MS) : 120_000;
  const hardDeadline = startedAt + Math.floor(HOOK_TIMEOUT_MS * 0.7);
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
  // 본문 받기 전용(#4609) — jfetch 의 4초는 헤더까지만 지키고 본문은 안 지킨다. 본문 마감은 fetchToTemp 가 신호로 건다.
  //  `download=1` 은 빼면 안 된다 — 위 「받기」 절.
  const getFile = (p, signal) => fetch(`${base}/api/ui/v6/projects/${projectId}/file?download=1&path=${encodeURIComponent(p)}`,
    { signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } });

  // 4) 매니페스트 → newest <= last_pull 이면 skip(박스가 안 바뀜)
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if ((manifest.newest || 0) <= lastPull) { // pull 불필요
    // 받을 것은 없다. 다만 기준선이 빠졌거나 옛 판인데 로컬이 서버와 같은 파일은 여기서 바로잡는다(#4609 — healBaselines).
    if (mode === "both") healBaselines(projDir, files, (f) => nk(f.path));
    return;
  }

  // 5) 변경분만 다운로드(단방향 — 삭제·worktree 미관여: 매니페스트에 없는 로컬 파일은 안 건드림)
  //    판정을 먼저 끝내고(stat 만 — 싸다) 받기는 그 뒤에 **작은 파일부터** 한다(#4609). 큰 파일 하나가 시간을 다 써서
  //    뒤의 작은 문서들이 매번 못 받는 일이 없게. 판정 때 본 로컬(seen)은 제자리에 놓기 직전에 다시 대 본다.
  const led = mode === "both" ? readLedger(projDir) : null;      // both 전용 — pull 모드는 기존 동작 그대로
  const ledger = led ? led.files : null;
  const held = {};          // 이번 실행에서 '보유'가 확인된 서버 파일 → 새 원장
  let completed = true;     // 서버 스냅샷에 **전량 수렴**했는가. last_pull 은 이때만 올린다(아래 6·7 참조).
  // 🔴 매니페스트가 상한에 잘렸으면 **전량 수렴을 주장할 수 없다** — newest 는 목록 밖 파일의 mtime 까지 반영할 수
  //  있어, last_pull 을 올리면 "s.mtime <= last_pull ⟹ 우리가 그 버전을 갖고 있다"(push 충돌검사의 근거)가 거짓이 된다.
  if (manifest.truncated) completed = false;
  const skip = readSkip(projDir), skipSet = {}, skipDel = new Set();   // 받기 보류 기록 — 위 「받기 보류 기록」 절
  const queue = [];         // 받을 것 — { f, dest, key, seen: 판정 때 본 로컬 stat, compare: 바이트가 같으면 시각만 맞출 후보 }
  for (const f of files) {
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    let local = null;
    try { local = fs.statSync(dest); } catch { /* 로컬 없음 */ }
    const key = nk(f.path);                      // 비교·원장 키(정본) — dest 는 서버가 준 실제 이름을 쓴다
    const base = ledger ? ledger[key] : null;
    if (led && led.tombs[key]) delete led.tombs[key];   // 서버에 다시 나타났다 → 묘비를 걷는다
    // mtime 이 **밀리초까지 정확히** 서버와 같고 크기도 같다 = 받기·올리기가 utimes 로 찍어 둔 그 판 = 이미 갖고 있다.
    //  (`>=` 가 아니라 `===` 인 게 핵심 — 우연히 일치할 값이 아니다.) 기준선이 없거나(원장 유실) **옛 판을 가리켜도**
    //  받을 것도 지킬 것도 없다 → 기준선만 서버 판으로. 🔴 옛 판일 때를 빼면, 원장 갱신 하나가 유실된 파일(pull 과
    //  push 가 원장을 따로 다시 쓰다 한쪽 기록이 덮인 경우)이 «로컬도 서버도 바뀜»으로 판정돼 영영 수렴하지 못한다
    //  (#4609 실측: 서버와 크기·시각까지 같은데 기준선이 옛 판인 파일 4개가 last_pull 을 막고 있었다).
    // (#4609) Node 18~22 의 옛 훅은 받은 파일 시각을 절반쯤 1ms 내려 찍었다(stampMtime 주석). 정확히 1ms 아래인 흔적은
    //  우리가 찍은 그 판으로 보고 시각만 바로잡는다 — 사람이 고친 파일은 시각이 «고친 때»라 정확히 1ms 아래일 수 없다.
    //  안 고치면 그 파일은 영영 «로컬 편집»으로 보이고, push 는 중앙에서 지운 그 파일을 «고친 것»으로 보고 되살린다.
    if (ledger && local) {
      const lm = Math.floor(local.mtimeMs), want = local.size === f.size && lm === f.mtime - 1 ? f.mtime
        : base && local.size === base.size && lm === base.mtime - 1 ? base.mtime : 0;
      if (want) { try { stampMtime(dest, want); local = fs.statSync(dest); } catch { /* 못 고치면 종전 판정 그대로 */ } }
    }
    if (ledger && local && local.size === f.size && Math.floor(local.mtimeMs) === f.mtime) {
      held[key] = { mtime: f.mtime, size: f.size };
      if (skip[key]) skipDel.add(key);
      continue;
    }
    if (ledger && !base) {
      // ── 기준선이 없다 = 이 경로의 서버본을 **받은 적이 없다**(원장은 받은 것만 적는다). ──
      //  🔴 여기서 "크기 같고 로컬이 더 최신이면 이미 받은 것"이라 **추측하면 안 된다**: 원장이 거짓이 되고,
      //   원장은 삭제 전파의 유일한 근거라 사용자가 자기 파일을 지우는 순간 **남의 서버 문서가 지워진다**
      //   (0바이트 TODO.md 처럼 이름·크기 충돌은 흔하다 — 파일이 이미 있는 폴더를 바인딩하는 게 이 기능의 목적이다).
      if (local) {
        // 🔴 양쪽에 다 있는데 공통 조상이 없다 = **독립적으로 만들어진 두 판본**. 어느 쪽이 옳은지 알 방법이 없다.
        //  받으면 사용자 파일이 사라지고, 올리면 서버 문서가 사라진다 → **아무것도 안 한다**. push 가 충돌로 보고한다
        //  (기준선이 없으면 s.mtime > last_pull 이 성립해 그쪽 검사에 걸린다).
        //  (#4609) 단 크기가 같으면 서버본을 받아 **바이트를 대 본다**. 같으면 같은 파일이고 시각만 다른 것이다
        //  (실측: 올리기가 올린 뒤 시각을 맞추기 전에 끊긴 파일). 추측이 아니라 비교라 원장에 적어도 거짓이 아니다.
        if (local.size === f.size) queue.push({ f, dest, key, seen: local, compare: true });
        else completed = false;   // 워터마크를 올리면 push 가 '서버 안 바뀜'으로 오판해 올려버린다
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
        if (serverChanged) {
          // 양쪽 다 바뀜 = 충돌. 워터마크를 올리면 push 검사가 뚫린다.
          //  (#4609) 단 크기가 같으면 바이트를 대 본다 — 같은 내용으로 모인 것이면 충돌이 아니다(시각만 맞춘다).
          if (local.size === f.size) queue.push({ f, dest, key, seen: local, compare: true });
          else completed = false;
        }
        continue;
      } else if (!serverChanged) { held[key] = base; continue; }   // 셋 다 같다 — 할 일 없음
      // 로컬은 받은 그대로 · 서버만 바뀜 → 잃을 게 없다. 받는다.
    } else {
      // 원장 없음(pull 모드) → 종전 휴리스틱 그대로. 서버가 정본이고 삭제 전파도 없어 추측이 무해하다.
      if (local && local.size === f.size && Math.floor(local.mtimeMs) >= f.mtime) continue;
    }
    queue.push({ f, dest, key, seen: local, compare: false });
  }
  queue.sort((a, b) => (a.f.size || 0) - (b.f.size || 0));
  for (const q of queue) {
    if (Date.now() >= hardDeadline) { completed = false; break; }   // 남은 것은 다음 세션에
    if (skipNow(skip[q.key], q.f, q.seen)) { completed = false; continue; }   // 보류 중 — 같은 헛수고를 되풀이하지 않는다
    // 시간을 넉넉히 받고 시작했나 — 앞의 파일들이 시간을 써서 늦게 시작한 받기가 끊긴 것까지 «느린 파일»로 적지 않게.
    const fair = hardDeadline - Date.now() >= (hardDeadline - startedAt) / 2;
    const got = await fetchToTemp(getFile, q.f, q.dest, hardDeadline);
    if (!got || got.err) {                                           // 개별 실패 → last_pull 미갱신 → 다음 실행 재시도
      completed = false;
      if (got && got.err === "slow" && fair) {
        const prev = skip[q.key];
        const n = prev && prev.why === "slow" && sameVer(prev.s, q.f.size, q.f.mtime) ? (Number(prev.n) || 1) + 1 : 1;
        skipSet[q.key] = { why: "slow", s: [q.f.size, q.f.mtime], at: Date.now(), n };
      }
      continue;
    }
    if (q.compare && !(await sameBytes(got.tmp, q.dest))) {          // 내용이 다르다 → 종전대로 손대지 않는다(독립 판본·로컬 편집 보호)
      drop(got.tmp); completed = false;
      skipSet[q.key] = { why: "differs", s: [q.f.size, q.f.mtime], l: [q.seen.size, Math.floor(q.seen.mtimeMs)], at: Date.now() };
      continue;
    }
    if (!placeTemp(got, q.dest, q.seen)) { completed = false; continue; }   // 받는 사이 로컬이 바뀌었다 → 덮지 않는다
    if (skip[q.key]) skipDel.add(q.key);
    if (ledger) held[q.key] = { mtime: got.mtime, size: got.size };
  }
  writeSkip(projDir, skipSet, skipDel, manifest.truncated ? null : new Set(files.map((f) => nk(f.path))));

  // 6) 원장 갱신(both 전용) — 완주했으면 통째 교체(서버에서 사라진 항목은 자연히 빠진다), 끊겼으면 도달분만 병합.
  //    "안 받은 걸 받았다고 주장하지 않는다" — 원장은 삭제 전파의 유일한 근거라 과다 주장이 곧 파괴다.
  // 6) 원장 갱신 — **사라진 것은 빼지 말고 묘비로 옮긴다**(#3787 진동의 뿌리).
  //  종전엔 완주 시 held 로 통째 교체해 「서버에서 사라진 항목은 자연히 빠진다」고 했는데, 그 빠짐이 곧
  //  push 의 «되살리지 않는다» 근거를 지워 재업로드를 부른다. 로컬에 아직 그 파일이 있으면 묘비를 세우고,
  //  로컬에도 없으면 할 일이 끝난 것이라 그냥 버린다(묘비가 무한히 쌓이지 않는다).
  if (led) {
    const nextFiles = completed ? held : { ...ledger, ...held };
    const tombs = { ...led.tombs };
    if (completed) {
      for (const [k, baseline] of Object.entries(ledger)) {
        if (nextFiles[k]) continue;                                   // 아직 서버에 있다
        const dest = path.join(projDir, k);
        if (fs.existsSync(dest)) tombs[k] = { ...baseline, at: Date.now() };   // 로컬에 남았다 → 기억한다
      }
    }
    for (const k of Object.keys(tombs)) {                             // 로컬에서도 사라진 묘비는 정리
      if (!fs.existsSync(path.join(projDir, k))) delete tombs[k];
    }
    writeLedger(projDir, nextFiles, tombs);
  }

  // 7) 마커 last_pull 갱신 — **전량 수렴했을 때만**(UserPromptSubmit 판과 동일 규칙). 실패분이 있는데 올리면
  //    그 파일은 서버가 또 바뀔 때까지 영구 누락되고, 더 나쁘게는 push 의 충돌검사 기준선이 거짓이 된다.
  if (completed) writeMarker(projDir, { project_id: projectId, sync: mode, last_pull: manifest.newest || lastPull });
})().then(() => process.exit(0)).catch(() => process.exit(0));
