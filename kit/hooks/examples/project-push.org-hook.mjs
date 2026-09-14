// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=Stop, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록. (#905 C3 up-sync)
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 턴 끝에 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 마커 sync="both" 인 프로젝트 폴더에서, **턴 중에 로컬에서 바뀐 공유문서를 게이트웨이로 올린다**(↑up).
//   여태 공유폴더는 중앙→멤버 **단방향**이었다(pull only). 멤버가 로컬에서 문서를 고치면 아무 데도 안 갔다.
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만).
//
//  ── 안전 설계 (이 훅은 **팀 공유문서를 지우고 덮을 수 있다** — 그래서 규칙이 전부다) ──
//   ① **sync="both" 일 때만 동작한다.** none/pull/미명시는 즉시 종료 = 기존 설치 전원 무영향(옵트인).
//   ② **서버가 우리 기준선 이후로 바뀐 파일은 절대 안 건드린다.** 기준선 = 마커의 last_pull(= 우리가 **전량 수렴**한
//      마지막 서버 스냅샷. pull 훅이 전량 확보 때만 올린다 — 그래서 "s.mtime <= last_pull ⟹ 우리가 그 버전을
//      갖고 있다"가 성립한다). 서버 mtime > last_pull 이면 남이 고친 것 → 덮으면 **남의 작업이 사라진다**.
//      → 충돌로 기록만 하고 건너뛴다. "모르면 안 건드린다".
//   ③ **삭제는 원장(.lively/sync-ledger.json)에 있는 것만 전파한다.** '로컬에 없음'은 **지웠음**과 **애초에 안
//      받았음**(예산초과·개별실패·나중에 서버에 생김)을 구분하지 못한다 — 구분 없이 지우면 **못 받은 남의 파일을
//      지운다**. 원장(=pull 이 실제로 받아 적은 것)에 있고, 서버가 그때 그대로일 때만 지운다.
//   ④ **판정 근거가 하나라도 불완전하면 통째로 포기한다.** 서버 매니페스트가 상한에 잘렸거나(truncated) 로컬
//      walk 가 잘렸으면 '없음'이 '안 보임'과 구분되지 않는다 → 삭제 전파 중단 + 신규 판정도 보류.
//   ⑤ 대상은 **문서뿐** — 숨김(. 시작)·git 레포 서브트리는 제외한다(코드는 git 이 수렴시킨다. 서버
//      manifestFiles 의 isGitRepoRoot 제외와 동형).
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


// ⏱ 시간 예산 — 이 훅은 run-custom.mjs 가 `execFileSync(..., {timeout, killSignal:"SIGKILL"})` 로 돌린다.
//  **SIGKILL 되면 정리 코드가 아예 안 돌아 sync-up.json 을 못 쓴다** = 충돌이 있어도 사용자에게 보일 유일한
//  표면이 통째로 사라진다. 그래서 죽기 전에 **우리가 먼저 멈춰** 기록을 남긴다.
//  상한은 run-custom 이 알려준다(LIVELY_HOOK_TIMEOUT_MS = 그 훅의 timeout_sec). 하드코딩하면 관리탭에서
//  timeout_sec 을 줄이는 순간 조용히 어긋난다. 구 run-custom(미전달)이면 시드 등록값 15s 로 가정.
//  70% 지점에서 네트워크를 끊고 남은 30% 로 기록한다. run-custom 은 훅들을 **순차** 실행하므로 여기서 시간을
//  다 쓰면 같은 Stop 의 다른 커스텀 훅이 굶는다 — 넉넉히 잡으면 안 되는 이유이기도 하다.
const HOOK_TIMEOUT_MS = Number(process.env.LIVELY_HOOK_TIMEOUT_MS) > 0
  ? Number(process.env.LIVELY_HOOK_TIMEOUT_MS)   // 🔴 하한을 깔면 안 된다 — run-custom 은 timeout_sec 을 1s 까지 허용하므로
  : 15_000;                                      //  하한(예: 2s)이 실제 킬(1s)보다 뒤에 오면 '먼저 멈춘다'가 정확히 깨진다

