// context.ts — [맥락 관리] 탭 셸(#1419 T6). 구 [분류체계] 탭의 자리를 넓혀 파이프라인 전체를 담는다.
//
//  요구 원문: "지금의 분류체계탭을 맥락 관리로 바꾸고 … 맥락관리에는 수집기, 증류지, 분류기 및
//   수집-증류-분류 파이프라인을 다 관리할수있게. 비개발자도 쉽게관리할수있어야하고."
//
//  ── 전면 재구성(#762, 2026-08-31 원준 확정 — 프로토타입 v5) ──────────────────────────
//  원준 지적: "아직 직관적으로 하나도 이해 안 간다 · 우리 수집기·증류기·카테고리를 여기서 이해시켜야 한다 ·
//   표지는 2안(흐름 지도)". 그래서 #1841 의 「단계 ▸ 화면 알약」 2층을 걷고 이렇게 바꾼다:
//   ① **표지 = 흐름 지도**(context-map.ts) — 수집기 → 자료 → [증류기] → 지식 → [전달] → AI 세션.
//     역·게이트가 전부 눌리고 상단 탭과 1:1 — 지도가 곧 목차다.
//   ② **탭은 1층뿐** — 현황 · 수집기 · 증류기 · 카테고리 · 점검 · AI 전달. 탭 이름이 우리 기계 이름
//     그대로다(숨기지 않고 가르친다). 한 탭 = 한 화면이고, 화면 안은 스크롤 섹션으로만 나눈다(알약 폐지).
//   ③ **사람 몫은 「확인할 것」 하나** — 승인 대기 · 카테고리 제안 · 점검 발견이 탭 줄 오른쪽 트레이로 모인다.
//  기능은 하나도 버리지 않았다 — 13화면의 패널을 그대로 부르고(복제 0), 옛 URL 은 LEGACY 표가 새 자리로 넘긴다.
//  저장 경로(API)는 하나도 안 바꿨다 — **합치는 건 화면이지 데이터가 아니다**(#837 불변식).
//
//  (구) #1841 — 탭 이름을 사람 말(가져오는 곳·지식 만들기·갈래·점검)로 바꿨으나, 2층 알약이 남았고
//   화면 안은 기계어 그대로라 "뭐하는 곳인지 감이 안 온다"가 반복됐다. #762 가 이를 뒤집는다:
//   이름은 기계의 정식 명칭으로 되돌리되(수집기·증류기·카테고리), **정의 한 줄 + 실물 예시**가 가르친다.
//  (구) #1584 — 좌측 사이드바. #1841 에서 가로 머리 3층으로 뒤집혔고, 이번엔 그 3층에서 알약 층을 걷는다.
import { api, el, hasScope, sv } from './core.js';
import { skeleton } from './ui-primitives.js';
import { stageHealthLevels } from './context-pipeline.js';
import { inboxCount, renderContextInbox, renderContextMapScreen } from './context-map.js';   // #762 표지(흐름 지도) + 확인할 것
import { renderCollectors } from './context-collectors.js';
import { renderClassifiers } from './context-classify.js';
import { renderManagers } from './context-manage.js';
import { renderCategoryList } from './categories.js';
import { distillerPage, distillersPanel } from './distillers.js';
import { collectorPresetEditor } from './admin-collector-presets.js';  // 새 소스 만들기 — 수집기 화면의 하위 갈래
import { sourceVisPolicyPanel } from './source-vis-policy.js';         // 자료 공개범위(#1291 v4) — AI 전달 ▸ 접근 권한에 함께 선다
import { ingestPolicyPanel } from './review.js';                       // 지식 검토 정책(#638) — 증류기 화면의 「사람 승인」 절
import { injectionMap } from './admin-injection.js';                   // 세션 주입 — 항상 주입되는 조직 정체성
import { embeddingsEditor } from './admin-embeddings.js';              // 의미 검색 — 임베딩 provider·백필(기본 off)
import { visibilityAxesPanel } from './visibility-axes.js';            // 공개범위 — 유형별 축 on/off
import { loadAdmin } from './admin-rerender.js';

