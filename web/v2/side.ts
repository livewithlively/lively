// v2/side.ts — 새 셸 좌측 사이드바(#1719): 워크스페이스 **전체** 프로젝트 ▸ 살아 있는 세션 트리.
//  규칙(상민님 2026-08-18, 같은 날 재구성 지시로 갱신):
//   · 프로젝트는 워크스페이스 전체가 보인다(내 것만이 아니다). '내 프로젝트만'은 필터 안의 토글.
//   · 프로젝트 아래엔 **끝나지 않은 세션만**(살아 있는 박스). 끝난 것은 프로젝트 화면·세션 이력에서.
//   · 완료 프로젝트는 기본 숨김(살아 있는 세션이 있으면 예외로 보인다). 정렬 = 마지막 작업 시각 내림차순.
//   · **기본 화면은 목록 하나다** — 상태 칩·완료 숨김·내 프로젝트만 같은 필터는 전부 [필터] 버튼 속 팝오버로
//     들어간다(밖에 늘어놓으면 목록보다 조작부가 먼저 읽힌다 — 번잡함의 주범이었다).
//   · **위계가 시각으로 갈린다**: 프로젝트 행 = 폴더 아이콘 + 굵은 글씨 → 누르면 프로젝트 화면.
//     세션 행 = 들여쓴 레일 + 상태점 + 보통 글씨 → 누르면 그 세션의 대화. 서로 다른 곳으로 간다는 게 생김새에서 보인다.
//   · 흐린 회색 본문 금지 — 완료·조용한 프로젝트도 이름은 같은 잉크색이고, 상태는 작은 태그·시각으로만 구분한다
//     (연회색 글씨가 목록의 절반을 차지하면 전체가 바래 보인다).
//  main.ts 가 데이터·활성 키를 넘기고, 필터·펼침 같은 사이드바 자체 상태는 여기 산다(브라우저에 기억).
import { el, loadPeopleAvatars, logout, navOn, personFace, profileAvatar, relTime, setUiModeOverride, state, sv } from '../core.js';
import { SESS_STATES } from '../session-status.js';
import { appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls, type Proj, type Sess, type V2Data } from './views.js';
import { switcherTop } from './switcher.js';

const CLOSED_KEY = 'lively_v2_closed';    // 사용자가 직접 접은 프로젝트 — 살아 있는 세션이 있으면 기본이 '펼침'이라 '접음'만 기억하면 된다
const DONE_KEY = 'lively_v2_side_done';   // '1' = 완료 프로젝트도 보인다(필터 풀림)
const MINE_KEY = 'lively_v2_side_mine';   // '1' = 내 프로젝트만
const MAX_SESS = 12;                      // 한 프로젝트 아래 펼쳐 보이는 세션 상한(넘치면 '외 n개' → 프로젝트 화면)

let closedSet = new Set<string>();
let showDone = false;
let mineOnly = false;
let sideFilter = '';
let stateFilter: string | null = null;    // 상태 칩 — 세션 상태 key(waiting·busy…) 하나. 새로고침하면 풀린다(잠깐 보는 렌즈)
let people: Record<string, any> = {};     // id → 멤버(표시명·아바타). 남의 세션 소유자 이름용
let inited = false;
let last: { host: HTMLElement; data: V2Data; activeKey: () => string } | null = null;

