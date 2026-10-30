// #4135 — **자식 프로세스 출력 조각 모으기(`stream-text.ts`)** 의 사양 시험 — 사양 A(1–6)만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// 자식 프로세스 파이프는 출력을 여러 조각(Buffer)으로 준다. 조각 경계가 3바이트 한글 글자 **한가운데** 에 걸릴 수 있는데,
//  조각을 각각 문자열로 바꾼 뒤 이으면 그 글자가 U+FFFD(�)로 깨진다. 이 모듈은 조각을 모았다가 한 번에 UTF-8 로 푼다.
//
// ── 여기서 지키는 것 ─────────────────────────────────────────────────────────
//  A1. `decodeChunks` — 한글 UTF-8 바이트를 글자 한가운데에서 둘로(셋·넷으로) 자른 Buffer 들을 주면 원문 그대로(U+FFFD 없음).
//  A2. Buffer 조각과 문자열 조각이 섞여 있어도 순서대로 이어진 원문(문자열 조각은 이미 글자 — 그대로 잇는다).
//  A3. 빈 배열 → `""`. `Uint8Array` 조각도 Buffer 와 같이 취급.
//  A4. `collectText(stream)` — `"data"` 로 온 조각을 모아 두었다가 `get()` 때 `decodeChunks` 와 같은 결과. 여러 번 불러도 같은 값,
//      조각이 더 오면 그다음 `get()` 에 반영(누적).
//  A5. `collectText(null)` / `collectText(undefined)` — 던지지 않고 `get()` 이 `""`(stdio 가 ignore 인 자식).
//  A6. 스트림은 `EventEmitter` 로 흉내 낸다(`emit("data", Buffer)`) — 실제 자식 프로세스는 띄우지 않는다.
import test from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { decodeChunks, collectText } from "./stream-text.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const FFFD = "�";
const KO = "가나다";                                  // 3바이트 × 3 = 9바이트
const KO_BYTES = Buffer.from(KO, "utf8");
/** 한 바이트열을 주어진 경계(오름차순 인덱스)에서 잘라 조각 배열로 — 각 조각은 **독립된** Buffer(원본 view 가 아니다). */
function cut(bytes: Buffer, ...at: number[]): Buffer[] {
  const out: Buffer[] = [];
  let prev = 0;
  for (const i of [...at, bytes.length]) { out.push(Buffer.from(bytes.subarray(prev, i))); prev = i; }
  return out;
}
/** 종전 결함 재현 — 조각을 각각 문자열로 바꾼 뒤 잇는다. 시험 재료가 정말 글자 한가운데를 가르는지 확인하는 데 쓴다. */
const naiveJoin = (chunks: Buffer[]) => chunks.map((c) => c.toString("utf8")).join("");

/** `on("data")` 만 가진 가짜 스트림 — 사양 시그니처가 요구하는 최소 표면. 등록된 리스너를 기록한다. */
function minimalStream() {
  const calls: Array<[string, unknown]> = [];
  const listeners: Array<(d: Buffer | string) => void> = [];
  return {
    calls,
    on(ev: "data", cb: (d: Buffer | string) => void) { calls.push([ev, cb]); listeners.push(cb); return this; },
    push(d: Buffer | string) { for (const cb of listeners) cb(d); },
  };
}

// ═══ 재료 자체의 검증 — 시험이 무엇을 재는지 분명히 한다 ══════════════════════
test("★재료 — 「가나다」 를 [0..4)/[4..9) 로 자르면 종전 방식(조각별 toString)은 정말 U+FFFD 를 낸다", () => {
  assert.equal(KO_BYTES.length, 9, "시험 재료 오류: 가나다 는 9바이트여야 한다");
  const two = cut(KO_BYTES, 4);
  assert.equal(two.length, 2);
  assert.equal(two[0].length, 4); assert.equal(two[1].length, 5);
  const broken = naiveJoin(two);
  assert.ok(broken.includes(FFFD), `재료 오류: 경계가 글자 한가운데가 아니다: ${JSON.stringify(broken)}`);
  assert.notEqual(broken, KO);
});

// ═══ A1. decodeChunks — 글자 한가운데를 가르는 Buffer 조각 ═══════════════════
test("★A1 「가나다」 9바이트를 [0..4)/[4..9) 두 Buffer 로 주면 원문 그대로 — U+FFFD 없음", () => {
  const out = decodeChunks(cut(KO_BYTES, 4));
  assert.equal(out, KO);
  assert.ok(!out.includes(FFFD), `U+FFFD 가 섞였다: ${JSON.stringify(out)}`);
});