/** 관리탭 패널이 요구하는 admin 데이터 — 없으면 빈 객체(패널이 자기 API 로 그린다). */
async function adminData(): Promise<any> {
  try { return await loadAdmin(); } catch { return {}; }
}

type CtxItem = {
  key: string;
  label: string;
  /** 관리자만 **조회**까지 되는 화면(#1618) — 서버가 GET 부터 admin scope 로 막는다. 비-admin 에겐 내비에서도 숨긴다. */
  adminOnly?: boolean;
  draw: (b: HTMLElement) => Promise<void>;
};
type CtxStage = {
  key: string;
  label: string;
  /** 이 탭이 무엇을 하는 자리인지 — **정의 한 줄**. 빵부스러기 옆에 그대로 선다(#762: 기계마다 정의 한 문장). */
  hint: string;
  /** '보는 건 누구나, 고치는 건 관리자'인 탭 — 자물쇠 배지. */
  adminEdit?: boolean;
  /** 탭 줄에 세우지 않는 스테이지(확인할 것 — 오른쪽 트레이가 대신 선다). */
  tray?: boolean;
  items: CtxItem[];
};

/**
 * 정보구조(#762 전면 재구성) — **탭 1층 = 기계 하나 = 화면 하나**. URL 은 `#/context/<tab>[/<item>]`.
 *  items 가 여럿인 탭도 알약을 세우지 않는다 — 첫 항목이 그 탭의 화면이고, 나머지는 화면 안 링크로만
 *  들어가는 하위 갈래(새 소스 만들기)거나 옛 주소 호환용이다.
 */
const STAGES: CtxStage[] = [
  {
    key: 'home', label: '현황',
    hint: '자료가 지식이 되어 AI 에 닿기까지 — 지금 어디가 막혔나',
    items: [{ key: 'home', label: '현황', draw: (b) => renderContextMapScreen(b) }],
  },
  {
    key: 'inbox', label: '확인할 것', tray: true,
    hint: '사람 손이 필요한 것 전부 — 승인 · 카테고리 제안 · 점검 발견',
    items: [{ key: 'inbox', label: '확인할 것', draw: (b) => renderContextInbox(b) }],
  },
  {
    key: 'sources', label: '수집기', adminEdit: true,
    hint: '외부 서비스에서 자료를 가져오는 연결 — 무엇을, 얼마나 자주',
    items: [
      { key: 'collectors', label: '수집기', draw: (b) => sourcesScreen(b) },
      { key: 'presets', label: '새 소스 만들기', draw: (b) => presetsScreen(b) },
      { key: 'source-vis', label: '자료를 볼 사람', adminOnly: true, draw: async (b) => { await sourceVisPolicyPanel(b); } },
    ],
  },
  {
    key: 'distill', label: '증류기',
    hint: '자료를 읽고 지식으로 정리하는 자동 규칙 — 채널·팀마다 기준을 다르게 여러 개',
    items: [{ key: 'distillers', label: '증류기', draw: (b) => distillScreen(b) }],
  },
  {
    key: 'category', label: '카테고리',
    hint: '지식이 정리되는 칸 — 정의를 적어 두면 자동 분류가 그 기준으로 배정합니다',
    items: [{ key: 'categories', label: '카테고리', draw: (b) => categoryScreen(b) }],
  },
  {
    key: 'checks', label: '점검',
    hint: '쌓인 지식이 낡거나 어긋나지 않았는지 검사하는 자동 규칙 — 찾아낸 것은 「확인할 것」으로',
    items: [{ key: 'managers', label: '검사 규칙', draw: (b) => checksScreen(b) }],
  },
  {
    key: 'deliver', label: 'AI 전달', adminEdit: true,
    hint: '지식이 실제로 AI 에 닿는 마지막 구간 — 세션 주입 · 검색 · 접근 권한',
    items: [{ key: 'injection', label: 'AI 전달', draw: (b) => deliverScreen(b) }],
  },
];

// ── 화면 조립 — 한 탭 = 한 화면. 여러 패널을 세로로 쌓는다(각자 실패는 자기 자리에서). ──────────
async function stack(b: HTMLElement, parts: Array<(h: HTMLElement) => Promise<void> | void>): Promise<void> {
  const hosts = parts.map(() => el('div', { class: 'ctx-stacked' }));
  b.replaceChildren(...hosts);
  for (let i = 0; i < parts.length; i++) {
    try { await parts[i](hosts[i]); }
    catch (e) { hosts[i].replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message }))); }
  }
}

