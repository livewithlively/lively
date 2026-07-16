// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=Stop, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록. (#905 C3 up-sync)
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 턴 끝에 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 마커 sync="both" 인 프로젝트 폴더에서, **턴 중에 로컬에서 바뀐 공유문서를 게이트웨이로 올린다**(↑up).
//   여태 공유폴더는 중앙→멤버 **단방향**이었다(pull only). 멤버가 로컬에서 문서를 고치면 아무 데도 안 갔다.
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만).
//
//  ── 안전 설계 (이 훅은 **팀 공유문서를 덮어쓸 수 있다** — 그래서 규칙이 전부다) ──
//   ① **sync="both" 일 때만 동작한다.** none/pull/미명시는 즉시 종료 = 기존 설치 전원 무영향(옵트인).
//   ② **서버가 우리 기준선 이후로 바뀐 파일은 절대 안 건드린다.** 기준선 = 마커의 last_pull(= 우리가 마지막으로
//      받아간 서버 상태). 서버 mtime > last_pull 이면 남이 고친 것 → 우리 로컬본으로 덮으면 **남의 작업이 사라진다**.
//      → 충돌로 기록만 하고 건너뛴다. "모르면 안 건드린다".
//   ③ **삭제는 전파하지 않는다(의도).** '로컬에 없음'은 '지웠음'과 '애초에 안 받았음'을 구분하지 못한다 —
//      구분하려면 별도 기준선 원장(무엇을 받았는지)이 필요하고, 그게 없는 채로 지우면 **안 받은 파일을 서버에서
//      지운다**. 되돌릴 수 없는 쪽이라 안 한다. (원장 기반 삭제 전파는 후속.)
//   ④ 대상은 **문서뿐** — 숨김(. 시작)·git 레포 서브트리는 제외한다(코드는 git 이 수렴시킨다. 서버
//      manifestFiles 의 isGitRepoRoot 제외와 동형).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BUDGET_MS = 8000;   // 턴 끝 지연 상한 — 넘기면 남은 건 다음 턴에.
const MAX_FILES = 200;    // 한 턴에 올릴 파일 상한(폭주 방어)
const MAX_BYTES = 25 * 1024 * 1024;

const SYNC_MODES = ["none", "pull", "both"];
function syncMode(meta) {
  const m = String((meta && meta.sync) || "").trim().toLowerCase();
  return SYNC_MODES.includes(m) ? m : null;   // 미명시 → null(= up 안 함. 옵트인이 아니면 안 올린다)
}

// 로컬 문서 walk — 숨김 제외 · git 레포 서브트리 제외(서버 manifestFiles 와 동형).
async function localFiles(base) {
  const out = [];
  async function walk(dir, rel, depth) {
    if (depth > 24 || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".")) continue;                       // .lively/.git/.env … 동기화 대상 아님
      const child = path.join(dir, e.name);
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        try { await fsp.stat(path.join(child, ".git")); continue; } catch { /* 레포 아님 → 들어간다 */ }
        await walk(child, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try { const st = await fsp.stat(child); out.push({ path: childRel, abs: child, size: st.size, mtime: Math.floor(st.mtimeMs) }); }
      catch { /* 읽기 불가 — 스킵 */ }
    }
  }
  await walk(base, "", 0);
  return out;
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
  const jfetch = async (p, opts = {}) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try { return await fetch(base + p, { ...opts, signal: ctl.signal, headers: { authorization: "Bearer " + token, ...(opts.headers || {}) } }); }
    finally { clearTimeout(t); }
  };

  // 5) 서버 매니페스트 — '남이 그 사이 고쳤나'를 판정할 유일한 근거.
  let manifest;
  try { const r = await jfetch(`/api/ui/v6/projects/${projectId}/shared/manifest`); if (!r.ok) return; manifest = await r.json(); }
  catch { return; }
  const server = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((f) => [f.path, f]));

  // 6) 판정 — 올릴 것 / 충돌
  const locals = await localFiles(projDir);
  const push = [], conflicts = [];
  for (const f of locals) {
    if (f.size > MAX_BYTES) continue;
    const s = server.get(f.path);
    if (!s) { push.push(f); continue; }                       // 서버에 없음 = 새 문서 → 올린다
    if (f.size === s.size && f.mtime <= s.mtime) continue;    // 로컬이 서버와 같거나 더 옛것 → 할 일 없음
    // 여기부터 로컬이 서버와 다르다. 서버가 우리 기준선 이후로 바뀌었으면 **남이 고친 것**이다.
    if (s.mtime > lastPull) { conflicts.push({ path: f.path, why: "서버도 우리가 마지막으로 받은 뒤에 바뀜(남의 작업일 수 있음)", server_mtime: s.mtime, local_mtime: f.mtime, last_pull: lastPull }); continue; }
    push.push(f);                                             // 로컬만 바뀜 → 안전하게 올린다
  }

  // 7) 업로드(원자적 PUT — 서버가 임시파일→rename, #797). 개별 실패는 다음 턴 재시도.
  let pushed = 0, failed = 0;
  for (const f of push) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    try {
      const body = await fsp.readFile(f.abs);
      const r = await jfetch(`/api/ui/v6/projects/${projectId}/file?path=${encodeURIComponent(f.path)}`, {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body,
      });
      if (r.ok) pushed++; else failed++;
    } catch { failed++; }
  }

  // 8) 결과를 사람이 볼 수 있게 남긴다(호스트 로컬 — 동기화 안 됨). 충돌은 **조용히 사라지면 안 된다**:
  //    자동 up 은 확인할 사람이 없으므로(수동 업로드의 #877 confirm 과 다름) 기록이 유일한 표면이다.
  //    `lively status` 가 이 파일을 읽어 보여준다.
  try {
    await fsp.writeFile(path.join(projDir, ".lively", "sync-up.json"),
      JSON.stringify({ at: new Date().toISOString(), pushed, failed, conflicts }, null, 2) + "\n");
  } catch { /* 기록 실패는 무해 */ }
})().then(() => process.exit(0)).catch(() => process.exit(0));
