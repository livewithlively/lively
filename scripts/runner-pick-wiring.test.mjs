// 실행 계정 고르기·해소의 **배선 계약** (#4052) — 소스를 읽어 검사한다. 사양 엣지 표 B + 화면 배선.
//
//  화면 넷(증류기·분류기·관리기 설정 · 자동 실행 카드)과 액션 셋(증류·분류·관리)이 «누구 계정으로 도나» 를 나눠 갖는다.
//  하나라도 어긋나면 조용히 틀어진다 — 칸을 채웠는데 잡 계정이 이겨서 안 듣거나(B1), 칸에 구성원 id 를 치라고 하거나,
//  카드가 서버와 다른 계정을 말하거나.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}).join('\n');

const DIST = code(read('../web/distillers.ts'));
const CLS = code(read('../web/context-classify.ts'));
const MGR = code(read('../web/context-manage.ts'));
const CARD = code(read('../web/context-stage-job.ts'));
const WIDGETS = code(read('../web/lib/widgets.ts'));
const PSEL = code(read('../web/lib/person-select.ts'));
const CSS = read('../public/styles/03-components.css');
const A_DISTILL = code(read('../src/scheduler/actions/distill.ts'));
const A_CLASSIFY = code(read('../src/scheduler/actions/classify.ts'));
const A_MANAGE = code(read('../src/scheduler/actions/manage.ts'));
const ADMIN = [read('../web/admin-credentials.ts'), read('../web/admin-automation.ts')].map(code).join('\n');

test('배선 · 소스를 실제로 읽었다(vacuous 방지)', () => {
  for (const s of [DIST, CLS, MGR, CARD, WIDGETS, PSEL, A_DISTILL, A_CLASSIFY, A_MANAGE]) assert.ok(s.length > 1500);
});

