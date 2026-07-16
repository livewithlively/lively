#!/usr/bin/env node
// run-custom 러너 사양테스트 — PreToolUse 도구 게이트의 '결정 전파' 계약을 고정한다.
//  오프라인·fs-only: 샌드박스 HOME/LIVELY_HOME 의 로컬 캐시(custom-hooks-<Event>.json)에 훅을 심고
//  러너를 실제 프로세스로 띄운다(토큰 부재 → 게이트웨이 미도달 → 캐시 폴백). 실제 ~/.lively 무접촉.
//  실행: node kit/hooks/run-custom.test.mjs
//
//  왜 이 테스트가 있나(#892): 러너는 하네스 눈에 **훅 하나**다 — 관리자 훅이 여럿이어도 러너가 대표해 하나의 응답을 낸다.
//  그 대표 응답이 전달되지 않으면 관리자는 "게이트를 걸었다"고 믿는데 도구는 그냥 통과한다(무음 실패).
//  ⚠ 최우선 불변식 = **러너는 무슨 일이 있어도 exit 0**(세션 불가침). 그 다음이 결정 전파·병합·정책이다.
//  ⚠ 사양은 훅↔러너 사이의 payload 전달 규약을 정하지 않는다 → 여기 테스트 훅들은 stdin 을 읽지 않는다
//    (미규정 규약에 테스트가 기대면, 사양이 아니라 구현을 고정하는 테스트가 된다).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RUNNER = join(fileURLToPath(import.meta.url), "..", "run-custom.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "run-custom-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });

// 게이트웨이에 닿을 수 없는 구성원 머신을 재현한다 — 토큰/URL 이 없어야 러너가 로컬 캐시(우리가 심은 훅)로 폴백한다.
const ENV = { ...process.env, HOME, LIVELY_HOME: HOME, TMPDIR: TMP, LIVELY_OFF: "", LIVELY_HOOKS_OFF: "" };
delete ENV.LIVELY_TOKEN;
delete ENV.LIVELY_GATEWAY_URL;

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const PRE_PAYLOAD = { session_id: "s1", tool_name: "Write", tool_input: { file_path: "/x/a.test.ts", content: "x" } };

