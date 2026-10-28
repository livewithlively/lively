// lib/studio-flow.ts — 앱 만들기 흐름의 **순수** 부분(#4592, 원준 2026-10-11 «기획 → 시안 → 의견 왕복 → 확인 → 넣기, 그리고 팀과»).
//  화면(web/v2/app-studio.ts)은 여기 함수로 AI 답을 읽고(기획 카드 · 걸음 · 점검) 단계마다 보낼 글을 만든다.
//  AI 와의 약속(지식 app-build-quickstart 에도 같은 꼴이 적혀 있다):
//   · 기획 카드  [[기획카드]] … [[/기획카드]]   줄마다 「줄 이름: 값」(CARD_ROWS · 더한 항목은 그 뒤)
//   · 걸음      [[걸음 n/4]]                   1 기획 읽음 · 2 화면 짬 · 3 자료 표 · 4 저장
//   · 점검      [[대조]] 있음: a · b | 빠짐: 없음
//   · 아이콘    [[아이콘]] path: … | color: #… | dark: #…   ④ 「AI에게 그려 달라기」 의 답(앱은 저장하지 않는다)
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

//  단계 바는 **와 본 곳이면 앞으로도** 간다(원준 2026-10-19 «내용 다 저장했었으면 이전으로 가는거 말고 다음으로 가는것도 있어야 · (3)하는 도중에 뒤로 뒤로 눌러서
//   (1)로 간 다음에 이전 (3)으로 다시 가는 느낌은 없고 밑에 이 내용으로 다시 기획 이거밖에 없어서 어색해 · 상단 탭을 클릭하는 방향으로도 원하는 위치로»).
//   «와 본 곳» 의 끝 = reached. 그 뒤 단계의 내용이 낡으면 끝을 당긴다 — 기획을 다시 받으면 ②, 새 버전이 나오면 ③(그 버전으로 ④ 확인 · ⑤ 넣기를 다시 해야 한다).
/** 한 번이라도 와 본 가장 뒤 단계(0~4). 기록에 없으면(옛 기록) 지금 단계 · 앱이 있으면 ③ · 넣었으면 ⑤ 까지. */
export function reachedOf(r: { stage: 'what' | StudioStage; appId?: string; done?: boolean; reached?: number }): number {
  const base = Math.max(stageIndex(r.stage), r.appId ? 2 : 0, r.done ? 4 : 0);
  const n = Number(r.reached);
  return Number.isFinite(n) && n >= 0 ? Math.max(base, Math.min(STAGES.length - 1, Math.floor(n))) : base;
}
/** 단계 바 칸마다의 꼴 — on 지금 · back 눌러서 돌아간다 · ahead 눌러서 다시 간다(와 본 곳) · done 지나왔지만 못 간다(고치기 · 사본의 ①②는 원본의 것) · todo 아직. */
export type StageTab = 'on' | 'back' | 'ahead' | 'done' | 'todo';
export function stageTabs(cur: number, reached: number, mode: 'new' | 'copy' | 'edit'): StageTab[] {
  return STAGES.map((_, i) => {
    if (i === cur) return 'on';
    const open = mode === 'new' || i >= 2;
    if (i < cur) return open ? 'back' : 'done';
    return open && i <= reached ? 'ahead' : 'todo';
  });
}
/** 「다음 →」 이 갈 단계 — 바로 다음 칸이 와 본 곳이면 그 번호, 아니면 -1(아직 안 간 단계는 그 단계의 주 단추가 연다). */
export function nextStageOpen(cur: number, reached: number, mode: 'new' | 'copy' | 'edit'): number {
  const i = cur + 1;
  return i < STAGES.length && stageTabs(cur, reached, mode)[i] === 'ahead' ? i : -1;
}

//  앱 화면에는 라이블리 사이드바가 없다(원준 2026-10-17 «사이드바 내용까지가 하나의 앱이야 … 앱빌더로 만들때는 디폴트가 없는거임 · 없을 때에는 사이드바 영역만큼도
//   다 그 앱이 쓰는게 디폴트»). 셸은 앱 화면(#/i)에서 사이드바 열을 접는다(lib/side-owner) — AI 가 왼쪽 목록을 기본으로 그리지 않게 이 사실을 말해 둔다.
export const FULL_NO_SIDE = '앱 화면은 라이블리 사이드바 없이 창 가득 열려(그 자리까지 앱이 써). 사이드바는 기본으로 두지 말고, 목록을 옆에 두고 써야 하는 앱일 때만 앱 안 왼쪽에 직접 그려.';
// 사람에게 보이는 이름은 둘로 통일한다(원준 2026-10-14) — 세션 오른쪽에 붙는 것 = 「세션 위젯」, 화면 전체로 여는 것 = 「앱 화면」.
export const PLACE: Record<StudioPlace, { title: string; sub: string; say: string; width: string }> = {
  side: { title: '세션 위젯', sub: 'AI 세션 오른쪽에 붙여 써요. AI에게 말하면 위젯 내용을 읽고 바꿔줘요.', say: '세션 위젯(세션 오른쪽 사이드바, 폭 340px 안팎)으로 붙여 쓰는 앱이야. 좁은 폭에서 잘 보이게 만들어 줘.', width: '세션 위젯 폭(360px)' },
  full: { title: '앱 화면', sub: '앱 찾기에서 열어 전체 화면으로 써요.', say: '앱 찾기에서 열어 화면 전체로 넓게 쓰는 앱이야. ' + FULL_NO_SIDE + ' 넓은 화면에 맞게 만들어 줘.', width: '앱 화면 폭' },
  both: { title: '둘 다', sub: '세션 위젯으로도, 앱 화면으로도 써요.', say: '세션 위젯(세션 오른쪽 좁은 사이드바)으로도 붙이고 화면 전체로도 여는 앱이야. ' + FULL_NO_SIDE + ' 좁을 때와 넓을 때 둘 다 잘 보이게 만들어 줘.', width: '세션 위젯 폭과 앱 화면 폭 둘 다' },
};

