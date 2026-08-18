// v2/main.ts — 새 1탭 셸(#1719)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 상단/하단 바 없음):
//    좌 사이드바 — 로고(→홈) · 리브(→리브 페이지) · 프로젝트(워크스페이스 전체) ▸ 살아 있는 세션 트리(web/v2/side.ts) · 앱(런치패드) · 나/로그아웃
//    중앙        — 입력창 하나(홈 — Enter 로 프로젝트 없는 세션, #1719) / 프로젝트 / 세션(대화창) / 앱 프레임(클래식 화면 임베드) / 리브 페이지
//    우측        — 이 선택의 지식(프로젝트 필요·산출) · 리브 카드(홈)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
//   서버 템플릿 의존 0, window.open 대신 <a target=_blank>(일렉트론이 새 창 정책으로 받는다).
import { $view, anchoredPopover, api, el, toast } from '../core.js';
import { fillLivCards, renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame, appIcon, openLaunchpad, visibleApps } from './apps.js';
import { drawSide as drawSideTree, projectOrder } from './side.js';
import { dotCls, mergeSessions, projName, refreshSession, renderHome, renderProject, renderSession, unmountSession, type Sess, type V2Data } from './views.js';
import { createTrailWidget, type TrailWidget } from '../session-trail.js';
import { makeSplitter } from './split.js';

let root: HTMLElement | null = null;
let sideEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let asideEl: HTMLElement | null = null;
let data: V2Data = { projects: [], sessions: [], loadedAt: 0 };
let projLoadedAt = 0;
const projRetried = new Set<number>();   // 목록에 없어 한 번 더 당겨 본 프로젝트 id(같은 id 로 반복 재조회 방지)
let routeSeq = 0;
// 프로젝트 목록은 워크스페이스 전체(수백 건·설명 포함이라 1MB 를 넘는다) — 세션처럼 20초마다 당기지 않는다.
//  5분에 한 번, 그리고 세션이 모르는 프로젝트를 가리킬 때(그새 생긴 프로젝트) 한 번 더.
const PROJ_TTL_MS = 5 * 60 * 1000;

