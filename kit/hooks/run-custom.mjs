#!/usr/bin/env node
// 불변 런너 — 커스텀 훅(org_hook)을 게이트웨이에서 매 세션 받아 실행한다.
//  설계(보안 종합 결론): 훅 본문(source_code)은 멤버 디스크에 영구 저장하지 않는다 — 매 호출 게이트웨이에서
//  fetch 해 임시파일로 실행 후 삭제. 따라서 admin 이 본문을 못 바꾸고(디스크에 없음), enabled=false/제거는
//  다음 세션부터 즉시 무효(=실효 kill-switch). 이 런너 1개만 settings 에 박히고 커스텀 훅별 엔트리는 없다.
//
//  fail-CLOSED + grace: 게이트웨이에 도달 못 하면 '최근 성공 캐시(grace 분 이내)'만 쓴다 — 만료되면 아무것도
//   실행하지 않는다(회수 불가 코드가 영원히 도는 일 방지). 단, 어떤 경우에도 세션 자체는 막지 않는다(exit 0).
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
import { execFileSync } from "node:child_process";

if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);

const EVENT = process.argv[2] || "";
const hIdx = process.argv.indexOf("--harness");
const HARNESS = ((hIdx > -1 ? process.argv[hIdx + 1] : "") || process.env.LIVELY_HARNESS || "").toLowerCase();

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const GRACE_MS = 10 * 60 * 1000; // 게이트웨이 일시 다운 허용(최근 성공 캐시). 만료 후 fail-CLOSED.
const FETCH_MS = 3000;
const REPORT_MS = 1500;   // 훅 실패 보고(fire-and-forget) 상한 — 세션을 절대 기다리게 하지 않는다.
const STDERR_KEEP = 800;  // 보고에 싣는 stderr 꼬리 길이(진단엔 충분, 페이로드는 작게).
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
  //  (찰스 wiki-action-router 로 검증된 계약, #637 Stage2). SessionStart·UserPromptSubmit 는 claude 가 raw stdout 을
  //  컨텍스트로 받으므로 raw 유지(codex 만 전 이벤트 JSON 래핑). → 기존 두 이벤트 동작 무변경.
  if (HARNESS === "codex" || EVENT === "PostToolUse") {
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
async function fetchHooks() {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/hooks?harness=${encodeURIComponent(HARNESS || "")}&event=${encodeURIComponent(EVENT)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) return null;
    const j = await res.json();
    if (!Array.isArray(j?.hooks)) return { hooks: [], relay: DEFAULT_RELAY };
    return { hooks: j.hooks, relay: Array.isArray(j?.relay_decisions) ? j.relay_decisions : DEFAULT_RELAY };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// 훅 실패를 게이트웨이에 보고(fire-and-forget) — 관리탭이 '이 훅이 어느 멤버 머신에서 죽는지' 보게 한다(#892 결함 C).
//  실패했을 때만 호출되므로 정상 경로 비용 0. 보고 실패는 무시한다(관측이 세션을 막아선 안 된다).
async function reportFailures(fails) {
  if (!TOKEN || !fails.length) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REPORT_MS);
  try {
    await fetch(`${GW}/api/ui/org/runner/hook-report`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ event: EVENT, harness: HARNESS || null, failures: fails }),
    });
  } catch { /* 관측은 best-effort */ }
  finally { clearTimeout(t); }
}

function saveCache(hooks, relay) {
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), hooks, relay }), { mode: 0o600 }); } catch { /* fail-open */ }
}
function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    if (!c || typeof c.at !== "number" || !Array.isArray(c.hooks)) return null;
    if (Date.now() - c.at > GRACE_MS) return null; // 만료 → fail-CLOSED(실행 안 함)
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

