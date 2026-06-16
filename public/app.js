// Lively Context 웹 UI — 프레임워크 없는 해시 라우팅 SPA-lite.
// 보안 규칙: 모든 데이터 텍스트는 textContent/createElement 만 사용(innerHTML 에 데이터 주입 금지 —
// discord/notion 본문 XSS 방어). 토큰은 localStorage 에만, 절대 로그/URL 에 싣지 않는다.
'use strict';

const TOKEN_KEY = 'lively_ui_token';
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  me: null,
  stats: null,          // /api/ui/stats 캐시 (개요 + 싱크 칩 + 필터 옵션 공유)
  repos: null,          // /api/ui/repos 캐시
  candidates: new Map(),// repo → Promise<candidates>
  items: { filters: { q: '', system: '', type: '', repo: '', domainKey: '', projectKey: '', since: '' }, rows: [], offset: 0, done: false, loaded: false, selectedId: null },
  inbox: { filters: { missing: 'either', repo: '', system: '', type: '', since: '' } }, // 페이지네이션 오프셋은 renderInbox 로컬
  domainsRepo: '',
  dm: { section: 'areas', filter: 'all', selectedId: null, cursor: -1, rows: [] }, // 도메인(domainmap 큐레이션) 페이지 상태
  admin: { data: null, sel: 'managed-policy', memberSel: null, memorySel: null }, // 관리(전달) 페이지 상태
};
let revealUsed = false; // 입장 리빌은 첫 부팅 렌더 1회만(§6)
let uid = 0;            // datalist 등 고유 id 카운터

// ── DOM 헬퍼 ──
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function sv(name, attrs, ...children) {
  const n = document.createElementNS(SVG_NS, name);
  if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null) n.setAttribute(k, v); }
  for (const c of children.flat(Infinity)) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return n;
}
const $view = () => document.getElementById('view');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function applyReveal(nodes) {
  if (revealUsed || reducedMotion()) { revealUsed = true; return; }
  nodes.forEach((n, i) => { n.classList.add('reveal'); n.style.animationDelay = (i * 70) + 'ms'; });
  revealUsed = true;
}

// ── fetch 헬퍼 — 401 은 토큰 게이트, 그 외 비정상은 {error} 메시지로 throw ──
async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = Object.assign({}, opts.headers);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showGate('토큰이 무효화되었습니다. 다시 입력하세요.');
    const e = new Error('인증이 필요합니다'); e.status = 401; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* 빈 바디 허용 */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
    e.status = res.status;
    throw e;
  }
  return data;
}

// ── 시간/숫자 ──
// 마지막 싱크가 며칠 전일 수 있음 — 분/시간/일 폴백('분' 가정 금지).
function relTime(iso) {
  if (!iso) return '시간 정보 없음';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '시간 정보 없음';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '일 전';
  return new Date(iso).toLocaleDateString('ko-KR');
}
function absTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
}
const fmtNum = (n) => Number(n || 0).toLocaleString('ko-KR');
const STATE_LABEL = { proposed: '제안됨', confirmed: '확정', rejected: '기각됨' };
const BY_LABEL = { rule: '규칙', llm: 'LLM', manual: '수동' };

// ── 토스트 — undo = { changeId, onUndone }: domainmap change_id 되돌리기(최신 1건만, 6초) ──
function toast(msg, isError, undo) {
  const box = document.getElementById('toasts');
  if (undo) for (const old of box.querySelectorAll('.toast[data-undo]')) old.remove();
  const t = el('div', { class: 'toast' + (isError ? ' coral' : ''), text: msg });
  if (undo && undo.changeId) {
    t.dataset.undo = '1';
    const btn = el('button', { class: 'btn-text', text: '실행 취소' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/ui/domainmap/restore/' + encodeURIComponent(undo.changeId), { method: 'POST', body: JSON.stringify({}) });
        t.remove();
        toast('되돌렸습니다');
        if (undo.onUndone) undo.onUndone();
      } catch (e) {
        // 400(dependent rows 등) — 서버 메시지 그대로 표시, 재시도 없음.
        t.remove();
        toast('되돌리지 못했습니다 — ' + e.message, true);
      }
    });
    t.append(btn);
  }
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), undo ? 6000 : 3600);
}

// ── 스킵 링크 — href 를 따라가면 해시 라우터가 오작동하므로 JS 로 포커스만 이동(§8) ──
document.getElementById('skip-link').addEventListener('click', (ev) => {
  ev.preventDefault();
  const v = $view();
  if (v) { v.setAttribute('tabindex', '-1'); v.focus(); }
});

// ── 탐색 리스트 캐시 동기화 — 디테일/인박스에서 제안·확정 성공 시 같은 세션의 목록 배지가
//    구식('제안됨')으로 남지 않게 해당 행의 매핑 엔트리를 갱신/추가 ──
function patchItemsCache(itemId, kind, repo, key, newState, newBy) {
  const row = state.items.rows.find((r) => String(r.id) === String(itemId));
  if (!row) return;
  const arr = kind === 'domain' ? (row.domains = row.domains || []) : (row.projects = row.projects || []);
  const ex = arr.find((m) => m.repo === repo && m.key === key);
  if (ex) { ex.state = newState; ex.by = newBy; }
  else arr.push({ repo, key, state: newState, by: newBy });
}

// ── 캐시 로더 ──
function getStats(force) {
  if (!force && state.stats) return Promise.resolve(state.stats);
  return api('/api/ui/stats').then((s) => { state.stats = s; updateSyncChip(); return s; });
}
function getRepos(force) {
  if (!force && state.repos) return Promise.resolve(state.repos);
  return api('/api/ui/repos').then((r) => { state.repos = r; return r; });
}
function getCandidates(repo) {
  if (!state.candidates.has(repo)) {
    const p = api('/api/ui/candidates?repo=' + encodeURIComponent(repo))
      .catch((e) => { state.candidates.delete(repo); throw e; });
    state.candidates.set(repo, p);
  }
  return state.candidates.get(repo);
}

function updateSyncChip() {
  const chip = document.getElementById('sync-chip');
  const label = document.getElementById('sync-label');
  if (state.stats && state.stats.lastOccurredAt) {
    label.textContent = relTime(state.stats.lastOccurredAt) + ' 싱크';
    chip.hidden = false;
  }
}

// ── 토큰 게이트 ──
function showGate(message) {
  document.getElementById('app').hidden = true;
  const gate = document.getElementById('gate');
  gate.hidden = false;
  const err = document.getElementById('gate-error');
  if (message) { err.textContent = message; err.hidden = false; }
  document.getElementById('gate-input').focus();
}
function hideGate() {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
}
document.getElementById('gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = document.getElementById('gate-input');
  const err = document.getElementById('gate-error');
  const v = input.value.trim();
  if (!v) return;
  try {
    const res = await fetch('/api/ui/me', { headers: { Authorization: 'Bearer ' + v } });
    if (res.ok) {
      localStorage.setItem(TOKEN_KEY, v);
      input.value = '';
      err.hidden = true;
      hideGate();
      boot();
    } else {
      err.textContent = '토큰이 유효하지 않습니다.';
      err.hidden = false;
    }
  } catch (_) {
    err.textContent = '서버에 연결하지 못했습니다.';
    err.hidden = false;
  }
});

// ── 에러 표시 헬퍼 ──
function errorNote(e, prefix) {
  if (e && e.status === 403) {
    return el('div', { class: 'note', text: '이 토큰에 필요한 권한(items/context)이 없습니다.' });
  }
  return el('div', { class: 'note', text: (prefix || '불러오지 못했습니다') + ' — ' + (e && e.message ? e.message : '알 수 없는 오류') });
}

// ── 매핑 배지(리스트/카드 공용) ──
function badgeRow(item) {
  const maps = [];
  for (const d of item.domains || []) maps.push({ kind: 'domain', repo: d.repo, key: d.key, state: d.state });
  for (const p of item.projects || []) maps.push({ kind: 'project', repo: p.repo, key: p.key, state: p.state });
  if (!maps.length) return null;
  const repoSet = new Set(maps.map((m) => m.repo));
  const showRepo = repoSet.size > 1; // 멀티레포일 때만 "repo:key" 프리픽스
  const wrap = el('div', { class: 'badge-row' });
  for (const m of maps.slice(0, 4)) {
    wrap.append(
      el('span', { class: 'pill ' + (m.kind === 'domain' ? 'pill-domain' : 'pill-project'), text: (showRepo ? m.repo + ':' : '') + m.key }),
      el('span', { class: 'pill pill-state ' + m.state, text: STATE_LABEL[m.state] || m.state }),
    );
  }
  if (maps.length > 4) wrap.append(el('span', { class: 'pill pill-more', text: '+' + (maps.length - 4) }));
  return wrap;
}

function rowTitle(item) {
  if (item.title) return item.title;
  const s = (item.snippet || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 80) : '(내용 없음)';
}

function itemRow(item, selected) {
  const meta = [item.system, item.actor || '작성자 미상', relTime(item.occurred_at)].join(' · ');
  const row = el('div', { class: 'row' + (selected ? ' sel' : ''), role: 'link', tabindex: '0' },
    el('div', { class: 'row-title', text: rowTitle(item) }),
    el('div', { class: 'row-meta' }, meta, item.parent_id ? el('span', { class: 'thread-mark', text: '  ↳ 스레드' }) : null),
    badgeRow(item),
  );
  const go = () => { location.hash = '#/items/' + item.id; };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return row;
}

// ════════════════════════════════════════════
// 1) 개요 #/overview
// ════════════════════════════════════════════
async function renderOverview(view) {
  view.replaceChildren(
    el('div', { class: 'skel-stack' },
      el('div', { class: 'skel', style: 'min-height:220px' }),
      el('div', { class: 'loading-caption', text: '통계 불러오는 중…' }),
    ),
  );
  let stats, recent;
  try {
    [stats, recent] = await Promise.all([getStats(true), api('/api/ui/items?limit=8')]);
  } catch (e) {
    if (e.status === 401) return;
    view.replaceChildren(errorNote(e, '통계를 불러오지 못했습니다'));
    return;
  }
  const recentRows = (recent && recent.rows) || [];

  // ── 페이지 헤더(§0.5 calm — 그라데이션/SVG 글로우 없이 숫자 타이포만) ──
  const confirmedTotal = stats.coverage.reduce((a, c) => a + c.domainConfirmed + c.projectConfirmed, 0);
  const statRow = el('div', { class: 'stat-row' },
    el('div', { class: 'stat' },
      el('div', { class: 'num' }, fmtNum(stats.total), el('small', { text: '건' })),
      el('div', { class: 'lbl', text: '전체 아이템' })),
    stats.bySystem.map((s) => el('div', { class: 'stat' },
      el('div', { class: 'num', text: fmtNum(s.count) }),
      el('div', { class: 'lbl', text: s.system }))),
    el('div', { class: 'stat' },
      el('div', { class: 'num' }, fmtNum(confirmedTotal), el('small', { text: '건' })),
      el('div', { class: 'lbl', text: '확정 매핑' })),
  );
  const systems = stats.bySystem.map((s) => s.system).join('·') || '소스';
  const hero = el('section', { class: 'page-head' },
    el('h1', { text: '개요' }),
    el('p', { class: 'sub', text: systems + '의 대화와 문서가 도메인 지도에 연결됩니다.' }),
    statRow,
  );

  // ── 커버리지 카드 ──
  const covCard = el('section', { class: 'card' }, el('h2', { text: '레포별 매핑 커버리지' }));
  if (!stats.coverage.length) {
    covCard.append(el('p', { class: 'empty', text: '아직 매핑된 레포가 없습니다. run-map을 실행하거나 큐레이션에서 직접 제안하세요.' }));
  } else {
    for (const c of stats.coverage) {
      const line = (lbl, items, proposed, confirmed) => {
        const pct = stats.total ? Math.min(100, Math.round(items / stats.total * 100)) : 0;
        const stat = el('span', { class: 'cov-stat' },
          fmtNum(items) + '/' + fmtNum(stats.total) + ' · 제안 ' + fmtNum(proposed) + ' · 확정 ',
          confirmed > 0 ? el('span', { class: 'ok', text: fmtNum(confirmed) }) : String(confirmed));
        return el('div', { class: 'cov-line' },
          el('span', { class: 'cov-lbl', text: lbl }),
          el('div', { class: 'track' }, el('div', { class: 'fill', style: 'width:' + pct + '%' })),
          stat);
      };
      covCard.append(el('div', { class: 'cov-repo' },
        el('div', { class: 'cov-name', text: c.repo }),
        line('도메인', c.domainItems, c.domainProposed, c.domainConfirmed),
        line('프로젝트', c.projectItems, c.projectProposed, c.projectConfirmed),
      ));
    }
  }

  // ── 최근 유입 카드 ──
  const recentCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: '최근 유입' }),
      el('span', { class: 'caption', text: '마지막 싱크 ' + relTime(stats.lastOccurredAt) })),
  );
  const listBox = el('div', { class: 'list-box', style: 'margin-top:4px' });
  if (!recentRows.length) listBox.append(el('div', { class: 'empty', text: '아직 싱크된 아이템이 없습니다.' }));
  for (const it of recentRows) {
    const r = el('div', { class: 'row', role: 'link', tabindex: '0' },
      el('div', { class: 'row-title', text: rowTitle(it) }),
      el('div', { class: 'row-meta', text: [it.system, it.actor || '작성자 미상', relTime(it.occurred_at)].join(' · ') }));
    r.addEventListener('click', () => { location.hash = '#/items/' + it.id; });
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = '#/items/' + it.id; });
    listBox.append(r);
  }
  recentCard.append(listBox);
  // 14일 미니 바 — 실데이터(recentDaily), 오늘은 민트.
  // 날짜 키는 서버(uiStats)와 동일하게 Asia/Seoul 고정 — UTC 키를 쓰면 KST 00~09시에 하루가 밀림.
  const byDay = new Map((stats.recentDaily || []).map((d) => [d.day, d.count]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })); // sv-SE = YYYY-MM-DD
  }
  const max = Math.max(1, ...days.map((d) => byDay.get(d) || 0));
  const bars = el('div', { class: 'bars' });
  days.forEach((d, i) => {
    const c = byDay.get(d) || 0;
    bars.append(el('div', {
      class: 'bar' + (i === 13 ? ' today' : ''),
      style: 'height:' + (4 + Math.round(28 * c / max)) + 'px',
      title: d + ' · ' + c + '건',
    }));
  });
  recentCard.append(el('div', { class: 'caption', style: 'margin-top:14px', text: '최근 14일 유입' }), bars);

  const grid = el('div', { class: 'grid-2' }, covCard, recentCard);
  view.replaceChildren(hero, grid);
  applyReveal([hero, covCard, recentCard]);
}

