// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=Stop · SessionEnd 판 session-log-capture-end, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록. (#905 C1 슬2c 세션이력 캡처)
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
//   ⑥ **읽기전용·인코그니토 세션은 올리지 않는다**(#5048). 대화 전문 저장은 조직 저장소에 쓰는 일이다 — 종전엔 이 훅만
//      모드를 안 봐서 «읽기전용인데 대화가 다 남는다» 가 됐다. 서버도 그 세션의 저장된 모드(org_session_state)로 한 번 더 거부한다.
//   ⑦ **마지막 답이 파일에 적힐 때까지 잠깐 기다린다**(#5580). Claude Code 는 Stop 훅을 그 답을 대화 파일에 쓰기 **전에** 부른다
//      (실측 2.1.326: 훅이 뜬 순간 그 답 0건 · 1.5초 뒤 1건). 그대로 올리면 중앙 기록엔 마지막 답 직전까지만 들어가고, 다음 턴이
//      없으면(세션이 꺼지면) 끝내 안 올라간다 — 노드 세션 대화창은 중앙 기록을 읽어서 «꺼진 세션 안내 위의 답이 최신이 아니다».
//      Stop 입력의 last_assistant_message 가 그 답이다 — 아직 안 올린 구간의 마지막 답 줄이 그 글과 맞을 때까지 본다(settleLastReply).
//   ⑧ **한 턴에 8MB 넘게 늘어도 끝까지 올린다**(#5611). 한 번에 올리는 상한(MAX_DELTA = 엔드포인트 상한)이 8MB 라 종전 훅은 턴마다
//      **8MB 한 조각만** 올렸다 — 그림·큰 도구 결과로 한 턴이 8MB 를 넘으면 나머지는 다음 턴들이 8MB 씩 갚았고, 그 전에 세션이
//      꺼지면(보관·자동 끔) 끝내 안 올라갔다. 꺼진 노드 세션의 대화창은 중앙 기록을 읽으므로 마지막 답은커녕 그 앞 질문 언저리에서
//      멈췄다(실측 2026-11-20 맥미니: 노드 세션 49개 중 둘이 워터마크 = 그 턴 시작 + 8MB×n 에서 멈춤 — 22,165,171 = 5,387,955 + 2×8MB).
//      이제 첫 조각은 종전처럼 여기서 올리고, 남은 몫은 **자기 사본을 분리된 프로세스로 띄워 뒤에서** 마저 올린다(project-pull 의
//      뒤에서 받기와 같은 꼴) — 턴 끝을 더 붙잡지 않고, 세션이 꺼져도(tmux 를 내려도) 그 프로세스는 끝까지 간다.
//      대화 하나에 뒤에서 올리는 판은 하나다(임시 폴더의 잠금). 그 판이 살아 있으면 다음 턴의 훅은 올리지 않고 그 판에 맡긴다 —
//      그 판은 잠금을 푼 **뒤에** 파일 끝을 다시 재서, 그 사이 늘어난 몫까지 잇는다. 겹쳐 올려도 서버 offset-CAS 가 중복을 흡수한다.
//      LIVELY_LOGCAP_BG_OFF=1 이면 뒤에서 돌리지 않고 이 훅의 예산 안에서 앞에서 잇는다(뒤에 프로세스를 둘 수 없는 자리·시험용).
//   ⑨ **세션이 내려갈 때(SessionEnd) 한 번 더 올린다**(#5611 후속). Stop 이 안 뜨는 턴 끝이 있다 — 사용 한도·API 오류로 끝난 턴
//      (Claude Code 는 Stop 대신 StopFailure 만 띄운다)과 사람이 Esc 로 끊은 턴(아무 훅도 안 뜬다). 그 뒤 세션이 꺼지면(보관·자동 끔)
//      그 턴은 중앙 기록에 끝내 안 들어갔다(실측 2026-11-20 맥미니: 턴마다 한도로 끝난 세션 둘 · 끊고 둔 세션 하나 — 중앙 기록 0바이트,
//      대화창이 통째로 비었다). 같은 소스를 SessionEnd 에도 건다(시드 session-log-capture-end) — tmux 를 내려도(SIGHUP) Claude Code 는
//      SessionEnd 훅을 띄우고 끝나기를 기다린다(2.1.329 실측: kill 0.1초 뒤 훅 시작 · 2.5초 걸린 훅도 끝까지 · 그 훅이 띄운 분리 프로세스도 끝까지).
//      내려가는 중이라 이 훅은 네트워크를 타기 전에 ⑧ 의 뒤에서 올리는 판부터 띄우고 끝난다 — 남은 일은 그 판이 한다. 그 판은 끝에 닿은 뒤
//      잠금을 쥔 채 잠깐(BG_QUIET_MS) 기다렸다가 파일 끝을 다시 잰다 — 하네스가 종료하며 마지막 줄을 조금 늦게 적어도 잇는다.
//      이 판 역시 러너(run-custom) 뒤에서 돈다 — 인코그니토·«이 세션만 끔»·기록 범위 밖이면 러너가 먼저 끝내 여기까지 오지 않는다.
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 상한은 run-custom 이 알려준다(LIVELY_HOOK_TIMEOUT_MS = 이 훅의 timeout_sec). 하드코딩하면 관리탭에서 timeout_sec 을
//  줄이는 순간 조용히 어긋난다. 구 run-custom(미전달)이면 시드 등록값 15s 로 가정. 하한을 깔지 않는다(1s 킬도 존중).
const HOOK_TIMEOUT_MS = Number(process.env.LIVELY_HOOK_TIMEOUT_MS) > 0 ? Number(process.env.LIVELY_HOOK_TIMEOUT_MS) : 15_000;
const BUDGET_MS = Math.floor(HOOK_TIMEOUT_MS * 0.7);   // 이 지점 넘기면 이번 턴 종료 — 남은 건 다음 턴(서버 워터마크가 이어줌).
const MAX_DELTA = 8 * 1024 * 1024;  // POST 하나에 올릴 상한(엔드포인트 상한과 동일) — 더 늘었으면 조각을 이어 올린다(⑧).
// ⑦ 마지막 답 기다림 — 상한 · 주기 · 들여다볼 꼬리 크기. 상한을 넘기면 기다림을 접고 종전대로 올린다(다음 턴이 나머지를 잇는다).
const SETTLE_MAX_MS = 4000;
const SETTLE_POLL_MS = 100;
const SETTLE_TAIL = 512 * 1024;
// ⑧ 뒤에서 마저 올리는 판 — 마감 · 조각 하나의 상한 · 다시 해 보는 간격 · 임시 파일 이름표.
const BG_HARD_MS = 15 * 60_000;                 // 넘기면 접는다 — 남은 몫은 다음 턴의 훅이 다시 맡는다(서버 워터마크부터)
const BG_POST_TIMEOUT_MS = 120_000;             // 8MB 한 조각을 느린 회선(약 0.07MB/s)에서도 넘길 만큼
const BG_RETRY_MS = [2_000, 10_000, 30_000];    // 네트워크 오류·408·429·5xx 일 때만 다시 — 그 밖의 거절(403·413 등)은 바로 접는다
const BG_SELF_TAG = "lively-logcap-bg-";
const BG_LOCK_TAG = "lively-logcap-lock-";
const BG_QUIET_MS = 3_000;                      // ⑨ 끝에 닿은 뒤 잠금을 쥔 채 기다리는 시간 — 종료하는 하네스의 늦은 마지막 줄까지
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