test("★A1 세 조각([0..2)/[2..5)/[5..9))·네 조각([0..1)/[1..4)/[4..7)/[7..9))으로 나눠도 원문 그대로", () => {
  const three = cut(KO_BYTES, 2, 5);
  const four = cut(KO_BYTES, 1, 4, 7);
  assert.equal(three.length, 3); assert.equal(four.length, 4);
  // 재료 확인 — 둘 다 모든 경계가 글자 한가운데다
  assert.ok(naiveJoin(three).includes(FFFD), "재료 오류(세 조각)");
  assert.ok(naiveJoin(four).includes(FFFD), "재료 오류(네 조각)");
  assert.equal(decodeChunks(three), KO, "세 조각");
  assert.equal(decodeChunks(four), KO, "네 조각");
});

test("★A1 어디서 자르든 — 두 조각의 모든 경계(1..8)·바이트 하나씩 아홉 조각 전부 원문 그대로", () => {
  for (let i = 1; i < KO_BYTES.length; i++) {
    const out = decodeChunks(cut(KO_BYTES, i));
    assert.equal(out, KO, `경계 ${i}: ${JSON.stringify(out)}`);
  }
  const single = cut(KO_BYTES, 1, 2, 3, 4, 5, 6, 7, 8);
  assert.equal(single.length, 9);
  assert.ok(single.every((c) => c.length === 1));
  assert.equal(decodeChunks(single), KO, "바이트 하나씩");
});

test("★A1 한글·ASCII·4바이트(이모지)가 섞인 긴 본문도 — 모든 경계에서 잘라도 원문 그대로", () => {
  const text = "세션 box-a 준비 ✓ 완료 🚀 done\n두 번째 줄 — 끝";
  const bytes = Buffer.from(text, "utf8");
  assert.ok(bytes.length > text.length, "재료 오류: 다바이트 글자가 없다");
  for (let i = 1; i < bytes.length; i++) {
    const out = decodeChunks(cut(bytes, i));
    assert.equal(out, text, `경계 ${i}`);
  }
  // 임의의 세 경계
  assert.equal(decodeChunks(cut(bytes, 3, 7, bytes.length - 2)), text);
  // 자르지 않은 한 덩어리
  assert.equal(decodeChunks([Buffer.from(bytes)]), text);
});

// ═══ A2. Buffer 와 문자열이 섞인 조각 ═════════════════════════════════════════
test("★A2 Buffer 조각과 문자열 조각이 섞여 있어도 순서대로 이어진 원문 — 문자열 조각은 그대로 잇는다", () => {
  assert.equal(decodeChunks([Buffer.from("가나"), "다라", Buffer.from("마")]), "가나다라마");
  assert.equal(decodeChunks(["앞:", Buffer.from("가나다"), ":뒤"]), "앞:가나다:뒤");
  assert.equal(decodeChunks(["a", "b", "c"]), "abc", "문자열만");
  assert.equal(decodeChunks(["한글 문자열", " 그대로"]), "한글 문자열 그대로", "문자열 조각은 바이트로 해석하지 않는다");
});

test("★A2 문자열 조각 사이에 놓인 «글자 한가운데를 가르는 두 Buffer» 도 함께 풀려 원문 그대로", () => {
  const [h1, h2] = cut(KO_BYTES, 4);
  assert.ok(naiveJoin([h1, h2]).includes(FFFD), "재료 오류");
  const out = decodeChunks(["앞", h1, h2, "뒤"]);
  assert.equal(out, "앞가나다뒤");
  assert.ok(!out.includes(FFFD));
  // 세 조각 사이사이가 아니라 앞뒤로만 문자열 — 순서가 지켜진다
  assert.equal(decodeChunks([h1, h2, "!", Buffer.from("끝")]), "가나다!끝");
});

// ═══ A3. 빈 배열 · Uint8Array ═════════════════════════════════════════════════
test("★A3 빈 배열 → \"\" — 빈 Buffer·빈 문자열 조각만 있어도 \"\"", () => {
  assert.equal(decodeChunks([]), "");
  assert.equal(decodeChunks([Buffer.alloc(0)]), "");
  assert.equal(decodeChunks([""]), "");
  assert.equal(decodeChunks(["", Buffer.alloc(0), "", new Uint8Array(0)]), "");
});

