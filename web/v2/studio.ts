// v2/studio.ts — 실험장(#1719 원준): 프로젝트 화면 = **작업대(캔버스)**. C(작업대)를 뼈대로,
//  E(고요한 문패·여백)·B(살아 있는 세션 카드)·2부(핀·타임라인 부품)를 조립한 판이다.
//
//  ── 구도 ──
//  문패(door)   — 프로젝트 이름·번호·상태·숫자(가장 눈에 들어오게, 원준 지시). 명세는 상시 노출하지 않고 위젯으로 소환.
//  판(board)    — 점 격자 캔버스. 위젯(세션·태스크·지식·폴더·명세·타임라인·스티키·리브 제안·앱 껍데기)을
//                 자유 배치·크기 조절·접기. 배치는 이 브라우저에 기억(localStorage) — 팀 공유 좌표는 다음 단계.
//  바닥(chat)   — 리브 대화(mountProjectChat, 실동작). 위젯의 [리브에게] 칩이 전부 이 대화로 흘러든다 —
//                 "AI 로 캔버스와 내용을 조작한다"의 첫 배선이다.
//  우패널       — 위젯 선반(끌어다 놓기/클릭 추가) + 프로젝트 타임라인.
//
//  ── 이 파일이 알면서 안 하는 것(원준에게 설명함) ──
//  · 화면 전체(홈 등)를 위젯으로 축소 배치 — 위젯은 '데이터를 아는 타입'만. 임의 화면 임베드는 죽은 액자다.
//  · 세션 위젯 안 전체 대화 — 읽기는 전체 화면(기존 대화창), 카드는 지금 하는 일 + 던지기만.
//  · 팀 공유 배치·실시간 커서 — 서버 저장이 필요한 P3.
import { api, el, personFace, relTime, renderMarkdown, toast } from '../core.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline } from '../timeline-sources.js';
import { fileIconSvg, fmtSize, openFileViewer } from '../projects/files.js';
import { runPrefs } from './run-picker.js';
import { sessText } from './side.js';
import { makeSplitter } from './split.js';
import { dotCls, type Sess, type V2Data } from './views.js';

export interface StudioOpts {
  data: () => V2Data;
  id: number;
  detail: any;
  onProjectChanged?: () => void;
}
export interface StudioHandle { destroy(): void; renderAside(aside: HTMLElement): void; }

// ── 위젯 카탈로그 — 선반과 판이 같은 표를 본다 ────────────────────────────────
type WType = 'session' | 'tasks' | 'knowledge' | 'folder' | 'desc' | 'timeline' | 'sticky' | 'coach' | 'app-meeting' | 'app-calendar' | 'app-slides';
interface WSpec { id: string; type: WType; x: number; y: number; w: number; h: number; min?: boolean; big?: boolean; data?: any }
interface WDef { type: WType; label: string; hint: string; w: number; h: number; shell?: boolean }
const WDEFS: WDef[] = [
  { type: 'session', label: 'AI 세션', hint: '이 프로젝트의 세션 하나 — 지금 하는 일이 살아서 보이고, 바로 시킬 수 있어요', w: 330, h: 240 },
  { type: 'coach', label: '리브 제안', hint: '리브가 이 판을 읽고 워크플로우를 더 밀어붙일 방법을 제안해요', w: 360, h: 250 },
  { type: 'tasks', label: '태스크', hint: '이 프로젝트의 할 일 — 보드는 크게 열어서', w: 310, h: 300 },
  { type: 'knowledge', label: '지식', hint: '필요·산출 지식 — 누르면 옆에서 펼쳐 읽어요', w: 310, h: 260 },
  { type: 'folder', label: '공유 폴더', hint: '프로젝트 파일 — 누르면 미리보기', w: 340, h: 300 },
  { type: 'desc', label: '명세(본문)', hint: '프로젝트 본문 — 필요할 때만 꺼내 보는 문서', w: 430, h: 340 },
  { type: 'timeline', label: '타임라인', hint: '이 프로젝트에서 일어난 일 — 판 위에도 놓을 수 있어요', w: 340, h: 420 },
  { type: 'sticky', label: '포스트잇', hint: '판에 붙이는 메모 — 결정·방향을 그 자리에', w: 230, h: 170 },
  { type: 'app-meeting', label: '회의록', hint: '껍데기 — 회의록을 넣으면 결정·태스크를 뽑는 앱 자리', w: 330, h: 260, shell: true },
  { type: 'app-calendar', label: '캘린더', hint: '껍데기 — 태스크 마감·세션 예약이 놓일 앱 자리', w: 330, h: 280, shell: true },
  { type: 'app-slides', label: '장표', hint: '껍데기 — 지식으로 보고용 장표를 만드는 앱 자리', w: 330, h: 250, shell: true },
];
const wdef = (t: WType): WDef => WDEFS.find((d) => d.type === t)!;

