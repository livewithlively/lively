#!/usr/bin/env node
// 앱 동의 창의 «AI 실행» 줄이 이 앱의 AI 가 실제로 어느 계정으로 도는지 말한다 — 실행 계정 결정 + 문구 + 화면 배선.
//
//  왜: 종전 «AI 실행» 줄은 «워크스페이스 API 키가 있으면 그 돈으로, 없으면 내 Claude 구독으로 돌아요» 라는 고정 문구라,
//   공용 계정(공용 시트)으로 도는 앱에서도 «내 구독» 이라고 잘못 말했다. 구성원은 그 말을 보고 동의한다.
//  기준: 사양(작업별 > 앱별 > 워크스페이스 기본 > API 키 > 계정 없음 · 본인 구독으로 넘어가는 길은 없다)만 보고 쓴 시험이다.
//  ⚠ 재는 대상은 빌드 산출물(public/app/lib/ai-run-consent.js) — lane-job-note.test.mjs 와 같은 관례.
//  ⚠ 배선 시험(W*)은 소스 글을 실패 메시지에 싣지 않는다(assert.ok + 메시지만) — 화면 코드가 출력에 쏟아지지 않게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { aiRunConsentText } = await import(pathToFileURL(join(ROOT, 'public/app/lib/ai-run-consent.js')).href);
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── 사양의 글귀 ──────────────────────────────────────────────────────────────
const START = '이 앱이 AI에게 일을 시킬 수 있어요.';
const END = '실행 기록은 이 앱의 AI 실행 목록에 남아요.';
const NONE = '정해지지 않아 AI 실행이 되지 않아요';
const API = '워크스페이스 API 키로 돌아요';
const NOT_MINE = '내 Claude 구독은 쓰지 않아요';
const MINE = '내 Claude 구독으로 돌아요';
const SEAT_OFF = '공용 계정 지정이 아직 켜지지 않아';
const NO_SEAT = '본인이나 그분 세션에 초대받은 사람';
const MIXED = '작업마다 실행 계정이 달라요';
const UNKNOWN = '워크스페이스가 정한 실행 계정';
const OLD_FALLBACK = '없으면 내 Claude 구독으로 돌아요';
const OLD_FIXED = '워크스페이스 API 키가 있으면 그 돈으로, 없으면 내 Claude 구독으로 돌아요';
const seatName = (m) => `공용 계정(${m})`; // 공용 계정 — 한 문장에도, 작업마다의 짧은 이름에도 같은 글귀
const othersRuns = (m) => `${m}님의 Claude 구독으로 돌아요`;
// 작업마다 다를 때 늘어놓는 짧은 이름
const SHORT_API = '워크스페이스 API 키';
const SHORT_NONE = '정해지지 않음';
const shortOthers = (m) => `${m}님의 Claude 구독`;
// «내 Claude 구독» 짧은 이름 — «내 Claude 구독은 쓰지 않아요» 안의 같은 글자는 세지 않는다
const mineShortCount = (t) => (t.match(/내 Claude 구독(?!은 쓰지 않아요)/g) || []).length;
const count = (t, s) => t.split(s).length - 1;

// ── 차림 ─────────────────────────────────────────────────────────────────────
const APP = 'app-1';
const OTHER_APP = 'app-10'; // 이름이 APP 으로 시작하는 다른 앱 — 앞부분 일치로 섞이지 않는지도 같이 본다
const ME = 'mem-me';
const KIM = 'mem-kim';
const LEE = 'mem-lee';
const SEAT = 'mem-seat';
const apiKey = () => ({ kind: 'api_key' });
const sub = (member) => ({ kind: 'subscription', member });
const run = (snap, meId = ME, appId = APP) => aiRunConsentText(snap, appId, meId);
const show = (snap) => JSON.stringify(snap) ?? String(snap);

const has = (t, s) => assert.ok(t.includes(s), `«${s}» 가 없다 — 받은 문구: ${t}`);
const lacks = (t, s) => assert.ok(!t.includes(s), `«${s}» 가 있으면 안 된다 — 받은 문구: ${t}`);
const once = (t, s) => assert.equal(count(t, s), 1, `«${s}» 가 한 번이 아니다(${count(t, s)}번) — 받은 문구: ${t}`);

