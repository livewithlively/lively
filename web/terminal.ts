// terminal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { api, el, errorNote, pageHead, personFace, state, toast } from './core.js';
import { openMySessionsModal } from './sessions.js';   // #905 C1 — 터미널 탭 '내 세션 기록' 버튼→모달
import { checklist, skeleton } from './learn.js';
import { field, overlay } from './admin.js';
import { startTour, isTourActive } from './tour.js';


// ════════════════════════════════════════════════════════════════════
// 터미널 세션 매니저 (#/terminal) — 중앙 박스 경로 D: xterm.js + 서버 node-pty(tmux).
//  목록/생성폼/CRUD → REST(/api/ui/terminal/*), PTY 스트림 → WS(/terminal/ws, ticket 쿠키).
//  보기(폰트·크기·테마·커서)는 사용자별 localStorage 영속 + 실시간 적용. 보안: el()/textContent 만.
// ════════════════════════════════════════════════════════════════════
const TERM_PREFS_KEY = 'lively_term_prefs';
const TERM_FONTS = [
  { v: 'JetBrains Mono, D2Coding, Menlo, monospace', label: 'JetBrains Mono' },
  { v: 'D2Coding, Menlo, monospace', label: 'D2Coding' },
  { v: 'Menlo, Monaco, monospace', label: 'Menlo' },
  { v: 'SFMono-Regular, "SF Mono", monospace', label: 'SF Mono' },
  { v: 'Consolas, "Courier New", monospace', label: 'Consolas' },
];
const TERM_THEMES = {
  dark:      { name: '다크',      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70' } },
  light:     { name: '라이트',    theme: { background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff' } },
  solarized: { name: 'Solarized', theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642' } },
  dracula:   { name: 'Dracula',   theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a' } },
};
function termPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(TERM_PREFS_KEY) || '{}'); } catch (_) { /* 기본값 */ }
  return Object.assign({ fontFamily: TERM_FONTS[0].v, fontSize: 14, theme: 'dark', cursorStyle: 'bar' }, p);
}
function saveTermPrefs(p) { try { localStorage.setItem(TERM_PREFS_KEY, JSON.stringify(p)); } catch (_) { /* noop */ } }

// 새 세션 폼 '실행 설정' 기억(#673) — 마지막으로 쓴 하네스 + 플래그(모델·effort) + 자동 승인(#782)을 저장해 다음 생성 때 복원.
//  #782 키를 사용자별로 나눈다 — 한 브라우저를 여러 계정이 쓰면 남이 켠 자동 승인이 내 기본값이 되면 안 된다.
//  옛 전역 키는 내 키가 없을 때만 폴백으로 읽어 하네스·모델 기억을 잇는다(자동 승인은 그 시절 저장하지 않았으므로 항상 꺼진 채 시작).
const TERM_CREATE_PREFS_KEY = 'lively_term_create_prefs';
const termCreatePrefsKey = (): string => TERM_CREATE_PREFS_KEY + '::' + ((state.me && (state.me.userId || state.me.email)) || 'anon');
function termCreatePrefs(): any {
  try {
    const raw = localStorage.getItem(termCreatePrefsKey()) || localStorage.getItem(TERM_CREATE_PREFS_KEY) || '{}';
    const p = JSON.parse(raw);
    return (p && typeof p === 'object') ? p : {};
  } catch (_) { return {}; }
}
function saveTermCreatePrefs(p) { try { localStorage.setItem(termCreatePrefsKey(), JSON.stringify(p)); } catch (_) { /* noop */ } }
// 자동 승인(--dangerously-skip-permissions)의 기본값 — 기본은 꺼짐, 내가 마지막으로 켰을 때만 켠 채로 복원(#782).
function termAutoApprovePref(): boolean { return termCreatePrefs().autoApprove === true; }

// 활성 터미널(세션) — 라우트 이탈/재진입 시 정리한다(ws 종료 + xterm dispose + 리스너 제거).
let termSession: any = null;
function teardownTerminal() {
  if (!termSession) return;
  try { if (termSession.ws) termSession.ws.close(); } catch (_) { /* noop */ }
  try { if (termSession.term) termSession.term.dispose(); } catch (_) { /* noop */ }
  if (termSession.onResize) window.removeEventListener('resize', termSession.onResize);
  termSession = null;
}

// 작업자(작성자) = 로그인 사용자. 서버가 토큰으로 owner 를 강제하므로 표시 전용(타인 선택 불가).
function memberName(cfg, id) {
  const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
  return (m && m.name) || id || '';
}
function myName(cfg) {
  const id = (state.me && state.me.userId) || '';
  return memberName(cfg, id) || (state.me && state.me.email) || id || '나';
}
// 세션 생성 시각 — '6월 19일 22:17'(브라우저 로컬 타임존). created 는 epoch 초.
function fmtTermDate(sec) {
  const n = Number(sec) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 세션 라이브 상태(#745) — 게이트웨이 백엔드의 agentState 를 그대로 쓴다. ──
//  busy=작업 중(프로세스그룹 CPU 큼) · waiting=확인 필요(승인·선택 대기) · idle=대기 중(접속중·유휴) · offline(미접속 또는 셸=하네스 종료).
//  title = Claude Code 가 pane 에 써두는 '지금 하는 일' 요약(백엔드 제공) → 카드에 그대로 노출(= '지금 무슨 작업').
//  (초기엔 session_activity 로 파생했으나 스피너가 활동으로 안 잡혀 항상 stale → 백엔드 CPU 기반 agentState 로 대체.)
//  waiting 을 맨 앞으로: 내 승인/선택을 기다리는 = 가장 먼저 처리할 것.
const TSESS_STATUS: Record<string, { label: string; cls: string; rank: number }> = {
  waiting: { label: '확인 필요', cls: 'waiting', rank: 0 },
  busy:    { label: '작업 중',   cls: 'busy',    rank: 1 },
  idle:    { label: '대기 중',   cls: 'idle',    rank: 2 },
  offline: { label: '오프라인',  cls: 'offline', rank: 3 },
};
function sessState(s) { return TSESS_STATUS[s.agentState] ? s.agentState : 'offline'; }
// 상대 시각 — '방금 · 3분 전 · 2시간 전 · 5일 전'.
function relAgo(sec) {
  const n = Number(sec) || 0; if (!n) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - n);
  if (diff < 45) return '방금';
  if (diff < 3600) return Math.floor(diff / 60) + '분 전';
  if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
  return Math.floor(diff / 86400) + '일 전';
}
// 작업 폴더는 끝 2단계만(…/745/context-ontology) — 카드 한 줄에 담기게.
function shortDir(d) {
  const segs = String(d || '').split('/').filter(Boolean);
  return segs.length <= 2 ? (d || '') : '…/' + segs.slice(-2).join('/');
}
// 상태 필터칩 겸 카운트 요약 — 색점 + 라벨 + 개수. (전체 칩은 색점 없음.)
function tsessChip(label, count, cls, active, onClick) {
  const c = el('button', { class: 'tsess-chip-btn' + (active ? ' active' : '') + (cls ? ' ' + cls : ''), type: 'button', onclick: onClick });
  if (cls) c.append(el('span', { class: 'tsess-dot tsess-dot-' + cls }));
  c.append(el('span', { class: 'tsess-chip-label', text: label }), el('span', { class: 'tsess-chip-n', text: String(count) }));
  return c;
}

// #1015 D — 필터 상태 영속(브라우저). 상태(다중 on/off)·소유. 프로젝트 필터는 세션마다 달라 안 남긴다.
const TSESS_STATUSSET_KEY = 'lively_term_statusset_v1';
function tsessStatusSet(): Set<string> { try { const r = localStorage.getItem(TSESS_STATUSSET_KEY); const a = r ? JSON.parse(r) : []; return new Set(Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []); } catch { return new Set(); } }
function saveTsessStatusSet(s: Set<string>) { try { localStorage.setItem(TSESS_STATUSSET_KEY, JSON.stringify([...s])); } catch { /* noop */ } }
const TSESS_OWN_KEY = 'lively_term_own_filter_v1';
function tsessOwnFilter(): string { try { const v = localStorage.getItem(TSESS_OWN_KEY); return ['all', 'mine', 'invited', 'project'].includes(v as string) ? (v as string) : 'all'; } catch { return 'all'; } }
function saveTsessOwnFilter(v: string) { try { localStorage.setItem(TSESS_OWN_KEY, v); } catch { /* noop */ } }
// 프로젝트 공동 세션인가 — 남의 세션이 보이는 사유가 '초대'(개인)냐 '프로젝트 공개'(#452)냐를 가른다.
function tsessIsProject(s): boolean { return !!(Number(s.projectId) || 0); }

// #1015 C — 검색형 프로젝트 필터(드롭다운 버튼 + 타이핑 검색). 값: 0=전체 · -1=개인 세션만 · -2=프로젝트 세션만 · >0=projectId.
function buildSessProjFilter(projName: Map<any, string>, projIds: any[], current: number, onPick: (v: number) => void) {
  const opts = [
    { v: 0, label: '프로젝트 전체' },
    { v: -1, label: '개인 세션만' },
    { v: -2, label: '프로젝트 세션만' },
    ...projIds.map((id) => ({ v: Number(id), label: projName.get(id) || ('프로젝트 #' + id) })),
  ];
  const cur = opts.find((o) => o.v === current) || opts[0];
  const wrap = el('div', { class: 'tsess-projfilter' });
  // 버튼 — 현재 선택 표시(전체면 '프로젝트'). 활성(전체 아님)이면 강조.
  const btn = el('button', { type: 'button', class: 'tsess-projfilter-btn' + (current !== 0 ? ' active' : ''), title: '프로젝트로 필터' },
    el('span', { text: current === 0 ? '프로젝트' : cur.label }), el('span', { class: 'tsess-projfilter-chev', text: '▾' }));
  const dd = el('div', { class: 'tsess-projfilter-dd', hidden: true });
  const search = el('input', { type: 'search', class: 'tsess-projfilter-search', placeholder: '프로젝트 검색…' }) as HTMLInputElement;
  const listBox = el('div', { class: 'tsess-projfilter-list' });
  const renderList = (q: string) => {
    const ql = (q || '').trim().toLowerCase();
    const matches = opts.filter((o) => !ql || o.label.toLowerCase().includes(ql));
    listBox.replaceChildren(...(matches.length ? matches : [{ v: current, label: '(일치 없음)' }]).map((o) =>
      el('button', { class: 'tsess-projfilter-opt' + (o.v === current ? ' active' : ''), type: 'button',
        onmousedown: (e: any) => { e.preventDefault(); close(); if (o.v !== current) onPick(o.v); } }, o.label)));
  };
  let docHandler: any = null;
  const close = () => { dd.hidden = true; if (docHandler) { document.removeEventListener('mousedown', docHandler); docHandler = null; } };
  const open = () => {
    dd.hidden = false; search.value = ''; renderList(''); search.focus();
    docHandler = (e: any) => { if (!wrap.contains(e.target)) close(); };
    document.addEventListener('mousedown', docHandler);
  };
  btn.addEventListener('click', () => (dd.hidden ? open() : close()));
  search.addEventListener('input', () => renderList(search.value));
  dd.append(search, listBox);
  wrap.append(btn, dd);
  return wrap;
}

async function renderTerminal(view) {
  view.replaceChildren(skeleton('세션을 불러오는 중'));
  let data, cfg, projects;
  try {
    [data, cfg, projects] = await Promise.all([
      // includeProjects=1 — 프로젝트 공동 세션(#452 로 로그인한 전원 공개)까지 서버가 함께 준다.
      //  남이 만든 것도 포함: 이 탭은 '박스에서 지금 도는 AI 작업' 전체를 보는 미션컨트롤.
      //  (기본값은 여전히 숨김이라 대시보드 '내 AI 세션' 위젯은 영향 없음.)
      api('/api/ui/terminal/sessions?includeProjects=1'),
      api('/api/ui/terminal/config'),
      // 프로젝트명 매핑 + '어떤 프로젝트 할당' 칩. 남의 프로젝트 세션도 이름을 보여야 하므로 mine=1 이 아닌
      //  전체 목록(공개범위는 서버가 시행). 실패해도 세션 목록은 그대로 보인다(칩은 '프로젝트 #id' 폴백).
      api('/api/ui/v6/projects').then((d) => (d && d.projects) || []).catch(() => []),
    ]);
  } catch (e) { view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
  const sessions = (data && data.sessions) || [];
  const projName = new Map<any, string>((projects || []).map((p) => [p.id, p.name]));
  // '내 프로젝트'(칩 강조용) = 서버 mine=1 과 같은 술어(생성자이거나 팀원)를 전체 목록에서 그대로 판정.
  const meIdNow = (state.me && state.me.userId) || '';
  const myProjIds = new Set<any>((projects || [])
    .filter((p) => p.created_by === meIdNow || (p.members || []).some((m) => m.member_id === meIdNow))
    .map((p) => p.id));
  for (const s of sessions) s._st = sessState(s); // 카드·정렬·카운트가 공유(백엔드 agentState)
  const reRender = () => renderTerminal(view);

  // 관리(선택삭제) 가능 = 내 소유 세션. 서버도 소유자 아니면 403 재검증.
  const ownedSessions = sessions.filter((s) => s.owned);
  const sel: any = { mode: false, ids: new Set() };
  let statusOn = tsessStatusSet();   // #1015 D 상태 필터(다중 on/off). 비어있으면 전체.
  let ownF = tsessOwnFilter();        // 'all' | 'mine'(내 세션) | 'invited'(초대받은)
  let projF = 0;                      // 0=전체 · -1=개인 세션만 · -2=프로젝트 세션만 · >0=projectId

  const headActions = el('div', { class: 'term-head-actions' });
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const controls = el('div', { class: 'tsess-controls' });
  const listWrap = el('div', {});

  function repaintBulk() {
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.ids.size;
    const allOn = sessions.length > 0 && sessions.every((s) => sel.ids.has(s.id));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else sessions.forEach((s) => sel.ids.add(s.id)); draw(); } });
    const openBtn = el('button', { class: 'btn btn-primary btn-sm', text: '선택 열기', disabled: n === 0, title: '고른 세션들을 한 탭 그리드로 동시에 열기',
      onclick: () => bulkOpen() });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
      onclick: () => bulkDelete(delBtn) });
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '세션을 골라 한 탭에 열거나 삭제하세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, openBtn, delBtn));
  }
  sel.onToggle = repaintBulk; // 카드 체크박스 토글 시 bulkBar 카운트만 갱신(전체 재렌더 없이)

  const ctx = { cfg, view, projName, myProjIds, reRender, sel };

  function draw() {
    // 헤더 우측 — [+ 새 세션] + (내 세션 0개면) 따라하기. data-tour 앵커 유지(#517 온보딩).
    const newBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'new-session', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view) });
    const nodeBtn = el('button', { class: 'btn btn-ghost', title: '내 PC·서버를 노드로 연결/관리(#869)', text: '🖥 노드', onclick: () => openNodeManager(view) });
    // 내 세션 기록(#905 C1) — 중앙에 기록된 내 세션 대화록(끝난 세션 포함). 프로젝트 탭과 동일 화면, 단 '내 세션'만.
    const logBtn = el('button', { class: 'btn btn-ghost', title: '중앙에 기록된 내 AI 세션 대화록(끝난 세션 포함)', text: '📜 세션 기록', onclick: () => openMySessionsModal() });
    const tourBtn = ownedSessions.length === 0
      ? el('button', { class: 'btn btn-ghost', text: '🧭 따라하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour() })
      : null;
    headActions.replaceChildren(...[tourBtn, logBtn, nodeBtn, newBtn].filter(Boolean));

    // ── 1행: 상태 필터(다중 on/off — 색점·라벨 유지, 비어있으면 전체) + 우측 액션 ──
    const counts: any = { waiting: 0, busy: 0, idle: 0, offline: 0 };
    for (const s of sessions) counts[s._st]++;
    const stChip = (key, label, cls) => tsessChip(label, counts[key], cls, statusOn.has(key), () => {
      if (statusOn.has(key)) statusOn.delete(key); else statusOn.add(key);
      saveTsessStatusSet(statusOn); draw();
    });
    const allChip = el('button', { class: 'tsess-chip-btn' + (statusOn.size === 0 ? ' active' : ''), type: 'button', title: '모든 상태',
      onclick: () => { statusOn.clear(); saveTsessStatusSet(statusOn); draw(); } },
      el('span', { class: 'tsess-chip-label', text: '전체' }), el('span', { class: 'tsess-chip-n', text: String(sessions.length) }));
    const chips = el('div', { class: 'tsess-chips' }, allChip,
      stChip('waiting', '확인 필요', 'waiting'), stChip('busy', '작업 중', 'busy'),
      stChip('idle', '대기', 'idle'), stChip('offline', '오프라인', 'offline'));

    // 우측 — 질문검색 + 프로젝트 필터(프로젝트 세션이 있을 때만) + 선택. (원래 한 줄 레이아웃 유지)
    const right = el('div', { class: 'tsess-controls-right' });
    right.append(el('button', { class: 'btn btn-ghost btn-sm tsess-gbtn', text: '질문 검색', title: '여러 세션에서 내가 클로드에게 보낸 질문을 통합 검색하고 어느 세션인지 찾기', onclick: () => openGlobalPromptSearch(ctx) }));
    const projIds = [...new Set(sessions.map((s) => Number(s.projectId) || 0).filter(Boolean))];
    if (projIds.length) right.append(buildSessProjFilter(projName, projIds, projF, (v) => { projF = v; draw(); }));
    const selToggle = sel.mode
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); draw(); } })
      : (sessions.length ? el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 세션을 골라 한 탭 그리드로 열거나 한 번에 삭제', onclick: () => { sel.mode = true; draw(); } }) : null);
    if (selToggle) right.append(selToggle);

    // ── 소유 필터(내 세션 / 초대받은 세션 / 남의 프로젝트 세션) — #1015 D.
    //  남의 세션이 하나라도 있을 때만 별도 줄로 노출(전부 내 것이면 무의미하므로 숨김).
    //  개인 세션은 초대로만 남의 것이 보이고(owner+invites), 프로젝트 세션은 초대 무관 전원 공개(#452) —
    //  둘은 성격이 달라 한 칩으로 묶지 않는다.
    const mineCount = sessions.filter((s) => s.owned).length;
    const invitedCount = sessions.filter((s) => !s.owned && !tsessIsProject(s)).length;
    const projCount = sessions.filter((s) => !s.owned && tsessIsProject(s)).length;
    const othersCount = invitedCount + projCount;
    if (ownF === 'invited' && !invitedCount) ownF = 'all';   // 해당 버킷이 비면 필터 해제(줄이 숨겨져 갇히지 않게)
    if (ownF === 'project' && !projCount) ownF = 'all';
    if (ownF === 'mine' && !othersCount) ownF = 'all';
    const rows = [el('div', { class: 'tsess-controls-top' }, chips, right)];
    if (othersCount) {
      const ownChip = (key, label, cnt) => tsessChip(label, cnt, '', ownF === key, () => { ownF = ownF === key ? 'all' : key; saveTsessOwnFilter(ownF); draw(); });
      rows.push(el('div', { class: 'tsess-filter-row' },
        el('span', { class: 'tsess-filter-lbl', text: '소유' }),
        ownChip('mine', '내 세션', mineCount),
        ...(invitedCount ? [ownChip('invited', '초대받은 세션', invitedCount)] : []),
        ...(projCount ? [ownChip('project', '남의 프로젝트 세션', projCount)] : [])));
    }
    controls.replaceChildren(...rows);

    // 필터 적용(상태 다중 · 소유 · 프로젝트) + 정렬(작업중→대기→오프라인, 그 안에서 최근 활동순).
    const shown = sessions
      .filter((s) => statusOn.size === 0 || statusOn.has(s._st))
      .filter((s) => ownF === 'all' || (ownF === 'mine' && s.owned)
        || (ownF === 'invited' && !s.owned && !tsessIsProject(s))
        || (ownF === 'project' && !s.owned && tsessIsProject(s)))
      .filter((s) => {
        if (projF === 0) return true;
        const pid = Number(s.projectId) || 0;
        if (projF === -1) return !pid;   // 개인 세션만
        if (projF === -2) return !!pid;  // 프로젝트 세션만
        return pid === projF;            // 특정 프로젝트
      })
      .sort((a, b) => TSESS_STATUS[a._st].rank - TSESS_STATUS[b._st].rank
        || (Number(b.lastActive || b.created) || 0) - (Number(a.lastActive || a.created) || 0));

    if (!sessions.length) { listWrap.replaceChildren(el('div', { class: 'empty', text: '아직 세션이 없습니다. "+ 새 세션"으로 만드세요.' })); repaintBulk(); return; }
    if (!shown.length) { listWrap.replaceChildren(el('div', { class: 'empty', text: '이 필터에 해당하는 세션이 없습니다.' })); repaintBulk(); return; }
    const list = el('div', { class: 'tsess-list' });
    for (const s of shown) list.append(tsessCard(s, ctx));
    listWrap.replaceChildren(list);
    repaintBulk();
  }

  // 선택 열기 — 고른 세션들을 한 탭 그리드로. 1개면 단독 탭, 여러 개면 배치(그리드) 선택 팝업 후 terminal-grid.html.
  function bulkOpen() {
    const items = [...sel.ids]
      .map((id) => sessions.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({ id: s.id, label: s.label || '', node: (s.node && s.node.id) || '' }));
    if (!items.length) return;
    if (items.length === 1) { window.open(termUrl(items[0].id, items[0].label, items[0].node), '_blank'); return; }
    openGridPicker(items);
  }

  async function bulkDelete(btn) {
    const picked: any[] = [...sel.ids].map((id) => sessions.find((s) => s.id === id)).filter(Boolean);
    // 삭제는 소유자만(서버가 403). 목록에 남의 세션(초대·프로젝트 공동)이 섞이므로 미리 걸러 안내한다
    //  — 안 그러면 '전체 선택 → 삭제'가 대량 403 실패 토스트로 끝난다.
    const items = picked.filter((s) => s.owned);
    const skipped = picked.length - items.length;
    if (!items.length) { toast(picked.length ? '내가 만든 세션만 삭제할 수 있습니다' : '', true); return; }
    if (!confirm(items.length + '개 세션을 삭제할까요?\n\n실행 중인 작업도 함께 종료됩니다(되돌릴 수 없음).'
      + (skipped ? '\n\n남의 세션 ' + skipped + '개는 제외됩니다(소유자만 삭제 가능).' : ''))) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403. 노드 세션은 ?node= 로 위임(#869).
    const results = await Promise.allSettled(
      items.map((s) => api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 세션을 삭제했습니다'), fail > 0);
    sel.mode = false; sel.ids.clear();
    reRender();
  }

  const head = pageHead('AI 세션', 'AI 세션이 지금 무슨 작업을 하는지 · 어떤 프로젝트 할당인지 · 어떤 게 오프라인인지 한눈에.', [headActions], '세션');
  view.replaceChildren(...[loginBannerEl(cfg, view), head, bulkBar, controls, listWrap].filter(Boolean));
  draw();
}

// 단독 터미널 페이지 URL — 노드 세션(#869)은 &node= 로 WS 릴레이 대상을 지정한다.
function termUrl(id, label, nodeId?, extra?) {
  return '/ui/terminal.html?session=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(label || '')
    + (nodeId ? '&node=' + encodeURIComponent(nodeId) : '') + (extra || '');
}

// 세션 카드(#745) — 라이브 상태점 + 라벨(작업) / 상태·시각·하네스·모델·폴더 + 프로젝트 칩 + 열기/관리.
//  선택(일괄삭제) 모드면 내 소유 카드에 체크박스(카드 전체가 토글 = label). 남의 세션은 체크박스 없음(삭제 불가).
function tsessCard(s, ctx) {
  const { cfg, view, projName, myProjIds, reRender, sel } = ctx;
  const st = TSESS_STATUS[s._st] || TSESS_STATUS.offline;
  const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness || '셸';
  const model = (s.flags && s.flags['--model']) || '';
  const owner = memberName(cfg, s.owner) || s.owner || '?';
  const pid = Number(s.projectId) || 0;

  // ── 1행: 상태점 + 이름 + 프로젝트 칩 + 배지 ──
  const title = el('div', { class: 'tsess-title' },
    el('span', { class: 'tsess-dot tsess-dot-' + st.cls, title: st.label }),
    el('span', { class: 'tsess-name', title: s.label, text: s.label || '(이름 없음)' }));
  if (pid) {
    const mine = myProjIds.has(pid);
    title.append(el('span', { class: 'tsess-proj' + (mine ? ' mine' : ''), title: (mine ? '내 프로젝트: ' : '프로젝트: ') + (projName.get(pid) || ('#' + pid)), text: '🗂 ' + (projName.get(pid) || ('프로젝트 #' + pid)) }));
  }
  if (s.attached) title.append(el('span', { class: 'tsess-badge live', text: '접속중' }));
  if (s.autoApprove) title.append(el('span', { class: 'tsess-badge danger', text: '자동승인' }));
  // 분산 노드(#869) — 원격 노드에서 도는 세션 표시. 노드가 끊겨 있으면(꺼짐·절전) 위험 배지로 구분.
  if (s.node) title.append(el('span', { class: 'tsess-badge' + (s.node.online ? '' : ' danger'), title: '실행 노드: ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' — 연결 끊김(꺼짐/절전)'), text: '🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' · 끊김') }));
  // 남의 세션이면 소유자 배지 — 보이는 사유를 정확히: 개인 세션은 '초대받음', 프로젝트 세션은 '공동'(초대 무관 전원 공개 #452).
  if (!s.owned) title.append(el('span', { class: 'tsess-badge', title: '소유: ' + owner, text: '👤 ' + owner + (pid ? ' · 공동' : ' · 초대받음') }));
  else if ((s.invites || []).length) title.append(el('span', { class: 'tsess-badge', title: s.invites.map((id) => memberName(cfg, id)).join(', '), text: '초대 ' + s.invites.length + '명' }));

  // ── 2행(있으면): '지금 하는 일' 실시간 요약(백엔드 title = Claude Code pane 요약) — 라벨과 다를 때만 ──
  const workTitle = (s.title && s.title !== s.label) ? el('div', { class: 'tsess-worktitle', title: s.title, text: '💬 ' + s.title }) : null;

  // ── 3행: 상태 · 시각 · 하네스·모델 · 폴더 ──
  const bits: any[] = [];
  bits.push(el('span', { class: 'tsess-stat tsess-stat-' + st.cls, text: st.label }));
  const when = relAgo(s.lastActive || s.created);
  if (when) bits.push(el('span', { text: (s.lastActive ? '작업 ' : '') + when }));
  bits.push(el('span', { text: harnessLabel + (model ? '·' + model : '') }));
  if (s.dir) bits.push(el('span', { class: 'tsess-dir', title: s.dir, text: '📁 ' + shortDir(s.dir) }));
  const meta = el('div', { class: 'tsess-meta' });
  bits.forEach((b, i) => { if (i) meta.append(el('span', { class: 'tsess-sep', text: '·' })); meta.append(b); });

  const info = el('div', { class: 'tsess-info' }, ...[title, workTitle, meta].filter(Boolean));

  // 선택 모드 — 모든 카드에 체크박스(카드 전체 토글). 골라서 한 탭 그리드로 '열기' 또는 '삭제'(삭제는 서버가 소유자만 허용).
  if (sel && sel.mode) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = sel.ids.has(s.id);
    cb.addEventListener('change', () => { if (cb.checked) sel.ids.add(s.id); else sel.ids.delete(s.id); if (sel.onToggle) sel.onToggle(); });
    return el('label', { class: 'tsess-card tsess-' + st.cls + ' tsess-card--sel' }, el('span', { class: 'tsess-check' }, cb), info);
  }

  // 액션 — 열기(항상) + 내 질문(노드 세션도 트랜스크립트 릴레이 #875 ③) + 소유자면 수정·삭제.
  const acts = el('div', { class: 'tsess-acts' },
    el('button', { class: 'tsess-open', text: '열기', onclick: () => window.open(termUrl(s.id, s.label, s.node && s.node.id), '_blank') }));
  acts.append(el('button', { class: 'tsess-icon tsess-q', title: '이 세션에서 클로드에게 보낸 내 질문만 순서대로 모아보기', text: '내 질문', onclick: () => openSessPrompts(s) }));
  if (s.owned) {
    acts.append(el('button', { class: 'tsess-icon', title: '이름·초대 수정', text: '수정', onclick: () => openTermEdit(s, cfg, view) }));
    acts.append(el('button', { class: 'tsess-icon danger', title: '세션 종료(삭제)', text: '삭제', onclick: async () => {
      if (!confirm('세션 "' + s.label + '" 을(를) 종료할까요? 실행 중인 작업도 함께 종료됩니다.')) return;
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' }); toast('세션 종료됨'); reRender(); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  return el('div', { class: 'tsess-card tsess-' + st.cls + (s.attached ? ' attached' : '') }, info, acts);
}

// 카드 '내 질문' 팝아웃(#745) — 이 세션에서 클로드에게 보낸 사용자 질문(프롬프트)만 시간순으로 모아 본다(위=최근).
//  백엔드가 ~/.claude 트랜스크립트에서 사람이 친 질문만 추출(툴결과·주입 메시지 제외). 접근통제는 서버 canAttach.
// 여러 세션을 한 탭 그리드로(#745) — n개에 맞는 배치 후보(격자·가로·세로·2열·3열). cols*rows>=n 인 것만.
function gridLayouts(n) {
  const out: any[] = []; const seen = new Set();
  const add = (cols, rows, label) => { const k = cols + 'x' + rows; if (cols >= 1 && rows >= 1 && cols * rows >= n && !seen.has(k)) { seen.add(k); out.push({ cols, rows, label }); } };
  const sq = Math.ceil(Math.sqrt(n));
  add(sq, Math.ceil(n / sq), '격자');          // 정사각형에 가깝게
  add(n, 1, '가로 한 줄');
  add(1, n, '세로 한 줄');
  add(2, Math.ceil(n / 2), '2열');
  if (n >= 6) add(3, Math.ceil(n / 3), '3열');
  return out.slice(0, 5);
}
// 배치(그리드) 선택 팝업 — 고른 뒤 terminal-grid.html 을 새 탭으로. items = [{id,label,node}].
//  대시보드 '내 AI 세션' 일괄 바도 이 함수를 재사용한다(#870 — 두 벌 만들지 않는다). 내부 의존(overlay·gridLayouts·el)은 이 모듈 스코프에서 해소된다.
export function openGridPicker(items) {
  const n = items.length;
  const container = el('div', { class: 'tgrid-opts' });
  const back = overlay(n + '개 세션을 한 탭에서 열기 — 배치를 고르세요', container);
  const openGrid = (cols, rows) => {
    const ids = items.map((x) => x.id).join(',');
    const labels = encodeURIComponent(JSON.stringify(items.map((x) => x.label || '')));
    const nodes = items.map((x) => x.node || '').join(','); // 세션별 실행 노드(#869) — 그리드 셀 iframe 이 &node= 로 전달
    window.open('/ui/terminal-grid.html?sessions=' + encodeURIComponent(ids) + '&labels=' + labels + '&nodes=' + encodeURIComponent(nodes) + '&cols=' + cols + '&rows=' + rows, '_blank');
    back.remove();
  };
  for (const L of gridLayouts(n)) {
    const preview = el('div', { class: 'tgrid-prev', style: 'grid-template-columns:repeat(' + L.cols + ',1fr);grid-template-rows:repeat(' + L.rows + ',1fr)' });
    for (let i = 0; i < L.cols * L.rows; i++) preview.append(el('span', { class: 'tgrid-prev-cell' + (i < n ? ' on' : '') }));
    container.append(el('button', { class: 'tgrid-opt', type: 'button', onclick: () => openGrid(L.cols, L.rows) },
      preview, el('div', { class: 'tgrid-opt-lbl', text: L.label }), el('div', { class: 'tgrid-opt-dim', text: L.cols + '×' + L.rows })));
  }
}
function qWhen(ts) {
  const ms = Date.parse(ts || ''); if (!ms) return '';
  return relAgo(Math.floor(ms / 1000));
}
// 검색어 → 토큰(공백분리·중복제거·소문자).
function qTerms(q) { return [...new Set(String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean))]; }
// 관련도 점수(백엔드 scoreText 와 동형) — 팝아웃 내 검색(클라이언트)도 같은 랭킹. matched=매치 단어 수(AND 판정).
const QBOUNDARY_RE = /[\s.,!?()[\]{}"'“”‘’·\-—:;/\\]/;
function qScore(textLower, terms, phrase) {
  let score = 0, matched = 0; const positions: number[] = [];
  for (const t of terms) {
    const idx = textLower.indexOf(t);
    if (idx === -1) continue;
    matched++; positions.push(idx); score += 10;
    if (idx === 0 || QBOUNDARY_RE.test(textLower[idx - 1])) score += 5;
    let c = 0, i = idx; while (i !== -1 && c < 5) { c++; i = textLower.indexOf(t, i + t.length); }
    score += Math.min(c - 1, 3);
  }
  if (matched === 0) return { score: 0, matched: 0 };
  if (terms.length > 1) {
    if (matched === terms.length && positions.length) { const span = Math.max(...positions) - Math.min(...positions); if (span < 30) score += 20; else if (span < 100) score += 8; }
    if (textLower.includes(phrase)) score += 50;
  }
  return { score, matched };
}
// 질문 텍스트에서 각 검색 토큰의 모든 등장을 <mark> 로 강조(el/textContent — XSS 안전). terms 없으면 그냥 텍스트.
function qHighlight(text, terms) {
  const wrap = el('div', { class: 'tsess-qtext' });
  if (!terms || !terms.length) { wrap.textContent = text; return wrap; }
  const lower = String(text).toLowerCase();
  const ranges: any[] = [];
  for (const t of terms) { let i = 0, idx; while ((idx = lower.indexOf(t, i)) !== -1) { ranges.push([idx, idx + t.length]); i = idx + t.length; } }
  if (!ranges.length) { wrap.textContent = text; return wrap; }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0].slice()];
  for (let k = 1; k < ranges.length; k++) { const last = merged[merged.length - 1]; if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]); else merged.push(ranges[k].slice()); }
  let pos = 0;
  for (const [a, b] of merged) { if (a > pos) wrap.append(document.createTextNode(text.slice(pos, a))); wrap.append(el('mark', { class: 'tsess-qmark', text: text.slice(a, b) })); pos = b; }
  if (pos < text.length) wrap.append(document.createTextNode(text.slice(pos)));
  return wrap;
}
// 한 세션 '내 질문' 팝아웃 — 상단 검색으로 그 세션 질문을 즉시 필터(클라이언트). 최신이 위, #N=시간순 번호.
//  대시보드 '내 AI 세션' 카드의 ⋮ 메뉴도 이걸 그대로 재사용한다(#853) — 질문 보기 UI 를 두 벌 만들지 않는다.
export async function openSessPrompts(s) {
  const body = el('div', { class: 'tsess-qbody' }, el('div', { class: 'caption', text: '질문을 불러오는 중…' }));
  overlay('💬 내 질문 · ' + (s.label || '(이름 없음)'), body);
  try {
    const d = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompts' + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''));
    const prompts = (d && d.prompts) || [];
    const total = (d && d.total) || prompts.length;
    if (!prompts.length) {
      body.replaceChildren(el('div', { class: 'empty', text: (d && d.found) ? '이 세션에서 보낸 질문이 아직 없어요.' : '이 세션의 대화 기록을 찾지 못했어요.' }));
      return;
    }
    const search = el('input', { class: 'tsess-qsearch', type: 'search', placeholder: '이 세션의 질문 검색…' });
    const cap = el('div', { class: 'caption tsess-qcap' });
    const list = el('div', { class: 'tsess-qlist' });
    const draw = () => {
      const query = search.value.trim();
      const terms = qTerms(query);
      list.replaceChildren();
      if (!terms.length) { // 검색 없음 → 최신순 전체
        cap.textContent = total + '개 질문 · 최근 순' + (total > prompts.length ? ' (최근 ' + prompts.length + '개)' : '');
        prompts.slice().reverse().forEach((p) => {
          list.append(el('div', { class: 'tsess-qitem' },
            el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + (prompts.indexOf(p) + 1) }), el('span', { class: 'tsess-qwhen', text: qWhen(p.ts) })),
            qHighlight(p.text, null)));
        });
        return;
      }
      const phrase = query.toLowerCase();
      const scored: any[] = [];
      for (let i = 0; i < prompts.length; i++) { const r = qScore(prompts[i].text.toLowerCase(), terms, phrase); if (r.matched >= 1) scored.push({ p: prompts[i], chrono: i + 1, score: r.score, matched: r.matched }); }
      const strict = scored.filter((x) => x.matched === terms.length);
      const isPartial = strict.length === 0 && terms.length > 1;
      const pool = isPartial ? scored : strict;
      pool.sort((a, b) => b.score - a.score || (b.chrono - a.chrono));  // 관련도 → 최신
      cap.textContent = pool.length ? (pool.length + ' / ' + total + '개 일치 · 관련도순' + (isPartial ? ' (일부 단어)' : '')) : '';
      if (!pool.length) { list.append(el('div', { class: 'empty', text: '일치하는 질문이 없어요.' })); return; }
      pool.forEach(({ p, chrono }) => {
        list.append(el('div', { class: 'tsess-qitem' },
          el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + chrono }), el('span', { class: 'tsess-qwhen', text: qWhen(p.ts) })),
          qHighlight(p.text, terms)));
      });
    };
    search.addEventListener('input', draw);
    body.replaceChildren(search, cap, list);
    draw();
  } catch (e) {
    body.replaceChildren(el('div', { class: 'empty', text: '질문을 불러오지 못했어요 — ' + (e && e.message || e) }));
  }
}
// 전체 세션 통합 '질문 검색' 팝아웃(#745) — 여러 터미널에서 보낸 질문을 한 번에 검색하고, 각 결과가 '어느 세션'인지 보여준다.
//  결과 클릭 = 그 세션 터미널 열기. 서버가 접근 가능한 세션만 검색(개인 소유/초대 + 내 프로젝트 세션).
function openGlobalPromptSearch(ctx) {
  const { projName, myProjIds } = ctx;
  const input = el('input', { class: 'tsess-gsearch', type: 'search', placeholder: '모든 세션에서 내 질문 검색 — 뜻이 비슷한 것도 찾아요' });
  const status = el('div', { class: 'caption tsess-qcap', text: '내가 여러 세션에서 클로드에게 보낸 질문을 한 번에 검색해요 (의미 기반).' });
  const results = el('div', { class: 'tsess-qlist tsess-gresults' });
  overlay('질문 검색 · 모든 세션', el('div', { class: 'tsess-qbody tsess-gbody' }, input, status, results));
  let timer: any = null, lastQ: any = null;
  const run = async () => {
    const q = input.value.trim();
    if (q === lastQ) return; lastQ = q;
    if (q.length < 2) { status.textContent = '두 글자 이상 입력하세요.'; results.replaceChildren(); return; }
    status.textContent = '검색 중…'; results.replaceChildren();
    try {
      const d = await api('/api/ui/terminal/prompts/search?q=' + encodeURIComponent(q));
      if (input.value.trim() !== q) return; // 늦게 온 응답 무시
      const rows = (d && d.results) || [];
      const mode = d.semantic ? '의미 검색' : '관련도순';
      status.textContent = rows.length ? (rows.length + '개 · ' + mode + (d.partial ? ' (일부 단어만 일치)' : '') + (d.truncated ? ' · 많아서 일부만' : '')) : '일치하는 질문이 없어요.';
      results.replaceChildren();
      const ql = qTerms(q);
      rows.forEach((r) => {
        const pid = Number(r.projectId) || 0;
        const meta = el('div', { class: 'tsess-qmeta' },
          el('span', { class: 'tsess-gsess', title: r.label, text: r.label || r.sessionId }),
          pid ? el('span', { class: 'tsess-proj' + (myProjIds.has(pid) ? ' mine' : ''), title: (projName.get(pid) || ('#' + pid)), text: '🗂 ' + (projName.get(pid) || ('프로젝트 #' + pid)) }) : null,
          el('span', { text: qWhen(r.ts) }),
          el('span', { class: 'tsess-gopen', text: '열기 ↗' }));
        const item = el('div', { class: 'tsess-qitem tsess-gitem', role: 'button', tabindex: '0', title: '이 세션 열기' }, meta, qHighlight(r.text, ql));
        item.onclick = () => window.open('/ui/terminal.html?session=' + encodeURIComponent(r.sessionId) + '&label=' + encodeURIComponent(r.label || ''), '_blank');
        results.append(item);
      });
    } catch (e) {
      if (input.value.trim() !== q) return;
      status.textContent = '검색 실패 — ' + (e && e.message || e);
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  setTimeout(() => input.focus(), 30);
}

// 구성원 격리(#524) — 이 세션의 claude 가 '내 격리 계정(box_)'으로 뜨는지 안내. box_ 격리가 #346 멀티프로필을 대체.
//  게이트웨이는 box_ 700 홈을 못 읽어 '로그인됨' 여부를 알 수 없으므로(격리의 본질), 로그인 안내를 상시 노출.
function profileNoteEl(cfg) {
  const os = (cfg && cfg.os) || {};
  if (os.ready) {
    const who = os.osUser || 'box_…';
    if (os.provisioned && os.loggedIn) return el('div', { class: 'caption', text: '🔐 내 AI 세션은 내 격리 계정(' + who + ')으로 실행됩니다 — 자격증명이 구성원 간 격리됩니다.' });
    if (os.provisioned) return el('div', { class: 'caption', text: '🔐 내 격리 계정(' + who + ') · Claude 로그인 전입니다 — 세션에서  claude  실행 후 /login (한 번만).' });
    return el('div', { class: 'caption', text: '🔐 첫 세션을 열면 내 격리 계정(' + who + ')이 자동 생성돼 격리 실행됩니다. 세션에서  claude  실행 후 /login 하세요.' });
  }
  // 격리 인프라 미설치 = 비격리(공유) — 레거시 #346 멀티프로필 안내(폴백).
  const p = (cfg && cfg.profile) || {};
  if (!p.multiprofile) return null;
  if (p.active) return el('div', { class: 'caption', text: '🔐 이 AI 세션은 내 Claude 계정(프로필 로그인됨)으로 실행됩니다.' });
  // '내 프로필'이라 부르면 우상단 [내 프로필](표시이름·아바타 편집)과 겹쳐 엉뚱한 데를 누르게 된다 —
  //  여기서 말하는 건 AI 가 돌아가는 격리 계정(관리탭 [구성원 ▸ AI 실행 계정])이다. 그 이름으로 부른다(#837).
  if (p.provisioned) return el('div', { class: 'caption', text: '⚠ 내 AI 실행 계정이 아직 로그인 안 돼 공유 계정으로 실행됩니다 — 상단 [내 계정 로그인] 버튼으로 한 번 로그인하세요.' });
  return el('div', { class: 'caption', text: '⚠ 공유 계정으로 실행됩니다(구성원 격리 미설치). 박스에서 deploy/linux/install-isolation.sh 실행 시 구성원별 격리가 켜집니다.' });
}

// 최초 로그인 세션 — loginProfile 로 게이트를 우회해 내 프로필 dir 로 claude 를 띄운다(닭-달걀 해소). 새 탭으로 열어 로그인.
async function openLoginSession(view) {
  try {
    const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
      label: '내 계정 로그인', rootKey: 'personal', subpath: '', harness: 'claude', flags: {}, autoApprove: false, loginProfile: true,
    }) });
    toast('로그인 터미널을 열었습니다 — 뜨는 claude 에서 로그인을 진행하세요');
    if (out && out.session) window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
    renderTerminal(view);
  } catch (e) { toast('로그인 터미널 열기 실패 — ' + e.message, true); }
}

