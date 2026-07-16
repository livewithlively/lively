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
  if (syncMode(meta, projDir, projectId) === "none") return;

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
  for (const f of files) {
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    let need = true;
    try { const st = fs.statSync(dest); if (st.size === f.size && Math.floor(st.mtimeMs) >= f.mtime) need = false; } catch { /* 로컬 없음 */ }
    if (!need) continue;
    try {
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`);
      if (!r.ok) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      if (f.mtime) { try { const tt = new Date(f.mtime); fs.utimesSync(dest, tt, tt); } catch { /* */ } }
    } catch { /* 개별 파일 실패 무시 */ }
  }

  // 6) 마커 last_pull 갱신
  try { meta.last_pull = manifest.newest || lastPull; fs.writeFileSync(marker, JSON.stringify(meta, null, 2) + "\n"); } catch { /* */ }
})().then(() => process.exit(0)).catch(() => process.exit(0));
