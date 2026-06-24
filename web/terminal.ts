// terminal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { api, el, errorNote, state, toast } from './core.js';
import { checklist, skeleton } from './learn.js';
import { field, overlay } from './admin.js';
import { parseHash } from './main.js';


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

async function renderTerminal(view, teamId) {
  view.replaceChildren(skeleton('세션을 불러오는 중'));
  let data, cfg, td;
  try { [data, cfg, td] = await Promise.all([
    api('/api/ui/terminal/sessions'), api('/api/ui/terminal/config'), api('/api/ui/terminal/teams'),
  ]); }
  catch (e) { view.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
  const sessions = (data && data.sessions) || [];
  const teams = (td && td.teams) || [];
  if (teamId) { renderTeamView(view, cfg, teams, sessions, teamId); return; }

  const reRender = () => renderTerminal(view, null);
  const top = sessions.filter((s) => !s.team);
  const pub = top.filter((s) => s.visibility !== 'private');
  const priv = top.filter((s) => s.visibility === 'private');
  const pubMine = pub.filter((s) => s.owned);
  const pubOthers = pub.filter((s) => !s.owned);
  // 삭제 가능 = 내 소유 세션(공개 내것 + 비공개). 서버도 소유자 아니면 403 으로 재검증.
  const deletable = [...pubMine, ...priv].filter((s) => s.owned);

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. ids = 선택된 세션 id 집합.
  const sel = { mode: false, ids: new Set() };
  const headActions = el('div', { class: 'term-head-actions' });
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const body = el('div', {});

  function repaintBulk() {
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.ids.size;
    const allOn = deletable.length > 0 && deletable.every((s) => sel.ids.has(s.id));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else deletable.forEach((s) => sel.ids.add(s.id)); repaint(); } });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
      onclick: () => bulkDelete(delBtn) });
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 세션을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
  }

  function repaint() {
    // 헤더 우측 — 생성 버튼들만. (선택/취소 토글은 '공개 세션' 섹션 헤더 우측으로 이동.)
    headActions.replaceChildren(
      el('button', { class: 'btn btn-ghost', text: '+ 새 팀', onclick: () => openTeamCreateForm(cfg, view) }),
      el('button', { class: 'btn btn-primary', text: '+ 새 공개 세션', onclick: () => openTermCreateForm(cfg, view, null, 'public') }),
      el('button', { class: 'btn btn-ghost', text: '+ 새 비공개 세션', onclick: () => openTermCreateForm(cfg, view, null, 'private') }));
    // '공개 세션' 헤더 우측 토글 — 선택모드면 [취소], 평소엔 (삭제 가능한 세션이 있을 때만) [선택].
    const selToggle = sel.mode
      ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); repaint(); } })
      : (deletable.length
          ? el('button', { class: 'btn btn-ghost btn-sm term-sel-toggle', text: '선택', title: '여러 세션을 골라 한 번에 삭제', onclick: () => { sel.mode = true; repaint(); } })
          : null);
    // 팀 세션 / 공개 세션 / 비공개 세션 — 세 섹션. 선택모드면 내 세션 행에 체크박스(selOpt).
    const selOpt = sel.mode ? { ids: sel.ids, onToggle: repaintBulk } : null;
    const sections: any[] = [];
    if (teams.length) {
      const tlist = el('div', { class: 'term-list' });
      for (const t of teams) tlist.append(teamRow(t, cfg, view));
      sections.push([termSectionHead('팀 세션', '같은 팀원끼리만 자유롭게 보고 열 수 있는 세션입니다.'), tlist]);
    }
    sections.push([termSectionHead('공개 세션', '모든 멤버에게 보이는 세션입니다.', selToggle),
      termPublicSection(pubMine, pubOthers, cfg, view, selOpt)]);
    sections.push([termSectionHead('비공개 세션', '나에게만 보이는 세션입니다.'),
      termSessionList(priv, cfg, view, '비공개 세션이 없습니다.', selOpt)]);
    body.replaceChildren();
    sections.forEach(([secHead, secList], i) => {
      if (i > 0) secHead.classList.add('term-section--div'); // 첫 섹션 빼고 위에 구분선
      body.append(secHead, secList);
    });
    repaintBulk();
  }

  async function bulkDelete(btn) {
    const ids: any[] = [...sel.ids];
    if (!ids.length) return;
    if (!confirm(ids.length + '개 세션을 삭제할까요?\n\n실행 중인 작업도 함께 종료됩니다(되돌릴 수 없음).')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403.
    const results = await Promise.allSettled(
      ids.map((id) => api('/api/ui/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 세션을 삭제했습니다'), fail > 0);
    sel.mode = false; sel.ids.clear();
    reRender();
  }

  const head = el('div', { class: 'page-head' }, el('h1', { text: '터미널 세션' }), headActions);
  view.replaceChildren(head, bulkBar, body);
  repaint();
}

// 섹션 제목 + 한 줄 설명(desc 없으면 제목만).
function termSectionHead(title, desc?, rightEl?) {
  return el('div', { class: 'term-section' },
    el('div', { class: 'term-section-row' },
      el('div', { class: 'term-section-title', text: title }),
      rightEl || null),
    desc ? el('div', { class: 'caption term-section-desc', text: desc }) : null);
}
// 세션 목록(비면 안내 문구 — emptyText 가 있을 때만).
function termSessionList(items, cfg, view, emptyText, sel?) {
  const list = el('div', { class: 'term-list' });
  if (!items.length && emptyText) list.append(el('div', { class: 'empty', text: emptyText }));
  for (const s of items) list.append(termRow(s, cfg, view, null, sel));
  return list;
}
// 공개 세션 = 내 것 + 다른 멤버 것. 남의 공개 세션은 계속 쌓이므로 기본 접고(N개) 펼쳐 보게 한다.
function termPublicSection(pubMine, pubOthers, cfg, view, sel) {
  const wrap = el('div', {});
  if (pubMine.length) wrap.append(termSessionList(pubMine, cfg, view, '', sel));
  else if (!pubOthers.length) wrap.append(termSessionList([], cfg, view, '공개 세션이 없습니다. "새 세션"으로 만드세요.'));
  else wrap.append(el('div', { class: 'caption', style: 'margin-top:10px', text: '내가 만든 공개 세션은 없습니다.' }));
  if (pubOthers.length) {
    const list = termSessionList(pubOthers, cfg, view, '');
    list.style.display = 'none';
    const caret = el('span', { class: 'term-fold-caret', text: '▾' });
    const toggle = el('button', { class: 'term-fold', type: 'button' },
      caret, el('span', { text: '다른 멤버의 공개 세션 ' + pubOthers.length + '개' }));
    toggle.addEventListener('click', () => {
      const open = list.style.display === 'none';
      list.style.display = open ? '' : 'none';
      caret.textContent = open ? '▴' : '▾';
      toggle.classList.toggle('open', open);
    });
    wrap.append(toggle, list);
  }
  return wrap;
}

// 팀 세션 행(루트 화면). 열기=팀 진입, 소유자는 팀원 관리·해제.
function teamRow(t, cfg, view) {
  const count = (t.members ? t.members.length : 0) + 1; // +1 = 소유자
  const meta = el('div', { class: 'term-row-meta' },
    el('div', { class: 'term-row-title' },
      el('span', { text: '📁 ' + t.label }),
      t.owned ? el('span', { class: 'term-badge', text: '내 팀' }) : null),
    el('div', { class: 'caption', text: '구성원 ' + count + '명' + ((t.memberNames && t.memberNames.length) ? ' · ' + t.memberNames.join(', ') : '') }));
  // 팀 세션은 모두에게 보이되, 멤버가 아니면 입장 불가(열기 자리에 잠금 표시).
  //  accessible 미정의(구 백엔드 응답)면 접근가능으로 본다 — 재시작 전 회귀 방지(구 백엔드는 내 팀만 내려줌).
  const actions = [t.accessible !== false
    ? el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => { location.hash = '#/terminal?team=' + encodeURIComponent(t.id); } })
    : el('button', { class: 'btn btn-ghost btn-sm', text: '🔒 팀원 전용', disabled: '', title: '이 팀의 팀원만 들어갈 수 있습니다' })];
  if (t.owned) {
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '팀원 관리', onclick: () => openTeamManageForm(t, cfg, view) }));
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '해제', onclick: async () => {
      if (!confirm('팀 "' + t.label + '"을(를) 해제할까요? 폴더와 파일은 그대로 두고 팀 묶음(접근 제한)만 풉니다.')) return;
      try { await api('/api/ui/terminal/teams/' + encodeURIComponent(t.id), { method: 'DELETE' }); toast('팀 해제됨'); renderTerminal(view, null); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  return el('div', { class: 'term-row' }, meta, el('div', { class: 'term-row-actions' }, ...actions));
}

// 팀 진입 화면 — 루트와 동일 UI(세션 목록 + 새 세션), 단 이 팀 세션으로 스코프.
function renderTeamView(view, cfg, teams, sessions, teamId) {
  const back = el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', text: '← 터미널 홈' });
  const team = teams.find((t) => t.id === teamId);
  if (!team || team.accessible === false) {
    const msg = !team ? '존재하지 않는 팀입니다.' : '이 팀 세션은 팀원만 들어갈 수 있습니다. 팀 소유자에게 초대를 요청하세요.';
    view.replaceChildren(el('div', { class: 'page-head' }, el('div', { class: 'term-head-actions' }, back), el('h1', { text: '팀 세션' })),
      el('div', { class: 'empty', text: msg }));
    return;
  }
  const ownerName = team.owned ? myName(cfg) : (memberName(cfg, team.owner) || '소유자');
  const memberBadges = el('div', { class: 'term-members' },
    el('span', { class: 'term-badge owner', text: '👑 ' + ownerName }),
    ...((team.memberNames || []).map((n) => el('span', { class: 'term-badge', text: '👤 ' + n }))));
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'term-head-actions' }, back,
      el('button', { class: 'btn btn-primary', text: '+ 새 세션', onclick: () => openTermCreateForm(cfg, view, team) }),
      team.owned ? el('button', { class: 'btn btn-ghost', text: '팀원 관리', onclick: () => openTeamManageForm(team, cfg, view) }) : null),
    el('h1', { text: '📁 ' + team.label }),
    memberBadges,
    el('div', { class: 'caption', text: '이 팀 세션은 같은 팀원끼리만 자유롭게 보고 열 수 있습니다.' }));
  const mine = sessions.filter((s) => s.team === teamId);
  const list = el('div', { class: 'term-list' });
  if (!mine.length) list.append(el('div', { class: 'empty', text: '이 팀에 세션이 없습니다. "새 세션"으로 만드세요.' }));
  for (const s of mine) list.append(termRow(s, cfg, view, team));
  view.replaceChildren(head, list);
}

