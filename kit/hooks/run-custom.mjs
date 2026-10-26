#!/usr/bin/env node
// 불변 런너 — 커스텀 훅(org_hook)을 게이트웨이에서 매 세션 받아 실행한다.
//  설계(보안 종합 결론): 훅 본문(source_code)은 멤버 디스크에 영구 저장하지 않는다 — 매 호출 게이트웨이에서
//  fetch 해 임시파일로 실행 후 삭제. 따라서 admin 이 본문을 못 바꾸고(디스크에 없음), enabled=false/제거는
//  다음 세션부터 즉시 무효(=실효 kill-switch). 이 런너 1개만 settings 에 박히고 커스텀 훅별 엔트리는 없다.
//
//  게이트웨이 미도달 시: 최근 성공 캐시로 실행한다. 캐시 유효기간은 hooks-config.json 의 hook_grace_ms(관리탭 노브,
//   runtime-config 발) — 기본 **무제한**(마지막 접속 기준 영구 실행, #1008). 값이 설정되면 그 ms 경과 후 fail-CLOSED(회수창).
//   content_hash 무결성은 캐시에도 적용되고 재접속 시 캐시가 교체되므로, 무제한이어도 변조·미회수 위험은 없다. 세션은 어떤 경우에도 안 막는다(exit 0).
//  비활성화(incognito): LIVELY_OFF=1 — 최상단에서 즉시 종료(커스텀 훅 일절 미실행).
//  사용: node run-custom.mjs <Event> [--harness codex]   (Event = SessionStart|PostToolUse|… 설치 시 박힘)
//
//  이 러너는 하네스에 **훅 1개로 보이는 멀티플렉서**다(N개 org_hook → stdout 1개). 그래서 컨텍스트 이벤트는
//   출력을 이어붙이면 되지만, **PreToolUse 는 '결정'이라 이어붙일 수 없어** 러너가 직접 병합한다(#892 — 하네스가
//   훅들 사이에서 하는 일을 러너가 대신). 상세는 runbooks/hooks.md §1.5, 테스트는 run-custom.test.mjs.
//
//  비용(#5034) — 이 러너는 프롬프트마다·툴 호출마다 돈다. 그래서 세 가지를 아낀다.
//   ① 제품 시드 훅은 기본으로 이 러너 안의 **워커 스레드**에서 돈다(훅마다 node 프로세스를 새로 띄우지 않는다 — 맥미니
//      실측 훅 하나 CPU 50~64ms → 14~20ms. gVisor 세션 노드에선 프로세스 기동이 그보다 훨씬 비싸다). 훅 본문은 그대로다 —
//      stdin·stdout·stderr·process.exit·exitCode 가 프로세스 때와 같게 동작한다. 스레드로는 같게 못 도는 훅은 소스를
//      보고 종전처럼 프로세스로 돈다(runtimeOf). 직접 만든 훅은 기본으로 종전처럼 프로세스다 — 스레드는 네이티브 호출에
//      묶이면 끊을 수 없어서(execWorker), 우리가 시험하는 코드만 기본으로 넣는다. 본문에 `lively-hook-runtime: worker` 를
//      넣으면 스레드로 간다. 되돌리기: 조직 runtime_config.hooks.runtime="process" · 이 머신만 LIVELY_HOOK_RUNTIME=process ·
//      훅 하나만 본문에 `lively-hook-runtime: process`.
//   ② 훅 목록을 LIST_TTL_MS 동안 다시 묻지 않는다(세션별 캐시). 관리자의 끄기·고치기는 그 시간 안에 반영된다.
//   ③ 맥락 이벤트(UserPromptSubmit·SessionStart)는 하네스가 러너를 끊는 상한보다 앞서 끝낸다 — 상한에 걸리면 하네스가
//      러너를 통째로 취소해 그때까지 모은 맥락도 전부 버리므로(실측 hook_cancelled timeoutMs 30000), 남은 훅을 건너뛰고
//      모은 것을 싣는다. 상한은 하네스마다 다르다(harness-registry 의 runnerCapMs).
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import crypto from "node:crypto";
// 주입 봉투는 하네스별 규약이다 — 표에서 파생한다. ⚠ HARNESS 상수는 종전 계산식 유지(빈 문자열 가능):
//  이 값이 게이트웨이 질의(`?harness=`)에 그대로 실리므로 여기서 기본값을 채우면 서버가 받는 값이 바뀐다.
import { harness, isForeignGrokInvocation, isForeignCursorInvocation, sessionTokenFromFile } from "./harness-registry.mjs";
import { hostEffects } from "./host-effects-port.mjs";
import { inScopeNow, startedOutside, clearStartedOutside } from "./record-scope.mjs";

const execFileSync = (...args) => hostEffects.execFileSync(...args);
const spawn = (...args) => hostEffects.spawn(...args);
const fetch = (...args) => hostEffects.fetch(...args);

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다 — dev '다온' 실측이 정확히 그 사고다.
const executionSessionId = (input = {}) => {
  const direct = String(process.env.LIVELY_SESSION_ID || "").trim();
  if (direct) return direct;
  const native = String(input.session_id || input.sessionId || "").trim();
  if (native && HARNESS === "codex") return `codex-${native}`;
  // #4927 — cursor-adapter 가 session_id(없으면 conversation_id)를 싣는다. 서버 agent-identity 가 `cursor-` 를 받는다.
  if (native && HARNESS === "cursor") return `cursor-${native}`;
  if (native && (HARNESS || "claude") === "claude") return `claude-${native}`;   // 미지정=claude(resolveHarness 규약)
  const codex = String(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || "").trim();
  if (codex) return `codex-${codex}`;
  const claude = String(process.env.CLAUDE_SESSION_ID || "").trim();
  return claude ? `claude-${claude}` : "";
};
const scopeHeaders = (input = {}) => ({
  ...(executionSessionId(input) ? { "x-lively-session": executionSessionId(input) } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
});


// grok compat 이중발화 가드(#1701) — grok 이 ~/.claude/settings.json 의 러너 엔트리를 그대로 실행한 사본이면
//  비켜선다(정본은 grok-adapter 경유 — 사본이 돌면 org 훅이 이벤트당 두 번 울린다).
// #4927 — Cursor 도 같은 compat 로 이 훅을 돌린다(CLI 는 끌 수 없다). 정본은 cursor-adapter 가 LIVELY_HARNESS=cursor 로 띄우는 경로.
if (isForeignGrokInvocation() || isForeignCursorInvocation()) process.exit(0);

if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);