/** 게이트웨이 호출 묶음 — 훅(앞)과 뒤에서 올리는 판(⑧)이 **같은 신원·같은 헤더**로 나간다(서버의 모드·귀속 판정이 같아야 한다). */
function makeClient(c) {
  const q = (o) => new URLSearchParams(o).toString();
  const jfetch = async (p, opts, timeoutMs) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(500, timeoutMs));
    try {
      return await fetch(c.base + p, { ...opts, signal: ctl.signal, headers: {
        authorization: "Bearer " + c.token, ...(c.executionId ? { "x-lively-session": c.executionId } : {}),
        ...(c.wsSlug ? { "x-lively-workspace": c.wsSlug } : {}), ...((opts && opts.headers) || {}) } });
    } finally { clearTimeout(t); }
  };
  /** 서버 워터마크 + 캡처 정책. 못 받으면 null. */
  const watermark = async (sid, timeoutMs) => {
    try {
      const r = await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?${q({ node: c.nodeId })}`, {}, timeoutMs);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  /** [from, min(파일 끝, from+MAX_DELTA)) 한 조각을 올린다.
   *  돌려줌: size = 읽은 순간의 파일 크기(null = 파일 없음) · bytes = 서버가 말한 워터마크(null = 못 올림) · status(0 = 네트워크).
   *  서버는 이어 붙였든(append) · 이미 있든(duplicate) · 어긋났든(gap·overlap) 지금 워터마크를 돌려준다 — 그게 다음 조각의 자리다. */
  const postSlice = async (sid, filePath, from, timeoutMs, extra) => {
    let st; try { st = await fsp.stat(filePath); } catch { return { size: null, bytes: null, status: 0 }; }
    if (!st.isFile()) return { size: null, bytes: null, status: 0 };
    if (st.size <= from) return { size: st.size, bytes: from, status: 200 };   // 늘어난 게 없음
    const end = Math.min(st.size, from + MAX_DELTA);
    let buf;
    try {
      const fh = await fsp.open(filePath, "r");
      try { const want = end - from; const b = Buffer.alloc(want); const { bytesRead } = await fh.read(b, 0, want, from); buf = b.subarray(0, bytesRead); }
      finally { await fh.close(); }
    } catch { return { size: st.size, bytes: null, status: 0 }; }
    if (!buf || !buf.length) return { size: st.size, bytes: from, status: 200 };
    try {
      const r = await jfetch(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q({ at: String(from), node: c.nodeId, harness: c.harness, ...(c.executionId ? { execution: c.executionId } : {}), ...(extra || {}) })}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf,
      }, timeoutMs);
      if (!r.ok) return { size: st.size, bytes: null, status: r.status };
      let j = null; try { j = await r.json(); } catch { /* 본문 없는 응답 — 보낸 만큼 들어갔다고 본다 */ }
      const nb = Number(j && j.bytes);
      return { size: st.size, bytes: Number.isFinite(nb) && nb >= 0 ? nb : from + buf.length, status: r.status };
    } catch { return { size: st.size, bytes: null, status: 0 }; }   // 끊김·시간 초과 — 서버에 들어갔는지는 다음 워터마크가 말한다
  };
  return { watermark, postSlice };
}

// ── ⑧ 뒤에서 올리는 판의 잠금 — 대화 하나에 하나. 임시 폴더에 pid·시각을 적는다(project-pull 의 pull-bg.json 과 같은 꼴). ──
const lockPath = (nodeId, sid) => path.join(os.tmpdir(),
  `${BG_LOCK_TAG}${crypto.createHash("sha256").update(`${nodeId}\n${sid}`).digest("hex").slice(0, 24)}.json`);
/** 이 대화를 뒤에서 올리는 판이 지금 살아 있나 — 잠금의 pid 가 살아 있고 마감(+1분) 안이다. 못 읽으면 없다고 본다. */
function bgAlive(p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!(Date.now() - Number(o.at || 0) < BG_HARD_MS + 60_000)) return false;   // 마감을 넘긴 잠금 = 죽은 판이 남긴 것
    try { process.kill(Number(o.pid), 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
  } catch { return false; }
}
function takeLock(p) {
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  try { fs.writeFileSync(p, body, { flag: "wx", mode: 0o600 }); return true; }
  catch (e) {
    if (!e || e.code !== "EEXIST" || bgAlive(p)) return false;
    try { fs.writeFileSync(p, body, { mode: 0o600 }); return true; } catch { return false; }   // 죽은 판의 잠금 — 넘겨받는다
  }
}
function releaseLock(p) {
  try { if (JSON.parse(fs.readFileSync(p, "utf8")).pid === process.pid) fs.unlinkSync(p); } catch { /* 이미 없음 */ }
}
const drop = (p) => { try { fs.unlinkSync(p); } catch { /* 이미 없음 */ } };

/** 이 훅의 사본을 분리된 프로세스로 띄운다. run-custom 은 이 파일을 우리가 끝나는 즉시 지우므로 사본을 넘긴다(자식이 뜨자마자 지운다).
 *  자식엔 stdin 이 없다 — 이미 정한 값은 env 로 넘기고, 토큰은 인자(ps 에 보인다)가 아니라 env 로만 넘긴다. */
function spawnBackground(target, token) {
  let copy = null;
  try {
    copy = path.join(os.tmpdir(), `${BG_SELF_TAG}${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mjs`);
    fs.writeFileSync(copy, fs.readFileSync(fileURLToPath(import.meta.url)), { mode: 0o600 });
    const child = spawn(process.execPath, [copy], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, LIVELY_TOKEN: token, LIVELY_LOGCAP_BG: "1", LIVELY_LOGCAP_BG_TARGET: JSON.stringify(target), LIVELY_LOGCAP_BG_SELF: copy },
    });
    child.on("error", () => drop(copy));
    child.unref();
    return true;
  } catch { if (copy) drop(copy); return false; }
}

/** ⑧ 서버 워터마크부터 **지금 파일 끝까지** 조각을 이어 올린다. 따라잡으면 그 워터마크, 못 하면(마감·거절·끝내 끊김) null. */
async function pushToEnd(cl, t, deadline) {
  let head = null;
  for (let i = 0; !head; i++) {
    head = await cl.watermark(t.sessionId, Math.min(30_000, deadline - Date.now()));
    if (head) break;
    if (i >= BG_RETRY_MS.length || Date.now() + BG_RETRY_MS[i] > deadline) return null;
    await sleep(BG_RETRY_MS[i]);
  }
  const cap = head.capture;
  if (!cap || cap.enabled !== true) return null;                                     // 조직이 껐다 · 읽기전용·인코그니토(서버가 끈 답)
  if (Array.isArray(cap.harnesses) && !cap.harnesses.includes(t.harness)) return null;
  let from = Number(head.bytes) || 0;
  let tries = 0, still = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const r = await cl.postSlice(t.sessionId, t.transcriptPath, from, Math.min(BG_POST_TIMEOUT_MS, left), {});
    if (r.size == null) return null;                                                  // 파일이 사라졌다
    if (r.bytes != null) {
      if (r.bytes >= r.size) return r.bytes;                                          // 따라잡음
      still = r.bytes === from ? still + 1 : 0;                                       // 서버가 받아 주지 않고 같은 자리를 말한다
      if (still >= 2) return null;
      from = r.bytes; tries = 0; continue;
    }
    if (!retryable(r.status) || tries >= BG_RETRY_MS.length || Date.now() + BG_RETRY_MS[tries] > deadline) return null;
    await sleep(BG_RETRY_MS[tries++]);
    const h = await cl.watermark(t.sessionId, 30_000);                                // 끊긴 POST 가 서버엔 들어갔을 수 있다 — 진실부터 다시
    if (h && Number.isFinite(Number(h.bytes))) from = Number(h.bytes);
  }
}

/** ⑧ 뒤에서 올리는 판의 본체 — 잠금을 잡고 끝까지 올린 뒤, 잠금을 푼 **뒤에** 파일 끝을 다시 잰다. 그 사이 끝난 턴의 훅은
 *  «뒤에서 올리는 중» 을 보고 제 몫을 이 판에 맡겼다 — 늘었으면 잠금을 다시 잡고 잇는다(다른 판이 잡았으면 그 판이 잇는다). */
async function runBackground() {
  const self = String(process.env.LIVELY_LOGCAP_BG_SELF || "");
  if (self && path.dirname(self) === os.tmpdir() && path.basename(self).startsWith(BG_SELF_TAG)) drop(self);   // 남의 파일은 안 지운다
  let t; try { t = JSON.parse(process.env.LIVELY_LOGCAP_BG_TARGET || ""); } catch { return; }
  const token = String(process.env.LIVELY_TOKEN || "").trim();
  if (!t || !t.sessionId || !t.transcriptPath || !t.base || !token) return;
  const cl = makeClient({ ...t, token });
  const lock = lockPath(t.nodeId, t.sessionId);
  const deadline = Date.now() + BG_HARD_MS;
  process.on("exit", () => releaseLock(lock));
  while (takeLock(lock)) {
    const done = await pushToEnd(cl, t, deadline);
    //  ⑨ 끝에 닿았으면 잠금을 쥔 채 잠깐 기다린다 — 그 사이 끝난 훅은 이 판에 맡기고, 종료하는 하네스가 늦게 적은 줄은 아래에서 잰다.
    if (done != null && Date.now() + BG_QUIET_MS < deadline) await sleep(BG_QUIET_MS);
    releaseLock(lock);
    if (done == null) return;                                                         // 다음 턴의 훅이 서버 워터마크부터 다시 맡는다
    let size = 0; try { size = (await fsp.stat(t.transcriptPath)).size; } catch { return; }
    if (size <= done) return;
  }
}

/** 대화 파일 한 줄(JSON)의 AI 글 — assistant 줄의 text 블록을 잇는다. 글이 없으면(도구 호출만 · 다른 종류) ''. */
const replyTextOf = (row) => {
  if (!row || row.type !== "assistant") return "";
  const c = row.message && row.message.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : "";
};

/**
 * ⑦ 아직 안 올린 구간 [from, 끝) 의 **마지막 AI 글 줄**이 이번 턴의 마지막 답(last_assistant_message)과 맞는가.
 *  맞음 = 그 줄의 글이 비어 있지 않고 마지막 답의 끝부분이다(답 하나가 블록 여러 개로 나뉘어 적히면 마지막 블록이 끝부분이다).
 *  이전 진행 문장(«굽는 중입니다» 따위)이 아직 마지막 줄이면 맞지 않는다 — 그게 고치려는 상태다.
 */
const lastReplyLanded = async (filePath, from, want) => {
  let st; try { st = await fsp.stat(filePath); } catch { return false; }
  if (!st.isFile() || st.size <= from) return false;
  const start = Math.max(from, st.size - SETTLE_TAIL);
  let text = "";
  try {
    const fh = await fsp.open(filePath, "r");
    try { const b = Buffer.alloc(st.size - start); const { bytesRead } = await fh.read(b, 0, b.length, start); text = b.subarray(0, bytesRead).toString("utf8"); }
    finally { await fh.close(); }
  } catch { return false; }
  const lines = text.split("\n");
  if (start > from) lines.shift();                                     // 꼬리만 읽었으면 첫 줄은 잘린 줄이다
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let row; try { row = JSON.parse(lines[i]); } catch { continue; }   // 쓰는 중인 줄은 건너뛴다
    const t = replyTextOf(row).trimEnd();
    if (!t) continue;
    return want.trimEnd().endsWith(t);
  }
  return false;
};

/** ⑦ 마지막 답이 파일에 적힐 때까지 짧게 기다린다. 답 글을 모르면(구 하네스 · 비Claude) 기다리지 않는다 — 종전 그대로. */
const settleLastReply = async (filePath, from, want, untilMs) => {
  if (typeof want !== "string" || !want.trim()) return;
  while (!(await lastReplyLanded(filePath, from, want))) {
    if (Date.now() + SETTLE_POLL_MS > untilMs) return;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
};

const main = async () => {
  const startedAt = Date.now();
  // 0) 읽기전용·인코그니토(⑥) — 네트워크를 한 번도 타지 않고 끝낸다. 구 boolean env 도 본다(전이기 dual-env, #1007+).
  const mode = String(process.env.LIVELY_MODE || "").trim().toLowerCase();
  if (mode === "readonly" || mode === "incognito" || process.env.LIVELY_READONLY === "1" || process.env.LIVELY_INCOGNITO === "1") return;
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

  // 대화 id(sessionId)와 실행 세션 id는 별개다. 프로젝트 귀속은 cwd가 아니라 실행 세션 DB 바인딩으로 서버가 해석한다.
  const directExecution = String(process.env.LIVELY_SESSION_ID || "").trim();
  const harness = String(process.env.LIVELY_HARNESS || "claude").trim().toLowerCase();
  const codexExecution = String(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || "").trim();
  const claudeExecution = String(process.env.CLAUDE_SESSION_ID || "").trim();
  const executionId = directExecution
    || (harness === "codex" ? `codex-${sessionId}` : "")
    || (harness === "cursor" ? `cursor-${sessionId}` : "")   // #4927 cursor-adapter
    || (harness === "claude" ? `claude-${sessionId}` : "")
    || (codexExecution ? `codex-${codexExecution}` : "")
    || (claudeExecution ? `claude-${claudeExecution}` : "");

  // 2) 게이트웨이 base + 토큰 (project-push 와 동일 출처).
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const nodeId = (process.env.LIVELY_NODE_ID || "").trim() || readLocal("node-id") || "";   // '' = 게이트웨이 로컬(박스)
  // #1750 S3 — 셀프호스트 다중 워크스페이스: 이 세션의 소속(spawn 이 pane env 로 심음)을 헤더로 알린다.
  //  없으면 안 붙인다(primary = 종전). 안 붙이면 secondary 세션의 기록이 primary 에 쌓인다(소속 불일치).
  const wsSlug = (process.env.LVLY_TENANT_SLUG || "").trim();
  const fgLeft = () => Math.max(500, Math.min(6000, BUDGET_MS - (Date.now() - startedAt)));
  const cl = makeClient({ base, token, executionId, wsSlug, nodeId, harness });
  const target = { base, nodeId, sessionId, transcriptPath, harness, executionId, wsSlug };
  const lock = lockPath(nodeId, sessionId);

  //  ⑨ 세션이 내려가는 중 — 네트워크를 타기 전에 뒤에서 올리는 판부터 띄우고 끝낸다(정책 확인·올리기는 그 판이 한다).
  //   그 판이 이미 돌고 있으면 그 판이 잠금을 푼 뒤 파일 끝을 다시 잰다. 띄우지 못하면 아래 턴 끝 경로로 앞에서 올린다.
  const ending = String(ev.hook_event_name || ev.hookEventName || "") === "SessionEnd";
  if (ending && process.env.LIVELY_LOGCAP_BG_OFF !== "1" && (bgAlive(lock) || spawnBackground(target, token))) return;

  // 3) 한 번의 GET 으로 오프셋 + 캡처 정책. enabled 꺼짐·정책 밖 하네스면 여기서 끝(전송 안 함).
  const head = await cl.watermark(sessionId, fgLeft());
  if (!head) return;
  const cap = head.capture;
  if (!cap || cap.enabled !== true) return;                          // 조직이 안 켬 → 캡처 안 함
  if (Array.isArray(cap.harnesses) && !cap.harnesses.includes(harness)) return;   // 정책 밖 하네스

  // 4) 주 트랜스크립트 먼저(head 로 워터마크 이미 받음). ⑦ 마지막 답이 파일에 적힌 뒤에 읽는다 — 서브에이전트 몫 예산은 남긴다.
  await settleLastReply(transcriptPath, Number(head.bytes) || 0, ev.last_assistant_message,
    Math.min(Date.now() + SETTLE_MAX_MS, startedAt + BUDGET_MS - 2000));
  //  ⑧ 이 대화를 뒤에서 올리는 판이 살아 있으면 그 판에 맡긴다 — 그 판은 잠금을 푼 뒤 파일 끝을 다시 재므로 이번 턴 몫도 잇는다
  //   (마지막 답이 적힌 **뒤에** 보는 것이라, 그 판이 다시 잴 때 이 턴의 끝은 이미 파일에 있다).
  if (!bgAlive(lock)) {
    let r = await cl.postSlice(sessionId, transcriptPath, Number(head.bytes) || 0, fgLeft(), {});   // 첫 조각 — 종전 그대로
    const behind = () => r.size != null && (r.bytes == null ? retryable(r.status) : r.bytes < r.size);
    if (behind()) {
      const bgOff = process.env.LIVELY_LOGCAP_BG_OFF === "1";
      if (bgOff || !spawnBackground(target, token)) {
        //  뒤에서 못 돌리는 자리 — 이 훅의 예산 안에서 앞에서 잇는다(서브에이전트 몫 1초는 남긴다).
        while (r.bytes != null && behind() && Date.now() - startedAt < BUDGET_MS - 1000) {
          const prev = r.bytes;
          r = await cl.postSlice(sessionId, transcriptPath, prev, fgLeft(), {});
          if (r.bytes != null && r.bytes <= prev) break;                  // 서버가 받아 주지 않는다 — 다음 턴에
        }
      }
    }
  }

  // 5) scope=tree 면 서브에이전트(<주sid>/subagents/agent-*.jsonl)도 각각 올린다(#905 C1 슬⑥). parent 로 부모에 매단다.
  //    예산 안에서만 — 초과분은 다음 턴(각자 서버 워터마크가 이어준다). 주 트랜스크립트가 항상 우선.
  if (cap.scope === "tree" && Date.now() - startedAt <= BUDGET_MS) {
    const subDir = path.join(path.dirname(transcriptPath), sessionId, "subagents");
    let files = [];
    try { files = (await fsp.readdir(subDir)).filter((f) => /^[A-Za-z0-9._-]{1,64}\.jsonl$/.test(f)); } catch { /* 서브에이전트 없음 */ }
    for (const f of files) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const agentSid = f.slice(0, -6);   // '.jsonl' 제거 = 서브에이전트 세션 id(agent-<hex>)
      const h = await cl.watermark(agentSid, fgLeft());
      if (!h) continue;
      await cl.postSlice(agentSid, path.join(subDir, f), Number(h.bytes) || 0, fgLeft(), { parent: sessionId });
    }
  }
};

//  ⑧ 뒤에서 올리는 판으로 떴으면(자기 사본 · stdin 없음) 그 일만 한다. 아니면 턴 끝의 훅이다.
(process.env.LIVELY_LOGCAP_BG === "1" ? runBackground() : main()).then(() => process.exit(0)).catch(() => process.exit(0));