// ── 시작 · 끝 문장 ───────────────────────────────────────────────────────────
const FIXTURES = [
  ['snap null', null, ME],
  ['snap undefined', undefined, ME],
  ['빈 snap', {}, ME],
  ['API 키만 등록', { api_key_registered: true }, ME],
  ['남의 구독 · 공용 계정 지정 없음', { settings: { default: sub(KIM) } }, ME],
  ['본인 구독', { settings: { default: sub(ME) } }, ME],
  ['공용 계정 지정 켜짐', { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: true }] }, ME],
  ['공용 계정 지정 꺼짐', { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: false }] }, ME],
  ['작업마다 다름', { settings: { apps: { [APP]: { default: apiKey(), jobs: { a: sub(KIM), b: sub(ME) } } } }, api_key_registered: true }, ME],
  ['작업마다 다름 · 앱 기본은 계정 없음', { settings: { apps: { [APP]: { jobs: { a: sub(KIM) } } } } }, ME],
  ['meId 빈 글자', { settings: { default: sub(KIM) } }, ''],
  ['모양 틀린 칸만', { settings: { default: { kind: 'mystery' } } }, ME],
];

test('A1 ★ 어떤 경우든 «이 앱이 AI에게 일을 시킬 수 있어요.» 로 시작하고 «실행 기록은 이 앱의 AI 실행 목록에 남아요.» 로 끝난다', () => {
  for (const [label, snap, meId] of FIXTURES) {
    const t = run(snap, meId);
    assert.equal(typeof t, 'string', `${label}: 글이 아니다`);
    assert.ok(t.startsWith(START), `${label}: 시작 문장이 다르다 — 받은 문구: ${t}`);
    assert.ok(t.endsWith(END), `${label}: 끝 문장이 다르다 — 받은 문구: ${t}`);
  }
});

// ── 실행 계정 결정 순서: 작업별 > 앱별 > 워크스페이스 기본 > API 키 > 계정 없음 ──────────
test('D1 ★ 작업별 계정이 그 아래 단계를 이긴다 — 그 작업은 작업별 계정으로 돌아 «작업마다» 가 된다', () => {
  // 작업별(김 구독) vs 앱별(API 키)
  const a = run({ settings: { apps: { [APP]: { default: apiKey(), jobs: { nightly: sub(KIM) } } } }, api_key_registered: true });
  has(a, MIXED);
  has(a, shortOthers(KIM));
  has(a, SHORT_API);
  // 작업별(API 키) vs 앱별(김 구독) — 계정 종류가 아니라 단계가 이긴다
  const b = run({ settings: { apps: { [APP]: { default: sub(KIM), jobs: { nightly: apiKey() } } } }, api_key_registered: true });
  has(b, MIXED);
  has(b, SHORT_API);
  has(b, shortOthers(KIM));
  // 앱별이 없을 때: 작업별(김 구독) vs 워크스페이스 기본(이 구독)
  const c = run({ settings: { default: sub(LEE), apps: { [APP]: { jobs: { nightly: sub(KIM) } } } } });
  has(c, MIXED);
  has(c, shortOthers(KIM));
  has(c, shortOthers(LEE));
  // 앱별·워크스페이스 기본이 없을 때: 작업별(김 구독) vs 등록된 API 키
  const d = run({ settings: { apps: { [APP]: { jobs: { nightly: sub(KIM) } } } }, api_key_registered: true });
  has(d, MIXED);
  has(d, shortOthers(KIM));
  has(d, SHORT_API);
});

test('D2 ★ 앱별 계정이 워크스페이스 기본값을 이긴다', () => {
  const a = run({ settings: { default: apiKey(), apps: { [APP]: { default: sub(KIM) } } }, api_key_registered: true });
  has(a, othersRuns(KIM));
  lacks(a, API);
  lacks(a, '작업마다');
  // 거꾸로 — 계정 종류가 아니라 단계가 이긴다
  const b = run({ settings: { default: sub(KIM), apps: { [APP]: { default: apiKey() } } }, api_key_registered: true });
  has(b, API);
  lacks(b, KIM);
  lacks(b, '작업마다');
  // 둘 다 구독이면 앱별 구독의 주인
  const c = run({ settings: { default: sub(LEE), apps: { [APP]: { default: sub(KIM) } } } });
  has(c, othersRuns(KIM));
  lacks(c, LEE);
});

