// v2/studio.ts — 실험장 v3(#1719 원준): 프로젝트 화면 = 작업대(캔버스), **위젯 중심 전면 재설계**.
//
//  v3 원칙(원준 피드백 2026-08-19 3차):
//   · 공통 틀에 내용을 끼워 넣지 않는다 — 위젯마다 **그 기능이 요구하는 구조**를 처음부터 설계한다.
//   · **크기가 곧 레이아웃이다**(iOS/맥 위젯 문법): S(한눈) · M(목록·조작) · L(펼침) — 크기를 끌면
//     그 문턱에서 내용 구성이 바뀐다. 참고한 문법 — 세션 S=Mail 위젯(요약 한 줄)·M/L=메시지 앱(스크롤 대화+입력),
//     태스크 S=활동 링·M=Things 목록, 지식 L=Notes 카드 그리드(본문 미리보기), 폴더=Files 아이콘 그리드,
//     리브 제안=Siri 제안, 자동화=단축어 갤러리.
//   · 세션 카드의 대화는 **자기 스크롤 영역**을 가진다 — 내용이 같으면 DOM 을 건드리지 않아(서명 비교)
//     스크롤·타이핑이 8초 틱에 끊기지 않고, 새 턴이 오면 바닥으로 따라간다.
import { api, apiUrl, TOKEN_KEY, el, personFace, relTime, renderMarkdown, sv, toast } from '../core.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline } from '../timeline-sources.js';
import { fmtSize, openFileViewer } from '../projects/files.js';
import { runPrefs } from './run-picker.js';
import { sessText } from './side.js';
import { dotCls, type Sess, type V2Data } from './views.js';

export interface StudioOpts { data: () => V2Data; id: number; detail: any; onProjectChanged?: () => void }
export interface StudioHandle { destroy(): void; renderAside(aside: HTMLElement): void }