// ════════════════════════════════════════════
// 2) 탐색 #/items, #/items/:id
// ════════════════════════════════════════════
async function renderItems(view, detailId, params) {
  // 해시 쿼리 프리필(도메인 페이지에서 진입 등).
  if (params && [...params.keys()].length) {
    const f = state.items.filters;
    for (const k of ['q', 'system', 'type', 'repo', 'domainKey', 'projectKey', 'since']) {
      if (params.has(k)) f[k] = params.get(k);
    }
    state.items.loaded = false; // 필터가 바뀌었으니 재조회
    history.replaceState(null, '', '#/items'); // 프리필 1회 소비
  }
  state.items.selectedId = detailId || null;

  let stats = null, repos = null;
  try { stats = await getStats(); } catch (e) { if (e.status === 401) return; }
  try { repos = await getRepos(); } catch (_) { /* context 스코프 없거나 다운 — 레포 필터만 비활성 */ }

  const f = state.items.filters;
  const mkSelect = (name, options, value, onchange, extra) => {
    const s = el('select', Object.assign({ 'aria-label': name }, extra));
    for (const o of options) s.append(el('option', { value: o.value, text: o.label }));
    s.value = value;
    s.addEventListener('change', onchange);
    return s;
  };
  const optAll = (label) => ({ value: '', label });

  const searchInput = el('input', { type: 'search', placeholder: '제목·본문 검색', value: f.q, 'aria-label': '검색' });
  let debounceTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { f.q = searchInput.value.trim(); resetAndFetch(); }, 300);
  });

  const systemSel = mkSelect('시스템',
    [optAll('시스템 전체'), ...((stats && stats.bySystem) || []).map((s) => ({ value: s.system, label: s.system }))],
    f.system, () => { f.system = systemSel.value; resetAndFetch(); });
  const typeSel = mkSelect('타입',
    [optAll('타입 전체'), ...((stats && stats.byType) || []).map((t) => ({ value: t.type, label: t.type }))],
    f.type, () => { f.type = typeSel.value; resetAndFetch(); });
  const repoSel = mkSelect('레포',
    [optAll('레포 전체'), ...(((repos && repos.repos) || []).map((r) => ({ value: r, label: r })))],
    f.repo, async () => { f.repo = repoSel.value; await fillKeySelects(); resetAndFetch(); });
  const domainSel = mkSelect('도메인 키', [optAll('도메인 전체')], f.domainKey,
    () => { f.domainKey = domainSel.value; resetAndFetch(); });
  const projectSel = mkSelect('프로젝트 키', [optAll('프로젝트 전체')], f.projectKey,
    () => { f.projectKey = projectSel.value; resetAndFetch(); });
  const sinceInput = el('input', { type: 'date', value: f.since ? f.since.slice(0, 10) : '', 'aria-label': '이후 날짜' });
  sinceInput.addEventListener('change', () => {
    f.since = sinceInput.value ? new Date(sinceInput.value + 'T00:00:00').toISOString() : '';
    resetAndFetch();
  });
  const resetBtn = el('button', { class: 'btn-text', text: '초기화', onclick: () => {
    state.items.filters = { q: '', system: '', type: '', repo: '', domainKey: '', projectKey: '', since: '' };
    state.items.loaded = false;
    route();
  } });

  async function fillKeySelects() {
    const repo = f.repo;
    for (const [sel, kind] of [[domainSel, 'domains'], [projectSel, 'projects']]) {
      // 비활성 사유를 title 만이 아니라 옵션 텍스트로도 노출(보조기술/시각 동일 정보).
      const base = kind === 'domains' ? '도메인' : '프로젝트';
      sel.replaceChildren(el('option', { value: '', text: repo ? base + ' 전체' : base + ' — 레포 먼저 선택' }));
      sel.disabled = !repo;
      sel.title = repo ? '' : '레포를 먼저 선택하세요';
    }
    if (!repo) { f.domainKey = ''; f.projectKey = ''; return; }
    try {
      const c = await getCandidates(repo);
      for (const d of c.domains) domainSel.append(el('option', { value: d.key, text: d.key + (d.name ? ' — ' + d.name : '') }));
      for (const p of c.projects) projectSel.append(el('option', { value: p.key, text: p.key + (p.name ? ' — ' + p.name : '') }));
      domainSel.value = f.domainKey || '';
      projectSel.value = f.projectKey || '';
      if (domainSel.value !== f.domainKey) f.domainKey = '';
      if (projectSel.value !== f.projectKey) f.projectKey = '';
    } catch (_) {
      // 후보 로드 실패(domainmap 다운 등) — 키 셀렉트는 빈 상태로 둠
    }
  }

  const filterBar = el('div', { class: 'panel filter-bar' },
    searchInput, systemSel, typeSel, repoSel, domainSel, projectSel, sinceInput, resetBtn);

  const listBox = el('div', { class: 'list-box' });
  const countCap = el('span', { class: 'caption', text: '' });
  const moreBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '더 보기', onclick: () => fetchPage(true) });
  moreBtn.hidden = true;
  const listFoot = el('div', { class: 'list-foot' }, moreBtn, countCap);
  const detailPane = el('div', { class: 'split-detail' });

  function renderList() {
    listBox.replaceChildren();
    if (!state.items.rows.length) {
      listBox.append(el('div', { class: 'empty', text: '조건에 맞는 아이템이 없습니다. 필터를 줄여보세요.' }));
    }
    for (const it of state.items.rows) listBox.append(itemRow(it, String(it.id) === String(state.items.selectedId)));
    countCap.textContent = fmtNum(state.items.rows.length) + '건 표시 중';
    moreBtn.hidden = state.items.done;
  }

  async function fetchPage(append) {
    const usp = new URLSearchParams();
    if (f.q) usp.set('q', f.q);
    if (f.system) usp.set('system', f.system);
    if (f.type) usp.set('type', f.type);
    if (f.repo) usp.set('repo', f.repo);
    if (f.domainKey) usp.set('domainKey', f.domainKey);
    if (f.projectKey) usp.set('projectKey', f.projectKey);
    if (f.since) usp.set('since', f.since);
    usp.set('limit', '30');
    usp.set('offset', String(append ? state.items.offset : 0));
    try {
      const data = await api('/api/ui/items?' + usp.toString());
      const rows = (data && data.rows) || [];
      if (append) state.items.rows = state.items.rows.concat(rows);
      else state.items.rows = rows;
      state.items.offset = state.items.rows.length;
      state.items.done = rows.length < 30;
      state.items.loaded = true;
      renderList();
    } catch (e) {
      if (e.status === 401) return;
      listBox.replaceChildren(errorNote(e, '아이템을 불러오지 못했습니다'));
    }
  }
  function resetAndFetch() { state.items.offset = 0; fetchPage(false); }

  const split = el('div', { class: 'split' },
    el('div', { class: 'split-list' }, listBox, listFoot),
    detailPane);
  view.replaceChildren(filterBar, split);
  applyReveal([filterBar, split]);

  await fillKeySelects();
  if (state.items.loaded) renderList(); else await fetchPage(false);

  if (detailId) renderDetail(detailPane, detailId);
  else detailPane.append(el('div', { class: 'detail-card' },
    el('p', { class: 'empty', text: '왼쪽 목록에서 아이템을 선택하세요.' })));
}

// ── 디테일 페인 ──
async function renderDetail(pane, id) {
  pane.replaceChildren(el('div', { class: 'skel', style: 'min-height:200px' }));
  let data;
  try {
    data = await api('/api/ui/items/' + encodeURIComponent(id));
  } catch (e) {
    if (e.status === 401) return;
    pane.replaceChildren(errorNote(e, '아이템을 불러오지 못했습니다'));
    return;
  }
  const item = data.item;
  const card = el('div', { class: 'detail-card' });

  // 헤더.
  const head = el('div', {},
    el('h3', { class: 'detail-title', text: item.title || '(제목 없음)' }),
    el('div', { class: 'detail-meta' },
      el('span', { text: item.type }), el('span', { text: '·' }),
      el('span', { text: item.system }), el('span', { text: '·' }),
      el('span', { text: item.actor || '작성자 미상' }), el('span', { text: '·' }),
      el('span', { text: absTime(item.occurred_at) }),
      el('span', { class: 'caption', text: '(' + relTime(item.occurred_at) + ')' }),
      item.external_url
        ? el('a', { class: 'btn btn-ghost btn-sm', href: item.external_url, target: '_blank', rel: 'noopener noreferrer', text: '원본 보기 ↗' })
        : null,
    ));
  card.append(head);

  // 스레드(대화형) — 부모 체인 → 현재 → 답글.
  const th = data.thread || { ancestors: [], children: [] };
  if (th.ancestors.length || th.children.length) {
    card.append(el('div', { class: 'sec-label', text: '스레드' }));
    const thread = el('div', { class: 'thread' });
    const bubble = (row, cls) => {
      const b = el('div', { class: 'bubble' + (cls ? ' ' + cls : ''), role: cls === 'current' ? null : 'link', tabindex: cls === 'current' ? null : '0' },
        el('div', { class: 'bubble-head' },
          el('span', { text: row.actor || '작성자 미상' }),
          el('span', { class: 'when', text: relTime(row.occurred_at) })),
        el('div', { class: 'bubble-body', text: (row.snippet || row.title || '').slice(0, 280) }));
      if (cls !== 'current') {
        const go = () => { location.hash = '#/items/' + row.id; };
        b.addEventListener('click', go);
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      }
      return b;
    };
    for (const a of th.ancestors) thread.append(bubble(a));
    thread.append(bubble({ actor: item.actor, occurred_at: item.occurred_at, snippet: item.title || (item.body || '').slice(0, 280) }, 'current'));
    if (th.children.length) {
      thread.append(el('div', { class: 'caption', text: '답글 ' + th.children.length + '개' }));
      for (const c of th.children) thread.append(bubble(c, 'child'));
    }
    card.append(thread);
  }

  // 본문 — 클램프 3단(3,000자 → 20k → ?full=1 전체, 50k 단위 rAF 분할 렌더).
  card.append(el('div', { class: 'sec-label', text: '본문' }));
  const total = Number(item.body_length || 0);
  const body = item.body || '';
  const pre = el('pre', { class: 'body-text' });
  if (!body) {
    pre.textContent = '(본문 없음)';
    card.append(pre);
  } else if (total <= 3000) {
    pre.textContent = body;
    card.append(pre);
  } else {
    pre.textContent = body.slice(0, 3000) + '\n…';
    const overServer = total > 20000;
    const btn = el('button', {
      class: 'btn btn-ghost btn-sm',
      style: 'margin-top:10px',
      text: (overServer ? '전체 불러오기' : '전체 보기') + ' (총 ' + fmtNum(total) + '자)',
    });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (!overServer) { pre.textContent = body; btn.remove(); return; }
      try {
        const full = await api('/api/ui/items/' + encodeURIComponent(id) + '?full=1');
        const text = (full.item && full.item.body) || '';
        // 518k 문서 잭 방지 — 50k 단위 텍스트 노드 분할 append.
        pre.textContent = '';
        let i = 0;
        (function step() {
          if (i >= text.length) return;
          pre.append(document.createTextNode(text.slice(i, i + 50000)));
          i += 50000;
          requestAnimationFrame(step);
        })();
        btn.remove();
      } catch (e) {
        btn.disabled = false;
        toast('본문을 불러오지 못했습니다 — ' + e.message, true);
      }
    });
    card.append(pre, btn);
  }

  // 필드(접힘).
  const fields = item.fields && typeof item.fields === 'object' ? Object.entries(item.fields) : [];
  if (fields.length) {
    const tbl = el('table', { class: 'fields-table' });
    for (const [k, v] of fields) {
      tbl.append(el('tr', {}, el('td', { text: k }), el('td', { text: typeof v === 'string' ? v : JSON.stringify(v) })));
    }
    card.append(el('details', { class: 'fields' }, el('summary', { text: '필드' }), tbl));
  }

  // 매핑 섹션.
  card.append(el('div', { class: 'sec-label', text: '매핑' }));
  const mapsBox = el('div', {});
  const renderMapGroup = (label, rows, kind, keyField) => {
    if (!rows.length) return;
    mapsBox.append(el('div', { class: 'caption', style: 'margin-top:6px', text: label }));
    for (const m of rows) {
      const row = el('div', { class: 'map-row' },
        el('span', { class: 'pill ' + (kind === 'domain' ? 'pill-domain' : 'pill-project'), text: m[keyField] }),
        el('span', { class: 'pill pill-state ' + m.state, text: STATE_LABEL[m.state] || m.state }),
        el('span', { class: 'chip-by', text: BY_LABEL[m.mapped_by] || m.mapped_by }),
        el('span', { class: 'caption', text: m.repo }),
        m.confidence != null ? el('span', { class: 'caption', text: Number(m.confidence).toFixed(2) }) : null,
      );
      if (m.state === 'proposed') {
        const cBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '확정' });
        const rBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '기각' });
        cBtn.addEventListener('click', async () => {
          cBtn.disabled = true; rBtn.disabled = true;
          try {
            await api('/api/ui/confirm', { method: 'POST', body: JSON.stringify({ kind, itemId: Number(id), key: m[keyField], repo: m.repo }) });
            row.querySelector('.pill-state').textContent = STATE_LABEL.confirmed;
            row.querySelector('.pill-state').className = 'pill pill-state confirmed';
            row.querySelector('.chip-by').textContent = BY_LABEL.manual;
            cBtn.remove(); rBtn.remove();
            row.classList.add('flash');
            toast('확정되었습니다');
            state.stats = null; // 커버리지 통계 무효화
            patchItemsCache(id, kind, m.repo, m[keyField], 'confirmed', 'manual'); // 목록 배지 구식 방지
          } catch (e) {
            cBtn.disabled = false; rBtn.disabled = false;
            toast('확정 실패 — ' + e.message, true);
          }
        });
        // 기각 — state='rejected' 전이. 서버 기본 제외라 reload 후엔 자동 숨김; 이번 렌더에선 칩만 전환.
        rBtn.addEventListener('click', async () => {
          // 기각 사유(선택) — audit.evidence 로 기록(CLI 발 기각과 감사 완전성 대칭). 취소(null)는 중단.
          const reason = prompt('기각 사유 (선택 — audit에 기록됩니다. 빈 값 가능)');
          if (reason === null) return;
          cBtn.disabled = true; rBtn.disabled = true;
          try {
            const body = { kind, itemId: Number(id), key: m[keyField], repo: m.repo };
            if (reason.trim()) body.evidence = reason.trim();
            await api('/api/ui/reject', { method: 'POST', body: JSON.stringify(body) });
            row.querySelector('.pill-state').textContent = STATE_LABEL.rejected;
            row.querySelector('.pill-state').className = 'pill pill-state rejected';
            cBtn.remove(); rBtn.remove();
            toast('기각되었습니다 — 확정으로만 부활 가능');
            state.stats = null; // 커버리지 통계 무효화
            patchItemsCache(id, kind, m.repo, m[keyField], 'rejected', m.mapped_by);
          } catch (e) {
            cBtn.disabled = false; rBtn.disabled = false;
            toast('기각 실패 — ' + e.message, true);
          }
        });
        row.append(cBtn, rBtn);
      }
      mapsBox.append(row);
      // 인용 그라운딩 — evidence 가 있는 행만(실데이터: llm). rule 행은 블록 생략.
      if (m.evidence) mapsBox.append(el('div', { class: 'evidence', text: m.evidence }));
    }
  };
  renderMapGroup('도메인', data.domains || [], 'domain', 'domain_key');
  renderMapGroup('프로젝트', data.projects || [], 'project', 'project_key');
  if (!(data.domains || []).length && !(data.projects || []).length) {
    mapsBox.append(el('p', { class: 'caption', text: '아직 매핑이 없습니다. 아래에서 직접 제안하세요.' }));
  }
  card.append(mapsBox);

  // ＋ 매핑 추가(인라인 제안 폼).
  const addBtn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:10px', text: '＋ 매핑 추가' });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    const form = await buildProposeForm(Number(id), () => renderDetail(pane, id));
    addBtn.replaceWith(form);
  });
  card.append(addBtn);

  pane.replaceChildren(card);
  // 포커스 관리(§8) — 라우트 재구축으로 포커스가 body 로 초기화되므로 디테일 카드로 이동
  // (키보드 사용자가 상단바·필터·행 전체를 다시 통과하지 않게).
  card.setAttribute('tabindex', '-1');
  card.focus({ preventScroll: true });
}