// 상단 '내 계정 로그인' 버튼 — 개인 claude 세션을 열어 거기서 로그인. box_ 격리면 그 세션이 내 격리 계정(box_)으로
//  떠서 로그인이 box_ 홈에 저장돼 이후 내 세션에 재사용된다. 게이트웨이가 box_ 로그인 여부를 못 봐서(격리) 상시 노출.
function loginBannerEl(cfg, view) {
  const os = (cfg && cfg.os) || {};
  if (os.ready) {
    if (os.loggedIn) return null;  // 이미 로그인됨(box_ creds 존재) → 버튼 숨김
    return el('div', { class: 'card' },
      el('button', { class: 'btn btn-primary btn-sm', text: '🔑 내 계정 로그인', onclick: () => openLoginSession(view) }),
      el('span', { class: 'caption', text: '  처음 한 번 — 개인 세션을 열어 claude 에서 /login (이후 내가 만드는 세션은 내 격리 계정으로 뜹니다).' }));
  }
  // 레거시 비격리(#346): 프로필 프로비저닝됐지만 미로그인일 때만.
  const p = (cfg && cfg.profile) || {};
  if (!p.multiprofile || !p.provisioned || p.loggedIn) return null;
  return el('div', { class: 'card' },
    el('div', { class: 'caption', text: '⚠ 내 Claude 계정이 아직 로그인되지 않았습니다. 한 번 로그인하면 이후 내가 만드는 세션은 내 계정으로 뜹니다.' }),
    el('button', { class: 'btn btn-primary', text: '내 계정 로그인', onclick: () => openLoginSession(view) }));
}

