// 수집 실행(#4213 T11) — 담당자의 세션 컨테이너에서 `claude -p` 한 판을 돌리는 데 쓰는 **파일·셸·해석** (순수).
//  실행(파일 쓰기·세션 열기·상태 읽기)은 collect-run.ts 가 한다. 여기는 프로세스도 파일도 만지지 않는다.
//
//  ── 왜 이 모양인가 ──
//  · 대화형 세션(TUI + 첫 지시 배달)으로는 못 돌린다. 2026-10-15 매니지드 실측에서 첫 지시가 배달되지 않거나 세션이
//    사라져 결과를 한 번도 못 받았다. 그래서 하네스 TUI 를 띄우지 않고 판(pane)에서 **러너**를 돌리고, 러너가
//    `claude -p` 를 직접 띄운다. 러너가 끝나면 판이 닫히고 브로커가 컨테이너를 바로 거둔다(#4696 하네스 종료 철거).
//  · 결과는 멤버 홈의 실행 폴더에 파일로 남는다(로그인 러너 ai-login-run.ts 와 같은 «파일로 주고받기»).
//    게이트웨이가 재기동해도 실행은 계속되고, 상태는 그 폴더를 다시 읽으면 된다.
//  · 원문은 AI 가 다시 쓰지 않는다 — PostToolUse 훅(cap.cjs)이 커넥터 결과를 그대로 파일로 남긴다
//    (2026-10-15 맥 실측: tool_response 34,204자 = 모델이 받은 결과).
//  · 읽기만 한다 — PreToolUse 훅(gate.cjs)이 «이번 실행에 허락한 claude.ai 커넥터의 읽기 도구» 밖은 전부 막는다.
//    `--permission-mode dontAsk` + 서버 단위 allow 가 같은 선을 한 겹 더 긋는다(실측 2.1.301: `mcp__claude_ai_*`
//    와일드카드는 allow 로 안 먹고, 서버 이름 `mcp__claude_ai_Slack` 은 먹는다).
//  · 허락한 앱의 도구만 문맥에 싣는다. 맥 실측(2026-10-16): 커넥터 5개 + 라이블리 MCP 를 다 실으면 한 판 기본 문맥이
//    158,651 토큰이었고, 앱 하나만 남기고 스킬을 끄면 8,395 토큰이었다. 그래서 러너가 `claude mcp list` 로 서버를 세고
//    허락한 앱 밖의 서버는 전부 `--disallowedTools mcp__<서버>` 로 뺀다(`--strict-mcp-config` 는 claude.ai 커넥터까지 지운다 — 실측).

import { COLLECT_PARENT, isCollectRunDir } from "./collect-run-pane.js";
export { COLLECT_PARENT, collectPaneArgv, isCollectRunDir } from "./collect-run-pane.js";

/** 실행 id — 시각(UTC 14자리) + 무작위 6자. 폴더 이름이 되므로 모양을 좁힌다. */
export const COLLECT_RUN_ID_RE = /^cr-\d{14}-[a-z0-9]{6}$/;
/** 세션 이름 — 사람 목록에는 세우지 않지만(web lib/proj-none) 운영 화면·로그에서 알아보게. */
export const COLLECT_SESSION_LABEL = "수집 실행";
/** 기본 모델 — 도구만 부르는 수집 부분은 작은 모델로 고정한다(계정 기본값을 따라 바뀌지 않게 — #2467). */
export const COLLECT_DEFAULT_MODEL = "haiku";

/** (순수) 새 실행 id. rand 는 [a-z0-9] 6자 이상 — 앞 6자만 쓴다. */
export function newCollectRunId(now: Date, rand: string): string {
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = String(rand).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  return `cr-${ts}-${r}`;
}

/** (순수) 그 사람의 실행 폴더. */
export function collectRunDir(home: string, runId: string): string {
  if (!COLLECT_RUN_ID_RE.test(runId)) throw new Error(`수집 실행 id 형식 오류: ${runId}`);
  return `${String(home).replace(/\/+$/, "")}/${COLLECT_PARENT}/${runId}`;
}

/** 러너가 읽는 일감. */
export interface CollectJob {
  v: 1;
  runId: string;
  /** claude 에 stdin 으로 넣을 지시. */
  prompt: string;
  model: string;
  maxTurns: number;
  timeoutSec: number;
  /** 이번 실행에 허락할 claude.ai 커넥터 앱 이름(«claude.ai » 뒤 이름 — Slack · Notion · Gmail …). 비면 연결된 것 전부. */
  apps: string[];
  /** HOME — 멤버 홈. 로그인 파일은 여기 있는 그대로 쓴다(복사하지 않는다). */
  home: string;
}

const MODEL_RE = /^[A-Za-z0-9._\[\]-]{1,64}$/;
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** (순수) 일감을 만든다 — 범위 밖 값은 거절하지 않고 안전한 쪽으로 접는다(호출 자리가 이미 검증한 값이 들어온다). */
export function collectJob(o: {
  runId: string; prompt: string; home: string;
  model?: string | null; maxTurns?: number | null; timeoutSec?: number | null; apps?: readonly string[] | null;
}): CollectJob {
  if (!COLLECT_RUN_ID_RE.test(o.runId)) throw new Error(`수집 실행 id 형식 오류: ${o.runId}`);
  const prompt = String(o.prompt || "").trim();
  if (!prompt) throw new Error("수집 지시가 비어 있습니다");
  const clamp = (v: number | null | undefined, lo: number, hi: number, d: number): number =>
    Number.isInteger(v) ? Math.min(hi, Math.max(lo, Number(v))) : d;
  const model = String(o.model || "").trim();
  const apps = [...new Set((o.apps ?? []).map((a) => String(a).trim()).filter((a) => APP_RE.test(a)))].slice(0, 12);
  return {
    v: 1,
    runId: o.runId,
    prompt,
    model: MODEL_RE.test(model) ? model : COLLECT_DEFAULT_MODEL,
    maxTurns: clamp(o.maxTurns, 1, 60, 12),
    timeoutSec: clamp(o.timeoutSec, 60, 3600, 900),
    apps,
    home: String(o.home),
  };
}

