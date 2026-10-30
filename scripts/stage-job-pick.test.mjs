// 자동 실행 카드의 대표 잡·끄기 대상 — 순수 규칙 (#4052 끝단 확인 후속). 사양 엣지 표 S3.
//
//  배경(실측 2026-09-17): 증류 단계에 같은 일을 하는 잡이 여럿 켜질 수 있다 — 처음 설정이 심는 local-files 전용 잡(10분)과
//  전체 접수 잡(30분), 옛 매니지드 워크스페이스의 distill-lanes + distill-sources-headless. 종전 카드는 목록 순 첫 켜진 잡
//  하나만 보이고 그것만 껐다 → 전용 잡의 주기로 말하고, 꺼도 다른 잡이 계속 돌았다.
//  ⚠ 재는 대상은 빌드 산출물(public/app/lib/stage-job-pick.js) — person-pick.test.mjs 와 같은 관례.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { pickStageJob, stageOffTargets, isWholeDistillJob } =
  await import(pathToFileURL(path.join(ROOT, 'public/app/lib/stage-job-pick.js')).href);
//  서버 판정(전용 잡 = 켜짐 + 비지 않은 묶음)과 화면 판정이 같아야 한다 — 서버 빌드 산출물로 대조한다.
const { dedicatedDistillerKeys } = await import(pathToFileURL(path.join(ROOT, 'dist/org/distill/ensure-job.js')).href);

const J = (id, enabled, distiller) => ({ id, enabled, params: distiller === undefined ? {} : { distiller } });
const LOCAL_ON = J('distill-local-files', true, 'local-files');
const LOCAL_OFF = J('distill-local-files', false, 'local-files');
const DSH_ON = J('distill-sources-headless', true);
const DSH_OFF = J('distill-sources-headless', false);
const LANES_ON = J('distill-lanes', true);
const LANES_OFF = J('distill-lanes', false);
const id = (j) => (j ? j.id : null);
const ids = (js) => js.map((j) => j.id);

