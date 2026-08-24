// 서로 다른 하네스 사이에 넘기는 맥락은 DOM 없이도 실제 웹 산출물로 검증한다.
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { sessionHandoffContext } = await import(join(root, 'public/app/session-handoff-context.js'));

const out = sessionHandoffContext([
  { t: { text: '첫 질문' }, evs: [
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: '비공개 생각' },
      { type: 'text', text: '첫 답' },
      { type: 'tool_use', name: 'read_file', input: { secret: '도구 입력 원문' } },
      { type: 'tool_use', name: 'read_file' },
    ] } },
    { type: 'tool_result', content: '도구 결과 원문' },
  ] },
  { t: { text: '계속해' }, evs: [{ type: 'assistant', message: { content: [{ type: 'text', text: '이어갑니다' }] } }] },
]);

assert.match(out, /사용자: 첫 질문[\s\S]*AI: 첫 답[\s\S]*사용한 도구: read_file/);
assert.match(out, /사용자: 계속해[\s\S]*AI: 이어갑니다/);
assert.doesNotMatch(out, /비공개 생각|도구 입력 원문|도구 결과 원문/);
assert.equal((out.match(/read_file/g) || []).length, 1, '같은 턴의 도구 이름은 중복하지 않는다');

const capped = sessionHandoffContext([
  { t: { text: '오래된 질문 ' + 'a'.repeat(30) }, evs: [] },
  { t: { text: '최신 질문 ' + 'z'.repeat(30) }, evs: [] },
], 50);
assert.doesNotMatch(capped, /오래된 질문/);
assert.match(capped, /최신 질문/);

console.log('ok  하네스 인수인계 맥락은 공통 대화만 최신순으로 제한해 보존한다');
