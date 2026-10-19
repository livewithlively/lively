// 작업 컨테이너 안에서 도는 판(runner) — 글자로만 있다(순수). 게이트웨이가 컨테이너 tmux 에 띄우고, 판은 하네스를 한 번 돌린 뒤 끝난다 (#4490)
//
// ── 두 조각 ──────────────────────────────────────────────────────────────────
//  ① 부트(BOOT_SOURCE) — tmux 판 명령 `node -e <부트>` 로 실린다. 브로커가 tmux 인자 하나를 4,096자로 막으므로(validateTmuxArgv)
//     작게 둔다. 하는 일은 하나: 일회용 부트 비밀(env LVLY_JOB_BOOT)로 게이트웨이 `/api/agent-jobs/<id>/boot` 를 불러
//     판 본체(code)·프롬프트·하네스 인자·콜백 비밀을 받아 실행한다.
//  ② 본체(RUNNER_SOURCE) — 부트 응답으로 온다(크기 제한 없음 · 게이트웨이 판과 늘 같은 판). 하네스를 한 번 돌리며 진행을 박동(tick)으로
//     올리고, 끝나면 결과(result)를 올린 뒤 **빠진다** — 판이 빠지면 tmux 서버가 끝나고, 세션 호스트의 3초 목록이 그것을 보아
//     브로커가 컨테이너를 곧바로 걷는다(#4696 하네스 종료 즉시 철거). `exec $SHELL` 로 남지 않는다(남으면 걷히지 않는다).
//
// ── 왜 파일을 미리 넣지 않나 ─────────────────────────────────────────────────
//  브로커 exec 는 분리 실행이 없고(끊기면 하위 트리를 죽인다) 세션 중계는 stdin 을 닫지 않는다 — 컨테이너 안에 파일을 «써 넣는» 길이
//  마땅치 않다. 멤버 홈(JuiceFS)에 쓰면 비밀이 영속 저장소·백업을 지난다. 그래서 판이 **스스로 받아 간다**: 비밀은 부트에서 한 번 쓰고
//  버리고(일회용), 콜백 비밀은 판 메모리에만 있다. 컨테이너 안 `localhost:8080` 은 세션 루프백 → mcp.sock → 그 테넌트의 게이트웨이다
//  (테넌트 헤더는 브로커가 붙인다 — 판이 테넌트를 사칭할 수 없다).
//
// ── 무엇을 믿지 않나 ─────────────────────────────────────────────────────────
//  판은 작업 AI 와 같은 uid 로 돈다 — 작업 AI 가 판의 보고를 흉내 낼 수 있다(제 작업의 결과를 제가 적는 것이라 새 권한은 아니다).
//  그래서 게이트웨이는 보고를 칸마다 거르고 자른다(plan.parseRunnerReport) · 콜백은 그 작업 하나만 연다(비밀) · 끝난 작업엔 410.

/** 컨테이너 안에서 게이트웨이에 닿는 주소(세션 루프백 — tenant-image/session-loopback.cjs 가 127.0.0.1·::1 둘 다 듣는다). */
export const RUNNER_GATEWAY = { host: "127.0.0.1", port: 8080 } as const;
/** 하네스 인자 안에서 «판이 만든 MCP 설정 파일 경로» 로 바꿔 넣을 자리표. */
export const MCP_CONFIG_PLACEHOLDER = "{{LVLY_MCP_CONFIG}}";
/** env 값 자리표 — 판이 이 작업만의 빈 설정 폴더를 만들어 바꿔 넣는다(#4488 API 키 실행 · ai-runs/service.CONFIG_DIR_PLACEHOLDER 와 같은 글자). */
export const CONFIG_DIR_PLACEHOLDER = "{{LVLY_CONFIG_DIR}}";
/** 판(부트)이 받는 env 이름 — 작업 id 와 일회용 부트 비밀. 부트가 읽자마자 지운다(하네스에 안 물려준다). */
export const JOB_ID_ENV = "LVLY_JOB_ID";
export const JOB_BOOT_ENV = "LVLY_JOB_BOOT";
/** 브로커 tmux 인자 상한(lvly-cloud validateTmuxArgv) — 부트가 넘으면 판이 아예 안 뜬다. */
export const TMUX_ARG_MAX = 4096;

