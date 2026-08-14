// liv.ts — 리브 화면(#1631). **독립 전체화면**(#/liv) — 상단 내비·푸터를 걷고 화면 전부를 쓴다.
//
//  ── 이 화면이 무엇인가 ──
//  "지금 손볼 것"을 왼쪽 레일에 카드로 보여주고, 오른쪽에서 **리브에게 맡기면 실제로 해 주는** 화면.
//  카드의 [리브에게 맡기기]는 그 세션에 프롬프트를 주입한다 — 그래서 **사람이 터미널을 읽을 줄 몰라도
//  일이 진행된다**. 이게 v0 가 웹터미널을 재사용하면서도 성립하는 이유다.
//
//  ── 왜 홈이 아니라 별도 페이지인가(대표 결정) ──
//  처음엔 상태를 보고 **홈을 리브로 갈아치웠다**. 그건 과했다 — 사람이 기대한 화면이 아닌 게 뜨는 것은
//  그 자체로 고장으로 읽힌다. 이제 상단 내비의 [리브] 버튼으로 들어오는 자기 페이지이고, 홈은 늘 홈이다.
//  대신 여기서는 **크롬을 걷는다**: 대화가 주인공인 화면이라 탭·푸터가 높이를 먹으면 정작 말하기가 불편하다.
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇이 덜 됐는지(카드)는 서버가 이미 정해서 준다(GET /api/ui/me/liv).
//  화면이 자기 판정을 가지면 리브와 다른 답을 하고, 그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다.
import { api, appUrl, el } from './core.js';
export async function livStatus() {
    return await api('/api/ui/me/liv');
}
// ── 세션 부팅 ────────────────────────────────────────────────────────────────
// 리브 세션은 **한 사람당 하나**다. 이미 있으면 그걸 쓰고, 없을 때만 만든다 — 홈에 들어올 때마다 세션이
//  늘어나면 그건 청소해야 할 쓰레기가 된다. 표식은 라벨(@box_label)이다.
const LIV_LABEL = '리브';
/**
 * 쓸 수 있는 리브 세션을 고른다 — **살아 있는 것만**.
 *
 * ⚠ 죽은 리브 세션은 되살리지 않고 **버린다**. 라이블리는 죽은 세션을 열 때 claude 대화를 `--resume` 으로
 *  이어붙이는데(#1059 E lazy resume), 그러면 리브가 **그 대화가 시작된 시점의 스킬·맥락에 영원히 묶인다**
 *  (실측: liv 스킬을 켜기 전에 시작된 대화가 계속 되살아나 리브가 "liv 스킬이 없다"고 답했다).
 *  기획의 불변식이 정확히 이걸 막으라고 말한다 — **리브의 기억은 대화가 아니라 서버에 있고, 세션은 교체
 *  가능하다.** 그러니 이어붙일 이유가 없다. 대화를 잇는 건 일반 작업 세션의 미덕이지 리브의 미덕이 아니다.
 */
async function findLivSession() {
    const r = await api('/api/ui/terminal/sessions');
    const mine = (r.sessions ?? []).filter((s) => s.label === LIV_LABEL && s.owned !== false);
    const live = mine.find((s) => s.agentState !== 'offline');
    if (live)
        return live;
    // 죽은 잔재는 지워 둔다(reclaim 없이 = desired-state 까지 완전 삭제). 안 지우면 다음에 또 되살아난다.
    for (const dead of mine) {
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(dead.id), { method: 'DELETE' }).catch(() => { });
    }
    return null;
}
async function createLivSession() {
    const r = await api('/api/ui/terminal/sessions', {
        method: 'POST',
        body: JSON.stringify({ label: LIV_LABEL, rootKey: 'personal', subpath: 'liv', harness: 'claude', autoApprove: true }),
    });
    return r.session;
}
/** 리브에게 말을 건다 — 그 세션에 프롬프트를 넣고 제출한다(사람이 터미널에 타이핑한 것과 같다). */
export async function livSendPrompt(sessionId, text) {
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) });
}
/**
 * 리브가 처음 열릴 때 스스로 시작하는 말 — **인사 한 마디.**
 *
 * ⚠ 예전엔 여기에 지시문("liv 스킬로 점검하고 급한 것부터 알려줘")을 넣었는데, 두 가지가 틀렸다:
 *  ① **사람이 안 쓴 지시가 자기 이름으로 화면에 찍힌다.** 열자마자 내가 안 한 말이 내 말로 올라와 있는 건
 *     그 자체로 이상하다(대표 지적).
 *  ② **정체성을 프롬프트에 실으면 재량이 된다.** 스킬은 모델이 부를지 말지 정하는 자산이라, 안 부르면 그
 *     세션은 그냥 클로드다(실측: 리브가 "liv 스킬이 없다"고 답했다). 그래서 정체성·모드·첫 수는
 *     **SessionStart 훅(liv-session-boot)** 이 무조건 주입한다 — 여기 남는 건 말을 트는 인사뿐이다.
 */