test("★A3 Uint8Array 조각도 Buffer 와 같이 — 글자 한가운데를 가른 두 Uint8Array 가 원문 그대로", () => {
  const [h1, h2] = cut(KO_BYTES, 4);
  const u1 = new Uint8Array([...h1]);
  const u2 = new Uint8Array([...h2]);
  assert.ok(!Buffer.isBuffer(u1) && !Buffer.isBuffer(u2), "재료 오류: Buffer 가 아니어야 한다");
  assert.equal(decodeChunks([u1, u2]), KO);
  // Buffer 와 Uint8Array 가 섞여도, 문자열이 끼어도
  assert.equal(decodeChunks([h1, u2]), KO);
  assert.equal(decodeChunks([u1, h2]), KO);
  assert.equal(decodeChunks(["앞", u1, u2, "뒤"]), "앞가나다뒤");
});

test("★A3 큰 ArrayBuffer 의 일부만 가리키는 Uint8Array(byteOffset ≠ 0)도 그 구간만 읽는다", () => {
  // 앞뒤에 쓰레기 바이트를 두고 가운데 9바이트만 가리키는 view 를 만든다
  const ab = new ArrayBuffer(4 + 9 + 4);
  const all = new Uint8Array(ab);
  all.fill(0x58);                                   // 'X' 로 채움
  all.set(KO_BYTES, 4);
  const v1 = new Uint8Array(ab, 4, 4);              // 가 + 나의 첫 바이트
  const v2 = new Uint8Array(ab, 8, 5);              // 나의 나머지 + 다
  assert.equal(v1.byteOffset, 4); assert.equal(v2.byteOffset, 8);
  const out = decodeChunks([v1, v2]);
  assert.equal(out, KO, `구간 밖 바이트가 새어 들어왔다: ${JSON.stringify(out)}`);
});

// ═══ A4. collectText — 스트림에서 모아 두었다가 get() ═════════════════════════
test("★A4 \"data\" 로 온 조각을 모아 두었다가 get() 때 decodeChunks 와 같은 결과 — 글자를 가른 두 Buffer 가 원문 그대로", () => {
  const stream = new EventEmitter();
  const t = collectText(stream);
  const chunks = cut(KO_BYTES, 4);
  for (const c of chunks) stream.emit("data", c);
  assert.equal(t.get(), decodeChunks(chunks));
  assert.equal(t.get(), KO);
  assert.ok(!t.get().includes(FFFD));
});

test("★A4 get() 을 여러 번 불러도 같은 값 — 읽기가 모아 둔 것을 비우지 않는다", () => {
  const stream = new EventEmitter();
  const t = collectText(stream);
  stream.emit("data", Buffer.from("첫 줄\n"));
  stream.emit("data", Buffer.from("둘째 줄\n"));
  const first = t.get();
  assert.equal(first, "첫 줄\n둘째 줄\n");
  for (let i = 0; i < 5; i++) assert.equal(t.get(), first, `${i + 1}번째 get()`);
});

test("★A4 조각이 더 오면 그다음 get() 에 반영된다(누적) — 앞서 읽은 것까지 합쳐서", () => {
  const stream = new EventEmitter();
  const t = collectText(stream);
  assert.equal(t.get(), "", "아직 아무것도 오지 않았다");
  const [a1, a2] = cut(Buffer.from("가나다"), 4);
  stream.emit("data", a1); stream.emit("data", a2);
  assert.equal(t.get(), "가나다");
  const [b1, b2] = cut(Buffer.from("라마바"), 2);
  stream.emit("data", b1);
  stream.emit("data", b2);
  assert.equal(t.get(), "가나다라마바", "뒤에 온 조각이 누적되지 않았다");
  stream.emit("data", Buffer.from(" 끝"));
  assert.equal(t.get(), "가나다라마바 끝");
  assert.equal(t.get(), "가나다라마바 끝", "누적 뒤에도 여러 번 같은 값");
});

