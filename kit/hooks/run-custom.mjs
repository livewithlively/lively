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
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
// 주입 봉투는 하네스별 규약이다 — 표에서 파생한다. ⚠ HARNESS 상수는 종전 계산식 유지(빈 문자열 가능):
//  이 값이 게이트웨이 질의(`?harness=`)에 그대로 실리므로 여기서 기본값을 채우면 서버가 받는 값이 바뀐다.
import { harness, isForeignGrokInvocation } from "./harness-registry.mjs";
import { hostEffects } from "./host-effects-port.mjs";

const execFileSync = (...args) => hostEffects.execFileSync(...args);
const fetch = (...args) => hostEffects.fetch(...args);

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다 — dev '다온' 실측이 정확히 그 사고다.
const executionSessionId = (input = {}) => {
  const direct = String(process.env.LIVELY_SESSION_ID || "").trim();
  if (direct) return direct;
  const native = String(input.session_id || input.sessionId || "").trim();
  if (native && HARNESS === "codex") return `codex-${native}`;
  if (native && HARNESS === "claude") return `claude-${native}`;
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
if (isForeignGrokInvocation()) process.exit(0);

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

const readLocal = (rel) => { try { return readFileSync(join(LIVELY, rel), "utf8").trim() || null; } catch { return null; } };
const TOKEN = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
const GW = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080").replace(/\/$/, "");

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

// → { hooks, relay } | null(게이트웨이 미도달). relay 는 org 정책(관리탭) — 구버전 게이트웨이면 기본값.
async function fetchHooks(input) {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SESSIONEND ? FETCH_MS_SESSIONEND : FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/hooks?harness=${encodeURIComponent(HARNESS || "")}&event=${encodeURIComponent(EVENT)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}`, ...scopeHeaders(input) } });
    if (!res.ok) return null;
    const j = await res.json();
    if (!Array.isArray(j?.hooks)) return { hooks: [], relay: DEFAULT_RELAY };
    return { hooks: j.hooks, relay: Array.isArray(j?.relay_decisions) ? j.relay_decisions : DEFAULT_RELAY };
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
async function reportFailures(fails, input) {
  if (!TOKEN || !fails.length) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REPORT_MS);
  try {
    await fetch(`${GW}/api/ui/org/runner/hook-report`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${TOKEN}`, ...scopeHeaders(input), "content-type": "application/json" },
      body: JSON.stringify({ event: EVENT, harness: HARNESS || null, failures: fails }),
    });
  } catch { /* 관측은 best-effort */ }
  finally { clearTimeout(t); }
}

function saveCache(hooks, relay) {
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), hooks, relay }), { mode: 0o600 }); } catch { /* fail-open */ }
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
    return { hooks: c.hooks, relay: Array.isArray(c.relay) ? c.relay : DEFAULT_RELAY };
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
    execFileSync("node", ["--check", file], { stdio: "ignore", timeout: CHECK_MS, killSignal: "SIGKILL" });
    return true;
  } catch { return false; } // 우리가 쓴 그 소스가 이 확장자로 파싱 안 됨 = 확장자를 잘못 골랐다(또는 훅 자체가 깨졌다)
}

// 훅 1개 실행 → { out, fail }. fail 은 관측용(#892 결함 C) — 종전엔 크래시를 통째로 삼켜(catch → "")
//  '훅이 죽음'과 '훅이 출력 없음'이 구분 불가였고, 그래서 죽은 훅이 내내 발견되지 않았다.
function runHook(hook, stdin) {
  // content_hash 무결성 — 해시가 없거나(변조 캐시) source 와 불일치면 실행 안 함(fail-CLOSED hard-gate).
  const h = crypto.createHash("sha256").update(hook.source_code || "").digest("hex");
  if (!hook.content_hash || hook.content_hash !== h) return { out: "", fail: { reason: "hash_mismatch" } };
  const first = moduleExt(hook.source_code);
  const r = spawnHook(hook, stdin, first, h);
  // 실패했고 **그 확장자로는 파일이 파싱조차 안 되면** 확장자를 잘못 고른 것 → 반대로 딱 한 번 다시.
  //  파싱이 안 됐다 = 본문이 한 줄도 안 돌았다 → 부작용 중복이 원리적으로 불가능하다.
  //  분류(moduleExt)는 휴리스틱이라 변두리에서 틀리는데, 그때 훅을 죽이는 대신 자가교정한다
  //  (오분류의 비용이 '훅 사망'이면 안 된다 — 그게 #892 였다).
  //  훅 자체가 문법오류면 반대쪽도 파싱 실패라 재시도 1회로 끝나고 원래 실패를 보고한다.
  if (r.fail && r.parses === false) {
    const retry = spawnHook(hook, stdin, first === "mjs" ? "cjs" : "mjs", h);
    if (!retry.fail) return retry;
  }
  return r;
}