function loadSet(k: string): Set<string> { try { const a = JSON.parse(localStorage.getItem(k) || '[]'); return new Set<string>(Array.isArray(a) ? a : []); } catch (_) { return new Set<string>(); } }
function saveSet(k: string, s: Set<string>): void { try { if (s.size) localStorage.setItem(k, JSON.stringify([...s])); else localStorage.removeItem(k); } catch (_) { /* noop */ } }
function saveFlag(k: string, v: boolean): void { try { if (v) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch (_) { /* noop */ } }
function init(): void {
  if (inited) return;
  inited = true;
  closedSet = loadSet(CLOSED_KEY);
  try { showDone = localStorage.getItem(DONE_KEY) === '1'; mineOnly = localStorage.getItem(MINE_KEY) === '1'; } catch (_) { /* noop */ }
  void loadPeopleAvatars().then((m) => { people = m || {}; if (last) redraw(); });
}

/** 살아 있는 세션 = 사이드바에 보이는 세션. 라이브 박스이고 끝나지 않은 것(중단됨·종료됨 제외). 기록만 남은 대화는 아니다. */
const isLive = (s: Sess) => s.live && s.alive;
const rankOf = (k: string) => (SESS_STATES[k] ? SESS_STATES[k].rank : 9);
const bySeen = (a: Sess, b: Sess) => rankOf(a.stateKey) - rankOf(b.stateKey) || b.lastSeen - a.lastSeen;
const when = (ms: number) => (ms ? relTime(new Date(ms).toISOString()) : '');
function ownerName(s: Sess): string {
  if (s.owned) return '나';
  const id = String((s.raw && s.raw.owner) || '');
  const m = people[id];
  return (m && m.display_name) || id || '?';
}

// ── 프로젝트 행 하나의 재료: 살아 있는 세션 · 마지막 작업 시각 · 내 것인가 ──
interface Row { key: string; proj: Proj | null; live: Sess[]; lastWork: number; mine: boolean; done: boolean; }
function buildRows(data: V2Data): Row[] {
  const me = String((state.me && state.me.userId) || '');
  const byProj = new Map<number, Sess[]>();
  const noProj: Sess[] = [];
  for (const s of data.sessions) { if (s.projectId) { const arr = byProj.get(s.projectId) || []; arr.push(s); byProj.set(s.projectId, arr); } else noProj.push(s); }
  const lastOf = (arr: Sess[]) => arr.reduce((m, s) => Math.max(m, s.lastSeen || 0), 0);
  const rows: Row[] = data.projects.map((p) => {
    const all = byProj.get(p.id) || [];
    return { key: 'p:' + p.id, proj: p, live: all.filter(isLive).sort(bySeen), lastWork: lastOf(all), done: p.status_category === 'done',
      mine: !!me && (p.created_by === me || (p.member_ids || []).includes(me)) };
  });
  // 프로젝트 없는 세션 — 가짜 프로젝트 한 줄로 같은 정렬에 섞는다(맨 아래 고정이면 프로젝트 수백 개 밑에 묻힌다).
  const loose = noProj.filter(isLive).sort(bySeen);
  if (loose.length) rows.push({ key: 'p:0', proj: null, live: loose, lastWork: lastOf(noProj), done: false, mine: true });
  return rows;
}

// ── 사이드바 정렬을 밖에서도(#1749 상단바 프로젝트 연결 드롭다운) — 트리와 **같은 순서**(마지막 작업 시각 ↓ → updated_at ↓).
//  완료 프로젝트는 뒤로 보낸다(트리는 기본 숨김이라 "보이는 순서"가 곧 미완료 순서 — 드롭다운은 숨기는 대신 가라앉힌다).
export function projectOrder(data: V2Data): Array<{ proj: Proj; done: boolean; mine: boolean; lastWork: number }> {
  const byWork = (a: Row, b: Row) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || ''));
  return buildRows(data).filter((r) => r.proj)
    .sort((a, b) => Number(a.done) - Number(b.done) || byWork(a, b))
    .map((r) => ({ proj: r.proj as Proj, done: r.done, mine: r.mine, lastWork: r.lastWork }));
}

// ── 그리기 ──
export function drawSide(host: HTMLElement, data: V2Data, activeKey: () => string): void {
  init();
  last = { host, data, activeKey };
  render();
}
function redraw(): void { if (last) render(); }

let treeEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let filterOpen = false;            // [필터] 팝오버 — 열림은 잠깐의 상태라 브라우저에 기억하지 않는다
let outsideBound = false;

