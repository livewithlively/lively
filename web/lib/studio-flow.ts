// lib/studio-flow.ts — 앱 만들기 흐름의 **순수** 부분(#4592, 원준 2026-10-11 «기획 → 시안 → 의견 왕복 → 확인 → 넣기, 그리고 팀과»).
//  화면(web/v2/app-studio.ts)은 여기 함수로 AI 답을 읽고(기획 카드 · 걸음 · 점검) 단계마다 보낼 글을 만든다.
//  AI 와의 약속(지식 app-build-quickstart 에도 같은 꼴이 적혀 있다):
//   · 기획 카드  [[기획카드]] … [[/기획카드]]   줄마다 「이름: …」
//   · 걸음      [[걸음 n/4]]                   1 기획 읽음 · 2 화면 짬 · 3 자료 표 · 4 저장
//   · 점검      [[대조]] 있음: a · b | 빠짐: 없음
//  시험: scripts/app-studio-flow.test.mjs

export type StudioPlace = 'side' | 'full' | 'both';
export type StudioStage = 'plan' | 'draft' | 'fix' | 'check' | 'put';

export const STAGES: Array<{ key: 'what' | StudioStage; n: number; label: string }> = [
  { key: 'what', n: 1, label: '앱 이름과 기능 정하기' }, { key: 'plan', n: 2, label: '세부 기획 정하기' }, { key: 'draft', n: 3, label: '생성된 시안' },
  { key: 'fix', n: 4, label: '고치기' }, { key: 'check', n: 5, label: '확인' }, { key: 'put', n: 6, label: '넣기' },
];
export function stageIndex(s: 'what' | StudioStage): number { return STAGES.findIndex((x) => x.key === s); }

// 사람에게 보이는 이름은 둘로 통일한다(원준 2026-10-14) — 세션 오른쪽에 붙는 것 = 「세션 위젯」, 화면 전체로 여는 것 = 「앱 화면」.
export const PLACE: Record<StudioPlace, { title: string; sub: string; say: string; width: string }> = {
  side: { title: '세션 위젯', sub: 'AI 세션 오른쪽에 붙여 같이 써요. 세션에 말로 시키면 AI 가 위젯 내용도 읽고 바꿔요', say: '세션 위젯(세션 오른쪽 사이드바, 폭 340px 안팎)으로 붙여 쓰는 앱이야. 좁은 폭에서 잘 보이게 만들어 줘.', width: '세션 위젯 폭(360px)' },
  full: { title: '앱 화면', sub: '앱 찾기에서 열어 화면 전체로 넓게 써요', say: '앱 찾기에서 열어 화면 전체로 넓게 쓰는 앱이야. 넓은 화면에 맞게 만들어 줘.', width: '앱 화면 폭' },
  both: { title: '둘 다', sub: '세션 위젯으로도, 앱 화면으로도 써요', say: '세션 위젯(세션 오른쪽 좁은 사이드바)으로도 붙이고 화면 전체로도 여는 앱이야. 좁을 때와 넓을 때 둘 다 잘 보이게 만들어 줘.', width: '세션 위젯 폭과 앱 화면 폭 둘 다' },
};

