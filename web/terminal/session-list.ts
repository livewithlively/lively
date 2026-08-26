// terminal/session-list.ts — 목록을 이루는 것들: 프로젝트 **트리 필터**(폴더›리스트›프로젝트) · **세션 행**(프로젝트 표 문법, #1841) · 질문 팝아웃/통합검색.
//  소비자: terminal/routes.ts + 대시보드 '내 AI 세션'(openSessPrompts — 배럴 terminal.ts 경유).
//  import 방향: status-filter·select-bar·session-form(전부 아래층)만 본다 — routes.ts 는 보지 않는다.
import { api, el, sv, toast } from '../core.js';
import { pjvPopover } from '../projects/popover.js';   // #1841 행 ⋯ 메뉴 — 프로젝트 표와 같은 팝오버(리프 모듈, 순환 없음)
import { sessionTermUrl } from '../lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { overlay } from '../admin.js';
// #1582 — 세션 종료·목록제거 확인창은 전 화면 공용 정의 하나만 쓴다.
import { confirmSessionForget, endedToast } from '../session-actions.js';
import { TSESS_STATUS, relAgo, shortDir, tsessConfirmEnd } from './status-filter.js';
import { termUrl } from './select-bar.js';
import { memberName, openTermEdit } from './session-form.js';