// 위계 아이콘 — 프로젝트는 폴더, 세션은 말풍선. 같은 24 뷰박스·현재색 스트로크(붓은 하나).
function glyph(kind: 'folder' | 'chat', cls: string): SVGElement {
  const d = kind === 'folder'
    ? 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
    : 'M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z';
  return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d }));
}

function render(): void {
  if (!last) return;
  const { host, data } = last;
  const me = state.me || {};
  const name = String(me.display_name || me.email || me.userId || '');
  const rows = buildRows(data);
  const liveAll = rows.flatMap((r) => r.live);
  const livOn = navOn('liv') !== false;
  // 20초 폴링마다 통째로 다시 그린다 — 스크롤 위치와 검색칸 포커스는 이어져야 한다(수백 행에서 매번 맨 위로 튀면 못 쓴다).
  const prevScroll = treeEl ? treeEl.scrollTop : 0;
  const findHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-find-in') ? document.activeElement : null;
  const findSel = findHad ? [findHad.selectionStart, findHad.selectionEnd] : null;
  countEl = el('span', { class: 'v2-k' });
  treeEl = el('div', { class: 'v2-tree', role: 'tree', 'aria-label': '프로젝트와 세션' });
  const findIn = el('input', { class: 'v2-find-in', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기', value: sideFilter,
    oninput: (e: any) => { sideFilter = e.target.value; renderTree(); if (treeEl) treeEl.scrollTop = 0; } }) as HTMLInputElement;
  const doneCount = rows.filter((r) => r.done).length;
  const fltN = (stateFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (showDone ? 1 : 0);
  host.replaceChildren(
    switcherTop(),   // 좌상단 워크스페이스 스위처(#1750) — 홈 워드마크 + 개인/팀 배지·전환·연결 메뉴
    // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 스프레드로.
    ...(livOn ? [el('a', { class: 'v2-liv-btn' + (last.activeKey() === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv' },
      el('span', { class: 'lm', text: 'L' }), el('span', { text: '리브' }), el('span', { class: 'sub', text: '워크스페이스 담당자' }))] : []),
    el('div', { class: 'v2-side-sec' }, countEl,
      filterBtn(fltN, liveAll, doneCount),
      el('a', { class: 'v2-add', href: '#/projects2', text: '+ 새 프로젝트', title: '프로젝트 앱(보드)에서 만듭니다' })),
    el('div', { class: 'v2-find' }, findIn),
    ...(fltN ? [filterSummary(fltN)] : []),
    treeEl!,
    el('div', { class: 'v2-side-foot' },
      el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })),
      el('div', { class: 'v2-me' },
        profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }),
        el('span', { class: 'v2-me-name', text: name }),
        el('button', { class: 'btn-text', type: 'button', text: '로그아웃', onclick: () => void logout() })),
      el('button', { class: 'v2-classic-link', type: 'button', text: '클래식 화면으로 (이 브라우저)', title: '이 브라우저에서만 옛 화면으로 봅니다. 관리탭 [화면] 에서 되돌릴 수 있어요.', onclick: () => { setUiModeOverride('classic'); location.replace(location.pathname + '#/dashboard'); location.reload(); } })));
  renderTree(rows);
  treeEl!.scrollTop = prevScroll;
  if (findHad) { findIn.focus(); if (findSel && findSel[0] != null) findIn.setSelectionRange(findSel[0], findSel[1]); }
}

