// projects/detail-hub.ts — 프로젝트 상세 = **도구 위젯 허브** (#3916, 2026-09-14 원준 결정: "원안(안 5 허브)이 제일 낫다 ·
//  카드 크기·배치를 설정에서 · 크기에 맞춰 뷰가 완전히 다르게, 휴대폰 위젯처럼").
//
//  화면 = 속성 띠(detail-meta.ts pjvProjFactsStrip, detail.ts 가 세운다) 아래 **3열 격자**에 도구 위젯 여섯(태스크·세션·본문·
//  공유 폴더·연결된 지식·작업 타임라인). 크기가 곧 뷰다:
//   S 1×1 «한눈»  수 하나 + 상태 한 줄 + 다음 행동      M 2×1 «목록»  행 넷·다섯 + 동작
//   L 2×2 «조작»  기존 섹션 렌더러를 그대로 앉힌다      XL 3×1 «띠»   전폭(세션은 함대 카드, 나머진 섹션)
//  배치(순서·크기·숨김)는 detail-hub-layout.ts 가 저장한다(내 계정 전역 한 벌 · «이 프로젝트에서만» 토글). 편집 모드는 iOS 홈
//  편집 문법 — 손잡이(⋮⋮)를 끌어 순서, 단추 [S M L XL] 로 크기, × 로 숨김, 「＋ 위젯」 슬롯으로 되살림, 프리셋은 시작점.
//
//  ⚠ 의존 방향: 이 모듈은 섹션 렌더러(detail-tasks·detail-terminal·detail-folder·detail-body·detail-sections)를 **직접 물지 않는다** —
//   그것들은 배럴(projects.ts)을 되짚어 새 순환을 만든다(scripts/check-imports.mjs). detail.ts 가 **공장(sections)** 으로 넣어 준다.
//   여기서 import 하는 것은 리프뿐(core · v2/sess-tail · files-icons · files-format · icons · popover · status · detail-hub-layout).
//  ⚠ 열기(→ 도구 전폭)는 페이지에선 주소(#/projects2/p/:id/<도구>)로, 모달(.pjv-pm) 안에선 제자리 전환으로 — 모달은 자기 주소를
//   소유하므로(#808) 해시를 바꾸면 라우터가 모달을 닫는다.
import { api, el, personFace, relTime, sv, toast } from '../core.js';
import { openSessionWindow } from '../lib/session-open.js';
import { fetchTurns } from '../v2/sess-tail.js';
import { fileThumb } from './files-icons.js';
import { fmtSize } from './files-format.js';
import { pjvPopover } from './popover.js';
import { PJV_PRIORITY, pjvFmtDate, pjvIsOverdue, pjvStatusIconStd } from './status.js';
import {
  HUB_PRESETS, HUB_SIZES, HUB_SIZE_LABEL, HUB_TOOL_LABEL, HUB_TOOLS, applyHubPreset, effectiveHubSize, hideHubItem, loadHubLayout,
  matchHubPreset, moveHubItem, resetHubLayout, resizeHubItem, saveHubLayout, setHubScope, showHubItem,
  type HubLayout, type HubSize, type HubTool,
} from './detail-hub-layout.js';

export type HubSectionFactory = () => HTMLElement;
export interface HubOpts {
  id: number;
  p: any;                       // GET /api/ui/v6/projects/:id 의 프로젝트(tasks · knowledge · description · updated_at …)
  members: any[];
  reload: () => void;           // 상세 전체 재렌더(기존 섹션들이 쓰는 그 reload)
  base: string;                 // '/api/ui/v6/projects/'
  sections: Record<HubTool, HubSectionFactory>;   // L·XL 과 «열기»가 앉히는 기존 섹션 카드
  inModal: boolean;             // .pjv-pm 안이면 열기는 제자리 전환
  focus: HubTool | null;        // 주소가 가리키는 «열기» 도구(페이지)
  actionsHost?: HTMLElement;    // [배치 편집] 단추를 앉힐 자리(뒤로 줄 오른쪽)
}

// ── 아이콘 — 24 그리드 · 획 1.7(projects/icons.ts 톤) ─────────────────────────
const HUB_ICON: Record<string, string> = {
  tasks: '<path d="M4 6.5h9M4 12h9M4 17.5h6"/><path d="M15 12.5l2.4 2.4L22 10"/>',
  sessions: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
  body: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  knowledge: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M8 7h7"/>',
  timeline: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevr: '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  comment: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  chev: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
};
const TOOL_TONE: Record<HubTool, string> = { tasks: 'amber', sessions: 'mint', body: '', folder: 'blue', knowledge: 'mint', timeline: '' };
function hubIcon(name: string, size = 14): SVGElement {
  const n = sv('svg', { class: 'pjh-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true', style: 'width:' + size + 'px;height:' + size + 'px' });
  n.innerHTML = HUB_ICON[name] || HUB_ICON.doc;
  return n;
}
const PRIORITY: Record<string, { label: string; cls: string }> = PJV_PRIORITY as any;