function termRow(s, cfg, view, team, sel?) {
  const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness;
  const author = memberName(cfg, s.owner) || s.owner || '?';
  const created = fmtTermDate(s.created);
  const meta = el('div', { class: 'term-row-meta' },
    el('div', { class: 'term-row-title' },
      el('span', { class: 'term-row-name', title: s.label, text: s.label }),
      el('span', { class: 'term-badge author', text: '👤 ' + author }),
      el('span', { class: 'term-badge', text: s.visibility === 'private' ? '비공개' : '공개' }),
      s.autoApprove ? el('span', { class: 'term-badge danger', text: '자동승인' }) : null,
      s.attached ? el('span', { class: 'term-badge', text: '접속중' }) : null),
    el('div', { class: 'caption', text: harnessLabel + (created ? ' · ' + created : '') + (s.dir ? ' · ' + s.dir : '') }));
  // 선택(일괄삭제) 모드: 내 소유 세션엔 체크박스(행 전체가 토글 — label). 남의 세션은 체크박스 없음(삭제 불가).
  if (sel && s.owned) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = sel.ids.has(s.id);
    cb.addEventListener('change', () => { if (cb.checked) sel.ids.add(s.id); else sel.ids.delete(s.id); if (sel.onToggle) sel.onToggle(); });
    return el('label', { class: 'term-row term-row--sel' }, el('span', { class: 'term-row-check' }, cb), meta);
  }
  const reRender = () => renderTerminal(view, team ? team.id : null);
  const actions = [el('button', { class: 'btn btn-primary btn-sm', text: '열기', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') })];
  if (s.owned) {
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '수정', onclick: () => openTermEdit(s, cfg, view, team) }));
    actions.push(el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: async () => {
      if (!confirm('세션 "' + s.label + '" 을(를) 종료할까요? 실행 중인 작업도 함께 종료됩니다.')) return;
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' }); toast('세션 종료됨'); reRender(); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  return el('div', { class: 'term-row' }, meta, el('div', { class: 'term-row-actions' }, ...actions));
}

// 새 세션. team 이 주어지면 그 팀 세션으로 스코프(작업 위치 고정, team 태그 전달).
function openTermCreateForm(cfg, view, team?, fixedVis?) {
  const roots = cfg.roots || [];
  const harnesses = cfg.harnesses || [];
  const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
  const authorI = el('input', { class: 'term-input', type: 'text', value: myName(cfg), disabled: '' });
  const rootSel = el('select', { class: 'term-input' }, ...roots.map((r) => el('option', { value: r.key }, r.label)));
  const pickerBox = el('div', { class: 'term-picker' });
  let pickerPath = '';
  const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
  const visSel = el('select', { class: 'term-input' },
    el('option', { value: 'public' }, '공개 — 모든 멤버가 열람 가능한 세션 (팀 내부 세션은 팀원만 열람가능)'),
    el('option', { value: 'private' }, '비공개 — 나에게만 보이고 나만 열 수 있는 세션'));
  // 헤더의 '새 공개/비공개 세션' 버튼으로 들어오면 공개여부가 정해져 있으므로 자동선택+비활성(회색)으로 둔다.
  if (fixedVis) { visSel.value = fixedVis; visSel.disabled = true; }
  const flagsBox = el('div', { class: 'term-flags' });
  const autoCb = el('input', { type: 'checkbox' });
  const autoWrap = el('label', { class: 'term-auto' }, autoCb,
    el('span', { text: ' 자동 승인 (위험) — 에이전트가 확인 없이 파일 수정·명령 실행. 공유 폴더에선 특히 주의.' }));

  function renderFlags() {
    const h = harnesses.find((x) => x.key === harnessSel.value) || {};
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl: any;
      if (f.type === 'select') ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(기본)')));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
      flagsBox.append(el('div', { class: 'field' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
  }
  harnessSel.addEventListener('change', renderFlags);
  renderFlags();

  // 작업 폴더 = 선택한 루트(공유/개인) 안을 드롭다운으로 재귀 탐색. 팀 컨텍스트면 폴더 고정.
  async function loadPicker() {
    pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더 불러오는 중…' }));
    let data: any;
    try { data = await api('/api/ui/terminal/browse?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(pickerPath)); }
    catch (e) { pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더를 불러오지 못했습니다: ' + e.message })); return; }
    pickerPath = data.path || '';
    const rootLabel = (roots.find((r) => r.key === rootSel.value) || {}).label || rootSel.value;
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
    pickerBox.replaceChildren(crumb, sel, el('div', { class: 'caption', text: '여기서 시작: /' + pickerPath }));
  }
  async function newPickerFolder() {
    const name = prompt('새 폴더 이름'); if (!name || !name.trim()) return;
    const rel = (pickerPath ? pickerPath + '/' : '') + name.trim();
    try { await api('/api/ui/terminal/browse/mkdir?root=' + encodeURIComponent(rootSel.value) + '&path=' + encodeURIComponent(rel), { method: 'POST' }); pickerPath = rel; loadPicker(); }
    catch (e) { toast('폴더 생성 실패 — ' + e.message, true); }
  }
  if (!team) {
    rootSel.addEventListener('change', () => { pickerPath = ''; loadPicker(); });
    loadPicker();
  }

  // 팀 컨텍스트면 작업 위치/폴더 대신 고정된 '팀 세션' 표시 필드.
  const locFields = team
    ? [field('팀 세션', el('input', { class: 'term-input', type: 'text', value: '📁 ' + team.label, disabled: '' }))]
    : [field('작업 위치', rootSel), field('폴더', pickerBox)];

  const newTitle = fixedVis === 'private' ? '새 비공개 세션' : (fixedVis === 'public' ? '새 공개 세션' : '새 세션');
  const back = overlay(team ? ('새 세션 · ' + team.label) : newTitle,
    field('이름', labelI), field('작업자', authorI), locFields, field('하네스', harnessSel),
    field('공개 범위', visSel), flagsBox, autoWrap,
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '생성하기', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        const flags = {};
        for (const c of flagsBox.querySelectorAll('[data-flag]')) flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
        const payload = team
          ? { label: labelI.value, rootKey: 'shared', subpath: team.id, harness: harnessSel.value, flags, autoApprove: autoCb.checked, visibility: visSel.value, team: team.id }
          : { label: labelI.value, rootKey: rootSel.value, subpath: pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, visibility: visSel.value };
        try {
          const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
          back.remove(); toast('세션 생성됨');
          if (out && out.session) window.open('/ui/terminal.html?session=' + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
          renderTerminal(view, team ? team.id : null);
        } catch (e) { btn.disabled = false; toast('생성 실패 — ' + e.message, true); }
      } })));
}

// 세션 수정 — 이름·공개범위만 변경 가능(소유자만, 서버가 강제). 작업폴더·하네스·모델·자동승인은
//  생성 시 실행 명령에 박혀(돌고 있는 LLM/셸 프로세스) 사후 변경 불가 → '현재값'을 비활성으로 보여주고
//  왜 못 바꾸는지(닫고 새로 켜야 함) 안내한다. "기능 미구현"이 아니라 "구조상 고정"임을 분명히.
function openTermEdit(s, cfg, view, team) {
  const harnesses = (cfg && cfg.harnesses) || [];
  const harness = harnesses.find((h) => h.key === s.harness) || {};
  // ── 변경 가능 ──
  const labelI = el('input', { class: 'term-input', type: 'text', value: s.label });
  const visSel = el('select', { class: 'term-input' },
    el('option', { value: 'public', selected: s.visibility !== 'private' ? '' : null }, '공개 — 모든 멤버가 열람 가능한 세션 (팀 내부 세션은 팀원만 열람가능)'),
    el('option', { value: 'private', selected: s.visibility === 'private' ? '' : null }, '비공개 — 나에게만 보이고 나만 열 수 있는 세션'));
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
    field('공개 범위', visSel),
    lockNote,
    field('작업자', ro(author)),
    field('작업 폴더', ro(s.dir || '(기본)')),
    field('하네스', ro(harness.label || s.harness || '?')),
    flagFields,
    field('자동 승인', ro(autoShown)),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, visibility: visSel.value }) }); back.remove(); toast('수정됨'); renderTerminal(view, team ? team.id : null); }
        catch (e) { ev.currentTarget.disabled = false; toast('수정 실패 — ' + e.message, true); }
      } })));
}

