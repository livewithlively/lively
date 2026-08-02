// admin-audit-common.ts — #1405 W3: admin-audit.ts 분할 ①.
//  감사 패널 3종(툴 사용량·조직 감사·DB 감사)이 공유하는 부품 — 페이지 크기·기간 필터·CSV 내보내기·페이저.
//  순수 잎: 세 패널이 전부 이쪽만 본다(반대 방향 없음).
import { appUrl, api, el, toast, TOKEN_KEY } from './core.js';
// 한 페이지에 몇 줄을 볼지 — 기본 10줄(첫 화면이 스크롤 없이 들어오는 크기). 서버 상한이 500 이라
//  '전체'는 500줄이 사실상의 최대다(그 이상은 페이지를 넘겨야 한다 — 있는 그대로 라벨에 쓴다).
const AUD_PAGE_SIZES = [[10, '10줄'], [25, '25줄'], [50, '50줄'], [100, '100줄'], [500, '500줄']];
const AUD_PAGE_SIZE_DEFAULT = 10;
// 개인 설정이라 서버에 안 남긴다 — 이 브라우저에만 기억한다.
function audPageSize(key) {
    try {
        const v = Number(localStorage.getItem('lively_audit_rows_' + key));
        if (AUD_PAGE_SIZES.some(([n]) => n === v))
            return v;
    }
    catch { /* localStorage 불가 환경 — 기본값 */ }
    return AUD_PAGE_SIZE_DEFAULT;
}
function audSetPageSize(key, n) {
    try {
        localStorage.setItem('lively_audit_rows_' + key, String(n));
    }
    catch { /* 무시 */ }
}
function audField(labelText, control) {
    return el('div', { class: 'aud-f' }, el('label', { text: labelText }), control);
}
// opts = [[value, label], …]. 값이 목록에 없으면(서버가 안 준 필터값) 그대로 한 항목 추가해 선택을 잃지 않는다.
function audSelect(opts, value, onchange) {
    const sel = el('select', { class: 'aud-sel' });
    for (const [v, label] of opts)
        sel.append(el('option', { value: v, text: label }));
    if (value && !opts.some(([v]) => v === value))
        sel.append(el('option', { value, text: value }));
    sel.value = value || '';
    sel.onchange = () => onchange(sel.value);
    return sel;
}
function audPageSizeField(key, onchange) {
    return audField('표시 줄 수', audSelect(AUD_PAGE_SIZES.map(([n, label]) => [String(n), label]), String(audPageSize(key)), (v) => { audSetPageSize(key, Number(v)); onchange(Number(v)); }));
}
// ── 기간 필터 — 상대 기간 + 「직접 지정」(특정 날짜·날짜 범위) (#1309) ────────────────
//  종전엔 세 탭 모두 상대 기간 드롭다운(최근 24시간·7일·30일…)뿐이라 "6월 3일 하루"나 "6/1~6/15" 를 볼 수
//  없었다. 드롭다운 맨 끝에 「직접 지정」을 두고, 고르면 시작·종료 날짜칸이 같은 줄에 붙는다.
//   · 시작만 = 그날부터 지금까지 · 종료만 = 처음부터 그날까지 · 둘 다 = 그 범위 · 같은 날 = 그 하루
//  날짜는 **보는 사람의 시간대**로 해석한다(화면 시각 표기와 같은 기준) — 그 날의 자정~23:59:59.999 를 ISO 로 보낸다.
const AUD_CUSTOM = 'custom';
function audToday() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function audDayStart(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).toISOString() : null;
}
function audDayEnd(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).toISOString() : null;
}
// 상대 기간(일) → ISO 하한. 0 = 하한 없음(전체 기간).
function audSinceDays(days) {
    return days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null;
}
// 기간 상태 → 서버에 실을 since/until. 상대 기간은 여기서 절대시각으로 굳힌다(서버는 절대범위만 안다).
function audPeriodQs(st, key, relDays) {
    if (st[key] === AUD_CUSTOM)
        return { since: audDayStart(st.from), until: audDayEnd(st.to) };
    return { since: audSinceDays(relDays[st[key]] || 0), until: null };
}
// 필터바용 기간 컨트롤. opts=[[value,label],…](상대 기간). 상태는 st[key] + st.from/st.to 에 적는다.
function audPeriodField(opts, st, key, onchange) {
    const sel = audSelect([...opts, [AUD_CUSTOM, '직접 지정']], st[key] || opts[0][0], (v) => {
        st[key] = v;
        // 「직접 지정」을 처음 고르면 오늘 하루로 채워 둔다 — 빈 칸 두 개보다 바로 쓸 수 있다.
        if (v === AUD_CUSTOM && !st.from && !st.to) {
            const t = audToday();
            st.from = t;
            st.to = t;
        }
        onchange();
    });
    if (st[key] !== AUD_CUSTOM)
        return audField('기간', sel);
    const today = audToday();
    const fromIn = el('input', { class: 'aud-inp aud-date', type: 'date', value: st.from || '', max: today });
    const toIn = el('input', { class: 'aud-inp aud-date', type: 'date', value: st.to || '', max: today });
    const apply = () => { st.from = fromIn.value; st.to = toIn.value; onchange(); };
    // 시작일만 고르면 그 하루로 맞춰 준다(가장 흔한 쓰임) — 종료일을 뒤로 늘리면 그때 범위가 된다.
    fromIn.onchange = () => { if (!toIn.value)
        toIn.value = fromIn.value; apply(); };
    toIn.onchange = apply;
    return el('div', { class: 'aud-f' }, el('label', { text: '기간' }), el('div', { class: 'aud-daterange' }, sel, fromIn, el('span', { class: 'aud-dash', text: '~' }), toIn));
}
// ── CSV 내보내기(#1309) — 행수 상한 없음. 엑셀 한 시트에 안 들어가면 파일을 나눠 전부 받는다 ──────
//  종전(구 [AI 도구 호출] 전용 버튼)은 브라우저가 500행씩 페이지를 돌며 **5000행에서 끊었다**. 서버가 한 번의
//  응답으로 흘려보내는 방식(/api/ui/audit-export.csv)으로 바꿔 상한을 없앴다 — 사연은 src/audit-export-routes.ts.
async function audExportCsv(kind, filters) {
    const q = new URLSearchParams(filters);
    q.set('kind', kind);
    toast('CSV 준비 중…');
    let plan;
    try {
        plan = await api('/api/ui/audit-export/plan?' + q.toString());
    }
    catch (e) {
        toast('CSV 준비 실패 — ' + e.message, true);
        return;
    }
    const total = plan.total || 0;
    if (!total) {
        toast('이 조건으로 내려받을 기록이 없습니다');
        return;
    }
    const parts = plan.parts || 1;
    const base = String(plan.filename || 'audit-export.csv').replace(/\.csv$/, '');
    if (parts > 1 && !confirm(total.toLocaleString() + '행입니다 — 엑셀 한 시트에 담기지 않아 파일 ' + parts + '개로 나눠 받습니다.\n'
        + '브라우저가 「여러 파일 다운로드」를 물으면 허용해 주세요. 계속할까요?'))
        return;
    if (plan.snapshot_id)
        q.set('snapshot_id', String(plan.snapshot_id));
    for (let p = 1; p <= parts; p++) {
        const q2 = new URLSearchParams(q);
        q2.set('part', String(p));
        await audDownload('/api/ui/audit-export.csv?' + q2.toString(), base + (parts > 1 ? '-part' + p + 'of' + parts : '') + '.csv');
        if (p < parts)
            await new Promise((r) => setTimeout(r, 800)); // 연속 트리거를 브라우저가 묶어 취소하지 않게 간격
    }
    toast(total.toLocaleString() + '행 내려받는 중' + (parts > 1 ? ' · 파일 ' + parts + '개' : ''));
}
// 인증 다운로드. 세션 쿠키 로그인이면 <a href> 로 브라우저가 응답을 **디스크에 바로 흘려** 받는다(탭 메모리 0) —
//  큰 CSV 의 정답 경로다. 토큰 로그인은 Authorization 헤더가 필요해 <a href> 로 인증이 안 되므로 fetch→blob 폴백.
async function audDownload(url, filename) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
        const a = el('a', { href: appUrl(url), download: filename });
        document.body.append(a);
        a.click();
        a.remove();
        return;
    }
    let res;
    try {
        res = await fetch(appUrl(url), { headers: { Authorization: 'Bearer ' + token } });
    }
    catch (e) {
        toast('다운로드 실패 — ' + e.message, true);
        return;
    }
    if (!res.ok) {
        toast('다운로드 실패 (' + res.status + ')', true);
        return;
    }
    const a = el('a', { href: URL.createObjectURL(await res.blob()), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function audExportBtn(onclick) {
    return el('button', { class: 'btn btn-ghost btn-sm', text: 'CSV 다운로드', onclick });
}
// ‹ 1 … 4 5 6 … 20 › + 'n / m 페이지'. 페이지가 하나뿐이면 빈 상자를 돌려준다(자리만 차지하지 않게).
function audPager(page, totalPages, go) {
    const box = el('div', { class: 'aud-pager' });
    if (totalPages <= 1)
        return box;
    const cur = Math.min(Math.max(1, page), totalPages);
    const pgBtn = (label, n, kind) => el('button', {
        class: 'aud-pg' + (kind === 'on' ? ' aud-pg-on' : '') + (kind === 'off' ? ' aud-pg-off' : ''),
        text: String(label), ...(kind ? {} : { onclick: () => go(n) })
    });
    box.append(pgBtn('‹', cur - 1, cur <= 1 ? 'off' : undefined));
    for (const pn of tuPageNumbers(cur, totalPages)) {
        if (pn === '…')
            box.append(el('span', { class: 'aud-pg-gap', text: '…' }));
        else
            box.append(pgBtn(pn, pn, pn === cur ? 'on' : undefined));
    }
    box.append(pgBtn('›', cur + 1, cur >= totalPages ? 'off' : undefined));
    box.append(el('span', { class: 'aud-pg-info', text: cur + ' / ' + totalPages + ' 페이지' }));
    return box;
}
// 번호 페이지네이션용 페이지 목록(생략 …). 적으면 전부, 많으면 1 … cur-1 cur cur+1 … total.
function tuPageNumbers(cur, total) {
    if (total <= 7) {
        const a = [];
        for (let i = 1; i <= total; i++)
            a.push(i);
        return a;
    }
    const out = [1];
    const lo = Math.max(2, cur - 1);
    const hi = Math.min(total - 1, cur + 1);
    if (lo > 2)
        out.push('…');
    for (let i = lo; i <= hi; i++)
        out.push(i);
    if (hi < total - 1)
        out.push('…');
    out.push(total);
    return out;
}
export { AUD_CUSTOM, audDayEnd, audDayStart, audExportBtn, audExportCsv, audField, audPageSize, audPageSizeField, audPager, audPeriodField, audPeriodQs, audSelect, tuPageNumbers };
