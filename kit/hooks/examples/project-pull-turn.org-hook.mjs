// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록(#828).
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 프롬프트마다 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: SessionStart 의 project-pull 과 같은 단방향 공유폴더 pull 을 '턴마다'(프롬프트 제출 시) 수행해,
//   세션 도중 웹에서 올린 문서가 바로 다음 턴에 로컬로 내려오게 한다(#828 — 세션 중 동기화 갭 해소).
//  SessionStart 판과의 차이:
//   ① 매 턴 도므로, 변경이 없으면 매니페스트 1회 조회로 즉시 종료(턴당 비용 최소 — newest<=last_pull 게이트).
//   ② 다운로드에 시간예산(BUDGET_MS)을 둬 큰 변경이 턴을 오래 막지 않게 한다 — 예산 초과 시 부분만 받고
//      last_pull 을 올리지 않아 다음 턴이 이어서 마저 받는다(개별 파일은 크기·mtime 일치 시 스킵 → 재시도 안전).
//  불변식: 절대 프롬프트를 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만 — 컨텍스트 주입 안 함).
//  전제(#828): 매니페스트가 provision 레포/워크트리를 제외해 작게 유지될 때 턴당 비용이 낮다(project-routes.ts).
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


const BUDGET_MS = 8000; // 턴 지연 상한 — 넘기면 부분만 받고 다음 턴에 이어받는다.

// ── 싱크 모드 게이트(#905 P1-②) — SessionStart 판(project-pull)과 **동일 규칙**. 근거·배경은 그 훅 주석 참조. ──
//  이 판은 **매 턴** 도므로 게이트가 없으면 사용자 폴더 파괴 창이 '세션당 1회'가 아니라 '턴당 1회'가 된다.
const SYNC_MODES = ["none", "pull", "both"];
function livelyOwnedDir(projDir, projectId) {
  const parent = path.dirname(projDir);
  return path.basename(projDir) === String(projectId)
    && path.basename(parent) === "projects"
    && path.basename(path.dirname(parent)) === "lively";
}
function syncMode(meta, projDir, projectId) {
  const m = String((meta && meta.sync) || "").trim().toLowerCase();
  if (SYNC_MODES.includes(m)) return m;
  return livelyOwnedDir(projDir, projectId) ? "pull" : "none";
}

// ── 싱크 원장(#905 C3) — SessionStart 판(project-pull)과 **동일**. 근거·배경은 그 훅 주석 참조. sync="both" 전용. ──
//  이 판이 특히 중요한 이유: pull 은 매 턴, push 는 턴 끝(Stop)에 돈다 → **pull 이 항상 push 보다 먼저**다.
//  원장 없이는 이 훅이 '크기가 다르다'는 이유로 아직 안 올라간 로컬 편집을 매 턴 덮어 없앤다.
function readLedger(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "sync-ledger.json"), "utf8"));
    return (o && o.files && typeof o.files === "object" && !Array.isArray(o.files)) ? o.files : {};
  } catch { return {}; }
}
function writeLedger(projDir, files) {
  try {
    fs.writeFileSync(path.join(projDir, ".lively", "sync-ledger.json"),
      JSON.stringify({ v: 1, at: new Date().toISOString(), files }, null, 2) + "\n");
  } catch { /* 실패는 무해 — 원장 없음은 fail-safe 쪽이다 */ }
}
function untouched(st, base) {
  // st=null 방어: 이 훅은 모든 예외를 삼키고 exit 0 하므로(무음 계약) TypeError 하나가 곧 '싱크가 조용히 멈춤'이다.
  return !!base && !!st && st.size === base.size && Math.floor(st.mtimeMs) === base.mtime;
}

