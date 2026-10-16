// lib/studio-flow.ts — 앱 만들기 흐름의 **순수** 부분(#4592, 원준 2026-10-11 «기획 → 시안 → 의견 왕복 → 확인 → 넣기, 그리고 팀과»).
//  화면(web/v2/app-studio.ts)은 여기 함수로 AI 답을 읽고(기획 카드 · 걸음 · 점검) 단계마다 보낼 글을 만든다.
//  AI 와의 약속(지식 app-build-quickstart 에도 같은 꼴이 적혀 있다):
//   · 기획 카드  [[기획카드]] … [[/기획카드]]   줄마다 「이름: …」
//   · 걸음      [[걸음 n/4]]                   1 기획 읽음 · 2 화면 짬 · 3 자료 표 · 4 저장
//   · 점검      [[대조]] 있음: a · b | 빠짐: 없음
//  시험: scripts/app-studio-flow.test.mjs

export type StudioPlace = 'side' | 'full' | 'both';
export type StudioStage = 'plan' | 'draft' | 'fix' | 'check' | 'put';

//  다섯 단계(원준 2026-10-14 «생성된 시안과 고치기는 하나의 과정 — 시안 확인하고 코멘트해서 고치기»). 속 단계 'draft'(첫 판을 기다리는 중)와
//   'fix'(판이 있다 · 코멘트 · 고치기)는 사람에게 같은 ③ 이다 — 단계 바 · 만들던 앱 목록 · 둘러보기가 전부 이 표로 잰다.
export const STAGES: Array<{ key: 'what' | StudioStage; n: number; label: string }> = [
  { key: 'what', n: 1, label: '앱 이름과 기능 정하기' }, { key: 'plan', n: 2, label: '세부 기획 정하기' }, { key: 'fix', n: 3, label: '시안 확인 · 수정' },
  { key: 'check', n: 4, label: '확인' }, { key: 'put', n: 5, label: '넣기' },
];
export function stageIndex(s: 'what' | StudioStage): number { return STAGES.findIndex((x) => x.key === (s === 'draft' ? 'fix' : s)); }

// 사람에게 보이는 이름은 둘로 통일한다(원준 2026-10-14) — 세션 오른쪽에 붙는 것 = 「세션 위젯」, 화면 전체로 여는 것 = 「앱 화면」.
export const PLACE: Record<StudioPlace, { title: string; sub: string; say: string; width: string }> = {
  side: { title: '세션 위젯', sub: 'AI 세션 오른쪽에 붙여 써요. AI에게 말하면 위젯 내용을 읽고 바꿔줘요.', say: '세션 위젯(세션 오른쪽 사이드바, 폭 340px 안팎)으로 붙여 쓰는 앱이야. 좁은 폭에서 잘 보이게 만들어 줘.', width: '세션 위젯 폭(360px)' },
  full: { title: '앱 화면', sub: '앱 찾기에서 열어 전체 화면으로 써요.', say: '앱 찾기에서 열어 화면 전체로 넓게 쓰는 앱이야. 넓은 화면에 맞게 만들어 줘.', width: '앱 화면 폭' },
  both: { title: '둘 다', sub: '세션 위젯으로도, 앱 화면으로도 써요.', say: '세션 위젯(세션 오른쪽 좁은 사이드바)으로도 붙이고 화면 전체로도 여는 앱이야. 좁을 때와 넓을 때 둘 다 잘 보이게 만들어 줘.', width: '세션 위젯 폭과 앱 화면 폭 둘 다' },
};