const EVENT = process.argv[2] || "";
const hIdx = process.argv.indexOf("--harness");
const HARNESS = ((hIdx > -1 ? process.argv[hIdx + 1] : "") || process.env.LIVELY_HARNESS || "").toLowerCase();

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
// 캐시 유효기간(grace)은 상수가 아니라 hooks-config.json 의 hook_grace_ms 에서 매번 읽는다(graceMs()) — 기본 무제한(#1008).
const FETCH_MS = 3000;
// SessionEnd 는 하네스가 이 훅을 AbortSignal.timeout(i) 로 끊는다 — Claude Code 2.1.215 실측:
//  i = getSessionEndHookTimeoutMs() = max(1500, min(settings엔트리.timeout*1000, 60000)). 러너 엔트리에 timeout 이
//  없으면 1500ms 바닥값. 오프라인(원격 게이트웨이 unreachable)이면 fetchHooks 가 FETCH_MS(3000ms) 블랙홀에 매달려
//  1500ms 를 넘기고, 하네스가 종료하며 러너를 통째로 abort → "SessionEnd hook […] failed: Hook cancelled"(#1039/#1043).
//  (로컬 미기동=ECONNREFUSED 는 ~20ms 즉시실패라 안 터지고 원격 unreachable 만 3초 매달려 터진다 — 실측.)
//  #1043 은 settings 엔트리에 timeout:10 을 줘 바닥을 10s 로 올려 abort 를 막고, 여기서는 SessionEnd 의 블로킹 예산
//  자체를 바닥 밑으로 줄인다 — 오프라인 세션종료가 3초 매달리지 않고 ~0.8s 에 캐시 폴백 후 exit 0(빠른 종료). 둘은
//  상보적이다(floor 상향 + 러너 자체 단축). SessionEnd stdout 은 미소비(부수효과 전용)라 예산 축소로 잃는 기능 없음.
const SESSIONEND = EVENT === "SessionEnd";
const FETCH_MS_SESSIONEND = 800;   // 오프라인 fetch 상한(뒤엔 캐시 폴백). 온라인 정상 fetch(로컬~ms·원격 보통<0.5s)는 이 안.
const STDIN_MS_SESSIONEND = 200;   // stdin 은 하네스가 즉시 닫아 몇 ms 로 끝나지만 hang-guard 도 바닥 밑으로.
const REPORT_MS = 1500;   // 훅 실패 보고(fire-and-forget) 상한 — 세션을 절대 기다리게 하지 않는다.
const REPORT_THROTTLE_MS = 10 * 60 * 1000; // 같은 훅 실패 재보고 최소 간격(툴콜마다 왕복하지 않기 위해).
const STDERR_KEEP = 800;  // 보고에 싣는 stderr 꼬리 길이(진단엔 충분, 페이로드는 작게).
const CHECK_MS = 5000;    // `node --check` 상한 — 실패한 훅에서만 도는 느린 경로(정상 경로 비용 0).
// PreToolUse 결정 중 러너가 하네스로 전파할 값 — 게이트웨이 미제공/구버전이면 이 기본값.
//  'allow' 는 기본 제외: 관리자 훅이 멤버의 권한 프롬프트(동의 UI)를 소리 없이 건너뛰게 하지 않는다.
//  관리탭에서 org 단위로 넓힐 수 있다(runtime_config.hook_relay_decisions).
const DEFAULT_RELAY = ["deny", "ask", "defer"];
const cacheFile = () => join(LIVELY, `custom-hooks-${EVENT.replace(/[^A-Za-z]/g, "")}.json`);
// 음이 아닌 ms 값을 env 에서 읽는다 — 비었거나 잡값이면 기본값(빈 문자열이 Number() 로 0 이 되어 «끔»으로 바뀌지 않게).
const envMs = (name, dflt) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
// ② 훅 목록 재사용 시간(#5034). 러너는 툴 호출마다 돌아서 매번 묻으면 이벤트마다 왕복 1회(맥미니 실측 약 0.26초,
//  CPU 116ms)가 붙는다. 0 이면 종전처럼 매번 묻는다.
const LIST_TTL_MS = envMs("LIVELY_HOOK_LIST_TTL_MS", 60_000);
const LIST_CACHE_DIR = join(LIVELY, "hook-list-cache");
const LIST_CACHE_KEEP_MS = 60 * 60 * 1000;   // 이보다 오래된 세션별 캐시 파일은 저장할 때 걷는다(끝난 세션의 흔적)
// ③ 이벤트 시간 예산(#5034) = 하네스가 러너를 끊는 상한 − 여유(5초, 상한이 짧으면 그 1/3). 상한보다 앞서 끝내야 의미가
//  있고, 상한보다 짧게 잡으면 원래 상한까지 돌던 훅을 일찍 자른다(SessionStart 의 project-pull 은 timeout_sec 120).
//  상한을 모르는 하네스·이벤트는 예산이 없다. 결정 이벤트(PreToolUse)엔 두지 않는다 — 막는 훅을 예산 때문에 건너뛰지 않는다.
//  LIVELY_HOOK_EVENT_BUDGET_MS 로 이 머신만 바꾼다(0 = 끔).
const BUDGETED = EVENT === "UserPromptSubmit" || EVENT === "SessionStart";
const capOf = (h, ev) => { const c = h && h.runnerCapMs; return typeof c === "number" ? c : (c && typeof c[ev] === "number" ? c[ev] : 0); };
const CAP_MS = BUDGETED ? capOf(harness(HARNESS), EVENT) : 0;
const EVENT_BUDGET_MS = BUDGETED ? envMs("LIVELY_HOOK_EVENT_BUDGET_MS", CAP_MS > 0 ? CAP_MS - Math.min(5000, Math.floor(CAP_MS / 3)) : 0) : 0;
const MIN_WAVE_MS = 300;   // 남은 예산이 이보다 적으면 다음 묶음을 시작하지 않는다
const MIN_SPAWN_MS = 100;  // 훅 하나를 띄우는 그 순간 남은 예산이 이보다 적으면 띄우지 않는다(묶음 안에서 줄 선 훅·재시도)

const readLocal = (rel) => { try { return readFileSync(join(LIVELY, rel), "utf8").trim() || null; } catch { return null; } };
// 자격·주소 — 사람이 연 셸이면 파일이, 라이블리가 띄운 pane(LIVELY_SESSION_ID)이면 env 가 이긴다(#959).
//  근거 전문은 hooks/session-preload.mjs 의 «훅의 자격·주소 우선순위» 주석.
const SPAWNED = !!(process.env.LIVELY_SESSION_ID || "").trim();
const pickCred = (envName, fileVal) => {
  const env = (process.env[envName] || "").trim();
  return (SPAWNED ? (env || fileVal) : (fileVal || env)) || "";
};
//  #4135 — 세션 토큰 파일이 있으면 그것이 먼저다(게이트웨이가 이 세션 앞으로 나중에 실어 준 정본 — harness-registry sessionTokenFile 머리말).
const TOKEN = sessionTokenFromFile("hook", HOME, (p) => readFileSync(p, "utf8")) || pickCred("LIVELY_TOKEN", readLocal("token"));
const GW_PICKED = pickCred("LIVELY_GATEWAY_URL", readLocal("gateway-url")).replace(/\/$/, "");
const GW = GW_PICKED || "http://localhost:8080";

function emitContext(text) {
  if (!text) return;
  // PostToolUse 는 Claude Code 가 raw stdout 을 컨텍스트로 안 넣는다 → hookSpecificOutput.additionalContext JSON 필수
  //  (담당자 wiki-action-router 로 검증된 계약, #637 Stage2). SessionStart·UserPromptSubmit 는 claude 가 raw stdout 을
  //  컨텍스트로 받으므로 raw 유지(codex 만 전 이벤트 JSON 래핑). → 기존 두 이벤트 동작 무변경.
  if (harness(HARNESS).contextEnvelope === "json" || EVENT === "PostToolUse") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } }) + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
}

// 훅 입력(JSON) — 짧은 타임박스로 읽는다(harness 가 stdin 을 안 닫아도 hang 방지).
function readStdin(ms = 800) {
  return new Promise((resolve) => {
    let data = ""; let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { data += c; if (data.length > 256 * 1024) finish(); });
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      setTimeout(finish, ms);
    } catch { finish(); }
  });
}

// → { hooks, relay, concurrent, runtime } | null(게이트웨이 미도달). relay 는 org 정책(관리탭) — 구버전 게이트웨이면 기본값.
//  concurrent 는 «직접 만든 훅도 같은 sort 끼리 동시에 돌려도 된다» 는 조직 설정(runtime_config.hooks.concurrent, 기본 꺼짐).
//   제품 시드 훅끼리는 이 설정과 무관하게 겹친다(wavesOf). 필드가 없으면(구 게이트웨이) 종전처럼 하나씩.
//  runtime 은 조직의 실행 방식(runtime_config.hooks.runtime) — "process" 면 전부 종전처럼 프로세스로. 없으면 null(=스레드).
//  hooks[].seed 는 «제품이 배포하는 시드 훅인가» — 없으면(구 게이트웨이·구 캐시) 전부 직접 만든 훅으로 본다.
async function fetchHooks(input) {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SESSIONEND ? FETCH_MS_SESSIONEND : FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/hooks?harness=${encodeURIComponent(HARNESS || "")}&event=${encodeURIComponent(EVENT)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}`, ...scopeHeaders(input) } });
    if (!res.ok) return null;
    const j = await res.json();
    const runtime = RUNTIMES.has(j?.runtime) ? j.runtime : null;
    if (!Array.isArray(j?.hooks)) return { hooks: [], relay: DEFAULT_RELAY, concurrent: false, runtime };
    return { hooks: j.hooks, relay: Array.isArray(j?.relay_decisions) ? j.relay_decisions : DEFAULT_RELAY, concurrent: j?.concurrent === true, runtime };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// 같은 훅의 실패를 매 툴콜마다 보고하지 않도록 로컬 스로틀. 러너는 PreToolUse matcher '.*' 로 배선돼
//  **모든 툴 호출마다** 돈다 — 훅 하나가 계속 깨져 있으면 스로틀 없이는 툴콜마다 왕복 1회 + 최대 REPORT_MS
//  지연이 붙는다(고장난 훅이 세션을 느리게 만드는 꼴). 훅별 마지막 보고 시각만 남긴다(파일 1개, 유계).
function throttleFailures(fails) {
  const f = join(LIVELY, "hook-report-sent.json");
  let sent = {};
  try { sent = JSON.parse(readFileSync(f, "utf8")) || {}; } catch { /* 없으면 첫 보고 */ }
  const now = Date.now();
  // 키는 훅 id **와 사유** — id 만으로 묶으면 hash_mismatch(캐시 갱신 중 잠깐) 뒤에 진짜 crash 가 나도
  //  10분간 통째로 묻힌다. 스로틀의 목적은 '같은 소음 억제'지 '새 신호 억제'가 아니다.
  const key = (x) => `${x.hook_id} ${x.reason}`;
  const fresh = fails.filter((x) => !(typeof sent[key(x)] === "number" && now - sent[key(x)] < REPORT_THROTTLE_MS));
  if (!fresh.length) return [];
  for (const x of fresh) sent[key(x)] = now;
  // 유계 유지 — 없어진 훅의 기록이 영원히 쌓이지 않게 만료분은 버린다.
  for (const k of Object.keys(sent)) if (now - sent[k] > REPORT_THROTTLE_MS) delete sent[k];
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(f, JSON.stringify(sent), { mode: 0o600 }); } catch { /* 스로틀 실패는 무시(중복 보고가 세션을 막진 않는다) */ }
  return fresh;
}

// 훅 실패를 게이트웨이에 보고(fire-and-forget) — 관리탭이 '이 훅이 어느 멤버 머신에서 죽는지' 보게 한다(#892 결함 C).
//  실패했을 때만 호출되므로 정상 경로 비용 0. 보고 실패는 무시한다(관측이 세션을 막아선 안 된다).
//  예산이 걸린 이벤트에선 남은 예산 안에서만 보낸다 — 보고 때문에 하네스 상한을 넘겨 모은 맥락까지 잃지 않게.
async function reportFailures(fails, input, deadline = Infinity) {
  if (!TOKEN || !fails.length) return;
  const ms = Math.min(REPORT_MS, deadline - Date.now());
  if (!(ms > 100)) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    await fetch(`${GW}/api/ui/org/runner/hook-report`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${TOKEN}`, ...scopeHeaders(input), "content-type": "application/json" },
      body: JSON.stringify({ event: EVENT, harness: HARNESS || null, failures: fails }),
    });
  } catch { /* 관측은 best-effort */ }
  finally { clearTimeout(t); }
}