// #1015 C — 검색형 프로젝트 필터(드롭다운 버튼 + 타이핑 검색). 값: 0=전체 · >0=projectId.
// #1015 C — 검색형 프로젝트 필터(드롭다운 + 타이핑 검색). 값: 0=전체 · >0=projectId.
//  #1098 후속 — 기본 뷰는 **사이드바와 같은 폴더 트리**(폴더 › 리스트 › 프로젝트). 처음엔 상위만 접힌 채로
//  보이고, 폴더를 눌러 안으로 들어간다 — 리스트로 나눠 늘어놓기만 하면 '정리된 뷰'로 안 보인다(상민님).
//  세션이 있는 프로젝트가 없는 가지는 통째로 감춘다(빈 서랍을 늘리지 않는다).
//  '최신순' 뷰로 토글하면 폴더를 무시하고 최근 갱신순 평면 목록. 검색은 두 뷰 모두에 걸리고,
//  폴더 뷰에서는 **매치가 있는 가지를 자동으로 펼친다**.
const TSESS_PROJVIEW_KEY = 'lively_term_projview_v1';
function tsessProjView(): 'list' | 'recent' { try { return localStorage.getItem(TSESS_PROJVIEW_KEY) === 'recent' ? 'recent' : 'list'; } catch { return 'list'; } }
function saveTsessProjView(v: string) { try { if (v === 'recent') localStorage.setItem(TSESS_PROJVIEW_KEY, 'recent'); else localStorage.removeItem(TSESS_PROJVIEW_KEY); } catch { /* noop */ } }
function buildSessProjFilter(opts: {
  projects: any[];                  // 전체 프로젝트(리스트·갱신시각 포함)
  projIds: any[];                   // 지금 세션이 있는 프로젝트 id — 여기 있는 것만 고를 값이 있다
  projName: Map<any, string>;
  lists: any[];                     // 리스트(영역)
  folders: any[];                   // 폴더(중첩 가능 — parent_id)
  current: number;
  onPick: (v: number) => void;
}) {
  const { projects, projIds, projName, lists, folders, current, onPick } = opts;
  const idSet = new Set(projIds.map((x) => Number(x)));
  const rows = projects.filter((p) => idSet.has(Number(p.id)));
  for (const id of idSet) if (!rows.some((p) => Number(p.id) === Number(id))) rows.push({ id, name: projName.get(id) || ('프로젝트 #' + id), list_id: 0, updated_at: null });
  const tsOf = (p) => { const t = Date.parse(p.updated_at || p.created_at || ''); return Number.isFinite(t) ? t : 0; };
  const listById = new Map<any, any>((lists || []).map((l) => [String(l.id), l]));
  const folderById = new Map<any, any>((folders || []).map((f) => [String(f.id), f]));
  const bySort = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'ko');

  // ── 트리 구성: 폴더(중첩) › 리스트 › 프로젝트. 세션이 있는 프로젝트가 없는 가지는 통째로 뺀다
  //  (필터에서 고를 값이 없는 폴더를 보여주면 '정리된 뷰'가 아니라 빈 서랍만 늘어난다).
  type Node = { key: string; kind: 'folder' | 'list'; name: string; sort: number; children: Node[]; projects: any[]; count: number };
  const mkNode = (key, kind, name, sort): Node => ({ key, kind, name, sort, children: [], projects: [], count: 0 });
  const folderNode = new Map<string, Node>();
  const listNode = new Map<string, Node>();
  const roots: Node[] = [];
  const orphanProjects: any[] = [];                    // 리스트 없는 프로젝트 = 최상위에 그대로 노출
  const ensureFolder = (fid: any): Node | null => {
    const f = folderById.get(String(fid));
    if (!f) return null;
    const k = 'f' + f.id;
    let n = folderNode.get(k);
    if (n) return n;
    n = mkNode(k, 'folder', f.name || '폴더', Number(f.sort) || 0);
    folderNode.set(k, n);
    const parent = f.parent_id != null ? ensureFolder(f.parent_id) : null;
    if (parent) parent.children.push(n); else roots.push(n);
    return n;
  };
  for (const p of rows) {
    const l = p.list_id != null ? listById.get(String(p.list_id)) : null;
    if (!l) { orphanProjects.push(p); continue; }
    const lk = 'l' + l.id;
    let ln = listNode.get(lk);
    if (!ln) {
      ln = mkNode(lk, 'list', l.name || '리스트', Number(l.sort) || 0);
      listNode.set(lk, ln);
      const fn = l.folder_id != null ? ensureFolder(l.folder_id) : null;
      if (fn) fn.children.push(ln); else roots.push(ln);
    }
    ln.projects.push(p);
  }
  const countUp = (n: Node): number => { n.count = n.projects.length + n.children.reduce((a, c) => a + countUp(c), 0); return n.count; };
  for (const r of roots) countUp(r);
  const prune = (ns: Node[]): Node[] => ns.filter((n) => n.count > 0).map((n) => ({ ...n, children: prune(n.children) }));
  const tree = prune(roots).sort(bySort);
  const hadSaved = (() => { try { return !!localStorage.getItem('lively_term_projtree_v1'); } catch { return false; } })();

  // 펼친 가지 — 브라우저에 기억한다(다음에 열면 보던 자리 그대로).
  const EXP_KEY = 'lively_term_projtree_v1';
  const loadExp = (): Set<string> => { try { const a = JSON.parse(localStorage.getItem(EXP_KEY) || '[]'); return new Set<string>(Array.isArray(a) ? a : []); } catch { return new Set<string>(); } };
  const saveExp = (e: Set<string>) => { try { if (e.size) localStorage.setItem(EXP_KEY, JSON.stringify([...e])); else localStorage.removeItem(EXP_KEY); } catch { /* noop */ } };
  const expanded = loadExp();
  //  아무것도 저장돼 있지 않은 첫 사용: **스페이스(최상위 폴더)는 펼친 채로** 시작한다 — 그래야 그 아래
  //  폴더까지 한눈에 보이고, 리스트·프로젝트는 눌러서 들어간다. 한 번이라도 여닫으면 그 선택을 따른다.
  const seedExpanded = (ns: Node[]) => { for (const n of ns) if (n.kind === 'folder') expanded.add(n.key); };
  if (!hadSaved) seedExpanded(tree);

  let view = tsessProjView();
  const cur = rows.find((p) => Number(p.id) === current);
  const wrap = el('div', { class: 'tsess-projfilter' });
  const btn = el('button', { type: 'button', class: 'tsess-projfilter-btn' + (current !== 0 ? ' active' : ''), title: '프로젝트로 필터' },
    el('span', { text: current === 0 ? '프로젝트' : (cur ? cur.name : projName.get(current) || ('프로젝트 #' + current)) }),
    el('span', { class: 'tsess-projfilter-chev', text: '▾' }));
  const dd = el('div', { class: 'tsess-projfilter-dd', hidden: true });
  const search = el('input', { type: 'search', class: 'tsess-projfilter-search', placeholder: '프로젝트 검색…' }) as HTMLInputElement;
  const seg = el('div', { class: 'tsess-projview-seg' });
  const listBox = el('div', { class: 'tsess-projfilter-list' });

  const projBtn = (p: any, depth: number, meta?: string) =>
    el('button', {
      class: 'tsess-projfilter-opt tsess-tree-proj' + (Number(p.id) === current ? ' active' : ''), type: 'button', title: p.name,
      style: depth ? 'padding-left:' + (10 + depth * 13) + 'px' : '',
      onmousedown: (e: any) => { e.preventDefault(); close(); if (Number(p.id) !== current) onPick(Number(p.id)); },
    }, el('span', { class: 'tsess-opt-name', text: p.name }), meta ? el('span', { class: 'tsess-opt-meta', text: meta }) : null);

  const renderList = (q: string) => {
    const ql = (q || '').trim().toLowerCase();
    const hit = (p) => !ql || String(p.name || '').toLowerCase().includes(ql);
    const nodes: any[] = [el('button', {
      class: 'tsess-projfilter-opt' + (current === 0 ? ' active' : ''), type: 'button',
      onmousedown: (e: any) => { e.preventDefault(); close(); if (current !== 0) onPick(0); },
    }, el('span', { class: 'tsess-opt-name', text: '프로젝트 전체' }))];

    if (view === 'recent') {
      // 최신순 — 폴더·리스트를 무시한 평면 목록. 어느 리스트인지는 회색 메타로.
      const flat = rows.filter(hit).sort((a, b) => tsOf(b) - tsOf(a));
      if (!flat.length) nodes.push(el('div', { class: 'tsess-projfilter-none', text: '일치하는 프로젝트가 없어요' }));
      for (const p of flat) nodes.push(projBtn(p, 0, (listById.get(String(p.list_id)) || {}).name || ''));
      listBox.replaceChildren(...nodes);
      return;
    }

    // 폴더 뷰 — 사이드바처럼 **접힌 채로** 시작한다. 폴더/리스트를 눌러 안으로 들어간다.
    //  검색 중에는 매치가 있는 가지를 자동으로 펼친다(찾은 걸 다시 클릭해서 열게 하면 검색이 검색이 아니다).
    let shown = 0;
    const walk = (ns: Node[], depth: number) => {
      for (const n of ns.slice().sort(bySort)) {
        const kids = n.children;
        const mine = n.projects.filter(hit).sort((a, b) => tsOf(b) - tsOf(a));
        const deepCount = (function cnt(x: Node): number { return x.projects.filter(hit).length + x.children.reduce((a, c) => a + cnt(c), 0); })(n);
        if (ql && !deepCount) continue;                 // 검색 중 매치 없는 가지는 숨긴다
        const open = ql ? true : expanded.has(n.key);
        const row = el('button', {
          class: 'tsess-tree-node tsess-tree-' + n.kind + (open ? ' open' : ''), type: 'button',
          style: depth ? 'padding-left:' + (8 + depth * 13) + 'px' : '',
          'aria-expanded': String(open), title: (n.kind === 'folder' ? '폴더: ' : '리스트: ') + n.name,
          onmousedown: (e: any) => {
            e.preventDefault(); e.stopPropagation();     // 가지를 여닫아도 드롭다운은 닫지 않는다
            if (expanded.has(n.key)) expanded.delete(n.key); else expanded.add(n.key);
            saveExp(expanded); renderList(search.value);
          },
        },
          el('span', { class: 'tsess-tree-caret', text: open ? '▾' : '▸' }),
          el('span', { class: 'tsess-tree-name', text: n.name }),
          el('span', { class: 'tsess-tree-n', text: String(deepCount) }));
        nodes.push(row); shown++;
        if (open) {
          walk(kids, depth + 1);
          for (const p of mine) { nodes.push(projBtn(p, depth + 1)); shown++; }
        }
      }
    };
    walk(tree, 0);
    const orphans = orphanProjects.filter(hit).sort((a, b) => tsOf(b) - tsOf(a));
    for (const p of orphans) { nodes.push(projBtn(p, 0)); shown++; }
    if (!shown) nodes.push(el('div', { class: 'tsess-projfilter-none', text: ql ? '일치하는 프로젝트가 없어요' : '고를 프로젝트가 없어요' }));
    listBox.replaceChildren(...nodes);
  };

  for (const [k, label, hint] of [['list', '폴더별', '사이드바처럼 폴더·리스트를 눌러 안으로 들어갑니다'], ['recent', '최신순', '폴더를 무시하고 최근에 갱신된 순서로 봅니다']] as [string, string, string][]) {
    const b = el('button', { class: 'tsess-projview-btn' + (view === k ? ' on' : ''), type: 'button', text: label, title: hint });
    b.onmousedown = (e: any) => {
      e.preventDefault(); e.stopPropagation();
      if (view === k) return;
      view = k as 'list' | 'recent'; saveTsessProjView(view);
      for (const x of [...seg.children]) x.classList.toggle('on', (x as any).textContent === (view === 'list' ? '폴더별' : '최신순'));
      renderList(search.value);
    };
    seg.append(b);
  }

  let docHandler: any = null;
  const close = () => { dd.hidden = true; if (docHandler) { document.removeEventListener('mousedown', docHandler); docHandler = null; } };
  const open = () => {
    dd.hidden = false; search.value = ''; renderList(''); search.focus();
    docHandler = (e: any) => { if (!wrap.contains(e.target)) close(); };
    document.addEventListener('mousedown', docHandler);
  };
  btn.addEventListener('click', () => (dd.hidden ? open() : close()));
  search.addEventListener('input', () => renderList(search.value));
  dd.append(search, seg, listBox);
  wrap.append(btn, dd);
  return wrap;
}

