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
//  ⚠ 내비게이션(#1584) — 위계 2단(**단계 ▸ 그 단계의 화면**)을 **좌측 사이드바 하나**가 전담한다.
//   종전엔 페이지 안에 가로 탭이 2층(단계 바 + 세그먼티드 바)으로 쌓여 있었다. 그래서 ① 다른 탭
//   (프로젝트·WIKI·관리)은 전부 좌측 내비인데 이 탭만 홀로 달랐고 ② 2층 아래 화면이 시작하니 본문이
//   그만큼 밀렸으며 ③ 2층은 1층을 눌러야만 드러나서, '수집 안에 자료 공개범위가 있다'는 사실이
//   들어가 보기 전에는 보이지 않았다. 좌측으로 펴면 화면 11개가 항상 한눈에 보인다
//   (관리탭이 #827 에서 가로 중분류 바를 폐지하고 .docs-side 로 편 것과 같은 방향·같은 시각 언어).
//   위→아래 순서가 곧 파이프라인 순서라 '순서 자체가 정보'라는 성질도 그대로 남는다(번호로 못박는다).
import { el, hasScope, sv } from './core.js';
import { sectionHead } from './admin-widgets.js';
import { skeleton } from './ui-primitives.js';
import { renderPipeline } from './context-pipeline.js';
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
  /** 파이프라인 몇 번째 단계인가 — 좌측에서도 흐름 순서를 읽히게(개요는 단계가 아니라 없다). */
  step?: number;
  /** '보는 건 누구나, 고치는 건 관리자'인 단계. 네 단계 중 수집만 그렇다(외부 서비스 토큰을 다룬다).
   *  권한과 무관하게 늘 배지를 단다 — 안 그러면 막힌 사람은 "나만 안 보이나"가 되고,
   *  관리자는 자기 화면과 남의 화면이 다르다는 사실 자체를 모른다. */
  adminEdit?: boolean;
  /** 그룹 머리글 없이 항목 하나만 서는 단계(개요) — '개요'는 단계가 아니라 전체 조망이라 머리글이 없다. */
  solo?: boolean;
  items: CtxItem[];
};

/**
 * 정보구조 표 — 단계(그룹) ▸ 화면(항목). URL 은 `#/context/<stage>/<item>`.
 *
 * ⚠ 왜 이 단계들 안에 설정이 모여 있나(어니스트 실박스 지적, #1419): 파이프라인 단계에 속한 설정이
 *  [설정] 탭에도 남아 있으면 입구가 둘이 되고, 무엇보다 **그 단계를 보면서 앞뒤를 못 본다**. 수집기를
 *  고치다 '수집 방식'을 정의하려고 다른 탭으로 나가야 했고, 자료 공개범위는 수집 지점(mirror INSERT)에
 *  걸리는데 [설정 ▸ AI 맥락]에 있었다. 지식 검토 정책도 증류 산출물이 통과하는 밸브다.
 *  옛 URL 은 admin-shell 의 SECTION_EXIT 가 여기로 넘긴다(북마크 보존).
 */