function spawnHook(hook, stdin, ext, expectHash) {
  const tmp = join(tmpdir(), `lively-hook-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(tmp, hook.source_code || "", { mode: 0o600 });
    const timeout = Math.min(Math.max(Number(hook.timeout_sec) || 10, 1), 120) * 1000;
    try {
      // killSignal SIGKILL — 훅이 SIGTERM 핸들러/동기 busy-loop 로 타임아웃을 살아남아 세션을 막는 것 방지(no-block 불변식).
      // LIVELY_HOOK_TIMEOUT_MS — 훅에게 **자기가 죽는 시각**을 알려준다(#905 C3). SIGKILL 은 정리 코드조차 못 돌게
      //  하므로, I/O 하는 훅은 그 전에 스스로 멈춰 결과를 남겨야 한다(project-push 의 충돌 기록이 그 예). 이 값이
      //  없으면 훅이 상한을 추측해 하드코딩하게 되고, 관리자가 timeout_sec 을 줄이는 순간 조용히 어긋난다.
      return { out: execFileSync("node", [tmp], {
        input: stdin, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(HARNESS ? { LIVELY_HARNESS: HARNESS } : {}),
          LIVELY_HOOK_TIMEOUT_MS: String(timeout),
        }, maxBuffer: 4 * 1024 * 1024,
      }), fail: null, parses: true };
    } catch (e) {
      // 타임아웃/비정상 종료여도 세션을 막지 않는다(fail-open) — 부분 stdout 만 회수하고 실패는 따로 보고한다.
      const fail = {
        reason: e && e.signal === "SIGKILL" ? "timeout" : "crash",
        exit_code: e && typeof e.status === "number" ? e.status : null,
        signal: (e && e.signal) || null,
        // 꼬리를 남긴다 — 훅이 자기 로그를 뱉고 나서 죽으면 정작 치명오류 덤프가 맨 뒤에 오기 때문.
        //  덤프(보통 수백 자)는 통째로 들어오고, errorHeadline 이 그 안에서 에러 줄을 골라낸다.
        stderr: e && e.stderr ? String(e.stderr).slice(-STDERR_KEEP) : "",
      };
      // 실패했을 때만 파서에게 묻는다(느린 경로) — tmp 가 아직 살아 있는 이 안에서 불러야 한다(finally 가 지운다).
      return { out: e && e.stdout ? String(e.stdout) : "", fail, parses: parsesUnder(tmp, expectHash) };
    }
  } catch (e) { return { out: "", fail: { reason: "spawn_error", stderr: String((e && e.message) || "").slice(-STDERR_KEEP) }, parses: true }; }
  finally { try { rmSync(tmp, { force: true }); } catch { /* */ } }
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

async function main() {
  if (!EVENT) return;
  const stdin = await readStdin(SESSIONEND ? STDIN_MS_SESSIONEND : undefined);
  let input = {}, toolName = "";
  try { input = JSON.parse(stdin || "{}"); toolName = input.tool_name || input.toolName || ""; } catch { /* */ }

  const fetched = await fetchHooks(input);
  const cfg = fetched === null ? (loadCache() || { hooks: [], relay: DEFAULT_RELAY }) : fetched; // 미도달 → grace 캐시
  if (fetched !== null) saveCache(fetched.hooks, fetched.relay);                                  // 성공 → 캐시 갱신
  const relay = cfg.relay.filter((d) => RANK[d]); // 잡값 방어
  const hooks = cfg.hooks.filter((hk) => hk && (hk.event === EVENT) && matches(hk, toolName));
  if (!hooks.length) return;

  const outputs = []; const fails = [];
  for (const hk of hooks) {
    const { out, fail } = runHook(hk, stdin);
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
  const notable = fails.length ? throttleFailures(fails) : [];
  if (notable.length) await reportFailures(notable, input);

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
  if ((EVENT === "SessionStart" || EVENT === "UserPromptSubmit" || EVENT === "PostToolUse") && outputs.length) emitContext(outputs.join("\n\n"));
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
