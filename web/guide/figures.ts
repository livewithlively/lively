// guide/figures.ts. 사용 가이드의 도식(#4179). 원고의 `{{fig:이름}}` 줄이 여기 그림 하나로 바뀐다.
//  흐름을 그린 세 장(loop · runtime · pipeline)은 서비스 소개서(2026-09, 3쪽 · 5쪽)의 도식을 화면 크기에 맞게 다시 그린 것이다.
//  색은 전부 토큰(52-guide.css)이라 다크 테마를 따라간다. 글자는 원고와 같은 화면 이름을 쓴다.
//  ⚠ 도식 라벨은 명사 한두 어절로 적고, 화살표에는 무엇이 넘어가는지를 적는다.
import { el, sv } from '../core.js';
import { guideIcon } from './icon.js';

function figure(name: string, caption: string, ...body: any[]): HTMLElement {
  return el('figure', { class: 'gd-fig gd-fig-' + name },
    el('div', { class: 'gd-fig-canvas' }, ...body),
    el('figcaption', { class: 'gd-fig-cap', text: caption }));
}

interface NodeOpts { t: string; s?: string; chips?: string[]; icon?: string; tone?: 'main' | 'dark' | 'soft' }
function nodeBox(o: NodeOpts): HTMLElement {
  return el('div', { class: 'gd-node' + (o.tone ? ' is-' + o.tone : '') },
    el('div', { class: 'gd-node-h' }, o.icon ? guideIcon(o.icon, 'gd-node-ic') : null, el('b', { text: o.t })),
    o.s ? el('p', { class: 'gd-node-s', text: o.s }) : null,
    o.chips && o.chips.length ? el('div', { class: 'gd-node-chips' }, ...o.chips.map((c) => el('span', { text: c }))) : null);
}
// 화살표 한 칸. 넓은 화면에서는 가로, 좁은 화면에서는 세로로 선다(CSS).
function flowLink(label: string, no?: number): HTMLElement {
  return el('div', { class: 'gd-link' },
    el('span', { class: 'gd-link-t' }, no ? el('i', { class: 'gd-no', text: String(no) }) : null, el('span', { text: label })),
    el('span', { class: 'gd-link-line', 'aria-hidden': 'true' }));
}

// ── 1. 맥락이 모이고 쓰이는 순서 ─────────────────────────────────────────────
function figLoop(): HTMLElement {
  return figure('loop', '라이블리가 자동으로 하는 세 가지 일입니다. 번호 순서대로 되풀이됩니다.',
    el('div', { class: 'gd-flow' },
      nodeBox({ t: '흩어진 자료', icon: 'apps', chips: ['메신저 대화', '이메일', '문서와 파일', '회의록', '이슈와 할 일'] }),
      flowLink('모아서 정리합니다', 1),
      nodeBox({ t: '맥락 저장소', icon: 'wiki', tone: 'main', s: '워크스페이스 하나에 저장소가 하나 있습니다.', chips: ['지식', '프로젝트', '자료'] }),
      flowLink('필요한 것만 넣습니다', 2),
      nodeBox({ t: 'AI 세션', icon: 'chat', s: '구성원 누구나 같은 맥락을 받고 시작합니다.' })),
    el('div', { class: 'gd-back' },
      el('span', { class: 'gd-back-line', 'aria-hidden': 'true' }),
      el('span', { class: 'gd-back-t' }, el('i', { class: 'gd-no is-mint', text: '3' }), el('span', { text: '세션이 만든 결과와 결정을 다시 저장합니다' }))));
}

