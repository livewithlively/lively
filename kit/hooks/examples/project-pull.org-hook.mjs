// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=SessionStart, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 프로젝트 세션이면 공유폴더를 게이트웨이에서 pull(단방향). 마커 없으면 no-op(비프로젝트 세션).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만 — 컨텍스트 주입 안 함).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
