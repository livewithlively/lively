// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=Stop, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록. (#905 C1 슬2c 세션이력 캡처)
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 턴 끝에 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 이 턴에 늘어난 **트랜스크립트(대화 기록)** 조각을 게이트웨이로 올린다(offset-CAS append).
//   여태 세션 대화는 로컬에만 있었다 — 환경·멤버가 달라지면 이어볼 수도 이어받을 수도 없었다(#905 C1).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만).
//
//  ── 설계 (설계 §5) ──
//   ① **조직이 켜야 캡처한다.** 관리탭 ▸ 세션 공유 enabled=false 면 훅이 즉시 종료(GET watermark 의 capture.enabled).
//      → 기본 켬(#1752)이지만 이 스위치가 최종 관문 — 조직이 끄면 그 즉시 수집이 멈춘다.
//   ② **로컬 오프셋 상태 파일이 없다.** 서버 워터마크(GET watermark 의 bytes)가 "어디까지 받았나"의 진실이다 —
//      매 턴 그걸 물어 그 지점부터 트랜스크립트 파일을 읽어 보낸다. 재시작·중복 tailer 는 서버 offset-CAS 가 흡수.
//   ③ **transcript_path 직수령**(Stop 이벤트 stdin). slug 재유도 안 함(설계 §5 — 경로 재계산은 취약).
//   ④ 캡처 단위 = 이 슬라이스는 **주 트랜스크립트만**(scope=main). 서브에이전트 트리(scope=tree)는 후속.
//   ⑤ 저장 형태 slim(서명·툴결과·토큰통계 제거)은 후속 슬라이스 — 지금은 원본 바이트를 보낸다(서버가 그대로 저장).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// 상한은 run-custom 이 알려준다(LIVELY_HOOK_TIMEOUT_MS = 이 훅의 timeout_sec). 하드코딩하면 관리탭에서 timeout_sec 을
//  줄이는 순간 조용히 어긋난다. 구 run-custom(미전달)이면 시드 등록값 15s 로 가정. 하한을 깔지 않는다(1s 킬도 존중).
const HOOK_TIMEOUT_MS = Number(process.env.LIVELY_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.LIVELY_HOOK_TIMEOUT_MS) : 15_000;
const BUDGET_MS = Math.floor(HOOK_TIMEOUT_MS * 0.7);   // 이 지점 넘기면 이번 턴 종료 — 남은 건 다음 턴(서버 워터마크가 이어줌).
const MAX_DELTA = 8 * 1024 * 1024;  // 한 번에 올릴 상한(엔드포인트 상한과 동일) — 넘으면 이번엔 여기까지만.

