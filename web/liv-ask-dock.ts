// liv-ask-dock.ts — 리브 세션 대화창의 **입력칸 바로 위**에 리브의 물음(자격·객관식·올리기)을 띄운다(#4970 «리브 = 세션 하나»).
//
//  ⚠ 왜 오른쪽 칸이 아니라 여기인가(실측 2026-08-15): 리브가 "어디에 쌓아 두셨어요?"를 물었는데 그 물음이 **대화와 다른 칸**에
//   떴다. 사람은 리브의 말을 읽는 자리에 눈이 있는데 정작 고를 것은 화면 끝에 있었다. 물음이 대화 밖에 있으면 그건 대화가 아니라
//   서식이다 — 그래서 리브가 던진 물음은 **말하는 자리 바로 위**(스크롤에 떠내려가지 않는 자리)에 붙인다. 오른쪽 «리브» 칸은
//   «입력칸 위에서 기다린다» 한 줄만 쓴다(web/v2/panes-liv.ts).
//  값은 대화로 가지 않는다 — 카드가 서버(화면 전용 문)로 곧바로 보내 금고에 넣고, 리브에게는 «저장했어요» 한 마디만 건넨다.
import { el } from './core.js';
import { livAskCard, livAskTyping, pokeLivStatus, watchLivStatus } from './liv-cards.js';

export interface LivAskDock { destroy(): void }

/** dock = 대화창의 입력칸 바로 위 자리. say = 이 대화창으로 리브에게 한 마디 보내기. */
export function mountLivAskDock(dock: HTMLElement, o: { say: (text: string) => void; isVisible: () => boolean }): LivAskDock {
  const host = el('div', { class: 'liv-askdock sc-liv-askdock' });
  dock.append(host);
  const hooks = { say: o.say, refresh: () => pokeLivStatus() };
  const off = watchLivStatus((st) => {
    if (!host.isConnected) return;
    if (livAskTyping(host)) return;           // 사람이 치는 중이면 손대지 않는다 — 다시 그리면 값이 사라진다
    if (!st) return;                          // 못 읽었으면 그대로 둔다(다음 판에 다시)
    const card = livAskCard(st.secretAsk, hooks);
    host.replaceChildren(...(card ? [card] : []));
  }, () => host.isConnected && o.isVisible());
  return { destroy: () => { off(); host.remove(); } };
}