const STAGES: CtxStage[] = [
  {
    key: 'overview', label: '개요', solo: true,
    items: [{
      key: 'overview', label: '개요',
      head: { title: '개요', hint: '수집부터 관리까지 흐름 전체를 한눈에 보고, 막힌 곳을 찾습니다.' },
      draw: (b) => renderPipeline(b),
    }],
  },
  {
    key: 'collect', label: '수집', step: 1, adminEdit: true,
    items: [
      { key: 'collectors', label: '수집기', head: { title: '수집기' }, draw: (b) => renderCollectors(b) },
      // 수집 '방식'(프리셋) — 수집기와 다른 객체다(틀 vs 인스턴스). 드물게 정의하지만 수집기 화면이
      //  가리키는 자리라, 나가지 않고 이 안에서 정의할 수 있어야 한다.
      { key: 'presets', label: '수집 방식', draw: (b) => collectorPresetEditor(b) },
      // 자료 공개범위 — match_system(+채널)으로 매칭해 **자료가 태어날 때** 공개범위를 새긴다(#1291 v4).
      //  생산 지점이 곧 수집이라 여기 있는 게 맞다.
      { key: 'source-vis', label: '자료 공개범위', draw: async (b) => { await sourceVisPolicyPanel(b); } },
    ],
  },
  {
    key: 'distill', label: '증류', step: 2,
    items: [
      { key: 'distillers', label: '증류기', draw: async (b) => { await distillersPanel(b, await adminData()); } },
      // 지식 검토 정책 — 증류가 만든 지식이 통과하는 밸브(#638). 생산 라인 바로 뒤가 제자리다.
      { key: 'ingest-policy', label: '지식 검토 정책', draw: async (b) => { await ingestPolicyPanel(b, await adminData()); } },
    ],
  },
  {
    key: 'classify', label: '분류', step: 3,
    items: [
      { key: 'classifiers', label: '분류기', head: { title: '분류기' }, draw: (b) => renderClassifiers(b) },
      { key: 'categories', label: '분류축', head: { title: '분류축' }, draw: (b) => renderCategoryList(b) },
    ],
  },
  {
    key: 'manage', label: '관리', step: 4,
    items: [
      { key: 'findings', label: '발견', head: { title: '발견' }, draw: (b) => renderFindings(b) },
      { key: 'managers', label: '관리기', head: { title: '관리기' }, draw: (b) => renderManagers(b) },
    ],
  },
  // ── 5단계 전달(#1618) — 설정탭 'AI 맥락' 그룹 3화면을 여기로 옮겼다. ─────────────────────────
  //  왜 5단계인가: 1~4 는 '자료를 쓸 만한 지식으로 만드는' 생산 라인이고, 이 셋은 **그 지식이 실제로
  //   AI 에게 닿는 경로**다 — 항상 주입되는 것(세션 주입) · 필요할 때 찾아지는 것(의미 검색) · 누구에게
  //   닿는지(공개범위). 라인이 아무리 잘 돌아도 이 단계가 비면 AI 는 그 지식을 못 쓴다. 실제로 임베딩
  //   기본값이 off 라, 새 조직은 의미 검색이 꺼진 채 출발하는데 knowledge_search 는 실패하지 않고
  //   조용히 단어 일치로 폴백한다 — 이 자리가 없으면 그 사실을 알 방법이 없었다.
  //  왜 옮겼나: 맥락 화면이 두 탭에 갈려 있었다. 이 탭의 존재 이유가 '단계를 보면서 앞뒤를 함께 보는 것'
  //   인데(위 STAGES 주석), 정작 맥락이 AI 에 닿는 마지막 구간만 다른 탭에 있었다. 복제가 아니라 이관이다
  //   — 관리탭의 같은 패널을 그대로 부르고(코드 복제 0), 옛 URL 은 admin-shell 의 SECTION_EXIT 가 여기로 넘긴다.
  {
    key: 'deliver', label: '전달', step: 5, adminEdit: true,
    items: [
      // 세션 주입 — 매 세션 항상 들어가는 조직 정체성(org-defaults 등 injection='always').
      //  구 [설정]에서도 ADMIN_ONLY 가 아니었다(전 구성원이 무엇이 주입되는지 볼 수 있어야 한다) → 그대로.
      { key: 'injection', label: '세션 주입', draw: async (b) => { await injectionMap(b, await adminData()); } },
      // 의미 검색 — 임베딩 provider·백필. 기본 off(뜻으로 찾기가 꺼진 상태). 서버가 GET 부터 admin.
      { key: 'embeddings', label: '의미 검색', adminOnly: true, draw: async (b) => { await embeddingsEditor(b, await adminData()); } },
      // 공개범위 — 어떤 유형에 공개범위 축을 쓸지. 자료 축은 이미 [수집 ▸ 자료 공개범위]에 있다(생산 지점).
      //  누가 무엇을 볼 수 있는지를 정하는 보안 경계라 구 [설정]에서도 ADMIN_ONLY 였다 → 그대로.
      { key: 'visibility', label: '공개범위', adminOnly: true, draw: async (b) => { await visibilityAxesPanel(b); } },
    ],
  },
];