// 인라인 제안 폼(디테일/공용) — repo·키 셀렉터, evidence/confidence 선택.
async function buildProposeForm(itemId, onDone) {
  let kind = 'domain';
  let repos = [];
  try { repos = ((await getRepos()) || {}).repos || []; } catch (_) { /* 아래 빈 상태 처리 */ }

  const form = el('div', { class: 'propose-form' });
  const kindBtns = {};
  const kindToggle = el('div', { class: 'kind-toggle', role: 'group', 'aria-label': '매핑 종류' });
  for (const [k, label] of [['domain', '도메인'], ['project', '프로젝트']]) {
    kindBtns[k] = el('button', { type: 'button', class: k === kind ? 'on' : '', 'aria-pressed': String(k === kind), text: label });
    kindBtns[k].addEventListener('click', () => {
      kind = k;
      for (const kk of Object.keys(kindBtns)) {
        kindBtns[kk].className = kk === kind ? 'on' : '';
        kindBtns[kk].setAttribute('aria-pressed', String(kk === kind));
      }
      refreshKeys();
    });
    kindToggle.append(kindBtns[k]);
  }
  const repoSel = el('select', { 'aria-label': '레포' });
  for (const r of repos) repoSel.append(el('option', { value: r, text: r }));
  if (!repos.length) repoSel.append(el('option', { value: '', text: '(레포 없음)' }));
  const keyId = 'cand-' + (++uid);
  const keyInput = el('input', { type: 'text', list: keyId, placeholder: '키 검색·선택', 'aria-label': '매핑 키' });
  const keyList = el('datalist', { id: keyId });
  const evidenceTa = el('textarea', { rows: '2', placeholder: '근거 인용 (선택)', 'aria-label': '근거' });
  const confInput = el('input', { type: 'number', min: '0', max: '1', step: '0.05', placeholder: 'confidence (선택)', 'aria-label': 'confidence', style: 'width:150px' });
  const inlineNote = el('p', { class: 'inline-note' });
  inlineNote.hidden = true;
  const submit = el('button', { class: 'btn btn-primary btn-sm', text: '제안' });

  async function refreshKeys() {
    keyList.replaceChildren();
    const repo = repoSel.value;
    if (!repo) return;
    try {
      const c = await getCandidates(repo);
      const rows = kind === 'domain' ? c.domains : c.projects;
      for (const r of rows) keyList.append(el('option', { value: r.key, label: r.name || r.key }));
    } catch (e) {
      inlineNote.textContent = '후보를 불러오지 못했습니다 — ' + e.message;
      inlineNote.hidden = false;
    }
  }
  repoSel.addEventListener('change', refreshKeys);

  submit.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) { inlineNote.textContent = '키를 입력하세요.'; inlineNote.hidden = false; return; }
    if (!repoSel.value) { inlineNote.textContent = 'repo 필수 — 레포를 선택하세요.'; inlineNote.hidden = false; return; }
    submit.disabled = true;
    inlineNote.hidden = true;
    const body = { kind, itemId, key, repo: repoSel.value };
    if (evidenceTa.value.trim()) body.evidence = evidenceTa.value.trim();
    if (confInput.value !== '') body.confidence = Number(confInput.value);
    try {
      const r = await api('/api/ui/propose', { method: 'POST', body: JSON.stringify(body) });
      // 보호 경로는 200 + skipped-* — 반드시 action 분기(성공으로 오인 금지).
      if (r.action === 'inserted' || r.action === 'refreshed') {
        patchItemsCache(itemId, kind, body.repo, key, 'proposed', 'manual'); // 목록 배지 동기화
      }
      if (r.action === 'inserted') { toast('제안됨'); state.stats = null; onDone && onDone(); }
      else if (r.action === 'refreshed') { toast('갱신됨'); onDone && onDone(); }
      else if (r.action === 'skipped-rejected') {
        inlineNote.textContent = '기각된 매핑 — 확정으로만 부활 가능합니다.';
        inlineNote.hidden = false;
        submit.disabled = false;
      }
      else {
        inlineNote.textContent = '보호된 매핑이라 건너뜀 — 확정·수동 행은 덮지 않습니다.';
        inlineNote.hidden = false;
        submit.disabled = false;
      }
    } catch (e) {
      inlineNote.textContent = '제안 실패 — ' + e.message;
      inlineNote.hidden = false;
      submit.disabled = false;
    }
  });

  form.append(
    el('div', { class: 'form-row' }, kindToggle, repoSel, keyInput),
    el('div', { class: 'form-row' }, evidenceTa, confInput, submit),
    keyList, inlineNote,
  );
  await refreshKeys();
  return form;
}

