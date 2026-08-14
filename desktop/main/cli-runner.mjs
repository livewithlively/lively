// 라이블리 CLI 구동기 (#1541 T2) — 앱이 `lively <명령> --json-events` 를 띄우고 그 NDJSON 을 읽는 층.
//
// **여기가 앱의 심장이다.** 설치·로그인·노드 제어가 전부 이 한 통로를 지난다(앱은 그 로직을 재구현하지 않는다 —
//  #864 의 '설치 로직 단일화'). 그래서 Electron API 를 **한 줄도 쓰지 않는다**: spawn 만 주입받아, Electron 없이
//  루트 테스트 체인에서 그대로 검증된다.
//
// 계약은 위키 `app-cli-json-events-contract-1541`. 요약:
//   stdout = NDJSON 이벤트(start·step·notice·prompt·result·end) · stderr = 사람용 · stdin = 답 한 줄.
//
// ⚠ 여기서 지켜야 할 것 셋:
//  1. **prompt 에 반드시 답하거나 끊는다.** CLI 는 답을 기다리며 매달린다(그게 fail-closed 의 대가다).
//  2. **stderr 를 버리지 않는다.** 실패 원인이 거기에만 있는 경우가 있다(CLI 가 이벤트를 못 낼 만큼 일찍 죽는 경로).
//  3. **`end` 를 못 받고 끝나면 실패로 본다.** 종료코드 0 이라도 계약을 지킨 종료가 아니다.
import { spawn as nodeSpawn } from "node:child_process";

/** NDJSON 스트림 파서 — 청크 경계에서 이벤트가 잘리지 않게 버퍼링한다. */
export function createNdjsonParser(onEvent, onRaw) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e = null;
        try { e = JSON.parse(line); } catch { /* NDJSON 아님 */ }
        // 객체가 아니거나 t 가 없으면 이벤트가 아니다 — 조용히 버리지 말고 raw 로 넘겨 로그에 남긴다.
        if (e && typeof e === "object" && !Array.isArray(e) && typeof e.t === "string") onEvent(e);
        else if (onRaw) onRaw(line);
      }
    },
    /** 개행 없이 끝난 마지막 줄까지 흘려보낸다. */
    flush() { if (buf.trim()) { this.push("\n"); } buf = ""; },
  };
}

/**
 * CLI 1회 실행.
 *
 * @param {object} o
 * @param {string} o.cli           lively 실행파일 경로(cli-locate 가 찾은 것)
 * @param {string[]} o.args        `--json-events` 는 여기서 붙인다(호출자가 잊지 않게)
 * @param {(e:object)=>void} [o.onEvent]   이벤트 스트림(step·notice·result…)
 * @param {(line:string)=>void} [o.onStderr] 사람용 출력 한 줄씩
 * @param {(p:object)=>Promise<any>|any} [o.onPrompt] prompt 이벤트 → 답(value). undefined 를 주면 답하지 않는다
 *                                                    (device-code 같은 통지형은 답할 게 없다).
 * @param {object} [o.env] @param {string} [o.cwd] @param {number} [o.timeoutMs]
 * @param {Function} [o.spawn]     테스트 주입용
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, events:object[], result:any, stderr:string, error:string|null}>}
 */
export function runCli(o) {
  const spawn = o.spawn || nodeSpawn;
  // ⚠ **무엇을 띄우나 ≠ 무엇을 찾았나.** Windows 심은 `.cmd` 라 그대로 spawn 하면 `EINVAL` 이다
  //  (CVE-2024-27980 이후 Node 가 배치 실행을 거부한다 — 실기기에서 앱이 CLI 를 한 번도 못 불렀다).
  //  그 판단은 cli-locate.cliLaunchSpec 이 하고 여기선 결과를 그대로 쓴다. launch 가 없으면 종전대로.
  const launch = o.launch || { cmd: o.cli, args: o.args, shell: false };
  const args = [...launch.args, "--json-events"];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launch.cmd, args, { env: o.env, cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: !!launch.shell });
    } catch (e) {
      resolve({ ok: false, code: null, signal: null, events: [], result: null, stderr: "", error: `CLI 를 실행하지 못했습니다: ${e?.message || e}` });
      return;
    }
    const events = [];
    let result = null, endEvent = null, stderr = "", spawnError = null, done = false;
    let timer = null;

    const answer = (id, value) => {
      // stdin 이 이미 닫혔으면 CLI 는 그걸 EOF 로 보고 fail-closed 로 죽는다 — 여기서 조용히 삼키지 않는다.
      try { child.stdin.write(JSON.stringify({ t: "answer", id, value }) + "\n"); } catch { /* 파이프 닫힘 */ }
    };
    const parser = createNdjsonParser((e) => {
      events.push(e);
      if (e.t === "result") result = e.data;
      if (e.t === "end") endEvent = e;
      if (o.onEvent) { try { o.onEvent(e); } catch { /* 소비자 예외가 구동을 깨지 않는다 */ } }
      if (e.t === "prompt" && o.onPrompt) {
        Promise.resolve()
          .then(() => o.onPrompt(e))
          .then((v) => { if (v !== undefined) answer(e.id, v); })
          .catch(() => { /* 답을 못 만들면 답하지 않는다 — CLI 는 계속 기다린다(끊는 건 cancel 의 몫) */ });
      }
    }, (line) => { if (o.onStderr) o.onStderr(`[stdout 비-NDJSON] ${line}`); });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => parser.push(d));
    let errBuf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += d; errBuf += d;
      let i;
      while ((i = errBuf.indexOf("\n")) >= 0) { const l = errBuf.slice(0, i); errBuf = errBuf.slice(i + 1); if (o.onStderr) o.onStderr(l); }
    });
    child.on("error", (e) => { spawnError = e?.message || String(e); });

    if (o.timeoutMs) {
      timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, o.timeoutMs);
      if (timer.unref) timer.unref();
    }
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      parser.flush();
      // ★ `end` 를 못 받았으면 성공이 아니다 — 종료코드 0 이어도 계약을 지킨 종료가 아니다(중간에 죽었거나 강제종료).
      const ok = !!endEvent && endEvent.ok === true && !signal && !spawnError;
      const error = spawnError
        || (signal ? `CLI 가 강제 종료됐습니다(${signal}).` : null)
        || (!endEvent ? "CLI 가 완료 신호(end) 없이 끝났습니다." : null)
        || (endEvent.ok ? null : lastError(events) || "CLI 가 실패했습니다.");
      resolve({ ok, code, signal: signal || null, events, result, stderr, error });
    });
    // 프로세스 취소 손잡이 — 앱이 '취소' 를 누르면 stdin 을 닫아 대기 중인 프롬프트를 fail-closed 로 풀고 종료시킨다.
    if (o.onHandle) o.onHandle({ cancel: () => { try { child.stdin.end(); } catch { /* */ } try { child.kill(); } catch { /* */ } } });
  });
}