//  ref(참고한 것) — 원준 2026-10-15 «초안 만들 때 비슷한 다른 앱이나 서비스 있으면 구조나 기능 같은 거 벤치마크해서 참고해서». 옛 카드엔 없다(빈 글로 읽는다).
//  notify(알림) — 원준 2026-10-17 «알림에 대한 것도 앱 빌딩할 때 전반적으로 설정해야 하는 중요한 체계 … 기획 카드나 이런 데에도 다 넣어야». 옛 카드엔 없다(빈 글).
//  extra(더한 항목) — 원준 2026-10-26 «원하면 그냥 섹션 제목(첫 화면, 알림에 이어서)과 본문도 원한다면 더 추가해서 넣을 수 있게». 정해진 줄 뒤에 제목 · 본문 한 쌍씩.
//   카드 글(cardText)에 「제목: 본문」 줄로 실려 AI 가 초안 · 고침 · 대조에서 같이 읽는다. 옛 카드엔 없다.
export interface CardExtra { title: string; body: string }
export interface StudioCard { name: string; who: string; items: string; can: string[]; not: string; first: string; ref?: string; notify?: string; extra?: CardExtra[] }
//  줄 이름(원준 2026-10-26 «무엇을 적나 이런거 좀 이상한데, 좀 명확하게 이해되는 표현으로») — 화면 · AI 에게 보내는 카드 글 · ④ 대조가 같은 이름을 쓴다.
//   옛 이름(누가 쓰나 · 무엇을 적나 · 할 수 있는 것 · 안 하는 것 · 참고한 것)도 KEY_OF 가 그대로 읽는다 — 옛 대화 · 옛 카드 · 옛 이름으로 답한 AI.
/** 정해진 줄의 칸 — 더한 항목(extra)은 줄이 아니다. */
export type CardRowKey = Exclude<keyof StudioCard, 'extra'>;
export const CARD_ROWS: Array<{ k: CardRowKey; label: string; hint: string }> = [
  { k: 'name', label: '앱 이름', hint: '짧은 한글 이름' },
  { k: 'who', label: '쓰는 사람', hint: '예: 회의를 준비하는 사람과 참석자' },
  { k: 'items', label: '저장하는 정보', hint: '예: 안건 제목, 날짜, 끝남 표시' },
  { k: 'can', label: '주요 기능', hint: '세 가지. 예: 더하기, 회의별 보기, 끝난 것 접기' },
  { k: 'not', label: '넣지 않는 기능', hint: '예: 회의록 쓰기, 알림 보내기' },
  { k: 'first', label: '첫 화면', hint: '예: 이번 회의 안건 목록(안 끝난 것 먼저)' },
  { k: 'notify', label: '알림', hint: '언제 누구에게 알리나. 예: 나를 언급하면 · 새 안건마다 담당자에게 · 없음' },
  { k: 'ref', label: '참고한 서비스', hint: '비슷한 서비스에서 가져온 구조나 기능. 예: Otter의 회의 목록과 정리본 탭' },
];
/** 줄 이름(띄어쓰기를 뗀 꼴) → 칸. 지금 이름과 옛 이름을 함께 받는다. */
const KEY_OF: Array<[RegExp, CardRowKey]> = [
  [/^(앱)?이름$/, 'name'], [/^누가|^쓰는사람/, 'who'], [/^(무엇을적나|적는것|무엇을|적는칸|칸|저장하는정보|저장하는것)$/, 'items'],
  [/^할수있는것|^기능|^주요기능/, 'can'], [/^안하는것|^하지않는것|^넣지않는/, 'not'], [/^첫화면|^처음화면/, 'first'], [/^알림/, 'notify'], [/^참고/, 'ref'],
];
/** 이 줄 이름이 정해진 줄의 것인가 — 더한 항목의 제목이 정해진 줄로 읽히지 않게(extraLine). */
const fixedKeyOf = (label: string): CardRowKey | null => { const key = label.replace(/\s+/g, ''); const k = KEY_OF.find(([r]) => r.test(key)); return k ? k[1] : null; };
/** 더한 항목의 제목으로 읽을 수 있는 꼴 — 글자 · 숫자 · 띄어쓰기 · 가운뎃점만(링크 주소가 이어진 줄 «Skills](https» 같은 조각은 아니다).
 *  쓰는 쪽(extraLine)도 제목을 이 꼴로만 쓴다 — 쓴 것이 다시 읽히게. */
const EXTRA_TITLE = /^[\p{L}\p{N} ·]{1,20}$/u;
const EXTRA_TITLE_OFF = /[^\p{L}\p{N} ·]+/gu;
/** 링크 한 줄(«https://…» — 제목 자리에 주소의 머리가 온 것)은 더한 항목이 아니다. */
const URL_HEAD = /^(https?|ftp|mailto|file)$/i;
/** 더한 항목 한 쌍 → 카드 글 한 줄. 비었으면 빈 글. 제목이 정해진 줄 이름과 겹치면 「추가 」 를 붙여 따로 읽히게. */
function extraLine(x: CardExtra): string {
  const t = String(x.title || '').replace(EXTRA_TITLE_OFF, ' ').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
  const b = String(x.body || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!t && !b) return '';
  const title = !t ? '추가 내용' : fixedKeyOf(t) ? ('추가 ' + t).slice(0, 20) : t;
  return title + ': ' + b;
}
const LABEL = Object.fromEntries(CARD_ROWS.map((r) => [r.k, r.label])) as Record<CardRowKey, string>;
export function splitList(s: string): string[] { return String(s || '').split(/\s*[·•,|]\s*|\s+\/\s+|\n/).map((x) => x.trim()).filter(Boolean); }
export function emptyCard(): StudioCard { return { name: '', who: '', items: '', can: [], not: '', first: '', ref: '', notify: '' }; }