// 세션별 목록 캐시의 열쇠 — 같은 홈이라도 게이트웨이·워크스페이스·하네스·신원·세션이 다르면 받는 목록이 다를 수 있다
//  (#699 구성원별 대상 · #1750 세션이 가리키는 워크스페이스). 토큰이 없으면 묻지도 못하니 재사용도 없다.
function listCacheKey(input) {
  if (!TOKEN || !(LIST_TTL_MS > 0)) return null;
  const parts = [GW, String(process.env.LVLY_TENANT_SLUG || "").trim(), HARNESS, TOKEN, executionSessionId(input)];
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}
const listCacheFile = (key) => join(LIST_CACHE_DIR, `${EVENT.replace(/[^A-Za-z]/g, "")}-${key}.json`);
const cfgOf = (c) => ({ hooks: c.hooks, relay: Array.isArray(c.relay) ? c.relay : DEFAULT_RELAY, concurrent: c.concurrent === true, runtime: RUNTIMES.has(c.runtime) ? c.runtime : null });

// 받은 목록을 남긴다 — 예전 자리(이벤트별 1개, 오프라인 폴백)와 세션별 자리(LIST_TTL_MS 재사용) 둘 다.
//  세션별 자리를 따로 두는 이유: 한 홈에서 세션 여럿이 같은 파일을 번갈아 덮으면 열쇠가 매번 어긋나 재사용이 0이 된다
//  (매니지드는 한 사람의 세션들이 홈 하나를 같이 쓴다). 끝난 세션의 파일은 저장할 때 LIST_CACHE_KEEP_MS 기준으로 걷는다.
function saveCache(cfg, key) {
  const body = JSON.stringify({ at: Date.now(), hooks: cfg.hooks, relay: cfg.relay, concurrent: cfg.concurrent === true, runtime: cfg.runtime ?? null });
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(cacheFile(), body, { mode: 0o600 }); } catch { /* fail-open */ }
  if (!key) return;
  try {
    mkdirSync(LIST_CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(listCacheFile(key), body, { mode: 0o600 });
    const now = Date.now();
    for (const name of readdirSync(LIST_CACHE_DIR)) {
      const p = join(LIST_CACHE_DIR, name);
      try { if (now - statSync(p).mtimeMs > LIST_CACHE_KEEP_MS) rmSync(p, { force: true }); } catch { /* 다른 세션이 먼저 걷음 */ }
    }
  } catch { /* 캐시는 최적화일 뿐 — 못 써도 다음에 다시 묻는다 */ }
}
// 이 세션이 방금(LIST_TTL_MS 안) 받은 목록 — 있으면 게이트웨이에 다시 묻지 않는다. 없거나 낡았으면 null.
function loadFreshCache(key) {
  if (!key) return null;
  try {
    const c = JSON.parse(readFileSync(listCacheFile(key), "utf8"));
    if (!c || typeof c.at !== "number" || !Array.isArray(c.hooks)) return null;
    // 조직이 오프라인 유효기간(hook_grace_ms)을 재사용 시간보다 짧게 정했으면 그쪽을 따른다 — 회수창을 넓히지 않는다.
    const ttl = Math.min(LIST_TTL_MS, graceMs() ?? Infinity);
    const age = Date.now() - c.at;
    return age >= 0 && age < ttl ? cfgOf(c) : null;
  } catch { return null; }
}
// 캐시 유효기간(ms) — hooks-config.json 의 hook_grace_ms(runtime-config 발, session-preload 가 매 세션 미러)에서 읽는다.
//  null/미설정/못읽음/잡값 = 무제한(마지막 접속 기준 영구 실행 — #1008 기본). 양수 = 그 ms 경과 후 fail-CLOSED(회수창).
//  오프라인이면 session-preload 가 파일을 못 갱신해 '마지막 접속 시 값'이 유지된다(그게 곧 last-known-good 정책).
function graceMs() {
  try {
    const c = JSON.parse(readFileSync(join(LIVELY, "hooks-config.json"), "utf8"));
    const g = c && c.hook_grace_ms;
    if (g === null || g === undefined) return null;   // 무제한
    const n = Number(g);
    return Number.isFinite(n) && n >= 0 ? n : null;   // 잡값 → 무제한(fail-open 쪽)
  } catch { return null; }                            // 못 읽으면 무제한 — 새 기본 정책과 일치
}
function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    if (!c || typeof c.at !== "number" || !Array.isArray(c.hooks)) return null;
    const grace = graceMs();
    if (grace !== null && Date.now() - c.at > grace) return null; // grace 설정 + 만료 → fail-CLOSED. null(무제한)이면 나이 무관 사용.
    return cfgOf(c);
  } catch { return null; }
}

// 매처: PreToolUse/PostToolUse 는 stdin 의 tool_name 에 정규식 매칭. 그 외 이벤트는 매처 무시(전부 실행).
function matches(hook, toolName) {
  if (!hook.matcher) return true; // 매처 없음 = 전체(의도된 동작)
  if (EVENT !== "PreToolUse" && EVENT !== "PostToolUse") return true; // 매처 무관 이벤트
  if (!toolName) return false; // 매처 있는데 tool_name 못 읽음(truncate/비JSON) → 미실행(fail-CLOSED: 스코프 누출 방지)
  try { return new RegExp(hook.matcher).test(toolName); } catch { return false; } // 깨진 매처 → 넓히지 말고 미실행
}

// 분류 전에 '코드가 아닌 것'(주석·문자열·템플릿)을 지운다. 주석 한 줄의 `require(` 때문에 멀쩡한 ESM 훅이
//  .cjs 로 오분류되면 top-level await 이 SyntaxError 로 죽는다 — 어제 되던 훅이 오늘 깨지는 회귀다.
//  ⚠ 주석만 지우면 안 된다: 문자열 안의 `"http://…"` 가 줄 주석으로 보여 뒷부분(진짜 require)을 통째로
//   먹어버린다. 그래서 한 패스에서 문자열을 먼저 소비한다.
//
//  정규식 리터럴은 안 본다(`/\/*$/` 같은 게 블록주석 시작처럼 보여 과소비할 수 있다). **왜 그래도 되나 —
//   오분류의 최악이 '1회 실패 보고'로 유계이기 때문**:
//   · .cjs 로 잘못 가면 → 파일을 ESM 으로 만드는 건 전부 *문법*(static import·top-level await·import.meta)이라
//     반드시 **파싱 단계**에서 죽는다 → 위 재시도가 .mjs 로 되살린다(파싱 실패라 부작용도 없다).
//     ESM 전용 문법이 없는 파일이면 애초에 .cjs 로도 잘 돈다.
//   · .mjs 로 잘못 가면 → 종전(항상 .mjs)과 **똑같이** 동작한다. 더 나빠질 수 없다.
//   즉 어느 방향으로 틀려도 '부작용 중복'이나 '조용한 무력화'로는 번지지 않는다.
function stripNonCode(src) {
  const s = String(src || "");
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      i++; out += q + q; continue; // 빈 리터럴로 대체 — 위치는 보존하되 내용은 분류에서 뺀다
    }
    out += c; i++;
  }
  return out;
}

