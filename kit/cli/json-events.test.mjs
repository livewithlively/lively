// 앱↔CLI 계약(#1541 T1) — NDJSON 이벤트 인코딩 · 답 파싱 · 프롬프트 채널 · 줄 리더.
//  프로세스를 띄우지 않고 검증하는 층(엣지 전수). 실제 CLI 를 스폰하는 통합 검증은 lively-json-events.test.mjs.
//  ⚠ 구현은 lively.mjs **안에** 있다 — 부트스트랩이 그 한 파일만 내려받기 때문(형제 모듈이면 설치 이전 명령이 깨진다).
// 실행: node kit/cli/json-events.test.mjs
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EVENT_V, encodeEvent, parseAnswer, createEmitter, createPrompter, lineReader, stripAnsi } from "./lively.mjs";
const ESC = "\u001b";   // 소스엔 리터럴 제어문자를 넣지 않는다

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── A. 인코딩 ────────────────────────────────────────────────────────────────
t("A1 이벤트 1건 = 정확히 한 줄(끝 개행 1개) · JSON.parse 가능", () => {
  const line = encodeEvent("step", { id: "x", status: "start" }, 1700000000000);
  assert.equal(line.split("\n").length, 2, "줄바꿈이 1개여야 한다(마지막 하나)");
  assert.ok(line.endsWith("\n"));
  const o = JSON.parse(line);
  assert.equal(o.t, "step"); assert.equal(o.id, "x"); assert.equal(o.ts, 1700000000000);
});

t("A2 개행·따옴표·유니코드가 섞여도 한 줄을 유지한다", () => {
  // 여기가 깨지면 한 이벤트가 여러 줄로 쪼개져 앱의 줄 단위 파서가 통째로 어긋난다.
  const msg = 'line1\nline2\t"quoted" 한글 🚀 \\backslash';
  const line = encodeEvent("notice", { level: "warn", message: msg }, 1);
  assert.equal(line.split("\n").length, 2);
  assert.equal(JSON.parse(line).message, msg, "왕복 복원");
});

t("A3 봉투(v·t·ts)는 항상 있다", () => {
  const o = JSON.parse(encodeEvent("end", { ok: true, code: 0 }, 42));
  assert.equal(o.v, EVENT_V); assert.equal(o.t, "end"); assert.equal(o.ts, 42);
});

t("A4 payload 는 봉투를 덮어쓸 수 없다(위조 방지)", () => {
  const o = JSON.parse(encodeEvent("step", { v: 999, t: "end", ts: 0, id: "x" }, 7));
  assert.equal(o.v, EVENT_V, "버전 위조");
  assert.equal(o.t, "step", "타입 위조 — 앱이 end 로 오인해 성공 처리한다");
  assert.equal(o.ts, 7);
  assert.equal(o.id, "x", "봉투가 아닌 필드는 그대로 실린다");
});

t("A5 payload 가 없거나 객체가 아니어도 유효한 한 줄", () => {
  for (const p of [undefined, null, "문자열", 42, ["a"]]) {
    const o = JSON.parse(encodeEvent("start", p, 1));
    assert.equal(o.t, "start"); assert.equal(o.v, EVENT_V);
  }
});

t("A6 직렬화 불가(순환참조)여도 throw 하지 않고 이벤트를 낸다", () => {
  // 진행 보고가 명령을 죽이면 안 된다. 대신 '못 실었다'를 앱이 알 수 있어야 한다(조용한 유실 금지).
  const cyc = { a: 1 }; cyc.self = cyc;
  let line;
  assert.doesNotThrow(() => { line = encodeEvent("step", cyc, 5); });
  const o = JSON.parse(line);
  assert.equal(o.t, "notice"); assert.equal(o.level, "warn");
  assert.match(o.message, /직렬화 실패/);
});

// ── B. 답 파싱 ───────────────────────────────────────────────────────────────
t("B1 정상 답 → {id, value}", () => {
  assert.deepEqual(parseAnswer('{"t":"answer","id":"x","value":true}'), { id: "x", value: true });
  assert.deepEqual(parseAnswer('{"t":"answer","id":"secret","value":"lvk_abc"}'), { id: "secret", value: "lvk_abc" });
  assert.deepEqual(parseAnswer('{"t":"answer","id":"x","value":false}'), { id: "x", value: false }, "false 도 유효한 답이다");
});