const LIV_OPENING = '안녕하세요.';
// ── 화면 ─────────────────────────────────────────────────────────────────────
export async function renderLiv(view) {
    if (!view)
        return; // 라우터가 넘기는 $view() 는 셸이 아직 없으면 null 이다(대시보드와 같은 계약)
    view.replaceChildren();
    document.body.dataset.route = 'liv';
    // 상단 내비를 걷었으니 **나가는 길이 화면 안에 있어야 한다** — 없으면 사람이 뒤로가기를 찾는다.
    //  하나만 둔다: 어디로 가는지가 분명한 [← 라이블리]. 탭을 여기 다시 그리면 크롬을 걷은 뜻이 없어진다.
    const head = el('div', { class: 'liv-head' }, el('div', { class: 'liv-title' }, el('span', { class: 'liv-dot' }), el('b', { text: '리브' })), el('div', { class: 'liv-head-acts' }, el('a', {
        class: 'btn btn-sm btn-ghost', href: '#/dashboard', text: '← 라이블리',
        title: '라이블리 홈으로 돌아갑니다. 리브는 상단 [리브] 버튼으로 다시 열 수 있습니다.',
    })));
    // 카드는 **왼쪽 레일**(이슈 목록 문법), 대화가 남은 폭·높이를 전부 먹는다. 카드가 위에 있으면 대화가
    //  절반으로 눌려 정작 리브와 말하기가 불편해진다 — 이 화면의 주인공은 대화다.
    const cards = el('div', { class: 'liv-cards' }, skeletonLine(), skeletonLine());
    const chatWrap = el('div', { class: 'liv-chat' }, el('div', { class: 'liv-chat-body', id: 'liv-chat-body' }, el('div', { class: 'liv-chat-boot', text: '세션을 준비하고 있습니다…' })));
    view.append(el('div', { class: 'liv-wrap' }, head, el('div', { class: 'liv-body' }, el('aside', { class: 'liv-rail' }, cards), chatWrap)));
    // 카드와 세션은 **독립적으로** 로드한다. 세션이 못 떠도 무엇이 문제인지는 보여야 하고,
    //  카드 조회가 느려도 대화는 먼저 시작될 수 있다(위젯 독립 실패 원칙과 같은 결).
    void fillLivCards(cards);
    void bootLivSession(chatWrap.querySelector('.liv-chat-body'), cards);
    // 리브가 대화 중에 자격을 요청하면(me_liv_ask_secret) 화면이 그걸 알아야 입력칸이 뜬다.
    //  터미널은 iframe 이라 출력에서 신호를 읽을 수 없다 — 서버 상태를 가볍게 되묻는 쪽이 견고하다.
    //  ⚠ 사람이 타이핑 중인 입력칸을 갈아치우지 않는다(fillLivCards 가 그 경우 그냥 넘어간다).
    const poll = setInterval(() => {
        if (document.body.dataset.route !== 'liv') {
            clearInterval(poll);
            return;
        } // 라우트를 떠나면 끝
        void fillLivCards(cards);
    }, 6000);
}
function skeletonLine() { return el('div', { class: 'liv-card liv-card-skel' }); }
async function fillLivCards(host) {
    // 사람이 자격을 입력하는 중이면 손대지 않는다 — 다시 그리면 타이핑하던 값이 사라진다.
    const typing = host.querySelector('.liv-ask-input');
    if (typing && (typing.value !== '' || document.activeElement === typing))
        return;
    let st;
    try {
        st = await livStatus();
    }
    catch {
        host.replaceChildren(el('div', { class: 'liv-note', text: '지금 상태를 읽지 못했습니다. 옆에서 리브에게 직접 물어보셔도 됩니다.' }));
        return;
    }
    // 리브가 기다리는 것은 **항상 맨 위**다 — 이게 떠 있으면 리브는 그걸 기다리느라 멈춰 있다.
    const ask = st.secretAsk
        ? (st.secretAsk.kind === 'choice' ? livChoiceCard(st.secretAsk, host)
            : st.secretAsk.kind === 'upload' ? livUploadCard(st.secretAsk, host)
                : livSecretCard(st.secretAsk, host))
        : null;
    if (!st.findings.length) {
        host.replaceChildren(...(ask ? [ask] : []), el('div', { class: 'liv-note' }, el('b', { text: '지금 손볼 것은 없습니다.' }), el('span', { text: ' 옆에서 리브에게 무엇이든 물어보세요.' })));
        return;
    }
    host.replaceChildren(...(ask ? [ask] : []), el('div', { class: 'liv-cards-title', text: `지금 손볼 것 ${st.total}` }), ...st.findings.map((f) => livCard(f, host)));
}
/**
 * 객관식 질문 — **사람은 고르기만 한다.**
 *
 * 실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("어디에 쌓고 계셨나요?"). 없는 말을 지어내야 하니
 * 어렵고, 답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다 — 쉽고, **답이 저절로
 * 구조화된다**. 그래서 이 카드가 곧 통계 수집기다.
 */