/**
 * 점검 실행의 고정 지시 — 커넥터가 뜨는지 · 훅이 원문을 받는지 · 메모리를 얼마나 쓰는지 재려고 작게 한 번 읽는다.
 *  사람의 자료를 많이 읽지 않게 «가장 작은 결과» 를 요구한다.
 */
export const COLLECT_PROBE_PROMPT = [
  "수집 실행 점검이다. 아래만 하고 다른 일은 하지 않는다.",
  "1. 쓸 수 있는 도구(claude.ai 커넥터) 가운데 앱마다 읽기 도구를 하나 골라 한 번씩 부른다.",
  "   결과가 가장 작게 나오게 인자를 준다(최근 항목 1~3건, 검색이면 짧은 낱말 하나).",
  "2. 보내기·만들기·고치기·지우기 도구는 부르지 않는다.",
  "3. 다 부른 뒤 앱마다 «앱 이름: 성공» 또는 «앱 이름: 실패(이유)» 한 줄씩만 답한다.",
].join("\n");

// ── 컨테이너 안에서 도는 스크립트 세 개(CommonJS) ─────────────────────────────────────────
//  ⚠ 여기 문자열은 **그 컨테이너의 node** 가 그대로 실행한다. TS 컴파일러가 보지 않으니 시험(collect-run-script.test.ts)이
//   실제로 node 로 돌려 본다 — 판정표·종료 코드·파일 모양이 그 시험의 대상이다.

/**
 * PreToolUse 문지기 — `node gate.cjs <폴더>`. 허락: `mcp__claude_ai_<허락한 서버>__<읽기 동사가 든 도구>` 뿐.
 *  · 막을 때는 종료 코드 2 + 사유(Claude Code 규약: 2 = 차단, 사유는 모델에게 간다).
 *  · ⚠ 2 가 아닌 비정상 종료는 «차단 아님» 으로 읽힌다(규약). 그래서 모든 갈래를 try 로 감싸 실패도 2 로 끝낸다(fail-closed).
 *  · 도구 이름은 낱말로 쪼개 본다 — 쓰기 동사가 하나라도 있으면 막고, 읽기 동사가 하나도 없으면 막는다
 *    (`notion-get-comments` 는 읽기, `slack_send_message_draft` · `gmail_create_draft` 는 쓰기).
 */
export const COLLECT_GATE_JS = String.raw`"use strict";
const fs = require("fs"), path = require("path");
const dir = process.argv[2] || "";
const READ = new Set(["search","read","get","list","fetch","query","find","view","retrieve","lookup","guide","describe","show","browse"]);
const WRITE = new Set(["send","create","update","delete","remove","post","reply","add","edit","move","archive","unarchive","draft","upload","schedule","invite","react","write","modify","patch","put","mark","rename","duplicate","trash","set","insert","append","publish","share","assign","close","merge","approve","cancel","import","export","batch","copy","restore","submit","complete","forward","pin","unpin","star","unstar","join","leave","kick","subscribe","unsubscribe","enable","disable","grant","revoke","transfer","reset","clear","run","execute","trigger","deploy","sync"]);
function decide(name, servers) {
  if (!name.startsWith("mcp__claude_ai_")) return "not a claude.ai connector tool";
  const rest = name.slice(5), i = rest.indexOf("__");
  if (i <= 0) return "unparsable tool name";
  const server = rest.slice(0, i), tool = rest.slice(i + 2);
  if (!servers.includes(server)) return "connector not allowed in this run (" + server + ")";
  const words = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => WRITE.has(w))) return "write tool";
  if (!words.some((w) => READ.has(w))) return "not a read tool";
  return null;
}
let buf = "";
process.stdin.on("data", (c) => { buf += c; }).on("end", () => {
  let name = "";
  try {
    const j = JSON.parse(buf);
    name = String(j.tool_name || "");
    const g = JSON.parse(fs.readFileSync(path.join(dir, "gate.json"), "utf8"));
    const why = decide(name, Array.isArray(g.servers) ? g.servers : []);
    try { fs.appendFileSync(path.join(dir, "gate.log"), (why ? "deny " : "allow ") + name + "\n"); } catch (_) {}
    if (!why) process.exit(0);
    process.stderr.write("lively collect run: only read tools of the allowed claude.ai connectors may be called (" + why + ": " + name + ")");
    process.exit(2);
  } catch (e) {
    process.stderr.write("lively collect run: gate error — blocked (" + (e && e.message ? e.message : e) + ")");
    process.exit(2);
  }
});
`;

