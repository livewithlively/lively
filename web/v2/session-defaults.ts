// v2/session-defaults.ts — 컴포저 [⚙] 「새 세션 기본값」 창(#3778 안 C, 원준 2026-09-09).
//
//  홈·프로젝트의 [시키기]로 여는 **모든** 새 세션에 적용되는 값 넷을 한 창에서 고친다 — 실행 컴퓨터 · 라이블리 모드 ·
//  실행 승인 · 기록 범위. 자주 안 바꾸는 값이라 줄에서 빼고(줄엔 AI·모델·추론강도만 남는다), «이번 세션만 다르게»는
//  두지 않는다 — 머릿속 모델을 «⚙ 는 설정, 줄은 지금 값» 하나로 유지하기 위해서다. 하나만 다르게 열려면 클래식 「새 AI 세션」 폼.
//
//  ── 2판(원준 2026-09-09 «모달 안 디자인이 엉망») ──
//  · 항목마다 제목 옆 (?) — 누르면 그 자리에 설명이 펼쳐진다. 비개발자가 읽는 말로, 비유 없이 무엇이 어떻게 되는지만 적는다.
//  · 선택지가 두셋인 축(모드·승인)은 드롭다운 대신 **나란한 단추**(무엇을 고를 수 있는지가 안 눌러도 보인다).
//  · 실행 컴퓨터는 고른 설정이 **지금 어디로 풀리는지** 한 줄로 보여 준다(「규칙대로」가 무엇을 뜻하는지 그 자리에서 답한다).
//  · confirmDialog 를 쓰지 않고 같은 겉모습(ov-back/ov-box)으로 직접 만든다 — 폭·머리·발 구성이 확인 창과 다르다.
import { el, visAxisOn } from '../core.js';
import { MODE_OPTS, NODE_CENTRAL, WRITE_VIS_OPTS, defaultNodeId, saveSessionDefaults, sessionDefaults, type LivelyMode, type RunNode, type SessionDefaults } from './run-prefs.js';

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

// (?) 설명 — 쉬운 말, 비유 없이. 각 문단은 «무엇을 정하나 → 선택지마다 무슨 일이 생기나 → 언제 무엇을 고르나» 순서.
//  ⚠ 이 문구는 **코드에서 확인한 것만** 적는다(원준 2026-09-10 «제대로 검증해서 다시 달아»). 1판은 클래식 폼의
//   문구를 옮겨 적었는데, 기록 범위는 그 문구가 실제 동작과 달랐다 — «그 팀만 봅니다» 라고 적어 두고 실제로는
//   보는 사람이 아니라 **기록할 수 있는 곳**을 제한하고 있었다(테스트 defaults-help.test.ts 가 이 어긋남을 잠근다).
//   근거 좌표 — mode: capabilities/index.ts registerMcpCapabilities(인코그니토는 즉시 return, 읽기전용은 쓰기 툴 미등록) ·
//   approve: terminal/sessions.ts 가 harness.autoApproveFlag 를 argv 에 넣는다 ·
//   vis: capabilities/activity.ts 가 유일한 강제 지점(작업 기록을 프로젝트에 붙일 때만) ·
//   node: v2/run-prefs.ts defaultNodeId·resolveNodeDefault.
const HELP = {
  node: [
    'AI 세션이 실제로 돌아갈 컴퓨터를 정해요.',
    '「중앙 컴퓨터」는 라이블리가 운영하는 서버예요. 그 밖의 항목은 라이블리 노드 프로그램을 켜 둔 내 컴퓨터나, 팀이 함께 쓰라고 지정해 둔 컴퓨터예요. 내 컴퓨터에서 열면 그 컴퓨터에 있는 파일과 설치된 프로그램을 그대로 쓸 수 있어요.',
    '「규칙대로」로 두면 켜져 있는 내 컴퓨터를 먼저 쓰고, 그런 컴퓨터가 없으면 중앙 컴퓨터에서 열어요. 특정 컴퓨터를 골라 뒀는데 그게 꺼져 있으면 역시 이 규칙으로 열려요.',
  ],
  mode: [
    '이 세션의 AI 가 라이블리에 쌓인 회사 자료(지식·프로젝트·작업 기록)를 쓸 수 있는지 정해요.',
    '「일반」은 읽기와 쓰기가 모두 됩니다. 「읽기전용」은 읽기만 되고, 라이블리에 무언가를 저장하는 기능이 그 세션에서 아예 사라져요 — AI 는 그런 기능이 있는 줄도 모릅니다. 「인코그니토」는 라이블리 기능이 하나도 연결되지 않아, 회사 자료를 읽지도 쓰지도 못해요.',
    '보통은 「일반」입니다. 회사에 남기면 안 되는 내용을 다룰 때 「읽기전용」, 라이블리와 완전히 분리해 AI 만 쓰고 싶을 때 「인코그니토」를 고르세요.',
  ],
  approve: [
    'AI 가 파일을 고치거나 명령을 실행하기 전에 나에게 물어볼지 정해요.',
    '「확인 후 실행」은 위험할 수 있는 일마다 먼저 물어보고, 내가 허락해야 진행해요. 「자동 승인」은 그 확인 절차를 끄고 바로 실행해요.',
    '자동 승인은 빠르지만 잘못된 명령도 그대로 실행돼요. 여러 사람이 함께 쓰는 폴더에서는 「확인 후 실행」을 권해요.',
  ],
  vis: [
    'AI 가 내 확인 없이 남기는 작업 기록을, 어떤 프로젝트에까지 붙일 수 있는지 정해요.',
    '「제한 없음」이면 어느 프로젝트에나 기록해요. 「공개 프로젝트 제외」로 두면, 회사 누구나 볼 수 있는 프로젝트에 기록하려 할 때 막히고 오류가 납니다 — 볼 사람을 지정해 둔 프로젝트에만 기록할 수 있어요. 「자동」은 세션이 열린 폴더를 보고 둘 중 하나로 정해요.',
    '이 설정은 작업 기록에만 적용돼요. AI 가 저장하는 지식은 이 설정을 따르지 않습니다. 그리고 「공개 프로젝트 제외」와 그 아래 항목은 지금 동작이 같아요.',
    '읽기전용·인코그니토에서는 기록을 남기지 않으니 이 항목은 고를 수 없어요.',
  ],
};

