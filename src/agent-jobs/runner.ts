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
/** 같은 자리의 주소 — MCP(/mcp) · LLM 프록시(/api/llm/anthropic)가 이 아래다(#5082 — 박스 위 판은 launch-host.hostGateway 의 그 박스 포트). */
export const RUNNER_GATEWAY_URL = `http://${RUNNER_GATEWAY.host}:${RUNNER_GATEWAY.port}`;
/** 하네스 인자 안에서 «판이 만든 MCP 설정 파일 경로» 로 바꿔 넣을 자리표. */
export const MCP_CONFIG_PLACEHOLDER = "{{LVLY_MCP_CONFIG}}";
/** 하네스 인자 안에서 «판이 만든 시스템 지시 파일 경로» 로 바꿔 넣을 자리표(#5082 앱 판 지시 — 명령줄에 지시 글이 남지 않게 파일로 넘긴다). */
export const SYSTEM_PROMPT_PLACEHOLDER = "{{LVLY_SYSTEM_PROMPT}}";
/** env 값 자리표 — 판이 이 작업만의 빈 설정 폴더를 만들어 바꿔 넣는다(#4488 API 키 실행 · ai-runs/service.CONFIG_DIR_PLACEHOLDER 와 같은 글자). */
export const CONFIG_DIR_PLACEHOLDER = "{{LVLY_CONFIG_DIR}}";
/** 판(부트)이 받는 env 이름 — 작업 id 와 일회용 부트 비밀. 부트가 읽자마자 지운다(하네스에 안 물려준다). */
export const JOB_ID_ENV = "LVLY_JOB_ID";
export const JOB_BOOT_ENV = "LVLY_JOB_BOOT";
/**
 * 박스 위 실행면(#5082 launch-host.ts)만 싣는 env 둘 — 판이 부를 루프백 포트 · 워크스페이스(`x-lively-workspace`, 셀프호스트 다중 워크스페이스).
 *  매니지드 판은 싣지 않는다 — 그 판의 `localhost:8080` 은 세션 루프백이고 테넌트는 브로커가 붙인다(판이 정하지 않는다). 없으면 종전 그대로다.
 */
export const JOB_PORT_ENV = "LVLY_JOB_PORT";
export const JOB_WS_ENV = "LVLY_JOB_WS";
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
  `if(e.${JOB_PORT_ENV})G.port=+e.${JOB_PORT_ENV};if(e.${JOB_WS_ENV})H["x-lively-workspace"]=e.${JOB_WS_ENV};`,
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
  /** 하네스의 시스템 지시(#5082 앱 판 지시 · ai.instructions) — 판이 파일로 써서 SYSTEM_PROMPT_PLACEHOLDER 자리에 넣는다. 없으면 이 칸이 없다. */
  system?: string;
  /** 하네스에 더 줄 env — 지금은 늘 비어 있다(service.onBoot). API 키 갈래(v2-9)의 프록시 주소·실행 토큰이 들어올 자리다. */
  env: Record<string, string>;
  /** 작업 폴더(컨테이너 경로). */
  cwd: string;
  timeoutMs: number;
  tickMs: number;
  tailMax: number;
  resultMax: number;
  stderrMax: number;
  /**
   * #5101 API 키 작업만 — 끝에 대화 기록 묶음(설정 폴더 projects/ 아래 파일 전부 · gzip)을 올린다(/transcript · 결과보다 먼저). 그 작업의 빈 설정 폴더는
   *  끝나면 지워져, 올리지 않으면 그 대화를 이어받을 수 없다. 압축한 크기가 이 값을 넘으면 올리지 않는다. 없으면(구독 작업 — 대화가 홈에 남는다 ·
   *  관리자가 보관을 끔) 올리지 않는다.
   */
  transcriptMax?: number;
  /** 대화 기록 묶음을 풀 때 상한(바이트 — 압축 폭탄 막기 · 올리기 전 크기 재기). */
  transcriptRawMax?: number;
  /** #5101 이어받는 API 키 작업 — 앞 작업의 대화 기록 묶음(conv = 이을 대화 id · gz = gzip 의 base64). 판이 빈 설정 폴더에 되돌려 놓는다. */
  transcript?: { conv: string; gz: string };
}