//  ref(참고한 것) — 원준 2026-10-15 «초안 만들 때 비슷한 다른 앱이나 서비스 있으면 구조나 기능 같은 거 벤치마크해서 참고해서». 옛 카드엔 없다(빈 글로 읽는다).
export interface StudioCard { name: string; who: string; items: string; can: string[]; not: string; first: string; ref?: string }
export const CARD_ROWS: Array<{ k: keyof StudioCard; label: string; hint: string }> = [
  { k: 'name', label: '이름', hint: '짧은 한글 이름' },
  { k: 'who', label: '누가 쓰나', hint: '예: 회의를 준비하는 사람과 참석자' },
  { k: 'items', label: '무엇을 적나', hint: '예: 안건 제목, 날짜, 끝남 표시' },
  { k: 'can', label: '할 수 있는 것', hint: '세 가지. 예: 더하기, 회의별 보기, 끝난 것 접기' },
  { k: 'not', label: '안 하는 것', hint: '예: 회의록 쓰기, 알림 보내기' },
  { k: 'first', label: '첫 화면', hint: '예: 이번 회의 안건 목록(안 끝난 것 먼저)' },
  { k: 'ref', label: '참고한 것', hint: '비슷한 서비스에서 가져온 구조나 기능. 예: Otter의 회의 목록과 정리본 탭' },
];
const KEY_OF: Array<[RegExp, keyof StudioCard]> = [
  [/^이름$/, 'name'], [/^누가/, 'who'], [/^(무엇을적나|적는것|무엇을|적는칸|칸)$/, 'items'],
  [/^할수있는것|^기능/, 'can'], [/^안하는것|^하지않는것/, 'not'], [/^첫화면|^처음화면/, 'first'], [/^참고/, 'ref'],
];
export function splitList(s: string): string[] { return String(s || '').split(/\s*[·•,|]\s*|\s+\/\s+|\n/).map((x) => x.trim()).filter(Boolean); }
export function emptyCard(): StudioCard { return { name: '', who: '', items: '', can: [], not: '', first: '', ref: '' }; }

/** AI 답 글에서 기획 카드를 읽는다 — 블록이 여럿이면 마지막. 이름이 없으면 카드가 아니다. */
export function parseCard(text: string): StudioCard | null {
  const re = /\[\[기획\s*카드\]\]([\s\S]*?)\[\[\/기획\s*카드\]\]/g; let m: RegExpExecArray | null; let body = '';
  while ((m = re.exec(String(text || '')))) body = m[1];
  if (!body) return null;
  const c = emptyCard(); let hit = false;
  body.split('\n').forEach((line) => {
    const mm = /^\s*(?:[-*•]|\d+[.)])?\s*([^:：]{1,20})[:：]\s*(.*)$/.exec(line); if (!mm) return;
    const key = mm[1].replace(/\s+/g, ''), val = mm[2].trim();
    const k = KEY_OF.find(([r]) => r.test(key)); if (!k) return;
    hit = true;
    if (k[1] === 'can') c.can = splitList(val); else c[k[1]] = val;
  });
  return hit && c.name ? c : null;
}
export function cardText(c: StudioCard): string {
  return '[[기획카드]]\n' + CARD_ROWS.map((r) => r.label + ': ' + (r.k === 'can' ? (c.can || []).join(' · ') : String(c[r.k] || ''))).join('\n') + '\n[[/기획카드]]';
}

// ── 버전 이름(원준 2026-10-15 «판 이라는 워딩 전면 금지 · 첫 판 = 초안 · 두 번째부터는 「두 번째 버전이 나왔어요」 · 2판 · 3판 → V2 · V3 ·
//  앱빌더 어디서도») — 앱빌더 화면은 판 번호를 이 함수들로만 말한다. 서버 · AI 에게 가는 글의 번호(version_no)는 그대로다.
/** 판 번호 → 화면 이름: 1 = 초안 · 2 이상 = V2 · V3 … · 0 이하(아직 없음) = 빈 글. */
export function verName(n: number): string { const k = Math.floor(Number(n) || 0); return k >= 2 ? 'V' + k : k === 1 ? '초안' : ''; }
/** 버전 이름 + 조사 — 초안은 받침이 있고(초안을 · 초안으로 · 초안이 · 초안은), V2 는 띄어 받침 없는 꼴(V2 를 · V2 로 · V2 가 · V2 는). */
export function verJ(n: number, j: '을' | '으로' | '이' | '은'): string {
  const k = Math.floor(Number(n) || 0);
  if (k <= 1) return '초안' + j;
  return 'V' + k + ' ' + ({ 을: '를', 으로: '로', 이: '가', 은: '는' } as const)[j];
}
//  서수는 우리말로 끝까지 — 열한 번째 · 스무 번째 · 아흔아홉 번째(원준 2026-10-16 «그 뒤도 열한 번째 버전이 나왔어요 <- 이렇게»). 백부터는 숫자(100번째).
const ORD_ONE = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const ORD_TEN = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
/** 2 이상 → 「두 번째」 · 「열한 번째」 · 「스무 번째」 · 「100번째」. */
export function verOrdinal(n: number): string {
  const k = Math.floor(Number(n) || 0);
  if (k >= 100) return k + '번째';
  if (k <= 1) return '첫 번째';
  const t = Math.floor(k / 10), o = k % 10;
  return (o === 0 && t === 2 ? '스무' : ORD_TEN[t] + ORD_ONE[o]) + ' 번째';
}
/** 새 버전이 왔을 때의 머리글 — 초안이 나왔어요 · 두 번째 버전이 나왔어요 · 열한 번째 버전이 나왔어요 …(서수는 verOrdinal). */
export function verArrived(n: number): string {
  const k = Math.floor(Number(n) || 0);
  return k <= 1 ? '초안이 나왔어요' : verOrdinal(k) + ' 버전이 나왔어요';
}