/**
 * `#/context/distill/<sub2>` 가 **증류기 설정 페이지**를 가리키나(#1564).
 *  증류 단계의 화면 키('distillers'·'ingest-policy')가 아니면 증류기 식별자로 읽는다 — 그 URL 은
 *  이 셸 밖의 전용 페이지라 라우터도 레이아웃(전폭)을 달리 잡아야 해서, 판정을 여기 한 곳에 둔다.
 *  (증류기 key 가 하필 화면 키와 같으면 목록이 뜬다. 서버가 막지는 않지만 실사용에서 겹칠 이름이 아니고,
 *   겹쳐도 잃는 것은 딥링크 하나뿐이라 URL 을 한 단 더 깊게 만드는 비용보다 싸다.)
 */
export function isDistillerDetailPath(sub: string | null | undefined, sub2: string | null | undefined): boolean {
  if (sub !== 'distill' || !sub2) return false;
  const stage = STAGES.find((s) => s.key === 'distill')!;
  return !stage.items.some((i) => i.key === sub2);
}

export async function renderContext(view: HTMLElement, sub?: string | null, sub2?: string | null): Promise<void> {
  // 증류기 설정(#/context/distill/<key>)은 **이 셸 밖**의 전용 페이지다(#1564) — 3단 전폭을 쓰려면
  //  좌측 단계 내비가 자리를 비켜야 한다(종전 세로 1840px = 2화면의 절반이 그것이었다).
  //  대신 그 페이지의 크럼이 '맥락 관리 › 증류'라는 위치 정보를 대신 진다.
  if (isDistillerDetailPath(sub, sub2)) { await distillerPage(view, String(sub2)); return; }

  const stage = STAGES.find((s) => s.key === sub) ?? STAGES[0];
  // adminOnly 화면(#1618)은 비-admin 에게 **주소로도** 열리지 않는다 — 내비에서 숨기기만 하면 옛 북마크·
  //  공유 링크로 들어와 403 카드만 보게 된다(구 [설정] 탭도 숨김+게이트 둘 다 했다). 그 단계의 첫 볼 수 있는
  //  화면으로 떨군다. 서버가 이미 막고 있으므로 이건 보안이 아니라 '막다른 화면을 안 보여주는' 처리다.
  const canSee = (i: CtxItem) => !i.adminOnly || hasScope('admin');
  const visible = stage.items.filter(canSee);
  const asked = stage.items.find((i) => i.key === sub2);
  const item = (asked && canSee(asked) ? asked : null) ?? visible[0] ?? stage.items[0];

  const host = el('div', {}, skeleton('불러오는 중'));
  const body = el('div', { class: 'ctx-body' },
    stageCrumb(stage), item.head ? sectionHead(item.head.title, item.head.hint || null) : null, host);
  // .docs-layout = 사이드바 + 본문 2단(반응형 세로 스택까지 그 안에 있다). 관리탭이 'docs-layout admin-layout'
  //  으로 쓰는 것과 같은 짝이다 — 골격은 공유하고, 이 탭 사정(본문 폭)만 .ctx-layout 이 덧쓴다.
  view.replaceChildren(el('div', { class: 'docs-layout ctx-layout' }, buildSide(stage, item), body));

  // 화면 본문. 실패는 자기 자리에서 처리한다(내비까지 죽이지 않는다 — 다른 화면으로는 갈 수 있어야 한다).
  try { await item.draw(host); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
  }
}

/**
 * 본문 머리의 위치 한 줄 — '맥락 관리 › ③ 분류'.
 *
 * ⚠ 왜 필요한가(#1584 사용자 지적): 좌측 내비로 옮기고 나니 **지금 어느 단계인지 감각이 죽었다**.
 *  종전 가로 탭은 본문 바로 위에서 '분류' 탭이 켜져 있어 위치가 눈에 박혔는데, 좌측으로 가면 그 정보가
 *  시선 밖(왼쪽 끝)으로 밀린다 — 본문만 보고 있으면 '분류축'이라는 제목뿐이라 어느 단계에 속한 화면인지
 *  본문 안에는 아무 단서가 없다. 증류기 설정 페이지(#1564)가 같은 이유로 이미 크럼(.dst-crumb)을 쓰고 있어
 *  같은 문법을 그대로 따른다(새 문법 발명 0).
 *  개요는 그리지 않는다 — 단계가 아니라 전체 조망이고, 사이드바 맨 위 단독 항목이라 위치가 이미 명확하다.
 */
