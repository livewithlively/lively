// review.ts — 지식 검토 정책(#783). 관리탭 2개 패널:
//   ① '지식 검토 정책' — 에이전트가 쓴 지식을 사람이 승인해야 유효해지게 할지(그리고 어디까지) 오너가 조절.
//   ② '검토 큐'        — 사람이 실제로 승인/반려하는 곳. 이 화면의 설계 목표는 단 하나: **인지비용 최소화**.
//
//  검토 큐 설계 원칙(사용자 요구 "사람 사용성 좋게, 인지비용 부담 적게"):
//   · 한 화면에 다 있다 — 신규 지식(pending)과 기존 지식 수정(revision)을 한 목록으로. 두 곳을 오갈 일이 없다.
//   · 판단에 필요한 것만 먼저 — 제목·도메인·누가 썼나·언제·(수정이면)±줄수. 나머지는 펼쳐야 나온다.
//   · 펼침은 제자리에서 — 신규는 본문 프리뷰+중복 경고, 수정은 줄단위 diff. 페이지 이동 0.
//   · 도메인별로 묶는다 — 자기 도메인만 훑고 나가는 게 가장 빠른 검토다(#638: 워킹레벨이 오너보다 잘 검토).
//   · 손이 안 떠난다 — j/k 이동 · Enter 펼침 · a 승인 · r 반려 · x 선택 → 일괄 승인.
//   · 되돌릴 수 있다 — 신규 반려=휴지통(복원 가능) · 수정 반려=수정 전으로 되돌리기.
import { api, busy, cardHead, el, errorNote, relTime, renderMarkdown, sv, toast } from './core.js';
import { confirmDialog } from './ui-primitives.js';
import { overlayBox, skeleton } from './learn.js';

// 관리탭 스위치가 관리하는 규칙의 표식 — 사람이 손으로 만든 세부 규칙과 구분(서버 org_ingest_policy.preset).
const GATE_PRESET = 'agent-knowledge';
// 도메인 필터의 '미분류' 센티넬 — 빈 문자열은 '모든 도메인'(전체) 값이라 겹친다.
const CAT_NONE = '__none__';
// #802 '내 도메인'(내 팀이 오너인 카테고리 전체) 센티넬 — 단일 카테고리 key 가 아니라 집합이라 별도 값이 필요하다.
const CAT_MINE = '__mine__';

// 신규 저장 시 동작 — 「제목 — 뜻」. 고르기 카드·규칙 줄·규칙 폼이 같은 표를 쓴다(#3830: 사람 말로).
const CREATE_ACTS: [string, string][] = [
  ['confirm', '확인한 뒤에 쓰기 — 확인 전에는 검색·AI 세션·목록에 나오지 않습니다'],
  ['auto', '바로 쓰기 — 확인 없이 곧바로 지식이 됩니다'],
  ['drop', '막기 — AI가 새 지식을 만들 수 없습니다'],
];
// 기존 지식 수정 시 동작.
const UPDATE_ACTS: [string, string][] = [
  ['review', '고친 대로 쓰고 나중에 확인 — 바로 반영하고, 무엇이 바뀌었는지 확인 목록에 쌓입니다'],
  ['stage', '확인한 뒤에 바꾸기 — 확인 전까지는 예전 내용이 쓰입니다'],
  ['auto', '바로 바꾸기 — 확인 없이 덮어씁니다'],
  ['drop', '막기 — AI가 기존 지식을 고칠 수 없습니다'],
];
/** 「제목 — 뜻」 한 줄을 둘로. */
function actParts(list: [string, string][], v: string): [string, string] {
  const hit = list.find((x) => x[0] === v);
  const t = hit ? hit[1] : String(v || '');
  const i = t.indexOf(' — ');
  return i > 0 ? [t.slice(0, i), t.slice(i + 3)] : [t, ''];
}
const HARNESSES = ['claude-code', 'codex', 'openclaw', 'cursor', 'cline', 'windsurf'];
const PAGE_TYPES = ['decision', 'concept', 'how-to', 'reference', 'research', 'entity'];
const TYPE_LABEL: Record<string, string> = {
  decision: '결정', concept: '개념', 'how-to': '런북', reference: '참조', research: '리서치', entity: '엔티티',
};


// 패널 전용 CSS 1회 주입(546KB styles.css 를 건드리지 않는 기존 관례 — admin.ts oaEnsureStyles 동형).
//  export: 다른 화면이 diffView(.rq-diff/.rq-dl)를 재사용할 수 있게 스타일도 함께 내보낸다.
export function rqEnsureStyles(): void {
  if (document.getElementById('rq-styles')) return;
  document.head.appendChild(el('style', {
    id: 'rq-styles',
    text: `
.rq-gate{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--bg-tint)}
.rq-gate-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rq-gate-title{font-size:15px;font-weight:800;color:var(--ink);flex:1}
.rq-gate-state{font-size:12.5px;color:var(--ink-sub);margin:8px 0 0;line-height:1.55}
.rq-gate-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:14px}
.rq-opt-label{display:block;font-size:11px;font-weight:700;color:var(--muted-head);margin-bottom:4px}
.rq-sel{width:100%;padding:7px 8px;font:inherit;font-size:13px;box-sizing:border-box;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.rq-sw{position:relative;width:46px;height:26px;border-radius:999px;border:1px solid var(--line);background:var(--muted-3);cursor:pointer;transition:background .15s;flex:none}
.rq-sw[aria-checked="true"]{background:var(--blue);border-color:var(--blue)}
.rq-sw::after{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--surface);transition:transform .15s}
.rq-sw[aria-checked="true"]::after{transform:translateX(20px)}
.rq-sw:disabled{opacity:.5;cursor:not-allowed}
.rq-stats{display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 14px}
.rq-stat{flex:1 1 110px;min-width:100px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg-tint)}
.rq-stat b{display:block;font-size:22px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}
.rq-stat span{font-size:11px;color:var(--muted)}
.rq-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.rq-chip{padding:4px 11px;border:1px solid var(--line);border-radius:999px;background:var(--bg);font-size:12px;font-weight:700;color:var(--ink-sub);cursor:pointer}
.rq-chip.on{background:var(--bg-punch);border-color:var(--node-blue-soft);color:var(--blue-deep)}
.rq-kbd{margin-left:auto;font-size:11px;color:var(--muted-2)}
.rq-kbd b{font-weight:700;color:var(--muted);font-family:ui-monospace,monospace}
.rq-group{margin-bottom:14px}
.rq-grouphead{display:flex;align-items:center;gap:8px;padding:6px 2px;font-size:11.5px;font-weight:800;color:var(--muted-head);text-transform:none}
.rq-groupcount{font-weight:700;color:var(--muted-2)}
.rq-rows{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.rq-row{border-bottom:1px solid var(--line-row)}
.rq-row:last-child{border-bottom:0}
.rq-row.cur{background:var(--bg-sel);box-shadow:inset 3px 0 0 var(--blue)}
.rq-row-main{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
.rq-row-main:hover{background:var(--bg-tint)}
.rq-chk{flex:none;width:15px;height:15px;cursor:pointer}
.rq-badge{flex:none;font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:6px;border:1px solid var(--line)}
.rq-badge.new{background:var(--bg-success);border-color:var(--node-mint-soft);color:var(--mint-deep)}
.rq-badge.edit{background:var(--bg-note);border-color:var(--line-note);color:var(--ink-note)}
.rq-title{flex:1;min-width:0;font-size:13.5px;font-weight:700;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rq-meta{flex:none;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--muted-head)}
.rq-delta{font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
.rq-delta .add{color:var(--mint-deep)}
.rq-delta .del{color:var(--coral-text)}
.rq-warn{color:var(--coral-text);font-weight:700}
.rq-acts{flex:none;display:flex;gap:6px;opacity:.55}
.rq-row:hover .rq-acts,.rq-row.cur .rq-acts,.rq-row:focus-within .rq-acts{opacity:1}
.rq-exp{padding:2px 12px 14px;background:var(--bg-tint)}
.rq-exp-note{font-size:12px;color:var(--ink-sub);margin:0 0 8px}
.rq-md{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--bg)}
.rq-dup{margin:0 0 8px;padding:8px 10px;border:1px solid var(--line-note);border-radius:9px;background:var(--bg-note);font-size:12px;color:var(--ink-note)}
.rq-dup a{color:var(--blue-deep);font-weight:700}
.rq-diff{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6}
.rq-dl{display:flex;white-space:pre-wrap;word-break:break-word;padding:0 10px}
.rq-dl.add{background:rgba(22,199,154,.10)}
.rq-dl.del{background:rgba(228,117,107,.10)}
.rq-dl .sig{flex:none;width:14px;color:var(--muted-2);user-select:none}
.rq-dl.add .sig{color:var(--mint-deep)}
.rq-dl.del .sig{color:var(--coral-text)}
.rq-dl.skip{color:var(--muted-2);font-style:italic;padding:3px 10px;background:var(--bg-tint);border-top:1px solid var(--line-row);border-bottom:1px solid var(--line-row)}
.rq-bulk{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:10px 12px;margin-top:12px;border:1px solid var(--line-net-2);border-radius:12px;background:var(--bg-punch)}
.rq-bulk b{font-size:13px;color:var(--ink)}
.rq-empty{padding:22px 14px;text-align:center;color:var(--muted);font-size:13px}
/* #802 관리탭 nav '검토 큐' 카운트 배지 — 대기 0이면 아예 안 그린다(nav 는 라벨만 두는 게 관례).
   톤은 지식탭 트리의 '검토' 배지(.kn-nav-review)와 같은 note 토큰 — 두 표면이 같은 것(검토 대기)을 가리키니 같아 보여야 한다. */
.rq-navn{display:none}
.rq-navn.on{display:inline-block;margin-left:8px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:800;
  font-variant-numeric:tabular-nums;color:var(--ink-note);background:var(--bg-note);border:1px solid var(--line-note)}
`,
  }));
}