// ── 작은 부품 ─────────────────────────────────────────────────────────────────
const btn = (label: string, kind = 'btn-ghost', onclick?: (e: Event) => void, extra?: any) =>
  el('button', { class: 'btn btn-sm ' + kind, type: 'button', text: label, onclick, ...(extra || {}) });
const stripMd = (md: string): string => String(md || '')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '').replace(/[*_`]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ').trim();
const lastHeading = (md: string): string | null => {
  const hs = String(md || '').split('\n').filter((l) => /^#{1,6}\s+\S/.test(l));
  return hs.length ? hs[hs.length - 1].replace(/^#{1,6}\s+/, '').trim() : null;
};
function ring(pct: number, s = 52, sw = 6): SVGElement {
  const r = (s - sw) / 2, c = 2 * Math.PI * r;
  const n = sv('svg', { class: 'pjh-ring', viewBox: '0 0 ' + s + ' ' + s, style: 'width:' + s + 'px;height:' + s + 'px', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', stroke: 'var(--line-net)', 'stroke-width': sw }));
  n.append(sv('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', stroke: 'var(--mint-fill)', 'stroke-width': sw, 'stroke-linecap': 'round',
    'stroke-dasharray': (c * Math.max(0, Math.min(1, pct))).toFixed(1) + ' ' + c.toFixed(1), transform: 'rotate(-90 ' + s / 2 + ' ' + s / 2 + ')' }));
  return n;
}
const big = (n: string | number, unit: string, lead?: HTMLElement | SVGElement) =>
  el('div', { class: 'pjh-big' }, lead || null, String(n), el('small', { text: unit }));
const stat = (...kids: any[]) => el('div', { class: 'pjh-stat' }, ...kids);
const row = (...kids: any[]) => el('div', { class: 'pjh-row' }, ...kids);
const emptyNote = (text: string) => el('div', { class: 'pjh-stat', style: 'padding:6px 2px', text });

// 세션 상태 어휘 — 새 셸 .v2-dot 과 같은 셋(도는 중 · 확인 필요 · 끝남) + 열려 있음 + 쉬는 중.
function sessState(s: any): { cls: string; label: string; live: boolean } {
  const st = s.agentState;
  if (s.working || st === 'busy') return { cls: 'busy', label: '작업 중', live: true };
  if (s.awaiting || st === 'waiting') return { cls: 'wait', label: '확인 필요', live: true };
  if (s.attached) return { cls: 'busy', label: '사용 중', live: true };
  if (st === 'exited') return { cls: 'done', label: '끝남', live: false };
  return { cls: 'off', label: '쉬는 중', live: false };
}
const sessDot = (s: any): HTMLElement => {
  const st = sessState(s);
  return st.live && st.cls === 'busy' ? el('span', { class: 'pjh-pulse', title: st.label }) : el('span', { class: 'pjh-dot ' + st.cls, title: st.label });
};
// 세션 «입장» — 세션 터미널로 가는 단 하나의 문(lib/session-open, #1820): 죽은 세션 복원은 도착지가 책임진다.
const enter = (s: any): void => { openSessionWindow(String(s.id), { label: s.label, node: s.node && s.node.id ? String(s.node.id) : null }); };
// 도는 세션의 마지막 줄 — v2 셸의 꼬리 읽기(v2/sess-tail)를 빌린다. 좌표(uuid·노드)가 없으면 빈 채로 둔다(꾸미지 않는다).
async function lastLine(s: any): Promise<string> {
  try {
    const onNode = !!(s.node && s.node.id);
    const adapted: any = { id: s.id, live: !!s.attached && !onNode, node: onNode ? s.node.id : undefined, raw: s };
    const turns = await fetchTurns(adapted, 6000);
    const ai = [...turns].reverse().find((t) => t.who === 'ai' && t.text.trim().length > 2);
    return ai ? ai.text.trim().replace(/\s+/g, ' ').slice(0, 180) : '';
  } catch (_) { return ''; }
}

// ══ 허브 ══════════════════════════════════════════════════════════════════════
export function mountProjectHub(host: HTMLElement, o: HubOpts): void {
  const pid = o.id;
  const P = o.p || {};
  const tasks: any[] = P.tasks || [];
  const kn = P.knowledge || { required: [], produced: [] };

  // 데이터 — 위젯마다 따로 부르지 않고 허브가 한 번 받아 나눠 준다(같은 화면에서 같은 것을 두 번 묻지 않는다).
  const lazy = <T,>(fn: () => Promise<T>): (() => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ||= fn()); };
  const D = {
    sessions: lazy(() => api(o.base + pid + '/sessions').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[])),
    files: lazy(() => api(o.base + pid + '/files?path=').then((d: any) => (d && d.items) || []).catch(() => [] as any[])),
    acts: lazy(() => api(o.base + pid + '/activity').then((d: any) => (d && d.activities) || []).catch(() => [] as any[])),
    comments: lazy(() => api('/api/ui/v6/projects/' + pid + '/comments').then((d: any) => ((d && d.feed) || []).filter((f: any) => f && f.kind === 'comment')).catch(() => [] as any[])),
    recs: lazy(() => api('/api/ui/v6/projects/' + pid + '/recommend-knowledge?limit=2').then((d: any) => (d && d.entries) || []).catch(() => [] as any[])),
  };
  const memberName = (mid: string): string => { const m = (o.members || []).find((x) => x.member_id === mid); return (m && m.display_name) || mid || ''; };

  // 배치 상태
  let { layout, scope } = loadHubLayout(pid);
  let editing = false;
  let focus: HubTool | null = o.focus;
  const mq = window.matchMedia('(max-width: 900px)');
  let narrow = mq.matches;

  const commit = (next: HubLayout): void => { layout = next; saveHubLayout(pid, layout, scope); renderGrid(); };
  const openTool = (tool: HubTool | null): void => {
    if (o.inModal) { focus = tool; render(); return; }
    location.hash = '#/projects2/p/' + pid + (tool ? '/' + tool : '');
  };

  // ── 위젯 한 장 ──
  function widget(tool: HubTool, size: HubSize): HTMLElement {
    const eff = effectiveHubSize(size, narrow);
    const card = el('div', { class: 'pjh-w ' + size, 'data-tool': tool });
    const sub = el('span', { class: 'pjh-wh-sub' });
    const acts = el('span', { class: 'pjh-wh-acts' });
    const openBtn = el('button', { class: 'pjh-open', type: 'button', title: HUB_TOOL_LABEL[tool] + ' 전폭으로 열기', onclick: () => openTool(tool) }, '열기 ', hubIcon('right', 13));
    acts.append(openBtn);
    const head = el('div', { class: 'pjh-wh' },
      el('span', { class: 'pjh-wh-ic ' + TOOL_TONE[tool] }, hubIcon(tool, 16)),
      el('span', { class: 'pjh-wh-name', text: HUB_TOOL_LABEL[tool] }), sub, acts);
    const body = el('div', { class: 'pjh-wb' });
    const foot = el('div', { class: 'pjh-wf' });
    card.append(head, body, foot);
    if (eff === 'l' || eff === 'xl') {
      if (tool === 'sessions' && eff === 'xl') fillSessionsFleet(body, foot, sub);
      else embedSection(tool, body, foot, sub);
    } else {
      const fill = FILL[tool];
      fill(eff, body, foot, sub);
    }
    if (editing) decorateEdit(card, tool, size);
    return card;
  }

  // L·XL — 기존 섹션 카드를 그대로 앉힌다. 카드 크롬은 CSS(.pjh-wb > .card)가 벗기고, 머리의 동작 단추는 위젯 바닥 줄로 옮긴다.
  function embedSection(tool: HubTool, body: HTMLElement, foot: HTMLElement, sub: HTMLElement): void {
    const sec = o.sections[tool]();
    body.append(sec);
    const head = sec.querySelector(':scope > .card-head');
    if (head) {
      const left = head.querySelector('.pjv-tasks-head-left');
      const moved: Element[] = [];
      if (left) for (const kid of Array.from(left.children)) if (kid.tagName !== 'H2' && kid.tagName !== 'H3') moved.push(kid);
      const actsBox = head.querySelector('.card-head-actions');
      if (actsBox) for (const kid of Array.from(actsBox.children)) moved.push(kid);
      const hint = head.querySelector('.pjk-head-hint');
      if (hint) foot.append(el('span', { class: 'pjh-wf-txt', text: hint.textContent || '' }));
      const box = el('span', { class: 'pjh-wf-acts', style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none' });
      for (const kid of moved) box.append(kid);
      foot.append(box);
    }
    const txt = el('span', { class: 'pjh-wf-txt', text: subFor(tool) || FOOT_NOTE[tool] });
    foot.prepend(txt);
    sub.textContent = subFor(tool);
    if (tool === 'sessions') D.sessions().then((ss: any[]) => { const live = ss.filter((x) => sessState(x).live).length; sub.textContent = ss.length ? ss.length + (live ? ' · 사용 중 ' + live : '') : ''; txt.textContent = '세션 ' + ss.length; });
    else if (tool === 'folder') D.files().then((items: any[]) => { const dirs = items.filter((i) => i.type === 'dir').length; sub.textContent = items.length ? String(items.length - dirs) + (dirs ? ' · 폴더 ' + dirs : '') : ''; });
    else if (tool === 'timeline') D.acts().then((acts: any[]) => { sub.textContent = acts.length ? String(acts.length) : ''; });
  }
  const FOOT_NOTE: Record<HubTool, string> = { tasks: '할 일', sessions: '세션', body: '본문 · 코멘트', folder: '루트', knowledge: '필요 → 산출', timeline: '이 프로젝트에 연결된 작업만' };
  function subFor(tool: HubTool): string {
    if (tool === 'tasks') { const t = tasks.length, d = tasks.filter((x) => x.status === 'done').length; return t ? d + ' / ' + t + ' 완료' : ''; }
    if (tool === 'body') return P.updated_at ? '갱신 ' + relTime(P.updated_at) : '';
    if (tool === 'knowledge') return '필요 ' + (kn.required || []).length + ' → 산출 ' + (kn.produced || []).length;
    return '';
  }

  // ── S·M 뷰 — 도구마다 «그 크기의 일» ──
  type Fill = (size: HubSize, body: HTMLElement, foot: HTMLElement, sub: HTMLElement) => void;
  const FILL: Record<HubTool, Fill> = {
    tasks(size, body, foot, sub) {
      const total = tasks.length, done = tasks.filter((t) => t.status === 'done').length;
      const open = tasks.filter((t) => t.status !== 'done');
      const next = open.filter((t) => t.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0];
      sub.textContent = String(total);
      if (!total) {
        body.append(emptyNote('아직 태스크가 없습니다. 열어서 첫 할 일을 적으세요.'));
        foot.append(el('span', { class: 'pjh-wf-txt', text: '할 일 0' }), btn('태스크', 'btn-ghost', () => openTool('tasks')));
        return;
      }
      if (size === 's') {
        body.append(el('div', { class: 'pjh-fig' }, ring(done / total), el('div', {},
          big(done, '/ ' + total + ' 완료'),
          next ? stat(el('b', { text: '다음 마감 ' + pjvFmtDate(next.due_date) }), el('br'), next.name + (next.assignee ? ' · ' + memberName(next.assignee) : ''))
            : stat('열린 태스크 ' + open.length))));
        foot.append(el('span', { class: 'pjh-wf-txt', text: '진행 중 ' + open.filter((t) => t.status === 'in_progress').length + ' · 할 일 ' + open.filter((t) => t.status !== 'in_progress').length }),
          btn('태스크', 'btn-ghost', () => openTool('tasks')));
        return;
      }
      const list = [...open.filter((t) => t.status === 'in_progress'), ...open.filter((t) => t.status !== 'in_progress')].slice(0, 5);
      for (const t of list) {
        const pr = t.priority && PRIORITY[t.priority];
        const nameEl = el(o.inModal ? 'span' : 'a', { class: 'pjh-row-n pjh-row-link', text: t.name, ...(o.inModal ? {} : { href: '#/projects2/t/' + t.id }) });
        body.append(row(pjvStatusIconStd(t.status, 'sm'), nameEl,
          t.subtasks && t.subtasks.length ? el('span', { class: 'pjv-trow-subcount', text: String(t.subtasks.length) }) : null,
          pr ? el('span', { class: 'pjv-flag ' + pr.cls }, el('span', { class: 'pjv-flag-label', text: pr.label })) : null,
          t.assignee ? personFace(t.assignee, 'pjv-ava', memberName(t.assignee)) : null,
          t.due_date ? el('span', { class: 'pjh-due' + (pjvIsOverdue(t) ? ' over' : ''), text: pjvFmtDate(t.due_date) }) : null));
      }
      if (open.length > 5) body.append(emptyNote('… 열린 태스크 ' + (open.length - 5) + '개 더'));
      foot.append(el('span', { class: 'pjh-wf-txt', text: '완료 ' + done + ' · 열림 ' + open.length }), btn('태스크', 'btn-ghost', () => openTool('tasks')));
    },
    sessions(size, body, foot, sub) {
      body.append(el('div', { class: 'pjh-stat', text: '세션을 불러오는 중' }));
      D.sessions().then(async (ss: any[]) => {
        body.replaceChildren();
        const live = ss.filter((s) => sessState(s).live);
        sub.textContent = ss.length ? ss.length + (live.length ? ' · 사용 중 ' + live.length : '') : '';
        if (!ss.length) {
          body.append(emptyNote('아직 이 프로젝트의 세션이 없습니다. 열어서 ＋ 새 세션으로 시작하세요.'));
          foot.append(el('span', { class: 'pjh-wf-txt', text: '세션 0' }), btn('세션', 'btn-ghost', () => openTool('sessions')));
          return;
        }
        const first = live[0] || ss[0];
        if (size === 's') {
          body.append(big(live.length, '사용 중', el('span', { class: live.length ? 'pjh-pulse' : 'pjh-dot off' })));
          const l = stat(el('b', { text: first.label || first.id }), el('span', { class: 'pjh-clamp2', style: 'display:block' }));
          body.append(l);
          if (sessState(first).live) lastLine(first).then((t) => { if (t) (l.lastChild as HTMLElement).textContent = t; });
          foot.append(el('span', { class: 'pjh-wf-txt', text: '세션 ' + ss.length }),
            sessState(first).live ? btn('입장', 'btn-primary', () => enter(first)) : btn('세션', 'btn-ghost', () => openTool('sessions')));
          return;
        }
        for (const s of ss.slice(0, 5)) {
          const st = sessState(s);
          const line = el('span', { class: 'pjh-row-l' });
          const r = row(sessDot(s), el('span', { class: 'pjh-row-n b', text: s.label || s.id }), line,
            el('span', { class: 'pjh-row-m', text: st.live ? st.label : (s.created ? relTime(new Date(s.created * 1000).toISOString()) : '') }),
            btn('입장', st.live ? 'btn-primary' : 'btn-ghost', () => enter(s)));
          body.append(r);
          if (st.live) lastLine(s).then((t) => { if (t) line.textContent = t; });
        }
        foot.append(el('span', { class: 'pjh-wf-txt', text: '만든이 ' + [...new Set(ss.map((s) => memberName(s.owner)))].filter(Boolean).slice(0, 3).join(' · ') }),
          btn('세션', 'btn-ghost', () => openTool('sessions')));
      });
    },
    body(size, body, foot, sub) {
      const md = String(P.description || '');
      sub.textContent = subFor('body');
      const h = lastHeading(md);
      const text = stripMd(md);
      if (size === 's') {
        body.append(el('div', { class: 'pjh-stat-t', text: h || text.slice(0, 80) || '본문이 비어 있습니다.' }));
        body.append(stat((md.split('\n').filter((l) => /^#{1,6}\s+\S/.test(l)).length || 1) + '절' + (P.updated_at ? ' · 갱신 ' + relTime(P.updated_at) : '')));
      } else {
        body.append(el('div', { class: 'pjh-excerpt' }, h ? el('b', { text: h + ' — ' }) : null, text.slice(0, 320) || '본문이 비어 있습니다. 열어서 적으세요.'));
      }
      const tail = el('div', { class: 'pjh-tail' });
      body.append(tail);
      const cnt = el('span', { class: 'pjh-wf-txt' }, hubIcon('comment', 13), '코멘트');
      foot.append(cnt, btn('본문', 'btn-ghost', () => openTool('body')));
      D.comments().then((cs: any[]) => {
        cnt.append(' ' + cs.length);
        const last = cs[cs.length - 1];
        if (!last) return;
        if (size === 's') tail.append(row(personFace(last.actor, 'pjv-ava', last.display_name), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: stripMd(last.body || '') })));
        else tail.append(el('div', { class: 'pjh-cmt' }, personFace(last.actor, 'pjv-cmt-mini-ava', last.display_name),
          el('div', { class: 'pjh-cmt-b' }, el('div', { class: 'pjh-cmt-h' }, el('b', { text: last.display_name || last.actor || '' }), el('span', { text: last.ts ? relTime(last.ts) : '' })),
            el('div', { class: 'pjh-cmt-t', text: stripMd(last.body || '') }))));
      });
    },
    folder(size, body, foot, sub) {
      body.append(el('div', { class: 'pjh-stat', text: '파일을 불러오는 중' }));
      D.files().then((items: any[]) => {
        body.replaceChildren();
        const files = items.filter((i) => i.type !== 'dir'), dirs = items.filter((i) => i.type === 'dir');
        sub.textContent = items.length ? String(files.length) + (dirs.length ? ' · 폴더 ' + dirs.length : '') : '';
        if (!items.length) {
          body.append(emptyNote('아직 올린 파일이 없습니다. 열어서 끌어다 놓거나 업로드하세요.'));
          foot.append(el('span', { class: 'pjh-wf-txt', text: '루트' }), btn('폴더', 'btn-ghost', () => openTool('folder')));
          return;
        }
        const latest = [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
        if (size === 's') {
          body.append(big(files.length, '파일'));
          if (latest) body.append(stat(el('b', { text: '최근 ' + (latest.mtime ? relTime(new Date(latest.mtime).toISOString()) : '') }), el('br'), latest.name + (latest.size != null ? ' · ' + fmtSize(latest.size) : '')));
        } else {
          const grid = el('div', { class: 'pjh-files' });
          for (const it of [...dirs, ...files].slice(0, 6)) {
            grid.append(el('div', { class: 'proj-file-card', title: it.name, onclick: () => openTool('folder') },
              el('div', { class: 'proj-file-card-ic' }, fileThumb(pid, it, it.name, o.base)),
              el('div', { class: 'proj-file-card-nm', text: it.name }),
              it.type === 'dir' ? null : el('div', { class: 'proj-file-sz', text: fmtSize(it.size || 0) })));
          }
          body.append(grid);
        }
        foot.append(el('span', { class: 'pjh-wf-txt', text: '루트' + (items.length > 6 ? ' · ' + items.length + '개' : '') }), btn('폴더', 'btn-ghost', () => openTool('folder')));
      });
    },
    knowledge(size, body, foot, sub) {
      const req: any[] = kn.required || [], prod: any[] = kn.produced || [];
      sub.textContent = subFor('knowledge');
      const recBox = el('div', {});
      if (size === 's') {
        body.append(el('div', { class: 'pjh-big' }, String(req.length), el('span', { class: 'pjh-arrow', text: '→' }), String(prod.length), el('small', { text: '필요 → 산출' })));
        const st = stat('연결하면 AI 가 그 문서를 읽은 상태로 시작합니다');
        body.append(st, recBox);
        const first = prod[0] || req[0];
        if (first) body.append(row(hubIcon('doc', 14), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: first.title || first.name }),
          el('span', { class: 'pjh-kn-rel', text: prod[0] ? '산출' : '필요' })));
        D.recs().then((rs: any[]) => { if (rs.length) st.replaceChildren(el('b', { text: '추천 ' + rs.length }), ' — 연결하면 AI 가 읽고 시작합니다'); });
      } else {
        for (const k of [...prod.map((k) => ({ ...k, rel: '산출' })), ...req.map((k) => ({ ...k, rel: '필요' }))].slice(0, 4)) {
          body.append(row(hubIcon('doc', 14), el('a', { class: 'pjh-row-n pjh-row-link', href: '#/knowledge/' + encodeURIComponent(k.name), text: k.title || k.name }),
            el('span', { class: 'pjh-kn-rel' + (k.rel === '필요' ? '' : ''), text: k.rel })));
        }
        body.append(recBox);
        D.recs().then((rs: any[]) => {
          for (const r of rs) {
            const link = el('button', { class: 'pjh-kn-link', type: 'button', text: '연결' });
            link.onclick = async () => {
              link.disabled = true;
              try { await api('/api/ui/v6/projects/' + pid + '/knowledge', { method: 'POST', body: JSON.stringify({ name: r.name, relation: 'required' }) }); toast('필요 지식으로 연결했습니다'); o.reload(); }
              catch (e: any) { toast('연결 실패 — ' + e.message, true); link.disabled = false; }
            };
            recBox.append(row(hubIcon('doc', 14), el('span', { class: 'pjh-row-n', style: 'font-weight:500;color:var(--ink-sub)', text: r.title || r.name }),
              el('span', { class: 'pjh-kn-pct', text: r.similarity != null ? Math.round(r.similarity * 100) + '%' : '' }), link));
          }
          if (!prod.length && !req.length && !rs.length) body.append(emptyNote('연결된 지식이 없습니다. 열어서 ＋ 지식 연결로 시작하세요.'));
        });
      }
      foot.append(el('span', { class: 'pjh-wf-txt', text: '필요 ' + req.length + ' · 산출 ' + prod.length }), btn('지식 연결', 'btn-ghost', () => openTool('knowledge')));
    },
    timeline(size, body, foot, sub) {
      body.append(el('div', { class: 'pjh-stat', text: '기록을 불러오는 중' }));
      D.acts().then((acts: any[]) => {
        body.replaceChildren();
        sub.textContent = acts.length ? String(acts.length) : '';
        if (!acts.length) {
          body.append(emptyNote('아직 이 프로젝트의 작업 기록이 없습니다.'));
          foot.append(el('span', { class: 'pjh-wf-txt', text: '이 프로젝트에 연결된 작업만' }), btn('전체 보기', 'btn-ghost', () => openTool('timeline')));
          return;
        }
        const when = (a: any) => a.committed_at || a.created_at || '';
        if (size === 's') {
          const a = acts[0];
          body.append(big(acts.length, '기록'));
          body.append(stat(el('b', { text: '마지막 ' + (when(a) ? relTime(when(a)) : '') }), el('br'), (a.summary || a.title || '') + (a.author_person ? ' · ' + memberName(a.author_person) : '')));
        } else {
          for (const a of acts.slice(0, 3)) {
            const d = when(a) ? new Date(when(a)) : null;
            body.append(el('a', { class: 'pjh-lg', href: '#', onclick: (e: Event) => { e.preventDefault(); openTool('timeline'); } },
              el('span', { class: 'pjh-lg-t' }, d ? (d.getMonth() + 1) + '/' + d.getDate() : '', el('br'), d ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : ''),
              el('span', { class: 'pjh-lg-b' }, el('span', { class: 'pjh-lg-title', text: a.summary || a.title || '(제목 없음)' }),
                el('span', { class: 'pjh-lg-meta', text: [a.type, memberName(a.author_person), a.author_agent].filter(Boolean).join(' · ') })),
              el('span', { class: 'pjh-lg-r' }, hubIcon('chevr', 14))));
          }
        }
        foot.append(el('span', { class: 'pjh-wf-txt', text: '이 프로젝트에 연결된 작업만' }), btn('전체 보기', 'btn-ghost', () => openTool('timeline')));
      });
    },
  };

  // XL 세션 = 함대 — 세션마다 카드 하나(상태·마지막 줄·노드·[입장]).
  function fillSessionsFleet(body: HTMLElement, foot: HTMLElement, sub: HTMLElement): void {
    body.append(el('div', { class: 'pjh-stat', text: '세션을 불러오는 중' }));
    D.sessions().then((ss: any[]) => {
      body.replaceChildren();
      const live = ss.filter((s) => sessState(s).live);
      sub.textContent = ss.length ? ss.length + (live.length ? ' · 사용 중 ' + live.length : '') : '';
      if (!ss.length) { body.append(emptyNote('아직 이 프로젝트의 세션이 없습니다.')); }
      const fleet = el('div', { class: 'pjh-fleet' });
      for (const s of [...live, ...ss.filter((s) => !sessState(s).live)].slice(0, 6)) {
        const st = sessState(s);
        const l = el('div', { class: 'pjh-fl-l', text: st.label });
        fleet.append(el('div', { class: 'pjh-fl' + (st.live ? ' live' : '') },
          el('div', { class: 'pjh-fl-t' }, sessDot(s), el('span', { text: s.label || s.id }), s.harness ? el('span', { class: 'pjh-hb', text: s.harness }) : null),
          l,
          el('div', { class: 'pjh-fl-m' }, hubIcon('monitor', 12), (s.node ? (s.node.name || s.node.id) + (s.node.online === false ? ' (끊김)' : '') : '중앙') + ' · 만든이 ' + memberName(s.owner)),
          el('div', { class: 'pjh-fl-a' }, btn(st.live ? '입장' : '열기', st.live ? 'btn-primary' : 'btn-ghost', () => enter(s)))));
        if (st.live) lastLine(s).then((t) => { if (t) l.textContent = t; });
      }
      body.append(fleet);
      // 바닥 줄엔 기존 섹션의 동작(새 세션·세션 기록)이 있어야 한다 — 섹션을 숨겨 세워 두고 단추만 빌린다.
      const sec = o.sections.sessions();
      sec.hidden = true; sec.classList.add('pjh-hidden-sec'); body.append(sec);
      const actsBox = sec.querySelector(':scope > .card-head .card-head-actions');
      const box = el('span', { style: 'margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none' });
      if (actsBox) for (const kid of Array.from(actsBox.children)) box.append(kid);
      foot.append(el('span', { class: 'pjh-wf-txt', text: '세션 ' + ss.length }), box);
    });
  }

  // ── 편집 모드 크롬 ──
  function decorateEdit(card: HTMLElement, tool: HubTool, size: HubSize): void {
    const sizes = el('span', { class: 'pjh-sizes', role: 'group', 'aria-label': '크기' });
    for (const z of HUB_SIZES) sizes.append(el('button', { type: 'button', text: z.toUpperCase(), title: HUB_SIZE_LABEL[z], 'aria-pressed': String(z === size),
      onclick: (e: Event) => { e.stopPropagation(); if (z !== size) commit(resizeHubItem(layout, tool, z)); } }));
    const hide = el('button', { class: 'pjh-hide', type: 'button', title: '숨기기', 'aria-label': HUB_TOOL_LABEL[tool] + ' 숨기기', onclick: (e: Event) => { e.stopPropagation(); commit(hideHubItem(layout, tool)); } }, hubIcon('x', 13));
    card.prepend(el('div', { class: 'pjh-edtools' }, el('span', { class: 'pjh-grip', title: '끌어서 순서 바꾸기' }), el('span', { class: 'pjh-edtools-sp' }), hide, sizes));
    card.draggable = true;
    card.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', tool); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    card.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault(); card.classList.remove('over');
      const src = e.dataTransfer?.getData('text/plain') as HubTool;
      if (src && src !== tool && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, tool));
    });
  }
  function editBar(): HTMLElement {
    const presetBtn = el('button', { class: 'pjh-preset', type: 'button' }, hubIcon('grid', 13), '프리셋' + (matchHubPreset(layout) ? ' · ' + (HUB_PRESETS.find((p) => p.id === matchHubPreset(layout)) || HUB_PRESETS[0]).label : ''), hubIcon('chev', 12));
    presetBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu pjh-preset-pop' });
      const close = pjvPopover(presetBtn, menu);
      const cur = matchHubPreset(layout);
      for (const p of HUB_PRESETS) {
        const mini = el('span', { class: 'pjh-pm' });
        for (const it of p.items) mini.append(el('i', { class: (it.size === 'm' ? 'c2' : it.size === 'l' ? 'c2 r2' : it.size === 'xl' ? 'c3' : '') + (it.tool === 'tasks' ? ' a' : '') }));
        menu.append(el('button', { class: 'pjh-preset-row' + (cur === p.id ? ' on' : ''), type: 'button', onclick: () => { close(); commit(applyHubPreset(p.id)); } }, mini, el('span', { text: p.label })));
      }
    };
    const sw = el('button', { class: 'pjh-sw', type: 'button', role: 'switch', 'aria-checked': String(scope === 'project'),
      onclick: () => { const r = setHubScope(pid, scope === 'project' ? 'global' : 'project', layout); layout = r.layout; scope = r.scope; render(); } },
      el('i'), '이 프로젝트에서만');
    return el('div', { class: 'pjh-edbar' }, hubIcon('grid', 15),
      el('span', {}, el('b', { text: '배치 편집' }), ' — 손잡이(⋮⋮)를 끌어 순서를 바꾸고, 크기 단추(S·M·L·XL)를 누르면 그 자리에서 뷰가 바뀝니다. 격자는 빈틈 없이 다시 채워집니다.'),
      el('span', { class: 'pjh-edbar-r' }, presetBtn, sw,
        btn('기본으로', 'btn-ghost', () => { layout = resetHubLayout(pid, scope); renderGrid(); }),
        btn('완료', 'btn-primary', () => { editing = false; render(); })));
  }
  function slot(): HTMLElement {
    const s = el('div', { class: 'pjh-slot' });
    if (!layout.hidden.length) s.append(el('span', { text: '숨긴 도구 없음 — 카드의 × 로 숨기면 여기서 되살립니다' }));
    else {
      s.append(hubIcon('plus', 15), el('span', { text: '위젯 추가' }));
      for (const t of layout.hidden) s.append(btn(HUB_TOOL_LABEL[t], 'btn-ghost', () => commit(showHubItem(layout, t))));
    }
    // 슬롯에 놓으면 맨 뒤로
    s.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); s.classList.add('over'); });
    s.addEventListener('dragleave', () => s.classList.remove('over'));
    s.addEventListener('drop', (e: DragEvent) => { e.preventDefault(); s.classList.remove('over'); const src = e.dataTransfer?.getData('text/plain') as HubTool; if (src && (HUB_TOOLS as string[]).includes(src)) commit(moveHubItem(layout, src, null)); });
    return s;
  }

  // ── 조립 ──
  const grid = el('div', { class: 'pjh-grid' });
  const top = el('div', {});
  const editBtn = btn('배치 편집', 'btn-ghost', () => { editing = !editing; render(); }, { class: 'btn btn-sm btn-ghost pjh-edit-btn' });
  editBtn.prepend(hubIcon('grid', 13));
  function renderGrid(): void {
    grid.classList.toggle('edit', editing);
    grid.replaceChildren(...layout.items.map((it) => widget(it.tool, it.size)));
  }
  function render(): void {
    host.replaceChildren();
    if (focus) {
      const tool = focus;
      host.append(el('div', { class: 'pjh-focus-bar' }, btn('허브', 'btn-ghost', () => openTool(null)), el('b', { text: HUB_TOOL_LABEL[tool] }),
        el('span', { class: 'muted', style: 'font-size:12.5px;color:var(--muted-2)', text: '전폭 보기 — 크기 XL 의 확장' })));
      host.append(el('div', { class: 'pjh-focus' }, o.sections[tool]()));
      if (o.actionsHost) o.actionsHost.replaceChildren();
      return;
    }
    if (o.actionsHost) { o.actionsHost.replaceChildren(editBtn); editBtn.classList.toggle('active', editing); }
    top.replaceChildren();
    if (editing) top.append(editBar());
    host.append(top, grid);
    renderGrid();
    if (editing) host.append(slot());
  }
  const onMq = (): void => { const n = mq.matches; if (n !== narrow) { narrow = n; renderGrid(); } };
  try { mq.addEventListener('change', onMq); } catch (_) { /* 옛 사파리 */ }
  render();
}