export interface StudioCard { name: string; who: string; items: string; can: string[]; not: string; first: string }
export const CARD_ROWS: Array<{ k: keyof StudioCard; label: string; hint: string }> = [
  { k: 'name', label: '이름', hint: '짧은 한글 이름' },
  { k: 'who', label: '누가 쓰나', hint: '예: 회의를 준비하는 사람과 참석자' },
  { k: 'items', label: '무엇을 적나', hint: '칸 이름들 · 예: 안건 제목 · 날짜 · 끝남 표시' },
  { k: 'can', label: '할 수 있는 것', hint: '셋 · 예: 더하기 · 회의별 보기 · 끝난 것 접기' },
  { k: 'not', label: '안 하는 것', hint: '예: 회의록 쓰기 · 알림 보내기' },
  { k: 'first', label: '첫 화면', hint: '예: 이번 회의 안건 목록(안 끝난 것 먼저)' },
];
const KEY_OF: Array<[RegExp, keyof StudioCard]> = [
  [/^이름$/, 'name'], [/^누가/, 'who'], [/^(무엇을적나|적는것|무엇을|적는칸|칸)$/, 'items'],
  [/^할수있는것|^기능/, 'can'], [/^안하는것|^하지않는것/, 'not'], [/^첫화면|^처음화면/, 'first'],
];
export function splitList(s: string): string[] { return String(s || '').split(/\s*[·•,|]\s*|\s+\/\s+|\n/).map((x) => x.trim()).filter(Boolean); }
export function emptyCard(): StudioCard { return { name: '', who: '', items: '', can: [], not: '', first: '' }; }

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
  return '[[기획카드]]\n' + CARD_ROWS.map((r) => r.label + ': ' + (r.k === 'can' ? c.can.join(' · ') : c[r.k])).join('\n') + '\n[[/기획카드]]';
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
const RULE = '만드는 법은 지식 app-build-quickstart 에 있어(knowledge_get 으로 그것만 읽고 다른 건 찾아보지 마).';
/** ① 사람이 적은 설명(여러 줄일 수 있다)과 이름(비면 AI 가 짓는다)으로 기획 카드를 청한다. */
export function planBrief(what: string, place: StudioPlace, name = ''): string {
  const desc = String(what || '').trim(), nm = String(name || '').trim();
  const head = desc.includes('\n') ? `이런 앱을 만들고 싶어:\n${desc}\n` : `「${desc}」 앱을 만들고 싶어. `;
  return `${head}${nm ? `앱 이름은 「${nm}」 로 해 줘(기획 카드 이름 줄에 그대로). ` : ''}${PLACE[place].say}\n`
    + '아직 만들지 말고, 내가 확인할 기획 카드만 아래 꼴 그대로 답해 줘(앞뒤에 다른 말 없이 · 각 줄 한 문장 · 할 수 있는 것은 셋을 · 로):\n'
    + '[[기획카드]]\n이름: \n누가 쓰나: \n무엇을 적나: \n할 수 있는 것: \n안 하는 것: \n첫 화면: \n[[/기획카드]]';
}
export function draftBrief(card: StudioCard, place: StudioPlace): string {
  return `이 기획 카드대로 첫 판을 만들어 저장해 줘. ${PLACE[place].say}\n${cardText(card)}\n${RULE}\n`
    + '진행을 알 수 있게 단계마다 한 줄씩 먼저 보내 줘: [[걸음 1/4]] 기획 읽음 → [[걸음 2/4]] 화면 짬 → [[걸음 3/4]] 자료 표 → [[걸음 4/4]] 저장. '
    + 'app_save 의 note 는 「첫 판 · 무엇이 되는지 한 줄」. 끝나면 쉬운 말 두 줄만(코드 · 파일 · 도구 이름은 빼고).';
}
/** ④ 짚은 곳 — 고른 요소(pick) · 핀(pin, 기본) · 영역(box). 좌표는 앱 화면의 비율(0~1), w · h 는 요소 · 영역의 크기. */
export interface StudioPin { x: number; y: number; where: string; note: string; kind?: 'pick' | 'pin' | 'box'; w?: number; h?: number }
export function fixBrief(round: number, pins: StudioPin[], general: string, place: StudioPlace, appId: string): string {
  const lines: string[] = [];
  const pc = (v?: number): number => Math.round((v || 0) * 100);
  pins.forEach((p, i) => {
    if (!p.note.trim()) return;
    const at = `왼쪽에서 ${pc(p.x)}% · 위에서 ${pc(p.y)}%`;
    if (p.kind === 'pick') lines.push(`[고른 요소 ${i + 1}] ${p.where || '요소'} — 화면의 ${at} · 폭 ${pc(p.w)}% · 높이 ${pc(p.h)}% → ${p.note.trim()}`);
    else if (p.kind === 'box') lines.push(`[영역 ${i + 1}] 화면의 ${at} 에서 폭 ${pc(p.w)}% · 높이 ${pc(p.h)}% 인 영역${p.where ? ' · 가운데 ' + p.where : ''} → ${p.note.trim()}`);
    else lines.push(`[찍은 곳 ${i + 1}] 화면의 ${at} 자리${p.where ? ' · ' + p.where : ''} → ${p.note.trim()}`);
  });
  if (general.trim()) lines.push(`[앱 전체] ${general.trim()}`);
  return `${round}번째 고침이야. 아래를 반영해 새 판으로 저장해 줘(app_pull ${appId} 로 지금 판을 받아 고치고 app_save · note 는 바뀐 점 한 줄). ${PLACE[place].say} 못 하는 건 이유 한 줄로.\n${lines.join('\n')}`;
}
export function checkBrief(card: StudioCard, appId: string): string {
  return `기획 카드와 지금 판(app_pull ${appId})을 대조해서 이 한 줄로만 답해 줘:\n[[대조]] 있음: (들어간 「할 수 있는 것」을 · 로) | 빠짐: (안 들어간 것 · 없으면 없음)\n${cardText(card)}`;
}
export function notifyBrief(name: string, line: string, slack: string): string {
  return `이 앱을 팀에 알려 줘. 지식에 제목 「앱 소개 · ${name}」 으로 아래 글을 저장하고(knowledge_save · 분류는 「세션 작업환경」)`
    + (slack.trim() ? `, 슬랙 채널 ${slack.trim()} 에도 같은 글을 보내 줘(못 보내면 지식만)` : '')
    + '. 끝나면 「알렸어요」 한 줄만.\n글: ' + line;
}
export function copyBrief(copyIdStr: string, copyTitle: string, originTitle: string, originBy: string, place: StudioPlace): string {
  return `워크스페이스 앱 「${originTitle}」${originBy ? '(' + originBy + ' 님이 만듦)' : ''} 의 내 사본 「${copyTitle}」(id ${copyIdStr}) 이 방금 저장돼 있어. app_pull ${copyIdStr} 로 받아 둬. `
    + `원본은 건드리지 말고, 내가 보내는 고침만 이 사본에 반영해 새 판으로 저장해 줘(app_save · note 는 바뀐 점 한 줄). ${PLACE[place].say} ${RULE} 지금은 「받았어요」 한 줄만.`;
}
export function editBrief(appId: string, title: string, place: StudioPlace): string {
  return `워크스페이스 앱 「${title}」(id ${appId}) 을 고치려고 해. app_pull ${appId} 로 받아 둬. 내가 보내는 고침을 반영해 새 판으로 저장해 줘(app_save · note 는 바뀐 점 한 줄 · 모두가 쓰는 앱이니 있던 것은 그대로). ${PLACE[place].say} ${RULE} 지금은 「받았어요」 한 줄만.`;
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
