// v2/app-review.ts — 앱빌더 「③ 시안 확인 · 고치기」 의 **진짜 화면 위 코멘트 층**(#4632, 원준 2026-10-14 «대충 구현한 앱 화면이랑 세션 위젯을 보여주지 말고
//  … 실제로 이게 들어간 라이블리 화면에서 활용되는 진짜 리얼 뷰 · 사이드바 그대로 있고, 대신 그 위에 코멘트 남기는 거만 기능으로»).
//
//  앱빌더(app-studio.ts ③)가 가운데 단추로 보낸다 — 세션 위젯 = **시험 세션**(app-try-session.ts — 앱을 만드는 세션과 다른 진짜 AI 세션의 진짜 화면, 우측 사이드바에 앱 ·
//   앱을 만드는 세션은 들이지 않는다 · 원준 2026-10-15), 앱 화면 = 앱 찾기에서 연 것과 같은 #/i/<앱>(셸이 평소대로 그린다). 이 층이 그 위에 뜬다:
//   · 막대 — 「‹ 앱빌더」 · 앱 이름 · 버전 · 도구(써 보기 · 선택 · 핀 · 영역) · 「의견 n건」 · 「수정하기」 · 「완료 · 다음 단계로」.
//     자리(dock)를 주면 그 안에 들어앉고(시험 세션의 문패 줄 위 — 세션의 입력칸을 가리지 않게), 없으면 아래 가운데 떠 있다(↑ 로 위로).
//   · 「AI에게 말하기」 칸 — 누르면 막대에 맞붙은 대화 칸이 올라오고, 그 안에 이 앱을 만드는 AI 세션 화면(앱빌더의 「AI 세션」)이 선다.
//     거기서 묻고 정하며 고친다(원준 2026-10-28). AI 가 저장한 새 버전은 부르는 쪽의 'updated' 경로가 앱 화면에 띄운다.
//   · 핀 · 상자 · 그 자리 의견 칸 — 그 앱의 프레임(iframe.v2-appui-frame[data-app-id], app-ui.ts) 자리를 따라 fixed 로 뜬다.
//     화면 구조를 모른다 — 곁칸이든 화면 가득이든 프레임이 보이는 곳이면 거기에 선다. 프레임이 안 보이면 막대가 그 말을 한다.
//   · 고르기 · 핀은 프레임 안 탐침(PROBE_JS)에게 그 자리의 요소(태그 · 글 · 테두리)를 묻는다 — app-ui 가 검토 중인 앱(markReviewProbe)의 문서에만 넣는다.
//  상태(짚은 곳 · 앱 전체 의견 · 판 · 기다림)는 부르는 쪽(앱빌더 만들기 화면)이 쥔다 — 이 층은 보여 주고 받아 적고(onChange) 단추를 전할 뿐(onSend · onLike · onBack).
//  떠나면(다른 주소로 · 「‹ 앱빌더」 · 부르는 쪽이 close) 층과 막대를 걷는다. 한 번에 하나만 뜬다.
import { el } from '../core.js';
import { ensureReviewProbe, markReviewProbe } from './app-ui.js';
import { fitGrow, growText } from './grow-text.js';
import { readHitRes, unsent, verName, whereText, type HitRes, type StudioPin } from '../lib/studio-flow.js';