interface SegOpt { v: string; t: string; d?: string }
/** 나란한 단추 — role=radiogroup. 두셋 중 하나를 고르는 축에 쓴다(안 눌러도 선택지가 다 보인다). */
function segmented(label: string, opts: SegOpt[], value: string, onChange: (v: string) => void): { el: HTMLElement; set(v: string): void; disable(on: boolean): void } {
  let cur = value;
  const btns: HTMLButtonElement[] = [];
  const root = el('div', { class: 'v2-seg', role: 'radiogroup', 'aria-label': label });
  const paint = (): void => { for (const b of btns) { const on = b.dataset.v === cur; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; } };
  for (const o of opts) {
    const b = el('button', { class: 'v2-seg-b', type: 'button', role: 'radio', 'data-v': o.v },
      el('span', { class: 't', text: o.t }), o.d ? el('span', { class: 'd', text: o.d }) : null) as HTMLButtonElement;
    b.addEventListener('click', () => { if (b.disabled) return; cur = o.v; paint(); onChange(cur); });
    b.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = btns.indexOf(b); const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
      btns[j].click(); btns[j].focus();
    });
    btns.push(b); root.append(b);
  }
  paint();
  return { el: root, set(v) { cur = v; paint(); }, disable(on) { for (const b of btns) b.disabled = on; } };
}

/** 항목 하나 — 제목 + (?) + (펼쳐지는 설명) + 컨트롤 + 아래 힌트. */
function field(title: string, help: string[], control: HTMLElement, hint?: HTMLElement | null): HTMLElement {
  const tip = el('div', { class: 'v2-def-tip', hidden: true, role: 'note' }, ...help.map((p) => el('p', { text: p })));
  const q = el('button', { class: 'v2-def-q', type: 'button', 'aria-expanded': 'false', 'aria-label': title + ' 설명', title: '이게 뭔가요?', text: '?' }) as HTMLButtonElement;
  q.addEventListener('click', () => { const open = tip.hidden; tip.hidden = !open; q.setAttribute('aria-expanded', open ? 'true' : 'false'); });
  return el('div', { class: 'v2-def-f' },
    el('div', { class: 'v2-def-t' }, el('span', { class: 'k', text: title }), q),
    tip, control, hint || null);
}

/**
 * 창을 열고, 저장했으면 true. nodes = 지금 카탈로그의 노드(없으면 실행 컴퓨터 항목을 안 그린다 — 중앙만 있는 사람에게 군더더기).
 *  hasAutoApprove = 지금 고른 AI 에 자동 승인 플래그가 있나(없으면 그 항목을 잠그고 이유를 적는다 — 효과 없는 컨트롤을 남기지 않는다).
 */
