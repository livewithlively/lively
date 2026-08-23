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
import { renderPipeline, stageHealthLevels } from './context-pipeline.js';
import { renderCollectors } from './context-collectors.js';
import { renderClassifiers } from './context-classify.js';
import { renderFindings, renderManagers } from './context-manage.js';
import { renderCategoryList } from './categories.js';
import { distillerPage, distillersPanel } from './distillers.js';
import { collectorPresetEditor } from './admin-collector-presets.js'; // 수집 방식(커스텀 프리셋) — 수집 단계 안으로(#1419)
import { sourceVisPolicyPanel } from './source-vis-policy.js'; // 자료 공개범위(#1291 v4) — 생산 지점이 수집이다
import { ingestPolicyPanel } from './review.js'; // 지식 검토 정책(#638) — 증류 산출물이 통과하는 밸브
// ── 5단계 '전달'(#1618) — 구 [설정 ▸ AI 맥락] 3화면. 관리탭 패널을 그대로 부른다(복제 0, #837 불변식).
import { injectionMap } from './admin-injection.js'; // 세션 주입 — 항상 주입되는 조직 정체성
import { embeddingsEditor } from './admin-embeddings.js'; // 의미 검색 — 임베딩 provider·백필(기본 off)
import { visibilityAxesPanel } from './visibility-axes.js'; // 공개범위 — 유형별 축 on/off
import { loadAdmin } from './admin-rerender.js';
/** 관리탭 패널이 요구하는 admin 데이터 — 없으면 빈 객체(패널이 자기 API 로 그린다). */
async function adminData() {
    try {
        return await loadAdmin();
    }
    catch {
        return {};
    }
}
/**
 * 정보구조 표 — 단계(그룹) ▸ 화면(항목). URL 은 `#/context/<stage>/<item>`.
 *
 * ⚠ 왜 이 단계들 안에 설정이 모여 있나(어니스트 실박스 지적, #1419): 파이프라인 단계에 속한 설정이
 *  [설정] 탭에도 남아 있으면 입구가 둘이 되고, 무엇보다 **그 단계를 보면서 앞뒤를 못 본다**. 수집기를
 *  고치다 '수집 방식'을 정의하려고 다른 탭으로 나가야 했고, 자료 공개범위는 수집 지점(mirror INSERT)에
 *  걸리는데 [설정 ▸ AI 맥락]에 있었다. 지식 검토 정책도 증류 산출물이 통과하는 밸브다.
 *  옛 URL 은 admin-shell 의 SECTION_EXIT 가 여기로 넘긴다(북마크 보존).
 */
