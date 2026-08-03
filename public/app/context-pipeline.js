// context-pipeline.ts — 맥락 파이프라인 개요(#1419 T6). [맥락 관리] 탭의 첫 화면.
//
//  이 화면이 답하는 질문 하나: **"지금 어디가 막혔나."**
//  그래서 4단계를 가로로 나란히 놓는다 — 파이프라인의 요점은 단계 '내부'가 아니라 단계 '사이'이고,
//  그건 같은 시점의 숫자를 나란히 봐야만 보인다. 세로로 쌓으면 비교가 안 된다(스크롤이 비교를 끊는다).
//
//  설계 결정 셋:
//   · **막힘을 먼저 말한다** — 카드 안 첫 줄이 상태 문장이다. 숫자만 보여 주면 "3,412 가 많은 건가?"를
//     사람이 판단해야 하는데, 그 판단이 이 제품에서 가장 자주 실패한 지점이다(#1289: 슬랙 10,900건 중
//     증류 13건이었는데 화면상으론 아무 이상이 없어 보였다).
//   · **'안 돌고 있음'을 최우선 경보로** — 설정만 하고 크론을 안 켜서 아무것도 안 도는 것이 대표 실패 모드다.
//     잔량이 0이어도 잡이 꺼져 있으면 그건 '깨끗한' 게 아니라 '멈춘' 것이다.
//   · **각 카드가 곧 그 단계의 입구** — 클릭하면 그 단계 설정으로 간다(별도 내비 학습 불요).
import { api, el, fmtNum, relTime } from './core.js';
/** 잡이 꺼져 있으면 무엇보다 먼저 말한다 — 잔량 0 이 '깨끗함'이 아니라 '멈춤'일 수 있다. */
function jobHealth(job, whatRuns) {
    if (!job)
        return { level: 'off', line: `${whatRuns} 자동 실행이 등록돼 있지 않습니다 — 설정해도 아무것도 돌지 않습니다.` };
    if (!job.any_enabled)
        return { level: 'off', line: `${whatRuns} 자동 실행이 꺼져 있습니다 — 켜야 돕니다.` };
    return null;
}
function collectHealth(s) {
    if (!s.configured)
        return { level: 'off', line: '수집기가 없습니다. 슬랙·노션 같은 곳을 연결해 자료를 모으세요.' };
    if (!s.enabled)
        return { level: 'off', line: `수집기 ${s.configured}개가 모두 꺼져 있습니다.` };
    const j = jobHealth(s.job, '수집');
    if (j)
        return j;
    if (!s.recent_24h)
        return { level: 'note', line: '최근 24시간 동안 새로 들어온 자료가 없습니다.' };
    return { level: 'ok', line: `최근 24시간에 ${fmtNum(s.recent_24h)}건이 새로 들어왔습니다.` };
}
function distillHealth(s) {
    const j = jobHealth(s.job, '증류');
    // 잡이 꺼졌는데 밀린 자료가 있으면 그게 가장 급한 사실이다 — 문구에 함께 싣는다.
    if (j)
        return { ...j, line: j.line + (s.backlog ? ` 밀린 자료 ${fmtNum(s.backlog)}건이 그대로 쌓입니다.` : '') };
    if (!s.configured)
        return { level: 'note', line: '증류기가 없어 전 자료 공통 기본 증류로 돕니다. 채널별로 기준을 나누려면 만드세요.' };
    if (!s.enabled)
        return { level: 'off', line: `증류기 ${s.configured}개가 모두 꺼져 있습니다.` };
    if (s.backlog > 1000)
        return { level: 'warn', line: `지식이 안 된 자료가 ${fmtNum(s.backlog)}건 밀려 있습니다.` };
    if (s.backlog)
        return { level: 'note', line: `지식이 안 된 자료 ${fmtNum(s.backlog)}건이 대기 중입니다.` };
    return { level: 'ok', line: '밀린 자료가 없습니다.' };
}
function classifyHealth(s) {
    if (s.no_definition) {
        // 정의 없는 분류축이 있으면 그게 먼저다 — 분류기는 정의를 기준으로 판단하므로 정의가 비면 판단 근거가 없다.
        return { level: 'warn', line: `분류축 ${s.no_definition}개에 정의가 비어 있습니다 — 정의가 없으면 분류 기준도 없습니다.` };
    }
    const j = jobHealth(s.job, '분류');
    if (j)
        return { ...j, line: j.line + (s.backlog ? ` 미분류 지식 ${fmtNum(s.backlog)}건이 그대로 남습니다.` : '') };
    const rest = s.backlog ? ` 미분류 지식 ${fmtNum(s.backlog)}건 대기 중입니다.` : '';
    // ⚠ 분류기 대수를 여기서 말해야 한다 — 이 두 줄이 없어서 개요는 "분류 1시간마다 · 23분 전"이라 하고
    //  분류 탭은 "아직 분류기가 없습니다"라고 했다. 둘 다 사실인데 합쳐 읽으면 모순이다(어니스트 실박스 지적).
    //  payload 는 configured·enabled 를 처음부터 담고 있었는데 이 함수만 안 읽었다(manageHealth 는 읽는다).
    if (!s.configured) {
        // 분류기 0개는 '고장'이 아니다 — 전역 기본 분류로 떨어지는 게 설계된 폴백이다(무중단 계약 ④).
        //  그래서 warn 이 아니라 note 로, 그리고 **지금 무엇이 돌고 있는지**를 문장으로 말한다.
        return { level: 'note',
            line: `분류기가 없어 전역 기본 분류가 돌고 있습니다 — 전 미분류 지식을 한 기준으로 봅니다.` +
                ` 팀·도메인별로 기준을 나누려면 분류기를 만드세요.${rest}` };
    }
    if (!s.enabled) {
        // 만들어 두고 다 꺼 둔 상태 — 잡은 도는데 아무 분류기도 대상을 안 집는다(가장 헷갈리는 상태다).
        return { level: 'off',
            line: `분류기 ${s.configured}개가 모두 꺼져 있습니다 — 잡은 돌지만 아무 분류기도 대상을 집지 않습니다.${rest}` };
    }
    if (s.uncovered)
        return { level: 'warn', line: `어느 분류기도 안 집는 지식이 ${fmtNum(s.uncovered)}건 있습니다 — 이대로면 영영 분류되지 않습니다.` };
    if (s.backlog)
        return { level: 'note', line: `미분류 지식 ${fmtNum(s.backlog)}건이 대기 중입니다.` };
    return { level: 'ok', line: '미분류 지식이 없습니다.' };
}
function manageHealth(s) {
    if (!s.configured)
        return { level: 'note', line: '관리기가 없습니다. 분류 어긋남·낡은 지식을 자동으로 찾게 하세요.' };
    if (!s.enabled)
        return { level: 'off', line: `관리기 ${s.configured}개가 모두 꺼져 있습니다.` };
    const j = jobHealth(s.job, '관리');
    if (j)
        return j;
    if (s.open.high)
        return { level: 'warn', line: `확인이 필요한 발견 ${fmtNum(s.open.high)}건(중요)이 있습니다.` };
    if (s.open.total)
        return { level: 'note', line: `확인이 필요한 발견 ${fmtNum(s.open.total)}건이 있습니다.` };
    return { level: 'ok', line: '처리할 발견이 없습니다.' };
}
/** 상태 점 — 채운 색 필을 쓰지 않는다(DS: 채운 컬러 상태 필 금지 → 점+라벨). */
function dot(level) {
    const cls = level === 'warn' ? 'ctxp-dot ctxp-dot-warn'
        : level === 'off' ? 'ctxp-dot ctxp-dot-off'
            : level === 'note' ? 'ctxp-dot ctxp-dot-note' : 'ctxp-dot ctxp-dot-ok';
    return el('span', { class: cls, 'aria-hidden': 'true' });
}
const LEVEL_TEXT = { ok: '정상', note: '참고', warn: '주의', off: '멈춤' };
/** 단계 카드 하나. 숫자 두 개(산출·잔량)와 상태 한 줄, 그리고 그 단계로 가는 입구. */
function stageCard(o) {
    const card = el('a', {
        class: `ctxp-stage ctxp-${o.health.level}`, href: o.goto,
        'aria-label': `${o.title} — ${LEVEL_TEXT[o.health.level]}. ${o.health.line}`,
    });
    card.append(el('div', { class: 'ctxp-stage-head' }, el('span', { class: 'ctxp-step', text: String(o.step) }), el('span', { class: 'ctxp-stage-title', text: o.title }), el('span', { class: 'ctxp-state' }, dot(o.health.level), el('span', { text: LEVEL_TEXT[o.health.level] }))), el('p', { class: 'ctxp-what', text: o.what }), el('p', { class: 'ctxp-line', text: o.health.line }), el('div', { class: 'ctxp-metrics' }, ...o.metrics.map((m) => el('div', { class: 'ctxp-metric', ...(m.hint ? { title: m.hint } : {}) }, el('span', { class: 'ctxp-metric-v', text: m.value }), el('span', { class: 'ctxp-metric-l', text: m.label })))), el('span', { class: 'ctxp-goto', text: o.gotoLabel + ' →' }));
    return card;
}
/** 단계 사이의 흐름 표시 — 무엇이 넘어가는지(자료 → 지식 → 분류된 지식). */
function flow(label) {
    return el('div', { class: 'ctxp-flow', 'aria-hidden': 'true' }, el('span', { class: 'ctxp-flow-line' }), el('span', { class: 'ctxp-flow-label', text: label }), el('span', { class: 'ctxp-flow-line' }));
}
/** 파이프라인 개요를 host 에 그린다. onGoto = 스테이지 클릭 시 서브탭 전환(라우터 대신 인메모리 전환). */
export async function renderPipeline(host) {
    host.replaceChildren(el('div', { class: 'ctxp-loading' }, el('p', { class: 'admin-hint', text: '파이프라인 현황을 불러오는 중…' })));
    let d;
    try {
        d = await api('/api/ui/org/pipeline');
    }
    catch (e) {
        host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '현황을 불러오지 못했습니다 — ' + e.message })));
        return;
    }
    const s = d.stages;
    const wrap = el('div', { class: 'ctxp' });
    // 상단 한 줄 요약 — 막힌 단계가 있으면 그것부터 말한다.
    const healths = [
        ['수집', collectHealth(s.collect)], ['증류', distillHealth(s.distill)],
        ['분류', classifyHealth(s.classify)], ['관리', manageHealth(s.manage)],
    ];
    const blocked = healths.filter(([, h]) => h.level === 'off' || h.level === 'warn');
    const summary = el('div', { class: 'ctxp-summary' + (blocked.length ? ' ctxp-summary-warn' : '') });
    if (blocked.length) {
        summary.append(el('span', { class: 'ctxp-summary-badge', text: `${blocked.length}단계 확인 필요` }), el('span', { class: 'ctxp-summary-txt', text: blocked.map(([n]) => n).join(' · ') + ' 단계가 멈췄거나 밀려 있습니다. 아래에서 해당 단계를 열어 보세요.' }));
    }
    else {
        summary.append(el('span', { class: 'ctxp-summary-badge ctxp-summary-ok', text: '정상 흐름' }), el('span', { class: 'ctxp-summary-txt', text: '네 단계가 모두 돌고 있습니다.' }));
    }
    wrap.append(summary);
    const track = el('div', { class: 'ctxp-track' });
    track.append(stageCard({
        step: 1, title: '수집', what: '외부 도구의 내용을 우리 저장소로 가져옵니다.',
        health: healths[0][1],
        metrics: [
            { label: '수집기', value: `${s.collect.enabled}/${s.collect.configured}`, hint: '켜진 것 / 전체' },
            { label: '모인 자료', value: fmtNum(s.collect.output) },
            { label: '최근 24시간', value: fmtNum(s.collect.recent_24h) },
        ],
        goto: '#/context/collect', gotoLabel: '수집기 관리',
    }), flow('자료'), stageCard({
        step: 2, title: '증류', what: '모인 원본에서 남길 가치가 있는 것만 지식으로 만듭니다.',
        health: healths[1][1],
        metrics: [
            { label: '증류기', value: `${s.distill.enabled}/${s.distill.configured}`, hint: '켜진 것 / 전체' },
            { label: '만들어진 지식', value: fmtNum(s.distill.output) },
            { label: '밀린 자료', value: fmtNum(s.distill.backlog), hint: '아직 지식이 되지 않은 자료' },
        ],
        goto: '#/context/distill', gotoLabel: '증류기 관리',
    }), flow('지식'), stageCard({
        step: 3, title: '분류', what: '지식이 어느 갈래에 속하는지 정합니다.',
        health: healths[2][1],
        metrics: [
            { label: '분류기', value: `${s.classify.enabled}/${s.classify.configured}`, hint: '켜진 것 / 전체' },
            { label: '분류축', value: fmtNum(s.classify.categories) },
            { label: '미분류', value: fmtNum(s.classify.backlog) },
        ],
        goto: '#/context/classify', gotoLabel: '분류 관리',
    }), flow('분류된 지식'), stageCard({
        step: 4, title: '관리', what: '쌓인 지식이 낡거나 어긋나지 않게 계속 살핍니다.',
        health: healths[3][1],
        metrics: [
            { label: '관리기', value: `${s.manage.enabled}/${s.manage.configured}`, hint: '켜진 것 / 전체' },
            { label: '확인 필요', value: fmtNum(s.manage.open.total) },
            { label: '중요', value: fmtNum(s.manage.open.high) },
        ],
        goto: '#/context/manage', gotoLabel: '관리기 · 발견',
    }));
    wrap.append(track);
    // 검토 대기 — 파이프라인 밖 큐지만 흐름을 막으므로 함께 보여 준다(클릭하면 그 큐로).
    const g = d.gates ?? {};
    if (g.knowledge_pending || g.classification_proposed) {
        const gates = el('div', { class: 'ctxp-gates' }, el('span', { class: 'ctxp-gates-title', text: '사람 확인 대기' }));
        if (g.knowledge_pending) {
            gates.append(el('a', { class: 'ctxp-gate', href: '#/knowledge/review' }, el('span', { class: 'ctxp-gate-n', text: fmtNum(g.knowledge_pending) }), el('span', { class: 'ctxp-gate-l', text: '지식 검토 대기' })));
        }
        if (g.classification_proposed) {
            gates.append(el('a', { class: 'ctxp-gate', href: '#/knowledge/classifications' }, el('span', { class: 'ctxp-gate-n', text: fmtNum(g.classification_proposed) }), el('span', { class: 'ctxp-gate-l', text: '분류 검토 대기' })));
        }
        wrap.append(gates);
    }
    // 자동 실행 상태 — 네 잡을 한 줄로. '무엇이 언제 도는가'가 파이프라인 신뢰의 근거다.
    const jobs = el('div', { class: 'ctxp-jobs' }, el('span', { class: 'ctxp-jobs-title', text: '자동 실행' }));
    for (const [name, st] of [['수집', s.collect], ['증류', s.distill], ['분류', s.classify], ['관리', s.manage]]) {
        const j = st.job;
        jobs.append(el('span', { class: 'ctxp-job' }, dot(!j || !j.any_enabled ? 'off' : 'ok'), el('span', { class: 'ctxp-job-n', text: name }), el('span', { class: 'ctxp-job-v', text: !j ? '미등록'
                : !j.any_enabled ? '꺼짐'
                    : (j.interval_sec >= 3600 ? `${Math.round(j.interval_sec / 3600)}시간마다` : `${Math.max(1, Math.round(j.interval_sec / 60))}분마다`)
                        + (j.last_run_at ? ` · ${relTime(j.last_run_at)}` : ' · 미실행') })));
    }
    jobs.append(el('a', { class: 'ctxp-jobs-link', href: '#/system/automation', text: '주기 설정 →' }));
    wrap.append(jobs);
    host.replaceChildren(wrap);
}
