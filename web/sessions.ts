// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b)의 **대화록**과 세션 기록 줄. `#/sessions/<sid>[?node=&q=&ln=]`(대화록·공유).
//  설계(사용자 요청): 스키밍 — 질문·답변 모두 10줄 하드 캡(더보기)·질문 사이드바 네비·마크다운 렌더·질문/줄 단위 링크.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → el({text})(textContent) 또는 renderMarkdown(core, textContent 기반)로만 렌더(innerHTML 금지, XSS 방어).
//  #4553(원준 2026-10-04) — 목록면(#/sessions)은 가로탭 셋(대화 찾기 · 작업 일지 · 세션 목록)인 앱이 됐다(sessions-app.ts).
//   이 파일은 그 탭들이 함께 쓰는 대화록(mountTranscript)과, 프로젝트·터미널 화면의 「세션 기록」 모달이 쓰는 줄 목록을 쥔다.
import { api, el, state, toast, renderMarkdown } from './core.js';
import { hitAnchor, markRanges, type HitRef } from './session-history.js';
import { requestOpenRoute } from './v2/ctx-registry.js';
import { EMBEDDED } from './v2/embed.js';
import { sessionLink } from './sessions-kit.js';
// #1850 완전 삭제 — 확인창·실행·토스트는 session-actions 의 단일 정의를 쓴다(#1582 규약: 같은 동작은 한 정의).
import { confirmSessionTrash, eulReul, sessionTrashOp } from './session-actions.js';

interface SessRow {
  node_id: string; session_id: string; harness: string | null; title: string | null;
  owner: string | null; owner_name: string | null; first_seen: string; last_seen: string; bytes: number;
  project_id?: number | null; project_name?: string | null;   // 내 세션 목록에서만 채워짐(#905 C1)
}
interface Item { role: string; text: string; tool?: string; ts?: string }
interface Turn { user: Item | null; ai: Item[] }

const PAGE_SIZE = 15;  // 목록 페이지당 세션 수(페이지네이션).

const fmtBytes = (b: number): string => !b ? '비어있음' : b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? Math.round(b / 1024) + 'KB' : b + 'B';
function fmtWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(iso).toISOString().slice(0, 10);
}
const shortId = (sid: string): string => sid.length > 12 ? sid.slice(0, 8) + '…' : sid;
// 나(서버 idOf 와 같은 규칙: userId 우선, 없으면 email) — 완전 삭제 버튼을 **내 기록에만** 보이기 위해.
//  ⚠ 이 목록면은 내 세션만 오지만, 프로젝트 세션 모달(openProjectSessionsModal)은 **팀원 전원의 세션**을 싣는다.
//   판정 없이 버튼을 달면 남의 대화에 삭제 버튼이 보인다(서버가 403 으로 막지만, 눌러서 거절당할 버튼은 안 보인다).
const meId = (): string => String((state.me && (state.me.userId || state.me.email)) || '');

// #/sessions/<sid>[?node=&q=&ln=] 파싱 — 없으면(=목록) null. q=질문(턴) 앵커, ln=줄/블록 앵커.
export function parseSel(): { sid: string; node: string; q: string; ln: string } | null {
  const h = location.hash.replace(/^#\/?/, '');
  const path = h.split('?')[0];
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'sessions' || !segs[1]) return null;
  const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  return { sid: decodeURIComponent(segs[1]), node: params.get('node') || '', q: params.get('q') || '', ln: params.get('ln') || '' };
}

