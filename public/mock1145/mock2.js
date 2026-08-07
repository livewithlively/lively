// #1145 2차 — '세션 여는 모든 경로를 한 모달로' 시안. 제약: 기본 상태에서 **스크롤 금지**(뷰포트 88vh 안).
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) { if (v == null) continue; if (k === 'text') n.textContent = v; else if (k === 'onclick') n.onclick = v; else n.setAttribute(k, v); }
  for (const c of kids.flat()) if (c) n.append(c);
  return n;
};
const field = (label, ctrl, info) => el('div', { class: 'field' },
  info ? el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), el('button', { class: 'hint-i', type: 'button' }, el('span', { text: 'ⓘ' })))
       : el('label', { class: 'field-label', text: label }), ctrl);
const input = (ph) => el('input', { class: 'term-input', type: 'text', placeholder: ph });
const select = (...o) => el('select', { class: 'term-input' }, ...o.map((x) => el('option', { text: x })));

function seg(items, active = 0, ico = false, onPick, cls = '') {
  const btns = [];
  const box = el('div', { class: 'term-seg ' + cls }, ...items.map((it, i) => {
    const b = el('button', { class: 'term-seg-btn' + (i === active ? ' active' : '') + (it.off ? ' term-seg-btn--off' : ''), type: 'button' },
      ico && it.ico ? el('span', { class: 'term-seg-ico', text: it.ico }) : null,
      el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: it.t }), el('span', { class: 'term-seg-sub', text: it.d })),
      el('span', { class: 'term-seg-check' }));
    b.onclick = (e) => { e.preventDefault(); if (it.off) return; btns.forEach((x, j) => x.classList.toggle('active', j === i)); onPick && onPick(i); };
    btns.push(b); return b;
  }));
  return box;
}
const WHERE = [{ ico: '☁️', t: '웹에서 열기', d: '설치 없이 바로 씁니다' }, { ico: '💻', t: '내 PC에서 열기', d: '실행 명령을 알려드립니다' }];
const KIND = [{ ico: '🗂', t: '프로젝트 세션', d: '팀이 함께 보고 맥락이 들어갑니다' }, { ico: '👤', t: '자유 세션', d: '나만 보고 폴더를 직접 고릅니다' }];
const ROOTS = [{ ico: '👥', t: '공유 워크스페이스', d: '팀과 함께 쓰는 폴더' }, { ico: '🔒', t: '개인 폴더', d: '나만 쓰는 폴더' }];

const folderBlock = () => el('div', { class: 'term-loc' }, seg(ROOTS, 0, true),
  el('div', { class: 'term-loc-folder' }, el('div', { class: 'term-picker' },
    el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: '공유 워크스페이스' })),
    select('하위 폴더로 이동…'),
    el('div', { class: 'term-runhere' }, el('span', { class: 'term-runhere-ic', text: '▶' }),
      el('span', { class: 'term-runhere-txt' }, el('b', { text: '이 폴더에서 AI 실행 · 공유 워크스페이스' }))))));

// 프로젝트로 고정된 폴더 — '비활성'이 아니라 '이미 정해졌고 그게 이득'으로 읽히게 한다.
const projFolderLocked = () => el('div', { class: 'term-proj-lock' },
  el('div', { class: 'term-proj-lock-head' }, el('span', { text: '🗂' }),
    el('b', { text: '라이블리 종합 UI 수정' }), el('span', { class: 'pill', text: '프로젝트 세션' })),
  el('div', { class: 'term-proj-lock-body' },
    el('div', { class: 'term-runhere' }, el('span', { class: 'term-runhere-ic', text: '▶' }),
      el('span', { class: 'term-runhere-txt' }, el('b', { text: '이 폴더에서 AI 실행 · project/1145' }))),
    el('ul', { class: 'term-proj-why' },
      el('li', { text: '이 프로젝트 폴더에서 열립니다 — 폴더를 고르지 않아도 됩니다.' }),
      el('li', { text: '프로젝트 본문·연결된 지식·규칙이 세션에 자동으로 들어갑니다.' }),
      el('li', { text: '이 프로젝트를 볼 수 있는 사람은 모두 이 세션을 보고 이어받을 수 있습니다.' }))));

const localGuide = () => el('div', { class: 'term-local-guide' },
  el('p', { class: 'caption', text: '내 PC 터미널에 붙여넣을 한 줄을 만들어 드립니다. 웹은 그 화면을 보지 않습니다.' }),
  el('pre', { class: 'term-cmd', text: 'node ~/.lively/work.mjs 1145 --repo lively' }),
  el('div', {}, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '명령 복사' })));