// ════════ #802 관리탭 사이드 nav '검토 큐' 배지 — 큐가 관리탭 안에만 있어 방치되는 걸 막는 표면 ① ════════
//  nav 는 원래 라벨만이다(#613 부제 제거). 그래서 배지는 **대기가 0보다 클 때만** 나타난다 —
//  평소 화면은 지금과 완전히 동일하고, 쌓였을 때만 눈에 띈다(새 관례를 최소로 도입).
let rqBadgeEl: HTMLElement | null = null;
export function reviewNavBadge(): HTMLElement {
  rqEnsureStyles();
  const sp = el('span', { class: 'rq-navn', 'aria-label': '검토 대기' });
  rqBadgeEl = sp;
  void refreshReviewBadge();
  return sp;
}
// 큐에서 승인·반려하면 그 자리에서 배지도 줄인다(재요청 없이) — n 을 주면 그 값, 없으면 서버에서 다시 센다.
export async function refreshReviewBadge(n?: number): Promise<void> {
  const sp = rqBadgeEl;
  if (!sp) return;
  let total = n;
  if (total == null) {
    // 검토 권한(memory scope)이 없으면 403 — 배지 없이 조용히 지나간다(검토 못 하는 사람에게 알릴 이유가 없다).
    try { const s = await api('/api/ui/review-queue/summary'); total = Number((s && s.total) || 0); }
    catch { total = 0; }
  }
  if (sp !== rqBadgeEl) return;   // 그 사이 탭을 옮겨 다시 그렸으면(다른 배지 노드) 늦게 온 응답은 버린다
  sp.textContent = total > 0 ? String(total) : '';
  sp.classList.toggle('on', total > 0);
  sp.title = total > 0 ? `검토 대기 ${total}건` : '';
}

// ════════════════════════════════════════════════════════════════════
// ① 지식 검토 정책 — 정책(org_ingest_policy). 스위치 1개로 95%, 나머지는 '세부 규칙'.
// ════════════════════════════════════════════════════════════════════
export async function ingestPolicyPanel(detail, data): Promise<void> {
  //  #3830(2026-09-10 원준 "일반 사용자 대상 — 쉬운 말 · 어려운 건 고급 설정") — 증류기 탭 아래의 이 판을 수집기·증류기와 같은 문법으로.
  //   · 말: 「에이전트」→「AI」 · 「게이트」 없앰 · 「검토 후 반영」→「확인한 뒤에 쓰기」.
  //   · 선택은 드롭다운이 아니라 **뜻이 붙은 고르기 카드** — 무엇이 일어나는지를 고르기 전에 읽는다.
  //   · 세부 규칙은 맨 아래 접힌 「고급 설정」.
  //   · 비-관리자에게는 누를 수 없는 스위치·카드를 그리지 않는다(#1419 — 누를 수 없는 버튼은 미끼다). 지금 걸린 것만 문장으로.
  rqEnsureStyles();
  const reload = () => ingestPolicyPanel(detail, data);
  busy(detail, el('div', { class: 'card' }, skeleton('AI가 쓴 지식 확인 설정을 불러오는 중')));
  let policies: any[];
  let canEdit = false;
  try {
    const r = await api('/api/ui/org/ingest-policy');
    policies = (r && r.policies) || [];
    // 편집 가능 여부는 서버 판정을 그대로 받는다 — 프론트가 scope 를 재해석하면 '눌러도 403' 이 난다(#1419).
    canEdit = !!(r && r.canEdit);
  }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, 'AI가 쓴 지식 확인 설정을 불러오지 못했습니다'))); return; }
  const [obs, cats] = await Promise.all([
    api('/api/ui/org/ingest-observability?days=30').catch(() => null),
    api('/api/ui/categories').catch(() => null),
  ]);
  const catName = new Map<string, string>(((cats && cats.categories) || []).map((c: any) => [String(c.key), String(c.name || c.key)] as [string, string]));

  const preset = policies.find((p) => p.preset === GATE_PRESET) || null;
  const rules = policies.filter((p) => p.preset !== GATE_PRESET);   // 프리셋은 위 스위치가 관리 — 목록에서 제외(두 곳 편집 방지)

  const head = el('div', { class: 'cxc-head' },
    el('div', { class: 'cxc-head-main' },
      el('h3', { class: 'cxc-title' }, el('span', { text: 'AI가 쓴 지식 확인' })),
      el('p', { class: 'cxc-lead', text: 'AI가 새로 쓰거나 고친 지식을 사람이 확인한 뒤에 쓰이게 할지 정합니다. 사람이 웹에서 직접 쓴 지식에는 걸리지 않습니다.' })),
    el('div', { class: 'cxc-head-acts' },
      el('span', { class: 'cxc-ro', title: '조직 전체의 지식에 걸리는 설정이라 관리자만 바꿀 수 있습니다', text: canEdit ? '관리자 설정' : '읽기 전용 · 관리자만 바꿈' })));
  detail.replaceChildren(el('div', { class: 'cxc rvp' }, head, gateCard(preset, obs, reload, canEdit), rulesSection(rules, reload, canEdit, catName)));
}