// 새 세션 — 기본 비공개. 초대 피커에서 멤버를 고르면 그 사람도 보고 열 수 있다.
// onCreated(out) — 있으면 생성 후 그걸 호출(대시보드에서 재사용: 세션 위젯 새로고침). 없으면 터미널 뷰 재렌더.
function openTermCreateForm(cfg, view, onCreated?) {
  const roots = cfg.roots || [];
  const harnesses = cfg.harnesses || [];
  const prefs = termCreatePrefs();
  const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
  // #853 작업 위치 = 공유/개인 2택 → 드롭다운 대신 세그먼트 토글(둘 중 하나를 명확히 고르게). 아래 '폴더'는 이 안의 하위 폴더.
  let rootKey = (roots[0] && roots[0].key) || 'personal';
  const rootBtns: Record<string, any> = {};
  const rootDesc: Record<string, string> = { shared: '팀과 함께 쓰는 폴더', personal: '나만 쓰는 폴더' };
  const rootIco: Record<string, string> = { shared: '👥', personal: '🔒' };
  // #853 작업 위치 = 2택 선택 카드(.mode-card 언어) — 아이콘·제목·부제 + 라디오 점. 진한 파란블록 대신 연한 강조.
  const rootSeg = el('div', { class: 'term-seg' }, ...roots.map((r) => {
    const b = el('button', { class: 'term-seg-btn', type: 'button' },
      el('span', { class: 'term-seg-ico', text: rootIco[r.key] || '📁' }),
      el('span', { class: 'term-seg-txt' },
        el('span', { class: 'term-seg-lbl', text: r.label }),
        rootDesc[r.key] ? el('span', { class: 'term-seg-sub', text: rootDesc[r.key] }) : null),
      el('span', { class: 'term-seg-check' }));
    b.onclick = () => { if (rootKey === r.key) return; rootKey = r.key; for (const k in rootBtns) rootBtns[k].classList.toggle('active', k === rootKey); pickerPath = ''; paintPicker(); }; // #869 노드 모드면 원격경로 유지(paintPicker), 폴더 모드면 loadPicker
    rootBtns[r.key] = b; return b;
  }));
  if (rootBtns[rootKey]) rootBtns[rootKey].classList.add('active');
  const pickerBox = el('div', { class: 'term-picker' });
  let pickerPath = '';
  // 실행 위치(#869) — 기본 중앙 컴퓨터. 등록된 내 노드(멤버 PC 등)가 있으면 골라서 그 노드에 세션을 만든다.
  //  오프라인 노드는 비활성(에이전트가 게이트웨이에 연결돼 있어야 생성 가능 — 서버도 409 재검증).
  const nodes = cfg.nodes || [];
  const nodeSel = el('select', { class: 'term-input' },
    el('option', { value: '' }, '중앙 컴퓨터 (기본)'),
    ...nodes.map((n) => {
      const o = el('option', { value: n.id }, '🖥 ' + (n.name || n.id) + (n.online ? '' : ' — 오프라인'));
      if (!n.online) o.disabled = true;
      return o;
    }));
  // 노드 폴더는 원격이라 게이트웨이 browse 로 못 훑는다(v1) — 루트(공유/개인) 기준 하위 경로를 직접 입력.
  const remoteSubI = el('input', { class: 'term-input', type: 'text', placeholder: '노드의 선택한 루트 기준 하위 경로 (비우면 루트)' });
  const paintPicker = () => {
    if (nodeSel.value) pickerBox.replaceChildren(remoteSubI, el('div', { class: 'caption', text: '노드 로컬 경로 — 노드 머신의 선택한 루트(공유/개인 워크스페이스) 기준입니다.' }));
    else loadPicker();
  };
  nodeSel.addEventListener('change', paintPicker);
  const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
  const inviteBox = buildInvitePicker(cfg, new Set()); // 기본 비공개(아무도 선택 안 됨)
  const flagsBox = el('div', { class: 'term-flags' });
  // 자동 승인은 기본 꺼짐이되, 내가 지난번에 켰다면 켠 채로 복원한다(#782 — 사용자별 기억).
  //  (#673 의 'git 워크트리에서 작업' 체크박스는 #918 에서 제거 — 서버측 근거가 사라졌다: terminal-sessions 참조.)
  const autoCb = el('input', { type: 'checkbox' });
  autoCb.checked = prefs.autoApprove === true;
  const autoWrap = el('label', { class: 'term-auto' }, autoCb,
    el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.' }));
  // 라이블리 모드(#1007+) — 이 세션이 라이블리와 얼마나 상호작용하나. 기본 일반, prefs 에 기억하지 않음(매번 명시 — 보안 모드라 의도적).
  //  claude-code 만 동작(codex 는 정적 헤더 → renderFlags 에서 숨김). '어디서 실행할까요'(rootSeg)와 같은 term-seg 선택 카드로 통일 —
  //  체크박스용 term-auto 에 얹은 인라인 <select> 는 라벨이 줄바꿈되고 카드 UI 와 이질적이었다(디자인 통일 요청).
  let modeVal = 'normal';
  const modeOpts = [
    { key: 'normal', lbl: '일반', sub: '라이블리 읽기·쓰기' },
    { key: 'readonly', lbl: '읽기전용', sub: '읽되 쓰지 않음 · 기밀 작업' },
    { key: 'incognito', lbl: '인코그니토', sub: '라이블리 전혀 안 씀 · 클린룸' },
  ];
  const modeBtns: Record<string, any> = {};
  // 아이콘 없이 텍스트(제목·부제) + 라디오만 — 카드 구조·정렬은 term-seg 그대로(요청: 이모지 아이콘 제거).
  const modeSeg = el('div', { class: 'term-seg' }, ...modeOpts.map((m) => {
    const b = el('button', { class: 'term-seg-btn', type: 'button' },
      el('span', { class: 'term-seg-txt' },
        el('span', { class: 'term-seg-lbl', text: m.lbl }),
        el('span', { class: 'term-seg-sub', text: m.sub })),
      el('span', { class: 'term-seg-check' }));
    b.onclick = () => { if (modeVal === m.key) return; modeVal = m.key; for (const k in modeBtns) modeBtns[k].classList.toggle('active', k === modeVal); };
    modeBtns[m.key] = b; return b;
  }));
  modeBtns[modeVal].classList.add('active');
  const modeField = el('div', { 'data-tour': 'mode' }, field('라이블리 모드', modeSeg));

  // '실행 설정'(하네스·모델·effort) — 접이식 프리셋으로 묶어 세로를 아끼고, 이전 설정을 기억한다(#673). 기본 접힘.
  const presetSum = el('div', { class: 'term-preset-sum' });
  const presetChev = el('span', { class: 'term-preset-chev', text: '▾' });
  const presetToggle = el('button', { class: 'term-preset-toggle', type: 'button', 'data-tour': 'preset' }, presetSum, presetChev);
  const presetBody = el('div', { class: 'term-preset-body', 'data-tour': 'model' },
    el('div', { 'data-tour': 'harness' }, field('실행 (AI)', harnessSel)),
    flagsBox,
    profileNoteEl(cfg));
  let presetOpen = false;
  const applyPreset = () => { presetBody.style.display = presetOpen ? '' : 'none'; presetChev.textContent = presetOpen ? '▴' : '▾'; };
  presetToggle.onclick = () => { presetOpen = !presetOpen; applyPreset(); };

  const harnessOf = () => harnesses.find((x) => x.key === harnessSel.value) || {};
  function presetSummary() {
    const h = harnessOf();
    const parts = [h.label || harnessSel.value];
    for (const f of (h.flags || [])) {
      if (f.name !== '--model' && f.name !== '--effort') continue;
      const c = flagsBox.querySelector('[data-flag="' + f.name + '"]') as any;
      parts.push((f.name === '--model' ? '모델 ' : 'effort ') + ((c && c.value) || '기본'));
    }
    presetSum.replaceChildren(el('b', { text: '실행 설정' }), document.createTextNode(' · ' + parts.join(' · ')));
  }

  function renderFlags() {
    const h = harnessOf();
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl: any;
      if (f.type === 'select') ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(기본)')));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
      const saved = prefs.flags && prefs.flags[f.name]; // 이전 설정 복원(#673)
      if (saved != null) { if (ctrl.type === 'checkbox') ctrl.checked = !!saved; else ctrl.value = saved; }
      ctrl.addEventListener('change', presetSummary);
      flagsBox.append(el('div', { class: 'field' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
    modeField.style.display = h.key === 'claude' ? '' : 'none'; // 라이블리 모드는 claude-code 만 동작(codex 정적 헤더·shell 무 MCP) — 안 되는 하네스엔 안 보여 오해 방지(#1007+)
    presetSummary();
  }
  harnessSel.addEventListener('change', renderFlags);
  if (prefs.harness && harnesses.some((h) => h.key === prefs.harness)) harnessSel.value = prefs.harness; // 이전 하네스 복원
  renderFlags();
  applyPreset();

  // 작업 폴더 = 선택한 루트(공유/개인) 안을 드롭다운으로 재귀 탐색.
  async function loadPicker() {
    pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더 불러오는 중…' }));
    let data: any;
    try { data = await api('/api/ui/terminal/browse?root=' + encodeURIComponent(rootKey) + '&path=' + encodeURIComponent(pickerPath)); }
    catch (e) { pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더를 불러오지 못했습니다: ' + e.message })); return; }
    pickerPath = data.path || '';
    const rootLabel = (roots.find((r) => r.key === rootKey) || {}).label || rootKey;
    const crumb = el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: rootLabel, onclick: () => { pickerPath = ''; loadPicker(); } }));
    let acc = '';
    for (const seg of (pickerPath ? pickerPath.split('/') : [])) {
      acc = acc ? acc + '/' + seg : seg; const p = acc;
      crumb.append(el('span', { class: 'crumb-sep', text: ' / ' }), el('a', { class: 'crumb', text: seg, onclick: () => { pickerPath = p; loadPicker(); } }));
    }
    const parentPath = data.parent; // '' = 루트로, null = 이미 루트(상위 없음)
    const sel = el('select', { class: 'term-input', onchange: () => {
      const v = sel.value; sel.value = '';
      if (v === '__up__') { pickerPath = parentPath || ''; loadPicker(); return; }
      if (v === '__new__') { newPickerFolder(); return; }
      if (v) { pickerPath = (pickerPath ? pickerPath + '/' : '') + v; loadPicker(); }
    } },
      el('option', { value: '' }, data.dirs.length ? '하위 폴더로 이동…' : '(하위 폴더 없음)'),
      (pickerPath ? el('option', { value: '__up__' }, '⬆ 상위 폴더로') : null),
      ...data.dirs.map((d) => el('option', { value: d }, '📁 ' + d)),
      el('option', { value: '__new__' }, '＋ 새 폴더 만들기…'));
    // #853 '여기서 AI 실행' 배너 — 지금 고른 위치/폴더에서 세션이 시작된다는 걸 직관적으로.
    const runHere = el('div', { class: 'term-runhere' },
      el('span', { class: 'term-runhere-ic', text: '▶' }),
      el('span', { class: 'term-runhere-txt' },
        document.createTextNode('이 폴더에서 AI 실행 · '),
        el('b', { text: rootLabel }),
        document.createTextNode(pickerPath ? ' / ' + pickerPath : '')));
    pickerBox.replaceChildren(crumb, sel, runHere);
  }
  async function newPickerFolder() {
    const name = prompt('새 폴더 이름'); if (!name || !name.trim()) return;
    const rel = (pickerPath ? pickerPath + '/' : '') + name.trim();
    try { await api('/api/ui/terminal/browse/mkdir?root=' + encodeURIComponent(rootKey) + '&path=' + encodeURIComponent(rel), { method: 'POST' }); pickerPath = rel; loadPicker(); }
    catch (e) { toast('폴더 생성 실패 — ' + e.message, true); }
  }
  loadPicker();

  // 폼 순서(#673) — 무엇(이름) → 어디(폴더) → 어떻게(실행 옵션 체크박스 · 실행 설정 프리셋) → 누구(초대는 맨 아래).
  //  온보딩 투어(#517)의 data-tour 앵커도 이 순서에 맞춘다: label → node → folder → options → preset → invite → create.
  const back = overlay('새 세션',
    el('div', { 'data-tour': 'label' }, field('이름', labelI)),
    el('div', { 'data-tour': 'node' }, field('실행 위치', nodeSel)), // #869 중앙 컴퓨터/등록 노드 — 항상 노출: 투어 ③'실행 위치' 스텝의 대상(#req). 등록 노드가 없으면 '중앙 컴퓨터(기본)' 한 줄만 보인다(submit 값은 기존과 동일 '').
    // #853 작업 위치(공유/개인 토글) + 그 안의 폴더를 한 블록으로 — '이 폴더에서 AI를 실행한다'는 직관.
    el('div', { 'data-tour': 'folder' }, field('어디서 실행할까요', el('div', { class: 'term-loc' }, rootSeg, el('div', { class: 'term-loc-folder' }, pickerBox)))),
    modeField, // 라이블리 모드 — '어디서 실행할까요'와 같은 카드 언어로, 그 아래 독립 필드(#1007+ 디자인 통일)
    el('div', { class: 'term-checks', 'data-tour': 'options' }, autoWrap),
    presetToggle, presetBody,
    el('div', { 'data-tour': 'invite' }, field('초대 (비우면 나만 보는 비공개 세션)', inviteBox.box)),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', 'data-tour': 'create', text: '생성하기', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const fromTour = isTourActive(); // 클릭 순간(투어 종료 전)에 캡처 — 따라하기면 완료 안내를 새 터미널 탭에 띄운다(#673)
        const flags = {};
        for (const c of flagsBox.querySelectorAll('[data-flag]')) flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
        const nodeId = nodeSel.value || ''; // #869 노드면 원격 경로(remoteSubI), 아니면 로컬 폴더(pickerPath)
        const mode = modeVal; // #1007+ 라이블리 모드 → readOnly/incognito 불리언(서버 CreateInput)
        const payload = { label: labelI.value, rootKey, subpath: nodeId ? remoteSubI.value.trim() : pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, readOnly: mode === 'readonly', incognito: mode === 'incognito', invites: inviteBox.selected(), node: nodeId || undefined };
        try {
          const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
          saveTermCreatePrefs({ harness: harnessSel.value, flags, autoApprove: autoCb.checked }); // 이 설정을 다음 생성 때 기본값으로 기억(#673, 자동 승인은 #782)
          back.remove();
          toast('세션 생성됨');
          if (out && out.session) window.open(termUrl(out.session.id, out.session.label, nodeId, fromTour ? '&welcome=1' : ''), '_blank');
          if (onCreated) onCreated(out); else renderTerminal(view);
        } catch (e) { btn.disabled = false; toast('생성 실패 — ' + e.message, true); }
      } })));
}