// [필터] 버튼 + 팝오버 — 조작부는 여기 다 모인다. 목록 표면에는 필터가 없다(켜져 있으면 요약 한 줄만).
function filterBtn(activeN: number, liveAll: Sess[], doneCount: number): HTMLElement {
  const counts = new Map<string, number>();
  for (const s of liveAll) counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
  if (stateFilter && !counts.has(stateFilter)) counts.set(stateFilter, 0);   // 켜 둔 상태가 0이 돼도 끌 수 있게 남긴다
  const keys = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
  const wrap = el('div', { class: 'v2-flt' });
  const btn = el('button', {
    class: 'v2-flt-btn' + (activeN ? ' has' : '') + (filterOpen ? ' open' : ''), type: 'button',
    'aria-haspopup': 'true', 'aria-expanded': String(filterOpen), title: '보기 조건 — 상태·범위·완료',
    onclick: (e: Event) => { e.stopPropagation(); filterOpen = !filterOpen; redraw(); } },
    sv('svg', { viewBox: '0 0 24 24', class: 'v2-flt-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M4 6h16M7 12h10M10 18h4' })),
    el('span', { text: '필터' }), activeN ? el('b', { class: 'v2-flt-n', text: String(activeN) }) : null);
  wrap.append(btn);
  if (filterOpen) {
    const opt = (on: boolean, label: string, cnt: string, dot: string | null, onclick: () => void) =>
      el('button', { class: 'v2-fo' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick },
        dot ? el('span', { class: 'v2-dot ' + dot, 'aria-hidden': 'true' }) : el('span', { class: 'v2-fo-pad', 'aria-hidden': 'true' }),
        el('span', { class: 'n', text: label }), cnt ? el('span', { class: 'v2-cnt', text: cnt }) : null,
        on ? el('span', { class: 'v2-fo-ck', text: '✓', 'aria-hidden': 'true' }) : null);
    wrap.append(el('div', { class: 'v2-flt-pop', role: 'menu', onclick: (e: Event) => e.stopPropagation() },
      el('div', { class: 'v2-flt-k', text: '세션 상태' }),
      opt(!stateFilter, '전체', '', null, () => { stateFilter = null; redraw(); }),
      ...keys.map((k) => { const st = SESS_STATES[k]; return opt(stateFilter === k, st ? st.label : k, String(counts.get(k) || 0), dotCls(k),
        () => { stateFilter = stateFilter === k ? null : k; redraw(); }); }),
      el('div', { class: 'v2-flt-k', text: '범위' }),
      opt(mineOnly, '내 프로젝트만', '', null, () => { mineOnly = !mineOnly; saveFlag(MINE_KEY, mineOnly); redraw(); }),
      opt(showDone, '완료 프로젝트도 보기', doneCount ? String(doneCount) : '', null, () => { showDone = !showDone; saveFlag(DONE_KEY, showDone); redraw(); }),
      el('div', { class: 'v2-flt-foot' },
        el('button', { class: 'btn-text', type: 'button', text: '전부 지우기', onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }),
        el('button', { class: 'btn-text', type: 'button', text: '닫기', onclick: () => { filterOpen = false; redraw(); } }))));
    if (!outsideBound) {
      outsideBound = true;
      document.addEventListener('click', (e) => {
        if (filterOpen && !(e.target as HTMLElement | null)?.closest?.('.v2-flt')) { filterOpen = false; redraw(); }
      });
    }
  }
  return wrap;
}
// 필터가 켜져 있을 때만 나오는 한 줄 — 무엇으로 걸러 보고 있는지 + 한 번에 끄기.
function filterSummary(n: number): HTMLElement {
  const bits: string[] = [];
  if (stateFilter) { const st = SESS_STATES[stateFilter]; bits.push((st ? st.label : stateFilter) + ' 세션만'); }
  if (mineOnly) bits.push('내 프로젝트만');
  if (showDone) bits.push('완료 포함');
  return el('div', { class: 'v2-flt-sum' }, el('span', { text: bits.join(' · ') }),
    el('button', { class: 'btn-text', type: 'button', text: '지우기', title: `필터 ${n}개를 끕니다`,
      onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }));
}

