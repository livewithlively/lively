// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b). `#/sessions`(내 세션 목록) · `#/sessions/<sid>[?node=&q=&ln=]`(대화록·공유).
//  설계(사용자 요청): 스키밍 — 질문·답변 모두 10줄 하드 캡(더보기)·질문 사이드바 네비·마크다운 렌더·질문/줄 단위 링크.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → el({text})(textContent) 또는 renderMarkdown(core, textContent 기반)로만 렌더(innerHTML 금지, XSS 방어).
import { api, el, state, toast, renderMarkdown } from './core.js';
// #1850 완전 삭제 — 확인창·실행·토스트는 session-actions 의 단일 정의를 쓴다(#1582 규약: 같은 동작은 한 정의).
import { confirmSessionPurge, purgeSessionRecord, purgedToast } from './session-actions.js';

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
function parseSel(): { sid: string; node: string; q: string; ln: string } | null {
  const h = location.hash.replace(/^#\/?/, '');
  const path = h.split('?')[0];
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'sessions' || !segs[1]) return null;
  const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  return { sid: decodeURIComponent(segs[1]), node: params.get('node') || '', q: params.get('q') || '', ln: params.get('ln') || '' };
}

export async function renderSessions(view: any): Promise<void> {
  const sel = parseSel();
  if (sel) return renderTranscriptPage(view, sel);
  return renderList(view);
}

// ── 목록면(#/sessions) ──
async function renderList(view: any): Promise<void> {
  const listEl = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  view.replaceChildren(el('div', { class: 'card', style: 'max-width:940px;margin:24px auto' },
    el('div', { class: 'card-head' }, el('h2', { text: '세션 이력' })),
    el('p', { class: 'guide-lead', text: '어느 환경/멤버 노드에서 만들었든 중앙에 기록된 내 세션들. 클릭하면 대화를 이어봅니다.' }),
    listEl));
  let data: any;
  try { data = await api('/api/ui/v6/sessions'); }
  catch (e: any) { listEl.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '목록을 불러오지 못했습니다.' })); return; }
  const sessions: SessRow[] = Array.isArray(data?.sessions) ? data.sessions : [];
  renderSessionListInto(listEl, sessions, '중앙에 기록된 세션이 없습니다. (관리 ▸ 세션 공유를 켜고 `lively backfill` 로 기존 기록을 올리세요.)');
}