// 캐시에 훅을 심고 러너를 실제 프로세스로 실행한다.
//  · relay 를 생략하면 캐시에 relay 키 자체가 없다 = "정책 미지" → 기본 정책 경로를 탄다(§D).
//  · execFileSync 는 반환값이 stdout 뿐이라 exit code(§E)와 진단 stderr(§F)를 함께 관측할 수 없다 → spawnSync 를 쓴다
//    (같은 node:child_process 의 동기 실행, 여전히 진짜 자식 프로세스).
function run(event, hooks, { relay, payload, timeoutMs = 20000 } = {}) {
  const cache = {
    at: Date.now(), // 오래된 캐시는 무시되므로 항상 '지금'으로 심는다
    hooks: hooks.map((h) => ({
      id: h.id,
      event,
      matcher: h.matcher ?? null,
      timeout_sec: h.timeout_sec ?? 5,
      source_code: h.src,
      content_hash: h.hash ?? sha256(h.src), // §G: 기본은 정상 해시, 변조 시나리오만 h.hash 로 어긴다
    })),
  };
  if (relay !== undefined) cache.relay = relay;
  writeFileSync(join(HOME, ".lively", `custom-hooks-${event.replace(/[^A-Za-z]/g, "")}.json`), JSON.stringify(cache));
  const r = spawnSync(process.execPath, [RUNNER, event], {
    input: JSON.stringify(payload ?? PRE_PAYLOAD),
    env: ENV,
    encoding: "utf8",
    timeout: timeoutMs, // 러너가 매달려도 테스트 자체는 끝나야 한다(그 경우 status=null 로 FAIL 이 뜬다)
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 러너가 하네스에 준 답(hookSpecificOutput). 출력이 아예 없으면 null = "전달할 것 없음".
function answer(r) {
  const s = r.stdout.trim();
  if (!s) return null;
  try { return JSON.parse(s).hookSpecificOutput ?? null; } catch { return { __raw: s }; }
}
// 러너가 하네스에 실제로 넘긴 결정값. 출력 없음·결정 없음·파싱 불가 모두 undefined(= 하네스는 아무 결정도 못 본다).
const decisionOf = (r) => answer(r)?.permissionDecision;
const dbg = (r) => `status=${r.status} signal=${r.signal} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.slice(0, 400))}`;

// 하네스 계약(외부 규격) 그대로의 JSON 한 덩어리를 stdout 에 쓰는 최소 훅. CJS/ESM 어느 쪽으로 실행돼도 동작한다.
function decide({ decision, reason, ctx }) {
  const o = { hookEventName: "PreToolUse" };
  if (decision !== undefined) o.permissionDecision = decision;
  if (reason !== undefined) o.permissionDecisionReason = reason;
  if (ctx !== undefined) o.additionalContext = ctx;
  return `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: o }))});\n`;
}

// ── §A 훅 언어 중립성 ──
// 관리자는 CJS 로도 ESM 으로도 훅을 쓴다. 한쪽이 실행조차 안 되면 "활성이라 믿는데 아무 일도 안 일어나는" 상태가 된다
// — 게이트가 없는 것보다 나쁘다(있다고 믿으니까). 아래 두 훅은 require/import 결과를 사유에 박아 실행을 증명한다.
{
  const src = 'const path = require("node:path");\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"cjs:"+path.basename("/tmp/cjs-ran.txt")}}));\n';
  const r = run("PreToolUse", [{ id: "cjs-hook", src }]);
  const a = answer(r);
  a?.permissionDecision === "deny" && a?.permissionDecisionReason === "cjs:cjs-ran.txt"
    ? ok("A1 CJS(require) 훅이 실제로 실행되고 결정이 나온다")
    : bad("A1 CJS 훅 실행", dbg(r));
}
{
  const src = 'import path from "node:path";\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"esm:"+path.basename("/tmp/esm-ran.txt")}}));\n';
  const r = run("PreToolUse", [{ id: "esm-hook", src }]);
  const a = answer(r);
  a?.permissionDecision === "deny" && a?.permissionDecisionReason === "esm:esm-ran.txt"
    ? ok("A2 ESM(import) 훅이 실제로 실행되고 결정이 나온다")
    : bad("A2 ESM 훅 실행", dbg(r));
}

// ── §B 결정 전달 ──
// deny 의 사유는 AI 가 읽고 행동을 고치는 유일한 단서다 — 잘리거나 뭉개지면 AI 는 왜 막혔는지 모른 채 재시도한다.
{
  const reason = "세션 첫 테스트 파일이다 — 사양을 먼저 확인해라 (#892)";
  const r = run("PreToolUse", [{ id: "deny-hook", src: decide({ decision: "deny", reason }) }]);
  const a = answer(r);
  a?.hookEventName === "PreToolUse" && a?.permissionDecision === "deny" && a?.permissionDecisionReason === reason
    ? ok("B1 deny 결정과 사유가 하네스 규격 그대로 전달된다")
    : bad("B1 deny 전달", dbg(r));
}
// 훅이 아무 말도 안 했으면 러너도 침묵해야 한다 — 빈 껍데기를 뱉으면 하네스가 의미 없는 결정을 파싱하게 된다.
{
  const r = run("PreToolUse", [{ id: "silent-hook", src: "// 아무 결정도 내지 않는다\n" }]);
  r.stdout.trim() === "" && r.status === 0
    ? ok("B2 결정 없음 → 러너도 무출력(도구 정상 진행)")
    : bad("B2 무결정 무출력", dbg(r));
}

// ── §C 여러 훅의 병합 ──
// 정책(§D)이 병합 판정을 가리지 않도록 여기선 relay 를 네 값 모두 켠다 — 이 블록이 보는 건 '가장 제한적인 것이 이긴다' 하나다.
const ALL = ["deny", "ask", "defer", "allow"];
{
  // deny 를 마지막에 둔다 — '먼저 나온 결정이 이긴다'류의 구현이면 allow 가 새어 나가 여기서 잡힌다.
  const r = run("PreToolUse", [
    { id: "c1-allow", src: decide({ decision: "allow", reason: "allow-r" }) },
    { id: "c1-ask", src: decide({ decision: "ask", reason: "ask-r" }) },
    { id: "c1-defer", src: decide({ decision: "defer", reason: "defer-r" }) },
    { id: "c1-deny", src: decide({ decision: "deny", reason: "deny-r" }) },
  ], { relay: ALL });
  decisionOf(r) === "deny" ? ok("C1 deny 가 defer·ask·allow 를 이긴다") : bad("C1 deny 우선", dbg(r));
}
{
  // defer 를 처음에 둔다 — '나중에 나온 결정이 덮어쓴다'류면 allow 로 뒤집혀 여기서 잡힌다(C1 과 반대 방향).
  const r = run("PreToolUse", [
    { id: "c2-defer", src: decide({ decision: "defer", reason: "defer-r" }) },
    { id: "c2-ask", src: decide({ decision: "ask", reason: "ask-r" }) },
    { id: "c2-allow", src: decide({ decision: "allow", reason: "allow-r" }) },
  ], { relay: ALL });
  decisionOf(r) === "defer" ? ok("C2 defer 가 ask·allow 를 이긴다") : bad("C2 defer 우선", dbg(r));
}
{
  const r = run("PreToolUse", [
    { id: "c3-allow", src: decide({ decision: "allow", reason: "allow-r" }) },
    { id: "c3-ask", src: decide({ decision: "ask", reason: "ask-r" }) },
  ], { relay: ALL });
  decisionOf(r) === "ask" ? ok("C3 ask 가 allow 를 이긴다") : bad("C3 ask 우선", dbg(r));
}
{
  // 결정에서 진 훅의 부가맥락까지 모두 살아야 한다 — 맥락은 결정과 별개 채널이다.
  // 여기서 버리면 "왜 막혔나"의 절반을 AI 가 못 본 채 재시도한다.
  const r = run("PreToolUse", [
    { id: "c4-allow", src: decide({ decision: "allow", ctx: "CTX-FROM-ALLOW" }) },
    { id: "c4-deny", src: decide({ decision: "deny", reason: "blocked", ctx: "CTX-FROM-DENY" }) },
  ], { relay: ALL });
  const a = answer(r);
  const ctx = a?.additionalContext ?? "";
  // 연결 형식(구분자)은 사양이 정하지 않는다 → 필드는 additionalContext 로 고정하고 '둘 다 살아있음'만 본다.
  a?.permissionDecision === "deny" && ctx.includes("CTX-FROM-ALLOW") && ctx.includes("CTX-FROM-DENY")
    ? ok("C4 결정에서 진 훅의 부가맥락도 하나도 안 버린다")
    : bad("C4 맥락 보존", dbg(r));
}

// ── §D 전파 정책(조직 설정) ──
{
  // 정책에 없는 결정값은 훅이 내더라도 효과가 없다 — 훅은 돌지만 결정은 무시된다.
  const r = run("PreToolUse", [{ id: "d1-deny", src: decide({ decision: "deny", reason: "should-not-reach-harness" }) }],
    { relay: ["ask"] });
  decisionOf(r) === undefined && r.status === 0
    ? ok("D1 정책에 없는 결정값(deny)은 전파되지 않는다")
    : bad("D1 정책 필터", dbg(r));
}
{
  // 정책이 결정을 걷어내도 그 훅의 부가맥락은 살아야 한다 — 관리자의 '막진 말되 알려는 주기'가 여기서만 가능하다.
  const r = run("PreToolUse", [{ id: "d2-deny-ctx", src: decide({ decision: "deny", reason: "R", ctx: "CTX-SURVIVES-POLICY" }) }],
    { relay: ["ask"] });
  const a = answer(r);
  a?.permissionDecision === undefined && (a?.additionalContext ?? "").includes("CTX-SURVIVES-POLICY")
    ? ok("D2 정책에 걸러진 훅의 부가맥락은 그래도 전달된다")
    : bad("D2 걸러진 훅의 맥락", dbg(r));
}
{
  // 정책을 알 수 없을 때(게이트웨이가 안 알려줌)의 기본값 = deny·ask·defer.
  // 이 셋 중 하나라도 기본에서 빠지면 게이트웨이가 잠깐 흔들린 동안 관리자 게이트가 통째로 무력해진다.
  for (const d of ["deny", "ask", "defer"]) {
    const r = run("PreToolUse", [{ id: `d3-${d}`, src: decide({ decision: d, reason: `${d}-reason` }) }]); // relay 키 없음
    decisionOf(r) === d
      ? ok(`D3 정책 미지 → 기본값에 ${d} 포함(전파됨)`)
      : bad(`D3 기본값 ${d}`, dbg(r));
  }
}
{
  // allow 는 기본에서 **빠져 있어야** 한다 — allow 가 새면 구성원의 권한 확인 화면이 조용히 사라진다.
  // 정책을 못 받아온 상황(=관리자 의사 불명)에서 권한 확인을 건너뛰는 건 실패 방향이 가장 나쁘다.
  const r = run("PreToolUse", [{ id: "d4-allow", src: decide({ decision: "allow", reason: "auto-approved" }) }]);
  decisionOf(r) === undefined && r.status === 0
    ? ok("D4 정책 미지 → allow 는 기본에서 빠져 전파되지 않는다")
    : bad("D4 allow 기본 제외", dbg(r));
}
{
  // 반대로 관리자가 명시하면 allow 도 나가야 한다 — 정책은 하드코딩이 아니라 조직 설정이다(D4 가 '항상 막기'로 구현되면 여기서 잡힌다).
  const r = run("PreToolUse", [{ id: "d5-allow", src: decide({ decision: "allow", reason: "admin-opted-in" }) }],
    { relay: ALL });
  decisionOf(r) === "allow"
    ? ok("D5 관리자가 명시적으로 켜면 allow 도 전파된다")
    : bad("D5 allow 명시 허용", dbg(r));
}

// ── §E 세션 불가침(최우선 불변식) ──
{
  // deny 를 전파할 때조차 exit 0 이어야 한다. 결정은 stdout JSON 으로만 말한다 —
  // exit code 로 말하는 순간 하네스 계약 위반이고, 같은 러너에 실린 다른 훅의 출력까지 함께 죽는다.
  const r = run("PreToolUse", [{ id: "e1-deny", src: decide({ decision: "deny", reason: "R" }) }]);
  r.status === 0 ? ok("E1 deny 를 전파해도 러너는 exit 0") : bad("E1 deny exit 0", dbg(r));
}
{
  // 훅이 런타임에 죽어도 세션은 계속된다. 그리고 죽었다는 사실은 진단 채널로 드러나야 한다(§F).
  const r = run("PreToolUse", [{ id: "boom-hook", src: 'throw new Error("kaboom-42");\n' }]);
  r.status === 0 ? ok("E2 훅이 죽어도 러너는 exit 0") : bad("E2 크래시 exit 0", dbg(r));
  decisionOf(r) === undefined ? ok("E2b 죽은 훅은 아무 결정도 내지 못한다") : bad("E2b 크래시 무결정", dbg(r));
  r.stderr.includes("boom-hook")
    ? ok("F1 죽은 훅의 id 가 진단 채널에 드러난다")
    : bad("F1 훅 id 노출", `stderr=${JSON.stringify(r.stderr)}`);
  // §F "진단 채널로 훅 id 와 **실패 사유**가 나온다" 를 '훅이 왜 죽었는지'로 읽은 검사다.
  //  이웃 문장("죽었다 vs 무결정 이 구분되어야")이 이미 '실패 사실'을 요구하므로, 실패 *사유* 는 그보다 더한 것 —
  //  즉 훅이 뱉은 에러 그 자체 — 을 뜻한다고 본다. 종료코드만 남으면 관리자는 어느 훅이 죽었는지는 알아도 왜인지는 영영 모른다.
  //  ⚠ '사유 = 실패 양태(crash/timeout/해시불일치)' 로 읽는 것도 가능하다. 그 해석을 택한다면 이 한 줄을 완화하면 된다.
  r.stderr.includes("kaboom-42")
    ? ok("F2 실패 사유(훅이 뱉은 에러)가 진단 채널에 드러난다")
    : bad("F2 실패 사유 노출", `훅의 에러 텍스트가 삼켜졌다. stderr=${JSON.stringify(r.stderr)}`);
}
{
  // 문법오류는 런타임 throw 와 죽는 지점이 다르다(파싱 단계). 여기서도 세션은 안 막힌다.
  const r = run("PreToolUse", [{ id: "syntax-hook", src: "function ( { <<< 이건 문법오류다\n" }]);
  r.status === 0 && decisionOf(r) === undefined
    ? ok("E3 훅이 문법오류여도 러너는 exit 0")
    : bad("E3 문법오류 exit 0", dbg(r));
}
{
  // 매달린 훅이 세션을 인질로 잡으면 안 된다 — timeout_sec 안에 손 떼고 exit 0.
  // '절대 세션을 막지 않는다'는 exit code 뿐 아니라 **시간**의 문제이기도 하다.
  const late = decide({ decision: "deny", reason: "너무 늦게 온 결정" });
  const src = 'const end = Date.now() + 12000; while (Date.now() < end) {}\n' + late;
  const t0 = Date.now();
  const r = run("PreToolUse", [{ id: "hang-hook", timeout_sec: 1, src }], { timeoutMs: 9000 });
  const ms = Date.now() - t0;
  r.status === 0 && ms < 6000
    ? ok("E4 매달린 훅은 timeout_sec 에 끊기고 러너는 제때 exit 0")
    : bad("E4 타임아웃", `${dbg(r)} ms=${ms}`);
  decisionOf(r) === undefined
    ? ok("E4b 끊긴 훅의 늦은 출력은 결정이 되지 않는다")
    : bad("E4b 늦은 결정", dbg(r));
}

// ── §F 실패는 드러나야 한다 (F1·F2 는 E2 블록에서 함께 관측) ──
{
  // "죽었다"와 "아무 결정도 안 했다"는 구분돼야 한다 — 조용한 훅은 실패로 보고되면 안 된다.
  // (반대로 F1 에선 같은 채널에 훅 id 가 떠야 했다. 둘을 붙여야 '구분 가능'이 증명된다.)
  const r = run("PreToolUse", [{ id: "quiet-hook", src: "// 정상 종료, 그러나 할 말 없음\n" }]);
  !r.stderr.includes("quiet-hook") && r.status === 0
    ? ok("F3 무결정 훅은 실패로 보고되지 않는다(죽음 ≠ 무결정)")
    : bad("F3 무결정≠실패", dbg(r));
}

// ── §G 무결성 ──
// sentinel 파일로 '실제로 코드가 돌았는가'를 직접 관측한다 — '결정이 안 나왔다'로는 미실행을 증명하지 못한다
// (필터에 걸렸을 수도, 죽었을 수도 있으니까).
const STAMP = join(SANDBOX, "g-executed");
const stampSrc = 'import { writeFileSync } from "node:fs";\n'
  + `writeFileSync(${JSON.stringify(STAMP)}, "ran");\n`
  + decide({ decision: "deny", reason: "integrity-probe" });
{
  rmSync(STAMP, { force: true });
  const r = run("PreToolUse", [{ id: "hash-ok-hook", src: stampSrc }]);
  existsSync(STAMP) && decisionOf(r) === "deny"
    ? ok("G1 해시가 맞으면 훅이 실행된다(대조군)")
    : bad("G1 정상 해시 실행", `stamp=${existsSync(STAMP)} ${dbg(r)}`);
}
{
  // 본문과 해시가 어긋났다 = 누군가 코드를 바꿔치기했다는 뜻 → 실행 자체를 하지 않는다. 그래도 세션은 안 막는다.
  rmSync(STAMP, { force: true });
  const r = run("PreToolUse", [{ id: "tampered-hook", src: stampSrc, hash: sha256(stampSrc + " // tampered") }]);
  !existsSync(STAMP) && decisionOf(r) === undefined && r.status === 0
    ? ok("G2 해시 불일치 훅은 실행조차 되지 않는다(세션은 유지)")
    : bad("G2 변조 차단", `stamp=${existsSync(STAMP)} ${dbg(r)}`);
}

// ── §H 다른 이벤트 무영향 ──
{
  // PostToolUse 는 종전대로 여러 훅의 출력을 이어붙여 낸다. PreToolUse 게이트를 얹으면서
  // 이 경로가 조용히 바뀌면 기존 컨텍스트 주입이 통째로 증발한다(가장 넓은 회귀 표면).
  // relay 키를 생략(정책 미지)해도 이 이벤트의 텍스트는 정책과 무관하게 나가야 한다.
  const r = run("PostToolUse", [
    { id: "post-1", src: 'process.stdout.write("POST-ALPHA");\n' },
    { id: "post-2", src: 'process.stdout.write("POST-BETA");\n' },
  ], { payload: { session_id: "s1", tool_name: "Write", tool_input: {}, tool_response: {} } });
  r.status === 0 && r.stdout.includes("POST-ALPHA") && r.stdout.includes("POST-BETA")
    ? ok("H1 PostToolUse 는 여러 훅 출력을 모두 이어붙여 전달한다")
    : bad("H1 PostToolUse 무영향", dbg(r));
}
{
  // 세션 부팅·프롬프트 주입 경로도 그대로여야 한다 — 이벤트 분기에서 빠지면 조용히 컨텍스트가 사라진다.
  for (const [ev, payload] of [
    ["SessionStart", { session_id: "s1", source: "startup" }],
    ["UserPromptSubmit", { session_id: "s1", prompt: "안녕" }],
  ]) {
    const r = run(ev, [{ id: `${ev}-1`, src: `process.stdout.write("CTX-${ev}");\n` }], { payload });
    r.status === 0 && r.stdout.includes(`CTX-${ev}`)
      ? ok(`H2 ${ev} 컨텍스트 주입은 그대로다`)
      : bad(`H2 ${ev} 무영향`, dbg(r));
  }
}

// ── 엣지 ──
{
  // JSON 아닌 일반 텍스트는 결정이 아니다. 본문에 일부러 "deny" 를 넣어 뒀다 —
  // 문자열 매칭으로 결정을 읽는 구현이면 관리자가 의도한 적 없는 게이트가 걸린다.
  const r = run("PreToolUse", [{ id: "chatty-hook", src: 'process.stdout.write("deny this please — 그냥 로그입니다");\n' }]);
  decisionOf(r) === undefined && r.status === 0
    ? ok("X1 JSON 아닌 텍스트는 결정으로 취급하지 않는다")
    : bad("X1 텍스트≠결정", dbg(r));
  // 사양의 "(무시)" — PreToolUse 응답은 하네스 규격 JSON 이어야 하므로 훅의 생 텍스트가 새면 안 된다.
  //  ⚠ '무출력' 이 아니라 '생 텍스트 미유출' 을 단언한다: 사양 §F 가 "하네스가 무시할 출력도 실패다" 라
  //   요구하므로, 러너는 이 경우 (결정이 아니라) 실패 알림을 규격 JSON 으로 낼 수 있다. 결정이 안 걸리는 것과
  //   생 텍스트가 안 새는 것 둘 다 지키면 사양을 만족한다.
  //  훅 id 가 뜨는 것까지 함께 본다 — '어딘가 안전한 데 떨어졌다'가 아니라 F4 와 **같은 bad_output 경로**로
  //  흘렀음을 적극 확인한다(그래야 이 단언이 무르지 않다).
  let wellFormed = true;
  try { if (r.stdout.trim()) JSON.parse(r.stdout.trim()); } catch { wellFormed = false; }
  wellFormed && !r.stdout.includes("deny this please") && r.stdout.includes("chatty-hook")
    ? ok("X1b JSON 아닌 텍스트는 하네스로 새지 않는다(무시 — 단, 실패로는 드러난다)")
    : bad("X1b 텍스트 무시", dbg(r));
}
{
  // 알 수 없는 결정값은 무시한다 — 그대로 흘려보내면 하네스가 규격 밖 값을 받는다(무슨 짓을 할지는 우리 소관이 아니다).
  const r = run("PreToolUse", [{ id: "weird-hook", src: decide({ decision: "maybe", reason: "누가 알겠나" }) }]);
  decisionOf(r) === undefined && r.status === 0
    ? ok("X2 알 수 없는 결정값(maybe)은 무시된다")
    : bad("X2 미지 결정값", dbg(r));
}
{
  // 같은 deny 를 둘이 냈으면 사유가 둘 다 남는 편이 낫다 — 하나만 남기면 사용자는 나머지 이유를 영영 모른 채
  // 첫 번째 사유만 고치고 다시 막힌다.
  const r = run("PreToolUse", [
    { id: "x3-deny-1", src: decide({ decision: "deny", reason: "REASON-ONE" }) },
    { id: "x3-deny-2", src: decide({ decision: "deny", reason: "REASON-TWO" }) },
  ]);
  const a = answer(r);
  const why = a?.permissionDecisionReason ?? "";
  a?.permissionDecision === "deny" && why.includes("REASON-ONE") && why.includes("REASON-TWO")
    ? ok("X3 같은 deny 를 여럿이 내면 사유가 모두 보존된다")
    : bad("X3 동일 결정 사유 보존", dbg(r));
}

// ── §A 회귀 방어 — 모듈 타입 분류가 '코드가 아닌 것'에 속으면 안 된다 (적대검증에서 나온 실제 회귀) ──
// 분류는 휴리스틱이라 틀릴 수 있는데, **틀린 대가가 훅 사망**이면 안 된다. 아래 넷은 전부 실제로 깨졌던/깨질
// 수 있는 모양이다. 특히 ①은 이 변경 이전(항상 .mjs)엔 멀쩡히 돌던 훅이라, 못 잡으면 순수 회귀다.
{
  // ① 주석 속 require( 때문에 CJS 로 오분류 → top-level await 이 SyntaxError. '어제 되던 훅이 오늘 죽는다'.
  const src = '// TODO: replace legacy require(...) calls with imports\n'
    + 'const r = await Promise.resolve("ok");\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"tla:"+r}}));\n';
  const r = run("PreToolUse", [{ id: "tla-comment-hook", src }]);
  answer(r)?.permissionDecisionReason === "tla:ok"
    ? ok("A3 주석 속 require( 가 ESM 훅을 CJS 로 오분류하지 않는다")
    : bad("A3 주석 오분류", dbg(r));
}
{
  // ② 반대 함정 — 주석만 지우면 문자열 속 "http://…" 가 줄 주석으로 보여 뒤의 진짜 require 를 먹어치운다
  //    → ESM 으로 오분류 → #892 원래 버그가 그대로 부활한다. 문자열을 먼저 소비해야만 통과한다.
  const src = 'const url = "http://example.com/x";\n'
    + 'const path = require("node:path");\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"cjs:"+path.basename(url)}}));\n';
  const r = run("PreToolUse", [{ id: "url-string-hook", src }]);
  answer(r)?.permissionDecisionReason === "cjs:x"
    ? ok("A4 문자열 속 // URL 이 CJS 훅을 ESM 으로 오분류하지 않는다")
    : bad("A4 URL 문자열 오분류", dbg(r));
}
{
  // ③ 분류가 그래도 틀리는 변두리(실행되지 않는 require + ESM 전용 문법) — 파싱 단계 실패는 본문이 한 줄도
  //    안 돌았다는 뜻이라, 반대 확장자로 한 번 되돌려 살려낸다. 오분류의 대가가 사망이면 안 된다.
  const src = 'const r = await Promise.resolve(1);\n'
    + 'if (false) { require("node:fs"); }\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"rescued:"+r}}));\n';
  const r = run("PreToolUse", [{ id: "ambiguous-hook", src }]);
  answer(r)?.permissionDecisionReason === "rescued:1"
    ? ok("A5 분류가 틀려도 파싱 실패면 반대 확장자로 자가교정된다")
    : bad("A5 자가교정", dbg(r));
}

{
  // ④ 템플릿 리터럴 안의 `import` 줄이 ESM 마커로 오인되면 CJS 훅이 .mjs 로 가 `require is not defined` 로 죽는다
  //    = #892 원본 증상. 이건 **런타임** ReferenceError 라 자가교정(파싱 실패 전용)이 못 구한다 —
  //    분류가 코드 아닌 것을 걷어내야만 통과한다. 즉 이 케이스가 stripNonCode 의 값을 단독으로 증명한다.
  const src = 'const tpl = `\nimport x from "y";\n`;\n'
    + 'const path = require("node:path");\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",'
    + 'permissionDecision:"deny",permissionDecisionReason:"tpl:"+path.basename("/a/b.txt")+":"+tpl.length}}));\n';
  const r = run("PreToolUse", [{ id: "template-import-hook", src }]);
  answer(r)?.permissionDecisionReason === "tpl:b.txt:20"
    ? ok("A6 템플릿 속 import 줄이 CJS 훅을 ESM 으로 오분류하지 않는다")
    : bad("A6 템플릿 오분류", dbg(r));
}

{
  // ⑤ **자가교정이 부작용을 두 번 내면 안 된다.** 훅은 파일을 쓰거나 POST 를 한다 — 두 번 돌면 두 번 일어난다.
  //    재시도는 '파싱 실패 = 본문 미실행' 일 때만 안전한데, ESM 에 없는 `__dirname`·`module`·`require` 는
  //    파싱이 아니라 **그 줄에 도달해서** 나는 런타임 오류다(앞줄의 I/O 는 이미 끝난 뒤다).
  //    그래서 그런 오류는 재시도 신호로 쓰면 안 된다 — 이 테스트가 그 경계를 고정한다.
  const sentinel = join(SANDBOX, "side-effect.log");
  const src = 'import("node:fs").then((fs) => {\n'
    + `  fs.appendFileSync(${JSON.stringify(sentinel)}, "ran\\n");\n`
    + '  console.log(__dirname);\n' // ESM 에선 여기서 런타임 ReferenceError — 위 append 는 이미 실행됨
    + '  process.stdout.write("never");\n'
    + '});\n';
  const r = run("PreToolUse", [{ id: "side-effect-hook", src }]);
  let lines = 0;
  try { lines = readFileSync(sentinel, "utf8").trim().split("\n").filter(Boolean).length; } catch { /* 미생성 */ }
  lines === 1
    ? ok("A7 자가교정이 훅의 부작용을 두 번 일으키지 않는다")
    : bad("A7 부작용 중복", `부작용 ${lines}회 실행됨(1회여야 함) — ${dbg(r)}`);
  r.status === 0
    ? ok("A7b 그래도 세션은 안 막힌다")
    : bad("A7b exit 0", dbg(r));
}

{
  // ⑥ 훅이 `eval("await …")` 를 쓰면 **모듈 타입이 맞아도** "await is only valid…" SyntaxError 가 난다.
  //    문구만 보고 재시도하면, eval 앞에서 이미 끝난 부작용이 두 번 일어난다. 오류 문구가 아니라
  //    **그게 우리 파일의 파싱에서 났는지**로 판정해야만 통과한다(eval 은 <anonymous_script> 로 찍힌다).
  const sentinel = join(SANDBOX, "eval-side-effect.log");
  const src = 'import("node:fs").then((fs) => {\n'
    + `  fs.appendFileSync(${JSON.stringify(sentinel)}, "ran\\n");\n`
    + '  eval("await Promise.resolve(1)");\n' // 모듈타입과 무관하게 SyntaxError — 위 append 는 이미 실행됨
    + '});\n';
  const r = run("PreToolUse", [{ id: "eval-hook", src }]);
  let lines = 0;
  try { lines = readFileSync(sentinel, "utf8").trim().split("\n").filter(Boolean).length; } catch { /* 미생성 */ }
  lines === 1
    ? ok("A8 훅이 eval 로 낸 모듈 오류에 속아 재시도하지 않는다")
    : bad("A8 eval 오인 재시도", `부작용 ${lines}회 실행됨(1회여야 함) — ${dbg(r)}`);
}

// ── §F 확장 — 하네스가 무시할 출력도 실패다 ──
{
  // 훅은 정상 종료했지만 JSON 앞에 로그가 섞여 하네스가 통째로 무시한다 → 관리자는 게이트가 걸린 줄 아는데
  // 실제론 아무 일도 안 일어난다. 죽는 것과 결과가 같으므로 같이 드러나야 한다(#892 와 똑같은 조용한 무력화).
  const src = 'console.log("checking policy...");\n' + decide({ decision: "deny", reason: "should have blocked" });
  const r = run("PreToolUse", [{ id: "chatty-json-hook", src }]);
  decisionOf(r) === undefined && r.stdout.includes("chatty-json-hook") && r.status === 0
    ? ok("F4 결정으로 못 읽히는 출력도 실패로 드러난다(조용한 무력화 방지)")
    : bad("F4 무시될 출력 보고", dbg(r));
}
{
  // 러너는 툴콜마다 돈다 — 같은 훅의 같은 실패를 매번 알리면 고장난 훅 하나가 세션을 시끄럽게 만든다.
  // 1회차엔 알리고, 곧이은 2회차엔 조용해야 한다(사양 §F 의 '최소 간격').
  const hooks = [{ id: "always-broken-hook", src: 'throw new Error("boom");\n' }];
  const first = run("PreToolUse", hooks);
  const second = run("PreToolUse", hooks);
  first.stdout.includes("always-broken-hook") && !second.stdout.includes("always-broken-hook")
    ? ok("F5 같은 훅의 반복 실패는 매 툴콜마다 알리지 않는다(스로틀)")
    : bad("F5 스로틀", `1회차=${JSON.stringify(first.stdout)} 2회차=${JSON.stringify(second.stdout)}`);
  second.status === 0
    ? ok("F5b 스로틀되어도 세션은 여전히 안 막힌다")
    : bad("F5b 스로틀 exit 0", dbg(second));
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`run-custom tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