export async function bootV2(): Promise<void> {
  root = document.getElementById('v2-root');
  if (!root) return;
  root.hidden = false;
  // 세 칸 사이 경계는 끌어서 조정(#1719) — 사이드바·우패널 너비를 CSS 변수(--v2-side-w/--v2-aside-w)로, 손잡이가 바꾼다(기억됨).
  root.replaceChildren(
    sideEl = el('nav', { class: 'v2-side', 'aria-label': '탐색' }),
    makeSplitter({ axis: 'x', key: 'side-w', cssVar: '--v2-side-w', target: root, def: 262, min: 180, max: 520, grow: 1, label: '사이드바 너비' }),
    centerEl = el('div', { class: 'v2-main', id: 'v2-main' }),
    makeSplitter({ axis: 'x', key: 'aside-w', cssVar: '--v2-aside-w', target: root, def: 316, min: 240, max: 720, grow: -1, label: '우패널 너비' }),
    asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 맥락' }));
  drawSide(); // 데이터 전 골격(로고·리브·앱)부터 — 빈 화면을 오래 두지 않는다
  await loadData();
  drawSide();
  window.addEventListener('hashchange', () => { void route(); });
  await route();
  // 사이드바 상태점 — 라이브 세션은 자주 바뀐다. 20초 폴링(가벼운 목록 두 개). 탭이 숨어 있으면 건너뛴다.
  setInterval(() => { if (document.hidden) return; void loadData().then(() => { drawSide(); const c = parse(); if (c.segs[0] === 's' && c.segs[1]) { const sid = decodeURIComponent(c.segs[1]); refreshSession(data, sid);
      // 우측 '이 세션'도 — 프로젝트 드롭다운(#1749)은 body 에 뜨는 팝오버라 우측을 되그려도 안 닫힌다.
      drawAsideSession(data.sessions.find((x) => x.id === sid || x.logId === sid) || null); } }); }, 20000);
}

// ── 데이터 ──
async function loadData(opts?: { projects?: boolean }): Promise<void> {
  const wantProj = opts && opts.projects != null ? opts.projects : (Date.now() - projLoadedAt > PROJ_TTL_MS);
  const [pj, live, logs] = await Promise.all([
    // 워크스페이스 **전체** 프로젝트(mine=1 아님) — 사이드바가 남의 프로젝트·세션까지 한 트리로 보여준다(상민님 2026-08-18).
    //  가시성은 서버가 시행한다(#1291 — 안 보이는 리스트의 프로젝트는 애초에 안 온다).
    wantProj ? api('/api/ui/v6/projects').then((d) => (d && d.projects) || null).catch(() => null) : Promise.resolve(null),
    // includeProjects=1 — 프로젝트 폴더 세션까지(기본은 '내 개인 세션'만이라 프로젝트 트리 아래 라이브 세션이 통째로 빠졌다).
    //  프로젝트 세션은 로그인한 전원에게 보인다(#452) — 클래식 AI 세션 탭과 같은 목록이다.
    api('/api/ui/terminal/sessions?includeProjects=1').then((d) => (d && d.sessions) || []).catch(() => []),
    api('/api/ui/v6/sessions').then((d) => (d && d.sessions) || []).catch(() => []),
  ]);
  let projects = data.projects;
  if (Array.isArray(pj)) {
    projects = (pj as any[]).map((p) => ({ id: Number(p.id), name: String(p.name || ''), status: p.status ?? null, status_category: p.status_category ?? null, description: p.description ?? null, list_id: p.list_id ?? null, updated_at: p.updated_at ?? null,
      created_by: p.created_by != null ? String(p.created_by) : null, member_ids: Array.isArray(p.members) ? p.members.map((m: any) => String(m && m.member_id != null ? m.member_id : m)) : [] }));
    projLoadedAt = Date.now();
  }
  const sessions = mergeSessions(live as any[], logs as any[]);
  data = { projects, sessions, loadedAt: Date.now() };
  // 세션이 가리키는데 목록에 없는 프로젝트(방금 만든 것) — 한 번 더 당긴다. 같은 id 로는 한 번만(그래도 없으면 안 보이는 프로젝트다 —
  //  프로젝트 세션은 전원 공개(#452)인데 프로젝트 목록은 리스트 가시성(#1291)을 타서 그런 경우가 정상적으로 생긴다. 매 폴링마다 1.4MB 를 다시 당기지 않는다).
  if (!wantProj) {
    const known = new Set(projects.map((p) => p.id));
    const fresh = sessions.filter((s) => s.projectId && !known.has(s.projectId) && !projRetried.has(s.projectId)).map((s) => s.projectId as number);
    if (fresh.length) { for (const id of fresh) projRetried.add(id); await loadData({ projects: true }); }
  }
}

// ── 라우터 ──
function parse(): { segs: string[]; params: URLSearchParams; raw: string } {
  const h = location.hash.replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const path = q >= 0 ? h.slice(0, q) : h;
  return { segs: path.split('/').filter(Boolean), params: new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), raw: h };
}
async function route(): Promise<void> {
  if (!centerEl || !asideEl) return;
  const seq = ++routeSeq;
  const { segs, raw } = parse();
  const page = segs[0] || '';
  // 리브 페이지를 떠나면 그 폴링이 멈추도록 route 표식을 되돌린다(liv.ts 는 body.dataset.route==='liv' 동안만 폴링).
  document.body.dataset.route = 'v2';
  if (page !== 's') unmountSession();   // 세션 화면을 떠나면 그 폴링·리스너를 끈다(다음 렌더가 덮어써도 타이머는 남는다)
  markActive(page === 'p' ? 'p:' + segs[1] : page === 's' ? 's:' + decodeURIComponent(segs[1] || '') : page === 'liv' ? 'liv' : page === '' || page === 'dashboard' ? 'home' : '');
  root!.classList.toggle('no-aside', false);
  try {
    if (page === '' || page === 'dashboard') {
      renderHome(centerEl, data);
      drawAsideHome();
    } else if (page === 'liv') {
      // 리브 전체 페이지 — 대화는 **본문**, "지금 손볼 것" 카드는 **우측 패널**. 다른 페이지(본문 가운데·패널 오른쪽)와
      //  같은 열 문법이다. (v1 renderLiv 는 카드를 왼쪽 레일에 그렸는데, 사이드바가 있는 셸에선 그게 사이드바 둘로 읽혔다.)
      centerEl.replaceChildren();
      const host = el('div', { class: 'v2-livpage' });
      centerEl.append(host);
      const rail = drawAsideLiv();
      await renderLiv(host, { rail, embedded: true });
    } else if (page === 'p' && segs[1]) {
      const id = Number(segs[1]);
      let detail: any = null;
      try { detail = await api('/api/ui/v6/projects/' + id); } catch (_) { detail = null; }
      if (seq !== routeSeq) return;
      // 목록에 없는 프로젝트(방금 만든 것·딥링크) — 사이드바 트리에도 나오게 목록을 한 번 더 당긴다.
      if (detail && !data.projects.some((p) => p.id === id)) void loadData({ projects: true }).then(() => drawSide());
      await renderProject(centerEl, data, id, detail);
      drawAsideProject(detail, id);
    } else if (page === 's' && segs[1]) {
      const id = decodeURIComponent(segs[1]);
      const find = (): Sess | undefined => data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
      let s = find();
      if (!s) { await loadData(); drawSide(); s = find(); }
      if (seq !== routeSeq) return;
      // 우패널(발자취)을 먼저 — 세션 화면이 대화 파일을 읽으며 거기로 흘려보낸다. 프로젝트 연결은 상단바 드롭다운(#1749).
      const trail = drawAsideSession(s || null);
      renderSession(centerEl, data, id, trail, (anchor) => openProjectPicker(anchor, id));
    } else if (page === 'app' && segs[1]) {
      const a = appByKey(segs[1]);
      const rest = segs.slice(2).join('/');
      const hash = a ? a.route + (rest ? '/' + rest : '') : segs.slice(1).join('/');
      centerEl.replaceChildren(appFrame(hash, a ? a.title : segs[1]));
      root!.classList.add('no-aside');
      markActive('app:' + (a ? a.key : ''));
    } else if (CLASSIC_PAGES[page]) {
      // 옛 딥링크(#/knowledge/…, #/projects2/p/12, #/system/…) — 앱 프레임에 그 해시 그대로. 북마크가 새 셸에서도 산다.
      const a = appByKey(CLASSIC_PAGES[page]);
      centerEl.replaceChildren(appFrame(raw, a ? a.title : page));
      root!.classList.add('no-aside');
      markActive('app:' + (a ? a.key : ''));
    } else {
      renderHome(centerEl, data);
      drawAsideHome();
    }
  } catch (e) {
    centerEl.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '화면을 불러오지 못했습니다 — ' + (e && e.message ? e.message : e) })));
  }
}