// 노드 관리(#869) — 내 PC·서버를 노드로 연결(상태·추가안내·토큰회전·활성토글·삭제). 등록 자체는 그 머신에서
//  `lively node --daemon` 이 self-register 하므로, 여기선 '추가하는 법' 안내 + 이미 붙은 노드의 관리를 제공한다.
function openNodeManager(view) {
  const body = el('div', {});
  const back = overlay('🖥 노드 관리', body);
  const gw = location.origin;
  const codeStyle = 'background:var(--bg-subtle,#0d1117);color:#c9d1d9;padding:10px 12px;border-radius:8px;white-space:pre;overflow-x:auto;font-size:12px;line-height:1.6;margin:6px 0';

  async function load() {
    body.replaceChildren(el('div', { class: 'caption', text: '노드를 불러오는 중…' }));
    let nodes: any[] = [];
    try { nodes = (await api('/api/ui/nodes')).nodes || []; }
    catch (e) { body.replaceChildren(el('div', { class: 'caption', text: '노드를 불러오지 못했습니다: ' + e.message })); return; }

    // '내 PC를 노드로 추가하는 법' — 접이식. lively node 가 self-register 하므로 웹 등록 폼 대신 안내.
    const cmd = 'curl -fsSL ' + gw + '/cli | sh\nlively login\nlively node --daemon        # 부팅·로그인마다 자동 연결';
    const codeEl = el('pre', { style: codeStyle, text: cmd });
    const howBody = el('div', { style: 'display:none' },
      el('div', { class: 'caption', text: '내 PC·서버(macOS·Linux)를 노드로 붙이면 그 머신의 터미널 세션을 여기서 만들고 관리하며, 위탁 워커로도 씁니다.' }),
      codeEl,
      el('div', {},
        el('button', { class: 'btn btn-ghost btn-sm', text: '명령 복사', onclick: () => { try { navigator.clipboard.writeText(cmd).then(() => toast('명령 복사됨')).catch(() => toast('복사 실패', true)); } catch (_) { toast('복사 실패', true); } } }),
        el('span', { class: 'caption', text: '  tmux 는 없으면 자동 설치됩니다. 등록되면 아래 목록에 나타납니다(새로고침).' })));
    const howToggle = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 내 PC를 노드로 추가하는 법',
      onclick: () => { howBody.style.display = howBody.style.display === 'none' ? '' : 'none'; } });

    const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px' });
    if (!nodes.length) list.append(el('div', { class: 'caption', text: '아직 등록된 노드가 없습니다 — 위 안내대로 추가하세요.' }));
    for (const n of nodes) {
      const badge = el('span', { class: 'tsess-badge' + (n.online ? '' : ' danger'),
        text: n.online ? '🟢 연결됨 · 세션 ' + (n.sessions || 0) : '⦿ 끊김' });
      const acts = el('div', { style: 'display:flex;gap:6px;margin-left:auto' },
        el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '활성화' : '비활성',
          title: n.enabled === false ? '다시 연결 허용' : '연결 차단(다음 재연결부터 거부)', onclick: () => toggle(n) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '토큰 회전',
          title: '현재 토큰 폐기 — 유출 대응. 그 머신에서 lively node --daemon 재실행이 필요합니다.', onclick: () => rotate(n) }),
        el('button', { class: 'btn btn-sm btn-danger', text: '삭제', onclick: () => del(n) }));
      list.append(el('div', { class: 'card', style: 'display:flex;align-items:center;gap:10px;padding:10px 12px' },
        el('span', { text: '🖥' }),
        el('div', { style: 'min-width:0' },
          el('div', { style: 'font-weight:600' }, document.createTextNode((n.name || n.id) + ' '),
            el('span', { class: 'caption', text: n.kind === 'worker' ? '워커' : '멤버' })),
          el('div', { class: 'caption', text: n.id })),
        badge, acts));
    }
    body.replaceChildren(
      el('div', {}, howToggle, howBody),
      el('div', { style: 'margin-top:8px;font-weight:600' }, document.createTextNode('내 노드 '),
        el('button', { class: 'btn btn-ghost btn-sm', text: '↻', title: '새로고침', onclick: () => load() })),
      list);
  }
  async function del(n) {
    if (!confirm('노드 "' + (n.name || n.id) + '" 를 삭제할까요?\n접속 열쇠가 해제되고 그 머신의 노드 연결이 끊깁니다(다시 붙이려면 lively node --daemon 재실행).')) return;
    try { await api('/api/ui/nodes/' + encodeURIComponent(n.id), { method: 'DELETE' }); toast('노드 삭제됨'); load(); renderTerminal(view); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  }
  async function toggle(n) {
    try { await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/enable', { method: 'POST', body: JSON.stringify({ enabled: n.enabled === false }) }); toast(n.enabled === false ? '활성화됨' : '비활성화됨'); load(); }
    catch (e) { toast('변경 실패 — ' + e.message, true); }
  }
  async function rotate(n) {
    if (!confirm('노드 "' + (n.name || n.id) + '" 의 토큰을 회전할까요?\n현재 토큰이 폐기돼 연결이 끊기고, 그 머신에서 lively node --daemon 을 다시 실행해야 합니다.')) return;
    try { await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/rotate', { method: 'POST', body: '{}' }); toast('토큰 회전됨 — 그 머신에서 lively node --daemon 재실행'); load(); }
    catch (e) { toast('회전 실패 — ' + e.message, true); }
  }
  load();
  return back;
}

// 세션 수정 — 이름·초대 멤버만 변경 가능(소유자만, 서버가 강제). 작업폴더·하네스·모델·자동승인은
//  생성 시 실행 명령에 박혀(돌고 있는 LLM/셸 프로세스) 사후 변경 불가 → '현재값'을 비활성으로 보여주고
//  왜 못 바꾸는지(닫고 새로 켜야 함) 안내한다. "기능 미구현"이 아니라 "구조상 고정"임을 분명히.
function openTermEdit(s, cfg, view) {
  const harnesses = (cfg && cfg.harnesses) || [];
  const harness = harnesses.find((h) => h.key === s.harness) || {};
  // ── 변경 가능 ──
  const labelI = el('input', { class: 'term-input', type: 'text', value: s.label });
  const inviteBox = buildInvitePicker(cfg, new Set(s.invites || []));
  // ── 생성 시 고정(비활성 표시) ──
  const ro = (val) => el('input', { class: 'term-input', type: 'text', value: val, disabled: '' });
  const author = memberName(cfg, s.owner) || s.owner || '?';
  const flagFields = (harness.flags || []).map((f) => {
    const raw = (s.flags && s.flags[f.name] != null) ? String(s.flags[f.name]) : '';
    const shown = f.type === 'bool' ? (raw ? '켜짐' : '꺼짐') : (raw || '(기본)');
    return field(f.label, ro(shown));
  });
  const autoShown = harness.hasAutoApprove ? (s.autoApprove ? '켜짐 (위험)' : '꺼짐') : '해당 없음';
  const lockNote = el('div', { class: 'term-lock-note' },
    el('span', { text: '🔒 작업 폴더 · 하네스 · 모델 · 자동 승인은 세션을 처음 켤 때 정해집니다. 바꾸려면 실행 중인 LLM(또는 셸)을 닫고 새로 켜야 하므로 여기서는 수정할 수 없습니다 — 바꾸려면 새 세션을 만드세요.' }));

  const back = overlay('세션 수정',
    field('이름', labelI),
    field('초대 (선택한 멤버만 이 세션을 보고 열 수 있음 · 비우면 비공개)', inviteBox.box),
    lockNote,
    field('작업자', ro(author)),
    field('작업 폴더', ro(s.dir || '(기본)')),
    field('하네스', ro(harness.label || s.harness || '?')),
    flagFields,
    field('자동 승인', ro(autoShown)),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, invites: inviteBox.selected(), node: (s.node && s.node.id) || undefined }) }); back.remove(); toast('수정됨'); renderTerminal(view); }
        catch (e) { ev.currentTarget.disabled = false; toast('수정 실패 — ' + e.message, true); }
      } })));
}

