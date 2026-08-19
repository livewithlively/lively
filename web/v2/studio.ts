// v2/studio.ts — 실험장 v2(#1719 원준): 프로젝트 화면 = **작업대(캔버스)**.
//  v1 피드백 반영 전면 재설계(2026-08-19 원준):
//   · 위젯마다 **다른 디자인 언어** — 같은 흰 카드의 반복이 기능 직관을 죽였다. 세션=상태 띠+대화 거품,
//     리브 제안=민트, 자동화=보라, 포스트잇=노랑 테이프, 폴더=파일 그리드, 지식=문서 행, 앱=각자 액센트.
//   · 선반 = **런치패드**(아이콘 타일 + 이름) — 맥 앱처럼 보이게.
//   · 입력은 **하나** — 플로팅 컴포저. 글의 내용으로 행선지(리브/기존 세션/새 세션)를 추정해 칩으로 보여주고
//     사람이 바꿀 수 있다(오배송 비용 때문에 자동 100%가 아니라 '보이는 자동'부터 — v1 휴리스틱).
//   · 세션 카드 = 최근 주고받음(나/AI 한 줄씩) — 카드만 봐도 무슨 대화인지 안다.
//   · 코멘트 모드 — 판 위 어디서나 드래그로 영역을 잡고 코멘트(민트 마키), [리브에게]로 AI 에도 들어간다.
//   · 타임라인 항목(지식)은 판으로 끌어다 문서 위젯으로.
//   · 새 산출물(이미지·문서)이 생기면 판에 **프리뷰 위젯이 자동 등장**(30초 감시).
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

// ── 아이콘(스트로크 SVG — 이모지 금지, 시안과 같은 붓) ─────────────────────────
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
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
function icon(name: string, cls = 'stu-i'): SVGElement {
  const s = sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  s.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
  return s;
}

// ── 위젯 카탈로그 — 선반(런치패드)과 판이 같은 표를 본다 ─────────────────────────
type WType = 'session' | 'coach' | 'automation' | 'tasks' | 'knowledge' | 'folder' | 'desc' | 'timeline' | 'sticky' | 'preview' | 'doc' | 'app-meeting' | 'app-calendar' | 'app-slides';
interface WSpec { id: string; type: WType; x: number; y: number; w: number; h: number; min?: boolean; big?: boolean; z?: number; data?: any }
interface WDef { type: WType; label: string; hint: string; w: number; h: number; ic: string; ac: string; shell?: boolean; hidden?: boolean }
const WDEFS: WDef[] = [
  { type: 'session', label: 'AI 세션', hint: '세션 하나 — 최근 주고받음이 보이고, 컴포저 행선지로 잡아 시켜요', w: 340, h: 250, ic: 'chat', ac: '#2D6BF0' },
  { type: 'coach', label: '리브 제안', hint: '리브가 판을 읽고 워크플로우를 더 크게 쓰는 법을 제안해요', w: 360, h: 240, ic: 'spark', ac: '#0FA37E' },
  { type: 'automation', label: '자동화', hint: '반복을 붙박이로 — 켤 수 있는 자동화 제안', w: 340, h: 240, ic: 'bolt', ac: '#7C5CFC' },
  { type: 'tasks', label: '태스크', hint: '남은 할 일 — 진행 막대와 함께', w: 320, h: 300, ic: 'task', ac: '#D9772B' },
  { type: 'knowledge', label: '지식', hint: '필요·산출 지식 — 누르면 옆에서 펼쳐 읽어요', w: 320, h: 260, ic: 'book', ac: '#1BAEB0' },
  { type: 'folder', label: '공유 폴더', hint: '프로젝트 파일 — 그리드로, 누르면 미리보기', w: 380, h: 300, ic: 'folder', ac: '#5A6B85' },
  { type: 'desc', label: '명세', hint: '프로젝트 본문 — 필요할 때 꺼내 보는 문서', w: 440, h: 340, ic: 'doc', ac: '#8A99B5' },
  { type: 'timeline', label: '타임라인', hint: '남은 결과들 — 판 위에도 놓을 수 있어요', w: 340, h: 420, ic: 'clock', ac: '#15233B' },
  { type: 'sticky', label: '포스트잇', hint: '판에 붙이는 메모', w: 230, h: 170, ic: 'note', ac: '#D9A32B' },
  { type: 'app-meeting', label: '회의록', hint: '껍데기 — 회의록에서 결정·태스크를 뽑는 앱 자리', w: 340, h: 250, ic: 'mic', ac: '#B84E9C', shell: true },
  { type: 'app-calendar', label: '캘린더', hint: '껍데기 — 마감·회의·세션 예약이 놓일 자리', w: 340, h: 280, ic: 'cal', ac: '#D9772B', shell: true },
  { type: 'app-slides', label: '장표', hint: '껍데기 — 지식으로 보고 장표를 만드는 자리', w: 340, h: 240, ic: 'deck', ac: '#2D6BF0', shell: true },
  { type: 'preview', label: '프리뷰', hint: '파일 미리보기(자동 등장)', w: 360, h: 320, ic: 'img', ac: '#5A6B85', hidden: true },
  { type: 'doc', label: '문서', hint: '지식·문서 임베드', w: 460, h: 420, ic: 'doc', ac: '#1BAEB0', hidden: true },
];
const wdef = (t: WType): WDef => WDEFS.find((d) => d.type === t)!;
const GRID = 8;
const snap = (n: number): number => Math.max(0, Math.round(n / GRID) * GRID);
const LS_KEY = (id: number): string => 'lively_studio2_' + id;
const INJ_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;

