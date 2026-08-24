// context.ts — [맥락 관리] 탭 셸(#1419 T6). 구 [분류체계] 탭의 자리를 넓혀 파이프라인 전체를 담는다.
//
//  요구 원문: "지금의 분류체계탭을 맥락 관리로 바꾸고 … 맥락관리에는 수집기, 증류지, 분류기 및
//   수집-증류-분류 파이프라인을 다 관리할수있게. 비개발자도 쉽게관리할수있어야하고."
//
//  구조 결정:
//   · **개요(파이프라인)가 기본 화면**이다. 설정 목록이 아니라 '지금 어디가 막혔나'가 먼저 보여야
//     비개발자가 무엇을 할지 안다. 설정은 그 다음이다.
//   · **분류축(카테고리 CRUD)은 '분류' 단계 안**에 있다. 그게 이 탭의 옛 정체성이었지만, 이제는
//     파이프라인의 한 부분이다 — 분류기가 쓰는 기준이 곧 분류축의 정의(should)이므로 같은 자리에 있어야 한다.
//   · 저장 경로(API)는 하나도 안 바꿨다 — **합치는 건 화면이지 데이터가 아니다**(#837 불변식).
//     증류기 화면은 관리탭의 distillersPanel 을 그대로 부른다(복제 0).
//
//  ⚠ 내비게이션(#1841, 2026-08-24) — 위계 2단(**단계 ▸ 그 단계의 화면**)을 **프로젝트 탭과 같은 머리 3층**이 전담한다:
//   뷰 탭 줄 = 단계(흐름 화살·건강 점 포함), 툴바 = 그 단계의 화면 알약. 아래 #1584 의 좌측 사이드바 결정은 이로써 뒤집혔다 —
//   이 탭만 홀로 좌측 내비를 가져 "사이드바가 여기만 또 있어 어색하다"(원준). 세 앱이 같은 머리를 가지면 2층이 본문을 민다는 걱정은
//   '밀림'이 아니라 규칙이 된다.
//  (구) 내비게이션(#1584) — 위계 2단(**단계 ▸ 그 단계의 화면**)을 **좌측 사이드바 하나**가 전담한다.
//   종전엔 페이지 안에 가로 탭이 2층(단계 바 + 세그먼티드 바)으로 쌓여 있었다. 그래서 ① 다른 탭
//   (프로젝트·WIKI·관리)은 전부 좌측 내비인데 이 탭만 홀로 달랐고 ② 2층 아래 화면이 시작하니 본문이
//   그만큼 밀렸으며 ③ 2층은 1층을 눌러야만 드러나서, '수집 안에 자료 공개범위가 있다'는 사실이
//   들어가 보기 전에는 보이지 않았다. 좌측으로 펴면 화면 11개가 항상 한눈에 보인다
//   (관리탭이 #827 에서 가로 중분류 바를 폐지하고 .docs-side 로 편 것과 같은 방향·같은 시각 언어).
//   위→아래 순서가 곧 파이프라인 순서라 '순서 자체가 정보'라는 성질도 그대로 남는다(번호로 못박는다).
import { api, el, hasScope, sv } from './core.js';
import { sectionHead } from './admin-widgets.js';
import { skeleton } from './ui-primitives.js';
import { stageHealthLevels } from './context-pipeline.js';
import { renderContextHome } from './context-home.js';   // #1841 새 첫 화면 — 아는 것 + 할 일
import { renderCollectors } from './context-collectors.js';
import { renderClassifiers } from './context-classify.js';
import { renderFindings, renderManagers } from './context-manage.js';
import { renderCategoryList } from './categories.js';
import { distillerPage, distillersPanel } from './distillers.js';
import { collectorPresetEditor } from './admin-collector-presets.js';  // 수집 방식(커스텀 프리셋) — 수집 단계 안으로(#1419)
import { sourceVisPolicyPanel } from './source-vis-policy.js';         // 자료 공개범위(#1291 v4) — 생산 지점이 수집이다
import { ingestPolicyPanel } from './review.js';                       // 지식 검토 정책(#638) — 증류 산출물이 통과하는 밸브
// ── 5단계 '전달'(#1618) — 구 [설정 ▸ AI 맥락] 3화면. 관리탭 패널을 그대로 부른다(복제 0, #837 불변식).
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
  /** 화면 머리(제목 + 한 줄 설명). **자체 제목을 이미 그리는 패널엔 두지 않는다** — 두면 제목이 두 번 나온다.
   *  (수집 방식·자료 공개범위·증류기·지식 검토 정책이 그렇다: 관리탭에서 쓰이던 패널이라 sectionHead 를 갖고 온다.)
   *  hint 도 마찬가지다 — 파이프라인 화면 대부분은 본문 첫 줄에 자기 설명을 이미 갖고 있어서(실측: 수집기·
   *  분류기·발견·관리기 넷 다) 셸이 한 줄 더 얹으면 같은 말이 두 번 나온다. 제목만 주고 설명은 본문에 맡긴다. */
  head?: { title: string; hint?: string | null };
  /** 관리자만 **조회**까지 되는 화면(#1618). 단계 단위 adminEdit('보긴 다 보고 고치는 건 관리자')과 다른 축이다 —
   *  이건 서버가 GET 부터 admin scope 로 막는 화면이라, 비-admin 에게 항목을 보여 주면 눌렀을 때 403 만
   *  남는다. 구 [설정] 탭에서 ADMIN_ONLY 로 **아예 숨겨져 있던** 것들이라 숨김이 곧 종전 동작이기도 하다. */
  adminOnly?: boolean;
  draw: (b: HTMLElement) => Promise<void>;
};
type CtxStage = {
  key: string;
  label: string;
  /** 이 탭이 무엇을 하는 자리인지 — 사람 말 한 줄. 빵부스러기 옆에 그대로 선다. */
  hint: string;
  /** '보는 건 누구나, 고치는 건 관리자'인 탭 — 자물쇠 배지. */
  adminEdit?: boolean;
  /** 항목 알약 없이 화면 하나만 서는 탭(현황). */
  solo?: boolean;
  items: CtxItem[];
};