/**
 * PostToolUse 원문 받기 — `node cap.cjs <폴더>`. 커넥터 결과를 **고치지 않고** `cap/<n>.json` 에 남기고, 목록 한 줄을
 *  `caps.jsonl` 에 더한다(게이트웨이는 목록만 읽고, 원문은 저장 단계가 읽는다). 실패해도 0 으로 끝낸다 — 받기 실패가
 *  수집 자체를 막지는 않는다(목록에 error 줄이 남는다).
 *  · 상한을 넘는 결과는 Claude Code 가 파일(`~/.claude/projects/<폴더>/<세션>/tool-results/*.txt`)에 저장하고 훅에도 모델에도
 *    **안내문 문자열만** 넘긴다(매니지드 실측 2026-10-16: 원문 114,934자 → 안내문 1,490자). 그때는 그 파일을 읽어 원문으로 남긴다.
 *  · ⚠ 그 파일만 읽는다 — tool_response **전체가** 안내문 문자열일 때, 그 사람 홈의 그 자리 모양(폴더/36자 세션/tool-results/*.txt)일 때만.
 *    커넥터가 돌려준 글(배열) 속에 같은 문구가 있어도 읽지 않는다 — 남이 쓴 글이 이 훅에게 아무 파일이나 읽히게 할 수 없게.
 *  · 첫 호출이 이 실행의 Claude 프로젝트 폴더(transcript_path 의 부모)를 적어 둔다 — 러너가 끝날 때 그 폴더를 치운다.
 */
export const COLLECT_CAPTURE_JS = String.raw`"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const dir = process.argv[2] || "";
const SAVED = /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to (\/[^\n]+?\.txt)\.(?:\n|$)/;
function projectsRoot() {
  const r = path.join(process.env.HOME || os.homedir(), ".claude", "projects");
  try { return fs.realpathSync(r); } catch (_) { return r; }
}
function savedFile(resp) {
  if (typeof resp !== "string") return null;
  const m = SAVED.exec(resp);
  if (!m) return null;
  let real;
  try { real = fs.realpathSync(m[1]); } catch (_) { return null; }
  const root = projectsRoot() + path.sep;
  if (!real.startsWith(root)) return null;
  const rel = real.slice(root.length).split(path.sep);
  if (rel.length !== 4 || !/^[0-9a-f-]{36}$/.test(rel[1]) || rel[2] !== "tool-results" || !/\.txt$/.test(rel[3])) return null;
  return fs.statSync(real).isFile() ? real : null;
}
const parts = [];
process.stdin.on("data", (c) => parts.push(c)).on("end", () => {
  const ts = new Date().toISOString();
  try {
    const j = JSON.parse(Buffer.concat(parts).toString("utf8"));
    const resp = j.tool_response === undefined ? null : j.tool_response;
    const saved = savedFile(resp);
    const text = saved ? fs.readFileSync(saved, "utf8") : null;
    const flat = text != null ? text : JSON.stringify(resp);
    const file = Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json";
    fs.mkdirSync(path.join(dir, "cap"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "cap", file), JSON.stringify(Object.assign({ tool_name: j.tool_name, tool_input: j.tool_input, tool_use_id: j.tool_use_id, tool_response: resp },
      text != null ? { saved_text: text } : {})), { mode: 0o600 });
    fs.appendFileSync(path.join(dir, "caps.jsonl"), JSON.stringify(Object.assign({ ts, tool: j.tool_name, id: j.tool_use_id || null, chars: flat.length, sha256: crypto.createHash("sha256").update(flat).digest("hex"), file },
      text != null ? { saved: true } : {})) + "\n", { mode: 0o600 });
    const tp = typeof j.transcript_path === "string" ? j.transcript_path : "";
    const note = path.join(dir, "claude-project.txt");
    if (tp && !fs.existsSync(note)) fs.writeFileSync(note, path.dirname(tp), { mode: 0o600 });
  } catch (e) {
    try { fs.appendFileSync(path.join(dir, "caps.jsonl"), JSON.stringify({ ts, error: String(e && e.message ? e.message : e).slice(0, 200) }) + "\n", { mode: 0o600 }); } catch (_) {}
  }
  process.exit(0);
});
`;

/**
 * 러너 — `node run.cjs <폴더>`. 세션 판의 유일한 프로세스다(끝나면 판이 닫힌다).
 *  ① 버전·지원 플래그를 잰다(이미지의 claude 는 굽는 때의 stable 이라 최신과 다를 수 있다 — 없는 플래그는 안 붙인다)
 *  ② `claude mcp list` 로 서버를 센다 → 허락할 커넥터 · 없는 커넥터 · 뺄 서버
 *  ③ 문지기·원문 받기 훅을 건 설정으로 `claude -p` 를 띄우고 지시를 stdin 으로 넣는다
 *  ④ 도는 동안 메모리를 잰다(cgroup · 프로세스 나무 RSS) · 시간이 넘으면 끊는다
 *  ⑤ 출력(stream-json)을 요약해 summary.json, 마지막으로 exit.json(끝났다는 유일한 신호 — 이름 바꾸기로 한 번에)
 *  ⚠ 기대한 커넥터가 없으면 «새 글 없음» 이 아니라 **실패**로 적는다(확정판 §8-5 — 헤드리스에서 커넥터가 빠지는 회귀).
 */
