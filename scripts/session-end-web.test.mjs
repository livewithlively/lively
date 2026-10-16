// #4783 — 꺼진 세션의 겉모습(누가 끝냈나)과 그 이름을 고정한다. 사양: 스크래치패드 spec.md 표 F.
//  컴파일 결과(public/app/session-status.js · public/app/session-end-copy.js)를 그대로 import 한다(DOM 무의존 순수 모듈).
//  틀리면 티가 크다:
//   🔴 시스템이 끈 세션을 «지난 세션» 으로 접으면 — 답을 기다리던 질문·안 본 결과가 사이드바에서 사라진다(이번 신고 그 자체).
//   🔴 사람이 끝낸 세션을 끄기 직전 모습으로 두면 — /exit 한 세션이 «작업 완료» 로 다시 뜬다.
//   🔴 오류를 «확인 필요» 와 같은 점으로 그리면 — «답할 것» 과 «고장» 이 안 갈린다.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(pathToFileURL(path.join(ROOT, "public/app/session-status.js")).href);
const C = await import(pathToFileURL(path.join(ROOT, "public/app/session-end-copy.js")).href);

const NOW = 1_800_000_000_000;
const sec = NOW / 1000;
const stopped = (o) => ({ restorable: true, agentState: "offline", ...o });

test("F1 누가 끝냈나 — 사람(/exit·멈춤·하네스 정상 종료) · 고장(크래시·기동 실패·사라짐·메모리) · 시스템(회수·T5) · 모름", () => {
  const rows = [
    [{ exitedByUser: true }, "user"],
    [{ endNote: { why: "stop", at: sec } }, "user"],
    [{ endNote: { why: "harness_exit", at: sec, code: 0 } }, "user"],
    [{ endNote: { why: "harness_crash", at: sec, code: 1 } }, "error"],
    [{ endNote: { why: "launch_fail", at: sec, code: 1 } }, "error"],
    [{ endNote: { why: "lost", at: sec } }, "error"],
    [{ oomKilled: true }, "error"],
    [{ endNote: { why: "reclaim", at: sec } }, "system"],
    [{ stopNote: { why: "done", at: sec } }, "system"],
    [{ stopNote: { why: "asking", at: sec } }, "system"],
    [{ stopNote: { why: "exited", at: sec } }, "unknown"],
    [{}, "unknown"],
    [{ endNote: { why: "nope", at: sec } }, "unknown"],
  ];
  for (const [o, want] of rows) assert.equal(S.sessEndKind(stopped(o)), want, JSON.stringify(o));
  //  같은 판의 끝난 사유가 판을 넘어 남을 수 있는 T5 쪽지보다 먼저다 — 되살린 판이 크래시로 끝났는데 지난 판의 «완료» 쪽지가 남아 있어도 고장이다.
  assert.equal(S.sessEndKind(stopped({ endNote: { why: "harness_crash", at: sec }, stopNote: { why: "done", at: sec - 999 } })), "error");
  assert.equal(S.sessEndKind(stopped({ endNote: { why: "stop", at: sec }, stopNote: { why: "asking", at: sec - 999 } })), "user");
  assert.equal(S.sessEndKind(null), "unknown");
});

test("F2 점 — 고장은 오류(7일) · 시스템이 끈 것은 끄기 직전 모습(질문=확인 필요 7일 · 안 본 결과=작업 완료 24시간) · 사람·모름은 점 없음", () => {
  const d = (o, now = NOW) => S.stoppedDotKey(stopped(o), now);
  assert.equal(d({ endNote: { why: "harness_crash", at: sec - 3600 } }), "error");
  assert.equal(d({ endNote: { why: "lost", at: sec - 7 * 86400 } }), "error", "경계 — 정확히 7일은 아직 오류");
  assert.equal(d({ endNote: { why: "lost", at: sec - 7 * 86400 - 1 } }), "", "7일 넘은 고장은 이력");
  assert.equal(d({ oomKilled: true }), "error", "시각을 모르는 고장도 오류(메모리 부족)");
  assert.equal(d({ stopNote: { why: "asking", at: sec - 3600 } }), "waiting");
  assert.equal(d({ stopNote: { why: "asking", at: sec - 3600 }, endNote: { why: "reclaim", at: sec - 3600, seen: true } }), "waiting", "질문은 seen 과 무관");
  assert.equal(d({ stopNote: { why: "asking", at: sec - 8 * 86400 } }), "", "8일 전 질문은 이력");
  assert.equal(d({ endNote: { why: "reclaim", at: sec - 600, seen: false } }), "done");
  assert.equal(d({ endNote: { why: "reclaim", at: sec - 86400, seen: false } }), "done", "경계 — 정확히 24시간은 아직 작업 완료");
  assert.equal(d({ endNote: { why: "reclaim", at: sec - 86400 - 1, seen: false } }), "");
  assert.equal(d({ endNote: { why: "reclaim", at: sec - 600, seen: true } }), "", "본 결과는 점 없음");
  assert.equal(d({ endNote: { why: "reclaim", at: sec - 600 } }), "", "봤는지 모르면 점 없음(지어내지 않는다)");
  assert.equal(d({ stopNote: { why: "done", at: sec - 600 } }), "", "T5 완료 쪽지만 있고 seen 을 모르면 점 없음");
  assert.equal(d({ exitedByUser: true, endNote: { why: "reclaim", at: sec - 600, seen: false } }), "", "사람이 끝냈으면 작업 완료로 안 세운다");
  assert.equal(d({ endNote: { why: "stop", at: sec } }), "");
  assert.equal(d({}), "");
});

