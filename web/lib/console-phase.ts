// lib/console-phase.ts — 곁칸 «콘솔»(#4876)의 순수 규칙. 잎 모듈(import 0) — scripts/console-phase.test.mjs 가 값으로 검증한다.
//
//  원준(2026-10-19): «세션을 열기 전에는 저 사이드바 위젯 애초에 볼 일이 없어 … 다른 세션 가 있다가 다시 돌아올 때 볼만한 게
//   필요한 거야 … 허가를 기다립니다 저런 거 여기 띄울 필요 없음 … 아이콘은 사이드 콘솔 같은 느낌, 세션의 조작을 도와주는 것.»
//  때는 둘이다 — A 시작(세션을 열고 첫 답 전): 세션에 알려 줄 것을 채우는 점검표 · B 돌아왔을 때(첫 답 이후 언제나, 끝난 세션도):
//   «다녀온 사이» 생긴 것 → 처음 시킨 것 → 알려 준 것(접힘) → 남긴 것. 기획: 지식 session-summary-widget-3-proposals-4876 4판.

export type ConsolePhase = 'none' | 'start' | 'back';

/** 때 판정 — 세션이 없으면 none · 내 질문이 없거나(0) 첫 답이 아직이면 start · 그 뒤는 늘 back(끝난 세션도). */
export function consolePhase(i: { sid: string | null | undefined; prompts: number; hasReply: boolean }): ConsolePhase {
  if (!i.sid) return 'none';
  if (i.prompts >= 2) return 'back';
  if (i.prompts === 1 && i.hasReply) return 'back';
  return 'start';
}

/** 발자취 항목 가운데 «답이 있었다» 의 증거 — 사람 말(say)·메타가 아닌 것이 하나라도 있으면 세션이 무언가 했다. */
export function hasReplyIn(items: ReadonlyArray<{ kind: string }>): boolean {
  return items.some((it) => it.kind !== 'say' && it.kind !== 'meta');
}

// ── 알려 줄 것(점검표) ──────────────────────────────────────────────────────────
export type CheckState = 'todo' | 'done' | 'opt';
export interface CheckRow { key: 'project' | 'prior' | 'knowledge' | 'rules' | 'repos' | 'files' | 'task' | 'run'; name: string; value: string; st: CheckState; action: string }
export interface CheckInput {
  projectId: number;                 // 0 = 프로젝트 없는 세션
  projectName?: string | null;
  descriptionChars: number;
  prior: Array<{ id: number; name: string }>;
  required: number;                  // 필요지식 수
  recommended: number;               // 추천 후보 수(아직 안 넣은 것)
  rulesLines: number | null;         // null = 모른다
  repos: string[];
  attachments: number;               // 이 세션에 넣은 파일 수
  task: { id: number; name: string; status?: string | null } | null;
  run: string;                       // 실행 설정 한 줄(모르면 '')
}
const n = (v: number): string => v.toLocaleString('ko-KR');