// ── 아이콘(스트로크 SVG) ──────────────────────────────────────────────────────
const ICON_PATHS: Record<string, string> = {
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  task: '<path d="M4 6h12M4 12h12M4 18h8"/><path d="M19 5l2 2-4 4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M8 7h7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  deck: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
function icon(name: string, cls = 'stu-i'): SVGElement {
  const s = sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  s.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
  return s;
}

// ── 위젯 카탈로그 ─────────────────────────────────────────────────────────────
type WType = 'session' | 'coach' | 'automation' | 'tasks' | 'knowledge' | 'folder' | 'desc' | 'timeline' | 'sticky' | 'preview' | 'doc' | 'app-meeting' | 'app-calendar' | 'app-slides';
type Sz = 's' | 'm' | 'l';
interface WSpec { id: string; type: WType; x: number; y: number; w: number; h: number; min?: boolean; z?: number; data?: any }
interface WDef { type: WType; label: string; hint: string; w: number; h: number; ic: string; ac: string; shell?: boolean; hidden?: boolean }
const WDEFS: WDef[] = [
  { type: 'session', label: 'AI 세션', hint: '세션 하나 — 크기를 키우면 대화가 통째로 보여요', w: 340, h: 300, ic: 'chat', ac: '#2D6BF0' },
  { type: 'coach', label: '리브 제안', hint: '판을 읽고 AI 를 더 크게 쓰는 법을 제안', w: 340, h: 250, ic: 'spark', ac: '#0FA37E' },
  { type: 'automation', label: '자동화', hint: '반복을 붙박이로 — 켤 수 있는 자동화', w: 340, h: 250, ic: 'bolt', ac: '#7C5CFC' },
  { type: 'tasks', label: '태스크', hint: 'S=진행 링 · M=할 일 목록 · L=마감까지', w: 320, h: 300, ic: 'task', ac: '#D9772B' },
  { type: 'knowledge', label: '지식', hint: 'M=문서 목록 · L=본문 미리보기 카드', w: 320, h: 280, ic: 'book', ac: '#1BAEB0' },
  { type: 'folder', label: '공유 폴더', hint: '파일 그리드 — 이미지·PDF 는 판에 프리뷰로', w: 380, h: 300, ic: 'folder', ac: '#5A6B85' },
  { type: 'desc', label: '명세', hint: '프로젝트 본문 — 꺼내 읽는 문서', w: 440, h: 360, ic: 'doc', ac: '#8A99B5' },
  { type: 'timeline', label: '타임라인', hint: '남은 결과들', w: 340, h: 420, ic: 'clock', ac: '#15233B' },
  { type: 'sticky', label: '포스트잇', hint: '판에 붙이는 메모', w: 230, h: 170, ic: 'note', ac: '#D9A32B' },
  { type: 'app-meeting', label: '회의록', hint: '껍데기 — 회의록→결정·태스크 추출 자리', w: 340, h: 250, ic: 'mic', ac: '#B84E9C', shell: true },
  { type: 'app-calendar', label: '캘린더', hint: '껍데기 — 마감·회의·세션 예약 자리', w: 340, h: 280, ic: 'cal', ac: '#D9772B', shell: true },
  { type: 'app-slides', label: '장표', hint: '껍데기 — 지식→보고 장표 자리', w: 340, h: 240, ic: 'deck', ac: '#2D6BF0', shell: true },
  { type: 'preview', label: '프리뷰', hint: '파일 미리보기', w: 360, h: 320, ic: 'img', ac: '#5A6B85', hidden: true },
  { type: 'doc', label: '문서', hint: '지식·문서 임베드', w: 460, h: 420, ic: 'doc', ac: '#1BAEB0', hidden: true },
];
const wdef = (t: WType): WDef => WDEFS.find((d) => d.type === t)!;
const GRID = 8;
const snap = (n: number): number => Math.max(0, Math.round(n / GRID) * GRID);
const LS_KEY = (id: number): string => 'lively_studio3_' + id;
const INJ_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;
/** 크기 → 레이아웃 등급(iOS 위젯 문법) — 문턱을 넘으면 내용 구성이 바뀐다. */
function sizeOf(spec: WSpec): Sz {
  if (spec.w < 280 || spec.h < 200) return 's';
  if (spec.w >= 540 || spec.h >= 460) return 'l';
  return 'm';
}

export function mountStudio(host: HTMLElement, opts: StudioOpts): StudioHandle {
  const id = opts.id;
  let detail: any = opts.detail;
  let dead = false;
  let chat: ProjectChatHandle | null = null;
  let zTop = 10;
  let liveTimer: number | null = null;
  let tick = 0;
  let commentMode = false;

  let widgets: WSpec[] = [];
  let seq = 1;
  let lastSpawnTs = 0;
  const els = new Map<string, { root: HTMLElement; body: HTMLElement; title: HTMLElement }>();
  const sigs = new Map<string, string>();   // 위젯 본문 서명 — 같으면 DOM 을 안 건드린다(스크롤·타이핑 보호)
  function save(): void { try { localStorage.setItem(LS_KEY(id), JSON.stringify({ widgets, seq, lastSpawnTs })); } catch (_) { /* noop */ } }
  function load(): boolean {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY(id)) || 'null');
      if (s && Array.isArray(s.widgets)) { widgets = s.widgets; seq = Number(s.seq) || widgets.length + 1; lastSpawnTs = Number(s.lastSpawnTs) || 0; return true; }
    } catch (_) { /* noop */ }
    return false;
  }

  const pj = (): any => (detail && detail.project) || { id, name: '프로젝트 #' + id };
  const mySessions = (): Sess[] => opts.data().sessions.filter((s) => Number(s.projectId) === id);

  // ── 골격 ──
  const door = el('header', { class: 'stu-door' });
  const canvas = el('div', { class: 'stu-canvas' });
  const cmLayer = el('div', { class: 'stu-cmlayer', hidden: true });
  const board = el('div', { class: 'stu-board' }, canvas, cmLayer);
  const wrap = el('div', { class: 'stu-wrap' }, door, board) as HTMLElement;
  host.replaceChildren(wrap);

  const cmBtn = el('button', { class: 'btn btn-ghost btn-sm stu-cm-btn', type: 'button', title: '코멘트 모드 — 판 위를 드래그해 영역을 잡고 코멘트를 남깁니다', onclick: () => setCommentMode(!commentMode) }, icon('pin', 'stu-i sm'), el('span', { text: '코멘트' })) as HTMLButtonElement;
  function paintDoor(): void {
    const p = pj();
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const doneN = tasks.filter((t) => t.status_category === 'done').length;
    const kn = p.knowledge || {};
    const knN = (kn.required || []).length + (kn.produced || []).length;
    const ss = mySessions();
    const live = ss.filter((s) => s.live && s.alive);
    const members: any[] = Array.isArray(p.members) ? p.members : [];
    const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
    door.replaceChildren(
      el('div', { class: 'stu-door-l' },
        el('div', { class: 'stu-door-top' },
          el('a', { class: 'stu-homelogo', href: '#/', title: '홈으로' }, el('span', { text: 'L' })),
          el('button', { class: 'stu-projbtn', type: 'button', title: '프로젝트 목록 열기/닫기', onclick: () => window.dispatchEvent(new Event('stu:toggle-projects')) },
            icon('folder', 'stu-i sm'), el('span', { text: '프로젝트' }), el('span', { class: 'car', text: '▾', 'aria-hidden': 'true' })),
          el('span', { class: 'stu-door-sep', 'aria-hidden': 'true' }),
          el('div', { class: 'stu-eyebrow' },
            el('span', { class: 'mono', text: '#' + p.id }), el('span', { class: 'sep', text: '·' }),
            el('span', { class: 'stu-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `지식 ${knN}` }))),
        el('h1', { class: 'stu-title', text: p.name || '프로젝트 #' + id })),
      el('div', { class: 'stu-door-r' },
        el('span', { class: 'stu-faces' }, ...members.slice(0, 5).map((m: any) => personFace(String(m.member_id || m), 'stu-face', String(m.display_name || m.member_id || '')))),
        cmBtn,
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '명세', onclick: () => addOrFocus('desc') }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '정리', title: '위젯 자동 재배치', onclick: () => { autoArrange(); paintAll(); save(); } })));
    cmBtn.classList.toggle('on', commentMode);
  }

  // ── 위젯 프레임 ──
  function addWidget(type: WType, at?: { x: number; y: number }, data?: any, o2?: { noSave?: boolean }): WSpec {
    const d = wdef(type);
    const spec: WSpec = { id: 'w' + seq++, type, x: at ? snap(at.x) : 40 + ((seq * 48) % 280), y: at ? snap(at.y) : 32 + ((seq * 36) % 200), w: d.w, h: d.h, data: data || {} };
    widgets.push(spec);
    if (!o2?.noSave) { save(); paintAll(); }
    return spec;
  }
  function addOrFocus(type: WType): void {
    const hit = widgets.find((w) => w.type === type);
    if (hit) { hit.min = false; hit.z = ++zTop; paintAll(); save(); return; }
    addWidget(type, { x: 72, y: 48 });
  }
  function removeWidget(spec: WSpec): void { widgets = widgets.filter((w) => w !== spec); sigs.delete(spec.id); save(); paintAll(); }

  function widgetEl(spec: WSpec): HTMLElement {
    if (spec.type === 'sticky') return stickyEl(spec);
    const d = wdef(spec.type);
    const body = el('div', { class: 'stu-w-body' });
    const titleEl2 = el('b', { class: 'stu-w-t', text: widgetTitle(spec) });
    const szBtn = el('button', { class: 'stu-w-btn', type: 'button', title: '크기 단계 — S/M/L 로 돌려요(끌어서도 조절)', text: sizeOf(spec).toUpperCase(), onclick: (e: Event) => { e.stopPropagation(); cycleSize(spec); } });
    const head = el('div', { class: 'stu-w-head' },
      el('span', { class: 'stu-w-ic', style: 'color:' + d.ac + ';background:' + d.ac + '1a' }, icon(d.ic, 'stu-i sm')),
      titleEl2,
      d.shell ? el('span', { class: 'stu-shell-badge', text: '껍데기' }) : null,
      el('span', { class: 'stu-w-acts' },
        szBtn,
        el('button', { class: 'stu-w-btn', type: 'button', title: spec.min ? '펼치기' : '접기', text: spec.min ? '▸' : '▾', onclick: (e: Event) => { e.stopPropagation(); spec.min = !spec.min; sigs.delete(spec.id); save(); paintAll(); } }),
        spec.type === 'session' && spec.data?.sid
          ? el('button', { class: 'stu-w-btn', type: 'button', title: '전체 화면(대화창)', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); location.hash = '#/s/' + encodeURIComponent(String(spec.data.sid)); } })
          : null,
        el('button', { class: 'stu-w-btn', type: 'button', title: '판에서 치우기', text: '×', onclick: (e: Event) => { e.stopPropagation(); removeWidget(spec); } })));
    const w = el('div', { class: 'stu-w stu-w-' + spec.type + (spec.min ? ' min' : ''), 'data-sz': sizeOf(spec), style: `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;${spec.min ? '' : 'height:' + spec.h + 'px;'}z-index:${spec.z || 1};--wac:${d.ac}` }, head, body,
      el('div', { class: 'stu-w-rsz', title: '크기 조절 — 문턱을 넘으면 구성이 바뀌어요' }));
    els.set(spec.id, { root: w, body, title: titleEl2 });
    if (!spec.min) fillBody(spec, body, true);
    wireDrag(spec, w, head);
    wireResize(spec, w, body, szBtn);
    w.addEventListener('mousedown', () => { spec.z = ++zTop; w.style.zIndex = String(spec.z); });
    return w;
  }
  const SIZES: Record<Sz, { w: number; h: number }> = { s: { w: 240, h: 160 }, m: { w: 0, h: 0 }, l: { w: 620, h: 520 } };
  function cycleSize(spec: WSpec): void {
    const cur = sizeOf(spec);
    const next: Sz = cur === 's' ? 'm' : cur === 'm' ? 'l' : 's';
    const d = wdef(spec.type);
    const t = next === 'm' ? { w: d.w, h: d.h } : SIZES[next];
    spec.w = t.w; spec.h = t.h; spec.min = false;
    sigs.delete(spec.id); save(); paintAll();
  }
  function widgetTitle(spec: WSpec): string {
    if (spec.type === 'session') {
      const s = spec.data?.sid ? mySessions().find((x) => x.id === spec.data.sid) : null;
      if (!s) return 'AI 세션 — 고르세요';
      const t = sessText(s, pj().name || '');
      return t.main || s.label || 'AI 세션';
    }
    if (spec.type === 'preview') return String(spec.data?.name || '프리뷰');
    if (spec.type === 'doc') return String(spec.data?.title || '문서');
    return wdef(spec.type).label;
  }
  function wireDrag(spec: WSpec, w: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, input, textarea, a, select')) return;
      e.preventDefault();
      w.classList.add('drag');
      const sx = e.clientX, sy = e.clientY, ox = spec.x, oy = spec.y;
      const move = (ev: MouseEvent): void => { spec.x = snap(ox + ev.clientX - sx); spec.y = snap(oy + ev.clientY - sy); w.style.left = spec.x + 'px'; w.style.top = spec.y + 'px'; };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); w.classList.remove('drag'); save(); growCanvas(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function wireResize(spec: WSpec, w: HTMLElement, body: HTMLElement, szBtn: HTMLElement): void {
    const h = w.querySelector('.stu-w-rsz') as HTMLElement | null;
    if (!h) return;
    h.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = spec.w, oh = spec.h;
      const szWas = sizeOf(spec);
      const move = (ev: MouseEvent): void => {
        spec.w = Math.max(216, snap(ow + ev.clientX - sx)); spec.h = Math.max(140, snap(oh + ev.clientY - sy));
        w.style.width = spec.w + 'px'; if (!spec.min) w.style.height = spec.h + 'px';
        const sz = sizeOf(spec);
        if (w.dataset.sz !== sz) { w.dataset.sz = sz; szBtn.textContent = sz.toUpperCase(); sigs.delete(spec.id); fillBody(spec, body, true); }   // 문턱 통과 → 그 자리에서 구성 전환
      };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); if (sizeOf(spec) !== szWas) { sigs.delete(spec.id); fillBody(spec, body, true); } };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function growCanvas(): void {
    const mx = Math.max(1500, ...widgets.map((s) => s.x + s.w + 80));
    const my = Math.max(900, ...widgets.map((s) => s.y + (s.min ? 40 : s.h) + 140));
    canvas.style.width = mx + 'px'; canvas.style.height = my + 'px';
    cmLayer.style.width = mx + 'px'; cmLayer.style.height = my + 'px';
  }

  // ── 본문 라우팅 — force=구성 재생성 · 아니면 서명이 같을 때 손대지 않는다 ──
  function fillBody(spec: WSpec, body: HTMLElement, force?: boolean): void {
    const t = spec.type;
    if (t === 'session') { void fillSession(spec, body, !!force); return; }
    if (t === 'coach') { fillCoach(spec, body, !!force); return; }
    if (t === 'automation') fillAutomation(spec, body);
    else if (t === 'tasks') fillTasks(spec, body);
    else if (t === 'knowledge') void fillKnowledge(spec, body);
    else if (t === 'folder') void fillFolder(spec, body);
    else if (t === 'desc') fillDesc(body);
    else if (t === 'timeline') fillTimeline(body);
    else if (t === 'preview') fillPreview(spec, body);
    else if (t === 'doc') fillDoc(spec, body);
    else if (t === 'app-meeting') fillMeeting(body);
    else if (t === 'app-calendar') fillCalendar(body);
    else if (t === 'app-slides') fillSlides(body);
  }

  // ══ 세션 위젯 — S: 한 줄 요약 · M/L: 스크롤 대화 + 입력(메시지 앱 문법) ══════════
  interface Turn { who: 'me' | 'ai'; text: string }
  const tailCache = new Map<string, { turns: Turn[]; at: number }>();
  async function fetchTurns(s: Sess, maxBytes: number): Promise<Turn[]> {
    const hit = tailCache.get(s.id);
    if (hit && Date.now() - hit.at < 7000) return hit.turns;
    const turns: Turn[] = [];
    try {
      const headers: Record<string, string> = {};
      const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
      const res = await fetch(apiUrl('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/transcript?tail=' + maxBytes), { headers, credentials: 'same-origin' });
      if (res.ok) {
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue;
          let o: any; try { o = JSON.parse(line); } catch { continue; }
          if (!o || o.isSidechain || o.isMeta) continue;
          const c = o.message?.content;
          if (o.type === 'user') {
            const txt = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join(' ') : '').replace(/\s+/g, ' ').trim();
            if (txt && !INJ_RE.test(txt)) turns.push({ who: 'me', text: txt });
          } else if (o.type === 'assistant') {
            const txt = (Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n') : '').trim();
            if (!txt) continue;
            const last = turns[turns.length - 1];
            if (last && last.who === 'ai') last.text = txt;   // 이어 쓰는 답은 마지막 것으로 갱신(도구 사이 조각 합침)
            else turns.push({ who: 'ai', text: txt });
          }
        }
      }
    } catch (_) { /* 읽기 불가 하네스 — 거품 없이 */ }
    const out = turns.slice(-12);
    tailCache.set(s.id, { turns: out, at: Date.now() });
    return out;
  }
  async function fillSession(spec: WSpec, body: HTMLElement, force: boolean): Promise<void> {
    const sid = spec.data?.sid ? String(spec.data.sid) : '';
    const s = sid ? mySessions().find((x) => x.id === sid) : null;
    const sz = sizeOf(spec);
    if (!s) {
      const list = mySessions();
      body.replaceChildren(
        el('p', { class: 'stu-fine', text: list.length ? '판에 올릴 세션을 고르세요.' : '아직 세션이 없어요 — 아래 컴포저로 시키면 자동으로 생깁니다.' }),
        el('div', { class: 'stu-pick' }, ...list.slice(0, 8).map((x) => el('button', { class: 'stu-pick-row', type: 'button', onclick: () => { spec.data = { sid: x.id }; sigs.delete(spec.id); save(); paintAll(); } },
          el('span', { class: 'v2-dot ' + dotCls(x.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'n', text: x.label || x.id }), el('span', { class: 'm', text: x.stateLabel })))));
      return;
    }
    const raw = s.raw || {};
    const waiting = s.stateKey === 'waiting';
    const root = els.get(spec.id)?.root;
    if (root) root.style.setProperty('--wac', s.stateKey === 'busy' ? '#2D6BF0' : waiting ? '#D9A32B' : s.stateKey === 'done' ? '#16C79A' : '#A6B2C8');
    const work = String(raw.title || '').trim();
    const workOk = work && !INJ_RE.test(work) && work.toLowerCase() !== String(raw.harness || '').toLowerCase();

    if (sz === 's') {   // S — Mail 위젯 문법: 상태 + 지금 하는 일 한 줄. 조작 없음.
      const sig = 's|' + s.stateKey + '|' + (workOk ? work : s.stateLabel);
      if (!force && sigs.get(spec.id) === sig) return;
      sigs.set(spec.id, sig);
      body.replaceChildren(
        el('div', { class: 'stu-sess-s' },
          el('div', { class: 'st' }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }), el('span', { class: 'stu-fine', style: 'margin-left:auto', text: s.lastSeen ? relTime(new Date(s.lastSeen).toISOString()) : '' })),
          el('div', { class: 'now', text: workOk ? work : '조용해요 — 크기를 키우면 대화가 보여요' })));
      return;
    }

    const turns = (s.live && !s.node) ? await fetchTurns(s, sz === 'l' ? 60000 : 30000) : [];
    if (dead || !body.isConnected) return;
    const shown = sz === 'l' ? turns : turns.slice(-6);
    const sig = sz + '|' + s.stateKey + '|' + (workOk ? work : '') + '|' + shown.map((t) => t.who + t.text.length).join(',');
    if (!force && sigs.get(spec.id) === sig) return;   // 변화 없음 — 스크롤·입력 그대로
    sigs.set(spec.id, sig);
    const conv = el('div', { class: 'stu-conv' },
      shown.length ? null : el('p', { class: 'stu-fine', style: 'padding:8px 2px', text: s.live ? '아직 주고받은 말이 없어요.' : '기록만 남은 세션 — 열어서 보세요.' }),
      ...shown.map((t) => el('div', { class: 'stu-msg ' + t.who },
        el('span', { class: 'who', text: t.who === 'me' ? '나' : 'AI' }),
        el('div', { class: 'tx', text: t.text.length > (sz === 'l' ? 2000 : 420) ? t.text.slice(0, sz === 'l' ? 2000 : 420) + '…' : t.text }))));
    const inp = el('input', { class: 'stu-sess-in', type: 'text', placeholder: '이 세션에 시키기 — Enter', 'aria-label': '이 세션에 시키기' }) as HTMLInputElement;
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = inp.value.trim();
      if (!text) return;
      inp.disabled = true;
      void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) })
        .then(() => { inp.value = ''; conv.append(el('div', { class: 'stu-msg me pend' }, el('span', { class: 'who', text: '나' }), el('div', { class: 'tx', text }))); conv.scrollTop = conv.scrollHeight; })
        .catch((err: any) => toast('보내지 못했어요 — ' + (err?.message || err), true))
        .finally(() => { inp.disabled = false; inp.focus(); });
    });
    const key = (action: string, label: string, primary?: boolean): HTMLElement =>
      el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text: label, onclick: () => {
        void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/keys', { method: 'POST', body: JSON.stringify({ action }) })
          .then(() => toast(label + ' — 보냈어요.')).catch((err: any) => toast('실패 — ' + (err?.message || err), true));
      } });
    body.replaceChildren(
      el('div', { class: 'stu-sess-st' },
        el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }),
        raw.harness ? el('span', { class: 'stu-hbadge mono', text: String(raw.harness) }) : null,
        workOk && sz === 'l' ? el('span', { class: 'stu-fine ell', style: 'margin-left:8px', title: work, text: work }) : null,
        el('a', { class: 'stu-fine', style: 'margin-left:auto;color:var(--blue)', href: '#/s/' + encodeURIComponent(s.id), text: '열기 →' })),
      conv,
      ...(waiting ? [el('div', { class: 'stu-sess-keys' }, el('span', { class: 'stu-wait-k', text: '확인 필요' }), key('approve', '승인', true), key('deny', '거부'), key('interrupt', '멈춤'))] : []),
      el('div', { class: 'stu-sess-footrow' }, inp));
    conv.scrollTop = conv.scrollHeight;   // 새 내용 = 바닥으로(메시지 앱)
  }

  // ══ 리브 제안 — Siri 제안 문법: 큰 아이콘 칩 + 한 문장 + 실행 하나 ═══════════════
  function coachRow(txt: string, say: string): HTMLElement {
    return el('button', { class: 'stu-sugg', type: 'button', title: '누르면 리브 대화로 들어가요', onclick: () => { openLiv(); chat?.say(say); } },
      el('span', { class: 'stu-sugg-ic' }, icon('spark', 'stu-i sm')),
      el('span', { class: 'n', text: txt }),
      el('span', { class: 'go' }, icon('arrow', 'stu-i sm')));
  }
  function coachRows(): Array<[string, string]> {
    const ss = mySessions();
    const waiting = ss.filter((s) => s.stateKey === 'waiting');
    const idle = ss.filter((s) => s.live && s.alive && s.stateKey === 'idle');
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const noMeta = tasks.filter((tk) => tk.status_category !== 'done' && !tk.due_date && !(tk.assignees && tk.assignees.length)).length;
    const rows: Array<[string, string]> = [];
    if (waiting.length) rows.push([`세션 ${waiting.length}개가 답을 기다려요 — 물음 모아 보기`, '답을 기다리는 세션들의 질문을 모아 요약해 줘. 한 번에 결정할 수 있게.']);
    if (idle.length >= 2) rows.push([`조용한 세션 ${idle.length}개 — 결과를 지식으로 정리하고 닫기`, '조용한 세션들이 남긴 결과를 지식으로 정리하고, 닫아도 되는 세션을 알려 줘.']);
    if (noMeta >= 3) rows.push([`담당·마감 없는 할 일 ${noMeta}개 — 정리하고 병렬로`, '상태·마감·담당을 점검하고 비거나 어긋난 걸 정리해 줘.']);
    rows.push(['이 작업을 세션 2~3개로 나눠 병렬로 돌리기', '지금 작업을 병렬 세션 2~3개로 나누는 안을 제안해 줘. 각 세션의 첫 지시까지.']);
    rows.push(['반복 확인을 상시 세션에 맡기기', '이 프로젝트에서 반복되는 확인 작업을 찾아 상시 세션에 맡기는 흐름을 제안해 줘.']);
    return rows;
  }
  function fillCoach(spec: WSpec, body: HTMLElement, force: boolean): void {
    const sz = sizeOf(spec);
    const rows = coachRows().slice(0, sz === 's' ? 1 : sz === 'l' ? 5 : 3);
    const sig = sz + '|' + rows.map((r) => r[0]).join('|');
    if (!force && sigs.get(spec.id) === sig) return;
    sigs.set(spec.id, sig);
    body.replaceChildren(
      el('div', { class: 'stu-suggs' }, ...rows.map(([t, s2]) => coachRow(t, s2))),
      sz !== 's' ? el('p', { class: 'stu-foot-note', text: '판의 상태에서 계산한 제안이에요.' }) : null);
  }

  // ══ 자동화 — 단축어 갤러리 문법: 색 타일 + 이름 + 설명 + [켜기] ═══════════════════
  function fillAutomation(spec: WSpec, body: HTMLElement): void {
    const sz = sizeOf(spec);
    const row = (t: string, d2: string, say: string): HTMLElement => el('div', { class: 'stu-auto' },
      el('span', { class: 'stu-auto-ic' }, icon('bolt', 'stu-i sm')),
      el('span', { class: 'b' }, el('b', { text: t }), sz !== 's' ? el('span', { class: 'd', text: d2 }) : null),
      el('button', { class: 'stu-pillbtn violet', type: 'button', text: '켜기', onclick: () => { openLiv(); chat?.say(say); } }));
    const rows = [
      row('아침 브리프', '매일 9시 — 밤새 남긴 것 요약', '매일 아침 9시에 이 프로젝트의 전날 결과(지식·커밋·결정)를 요약해 주는 자동화를 만들어 줘. 가능한 방법 먼저.'),
      row('회의록 → 태스크', '회의록이 오르면 결정·태스크 추출', '공유 폴더에 회의록이 올라오면 결정·태스크를 자동 추출하는 흐름을 만들어 줘.'),
      row('화면 회귀 검증', '화면이 바뀔 때마다 스크린샷 비교', '화면이 바뀔 때마다 스크린샷을 비교하는 상시 검증 흐름을 제안해 줘.'),
    ];
    body.replaceChildren(el('div', { class: 'stu-autos' }, ...rows.slice(0, sz === 's' ? 1 : 3)),
      sz !== 's' ? el('p', { class: 'stu-foot-note', text: '켜기 = 리브가 설계·생성(예약 붙박이는 다음 단계)' }) : null);
  }

  // ══ 태스크 — S: 진행 링 · M: Things 식 목록 · L: 마감 포함 ═══════════════════════
  function fillTasks(spec: WSpec, body: HTMLElement): void {
    const sz = sizeOf(spec);
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const done = tasks.filter((tk) => tk.status_category === 'done').length;
    const open = tasks.filter((tk) => tk.status_category !== 'done');
    const pct = tasks.length ? done / tasks.length : 0;
    if (sz === 's') {   // 활동 링(Apple 링 문법)
      const R = 30, C = 2 * Math.PI * R;
      const ring = sv('svg', { viewBox: '0 0 80 80', class: 'stu-ring' });
      ring.innerHTML = `<circle cx="40" cy="40" r="${R}" fill="none" stroke="#F3E3D2" stroke-width="9"/>` +
        `<circle cx="40" cy="40" r="${R}" fill="none" stroke="#D9772B" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 40 40)"/>`;
      body.replaceChildren(el('div', { class: 'stu-task-s' }, ring,
        el('div', { class: 'k' }, el('b', { text: `${done}/${tasks.length}` }), el('span', { text: '끝냄' }),
          open.length ? el('span', { class: 'stu-fine', text: '다음 — ' + String(open[0].name).slice(0, 22) }) : null)));
      return;
    }
    const row = (tk: any): HTMLElement => el('a', { class: 'stu-task', href: '#/projects2/t/' + tk.id, title: tk.name },
      el('span', { class: 'stu-ck' + (tk.status_category === 'started' ? ' run' : ''), 'aria-hidden': 'true' }),
      el('span', { class: 'n', text: tk.name }),
      tk.due_date ? el('span', { class: 'due' + (String(tk.due_date) < new Date().toISOString().slice(0, 10) ? ' over' : ''), text: String(tk.due_date).slice(5, 10) }) : null);
    body.replaceChildren(
      el('div', { class: 'stu-taskbar' }, el('i', { style: 'width:' + Math.round(pct * 100) + '%' }), el('span', { text: `${done}/${tasks.length}` })),
      open.length ? el('div', { class: 'stu-scroll' }, ...open.slice(0, sz === 'l' ? 30 : 9).map(row)) : el('p', { class: 'stu-fine', text: '남은 할 일이 없어요.' }),
      el('div', { class: 'stu-w-foot' },
        el('a', { class: 'btn-text', href: '#/projects2/p/' + id, text: '보드에서 전체 →' }),
        el('button', { class: 'btn-text', type: 'button', text: '리브에게 나누기', onclick: () => { openLiv(); chat?.say('이 프로젝트를 태스크로 나눠 줘. 만들기 전에 목록 먼저.'); } })));
  }

  // ══ 지식 — M: 문서 목록 · L: 본문 미리보기 카드(Notes 그리드) ═══════════════════
  const knPeekCache = new Map<string, string>();
  async function knSnippet(name: string): Promise<string> {
    if (knPeekCache.has(name)) return knPeekCache.get(name)!;
    let out = '';
    try {
      const r: any = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '?limit=8');
      out = String(r?.knowledge?.body_md || '').replace(/^#.*$/m, '').replace(/[#>*`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    } catch (_) { /* noop */ }
    knPeekCache.set(name, out);
    return out;
  }
  async function fillKnowledge(spec: WSpec, body: HTMLElement): Promise<void> {
    const sz = sizeOf(spec);
    const kn = pj().knowledge || {};
    const all: Array<{ name: string; rel: string }> = [
      ...(kn.required || []).map((k: any) => ({ name: k.name, rel: '필요' })),
      ...(kn.produced || []).map((k: any) => ({ name: k.name, rel: '산출' })),
    ];
    if (!all.length) { body.replaceChildren(el('p', { class: 'stu-fine', text: '연결된 지식이 아직 없어요.' })); return; }
    if (sz === 's') {
      body.replaceChildren(el('div', { class: 'stu-kn-s' }, el('b', { text: String(all.length) }), el('span', { text: '연결된 지식' }),
        el('span', { class: 'stu-fine ell', text: all[all.length - 1].name })));
      return;
    }
    if (sz === 'l') {
      const cards = await Promise.all(all.slice(0, 8).map(async (k) => {
        const snip = await knSnippet(k.name);
        return el('button', { class: 'stu-kncard', type: 'button', title: k.name, onclick: () => openPeek('#/k/' + encodeURIComponent(k.name), k.name) },
          el('div', { class: 'h' }, icon('doc', 'stu-i sm'), el('span', { class: 'stu-kn-rel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel })),
          el('b', { class: 'ell2', text: k.name }),
          el('span', { class: 'snip', text: snip || '…' }));
      }));
      if (dead || !body.isConnected) return;
      body.replaceChildren(el('div', { class: 'stu-kngrid' }, ...cards));
      return;
    }
    body.replaceChildren(el('div', { class: 'stu-scroll' }, ...all.slice(0, 14).map((k) =>
      el('button', { class: 'stu-docrow', type: 'button', title: k.name, onclick: () => openPeek('#/k/' + encodeURIComponent(k.name), k.name) },
        icon('doc', 'stu-i sm'), el('span', { class: 'n', text: k.name }), el('span', { class: 'stu-kn-rel' + (k.rel === '산출' ? ' prod' : ''), text: k.rel })))));
  }

  // ══ 폴더 — Files 그리드(최근 먼저). 이미지·PDF 는 판에 프리뷰로 ═══════════════════
  async function fillFolder(spec: WSpec, body: HTMLElement): Promise<void> {
    const sz = sizeOf(spec);
    body.replaceChildren(el('p', { class: 'stu-fine', text: '불러오는 중…' }));
    let data: any = null;
    try { data = await api('/api/ui/projects/' + id + '/files?path='); } catch (e: any) { body.replaceChildren(el('p', { class: 'stu-fine', text: '폴더를 못 읽었어요 — ' + (e?.message || e) })); return; }
    if (dead || !body.isConnected) return;
    const items: any[] = ((data && data.items) || []).slice().sort((a: any, b: any) => Number(b.mtime || 0) - Number(a.mtime || 0));
    if (!items.length) { body.replaceChildren(el('p', { class: 'stu-fine', text: '아직 파일이 없어요 — 세션 작업물이 여기 쌓입니다.' })); return; }
    if (sz === 's') {
      const f = items.find((x: any) => x.type !== 'dir') || items[0];
      body.replaceChildren(el('div', { class: 'stu-kn-s' }, el('b', { text: String(items.length) }), el('span', { text: '항목' }), el('span', { class: 'stu-fine ell', text: '최근 — ' + f.name })));
      return;
    }
    const tile = (it: any): HTMLElement => el('button', { class: 'stu-file', type: 'button', title: it.name, onclick: () => {
      if (it.type === 'dir') { openPeek('#/f?root=shared&path=' + encodeURIComponent('project/' + id + '/' + it.name), it.name); return; }
      if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(it.name)) { addWidget('preview', { x: 96, y: 96 }, { path: it.name, name: it.name }); return; }
      void openFileViewer(id, it.name, it.name, () => { /* noop */ }, '/api/ui/projects/');
    } },
      el('span', { class: 'stu-file-ic' + (it.type === 'dir' ? ' dir' : /\.(png|jpe?g|gif|webp|svg)$/i.test(it.name) ? ' im' : '') }, icon(it.type === 'dir' ? 'folder' : /\.(png|jpe?g|gif|webp|svg)$/i.test(it.name) ? 'img' : 'doc', 'stu-i')),
      el('span', { class: 'n', text: it.name }), el('span', { class: 'm', text: it.type === 'dir' ? '폴더' : fmtSize(it.size || 0) }));
    body.replaceChildren(el('div', { class: 'stu-scroll' }, el('div', { class: 'stu-filegrid' }, ...items.slice(0, sz === 'l' ? 40 : 12).map(tile))));
  }

  function fillDesc(body: HTMLElement): void {
    const md = String(pj().description || '').trim();
    body.replaceChildren(
      el('div', { class: 'stu-scroll' }, md ? el('div', { class: 'stu-md' }, renderMarkdown(md)) : el('p', { class: 'stu-fine', text: '본문이 아직 없어요.' })),
      el('div', { class: 'stu-w-foot' }, el('button', { class: 'btn-text', type: 'button', text: '리브에게 정돈 맡기기', onclick: () => { openLiv(); chat?.say('본문을 정돈된 형식으로 다시 써 줘. 사실·결정·링크는 하나도 잃지 말고.'); } })));
  }
  function fillTimeline(body: HTMLElement): void {
    const tl = createTimeline(body, { scope: '프로젝트 #' + id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }
  function fillPreview(spec: WSpec, body: HTMLElement): void {
    const path = String(spec.data?.path || '');
    const url = apiUrl('/api/ui/projects/' + id + '/file?path=' + encodeURIComponent(path));
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) body.replaceChildren(el('div', { class: 'stu-prevwrap' }, el('img', { class: 'stu-prev-img', src: url, alt: path, loading: 'lazy' })));
    else body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: /\.pdf$/i.test(path) ? url + '#toolbar=0&view=FitH' : url, title: path }));
    body.append(el('div', { class: 'stu-w-foot' }, el('span', { class: 'stu-fine ell', text: path }),
      el('button', { class: 'btn-text', type: 'button', text: '크게', onclick: () => void openFileViewer(id, path, path, () => { /* noop */ }, '/api/ui/projects/') })));
  }
  function fillDoc(spec: WSpec, body: HTMLElement): void {
    body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: location.pathname + '?embed=1' + String(spec.data?.hash || ''), title: String(spec.data?.title || '문서') }));
  }
  function shellCard(bodyText: string, rows: HTMLElement[]): HTMLElement[] {
    return [el('p', { class: 'stu-shell-p', text: bodyText }), el('div', { class: 'stu-suggs' }, ...rows)];
  }
  function fillMeeting(body: HTMLElement): void {
    body.replaceChildren(...shellCard('회의록을 넣으면 결정·태스크·미결이 추출되어 이 프로젝트에 연결되는 자리예요.',
      [coachRow('회의록 추출을 지금 맡겨 보기', '공유 폴더의 회의록을 찾아 결정·태스크·미결을 추출하고, 태스크로 만들지 목록 먼저 보여 줘.')]));
  }
  function fillCalendar(body: HTMLElement): void {
    const tasks: any[] = (Array.isArray(pj().tasks) ? pj().tasks : []).filter((tk: any) => tk.due_date && tk.status_category !== 'done');
    body.replaceChildren(
      el('p', { class: 'stu-shell-p', text: '마감·회의·세션 예약(정기 실행)이 한 달력에 놓일 자리예요.' }),
      tasks.length ? el('div', { class: 'stu-scroll' }, ...tasks.slice(0, 6).map((tk: any) => el('a', { class: 'stu-task', href: '#/projects2/t/' + tk.id },
        el('span', { class: 'due', text: String(tk.due_date).slice(5, 10) }), el('span', { class: 'n', text: tk.name })))) : el('p', { class: 'stu-fine', text: '마감 있는 할 일이 아직 없어요.' }),
      el('div', { class: 'stu-suggs' }, coachRow('마감 점검 맡기기', '마감이 지난·임박한 태스크를 점검하고 조정안을 제안해 줘.')));
  }
  function fillSlides(body: HTMLElement): void {
    body.replaceChildren(...shellCard('이 프로젝트의 지식·산출물로 보고용 장표(HTML)를 만들어 판에 놓는 자리예요.',
      [coachRow('산출지식으로 장표 초안', '산출지식으로 보고용 장표(HTML) 초안을 만들어 줘. 목차 먼저.')]));
  }

  // 포스트잇
  function stickyEl(spec: WSpec): HTMLElement {
    const ta = el('textarea', { class: 'stu-sticky-ta', placeholder: '메모…', 'aria-label': '포스트잇' }) as HTMLTextAreaElement;
    ta.value = String(spec.data?.text || '');
    ta.addEventListener('input', () => { spec.data = { ...(spec.data || {}), text: ta.value }; save(); });
    const w = el('div', { class: 'stu-w stu-sticky', style: `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;z-index:${spec.z || 1}` },
      el('span', { class: 'stu-tape', 'aria-hidden': 'true' }),
      el('button', { class: 'stu-w-btn stu-sticky-x', type: 'button', text: '×', title: '치우기', onclick: () => removeWidget(spec) }),
      ta, el('div', { class: 'stu-w-rsz' }));
    els.set(spec.id, { root: w, body: w, title: w });
    wireDrag(spec, w, w);
    const h = w.querySelector('.stu-w-rsz') as HTMLElement;
    h.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = spec.w, oh = spec.h;
      const move = (ev: MouseEvent): void => { spec.w = Math.max(160, snap(ow + ev.clientX - sx)); spec.h = Math.max(120, snap(oh + ev.clientY - sy)); w.style.width = spec.w + 'px'; w.style.height = spec.h + 'px'; };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    w.addEventListener('mousedown', () => { spec.z = ++zTop; w.style.zIndex = String(spec.z); });
    return w;
  }

  // ── 코멘트 모드(민트 마키) ──
  function setCommentMode(on: boolean): void {
    commentMode = on;
    cmLayer.hidden = !on;
    board.classList.toggle('cm-on', on);
    cmBtn.classList.toggle('on', on);
    if (on) toast('코멘트 모드 — 판 위를 드래그해 영역을 잡으세요.');
  }
  cmLayer.addEventListener('mousedown', (e: MouseEvent) => {
    if (!commentMode) return;
    e.preventDefault();
    const r = cmLayer.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const box = el('div', { class: 'stu-marq', style: `left:${sx}px;top:${sy}px;width:0;height:0` });
    cmLayer.append(box);
    const move = (ev: MouseEvent): void => {
      const x = Math.min(sx, ev.clientX - r.left), y = Math.min(sy, ev.clientY - r.top);
      const w2 = Math.abs(ev.clientX - r.left - sx), h2 = Math.abs(ev.clientY - r.top - sy);
      box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w2 + 'px'; box.style.height = h2 + 'px';
    };
    const up = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      box.remove();
      const x = Math.min(sx, ev.clientX - r.left), y = Math.min(sy, ev.clientY - r.top);
      const w2 = Math.abs(ev.clientX - r.left - sx), h2 = Math.abs(ev.clientY - r.top - sy);
      if (w2 < 24 || h2 < 18) return;
      const spec: WSpec = { id: 'w' + seq++, type: 'sticky', x: 0, y: 0, w: 0, h: 0, data: { cm: { x: snap(x), y: snap(y), w: snap(w2), h: snap(h2) }, text: '' } };
      widgets.push(spec);
      save(); paintAll();
      setCommentMode(false);
      window.setTimeout(() => { (canvas.querySelector('[data-cm="' + spec.id + '"] textarea') as HTMLTextAreaElement | null)?.focus(); }, 30);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  function commentEl(spec: WSpec): HTMLElement {
    const cm = spec.data?.cm || { x: 40, y: 40, w: 160, h: 80 };
    const ta = el('textarea', { class: 'stu-cmt-ta', placeholder: '이 영역에 대해…', 'aria-label': '코멘트' }) as HTMLTextAreaElement;
    ta.value = String(spec.data?.text || '');
    ta.addEventListener('input', () => { spec.data = { ...(spec.data || {}), text: ta.value }; save(); });
    const card = el('div', { class: 'stu-cmt-card' },
      el('div', { class: 'stu-cmt-h' }, icon('pin', 'stu-i sm'), el('b', { text: '코멘트' }),
        el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '지우기', onclick: () => removeWidget(spec) })),
      ta,
      el('div', { class: 'stu-cmt-acts' },
        el('button', { class: 'stu-pillbtn mint', type: 'button', text: '리브에게', onclick: () => {
          const t = ta.value.trim(); if (!t) { toast('코멘트를 먼저 써 주세요.', true); return; }
          openLiv(); chat?.say('[캔버스 코멘트 · 판 좌표 ' + cm.x + ',' + cm.y + ' 근처] ' + t);
        } })));
    const g = el('div', { class: 'stu-cmt', 'data-cm': spec.id, style: `left:${cm.x}px;top:${cm.y}px;z-index:${spec.z || 5}` },
      el('div', { class: 'stu-cmt-region', style: `width:${cm.w}px;height:${cm.h}px` }), card);
    const head = g.querySelector('.stu-cmt-h') as HTMLElement;
    head.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = cm.x, oy = cm.y;
      const move = (ev: MouseEvent): void => { cm.x = snap(ox + ev.clientX - sx); cm.y = snap(oy + ev.clientY - sy); g.style.left = cm.x + 'px'; g.style.top = cm.y + 'px'; };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); spec.data = { ...(spec.data || {}), cm }; save(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    return g;
  }

  // ── 피크 ──
  let peekEl: HTMLElement | null = null;
  function closePeek(): void { if (peekEl) { peekEl.remove(); peekEl = null; document.removeEventListener('keydown', peekEsc, true); } }
  function peekEsc(e: KeyboardEvent): void { if (e.key === 'Escape') { e.stopPropagation(); closePeek(); } }
  function openPeek(hash: string, title: string): void {
    closePeek();
    const pe = el('div', { class: 'stu-peek' },
      el('div', { class: 'stu-peek-h' }, el('b', { text: title }),
        el('span', { class: 'stu-w-acts' },
          el('button', { class: 'btn-text', type: 'button', text: '판에 놓기', onclick: () => { addWidget('doc', { x: 120, y: 80 }, { hash, title }); closePeek(); } }),
          el('a', { class: 'btn-text', href: hash, target: '_blank', rel: 'noopener', text: '새 탭 ↗' }),
          el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '닫기(Esc)', onclick: closePeek }))),
      el('iframe', { class: 'stu-peek-f', src: location.pathname + '?embed=1' + hash, title }));
    peekEl = pe;
    wrap.append(pe);
    document.addEventListener('keydown', peekEsc, true);
  }

  // ── 플로팅 컴포저 + 리브 패널 ──
  type Dest = { kind: 'liv' } | { kind: 'session'; sid: string; label: string } | { kind: 'new' };
  let destOverride: Dest | null = null;
  const destChip = el('button', { class: 'stu-dest', type: 'button', 'aria-haspopup': 'listbox', title: '행선지 — 글의 내용으로 추정해요. 눌러서 바꿀 수 있어요' }) as HTMLButtonElement;
  const destWhy = el('span', { class: 'stu-dest-why' });
  const input = el('textarea', { class: 'stu-comp-in', rows: '1', placeholder: '무엇이든 시키세요 — 정리는 리브가, 일은 세션이 받아요', 'aria-label': '시키기' }) as HTMLTextAreaElement;
  const sendBtn = el('button', { class: 'stu-comp-send', type: 'button', title: '보내기(Enter)' }, icon('send', 'stu-i')) as HTMLButtonElement;
  const livToggle = el('button', { class: 'stu-liv-toggle', type: 'button', title: '리브 대화 열기/닫기' }, el('span', { class: 'lm', text: 'L' }), el('span', { class: 'stu-liv-n', hidden: true })) as HTMLButtonElement;
  const livPanel = el('div', { class: 'stu-livpanel', hidden: true });
  const livBody = el('div', { class: 'stu-livbody' });
  livPanel.append(el('div', { class: 'stu-livpanel-h' }, el('b', { text: '리브 — 이 프로젝트' }), el('button', { class: 'stu-w-btn', type: 'button', text: '×', onclick: () => toggleLiv(false) })), livBody);
  const composer = el('div', { class: 'stu-composer' },
    livToggle,
    el('div', { class: 'stu-comp-box' },
      el('div', { class: 'stu-comp-row1' }, input, sendBtn),
      el('div', { class: 'stu-comp-row2' }, el('span', { class: 'k', text: '행선지' }), destChip, destWhy)),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 새 세션', title: '빈 세션을 열어 판에 올립니다', onclick: () => void spawnSession(null) }));
  board.append(composer, livPanel);

  const tokensOf = (t: string): string[] => String(t || '').toLowerCase().split(/[^0-9a-z가-힣]+/).filter((x) => (/[가-힣]/.test(x) ? x.length >= 2 : x.length >= 3));
  function guessDest(text: string): { dest: Dest; why: string } {
    if (destOverride) return { dest: destOverride, why: '직접 골랐어요' };
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return { dest: { kind: 'liv' }, why: '' };
    let best: { s: Sess; score: number; hit: string } | null = null;
    for (const s of mySessions().filter((x) => x.live && x.alive)) {
      const name = (s.label || '') + ' ' + String(s.raw?.title || '');
      let score = 0, hit = '';
      for (const tok of tokensOf(name)) if (t.includes(tok)) { score += tok.length; if (tok.length > hit.length) hit = tok; }
      if (score && (!best || score > best.score)) best = { s, score, hit };
    }
    if (best && best.score >= 4) return { dest: { kind: 'session', sid: best.s.id, label: sessText(best.s, pj().name || '').main || best.s.label }, why: `「${best.hit}」가 닿았어요` };
    if (/(본문|명세|태스크|할 일|할일|상태|정리|요약|지식|연결|이름|마감|담당|우선순위|프로젝트)/.test(t)) return { dest: { kind: 'liv' }, why: '정리 명령으로 읽혀요' };
    return { dest: { kind: 'new' }, why: '새 일로 읽혀요' };
  }
  function paintDest(): void {
    const g = guessDest(input.value);
    const d = g.dest;
    destChip.replaceChildren(
      el('span', { class: 'stu-dest-dot ' + (d.kind === 'liv' ? 'liv' : d.kind === 'new' ? 'new' : 'sess'), 'aria-hidden': 'true' }),
      el('b', { text: d.kind === 'liv' ? '리브(워크스페이스)' : d.kind === 'new' ? '새 세션' : d.label }),
      el('span', { class: 'car', text: '▾', 'aria-hidden': 'true' }));
    destWhy.textContent = g.why;
  }
  destChip.onclick = (e) => {
    e.stopPropagation();
    const pop = el('div', { class: 'stu-dest-pop' },
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { destOverride = null; paintDest(); pop.remove(); } }, el('b', { text: '자동 — 글에서 추정' })),
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { destOverride = { kind: 'liv' }; paintDest(); pop.remove(); } }, el('span', { class: 'stu-dest-dot liv' }), el('span', { text: '리브(정리·본문·태스크)' })),
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { destOverride = { kind: 'new' }; paintDest(); pop.remove(); } }, el('span', { class: 'stu-dest-dot new' }), el('span', { text: '새 세션 열어서' })),
      ...mySessions().filter((s) => s.live && s.alive).slice(0, 6).map((s) => el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { destOverride = { kind: 'session', sid: s.id, label: sessText(s, pj().name || '').main || s.label }; paintDest(); pop.remove(); } },
        el('span', { class: 'v2-dot ' + dotCls(s.stateKey) }), el('span', { text: sessText(s, pj().name || '').main || s.label }))));
    composer.append(pop);
    const off = (ev: MouseEvent): void => { if (!(ev.target as HTMLElement).closest('.stu-dest-pop, .stu-dest')) { pop.remove(); document.removeEventListener('click', off); } };
    window.setTimeout(() => document.addEventListener('click', off), 0);
  };
  input.addEventListener('input', () => { paintDest(); input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendComposer(); } });
  sendBtn.onclick = () => void sendComposer();
  async function sendComposer(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    const { dest } = guessDest(text);
    input.value = ''; input.style.height = 'auto'; destOverride = null; paintDest();
    if (dest.kind === 'liv') { openLiv(); chat?.say(text); return; }
    if (dest.kind === 'session') {
      try {
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(dest.sid) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) });
        toast(`「${dest.label}」 세션에 보냈어요.`);
        const wg = widgets.find((w) => w.type === 'session' && w.data?.sid === dest.sid);
        if (wg) { const ref = els.get(wg.id); ref?.root.classList.add('flash'); window.setTimeout(() => ref?.root.classList.remove('flash'), 1600); }
        else addWidget('session', { x: 72, y: 72 }, { sid: dest.sid });
      } catch (e: any) { toast('보내지 못했어요 — ' + (e?.message || e), true); }
      return;
    }
    await spawnSession(text);
  }
  async function spawnSession(firstPrompt: string | null): Promise<void> {
    const p = runPrefs();
    try {
      const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
        label: (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').slice(0, 28) : (pj().name || '새 세션').slice(0, 28)),
        harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
        flags: p.flags && typeof p.flags === 'object' ? p.flags : {}, autoApprove: !!p.autoApprove, sessionDir: true,
        ...(firstPrompt ? { initialPrompt: firstPrompt } : {}) }) });
      const sid = out?.session?.id ? String(out.session.id) : '';
      if (!sid) throw new Error('세션 id 를 받지 못했습니다');
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/project', { method: 'POST', body: JSON.stringify({ projectId: id }) }); } catch (_) { /* noop */ }
      addWidget('session', { x: 88, y: 88 }, { sid });
      toast(firstPrompt ? '새 세션을 열어 시켰어요 — 판에 카드로 올라왔습니다.' : '세션을 열고 판에 올렸어요.');
      opts.onProjectChanged?.();
    } catch (e: any) { toast('세션을 열지 못했어요 — ' + (e?.message || e), true); }
  }
  function toggleLiv(on?: boolean): void {
    const want = on != null ? on : livPanel.hidden;
    livPanel.hidden = !want;
    livToggle.classList.toggle('on', want);
  }
  function openLiv(): void { toggleLiv(true); }
  livToggle.onclick = () => toggleLiv();

  function mountChat(): void {
    chat = mountProjectChat(livBody, {
      projectId: id,
      onTurnDone: () => { void refreshDetail(); opts.onProjectChanged?.(); },
      onHasTurns: (has) => { (livToggle.querySelector('.stu-liv-n') as HTMLElement).hidden = !has; },
    });
  }
  async function refreshDetail(): Promise<void> {
    try { const d = await api('/api/ui/v6/projects/' + id); if (!dead && d) { detail = d; paintDoor(); refreshDataWidgets(); } } catch (_) { /* noop */ }
  }
  function refreshDataWidgets(): void {
    for (const spec of widgets) {
      if (spec.min || spec.type === 'session') continue;
      if (!['tasks', 'knowledge', 'desc', 'coach', 'automation', 'app-calendar'].includes(spec.type)) continue;
      const ref = els.get(spec.id);
      if (ref && ref.root.isConnected && !(document.activeElement && ref.root.contains(document.activeElement))) { sigs.delete(spec.id); fillBody(spec, ref.body, true); }
    }
  }

  // ── 새 산출물 자동 등장 ──
  async function autoSpawn(): Promise<void> {
    let data: any = null;
    try { data = await api('/api/ui/projects/' + id + '/files?path='); } catch (_) { return; }
    if (dead) return;
    const items: any[] = ((data && data.items) || []).filter((it: any) => it.type !== 'dir' && /\.(png|jpe?g|gif|webp|svg|pdf|html?)$/i.test(it.name));
    const fresh = items.filter((it: any) => Number(it.mtime || 0) * (String(it.mtime).length > 11 ? 1 : 1000) > lastSpawnTs)
      .filter((it: any) => !widgets.some((w) => w.type === 'preview' && w.data?.path === it.name));
    if (!lastSpawnTs) { lastSpawnTs = Date.now(); save(); return; }
    for (const it of fresh.slice(0, 2)) {
      addWidget('preview', { x: 120 + Math.random() * 120, y: 96 + Math.random() * 80 }, { path: it.name, name: it.name });
      toast('새 산출물이 판에 올라왔어요 — ' + it.name);
    }
    if (fresh.length) { lastSpawnTs = Date.now(); save(); }
  }

  // ── 판 그리기 ──
  function paintAll(): void {
    if (dead) return;
    els.clear(); sigs.clear();
    canvas.replaceChildren(
      ...widgets.map((s) => (s.data?.cm ? commentEl(s) : widgetEl(s))),
      el('div', { class: 'stu-boardhint', text: '선반에서 끌어다 놓기 · 크기를 끌면 구성이 바뀜(S/M/L) · [코멘트]로 어디든 표시' }));
    growCanvas();
  }
  function autoArrange(): void {
    const keep = widgets.filter((s) => s.data?.cm || s.type === 'sticky');
    widgets = [];
    addWidget('coach', { x: 32, y: 24 }, {}, { noSave: true });
    const live = mySessions().filter((s) => s.live && s.alive).slice(0, 3);
    live.forEach((s, i) => addWidget('session', i === 0 ? { x: 32, y: 298 } : { x: 424, y: 24 + (i - 1) * 332 }, { sid: s.id }, { noSave: true }));
    addWidget('tasks', { x: 796, y: 24 }, {}, { noSave: true });
    addWidget('knowledge', { x: 796, y: 356 }, {}, { noSave: true });
    widgets.push(...keep);
  }

  // ── 우패널: 런치패드 선반 + 타임라인 ──
  function renderAside(aside: HTMLElement): void {
    aside.replaceChildren();
    const tile = (d: WDef): HTMLElement => {
      const c = el('button', { class: 'stu-app', type: 'button', title: d.hint, draggable: 'true', onclick: () => addWidget(d.type) },
        el('span', { class: 'stu-app-ic', style: 'background:' + d.ac }, icon(d.ic, 'stu-i')),
        el('span', { class: 'stu-app-n', text: d.label }),
        d.shell ? el('span', { class: 'stu-shell-dot', title: '껍데기' }) : null);
      c.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', 'stu:' + d.type); });
      return c;
    };
    aside.append(
      el('div', { class: 'stu-shelf' },
        el('div', { class: 'stu-shelf-h', text: '위젯 · 앱' }),
        el('div', { class: 'stu-shelf-grid' }, ...WDEFS.filter((d) => !d.hidden).map(tile))));
    const tl = createTimeline(aside, { scope: '프로젝트 #' + id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }

  board.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
  board.addEventListener('drop', (e: DragEvent) => {
    const raw = e.dataTransfer?.getData('text/plain') || '';
    const r = canvas.getBoundingClientRect();
    const at = { x: e.clientX - r.left - 40, y: e.clientY - r.top - 16 };
    if (raw.startsWith('stu:')) { e.preventDefault(); addWidget(raw.slice(4) as WType, at); return; }
    if (raw.startsWith('tl:')) {
      e.preventDefault();
      try { const p = JSON.parse(raw.slice(3)); if (p && p.href) addWidget('doc', at, { hash: String(p.href), title: String(p.label || '문서') }); } catch (_) { /* noop */ }
    }
  });

  // ── 라이브 틱 — 세션·코치는 서명 비교로 제자리 갱신(입력·스크롤 보존) ──
  function armLive(): void {
    liveTimer = window.setInterval(() => {
      if (dead || document.hidden) return;
      tick++;
      paintDoor();
      const focused = document.activeElement as HTMLElement | null;
      for (const spec of widgets) {
        if (spec.min || (spec.type !== 'session' && spec.type !== 'coach')) continue;
        const ref = els.get(spec.id);
        if (!ref || !ref.root.isConnected) continue;
        if (focused && ref.root.contains(focused) && focused.tagName === 'INPUT') continue;   // 입력 중 — 건드리지 않는다(서명 비교가 있어도 안전하게)
        fillBody(spec, ref.body, false);
        if (spec.type === 'session') ref.title.textContent = widgetTitle(spec);
      }
      if (tick % 4 === 0) void autoSpawn();
    }, 8000);
  }

  // ── 시작 ──
  if (!load()) autoArrange();
  paintDoor();
  paintAll();
  mountChat();
  paintDest();
  armLive();
  void autoSpawn();
  if (!detail) void refreshDetail();

  return {
    destroy() { dead = true; if (liveTimer) clearInterval(liveTimer); chat?.destroy(); chat = null; closePeek(); },
    renderAside,
  };
}