// 세션 목록을 컨테이너에 렌더 — 페이지네이션 + 빈 세션(0바이트) 방어적 제외. onGo: 행 진입 시 콜백(모달 닫기 등).
export function renderSessionListInto(container: any, sessions: SessRow[], emptyMsg: string, onGo?: () => void): void {
  //  휴지통에 있는 세션은 뺀다(#3778) — 서버가 trashed_at 을 얹어 준다. 되돌리기·완전 삭제는 휴지통 화면의 몫이다.
  const rows = (Array.isArray(sessions) ? sessions : []).filter((s) => (s.bytes || 0) > 0 && !(s as SessRow & { trashed_at?: string | null }).trashed_at);
  if (!rows.length) { container.replaceChildren(el('p', { class: 'admin-hint', text: emptyMsg })); return; }
  let page = 0;
  const listBox = el('div');
  const pager = el('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:center;margin-top:12px' });
  const draw = () => {
    listBox.replaceChildren(...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => sessionRowEl(s, onGo, () => {
      const i = rows.indexOf(s);
      if (i >= 0) rows.splice(i, 1);
      // 마지막 페이지의 마지막 행을 지우면 그 페이지가 사라진다 — 빈 페이지에 남지 않게 한 칸 당긴다.
      const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
      if (page > lastPage) page = lastPage;
      if (!rows.length) { container.replaceChildren(el('p', { class: 'admin-hint', text: emptyMsg })); return; }
      draw();
    })));
    const pages = Math.ceil(rows.length / PAGE_SIZE);   // 삭제로 줄어들 수 있다 — 그릴 때마다 다시 센다
    if (pages <= 1) { pager.replaceChildren(); return; }
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '← 이전' }) as HTMLButtonElement;
    const next = el('button', { class: 'btn btn-ghost btn-sm', text: '다음 →' }) as HTMLButtonElement;
    prev.disabled = page === 0; next.disabled = page >= pages - 1;
    prev.addEventListener('click', () => { if (page > 0) { page--; draw(); } });
    next.addEventListener('click', () => { if (page < pages - 1) { page++; draw(); } });
    pager.replaceChildren(prev, el('span', { class: 'admin-hint', style: 'font-size:12px', text: `${page + 1} / ${pages} · 총 ${rows.length}` }), next);
  };
  draw();
  container.replaceChildren(listBox, pager);
}

function sessionRowEl(s: SessRow, onGo?: () => void, onPurged?: () => void): any {
  const link = '#/sessions/' + encodeURIComponent(s.session_id) + (s.node_id ? '?node=' + encodeURIComponent(s.node_id) : '');
  const title = s.title || shortId(s.session_id);
  const who = s.owner_name || s.owner || '(알 수 없음)';
  const proj = s.project_name ? `📁 ${s.project_name} · ` : '';   // 내 세션 목록: 어느 프로젝트의 세션인지
  const meta = `${proj}${who} · 만든 ${fmtWhen(s.first_seen)} · 마지막 ${fmtWhen(s.last_seen)} · ${fmtBytes(s.bytes)}${s.harness ? ' · ' + s.harness : ''}`;
  const remember = () => { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } if (onGo) onGo(); };
  const open = el('a', { class: 'btn btn-ghost btn-sm', href: link, text: '이어보기 →' });
  // 휴지통으로(#3778) — 내 기록일 때만 보인다. 종전엔 이 자리가 [완전 삭제]였다: 휴지통을 거치지 않고 대화 전문과 그 세션이 만든
  //  지식·자료까지 그 자리에서 영구히 지웠다. 완전 삭제는 휴지통 안에서만 — 거기서 무엇이 함께 지워지는지 고르고 지운다.
  const mine = !!s.owner && s.owner === meId();
  //  위험 색을 쓰지 않는다 — 잃는 것이 없는 동작이다(표식만 붙는다). 빨강은 휴지통 안의 [완전 삭제] 몫이다(#1582).
  const purge = el('button', { class: 'btn-text', text: '휴지통으로',
    title: '이 세션을 휴지통으로 보냅니다 — 휴지통에서 되돌릴 수 있고, 완전히 지우는 건 거기서만 합니다.' }) as HTMLButtonElement;
  purge.addEventListener('click', async () => {
    if (!await confirmSessionTrash({ title: `「${title}」${eulReul(title)} 휴지통으로 보낼까요?` })) return;
    purge.disabled = true;
    try {
      const r = await sessionTrashOp('trash', [s.session_id]);
      if (!r.done.length) { toast(r.skipped[0]?.why || '휴지통으로 보내지 못했습니다.'); purge.disabled = false; return; }
      toast('휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요');
      if (onPurged) onPurged();
    } catch (e: any) {
      toast(e?.message || '휴지통으로 보내지 못했습니다.');
      purge.disabled = false;
    }
  });
  const titleLink = el('a', { href: link, style: 'font-weight:600;text-decoration:none;color:inherit', text: title });
  open.addEventListener('click', remember);
  titleLink.addEventListener('click', remember);
  return el('div', { class: 'sess-row', style: 'display:flex;gap:12px;align-items:center;padding:10px 2px;border-bottom:1px solid rgba(127,127,127,.15)' },
    el('div', { style: 'flex:1;min-width:0' },
      el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, titleLink),
      el('div', { class: 'admin-hint', style: 'font-size:12px;margin-top:2px', text: meta })),
    ...(mine ? [purge] : []), open);
}