// ── 2. 화면의 구역 ──────────────────────────────────────────────────────────
function bars(n: number, cls = ''): HTMLElement[] {
  const w = [86, 64, 78, 52, 70, 60, 82, 46];
  return Array.from({ length: n }, (_, i) => el('span', { class: 'gd-bar ' + cls, style: 'width:' + w[i % w.length] + '%' }));
}
function no(n: number): HTMLElement { return el('i', { class: 'gd-no gd-lay-no', text: String(n) }); }
function figLayout(): HTMLElement {
  const railIcons = ['home', 'chat', 'proj', 'wiki', 'liv'].map((k) => guideIcon(k, 'gd-lay-ic'));
  const recent = ['src', 'tags'].map((k) => guideIcon(k, 'gd-lay-ic is-dim'));
  return figure('layout', '넓은 화면 기준의 구조입니다. 번호는 아래 표의 번호와 같습니다.',
    el('div', { class: 'gd-lay', role: 'img', 'aria-label': '화면 구조. 맨 윗줄, 레일, 사이드바, 가운데 화면, 우측 사이드바' },
      el('div', { class: 'gd-lay-top' },
        no(1), guideIcon('panel', 'gd-lay-ic'), guideIcon('chevL', 'gd-lay-ic is-dim'), guideIcon('chevR', 'gd-lay-ic is-dim'),
        el('span', { class: 'gd-lay-search' }, guideIcon('search', 'gd-lay-ic'), el('span', { text: '검색' }))),
      el('div', { class: 'gd-lay-body' },
        el('div', { class: 'gd-lay-rail' }, no(2),
          el('span', { class: 'gd-lay-ws' }), ...railIcons, el('span', { class: 'gd-lay-sep' }), ...recent,
          el('span', { class: 'gd-lay-sp' }), guideIcon('apps', 'gd-lay-ic'), el('span', { class: 'gd-lay-me' })),
        el('div', { class: 'gd-lay-side' }, no(3),
          el('div', { class: 'gd-lay-card' }, ...bars(3)),
          el('div', { class: 'gd-lay-card' }, ...bars(2)),
          el('div', { class: 'gd-lay-card' }, ...bars(4)),
          el('div', { class: 'gd-lay-foot' }, guideIcon('archive', 'gd-lay-ic'), guideIcon('trash', 'gd-lay-ic'), guideIcon('link', 'gd-lay-ic'))),
        el('div', { class: 'gd-lay-center' }, no(4),
          el('div', { class: 'gd-lay-head' }, ...bars(1, 'is-strong')),
          el('div', { class: 'gd-lay-talk' }, ...bars(5)),
          el('div', { class: 'gd-lay-input' }, ...bars(1))),
        el('div', { class: 'gd-lay-aside' }, no(5),
          el('div', { class: 'gd-lay-tabs' }, el('span', { class: 'on' }), el('span'), el('span'), el('span')),
          el('div', { class: 'gd-lay-tiles' }, el('span'), el('span'), el('span'), el('span'))))));
}

// ── 3. 맥락을 이루는 것들의 관계(SVG) ────────────────────────────────────────
function box(x: number, y: number, w: number, h: number, title: string, sub: string, cls = ''): SVGElement {
  return sv('g', { class: 'gd-s-box ' + cls },
    sv('rect', { x, y, width: w, height: h, rx: 12 }),
    sv('text', { x: x + w / 2, y: y + (sub ? h / 2 - 4 : h / 2 + 5), class: 'gd-s-t', 'text-anchor': 'middle' }, title),
    sub ? sv('text', { x: x + w / 2, y: y + h / 2 + 16, class: 'gd-s-s', 'text-anchor': 'middle' }, sub) : null);
}
// 화살표. 머리는 선의 방향에서 직접 셈한다(마커를 쓰지 않아 색이 클래스를 그대로 따른다).
function arrow(pts: Array<[number, number]>, cls = ''): SVGElement {
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1), s = 8;
  const head = [[x2, y2], [x2 - s * Math.cos(a - 0.42), y2 - s * Math.sin(a - 0.42)], [x2 - s * Math.cos(a + 0.42), y2 - s * Math.sin(a + 0.42)]]
    .map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  return sv('g', { class: 'gd-s-ar ' + cls }, sv('path', { d }), sv('polygon', { points: head }));
}
function label(x: number, y: number, text: string, cls = ''): SVGElement {
  const w = text.length * 12.2 + 16;
  return sv('g', { class: 'gd-s-lab ' + cls },
    sv('rect', { x: x - w / 2, y: y - 11, width: w, height: 22, rx: 11 }),
    sv('text', { x, y: y + 4.5, 'text-anchor': 'middle' }, text));
}
function figEntities(): HTMLElement {
  const svg = sv('svg', { class: 'gd-svg', viewBox: '0 0 760 340', role: 'img', 'aria-label': '자료, 지식, AI 세션, 프로젝트, 태스크, 분류의 관계' },
    // 윗줄: 자료 → 지식 → 세션
    arrow([[170, 80], [298, 80]]), label(234, 80, '증류'),
    arrow([[460, 66], [588, 66]]), label(524, 66, '세션에 전달'),
    arrow([[588, 96], [462, 96]], 'is-mint'), label(524, 96, '결과를 저장', 'is-mint'),
    // 지식 ↔ 프로젝트
    arrow([[352, 114], [352, 218]]), label(352, 166, '필요 지식'),
    arrow([[418, 218], [418, 116]], 'is-mint'), label(430, 196, '산출 지식', 'is-mint'),
    // 프로젝트(태스크) → 세션
    arrow([[480, 268], [665, 268], [665, 116]]), label(600, 268, '태스크 하나에 세션 하나'),
    // 분류 → 지식, 프로젝트
    arrow([[170, 250], [298, 250]], 'is-dash'), arrow([[95, 218], [95, 170], [320, 170], [320, 116]], 'is-dash'), label(190, 170, '분류가 붙습니다', 'is-plain'),
    box(20, 48, 150, 64, '자료', '외부 앱과 파일의 원문'),
    box(300, 48, 160, 64, '지식', '위키에 남는 문서', 'is-main'),
    box(590, 48, 150, 64, 'AI 세션', 'AI와 일하는 한 자리'),
    sv('g', { class: 'gd-s-box is-proj' }, sv('rect', { x: 300, y: 220, width: 180, height: 96, rx: 12 })),
    sv('text', { x: 390, y: 246, class: 'gd-s-t', 'text-anchor': 'middle' }, '프로젝트'),
    sv('g', { class: 'gd-s-chip' },
      sv('rect', { x: 316, y: 262, width: 70, height: 26, rx: 8 }), sv('text', { x: 351, y: 279, 'text-anchor': 'middle' }, '태스크'),
      sv('rect', { x: 394, y: 262, width: 70, height: 26, rx: 8 }), sv('text', { x: 429, y: 279, 'text-anchor': 'middle' }, '태스크')),
    sv('text', { x: 390, y: 306, class: 'gd-s-s', 'text-anchor': 'middle' }, '하려는 일과 그 기록'),
    box(20, 218, 150, 64, '분류', '주제별로 나누는 기준'));
  return figure('entities', '파란 선은 맥락이 읽히는 방향이고, 초록 선은 새로 쓰이는 방향입니다.', el('div', { class: 'gd-svgwrap' }, svg));
}

