// liv.ts — 리브 화면(#1631). 홈이 대시보드 대신 이걸 띄우는 경우가 있다.
//
//  ── 이 화면이 무엇인가 ──
//  워크스페이스가 아직 굴러가지 않을 때, "지금 손볼 것"을 카드로 보여주고 **리브에게 맡기면 실제로 해 주는** 화면.
//  위쪽이 액션카드, 아래쪽이 리브와의 대화(터미널)다. 카드의 [리브에게 맡기기]는 그 세션에 프롬프트를 주입한다 —
//  그래서 **사람이 터미널을 읽을 줄 몰라도 일이 진행된다**. 이게 v0 가 웹터미널을 재사용하면서도 성립하는 이유다.
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇을 띄울지(mode)도, 무엇이 덜 됐는지(카드)도 서버가 이미 정해서 준다(GET /api/ui/me/liv).
//  화면이 자기 판정을 가지면 리브와 다른 답을 하고, 그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다.
import { api, appUrl, el } from './core.js';
// 사람이 홈을 명시적으로 고른 값. **서버 판정을 이긴다** — 내가 껐는데 자꾸 뜨면 고장으로 읽힌다.
const LIV_CHOICE_KEY = 'liv_home_choice_v1';
// 세션당 1회만 판정한다. 홈은 자주 드나드는 화면이라 매번 왕복하면 대시보드가 느려진다.
const LIV_GATE_CACHE = 'liv_home_mode_v1';
export function livChoice() {
    const v = localStorage.getItem(LIV_CHOICE_KEY);
    return v === 'liv' || v === 'dashboard' ? v : null;
}
export function livSetChoice(v) {
    if (v)
        localStorage.setItem(LIV_CHOICE_KEY, v);
    else
        localStorage.removeItem(LIV_CHOICE_KEY);
    sessionStorage.removeItem(LIV_GATE_CACHE); // 선택이 바뀌면 캐시된 판정은 낡았다
}
export async function livStatus() {
    const c = livChoice();
    return await api('/api/ui/me/liv' + (c ? '?choice=' + encodeURIComponent(c) : ''));
}
/**
 * 홈(#/dashboard) 진입 게이트 — 리브를 띄울지 대시보드를 띄울지.
 *
 * **대시보드를 고른 사람은 왕복조차 하지 않는다**(그게 대부분의 기존 사용자다). 그 외에는 세션당 1회만
 * 서버에 묻고 sessionStorage 에 담아 둔다 — 새로고침이나 탭 이동으로 홈에 다시 와도 즉시 그려진다.
 *
 * 실패하면 **대시보드로 떨어진다**. 리브가 안 뜨는 것보다 홈이 안 열리는 게 훨씬 나쁘다.
 */
export async function livHomeGate() {
    if (livChoice() === 'dashboard')
        return 'dashboard';
    const cached = sessionStorage.getItem(LIV_GATE_CACHE);
    if (cached === 'liv' || cached === 'dashboard' || cached === 'login')
        return cached;
    try {
        const st = await livStatus();
        sessionStorage.setItem(LIV_GATE_CACHE, st.mode);
        return st.mode;
    }
    catch {
        return 'dashboard';
    }
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
/** 리브가 처음 열릴 때 스스로 시작하는 말. 사람이 아무것도 안 눌러도 진단이 돈다(대표 결정). */
const LIV_OPENING = 'liv 스킬로 지금 내 워크스페이스를 점검하고, 제일 급한 것부터 무엇을 하면 되는지 알려줘. 내가 맡기면 네가 직접 해 줘.';
// ── 화면 ─────────────────────────────────────────────────────────────────────
export async function renderLiv(view) {
    if (!view)
        return; // 라우터가 넘기는 $view() 는 셸이 아직 없으면 null 이다(대시보드와 같은 계약)
    view.replaceChildren();
    document.body.dataset.route = 'liv';
    const head = el('div', { class: 'liv-head' }, el('div', { class: 'liv-title' }, el('span', { class: 'liv-dot' }), el('b', { text: '리브' })), el('div', { class: 'liv-head-acts' }, el('button', {
        class: 'btn btn-sm', type: 'button', text: '대시보드로 →',
        title: '앞으로 홈은 대시보드로 엽니다. 리브는 언제든 다시 열 수 있습니다.',
        onclick: () => { livSetChoice('dashboard'); location.hash = '#/dashboard'; },
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
}
function skeletonLine() { return el('div', { class: 'liv-card liv-card-skel' }); }
async function fillLivCards(host) {
    let st;
    try {
        st = await livStatus();
    }
    catch {
        host.replaceChildren(el('div', { class: 'liv-note', text: '지금 상태를 읽지 못했습니다. 아래에서 리브에게 직접 물어보셔도 됩니다.' }));
        return;
    }
    if (!st.findings.length) {
        host.replaceChildren(el('div', { class: 'liv-note' }, el('b', { text: '지금 손볼 것은 없습니다.' }), el('span', { text: ' 아래에서 리브에게 무엇이든 물어보세요.' })));
        return;
    }
    host.replaceChildren(el('div', { class: 'liv-cards-title', text: `지금 손볼 것 ${st.total}` }), ...st.findings.map((f) => livCard(f, host)));
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
