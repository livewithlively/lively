// 증류를 손으로 돌리기 전의 확인(#5235) — 무엇을 물을지의 순수 규칙 + 화면 배선 + 사실과 반대이던 문구.
//
//  배경: 레인을 지정하지 않은 증류 잡은 맡은 레인이 없는 자료도 기본 기준으로 함께 낸다(#1631). 그런데 화면은 그 자료를
//   «어느 증류기도 읽지 않습니다 · 이대로 두면 영영 지식이 되지 않습니다» 라고 말했고, 누르기 전에 볼 길도 없었다.
//   고객사 첫 세팅에서 레인 하나를 시범으로 돌리자 50건이 붙어 나가 손으로 취소했다.
//  ⚠ 재는 대상은 빌드 산출물(public/app/lib/distill-run-ask.js) — person-pick.test.mjs 와 같은 관례.
//  화면을 실제로 눌러 보는 것은 distill-run-check-runtime.test.mjs, 여기는 규칙과 소스에서만 보이는 배선이다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const { distillRunAsk, distillRunBody } = await import(pathToFileURL(path.join(ROOT, 'public/app/lib/distill-run-ask.js')).href);

const lane = (sources) => ({ distiller: 'liv-a', sources, backlog: sources });

// ── 규칙 ─────────────────────────────────────────────────────────────────────
test('A1 기본 기준으로 나갈 자료가 없으면 묻지 않는다', () => {
  assert.deepEqual(distillRunAsk({ lanes: [lane(2)], unassigned: null }), { ask: 'none' });
  assert.deepEqual(distillRunAsk({ lanes: [], unassigned: null }), { ask: 'none' });
});

test('A2 계획을 못 읽으면 «모름» 이다 — «묻지 않음» 으로 접지 않는다', () => {
  //  옛 게이트웨이·필드 부재가 여기로 온다. none 으로 접으면 무엇이 나갈지 모른 채 실행한다.
  for (const p of [null, undefined, 'x', 0]) assert.deepEqual(distillRunAsk(p), { ask: 'unknown' }, JSON.stringify(p));
  assert.deepEqual(distillRunAsk({}), { ask: 'none' }, '계획은 있는데 나갈 자료가 없다');
  assert.deepEqual(distillRunAsk({ unassigned: { sources: 0, total: 0 } }), { ask: 'none' });
});

test('A3 증류기 몫과 함께 나가면 뺄 수 있게 묻는다', () => {
  assert.deepEqual(distillRunAsk({ lanes: [lane(2), lane(3)], unassigned: { sources: 50, total: 120 } }),
    { ask: 'choose', sources: 50, rest: 70, laneCount: 2, laneSources: 5 });
});

test('A4 나가는 것이 기본 기준 배치뿐이면 뺄 것이 없다 — 실행할지만 묻는다', () => {
  assert.deepEqual(distillRunAsk({ lanes: [], unassigned: { sources: 3, total: 3 } }), { ask: 'default-only', sources: 3, rest: 0 });
  assert.deepEqual(distillRunAsk({ unassigned: { sources: 3, total: 3 } }), { ask: 'default-only', sources: 3, rest: 0 }, 'lanes 부재');
});

test('A5 경계 — 이번 건수가 전체와 같으면 남은 건수 0, 전체가 더 작아도 음수가 안 된다', () => {
  assert.equal(distillRunAsk({ lanes: [lane(1)], unassigned: { sources: 50, total: 50 } }).rest, 0);
  assert.equal(distillRunAsk({ lanes: [lane(1)], unassigned: { sources: 50, total: 51 } }).rest, 1);
  assert.equal(distillRunAsk({ lanes: [lane(1)], unassigned: { sources: 5, total: 0 } }).rest, 0);
});

// ── 답 → 실행 요청 ───────────────────────────────────────────────────────────
const CHOOSE = { ask: 'choose', sources: 3, rest: 0, laneCount: 1, laneSources: 2 };
const ONLY = { ask: 'default-only', sources: 3, rest: 0 };

test('B1 계획을 모르면 어떤 답이어도 실행하지 않는다', () => {
  assert.equal(distillRunBody({ ask: 'unknown' }, { confirmed: true, withUnassigned: true }), null);
});

test('B2 물을 것이 없으면 그대로 실행한다', () => {
  assert.deepEqual(distillRunBody({ ask: 'none' }, { confirmed: true }), {});
});

