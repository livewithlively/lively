// 세션 복제(#4135, 원준 2026-09-27) — 문패 [세션 복제] · 세션 우클릭 「세션 복제」가 여는 확인 창과 실행.
//
// 무엇: 지금 세션의 대화를 그대로 아는 새 세션을 하나 더 만든다(서버 POST …/sessions/:id/fork — src/terminal/session-fork.ts).
//  원래 세션은 건드리지 않는다. 새 세션은 **새 탭**에 연다 — 원래 세션의 탭이 그대로 남아야 «하나 더 생겼다» 가 눈에 보인다.
// 왜 확인 창을 두나: 누르면 세션(= 돌아가는 AI 하나)이 새로 뜬다. 되돌릴 수는 있지만(닫으면 된다) 무엇이 생기는지
//  모르고 누르면 같은 이름의 세션이 둘인 이유를 알 수 없다. 창이 그 설명을 겸한다(처음 보는 사람이 읽는 자리).
// 이름: 「세션 복제」. 바로 옆 단추 「세션 옮기기」 와 같은 꼴(세션 + 하는 일)이고, 「복제」 는 원본이 남고 똑같은 것이
//  하나 더 생긴다는 뜻을 이미 갖고 있다. 개발 용어(브랜치·포크)는 쓰지 않는다.
'use strict';

import { anchoredPopover, api, el, toast } from '../core.js';
import { icon } from './icons.js';
import { rememberCreated } from './created-cache.js';

/** 복제 수단이 실증된 AI(서버 catalog 의 Harness.forkArgv 와 같은 목록 — 서버가 최종 판정한다). */
const FORKABLE = new Set(['claude', 'codex']);
export function forkableHarness(h: unknown): boolean {
  return FORKABLE.has(String(h || '').trim());
}

export interface ForkTarget { id: string; name: string }

/** 실패를 사람 말로 — 서버의 거절 문장은 그대로, 요청이 서버에 닿지도 못한 경우(브라우저의 영문 오류)는 우리 말로 바꾼다. */
export function failText(e: unknown): string {
  const m = String((e && (e as { message?: unknown }).message) || e || '').trim();
  if (!m || /failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
    return '서버에 닿지 못했습니다. 연결을 확인하고 다시 시도해 주세요.';
  }
  return m;
}

/** 확인 창을 연다. 복제가 끝나면 onOpen(새 세션 id) — 어디에 열지는 부르는 쪽(탭 규칙을 아는 셸)이 정한다. */
export function openForkPopover(anchor: HTMLElement, t: ForkTarget, onOpen: (newId: string) => void): void {
  let busy = false;
  const note = el('p', { class: 'fk-note', role: 'status', hidden: true }) as HTMLElement;
  const goText = el('span', { text: '복제해서 열기' }) as HTMLElement;
  const go = el('button', { class: 'btn btn-primary btn-sm fk-go', type: 'button', onclick: () => { void run(); } },
    icon('copy', 'pn-i sm'), goText) as HTMLButtonElement;
  const cancel = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => close() }, el('span', { text: '취소' })) as HTMLButtonElement;
  const li = (text: string): HTMLElement => el('li', {}, icon('check', 'pn-i sm'), el('span', { text })) as HTMLElement;
  const panel = el('div', { class: 'fk-pop', role: 'dialog', 'aria-label': '세션 복제' },
    el('div', { class: 'fk-h' }, el('b', { text: '세션 복제' })),
    el('p', { class: 'fk-name', title: t.name, text: t.name }),
    el('p', { class: 'fk-sub', text: '지금까지의 대화를 그대로 아는 새 세션을 하나 더 만듭니다.' }),
    el('ul', { class: 'fk-list' },
      li('이 세션은 그대로 남습니다.'),
      li('복제한 뒤로 두 세션은 서로의 대화를 모릅니다.'),
      li('작업 폴더는 같습니다. 두 세션이 같은 파일을 동시에 고치지 않게 해 주세요.')),
    note,
    el('div', { class: 'fk-act' }, cancel, go)) as HTMLElement;
  const close = anchoredPopover(anchor, panel);

  async function run(): Promise<void> {
    if (busy) return;
    busy = true; go.disabled = true; cancel.disabled = true;
    goText.textContent = '복제하는 중…';
    note.hidden = true; note.classList.remove('bad');
    try {
      const r: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(t.id) + '/fork', { method: 'POST', body: JSON.stringify({}) });
      const id = r && r.session && r.session.id ? String(r.session.id) : '';
      if (!id) throw new Error('복제된 세션 id 를 받지 못했습니다.');
      rememberCreated(r.session);   // 노드 세션은 목록에 한 박자 늦게 뜬다 — 라우트가 이 한 장으로 먼저 그린다
      close();
      toast('세션을 복제했어요. 새 탭에 열었습니다.');
      onOpen(id);
    } catch (e: any) {
      //  서버의 거절 문장(누구 세션인지 · 아직 대화가 없는지 · 그 컴퓨터가 꺼져 있는지)을 그대로 보여 준다 — 창은 닫지 않는다.
      note.textContent = failText(e);
      note.classList.add('bad'); note.hidden = false;
      busy = false; go.disabled = false; cancel.disabled = false;
      goText.textContent = '다시 시도';
    }
  }
}
