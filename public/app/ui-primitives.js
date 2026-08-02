// ui-primitives.ts — 앱 전역 UI 프리미티브(#1313 R27). admin.ts(관리탭)·learn.ts(사용 가이드)에
//  홈스테드돼 있던 셸 조각들을 **verbatim 으로** 꺼내 한 곳에 모았다. 도메인 로직 0, 의존은 core.js 뿐.
//  왜: 이 조각들은 관리·가이드 화면의 것이 아니라 **앱 전역의 것**인데 두 페이지 파일이 소유하고 있어서
//   29개 파일이 페이지 모듈을 역방향으로 import 했고, admin↔learn 상호 import(순환)까지 만들었다.
//  계약: admin.ts·learn.ts 가 이 심볼들을 **그대로 재수출**한다 — 기존 호출부의 import 문은 무변경.
import { el, toast, uiText } from './core.js';
// ── 필드(라벨 + 컨트롤) ──
export function field(label, control) {
    return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}
// 필드 라벨 바로 옆에 '이게 뭐예요?' 트리거를 붙이는 변형(필드 단위 설명용).
export function fieldWithHelp(label, control, m) {
    return el('div', { class: 'field' }, el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label })), control);
}
// ── 클립보드 ──
// 클립보드 복사 — navigator.clipboard 는 보안 컨텍스트(https/localhost)에서만 동작한다.
// http://localhost:8080 같은 비보안 origin 에선 undefined 이므로, execCommand('copy') 텍스트영역 폴백을 쓴다.
export async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch { /* 폴백으로 */ }
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
    catch {
        return false;
    }
}
export function copyButton(getText, label) {
    const b = el('button', { class: 'btn btn-ghost btn-sm', text: label || '복사' });
    b.addEventListener('click', async () => {
        if (await copyText(getText()))
            toast('복사됨');
        else
            toast('복사 실패 — 명령을 직접 선택해 복사하세요', true);
    });
    return b;
}
// ── 모달 오버레이 ──
//  구 admin.overlay() 와 구 learn.overlayBox() 는 **닫기 버튼 class 하나만** 다른 같은 셸이었다
//  (마크업·ESC/배경클릭 닫기·document.body 부착·반환값 전부 동일). 그래서 셸을 하나로 합치고
//  두 이름을 얇은 래퍼로 남긴다 — 버튼 생김새 차이는 호출부에 보이는 사실이라 이름으로 보존한다.
function overlayShell(title, content, closeClass) {
    const close = el('button', { class: closeClass, text: '닫기' });
    const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), close), ...content);
    const back = el('div', { class: 'ov-back' }, box);
    close.addEventListener('click', () => back.remove());
    back.addEventListener('click', (e) => { if (e.target === back)
        back.remove(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
    } });
    document.body.append(back);
    return back;
}
// 닫기 = 버튼 스타일(관리·터미널·대시보드 계열 모달).
export function overlay(title, ...content) {
    return overlayShell(title, content, 'btn btn-ghost btn-sm');
}
// 닫기 = 텍스트 링크(가이드·지식·프로젝트 계열 모달).
export function overlayBox(title, ...content) {
    return overlayShell(title, content, 'btn-text');
}
// 라이블리 확인 다이얼로그 — 브라우저 confirm() 대체(#1062). 파괴적 동작(종료·삭제) 확인은 전부 이걸 쓴다.
//  왜: 브라우저 기본 confirm 은 디자인시스템 밖이고(OS 팝업), 줄바꿈·강조·위험도 표현이 안 되며,
//   포커스가 확인 버튼에 잡혀 엔터 연타로 실수하기 쉽다. 여기선 기본 포커스를 '취소'에 둔다.
//  반환: Promise<boolean> — 확인=true, 취소·Esc·바깥클릭=false. 호출부는 `if (!await confirmDialog(...)) return;`.
export function confirmDialog(opts) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done)
            return; done = true; back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const body = el('div', { class: 'ov-confirm-body' });
        if (opts.message)
            body.append(el('p', { class: 'ov-confirm-msg', text: opts.message }));
        for (const l of opts.lines || [])
            body.append(el('p', { class: 'ov-confirm-line', text: l }));
        if (opts.note)
            body.append(el('p', { class: 'ov-confirm-note' }, ...uiText(opts.note)));
        const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: opts.cancelText || '취소', onclick: () => finish(false) });
        const ok = el('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: opts.confirmText || '확인', onclick: () => finish(true) });
        const box = el('div', { class: 'ov-box ov-confirm' + (opts.danger ? ' danger' : '') }, el('div', { class: 'ov-head' }, el('h3', { text: opts.title })), body, el('div', { class: 'ov-confirm-acts' }, cancel, ok));
        const back = el('div', { class: 'ov-back ov-confirm-back' }, box);
        back.addEventListener('click', (e) => { if (e.target === back)
            finish(false); });
        const onKey = (ev) => {
            if (ev.key === 'Escape')
                finish(false);
            // 엔터는 '포커스된 버튼'을 누른다 — 기본 포커스가 취소라, 무심코 엔터를 쳐도 파괴적 동작이 안 일어난다.
            if (ev.key === 'Enter' && document.activeElement === ok)
                finish(true);
        };
        document.addEventListener('keydown', onKey);
        document.body.append(back);
        cancel.focus();
    });
}
// ── 로딩 스켈레톤 ──
export function skeleton(caption) {
    return el('div', {}, el('p', { class: 'loading-caption', text: caption + '…' }), el('div', { class: 'skel-stack' }, el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' })));
}
export function skeletonRows(n) {
    const box = el('div', {});
    for (let i = 0; i < n; i++)
        box.append(el('div', { class: 'row' }, el('div', { class: 'skel', style: 'min-height:18px;border:none;background:var(--bg-tint)' })));
    return box;
}