const STAGES = [
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
export function isDistillerDetailPath(sub, sub2) {
    if (sub !== 'distill' || !sub2)
        return false;
    const stage = STAGES.find((s) => s.key === 'distill');
    return !stage.items.some((i) => i.key === sub2);
}
export async function renderContext(view, sub, sub2) {
    // 증류기 설정(#/context/distill/<key>)은 **이 셸 밖**의 전용 페이지다(#1564) — 3단 전폭을 쓰려면
    //  좌측 단계 내비가 자리를 비켜야 한다(종전 세로 1840px = 2화면의 절반이 그것이었다).
    //  대신 그 페이지의 크럼이 '맥락 관리 › 증류'라는 위치 정보를 대신 진다.
    if (isDistillerDetailPath(sub, sub2)) {
        await distillerPage(view, String(sub2));
        return;
    }
    const stage = STAGES.find((s) => s.key === sub) ?? STAGES[0];
    // adminOnly 화면(#1618)은 비-admin 에게 **주소로도** 열리지 않는다 — 내비에서 숨기기만 하면 옛 북마크·
    //  공유 링크로 들어와 403 카드만 보게 된다(구 [설정] 탭도 숨김+게이트 둘 다 했다). 그 단계의 첫 볼 수 있는
    //  화면으로 떨군다. 서버가 이미 막고 있으므로 이건 보안이 아니라 '막다른 화면을 안 보여주는' 처리다.
    const canSee = (i) => !i.adminOnly || hasScope('admin');
    const visible = stage.items.filter(canSee);
    const asked = stage.items.find((i) => i.key === sub2);
    const item = (asked && canSee(asked) ? asked : null) ?? visible[0] ?? stage.items[0];
    const host = el('div', {}, skeleton('불러오는 중'));
    // 개요는 탭 이름이 곧 제목이고 한 줄 설명은 빵부스러기 옆에 있다 — 본문 머리를 또 세우면 같은 말이 세 번(탭·머리·요약) 난다.
    const body = el('div', { class: 'ctx-body' }, item.head && !stage.solo ? sectionHead(item.head.title, item.head.hint || null) : null, host);
    // #1841 — 좌측 단계 사이드바(#1584)를 걷고, **프로젝트 탭과 같은 머리 3층**으로 올린다:
    //  ① 빵부스러기(앱 이름) ② 뷰 탭 = 단계 줄(개요 · ①수집 › ②증류 › ③분류 › ④관리 › ⑤전달 — 탭 사이 화살이 흐름을,
    //     탭 안 점이 그 단계의 건강을 말한다 = 개요 다이어그램의 축약판) ③ 툴바 = 그 단계의 화면 알약(수집기 · 수집 방식 · …).
    //  원준 지적(2026-08-24): "좌측 사이드바가 여기만 또 있어 어색하다 — 세로 단계를 상단 가로 줄로 보내고 탭처럼 고르게".
    //  #1584 가 좌측으로 간 이유('2층 아래 화면이 시작해 본문이 밀린다·2층이 숨어 있다')는 머리 3층이 프로젝트·WIKI·AI 세션과
    //  같은 높이로 고정되면서 사라진다 — 모든 앱이 같은 자리에 같은 두께의 머리를 가지면 그건 밀림이 아니라 규칙이다.
    view.replaceChildren(el('div', { class: 'pjv-board-wrap ctx-board-wrap' }, el('div', { class: 'card pjv-listboard ctx-board' }, buildHeader(stage, item), body)));
    void paintStageHealth(view);
    // 화면 본문. 실패는 자기 자리에서 처리한다(내비까지 죽이지 않는다 — 다른 화면으로는 갈 수 있어야 한다).
    try {
        await item.draw(host);
    }
    catch (e) {
        host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message })));
    }
}
/**
 * 머리 3층(#1841) — 프로젝트 탭 .pjv-board-header 동형.
 *  단계 줄은 **탭이면서 다이어그램**이다: 번호 원 · 이름 · 건강 점(수집·증류·분류·관리)이 한 탭이고, 탭 사이 '›' 가 흐름이다.
 *  개요는 단계가 아니라 전체 조망이라 맨 앞에 떨어져 선다(흐름 화살 없이). 관리자 편집 단계는 자물쇠 배지.
 */