/**
 * 이 CLI 가 **우리 계약을 아는가** — 실행 결과로만 판정한다(버전 문자열 추측 금지). 순수.
 *
 * 왜 필요한가(2026-08-11 실측): 앱보다 먼저 CLI 를 깔아 둔 PC 가 흔하다. 그 구 CLI 는 `--json-events` 를
 * **조용히 무시하고 exit 0** 으로 끝낸다 — 평범한 JSON 을 stdout 에 뱉고 NDJSON 이벤트는 **0개**다.
 * 그러면 앱은 "성공한 것 같은데 아무 일도 안 일어남" 이 된다(가장 나쁜 실패 모드 — 사람은 앱이 고장났다고 본다).
 *
 * 종전 앱은 `locateCli` 로 **있나/없나**만 봤다. 있으면 그대로 몰았으니, 이 상태가 영원히 안 풀렸다.
 * 판정은 세 갈래여야 한다 — 없다 / 있지만 말이 안 통한다 / 멀쩡하다.
 *
 * @param {{error?:string|null, events?:Array, code?:number|null, signal?:string|null}} r  runCli 결과
 * @returns {"ok"|"too-old"|"failed"|"unusable"}
 */
export function cliContractVerdict(r) {
  const o = r || {};
  if (!o || typeof o !== "object") return "unusable";
  const events = Array.isArray(o.events) ? o.events : [];
  if (events.length) return "ok";                       // 한 마디라도 우리 말로 했으면 계약을 안다
  // ⚠ 여기서 갈린다. **깨끗이 끝났는데 한 마디도 안 했다** = 플래그를 모르고 무시했다는 뜻이다.
  //  반대로 죽었거나(code≠0·시그널) 애초에 못 띄웠으면 그건 '오래됨' 이 아니라 그냥 실패다 —
  //  실패를 오래됨으로 읽으면 멀쩡한 CLI 를 네트워크 오류마다 재설치하게 된다.
  if (o.error && /실행하지 못했습니다/.test(String(o.error))) return "unusable";
  if (o.signal) return "failed";
  return o.code === 0 ? "too-old" : "failed";
}

/** 마지막 error notice 문구 — 앱이 실패 이유를 사람 말로 보여줄 때 쓴다. */
export function lastError(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t === "notice" && e.level === "error" && e.message) return e.message;
  }
  return null;
}

/**
 * 이벤트 스트림 → 화면에 그릴 진행 상태(누적 리듀서). 순수 함수라 그대로 테스트한다.
 *
 * step 은 같은 id 로 start→done/fail 이 오므로 **id 로 갱신**한다(줄이 늘어나지 않게).
 * 진행률은 마지막으로 본 i/n 을 쓴다 — 없으면 null(모르는 걸 0% 로 그리면 멈춘 것처럼 보인다).
 */
export function reduceProgress(state, e) {
  const s = state || { phase: "idle", steps: [], notices: [], prompt: null, i: null, n: null, done: false, ok: null };
  const next = { ...s, steps: [...s.steps], notices: [...s.notices] };
  if (e.t === "start") { next.phase = "running"; next.cmd = e.cmd; }
  else if (e.t === "step") {
    const at = next.steps.findIndex((x) => x.id === e.id);
    const item = { id: e.id, label: e.label || e.id, status: e.status };
    if (at >= 0) next.steps[at] = item; else next.steps.push(item);
    if (Number.isFinite(e.i)) next.i = e.i;
    if (Number.isFinite(e.n)) next.n = e.n;
  } else if (e.t === "notice") next.notices.push({ level: e.level, message: e.message });
  else if (e.t === "prompt") next.prompt = e;
  else if (e.t === "end") { next.phase = "done"; next.done = true; next.ok = e.ok === true; next.prompt = null; }
  return next;
}