/**
 * ① 부트 — `node -e` 한 인자. 게이트웨이가 5xx·연결 실패면 잠깐 기다렸다 다시 묻는다(컨테이너가 막 떠 루프백이 아직 안 들었을 수 있다).
 *  401·404·410 이면 곧바로 끝낸다(그 작업은 이미 끝났거나 남의 것이다).
 *  ★ 끝내기 전에 실패를 알린다(#4829 — `boot-failed`, 같은 부트 비밀 · 한 번 · 5초): 401(시작 응답을 못 받고 다시 물은 판) · 5xx ·
 *   끊김 · JSON 아님 · 판 본체가 곧바로 던짐(stage runner). 종전엔 사유가 tmux 화면(console.error)에만 남아 컨테이너와 함께 사라지고,
 *   작업은 시작 상한(180초) · 무응답 상한(90초)이 지나서야 일반 문장으로 끝났다. 게이트웨이에 아예 못 닿으면 알림도 못 가므로
 *   그때는 종전처럼 시작 상한이 끝낸다. 종료 코드: 3 부트 실패 · 4 응답이 JSON 아님 · 5 본체가 곧바로 던짐(알림이 답하지 않거나
 *   도중에 멈춰도 5초 뒤 같은 코드 — 답이 끝나든 끊기든 «close» 에서 끝낸다).
 */
export const BOOT_SOURCE = [
  `const h=require("http"),e=process.env,id=e.${JOB_ID_ENV},k=e.${JOB_BOOT_ENV};delete e.${JOB_BOOT_ENV};let n=0;`,
  `const G={host:"${RUNNER_GATEWAY.host}",port:${RUNNER_GATEWAY.port}},u=s=>"/api/agent-jobs/"+encodeURIComponent(id)+"/"+s,`,
  `H={authorization:"Bearer "+k,"content-type":"application/json"};`,
  `const fail=(s,c,m,x)=>{console.error("lvly-job "+s+": "+c+" "+m);`,
  `const q=h.request({...G,path:u("boot-failed"),method:"POST",headers:H,timeout:5000},r=>{r.resume();r.on("close",()=>process.exit(x))});`,
  `q.on("timeout",()=>q.destroy());q.on("error",()=>process.exit(x));q.end(JSON.stringify({stage:s,status:c,message:String(m).slice(0,300)}))};`,
  `const go=()=>{const q=h.request({...G,path:u("boot"),method:"POST",headers:H},r=>{let b="";r.setEncoding("utf8");r.on("data",d=>b+=d);`,
  `r.on("end",()=>{if(r.statusCode===200){let j;try{j=JSON.parse(b)}catch(x){return fail("boot",200,"응답이 JSON 이 아닙니다",4)}`,
  `try{new Function("job","require",j.code)(j,require)}catch(x){fail("runner",0,x&&x.message,5)}return}`,
  `if(r.statusCode>=500&&++n<30)return void setTimeout(go,1000);`,
  `fail("boot",r.statusCode,b.slice(0,300),3)})});`,
  `q.on("error",x=>{if(++n<30)return void setTimeout(go,500);fail("boot",0,x.message,3)});q.end("{}")};go();`,
].join("");

/** 부트 응답 — 판 본체가 받는 job 객체(게이트웨이 service.ts 가 만든다). */
export interface RunnerJob {
  id: number;
  /** 콜백 비밀(Bearer) — 판 메모리에만 있다. */
  secret: string;
  /** 판 본체 소스(RUNNER_SOURCE). */
  code: string;
  /** 하네스 argv — MCP_CONFIG_PLACEHOLDER 는 판이 쓴 MCP 설정 파일 경로로 바뀐다. */
  argv: string[];
  /** 하네스 stdin 으로 넣을 프롬프트. */
  prompt: string;
  /** 하네스에 줄 MCP 설정({mcpServers}) — 없으면 MCP 없이 돈다(--strict-mcp-config). */
  mcp: Record<string, unknown> | null;
  /** 하네스에 더 줄 env — 지금은 늘 비어 있다(service.onBoot). API 키 갈래(v2-9)의 프록시 주소·실행 토큰이 들어올 자리다. */
  env: Record<string, string>;
  /** 작업 폴더(컨테이너 경로). */
  cwd: string;
  timeoutMs: number;
  tickMs: number;
  tailMax: number;
  resultMax: number;
  stderrMax: number;
}