export const COLLECT_RUNNER_JS = String.raw`"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = process.argv[2];
const P = (f) => path.join(dir, f);
const rd = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch (_) { return null; } };
const W = (f, v) => fs.writeFileSync(P(f), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
const t0 = Date.now();
let job = null, child = null, timedOut = false, finished = false;
const info = { version: null, flags: {}, servers: [], connectors: [], allowed: [], missing: [], denied: [], attempts: 0, loadMisses: [] };
//  커넥터가 안 뜬 판을 몇 번까지 다시 띄우나 · 시작 알림(init)을 얼마나 기다리나.
//   (시험이 기다림을 줄이는 env — 운영에서는 안 건드린다.)
const envMs = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const LOAD_TRIES = 3, INIT_WAIT_MS = envMs("LVLY_COLLECT_INIT_WAIT_MS", 90000), RETRY_GAP_MS = envMs("LVLY_COLLECT_RETRY_GAP_MS", 3000);
// ── 메모리 ──
const num = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);
const cgNow = () => num(rd("/sys/fs/cgroup/memory.current")) ?? num(rd("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
const hasProc = fs.existsSync("/proc/self/status");
const rssKb = (pid) => { const s = rd("/proc/" + pid + "/status"); const m = s && s.match(/VmRSS:\s+(\d+)/); return m ? Number(m[1]) : 0; };
function tree(root) {
  const kids = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const st = rd("/proc/" + d + "/stat"); if (!st) continue;
    const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(d));
  }
  const all = [], q = [root];
  while (q.length) { const p = q.shift(); all.push(p); for (const k of kids.get(p) || []) q.push(k); }
  return all;
}
//  컨테이너 전체 사용 — MemTotal − MemAvailable. gVisor 세션 컨테이너는 cgroup 파일을 안 보여 주지만 /proc/meminfo 의
//   MemTotal 이 그 컨테이너의 메모리 상한이다(매니지드 실측: 보통 세션 2,560MB). 수집 세션은 이 컨테이너를 혼자 쓰므로
//   이 값이 상한(캡)과 바로 견줄 수치다. 프로세스 나무 RSS 합은 공유 페이지를 겹쳐 세서 크게 나온다(참고용).
const memInfo = () => {
  const s = rd(process.env.LVLY_COLLECT_MEMINFO || "/proc/meminfo");
  if (!s) return null;
  const g = (k) => { const m = s.match(new RegExp("^" + k + ":\\s+(\\d+)", "m")); return m ? Number(m[1]) : null; };
  const total = g("MemTotal"), avail = g("MemAvailable");
  return total != null && avail != null ? { totalKb: total, usedKb: total - avail } : null;
};
const mi0 = memInfo();
const mem = { cgPeak: 0, treePeakKb: 0, treePeakProcs: 0, samples: 0, miPeakKb: mi0 ? mi0.usedKb : 0 };
const sampler = setInterval(() => {
  mem.samples++;
  const v = cgNow(); if (v != null && v > mem.cgPeak) mem.cgPeak = v;
  const mi = memInfo(); if (mi && mi.usedKb > mem.miPeakKb) mem.miPeakKb = mi.usedKb;
  if (hasProc && child && child.pid) {
    try { const ps = tree(child.pid); let kb = 0; for (const p of ps) kb += rssKb(p); if (kb > mem.treePeakKb) { mem.treePeakKb = kb; mem.treePeakProcs = ps.length; } } catch (_) {}
  }
}, 500);
// ── 실행 ──
function env() {
  const e = Object.assign({}, process.env, { LIVELY_OFF: "1", LIVELY_HOOKS_OFF: "1" });
  //  정식 로그인으로만 돈다 — 토큰 env 가 있으면 claude 가 그쪽을 쓰고, setup-token 으로는 claude.ai 커넥터가 안 뜬다.
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "LIVELY_SESSION_ID", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ENABLE_CLAUDEAI_MCP_SERVERS"]) delete e[k];
  if (job && job.home) e.HOME = job.home;
  //  -p 는 claude.ai 커넥터를 **기다리지 않고** 붙인다(디버그 로그: «claude.ai connectors running fully async (nonblocking)»).
  //   목록은 받았는데(«Fetched 6 servers») 붙기 전에 첫 턴이 시작되면 그 판에는 도구가 없다 — 맥 실측 2026-10-16: 연달아 띄우면
  //   절반꼴로 init 의 mcp_servers 가 비었다. MCP_CONNECTION_NONBLOCKING=0 이면 붙은 뒤 시작한다(같은 날 6/6 · 한 판 7~9초).
  //   그래도 빠지면 아래 «다시 띄우기» 가 받는다. 이미 정해 둔 값이 있으면 그대로 둔다.
  if (e.MCP_CONNECTION_NONBLOCKING == null || e.MCP_CONNECTION_NONBLOCKING === "") e.MCP_CONNECTION_NONBLOCKING = "0";
  return e;
}
function run(args, ms, input) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let c;
    try { c = cp.spawn(job.bin || "claude", args, { cwd: P("work"), env: env(), stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { resolve({ code: null, out: "", err: String(e && e.message || e) }); return; }
    child = c;
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch (_) {} }, ms);
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    c.on("error", (e) => { err += String(e && e.message || e); });
    c.on("close", (code) => { clearTimeout(t); child = null; resolve({ code, out, err }); });
    //  claude 가 stdin 을 읽기 전에 끝나면(--version 처럼 빠른 것) 쓰기가 EPIPE 로 떨어진다 — 러너를 죽이지 않고 종료 코드로 판정한다
    //   (맥 실측 2026-10-16: 처리 안 하면 «runner: write EPIPE» 로 실행 전체가 47ms 만에 끝났다).
    c.stdin.on("error", () => {});
    c.stdin.end(input || "");
  });
}
function parseMcpList(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const i = line.indexOf(": ");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim(), rest = line.slice(i + 2);
    if (!name || name.length > 120 || /\s{2,}/.test(name)) continue;
    const status = /✔|✓|\bConnected\b/.test(rest) ? "connected" : /Needs authentication|needs-auth/i.test(rest) ? "needs-auth" : /✘|✗|Failed/i.test(rest) ? "failed" : "unknown";
    out.push({ name, status });
  }
  return out;
}
const key = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");
function summarize() {
  let lines = [];
  try { lines = fs.readFileSync(P("out.jsonl"), "utf8").split("\n"); } catch (_) {}
  let init = null, res = null;
  const uses = [], results = {};
  for (const l of lines) {
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch (_) { continue; }
    if (j.type === "system" && j.subtype === "init") init = j;
    else if (j.type === "result") res = j;
    else if (j.type === "assistant") { for (const c of (j.message && j.message.content) || []) if (c.type === "tool_use") uses.push({ id: c.id, name: c.name }); }
    else if (j.type === "user") { for (const c of (j.message && j.message.content) || []) if (c.type === "tool_result") results[c.tool_use_id] = { error: !!c.is_error, chars: JSON.stringify(c.content === undefined ? null : c.content).length }; }
  }
  const u = res && res.usage;
  return {
    init: init ? { version: init.claude_code_version || null, model: init.model || null, permissionMode: init.permissionMode || null, tools: Array.isArray(init.tools) ? init.tools.length : null,
      mcp: (init.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })) } : null,
    calls: uses.map((x) => Object.assign({ tool: x.name }, results[x.id] || {})),
    result: res ? { subtype: res.subtype || null, error: !!res.is_error, turns: res.num_turns ?? null, durationMs: res.duration_ms ?? null, costUsd: res.total_cost_usd ?? null,
      usage: u ? { in: u.input_tokens ?? null, cacheWrite: u.cache_creation_input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null, out: u.output_tokens ?? null } : null,
      text: String(res.result || "").slice(0, 1500) } : null,
  };
}
function finish(o) {
  if (finished) return; finished = true;
  clearInterval(sampler);
  const mb = (b) => (b ? Math.round(b / 1048576) : null);
  const memOut = { cgroupPeakMb: mb(mem.cgPeak), cgroupPeakFileMb: mb(num(rd("/sys/fs/cgroup/memory.peak"))), cgroupMax: rd("/sys/fs/cgroup/memory.max") ?? rd("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    treePeakMb: mem.treePeakKb ? Math.round(mem.treePeakKb / 1024) : null, treePeakProcs: mem.treePeakProcs || null, samples: mem.samples,
    container: mi0 ? { totalMb: Math.round(mi0.totalKb / 1024), startMb: Math.round(mi0.usedKb / 1024), peakMb: Math.round(mem.miPeakKb / 1024) } : null };
  let sum = {};
  try { sum = summarize(); } catch (e) { sum = { summarizeError: String(e && e.message || e) }; }
  const caps = (rd(P("caps.jsonl")) || "").split("\n").filter(Boolean).length;
  try { W("summary.json", Object.assign({ runId: job && job.runId, apps: job ? job.apps : [], claude: { version: info.version, flags: info.flags }, servers: info.servers, connectors: info.connectors, allowed: info.allowed, missing: info.missing, denied: info.denied.length, attempts: info.attempts, loadMisses: info.loadMisses, captures: caps, mem: memOut, stderrTail: (rd(P("err.log")) || "").slice(-1500) }, sum)); } catch (_) {}
  const ex = Object.assign({ startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - t0, timedOut }, o);
  try { W("exit.json.tmp", ex); fs.renameSync(P("exit.json.tmp"), P("exit.json")); } catch (_) {}
  try { fs.unlinkSync(P("runner.pid")); } catch (_) {}
  cleanProject();
  process.exit(0);
}
//  이 실행의 Claude 프로젝트 폴더(~/.claude/projects/<작업 폴더 슬러그>)를 치운다 — 실행마다 작업 폴더가 달라 한 판에 하나씩 쌓인다.
//   큰 결과 파일(tool-results)도 거기 있다(원문은 이미 cap/ 에 옮겼다). 그 자리 모양일 때만 지운다.
function cleanProject() {
  try {
    const d = rd(P("claude-project.txt"));
    if (!d || !job) return;
    const root = path.join((job && job.home) || process.env.HOME || "", ".claude", "projects");
    if (path.dirname(d) !== root || !path.basename(d).endsWith(job.runId + "-work")) return;
    fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}
process.on("SIGTERM", () => { try { if (child) child.kill("SIGTERM"); } catch (_) {} finish({ code: null, error: "canceled" }); });
process.on("uncaughtException", (e) => finish({ code: null, error: "runner: " + String(e && e.message || e).slice(0, 300) }));
(async () => {
  try { job = JSON.parse(fs.readFileSync(P("job.json"), "utf8")); } catch (e) { finish({ code: null, error: "job.json: " + e.message }); return; }
  W("runner.pid", String(process.pid));
  fs.mkdirSync(P("work"), { recursive: true, mode: 0o700 });
  const deadline = setTimeout(() => { timedOut = true; try { if (child) child.kill("SIGTERM"); } catch (_) {} setTimeout(() => { try { if (child) child.kill("SIGKILL"); } catch (_) {} }, 5000); }, job.timeoutSec * 1000);
  const v = await run(["--version"], 30000);
  if (v.code !== 0) { clearTimeout(deadline); finish({ code: v.code, error: "claude --version 실패: " + (v.err || v.out).slice(0, 300) }); return; }
  info.version = v.out.trim().split(/\s+/)[0] || null;
  const help = (await run(["--help"], 30000)).out;
  const has = (s) => help.includes(s);
  info.flags = { tools: has("--tools <"), dontAsk: has("dontAsk"), noPersist: has("--no-session-persistence"), noSkills: has("--disable-slash-commands"), sources: has("--setting-sources") };
  //  서버 목록도 사용자 설정을 빼고 센다 — 사용자 MCP(로컬 프로세스)를 건강 검사하느라 띄우지 않는다(맥 실측: CPU 1.68s → 0.37s).
  //   그 서버들은 아래 claude -p 에서도 안 뜨므로 deny 할 것도 없다. 옛 claude 는 종전대로 다 센다.
  const list = await run(info.flags.sources ? ["--setting-sources", "project,local", "mcp", "list"] : ["mcp", "list"], 90000);
  info.servers = parseMcpList(list.out);
  info.connectors = info.servers.filter((s) => s.name.startsWith("claude.ai ")).map((s) => ({ app: s.name.slice(10), status: s.status, key: key(s.name) }));
  const want = (job.apps || []).map((a) => String(a).toLowerCase());
  const allowed = info.connectors.filter((c) => c.status === "connected" && (!want.length || want.includes(c.app.toLowerCase())));
  info.allowed = allowed.map((c) => c.app);
  info.missing = (job.apps || []).filter((a) => !allowed.some((c) => c.app.toLowerCase() === String(a).toLowerCase()));
  info.denied = info.servers.filter((s) => !allowed.some((c) => c.key === key(s.name))).map((s) => "mcp__" + key(s.name));
  if (!allowed.length) { clearTimeout(deadline); finish({ code: null, error: "no-connector" }); return; }
  W("gate.json", { servers: allowed.map((c) => c.key) });
  const node = process.execPath, q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  W("settings.json", { hooks: {
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: q(node) + " " + q(P("gate.cjs")) + " " + q(dir), timeout: 30 }] }],
    PostToolUse: [{ matcher: "mcp__claude_ai_.*", hooks: [{ type: "command", command: q(node) + " " + q(P("cap.cjs")) + " " + q(dir), timeout: 120 }] }],
  } });
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", String(job.maxTurns), "--model", job.model, "--settings", P("settings.json"),
    "--allowedTools", ...allowed.map((c) => "mcp__" + c.key),
    "--disallowedTools", ...info.denied, "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"];
  if (info.flags.tools) args.push("--tools", "");
  if (info.flags.dontAsk) args.push("--permission-mode", "dontAsk");
  if (info.flags.noSkills) args.push("--disable-slash-commands");
  if (info.flags.noPersist) args.push("--no-session-persistence");
  //  사용자 설정을 뺀다 — 사용자 훅·사용자 MCP(라이블리 MCP 등 로컬 프로세스)가 안 뜬다. claude.ai 커넥터는 그대로 뜬다
  //   (매니지드 실측 2026-10-16: 컨테이너 사용 +450MB → +389MB). 문지기·원문 받기 훅은 --settings 라 그대로 걸린다.
  if (info.flags.sources) args.push("--setting-sources", "project,local");
  //  기다릴 커넥터 — 앱을 정해 준 실행은 그 앱 전부, 아니면 하나라도.
  const need = (job.apps || []).length ? allowed.map((c) => "claude.ai " + c.app) : [];
  const attempt = () => {
    info.attempts++;
    //  지난 시도의 출력은 버린다 — 요약(summarize)은 마지막 시도만 본다. 훅이 남긴 원문(cap/)은 지울 일이 없다(커넥터가 없으면 부를 도구도 없다).
    try { fs.writeFileSync(P("out.jsonl"), "", { mode: 0o600 }); } catch (_) {}
    const out = fs.openSync(P("out.jsonl"), "a", 0o600), err = fs.openSync(P("err.log"), "a", 0o600);
    let c;
    try { c = cp.spawn(job.bin || "claude", args, { cwd: P("work"), env: env(), stdio: ["pipe", out, err] }); }
    catch (e) { clearTimeout(deadline); finish({ code: null, error: "spawn: " + String(e && e.message || e) }); return; }
    child = c;
    let checked = false, notLoaded = false;
    //  시작 알림(init)의 mcp_servers 에 기다리는 커넥터가 다 있나 — 없으면 이 판은 도구가 없는 판이다. 바로 끊고 다시 띄운다.
    const miss = (loaded, why) => {
      checked = true; notLoaded = true;
      info.loadMisses.push({ attempt: info.attempts, why, loaded: loaded.slice(0, 20) });
      try { c.kill("SIGTERM"); } catch (_) {}
    };
    const check = () => {
      if (checked || finished) return;
      const line = (rd(P("out.jsonl")) || "").split("\n").find((l) => l.indexOf('"subtype":"init"') >= 0);
      if (!line) return;
      let init = null;
      try { init = JSON.parse(line); } catch (_) { return; }
      const loaded = ((init && init.mcp_servers) || []).filter((x) => x && x.status === "connected").map((x) => String(x.name));
      const ok = need.length ? need.every((w) => loaded.indexOf(w) >= 0) : loaded.some((n) => n.indexOf("claude.ai ") === 0);
      if (ok) { checked = true; clearInterval(iv); return; }
      clearInterval(iv); miss(loaded, "init");
    };
    const iv = setInterval(check, 250);
    const initWait = setTimeout(() => { if (!checked) { clearInterval(iv); miss([], "no-init"); } }, INIT_WAIT_MS);
    c.on("error", (e) => { clearInterval(iv); clearTimeout(initWait); clearTimeout(deadline); finish({ code: null, error: "spawn: " + String(e && e.message || e) }); });
    c.on("close", (code, signal) => {
      clearInterval(iv); clearTimeout(initWait); child = null;
      if (finished) return;
      if (notLoaded && !timedOut && info.attempts < LOAD_TRIES) { setTimeout(attempt, RETRY_GAP_MS); return; }
      clearTimeout(deadline);
      finish({ code, signal: signal || null, error: timedOut ? "timeout" : notLoaded ? "connector-not-loaded" : (code === 0 ? null : "claude exit " + code) });
    });
    c.stdin.on("error", () => {});
    c.stdin.end(job.prompt);
  };
  attempt();
})();
`;

