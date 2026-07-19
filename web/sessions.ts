// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b). `#/sessions`(내 세션 목록) · `#/sessions/<sid>[?node=]`(대화록, 공유 링크).
//  설계 목표(사용자 요청): **스키밍 가능** — 사람 질문·AI 답변 모두 적당한 높이에서 접고(더보기), 툴콜은 접힌 칩으로,
//   라벨(나/AI) 없이 배경색으로 구분, 질문 인덱스로 네비게이트. 프로젝트 탭에선 섹션 대신 버튼→모달.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → 반드시 el({text})(textContent)로만 렌더(innerHTML 금지, XSS 방어).
import { api, el, toast } from './core.js';

interface SessRow {
  node_id: string; session_id: string; harness: string | null; title: string | null;
  owner: string | null; owner_name: string | null; first_seen: string; last_seen: string; bytes: number;
}
interface Item { role: string; text: string; tool?: string; ts?: string }
interface Turn { user: Item | null; ai: Item[] }

const CAP_PX = 200;    // 사람 질문·AI 답변 공통 높이 캡(px) — 넘으면 접고 [더보기](스키밍).
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

// #/sessions/<sid>[?node=] 파싱 — 없으면(=목록) null.
function parseSel(): { sid: string; node: string } | null {
  const h = location.hash.replace(/^#\/?/, '');
  const path = h.split('?')[0];
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'sessions' || !segs[1]) return null;
  const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  return { sid: decodeURIComponent(segs[1]), node: params.get('node') || '' };
}

export async function renderSessions(view: any): Promise<void> {
  const sel = parseSel();
  if (sel) return renderTranscriptPage(view, sel.sid, sel.node);
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
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  let page = 0;
  const listBox = el('div');
  const pager = el('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:center;margin-top:12px' });
  const draw = () => {
    listBox.replaceChildren(...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => sessionRowEl(s, onGo)));
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

function sessionRowEl(s: SessRow, onGo?: () => void): any {
  const link = '#/sessions/' + encodeURIComponent(s.session_id) + (s.node_id ? '?node=' + encodeURIComponent(s.node_id) : '');
  const title = s.title || shortId(s.session_id);
  const who = s.owner_name || s.owner || '(알 수 없음)';
  const meta = `${who} · 만든 ${fmtWhen(s.first_seen)} · 마지막 ${fmtWhen(s.last_seen)} · ${fmtBytes(s.bytes)}${s.harness ? ' · ' + s.harness : ''}`;
  // 진입 전 '돌아갈 곳'을 기억(← 뒤로 가 원래 페이지로). 모달에서 왔으면 onGo 로 오버레이도 닫는다.
  const remember = () => { try { sessionStorage.setItem('sessReturn', location.hash || '#/sessions'); } catch { /* */ } if (onGo) onGo(); };
  const open = el('a', { class: 'btn btn-ghost btn-sm', href: link, text: '이어보기 →' });
  const titleLink = el('a', { href: link, style: 'font-weight:600;text-decoration:none;color:inherit', text: title });
  open.addEventListener('click', remember);
  titleLink.addEventListener('click', remember);
  return el('div', { class: 'sess-row', style: 'display:flex;gap:12px;align-items:center;padding:10px 2px;border-bottom:1px solid rgba(127,127,127,.15)' },
    el('div', { style: 'flex:1;min-width:0' },
      el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, titleLink),
      el('div', { class: 'admin-hint', style: 'font-size:12px;margin-top:2px', text: meta })),
    open);
}

