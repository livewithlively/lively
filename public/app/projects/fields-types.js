// projects/fields-types.ts — #1405 W2: fields.ts 분할 ①.
//  커스텀 필드의 **타입 카탈로그와 값 표시** — 팔레트·통화·티셔츠 사이즈·타입 정의 + 읽기 전용 렌더.
//  순수 잎.
import { el } from '../core.js';
import { pjvFieldIcon } from './icons.js';
import { pjvFmtDate } from './status.js'; // #1313 R31 — 날짜 표기는 상태 시스템(status.js) 소유
// 옵션(드롭다운/라벨) 색 팔레트 — 차분한 톤(채도 절제). 추가 순서대로 라운드로빈.
const PJV_FIELD_PALETTE = ['#6b7cff', '#2bb3a3', '#e6913a', '#e0688e', '#9268d6', '#3f9ae0', '#56b877', '#dd6450', '#7f8aa3'];
// 통화 — 금액 필드. 기본 원화.
const PJV_CURRENCIES = {
    KRW: { symbol: '₩', label: '원 (₩)' }, USD: { symbol: '$', label: '달러 ($)' },
    EUR: { symbol: '€', label: '유로 (€)' }, JPY: { symbol: '¥', label: '엔 (¥)' },
};
// 필드 형식 정의 — key 는 백엔드 field_type 과 동일. w=컬럼 px 폭, config=설정 단계 종류(옵션/통화/별점/진행률).
const PJV_FIELD_TYPES = [
    { key: 'text', label: '텍스트', desc: '한 줄 텍스트', w: 150 },
    { key: 'textarea', label: '긴 텍스트', desc: '여러 줄 메모', w: 180 },
    { key: 'number', label: '숫자', desc: '정수·소수', w: 104 },
    { key: 'money', label: '금액', desc: '통화 단위 숫자', w: 120, config: 'money' },
    { key: 'date', label: '날짜', desc: '날짜 선택', w: 108 },
    { key: 'dropdown', label: '드롭다운', desc: '옵션 1개 선택', w: 130, config: 'options' },
    { key: 'labels', label: '라벨', desc: '옵션 여러 개 선택', w: 130, config: 'options' },
    { key: 'checkbox', label: '체크박스', desc: '예 / 아니오', w: 86 },
    { key: 'website', label: '웹사이트', desc: 'URL 링크', w: 156 },
    { key: 'email', label: '이메일', desc: '메일 주소', w: 168 },
    { key: 'phone', label: '전화', desc: '전화번호', w: 148 },
    { key: 'rating', label: '별점', desc: '별 점수', w: 128, config: 'rating' },
    { key: 'progress', label: '진행률', desc: '0–100% 막대', w: 136, config: 'progress' },
    { key: 'tshirt', label: '티셔츠 사이즈', desc: 'XS–XXL', w: 104 },
    { key: 'location', label: '위치', desc: '장소·주소', w: 156 },
    { key: 'files', label: '파일', desc: '공유 폴더에서 선택', w: 150 },
    { key: 'relationship', label: '관계', desc: '태스크 연결', w: 150 },
    { key: 'progress_auto', label: '진행률(자동)', desc: '하위 완료율 자동', w: 136 },
];
const PJV_FIELD_BY_KEY = Object.fromEntries(PJV_FIELD_TYPES.map((f) => [f.key, f]));
const PJV_TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
function pjvOptChip(o) {
    return el('span', { class: 'pjv-fopt', style: '--opt:' + (o.color || PJV_FIELD_PALETTE[0]) }, el('span', { class: 'pjv-fopt-dot' }), el('span', { class: 'pjv-fopt-label', text: o.label }));
}
function pjvHasFieldValue(v) {
    return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}
function pjvUrlText(v) { return String(v).replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
// 값 표시 노드(읽기) — 타입별. 셀 버튼 안에 들어간다.
function pjvFieldDisplay(field, value) {
    const type = field.field_type;
    const cfg = field.config || {};
    if (type === 'dropdown') {
        const o = (cfg.options || []).find((x) => x.id === value);
        return o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(value) });
    }
    if (type === 'labels') {
        const opts = cfg.options || [];
        const wrap = el('span', { class: 'pjv-flabels' });
        for (const id of (Array.isArray(value) ? value : [])) {
            const o = opts.find((x) => x.id === id);
            wrap.append(o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(id) }));
        }
        return wrap;
    }
    if (type === 'money') {
        const c = PJV_CURRENCIES[cfg.currency] || PJV_CURRENCIES.KRW;
        const n = Number(value);
        return el('span', { class: 'pjv-fval', text: c.symbol + (Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value)) });
    }
    if (type === 'number') {
        const n = Number(value);
        return el('span', { class: 'pjv-fval', text: Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value) });
    }
    if (type === 'date')
        return el('span', { class: 'pjv-fval', text: pjvFmtDate(value) });
    if (type === 'progress') {
        const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        return el('span', { class: 'pjv-fprog' }, el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })), el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
    }
    if (type === 'files') {
        const arr = Array.isArray(value) ? value : [];
        return el('span', { class: 'pjv-ffiles' }, pjvFieldIcon('files', 'pjv-fmini'), el('span', { class: 'pjv-fval', text: arr.length === 1 ? arr[0].name : arr.length + '개' }));
    }
    if (type === 'relationship') {
        const arr = Array.isArray(value) ? value : [];
        const w = el('span', { class: 'pjv-frel' });
        for (const r of arr.slice(0, 2))
            w.append(el('span', { class: 'pjv-rel-chip', text: r.name || ('#' + r.id), title: r.name }));
        if (arr.length > 2)
            w.append(el('span', { class: 'pjv-rel-more', text: '+' + (arr.length - 2) }));
        return w;
    }
    if (type === 'tshirt')
        return el('span', { class: 'pjv-fsize', text: String(value) });
    if (type === 'website')
        return el('span', { class: 'pjv-fval pjv-flink', text: pjvUrlText(value) });
    return el('span', { class: 'pjv-fval', text: String(value) }); // text/textarea/email/phone/location
}
export { PJV_CURRENCIES, PJV_FIELD_BY_KEY, PJV_FIELD_PALETTE, PJV_FIELD_TYPES, PJV_TSHIRT_SIZES, pjvFieldDisplay, pjvHasFieldValue, pjvOptChip };