// ════════════════════════════════════════════
// 3) 큐레이션 #/inbox
// ════════════════════════════════════════════
async function renderInbox(view) {
  const f = state.inbox.filters;
  let stats = null, repos = null;
  try { stats = await getStats(); } catch (e) { if (e.status === 401) return; }
  try { repos = await getRepos(); } catch (_) { /* 레포 셀렉터만 축소 */ }
  const repoList = (repos && repos.repos) || [];

  const banner = el('div', { class: 'note', text: '미매핑은 신호입니다 — 억지로 매핑하지 마세요. 맞는 후보가 없으면 그대로 두는 것이 맞습니다.' });

  const mkSelect = (label, options, value, onchange) => {
    const s = el('select', { 'aria-label': label });
    for (const o of options) s.append(el('option', { value: o.value, text: o.label }));
    s.value = value;
    s.addEventListener('change', onchange);
    return s;
  };
  const missingSel = mkSelect('미매핑 기준', [
    { value: 'either', label: '하나라도 없음' },
    { value: 'domain', label: '도메인 없음' },
    { value: 'project', label: '프로젝트 없음' },
    { value: 'both', label: '둘 다 없음' },
  ], f.missing, () => { f.missing = missingSel.value; refetch(); });
  const repoSel = mkSelect('레포', [
    { value: '', label: '전체(레포 무관)' },
    ...repoList.map((r) => ({ value: r, label: r })),
  ], f.repo, () => { f.repo = repoSel.value; refetch(); });
  const systemSel = mkSelect('시스템',
    [{ value: '', label: '시스템 전체' }, ...((stats && stats.bySystem) || []).map((s) => ({ value: s.system, label: s.system }))],
    f.system, () => { f.system = systemSel.value; refetch(); });
  const typeSel = mkSelect('타입',
    [{ value: '', label: '타입 전체' }, ...((stats && stats.byType) || []).map((t) => ({ value: t.type, label: t.type }))],
    f.type, () => { f.type = typeSel.value; refetch(); });
  const sinceInput = el('input', { type: 'date', value: f.since ? f.since.slice(0, 10) : '', 'aria-label': '이후 날짜' });
  sinceInput.addEventListener('change', () => {
    f.since = sinceInput.value ? new Date(sinceInput.value + 'T00:00:00').toISOString() : '';
    refetch();
  });

  const countNum = el('div', { class: 'num-big', text: '—' });
  const countCap = el('div', { class: 'caption', text: '기준: ' + (f.repo ? f.repo + ' 레포 미매핑' : '레포 무관 미매핑') });
  const controls = el('div', { class: 'panel filter-bar' },
    missingSel,
    el('label', { class: 'fld' }, '레포 선택 시 그 레포 기준 미매핑', repoSel),
    systemSel, typeSel, sinceInput,
    el('div', { style: 'margin-left:auto;text-align:right' }, countNum, countCap),
  );

  const grid = el('div', { class: 'inbox-grid' });
  const moreBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '더 보기', onclick: () => fetchPage(true) });
  moreBtn.hidden = true;
  const footCap = el('span', { class: 'caption' });
  const foot = el('div', { class: 'list-foot' }, moreBtn, footCap);
  view.replaceChildren(banner, el('div', { style: 'margin-top:14px' }, controls), grid, foot);
  applyReveal([banner, controls, grid]);

  let total = 0;  // 서버 count(현재 필터 기준 총 미매핑)
  let offset = 0; // 누적 오프셋 — 카드 제거 시 보정해 '더 보기' 건너뜀 방지

  function renderCount() {
    // §2 num 레시피 — 숫자만 num 스케일, '미매핑'·'건'은 단위(small --muted-2)로 분리.
    countNum.replaceChildren(el('small', { text: '미매핑' }), fmtNum(total), el('small', { text: '건' }));
  }
  function renderFoot() {
    const shown = grid.querySelectorAll('.inbox-card').length;
    footCap.textContent = fmtNum(shown) + '건 표시 중 / 총 ' + fmtNum(total) + '건';
    moreBtn.hidden = offset >= total;
  }

  // 서버 unmappedItemsUi 와 같은 의미(레포 선택 시 그 레포 기준) — 제안 후 로컬 제거/유지 판정용.
  function matchesMissing(item) {
    const inRepo = (m) => !f.repo || m.repo === f.repo;
    const hasD = (item.domains || []).some(inRepo);
    const hasP = (item.projects || []).some(inRepo);
    if (f.missing === 'domain') return !hasD;
    if (f.missing === 'project') return !hasP;
    if (f.missing === 'both') return !hasD && !hasP;
    return !hasD || !hasP; // either(기본)
  }

  async function fetchPage(append) {
    countCap.textContent = '기준: ' + (f.repo ? f.repo + ' 레포 미매핑' : '레포 무관 미매핑');
    if (!append) {
      offset = 0;
      grid.replaceChildren(
        el('div', { class: 'skel', style: 'min-height:130px' }),
        el('div', { class: 'skel', style: 'min-height:130px' }),
        el('div', { class: 'skel', style: 'min-height:130px' }));
      footCap.textContent = '';
      moreBtn.hidden = true;
    }
    moreBtn.disabled = true;
    const usp = new URLSearchParams();
    usp.set('missing', f.missing);
    if (f.repo) usp.set('repo', f.repo);
    if (f.system) usp.set('system', f.system);
    if (f.type) usp.set('type', f.type);
    if (f.since) usp.set('since', f.since);
    usp.set('limit', '20');
    usp.set('offset', String(append ? offset : 0));
    let data;
    try {
      data = await api('/api/ui/inbox?' + usp.toString());
    } catch (e) {
      moreBtn.disabled = false;
      if (e.status === 401) return;
      if (append) toast('더 불러오지 못했습니다 — ' + e.message, true);
      else grid.replaceChildren(errorNote(e, '미매핑 아이템을 불러오지 못했습니다'));
      return;
    }
    moreBtn.disabled = false;
    total = data.count;
    renderCount();
    if (!append) grid.replaceChildren();
    if (!append && !data.rows.length) {
      // 빈 상태 — 미니 정적 네트워크(펄스 없음).
      const svg = sv('svg', { viewBox: '0 0 120 60', width: '120', height: '60', fill: 'none' },
        sv('line', { x1: '60', y1: '30', x2: '20', y2: '14', stroke: 'var(--line-net-2)', 'stroke-width': '2' }),
        sv('line', { x1: '60', y1: '30', x2: '100', y2: '44', stroke: 'var(--line-net-2)', 'stroke-width': '2' }),
        sv('circle', { cx: '60', cy: '30', r: '8', fill: 'var(--blue)' }),
        sv('circle', { cx: '20', cy: '14', r: '5', fill: 'var(--mint)' }),
        sv('circle', { cx: '100', cy: '44', r: '5', fill: 'var(--node-mint-soft)' }));
      grid.append(el('div', { class: 'empty' }, svg, '미매핑 아이템이 없습니다. 새 아이템이 싱크되면 여기에 표시됩니다.'));
      return;
    }
    for (const it of data.rows) grid.append(inboxCard(it));
    offset += data.rows.length;
    renderFoot();
  }
  function refetch() { return fetchPage(false); }

  function inboxCard(item) {
    const defaultRepo = f.repo || repoList[0] || '';
    const card = el('section', { class: 'card inbox-card' });
    // 제목 = 디테일 링크(스레드·전체 본문·기존 근거를 보고 제안할 수 있게) + 명시적 '자세히 →'.
    card.append(el('div', { class: 'inbox-head' },
      el('h3', { class: 'inbox-title' }, el('a', { href: '#/items/' + item.id, text: rowTitle(item) })),
      el('span', { style: 'white-space:nowrap' },
        el('a', { class: 'inbox-detail-link', href: '#/items/' + item.id, text: '자세히 →' }),
        item.external_url ? el('a', { class: 'caption', style: 'margin-left:10px', href: item.external_url, target: '_blank', rel: 'noopener noreferrer', text: '원본 ↗' }) : null,
      ),
    ));
    card.append(el('div', { class: 'row-meta', text: [item.system, item.actor || '작성자 미상', relTime(item.occurred_at)].join(' · ') }));
    // discord 는 title 이 본문 머리와 동일한 경우가 많음 — 정규화 후 중복이면 스니펫 생략.
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    if (item.title && item.snippet && !norm(item.snippet).startsWith(norm(item.title))) {
      card.append(el('p', { class: 'snippet-2l', text: item.snippet }));
    }

    // 매핑 배지 — either 기준이라 한쪽만 매핑된 경우 부분 배지 + proposed 행은 바로 확정 가능.
    const badgesSlot = el('div', {});
    function renderBadges() {
      const maps = [];
      for (const d of item.domains || []) maps.push({ kind: 'domain', m: d });
      for (const p of item.projects || []) maps.push({ kind: 'project', m: p });
      if (!maps.length) { badgesSlot.replaceChildren(); return; }
      const showRepo = new Set(maps.map((x) => x.m.repo)).size > 1;
      const wrap = el('div', { class: 'badge-row' });
      for (const { kind, m } of maps) {
        wrap.append(
          el('span', { class: 'pill ' + (kind === 'domain' ? 'pill-domain' : 'pill-project'), text: (showRepo ? m.repo + ':' : '') + m.key }),
          el('span', { class: 'pill pill-state ' + m.state, text: STATE_LABEL[m.state] || m.state }),
        );
        if (m.state === 'proposed') {
          const cBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '확정' });
          const rBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '기각' });
          cBtn.addEventListener('click', async () => {
            cBtn.disabled = true; rBtn.disabled = true;
            try {
              await api('/api/ui/confirm', { method: 'POST', body: JSON.stringify({ kind, itemId: Number(item.id), key: m.key, repo: m.repo }) });
              m.state = 'confirmed'; m.by = 'manual';
              state.stats = null;
              patchItemsCache(item.id, kind, m.repo, m.key, 'confirmed', 'manual');
              toast('확정되었습니다');
              renderBadges();
              card.classList.add('flash');
            } catch (e) {
              cBtn.disabled = false; rBtn.disabled = false;
              toast('확정 실패 — ' + e.message, true);
            }
          });
          // 기각 — 서버 기본 제외라 reload 후 자동 숨김. 이번 렌더에선 기각됨 칩으로 전환만.
          rBtn.addEventListener('click', async () => {
            // 기각 사유(선택) — audit.evidence 로 기록(CLI 발 기각과 감사 완전성 대칭). 취소(null)는 중단.
            const reason = prompt('기각 사유 (선택 — audit에 기록됩니다. 빈 값 가능)');
            if (reason === null) return;
            cBtn.disabled = true; rBtn.disabled = true;
            try {
              const body = { kind, itemId: Number(item.id), key: m.key, repo: m.repo };
              if (reason.trim()) body.evidence = reason.trim();
              await api('/api/ui/reject', { method: 'POST', body: JSON.stringify(body) });
              m.state = 'rejected';
              state.stats = null;
              patchItemsCache(item.id, kind, m.repo, m.key, 'rejected', m.by);
              toast('기각되었습니다 — 확정으로만 부활 가능');
              renderBadges();
            } catch (e) {
              cBtn.disabled = false; rBtn.disabled = false;
              toast('기각 실패 — ' + e.message, true);
            }
          });
          wrap.append(cBtn, rBtn);
        }
      }
      badgesSlot.replaceChildren(wrap);
    }
    renderBadges();
    card.append(badgesSlot);

    // 제안 성공으로 missing 에서 벗어나면 이 카드만 제거(그리드 전체 refetch 금지 — 포커스·스크롤 보존).
    function removeCard() {
      card.classList.add('flash');
      setTimeout(() => {
        const next = card.nextElementSibling || card.previousElementSibling;
        card.remove();
        total = Math.max(0, total - 1);
        offset = Math.max(0, offset - 1); // 서버 오프셋 시프트 보정
        renderCount();
        renderFoot();
        if (!grid.querySelectorAll('.inbox-card').length) { refetch(); return; }
        if (next) { const t = next.querySelector('a, button, select, input'); if (t) t.focus(); }
      }, 450);
    }

    const strip = el('div', { class: 'curation-strip' });
    for (const [kind, title] of [['domain', '도메인 제안'], ['project', '프로젝트 제안']]) {
      const repoSel2 = el('select', { 'aria-label': title + ' 레포' });
      for (const r of repoList) repoSel2.append(el('option', { value: r, text: r }));
      if (!repoList.length) repoSel2.append(el('option', { value: '', text: '(레포 없음)' }));
      if (defaultRepo) repoSel2.value = defaultRepo;
      const keySel = el('select', { 'aria-label': title + ' 키' }, el('option', { value: '', text: '키 선택' }));
      const evInput = el('input', { type: 'text', placeholder: '근거 인용 (선택)', 'aria-label': '근거' });
      const goBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '제안' }); // 카드 반복 액션 = 무채(§0.5 예산)
      const note = el('p', { class: 'inline-note' });
      note.hidden = true;

      async function fillKeys() {
        keySel.replaceChildren(el('option', { value: '', text: '키 선택' }));
        if (!repoSel2.value) return;
        try {
          const c = await getCandidates(repoSel2.value);
          for (const r of (kind === 'domain' ? c.domains : c.projects)) {
            keySel.append(el('option', { value: r.key, text: r.key + (r.name ? ' — ' + r.name : '') }));
          }
        } catch (e) {
          note.textContent = '후보를 불러오지 못했습니다 — ' + e.message;
          note.hidden = false;
        }
      }
      repoSel2.addEventListener('change', fillKeys);
      fillKeys();

      goBtn.addEventListener('click', async () => {
        if (!keySel.value) { note.textContent = '키를 선택하세요.'; note.hidden = false; return; }
        if (!repoSel2.value) { note.textContent = 'repo 필수 — 레포를 선택하세요.'; note.hidden = false; return; }
        goBtn.disabled = true;
        note.hidden = true;
        const body = { kind, itemId: Number(item.id), key: keySel.value, repo: repoSel2.value }; // pg 가 BIGINT id 를 문자열로 반환 — 숫자 강제
        if (evInput.value.trim()) body.evidence = evInput.value.trim();
        try {
          const r = await api('/api/ui/propose', { method: 'POST', body: JSON.stringify(body) });
          if (r.action === 'inserted' || r.action === 'refreshed') {
            toast(r.action === 'inserted' ? '제안됨' : '갱신됨');
            state.stats = null;
            patchItemsCache(item.id, kind, body.repo, body.key, 'proposed', 'manual');
            // 로컬 매핑 갱신 → missing 재평가(서버 unmappedItemsUi 와 동일 기준).
            const arr = kind === 'domain' ? (item.domains = item.domains || []) : (item.projects = item.projects || []);
            const ex = arr.find((mm) => mm.repo === body.repo && mm.key === body.key);
            if (ex) { ex.state = 'proposed'; ex.by = 'manual'; }
            else arr.push({ repo: body.repo, key: body.key, state: 'proposed', by: 'manual' });
            if (!matchesMissing(item)) { removeCard(); return; }
            renderBadges();
            card.classList.add('flash');
            goBtn.disabled = false;
          } else if (r.action === 'skipped-rejected') {
            note.textContent = '기각된 매핑 — 확정으로만 부활 가능합니다.';
            note.hidden = false;
            goBtn.disabled = false;
          } else {
            note.textContent = '보호된 매핑이라 건너뜀 — 확정·수동 행은 덮지 않습니다.';
            note.hidden = false;
            goBtn.disabled = false;
          }
        } catch (e) {
          note.textContent = '제안 실패 — ' + e.message;
          note.hidden = false;
          goBtn.disabled = false;
        }
      });

      strip.append(el('div', { class: 'mini-form' },
        el('div', { class: 'mf-title', text: title }),
        el('div', { class: 'mf-row' }, repoSel2, keySel),
        el('div', { class: 'mf-row' }, evInput, goBtn),
        note,
      ));
    }
    card.append(strip);
    return card;
  }

  await refetch();
}

// ════════════════════════════════════════════
// 4) 도메인 #/domains, #/domains/:id — domainmap 큐레이션 표면(구 :7700 UI 흡수, §0.5 calm)
// ════════════════════════════════════════════
const DM_STATE_LABEL = { proposed: '제안됨', confirmed: '확정', rejected: '기각됨' };
const DM_ORIGIN_LABEL = { human: '사람', agent: 'AI' };
const DEBT_STATUS_LABEL = { open: '열림', ack: '확인함', resolved: '해결됨', dismissed: '무시함' };
const DEBT_STATUSES = ['open', 'ack', 'resolved', 'dismissed'];
const OP_LABEL = { insert: '추가', update: '수정', reassign: '이동', merge: '병합', drift: '드리프트', restore: '되돌림', rename: '이름변경', remove: '제거', revive: '복원', retomb: '경로해제' };

const dmApi = {
  domains: (repo) => api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/domains'),
  projects: (repo) => api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/projects'),
  detail: (repo, id) => api('/api/ui/domainmap/' + encodeURIComponent(repo) + '/domain/' + encodeURIComponent(id)),
  debts: (repo) => api('/api/ui/domainmap/debts?repo=' + encodeURIComponent(repo)),
  history: (repo) => api('/api/ui/domainmap/history?repo=' + encodeURIComponent(repo) + '&limit=80'),
  post: (path, body) => api('/api/ui/domainmap' + path, { method: 'POST', body: JSON.stringify(body || {}) }),
};