const advFold = (summary) => {
  const body = el('div', { class: 'term-adv-body', hidden: '' },
    field('실행 위치', select('중앙 컴퓨터 (기본)', '🖥 내 맥미니'), true),
    field('라이블리 모드', seg([{ t: '일반', d: '읽고 씁니다' }, { t: '읽기전용', d: '읽기만 합니다' }, { t: '인코그니토', d: '쓰지 않습니다' }]), true),
    field('기록 범위', seg([{ t: '자동', d: '위치를 따릅니다' }, { t: '전체 공개', d: '누구나 봅니다' }, { t: '프로젝트', d: '그 팀만 봅니다' }, { t: '나만', d: '나만 봅니다' }]), true),
    el('div', { class: 'term-preset-body', style: 'margin-top:0' },
      el('div', { class: 'term-preset-row', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' },
        el('div', { style: 'flex:1 1 120px;min-width:0' }, field('실행 (AI)', select('Claude Code'))),
        el('div', { class: 'term-flags', style: 'display:flex;flex-direction:row;gap:10px;flex-wrap:wrap;flex:2 1 240px;min-width:0' },
          el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '모델' }), select('지난번 그대로')),
          el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: '추론강도(effort)' }), select('지난번 그대로'))))),
    el('div', { class: 'term-checks' }, el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요.' }))));
  const caret = el('span', { class: 'term-fold-caret', text: '▸' });
  const btn = el('button', { class: 'term-fold', type: 'button' }, caret, el('b', { text: '고급 설정' }), el('span', { class: 'term-fold-sum', text: ' · ' + summary }));
  btn.onclick = (e) => { e.preventDefault(); const o = body.hasAttribute('hidden'); if (o) body.removeAttribute('hidden'); else body.setAttribute('hidden', ''); caret.textContent = o ? '▾' : '▸'; };
  return el('div', {}, btn, body);
};
const invite = () => field('초대 (비우면 나만 보는 비공개 세션)',
  el('div', { class: 'proj-mp' }, el('div', { class: 'proj-mp-ta' }, el('input', { class: 'proj-mp-search', type: 'text', placeholder: '이름으로 검색해 추가…' }))));
// 프로젝트 세션의 초대 — canSeeSession(write-cap.ts)은 프로젝트 세션에서 invites 를 **보지 않는다**.
//  가시성은 리스트 공개범위가 정한다 → 칸은 남기되 왜 못 쓰는지 적고 잠근다.
const inviteProject = (listPublic = true) => field('초대', el('div', {},
  el('div', { class: 'term-lock-note' }, el('span', { text: '🗂' }),
    el('span', {}, el('b', { text: listPublic ? '이 프로젝트를 볼 수 있는 사람은 모두' : '이 리스트를 볼 수 있는 사람만' }),
      document.createTextNode(listPublic
        ? ' 이 세션을 봅니다 — 지금 이 리스트는 잠겨 있지 않아 조직 전원이 볼 수 있습니다.'
        : ' 이 세션을 봅니다 — 이 리스트는 잠겨 있습니다.'))),
  el('div', { class: 'proj-mp', style: 'opacity:.5;pointer-events:none;margin-top:6px' },
    el('div', { class: 'proj-mp-ta' }, el('input', { class: 'proj-mp-search', type: 'text', disabled: 'true', placeholder: '프로젝트 세션은 따로 초대하지 않습니다' })))), true);
const remember = () => el('div', { class: 'term-checks' },
  el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 이 설정을 기억하기 — 다음에 열면 그대로 채워집니다.' })));

const modal = (title, ...body) => el('div', { class: 'ov-back', style: 'position:static;padding:0;background:none;display:block' },
  el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' })),
    ...body, el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '생성하기' }))));

// ── 안 1: 맨 위 웹/내 PC 2택 → 고른 쪽 내용이 아래에 ──
function plan1(asProject) {
  const host = el('div', {});
  const paint = (i) => host.replaceChildren(i === 0
    ? el('div', {}, field('이름', input('예: 랜딩 카피 수정')),
        asProject ? field('어디서 실행할까요', projFolderLocked(), true) : field('어디서 실행할까요', folderBlock(), true),
        asProject ? inviteProject(true) : invite(),
        advFold('Claude Code · 모델 지난번 그대로 · 일반 · 기록 자동'), remember())
    : el('div', {}, localGuide(), advFold('레포 · 워크트리 · 모델')));
  paint(0);
  return modal('새 AI 세션', field('어떻게 열까요', seg(WHERE, 0, true, paint), true), host);
}