// ── pickStageJob ─────────────────────────────────────────────────────────────
test('P1 잡이 없으면 null', () => {
  assert.equal(pickStageJob([], isWholeDistillJob), null);
  assert.equal(pickStageJob([]), null);
});
test('P2 ★ 켜진 전용 잡이 목록 앞이어도 켜진 전체 잡을 대표로', () => {
  assert.equal(id(pickStageJob([LOCAL_ON, DSH_ON], isWholeDistillJob)), 'distill-sources-headless');
});
test('P3 켜진 전체 잡이 둘이면 목록 순 첫 것', () => {
  assert.equal(id(pickStageJob([LANES_ON, DSH_ON], isWholeDistillJob)), 'distill-lanes');
});
test('P4 켜진 전체 잡이 없으면 켜진 잡(전용)을 — 무언가 돌고 있으면 «켜짐» 으로 말한다', () => {
  assert.equal(id(pickStageJob([LOCAL_ON, DSH_OFF], isWholeDistillJob)), 'distill-local-files');
});
test('P5 모두 꺼짐 → 조건 맞는 첫 항목', () => {
  assert.equal(id(pickStageJob([DSH_OFF, LANES_OFF], isWholeDistillJob)), 'distill-sources-headless');
});
test('P6 ★ 모두 꺼짐 + 전용이 목록 앞 → 전체 잡(대표가 곧 [켜기] 대상 — 전용 잡을 켜면 한 레인만 돈다)', () => {
  assert.equal(id(pickStageJob([LOCAL_OFF, DSH_OFF], isWholeDistillJob)), 'distill-sources-headless');
});
test('P7 prefer 없음 — 종전 규칙(첫 켜진 잡)', () => {
  assert.equal(id(pickStageJob([LOCAL_ON, DSH_ON])), 'distill-local-files');
});
test('P8 prefer 없음 · 모두 꺼짐 — 종전 규칙(첫 항목)', () => {
  assert.equal(id(pickStageJob([LOCAL_OFF, DSH_OFF])), 'distill-local-files');
});
test('P9 prefer 가 모두 거짓이고 켜진 것도 없으면 첫 항목', () => {
  assert.equal(id(pickStageJob([LOCAL_OFF, J('p2', false, 'x')], isWholeDistillJob)), 'distill-local-files');
});
test('P10 켜짐은 enabled === true 만 — 문자열·숫자는 켜짐이 아니다', () => {
  const rows = [{ id: 'a', enabled: 'true', params: {} }, { id: 'b', enabled: 1, params: {} }, { id: 'c', enabled: true, params: {} }];
  assert.equal(id(pickStageJob(rows)), 'c');
  assert.equal(id(pickStageJob(rows, isWholeDistillJob)), 'c');
});
//  정본 id(preferId = 화면이 만드는 잡) — 전체 잡이 둘인 옛 매니지드 워크스페이스에서 «껐다 켜기» 가 정본으로 수렴하게(#4052 리뷰)
const CANON = 'distill-sources-headless';
test('P12 ★ 켜진 전체 잡이 둘이면 정본 id 가 대표 — 목록 순(distill-lanes 가 앞)이 아니다', () => {
  assert.equal(id(pickStageJob([LANES_ON, LOCAL_ON, DSH_ON], isWholeDistillJob, CANON)), CANON);
});
test('P13 ★ 모두 꺼짐 — 정본 id 가 대표(= [켜기] 가 켜는 잡)', () => {
  assert.equal(id(pickStageJob([LANES_OFF, LOCAL_OFF, DSH_OFF], isWholeDistillJob, CANON)), CANON);
});
test('P14 정본이 꺼져 있고 다른 전체 잡이 켜져 있으면 켜진 쪽 — 돌고 있는 것을 «꺼짐» 으로 말하지 않는다', () => {
  assert.equal(id(pickStageJob([LANES_ON, DSH_OFF], isWholeDistillJob, CANON)), 'distill-lanes');
});
test('P15 정본 id 가 조건(prefer)을 못 넘으면 무시 — 전용 잡이 정본 id 여도 대표가 되지 않는다', () => {
  assert.equal(id(pickStageJob([LOCAL_ON, DSH_ON], isWholeDistillJob, 'distill-local-files')), CANON);
});
test('P16 prefer 가 없으면 정본 id 도 보지 않는다 — 분류·관리는 종전 규칙 그대로', () => {
  assert.equal(id(pickStageJob([LANES_ON, DSH_ON], undefined, CANON)), 'distill-lanes');
  assert.equal(id(pickStageJob([LANES_OFF, DSH_OFF], undefined, CANON)), 'distill-lanes');
});
test('P17 정본 id 가 비었거나 목록에 없으면 목록 순', () => {
  assert.equal(id(pickStageJob([LANES_ON, DSH_ON], isWholeDistillJob, '')), 'distill-lanes');
  assert.equal(id(pickStageJob([LANES_ON, DSH_ON], isWholeDistillJob, null)), 'distill-lanes');
  assert.equal(id(pickStageJob([LANES_ON, DSH_ON], isWholeDistillJob, 'nope')), 'distill-lanes');
});
test('P11 입력 목록을 바꾸지 않는다', () => {
  const rows = [LOCAL_ON, DSH_ON];
  const before = JSON.stringify(rows);
  pickStageJob(rows, isWholeDistillJob);
  stageOffTargets(rows, DSH_ON);
  assert.equal(JSON.stringify(rows), before);
});