// 상태 점(6px)+무채 라벨 — domainmap status 용.
function dmStatusChip(status) {
  const cls = status === 'confirmed' ? ' ok' : status === 'rejected' ? ' dim' : '';
  return el('span', { class: 'st' + cls, text: DM_STATE_LABEL[status] || status });
}
function debtStatusChip(status) {
  const cls = status === 'resolved' ? ' ok' : status === 'dismissed' ? ' dim' : status === 'open' ? ' warn' : '';
  return el('span', { class: 'st' + cls, text: DEBT_STATUS_LABEL[status] || status });
}
// 이력 diff 값 국문화 — 상태/원천만 번역, 그 외 원문(객체는 JSON).
function dmDiffValue(key, v) {
  if (v == null) return '—';
  if (key === 'status') return DM_STATE_LABEL[v] || DEBT_STATUS_LABEL[v] || String(v);
  if (key === 'origin') return DM_ORIGIN_LABEL[v] || String(v);
  if (typeof v === 'boolean') return v ? '예' : '아니요';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

let dmKeyHandler = null; // 도메인 페이지 전역 키보드(j/k/Enter/x) — 페이지 이탈 시 자가 해제

async function renderDomains(view, domainId, params) {
  let repos;
  try {
    repos = await getRepos();
  } catch (e) {
    if (e.status === 401) return;
    view.replaceChildren(errorNote(e, 'domainmap에 연결하지 못했습니다. 서비스 상태를 확인하세요'));
    return;
  }
  const repoList = repos.repos || [];
  if (repos.domainmapError) {
    const retryBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '다시 시도' });
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      try { await getRepos(true); } catch (_) { /* 아래 renderDomains 가 에러 표시 */ }
      renderDomains(view, domainId, params);
    });
    view.replaceChildren(
      el('div', { class: 'note', text: repos.domainmapError + ' 서비스 상태를 확인하세요.' }),
      el('div', { style: 'margin-top:12px' }, retryBtn),
    );
    return;
  }
  if (!repoList.length) {
    view.replaceChildren(el('div', { class: 'empty', text: '등록된 레포가 없습니다. domainmap에 레포를 먼저 추가하세요.' }));
    return;
  }

  // repo 결정: ?repo= 파라미터 > 기억된 선택 > 첫 레포. 딥링크(#/domains/:id)는 영역 섹션 강제.
  const wantRepo = params && params.get('repo');
  if (wantRepo && repoList.includes(wantRepo)) state.domainsRepo = wantRepo;
  if (!state.domainsRepo || !repoList.includes(state.domainsRepo)) state.domainsRepo = repoList[0] || '';
  const dm = state.dm;
  if (domainId) { dm.selectedId = Number(domainId); dm.section = 'areas'; }

  // ── 페이지 골격: repo 셀렉터 + 섹션 탭 + 콘텐츠 ──
  const pills = el('div', { class: 'repo-pills' });
  for (const r of repoList) {
    const pill = el('button', { class: 'repo-pill' + (r === state.domainsRepo ? ' on' : ''), text: r });
    pill.addEventListener('click', () => {
      if (state.domainsRepo === r) return;
      state.domainsRepo = r;
      dm.selectedId = null; dm.cursor = -1; dm.rows = [];
      history.replaceState(null, '', '#/domains?repo=' + encodeURIComponent(r));
      for (const p of pills.children) p.classList.toggle('on', p.textContent === r);
      renderSection();
    });
    pills.append(pill);
  }
  const SECTIONS = [['areas', '영역'], ['projects', '프로젝트'], ['debts', '이슈'], ['history', '변경 이력']];
  const tabs = el('div', { class: 'seg-tabs', role: 'tablist' });
  for (const [key, label] of SECTIONS) {
    const b = el('button', { class: key === dm.section ? 'on' : '', role: 'tab', 'aria-selected': String(key === dm.section), text: label });
    b.addEventListener('click', () => {
      dm.section = key;
      for (const t of tabs.children) {
        t.classList.toggle('on', t === b);
        t.setAttribute('aria-selected', String(t === b));
      }
      renderSection();
    });
    tabs.append(b);
  }
  const content = el('div', {});
  view.replaceChildren(pills, tabs, content);
  applyReveal([pills, tabs, content]);

  const loading = (msg) => el('div', { class: 'skel-stack', style: 'margin-top:16px' },
    el('div', { class: 'skel', style: 'min-height:180px' }),
    el('div', { class: 'loading-caption', text: msg }));
  const dmError = (e, retry) => {
    const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:10px', text: '다시 시도' });
    btn.addEventListener('click', retry);
    return el('div', { style: 'margin-top:16px' },
      el('div', { class: 'note', text: 'domainmap에 연결하지 못했습니다 — ' + (e && e.message || '알 수 없는 오류') + '. 서비스 상태를 확인하세요.' }), btn);
  };

  function renderSection() {
    dm.cursor = -1; dm.rows = [];
    if (dm.section === 'projects') return renderProjectsSec();
    if (dm.section === 'debts') return renderDebtsSec();
    if (dm.section === 'history') return renderHistorySec();
    return renderAreasSec();
  }

  // ════════ 영역 섹션 (two-pane) ════════
  async function renderAreasSec() {
    content.replaceChildren(loading('영역 불러오는 중…'));
    let domains;
    try { domains = await dmApi.domains(state.domainsRepo); }
    catch (e) { if (e.status === 401) return; content.replaceChildren(dmError(e, renderAreasSec)); return; }
    domains = Array.isArray(domains) ? domains : [];

    const filters = el('div', { class: 'dm-filters', role: 'group', 'aria-label': '영역 필터' });
    const listBox = el('div', { class: 'list-box' });
    const detailPane = el('div', { class: 'split-detail' });
    const hint = el('div', { class: 'kbd-hint', text: '↑↓ 영역 이동 · j/k 행 이동 · Enter 확인 · x 제외' });
    content.replaceChildren(
      el('div', { class: 'split' },
        el('div', { class: 'split-list' }, filters, listBox, hint),
        detailPane));

    // '확인 필요' = status proposed 이거나 proposed 매핑 보유(구 UI 식 그대로), '이슈' = debts>0.
    const needReview = (d) => d.status === 'proposed' || (d.proposed || 0) > 0;
    const counts = {
      all: domains.length,
      review: domains.filter(needReview).length,
      issues: domains.filter((d) => (d.debts || 0) > 0).length,
    };
    for (const [key, label] of [['all', '전체'], ['review', '확인 필요'], ['issues', '이슈']]) {
      const b = el('button', { class: key === dm.filter ? 'on' : '', 'aria-pressed': String(key === dm.filter), text: label + ' ' + counts[key] });
      b.addEventListener('click', () => {
        dm.filter = key;
        for (const x of filters.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
        renderList();
      });
      filters.append(b);
    }

    function visibleDomains() {
      if (dm.filter === 'review') return domains.filter(needReview);
      if (dm.filter === 'issues') return domains.filter((d) => (d.debts || 0) > 0);
      return domains;
    }

    function areaRow(d) {
      const row = el('div', { class: 'row' + (Number(dm.selectedId) === Number(d.id) ? ' sel' : ''), role: 'link', tabindex: '0', 'data-did': d.id },
        el('div', { class: 'dm-row' },
          el('span', { class: 'dot6' + (d.status === 'confirmed' ? ' ok' : ''), 'aria-hidden': 'true' }),
          el('span', { class: 'nm', text: d.name || d.key }),
          el('span', { class: 'mono', text: d.key })),
        // '제안 N' = 확인 필요 필터에 걸린 이유 노출(확정 영역도 proposed 매핑이 있으면 포함되므로).
        el('div', { class: 'dm-counts', text: '코드 ' + fmtNum(d.units) + ' · 데이터 ' + fmtNum(d.entities) + ' · 이슈 ' + fmtNum(d.debts) + ((d.proposed || 0) > 0 ? ' · 제안 ' + fmtNum(d.proposed) : '') }),
      );
      const go = () => selectArea(d.id);
      row.addEventListener('click', go);
      // 매핑 커서 활성 중엔 Enter 를 전역 핸들러(installKeys)에 양보 — 커서 행 '확인'이 우선(힌트 문구와 일치).
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (dm.cursor >= 0) return; go(); } });
      return row;
    }

    function renderList() {
      const vis = visibleDomains();
      listBox.replaceChildren();
      if (!vis.length) {
        const msg = dm.filter === 'review' ? '확인할 제안이 없습니다 — 모든 영역이 확정 상태입니다.'
          : dm.filter === 'issues' ? '열린 이슈가 없습니다.'
          : '아직 영역이 없습니다. domain-map 스캔을 먼저 실행하세요.';
        listBox.append(el('div', { class: 'empty', text: msg }));
        return;
      }
      const core = vis.filter((d) => !d.cross_cutting);
      const cross = vis.filter((d) => d.cross_cutting);
      if (core.length) {
        listBox.append(el('div', { class: 'dm-group-head', text: '핵심 영역' }));
        for (const d of core) listBox.append(areaRow(d));
      }
      if (cross.length) {
        listBox.append(el('div', { class: 'dm-group-head', text: '지원 영역' }));
        for (const d of cross) listBox.append(areaRow(d));
      }
    }

    function selectArea(id) {
      dm.selectedId = Number(id);
      dm.cursor = -1; dm.rows = [];
      history.replaceState(null, '', '#/domains/' + id + '?repo=' + encodeURIComponent(state.domainsRepo));
      for (const r of listBox.querySelectorAll('.row')) r.classList.toggle('sel', Number(r.dataset.did) === Number(id));
      loadDetail(id);
    }

    // 좌측 카운트만 재계산(매핑 op 후) — 목록 DOM 재구축하되 스크롤 보존.
    async function refreshListCounts() {
      try {
        const fresh = await dmApi.domains(state.domainsRepo);
        if (Array.isArray(fresh)) {
          domains = fresh;
          const sc = listBox.scrollTop;
          counts.all = domains.length;
          counts.review = domains.filter(needReview).length;
          counts.issues = domains.filter((d) => (d.debts || 0) > 0).length;
          const labels = ['전체 ' + counts.all, '확인 필요 ' + counts.review, '이슈 ' + counts.issues];
          [...filters.children].forEach((b, i) => { b.textContent = labels[i]; });
          renderList();
          listBox.scrollTop = sc;
        }
      } catch (_) { /* 카운트 갱신 실패는 치명 아님 */ }
    }

    // ── 우측 상세 ──
    async function loadDetail(id) {
      detailPane.replaceChildren(el('div', { class: 'skel', style: 'min-height:200px' }), el('div', { class: 'loading-caption', text: '영역 불러오는 중…' }));
      let data;
      try { data = await dmApi.detail(state.domainsRepo, id); }
      catch (e) {
        if (e.status === 401) return;
        detailPane.replaceChildren(el('div', { class: 'detail-card' }, errorNote(e, '영역을 불러오지 못했습니다')));
        return;
      }
      renderDetail(data);
    }

    function renderDetail(data) {
      const d = data.domain;
      const card = el('div', { class: 'detail-card' });
      dm.rows = []; dm.cursor = -1;

      // 헤더 + 서술.
      card.append(el('div', {},
        el('h3', { class: 'detail-title', text: d.name || d.key }),
        el('div', { class: 'detail-meta' },
          el('span', { class: 'mono', text: d.key }),
          dmStatusChip(d.status),
          d.cross_cutting ? el('span', { class: 'caption', text: '지원 영역' }) : null),
        d.description ? el('p', { class: 'body-text', style: 'margin-top:10px', text: d.description }) : null,
      )); // el() 경유 — null 자식 스킵

      // 액션 — [확인] = 이 화면 유일한 채운 primary(확정이면 숨김), 나머지 전부 ghost.
      const actions = el('div', { class: 'dm-actions' });
      if (d.status !== 'confirmed') {
        const okBtn = el('button', { class: 'btn btn-primary btn-sm', text: '확인' });
        okBtn.addEventListener('click', async () => {
          okBtn.disabled = true;
          try {
            const r = await dmApi.post('/domain/' + d.id + '/confirm', {});
            toast('영역을 확정했습니다', false, { changeId: r.change_id, onUndone: () => { refreshListCounts(); loadDetail(d.id); } });
            refreshListCounts();
            loadDetail(d.id);
          } catch (e) { okBtn.disabled = false; toast('확정 실패 — ' + e.message, true); }
        });
        actions.append(okBtn);
      }
      const editBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '수정' });
      const editSlot = el('div', {});
      editBtn.addEventListener('click', () => {
        if (editSlot.firstChild) { editSlot.replaceChildren(); return; }
        editSlot.replaceChildren(buildEditForm(d));
      });
      actions.append(editBtn);
      // 다른 영역에 합치기 — select(타 영역), 선택 시 confirm() 후 merge.
      const others = domains.filter((x) => Number(x.id) !== Number(d.id));
      if (others.length) {
        const mergeSel = el('select', { 'aria-label': '다른 영역에 합치기' },
          el('option', { value: '', text: '다른 영역에 합치기…' }),
          others.map((x) => el('option', { value: x.id, text: (x.name || x.key) + ' (' + x.key + ')' })));
        mergeSel.addEventListener('change', async () => {
          const into = mergeSel.value;
          if (!into) return;
          const target = others.find((x) => String(x.id) === String(into));
          if (!window.confirm('"' + (d.name || d.key) + '" 영역을 "' + (target.name || target.key) + '"에 합칠까요? 매핑이 모두 이동합니다.')) {
            mergeSel.value = ''; return;
          }
          mergeSel.disabled = true;
          try {
            const r = await dmApi.post('/domain/merge', { fromId: Number(d.id), intoId: Number(into) });
            toast('영역을 합쳤습니다 — 이동 ' + fmtNum(r.moved_mappings) + ' · 중복 제외 ' + fmtNum(r.folded_mappings), false,
              { changeId: r.change_id, onUndone: () => renderAreasSec() });
            dm.selectedId = Number(into);
            renderAreasSec();
          } catch (e) { mergeSel.disabled = false; mergeSel.value = ''; toast('합치기 실패 — ' + e.message, true); }
        });
        actions.append(mergeSel);
      }
      card.append(actions, editSlot);

      function buildEditForm(dom) {
        const nameIn = el('input', { type: 'text', value: dom.name || '', 'aria-label': '영역 이름' });
        const descTa = el('textarea', { rows: '3', 'aria-label': '영역 서술' });
        descTa.value = dom.description || '';
        const ccCb = el('input', { type: 'checkbox', 'aria-label': '지원 영역(cross-cutting)' });
        ccCb.checked = !!dom.cross_cutting;
        const saveBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '저장' });
        const cancelBtn = el('button', { class: 'btn-text', text: '취소' });
        cancelBtn.addEventListener('click', () => editSlot.replaceChildren());
        saveBtn.addEventListener('click', async () => {
          const name = nameIn.value.trim();
          if (!name) { toast('이름을 입력하세요', true); return; }
          saveBtn.disabled = true;
          try {
            const r = await dmApi.post('/domain/' + dom.id + '/edit', { name, description: descTa.value, crossCutting: ccCb.checked });
            toast('저장했습니다 — 영역이 확정 처리되었습니다', false, { changeId: r.change_id, onUndone: () => { refreshListCounts(); loadDetail(dom.id); } });
            refreshListCounts();
            loadDetail(dom.id);
          } catch (e) { saveBtn.disabled = false; toast('저장 실패 — ' + e.message, true); }
        });
        return el('div', { class: 'dm-edit' },
          el('label', { class: 'fld' }, '이름', nameIn),
          el('label', { class: 'fld' }, '서술', descTa),
          el('div', { class: 'frow' },
            el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-sub)' }, ccCb, '지원 영역(cross-cutting)'),
            saveBtn, cancelBtn),
          el('p', { class: 'caption', text: '저장하면 이 영역은 확정 처리됩니다.' }), // auto-confirm 정직 노출
        );
      }

      // ── 매핑 행(코드 유닛/데이터 엔티티 공용) ──
      function mappingRow(rowData, kind) {
        const m = rowData.mapping || {};
        const removed = rowData.state === 'removed';
        const label = kind === 'code' ? (rowData.path || rowData.label) : (rowData.name || rowData.label);
        // 주의: DOM .append(null) 은 'null' 텍스트가 되므로 조건부 자식은 el() 경유(널 스킵).
        const row = el('div', { class: 'maprow' + (removed ? ' removed' : '') },
          el('span', { class: 'mono', text: label }),
          removed ? el('span', { class: 'meta', text: '삭제됨' }) : null,
          el('span', { class: 'meta', text: rowData.kind + (kind === 'data' && rowData.source ? ' · ' + rowData.source : '') }),
          dmStatusChip(m.status),
          m.confidence != null ? el('span', { class: 'conf', text: '신뢰도 ' + Math.round(Number(m.confidence) * 100) + '%' }) : null,
          el('span', { class: 'meta', text: DM_ORIGIN_LABEL[m.origin] || m.origin || '' }),
        );
        const acts = el('span', { style: 'display:inline-flex;gap:6px;align-items:center' });
        const doOp = async (op, label2) => {
          try {
            const r = await dmApi.post('/mapping/' + m.id + '/' + op, {});
            // 낙관적 갱신: 이 행만 교체(전체 refetch 금지 — 포커스·스크롤 보존).
            m.status = op === 'reject' ? 'rejected' : 'confirmed';
            m.origin = 'human';
            const fresh = mappingRow(rowData, kind);
            const i = dm.rows.findIndex((x) => x.el === row);
            if (i >= 0) { dm.rows[i].el = fresh; if (dm.cursor === i) fresh.classList.add('cur'); }
            row.replaceWith(fresh);
            toast(label2, false, { changeId: r.change_id, onUndone: () => loadDetail(d.id) });
            refreshListCounts();
          } catch (e) { toast('실패 — ' + e.message, true); }
        };
        if (m.status === 'proposed') {
          const ok = el('button', { class: 'btn btn-ghost btn-sm', text: '확인' });
          ok.addEventListener('click', () => doOp('confirm', '매핑을 확정했습니다'));
          const no = el('button', { class: 'btn btn-ghost btn-sm', text: '제외' });
          no.addEventListener('click', () => doOp('reject', '매핑을 제외했습니다'));
          acts.append(ok, no);
        } else if (m.status === 'rejected') {
          const re = el('button', { class: 'btn btn-ghost btn-sm', text: '다시 확인' });
          re.addEventListener('click', () => doOp('confirm', '매핑을 다시 확정했습니다'));
          acts.append(re);
        }
        if (others.length) {
          const moveSel = el('select', { 'aria-label': '영역 이동(이동하면 확정됩니다)', title: '이동하면 확정됩니다' },
            el('option', { value: '', text: '영역 이동…' }),
            others.map((x) => el('option', { value: x.id, text: x.name || x.key })));
          moveSel.addEventListener('change', async () => {
            const to = moveSel.value;
            if (!to) return;
            moveSel.disabled = true;
            try {
              const r = await dmApi.post('/mapping/' + m.id + '/move', { domainId: Number(to) });
              toast('이동했습니다(확정 전이)', false, { changeId: r.change_id, onUndone: () => loadDetail(d.id) });
              // 이동 = 이 영역에서 사라짐 — 행 제거 + 커서 시퀀스에서 빼고 좌측 카운트 갱신.
              const i = dm.rows.findIndex((x) => x.el === row);
              if (i >= 0) { dm.rows.splice(i, 1); if (dm.cursor >= dm.rows.length) dm.cursor = dm.rows.length - 1; }
              row.remove();
              refreshListCounts();
            } catch (e) { moveSel.disabled = false; moveSel.value = ''; toast('이동 실패 — ' + e.message, true); }
          });
          acts.append(moveSel);
        }
        row.append(acts);
        return row;
      }

      const cu = data.code_units || [];
      card.append(el('div', { class: 'sec-label', text: '코드 유닛 (' + cu.length + ')' }));
      const cuBox = el('div', { class: 'map-sec' });
      if (!cu.length) cuBox.append(el('p', { class: 'caption', text: '매핑된 코드 유닛이 없습니다.' }));
      for (const r of cu) { const node = mappingRow(r, 'code'); dm.rows.push({ el: node, data: r }); cuBox.append(node); }
      card.append(cuBox);

      const de = data.data_entities || [];
      card.append(el('div', { class: 'sec-label', text: '데이터 엔티티 (' + de.length + ')' }));
      const deBox = el('div', { class: 'map-sec' });
      if (!de.length) deBox.append(el('p', { class: 'caption', text: '매핑된 데이터 엔티티가 없습니다.' }));
      for (const r of de) { const node = mappingRow(r, 'data'); dm.rows.push({ el: node, data: r }); deBox.append(node); }
      card.append(deBox);

      // 이슈(이 영역의 코드 경로를 인용하는 debts).
      const debts = data.debts || [];
      card.append(el('div', { class: 'sec-label', text: '이슈 (' + debts.length + ')' }));
      if (!debts.length) card.append(el('p', { class: 'caption', text: '이 영역을 인용하는 이슈가 없습니다.' }));
      else {
        const dBox = el('div', { class: 'list-box', style: 'margin-top:4px' });
        for (const dt of debts) dBox.append(debtRow(dt, () => loadDetail(d.id)));
        card.append(dBox, el('p', { class: 'caption', style: 'margin-top:6px', text: '이슈는 레포 단위 — 다른 영역에도 나타날 수 있습니다.' }));
      }

      detailPane.replaceChildren(card);
    }

    renderList();
    // 키보드: ↑↓ = 영역 목록(목록엔 j/k 도 허용 — 단 상세 커서 활성 시 행 우선), j/k = 매핑 행 커서, Enter/x = 행 액션.
    installKeys({
      moveArea: (dir) => {
        const rows = [...listBox.querySelectorAll('.row')];
        if (!rows.length) return;
        const idx = rows.findIndex((r) => r.classList.contains('sel'));
        const next = rows[Math.max(0, Math.min(rows.length - 1, (idx < 0 ? 0 : idx + dir)))];
        if (next && Number(next.dataset.did) !== Number(dm.selectedId)) {
          selectArea(next.dataset.did);
          next.scrollIntoView({ block: 'nearest' });
        }
      },
      moveCursor: (dir) => {
        if (!dm.rows.length) return;
        const next = dm.cursor < 0 ? (dir > 0 ? 0 : dm.rows.length - 1) : Math.max(0, Math.min(dm.rows.length - 1, dm.cursor + dir));
        if (dm.cursor >= 0 && dm.rows[dm.cursor]) dm.rows[dm.cursor].el.classList.remove('cur');
        dm.cursor = next;
        const cur = dm.rows[dm.cursor].el;
        cur.classList.add('cur');
        cur.scrollIntoView({ block: 'nearest' });
      },
      enter: () => {
        const r = dm.rows[dm.cursor];
        if (!r) return;
        const st = r.data.mapping && r.data.mapping.status;
        const btns = [...r.el.querySelectorAll('button')];
        const target = btns.find((b) => b.textContent === '확인' || b.textContent === '다시 확인');
        if ((st === 'proposed' || st === 'rejected') && target) target.click();
      },
      exclude: () => {
        const r = dm.rows[dm.cursor];
        if (!r) return;
        const st = r.data.mapping && r.data.mapping.status;
        const target = [...r.el.querySelectorAll('button')].find((b) => b.textContent === '제외');
        if (st === 'proposed' && target) target.click();
      },
    });

    if (dm.selectedId && domains.some((x) => Number(x.id) === Number(dm.selectedId))) loadDetail(dm.selectedId);
    else {
      dm.selectedId = null;
      detailPane.replaceChildren(el('div', { class: 'detail-card' },
        el('p', { class: 'empty', text: '왼쪽 목록에서 영역을 선택하세요.' })));
    }
  }

  // 전역 키 리스너 1개 — input/textarea/select/contentEditable 포커스 가드(구 UI 가드 복제),
  // 도메인 뷰가 DOM 에서 사라지면 자가 해제.
  function installKeys(h) {
    if (dmKeyHandler) { document.removeEventListener('keydown', dmKeyHandler); dmKeyHandler = null; }
    const onKey = (e) => {
      if (!document.body.contains(content)) {
        document.removeEventListener('keydown', onKey);
        if (dmKeyHandler === onKey) dmKeyHandler = null;
        return;
      }
      const t = e.target;
      if (t && (t.matches && t.matches('input, textarea, select') || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (dm.section !== 'areas') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); h.moveArea(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); h.moveArea(-1); }
      else if (e.key === 'j') { e.preventDefault(); if (dm.rows.length) h.moveCursor(1); else h.moveArea(1); }
      else if (e.key === 'k') { e.preventDefault(); if (dm.rows.length) h.moveCursor(-1); else h.moveArea(-1); }
      else if (e.key === 'Enter' && dm.cursor >= 0) { e.preventDefault(); h.enter(); }
      else if (e.key === 'x' && dm.cursor >= 0) { e.preventDefault(); h.exclude(); }
    };
    dmKeyHandler = onKey;
    document.addEventListener('keydown', onKey);
  }

  // ── 이슈(debt) 행 — 상세/이슈 섹션 공용 ──
  function debtRow(dt, onChanged) {
    const sel = el('select', { 'aria-label': '이슈 상태' },
      DEBT_STATUSES.map((s) => el('option', { value: s, text: DEBT_STATUS_LABEL[s] })));
    sel.value = dt.status;
    const chipSlot = el('span', {}, debtStatusChip(dt.status));
    sel.addEventListener('change', async () => {
      const prev = dt.status;
      const next = sel.value;
      sel.disabled = true;
      // 낙관적 갱신 — 실패 시 원복.
      dt.status = next;
      chipSlot.replaceChildren(debtStatusChip(next));
      try {
        const r = await dmApi.post('/debt/' + dt.id + '/status', { status: next });
        toast('이슈 상태를 변경했습니다 — ' + DEBT_STATUS_LABEL[next], false, { changeId: r.change_id, onUndone: onChanged });
        sel.disabled = false;
      } catch (e) {
        dt.status = prev;
        sel.value = prev;
        chipSlot.replaceChildren(debtStatusChip(prev));
        sel.disabled = false;
        toast('상태 변경 실패 — ' + e.message, true);
      }
    });
    const refs = Array.isArray(dt.cited_refs) ? dt.cited_refs : [];
    return el('div', { class: 'debt-row' },
      el('div', { class: 'debt-head' },
        el('span', { class: 'caption', text: dt.kind || '' }),
        el('span', { class: 'debt-title', text: dt.title || '(제목 없음)' }),
        chipSlot, sel,
        el('span', { class: 'caption', text: DM_ORIGIN_LABEL[dt.origin] || dt.origin || '' })),
      dt.detail ? el('p', { class: 'debt-detail', text: dt.detail }) : null,
      refs.length ? el('div', { class: 'debt-refs' },
        refs.map((rf) => el('span', { class: 'mono', text: typeof rf === 'string' ? rf : (rf && rf.path) || JSON.stringify(rf) }))) : null,
    );
  }

  // ════════ 프로젝트 섹션 ════════
  async function renderProjectsSec() {
    content.replaceChildren(loading('프로젝트 불러오는 중…'));
    let projects;
    try { projects = await dmApi.projects(state.domainsRepo); }
    catch (e) { if (e.status === 401) return; content.replaceChildren(dmError(e, renderProjectsSec)); return; }
    projects = Array.isArray(projects) ? projects : [];
    if (!projects.length) {
      content.replaceChildren(el('div', { class: 'empty', text: '등록된 프로젝트가 없습니다.' }));
      return;
    }
    const box = el('div', { class: 'list-box' });
    for (const p of projects) {
      const period = p.started_at ? String(p.started_at).slice(0, 10) + ' — ' + (p.ended_at ? String(p.ended_at).slice(0, 10) : '') : '';
      const row = el('div', { class: 'row', style: 'cursor:default' },
        el('div', { class: 'dm-row' },
          el('span', { class: 'dot6' + (p.status === 'confirmed' ? ' ok' : ''), 'aria-hidden': 'true' }),
          el('span', { class: 'nm', text: p.name || p.key }),
          el('span', { class: 'mono', text: p.key }),
          p.kind ? el('span', { class: 'caption', text: p.kind }) : null,
          dmStatusChip(p.status)),
        el('div', { class: 'dm-counts' },
          '코드 ' + fmtNum(p.touched_code) + ' · 데이터 ' + fmtNum(p.touched_entities) + (period ? ' · ' + period : '')),
        p.description ? el('p', { class: 'debt-detail', text: p.description }) : null,
      );
      if (p.status === 'proposed') {
        const ok = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:8px', text: '확인' });
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          try {
            const r = await dmApi.post('/project/' + p.id + '/confirm', {});
            p.status = 'confirmed';
            row.querySelector('.dot6').classList.add('ok');
            row.querySelector('.st').replaceWith(dmStatusChip('confirmed'));
            ok.remove();
            toast('프로젝트를 확정했습니다', false, { changeId: r.change_id, onUndone: () => renderProjectsSec() });
          } catch (e) { ok.disabled = false; toast('확정 실패 — ' + e.message, true); }
        });
        row.append(ok);
      }
      box.append(row);
    }
    content.replaceChildren(box);
  }

  // ════════ 이슈 섹션(레포 전체) ════════
  async function renderDebtsSec() {
    content.replaceChildren(loading('이슈 불러오는 중…'));
    let debts;
    try { debts = await dmApi.debts(state.domainsRepo); }
    catch (e) { if (e.status === 401) return; content.replaceChildren(dmError(e, renderDebtsSec)); return; }
    debts = Array.isArray(debts) ? debts : [];
    if (!debts.length) {
      content.replaceChildren(el('div', { class: 'empty', text: '열린 이슈가 없습니다.' }));
      return;
    }
    const box = el('div', { class: 'list-box' });
    for (const dt of debts) box.append(debtRow(dt, () => renderDebtsSec()));
    content.replaceChildren(box);
  }

  // ════════ 변경 이력 섹션 ════════
  async function renderHistorySec() {
    content.replaceChildren(loading('변경 이력 불러오는 중…'));
    let rows;
    try { rows = await dmApi.history(state.domainsRepo); }
    catch (e) { if (e.status === 401) return; content.replaceChildren(dmError(e, renderHistorySec)); return; }
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) {
      content.replaceChildren(el('div', { class: 'empty', text: '변경 이력이 없습니다. 첫 큐레이션이 여기에 기록됩니다.' }));
      return;
    }
    const box = el('div', { class: 'list-box' });
    for (const r of rows) {
      const who = r.actor_type === 'human' ? (r.actor_id || '사람') : 'AI';
      const head = el('div', { class: 'hist-head' },
        el('span', { class: 'when', text: relTime(r.at) }),
        el('span', { class: 'who', text: who }),
        el('span', { class: 'op', text: OP_LABEL[r.op] || r.op }),
        el('span', { class: 'mono', text: r.entity_type + '#' + r.entity_id }));
      // 되돌리기 — op==='restore' 행에는 숨김(restore-of-restore 루프 방지, 구 UI 동일).
      if (r.op !== 'restore') {
        const undoBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '되돌리기' });
        undoBtn.addEventListener('click', async () => {
          undoBtn.disabled = true;
          try {
            await dmApi.post('/restore/' + r.id, {});
            toast('되돌렸습니다');
            renderHistorySec();
          } catch (e) {
            undoBtn.disabled = false;
            toast('되돌리지 못했습니다 — ' + e.message, true); // 400 메시지 보존, 재시도 없음
          }
        });
        head.append(undoBtn);
      }
      const rowEl = el('div', { class: 'hist-row' }, head);
      if (r.note) rowEl.append(el('div', { class: 'hist-note', text: r.note }));
      // 변경 키만의 before→after 미니 diff.
      const before = r.before && typeof r.before === 'object' ? r.before : null;
      const after = r.after && typeof r.after === 'object' ? r.after : null;
      if (before || after) {
        // '변경 키만': 양쪽 다 있으면 after 의 키만(restore 의 before=전체 스냅샷 노이즈 차단),
        // insert(before=null)/delete(after=null)는 있는 쪽 키 전부.
        const baseKeys = before && after ? Object.keys(after) : Object.keys(after || before || {});
        const keys = baseKeys
          .filter((k) => JSON.stringify(before && before[k]) !== JSON.stringify(after && after[k]));
        if (keys.length) {
          rowEl.append(el('div', { class: 'hist-diff' }, keys.map((k) => el('div', {},
            el('span', { class: 'k', text: k + ' ' }),
            dmDiffValue(k, before && before[k]),
            el('span', { class: 'arrow', text: ' → ' }),
            dmDiffValue(k, after && after[k])))));
        }
      }
      box.append(rowEl);
    }
    content.replaceChildren(box);
  }

  renderSection();
}

