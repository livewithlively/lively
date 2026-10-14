// 이 대화가 띄우고 아직 안 끝난 백그라운드 작업 수 (#4588) — work-flag 가 Stop 에 세어 실행 단계 보고(idle)에 싣는다.
//
//  왜: 사이드바 점은 Claude Code 화면의 «… · 1 shell still running» 을 «AI 가 백그라운드 작업을 기다린다»(#4502)로 읽어
//   파랗게 깜빡인다. 그런데 «남은 셸» 이 AI 가 기다리는 작업이라는 보장이 없다. 실측(2026-10-06~07, 맥미니 노드 Claude Code 2.1.289
//   세션 둘 — box-wonjoon-jang-8923ed5b · c6f65b07): AI 가 하루 이틀 전에 띄운 «테스트가 끝나길 기다리는 반복문» 이 시간 초과로
//   백그라운드로 넘어간 뒤 완료 알림이 영영 오지 않았다. AI 는 그 작업을 잊고 «아무것도 안 돈다, 답을 기다린다» 고 말했고, 점은
//   이틀째 «작업 중» 으로 깜빡였다(원준님: «이 세션 끝났는데도 계속 파란불 깜빡거려»).
//   ⇒ 사람의 요청(2026-10-07): **실제로 도는지를 재서 센다.** 대화 기록으로 «띄운 것 − 끝난 것» 을 구하고, 셸 작업은 그 프로세스가
//   지금 살아 있는지를 다시 잰다(liveShells — 아래 「살아 있나」).
//
//  셈: 띄움(도구 결과의 머리) − 끝남(완료 알림 · 중지 결과). 대화 기록에 적힌 문구 그대로다(Claude Code 2.1.289~291 실측).
//   띄움  · Bash run_in_background   «Command running in background with ID: <id>»
//         · 시간 초과로 넘어간 Bash   «Command did not complete within its 120s timeout and was moved to the background (ID: <id>)»
//         · 백그라운드 에이전트      «Async agent launched successfully. … agentId: <id>»
//         · Monitor                 «Monitor started (task <id>, …»
//   끝남  · 완료 알림 «<task-notification> <task-id><id></task-id> … <status>completed|failed|killed</status>» — 대기열(queue-operation) ·
//           첨부(attachment.prompt) · 사용자 줄 어디에 적혀도 같은 알림이다. Monitor 의 사건 알림은 <status> 가 없어 끝남이 아니다.
//         · TaskStop 결과 «{"message":"Successfully stopped task: <id> …","task_id":"<id>"}» (옛 KillShell «Successfully killed shell: <id>»)
//  ⚠ 문구는 **도구 결과·알림의 머리**에서만 읽는다. 대화 본문이나 다른 대화를 grep 한 출력에 같은 문구가 적혀 있어도 세지 않으려고.
//   서브에이전트 줄(isSidechain)도 안 센다 — 그 작업의 알림은 메인이 아니라 그 에이전트에게 간다.
//  ⚠ 틀리는 방향: 못 읽으면 null(=모른다)을 돌려 보고에 싣지 않는다 → 서버는 종전대로 화면을 믿는다(파란 점). 끝남을 놓치면 열린 채로
//   세어 역시 화면을 믿는다. **위험한 쪽은 띄움을 놓치는 것 하나다**(0 으로 세어 기다리는 세션의 점이 꺼진다). 그래서 띄우라고 부른
//   도구(Bash·Agent run_in_background:true · Monitor)의 결과가 아는 띄움 문구도 오류도 아니면 — Claude Code 가 문구를 바꿨다는 뜻이다 —
//   그 대화는 «모른다»(null)로 둔다. «0» 은 대화 기록을 끝까지 읽고, 띄운 것을 다 알아보고, 열린 게 없을 때만 나온다.
//
//  살아 있나(셸 작업만): Claude Code 는 백그라운드 셸(처음부터 백그라운드든 시간 초과로 넘어갔든)의 stdout·stderr 를 띄움 문구가 말하는
//   출력 파일(…/tasks/<id>.output)에 **곧바로** 연결한다. 그래서 그 파일을 쥔 프로세스가 있으면 그 셸(또는 그 자식)이 살아 있고,
//   없으면 끝났다(실측 2.1.291 macOS — lsof 로 도는 셸은 zsh·자식이 fd 1·2 로 쥐고, 끝난 셸은 쥔 프로세스 0. Claude 본체는 안 쥔다).
//   · 리눅스: /proc/<pid>/fd 링크를 읽는다(외부 명령 없음) · macOS: lsof(host-effects 경유) · 그 밖(윈도우): 못 잰다.
//   · 못 재거나 파일이 없으면 «살아 있다» 로 센다(종전대로 화면을 믿는 쪽 — 임시 폴더가 청소돼 지워진 파일을 도는 셸이 쥐고 있을 수 있다).
//   · 에이전트·Monitor 는 쥘 파일이 없다(에이전트는 대화 기록을 가리키는 심링크 · Monitor 는 파이프) — 대화 기록 셈 그대로다.
//     둘 다 완료 알림이 확실히 온다(Monitor 는 시간 제한이 있다).
//
//  증분: 대화 기록은 덧붙이기만 한다(Claude Code 의 jsonl). 읽은 끝(size)과 열린·닫힌 id 를 플래그 디렉터리에 두고 새로 붙은 바이트만
//   읽는다. 경로가 다르거나 파일이 줄었으면 처음부터 다시 읽는다(같은 경로가 더 큰 다른 내용으로 바뀌는 일은 덧붙이기 규약상 없다고 본다).
//  알려진 한계(둘 다 «화면을 믿는» 안전한 쪽이다): 상한(MAX_SCAN_BYTES)을 넘는 첫 읽기는 포기한다(null — 훅은 턴 끝의 길목이다).
//   이어 열기(resume)로 옛 기록이 새 파일에 복사되면, 옛 프로세스와 함께 죽은 작업은 끝남 줄 없이 열린 채로 남는다.
//   플래그 없이 백그라운드로 도는 에이전트(fork 등)는 띄움 문구로만 알아본다 — 그 문구가 바뀌면 못 막는다(도구 이름이 바뀌어도 같다).
import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, readlinkSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostEffects } from "./host-effects-port.mjs";