// 세션 목록을 컨테이너에 렌더 — 페이지네이션 + 빈 세션(0바이트) 방어적 제외. onGo: 행 진입 시 콜백(모달 닫기 등).
export function renderSessionListInto(container: any, sessions: SessRow[], emptyMsg: string, onGo?: () => void): void {
  const rows = (Array.isArray(sessions) ? sessions : []).filter((s) => (s.bytes || 0) > 0);
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
  // 완전 삭제(#1850) — 내 기록일 때만 보인다(서버도 소유자만 허용하지만, 누를 수 없는 버튼을 보이지 않는다).
  const mine = !!s.owner && s.owner === meId();
  const purge = el('button', { class: 'btn-text', style: 'color:var(--danger,#dc2626)', text: '완전 삭제',
    title: '이 세션의 대화 전문을 중앙 기록에서 영구 삭제합니다(되돌릴 수 없음).' }) as HTMLButtonElement;
  purge.addEventListener('click', async () => {
    const okd = await confirmSessionPurge({
      title: '이 세션 기록을 완전히 지울까요?',
      lines: [`${title} · ${fmtBytes(s.bytes)}`],
      remoteNode: s.node_id || null,
    });
    if (!okd) return;
    purge.disabled = true; purge.textContent = '지우는 중…';
    try {
      toast(purgedToast(await purgeSessionRecord(s.session_id, s.node_id)));
      if (onPurged) onPurged();
    } catch (e: any) {
      toast(e?.message || '지우지 못했습니다.');
      purge.disabled = false; purge.textContent = '완전 삭제';
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
function gotoAnchor(sel: { q: string; ln: string }): void {
  let target: HTMLElement | null = null;
  if (sel.ln) target = document.getElementById('ln-' + sel.ln);
  else if (sel.q) target = document.getElementById('turn-' + sel.q);
  if (!target) return;
  const body = target.closest('.sess-body') as HTMLElement | null;   // 접힌 답변 속이면 펼치기
  if (body && body.classList.contains('clamp')) { const more = body.parentElement?.querySelector('.sess-more') as HTMLButtonElement | null; if (more) more.click(); }
  requestAnimationFrame(() => {
    target!.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target!.classList.add('sess-flash');
    setTimeout(() => target!.classList.remove('sess-flash'), 2600);
  });
}

async function renderTranscriptPage(view: any, sel: { sid: string; node: string; q: string; ln: string }): Promise<void> {
  const { sid, node } = sel;
  const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔗 링크 복사' });
  copyBtn.addEventListener('click', () => copyLink(buildShareLink(sid, node)));
  // 이어 질문하기 — 원본 박스에서 이 세션을 claude --resume 로 잇는다(원격/불가면 같은 프로젝트 새 세션 폴백).
  const resumeBtn = el('button', { class: 'btn btn-primary btn-sm', text: '💬 이어 질문하기' }) as HTMLButtonElement;
  resumeBtn.addEventListener('click', async () => {
    const orig = resumeBtn.textContent; resumeBtn.disabled = true; resumeBtn.textContent = '여는 중…';
    try {
      const r: any = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/resume?node=${encodeURIComponent(node)}`, { method: 'POST', body: '{}' });
      if (r?.mode === 'resume') toast('원본 박스에 이어보기 세션을 만들었습니다 — 터미널에서 이어서 대화하세요.');
      else toast(r?.reason || '같은 프로젝트에 새 세션을 만들었습니다.');
      location.hash = r?.projectId ? '#/projects2/p/' + r.projectId : '#/terminal';
    } catch (e: any) { toast(e?.message || '이어받기 세션을 만들지 못했습니다.'); resumeBtn.disabled = false; resumeBtn.textContent = orig || '💬 이어 질문하기'; }
  });
  let returnTo = '#/sessions';
  try { returnTo = sessionStorage.getItem('sessReturn') || '#/sessions'; } catch { /* */ }
  const back = el('a', { class: 'btn btn-ghost btn-sm', href: returnTo, text: '← 뒤로' });
  const sideSlot = el('nav', { class: 'sess-side' });
  const convo = el('div', { class: 'sess-main', style: 'min-width:0' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  view.replaceChildren(el('div', { class: 'card', style: 'max-width:1160px;margin:20px auto' },
    el('div', { class: 'card-head', style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap' },
      el('h2', { id: 'sess-title', style: 'font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis', text: '세션 ' + shortId(sid) }),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, resumeBtn, copyBtn, back)),
    el('div', { class: 'sess-layout', style: 'display:flex;gap:20px;align-items:flex-start;margin-top:8px' }, sideSlot, convo)));

  const qy = new URLSearchParams({ node, view: 'render' }).toString();
  let data: any;
  try { data = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${qy}`); }
  catch (e: any) { convo.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '대화록을 불러오지 못했습니다(열람 권한이 없을 수 있습니다).' })); return; }
  const items: Item[] = Array.isArray(data?.items) ? data.items : [];
  // 완전 삭제(#1850) — 서버가 판정한 isOwner 일 때만 헤더에 단다. 이 화면은 공유 링크로도 열리므로
  //  '내가 로그인해 있다'가 '내 대화다'를 뜻하지 않는다(view_policy=attach 면 팀원의 대화도 여기서 열린다).
  if (data?.isOwner) {
    const purgeBtn = el('button', { class: 'btn btn-ghost btn-sm', style: 'color:var(--danger,#dc2626)', text: '완전 삭제' }) as HTMLButtonElement;
    purgeBtn.addEventListener('click', async () => {
      const okd = await confirmSessionPurge({
        title: '이 세션 기록을 완전히 지울까요?',
        lines: [document.getElementById('sess-title')?.textContent || shortId(sid)],
        remoteNode: node || null,
      });
      if (!okd) return;
      purgeBtn.disabled = true; purgeBtn.textContent = '지우는 중…';
      try {
        toast(purgedToast(await purgeSessionRecord(sid, node)));
        location.hash = '#/sessions';   // 지운 대화록에 머물러 있으면 화면이 사실과 어긋난다 — 목록으로 돌아간다.
      } catch (e: any) {
        toast(e?.message || '지우지 못했습니다.');
        purgeBtn.disabled = false; purgeBtn.textContent = '완전 삭제';
      }
    });
    copyBtn.parentElement?.insertBefore(purgeBtn, back);
  }
  if (!items.length) { convo.replaceChildren(el('p', { class: 'admin-hint', text: '표시할 대화가 없습니다.' })); return; }

  const grouped = groupTurns(items);
  // 답변 없이 취소된(보냈다 esc) 질문 숨김 — 사용자 발화가 있는데 어시스턴트 '답변 텍스트'가 없고 마지막 턴이 아니면
  //  이어지는 다른 질문이 있다는 뜻(=취소하고 다시 보냄). 마지막 턴·선행 AI(user=null)·답변 있는 턴은 유지.
  const turns = grouped.filter((t, i) => i === grouped.length - 1 || !t.user || t.ai.some((x) => x.role === 'assistant' && !!x.text));
  const firstQ = turns.find((t) => t.user)?.user?.text;
  if (firstQ) { const h = document.getElementById('sess-title'); if (h) h.textContent = firstQ.length > 80 ? firstQ.slice(0, 80) + '…' : firstQ; }
  sideSlot.replaceChildren(sidebar(turns, sid, node));
  convo.replaceChildren(...turns.map((t, i) => turnEl(t, i, sid, node)));
  requestAnimationFrame(() => { finalizeCaps(convo); if (sel.q || sel.ln) setTimeout(() => gotoAnchor(sel), 60); });

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
function sidebar(turns: Turn[], sid: string, node: string): any {
  const qs = turns.map((t, i) => ({ i, text: t.user?.text || '' })).filter((x) => x.text);
  const box = el('div', {},
    el('div', { class: 'sess-side-head', text: `질문 ${qs.length}개` }));
  if (!qs.length) { box.append(el('p', { class: 'admin-hint', style: 'font-size:12px', text: '(질문 없음)' })); return box; }
  for (const q of qs) {
    const label = el('button', { class: 'sess-side-item', title: q.text, text: `${q.i + 1}. ${q.text}` });
    label.addEventListener('click', () => document.getElementById('turn-' + q.i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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