// 세션 기록 모달(버튼→모달, 공간 절약) — 페이지네이션·빈세션 제외. 진입 시 오버레이 닫고 현재 페이지를 '돌아갈 곳'으로.
//  프로젝트용(모두의 세션)·터미널탭용(내 세션)이 공유. url 만 다르다.
async function openSessionsModal(title: string, hint: string, url: string, emptyMsg: string): Promise<void> {
  const body = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  const box = el('div', { class: 'ov-box', style: 'max-width:820px;width:92%' },
    el('div', { class: 'ov-head' },
      el('h3', { text: title }),
      el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })),
    el('p', { class: 'admin-hint', style: 'margin:0 0 8px', text: hint }),
    body);
  const back = el('div', { class: 'ov-back' }, box);
  back.addEventListener('click', (e: any) => { if (e.target === back) back.remove(); });
  const esc = (ev: any) => { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  document.body.append(back);
  let d: any;
  try { d = await api(url); }
  catch (e: any) { body.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '세션 기록을 불러오지 못했습니다.' })); return; }
  renderSessionListInto(body, (d && d.sessions) || [], emptyMsg, () => back.remove());
}

// 프로젝트 탭 '세션 기록' — 이 프로젝트의 (모든 멤버) 세션(멤버 인가는 서버).
export async function openProjectSessionsModal(projectId: number | string, projectName?: string): Promise<void> {
  return openSessionsModal(`세션 기록${projectName ? ' · ' + projectName : ''}`,
    '이 프로젝트에서 만든 AI 세션 대화록(끝난 세션 포함).',
    '/api/ui/v6/projects/' + projectId + '/session-logs',
    '이 프로젝트에 기록된(내용 있는) 세션이 없습니다.');
}

// 터미널 탭 '내 세션 기록' — 소유자=나인 세션만(/sessions 는 서버에서 owner=요청자로 스코프됨).
export async function openMySessionsModal(): Promise<void> {
  return openSessionsModal('내 세션 기록',
    '어느 환경/멤버 노드에서 만들었든 중앙에 기록된 내 세션들. 클릭하면 대화를 이어봅니다.',
    '/api/ui/v6/sessions',
    '중앙에 기록된 내 세션이 없습니다. (관리 ▸ 세션 공유를 켜고 `lively backfill` 로 올리세요.)');
}

// ── 대화록 페이지(공유 링크) ──
function buildShareLink(sid: string, node: string, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (node) p.set('node', node);
  for (const k in (extra || {})) p.set(k, String((extra as any)[k]));
  const qs = p.toString();
  return location.origin + location.pathname + '#/sessions/' + encodeURIComponent(sid) + (qs ? '?' + qs : '');
}
async function copyLink(url: string): Promise<void> {
  try { await navigator.clipboard.writeText(url); toast('링크를 복사했습니다 — 열람 권한 있는 사람과 공유하세요.'); }
  catch { window.prompt('이 링크를 복사하세요:', url); }
}
// 앵커(줄/블록·질문)로 스크롤 + 잠깐 하이라이트. 접힌 답변 안이면 먼저 펼친다.
//  ⚠ 찾기는 **이 대화록이 실린 자리(host) 안에서만** 한다 — 세션 이력 앱은 탭마다 대화록을 따로 싣는다(#4553). 문서 전체에서
//   id 로 찾으면 감춰 둔 다른 탭의 같은 번호(turn-0 …)에 걸린다.
const byId = (host: HTMLElement, id: string): HTMLElement | null => {
  try { return host.querySelector('#' + CSS.escape(id)) as HTMLElement | null; } catch { return null; }
};
/** 다음 그리기 뒤에 한다. 그리기가 돌지 않는 자리(뒤에 가려진 탭 · 헤드리스)에서는 requestAnimationFrame 이 영영 안 불린다 —
 *  그러면 접기 확정도, 그 자리로 가기도 안 일어난다. 그래서 짧은 타이머로도 건다(먼저 온 쪽이 한 번만 한다). */
function afterPaint(fn: () => void): void {
  let done = false;
  const run = (): void => { if (done) return; done = true; fn(); };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}