/**
 * 정보구조(#1841 전면 재설계, 2026-08-24) — **사람이 하는 일** 단위의 탭 ▸ 그 안의 화면. URL 은 `#/context/<tab>/<item>`.
 *
 * ⚠ 왜 갈아엎었나: 원준 지적 "사용자 입장에서 뭐하는건지 감이 안 옴". 옛 구조는 파이프라인 **부품 이름**
 *  (수집기·증류기·분류기·관리기·주입)으로 5단계 13화면을 늘어놓았다. 부품 이름은 만든 사람의 언어지 쓰는 사람의 언어가 아니다
 *  — "증류기가 없습니다"를 읽고도 그게 나쁜 상태인지, 뭘 해야 하는지 알 수 없었다.
 *  새 구조의 규칙 셋:
 *   ① 탭 이름은 **하는 일**이다(가져오는 곳 · 지식 만들기 · 갈래 · 점검 · AI 에 전달).
 *   ② 첫 화면(현황)은 지표가 아니라 **아는 것 + 할 일**을 말한다(context-home).
 *   ③ 기계 이름은 화면 안에서 필요할 때만 쓰고, 항목 알약은 그 화면에서 **정하는 것**으로 이름 붙인다.
 *  기능은 하나도 버리지 않았다 — 13화면의 패널을 그대로 부르고, 옛 URL 은 아래 LEGACY 표가 새 자리로 넘긴다.
 */
