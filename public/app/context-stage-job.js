// context-stage-job.ts — 파이프라인 단계의 '언제 도나' 카드. 네 단계(수집·증류·분류·관리) 공용.
//
//  왜 한 곳으로 모았나(#1618): 단계마다 실행 제어의 수준이 제각각이었다 —
//   · 수집: 수집기를 켜면 잡이 자동 생성·활성(syncCollectorJob). 사람이 잡을 의식할 일이 없다.
//   · 증류: 화면에 '만들기' 버튼은 있었지만 **꺼진 채로** 만들고, 다시 '켜기'를 눌러야 했다.
//   · 분류: 만들기 버튼이 없고 "[설정 ▸ 자동화]에서 만드세요"라는 **문장만** 있었다.
//   · 관리: 카드 자체가 없었다 — 관리기를 켜면 초록 점이 켜지고, 그게 곧 '돈다'로 읽혔다.
//  마지막 것이 실제로 우리를 물었다: dev 게이트웨이가 관리기 3개를 켠 채 run_managers 잡 없이 8일을 보냈고,
//  화면은 그동안 초록 점 3개를 보여줬다. 그 셋은 결정적 SQL 판정이라 **비용 0으로 돌 수 있는 것**이었다.
//
//  그래서 이 카드가 지는 계약 셋:
//   ① **'설정했다'와 '돈다'를 절대 같은 신호로 만들지 않는다.** 잡이 없거나 꺼져 있으면 그 사실이 첫 줄이다.
//   ② **여기서 끝난다.** 만들기·켜고끄기·주기·의뢰자·지금 실행이 전부 이 카드 안에 있다. 종전엔 이 중
//      절반이 [설정 ▸ 자동화]에 있어 단계를 보다가 다른 탭으로 나가야 했다 — 나가면 앞뒤(무엇이 밀렸나)를
//      못 보고, 돌아올 때 자기가 뭘 하려 했는지 잃는다.
//   ③ **만들면 켠다.** 꺼진 채 만드는 건 ①이 경고하는 바로 그 상태를 손수 만드는 일이다. 끄고 싶으면
//      같은 카드의 토글이 한 번에 끈다(만들 때 두 번 누르게 하는 것보다 끌 때 한 번 누르게 하는 게 낫다).
//
//  ⚠ 권한: cron 은 GET·POST 둘 다 admin scope(capabilities/cron.ts) — 게이트웨이 권한으로 도는 액션이라
//   블래스트 반경이 멤버머신 훅과 다르다. 비-admin 은 상태 조회부터 막히므로 카드가 그 사실을 정직하게
//   말하고 끝낸다(빈 카드·거짓 초록 금지). 단계 설정 자체는 비-admin 도 만질 수 있는 것이 있어(증류기는
//   scope=memory) '기준은 세우는데 돌리지는 못하는' 비대칭이 남는다 — 서버 스코프 설계 몫으로 분리했다.
import { api, cardHead, el, relTime, state, toast } from './core.js';
/** 주기 선택지 — 초 단위. 분 단위 임의 입력 대신 고른다(60초 미만은 서버가 거부하므로 애초에 못 고르게). */
const INTERVALS = [
    [600, '10분마다'], [1800, '30분마다'], [3600, '1시간마다'],
    [10800, '3시간마다'], [21600, '6시간마다'], [86400, '하루에 한 번'],
];
function intervalText(sec) {
    const hit = INTERVALS.find(([s]) => s === sec);
    if (hit)
        return hit[1];
    return sec >= 3600 ? `${Math.round(sec / 3600)}시간마다` : `${Math.max(1, Math.round(sec / 60))}분마다`;
}
/** 주격 조사 — 단계 이름이 받침으로 끝나면 '이', 아니면 '가'. ('수집가 돌지 않습니다'가 사람으로 읽혔다.) */
function subj(word) {
    const last = word.charCodeAt(word.length - 1);
    const hangul = last >= 0xac00 && last <= 0xd7a3;
    return word + (hangul && (last - 0xac00) % 28 !== 0 ? '이' : '가');
}
/** 카드 안에서 잡을 부분수정한다 — 서버가 COALESCE 패치라 보낸 키만 바뀐다(cron-store.ts updateCronJob). */
async function patch(id, body) {
    await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id, ...body }) });
}
/**
 * 단계의 '언제 도나' 카드를 그린다. rerender = 변경 후 그 단계 화면을 다시 그리는 콜백
 *  (잡 상태가 단계 요약·잔량 문구를 바꾸므로 카드만 갱신하면 화면이 서로 다른 말을 한다).
 */