export function openSessionDefaults(opts: { nodes: RunNode[]; hasAutoApprove: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const d = sessionDefaults();
    const nodes = opts.nodes;
    let done = false;
    const finish = (v: boolean): void => { if (done) return; done = true; back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };

    // ── 실행 컴퓨터 ──
    const nodeSel = el('select', { class: 'term-input v2-def-sel', 'aria-label': '실행 컴퓨터' }) as HTMLSelectElement;
    nodeSel.replaceChildren(
      el('option', { value: '' }, '규칙대로 — 켜져 있는 내 컴퓨터, 없으면 중앙'),
      el('option', { value: NODE_CENTRAL }, '항상 중앙 컴퓨터'),
      ...nodes.map((n) => el('option', { value: n.id }, '🖥 ' + (n.name || n.id) + (n.shared ? ' (공유)' : '') + (n.online ? '' : ' — 지금 꺼짐'))));
    nodeSel.value = ['', NODE_CENTRAL, ...nodes.map((n) => n.id)].includes(d.nodeDefault) ? d.nodeDefault : '';
    const nodeHint = el('div', { class: 'v2-def-hint' });
    const nameOf = (id: string): string => '🖥 ' + ((nodes.find((n) => n.id === id) || {}).name || id);
    const paintNodeHint = (): void => {
      const v = nodeSel.value;
      if (v === NODE_CENTRAL) { nodeHint.textContent = '지금 이 설정이면: 중앙 컴퓨터에서 열려요.'; return; }
      if (v) {
        const n = nodes.find((x) => x.id === v);
        nodeHint.textContent = n && n.online ? `지금 이 설정이면: ${nameOf(v)} 에서 열려요.`
          : `${nameOf(v)} 이(가) 지금 꺼져 있어요 — 켜질 때까지는 규칙대로(${defaultNodeId(nodes) ? nameOf(defaultNodeId(nodes)) : '중앙 컴퓨터'}) 열려요.`;
        return;
      }
      const r = defaultNodeId(nodes);
      nodeHint.textContent = '지금 이 설정이면: ' + (r ? `${nameOf(r)} 에서 열려요(켜져 있는 내 컴퓨터).` : '중앙 컴퓨터에서 열려요(켜진 내 컴퓨터가 없어요).');
    };
    nodeSel.addEventListener('change', paintNodeHint); paintNodeHint();

    // ── 라이블리 모드 ──
    let mode: LivelyMode = d.mode;
    const modeSeg = segmented('라이블리 모드', MODE_OPTS.map((m) => ({ v: m.key, t: m.lbl, d: m.sub })), mode, (v) => { mode = v as LivelyMode; syncVis(); });

    // ── 실행 승인 ──
    let auto = d.autoApprove;
    const okSeg = segmented('실행 승인', [
      { v: '', t: '확인 후 실행', d: '위험한 일은 물어봐요' },
      { v: 'auto', t: '자동 승인', d: '묻지 않고 바로 실행' },
    ], auto ? 'auto' : '', (v) => { auto = v === 'auto'; });
    okSeg.disable(!opts.hasAutoApprove);
    const okHint = el('div', { class: 'v2-def-hint', text: opts.hasAutoApprove
      ? '자동 승인은 빠르지만 실수도 그대로 실행돼요. 여러 사람이 함께 쓰는 폴더에서는 「확인 후 실행」을 권해요.'
      : '지금 고른 AI 에는 자동 승인 기능이 없어 고를 수 없어요.' });

    // ── 기록 범위 ──
    const visSel = el('select', { class: 'term-input v2-def-sel', 'aria-label': '기록 범위' }) as HTMLSelectElement;
    visSel.replaceChildren(...WRITE_VIS_OPTS.map((o) => el('option', { value: o.v }, o.t + ' — ' + o.d)));
    visSel.value = d.writeVis;
    const visHint = el('div', { class: 'v2-def-hint' });
    const syncVis = (): void => {
      const locked = mode !== 'normal';
      visSel.disabled = locked;
      visHint.textContent = locked ? '읽기전용·인코그니토에서는 기록을 남기지 않아 고를 수 없어요.' : 'AI 가 내 확인 없이 남기는 작업 기록에만 적용돼요.';
    };
    syncVis();

    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '취소', onclick: () => finish(false) }) as HTMLButtonElement;
    const save = el('button', { class: 'btn btn-primary', type: 'button', text: '저장', onclick: () => {
      saveSessionDefaults({ nodeDefault: nodeSel.value, mode, autoApprove: opts.hasAutoApprove ? auto : d.autoApprove, writeVis: visSel.value });
      finish(true);
    } }) as HTMLButtonElement;
    const close = el('button', { class: 'v2-def-x', type: 'button', 'aria-label': '닫기', text: '✕', onclick: () => finish(false) });

    const box = el('div', { class: 'ov-box v2-def-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '새 세션 기본값' },
      el('div', { class: 'ov-head' }, el('h3', { text: '새 세션 기본값' }), close),
      el('p', { class: 'v2-def-lead', text: '홈과 프로젝트의 [시키기]로 여는 모든 새 세션에 적용돼요. 하나만 다르게 열려면 「새 AI 세션」 폼을 쓰세요.' }),
      nodes.length ? field('실행 컴퓨터', HELP.node, nodeSel, nodeHint) : null,
      field('라이블리 모드', HELP.mode, modeSeg.el),
      field('실행 승인', HELP.approve, okSeg.el, okHint),
      visAxisOn('session_cap') ? field('작업 기록 범위', HELP.vis, visSel, visHint) : null,
      el('div', { class: 'v2-def-acts' }, cancel, save));
    const back = el('div', { class: 'ov-back ov-confirm-back' }, box);
    back.addEventListener('click', (e) => { if (e.target === back) finish(false); });
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') finish(false);
      // 엔터는 '포커스된 저장 단추'만 누른다 — 기본 포커스는 취소라 무심코 엔터를 쳐도 값이 바뀌지 않는다(confirmDialog 와 같은 규약).
      if (ev.key === 'Enter' && document.activeElement === save) save.click();
    };
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    cancel.focus();
  });
}