// ── 사이드바 ── (트리·필터·펼침은 web/v2/side.ts — 여기선 활성 표시와 활성 키 계산만)
function markActive(key: string): void {
  if (!sideEl) return;
  let hit: HTMLElement | null = null;
  for (const a of Array.from(sideEl.querySelectorAll<HTMLElement>('[data-nav]'))) { const on = a.dataset.nav === key; a.classList.toggle('on', on); if (on && !hit) hit = a; }
  // 트리는 수백 행이라 지금 보는 것이 화면 밖일 수 있다 — 라우트가 바뀔 때만 그 행이 보이게 살짝 굴린다(폴링 재렌더에선 안 건드린다).
  if (hit && key !== 'home' && key !== 'liv') hit.scrollIntoView({ block: 'nearest' });
}
function activeKey(): string {
  const cur = parse();
  return cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
}
function drawSide(): void { if (sideEl) drawSideTree(sideEl, data, activeKey); }

// ── 우측 ──
function knItem(name: string, rel: 'req' | 'prod'): HTMLElement {
  return el('a', { class: 'v2-kn', href: '#/k/' + encodeURIComponent(name), title: name },
    el('span', { class: 'v2-kn-rel ' + rel, text: rel === 'req' ? '필요' : '산출' }), el('span', { class: 'v2-kn-name', text: name }));
}
function drawAsideHome(): void {
  if (!asideEl) return;
  const cards = el('div', { class: 'liv-cards v2-liv-cards' });
  asideEl.replaceChildren(
    el('div', { class: 'v2-aside-h' }, el('b', { text: '리브가 지금 보는 것' })),
    cards,
    el('div', { class: 'v2-aside-h', style: 'margin-top:14px' }, el('b', { text: '앱' }), el('span', { class: 'v2-k', text: '옛 화면 그대로' })),
    el('div', { class: 'v2-applist' }, ...visibleApps().slice(0, 6).map((a) => el('a', { class: 'v2-applink', href: '#/app/' + a.key }, appIcon(a.icon), el('span', { text: a.title })))),
    el('button', { class: 'btn-text', type: 'button', text: '전체 앱 보기 →', onclick: () => openLaunchpad() }));
  // 리브가 기다리는 물음(자격·선택·업로드 카드)은 이제 홈 가운데가 아니라 여기(우측) 카드 위에 붙는다 — 홈 가운데는 입력창 하나다.
  const askHost = el('div', { class: 'liv-askdock v2-askdock' });
  cards.before(askHost);
  void fillLivCards(cards, askHost);
}
// 리브 페이지의 우측 패널 — 홈 패널과 같은 자리·같은 카드("리브가 지금 보는 것"). 카드 본체는 renderLiv 가 채운다.
function drawAsideLiv(): HTMLElement | null {
  if (!asideEl) return null;
  const rail = el('div', { class: 'liv-rail v2-liv-rail' });
  asideEl.replaceChildren(
    el('div', { class: 'v2-aside-h' }, el('b', { text: '리브가 지금 보는 것' }), el('span', { class: 'v2-k', text: '손볼 것' })),
    rail,
    el('p', { class: 'v2-fine', text: '리브가 던진 물음은 대화 입력 바로 위에 뜹니다.' }));
  return rail;
}
function drawAsideProject(detail: any, id: number): void {
  if (!asideEl) return;
  const kn = detail && detail.project && detail.project.knowledge;
  const req: any[] = (kn && kn.required) || [];
  const prod: any[] = (kn && kn.produced) || [];
  asideEl.replaceChildren(
    el('div', { class: 'v2-aside-h' }, el('b', { text: '이 프로젝트의 지식' }), el('span', { class: 'v2-k', text: `필요 ${req.length} · 산출 ${prod.length}` })),
    el('div', { class: 'v2-kn-sec' }, el('span', { class: 'v2-k', text: '필요지식' }),
      req.length ? el('div', { class: 'v2-kn-list' }, ...req.map((k) => knItem(k.name, 'req'))) : el('p', { class: 'v2-empty', text: '아직 없어요 — 세션에서 리브가 읽은 것부터 채워집니다.' })),
    el('div', { class: 'v2-kn-sec' }, el('span', { class: 'v2-k', text: '산출지식' }),
      prod.length ? el('div', { class: 'v2-kn-list' }, ...prod.map((k) => knItem(k.name, 'prod'))) : el('p', { class: 'v2-empty', text: '세션이 끝나면 여기에 쌓입니다.' })),
    el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2/p/' + id, text: '프로젝트 앱에서 지식 연결' }));
}
// 세션 우패널 = 짧은 사실 줄 + **발자취**(session-trail.ts — 이 세션이 읽고 쓴 파일·지식·활동·프로젝트·태스크·자료).
//  같은 세션이면 위젯을 **다시 만들지 않는다**(20초 폴링이 상태만 갱신) — 새로 만들면 쌓인 발자취가 사라진다.
let asideTrail: { id: string; w: TrailWidget; facts: HTMLElement } | null = null;
function drawAsideSession(s: Sess | null): TrailWidget | null {
  if (!asideEl) return null;
  if (!s) { asideTrail = null; asideEl.replaceChildren(el('p', { class: 'v2-empty', text: '세션 정보를 찾을 수 없어요.' })); return null; }
  const raw = s.raw || {};
  const factsEl = el('div', { class: 'v2-sfacts' },
    el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }),
    el('span', { class: 'sep', text: '·' }), s.projectId ? el('a', { href: '#/p/' + s.projectId, text: projName(data, s.projectId) }) : el('span', { text: '프로젝트 없음' }),
    raw.harness ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'mono', text: String(raw.harness) })] : null,
    s.node ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(s.node) })] : null,
    !s.owned && (raw.owner_name || raw.owner) ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(raw.owner_name || raw.owner) })] : null);
  if (asideTrail && asideTrail.id === s.id && asideTrail.w.root.isConnected) { asideTrail.facts.replaceWith(factsEl); asideTrail.facts = factsEl; return asideTrail.w; }
  asideEl.replaceChildren(factsEl);   // 프로젝트 붙이기는 상단바 [프로젝트 연결](#1749)
  const w = createTrailWidget(asideEl, { sessionId: s.id, live: s.live });
  asideTrail = { id: s.id, w, facts: factsEl };
  return w;
}
// 세션의 프로젝트 소속(#1749) — 상단바 [프로젝트 연결]/[▾] 이 여는 **검색 드롭다운**. 내 세션이면 언제든 붙이고 뗀다.
//  POST terminal/sessions/:id/project — 서버가 tmux 표시값·세션 폴더 안 마커/링크·DB 구간을 함께 바꾼다(cwd 는 그대로).
//  목록·정렬 = 좌측 사이드바와 같다(side.ts projectOrder — 마지막 작업 시각 ↓, 완료는 뒤로). 서버 게이트는 '내가 볼 수 있는 프로젝트'.
function openProjectPicker(anchor: HTMLElement, sessionId: string): void {
  const s = data.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const rows = projectOrder(data);
  const input = el('input', { class: 'v2-pjpick-in', type: 'search', placeholder: '프로젝트 검색', 'aria-label': '프로젝트 검색' }) as HTMLInputElement;
  const listEl = el('div', { class: 'v2-pjpick-list', role: 'listbox' });
  const note = el('p', { class: 'v2-fine v2-pjpick-note' });
  const panel = el('div', { class: 'v2-pjpick' }, input, listEl, note);
  let closePop: (() => void) | null = null;
  let busyPick = false;

  async function pick(pid: number | null): Promise<void> {
    if (busyPick) return;
    busyPick = true;
    note.textContent = pid ? '붙이는 중…' : '떼는 중…';
    try {
      const r: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/project', { method: 'POST', body: JSON.stringify({ projectId: pid }) });
      toast(pid ? `프로젝트에 붙였어요${r && r.linked ? ' — 세션 폴더의 ./project 로 프로젝트 폴더에 갑니다' : ''}.` : '프로젝트에서 뗐어요.');
      if (closePop) closePop();
      await loadData(); drawSide();
      refreshSession(data, sessionId);
      drawAsideSession(data.sessions.find((x) => x.id === sessionId) || null);
    } catch (e: any) {
      busyPick = false;
      note.textContent = '';
      toast('프로젝트를 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
    }
  }

  const renderList = (): void => {
    const q = input.value.trim().toLowerCase();
    const hits = rows.filter((r) => !q || r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q);
    const kids: HTMLElement[] = [];
    // 떼기 — 붙어 있을 때만, 목록 맨 위(검색과 무관하게 항상 보인다: 검색은 '붙일 것'을 찾는 행위지 떼기를 가리는 행위가 아니다).
    if (s.projectId) kids.push(el('button', { class: 'v2-pjpick-row v2-pjpick-none', type: 'button', role: 'option', onclick: () => void pick(null) },
      el('span', { class: 'n', text: '프로젝트에서 떼기' }), el('span', { class: 'm', text: '프로젝트 없음으로' })));
    for (const r of hits.slice(0, 50)) {
      const cur = Number(s.projectId) === Number(r.proj.id);
      kids.push(el('button', { class: 'v2-pjpick-row' + (cur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(cur), onclick: () => { if (!cur) void pick(r.proj.id); },
        title: r.proj.name + ' · #' + r.proj.id }, 
        el('span', { class: 'n', text: r.proj.name }),
        el('span', { class: 'm' }, el('span', { class: 'mono', text: '#' + r.proj.id }), r.done ? el('span', { class: 'v2-pjpick-done', text: '완료' }) : null, cur ? el('span', { class: 'v2-pjpick-cur', text: '✓ 지금' }) : null)));
    }
    if (hits.length > 50) kids.push(el('p', { class: 'v2-fine', text: `외 ${hits.length - 50}개 — 더 좁혀 검색하세요.` }));
    if (!kids.length) kids.push(el('p', { class: 'v2-fine', text: '조건에 맞는 프로젝트가 없어요.' }));
    listEl.replaceChildren(...kids);
  };
  input.oninput = renderList;
  // Enter = 첫 후보 선택(검색해서 바로 확정하는 손) · Esc 는 anchoredPopover 가 닫는다.
  input.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const first = listEl.querySelector('.v2-pjpick-row:not(.v2-pjpick-none):not(.cur)') as HTMLButtonElement | null;
      if (first) first.click();
    }
  };
  renderList();
  closePop = anchoredPopover(anchor, panel);
  window.setTimeout(() => input.focus(), 0);
}

// 미사용 경고 방지 — 라우터 밖에서도 뷰를 갱신하고 싶을 때 쓰는 진입점(툴바 등 후속용).
export function v2Refresh(): void { void loadData().then(() => { drawSide(); void route(); }); }
export function v2Toast(msg: string): void { toast(msg); }
export function v2View(): HTMLElement | null { return $view(); }
