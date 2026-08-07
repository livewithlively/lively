// #1145 — 고급 설정 안의 '라이블리 모드'(3카드) + '기록 범위'(4카드) = 7카드를 정리하는 안 비교.
const el = (t, a = {}, ...k) => {
  const n = document.createElement(t);
  for (const [key, v] of Object.entries(a)) { if (v == null) continue; if (key === 'text') n.textContent = v; else if (key === 'onclick') n.onclick = v; else n.setAttribute(key, v); }
  for (const c of k.flat()) if (c) n.append(c);
  return n;
};
const fieldI = (label, ctrl) => el('div', { class: 'field' },
  el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), el('button', { class: 'hint-i', type: 'button' }, el('span', { text: 'ⓘ' }))), ctrl);
const sel = (...o) => el('select', { class: 'term-input' }, ...o.map((x) => el('option', { text: x })));
const seg = (items, active = 0) => el('div', { class: 'term-seg' }, ...items.map((it, i) =>
  el('button', { class: 'term-seg-btn' + (i === active ? ' active' : ''), type: 'button' },
    el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: it.t }), el('span', { class: 'term-seg-sub', text: it.d })),
    el('span', { class: 'term-seg-check' }))));

const MODES = [{ t: '일반', d: '읽고 씁니다' }, { t: '읽기전용', d: '읽기만 합니다' }, { t: '인코그니토', d: '쓰지 않습니다' }];
const VIS = [{ t: '자동', d: '위치를 따릅니다' }, { t: '전체 공개', d: '누구나 봅니다' }, { t: '프로젝트', d: '그 팀만 봅니다' }, { t: '나만', d: '나만 봅니다' }];

const presetRow = () => el('div', { class: 'term-preset-body', style: 'margin-top:0' },
  el('div', { class: 'term-preset-row', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' },
    el('div', { style: 'flex:1 1 120px;min-width:0' }, el('div', { class: 'field' }, el('label', { class: 'field-label', text: '실행 (AI)' }), sel('Claude Code'))),
    el('div', { class: 'term-flags', style: 'display:flex;flex-direction:row;gap:10px;flex-wrap:wrap;flex:2 1 240px;min-width:0' },
      el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '모델' }), sel('지난번 그대로')),
      el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '추론강도(effort)' }), sel('지난번 그대로')))));
const autoRow = () => el('div', { class: 'term-checks' },
  el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요.' })));
const node = () => fieldI('실행 위치', sel('중앙 컴퓨터 (기본)'));

const advBox = (...kids) => el('div', { class: 'ov-box', style: 'padding:16px 18px' },
  el('div', { class: 'term-fold', style: 'pointer-events:none' }, el('span', { class: 'term-fold-caret', text: '▾' }), el('b', { text: '고급 설정' })),
  el('div', { class: 'term-adv-body' }, ...kids));

// ── 지금 (7카드) ──
const now = () => advBox(node(), fieldI('라이블리 모드', seg(MODES)), fieldI('기록 범위', seg(VIS)), presetRow(), autoRow());

// ── 안 A: 두 축을 드롭다운으로 — 실행 설정과 같은 줄 언어로 통일 ──
const planA = () => advBox(
  el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' },
    el('div', { style: 'flex:1 1 150px;min-width:0' }, fieldI('실행 위치', sel('중앙 컴퓨터 (기본)'))),
    el('div', { style: 'flex:1 1 150px;min-width:0' }, fieldI('라이블리 모드', sel('일반 — 읽고 씁니다', '읽기전용 — 읽기만 합니다', '인코그니토 — 쓰지 않습니다'))),
    el('div', { style: 'flex:1 1 150px;min-width:0' }, fieldI('기록 범위', sel('자동 — 위치를 따릅니다', '전체 공개', '프로젝트', '나만')))),
  presetRow(), autoRow());

// ── 안 B: 두 축을 하나로 합쳐 단일 드롭다운 ──
const planB = () => advBox(node(),
  fieldI('라이블리에 무엇을 할까요', sel(
    '읽고 씁니다 · 기록은 위치를 따릅니다 (기본)',
    '읽고 씁니다 · 기록을 누구나 봅니다',
    '읽고 씁니다 · 기록을 그 팀만 봅니다',
    '읽고 씁니다 · 기록을 나만 봅니다',
    '읽기만 합니다 · 기록하지 않습니다',
    '라이블리를 아예 쓰지 않습니다')),
  presetRow(), autoRow());

// ── 안 C: 카드는 두되 한 줄짜리 칩으로 축소(부제는 ⓘ 로) ──
const chip = (items, active = 0) => el('div', { class: 'term-chips' }, ...items.map((it, i) =>
  el('button', { class: 'term-chip' + (i === active ? ' active' : ''), type: 'button', text: it.t })));
const planC = () => advBox(
  el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' },
    el('div', { style: 'flex:1 1 150px;min-width:0' }, fieldI('실행 위치', sel('중앙 컴퓨터 (기본)')))),
  fieldI('라이블리 모드', chip(MODES)),
  fieldI('기록 범위', chip(VIS)),
  presetRow(), autoRow());

const mount = (id, n) => document.getElementById(id).replaceChildren(n);
mount('now', now()); mount('a', planA()); mount('b', planB()); mount('c', planC());
document.querySelectorAll('.plan').forEach((p) => {
  const box = p.querySelector('.ov-box'); if (!box) return;
  const h = Math.round(box.getBoundingClientRect().height);
  p.querySelector('.plan-h')?.append(el('span', { class: 'plan-ok', text: `  고급 설정 높이 ${h}px` }));
});
document.title = 'ready';
