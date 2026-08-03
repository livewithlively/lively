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
import { distillersPanel } from './distillers.js';
import { loadAdmin } from './admin-rerender.js';
/** 서브탭 정의 — key 가 곧 URL(#/context/<key>). */
const TABS = [
    { key: 'overview', label: '개요', hint: '수집부터 관리까지 흐름 전체를 한눈에 보고, 막힌 곳을 찾습니다.' },
    // adminEdit — '보는 건 누구나, 고치는 건 관리자'인 단계. 네 단계 중 수집만 그렇다(외부 서비스 토큰을 다룬다).
    //  이걸 **탭에서** 알리는 이유: 들어가서 버튼이 없는 걸 보고 유추하게 두면 "나만 안 보이나"가 되고,
    //  관리자는 자기 화면과 남의 화면이 다르다는 사실 자체를 모른다. 배지는 권한과 무관하게 늘 붙인다.
    { key: 'collect', label: '수집', adminEdit: true, hint: '외부 도구의 내용을 가져오는 수집기를 만들고 관리합니다. 만들고 고치는 일은 관리자 전용이며, 무엇이 언제 수집되는지는 모두가 봅니다.' },
    { key: 'distill', label: '증류', hint: '모인 원본에서 무엇을 어떤 형식의 지식으로 만들지 정합니다.' },
    { key: 'classify', label: '분류', hint: '지식이 어느 갈래에 속하는지 정하는 규칙과 분류축을 관리합니다.' },
    { key: 'manage', label: '관리', hint: '쌓인 지식이 낡거나 어긋나지 않게 살피고, 찾아낸 것을 처리합니다.' },
];
/** 분류·관리 화면 안의 2단 탭 — 모듈 전역에 둬 탭을 오가도 선택이 보존된다. */
const inner = { classify: 'classifiers', manage: 'findings' };
export async function renderContext(view, sub) {
    const sel = TABS.some((t) => t.key === sub) ? String(sub) : 'overview';
    const tab = TABS.find((t) => t.key === sel);
    const head = pageHead('맥락 관리', tab.hint, [], '맥락 관리');
    // 상단 단계 내비 — 파이프라인 순서 그대로(개요 · 수집 → 증류 → 분류 → 관리).
    //  순서 자체가 정보다: 이 탭에서 처음 보는 사람도 흐름을 읽는다.
    const nav = el('nav', { class: 'ctx-nav', 'aria-label': '파이프라인 단계' });
    for (const t of TABS) {
        nav.append(el('a', {
            class: 'ctx-nav-item' + (t.key === sel ? ' active' : ''),
            href: '#/context/' + t.key,
            'aria-current': t.key === sel ? 'page' : null,
        }, el('span', { text: t.label }), 
        // 배지 문구는 '관리자' 하나로 통일한다(#1085) — admin·memory 같은 내부 scope 이름은 보는 사람에게
        //  아무 뜻이 아니고, 실제로 그 자리를 고칠 수 있는 사람은 관리 권한을 받은 사람이다.
        t.adminEdit
            ? el('span', { class: 'admin-only-badge', text: '관리자',
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
    if (sel === 'collect') {
        await renderCollectors(host);
        return;
    }
    if (sel === 'distill') {
        // 증류기 화면은 관리탭 패널을 그대로 재사용한다 — 같은 데이터에 두 화면을 만들지 않는다.
        //  그 패널은 admin 데이터(meaning 등)를 인자로 받으므로 여기서 채워 준다(없으면 빈 객체로 동작).
        let data = {};
        try {
            data = await loadAdmin();
        }
        catch { /* 권한 없거나 실패 — 패널은 자기 API 로 그린다 */ }
        host.replaceChildren();
        await distillersPanel(host, data);
        return;
    }
    if (sel === 'classify') {
        await renderClassifyStage(host);
        return;
    }
    await renderManageStage(host);
}
/** 분류 단계 — '분류기'(규칙)와 '분류축'(갈래 정의) 2단 탭. */
async function renderClassifyStage(host) {
    const box = el('div', {});
    const body = el('div', {});
    box.append(segmented('classify', [
        { key: 'classifiers', label: '분류기' },
        { key: 'categories', label: '분류축' },
    ], body));
    box.append(body);
    host.replaceChildren(box);
    await drawClassifyInner(body);
}
async function drawClassifyInner(body) {
    body.replaceChildren(skeleton('불러오는 중'));
    if (inner.classify === 'categories')
        await renderCategoryList(body);
    else
        await renderClassifiers(body);
}
/** 관리 단계 — '발견'(일감)이 먼저, '관리기'(설정)가 뒤. */
async function renderManageStage(host) {
    const box = el('div', {});
    const body = el('div', {});
    box.append(segmented('manage', [
        { key: 'findings', label: '발견' },
        { key: 'managers', label: '관리기' },
    ], body));
    box.append(body);
    host.replaceChildren(box);
    await drawManageInner(body);
}
async function drawManageInner(body) {
    body.replaceChildren(skeleton('불러오는 중'));
    if (inner.manage === 'managers')
        await renderManagers(body);
    else
        await renderFindings(body);
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
            void (scope === 'classify' ? drawClassifyInner(body) : drawManageInner(body));
        });
        bar.append(b);
    }
    return bar;
}
export { renderContext as default };
