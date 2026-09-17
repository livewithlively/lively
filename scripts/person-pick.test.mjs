// 사람 한 명 고르기 — 순수 규칙 (#4052). 사양 엣지 표 D1~D22.
//
//  이 판정이 틀어지면 **엉뚱한 사람의 AI 계정으로 과금**되거나(나를 맨 위로 올리다 다른 사람을 고르게 되는 등),
//  명부에 없는 옛 값이 빈 칸으로 보여 사람이 모르는 채 지워진다. 화면 카드는 서버와 **같은 순서로** 계정을 말해야 한다.
//  ⚠ 재는 대상은 소스가 아니라 **빌드 산출물**(public/app/lib/person-pick.js)이다 — 러너가 web/ 를 수집하지 않고,
//   실제로 브라우저에 나가는 것도 그 파일이다(scripts/person-name.test.mjs 와 같은 관례).
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { toPickPeople, pickMatches, pickLabel, effectiveRunner } =
  await import(pathToFileURL(path.join(ROOT, 'public/app/lib/person-pick.js')).href);

const P = (id, name, sub = null) => ({ id, name, sub });
const ids = (rows) => rows.map((p) => p.id);
const PEOPLE = [P('wonjoon-jang', '장원준'), P('sangmin-yoon', '윤상민'), P('Daon', '다온', 'AI 구성원'), P('hyun', '김현')];

// ── toPickPeople ────────────────────────────────────────────────────────────
test('D1 정상 행 → id·이름·보조 글', () => {
  assert.deepEqual(toPickPeople([{ id: 'a', name: '가', sub: 'AI 로그인됨' }]), [P('a', '가', 'AI 로그인됨')]);
});
test('D2 id 가 비었거나 공백이면 버린다 — 고를 수 없는 줄을 내지 않는다', () => {
  assert.deepEqual(ids(toPickPeople([{ id: '', name: '빈' }, { id: '   ', name: '공백' }, { name: '없음' }, { id: 'ok', name: '됨' }])), ['ok']);
});
test('D3 id 가 겹치면 첫 행만 — 같은 사람이 두 번 보이지 않는다', () => {
  const r = toPickPeople([{ id: 'a', name: '첫' }, { id: 'a', name: '둘' }, { id: ' a ', name: '셋' }]);
  assert.deepEqual(r, [P('a', '첫')]);
});
test('D4 이름이 비면 id 로 — 빈 줄을 내지 않는다', () => {
  assert.deepEqual(toPickPeople([{ id: 'x', name: '' }, { id: 'y', name: '  ' }, { id: 'z' }]).map((p) => p.name), ['x', 'y', 'z']);
});
test('D5 보조 글이 비면 null', () => {
  assert.equal(toPickPeople([{ id: 'a', name: '가', sub: '  ' }])[0].sub, null);
  assert.equal(toPickPeople([{ id: 'a', name: '가' }])[0].sub, null);
});
test('D6 행이 없으면 빈 목록', () => {
  assert.deepEqual(toPickPeople(null), []);
  assert.deepEqual(toPickPeople(undefined), []);
});