// 세션 행(#1841) — 프로젝트 탭의 리스트 행(.pjv-trow/.pjv-proj-row)과 **같은 문법**으로 그린다.
//  왜: 세 앱(AI 세션·프로젝트·WIKI)의 통일감은 콘텐츠를 다시 그리는 게 아니라 **같은 표 엔진·같은 머리·같은 크롬**에서 온다(원준 2026-08-24).
//  종전 카드(상태색 좌측 테두리 + 칩 + 버튼 4개)는 이 표의 한 행이 된다: [상태점 · 이름 · 지금 하는 일 · 사실 칩 | 상태 | 프로젝트 | 노드 | 마지막 작업 | 하네스 | 폴더 | 열기 ⋯].
//  행 hover 에 프로젝트 행과 같은 자리의 액션(질문·수정·종료)이 뜨고, ⋯ 메뉴가 같은 항목을 한 번 더 든다(hover 못 하는 기기).
//  선택(일괄) 모드면 앞에 체크박스(소유 세션만). 그리드 트랙은 TSESS_GRID 한 곳.
const TSESS_GRID = 'minmax(var(--pjv-name-min, 240px), 1fr) 96px 160px 120px 92px 100px 140px 112px';
const TSESS_COLS: Array<[string, string]> = [['state', '상태'], ['proj', '프로젝트'], ['node', '노드'], ['last', '마지막 작업'], ['harness', '하네스'], ['dir', '폴더']];
// 컬럼 헤더 한 줄 — 프로젝트 리스트의 pjvListColHead 와 같은 껍데기(.pjv-list-colhead). 정렬·숨김은 없다(고정 7열).
function tsessColHead() {
  const head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols pjv-list-colhead tsess-colhead' },
    el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-list-colhead-name', text: '세션' })),
    ...TSESS_COLS.map(([key, label]) => el('div', { class: 'pjv-tcell pjv-colhead pjv-stdcol', 'data-col': key }, el('span', { class: 'pjv-thcol-name', text: label, title: label }))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, el('span', {})));
  head.style.gridTemplateColumns = TSESS_GRID;
  return head;
}
// 행 액션 아이콘(선) — 프로젝트 행의 .pjv-row-act 와 같은 자리·크기. 이모지 대신 선 아이콘(질문=말풍선 · 수정=연필 · 종료=×).
function tsessActIcon(kind) {
  const n = sv('svg', { class: 'pjv-act-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  if (kind === 'q') n.append(sv('path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z' }));
  else if (kind === 'edit') n.append(sv('path', { d: 'M4 20h4.5L19 9.5a2 2 0 0 0 0-2.8l-1.7-1.7a2 2 0 0 0-2.8 0L4 15.5z' }), sv('path', { d: 'M13 6.5l4.5 4.5' }));
  else n.append(sv('path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }));
  return n;
}
function tsessRow(s, ctx) {
  const { cfg, view, projName, myProjIds, reRender, sel } = ctx;
  const st = TSESS_STATUS[s._st] || TSESS_STATUS.offline;
  const exitedByUser = !!(s.restorable && s.exitedByUser);
  const stLabel = st.label;
  // '복원'은 백업 복구 뉘앙스라 대화를 이어가는 일과 어긋난다(상민님 결정 2026-07-28) — 동사가 곧 상태.
  const restoreVerb = exitedByUser ? '다시 열기' : '이어서 열기';
  const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness || '셸';
  const model = (s.flags && s.flags['--model']) || '';
  const owner = memberName(cfg, s.owner) || s.owner || '?';
  const pid = Number(s.projectId) || 0;
  const openUrl = () => termUrl(s.id, s.label, s.node && s.node.id);

  // ── 동작(카드 때와 동일) ──
  const doOpen = () => window.open(openUrl(), '_blank');
  const doRestore = async (btn) => {
    btn.disabled = true; const keep = btn.textContent; btn.textContent = '여는 중…';
    try {
      const r: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST', body: '{}' });
      if (r && r.already) { doOpen(); toast('세션이 이미 살아있어 그대로 엽니다'); reRender(); return; }
      const ns = r && r.session;
      if (ns && ns.id) window.open(termUrl(ns.id, ns.label || s.label, ns.node && ns.node.id), '_blank');
      toast('열었어요 — 새 터미널에서 대화를 이어받아요(정확한 대화를 못 찾으면 목록에서 고르세요).'); reRender();
    } catch (e: any) { toast('열지 못했어요 — ' + (e && e.message || e), true); btn.disabled = false; btn.textContent = keep; }
  };
  const doEnd = async () => {
    const ok = s.restorable
      ? await confirmSessionForget({ title: '‘' + (s.label || '이름 없음') + '’ 을(를) 복원 목록에서 지울까요?', sessions: [s] })
      : await tsessConfirmEnd('‘' + (s.label || '이름 없음') + '’ 세션을 종료할까요?', [], [s]);
    if (!ok) return;
    try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' }); toast(s.restorable ? '복원 목록에서 지웠어요' : await endedToast(1, [s])); reRender(); }
    catch (e) { toast('실패 — ' + e.message, true); }
  };

  // ── 제목 셀: [체크] 상태점 · 이름 · 지금 하는 일 · 사실 칩 · (hover) 액션 ──
  const lead = el('span', { class: 'tsess-dot tsess-dot-' + st.cls, title: stLabel, 'aria-hidden': 'true' });
  const title = el('span', { class: 'pjv-trow-title clickable tsess-name', title: s.label, text: s.label || '(이름 없음)' });
  title.onclick = (e) => { e.stopPropagation(); if (s.restorable && !s.owned) return; if (s.restorable) return; doOpen(); };
  // '지금 하는 일'(백엔드 title = Claude Code pane 요약) — 라벨과 다를 때만, 이름 뒤에 흐리게(행 한 줄 유지).
  const work = (s.title && s.title !== s.label) ? el('span', { class: 'tsess-work', title: s.title, text: s.title }) : null;
  // 사실 칩 — 프로젝트 행의 하위 개수 칩(.pjv-trow-subcount)과 같은 모양. 접속중=민트 · 자동승인=앰버 · 노드 끊김=코랄 · 초대/소유자=회색.
  const chips: any[] = [];
  if (s.attached) chips.push(el('span', { class: 'pjv-trow-subcount tsess-chip live', text: '접속중' }));
  if (s.autoApprove) chips.push(el('span', { class: 'pjv-trow-subcount tsess-chip warn', text: '자동승인' }));
  if (!s.owned) chips.push(el('span', { class: 'pjv-trow-subcount tsess-chip', title: '소유: ' + owner, text: owner + (pid ? ' · 공동' : ' · 초대받음') }));
  else if ((s.invites || []).length) chips.push(el('span', { class: 'pjv-trow-subcount tsess-chip', title: s.invites.map((id) => memberName(cfg, id)).join(', '), text: '초대 ' + s.invites.length }));
  // hover 액션 — 프로젝트 행의 .pjv-row-actions/.pjv-row-act 와 같은 껍데기. 소유자면 수정·종료까지.
  const acts = el('span', { class: 'pjv-row-actions' });
  const act = (title, kind, fn) => { const b = el('button', { class: 'pjv-row-act', type: 'button', title, 'aria-label': title }, tsessActIcon(kind)); b.onclick = (e) => { e.stopPropagation(); fn(b); }; acts.append(b); };
  act('이 세션의 질문 모아보기', 'q', () => openSessPrompts(s));
  if (s.owned && !s.restorable) act('이름·초대 수정', 'edit', () => openTermEdit(s, cfg, view));
  if (s.owned) act(s.restorable ? '복원 목록에서 지우기' : '세션 종료', 'x', () => doEnd());

  let check: any = null;
  if (sel && s.owned) {
    // 선택 체크박스 — 대시보드 '내 AI 세션'과 같은 방식(#853): 평소 숨었다가 행 hover·선택모드·선택됨에 나온다. 드래그 범위 선택(#1140)은 routes 가 건다.
    check = el('input', { type: 'checkbox', class: 'tsess-check dash-sess-check', 'aria-label': (s.label || '세션') + ' 선택' });
    check.checked = sel.ids.has(s.id);
  }
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    check ? el('label', { class: 'tsess-checkwrap', title: '선택 — 누른 채 위아래로 끌면 여러 개가 한 번에 선택돼요 (Shift+클릭도 범위 선택)' }, check) : el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
    lead, title, work, ...chips, acts);
  // 제목 셀 전체가 클릭 영역(프로젝트 행과 동일) — 컨트롤은 제외.
  titleCell.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button, input, label, a, .pjv-row-actions, .pjv-trow-title')) return;
    if (sel && sel.mode && check) { check.click(); return; }
    if (!s.restorable) doOpen();
  });

  // ── 나머지 셀 ──
  const cell = (col, child, cls?) => el('div', { class: 'pjv-tcell tsess-cell' + (cls ? ' ' + cls : ''), 'data-col': col }, child);
  const stateCell = cell('state', el('span', { class: 'tsess-stat tsess-stat-' + st.cls, text: stLabel }));
  let projEl: any = el('span', { class: 'pjv-fval tsess-empty', 'aria-hidden': 'true' });
  if (pid) {
    const mine = myProjIds.has(pid);
    projEl = el('a', { class: 'tsess-proj' + (mine ? ' mine' : ''), href: '#/projects2/p/' + pid, target: '_blank', rel: 'noopener', title: (mine ? '내 프로젝트: ' : '프로젝트: ') + (projName.get(pid) || ('#' + pid)), text: projName.get(pid) || ('프로젝트 #' + pid) });
    projEl.onclick = (e) => e.stopPropagation();
  }
  const projCell = cell('proj', projEl);
  const nodeCell = cell('node', s.node
    ? el('span', { class: 'pjv-fval tsess-node' + (s.node.online ? '' : ' off'), title: '실행 노드: ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' — 연결 끊김(꺼짐/절전)'), text: (s.node.name || s.node.id) + (s.node.online ? '' : ' · 끊김') })
    : el('span', { class: 'pjv-fval tsess-muted', text: '박스' }));
  const when = relAgo(s.lastActive || s.created);
  const lastCell = cell('last', el('span', { class: 'pjv-fval', title: s.lastActive ? '마지막 작업' : '만든 시각', text: when }));
  const harnessCell = cell('harness', el('span', { class: 'pjv-fval', title: harnessLabel + (model ? ' · ' + model : ''), text: harnessLabel + (model ? ' · ' + model : '') }));
  const dirCell = cell('dir', s.dir ? el('span', { class: 'pjv-fval tsess-dir', title: s.dir, text: shortDir(s.dir) }) : el('span', { class: 'pjv-fval tsess-empty' }));

  // ── 마지막 칸: [열기 / 이어서 열기 / 다시 열기] + ⋯ ──
  const addCell = el('div', { class: 'pjv-tcell pjv-tcell-add tsess-actcell' });
  if (s.restorable && !s.owned) {
    addCell.append(el('span', { class: 'tsess-muted', title: '이 세션을 만든 사람만 다시 열 수 있어요', text: '소유자만' }));
  } else if (s.restorable) {
    const rb = el('button', { class: 'btn btn-ghost btn-sm tsess-open', type: 'button', text: restoreVerb, title: exitedByUser ? '내가 종료한 세션 — 저장된 대화를 이어서 엽니다 (같은 폴더·설정)' : '재부팅·자동회수로 중단된 세션을 다시 엽니다 (같은 폴더·설정 + 대화 이어받기)' }) as HTMLButtonElement;
    rb.onclick = (e) => { e.stopPropagation(); doRestore(rb); };
    addCell.append(rb);
  } else {
    addCell.append(el('button', { class: 'btn btn-ghost btn-sm tsess-open', type: 'button', text: '열기', onclick: (e) => { e.stopPropagation(); doOpen(); } }));
  }
  const more = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '세션 작업', text: '⋯' });
  more.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(more, menu, { align: 'right' });
    const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('질문 모아보기', () => openSessPrompts(s)));
    menu.append(mk('새 탭에서 열기', () => doOpen()));
    if (s.owned && !s.restorable) menu.append(mk('이름·초대 수정', () => openTermEdit(s, cfg, view)));
    if (s.owned) menu.append(mk(s.restorable ? '복원 목록에서 지우기' : '종료', () => doEnd(), true));
  };
  addCell.append(more);

  const row = el('div', { class: 'pjv-trow pjv-proj-row tsess-row tsess-' + st.cls + (s.attached ? ' attached' : '') + (sel && sel.ids.has(s.id) ? ' sel' : '') },
    titleCell, stateCell, projCell, nodeCell, lastCell, harnessCell, dirCell, addCell);
  row.style.gridTemplateColumns = TSESS_GRID;
  if (check) {
    check.addEventListener('change', () => {
      if (check.checked) sel.ids.add(s.id); else sel.ids.delete(s.id);
      row.classList.toggle('sel', check.checked);
      for (const l of sel.listEls || []) l.classList.toggle('has-sel', sel.ids.size > 0);
      if (sel.onToggle) sel.onToggle();
    });
    check.parentElement.addEventListener('click', (ev) => ev.stopPropagation());
  }
  const wrap = el('div', { class: 'pjv-trow-wrap tsess-wrap', 'data-sess-id': s.id }, row);
  return wrap;
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
// 질문 작성자 배지 — 백엔드가 준 author(멤버 슬러그, 공유 트리 출처는 빈 값)를 사람 이름으로.
//  이름은 /terminal/config 의 members 로 한 번만 조회해 캐시(팝업이 대시보드에서도 열리므로 cfg 를 못 받는다).
let _qMembers: any[] | null = null;
async function qMemberName(slug) {
  if (!slug) return '';
  if (_qMembers === null) { try { const c = await api('/api/ui/terminal/config'); _qMembers = (c && c.members) || []; } catch { _qMembers = []; } }
  const m = (_qMembers || []).find((x) => x.id === slug || String(x.id || '').toLowerCase() === slug);
  return (m && (m.name || m.id)) || slug;
}
// 작성자가 둘 이상일 때만 배지를 단다 — 혼자 쓴 세션에 배지를 붙이면 소음이다.
function qAuthorBadge(author, names) {
  if (!author || !names) return null;
  return el('span', { class: 'tsess-qwho', title: '이 질문을 보낸 사람', text: names.get(author) || author });
}
// 긴 질문 접기 — 항목을 리스트에 붙인 '뒤에' 호출한다(DOM 에 있어야 높이를 잰다). 8줄을 넘으면 접고
//  '더 보기' 토글을 단다. 넘지 않으면 clamp 를 떼고 아무것도 안 붙인다(짧은 질문은 그대로).
function qClampText(item, textEl) {
  textEl.classList.add('clamped');
  if (textEl.scrollHeight - textEl.clientHeight < 8) { textEl.classList.remove('clamped'); return; }
  const btn = el('button', { class: 'tsess-qmore', type: 'button', text: '더 보기' });
  btn.onclick = (ev) => {
    ev.stopPropagation();  // 통합검색 결과는 항목 자체가 '세션 열기' 버튼 — 펼치기가 새 탭을 열면 안 된다
    btn.textContent = textEl.classList.toggle('clamped') ? '더 보기' : '접기';
  };
  item.append(btn);
}
// 카드 '내 질문' 팝아웃(#745) — 이 세션에서 클로드에게 보낸 사용자 질문(프롬프트)만 시간순으로 모아 본다(위=최근).
//  백엔드가 ~/.claude 트랜스크립트에서 사람이 친 질문만 추출(툴결과·주입 메시지 제외). 접근통제는 서버 canAttach.
// 한 세션 '내 질문' 팝아웃 — 상단 검색으로 그 세션 질문을 즉시 필터(클라이언트). 최신이 위, #N=시간순 번호.
//  대시보드 '내 AI 세션' 카드의 ⋮ 메뉴도 이걸 그대로 재사용한다(#853) — 질문 보기 UI 를 두 벌 만들지 않는다.
export async function openSessPrompts(s) {
  const body = el('div', { class: 'tsess-qbody' }, el('div', { class: 'caption', text: '질문을 불러오는 중…' }));
  // '내 질문'이 아니라 '이 세션의 질문' — 백엔드가 이 세션 폴더의 모든 대화(공유 + 멤버별 프로필)를 합쳐
  //  누가 던졌든 사람 질문 전부를 준다. 여러 사람이 물었으면 항목에 작성자 배지가 붙는다.
  overlay('💬 이 세션의 질문 · ' + (s.label || '(이름 없음)'), body);
  try {
    const d = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompts' + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''));
    const prompts = (d && d.prompts) || [];
    const total = (d && d.total) || prompts.length;
    if (!prompts.length) {
      body.replaceChildren(el('div', { class: 'empty', text: (d && d.found) ? '이 세션에서 보낸 질문이 아직 없어요.' : '이 세션의 대화 기록을 찾지 못했어요.' }));
      return;
    }
    // 작성자가 2명 이상이면 이름 맵을 만들어 배지를 단다(1명이면 null → 배지 없음).
    const authors = [...new Set(prompts.map((p) => p.author).filter(Boolean))];
    let authorNames: Map<string, string> | null = null;
    if (authors.length > 1) {
      authorNames = new Map(await Promise.all(authors.map(async (a2) => [a2, await qMemberName(a2)] as [string, string])));
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
          const txt = qHighlight(p.text, null);
          const item = el('div', { class: 'tsess-qitem' },
            el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + (prompts.indexOf(p) + 1) }),
              ...[qAuthorBadge(p.author, authorNames)].filter(Boolean), el('span', { class: 'tsess-qwhen', text: qWhen(p.ts) })),
            txt);
          list.append(item);
          qClampText(item, txt);
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
        const txt = qHighlight(p.text, terms);
        const item = el('div', { class: 'tsess-qitem' },
          el('div', { class: 'tsess-qmeta' }, el('span', { class: 'tsess-qnum', text: '#' + chrono }),
            ...[qAuthorBadge(p.author, authorNames)].filter(Boolean), el('span', { class: 'tsess-qwhen', text: qWhen(p.ts) })),
          txt);
        list.append(item);
        qClampText(item, txt);
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
        const txt = qHighlight(r.text, ql);
        const item = el('div', { class: 'tsess-qitem tsess-gitem', role: 'button', tabindex: '0', title: '이 세션 열기' }, meta, txt);
        item.onclick = () => window.open(sessionTermUrl(r.sessionId, { label: r.label }), '_blank');
        results.append(item);
        qClampText(item, txt);
      });
    } catch (e) {
      if (input.value.trim() !== q) return;
      status.textContent = '검색 실패 — ' + (e && e.message || e);
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  setTimeout(() => input.focus(), 30);
}

// ── routes 가 쓰는 것 재수출(openSessPrompts 는 위에서 이미 export — 대시보드도 배럴로 그대로 쓴다). ──
export { buildSessProjFilter, tsessRow, tsessColHead, TSESS_GRID, openGlobalPromptSearch };
