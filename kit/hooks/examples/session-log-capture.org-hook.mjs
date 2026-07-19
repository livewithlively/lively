// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=Stop, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록. (#905 C1 슬2c 세션이력 캡처)
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 턴 끝에 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 이 턴에 늘어난 **트랜스크립트(대화 기록)** 조각을 게이트웨이로 올린다(offset-CAS append).
//   여태 세션 대화는 로컬에만 있었다 — 환경·멤버가 달라지면 이어볼 수도 이어받을 수도 없었다(#905 C1).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). stdout 미출력(부수효과만).
//
//  ── 설계 (설계 §5) ──
//   ① **조직이 켜야 캡처한다.** 관리탭 ▸ 세션 공유 enabled=false 면 훅이 즉시 종료(GET watermark 의 capture.enabled).
//      → 기본 꺼짐이라 켜기 전엔 아무 세션도 수집 안 함(롤아웃 안전).
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

const BUDGET_MS = 8000;              // 턴 끝 지연 상한 — 넘기면 남은 건 다음 턴에(서버 워터마크가 이어준다).
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
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
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

  // 4) 서버 워터마크(bytes)부터 트랜스크립트 델타를 읽는다. 새 바이트 없으면 종료.
  let from = Number(head.bytes) || 0;
  let st;
  try { st = await fsp.stat(transcriptPath); } catch { return; }     // 파일 없음(격리 등) → 조용히 종료
  if (!st.isFile() || st.size <= from) return;                       // 늘어난 게 없음

  // 5) 델타 전송(원자 append). 상한 안에서 [from, end) 를 한 조각으로. gap/충돌은 서버가 판정, 다음 턴이 정정.
  const end = Math.min(st.size, from + MAX_DELTA);
  let buf;
  try {
    const fh = await fsp.open(transcriptPath, "r");
    try { const want = end - from; const b = Buffer.alloc(want); const { bytesRead } = await fh.read(b, 0, want, from); buf = b.subarray(0, bytesRead); }
    finally { await fh.close(); }
  } catch { return; }
  if (!buf || !buf.length) return;
  if (Date.now() - startedAt > BUDGET_MS) return;                    // 예산 초과 — 다음 턴에(서버 워터마크가 이어준다)
  try {
    await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(sessionId)}/log?${q({ at: String(from), node: nodeId, harness })}`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf,
    });
    // 응답을 굳이 안 본다 — ok/duplicate/gap 무엇이든 다음 턴에 GET watermark 로 서버 진실을 다시 받아 이어간다.
  } catch { /* 전송 실패 → 다음 턴 재시도(영구 누락 없음: 서버 워터마크 기준) */ }
})().then(() => process.exit(0)).catch(() => process.exit(0));