export const DRAFT_STEPS = ['기획 읽는 중', '화면 짜는 중', '자료 표 만드는 중', '저장하는 중'];
/** [[걸음 n/4]] 가운데 가장 큰 n(1~4) · 없으면 0. */
export function parseStep(text: string): number {
  const re = /\[\[걸음\s*(\d)\s*(?:\/\s*\d)?[^\]]*\]\]/g; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(String(text || '')))) n = Math.max(n, Math.min(4, Number(m[1]) || 0));
  return n;
}

/** [[대조]] 있음: a · b | 빠짐: 없음 */
export function parseCheck(text: string): { have: string[]; missing: string[] } | null {
  const re = /\[\[대조\]\]\s*([^\n]*)/g; let m: RegExpExecArray | null; let line = '';
  while ((m = re.exec(String(text || '')))) line = m[1];
  if (!line) return null;
  const part = (label: RegExp): string => { const mm = label.exec(line); return mm ? mm[1].trim() : ''; };
  const have = part(/있음\s*[:：]\s*([^|]*)/), miss = part(/빠짐\s*[:：]\s*([^|]*)/);
  const none = (s: string): boolean => !s || /^(없음|없어요|없습니다|-|x)$/i.test(s);
  return { have: none(have) ? [] : splitList(have), missing: none(miss) ? [] : splitList(miss) };
}

/** 세션 기록(ndjson) 가운데 AI 답의 글만 — 줄마다 한 덩이. */
export function assistantTexts(ndjson: string): string[] {
  const out: string[] = [];
  String(ndjson || '').split('\n').forEach((line) => {
    const s = line.trim(); if (!s) return;
    let o: any; try { o = JSON.parse(s); } catch (_) { return; }
    if (!o || o.type !== 'assistant') return;
    const c = o.message && o.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b && b.type === 'text').map((b: any) => String(b.text || '')).join('\n') : '';
    if (t.trim()) out.push(t);
  });
  return out;
}

export function freshApps(known: string[], apps: Array<{ id: string; status?: string }>): string[] {
  return apps.filter((a) => a && (a.status == null || a.status === 'active') && !known.includes(String(a.id))).map((a) => String(a.id));
}

/** 사본 id — 원본 id + 내 id(짧게). 소문자 영숫자/- · 32자 안. */
export function copyId(originId: string, memberId: string): string {
  const me = String(memberId || 'me').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'me';
  const base = String(originId || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base.slice(0, 31 - me.length - 1) + '-' + me).replace(/-+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32);
}

