// v2/session-defaults.ts — 컴포저 [⚙] 「새 세션 기본값」 창(#3778 안 C, 원준 2026-09-09).
//
//  홈·프로젝트의 [시키기]로 여는 **모든** 새 세션에 적용되는 값 넷을 한 창에서 고친다 — 실행 컴퓨터 · 라이블리 모드 ·
//  실행 승인 · 기록 범위. 자주 안 바꾸는 값이라 줄에서 빼고(줄엔 AI·모델·추론강도만 남는다), «이번 세션만 다르게»는
//  두지 않는다 — 머릿속 모델을 «⚙ 는 설정, 줄은 지금 값» 하나로 유지하기 위해서다. 하나만 다르게 열려면 클래식 「새 AI 세션」 폼.
//  창은 confirmDialog(ui-primitives)의 extra 자리에 폼을 얹는다 — 확인 창과 같은 겉모습·같은 키 규약(Esc 취소).
import { el, visAxisOn } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { MODE_OPTS, NODE_CENTRAL, WRITE_VIS_OPTS, saveSessionDefaults, sessionDefaults, type RunNode, type SessionDefaults } from './run-prefs.js';

/** 툴팁·요약용 한 줄 — «내 맥북 · 일반 · 확인 후 실행 · 기록 자동». */
export function defaultsSummary(d: SessionDefaults, nodes: RunNode[]): string {
  const node = d.nodeDefault === NODE_CENTRAL ? '중앙 컴퓨터'
    : d.nodeDefault ? ('🖥 ' + ((nodes.find((n) => n.id === d.nodeDefault) || {}).name || d.nodeDefault))
      : (nodes.length ? '규칙대로(켜진 내 컴퓨터 우선)' : '중앙 컴퓨터');
  const mode = (MODE_OPTS.find((m) => m.key === d.mode) || MODE_OPTS[0]).lbl;
  const parts = [node, mode, d.autoApprove ? '자동 승인' : '확인 후 실행'];
  if (d.mode === 'normal' && visAxisOn('session_cap')) parts.push('기록 ' + ((WRITE_VIS_OPTS.find((o) => o.v === d.writeVis) || WRITE_VIS_OPTS[0]).t));
  return parts.join(' · ');
}

/**
 * 창을 열고, 저장했으면 true. nodes = 지금 카탈로그의 노드(없으면 실행 컴퓨터 줄을 안 그린다 — 중앙만 있는 사람에게 군더더기).
 *  hasAutoApprove = 지금 고른 AI 에 자동 승인 플래그가 있나(없으면 그 줄을 잠그고 이유를 적는다 — 효과 없는 컨트롤을 남기지 않는다).
 */
export async function openSessionDefaults(opts: { nodes: RunNode[]; hasAutoApprove: boolean }): Promise<boolean> {
  const d = sessionDefaults();
  const sel = (title: string): HTMLSelectElement => el('select', { class: 'term-input v2-def-sel', 'aria-label': title }) as HTMLSelectElement;
  const row = (k: string, ctl: HTMLElement, note?: string): HTMLElement =>
    el('div', { class: 'v2-def-row' }, el('span', { class: 'k', text: k }), el('div', { class: 'v' }, ctl, note ? el('div', { class: 'v2-fine', text: note }) : null));

  const nodeSel = sel('실행 컴퓨터');
  nodeSel.replaceChildren(
    el('option', { value: '' }, '규칙대로 — 켜진 내 컴퓨터, 없으면 중앙'),
    el('option', { value: NODE_CENTRAL }, '항상 중앙 컴퓨터'),
    ...opts.nodes.map((n) => el('option', { value: n.id }, '🖥 ' + (n.name || n.id) + (n.shared ? ' (공유)' : '') + (n.online ? '' : ' — 지금 꺼짐'))));
  nodeSel.value = [ '', NODE_CENTRAL, ...opts.nodes.map((n) => n.id) ].includes(d.nodeDefault) ? d.nodeDefault : '';

  const modeSel = sel('라이블리 모드');
  modeSel.replaceChildren(...MODE_OPTS.map((m) => el('option', { value: m.key }, m.lbl + ' — ' + m.sub)));
  modeSel.value = d.mode;

  const okSel = sel('실행 승인');
  okSel.replaceChildren(el('option', { value: '' }, '확인 후 실행 — 위험한 명령은 물어본다'), el('option', { value: 'auto' }, '자동 승인 — 묻지 않고 바로 실행'));
  okSel.value = d.autoApprove ? 'auto' : '';
  okSel.disabled = !opts.hasAutoApprove;

  const visSel = sel('기록 범위');
  visSel.replaceChildren(...WRITE_VIS_OPTS.map((o) => el('option', { value: o.v }, o.t + ' — ' + o.d)));
  visSel.value = d.writeVis;
  const visNote = el('div', { class: 'v2-fine', hidden: true, text: '읽기전용·인코그니토에서는 기록하지 않아 고를 수 없어요.' });
  const syncVis = (): void => { const locked = modeSel.value !== 'normal'; visSel.disabled = locked; visNote.hidden = !locked; };
  modeSel.addEventListener('change', syncVis); syncVis();

  const form = el('div', { class: 'v2-def' },
    el('p', { class: 'v2-def-lead', text: '홈과 프로젝트의 [시키기]로 여는 모든 새 세션에 적용돼요. 하나만 다르게 열려면 「새 AI 세션」 폼을 쓰세요.' }),
    opts.nodes.length ? row('실행 컴퓨터', nodeSel) : null,
    row('라이블리 모드', modeSel),
    row('실행 승인', okSel, opts.hasAutoApprove ? '자동 승인은 빠르지만 공유 폴더에선 끄기를 권해요.' : '지금 고른 AI 에는 자동 승인 플래그가 없어요.'),
    visAxisOn('session_cap') ? row('기록 범위', el('div', {}, visSel, visNote)) : null);

  const ok = await confirmDialog({ title: '새 세션 기본값', extra: form, confirmText: '저장', cancelText: '취소' });
  if (!ok) return false;
  saveSessionDefaults({
    nodeDefault: nodeSel.value,
    mode: (MODE_OPTS.some((m) => m.key === modeSel.value) ? modeSel.value : 'normal') as SessionDefaults['mode'],
    autoApprove: opts.hasAutoApprove ? okSel.value === 'auto' : d.autoApprove,
    writeVis: visSel.value,
  });
  return true;
}
