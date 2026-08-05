// context.ts — [맥락 관리] 탭 셸(#1419 T6). 구 [분류체계] 탭의 자리를 넓혀 파이프라인 전체를 담는다.
//
//  요구 원문: "지금의 분류체계탭을 맥락 관리로 바꾸고 … 맥락관리에는 수집기, 증류지, 분류기 및
//   수집-증류-분류 파이프라인을 다 관리할수있게. 비개발자도 쉽게관리할수있어야하고."
//
//  구조 결정:
//   · **개요(파이프라인)가 기본 화면**이다. 설정 목록이 아니라 '지금 어디가 막혔나'가 먼저 보여야
//     비개발자가 무엇을 할지 안다. 설정은 그 다음이다.
//   · 단계별 서브탭 4개(수집·증류·분류·관리) — 파이프라인 카드를 누르면 그 탭으로 간다.
//   · **분류축(카테고리 CRUD)은 '분류' 단계 안**에 있다. 그게 이 탭의 옛 정체성이었지만, 이제는
//     파이프라인의 한 부분이다 — 분류기가 쓰는 기준이 곧 분류축의 정의(should)이므로 같은 자리에 있어야 한다.
//   · 저장 경로(API)는 하나도 안 바꿨다 — **합치는 건 화면이지 데이터가 아니다**(#837 불변식).
//     증류기 화면은 관리탭의 distillersPanel 을 그대로 부른다(복제 0).
import { el, pageHead } from './core.js';
import { skeleton } from './ui-primitives.js';
import { renderPipeline } from './context-pipeline.js';
import { renderCollectors } from './context-collectors.js';
import { renderClassifiers } from './context-classify.js';
import { renderFindings, renderManagers } from './context-manage.js';
import { renderCategoryList } from './categories.js';
import { distillerPage, distillersPanel } from './distillers.js';
import { collectorPresetEditor } from './admin-collector-presets.js'; // 수집 방식(커스텀 프리셋) — 수집 단계 안으로(#1419)
import { sourceVisPolicyPanel } from './source-vis-policy.js'; // 자료 공개범위(#1291 v4) — 생산 지점이 수집이다
import { ingestPolicyPanel } from './review.js'; // 지식 검토 정책(#638) — 증류 산출물이 통과하는 밸브
import { loadAdmin } from './admin-rerender.js';
/** 서브탭 정의 — key 가 곧 URL(#/context/<key>). */
const TABS = [
    { key: 'overview', label: '개요', hint: '수집부터 관리까지 흐름 전체를 한눈에 보고, 막힌 곳을 찾습니다.' },
    // adminEdit — '보는 건 누구나, 고치는 건 관리자'인 단계. 네 단계 중 수집만 그렇다(외부 서비스 토큰을 다룬다).
    //  이걸 **탭에서** 알리는 이유: 들어가서 버튼이 없는 걸 보고 유추하게 두면 "나만 안 보이나"가 되고,
    //  관리자는 자기 화면과 남의 화면이 다르다는 사실 자체를 모른다. 배지는 권한과 무관하게 늘 붙인다.
    { key: 'collect', label: '수집', adminEdit: true, hint: '외부 도구의 내용을 가져오는 수집기, 그 수집 방식, 그리고 들어온 자료를 누가 볼지 정합니다. 만들고 고치는 일은 관리자 전용이며, 무엇이 언제 수집되는지는 모두가 봅니다.' },
    { key: 'distill', label: '증류', hint: '모인 원본에서 무엇을 어떤 형식의 지식으로 만들지, 그리고 만들어진 지식을 사람이 검토할지 정합니다.' },
    { key: 'classify', label: '분류', hint: '지식이 어느 갈래에 속하는지 정하는 규칙과 분류축을 관리합니다.' },
    { key: 'manage', label: '관리', hint: '쌓인 지식이 낡거나 어긋나지 않게 살피고, 찾아낸 것을 처리합니다.' },
];
/** 단계별 하위 탭 선택 — 모듈 전역에 둬 탭을 오가도 선택이 보존된다. 값은 STAGE_TABS 의 첫 항목 기준. */
const inner = { collect: 'collectors', distill: 'distillers', classify: 'classifiers', manage: 'findings' };
export async function renderContext(view, sub, sub2) {
    // 증류기 설정(#/context/distill/<key>)은 **이 셸 밖**의 전용 페이지다(#1564) — 3단 전폭을 쓰려면
    //  위쪽 파이프라인 네비 + 단계 탭이 자리를 비켜야 한다(종전 세로 1840px = 2화면의 절반이 그것이었다).
    //  대신 그 페이지의 크럼이 '맥락 관리 › 증류'라는 위치 정보를 대신 진다.
    if (sub === 'distill' && sub2) {
        await distillerPage(view, sub2);
        return;
    }
    const sel = TABS.some((t) => t.key === sub) ? String(sub) : 'overview';
    const tab = TABS.find((t) => t.key === sel);
    const head = pageHead('맥락 관리', tab.hint, [], '맥락 관리');
    // 상단 단계 내비 — 파이프라인 순서 그대로(개요 · 수집 → 증류 → 분류 → 관리).
    //  순서 자체가 정보다: 이 탭에서 처음 보는 사람도 흐름을 읽는다.
    const nav = el('nav', { class: 'ctx-nav', 'aria-label': '파이프라인 단계' });
    for (const t of TABS) {
        const adminEdit = !!t.adminEdit;
        nav.append(el('a', {
            class: 'ctx-nav-item' + (t.key === sel ? ' active' : ''),
            href: '#/context/' + t.key,
            'aria-current': t.key === sel ? 'page' : null,
            // ⚠ 배지를 붙이면 링크의 접근가능 이름이 자식 텍스트 연결로 '수집관리자'가 된다 — 한 낱말로 읽혀
            //  뜻이 사라진다(실측: linkText === '수집관리자'). aria-label 로 이름을 직접 정해 끊어 읽히게 한다.
            //  span 에 aria-label 을 걸어도 안 된다 — role 없는 generic 은 그 값이 노출되지 않는다.
            'aria-label': adminEdit ? `${t.label} — 관리자 전용 단계` : null,
        }, el('span', { text: t.label }), 
        // 배지 문구는 '관리자' 하나로 통일한다(#1085) — admin·memory 같은 내부 scope 이름은 보는 사람에게
        //  아무 뜻이 아니고, 실제로 그 자리를 고칠 수 있는 사람은 관리 권한을 받은 사람이다.
        adminEdit
            ? el('span', { class: 'admin-only-badge', text: '관리자', 'aria-hidden': 'true',
                title: '보는 것은 모든 구성원이 할 수 있고, 만들고 고치는 것은 관리자만 할 수 있는 단계입니다.' })
            : null));
        if (t.key === 'overview')
            nav.append(el('span', { class: 'ctx-nav-sep', 'aria-hidden': 'true' }));
    }
    const host = el('div', { class: 'ctx-body' }, skeleton('불러오는 중'));
    view.replaceChildren(el('div', { class: 'ctx-layout' }, head, nav, host));
    // 단계별 본문. 실패는 각 렌더러가 자기 자리에서 처리한다(화면 전체를 죽이지 않는다).
    if (sel === 'overview') {
        await renderPipeline(host);
        return;
    }
    await renderStage(sel, host);
}
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
 * 단계 하위 탭 표 — **한 단계 안에 그 단계에 속한 설정을 전부** 모은다.
 *
 * ⚠ 왜 설정탭에서 여기로 옮겼나(어니스트 실박스 지적): 파이프라인 단계에 속한 설정이 [설정] 탭에도
 *  남아 있으면 입구가 둘이 되고, 무엇보다 **그 단계를 보면서 앞뒤를 못 본다**. 수집기를 고치다
 *  '수집 방식'을 정의하려고 다른 탭으로 나가야 했고, 자료 공개범위는 수집 지점(mirror INSERT)에
 *  걸리는데 [설정 ▸ AI 맥락]에 있었다. 지식 검토 정책도 증류 산출물이 통과하는 밸브다.
 *  옛 URL 은 admin-shell 의 SECTION_EXIT 가 여기로 넘긴다(북마크 보존).
 */