test('D3 ★ 워크스페이스 기본값이 등록된 API 키를 이긴다', () => {
  const t = run({ settings: { default: sub(KIM) }, api_key_registered: true });
  has(t, othersRuns(KIM));
  lacks(t, API);
});

test('D4 ★ 아무 계정도 정하지 않았으면 등록된 워크스페이스 API 키로 돈다 — 계정 없음보다 앞, 내 구독은 쓰지 않는다', () => {
  for (const snap of [
    { api_key_registered: true },
    { settings: {}, api_key_registered: true },
    { settings: { apps: { [APP]: {} } }, api_key_registered: true },
  ]) {
    const t = run(snap);
    has(t, API);
    has(t, NOT_MINE);
    lacks(t, NONE);
    lacks(t, MINE);
  }
});

test('D5 ★ API 키도 없으면 «계정 없음» — AI 실행이 되지 않는다고 말하고 내 구독으로 넘어가지 않는다', () => {
  for (const snap of [
    {},
    { api_key_registered: false },
    { settings: {}, api_key_registered: false, seats: [] },
    { settings: { apps: { [APP]: { jobs: {} } } } },
    // 공용 계정 지정 목록은 실행 계정을 정하지 않는다 — 나·남이 켜져 있어도 계정 없음
    { seats: [{ member: ME, on: true }, { member: KIM, on: true }] },
  ]) {
    const t = run(snap, ME);
    has(t, NONE);
    lacks(t, MINE);
    lacks(t, API);
  }
});

// ── 다른 앱 ──────────────────────────────────────────────────────────────────
test('O1 ★ 다른 앱의 앱별·작업별 계정은 끼어들지 않는다', () => {
  const other = { default: sub(KIM), jobs: { nightly: sub(LEE) } };
  // 이 앱 칸이 아예 없을 때 → 워크스페이스 기본값(API 키)
  const a = run({ settings: { default: apiKey(), apps: { [OTHER_APP]: other } }, api_key_registered: true });
  has(a, API);
  lacks(a, '작업마다');
  lacks(a, KIM);
  lacks(a, LEE);
  // 이 앱 칸이 비어 있고 다른 것도 없을 때 → 계정 없음
  const b = run({ settings: { apps: { [APP]: {}, [OTHER_APP]: other } } });
  has(b, NONE);
  lacks(b, '작업마다');
  lacks(b, KIM);
  lacks(b, LEE);
  // 작업별 계정이 다른 앱에만 있을 때 → 이 앱은 한 문장
  const c = run({ settings: { apps: { [APP]: { default: sub(KIM) }, [OTHER_APP]: { jobs: { nightly: apiKey(), weekly: sub(LEE) } } } }, api_key_registered: true });
  has(c, othersRuns(KIM));
  lacks(c, '작업마다');
  lacks(c, LEE);
});

test('O2 같은 snap 이라도 appId 가 가른다 — 물은 앱의 설정을 쓴다', () => {
  const snap = { settings: { apps: { [APP]: { default: sub(KIM) }, [OTHER_APP]: { default: apiKey() } } }, api_key_registered: true };
  has(run(snap, ME, APP), othersRuns(KIM));
  const t = run(snap, ME, OTHER_APP);
  has(t, API);
  lacks(t, KIM);
});

// ── 모양이 틀린 계정 칸 ──────────────────────────────────────────────────────
const MALFORMED = [
  ['member 없는 구독', { kind: 'subscription' }],
  ['모르는 kind', { kind: 'mystery' }],
  ['kind 없음', {}],
];

test('M1 ★ 모양이 틀린 앱별 계정은 없는 것으로 보고 다음 단계(워크스페이스 기본값)로 간다', () => {
  for (const [label, bad] of MALFORMED) {
    const t = run({ settings: { default: sub(KIM), apps: { [APP]: { default: bad } } }, api_key_registered: true });
    assert.ok(t.includes(othersRuns(KIM)), `${label}: 워크스페이스 기본값(${KIM})으로 가지 않았다 — 받은 문구: ${t}`);
    lacks(t, API);
    lacks(t, MINE);
  }
});