function stageCrumb(stage: CtxStage): HTMLElement | null {
  if (stage.solo) return null;
  return el('nav', { class: 'ctx-crumb', 'aria-label': '위치' },
    el('a', { href: '#/context/overview', text: '맥락 관리' }),
    el('span', { class: 'ctx-crumb-sep', 'aria-hidden': 'true', text: '›' }),
    // 단계 이름도 링크다 — 그 단계 첫 화면으로. '옆 화면으로 가려면 왼쪽까지 시선을 옮겨야 하나'를 없앤다.
    el('a', { class: 'ctx-crumb-stage', href: '#/context/' + stage.key + '/' + stage.items[0].key },
      stage.step ? el('span', { class: 'ctx-crumb-step', 'aria-hidden': 'true', text: String(stage.step) }) : null,
      el('span', { text: stage.label })));
}

/**
 * 좌측 내비 — 관리탭·사용 가이드의 .docs-side 를 그대로 쓴다(탭 사이 시각 언어 통일).
 *
 * 그 위에 **단계 레일**을 얹는다(#1584): 번호 원을 세로선으로 잇고, 지나온 단계·현재 단계·아직인 단계를
 *  세 상태로 칠한다. 번호만 붙여 뒀을 땐 '수집 → 증류 → 분류 → 관리'가 흐름으로 안 읽혔다 — 가로 배열이
 *  공짜로 주던 순서·진행 감각을 세로에서 되찾으려면 선이 필요하다(사용자 지적).
 *  ⚠ 개요를 보는 중이면 현재 단계가 없다(step 0). 이때 넷을 전부 '아직'으로 흐리면 사이드바가 통째로
 *  죽은 화면이 된다 — 개요는 **전체 조망**이라 파이프라인이 오히려 또렷해야 한다. 그래서 별도 상태
 *  (is-idle)로 두고 '지나온'과 같은 톤으로 칠한다: 어느 한 단계도 강조하지 않되 넷 다 살아 있다.
 */
function buildSide(selStage: CtxStage, selItem: CtxItem): HTMLElement {
  const side = el('nav', { class: 'docs-side ctx-side', 'aria-label': '맥락 관리 단계' });
  const curStep = selStage.step ?? 0;
  for (const s of STAGES) {
    // 개요는 목록의 한 줄이 아니라 **눌러서 들어가는 입구**다(#1584 사용자 지적: "누를 수 있는 버튼 같지가
    //  않다"). 굵은 잉크 한 줄로 두니 아래 단계 머리글(수집·증류…)과 같은 모양이라 라벨로 읽혔다 —
    //  머리글은 안 눌리는 것이므로, 같은 모양이면 안 눌리는 것으로 학습된다. 그래서 카드로 세운다:
    //  테두리·틴트가 클릭 대상임을 말하고, 아이콘이 '흐름 전체'를, 부제가 '눌러서 무엇을 보는지'를 말한다.
    if (s.solo) { side.append(overviewCard(s, selStage.key === s.key)); continue; }
    const railState = !s.step ? ''
      : !curStep ? ' is-idle'                                    // 개요 — 강조 없이 넷 다 또렷하게
      : s.step < curStep ? ' is-done' : s.step === curStep ? ' is-current' : ' is-todo';
    const box = el('div', { class: 'docs-side-group ctx-stage' + railState });
    {
      box.append(el('div', { class: 'docs-side-title' },
        s.step ? el('span', { class: 'ctx-side-step', 'aria-hidden': 'true', text: String(s.step) }) : null,
        el('span', { text: s.label }),
        // 배지 문구는 '관리자' 하나로 통일한다(#1085) — admin·memory 같은 내부 scope 이름은 보는 사람에게
        //  아무 뜻이 아니고, 실제로 그 자리를 고칠 수 있는 사람은 관리 권한을 받은 사람이다.
        //  머리글은 링크가 아니라 읽히는 이름이라, 배지는 aria-hidden 으로 이름에 섞이지 않게 두고
        //  뜻은 title 로 준다(종전 가로 탭에서 '수집관리자'로 붙어 읽히던 문제와 같은 처리).
        s.adminEdit
          ? el('span', { class: 'admin-only-badge', text: '관리자', 'aria-hidden': 'true',
              title: '보는 것은 모든 구성원이 할 수 있고, 만들고 고치는 것은 관리자만 할 수 있는 단계입니다.' })
          : null));
    }
    for (const it of s.items) {
      if (it.adminOnly && !hasScope('admin')) continue;   // #1618 — 눌러도 403 인 자리는 아예 안 그린다
      const on = s.key === selStage.key && it.key === selItem.key;
      box.append(el('a', {
        class: 'docs-item' + (on ? ' active' : ''),
        href: '#/context/' + s.key + '/' + it.key,
        'aria-current': on ? 'page' : null,
      }, el('span', { text: it.label })));
    }
    side.append(box);
  }
  return side;
}

