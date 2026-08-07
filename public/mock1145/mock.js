// #1145 새 AI 세션 모달 — 정보구조 시안 4안(동작하는 목업). 라이브 CSS·부품 그대로.
//  · 접힌 줄은 실제로 눌러 펼칠 수 있고, 펼친 내용까지 들어 있다.
//  · 카드는 실제로 선택된다. 라이블리 모드를 읽기전용/인코그니토로 바꾸면 기록 범위가 잠긴다(공통 규칙).
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (v == null) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'onclick') n.onclick = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) n.append(c);
  return n;
};
const field = (label, ctrl, info) => el('div', { class: 'field' },
  info ? el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), el('button', { class: 'hint-i', type: 'button' }, el('span', { text: 'ⓘ' })))
       : el('label', { class: 'field-label', text: label }),
  ctrl);
const input = (ph) => el('input', { class: 'term-input', type: 'text', placeholder: ph });
const select = (...opts) => el('select', { class: 'term-input' }, ...opts.map((o) => el('option', { text: o })));

const ROOTS = [{ ico: '👥', t: '공유 워크스페이스', d: '팀과 함께 쓰는 폴더' }, { ico: '🔒', t: '개인 폴더', d: '나만 쓰는 폴더' }];
const MODES = [{ t: '일반', d: '읽고 씁니다' }, { t: '읽기전용', d: '읽기만 합니다' }, { t: '인코그니토', d: '쓰지 않습니다' }];
const VIS = [{ t: '자동', d: '위치를 따릅니다' }, { t: '전체 공개', d: '누구나 봅니다' }, { t: '프로젝트', d: '그 팀만 봅니다' }, { t: '나만', d: '나만 봅니다' }];

// 선택 카드 묶음 — onPick(i) 로 바깥에 선택을 알린다.
function seg(items, activeIdx = 0, withIco = false, onPick) {
  const btns = [];
  const box = el('div', { class: 'term-seg' }, ...items.map((it, i) => {
    const b = el('button', { class: 'term-seg-btn' + (i === activeIdx ? ' active' : ''), type: 'button' },
      withIco && it.ico ? el('span', { class: 'term-seg-ico', text: it.ico }) : null,
      el('span', { class: 'term-seg-txt' },
        el('span', { class: 'term-seg-lbl', text: it.t }),
        el('span', { class: 'term-seg-sub', text: it.d })),
      el('span', { class: 'term-seg-check' }));
    b.onclick = (e) => { e.preventDefault(); btns.forEach((x, j) => x.classList.toggle('active', j === i)); onPick && onPick(i); };
    btns.push(b); return b;
  }));
  return box;
}

const folderBlock = () => el('div', { class: 'term-loc' }, seg(ROOTS, 0, true),
  el('div', { class: 'term-loc-folder' }, el('div', { class: 'term-picker' },
    el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: '공유 워크스페이스' })),
    select('하위 폴더로 이동…', '📁 project', '📁 productivity', '＋ 새 폴더 만들기…'),
    el('div', { class: 'term-runhere' }, el('span', { class: 'term-runhere-ic', text: '▶' }),
      el('span', { class: 'term-runhere-txt' }, el('b', { text: '이 폴더에서 AI 실행 · 공유 워크스페이스' }))))));

const presetRow = () => el('div', { class: 'term-preset-body', style: 'display:block;margin-top:0' },
  el('div', { class: 'term-preset-row', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' },
    el('div', { style: 'flex:1 1 120px;min-width:0' }, field('실행 (AI)', select('Claude Code', 'Codex', '셸 (에이전트 없음)'))),
    el('div', { class: 'term-flags', style: 'display:flex;flex-direction:row;gap:10px;flex-wrap:wrap;flex:2 1 240px;min-width:0' },
      el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '모델' }), select('(자동)', 'opus', 'sonnet', 'haiku')),
      el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '추론강도(effort)' }), select('(자동)', 'low', 'medium', 'high', 'xhigh', 'max')))),
  el('div', { class: 'caption', text: '🔐 내 AI 세션은 내 격리 계정으로 실행됩니다.' }));

