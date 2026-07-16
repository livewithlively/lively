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

async function fetchHooks() {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const url = `${GW}/api/ui/org/runner/hooks?harness=${encodeURIComponent(HARNESS || "")}&event=${encodeURIComponent(EVENT)}`;
    const res = await fetch(url, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.hooks) ? j.hooks : [];
  } catch { return null; }
  finally { clearTimeout(t); }
}

function saveCache(hooks) {
  try { mkdirSync(LIVELY, { recursive: true }); writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), hooks }), { mode: 0o600 }); } catch { /* fail-open */ }
}
function loadCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    if (!c || typeof c.at !== "number" || !Array.isArray(c.hooks)) return null;
    if (Date.now() - c.at > GRACE_MS) return null; // 만료 → fail-CLOSED(실행 안 함)
    return c.hooks;
  } catch { return null; }
}

// 매처: PreToolUse/PostToolUse 는 stdin 의 tool_name 에 정규식 매칭. 그 외 이벤트는 매처 무시(전부 실행).
function matches(hook, toolName) {
  if (!hook.matcher) return true; // 매처 없음 = 전체(의도된 동작)
  if (EVENT !== "PreToolUse" && EVENT !== "PostToolUse") return true; // 매처 무관 이벤트
  if (!toolName) return false; // 매처 있는데 tool_name 못 읽음(truncate/비JSON) → 미실행(fail-CLOSED: 스코프 누출 방지)
  try { return new RegExp(hook.matcher).test(toolName); } catch { return false; } // 깨진 매처 → 넓히지 말고 미실행
}

function runHook(hook, stdin) {
  // content_hash 무결성 — 해시가 없거나(변조 캐시) source 와 불일치면 실행 안 함(fail-CLOSED hard-gate).
  const h = crypto.createHash("sha256").update(hook.source_code || "").digest("hex");
  if (!hook.content_hash || hook.content_hash !== h) return "";
  const tmp = join(tmpdir(), `lively-hook-${crypto.randomBytes(8).toString("hex")}.mjs`);
  try {
    writeFileSync(tmp, hook.source_code || "", { mode: 0o600 });
    const timeout = Math.min(Math.max(Number(hook.timeout_sec) || 10, 1), 120) * 1000;
    try {
      // killSignal SIGKILL — 훅이 SIGTERM 핸들러/동기 busy-loop 로 타임아웃을 살아남아 세션을 막는 것 방지(no-block 불변식).
      // LIVELY_HOOK_TIMEOUT_MS — 훅에게 **자기가 죽는 시각**을 알려준다(#905 C3). SIGKILL 은 정리 코드조차 못 돌게
      //  하므로, I/O 하는 훅은 그 전에 스스로 멈춰 결과를 남겨야 한다(project-push 의 충돌 기록이 그 예). 이 값이
      //  없으면 훅이 상한을 추측해 하드코딩하게 되고, 관리자가 timeout_sec 을 줄이는 순간 조용히 어긋난다.
      return execFileSync("node", [tmp], {
        input: stdin, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LIVELY_HOOK_TIMEOUT_MS: String(timeout) }, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      // 타임아웃/비정상 종료여도 세션을 막지 않는다(fail-open) — 부분 stdout 만 회수.
      return e && e.stdout ? String(e.stdout) : "";
    }
  } catch { return ""; }
  finally { try { rmSync(tmp, { force: true }); } catch { /* */ } }
}

async function main() {
  if (!EVENT) return;
  const stdin = await readStdin();
  let toolName = "";
  try { const o = JSON.parse(stdin || "{}"); toolName = o.tool_name || o.toolName || ""; } catch { /* */ }

  let hooks = await fetchHooks();
  if (hooks === null) hooks = loadCache() || []; // 게이트웨이 미도달 → grace 캐시(만료면 [])
  else saveCache(hooks);                          // 성공 → 캐시 갱신
  hooks = hooks.filter((hk) => hk && (hk.event === EVENT) && matches(hk, toolName));
  if (!hooks.length) return;

  const outputs = [];
  for (const hk of hooks) {
    const out = runHook(hk, stdin);
    if (out && out.trim()) outputs.push(out.trim());
  }
  // SessionStart·UserPromptSubmit 의 stdout 은 컨텍스트로 주입(둘 다 Claude 가 raw stdout 을 additionalContext 로 받는 안전 이벤트).
  //  UserPromptSubmit 주입 = #172 관련지식 자동회수(knowledge-recall) + #637 도메인 라우팅(domain-recall).
  //  PostToolUse 도 주입(#637 Stage2): 코드파일 Read 즉시 leaf 주입(domain-recall-action). emitContext 가 이벤트별 포맷
  //   (PostToolUse 는 hookSpecificOutput.additionalContext JSON — Claude Code 계약, 찰스 검증). 실행결과 없으면 no-op.
  //  나머지 이벤트(Stop·PreToolUse 등)는 여전히 부수효과만(stdout 미전파).
  if ((EVENT === "SessionStart" || EVENT === "UserPromptSubmit" || EVENT === "PostToolUse") && outputs.length) emitContext(outputs.join("\n\n"));
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
