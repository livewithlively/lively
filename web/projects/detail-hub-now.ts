// projects/detail-hub-now.ts — 허브 맨 위 «지금» 띠(#5630 3판, 원준 2026-11-22 «협업에 편한 대시보드이고싶어»).
//
//  위젯 여섯은 «도구» 다 — 열어서 일하는 자리. 그 위에 «같이 일하는 사람이 들어오자마자 알아야 하는 것» 셋을 한 줄로 세운다:
//   ① 진행      — 태스크 몇 개 중 몇 개가 끝났나(고리).
//   ② 내 차례   — 나를 기다리는 것: 내가 답해야 하는 세션(확인 필요) → 내가 맡은 열린 태스크. 줄을 누르면 바로 그 자리로.
//   ③ 지금      — 누가 지금 돌리고 있나(얼굴) · 작업 중인 세션 수.
//  (최근 활동 칸은 걷었다 — 원준 2026-11-22 «다른 사람 한 게 기본으로 보이는 것 자체가 별로».)
//  수(진행률 · 세션 수)는 여기서 한 번만 말한다 — 위젯 머리는 이름만 남는다(되풀이하지 않는다).
//  ⚠ 리프만 문다(core · detail-hub-kit · detail-hub-model) — 허브(detail-hub.ts)가 ctx 를 넘긴다.
import { el, personFace } from '../core.js';
import { type HubCtx, type SessView, enterSession, ring, sessView } from './detail-hub-kit.js';
import { myTurnItems, sessionIsPast } from './detail-hub-model.js';

export function mountHubNow(host: HTMLElement, ctx: HubCtx): void {
  const { P, o } = ctx;
  const now = Date.now();
  const tasks: any[] = P.tasks || [];
  const cell = (cls: string, k: string, ...kids: any[]): HTMLElement => el('div', { class: 'h3-nc ' + cls }, el('div', { class: 'h3-nc-k', text: k }), ...kids);
  const asBtn = (node: HTMLElement, title: string, run: () => void): HTMLElement => {
    node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.title = title; node.classList.add('go');
    node.addEventListener('click', run);
    node.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
    return node;
  };
  const num = (n: string | number, unit?: string): HTMLElement => el('b', { class: 'h3-num' }, String(n), unit ? el('small', { text: unit }) : null);

  // ① 진행
  const done = tasks.filter((t) => t.status === 'done').length;
  const prog = cell('prog', '진행',
    el('div', { class: 'h3-nc-v' }, ...(tasks.length ? [ring(done / tasks.length, 40, 5), num(Math.round((done / tasks.length) * 100), '%')] : [num('—')])),
    el('div', { class: 'h3-nc-s', text: tasks.length ? '태스크 ' + done + ' / ' + tasks.length : '아직 태스크가 없어요' }));
  asBtn(prog, '태스크 열기', () => ctx.openTool('tasks'));

  // ② 내 차례 · ③ 지금 — 세션이 와야 선다
  const turn = cell('turn', '내 차례', el('div', { class: 'h3-nc-v' }, num('·')));
  const live = cell('live', '지금', el('div', { class: 'h3-nc-v' }, num('·')));
  host.replaceChildren(el('div', { class: 'h3-now' }, prog, turn, live));

  ctx.D.sessions().then((raw: any[]) => {
    const rows = raw.map((s) => { const v: SessView = sessView(s, now); return { s, key: v.key, mine: !!s.owned || (!!ctx.meId && String(s.owner || '') === ctx.meId), past: sessionIsPast(s) }; });
    // 내 차례
    const items = myTurnItems(rows.filter((x) => !x.past), tasks, ctx.meId);
    const list = el('div', { class: 'h3-turn-l' });
    for (const it of items.slice(0, 2)) {
      const b = el('button', { class: 'h3-turn-i ' + it.kind, type: 'button', title: it.kind === 'session' ? '답하러 가기 — ' + it.label : '태스크 열기 — ' + it.label },
        el('i', { 'aria-hidden': 'true' }), el('span', { text: it.label }), el('em', { text: it.kind === 'session' ? '답하기' : '열기' }));
      b.onclick = () => { if (it.kind === 'session') enterSession(it.ref); else if (o.openTask) o.openTask(Number(it.ref.id)); else ctx.openTool('tasks'); };
      list.append(b);
    }
    turn.classList.toggle('has', items.length > 0);
    turn.replaceChildren(el('div', { class: 'h3-nc-k', text: '내 차례' }),
      items.length
        ? el('div', { class: 'h3-nc-v' }, num(items.length, '건'))
        : el('div', { class: 'h3-nc-v' }, num('0', '건')),
      items.length ? list : el('div', { class: 'h3-nc-s', text: '기다리는 일이 없어요' }));

    // 지금
    const busy = rows.filter((x) => x.key === 'busy');
    const open = rows.filter((x) => !x.past && (x.key === 'waiting' || x.key === 'busy' || x.key === 'done' || x.key === 'idle'));
    const shown = busy.length ? busy : open;
    const owners = Array.from(new Set(shown.map((x) => String(x.s.owner || '')).filter(Boolean))).slice(0, 4);
    const faces = el('span', { class: 'pj-ppl-faces h3-live-f' }, ...owners.map((id) => personFace(id, 'pj-ppl-face', ctx.memberName(id))));
    live.classList.toggle('on', busy.length > 0);
    live.replaceChildren(el('div', { class: 'h3-nc-k' }, busy.length ? el('i', { class: 'h3-pulse', 'aria-hidden': 'true' }) : null, '지금'),
      el('div', { class: 'h3-nc-v' }, num(busy.length ? busy.length : open.length, '세션'), owners.length ? faces : null),
      el('div', { class: 'h3-nc-s', text: busy.length ? '작업 중 — ' + String(busy[0].s.label || '') : open.length ? '열려 있어요 · 도는 것은 없어요' : '도는 세션이 없어요' }));
    asBtn(live, '세션 열기', () => ctx.openTool('sessions'));
  }).catch(() => { /* 세션을 못 받아도 띠는 선다 */ });
}