// 새 팀 — 공유 워크스페이스에 폴더를 만들고 선택한 구성원만 접근. 소유자(나)는 자동 포함.
function openTeamCreateForm(cfg, view) {
  const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 그로스팀' });
  const meId = (state.me && state.me.userId) || '';
  const others = (cfg.members || []).filter((m) => m.id !== meId);
  const checks = others.map((m) => {
    const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
    return { id: m.id, cb, row: el('label', { class: 'term-check' }, cb, el('span', { text: m.name + (m.kind === 'agent' ? ' (AI)' : '') })) };
  });
  const listBox = checks.length
    ? el('div', { class: 'term-checklist' }, ...checks.map((c) => c.row))
    : el('div', { class: 'caption', text: '추가할 다른 구성원이 없습니다 — 나만 접근하는 팀이 됩니다.' });
  const back = overlay('새 팀',
    field('팀 이름', labelI),
    field('소유자', el('input', { class: 'term-input', type: 'text', value: myName(cfg), disabled: '' })),
    field('팀원 (선택한 구성원만 이 팀 세션에 접근)', listBox),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '팀 만들기', onclick: async (ev) => {
        if (!labelI.value.trim()) { toast('팀 이름을 입력하세요', true); return; }
        ev.currentTarget.disabled = true;
        const picked = checks.filter((c) => c.cb.checked).map((c) => c.id);
        try {
          const out = await api('/api/ui/terminal/teams', { method: 'POST', body: JSON.stringify({ label: labelI.value, members: picked }) });
          back.remove(); toast('팀 생성됨');
          if (out && out.team) location.hash = '#/terminal?team=' + encodeURIComponent(out.team.id);
          else renderTerminal(view, null);
        } catch (e) { ev.currentTarget.disabled = false; toast('팀 생성 실패 — ' + e.message, true); }
      } })));
}

