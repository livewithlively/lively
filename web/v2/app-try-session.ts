// v2/app-try-session.ts — 앱빌더 ③ 「세션 위젯으로 보기」 의 **가상 세션**(#4632, 원준 2026-10-15 «지금 시연 중인 상황이잖아 · 가상의 세션을 만들어야지 ·
//  지금 저 앱을 수정하는 세션이 들어가면 안 되지 · 동작을 어떻게 하는지 미리 보고 싶은 거잖아»).
//
//  진짜 세션 화면과 같은 꼴(문패 · 세션 머리줄 · 가운데 대화 · 우측 사이드바의 탭 줄 · 붙은 앱 머리줄)로 서고 — 셸의 클래스를 그대로 써서 같은 모양이다 —
//   우측 사이드바의 앱 탭에는 **진짜 앱**(같은 판 · 같은 데이터 · 같은 프레임)이 뜬다. 가운데 세션만 가짜다: AI 가 없고,
//   앱이 「세션에 보내기」(chat.send)로 보낸 글은 진짜 세션(앱을 만드는 세션) 대신 여기 찍힌다 — 서버가 붙이는 표식 한 줄까지 같은 꼴로.
//  코멘트 막대(app-review.ts)는 이 화면 맨 위 줄(dock)에 들어앉는다 — 떠서 세션의 입력칸을 가리지 않게(원준 같은 날 «타이핑 부분을 코멘트 팝업이 가린다»).
//  우측 사이드바 폭은 끌어 바꾼다(진짜처럼 기본 340) — 좁을 때 · 넓을 때를 여기서 본다.
import { el } from '../core.js';
import { mountAppUiFrame, markReviewProbe, type AppUiFrame } from './app-ui.js';
import { pnIcon } from './panes-kit.js';
import { glyphAt } from '../lib/icon-paths.js';
import { sessAppDoorIcon, sessAppFace } from './session-app-pane.js';
import { makeSplitter } from './split.js';
import { SIDE_DEF } from '../lib/side-card-geom.js';

export interface TrySessionOpts { appId: string; title: string; version: number }
export interface TrySession {
  root: HTMLElement;
  /** 코멘트 막대가 들어앉는 자리 — 화면 맨 위 한 줄(app-review 의 dock). */
  dock: HTMLElement;
  update(p: { title?: string; version?: number }): void;
  destroy(): void;
}

/** 서버가 앱의 글 앞에 붙이는 표식(src/apps/app-chat-send.ts composeAppMessage 와 같은 꼴) — 진짜 세션에 찍히는 모습 그대로 보인다. */
export function trySentText(appTitle: string, text: string): string { return '(앱 「' + appTitle + '」에서 보냄)\n' + text; }