// ── stageOffTargets ──────────────────────────────────────────────────────────
test('O1 ★ 끄면 이 단계의 켜진 잡 전부(대표 포함)', () => {
  assert.deepEqual(ids(stageOffTargets([LOCAL_ON, DSH_ON], DSH_ON)), ['distill-local-files', 'distill-sources-headless']);
  assert.deepEqual(ids(stageOffTargets([LANES_ON, DSH_ON, LOCAL_ON], LANES_ON)), ['distill-lanes', 'distill-sources-headless', 'distill-local-files']);
});
test('O2 켜진 잡이 하나면 그것만', () => {
  assert.deepEqual(ids(stageOffTargets([DSH_ON], DSH_ON)), ['distill-sources-headless']);
});
test('O3 꺼진 잡은 건드리지 않는다', () => {
  assert.deepEqual(ids(stageOffTargets([DSH_ON, LANES_OFF, LOCAL_OFF], DSH_ON)), ['distill-sources-headless']);
});
test('O4 켜진 것이 없으면 대표만', () => {
  assert.deepEqual(ids(stageOffTargets([DSH_OFF, LOCAL_OFF], DSH_OFF)), ['distill-sources-headless']);
});

// ── isWholeDistillJob — 서버 판정과 같은가 ───────────────────────────────────
const PARAMS = [
  undefined, null, {}, { distiller: '' }, { distiller: '   ' }, { distiller: 42 }, { distiller: null }, { distiller: ['a'] },
  { distiller: 'local-files' }, { distiller: ' a ' }, { distiller: '7' }, { node: 'central' }, { distiller: 'x', requester: 'y' },
];
test('W1 묶음이 없거나 비었거나 공백·문자열 아님 → 전체 잡', () => {
  for (const p of [undefined, null, {}, { distiller: '' }, { distiller: '   ' }, { distiller: 42 }, { distiller: null }, { node: 'central' }]) {
    assert.equal(isWholeDistillJob({ id: 'x', enabled: true, params: p }), true, JSON.stringify(p));
  }
  assert.equal(isWholeDistillJob({ id: 'x', enabled: true }), true, 'params 칸 자체가 없어도');
});
test('W2 비지 않은 문자열 묶음 → 전용 잡', () => {
  for (const p of [{ distiller: 'local-files' }, { distiller: ' a ' }, { distiller: '7' }]) {
    assert.equal(isWholeDistillJob({ id: 'x', enabled: true, params: p }), false, JSON.stringify(p));
  }
});
test('W3 ★ 화면의 «전체 잡» 판정 = 서버의 «전용 잡 아님» 판정(켜진 잡 기준)', () => {
  for (const p of PARAMS) {
    const server = dedicatedDistillerKeys([{ id: 'x', enabled: true, params: p ?? null }]).size === 0;
    assert.equal(isWholeDistillJob({ id: 'x', enabled: true, params: p }), server, JSON.stringify(p));
  }
});

// ── 배선 ─────────────────────────────────────────────────────────────────────
const code = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
test('B1 ★ 카드가 대표를 규칙으로 고른다(명세의 prefer 와 정본 id = create.id 를 넘겨서)', () => {
  const c = code('web/context-stage-job.ts');
  assert.match(c, /const job = pickStageJob\(found, spec\.prefer, spec\.create\?\.id\);/);
  assert.ok(!/found\.find\(\(j\) => j\.enabled === true\) \?\? found\[0\]/.test(c), '옛 고르기가 남지 않는다');
  assert.match(c, /prefer\?: \(job: any\) => boolean;/, '명세에 칸이 있다');
});
test('B2 ★ 스위치 — 끌 때는 켜진 잡 전부, 켤 때는 대표 하나', () => {
  const c = code('web/context-stage-job.ts');
  assert.match(c, /const targets = next \? \[job\] : stageOffTargets\(found, job\);/);
  assert.match(c, /for \(const t of targets\) await patch\(t\.id, \{ enabled: next \}\);/);
  assert.ok(!/await patch\(job\.id, \{ enabled: next \}\)/.test(c), '대표 하나만 끄던 옛 호출이 남지 않는다');
});
test('B3 ★ 증류 카드가 전체 잡을 대표로 고르게 넘긴다', () => {
  const d = code('web/distillers.ts');
  const i = d.indexOf('async function runJobCard(');
  const body = d.slice(i, d.indexOf('\n}\n', i));
  assert.match(body, /prefer: isWholeDistillJob,/);
  assert.match(d, /import \{ isWholeDistillJob \} from '\.\/lib\/stage-job-pick\.js';/);
});
