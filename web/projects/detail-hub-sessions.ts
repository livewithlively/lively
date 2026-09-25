// projects/detail-hub-sessions.ts — 허브 «터미널 세션» 위젯(#4135, 5판 시안 2026-09-25 원준).
//  줄 = 상태 점 · 이름 · 태스크 칩(이름 바로 뒤, 2칸 이상) · [입장|열기]·[태스크에 붙이기](이름 뒤 — 다른 열을 가리지 않는다) · 상태 · 사람(2칸+) · 마지막 활동(3칸).
//   1×1  지금 볼 세션 하나(확인 필요 → 작업 완료 → 작업 중 순) + 마지막 줄 + [입장], 그 아래 한 줄 더
//   1×N  «사용 중»·«최근» 묶음, 상태 열 하나
//   2×1 · 3×1  «세션» 한 묶음
//   2×2+ 도구 줄(묶기 · 상태 · 사람) + «태스크에 붙은 세션»·«태스크 없는 세션»
//   3×2+ 왼쪽 목록 + 오른쪽 «고른 세션»(태스크 · 사람·노드 · 상태 · 마지막 몇 턴 · [입장해서 답하기][세션 기록])
//  상태 어휘는 web/session-status.ts 한 벌(확인 필요 · 작업 완료 · 작업 중 · 대기 중 · 오프라인 · 셸 · 중단됨 · 메모리 부족 · 종료됨).
//  «태스크에 붙이기» = POST /v6/projects/:id/sessions/:sid/task {taskId}(세션 = 태스크 #4084 의 잇기 규칙 그대로).
import { api, el, personFace, relTime, toast } from '../core.js';
import { pjvPopover } from './popover.js';
import { type Fill, type SessView, btn, emptyNote, footText, hubIcon, lastLine, lastTurns, enterSession, sessDot, sessView } from './detail-hub-kit.js';
import { type SessionGroupDef, rowsBudget, sessionGroupsFor, sessionLastActivity, sessionTaskIndex, sortSessions, splitRows } from './detail-hub-model.js';

// 2칸 이상 도구 줄의 필터·묶기 — 페이지 안에서만 산다(프로젝트별).
const TOOLS: Map<number, { group: 'task' | 'state'; state: string; person: string; picked: string }> = new Map();
const toolsOf = (pid: number) => { let t = TOOLS.get(pid); if (!t) { t = { group: 'task', state: '', person: '', picked: '' }; TOOLS.set(pid, t); } return t; };

const STATE_FILTERS: Array<[string, string]> = [['', '전체'], ['waiting', '확인 필요'], ['busy', '작업 중'], ['done', '작업 완료'], ['idle', '대기 중'], ['off', '끝남·오프라인']];
const stateMatch = (v: SessView, filter: string): boolean => !filter ? true : filter === 'off' ? !v.live : v.key === filter;