(async () => {
  const startedAt = Date.now();
  // 1) cwd — UserPromptSubmit 이벤트 stdin JSON 의 cwd 우선, 없으면 process.cwd()
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let cwd = process.cwd();
  try { const o = JSON.parse(stdinData || "{}"); if (o && typeof o.cwd === "string" && o.cwd) cwd = o.cwd; } catch { /* */ }

  // 2) cwd 에서 위로 .lively/project.json 탐색. 없으면 no-op(비프로젝트 세션).
  let dir = path.resolve(cwd), marker = null, projDir = null;
  for (let i = 0; i < 40; i++) {
    const m = path.join(dir, ".lively", "project.json");
    if (fs.existsSync(m)) { marker = m; projDir = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!marker) return; // 프로젝트 세션 아님

  let meta; try { meta = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { return; }
  const projectId = meta && meta.project_id;
  const lastPull = Number(meta && meta.last_pull) || 0;
  if (!projectId) return;

  // 2-b) 🔴 쓰기 자격 게이트 — 싱크 대상이 아니면 여기서 끝(턴당 네트워크 비용도 0).
  const mode = syncMode(meta, projDir, projectId);
  if (mode === "none") return;

  // 3) 게이트웨이 base + 토큰 (session-preload/run-custom 와 동일 출처)
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

  // 4) 매니페스트 → newest <= last_pull 이면 즉시 종료(변경 없음 — 턴마다 도는 비용의 핵심 최소화 지점)
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if ((manifest.newest || 0) <= lastPull) return; // pull 불필요

  // 5) 변경분만 다운로드(단방향). 시간예산 초과 시 부분만 받고 중단 → completed=false → last_pull 미갱신 → 다음 턴 이어받기.
  const ledger = mode === "both" ? readLedger(projDir) : null;   // both 전용 — pull 모드는 기존 동작 그대로
  const held = {};
  let completed = true;
  // 🔴 매니페스트가 상한에 잘렸으면 **전량 수렴을 주장할 수 없다** — newest 는 목록 밖 파일의 mtime 까지 반영할 수
  //  있어, last_pull 을 올리면 "s.mtime <= last_pull ⟹ 우리가 그 버전을 갖고 있다"(push 충돌검사의 근거)가 거짓이 된다.
  if (manifest.truncated) completed = false;
  for (const f of files) {
    if (Date.now() - startedAt > BUDGET_MS) { completed = false; break; }
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    let local = null;
    try { local = fs.statSync(dest); } catch { /* 로컬 없음 */ }
    const base = ledger ? ledger[f.path] : null;
    if (ledger && !base) {
      // ── 기준선 없음 = 서버본을 **받은 적 없음**. SessionStart 판(project-pull)과 **동일 규칙**, 근거는 그 주석 참조.
      //  요지: 얕은 추측으로 원장에 적으면 그 거짓이 곧 **남의 서버 문서 삭제**가 된다.
      if (local && local.size === f.size && Math.floor(local.mtimeMs) === f.mtime) {
        held[f.path] = { mtime: f.mtime, size: f.size };   // mtime 이 ms 까지 정확히 일치 = pull 이 찍은 것(원장 유실 자기치유)
        continue;
      }
      if (local) { completed = false; continue; }          // 공통 조상 없는 두 판본 → 아무것도 안 함(push 가 충돌 보고)
      // 로컬에 없다 → 받아서 기준선을 세운다.
    } else if (base) {
      // ── 3-way(기준선·로컬·서버) — SessionStart 판(project-pull)과 **동일 규칙**. 근거는 그 훅 주석 참조.
      //  요지: 크기·시각으로 동일성을 추측하면 **같은 크기의 다른 내용**을 '동일'로 오판해 워터마크를 올리고,
      //  그러면 push 의 충돌검사가 뚫려 남의 최신본이 덮인다. 기준선이 있으면 추측할 필요가 없다.
      const serverChanged = base.mtime !== f.mtime || base.size !== f.size;
      if (!local) {
        if (!serverChanged) { held[f.path] = base; continue; }   // 우리가 지웠다 · 서버 그대로 → push 가 전파
        // 서버가 바뀌었으면 우리 삭제는 push 에서 충돌로 막히고 보고된다 → 최신본은 받아준다(안 받으면 영영 못 본다)
      } else if (!untouched(local, base)) {
        held[f.path] = base; if (serverChanged) completed = false; continue;                 // 내 편집 → 보호
      } else if (!serverChanged) { held[f.path] = base; continue; }                          // 셋 다 같다
      // 로컬은 받은 그대로 · 서버만 바뀜 → 받는다.
    } else {
      // 원장 없음(pull 모드) → 종전 휴리스틱 그대로(서버가 정본이고 삭제 전파도 없어 추측이 무해).
      if (local && local.size === f.size && Math.floor(local.mtimeMs) >= f.mtime) continue;
    }
    try {
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`);
      if (!r.ok) { completed = false; continue; } // 실패분이 있으면 last_pull 미갱신 → 다음 턴 재시도(영구 누락 방지)
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      if (f.mtime) { try { const tt = new Date(f.mtime); fs.utimesSync(dest, tt, tt); } catch { /* */ } }
      if (ledger) held[f.path] = { mtime: f.mtime, size: f.size };
    } catch { completed = false; } // 개별 파일 실패 → last_pull 미갱신 → 다음 턴 재시도
  }

  // 6) 원장 갱신(both 전용) — 완주 시 통째 교체(서버에서 사라진 항목 정리), 예산·실패로 끊겼으면 도달분만 병합.
  if (ledger) writeLedger(projDir, completed ? held : { ...ledger, ...held });

  // 7) 전량 완료했을 때만 last_pull 갱신 — 예산으로 끊겼으면 다음 턴이 이어받도록 그대로 둔다.
  if (completed) { try { meta.last_pull = manifest.newest || lastPull; fs.writeFileSync(marker, JSON.stringify(meta, null, 2) + "\n"); } catch { /* */ } }
})().then(() => process.exit(0)).catch(() => process.exit(0));
