// run-custom 러너 시험 하네스 — kit/hooks/run-custom.test.mjs 와 run-custom-cost.test.mjs 가 함께 쓴다(테스트 전용).
//  #5034 에서 run-custom.test.mjs 에서 그대로 옮겼다: 시험이 늘어 한 파일이 CI 의 유닛 파일 예산(scripts/run-tests.mjs
//   --budget=45)을 넘어서 파일을 나눴고, 두 파일이 같은 하네스를 써야 같은 계약을 본다.
//  오프라인·fs-only: 샌드박스 HOME/LIVELY_HOME 의 로컬 캐시(custom-hooks-<Event>.json)에 훅을 심고
//  러너를 실제 프로세스로 띄운다(토큰 부재 → 게이트웨이 미도달 → 캐시 폴백). 실제 ~/.lively 무접촉.
//  모듈 상태(샌드박스·통과/실패 수)는 시험 파일 프로세스마다 하나다 — run-tests 가 파일마다 프로세스를 띄운다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "./os-sandbox.mjs";

// RUN_CUSTOM_TEST_RUNNER — 같은 시험을 다른 판의 러너(예: 변경 전 판)에 돌려 빨간불을 먼저 보려고 둔 자리(fail-first).
export const RUNNER = process.env.RUN_CUSTOM_TEST_RUNNER || join(fileURLToPath(import.meta.url), "..", "..", "hooks", "run-custom.mjs");
export const SANDBOX = mkdtempSync(join(tmpdir(), "run-custom-test-"));
export const HOME = join(SANDBOX, "home");
export const TMP = join(SANDBOX, "tmp");
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });

// 게이트웨이에 닿을 수 없는 구성원 머신을 재현한다 — 토큰/URL 이 없어야 러너가 로컬 캐시(우리가 심은 훅)로 폴백한다.
export const ENV = { ...process.env, ...offlineLivelyEnv(), HOME, LIVELY_HOME: HOME, TMPDIR: TMP, LIVELY_OFF: "", LIVELY_HOOKS_OFF: "" };
delete ENV.LIVELY_TOKEN;
delete ENV.LIVELY_GATEWAY_URL;

let pass = 0, fail = 0;
export const ok = (name) => { pass++; console.log(`ok  ${name}`); };
export const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const PRE_PAYLOAD = { session_id: "s1", tool_name: "Write", tool_input: { file_path: "/x/a.test.ts", content: "x" } };

// 캐시에 훅을 심고 러너를 실제 프로세스로 실행한다.
//  · relay 를 생략하면 캐시에 relay 키 자체가 없다 = "정책 미지" → 기본 정책 경로를 탄다(§D).
//  · execFileSync 는 반환값이 stdout 뿐이라 exit code(§E)와 진단 stderr(§F)를 함께 관측할 수 없다 → spawnSync 를 쓴다
//    (같은 node:child_process 의 동기 실행, 여전히 진짜 자식 프로세스).
export function run(event, hooks, { relay, concurrent, runtime, payload, timeoutMs = 20000, cacheAgeMs = 0, graceMs, token, gatewayUrl, env: extraEnv } = {}) {
  const cache = {
    at: Date.now() - cacheAgeMs, // 기본 0 = 지금. cacheAgeMs 로 '오래된 캐시'를 재현한다(#1008 grace 테스트)
    hooks: hooks.map((h) => ({
      id: h.id,
      event,
      matcher: h.matcher ?? null,
      timeout_sec: h.timeout_sec ?? 5,
      ...(h.sort !== undefined ? { sort: h.sort } : {}), // 생략 = 구버전 게이트웨이 응답(§W3)
      ...(h.seed !== undefined ? { seed: h.seed } : {}), // 제품 시드 훅인가(§Y). 생략 = 구 게이트웨이 응답 = 직접 만든 훅
      source_code: h.src,
      content_hash: h.hash ?? sha256(h.src), // §G: 기본은 정상 해시, 변조 시나리오만 h.hash 로 어긴다
    })),
  };
  if (relay !== undefined) cache.relay = relay;
  // concurrent — 조직의 동시 실행 설정(게이트웨이 응답과 함께 캐시된다). 생략 = 구 캐시·꺼짐(종전처럼 하나씩, §W0).
  if (concurrent !== undefined) cache.concurrent = concurrent;
  // runtime — 조직의 실행 방식(run-custom-cost §R). 생략 = 구 캐시 = 기본(스레드).
  if (runtime !== undefined) cache.runtime = runtime;
  writeFileSync(join(HOME, ".lively", `custom-hooks-${event.replace(/[^A-Za-z]/g, "")}.json`), JSON.stringify(cache));
  // hook_grace_ms(#1008) — graceMs 를 주면 hooks-config.json 에 심어 캐시 유효기간을 정하고, 안 주면 파일을 지워
  //  '무제한(기본)' 경로를 재현한다(같은 HOME 재사용이라 직전 테스트가 남긴 값이 새지 않게 매번 명시).
  const hcfg = join(HOME, ".lively", "hooks-config.json");
  if (graceMs !== undefined) writeFileSync(hcfg, JSON.stringify({ hook_grace_ms: graceMs }));
  else { try { rmSync(hcfg, { force: true }); } catch { /* 없으면 무시 */ } }
  // 기본은 무토큰/무URL(게이트웨이 미도달 → 캐시 폴백). token+gatewayUrl 을 주면 실제 fetch 를 시도하게 해
  //  '온라인처럼 시도하다 매달리는 오프라인'(도달불가 게이트웨이)을 재현한다(#1039 §J).
  const env = { ...ENV, ...(extraEnv || {}) };
  if (token !== undefined) env.LIVELY_TOKEN = token;
  if (gatewayUrl !== undefined) env.LIVELY_GATEWAY_URL = gatewayUrl;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RUNNER, event], {
    input: JSON.stringify(payload ?? PRE_PAYLOAD),
    env,
    encoding: "utf8",
    timeout: timeoutMs, // 러너가 매달려도 테스트 자체는 끝나야 한다(그 경우 status=null 로 FAIL 이 뜬다)
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", elapsed: Date.now() - t0 };
}