test("F3 지난 세션(흐림·접힘)은 사람이 끝냈거나 사유를 모를 때(종전 그대로) — 시스템이 끈 것·고장은 보통 줄", () => {
  const p = (o) => S.stoppedIsPast(stopped(o));
  assert.equal(p({ exitedByUser: true }), true);
  assert.equal(p({ endNote: { why: "stop", at: sec } }), true);
  assert.equal(p({ endNote: { why: "harness_exit", at: sec } }), true);
  assert.equal(p({ endNote: { why: "reclaim", at: sec } }), false);
  assert.equal(p({ stopNote: { why: "asking", at: sec } }), false);
  assert.equal(p({ endNote: { why: "lost", at: sec } }), false);
  assert.equal(p({}), true, "사유를 모르면 종전 그대로 지난 세션(옛 판 · 끝을 보고하지 않는 판의 정상 종료가 여기 든다)");
  assert.equal(p({ stopNote: { why: "exited", at: sec } }), true);
});

test("F4 오류 점은 확인 필요와 다른 모양 · 점 상태에 든다 · 생사·필터 어휘는 안 바뀐다", () => {
  assert.equal(S.isDotState("error"), true);
  assert.equal(S.rowDotCls("error"), "err");
  assert.notEqual(S.rowDotCls("error"), S.rowDotCls("waiting"));
  assert.equal(S.rowDotCls("waiting"), "wait");
  assert.ok(S.SESS_STATES.error && S.SESS_STATES.error.label === "오류");
  assert.ok(!S.SESS_STATE_KEYS.includes("error"), "필터 어휘에는 안 든다(sessStateKey 가 이 값을 내지 않는다)");
  //  꺼진 세션의 생사 판정은 그대로 — 고장으로 끝난 세션도 «죽었다»(터미널을 붙이지 않는다).
  assert.equal(S.sessIsDead(stopped({ endNote: { why: "harness_crash", at: sec } })), true);
  assert.equal(S.sessIsDead(stopped({ stopNote: { why: "asking", at: sec } })), true);
});

test("F5 꺼진 세션의 이름 — 누가 끝냈나로 부르고, 모르면 비운다(종전 말로 떨어진다)", () => {
  const n = (o) => C.endedSessPhrase(stopped(o));
  assert.equal(n({ exitedByUser: true }), "직접 끝낸 세션");
  assert.equal(n({ endNote: { why: "stop", at: sec } }), "직접 끝낸 세션");
  assert.equal(n({ endNote: { why: "harness_crash", at: sec } }), "AI 가 오류로 끝난 세션");
  assert.equal(n({ endNote: { why: "launch_fail", at: sec } }), "AI 가 뜨자마자 끝난 세션");
  assert.equal(n({ endNote: { why: "lost", at: sec } }), "끝난 이유를 알 수 없는 세션", "사라짐은 원인을 단정하지 않는다");
  assert.equal(n({ oomKilled: true }), "메모리가 모자라 멈춘 세션");
  assert.equal(n({ endNote: { why: "reclaim", at: sec } }), "시스템이 잠시 꺼 둔 세션", "회수만으로는 «작업이 끝나» 를 단정하지 않는다");
  assert.equal(n({ endNote: { why: "reclaim", at: sec }, stopNote: { why: "done", at: sec } }), "작업이 끝나 잠시 꺼 둔 세션");
  assert.equal(n({ stopNote: { why: "asking", at: sec } }), "답을 기다리다 잠시 꺼 둔 세션");
  assert.equal(n({}), "");
  assert.equal(C.endedSessPhrase(null), "");
  //  액자가 넘긴 사실(endFactsOf 모양) → 같은 판정
  assert.equal(C.endedSessPhrase(C.sessLikeOfFacts({ endWhy: "harness_crash", endCode: 1 })), "AI 가 오류로 끝난 세션");
  assert.equal(C.endedSessPhrase(C.sessLikeOfFacts({ exitedByUser: true })), "직접 끝낸 세션");
  assert.equal(C.endedSessPhrase(C.sessLikeOfFacts({ stopWhy: "asking" })), "답을 기다리다 잠시 꺼 둔 세션");
  assert.equal(C.endedSessPhrase(C.sessLikeOfFacts(null)), "");
  //  이름은 전부 «세션» 으로 끝난다 — 부르는 쪽이 «이에요» 를 붙인다(받침 있는 글자).
  for (const o of [{ exitedByUser: true }, { endNote: { why: "lost", at: sec } }, { endNote: { why: "reclaim", at: sec } }]) assert.match(n(o), /세션$/);
});
