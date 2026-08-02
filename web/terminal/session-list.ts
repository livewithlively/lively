// terminal/session-list.ts — 목록을 이루는 것들: 프로젝트 **트리 필터**(폴더›리스트›프로젝트) · **세션 카드** · 질문 팝아웃/통합검색.
//  소비자: terminal/routes.ts + 대시보드 '내 AI 세션'(openSessPrompts — 배럴 terminal.ts 경유).
//  import 방향: status-filter·select-bar·session-form(전부 아래층)만 본다 — routes.ts 는 보지 않는다.
import { api, appUrl, el, toast } from '../core.js';
import { confirmDialog, overlay } from '../admin.js';
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

// 세션 카드(#745) — 라이브 상태점 + 라벨(작업) / 상태·시각·하네스·모델·폴더 + 프로젝트 칩 + 열기/관리.
//  선택(일괄삭제) 모드면 내 소유 카드에 체크박스(카드 전체가 토글 = label). 남의 세션은 체크박스 없음(삭제 불가).
function tsessCard(s, ctx) {
  const { cfg, view, projName, myProjIds, reRender, sel } = ctx;
  const st = TSESS_STATUS[s._st] || TSESS_STATUS.offline;
  // #1059 — restorable 이 '사용자 정상 종료(/exit)'로 생긴 경우 라벨·버튼을 구분한다('종료됨 · 대화 이어보기').
  //  재부팅·자동회수로 중단된 것은 기존대로 '복원 가능'. 복원(POST …/restore) 경로 자체는 둘 다 동일.
  const exitedByUser = !!(s.restorable && s.exitedByUser);
  const stLabel = st.label; // #1059 P1 — 라벨은 공용 정의가 결정한다(exited_user key 가 이미 '종료됨')
  // #1059 — 버튼은 '무엇을 할까'(행동). 상태 배지가 '무슨 일이 있었나'(중단됨/종료됨)를 말하므로 여기선 행동만.
  //  '복원'은 백업 복구 뉘앙스라 대화를 이어가는 일과 어긋난다(상민님 결정 2026-07-28).
  const restoreVerb = exitedByUser ? '다시 열기' : '이어서 열기';
  const harnessLabel = ((cfg.harnesses || []).find((h) => h.key === s.harness) || {}).label || s.harness || '셸';
  const model = (s.flags && s.flags['--model']) || '';
  const owner = memberName(cfg, s.owner) || s.owner || '?';
  const pid = Number(s.projectId) || 0;

  // ── 1행: 상태점 + 이름 + 프로젝트 칩 + 배지 ──
  const title = el('div', { class: 'tsess-title' },
    el('span', { class: 'tsess-dot tsess-dot-' + st.cls, title: stLabel }),
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
  bits.push(el('span', { class: 'tsess-stat tsess-stat-' + st.cls, text: stLabel }));
  const when = relAgo(s.lastActive || s.created);
  if (when) bits.push(el('span', { text: (s.lastActive ? '작업 ' : '') + when }));
  bits.push(el('span', { text: harnessLabel + (model ? '·' + model : '') }));
  if (s.dir) bits.push(el('span', { class: 'tsess-dir', title: s.dir, text: '📁 ' + shortDir(s.dir) }));
  const meta = el('div', { class: 'tsess-meta' });
  bits.forEach((b, i) => { if (i) meta.append(el('span', { class: 'tsess-sep', text: '·' })); meta.append(b); });

  const info = el('div', { class: 'tsess-info' }, ...[title, workTitle, meta].filter(Boolean));

  // 액션 — 열기/복원(항상) + 내 질문(노드 세션도 트랜스크립트 릴레이 #875 ③) + 소유자면 수정·종료/제거.
  const acts = el('div', { class: 'tsess-acts' });
  if (s.restorable && !s.owned) {
    // #1059 — 남의 중단된 세션: **보이지만** 되살리는 건 소유자 몫이다(restore 는 owner/admin 게이트).
    //  이제 프로젝트 세션의 중단된 것도 팀원 전원에게 보이므로(가시성=라이브 규칙) 이 분기가 필요하다.
    acts.append(el('span', { class: 'tsess-meta', title: '이 세션을 만든 사람만 다시 열 수 있어요', text: '소유자만 열기' }));
  } else if (s.restorable) {
    // #1059 E — 복원: 재부팅·회수로 꺼진 세션을 저장된 desired-state 로 재생성(claude 는 대화 이어받기). 새 세션을 연다.
    const rb = el('button', { class: 'tsess-open', text: restoreVerb, title: exitedByUser ? '내가 종료한 세션 — 저장된 대화를 이어서 엽니다 (같은 폴더·설정)' : '재부팅·자동회수로 중단된 세션을 다시 엽니다 (같은 폴더·설정 + 대화 이어받기)' }) as HTMLButtonElement;
    rb.onclick = async () => {
      rb.disabled = true; rb.textContent = '여는 중…';
      try {
        const r: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/restore', { method: 'POST', body: '{}' });
        // 라이브 경합(already) — 그새 다시 떠 있으면 새로 만들지 않고 그 세션을 그대로 연다(오success 방지).
        if (r && r.already) { window.open(termUrl(s.id, s.label, s.node && s.node.id), '_blank'); toast('세션이 이미 살아있어 그대로 엽니다'); reRender(); return; }
        const ns = r && r.session;
        if (ns && ns.id) window.open(termUrl(ns.id, ns.label || s.label), '_blank');
        // 정밀복원(UUID 매핑 有)이면 바로 그 대화로 이어지고, 미상이면 이어보기 목록이 뜬다 — 둘 다 안내.
        toast('열었어요 — 새 터미널에서 대화를 이어받아요(정확한 대화를 못 찾으면 목록에서 고르세요).'); reRender();
      } catch (e: any) { toast('열지 못했어요 — ' + (e && e.message || e), true); rb.disabled = false; rb.textContent = restoreVerb; }
    };
    acts.append(rb);
  } else {
    acts.append(el('button', { class: 'tsess-open', text: '열기', onclick: () => window.open(termUrl(s.id, s.label, s.node && s.node.id), '_blank') }));
  }
  acts.append(el('button', { class: 'tsess-icon tsess-q', title: '이 세션에서 AI 에게 보낸 질문 전부(누가 보냈든) 순서대로 모아보기', text: '질문', onclick: () => openSessPrompts(s) }));
  if (s.owned) {
    if (!s.restorable) acts.append(el('button', { class: 'tsess-icon', title: '이름·초대 수정', text: '수정', onclick: () => openTermEdit(s, cfg, view) }));
    // restorable 은 '복원 목록에서 제거'(desired-state 삭제), 라이브는 '종료'(tmux 종료, 대화록은 세션 기록에 남아 이어받기 가능). 둘 다 DELETE(백엔드가 gone→forget 처리).
    acts.append(el('button', { class: 'tsess-icon danger', title: s.restorable ? '복원 목록에서 제거' : '이 세션을 끝낸다(대화록은 세션 기록에 남아 나중에 이어받을 수 있음)', text: s.restorable ? '제거' : '종료', onclick: async () => {
      const ok = s.restorable
        ? await confirmDialog({ title: '‘' + (s.label || '이름 없음') + '’ 을(를) 복원 목록에서 제거할까요?', danger: true,
            confirmText: '제거', cancelText: '취소', message: '더는 이 세션을 복원할 수 없어요.' })
        : await tsessConfirmEnd('‘' + (s.label || '이름 없음') + '’ 세션을 종료할까요?');
      if (!ok) return;
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' }); toast(s.restorable ? '복원 목록에서 제거됨' : '세션을 종료했습니다 — 대화록은 📜 세션 기록에 남아 있어요'); reRender(); }
      catch (e) { toast('실패 — ' + e.message, true); }
    } }));
  }
  const box = el('div', { class: 'tsess-card tsess-' + st.cls + (s.attached ? ' attached' : '') + (sel && sel.ids.has(s.id) ? ' sel' : '') }, info, acts);
  // 선택 체크박스 — 대시보드 '내 AI 세션'과 같은 방식(#853 패턴, CSS도 한 벌을 공유):
  //  평소엔 폭 0 으로 숨어 있다가 카드에 호버(또는 포커스·선택됨·선택모드)하면 왼쪽에서 밀려 나온다.
  //  체크 하나만 해도 하단 플로팅 바가 뜨고, 다 풀면 사라진다 — '선택' 모드로 먼저 들어갈 필요가 없다.
  //  소유 세션만 — 종료는 소유자만 되므로(서버 403) 남의 카드엔 체크박스를 안 단다.
  if (sel && s.owned) {
    const cb: any = el('input', { type: 'checkbox', class: 'tsess-check dash-sess-check', 'aria-label': (s.label || '세션') + ' 선택' });
    cb.checked = sel.ids.has(s.id);
    cb.addEventListener('change', () => {
      if (cb.checked) sel.ids.add(s.id); else sel.ids.delete(s.id);
      box.classList.toggle('sel', cb.checked);
      for (const l of sel.listEls || []) l.classList.toggle('has-sel', sel.ids.size > 0);
      if (sel.onToggle) sel.onToggle();
    });
    const wrap = el('label', { class: 'tsess-checkwrap', title: '선택 — 누른 채 위아래로 끌면 여러 개가 한 번에 선택돼요 (Shift+클릭도 범위 선택)' }, cb);
    wrap.addEventListener('click', (ev) => ev.stopPropagation());
    box.prepend(wrap);
  }
  return box;
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
        item.onclick = () => window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(r.sessionId) + '&label=' + encodeURIComponent(r.label || ''), '_blank');
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
export { buildSessProjFilter, tsessCard, openGlobalPromptSearch };