// ── 4. 세션이 실행되는 컴퓨터 ────────────────────────────────────────────────
function figRuntime(): HTMLElement {
  return figure('runtime', '세션은 내 화면이 아니라 고른 컴퓨터에서 실행됩니다. 그래서 화면을 닫아도 세션이 멈추지 않습니다.',
    el('div', { class: 'gd-rt' },
      nodeBox({ t: '내 화면', icon: 'web', s: '브라우저, 데스크톱 앱, 폰 어디서든 같은 세션을 봅니다.' }),
      el('div', { class: 'gd-rt-links' }, flowLink('지시를 보냅니다'), el('div', { class: 'gd-link is-back' },
        el('span', { class: 'gd-link-t' }, el('span', { text: '진행 화면을 받습니다' })), el('span', { class: 'gd-link-line', 'aria-hidden': 'true' }))),
      el('div', { class: 'gd-rt-where' },
        nodeBox({ t: '중앙 컴퓨터', icon: 'layers', tone: 'main', s: '라이블리가 운영합니다. 설치 없이 씁니다.', chips: ['세션마다 분리된 실행 공간', '워크스페이스 파일을 함께 사용'] }),
        nodeBox({ t: '내 컴퓨터', icon: 'term', s: '연결해 둔 내 PC에서 실행합니다.', chips: ['내 PC의 파일과 프로그램 사용', 'PC가 꺼지면 오프라인'] }))));
}

// ── 5. 자료가 지식이 되는 순서 ───────────────────────────────────────────────
function machine(title: string, sub: string): HTMLElement {
  return el('div', { class: 'gd-pl-m' }, guideIcon('gear', 'gd-pl-mic'), el('b', { text: title }), el('span', { text: sub }));
}
function place(icon: string, title: string, sub: string): HTMLElement {
  return el('div', { class: 'gd-pl-p' }, el('div', { class: 'gd-node-h' }, guideIcon(icon, 'gd-node-ic'), el('b', { text: title })), el('p', { class: 'gd-node-s', text: sub }));
}
function figPipeline(): HTMLElement {
  return figure('pipeline', '흰 칸은 맥락이 머무는 곳이고, 어두운 칸은 그 사이에서 자동으로 실행되는 기능입니다.',
    el('div', { class: 'gd-pl' },
      place('apps', '외부 앱', '슬랙, 노션, 메일처럼 자료가 생기는 곳입니다.'),
      machine('수집기', '원문을 가져옵니다'),
      place('src', '자료', '가져온 원문을 그대로 둡니다.'),
      machine('증류기', '지식으로 만듭니다'),
      place('wiki', '지식', '분류에 맞춰 위키에 저장합니다.'),
      machine('주입 규칙', '세션에 넣습니다'),
      place('chat', 'AI 세션', '시작할 때 읽고, 일하는 중에 검색합니다.')));
}