test('M2 ★ 모양이 틀린 워크스페이스 기본값도 건너뛴다 — member 없는 구독이 «내 구독» 이 되지 않는다', () => {
  for (const [label, bad] of MALFORMED) {
    const a = run({ settings: { default: bad }, api_key_registered: true }, ME);
    assert.ok(a.includes(API), `${label}: 등록된 API 키로 가지 않았다 — 받은 문구: ${a}`);
    lacks(a, MINE);
    const b = run({ settings: { default: bad } }, ME);
    assert.ok(b.includes(NONE), `${label}: 계정 없음으로 가지 않았다 — 받은 문구: ${b}`);
    lacks(b, MINE);
  }
});

test('M3 ★ 모양이 틀린 작업별 계정은 없는 것으로 본다 — 그 작업은 앱 계정으로 돌아 «작업마다» 가 되지 않는다', () => {
  const jobs = Object.fromEntries(MALFORMED.map(([, bad], i) => [`job${i}`, bad]));
  const a = run({ settings: { apps: { [APP]: { default: apiKey(), jobs } } }, api_key_registered: true });
  has(a, API);
  lacks(a, '작업마다');
  lacks(a, MINE);
  // 앱별이 없으면 그 작업들도 워크스페이스 기본값으로
  const b = run({ settings: { default: sub(KIM), apps: { [APP]: { jobs } } } });
  has(b, othersRuns(KIM));
  lacks(b, '작업마다');
});

test('M4 비워 둔(null) 계정 칸도 없는 것으로 보고 다음 단계로 간다', () => {
  const a = run({ settings: { default: sub(KIM), apps: { [APP]: { default: null, jobs: { nightly: null } } } } });
  has(a, othersRuns(KIM));
  lacks(a, '작업마다');
  const b = run({ settings: { default: null }, api_key_registered: true });
  has(b, API);
});

// ── 구독의 주인 · 공용 계정 지정 ─────────────────────────────────────────────
test('P1 ★ 정해진 구독이 지금 구성원 본인 것이면 «내 Claude 구독으로 돌아요»', () => {
  const a = run({ settings: { default: sub(ME) }, api_key_registered: true }, ME);
  has(a, MINE);
  lacks(a, NOT_MINE);
  const b = run({ settings: { apps: { [APP]: { default: sub(ME) } } } }, ME);
  has(b, MINE);
  lacks(b, NOT_MINE);
});

test('P2 ★ 본인 구독은 공용 계정 지정 대상이어도 «내 구독» 이 우선이다', () => {
  const on = run({ settings: { default: sub(ME) }, seats: [{ member: ME, on: true }] }, ME);
  has(on, MINE);
  lacks(on, seatName(ME));
  lacks(on, NOT_MINE);
  const off = run({ settings: { default: sub(ME) }, seats: [{ member: ME, on: false }] }, ME);
  has(off, MINE);
});

test('P3 ★ 남의 구독 + 공용 계정 지정 켜짐 → «공용 계정(<member>)» · 내 구독은 쓰지 않는다', () => {
  for (const snap of [
    { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: true }] },
    { settings: { apps: { [APP]: { default: sub(SEAT) } } }, seats: [{ member: LEE, on: false }, { member: SEAT, on: true }] },
  ]) {
    const t = run(snap, ME);
    has(t, seatName(SEAT));
    has(t, NOT_MINE);
    lacks(t, MINE);
  }
});

test('P4 ★ 남의 구독 + 공용 계정 지정이 꺼져 있음 → 그분 구독으로 돈다 · 지정이 아직 안 켜졌다고 말한다', () => {
  for (const snap of [
    { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: false }] },
    { settings: { default: sub(SEAT) }, seats: [{ member: LEE, on: true }, { member: SEAT, on: false }] },
  ]) {
    const t = run(snap, ME);
    has(t, othersRuns(SEAT));
    has(t, SEAT_OFF);
    lacks(t, seatName(SEAT));
    lacks(t, seatName(LEE));
    lacks(t, MINE);
  }
});

test('P5 ★ 남의 구독 + 공용 계정 지정 없음 → 그분 구독 · «본인이나 그분 세션에 초대받은 사람»', () => {
  const base = { settings: { default: sub(KIM) } };
  for (const snap of [base, { ...base, seats: [] }, { ...base, seats: [{ member: LEE, on: true }] }]) {
    const t = run(snap, ME);
    has(t, othersRuns(KIM));
    has(t, NO_SEAT);
    lacks(t, seatName(KIM));
    lacks(t, seatName(LEE));
    lacks(t, MINE);
  }
});