// ── 단계마다 보내는 글(사람이 치는 글이 아니라 단추가 보낸다 · 대화에 그대로 보이니 짧고 쉬운 말로) ──
//  #4667 저장은 나만 보는 판(새 앱 · 공개한 앱의 초안)이고 공개는 사람이 정한다 — 모든 글에 같은 문장(격리 리뷰 2-7).
const NO_PUBLISH = '저장하면 비공개 버전이 되고, 공개는 내가 정하니 app_visibility_set 은 부르지 마.';
const RULE = '만드는 법은 지식 app-build-quickstart 에 있어(knowledge_get 으로 그것만 읽고 다른 건 찾아보지 마). ' + NO_PUBLISH;
//  벤치마크(원준 2026-10-15) — 기획 카드를 쓰기 전에 비슷한 앱 · 서비스의 구조 · 기능을 견준다. 라이블리 지식을 뒤지라는 말이 아니다(RULE 과 어긋나지 않게).
const BENCH = '먼저 비슷한 앱 · 서비스(같은 일을 하며 오래 널리 쓰여 온 회사 제품 두셋)를 조사해 화면 구조 · 기능을 견줘 보고 좋은 점을 기획에 담아 줘(웹 검색을 쓸 수 있으면 찾아봐도 돼 · 라이블리 지식은 더 찾지 말고).';
//  초안을 짤 때 맨 먼저 할 일(원준 2026-10-16 «처음에 시안 짤 때 비슷한 기능 하는 레거시 회사들이나 UI 조사도 해서 그거랑 비슷하게 만드는 걸 높은 우선순위로»).
const LEGACY = '★ 우선순위 높음 — 짜기 전에 이 앱과 같은 일을 하는 기존 서비스(오래 쓰여 온 회사 제품 두셋)의 화면 구성 · 기능 · UI 를 조사하고(웹 검색을 쓸 수 있으면 찾아봐), 그 익숙한 꼴과 비슷하게 짜 줘 — 처음 보는 사람도 바로 쓸 줄 아는 화면이 목표야. 카드의 「참고한 것」 이 그 출발점이야.';
/** 화면 흐름 와이어프레임(원준 2026-10-15 «초안 만든 뒤 와이어프레임 볼 수 있게 · 클로드 아티팩트처럼 버튼 누르면») — 앱 패키지의 이 파일을 앱빌더 ③ 「와이어프레임 보기」 가 띄운다. */
export const WIREFRAME_PATH = 'studio/wireframe.html';
const WIRE = `저장할 때 화면 흐름 와이어프레임도 함께 넣어 줘: app_save 의 files 에 ${WIREFRAME_PATH} — 피그마 보드처럼 이 앱의 화면을 한 장씩 프레임으로 가로로 나란히 놓고(화면이 하나여도 한 장), 프레임마다 위에 화면 이름표 · 안은 얇은 선(1px 회색)으로 그린 칸 · 글 · 단추, 그리고 **단추 하나하나마다** 그 단추에서 나가는 화살표로 어느 화면(또는 어느 칸)으로 이어지는지 이어 그린 HTML 한 장(외부 자원 없이 · 흰 바탕 · 앱 화면이 아니라 설명 그림 · 화면 수만큼 넓어도 된다).`;
/** ① 사람이 적은 설명(여러 줄일 수 있다)과 이름(비면 AI 가 짓는다)으로 기획 카드를 청한다. */
export function planBrief(what: string, place: StudioPlace, name = ''): string {
  const desc = String(what || '').trim(), nm = String(name || '').trim();
  const head = desc.includes('\n') ? `이런 앱을 만들고 싶어:\n${desc}\n` : `「${desc}」 앱을 만들고 싶어. `;
  return `${head}${nm ? `앱 이름은 「${nm}」 로 해 줘(기획 카드 이름 줄에 그대로). ` : ''}${PLACE[place].say}\n`
    + `아직 만들지 말고, ${BENCH} `
    + '그다음 내가 확인할 기획 카드만 아래 꼴 그대로 답해 줘(앞뒤에 다른 말 없이 · 각 줄 한 문장 · 할 수 있는 것은 셋을 · 로 · 참고한 것은 어디서 무엇을 가져왔는지):\n'
    + '[[기획카드]]\n이름: \n누가 쓰나: \n무엇을 적나: \n할 수 있는 것: \n안 하는 것: \n첫 화면: \n참고한 것: \n[[/기획카드]]';
}
/** ②→③ 첫 판 — appId 는 「만들기 시작」 때 서버가 예약해 둔 앱(#4667). 그 id 로 저장해야 이 만들기의 앱이 된다(다르면 서버가 409). */
export function draftBrief(card: StudioCard, place: StudioPlace, appId = ''): string {
  const id = String(appId || '').trim();
  return `이 기획 카드대로 초안을 만들어 저장해 줘. ${PLACE[place].say}\n${LEGACY}\n${cardText(card)}\n${RULE}\n${WIRE}\n`
    + (id ? `이 앱의 id 는 ${id} 로 미리 잡아 뒀어 — lively-app.json 의 id 를 꼭 ${id} 로 해 줘.\n` : '')
    + '진행을 알 수 있게 단계마다 한 줄씩 먼저 보내 줘: [[걸음 1/4]] 기획 읽음 → [[걸음 2/4]] 화면 짬 → [[걸음 3/4]] 자료 표 → [[걸음 4/4]] 저장. '
    + 'app_save 의 note 는 「초안 · 무엇이 되는지 한 줄」. 끝나면 쉬운 말 두 줄만(코드 · 파일 · 도구 이름은 빼고).';
}
/** ④ 짚은 곳 — 선택한 요소(pick) · 핀(pin, 기본) · 영역(box). 좌표는 앱 화면의 비율(0~1), w · h 는 요소 · 영역의 크기. */
/** on: 'wire' — 앱 화면이 아니라 「와이어프레임(화면 흐름) 보기」 보드에서 짚은 곳(좌표는 그 그림 전체의 비율). 없으면 앱 화면. */
export interface StudioPin { x: number; y: number; where: string; note: string; kind?: 'pick' | 'pin' | 'box'; w?: number; h?: number; on?: 'wire' }
export function fixBrief(round: number, pins: StudioPin[], general: string, place: StudioPlace, appId: string): string {
  const lines: string[] = [];
  const pc = (v?: number): number => Math.round((v || 0) * 100);
  pins.forEach((p, i) => {
    if (!p.note.trim()) return;
    const at = `왼쪽에서 ${pc(p.x)}% · 위에서 ${pc(p.y)}%`;
    //  와이어프레임 보드에서 짚은 곳은 그 그림(${WIREFRAME_PATH}) 안의 자리다 — 앱 화면의 자리와 섞이지 않게 말머리를 가른다.
    const on = p.on === 'wire' ? `와이어프레임(${WIREFRAME_PATH})의` : '화면의';
    if (p.kind === 'pick') lines.push(`[선택한 요소 ${i + 1}] ${p.where || '요소'} — ${on} ${at} · 폭 ${pc(p.w)}% · 높이 ${pc(p.h)}% → ${p.note.trim()}`);
    else if (p.kind === 'box') lines.push(`[영역 ${i + 1}] ${on} ${at} 지점부터 폭 ${pc(p.w)}% · 높이 ${pc(p.h)}% 인 영역${p.where ? ' · 가운데 ' + p.where : ''} → ${p.note.trim()}`);
    else lines.push(`[핀 ${i + 1}] ${on} ${at} 자리${p.where ? ' · ' + p.where : ''} → ${p.note.trim()}`);
  });
  if (general.trim()) lines.push(`[앱 전체] ${general.trim()}`);
  return `${round}번째 고침이야. 아래를 반영해 새 버전으로 저장해 줘(app_pull ${appId} 로 지금 버전을 받아 고치고 app_save · note 는 바뀐 점 한 줄 · 화면 흐름이 바뀌면 ${WIREFRAME_PATH} 도 맞춰 고쳐 · 그 파일이 아직 없으면 이번에 함께 그려). ${PLACE[place].say} ${NO_PUBLISH} 못 하는 건 이유 한 줄로.\n${lines.join('\n')}`;
}
/** ③ 「세션 위젯으로 보기」 시험 세션의 첫 지시 — 앱을 **써 보는** 세션이지 고치는 세션이 아니다(원준 2026-10-15 «수정을 위한 AI 세션이 아니어야»). */
export function tryBrief(title: string, appId: string): string {
  //  시험 세션은 터미널로 바로 열린다(원준 2026-10-16 «그냥 한 방에 터미널로 보이게») — 터미널엔 이 글이 첫 줄로 남으니 한 줄로 짧게.
  //   머리(이 세션은 「…」 앱(app_id …)을 시험해 보는 세션이야)는 lib/builder-flow TRY_TITLE_RE 가 시험 세션을 알아보는 표식이라 그대로 둔다.
  return `이 세션은 「${title}」 앱(app_id ${appId})을 시험해 보는 세션이야. 앱 코드는 고치지 말고(app_pull · app_save 금지), 사람이 앱을 쓰며 묻는 것에 앱의 지침과 표로 답해 줘. 지금은 「준비됐어요」 한 줄만.`;
}
/** ③ 「와이어프레임 보기」 — 와이어프레임이 없는 앱(옛 앱)에 그려 달라고 한다. 앱 화면은 그대로 두고 그 파일만 더해 저장한다. */
export function wireframeBrief(appId: string): string {
  return `이 앱의 화면 흐름 와이어프레임을 그려 줘. app_pull ${appId} 로 받아 앱 화면은 그대로 두고 ${WIREFRAME_PATH} 파일만 더해 app_save 해 줘(note 는 「와이어프레임 더함」 · ${NO_PUBLISH}) — `
    + `화면마다 회색 상자로 그린 그림과, 무엇을 누르면 어느 화면(또는 어느 칸)으로 가는지 화살표 · 짧은 설명을 그린 한 장짜리 HTML(외부 자원 없이 · 흰 바탕 · 앱 화면이 아니라 설명 그림). 끝나면 「그렸어요」 한 줄만.`;
}
export function checkBrief(card: StudioCard, appId: string): string {
  return `기획 카드와 지금 버전(app_pull ${appId})을 대조해서 이 한 줄로만 답해 줘:\n[[대조]] 있음: (들어간 「할 수 있는 것」을 · 로) | 빠짐: (안 들어간 것 · 없으면 없음)\n${cardText(card)}`;
}
export function notifyBrief(name: string, line: string, slack: string): string {
  return `이 앱을 팀에 알려 줘. 지식에 제목 「앱 소개 · ${name}」 으로 아래 글을 저장하고(knowledge_save · 분류는 「세션 작업환경」)`
    + (slack.trim() ? `, 슬랙 채널 ${slack.trim()} 에도 같은 글을 보내 줘(못 보내면 지식만)` : '')
    + '. 끝나면 「알렸어요」 한 줄만.\n글: ' + line;
}
export function copyBrief(copyIdStr: string, copyTitle: string, originTitle: string, originBy: string, place: StudioPlace): string {
  return `워크스페이스 앱 「${originTitle}」${originBy ? '(' + originBy + ' 님이 만듦)' : ''} 의 내 사본 「${copyTitle}」(id ${copyIdStr}) 이 방금 저장돼 있어. app_pull ${copyIdStr} 로 받아 둬. `
    + `원본은 건드리지 말고, 내가 보내는 고침만 이 사본에 반영해 새 버전으로 저장해 줘(app_save · note 는 바뀐 점 한 줄). ${PLACE[place].say} ${RULE} 지금은 「받았어요」 한 줄만.`;
}
export function editBrief(appId: string, title: string, place: StudioPlace): string {
  return `워크스페이스 앱 「${title}」(id ${appId}) 을 고치려고 해. app_pull ${appId} 로 받아 둬. 내가 보내는 고침을 반영해 새 버전으로 저장해 줘(app_save · note 는 바뀐 점 한 줄 · 모두가 쓰는 앱이니 있던 것은 그대로). ${PLACE[place].say} ${RULE} 지금은 「받았어요」 한 줄만.`;
}