function reveal(target: HTMLElement): void {
  const body = target.closest('.sess-body') as HTMLElement | null;   // 접힌 답변 속이면 펼치기
  if (body && body.classList.contains('clamp')) { const more = body.parentElement?.querySelector('.sess-more') as HTMLButtonElement | null; if (more) more.click(); }
  afterPaint(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('sess-flash');
    setTimeout(() => target.classList.remove('sess-flash'), 2600);
  });
}
function gotoAnchor(host: HTMLElement, sel: { q: string; ln: string }): void {
  let target: HTMLElement | null = null;
  if (sel.ln) target = byId(host, 'ln-' + sel.ln);
  if (!target && sel.q) target = byId(host, 'turn-' + sel.q);
  if (target) reveal(target);
}

// ── 낱말 색칠 + 이 대화 안에서 찾기(#4553 「대화 찾기」) ──
//  색칠은 **글 노드만** 만진다(innerHTML 금지 — 대화록 본문은 신뢰할 수 없다). 코드 블록·표 안의 글도 글 노드라 함께 칠해진다.
function paintWords(root: HTMLElement, words: string[]): HTMLElement[] {
  if (!words.length) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.trim() || (t.parentElement && t.parentElement.closest('.sess-line-copy'))) continue;
    texts.push(t);
  }
  const lines = new Set<HTMLElement>();
  for (const t of texts) {
    const ranges = markRanges(t.data, words);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [s, e] of ranges) {
      if (s > at) frag.append(t.data.slice(at, s));
      frag.append(el('mark', { class: 'sess-hl', text: t.data.slice(s, e) }));
      at = e;
    }
    if (at < t.data.length) frag.append(t.data.slice(at));
    const line = t.parentElement ? (t.parentElement.closest('.sess-line') as HTMLElement | null) : null;
    t.replaceWith(frag);
    if (line) lines.add(line);
  }
  //  문서 순서로 — Set 은 넣은 순서인데 글 노드를 문서 순서로 돌았으므로 이미 그렇다.
  return [...lines];
}

export interface TranscriptOpts {
  /** 세션 이력 앱의 칸 안에 실린 판 — 「← 뒤로」가 없고 칸을 채운다. */
  embedded?: boolean;
  /** 색칠할 낱말(「대화 찾기」의 검색어). 있으면 이 대화 안의 맞은 자리를 오가는 줄이 선다. */
  words?: string[];
  /** 이 말의 자리로 간다(「대화 찾기」에서 고른 맞은 말). */
  hit?: HitRef | null;
  /** 목록이 아는 세션 이름 — 없으면 첫 질문으로 짓는다. */
  name?: string;
  /** 휴지통으로 보낸 뒤 할 일 — 없으면 목록(#/sessions)으로 간다. */
  onTrashed?: () => void;
  /** 대화록 아래에 덧붙일 칸(「이 세션이 남긴 것」). */
  footer?: () => HTMLElement | null;
  /** 「이어 질문하기」를 달지 않는다 — 세션으로 가는 문을 부르는 쪽이 따로 세운 자리(세션 목록 탭: 박스가 있으면 [세션 열기],
   *  기록만 남았으면 [이어 질문하기] 하나). 박스가 도는 대화를 기록으로 하나 더 열면 같은 대화가 둘이 된다. */
  noResume?: boolean;
}