t("B2 잡음(빈 줄·비-JSON·배열·원시값) → null", () => {
  for (const s of ["", "   ", "not json", "[1,2]", '"str"', "null", "42"]) {
    assert.equal(parseAnswer(s), null, `잡음이 답으로 통과: ${s}`);
  }
});

t("B3 t 가 answer 가 아니면 null", () => {
  assert.equal(parseAnswer('{"t":"cancel","id":"x","value":true}'), null);
  assert.equal(parseAnswer('{"id":"x","value":true}'), null);
});

t("B4 id 가 없거나 빈 문자열이면 null", () => {
  assert.equal(parseAnswer('{"t":"answer","value":true}'), null);
  assert.equal(parseAnswer('{"t":"answer","id":"","value":true}'), null);
  assert.equal(parseAnswer('{"t":"answer","id":123,"value":true}'), null);
});

t("B5 ★ value 가 없으면 null — 빈 답이 '기본값 승인'이 되면 안 된다", () => {
  assert.equal(parseAnswer('{"t":"answer","id":"x"}'), null);
  // 반대로 명시적 null/undefined-like 값은 답이다(사람이 고른 값일 수 있다).
  assert.deepEqual(parseAnswer('{"t":"answer","id":"x","value":null}'), { id: "x", value: null });
});

// ── C. 프롬프트 채널 ─────────────────────────────────────────────────────────
// 부작용(발행된 이벤트·resolve/reject)으로 판정한다.
function harness() {
  const lines = [], out = [];
  let endCb = null;
  const emitter = createEmitter({ write: (l) => out.push(JSON.parse(l)), now: () => 1 });
  const p = createPrompter({
    emit: emitter.emit,
    onLine: (cb) => lines.push(cb),
    onEnd: (cb) => { endCb = cb; },
  });
  return { p, out, feed: (l) => lines.forEach((cb) => cb(l)), end: () => endCb && endCb() };
}

await ta("C1 확인 요청 → prompt 이벤트 1건, 같은 id 답이 오면 그 값", async () => {
  const h = harness();
  const got = h.p.ask("confirm-1", "confirm", { label: "계속할까요?", default: true });
  assert.equal(h.out.length, 1);
  assert.equal(h.out[0].t, "prompt");
  assert.equal(h.out[0].id, "confirm-1");
  assert.equal(h.out[0].kind, "confirm");
  assert.equal(h.out[0].label, "계속할까요?");
  h.feed('{"t":"answer","id":"confirm-1","value":false}');
  assert.equal(await got, false);
});

await ta("C2 ★ 다른 id 의 답으로는 절대 풀리지 않는다", async () => {
  // 여기가 깨지면 '설치할까요?' 의 예 가 '이 계정으로 로그인됩니다' 의 예 로 쓰인다.
  const h = harness();
  let settled = false;
  const got = h.p.ask("identity", "confirm", { label: "이 계정?" }).then((v) => { settled = true; return v; });
  h.feed('{"t":"answer","id":"other","value":true}');
  await sleep(10);
  assert.equal(settled, false, "엉뚱한 답으로 풀렸다");
  assert.equal(h.p.pending, 1);
  h.feed('{"t":"answer","id":"identity","value":true}');
  assert.equal(await got, true);
});

await ta("C3 잡음 줄이 섞여도 계속 기다린다", async () => {
  const h = harness();
  const got = h.p.ask("q", "confirm", {});
  for (const noise of ["", "쓰레기", "{bad json", '{"t":"log","msg":"x"}', '{"t":"answer","id":"q"}']) h.feed(noise);
  await sleep(10);
  assert.equal(h.p.pending, 1, "잡음(value 없는 답 포함)에 풀리면 안 된다");
  h.feed('{"t":"answer","id":"q","value":true}');
  assert.equal(await got, true);
});

await ta("C4 ★ 답 없이 stdin 이 닫히면 reject — 기본값으로 조용히 승인하지 않는다", async () => {
  const h = harness();
  const got = h.p.ask("identity", "confirm", { label: "이 계정?", default: true });
  h.end();
  await assert.rejects(got, /연결이 끊겼/);
  // 닫힌 뒤의 새 요청도 즉시 실패한다(닫힌 채널에 물어보고 영원히 매달리지 않게).
  await assert.rejects(h.p.ask("again", "confirm", {}), /연결이 끊겼/);
});

