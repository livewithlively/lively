// distillers.ts — 자료 증류기(#1289). [맥락 관리 ▸ 증류 ▸ 증류기].
//
//  왜 이 화면이 있나(실측 ernest-slack-distill-zero-measurement-1289): 고객사 A 슬랙 10,900건 중 증류 13건(0.12%).
//  수집은 도는데 증류가 안 돌았고, 크론을 켜도 인박스가 전역 하나뿐이라 팀별로 다른 대상 채널·지식화 기준·
//  결과 형식을 표현할 데가 없었다. 그래서 '증류기'를 n개 세우고 각각을 여기서 설정한다.
//
//  화면은 둘로 나뉜다(#1564 — 종전엔 목록 위에 카드를 인라인 확장했다):
//   · **목록** `#/context/knowledge` — 사각지대·잔량을 비교하고, 켜고 끄고, 들어간다.
//   · **설정** `#/context/knowledge/<key>`(신규는 `/new`) — 3단 전폭 페이지(distillerPage).
//
//  왜 별도 페이지인가: 인라인 카드는 폼이 702px 밖에 못 썼다(1440 실측: main 1200 캡 → .ctx-layout 1160 →
//  카드 안 2열 = 폼 702 + 반사판 340). 필드 20개를 그 폭에 5단계 가로 탭으로 쪼개 넣고, 6천 자짜리 지시문
//  전문을 340px · max-height 300px 안에서 봐야 했다. 세로는 1840px(2화면). 페이지로 빼면서 함께 해결된 것:
//   · 주소가 생겼다 — "이 증류기 설정 좀 봐줘"가 링크 하나가 된다([[project-modal-url-routed-808]] 의 결).
//   · 카드를 열고 닫을 때마다 목록 전체가 재렌더되던 문제가 사라졌다(목록은 이제 편집을 모른다).
//
//  화면 설계 원칙:
//   · **레버 먼저, 세부는 접어서** — 채널마다 기준이 달라 결국 튜닝해야 하는데 축이 4개면 감이 안 온다.
//     값이 실제로 몇 건을 통과시키는지 **즉시 숫자로** 보여준다(추측 금지).
//   · **사각지대를 맨 위에** — "증류기를 켰는데 왜 안 줄지?"의 답이 목록보다 먼저 보인다.
//   · **채널은 고르는 것** — 실재하는 채널 목록(건수·잔량 포함)에서 눌러 담는다(오타 원천 차단).
//   · **반사판은 늘 곁에** — 설정을 만지는 내내 "지금 이게 무엇을 집는가"가 오른쪽에 붙어 있다.
import { api, busy, cardHead, el, keepSideScroll, relTime, toast } from './core.js';
import { confirmDialog, skeleton } from './ui-primitives.js';
import { stageJobCard } from './context-stage-job.js'; // 단계 공용 '언제 도나' 카드(#1618)
const PAGE_TYPES = ['', 'decision', 'concept', 'how-to', 'reference', 'research', 'entity'];
const KINDS = ['slack', 'email', 'discord', 'transcript', 'minutes', 'notion_doc', 'clickup_doc', 'drive_file', 'other'];
/** 목록 주소. */
const LIST_HREF = '#/context/knowledge';
/** 설정 페이지 주소 — 목록·크럼·저장 후 이동이 전부 이걸 쓴다(해시 문자열 조립이 흩어지지 않게). */
const pageHref = (key) => LIST_HREF + '/' + encodeURIComponent(key);
/** 신규 생성의 자리표시 key — 그래서 이 문자열은 실제 증류기 key 가 될 수 없다(저장 시 거부). */
const NEW_KEY = 'new';
// ── 저장 안 된 변경 가드 ─────────────────────────────────────────────────────
//  설정이 페이지가 되면서 새로고침·탭 닫기로 폼을 통째로 잃을 수 있게 됐다(인라인 카드 시절엔 '닫기'를
//  눌러야 사라졌다). 현재 열린 설정 페이지가 자기 dirty 판정을 여기 걸어 둔다.
//  ⚠ 해시 이동은 beforeunload 가 못 잡는다 — 그 경로는 '← 증류기 목록' 링크가 confirmDialog 로 막는다.
//   브라우저 뒤로가기까지 막으려면 라우터 계약(main.ts route())을 건드려야 해 이번 범위 밖으로 뒀고,
//   대신 '저장 안 된 변경' 배지를 머리에 상시 노출해 상태를 늘 보이게 했다.
let dirtyGuard = null;
window.addEventListener('beforeunload', (ev) => {
    if (!dirtyGuard || !dirtyGuard())
        return;
    ev.preventDefault();
    ev.returnValue = '';
});
window.addEventListener('hashchange', () => {
    // 설정 페이지를 벗어나면 가드를 놓는다 — 라우터는 view 를 갈아치울 뿐 정리 훅을 주지 않는다.
    if (!location.hash.startsWith(LIST_HREF + '/'))
        dirtyGuard = null;
});
// ══════════════════════════════════════════════════════════════════════════
//  목록 — #/context/knowledge
// ══════════════════════════════════════════════════════════════════════════
export async function distillersPanel(detail, data) {
    const head = () => el('div', { class: 'admin-sechead' }, el('div', { class: 'section-title' }, el('h2', { text: '자료 증류기' })), el('p', { class: 'admin-hint', text: '수집된 원본 자료를 무슨 기준으로 어떤 형식의 지식으로 만들지 정합니다. 팀·채널마다 다르게 여러 개 만들 수 있습니다.' }));
    busy(detail, head(), el('div', { class: 'card' }, skeleton('증류기 불러오는 중')));
    let res;
    try {
        res = await api('/api/ui/org/distillers');
    }
    catch (e) {
        detail.replaceChildren(head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message })));
        return;
    }
    const distillers = res.distillers || [];
    const coverage = res.coverage || { total_undistilled: 0, uncovered: 0, distillers: [], uncovered_channels: [] };
    const stat = (id) => coverage.distillers.find((x) => x.id === id) || {};
    const rerender = () => { void distillersPanel(detail, data); };
    const body = el('div', {});
    body.append(el('p', { class: 'admin-hint' }, el('span', { text: '증류기는 수집된 원본 자료(슬랙·메일 등)를 읽어 지식으로 만드는 생산 라인입니다. 한 자료는 ' }), el('b', { text: '우선순위가 가장 높은 증류기 하나' }), el('span', { text: '에만 배정됩니다(중복 증류 없음). 우선순위를 낮게 준 넓은 증류기는 자연히 나머지를 받는 기본 라인이 됩니다.' })));
    body.append(coverageCard(coverage, distillers));
    if (!distillers.length) {
        body.append(el('p', { class: 'admin-hint' }, el('span', { text: '아직 증류기가 없습니다. 증류기가 하나도 없으면 증류 잡은 ' }), el('b', { text: '전 자료 공통 기본 증류' }), el('span', { text: '로 동작합니다(채널·기준 구분 없음).' })));
    }
    for (const d of distillers)
        body.append(summaryCard(d, stat(d.id), rerender));
    // 만들기도 '들어가는 것' — 목록에서 폼이 펼쳐지지 않고 설정 페이지로 이동한다.
    body.append(el('div', { style: 'margin-top:14px' }, el('a', { class: 'btn', href: pageHref(NEW_KEY), text: '+ 증류기 만들기' })));
    body.append(await runJobCard(rerender));
    detail.replaceChildren(head(), body);
}
// ── 현황(사각지대 먼저) ────────────────────────────────────────────────────
function coverageCard(cov, distillers) {
    const card = el('div', { class: 'card', style: 'margin-top:12px' }, cardHead('증류 현황'));
    const on = distillers.filter((d) => d.enabled).length;
    card.append(el('div', { class: 'mini-meta' }, el('span', { class: 'pill', text: '미증류 자료 ' + (cov.total_undistilled || 0).toLocaleString() + '건' }), el('span', { class: 'pill' + (on ? ' pill-ok' : ''), text: '켜진 증류기 ' + on + '/' + distillers.length }), el('span', { class: 'pill' + (cov.uncovered ? '' : ' pill-ok'), text: '사각지대 ' + (cov.uncovered || 0).toLocaleString() + '건' })));
    if (cov.uncovered > 0 && on > 0) {
        card.append(el('p', { class: 'admin-hint', style: 'margin-top:8px' }, el('b', { text: '⚠ 사각지대 ' + cov.uncovered.toLocaleString() + '건' }), el('span', { text: ' — 켜진 증류기 어디에도 안 걸리는 자료입니다. 이대로 두면 영영 증류되지 않습니다. 아래 채널을 기존 증류기 범위에 넣거나, 우선순위를 낮춘 넓은 증류기를 하나 만들어 나머지를 받게 하세요.' })));
        if ((cov.uncovered_channels || []).length) {
            const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px' });
            for (const c of cov.uncovered_channels)
                grid.append(el('span', { class: 'pill', text: (c.channel || '(채널 없음)') + ' · ' + c.n.toLocaleString() }));
            card.append(grid);
        }
    }
    return card;
}
// ── 목록의 한 줄 ───────────────────────────────────────────────────────────
function summaryCard(d, st, rerender) {
    const card = el('div', { class: 'card', style: 'margin-top:12px' });
    // 제목이 곧 입구 — 들어가는 길이 '설정 열기' 버튼 하나뿐이면 찾아야 한다.
    card.append(el('div', { class: 'mini-title' }, el('a', { href: pageHref(d.key), text: d.label || d.key }), el('span', { class: 'pill' + (d.enabled ? ' pill-ok' : ''), text: d.enabled ? '켜짐' : '꺼짐' }), el('span', { class: 'pill', text: '우선순위 ' + d.priority }), el('span', { class: 'pill', text: '남은 자료 ' + Number(st.backlog || 0).toLocaleString() + '건' }), st.reviewed ? el('span', { class: 'pill', text: '판정 ' + Number(st.reviewed).toLocaleString() }) : null, d.prefilter_level ? el('span', { class: 'pill', text: '사전필터 ' + d.prefilter_level }) : null));
    card.append(el('div', { class: 'mini-meta' }, el('span', { text: d.scope_text || '범위 전체' })));
    card.append(el('div', { class: 'mini-meta' }, el('span', {
        text: d.last_run_at ? ('마지막 실행 ' + relTime(d.last_run_at) + ' · ' + (d.last_status || '')) : '아직 실행된 적 없음'
    })));
    const chk = el('input', { type: 'checkbox' });
    chk.checked = !!d.enabled;
    chk.addEventListener('change', async () => {
        try {
            await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify({ ...settable(d), enabled: chk.checked }) });
            toast('저장됨');
            rerender();
        }
        catch (e) {
            toast(e.message, true);
            chk.checked = !chk.checked;
        }
    });
    const edit = el('a', { class: 'btn btn-ghost btn-sm', href: pageHref(d.key), text: '설정 열기' });
    const del = el('button', { class: 'btn-text', type: 'button', text: '삭제' });
    del.addEventListener('click', () => { void removeDistiller(d, rerender); });
    card.append(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap' }, el('label', { class: 'inline' }, chk, el('span', { text: ' 켜기' })), edit, del));
    return card;
}
/** 삭제 — 목록과 설정 페이지가 같은 문구·같은 확인을 쓴다. after 는 삭제에 성공한 뒤 할 일. */
async function removeDistiller(d, after) {
    const ok = await confirmDialog({
        title: `증류기 '${d.label || d.key}' 를 삭제할까요?`,
        message: '이미 만들어진 지식은 그대로 남습니다. 이 증류기가 맡던 자료는 다른 증류기(또는 사각지대)로 넘어갑니다.',
        confirmText: '삭제', danger: true,
    });
    if (!ok)
        return;
    try {
        await api('/api/ui/org/distillers/remove', { method: 'POST', body: JSON.stringify({ id: d.id }) });
        toast('삭제됨');
        after();
    }
    catch (e) {
        toast(e.message, true);
    }
}
// upsert 는 전 필드 교체라, 부분 저장 시 나머지가 날아가지 않게 현재 값을 그대로 되보낸다.
function settable(d) {
    return {
        id: d.id, key: d.key, label: d.label, priority: d.priority, enabled: d.enabled,
        match_kinds: d.match_kinds, match_system: d.match_system,
        include_channels: d.include_channels, exclude_channels: d.exclude_channels,
        include_authors: d.include_authors, exclude_authors: d.exclude_authors,
        exclude_bots: d.exclude_bots, min_chars: d.min_chars, lookback_days: d.lookback_days,
        criteria_md: d.criteria_md, format_md: d.format_md, target_category: d.target_category,
        default_type: d.default_type, name_prefix: d.name_prefix, thread_aware: d.thread_aware,
        prefilter_level: d.prefilter_level, prefilter_rules: d.prefilter_rules,
        batch_size: d.batch_size, batch_max_msgs: d.batch_max_msgs, mode: d.mode, session_ref: d.session_ref,
        model: d.model, effort: d.effort, requester: d.requester, note: d.note,
    };
}
// ══════════════════════════════════════════════════════════════════════════
//  설정 페이지 — #/context/knowledge/<key>
// ══════════════════════════════════════════════════════════════════════════
/** 위치 + 되돌아갈 자리. 이 페이지엔 좌측 단계 내비(.ctx-side)를 그리지 않으므로 이 한 줄이 그 몫을 한다. */
function crumb() {
    const back = el('a', { href: LIST_HREF, text: '← 증류기 목록' });
    return {
        back,
        nav: el('nav', { class: 'dst-crumb', 'aria-label': '위치' }, back, el('span', { class: 'dst-crumb-sep', text: '·', 'aria-hidden': 'true' }), el('span', { text: '맥락 관리 › 증류' })),
    };
}
/** 페이지 셸 — 로딩·오류·없음도 크럼을 달고 나온다(링크로 착지한 사람이 나갈 길을 잃지 않게). */
function pageShell(...kids) {
    return el('div', { class: 'dst-page' }, crumb().nav, ...kids);
}
export async function distillerPage(view, rawKey) {
    const key = decodeURIComponent(rawKey || '');
    const isNew = key === NEW_KEY;
    dirtyGuard = null; // 이전 페이지의 가드를 물려받지 않는다
    view.replaceChildren(pageShell(el('div', { class: 'card' }, skeleton('증류기 설정 불러오는 중'))));
    let d = null;
    if (!isNew) {
        let res;
        try {
            res = await api('/api/ui/org/distillers');
        }
        catch (e) {
            view.replaceChildren(pageShell(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '증류기를 불러오지 못했습니다 — ' + e.message }))));
            return;
        }
        d = (res.distillers || []).find((x) => x.key === key) || null;
        if (!d) {
            // 삭제됐거나 오타난 주소 — 링크를 받은 사람이 여기 착지할 수 있으니 무엇이 없는지 그대로 말한다.
            view.replaceChildren(pageShell(el('div', { class: 'card' }, el('p', { class: 'mini-title' }, el('span', { text: '이 증류기를 찾지 못했습니다' })), el('p', { class: 'admin-hint', text: `식별자 '${key}' 인 증류기가 없습니다. 이름이 바뀌었거나 삭제됐을 수 있습니다.` }), el('div', { style: 'margin-top:12px' }, el('a', { class: 'btn btn-ghost', href: LIST_HREF, text: '증류기 목록으로' })))));
            return;
        }
    }
    view.replaceChildren(editorPage(d, isNew));
}
function editorPage(d, isNew) {
    const page = el('div', { class: 'dst-page' });
    // 한 줄 필드 — 라벨·설명·입력을 묶어 일관되게. 설명은 '왜 이 값을 정하나'를 말한다.
    const F = (label, hint, ctrl) => el('div', { class: 'dst-field' }, el('div', { class: 'field-label', text: label }), hint ? el('p', { class: 'admin-hint', text: hint }) : null, ctrl);
    // 짧은 필드 둘을 나란히 — 넓어진 폼을 실제로 쓰려면 이게 필요하다(실측: 260px 짜리 숫자칸이
    //  세로로만 쌓여 오른쪽 500px 이 통째로 비었다). 좁은 화면에서는 CSS 가 1열로 되돌린다.
    const row2 = (a, b) => el('div', { class: 'dst-row2' }, a, b);
    // 접이식 — 세부 옵션을 숨기되 막지는 않는다(커스텀 상한 없음). 폼이 넓어졌어도 '늘 필요하진 않은' 축은 접는다.
    const fold = (title, ...kids) => {
        const wrap = el('div', { class: 'dst-fold' });
        const btn = el('button', { type: 'button', class: 'btn-text', text: '▸ ' + title, 'aria-expanded': 'false' });
        btn.addEventListener('click', () => {
            const open = wrap.classList.toggle('open');
            btn.textContent = (open ? '▾ ' : '▸ ') + title;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        wrap.append(btn, el('div', { class: 'dst-fold-body' }, ...kids));
        return wrap;
    };
    const v = (k, dflt = '') => (d && d[k] != null ? d[k] : dflt);
    const listText = (x) => Array.isArray(x) ? x.join('\n') : (x || '');
    // ⓪ 기본
    const keyIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('key'), placeholder: 'hf-yeosin', ...(isNew ? {} : { disabled: true }) });
    const labelIn = el('input', { type: 'text', class: 'dst-in', value: v('label'), placeholder: '여신 제품팀 증류기' });
    const prioIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('priority', 0)) });
    const enabledChk = el('input', { type: 'checkbox', ...(v('enabled', false) ? { checked: true } : {}) });
    // ① 범위
    const kindBoxes = {};
    const kindsWrap = el('div', { class: 'dst-kinds' });
    const curKinds = new Set(v('match_kinds', []) || []);
    for (const k of KINDS) {
        const cb = el('input', { type: 'checkbox', value: k });
        cb.checked = curKinds.has(k);
        kindBoxes[k] = cb;
        kindsWrap.append(el('label', { class: 'pill' }, cb, el('span', { text: ' ' + k })));
    }
    const incCh = el('textarea', { class: 'dst-in', style: 'min-height:88px', placeholder: '한 줄에 채널 하나. 비우면 채널 무관(전체)' });
    incCh.value = listText(v('include_channels', null));
    const excCh = el('textarea', { class: 'dst-in', style: 'min-height:60px', placeholder: '제외할 채널(한 줄에 하나)' });
    excCh.value = listText(v('exclude_channels', null));
    const botChk = el('input', { type: 'checkbox', ...(v('exclude_bots', true) ? { checked: true } : {}) });
    const minIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('min_chars', 0)), min: '0' });
    const lookIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: d && d.lookback_days ? String(d.lookback_days) : '', placeholder: '비우면 전체 기간' });
    const chPick = el('div', { class: 'dst-chpick' }, el('span', { class: 'admin-hint', text: '채널 목록 불러오는 중…' }));
    void (async () => {
        try {
            const r = await api('/api/ui/org/source-channels?limit=200');
            const chans = (r.channels || []).filter((c) => c.channel);
            chPick.replaceChildren();
            if (!chans.length) {
                chPick.append(el('span', { class: 'admin-hint', text: '수집된 채널이 아직 없습니다.' }));
                return;
            }
            for (const c of chans) {
                const b = el('button', { type: 'button', class: 'pill', title: '클릭하면 대상 채널에 추가',
                    text: c.channel + ' · 미증류 ' + Number(c.undistilled).toLocaleString() });
                b.addEventListener('click', () => {
                    const cur = incCh.value.split('\n').map((s) => s.trim()).filter(Boolean);
                    if (!cur.includes(c.channel)) {
                        cur.push(c.channel);
                        incCh.value = cur.join('\n');
                    }
                    // 프로그램이 바꾼 값은 input 을 안 쏜다 — 눌러 담아도 반사판이 갱신되게 직접 알린다.
                    incCh.dispatchEvent(new Event('input', { bubbles: true }));
                });
                chPick.append(b);
            }
        }
        catch {
            chPick.replaceChildren(el('span', { class: 'admin-hint', text: '채널 목록을 불러오지 못했습니다(직접 입력해도 됩니다).' }));
        }
    })();
    // ② 사전 필터 — 축별 수치가 정본(레버 폐기). 최적값은 AI 가 실측으로 정한다.
    const rules = (d && d.prefilter_rules) || {};
    const rIn = (k, ph) => {
        const i = el('input', { type: 'number', class: 'dst-in dst-in-sm', placeholder: ph });
        if (rules[k] != null)
            i.value = String(rules[k]);
        return i;
    };
    const rDec = rIn('min_decisive', '비우면 조건 없음'), rAut = rIn('min_authors', '비우면 조건 없음');
    const rMsg = rIn('min_msgs', '비우면 조건 없음'), rChr = rIn('min_chars', '비우면 조건 없음');
    const rKw = el('textarea', { class: 'dst-in', style: 'min-height:110px',
        placeholder: '한 줄에 하나. 이 채널에서 실제로 쓰는 말을 많이 넣을수록 좋습니다(도메인 용어가 특히 잘 듣습니다).' });
    rKw.value = Array.isArray(rules.keywords) ? rules.keywords.join('\n') : '';
    const rMatch = el('select', { class: 'dst-in dst-in-sm' });
    rMatch.append(el('option', { value: 'any', text: '하나만 만족해도 통과 (OR · 권장)' }));
    rMatch.append(el('option', { value: 'all', text: '모든 조건을 만족해야 통과 (AND · 유실 큼)' }));
    rMatch.value = rules.match === 'all' ? 'all' : 'any';
    // ③ 기준·형식
    const critIn = el('textarea', { class: 'dst-in', style: 'min-height:150px',
        placeholder: '예) 제품 사양 결정·장애 원인과 조치·운영 규칙 합의만 지식화한다. 일정 조율·단순 질의응답은 제외.' });
    critIn.value = v('criteria_md');
    const fmtIn = el('textarea', { class: 'dst-in', style: 'min-height:150px',
        placeholder: '예) 제목은 “[여신] <결정 한 줄>”. 본문은 배경 / 결정 / 근거 / 영향 순서의 섹션으로.' });
    fmtIn.value = v('format_md');
    const catIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('target_category'), placeholder: '비우면 AI가 내용에 맞는 분류를 고름' });
    const typeSel = el('select', { class: 'dst-in dst-in-sm' });
    for (const t of PAGE_TYPES)
        typeSel.append(el('option', { value: t, text: t || '(자동)' }));
    if (v('default_type'))
        typeSel.value = v('default_type');
    const prefixIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('name_prefix'), placeholder: '예: hf-yeosin-' });
    const threadChk = el('input', { type: 'checkbox', ...(v('thread_aware', true) ? { checked: true } : {}) });
    // ④ 실행
    const batchIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('batch_size', 3)), min: '1', max: '200' });
    const batchMsgIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('batch_max_msgs', 20)), min: '1', max: '2000' });
    const modeSel = el('select', { class: 'dst-in dst-in-sm' });
    modeSel.append(el('option', { value: 'headless', text: '헤드리스 — 매 배치 새 세션(권장)' }));
    modeSel.append(el('option', { value: 'session', text: '상시 세션에 주입' }));
    if (v('mode'))
        modeSel.value = v('mode');
    const sessIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('session_ref'), placeholder: '실행 방식이 상시 세션일 때만' });
    const modelSel = el('select', { class: 'dst-in dst-in-sm' });
    for (const m of ['', 'fable', 'opus', 'sonnet', 'haiku'])
        modelSel.append(el('option', { value: m, text: m || '(계정 기본)' }));
    if (v('model'))
        modelSel.value = v('model');
    const effortSel = el('select', { class: 'dst-in dst-in-sm' });
    for (const m of ['', 'low', 'medium', 'high', 'xhigh', 'max'])
        effortSel.append(el('option', { value: m, text: m || '(기본)' }));
    if (v('effort'))
        effortSel.value = v('effort');
    const reqIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('requester'), placeholder: '비우면 잡 생성자 — 이 사람의 AI 계정으로 실행·과금' });
    const collect = () => {
        const kw = rKw.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const pr = {};
        const put = (k, i) => { const x = i.value.trim(); if (x !== '')
            pr[k] = Number(x); };
        put('min_decisive', rDec);
        put('min_authors', rAut);
        put('min_msgs', rMsg);
        put('min_chars', rChr);
        if (kw.length)
            pr.keywords = kw;
        if (rMatch.value === 'any')
            pr.match = 'any';
        return {
            ...(d ? { id: d.id } : {}),
            key: keyIn.value.trim(),
            label: labelIn.value.trim() || null,
            enabled: enabledChk.checked,
            priority: Number(prioIn.value) || 0,
            match_kinds: Object.keys(kindBoxes).filter((k) => kindBoxes[k].checked),
            include_channels: incCh.value, exclude_channels: excCh.value,
            exclude_bots: botChk.checked,
            min_chars: Number(minIn.value) || 0,
            lookback_days: lookIn.value.trim() ? Number(lookIn.value) : null,
            prefilter_level: 0, // 레버 폐기 — rules 가 정본
            prefilter_rules: Object.keys(pr).length ? pr : null,
            criteria_md: critIn.value.trim() || null,
            format_md: fmtIn.value.trim() || null,
            target_category: catIn.value.trim() || null,
            default_type: typeSel.value || null,
            name_prefix: prefixIn.value.trim() || null,
            thread_aware: threadChk.checked,
            batch_size: Number(batchIn.value) || 3,
            batch_max_msgs: Number(batchMsgIn.value) || 20,
            mode: modeSel.value,
            session_ref: sessIn.value.trim() || null,
            model: modelSel.value || null, effort: effortSel.value || null,
            requester: reqIn.value.trim() || null,
            // 조각: 손대지 않은(빈) 칸은 **키를 아예 안 보낸다** — 미지정=기본값이고, 빈 문자열은 '그 조각을 뺀다'는
            //  다른 뜻이기 때문이다. 조각 UI 를 아직 안 불러왔으면 이 필드를 건드리지 않는다(기존 설정 보존).
            ...(sectionsLoaded.v ? { prompt_sections: (() => {
                    const o = {};
                    for (const [id, ta] of Object.entries(sectionInputs))
                        if (ta.value !== '')
                            o[id] = ta.value;
                    return Object.keys(o).length ? o : null;
                })() } : {}),
        };
    };
    // ── 프롬프트 조각 덮어쓰기(#1419-B) ──────────────────────────────────────────
    //  프롬프트가 코드에 통으로 박혀 있으면 무엇이 나가는지 파악도 수정도 어렵다. 조각만 덮어쓴다.
    //  · 편집란은 **비어 있는 게 기본** — 비면 코드 기본값이 나가고, 제품 개선이 계속 흘러든다.
    //  · [기본값 보기]로 원문을 펼쳐 확인한 뒤 덮어쓴다(무엇을 대체하는지 모르면 덮어쓸 수 없다).
    //  · 대상 지정·안전 문구는 불변이라 여기 없다(스코프 누출·주입 방어 상실 방지).
    const SECTION_HINT = {
        intro: '배치 첫 문장. 증류기 이름과 자료 건수를 알립니다.',
        criteria: '무엇을 지식화할지. 위 [지식화 기준] 칸이 이 조각의 저장소입니다 — 여기에 쓰면 그 칸 대신 이게 나갑니다.',
        format: '결과 문서 형식. 위 [문서 형식] 칸이 저장소입니다.',
        thread: '스레드를 한 덩어리로 묶으라는 지시. 스레드 묶기를 끄면 애초에 안 나갑니다.',
        procedure: '절차 ①~⑤(본문 읽기·중복확인·저장·허용선·skip).',
    };
    const sectionInputs = {};
    const sectionDefs = {}; // [기본값 보기] 본문 — 설정이 바뀌면 **이것만** 갱신한다
    const sectionsHost = el('div', {}, el('p', { class: 'admin-hint', text: '지시문 조각을 불러오는 중…' }));
    const sectionsLoaded = { v: false };
    const defText = (v) => v.def || '(이 조각은 지금 설정에선 나가지 않습니다)';
    // ⚠ **이미 만든 편집란을 다시 만들지 않는다.** 미리보기는 입력이 바뀔 때마다(디바운스 0.6초) 갱신되는데,
    //  그 응답마다 textarea 를 새로 그리면 **사람이 지금 타이핑하던 요소가 DOM 에서 사라진다** — 값은 서버가
    //  override 로 돌려줘 복원되지만 **포커스·커서·선택영역이 매번 날아가** 문장을 이어 쓸 수가 없다
    //  (= 조각 편집이 사실상 불가능. 실측 #1557: 0.6초마다 activeElement 가 BODY 로 빠졌다).
    //  편집란의 값은 **사람이 소유**한다 — 서버 응답이 갱신해야 할 것은 [기본값 보기] 본문뿐이다.
    //  (scripts/distiller-sections-stable.test.mjs 가 이 함수를 산출물에서 꺼내 두 번 호출해 잠근다 —
    //   이름·자유변수를 바꾸면 그 테스트도 함께 고쳐야 한다.)
    function renderSections(views) {
        if (sectionsLoaded.v) {
            for (const v of (views || [])) {
                const pre = sectionDefs[v.id];
                if (pre)
                    pre.textContent = defText(v);
            }
            return;
        }
        const rows = [];
        for (const v of (views || [])) {
            const ta = el('textarea', { rows: '5', class: 'dst-in', placeholder: '비어 있으면 기본값이 나갑니다' });
            ta.value = typeof v.override === 'string' ? v.override : '';
            sectionInputs[v.id] = ta;
            const pre = el('pre', { class: 'dst-sec-def', text: defText(v) });
            sectionDefs[v.id] = pre;
            rows.push(el('div', { class: 'dst-sec' }, el('div', { class: 'mini-meta' }, el('span', { class: 'pill', text: v.label }), el('span', { class: 'admin-hint', text: ' ' + (SECTION_HINT[v.id] || '') })), ta, el('details', { style: 'margin-top:4px' }, el('summary', { class: 'admin-hint', text: '기본값 보기' }), pre)));
        }
        sectionsLoaded.v = true;
        sectionsHost.replaceChildren(el('p', { class: 'admin-hint', text: '비워 두면 코드 기본값이 나갑니다(제품이 개선되면 자동 반영). 내용을 쓰면 그 조각만 대체됩니다. 대상 자료 지정과 안전 문구는 바꿀 수 없어 여기 없습니다.' }), ...rows);
    }
    // ── 반사판(우측) — "지금 이 설정이 무엇을 집는가"를 입력 즉시 보여준다 ──────────
    //  종전 화면의 가장 큰 불편이 여기였다: 미리보기가 **저장된 값**만 읽고 폼 맨 아래에 나와서,
    //  채널 하나 고치려면 저장→스크롤→확인을 반복해야 했다(새 증류기는 미리보기 자체가 거부됐다).
    //  이제 입력이 바뀌면 draft 로 서버에 물어 오른쪽이 갱신된다 — 저장 없이. DB 는 안 건드린다.
    //  #1564: 지시문 전문이 접힌 details(max-height 300px) 대신 **남은 높이를 다 쓰는 영역**이 됐다.
    const rBacklog = el('div', { class: 'dst-reflect-num', text: '—' });
    const rFilter = el('p', { class: 'admin-hint', style: 'margin:2px 0 0' });
    const rLoss = el('p', { style: 'margin:6px 0 0;font-size:12px' });
    const rSample = el('div', { class: 'dst-reflect-sample' });
    const rPrompt = el('pre', { class: 'dst-reflect-prompt' });
    const rState = el('p', { class: 'admin-hint', style: 'margin:0', text: '설정을 바꾸면 여기가 갱신됩니다.' });
    function paint(r) {
        rState.textContent = '';
        rBacklog.textContent = '집힐 자료 ' + Number(r.backlog || 0).toLocaleString() + '건';
        const fi = r.filter_impact;
        if (!fi) {
            rFilter.textContent = '';
            rLoss.replaceChildren();
        }
        else if (!fi.filtered) {
            rFilter.textContent = '사전 필터 꺼짐 — 이 범위의 자료를 전부 AI에게 보냅니다.';
            rLoss.replaceChildren();
        }
        else {
            rFilter.textContent = '필터 통과 ' + Number(fi.pass_msgs).toLocaleString() + '건'
                + (fi.pass_pct != null ? ' (' + fi.pass_pct + '%)' : '') + ' · 범위 전체 ' + Number(fi.msgs).toLocaleString() + '건';
            // ⚠ 유실률이 이 화면의 핵심 숫자다 — 절감은 눈에 띄지만 유실은 안 보여주면 아무도 모른 채 지식을 버린다.
            if (fi.loss_pct == null) {
                rLoss.replaceChildren(el('span', { class: 'admin-hint', text: '이 범위엔 아직 지식이 된 스레드가 없어 유실률을 잴 수 없습니다.' }));
            }
            else {
                const bad = fi.loss_pct > 5;
                rLoss.replaceChildren(el('b', { style: 'color:var(' + (bad ? '--coral-text' : '--mint-deep') + ')',
                    text: (bad ? '⚠ ' : '✓ ') + '이미 지식이 된 스레드의 ' + fi.loss_pct + '% 가 이 필터에 걸러집니다' }), el('span', { class: 'admin-hint', text: ' (' + (fi.known_threads - fi.kept_known) + '/' + fi.known_threads + '건)' }), bad ? el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: '그만큼 앞으로 지식을 놓칩니다. AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 유실을 억제한 값을 실측으로 찾아줍니다.' }) : null);
            }
        }
        rSample.replaceChildren();
        for (const s of (r.sample || [])) {
            rSample.append(el('div', { class: 'mini-meta' }, el('span', { class: 'pill', text: String(s.channel || s.kind) }), el('span', { text: ' ' + String(s.title || '(제목 없음)').slice(0, 70) })));
        }
        if (!(r.sample || []).length) {
            rSample.append(el('p', { class: 'admin-hint', text: '지금 집히는 자료가 0건입니다 — 채널명 오타, 사전 필터가 과함, 또는 우선순위가 높은 증류기가 먼저 가져가는지 확인하세요.' }));
        }
        rPrompt.textContent = r.prompt || '';
        if (r.sections) {
            // 조각이 처음 실리면 collect() 결과에 prompt_sections 가 더해진다 — 그때 '저장된 상태'의 기준선을
            //  다시 잡지 않으면 아무것도 안 건드렸는데 '저장 안 된 변경'으로 보인다. 사람이 이미 손댔으면 그대로 둔다.
            const first = !sectionsLoaded.v;
            renderSections(r.sections);
            if (first && !touched)
                markClean();
        }
    }
    let seq = 0, timer = null;
    async function refresh() {
        const my = ++seq;
        rState.textContent = '계산 중…';
        try {
            const body = { draft: collect(), limit: 8 };
            if (!isNew)
                body.key = d.key;
            const r = await api('/api/ui/org/distillers/preview', { method: 'POST', body: JSON.stringify(body) });
            if (my !== seq)
                return; // 늦게 온 응답이 최신 결과를 덮지 않게
            paint(r);
        }
        catch (e) {
            if (my !== seq)
                return;
            rState.textContent = '미리보기 실패: ' + e.message;
            // ⑤ 지시문 조각도 **이 응답 하나**에서 온다 — 실패를 그 단계에도 알리지 않으면
            //  "설명 문구만 있고 편집란이 없는" 텅 빈 화면이 되어 사람이 원인을 못 짚는다(#1557).
            if (!sectionsLoaded.v) {
                sectionsHost.replaceChildren(el('p', { class: 'admin-hint',
                    text: '지시문 조각을 불러오지 못했습니다(미리보기 실패: ' + e.message + '). 설정을 바꾸면 다시 시도합니다.' }));
            }
        }
    }
    // 지시문 전문은 사람이 통째로 들고 나가 검토하는 물건이다("이 지시문 좀 봐줘") — 6천 자를 직접 드래그하지 않게.
    const copyBtn = el('button', { type: 'button', class: 'btn-text', text: '복사' });
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(rPrompt.textContent || '');
            toast('지시문 전문을 복사했습니다');
        }
        catch {
            toast('복사하지 못했습니다 — 직접 선택해 복사하세요', true);
        }
    });
    const reflect = el('aside', { class: 'card dst-reflect', 'aria-label': '지금 이 설정이 집는 것' }, el('div', { class: 'mini-meta' }, el('span', { class: 'pill', text: '지금 이 설정이' })), rBacklog, rFilter, rLoss, rState, rSample, el('div', { class: 'dst-reflect-prompt-head' }, el('span', { class: 'field-label', text: 'AI 에게 나갈 지시문 전문' }), copyBtn), rPrompt);
    // ── 단계 네비(좌측) — 가로 탭이던 것을 세로로. 지금 어느 단계인지가 늘 보인다 ──────
    //  ⚠ 항목은 **버튼**이다(링크 아님): 링크면 라우터가 돌아 폼이 통째로 재렌더되고 입력 중인 값이 날아간다.
    //   사이드바 시각 언어는 사용 가이드·관리탭의 .docs-side 를 그대로 쓴다(#827 과 같은 결).
    const STEPS = [
        { key: 'basic', label: '기본', hint: '이름과 식별자, 사용 여부를 정합니다.' },
        { key: 'scope', label: '① 범위', hint: '어떤 자료를 이 증류기가 맡을지 정합니다.' },
        { key: 'filter', label: '② 사전 필터', hint: 'AI에게 보내기 전에 서버가 걸러낼 기준입니다.' },
        { key: 'what', label: '③ 기준·형식', hint: '무엇을 지식으로 만들고, 어떤 문서로 쓸지 정합니다.' },
        { key: 'run', label: '④ 실행', hint: '배치 크기·의뢰자·모델을 정합니다.' },
        { key: 'prompt', label: '⑤ 지시문', hint: 'AI에게 나갈 문장을 조각별로 손봅니다.' },
    ];
    const panes = {};
    const side = el('nav', { class: 'docs-side dst-side', 'aria-label': '설정 단계' });
    keepSideScroll(side, 'distiller'); // 단계를 고르면 화면을 다시 그려 사이드바가 새 노드가 된다(#1635)
    const sideGroup = el('div', { class: 'docs-side-group' }, el('div', { class: 'docs-side-title', text: '설정' }));
    for (const s of STEPS) {
        const b = el('button', { type: 'button', class: 'docs-item', 'data-step': s.key, text: s.label });
        b.addEventListener('click', () => showStep(s.key));
        sideGroup.append(b);
    }
    side.append(sideGroup);
    const stepHint = el('p', { class: 'dst-step-hint' });
    const paneHost = el('div', {});
    function showStep(k) {
        const s = STEPS.find((x) => x.key === k) || STEPS[0];
        for (const b of side.querySelectorAll('.docs-item')) {
            const on = b.dataset.step === s.key;
            b.classList.toggle('active', on);
            if (on)
                b.setAttribute('aria-current', 'true');
            else
                b.removeAttribute('aria-current');
        }
        stepHint.textContent = s.hint;
        paneHost.replaceChildren(panes[s.key]);
    }
    panes.basic = el('div', {}, row2(F('이름', '목록에 보일 이름입니다.', labelIn), F('식별자(key)', isNew ? '소문자 슬러그(a-z0-9._-). 이 값이 이 설정 화면의 주소가 됩니다 — 만든 뒤에는 바꾸지 않는 것을 권합니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn)), el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 이 증류기 사용' })));
    panes.scope = el('div', {}, F('자료 종류', '비우면 전체. 슬랙만 다루는 증류기면 slack 만 고르세요.', kindsWrap), F('대상 채널', '한 줄에 하나. 비우면 채널을 가리지 않습니다. 아래 목록에서 눌러 담으면 오타가 없습니다.', el('div', {}, incCh, chPick)), F('제외 채널', '알림봇·모니터링 채널처럼 지식화할 게 없는 곳을 빼세요. (이미 수집된 뒤라면 커넥터에서 막는 게 낫습니다 — 저장공간을 계속 먹습니다.)', excCh), el('label', { class: 'inline' }, botChk, el('span', { text: ' 봇이 쓴 메시지는 제외' })), fold('세부 조건(길이·기간)', row2(F('본문 최소 길이', '이 길이보다 짧은 자료는 건너뜁니다. 0이면 제한 없음.', minIn), F('기간', '최근 며칠치만 다룰지. 비우면 과거 전체를 백필합니다.', lookIn))), fold('우선순위 — 다른 증류기와 겹칠 때', F('우선순위', '높을수록 먼저 가져갑니다. 한 자료는 우선순위가 높은 증류기 하나만 처리합니다. 낮은 값 + 넓은 범위 = 나머지를 받는 기본 라인(catch-all).', prioIn)));
    panes.filter = el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0 0 10px' }, el('span', { text: 'AI에게 보내기 ' }), el('b', { text: '전에' }), el('span', { text: ' 서버가 스레드를 걸러냅니다. 비워두면 필터가 꺼집니다(전부 보냄). 오른쪽에서 ' }), el('b', { text: '유실률' }), el('span', { text: '을 보며 정하세요 — 그게 앞으로 놓칠 지식의 비율입니다.' })), el('p', { class: 'dst-callout' }, el('b', { text: '값을 감으로 정하지 마세요. ' }), el('span', { text: 'AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 실측으로 정합니다 — 이 채널에서 판별력 높은 단어가 무엇인지, 조합별 절감 대비 유실이 얼마인지 계산해 최적값을 넣어줍니다.' })), row2(F('결정성 키워드 최소 등장', '아래 [결정성 키워드 목록]의 말이 스레드에 몇 번 나와야 하는지.', rDec), F('스레드 최소 길이(자)', '짧은 잡담을 거르는 데 가장 안전한 축입니다.', rChr)), F('결정성 키워드 목록', '이 채널에서 실제로 쓰는 말. 실측상 "결정·장애" 같은 일반어보다 "할인일시납·플랫폼이용료" 같은 도메인 용어가 훨씬 잘 듣습니다. 많이 넣으세요.', rKw), fold('참여자·메시지 수 조건 (신중히)', el('p', { class: 'admin-hint', text: '⚠ 이 두 축이 유실을 많이 냅니다 — 한 사람이 길게 쓴 분석 보고, 짧지만 결론이 담긴 스레드가 잘립니다.' }), row2(F('최소 참여자 수', '', rAut), F('최소 메시지 수', '', rMsg))), F('조건 결합', 'OR 권장. AND 는 모든 축을 만족해야 해서 값진 스레드를 많이 버립니다(실측 21% 유실).', rMatch));
    panes.what = el('div', {}, F('지식화 기준', '이 팀에서 무엇이 남길 가치가 있는지 그대로 쓰세요. 이 문장이 AI의 판단 기준이 됩니다.', critIn), F('결과 문서 형식', '제목 규칙·섹션 구성 등을 자유롭게 쓰세요.', fmtIn), el('label', { class: 'inline' }, threadChk, el('span', { text: ' 스레드를 묶어 하나의 지식으로 (권장)' })), fold('분류·이름 규칙', F('분류 고정', '항상 한 분류에 넣으려면 분류 key 를 쓰세요. 비우면 AI가 내용에 맞게 고릅니다.', catIn), row2(F('문서 유형 기본값', '', typeSel), F('지식 이름 접두어', '산출 지식의 이름을 이 문자열로 시작하게 합니다.', prefixIn))));
    panes.run = el('div', {}, row2(F('한 번에 처리할 스레드 수', '배치는 스레드 단위로 자릅니다 — 스레드를 쪼개면 대화가 끊겨 증류가 안 됩니다. 2~3 권장.', batchIn), F('한 배치 메시지 상한', '스레드를 최근순으로 담다가 이 수를 넘으면 멈춥니다. ⚠ 첫 스레드는 예외 — 상한보다 커도 통째로 담습니다(대화를 자르지 않으려고). 20~40 권장.', batchMsgIn)), F('의뢰자', '이 사람의 AI 계정으로 실행되고 과금됩니다.', reqIn), fold('실행 방식·모델', row2(F('실행 방식', '헤드리스는 매 배치 새 세션이라 이전 판단에 끌려가지 않습니다(권장).', modeSel), F('상시 세션 id', '실행 방식이 상시 세션일 때만 필요합니다.', sessIn)), row2(F('모델', '판단이 무거운 기준이면 sonnet 이상을 권합니다.', modelSel), F('추론 강도', '', effortSel))));
    panes.prompt = el('div', {}, sectionsHost);
    // ── 저장 안 된 변경 추적 ────────────────────────────────────────────────────
    //  페이지가 되면서 새로고침·뒤로가기로 폼을 잃을 수 있게 됐다. 지금 상태가 저장본과 다른지를 늘 보인다.
    const dirtyBadge = el('span', { class: 'dst-dirty', text: '저장 안 된 변경', hidden: 'hidden' });
    let baseline = '';
    let touched = false; // 사람이 한 번이라도 건드렸나 — 조각 로드 시 기준선 재촬영 여부 판단에 쓴다
    const isDirty = () => JSON.stringify(collect()) !== baseline;
    function paintDirty() { dirtyBadge.hidden = !isDirty(); }
    function markClean() { baseline = JSON.stringify(collect()); paintDirty(); }
    // ── 저장 ──────────────────────────────────────────────────────────────────
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '증류기 만들기' : '저장' });
    async function save() {
        const body = collect();
        if (!body.key) {
            showStep('basic');
            toast('식별자(key)가 필요합니다', true);
            keyIn.focus();
            return;
        }
        // '/new' 가 신규 생성의 주소라, key 가 'new' 면 그 증류기의 설정 페이지를 영영 열 수 없다.
        if (body.key === NEW_KEY) {
            showStep('basic');
            toast("'new' 는 주소에서 '새 증류기'를 뜻해 식별자로 쓸 수 없습니다", true);
            keyIn.focus();
            return;
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify(body) });
            if (isNew) {
                // 만든 즉시 그 증류기의 주소로 — replace 라 뒤로가기가 '/new'(빈 폼)로 되돌아가지 않는다.
                //  해시가 바뀌므로 라우터가 이 페이지를 저장된 값으로 다시 그린다.
                dirtyGuard = null;
                toast('증류기를 만들었습니다');
                location.replace(pageHref(body.key));
                return;
            }
            toast('저장했습니다');
            titleEl.textContent = body.label || body.key;
            markClean();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
        }
        finally {
            saveBtn.disabled = false;
        }
    }
    saveBtn.addEventListener('click', () => { void save(); });
    // ── 머리 ──────────────────────────────────────────────────────────────────
    const { nav: crumbNav, back } = crumb();
    back.addEventListener('click', (ev) => {
        if (!isDirty())
            return; // 기본 동작(해시 이동)
        ev.preventDefault();
        void (async () => {
            const go = await confirmDialog({
                title: '저장하지 않고 나갈까요?',
                message: '이 증류기 설정에 저장하지 않은 변경이 있습니다.',
                confirmText: '나가기', cancelText: '계속 편집', danger: true,
            });
            if (go) {
                dirtyGuard = null;
                location.hash = LIST_HREF;
            }
        })();
    });
    const titleEl = el('h1', { class: 'dst-title', text: isNew ? '새 증류기' : (d.label || d.key) });
    const headActs = el('div', { class: 'dst-head-acts' }, dirtyBadge, saveBtn);
    if (!isNew) {
        const del = el('button', { class: 'btn-text', type: 'button', text: '삭제' });
        del.addEventListener('click', () => {
            void removeDistiller(d, () => { dirtyGuard = null; location.hash = LIST_HREF; });
        });
        headActs.append(del);
    }
    const head = el('div', { class: 'dst-head' }, el('div', { class: 'dst-head-main' }, titleEl, el('p', { class: 'dst-sub', text: isNew
            ? '무엇을 어떤 기준으로 어떤 형식의 지식으로 만들지 정합니다. 오른쪽에서 지금 설정이 무엇을 집는지 바로 확인할 수 있습니다.'
            : '식별자 ' + d.key + (d.last_run_at ? ' · 마지막 실행 ' + relTime(d.last_run_at) + ' · ' + (d.last_status || '') : ' · 아직 실행된 적 없음') })), headActs);
    const form = el('div', { class: 'dst-form' }, el('div', { class: 'card' }, stepHint, paneHost));
    page.append(crumbNav, head, el('div', { class: 'dst-grid' }, side, form, reflect));
    // 입력 변경 → 디바운스 → 반사판 갱신. 타이핑마다 서버를 때리지 않는다.
    const onEdit = () => { touched = true; paintDirty(); clearTimeout(timer); timer = setTimeout(refresh, 600); };
    page.addEventListener('input', onEdit);
    page.addEventListener('change', onEdit);
    // ⌘/Ctrl+S — ⑤ 지시문은 조각이 5개라 폼이 길다. 저장하려고 머리까지 스크롤해 올라가지 않아도 되게.
    page.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
            ev.preventDefault();
            void save();
        }
    });
    dirtyGuard = isDirty;
    showStep('basic');
    markClean(); // 방금 그린 값이 곧 저장된 값이다(조각이 실리면 paint 가 기준선을 한 번 더 잡는다)
    void refresh(); // 페이지를 열면 바로 지금 상태를 보여준다(버튼을 누르게 하지 않는다)
    return page;
}
// ── 실행 잡 ────────────────────────────────────────────────────────────────
//  #1618 에서 단계 공용 카드(context-stage-job.ts)로 갈아탔다. 종전 전용 구현과 달라진 것 셋:
//   · 만들면 **켠다**(종전엔 꺼진 채 만들고 다시 켜기를 눌러야 했다 — 화면이 경고하는 '멈춤' 상태를 손수 만드는 셈).
//   · 주기·끄기·지금 실행이 카드 안에 있다(종전엔 "[AI 능력 ▸ 자동화]에서 조정합니다"라고 내보냈다).
//   · 의뢰자 부재를 잡아 그 자리에서 지정하게 한다(없으면 매 주기 조용히 error 였다).
async function runJobCard(rerender) {
    return stageJobCard({
        stage: '증류',
        actions: ['distill_sources_headless', 'distill_sources'],
        create: {
            id: 'distill-sources-headless', label: '자료 증류 (수집된 원본→지식, 헤드리스)',
            action: 'distill_sources_headless', params: {}, interval_sec: 1800,
            note: '켜진 증류기별로 미증류 자료 배치를 헤드리스 AI 세션에 접수. 증류기가 없으면 전 자료 공통 기본 증류.',
        },
        missingLine: '증류 자동 실행이 없습니다 — 증류기를 만들어도 자료가 지식이 되지 않습니다.',
        // 분류와 같은 이유 — 구 세션주입판(distill_sources)은 params.session 이 있어야 돈다.
        unrunnable: (j) => (j.action === 'distill_sources' && !(j.params && j.params.session))
            ? '지금 등록된 증류 잡은 상시 세션이 있어야 도는 구 방식인데, 그 세션이 지정돼 있지 않습니다 — 이대로 켜면 매번 실패합니다.'
            : null,
        usesAi: true,
    }, rerender);
}