const DEADLINE_MS = Math.floor(HOOK_TIMEOUT_MS * 0.7);
const SLOW_WALK_MS = 15;            // 이 시간을 넘게 걷는 폴더면 PostToolUse 판은 자기제한을 켠다(#3787)
const SLOW_MIN_INTERVAL_MS = 5000;  // 그때의 최소 간격 — 놓친 변경은 Stop 판이 쓸어담는다
const REQ_TIMEOUT_MS = 8000;  // 개별 요청 상한(남은 예산과 min 을 취한다 — 마지막 요청이 데드라인을 넘기지 못하게)
const MAX_PUSH = 200;     // 한 턴에 **올릴** 파일 상한(폭주 방어). walk 상한과 별개다 — 아래 MAX_WALK 주석 참조.
const MAX_DELETE = 50;    // 한 턴에 **지울** 파일 상한. 업로드보다 훨씬 보수적인 이유: 잘못 올린 건 충돌로 남거나
//  덮이지만 **삭제는 되돌릴 수 없다**. 로컬에서 큰 폴더가 실수로 날아간 경우 시간예산만으로는 수백 건이 나갈 수 있다.
//  남은 건 다음 턴에 나가므로 진짜 대량삭제도 결국 전파된다 — 사람이 알아챌 시간이 생길 뿐이다.
const MAX_WALK = 5000;    // 로컬 walk 상한 = 서버 manifestFiles 의 MANIFEST_FILE_CAP 과 동수.
//  🔴 walk 상한을 업로드 상한(200)으로 같이 묶으면 안 된다: walk 가 잘리면 **실재하는 로컬 파일이 '없음'으로
//   보이고**, 그게 곧 삭제 전파의 근거가 된다(문서 300개짜리 폴더에서 100개가 서버에서 지워진다). walk 는 stat 만
//   하므로 싸다 — 끝까지 본다. 비싼 건 업로드뿐이라 거기만 200 으로 막는다.
const MAX_BYTES = 25 * 1024 * 1024;

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
  } catch { return { files: {}, tombs: {} }; }   // 없음·깨짐 → 빈 원장 = 보호도 삭제전파도 안 함(fail-safe)
}
function writeLedger(projDir, files, tombs) {
  try {
    fs.writeFileSync(path.join(projDir, ".lively", "sync-ledger.json"),
      JSON.stringify({ v: 2, at: new Date().toISOString(), files, tombs: tombs || {} }, null, 2) + "\n");
  } catch { /* 실패는 무해 — 원장 없음은 fail-safe 쪽이다 */ }
}
/** 로컬 파일이 이 기준선과 **바이트 동일한 그 파일**인가 — pull·push 가 mtime 을 서버 값으로 맞추므로 정확히 일치한다. */
function sameAsBaseline(st, base) {
  return !!base && !!st && st.size === base.size && Math.floor(st.mtimeMs) === base.mtime;
}

// 서버가 자동 생성하는 파일 — up-sync 대상이 아니다(올리지도 지우지도 않는다). 내려주는 건 pull 이 한다.
//  ① 지우면: 그 안의 '규칙'은 **사람이 쓴 유일본**이라 파일과 함께 사라진다(서버는 규칙을 그 파일에 보관한다).
//  ② 올리면: 서버가 매니페스트 조회마다 재생성하므로(ensureAgentsMd) 프로젝트 digest 가 바뀔 때마다 우리 로컬본은
//     자동으로 '뒤처진 다른 내용'이 된다 → 매번 거짓 충돌이 뜬다. 규칙 편집은 전용 경로(웹/POST rules)가 있다.
const SERVER_OWNED = new Set(["AGENTS.md"]);