/** 셸 리터럴 — 우리가 만든 값만 넣지만 그래도 감싼다(ai-login-run.ts 의 q 와 같다). */
const q = (s: string): string => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * 쓰기 셸이 싣는 파일 덩이(base64)의 상한. 셸 스크립트 전체가 `sh -c` 의 인자 **하나**로, 덩이가 `node -e` 의 인자 하나로 간다 —
 *  리눅스는 인자 하나를 128KB(MAX_ARG_STRLEN)까지만 받아 넘으면 E2BIG 로 아무 말 없이 실패한다(맥은 이 상한이 없다 —
 *  2026-10-16 CI 실측). 지금 실리는 것은 러너·훅 약 22KB + 지시(사람 지시 8,000자 · 서버 지시 수 KB)라 덩이가 60KB 밑이다.
 */
export const COLLECT_WRITE_MAX_B64 = 120 * 1024;

/**
 * (순수) 실행 폴더를 만들고 파일 넷을 쓰는 셸. 멤버 경계(그 사람 uid · 그 사람 홈)에서 돈다.
 *  · 파일 내용은 base64 JSON 한 덩이로 넘겨 node 가 쓴다 — 셸이 내용을 해석할 자리를 없앤다(따옴표·$·줄바꿈).
 *  · ⚠ `node -e <script> a b` 는 a 가 argv[1] 이다(ai-login-run.ts 머리말에서 실측으로 밟은 자리).
 *  · 사흘 지난 실행 폴더는 치운다 — 원문이 담긴 폴더라 남겨 둘 이유가 없다(저장 단계가 다 읽은 뒤다).
 */