// 「사람이 확인한 뒤에 쓰기」 카드 — 스위치 + (켜져 있으면) 새 지식/고칠 때 고르기 카드.
function gateCard(preset: any, obs: any, reload: () => void, canEdit: boolean) {
  const on = !!(preset && preset.enabled);
  const createAct = (preset && preset.action) || 'confirm';
  const updateAct = (preset && preset.action_update) || 'review';
  const card = el('section', { class: 'rvp-card' });

  // 지금 무슨 일이 일어나는지 한 문장 — 설정값을 사람 말로 되풀이한다(스위치만 보고 결과를 상상하지 않도록).
  //  켜져 있어도 둘 다 「바로」면 실제로 확인하는 지식은 없다 — 스위치의 "켜짐"과 결과가 어긋나 보이지 않게 그 사실을 말한다.
  const noneChecked = on && createAct === 'auto' && (updateAct === 'auto' || updateAct === 'drop') || (on && createAct === 'drop' && updateAct === 'auto');
  const stateText = !on
    ? 'AI가 쓴 지식이 사람 확인 없이 곧바로 검색과 AI 세션에 쓰입니다.'
    : noneChecked
      ? `켜져 있지만 새 지식은 「${actParts(CREATE_ACTS, createAct)[0]}」, 고친 지식은 「${actParts(UPDATE_ACTS, updateAct)[0]}」로 골라 두어, 지금은 사람이 확인하는 지식이 없습니다.`
      : `AI가 새로 쓴 지식은 「${actParts(CREATE_ACTS, createAct)[0]}」, 고친 지식은 「${actParts(UPDATE_ACTS, updateAct)[0]}」로 다룹니다.`;
  const headRow = el('div', { class: 'rvp-head' },
    el('span', { class: 'svc-tile cxc-tile cxc-tile-machine', 'aria-hidden': 'true' }, shieldIcon()),
    el('div', { class: 'cxc-main' },
      el('div', { class: 'cxc-t' },
        el('b', { class: 'rvp-t', text: '사람이 확인한 뒤에 쓰기' }),
        el('span', { class: 'cxc-state' + (on ? ' is-on' : '') },
          el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: on ? '켜짐' : '꺼짐' }))),
      el('p', { class: 'rvp-line', text: stateText })));
  if (canEdit) {
    const sw = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': '사람이 확인한 뒤에 쓰기' }) as HTMLInputElement;
    sw.checked = on;
    sw.addEventListener('change', () => {
      const next = sw.checked;
      sw.disabled = true;
      void gateSave({ enabled: next, action: createAct, action_update: updateAct }, reload,
        next ? '켰습니다 — AI가 쓴 지식은 확인한 뒤에 쓰입니다' : '껐습니다 — AI가 쓴 지식이 곧바로 쓰입니다',
        () => { sw.checked = !next; sw.disabled = false; });
    });
    headRow.append(el('div', { class: 'cxc-acts' }, sw));
  }
  card.append(headRow);

  const waiting = obs ? (Number(obs.pending_now || 0) + Number(obs.rev_pending || 0)) : 0;
  if (waiting > 0) {
    card.append(el('div', { class: 'rvp-wait' },
      el('span', {}, el('b', { class: 'num', text: `${waiting.toLocaleString()}건` }), '이 사람의 확인을 기다리고 있습니다'),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/review', text: '확인하러 가기 →' })));
  }
  if (obs && Number(obs.agent_auto || 0) > 0 && !on) {
    card.append(el('p', { class: 'rvp-note', text: `최근 30일 동안 AI가 확인 없이 곧바로 쓴 새 지식이 ${Number(obs.agent_auto).toLocaleString()}건입니다.` }));
  }
  if (!canEdit) return card;   // 읽는 사람에게는 위 문장이 전부다 — 누를 수 없는 고르기 카드는 그리지 않는다.

  const group = (title: string, name: string, list: [string, string][], cur: string, rec: string, pick: (v: string) => void) => {
    const opts = el('div', { class: 'rvp-opts', role: 'radiogroup', 'aria-label': title });
    for (const [v] of list) {
      const [t, dsc] = actParts(list, v);
      const r = el('input', { type: 'radio', name, value: v, ...(v === cur ? { checked: true } : {}), ...(on ? {} : { disabled: true }) }) as HTMLInputElement;
      r.addEventListener('change', () => { if (r.checked) pick(v); });
      opts.append(el('label', { class: 'rvp-opt' }, r,
        el('span', { class: 'rvp-opt-x' },
          el('b', {}, t, v === rec ? el('span', { class: 'rvp-rec', text: '추천' }) : null),
          dsc ? el('span', { text: dsc }) : null)));
    }
    return el('div', { class: 'rvp-group' + (on ? '' : ' is-off') }, el('p', { class: 'rvp-gt', text: title }), opts);
  };
  if (!on) card.append(el('p', { class: 'rvp-caption', text: '스위치를 켜면 아래 방식이 적용됩니다.' }));
  card.append(el('div', { class: 'rvp-groups' },
    group('AI가 새 지식을 쓸 때', 'rvp-create', CREATE_ACTS, createAct, 'confirm',
      (v) => { void gateSave({ enabled: true, action: v, action_update: updateAct }, reload, '바꿨습니다'); }),
    group('AI가 기존 지식을 고칠 때', 'rvp-update', UPDATE_ACTS, updateAct, 'review',
      (v) => { void gateSave({ enabled: true, action: createAct, action_update: v }, reload, '바꿨습니다'); })));
  return card;
}

// 프리셋 규칙 upsert — 축은 고정(AI 저작), 방식·켜짐만 사람이 고른다.
async function gateSave(patch: any, reload: () => void, msg: string, onFail?: () => void): Promise<void> {
  try {
    await api('/api/ui/org/ingest-policy', {
      method: 'POST',
      body: JSON.stringify({
        preset: GATE_PRESET,
        match_actor_kind: 'ai',        // 서버가 채널로 판정(MCP=에이전트) — 자기보고 아님
        match_provenance: 'authored',  // 커넥터 미러(observed)는 별도 규칙으로
        enabled: patch.enabled,
        action: patch.action,
        action_update: patch.action_update,
        priority: 0,
        note: '관리탭 스위치 — 에이전트가 기록한 지식',
      }),
    });
    toast(msg);
    reload();
  } catch (e: any) { toast('실패 — ' + e.message, true); onFail?.(); }
}

// 세부 규칙 — 전 축(카테고리·출처·작성자·AI 도구·종류…) CRUD. 맨 아래 접힌 「고급 설정」.
function rulesSection(rules: any[], reload: () => void, canEdit: boolean, catName: Map<string, string>) {
  const det = el('details', { class: 'dsl-adv rvp-adv' },
    el('summary', {},
      el('span', { class: 'dsl-adv-t', text: '고급 설정' }),
      el('span', { class: 'dsl-adv-d', text: rules.length
        ? `세부 규칙 ${rules.length}개 — 카테고리·AI 도구·출처마다 다르게 확인합니다`
        : '카테고리·AI 도구·출처마다 다르게 확인하고 싶을 때만 씁니다' })));
  const body = el('div', { class: 'dsl-adv-body' },
    el('p', { class: 'dst-intro', text: '위 설정은 AI가 쓴 지식 전부에 한 번에 걸립니다. 카테고리·AI 도구·출처·지식 종류마다 다르게 하고 싶을 때만 규칙을 더하세요. 여러 규칙에 걸리면 가장 조심스러운 쪽이 적용됩니다(막기 → 확인한 뒤에 → 바로 순서). 「예외」로 만든 규칙만 겹쳐도 그 규칙대로 곧바로 정해집니다 — 「전부 확인하되 이 카테고리만 바로 쓰기」 같은 완화는 예외로만 할 수 있습니다.' }));
  if (canEdit) body.append(el('div', {}, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 규칙 더하기', onclick: () => openIngestPolicyForm(null, reload) })));
  const list = el('div', { class: 'cxc-list' });
  if (!rules.length) list.append(el('div', { class: 'cxc-empty' }, el('p', { class: 'cxc-empty-d', text: '세부 규칙이 없습니다 — 위 스위치 하나로 충분한 경우가 대부분입니다.' })));
  for (const p of rules) list.append(ruleRow(p, reload, canEdit, catName));
  body.append(list);
  det.append(body);
  return det;
}

function ruleRow(p: any, reload: () => void, canEdit: boolean, catName: Map<string, string>) {
  const axes = [
    p.match_actor_kind && (p.match_actor_kind === 'ai' ? 'AI가 쓴 것' : '사람이 쓴 것'),
    p.match_agent && ('AI 도구 ' + p.match_agent),
    p.match_category && ('카테고리 「' + (catName.get(String(p.match_category)) || p.match_category) + '」'),
    p.match_type && ('종류 ' + (TYPE_LABEL[p.match_type] || p.match_type)),
    p.match_provenance && (p.match_provenance === 'observed' ? '외부 앱에서 가져온 자료' : '직접 쓴 것'),
    p.match_system && ('출처 ' + p.match_system),
    p.match_channel && ('채널 ' + p.match_channel),
    p.match_sensitive && ('민감도 ' + p.match_sensitive),
  ].filter(Boolean).join(' · ') || '모든 지식';
  const row = el('div', { class: 'cxc-row' + (p.enabled ? '' : ' is-off') },
    el('div', { class: 'cxc-main' },
      el('div', { class: 'cxc-t' },
        el('span', { class: 'cxc-name', text: axes }),
        p.is_exception ? el('span', { class: 'cxc-tag', text: '예외' }) : null,
        el('span', { class: 'cxc-state' + (p.enabled ? ' is-on' : '') },
          el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: p.enabled ? '켜짐' : '꺼짐' }))),
      el('div', { class: 'cxc-m' },
        el('span', { text: '새 지식 — ' + actParts(CREATE_ACTS, p.action)[0] }),
        el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
        el('span', { text: '고칠 때 — ' + actParts(UPDATE_ACTS, p.action_update || 'auto')[0] }))));
  if (!canEdit) return row;
  const sw = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': '이 규칙 켜기' }) as HTMLInputElement;
  sw.checked = !!p.enabled;
  sw.addEventListener('change', () => { sw.disabled = true; void ruleToggle(p, reload); });
  row.append(el('div', { class: 'cxc-acts' }, sw,
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '고치기', onclick: () => openIngestPolicyForm(p, reload) }),
    el('button', { class: 'btn-text btn-text-danger', type: 'button', text: '삭제', onclick: () => ruleDelete(p.id, reload) })));
  return row;
}