export async function stageJobCard(spec, rerender) {
    const card = el('div', { class: 'card', style: 'margin-top:14px' }, cardHead('언제 도나'));
    let jobs = [];
    try {
        const r = await api('/api/ui/cron');
        jobs = (r && r.jobs) || [];
    }
    catch {
        // 비-admin — 상태를 볼 수 없다. 조용히 비우면 '없음'으로 오독되므로 이유를 말한다.
        card.append(el('p', { class: 'admin-hint', text: `${spec.stage} 자동 실행 상태는 관리자만 볼 수 있습니다. 돌고 있는지 확인이 필요하면 관리자에게 문의하세요.` }));
        return card;
    }
    // 같은 단계에 구·신 액션이 함께 있으면 **켜진 것**이 현행이다(둘 다 꺼져 있으면 권장 액션 순).
    //  matchId 가 있으면 같은 action 을 쓰는 남의 계보를 먼저 걷어낸다(수집의 sync-<system> — 위 주석).
    const found = spec.actions.map((a) => jobs.filter((j) => j.action === a)).flat()
        .filter((j) => !spec.matchId || spec.matchId(String(j.id)));
    const job = found.find((j) => j.enabled === true) ?? found[0];
    // ── 잡이 없다 ──────────────────────────────────────────────────────────
    if (!job) {
        card.append(el('p', { class: 'admin-hint' }, el('b', { text: spec.missingLine })));
        if (spec.managedElsewhere) {
            card.append(el('p', { class: 'admin-hint', text: spec.managedElsewhere }));
            return card;
        }
        if (!spec.create)
            return card;
        const c = spec.create;
        const mk = el('button', { class: 'btn btn-primary', text: `${spec.stage} 자동 실행 켜기 (${intervalText(c.interval_sec)})` });
        mk.addEventListener('click', async () => {
            mk.disabled = true;
            try {
                await patch(c.id, { label: c.label, action: c.action, params: c.params ?? {}, interval_sec: c.interval_sec, enabled: true, note: c.note });
                toast(`${spec.stage} 자동 실행을 켰습니다`);
                rerender();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                mk.disabled = false;
            }
        });
        card.append(el('div', { style: 'margin-top:10px' }, mk));
        if (spec.usesAi) {
            card.append(el('p', { class: 'admin-hint', style: 'margin-top:8px',
                text: '켜면 주기마다 AI 가 실제로 돌아 비용이 발생합니다. 아래에서 주기를 늦추거나 언제든 끌 수 있습니다.' }));
        }
        return card;
    }
    // ── 잡이 있다 — 상태 한 줄 ──────────────────────────────────────────────
    const meta = el('div', { class: 'mini-meta' }, el('span', { class: 'pill' + (job.enabled ? ' pill-ok' : ''), text: job.enabled ? '켜짐' : '꺼짐' }), el('span', { class: 'pill', text: job.id }), el('span', { class: 'pill', text: intervalText(Number(job.interval_sec || 0)) }), el('span', { text: job.last_run_at ? `  마지막 실행 ${relTime(job.last_run_at)} · ${job.last_status || ''}` : '  아직 실행 전' }));
    card.append(meta);
    // 읽기 전용 단계(수집) — 상태만 말하고, 조작은 잡의 주인(수집기)에게 맡긴다.
    if (spec.readOnly) {
        const others = found.length - 1;
        if (others > 0)
            card.append(el('p', { class: 'admin-hint', text: `자동 수집 잡 ${found.length}개 중 켜진 것 ${found.filter((j) => j.enabled).length}개 — 위 목록의 수집기와 1:1 입니다.` }));
        if (spec.managedElsewhere)
            card.append(el('p', { class: 'admin-hint', text: spec.managedElsewhere }));
        return card;
    }
    // 꺼져 있으면 그게 첫 메시지다 — 잔량이 0이어도 '깨끗함'이 아니라 '멈춤'이다.
    if (!job.enabled) {
        const on = el('button', { class: 'btn btn-sm btn-primary', text: `${spec.stage} 자동 실행 켜기` });
        on.addEventListener('click', async () => {
            on.disabled = true;
            try {
                await patch(job.id, { enabled: true });
                toast(`${spec.stage} 자동 실행을 켰습니다`);
                rerender();
            }
            catch (e) {
                toast(e.message, true);
                on.disabled = false;
            }
        });
        card.append(el('p', { class: 'admin-hint' }, el('b', { text: `꺼져 있어 ${subj(spec.stage)} 돌지 않습니다. ` }), on));
    }
    // ── 조절 — 주기 · 끄기 · 지금 실행. 여기서 끝나야 [설정 ▸ 자동화]로 나갈 일이 없다. ──
    const controls = el('div', { class: 'mini-meta', style: 'margin-top:10px;gap:10px;flex-wrap:wrap' });
    const sel = el('select', { class: 'input input-sm', 'aria-label': `${spec.stage} 실행 주기` });
    const cur = Number(job.interval_sec || 0);
    const opts = INTERVALS.some(([s]) => s === cur) ? INTERVALS : [...INTERVALS, [cur, intervalText(cur)]];
    for (const [s, label] of opts.sort((a, b) => a[0] - b[0])) {
        sel.append(el('option', { value: String(s), text: label, ...(s === cur ? { selected: 'selected' } : {}) }));
    }
    sel.addEventListener('change', async () => {
        const next = Number(sel.value);
        sel.disabled = true;
        try {
            await patch(job.id, { interval_sec: next });
            toast(`주기를 ${intervalText(next)}로 바꿨습니다`);
            rerender();
        }
        catch (e) {
            toast(e.message, true);
            sel.disabled = false;
            sel.value = String(cur);
        }
    });
    controls.append(el('span', { class: 'admin-hint', text: '주기' }), sel);
    // '지금 실행' — 설정 직후 "이게 진짜 도나"를 그 자리에서 확인하는 길. 이게 없으면 다음 주기까지
    //  사람이 화면을 믿고 기다려야 하는데, 그 믿음이 틀렸던 게 이 프로젝트의 출발점이다.
    const run = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 한 번 실행' });
    run.addEventListener('click', async () => {
        run.disabled = true;
        run.textContent = '실행 중…';
        try {
            const r = await api(`/api/ui/cron/${encodeURIComponent(job.id)}/run`, { method: 'POST' });
            const st = (r && (r.status || r.last_status)) || 'ok';
            toast(st === 'error' ? `실행했지만 오류가 났습니다 — 아래 마지막 실행 상태를 보세요` : `${spec.stage}를 한 번 실행했습니다`, st === 'error');
            rerender();
        }
        catch (e) {
            toast('실행 실패 — ' + e.message, true);
            run.disabled = false;
            run.textContent = '지금 한 번 실행';
        }
    });
    controls.append(run);
    if (job.enabled) {
        const off = el('button', { class: 'btn btn-ghost btn-sm', text: '자동 실행 끄기' });
        off.addEventListener('click', async () => {
            off.disabled = true;
            try {
                await patch(job.id, { enabled: false });
                toast(`${spec.stage} 자동 실행을 껐습니다`);
                rerender();
            }
            catch (e) {
                toast(e.message, true);
                off.disabled = false;
            }
        });
        controls.append(off);
    }
    card.append(controls);
    // ── 의뢰자 — 헤드리스 단계의 숨은 전제. 없으면 매 주기 HEADLESS_REQUESTER_MISSING 으로 죽는데,
    //  종전엔 그 사실이 화면 어디에도 없어 '켜 뒀는데 아무 일도 안 일어난다'로만 보였다. 여기서 고치게 한다 —
    //  다른 탭으로 보내면 이 카드가 지는 계약 ②가 깨진다. 지정할 값은 지금 보고 있는 사람 자신이 정답인
    //  경우가 대부분이라(관리자가 자기 계정으로 돌린다) 한 번 누르면 끝나게 둔다.
    //  ⚠ 판정은 **그 잡의 action** 으로 한다(단계로 하면 안 된다). 의뢰자를 요구하는 건 헤드리스 접수 경로
    //   (_headless.ts headlessRequester)뿐이고, 같은 단계의 구 세션주입판(classify_knowledge·distill_sources)은
    //   params.session 으로 돌아 의뢰자가 아예 필요 없다. 단계로 판정했더니 정상 동작 중인 세션주입 잡
    //   (classify-unmapped-knowledge, last_status=ok)에 "실행이 매번 실패합니다"라는 거짓 경고가 붙었다.
    if (String(job.action || '').endsWith('_headless')) {
        const requester = (job.params && job.params.requester) || job.created_by || null;
        if (requester) {
            card.append(el('p', { class: 'admin-hint', style: 'margin-top:8px',
                text: `AI 실행은 ${requester} 의 계정으로 돌아갑니다(비용도 그 계정에 붙습니다).` }));
        }
        else {
            const meId = String((state.me && (state.me.userId || state.me.email)) || '');
            const line = el('p', { class: 'admin-hint', style: 'margin-top:8px' }, el('b', { text: '의뢰자가 없어 실행이 매번 실패합니다. ' }), el('span', { text: 'AI 를 어느 계정으로 돌릴지 정해야 합니다. ' }));
            if (meId) {
                const claim = el('button', { class: 'btn btn-sm', text: `${meId} 로 지정` });
                claim.addEventListener('click', async () => {
                    claim.disabled = true;
                    try {
                        await patch(job.id, { params: { ...(job.params || {}), requester: meId } });
                        toast(`의뢰자를 ${meId} 로 지정했습니다`);
                        rerender();
                    }
                    catch (e) {
                        toast(e.message, true);
                        claim.disabled = false;
                    }
                });
                line.append(claim);
            }
            card.append(line);
        }
    }
    return card;
}
