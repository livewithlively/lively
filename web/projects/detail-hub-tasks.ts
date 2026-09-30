// projects/detail-hub-tasks.ts — 허브 «태스크» 위젯(#4135, 5판 시안 2026-09-25 원준).
//  프로젝트 탭 태스크 목록(detail-tasks.pjvTasksSection)의 **줄을 그대로** 쓴다 — 호버 체크박스·호버 동작(세션 열기·⋯)·다중 선택
//  플로팅 바·묶음 맨 밑 「＋ 태스크」 인라인 추가가 위젯에서도 똑같이 돈다. 위젯은 «어느 묶음을 어떤 열로» 만 정한다(detail-hub-model).
//   1×1  «내 것 · 열림» 한 묶음 · 이름 + 오른쪽 열 하나(팀 설정, 기본 담당자) · 「⚙ 보기」 팝아웃
//   1×N  진행 중 · 할 일 묶음(설정으로 묶기 없음/내 것) · 1칸 열 하나 · ⚙ 보기
//   2×1  «이번 주 마감» 한 묶음 · 담당자 · 마감일
//   3×1  열림(진행 중 → 할 일) · 담당자(이름까지) · 마감일 · 우선순위
//   2×2+ 도구 줄(묶기 · 담당자 · 마감) + 진행 중 · 할 일 · 3칸 폭은 이름까지 + 커스텀 필드
//   모달 도구 줄 + 찾기 + 「완료 보기」 · 모든 열(담당자 이름 · 마감일 · 우선순위 · 커스텀 필드) · 오른쪽 «한눈에»(진행 · 담당자별 · 마감 · 세션이 붙은 태스크)
//  ★ 줄 수를 자르지 않는다(2026-09-27 원준) — 많으면 **그 위젯 안에서 스크롤**. «… N개 더» 로 다른 화면에 보내지 않는다.
//  완료는 위젯에선 안 그린다(«완료 N 는 접힘» 은 바닥 줄 글) — 모달의 「완료 보기」 로 편다. 열 숨김은 프로젝트 탭과 같은 CSS 변수(columns.ts --pjv-w-*).
import { el, personFace } from '../core.js';
import { pjvPopover } from './popover.js';
import { type Fill, btn, footText, hubIcon, ring } from './detail-hub-kit.js';
import {
  TASK_COLS, TASK_COL_LABEL, TASKS_PREF_DEFAULT, TASKS_PREF_KEY, type TaskColKey, type TaskGroupDef, type TasksViewPref,
  assigneesOf, dueThisWeek, isOverdue, normalizeTasksPref, taskColsFor, taskGroupsFor, tasksFootText,
} from './detail-hub-model.js';

function readPref(): TasksViewPref {
  try { return normalizeTasksPref(JSON.parse(localStorage.getItem(TASKS_PREF_KEY) || 'null')); } catch (_) { return { ...TASKS_PREF_DEFAULT }; }
}
function writePref(p: TasksViewPref): void {
  try { localStorage.setItem(TASKS_PREF_KEY, JSON.stringify(p)); } catch (_) { /* 저장 못 해도 화면은 선다 */ }
}
// 2칸 이상 도구 줄의 필터 — 페이지 안에서만 산다(프로젝트별). 새로고침하면 «전체». q · done 은 모달에서만 쓴다.
type Tools = { assignee: string; due: 'all' | 'week' | 'over' | 'none'; q: string; done: boolean; sess: boolean };
const TOOLS: Map<number, Tools> = new Map();
const toolsOf = (pid: number): Tools => { let t = TOOLS.get(pid); if (!t) { t = { assignee: '', due: 'all', q: '', done: false, sess: false }; TOOLS.set(pid, t); } return t; };