const LAUNCH = [
  /^Command running in background with ID: ([\w-]+)/,
  /^Command did not complete within its [\d.]+m?s timeout and was moved to the background \(ID: ([\w-]+)\)/,
  /^Async agent launched successfully\b[\s\S]{0,400}?\bagentId: ([\w-]+)/,
  /^Monitor started \(task ([\w-]+)/,
];
const STOPPED = /^Successfully (?:stopped task|killed shell):? ([\w-]+)/;
//  셸 띄움(앞의 둘)이 말하는 출력 파일 — 살아 있나를 잴 자리.
const OUTPUT_FILE = /Output is being written to: (\S+?\.output)\b/;
const NOTICE = "<task-notification>";
//  이 낱말이 하나도 없는 줄은 JSON 으로 풀지 않는다(긴 대화 기록에서 Stop 훅을 빠르게 — 거의 모든 줄이 여기서 걸러진다).
//  뒤의 셋은 «띄우라고 부른 도구» 와 그 오류 결과를 보려는 것이다(띄움 문구를 못 알아본 경우를 «모른다» 로 돌리려고).
const HINTS = ["in background with ID", "moved to the background", "Async agent launched", "Monitor started", NOTICE, "Successfully stopped task", "Successfully killed shell",
  '"run_in_background":true', '"name":"Monitor"', '"is_error":true'];
export const MAX_SCAN_BYTES = 96 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const MAX_IDS = 4000;

function textsOf(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b && typeof b === "object" && typeof b.text === "string" ? [b.text] : []));
}

/**
 * 대화 기록 한 줄(JSON 객체)이 띄운·끝낸 작업 id. 순수 — 표는 bg-jobs.test.mjs.
 *  expects  = 띄우라고 부른 도구 호출 id(Bash·Agent run_in_background:true · Monitor)
 *  answered = 그 호출에 답이 된 결과의 호출 id(띄움 문구로 알아봤거나 오류 결과)
 */