function livChoiceCard(ask, host) {
    const picked = new Set();
    const opts = el('div', { class: 'liv-ask-opts' });
    const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '이걸로' });
    // 복수 선택이면 고른 게 있어야 보낼 수 있다. 단일 선택은 누르는 즉시 보낸다(한 번 덜 누르게).
    const sync = () => { send.disabled = picked.size === 0 && !otherIn.value.trim(); };
    const submit = async () => {
        send.disabled = true;
        const was = send.textContent;
        send.textContent = '보내는 중…';
        try {
            const r = await api('/api/ui/me/liv-answer', {
                method: 'POST',
                body: JSON.stringify({ choices: [...picked], other: otherIn.value.trim() || undefined }),
            });
            const said = [...(r.labels ?? []), ...(r.other ? [r.other] : [])].join(', ');
            // ⚠ 비우고 포커스를 뗀다 — 안 그러면 '타이핑 중이면 갱신하지 않는다' 가드에 걸려
            //  답을 보냈는데도 질문 카드가 그대로 남는다(실측).
            otherIn.value = '';
            otherIn.blur();
            livToast('고르신 걸 전했습니다.');
            // 사람이 다시 타이핑하지 않아도 대화가 이어지게 — 무엇을 골랐는지 리브에게 그대로 말해 준다.
            if (livSessionId && said)
                await livSendPrompt(livSessionId, said).catch(() => { });
            setTimeout(() => void fillLivCards(host), 600);
        }
        catch (e) {
            send.disabled = false;
            send.textContent = was ?? '이걸로';
            livToast(String(e?.message ?? e));
        }
    };
    for (const o of ask.options ?? []) {
        const b = el('button', { class: 'btn btn-sm liv-opt', type: 'button' }, el('b', { text: o.label }), o.hint ? el('span', { class: 'liv-opt-hint', text: o.hint }) : null);
        b.onclick = () => {
            if (ask.multi) {
                if (picked.has(o.id)) {
                    picked.delete(o.id);
                    b.classList.remove('liv-opt-on');
                }
                else {
                    picked.add(o.id);
                    b.classList.add('liv-opt-on');
                }
                sync();
            }
            else {
                picked.clear();
                picked.add(o.id);
                void submit();
            }
        };
        opts.append(b);
    }
    const otherIn = el('input', {
        class: 'liv-ask-input', type: 'text', autocomplete: 'off',
        placeholder: '목록에 없으면 여기 적어 주세요', 'aria-label': '그 외',
    });
    otherIn.oninput = sync;
    otherIn.onkeydown = (ev) => { if (ev.key === 'Enter') {
        ev.preventDefault();
        void submit();
    } };
    send.onclick = () => void submit();
    sync();
    return el('div', { class: 'liv-card liv-ask' }, el('div', { class: 'liv-ask-head' }, el('b', { text: ask.question ?? '' })), ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null, opts, 
    // '그 외'는 탈출구다 — 여기 적히는 것이 곧 다음에 만들 커넥터 후보라 버리지 않고 쌓는다.
    ask.allow_other ? el('div', { class: 'liv-ask-row' }, otherIn) : null, (ask.multi || ask.allow_other) ? el('div', { class: 'liv-ask-row' }, send) : null, ask.multi ? el('div', { class: 'liv-ask-note', text: '해당하는 걸 모두 고르셔도 됩니다.' }) : null);
}
/**
 * 파일 올리기 — **로컬 폴더를 뒤지는 대신 끌어다 놓는다**(대표 판단).
 *
 * 글자 파일만 받는다. PDF·이미지는 브라우저에서 글자를 못 뽑아 **올린 척만 하고 빈 자료가 쌓이므로**,
 * 되는 척하지 않고 그 자리에서 거른다.
 */
