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

  // 4) 매니페스트 → newest <= last_pull 이면 즉시 종료(변경 없음 — 턴마다 도는 비용의 핵심 최소화 지점)
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if ((manifest.newest || 0) <= lastPull) return; // pull 불필요

  // 5) 변경분만 다운로드(단방향). 시간예산 초과 시 부분만 받고 중단 → completed=false → last_pull 미갱신 → 다음 턴 이어받기.
  let completed = true;
  for (const f of files) {
    if (Date.now() - startedAt > BUDGET_MS) { completed = false; break; }
    const dest = path.join(projDir, f.path);
    if (path.relative(projDir, dest).startsWith("..")) continue;
    let need = true;
    try { const st = fs.statSync(dest); if (st.size === f.size && Math.floor(st.mtimeMs) >= f.mtime) need = false; } catch { /* 로컬 없음 */ }
    if (!need) continue;
    try {
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`);
      if (!r.ok) { completed = false; continue; } // 실패분이 있으면 last_pull 미갱신 → 다음 턴 재시도(영구 누락 방지)
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      if (f.mtime) { try { const tt = new Date(f.mtime); fs.utimesSync(dest, tt, tt); } catch { /* */ } }
    } catch { completed = false; } // 개별 파일 실패 → last_pull 미갱신 → 다음 턴 재시도
  }

  // 6) 전량 완료했을 때만 last_pull 갱신 — 예산으로 끊겼으면 다음 턴이 이어받도록 그대로 둔다.
  if (completed) { try { meta.last_pull = manifest.newest || lastPull; fs.writeFileSync(marker, JSON.stringify(meta, null, 2) + "\n"); } catch { /* */ } }
})().then(() => process.exit(0)).catch(() => process.exit(0));