await ta("C5 프롬프트 2건이 동시에 떠도 각자 자기 답을 받는다", async () => {
  const h = harness();
  const a = h.p.ask("a", "confirm", {});
  const b = h.p.ask("b", "secret", {});
  assert.equal(h.p.pending, 2);
  h.feed('{"t":"answer","id":"b","value":"토큰값"}');   // 나중 것 먼저 답이 와도
  h.feed('{"t":"answer","id":"a","value":true}');
  assert.equal(await a, true);
  assert.equal(await b, "토큰값");
});

await ta("C6 tell(통지형)은 답을 기다리지 않는다", async () => {
  const h = harness();
  h.p.tell("device-code", "device-code", { user_code: "ABCD-1234", verification_uri: "https://gw/device" });
  assert.equal(h.p.pending, 0);
  assert.equal(h.out[0].kind, "device-code");
  assert.equal(h.out[0].user_code, "ABCD-1234");
});

// ── D. 줄 리더 — 청크 경계 ───────────────────────────────────────────────────
await ta("D1 청크가 줄 중간에서 잘려도 답이 유실되지 않는다", async () => {
  const s = new PassThrough();
  const got = [];
  const r = lineReader(s);
  r.onLine((l) => got.push(l));
  s.write('{"t":"answer","id":"a"');    // 줄 중간에서 끊김
  s.write(',"value":true}\n{"t":"ans');  // 다음 줄이 이어서 시작
  s.write('wer","id":"b","value":1}\n');
  await sleep(10);
  assert.deepEqual(got.map((l) => parseAnswer(l)), [{ id: "a", value: true }, { id: "b", value: 1 }]);
});

await ta("D2 마지막 줄에 개행이 없어도 end 직전에 전달된다", async () => {
  const s = new PassThrough();
  const got = [];
  let ended = false;
  const r = lineReader(s);
  r.onLine((l) => got.push(l)); r.onEnd(() => { ended = true; });
  s.end('{"t":"answer","id":"z","value":true}');   // 개행 없이 종료
  await sleep(10);
  assert.deepEqual(got.map(parseAnswer), [{ id: "z", value: true }]);
  assert.equal(ended, true, "end 콜백이 안 오면 프롬프트가 영원히 매달린다");
});

// ── E. ANSI 제거 — CLI 를 스폰하는 테스트로는 **영영 못 재는** 층 ────────────
//  stderr 가 파이프면 색이 아예 안 붙어(TTY=false) 실전 입력이 한 번도 안 들어온다. 여기서 직접 먹인다.
t("E1 색 시퀀스를 ESC 까지 통째로 지운다(ESC 만 남기면 GUI 표시가 깨진다)", () => {
  assert.equal(stripAnsi(ESC + "[1m굵게" + ESC + "[0m"), "굵게");
  assert.equal(stripAnsi(ESC + "[32m✓" + ESC + "[0m 완료"), "✓ 완료");
  assert.ok(!stripAnsi(ESC + "[31m✗ 실패" + ESC + "[0m").includes(ESC), "보이지 않는 ESC 가 남았다");
});

t("E2 색 말고 다른 CSI(커서 이동·지우기)도 지운다", () => {
  assert.equal(stripAnsi(ESC + "[2K" + ESC + "[1G진행중"), "진행중");
  assert.equal(stripAnsi(ESC + "[?25l숨김" + ESC + "[?25h"), "숨김");
});

t("E3 평범한 문구·대괄호는 그대로 둔다(과잉 제거 금지)", () => {
  assert.equal(stripAnsi("[1/3] 키트 내려받는 중…"), "[1/3] 키트 내려받는 중…");
  assert.equal(stripAnsi("경로: C:\\Users\\yoon [ok] 한글 🚀"), "경로: C:\\Users\\yoon [ok] 한글 🚀");
  assert.equal(stripAnsi(""), "");
  assert.equal(stripAnsi(undefined), "undefined");
});

console.log(`\n${pass} passed`);