// ── 라우터 ──
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const qIdx = h.indexOf('?');
  const pathPart = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const params = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
  return { segs: pathPart.split('/').filter(Boolean), params };
}

function setActiveTab(name) {
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function route() {
  if (!localStorage.getItem(TOKEN_KEY)) { showGate(); return; }
  const { segs, params } = parseHash();
  const view = $view();
  const page = segs[0] || 'overview';
  try {
    if (page === 'items') {
      setActiveTab('items');
      await renderItems(view, segs[1] || null, params);
    } else if (page === 'inbox') {
      setActiveTab('inbox');
      await renderInbox(view);
    } else if (page === 'domains') {
      setActiveTab('domains');
      await renderDomains(view, segs[1] || null, params);
    } else if (page === 'admin') {
      setActiveTab('admin');
      await renderAdmin(view, segs[1] || null);
    } else {
      setActiveTab('overview');
      await renderOverview(view);
    }
  } catch (e) {
    if (e && e.status === 401) return;
    view.replaceChildren(errorNote(e, '페이지를 불러오지 못했습니다'));
  }
}
window.addEventListener('hashchange', route);

// ── 부팅 ──
async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showGate(); return; }
  try {
    state.me = await api('/api/ui/me');
  } catch (e) {
    if (e.status === 401) return; // api() 가 게이트 표시
    showGate('서버에 연결하지 못했습니다 — ' + e.message);
    return;
  }
  hideGate();
  document.getElementById('user-email').textContent = state.me.email || state.me.userId || '';
  // admin scope 보유자에게만 '관리' 탭 노출(서버가 1차 게이트 — UI 는 2차 가시성).
  const adminTab = document.getElementById('admin-tab');
  if (adminTab) adminTab.hidden = !(state.me.scopes && state.me.scopes.includes('admin'));
  getStats().catch(() => { /* 싱크 칩만 생략(개요 진입 시 재시도) */ });
  route();
}
boot();

