#!/usr/bin/env node
// run-custom 러너 사양테스트 — PreToolUse 도구 게이트의 '결정 전파' 계약을 고정한다.
//  하네스(캐시 심기·러너 실행·랑데부 조각)는 kit/testlib/run-custom-harness.mjs — run-custom-cost.test.mjs(#5034)와 함께 쓴다.
//  오프라인·fs-only: 샌드박스 HOME/LIVELY_HOME 의 로컬 캐시(custom-hooks-<Event>.json)에 훅을 심고
//  러너를 실제 프로세스로 띄운다(토큰 부재 → 게이트웨이 미도달 → 캐시 폴백). 실제 ~/.lively 무접촉.
//  실행: node scripts/run-tests.mjs run-custom (직접 실행하려면 LIVELY_HOST_EFFECTS_TEST_MODE=sandbox 필요 —
//   테스트가 심는 LIVELY_HOST_EFFECTS=deny 가 그 값 없이는 훅 자식 spawn 까지 막는다)
//
//  왜 이 테스트가 있나(#892): 러너는 하네스 눈에 **훅 하나**다 — 관리자 훅이 여럿이어도 러너가 대표해 하나의 응답을 낸다.
//  그 대표 응답이 전달되지 않으면 관리자는 "게이트를 걸었다"고 믿는데 도구는 그냥 통과한다(무음 실패).
//  ⚠ 최우선 불변식 = **러너는 무슨 일이 있어도 exit 0**(세션 불가침). 그 다음이 결정 전파·병합·정책이다.
//  ⚠ 사양은 훅↔러너 사이의 payload 전달 규약을 정하지 않는다 → 여기 테스트 훅들은 stdin 을 읽지 않는다
//    (미규정 규약에 테스트가 기대면, 사양이 아니라 구현을 고정하는 테스트가 된다).
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SANDBOX, HOME, ok, bad, finish, sha256, run, answer, decisionOf, dbg, decide,
  UPS, wDir, sleepSrc, sayHook, meet, logHook, readLog, before,
} from "../testlib/run-custom-harness.mjs";

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
{
  // 훅은 컨텍스트도 PreToolUse 와 같은 봉투(hookSpecificOutput.additionalContext)로 내는 일이 흔하다.
  //  러너가 그걸 생 문자열로 이어붙이면 `{...}\n\n{...}` 가 되어 하네스는 "JSON 처럼 보이는데 파싱 실패" 로
  //  **출력 전체를 버린다** — 훅 둘 다 성공했는데 컨텍스트는 하나도 안 들어가는 무음 실패다.
  //  사양은 봉투 여부를 정하지 않으므로 '하네스가 읽을 수 있는 한 덩이' + '두 컨텍스트 생존' 을 보되,
  //  봉투를 통째로 문자열로 감싸 버리는 오답(이중 래핑 — 컨텍스트가 JSON 텍스트로 주입된다)은 걸러야 하므로
  //  '주입되는 본문 안에 봉투 흔적이 없다' 까지 함께 단언한다.
  const envelope = (event, ctx) => `process.stdout.write(${JSON.stringify(JSON.stringify({
    hookSpecificOutput: { hookEventName: "__EV__", additionalContext: "__CTX__" },
  }))}.replace("__EV__", ${JSON.stringify(event)}).replace("__CTX__", ${JSON.stringify(ctx)}));\n`;
  // 하네스가 실제로 컨텍스트로 삼는 본문만 꺼낸다(raw 경로면 stdout 자체, JSON 경로면 additionalContext).
  const injected = (out) => {
    if (!out.startsWith("{")) return { ok: true, body: out };
    try { return { ok: true, body: String(JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "") }; }
    catch { return { ok: false, body: "" }; } // 하네스가 파싱조차 못 하는 출력 = 컨텍스트 전멸
  };
  for (const [ev, payload] of [
    ["UserPromptSubmit", { session_id: "s1", prompt: "안녕" }],
    ["PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: {}, tool_response: {} }],
  ]) {
    const r = run(ev, [
      { id: "env-1", src: envelope(ev, "ENVELOPE-ALPHA") },
      { id: "env-2", src: envelope(ev, "ENVELOPE-BETA") },
    ], { payload });
    const { ok: readable, body } = injected(r.stdout.trim());
    r.status === 0 && readable && body.includes("ENVELOPE-ALPHA") && body.includes("ENVELOPE-BETA")
      && !body.includes("hookSpecificOutput")
      ? ok(`H3 ${ev} 봉투로 낸 컨텍스트가 여럿이어도 한 덩이로 합쳐져 주입된다`)
      : bad(`H3 ${ev} 봉투 컨텍스트 병합`, dbg(r));
  }
}
{
  // 봉투에 컨텍스트 말고 **다른 뜻**(decision·systemMessage)이 함께 실려 있으면 벗기면 안 된다 —
  //  훅이 하나일 때 하네스가 그 봉투를 그대로 소비하던 경로다. 벗기는 순간 게이트가 조용히 사라진다(#892 클래스).
  const src = `process.stdout.write(${JSON.stringify(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX-WITH-BLOCK" },
    decision: "block", reason: "BLOCKED-BY-HOOK",
  }))});\n`;
  const r = run("UserPromptSubmit", [{ id: "blocking-ctx-hook", src }], { payload: { session_id: "s1", prompt: "안녕" } });
  r.status === 0 && r.stdout.includes("BLOCKED-BY-HOOK") && r.stdout.includes('"block"')
    ? ok("H4 컨텍스트 외의 뜻(block)이 실린 봉투는 벗기지 않는다")
    : bad("H4 봉투 내 결정 보존", dbg(r));
  // 봉투 **안쪽**에 실린 뜻도 같다 — 컨텍스트와 함께 온 결정을 벗겨 버리면 게이트가 조용히 사라진다.
  const inner = `process.stdout.write(${JSON.stringify(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX-WITH-DENY", permissionDecision: "deny" },
  }))});\n`;
  const r2 = run("UserPromptSubmit", [{ id: "inner-decision-hook", src: inner }], { payload: { session_id: "s1", prompt: "안녕" } });
  r2.status === 0 && r2.stdout.includes('"deny"')
    ? ok("H4b 봉투 안쪽에 실린 결정도 벗기지 않는다")
    : bad("H4b 봉투 내부 결정 보존", dbg(r2));
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

{
  // ⑦ 훅은 자기 stderr 를 **위조할 수 있다**: vm.Script 의 filename 옵션은 오류 위치줄을 임의 경로로 바꾼다
  //    (스택 가독성을 위한 정상 관행이기도 하다). 그래서 '오류 문구'나 '위치줄' 같이 훅이 영향 줄 수 있는
  //    텍스트로 재시도를 판정하면 이미 실행된 훅을 미실행으로 오인해 부작용을 두 번 낸다.
  //    판정은 파서에게 직접 물어야만(=훅을 실행하지 않아야만) 위조에 면역이다.
  const sentinel = join(SANDBOX, "vm-side-effect.log");
  const src = 'import("node:fs").then(async (fs) => {\n'
    + `  fs.appendFileSync(${JSON.stringify(sentinel)}, "ran\\n");\n`
    + '  const vm = await import("node:vm");\n'
    + '  new vm.Script("await Promise.resolve(1)", { filename: process.argv[1] }).runInThisContext();\n'
    + '});\n';
  const r = run("PreToolUse", [{ id: "vm-forge-hook", src }]);
  let lines = 0;
  try { lines = readFileSync(sentinel, "utf8").trim().split("\n").filter(Boolean).length; } catch { /* 미생성 */ }
  lines === 1
    ? ok("A9 훅이 오류 위치줄을 위조해도 재시도에 속지 않는다")
    : bad("A9 위치줄 위조", `부작용 ${lines}회 실행됨(1회여야 함) — ${dbg(r)}`);
}

{
  // ⑧ 재시도 판정은 **디스크의 파일**을 다시 읽는다. 방금 끝난 훅은 자기 경로에 쓸 수 있으니, 크래시 직전에
  //    자기 소스를 쓰레기로 덮어쓰면 판정이 그 쓰레기를 읽고 '확장자가 틀렸다'로 오인해 재시도한다.
  //    실행 전 해시와 대조해야만 '우리가 쓴 그 파일'임을 알 수 있다. (훅이 자기 실행횟수를 늘리는 것뿐이라
  //    위협모델 밖이지만, 주석이 약속하는 성질은 실제로 지켜져야 한다.)
  const sentinel = join(SANDBOX, "tamper-side-effect.log");
  const src = 'import("node:fs").then((fs) => {\n'
    + `  fs.appendFileSync(${JSON.stringify(sentinel)}, "ran\\n");\n`
    + '  fs.writeFileSync(process.argv[1], "not >>> valid <<< js {{{");\n' // 자기 소스를 덮어씀
    + '  throw new Error("모듈 타입과 무관한 평범한 버그");\n'
    + '});\n';
  const r = run("PreToolUse", [{ id: "tamper-hook", src }]);
  let lines = 0;
  try { lines = readFileSync(sentinel, "utf8").trim().split("\n").filter(Boolean).length; } catch { /* 미생성 */ }
  lines === 1
    ? ok("A10 훅이 자기 소스를 덮어써도 재시도 판정이 속지 않는다")
    : bad("A10 소스 변조", `부작용 ${lines}회 실행됨(1회여야 함) — ${dbg(r)}`);
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

// ── §I 오프라인 캐시 유효기간(#1008) — 게이트웨이 미도달 시 last-known-good 정책 ──
// 종전엔 10분이 하드코딩돼 오프라인 10분 후 로컬-자족 훅(스킬 라우터·품질 게이트)까지 죽었다. 이제 hook_grace_ms
// 노브로 승격, 기본(파일 없음/null) = 무제한(마지막 접속 기준 영구 실행). run() 은 오프라인이라 늘 캐시 폴백을 탄다.
const graceHook = (id) => ({ id, src: decide({ decision: "deny", reason: id }) });

// I1: 무제한 기본 — hooks-config.json 없음 + 아주 오래된 캐시(1년)여도 실행된다(마지막 접속 기준 영구).
{
  const r = run("PreToolUse", [graceHook("i1")], { cacheAgeMs: 365 * 24 * 3600 * 1000 });
  decisionOf(r) === "deny"
    ? ok("I1 무제한 기본 — 1년 된 캐시도 실행(마지막 접속 기준 영구)")
    : bad("I1 무제한 기본", dbg(r));
}
// I2: grace 설정 + 캐시가 grace 보다 오래됨 → fail-CLOSED(결정 없음 = 하네스가 아무것도 못 본다).
{
  const r = run("PreToolUse", [graceHook("i2")], { graceMs: 600000, cacheAgeMs: 3600000 }); // grace 10분, 캐시 1시간 전
  decisionOf(r) === undefined
    ? ok("I2 grace 만료 — 캐시가 grace 보다 오래되면 fail-CLOSED(미실행)")
    : bad("I2 grace 만료", dbg(r));
}
// I3: grace 설정 + 캐시가 grace 이내 → 실행된다.
{
  const r = run("PreToolUse", [graceHook("i3")], { graceMs: 3600000, cacheAgeMs: 60000 }); // grace 1시간, 캐시 1분 전
  decisionOf(r) === "deny"
    ? ok("I3 grace 이내 — 신선한 캐시는 실행")
    : bad("I3 grace 이내", dbg(r));
}
// I4: grace=0(즉시 만료) + 살짝 오래된 캐시 → fail-CLOSED. 가장 보수적 설정이 실제로 즉시 끊는지.
{
  const r = run("PreToolUse", [graceHook("i4")], { graceMs: 0, cacheAgeMs: 5000 }); // grace 0, 캐시 5초 전
  decisionOf(r) === undefined
    ? ok("I4 grace=0 — 연결 끊기면 즉시 중단(가장 보수적)")
    : bad("I4 grace=0 즉시 중단", dbg(r));
}
// I5: hooks-config.json 에 hook_grace_ms:null 이 명시돼 있어도(파일 부재의 catch 가 아닌 정상 파싱 경로) 무제한이다.
//  session-preload 는 null 을 키 생략(undefined)으로 미러하지만, 방어적으로 literal null 도 무제한이어야 한다(graceMs() 의 g===null 분기).
{
  const r = run("PreToolUse", [graceHook("i5")], { graceMs: null, cacheAgeMs: 365 * 24 * 3600 * 1000 });
  decisionOf(r) === "deny"
    ? ok("I5 hook_grace_ms:null 명시 — 정상 파싱 경로에서도 무제한")
    : bad("I5 literal null 무제한", dbg(r));
}

// ── §J SessionEnd 오프라인 — 하네스 취소창(1500ms) 안에 끝나야 한다 (#1039/#1043) ──
// Claude Code(2.1.215)는 SessionEnd 훅을 AbortSignal.timeout(i)로 끊는다. 러너 엔트리에 timeout 이 없으면
//  i = max(1500, min(엔트리.timeout*1000, 60000)) = 1500ms 바닥. 종전 러너는 오프라인(도달불가 게이트웨이)에서
//  fetch 를 FETCH_MS(3000ms) 매달려 1500ms 를 넘겼고, 하네스가 러너를 통째로 abort → "Hook cancelled".
//  이제 SessionEnd 는 fetch 예산(FETCH_MS_SESSIONEND)을 바닥 밑으로 줄여, 오프라인이어도 캐시로 손 떼고 제때 exit 0.
{
  const { createServer } = await import("node:net");
  // 응답을 절대 주지 않는 로컬 게이트웨이(accept 만, HTTP 응답 없음) — 연결은 되지만 무한 대기라 fetch 가 예산까지
  //  매달린다. 도달불가 IP(192.0.2.1 등)는 CI 망에 따라 즉시 ICMP-unreachable 로 빨리 죽어 회귀를 못 잡을 수 있어,
  //  로컬 hang 서버가 결정적이다(spawnSync 로 부모 이벤트루프가 막혀도 커널 backlog 가 handshake 를 완결한다).
  const hang = createServer((sock) => { sock.on("error", () => {}); });
  await new Promise((res) => hang.listen(0, "127.0.0.1", res));
  const port = hang.address().port;
  const sentinel = join(HOME, "se-hook-ran.txt");
  try { rmSync(sentinel, { force: true }); } catch { /* 없으면 무시 */ }
  // 캐시된 SessionEnd 훅 1개 — 실행되면 sentinel 을 남긴다(SessionEnd stdout 은 미소비라 side-effect 로 관측).
  const src = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`;
  // ── 대조군: **닫힌 포트**(ECONNREFUSED) ────────────────────────────────────
  //  같은 실패 경로(fetch 실패 → 캐시 폴백)를 타되 **기다리지 않는다** — 러너 주석의 실측대로
  //  "ECONNREFUSED 는 ~20ms 즉시실패". 그래서 두 실행의 차이가 곧 **네트워크를 기다린 시간**이고,
  //  부하는 양쪽에 똑같이 얹히므로 그 차이에서 상쇄된다.
  //
  //  ⚠ 왜 총 경과시간(elapsed<1500)을 직접 안 재나 — 그게 이 테스트를 플레이크로 만들었다.
  //   실측 2026-08-27: 8병렬 × 3라운드에서 **24회 중 7회(29%) 실패**, 관측 1531~2052ms.
  //   전부 상한을 살짝 넘긴 것이고 원인은 코드가 아니라 **부하**다(SessionEnd 예산 800ms + 러너 오버헤드).
  //   상한을 그냥 올리면 사양이 약해지고, -j 를 낮추면 러너 방침("상한을 부하 내성 있게 고쳐라")에 어긋난다.
  //   그래서 **재는 대상을 바꾼다** — 이 테스트가 정말 지켜야 할 것은 «러너가 네트워크를 기다리지 않는다» 이고,
  //   델타는 그것을 부하와 무관하게 잰다.
  const closed = createServer(() => {});
  await new Promise((res) => closed.listen(0, "127.0.0.1", res));
  const deadPort = closed.address().port;
  await new Promise((res) => closed.close(res));           // 포트를 비워 ECONNREFUSED 를 보장
  //  ⚠ 각 변을 **2회 재고 더 빠른 쪽**을 쓴다. 델타는 평균 부하를 상쇄하지만 **분산**은 못 지운다 —
  //   실측(8병렬): 델타가 201~1187ms 로 흔들려 상한 1500 에 여유가 313ms 밖에 없었다. min-of-2 는 그
  //   위쪽 꼬리를 깎는다. 회귀(예산 3000)는 두 번 다 느리므로 min 을 써도 그대로 잡힌다.
  const fastest = (label, gw) => {
    let best = null;
    for (let i = 0; i < 2; i++) {
      const x = run("SessionEnd", [{ id: "se-cleanup", src }], { token: "x", gatewayUrl: gw, timeoutMs: 9000 });
      if (!best || x.elapsed < best.elapsed) best = x;
      if (x.status !== 0) return x;                     // 비정상 종료는 즉시 드러낸다(감추지 않는다)
    }
    return best;
  };
  const base = fastest("즉시실패", `http://127.0.0.1:${deadPort}`);
  try { rmSync(sentinel, { force: true }); } catch { /* 없으면 무시 */ }

  const r = fastest("무응답", `http://127.0.0.1:${port}`);
  hang.close();
  // J1: 도달불가(무응답) 게이트웨이가 **하네스 1500ms 취소창을 넘게 만들지 않는다**.
  //  1500 은 하네스 계약이다(Claude Code 2.1.215 실측 getSessionEndHookTimeoutMs 바닥값) — 그래서 러너의
  //  SessionEnd fetch 예산이 800ms 로 잘려 있다(FETCH_MS_SESSIONEND). 회귀는 그 예산이 FETCH_MS(3000ms)로
  //  돌아가는 것이고, 그러면 델타가 ~3000 이 돼 여기서 잡힌다.
  const delta = r.elapsed - base.elapsed;
  // 배선 확인 — 대조군이 정상 종료했어야 델타가 뜻을 갖는다(둘 다 죽으면 델타 0으로 조용히 통과한다).
  if (base.status !== 0) {
    bad("J1 SessionEnd 취소창(대조군)", `대조군(ECONNREFUSED)이 exit ${base.status} — 델타가 vacuous 하다 ${dbg(base)}`);
  } else if (r.status === 0 && delta < 1500) {
    ok(`J1 무응답 게이트웨이가 1500ms 취소창을 넘기지 않는다 (델타 ${delta}ms = 무응답 ${r.elapsed} − 즉시실패 ${base.elapsed})`);
  } else {
    bad("J1 SessionEnd 1500ms 취소창",
      `${dbg(r)} 델타=${delta}ms (무응답 ${r.elapsed}ms − 즉시실패 ${base.elapsed}ms) — 러너가 네트워크를 기다린다`);
  }
  // J2: 예산에서 손을 뗐어도 캐시된 SessionEnd 훅은 여전히 돌았다(오프라인 last-known-good 기능 보존).
  existsSync(sentinel)
    ? ok("J2 오프라인에서도 캐시된 SessionEnd 훅은 실행된다(기능 보존)")
    : bad("J2 캐시된 SessionEnd 훅 실행", dbg(r));
}

// ── §W 실행 순서(sort 묶음) ──
// 조직이 동시 실행을 켜면(concurrent) 같은 sort 는 동시에, 다른 sort 는 오름차순으로 차례차례 돈다. 순서 정보가 하나라도
//  빠지면 전부 하나씩. 끄면(기본 — 설정이 없는 구 캐시 포함) 종전처럼 받은 순서대로 하나씩(§W0).
//  '겹쳤나'는 경과시간보다 **랑데부**로 본다: 두 훅이 각자 시작 표식을 남기고 상대 표식을 기다린다 —
//  동시에 돌면 둘 다 상대를 보고, 하나씩 돌면 먼저 돈 쪽은 끝내 혼자다. 부하에 흔들리지 않는 관측이다.
//  경과시간 단정은 하한(W3a: 하나씩이면 구조상 2T 이상)과 넉넉한 상한(W6·W6b)에만 쓴다 — 부하에 흔들리지 않게.

// W0a (기본): 동시 실행 설정이 없으면(구 캐시 · 조직이 안 켬) sort 가 같아도 하나씩 돈다 — 먼저 돈 쪽은 끝내 혼자다.
{
  const d = wDir("0a");
  const r = run("UserPromptSubmit", [
    { id: "w0a-p", sort: 3, timeout_sec: 10, src: meet(d, "p", "q", 1500) },
    { id: "w0a-q", sort: 3, timeout_sec: 10, src: meet(d, "q", "p", 1500) },
  ], { payload: UPS });
  r.status === 0 && r.stdout.includes("p:ALONE") && r.stdout.includes("q:SAW")
    ? ok("W0a 동시 실행 설정이 없으면 같은 sort 여도 겹치지 않는다(기본 꺼짐)")
    : bad("W0a 기본 꺼짐 직렬", dbg(r));
}
// W0b: concurrent:false 로 명시해도 같다 — true 만 켠다.
{
  const d = wDir("0b");
  const r = run("UserPromptSubmit", [
    { id: "w0b-p", sort: 3, timeout_sec: 10, src: meet(d, "p", "q", 1500) },
    { id: "w0b-q", sort: 3, timeout_sec: 10, src: meet(d, "q", "p", 1500) },
  ], { payload: UPS, concurrent: false });
  r.status === 0 && r.stdout.includes("p:ALONE") && r.stdout.includes("q:SAW")
    ? ok("W0b concurrent:false 면 하나씩 돈다")
    : bad("W0b 명시 꺼짐 직렬", dbg(r));
}
// W0c: 꺼져 있으면 러너는 순서를 다시 정하지 않는다 — 받은 순서(서버가 sort·id 로 정렬해 준 순서) 그대로다(종전 동작).
{
  const d = wDir("0c");
  const log = join(d, "order.log");
  const r = run("UserPromptSubmit", [
    { id: "w0c-high", sort: 7, src: logHook(log, "high") },
    { id: "w0c-low", sort: -2, src: logHook(log, "low") },
  ], { payload: UPS });
  const order = readLog(log);
  r.status === 0 && order === "high,low"
    ? ok("W0c 꺼져 있으면 받은 순서 그대로 돈다(종전 동작)")
    : bad("W0c 꺼짐 받은 순서", `order=${order} (기대 high,low) ${dbg(r)}`);
}

// W1a (S1): 모든 훅에 sort 가 있고 값이 같으면 동시에 돈다 — 두 훅이 서로의 시작 표식을 본다.
{
  const d = wDir("1a");
  const r = run("UserPromptSubmit", [
    { id: "w1a-p", sort: 3, timeout_sec: 10, src: meet(d, "p", "q", 4000) },
    { id: "w1a-q", sort: 3, timeout_sec: 10, src: meet(d, "q", "p", 4000) },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("p:SAW") && r.stdout.includes("q:SAW")
    ? ok("W1a 같은 sort 의 훅들은 겹쳐서(동시에) 돈다")
    : bad("W1a 같은 sort 동시 실행", dbg(r));
}
// W2a (S2): 큰 sort 는 작은 sort 묶음이 **모두** 끝난 뒤에 시작한다 — 같은 묶음의 느린 훅이 남긴 부수효과까지 본다.
{
  const d = wDir("2a");
  const mark = join(d, "slow-done");
  const r = run("UserPromptSubmit", [
    { id: "w2a-fast", sort: 1, src: sayHook("W2A-FAST ") },
    { id: "w2a-slow", sort: 1, src: 'const fs = require("node:fs");\n' + sleepSrc(800) + `fs.writeFileSync(${JSON.stringify(mark)}, "1");\n` },
    { id: "w2a-later", sort: 2, src: 'const fs = require("node:fs");\n'
      + `process.stdout.write(fs.existsSync(${JSON.stringify(mark)}) ? "W2A-SEEN " : "W2A-MISSING ");\n` },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W2A-SEEN")
    ? ok("W2a 큰 sort 훅은 작은 sort 묶음이 모두 끝난 뒤 시작한다(느린 앞 훅의 부수효과를 본다)")
    : bad("W2a sort 묶음 간 선후", dbg(r));
}
// W2c (S2): 음수·소수·여러 자리 수도 **숫자로** 비교된다(문자열 비교면 "10" < "9" 가 된다).
//  앞 sort 일수록 오래 자게 했다 — 한꺼번에 돌면 로그가 거꾸로(늦게 잔 순) 찍혀 잡힌다.
{
  const d = wDir("2c");
  const log = join(d, "order.log");
  const r = run("UserPromptSubmit", [
    { id: "w2c-ten", sort: 10, src: logHook(log, "ten") },
    { id: "w2c-half", sort: 0.5, src: logHook(log, "half", 400) },
    { id: "w2c-neg", sort: -1, src: logHook(log, "neg", 600) },
    { id: "w2c-nine", sort: 9, src: logHook(log, "nine", 200) },
  ], { payload: UPS, concurrent: true });
  const order = readLog(log);
  r.status === 0 && order === "neg,half,nine,ten"
    ? ok("W2c sort 는 음수·소수 포함 숫자 오름차순으로 돈다")
    : bad("W2c 숫자 비교", `order=${order} (기대 neg,half,nine,ten) ${dbg(r)}`);
}
// W3a (S3): sort 가 전부 빠지면(구 게이트웨이) 하나씩 돈다 — T초 훅 둘이면 2T 이상.
{
  const r = run("UserPromptSubmit", [
    { id: "w3a-1", src: sleepSrc(1500) + sayHook("W3A-ONE ") },
    { id: "w3a-2", src: sleepSrc(1500) + sayHook("W3A-TWO ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W3A-ONE") && r.stdout.includes("W3A-TWO") && r.elapsed >= 2900
    ? ok(`W3a sort 가 없는 훅들은 겹치지 않고 하나씩 돈다 (${r.elapsed}ms)`)
    : bad("W3a sort 부재 직렬", `elapsed=${r.elapsed}ms (2900 이상이어야 함) ${dbg(r)}`);
}
// W3b (S3): **하나만** sort 가 빠져도 전부 하나씩 돈다 — 나머지 훅의 sort 가 같아도 겹치지 않는다.
//  (빠진 sort 를 0 으로 채우는 구현이면 sort:0 짝과 한 묶음이 되어 여기서 잡힌다.)
{
  const d = wDir("3b");
  const r = run("UserPromptSubmit", [
    { id: "w3b-p", sort: 0, timeout_sec: 10, src: meet(d, "p", "q", 1500) },
    { id: "w3b-q", timeout_sec: 10, src: meet(d, "q", "p", 1500) },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("p:ALONE") && r.stdout.includes("q:SAW")
    ? ok("W3b 하나라도 sort 가 없으면 모든 훅이 받은 순서대로 하나씩 돈다")
    : bad("W3b 일부 sort 부재 직렬", dbg(r));
}
// W3c (S3): 그 하나씩은 **받은 순서**다 — 다른 훅들의 sort 값은 이때 순서를 정하지 않는다.
{
  const d = wDir("3c");
  const log = join(d, "order.log");
  const r = run("UserPromptSubmit", [
    { id: "w3c-x", sort: 2, src: logHook(log, "x") },
    { id: "w3c-y", sort: 1, src: logHook(log, "y") },
    { id: "w3c-z", src: logHook(log, "z") },
  ], { payload: UPS, concurrent: true });
  const order = readLog(log);
  r.status === 0 && order === "x,y,z"
    ? ok("W3c sort 가 빠진 묶음은 sort 와 무관하게 받은 순서대로 돈다")
    : bad("W3c 받은 순서 실행", `order=${order} (기대 x,y,z) ${dbg(r)}`);
}
// W4a (S4): 같은 sort 안에서 컨텍스트 순서 = 받은 순서. 먼저 받은 훅을 **느리게** 해 '먼저 끝난 순서'와 갈라 놓는다.
{
  const r = run("UserPromptSubmit", [
    { id: "w4a-slow", sort: 5, src: sleepSrc(800) + sayHook("W4A-FIRST-RECEIVED ") },
    { id: "w4a-fast", sort: 5, src: sayHook("W4A-SECOND-RECEIVED ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && before(r.stdout, "W4A-FIRST-RECEIVED", "W4A-SECOND-RECEIVED")
    ? ok("W4a 같은 sort 의 컨텍스트는 먼저 끝난 순서가 아니라 받은 순서로 이어붙는다")
    : bad("W4a 같은 sort 출력 순서", dbg(r));
}
// W4b (S4): 다른 sort 끼리는 받은 목록 순서와 무관하게 sort 오름차순으로 이어붙는다.
{
  const r = run("UserPromptSubmit", [
    { id: "w4b-high", sort: 7, src: sayHook("W4B-HIGH ") },
    { id: "w4b-low", sort: -2, src: sayHook("W4B-LOW ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && before(r.stdout, "W4B-LOW", "W4B-HIGH")
    ? ok("W4b 컨텍스트는 sort 오름차순으로 이어붙는다(목록에 높은 sort 가 먼저 와도)")
    : bad("W4b sort 순 출력", dbg(r));
}
// W5a (S5): PreToolUse 같은 등급(deny) 사유 합치기도 받은 순서 — 먼저 받은 쪽이 늦게 끝나도.
{
  const r = run("PreToolUse", [
    { id: "w5a-slow", sort: 1, src: sleepSrc(800) + decide({ decision: "deny", reason: "W5A-REASON-FIRST" }) },
    { id: "w5a-fast", sort: 1, src: decide({ decision: "deny", reason: "W5A-REASON-SECOND" }) },
  ], { concurrent: true });
  const a = answer(r);
  a?.permissionDecision === "deny" && before(a?.permissionDecisionReason ?? "", "W5A-REASON-FIRST", "W5A-REASON-SECOND")
    ? ok("W5a 같은 sort 의 deny 사유는 먼저 끝난 순서가 아니라 받은 순서로 합쳐진다")
    : bad("W5a 사유 순서(같은 sort)", dbg(r));
}
// W6 (S6): 같은 묶음에서 한 훅이 timeout_sec 을 넘기면 그 훅만 끊기고, 이웃의 출력은 그대로 나간다.
{
  const r = run("UserPromptSubmit", [
    { id: "w6-hang", sort: 1, timeout_sec: 1, src: sleepSrc(5000) + sayHook("W6-LATE ") },
    { id: "w6-ok", sort: 1, src: sleepSrc(300) + sayHook("W6-SURVIVOR ") },
  ], { payload: UPS, concurrent: true, timeoutMs: 15000 });
  r.status === 0 && r.stdout.includes("W6-SURVIVOR") && !r.stdout.includes("W6-LATE")
    && r.stderr.includes("[lively] hook 'w6-hang' timeout") && r.elapsed < 4500
    ? ok(`W6 같은 묶음의 timeout 훅만 끊기고 이웃 출력은 전달된다(exit 0, ${r.elapsed}ms)`)
    : bad("W6 묶음 내 timeout 격리", `elapsed=${r.elapsed}ms ${dbg(r)}`);
}
// W6b (S8): timeout 된 훅이 stdio 를 물려받은 자식(백그라운드 작업)을 남겨도, 러너는 그 훅의 상한 직후 진행한다.
//  자식이 8초 살아 있으므로 러너가 자식을 기다리면 8초를 넘긴다. 상한 5초는 timeout(1초)+기동 오버헤드에 넉넉하다.
{
  const r = run("UserPromptSubmit", [
    { id: "w6b-orphan", sort: 1, timeout_sec: 1, src: 'const { spawn } = require("node:child_process");\n'
      + 'spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" });\n' + sleepSrc(5000) },
    { id: "w6b-ok", sort: 1, src: sayHook("W6B-SURVIVOR ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W6B-SURVIVOR") && r.stderr.includes("[lively] hook 'w6b-orphan' timeout") && r.elapsed < 5000
    ? ok(`W6b timeout 훅이 남긴 자식이 파이프를 붙잡아도 러너는 기다리지 않는다(${r.elapsed}ms)`)
    : bad("W6b timeout 훅의 자식 대기", `elapsed=${r.elapsed}ms ${dbg(r)}`);
}
// W6c (S9): 훅이 스스로 정상 종료했는데 stdio 를 물려받은 자식이 파이프를 붙잡고 있어도, 러너는 그 훅의 상한 안에
//  성공으로 마무리한다 — 출력은 전달되고 실패로 보고되지 않는다.
{
  const r = run("UserPromptSubmit", [
    { id: "w6c-done", sort: 1, timeout_sec: 1, src: 'const { spawn } = require("node:child_process");\n'
      + 'spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" }).unref();\n'
      + 'process.stdout.write("W6C-DONE ", () => process.exit(0));\n' },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W6C-DONE") && !r.stderr.includes("w6c-done") && r.elapsed < 5000
    ? ok(`W6c 정상 종료한 훅의 자식이 파이프를 붙잡아도 상한 안에 성공으로 끝난다(${r.elapsed}ms)`)
    : bad("W6c 정상 종료 훅의 자식 대기", `elapsed=${r.elapsed}ms ${dbg(r)}`);
}
// W7 (S7): 같은 묶음에서 한 훅이 크래시해도 그 훅만 실패로 드러나고, 더 늦게 끝나는 이웃의 출력은 전달된다.
{
  const r = run("UserPromptSubmit", [
    { id: "w7-crash", sort: 1, src: 'throw new Error("w7-boom");\n' },
    { id: "w7-ok", sort: 1, src: sleepSrc(500) + sayHook("W7-SURVIVOR ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W7-SURVIVOR") && r.stderr.includes("[lively] hook 'w7-crash' crash")
    ? ok("W7 같은 묶음의 크래시 훅만 실패로 드러나고 이웃 출력은 전달된다(exit 0)")
    : bad("W7 묶음 내 크래시 격리", dbg(r));
}

// W8: 한 묶음에서 동시에 도는 훅은 8개까지다 — 같은 sort 의 훅 10개가 각자 «지금 도는 훅 수» 를 세어 남긴다.
//  상한이 없으면 10개가 한꺼번에 떠 최대값이 8 을 넘는다. 2 이상이어야 실제로 겹친 것이다.
{
  const d = wDir("8");
  const runDir = join(d, "run"); mkdirSync(runDir, { recursive: true });
  const counted = (id) => 'const fs = require("node:fs"); const path = require("node:path");\n'
    + `const me = path.join(${JSON.stringify(runDir)}, ${JSON.stringify(id)}); fs.writeFileSync(me, "1");\n`
    + `fs.appendFileSync(${JSON.stringify(join(d, "counts.log"))}, fs.readdirSync(${JSON.stringify(runDir)}).length + "\\n");\n`
    + sleepSrc(700) + 'fs.unlinkSync(me);\n' + sayHook(`${id} `);
  const hooks = Array.from({ length: 10 }, (_, i) => ({ id: `w8-${i}`, sort: 1, timeout_sec: 10, src: counted(`w8-${i}`) }));
  const r = run("UserPromptSubmit", hooks, { payload: UPS, concurrent: true, timeoutMs: 30000 });
  const counts = (() => { try { return readFileSync(join(d, "counts.log"), "utf8").trim().split("\n").map(Number); } catch { return []; } })();
  const max = counts.length ? Math.max(...counts) : 0;
  r.status === 0 && counts.length === 10 && max >= 2 && max <= 8 && hooks.every((h) => r.stdout.includes(h.id))
    ? ok(`W8 같은 sort 의 훅 10개 — 동시에 도는 건 최대 8개(관측 최대 ${max})`)
    : bad("W8 동시 실행 상한", `counts=${counts.join(",")} max=${max} ${dbg(r)}`);
}
// W9: 한 훅을 실행하다 러너 쪽에서 예외가 나도(캐시가 깨져 source_code 가 문자열이 아님) 같은 묶음의 이웃은 끝까지 돈다.
{
  const r = run("UserPromptSubmit", [
    { id: "w9-broken", sort: 1, src: 12345, hash: "not-a-hash" },
    { id: "w9-ok", sort: 1, src: sleepSrc(300) + sayHook("W9-SURVIVOR ") },
  ], { payload: UPS, concurrent: true });
  r.status === 0 && r.stdout.includes("W9-SURVIVOR") && r.stderr.includes("[lively] hook 'w9-broken'")
    ? ok("W9 러너 쪽 예외는 그 훅의 실패로 갇히고 이웃 출력은 전달된다(exit 0)")
    : bad("W9 훅 단위 예외 격리", dbg(r));
}
// W10a: 출력이 4MB 상한을 넘는 훅은 끊기고 실패로 드러난다(잘린 출력이 성공으로 나가지 않는다) · 이웃은 그대로.
//  stderr 로 쏟는다 — stdout 으로 쏟으면 회수한 앞부분이 러너 출력으로 그대로 나가 이 시험의 spawnSync 버퍼를 넘친다.
{
  const flood = 'const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 5; i++) require("node:fs").writeSync(2, b);\n';
  const r = run("UserPromptSubmit", [
    { id: "w10a-flood", sort: 1, timeout_sec: 20, src: flood },
    { id: "w10a-ok", sort: 1, src: sayHook("W10A-SURVIVOR ") },
  ], { payload: UPS, concurrent: true, timeoutMs: 30000 });
  r.status === 0 && r.stdout.includes("W10A-SURVIVOR") && r.stderr.includes("[lively] hook 'w10a-flood'")
    ? ok("W10a 출력 4MB 상한을 넘긴 훅은 실패로 드러나고 이웃 출력은 전달된다")
    : bad("W10a 출력 상한", dbg({ ...r, stderr: r.stderr.slice(-600) }));
}
// W10b: 훅이 stdin 을 안 읽고 먼저 끝나면(큰 입력에서 EPIPE) 러너는 죽지 않고 다음 훅까지 돈다.
{
  const big = { ...UPS, prompt: "x".repeat(512 * 1024) };
  const r = run("UserPromptSubmit", [
    { id: "w10b-noread", src: "process.exit(0);\n" },
    { id: "w10b-ok", src: sayHook("W10B-SURVIVOR ") },
  ], { payload: big, timeoutMs: 30000 });
  r.status === 0 && r.stdout.includes("W10B-SURVIVOR") && !r.stderr.includes("w10b-noread")
    ? ok("W10b stdin 을 안 읽고 끝난 훅(EPIPE)에도 러너는 exit 0 으로 다음 훅까지 돈다")
    : bad("W10b stdin EPIPE", dbg({ ...r, stderr: r.stderr.slice(-600) }));
}

finish("run-custom");