(async () => {
  const startedAt = Date.now();
  // 1) Stop 이벤트 stdin — session_id·transcript_path·cwd.
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 500); }
    catch { fin(); }
  });
  let ev = {};
  try { ev = JSON.parse(stdinData || "{}") || {}; } catch { return; }
  const sessionId = String(ev.session_id || ev.sessionId || "").trim();
  const transcriptPath = String(ev.transcript_path || ev.transcriptPath || "").trim();
  if (!sessionId || !transcriptPath) return;   // 이 정보가 없으면(구 하네스·비Claude) 캡처 불가 — 조용히 종료.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionId)) return;

  // 프로젝트 귀속(#905 C1) — **`.lively/project.json` 마커에서 project_id 를 읽는다**(경로 휴리스틱 아님, 구조화된 정본).
  //  세션 cwd 에서 위로 올라가며 마커를 찾는다. 서버는 이 값을 받아 '요청자가 그 프로젝트 멤버일 때만' 귀속한다(위조 방어).
  const cwd = String(ev.cwd || ev.cwd || "").trim() || process.cwd();
  const projectId = (() => {
    let dir = cwd;
    for (let i = 0; i < 40 && dir; i++) {
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, ".lively", "project.json"), "utf8")); if (m && Number.isInteger(m.project_id) && m.project_id > 0) return m.project_id; } catch { /* 마커 없음·파손 */ }
      const p = path.dirname(dir); if (p === dir) break; dir = p;
    }
    return null;
  })();

  // 2) 게이트웨이 base + 토큰 (project-push 와 동일 출처).
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const nodeId = (process.env.LIVELY_NODE_ID || "").trim() || readLocal("node-id") || "";   // '' = 게이트웨이 로컬(박스)
  const harness = (process.env.LIVELY_HARNESS || "claude").trim().toLowerCase();
  const jfetch = async (p, opts = {}) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(500, Math.min(6000, BUDGET_MS - (Date.now() - startedAt))));
    try { return await fetch(base + p, { ...opts, signal: ctl.signal, headers: { authorization: "Bearer " + token, ...(opts.headers || {}) } }); }
    finally { clearTimeout(t); }
  };
  const q = (o) => new URLSearchParams(o).toString();

  // 3) 한 번의 GET 으로 오프셋 + 캡처 정책. enabled 꺼짐·정책 밖 하네스면 여기서 끝(전송 안 함).
  let head;
  try {
    const r = await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(sessionId)}/log/watermark?${q({ node: nodeId })}`);
    if (!r.ok) return;
    head = await r.json();
  } catch { return; }
  const cap = head && head.capture;
  if (!cap || cap.enabled !== true) return;                          // 조직이 안 켬 → 캡처 안 함
  if (Array.isArray(cap.harnesses) && !cap.harnesses.includes(harness)) return;   // 정책 밖 하네스

  // 4) 델타 업로드(한 파일) — from(서버 워터마크)부터 [from, end) 한 조각. gap/충돌은 서버 판정, 다음 턴 정정.
  const uploadDelta = async (sid, filePath, from, extra) => {
    let st; try { st = await fsp.stat(filePath); } catch { return; }
    if (!st.isFile() || st.size <= from) return;                     // 늘어난 게 없음
    const end = Math.min(st.size, from + MAX_DELTA);
    let buf;
    try {
      const fh = await fsp.open(filePath, "r");
      try { const want = end - from; const b = Buffer.alloc(want); const { bytesRead } = await fh.read(b, 0, want, from); buf = b.subarray(0, bytesRead); }
      finally { await fh.close(); }
    } catch { return; }
    if (!buf || !buf.length) return;
    try {
      await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q({ at: String(from), node: nodeId, harness, ...(projectId ? { project: String(projectId) } : {}), ...(extra || {}) })}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf,
      });
    } catch { /* 전송 실패 → 다음 턴 재시도(영구 누락 없음: 서버 워터마크 기준) */ }
  };

  // 5) 주 트랜스크립트 먼저(head 로 워터마크 이미 받음).
  await uploadDelta(sessionId, transcriptPath, Number(head.bytes) || 0, {});

  // 6) scope=tree 면 서브에이전트(<주sid>/subagents/agent-*.jsonl)도 각각 올린다(#905 C1 슬⑥). parent 로 부모에 매단다.
  //    예산 안에서만 — 초과분은 다음 턴(각자 서버 워터마크가 이어준다). 주 트랜스크립트가 항상 우선.
  if (cap.scope === "tree" && Date.now() - startedAt <= BUDGET_MS) {
    const subDir = path.join(path.dirname(transcriptPath), sessionId, "subagents");
    let files = [];
    try { files = (await fsp.readdir(subDir)).filter((f) => /^[A-Za-z0-9._-]{1,64}\.jsonl$/.test(f)); } catch { /* 서브에이전트 없음 */ }
    for (const f of files) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const agentSid = f.slice(0, -6);   // '.jsonl' 제거 = 서브에이전트 세션 id(agent-<hex>)
      let subFrom = 0;
      try { const r = await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(agentSid)}/log/watermark?${q({ node: nodeId })}`); if (!r.ok) continue; subFrom = Number((await r.json()).bytes) || 0; }
      catch { continue; }
      await uploadDelta(agentSid, path.join(subDir, f), subFrom, { parent: sessionId });
    }
  }
})().then(() => process.exit(0)).catch(() => process.exit(0));