const GRID = 8;
const snap = (n: number): number => Math.max(0, Math.round(n / GRID) * GRID);
const LS_KEY = (id: number): string => 'lively_studio_' + id;

export function mountStudio(host: HTMLElement, opts: StudioOpts): StudioHandle {
  const id = opts.id;
  let detail: any = opts.detail;
  let dead = false;
  let chat: ProjectChatHandle | null = null;
  let zTop = 10;
  let liveTimer: number | null = null;

  // ── 배치 상태 (이 브라우저에 기억 — 팀 공유는 P3) ──
  let widgets: WSpec[] = [];
  let seq = 1;
  const els = new Map<string, { root: HTMLElement; body: HTMLElement; title: HTMLElement }>();   // 제자리 갱신용(라이브 틱이 전체 재그림을 하지 않는다)
  function save(): void { try { localStorage.setItem(LS_KEY(id), JSON.stringify({ widgets, seq })); } catch (_) { /* noop */ } }
  function load(): boolean {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY(id)) || 'null');
      if (s && Array.isArray(s.widgets)) { widgets = s.widgets; seq = Number(s.seq) || widgets.length + 1; return true; }
    } catch (_) { /* noop */ }
    return false;
  }

  // ── 골격 ──
  const door = el('header', { class: 'stu-door' });
  const canvas = el('div', { class: 'stu-canvas' });
  const board = el('div', { class: 'stu-board' }, canvas);
  const chatHost = el('div', { class: 'stu-chat' });
  const wrap = el('div', { class: 'stu-wrap' }, door, board) as HTMLElement;
  wrap.append(makeSplitter({ axis: 'y', key: 'stu-chat-h', cssVar: '--stu-chat-h', target: wrap, def: 260, min: 150, max: 560, grow: -1, label: '판·대화 경계' }), chatHost);
  host.replaceChildren(wrap);

  const pj = (): any => (detail && detail.project) || { id, name: '프로젝트 #' + id };
  const mySessions = (): Sess[] => opts.data().sessions.filter((s) => Number(s.projectId) === id);

  // ── 문패 — 이름이 주인공(원준: "제목 박스는 가장 눈에 들어오게") ──
  function paintDoor(): void {
    const p = pj();
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const doneN = tasks.filter((t) => t.status_category === 'done').length;
    const kn = p.knowledge || {};
    const knN = ((kn.required || []).length + (kn.produced || []).length) || 0;
    const ss = mySessions();
    const live = ss.filter((s) => s.live && s.alive);
    const members: any[] = Array.isArray(p.members) ? p.members : [];
    const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
    door.replaceChildren(
      el('div', { class: 'stu-door-l' },
        el('div', { class: 'stu-eyebrow' },
          el('span', { class: 'mono', text: '#' + p.id }), el('span', { class: 'sep', text: '·' }),
          el('span', { class: 'stu-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `세션 ${ss.length}` + (live.length ? ` (지금 ${live.length})` : '') }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), el('span', { class: 'sep', text: '·' }),
          el('span', { text: `지식 ${knN}` })),
        el('h1', { class: 'stu-title', text: p.name || '프로젝트 #' + id })),
      el('div', { class: 'stu-door-r' },
        el('span', { class: 'stu-faces' }, ...members.slice(0, 5).map((m: any) => personFace(String(m.member_id || m), 'stu-face', String(m.display_name || m.member_id || '')))),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '명세', title: '프로젝트 본문을 판에 꺼냅니다', onclick: () => addOrFocus('desc') }),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2/p/' + id, text: '보드(클래식)', title: '태스크 보드·표·타임라인은 클래식 앱에서' }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '정리', title: '위젯을 자동으로 다시 배치합니다', onclick: () => { autoArrange(); paintAll(); save(); } })));
  }

  // ── 위젯 공통 틀 ──
  function addWidget(type: WType, at?: { x: number; y: number }, data?: any, opts2?: { noSave?: boolean }): WSpec {
    const d = wdef(type);
    const spec: WSpec = { id: 'w' + seq++, type, x: at ? snap(at.x) : 24 + ((seq * 40) % 240), y: at ? snap(at.y) : 24 + ((seq * 32) % 180), w: d.w, h: d.h, data: data || {} };
    widgets.push(spec);
    if (!opts2?.noSave) { save(); paintAll(); }
    return spec;
  }
  function addOrFocus(type: WType): void {
    const hit = widgets.find((w) => w.type === type);
    if (hit) { hit.min = false; bump(hit); paintAll(); save(); return; }
    addWidget(type, { x: 60, y: 40 });
  }
  function bump(spec: WSpec): void { (spec as any).z = ++zTop; }
  function removeWidget(spec: WSpec): void { widgets = widgets.filter((w) => w !== spec); save(); paintAll(); }

  function widgetEl(spec: WSpec): HTMLElement {
    const d = wdef(spec.type);
    const body = el('div', { class: 'stu-w-body' });
    const title = spec.type === 'session' ? sessionTitle(spec) : (spec.type === 'sticky' ? '포스트잇' : d.label);
    const isBig = !!spec.big;
    const head = el('div', { class: 'stu-w-head' },
      el('b', { class: 'stu-w-t', text: title }),
      d.shell ? el('span', { class: 'stu-shell-badge', text: '껍데기' }) : null,
      el('span', { class: 'stu-w-acts' },
        el('button', { class: 'stu-w-btn', type: 'button', title: spec.min ? '펼치기' : '접기', text: spec.min ? '▸' : '▾', onclick: (e: Event) => { e.stopPropagation(); spec.min = !spec.min; save(); paintAll(); } }),
        spec.type === 'session' && spec.data?.sid
          ? el('button', { class: 'stu-w-btn', type: 'button', title: '전체 화면(대화창)', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); location.hash = '#/s/' + encodeURIComponent(String(spec.data.sid)); } })
          : el('button', { class: 'stu-w-btn', type: 'button', title: isBig ? '원래 크기' : '크게', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); toggleBig(spec); } }),
        el('button', { class: 'stu-w-btn', type: 'button', title: '닫기(판에서 치우기 — 데이터는 안 지워져요)', text: '×', onclick: (e: Event) => { e.stopPropagation(); removeWidget(spec); } })));
    const w = el('div', { class: 'stu-w stu-w-' + spec.type + (spec.min ? ' min' : '') + (spec.type === 'sticky' ? ' sticky' : ''), style: `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;${spec.min ? '' : 'height:' + spec.h + 'px;'}z-index:${(spec as any).z || 1}` }, head, body,
      el('div', { class: 'stu-w-rsz', title: '크기 조절' }));
    els.set(spec.id, { root: w, body, title: head.querySelector('.stu-w-t') as HTMLElement });
    if (!spec.min) fillBody(spec, body);
    wireDrag(spec, w, head);
    wireResize(spec, w);
    w.addEventListener('mousedown', () => { bump(spec); w.style.zIndex = String((spec as any).z); });
    return w;
  }
  function toggleBig(spec: WSpec): void {
    const d = wdef(spec.type);
    if (spec.big) { spec.w = d.w; spec.h = d.h; spec.big = false; }
    else { spec.w = 760; spec.h = 540; spec.big = true; }
    save(); paintAll();
  }

  // 드래그 — 머리를 잡고 끈다(스냅 8px). 버튼·입력은 예외.
  function wireDrag(spec: WSpec, w: HTMLElement, head: HTMLElement): void {
    head.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, input, textarea, a, select')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = spec.x, oy = spec.y;
      const move = (ev: MouseEvent): void => {
        spec.x = snap(ox + ev.clientX - sx); spec.y = snap(oy + ev.clientY - sy);
        w.style.left = spec.x + 'px'; w.style.top = spec.y + 'px';
      };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); growCanvas(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function wireResize(spec: WSpec, w: HTMLElement): void {
    const h = w.querySelector('.stu-w-rsz') as HTMLElement;
    h.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = spec.w, oh = spec.h;
      const move = (ev: MouseEvent): void => {
        spec.w = Math.max(200, snap(ow + ev.clientX - sx)); spec.h = Math.max(120, snap(oh + ev.clientY - sy));
        w.style.width = spec.w + 'px'; if (!spec.min) w.style.height = spec.h + 'px';
      };
      const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); spec.big = false; save(); paintAll(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  function growCanvas(): void {
    const mx = Math.max(1600, ...widgets.map((s) => s.x + s.w + 80));
    const my = Math.max(1000, ...widgets.map((s) => s.y + (s.min ? 40 : s.h) + 120));
    canvas.style.width = mx + 'px'; canvas.style.height = my + 'px';
  }

  // ── 위젯 본문들 ──
  function fillBody(spec: WSpec, body: HTMLElement): void {
    const t = spec.type;
    if (t === 'session') fillSession(spec, body);
    else if (t === 'tasks') fillTasks(body);
    else if (t === 'knowledge') fillKnowledge(body);
    else if (t === 'folder') void fillFolder(body);
    else if (t === 'desc') fillDesc(body);
    else if (t === 'timeline') fillTimeline(body);
    else if (t === 'sticky') fillSticky(spec, body);
    else if (t === 'coach') fillCoach(body);
    else if (t === 'app-meeting') fillMeeting(body);
    else if (t === 'app-calendar') fillCalendar(body);
    else if (t === 'app-slides') fillSlides(body);
  }

  // 세션 위젯 — 살아 있는 카드(B의 감각). 읽기는 전체 화면, 여기선 상태·마지막 일·던지기·승인.
  function sessionTitle(spec: WSpec): string {
    const s = spec.data?.sid ? mySessions().find((x) => x.id === spec.data.sid) : null;
    if (!s) return 'AI 세션 — 고르세요';
    const t = sessText(s, pj().name || '');   // 프로젝트명 되풀이를 걷어낸다(사이드바와 같은 규칙)
    return t.main || s.label || 'AI 세션';
  }
  function fillSession(spec: WSpec, body: HTMLElement): void {
    const sid = spec.data?.sid ? String(spec.data.sid) : '';
    const s = sid ? mySessions().find((x) => x.id === sid) : null;
    if (!s) {
      const list = mySessions();
      body.replaceChildren(
        el('p', { class: 'stu-fine', text: list.length ? '이 판에 올릴 세션을 고르세요.' : '이 프로젝트에 세션이 아직 없어요 — 아래 대화나 [+ 새 세션]으로 시작하세요.' }),
        el('div', { class: 'stu-pick' }, ...list.slice(0, 8).map((x) => el('button', {
          class: 'stu-pick-row', type: 'button', onclick: () => { spec.data = { sid: x.id }; save(); paintAll(); } },
          el('span', { class: 'v2-dot ' + dotCls(x.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'n', text: x.label || x.id }), el('span', { class: 'm', text: x.stateLabel })))));
      return;
    }
    const raw = s.raw || {};
    const work = String(raw.title || '').trim();
    const waiting = s.stateKey === 'waiting';
    const lastEl = el('div', { class: 'stu-sess-last', text: work && work.toLowerCase() !== String(raw.harness || '').toLowerCase() ? work : (s.stateLabel + (s.lastSeen ? ' · ' + relTime(new Date(s.lastSeen).toISOString()) : '')) });
    const input = el('input', { class: 'stu-sess-in', type: 'text', placeholder: '이 세션에 시키기 — Enter', 'aria-label': '세션에 보낼 지시' }) as HTMLInputElement;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) })
        .then(() => { input.value = ''; toast('보냈어요 — 진행은 카드와 타임라인에 나타납니다.'); })
        .catch((err: any) => toast('보내지 못했어요 — ' + (err?.message || err), true))
        .finally(() => { input.disabled = false; });
    });
    const key = (action: string, label: string, primary?: boolean): HTMLElement =>
      el('button', { class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text: label, onclick: () => {
        void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/keys', { method: 'POST', body: JSON.stringify({ action }) })
          .then(() => toast(label + ' — 보냈어요.')).catch((err: any) => toast('실패 — ' + (err?.message || err), true));
      } });
    body.replaceChildren(
      el('div', { class: 'stu-sess-st' },
        el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }),
        el('span', { text: s.stateLabel }),
        el('span', { class: 'stu-fine', text: raw.harness ? String(raw.harness) : '' }),
        el('a', { class: 'stu-fine stu-open', href: '#/s/' + encodeURIComponent(s.id), text: '대화 열기 →' })),
      lastEl,
      ...(waiting ? [el('div', { class: 'stu-sess-keys' }, key('approve', '승인', true), key('deny', '거부'), key('interrupt', '멈춤'))] : []),
      input);
  }

  // 태스크 위젯 — 미니 목록(보드는 클래식 앱이 담당 — 칸반과 판을 합치지 않는다).
  function fillTasks(body: HTMLElement): void {
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const row = (tk: any): HTMLElement => el('a', { class: 'stu-row', href: '#/projects2/t/' + tk.id, title: tk.name },
      el('span', { class: 'v2-dot ' + (tk.status_category === 'done' ? 'done' : tk.status_category === 'started' ? 'busy' : ''), 'aria-hidden': 'true' }),
      el('span', { class: 'n', text: tk.name }), el('span', { class: 'm', text: tk.status || '' }));
    const open = tasks.filter((tk) => tk.status_category !== 'done');
    body.replaceChildren(
      open.length ? el('div', { class: 'stu-rows' }, ...open.slice(0, 12).map(row)) : el('p', { class: 'stu-fine', text: '남은 할 일이 없어요.' }),
      el('div', { class: 'stu-w-foot' },
        el('span', { class: 'stu-fine', text: `남음 ${open.length} · 전체 ${tasks.length}` }),
        el('button', { class: 'btn-text', type: 'button', text: '리브에게 나누기', onclick: () => chat?.say('이 프로젝트를 태스크로 나눠 줘. 만들기 전에 목록을 먼저 보여 줘.') })));
  }

  // 지식 위젯 — 누르면 오른쪽에서 펼쳐 읽는다(3열 확장 패턴 재사용).
  function fillKnowledge(body: HTMLElement): void {
    const kn = pj().knowledge || {};
    const rows: HTMLElement[] = [];
    for (const [rel, list] of [['필요', kn.required || []], ['산출', kn.produced || []]] as Array<[string, any[]]>) {
      for (const k of list) rows.push(el('button', { class: 'stu-row', type: 'button', title: k.name, onclick: () => openPeek('#/k/' + encodeURIComponent(k.name), k.name) },
        el('span', { class: 'stu-kn-rel' + (rel === '산출' ? ' prod' : ''), text: rel }), el('span', { class: 'n', text: k.name })));
    }
    body.replaceChildren(rows.length ? el('div', { class: 'stu-rows' }, ...rows.slice(0, 14)) : el('p', { class: 'stu-fine', text: '연결된 지식이 아직 없어요 — 세션이 남기면 여기에 쌓입니다.' }));
  }

  // 공유 폴더 위젯 — 파일 목록 + 클릭 미리보기(기존 뷰어 재사용).
  async function fillFolder(body: HTMLElement): Promise<void> {
    body.replaceChildren(el('p', { class: 'stu-fine', text: '불러오는 중…' }));
    let data: any = null;
    try { data = await api('/api/ui/projects/' + id + '/files?path='); } catch (e: any) { body.replaceChildren(el('p', { class: 'stu-fine', text: '폴더를 불러오지 못했어요 — ' + (e?.message || e) })); return; }
    if (dead) return;
    const items: any[] = (data && data.items) || [];
    const row = (it: any): HTMLElement => el('button', { class: 'stu-row', type: 'button', title: it.name, onclick: () => {
      if (it.type === 'dir') { openPeek('#/f?root=shared&path=' + encodeURIComponent('project/' + id + '/' + it.name), it.name); return; }
      void openFileViewer(id, it.name, it.name, () => { /* 목록 재조회 불요 */ }, '/api/ui/projects/');
    } }, fileIconSvg(it.name, it.type), el('span', { class: 'n', text: it.name }), el('span', { class: 'm', text: it.type === 'dir' ? '폴더' : fmtSize(it.size || 0) }));
    body.replaceChildren(items.length ? el('div', { class: 'stu-rows' }, ...items.slice(0, 16).map(row)) : el('p', { class: 'stu-fine', text: '아직 파일이 없어요 — 세션 작업물이 여기 쌓입니다.' }));
  }

  // 명세(본문) 위젯 — "본문이 계속 눈에 보일 필요는 없다"(원준) → 상시 노출 대신 꺼내 보는 문서.
  function fillDesc(body: HTMLElement): void {
    const md = String(pj().description || '').trim();
    body.replaceChildren(
      md ? el('div', { class: 'stu-md' }, renderMarkdown(md)) : el('p', { class: 'stu-fine', text: '본문이 아직 없어요.' }),
      el('div', { class: 'stu-w-foot' }, el('button', { class: 'btn-text', type: 'button', text: '리브에게 정돈 맡기기', onclick: () => chat?.say('본문을 정돈된 형식으로 다시 써 줘. 원문의 사실·결정·링크는 하나도 잃지 말고, 산만한 문장만 정리해.') })));
  }

  function fillTimeline(body: HTMLElement): void {
    const tl = createTimeline(body, { scope: '프로젝트 #' + id, showActors: true, empty: '아직 이 프로젝트에서 일어난 일이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }

  function fillSticky(spec: WSpec, body: HTMLElement): void {
    const ta = el('textarea', { class: 'stu-sticky-ta', placeholder: '메모 — 이 판을 보는 팀원에게 남길 말', 'aria-label': '포스트잇 메모' }) as HTMLTextAreaElement;
    ta.value = String(spec.data?.text || '');
    ta.addEventListener('input', () => { spec.data = { ...(spec.data || {}), text: ta.value }; save(); });
    body.replaceChildren(ta, el('div', { class: 'stu-fine stu-sticky-note', text: '지금은 이 브라우저에만 저장돼요 — 팀 공유는 다음 단계.' }));
  }

  // 리브 제안 — "사람은 자기 워크플로우의 한계로 AI 를 작게 쓴다 → 리브가 계속 더 큰 쓰임을 제안한다"(원준 문제의식).
  //  제안 = 데이터에서 계산한 것 + 워크플로우 확장 제안(예시). [리브에게] = 아래 리브 대화로 실제 전송.
  function fillCoach(body: HTMLElement): void {
    const ss = mySessions();
    const waiting = ss.filter((s) => s.stateKey === 'waiting');
    const idle = ss.filter((s) => s.live && s.alive && s.stateKey === 'idle');
    const tasks: any[] = Array.isArray(pj().tasks) ? pj().tasks : [];
    const noMeta = tasks.filter((tk) => tk.status_category !== 'done' && !tk.due_date && !(tk.assignees && tk.assignees.length)).length;
    const rows: Array<[string, string]> = [];
    if (waiting.length) rows.push([`세션 ${waiting.length}개가 답을 기다려요 — 물음을 모아 보여 드릴까요?`, '지금 답을 기다리는 세션들의 질문을 모아서 요약해 줘. 내가 한 번에 결정할 수 있게.']);
    if (idle.length >= 2) rows.push([`조용한 세션 ${idle.length}개 — 남긴 것을 지식으로 정리하고 닫을 수 있어요.`, '이 프로젝트의 조용한 세션들이 남긴 결과를 지식으로 정리하고, 닫아도 되는 세션을 알려 줘.']);
    if (noMeta >= 3) rows.push([`담당·마감 없는 할 일이 ${noMeta}개 — 정리하면 병렬로 시킬 수 있어요.`, '상태·마감·담당·우선순위를 점검하고, 비어 있거나 어긋난 게 있으면 정리해 줘.']);
    rows.push(['이 작업, 세션 여러 개로 나눠 병렬로 돌릴 수 있어요 — 나누는 안을 받아 보세요.', '지금 진행 중인 작업을 병렬 세션 2~3개로 나누는 안을 제안해 줘. 각 세션에 줄 첫 지시까지 써 줘.']);
    rows.push(['반복 확인(화면 검증·회귀 체크)은 상시 세션에 맡길 수 있어요.', '이 프로젝트에서 반복되는 확인 작업을 찾아서, 상시 세션 하나에 맡기는 흐름을 제안해 줘.']);
    body.replaceChildren(
      el('div', { class: 'stu-coach-rows' }, ...rows.slice(0, 4).map(([txt, say]) => el('div', { class: 'stu-coach-row' },
        el('span', { class: 'n', text: txt }),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '리브에게', onclick: () => { chat?.say(say); chat?.focus(); } })))),
      el('p', { class: 'stu-fine', text: '제안은 판의 상태에서 계산돼요 — 누르면 아래 리브 대화로 들어갑니다.' }));
  }

  // ── 앱 껍데기 셋 — "무엇이 들어올 자리인지"를 말하고, 지금 되는 것(리브)으로 연결한다 ──
  function shellRow(txt: string, say: string): HTMLElement {
    return el('div', { class: 'stu-coach-row' }, el('span', { class: 'n', text: txt }),
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '리브에게', onclick: () => { chat?.say(say); chat?.focus(); } }));
  }
  function fillMeeting(body: HTMLElement): void {
    body.replaceChildren(
      el('p', { class: 'stu-shell-p', text: '회의록 앱 자리 — 회의록(텍스트·녹취)을 넣으면 결정·태스크·미결이 추출되어 이 프로젝트에 연결됩니다.' }),
      el('div', { class: 'stu-coach-rows' },
        shellRow('회의록을 공유 폴더에 올리고 추출을 맡겨 보세요.', '공유 폴더의 회의록 파일을 찾아 결정·태스크·미결 항목을 추출하고, 태스크로 만들지 목록을 먼저 보여 줘.'),
        shellRow('회의마다 자동으로 하게 만들 수도 있어요.', '회의록이 올라오면 자동으로 결정·태스크를 추출하는 흐름을 어떻게 만들 수 있는지 제안해 줘.')));
  }
  function fillCalendar(body: HTMLElement): void {
    const tasks: any[] = (Array.isArray(pj().tasks) ? pj().tasks : []).filter((tk: any) => tk.due_date && tk.status_category !== 'done');
    body.replaceChildren(
      el('p', { class: 'stu-shell-p', text: '캘린더 앱 자리 — 태스크 마감·회의·세션 예약(정기 실행)이 한 달력에 놓입니다.' }),
      tasks.length ? el('div', { class: 'stu-rows' }, ...tasks.slice(0, 6).map((tk: any) => el('a', { class: 'stu-row', href: '#/projects2/t/' + tk.id },
        el('span', { class: 'm mono', text: String(tk.due_date).slice(5, 10) }), el('span', { class: 'n', text: tk.name })))) : el('p', { class: 'stu-fine', text: '마감이 있는 할 일이 아직 없어요.' }),
      el('div', { class: 'stu-coach-rows' }, shellRow('마감 점검을 리브에게.', '마감이 지난·임박한 태스크를 점검하고 조정안을 제안해 줘.')));
  }
  function fillSlides(body: HTMLElement): void {
    body.replaceChildren(
      el('p', { class: 'stu-shell-p', text: '장표 앱 자리 — 이 프로젝트의 지식·산출물로 보고용 장표(HTML)를 만들어 판에 놓습니다.' }),
      el('div', { class: 'stu-coach-rows' },
        shellRow('산출지식으로 장표 초안 만들기.', '이 프로젝트의 산출지식을 바탕으로 보고용 장표(HTML) 초안을 만들어 줘. 목차부터 먼저 보여 줘.')));
  }

  // ── 오른쪽에서 펼쳐 읽기(피크) — 타임라인 펼쳐보기(#1756 계열)와 같은 문법 ──
  let peekEl: HTMLElement | null = null;
  function closePeek(): void { if (peekEl) { peekEl.remove(); peekEl = null; document.removeEventListener('keydown', peekEsc, true); } }
  function peekEsc(e: KeyboardEvent): void { if (e.key === 'Escape') { e.stopPropagation(); closePeek(); } }
  function openPeek(hash: string, title: string): void {
    closePeek();
    const url = location.pathname + '?embed=1' + hash;
    const pe = el('div', { class: 'stu-peek' },
      el('div', { class: 'stu-peek-h' }, el('b', { text: title }),
        el('span', { class: 'stu-w-acts' },
          el('a', { class: 'btn-text', href: hash, target: '_blank', rel: 'noopener', text: '새 탭 ↗' }),
          el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '닫기(Esc)', onclick: closePeek }))),
      el('iframe', { class: 'stu-peek-f', src: url, title }));
    peekEl = pe;
    wrap.append(pe);
    document.addEventListener('keydown', peekEsc, true);
  }

  // ── 바닥 — 리브 대화(실동작). 위젯의 [리브에게]가 전부 여기로 흘러든다 ──
  function mountChat(): void {
    const barR = el('span', { class: 'stu-chat-r' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 새 세션', title: '이 프로젝트에 붙은 새 AI 세션을 열고, 판에 카드로 올립니다', onclick: () => void spawnSession() }));
    chat = mountProjectChat(chatHost, {
      projectId: id,
      bar: { right: barR },
      onTurnDone: () => { void refreshDetail(); opts.onProjectChanged?.(); },
    });
  }
  async function spawnSession(): Promise<void> {
    const p = runPrefs();
    try {
      const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
        label: (pj().name || '새 세션').slice(0, 28), harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
        flags: p.flags && typeof p.flags === 'object' ? p.flags : {}, autoApprove: !!p.autoApprove, sessionDir: true }) });
      const sid = out?.session?.id ? String(out.session.id) : '';
      if (!sid) throw new Error('세션 id 를 받지 못했습니다');
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/project', { method: 'POST', body: JSON.stringify({ projectId: id }) }); } catch (_) { /* 위젯에서 재연결 가능 */ }
      addWidget('session', { x: 60, y: 60 }, { sid });
      toast('세션을 열고 판에 올렸어요.');
    } catch (e: any) { toast('세션을 열지 못했어요 — ' + (e?.message || e), true); }
  }

  async function refreshDetail(): Promise<void> {
    try { const d = await api('/api/ui/v6/projects/' + id); if (!dead && d) { detail = d; paintDoor(); paintAll(); } } catch (_) { /* noop */ }
  }

  // ── 판 그리기 ──
  function paintAll(): void {
    if (dead) return;
    els.clear();
    canvas.replaceChildren(...widgets.map(widgetEl),
      el('div', { class: 'stu-boardhint', text: '오른쪽 선반에서 끌어다 놓거나 눌러서 위젯을 놓아요 · 머리를 끌면 이동 · 모서리로 크기' }));
    growCanvas();
  }

  // 기본 배치 — 처음 열면 자동으로(자유 배치의 '정리 비용'을 기본값이 흡수한다).
  //  1열 리브 제안+첫 세션 · 2열 나머지 세션 · 3열 태스크·지식. 이후엔 사람이 끈 자리가 진실.
  function autoArrange(): void {
    widgets = [];
    seq = 1;
    addWidget('coach', { x: 24, y: 16 }, {}, { noSave: true });
    const live = mySessions().filter((s) => s.live && s.alive).slice(0, 3);
    live.forEach((s, i) => {
      const at = i === 0 ? { x: 24, y: 290 } : { x: 424, y: 16 + (i - 1) * (wdef('session').h + 24) };
      addWidget('session', at, { sid: s.id }, { noSave: true });
    });
    addWidget('tasks', { x: 768, y: 16 }, {}, { noSave: true });
    addWidget('knowledge', { x: 768, y: 344 }, {}, { noSave: true });
  }

  // ── 우패널: 위젯 선반 + 타임라인 ──
  function renderAside(aside: HTMLElement): void {
    aside.replaceChildren();
    const shelf = el('div', { class: 'stu-shelf' },
      el('div', { class: 'stu-shelf-h', text: '위젯 · 앱 — 판으로 끌어다 놓기' }),
      el('div', { class: 'stu-shelf-grid' }, ...WDEFS.map((d) => {
        const card = el('button', { class: 'stu-shelf-card', type: 'button', title: d.hint + (d.shell ? ' (껍데기)' : ''), draggable: 'true', onclick: () => addWidget(d.type, undefined) },
          el('b', { text: d.label }), d.shell ? el('span', { class: 'stu-shell-badge', text: '껍' }) : null);
        card.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', 'stu:' + d.type); });
        return card;
      })));
    aside.append(shelf);
    const tl = createTimeline(aside, { scope: '프로젝트 #' + id, showActors: true, empty: '아직 이 프로젝트에서 일어난 일이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }

  // 판에 드롭 받기
  board.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
  board.addEventListener('drop', (e: DragEvent) => {
    const t = e.dataTransfer?.getData('text/plain') || '';
    if (!t.startsWith('stu:')) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    addWidget(t.slice(4) as WType, { x: e.clientX - r.left - 40, y: e.clientY - r.top - 16 });
  });

  // ── 라이브 갱신 — 세션 카드의 상태·지금 하는 일(8초). main 의 20초 목록과 별개로 가볍게 ──
  function armLive(): void {
    liveTimer = window.setInterval(() => {
      if (dead || document.hidden) return;
      paintDoor();
      const focused = document.activeElement as HTMLElement | null;
      for (const spec of widgets) {
        if (spec.min || (spec.type !== 'session' && spec.type !== 'coach')) continue;
        const ref = els.get(spec.id);
        if (!ref || !ref.root.isConnected) continue;
        if (focused && ref.root.contains(focused)) continue;   // 입력·선택 중 — 손대지 않는다
        fillBody(spec, ref.body);
        if (spec.type === 'session') ref.title.textContent = sessionTitle(spec);
      }
    }, 8000);
  }

  // ── 시작 ──
  if (!load()) autoArrange();
  paintDoor();
  paintAll();
  mountChat();
  armLive();
  if (!detail) void refreshDetail();

  return {
    destroy() { dead = true; if (liveTimer) clearInterval(liveTimer); chat?.destroy(); chat = null; closePeek(); },
    renderAside,
  };
}