test("P6 ★ 지금 구성원을 모르면(meId '') 어떤 구독도 «내 구독» 으로 보지 않는다", () => {
  const a = run({ settings: { default: sub(KIM) } }, '');
  has(a, othersRuns(KIM));
  lacks(a, MINE);
  // member 가 빈 글자인 구독 칸 — 빈 meId 와 글자가 같다고 «내 구독» 이 되면 안 된다
  lacks(run({ settings: { default: { kind: 'subscription', member: '' } } }, ''), MINE);
  lacks(run({ settings: { default: { kind: 'subscription', member: '' } }, api_key_registered: true }, ''), MINE);
  // 공용 계정 지정은 meId 와 상관없다
  const c = run({ settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: true }] }, '');
  has(c, seatName(SEAT));
  lacks(c, MINE);
  // 작업마다 다를 때도 «내 Claude 구독» 이 끼지 않는다
  const d = run({ settings: { apps: { [APP]: { default: sub(KIM), jobs: { nightly: apiKey() } } } }, api_key_registered: true }, '');
  has(d, MIXED);
  has(d, shortOthers(KIM));
  assert.equal(mineShortCount(d), 0, `«내 Claude 구독» 이 끼었다 — 받은 문구: ${d}`);
});

test('P7 ★ 묻는 구성원 본인의 구독으로 넘어가는 길은 없다 — 본인 구독이 정해진 게 아니면 «내 Claude 구독으로 돌아요» 가 안 나온다', () => {
  for (const snap of [
    null,
    undefined,
    {},
    { api_key_registered: true },
    { api_key_registered: false },
    { settings: { default: sub(KIM) } },
    { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: true }] },
    { settings: { default: sub(SEAT) }, seats: [{ member: SEAT, on: false }] },
    { settings: { default: { kind: 'subscription' } } },
    { settings: { apps: { [APP]: { default: { kind: 'subscription' } } } } },
    { seats: [{ member: ME, on: true }] },
    { settings: { apps: { [OTHER_APP]: { default: sub(ME), jobs: { nightly: sub(ME) } } } } },
  ]) {
    const t = run(snap, ME);
    assert.ok(!t.includes(MINE), `${show(snap)}: «${MINE}» 가 나왔다 — 받은 문구: ${t}`);
  }
});

// ── 작업마다 계정이 다를 때 ──────────────────────────────────────────────────
//  P8 은 블라인드 작성 뒤 코드 리뷰에서 더한 사양이다(2026-11-04) — 서버는 켜진 공용 계정을 구성원 누구의 요청이든 받는다(plan.ts subscriptionRefusal).
const ANYONE = '구성원 누구의 요청이든 이 구독으로 돌아요';
test('P8 본인 구독이 켜진 공용 계정이면 «내 구독» 에 더해 누구의 요청이든 돈다고 말한다 · 꺼졌거나 지정이 없으면 그 말이 없다 · 남이 보면 본인 한정 단서가 없다', () => {
  const on = run({ settings: { apps: { [APP]: { default: sub(ME) } } }, seats: [{ member: ME, on: true }] });
  has(on, MINE);
  has(on, ANYONE);
  for (const seats of [[{ member: ME, on: false }], [], undefined]) {
    lacks(run({ settings: { apps: { [APP]: { default: sub(ME) } } }, seats }), ANYONE);
  }
  //  남(KIM)이 같은 공용 계정을 보면 — 공용 계정이라 말하고, «내가 이 앱에 물은 요청만» 같은 본인 한정 단서는 달지 않는다.
  const other = run({ settings: { apps: { [APP]: { default: sub(SEAT) } } }, seats: [{ member: SEAT, on: true }] }, KIM);
  has(other, seatName(SEAT));
  lacks(other, '내가 이 앱에 물은 요청만');
});

test('J1 ★ 작업마다 계정이 다르면 «작업마다 실행 계정이 달라요» + 서로 다른 계정마다 짧은 이름', () => {
  const t = run({
    settings: { apps: { [APP]: { default: apiKey(), jobs: { a: sub(KIM), b: sub(SEAT), c: sub(ME) } } } },
    api_key_registered: true,
    seats: [{ member: SEAT, on: true }],
  }, ME);
  has(t, MIXED);
  has(t, SHORT_API);
  has(t, shortOthers(KIM));
  has(t, seatName(SEAT));
  assert.ok(mineShortCount(t) >= 1, `«내 Claude 구독» 이 없다 — 받은 문구: ${t}`);
});