export function collectWriteSh(dir: string, files: Record<string, string>): string {
  if (!isCollectRunDir(dir)) throw new Error(`수집 실행 폴더 형식 오류: ${dir}`);
  for (const n of Object.keys(files)) if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(n)) throw new Error(`파일 이름 형식 오류: ${n}`);
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  const b64 = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
  if (b64.length > COLLECT_WRITE_MAX_B64) throw new Error(`수집 실행 파일이 너무 큽니다(${Math.ceil(b64.length / 1024)}KB > ${COLLECT_WRITE_MAX_B64 / 1024}KB) — 지시를 줄여 주세요`);
  const writer = `const fs=require("fs"),path=require("path");const d=process.argv[1];const f=JSON.parse(Buffer.from(process.argv[2],"base64").toString("utf8"));for(const n of Object.keys(f))fs.writeFileSync(path.join(d,n),f[n],{mode:0o600});`;
  return [
    `command -v node >/dev/null 2>&1 || { echo "node 없음" >&2; exit 127; }`,
    `umask 077`,
    `mkdir -p ${q(dir)}`,
    `find ${q(parent)} -mindepth 1 -maxdepth 1 -type d -name 'cr-*' -mtime +3 -exec rm -rf {} + 2>/dev/null || true`,
    `node -e ${q(writer)} ${q(dir)} ${q(b64)}`,
    `echo written`,
  ].join("\n");
}