// 초대 멤버 피커(#673) — 긴 행 목록 대신 '검색해 추가 → 칩' 타입어헤드. 세로로 여러 이름을 항상 보여줄 이유가 없어,
//  기본은 칩(선택된 사람)만 보이고, 검색창을 누르면 드롭다운(absolute 오버레이라 폼 높이를 안 늘림)이 후보를 보여준다.
//  나(state.me) 제외한 구성원이 후보. current(Set)=초기 선택, selected()=고른 id 배열. 생성·수정 폼이 공유한다.
function buildInvitePicker(cfg, current) {
  const meId = (state.me && state.me.userId) || '';
  const others = (cfg.members || []).filter((m) => m.id !== meId);
  const selected = new Set([...current].filter((id) => others.some((m) => m.id === id))); // 유령 id 방지
  const label = (m) => (m.name || m.id) + (m.kind === 'agent' ? ' (AI)' : '');
  const chips = el('div', { class: 'proj-mp-chips' });
  const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
  const menu = el('div', { class: 'proj-mp-menu', hidden: '' });
  const box = el('div', { class: 'proj-mp' }, chips, el('div', { class: 'proj-mp-ta' }, searchIn, menu));

  function paintChips() {
    if (!selected.size) { chips.replaceChildren(el('span', { class: 'proj-mp-hint', text: others.length ? '비우면 나만 보는 비공개 세션이에요.' : '초대할 다른 구성원이 없습니다 — 비공개 세션이 됩니다.' })); return; }
    chips.replaceChildren(...[...selected].map((id) => {
      const m = others.find((x) => x.id === id) || { id, name: id };
      return el('span', { class: 'proj-mp-chip' },
        personFace(m.id, 'proj-mp-ava proj-mp-ava-sm', m.name),
        el('span', { class: 'proj-mp-chip-name', text: label(m) }),
        el('button', { class: 'proj-mp-chip-x', type: 'button', 'aria-label': '초대 제거', text: '×', onclick: () => { selected.delete(id); paintChips(); } }));
    }));
  }
  function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
  function openMenu() {
    const q = searchIn.value.trim().toLowerCase();
    const cand = others.filter((m) => !selected.has(m.id) && (!q || (m.name || m.id).toLowerCase().includes(q))).slice(0, 8);
    if (!cand.length) { menu.replaceChildren(el('div', { class: 'proj-mp-empty', text: others.length ? '일치하는 사람이 없어요.' : '초대할 구성원이 없어요.' })); menu.hidden = false; return; }
    menu.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', role: 'button',
      // mousedown+preventDefault: 클릭 전 blur 로 메뉴가 닫혀 클릭이 씹히는 걸 막는다.
      onmousedown: (e) => { e.preventDefault(); selected.add(m.id); searchIn.value = ''; paintChips(); openMenu(); searchIn.focus(); } },
      personFace(m.id, 'proj-mp-ava', m.name),
      el('span', { class: 'proj-mp-name', text: label(m) }),
      el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
    menu.hidden = false;
  }
  searchIn.addEventListener('focus', openMenu);
  searchIn.addEventListener('input', openMenu);
  searchIn.addEventListener('blur', () => setTimeout(closeMenu, 120));
  paintChips();
  return { box, selected: () => [...selected] };
}