/** 점검표 줄 — 채울 것(todo)이 위로 올라오고, 나머지는 정한 차례(프로젝트 › 선행 › 지식 › 규칙 › 레포 › 자료 › 태스크 › 실행 설정). */
export function checklistRows(i: CheckInput): CheckRow[] {
  const rows: CheckRow[] = [];
  if (i.projectId > 0) rows.push({ key: 'project', name: '프로젝트', value: `#${i.projectId}${i.descriptionChars ? ` · 본문 ${n(i.descriptionChars)}자` : ' · 본문 없음'}`, st: i.descriptionChars ? 'done' : 'todo', action: i.descriptionChars ? '읽기' : '쓰기' });
  else rows.push({ key: 'project', name: '프로젝트', value: '붙어 있지 않습니다', st: 'todo', action: '연결' });
  if (i.projectId > 0) {
    rows.push(i.prior.length
      ? { key: 'prior', name: '선행 프로젝트', value: i.prior.map((p) => `#${p.id} ${p.name}`).join(' · '), st: 'done', action: '바꾸기' }
      : { key: 'prior', name: '선행 프로젝트', value: '이어받는 프로젝트가 없습니다', st: 'todo', action: '고르기' });
    rows.push(i.required > 0
      ? { key: 'knowledge', name: '지식', value: `${i.required}건 넣음`, st: 'done', action: '더' }
      : { key: 'knowledge', name: '지식', value: i.recommended > 0 ? `추천 ${i.recommended}건 · 아직 안 넣음` : '아직 안 넣음', st: 'todo', action: '고르기' });
    rows.push(i.rulesLines == null
      ? { key: 'rules', name: '규칙', value: '프로젝트 설정에서 봅니다', st: 'opt', action: '쓰기' }
      : i.rulesLines > 0
        ? { key: 'rules', name: '규칙', value: `${i.rulesLines}줄`, st: 'done', action: '고치기' }
        : { key: 'rules', name: '규칙', value: '없음', st: 'todo', action: '쓰기' });
    rows.push(i.repos.length
      ? { key: 'repos', name: '레포', value: i.repos.join(' · '), st: 'done', action: '바꾸기' }
      : { key: 'repos', name: '레포', value: '코드 일이면 연결합니다', st: 'opt', action: '연결' });
  }
  rows.push(i.attachments > 0
    ? { key: 'files', name: '자료', value: `${i.attachments}건 넣음`, st: 'done', action: '＋ 넣기' }
    : { key: 'files', name: '자료', value: '첫 지시에 붙일 파일이 있으면', st: 'opt', action: '＋ 넣기' });
  if (i.projectId > 0) {
    rows.push(i.task
      ? { key: 'task', name: '태스크', value: `#${i.task.id} ${i.task.name}${i.task.status ? ` · ${i.task.status}` : ''}`, st: 'done', action: '' }
      : { key: 'task', name: '태스크', value: '세션이 이름을 지으면 생깁니다', st: 'opt', action: '' });
  }
  rows.push({ key: 'run', name: '실행 설정', value: i.run || '세션 머리줄에서 봅니다', st: 'opt', action: '' });
  //  채울 것이 위로 — 같은 상태끼리는 정한 차례를 지킨다(안정 정렬).
  const rank = (r: CheckRow): number => (r.st === 'todo' ? 0 : 1);
  return rows.map((r, idx) => ({ r, idx })).sort((a, b) => rank(a.r) - rank(b.r) || a.idx - b.idx).map((x) => x.r);
}

// ── 다녀온 사이 ─────────────────────────────────────────────────────────────────
export interface TrailLike { id: string; kind: string; verb: string; label: string; ts?: string; tier?: number }
const tsNum = (s?: string): number => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : 0; };
/** 마지막으로 본 때(leftAt, ms) **뒤에** 생긴 것 — 사람 말·메타는 빼고, 오래된 순. leftAt 이 0(모른다)이면 비어 있다. 경계(같은 시각)는 «본 것». */
export function sinceAway<T extends TrailLike>(items: ReadonlyArray<T>, leftAt: number): T[] {
  if (!(leftAt > 0)) return [];
  return items.filter((it) => it.kind !== 'say' && it.kind !== 'meta' && tsNum(it.ts) > leftAt).sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
}

// ── 종류 칩 ───────────────────────────────────────────────────────────────────
export type ConsoleKind = 'ask' | 'file' | 'knowledge' | 'done' | 'ref';
export const KIND_LABEL: Record<ConsoleKind, string> = { ask: '질문', file: '파일', knowledge: '지식', done: '반영', ref: '참고' };
/** 발자취 항목 → 콘솔의 종류. null = 목록에 세우지 않는다(답 · 메타 — 답은 가운데 대화가 보여 준다). */
export function consoleKind(it: { kind: string; verb: string }): ConsoleKind | null {
  switch (it.kind) {
    case 'say': return 'ask';
    case 'file': case 'out': case 'source': return 'file';
    case 'knowledge': return it.verb === '읽음' || it.verb === '찾아봄' ? 'ref' : 'knowledge';
    case 'cmd': return it.verb === '커밋' ? 'done' : null;
    case 'activity': case 'task': case 'project': return 'done';
    default: return null;
  }
}

