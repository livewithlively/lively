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

// ── 싱크 모드 게이트(#905 P1-②) — 이 폴더에 서버 파일을 쓸 자격이 있는가. ──
//  배경(왜 이게 없으면 사고인가): 이 훅은 cwd 에서 **위로 40단계** 마커를 찾고, 찾은 폴더에 매니페스트 파일을
//   '크기가 다르면' 덮어쓴다 — 그리고 stdout 을 안 내므로 **완전 무음**이다. 지금껏 안 터진 유일한 이유는
//   마커가 **라이블리가 만든 폴더에만** 있었기 때문이다(workspace/project/<id> · ~/lively/projects/<id> —
//   덮어써도 원래 서버가 정본이라 무해). 그런데 `lively init`(C2a)의 존재 이유가 **사용자 자기 폴더에 마커를
//   심는 것**이라 그 불변식이 깨진다 → 사용자의 CLAUDE.md/AGENTS.md 가 조용히 날아간다.
//  그래서 마커가 스스로 "나는 싱크 대상"이라고 말할 때만 쓴다: sync = none(안 씀) | pull(받기) | both(양방향, C3).
const SYNC_MODES = ["none", "pull", "both"];
// sync 없는 **구 마커** 전용 폴백 — work.mjs 가 만드는 `~/lively/projects/<id>` 인가.
//  이 한 꼴만 인정하는 이유: 라이블리 폴더 중 **경로 모양이 고정된 건 이것뿐**이다. 박스 폴더
//  (<shared>/project/<folder>)는 folder 값이 임의라(실측: 'project/관리탭 수정' 같은 이름 기반이 실재) 구조로
//  못 알아본다. 그렇다고 "부모가 project/projects 면 소유"로 넓히면 흔한 사용자 경로 `~/projects/<무언가>` 가
//  걸려 **무음 파괴**가 난다 — 넓히는 쪽의 실패는 비가역이다. 박스 폴더는 대신 서버가 부팅 때 마커에 sync 를
//  직접 stamp 한다(backfillMarkerSync, project-fs.ts) → 폴백이 필요 없다.
//  grandparent 가 'lively' 여야 함에 주의: `~/projects/905`(사용자 코드)와 `~/lively/projects/905`(work.mjs)를 가른다.
function livelyOwnedDir(projDir, projectId) {
  const parent = path.dirname(projDir);
  return path.basename(projDir) === String(projectId)
    && path.basename(parent) === "projects"
    && path.basename(path.dirname(parent)) === "lively";
}
// 마커의 sync 가 우선. 없으면(구 마커) 위 폴백으로 **fail-safe** 판정 — 모르면 안 쓴다.
//  (work.mjs·서버 마커 writer 가 앞으로 sync 를 명시하므로 이 폴백은 구 마커 전용 과도기 경로다.)
function syncMode(meta, projDir, projectId) {
  const m = String((meta && meta.sync) || "").trim().toLowerCase();
  if (SYNC_MODES.includes(m)) return m;
  return livelyOwnedDir(projDir, projectId) ? "pull" : "none";
}

