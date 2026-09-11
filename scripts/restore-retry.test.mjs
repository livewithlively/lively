// 복원 요청은 **끊김에만** 짧게 다시 묻는다 (#3891, 상민님 신고 2026-09-11) — 값으로 고정한다.
//
//  무엇이 문제였나: 회수된 세션 대화창에서 보내면 화면이 복원을 부른다. 그 요청이 매니지드 롤 교대에 잘렸다
//   (게이트웨이 SIGTERM 15ms 뒤 relay 사망 — 게이트웨이 로그 실측). 화면은 실패를 토스트로 삼키고 «이어서 여는 중…» 에
//   멈췄다 — 보낸 말은 안 갔고, 서버엔 이미 뜬 세션이 남아 사이드바에 같은 세션이 두 줄 섰다.
//  규칙: 응답이 없거나(네트워크) 게이트웨이가 넘어진 모양(500·502·503·504)이면 1.5·3·6초 뒤 다시 묻는다. 4xx 는 서버가
//   판단해서 거절한 것이라 다시 묻지 않는다. 다시 물어도 안전한 이유는 서버 복원이 같은 대화를 둘로 만들지 않아서다
//   (src/terminal/restore-adopt.test.ts).
//
//  사양·엣지 표: 스크래치패드 spec-3891.md 의 T·R 행 — 아래 이름의 번호가 그 행이다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const show = (v) => JSON.stringify(v);

const tmp = mkdtempSync(path.join(tmpdir(), "restore-retry-"));
try {
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/restore-retry.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { isTransientRequestError, withRetry, RESTORE_RETRY_DELAYS_MS } = await import(path.join(tmp, "restore-retry.js"));

  const httpErr = (status) => Object.assign(new Error(`요청 실패 (${status})`), { status });   // web/lib/net.ts api() 의 모양
  const netErr = () => new TypeError("Failed to fetch");                                       // fetch 가 응답 없이 던지는 모양

  // ── T — 다시 물을 오류인가 ──────────────────────────────────────────────
  ok(isTransientRequestError(netErr()) === true, "T1 응답이 없던 실패(네트워크, status 없음)는 다시 묻는다");
  for (const st of [500, 502, 503, 504]) ok(isTransientRequestError(httpErr(st)) === true, `T2 ${st} 는 게이트웨이·중계가 넘어진 모양 — 다시 묻는다`);
  for (const st of [400, 401, 403, 404, 409]) ok(isTransientRequestError(httpErr(st)) === false, `T3 ${st} 는 서버가 판단해 거절한 것 — 다시 묻지 않는다`);
  ok(isTransientRequestError(null) === false && isTransientRequestError(undefined) === false,
    "T4 오류 객체가 없으면(새 헬퍼의 부재 입력) 판정 근거가 없어 다시 묻지 않는다");
  ok(isTransientRequestError(httpErr(499)) === false && isTransientRequestError(httpErr(505)) === false,
    "T5 경계 — 499·505 는 끊김 목록 밖이다");

  // ── R — 재시도 runner ────────────────────────────────────────────────────
  //  run 은 차례로 결과를 낸다: 값이면 성공, Error 면 던진다. 호출 수·잠 목록·onRetry 인자를 **부작용으로** 잰다.
  const script = (steps) => {
    const calls = { run: 0, slept: [], retries: [] };
    const run = async () => { const s = steps[Math.min(calls.run, steps.length - 1)]; calls.run++; if (s instanceof Error) throw s; return s; };
    const sleep = async (ms) => { calls.slept.push(ms); };
    const onRetry = (n, e) => { calls.retries.push([n, e?.status ?? "net"]); };
    return { calls, run, sleep, onRetry };
  };

  {
    const s = script(["ok"]);
    const v = await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry });
    ok(v === "ok" && s.calls.run === 1 && s.calls.slept.length === 0, "R1 첫 시도에 성공하면 한 번만 부르고 기다리지 않는다", show(s.calls));
  }
  {
    const s = script([netErr(), "ok"]);
    const v = await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry });
    ok(v === "ok" && s.calls.run === 2 && show(s.calls.slept) === show([1500]) && show(s.calls.retries) === show([[1, "net"]]),
      "R2 네트워크 실패 뒤 1.5초 기다렸다 다시 불러 성공한다(onRetry 1회)", show(s.calls));
  }
  {
    const s = script([httpErr(503), httpErr(502), "ok"]);
    const v = await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry });
    ok(v === "ok" && s.calls.run === 3 && show(s.calls.slept) === show([1500, 3000]), "R3 503 → 502 → 성공 — 기다림이 1.5·3초로 는다", show(s.calls));
  }
  {
    const s = script([httpErr(409), "ok"]);
    let thrown = null;
    try { await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry }); } catch (e) { thrown = e; }
    ok(thrown?.status === 409 && s.calls.run === 1 && s.calls.slept.length === 0 && s.calls.retries.length === 0,
      "R4 409 는 다시 묻지 않고 그 오류를 그대로 던진다(사람에게 사유를 바로 보인다)", show(s.calls));
  }
  {
    const s = script([httpErr(503)]);
    let thrown = null;
    try { await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry }); } catch (e) { thrown = e; }
    ok(thrown?.status === 503 && s.calls.run === 1 + RESTORE_RETRY_DELAYS_MS.length && show(s.calls.slept) === show([...RESTORE_RETRY_DELAYS_MS]),
      "R5 계속 끊기면 정해진 횟수(1+3)만 부르고 마지막 오류를 던진다", show(s.calls));
    ok(show([...RESTORE_RETRY_DELAYS_MS]) === show([1500, 3000, 6000]), "R5b 기다림 표는 1.5·3·6초(합 10.5초 — 롤 교대 창을 넘길 만큼)");
  }
  {
    const s = script([httpErr(503), "ok"]);
    let stop = false;
    let thrown = null;
    try { await withRetry(s.run, { sleep: async (ms) => { s.calls.slept.push(ms); stop = true; }, stop: () => stop, onRetry: s.onRetry }); } catch (e) { thrown = e; }
    ok(thrown?.status === 503 && s.calls.run === 1, "R6 기다리는 사이 화면이 사라지면(stop) 더 부르지 않고 오류를 던진다", show(s.calls));
    const s2 = script([httpErr(503), "ok"]);
    let thrown2 = null;
    try { await withRetry(s2.run, { sleep: s2.sleep, stop: () => true, onRetry: s2.onRetry }); } catch (e) { thrown2 = e; }
    ok(thrown2?.status === 503 && s2.calls.run === 1 && s2.calls.slept.length === 0, "R6b 이미 멈춘 화면이면 기다리지도 않는다", show(s2.calls));
  }
  {
    const s = script([httpErr(503), httpErr(404), "ok"]);
    let thrown = null;
    try { await withRetry(s.run, { sleep: s.sleep, onRetry: s.onRetry }); } catch (e) { thrown = e; }
    ok(thrown?.status === 404 && s.calls.run === 2, "R7 끊김 뒤 4xx 가 오면 그 4xx 를 던지고 멈춘다", show(s.calls));
  }
  {
    const s = script([httpErr(503), "ok"]);
    let thrown = null;
    try { await withRetry(s.run, { delays: [], sleep: s.sleep, onRetry: s.onRetry }); } catch (e) { thrown = e; }
    ok(thrown?.status === 503 && s.calls.run === 1 && s.calls.slept.length === 0, "R8 기다림 표가 비었으면(부재 입력) 한 번만 부른다", show(s.calls));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed`);
