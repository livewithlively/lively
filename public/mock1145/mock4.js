// #1145 — '웹 / 내 PC' 를 나머지 필드보다 **위계 높게** 보여주는 안 비교.
const el = (t, a = {}, ...k) => {
  const n = document.createElement(t);
  for (const [key, v] of Object.entries(a)) { if (v == null) continue; if (key === 'text') n.textContent = v; else if (key === 'onclick') n.onclick = v; else n.setAttribute(key, v); }
  for (const c of k.flat()) if (c) n.append(c);
  return n;
};
const fieldI = (label, ctrl) => el('div', { class: 'field' },
  el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), el('button', { class: 'hint-i', type: 'button' }, el('span', { text: 'ⓘ' }))), ctrl);
const field = (label, ctrl) => el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), ctrl);
const sel = (...o) => el('select', { class: 'term-input' }, ...o.map((x) => el('option', { text: x })));
const inp = (ph) => el('input', { class: 'term-input', type: 'text', placeholder: ph });

const folder = () => el('div', { class: 'term-loc' },
  el('div', { class: 'term-seg' }, ...[['👥', '공유 워크스페이스', '팀과 함께 쓰는 폴더'], ['🔒', '개인 폴더', '나만 쓰는 폴더']].map(([i, t, d], n) =>
    el('button', { class: 'term-seg-btn' + (n === 0 ? ' active' : ''), type: 'button' },
      el('span', { class: 'term-seg-ico', text: i }),
      el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: t }), el('span', { class: 'term-seg-sub', text: d })),
      el('span', { class: 'term-seg-check' })))),
  el('div', { class: 'term-loc-folder' }, el('div', { class: 'term-picker' },
    el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: '공유 워크스페이스' })),
    sel('하위 폴더로 이동…'),
    el('div', { class: 'term-runhere' }, el('span', { class: 'term-runhere-ic', text: '▶' }),
      el('span', { class: 'term-runhere-txt' }, el('b', { text: '이 폴더에서 AI 실행 · 공유 워크스페이스' }))))));
const rest = () => [
  field('이름', inp('예: 랜딩 카피 수정')),
  fieldI('어디서 실행할까요', folder()),
  field('초대 (비우면 나만 보는 비공개 세션)', el('div', { class: 'proj-mp' }, el('div', { class: 'proj-mp-ta' }, el('input', { class: 'proj-mp-search', type: 'text', placeholder: '이름으로 검색해 추가…' })))),
  el('button', { class: 'term-fold', type: 'button' }, el('span', { class: 'term-fold-caret', text: '▸' }), el('b', { text: '고급 설정' }),
    el('span', { class: 'term-fold-sum', text: ' · Claude Code · 일반 · 기록 자동' })),
  el('div', { class: 'term-checks' }, el('label', { class: 'term-auto' }, el('input', { type: 'checkbox' }), el('span', { text: ' 이 설정을 기억하기 — 다음에 열면 그대로 채워집니다.' }))),
];
const WHERE = [['☁️', '웹에서 열기', '설치 없이 바로 씁니다'], ['💻', '내 PC에서 열기', '실행 명령을 알려드립니다']];

const shell = (head, ...body) => el('div', { class: 'ov-box' },
  el('div', { class: 'ov-head' }, el('h3', { text: '새 AI 세션' }), el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' })),
  head, ...body, el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '생성하기' })));

// ── 지금 — 다른 필드와 동급(라벨 + 카드) ──
const now = () => shell(fieldI('어떻게 열까요', el('div', { class: 'term-seg' }, ...WHERE.map(([i, t, d], n) =>
  el('button', { class: 'term-seg-btn' + (n === 0 ? ' active' : ''), type: 'button' },
    el('span', { class: 'term-seg-ico', text: i }),
    el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: t }), el('span', { class: 'term-seg-sub', text: d })),
    el('span', { class: 'term-seg-check' }))))), ...rest());

// ── 안 A: 밑줄 탭(.seg-tabs) — 제목 바로 아래, 라벨 없음 ──
const planA = () => shell(
  el('div', { class: 'seg-tabs', style: 'margin:0 0 14px' },
    el('button', { class: 'on', type: 'button', text: '☁️  웹에서 열기' }),
    el('button', { type: 'button', text: '💻  내 PC에서 열기' })),
  ...rest());

// ── 안 B: 상단 밴드 — 옅은 배경으로 감싸고 구분선으로 본문과 분리 ──
const planB = () => shell(
  el('div', { class: 'where-band' },
    el('div', { class: 'where-band-q', text: '이 세션을 어디서 열까요?' }),
    el('div', { class: 'term-seg' }, ...WHERE.map(([i, t, d], n) =>
      el('button', { class: 'term-seg-btn' + (n === 0 ? ' active' : ''), type: 'button' },
        el('span', { class: 'term-seg-ico', text: i }),
        el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: t }), el('span', { class: 'term-seg-sub', text: d })),
        el('span', { class: 'term-seg-check' }))))),
  ...rest());

// ── 안 C: 제목 줄에 pill 세그먼트 — 헤더와 한 몸 ──
const planC = () => {
  const box = el('div', { class: 'ov-box' },
    el('div', { class: 'ov-head', style: 'flex-wrap:wrap' },
      el('h3', { text: '새 AI 세션' }),
      el('div', { class: 'where-pill' },
        el('button', { class: 'on', type: 'button', text: '☁️ 웹' }),
        el('button', { type: 'button', text: '💻 내 PC' })),
      el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' })),
    ...rest(), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '생성하기' })));
  return box;
};

// ── 안 D: 큰 카드 2장을 라벨 없이 맨 위 + 굵은 구분선 ──
const planD = () => shell(
  el('div', { class: 'where-hero' }, ...WHERE.map(([i, t, d], n) =>
    el('button', { class: 'where-hero-btn' + (n === 0 ? ' active' : ''), type: 'button' },
      el('span', { class: 'where-hero-ic', text: i }),
      el('span', { class: 'where-hero-t', text: t }),
      el('span', { class: 'where-hero-d', text: d })))),
  ...rest());

const mount = (id, n) => document.getElementById(id).replaceChildren(n);
mount('now', now()); mount('a', planA()); mount('b', planB()); mount('c', planC()); mount('d', planD());
document.querySelectorAll('.plan').forEach((p) => {
  const box = p.querySelector('.ov-box'); if (!box) return;
  p.querySelector('.plan-h')?.append(el('span', { class: 'plan-ok', text: `  모달 높이 ${Math.round(box.getBoundingClientRect().height)}px` }));
});
document.title = 'ready';