async function renderTerminalSession(view, id) {
  const prefs = termPrefs();
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 세션 목록' });
  const status = el('span', { class: 'caption', text: '연결 중…' });
  const gear = el('button', { class: 'btn btn-ghost btn-sm', text: '⚙ 보기 설정', onclick: () => openTermSettings() });
  const bar = el('div', { class: 'term-bar' }, backLink, el('span', { class: 'term-bar-id', text: decodeURIComponent(id) }), el('span', { style: 'flex:1' }), status, gear);
  const host = el('div', { class: 'term-host' });
  view.replaceChildren(el('div', { class: 'term-wrap' }, bar, host));

  if (!window.Terminal || !window.FitAddon) { status.textContent = '터미널 라이브러리 로드 실패 (xterm)'; return; }
  const term = new Terminal({
    fontFamily: prefs.fontFamily, fontSize: prefs.fontSize, cursorStyle: prefs.cursorStyle, cursorBlink: true,
    theme: (TERM_THEMES[prefs.theme] || TERM_THEMES.dark).theme, scrollback: 5000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch (_) { /* noop */ }

  try { await api('/api/ui/terminal/ticket', { method: 'POST' }); }
  catch (e) { status.textContent = '인증 실패 — ' + e.message; return; }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/terminal/ws?session=' + encodeURIComponent(id));
  const onResize = () => { try { fit.fit(); } catch (_) { /* noop */ } if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } catch (_) { /* noop */ } } };
  termSession = { ws, term, fit, onResize };
  window.addEventListener('resize', onResize);

  ws.onopen = () => { status.textContent = '연결됨'; onResize(); term.focus(); };
  ws.onmessage = (e) => { if (typeof e.data === 'string') term.write(e.data); };
  ws.onclose = () => { status.textContent = '연결 종료'; };
  ws.onerror = () => { status.textContent = '연결 오류'; };
  term.onData((d) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'i', d })); } catch (_) { /* noop */ } } });
}