test('J2 앱 기본이 «계정 없음» 이고 작업 하나만 계정이 있으면 «정해지지 않음» 도 늘어놓는다', () => {
  const t = run({ settings: { apps: { [APP]: { jobs: { nightly: sub(KIM) } } } } }, ME);
  has(t, MIXED);
  has(t, SHORT_NONE);
  has(t, shortOthers(KIM));
  lacks(t, MINE);
});

test('J3 ★ 같은 계정은 한 번만 늘어놓는다', () => {
  // 작업 셋이 같은 남의 구독
  const a = run({ settings: { apps: { [APP]: { default: apiKey(), jobs: { a: sub(KIM), b: sub(KIM), c: sub(KIM) } } } }, api_key_registered: true }, ME);
  has(a, MIXED);
  once(a, shortOthers(KIM));
  once(a, SHORT_API);
  // 작업 둘이 같은 API 키
  const b = run({ settings: { apps: { [APP]: { default: sub(KIM), jobs: { a: apiKey(), b: apiKey() } } } }, api_key_registered: true }, ME);
  has(b, MIXED);
  once(b, SHORT_API);
  once(b, shortOthers(KIM));
  // 작업 둘이 같은 공용 계정
  const c = run({ settings: { apps: { [APP]: { default: apiKey(), jobs: { a: sub(SEAT), b: sub(SEAT) } } } }, api_key_registered: true, seats: [{ member: SEAT, on: true }] }, ME);
  has(c, MIXED);
  once(c, seatName(SEAT));
  // 작업 둘이 같은 본인 구독
  const d = run({ settings: { apps: { [APP]: { default: apiKey(), jobs: { a: sub(ME), b: sub(ME) } } } }, api_key_registered: true }, ME);
  has(d, MIXED);
  assert.equal(mineShortCount(d), 1, `«내 Claude 구독» 이 한 번이 아니다 — 받은 문구: ${d}`);
  // 앱 계정과 같은 작업 + 다른 작업 — 앱 계정은 한 번
  const e = run({ settings: { apps: { [APP]: { default: sub(KIM), jobs: { same: sub(KIM), other: apiKey() } } } }, api_key_registered: true }, ME);
  has(e, MIXED);
  once(e, shortOthers(KIM));
  // 등록된 API 키(4단계)로 도는 앱 기본 + 작업별 API 키 — 같은 워크스페이스 API 키라 한 번
  const f = run({ settings: { apps: { [APP]: { jobs: { x: apiKey(), y: sub(KIM) } } } }, api_key_registered: true }, ME);
  has(f, MIXED);
  once(f, SHORT_API);
});

test('J4 앱 기본(작업 없음)도 살펴본다 — 작업별 계정끼리 같아도 앱 계정과 다르면 «작업마다»', () => {
  const t = run({ settings: { default: sub(KIM), apps: { [APP]: { jobs: { a: apiKey(), b: apiKey() } } } }, api_key_registered: true }, ME);
  has(t, MIXED);
  has(t, shortOthers(KIM));
  has(t, SHORT_API);
});

test('J5 ★ 작업별 계정이 앱 계정과 같으면 «작업마다» 를 쓰지 않고 한 문장으로 말한다', () => {
  const a = run({ settings: { apps: { [APP]: { default: sub(KIM), jobs: { nightly: sub(KIM) } } } } }, ME);
  lacks(a, '작업마다');
  has(a, othersRuns(KIM));
  has(a, NO_SEAT);
  // 앱 계정이 워크스페이스 기본값에서 왔어도
  const b = run({ settings: { default: sub(SEAT), apps: { [APP]: { jobs: { a: sub(SEAT), b: sub(SEAT) } } } }, seats: [{ member: SEAT, on: true }] }, ME);
  lacks(b, '작업마다');
  has(b, seatName(SEAT));
  has(b, NOT_MINE);
  // 앱 계정이 등록된 API 키(4단계)에서 왔어도 — 작업별 API 키와 같은 계정
  const c = run({ settings: { apps: { [APP]: { jobs: { nightly: apiKey() } } } }, api_key_registered: true }, ME);
  lacks(c, '작업마다');
  has(c, API);
  // 본인 구독
  const d = run({ settings: { apps: { [APP]: { default: sub(ME), jobs: { nightly: sub(ME) } } } } }, ME);
  lacks(d, '작업마다');
  has(d, MINE);
});