function livUploadCard(ask, host) {
    const TEXT_RE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|rtf|html?|tex|org)$/i;
    const msg = el('div', { class: 'liv-ask-msg' });
    const input = el('input', { class: 'liv-upload-in', type: 'file', multiple: 'multiple' });
    input.onchange = async () => {
        const files = [...(input.files ?? [])];
        if (!files.length)
            return;
        const ok = files.filter((f) => TEXT_RE.test(f.name));
        const skipped = files.filter((f) => !TEXT_RE.test(f.name));
        input.disabled = true;
        let saved = 0;
        const failed = [];
        for (const f of ok) {
            try {
                const body_md = await f.text();
                if (!body_md.trim()) {
                    failed.push(`${f.name}(비어 있음)`);
                    continue;
                }
                await api('/api/ui/sources', { method: 'POST', body: JSON.stringify({
                        kind: 'upload', title: f.name, body_md,
                        occurred_at: new Date(f.lastModified).toISOString(),
                    }) });
                saved++;
            }
            catch (e) {
                failed.push(`${f.name}(${e?.message ?? e})`);
            }
        }
        input.disabled = false;
        input.value = '';
        const parts = [`${saved}개 올렸습니다`];
        if (skipped.length)
            parts.push(`${skipped.length}개는 글자 파일이 아니라 건너뛰었습니다`);
        if (failed.length)
            parts.push(`${failed.length}개 실패`);
        msg.replaceChildren(el('span', { class: failed.length ? 'liv-ask-err' : 'liv-ask-ok', text: parts.join(' · ') }));
        if (saved && livSessionId) {
            await livSendPrompt(livSessionId, `파일 ${saved}개 올렸어요: ${ok.slice(0, 10).map((f) => f.name).join(', ')}`).catch(() => { });
            setTimeout(() => void fillLivCards(host), 1200);
        }
    };
    return el('div', { class: 'liv-card liv-ask' }, el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label ?? '파일 올리기' })), ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null, el('div', { class: 'liv-ask-row' }, input), el('div', { class: 'liv-ask-note', text: ask.accept_hint || '글자로 된 파일만 됩니다 — 메모·문서(.txt·.md)·표(.csv) 등. PDF·이미지는 아직 안 됩니다.' }), msg);
}
/**
 * 자격 입력칸 — **이 화면에서 끝내기 위한 장치**.
 *
 * 실측 2회 모두 리브는 시크릿을 채팅에 붙여넣으라고 했고(대화 기록에 남는다), 화면으로 돌릴 때는
 * 없는 메뉴 경로를 지어냈다. 안내를 다듬어 고칠 문제가 아니라 **여기서 받을 자리가 없던 것**이 원인이다.
 *
 * 계약: 넣을 자리는 서버가 저장해 둔 요청에서만 온다(브라우저가 대상을 못 바꾼다). 값은 전송 즉시
 * 암호화 저장되고 화면에서도 지운다. 저장되면 리브에게 **사람 대신 한 마디 건네** 대화가 이어진다.
 */