// 훅 하나를 어디서 돌리나(#5034) — 스레드 기본은 **제품 시드 훅만**(hooks[].seed — 우리가 시험하는 코드다). 직접 만든 훅은
//  본문에 `lively-hook-runtime: worker` 가 있거나 이 머신이 LIVELY_HOOK_RUNTIME=worker 일 때만 스레드로 간다.
//  왜 고객 코드는 기본 프로세스인가: 스레드는 네이티브 호출(FIFO·멈춘 네트워크 파일시스템의 동기 읽기 등)에 묶이면 끊을 수 없고
//   러너가 끝날 때 그 스레드를 기다린다 — 프로세스면 상한에서 SIGKILL 로 끊고 러너는 제 갈 길을 간다(리뷰 실측: FIFO 를
//   동기로 읽는 스레드 → terminate → 러너가 끝나지 않음). 아래 표는 정적 검사라 변수로 넘긴 fd 같은 것은 못 잡는다.
//  그리고 스레드여도 프로세스 때와 다르게 동작하는 훅은 프로세스로 보낸다:
//  · 자식 프로세스(child_process 전부): 스레드에서 띄운 자식은 **러너의** fd 를 물려받는다 — stdio:"inherit" 자식이
//    하네스로 가는 러너 stdout 을 쥐고 살아 있으면 하네스가 그 자식이 끝날 때까지 기다린다(W6b·W6c 가 8초를 잡았다).
//    동기 자식 실행(execFileSync 등)은 더 나쁘다 — 스레드가 그 호출에 묶이면 terminate 가 안 먹고, 러너가 끝날 때 그
//    스레드를 기다린다(실측: execFileSync("sleep", ["10"]) 을 1초에 끊어도 러너 종료까지 10.2초). 프로세스면 상한에서 끊긴다.
//  · fd 0~2 를 숫자로 직접 쓰는 호출·경로(writeSync(1, …)·writeFileSync(1, …)·/dev/stdout·/proc/self/fd/1 등): 스레드는
//    러너와 fd 를 같이 쓴다 — 훅 출력이 러너의 수집·병합·전파 정책을 건너뛰고 하네스로 바로 나간다(결정 JSON 이 둘로
//    겹치면 하네스가 둘 다 버린다 — #892 와 같은 조용한 무력화). project-pull 의 백그라운드 안내가 이 모양이다.
//  · chdir·umask(값)·setuid 계열·abort·process.kill(process.pid): 스레드에선 막히거나 러너 전체에 걸린다.
//  · «직접 실행일 때만» 관용구(require.main === module 등): 스레드에선 훅을 import 로 불러오므로 그 조건이 거짓이 되어
//    본문이 한 줄도 안 돈다(R14).
//  주석 **줄**만 지우고 본다(codeLines) — 줄 안의 주석·문자열·정규식은 그대로 두므로 틀리면 «프로세스로» 쪽(느려질 뿐)이다.
//   stripNonCode 는 정규식 리터럴 안의 «/*»(예: /\/*$/)를 주석 시작으로 읽어 그 뒤 코드를 통째로 놓친다(리뷰 실측).
const PROCESS_ONLY = [
  /\bchild_process\b/,
  /["'](?:node:)?cluster["']/,
  /\b(?:execFileSync|execSync|spawnSync)\s*\(/,
  /\b(?:write|read|append|close|fsync|fdatasync|ftruncate)\w*\s*\(\s*[0-2]\s*[,)]/,
  /\b(?:Write|Read)Stream\s*\(\s*[0-2]\s*[,)]/,
  /\bfd\s*:\s*[0-2]\b/,
  /\/(?:dev|proc\/[^/\s'"`]+)\/(?:stdin|stdout|stderr|fd\/[0-2])\b/,
  /\bprocess\s*\.\s*std(?:in|out|err)\s*\.\s*fd\b/,
  /\bprocess\s*\.\s*(?:chdir|abort|setuid|setgid|seteuid|setegid|setgroups|initgroups)\s*\(/,
  /\bprocess\s*\.\s*umask\s*\(\s*[^)\s]/,
  /\bprocess\s*\.\s*kill\s*\(\s*process\s*\.\s*pid\b/,
  /\brequire\s*\.\s*main\b|\bprocess\s*\.\s*mainModule\b|\bimport\s*\.\s*meta\s*\.\s*main\b/,
];
const codeLines = (src) => String(src || "").split("\n").filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l)).join("\n");
const RUNTIME_PRAGMA = /lively-hook-runtime\s*:\s*(process|worker)\b/;
const RUNTIMES = new Set(["worker", "process"]);
function runtimeOf(hook, orgRuntime) {
  const machine = String(process.env.LIVELY_HOOK_RUNTIME || "").trim().toLowerCase();
  if (machine === "process") return "process";                       // 이 머신만 되돌리기
  if (orgRuntime === "process") return "process";                    // 조직이 되돌림
  const src = String(hook.source_code || "");
  const pragma = (RUNTIME_PRAGMA.exec(src) || [])[1];
  if (pragma === "process") return "process";                        // 훅이 스스로 원함
  if (PROCESS_ONLY.some((re) => re.test(codeLines(src)))) return "process";
  return hook.seed === true || pragma === "worker" || machine === "worker" ? "worker" : "process";
}

// 훅 소스의 모듈 타입 — 임시파일 확장자가 곧 Node 의 모듈 해석이다. CJS 소스(`require`)를 .mjs 로 쓰면
//  `require is not defined in ES module scope` 로 첫 줄에서 즉사한다(#892: spec-blind guard/tracker 가 이렇게
//  등록 이래 내내 죽어 있었다 — stdout 0바이트라 '아무 결정 안 함'과 구분되지 않았다).
//  ESM 마커(최상위 import/export)가 있으면 .mjs, 없고 CJS 마커만 있으면 .cjs, 판단 불가면 .mjs(종전 기본값 유지).
//  판단 불가를 .mjs 로 두는 게 중요하다 — 종전 동작과 같아서 '되던 훅'이 분류 때문에 깨지지 않는다.
//  `.js` + Node 모듈 자동감지에 기대지 않는 이유: tmpdir 상위의 package.json `type` 에 좌우돼 비결정적이다.
const ESM_MARK = /^[ \t]*(?:import[\s{*'"]|export[\s{*])/m;
const CJS_MARK = /\brequire\s*\(|\bmodule\.exports\b|\bexports\./;
function moduleExt(src) {
  const s = stripNonCode(src);
  if (ESM_MARK.test(s)) return "mjs";
  return CJS_MARK.test(s) ? "cjs" : "mjs";
}

// 이 파일이 **이 확장자로 파싱되는가** 를 Node 에게 직접 묻는다. `--check` 는 문법만 보고 **한 줄도 실행하지
//  않는다**(실측: 부작용 파일이 안 생긴다). 재시도 자격은 이걸로만 판정한다.
//
//  ⚠ **훅이 만든 텍스트로는 판정할 수 없다** — 훅은 자기 stderr 를 원하는 대로 만들 수 있기 때문이다.
//   이 판정은 두 번 뚫렸다(적대검증):
//    ① 오류 '문구'로 판정 → 훅이 `eval("await …")` 를 쓰면 모듈 타입이 맞아도 같은 SyntaxError 가 난다.
//    ② 덤프 '위치줄'로 판정 → `vm.Script(code, { filename: process.argv[1] })` 로 위치줄을 **우리 파일 경로로
//       위조**할 수 있다(그리고 그건 스택 가독성을 위한 정상적인 관행이다).
//   둘 다 '이미 실행된 훅'을 '아직 실행 안 된 훅'으로 오인하게 만들어 부작용을 두 번 일으켰다.
//   패턴을 더 깁는 대신 질문을 바꾼다 — 텍스트를 해석하지 말고 **파서에게 직접** 물어라. 훅을 실행하지
//   않으므로 훅이 런타임에 무엇을 하든 속일 수 없다(설계상 위조 불가).
//
//  ⚠ 단, `--check` 는 **디스크의 파일**을 다시 읽는다 — 방금 끝난 훅은 자기 경로(process.argv[1])에 쓸 수 있으니
//   크래시 직전에 자기 소스를 쓰레기로 덮어쓰면 이 검사가 그 쓰레기를 읽는다. 그래서 읽기 전에 **실행 전 해시와
//   같은 파일인지** 먼저 확인한다. 이 확인까지 있어야 '훅이 뭘 하든 못 속인다'가 참이다.
//   (이 우회는 훅이 자기 실행횟수를 늘릴 뿐이고 훅은 원래 임의 코드 실행 권한이라 새 권한도 아니지만,
//    주석이 약속하는 성질은 실제로 지켜져야 한다 — 이 버그 사슬 전체가 '살짝 과한 전제'에서 나왔다.)
//
//  판단이 조금이라도 불확실하면 전부 '파싱된다'(=재시도 안 함)로 답한다 — 부작용 중복보다 훅 1회 실패가 낫다.
//  실패한 훅에서만(이미 느린 경로) 부르므로 정상 경로 비용은 0이다.
function parsesUnder(file, expectHash) {
  let actual;
  try { actual = crypto.createHash("sha256").update(readFileSync(file)).digest("hex"); }
  catch { return true; }                  // 파일을 못 읽는다(훅이 지웠나) → 판정 불가 → 재시도 안 함
  if (actual !== expectHash) return true; // 우리가 쓴 그 파일이 아니다(훅이 덮어씀) → 판정 불가 → 재시도 안 함
  try {
    // 러너 자신의 node 로 본다 — PATH 에 node 가 없어도(번들 node 로 띄운 러너) 판정이 선다.
    execFileSync(process.execPath, ["--check", file], { stdio: "ignore", timeout: CHECK_MS, killSignal: "SIGKILL" });
    return true;
  } catch (e) {
    // «안 된다» 는 `--check` 가 실제로 돌아 1 로 끝났을 때뿐이다(이 확장자로 파싱 안 됨 = 확장자를 잘못 골랐다, 또는 훅
    //  자체가 깨졌다). 못 띄웠거나(ENOENT·EAGAIN) 시간 안에 못 끝냈으면(ETIMEDOUT) 판정 불가 → 재시도 안 함 —
    //  판정 불가를 «안 됨» 으로 읽으면 이미 돈 훅을 한 번 더 돌린다(부작용 중복, #5034 리뷰).
    return !(e && e.status === 1 && !e.signal);
  }
}

// 훅 1개 실행 → { out, fail }. fail 은 관측용(#892 결함 C) — 종전엔 크래시를 통째로 삼켜(catch → "")
//  '훅이 죽음'과 '훅이 출력 없음'이 구분 불가였고, 그래서 죽은 훅이 내내 발견되지 않았다.
//  opts.orgRuntime — 조직 실행 방식(runtimeOf) · opts.deadline — 이벤트 예산의 마감 시각(spawnHook 이 띄우는 순간 남은 시간을 잰다).
async function runHook(hook, stdin, opts = {}) {
  // content_hash 무결성 — 해시가 없거나(변조 캐시) source 와 불일치면 실행 안 함(fail-CLOSED hard-gate).
  const h = crypto.createHash("sha256").update(hook.source_code || "").digest("hex");
  if (!hook.content_hash || hook.content_hash !== h) return { out: "", fail: { reason: "hash_mismatch" } };
  const run = { runtime: runtimeOf(hook, opts.orgRuntime), deadline: opts.deadline };
  const first = moduleExt(hook.source_code);
  const r = await spawnHook(hook, stdin, first, h, run);
  // 실패했고 **그 확장자로는 파일이 파싱조차 안 되면** 확장자를 잘못 고른 것 → 반대로 딱 한 번 다시.
  //  파싱이 안 됐다 = 본문이 한 줄도 안 돌았다 → 부작용 중복이 원리적으로 불가능하다.
  //  분류(moduleExt)는 휴리스틱이라 변두리에서 틀리는데, 그때 훅을 죽이는 대신 자가교정한다
  //  (오분류의 비용이 '훅 사망'이면 안 된다 — 그게 #892 였다).
  //  훅 자체가 문법오류면 반대쪽도 파싱 실패라 재시도 1회로 끝나고 원래 실패를 보고한다.
  if (r.fail && r.parses === false) {
    const retry = await spawnHook(hook, stdin, first === "mjs" ? "cjs" : "mjs", h, run);
    if (!retry.fail) return retry;
  }
  return r;
}

const HOOK_MAX_BUFFER = 4 * 1024 * 1024;
const PIPE_GRACE_MS = 200;

// 자식 node 를 비동기로 띄워 끝날 때까지 기다린다 — execFileSync 와 같은 결과 모양(stdout·stderr·status·signal)을
//  돌려주되 이벤트 루프를 막지 않아서 같은 묶음의 훅들이 동시에 돈다. 실패를 throw 하지 않고 값으로 돌려준다.
//  maxBuffer 초과도 execFileSync 처럼 SIGKILL 로 끊는다(무한 출력 훅이 러너 메모리를 잡아먹지 않게).
function execNode(file, { input, timeout, env }) {
  return new Promise((resolve) => {
    let child;
    // 러너 자신의 node 로 띄운다 — PATH 에 node 가 없는 기계(번들 node 로 러너를 띄운 설치)에선 "node" 가 ENOENT 로
    //  모든 훅을 죽였다(health 의 «spawn node ENOENT»). 스레드로 도는 훅과 같은 판의 node 이기도 하다.
    try { child = spawn(process.execPath, [file], { env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { resolve({ stdout: "", stderr: String((e && e.message) || ""), status: null, signal: null }); return; }
    const out = []; const err = []; let outLen = 0; let errLen = 0; let settled = false; let killed = false; let overflow = false;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // 상한에서 손을 뗀다 — 파이프에 남은 마지막 출력이 들어올 짧은 유예를 준 뒤 스트림을 닫고 끝낸다.
    //  close 를 끝까지 기다리지 않는 이유: 훅이 stdio 를 물려받은 손자(예: 백그라운드 git fetch)를 남기면 그 손자가
    //  끝날 때까지 파이프가 안 닫혀 timeout 이 상한 노릇을 못 한다(execFileSync 는 상한에서 바로 돌아왔다).
    const letGo = (code, signal) => setTimeout(() => {
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* */ }
      finish(code, signal);
    }, PIPE_GRACE_MS);
    // 아직 도는 훅만 죽인다 — 이미 끝났는데 파이프만 손자가 붙잡고 있으면 그 시점의 결과로 끝낸다.
    const kill = () => {
      if (exited()) { letGo(child.exitCode, child.signalCode); return; }
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* 그 사이 끝남 — exit 가 온다 */ }
    };
    const timer = setTimeout(kill, timeout);
    const take = (buf, chunks, len) => { if (len + buf.length > HOOK_MAX_BUFFER) { overflow = true; kill(); return len; } chunks.push(buf); return len + buf.length; };
    child.stdout.on("data", (b) => { outLen = take(b, out, outLen); });
    child.stderr.on("data", (b) => { errLen = take(b, err, errLen); });
    const finish = (status, signal, extraErr) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + (extraErr || ""),
        // 출력 상한 초과는 훅이 어떻게 끝났든 실패다(잘린 출력이 성공으로 나가면 안 된다) — execFileSync 처럼 강제 종료로 본다.
        status: overflow ? null : (typeof status === "number" ? status : null),
        signal: overflow ? "SIGKILL" : (signal || null),
      });
    };
    child.on("error", (e) => finish(null, null, String((e && e.message) || "")));
    child.on("exit", (code, signal) => { if (killed || signal === "SIGKILL") letGo(code, signal); });
    child.on("close", (code, signal) => finish(code, signal));
    // 훅이 stdin 을 안 읽고 먼저 끝나면 EPIPE 가 난다 — 훅의 정상 동작이므로 삼킨다.
    child.stdin.on("error", () => { /* */ });
    child.stdin.end(input);
  });
}

// 워커 부트스트랩 — 훅 파일을 스레드 안에서 불러오기 전에 process.stdin 을 «입력 한 덩어리 뒤 바로 끝나는» 스트림으로 바꾼다.
//  Worker 의 stdin:true 는 메시지 포트라, 훅이 stdin 을 끝까지 안 읽으면 그 포트가 스레드를 상한까지 살려 둔다(실측).
//  입력은 러너가 이미 다 읽어 두었으니 스트림으로 건네면 안 읽는 훅을 붙잡을 것이 없다.
//  process.argv 도 프로세스 때 모양([node, 훅 파일])으로 맞춘다 — 그대로 두면 argv[1] 이 "[worker eval]" 이라
//   자기 경로에 쓰는 훅이 cwd 에 그 이름의 파일을 만든다(실측: A10 시험 훅이 워크트리에 만들었다).
//  eval 스레드는 `node -e` 처럼 require·module·exports·__filename·__dirname 을 **전역**에 둔다 — 그대로 두면 ESM 훅이
//   프로세스 때는 죽을 require 를 스레드에서만 몰래 쓴다(두 실행 방식이 다르게 동작한다). 부트스트랩이 쓸 것을 챙긴 뒤 지운다.
//   CJS 훅(.cjs)은 모듈 래퍼가 제 require 를 주므로 영향이 없다.
//  모듈 로드 실패(문법 오류 등)는 다음 틱에 다시 던져 스레드의 잡히지 않은 오류로 만든다 — 프로세스 때처럼 «죽었다» 로 드러난다.
const WORKER_BOOT = [
  'const { workerData } = require("node:worker_threads");',
  'const { Readable } = require("node:stream");',
  'const stdin = Readable.from([Buffer.from(workerData.input, "utf8")], { objectMode: false });',
  'Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true, writable: true });',
  "process.argv.splice(1, process.argv.length, workerData.file);",
  'for (const k of ["require", "module", "exports", "__filename", "__dirname"]) { try { delete globalThis[k]; } catch { /* */ } }',
  "import(workerData.url).catch((e) => setImmediate(() => { throw e; }));",
].join("\n");

// execNode 와 같은 결과 모양으로 훅을 워커 스레드에서 돌린다(#5034). 다른 점만 적는다:
//  · 상한·출력 초과에선 스레드를 끊고(terminate) 끝나기를 기다리지 않는다 — 네이티브 호출에 묶인 스레드엔 terminate 가
//    그 호출이 돌아온 뒤에야 먹히고, 러너도 끝날 때 그 스레드를 기다린다(FIFO 동기 읽기면 영영). 그래서 스레드 기본은 우리가
//    시험하는 시드 훅만이고, 아는 모양(동기 자식 실행 등)은 runtimeOf 가 시드여도 프로세스로 보낸다.
//  · 잡히지 않은 오류는 'error' 이벤트로 온다 — 프로세스라면 stderr 에 찍혔을 덤프를 같은 자리에 둔다(errorHeadline 이 그대로 읽는다).
//  · HostEffects 가 deny(격리 안 된 테스트)면 프로세스 경로처럼 띄우지 않는다 — 두 경로의 차단 의미를 맞춘다.
function execWorker(file, { input, timeout, env }) {
  return new Promise((resolve) => {
    let w;
    try {
      if (hostEffects.mode === "deny") throw new Error("HostEffects denied worker: node");
      w = new Worker(WORKER_BOOT, { eval: true, env, stdout: true, stderr: true, workerData: { file, url: pathToFileURL(file).href, input: String(input ?? "") } });
    } catch (e) { resolve({ stdout: "", stderr: String((e && e.message) || ""), status: null, signal: null }); return; }
    const out = []; const err = []; let outLen = 0; let errLen = 0;
    let settled = false; let killed = false; let overflow = false; let exited = false; let exitCode = null; let open = 2; let grace = null;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace);
      const cut = killed || overflow;
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), status: cut ? null : exitCode, signal: cut ? "SIGKILL" : null });
    };
    const kill = () => {
      if (killed) return; killed = true;
      w.terminate().catch(() => { /* 이미 끝남 */ });
      clearTimeout(grace); grace = setTimeout(finish, PIPE_GRACE_MS);
    };
    const timer = setTimeout(kill, timeout);
    const take = (buf, chunks, len) => { if (len + buf.length > HOOK_MAX_BUFFER) { overflow = true; kill(); return len; } chunks.push(buf); return len + buf.length; };
    const doneIfDrained = () => { if (exited && open <= 0) finish(); };
    w.stdout.on("data", (b) => { outLen = take(b, out, outLen); });
    w.stderr.on("data", (b) => { errLen = take(b, err, errLen); });
    for (const s of [w.stdout, w.stderr]) {
      s.on("end", () => { open--; doneIfDrained(); });
      s.on("error", () => { open--; doneIfDrained(); });
    }
    w.on("error", (e) => { errLen = take(Buffer.from(String((e && (e.stack || e.message)) || e) + "\n"), err, errLen); });
    w.on("exit", (code) => {
      exited = true; exitCode = typeof code === "number" ? code : null;
      if (killed) { finish(); return; }
      doneIfDrained();
      // 스레드는 끝났는데 스트림 끝 신호가 늦는 경우의 안전판.
      clearTimeout(grace); grace = setTimeout(finish, PIPE_GRACE_MS);
    });
  });
}

async function spawnHook(hook, stdin, ext, expectHash, run = {}) {
  // 이벤트 예산이 남긴 시간보다 오래 기다리지 않는다 — 그 값이 곧 LIVELY_HOOK_TIMEOUT_MS 라 훅도 그 전에 스스로 멈춘다.
  //  띄우는 **이 순간** 잰다: 묶음에서 줄 서 기다린 훅·확장자 재시도도 같은 마감을 지킨다.
  const left = Number.isFinite(run.deadline) ? run.deadline - Date.now() : Infinity;
  if (left < MIN_SPAWN_MS) return { out: "", fail: { reason: "budget" }, parses: true };
  const tmp = join(tmpdir(), `lively-hook-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(tmp, hook.source_code || "", { mode: 0o600 });
    const limit = Math.min(Math.max(Number(hook.timeout_sec) || 10, 1), 120) * 1000;
    const timeout = Math.max(1, Math.min(limit, Math.floor(left)));
    // SIGKILL 로 끊는다 — 훅이 SIGTERM 핸들러/동기 busy-loop 로 타임아웃을 살아남아 세션을 막는 것 방지(no-block 불변식).
    // LIVELY_HOOK_TIMEOUT_MS — 훅에게 **자기가 죽는 시각**을 알려준다(#905 C3). SIGKILL 은 정리 코드조차 못 돌게
    //  하므로, I/O 하는 훅은 그 전에 스스로 멈춰 결과를 남겨야 한다(project-push 의 충돌 기록이 그 예). 이 값이
    //  없으면 훅이 상한을 추측해 하드코딩하게 되고, 관리자가 timeout_sec 을 줄이는 순간 조용히 어긋난다.
    const exec = run.runtime === "worker" ? execWorker : execNode;
    const r = await exec(tmp, {
      input: stdin, timeout,
      env: {
        ...process.env,
        // 본문 훅도 러너가 고른 **같은 신원·같은 주소**로 나가게 한다(#959). 훅 본문은 대개 «env 먼저» 로 고르므로,
        //  사람이 연 셸에서 rc 가 심은 옛 LIVELY_TOKEN 을 그대로 물려받으면 러너만 새 신원이고 본문은 옛 신원이 된다.
        //  라이블리가 띄운 pane 에선 러너가 고른 값이 곧 그 env 라 달라지는 게 없다. 고른 값이 없으면 싣지 않는다.
        ...(TOKEN ? { LIVELY_TOKEN: TOKEN } : {}),
        ...(GW_PICKED ? { LIVELY_GATEWAY_URL: GW_PICKED } : {}),
        ...(HARNESS ? { LIVELY_HARNESS: HARNESS } : {}),
        LIVELY_HOOK_TIMEOUT_MS: String(timeout),
      },
    });
    if (r.status === 0 && !r.signal) return { out: r.stdout, fail: null, parses: true };
    // 타임아웃/비정상 종료여도 세션을 막지 않는다(fail-open) — 부분 stdout 만 회수하고 실패는 따로 보고한다.
    const fail = {
      // 예산이 상한을 줄였고 그 상한에 끊겼으면 훅 탓이 아니라 예산 탓이다(«budget» — 게이트웨이에 훅 실패로 보고하지 않는다).
      reason: r.signal === "SIGKILL" ? (timeout < limit ? "budget" : "timeout") : "crash",
      exit_code: r.status,
      signal: r.signal,
      // 꼬리를 남긴다 — 훅이 자기 로그를 뱉고 나서 죽으면 정작 치명오류 덤프가 맨 뒤에 오기 때문.
      //  덤프(보통 수백 자)는 통째로 들어오고, errorHeadline 이 그 안에서 에러 줄을 골라낸다.
      stderr: r.stderr.slice(-STDERR_KEEP),
    };
    // 실패했을 때만 파서에게 묻는다(느린 경로) — tmp 가 아직 살아 있는 이 안에서 불러야 한다(finally 가 지운다).
    //  상한에 끊긴 훅은 묻지 않는다: 돌고 있었다 = 파싱됐다. `--check` 는 동기(최대 CHECK_MS)라 그동안 러너의 다른 훅도 멈춘다.
    return { out: r.stdout, fail, parses: r.signal === "SIGKILL" ? true : parsesUnder(tmp, expectHash) };
  } catch (e) { return { out: "", fail: { reason: "spawn_error", stderr: String((e && e.message) || "").slice(-STDERR_KEEP) }, parses: true }; }
  finally { try { rmSync(tmp, { force: true }); } catch { /* */ } }
}

// 실행 순서 — 조직이 동시 실행을 켰으면(concurrent) 훅의 sort 가 같은 것끼리 한 묶음으로 **동시에**, 다른 묶음은
//  sort 오름차순으로 **차례로** 돈다. 끄면(기본) 종전처럼 받은 순서(서버 정렬 sort·id)대로 하나씩 돈다.
//  종전엔 전부 차례로 돌아 한 이벤트의 시간이 훅 소요의 합이었다(훅 12개면 매 프롬프트 2~5초). sort 는 관리자가
//  이미 '뒤에 돌아야 하는 훅'(예: 프로젝트를 붙인 뒤에 그 프로젝트 문맥을 싣는 훅)을 뒤로 미는 데 쓰고 있었으므로,
//  그 뜻은 묶음 사이 순서로 그대로 지키고 묶음 안에서만 겹친다.
//  ⚠ 기본이 꺼짐인 이유: 조직이 만든 훅은 기본 sort 0 이라 켜는 순간 시드와 한 묶음이 된다 — 종전엔 id 순으로 우연히
//   지켜지던 선후(같은 파일을 쓰거나 앞 훅의 결과에 기대는 훅)가 소리 없이 깨질 수 있어, 조직이 확인하고 켠다.
//  ⚠ sort 를 모르면(구버전 게이트웨이 응답·그때 저장된 캐시) 켜져 있어도 전부 차례로 돈다 — 순서 정보 없이 겹치면
//   종전에 우연히 지켜지던 순서가 깨질 수 있고, 느린 쪽이 안전한 쪽이다.
//  한 묶음에서 동시에 도는 훅은 HOOK_PARALLEL_MAX 개까지다(같은 sort 의 훅이 수십 개여도 프로세스가 한꺼번에 뜨지 않게).
//  결과는 sort 오름차순, 같은 sort 안에서는 받은 순서로 돌려준다(끝난 순서가 아니다) — 컨텍스트 이어붙이기·결정
//   병합이 매번 같아야 한다.
//  ★ 제품 시드 훅끼리는 조직 설정과 무관하게 겹친다(#5034 — 모든 조직의 기본). 시드 훅은 제품 코드라 같은 sort 끼리
//   서로의 결과에 기대지 않는다는 것을 우리가 보장한다(뒤에 돌아야 하는 것은 sort 를 나눠 두었다 — 프로젝트를 붙인 뒤에
//   맥락을 싣는 project-agents-inject 10 · 내려받은 뒤에 올리는 push 20). 직접 만든 훅은 설정을 켜기 전까지 혼자 돈다 —
//   받은 순서에서 «이어진 시드 훅 중 sort 가 같은 것» 만 한 묶음이라, 직접 만든 훅과 시드 훅 사이의 앞뒤는 종전 그대로다.
const HOOK_PARALLEL_MAX = 8;
// 훅 하나의 예외(예: 캐시가 깨져 source_code 가 문자열이 아님)가 같은 묶음의 이웃을 끌고 가지 않게 값으로 바꾼다.
const runHookIsolated = (hk, stdin, opts) => runHook(hk, stdin, opts).catch((e) =>
  ({ out: "", fail: { reason: "spawn_error", stderr: String((e && e.message) || e).slice(-STDERR_KEEP) } }));
async function runWave(wave, stdin, opts) {
  const rs = new Array(wave.length);
  let next = 0;
  const worker = async () => { while (next < wave.length) { const i = next++; rs[i] = await runHookIsolated(wave[i], stdin, opts); } };
  await Promise.all(Array.from({ length: Math.min(HOOK_PARALLEL_MAX, wave.length) }, worker));
  return rs;
}
function wavesOf(hooks, concurrent) {
  if (!hooks.every((hk) => typeof hk.sort === "number" && Number.isFinite(hk.sort))) return hooks.map((hk) => [hk]);
  if (concurrent === true) {
    const bySort = new Map();
    for (const hk of hooks) { if (!bySort.has(hk.sort)) bySort.set(hk.sort, []); bySort.get(hk.sort).push(hk); }
    return [...bySort.keys()].sort((a, b) => a - b).map((k) => bySort.get(k));
  }
  const waves = [];
  for (const hk of hooks) {
    const last = waves[waves.length - 1];
    if (hk.seed === true && last && last[0].seed === true && last[0].sort === hk.sort) last.push(hk);
    else waves.push([hk]);
  }
  return waves;
}
// 예산(EVENT_BUDGET_MS)이 걸린 이벤트는 묶음을 시작하기 전에 남은 시간을 본다 — 모자라면 남은 훅을 건너뛰고(실패 «budget»
//  으로 드러낸다) 지금까지 모은 출력으로 끝낸다. 도는 훅의 상한도 남은 시간으로 줄인다.
async function runAll(hooks, stdin, cfg, deadline = Infinity) {
  const waves = wavesOf(hooks, cfg.concurrent);
  const results = [];
  for (let i = 0; i < waves.length; i++) {
    const left = deadline - Date.now();
    if (left < MIN_WAVE_MS) {
      for (const hk of waves.slice(i).flat()) results.push({ hk, out: "", fail: { reason: "budget" } });
      break;
    }
    const rs = await runWave(waves[i], stdin, { orgRuntime: cfg.runtime, deadline });
    waves[i].forEach((hk, j) => results.push({ hk, ...rs[j] }));
  }
  return results;
}

// 훅 stderr 에서 '왜 죽었나' 한 줄을 뽑는다. Node 의 치명오류 덤프는 [소스발췌 → 빈줄 → `XxxError: 메시지` →
//  `at ...` 스택 → `Node.js vX`] 순이라, 뒤에서 자르면 정작 메시지가 아니라 스택 꼬리만 남는다.
//  스택 프레임·캐럿·버전줄을 걷어내고 에러 헤드라인을 우선 고른다(없으면 첫 유효 줄).
function errorHeadline(stderr) {
  const lines = String(stderr || "").split("\n").map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^\^+$/.test(l) && !/^Node\.js v/.test(l));
  //  `\w*` 앞자리를 비워 둬야 접두어 없는 `Error:`(가장 흔한 형태)와 `Error [ERR_MODULE_NOT_FOUND]:` 도 잡힌다
  //  — 접두어를 강제하면 ReferenceError·TypeError 만 잡고 정작 맨 앞의 파일경로 줄로 폴백해 버린다.
  const head = lines.find((l) => /^\w*(Error|Exception)\b/.test(l)) || lines[0] || "";
  return head.slice(0, 300);
}

// PreToolUse 의 훅 출력은 '컨텍스트 텍스트'가 아니라 '결정'이라 이어붙일 수 없다. 러너는 하네스에 훅 1개로
//  보이는 멀티플렉서(N훅 → stdout 1개)이므로, 하네스가 훅들 사이에서 하는 병합을 러너가 직접 해야 한다.
//  규칙은 Claude Code 공식과 동일: 가장 제한적인 결정이 이긴다(deny > defer > ask > allow),
//  additionalContext 는 모든 훅 것을 모아 함께 전달. relay 는 org 정책 필터(기본 allow 제외).
const RANK = { deny: 4, defer: 3, ask: 2, allow: 1 };

// 훅 stdout 에서 hookSpecificOutput 을 꺼낸다. 하네스 계약상 PreToolUse 의 비JSON stdout 은 무시되므로,
//  파싱 실패 = '이 훅은 하네스에 아무 말도 못 했다' 와 같다 → 호출부가 이걸 실패로 드러낸다.
function hookOutputOf(raw) {
  let j; try { j = JSON.parse(raw); } catch { return null; }
  const h = j && j.hookSpecificOutput;
  return (h && typeof h === "object" && !Array.isArray(h)) ? h : null;
}

// 컨텍스트 이벤트(SessionStart·UserPromptSubmit·PostToolUse)의 훅 출력에서 하네스 봉투를 벗긴다.
//  훅은 PreToolUse 와 같은 모양(hookSpecificOutput.additionalContext JSON)으로 컨텍스트를 내는 일이 흔하다.
//  N개를 그대로 이어붙이면 `{...}\n\n{...}` 가 되어 하네스가 "JSON 처럼 보이는데 파싱 실패" 로 통째 버린다
//  — 훅은 전부 성공했는데 컨텍스트는 하나도 안 들어가는 무음 실패다. 봉투는 러너가 벗기고 본문만 합친다
//  (다시 봉투가 필요한 하네스·이벤트는 emitContext 가 하나로 감싼다).
//  ⚠ 컨텍스트'만' 실은 봉투일 때만 벗긴다 — decision·systemMessage 등 다른 뜻이 함께 실려 있으면 벗기는 순간
//   그 뜻이 사라진다(훅 1개면 하네스가 봉투를 그대로 소비하던 경로다). 그 경우 raw 로 두고, 다른 출력과
//   합쳐져 하네스가 못 읽게 될 수 있으니 진단만 남긴다.
function unwrapContext(raw) {
  let j; try { j = JSON.parse(raw); } catch { return raw; }
  const h = hookOutputOf(raw);
  if (!h || typeof h.additionalContext !== "string") return raw;
  const extra = Object.keys(j).some((k) => k !== "hookSpecificOutput")
    || Object.keys(h).some((k) => k !== "hookEventName" && k !== "additionalContext");
  if (!extra) return h.additionalContext;
  const carried = Object.keys(j).filter((k) => k !== "hookSpecificOutput")
    .concat(Object.keys(h).filter((k) => k !== "hookEventName" && k !== "additionalContext"));
  process.stderr.write(`[lively] hook envelope carries ${carried.join(",")} — kept as-is\n`);
  return raw;
}

function mergePreToolUse(outputs, relay) {
  let best = null; const reasons = []; const ctxs = [];
  for (const raw of outputs) {
    const h = hookOutputOf(raw);
    if (!h) continue; // 비JSON stdout 은 PreToolUse 에서 하네스도 무시 → 버린다(호출부가 별도로 보고)
    if (h.additionalContext) ctxs.push(String(h.additionalContext));
    const d = h.permissionDecision;
    if (!d || !RANK[d] || !relay.includes(d)) continue; // 정책상 전파 안 하는 결정은 무시
    if (!best || RANK[d] > RANK[best]) { best = d; reasons.length = 0; }
    if (RANK[d] === RANK[best] && h.permissionDecisionReason) reasons.push(String(h.permissionDecisionReason));
  }
  if (!best && !ctxs.length) return null;
  const out = { hookEventName: "PreToolUse" };
  if (best) {
    out.permissionDecision = best;
    if (reasons.length) out.permissionDecisionReason = reasons.join("\n\n");
  }
  if (ctxs.length) out.additionalContext = ctxs.join("\n\n");
  return out;
}

// 세션 중간 연결(#5016) — 작업 폴더 밖으로 시작한 세션(시작 훅이 표식을 남김)에서 이 폴더가 방금 등록됐으면,
//  시작 때 빠진 회사 맥락을 이번 지시에 한 번 넣는다. 표식은 먼저 걷는다 — 못 받아 와도 지시마다 다시 왕복하지 않게.
async function lateOrgContext(input) {
  const sid = String(input.session_id || input.sessionId || "");
  if (!TOKEN || !startedOutside(sid)) return "";
  clearStartedOutside(sid);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(`${GW}/api/ui/org/preview`, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}`, ...scopeHeaders(input) } });
    const ctx = res.ok ? String((await res.json())?.context || "").trim() : "";
    return ctx ? `## [라이블리] 이 폴더가 방금 작업 폴더로 등록돼 이 세션도 연결됐습니다 — 세션 시작 때 빠진 회사 맥락을 지금 넣습니다\n\n${ctx}` : "";
  } catch { return ""; }
  finally { clearTimeout(t); }
}