/** AI 답 글에서 기획 카드를 읽는다 — 블록이 여럿이면 마지막. 이름이 없으면 카드가 아니다. */
export function parseCard(text: string): StudioCard | null {
  const re = /\[\[기획\s*카드\]\]([\s\S]*?)\[\[\/기획\s*카드\]\]/g; let m: RegExpExecArray | null; let body = '';
  while ((m = re.exec(String(text || '')))) body = m[1];
  if (!body) return null;
  const c = emptyCard(); let hit = false;
  body.split('\n').forEach((line) => {
    const mm = /^\s*([-*•]|\d+[.)])?\s*([^:：]{1,20})[:：]\s*(.*)$/.exec(line); if (!mm) return;
    const key = mm[2].replace(/\s+/g, ''), val = mm[3].trim();
    const k = KEY_OF.find(([r]) => r.test(key));
    //  모르는 이름의 줄 = 더한 항목. 단 줄머리(- · 1.)가 붙은 줄은 위 줄의 하위 목록이고(«- 올리기: 음성 업로드»), 링크 한 줄도 아니다.
    if (!k) { const t = mm[2].trim(); if (!mm[1] && val && EXTRA_TITLE.test(t) && !URL_HEAD.test(t) && !val.startsWith('//')) (c.extra = c.extra || []).push({ title: t, body: val }); return; }
    hit = true;
    if (k[1] === 'can') c.can = splitList(val); else c[k[1]] = val;
  });
  return hit && c.name ? c : null;
}
// ── 「참고한 서비스」 보기(원준 2026-10-26 «주소 그냥 하이퍼링크로 … 뭘 참고했는지도 줄바꿈 … 텍스트 박스 안에서 이쁘게» · «주소 일일이 복붙해야하더라») ──
//  카드 글은 한 줄이라 AI 는 «이름: 것 ; 이름: 것 ; 출처: [이름](주소)» 로 쓴다(planBrief). 그 전 카드는 산문
//   («A에서는 …을, B에서는 …을 가져왔습니다(출처: [..](..), …)») — 둘 다 서비스마다 한 항목 · 링크 목록으로 푼다. 화면은 이것만 그리고, 고칠 땐 원문 그대로.
export interface RefLink { label: string; url: string }
export interface RefView { items: Array<{ name: string; text: string }>; links: RefLink[] }
//  이름 칸은 대괄호 한 겹까지(«[Foo [1]]»), 주소 칸은 괄호 한 겹까지(위키백과 «Foo_(bar)») — 격리 리뷰: 괄호에서 주소가 잘려 엉뚱한 곳으로 가던 것.
const MD_LINK = /\[((?:[^\[\]\n]|\[[^\[\]\n]*\]){1,120})\]\(\s*((?:[^\s()]|\([^\s()]*\))+)\s*\)/g;
const BARE_URL = /https?:\/\/(?:[^\s()<>"'\[\]，]|\([^\s()<>"']*\))+/g;
/** 맨 주소 끝에 붙은 문장 부호(. , ; : ! ?)는 주소가 아니다. */
const trimUrlTail = (u: string): string => u.replace(/[.,;:!?。、]+$/, '');
/** http(s) 주소만 링크로 — javascript: · data: 같은 것은 링크가 아니다. */
const safeUrl = (u: string): string => (/^https?:\/\/[^\s]+$/i.test(u) ? u : '');
const hostOf = (u: string): string => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } };
export function refView(text: string): RefView {
  const links: RefLink[] = [];
  let s = String(text || '');
  s = s.replace(MD_LINK, (_, label: string, url: string) => { const u = safeUrl(url); if (u) links.push({ label: label.trim(), url: u }); return u ? ' ' : label; });
  s = s.replace(BARE_URL, (m: string) => { const u = trimUrlTail(m); links.push({ label: hostOf(u), url: u }); return ' ' + m.slice(u.length); });
  //  링크를 걷고 남은 «(출처: , , )» · «; 출처: , ,» 꼬리
  s = s.replace(/[(（]\s*(출처|참고)\s*[:：][\s,·、]*[)）]/g, ' ').replace(/(^|;)\s*(출처|참고 링크)\s*[:：][\s,·、]*(?=;|$)/g, '$1');
  const tidy = (t: string): string => t.replace(/\s*·\s*/g, ', ').replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[,;.\s]+|[,;\s]+$/g, '').trim();
  let parts: Array<{ name: string; text: string }>;
  if (s.includes(';')) {
    parts = s.split(/\s*;\s*/).map((p) => { const m = /^([^:：]{1,30})[:：]\s*(.+)$/.exec(p.trim()); return m ? { name: m[1].trim(), text: m[2] } : { name: '', text: p }; });
  } else {
    parts = s.split(/,\s*(?=[^,]{1,30}?에서는\s)/).map((p) => { const m = /^\s*(.{1,30}?)에서는\s+([\s\S]+)$/.exec(p); return m ? { name: m[1].trim(), text: m[2] } : { name: '', text: p }; });
  }
  const items = parts.map((x) => ({ name: x.name, text: tidy(x.text.replace(/\s*(을|를)?\s*(가져왔|참고했)[^,;]*$/, '').replace(/(을|를)\s*$/, '')) })).filter((x) => x.text || x.name);
  //  다 걷고 아무것도 안 남았는데 원문이 있으면(«참고했습니다» · «;») — 빈 칸 대신 원문 그대로.
  if (!items.length && !links.length && String(text || '').trim()) items.push({ name: '', text: String(text).trim() });
  return { items, links };
}
export function cardText(c: StudioCard): string {
  const extra = (Array.isArray(c.extra) ? c.extra : []).map(extraLine).filter(Boolean);
  return '[[기획카드]]\n' + [...CARD_ROWS.map((r) => r.label + ': ' + (r.k === 'can' ? (c.can || []).join(' · ') : String(c[r.k] || ''))), ...extra].join('\n') + '\n[[/기획카드]]';
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

/** 앱빌더 ④ 의 «마무리» 저장(이름 · 자리 · 넣기 표시) — AI 가 고친 판이 아니다. 되돌리기 · 대조가 이 판을 건너뛴다(점검 2-7). */
export const isWrapNote = (note: string | null | undefined): boolean => /^마무리 · /.test(String(note || '').trim());
/** 지금 판(cur)의 «내용 판»(마무리 판이면 그 아래 마지막 AI 판)과 「이전 버전으로」 가 갈 판(내용 판 아래 마지막 AI 판 · 없으면 0).
 *  마무리 판 V7 위에서 「V6로 되돌리기」 를 누르면 이름 · 넣기 표시만 되돌아가던 것(점검 2-7). */
export function verPlan(vs: ReadonlyArray<{ version_no: number; note: string | null }>, cur: number): { base: number; prev: number } {
  const below = vs.filter((v) => v.version_no <= cur).slice().sort((a, b) => b.version_no - a.version_no);
  const baseV = below.find((v) => !isWrapNote(v.note));
  const base = baseV ? baseV.version_no : cur;
  const prevV = below.find((v) => v.version_no < base && !isWrapNote(v.note));
  return { base, prev: prevV ? prevV.version_no : 0 };
}
/** 서버 사건 글의 「판」 낱말 — 화면 글에는 이 낱말을 쓰지 않아서(K1 이 소스를 훑는다) 서버가 쓴 글을 읽는 자리만 코드 포인트로 적는다. */
const PAN = '\uD310';
const RE_REVERT = new RegExp('^되돌림 → (\\d+)' + PAN + '$'), RE_PUB = new RegExp('^(\\d*)' + PAN + ' 공개$'), RE_NO = new RegExp('(\\d+)' + PAN, 'g');
/** 앱 사건의 note 가 사람(화면)이 한 일인가 — 되돌림 · 공개 · 마무리 · 배포 설정의 자리 바꿈. 그건 AI 고침이 끝난 표시가 아니다(점검 2-3). */
export function systemNote(note: string | null | undefined): boolean {
  const t = String(note || '').trim();
  return RE_REVERT.test(t) || RE_PUB.test(t) || isWrapNote(t) || /^쓰는 자리 · /.test(t);
}
/** 서버가 적은 글을 화면 말로 — 판 번호 → V · 「—」 는 마침표로 끊는다(점검 6-13 · 2-4). */
export function plainNote(note: string | null | undefined): string {
  const t = String(note || '').trim();
  let m = RE_REVERT.exec(t); if (m) return verJ(Number(m[1]), '으로') + ' 되돌렸어요';
  m = RE_PUB.exec(t); if (m) return m[1] ? verJ(Number(m[1]), '을') + ' 공개했어요' : '공개했어요';
  return t.replace(RE_NO, (_, n) => verName(Number(n)) || n + '번째 버전').replace(/\s*—\s*/g, '. ').replace(/\s*→\s*/g, ', ').trim();
}

export const DRAFT_STEPS = ['기획 읽는 중', '화면 짜는 중', '자료 표 만드는 중', '저장하는 중'];
/** [[걸음 n/4]] 가운데 가장 큰 n(1~4) · 없으면 0. */
export function parseStep(text: string): number {
  const re = /\[\[걸음\s*(\d)\s*(?:\/\s*\d)?[^\]]*\]\]/g; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(String(text || '')))) n = Math.max(n, Math.min(4, Number(m[1]) || 0));
  return n;
}