const STAGES: CtxStage[] = [
  {
    key: 'home', label: '현황', solo: true,
    hint: '우리 AI 가 무엇을 알고, 지금 무엇이 막혀 있나',
    items: [{ key: 'home', label: '현황', draw: (b) => renderContextHome(b) }],
  },
  {
    key: 'sources', label: '가져오는 곳', adminEdit: true,
    hint: '슬랙·노션 같은 도구에서 무엇을 가져올지 — 자료가 여기서 들어옵니다',
    items: [
      { key: 'collectors', label: '연결', draw: (b) => renderCollectors(b) },
      // 수집 '방식'(프리셋) — 연결이 고를 수 있는 틀. 드물게 정의하지만 연결 화면이 가리키는 자리라 같은 탭에 둔다.
      { key: 'presets', label: '새 소스 만들기', draw: (b) => collectorPresetEditor(b) },
      // 자료 공개범위 — 자료가 **태어날 때** 공개범위를 새긴다(#1291 v4). 서버가 GET 부터 admin 이라 adminOnly.
      { key: 'source-vis', label: '자료를 볼 사람', adminOnly: true, draw: async (b) => { await sourceVisPolicyPanel(b); } },
    ],
  },
  {
    key: 'knowledge', label: '지식 만들기',
    hint: '들어온 자료 중 무엇을 어떤 형식의 지식으로 남길지',
    items: [
      { key: 'distillers', label: '만드는 기준', draw: async (b) => { await distillersPanel(b, await adminData()); } },
      // 지식 검토 정책 — 만들어진 지식이 통과하는 밸브(#638). 만드는 기준 바로 뒤가 제자리다.
      { key: 'ingest-policy', label: '사람 확인', draw: async (b) => { await ingestPolicyPanel(b, await adminData()); } },
    ],
  },
  {
    key: 'topics', label: '갈래',
    hint: '지식을 어떤 갈래로 나눌지 — 갈래가 없으면 AI 가 검색해도 안 나옵니다',
    items: [
      // 갈래 정의가 먼저다 — 배정 규칙은 이 정의를 기준으로 판단한다(정의가 비면 기준도 없다).
      { key: 'categories', label: '갈래 정하기', draw: (b) => renderCategoryList(b) },
      { key: 'classifiers', label: '자동 배정', draw: (b) => renderClassifiers(b) },
    ],
  },
  {
    key: 'checks', label: '점검',
    hint: '쌓인 지식이 낡거나 어긋나지 않게 — 찾아낸 것을 확인하고 고칩니다',
    items: [
      // 발견이 먼저 — 여기 오는 사람 대부분은 설정을 바꾸러가 아니라 쌓인 것을 처리하러 온다.
      { key: 'findings', label: '확인할 것', draw: (b) => renderFindings(b) },
      { key: 'managers', label: '검사 규칙', draw: (b) => renderManagers(b) },
    ],
  },
  {
    key: 'deliver', label: 'AI 에 전달', adminEdit: true,
    hint: '쌓인 지식이 실제로 AI 에 닿는 마지막 구간',
    items: [
      { key: 'injection', label: '매번 읽는 것', draw: async (b) => { await injectionMap(b, await adminData()); } },
      { key: 'embeddings', label: '뜻으로 찾기', adminOnly: true, draw: async (b) => { await embeddingsEditor(b, await adminData()); } },
      { key: 'visibility', label: '공개 범위', adminOnly: true, draw: async (b) => { await visibilityAxesPanel(b); } },
    ],
  },
];

/** 옛 주소(단계 이름) → 새 자리. 북마크·문서·화면 안 링크가 살아 있어야 한다. */
const LEGACY_STAGE: Record<string, string> = { overview: 'home', collect: 'sources', distill: 'knowledge', classify: 'topics', manage: 'checks', deliver: 'deliver' };
const LEGACY_ITEM: Record<string, string> = { overview: 'home' };

/**
 * `#/context/knowledge/<sub2>` 가 **증류기 설정 페이지**를 가리키나(#1564).
 *  증류 단계의 화면 키('distillers'·'ingest-policy')가 아니면 증류기 식별자로 읽는다 — 그 URL 은
 *  이 셸 밖의 전용 페이지라 라우터도 레이아웃(전폭)을 달리 잡아야 해서, 판정을 여기 한 곳에 둔다.
 *  (증류기 key 가 하필 화면 키와 같으면 목록이 뜬다. 서버가 막지는 않지만 실사용에서 겹칠 이름이 아니고,
 *   겹쳐도 잃는 것은 딥링크 하나뿐이라 URL 을 한 단 더 깊게 만드는 비용보다 싸다.)
 */