function openTermSettings() {
  if (!termSession || !termSession.term) { toast('열린 터미널이 없습니다', true); return; }
  const term = termSession.term;
  const prefs = termPrefs();
  const fontSel = el('select', { class: 'term-input' }, ...TERM_FONTS.map((f) => el('option', { value: f.v, selected: f.v === prefs.fontFamily ? '' : null }, f.label)));
  const sizeI = el('input', { class: 'term-input', type: 'number', min: '9', max: '28', value: String(prefs.fontSize) });
  const themeSel = el('select', { class: 'term-input' }, ...Object.entries(TERM_THEMES).map(([k, v]) => el('option', { value: k, selected: k === prefs.theme ? '' : null }, v.name)));
  const cursorSel = el('select', { class: 'term-input' }, ...['bar', 'block', 'underline'].map((c) => el('option', { value: c, selected: c === prefs.cursorStyle ? '' : null }, c)));
  const apply = () => {
    const p = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value };
    term.options.fontFamily = p.fontFamily; term.options.fontSize = p.fontSize; term.options.cursorStyle = p.cursorStyle;
    term.options.theme = (TERM_THEMES[p.theme] || TERM_THEMES.dark).theme;
    saveTermPrefs(p);
    if (termSession && termSession.onResize) termSession.onResize();
  };
  for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener('change', apply);
  sizeI.addEventListener('input', apply);
  overlay('터미널 보기 설정', field('폰트', fontSel), field('크기(px)', sizeI), field('테마', themeSel), field('커서', cursorSel),
    el('div', { class: 'caption', text: '설정은 이 브라우저에 저장되어 다음에도 적용됩니다.' }));
}