export const fillSessions: Fill = (ctx, f, body, foot, sub, acts) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const tools = toolsOf(pid);
  const taskIdx = sessionTaskIndex(P.tasks || []);
  const hasTask = (s: any) => taskIdx.has(String(s.id));
  const openTasks: any[] = (P.tasks || []).filter((t: any) => t.status !== 'done');
  const memberName = ctx.memberName;
  const newBtn = () => btn('＋ 새 세션', 'btn-ghost', () => { if (o.newSession) o.newSession(); else ctx.openTool('sessions'); });
  const logBtn = () => btn('세션 기록', 'btn-ghost', () => { if (o.sessionLog) o.sessionLog(); else ctx.openTool('sessions'); });

  body.append(el('div', { class: 'pjh-stat', text: '세션을 불러오는 중' }));
  ctx.D.sessions().then((raw: any[]) => {
    body.replaceChildren();
    const now = Date.now();
    const views = new Map<string, SessView>();
    const V = (s: any): SessView => { let v = views.get(s.id); if (!v) { v = sessView(s, now); views.set(s.id, v); } return v; };
    const ss = sortSessions(raw, (s) => V(s).rank);
    const live = ss.filter((s) => V(s).live);
    const waiting = ss.filter((s) => V(s).key === 'waiting').length;
    const noTask = ss.filter((s) => !hasTask(s)).length;
    sub.textContent = !ss.length ? '' : (w <= 1 && h <= 1 && waiting) ? '확인 필요 ' + waiting : ss.length + (live.length ? ' · 사용 중 ' + live.length : '');
    if (!ss.length) {
      body.append(emptyNote('아직 이 프로젝트의 세션이 없습니다. ＋ 새 세션으로 시작하세요.'));
      foot.append(footText('세션 0'), newBtn());
      return;
    }

    // ── 태스크 칩 · 동작 단추 ──
    const taskChip = (s: any): HTMLElement | null => {
      const t = taskIdx.get(String(s.id));
      if (!t) return null;
      const c = el('button', { class: 'pjh-tb', type: 'button', title: '태스크: ' + t.name + ' — 누르면 태스크 열기' }, hubIcon('tasks', 11), el('span', { text: t.name }));
      c.onclick = (e) => { e.stopPropagation(); if (o.openTask) o.openTask(Number(t.id)); else location.hash = '#/projects2/t/' + t.id; };
      return c;
    };
    const attachBtn = (s: any): HTMLElement => {
      const b = el('button', { class: 'pjh-sbtn ghost', type: 'button', title: '이 세션을 이 프로젝트의 태스크에 잇는다(세션 = 태스크)' }, hubIcon('link', 12), '태스크에 붙이기');
      b.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjh-pop' });
        const close = pjvPopover(b, menu);
        menu.append(el('div', { class: 'pjh-pop-h', text: '어느 태스크에 붙일까요' }));
        if (!openTasks.length) { menu.append(el('div', { class: 'pjv-menu-hint', text: '열린 태스크가 없습니다 — 태스크 위젯에서 먼저 적으세요.' })); return; }
        const list = el('div', {});
        const paint = (q: string) => {
          list.replaceChildren(...openTasks.filter((t) => !q || String(t.name || '').toLowerCase().includes(q)).slice(0, 12).map((t) =>
            el('button', { class: 'pjv-menu-item', type: 'button', text: t.name || ('#' + t.id), onclick: async (ev: Event) => {
              ev.stopPropagation(); close();
              try {
                await api(o.base + pid + '/sessions/' + encodeURIComponent(s.id) + '/task', { method: 'POST', body: JSON.stringify({ taskId: t.id }) });
                toast('«' + (t.name || t.id) + '» 에 붙였습니다 — 태스크가 진행 중이 됩니다');
                o.reload();   // tasks[].sessions 가 바뀐다 — 상세 전체 재조회(태스크 위젯 칩도 같이 바뀐다)
              } catch (err: any) { toast('붙이지 못했습니다 — ' + (err && err.message || err), true); }
            } })));
        };
        if (openTasks.length > 6) {
          const q = el('input', { type: 'search', class: 'pjh-search-in', placeholder: '태스크 이름으로 찾기…' });
          q.addEventListener('input', () => paint(q.value.trim().toLowerCase()));
          menu.append(q);
          setTimeout(() => q.focus(), 0);
        }
        paint('');
        menu.append(list);
      };
      return b;
    };
    const enterBtn = (s: any, label?: string): HTMLElement => {
      const v = V(s);
      const b = el('button', { class: 'pjh-sbtn' + (v.live ? '' : ' ghost'), type: 'button' }, hubIcon('term', 12), label || (v.live ? '입장' : '열기'));
      b.onclick = (e) => { e.stopPropagation(); enterSession(s); };
      return b;
    };
    const ownerCell = (s: any): HTMLElement => el('span', { class: 'pjh-sr-c' }, personFace(s.owner, 'pjv-ava', memberName(s.owner)), el('span', { class: 'pjh-sr-cn', text: memberName(s.owner) }));
    const stateCell = (s: any): HTMLElement => el('span', { class: 'pjh-sr-c', text: V(s).label });
    const actCell = (s: any): HTMLElement => { const at = sessionLastActivity(s); return el('span', { class: 'pjh-sr-c', text: at ? relTime(new Date(at).toISOString()) : '' }); };

    // ── 1×1 — 지금 볼 세션 하나 + 한 줄 ──
    if (w <= 1 && h <= 1) {
      const first = ss[0], v = V(first);
      const line = el('div', { class: 'pjh-now-l', text: v.live ? '마지막 줄을 읽는 중…' : (v.label) });
      const meta = el('div', { class: 'pjh-now-m' }, hubIcon('monitor', 12), el('span', { text: (first.node ? (first.node.name || first.node.id) : '중앙') + ' · ' + v.label + (sessionLastActivity(first) ? ' · ' + relTime(new Date(sessionLastActivity(first)).toISOString()) : '') }),
        el('span', { style: 'margin-left:auto' }, enterBtn(first)));
      body.append(el('div', { class: 'pjh-now' },
        el('div', { class: 'pjh-now-t' }, sessDot(v), el('span', { class: 'pjh-sr-n', text: first.label || first.id }), personFace(first.owner, 'pjv-ava', memberName(first.owner))),
        line, meta));
      if (v.live) lastLine(first).then((t) => { line.textContent = t || v.label; });
      const second = ss[1];
      if (second) {
        const v2 = V(second);
        body.append(el('div', { class: 'pjh-sr pjh-sr-one', style: 'grid-template-columns:minmax(0,1fr) auto' },
          el('div', { class: 'pjh-sr-t' }, sessDot(v2), el('span', { class: 'pjh-sr-n', text: second.label || second.id }), el('span', { class: 'pjh-sr-acts' }, enterBtn(second))),
          el('span', { class: 'pjh-sr-c', text: v2.label + ' · ' + memberName(second.owner) })));
      }
      foot.append(footText('세션 ' + ss.length + (noTask ? ' · 태스크 없는 세션 ' + noTask : '')), newBtn());
      return;
    }

    // ── 목록(2칸 이상은 도구 줄) ──
    let groups: SessionGroupDef[] = sessionGroupsFor(ss, w, h, (s) => V(s).live, hasTask);
    const toolsRow = w >= 2 && h >= 2;
    if (toolsRow) {
      if (tools.group === 'state') groups = [{ key: 'live', label: '사용 중', sessions: ss.filter((s) => V(s).live) }, { key: 'recent', label: '최근', sessions: ss.filter((s) => !V(s).live) }];
      groups = groups.map((g) => ({ ...g, sessions: g.sessions.filter((s) => stateMatch(V(s), tools.state) && (!tools.person || (tools.person === 'me' ? s.owner === ctx.meId : s.owner === tools.person))) }));
    }
    const sidePane = w >= 3 && h >= 2;
    const budget = rowsBudget(h, groups.length, toolsRow ? 30 : 0);
    const caps = splitRows(groups.map((g) => g.sessions.length), budget);
    // 열 — 1칸: 상태 · 2칸: 상태·사람 · 3칸: 상태·사람·마지막 활동(옆 칸이 있으면 활동은 뺀다 — 자리가 좁다)
    const colDefs: Array<{ key: string; label: string; px: number; cell: (s: any) => HTMLElement }> = [
      { key: 'state', label: '상태', px: 74, cell: stateCell },
      ...(w >= 2 ? [{ key: 'owner', label: '사람', px: 104, cell: ownerCell }] : []),
      ...(w >= 3 && !sidePane ? [{ key: 'act', label: '마지막 활동', px: 92, cell: actCell }] : []),
    ];
    const gridCols = 'minmax(0,1fr) ' + colDefs.map((c) => c.px + 'px').join(' ');

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
      const people: Array<[string, string]> = [['', '전체'], ...(ctx.meId ? [['me', '나'] as [string, string]] : []), ...[...new Set(ss.map((s) => String(s.owner || '')))].filter(Boolean).map((id) => [id, memberName(id)] as [string, string])];
      body.append(el('div', { class: 'pjh-tools' },
        chip('묶기', tools.group === 'task' ? '태스크 연결' : '상태', (b) => menuOf(b, [['task', '태스크 연결'], ['state', '상태']], tools.group, (v) => { tools.group = v as 'task' | 'state'; ctx.refreshGrid(); })),
        chip('상태', (STATE_FILTERS.find((x) => x[0] === tools.state) || STATE_FILTERS[0])[1], (b) => menuOf(b, STATE_FILTERS, tools.state, (v) => { tools.state = v; ctx.refreshGrid(); })),
        chip('사람', !tools.person ? '전체' : tools.person === 'me' ? '나' : memberName(tools.person), (b) => menuOf(b, people, tools.person, (v) => { tools.person = v; ctx.refreshGrid(); }))));
    }

    const list = el('div', { class: 'pjh-slist' });
    let side: HTMLElement | null = null;
    const paintSide = (s: any) => {
      if (!side) return;
      const v = V(s); const t = taskIdx.get(String(s.id));
      const tail = el('div', { class: 'pjh-stail', text: v.live ? '마지막 줄을 읽는 중…' : '기록을 읽는 중…' });
      side.replaceChildren(
        el('div', { class: 'pjh-side-l', text: '고른 세션' }),
        el('div', { class: 'pjh-side-t' }, sessDot(v), el('span', { class: 'pjh-sr-n', text: s.label || s.id })),
        el('div', { class: 'pjh-kv' },
          el('b', { text: '태스크' }), el('span', { text: t ? t.name : '없음' }),
          el('b', { text: '사람' }), el('span', { text: memberName(s.owner) + ' · ' + (s.node ? (s.node.name || s.node.id) : '중앙') }),
          el('b', { text: '상태' }), el('span', { text: v.label + (sessionLastActivity(s) ? ' · ' + relTime(new Date(sessionLastActivity(s)).toISOString()) : '') })),
        el('div', { class: 'pjh-side-l', text: '마지막 줄' }),
        tail,
        el('div', { style: 'display:flex;gap:6px;flex:none' }, enterBtn(s, v.key === 'waiting' ? '입장해서 답하기' : undefined), t ? null : attachBtn(s), logBtn()));
      lastTurns(s, 4).then((turns) => {
        if (!turns.length) { tail.textContent = '읽을 대화가 없습니다.'; return; }
        tail.replaceChildren(...turns.map((x) => el('div', { class: 'pjh-stail-' + (x.who === 'ai' ? 'ai' : 'me'), text: (x.who === 'ai' ? '' : '› ') + x.text })));
      });
    };
    const srow = (s: any): HTMLElement => {
      const v = V(s);
      const r = el('div', { class: 'pjh-sr' + (sidePane && tools.picked === s.id ? ' on' : ''), style: 'grid-template-columns:' + gridCols },
        el('div', { class: 'pjh-sr-t' }, sessDot(v), el('span', { class: 'pjh-sr-n', text: s.label || s.id }), w >= 2 ? taskChip(s) : null,
          el('span', { class: 'pjh-sr-acts' }, enterBtn(s), hasTask(s) ? null : attachBtn(s))),
        ...colDefs.map((c) => c.cell(s)));
      if (sidePane) r.onclick = () => { tools.picked = s.id; list.querySelectorAll('.pjh-sr.on').forEach((x) => x.classList.remove('on')); r.classList.add('on'); paintSide(s); };
      return r;
    };
    groups.forEach((g, i) => {
      const cap = caps[i];
      if (!g.sessions.length && groups.length > 1 && !(w <= 1)) return;   // 빈 묶음은 접는다(1칸 폭은 «사용 중 0» 도 정보라 남긴다)
      list.append(el('div', { class: 'pjh-sg', style: 'grid-template-columns:' + gridCols },
        el('div', { class: 'pjh-sg-l' }, el('span', { text: g.label }), el('span', { class: 'pjh-sg-n', text: String(g.sessions.length) })),
        ...colDefs.map((c) => el('span', { class: 'pjh-sr-c', text: i === 0 ? c.label : '' }))));
      for (const s of g.sessions.slice(0, cap)) list.append(srow(s));
      if (g.sessions.length > cap) list.append(el('button', { class: 'pjv-more-row', type: 'button', text: '… ' + (g.sessions.length - cap) + '개 더', onclick: () => ctx.openTool('sessions') }));
    });

    if (sidePane) {
      side = el('div', { class: 'pjh-side' });
      body.append(el('div', { class: 'pjh-two-s' }, list, side));
      const picked = ss.find((s) => s.id === tools.picked) || ss[0];
      tools.picked = picked.id;
      list.querySelectorAll('.pjh-sr').forEach((x) => x.classList.remove('on'));
      paintSide(picked);
    } else {
      body.append(list);
    }
    // 목록 줄의 «마지막 줄» 은 안 싣는다(5판 — 줄이 좁다). 사용 중 세션의 상태 열이 그 역할이다.
    const footTxt = (w >= 2 ? '사용 중 ' + live.length + ' · 최근 ' + (ss.length - live.length) : '세션 ' + ss.length) + (noTask ? ' · 태스크 없는 세션 ' + noTask : '');
    foot.append(footText(footTxt), newBtn());
    if (w >= 2) foot.append(logBtn());
  });
};
