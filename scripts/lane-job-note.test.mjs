#!/usr/bin/env node
// 증류기를 켠 뒤 무엇이 그것을 돌리는지 화면이 말한다(#5235) — 규칙 표 + 화면 배선.
//
//  왜: 레인을 켜면 자동 실행이 저절로 생기는데 화면에 안 보여, 사람이 레인별 잡을 또 만들었고 첫 틱에 같은 자료가 두 번 나갔다.
//   반대로 자동 실행을 꺼 둔 채 레인을 켜면 안 도는데 화면은 «켰습니다» 라고만 했다.
//  ⚠ 재는 대상은 빌드 산출물(public/app/lib/lane-job-note.js) — person-pick.test.mjs 와 같은 관례.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { laneJobNote } = await import(pathToFileURL(join(ROOT, 'public/app/lib/lane-job-note.js')).href);
const { firstRunNote } = await import(pathToFileURL(join(ROOT, 'public/app/lib/first-run-note.js')).href);
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

test('N1 옛 게이트웨이·꺼진 채 저장 — 응답에 없으면 아무 말도 안 한다', () => {
  for (const p of [undefined, null]) assert.equal(laneJobNote(p), null);
});

test('N2 맡은 잡이 있으면 아무 말도 안 한다 — 평소 저장을 시끄럽게 만들지 않는다', () => {
  assert.equal(laneJobNote({ action: 'none', uncovered: false }), null);
});

test('N3 ★ 돌릴 잡이 없으면 경고로 말한다', () => {
  const n = laneJobNote({ action: 'none', uncovered: true });
  assert.equal(n.warn, true);
  assert.match(n.text, /자동 실행/);
});

test('N4 ★ 새로 만들었으면 주기와 함께 나가는 자료를 말한다 — 경고는 아니다', () => {
  const n = laneJobNote({ action: 'create', interval_sec: 600 });
  assert.equal(n.warn, false);
  assert.match(n.text, /10분마다/);
  assert.match(n.text, /맡은 증류기가 없는 자료/);
});

test('N5 주기가 빠져도 말이 깨지지 않는다', () => {
  assert.match(laneJobNote({ action: 'create' }).text, /10분마다/);
});

test('N6 심은 잡을 넓혔으면 그렇게 말한다', () => {
  const n = laneJobNote({ action: 'widen' });
  assert.equal(n.warn, false);
  assert.match(n.text, /넓혔습니다/);
});

test('W1 저장 자리 넷이 다 이 안내를 지난다 — 스위치 두 곳 · 새로 만들기 · 저장', () => {
  const s = src('web/distillers.ts');
  assert.match(s, /savedToast\(await api\('\/api\/ui\/org\/distillers', \{ method: 'POST', body: JSON\.stringify\(\{ \.\.\.settable\(d\), enabled: next \}\) \}\), next \? '켰습니다' : '껐습니다'\)/);
  assert.match(s, /savedToast\(await api\('\/api\/ui\/org\/distillers', \{ method: 'POST', body: JSON\.stringify\(\{ \.\.\.settable\(d\), enabled: true \}\) \}\), '켰습니다'\)/);
  assert.match(s, /savedToast\(res, '증류기를 만들었습니다'\)/);
  assert.match(s, /savedToast\(res, '저장했습니다'\)/);
  assert.doesNotMatch(s, /toast\('켰습니다'\)|toast\('저장했습니다'\)|toast\('증류기를 만들었습니다'\)/, '안내를 안 지나는 알림이 남았다');
});

test('W2 응답의 job_plan 을 읽는다 · 경고면 경고로 띄운다', () => {
  const s = src('web/distillers.ts');
  const i = s.indexOf('function savedToast(');
  const body = s.slice(i, s.indexOf('\n}\n', i));
  assert.match(body, /laneJobNote\(res\?\.job_plan\)/);
  assert.match(body, /note\.warn/);
});

// ── 시각을 준 1회성이 언제 도는지 ──────────────────────────────────────────────
test('F1 값이 없으면(반복 잡 · 꺼진 잡 · 옛 게이트웨이) 말하지 않는다', () => {
  assert.equal(firstRunNote(undefined, 'Asia/Seoul'), null);
});

test('F2 ★ 조직 시간대로 말한다 — 지난 날짜를 넣었으면 여기서 다음 해가 보인다', () => {
  const n = firstRunNote('2026-12-31T15:00:00.000Z', 'Asia/Seoul');
  assert.equal(n.warn, false);
  assert.match(n.text, /2027/, '12/31 15:00 UTC 는 서울로 다음 해다');
  assert.match(n.text, /Asia\/Seoul/);
});

test('F3 ★ 오지 않는 시각이면 경고로 말한다', () => {
  assert.equal(firstRunNote(null, 'Asia/Seoul').warn, true);
});

test('F4 브라우저가 모르는 시간대여도 던지지 않는다 — 저장은 이미 끝났다', () => {
  assert.match(firstRunNote('2026-12-31T15:00:00.000Z', 'Not/AZone').text, /2026-12-31T15:00/);
});

test('W3 관리 화면이 새 동작을 말한다 — «cron 무시» 가 돌아오지 않는다', () => {
  const s = src('web/admin-automation.ts');
  assert.doesNotMatch(s, /주기·cron 무시/, '정반대 문구가 돌아왔다');
  assert.match(s, /cron식이 있으면 저장 뒤 첫 매치에/);
  assert.match(s, /'한 번만 · cron: ' \+ j\.cron_expr/, '목록이 1회성의 시각을 숨긴다');
  assert.match(s, /firstRunNote\(r\?\.first_run_at, tz\)/, '저장 응답의 시각을 안 읽는다');
});