// ════════════════════════════════════════════════════════════════════
// 관리(전달/관리 — workflow-std 흡수). 핵심 원칙: 비개발자가 편집/확인하는 모든 항목 옆에
// '구성원에게 미치는 효과'를 항상 보여준다(meaning 패널). 셸/디자인/라우터는 기존 재사용.
// ════════════════════════════════════════════════════════════════════
const ADMIN_SECTIONS = [
  { key: 'managed-policy', label: '강제 규칙', meaning: 'managed-policy' },
  { key: 'org-defaults', label: '회사 맥락 · 페르소나', meaning: 'org-defaults' },
  { key: 'memory', label: '팀 메모리', meaning: 'memory' },
  { key: 'members', label: '구성원', meaning: 'member' },
  { key: 'profile', label: '조직 · 연결', meaning: 'gateway-url' },
  { key: 'publish', label: '발행 · 배포', meaning: null },
];

async function loadAdmin(force) {
  if (!state.admin.data || force) state.admin.data = await api('/api/ui/org');
  return state.admin.data;
}

function meaningRow(k, v) {
  return el('div', { class: 'meaning-row' },
    el('span', { class: 'meaning-k', text: k }),
    el('span', { class: 'meaning-v', text: v }));
}
// '구성원에게 미치는 효과' 카드 — 의미 인지의 핵심 컴포넌트.
function meaningCard(m) {
  if (!m) return null;
  const tag = { critical: '절대 규칙', identity: '신원 · 매칭', infra: '연결 · 배포', normal: '' }[m.tone] || '';
  return el('div', { class: 'meaning meaning-' + m.tone },
    el('div', { class: 'meaning-head' },
      el('span', { class: 'meaning-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'meaning-title', text: '이 내용이 구성원에게 미치는 효과' }),
      tag ? el('span', { class: 'meaning-tag', text: tag }) : null),
    el('p', { class: 'meaning-what', text: m.what }),
    el('div', { class: 'meaning-grid' },
      meaningRow('누가 받나', m.reach),
      meaningRow('언제 도달', m.when),
      meaningRow('어디에 나타나나', m.where)),
    el('div', { class: 'meaning-ex' },
      el('span', { class: 'meaning-ex-label', text: '예시' }),
      el('span', { text: m.example })));
}

function adminRowMeta(key, data) {
  if (key === 'managed-policy' || key === 'org-defaults') {
    const s = data.sections[key];
    return s && s.body_md && s.body_md.trim() ? '작성됨 · v' + s.version : '비어 있음';
  }
  if (key === 'memory') return data.memory.length + '개 문서';
  if (key === 'members') return data.members.length + '명';
  if (key === 'profile') return data.profile.gateway_url ? '연결됨' : '게이트웨이 미설정';
  if (key === 'publish') return '구성원에게 게시';
  return '';
}

async function renderAdmin(view, sub) {
  if (!(state.me && state.me.scopes && state.me.scopes.includes('admin'))) {
    view.replaceChildren(errorNote(new Error('관리 권한(admin)이 필요합니다'), '접근 불가'));
    return;
  }
  let data;
  try { data = await loadAdmin(); }
  catch (e) { view.replaceChildren(errorNote(e, '관리 데이터를 불러오지 못했습니다')); return; }

  const sel = sub || state.admin.sel || 'managed-policy';
  state.admin.sel = sel;

  const list = el('div', { class: 'split-list card admin-nav' });
  for (const s of ADMIN_SECTIONS) {
    list.append(el('a', { class: 'row' + (s.key === sel ? ' sel' : ''), href: '#/admin/' + s.key },
      el('div', { class: 'row-title', text: s.label }),
      el('div', { class: 'row-meta', text: adminRowMeta(s.key, data) })));
  }
  const detail = el('div', { class: 'split-detail' });
  renderAdminDetail(detail, sel, data);

  view.replaceChildren(el('div', {},
    el('div', { class: 'card-head admin-head' },
      el('h2', { text: '관리 — 전달' }),
      el('span', { class: 'admin-sub', text: (data.profile.display_name || '조직') + ' · 편집은 발행 후 구성원에게 반영됩니다' })),
    el('div', { class: 'split' }, list, detail)));
  applyReveal([list, detail]);
}

function renderAdminDetail(detail, sel, data) {
  if (sel === 'managed-policy' || sel === 'org-defaults') return sectionEditor(detail, sel, data);
  if (sel === 'memory') return memoryEditor(detail, data);
  if (sel === 'members') return membersEditor(detail, data);
  if (sel === 'profile') return profileEditor(detail, data);
  if (sel === 'publish') return publishPanel(detail, data);
}

// ── 섹션(강제규칙·회사맥락) markdown 에디터 ──
function sectionEditor(detail, key, data) {
  const meaning = data.meaning[key];
  const sec = data.sections[key] || { body_md: '', version: 0 };
  const ta = el('textarea', { rows: '18', class: 'admin-ta', 'aria-label': meaning ? meaning.label : key });
  ta.value = sec.body_md || '';
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const r = await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section: key, body_md: ta.value }) });
      data.sections[key] = r.section;
      status.textContent = '저장됨 · v' + r.section.version;
      toast('저장됨 — 발행하면 구성원에게 반영됩니다');
    } catch (e) { toast(e.message, true); status.textContent = ''; }
    saveBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', { text: meaning ? meaning.label : key }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '멤버 미리보기', onclick: showMemberPreview })),
    el('p', { class: 'admin-hint', text: 'markdown 으로 작성하세요. 저장은 초안이고, [발행]해야 구성원이 받습니다.' }),
    ta,
    el('div', { class: 'admin-actions' }, saveBtn, status),
    meaningCard(meaning)));
}