/** 앱 틀 안에 넣는 탐침 — 「찍어서 의견」: 호스트가 비율 좌표를 주면 그 자리의 요소(태그 · 글)를 알려 주고 테두리를 그린다. */
export const PROBE_JS = "(function(){var box=null;function mark(r){if(!box){box=document.createElement('div');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7B61E0;border-radius:4px;background:rgba(123,97,224,.12);box-shadow:0 0 0 2px #fff';document.documentElement.appendChild(box);}box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';box.style.display='';}"
  + "window.addEventListener('message',function(ev){var m=ev.data;if(!m||typeof m!=='object')return;if(m.__studio==='clear'){if(box)box.style.display='none';return;}if(m.__studio!=='hit')return;"
  + "var W=innerWidth||1,H=innerHeight||1,e=document.elementFromPoint(m.x*W,m.y*H)||document.body;var t=(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);var r=e.getBoundingClientRect();mark(r);"
  + "parent.postMessage({__studio:'hitres',id:m.id,tag:e.tagName.toLowerCase(),text:t,rect:{l:r.left/W,t:r.top/H,w:r.width/W,h:r.height/H}},'*');});})();";

/** 찍은 자리를 AI 에게 말할 때의 글 — 「<h1 「이번 회의 안건」>」. */
export function whereText(hit: { tag?: string; text?: string } | null): string {
  if (!hit || !hit.tag) return '';
  const t = String(hit.text || '').trim();
  return '<' + hit.tag + (t ? ' 「' + t.slice(0, 40) + (t.length > 40 ? '…' : '') + '」' : '') + '>';
}