/** (순수) 세션 id 를 실행 폴더에 적는 셸 — 게이트웨이가 재기동해도 뒷정리가 그 세션을 찾게. */
export function collectSessionNoteSh(dir: string, sessionId: string): string {
  if (!isCollectRunDir(dir)) throw new Error(`수집 실행 폴더 형식 오류: ${dir}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) throw new Error(`세션 id 형식 오류: ${sessionId}`);
  return `printf '%s' ${q(sessionId)} > ${q(`${dir}/session.txt`)} && echo ok`;
}

/** 읽기 셸의 구획 표 — 출력 한 덩이를 구획으로 나눠 해석한다. */
const MARKS = ["@@missing", "@@exit", "@@summary", "@@caps", "@@session", "@@end"] as const;

/** (순수) 실행 폴더의 상태를 한 번에 읽는 셸. 원문(cap/*)은 읽지 않는다 — 목록·요약만. */
export function collectReadSh(dir: string): string {
  if (!isCollectRunDir(dir)) throw new Error(`수집 실행 폴더 형식 오류: ${dir}`);
  const d = q(dir);
  return [
    `if [ ! -d ${d} ]; then echo '@@missing'; echo '@@end'; exit 0; fi`,
    `if [ -f ${d}/exit.json ]; then echo '@@exit'; cat ${d}/exit.json; echo; echo '@@summary'; cat ${d}/summary.json 2>/dev/null; echo; fi`,
    `echo '@@caps'; tail -n 300 ${d}/caps.jsonl 2>/dev/null; echo`,
    `echo '@@session'; cat ${d}/session.txt 2>/dev/null; echo`,
    `echo '@@end'`,
  ].join("\n");
}

/** 원문 하나의 목록 줄(caps.jsonl). */
export interface CollectCapture { ts: string; tool: string | null; id: string | null; chars: number | null; sha256: string | null; file: string | null; error?: string }

/** 읽은 상태. */
export interface CollectRunRead {
  state: "missing" | "running" | "done";
  exit: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  captures: CollectCapture[];
  sessionId: string | null;
}

/** (순수) 읽기 셸 출력 → 상태. 모르는 줄은 버린다(셸이 덧붙인 경고 등). */
export function parseCollectRead(out: string): CollectRunRead {
  const sec = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of String(out ?? "").split("\n")) {
    const t = line.trim();
    if ((MARKS as readonly string[]).includes(t)) { cur = t; if (!sec.has(t)) sec.set(t, []); continue; }
    if (cur) sec.get(cur)!.push(line);
  }
  const json = (k: string): Record<string, unknown> | null => {
    const s = (sec.get(k) ?? []).join("\n").trim();
    if (!s) return null;
    try { const v = JSON.parse(s); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; }
  };
  const captures: CollectCapture[] = [];
  for (const l of sec.get("@@caps") ?? []) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      captures.push({
        ts: String(j.ts ?? ""), tool: j.tool == null ? null : String(j.tool), id: j.id == null ? null : String(j.id),
        chars: typeof j.chars === "number" ? j.chars : null, sha256: j.sha256 == null ? null : String(j.sha256),
        file: j.file == null ? null : String(j.file), ...(j.error ? { error: String(j.error) } : {}),
      });
    } catch { /* 반쯤 쓰인 줄 — 다음 읽기에 온전해진다 */ }
  }
  const sid = (sec.get("@@session") ?? []).join("").trim();
  const exit = json("@@exit");
  return {
    state: sec.has("@@missing") ? "missing" : exit ? "done" : "running",
    exit,
    summary: json("@@summary"),
    captures,
    sessionId: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sid) ? sid : null,
  };
}

/** 원문 읽기 한 번의 상한(바이트) — 한 판의 원문이 이보다 크면 앞에서부터 이만큼만 저장 단계로 넘긴다(truncated). */
export const COLLECT_CAPS_MAX_BYTES = 48 * 1024 * 1024;

/**
 * (순수) 원문(cap/*.json)을 한 덩이로 읽는 셸 — 저장 단계(run-ingest)가 쓴다. 멤버 경계(그 사람 uid)에서 돈다.
 *  이름순(= 받은 순서 — 이름이 Date.now() 로 시작한다)으로 읽고, 상한을 넘으면 거기서 멈춘다. 이름 모양이 다른 파일은 읽지 않는다.
 */
export function collectCapsReadSh(dir: string, maxBytes = COLLECT_CAPS_MAX_BYTES): string {
  if (!isCollectRunDir(dir)) throw new Error(`수집 실행 폴더 형식 오류: ${dir}`);
  const max = Math.max(1024, Math.floor(Number(maxBytes) || COLLECT_CAPS_MAX_BYTES));
  const js = `const fs=require("fs"),path=require("path");const d=path.join(process.argv[1],"cap");const max=Number(process.argv[2]);`
    + `let names=[];try{names=fs.readdirSync(d).filter((n)=>/^\\d+-[0-9a-f]{6}\\.json$/.test(n)).sort();}catch(e){}`
    + `const files=[];let n=0,trunc=false;for(const f of names){let s;try{s=fs.readFileSync(path.join(d,f),"utf8");}catch(e){continue;}`
    + `if(n+s.length>max){trunc=true;break;}n+=s.length;try{files.push(JSON.parse(s));}catch(e){}}`
    + `process.stdout.write("@@capsjson\\n"+JSON.stringify({files,truncated:trunc,total:names.length})+"\\n@@end\\n");`;
  return [
    `command -v node >/dev/null 2>&1 || { echo "node 없음" >&2; exit 127; }`,
    `node -e ${q(js)} ${q(dir)} ${q(String(max))}`,
  ].join("\n");
}

/** (순수) 원문 읽기 셸 출력 → 캡처 파일들. 모양이 틀리면 null(저장 단계가 «못 읽음» 으로 적는다). */
export function parseCollectCaps(out: string): { files: Array<Record<string, unknown>>; truncated: boolean; total: number } | null {
  const s = String(out ?? "");
  const a = s.indexOf("@@capsjson\n"), b = s.lastIndexOf("\n@@end");
  if (a < 0 || b < a) return null;
  try {
    const j = JSON.parse(s.slice(a + "@@capsjson\n".length, b)) as { files?: unknown; truncated?: unknown; total?: unknown };
    const files = Array.isArray(j.files) ? j.files.filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && !Array.isArray(f)) : [];
    return { files, truncated: j.truncated === true, total: typeof j.total === "number" ? j.total : files.length };
  } catch { return null; }
}

/** (순수) 실행 id 에 박힌 시작 시각(ms). 모양이 틀리면 null. */
export function collectRunStartedAt(runId: string): number | null {
  const m = /^cr-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(runId);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? t : null;
}
