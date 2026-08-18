// admin-ui-mode.ts — 관리탭 ▸ [화면](#1719): 기본 화면 셸(새 화면 v2 / 클래식) 선택 + 이 브라우저에서만 바꿔 보기.
//  값의 집: org_runtime_config.ui_mode(조직 기본, 관리자만 저장) · localStorage[lively_ui_mode](이 브라우저, 누구나).
//  둘의 관계는 web/lib/state.ts uiMode() 한 곳이 해석한다(URL ?ui > 로컬 > 조직 > 'v2').
//  소비: admin-shell.ts registerPanel('ui'). 다른 어디서도 부르지 않는다.
import { api, cardHead, el, setUiModeOverride, state, toast, uiModeOverride, uiText } from './core.js';
import { sectionHead } from './admin-widgets.js';
const LABEL = { v2: '새 화면 — 사이드바 · 리브 대화 · 앱(런치패드)', classic: '클래식 — 상단 탭(홈 · AI 세션 · 프로젝트 · WIKI · 맥락 관리 · 설정)' };
export function uiModeSection(detail, data) {
    const rc = data && data.runtimeConfig; // admin 만 non-null
    const canEdit = !!(data && data.canEdit) && !!rc;
    const body = el('div');
    detail.replaceChildren(sectionHead('화면', '라이블리를 어떤 화면으로 볼지 정합니다. 새 화면과 클래식은 같은 데이터·같은 주소를 쓰고, 클래식의 모든 페이지는 새 화면 안에서 [앱]으로 그대로 열립니다.'), el('div', { class: 'card' }, cardHead('조직 기본 화면'), body), el('div', { class: 'card' }, cardHead('이 브라우저에서만'), mineBox()));
    build();
    function build() {
        body.replaceChildren();
        const orgMode = (rc && rc.ui_mode === 'classic') ? 'classic' : (rc ? 'v2' : (state.me && state.me.ui_mode === 'classic' ? 'classic' : 'v2'));
        if (!rc) {
            body.append(el('p', { class: 'admin-hint' }, ...uiText(`지금 조직 기본은 **${orgMode === 'v2' ? '새 화면' : '클래식'}** 입니다. 바꾸는 것은 관리자(admin)만 할 수 있어요 — 아래 '이 브라우저에서만'은 누구나 됩니다.`)));
            return;
        }
        const sel = el('select', { class: 'input' }, ...['v2', 'classic'].map((v) => el('option', { value: v, text: LABEL[v] })));
        sel.value = orgMode;
        sel.disabled = !canEdit;
        const save = el('button', { class: 'btn btn-primary', text: '저장', disabled: !canEdit });
        save.addEventListener('click', async () => {
            save.disabled = true;
            try {
                const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ ui_mode: sel.value }) });
                if (r && r.runtimeConfig)
                    data.runtimeConfig = r.runtimeConfig;
                if (state.me)
                    state.me.ui_mode = sel.value;
                toast('기본 화면을 저장했어요 — 구성원은 다음 새로고침부터 이 화면으로 봅니다.');
                build();
            }
            catch (e) {
                toast(e.message, true);
                save.disabled = !canEdit;
            }
        });
        body.append(el('div', { class: 'admin-field' }, el('label', { class: 'admin-field-label', text: '모든 구성원의 기본 화면' }), sel, el('p', { class: 'admin-hint' }, ...uiText('새로 설치한 라이블리와 매니지드(app.lvly.io)는 **새 화면**이 기본입니다. 이미 클래식으로 쓰던 조직은 여기서 클래식으로 두면 종전과 같습니다. 사람마다는 아래에서 따로 고를 수 있어요.'))), canEdit ? el('div', { class: 'admin-actions' }, save) : el('p', { class: 'admin-hint' }, ...uiText('읽기 전용 — 변경은 관리자(admin) 권한이 필요합니다.')));
    }
    function mineBox() {
        const box = el('div');
        const draw = () => {
            const o = uiModeOverride();
            box.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText(o ? `이 브라우저는 조직 기본과 상관없이 **${o === 'v2' ? '새 화면' : '클래식'}** 으로 봅니다.` : '이 브라우저는 조직 기본 화면을 따릅니다.')), el('div', { class: 'admin-actions' }, el('button', { class: 'btn btn-sm', text: '새 화면으로 보기', onclick: () => { setUiModeOverride('v2'); location.hash = '#/'; location.reload(); } }), el('button', { class: 'btn btn-sm', text: '클래식으로 보기', onclick: () => { setUiModeOverride('classic'); location.hash = '#/dashboard'; location.reload(); } }), o ? el('button', { class: 'btn btn-sm btn-ghost', text: '조직 기본 따르기', onclick: () => { setUiModeOverride(null); location.reload(); } }) : null));
        };
        draw();
        return box;
    }
}