/** 목록 거르기 — 종류 칩(all 이면 전부) + 찾기 낱말(띄어쓰기 무시 · 대소문자 무시). 최신이 위. */
export function filterItems<T extends TrailLike>(items: ReadonlyArray<T>, kind: ConsoleKind | 'all', query: string): Array<T & { ck: ConsoleKind }> {
  const q = query.replace(/\s+/g, '').toLowerCase();
  const out: Array<T & { ck: ConsoleKind }> = [];
  for (const it of items) {
    const ck = consoleKind(it);
    if (!ck) continue;
    if (kind !== 'all' && ck !== kind) continue;
    if (q && !it.label.replace(/\s+/g, '').toLowerCase().includes(q)) continue;
    out.push(Object.assign({}, it, { ck }));
  }
  return out.sort((a, b) => tsNum(b.ts) - tsNum(a.ts));
}

/** 종류별 수(칩에 쓴다). */
export function kindCounts(items: ReadonlyArray<TrailLike>): Record<ConsoleKind | 'all', number> {
  const c: Record<ConsoleKind | 'all', number> = { all: 0, ask: 0, file: 0, knowledge: 0, done: 0, ref: 0 };
  for (const it of items) { const k = consoleKind(it); if (!k) continue; c[k]++; c.all++; }
  return c;
}

// ── 마지막으로 본 때 — 이 사람·이 브라우저(localStorage). 서버에 열람 시각이 없다(#4783 실측). ───────────────
const LEFT_PREFIX = 'lv-left:';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function readLeftAt(st: Store | null | undefined, sid: string): number {
  if (!st || !sid) return 0;
  try { const v = Number(st.getItem(LEFT_PREFIX + sid)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
}
export function writeLeftAt(st: Store | null | undefined, sid: string, now: number): void {
  if (!st || !sid || !(now > 0)) return;
  try { st.setItem(LEFT_PREFIX + sid, String(Math.floor(now))); } catch { /* 저장이 막힌 브라우저 — 다녀온 사이 묶음만 안 선다 */ }
}

// ── 지시 문장 — 글칸에 **넣기만** 한다(보내지 않는다). #4339 «다음» 3안의 문장. ────────────────────────────
export interface Phrase { text: string; hint: string }
export function phrasesFor(phase: ConsolePhase, i: { prior: Array<{ id: number; name: string }>; tasks: number; task: { id: number } | null }): Phrase[] {
  if (phase === 'start') {
    const out: Phrase[] = [];
    if (i.prior.length) out.push({ text: `선행 프로젝트 ${i.prior.map((p) => `#${p.id}`).join(' · ')} 이 남긴 것을 읽고 이어서 해 줘`, hint: '선행 있음' });
    if (i.task) out.push({ text: `#${i.task.id} 진행해`, hint: '맡은 태스크' });
    if (i.tasks === 0) out.push({ text: '이 프로젝트에서 할 일을 뽑아 세션 단위 태스크로 나누고 순서를 그려 줘', hint: '태스크 0' });
    out.push({ text: '먼저 프로젝트 본문과 필요지식을 읽고 무엇을 할지 한 줄로 확인해 줘', hint: '시작' });
    return out;
  }
  return [
    { text: '지금까지 한 것을 태스크 본문에 정리하고 완료 처리해 줘', hint: '마무리' },
    { text: '방금 얘기한 건 이 세션에서 안 하고 후속 태스크로 만들어 본문을 채워 줘', hint: '후속으로' },
    { text: '지금까지 정리해 줘', hint: '정리' },
    { text: '테스트 돌려', hint: '검사' },
  ];
}