// 훅 소스의 모듈 타입 — 임시파일 확장자가 곧 Node 의 모듈 해석이다. CJS 소스(`require`)를 .mjs 로 쓰면
//  `require is not defined in ES module scope` 로 첫 줄에서 즉사한다(#892: spec-blind guard/tracker 가 이렇게
//  등록 이래 내내 죽어 있었다 — stdout 0바이트라 '아무 결정 안 함'과 구분되지 않았다).
//  ESM 마커(최상위 import/export)가 있으면 .mjs, 없고 CJS 마커만 있으면 .cjs, 판단 불가면 .mjs(종전 기본값 유지).
//  `.js` + Node 모듈 자동감지에 기대지 않는 이유: tmpdir 상위의 package.json `type` 에 좌우돼 비결정적이다.
const ESM_MARK = /^[ \t]*(?:import[\s{*'"]|export[\s{*])/m;
const CJS_MARK = /\brequire\s*\(|\bmodule\.exports\b|\bexports\./;
function moduleExt(src) {
  const s = String(src || "");
  if (ESM_MARK.test(s)) return "mjs";
  return CJS_MARK.test(s) ? "cjs" : "mjs";
}

// 훅 1개 실행 → { out, fail }. fail 은 관측용(#892 결함 C) — 종전엔 크래시를 통째로 삼켜(catch → "")
//  '훅이 죽음'과 '훅이 출력 없음'이 구분 불가였고, 그래서 죽은 훅이 내내 발견되지 않았다.
function runHook(hook, stdin) {
  // content_hash 무결성 — 해시가 없거나(변조 캐시) source 와 불일치면 실행 안 함(fail-CLOSED hard-gate).
  const h = crypto.createHash("sha256").update(hook.source_code || "").digest("hex");
  if (!hook.content_hash || hook.content_hash !== h) return { out: "", fail: { reason: "hash_mismatch" } };
  const tmp = join(tmpdir(), `lively-hook-${crypto.randomBytes(8).toString("hex")}.${moduleExt(hook.source_code)}`);
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
        env: { ...process.env, LIVELY_HOOK_TIMEOUT_MS: String(timeout) }, maxBuffer: 4 * 1024 * 1024,
      }), fail: null };
    } catch (e) {
      // 타임아웃/비정상 종료여도 세션을 막지 않는다(fail-open) — 부분 stdout 만 회수하고 실패는 따로 보고한다.
      const fail = {
        reason: e && e.signal === "SIGKILL" ? "timeout" : "crash",
        exit_code: e && typeof e.status === "number" ? e.status : null,
        signal: (e && e.signal) || null,
        stderr: e && e.stderr ? String(e.stderr).slice(-STDERR_KEEP) : "",
      };
      return { out: e && e.stdout ? String(e.stdout) : "", fail };
    }
  } catch (e) { return { out: "", fail: { reason: "spawn_error", stderr: String((e && e.message) || "").slice(-STDERR_KEEP) } }; }
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
function mergePreToolUse(outputs, relay) {
  let best = null; const reasons = []; const ctxs = [];
  for (const raw of outputs) {
    let j; try { j = JSON.parse(raw); } catch { continue; } // 비JSON stdout 은 PreToolUse 에서 하네스도 무시 → 버린다
    const h = j && j.hookSpecificOutput;
    if (!h || typeof h !== "object") continue;
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
  const stdin = await readStdin();
  let toolName = "";
  try { const o = JSON.parse(stdin || "{}"); toolName = o.tool_name || o.toolName || ""; } catch { /* */ }

  const fetched = await fetchHooks();
  const cfg = fetched === null ? (loadCache() || { hooks: [], relay: DEFAULT_RELAY }) : fetched; // 미도달 → grace 캐시
  if (fetched !== null) saveCache(fetched.hooks, fetched.relay);                                  // 성공 → 캐시 갱신
  const relay = cfg.relay.filter((d) => RANK[d]); // 잡값 방어
  const hooks = cfg.hooks.filter((hk) => hk && (hk.event === EVENT) && matches(hk, toolName));
  if (!hooks.length) return;

  const outputs = []; const fails = [];
  for (const hk of hooks) {
    const { out, fail } = runHook(hk, stdin);
    if (out && out.trim()) outputs.push(out.trim());
    if (fail) {
      fails.push({ hook_id: hk.id, ...fail });
      // exit 0 을 유지하므로 이 stderr 는 하네스 디버그 로그로만 간다(`claude --debug`) — 세션엔 영향 없음.
      //  훅이 실제로 뱉은 에러까지 싣는다: 게이트웨이 보고(health)가 유일한 진단 채널이면 토큰이 없거나
      //  게이트웨이가 죽었을 때 '왜 죽었는지'가 통째로 사라진다 — 그게 애초에 이 훅들이 조용히 죽어 있던 이유다.
      try {
        const why = errorHeadline(fail.stderr);
        process.stderr.write(`[lively] hook '${hk.id}' ${fail.reason}`
          + (fail.exit_code != null ? ` exit=${fail.exit_code}` : "")
          + (why ? `: ${why}` : "") + "\n");
      } catch { /* */ }
    }
  }
  if (fails.length) await reportFailures(fails);

  // PreToolUse 는 결정 이벤트 — 파싱·병합해 단일 결정 JSON 으로 전파(exit 0 + JSON stdout = 하네스 계약).
  //  훅이 죽었으면 systemMessage 로 사용자에게도 알린다(조용한 죽음 방지 — 이 이벤트는 이미 JSON 출력이라 무위험).
  if (EVENT === "PreToolUse") {
    const decision = mergePreToolUse(outputs, relay);
    const payload = decision ? { hookSpecificOutput: decision } : {};
    if (fails.length) payload.systemMessage = `Lively 커스텀 훅 실패: ${fails.map((f) => `${f.hook_id}(${f.reason})`).join(", ")}`;
    if (decision || fails.length) process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }
  // SessionStart·UserPromptSubmit 의 stdout 은 컨텍스트로 주입(둘 다 Claude 가 raw stdout 을 additionalContext 로 받는 안전 이벤트).
  //  UserPromptSubmit 주입 = #172 관련지식 자동회수(knowledge-recall) + #637 도메인 라우팅(domain-recall).
  //  PostToolUse 도 주입(#637 Stage2): 코드파일 Read 즉시 leaf 주입(domain-recall-action). emitContext 가 이벤트별 포맷
  //   (PostToolUse 는 hookSpecificOutput.additionalContext JSON — Claude Code 계약, 찰스 검증). 실행결과 없으면 no-op.
  //  나머지 이벤트(Stop·SessionEnd 등)는 여전히 부수효과만(stdout 미전파).
  if ((EVENT === "SessionStart" || EVENT === "UserPromptSubmit" || EVENT === "PostToolUse") && outputs.length) emitContext(outputs.join("\n\n"));
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