function shieldIcon(): SVGElement {
  const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6z' }), sv('path', { d: 'M9 12l2 2 4-4' }));
  return n;
}

async function ruleToggle(pol: any, reload: () => void): Promise<void> {
  try {
    await api('/api/ui/org/ingest-policy', { method: 'POST', body: JSON.stringify({ ...pol, enabled: !pol.enabled }) });
    reload();
  } catch (e: any) { toast('실패 — ' + e.message, true); reload(); }
}
async function ruleDelete(id: number, reload: () => void): Promise<void> {
  //  네이티브 confirm() 금지(DS §6.5 — 포커스가 확인에 놓여 파괴 동작이 오발된다). 잃는 것만 말한다.
  const ok = await confirmDialog({
    title: '이 규칙을 삭제할까요?',
    message: '이 규칙에 걸리던 지식은 위 기본 설정을 따르게 됩니다. 이미 확인했거나 쓰인 지식은 그대로 남습니다.',
    confirmText: '삭제', danger: true,
  });
  if (!ok) return;
  try { await api('/api/ui/org/ingest-policy/remove', { method: 'POST', body: JSON.stringify({ id }) }); toast('삭제했습니다'); reload(); }
  catch (e: any) { toast('실패 — ' + e.message, true); }
}

// 규칙 폼 — 8축 + 신규/수정 액션 + 예외.
export async function openIngestPolicyForm(pol: any, reload: () => void): Promise<void> {
  const isNew = !pol;
  const block = (title: string, hint: string | null, ctrl: any) => el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: title }),
    hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ctrl);
  const sel = (opts: [string, string][], cur: string | null) => {
    const s = el('select', { class: 'rq-sel' }) as HTMLSelectElement;
    for (const [v, t] of opts) s.append(el('option', { value: v, text: t }));
    if (cur) { if (!opts.some((o) => o[0] === cur)) s.append(el('option', { value: cur, text: cur + ' (미등록)' })); s.value = cur; }
    return s;
  };

  let cats: any[] = [];
  try {
    cats = await api('/api/ui/categories').then((d: any) => (d && d.categories) || []);
  } catch { cats = []; }

  const actSel = sel(CREATE_ACTS, (pol && pol.action) || 'confirm');
  const updSel = sel(UPDATE_ACTS, (pol && pol.action_update) || 'auto');
  const whoSel = sel([['', '누가 쓰든'], ['ai', 'AI가 쓴 것'], ['human', '사람이 웹에서 쓴 것']], (pol && pol.match_actor_kind) || '');
  const agentSel = sel([['', '모든 AI 도구'], ...HARNESSES.map((h) => [h, h] as [string, string])], (pol && pol.match_agent) || '');
  const catSel = sel([['', '모든 카테고리'], ...cats.map((c: any) => [c.key, String(c.name || c.key)] as [string, string])], (pol && pol.match_category) || '');
  const typeSel = sel([['', '모든 종류'], ...PAGE_TYPES.map((t) => [t, TYPE_LABEL[t] || t] as [string, string])], (pol && pol.match_type) || '');
  const provSel = sel([['', '모두'], ['authored', '직접 쓴 것 (AI·사람)'], ['observed', '외부 앱에서 가져온 자료']], (pol && pol.match_provenance) || '');
  const sysSel = sel([['', '모든 앱'], ...['slack', 'notion', 'clickup', 'gmail', 'gdrive', 'discord'].map((s) => [s, s] as [string, string])], (pol && pol.match_system) || '');
  const chanInp = el('input', { type: 'text', class: 'rq-sel', value: (pol && pol.match_channel) || '', placeholder: '특정 슬랙 채널·노션 폴더 id — 비우면 그 앱 전체' }) as HTMLInputElement;
  const sensSel = sel([['', '가리지 않음'], ['cooking', '아직 무르익는 중'], ['planning', '기획 단계'], ['unfinished', '끝나지 않은 이야기']], (pol && pol.match_sensitive) || '');
  const prioInp = el('input', { type: 'number', class: 'rq-sel', value: String((pol && pol.priority) || 0) }) as HTMLInputElement;
  const excChk = el('input', { type: 'checkbox', ...((pol && pol.is_exception) ? { checked: true } : {}) }) as HTMLInputElement;
  const enChk = el('input', { type: 'checkbox', ...((pol ? pol.enabled : true) ? { checked: true } : {}) }) as HTMLInputElement;

  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '규칙 더하기' : '저장' }) as HTMLButtonElement;
  const form = el('div', { class: 'proj-settings' },
    block('AI가 새 지식을 쓸 때', '이 규칙에 걸리는 새 지식을 어떻게 다룰지 고릅니다.', actSel),
    block('AI가 기존 지식을 고칠 때', '이미 있는 지식을 고칠 때입니다. AI가 쓰는 것의 상당수가 「고치기」입니다.', updSel),
    block('누가 썼나', '접속 경로로 서버가 판단합니다 — AI 도구로 연결해 쓴 것은 AI, 웹에서 쓴 것은 사람입니다.', whoSel),
    block('어느 AI 도구 (선택)', '특정 AI 도구(claude-code·codex 등)로 쓴 것만. 비우면 모든 도구.', agentSel),
    block('어느 카테고리 (선택)', '이 카테고리의 지식에만 적용합니다. 비우면 모든 카테고리.', catSel),
    block('지식 종류 (선택)', '예: 방법·절차 문서만 사람이 확인. 비우면 모든 종류.', typeSel),
    block('어디서 온 지식 (선택)', '직접 쓴 것과 외부 앱에서 가져온 자료를 가를 때 씁니다.', provSel),
    block('어느 외부 앱 (선택)', '외부 앱에서 가져온 자료의 출처. 비우면 모든 앱.', sysSel),
    block('채널·폴더 (선택)', '특정 슬랙 채널·노션 폴더 등의 id.', chanInp),
    block('민감도 (선택)', 'AI가 내용을 읽고 붙인 표시입니다.', sensSel),
    block('예외 규칙', '켜면 다른 규칙과 겹쳐도 이 규칙대로 곧바로 정해집니다 — 「전부 확인하되 여기만 바로 쓰기」 같은 때에 씁니다.',
      el('label', { class: 'inline' }, excChk, el('span', { text: ' 이 규칙을 예외로' }))),
    block('우선순위', '예외 규칙이 여럿 걸릴 때 숫자가 큰 쪽이 이깁니다.', prioInp),
    block('켜기', '', el('label', { class: 'inline' }, enChk, el('span', { text: ' 이 규칙 켜기' }))),
    el('div', { class: 'ps-rules-actions' }, saveBtn));
  const back = overlayBox(isNew ? '확인 규칙 더하기' : '확인 규칙 고치기', form);
  const boxw = back.querySelector('.ov-box'); if (boxw) boxw.classList.add('ov-box-wide');
  saveBtn.onclick = async () => {
    const body: any = {
      action: actSel.value, action_update: updSel.value,
      match_actor_kind: whoSel.value || null, match_agent: agentSel.value || null,
      match_category: catSel.value || null, match_type: typeSel.value || null,
      match_provenance: provSel.value || null, match_system: sysSel.value || null,
      match_channel: chanInp.value.trim() || null, match_sensitive: sensSel.value || null,
      is_exception: excChk.checked, priority: Number(prioInp.value) || 0, enabled: enChk.checked,
    };
    if (pol) body.id = pol.id;
    saveBtn.disabled = true;
    try { await api('/api/ui/org/ingest-policy', { method: 'POST', body: JSON.stringify(body) }); toast(isNew ? '규칙을 추가했습니다' : '저장했습니다'); back.remove(); reload(); }
    catch (e: any) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// ════════════════════════════════════════════════════════════════════
// ② 검토 큐 — 사람이 승인/반려하는 화면.
// ════════════════════════════════════════════════════════════════════
type QItem = {
  key: string; kind: 'new' | 'edit'; name: string; title: string;
  cat: string; catName: string; type: string | null;
  who: string; whoKind: string; agent: string | null; at: string;
  revId?: number; mode?: string; added?: number; removed?: number; conflict?: boolean; edits?: number;
};

const rqUi: { filter: string; cat: string; who: string; sel: Set<string>; open: Set<string>; cur: number } = {
  filter: 'all', cat: '', who: '', sel: new Set(), open: new Set(), cur: 0,
};
let rqKeys: AbortController | null = null;

// #837 — 큐는 관리탭을 떠나 WIKI 탭(#/knowledge/review)으로 왔다. 설정이 아니라 **반복 처리하는 일감**이고
//  권한도 워킹레벨(memory)이라, 관리(admin)탭에 두면 볼 사람이 못 보고 방치된다(그걸 배지로 때우고 있었다).
//  data(관리 org 페이로드)는 이 패널이 쓰지 않으므로 옵셔널 — WIKI 에서 인자 없이 부른다.
export async function reviewQueuePanel(detail, data?): Promise<void> {
  rqEnsureStyles();
  busy(detail, el('div', { class: 'card' }, skeleton('검토 대기 항목을 불러오는 중')));

  let pending: any[] = [], revs: any[] = [];
  try {
    const [pk, pr] = await Promise.all([
      api('/api/ui/knowledge?lifecycle=pending&orderBy=updated_at&limit=500'),
      api('/api/ui/knowledge-revisions?status=pending&limit=500'),
    ]);
    pending = (pk && pk.entries) || [];
    revs = (pr && pr.entries) || [];
  } catch (e) {
    detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '검토 대기 항목을 불러오지 못했습니다'))); return;
  }
  let obs: any = null;
  try { obs = await api('/api/ui/org/ingest-observability?days=30'); } catch { obs = null; }
  // #802 '내 도메인' = 내 팀이 오너인 카테고리 집합(서버가 판정 — me.team_owner_category_ids 와 같은 소스).
  //  실패하면 그 필터 옵션만 빠진다(큐 자체는 그대로).
  let mineCats: string[] = [];
  try { const s = await api('/api/ui/review-queue/summary'); mineCats = (s && s.mine_category_keys) || []; } catch { mineCats = []; }
  let gateOn: boolean | null = null;   // admin 만 조회 가능 — 아니면 null(배너 생략)
  try {
    const r = await api('/api/ui/org/ingest-policy');
    const p = ((r && r.policies) || []).find((x: any) => x.preset === GATE_PRESET);
    gateOn = !!(p && p.enabled);
  } catch { gateOn = null; }

  // 두 소스를 한 목록으로 — 사람에겐 '검토할 것' 하나일 뿐이다.
  const items: QItem[] = [
    ...pending.map((k: any): QItem => ({
      key: 'new:' + k.name, kind: 'new', name: k.name, title: k.title || k.name,
      cat: k.category_key || '', catName: k.category_name || '미분류', type: k.type || null,
      whoKind: k.confidence === 'ai' ? 'ai' : (k.provenance === 'observed' ? 'connector' : 'human'),
      who: k.provenance === 'observed' ? (k.source || '자료 수집기') : (k.updated_by || '—'),
      agent: null, at: k.updated_at,
    })),
    ...revs.map((r: any): QItem => ({
      key: 'rev:' + r.id, kind: 'edit', name: r.name, title: r.title || r.name,
      cat: r.category_key || '', catName: r.category_name || '미분류', type: r.type || null,
      whoKind: r.actor_kind === 'ai' ? 'ai' : 'human', who: r.proposed_by || '—', agent: r.agent || null,
      at: r.updated_at, revId: r.id, mode: r.mode, added: r.added, removed: r.removed,
      conflict: !!r.conflict, edits: r.edits,
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const listBox = el('div', {});
  const bulkBox = el('div', {});

  const mineSet = new Set(mineCats);
  // 필터 적용 후 화면에 실제 보이는 것들(키보드 커서·일괄 승인의 대상).
  const catMatch = (i: QItem): boolean => {
    if (!rqUi.cat) return true;                          // 모든 도메인
    if (rqUi.cat === CAT_MINE) return mineSet.has(i.cat); // 내 도메인(내 팀 소유 카테고리 집합)
    if (rqUi.cat === CAT_NONE) return !i.cat;            // 미분류
    return i.cat === rqUi.cat;
  };
  const visible = (): QItem[] => items.filter((i) =>
    (rqUi.filter === 'all' || rqUi.filter === i.kind)
    && catMatch(i)
    && (!rqUi.who || i.whoKind === rqUi.who));

  const paint = (): void => {
    const vis = visible();
    if (rqUi.cur >= vis.length) rqUi.cur = Math.max(0, vis.length - 1);
    listBox.replaceChildren(...renderGroups(vis, paint, drop));
    bulkBox.replaceChildren(...(rqUi.sel.size ? [bulkBar(items, paint, drop)] : []));
    chips.replaceChildren(...chipEls());
  };
  // 처리된 항목을 목록에서 즉시 제거(전체 리로드 없이 — 스크롤·펼침 상태 보존).
  const drop = (key: string): void => {
    const i = items.findIndex((x) => x.key === key);
    if (i >= 0) items.splice(i, 1);
    rqUi.sel.delete(key); rqUi.open.delete(key);
    paint();
    void refreshReviewBadge(items.length);   // #802 nav 배지도 같이 줄인다(남은 = 전체 대기 — 필터와 무관)
  };

  const chipEls = () => {
    const nNew = items.filter((i) => i.kind === 'new').length;
    const nEdit = items.filter((i) => i.kind === 'edit').length;
    const chip = (k: string, label: string) => el('button', {
      class: 'rq-chip' + (rqUi.filter === k ? ' on' : ''), text: label,
      onclick: () => { rqUi.filter = k; rqUi.cur = 0; paint(); },
    });
    return [
      chip('all', `전체 ${items.length}`),
      chip('new', `신규 ${nNew}`),
      chip('edit', `수정 ${nEdit}`),
    ];
  };
  const chips = el('span', { style: 'display:flex;gap:6px' }, ...chipEls());

  // 도메인 필터 — key→이름 맵. (key+구분자+name 을 합쳐 split 하는 방식은 이름의 공백/구분자에 취약하다.)
  //  미분류는 key 가 '' 라 '모든 도메인'(value='')과 값이 겹치므로 센티넬(CAT_NONE)로 치환한다.
  const catMap = new Map();
  for (const it of items) { const ck = it.cat || CAT_NONE; if (!catMap.has(ck)) catMap.set(ck, it.catName); }
  const catSel = el('select', { class: 'rq-sel', style: 'width:auto;min-width:150px' }) as HTMLSelectElement;
  catSel.append(el('option', { value: '', text: '모든 도메인' }));
  // #802 '내 도메인' — 자기 도메인만 훑고 나가는 게 가장 빠른 검토다(#783 설계원칙). 대기 건이 있을 때만 띄운다.
  const nMine = items.filter((i) => mineSet.has(i.cat)).length;
  if (nMine) catSel.append(el('option', { value: CAT_MINE, text: `내 도메인 (${nMine})` }));
  for (const [k, n] of catMap) catSel.append(el('option', { value: k, text: n }));
  if (rqUi.cat === CAT_MINE && !nMine) rqUi.cat = '';   // 내 도메인 건을 다 처리했으면 전체로 되돌림(빈 화면 방지)
  catSel.value = rqUi.cat;
  catSel.onchange = () => { rqUi.cat = catSel.value; rqUi.cur = 0; paint(); };

  const whoSel = el('select', { class: 'rq-sel', style: 'width:auto;min-width:120px' }) as HTMLSelectElement;
  for (const [v, t] of [['', '누가 쓰든'], ['ai', '에이전트'], ['human', '사람'], ['connector', '외부 자료 미러']] as [string, string][]) {
    whoSel.append(el('option', { value: v, text: t }));
  }
  whoSel.value = rqUi.who;
  whoSel.onchange = () => { rqUi.who = whoSel.value; rqUi.cur = 0; paint(); };

  const stat = (v: any, label: string, hint: string) => el('div', { class: 'rq-stat', title: hint },
    el('b', { text: String(v ?? 0) }), el('span', { text: label }));
  const stats = obs ? el('div', { class: 'rq-stats' },
    stat(items.filter((i) => i.kind === 'new').length, '새 지식 대기', '승인해야 검색·주입에 반영됩니다'),
    stat(items.filter((i) => i.kind === 'edit').length, '수정 대기', '기존 지식을 고친 건 — diff 를 확인하세요'),
    stat((obs.approved || 0) + (obs.rev_approved || 0), '최근 승인', obs.days + '일 내 승인'),
    stat((obs.rejected || 0) + (obs.rev_rejected || 0), '최근 반려', obs.days + '일 내 반려·되돌리기'),
    stat(obs.agent_auto, '검토 없이 반영', obs.days + '일 내 에이전트가 게이트 없이 즉시 반영한 신규 지식')) : null;

  const banner = (gateOn === false)
    ? el('div', { class: 'rq-dup', style: 'display:flex;align-items:center;gap:10px' },
      el('span', { style: 'flex:1', text: '지식 검토 정책가 꺼져 있습니다 — 에이전트가 쓴 지식이 사람 확인 없이 곧바로 유효해집니다.' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/system/ingest-policy', text: '게이트 설정' }))
    : null;

  const card = el('div', { class: 'card' },
    cardHead('검토 대기 목록', '사람이 확인해야 지식이 됩니다. 신규는 승인 전까지 검색·세션주입·목록에서 빠져 있고, 수정은 반영본과 이전본의 차이를 보고 확인하거나 되돌릴 수 있습니다. 반려한 신규 지식은 휴지통으로 갑니다(복원 가능). 승인·반려는 변경 감사에 기록됩니다.'),
    banner,
    stats,
    el('div', { class: 'rq-bar' }, chips, catSel, whoSel,
      el('span', { class: 'rq-kbd' },
        el('b', { text: 'j/k' }), el('span', { text: ' 이동 · ' }),
        el('b', { text: 'Enter' }), el('span', { text: ' 펼침 · ' }),
        el('b', { text: 'a' }), el('span', { text: ' 승인 · ' }),
        el('b', { text: 'r' }), el('span', { text: ' 반려 · ' }),
        el('b', { text: 'x' }), el('span', { text: ' 선택' }))),
    listBox,
    bulkBox);
  detail.replaceChildren(card);
  paint();
  installKeys(listBox, visible, paint, drop);
}

// 도메인별 그룹 — 자기 도메인만 훑는 게 가장 빠른 검토다.
function renderGroups(vis: QItem[], paint: () => void, drop: (k: string) => void): any[] {
  if (!vis.length) {
    return [el('div', { class: 'rq-rows' },
      el('div', { class: 'rq-empty', text: '검토 대기 중인 항목이 없습니다.' }))];
  }
  const groups = new Map<string, QItem[]>();
  for (const it of vis) {
    const k = it.catName || '미분류';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }
  let idx = 0;
  const out: any[] = [];
  for (const [gname, gitems] of groups) {
    const rows = el('div', { class: 'rq-rows' });
    for (const it of gitems) rows.append(renderRow(it, idx++, paint, drop));
    out.push(el('div', { class: 'rq-group' },
      el('div', { class: 'rq-grouphead' },
        el('span', { text: gname }),
        el('span', { class: 'rq-groupcount', text: String(gitems.length) })),
      rows));
  }
  return out;
}

function renderRow(it: QItem, idx: number, paint: () => void, drop: (k: string) => void) {
  const isOpen = rqUi.open.has(it.key);
  const chk = el('input', {
    type: 'checkbox', class: 'rq-chk', ...(rqUi.sel.has(it.key) ? { checked: true } : {}),
    title: '선택(일괄 승인)',
    onclick: (e: any) => {
      e.stopPropagation();
      if (rqUi.sel.has(it.key)) rqUi.sel.delete(it.key); else rqUi.sel.add(it.key);
      paint();
    },
  });
  // 누가 썼나 — 검토자가 가장 먼저 보는 신호(에이전트가 쓴 글은 사실확인이 필요하다).
  const whoText = it.whoKind === 'ai'
    ? '에이전트' + (it.agent ? ' · ' + it.agent : '')
    : it.whoKind === 'connector' ? '외부 자료 미러 · ' + it.who : '사람 · ' + it.who;

  const badge = it.kind === 'new'
    ? el('span', { class: 'rq-badge new', text: '신규' })
    : el('span', { class: 'rq-badge edit', text: it.mode === 'staged' ? '수정 · 미반영' : '수정 · 반영됨' });

  const meta = el('span', { class: 'rq-meta' },
    it.kind === 'edit'
      ? el('span', { class: 'rq-delta' },
        el('span', { class: 'add', text: '+' + (it.added ?? 0) }),
        el('span', { text: ' ' }),
        el('span', { class: 'del', text: '−' + (it.removed ?? 0) }))
      : null,
    it.conflict ? el('span', { class: 'rq-warn', title: '제안 이후 라이브 본문이 또 바뀌었습니다 — 승인하면 그 변경을 덮어씁니다', text: '⚠ 충돌' }) : null,
    it.type ? el('span', { text: TYPE_LABEL[it.type] || it.type }) : null,
    el('span', { text: whoText }),
    el('span', { text: relTime(it.at) }));

  const main = el('div', {
    class: 'rq-row-main',
    onclick: () => { if (rqUi.open.has(it.key)) rqUi.open.delete(it.key); else rqUi.open.add(it.key); rqUi.cur = idx; paint(); },
  }, chk, badge, el('span', { class: 'rq-title', text: it.title }), meta,
    el('span', { class: 'rq-acts' },
      el('a', {
        class: 'btn btn-ghost btn-sm', href: '#/knowledge/' + encodeURIComponent(it.name), text: '열기',
        onclick: (e: any) => e.stopPropagation(),
      }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '✓ 승인', onclick: (e: any) => { e.stopPropagation(); approve(it, drop); } }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '✕ 반려', onclick: (e: any) => { e.stopPropagation(); reject(it, drop); } })));

  const row = el('div', { class: 'rq-row' + (rqUi.cur === idx ? ' cur' : ''), 'data-key': it.key }, main);
  if (isOpen) {
    const exp = el('div', { class: 'rq-exp' }, el('div', { class: 'rq-md' }, skeleton('불러오는 중')));
    row.append(exp);
    void fillExpand(exp, it);
  }
  return row;
}

// 펼침 — 신규는 본문+중복 경고, 수정은 줄단위 diff. 제자리에서(페이지 이동 0).
async function fillExpand(exp: any, it: QItem): Promise<void> {
  try {
    if (it.kind === 'new') {
      const r = await api('/api/ui/knowledge/' + encodeURIComponent(it.name));
      const k = (r && r.knowledge) || {};
      const parts: any[] = [];
      // 중복 경고 — 승인 전에 "이미 있는 지식 아닌가?"를 잡아준다(에이전트 저장의 가장 흔한 사고).
      try {
        const sim = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: it.name, limit: '3' }));
        const hits = ((sim && sim.similar) || []).filter((s: any) => Number(s.score) >= 0.6);
        if (hits.length) {
          const strip = el('div', { class: 'rq-dup' }, el('span', { text: '⚠ 비슷한 기존 지식이 있습니다 — 중복이면 반려하고 기존 지식을 갱신하게 하세요: ' }));
          hits.forEach((h: any, i: number) => {
            if (i) strip.append(el('span', { text: ' · ' }));
            strip.append(el('a', { href: '#/knowledge/' + encodeURIComponent(h.name), text: (h.title || h.name) + ' (' + Math.round(Number(h.score) * 100) + '%)' }));
          });
          parts.push(strip);
        }
      } catch { /* 임베딩 off → 중복 검사 생략 */ }
      parts.push(el('div', { class: 'rq-md md-rendered' }, renderMarkdown(k.body_md || '(본문 없음)')));
      exp.replaceChildren(...parts);
      return;
    }
    const r = await api('/api/ui/knowledge-revisions/' + it.revId);
    const rev = r.revision, cur = r.current;
    if (!cur) { exp.replaceChildren(el('p', { class: 'rq-exp-note rq-warn', text: '대상 지식이 삭제되었습니다 — 반려로 정리하세요.' })); return; }
    // staged: 승인하면 바뀔 것(라이브 → 제안). applied: 이미 바뀐 것(수정 전 → 라이브).
    const [beforeTxt, afterTxt, note] = rev.mode === 'staged'
      ? [cur.body_md, rev.new_body_md, '승인하면 아래 변경이 라이브 본문에 적용됩니다(지금 라이브는 왼쪽 상태 그대로).']
      : [rev.base_body_md || '', cur.body_md, '이미 반영된 변경입니다. 되돌리면 수정 전 상태로 복구됩니다.'];
    exp.replaceChildren(
      el('p', { class: 'rq-exp-note', text: note + (rev.edits > 1 ? ` (에이전트가 ${rev.edits}번 저장 — 마지막 검토 이후 누적 변화)` : '') }),
      diffView(beforeTxt, afterTxt));
  } catch (e) {
    exp.replaceChildren(errorNote(e, '내용을 불러오지 못했습니다'));
  }
}

// ── 줄단위 diff — 공통 prefix/suffix 를 깎고 가운데만 LCS(편집은 대개 국소적이라 창이 작다). ──
//  가드: 남은 창이 800×800 을 넘으면 LCS 를 포기하고 블록 치환으로 폴백(브라우저 프리즈 방지).
//  export: 다른 화면이 같은 diff(변경 블록 파생·원문 비교 접힘)를 재사용한다 — 알고리즘 두 벌 금지.
export function lineDiff(aStr: string, bStr: string): { t: string; s: string }[] {
  const a = String(aStr ?? '').split('\n'), b = String(bStr ?? '').split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const midA = a.slice(s, ea), midB = b.slice(s, eb);
  const out: { t: string; s: string }[] = [];
  for (let i = 0; i < s; i++) out.push({ t: ' ', s: a[i] });
  const n = midA.length, m = midB.length;
  if (n * m > 640000) {
    for (const l of midA) out.push({ t: '-', s: l });
    for (const l of midB) out.push({ t: '+', s: l });
  } else if (n || m) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ t: ' ', s: midA[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { out.push({ t: '-', s: midA[i] }); i++; }
      else { out.push({ t: '+', s: midB[j] }); j++; }
    }
    while (i < n) { out.push({ t: '-', s: midA[i] }); i++; }
    while (j < m) { out.push({ t: '+', s: midB[j] }); j++; }
  }
  for (let k = eb; k < b.length; k++) out.push({ t: ' ', s: b[k] });
  return out;
}