// 프로젝트 탭 '세션 기록' — 섹션 대신 버튼→모달(공간 절약). 목록은 페이지네이션·빈세션 제외.
//  행 진입 시 오버레이를 닫고 원래(프로젝트) 페이지를 '돌아갈 곳'으로 기억한다.
export async function openProjectSessionsModal(projectId: number | string, projectName?: string): Promise<void> {
  const body = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  const box = el('div', { class: 'ov-box', style: 'max-width:820px;width:92%' },
    el('div', { class: 'ov-head' },
      el('h3', { text: `세션 기록${projectName ? ' · ' + projectName : ''}` }),
      el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })),
    el('p', { class: 'admin-hint', style: 'margin:0 0 8px', text: '이 프로젝트에서 만든 AI 세션 대화록(끝난 세션 포함).' }),
    body);
  const back = el('div', { class: 'ov-back' }, box);
  back.addEventListener('click', (e: any) => { if (e.target === back) back.remove(); });
  const esc = (ev: any) => { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  document.body.append(back);
  let d: any;
  try { d = await api('/api/ui/v6/projects/' + projectId + '/session-logs'); }
  catch (e: any) { body.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '세션 기록을 불러오지 못했습니다.' })); return; }
  renderSessionListInto(body, (d && d.sessions) || [], '이 프로젝트에 기록된(내용 있는) 세션이 없습니다.', () => back.remove());
}