/**
 * 개요 입구 카드 — 사이드바 맨 위에서 '전체 흐름을 보러 들어가는 자리'임을 스스로 말한다.
 *
 * 네 조각이 각자 다른 일을 한다:
 *   ① 테두리 + 틴트 배경 — 이 행이 **눌린다**는 신호(아래 단계 머리글은 안 눌리는 텍스트다).
 *   ② 흐름 아이콘 — 점 셋을 선으로 이어 '단계가 이어진 전체'를 그린다(개요 화면의 4단계 트랙 은유).
 *   ③ 부제 — 눌러서 **무엇을 보는지**. '개요'라는 이름만으로는 목차처럼 읽혀 들어갈 이유가 안 생긴다.
 *              단, 담는 것은 화면의 내용물뿐이다(아래 주석 참조).
 *   ④ '›' — 이동한다는 마지막 힌트.
 */
function overviewCard(s: CtxStage, on: boolean): HTMLElement {
  const it = s.items[0];
  const ic = sv('svg', { class: 'ctx-side-ov-ic', viewBox: '0 0 24 24', width: '19', height: '19', 'aria-hidden': 'true' });
  ic.append(
    sv('path', { d: 'M6.4 12h3.2M14.4 12h3.2', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', opacity: '0.6' }),
    sv('circle', { cx: '4', cy: '12', r: '2.6', fill: 'currentColor' }),
    sv('circle', { cx: '12', cy: '12', r: '2.6', fill: 'currentColor', opacity: '0.85' }),
    sv('circle', { cx: '20', cy: '12', r: '2.6', fill: 'currentColor', opacity: '0.7' }));
  return el('a', {
    // 개요는 화면이 하나뿐이라 단계 키까지면 충분하다 — '#/context/overview/overview' 는 같은 말을 두 번 한다.
    //  (라우터가 하위 화면 미지정이면 첫 화면으로 폴백하므로 동작은 같다.)
    class: 'ctx-side-ov' + (on ? ' active' : ''),
    href: '#/context/' + s.key,
    'aria-current': on ? 'page' : null,
  }, ic,
    el('span', { class: 'ctx-side-ov-t' },
      el('span', { class: 'ctx-side-ov-label', text: it.label }),
      // 부제는 **이 화면에 무엇이 있는지**만 말한다 — '한눈에'·'찾습니다' 같은 말은 기능이 아니라 광고다.
      //  네 단계를 그대로 적으면 '이 넷을 한 화면에서 본다'가 읽히고, '현황'은 이 탭이 이미 쓰는 말이다
      //  (분류 현황 · 증류 현황 · 종류별 현황).
      el('span', { class: 'ctx-side-ov-sub', text: '수집 · 증류 · 분류 · 관리 현황' })),
    el('span', { class: 'ctx-side-ov-go', 'aria-hidden': 'true', text: '›' }));
}

export { renderContext as default };