// 변경 주변 3줄만 — 긴 동일 구간은 접는다(스크롤 피로 감소). export: 다른 화면의 '원문 비교' 접힘이 재사용.
export function diffView(before: string, after: string) {
  const d = lineDiff(before, after);
  const CTX = 3;
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.t === ' ') return;
    for (let k = Math.max(0, i - CTX); k <= Math.min(d.length - 1, i + CTX); k++) keep[k] = true;
  });
  const box = el('div', { class: 'rq-diff' });
  if (!d.some((l) => l.t !== ' ')) {
    box.append(el('div', { class: 'rq-dl skip', text: '내용 변화 없음(메타만 변경)' }));
    return box;
  }
  let skipped = 0;
  const flush = () => {
    if (skipped) box.append(el('div', { class: 'rq-dl skip', text: `⋯ ${skipped}줄 생략` }));
    skipped = 0;
  };
  d.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    flush();
    const cls = l.t === '+' ? 'rq-dl add' : l.t === '-' ? 'rq-dl del' : 'rq-dl';
    box.append(el('div', { class: cls },
      el('span', { class: 'sig', text: l.t === ' ' ? '' : l.t }),
      el('span', { text: l.s })));
  });
  flush();
  return box;
}

// ── 액션 ──
async function approve(it: QItem, drop: (k: string) => void): Promise<void> {
  try {
    if (it.kind === 'new') {
      await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
      toast('승인 — 지식으로 반영했습니다');
    } else {
      await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
      toast(it.mode === 'staged' ? '승인 — 수정을 반영했습니다' : '확인 — 검토 완료로 표시했습니다');
    }
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

async function reject(it: QItem, drop: (k: string) => void): Promise<void> {
  const msg = it.kind === 'new'
    ? '이 지식을 반려할까요? 휴지통으로 이동하며 복원할 수 있습니다.'
    : it.mode === 'staged'
      ? '이 수정 제안을 반려할까요? 라이브 본문은 바뀌지 않습니다(제안만 폐기).'
      : '이 수정을 되돌릴까요? 라이브 본문이 수정 전 상태로 복구됩니다.';
  if (!confirm(msg)) return;
  try {
    if (it.kind === 'new') {
      await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/delete', { method: 'POST' });
      toast('반려했습니다(휴지통)');
    } else {
      await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'reject' }) });
      toast(it.mode === 'staged' ? '제안을 반려했습니다' : '수정을 되돌렸습니다');
    }
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