// ── 대화록 페이지(공유 링크) ──
async function renderTranscriptPage(view: any, sid: string, node: string): Promise<void> {
  const shareUrl = location.origin + location.pathname + '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : '');
  const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔗 링크 복사' });
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareUrl); toast('링크를 복사했습니다 — 열람 권한 있는 사람과 공유하세요.'); }
    catch { window.prompt('이 링크를 복사하세요:', shareUrl); }
  });
  // ← 뒤로: 이 대화록으로 들어온 원래 페이지(목록 or 프로젝트)로. 공유 링크로 바로 열었으면 목록으로.
  let returnTo = '#/sessions';
  try { returnTo = sessionStorage.getItem('sessReturn') || '#/sessions'; } catch { /* */ }
  const back = el('a', { class: 'btn btn-ghost btn-sm', href: returnTo, text: '← 뒤로' });
  const idxSlot = el('div');
  const convo = el('div', { class: 'sess-convo', style: 'margin-top:8px' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  view.replaceChildren(el('div', { class: 'card', style: 'max-width:920px;margin:20px auto' },
    el('div', { class: 'card-head', style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap' },
      el('h2', { id: 'sess-title', style: 'font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis', text: '세션 ' + shortId(sid) }),
      el('div', { style: 'display:flex;gap:6px' }, copyBtn, back)),
    idxSlot, convo));

  const q = new URLSearchParams({ node, view: 'render' }).toString();
  let data: any;
  try { data = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q}`); }
  catch (e: any) { convo.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '대화록을 불러오지 못했습니다(열람 권한이 없을 수 있습니다).' })); return; }
  const items: Item[] = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) { convo.replaceChildren(el('p', { class: 'admin-hint', text: '표시할 대화가 없습니다.' })); return; }

  const turns = groupTurns(items);
  const firstQ = turns.find((t) => t.user)?.user?.text;
  if (firstQ) { const h = document.getElementById('sess-title'); if (h) h.textContent = firstQ.length > 80 ? firstQ.slice(0, 80) + '…' : firstQ; }
  idxSlot.replaceChildren(questionIndex(turns));
  convo.replaceChildren(...turns.map(turnEl));
  requestAnimationFrame(() => finalizeCaps(convo));   // 마운트 후 실제 높이를 재서 넘치는 것만 접는다
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

// 질문 인덱스(skimming/navigate) — 접이식. 각 항목 클릭 시 해당 턴으로 스크롤.
function questionIndex(turns: Turn[]): any {
  const qs = turns.map((t, i) => ({ i, text: t.user?.text || '' })).filter((x) => x.text);
  if (!qs.length) return el('div');
  const list = el('div', { style: 'display:none;margin-top:6px;padding-left:4px;border-left:2px solid rgba(127,127,127,.25)' },
    ...qs.map((qq) => {
      const a = el('a', { href: 'javascript:void 0', class: 'admin-hint',
        style: 'display:block;padding:3px 8px;font-size:12px;text-decoration:none;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        text: `${qq.i + 1}. ${qq.text}` });
      a.addEventListener('click', (e: any) => { e.preventDefault(); document.getElementById('turn-' + qq.i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      return a;
    }));
  const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: `질문 ${qs.length}개 ▾` });
  toggle.addEventListener('click', () => {
    const open = list.style.display === 'none';
    list.style.display = open ? 'block' : 'none';
    toggle.textContent = `질문 ${qs.length}개 ${open ? '▴' : '▾'}`;
  });
  return el('div', { style: 'margin:6px 0' }, toggle, list);
}

function turnEl(t: Turn, idx: number): any {
  const box = el('div', { class: 'sess-turn', id: 'turn-' + idx, style: 'margin:6px 0' });
  if (t.user) box.append(userBubble(t.user.text));
  for (const it of t.ai) if (it.role === 'assistant' && it.text) box.append(aiBubble(it.text));
  const tools = t.ai.filter((i) => i.role === 'tool');
  if (tools.length) box.append(toolsChip(tools));
  return box;
}

// 높이 캡 본문 — 라벨 없이 배경만으로 구분. finalizeCaps 가 마운트 후 scrollHeight 를 재서 넘칠 때만 접기+[더보기].
function capBody(text: string, fontPx: string): any {
  return el('div', { class: 'sess-cap', style: `white-space:pre-wrap;word-break:break-word;overflow:hidden;font-size:${fontPx}` , text });
}
function finalizeCaps(root: any): void {
  root.querySelectorAll('.sess-cap').forEach((body: any) => {
    if (body.dataset.capReady) return;
    body.dataset.capReady = '1';
    if (body.scrollHeight <= CAP_PX + 16) return;   // 안 넘침 → 그대로(버튼 없음)
    body.style.maxHeight = CAP_PX + 'px';
    body.classList.add('capped');                   // 하단 페이드(마스크 — 배경·테마 무관)
    const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'font-size:12px;margin-top:4px', text: '더보기 ▾' });
    let expanded = false;
    btn.addEventListener('click', () => {
      expanded = !expanded;
      body.style.maxHeight = expanded ? 'none' : CAP_PX + 'px';
      body.classList.toggle('capped', !expanded);
      btn.textContent = expanded ? '접기 ▴' : '더보기 ▾';
    });
    if (body.parentElement) body.parentElement.append(btn);
  });
}

// 사람 질문 — 파란 배경으로 구분(라벨 없음). 길면 캡+더보기.
function userBubble(text: string): any {
  return el('div', { style: 'background:rgba(37,99,235,.10);border-left:3px solid #2563eb;border-radius:6px;padding:8px 12px;margin:10px 0' },
    capBody(text, '14px'));
}

// AI 답변 — 라벨·배경 없음(들여쓰기로 구분). 길면 캡+더보기(스키밍).
function aiBubble(text: string): any {
  return el('div', { style: 'padding:2px 12px;margin:4px 0 8px 8px;color:var(--fg,#333)' },
    capBody(text, '13.5px'));
}

// 툴 호출 — 기본 접힘. [펼치기] 하면 이름+요약 목록. 대화 읽기 흐름에서 노이즈 제거(하지만 볼 수는 있게).
function toolsChip(tools: Item[]): any {
  const names = [...new Set(tools.map((t) => t.tool).filter(Boolean))].slice(0, 4).join(', ');
  const detail = el('div', { style: 'display:none;margin:4px 0 4px 8px;padding:6px 10px;border-left:2px solid rgba(161,98,7,.35);background:rgba(161,98,7,.06);border-radius:4px' },
    ...tools.map((t) => el('div', { style: 'font-size:12px;padding:2px 0;font-family:ui-monospace,Menlo,monospace' },
      el('span', { style: 'color:#a16207;font-weight:600', text: (t.tool || 'tool') + ' ' }),
      el('span', { style: 'opacity:.8', text: t.text || '' }))));
  const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin:2px 0 2px 8px;font-size:12px', text: `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ▸` });
  btn.addEventListener('click', () => {
    const open = detail.style.display === 'none';
    detail.style.display = open ? 'block' : 'none';
    btn.textContent = `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ${open ? '▾' : '▸'}`;
  });
  return el('div', {}, btn, detail);
}