// ── pickMatches ─────────────────────────────────────────────────────────────
test('D7 검색어가 비면 전부 — 나를 맨 위로, 나머지는 명부 순서 그대로', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, '', 'sangmin-yoon')), ['sangmin-yoon', 'wonjoon-jang', 'Daon', 'hyun']);
  assert.deepEqual(ids(pickMatches(PEOPLE, '   ', 'hyun')), ['hyun', 'wonjoon-jang', 'sangmin-yoon', 'Daon']);
});
test('D8 내가 명부에 없거나 모르면 순서를 건드리지 않는다', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, '', 'nobody')), ids(PEOPLE));
  assert.deepEqual(ids(pickMatches(PEOPLE, '', '')), ids(PEOPLE));
  assert.deepEqual(ids(pickMatches(PEOPLE, '', null)), ids(PEOPLE));
  assert.deepEqual(ids(pickMatches(PEOPLE, '', 'wonjoon-jang')), ids(PEOPLE), '이미 맨 위면 그대로');
});
test('D9 이름 부분일치로 좁힌다', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, '상민', null)), ['sangmin-yoon']);
  assert.deepEqual(ids(pickMatches(PEOPLE, '원', null)), ['wonjoon-jang']);
});
test('D10 id 로도 찾는다 — 대소문자 무시', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, 'daon', null)), ['Daon']);
  assert.deepEqual(ids(pickMatches(PEOPLE, 'YOON', null)), ['sangmin-yoon']);
});
test('D11 초성으로 찾는다 — 사람이 실제로 치는 것', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, 'ㅇㅅㅁ', null)), ['sangmin-yoon']);
  assert.deepEqual(ids(pickMatches(PEOPLE, 'ㄱㅎ', null)), ['hyun']);
});
test('D12 띄어쓰기는 무시한다', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, '윤 상민', null)), ['sangmin-yoon']);
  assert.deepEqual(ids(pickMatches([P('a', '박 서 연')], '박서연', null)), ['a']);
});
test('D13 맞는 사람이 없으면 빈 목록', () => {
  assert.deepEqual(pickMatches(PEOPLE, '존재하지않음', 'sangmin-yoon'), []);
});
test('D14 검색이 나를 걸러냈으면 되살리지 않는다', () => {
  assert.deepEqual(ids(pickMatches(PEOPLE, '원준', 'sangmin-yoon')), ['wonjoon-jang']);
});
test('pickMatches 는 받은 목록을 바꾸지 않는다(명부 캐시를 여러 칸이 나눠 쓴다)', () => {
  const src = PEOPLE.slice();
  pickMatches(src, '', 'hyun');
  assert.deepEqual(ids(src), ids(PEOPLE));
});

// ── pickLabel ───────────────────────────────────────────────────────────────
test('D15 값이 비면 null — 빈 칸', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(pickLabel(PEOPLE, v), null);
});
test('D16 명부에 있으면 그 이름', () => {
  assert.deepEqual(pickLabel(PEOPLE, 'sangmin-yoon'), { id: 'sangmin-yoon', name: '윤상민', known: true });
});
test('★ D17 명부에 없으면 값 그대로 + known:false — 옛 설정을 숨기지도, 이름을 지어내지도 않는다', () => {
  assert.deepEqual(pickLabel(PEOPLE, 'admin'), { id: 'admin', name: 'admin', known: false });
  assert.deepEqual(pickLabel([], 'yoon'), { id: 'yoon', name: 'yoon', known: false });
});
test('D18 앞뒤 공백은 다듬어 대조한다', () => {
  assert.deepEqual(pickLabel(PEOPLE, '  hyun '), { id: 'hyun', name: '김현', known: true });
});

// ── effectiveRunner ─────────────────────────────────────────────────────────
test('D19 이 자동 실행에 정한 계정이 먼저', () => {
  assert.deepEqual(effectiveRunner({ explicit: 'a', workspace: 'b', creator: 'c' }), { id: 'a', from: 'job' });
});
test('★ D20 비었으면(공백 포함) 워크스페이스 실행 멤버 — «만든 사람» 으로 건너뛰지 않는다', () => {
  assert.deepEqual(effectiveRunner({ explicit: '  ', workspace: 'b', creator: 'c' }), { id: 'b', from: 'workspace' });
  assert.deepEqual(effectiveRunner({ workspace: ' b ', creator: 'c' }), { id: 'b', from: 'workspace' });
});
test('D21 둘 다 비면 만든 사람', () => {
  assert.deepEqual(effectiveRunner({ explicit: null, workspace: '', creator: 'c' }), { id: 'c', from: 'creator' });
});
test('D22 셋 다 없으면 null — 모르는 계정을 지어내지 않는다', () => {
  assert.equal(effectiveRunner({}), null);
  assert.equal(effectiveRunner({ explicit: ' ', workspace: null, creator: '' }), null);
});