// ── 싱크 원장(#905 C3) — "서버에서 받아 지금 보유 중인 파일"의 기준선. sync="both" 전용. ──
//  왜 pull 이 이걸 쓰는가: both 폴더에선 로컬도 정본 작성자다. 원장이 없으면 pull 은 '크기가 다르다'는 이유로
//   **아직 안 올라간 로컬 편집을 덮어써** 없앤다(pull 이 push 보다 먼저 돈다 — UserPromptSubmit → Stop).
//   원장과 로컬이 정확히 일치 = 받은 뒤 손 안 댔다 → 서버본으로 갱신해도 잃을 게 없다. 다르면 = 우리가 고쳤다
//   → 건드리지 않고 push 훅에 맡긴다(거기서 올리거나 충돌로 보고한다).
//  pull 모드는 서버가 정본이므로 이 보호가 없다(기존 동작 그대로 — 원장도 안 만든다).
function readLedger(projDir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(projDir, ".lively", "sync-ledger.json"), "utf8"));
    return (o && o.files && typeof o.files === "object" && !Array.isArray(o.files)) ? o.files : {};
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
  // 1) cwd — SessionStart 이벤트 stdin JSON 의 cwd 우선, 없으면 process.cwd()
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let cwd = process.cwd();
  try { const o = JSON.parse(stdinData || "{}"); if (o && typeof o.cwd === "string" && o.cwd) cwd = o.cwd; } catch { /* */ }

  // 2) cwd 에서 위로 .lively/project.json 탐색(git 의 .git 발견과 동형). 없으면 no-op.
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

  // 2-b) 🔴 쓰기 자격 게이트 — 이 폴더가 싱크 대상이 아니면 **여기서 끝**(네트워크도 안 탄다).
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
    try { return await fetch(base + p, { signal: ctl.signal, headers: { authorization: "Bearer " + token } }); }
    finally { clearTimeout(t); }
  };

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
    const base = ledger ? ledger[f.path] : null;
    if (ledger && !base) {
      // ── 기준선이 없다 = 이 경로의 서버본을 **받은 적이 없다**(원장은 받은 것만 적는다). ──
      //  🔴 여기서 "크기 같고 로컬이 더 최신이면 이미 받은 것"이라 **추측하면 안 된다**: 원장이 거짓이 되고,
      //   원장은 삭제 전파의 유일한 근거라 사용자가 자기 파일을 지우는 순간 **남의 서버 문서가 지워진다**
      //   (0바이트 TODO.md 처럼 이름·크기 충돌은 흔하다 — 파일이 이미 있는 폴더를 바인딩하는 게 이 기능의 목적이다).
      if (local && local.size === f.size && Math.floor(local.mtimeMs) === f.mtime) {
        // mtime 이 **밀리초까지 정확히** 서버와 같고 크기도 같다 = pull 이 utimes 로 찍어둔 것 = 우리가 받은 것이다.
        //  (원장만 유실된 경우의 자기치유 경로. `>=` 가 아니라 `===` 인 게 핵심 — 우연히 일치할 값이 아니다.)
        held[f.path] = { mtime: f.mtime, size: f.size };
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
        if (!serverChanged) { held[f.path] = base; continue; }
        // 서버가 그 사이 바뀌었으면 우리 삭제는 push 에서 충돌로 막히고 **보고된다**. 그 최신본은 받아준다 —
        //  안 받으면 사용자는 그 파일을 영영 못 보고 충돌만 남는다(되돌릴 방법 없음). 받은 뒤 다시 지우면
        //  그땐 기준선이 서버와 같으므로 삭제가 정상 전파된다.
      } else if (!untouched(local, base)) {
        // 🔴 받은 뒤 로컬에서 고쳤다 → **덮지 않는다**(아직 안 올라간 편집 — push 가 올리거나 충돌로 보고).
        held[f.path] = base;
        if (serverChanged) completed = false;   // 양쪽 다 바뀜 = 충돌. 워터마크를 올리면 push 검사가 뚫린다.
        continue;
      } else if (!serverChanged) { held[f.path] = base; continue; }   // 셋 다 같다 — 할 일 없음
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
      if (ledger) held[f.path] = { mtime: f.mtime, size: f.size };
    } catch { completed = false; } // 개별 파일 실패 → last_pull 미갱신 → 다음 세션 재시도
  }

  // 6) 원장 갱신(both 전용) — 완주했으면 통째 교체(서버에서 사라진 항목은 자연히 빠진다), 끊겼으면 도달분만 병합.
  //    "안 받은 걸 받았다고 주장하지 않는다" — 원장은 삭제 전파의 유일한 근거라 과다 주장이 곧 파괴다.
  if (ledger) writeLedger(projDir, completed ? held : { ...ledger, ...held });

  // 7) 마커 last_pull 갱신 — **전량 수렴했을 때만**(UserPromptSubmit 판과 동일 규칙). 실패분이 있는데 올리면
  //    그 파일은 서버가 또 바뀔 때까지 영구 누락되고, 더 나쁘게는 push 의 충돌검사 기준선이 거짓이 된다.
  if (completed) { try { meta.last_pull = manifest.newest || lastPull; fs.writeFileSync(marker, JSON.stringify(meta, null, 2) + "\n"); } catch { /* */ } }
})().then(() => process.exit(0)).catch(() => process.exit(0));