export function mountTrySession(host: HTMLElement, o: TrySessionOpts): TrySession {
  let title = o.title, version = o.version, dead = false, frame: AppUiFrame | null = null;
  const face = sessAppFace({ app_id: o.appId, has_ui: true });

  // ── 문패 · 세션 머리줄(진짜 화면의 .pn-door · .sc-head 와 같은 클래스) ──
  const doorT = el('span', { class: 'v2-try-title' });
  const door = el('header', { class: 'pn-door in-sess v2-try-door' },
    el('div', { class: 'pn-door-l' },
      el('h1', { class: 'pn-title' }, doorT),
      el('div', { class: 'pn-eyebrow' }, el('span', { class: 'pn-state v2-try-state', text: '가상 세션' }), el('span', { class: 'sep', text: '·' }),
        el('span', { text: '진짜 AI 세션이 아니에요 — 앱을 만드는 세션에는 아무것도 가지 않아요' }))));
  const scTitle = el('span', { class: 'sc-title' });
  const shead = el('div', { class: 'sc-head' },
    el('div', { class: 'sc-head-l' }, el('span', { class: 'v2-try-dot', 'aria-hidden': 'true' }), scTitle,
      el('span', { class: 'sc-meta' }, el('span', { class: 'sc-sep', text: '·' }), el('span', { text: '가상 세션' }))));

  // ── 가운데 대화(터미널 꼴 · 가짜) ──
  const log = el('div', { class: 'v2-try-log', role: 'log', 'aria-live': 'polite', 'aria-label': '가상 세션 대화' });
  const line = (cls: string, mark: string, text: string): HTMLElement => el('div', { class: 'v2-try-ln ' + cls }, el('span', { class: 'mk', 'aria-hidden': 'true', text: mark }), el('span', { class: 'tx', text }));
  const intro = (): HTMLElement => el('div', { class: 'v2-try-intro' },
    line('ai', '✻', '가상 세션이에요 — AI 가 없는 가짜 세션입니다.'),
    line('dim', ' ', '우측 사이드바의 「' + title + '」 은 진짜 앱이에요(같은 판 · 같은 데이터). 세션에 붙었을 때와 똑같이 눌러 보세요.'),
    line('dim', ' ', '앱이 「세션에 보내기」 로 보내는 글은 진짜 세션 대신 여기 찍혀요. 앱에서 바꾼 데이터는 진짜로 남아요.'));
  let introEl = intro(); log.append(introEl);
  const input = el('div', { class: 'v2-try-input' },
    el('div', { class: 'v2-try-prompt' }, el('span', { class: 'mk', 'aria-hidden': 'true', text: '›' }), el('span', { class: 'ph', text: '가상 세션이라 여기엔 칠 수 없어요 — 우측 사이드바의 앱을 눌러 보세요' })),
    el('div', { class: 'v2-try-foot', text: '가상 세션 · 보낸 글은 이 화면에만 남아요' }));
  const sess = el('div', { class: 'sc-wrap v2-try-sess' }, shead, log, input);

  // ── 우측 사이드바 — 탭 줄(자료 · 프로젝트 · 지식 · 이 앱) + 붙은 앱 머리줄 + 앱 ──
  const tab = (ic: string, color: string, name: string, on: boolean): HTMLElement => {
    const lead = el('span', { class: 'pn-tab-lead', 'data-ic': ic }, pnIcon(glyphAt(ic, 14), 'pn-i sm'));
    const b = el('button', { class: 'pn-tab', type: 'button', role: 'tab', tabindex: on ? '0' : '-1', 'aria-selected': String(on), title: on ? name : name + ' — 가상 세션에선 열지 않아요', 'aria-label': name }, lead, el('span', { class: 'pn-tab-t', text: name }));
    if (!on) b.setAttribute('aria-disabled', 'true');
    return el('span', { class: 'pn-tabwrap' + (on ? ' on' : ''), style: '--ac: var(--gi-c-' + color + ')' }, b);
  };
  const appTabT = (): HTMLElement => tab('apps', face, title, true);
  const tabs = el('div', { class: 'pn-tabs', role: 'tablist' });
  const paintTabs = (): void => { tabs.replaceChildren(tab('folder', 'src', '자료', false), tab('proj', 'proj', '프로젝트', false), tab('wiki', 'wiki', '지식', false), appTabT()); };
  //  앱 탭의 그림은 앱 찾기와 같은 그림(붙은 앱 탭과 같은 규칙) — glyph 이름이 아니라 앱 얼굴을 그대로 넣는다.
  const fixAppLead = (): void => { const lead = tabs.querySelector('.pn-tabwrap.on .pn-tab-lead'); if (lead) lead.replaceChildren(sessAppDoorIcon([{ app_id: o.appId, has_ui: true }], 'pn-i sm')); };
  paintTabs(); fixAppLead();
  const bar = el('div', { class: 'pn-tabbar compact v2-try-tabbar' }, tabs);
  const hTitle = el('b', { class: 'pn-sessapp-title ell' });
  const hVer = el('span', { class: 'pn-sessapp-ver' });
  const head = el('div', { class: 'pn-sessapp-head' }, sessAppDoorIcon([{ app_id: o.appId, has_ui: true }], 'pn-i sm'), hTitle, hVer, el('span', { class: 'pn-sp' }));
  const appBody = el('div', { class: 'v2-try-app' }, el('p', { class: 'pn-fine pn-sessapp-wait', text: '앱을 여는 중…' }));
  //  진짜 곁칸(.pn-pane[data-zone=side])의 클래스는 쓰지 않는다 — 좁은 폭에서 셸이 그 칸을 서랍으로 접고(42-v2-panes · 50-mobile), 셸이 그 칸을 찾는다(main.ts).
  //   .pn-sessapp 도 쓰지 않는다 — 새 판이 오면 앱빌더가 이 프레임을 다시 띄워야 하는데(reloadAppFrames) 그 함수는 진짜 곁칸(스스로 다시 띄운다)을 건너뛴다.
  const side = el('section', { class: 'pn-pane v2-try-side', 'aria-label': '우측 사이드바(가상 세션)' }, bar, el('div', { class: 'v2-try-side-body' }, head, appBody));

  const body = el('div', { class: 'v2-try-body' });
  const split = makeSplitter({ axis: 'x', key: 'studio_try_side', cssVar: '--v2-try-side-w', target: body, def: SIDE_DEF, min: 260,
    max: () => Math.max(300, Math.round(body.getBoundingClientRect().width * 0.7)), grow: -1, label: '우측 사이드바 폭' });
  body.append(el('div', { class: 'pn-col v2-try-col' }, sess), split, side);
  const dock = el('div', { class: 'v2-try-dock' });
  const root = el('div', { class: 'v2-try' + (host === document.body ? ' v2-try--fixed' : ''), role: 'region', 'aria-label': '가상 세션 — 「' + title + '」 써 보기' }, dock, door, body);
  host.append(root);

  const paintNames = (): void => {
    doorT.textContent = '「' + title + '」 써 보기';
    scTitle.textContent = '「' + title + '」 을 붙인 세션';
    hTitle.textContent = title; hVer.textContent = version ? version + '판' : ''; hVer.hidden = !version;
  };
  paintNames();

  //  앱이 「세션에 보내기」 를 눌렀다 — 진짜 세션 대신 여기 찍는다(서버 표식 꼴 그대로) · 미리보기라 AI 는 답하지 않는다고 한 줄.
  const onSend = (text: string): void => {
    if (dead) return;
    const [first, ...rest] = trySentText(title, text).split('\n');
    log.append(el('div', { class: 'v2-try-turn' },
      el('div', { class: 'v2-try-ln me' }, el('span', { class: 'mk', 'aria-hidden': 'true', text: '›' }), el('span', { class: 'tx', text: first })),
      ...(rest.length ? [el('div', { class: 'v2-try-ln me more' }, el('span', { class: 'mk', 'aria-hidden': 'true', text: ' ' }), el('span', { class: 'tx', text: rest.join('\n') }))] : []),
      line('ai dim', '●', '가상 세션이라 여기서 멈춰요 — 진짜 세션이면 AI 가 이 글을 받아 일을 시작해요.')));
    log.scrollTop = log.scrollHeight;
  };

  markReviewProbe(o.appId, true);   // 코멘트 층의 탐침이 이 프레임에 들어가게(층이 먼저 섰어도 프레임은 이 뒤에 뜬다)
  void (async () => {
    try {
      const f = await mountAppUiFrame(o.appId, { title, chatSink: onSend,
        //  제 머리줄이 있는 앱은 호스트 머리줄을 접어 달라고 한다 — 진짜 곁칸처럼 따른다.
        onChrome: (c) => { if (!c.init) head.hidden = !c.head; } });
      if (dead) { f.destroy(); return; }
      frame = f; appBody.replaceChildren(f.root);
    } catch (e: any) {
      if (dead) return;
      appBody.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '앱 화면을 열지 못했어요.' }), el('p', { class: 'pn-fine', text: String(e && e.message ? e.message : e) })));
    }
  })();

  return {
    root, dock,
    update(p) {
      if (p.title != null && p.title !== title) { title = p.title; paintTabs(); fixAppLead(); const n = intro(); introEl.replaceWith(n); introEl = n; }
      if (p.version != null) version = p.version;
      paintNames();
    },
    destroy() { if (dead) return; dead = true; frame?.destroy(); frame = null; root.remove(); },
  };
}