export function jobEventsOf(o) {
  const launched = [], closed = [], expects = [], answered = [], outputs = {};
  if (!o || typeof o !== "object" || o.isSidechain === true) return { launched, closed, expects, answered, outputs };
  const notices = [];
  if (typeof o.content === "string") notices.push(o.content);                                  // queue-operation
  if (o.attachment && typeof o.attachment.prompt === "string") notices.push(o.attachment.prompt); // 턴 중에 온 알림(queued_command)
  const msg = o.message && typeof o.message === "object" ? o.message : null;
  if (msg && o.type === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || b.type !== "tool_use" || typeof b.id !== "string") continue;
      if (((b.name === "Bash" || b.name === "Agent" || b.name === "Task") && b.input?.run_in_background === true) || b.name === "Monitor") expects.push(b.id);
    }
  }
  if (msg && o.type === "user") {
    notices.push(...textsOf(msg.content));
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || b.type !== "tool_result") continue;
        if (b.is_error === true && typeof b.tool_use_id === "string") answered.push(b.tool_use_id);
        for (const raw of textsOf(b.content)) {
          const t = raw.trimStart();
          for (const [k, re] of LAUNCH.entries()) {
            const m = re.exec(t);
            if (!m) continue;
            launched.push(m[1]);
            if (typeof b.tool_use_id === "string") answered.push(b.tool_use_id);
            const out = k < 2 ? OUTPUT_FILE.exec(t)?.[1] : undefined;   // 셸 띄움(앞의 둘)만 출력 파일을 쥔다
            if (out) outputs[m[1]] = out;
            break;
          }
          let stop = STOPPED.exec(t);
          if (!stop && t.startsWith("{")) {
            try { const j = JSON.parse(t); if (typeof j?.message === "string") stop = STOPPED.exec(j.message); } catch { /* 결과가 JSON 이 아니다 */ }
          }
          if (stop) closed.push(stop[1]);
        }
      }
    }
  }
  for (const raw of notices) {
    const t = raw.trimStart();
    if (!t.startsWith(NOTICE)) continue;
    const id = /<task-id>([^<]+)<\/task-id>/.exec(t)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(t)?.[1]?.trim();
    if (id && status && status !== "running") closed.push(id);
  }
  return { launched, closed, expects, answered, outputs };
}

/**
 * 대화 기록 조각(완결된 줄들)을 상태에 먹인다(순수). state = { open, closed, pending? }.
 *  pending = 띄우라고 불렀는데 아직 알아본 답이 없는 호출 id. 대화 기록을 다 읽었는데 남아 있으면 «모른다»(countOpenJobs).
 */
export function feedLines(text, state) {
  const open = new Set(state.open), closed = new Set(state.closed), pending = new Set(state.pending || []);
  const shells = { ...(state.shells || {}) };   // 열린 셸 작업 id → 출력 파일
  for (const line of text.split("\n")) {
    if (!line || !HINTS.some((h) => line.includes(h))) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ev = jobEventsOf(o);
    for (const id of ev.expects) pending.add(id);
    for (const id of ev.answered) pending.delete(id);
    for (const id of ev.launched) if (!closed.has(id)) { open.add(id); if (ev.outputs[id]) shells[id] = ev.outputs[id]; }
    for (const id of ev.closed) { open.delete(id); closed.add(id); delete shells[id]; }
  }
  for (const id of Object.keys(shells)) if (!open.has(id)) delete shells[id];
  //  닫힌 id 는 «끝난 뒤에 띄움 줄이 다시 읽히는» 일(같은 줄 두 벌)을 막는 데만 쓴다 — 오래된 것부터 버린다.
  return { open: [...open], closed: [...closed].slice(-MAX_IDS), pending: [...pending].slice(-MAX_IDS), shells };
}

/**
 * 출력 파일들 가운데 **지금 어떤 프로세스가 쥐고 있는** 것(실경로 집합). 못 재면 null.
 *  리눅스는 /proc/<pid>/fd 를 읽고, macOS 는 lsof 를 부른다(파일을 하나도 안 쥐었으면 lsof 는 종료코드 1 — 빈 집합이다).
 *  deps 는 시험용(플랫폼 · 명령 실행 · /proc 뿌리).
 */
