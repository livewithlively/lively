// ═══════════════════════════════════════════════════════════════════════════
// `lively delegate` 서브커맨드 (#869 §11) — lively.mjs 에서 **원문 그대로** 분리한 조각(#1313 R52).
//  cmd-node.mjs 와 같은 레일: lively.mjs 가 dynamic import 로 부르고 공용 원시함수를 ctx 로 주입한다
//  (부트스트랩이 lively.mjs 한 파일만 내려받으므로 static import 는 못 쓴다 — 사연은 cmd-node.mjs 머리말).
//
//  주입 컨텍스트  ctx = { say, dim, green, red, die, api, sleep }
// ═══════════════════════════════════════════════════════════════════════════

// ctx 주입 슬롯 — 아래 함수 본문은 lively.mjs 원문 그대로다(이름·들여쓰기 무변경).
let say, dim, green, red, die, api, sleep;

export function delegateCommands(ctx) {
  ({ say, dim, green, red, die, api, sleep } = ctx);
  return { cmdDelegate };
}

// ── 위탁(delegate, #869 §11) — 세션이 무거운 1회성 작업을 워커/중앙에 위탁하는 클라이언트 프로세스. ──
//  하네스의 Bash/백그라운드셸/서브에이전트와 동형: 실행→진행 stdout 미러→결과 출력+exit code(0/1).
//  진행 로그는 게이트웨이가 워커 stream.jsonl 을 오프셋 tail 로 릴레이(폴링). 진행은 stderr, 최종 결과는 stdout.
// stream.jsonl 청크를 소비 — 항상 파싱해 최종 result 이벤트를 잡고(스케줄러 타이밍 무관 = 클라 자립),
//  mirror 면 assistant 텍스트/툴사용을 stderr 로 흘린다(진행은 stderr, 최종 결과는 stdout — 분리).
let _cbuf = "", _finalResult = null, _finalIsError = false;
function consumeStream(chunk, mirror) {
  _cbuf += chunk;
  const lines = _cbuf.split("\n"); _cbuf = lines.pop();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    if (ev.type === "result") { _finalResult = typeof ev.result === "string" ? ev.result : JSON.stringify(ev); if (ev.is_error) _finalIsError = true; }
    else if (mirror && ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b.type === "text" && b.text) process.stderr.write(dim(b.text) + "\n");
        else if (b.type === "tool_use") process.stderr.write(dim(`· ${b.name}`) + "\n");
      }
    }
  }
}
async function streamAndExit(id, jsonMode) {
  let from = 0, last = "", exitCode = null;
  for (;;) {
    let r;
    try { r = await api(`/api/ui/delegate/${id}/logs?from=${from}`, { timeoutMs: 20000 }); }
    catch (e) { say(dim(`(재연결: ${e.message})`)); await sleep(2000); continue; }
    if (r.pending) { if (last !== "queued") { say(dim("적합한 노드를 기다리는 중…")); last = "queued"; } await sleep(2000); continue; }
    if (r.status === "running" && last !== "running") { say(dim("워커에서 실행 중…")); last = "running"; }
    if (r.chunk) { from = r.next; consumeStream(r.chunk, !jsonMode); }
    if (r.done) { exitCode = r.exit; break; }
    if (!r.chunk) await sleep(1000);
  }
  // 결과 텍스트는 스트림에서 직접 뽑은 게 우선(스케줄러 종결 마킹을 기다리지 않는다). 없으면 status 폴백.
  let result = _finalResult, error = null;
  if (result === null) {
    for (let i = 0; i < 15; i++) {
      const { task } = await api(`/api/ui/delegate/${id}`);
      if (["done", "failed", "canceled"].includes(task.status)) { result = (task.result && task.result.summary) || ""; error = task.error; break; }
      await sleep(1000);
    }
  }
  const ok = exitCode === 0 && !_finalIsError && !error;
  if (jsonMode) { const { task } = await api(`/api/ui/delegate/${id}`); process.stdout.write(JSON.stringify(task) + "\n"); }
  else {
    if (result) process.stdout.write(result + (result.endsWith("\n") ? "" : "\n"));
    if (ok) say(green(`✓ 위탁 #${id} 완료`));
    else say(red(`위탁 실패${error ? ": " + error : exitCode != null ? ` (exit ${exitCode})` : ""} — 워커 세션은 보존됨(웹터미널로 검시)`));
  }
  process.exit(ok ? 0 : 1);
}

async function cmdDelegate(rest) {
  const sub = rest[0];
  const needId = (v) => { if (!/^\d+$/.test(v || "")) die("위탁 번호가 필요합니다. 예: lively delegate status 3", 2); return v; };
  if (sub === "status") { const { task } = await api(`/api/ui/delegate/${needId(rest[1])}`); process.stdout.write(JSON.stringify(task, null, 2) + "\n"); return; }
  if (sub === "cancel") { await api(`/api/ui/delegate/${needId(rest[1])}/cancel`, { method: "POST", body: {} }); say(green(`위탁 #${rest[1]} 취소됨`)); return; }
  if (sub === "list") { const { tasks } = await api("/api/ui/delegate"); for (const t of (tasks || [])) say(`#${t.id}  ${t.status}${t.node_id ? "  @" + t.node_id : ""}  ${dim((t.prompt || "").slice(0, 60).replace(/\s+/g, " "))}`); return; }
  if (sub === "logs") { await streamAndExit(needId(rest[1]), rest.includes("--json")); return; }
  // 기본: 위탁 실행 — rest = 프롬프트 + 옵션.
  const need = {}; let detach = false, jsonMode = false; const parts = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--ram") need.need_ram_mb = Number(rest[++i]);
    else if (t === "--cpu") need.need_cpu = Number(rest[++i]);
    else if (t === "--disk") need.need_disk_mb = Number(rest[++i]);
    else if (t === "--timeout") need.timeout_sec = Number(rest[++i]);
    else if (t === "--node") need.node = rest[++i];
    else if (t === "--repo") need.repo = rest[++i];
    else if (t === "--ref") need.ref = rest[++i];
    else if (t === "--docker") need.needs_docker = true;
    else if (t === "--detach") detach = true;
    else if (t === "--json") jsonMode = true;
    else parts.push(t);
  }
  const prompt = parts.join(" ").trim();
  if (!prompt) die('위탁할 작업 지시가 필요합니다.  예: lively delegate "테스트 전체 실행하고 결과 보고" --ram 2048', 2);
  // CLI 는 자체 로그 스트리밍(streamAndExit)을 하므로 서버 wait 는 끈다(이중 대기 방지).
  //  queue 옵션은 CLI 에선 기본 대기(배치 불가면 계속 폴링) — 서버엔 queue:true 로 등록(no_capacity 즉실패 대신).
  const res = await api("/api/ui/delegate", { method: "POST", body: { prompt, ...need, wait: false, queue: true } });
  if (res.no_capacity) { say(red(`위탁 불가 — ${res.reason || "가용 노드 없음"}`)); say(dim("로컬에서 직접 실행하세요.")); process.exit(2); }
  const task = res.task;
  if (detach) { say(green(`위탁 #${task.id} 생성 — 진행: lively delegate logs ${task.id}`)); process.stdout.write(String(task.id) + "\n"); return; }
  say(dim(`위탁 #${task.id} 생성 — 배치 대기…`));
  await streamAndExit(task.id, jsonMode);
}