const checks = (withAuto = true) => el('div', { class: 'term-checks' },
  withAuto ? el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.' })) : null,
  el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 이 설정을 기억하기 — 다음에 새 AI 세션을 열면 지금 고른 값이 그대로 채워집니다.' })));

const invite = () => field('초대 (비우면 나만 보는 비공개 세션)',
  el('div', { class: 'proj-mp' }, el('div', { class: 'proj-mp-ta' }, el('input', { class: 'proj-mp-search', type: 'text', placeholder: '이름으로 검색해 추가…' }))));

const lockNote = () => el('div', { class: 'term-lock-note' },
  el('span', { text: '🔒' }),
  el('span', { text: '읽기전용·인코그니토에서는 라이블리에 기록하지 않으므로 기록 범위를 고르지 않습니다.' }));

// 라이블리 모드 + 기록 범위 한 묶음 — 모드에 따라 기록 범위가 잠긴다(모든 안 공통 규칙).
function permBlock(onSummary) {
  const visHost = el('div', {});
  let visIdx = 0;
  const paintVis = (modeIdx) => {
    if (modeIdx === 0) visHost.replaceChildren(field('기록 범위', seg(VIS, visIdx, false, (i) => { visIdx = i; onSummary && onSummary(modeIdx, visIdx); }), true));
    else visHost.replaceChildren(field('기록 범위', lockNote(), true));
    onSummary && onSummary(modeIdx, visIdx);
  };
  const modeSeg = seg(MODES, 0, false, (i) => paintVis(i));
  paintVis(0);
  return el('div', {}, field('라이블리 모드', modeSeg, true), visHost);
}

// 접이식 한 줄 — 누르면 아래 내용이 펼쳐진다(term-fold = 이미 있는 부품).
function fold(label, summaryFn, contentFn, open = false) {
  const caret = el('span', { class: 'term-fold-caret', text: open ? '▾' : '▸' });
  const sum = el('span', { style: 'color:var(--muted-head)' });
  const body = el('div', { style: 'margin:2px 0 0 2px;padding:0 0 4px', ...(open ? {} : { hidden: '' }) }, contentFn());
  const setSum = (t) => { sum.textContent = ' · ' + t; };
  setSum(summaryFn());
  const btn = el('button', { class: 'term-fold', type: 'button' }, caret, el('b', { text: label }), sum);
  btn.onclick = (e) => {
    e.preventDefault();
    const willOpen = body.hasAttribute('hidden');
    if (willOpen) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    caret.textContent = willOpen ? '▾' : '▸';
  };
  return { wrap: el('div', {}, btn, body), setSum };
}

const section = (title, desc, ...kids) => el('section', { class: 'term-section term-section--div' },
  el('h4', { class: 'term-section-title', text: title }),
  desc ? el('p', { class: 'term-section-desc caption', text: desc }) : null, ...kids);

const modal = (title, ...body) => el('div', { class: 'ov-back', style: 'position:static;padding:0;background:none;display:block' },
  el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' })),
    ...body, el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '생성하기' }))));

// ── 안 A: 섹션으로 묶되 전부 보인다 ──
const planA = () => modal('새 AI 세션',
  field('이름', input('예: 랜딩 카피 수정')),
  section('어디서 일할까요', 'AI 가 돌아갈 컴퓨터와 작업 폴더를 정합니다.',
    field('실행 위치', select('중앙 컴퓨터 (기본)', '🖥 내 맥미니'), true), field('폴더', folderBlock(), true)),
  section('무엇을 남길까요', '이 세션이 라이블리에 쓸 수 있는 범위입니다.', permBlock()),
  section('어떻게 실행할까요', null, presetRow(), invite(), checks()));

// ── 안 B: 그룹마다 요약 한 줄로 접는다 ──
function planB() {
  const MODE_T = ['일반', '읽기전용', '인코그니토'], VIS_T = ['기록 자동', '기록 전체 공개', '기록 프로젝트', '기록 나만'];
  let sm = 0, sv = 0;
  // perm 은 fold() 안에서 contentFn 이 **즉시** 실행되므로, 콜백이 도는 시점엔 아직 대입 전이다 — 가드해서 쓴다.
  let perm;
  perm = fold('권한과 기록', () => MODE_T[sm] + (sm === 0 ? ' · ' + VIS_T[sv] : ' · 기록 안 함'),
    () => permBlock((m, v) => { sm = m; sv = v; if (perm) perm.setSum(MODE_T[m] + (m === 0 ? ' · ' + VIS_T[v] : ' · 기록 안 함')); }));
  const node = fold('실행 위치', () => '중앙 컴퓨터', () => select('중앙 컴퓨터 (기본)', '🖥 내 맥미니'));
  const run = fold('실행 설정', () => 'Claude Code · 모델 자동 · 추론강도 자동', () => presetRow());
  const inv = fold('초대', () => '비공개 (나만)', () => invite());
  return modal('새 AI 세션',
    field('이름', input('예: 랜딩 카피 수정')),
    field('어디서 실행할까요', folderBlock(), true),
    node.wrap, perm.wrap, run.wrap, inv.wrap, checks());
}

// ── 안 C: 기본은 셋뿐, 나머지는 '고급 설정' 하나로 ──
function planC() {
  const adv = fold('고급 설정', () => '실행 위치 · 라이블리 모드 · 기록 범위 · 모델',
    () => el('div', {}, field('실행 위치', select('중앙 컴퓨터 (기본)', '🖥 내 맥미니'), true), permBlock(), presetRow(),
      el('div', { class: 'term-checks' }, el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요.' })))));
  return modal('새 AI 세션',
    field('이름', input('예: 랜딩 카피 수정')),
    field('어디서 실행할까요', folderBlock(), true),
    invite(), adv.wrap, checks(false));
}

// ── 안 D: 설정 전체를 한 줄 요약 + 펼치기 ──
function planD() {
  const chev = el('span', { class: 'term-preset-chev', text: '▾' });
  const body = el('div', { hidden: '' },
    field('실행 위치', select('중앙 컴퓨터 (기본)', '🖥 내 맥미니'), true), permBlock(), presetRow(), invite());
  const bar = el('button', { class: 'term-preset-toggle', type: 'button' },
    el('div', { class: 'term-preset-sum' }, el('b', { text: '이 세션 설정' }),
      document.createTextNode(' · Claude Code · 모델 자동 · 일반 · 기록 자동 · 중앙 컴퓨터 · 비공개')), chev);
  bar.onclick = (e) => { e.preventDefault(); const o = body.hasAttribute('hidden'); if (o) body.removeAttribute('hidden'); else body.setAttribute('hidden', ''); chev.textContent = o ? '▴' : '▾'; };
  return modal('새 AI 세션',
    field('이름', input('예: 랜딩 카피 수정')),
    field('어디서 실행할까요', folderBlock(), true),
    bar, body, checks());
}

const mount = (id, node) => document.getElementById(id).replaceChildren(node);
mount('a', planA()); mount('b', planB()); mount('c', planC()); mount('d', planD());
document.title = 'ready';