export type ReviewTool = 'try' | 'pick' | 'pin' | 'box';
export interface ReviewHost {
  appId: string; title: string;
  /** 보낼 실제 화면의 주소 — #/i/<앱>(앱 화면) · 시험 세션은 지금 주소(앱빌더). 이 주소를 벗어나면 층을 걷는다. */
  route: string;
  /** 막대가 들어앉을 자리(시험 세션의 문패 줄 위) — 없으면 화면 아래 가운데 떠 있다. */
  dock?: HTMLElement;
  pins: StudioPin[]; general: string;   // 부르는 쪽의 것 **그대로**(같은 배열 · 값) — 이 층이 더하고 지우고 고친 뒤 onChange 로 알린다
  version: number; waiting: boolean;
  /** 고침을 보낸 시각(ms) — 막대 시계가 앱빌더 띠와 같은 시계로 이어서 센다(점검 3-10). 없으면 막대를 연 때부터. */
  waitSince?: number;
  /** 기다리던 AI 일이 멈췄다 — 막대가 시계 대신 그 까닭을 말하고, resume 이면 「수정하기」 자리가 「이어서 수정하기」(onResume)가 된다.
   *  ask = AI 가 확인을 기다린다 — 답할 곳은 막대의 「AI에게 말하기」 다(점검 3-7 · 그 단추가 대화 칸을 연다). */
  stall?: ReviewStall | null;
  onResume?: () => void;
  /** 이 앱을 만드는 AI 세션 화면(앱빌더의 「AI 세션」 칸) — 「AI에게 말하기」 칸을 처음 열 때 대화 칸으로 옮겨 오고, 층이 걷히면 제자리로 돌려놓는다. */
  chat: HTMLElement;
  /** 막대 칸에 쓴 말을 그 AI 세션에 보낸다 — 보내졌으면 true(칸을 비운다). */
  onTalk: (text: string) => Promise<boolean>;
  onChange: (p: { pins: StudioPin[]; general: string }) => void;
  onSend: () => void; onLike: () => void; onBack: () => void;
  /** 층이 걷혔다(다른 데로 갔다 · close) — 부르는 쪽이 손잡이를 놓는다. */
  onClose?: () => void;
}
export interface ReviewStall { text: string; resume: boolean; ask?: boolean }
export interface ReviewApi {
  /** 판 · 기다림 · 이름 · 의견이 바뀌었다(새 판이 왔다 · 보냈다 · 앱빌더 쪽에서 고쳤다). note 를 주면 막대에 잠깐 띄운다(«2판 · 고쳤어요»). */
  update(p: { version?: number; waiting?: boolean; waitSince?: number; stall?: ReviewStall | null; title?: string; note?: string; pins?: StudioPin[]; general?: string }): void;
  close(): void;
  isOpen(): boolean;
}
//  도구 그림은 이모지가 아니라 선 그림(원준 2026-10-15 «이모지 짜침 · 너가 아이콘 그려 · 써 보기와 맞는 걸로») — 20칸 격자 · 글자색을 따른다.
//   원준 2026-10-16 «고르기 아이콘이 영역 아이콘 같아 · 영역으로 보내고 · 써 보기에 있는 걸 고르기로 · 써 보기는 새로» —
//   써 보기 = 누르는 손가락과 눌림 표시 · 선택(옛 고르기) = 누르는 화살표와 눌린 물결 · 핀 = 핀 · 영역 = 점선 상자(묶음 #7 «영역은 점선 박스로»).
const TOOL_SVG: Record<ReviewTool, string> = {
  try: '<path d="M8.2 12.6V5.4a1.3 1.3 0 0 1 2.6 0v3.8"/><path d="M10.8 9.2v-.6a1.3 1.3 0 0 1 2.6 0v1"/><path d="M13.4 9.6a1.3 1.3 0 0 1 2.6 0v2.8a5.2 5.2 0 0 1-5.2 5.2H10a4.6 4.6 0 0 1-3.6-1.7l-2.5-3.1a1.25 1.25 0 0 1 1.9-1.6l2.4 2.4"/><path d="M5.4 3.4 6.6 4.2M9.5 1v1.3M13.6 3.4l-1.2.8"/>',
  pick: '<path d="M7.5 6.5 16.5 11l-4.2 1.1-2 4.2z"/><path d="M3.6 8.2a4.6 4.6 0 0 1 3.1-4.3"/><path d="M3.2 4.6 4.6 5.8"/>',
  pin: '<path d="M10 17.5s-5-5-5-8.8a5 5 0 0 1 10 0c0 3.8-5 8.8-5 8.8z"/><circle cx="10" cy="8.6" r="1.8"/>',
  box: '<rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2" stroke-dasharray="3 2.2"/>',
};
function toolIcon(k: ReviewTool): HTMLElement {
  const s = el('span', { class: 'ico', 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + TOOL_SVG[k] + '</svg>';   // 셸 코드의 고정 글(앱이 주는 것이 아니다)
  return s;
}
const TOOLS: Array<{ k: ReviewTool; t: string; help: string }> = [
  { k: 'try', t: '써 보기', help: '직접 써 보면서 앱의 실제 동작을 확인해요.' },
  { k: 'pick', t: '선택', help: '앱 안의 버튼 · 칸 · 글을 선택해요' },
  { k: 'pin', t: '핀', help: '누른 자리에 핀을 꽂고 코멘트를 적어요.' },
  { k: 'box', t: '영역', help: '끌어서 상자를 그리면 그 영역 전체에 코멘트를 적어요.' },
];
let cur: ReviewApi | null = null;
export function reviewOpen(): boolean { return !!cur && cur.isOpen(); }
export function closeReview(): void { if (cur) { const c = cur; cur = null; c.close(); } }

export function openReview(host: ReviewHost): ReviewApi {
  closeReview();
  const routeBase = host.route.split('?')[0];
  const S = { tool: 'pick' as ReviewTool, active: -1, hoverAt: 0, hitSeq: 1, hitWaits: {} as Record<number, (h: HitRes | null) => void>, frame: null as HTMLIFrameElement | null, dead: false, tick: 0, noteT: 0,
    waitT0: host.waitSince || Date.now(), waitTick: 0, top: false, talkBusy: false,
    sx: 0, sy: 0 };   // 앱 문서의 지금 스크롤(px · 탐침이 알린다) — 번호는 짚을 때의 스크롤(p.sx · p.sy)과의 차이만큼 옮겨 그린다(점검 3-3)
  markReviewProbe(host.appId, true);
  ensureReviewProbe(host.appId);   // 검토하지 않는 동안 새 판으로 다시 뜬 프레임에는 탐침이 없다 — 그것만 다시 띄운다(점검 3-1)

  // ── 막대 ──
  const bar = el('div', { class: 'v2-review-bar', role: 'toolbar', 'aria-label': '시안 코멘트' });
  const name = el('b', { text: '「' + host.title + '」' });
  const ver = el('span', { class: 'v2-review-ver', text: verName(host.version) });
  const tools = el('span', { class: 'v2-studio-tools v2-review-tools', role: 'tablist', 'aria-label': '코멘트 다는 도구' });
  const count = el('button', { class: 'btn btn-ghost btn-sm v2-review-count', type: 'button' }) as HTMLButtonElement;
  const send = el('button', { class: 'v2-studio-now-pri', type: 'button' }) as HTMLButtonElement;
  const like = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '완료 · 다음 단계로', title: '고칠 곳이 없으면 다음 단계로', onclick: () => host.onLike() }) as HTMLButtonElement;
  const hint = el('small', { class: 'v2-review-hint' });
  //  지금 보는 화면이 어느 꼴인지(원준 2026-10-16 «지금 보고 있는 창이 앱 전체 창인지 위젯 창인지만 구분해서 알려 주고») — 막대가 문패 줄에 얹혔으면 시험 세션의 세션 위젯.
  const mode = el('span', { class: 'v2-review-mode' + (host.dock ? ' widget' : ' app'), text: host.dock ? '세션 위젯으로 보는 중' : '앱 화면으로 보는 중',
    title: host.dock ? '시험 세션의 우측 사이드바에 붙은 모습이에요' : '실제 앱의 사용 화면과 동일한 화면이에요' });
  //  「AI에게 말하기」(원준 2026-10-28 «앱 전체에 코멘트하는 텍스트박스를 누르면 아래에서 위로 올라오게 · AI와 대화하면서 물어보고 지정하고 수정»).
  //   옛 «앱 전체 코멘트» 칸(원준 2026-10-16 «바로바로 텍스트 쳐서»)의 자리다 — 묶어 보내는 앱 전체 코멘트는 「코멘트 n건」 칸의 「앱 전체」 줄에 그대로 있다.
  //   글이 길면 세로로 늘어난다(원준 2026-10-28 «한 줄로 고정 · 너무 불편») — Enter 보내기 · Shift+Enter 줄바꿈.
  const gen = growText({ class: 'v2-review-gen', placeholder: 'AI에게 말하기 · 예: 글자 조금 크게', label: 'AI에게 말하기', title: '이 앱을 만드는 AI와 대화하며 수정해요 · Shift+Enter 줄바꿈', max: host.dock ? 2 : 4,   // 세션 위젯 꼴은 문패 줄에 얹혀 있어 두 줄까지
    onEnter: () => { void say(); }, onEscape: () => { closeTalk(); gen.blur(); } });
  gen.addEventListener('focus', () => openTalk());
  const note = el('span', { class: 'v2-review-note', hidden: true });
  const flip = el('button', { class: 'btn btn-ghost btn-sm v2-review-flip', type: 'button', text: '↑', title: '막대를 위나 아래로 옮겨요', 'aria-label': '막대 자리 바꾸기', onclick: () => { S.top = !S.top; bar.classList.toggle('v2-review-bar--top', S.top); flip.textContent = S.top ? '↓' : '↑'; } });
  bar.append(
    el('button', { class: 'btn btn-ghost btn-sm v2-review-back', type: 'button', text: '‹ 앱빌더', title: '앱빌더로 돌아가요. 적은 코멘트는 그대로 남아요.', onclick: () => host.onBack() }),
    el('span', { class: 'v2-review-name' }, name, ver), mode, el('i', { class: 'v2-review-sep' }),
    tools, count, gen, el('span', { class: 'v2-studio-sp' }), note, like, send, flip,
    hint);
  // ── 층 — 프레임 자리를 따라간다 ──
  const layer = el('div', { class: 'v2-review-layer', hidden: true });
  const ov = el('div', { class: 'v2-studio-overlay v2-review-ov' });
  layer.append(ov);
  //  자리(dock)에 얹히면 한 줄로 — 도움말은 막대 가운데(의견 n건 뒤)에서 남는 폭을 쓰고 넘치면 말줄임(문패 줄 높이를 넘지 않게).
  if (host.dock) { bar.classList.add('v2-review-bar--dock'); flip.hidden = true; count.after(hint); host.dock.append(bar); document.body.append(layer); }
  else document.body.append(layer, bar);

  const cmCount = (): number => host.pins.filter((p) => unsent(p) && p.note.trim()).length + (host.general.trim() ? 1 : 0);   // 보내서 반영 중인 것은 세지 않는다
  const changed = (): void => { host.onChange({ pins: host.pins, general: host.general }); paintBar(); };
  const paintBar = (): void => {
    const n = cmCount();
    tools.replaceChildren(...TOOLS.map((x) => { const b = el('button', { type: 'button', role: 'tab', class: x.k === S.tool ? 'on' : '', 'aria-selected': x.k === S.tool ? 'true' : 'false', title: x.t + '\n' + x.help, onclick: () => setTool(x.k) }, toolIcon(x.k), el('span', { text: x.t })) as HTMLButtonElement; return b; }));   // 고치는 중에도 짚는다 — 다음 「수정하기」 몫(원준 2026-10-28)
    const blank = host.pins.filter((p) => !p.note.trim()).length;
    count.textContent = '코멘트 ' + n + '건' + (blank ? ' · 빈 코멘트 ' + blank : '');
    count.title = '적은 코멘트 · 앱 전체 코멘트';
    send.textContent = host.waiting ? 'AI 수정 중…' : '수정하기' + (n ? ' · ' + n + '건' : '');
    send.disabled = host.waiting || n === 0; like.disabled = host.waiting;
    gen.disabled = S.talkBusy;   // 고치는 중에도 말한다 — AI 세션이 받아 두었다가 이어서 한다(원준 2026-10-28 «다 적용될 때까지 비활성화 · 해결해야»)
    ver.textContent = verName(host.version);
    const t = TOOLS.find((x) => x.k === S.tool) || TOOLS[1];
    hint.textContent = host.waiting ? 'AI가 수정하고 있어요. 그동안 다음 코멘트를 남겨 둘 수 있어요.' : !S.frame ? (host.dock ? '앱을 여는 중이에요. 시안을 보고 수정할 내용을 알려주세요.' : '앱이 아직 안 보여요. 앱 화면이 뜨면 코멘트를 남길 수 있어요.') : t.help;
    if (host.waiting && host.stall) {   // 멈췄다 — «AI 수정 중 m:ss» 를 세지 않고 앱빌더 막대와 같은 말 · 같은 단추
      send.textContent = '이어서 수정하기'; send.disabled = !host.stall.resume || !host.onResume; hint.textContent = host.stall.text;
      //  AI 가 확인을 기다린다 — 이 막대엔 「AI 세션 보기」 가 없다. 답할 곳은 「AI에게 말하기」(그 대화 칸에 그 AI 세션이 선다 · 점검 3-7).
      if (host.stall.ask) { send.textContent = 'AI에게 답하기'; send.disabled = false; hint.textContent = 'AI가 확인을 기다리고 있어요. 「AI에게 말하기」를 눌러 답해 주세요.'; }
    }
    layer.hidden = !S.frame;   // 고치는 중에도 짚는다(원준 2026-10-28)
    layer.dataset.tool = S.tool;   // 써 보기면 번호 · 상자가 흐리고 눌리지 않는다(앱의 단추를 가리지 않게 · 점검 3-9)
    ov.dataset.tool = S.tool; ov.hidden = S.tool === 'try';
    paintTrayBits();   // 열린 코멘트 목록의 머리 · 「수정하기」 도 같은 셈으로
  };
  const setTool = (k: ReviewTool): void => { S.tool = k; closePop(); closeTalk(); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); paintBar(); paintMarks(); };
  count.onclick = () => toggleTray();
  send.onclick = () => {
    if (host.waiting && host.stall) {
      if (host.stall.ask) { openTalk(); gen.focus(); return; }   // 대화 칸을 열고 막대 칸에 바로 쓴다
      if (host.stall.resume && host.onResume) host.onResume();
      return;
    }
    if (cmCount()) host.onSend();
  };

  // ── 프레임 찾기 · 따라가기 ──
  const frameWin = (): Window | null => (S.frame && S.frame.contentWindow) || null;
  //  이 층이 띄운 것(막대 · 앱 위 층 · 코멘트 목록 · 대화 칸)은 앱을 가린 것으로 치지 않는다 — 막대를 위로 옮기거나(↑) 대화 칸을 크게 열면
  //   그것이 앱 위쪽 가운데 점을 덮어, 앱이 가려졌다고 보고 번호를 다 숨겼다(점검 3-2).
  const ours = (n: Element): boolean => layer.contains(n) || bar.contains(n) || talk.contains(n) || (!!tray && tray.contains(n));
  const findFrame = (): HTMLIFrameElement | null => {
    let best: HTMLIFrameElement | null = null, area = 0;
    document.querySelectorAll('iframe.v2-appui-frame[data-app-id="' + CSS.escape(host.appId) + '"]').forEach((n) => {
      const f = n as HTMLIFrameElement; const r = f.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || !f.getClientRects().length) return;
      //  떠 있는 창(다른 화면의 덮개) 속이 아닌, 지금 화면에 보이는 것 — 위쪽 가운데 점에서 우리 것을 걷어 낸 맨 위가 그 프레임인가
      const at = document.elementsFromPoint(r.left + r.width / 2, Math.min(r.top + 24, r.bottom - 1));
      const top = at.find((x) => !ours(x));
      if (top && top !== f && !f.contains(top)) return;
      if (r.width * r.height > area) { best = f; area = r.width * r.height; }
    });
    return best;
  };
  const follow = (): void => {
    if (S.dead) return;
    if (!location.hash.startsWith(routeBase)) { api.close(); return; }   // 다른 데로 갔다 — 층을 걷는다(적은 것은 이미 부르는 쪽에 있다)
    const f = findFrame();
    if (f !== S.frame) {
      S.frame = f; S.sx = 0; S.sy = 0;   // 다른 문서 — 스크롤은 그 탐침이 알릴 때까지 맨 위로 본다
      if (f && f.getAttribute('data-probe') !== '1') ensureReviewProbe(host.appId);   // 막대를 연 뒤에 나타난 옛 프레임(탐침 없이 뜬 것)
      closePop(); paintBar(); paintMarks();
    }
    if (f) { const r = f.getBoundingClientRect(); layer.style.left = r.left + 'px'; layer.style.top = r.top + 'px'; layer.style.width = r.width + 'px'; layer.style.height = r.height + 'px'; }
  };
  S.tick = window.setInterval(follow, 250);
  const onScroll = (): void => { follow(); if (talk.classList.contains('on')) placeTalk(); };
  window.addEventListener('resize', onScroll); document.addEventListener('scroll', onScroll, true);

  // ── 짚기 — 앱 위 투명한 층(도구마다 하는 일이 다르다: 고르기 = 요소 · 핀 = 점 · 영역 = 끌어 그린 상자) ──
  const askHit = async (x: number, y: number): Promise<HitRes | null> => {
    const w = frameWin(); if (!w) return null;
    const id = S.hitSeq++;
    return new Promise((res) => { S.hitWaits[id] = res; w.postMessage({ __studio: 'hit', id, x, y }, '*'); setTimeout(() => { if (S.hitWaits[id]) { delete S.hitWaits[id]; res(null); } }, 700); });
  };
  const ratio = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = layer.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))), y: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))) };
  };
  //  코멘트 목록이 열려 있으면 그 끝에 한 줄을 더해 그 칸에 바로 쓴다(목록은 닫지 않는다 — 원준 2026-10-28 «여러 개 코멘트 넘기기도 어렵고»).
  //   닫혀 있으면 짚은 곳 옆에 그 자리 칸이 뜬다. 도구는 그대로라 이어서 다음 곳을 짚는다.
  const addItem = (p: StudioPin): void => { host.pins.push(p); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); changed(); paintMarks(); if (tray) openTray(host.pins.length - 1); else openPop(host.pins.length - 1); };
  let drag: { x: number; y: number; box: HTMLElement } | null = null; let skip = false;
  ov.addEventListener('pointermove', (e: PointerEvent) => {
    if (S.tool === 'pick' && Date.now() - S.hoverAt > 70) { S.hoverAt = Date.now(); const w = frameWin(); const q = ratio(e); if (w) w.postMessage({ __studio: 'hit', id: 0, x: q.x, y: q.y }, '*'); }
    if (S.tool === 'box' && drag) {
      const q = ratio(e); const l = Math.min(q.x, drag.x), t = Math.min(q.y, drag.y);
      Object.assign(drag.box.style, { left: l * 100 + '%', top: t * 100 + '%', width: Math.abs(q.x - drag.x) * 100 + '%', height: Math.abs(q.y - drag.y) * 100 + '%' });
    }
  });
  ov.addEventListener('pointerleave', () => { if (S.tool === 'pick') { const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); } });
  ov.addEventListener('pointerdown', (e: PointerEvent) => {
    if (pop) { closePop(); skip = true; return; }   // 열린 의견 칸 밖을 누르면 먼저 닫기만 한다
    if (S.tool !== 'box') return;
    const q = ratio(e); const box = el('div', { class: 'v2-studio-mk v2-studio-mk-box draft' }); layer.append(box); drag = { x: q.x, y: q.y, box }; ov.setPointerCapture(e.pointerId);
  });
  //  짚은 곳에는 그때의 스크롤을 남긴다 — 번호가 문서 자리를 따라가고(paintMarks) AI 에게도 그 화면 기준이라고 말한다(fixBrief · 점검 3-3).
  const scrollAt = (hit: HitRes | null): { sx: number; sy: number } => (hit ? { sx: hit.sx, sy: hit.sy } : { sx: S.sx, sy: S.sy });
  ov.addEventListener('click', async (e: MouseEvent) => {
    if (skip) { skip = false; return; }
    if (S.tool !== 'pick' && S.tool !== 'pin') return;
    const q = ratio(e); const hit = await askHit(q.x, q.y);
    if (S.tool === 'pick' && hit && hit.rect) addItem({ kind: 'pick', x: hit.rect.l, y: hit.rect.t, w: hit.rect.w, h: hit.rect.h, where: whereText(hit), note: '', ...scrollAt(hit) });
    else addItem({ kind: 'pin', x: q.x, y: q.y, where: whereText(hit), note: '', ...scrollAt(hit) });
  });
  ov.addEventListener('pointerup', async (e: PointerEvent) => {
    if (S.tool !== 'box' || !drag) return;
    const q = ratio(e); const d = drag; drag = null; d.box.remove();
    const l = Math.min(q.x, d.x), t = Math.min(q.y, d.y), w = Math.abs(q.x - d.x), hh = Math.abs(q.y - d.y);
    if (w < 0.02 || hh < 0.02) return;   // 너무 작은 상자는 실수로 본다
    const s0 = { sx: S.sx, sy: S.sy };   // 상자는 그린 화면 기준 — 답을 기다리는 사이 스크롤돼도 그린 때의 것
    const hit = await askHit(l + w / 2, t + hh / 2);
    addItem({ kind: 'box', x: l, y: t, w, h: hh, where: whereText(hit), note: '', ...s0 });
  });
  //  도구를 쓰는 중에도 휠은 앱으로 — 덮개가 받아 탐침에게 넘기고, 탐침이 그 자리의 스크롤되는 칸(없으면 문서)을 내린다(점검 3-3).
  ov.addEventListener('wheel', (e: WheelEvent) => {
    const w = frameWin(); if (!w) return;
    e.preventDefault();
    const q = ratio(e), r = layer.getBoundingClientRect();
    const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, r.height) : 1;
    w.postMessage({ __studio: 'wheel', x: q.x, y: q.y, dx: e.deltaX * f, dy: e.deltaY * f }, '*');
  }, { passive: false });
  //  위치 답(hitres)은 보드와 같은 거르기(readHitRes · 점검 3-13) · 스크롤 알림(scroll)은 번호를 옮겨 그린다. 이 프레임에서 온 것만.
  const onMsg = (ev: MessageEvent): void => {
    if (!ev.source || ev.source !== frameWin()) return;
    const m: any = ev.data;
    if (m && typeof m === 'object' && m.__studio === 'scroll') {
      const sx = Number(m.sx), sy = Number(m.sy);
      if (Number.isFinite(sx) && Number.isFinite(sy) && (sx !== S.sx || sy !== S.sy)) { S.sx = sx; S.sy = sy; paintMarks(); placePop(); }
      return;
    }
    const h = readHitRes(m); if (!h) return;
    const w = S.hitWaits[h.id]; if (w) { delete S.hitWaits[h.id]; w(h); }
  };
  window.addEventListener('message', onMsg);
  //  짚은 곳이 지금 화면의 어디에 있나(비율) — 짚은 뒤 앱이 스크롤된 만큼 옮긴다. 층이 아직 없으면(크기 0) 옮기지 않는다.
  const shown = (p: StudioPin): { x: number; y: number } => {
    const r = layer.getBoundingClientRect();
    return { x: p.x - (r.width > 0 ? (S.sx - (p.sx || 0)) / r.width : 0), y: p.y - (r.height > 0 ? (S.sy - (p.sy || 0)) / r.height : 0) };
  };
  const paintMarks = (): void => {
    layer.querySelectorAll('.v2-studio-mk').forEach((n) => n.remove());
    host.pins.forEach((p, i) => {
      if (p.on === 'wire') return;   // 와이어프레임 보드에서 짚은 곳 — 앱 화면 위엔 그리지 않는다(번호는 그대로 i + 1)
      const hot = i === S.active;
      const q = shown(p);
      if (q.y + (p.h || 0) < 0 || q.y > 1 || q.x + (p.w || 0) < 0 || q.x > 1) return;   // 스크롤로 화면 밖에 나갔다 — 앱 밖에 그리지 않는다
      if (p.kind === 'pick' || p.kind === 'box') {
        const b = el('div', { class: 'v2-studio-mk v2-studio-mk-box' + (p.kind === 'pick' ? ' pick' : '') + (hot ? ' hot' : '') + (p.sent ? ' sent' : '') });
        Object.assign(b.style, { left: q.x * 100 + '%', top: q.y * 100 + '%', width: (p.w || 0) * 100 + '%', height: (p.h || 0) * 100 + '%' });
        layer.append(b);
      }
      //  보낸 코멘트(반영 중)는 흐리게 · 눌러도 칸을 열지 않는다 — 고칠 수 없다(이미 AI 에게 갔다).
      const n = el('button', { type: 'button', class: 'v2-studio-mk v2-studio-mk-n' + (p.kind === 'pick' || p.kind === 'box' ? '' : ' pin') + (hot ? ' hot' : '') + (p.sent ? ' sent' : ''),
        title: p.sent ? 'AI가 반영하고 있어요 · ' + (p.note || p.where || '') : p.note || p.where || '', 'aria-label': (i + 1) + (p.sent ? '번 코멘트 · 반영 중' : '번 코멘트 열기'),
        onclick: (e: MouseEvent) => { e.stopPropagation(); if (!p.sent && S.tool !== 'try') openPop(host.pins.indexOf(p)); } }, el('span', { text: String(i + 1) }));
      n.style.left = q.x * 100 + '%'; n.style.top = q.y * 100 + '%';
      layer.append(n);
    });
  };
  // 그 자리의 의견 칸 — 짚은 곳 옆에 뜬다. 칸은 번호가 아니라 **그 코멘트(객체)** 를 든다 — 새 판이 와 앞의 보낸 코멘트가 빠지면 번호가 당겨지는데,
  //  번호를 들고 있으면 칸이 닫히거나(점검 3-4) 「취소」 가 다른 코멘트를 지웠다.
  let pop: HTMLElement | null = null, popPin: StudioPin | null = null;
  const closePop = (): void => { if (pop) { pop.remove(); pop = null; } popPin = null; if (S.active >= 0) { S.active = -1; paintMarks(); } };
  const removePin = (p: StudioPin): void => { const j = host.pins.indexOf(p); if (j >= 0) host.pins.splice(j, 1); closePop(); changed(); paintMarks(); };
  //  칸의 번호 · 자리를 지금 목록 · 스크롤에 맞춘다(옮겨 그리기 · 새 목록).
  const placePop = (): void => {
    if (!pop || !popPin) return;
    const i = host.pins.indexOf(popPin), p = popPin, q = shown(p);
    const n = pop.querySelector('.k .n'); if (n) n.textContent = String(i + 1);
    pop.setAttribute('aria-label', (i + 1) + '번 코멘트');
    const right = q.x + (p.w || 0);
    pop.style.top = Math.max(0, Math.min(q.y * 100, 66)) + '%';
    //  짚은 곳의 오른쪽 · 왼쪽 중 **화면에** 자리가 있는 쪽 — 앱 칸 안의 비율로만 고르면 화면 오른쪽 끝의 좁은 사이드바(340)에서 칸이 화면 밖으로 나갔다.
    const lr = layer.getBoundingClientRect(), need = 280 + 12 + 8;
    const roomR = window.innerWidth - (lr.left + right * lr.width), roomL = lr.left + q.x * lr.width;
    const toRight = roomR >= need ? true : roomL >= need ? false : roomR >= roomL;
    if (toRight) { pop.style.left = 'calc(' + right * 100 + '% + 12px)'; pop.style.right = ''; } else { pop.style.right = 'calc(' + (100 - q.x * 100) + '% + 12px)'; pop.style.left = ''; }
  };
  const openPop = (i: number): void => {
    const p = host.pins[i]; if (!p) return;
    if (pop) pop.remove();
    closeTray();   // 그 자리 칸과 코멘트 목록은 함께 서지 않는다 — 한쪽에서 고친 것을 다른 쪽이 옛 글로 들고 있게 된다
    S.active = i; popPin = p; paintMarks();
    const ta = growText({ class: 'ta', placeholder: '이 자리를 어떻게 고칠까요', label: (i + 1) + '번 코멘트', value: p.note, max: 8,
      onInput: (v) => { p.note = v; changed(); }, onEnter: () => closePop(), onEscape: () => closePop() });
    const kind = p.kind === 'pick' ? '선택한 요소' : p.kind === 'box' ? '영역' : '핀';
    const pp = el('div', { class: 'v2-studio-pop', role: 'dialog', 'aria-label': (i + 1) + '번 코멘트' },
      el('div', { class: 'k' }, el('span', { class: 'n', text: String(i + 1) }), el('b', { text: kind }), el('span', { class: 'w', text: p.where || '' })),
      ta,
      el('div', { class: 'act' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '취소', title: '이 자리 코멘트를 지워요', onclick: () => removePin(p) }),
        el('small', { class: 'v2-studio-pop-key', text: 'Shift+Enter 줄바꿈' }),
        el('span', { class: 'v2-studio-sp' }), el('button', { type: 'button', class: 'v2-studio-now-pri', text: '완료', onclick: () => closePop() })));
    pp.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop = pp; placePop(); layer.append(pp); fitGrow(ta); ta.focus();
  };
  // 코멘트 목록 — 막대에 맞붙어 열린다(짚은 곳마다 한 장 · 앱 전체 한 칸 · 맨 아래 「수정하기」).
  //  앱을 짚어도 닫히지 않는다 — 열어 둔 채 이곳저곳 짚으면 짚을 때마다 끝에 한 장이 생기고 그 칸에 바로 쓴다(원준 2026-10-28 «여러 개 코멘트 넘기기도 어렵고 · 쓰기가 너무 불편»).
  //  닫는 것은 「접기」 · 「코멘트 n건」 · Esc · 「AI에게 말하기」 칸 열기.
  let tray: HTMLElement | null = null;
  let trayHead: HTMLElement | null = null, traySend: HTMLButtonElement | null = null;
  const closeTray = (): void => { if (tray) { tray.remove(); tray = null; trayHead = null; traySend = null; if (!bar.classList.contains('v2-review-bar--talk')) bar.classList.remove('v2-review-bar--tray'); if (S.active >= 0) { S.active = -1; paintMarks(); } } };
  const paintTrayBits = (): void => {
    if (trayHead) trayHead.textContent = '코멘트' + (cmCount() ? ' · ' + cmCount() + '건' : '');
    if (traySend) { traySend.textContent = send.textContent; traySend.disabled = send.disabled; }
  };
  //  다시 그려도 쓰던 칸을 잃지 않는다 — 칸 ↔ 그 코멘트(같은 객체)를 기억했다가 새 칸에 커서 · 고른 글을 되돌린다(고치는 중 새 버전이 오면 목록을 다시 그린다).
  const taOf = new WeakMap<HTMLTextAreaElement, StudioPin | 'all'>();
  const openTray = (focus?: number): void => {
    closeTalk(); closePop();
    const prevList = tray ? (tray.querySelector('.v2-studio-tray-list') as HTMLElement | null) : null;
    const keepScroll = prevList ? prevList.scrollTop : 0;
    const act = tray && document.activeElement instanceof HTMLTextAreaElement && tray.contains(document.activeElement) ? document.activeElement : null;
    const keep = act ? { key: taOf.get(act), a: act.selectionStart, b: act.selectionEnd } : null;
    const mark = (i: number): void => { if (S.active !== i) { S.active = i; paintMarks(); } };
    const rows = host.pins.map((p, i) => {
      const wire = p.on === 'wire';
      const inp = growText({ class: 'v2-studio-tray-in', placeholder: '이 자리를 어떻게 고칠까요', label: (i + 1) + '번 코멘트', value: p.note,
        onInput: (v) => { p.note = v; changed(); }, onEnter: () => inp.blur(), onEscape: () => closeTray() });
      taOf.set(inp, p);
      inp.addEventListener('focus', () => mark(host.pins.indexOf(p)));
      if (p.sent) { inp.disabled = true; inp.title = 'AI가 반영하고 있어요'; }
      //  ✕ · 번호는 그 코멘트(객체)로 찾는다 — 다른 데서 하나가 지워져도 엉뚱한 것을 지우지 않는다.
      const row = el('div', { class: 'v2-studio-tray-row' + (p.sent ? ' sent' : '') }, el('button', { type: 'button', class: 'n', text: String(i + 1), title: wire ? '와이어프레임에 남긴 코멘트예요. 앱빌더의 「와이어프레임(화면 흐름) 보기」에서 볼 수 있어요.' : '앱에서 그 자리 보기', disabled: wire, onclick: () => mark(host.pins.indexOf(p)) }),
        el('span', { class: 'w', text: (p.sent ? '반영 중 · ' : '') + (wire ? '와이어프레임 · ' : '') + (p.kind === 'pick' ? '요소 ' : p.kind === 'box' ? '영역 ' : '핀 ') + (p.where || '') }), inp,
        p.sent ? null : el('button', { type: 'button', class: 'x', text: '✕', title: '이 코멘트 지우기', onclick: () => { removePin(p); openTray(); } }));
      row.addEventListener('pointerenter', () => mark(host.pins.indexOf(p)));
      return row;
    });
    const g = growText({ class: 'v2-studio-tray-in', placeholder: '앱 전체 코멘트 · 예: 글자 조금 크게', label: '앱 전체 코멘트', value: host.general,
      onInput: (v) => { host.general = v; changed(); }, onEnter: () => g.blur(), onEscape: () => closeTray() });
    taOf.set(g, 'all');
    trayHead = el('b');
    traySend = el('button', { class: 'v2-studio-now-pri', type: 'button', onclick: () => send.click() }) as HTMLButtonElement;   // 막대의 단추와 같은 일(멈췄으면 「이어서 수정하기」)
    const list = el('div', { class: 'v2-studio-tray-list' }, el('div', { class: 'v2-studio-tray-row all' }, el('span', { class: 'w', text: '앱 전체' }), g), ...rows);
    const kids = [
      el('div', { class: 'v2-studio-tray-h' }, trayHead, el('span', { class: 'v2-studio-sp' }),
        el('small', { text: host.pins.length ? '열어 둔 채로 앱을 이어서 짚으면 여기에 한 장씩 더해져요' : '선택 · 핀 · 영역으로 앱을 짚으면 여기에 한 장씩 더해져요' }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '접기', onclick: () => closeTray() })),
      //  앱 전체 의견 칸은 머리 바로 아래 — 짚은 자리 줄들보다 위(원준 2026-10-15 «텍스트 박스 위치가 그 윗줄에 보낼 의견 아래에»)
      list,
      el('div', { class: 'v2-studio-tray-f' }, el('small', { text: 'Enter 완료 · Shift+Enter 줄바꿈' }), el('span', { class: 'v2-studio-sp' }), traySend)];
    //  이미 열려 있으면 그 상자를 그대로 두고 속만 간다 — 세션 위젯 꼴의 고정 자리(--fixed · 위치)가 남는다.
    if (tray) tray.replaceChildren(...kids);
    else {
      const t = el('div', { class: 'v2-studio-tray v2-review-tray', role: 'dialog', 'aria-label': '코멘트' }, ...kids);
      tray = t;
      if (host.dock) {
        //  막대가 화면 맨 위 줄에 들어앉았으면 칸은 막대 **아래로** — 몸(body)에 붙여 앱 위 층(.v2-review-layer)보다 위에 선다(그 층이 사이드바의 앱을 덮고 있다).
        const br = bar.getBoundingClientRect(), cr = count.getBoundingClientRect(), w = Math.min(560, window.innerWidth - 16);
        t.classList.add('v2-review-tray--fixed');
        Object.assign(t.style, { top: Math.round(br.bottom) + 'px', left: Math.round(Math.max(8, Math.min(cr.left, window.innerWidth - w - 8))) + 'px', width: w + 'px' });
        document.body.append(t);
      } else bar.append(t);
      //  막대와 칸은 한 덩어리(원준 2026-10-16 «이거 두 개를 왜 하나로 안 붙이는 거야») — 사이 틈 없이 맞붙고 맞닿은 모서리는 각진다.
      bar.classList.add('v2-review-bar--tray');
    }
    paintTrayBits();
    list.querySelectorAll('textarea').forEach((x) => fitGrow(x as HTMLTextAreaElement));
    list.scrollTop = keepScroll;   // 칸 높이를 맞춘 뒤에 — 한 줄짜리일 때 되돌리면 브라우저가 깎는다
    let to: HTMLTextAreaElement | undefined;
    if (focus != null) to = list.querySelectorAll('.v2-studio-tray-row:not(.all) textarea')[focus] as HTMLTextAreaElement | undefined;
    else if (keep && keep.key) to = [...list.querySelectorAll('textarea')].find((x) => taOf.get(x as HTMLTextAreaElement) === keep.key) as HTMLTextAreaElement | undefined;
    if (to && !to.disabled) {
      if (focus != null) to.scrollIntoView({ block: 'nearest' });
      to.focus();
      if (keep && focus == null) { try { to.setSelectionRange(keep.a, keep.b); } catch (_) { /* 글이 줄었으면 끝으로 */ } }
    }
  };
  const toggleTray = (): void => { if (tray) closeTray(); else openTray(); };
  // 대화 칸 — 막대에 맞붙어 올라오고(막대가 위면 아래로) 그 안에 만드는 AI 세션 화면이 선다. 처음 열 때 한 번 옮겨 오고(옮기면 터미널이 다시 붙는다),
  //  닫으면 숨기기만 한다 — 다시 열면 그대로다. 층이 걷히면 제자리(앱빌더의 「AI 세션」 칸)로 돌려놓는다.
  const talkBody = el('div', { class: 'v2-review-talk-body' });
  const talk = el('div', { class: 'v2-review-talk', role: 'dialog', 'aria-label': 'AI와 대화하며 수정' },
    el('div', { class: 'v2-review-talk-h' }, el('b', { text: 'AI와 대화하며 수정' }),
      el('small', { text: '이 앱을 만드는 AI예요. 애매한 건 먼저 물어보고, 정해지면 새 버전으로 고쳐요.' }), el('span', { class: 'v2-studio-sp' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '접기', title: '대화는 그대로 남아요', onclick: () => closeTalk() })),
    talkBody);
  let chatHome: { parent: Node; next: Node | null } | null = null;
  const placeTalk = (): void => {
    if (!host.dock) return;
    //  막대가 화면 맨 위 줄에 들어앉았으면 칸은 막대 **아래로** — 코멘트 칸(.v2-review-tray--fixed)과 같은 자리 잡기.
    const br = bar.getBoundingClientRect(), w = Math.min(760, window.innerWidth - 16), gr = gen.getBoundingClientRect();
    Object.assign(talk.style, { top: Math.round(br.bottom) + 'px', left: Math.round(Math.max(8, Math.min(gr.left, window.innerWidth - w - 8))) + 'px', width: w + 'px' });
  };
  const openTalk = (): void => {
    if (S.dead || talk.classList.contains('on')) return;
    closeTray(); closePop();
    //  제자리는 열 때마다 다시 적는다 — 그 사이 앱빌더가 「AI 세션」 칸을 떼어 내거나 붙여 세션 화면을 옮겼을 수 있다.
    if (host.chat.parentNode && host.chat.parentNode !== talkBody) chatHome = { parent: host.chat.parentNode, next: host.chat.nextSibling };
    if (host.chat.parentNode !== talkBody) talkBody.append(host.chat);
    if (!talk.isConnected) { if (host.dock) { talk.classList.add('v2-review-talk--fixed'); document.body.append(talk); } else bar.append(talk); }
    placeTalk();
    bar.classList.add('v2-review-bar--tray', 'v2-review-bar--talk');
    void talk.offsetWidth;   // 붙인 다음 틀에서 'on' — 아래에서 올라오는 움직임이 보이게
    talk.classList.add('on');
  };
  const closeTalk = (): void => {
    if (!talk.classList.contains('on')) return;
    talk.classList.remove('on');
    bar.classList.remove('v2-review-bar--talk'); if (!tray) bar.classList.remove('v2-review-bar--tray');
  };
  const say = async (): Promise<void> => {
    const t = gen.value.trim(); if (!t || S.talkBusy) return;
    openTalk();
    S.talkBusy = true; paintBar();
    const ok = await host.onTalk(t).catch(() => false);
    S.talkBusy = false;
    if (S.dead) return;
    if (ok && gen.value.trim() === t) gen.value = '';
    paintBar(); if (ok) gen.focus();
  };
  const tickWait = (): void => {
    if (!host.waiting || host.stall || S.dead) return;
    const s = Math.floor((Date.now() - S.waitT0) / 1000);
    send.textContent = 'AI 수정 중 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); paintTrayBits();
    S.waitTick = window.setTimeout(tickWait, 1000);
  };

  const api: ReviewApi = {
    update: (p) => {
      if (S.dead) return;
      if (p.title != null) { host.title = p.title; name.textContent = '「' + host.title + '」'; }
      if (p.version != null) host.version = p.version;
      const reTray = !!tray;   // 열린 코멘트 목록은 닫지 않고 새 목록으로 다시 그린다
      if (p.pins) {
        //  쓰던 그 자리 칸은 그 코멘트가 아직 목록에 있으면 그대로 둔다 — 번호만 새 목록에 맞춘다(점검 3-4). 없어졌으면 닫는다.
        host.pins = p.pins;
        if (popPin && host.pins.includes(popPin)) { S.active = host.pins.indexOf(popPin); placePop(); }
        else { closePop(); S.active = -1; }
      }
      if (p.general != null) host.general = p.general;
      const sk = (x: ReviewStall | null | undefined): string => (x ? x.text + '|' + x.resume + '|' + !!x.ask : '');
      if (p.stall !== undefined && sk(p.stall) !== sk(host.stall)) {
        const was = !!host.stall; host.stall = p.stall; window.clearTimeout(S.waitTick);
        if (was && !host.stall && host.waiting) S.waitT0 = p.waitSince || Date.now();   // 다시 돌면 시계는 그때부터
        tickWait();
      }
      //  기다림이 시작돼도 · 끝나도 쓰던 칸은 닫지 않는다(점검 3-4) — 도구도 그대로(고치는 중에도 짚는다).
      if (p.waiting != null && p.waiting !== host.waiting) { host.waiting = p.waiting; window.clearTimeout(S.waitTick); if (p.waiting) { S.waitT0 = p.waitSince || Date.now(); tickWait(); } }
      else if (p.waitSince && p.waitSince !== S.waitT0 && host.waiting) { S.waitT0 = p.waitSince; window.clearTimeout(S.waitTick); tickWait(); }   // 앱빌더의 시계에 맞춘다(점검 3-10)
      paintBar(); paintMarks();
      if (reTray && tray && (p.pins || p.waiting != null)) openTray();
      if (p.note) { note.textContent = (host.version ? verName(host.version) + ' · ' : '') + p.note; note.hidden = false; window.clearTimeout(S.noteT); S.noteT = window.setTimeout(() => { note.hidden = true; }, 8000); }
    },
    close: () => {
      if (S.dead) return; S.dead = true;
      if (cur === api) cur = null;
      window.clearInterval(S.tick); window.clearTimeout(S.waitTick); window.clearTimeout(S.noteT);
      window.removeEventListener('resize', onScroll); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('message', onMsg);
      closeTray(); closeTalk(); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*');
      //  AI 세션 화면은 부르는 쪽의 것이다 — 옮겨 왔으면 제자리로(막대와 함께 버리지 않는다).
      if (chatHome && host.chat.parentNode === talkBody) chatHome.parent.insertBefore(host.chat, chatHome.next && chatHome.next.parentNode === chatHome.parent ? chatHome.next : null);
      talk.remove(); layer.remove(); bar.remove(); markReviewProbe(host.appId, false);
      if (host.onClose) host.onClose();
    },
    isOpen: () => !S.dead,
  };
  cur = api;
  paintBar(); paintMarks();
  tickWait();   // 고치는 중에 열었다 — 보낸 때부터 이어서 센다(«AI 수정 중…» 에 멈춰 있지 않게 · 점검 3-10)
  if (location.hash !== host.route) location.hash = host.route;   // 셸이 그 화면을 연다(탭이 있으면 그 탭으로) — 층은 프레임이 보이면 거기 선다
  follow();
  return api;
}