export function isDistillerDetailPath(sub: string | null | undefined, sub2: string | null | undefined): boolean {
  if ((sub !== 'knowledge' && sub !== 'distill') || !sub2) return false;   // 'distill' 은 옛 주소(#1841 이전)
  const stage = STAGES.find((s) => s.key === 'knowledge')!;
  return !stage.items.some((i) => i.key === sub2);
}

export async function renderContext(view: HTMLElement, sub?: string | null, sub2?: string | null): Promise<void> {
  // 증류기 설정(#/context/distill/<key>)은 **이 셸 밖**의 전용 페이지다(#1564) — 3단 전폭을 쓰려면
  //  좌측 단계 내비가 자리를 비켜야 한다(종전 세로 1840px = 2화면의 절반이 그것이었다).
  //  대신 그 페이지의 크럼이 '맥락 관리 › 증류'라는 위치 정보를 대신 진다.
  if (isDistillerDetailPath(sub, sub2)) { await distillerPage(view, String(sub2)); return; }

  // 옛 주소(단계 이름)로 들어오면 새 자리로 조용히 옮긴다 — 북마크·문서·화면 안 링크 보존.
  if (sub && !STAGES.some((s) => s.key === sub) && LEGACY_STAGE[sub]) {
    const it = sub2 ? (LEGACY_ITEM[sub2] || sub2) : '';
    location.replace('#/context/' + LEGACY_STAGE[sub] + (it ? '/' + it : ''));
    return;
  }
  const stage = STAGES.find((s) => s.key === sub) ?? STAGES[0];
  // adminOnly 화면(#1618)은 비-admin 에게 **주소로도** 열리지 않는다 — 내비에서 숨기기만 하면 옛 북마크·
  //  공유 링크로 들어와 403 카드만 보게 된다(구 [설정] 탭도 숨김+게이트 둘 다 했다). 그 단계의 첫 볼 수 있는
  //  화면으로 떨군다. 서버가 이미 막고 있으므로 이건 보안이 아니라 '막다른 화면을 안 보여주는' 처리다.
  const canSee = (i: CtxItem) => !i.adminOnly || hasScope('admin');
  const visible = stage.items.filter(canSee);
  const asked = stage.items.find((i) => i.key === sub2);
  const item = (asked && canSee(asked) ? asked : null) ?? visible[0] ?? stage.items[0];

  const host = el('div', {}, skeleton('불러오는 중'));
  // 개요는 탭 이름이 곧 제목이고 한 줄 설명은 빵부스러기 옆에 있다 — 본문 머리를 또 세우면 같은 말이 세 번(탭·머리·요약) 난다.
  const body = el('div', { class: 'ctx-body' },
    item.head && !stage.solo ? sectionHead(item.head.title, item.head.hint || null) : null, host);
  // #1841 — 좌측 단계 사이드바(#1584)를 걷고, **프로젝트 탭과 같은 머리 3층**으로 올린다:
  //  ① 빵부스러기(앱 이름) ② 뷰 탭 = 단계 줄(개요 · ①수집 › ②증류 › ③분류 › ④관리 › ⑤전달 — 탭 사이 화살이 흐름을,
  //     탭 안 점이 그 단계의 건강을 말한다 = 개요 다이어그램의 축약판) ③ 툴바 = 그 단계의 화면 알약(수집기 · 수집 방식 · …).
  //  원준 지적(2026-08-24): "좌측 사이드바가 여기만 또 있어 어색하다 — 세로 단계를 상단 가로 줄로 보내고 탭처럼 고르게".
  //  #1584 가 좌측으로 간 이유('2층 아래 화면이 시작해 본문이 밀린다·2층이 숨어 있다')는 머리 3층이 프로젝트·WIKI·AI 세션과
  //  같은 높이로 고정되면서 사라진다 — 모든 앱이 같은 자리에 같은 두께의 머리를 가지면 그건 밀림이 아니라 규칙이다.
  view.replaceChildren(el('div', { class: 'pjv-board-wrap ctx-board-wrap' },
    el('div', { class: 'card pjv-listboard ctx-board' }, buildHeader(stage, item), body)));
  void paintStageHealth(view);

  // 화면 본문. 실패는 자기 자리에서 처리한다(내비까지 죽이지 않는다 — 다른 화면으로는 갈 수 있어야 한다).
  try { await item.draw(host); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
  }
}