export function heldFiles(paths, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const want = new Set(paths);
  if (!want.size) return new Set();
  if (platform === "linux") {
    const root = deps.procRoot ?? "/proc";
    let pids;
    try { pids = readdirSync(root).filter((d) => /^\d+$/.test(d)); } catch { return null; }
    const held = new Set();
    for (const pid of pids) {
      let fds;
      try { fds = readdirSync(join(root, pid, "fd")); } catch { continue; }   // 남의 프로세스 · 방금 끝난 프로세스
      for (const fd of fds) {
        try { const t = readlinkSync(join(root, pid, "fd", fd)); if (want.has(t)) held.add(t); } catch { /* 방금 닫혔다 */ }
      }
    }
    return held;
  }
  if (platform === "darwin") {
    const exec = deps.exec ?? ((cmd, args, opts) => hostEffects.execFileSync(cmd, args, opts));
    let out;
    try {
      out = String(exec("lsof", ["-w", "-F", "n", "--", ...want], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch (e) {
      if (e && e.status === 1) out = String(e.stdout ?? "");   // 일부(또는 전부)를 아무도 안 쥐었다 — 정상
      else return null;                                        // lsof 없음 · 막힘 · 시간 초과 — 모른다
    }
    const held = new Set();
    for (const line of out.split("\n")) if (line.startsWith("n") && want.has(line.slice(1))) held.add(line.slice(1));
    return held;
  }
  return null;
}

/**
 * 열린 셸 작업 가운데 **끝난 것**(쥔 프로세스가 없다)의 id. 못 재거나 파일이 없으면 끝났다고 하지 않는다.
 * @param {Record<string, string>} shells  열린 셸 작업 id → 출력 파일
 */
export function deadShells(shells, deps = {}) {
  const real = {};
  for (const [id, path] of Object.entries(shells || {})) {
    try { if (existsSync(path)) real[id] = realpathSync(path); } catch { /* 모른다 — 살아 있다고 센다 */ }
  }
  const ids = Object.keys(real);
  if (!ids.length) return [];
  const held = (deps.held ?? heldFiles)(Object.values(real), deps);
  if (!held) return [];
  return ids.filter((id) => !held.has(real[id]));
}

/**
 * 열린 백그라운드 작업 수(셸은 지금 살아 있는 것만). 못 읽으면 null.
 * @param {string} file  대화 기록(hook 입력의 transcript_path)
 * @param {string} cacheFile  증분 상태(플래그 디렉터리)
 * @param {object} [deps]  시험용 — held(paths) 로 «쥔 파일» 판정을 바꿔 끼운다
 */
export function countOpenJobs(file, cacheFile, deps = {}) {
  try {
    if (!file) return null;
    const size = statSync(file).size;
    let st = null;
    try { st = JSON.parse(readFileSync(cacheFile, "utf8")); } catch { /* 첫 읽기 */ }
    let state = { open: [], closed: [] }, from = 0;
    if (st && st.file === file && Number.isFinite(st.size) && st.size <= size && Array.isArray(st.open) && Array.isArray(st.closed)) {
      state = { open: st.open, closed: st.closed, pending: Array.isArray(st.pending) ? st.pending : [], shells: st.shells && typeof st.shells === "object" ? st.shells : {} }; from = st.size;
    }
    if (size - from > MAX_SCAN_BYTES) return null;
    const fd = openSync(file, "r");
    let pos = from, carry = Buffer.alloc(0);
    try {
      const buf = Buffer.alloc(CHUNK);
      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        //  줄 경계는 바이트로 자른다 — 덩어리 경계에서 한글(3바이트)이 갈려도 완결된 줄만 문자열로 푼다.
        //  완결된 줄만 먹인다. 쓰다 만 마지막 줄은 다음 번에 그 시작부터 다시 읽는다(읽은 끝을 그 줄 머리로 되돌린다).
        const bytes = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        const cut = bytes.lastIndexOf(0x0a);
        if (cut < 0) { carry = bytes; continue; }
        state = feedLines(bytes.subarray(0, cut).toString("utf8"), state);
        carry = bytes.subarray(cut + 1);
      }
    } finally { closeSync(fd); }
    const end = pos - carry.length;
    try { mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 }); writeFileSync(cacheFile, JSON.stringify({ file, size: end, ...state })); } catch { /* 다음 번에 처음부터 */ }
    //  띄우라고 부른 호출의 답을 못 알아봤다 — 띄움 문구가 바뀌었을 수 있다. 0 으로 세면 기다리는 세션의 점이 꺼지니 모른다로 둔다.
    if (state.pending && state.pending.length) return null;
    //  셸 작업은 지금 살아 있는 것만 센다. 끝난 셸을 «닫힘» 으로 저장하지는 않는다 — 한 번 잘못 잰 것이 영구히 남지 않게, 매번 다시 잰다.
    const dead = new Set(deadShells(state.shells, deps));
    return state.open.filter((id) => !dead.has(id)).length;
  } catch { return null; }
}