/** 열 폭 — 프로젝트 탭 기본(96·92·112)보다 한 단 좁게. 3칸 폭 담당자는 이름까지라 넓게. 모달은 넉넉히. 숨긴 열은 0(격자 트랙이 사라진다). */
function colWidth(k: TaskColKey, w: number, modal: boolean): string {
  if (modal) return k === 'assignee' ? '150px' : k === 'due' ? '96px' : '108px';
  if (k === 'assignee') return w >= 3 ? '150px' : '52px';
  if (k === 'due') return '84px';
  return '100px';
}
/** 세그먼트 단추 한 벌 — 「⚙ 보기」 팝아웃의 한 줄. */
function seg<T extends string>(cur: T, opts: Array<[T, string]>, pick: (v: T) => void): HTMLElement {
  const box = el('span', { class: 'pjh-seg' });
  for (const [v, label] of opts) box.append(el('button', { type: 'button', class: v === cur ? 'on' : '', text: label, onclick: (e: Event) => { e.stopPropagation(); pick(v); } }));
  return box;
}

export const fillTasks: Fill = (ctx, f, body, foot, sub, acts) => {
  const { o, P, pid } = ctx;
  const tasks: any[] = P.tasks || [];
  const now = Date.now();
  const w = f.w, h = f.h;
  const modal = !!f.modal;
  const phone = modal && ctx.narrow;   // 좁은 화면의 모달 — 열은 담당자 얼굴 하나(이름·마감·우선순위는 태스크를 열어 본다)
  const hasSess = (t: any): boolean => Array.isArray(t.sessions) && t.sessions.length > 0;
  const pref = readPref();
  const tools = toolsOf(pid);
  const total = tasks.length, done = tasks.filter((t) => t.status === 'done').length;
  const open = () => ctx.openTool('tasks');

  // 머리 부제 — 5판: 2×1 «마감: 이번 주» · 3×1 «상태: 열림» · 그 밖 «완료 / 전체».
  const weekN = dueThisWeek(tasks, now).length;
  sub.textContent = (!modal && h <= 1 && w === 2) ? (weekN ? '마감: 이번 주' : '상태: 열림') : (!modal && h <= 1 && w >= 3) ? '상태: 열림' : (total ? done + ' / ' + total + ' 완료' : '');

  // 「⚙ 보기」 — 1칸 폭에만(글자가 많아 산만하다는 5판 코멘트). 묶기 · 필터 · 오른쪽 열.
  if (w <= 1 && !modal) {
    const cfg = el('button', { class: 'pjh-cfg', type: 'button', title: '보기 설정 — 묶기 · 필터 · 오른쪽 열' }, hubIcon('gear', 13), '보기');
    cfg.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu pjh-pop' });
      const close = pjvPopover(cfg, menu, { align: 'right' });
      const apply = (patch: Partial<TasksViewPref>) => { writePref({ ...pref, ...patch }); close(); ctx.refreshGrid(); };
      menu.append(el('div', { class: 'pjh-pop-h', text: '보기 설정' }),
        el('div', { class: 'pjh-pop-r' }, el('span', { text: '묶기' }), seg(pref.group, [['status', '상태'], ['none', '없음']], (v) => apply({ group: v }))),
        el('div', { class: 'pjh-pop-r' }, el('span', { text: '필터' }), seg(pref.filter, [['all', '전체'], ['mine', '내 것']], (v) => apply({ filter: v }))),
        el('div', { class: 'pjh-pop-r' }, el('span', { text: '오른쪽 열' }), seg(pref.col, TASK_COLS.map((k) => [k, TASK_COL_LABEL[k]] as [TaskColKey, string]), (v) => apply({ col: v }))));
    };
    acts.prepend(cfg);
  }

  if (!total) {
    body.append(el('div', { class: 'pjh-stat', style: 'padding:6px 2px', text: '아직 태스크가 없습니다. 아래 ＋ 태스크로 첫 할 일을 적으세요.' }));
  }

  // 묶음 — 크기·설정으로 정하고(순수 모델), 2칸 이상 도구 줄의 필터(담당자·마감)를 그 위에 얹는다. 모달은 찾기·완료까지.
  let groups: TaskGroupDef[] = taskGroupsFor(tasks, w, h, modal ? { ...pref, filter: 'all' } : pref, ctx.meId, now);
  const toolsRow = modal || (w >= 2 && h >= 2);
  const weekIds = new Set(dueThisWeek(tasks, now).map((t) => String(t.id)));
  const byAssignee = (t: any) => !tools.assignee || (tools.assignee === 'me' ? assigneesOf(t).includes(ctx.meId) : tools.assignee === 'none' ? !assigneesOf(t).length : assigneesOf(t).includes(tools.assignee));
  const byDue = (t: any) => tools.due === 'all' ? true : tools.due === 'week' ? weekIds.has(String(t.id)) : tools.due === 'over' ? isOverdue(t, now) : !t.due_date;
  const q = modal ? tools.q.trim().toLowerCase() : '';
  const byQ = (t: any) => !q || String(t.name || '').toLowerCase().includes(q);
  const bySess = (t: any) => !(modal && tools.sess) || hasSess(t);
  if (toolsRow) {
    if (modal && tools.done) groups = [...groups, { key: 'done', label: '완료', status: 'done', tasks: tasks.filter((t) => t.status === 'done'), add: false }];
    groups = groups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => byAssignee(t) && byDue(t) && byQ(t) && bySess(t)) }));
  }
  // 줄 수를 자르지 않는다 — 넘치면 목록 안에서 스크롤(37-projects-hub.css .pjv-tasks-body).
  const caps = groups.map((g) => g.tasks.length);
  const listed = groups.flatMap((g) => g.tasks);
  // 열 — 위젯: 보이는 줄에 값이 하나도 없는 열(마감일·우선순위)은 머리도 세우지 않는다. 1칸 폭은 고른 열 그대로. 모달: 전부(비어 있어도 그 자리에서 채울 수 있게).
  const hasVal = (k: TaskColKey) => k === 'assignee' || listed.some((t: any) => k === 'due' ? !!t.due_date : !!t.priority);
  const cols: TaskColKey[] = phone ? ['assignee'] : modal ? [...TASK_COLS] : taskColsFor(w, pref).filter((k) => w <= 1 || hasVal(k));
  const shown = listed.length;
  // 담당자 이름 — 프로젝트 구성원 목록에 없는 담당자는 명부 이름(ctx.memberName)으로 채워 넘긴다(아니면 줄에 id 가 선다).
  const known = new Set((o.members || []).map((m) => String(m.member_id)));
  const allAssignees = [...new Set(tasks.flatMap((t) => assigneesOf(t)))].filter(Boolean);
  const extraMembers = allAssignees.filter((id) => !known.has(id)).map((id) => ({ member_id: id, display_name: ctx.memberName(id) }));
  const members = extraMembers.length ? [...(o.members || []), ...extraMembers] : undefined;

  if (toolsRow) {
    const chip = (k: string, v: string, onclick: (b: HTMLElement) => void) => {
      const c = el('button', { class: 'pjh-chip', type: 'button' }, k + ' ', el('b', { text: v }), hubIcon('chev', 11));
      c.onclick = (e) => { e.stopPropagation(); onclick(c); };
      return c;
    };
    const menuOf = (anchor: HTMLElement, items: Array<[string, string]>, cur: string, pick: (v: string) => void) => {
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(anchor, menu);
      for (const [v, label] of items) menu.append(el('button', { class: 'pjv-menu-item' + (v === cur ? ' sel' : ''), type: 'button', text: label, onclick: (e: Event) => { e.stopPropagation(); close(); pick(v); } }));
    };
    const memberItems: Array<[string, string]> = [['', '전체'], ...(ctx.meId ? [['me', '내 것'] as [string, string]] : []),
      ...(members || o.members || []).map((m: any) => [String(m.member_id), String(m.display_name || m.member_id)] as [string, string]), ['none', '담당자 없음']];
    const assigneeLabel = !tools.assignee ? '전체' : tools.assignee === 'me' ? '내 것' : tools.assignee === 'none' ? '담당자 없음' : ctx.memberName(tools.assignee);
    const dueLabel = { all: '전체', week: '이번 주', over: '지남', none: '없음' }[tools.due];
    const row = el('div', { class: 'pjh-tools' },
      chip('묶기', pref.group === 'status' ? '상태' : '없음', (b) => menuOf(b, [['status', '상태'], ['none', '없음']], pref.group, (v) => { writePref({ ...pref, group: v as TasksViewPref['group'] }); ctx.refreshGrid(); })),
      chip('담당자', assigneeLabel, (b) => menuOf(b, memberItems, tools.assignee, (v) => { tools.assignee = v; ctx.refreshGrid(); })),
      chip('마감', dueLabel, (b) => menuOf(b, [['all', '전체'], ['week', '이번 주'], ['over', '지남'], ['none', '없음']], tools.due, (v) => { tools.due = v as Tools['due']; ctx.refreshGrid(); })));
    if (modal) {
      const doneChip = el('button', { class: 'pjh-chip' + (tools.done ? ' on' : ''), type: 'button', 'aria-pressed': String(tools.done), title: '끝낸 태스크도 목록에 편다' }, tools.done ? hubIcon('check', 11) : null, '완료 보기 ', el('b', { text: String(done) }));
      doneChip.onclick = () => { tools.done = !tools.done; ctx.refreshGrid(); };
      const find = el('input', { type: 'search', class: 'pjh-search-in', placeholder: '이름으로 찾기…', value: tools.q }) as HTMLInputElement;
      let timer: any = null;
      find.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { tools.q = find.value; ctx.refreshGrid(); }, 260); });
      row.append(doneChip, el('label', { class: 'pjh-search pjh-tools-find' }, hubIcon('search', 13), find));
      if (tools.q) setTimeout(() => { const n = document.querySelector('.pjh-modal .pjh-tools-find input') as HTMLInputElement | null; if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 0);
      if (tools.assignee || tools.due !== 'all' || tools.q || tools.sess) row.append(el('button', { class: 'pjh-kn-link', type: 'button', text: '필터 지우기', onclick: () => { tools.assignee = ''; tools.due = 'all'; tools.q = ''; tools.sess = false; ctx.refreshGrid(); } }));
    }
    body.append(row);
  }

  let listEl: HTMLElement;
  if (o.tasksList) {
    const sec = o.tasksList({
      chrome: false, groups, cap: caps, onMore: open, noMore: true, members,
      rowOpts: { assigneeNames: !phone && (modal || w >= 3) },
      fields: !phone && (modal || (w >= 3 && h >= 2)) ? (P.fields || []) : [],   // 커스텀 필드 열은 3×2 이상·모달에서만 — 좁은 폭에선 이름을 먹는다
    });
    for (const k of TASK_COLS) sec.style.setProperty('--pjv-w-' + k, cols.includes(k) ? (phone ? '52px' : colWidth(k, w, modal)) : '0px');
    sec.style.setProperty('--pjv-name-min', phone ? '120px' : modal ? '320px' : w <= 1 ? '90px' : w === 2 ? '150px' : '200px');
    const scroller = (sec.querySelector('.pjv-tasks-body') as HTMLElement | null) || sec;
    scroller.setAttribute('data-mscroll', 'tasks');
    listEl = sec;
  } else {
    listEl = el('div', { class: 'pjh-stat', text: '태스크 목록을 그릴 수 없습니다(공장 없음).' });
  }

  if (!modal) {
    body.append(listEl);
    foot.append(footText(tasksFootText(tasks, w, h, shown, now, shown)), btn('태스크', 'btn-ghost', open));
    return;
  }

  // ── 모달 — 위 «한눈에» 띠(진행 · 담당자별 · 마감 · 세션 — 누르면 그걸로 거른다) + 아래 목록(모든 열, 전폭).
  //   오른쪽 레일로 뒀더니 목록 폭이 600px 로 줄어 이름이 잘렸다(화면 폭 ≈ 1000) — 목록이 주인이라 요약은 위 띠로. ──
  const openList = tasks.filter((t) => t.status !== 'done');
  const inprog = openList.filter((t) => t.status === 'in_progress').length;
  const over = openList.filter((t) => isOverdue(t, now)).length;
  const noDue = openList.filter((t) => !t.due_date).length;
  const byPerson = allAssignees.map((id) => ({ id, n: openList.filter((t) => assigneesOf(t).includes(id)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const unassigned = openList.filter((t) => !assigneesOf(t).length).length;
  const withSess = openList.filter(hasSess);
  const setAssignee = (v: string) => { tools.assignee = tools.assignee === v ? '' : v; ctx.refreshGrid(); };
  const setDue = (v: Tools['due']) => { tools.due = tools.due === v ? 'all' : v; ctx.refreshGrid(); };
  const sumChip = (label: any, n: number | string, on: boolean, pick: () => void, tone = ''): HTMLElement =>
    el('button', { class: 'pjh-sum-c' + (on ? ' on' : '') + (tone ? ' ' + tone : ''), type: 'button', 'aria-pressed': String(on), onclick: pick }, el('span', { class: 'pjh-sum-k' }, label), el('b', { text: String(n) }));
  const strip = el('div', { class: 'pjh-sum' },
    el('div', { class: 'pjh-sum-g prog' }, ring(total ? done / total : 0, 40, 6),
      el('div', {}, el('div', { class: 'pjh-sum-big' }, String(done), el('small', { text: ' / ' + total + ' 끝냄' })), el('div', { class: 'pjh-rail-fine', text: '진행 중 ' + inprog + ' · 할 일 ' + (openList.length - inprog) }))),
    el('div', { class: 'pjh-sum-g' }, el('div', { class: 'pjh-rail-h', text: '담당자 · 열린 태스크' }), el('div', { class: 'pjh-sum-row' },
      ...byPerson.map((x) => sumChip(el('span', { class: 'pjh-rail-who' }, personFace(x.id, 'pjv-ava', ctx.memberName(x.id)), ctx.memberName(x.id)), x.n, tools.assignee === x.id, () => setAssignee(x.id))),
      unassigned ? sumChip('없음', unassigned, tools.assignee === 'none', () => setAssignee('none')) : null)),
    el('div', { class: 'pjh-sum-g' }, el('div', { class: 'pjh-rail-h', text: '마감' }), el('div', { class: 'pjh-sum-row' },
      sumChip('지남', over, tools.due === 'over', () => setDue('over'), over ? 'danger' : ''),
      sumChip('이번 주', weekIds.size, tools.due === 'week', () => setDue('week')),
      sumChip('없음', noDue, tools.due === 'none', () => setDue('none')))),
    el('div', { class: 'pjh-sum-g' }, el('div', { class: 'pjh-rail-h', text: '세션' }), el('div', { class: 'pjh-sum-row' },
      sumChip(el('span', { class: 'pjh-rail-who' }, hubIcon('term', 12), '붙은 태스크'), withSess.length, tools.sess, () => { tools.sess = !tools.sess; ctx.refreshGrid(); }))));
  body.append(strip, el('div', { class: 'pjh-mmain' }, listEl));
  foot.append(footText(phone ? '보이는 줄 ' + shown + ' · 열림 ' + openList.length + ' · 완료 ' + done + (tools.done ? '' : ' 접힘')
    : '보이는 줄 ' + shown + ' · 열림 ' + openList.length + ' · 마감 지남 ' + over + ' · 완료 ' + done + (tools.done ? '' : ' 는 접힘') + ' — 줄을 누르면 태스크가 열립니다'));
};