/**
 * ② 본체 — `new Function("job","require", RUNNER_SOURCE)(job, require)` 로 돈다(ES2020 · 노드 내장만).
 *  하는 일: 프롬프트·MCP 설정을 컨테이너 /tmp 의 0700 폴더에 쓰고 → 하네스를 stdin=프롬프트로 띄우고 → stream-json 을 줄마다 읽어
 *  대화 id·마지막 result·진행 꼬리를 모으고 → tickMs 마다 박동(게이트웨이가 cancel 이면 끊는다) → 시간 상한이면 끊고 →
 *  끝나면 (API 키 작업이면 대화 기록을 먼저 올리고 — #5101) 결과를 올리고(못 올리면 다시 — 24번) → 폴더를 지우고 빠진다.
 *  이어받는 API 키 작업이면 하네스를 띄우기 전에 앞 대화 기록을 빈 설정 폴더에 되돌려 놓는다(#5101).
 *  ★ 결과를 올리는 동안에도 박동한다 — 박동을 먼저 멈추면 결과를 다시 보내는 동안 게이트웨이가 침묵(silent_sec)을 듣고, 일을 마친
 *   작업을 «응답 없음» 으로 끊어 결과가 사라진다(격리 리뷰). 결과가 받아들여진 뒤의 박동은 410 이라 해가 없다.
 *  끊기: SIGTERM, 10초 뒤 SIGKILL.
 */