async function main() {
  if (!EVENT) return;
  const stdin = await readStdin(SESSIONEND ? STDIN_MS_SESSIONEND : undefined);
  let input = {}, toolName = "";
  try { input = JSON.parse(stdin || "{}"); toolName = input.tool_name || input.toolName || ""; } catch { /* */ }
  // 기록 범위(#5016) — 작업 폴더 밖에서 켠 세션이면 인코그니토와 같다: 게이트웨이 조회도 커스텀 훅 실행도 없이 끝낸다.
  //  (대화 업로드·첫 지시 프로젝트·지식 회수 같은 조직 훅이 전부 이 러너 뒤에 있다.) 판정 규칙은 record-scope.mjs 하나.
  if (!inScopeNow({ env: process.env, input, cwd: process.cwd(), harness: HARNESS, lively: LIVELY }).inScope) return;
  const late = EVENT === "UserPromptSubmit" ? await lateOrgContext(input) : "";

  // 예산의 기준은 이 프로세스가 뜬 시각이다 — 하네스의 상한도 러너를 띄운 순간부터 센다.
  const deadline = EVENT_BUDGET_MS > 0 ? performance.timeOrigin + EVENT_BUDGET_MS : Infinity;
  const key = listCacheKey(input);
  let cfg = loadFreshCache(key);                                                   // 방금 받은 목록이면 다시 묻지 않는다
  if (!cfg) {
    const fetched = await fetchHooks(input);
    cfg = fetched === null ? (loadCache() || { hooks: [], relay: DEFAULT_RELAY, concurrent: false, runtime: null }) : fetched; // 미도달 → grace 캐시
    if (fetched !== null) saveCache(fetched, key);                                 // 성공 → 캐시 갱신
  }
  const relay = cfg.relay.filter((d) => RANK[d]); // 잡값 방어
  const hooks = cfg.hooks.filter((hk) => hk && (hk.event === EVENT) && matches(hk, toolName));
  if (!hooks.length) { if (late) emitContext(late); return; }

  const outputs = []; const fails = [];
  for (const { hk, out, fail } of await runAll(hooks, stdin, cfg, deadline)) {
    const trimmed = out && out.trim() ? out.trim() : "";
    if (trimmed) outputs.push(trimmed);
    // PreToolUse 에서 훅이 뭔가 뱉었는데 결정으로 못 읽히면(예: JSON 앞에 console.log 한 줄) 하네스는 그걸
    //  통째로 무시한다 — 훅은 '성공'으로 끝났는데 게이트는 안 걸리는, #892 와 똑같은 조용한 무력화다.
    //  크래시가 아니라 잡히지 않던 구멍이라 여기서 명시적으로 실패로 드러낸다.
    if (!fail && EVENT === "PreToolUse" && trimmed && !hookOutputOf(trimmed)) {
      fails.push({ hook_id: hk.id, reason: "bad_output", exit_code: null, stderr: trimmed.slice(0, STDERR_KEEP) });
    }
    if (fail) fails.push({ hook_id: hk.id, ...fail });
  }
  // 모든 실패를 stderr 에 남긴다 — exit 0 을 유지하므로 하네스 디버그 로그로만 간다(`claude --debug`), 세션엔 무영향.
  //  훅이 실제로 뱉은 것까지 싣는다: 게이트웨이 보고(health)가 유일한 진단 채널이면 토큰이 없거나 게이트웨이가
  //  죽었을 때 '왜'가 통째로 사라진다 — 그게 애초에 이 훅들이 조용히 죽어 있던 이유다.
  //  스로틀을 걸지 않는다(로그행은 공짜고, 진단할 땐 매번 보이는 편이 낫다). bad_output 도 같은 채널로 —
  //  '하네스가 무시할 출력'이야말로 로컬에서 눈으로 봐야 고칠 수 있다.
  for (const f of fails) {
    try {
      const why = errorHeadline(f.stderr);
      process.stderr.write(`[lively] hook '${f.hook_id}' ${f.reason}`
        + (f.exit_code != null ? ` exit=${f.exit_code}` : "")
        + (why ? `: ${why}` : "") + "\n");
    } catch { /* */ }
  }
  // 게이트웨이 보고와 사용자 알림엔 스로틀을 건다 — 러너는 툴콜마다 도므로, 없으면 고장난 훅 하나가
  //  매 툴콜에 왕복 1회 + 배너 1개를 붙여 세션을 시끄럽고 느리게 만든다.
  //  · «budget»(예산 때문에 건너뛰었거나 줄인 상한에 끊김)은 보고하지 않는다 — 훅 탓이 아니라 앞 훅들이 오래 걸린 탓이라,
  //    올리면 그 훅의 진짜 실패 기록(health)을 덮고 엉뚱한 훅을 탓한다. 진단은 위 stderr 줄에 남는다.
  //  · 보고할 시간이 없으면 스로틀 도장도 찍지 않는다 — 찍고 안 보내면 진짜 크래시가 10분간 묻힌다(다음 실행이 보낸다).
  const reportable = fails.filter((f) => f.reason !== "budget");
  const roomToReport = !Number.isFinite(deadline) || deadline - Date.now() > 100;
  const notable = reportable.length && roomToReport ? throttleFailures(reportable) : [];
  if (notable.length) await reportFailures(notable, input, deadline);

  // PreToolUse 는 결정 이벤트 — 파싱·병합해 단일 결정 JSON 으로 전파(exit 0 + JSON stdout = 하네스 계약).
  //  훅이 죽었으면 systemMessage 로 사용자에게도 알린다(조용한 죽음 방지 — 이 이벤트는 이미 JSON 출력이라 무위험).
  if (EVENT === "PreToolUse") {
    const decision = mergePreToolUse(outputs, relay);
    const payload = decision ? { hookSpecificOutput: decision } : {};
    if (notable.length) payload.systemMessage = `Lively 커스텀 훅 실패: ${notable.map((f) => `${f.hook_id}(${f.reason})`).join(", ")}`;
    if (decision || notable.length) process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }
  // SessionStart·UserPromptSubmit 의 stdout 은 컨텍스트로 주입(둘 다 Claude 가 raw stdout 을 additionalContext 로 받는 안전 이벤트).
  //  UserPromptSubmit 주입 = #172 관련지식 자동회수(knowledge-recall) + #637 도메인 라우팅(domain-recall).
  //  PostToolUse 도 주입(#637 Stage2): 코드파일 Read 즉시 leaf 주입(domain-recall-action). emitContext 가 이벤트별 포맷
  //   (PostToolUse 는 hookSpecificOutput.additionalContext JSON — Claude Code 계약, 담당자 검증). 실행결과 없으면 no-op.
  //  나머지 이벤트(Stop·SessionEnd 등)는 여전히 부수효과만(stdout 미전파).
  if ((EVENT === "SessionStart" || EVENT === "UserPromptSubmit" || EVENT === "PostToolUse") && (outputs.length || late)) emitContext([late, ...outputs.map((o) => unwrapContext(o).trim())].filter(Boolean).join("\n\n"));
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