/** 기다리던 AI 일이 멈춘 까닭 — ask 확인을 기다림 · offline 세션이 돌던 컴퓨터가 꺼짐(잠듦) · ended 세션이 꺼짐 · idle 턴이 끝났는데 결과가 없음
 *  · limit AI 사용 한도에 걸려 턴이 끝남(세션 줄로는 idle 과 같다 — 답 글로 안다 · parseLimit). */
export type RunStall = 'ask' | 'offline' | 'ended' | 'idle' | 'limit';
/** 멈춤이 이만큼 이어져야 화면이 멈췄다고 말한다 — 말을 막 보낸 틈 · 저장 직후 앱을 찾는 틈에 잘못 말하지 않게. */
export const STALL_MS = 30000;
export interface RunRow { agentState?: string; working?: boolean; awaiting?: boolean; background?: boolean; restorable?: boolean; observed?: boolean; node?: { online?: boolean } | null }
/**
 * 세션 한 줄(GET /api/ui/terminal/sessions?only=<sid>)로 기다리던 AI 일이 멈췄는지 본다. 도는 중이거나 모르면 null.
 *  원준 2026-10-26 — 만들기 세션이 돌던 노트북이 잠들어 턴이 끝났는데 화면은 몇 시간째 «만들고 있어요» 였다.
 */