// 터미널 온보딩 투어(#517) — 세션 만드는 과정을 실제 UI 위에서 스포트라이트로 한 단계씩 짚어 준다.
//  '새 창으로 열기'(원래 창을 가림)를 대체: 같은 화면에서 필요한 버튼만 밝게, 나머지는 어둡게 하고
//  사용자가 실제 버튼을 직접 누르며 진행한다. renderTerminal/폼이 그린 DOM(data-tour 앵커)에 붙는다.
//  순서는 만들기 창의 시각적 위→아래를 그대로 따른다: [+ 새 세션] 클릭 → ② 이름 → ③ 실행 위치(어느 컴퓨터) →
//  ④ 어디서 실행할까요(어느 폴더) → ⑤ 실행 옵션 → ⑥ 실행 설정(선택) → ⑦ 초대(선택) → ⑧ [생성하기] 클릭 → 🎉 완료.
//  ① 새 세션·⑦ 생성하기는 advanceOn:'click' — 실제 버튼을 눌러야만 진행되며(코치마크에 [이전]/[다음]
//  없이 ✕ 닫기만), 나머지 정보 단계는 [다음 →]으로 넘어간다.
// firstStep — 있으면 ① 단계를 이걸로 대체(대시보드 등 다른 진입점의 '새 세션' 버튼 위치·문구에 맞춤). 없으면 터미널 기본.
function startTerminalTour(firstStep?, opts?) {
  startTour([
    firstStep || {
      target: '[data-tour="new-session"]',
      title: '① 새 세션 만들기',
      body: [el('p', { class: 'tour-p' }, '오른쪽 위 파란 ', el('b', { text: '[+ 새 세션]' }), ' 버튼을 눌러 주세요. 세션 만들기 창이 열립니다.')],
      // scrollIntoView: 버튼이 뷰포트 밖이면 스포트라이트 구멍이 화면 밖이 돼 딤이 통째로 덮여 클릭이 막힌다(#1000).
      placement: 'bottom', advanceOn: 'click', scrollIntoView: true,
    },
    {
      target: '[data-tour="label"]',
      title: '② 세션 이름 정하기',
      body: [el('p', { class: 'tour-p' }, '나중에 알아보기 쉽게 이름을 적어요. 예: ', el('b', { text: '랜딩 카피 수정' }), '.')],
      placement: 'right', scrollIntoView: true,
    },
    {
      // 실행 위치(#869 노드) — 어느 '컴퓨터'에서 돌지. folder(어느 '폴더'에서 일할지)와는 다른 것이라 스텝을 나눈다(#req).
      target: '[data-tour="node"]',
      title: '③ 실행 위치',
      body: [el('p', { class: 'tour-p' }, 'AI가 실제로 ', el('b', { text: '어느 컴퓨터에서 실행될지' }), '예요.'),
        el('p', { class: 'tour-p' }, '보통은 회사의 ', el('b', { text: '[중앙 컴퓨터]' }), '(기본)에서 돌아가니 ', el('b', { text: '그대로 두면 됩니다' }), '. 내 PC를 따로 등록해 뒀다면 여기서 골라 그 컴퓨터에서 돌릴 수도 있어요.')],
      placement: 'right', scrollIntoView: true,
    },
    {
      // 작업 위치(공유/개인) + 그 안의 폴더 = 어느 '폴더'에서 일할지. AI가 들여다보고 다룰 파일들이 있는 곳.
      target: '[data-tour="folder"]',
      title: '④ 어디서 실행할까요',
      body: [el('p', { class: 'tour-p' }, 'AI가 ', el('b', { text: '어느 폴더에서 일할지' }), ' 골라요 — 그 폴더 안의 파일을 AI가 보고 다뤄요.'),
        el('p', { class: 'tour-p' }, '먼저 ', el('b', { text: '작업 위치' }), '를 골라요: ', el('b', { text: '공유 워크스페이스' }), '(팀이 함께 쓰는 곳) 또는 ', el('b', { text: '개인 폴더' }), '(나만 쓰는 곳). 그 아래 ', el('b', { text: '폴더' }), '에서 더 좁은 하위 폴더까지 정할 수 있어요.'),
        el('p', { class: 'tour-p', text: '잘 모르겠으면 기본값 그대로 두어도 괜찮아요.' })],
      placement: 'right', scrollIntoView: true,
    },
    {
      target: '[data-tour="options"]',
      title: '⑤ 실행 옵션',
      body: [el('p', { class: 'tour-p' }, el('b', { text: '자동 승인' }), ' — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.')],
      placement: 'right', scrollIntoView: true,
    },
    {
      target: '[data-tour="preset"]',
      title: '⑥ 실행 설정 (선택)',
      body: [el('p', { class: 'tour-p' }, '함께 일할 ', el('b', { text: 'AI · 모델 · effort' }), '예요. 기본값으로 접혀 있고 ', el('b', { text: '이전 설정을 기억' }), '해요 — 바꾸려면 눌러 펼치세요.'),
        el('p', { class: 'tour-p', text: '잘 모르겠으면 그대로 — Claude Code · 기본 모델로 시작해요.' })],
      placement: 'right', scrollIntoView: true,
    },
    {
      // 검색하면 그 아래로 '사람 목록'(.proj-mp-menu, position:absolute)이 초대칸 밖으로 열린다 → 구멍이 초대칸만 뚫으면
      //  목록이 딤(pointer-events:auto) 밑에 깔려 클릭이 씹힌다(#req). 목록이 열려 있으면 구멍에 함께 포함해 누를 수 있게.
      target: () => { const f = document.querySelector('[data-tour="invite"]'); if (!f) return null; const m = f.querySelector('.proj-mp-menu:not([hidden])'); return m ? [f, m] : f; },
      title: '⑦ 함께 볼 사람 초대하기 (선택)',
      body: [el('p', { class: 'tour-p' }, '검색해서 추가하면 그 사람도 이 세션을 봐요. ', el('b', { text: '비워두면 나만 보는 비공개 세션' }), '이에요.'),
        el('p', { class: 'tour-p', text: '지금 안 정해도 돼요 — 나중에 세션 [수정]에서 바꿀 수 있어요.' })],
      placement: 'right', scrollIntoView: true,
    },
    {
      target: '[data-tour="create"]',
      title: '⑧ 만들기',
      body: [el('p', { class: 'tour-p' }, '마지막! ', el('b', { text: '[생성하기]' }), ' 를 누르면 새 탭에 까만 터미널 창이 열리고, 거기서 완료 안내가 이어집니다.')],
      placement: 'top', scrollIntoView: true, advanceOn: 'click',
    },
    // '🎉 완료' 단계는 여기(원래 탭)에 안 띄운다 — 생성하면 새 탭으로 실제 터미널이 열리므로, 완료 안내는 그 새 탭에서
    //  보여준다(openTermCreateForm 이 &welcome=1 로 넘기고 terminal.js 의 maybeShowWelcome 이 띄운다). 흐름이 실제 터미널에서 끝난다.
  ], opts);
}

export {
  renderTerminal,
  startTerminalTour,
  openTermCreateForm,
  teardownTerminal,
  // '실행 설정' 기억(#673) — 프로젝트 탭 '웹에서 바로 열기' 폼도 같은 키를 읽고 써 두 폼이 기억을 공유한다(#req).
  termCreatePrefs,
  saveTermCreatePrefs,
  termAutoApprovePref,   // 체크박스 없는 원클릭 실행(대시보드 '만들고 Claude로 실행' 등)이 쓰는 자동 승인 기본값(#782)
};