// 로컬 문서 walk — 숨김 제외 · git 레포 서브트리 제외(서버 manifestFiles 와 동형).
//  present: 로컬에 **존재**하는 문서 경로(삭제 판정용 — stat 이 실패해도 존재는 존재다).
//  files:   업로드 후보(stat 성공분).  truncated: 전체를 못 봤다는 신호 → 삭제·신규 판정 금지.
//  skipped: 통째로 건너뛴 git 서브트리 접두사 — 그 밑은 '없음'이 아니라 '안 봄'이다.
async function localFiles(base) {
  const files = [], present = new Set(), skipped = [];
  let truncated = false;
  async function walk(dir, rel, depth) {
    if (depth > 24) return;   // 서버 매니페스트와 **동일** 상한 → 원장 경로는 전부 이 안에 있다(거짓 부재 없음)
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { truncated = true; return; }   // 읽기 실패 → 이 밑을 '없다'고 단정하면 남의 파일을 지운다
    for (const e of entries) {
      if (present.size >= MAX_WALK) { truncated = true; return; }
      if (e.name.startsWith(".")) continue;                       // .lively/.git/.env … 동기화 대상 아님
      const child = path.join(dir, e.name);
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        try { await fsp.stat(path.join(child, ".git")); skipped.push(nk(childRel) + "/"); continue; } catch { /* 레포 아님 → 들어간다 */ }
        await walk(child, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      present.add(nk(childRel));
      try { const st = await fsp.stat(child); files.push({ path: childRel, abs: child, size: st.size, mtime: Math.floor(st.mtimeMs) }); }
      catch { /* stat 불가 → 업로드 후보에서만 제외. present 에는 남는다(존재하므로) */ }
    }
  }
  await walk(base, "", 0);
  return { files, present, skipped, truncated };
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
  // 1) 훅 입력(stdin JSON) — cwd 는 폴백 해석에만 쓴다(대상은 서버가 지목한다).
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { /* */ }
  const cwd = (input && typeof input.cwd === "string" && input.cwd) ? input.cwd : process.cwd();
  // PostToolUse 로도 돌기 때문에(#3787 — Stop 만으론 턴 하나가 통째로 싱크 지연) 이벤트를 구분한다.
  //  Stop 은 한 턴에 한 번이라 무조건 돌고, PostToolUse 는 아래 ⑶ 선검사·자기제한을 통과해야 돈다.
  const perTool = String(input.hook_event_name || input.hookEventName || "") === "PostToolUse";

  // 2) 게이트웨이 base + 토큰 — 해석보다 먼저다(서버에 물어야 하므로).
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  // 남은 예산 — 모든 네트워크는 이 안에서 끝난다(위 DEADLINE_MS 주석: SIGKILL 되면 충돌 기록을 못 남긴다).
  const left = () => startedAt + DEADLINE_MS - Date.now();
  const jfetch = async (p, opts = {}) => {
    const budget = Math.min(REQ_TIMEOUT_MS, left());
    if (budget <= 0) throw new Error("시간 예산 소진");   // 남은 건 다음 턴에
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), budget);
    try { return await fetch(base + p, { ...opts, signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS, ...(opts.headers || {}) } }); }
    finally { clearTimeout(t); }
  };

  // ── 3) 상태 파일 — 실행 세션 단위. **직전 해석 결과(projDir)를 품는다.** ──
  //  🔴 왜 projDir 을 캐시하나: 이 훅은 PostToolUse 로도 돈다(Bash 포함). 서버 조회를 선검사보다 먼저 두면
  //   **도구를 쓸 때마다 게이트웨이 왕복**이 붙는다 — 한 턴에 Bash 를 100번 쓰면 왕복 100회다. 바뀐 게 없는
  //   흔한 경우에 네트워크를 0으로 만들려면 «어느 폴더를 볼지»를 네트워크 없이 알아야 하고, 그 답이 이 캐시다.
  //   소속이 턴 중에 바뀌면 캐시는 낡지만, 그때는 조기 종료가 한 번 헛돌 뿐이고 **Stop 판이 매 턴 전체 해석을
  //   다시 한다** — 낡음의 비용이 «한 사이클 늦음» 으로 유계다.
  const execId = executionSessionId(input);
  const statePath = path.join(os.tmpdir(), "lively-hooks", `push-${(execId || "anon").replace(/[^A-Za-z0-9._-]/g, "_")}.state`);
  const prevState = (() => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; } })();

  // 걷기 — 실측 0.02~0.13ms(레포 서브트리·닷파일은 안 걷는다), 자료 1,000건이어도 ~9ms.
  const walkOf = async (dir) => {
    const t0 = Date.now();
    const l = await localFiles(dir);
    return { local: l, walkMs: Date.now() - t0, stamp: l.files.reduce((a, f) => (f.mtime > a ? f.mtime : a), 0) + ":" + l.present.size };
  };

  // 3-a) 🔴 PostToolUse 저지연 경로 — **네트워크 앞에서** 끝낸다.
  //  · 지난 성공 이후 로컬이 그대로면 올릴 것이 없다 → 즉시 종료(왕복 0).
  //  · 걷기가 느린 폴더(자료 수천 건)면 스스로 물러나 최소 간격을 둔다 — 놓친 건 Stop 이 쓸어담는다.
  //  ⚠ Stop 은 이 경로를 타지 않는다. 로컬이 그대로여도 서버는 바뀔 수 있고(남이 중앙에서 문서를 지움) 그건
  //   push 가 충돌로 보고해야 할 사건이다 — 매 턴 대조하지 않으면 조용히 묻힌다(project-bidi.test.mjs ⑥).
  let pre = null;
  if (perTool && prevState && prevState.proj_dir && fs.existsSync(prevState.proj_dir)) {
    if (Number(prevState.walk_ms) > SLOW_WALK_MS && Date.now() - Number(prevState.at || 0) < SLOW_MIN_INTERVAL_MS) return;
    pre = await walkOf(prevState.proj_dir);
    if (pre.stamp === prevState.stamp && prevState.pushed_clean) return;   // 로컬 무변경 → 네트워크 안 탄다
  }

  // 3-b) 대상 해석 — 서버가 권위, 실패 시 마커 캐시. push 는 both 에서만 돈다(사람이 그렇게 정한 폴더).
  const target = (await askServer(jfetch, execId, process.env.LIVELY_NODE_ID)) ?? fromCache(cwd);
  if (!target || !target.projectId || !target.projDir) return;
  // 서버가 canonical 슬롯을 지목했는데 cwd 가 이미 이 프로젝트의 구 work.mjs 폴더 안이면 그쪽이 이긴다.
  if (target.slot) { const legacy = legacyDirForCwd(cwd, target.projectId); if (legacy) { target.projDir = legacy; target.slot = false; } }
  const { projectId, projDir } = target;
  if (target.mode !== "both") return;
  if (!fs.existsSync(projDir)) return;                  // 올릴 폴더가 없다 — 만들지 않는다(push 는 읽기에서 시작한다)
  const lastPull = Number((readMarker(projDir) || {}).last_pull) || 0;

  // 선검사에서 **같은 폴더를** 이미 걸었으면 그 결과를 쓴다(두 번 걷지 않는다).
  const walked = (pre && prevState && prevState.proj_dir === projDir) ? pre : await walkOf(projDir);
  const { local, walkMs, stamp } = walked;
  const saveState = (extra) => {
    try { fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(statePath, JSON.stringify({ stamp, at: Date.now(), walk_ms: walkMs, proj_dir: projDir, ...extra })); } catch { /* 무해 */ }
  };

  // 5) 서버 매니페스트 — '남이 그 사이 고쳤나'를 판정할 유일한 근거.
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const server = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((f) => [nk(f.path), f]));

  const led = readLedger(projDir);
  const ledger = led.files, tombs = led.tombs;
  // 🔴 서버·로컬 어느 쪽이든 전체를 못 봤으면 '서버에 없음'/'로컬에 없음'이 **'안 보임'과 구분되지 않는다**.
  //  그 상태에서 신규 판정(→덮어쓰기)도 삭제 판정(→지우기)도 하면 안 된다. 수정분 올리기는 여전히 안전하다
  //  (매니페스트에 **있는** 파일만 근거로 삼으므로).
  const complete = !manifest.truncated && !local.truncated;

  // 6) 판정 — 올릴 것 / 충돌
  const push = [], conflicts = [], tombDrop = [];
  for (const f of local.files) {
    if (f.size > MAX_BYTES) continue;
    if (SERVER_OWNED.has(f.path)) continue;                          // 서버 생성물 — 위 SERVER_OWNED 주석 참조
    const key = nk(f.path);                                          // 서버·원장 대조는 정본 키로(#1278b)
    const s = server.get(key);
    if (!s) {
      // 서버에 없다 — **세 가지가 이 모습이다**: ① 진짜 새 문서 ② 남이 중앙에서 지운 문서를 우리가 아직 들고 있는 것
      // ③ 매니페스트 상한에 잘려 안 보이는 서버 문서. ②③ 을 ① 로 오인해 올리면 각각 **남의 삭제를 되살리고**,
      // **남의 최신본을 우리 옛본으로 덮는다**. 원장과 truncated 가 셋을 가른다.
      if (!complete) continue;                                       // ③ 가능성 — 모르면 안 올린다
      // ② 기준선이 있다 = 한때 서버에서 받은 파일이다. 그 기준선은 **두 자리에** 있을 수 있다:
      //   files — 아직 원장에 남아 있음(pull 이 삭제를 아직 못 봄. 지운 파일이 최신이었으면 manifest.newest 가
      //           내려가 pull 이 `newest <= last_pull` 로 조기 종료하므로 이 상태가 오래 간다)
      //   tombs — pull 이 「서버에서 사라진 걸 봤다」고 옮겨 적음(#3787 — 원장 재작성에도 안 지워진다)
      //  판정은 **한 규칙**이다: 로컬이 기준선 그대로면 «중앙이 지운 그 파일» 이라 안 올리고, 다르면
      //  «삭제 뒤 로컬에서 새로 쓴 것» 이라 올린다. 두 자리를 다르게 판정하면 같은 상황이 pull 타이밍에 따라
      //  갈린다 — 그게 지금 «로컬에서 고쳤는데 영영 안 올라가는» 자리였다.
      const baseline = ledger[key] || tombs[key];
      if (baseline) {
        if (f.size === baseline.size && f.mtime === baseline.mtime) {
          conflicts.push({ path: f.path, why: "받아둔 문서인데 서버에서 사라짐(중앙에서 삭제된 듯) — 되살리지 않고 로컬에 그대로 둠(올리려면 파일을 고치세요)", held_mtime: baseline.mtime, last_pull: lastPull });
          continue;
        }
        if (tombs[key]) tombDrop.push(key);                          // 고쳤다 → 묘비를 걷고 올린다
      }
      push.push(f);                                                  // ① 진짜 새 문서(기준선 없음) 또는 삭제 뒤 새로 씀
      continue;
    }
    if (f.size === s.size && f.mtime <= s.mtime) continue;           // 로컬이 서버와 같거나 더 옛것 → 할 일 없음
    // 여기부터 로컬이 서버와 다르다. 서버가 우리 기준선 이후로 바뀌었으면 **남이 고친 것**이다.
    if (s.mtime > lastPull) { conflicts.push({ path: f.path, why: "서버도 우리가 마지막으로 받은 뒤에 바뀜(남의 작업일 수 있음)", server_mtime: s.mtime, local_mtime: f.mtime, last_pull: lastPull }); continue; }
    push.push(f);                                                    // 로컬만 바뀜 → 안전하게 올린다
  }

  // 7) 판정 — 지울 것. **원장에 있는 것만** 후보다(= pull 이 실제로 받아준 것 = '한때 우리가 들고 있던 것').
  const del = [], ledgerDrop = [], ledgerDropAfterPush = [];
  if (complete) {
    for (const [p, baseline] of Object.entries(ledger)) {
      if (!baseline || typeof baseline.mtime !== "number") continue; // 기준선이 온전치 않으면 판정 불가
      if (local.present.has(p)) continue;                            // 로컬에 있다 — 삭제가 아니다
      if (local.skipped.some((pre) => p.startsWith(pre))) continue;  // git 서브트리 밑 — '없음'이 아니라 '안 봄'
      if (SERVER_OWNED.has(p)) continue;                             // 서버 생성물 — 지우면 규칙이 사라진다
      const s = server.get(p);
      if (!s) { ledgerDrop.push(p); continue; }                      // 서버에도 이미 없다 — 원장만 정리
      // 서버가 우리가 받은 그 버전 **그대로**일 때만 지운다. 한 톨이라도 다르면 남이 손댄 것이다.
      if (s.mtime !== baseline.mtime || s.size !== baseline.size) {
        conflicts.push({ path: p, why: "로컬에서 지웠지만 서버본이 우리가 받은 뒤 바뀜(남의 작업) — 지우지 않음", server_mtime: s.mtime, held_mtime: baseline.mtime });
        continue;
      }
      del.push({ key: p, path: s.path });   // 서버가 준 실제 경로로 지운다(정본 키와 다를 수 있다)
    }
  }

  // 8) 업로드(원자적 PUT — 서버가 임시파일→rename, #797) → 삭제. 개별 실패는 다음 턴 재시도.
  //    상한(MAX_PUSH)·데드라인에 걸려 못 한 건 **개수를 남긴다** — 조용히 잘리면 "다 올라갔다"로 읽힌다.
  const todo = push.length + del.length;
  const ledgerSet = {};   // 올리기 성공분의 새 기준선 — 아래 ⑨ 에서 원장에 반영
  let pushed = 0, deleted = 0, failed = 0;
  for (const f of push.slice(0, MAX_PUSH)) {
    if (left() <= 0) break;
    try {
      const body = await fsp.readFile(f.abs);
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(nk(f.path))}`, {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body,
      });
      if (!r.ok) { failed++; continue; }
      pushed++;
      // 🔴 올린 뒤 **로컬 mtime 을 서버 결과값에 맞추고 기준선으로 적는다** — pull 이 다운로드 후 utimes 로 하는 것과
      //  대칭이다. 불변식: *성공적으로 싱크된 파일은 로컬 mtime == 서버 mtime == 기준선 mtime*. 어긋난 것만이 변경이다.
      //  이걸 안 하면 우리가 올린 파일이 영원히 '기준선과 다른 로컬'로 남아 → 다음 pull 이 보호(=수렴 불가) → 그다음
      //  push 가 자기 업로드를 '남의 변경'으로 오인해 **영구 거짓 충돌**을 낸다. 같은 파일 두 번 고치는 게 안 된다는 뜻.
      const meta2 = await r.json().catch(() => ({}));
      if (typeof meta2.mtime === "number") {
        const t = new Date(meta2.mtime);
        try { fs.utimesSync(f.abs, t, t); } catch { /* 실패해도 아래 기준선이 안 맞을 뿐 — 다음 pull 이 바로잡는다 */ }
        ledgerSet[nk(f.path)] = { mtime: meta2.mtime, size: typeof meta2.size === "number" ? meta2.size : f.size };
      } else {
        // 구 게이트웨이(mtime 미반환) → 기준선을 **모른다**. 거짓 기준선을 적느니 지운다(원장 없음 = fail-safe).
        //  다음 pull 이 종전 휴리스틱으로 받아가며 기준선을 다시 세운다.
        ledgerDropAfterPush.push(nk(f.path));
      }
    } catch { failed++; }
  }
  for (const d of del.slice(0, MAX_DELETE)) {
    if (left() <= 0) break;
    try {
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(d.path)}`, { method: "DELETE" });
      if (r.ok) { deleted++; ledgerDrop.push(d.key); } else failed++;
    } catch { failed++; }
  }

  // 9) 원장 갱신 — **우리가 방금 확인한 것만** 손댄다.
  //    · 올리기 성공분 → 서버가 돌려준 결과값을 기준선으로(위 ⑧ 불변식). 이건 '받은 적 있다'가 아니라
  //      '지금 서버본이 곧 우리 것'이라 과다 주장이 아니다 — 서버가 그 바이트를 갖고 있다고 방금 응답했다.
  //    · 사라진 게 확실한 것(서버에도 없음 · 우리가 지움) → 제거. 안 빼면 우리가 지운 파일이 원장에 남고,
  //      삭제로 서버 newest 가 낮아져 pull 이 조기 종료하면 영영 남는다.
  if (ledgerDrop.length || ledgerDropAfterPush.length || tombDrop.length || Object.keys(ledgerSet).length) {
    try {
      const next = { ...ledger, ...ledgerSet };
      for (const p of [...ledgerDrop, ...ledgerDropAfterPush]) delete next[p];
      const nextTombs = { ...tombs };
      for (const p of tombDrop) delete nextTombs[p];                 // 고쳐서 올렸다 → 묘비 해제
      for (const p of Object.keys(ledgerSet)) delete nextTombs[p];   // 올라간 건 더 이상 묘비가 아니다
      writeLedger(projDir, next, nextTombs);
    } catch { /* 실패는 무해 — 다음 pull 이 다시 쓴다 */ }
  }

  // 10) 결과를 사람이 볼 수 있게 남긴다(호스트 로컬 — 동기화 안 됨). 충돌은 **조용히 사라지면 안 된다**:
  //    자동 up 은 확인할 사람이 없으므로(수동 업로드의 #877 confirm 과 다름) 기록이 유일한 표면이다.
  //    `lively status` 가 이 파일을 읽어 보여준다. **해결된 충돌이 남아 보이면 안 되므로** 조건 없이 덮어쓴다
  //    (여기까지 왔다는 건 판정을 끝냈다는 뜻 — 그때의 결론이 곧 현재 상태다).
  try {
    await fsp.writeFile(path.join(projDir, ".lively", "sync-up.json"),
      JSON.stringify({
        at: new Date().toISOString(), pushed, deleted, failed,
        remaining: Math.max(0, todo - pushed - deleted - failed),   // 상한·데드라인에 걸려 다음 턴으로 밀린 것
        conflicts,
      }, null, 2) + "\n");
  } catch { /* 기록 실패는 무해 */ }

  // 11) 선검사 상태 저장(#3787) — **완주했을 때만** pushed_clean 을 세운다. 남은 게 있는데 clean 으로 적으면
  //    다음 PostToolUse·Stop 이 "로컬 무변경" 으로 오판해 밀린 업로드를 영영 안 한다(워터마크 규율과 같은 자).
  saveState({ pushed_clean: failed === 0 && todo - pushed - deleted === 0 });
})().then(() => process.exit(0)).catch(() => process.exit(0));