// 일괄 승인 — 화면당 채운 파란 버튼 1개 예산(styles.css §0.5)은 여기에 쓴다.
function bulkBar(items: QItem[], paint: () => void, drop: (k: string) => void) {
  const n = rqUi.sel.size;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: `선택 ${n}건 승인` }) as HTMLButtonElement;
  go.onclick = async () => {
    if (!confirm(`${n}건을 승인할까요?`)) return;
    go.disabled = true;
    const keys = [...rqUi.sel];
    let ok = 0, fail = 0;
    for (const key of keys) {
      const it = items.find((x) => x.key === key);
      if (!it) continue;
      try {
        if (it.kind === 'new') {
          await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
        } else {
          await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
        }
        ok++; drop(key);
      } catch { fail++; }
    }
    toast(fail ? `${ok}건 승인 · ${fail}건 실패` : `${ok}건을 승인했습니다`, !!fail);
    paint();
  };
  return el('div', { class: 'rq-bulk' },
    el('b', { text: `${n}건 선택됨` }),
    go,
    el('button', { class: 'btn btn-ghost btn-sm', text: '선택 해제', onclick: () => { rqUi.sel.clear(); paint(); } }));
}

// ── 키보드 — 손이 마우스로 안 떠나게. 입력창 안에서는 절대 가로채지 않는다(undo.ts inEditableOwner 관례). ──
function installKeys(listBox: any, visible: () => QItem[], paint: () => void, drop: (k: string) => void): void {
  if (rqKeys) rqKeys.abort();
  rqKeys = new AbortController();
  const inEditable = (t: any): boolean => {
    const e = (t && t.nodeType === 1 ? t : document.activeElement) as HTMLElement | null;
    return !!(e && e.closest && e.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .be, .xterm'));
  };
  document.addEventListener('keydown', (e: any) => {
    if (!document.body.contains(listBox)) { rqKeys?.abort(); rqKeys = null; return; }   // 다른 탭으로 이동 → 자가 해제
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inEditable(e.target)) return;
    const vis = visible();
    if (!vis.length) return;
    const cur = () => vis[Math.min(rqUi.cur, vis.length - 1)];
    const move = (d: number) => {
      rqUi.cur = Math.max(0, Math.min(vis.length - 1, rqUi.cur + d));
      paint();
      const node = listBox.querySelector('.rq-row.cur');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = cur(); if (!it) return;
      if (rqUi.open.has(it.key)) rqUi.open.delete(it.key); else rqUi.open.add(it.key);
      paint(); return;
    }
    if (e.key === 'x') { e.preventDefault(); const it = cur(); if (!it) return; if (rqUi.sel.has(it.key)) rqUi.sel.delete(it.key); else rqUi.sel.add(it.key); paint(); return; }
    if (e.key === 'a') { e.preventDefault(); const it = cur(); if (it) void approve(it, drop); return; }
    if (e.key === 'r') { e.preventDefault(); const it = cur(); if (it) void reject(it, drop); return; }
    if (e.key === 'Escape' && rqUi.sel.size) { e.preventDefault(); rqUi.sel.clear(); paint(); }
  }, { signal: rqKeys.signal });
}
