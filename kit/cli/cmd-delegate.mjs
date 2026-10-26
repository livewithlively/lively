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

/** `lively delegate` 사용법 — `--help`·`-h`·`help` 와 인자 오류 때 **위탁 대신** 이것을 보여준다(#5028). */
export function delegateUsage() {
  return [
    "사용법: lively delegate \"<작업 지시>\" [옵션]     무거운 작업을 워커 노드/중앙에 위탁 — 진행을 미러하고 결과 출력 후 종료",
    "        lively delegate status|logs|cancel <번호>",
    "        lively delegate list",
    "",
    "⚠ 작업 지시를 주면 **실제 위탁이 생성**됩니다. 이 도움말은 --help · -h · help 로 보며, 그때는 아무것도 위탁하지 않습니다.",
    "",
    "위탁 옵션",
    "  --repo <이름>        대상 레포를 워커에 자동 준비(공유 base → worktree, 그 자리가 cwd)",
    "  --ref <ref>          --repo 를 뜰 ref",
    "  --node <id>          이 노드에 배치",
    "  --ram <MB>  --cpu <N>  --disk <MB>   필요 자원(이만큼 여유 있는 노드에만 배치)",
    "  --docker             docker 가 되는 노드에만 배치",
    "  --timeout <초>       제한 시간",
    "  --json               끝나면 위탁 레코드를 JSON 한 줄로 stdout 에(진행 미러 끔)",
    "  --detach             번호만 출력하고 즉시 종료 — 결과는 lively delegate logs <번호> 로 받는다",
    "  --                   이후 인자는 전부 작업 지시로 — 옵션처럼 생긴 낱말(--watch 등)을 지시에 넣을 때",
    "",
    "하위 명령",
    "  status <번호>        위탁 레코드(JSON)",
    "  logs <번호>          진행 미러 — 끝나면 결과 출력 후 종료 (--json)",
    "  cancel <번호>        취소",
    "  list                 최근 위탁 목록",
    "",
    "예",
    "  lively delegate \"npm test 전체 실행하고 실패만 보고\" --repo lively --ram 4096 --timeout 1800",
    "  lively delegate logs 42",
    "",
    "진행은 stderr, 최종 결과는 stdout · 종료 코드 0=성공 · 1=실패 · 2=사용법 오류/가용 노드 없음",
  ].join("\n");
}

const isHelpFlag = (a) => a === "--help" || a === "-h";
// 옵션 모양 — 빈칸 없는 `-x`/`--xyz`. 따옴표로 묶은 지시("-x 로 실행해")·음수("-1")는 해당 없음.
//  `--ram=2048` 처럼 `=` 로 값을 붙인 꼴도 옵션이다(GNU 관례) — 안 그러면 지시에 붙어 자원 조건 없이 위탁된다.
const looksLikeOption = (a) => /^--?[A-Za-z][\w-]*(=|$)/.test(a);
const SUBCOMMANDS = ["status", "cancel", "logs", "list"];

/**
 * `lively delegate` 인자 해석(순수 — 테스트 seam, #5028).
 *
 * ★ 왜 떼어냈나: 종전 해석은 모르는 낱말을 **전부 작업 지시에 붙였다**. 그래서 `lively delegate --help` 가
 *  도움말이 아니라 «--help» 라는 지시의 **실제 위탁**을 만들었고, 노드 배치를 기다리며 끝나지 않았다 —
 *  AI 세션들이 사용법을 보려다 이걸 반복해서 밟았다. `lively node --help`(#4006)와 같은 계열의 사고라 같은
 *  원칙으로 뒤집는다: «모르면 실행한다» → «모르면 멈추고 사용법을 보여준다».
 *   · `--help`/`-h`(`--` 앞 어디든) 또는 첫 낱말 `help` → 도움말. 하위 명령 뒤에 와도(`logs 3 --help`) 마찬가지.
 *   · 모르는 옵션(`--halp`·`--detatch`) → 오류. 지시에 넣으려면 `--` 뒤에 둔다.
 *   · 값이 필요한 옵션에 값이 없거나 숫자 옵션이 숫자가 아니면 → 오류(종전엔 NaN·undefined 로 조용히 위탁됐다).
 *
 * @param {string[]} rest `lively delegate` 뒤의 인자 원형
 * @returns {{action:"help"|"status"|"cancel"|"list"|"logs"|"run", id:string|null, prompt:string, need:object,
 *            detach:boolean, json:boolean, error:string|null}}
 */