// 트리(프로젝트 ▸ 세션) — 검색은 여기만 다시 그린다(입력칸 포커스를 잃지 않게).
function renderTree(rowsIn?: Row[]): void {
  if (!last || !treeEl) return;
  const rows = rowsIn || buildRows(last.data);
  const activeKey = last.activeKey();
  const q = sideFilter.trim().toLowerCase();
  const hit = (r: Row) => !q || (r.proj ? (r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q) : '프로젝트 없는 세션'.includes(q));
  const stateOf = (r: Row) => (stateFilter ? r.live.filter((s) => s.stateKey === stateFilter) : r.live);
  let hiddenDone = 0;
  const shown = rows.filter((r) => {
    if (!hit(r)) return false;
    if (mineOnly && !r.mine) return false;
    if (stateFilter && !stateOf(r).length) return false;
    if (r.done && !showDone && !r.live.length) { hiddenDone++; return false; }
    return true;
  }).sort((a, b) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || '')));
  if (countEl) countEl.textContent = `프로젝트 · ${shown.filter((r) => r.proj).length}${q || mineOnly || stateFilter ? ` / ${rows.filter((r) => r.proj && (showDone || !r.done || r.live.length)).length}` : ''}`;
  const kids: HTMLElement[] = shown.map((r) => projRow(r, stateOf(r), activeKey));
  if (!kids.length) {
    kids.push(!last.data.loadedAt ? el('p', { class: 'v2-tree-note', text: '불러오는 중…' }) : !last.data.projects.length
      ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 가운데 입력창에 무엇이든 시키면 세션이 열리고, 프로젝트는 나중에 붙일 수 있어요.' })
      : el('div', { class: 'v2-tree-note' }, el('span', { text: '조건에 맞는 프로젝트가 없어요.' }),
        el('button', { class: 'btn-text', type: 'button', text: '필터 지우기', onclick: () => { sideFilter = ''; stateFilter = null; mineOnly = false; saveFlag(MINE_KEY, false); redraw(); } })));
  }
  if (hiddenDone) kids.push(el('button', { class: 'v2-tree-more', type: 'button', text: `숨긴 완료 프로젝트 ${hiddenDone}개 보기`, onclick: () => { showDone = true; saveFlag(DONE_KEY, true); redraw(); } }));
  treeEl.replaceChildren(...kids);
}