function livSecretCard(ask, host) {
    const input = el('input', {
        class: 'liv-ask-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
        placeholder: ask.hint || '여기에 붙여넣어 주세요', 'aria-label': ask.label,
    });
    const msg = el('div', { class: 'liv-ask-msg' });
    const save = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '저장' });
    const submit = async () => {
        const value = input.value;
        if (!value.trim()) {
            input.focus();
            return;
        }
        save.disabled = true;
        input.disabled = true;
        save.textContent = '저장 중…';
        try {
            await api('/api/ui/me/liv-secret', { method: 'POST', body: JSON.stringify({ value }) });
            input.value = ''; // 화면에서도 즉시 지운다
            // ⚠ 확인은 **카드 밖**(토스트)에 띄운다 — 카드 안에 쓰면 바로 뒤의 갱신이 카드째 지워서
            //  사람은 아무 일도 안 일어난 것처럼 본다(실측: 저장은 됐는데 화면엔 흔적이 없었다).
            livToast('저장했습니다. 리브가 이어서 확인합니다.');
            // 사람이 다시 타이핑하지 않아도 대화가 이어지게 한마디 건넨다 — 값은 절대 안 보낸다.
            if (livSessionId)
                await livSendPrompt(livSessionId, '자격 저장했어요. 확인해 주세요.').catch(() => { });
            setTimeout(() => void fillLivCards(host), 600);
        }
        catch (e) {
            save.disabled = false;
            input.disabled = false;
            save.textContent = '저장';
            msg.replaceChildren(el('span', { class: 'liv-ask-err', text: String(e?.message ?? e) }));
            input.focus();
        }
    };
    save.onclick = () => void submit();
    input.onkeydown = (ev) => { if (ev.key === 'Enter') {
        ev.preventDefault();
        void submit();
    } };
    return el('div', { class: 'liv-card liv-ask' }, el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label })), ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null, el('div', { class: 'liv-ask-row' }, input, save), el('div', { class: 'liv-ask-note', text: '입력하신 값은 잠긴 보관함으로 바로 들어가고, 대화 기록에는 남지 않습니다.' }), msg);
}
function livCard(f, host) {
    const acts = el('div', { class: 'liv-card-acts' });
    if (f.prompt) {
        acts.append(el('button', {
            class: 'btn btn-sm btn-primary', type: 'button', text: '리브에게 맡기기',
            onclick: (ev) => void livDelegate(ev.currentTarget, f),
        }));
    }
    if (f.href)
        acts.append(el('a', { class: 'btn btn-sm', href: f.href, text: f.prompt ? '직접 보기' : '보러 가기' }));
    // '나중에' 는 이 화면에서 그 카드를 접어 둘 뿐, 서버에 거절로 남기지 않는다 — 거절 기록은 리브가
    //  대화에서 사람 뜻을 확인하고 남길 일이다(화면 버튼 한 번으로 영구 침묵시키면 그게 더 위험하다).
    acts.append(el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', text: '나중에',
        onclick: (ev) => { ev.currentTarget.closest('.liv-card')?.remove(); if (!host.querySelector('.liv-card'))
            void fillLivCards(host); },
    }));
    return el('div', { class: 'liv-card liv-card-' + f.severity }, el('div', { class: 'liv-card-title' }, el('span', { class: 'liv-card-mark', text: f.severity === 'p0' ? '!' : '·' }), el('b', { text: f.title })), f.detail ? el('div', { class: 'liv-card-detail', text: f.detail }) : null, acts);
}
// 카드에서 맡긴 일은 **대화로 이어진다** — 무엇을 시켰는지 사람이 보고, 리브의 진행도 같은 자리에서 본다.
async function livDelegate(btn, f) {
    const id = livSessionId;
    if (!id) {
        livToast('리브 세션이 아직 준비되지 않았습니다. 잠시 후 다시 눌러 주세요.');
        return;
    }
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = '맡기는 중…';
    try {
        await livSendPrompt(id, f.prompt);
        btn.textContent = '맡겼습니다';
        btn.closest('.liv-card')?.classList.add('liv-card-done');
    }
    catch (e) {
        btn.disabled = false;
        btn.textContent = was ?? '리브에게 맡기기';
        livToast(String(e?.message ?? e));
    }
}
function livToast(msg) {
    const t = el('div', { class: 'liv-toast', text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
}
// 지금 열려 있는 리브 세션 id — 카드 버튼이 이걸 쓴다(세션이 뜨기 전엔 null).
let livSessionId = null;
async function bootLivSession(host, cards) {
    const bootAt = Date.now() - 15000; // 시계 오차·왕복 지연 여유
    let s = null;
    let fresh = false;
    try {
        s = await findLivSession();
        if (!s) {
            s = await createLivSession();
            fresh = true;
        }
    }
    catch (e) {
        host.replaceChildren(el('div', { class: 'liv-chat-err' }, el('div', { text: '리브 세션을 열지 못했습니다.' }), el('div', { class: 'liv-chat-err-detail', text: String(e?.message ?? e) })));
        void cards; // 카드는 그대로 둔다 — 세션이 없어도 무엇이 문제인지는 보인다
        return;
    }
    livSessionId = s.id;
    // 터미널은 iframe 으로 붙인다(#745 그리드 뷰어와 같은 문법) — 터미널 화면 코드를 두 벌 만들지 않는다.
    // #1169 appUrl — 프리뷰(/preview/<id>/…) 아래에서 루트 절대경로를 쓰면 오리진 루트(라이브)로 새어 프리뷰가 풀린다.
    const url = appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(LIV_LABEL)
        + (s.node?.id ? '&node=' + encodeURIComponent(s.node.id) : '');
    host.replaceChildren(el('iframe', { class: 'liv-term', src: url, title: '리브와의 대화' }));
    // **열면 바로 진단**(대표 결정) — 방금 만든 세션에만 건다. 이미 있던 세션에 또 걸면 하던 말을 끊는다.
    if (fresh)
        void sendWhenReady(s.id, LIV_OPENING, bootAt);
}
/**
 * 첫 말을 **넣고, 도달했는지 확인하고, 안 됐으면 다시** 넣는다.
 *
 * ⚠ 왜 상태를 안 믿나(실측 2번): ① 고정 지연(4초)은 하네스가 아직 못 받는 시점에 넣어 **조용히 유실**됐다.
 *  ② 그래서 `agentState` 가 idle/waiting 이 되길 기다리게 고쳤더니 **5분이 지나도 `busy` 였다** — 화면은
 *  빈 입력창으로 사람을 기다리는데 서버 판정은 busy 다. 그 값은 "입력을 받을 준비"의 지표가 아니다.
 *  → 판정 대신 **결과**를 본다: 넣고 나서 그 세션의 프롬프트 이력이 늘었으면 도달한 것이다.
 *
 * 못 넣어도 화면은 살아 있다 — 사람이 직접 물으면 된다(조용히 포기하되 막지는 않는다).
 */
async function sendWhenReady(sessionId, text, since) {
    // ⚠ `/prompts` 는 **세션이 아니라 그 작업 폴더의 모든 대화**를 모은다(cwd 기준 트랜스크립트 스캔).
    //  리브 세션은 폴더가 고정(`~/box/<나>/liv`)이라 **옛 대화의 질문이 그대로 잡힌다** — 그걸 '이미 대화가
    //  있다'로 읽으면 새 세션에 여는 말을 영영 안 넣는다(실측: pane 은 비었는데 이력은 3건이었다).
    //  그래서 **이 세션이 뜬 뒤의 것만** 센다.
    const promptCount = async () => {
        const p = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/prompts')
            .catch(() => null);
        if (!p || !Array.isArray(p.prompts))
            return null;
        return p.prompts.filter((x) => {
            const t = Date.parse(String(x?.ts ?? ''));
            return Number.isFinite(t) && t >= since;
        }).length;
    };
    for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 5000 : 10000)); // 하네스 기동 여유
        if (livSessionId !== sessionId)
            return; // 그 사이 화면을 떠났거나 다른 세션으로 바뀌었다
        // 이미 대화가 있으면 끼어들지 않는다 — 하던 말을 끊지 않는 게 규칙이다(사람이 먼저 칠 수도 있다).
        const before = await promptCount();
        if (before === null)
            continue; // 조회 실패 — 다음 주기에 다시
        if (before > 0)
            return;
        await livSendPrompt(sessionId, text).catch(() => { });
        // 도달 확인은 **폴링**이다. 트랜스크립트 반영이 늦는데 한 번만 보고 재주입하면 같은 말이 여러 번
        //  들어간다(실측: 8초 뒤 한 번만 보고 재시도했더니 3회 주입됐다). 도달하면 그 즉시 끝낸다.
        for (let k = 0; k < 10; k++) {
            await new Promise((r) => setTimeout(r, 2500));
            if (livSessionId !== sessionId)
                return;
            const after = await promptCount();
            if (after !== null && after > 0)
                return;
        }
    }
}