/**
 * 머리 3층(#1841) — 프로젝트 탭 .pjv-board-header 동형.
 *  단계 줄은 **탭이면서 다이어그램**이다: 번호 원 · 이름 · 건강 점(수집·증류·분류·관리)이 한 탭이고, 탭 사이 '›' 가 흐름이다.
 *  개요는 단계가 아니라 전체 조망이라 맨 앞에 떨어져 선다(흐름 화살 없이). 관리자 편집 단계는 자물쇠 배지.
 */
function buildHeader(selStage: CtxStage, selItem: CtxItem): HTMLElement {
  const crumbBar = el('div', { class: 'pjv-crumbbar' },
    el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' },
      el('span', { class: 'pjv-crumb is-leaf ctx-crumb-leaf' }, ctxAppIcon(), el('span', { class: 'pjv-crumb-label', text: '맥락 관리' })),
      el('span', { class: 'ctx-crumb-sub', text: selStage.hint })));
  const tabs = el('div', { class: 'pjv-vtabs ctx-vtabs', role: 'tablist', 'aria-label': '맥락 관리' });
  for (const s of STAGES) {
    const on = s.key === selStage.key;
    const first = s.items.filter((i) => !i.adminOnly || hasScope('admin'))[0] || s.items[0];
    const tab = el('a', {
      class: 'pjv-vtab ctx-vtab' + (on ? ' active' : '') + (s.solo ? ' ctx-vtab-ov' : ''),
      href: s.solo ? '#/context/' + s.key : '#/context/' + s.key + '/' + first.key,
      role: 'tab', 'aria-selected': String(on), 'data-stage': s.key,
      title: s.hint + (s.adminEdit ? ' — 보는 것은 모든 구성원, 만들고 고치는 것은 관리자' : ''),
    },
      el('span', { class: 'ctx-vtab-label', text: s.label }),
      // 건강 점은 '지금 문제가 있는 탭'에만 붙는다(paintStageHealth 가 ok 면 지운다) — 늘 켜진 점은 신호가 아니라 장식이다.
      HEALTH_TAB[s.key] ? el('span', { class: 'ctx-vtab-dot', 'aria-hidden': 'true' }) : null,
      s.adminEdit ? el('span', { class: 'ctx-vtab-lock', 'aria-hidden': 'true', title: '관리자만 고칠 수 있습니다' }, ctxLockIcon()) : null);
    tabs.append(tab);
  }
  // 툴바 좌측 — 이 탭에서 정하는 것들(알약). 현황은 화면이 하나뿐이라 알약을 세우지 않는다.
  const left = el('div', { class: 'pjv-tasks-head-left' });
  if (!selStage.solo) {
    for (const it of selStage.items) {
      if (it.adminOnly && !hasScope('admin')) continue;   // #1618 — 눌러도 403 인 자리는 아예 안 그린다
      const on = it.key === selItem.key;
      left.append(el('a', { class: 'pjv-tb-btn pjv-tb-pill ctx-pill' + (on ? ' active' : ''), href: '#/context/' + selStage.key + '/' + it.key, 'aria-current': on ? 'page' : null },
        el('span', { class: 'pjv-view-btn-label', text: it.label })));
    }
  }
  const right = el('div', { class: 'card-head-actions' });
  const toolbar = selStage.solo ? null : el('div', { class: 'card-head pjv-board-toolbar' }, left, right);
  return el('div', { class: 'pjv-board-header ctx-board-header' }, crumbBar, tabs, toolbar);
}

/** 건강 점을 붙일 수 있는 탭 — 파이프라인 4단계에 대응하는 탭만(현황·AI 에 전달은 판정이 없다). */
const HEALTH_TAB: Record<string, 'collect' | 'distill' | 'classify' | 'manage'> = {
  sources: 'collect', knowledge: 'distill', topics: 'classify', checks: 'manage',
};

/** 탭의 건강 점 — 개요 카드와 같은 판정(stageHealthLevels). **ok 면 점을 지운다** — 문제 있는 탭만 눈에 띄어야 한다. */
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