test('B3 취소하면 어떤 경우든 실행하지 않는다', () => {
  assert.equal(distillRunBody(CHOOSE, { confirmed: false, withUnassigned: true }), null);
  assert.equal(distillRunBody(ONLY, { confirmed: false }), null);
});

test('B4 뺄 수 있는 실행 — 체크를 안 하면 증류기 몫만 나간다', () => {
  assert.deepEqual(distillRunBody(CHOOSE, { confirmed: true, withUnassigned: false }), { lanes_only: true });
  assert.deepEqual(distillRunBody(CHOOSE, { confirmed: true }), { lanes_only: true }, '답이 빠져도 안전한 쪽');
  assert.deepEqual(distillRunBody(CHOOSE, { confirmed: true, withUnassigned: true }), {});
});

test('B5 기본 기준 배치뿐이면 뺄 것이 없다 — 실행하면 그대로 나간다', () => {
  assert.deepEqual(distillRunBody(ONLY, { confirmed: true }), {});
});

// ── 배선 — 이 규칙을 안 부르면 위 시험은 아무것도 지키지 않는다 ─────────────────
test('W1 「지금 한 번 실행」 이 실행 전에 묻는다', () => {
  assert.match(src('web/distillers.ts'), /beforeRun: \(job\) => confirmDistillRun\(/, '증류 카드가 확인을 안 건다');
  const card = src('web/context-stage-job.ts');
  assert.match(card, /spec\.beforeRun \? await spec\.beforeRun\(job\)/, '카드가 beforeRun 을 안 부른다');
  assert.match(card, /if \(body === null\) \{[^}]*return; \}/, '사람이 멈춰도 실행한다');
  assert.ok(card.indexOf('await spec.beforeRun(job)') < card.indexOf('/run`, { method: \'POST\', body: JSON.stringify(body)'), '실행 뒤에 묻는다');
});

test('W2 「지금 수집·증류」 도 같은 확인을 지나고, 고른 값을 서버에 보낸다', () => {
  const map = src('web/context-map.ts');
  assert.match(map, /await confirmDistillRun\(String\(distillJobId\)\)/, '단추가 확인을 안 건다');
  assert.match(map, /if \(opt === null\) return;/, '사람이 멈춰도 돈다');
  assert.ok(map.indexOf('if (opt === null) return;') < map.indexOf("'/api/ui/org/pipeline/run-now'"), '실행 뒤에 묻는다');
  assert.match(map, /distill_job_ids: ids, \.\.\.opt/, '고른 값을 안 보낸다');
  assert.match(map, /runNowButtons\(collectors, \[st\.distill\?\.job, fill\?\.job\], \(\) => panel\.reload\(\), st\.distill\?\.job\?\.id\)/, '증류 잡을 안 넘긴다');
});

test('W3 계획은 실행 경로가 아니라 이름이 다른 경로로 읽는다 — 옛 게이트웨이는 모르는 인자를 떨구고 실제로 실행한다', () => {
  const check = src('web/distill-run-check.ts');
  assert.match(check, /\/run-plan`\)/, '계획을 다른 경로로 안 읽는다');
  const code = check.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /method: 'POST'/, '확인 단계가 POST 를 보낸다');
  assert.doesNotMatch(code, /dry_run/, '실행 경로에 미리보기 인자를 얹었다');
});

test('W4 이번 1회만 뺀다는 것을 말한다 — 켜 둔 자동 실행은 다음 주기에 내보낸다', () => {
  const check = src('web/distill-run-check.ts');
  assert.match(check, /이번 실행에서만 뺍니다/);
  assert.match(check, /다음 주기에 나갑니다/);
});

// ── 사실과 반대이던 문구가 돌아오지 않는다 ─────────────────────────────────────
test('C1 화면과 가이드가 «읽지 않는다 · 영영 안 된다» 라고 말하지 않는다', () => {
  for (const f of ['web/distillers.ts', 'web/context-map.ts', 'web/docs-content.ts']) {
    const body = src(f).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(body, /어느 증류기(도|에도) (안 )?읽지 않/, `${f} — #1631 뒤로 사실이 아니다`);
    assert.doesNotMatch(body, /영영 지식이 되지 않습니다/, f);
    assert.doesNotMatch(body, /이대로 두면 지식이 되지 않습니다/, f);
  }
});