function buildHeader(selStage, selItem) {
    const crumbBar = el('div', { class: 'pjv-crumbbar' }, el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' }, el('span', { class: 'pjv-crumb is-leaf ctx-crumb-leaf' }, ctxAppIcon(), el('span', { class: 'pjv-crumb-label', text: '맥락 관리' })), el('span', { class: 'ctx-crumb-sub', text: '자료가 지식이 되어 AI 에 닿는 길 — 수집 › 증류 › 분류 › 관리 › 전달' })));
    const tabs = el('div', { class: 'pjv-vtabs ctx-vtabs', role: 'tablist', 'aria-label': '파이프라인 단계' });
    for (const s of STAGES) {
        const on = s.key === selStage.key;
        const first = s.items.filter((i) => !i.adminOnly || hasScope('admin'))[0] || s.items[0];
        if (s.step && s.step > 1)
            tabs.append(el('span', { class: 'ctx-vtab-flow', 'aria-hidden': 'true', text: '›' }));
        const tab = el('a', {
            class: 'pjv-vtab ctx-vtab' + (on ? ' active' : '') + (s.solo ? ' ctx-vtab-ov' : ''),
            href: s.solo ? '#/context/' + s.key : '#/context/' + s.key + '/' + first.key,
            role: 'tab', 'aria-selected': String(on), 'data-stage': s.key,
            title: s.adminEdit ? s.label + ' — 보는 것은 모든 구성원, 만들고 고치는 것은 관리자' : s.label,
        }, s.step ? el('span', { class: 'ctx-vtab-step', 'aria-hidden': 'true', text: String(s.step) }) : ctxFlowIcon(), el('span', { class: 'ctx-vtab-label', text: s.label }), s.step && s.step <= 4 ? el('span', { class: 'ctx-vtab-dot', 'aria-hidden': 'true' }) : null, s.adminEdit ? el('span', { class: 'ctx-vtab-lock', 'aria-hidden': 'true', title: '관리자만 고칠 수 있습니다' }, ctxLockIcon()) : null);
        tabs.append(tab);
        if (s.solo)
            tabs.append(el('span', { class: 'pjv-vtab-sep', 'aria-hidden': 'true' })); // 개요 | ①›②›③›④›⑤ — 조망과 흐름을 한 칸 띄운다
    }
    // 툴바 좌측 — 이 단계의 화면들(알약). 개요는 화면이 하나뿐이라 알약을 세우지 않는다.
    const left = el('div', { class: 'pjv-tasks-head-left' });
    if (!selStage.solo) {
        for (const it of selStage.items) {
            if (it.adminOnly && !hasScope('admin'))
                continue; // #1618 — 눌러도 403 인 자리는 아예 안 그린다
            const on = it.key === selItem.key;
            left.append(el('a', { class: 'pjv-tb-btn pjv-tb-pill ctx-pill' + (on ? ' active' : ''), href: '#/context/' + selStage.key + '/' + it.key, 'aria-current': on ? 'page' : null }, el('span', { class: 'pjv-view-btn-label', text: it.label })));
        }
    }
    const right = el('div', { class: 'card-head-actions' });
    // 개요는 화면 알약도 우측 동작도 없으니 툴바 층을 아예 세우지 않는다(주기 설정 → 은 본문 '자동 실행' 줄에 이미 있다).
    const toolbar = selStage.solo ? null : el('div', { class: 'card-head pjv-board-toolbar' }, left, right);
    return el('div', { class: 'pjv-board-header ctx-board-header' }, crumbBar, tabs, toolbar);
}
/** 단계 탭의 건강 점 — 개요 카드와 같은 판정(stageHealthLevels)으로 칠한다. 머리는 먼저 뜨고 점은 뒤따라 들어온다. */
async function paintStageHealth(view) {
    let d;
    try {
        d = await api('/api/ui/org/pipeline');
    }
    catch {
        return;
    }
    const lv = stageHealthLevels(d);
    const map = { collect: lv.collect, distill: lv.distill, classify: lv.classify, manage: lv.manage };
    for (const [key, level] of Object.entries(map)) {
        const dotEl = view.querySelector('.ctx-vtab[data-stage="' + key + '"] .ctx-vtab-dot');
        if (!dotEl || !dotEl.isConnected)
            continue;
        dotEl.classList.add('is-' + level);
        dotEl.title = level === 'ok' ? '정상' : level === 'note' ? '참고' : level === 'warn' ? '확인 필요' : '멈춤';
    }
}
function ctxAppIcon() {
    const n = sv('svg', { class: 'pjv-crumb-ic ctx-crumb-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 5h16l-6.2 7.2V18l-3.6 2v-7.8z' })); // 깔때기 — 런치패드 유리 아이콘과 같은 형태(맥락 관리 = 수집·증류·분류)
    return n;
}
function ctxFlowIcon() {
    const n = sv('svg', { class: 'ctx-vtab-ov-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M6.4 12h3.2M14.4 12h3.2', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', opacity: '0.6' }), sv('circle', { cx: '4', cy: '12', r: '2.6', fill: 'currentColor' }), sv('circle', { cx: '12', cy: '12', r: '2.6', fill: 'currentColor', opacity: '0.85' }), sv('circle', { cx: '20', cy: '12', r: '2.6', fill: 'currentColor', opacity: '0.7' }));
    return n;
}
function ctxLockIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }), sv('path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }));
    return n;
}
export { renderContext as default };