/** 이어 질문하기 — 원본 박스에서 이 세션을 잇는다(원격·불가면 같은 프로젝트 새 세션 폴백). 만든 세션으로 간다. */
export async function resumeSessionRecord(sid: string, node: string, btn?: HTMLButtonElement): Promise<void> {
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '여는 중…'; }
  try {
    const r: any = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/resume?node=${encodeURIComponent(node)}`, { method: 'POST', body: '{}' });
    if (r?.mode === 'resume') toast('이어서 대화할 세션을 열었습니다.');
    else toast(r?.reason || '같은 프로젝트에 새 세션을 만들었습니다.');
    //  셸 안(액자)이면 만든 세션 화면으로 간다 — 액자 안 주소를 바꾸면 세션 이력 앱 자리에 다른 화면이 그려진다(#3870 과 같은 자리).
    const newId = r?.session?.id ? String(r.session.id) : '';
    if (EMBEDDED && newId) requestOpenRoute('#/s/' + encodeURIComponent(newId), true);
    else location.hash = r?.projectId ? '#/projects2/p/' + r.projectId : '#/terminal';
    //  성공한 뒤엔 단추를 곧바로 되살리지 않는다 — 액자 안에서는 이 화면이 그대로 남아, 연달아 누르면 같은 대화의 세션이 둘 생긴다.
    if (btn) { btn.textContent = '열었습니다'; setTimeout(() => { btn.disabled = false; btn.textContent = orig || '이어 질문하기'; }, 5000); }
  } catch (e: any) {
    toast(e?.message || '이어받기 세션을 만들지 못했습니다.');
    if (btn) { btn.disabled = false; btn.textContent = orig || '이어 질문하기'; }
  }
}

/** 대화록 머리의 「이어 질문하기」를 「세션 열기」로 바꾼다 — 그 대화를 돌리는 박스를 알게 됐을 때(세션으로 가는 문은 하나다:
 *  박스가 있는 대화를 기록으로 하나 더 열면 같은 대화가 둘이 된다). host = 대화록을 실은 자리. */
export function setTranscriptDoor(host: HTMLElement, boxId: string): void {
  const btn = host.querySelector('.sess-resume');
  if (!btn || !boxId) return;
  btn.replaceWith(sessionLink(boxId, { class: 'btn btn-primary btn-sm sess-door' }, '세션 열기'));
}

/** 숨어 있던 칸이 보이게 됐다 — 그 사이 실린 대화록의 접기(10줄 캡)를 이제 잰다. */
export function refreshTranscripts(root: HTMLElement): void { finalizeCaps(root); }

export async function renderTranscriptPage(view: any, sel: { sid: string; node: string; q: string; ln: string }): Promise<void> {
  return mountTranscript(view, sel, {});
}

/** 대화록을 host 에 싣는다 — 단독 페이지(#/sessions/<sid>)와 세션 이력 앱의 칸(embedded)이 같은 한 벌을 쓴다. */
export async function mountTranscript(host: HTMLElement, sel: { sid: string; node: string; q: string; ln: string }, opts: TranscriptOpts = {}): Promise<void> {
  const { sid, node } = sel;
  const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔗 링크 복사' });
  copyBtn.addEventListener('click', () => copyLink(buildShareLink(sid, node)));
  const resumeBtn = el('button', { class: 'btn btn-primary btn-sm sess-resume', text: '💬 이어 질문하기' }) as HTMLButtonElement;
  resumeBtn.addEventListener('click', () => { void resumeSessionRecord(sid, node, resumeBtn); });
  let returnTo = '#/sessions';
  try { returnTo = sessionStorage.getItem('sessReturn') || '#/sessions'; } catch { /* */ }
  const back = opts.embedded ? null : el('a', { class: 'btn btn-ghost btn-sm', href: returnTo, text: '← 뒤로' });
  const acts = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, ...(opts.noResume ? [] : [resumeBtn]), copyBtn, ...(back ? [back] : []));
  const titleEl = el('h2', { class: 'sess-title', style: 'font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis', text: opts.name || '세션 ' + shortId(sid) });
  const findSlot = el('div', { class: 'sess-find', hidden: true });
  const sideSlot = el('nav', { class: 'sess-side' });
  const convo = el('div', { class: 'sess-main', style: 'min-width:0' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  host.replaceChildren(el('div', { class: opts.embedded ? 'sess-embed' : 'card', style: opts.embedded ? '' : 'max-width:1160px;margin:20px auto' },
    el('div', { class: 'card-head', style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap' }, titleEl, acts),
    findSlot,
    el('div', { class: 'sess-layout', style: 'display:flex;gap:20px;align-items:flex-start;margin-top:8px' }, sideSlot, convo)));

  const qy = new URLSearchParams({ node, view: 'render' }).toString();
  let data: any;
  try { data = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${qy}`); }
  catch (e: any) { convo.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '대화록을 불러오지 못했습니다(열람 권한이 없을 수 있습니다).' })); return; }
  const items: Item[] = Array.isArray(data?.items) ? data.items : [];
  // 휴지통으로(#3778 — 종전 [완전 삭제]) — 서버가 판정한 isOwner 일 때만 헤더에 단다. 이 화면은 공유 링크로도 열리므로
  //  '내가 로그인해 있다'가 '내 대화다'를 뜻하지 않는다(view_policy=attach 면 팀원의 대화도 여기서 열린다).
  if (data?.isOwner) {
    const trashBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '휴지통으로' }) as HTMLButtonElement;
    trashBtn.addEventListener('click', async () => {
      const name = titleEl.textContent || shortId(sid);
      if (!await confirmSessionTrash({ title: `「${name}」${eulReul(name)} 휴지통으로 보낼까요?` })) return;
      trashBtn.disabled = true;
      try {
        const r = await sessionTrashOp('trash', [sid]);
        if (!r.done.length) { toast(r.skipped[0]?.why || '휴지통으로 보내지 못했습니다.'); trashBtn.disabled = false; return; }
        toast('휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요');
        //  휴지통으로 간 대화록에 머물러 있으면 화면이 사실과 어긋난다 — 목록으로 돌아간다(칸 안이면 그 탭이 줄을 걷는다).
        if (opts.onTrashed) opts.onTrashed(); else location.hash = '#/sessions';
      } catch (e: any) {
        toast(e?.message || '휴지통으로 보내지 못했습니다.');
        trashBtn.disabled = false;
      }
    });
    acts.insertBefore(trashBtn, back);
  }
  if (!items.length) { convo.replaceChildren(el('p', { class: 'admin-hint', text: '표시할 대화가 없습니다.' })); return; }

  const grouped = groupTurns(items);
  // 답변 없이 취소된(보냈다 esc) 질문 숨김 — 사용자 발화가 있는데 어시스턴트 '답변 텍스트'가 없고 마지막 턴이 아니면
  //  이어지는 다른 질문이 있다는 뜻(=취소하고 다시 보냄). 마지막 턴·선행 AI(user=null)·답변 있는 턴은 유지.
  const turns = grouped.filter((t, i) => i === grouped.length - 1 || !t.user || t.ai.some((x) => x.role === 'assistant' && !!x.text));
  const firstQ = turns.find((t) => t.user)?.user?.text;
  if (firstQ && !opts.name) titleEl.textContent = firstQ.length > 80 ? firstQ.slice(0, 80) + '…' : firstQ;
  sideSlot.replaceChildren(sidebar(turns, sid, node, convo));
  convo.replaceChildren(...turns.map((t, i) => turnEl(t, i, sid, node)));
  const foot = opts.footer ? opts.footer() : null;
  if (foot) convo.append(foot);

  //  낱말 색칠 · 이 대화 안에서 찾기 — 고른 맞은 말의 자리(시각으로 찾는다)에서 시작한다.
  const words = (opts.words || []).filter(Boolean);
  const hitLines = paintWords(convo, words);
  const want = hitAnchor(turns, opts.hit ?? null, words);
  if (words.length) {
    let cur = -1;
    const count = el('span', { class: 'sess-find-n' });
    const paint = (): void => { count.textContent = hitLines.length ? `이 대화에서 ${hitLines.length}곳${cur >= 0 ? ` · ${cur + 1}번째` : ''}` : '이 대화의 보이는 글에는 그 낱말이 없습니다'; };
    const go = (i: number): void => {
      if (!hitLines.length) return;
      cur = (i + hitLines.length) % hitLines.length;
      paint();
      reveal(hitLines[cur]!);
    };
    const prev = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '‹ 이전' }) as HTMLButtonElement;
    const next = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다음 ›' }) as HTMLButtonElement;
    prev.addEventListener('click', () => go(cur < 0 ? hitLines.length - 1 : cur - 1));
    next.addEventListener('click', () => go(cur + 1));
    prev.disabled = next.disabled = hitLines.length < 1;
    findSlot.replaceChildren(el('span', { class: 'sess-find-q', text: '「' + words.join(' ') + '」' }), count, prev, next);
    findSlot.hidden = false;
    //  시작 자리 — 고른 말의 블록이 맞은 줄 가운데 있으면 그 번호부터 센다.
    if (want) {
      const target = (want.ln && byId(convo, 'ln-' + want.ln)) || byId(convo, 'turn-' + want.q);
      const idx = target ? hitLines.findIndex((l) => l === target || target.contains(l)) : -1;
      if (idx >= 0) cur = idx;
    }
    paint();
  }
  afterPaint(() => {
    finalizeCaps(convo);
    const to = sel.q || sel.ln ? { q: sel.q, ln: sel.ln } : want;
    if (to) setTimeout(() => gotoAnchor(convo, to), 60);
  });

  // 서브에이전트 트리(#905 C1 슬⑥) — 이 세션이 스폰한 서브에이전트들. 접힌 목록, 클릭 시 각자 대화록으로.
  api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/subagents${node ? '?node=' + encodeURIComponent(node) : ''}`)
    .then((d: any) => { const subs: SessRow[] = Array.isArray(d?.subagents) ? d.subagents : []; if (subs.length) convo.append(subagentsSection(subs)); })
    .catch(() => { /* 서브에이전트 없음/권한없음 — 조용히 */ });
}

// 서브에이전트 트리 섹션 — 기본 접힘 '🌿 서브에이전트 N개', 펼치면 각 서브에이전트(제목·크기) 링크(자기 대화록으로).
function subagentsSection(subs: SessRow[]): any {
  const list = el('div', { style: 'display:none;margin:4px 0 4px 8px;border-left:2px solid rgba(22,163,74,.3);padding-left:10px' },
    ...subs.map((s) => {
      const link = '#/sessions/' + encodeURIComponent(s.session_id) + (s.node_id ? '?node=' + encodeURIComponent(s.node_id) : '');
      const title = s.title || shortId(s.session_id);
      const a = el('a', { href: link, style: 'display:block;padding:4px 0;text-decoration:none;color:inherit;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
        el('span', { text: '🌿 ' + title }),
        el('span', { class: 'admin-hint', style: 'font-size:11px;margin-left:6px', text: fmtBytes(s.bytes) }));
      a.addEventListener('click', () => { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } });
      return a;
    }));
  const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin:8px 0 2px;font-size:12px', text: `🌿 서브에이전트 ${subs.length}개 ▸` });
  btn.addEventListener('click', () => {
    const open = list.style.display === 'none';
    list.style.display = open ? 'block' : 'none';
    btn.textContent = `🌿 서브에이전트 ${subs.length}개 ${open ? '▾' : '▸'}`;
  });
  return el('div', { style: 'margin-top:10px;border-top:1px solid rgba(127,127,127,.15);padding-top:6px' }, btn, list);
}

// 사람 발화마다 새 턴 시작, 뒤따르는 AI/툴은 그 턴에 붙인다(첫 사람 발화 이전 AI 는 user=null 턴).
function groupTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const it of items) {
    if (it.role === 'user') { cur = { user: it, ai: [] }; turns.push(cur); }
    else { if (!cur) { cur = { user: null, ai: [] }; turns.push(cur); } cur.ai.push(it); }
  }
  return turns;
}

// 질문 사이드바(skimming/navigate) — 항상 보이는 세로 목록. 항목 클릭 = 그 질문으로 스크롤, 🔗 = 질문 링크 복사.
function sidebar(turns: Turn[], sid: string, node: string, convo: HTMLElement): any {
  const qs = turns.map((t, i) => ({ i, text: t.user?.text || '' })).filter((x) => x.text);
  const box = el('div', {},
    el('div', { class: 'sess-side-head', text: `질문 ${qs.length}개` }));
  if (!qs.length) { box.append(el('p', { class: 'admin-hint', style: 'font-size:12px', text: '(질문 없음)' })); return box; }
  for (const q of qs) {
    const label = el('button', { class: 'sess-side-item', title: q.text, text: `${q.i + 1}. ${q.text}` });
    label.addEventListener('click', () => byId(convo, 'turn-' + q.i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const cp = el('button', { class: 'sess-side-copy', title: '이 질문 링크 복사', text: '🔗' });
    cp.addEventListener('click', (e: any) => { e.stopPropagation(); copyLink(buildShareLink(sid, node, { q: String(q.i) })); });
    box.append(el('div', { class: 'sess-side-row' }, label, cp));
  }
  return box;
}

function turnEl(t: Turn, idx: number, sid: string, node: string): any {
  const box = el('div', { class: 'sess-turn', id: 'turn-' + idx, style: 'margin:8px 0 14px' });
  if (t.user) box.append(userBubble(t.user.text, idx, sid, node));
  // 이 턴의 AI 답변 '전체'(다음 질문 전까지의 모든 어시스턴트 텍스트)를 하나의 10줄 캡으로 묶는다.
  const aiTexts = t.ai.filter((x) => x.role === 'assistant' && !!x.text);
  if (aiTexts.length) box.append(aiTurnBubble(aiTexts, idx, sid, node));
  const tools = t.ai.filter((i) => i.role === 'tool');
  if (tools.length) box.append(toolsChip(tools));   // 툴콜은 캡 밖(항상 접힌 칩으로 접근 가능)
  return box;
}

// 한 줄/블록을 앵커(id)+호버 링크복사(🔗)로 감싼다 — 질문/답변의 특정 지점으로 링크 전달.
function lineWrap(content: any, anchor: string, sid: string, node: string): any {
  const cp = el('button', { class: 'sess-line-copy', title: '이 지점 링크 복사', text: '🔗' });
  cp.addEventListener('click', () => copyLink(buildShareLink(sid, node, { ln: anchor })));
  return el('div', { class: 'sess-line', id: 'ln-' + anchor }, cp, content);
}

// 사람 질문 — 파란 배경(라벨 없음). 원문 그대로(줄 단위 앵커), 10줄 넘으면 접힘.
function userBubble(text: string, turnIdx: number, sid: string, node: string): any {
  const body = el('div', { class: 'sess-body clamp', style: 'font-size:14px' });
  const lines = text.split('\n');
  lines.forEach((ln, li) => body.append(lineWrap(el('span', { style: 'white-space:pre-wrap', text: ln || ' ' }), `${turnIdx}-q-${li}`, sid, node)));
  return el('div', { class: 'sess-bubble sess-user' }, body);
}

// AI 답변(턴 전체) — 이 턴의 모든 어시스턴트 텍스트를 **하나의** 10줄 캡 컨테이너에 담는다(질문 사이의 답변 통짜 캡).
//  마크다운 렌더(**/목록/코드/표, textContent 기반 안전) + 블록 단위 앵커. 여러 답변 블록은 세로로 이어 붙인다.
function aiTurnBubble(aiTexts: Item[], turnIdx: number, sid: string, node: string): any {
  const body = el('div', { class: 'sess-body clamp', style: 'font-size:13.5px' });
  aiTexts.forEach((it, aiIdx) => {
    const md = renderMarkdown(it.text);                   // <div class=md> — 안전 렌더(core)
    const blocks = Array.from(md.children) as any[];       // 블록 요소만(스냅샷 — append 가 원소를 옮기므로)
    if (!blocks.length) body.append(lineWrap(el('span', { style: 'white-space:pre-wrap', text: it.text }), `${turnIdx}-a${aiIdx}-0`, sid, node));
    else blocks.forEach((b, bi) => body.append(lineWrap(b, `${turnIdx}-a${aiIdx}-${bi}`, sid, node)));
  });
  return el('div', { class: 'sess-bubble sess-ai' }, body);
}

// 마운트 후 실제 높이로 캡 확정 — 안 넘치면 clamp 해제(버튼 없음), 넘치면 [더보기]/[접기]. (CSS 로 처음부터 접혀 플리커 없음)
function finalizeCaps(root: any): void {
  root.querySelectorAll('.sess-body.clamp').forEach((body: any) => {
    if (body.dataset.capReady) return;
    //  감춰진 칸(다른 탭)에서는 높이가 0 으로 재진다 — «안 넘친다» 로 읽어 접기를 영영 풀어 버리면 안 된다(격리 리뷰).
    //   확정하지 않고 둔다. 그 칸이 보이게 될 때 refreshTranscripts 가 다시 잰다.
    if (!body.getClientRects().length) return;
    body.dataset.capReady = '1';
    if (body.scrollHeight <= body.clientHeight + 4) { body.classList.remove('clamp'); return; }   // 안 넘침 → 펼쳐둠
    const btn = el('button', { class: 'btn btn-ghost btn-sm sess-more', style: 'font-size:12px;margin-top:4px', text: '더보기 ▾' });
    let expanded = false;
    btn.addEventListener('click', () => { expanded = !expanded; body.classList.toggle('clamp', !expanded); btn.textContent = expanded ? '접기 ▴' : '더보기 ▾'; });
    if (body.parentElement) body.parentElement.append(btn);
  });
}

// 툴 호출 — 기본 접힘. [펼치기] 하면 이름+요약 목록(노이즈 제거하되 볼 수는 있게).
function toolsChip(tools: Item[]): any {
  const names = [...new Set(tools.map((t) => t.tool).filter(Boolean))].slice(0, 4).join(', ');
  const detail = el('div', { style: 'display:none;margin:4px 0 4px 8px;padding:6px 10px;border-left:2px solid rgba(161,98,7,.35);background:rgba(161,98,7,.06);border-radius:4px' },
    ...tools.map((t) => el('div', { style: 'font-size:12px;padding:2px 0;font-family:ui-monospace,Menlo,monospace' },
      el('span', { style: 'color:var(--warn-ink);font-weight:600', text: (t.tool || 'tool') + ' ' }),
      el('span', { style: 'opacity:.8', text: t.text || '' }))));
  const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin:2px 0 2px 8px;font-size:12px', text: `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ▸` });
  btn.addEventListener('click', () => {
    const open = detail.style.display === 'none';
    detail.style.display = open ? 'block' : 'none';
    btn.textContent = `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ${open ? '▾' : '▸'}`;
  });
  return el('div', {}, btn, detail);
}