// ── 안 2: 종류 3택(프로젝트/자유/내 PC)을 한 줄에 ──
function plan2() {
  const host = el('div', {});
  const KIND3 = [{ ico: '🗂', t: '프로젝트', d: '팀이 함께 봅니다' }, { ico: '👤', t: '자유', d: '나만 봅니다' }, { ico: '💻', t: '내 PC', d: '명령을 받습니다' }];
  const paint = (i) => host.replaceChildren(i === 2 ? el('div', {}, localGuide(), advFold('레포 · 워크트리 · 모델'))
    : el('div', {}, field('이름', input('예: 랜딩 카피 수정')),
        i === 0 ? field('프로젝트', el('div', {}, select('라이블리 종합 UI 수정 (#1145)', '웹 터미널 개선 (#1117)'), projFolderLocked()), true)
                : field('어디서 실행할까요', folderBlock(), true),
        invite(), advFold('Claude Code · 일반 · 기록 자동'), remember()));
  paint(0);
  return modal('새 AI 세션', field('무엇을 만들까요', seg(KIND3, 0, true, paint), true), host);
}

// ── 안 3: 2단계 — 1단계에서 어디서·무엇에, [다음] 누르면 2단계 ──
function plan3() {
  return el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap' },
    el('div', { style: 'flex:1 1 380px;min-width:0' },
      el('p', { class: 'plan-sub', text: '1단계 — 어디서·무엇에' }),
      modal('새 AI 세션', field('어떻게 열까요', seg(WHERE, 0, true), true), field('무엇에 붙일까요', seg(KIND, 0, true), true))),
    el('div', { style: 'flex:1 1 380px;min-width:0' },
      el('p', { class: 'plan-sub', text: '2단계 — 세부 (지금 C안 그대로)' }),
      modal('새 AI 세션 · 프로젝트', field('이름', input('예: 랜딩 카피 수정')),
        field('어디서 실행할까요', projFolderLocked(), true), invite(), advFold('Claude Code · 일반 · 기록 자동'), remember())));
}

// ── 안 4: 맥락 배너 + 실행 위치를 '중앙/내 PC' 한 줄로 흡수 ──
function plan4(asProject) {
  return modal('새 AI 세션',
    el('div', { class: 'term-ctx-banner' + (asProject ? ' on' : '') },
      el('span', { text: asProject ? '🗂' : '👤' }),
      el('span', { class: 'term-ctx-txt' }, el('b', { text: asProject ? '라이블리 종합 UI 수정' : '자유 세션' }),
        el('span', { class: 'caption', text: asProject ? ' · 이 프로젝트 폴더에서 열리고, 팀이 함께 봅니다.' : ' · 폴더를 직접 고르고, 기본은 나만 봅니다.' })),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: asProject ? '프로젝트 바꾸기' : '프로젝트에 연결' })),
    field('이름', input('예: 랜딩 카피 수정')),
    asProject ? null : field('어디서 실행할까요', folderBlock(), true),
    field('어느 컴퓨터에서', seg([{ ico: '☁️', t: '중앙 컴퓨터', d: '노트북을 꺼도 계속 돕니다' }, { ico: '💻', t: '내 PC', d: '명령을 받아 직접 실행합니다' }], 0, true), true),
    invite(), advFold('Claude Code · 일반 · 기록 자동'), remember());
}

const mount = (id, n) => document.getElementById(id).replaceChildren(n);
mount('p1', plan1(false)); mount('p1p', plan1(true));
mount('p2', plan2()); mount('p3', plan3());
mount('p4', plan4(false)); mount('p4p', plan4(true));
// 스크롤 한계선 — .ov-back 이 padding 6vh 라 실제 가용 높이는 88vh. 900px 화면이면 792px.
document.querySelectorAll('.plan').forEach((p) => {
  const box = p.querySelector('.ov-box'); if (!box) return;
  const h = Math.round(box.getBoundingClientRect().height);
  const tag = p.querySelector('.plan-h');
  if (tag) tag.append(el('span', { class: h > 792 ? 'plan-bad' : 'plan-ok', text: `  높이 ${h}px ${h > 792 ? '— 900px 화면에서 스크롤 발생' : '— 스크롤 없음(900px 화면 기준)'}` }));
});
document.title = 'ready';