// 멤버가 실제 읽는 컨텍스트 미리보기(WYSIWYG) — 오버레이.
async function showMemberPreview() {
  try {
    const r = await api('/api/ui/org/preview');
    overlay('구성원의 AI가 매 세션 실제로 읽는 내용',
      el('p', { class: 'admin-hint', text: '아래가 모든 구성원의 대화 첫머리에 주입되는 정적 컨텍스트입니다(라이브 현황은 별도로 매 세션 자동 추가).' }),
      el('pre', { class: 'admin-preview', text: r.context || '(비어 있음)' }));
  } catch (e) { toast(e.message, true); }
}

// ── 구성원 ──
function membersEditor(detail, data) {
  const meaning = data.meaning['member'];
  const sel = state.admin.memberSel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 구성원 추가',
    onclick: () => { state.admin.memberSel = '__new__'; renderAdminDetail(detail, 'members', data); } }));
  for (const m of data.members) {
    listCol.append(el('div', { class: 'mini-row' + (m.id === sel ? ' sel' : ''),
      onclick: () => { state.admin.memberSel = m.id; renderAdminDetail(detail, 'members', data); } },
      el('div', { class: 'mini-title', text: (m.display_name || m.id) },
        m.hasToken ? el('span', { class: 'pill pill-ok', text: '설치됨' }) : el('span', { class: 'pill', text: '미설치' })),
      el('div', { class: 'mini-meta', text: (m.kind || 'human') + (m.email ? ' · ' + m.email : '') + ' · 계정 ' + (m.identities ? m.identities.length : 0) })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active' }
    : data.members.find((m) => m.id === sel);
  if (editing) memberForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: '왼쪽에서 구성원을 고르거나 추가하세요.' }), meaningCard(meaning));

  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '구성원' }),
    el('div', { class: 'admin-two' }, listCol, right)));
}

function memberForm(root, m, data, detail, isNew) {
  const idIn = el('input', { type: 'text', value: m.id, placeholder: '아이디(영문/숫자, 예: yoon)', disabled: isNew ? null : '' });
  const nameIn = el('input', { type: 'text', value: m.display_name || '', placeholder: '표시 이름' });
  const emailIn = el('input', { type: 'text', value: m.email || '', placeholder: '대표 이메일(매칭 키)' });
  const kindSel = el('select', {}, ...['human', 'agent', 'system'].map((k) => el('option', { value: k, text: k })));
  kindSel.value = m.kind || 'human';
  const stateSel = el('select', {}, ...['active', 'inactive'].map((k) => el('option', { value: k, text: k === 'active' ? '활성' : '비활성' })));
  stateSel.value = m.state || 'active';
  const bodyTa = el('textarea', { rows: '4', placeholder: '개인 레이어(역할/호칭/담당 — 선택)' });
  bodyTa.value = m.body_md || '';

  // 외부 계정 연결(identities) — 신원 매칭 키. 구조화 행 + 추가/삭제.
  const idnWrap = el('div', { class: 'idn-wrap' });
  const idnRows = [];
  function addIdn(idn) {
    const sysIn = el('input', { type: 'text', value: (idn && idn.system) || '', placeholder: 'slack / discord / notion …', class: 'idn-sys' });
    const extIn = el('input', { type: 'text', value: (idn && idn.external_id) || '', placeholder: '외부 계정 ID', class: 'idn-ext' });
    const emIn = el('input', { type: 'text', value: (idn && idn.email) || '', placeholder: '이메일(선택)', class: 'idn-em' });
    const rm = el('button', { class: 'btn-text', text: '✕', title: '삭제' });
    const row = el('div', { class: 'idn-row' }, sysIn, extIn, emIn, rm);
    const rec = { row, sysIn, extIn, emIn };
    rm.addEventListener('click', () => { row.remove(); const i = idnRows.indexOf(rec); if (i >= 0) idnRows.splice(i, 1); });
    idnRows.push(rec);
    idnWrap.append(row);
  }
  (m.identities || []).forEach(addIdn);

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const identities = idnRows.map((r) => ({ system: r.sysIn.value.trim(), external_id: r.extIn.value.trim(), email: r.emIn.value.trim() || undefined }))
      .filter((x) => x.system && x.external_id);
    const payload = {
      id: idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(),
      email: emailIn.value.trim(), identities, body_md: bodyTa.value, state: stateSel.value,
    };
    if (!payload.id) { toast('아이디는 필수입니다', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
      await loadAdmin(true);
      state.admin.memberSel = payload.id;
      toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
      renderAdminDetail(detail, 'members', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '설치 토큰 발급',
      onclick: () => mintInstallToken(m) }));
    actions.append(el('button', { class: 'btn-text', text: '제거',
      onclick: async () => {
        if (!confirm(`구성원 '${m.display_name || m.id}' 제거?`)) return;
        try { await api('/api/ui/org/member/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) });
          await loadAdmin(true); state.admin.memberSel = null; toast('제거됨'); renderAdminDetail(detail, 'members', state.admin.data); }
        catch (e) { toast(e.message, true); }
      } }));
  }

  root.replaceChildren(
    field('아이디', idIn), field('표시 이름', nameIn), field('종류', kindSel),
    field('대표 이메일', emailIn), field('상태', stateSel),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '외부 계정 연결 (신원 매칭 키)' }), idnWrap,
      el('button', { class: 'btn-text', text: '+ 계정 추가', onclick: () => addIdn(null) })),
    field('개인 레이어', bodyTa),
    actions,
    meaningCard(data.meaning['member']));
}

async function mintInstallToken(m) {
  let adminScope = false;
  const adminChk = el('input', { type: 'checkbox' });
  adminChk.addEventListener('change', () => { adminScope = adminChk.checked; });
  const out = el('div', {});
  const go = el('button', { class: 'btn btn-primary', text: '토큰 발급' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const scopes = adminScope ? ['items', 'context', 'admin'] : ['items', 'context'];
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, email: m.email || undefined, scopes, label: m.display_name || m.id }) });
      const origin = window.location.origin;
      const cmd = `curl -fsSL -H "Authorization: Bearer ${r.token}" ${origin}/install -o /tmp/lively.tgz \\\n  && mkdir -p /tmp/lively-setup && tar -xzf /tmp/lively.tgz -C /tmp/lively-setup \\\n  && LIVELY_TOKEN=${r.token} bash /tmp/lively-setup/setup/setup-mac.sh`;
      out.replaceChildren(
        el('p', { class: 'admin-hint', text: '아래 한 줄을 구성원에게 전달하세요(터미널에 붙여넣기). 토큰은 지금만 보입니다 — 안전 채널로 전달.' }),
        el('pre', { class: 'admin-preview', text: cmd }),
        copyButton(() => cmd, '명령 복사'),
        el('div', { class: 'admin-status', text: 'scope: ' + r.scopes.join(', ') }));
      await loadAdmin(true);
    } catch (e) { toast(e.message, true); go.disabled = false; }
  });
  overlay(`'${m.display_name || m.id}' 설치 토큰 발급`,
    el('p', { class: 'admin-hint', text: '발급하면 이 구성원이 한 줄 명령으로 설치합니다(git 불필요). 토큰은 발급 직후 1회만 표시됩니다.' }),
    el('label', { class: 'admin-check' }, adminChk, ' 관리자 권한(admin)도 포함'),
    el('p', { class: 'admin-warn', text: '⚠ 관리자 권한은 조직 전체 설정·구성원 데이터를 편집할 수 있습니다 — 신뢰하는 사람에게만 부여하세요.' }),
    go, out);
}

// ── 팀 메모리 ──
function memoryEditor(detail, data) {
  const sel = state.admin.memorySel;
  const listCol = el('div', { class: 'admin-sublist' });
  listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ 메모리 추가',
    onclick: () => { state.admin.memorySel = '__new__'; renderAdminDetail(detail, 'memory', data); } }));
  for (const mem of data.memory) {
    listCol.append(el('div', { class: 'mini-row' + (mem.name === sel ? ' sel' : ''),
      onclick: () => { state.admin.memorySel = mem.name; renderAdminDetail(detail, 'memory', data); } },
      el('div', { class: 'mini-title', text: (mem.title || mem.name) }, mem.in_index ? el('span', { class: 'pill pill-ok', text: '인덱스' }) : null),
      el('div', { class: 'mini-meta', text: mem.name })));
  }
  const right = el('div', {});
  const editing = sel === '__new__' ? { name: '', title: '', body_md: '', in_index: true }
    : data.memory.find((x) => x.name === sel);
  if (editing) memoryForm(right, editing, data, detail, sel === '__new__');
  else right.append(el('p', { class: 'admin-hint', text: '팀이 승인한 공식 지식만 둡니다(개인 메모는 각자 로컬).' }), meaningCard(data.meaning['memory']));
  detail.replaceChildren(el('div', { class: 'card' }, el('h2', { text: '팀 메모리' }), el('div', { class: 'admin-two' }, listCol, right)));
}

function memoryForm(root, mem, data, detail, isNew) {
  const nameIn = el('input', { type: 'text', value: mem.name, placeholder: '파일명(예: agent-context-architecture)', disabled: isNew ? null : '' });
  const titleIn = el('input', { type: 'text', value: mem.title || '', placeholder: '제목' });
  const idxChk = el('input', { type: 'checkbox' }); idxChk.checked = mem.in_index !== false;
  const bodyTa = el('textarea', { rows: '12', placeholder: 'markdown 본문' }); bodyTa.value = mem.body_md || '';
  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) { toast('파일명 필수', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/org/memory', { method: 'POST', body: JSON.stringify({ name: nameIn.value.trim(), title: titleIn.value.trim(), in_index: idxChk.checked, body_md: bodyTa.value }) });
      await loadAdmin(true); state.admin.memorySel = nameIn.value.trim(); toast('저장됨');
      renderAdminDetail(detail, 'memory', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });
  const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
    if (!confirm(`메모리 '${mem.title || mem.name}' 제거?`)) return;
    try { await api('/api/ui/org/memory/remove', { method: 'POST', body: JSON.stringify({ name: mem.name }) });
      await loadAdmin(true); state.admin.memorySel = null; toast('제거됨'); renderAdminDetail(detail, 'memory', state.admin.data); }
    catch (e) { toast(e.message, true); }
  } }));
  root.replaceChildren(field('파일명', nameIn), field('제목', titleIn),
    el('label', { class: 'admin-check' }, idxChk, ' 메모리 인덱스(MEMORY.md)에 노출'),
    field('본문', bodyTa), actions, meaningCard(data.meaning['memory']));
}

// ── 조직 · 연결 ──
function profileEditor(detail, data) {
  const p = data.profile;
  const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
  const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const r = await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ display_name: dnIn.value.trim(), gateway_url: gwIn.value.trim() }) });
      data.profile = r.profile; toast('저장됨'); status.textContent = '저장됨';
    } catch (e) { toast(e.message, true); }
    saveBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '조직 · 연결' }),
    field('조직 표시명', dnIn), meaningCard(data.meaning['display_name']),
    field('게이트웨이 주소', gwIn), meaningCard(data.meaning['gateway-url']),
    el('div', { class: 'admin-actions' }, saveBtn, status)));
}

// ── 발행 · 배포 ──
function publishPanel(detail, data) {
  const pm = data.publishMeaning || {};
  const runBtn = el('button', { class: 'btn btn-primary', text: '발행(검증)' });
  const result = el('div', { class: 'admin-status' });
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; result.textContent = '발행 중…';
    try {
      const r = await api('/api/ui/org/publish', { method: 'POST', body: '{}' });
      result.replaceChildren(el('span', { class: 'pill pill-ok', text: '발행 OK' }),
        ' AGENTS.md ' + (r.artifactBytes != null ? (r.artifactBytes / 1024).toFixed(1) + ' KiB' : '?'),
        r.warning ? el('span', { class: 'pill pill-warn', text: r.warning }) : null);
      toast('발행 검증 완료 — 구성원은 설치/재설치로 받습니다');
    } catch (e) { result.textContent = ''; toast(e.message, true); }
    runBtn.disabled = false;
  });
  detail.replaceChildren(el('div', { class: 'card' },
    el('h2', { text: '발행 · 배포' }),
    el('p', { class: 'admin-what', text: pm.what || '' }),
    el('p', { class: 'admin-hint', text: pm.effect || '' }),
    el('p', { class: 'admin-hint', text: pm.note || '' }),
    el('div', { class: 'admin-actions' }, runBtn, result),
    el('div', { class: 'meaning meaning-infra' },
      el('div', { class: 'meaning-head' }, el('span', { class: 'meaning-dot' }), el('span', { class: 'meaning-title', text: '구성원 설치 방법' })),
      el('p', { class: 'meaning-what', text: '구성원은 git 없이 한 줄로 설치합니다 — [구성원] 탭에서 각자 토큰을 발급하면 그 사람 전용 설치 명령이 나옵니다.' }))));
}

// ── 공용 UI 헬퍼 ──
function field(label, control) {
  return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}
function copyButton(getText, label) {
  const b = el('button', { class: 'btn btn-ghost btn-sm', text: label || '복사' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); toast('복사됨'); }
    catch { toast('복사 실패 — 직접 선택해 복사하세요', true); }
  });
  return b;
}
function overlay(title, ...content) {
  const close = el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' });
  const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), close), ...content);
  const back = el('div', { class: 'ov-back' }, box);
  close.addEventListener('click', () => back.remove());
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); } });
  document.body.append(back);
  return back;
}