/**
 * ② 본체 — `new Function("job","require", RUNNER_SOURCE)(job, require)` 로 돈다(ES2020 · 노드 내장만).
 *  하는 일: 프롬프트·MCP 설정을 컨테이너 /tmp 의 0700 폴더에 쓰고 → 하네스를 stdin=프롬프트로 띄우고 → stream-json 을 줄마다 읽어
 *  대화 id·마지막 result·진행 꼬리를 모으고 → tickMs 마다 박동(게이트웨이가 cancel 이면 끊는다) → 시간 상한이면 끊고 →
 *  끝나면 결과를 올리고(못 올리면 다시 — 24번) → 폴더를 지우고 빠진다.
 *  ★ 결과를 올리는 동안에도 박동한다 — 박동을 먼저 멈추면 결과를 다시 보내는 동안 게이트웨이가 침묵(silent_sec)을 듣고, 일을 마친
 *   작업을 «응답 없음» 으로 끊어 결과가 사라진다(격리 리뷰). 결과가 받아들여진 뒤의 박동은 410 이라 해가 없다.
 *  끊기: SIGTERM, 10초 뒤 SIGKILL.
 */
export const RUNNER_SOURCE = String.raw`
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), http = require("http");
const J = job;
const GW = { host: "${RUNNER_GATEWAY.host}", port: ${RUNNER_GATEWAY.port} };
function call(kind, body, tries) {
  return new Promise((resolve) => {
    const once = (left) => {
      const data = JSON.stringify(body);
      const q = http.request({ host: GW.host, port: GW.port, path: "/api/agent-jobs/" + encodeURIComponent(String(J.id)) + "/" + kind, method: "POST",
        headers: { authorization: "Bearer " + J.secret, "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: 20000 }, (r) => {
        let b = ""; r.setEncoding("utf8"); r.on("data", (d) => { b += d; });
        r.on("end", () => {
          if (r.statusCode === 200) { try { resolve(JSON.parse(b)); } catch (e) { resolve({}); } return; }
          if (r.statusCode >= 500 && left > 1) { setTimeout(() => once(left - 1), 5000); return; }
          resolve({ gone: r.statusCode === 410, status: r.statusCode });
        });
      });
      q.on("timeout", () => q.destroy(new Error("timeout")));
      q.on("error", () => { if (left > 1) setTimeout(() => once(left - 1), 5000); else resolve(null); });
      q.end(data);
    };
    once(tries);
  });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job-"));
fs.chmodSync(dir, 0o700);
const promptPath = path.join(dir, "prompt.txt");
fs.writeFileSync(promptPath, J.prompt, { mode: 0o600 });
let mcpPath = null;
if (J.mcp) { mcpPath = path.join(dir, "mcp.json"); fs.writeFileSync(mcpPath, JSON.stringify(J.mcp), { mode: 0o600 }); }
const argv = J.argv.map((a) => (a === "${MCP_CONFIG_PLACEHOLDER}" ? mcpPath : a)).filter((a) => a !== null);
const env = Object.assign({}, process.env, J.env || {});
delete env.${JOB_ID_ENV}; delete env.${JOB_BOOT_ENV};
// 빈 설정 폴더 자리표(#4488 API 키 실행) — 하네스가 멤버 홈의 로그인을 읽지 않게 이 작업만의 설정 폴더를 만든다. 빈 값은 «그 변수를 지워라» 다.
for (const k of Object.keys(env)) {
  if (env[k] === "${CONFIG_DIR_PLACEHOLDER}") { const c = path.join(dir, "cfg"); fs.mkdirSync(c, { mode: 0o700 }); env[k] = c; }
  else if (env[k] === "" && (J.env || {})[k] === "") delete env[k];
}
let buf = "", events = 0, conv = null, model = null, last = null, errTail = "", stopped = null;
const tail = [];
const pushTail = (s) => { tail.push(String(s).slice(0, 2000)); let n = tail.reduce((a, x) => a + x.length + 1, 0); while (tail.length > 1 && n > J.tailMax) { n -= tail.shift().length + 1; } };
const onLine = (line) => {
  if (!line.trim()) return;
  events++;
  let ev; try { ev = JSON.parse(line); } catch (e) { pushTail(line); return; }
  if (ev && ev.type === "system" && ev.subtype === "init") { if (typeof ev.session_id === "string") conv = ev.session_id; if (typeof ev.model === "string") model = ev.model; }
  if (ev && ev.type === "result") { last = ev; if (typeof ev.session_id === "string") conv = ev.session_id; }
  if (ev && ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c && c.type === "text" && c.text) pushTail(c.text);
      else if (c && c.type === "tool_use") pushTail("▸ " + c.name);
    }
  }
};
let child;
try {
  child = cp.spawn(argv[0], argv.slice(1), { cwd: J.cwd, env, stdio: [fs.openSync(promptPath, "r"), "pipe", "pipe"] });
} catch (e) {
  errTail = "spawn: " + (e && e.message);
}
const kill = (why) => {
  if (stopped || !child) return;
  stopped = why;
  try { child.kill("SIGTERM"); } catch (e) {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 10000).unref();
};
const finish = async (code, signal) => {
  clearTimeout(deadline);
  if (buf.trim()) { onLine(buf); buf = ""; }
  const r = last ? {
    text: typeof last.result === "string" ? last.result.slice(0, J.resultMax) : null,
    is_error: last.is_error === true, subtype: typeof last.subtype === "string" ? last.subtype : null,
    num_turns: typeof last.num_turns === "number" ? last.num_turns : null,
    duration_ms: typeof last.duration_ms === "number" ? last.duration_ms : null,
    cost_usd: typeof last.total_cost_usd === "number" ? last.total_cost_usd : null,
    usage: last.usage && typeof last.usage === "object" ? last.usage : null,
  } : null;
  await call("result", { exit_code: code, signal: signal || null, stopped, conversation_id: conv, model, result: r, stderr_tail: errTail.slice(-J.stderrMax), tail: tail.join("\n") }, 24);
  clearInterval(ticker);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
};
const deadline = setTimeout(() => kill("timeout"), J.timeoutMs);
const ticker = setInterval(async () => {
  const r = await call("tick", { events, tail: tail.join("\n"), conversation_id: conv, model }, 1);
  if (r && (r.cancel === true || r.gone === true)) kill("canceled");
}, J.tickMs);
if (!child) { finish(127, null); }
else {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); } });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-J.stderrMax); });
  child.on("error", (e) => { errTail += "\nspawn: " + (e && e.message); });
  child.on("close", (code, signal) => { finish(code, signal); });
}
`;