export function mountStudio(host: HTMLElement, opts: StudioOpts): StudioHandle {
  const id = opts.id;
  let detail: any = opts.detail;
  let dead = false;
  let chat: ProjectChatHandle | null = null;
  let zTop = 10;
  let liveTimer: number | null = null;
  let tick = 0;
  let commentMode = false;

  // ── 배치 상태(이 브라우저) ──
  let widgets: WSpec[] = [];
  let seq = 1;
  let lastSpawnTs = 0;   // 자동 등장 프리뷰의 기준 시각(이보다 새 파일만 판에 올린다)
  const els = new Map<string, { root: HTMLElement; body: HTMLElement; title: HTMLElement }>();
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

  // ── 골격 — 문패 / 판(+코멘트 층) / 플로팅 컴포저·리브 패널 ──
  const door = el('header', { class: 'stu-door' });
  const canvas = el('div', { class: 'stu-canvas' });
  const cmLayer = el('div', { class: 'stu-cmlayer', hidden: true });     // 코멘트 모드에서만 활성(판 최상위)
  const board = el('div', { class: 'stu-board' }, canvas, cmLayer);
  const wrap = el('div', { class: 'stu-wrap' }, door, board) as HTMLElement;
  host.replaceChildren(wrap);

  // ── 문패 ──
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
        el('div', { class: 'stu-eyebrow' },
          el('span', { class: 'mono', text: '#' + p.id }), el('span', { class: 'sep', text: '·' }),
          el('span', { class: 'stu-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `지식 ${knN}` })),
        el('h1', { class: 'stu-title', text: p.name || '프로젝트 #' + id })),
      el('div', { class: 'stu-door-r' },
        el('span', { class: 'stu-faces' }, ...members.slice(0, 5).map((m: any) => personFace(String(m.member_id || m), 'stu-face', String(m.display_name || m.member_id || '')))),
        cmBtn,
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '명세', onclick: () => addOrFocus('desc') }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '정리', title: '위젯 자동 재배치', onclick: () => { autoArrange(); paintAll(); save(); } })));
    cmBtn.classList.toggle('on', commentMode);
  }

  // ── 위젯 공통 틀 — 타입별 액센트 띠·머리 아이콘(디자인 언어 분리) ──
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
  function removeWidget(spec: WSpec): void { widgets = widgets.filter((w) => w !== spec); save(); paintAll(); }

  function widgetEl(spec: WSpec): HTMLElement {
    if (spec.type === 'sticky') return stickyEl(spec);
    const d = wdef(spec.type);
    const body = el('div', { class: 'stu-w-body' });
    const titleEl2 = el('b', { class: 'stu-w-t', text: widgetTitle(spec) });
    const head = el('div', { class: 'stu-w-head' },
      el('span', { class: 'stu-w-ic', style: 'color:' + d.ac }, icon(d.ic, 'stu-i sm')),
      titleEl2,
      d.shell ? el('span', { class: 'stu-shell-badge', text: '껍데기' }) : null,
      el('span', { class: 'stu-w-acts' },
        el('button', { class: 'stu-w-btn', type: 'button', title: spec.min ? '펼치기' : '접기', text: spec.min ? '▸' : '▾', onclick: (e: Event) => { e.stopPropagation(); spec.min = !spec.min; save(); paintAll(); } }),
        spec.type === 'session' && spec.data?.sid
          ? el('button', { class: 'stu-w-btn', type: 'button', title: '전체 화면(대화창)', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); location.hash = '#/s/' + encodeURIComponent(String(spec.data.sid)); } })
          : el('button', { class: 'stu-w-btn', type: 'button', title: spec.big ? '원래 크기' : '크게', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); toggleBig(spec); } }),
        el('button', { class: 'stu-w-btn', type: 'button', title: '판에서 치우기(데이터는 안 지워져요)', text: '×', onclick: (e: Event) => { e.stopPropagation(); removeWidget(spec); } })));
    const w = el('div', { class: 'stu-w stu-w-' + spec.type + (spec.min ? ' min' : ''), style: `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;${spec.min ? '' : 'height:' + spec.h + 'px;'}z-index:${spec.z || 1};--wac:${d.ac}` }, head, body,
      el('div', { class: 'stu-w-rsz', title: '크기 조절' }));
    els.set(spec.id, { root: w, body, title: titleEl2 });
    if (!spec.min) fillBody(spec, body);
    wireDrag(spec, w, head);
    wireResize(spec, w);
    w.addEventListener('mousedown', () => { spec.z = ++zTop; w.style.zIndex = String(spec.z); });
    return w;
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
  function toggleBig(spec: WSpec): void {
    const d = wdef(spec.type);
    if (spec.big) { spec.w = d.w; spec.h = d.h; spec.big = false; }
    else { spec.w = 780; spec.h = 560; spec.big = true; spec.z = ++zTop; }
    save(); paintAll();
  }
  function wireDrag(spec: WSpec, w: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, input, textarea, a, select')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = spec.x, oy = spec.y;
      const move = (ev: MouseEvent): void => { spec.x = snap(ox + ev.clientX - sx); spec.y = snap(oy + ev.clientY - sy); w.style.left = spec.x + 'px'; w.style.top = spec.y + 'px'; };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); growCanvas(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function wireResize(spec: WSpec, w: HTMLElement): void {
    const h = w.querySelector('.stu-w-rsz') as HTMLElement | null;
    if (!h) return;
    h.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = spec.w, oh = spec.h;
      const move = (ev: MouseEvent): void => { spec.w = Math.max(200, snap(ow + ev.clientX - sx)); spec.h = Math.max(120, snap(oh + ev.clientY - sy)); w.style.width = spec.w + 'px'; if (!spec.min) w.style.height = spec.h + 'px'; };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); spec.big = false; save(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function growCanvas(): void {
    const mx = Math.max(1500, ...widgets.map((s) => s.x + s.w + 80));
    const my = Math.max(900, ...widgets.map((s) => s.y + (s.min ? 40 : s.h) + 140));
    canvas.style.width = mx + 'px'; canvas.style.height = my + 'px';
    cmLayer.style.width = mx + 'px'; cmLayer.style.height = my + 'px';
  }

  // ── 위젯 본문 ──
  function fillBody(spec: WSpec, body: HTMLElement): void {
    const t = spec.type;
    if (t === 'session') void fillSession(spec, body);
    else if (t === 'coach') fillCoach(body);
    else if (t === 'automation') fillAutomation(body);
    else if (t === 'tasks') fillTasks(body);
    else if (t === 'knowledge') fillKnowledge(body);
    else if (t === 'folder') void fillFolder(body);
    else if (t === 'desc') fillDesc(body);
    else if (t === 'timeline') fillTimeline(body);
    else if (t === 'preview') fillPreview(spec, body);
    else if (t === 'doc') fillDoc(spec, body);
    else if (t === 'app-meeting') fillMeeting(body);
    else if (t === 'app-calendar') fillCalendar(body);
    else if (t === 'app-slides') fillSlides(body);
  }

  // 세션 — 최근 주고받음(나/AI). 입력칸은 없다: 입력은 아래 컴포저 하나, [여기에 시키기]가 행선지를 이 세션으로.
  const tailCache = new Map<string, { ask: string; ans: string; at: number }>();
  async function fetchTail(s: Sess): Promise<{ ask: string; ans: string }> {
    const hit = tailCache.get(s.id);
    if (hit && Date.now() - hit.at < 15000) return hit;
    let ask = '', ans = '';
    try {
      const headers: Record<string, string> = {};
      const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
      const res = await fetch(apiUrl('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/transcript?tail=24000'), { headers, credentials: 'same-origin' });
      if (res.ok) {
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue;
          let o: any; try { o = JSON.parse(line); } catch { continue; }
          if (!o || o.isSidechain || o.isMeta) continue;
          if (o.type === 'user') {
            const c = o.message?.content;
            const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join(' ') : '';
            const one = txt.replace(/\s+/g, ' ').trim();
            if (one && !INJ_RE.test(one)) { ask = one; ans = ''; }
          } else if (o.type === 'assistant') {
            const c = o.message?.content;
            const txt = Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join(' ') : '';
            const one = txt.replace(/\s+/g, ' ').trim();
            if (one) ans = one;
          }
        }
      }
    } catch (_) { /* 기록을 못 읽는 하네스(409 등) — 거품 없이 상태만 */ }
    const out = { ask: ask.slice(0, 120), ans: ans.slice(0, 160), at: Date.now() };
    tailCache.set(s.id, out);
    return out;
  }
  async function fillSession(spec: WSpec, body: HTMLElement): Promise<void> {
    const sid = spec.data?.sid ? String(spec.data.sid) : '';
    const s = sid ? mySessions().find((x) => x.id === sid) : null;
    if (!s) {
      const list = mySessions();
      body.replaceChildren(
        el('p', { class: 'stu-fine', text: list.length ? '판에 올릴 세션을 고르세요.' : '아직 세션이 없어요 — 아래 컴포저로 시키면 자동으로 생깁니다.' }),
        el('div', { class: 'stu-pick' }, ...list.slice(0, 8).map((x) => el('button', { class: 'stu-pick-row', type: 'button', onclick: () => { spec.data = { sid: x.id }; save(); paintAll(); } },
          el('span', { class: 'v2-dot ' + dotCls(x.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'n', text: x.label || x.id }), el('span', { class: 'm', text: x.stateLabel })))));
      return;
    }
    const raw = s.raw || {};
    const waiting = s.stateKey === 'waiting';
    const stripe = els.get(spec.id)?.root;
    if (stripe) stripe.style.setProperty('--wac', s.stateKey === 'busy' ? '#2D6BF0' : waiting ? '#D9A32B' : s.stateKey === 'done' ? '#16C79A' : '#A6B2C8');
    const work = String(raw.title || '').trim();
    const key = (action: string, label: string, primary?: boolean): HTMLElement =>
      el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text: label, onclick: () => {
        void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/keys', { method: 'POST', body: JSON.stringify({ action }) })
          .then(() => toast(label + ' — 보냈어요.')).catch((err: any) => toast('실패 — ' + (err?.message || err), true));
      } });
    body.replaceChildren(
      el('div', { class: 'stu-sess-st' },
        el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }),
        raw.harness ? el('span', { class: 'stu-hbadge mono', text: String(raw.harness) }) : null,
        el('span', { class: 'stu-fine', style: 'margin-left:auto', text: s.lastSeen ? relTime(new Date(s.lastSeen).toISOString()) : '' })),
      work && !INJ_RE.test(work) ? el('div', { class: 'stu-sess-now', title: work }, icon('bolt', 'stu-i sm'), el('span', { text: work })) : null,
      el('div', { class: 'stu-sess-x', 'data-x': '1' }),
      ...(waiting ? [el('div', { class: 'stu-sess-keys' }, key('approve', '승인', true), key('deny', '거부'), key('interrupt', '멈춤'))] : []),
      (() => {   // 카드에서 바로 친다(원준 2026-08-19) — 행선지 점프 대신 그 자리 입력. Enter = 이 세션으로 전송.
        const inp = el('input', { class: 'stu-sess-in', type: 'text', placeholder: '이 세션에 시키기 — Enter', 'aria-label': '이 세션에 시키기' }) as HTMLInputElement;
        inp.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          const text = inp.value.trim();
          if (!text) return;
          inp.disabled = true;
          void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) })
            .then(() => { inp.value = ''; toast('보냈어요 — 답은 카드와 대화창에 나타납니다.'); })
            .catch((err: any) => toast('보내지 못했어요 — ' + (err?.message || err), true))
            .finally(() => { inp.disabled = false; inp.focus(); });
        });
        return el('div', { class: 'stu-sess-footrow' }, inp,
          el('a', { class: 'btn-text', href: '#/s/' + encodeURIComponent(s.id), text: '열기 →', title: '전체 대화창' }));
      })());
    if (s.live && !s.node) {
      const x = body.querySelector('.stu-sess-x') as HTMLElement | null;
      const t = await fetchTail(s);
      if (dead || !x || !x.isConnected) return;
      // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다 — 조건부 자식은 배열 스프레드로.
      x.replaceChildren(
        ...(t.ask ? [el('div', { class: 'stu-bub me', title: t.ask }, el('span', { class: 'who', text: '나' }), el('span', { class: 'tx', text: t.ask }))] : [el('p', { class: 'stu-fine', text: '아직 주고받은 말이 없어요.' })]),
        ...(t.ans ? [el('div', { class: 'stu-bub ai', title: t.ans }, el('span', { class: 'who', text: 'AI' }), el('span', { class: 'tx', text: t.ans }))] : []));
    }
  }

  // 리브 제안(민트) — 판 상태에서 계산한 '더 크게 쓰기'.
  function coachRow(txt: string, say: string): HTMLElement {
    return el('div', { class: 'stu-coach-row' }, el('span', { class: 'n', text: txt }),
      el('button', { class: 'stu-mintbtn', type: 'button', text: '리브에게', onclick: () => { openLiv(); chat?.say(say); } }));
  }
  function fillCoach(body: HTMLElement): void {
    const ss = mySessions();
    const waiting = ss.filter((s) => s.stateKey === 'waiting');
    const idle = ss.filter((s) => s.live && s.alive && s.stateKey === 'idle');
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const noMeta = tasks.filter((tk) => tk.status_category !== 'done' && !tk.due_date && !(tk.assignees && tk.assignees.length)).length;
    const rows: HTMLElement[] = [];
    if (waiting.length) rows.push(coachRow(`세션 ${waiting.length}개가 답을 기다려요 — 물음을 모아 볼까요?`, '답을 기다리는 세션들의 질문을 모아 요약해 줘. 한 번에 결정할 수 있게.'));
    if (idle.length >= 2) rows.push(coachRow(`조용한 세션 ${idle.length}개 — 결과를 지식으로 정리하고 닫을 수 있어요.`, '조용한 세션들이 남긴 결과를 지식으로 정리하고, 닫아도 되는 세션을 알려 줘.'));
    if (noMeta >= 3) rows.push(coachRow(`담당·마감 없는 할 일 ${noMeta}개 — 정리하면 병렬로 시킬 수 있어요.`, '상태·마감·담당을 점검하고 비거나 어긋난 걸 정리해 줘.'));
    rows.push(coachRow('이 작업, 세션 2~3개로 나눠 병렬로 돌릴 수 있어요.', '지금 작업을 병렬 세션 2~3개로 나누는 안을 제안해 줘. 각 세션의 첫 지시까지.'));
    body.replaceChildren(el('div', { class: 'stu-coach-rows' }, ...rows.slice(0, 4)),
      el('p', { class: 'stu-fine', text: '판의 상태에서 계산한 제안 — 누르면 리브 대화로 들어가요.' }));
  }

  // 자동화(보라) — 반복을 붙박이로. 지금은 제안+리브 배선(실제 예약 실행은 다음 단계).
  function fillAutomation(body: HTMLElement): void {
    const row = (t: string, d2: string, say: string): HTMLElement => el('div', { class: 'stu-auto-row' },
      el('span', { class: 'stu-auto-ic' }, icon('bolt', 'stu-i sm')),
      el('span', { class: 'b' }, el('b', { text: t }), el('span', { class: 'stu-fine', text: d2 })),
      el('button', { class: 'stu-violetbtn', type: 'button', text: '켜기', onclick: () => { openLiv(); chat?.say(say); } }));
    body.replaceChildren(
      row('아침 브리프', '매일 9시, 밤새 남긴 것 요약을 판과 대화로', '매일 아침 9시에 이 프로젝트의 전날 결과(지식·커밋·결정)를 요약해 주는 자동화를 만들려면 어떻게 하면 되는지 제안하고, 가능하면 만들어 줘.'),
      row('회의록 → 태스크', '회의록이 올라오면 결정·태스크 자동 추출', '공유 폴더에 회의록이 올라오면 결정·태스크를 자동 추출하는 흐름을 제안하고, 가능하면 만들어 줘.'),
      row('화면 회귀 검증', '화면 바뀔 때마다 스크린샷 비교를 상시 세션에', '화면이 바뀔 때마다 스크린샷을 찍어 이전과 비교하는 상시 검증 흐름을 제안해 줘.'),
      el('p', { class: 'stu-fine', text: '켜기 = 리브에게 설계·생성을 맡깁니다(예약 실행 붙박이는 다음 단계).' }));
  }

  // 태스크(주황) — 진행 막대 + 체크 스타일 행.
  function fillTasks(body: HTMLElement): void {
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const done = tasks.filter((tk) => tk.status_category === 'done').length;
    const open = tasks.filter((tk) => tk.status_category !== 'done');
    const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    body.replaceChildren(
      el('div', { class: 'stu-taskbar' }, el('i', { style: 'width:' + pct + '%' }), el('span', { class: 'stu-fine', text: `${done}/${tasks.length} · ${pct}%` })),
      open.length ? el('div', { class: 'stu-rows' }, ...open.slice(0, 12).map((tk) => el('a', { class: 'stu-task-row', href: '#/projects2/t/' + tk.id, title: tk.name },
        el('span', { class: 'stu-ck' + (tk.status_category === 'started' ? ' run' : ''), 'aria-hidden': 'true' }),
        el('span', { class: 'n', text: tk.name }),
        tk.due_date ? el('span', { class: 'm mono', text: String(tk.due_date).slice(5, 10) }) : null)))
        : el('p', { class: 'stu-fine', text: '남은 할 일이 없어요.' }),
      el('div', { class: 'stu-w-foot' }, el('button', { class: 'btn-text', type: 'button', text: '리브에게 나누기', onclick: () => { openLiv(); chat?.say('이 프로젝트를 태스크로 나눠 줘. 만들기 전에 목록 먼저.'); } })));
  }

  // 지식(청록 문서) — 행 = 문서. 클릭 = 피크.
  function fillKnowledge(body: HTMLElement): void {
    const kn = pj().knowledge || {};
    const rows: HTMLElement[] = [];
    for (const [rel, list] of [['필요', kn.required || []], ['산출', kn.produced || []]] as Array<[string, any[]]>) {
      for (const k of list) rows.push(el('button', { class: 'stu-doc-row', type: 'button', title: k.name, onclick: () => openPeek('#/k/' + encodeURIComponent(k.name), k.name) },
        icon('doc', 'stu-i sm'), el('span', { class: 'n', text: k.name }), el('span', { class: 'stu-kn-rel' + (rel === '산출' ? ' prod' : ''), text: rel })));
    }
    body.replaceChildren(rows.length ? el('div', { class: 'stu-rows' }, ...rows.slice(0, 14)) : el('p', { class: 'stu-fine', text: '연결된 지식이 아직 없어요.' }));
  }

  // 폴더(파일 그리드 — Finder 감각).
  async function fillFolder(body: HTMLElement): Promise<void> {
    body.replaceChildren(el('p', { class: 'stu-fine', text: '불러오는 중…' }));
    let data: any = null;
    try { data = await api('/api/ui/projects/' + id + '/files?path='); } catch (e: any) { body.replaceChildren(el('p', { class: 'stu-fine', text: '폴더를 못 읽었어요 — ' + (e?.message || e) })); return; }
    if (dead) return;
    const items: any[] = (data && data.items) || [];
    const tile = (it: any): HTMLElement => el('button', { class: 'stu-file', type: 'button', title: it.name, onclick: () => {
      if (it.type === 'dir') { openPeek('#/f?root=shared&path=' + encodeURIComponent('project/' + id + '/' + it.name), it.name); return; }
      if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(it.name)) { addWidget('preview', { x: 80, y: 80 }, { path: it.name, name: it.name }); return; }
      void openFileViewer(id, it.name, it.name, () => { /* noop */ }, '/api/ui/projects/');
    } },
      el('span', { class: 'stu-file-ic' + (it.type === 'dir' ? ' dir' : '') }, icon(it.type === 'dir' ? 'folder' : /\.(png|jpe?g|gif|webp|svg)$/i.test(it.name) ? 'img' : 'doc', 'stu-i')),
      el('span', { class: 'n', text: it.name }), el('span', { class: 'm', text: it.type === 'dir' ? '폴더' : fmtSize(it.size || 0) }));
    body.replaceChildren(items.length ? el('div', { class: 'stu-filegrid' }, ...items.slice(0, 18).map(tile)) : el('p', { class: 'stu-fine', text: '아직 파일이 없어요.' }));
  }

  function fillDesc(body: HTMLElement): void {
    const md = String(pj().description || '').trim();
    body.replaceChildren(
      md ? el('div', { class: 'stu-md' }, renderMarkdown(md)) : el('p', { class: 'stu-fine', text: '본문이 아직 없어요.' }),
      el('div', { class: 'stu-w-foot' }, el('button', { class: 'btn-text', type: 'button', text: '리브에게 정돈 맡기기', onclick: () => { openLiv(); chat?.say('본문을 정돈된 형식으로 다시 써 줘. 사실·결정·링크는 하나도 잃지 말고.'); } })));
  }
  function fillTimeline(body: HTMLElement): void {
    const tl = createTimeline(body, { scope: '프로젝트 #' + id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }
  function fillPreview(spec: WSpec, body: HTMLElement): void {
    const path = String(spec.data?.path || '');
    const url = apiUrl('/api/ui/projects/' + id + '/file?path=' + encodeURIComponent(path));
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) body.replaceChildren(el('img', { class: 'stu-prev-img', src: url, alt: path, loading: 'lazy' }));
    else if (/\.pdf$/i.test(path)) body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: url + '#toolbar=0&view=FitH', title: path }));
    else body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: url, title: path }));
    body.append(el('div', { class: 'stu-w-foot' }, el('span', { class: 'stu-fine', text: path }),
      el('button', { class: 'btn-text', type: 'button', text: '크게', onclick: () => void openFileViewer(id, path, path, () => { /* noop */ }, '/api/ui/projects/') })));
  }
  function fillDoc(spec: WSpec, body: HTMLElement): void {
    const hash = String(spec.data?.hash || '');
    body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: location.pathname + '?embed=1' + hash, title: String(spec.data?.title || '문서') }));
  }
  function fillMeeting(body: HTMLElement): void {
    body.replaceChildren(el('p', { class: 'stu-shell-p', text: '회의록을 넣으면 결정·태스크·미결이 추출되어 이 프로젝트에 연결되는 자리예요.' }),
      el('div', { class: 'stu-coach-rows' },
        coachRow('회의록 추출을 지금 맡겨 보기', '공유 폴더의 회의록을 찾아 결정·태스크·미결을 추출하고, 태스크로 만들지 목록 먼저 보여 줘.')));
  }
  function fillCalendar(body: HTMLElement): void {
    const tasks: any[] = (Array.isArray(pj().tasks) ? pj().tasks : []).filter((tk: any) => tk.due_date && tk.status_category !== 'done');
    body.replaceChildren(el('p', { class: 'stu-shell-p', text: '태스크 마감·회의·세션 예약(정기 실행)이 한 달력에 놓일 자리예요.' }),
      tasks.length ? el('div', { class: 'stu-rows' }, ...tasks.slice(0, 6).map((tk: any) => el('a', { class: 'stu-task-row', href: '#/projects2/t/' + tk.id },
        el('span', { class: 'm mono', text: String(tk.due_date).slice(5, 10) }), el('span', { class: 'n', text: tk.name })))) : el('p', { class: 'stu-fine', text: '마감 있는 할 일이 아직 없어요.' }),
      el('div', { class: 'stu-coach-rows' }, coachRow('마감 점검 맡기기', '마감이 지난·임박한 태스크를 점검하고 조정안을 제안해 줘.')));
  }
  function fillSlides(body: HTMLElement): void {
    body.replaceChildren(el('p', { class: 'stu-shell-p', text: '이 프로젝트의 지식·산출물로 보고용 장표(HTML)를 만들어 판에 놓는 자리예요.' }),
      el('div', { class: 'stu-coach-rows' }, coachRow('산출지식으로 장표 초안', '산출지식으로 보고용 장표(HTML) 초안을 만들어 줘. 목차 먼저.')));
  }

  // 포스트잇 — 테이프 달린 노랑 쪽지(머리 없음, 전체가 손잡이).
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
    wireResize(spec, w);
    w.addEventListener('mousedown', () => { spec.z = ++zTop; w.style.zIndex = String(spec.z); });
    return w;
  }

  // ── 코멘트 모드 — 판 최상위 마키(민트). 드래그 = 영역, 놓으면 코멘트 카드. ──
  function setCommentMode(on: boolean): void {
    commentMode = on;
    cmLayer.hidden = !on;
    board.classList.toggle('cm-on', on);
    cmBtn.classList.toggle('on', on);
    if (on) toast('코멘트 모드 — 판 위를 드래그해 영역을 잡으세요. (버튼으로 끔)');
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
      if (w2 < 24 || h2 < 18) return;   // 실수 클릭은 코멘트가 아니다
      const spec: WSpec = { id: 'w' + seq++, type: 'sticky', x: 0, y: 0, w: 0, h: 0, data: { cm: { x: snap(x), y: snap(y), w: snap(w2), h: snap(h2) }, text: '' } };
      (spec as any).comment = true;
      widgets.push(spec);
      save(); paintAll();
      setCommentMode(false);
      window.setTimeout(() => { (canvas.querySelector('[data-cm="' + spec.id + '"] textarea') as HTMLTextAreaElement | null)?.focus(); }, 30);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  // 코멘트(영역+카드) 렌더 — 위젯 배열에 살지만 생김새는 마키 민트.
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
        el('button', { class: 'stu-mintbtn', type: 'button', text: '리브에게', title: '이 코멘트를 리브 대화로 보냅니다', onclick: () => {
          const t = ta.value.trim(); if (!t) { toast('코멘트를 먼저 써 주세요.', true); return; }
          openLiv(); chat?.say('[캔버스 코멘트 · 판 좌표 ' + cm.x + ',' + cm.y + ' 근처] ' + t);
        } })));
    const g = el('div', { class: 'stu-cmt', 'data-cm': spec.id, style: `left:${cm.x}px;top:${cm.y}px;z-index:${spec.z || 5}` },
      el('div', { class: 'stu-cmt-region', style: `width:${cm.w}px;height:${cm.h}px` }), card);
    // 카드 머리를 끌면 그룹 이동
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

  // ── 피크(오른쪽 펼쳐 읽기) ──
  let peekEl: HTMLElement | null = null;
  function closePeek(): void { if (peekEl) { peekEl.remove(); peekEl = null; document.removeEventListener('keydown', peekEsc, true); } }
  function peekEsc(e: KeyboardEvent): void { if (e.key === 'Escape') { e.stopPropagation(); closePeek(); } }
  function openPeek(hash: string, title: string): void {
    closePeek();
    const pe = el('div', { class: 'stu-peek' },
      el('div', { class: 'stu-peek-h' }, el('b', { text: title }),
        el('span', { class: 'stu-w-acts' },
          el('button', { class: 'btn-text', type: 'button', text: '판에 놓기', title: '이 문서를 위젯으로 판에 둡니다', onclick: () => { addWidget('doc', { x: 120, y: 80 }, { hash, title }); closePeek(); } }),
          el('a', { class: 'btn-text', href: hash, target: '_blank', rel: 'noopener', text: '새 탭 ↗' }),
          el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '닫기(Esc)', onclick: closePeek }))),
      el('iframe', { class: 'stu-peek-f', src: location.pathname + '?embed=1' + hash, title }));
    peekEl = pe;
    wrap.append(pe);
    document.addEventListener('keydown', peekEsc, true);
  }

  // ── 플로팅 컴포저(입력은 하나) + 리브 패널 ──
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
    // ① 기존 세션 — 세션 이름·지금 하는 일과 겹치면 그 세션(홈 런처의 매칭 규칙과 같은 감각)
    let best: { s: Sess; score: number; hit: string } | null = null;
    for (const s of mySessions().filter((x) => x.live && x.alive)) {
      const name = (s.label || '') + ' ' + String(s.raw?.title || '');
      let score = 0, hit = '';
      for (const tok of tokensOf(name)) if (t.includes(tok)) { score += tok.length; if (tok.length > hit.length) hit = tok; }
      if (score && (!best || score > best.score)) best = { s, score, hit };
    }
    if (best && best.score >= 4) return { dest: { kind: 'session', sid: best.s.id, label: sessText(best.s, pj().name || '').main || best.s.label }, why: `「${best.hit}」가 닿았어요` };
    // ② 워크스페이스 정리 명령 — 리브가 받는다
    if (/(본문|명세|태스크|할 일|할일|상태|정리|요약|지식|연결|이름|마감|담당|우선순위|프로젝트)/.test(t)) return { dest: { kind: 'liv' }, why: '정리 명령으로 읽혀요' };
    // ③ 그 밖의 일 — 새 세션
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
  function setDest(d: Dest | null, focus?: boolean): void { destOverride = d; paintDest(); if (focus) input.focus(); }
  destChip.onclick = (e) => {
    e.stopPropagation();
    const pop = el('div', { class: 'stu-dest-pop' },
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { setDest(null); pop.remove(); } }, el('b', { text: '자동 — 글에서 추정' })),
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { setDest({ kind: 'liv' }); pop.remove(); } }, el('span', { class: 'stu-dest-dot liv' }), el('span', { text: '리브(정리·본문·태스크)' })),
      el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { setDest({ kind: 'new' }); pop.remove(); } }, el('span', { class: 'stu-dest-dot new' }), el('span', { text: '새 세션 열어서' })),
      ...mySessions().filter((s) => s.live && s.alive).slice(0, 6).map((s) => el('button', { class: 'stu-dest-opt', type: 'button', onclick: () => { setDest({ kind: 'session', sid: s.id, label: sessText(s, pj().name || '').main || s.label }); pop.remove(); } },
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
      if (ref && ref.root.isConnected && !(document.activeElement && ref.root.contains(document.activeElement))) fillBody(spec, ref.body);
    }
  }

  // ── 새 산출물 자동 등장 — 30초마다 폴더를 보고, 새 이미지·PDF 를 판에 올린다 ──
  async function autoSpawn(): Promise<void> {
    let data: any = null;
    try { data = await api('/api/ui/projects/' + id + '/files?path='); } catch (_) { return; }
    if (dead) return;
    const items: any[] = ((data && data.items) || []).filter((it: any) => it.type !== 'dir' && /\.(png|jpe?g|gif|webp|svg|pdf|html?)$/i.test(it.name));
    const fresh = items.filter((it: any) => Number(it.mtime || 0) * (String(it.mtime).length > 11 ? 1 : 1000) > lastSpawnTs)
      .filter((it: any) => !widgets.some((w) => w.type === 'preview' && w.data?.path === it.name));
    if (!lastSpawnTs) { lastSpawnTs = Date.now(); save(); return; }   // 첫 방문 — 과거 파일을 쏟아붓지 않는다
    for (const it of fresh.slice(0, 2)) {
      addWidget('preview', { x: 120 + Math.random() * 120, y: 96 + Math.random() * 80 }, { path: it.name, name: it.name });
      toast('새 산출물이 판에 올라왔어요 — ' + it.name);
    }
    if (fresh.length) { lastSpawnTs = Date.now(); save(); }
  }

  // ── 판 그리기 ──
  function paintAll(): void {
    if (dead) return;
    els.clear();
    canvas.replaceChildren(
      ...widgets.map((s) => ((s as any).comment || s.data?.cm ? commentEl(s) : widgetEl(s))),
      el('div', { class: 'stu-boardhint', text: '선반에서 끌어다 놓기 · 머리 끌면 이동 · 모서리로 크기 · [코멘트]로 어디든 표시' }));
    growCanvas();
  }
  function autoArrange(): void {
    const keep = widgets.filter((s) => (s as any).comment || s.data?.cm || s.type === 'sticky');
    widgets = [];
    seq = Math.max(1, seq);
    addWidget('coach', { x: 32, y: 24 }, {}, { noSave: true });
    const live = mySessions().filter((s) => s.live && s.alive).slice(0, 3);
    live.forEach((s, i) => addWidget('session', i === 0 ? { x: 32, y: 296 } : { x: 424, y: 24 + (i - 1) * 284 }, { sid: s.id }, { noSave: true }));
    addWidget('tasks', { x: 796, y: 24 }, {}, { noSave: true });
    addWidget('knowledge', { x: 796, y: 356 }, {}, { noSave: true });
    widgets.push(...keep);
  }

  // ── 우패널: 런치패드 선반 + 타임라인(결과만) ──
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

  // 판에 드롭 — 선반 위젯 + 타임라인 지식(문서로)
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

  // ── 라이브 틱 — 문패 + 세션·코치 제자리 갱신(8초), 산출물 감시(32초) ──
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
        if (focused && ref.root.contains(focused)) continue;
        fillBody(spec, ref.body);
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
  void autoSpawn();          // 기준 시각 시딩(첫 방문은 안 쏟아붓는다)
  if (!detail) void refreshDetail();

  return {
    destroy() { dead = true; if (liveTimer) clearInterval(liveTimer); chat?.destroy(); chat = null; closePeek(); },
    renderAside,
  };
}