/** 수집기 — 연결 목록 + 「새 소스 만들기」 입구(상시 화면이 아니라 하위 갈래로, #762). */
async function sourcesScreen(b: HTMLElement): Promise<void> {
  await stack(b, [
    (h) => renderCollectors(h),
    (h) => { h.replaceChildren(el('div', { class: 'card ctx-crosslink' },
      el('b', { text: '직접 정의하는 소스 (HTTP · RSS)' }),
      el('p', { class: 'admin-hint', text: '정해진 연동이 없는 곳도 주소만 있으면 소스로 만들 수 있습니다.' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/context/sources/presets', text: '새 소스 만들기 →' }))); },
  ]);
}

/** 새 소스 만들기(수집 방식 프리셋) — 수집기 화면의 하위 갈래. 돌아갈 길을 화면이 준다. */
async function presetsScreen(b: HTMLElement): Promise<void> {
  await stack(b, [
    (h) => { h.replaceChildren(el('p', { class: 'admin-hint' }, el('a', { href: '#/context/sources', text: '‹ 수집기로' }))); },
    (h) => collectorPresetEditor(h),
  ]);
}

/** 증류기 — 목록·사각지대(distillersPanel) + 사람 승인 정책(ingestPolicyPanel)이 한 화면에. */
async function distillScreen(b: HTMLElement): Promise<void> {
  const data = await adminData();
  await stack(b, [
    async (h) => { await distillersPanel(h, data); },
    async (h) => { await ingestPolicyPanel(h, data); },
  ]);
}

/** 카테고리 — 칸(정의·담당)과 그 칸을 채우는 기계(자동 분류)가 한 화면에. */
async function categoryScreen(b: HTMLElement): Promise<void> {
  await stack(b, [
    (h) => renderCategoryList(h),
    (h) => renderClassifiers(h),
  ]);
}

/** 점검 — 검사 규칙(관리기)만. 찾아낸 것(발견)의 처리는 「확인할 것」이 맡는다(#762 큐 통합). */
async function checksScreen(b: HTMLElement): Promise<void> {
  await stack(b, [
    (h) => { h.replaceChildren(el('div', { class: 'card ctx-crosslink' },
      el('b', { text: '점검이 찾아낸 것' }),
      el('p', { class: 'admin-hint', text: '발견된 문제의 확인·처리는 「확인할 것」에서 합니다 — 승인·카테고리 제안과 한 자리입니다.' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/context/inbox', text: '확인할 것 열기 →' }))); },
    (h) => renderManagers(h),
  ]);
}

/** AI 전달 — 세션 주입 + (관리자) 의미 검색 · 공개 범위 · 자료를 볼 사람. 접근 권한을 한 자리에. */
async function deliverScreen(b: HTMLElement): Promise<void> {
  const data = await adminData();
  const parts: Array<(h: HTMLElement) => Promise<void> | void> = [async (h) => { await injectionMap(h, data); }];
  if (hasScope('admin')) {
    parts.push(async (h) => { await embeddingsEditor(h, data); });
    parts.push(async (h) => { await visibilityAxesPanel(h); });
    parts.push(async (h) => { await sourceVisPolicyPanel(h); });
  }
  await stack(b, parts);
}

/** 옛 주소 → 새 자리. 북마크·문서·화면 안 링크가 살아 있어야 한다(#1841 방식 승계). */
const LEGACY_STAGE: Record<string, string> = {
  overview: 'home', collect: 'sources', knowledge: 'distill', topics: 'category', classify: 'category', manage: 'checks',
};
const LEGACY_ITEM: Record<string, string> = {
  overview: 'home', 'ingest-policy': 'distillers', classifiers: 'categories', findings: 'inbox',
};

/**
 * `#/context/distill/<sub2>` 가 **증류기 설정 페이지**를 가리키나(#1564).
 *  화면 키('distillers' · 옛 'ingest-policy')가 아니면 증류기 식별자로 읽는다 — 그 URL 은 이 셸 밖의
 *  전용 페이지라 라우터도 레이아웃(전폭)을 달리 잡아야 해서, 판정을 여기 한 곳에 둔다.
 *  (증류기 key 가 하필 화면 키와 같으면 목록이 뜬다 — 실사용에서 겹칠 이름이 아니고, 겹쳐도 잃는 것은 딥링크 하나뿐.)
 */
export function isDistillerDetailPath(sub: string | null | undefined, sub2: string | null | undefined): boolean {
  if ((sub !== 'distill' && sub !== 'knowledge') || !sub2) return false;   // 'knowledge' 는 옛 주소(#1841 시절)
  return sub2 !== 'distillers' && sub2 !== 'ingest-policy';
}

export async function renderContext(view: HTMLElement, sub?: string | null, sub2?: string | null): Promise<void> {
  // 증류기 설정(#/context/distill/<key>)은 **이 셸 밖**의 전용 페이지다(#1564).
  if (isDistillerDetailPath(sub, sub2)) { await distillerPage(view, String(sub2)); return; }

  // 옛 주소(단계 이름)로 들어오면 새 자리로 조용히 옮긴다 — 북마크·문서·화면 안 링크 보존.
  if (sub && !STAGES.some((s) => s.key === sub) && LEGACY_STAGE[sub]) {
    const it = sub2 ? (LEGACY_ITEM[sub2] || sub2) : '';
    // 옛 「점검 ▸ 확인할 것」은 스테이지가 통째로 바뀐다(#762 큐 통합).
    if (it === 'inbox') { location.replace('#/context/inbox'); return; }
    location.replace('#/context/' + LEGACY_STAGE[sub] + (it ? '/' + it : ''));
    return;
  }
  if (sub === 'checks' && sub2 === 'findings') { location.replace('#/context/inbox'); return; }
  const stage = STAGES.find((s) => s.key === sub) ?? STAGES[0];
  // adminOnly 화면(#1618)은 비-admin 에게 **주소로도** 열리지 않는다 — 그 탭의 첫 볼 수 있는 화면으로 떨군다.
  const canSee = (i: CtxItem) => !i.adminOnly || hasScope('admin');
  const visible = stage.items.filter(canSee);
  const asked = stage.items.find((i) => i.key === sub2);
  const item = (asked && canSee(asked) ? asked : null) ?? visible[0] ?? stage.items[0];

  const host = el('div', {}, skeleton('불러오는 중'));
  const body = el('div', { class: 'ctx-body' }, host);
  view.replaceChildren(el('div', { class: 'pjv-board-wrap ctx-board-wrap' },
    el('div', { class: 'card pjv-listboard ctx-board' }, buildHeader(stage), body)));
  void paintStageHealth(view);

  // 화면 본문. 실패는 자기 자리에서 처리한다(내비까지 죽이지 않는다 — 다른 화면으로는 갈 수 있어야 한다).
  try { await item.draw(host); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
  }
}

/**
 * 머리 2층(#762) — 빵부스러기(앱 이름 + 정의 한 줄) + 탭 1층.
 *  탭 이름이 우리 기계 이름 그대로다(수집기·증류기·카테고리) — 탭 줄이 곧 파이프라인 순서이고,
 *  표지(현황)의 지도와 1:1 이다. 「확인할 것」은 탭이 아니라 **오른쪽 트레이**(배지 = 사람 몫 수).
 *  #1841 의 셋째 층(화면 알약)은 폐지 — 한 탭 = 한 화면, 화면 안은 스크롤 섹션이다.
 */
function buildHeader(selStage: CtxStage): HTMLElement {
  const crumbBar = el('div', { class: 'pjv-crumbbar' },
    el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' },
      el('span', { class: 'pjv-crumb is-leaf ctx-crumb-leaf' }, ctxAppIcon(), el('span', { class: 'pjv-crumb-label', text: '맥락 관리' })),
      el('span', { class: 'ctx-crumb-sub', text: selStage.hint })));
  const tabs = el('div', { class: 'pjv-vtabs ctx-vtabs', role: 'tablist', 'aria-label': '맥락 관리' });
  for (const s of STAGES) {
    if (s.tray) continue;   // 확인할 것 — 아래 트레이가 대신 선다
    const on = s.key === selStage.key;
    const tab = el('a', {
      class: 'pjv-vtab ctx-vtab' + (on ? ' active' : '') + (s.key === 'home' ? ' ctx-vtab-ov' : ''),
      href: '#/context/' + s.key,
      role: 'tab', 'aria-selected': String(on), 'data-stage': s.key,
      title: s.hint + (s.adminEdit ? ' — 보는 것은 모든 구성원, 만들고 고치는 것은 관리자' : ''),
    },
      el('span', { class: 'ctx-vtab-label', text: s.label }),
      // 건강 점은 '지금 문제가 있는 탭'에만 붙는다(paintStageHealth 가 ok 면 지운다) — 늘 켜진 점은 신호가 아니라 장식이다.
      HEALTH_TAB[s.key] ? el('span', { class: 'ctx-vtab-dot', 'aria-hidden': 'true' }) : null,
      s.adminEdit ? el('span', { class: 'ctx-vtab-lock', 'aria-hidden': 'true', title: '관리자만 고칠 수 있습니다' }, ctxLockIcon()) : null);
    tabs.append(tab);
  }
  // 확인할 것 트레이 — 탭 줄 오른쪽 끝. 배지는 paintStageHealth 가 채운다(사람 몫이 0이면 배지 없음).
  tabs.append(el('span', { class: 'ctx-vtabs-sp', 'aria-hidden': 'true' }));
  tabs.append(el('a', {
    class: 'pjv-vtab ctx-vtab ctx-vtab-tray' + (selStage.key === 'inbox' ? ' active' : ''),
    href: '#/context/inbox', role: 'tab', 'aria-selected': String(selStage.key === 'inbox'),
    title: '사람 손이 필요한 것 전부 — 승인 · 카테고리 제안 · 점검 발견',
  },
    el('span', { class: 'ctx-vtab-label', text: '확인할 것' }),
    el('b', { class: 'ctx-tray-n num', hidden: true })));
  return el('div', { class: 'pjv-board-header ctx-board-header' }, crumbBar, tabs);
}

/** 건강 점을 붙일 수 있는 탭 — 파이프라인 4단계에 대응하는 탭만(현황·AI 전달은 판정이 없다). */
const HEALTH_TAB: Record<string, 'collect' | 'distill' | 'classify' | 'manage'> = {
  sources: 'collect', distill: 'distill', category: 'classify', checks: 'manage',
};

/** 탭의 건강 점 + 트레이 배지 — 개요 지도와 같은 판정·같은 수(잣대가 둘이면 화면끼리 다른 말을 한다). */
async function paintStageHealth(view: HTMLElement): Promise<void> {
  let d: any;
  try { d = await api('/api/ui/org/pipeline'); } catch { return; }
  const lv = stageHealthLevels(d);
  for (const [tabKey, stageKey] of Object.entries(HEALTH_TAB)) {
    const dotEl = view.querySelector('.ctx-vtab[data-stage="' + tabKey + '"] .ctx-vtab-dot') as HTMLElement | null;
    if (!dotEl || !dotEl.isConnected) continue;
    const level = (lv as any)[stageKey];
    if (level === 'ok') { dotEl.remove(); continue; }
    dotEl.classList.add('is-' + level);
    dotEl.title = level === 'note' ? '살펴볼 것이 있습니다' : level === 'warn' ? '확인이 필요합니다' : '멈춰 있습니다';
  }
  const trayN = view.querySelector('.ctx-vtab-tray .ctx-tray-n') as HTMLElement | null;
  if (trayN) {
    const n = inboxCount(d);
    if (n > 0) { trayN.textContent = n > 999 ? '999+' : String(n); trayN.hidden = false; }
  }
}

function ctxAppIcon(): SVGElement {
  const n = sv('svg', { class: 'pjv-crumb-ic ctx-crumb-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 5h16l-6.2 7.2V18l-3.6 2v-7.8z' }));   // 깔때기 — 런치패드 유리 아이콘과 같은 형태(맥락 관리 = 수집·증류·분류)
  return n;
}
function ctxLockIcon(): SVGElement {
  const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }), sv('path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }));
  return n;
}

export { renderContext as default };