export const RUNNER_SOURCE = String.raw`
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), http = require("http");
const J = job;
const GW = { host: "${RUNNER_GATEWAY.host}", port: ${RUNNER_GATEWAY.port} };
// 박스 위 실행면(#5082)만 싣는 둘 — 포트 · 워크스페이스. 없으면 종전 그대로(매니지드는 브로커가 테넌트를 붙인다).
if (process.env.${JOB_PORT_ENV}) GW.port = Number(process.env.${JOB_PORT_ENV});
const WS = process.env.${JOB_WS_ENV} || "";
// raw = { buf, type, headers } 면 JSON 대신 그 바이트를 그대로 보낸다(#5101 대화 기록 — gzip).
function call(kind, body, tries, raw) {
  return new Promise((resolve) => {
    const once = (left) => {
      const data = raw ? raw.buf : JSON.stringify(body);
      const q = http.request({ host: GW.host, port: GW.port, path: "/api/agent-jobs/" + encodeURIComponent(String(J.id)) + "/" + kind, method: "POST",
        headers: Object.assign({ authorization: "Bearer " + J.secret, "content-type": raw ? raw.type : "application/json", "content-length": Buffer.byteLength(data) }, raw ? raw.headers : {}, WS ? { "x-lively-workspace": WS } : {}), timeout: 20000 }, (r) => {
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
let sysPath = null;
if (J.system) { sysPath = path.join(dir, "system.md"); fs.writeFileSync(sysPath, J.system, { mode: 0o600 }); }
const argv = J.argv.map((a) => (a === "${MCP_CONFIG_PLACEHOLDER}" ? mcpPath : a === "${SYSTEM_PROMPT_PLACEHOLDER}" ? sysPath : a)).filter((a) => a !== null);
const env = Object.assign({}, process.env, J.env || {});
delete env.${JOB_ID_ENV}; delete env.${JOB_BOOT_ENV}; delete env.${JOB_PORT_ENV}; delete env.${JOB_WS_ENV};
// 빈 설정 폴더 자리표(#4488 API 키 실행) — 하네스가 멤버 홈의 로그인을 읽지 않게 이 작업만의 설정 폴더를 만든다. 빈 값은 «그 변수를 지워라» 다.
let cfgDir = null;
for (const k of Object.keys(env)) {
  if (env[k] === "${CONFIG_DIR_PLACEHOLDER}") { const c = path.join(dir, "cfg"); fs.mkdirSync(c, { mode: 0o700 }); env[k] = c; cfgDir = c; }
  else if (env[k] === "" && (J.env || {})[k] === "") delete env[k];
}
let buf = "", events = 0, conv = null, model = null, last = null, errTail = "", stopped = null, tNote = "";
// #5101 대화 기록 묶음 — 그 빈 설정 폴더의 projects/ 아래 파일 전부(대화 파일 · 큰 도구 결과 파일 <대화>/tool-results/* · 하위 에이전트 대화)를
//  projects/ 기준 상대 경로 그대로 담는다: gzip(JSON {v:1, cfg:<이 작업의 설정 폴더>, files:[{p, d(base64)}]}). 큰 도구 결과는 대화 파일에
//  «<설정 폴더>/projects/…/tool-results/x.txt 에 저장했다» 는 안내문으로만 남는다(collect-run-script 머리말 · 매니지드 실측 2026-10-16) — 그래서 파일까지
//  담고, 되돌릴 때 대화 파일(.jsonl) 속 앞 작업의 설정 폴더 경로를 이 작업의 경로로 바꿔 쓴다(이어받은 AI 가 그 파일을 다시 읽을 수 있게).
//  되돌린 대화 파일은 원래 자리(작업 폴더 이름의 폴더)에 놓인다 — claude 가 --resume <id> 를 그 자리에서 찾는다(다른 폴더에서도 찾지만 그 동작에 기대지 않는다).
const zlib = require("zlib");
const CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEG_RE = /^[A-Za-z0-9._-]{1,200}$/;
const BUNDLE_FILES_MAX = 2000;
const RAW_MAX = J.transcriptRawMax || 67108864;
const projDir = () => path.join(cfgDir, "projects");
const safeRel = (rel) => typeof rel === "string" && rel.length < 1024 && rel.split("/").every((s) => SEG_RE.test(s) && s !== "." && s !== "..");
const listProjectFiles = () => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && safeRel(r)) out.push(r);
      if (out.length > BUNDLE_FILES_MAX) throw new Error("파일이 너무 많다(" + BUNDLE_FILES_MAX + " 초과)");
    }
  };
  walk(projDir(), "");
  return out;
};
if (cfgDir && J.transcript && CONV_RE.test(String(J.transcript.conv))) {
  try {
    const b = JSON.parse(zlib.gunzipSync(Buffer.from(String(J.transcript.gz), "base64"), { maxOutputLength: RAW_MAX }).toString("utf8"));
    if (!b || b.v !== 1) throw new Error("묶음 형식(v " + String(JSON.stringify(b && b.v)).slice(0, 40) + ")을 모른다");
    const from = typeof b.cfg === "string" && b.cfg.length > 1 ? b.cfg + "/" : null;
    const files = Array.isArray(b.files) ? b.files.slice(0, BUNDLE_FILES_MAX) : [];
    //  전부 아니면 없음 — 먼저 다 바꿔 세고(경로를 바꿔 쓰면 늘 수 있다 · 짧은 앞 경로) 상한 안일 때만 쓴다. 반쯤 놓인 대화(큰 결과 파일 없이)로 잇지 않는다.
    const put = [];
    let found = false, written = 0;
    for (const f of files) {
      if (!f || !safeRel(f.p)) continue;
      let data = Buffer.from(String(f.d || ""), "base64");
      if (from && f.p.endsWith(".jsonl")) data = Buffer.from(data.toString("utf8").split(from).join(cfgDir + "/"), "utf8");
      if ((written += data.length) > RAW_MAX) throw new Error("되돌릴 크기가 상한(" + RAW_MAX + ")을 넘는다");
      put.push([f.p, data]);
      if (f.p.endsWith("/" + J.transcript.conv + ".jsonl")) found = true;
    }
    for (const [p, data] of put) {
      const dest = path.join(projDir(), p);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, data, { mode: 0o600 });
    }
    if (!found) tNote += "transcript restore: 그 대화 파일이 묶음에 없다\n";
  } catch (e) { tNote += "transcript restore: " + (e && e.message) + "\n"; }
}
// #5101 끝난 대화를 올린다(API 키 작업 — 빈 설정 폴더는 끝나면 지운다). 결과보다 먼저 — 결과가 곧바로 같은 대화를 잇는 작업(형식 재시도)을 낳을 수 있다.
//  읽기 전에 크기부터 잰다 — 너무 큰 기록을 메모리에 올리다 판이 죽으면 결과까지 잃는다(base64 · JSON 을 더해도 풀린 상한 안이어야 한다).
//  못 올리면(되돌리지 못한 것도) 그 까닭을 결과 보고의 transcript_note 칸에 싣는다 — 게이트웨이가 작업 번호와 함께 경고 로그로 남긴다. 나중에 이어받기가
//   «기록이 없습니다» 로 거절될 때 어느 상한이었는지 그 작업으로 찾는다(격리 리뷰). stderr_tail 에 섞지 않는다 — 실패 글은 그 끝 세 줄을 쓴다.
const skipTranscript = (why) => { tNote += "transcript skipped: " + why + "\n"; };
const saveTranscript = async () => {
  if (!cfgDir || !conv || !CONV_RE.test(conv) || !(J.transcriptMax > 0)) return;
  let gz = null;
  try {
    const files = listProjectFiles();
    if (!files.some((r) => r.endsWith("/" + conv + ".jsonl"))) return skipTranscript("대화 파일(" + conv + ".jsonl)이 없다");
    let total = 0;
    for (const r of files) total += fs.statSync(path.join(projDir(), r)).size;
    if (total > RAW_MAX * 0.7) return skipTranscript("풀린 크기 " + total + " > " + Math.floor(RAW_MAX * 0.7));
    const bundle = { v: 1, cfg: cfgDir, files: files.map((r) => ({ p: r, d: fs.readFileSync(path.join(projDir(), r)).toString("base64") })) };
    gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
  } catch (e) { return skipTranscript(String(e && e.message)); }
  if (gz.length > J.transcriptMax) return skipTranscript("압축 " + gz.length + " > " + J.transcriptMax);
  const r = await call("transcript", null, 3, { buf: gz, type: "application/gzip", headers: { "x-lvly-conversation": conv } });
  if (!r || r.status) tNote += "transcript upload: " + (r ? r.status : "연결 실패") + "\n";
  else if (r.stored === false) tNote += "transcript upload: 새로 받지 않았다(이미 받았거나 받을 일이 없다고 답함)\n";
};
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
  await saveTranscript();
  await call("result", { exit_code: code, signal: signal || null, stopped, conversation_id: conv, model, result: r, stderr_tail: errTail.slice(-J.stderrMax), tail: tail.join("\n"), transcript_note: tNote ? tNote.slice(-1000) : null }, 24);
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
export const MODEL_RE = /^[a-z0-9][a-z0-9.\-\[\]]{1,63}$/i;

/**
 * (순수) 작업용 claude 인자.
 *  · `-p` + stream-json — 진행을 줄마다 읽고 마지막 result 이벤트로 답을 받는다(위탁 HEADLESS 표와 같은 규약).
 *  · `--dangerously-skip-permissions` — 사람이 승인할 자리가 없다(무인).
 *  · `--settings {"disableAllHooks":true}` — 멤버 홈의 키트 훅(맥락 주입·기록 게이트·대화 매핑 보고)을 끈다. 켜 두면 Stop 훅이 무인 실행을
 *    한 턴 더 끌고 가고, 대화 매핑 훅이 엉뚱한 세션을 덮는다. 실측(2026-10-16, claude 2.1.301): 끄면 hook 이벤트 0 · 켜면 4.
 *  · `--strict-mcp-config` — 멤버가 등록한 MCP 서버를 싣지 않는다. 라이블리 MCP 는 작업용 토큰(앱 작업이면 앱 토큰)으로만 붙인다.
 *  · 대화를 남긴다(--no-session-persistence 를 쓰지 않는다) — 같은 대화를 이어받는 작업(--resume)이 그 기록을 읽는다.
 *  · #5082 앱 판 지시(system) — 게이트웨이가 «부른 사람의 판» 에서 읽은 지시 파일을 시스템 지시로 싣고(파일 — 명령줄에 글이 남지 않게),
 *    작업 폴더(앱 데이터 폴더 — 구성원 · 작업 AI 가 고칠 수 있다)의 CLAUDE.md · .claude/(skills · agents · commands · settings)는 읽지 않는다
 *    (`--setting-sources user`). 실측(2026-10-29, claude 2.1.312): 제한이 없으면 작업 폴더의 CLAUDE.md · 스킬이 요청에 실리고, user 만 주면
 *    둘 다 빠지며, 지시 파일은 system 에 실린다(격리 리뷰: settings · agents · commands 도 빠진다).
 *    ⚠ user(실행 계정 홈의 ~/.claude)는 그대로 읽는다 — 구독 실행이면 그 구성원의 홈이라 같은 계정으로 도는 작업 AI 가 거기에 쓸 수 있다.
 *     «지시는 판으로만 바뀐다» 는 앱 폴더에 대한 보장이다. API 키 · 홈 없는 실행은 빈 설정 폴더라 user 도 비어 있다.
 *     #5081 공용 시트 실행은 그 홈을 구성원 모두가 함께 쓴다 — 한 사람의 작업 AI 가 쓴 글이 다른 사람의 작업에 읽힐 수 있다(#5123 공용 시트 홈 격리).
 *  · 이어받기는 늘 갈라서 잇는다(`--fork-session` · #5101) — 앞 작업의 대화 파일은 그대로 두고 새 대화 id 로 이어 쓴다. 같은 대화를 잇는 작업이 둘 겹쳐도
 *    한 파일에 같이 쓰지 않고, 앞 실행에서 몇 번이든 다시 갈라 이을 수 있다(실측 2026-10-29 · claude 2.1.312: 새 id · 앞 파일 내용 그대로 ·
 *    요청에 앞 대화가 다 실림 — 빈 설정 폴더에 되돌려 놓은 기록에서도 같다).
 */
export function claudeJobArgv(o: { model?: string | null; resume?: string | null; mcp: boolean; bare?: boolean; system?: boolean }): string[] {
  if (o.model && !MODEL_RE.test(o.model)) throw new Error(`모델 이름 형식 밖: ${JSON.stringify(o.model)}`);
  return [
    "claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    //  #4488 단발 — 도구 없이 글만(`--tools ""` = 내장 도구 전부 끔 · 실측 2026-10-16 claude 2.1.301: init 이벤트 tools []). 파일 · 셸에 닿지 않는다.
    ...(o.bare ? ["--tools", ""] : []),
    ...(o.mcp ? ["--mcp-config", MCP_CONFIG_PLACEHOLDER] : []),
    ...(o.system ? ["--append-system-prompt-file", SYSTEM_PROMPT_PLACEHOLDER, "--setting-sources", "user"] : []),
    ...(o.model ? ["--model", o.model] : []),
    ...(o.resume ? ["--resume", o.resume, "--fork-session"] : []),
  ];
}