test("★A4 글자 한가운데에서 get() 을 끼워 불러도 — 나머지 반쪽이 오면 그다음 get() 은 원문 그대로", () => {
  const stream = new EventEmitter();
  const t = collectText(stream);
  const [h1, h2] = cut(KO_BYTES, 4);
  stream.emit("data", h1);
  let mid: string | undefined;
  assert.doesNotThrow(() => { mid = t.get(); });
  assert.equal(typeof mid, "string");
  assert.ok(mid!.startsWith("가"), `반쪽만 왔을 때: ${JSON.stringify(mid)}`);
  stream.emit("data", h2);
  const out = t.get();
  assert.equal(out, KO, `중간 get() 이 모아 둔 바이트를 망가뜨렸다: ${JSON.stringify(out)}`);
  assert.equal(t.get(), KO);
});

test("★A4 문자열 조각과 Buffer 조각이 섞여 와도 순서대로 — decodeChunks 와 같은 결과", () => {
  const stream = new EventEmitter();
  const t = collectText(stream);
  const [h1, h2] = cut(KO_BYTES, 4);
  const seq: Array<Buffer | string> = ["앞", h1, h2, "뒤", Buffer.from("끝")];
  for (const c of seq) stream.emit("data", c);
  assert.equal(t.get(), decodeChunks(seq));
  assert.equal(t.get(), "앞가나다뒤끝");
});

test("★A4 스트림마다 따로 모은다 — 두 collectText 가 서로 섞이지 않는다(stdout·stderr)", () => {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const o = collectText(out);
  const e = collectText(err);
  out.emit("data", Buffer.from("표준 출력"));
  err.emit("data", Buffer.from("표준 오류"));
  out.emit("data", Buffer.from(" 더"));
  assert.equal(o.get(), "표준 출력 더");
  assert.equal(e.get(), "표준 오류");
});

test("★A4 시그니처대로 on(\"data\", cb) 만 있는 객체로도 된다 — 리스너 하나를 \"data\" 에 건다", () => {
  const s = minimalStream();
  const t = collectText(s);
  assert.ok(s.calls.length >= 1, "on() 이 불리지 않았다");
  assert.ok(s.calls.every(([ev, cb]) => ev === "data" && typeof cb === "function"), `엉뚱한 이벤트/콜백: ${JSON.stringify(s.calls.map(([ev]) => ev))}`);
  const [h1, h2] = cut(KO_BYTES, 4);
  s.push(h1); s.push(h2); s.push(" 끝");
  assert.equal(t.get(), "가나다 끝");
});

// ═══ A5. null / undefined 스트림 ══════════════════════════════════════════════
test("★A5 collectText(null) — 던지지 않고 get() 이 \"\"(여러 번 불러도)", () => {
  let t: { get(): string } | undefined;
  assert.doesNotThrow(() => { t = collectText(null); });
  assert.ok(t, "반환이 없다");
  assert.equal(typeof t!.get, "function");
  assert.equal(t!.get(), "");
  assert.equal(t!.get(), "");
});

test("★A5 collectText(undefined) — 던지지 않고 get() 이 \"\"(stdio 가 ignore 인 자식)", () => {
  let t: { get(): string } | undefined;
  assert.doesNotThrow(() => { t = collectText(undefined); });
  assert.ok(t, "반환이 없다");
  assert.equal(t!.get(), "");
  assert.equal(t!.get(), "");
  // 변수에 담긴 undefined(옵셔널 체인 결과 같은 꼴)도 같다
  const stdio: { stdout?: EventEmitter } = {};
  let u: { get(): string } | undefined;
  assert.doesNotThrow(() => { u = collectText(stdio.stdout); });
  assert.equal(u!.get(), "");
});

// ═══ A6. 스트림은 EventEmitter 로 흉내 — 자식 프로세스 없이 ═════════════════════
test("★A6 EventEmitter 로 흉내 낸 스트림에 collectText 가 \"data\" 리스너를 건다 — emit 이 true(받는 이가 있다)", () => {
  const stream = new EventEmitter();
  assert.equal(stream.emit("data", Buffer.from("x")), false, "재료 오류: 아직 리스너가 없어야 한다");
  const t = collectText(stream);
  assert.ok(stream.listenerCount("data") >= 1, "\"data\" 리스너가 없다");
  assert.equal(stream.emit("data", Buffer.from("가")), true, "emit 을 받는 리스너가 없다");
  assert.equal(t.get(), "가", "collectText 이전에 emit 된 조각은 모이지 않고, 이후 것만 모인다");
});
