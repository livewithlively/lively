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

const SYNC_MODES = ["none", "pull", "both"];
function syncMode(meta) {
  const m = String((meta && meta.sync) || "").trim().toLowerCase();
  return SYNC_MODES.includes(m) ? m : null;   // 미명시 → null(= up 안 함. 옵트인이 아니면 안 올린다)
}

// ── 싱크 원장 — pull 훅이 "실제로 받아서 지금 보유 중인 서버 파일"을 적어둔 것. 삭제·신규 판정의 유일한 근거. ──
//  없음·깨짐 → 빈 원장 → 삭제 전파 0 · 서버에 없는 로컬 파일은 전부 '신규'로 취급(C3 이전과 동일) = fail-safe.
// 동기화 비교 키는 **NFC 정본**이다(#1278b) — pull 훅과 같은 규칙. 맥 readdir 은 NFD 를 돌려주므로(실측)
//  로컬 walk 결과를 서버 매니페스트와 바이트 비교하면 전량이 '새 파일'로 보여 재업로드·중복이 난다.
//  ⚠ 접는 건 **키만**이다 — 디스크 읽기는 실제 로컬 이름(f.abs)으로, 서버 삭제는 서버가 준 실제 경로로 한다.
const nk = (p) => String(p ?? "").normalize("NFC");

function readLedger(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "sync-ledger.json"), "utf8"));
    const files = (o && o.files && typeof o.files === "object" && !Array.isArray(o.files)) ? o.files : {};
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [nk(k), v]));   // 구 원장(NFD 키)도 여기서 접힌다
  } catch { return {}; }
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
  const startedAt = Date.now();
  // 1) cwd — Stop 이벤트 stdin JSON 의 cwd 우선.
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let cwd = process.cwd();
  try { const o = JSON.parse(stdinData || "{}"); if (o && typeof o.cwd === "string" && o.cwd) cwd = o.cwd; } catch { /* */ }

  // 2) 마커 상향탐색(리더 전원 40단계 계약). 없으면 no-op.
  let dir = path.resolve(cwd), marker = null, projDir = null;
  for (let i = 0; i < 40; i++) {
    const m = path.join(dir, ".lively", "project.json");
    if (fs.existsSync(m)) { marker = m; projDir = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!marker) return;

  let meta; try { meta = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { return; }
  const projectId = meta && meta.project_id;
  if (!projectId) return;

  // 3) 🔴 옵트인 게이트 — both 만 올린다. 기존 설치(none/pull/미명시) 전원 무영향.
  if (syncMode(meta) !== "both") return;

  const lastPull = Number(meta.last_pull) || 0;

  // 4) 게이트웨이 base + 토큰
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
    try { return await fetch(base + p, { ...opts, signal: ctl.signal, headers: { authorization: "Bearer " + token, ...(opts.headers || {}) } }); }
    finally { clearTimeout(t); }
  };

  // 5) 서버 매니페스트 — '남이 그 사이 고쳤나'를 판정할 유일한 근거.
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const server = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((f) => [nk(f.path), f]));

  const ledger = readLedger(projDir);
  const local = await localFiles(projDir);
  // 🔴 서버·로컬 어느 쪽이든 전체를 못 봤으면 '서버에 없음'/'로컬에 없음'이 **'안 보임'과 구분되지 않는다**.
  //  그 상태에서 신규 판정(→덮어쓰기)도 삭제 판정(→지우기)도 하면 안 된다. 수정분 올리기는 여전히 안전하다
  //  (매니페스트에 **있는** 파일만 근거로 삼으므로).
  const complete = !manifest.truncated && !local.truncated;

  // 6) 판정 — 올릴 것 / 충돌
  const push = [], conflicts = [];
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
      if (ledger[key]) { conflicts.push({ path: f.path, why: "받아둔 문서인데 서버에서 사라짐(중앙에서 삭제된 듯) — 되살리지 않고 로컬에 그대로 둠", last_pull: lastPull }); continue; } // ②
      push.push(f);                                                  // ① 진짜 새 문서
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
  if (ledgerDrop.length || ledgerDropAfterPush.length || Object.keys(ledgerSet).length) {
    try {
      const next = { ...ledger, ...ledgerSet };
      for (const p of [...ledgerDrop, ...ledgerDropAfterPush]) delete next[p];
      fs.writeFileSync(path.join(projDir, ".lively", "sync-ledger.json"),
        JSON.stringify({ v: 1, at: new Date().toISOString(), files: next }, null, 2) + "\n");
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
})().then(() => process.exit(0)).catch(() => process.exit(0));
