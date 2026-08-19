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
//
//  v4 = 바탕화면(2026-08-19, "맥OS·바탕화면·캔버스·피그마의 그림"):
//   · **우측 사이드바를 버린다** — 판이 폭 전체를 쓴다. 타임라인은 상주 열이 아니라 **알림 센터**(문패 [타임라인] → 우측 위 카드,
//     밖 클릭·Esc 로 물러남 · [판에 고정]으로 위젯이 된다), 위젯·앱 선반은 **런치패드**(도크의 ⊞) 로 옮긴다.
//   · 판 = 바탕화면: 우측 위에 **바로가기 아이콘**(공유 폴더 항목·지식) — 한 번 = 선택, 두 번 = 열기(폴더·문서 = 피크 창,
//     이미지·PDF = 판 위 프리뷰 창), 끌어다 놓으면 그 자리에 창. **컴퓨터의 파일·폴더를 끌어다 놓으면** 공유 폴더로 올라가고
//     이미지는 그 자리에 바로 뜬다(드롭 대상은 판 전체가 빛난다).
//   · 하단 = **도크**: [리브] [명령 입력] [+새 세션] [⊞ 런치패드]. 명령을 치는 동안 행선지에 따라 **세션 창이 미리 나타난다**
//     ('짠') — 새 일이면 도크 위에 유령 창(첫 프롬프트 미리보기)이 떠오르고, 보내면 그 자리에서 진짜 세션 카드가 된다.
//     기존 세션이면 그 카드가 조준된다(테두리), 리브면 리브 단추가 조준된다.
import { api, apiUrl, TOKEN_KEY, el, personFace, relTime, renderMarkdown, sv, toast } from '../core.js';
import { mountProjectChat, type ProjectChatHandle } from '../project-chat.js';
import { createTimeline } from '../timeline.js';
import { loadProjectTimeline } from '../timeline-sources.js';
import { fmtSize, openFileViewer } from '../projects/files.js';
import { upDropZone, upSend, upToast, type UpItem } from '../projects/files-upload.js';
import { runPrefs } from './run-picker.js';
import { listSessionApps, spawnAppSession, type SessionApp } from './app-session.js';
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
  grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v6M14 11v6"/>',
  drop: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
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
// surf = 이 기능이 사는 **표면**(원준 2026-08-19 "앱은 모달, 위젯은 캔버스를 꾸미는 것"):
//  app = 열어서 하는 일(검색·편집·설정 — 모달) · widget = 캔버스에 두는 것(곁눈질) · both = 둘 다(같은 재료, 다른 성격).
interface WDef { type: WType; label: string; hint: string; w: number; h: number; ic: string; ac: string; surf: 'app' | 'widget' | 'both'; shell?: boolean; hidden?: boolean }
const WDEFS: WDef[] = [
  { type: 'session', label: 'AI 세션', hint: '세션 하나 — 크기를 키우면 대화가 통째로 보여요', w: 340, h: 300, ic: 'chat', ac: '#2D6BF0', surf: 'widget' },
  { type: 'coach', label: '리브 제안', hint: '판을 읽고 AI 를 더 크게 쓰는 법을 제안', w: 340, h: 250, ic: 'spark', ac: '#0FA37E', surf: 'widget' },
  { type: 'automation', label: '자동화', hint: '반복을 붙박이로 — 켤 수 있는 자동화', w: 340, h: 250, ic: 'bolt', ac: '#7C5CFC', surf: 'both' },
  { type: 'tasks', label: '태스크', hint: 'S=진행 링 · M=할 일 목록 · L=마감까지', w: 320, h: 300, ic: 'task', ac: '#D9772B', surf: 'both' },
  { type: 'knowledge', label: '지식', hint: 'M=문서 목록 · L=본문 미리보기 카드', w: 320, h: 280, ic: 'book', ac: '#1BAEB0', surf: 'both' },
  { type: 'folder', label: '공유 폴더', hint: '내가 올린 자료 · 세션이 남긴 결과물 — 끌어다 놓으면 올라가요', w: 380, h: 320, ic: 'folder', ac: '#5A6B85', surf: 'both' },
  { type: 'desc', label: '명세', hint: '프로젝트 본문 — 꺼내 읽는 문서', w: 440, h: 360, ic: 'doc', ac: '#8A99B5', surf: 'app' },
  { type: 'timeline', label: '타임라인', hint: '남은 결과들', w: 340, h: 420, ic: 'clock', ac: '#15233B', surf: 'both' },
  { type: 'sticky', label: '포스트잇', hint: '판에 붙이는 메모', w: 230, h: 170, ic: 'note', ac: '#D9A32B', surf: 'widget' },
  { type: 'app-meeting', label: '회의록', hint: '껍데기 — 회의록→결정·태스크 추출 자리', w: 340, h: 250, ic: 'mic', ac: '#B84E9C', surf: 'app', shell: true },
  { type: 'app-calendar', label: '캘린더', hint: '껍데기 — 마감·회의·세션 예약 자리', w: 340, h: 280, ic: 'cal', ac: '#D9772B', surf: 'app', shell: true },
  { type: 'app-slides', label: '장표', hint: '껍데기 — 지식→보고 장표 자리', w: 340, h: 240, ic: 'deck', ac: '#2D6BF0', surf: 'app', shell: true },
  { type: 'preview', label: '프리뷰', hint: '파일 미리보기', w: 360, h: 320, ic: 'img', ac: '#5A6B85', surf: 'widget', hidden: true },
  { type: 'doc', label: '문서', hint: '지식·문서 임베드', w: 460, h: 420, ic: 'doc', ac: '#1BAEB0', surf: 'widget', hidden: true },
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
  // id 0 = **프로젝트 없는 세션들의 작업대**(사이드바 그 폴더의 목적지, 원준 2026-08-19).
  //  프로젝트가 없으니 공유 폴더·태스크·지식·프로젝트 리브가 없다 — 있는 건 '자투리 세션들'뿐이고,
  //  그것들이 카드로 모여 여기서 바로 말을 걸 수 있다(프로젝트로 옮기는 건 세션의 [프로젝트 연결]).
  const loose = id === 0;
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

  const pj = (): any => (loose ? { id: 0, name: '프로젝트 없는 세션' } : (detail && detail.project) || { id, name: '프로젝트 #' + id });
  const mySessions = (): Sess[] => opts.data().sessions.filter((s) => (loose ? !s.projectId : Number(s.projectId) === id));

  // ── 골격 ──
  const door = el('header', { class: 'stu-door' });
  const canvas = el('div', { class: 'stu-canvas' });
  const cmLayer = el('div', { class: 'stu-cmlayer', hidden: true });
  const board = el('div', { class: 'stu-board' }, canvas, cmLayer);
  // 스테이지(v4) — 스크롤하는 판(board) 위에 **스크롤하지 않는 것들**(바로가기·알림 센터·도크·런치패드·유령 창)을 얹는 층.
  const stage = el('div', { class: 'stu-stage' }, board);
  const wrap = el('div', { class: 'stu-wrap' }, door, stage) as HTMLElement;
  host.replaceChildren(wrap);

  const cmBtn = el('button', { class: 'btn btn-ghost btn-sm stu-cm-btn', type: 'button', title: '코멘트 모드 — 판 위를 드래그해 영역을 잡고 코멘트를 남깁니다', onclick: () => setCommentMode(!commentMode) }, icon('pin', 'stu-i sm'), el('span', { text: '코멘트' })) as HTMLButtonElement;
  // 타임라인은 위젯이 아니라 **우상단 토글**이다(원준 2026-08-19) — 맥 알림 센터 문법: 문패 오른쪽 끝에서
  //  누르면 오른쪽에서 스르륵 밀려 들어오고, 다시 누르면 밀려 나간다. 판 위 다른 위젯과 결이 다른 게 맞다 —
  //  이건 '판에 둔 물건'이 아니라 '잠깐 젖혀 보는 서랍'이라서다(그래서 판 배치에 저장되지 않는다).
  const tlBtn = el('button', { class: 'btn btn-ghost btn-sm stu-tl-btn', type: 'button', title: '타임라인 — 이 프로젝트에 남은 것들 (Esc 로 닫기)',
    'aria-label': '타임라인', 'aria-expanded': 'false', onclick: () => toggleNotif() },
    icon('clock', 'stu-i sm'), el('span', { text: '타임라인' })) as HTMLButtonElement;
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
          loose ? el('div', { class: 'stu-eyebrow' },
            el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: '아직 어느 프로젝트에도 붙지 않음' }))
          : el('div', { class: 'stu-eyebrow' },
            el('span', { class: 'mono', text: '#' + p.id }), el('span', { class: 'sep', text: '·' }),
            el('span', { class: 'stu-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), el('span', { class: 'sep', text: '·' }),
            el('span', { text: `지식 ${knN}` }))),
        el('h1', { class: 'stu-title', text: p.name || '프로젝트 #' + id })),
      el('div', { class: 'stu-door-r' },
        el('span', { class: 'stu-faces' }, ...members.slice(0, 5).map((m: any) => personFace(String(m.member_id || m), 'stu-face', String(m.display_name || m.member_id || '')))),
        // 이 줄은 **캔버스보다 위**에 있는 것들만 — 판 설정(코멘트 모드·정리)뿐이다(원준 2026-08-19).
        //  타임라인·명세는 기능이라 앱/위젯으로 내려갔다(⊞ 런치패드).
        tlBtn,
        cmBtn,
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '정리', title: '위젯 위치만 격자에 맞춰 정렬합니다(크기는 그대로)', onclick: () => { autoArrange(); paintAll(); save(); } })));
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
  function removeWidget(spec: WSpec): void {
    if (loose && spec.type === 'session' && spec.data?.sid) looseHide(String(spec.data.sid));   // 자투리 판: 치운 카드는 다시 안 올린다
    widgets = widgets.filter((w) => w !== spec); sigs.delete(spec.id); save(); paintAll();
  }

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
        focusPrev.has(spec.id)
          ? el('button', { class: 'stu-w-btn', type: 'button', title: '작게 — 원래 자리·크기로', text: '⤡', onclick: (e: Event) => { e.stopPropagation(); unfocusWidget(spec); } })
          : null,
        spec.type === 'session' && spec.data?.sid
          ? el('button', { class: 'stu-w-btn', type: 'button', title: '전체 화면(대화창)', text: '⤢', onclick: (e: Event) => { e.stopPropagation(); location.hash = '#/s/' + encodeURIComponent(String(spec.data.sid)); } })
          : null,
        el('button', { class: 'stu-w-btn', type: 'button', title: '판에서 치우기', text: '×', onclick: (e: Event) => { e.stopPropagation(); removeWidget(spec); } })));
    const w = el('div', { class: 'stu-w stu-w-' + spec.type + (spec.min ? ' min' : '') + (focusId === spec.id ? ' focused' : ''), 'data-sz': sizeOf(spec), style: `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;${spec.min ? '' : 'height:' + spec.h + 'px;'}z-index:${spec.z || 1};--wac:${d.ac}` }, head, body,
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

  // ══ 공유 폴더 = **내가 올린 자료함**(원준 2026-08-19 "claude.md 처럼 자세한 건 보여줄 필요 없고,
  //   내가 올린 파일을 담는 공유폴더의 느낌이 더 강했으면") ══════════════════════════
  //  판이 보는 것은 파일시스템이 아니라 **자료**다: 워크트리(.git 폴더)·기계 파일(CLAUDE.md·AGENTS.md)·
  //  캐시(__pycache__·node_modules·dist)는 애초에 목록에 없다. 원시 파일 브라우저는 발밑에 링크로만 남긴다.
  async function fillFolder(spec: WSpec, body: HTMLElement): Promise<void> {
    const sz2 = sizeOf(spec);
    body.replaceChildren(el('p', { class: 'stu-fine', text: '불러오는 중…' }));
    const files = await assetFiles();
    if (dead || !body.isConnected) return;
    const upIn = el('input', { type: 'file', multiple: 'true', hidden: true }) as HTMLInputElement;
    upIn.addEventListener('change', () => {
      const items: UpItem[] = Array.from(upIn.files || []).map((f) => ({ file: f, rel: f.name }));
      upIn.value = '';
      void uploadDropped(items, []).then(() => { sigs.delete(spec.id); fillBody(spec, body, true); });
    });
    const head = el('div', { class: 'stu-w-foot stu-asset-head' },
      el('span', { class: 'stu-fine', text: files.length ? files.length + '개 · 최근 먼저' : '' }),
      el('button', { class: 'btn-text', type: 'button', text: '＋ 올리기', title: '컴퓨터에서 파일 고르기 — 판에 끌어다 놓아도 올라가요', onclick: () => upIn.click() }));
    if (!files.length) {
      body.replaceChildren(upIn, el('div', { class: 'stu-asset-empty' },
        icon('drop', 'stu-i big'),
        el('b', { text: '아직 자료가 없어요' }),
        el('p', { class: 'stu-fine', text: '컴퓨터에서 파일을 판에 끌어다 놓거나 [＋ 올리기]를 누르세요. 세션이 만든 결과물도 여기 쌓입니다.' }),
        el('button', { class: 'btn-text', type: 'button', text: '＋ 올리기', onclick: () => upIn.click() })));
      return;
    }
    if (sz2 === 's') {
      const f = files[0];
      body.replaceChildren(upIn, el('div', { class: 'stu-kn-s' }, el('b', { text: String(files.length) }), el('span', { text: '자료' }), el('span', { class: 'stu-fine ell', text: '최근 — ' + base(f.path) })));
      return;
    }
    const row = (f: AssetFile): HTMLElement => {
      const k = kindOf(f.path);
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const thumb = k.kind === 'img' ? el('img', { alt: '', loading: 'lazy' }) as HTMLImageElement : null;
      if (thumb) fillImg(thumb, f.path);
      return el('div', { class: 'stu-asset' },
        el('button', { class: 'stu-asset-b', type: 'button', title: f.path + ' — 열기', onclick: () => openDeskItem({ kind: k.kind, path: f.path, label: base(f.path), type: k.type }) },
          el('span', { class: 'stu-asset-ic ' + k.kind }, thumb || icon(k.kind === 'page' ? 'deck' : 'doc', 'stu-i')),
          el('span', { class: 'stu-asset-t' },
            el('b', { text: base(f.path) }),
            el('span', { class: 'stu-asset-m' }, el('span', { text: k.type }), el('span', { class: 'sep', text: '·' }), el('span', { text: fmtSize(f.size || 0) }),
              dir ? el('span', { class: 'sep', text: '·' }) : null, dir ? el('span', { class: 'stu-asset-dir', text: dir }) : null))),
        el('button', { class: 'stu-w-btn stu-asset-x', type: 'button', text: '×', title: '휴지통으로', onclick: () => void trashItems([{ kind: k.kind, path: f.path, label: base(f.path), type: k.type }]).then(() => { sigs.delete(spec.id); fillBody(spec, body, true); }) }));
    };
    body.replaceChildren(upIn, head,
      el('div', { class: 'stu-scroll stu-assets' }, ...files.slice(0, sz2 === 'l' ? 60 : 20).map(row)),
      el('div', { class: 'stu-w-foot' }, el('button', { class: 'btn-text', type: 'button', text: '원본 폴더 열기 ↗', title: '폴더 구조 그대로 보는 파일 브라우저', onclick: () => openPeek('#/f?root=shared&path=' + encodeURIComponent('project/' + id), '공유 폴더 — 원본') })));
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
    const url = apiUrl('/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent(path));
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
      const im = el('img', { class: 'stu-prev-img', alt: path, loading: 'lazy' }) as HTMLImageElement;
      fillImg(im, path);   // 헤더 인증(쿠키 없는 세션에서도 뜨게)
      body.replaceChildren(el('div', { class: 'stu-prevwrap' }, im));
    }
    else body.replaceChildren(el('iframe', { class: 'stu-prev-f', src: /\.pdf$/i.test(path) ? url + '#toolbar=0&view=FitH' : url, title: path }));
    body.append(el('div', { class: 'stu-w-foot' }, el('span', { class: 'stu-fine ell', text: path }),
      el('button', { class: 'btn-text', type: 'button', text: '크게', onclick: () => void openFileViewer(id, path, path, () => { /* noop */ }, '/api/ui/v6/projects/') })));
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
    // 닫는 길을 **셋** 둔다(원준 2026-08-19 "켠 걸 어떻게 없애는지 직관적이어야"): ① 머리의 [닫기] 단추(항상 보임 —
    //  종전엔 .stu-w-acts 를 빌려 써서 opacity:0 인 채였다: 실제로 화면에 없던 버튼) ② 판 아무 데나 클릭 ③ Esc.
    //  왼쪽 모서리 손잡이(›)는 '밀어서 치운다'는 같은 뜻을 몸짓으로도 준다.
    const pe = el('aside', { class: 'stu-peek', role: 'dialog', 'aria-label': title },
      el('button', { class: 'stu-peek-grip', type: 'button', title: '닫기 — 오른쪽으로 밀어 치웁니다 (Esc)', 'aria-label': '닫기', onclick: closePeek }, el('span', { class: 'ch', text: '›', 'aria-hidden': 'true' })),
      el('div', { class: 'stu-peek-h' }, el('b', { text: title }),
        el('span', { class: 'stu-peek-acts' },
          el('button', { class: 'btn-text', type: 'button', text: '판에 놓기', onclick: () => { addWidget('doc', { x: 120, y: 80 }, { hash, title }); closePeek(); } }),
          el('a', { class: 'btn-text', href: hash, target: '_blank', rel: 'noopener', text: '새 탭 ↗' }),
          el('button', { class: 'stu-peek-x', type: 'button', title: '닫기 (Esc)' }, icon('x', 'stu-i sm'), el('span', { text: '닫기' })))),
      el('iframe', { class: 'stu-peek-f', src: location.pathname + '?embed=1' + hash, title }));
    (pe.querySelector('.stu-peek-x') as HTMLButtonElement).onclick = closePeek;
    peekEl = pe;
    stage.append(pe);   // 스테이지에 얹는다 — 도크 위가 아니라 도크 '옆'에 서게(명령 입력을 가리지 않는다)
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
  const launchBtn = el('button', { class: 'stu-dock-btn', type: 'button', 'aria-expanded': 'false', title: '런치패드 — 위젯·앱을 판에 꺼냅니다', onclick: (e: Event) => { e.stopPropagation(); toggleLaunch(); } }, icon('grid', 'stu-i')) as HTMLButtonElement;
  // 도크(원준 2026-08-19): 왼쪽 = 부르는 것(리브·런치패드), 가운데 = 시키는 것. [+ 새 세션]은 뺐다 —
  //  처음 온 사람에게 '세션'은 뜻 모를 말이고, 새 일을 시키면 어차피 세션이 열린다(행선지 칩이 그 사실을 말해 준다).
  const composer = el('div', { class: 'stu-composer stu-dock' },
    livToggle,
    launchBtn,
    el('div', { class: 'stu-comp-box' },
      el('div', { class: 'stu-comp-row1' }, input, sendBtn),
      el('div', { class: 'stu-comp-row2' }, el('span', { class: 'k', text: '행선지' }), destChip, destWhy)));
  stage.append(composer, livPanel);

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
  input.addEventListener('input', () => { paintDest(); paintAim(); input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendComposer(); } });
  sendBtn.onclick = () => void sendComposer();
  async function sendComposer(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    const { dest } = guessDest(text);
    const born = ghostCanvasPos();   // 유령 창이 떠 있던 자리 — 진짜 카드가 거기서 태어난다('짠')
    input.value = ''; input.style.height = 'auto'; destOverride = null; paintDest();
    if (dest.kind === 'liv') { paintAim(); openLiv(); chat?.say(text); return; }
    if (dest.kind === 'session') {
      try {
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(dest.sid) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) });
        toast(`「${dest.label}」 세션에 보냈어요.`);
        const wg = widgets.find((w) => w.type === 'session' && w.data?.sid === dest.sid);
        // 시킨 세션이 눈앞으로 온다 — 카드가 없으면 만들고, 있으면 가운데로 키운다(대화가 크게 보이게).
        const card = wg || addWidget('session', born || { x: 72, y: 72 }, { sid: dest.sid });
        focusWidget(card);
        const ref2 = els.get(card.id); ref2?.root.classList.add('flash'); window.setTimeout(() => ref2?.root.classList.remove('flash'), 1600);
      } catch (e: any) { toast('보내지 못했어요 — ' + (e?.message || e), true); }
      paintAim();
      return;
    }
    await spawnSession(text, born);
  }
  async function spawnSession(firstPrompt: string | null, at?: { x: number; y: number } | null): Promise<void> {
    const p = runPrefs();
    ghostBusy(true, firstPrompt);
    try {
      const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
        label: (firstPrompt ? firstPrompt.replace(/\s+/g, ' ').slice(0, 28) : (pj().name || '새 세션').slice(0, 28)),
        harness: p.harness && p.harness !== 'shell' ? p.harness : 'claude',
        flags: p.flags && typeof p.flags === 'object' ? p.flags : {}, autoApprove: !!p.autoApprove, sessionDir: true,
        ...(firstPrompt ? { initialPrompt: firstPrompt } : {}) }) });
      const sid = out?.session?.id ? String(out.session.id) : '';
      if (!sid) throw new Error('세션 id 를 받지 못했습니다');
      // 자투리 판에서 연 세션은 어디에도 붙이지 않는다 — 그게 이 판의 정의다(나중에 [프로젝트 연결]로 옮긴다).
      if (!loose) { try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/project', { method: 'POST', body: JSON.stringify({ projectId: id }) }); } catch (_) { /* noop */ } }
      const spec = addWidget('session', at || ghostCanvasPos() || { x: 88, y: 88 }, { sid });
      spec.z = ++zTop;
      popIn(spec);
      if (firstPrompt) focusWidget(spec);   // 시켰으면 그 대화를 크게 — 세션 화면으로 넘어가지 않아도 되게
      toast(firstPrompt ? '새 세션을 열어 시켰어요 — 판에 카드로 올라왔습니다.' : '세션을 열고 판에 올렸어요.');
      opts.onProjectChanged?.();
    } catch (e: any) { toast('세션을 열지 못했어요 — ' + (e?.message || e), true); }
    ghostBusy(false, null);
    paintAim();
  }
  /** 방금 태어난 카드의 '짠' — 유령 자리에서 실체가 되는 한 박자(CSS 키프레임). */
  function popIn(spec: WSpec): void {
    const ref = els.get(spec.id);
    if (!ref) return;
    ref.root.classList.add('pop');
    window.setTimeout(() => ref.root.classList.remove('pop'), 700);
  }
  function toggleLiv(on?: boolean): void {
    const want = on != null ? on : livPanel.hidden;
    livPanel.hidden = !want;
    livToggle.classList.toggle('on', want);
  }
  function openLiv(): void { toggleLiv(true); }
  livToggle.onclick = () => { if (loose) { location.hash = '#/liv'; return; } toggleLiv(); };
  if (loose) livToggle.title = '리브 — 워크스페이스 리브 화면으로';

  function mountChat(): void {
    if (loose) return;   // 프로젝트 리브는 프로젝트의 것 — 자투리 판에서는 L 이 워크스페이스 리브로 데려간다
    chat = mountProjectChat(livBody, {
      projectId: id,
      onTurnDone: () => { void refreshDetail(); opts.onProjectChanged?.(); },
      onHasTurns: (has) => { (livToggle.querySelector('.stu-liv-n') as HTMLElement).hidden = !has; },
    });
  }
  async function refreshDetail(): Promise<void> {
    if (loose) { paintDoor(); return; }
    try { const d = await api('/api/ui/v6/projects/' + id); if (!dead && d) { detail = d; paintDoor(); refreshDataWidgets(); void paintDesk(); } } catch (_) { /* noop */ }
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
    if (loose) return;
    let data: any = null;
    try { data = await api('/api/ui/v6/projects/' + id + '/files?path='); } catch (_) { return; }
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
      widgets.length ? el('div', { class: 'stu-boardhint', text: '바탕화면 — 아이콘은 두 번 눌러 열기 · 파일을 끌어다 놓기 · ⊞ 에서 앱·위젯 꺼내기 · [코멘트]로 어디든 표시' }) : startGuide());
    if (focusId) { ensureScrim(); const r = els.get(focusId); if (r) r.root.classList.add('focused'); }   // 다시 그려도 모달은 열린 채로
    growCanvas();
  }
  /** 처음 = **빈 판 + 길잡이**(원준 2026-08-19 "빈 백지보다 뭐부터 해야 하는지 감이 오는 화면").
   *  위젯을 미리 뿌려 놓지 않는다 — 처음 온 사람에게 판 가득한 카드는 남의 화면처럼 보인다.
   *  할 수 있는 일 셋만 큰 글씨로 두고, 나머지는 일하다 리브가 제안한다. */
  function startGuide(): HTMLElement {
    const step = (n: string, t: string, d2: string, act?: { label: string; run: () => void }): HTMLElement =>
      el('div', { class: 'stu-guide-s' },
        el('span', { class: 'stu-guide-n', text: n }),
        el('div', {}, el('b', { text: t }), el('p', { class: 'stu-fine', text: d2 }),
          act ? el('button', { class: 'btn-text', type: 'button', text: act.label, onclick: act.run }) : null));
    if (loose) return el('div', { class: 'stu-guide' },
      el('h2', { text: '프로젝트에 붙지 않은 세션들' }),
      el('p', { class: 'stu-guide-l', text: '아직 어느 프로젝트에도 매이지 않은 세션이 여기 모입니다. 지금은 하나도 없네요.' }),
      el('div', { class: 'stu-guide-g' },
        el('div', { class: 'stu-guide-s' }, el('span', { class: 'stu-guide-n', text: '＋' }),
          el('div', {}, el('b', { text: '아래 칸에 시켜 보세요' }),
            el('p', { class: 'stu-fine', text: '프로젝트를 정하지 않고도 바로 일을 시킬 수 있어요. 열린 세션은 이 판에 카드로 모이고, 나중에 프로젝트로 옮길 수 있습니다.' })))));
    // 문구는 상민님이 직접 준 판(2026-08-19) — ①엔 버튼을 두지 않는다(입력칸은 늘 아래에 보이는데
    //  거기로 데려가는 버튼은 한 번 더 누르게만 만든다). ②는 '자료 보관'이 아니라 **AI 가 참고한다**는 쓸모로,
    //  ③은 '필요해지면'이 아니라 **커스터마이즈**로 — 판을 자기 것으로 만든다는 감이 먼저다.
    return el('div', { class: 'stu-guide' },
      el('h2', { text: '여기가 이 프로젝트의 작업대예요' }),
      el('p', { class: 'stu-guide-l', text: '빈 캔버스로 시작해서, 이 프로젝트에 맞게 화면을 조정해보세요.' }),
      el('div', { class: 'stu-guide-g' },
        step('1', '아래 칸에 시켜 보세요', '“랜딩 문구 3안 써 줘” 처럼 적으면 AI가 일을 시작하고, 그 대화가 이 판에 카드로 올라옵니다.'),
        step('2', '파일을 끌어다 놓아 보세요', '컴퓨터에서 파일·폴더를 이 판에 떨어뜨리면 이 프로젝트에서 AI랑 대화할 때 AI가 참고해서 작업합니다. AI가 작업하면서 생성한 파일도 여기에 쌓입니다.'),
        step('3', '위젯을 통해서 커스터마이즈 해보세요', '태스크·캘린더·메모 같은 건 ⊞ 에서 앱으로 열거나 위젯으로 캔버스에 둘 수 있어요. 지금 당장은 필요 없습니다.',
          { label: '⊞ 열어 보기', run: () => toggleLaunch(true) })));
  }
  /** 정리 = **위치만** 격자에 맞춘다(원준 2026-08-19 "정리 누르면 크기도 맘대로 바뀐다").
   *  위젯의 크기·구성·내용은 사용자의 것이라 손대지 않는다. 코멘트는 판 위 좌표가 뜻이라 제자리. */
  function autoArrange(): void {
    const movable = widgets.filter((w) => !w.data?.cm);
    const COL = 24, ROW = 24;
    const width = Math.max(600, canvas.clientWidth || 1200);
    let x = COL, y = ROW, rowH = 0;
    for (const w of movable) {
      const ww = w.w || 320, wh = w.min ? 44 : (w.h || 260);
      if (x > COL && x + ww > width - COL) { x = COL; y += rowH + ROW; rowH = 0; }
      w.x = snap(x); w.y = snap(y);
      x += ww + COL; rowH = Math.max(rowH, wh);
    }
    growCanvas();
  }

  // ── 런치패드 타일(위젯·앱) — 클릭 = 판에 올리기 · 끌어다 놓기 = 그 자리에 ──
  const appTile = (d: WDef, after?: () => void, asApp?: boolean): HTMLElement => {
    const c = el('button', { class: 'stu-app' + (asApp ? ' as-app' : ''), type: 'button', title: (asApp ? '앱 — 열어서 하는 일. ' : '위젯 — 캔버스에 둡니다. ') + d.hint, draggable: String(!asApp) as any,
      onclick: () => { if (asApp) openApp(d.type); else addWidget(d.type); after?.(); } },
      el('span', { class: 'stu-app-ic', style: 'background:' + d.ac }, icon(d.ic, 'stu-i')),
      el('span', { class: 'stu-app-n', text: d.label }),
      d.shell ? el('span', { class: 'stu-shell-dot', title: '껍데기' }) : null);
    if (!asApp) c.addEventListener('dragstart', (e: DragEvent) => { e.dataTransfer?.setData('text/plain', 'stu:' + d.type); after?.(); });
    return c;
  };
  // ── 세션 앱 타일(#1780) — 설치된 앱을 열면 그 앱 전용 AI 세션이 판 위에 카드로 뜬다(동의 없으면 그때 동의 창). ──
  const sessionAppTile = (a: SessionApp): HTMLElement =>
    el('button', { class: 'stu-app as-app stu-app-inst', type: 'button', title: '세션 앱 — 열면 이 앱 전용 AI 세션이 판 위에 카드로 떠요',
      onclick: () => { toggleLaunch(false); void openSessionAppCard(a); } },
      el('span', { class: 'stu-app-ic', style: 'background:#0FA37E' }, icon('chat', 'stu-i')),
      el('span', { class: 'stu-app-n', text: a.title }),
      el('span', { class: 'stu-inst-dot', title: '세션 앱' }));
  // 앱 세션을 열고 판 위에 세션 카드로 올린다(spawnSession 과 같은 문법 — 여기선 appId 를 실어 앱 배관을 켠다).
  async function openSessionAppCard(a: SessionApp): Promise<void> {
    const born = ghostCanvasPos();
    const s = await spawnAppSession(a.id, { title: a.title, projectId: id });
    if (!s || dead) return;
    const spec = addWidget('session', born || { x: 88, y: 88 }, { sid: s.id });
    spec.z = ++zTop; popIn(spec); focusWidget(spec);
  }
  /** (v3 호환) 우패널이 있는 셸이 부르면 선반+타임라인을 그린다 — v4 셸은 부르지 않는다(알림 센터·런치패드로 옮겼다). */
  function renderAside(aside: HTMLElement): void {
    aside.replaceChildren(
      el('div', { class: 'stu-shelf' },
        el('div', { class: 'stu-shelf-h', text: '위젯 · 앱' }),
        el('div', { class: 'stu-shelf-grid' }, ...WDEFS.filter((d) => !d.hidden).map((d) => appTile(d)))));
    const tl = createTimeline(aside, { scope: '프로젝트 #' + id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
    void loadProjectTimeline(id, detail).then((items) => { if (!dead) tl.addAll(items); });
  }

  // ── 런치패드(도크 ⊞) — 위젯·앱 그리드가 도크 위로 떠오른다. 밖 클릭·Esc 로 닫힘 ──
  const launch = el('div', { class: 'stu-launch', hidden: true });
  stage.append(launch);
  function toggleLaunch(on?: boolean): void {
    const want = on != null ? on : launch.hidden;
    if (want) {
      // 앱과 위젯은 성격이 다르다 — 앱은 열어서 하는 일(모달), 위젯은 캔버스에 두는 것. 구역을 갈라 그 차이를 보이게.
      // 자투리 판(#/p/0)엔 프로젝트 재료(태스크·지식·자료·명세·타임라인·자동화)가 없다 — 없는 걸 눌러 빈 창을 보여 주는 게 가장 나쁜 안내다.
      const LOOSE_OK = new Set<WType>(['session', 'sticky']);
      const usable = WDEFS.filter((d) => !d.hidden && (!loose || LOOSE_OK.has(d.type)));
      const apps = usable.filter((d) => d.surf === 'app' || d.surf === 'both');
      const wgs = usable.filter((d) => d.surf === 'widget' || d.surf === 'both');
      // 설치된 세션 앱(org_app, #1780) — 스튜디오 내장 앱과 성격이 달라(각자 전용 세션이 뜬다) 별도 구역으로.
      //  비동기로 불러와 도착하면 채운다(없으면 구역 숨김 유지 → 종전 화면과 동일).
      const instGrid = el('div', { class: 'stu-shelf-grid stu-launch-grid' });
      const instSec = el('div', { class: 'stu-launch-inst', hidden: true },
        el('div', { class: 'stu-launch-h sep' }, el('b', { text: '설치된 앱' }), el('span', { class: 'stu-fine', text: '열면 이 앱 전용 AI 세션이 판 위에 카드로 떠요' })),
        instGrid);
      launch.replaceChildren(...[
        apps.length ? el('div', { class: 'stu-launch-h' }, el('b', { text: '앱' }), el('span', { class: 'stu-fine', text: '열어서 하는 일 — 창으로 뜹니다' })) : null,
        apps.length ? el('div', { class: 'stu-shelf-grid stu-launch-grid' }, ...apps.map((d) => appTile(d, () => toggleLaunch(false), true))) : null,
        instSec,
        el('div', { class: 'stu-launch-h' + (apps.length ? ' sep' : '') }, el('b', { text: '위젯' }), el('span', { class: 'stu-fine', text: '캔버스에 두는 것 — 눌러 올리거나 원하는 자리로 끌어다 놓기' })),
        el('div', { class: 'stu-shelf-grid stu-launch-grid' }, ...wgs.map((d) => appTile(d, () => toggleLaunch(false)))),
        // 자투리 판에서 앱 구역이 통째로 비는 건 고장이 아니다 — 왜 없는지 한 줄로 말해 준다(막다른 안내 금지).
        loose ? el('p', { class: 'stu-launch-note stu-fine', text: '태스크·지식·자료 같은 건 프로젝트의 것이에요. 세션을 프로젝트에 연결하면 그 작업대에서 쓸 수 있습니다.' }) : null,
      ].filter(Boolean) as HTMLElement[]);
      void listSessionApps().then((list) => {
        if (launch.hidden || !list.length) return;   // 닫혔거나 설치된 세션 앱 없음 → 숨김 유지
        instSec.hidden = false;
        instGrid.replaceChildren(...list.map((a) => sessionAppTile(a)));
      });
      toggleNotif(false);
    }
    launch.hidden = !want;
    launchBtn.classList.toggle('on', want);
    launchBtn.setAttribute('aria-expanded', String(want));
  }

  // ══ 앱 = 열어서 하는 일(모달) ═══════════════════════════════════════════════
  //  같은 재료라도 성격이 다르다: 앱은 **찾고·고치고·설정하는** 자리(넓은 창), 위젯은 **곁눈질하는** 자리(판 위).
  //  그래서 앱 창엔 언제나 [＋ 캔버스에 위젯으로]가 있다 — 두 표면이 이어져 있음을 손으로 알게.
  let appEl: HTMLElement | null = null;
  function closeApp(): void { if (appEl) { const id2 = appEl.dataset.spec || ''; sigs.delete(id2); els.delete(id2); appEl.remove(); appEl = null; } }
  function openApp(type: WType): void {
    closeApp();
    const d = wdef(type);
    const body = el('div', { class: 'stu-appwin-b' });
    const win = el('section', { class: 'stu-appwin', role: 'dialog', 'aria-label': d.label },
      el('div', { class: 'stu-appwin-h' },
        el('span', { class: 'stu-w-ic', style: 'color:' + d.ac + ';background:' + d.ac + '1a' }, icon(d.ic, 'stu-i sm')),
        el('b', { text: d.label }),
        d.shell ? el('span', { class: 'stu-shell-badge', text: '껍데기' }) : null,
        el('span', { class: 'stu-peek-acts' },
          el('button', { class: 'btn-text', type: 'button', text: '＋ 캔버스에 위젯으로', title: '이 앱의 내용을 판에 두고 곁눈질합니다', onclick: () => { addOrFocus(type); closeApp(); } }),
          el('button', { class: 'stu-peek-x', type: 'button', onclick: closeApp }, icon('x', 'stu-i sm'), el('span', { text: '닫기' })))),
      body);
    appEl = win;
    win.dataset.spec = 'app-' + type;
    if (type === 'desc') fillDescApp(body);
    else if (type === 'knowledge') fillKnowledgeApp(body);
    else {
      const spec: WSpec = { id: 'app-' + type, type, x: 0, y: 0, w: 900, h: 560, data: {} };   // L 등급 = 앱은 넓게
      els.set(spec.id, { root: win, body, title: el('b') });
      fillBody(spec, body, true);
    }
    stage.append(win);
    toggleLaunch(false); toggleNotif(false);
  }
  /** 명세 앱 = 프로젝트 본문을 **고치는** 자리(위젯은 읽는 자리). */
  function fillDescApp(body: HTMLElement): void {
    const ta = el('textarea', { class: 'stu-descedit', spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = String(pj().description || '');
    const status = el('span', { class: 'stu-fine' });
    body.replaceChildren(
      el('p', { class: 'stu-fine', text: '이 프로젝트가 무엇인지 — 세션과 리브가 일할 때 먼저 읽는 글입니다. 마크다운으로 쓰세요.' }),
      ta,
      el('div', { class: 'stu-appwin-f' }, status,
        el('button', { class: 'stu-pillbtn mint', type: 'button', text: '저장', onclick: async () => {
          status.textContent = '저장 중…';
          try {
            await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: ta.value || null }) });
            (detail && detail.project ? detail.project : {}).description = ta.value;
            status.textContent = '저장했어요.'; refreshDataWidgets(); void refreshDetail();
          } catch (e: any) { status.textContent = '저장하지 못했어요 — ' + (e?.message || e); }
        } }),
        el('button', { class: 'btn-text', type: 'button', text: '리브에게 정돈 맡기기', onclick: () => { closeApp(); openLiv(); chat?.say('본문을 정돈된 형식으로 다시 써 줘. 사실·결정·링크는 하나도 잃지 말고.'); } })));
  }
  /** 지식 앱 = **찾는** 자리(위젯은 목록만). */
  function fillKnowledgeApp(body: HTMLElement): void {
    const kn = (pj().knowledge || {}) as any;
    const all: Array<{ name: string; rel: string; title?: string }> = [
      ...((kn.required || []) as any[]).map((k: any) => ({ name: String(k.name), rel: '필요', title: String(k.title || '') })),
      ...((kn.produced || []) as any[]).map((k: any) => ({ name: String(k.name), rel: '산출', title: String(k.title || '') })),
    ];
    const list = el('div', { class: 'stu-scroll stu-assets' });
    const q = el('input', { class: 'stu-appsearch', type: 'search', placeholder: '지식 이름·제목으로 찾기', 'aria-label': '지식 검색' }) as HTMLInputElement;
    const draw = (): void => {
      const t = q.value.trim().toLowerCase();
      const hit = all.filter((k) => !t || k.name.toLowerCase().includes(t) || (k.title || '').toLowerCase().includes(t));
      list.replaceChildren(...(hit.length ? hit.map((k) => el('div', { class: 'stu-asset' },
        el('button', { class: 'stu-asset-b', type: 'button', onclick: () => { closeApp(); openPeek('#/k/' + encodeURIComponent(k.name), k.name); } },
          el('span', { class: 'stu-asset-ic' }, icon('book', 'stu-i')),
          el('span', { class: 'stu-asset-t' }, el('b', { text: k.name }), el('span', { class: 'stu-asset-m' }, el('span', { text: k.rel }), k.title ? el('span', { class: 'sep', text: '·' }) : null, k.title ? el('span', { class: 'stu-asset-dir', text: k.title }) : null)))))
        : [el('p', { class: 'stu-fine', text: t ? '찾는 지식이 없어요.' : '아직 연결된 지식이 없어요 — 세션이 남긴 결론이 여기 쌓입니다.' })]));
    };
    q.addEventListener('input', draw);
    body.replaceChildren(q, list);
    draw();
  }

  // ── 알림 센터(옛 문패 [타임라인]) — 지금은 활동 스트림의 [모두 보기]가 부른다 ──
  const notif = el('aside', { class: 'stu-notif', hidden: true, 'aria-label': '타임라인' });
  stage.append(notif);
  function toggleNotif(on?: boolean): void {
    const want = on != null ? on : notif.hidden;
    if (want) {
      const body = el('div', { class: 'stu-notif-b' });
      notif.replaceChildren(body);
      const tl = createTimeline(body, { scope: '프로젝트 #' + id, showActors: true, outcomes: true, empty: '아직 남은 것이 없어요.' });
      // 타임라인 자기 머리(제목·범위·건수)에 알림 센터의 손잡이만 얹는다 — 머리를 두 번 그리지 않는다.
      body.querySelector('.tl-wrap > .v2-aside-h')?.append(el('span', { class: 'stu-w-acts stu-notif-acts' },
        el('button', { class: 'btn-text', type: 'button', text: '판에 고정', title: '위젯으로 꺼내 바탕화면에 둡니다', onclick: () => { addOrFocus('timeline'); toggleNotif(false); } }),
        el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '닫기(Esc)', onclick: () => toggleNotif(false) })));
      void loadProjectTimeline(id, detail).then((items) => { if (!dead && !notif.hidden) tl.addAll(items); });
      toggleLaunch(false);
      notif.hidden = false;
      requestAnimationFrame(() => notif.classList.add('on'));   // 다음 프레임에 켜야 '들어오는' 전환이 걸린다
    } else {
      notif.classList.remove('on');
      // 다 밀려 나간 뒤에 감춘다 — 바로 hidden 을 주면 전환이 잘린다.
      window.setTimeout(() => { if (!notif.classList.contains('on')) notif.hidden = true; }, 260);
    }
    tlBtn.classList.toggle('on', want);
    tlBtn.setAttribute('aria-expanded', String(want));
  }
  document.addEventListener('pointerdown', onDocDown);
  document.addEventListener('keydown', onDocKey);
  function onDocDown(e: PointerEvent): void {
    if (dead) { document.removeEventListener('pointerdown', onDocDown); return; }
    const t = e.target as Node;
    if (!notif.hidden && !notif.contains(t) && !streamEl.contains(t) && !tlBtn.contains(t)) toggleNotif(false);
    if (appEl && !appEl.contains(t) && !launch.contains(t)) closeApp();
    if (!launch.hidden && !launch.contains(t) && !launchBtn.contains(t)) toggleLaunch(false);
    if (peekEl && !peekEl.contains(t)) closePeek();   // 판 아무 데나 누르면 피크는 물러난다(맥 훑어보기와 같은 몸짓)
    if (desk.contains(t)) return;
    desk.querySelectorAll('.stu-ico.sel').forEach((x) => x.classList.remove('sel'));   // 바탕 클릭 = 선택 해제(맥)
  }
  function onDocKey(e: KeyboardEvent): void {
    if (dead) { document.removeEventListener('keydown', onDocKey); return; }
    const typing = !!(document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    if (e.key === 'Escape') {
      if (focusId) { unfocusWidget(); e.stopPropagation(); }
      else if (appEl) { closeApp(); e.stopPropagation(); }
      else if (!notif.hidden) { toggleNotif(false); e.stopPropagation(); }
      else if (!launch.hidden) { toggleLaunch(false); e.stopPropagation(); }
      else if (selected().length) { clearSel(); e.stopPropagation(); }
      return;
    }
    if (typing) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); for (const [x] of iconEls) x.classList.add('sel'); paintDeskBar(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected().length) { e.preventDefault(); void trashItems(selected().map((x) => x.it)); }
  }

  // ── 바탕화면(v5, 원준 2026-08-19 "폴더가 쓸데없이 엄청 생겨있고 뭔지 전혀 모르겠음") ─────────────
  //  ★ 규칙: **뜻이 있는 것만 올린다.** 공유 폴더의 워크트리(레포 클론)·기계 파일(CLAUDE.md·AGENTS.md)은 사람이 만든 게
  //   아니라 판을 어지럽힐 뿐이다. 그래서 목록은 매니페스트(`/shared/manifest` — .git 보유 폴더를 통째로 건너뛴다)를 쓰고,
  //   폴더 여러 개 대신 **스택 하나**(공유 폴더 · 지식)로 접는다. 아이콘마다 종류 캡션(그림·PDF·시안·문서)을 달아
  //   "각각 뭔지" 를 이름 밑에서 바로 읽게 한다.
  //  조작(맥 그대로): 클릭 = 선택 · ⌘/Ctrl+클릭 = 더하기 · 바탕 드래그 = 영역 선택 · ⌘A = 전체 · Esc = 해제 ·
  //   두 번 = 열기 · 끌어다 판에 놓기 = 그 자리에 창 · Delete 또는 휴지통에 떨구기 = 버리기.
  const TRASH_DIR = '휴지통';
  const MACHINE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.DS_Store', 'package-lock.json', 'yarn.lock']);
  const NOISE_RE = /\/(__pycache__|node_modules|dist|build|\.next|coverage|venv)\//;   // 사람이 올린 자료가 아닌 것
  type AssetFile = { path: string; size: number; mtime: number };
  const desk = el('div', { class: 'stu-desk', role: 'listbox', 'aria-label': '바탕화면', 'aria-multiselectable': 'true' });
  const deskBar = el('div', { class: 'stu-deskbar', hidden: true });
  const marq = el('div', { class: 'stu-deskmarq', hidden: true });
  const trashEl = el('div', { class: 'stu-trash' });
  stage.append(desk, deskBar, marq, trashEl);
  let deskSig = '';
  let trashN = 0;
  type DKind = 'stack-folder' | 'stack-kn' | 'img' | 'pdf' | 'page' | 'doc' | 'file';
  type DeskItem = { kind: DKind; path: string; label: string; type: string; sub?: string; n?: number };
  const isImg = (n: string): boolean => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
  const base = (p2: string): string => String(p2).split('/').pop() || String(p2);
  /** 확장자 → 사람이 읽는 종류. 아이콘 밑 캡션이자 이 파일이 무엇인지에 대한 답. */
  function kindOf(p2: string): { kind: DKind; type: string } {
    if (isImg(p2)) return { kind: 'img', type: '그림' };
    if (/\.pdf$/i.test(p2)) return { kind: 'pdf', type: 'PDF' };
    if (/\.html?$/i.test(p2)) return { kind: 'page', type: '시안' };
    if (/\.(md|txt)$/i.test(p2)) return { kind: 'doc', type: '문서' };
    if (/\.(csv|tsv|xlsx?)$/i.test(p2)) return { kind: 'file', type: '표' };
    if (/\.(pptx?|key)$/i.test(p2)) return { kind: 'file', type: '장표' };
    if (/\.(zip|tar|gz)$/i.test(p2)) return { kind: 'file', type: '묶음' };
    return { kind: 'file', type: '파일' };
  }
  const fileUrl = (p2: string): string => apiUrl('/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent(p2));
  // <img src> 는 Authorization 헤더를 못 싣는다 — 쿠키 없는 세션(프리뷰·데스크톱 토큰 모드)에서 그림이 깨진다.
  //  받아서 objectURL 로 건다. URL 은 화면이 죽을 때 한꺼번에 반납한다.
  const blobUrls: string[] = [];
  function fillImg(img: HTMLImageElement, p2: string): void {
    void fetch(fileUrl(p2), { headers: authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((bl) => {
      if (!bl || dead) return;
      const u = URL.createObjectURL(bl); blobUrls.push(u); img.src = u;
    }).catch(() => { /* 못 받으면 아이콘 그대로 */ });
  }

  function openDeskItem(it: DeskItem, at?: { x: number; y: number }): void {
    if (it.kind === 'stack-folder') { addOrFocus('folder'); return; }   // 원시 파일 브라우저가 아니라 자료함 위젯(그 안에 '원본 폴더 열기' 가 있다)
    if (it.kind === 'stack-kn') { addOrFocus('knowledge'); return; }
    if (it.kind === 'img' || it.kind === 'pdf' || it.kind === 'page') {
      const w = addWidget('preview', at || { x: 96 + (widgets.length % 5) * 26, y: 96 + (widgets.length % 4) * 22 }, { path: it.path, name: base(it.path) });
      w.z = ++zTop; popIn(w); return;
    }
    void openFileViewer(id, it.path, base(it.path), () => { /* noop */ }, '/api/ui/v6/projects/');
  }
  // ── 선택 ──
  const iconEls = new Map<HTMLElement, DeskItem>();
  const selected = (): Array<{ el: HTMLElement; it: DeskItem }> => [...iconEls].filter(([e2]) => e2.classList.contains('sel')).map(([e2, it]) => ({ el: e2, it }));
  function selectOnly(b: HTMLElement | null): void {
    for (const [e2] of iconEls) e2.classList.toggle('sel', e2 === b);
    paintDeskBar();
  }
  function clearSel(): void { for (const [e2] of iconEls) e2.classList.remove('sel'); paintDeskBar(); }
  function paintDeskBar(): void {
    const sel = selected().filter((x) => x.it.kind !== 'stack-folder' && x.it.kind !== 'stack-kn');
    const n = selected().length;
    deskBar.hidden = n === 0;
    if (!n) return;
    deskBar.replaceChildren(...[
      el('b', { text: n + '개 선택' }),
      el('button', { class: 'btn-text', type: 'button', text: '열기', onclick: () => { selected().forEach((x, i) => openDeskItem(x.it, { x: 80 + i * 26, y: 72 + i * 22 })); clearSel(); } }),
      sel.length ? el('button', { class: 'btn-text', type: 'button', text: '복제', onclick: () => void duplicateItems(sel.map((x) => x.it)) }) : null,
      sel.length ? el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashItems(sel.map((x) => x.it)) }) : null,
      el('button', { class: 'stu-w-btn', type: 'button', text: '×', title: '선택 해제 (Esc)', onclick: clearSel }),
    ].filter(Boolean) as HTMLElement[]);   // ⚠ replaceChildren 은 el 과 달리 null 을 'null' 텍스트로 넣는다
  }
  function deskIcon(it: DeskItem): HTMLElement {
    const stack = it.kind === 'stack-folder' || it.kind === 'stack-kn';
    const thumb = it.kind === 'img' ? el('img', { alt: '', loading: 'lazy' }) as HTMLImageElement : null;
    if (thumb) fillImg(thumb, it.path);
    const g = it.kind === 'img'
      ? el('span', { class: 'stu-ico-g im' }, thumb!)
      : el('span', { class: 'stu-ico-g ' + it.kind }, icon(it.kind === 'stack-folder' ? 'folder' : it.kind === 'stack-kn' ? 'book' : it.kind === 'page' ? 'deck' : it.kind === 'pdf' ? 'doc' : 'doc', 'stu-i'));
    if (stack) g.classList.add('stack');
    const b = el('button', { class: 'stu-ico' + (stack ? ' is-stack' : ''), type: 'button', role: 'option', 'aria-selected': 'false', draggable: String(!stack) as any,
      title: (stack ? it.label : it.path) + (it.sub ? ' — ' + it.sub : '') + '\n' + (stack ? '두 번 눌러 열기' : '두 번 눌러 열기 · 끌어다 놓으면 그 자리에 창 · Delete = 휴지통') },
      g, el('span', { class: 'stu-ico-n', text: it.label }), el('span', { class: 'stu-ico-t', text: it.type + (it.n != null ? ' · ' + it.n : '') }));
    b.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) { b.classList.toggle('sel'); paintDeskBar(); return; }
      selectOnly(b);
    });
    b.addEventListener('dblclick', (e: MouseEvent) => { e.preventDefault(); openDeskItem(it); });
    b.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); openDeskItem(it); } });
    b.addEventListener('dragstart', (e: DragEvent) => {
      if (stack) { e.preventDefault(); return; }
      if (!b.classList.contains('sel')) selectOnly(b);
      const many = selected().map((x) => x.it).filter((x) => x.kind !== 'stack-folder' && x.kind !== 'stack-kn');
      e.dataTransfer?.setData('text/plain', 'stu-desk:' + JSON.stringify(many.length ? many : [it]));
      desk.classList.add('dragging');
    });
    b.addEventListener('dragend', () => { desk.classList.remove('dragging'); trashEl.classList.remove('over'); });
    iconEls.set(b, it);
    return b;
  }

  // ── 영역 선택(마퀴) — 바탕(빈 판)에서 끌면 사각형이 그려지고 겹친 아이콘이 잡힌다 ──
  board.addEventListener('mousedown', (e: MouseEvent) => {
    if (commentMode || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.stu-w, .stu-cmt, .stu-composer, .stu-launch, .stu-notif, .stu-peek')) return;
    e.preventDefault();                 // 판을 긁을 때 페이지 글자가 함께 선택되던 것
    const sr = stage.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev: MouseEvent): void => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      if (!moved) stage.classList.add('marq-on');
      moved = true; marq.hidden = false;
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY);
      const w2 = Math.abs(ev.clientX - sx), h2 = Math.abs(ev.clientY - sy);
      marq.style.left = (x - sr.left) + 'px'; marq.style.top = (y - sr.top) + 'px'; marq.style.width = w2 + 'px'; marq.style.height = h2 + 'px';
      const box = { l: x, t: y, r: x + w2, b: y + h2 };
      for (const [e2] of iconEls) {
        const r = e2.getBoundingClientRect();
        const hit = r.right > box.l && r.left < box.r && r.bottom > box.t && r.top < box.b;
        e2.classList.toggle('sel', ev.metaKey || ev.ctrlKey ? (e2.classList.contains('sel') || hit) : hit);
      }
      paintDeskBar();
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      marq.hidden = true; stage.classList.remove('marq-on');
      if (!moved) clearSel();   // 그냥 클릭 = 바탕 클릭 = 선택 해제(맥)
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });

  // ── 휴지통 — 아이콘을 떨구거나 Delete. 되돌리기·비우기는 휴지통을 두 번 눌러서 ──
  //  서버 rename 은 같은 폴더 안에서만 되므로(경로 이동 API 없음) '복사 후 삭제' 로 옮긴다 — 큰 파일은 확인을 받는다.
  function paintTrash(): void {
    trashEl.replaceChildren(
      el('span', { class: 'stu-ico-g trash' + (trashN ? ' full' : '') }, icon('trash', 'stu-i')),
      el('span', { class: 'stu-ico-n', text: '휴지통' }),
      el('span', { class: 'stu-ico-t', text: trashN ? trashN + '개' : '비어 있음' }));
  }
  trashEl.addEventListener('dblclick', () => void openTrash());
  trashEl.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); trashEl.classList.add('over'); });
  trashEl.addEventListener('dragleave', () => trashEl.classList.remove('over'));
  trashEl.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); trashEl.classList.remove('over');
    const raw = e.dataTransfer?.getData('text/plain') || '';
    if (!raw.startsWith('stu-desk:')) return;
    try { void trashItems(JSON.parse(raw.slice(9)) as DeskItem[]); } catch (_) { /* noop */ }
  });
  async function moveFile(from: string, to: string): Promise<void> {
    const r = await fetch(fileUrl(from), { headers: authHeaders() });
    if (!r.ok) throw new Error('읽지 못했어요(' + r.status + ')');
    const blob = await r.blob();
    const up = await fetch(fileUrl(to), { method: 'PUT', headers: authHeaders(), body: blob });
    if (!up.ok) throw new Error('옮기지 못했어요(' + up.status + ')');
    await api('/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent(from), { method: 'DELETE' });
  }
  function authHeaders(): Record<string, string> {
    const t = (() => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } })();
    return t ? { authorization: 'Bearer ' + t } : {};
  }
  async function trashItems(items: DeskItem[]): Promise<void> {
    const list = items.filter((it) => it.kind !== 'stack-folder' && it.kind !== 'stack-kn');
    if (!list.length) return;
    try { await api('/api/ui/v6/projects/' + id + '/folder?path=' + encodeURIComponent(TRASH_DIR), { method: 'POST' }); } catch (_) { /* 이미 있음 */ }
    let ok = 0;
    for (const it of list) {
      try { await moveFile(it.path, TRASH_DIR + '/' + base(it.path)); ok++; }
      catch (e: any) { toast(base(it.path) + ' — ' + (e?.message || e), true); }
    }
    if (ok) toast(ok + '개를 휴지통으로 옮겼어요 — 휴지통을 두 번 누르면 되돌릴 수 있어요.');
    clearSel(); deskSig = ''; await paintDesk();
  }
  async function duplicateItems(items: DeskItem[]): Promise<void> {
    let ok = 0;
    for (const it of items) {
      const nm = base(it.path);
      const dot = nm.lastIndexOf('.');
      const copy = (dot > 0 ? nm.slice(0, dot) + ' 사본' + nm.slice(dot) : nm + ' 사본');
      const dir = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/') + 1) : '';
      try {
        const r = await fetch(fileUrl(it.path), { headers: authHeaders() });
        const up = await fetch(fileUrl(dir + copy), { method: 'PUT', headers: authHeaders(), body: await r.blob() });
        if (!up.ok) throw new Error('복제 실패(' + up.status + ')');
        ok++;
      } catch (e: any) { toast(nm + ' — ' + (e?.message || e), true); }
    }
    if (ok) toast(ok + '개를 복제했어요.');
    clearSel(); deskSig = ''; await paintDesk();
  }
  async function openTrash(): Promise<void> {
    let items: any[] = [];
    try { const d: any = await api('/api/ui/v6/projects/' + id + '/files?path=' + encodeURIComponent(TRASH_DIR)); items = (d && d.items) || []; } catch (_) { items = []; }
    if (dead) return;
    const host = el('div', { class: 'stu-trashpanel-b' });
    const panel = el('aside', { class: 'stu-trashpanel', role: 'dialog', 'aria-label': '휴지통' },
      el('div', { class: 'stu-notif-h2' }, el('b', { text: '휴지통' }), el('span', { class: 'stu-fine', text: items.length + '개' }),
        el('span', { class: 'stu-peek-acts' },
          items.length ? el('button', { class: 'btn-text danger', type: 'button', text: '비우기', onclick: () => void emptyTrash(panel) }) : null,
          el('button', { class: 'stu-peek-x', type: 'button', onclick: () => panel.remove() }, icon('x', 'stu-i sm'), el('span', { text: '닫기' })))),
      host);
    host.replaceChildren(...(items.length ? items.map((f: any) => el('div', { class: 'stu-trashrow' },
      el('span', { class: 'n', text: String(f.name) }), el('span', { class: 'm', text: fmtSize(f.size || 0) }),
      el('button', { class: 'btn-text', type: 'button', text: '되돌리기', onclick: async () => {
        try { await moveFile(TRASH_DIR + '/' + f.name, String(f.name)); toast(f.name + ' — 제자리로 돌려놨어요.'); panel.remove(); deskSig = ''; await paintDesk(); }
        catch (e: any) { toast('되돌리지 못했어요 — ' + (e?.message || e), true); }
      } })))
      : [el('p', { class: 'stu-fine', text: '휴지통이 비어 있어요.' })]));
    stage.append(panel);
  }
  async function emptyTrash(panel: HTMLElement): Promise<void> {
    try { await api('/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent(TRASH_DIR), { method: 'DELETE' }); toast('휴지통을 비웠어요.'); }
    catch (e: any) { toast('비우지 못했어요 — ' + (e?.message || e), true); }
    panel.remove(); deskSig = ''; await paintDesk();
  }

  // ── 자투리 판 = 프로젝트 없는 세션이 곧 내용 ────────────────────────────────
  //  전부 카드로 올린다(원준 "자투리 세션들을 다 거기에 넣어"). 사용자가 치운 카드는 다시 올리지 않는다 —
  //  판은 사용자의 것이므로, 되살리는 건 우리가 아니라 사용자가 [AI 세션] 위젯으로 한다.
  const LOOSE_HIDE_KEY = 'lively_studio_loose_hidden';
  const looseHidden = ((): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(LOOSE_HIDE_KEY) || '[]')); } catch (_) { return new Set(); } })();
  function looseHide(sid: string): void { looseHidden.add(sid); try { localStorage.setItem(LOOSE_HIDE_KEY, JSON.stringify([...looseHidden])); } catch (_) { /* noop */ } }
  function syncLooseCards(first: boolean): void {
    if (!loose) return;
    const on = new Set(widgets.filter((w) => w.type === 'session').map((w) => String(w.data?.sid || '')));
    // ⚠ 카드 하나가 곧 폴링 하나다(대화·상태) — 자투리가 189개인 워크스페이스도 있다(실측).
    //  그래서 **살아 있는 세션 먼저**, 없으면 최근 것 몇 개만. 나머지는 사이드바 목록이 이미 다 보여 준다.
    const cand = mySessions().filter((s2) => !on.has(s2.id) && !looseHidden.has(s2.id));
    const live = cand.filter((s2) => s2.live && s2.alive);
    const rest = cand.filter((s2) => !(s2.live && s2.alive));
    const room = Math.max(0, (first ? 8 : 3) - widgets.filter((w) => w.type === 'session').length);
    const add = [...live, ...(first ? rest.slice(0, Math.max(0, 4 - live.length)) : [])].slice(0, room);
    if (!add.length) return;
    add.forEach((s2, i) => {
      const n = widgets.length + i;
      addWidget('session', { x: 32 + (n % 3) * 360, y: 24 + Math.floor(n / 3) * 332 }, { sid: s2.id }, { noSave: true });
    });
    save(); paintAll();
  }

  /** 자료 = 사람이 올렸거나 세션이 남긴 파일. 워크트리·기계 파일·캐시는 애초에 자료가 아니다. */
  async function assetFiles(): Promise<AssetFile[]> {
    // 매니페스트 = 재귀 파일 목록에서 **워크트리(.git 보유 폴더)를 통째로 건너뛴 것**.
    const m: any = await api('/api/ui/v6/projects/' + id + '/shared/manifest').catch(() => null);
    const mf: any[] = (m && m.files) || [];
    trashN = mf.filter((f: any) => String(f.path).startsWith(TRASH_DIR + '/')).length;
    return mf
      .filter((f: any) => {
        const p2 = String(f.path);
        if (p2.startsWith(TRASH_DIR + '/')) return false;
        if (MACHINE_FILES.has(base(p2))) return false;
        return !NOISE_RE.test('/' + p2);
      })
      .map((f: any) => ({ path: String(f.path), size: Number(f.size || 0), mtime: Number(f.mtime || 0) }))
      .sort((a2, b2) => b2.mtime - a2.mtime);
  }

  let assetCount: number | null = null;
  async function paintDesk(): Promise<void> {
    if (loose) { desk.replaceChildren(); trashEl.hidden = true; return; }   // 공유 폴더가 없는 판 — 바탕 아이콘·휴지통도 없다
    const assets = await assetFiles().catch(() => [] as AssetFile[]);
    if (dead) return;
    assetCount = assets.length;
    const rootN = assets.length;   // 스택 배지 = **자료 수**(파일시스템 항목 수가 아니라)
    const docs = assets.slice(0, 6);   // 많을수록 바탕이 어지럽다 — 최근 것 여섯만(나머지는 [공유 폴더] 안에)
    const kn = (pj().knowledge || {}) as any;
    const knN = ((kn.required || []) as any[]).length + ((kn.produced || []) as any[]).length;
    const items: DeskItem[] = [
      { kind: 'stack-folder', path: '', label: '공유 폴더', type: '자료', n: rootN, sub: '올린 파일·세션이 남긴 결과물' },
      ...(knN ? [{ kind: 'stack-kn' as const, path: '', label: '지식', type: '지식', n: knN, sub: '필요·산출 지식' }] : []),
      ...docs.map((f) => {
        const k = kindOf(f.path);
        return { kind: k.kind, path: f.path, label: base(f.path), type: k.type, sub: fmtSize(f.size) };
      }),
    ];
    const sig = JSON.stringify(items.map((i) => i.kind + ':' + i.path + ':' + (i.n ?? '')) ) + ':' + trashN;
    if (sig === deskSig) return;
    deskSig = sig;
    iconEls.clear();
    desk.replaceChildren(...items.map(deskIcon));
    paintTrash();
    paintDeskBar();
  }

  // ══ 타임라인 = 두 층(원준 2026-08-19 "타임라인은 중요한데 버튼 눌러 나오는 건 별로") ═══════════
  //  ① **살아 있는 층 = 활동 스트림**: 새 일이 생기면 우측 위에 카드가 스스로 떠올랐다 물러난다(맥 알림).
  //     버튼을 누르지 않아도 흐름이 보이고, 누르면 그 일이 있던 자리(세션 카드)로 데려간다.
  //  ② **되돌아보는 층**: 전체 기록은 [타임라인] **앱**(찾기·필터)이나 **위젯**(상주)으로 — 상시 여부는 사용자가 정한다.
  //  그래서 문패의 [타임라인] 버튼은 없앴다. 상단 버튼은 캔버스 설정 자리지 기능 자리가 아니다.
  const streamEl = el('div', { class: 'stu-stream', 'aria-live': 'polite', 'aria-label': '방금 일어난 일' });
  stage.append(streamEl);
  let streamSeen: Set<string> | null = null;   // null = 첫 로드(기준선만 잡고 알리지 않는다 — 들어오자마자 폭탄이면 소음이다)
  async function pollStream(): Promise<void> {
    let items: any[] = [];
    try { items = await loadProjectTimeline(id, detail); } catch (_) { return; }
    if (dead) return;
    const key = (it: any): string => String(it.id ?? '') + ':' + String(it.at ?? it.time ?? '') + ':' + String(it.title ?? it.text ?? '');
    if (!streamSeen) { streamSeen = new Set(items.slice(0, 60).map(key)); return; }
    const fresh = items.filter((it) => !streamSeen!.has(key(it))).slice(0, 3);
    for (const it of fresh) streamSeen.add(key(it));
    for (const it of fresh) pushStream(it);
  }
  function pushStream(it: any): void {
    const title = String(it.title || it.text || it.label || '새 소식');
    const sid = String(it.sessionId || it.session_id || it.raw?.session_id || '');
    const card = el('button', { class: 'stu-streamcard', type: 'button', title: '이 일이 있던 자리로' },
      el('span', { class: 'stu-stream-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'stu-stream-t' }, el('b', { text: title }), el('span', { class: 'stu-fine', text: it.kind || it.type || '방금' })));
    card.onclick = () => {
      const wg = sid ? widgets.find((w) => w.type === 'session' && w.data?.sid === sid) : null;
      if (wg) focusWidget(wg); else toggleNotif(true);
      card.remove();
    };
    streamEl.append(card);
    while (streamEl.children.length > 3) streamEl.firstElementChild?.remove();
    window.setTimeout(() => { card.classList.add('out'); window.setTimeout(() => card.remove(), 260); }, 9000);
  }

  // ══ 리브 말풍선 — 캔버스를 쓸 수 있다는 감을 '말'로 준다(원준 2026-08-19) ══════════════
  //  규칙 기반(껍데기): 판의 상태를 보고 지금 해 볼 만한 것 하나를 제안한다. 닫으면 그 제안은 다시 안 나온다.
  const tip = el('div', { class: 'stu-tip', hidden: true });
  stage.append(tip);
  const TIP_KEY = 'lively_studio_tips_' + id;
  const tipsDone = ((): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(TIP_KEY) || '[]')); } catch (_) { return new Set(); } })();
  function tipDone(k: string): void { tipsDone.add(k); try { localStorage.setItem(TIP_KEY, JSON.stringify([...tipsDone])); } catch (_) { /* noop */ } }
  function showTip(k: string, text: string, act?: { label: string; run: () => void }): void {
    if (tipsDone.has(k) || !tip.hidden) return;
    tip.replaceChildren(
      el('p', { class: 'stu-tip-t', text }),
      el('div', { class: 'stu-tip-a' },
        act ? el('button', { class: 'stu-pillbtn mint', type: 'button', text: act.label, onclick: () => { tipDone(k); tip.hidden = true; act.run(); } }) : null,
        el('button', { class: 'btn-text', type: 'button', text: '괜찮아요', onclick: () => { tipDone(k); tip.hidden = true; } })));
    tip.hidden = false;
  }
  function thinkTip(): void {
    if (!tip.hidden || dead) return;
    const live = mySessions().filter((s) => s.live && s.alive);
    const hasSessionCard = widgets.some((w) => w.type === 'session');
    if (loose) {
      // 자투리 판엔 자료·타임라인이 없다 — 없는 걸 권하지 않는다(막다른 안내 금지).
      showTip('loose', '여기 카드는 아직 어느 프로젝트에도 붙지 않은 세션들이에요. 프로젝트에 연결하면 그 프로젝트의 자료·태스크와 함께 일하게 됩니다.');
      return;
    }
    if (!widgets.length && !(assetCount ?? 0)) {
      showTip('start', '먼저 무엇을 할지 아래 칸에 적어 보세요. 컴퓨터에서 파일을 끌어다 놓아도 돼요 — 이 판이 이 프로젝트의 작업대예요.');
      return;
    }
    if ((assetCount ?? 0) > 0 && !widgets.some((w) => w.type === 'folder')) {
      showTip('assets', `올려 둔 자료가 ${assetCount}개 있어요. 자주 볼 것 같으면 판에 두고 곁눈질할 수 있어요.`,
        { label: '자료함 올리기', run: () => addOrFocus('folder') });
      return;
    }
    if (live.length && !hasSessionCard) {
      showTip('live', `지금 ${live.length}개가 돌아가는 중이에요. 판에 올려 두면 대화가 오가는 걸 그대로 볼 수 있어요.`,
        { label: '세션 올리기', run: () => { const s0 = live[0]; const w = addWidget('session', { x: 80, y: 96 }, { sid: s0.id }); w.z = ++zTop; popIn(w); } });
      return;
    }
    if (widgets.length >= 2 && !widgets.some((w) => w.type === 'timeline')) {
      showTip('tl', '무슨 일이 있었는지 늘 보고 싶으면 타임라인을 판에 두세요. 필요 없으면 그때그때 알림으로만 와요.',
        { label: '타임라인 올리기', run: () => addOrFocus('timeline') });
    }
  }

  // ══ 세션 포커스 — 시킨 세션이 가운데로 커진다(원준 2026-08-19) ═══════════════════
  //  "매번 세션 화면으로 넘어가지 않고도 오가는 말이 보였으면" — 카드를 키워 대화를 크게 보여주고,
  //  [작게]로 원래 자리·크기로 돌아온다(창을 키웠다 줄이는 맥 문법 그대로).
  //  ⚠ **모달처럼 다룬다**(원준 2026-08-19): 커진 카드가 판의 새 자리로 '이사'하면 닫을 때 돌아갈 곳이 흐려진다.
  //   그래서 ① 뒤에 딤을 깔아 판을 잠그고 ② 커진 기하는 **저장하지 않는다**(닫으면 원래 자리·크기로 복귀,
  //   새로고침해도 원래 자리) ③ 위치·크기 변화는 그 자리에서 **부드럽게** 움직인다.
  //   paintAll 은 DOM 을 통째로 새로 만들어 전환이 안 걸리므로, 포커스는 **다시 그리지 않고 스타일만** 바꾼다.
  const focusPrev = new Map<string, { x: number; y: number; w: number; h: number; min?: boolean }>();
  let focusId: string | null = null;
  let scrimEl: HTMLElement | null = null;
  const ANIM_MS = 280;

  function ensureScrim(): HTMLElement {
    const sc = scrimEl ?? el('div', { class: 'stu-scrim', 'aria-hidden': 'true' });
    if (!scrimEl) { sc.addEventListener('pointerdown', (e: Event) => { e.stopPropagation(); unfocusWidget(); }); scrimEl = sc; }
    if (sc.parentElement !== canvas) canvas.append(sc);
    return sc;
  }
  /** 전환 동안만 transition 을 켠다 — 상시로 켜면 끌어 옮길 때 손가락을 따라오지 못한다. */
  function animate(node: HTMLElement, apply: () => void): void {
    node.classList.add('anim');
    apply();
    window.setTimeout(() => node.classList.remove('anim'), ANIM_MS + 40);
  }
  function focusWidget(spec: WSpec): void {
    if (focusId && focusId !== spec.id) unfocusWidget();
    let ref = els.get(spec.id);
    if (!ref) { paintAll(); ref = els.get(spec.id); }
    if (!ref) return;
    const scroll = { x: board.scrollLeft, y: board.scrollTop };
    const vw = board.clientWidth, vh = board.clientHeight;
    if (!focusPrev.has(spec.id)) focusPrev.set(spec.id, { x: spec.x, y: spec.y, w: spec.w, h: spec.h, min: spec.min });
    const w = Math.min(720, Math.max(420, vw - 220));
    const h = Math.min(560, Math.max(320, vh - 240));
    const x = snap(scroll.x + Math.max(24, (vw - w) / 2));
    const y = snap(scroll.y + Math.max(16, (vh - h) / 2 - 40));
    // 접혀 있었으면 먼저 펴야 높이가 생긴다(펴는 것 자체는 다시 그려야 한다).
    if (spec.min) { spec.min = false; sigs.delete(spec.id); paintAll(); ref = els.get(spec.id); if (!ref) return; }
    focusId = spec.id;
    spec.z = ++zTop;
    const scrim = ensureScrim();
    requestAnimationFrame(() => scrim.classList.add('on'));
    const root = ref.root;
    root.classList.add('focused');
    animate(root, () => {
      root.style.left = x + 'px'; root.style.top = y + 'px';
      root.style.width = w + 'px'; root.style.height = h + 'px';
      root.style.zIndex = String(spec.z);
    });
    // ⚠ spec 은 건드리지 않는다 — 저장되는 배치는 언제나 '원래 자리'다.
  }
  function unfocusWidget(spec?: WSpec): void {
    const id = spec ? spec.id : focusId;
    if (!id) return;
    const prev = focusPrev.get(id);
    const ref = els.get(id);
    focusId = null;
    if (scrimEl) { const sc = scrimEl; sc.classList.remove('on'); window.setTimeout(() => { if (!focusId) sc.remove(); }, ANIM_MS); }
    if (!prev) return;
    focusPrev.delete(id);
    if (!ref) return;
    ref.root.classList.remove('focused');
    animate(ref.root, () => {
      ref.root.style.left = prev.x + 'px'; ref.root.style.top = prev.y + 'px';
      ref.root.style.width = prev.w + 'px';
      ref.root.style.height = prev.min ? '' : prev.h + 'px';
    });
  }

  // ── 명령 → 창이 미리 나타난다('짠'): 새 일 = 도크 위 유령 창 · 기존 세션 = 그 카드 조준 · 리브 = 리브 단추 조준 ──
  const ghost = el('div', { class: 'stu-ghost', hidden: true },
    el('div', { class: 'stu-w-head' }, el('span', { class: 'stu-w-ic', style: 'color:#2D6BF0;background:#2D6BF01a' }, icon('chat', 'stu-i sm')), el('b', { class: 'stu-w-t', text: '새 세션' }), el('span', { class: 'stu-ghost-tag', text: '보내면 여기서 시작돼요' })),
    el('div', { class: 'stu-ghost-b' }, el('p', { class: 'stu-ghost-p' }), el('div', { class: 'stu-ghost-cur', 'aria-hidden': 'true' })));
  stage.append(ghost);
  function paintAim(): void {
    const text = input.value;
    const g = guessDest(text);
    const isNew = !!text.trim() && g.dest.kind === 'new';
    if (isNew) {
      const p = runPrefs();
      (ghost.querySelector('.stu-ghost-p') as HTMLElement).textContent = text.trim().replace(/\s+/g, ' ').slice(0, 140);
      (ghost.querySelector('.stu-ghost-tag') as HTMLElement).textContent = (p.harness && p.harness !== 'shell' ? p.harness : 'claude') + ' · 보내면 여기서 시작돼요';
    }
    if (ghost.hidden === isNew) ghost.hidden = !isNew;
    livToggle.classList.toggle('aim', !!text.trim() && g.dest.kind === 'liv');
    for (const spec of widgets) {
      if (spec.type !== 'session') continue;
      const ref = els.get(spec.id);
      ref?.root.classList.toggle('aim', g.dest.kind === 'session' && !!text.trim() && spec.data?.sid === g.dest.sid);
    }
  }
  function ghostBusy(on: boolean, prompt: string | null): void {
    ghost.classList.toggle('busy', on);
    if (on) { ghost.hidden = false; (ghost.querySelector('.stu-ghost-p') as HTMLElement).textContent = prompt ? prompt.replace(/\s+/g, ' ').slice(0, 140) : '빈 세션'; (ghost.querySelector('.stu-ghost-tag') as HTMLElement).textContent = '세션을 여는 중…'; }
    else ghost.hidden = true;
  }
  /** 유령 창의 판 좌표(스크롤 반영) — 진짜 카드가 그 자리에서 태어난다. */
  function ghostCanvasPos(): { x: number; y: number } | null {
    if (ghost.hidden) return null;
    const gr = ghost.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    return { x: Math.max(0, gr.left - cr.left), y: Math.max(0, gr.top - cr.top) };
  }

  // ── 끌어다 놓기: 런치패드 타일 · 타임라인 항목 · 바탕화면 아이콘 · **컴퓨터의 파일/폴더**(공유 폴더로 업로드) ──
  let lastDropAt: { x: number; y: number } | null = null;
  board.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
  board.addEventListener('drop', (e: DragEvent) => {
    const raw = e.dataTransfer?.getData('text/plain') || '';
    const r = canvas.getBoundingClientRect();
    const at = { x: e.clientX - r.left - 40, y: e.clientY - r.top - 16 };
    lastDropAt = at;
    if (raw.startsWith('stu:')) { e.preventDefault(); addWidget(raw.slice(4) as WType, at); return; }
    if (raw.startsWith('stu-desk:')) {
      e.preventDefault();
      try {
        const got = JSON.parse(raw.slice(9));
        const list: DeskItem[] = Array.isArray(got) ? got : [got];
        list.forEach((it, i) => openDeskItem(it, { x: at.x + i * 26, y: at.y + i * 22 }));
        clearSel();
      } catch (_) { /* noop */ }
      return;
    }
    if (raw.startsWith('tl:')) {
      e.preventDefault();
      try { const p = JSON.parse(raw.slice(3)); if (p && p.href) addWidget('doc', at, { hash: String(p.href), title: String(p.label || '문서') }); } catch (_) { /* noop */ }
    }
  });
  upDropZone(stage, stage, (items, emptyDirs) => { void uploadDropped(items, emptyDirs); });
  async function uploadDropped(items: UpItem[], emptyDirs: string[]): Promise<void> {
    if (!items.length && !emptyDirs.length) return;
    if (loose) { toast('이 판은 프로젝트 폴더가 없어 파일을 둘 곳이 없어요 — 세션을 프로젝트에 연결한 뒤 그 작업대에 올려 주세요.', true); return; }
    const at = lastDropAt;
    const ac = new AbortController();
    toast(items.length ? `${items.length}개를 공유 폴더로 올리는 중…` : '폴더를 만드는 중…');
    const r = await upSend({
      items, emptyDirs, signal: ac.signal,
      fileUrl: (rel) => '/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent(rel),
      dirUrl: (d) => '/api/ui/v6/projects/' + id + '/folder?path=' + encodeURIComponent(d),
    });
    if (dead) return;
    upToast(r);
    // 이미지·PDF 는 놓은 자리에 바로 뜬다(바탕화면에 사진을 던진 느낌) — 최대 3장, 나머지는 아이콘으로.
    items.filter((it) => /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(it.rel)).slice(0, 3).forEach((it, i) => {
      const w = addWidget('preview', at ? { x: at.x + i * 28, y: at.y + i * 22 } : undefined, { path: it.rel, name: it.rel });
      w.z = ++zTop; popIn(w);
    });
    lastSpawnTs = Date.now(); save();   // 자동 등장(autoSpawn)이 같은 파일을 한 번 더 올리지 않게
    for (const spec of widgets) if (spec.type === 'folder') { const ref = els.get(spec.id); if (ref) { sigs.delete(spec.id); fillBody(spec, ref.body, true); } }
    deskSig = ''; void paintDesk();
  }

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
      if (tick % 4 === 0) { void autoSpawn(); void paintDesk(); }
      if (loose) syncLooseCards(false);
      void pollStream();
      thinkTip();
    }, 8000);
  }

  // ── 시작 ──
  if (!load()) widgets = [];   // 첫 방문 = 빈 판(위젯 자동 배치 폐지, #1719 원준 2026-08-19)
  if (loose) syncLooseCards(true);   // 다만 자투리 판은 '그 세션들' 자체가 내용이다 — 카드로 전부 올린다
  paintDoor();
  paintAll();
  mountChat();
  paintDest();
  armLive();
  void autoSpawn();
  void paintDesk();
  void pollStream();
  window.setTimeout(() => thinkTip(), 1200);
  if (!detail) void refreshDetail();

  return {
    destroy() { dead = true; if (liveTimer) clearInterval(liveTimer); chat?.destroy(); chat = null; closePeek(); for (const u of blobUrls) URL.revokeObjectURL(u); document.removeEventListener('pointerdown', onDocDown); document.removeEventListener('keydown', onDocKey); },
    renderAside,
  };
}