test('★ 증류기 설정 — 실행 계정은 이름으로 고르는 칸이고, 그 값이 저장된다', () => {
  assert.match(DIST, /const reqPick = personSelect\(\{ value: v\('requester'\)/, '고르기 칸');
  assert.match(DIST, /requester: reqPick\.value\(\) \|\| null,/, '저장 값은 고른 구성원 id');
  assert.match(DIST, /F\('실행 계정', [^\n]*, reqPick\.el\)/, '칸을 폼에 실제로 붙인다');
  assert.ok(!/구성원 id — 비우면/.test(DIST), '«구성원 id» 를 치라는 글자칸이 없다');
  assert.ok(!/reqIn\b/.test(DIST), '옛 글자칸 변수가 남지 않는다');
});

test('★ 분류기 설정 — 같은 칸 · 이름은 «실행 계정»', () => {
  assert.match(CLS, /const reqPick = personSelect\(\{ value: c\?\.requester/, '고르기 칸');
  assert.match(CLS, /requester: reqPick\.value\(\) \|\| null,/, '저장 값');
  assert.match(CLS, /F\('실행 계정', [^\n]*, reqPick\.el\)/, '폼에 붙인다');
  assert.ok(!/F\('의뢰자'/.test(CLS) && !/reqIn\b/.test(CLS), '옛 «의뢰자» 글자칸이 없다');
});

test('★ 관리기 설정 — 같은 칸이 AI 판정 칸 묶음(runFields) 안에 있다(쓰이지 않는 종류에선 숨는다)', () => {
  assert.match(MGR, /const reqPick = personSelect\(\{ value: m\?\.requester/, '고르기 칸');
  assert.match(MGR, /requester: reqPick\.value\(\) \|\| null,/, '저장 값');
  const i = MGR.indexOf('const runFields = el(');
  const block = MGR.slice(i, MGR.indexOf(') as HTMLElement;', i));
  assert.match(block, /F\('실행 계정', [^\n]*, reqPick\.el\)/, 'runFields 안에 있다');
  assert.ok(!/F\('의뢰자'/.test(MGR) && !/reqIn\b/.test(MGR), '옛 «의뢰자» 글자칸이 없다');
});

test('★ 자동 실행 카드 — id 가 아니라 이름으로, 서버와 같은 순서로 말하고, 그 자리에서 바꾼다', () => {
  assert.match(CARD, /card\.append\(await runnerNote\(spec\.stage, job, rerender\)\)/, '헤드리스 잡에 실행 계정 줄을 붙인다');
  const i = CARD.indexOf('async function runnerNote(');
  assert.ok(i >= 0, 'runnerNote 가 있다');
  const body = CARD.slice(i);
  assert.match(body, /api\('\/api\/ui\/me\/headless'\)/, '워크스페이스 실행 멤버를 읽는다(서버 사슬 ②)');
  assert.match(body, /effectiveRunner\(\{ explicit, workspace: wsId, creator \}\)/, '서버와 같은 순서(lib/person-pick)');
  assert.match(body, /personSelect\(\{\s*value: explicit,/, '고르는 칸의 값은 이 자동 실행에 정한 계정');
  assert.match(body, /if \(id\) params\.requester = id; else delete params\.requester;/, '고르면 잡에 싣고, 비우면 뺀다');
  assert.match(body, /await patch\(job\.id, \{ params \}\)/, '저장은 잡 부분수정');
  assert.match(body, /nameOf\(effective\)/, '문장은 이름으로 말한다');
  assert.ok(!/AI는 \$\{requester\} 의 계정/.test(CARD), '옛 id 문장이 없다');
  assert.ok(!/내 계정\(\$\{meId\}\)/.test(CARD), '옛 «내 계정(id)» 단추가 없다');
});

test('관리 화면 공용 콤보(memberCombo)도 이름으로 보인다 — datalist(id 가 칸에 박힘)를 쓰지 않는다', () => {
  const i = WIDGETS.indexOf('export function memberCombo(');
  const body = WIDGETS.slice(i, WIDGETS.indexOf('\n}\n', i));
  assert.match(body, /personSelect\(\{[^}]*source: 'profiles'/, '관리자 명부로 고르기 칸');
  assert.ok(!/datalist/.test(body), 'datalist 없음');
  assert.ok(!/구성원 id 선택\/검색/.test(ADMIN), '호출부 안내도 «구성원 id» 를 요구하지 않는다');
});

test('고르기 칸 — 값이 바뀔 때만 change 를 올리고, 검색어는 밖으로 새지 않는다 · 목록은 모달 위에 뜬다', () => {
  assert.match(PSEL, /root\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/, '값 변경 = 거품 change');
  assert.match(PSEL, /input\.addEventListener\('input', \(e\) => \{\s*e\.stopPropagation\(\);/, '검색어 타이핑은 새지 않는다');
  assert.match(PSEL, /if \(e\.isComposing\) return;/, '한글 조합 중 Enter 는 고르기가 아니다');
  assert.match(PSEL, /document\.body\.append\(menu\)/, '목록은 body 에 붙는다(overflow 에 안 잘린다)');
  const m = /\.psel-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*(\d+)/.exec(CSS);
  assert.ok(m, '.psel-menu 는 fixed');
  assert.ok(Number(m[1]) > 1450, '모달(.ov-back 1450) 위에 뜬다');
});

test('★ B1 증류 — 증류기(레인) 계정이 잡 계정보다 앞선다', () => {
  assert.match(A_DISTILL, /resolveJobRunner\(explicitRunner\(b\.requester, params\.requester\), createdBy\)/, '레인 → 잡 → 워크스페이스 → 만든 사람');
  assert.ok(!/params\.requester \?\? b\.requester/.test(A_DISTILL), '옛 순서(잡 → 레인)가 없다');
});

test('★ B2·B3·B4 분류 — 잡 수준이 비어도 자기 계정을 정한 분류기는 돈다 · 아무도 없으면 미설정', () => {
  const i = A_CLASSIFY.indexOf('export async function runClassifyKnowledgeHeadless(');
  const body = A_CLASSIFY.slice(i, A_CLASSIFY.indexOf('\n}\n', i));
  const head = body.slice(0, body.indexOf('if (targets.length) {'));
  assert.ok(!/if \(!requester\) return HEADLESS_REQUESTER_MISSING;/.test(head), 'B2 분류기 판정 전에 «미설정» 으로 끝내지 않는다');
  assert.match(body, /if \(!requester && !targets\.some\(\(c\) => explicitRunner\(c\.requester\)\)\) return HEADLESS_REQUESTER_MISSING;/, 'B3 아무도 계정이 없으면 미설정');
  assert.match(body, /const runner = explicitRunner\(c\.requester\) \?\? requester;/, 'B2 분류기 계정이 앞선다');
  assert.match(body, /prompt, requester: runner, jobId,/, 'B2 그 계정으로 접수');
  const legacyAt = body.indexOf('const { listUnmappedKnowledge } = await import(');
  assert.ok(legacyAt > 0, '레거시 경로를 찾았다');
  assert.match(body.slice(legacyAt - 80, legacyAt), /if \(!requester\) return HEADLESS_REQUESTER_MISSING;\s*$/, 'B4 분류기 없는 경로는 종전대로 미설정');
});

test('★ B5·B6 관리 — 자기 계정을 정한 AI 판정 관리기는 잡 수준이 비어도 돈다', () => {
  assert.match(A_MANAGE, /if \(!requester && targets\.some\(\(m\) => needsLlm\(m\.kind\) && !explicitRunner\(m\.requester\)\)\) return HEADLESS_REQUESTER_MISSING;/, 'B6 계정 없는 AI 관리기만 멈춘다');
  assert.match(A_MANAGE, /const runner = explicitRunner\(m\.requester\) \?\? requester;/, 'B5 관리기 계정이 앞선다');
  assert.match(A_MANAGE, /const enqueue = runner\s*\?/, 'B5 계정이 있으면 접수기를 준다');
  assert.match(A_MANAGE, /requester: explicitRunner\(o\.requester\) \?\? runner,/, 'B5 그 계정으로 접수');
});
