// projects/detail-hub-tasks.ts — 허브 «태스크» 위젯(#4135, 5판 시안 2026-09-25 원준).
//  프로젝트 탭 태스크 목록(detail-tasks.pjvTasksSection)의 **줄을 그대로** 쓴다 — 호버 체크박스·호버 동작(세션 열기·⋯)·다중 선택
//  플로팅 바·묶음 맨 밑 「＋ 태스크」 인라인 추가가 위젯에서도 똑같이 돈다. 위젯은 «어느 묶음을 몇 줄 어떤 열로» 만 정한다(detail-hub-model).
//   1×1  «내 것 · 열림» 한 묶음 · 이름 + 오른쪽 열 하나(팀 설정, 기본 담당자) · 「⚙ 보기」 팝아웃 · 바닥 «… N개 더»
//   1×N  진행 중 · 할 일 묶음(설정으로 묶기 없음/내 것) · 1칸 열 하나 · ⚙ 보기
//   2×1  «이번 주 마감» 한 묶음 · 담당자 · 마감일
//   3×1  열림(진행 중 → 할 일) · 담당자(이름까지) · 마감일 · 우선순위
//   2×2+ 도구 줄(묶기 · 담당자 · 마감) + 진행 중 · 할 일 · 3칸 폭은 이름까지 + 커스텀 필드
//  완료는 어느 크기에도 안 그린다(«완료 N 는 접힘» 은 바닥 줄 글). 열 숨김은 프로젝트 탭과 같은 CSS 변수(columns.ts --pjv-w-*).
import { el } from '../core.js';
import { pjvPopover } from './popover.js';
import { type Fill, btn, footText, hubIcon } from './detail-hub-kit.js';
import {
  TASK_COLS, TASK_COL_LABEL, TASKS_PREF_DEFAULT, TASKS_PREF_KEY, type TaskColKey, type TaskGroupDef, type TasksViewPref,
  assigneesOf, dueThisWeek, isOverdue, normalizeTasksPref, rowsBudget, splitRows, taskColsFor, taskGroupsFor, tasksFootText,
} from './detail-hub-model.js';

function readPref(): TasksViewPref {
  try { return normalizeTasksPref(JSON.parse(localStorage.getItem(TASKS_PREF_KEY) || 'null')); } catch (_) { return { ...TASKS_PREF_DEFAULT }; }
}
function writePref(p: TasksViewPref): void {
  try { localStorage.setItem(TASKS_PREF_KEY, JSON.stringify(p)); } catch (_) { /* 저장 못 해도 화면은 선다 */ }
}
// 2칸 이상 도구 줄의 필터 — 페이지 안에서만 산다(프로젝트별). 새로고침하면 «전체».
const TOOLS: Map<number, { assignee: string; due: 'all' | 'week' | 'over' | 'none' }> = new Map();
const toolsOf = (pid: number) => { let t = TOOLS.get(pid); if (!t) { t = { assignee: '', due: 'all' }; TOOLS.set(pid, t); } return t; };

/** 열 폭 — 프로젝트 탭 기본(96·92·112)보다 한 단 좁게. 3칸 폭 담당자는 이름까지라 넓게. 숨긴 열은 0(격자 트랙이 사라진다). */
function colWidth(k: TaskColKey, w: number): string {
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
  const pref = readPref();
  const tools = toolsOf(pid);
  const total = tasks.length, done = tasks.filter((t) => t.status === 'done').length;
  const open = () => ctx.openTool('tasks');

  // 머리 부제 — 5판: 2×1 «마감: 이번 주» · 3×1 «상태: 열림» · 그 밖 «완료 / 전체».
  sub.textContent = (h <= 1 && w === 2) ? '마감: 이번 주' : (h <= 1 && w >= 3) ? '상태: 열림' : (total ? done + ' / ' + total + ' 완료' : '');

  // 「⚙ 보기」 — 1칸 폭에만(글자가 많아 산만하다는 5판 코멘트). 묶기 · 필터 · 오른쪽 열.
  if (w <= 1) {
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

  // 묶음 — 크기·설정으로 정하고(순수 모델), 2칸 이상 도구 줄의 필터(담당자·마감)를 그 위에 얹는다.
  let groups: TaskGroupDef[] = taskGroupsFor(tasks, w, h, pref, ctx.meId, now);
  const toolsRow = w >= 2 && h >= 2;
  if (toolsRow) {
    const byAssignee = (t: any) => !tools.assignee || (tools.assignee === 'me' ? assigneesOf(t).includes(ctx.meId) : assigneesOf(t).includes(tools.assignee));
    const weekIds = new Set(dueThisWeek(tasks, now).map((t) => String(t.id)));
    const byDue = (t: any) => tools.due === 'all' ? true : tools.due === 'week' ? weekIds.has(String(t.id)) : tools.due === 'over' ? isOverdue(t, now) : !t.due_date;
    groups = groups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => byAssignee(t) && byDue(t)) }));
  }
  const budget = rowsBudget(h, groups.length, toolsRow ? 30 : 0);
  const caps = splitRows(groups.map((g) => g.tasks.length), budget);
  const cols = taskColsFor(w, pref);
  const shown = caps.reduce((a, c) => a + c, 0);

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
    const memberItems: Array<[string, string]> = [['', '전체'], ...(ctx.meId ? [['me', '내 것'] as [string, string]] : []), ...(o.members || []).map((m) => [String(m.member_id), String(m.display_name || m.member_id)] as [string, string])];
    const assigneeLabel = !tools.assignee ? '전체' : tools.assignee === 'me' ? '내 것' : ctx.memberName(tools.assignee);
    const dueLabel = { all: '전체', week: '이번 주', over: '지남', none: '없음' }[tools.due];
    body.append(el('div', { class: 'pjh-tools' },
      chip('묶기', pref.group === 'status' ? '상태' : '없음', (b) => menuOf(b, [['status', '상태'], ['none', '없음']], pref.group, (v) => { writePref({ ...pref, group: v as TasksViewPref['group'] }); ctx.refreshGrid(); })),
      chip('담당자', assigneeLabel, (b) => menuOf(b, memberItems, tools.assignee, (v) => { tools.assignee = v; ctx.refreshGrid(); })),
      chip('마감', dueLabel, (b) => menuOf(b, [['all', '전체'], ['week', '이번 주'], ['over', '지남'], ['none', '없음']], tools.due, (v) => { tools.due = v as typeof tools.due; ctx.refreshGrid(); }))));
  }

  if (o.tasksList) {
    const sec = o.tasksList({
      chrome: false, groups, cap: caps, onMore: open,
      rowOpts: { assigneeNames: w >= 3 },
      fields: w >= 3 && h >= 2 ? (P.fields || []) : [],   // 커스텀 필드 열은 3×2 이상에서만 — 좁은 폭에선 이름을 먹는다
    });
    for (const k of TASK_COLS) sec.style.setProperty('--pjv-w-' + k, cols.includes(k) ? colWidth(k, w) : '0px');
    sec.style.setProperty('--pjv-name-min', w <= 1 ? '90px' : w === 2 ? '150px' : '200px');
    body.append(sec);
  } else {
    body.append(el('div', { class: 'pjh-stat', text: '태스크 목록을 그릴 수 없습니다(공장 없음).' }));
  }

  foot.append(footText(tasksFootText(tasks, w, h, shown, now, groups.reduce((a, g) => a + g.tasks.length, 0))), btn('태스크', 'btn-ghost', open));
};
