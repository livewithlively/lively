// v2/omni-frame.ts — 액자(클래식 ?embed=1) 문서에서 ⌘K 를 바깥 셸의 통합검색으로 넘기는 다리(#4530).
//
//  ── 왜 ──
//  새 셸은 프로젝트·지식 문서·수집·증류·설정·세션 이력·홈(클래식) 화면을 **같은 오리진 iframe(액자)** 에 싣는다(apps.ts embedUrl).
//  그 안을 한 번 누르면 키는 액자 문서로만 가고 셸 문서에는 오지 않는다. 그래서 프로젝트 보드를 보다가 ⌘K 를 누르면
//  아무 일도 없었다(실측 2026-10-01 매니지드: 프로젝트 화면 안 Ctrl+K · Alt+K 모두 무반응 · #4530 점검 1번).
//  지식 문서 안에서는 위키 전용 검색(wiki-doc.ts)이 따로 떠서, 같은 ⌘K 가 자리에 따라 다른 검색을 열었다(점검 2번).
//  터미널 프레임이 이미 쓰는 다리(OMNI_MSG)를 액자에도 놓는다 — 셸에 프레임 목록을 두지 않고, 프레임이 각자 넘긴다.
//
//  ── 규칙 ──
//   · 끼워 넣은 판(embed=1)이고 부모 창이 있을 때만 단다. 단독 탭에서는 종전 그대로(위키 ⌘K 도 그대로).
//   · window **캡처 단계**에서 받는다 — 같은 문서의 위키 ⌘K(document 버블 단계)보다 먼저 받아 거기서 끊는다.
//   · 판정은 lib/omni-chord.ts(한글 자판·맥 Option 도) — 셸과 같은 키를 같은 규칙으로 본다.
//   · 셸이 닫았다고 알려 오면(OMNI_CLOSED_MSG) 누르기 직전의 입력칸으로 초점을 되돌린다.
import { isOmniChordLike } from '../lib/omni-chord.js';
import { OMNI_CLOSED_MSG, requestOmniFromParent } from './omni.js';
import { EMBEDDED } from './embed.js';

let installed = false;
let lastFocus: Element | null = null;

/** 이 문서가 셸에 통합검색을 부탁할 자리인가 — 끼워 넣은 판이고 부모가 있다. */
export function omniFrameActive(): boolean {
  try { return EMBEDDED && window.parent !== window; } catch { return false; }
}

/** 지금 초점을 기억하고 셸에 통합검색을 부탁한다(seed = 검색칸에 미리 넣을 글). 부탁하지 못했으면 false. */
export function forwardOmniToShell(seed?: string): boolean {
  const ae = document.activeElement;
  lastFocus = ae && ae !== document.body ? ae : null;
  return requestOmniFromParent(seed);
}

/** 액자 문서 부팅 때 한 번 부른다(web/main.ts 클래식 갈래). 끼워 넣은 판이 아니면 아무것도 안 한다. */
export function installOmniForwarder(): void {
  if (installed || !omniFrameActive()) return;
  installed = true;
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!isOmniChordLike(e)) return;
    e.preventDefault();
    e.stopPropagation();   // 같은 문서의 위키 ⌘K(wiki-doc.ts)까지 가지 않게 — 셸 통합검색 하나만 뜬다
    forwardOmniToShell();
  }, true);
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    const m: any = ev.data;
    if (!m || m.type !== OMNI_CLOSED_MSG) return;
    const t = lastFocus as HTMLElement | null;
    lastFocus = null;
    //  셸 창에서 이 액자로 초점을 먼저 넘긴 뒤(부모가 iframe.focus 를 부르지 않았어도) 그 칸으로 간다.
    try { window.focus(); } catch { /* 막힌 환경 */ }
    if (t && t.isConnected && typeof t.focus === 'function') { try { t.focus({ preventScroll: true }); } catch { /* 사라진 칸 */ } }
  });
}