function projRow(r: Row, sess: Sess[], activeKey: string): HTMLElement {
  const p = r.proj;
  const pk = r.key;
  const href = p ? '#/p/' + p.id : '#/app/terminal';
  const isOn = activeKey === pk || (!p && activeKey === 'app:terminal');
  // 펼침 기본값: 살아 있는 세션이 있으면 **펼침**(한눈에 상태를 보는 게 사이드바의 일이다) — 사용자가 접은 것만 접힌 채로.
  const isOpen = sess.length > 0 && !closedSet.has(pk);
  const caret = sess.length
    ? el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      if (isOpen) closedSet.add(pk); else closedSet.delete(pk);
      saveSet(CLOSED_KEY, closedSet); renderTree(); } })
    : el('span', { class: 'v2-car none', 'aria-hidden': 'true' });
  const tipBits = p
    ? [`#${p.id} · ${p.status_category === 'done' ? '완료' : p.status_category === 'unstarted' ? '시작 전' : '진행 중'}`, r.lastWork ? '마지막 작업 ' + when(r.lastWork) : '세션 없음', r.mine ? '내 프로젝트' : (p.created_by ? `${(people[p.created_by] && people[p.created_by].display_name) || p.created_by} 만듦` : '')]
    : ['프로젝트에 붙지 않은 세션 — AI 세션 앱에서 전부 봅니다'];
  // 이름은 언제나 같은 잉크색이다 — 완료·조용함은 태그·시각이 말한다(연회색 본문이 목록 절반이면 전체가 바래 보인다).
  const row = el('a', { class: 'v2-pj-row' + (isOn ? ' on' : ''), href, 'data-nav': p ? pk : 'app:terminal', title: (p ? p.name + '\n' : '') + tipBits.filter(Boolean).join(' · ') + '\n프로젝트 화면을 엽니다' },
    caret, glyph('folder', 'v2-pj-ic'), el('span', { class: 'n', text: p ? p.name : '프로젝트 없는 세션' }),
    r.done ? el('span', { class: 'v2-tag', text: '완료' }) : null,
    sess.length ? sumEl(sess) : (r.lastWork ? el('span', { class: 'v2-pj-when', text: when(r.lastWork) }) : null));
  const list = sess.length ? el('div', { class: 'v2-ss-list', role: 'group', hidden: !isOpen },
    ...sess.slice(0, MAX_SESS).map((s) => sessRow(s, activeKey)),
    sess.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${sess.length - MAX_SESS}개` }) : null) : null;
  return el('div', { class: 'v2-pj' + (isOpen ? ' open' : ''), role: 'treeitem', 'aria-expanded': sess.length ? String(isOpen) : null }, row, list);
}

// 프로젝트 행 오른쪽 — 숫자를 늘어놓지 않는다. **볼 일이 있는 것만**: 확인 필요(호박)·작업 중(파랑).
//  그 밖의 살아 있는 세션은 개수 하나(회색). 상태별 전체 분포는 [필터] 팝오버가 보여 준다.
function sumEl(sess: Sess[]): HTMLElement | null {
  if (!sess.length) return null;
  const c = { wait: 0, busy: 0, rest: 0 };
  for (const s of sess) { if (s.stateKey === 'waiting') c.wait++; else if (s.stateKey === 'busy') c.busy++; else c.rest++; }
  const part = (n: number, cls: string, label: string) => (n ? el('span', { class: 'v2-sum ' + cls, title: `${label} ${n}` }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), String(n)) : null);
  return el('span', { class: 'v2-sums', 'aria-label': `세션 ${sess.length}` }, part(c.wait, 'wait', '확인 필요'), part(c.busy, 'busy', '작업 중'),
    (!c.wait && !c.busy && c.rest) ? el('span', { class: 'v2-sum idle', title: `살아 있는 세션 ${c.rest}` }, String(c.rest)) : null);
}

// 세션 행 — 상태점 · 이름(+ 아래에 '지금 하는 일' 한 줄) · 남의 세션이면 소유자 얼굴 · 상태어.
function sessRow(s: Sess, activeKey: string): HTMLElement {
  const st = SESS_STATES[s.stateKey];
  const cls = dotCls(s.stateKey);
  const raw = s.raw || {};
  const owner = ownerName(s);
  // '지금 하는 일'(하네스가 pane 제목에 써 두는 요약, 클래식 카드의 💬 줄) — 이름과 다를 때만 둘째 줄로. 세션 이름이 프로젝트명 그대로인 게 많아
  //  이 줄이 사실상 세션을 구분해 준다. 끝난 세션은 트리에 없으니 '마지막으로 하던 일'로 읽어도 틀리지 않는다.
  const sub = raw.title && String(raw.title) !== s.label ? String(raw.title) : '';
  const tip = [s.label, `${st ? st.label : s.stateLabel}${s.lastSeen ? ' · ' + when(s.lastSeen) : ''}`, s.owned ? '내 세션' : `${owner}의 세션`, raw.harness ? String(raw.harness) : '', s.node ? '노드 ' + s.node : ''].filter(Boolean).join('\n');
  const showWord = s.stateKey === 'waiting' || s.stateKey === 'busy';   // 상태어는 지금 볼 일이 있는 것만 — 나머지는 점이 말한다
  return el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : '') + (s.owned ? '' : ' other'), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: tip + '\n세션 대화를 엽니다', role: 'treeitem' },
    el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }),
    el('span', { class: 'v2-ss-main' }, el('span', { class: 't', text: s.label }), sub ? el('span', { class: 'sub', text: sub }) : null),
    s.owned ? null : personFace(String(raw.owner || ''), 'v2-ss-face', owner),
    showWord ? el('span', { class: 'w ' + cls, text: st ? st.label : s.stateLabel }) : glyph('chat', 'v2-ss-go'));
}