// 러너가 하네스에 준 답(hookSpecificOutput). 출력이 아예 없으면 null = "전달할 것 없음".
export function answer(r) {
  const s = r.stdout.trim();
  if (!s) return null;
  try { return JSON.parse(s).hookSpecificOutput ?? null; } catch { return { __raw: s }; }
}
// 러너가 하네스에 실제로 넘긴 결정값. 출력 없음·결정 없음·파싱 불가 모두 undefined(= 하네스는 아무 결정도 못 본다).
export const decisionOf = (r) => answer(r)?.permissionDecision;
export const dbg = (r) => `status=${r.status} signal=${r.signal} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.slice(0, 400))}`;

// 하네스 계약(외부 규격) 그대로의 JSON 한 덩어리를 stdout 에 쓰는 최소 훅. CJS/ESM 어느 쪽으로 실행돼도 동작한다.
export function decide({ decision, reason, ctx }) {
  const o = { hookEventName: "PreToolUse" };
  if (decision !== undefined) o.permissionDecision = decision;
  if (reason !== undefined) o.permissionDecisionReason = reason;
  if (ctx !== undefined) o.additionalContext = ctx;
  return `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: o }))});\n`;
}


// ── §W 실행 순서 시험용 조각(랑데부·순서 로그) ──
export const UPS = { session_id: "s1", prompt: "안녕" };
export const wDir = (name) => { const d = join(SANDBOX, `w-${name}`); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
// 동기 sleep — CJS/ESM 어느 쪽으로 실행돼도 동작하고 이벤트루프 없이 정확히 기다린다.
export const sleepSrc = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`;
export const sayHook = (text) => `process.stdout.write(${JSON.stringify(text)});\n`;
// 랑데부 훅: 내 표식을 남기고 상대 표식을 waitMs 까지 기다린 뒤 "<me>:SAW " / "<me>:ALONE " 를 낸다.
export const meet = (dir, me, other, waitMs) => 'const fs = require("node:fs"); const path = require("node:path");\n'
  + `fs.writeFileSync(path.join(${JSON.stringify(dir)}, ${JSON.stringify(me)}), "1");\n`
  + `const end = Date.now() + ${waitMs}; let saw = false;\n`
  + `while (Date.now() < end) { if (fs.existsSync(path.join(${JSON.stringify(dir)}, ${JSON.stringify(other)}))) { saw = true; break; } `
  + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }\n'
  + `process.stdout.write(${JSON.stringify(me)} + (saw ? ":SAW " : ":ALONE "));\n`;
// 실행 순서 로그: (선택적으로 잠깐 잔 뒤) 자기 id 를 공용 로그에 덧붙인다.
export const logHook = (log, id, delayMs = 0) => 'const fs = require("node:fs");\n'
  + (delayMs ? sleepSrc(delayMs) : "")
  + `fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(id + "\n")});\n`;
export const readLog = (log) => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).join(","); } catch { return ""; } };
// 출력 안에서 a 가 b 보다 앞에 있나(둘 다 있어야 참).
export const before = (s, a, b) => s.includes(a) && s.includes(b) && s.indexOf(a) < s.indexOf(b);

// 샌드박스를 치우고 결과를 찍고 실패가 있으면 1 로 끝낸다 — 시험 파일의 마지막 줄.
export function finish(label) {
  rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`${label} tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
  process.exit(fail ? 1 : 0);
}