// 팀원 관리 — 이름·팀원 수정(소유자만). 저장 후 현재 보던 화면 유지.
function openTeamManageForm(team, cfg, view) {
  const labelI = el('input', { class: 'term-input', type: 'text', value: team.label });
  const current = new Set(team.members || []);
  const others = (cfg.members || []).filter((m) => m.id !== team.owner);
  const checks = others.map((m) => {
    const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
    if (current.has(m.id)) cb.checked = true;
    return { id: m.id, cb, row: el('label', { class: 'term-check' }, cb, el('span', { text: m.name + (m.kind === 'agent' ? ' (AI)' : '') })) };
  });
  const listBox = checks.length
    ? el('div', { class: 'term-checklist' }, ...checks.map((c) => c.row))
    : el('div', { class: 'caption', text: '추가할 다른 구성원이 없습니다.' });
  const back = overlay('팀원 관리 · ' + team.label,
    field('팀 이름', labelI),
    field('소유자', el('input', { class: 'term-input', type: 'text', value: memberName(cfg, team.owner), disabled: '' })),
    field('팀원 (선택한 구성원만 이 팀 세션에 접근)', listBox),
    el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
        if (!labelI.value.trim()) { toast('팀 이름을 입력하세요', true); return; }
        ev.currentTarget.disabled = true;
        const picked = checks.filter((c) => c.cb.checked).map((c) => c.id);
        try {
          await api('/api/ui/terminal/teams/' + encodeURIComponent(team.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, members: picked }) });
          back.remove(); toast('팀 수정됨');
          renderTerminal(view, parseHash().params.get('team') || null);
        } catch (e) { ev.currentTarget.disabled = false; toast('수정 실패 — ' + e.message, true); }
      } })));
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

export {
  renderTerminal,
  teamRow,
  teardownTerminal,
};