/** 하네스 모델 이름 모양 — 별칭(sonnet·opus·haiku)이나 전체 id. `-` 로 시작하면 플래그로 읽히므로 막는다. */
export const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/i;

/**
 * (순수) 작업용 claude 인자.
 *  · `-p` + stream-json — 진행을 줄마다 읽고 마지막 result 이벤트로 답을 받는다(위탁 HEADLESS 표와 같은 규약).
 *  · `--dangerously-skip-permissions` — 사람이 승인할 자리가 없다(무인).
 *  · `--settings {"disableAllHooks":true}` — 멤버 홈의 키트 훅(맥락 주입·기록 게이트·대화 매핑 보고)을 끈다. 켜 두면 Stop 훅이 무인 실행을
 *    한 턴 더 끌고 가고, 대화 매핑 훅이 엉뚱한 세션을 덮는다. 실측(2026-10-16, claude 2.1.301): 끄면 hook 이벤트 0 · 켜면 4.
 *  · `--strict-mcp-config` — 멤버가 등록한 MCP 서버를 싣지 않는다. 라이블리 MCP 는 작업용 토큰(앱 작업이면 앱 토큰)으로만 붙인다.
 *  · 대화를 남긴다(--no-session-persistence 를 쓰지 않는다) — 같은 대화를 이어받는 작업(--resume)이 그 기록을 읽는다.
 */
export function claudeJobArgv(o: { model?: string | null; resume?: string | null; mcp: boolean; bare?: boolean }): string[] {
  if (o.model && !MODEL_RE.test(o.model)) throw new Error(`모델 이름 형식 밖: ${JSON.stringify(o.model)}`);
  return [
    "claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    //  #4488 단발 — 도구 없이 글만(`--tools ""` = 내장 도구 전부 끔 · 실측 2026-10-16 claude 2.1.301: init 이벤트 tools []). 파일 · 셸에 닿지 않는다.
    ...(o.bare ? ["--tools", ""] : []),
    ...(o.mcp ? ["--mcp-config", MCP_CONFIG_PLACEHOLDER] : []),
    ...(o.model ? ["--model", o.model] : []),
    ...(o.resume ? ["--resume", o.resume] : []),
  ];
}