// ── 6. 프로젝트 · 태스크 · 세션 ──────────────────────────────────────────────
function stRow(task: string, state: string, stateCls: string, sess: string, sessCls: string): HTMLElement {
  return el('div', { class: 'gd-st-row' },
    el('span', { class: 'gd-st-task' }, el('i', { class: 'gd-st-dot ' + stateCls, 'aria-hidden': 'true' }), el('span', { text: task })),
    el('span', { class: 'gd-st-state ' + stateCls, text: state }),
    el('span', { class: 'gd-st-line', 'aria-hidden': 'true' }),
    el('span', { class: 'gd-st-sess ' + sessCls }, guideIcon('chat', 'gd-st-ic'), el('span', { text: sess })));
}
function figSessionTask(): HTMLElement {
  return figure('session-task', '예시입니다. 태스크마다 세션이 하나씩 붙고, 세션이 없는 태스크는 세션을 열 때 붙습니다.',
    el('div', { class: 'gd-st' },
      el('div', { class: 'gd-st-h' }, guideIcon('folder', 'gd-node-ic'), el('b', { text: '프로젝트: 가을 메뉴 출시' })),
      el('div', { class: 'gd-st-cols' }, el('span', { text: '태스크' }), el('span', { text: '태스크 상태' }), el('span'), el('span', { text: '맡은 세션' })),
      stRow('메뉴 가격표 정리', '완료', 'is-done', '가격표 정리', 'is-done'),
      stRow('매장 안내문 작성', '진행 중', 'is-doing', '안내문 작성', 'is-doing'),
      stRow('출시 공지 초안', '시작 전', 'is-todo', '아직 없음', 'is-none')));
}

// ── 7. 치운 것이 가는 곳 ─────────────────────────────────────────────────────
function binStep(icon: string, title: string, tone = ''): HTMLElement {
  return el('div', { class: 'gd-bin' + (tone ? ' ' + tone : '') }, guideIcon(icon, 'gd-node-ic'), el('b', { text: title }));
}
function binLink(go: string, back: string): HTMLElement {
  return el('div', { class: 'gd-binlink' },
    el('span', { class: 'gd-binlink-go' }, el('span', { text: go }), el('span', { class: 'gd-link-line', 'aria-hidden': 'true' })),
    back ? el('span', { class: 'gd-binlink-back' }, el('span', { class: 'gd-link-line', 'aria-hidden': 'true' }), el('span', { text: back })) : null);
}
function figBins(): HTMLElement {
  return figure('bins', '위 글자는 치우는 동작이고, 아래 글자는 되돌리는 동작입니다. 휴지통에서 완전히 지우기 전까지는 되돌릴 수 있습니다.',
    el('div', { class: 'gd-bins' },
      binStep('home', '홈 목록'),
      binLink('목록에서 치우기', '홈 목록으로'),
      binStep('archive', '지난 세션'),
      binLink('휴지통으로 보내기', '되돌리기'),
      binStep('trash', '휴지통'),
      binLink('완전 삭제', ''),
      binStep('x', '삭제됨', 'is-end')));
}

const FIGS: Record<string, () => HTMLElement> = {
  loop: figLoop,
  layout: figLayout,
  entities: figEntities,
  runtime: figRuntime,
  pipeline: figPipeline,
  'session-task': figSessionTask,
  bins: figBins,
};

/** 이름으로 도식 하나를 그린다. 모르는 이름이면 아무것도 그리지 않는다. */
export function guideFigure(name: string): HTMLElement | null {
  const f = FIGS[name];
  return f ? f() : null;
}
/** 원고가 부를 수 있는 도식 이름(시험이 원고와 대조한다). */
export const GUIDE_FIGURES: readonly string[] = Object.keys(FIGS);