export function runStall(row: RunRow | null | undefined): RunStall | null {
  if (!row) return 'ended';
  if (row.observed === false) return null;   // 게이트웨이가 못 본 틱에 지어낸 줄 — 모르면 멈췄다 하지 않는다
  if (row.node && row.node.online === false) return 'offline';
  if (row.restorable) return 'ended';
  if (row.awaiting || row.agentState === 'waiting') return 'ask';
  if (row.working || row.background || row.agentState === 'busy') return null;
  return 'idle';
}
/**
 * AI 답 글이 «사용 한도에 걸렸다» 는 하네스의 알림인지 — 맞으면 화면에 쓸 한 줄(풀리는 때 포함), 아니면 null.
 *  원준 2026-10-28 — 만들기 세션이 고침을 받자마자 «You've hit your weekly limit · resets 9am» 으로 끝났는데 화면은 «멈췄어요» 만 말하고 시계는 계속 갔다.
 *  하네스가 지어 넣는 짧은 줄만 본다(AI 가 코드 이야기를 하다 «rate limit» 을 쓴 긴 답을 한도로 읽지 않게).
 */
export function parseLimit(text: string): string | null {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  if (!/^(you[’']ve|you have) hit your\b[^\n]*\blimit\b|^(claude ai )?usage limit reached\b|^5-hour limit reached\b/i.test(t)) return null;
  const week = /\bweekly\b/i.test(t);
  let when = '';
  const m = /\bresets?\s+(?:(?:on\s+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(t);
  if (m) {
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = m[1] ? MON.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
    const h = Number(m[3]) % 12, pm = m[5].toLowerCase() === 'pm';
    when = (mi >= 0 ? (mi + 1) + '월 ' + Number(m[2]) + '일 ' : '') + (pm ? '오후 ' : '오전 ') + (h === 0 ? 12 : h) + '시' + (m[4] && m[4] !== '00' ? ' ' + Number(m[4]) + '분' : '');
  }
  return (week ? '이번 주 ' : '') + 'AI 사용 한도에 걸려 멈췄어요.' + (when ? ' ' + when + '에 풀려요.' : '');
}
/** 멈춘 일을 이어서 하라는 글 — 처음 일러 둔 표식 · 저장 방법을 다시 적는다(이어 쓴 답도 화면이 읽게). */
export function resumeBrief(kind: 'plan' | 'draft' | 'fix' | 'check'): string {
  const head = '하던 일이 중간에 끊겼어요(세션이 돌던 컴퓨터가 잠들었거나 세션이 멈췄어요). 이미 만든 것은 그대로 두고 멈춘 곳부터 이어서 끝내 줘.';
  if (kind === 'plan') return head + ' 기획 카드는 처음 말한 꼴 그대로 보내 줘.';
  if (kind === 'check') return head + ' [[대조]] 줄은 처음 말한 꼴 그대로 보내 줘.';
  if (kind === 'fix') return head + ' 끝나면 처음 말한 대로 새 버전으로 저장해 줘(app_save).';
  return head + ' 단계를 지날 때마다 [[걸음 n/4]] 표식을 먼저 보내고, 끝나면 처음 말한 대로 app_save 로 저장해 줘.';
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

// ── ④ 아이콘(원준 2026-10-28 «자동으로 만들어진 디자인 사항들도 정리해서 보여주면 · 아이콘 커스텀하는 창 · AI한테 그 아이콘 수정할 수 있는 창») ──
//  앱 아이콘은 매니페스트 icon {path, color, color_dark} 한 벌이고(#4769), 사이드바 줄 · 세션 위젯 탭 · 앱 찾기 타일이 같은 그림을 쓴다.
//  첫 판을 짤 때 AI 가 그리고(draftBrief ICON), ④ 에서 사람이 보고 고른다. 고른 것은 「완료 · 다음 단계로」 의 마무리 저장에 함께 실린다.
//  AI 에게 다시 그려 달라고 할 때는 앱을 저장하지 않고 [[아이콘]] 한 줄로만 받는다 — 버전이 올라가면 ④ 대조를 다시 해야 해서.
export interface StudioIcon { path: string; color: string; color_dark?: string }
//  서버(src/apps/manifest.ts APP_ICON_PATH_RE · APP_ICON_COLOR_RE)와 같은 잣대 — 여기서 걸러야 마무리 저장이 400 으로 안 막힌다.
const ICON_PATH_OK = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\-\s]{1,2000}$/;
const ICON_COLOR_OK = /^#[0-9a-fA-F]{6}$/;
/** 아이콘 선언을 서버 잣대로 거른다 — 틀리면 null. */
export function iconSpec(raw: unknown): StudioIcon | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null; if (!o) return null;
  const path = typeof o.path === 'string' ? o.path.replace(/\s+/g, ' ').trim() : '';
  const color = typeof o.color === 'string' ? o.color.trim() : '';
  const dark = typeof o.color_dark === 'string' ? o.color_dark.trim() : '';
  if (!ICON_PATH_OK.test(path) || !ICON_COLOR_OK.test(color)) return null;
  return ICON_COLOR_OK.test(dark) ? { path, color, color_dark: dark } : { path, color };
}
const ICON_SHAPE = '24×24 격자 위 선 그림 하나(SVG path d 에 명령과 숫자만 · 획 굵기 1.7 · 채우기 없음 · 선은 2~22 안 · 16px 에서도 알아볼 만큼 단순하게)';
//  첫 판에 아이콘을 넣는 약속 — 사이드바 · 세션 위젯 · 앱 찾기에 같은 그림이 선다.
const ICON = `lively-app.json 에 앱 아이콘도 넣어 줘: "icon": {"path": ${ICON_SHAPE}, "color": 밝은 바탕용 #RRGGBB, "color_dark": 어두운 바탕용 #RRGGBB}. 앱이 하는 일이 한눈에 보이는 그림으로(사이드바 · 세션 위젯 · 앱 찾기에 같은 그림이 나와).`;
/** ④ 「AI에게 그려 달라기」 — 앱은 저장하지 말고 [[아이콘]] 한 줄로만. ask 가 비면 앱이 하는 일로. */
export function iconBrief(title: string, appId: string, ask: string, now: StudioIcon | null): string {
  const want = String(ask || '').replace(/\s+/g, ' ').trim();
  return `「${title}」 앱(app_id ${appId})의 아이콘을 새로 그려 줘. ${want ? '원하는 그림: ' + want + '.' : '앱이 하는 일이 한눈에 보이는 그림으로.'} `
    + (now ? `지금 아이콘은 path "${now.path}" · 색 ${now.color}${now.color_dark ? ' / ' + now.color_dark : ''} 야. ` : '')
    + `${ICON_SHAPE}, 색은 밝은 바탕용과 어두운 바탕용 둘. 앱 코드는 고치지 말고(app_save 하지 마) 앞뒤에 다른 말 없이 이 한 줄로만 답해 줘:\n`
    + '[[아이콘]] path: (SVG path d) | color: #RRGGBB | dark: #RRGGBB';
}
/** [[아이콘]] path: … | color: #… | dark: #… — 여럿이면 마지막. 잣대에 안 맞으면 null. */
export function parseIcon(text: string): StudioIcon | null {
  const re = /\[\[아이콘\]\]\s*([^\n]*)/g; let m: RegExpExecArray | null; let line = '';
  while ((m = re.exec(String(text || '')))) line = m[1];
  if (!line) return null;
  const part = (label: RegExp): string => { const mm = label.exec(line); return mm ? mm[1].trim().replace(/^["'`]+|["'`]+$/g, '') : ''; };
  return iconSpec({ path: part(/path\s*[:：]\s*([^|]*)/i), color: part(/color\s*[:：]\s*([^|]*)/i), color_dark: part(/dark\s*[:：]\s*([^|]*)/i) });
}
/** ④ 그림 고르기의 기본 그림 — 레일 · 사이드바와 같은 선 그림 표(lib/icon-paths)의 이름. 앱이 흔히 하는 일 위주. */
export const ICON_GLYPHS = ['note', 'doc', 'list', 'task', 'chart', 'board', 'timeline', 'clock', 'bell', 'chat', 'quote', 'folder', 'img', 'star', 'bolt', 'spark', 'people', 'pen'] as const;
/** ④ 색 고르기 — 앱 아이콘 색 토큰(01-base.css · 90-dark.css --gi-c-*)과 같은 짝(밝은 바탕 · 어두운 바탕). */
export const ICON_COLORS: ReadonlyArray<{ color: string; color_dark: string; name: string }> = [
  { color: '#118E6E', color_dark: '#16B48C', name: '초록' }, { color: '#2D6BF0', color_dark: '#739DF5', name: '파랑' },
  { color: '#8A3FD1', color_dark: '#C084FC', name: '보라' }, { color: '#B0323F', color_dark: '#E8737F', name: '와인' },
  { color: '#D5541F', color_dark: '#E7845B', name: '주황' }, { color: '#D6457A', color_dark: '#E37EA3', name: '분홍' },
  { color: '#0D88A7', color_dark: '#10ACD3', name: '청록' }, { color: '#B36E18', color_dark: '#E08A1E', name: '호박' },
  { color: '#576889', color_dark: '#909EB8', name: '회색' },
];

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

/** 세션 기록(ndjson) 가운데 사람이 보낸 글만(도구 결과는 뺀다). */
export function userTexts(ndjson: string): string[] {
  const out: string[] = [];
  String(ndjson || '').split('\n').forEach((line) => {
    const s = line.trim(); if (!s) return;
    let o: any; try { o = JSON.parse(s); } catch (_) { return; }
    if (!o || o.type !== 'user') return;
    const c = o.message && o.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b && b.type === 'text').map((b: any) => String(b.text || '')).join('\n') : '';
    if (t.trim()) out.push(t);
  });
  return out;
}
/** 이 세션에 초안(첫 판)을 이미 청했나 — 기록이 없는 브라우저에서 이어 열 때 ② 의 「완료」 로 또 청하지 않게(점검 4-10). draftBrief 의 첫 말로 가린다. */
export const DRAFT_ASK_HEAD = '이 기획 카드대로 초안을 만들어 저장해 줘.';
export function draftAsked(ndjson: string): boolean { return userTexts(ndjson).some((t) => t.trim().startsWith(DRAFT_ASK_HEAD)); }

export function freshApps(known: string[], apps: Array<{ id: string; status?: string }>): string[] {
  return apps.filter((a) => a && (a.status == null || a.status === 'active') && !known.includes(String(a.id))).map((a) => String(a.id));
}

/** 사본 id — 원본 id + 내 id(짧게). 소문자 영숫자/- · 32자 안. */
export function copyId(originId: string, memberId: string): string {
  const me = String(memberId || 'me').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'me';
  const base = String(originId || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base.slice(0, 31 - me.length - 1) + '-' + me).replace(/-+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32);
}
/** 같은 원본으로 사본을 또 뜰 때 새 사본의 id · 번호 — copyId 뒤에 «-2», «-3» … 비어 있는 첫 번호(32자 안). 감사 1-4: 고쳐 둔 내 사본을 원본으로 덮지 않는다. */
export function nextCopyId(id: string, taken: ReadonlySet<string>): { id: string; n: number } {
  for (let n = 2; n < 1000; n++) {
    const tail = '-' + n;
    const x = id.slice(0, 32 - tail.length).replace(/-+$/, '') + tail;
    if (!taken.has(x)) return { id: x, n };
  }
  return { id: id.slice(0, 22) + '-' + Date.now().toString(36).slice(-9), n: 0 };
}

// ── 단계마다 보내는 글(사람이 치는 글이 아니라 단추가 보낸다 · 대화에 그대로 보이니 짧고 쉬운 말로) ──
//  #4667 저장은 나만 보는 판(새 앱 · 공개한 앱의 초안)이고 공개는 사람이 정한다 — 모든 글에 같은 문장(격리 리뷰 2-7).
const NO_PUBLISH = '저장하면 비공개 버전이 되고, 공개는 내가 정하니 app_visibility_set 은 부르지 마.';
const RULE = '만드는 법은 지식 app-build-quickstart 에 있어(knowledge_get 으로 그것만 읽고 다른 건 찾아보지 마). ' + NO_PUBLISH;
//  벤치마크(원준 2026-10-15) — 기획 카드를 쓰기 전에 비슷한 앱 · 서비스의 구조 · 기능을 견준다. 라이블리 지식을 뒤지라는 말이 아니다(RULE 과 어긋나지 않게).
const BENCH = '먼저 비슷한 앱 · 서비스(같은 일을 하며 오래 널리 쓰여 온 회사 제품 두셋)를 조사해 화면 구조 · 기능을 견줘 보고 좋은 점을 기획에 담아 줘(웹 검색을 쓸 수 있으면 찾아봐도 돼 · 라이블리 지식은 더 찾지 말고).';
//  초안을 짤 때 맨 먼저 할 일(원준 2026-10-16 «처음에 시안 짤 때 비슷한 기능 하는 레거시 회사들이나 UI 조사도 해서 그거랑 비슷하게 만드는 걸 높은 우선순위로»).
const LEGACY = '★ 우선순위 높음 — 짜기 전에 이 앱과 같은 일을 하는 기존 서비스(오래 쓰여 온 회사 제품 두셋)의 화면 구성 · 기능 · UI 를 조사하고(웹 검색을 쓸 수 있으면 찾아봐), 그 익숙한 꼴과 비슷하게 짜 줘 — 처음 보는 사람도 바로 쓸 줄 아는 화면이 목표야. 카드의 「' + LABEL.ref + '」가 그 출발점이야.';
/** 화면 흐름 와이어프레임(원준 2026-10-15 «초안 만든 뒤 와이어프레임 볼 수 있게 · 클로드 아티팩트처럼 버튼 누르면») — 앱 패키지의 이 파일을 앱빌더 ③ 「와이어프레임 보기」 가 띄운다. */
export const WIREFRAME_PATH = 'studio/wireframe.html';
//  알림 체계(#4769, 원준 2026-10-17) — 기획 카드의 「알림」 줄이 앱의 알림 권한 · 보내는 순간 · 앱 안 설정으로 이어진다. 앱 전체 on/off 는 라이블리 [나 ▸ 알림] 의 몫.
const NOTIFY = '알림: 기획 카드의 「알림」 줄이 「없음」 이 아니면 lively-app.json 에 permissions.notifications: true 를 켜고(app_notify 도구가 따라온다), 그 순간에 app_notify {member_id, title, body, href, dedupe_key} 로 받을 사람마다 보내 줘(href 는 #/open/<앱 id>?… — 앱이 lively.state 로 읽어 그 자리를 연다). 앱 안에는 사람마다 «무엇을 받을지»(예: 전부 · 나를 언급할 때만 · 없음) 고르는 설정을 두고 그 값은 보내는 쪽이 읽을 수 있게 앱 표에 저장해(개인 prefs 는 남이 못 읽어). 앱 전체 알림 켜고 끄기는 라이블리 [나 ▸ 알림] 이 맡으니 앱이 따로 만들지 마.';
const WIRE = `저장할 때 화면 흐름 와이어프레임도 함께 넣어 줘: app_save 의 files 에 ${WIREFRAME_PATH} — 피그마 보드처럼 이 앱의 화면을 한 장씩 프레임으로 가로로 나란히 놓고(화면이 하나여도 한 장), 프레임마다 위에 화면 이름표 · 안은 얇은 선(1px 회색)으로 그린 칸 · 글 · 단추, 그리고 **단추 하나하나마다** 그 단추에서 나가는 화살표로 어느 화면(또는 어느 칸)으로 이어지는지 이어 그린 HTML 한 장(외부 자원 없이 · 흰 바탕 · 앱 화면이 아니라 설명 그림 · 화면 수만큼 넓어도 된다).`;
/** ① 사람이 적은 설명(여러 줄일 수 있다)과 이름(비면 AI 가 짓는다)으로 기획 카드를 청한다. */
export function planBrief(what: string, place: StudioPlace, name = '', prev?: StudioCard | null): string {
  const desc = String(what || '').trim(), nm = String(name || '').trim();
  //  ① 로 돌아와 다시 기획 — 고쳐 둔 카드(사람이 고친 줄 · 더한 항목)를 버리지 않게 지난 카드를 함께 보낸다(점검 4-8).
  const keep = prev ? `\n지난 기획 카드야(사람이 고친 줄 · 더한 항목 포함). 바뀐 점만 반영하고 나머지 줄과 더한 항목은 그대로 둬:\n${cardText(prev)}\n` : '';
  const head = desc.includes('\n') ? `이런 앱을 만들고 싶어:\n${desc}\n` : `「${desc}」 앱을 만들고 싶어. `;
  return `${head}${nm ? `앱 이름은 「${nm}」 로 해 줘(기획 카드 ${LABEL.name} 줄에 그대로). ` : ''}${PLACE[place].say}\n`
    + `아직 만들지 말고, ${BENCH} `
    + '그다음 내가 확인할 기획 카드만 아래 꼴 그대로 답해 줘(앞뒤에 다른 말 없이 · 각 줄 한 문장 · ' + LABEL.can + '은 셋을 · 로 · ' + LABEL.notify + '은 언제 누구에게 알리는지(알릴 일이 없으면 「없음」) · ' + LABEL.ref + '는 서비스마다 「서비스 이름: 가져온 것」을 ; 로 나누고 맨 끝에 「출처: [이름](주소), [이름](주소)」 · 주소는 이 꼴로만):\n'
    + cardText(emptyCard()) + keep;
}
/** ②→③ 첫 판 — appId 는 「만들기 시작」 때 서버가 예약해 둔 앱(#4667). 그 id 로 저장해야 이 만들기의 앱이 된다(다르면 서버가 409). */
export function draftBrief(card: StudioCard, place: StudioPlace, appId = ''): string {
  const id = String(appId || '').trim();
  return `${DRAFT_ASK_HEAD} ${PLACE[place].say}\n${LEGACY}\n${cardText(card)}\n${RULE}\n${NOTIFY}\n${WIRE}\n${ICON}\n`
    + (id ? `이 앱의 id 는 ${id} 로 미리 잡아 뒀어 — lively-app.json 의 id 를 꼭 ${id} 로 해 줘.\n` : '')
    + '진행을 알 수 있게 단계마다 한 줄씩 먼저 보내 줘: [[걸음 1/4]] 기획 읽음 → [[걸음 2/4]] 화면 짬 → [[걸음 3/4]] 자료 표 → [[걸음 4/4]] 저장. '
    + 'app_save 의 note 는 「초안 · 무엇이 되는지 한 줄」. 끝나면 쉬운 말 두 줄만(코드 · 파일 · 도구 이름은 빼고).';
}
/** ④ 짚은 곳 — 선택한 요소(pick) · 핀(pin, 기본) · 영역(box). 좌표는 앱 화면의 비율(0~1), w · h 는 요소 · 영역의 크기. */
/** on: 'wire' — 앱 화면이 아니라 「와이어프레임(화면 흐름) 보기」 보드에서 짚은 곳(좌표는 그 그림 전체의 비율). 없으면 앱 화면. */
export interface StudioPin { x: number; y: number; where: string; note: string; kind?: 'pick' | 'pin' | 'box'; w?: number; h?: number; on?: 'wire';
  /** 「수정하기」로 이미 보내 AI 가 반영하고 있는 코멘트 — 고치는 동안에도 다음 코멘트를 남기게(원준 2026-10-28) 목록엔 두되 세지 않고 고칠 수 없다.
   *  새 버전이 오면 걷는다 · 기록(localStorage)엔 남기지 않는다(새로 열면 보낸 것은 이미 AI 에게 있다). */
  sent?: boolean }
/** 아직 안 보낸 코멘트 — 셈 · 보내기 · 기록이 이 한 술어를 쓴다. */
export const unsent = (p: StudioPin): boolean => !p.sent;
export function fixBrief(round: number, pins: StudioPin[], general: string, place: StudioPlace, appId: string): string {
  const lines: string[] = [];
  const pc = (v?: number): number => Math.round((v || 0) * 100);
  //  번호는 화면의 번호(i + 1) — 보낸(반영 중) 것 · 빈 것은 건너뛰되 번호는 그대로 둔다.
  pins.forEach((p, i) => {
    if (!p.note.trim() || p.sent) return;
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
/** ③ 실제 화면 막대의 「AI에게 말하기」 — 시안을 보며 만드는 AI 와 주고받으며 고친다(원준 2026-10-28 «대화형으로 수정»).
 *  그 화면을 연 뒤 첫 말에만 방식을 붙인다 — 터미널에 그대로 남으니 짧게 · 두 번째 말부터는 사람이 쓴 글 그대로. */
export function talkBrief(text: string, appId: string, place: StudioPlace, first: boolean): string {
  if (!first) return text.trim();
  return `지금부터 시안 화면을 보면서 대화로 고칠게. 뜻이 애매하면 고치기 전에 먼저 짧게 물어봐 줘. 정해지면 app_pull ${appId} 로 받아 고치고 app_save 해 줘(note 는 바뀐 점 한 줄 · 화면 흐름이 바뀌면 ${WIREFRAME_PATH} 도). ${PLACE[place].say} ${NO_PUBLISH} 답은 짧게.\n${text.trim()}`;
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
  return `기획 카드와 지금 버전(app_pull ${appId})을 대조해서 이 한 줄로만 답해 줘:\n[[대조]] 있음: (들어간 「${LABEL.can}」을 · 로) | 빠짐: (안 들어간 것 · 없으면 없음)\n${cardText(card)}`;
}
export function notifyBrief(name: string, line: string, slack: string): string {
  return `이 앱을 팀에 알려 줘. 지식에 제목 「앱 소개 · ${name}」 으로 아래 글을 저장하고(knowledge_save · 분류는 「세션 작업환경」)`
    + (slack.trim() ? `, 슬랙 채널 ${slack.trim()} 에도 같은 글을 보내 줘(못 보내면 지식만)` : '')
    + '. 끝나면 「[[알림]] 알렸어요」 한 줄만(못 했으면 「[[알림]] 못 했어요: 까닭 한 줄」).\n글: ' + line;
}
/** 「팀에 알리기」 의 답 — ok 알렸다 · fail 못 했다(까닭) · null 아직(점검 2-9: 보내기만 하면 «알렸어요» 로 굳던 것). 표식 없는 「알렸어요」 한 줄(옛 글)도 ok. */
export function parseNotify(text: string): { ok: true } | { ok: false; why: string } | null {
  const t = String(text || '');
  const re = /\[\[알림\]\]\s*([^\n]*)/g; let m: RegExpExecArray | null; let line: string | null = null;
  while ((m = re.exec(t))) line = m[1].trim();
  if (line == null) return /^\s*「?알렸어요」?[.!]?\s*$/.test(t) ? { ok: true } : null;
  if (/^못\s*했/.test(line)) return { ok: false, why: line.replace(/^못\s*했어요\s*[:：]?\s*/, '').trim() };
  return { ok: true };
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