export function parseDelegateArgv(rest = []) {
  // `--json-events` 는 main() 이 이미 소비한 전역 계약이다(cmd-node 의 parseNodeArgv 와 같은 이유로 없는 셈 친다).
  const args = (Array.isArray(rest) ? rest : []).map((a) => String(a)).filter((a) => a !== "--json-events");
  const out = { action: "run", id: null, prompt: "", need: {}, detach: false, json: false, error: null };
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  if (head.some(isHelpFlag) || args[0] === "help") return { ...out, action: "help" };
  const sub = args[0];
  if (["status", "cancel", "logs"].includes(sub)) {
    const id = args[1];
    if (!/^\d+$/.test(id || "")) return { ...out, action: sub, error: `위탁 번호가 필요합니다. 예: lively delegate ${sub} 3` };
    return { ...out, action: sub, id, json: args.includes("--json") };
  }
  if (sub === "list") return { ...out, action: "list" };
  const NUM = { "--ram": "need_ram_mb", "--cpu": "need_cpu", "--disk": "need_disk_mb", "--timeout": "timeout_sec" };
  const STR = { "--node": "node", "--repo": "repo", "--ref": "ref" };
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    let t = args[i];
    if (t === "--") { parts.push(...args.slice(i + 1)); break; }
    // `--ram=2048` → `--ram 2048` 로 펼친다(값을 붙인 꼴). 모르는 옵션이면 아래에서 그대로 거부된다.
    let inline;
    const eq = /^(--[A-Za-z][\w-]*)=(.*)$/.exec(t);
    if (eq && (NUM[eq[1]] || STR[eq[1]])) { t = eq[1]; inline = eq[2]; }
    if (NUM[t] || STR[t]) {
      const v = inline !== undefined ? inline : args[i + 1];
      if (v === undefined || v === "" || (inline === undefined && looksLikeOption(v))) return { ...out, error: `\`${t}\` 에는 값이 필요합니다` };
      if (NUM[t]) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { ...out, error: `\`${t}\` 에는 양수가 필요합니다 (받은 값: ${v})` };
        out.need[NUM[t]] = n;
      } else out.need[STR[t]] = v;
      if (inline === undefined) i++;
      continue;
    }
    if (t === "--docker") { out.need.needs_docker = true; continue; }
    if (t === "--detach") { out.detach = true; continue; }
    if (t === "--json") { out.json = true; continue; }
    if (looksLikeOption(t)) return { ...out, error: `알 수 없는 옵션: ${t} — 작업 지시에 넣으려면 \`--\` 뒤에 두세요` };
    parts.push(t);
  }
  out.prompt = parts.join(" ").trim();
  if (!out.prompt) return { ...out, error: "위탁할 작업 지시가 필요합니다." };
  // 하위 명령은 맨 앞에서만 읽는다 — `delegate --json logs 3` 이 «logs 3» 이라는 지시의 위탁이 되지 않게 멈춘다.
  //  그런 문장을 정말 위탁하려면 지시를 따옴표로 묶는다(낱말 하나가 아니게 되어 여기 걸리지 않는다).
  if (SUBCOMMANDS.includes(parts[0])) {
    return { ...out, error: `하위 명령 ${parts[0]} 은 맨 앞에 둡니다 — 예: lively delegate ${parts[0]}${parts[0] === "list" ? "" : " <번호>"}` };
  }
  return out;
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
  // 인자 해석은 순수함수 한 벌이 진다(#5028) — 도움말·오류는 API 를 한 번도 부르지 않고 끝난다.
  const p = parseDelegateArgv(rest);
  if (p.action === "help") { say(delegateUsage()); return; }
  if (p.error) die(`${p.error}\n\n${delegateUsage()}`, 2);
  if (p.action === "status") { const { task } = await api(`/api/ui/delegate/${p.id}`); process.stdout.write(JSON.stringify(task, null, 2) + "\n"); return; }
  if (p.action === "cancel") { await api(`/api/ui/delegate/${p.id}/cancel`, { method: "POST", body: {} }); say(green(`위탁 #${p.id} 취소됨`)); return; }
  if (p.action === "list") { const { tasks } = await api("/api/ui/delegate"); for (const t of (tasks || [])) say(`#${t.id}  ${t.status}${t.node_id ? "  @" + t.node_id : ""}  ${dim((t.prompt || "").slice(0, 60).replace(/\s+/g, " "))}`); return; }
  if (p.action === "logs") { await streamAndExit(p.id, p.json); return; }
  // 기본: 위탁 실행.
  const { prompt, need, detach, json: jsonMode } = p;
  // CLI 는 자체 로그 스트리밍(streamAndExit)을 하므로 서버 wait 는 끈다(이중 대기 방지).
  //  queue 옵션은 CLI 에선 기본 대기(배치 불가면 계속 폴링) — 서버엔 queue:true 로 등록(no_capacity 즉실패 대신).
  const res = await api("/api/ui/delegate", { method: "POST", body: { prompt, ...need, wait: false, queue: true }, fromSession: true });   // #4551 — 시킨 세션을 남긴다
  if (res.no_capacity) { say(red(`위탁 불가 — ${res.reason || "가용 노드 없음"}`)); say(dim("로컬에서 직접 실행하세요.")); process.exit(2); }
  const task = res.task;
  if (detach) { say(green(`위탁 #${task.id} 생성 — 진행: lively delegate logs ${task.id}`)); process.stdout.write(String(task.id) + "\n"); return; }
  say(dim(`위탁 #${task.id} 생성 — 배치 대기…`));
  await streamAndExit(task.id, jsonMode);
}