const STAGE_TABS = {
    collect: [
        { key: 'collectors', label: '수집기', draw: (b) => renderCollectors(b) },
        // 수집 '방식'(프리셋) — 수집기와 다른 객체다(틀 vs 인스턴스). 드물게 정의하지만 수집기 화면이
        //  가리키는 자리라, 나가지 않고 이 안에서 정의할 수 있어야 한다.
        { key: 'presets', label: '수집 방식', draw: (b) => collectorPresetEditor(b) },
        // 자료 공개범위 — match_system(+채널)으로 매칭해 **자료가 태어날 때** 공개범위를 새긴다(#1291 v4).
        //  생산 지점이 곧 수집이라 여기 있는 게 맞다.
        { key: 'source-vis', label: '자료 공개범위', draw: async (b) => { await sourceVisPolicyPanel(b); } },
    ],
    distill: [
        { key: 'distillers', label: '증류기', draw: async (b) => { await distillersPanel(b, await adminData()); } },
        // 지식 검토 정책 — 증류가 만든 지식이 통과하는 밸브(#638). 생산 라인 바로 뒤가 제자리다.
        { key: 'ingest-policy', label: '지식 검토 정책', draw: async (b) => { await ingestPolicyPanel(b, await adminData()); } },
    ],
    classify: [
        { key: 'classifiers', label: '분류기', draw: (b) => renderClassifiers(b) },
        { key: 'categories', label: '분류축', draw: (b) => renderCategoryList(b) },
    ],
    manage: [
        { key: 'findings', label: '발견', draw: (b) => renderFindings(b) },
        { key: 'managers', label: '관리기', draw: (b) => renderManagers(b) },
    ],
};
async function renderStage(stage, host) {
    const tabs = STAGE_TABS[stage] ?? [];
    const body = el('div', {});
    // 하위 탭이 하나뿐인 단계는 바를 그리지 않는다 — 고를 것이 없는 탭 바는 소음이다.
    const box = tabs.length > 1 ? el('div', {}, segmented(stage, tabs, body), body) : el('div', {}, body);
    host.replaceChildren(box);
    await drawInner(stage, body);
}
async function drawInner(stage, body) {
    const tabs = STAGE_TABS[stage] ?? [];
    const pick = tabs.find((t) => t.key === inner[stage]) ?? tabs[0];
    if (!pick)
        return;
    body.replaceChildren(skeleton('불러오는 중'));
    try {
        await pick.draw(body);
    }
    catch (e) {
        body.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message })));
    }
}
/** 2단 탭(세그먼티드) — 관리탭 segTabs 와 같은 시각 언어. 라우터를 안 타므로 인메모리 상태로. */
function segmented(scope, items, body) {
    const bar = el('div', { class: 'ctx-seg', role: 'tablist' });
    for (const it of items) {
        const b = el('button', {
            class: 'ctx-seg-item' + (inner[scope] === it.key ? ' active' : ''),
            type: 'button', role: 'tab', 'aria-selected': inner[scope] === it.key ? 'true' : 'false', text: it.label,
        });
        b.addEventListener('click', () => {
            if (inner[scope] === it.key)
                return;
            inner[scope] = it.key;
            for (const other of bar.querySelectorAll('.ctx-seg-item')) {
                const on = other.textContent === it.label;
                other.classList.toggle('active', on);
                other.setAttribute('aria-selected', on ? 'true' : 'false');
            }
            void drawInner(scope, body);
        });
        bar.append(b);
    }
    return bar;
}
export { renderContext as default };