test('J6 같은 계정을 칸 순서만 바꿔 적어도 같은 계정이다 — «작업마다» 가 되지 않는다', () => {
  const t = run({ settings: { apps: { [APP]: { default: { kind: 'subscription', member: KIM }, jobs: { nightly: { member: KIM, kind: 'subscription' } } } } } }, ME);
  lacks(t, '작업마다');
  has(t, othersRuns(KIM));
});

test('J7 작업마다 다를 때도 공용 계정 지정이 꺼진 구독은 공용 계정이라 부르지 않는다 — «<member>님의 Claude 구독»', () => {
  const t = run({ settings: { apps: { [APP]: { default: apiKey(), jobs: { nightly: sub(SEAT) } } } }, api_key_registered: true, seats: [{ member: SEAT, on: false }] }, ME);
  has(t, MIXED);
  has(t, shortOthers(SEAT));
  lacks(t, seatName(SEAT));
});

// ── 설정을 못 읽었을 때 ──────────────────────────────────────────────────────
test('X1 ★ 설정을 못 읽었으면(null/undefined) 특정 계정을 단정하지 않는다 — 옛 «없으면 내 Claude 구독으로 돌아요» 도 없다', () => {
  for (const snap of [null, undefined]) {
    for (const meId of [ME, '']) {
      const t = run(snap, meId);
      has(t, UNKNOWN);
      lacks(t, OLD_FALLBACK);
      lacks(t, MINE);
      lacks(t, API);
      lacks(t, NONE);
    }
  }
});

// ── 화면 배선 (소스 글 검사) ─────────────────────────────────────────────────
const CONSENT = 'web/v2/app-session.ts';

test("W1 ★ 동의 창이 '../lib/ai-run-consent.js' 에서 aiRunConsentText 를 가져다 «AI 실행» 줄에 쓴다", () => {
  const s = src(CONSENT);
  const imp = s.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/lib\/ai-run-consent\.js['"]/);
  assert.ok(imp, `${CONSENT} 에 '../lib/ai-run-consent.js' 에서 가져오는 import 가 없다`);
  const named = imp[1].split(',').map((x) => x.trim()).find((x) => /^aiRunConsentText(\s|$)/.test(x));
  assert.ok(named, `'../lib/ai-run-consent.js' import 에 aiRunConsentText 가 없다`);
  const local = (named.match(/\bas\s+([\w$]+)/) || [null, 'aiRunConsentText'])[1];
  const body = s.replace(imp[0], '');
  assert.ok(new RegExp(`(^|[^\\w$])${local.replace(/\$/g, '\\$')}\\s*\\(`).test(body), `${CONSENT} 가 가져온 aiRunConsentText 를 부르지 않는다`);
  assert.ok(s.includes('AI 실행'), `${CONSENT} 에 «AI 실행» 줄이 없다`);
});

test("W2 ★ 동의 창을 띄우기 전에 실행 계정 설정을 읽는다 — api('/api/ui/ai-account') 호출이 있다", () => {
  const s = src(CONSENT);
  assert.ok(/\bapi\(\s*['"`]\/api\/ui\/ai-account['"`]/.test(s), `${CONSENT} 에 api('/api/ui/ai-account') 호출이 없다`);
});

test('W3 ★ 옛 고정 문구 «워크스페이스 API 키가 있으면 그 돈으로, 없으면 내 Claude 구독으로 돌아요» 가 그 파일에 남아 있지 않다', () => {
  const s = src(CONSENT);
  assert.ok(!s.includes(OLD_FIXED), `${CONSENT} 에 옛 고정 문구가 남았다`);
});

test('W4 옛 고정 문구를 토막 내 이어 붙인 꼴로도 남아 있지 않다 — 앞 토막 · 뒤 토막', () => {
  const s = src(CONSENT);
  assert.ok(!s.includes('워크스페이스 API 키가 있으면 그 돈으로'), `${CONSENT} 에 옛 문구 앞 토막이 남았다`);
  assert.ok(!s.includes(OLD_FALLBACK), `${CONSENT} 에 옛 문구 뒤 토막 «${OLD_FALLBACK}» 가 남았다`);
});
