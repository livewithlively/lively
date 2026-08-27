// personName — 「이 닉네임을 내 이름으로 사용」 판정 (#1813).
//
//  사양 엣지 표: use_nickname × nickname × display_name × email × id.
//  이 판정이 틀어지면 **사람 이름이 화면에서 사라지거나 엉뚱한 이름으로 불린다.** 조용히 틀어지는 자리라 표로 못박는다.
//  ⚠ 재는 대상은 소스가 아니라 **빌드 산출물**(public/app/lib/person-name.js)이다 — 러너가 web/ 를 수집하지 않고,
//   실제로 브라우저에 나가는 것도 그 파일이다. `npm run build` 가 build-web 을 포함하므로 CI 에서 항상 존재한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { personName } = await import(pathToFileURL(path.join(ROOT, 'public/app/lib/person-name.js')).href);

test('① 켜고 닉네임이 있으면 닉네임으로 불린다', () => {
  assert.equal(personName({ use_nickname: true, nickname: '원준', display_name: '장원준' }), '원준');
});
test('② 껐으면 닉네임이 있어도 표시이름', () => {
  assert.equal(personName({ use_nickname: false, nickname: '원준', display_name: '장원준' }), '장원준');
});
test('③ 플래그가 없으면(옛 레코드) 표시이름 — 켠 적 없는 사람이 갑자기 닉네임으로 불리지 않는다', () => {
  assert.equal(personName({ nickname: '원준', display_name: '장원준' }), '장원준');
});
test('④ 켰는데 닉네임이 비면 표시이름으로 떨어진다 — 빈 이름을 내지 않는다', () => {
  assert.equal(personName({ use_nickname: true, nickname: '', display_name: '장원준' }), '장원준');
  assert.equal(personName({ use_nickname: true, nickname: '   ', display_name: '장원준' }), '장원준');
});
test('⑤ 표시이름이 비면 이메일 → id 순으로 떨어진다', () => {
  assert.equal(personName({ display_name: '', email: 'a@b.c', id: 'jang' }), 'a@b.c');
  assert.equal(personName({ display_name: null, email: null, id: 'jang' }), 'jang');
  assert.equal(personName({ userId: 'yoon' }), 'yoon');
});
test('⑥ 공백만 있는 표시이름은 이름이 아니다', () => {
  assert.equal(personName({ display_name: '   ', email: 'a@b.c' }), 'a@b.c');
});
test('⑦ 아무것도 없으면 빈 문자열 — 화면이 undefined 를 그리지 않는다', () => {
  assert.equal(personName({}), '');
  assert.equal(personName(null), '');
  assert.equal(personName(undefined), '');
});
test('⑧ 닉네임 앞뒤 공백은 다듬어 쓴다', () => {
  assert.equal(personName({ use_nickname: true, nickname: '  원준  ', display_name: '장원준' }), '원준');
});
