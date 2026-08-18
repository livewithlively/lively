// chat-view.ts — 대화창 **하나**(#1719). 리브(web/liv-chat.ts)와 세션 화면(web/session-chat.ts)이 같은 컴포넌트를 쓴다.
//
//  ── 왜 떼어냈나 ──
//  리브 대화창(#1631 v1)은 "터미널 대신 말풍선"을 이미 풀었다 — 일지 형태(사람 말은 제목처럼, AI 가 한 일은 세로 괘선에),
//  작업 슬립(무엇을 보냈고 무엇이 돌아왔는지 접힘), 조각 스트리밍, 읽고 있으면 잡아채지 않는 스크롤, IME 안전 Enter, Esc 멈춤.
//  세션 화면(라이브 Claude Code 세션)도 **같은 문법의 데이터**(assistant/user 메시지의 text·tool_use·tool_result 블록)라
//  같은 그림이 맞다. 두 벌을 두면 한쪽만 고쳐진다 — 그래서 그림·입력·스크롤은 여기 한 곳에, **어디서 읽고 어디로 보내나**만
//  호출자가 다르다(리브: me/liv/turn 파일 · 세션: 박스의 대화 파일 + 프롬프트 주입).
//
//  ── 이 파일이 아는 것 / 모르는 것 ──
//  안다: 이벤트 한 줄(claude stream-json / Claude Code 트랜스크립트 한 줄)을 받아 어느 턴의 어디에 무엇을 그릴지.
//  모른다: 그 줄이 어디서 오는지(파일·API), 언제 폴링하는지, 보내기가 무엇을 하는지 — 전부 opts 콜백.
//
//  ── 지키는 것(리브에서 물려받은 원칙, 그대로) ──
//  · 사람이 읽고 있으면 스크롤을 잡아채지 않는다(바닥에 붙어 있을 때만 따라간다 + 돌아가는 버튼).
//  · 한글 입력 중 Enter 는 전송이 아니다(isComposing — 레포 불변식).
//  · 실패를 조용히 삼키지 않는다 — 그 자리에 말한다.
//  · 원문(도구 입출력)은 버리지 않고 접는다 — 펼치면 그게 '진짜 했다'의 증거.
//  · innerHTML 을 쓰지 않는다(모델 출력을 그린다 — 마크다운도 textContent 기반 렌더러 lib/markdown.ts).
//  클래스 이름은 리브 시절의 `livc-*` 를 그대로 둔다(35-liv.css 가 이미 그 이름으로 그린다 — 접두어를 바꾸면 얻는 게 없다).
import { el, renderMarkdown, toast } from './core.js';
// ── 조각 렌더 ────────────────────────────────────────────────────────────────────────────
/** 작업 슬립 — 이 화면의 시그니처. 상태는 색이 아니라 표식과 글자로(●하는 중 / ✓했음 / ✕실패). */
function actionCard(lab, input) {
    return el('div', { class: 'livc-slip' }, el('div', { class: 'livc-slip-head' }, el('span', { class: 'livc-slip-mark livc-slip-run', 'aria-hidden': 'true', text: '●' }), el('span', { class: 'livc-slip-name', text: lab.label }), lab.detail ? el('span', { class: 'livc-slip-detail', title: lab.detail, text: lab.detail }) : null, el('details', { class: 'livc-slip-raw' }, el('summary', { text: '자세히' }), rawPart('보낸 것', pretty(input))), el('span', { class: 'livc-slip-state', text: '하는 중' })));
}
function pretty(v) {
    if (typeof v === 'string')
        return v;
    try {
        return JSON.stringify(v ?? {}, null, 2);
    }
    catch {
        return String(v);
    }
}
function rawPart(cap, body) {
    const s = String(body ?? '');
    return el('div', { class: 'livc-raw-part' }, el('div', { class: 'livc-raw-cap', text: cap + (s.length > 4000 ? ` · 앞 4,000자` : '') }), el('pre', { text: s.slice(0, 4000) }));
}
function finishCard(card, output, isError) {
    const mark = card.querySelector('.livc-slip-mark');
    if (mark) {
        mark.classList.remove('livc-slip-run');
        mark.textContent = isError ? '✕' : '✓';
    }
    const state = card.querySelector('.livc-slip-state');
    if (state)
        state.textContent = isError ? '실패' : '했음';
    card.classList.add(isError ? 'livc-slip-err' : 'livc-slip-done');
    card.querySelector('.livc-slip-raw')?.append(rawPart(isError ? '무엇이 잘못됐는지' : '돌아온 것', output));
}
/** 끝난 세션의 기록을 되그릴 때 — 결과가 창 밖(이전 창)에 있어 못 받은 카드는 '하는 중'으로 남기지 않는다. */
function settleCard(card) {
    const mark = card.querySelector('.livc-slip-mark');
    if (mark) {
        mark.classList.remove('livc-slip-run');
        mark.textContent = '·';
    }
    const state = card.querySelector('.livc-slip-state');
    if (state)
        state.textContent = '';
}
/** AI 가 한 말 한 덩이 — 마크다운(textContent 기반, XSS 없음). 코드 블록엔 복사 버튼을 단다. */
function said(text) {
    const box = el('div', { class: 'livc-said' }, renderMarkdown(text));
    decorateCode(box);
    return box;
}
function decorateCode(box) {
    box.querySelectorAll('pre').forEach((pre) => {
        if (pre.parentElement?.classList.contains('livc-code'))
            return;
        const wrap = el('div', { class: 'livc-code' });
        pre.replaceWith(wrap);
        const btn = el('button', {
            class: 'livc-copy', type: 'button', text: '복사', 'aria-label': '코드 복사',
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(pre.textContent || '');
                    btn.textContent = '복사됨';
                    setTimeout(() => { btn.textContent = '복사'; }, 1200);
                }
                catch {
                    toast('복사하지 못했습니다 — 직접 선택해 복사해 주세요.');
                }
            },
        });
        wrap.append(pre, btn);
    });
}
/** 생각(thinking) 블록 — 접힌 카드. Claude Code 의 "✻ Thinking…" 자리. 글자 수만 머리에 보이고 본문은 펼쳐야 보인다. */
function thinkCard(text) {
    const n = text.length;
    return el('details', { class: 'livc-think' }, el('summary', {}, el('span', { class: 'livc-think-k', text: '생각' }), el('span', { class: 'livc-think-n', text: n >= 1000 ? `${(n / 1000).toFixed(1)}천자` : `${n}자` })), el('div', { class: 'livc-think-body', text }));
}
const fmtClock = (iso) => {
    if (!iso)
        return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime()))
        return '';
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return `${s}초`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}분 ${s % 60}초`;
    return `${Math.floor(m / 60)}시간 ${m % 60}분`;
};
// ── 컴포넌트 ─────────────────────────────────────────────────────────────────────────────
export function createChatView(host, opts) {
    const list = el('div', { class: 'livc-list' });
    const input = el('textarea', { class: 'livc-input', rows: '1', placeholder: opts.placeholder, 'aria-label': opts.placeholder });
    const send = el('button', { class: 'btn btn-sm livc-send', type: 'submit', text: '보내기' });
    const stop = el('button', { class: 'btn btn-sm livc-send livc-send-stop', type: 'button', text: '멈춤', hidden: true, title: 'Esc' });
    const note = el('div', { class: 'livc-note' });
    const form = el('form', { class: 'livc-compose' }, input, stop, send);
    const footSlot = el('div', { class: 'livc-foot' }, form);
    // 스크롤 — 사람이 읽고 있으면 잡아채지 않는다.
    const NEAR_BOTTOM = 48;
    let stick = true;
    const jump = el('button', {
        class: 'livc-jump', type: 'button', hidden: true, text: '최신 대화로 ↓',
        onclick: () => { stick = true; list.scrollTop = list.scrollHeight; jump.hidden = true; },
    });
    list.addEventListener('scroll', () => {
        stick = list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM;
        if (stick)
            jump.hidden = true;
    });
    const scroll = () => {
        if (stick) {
            list.scrollTop = list.scrollHeight;
            jump.hidden = true;
            return;
        }
        jump.hidden = false;
    };
    const root = el('div', { class: 'livc-wrap' }, el('div', { class: 'livc-scroller' }, list, jump), opts.askHost ?? undefined, note, footSlot);
    host.replaceChildren(root);
    if (opts.opening)
        list.append(opts.opening);
    if (opts.footer) {
        form.hidden = true;
        footSlot.append(opts.footer);
    }
    const turnsArr = [];
    let runningTurn = null;
    let ticker = null;
    let isBusy = false;
    const busy = (on) => {
        isBusy = on;
        const lock = on && !opts.sendWhileBusy;
        input.disabled = lock;
        input.placeholder = lock ? (opts.busyPlaceholder || opts.placeholder) : opts.placeholder;
        stop.hidden = !(on && opts.onStop);
        // 리브(보내기 잠금)에서는 멈춤이 보내기 자리를 차지한다 — 버튼이 둘이면 잠긴 칸 옆에 죽은 버튼이 하나 남는다.
        send.hidden = lock && !!opts.onStop;
    };
    const tickLive = () => {
        if (!runningTurn || !runningTurn.live)
            return;
        const t = runningTurn;
        const busyCard = Array.from(t.work.querySelectorAll('.livc-slip-run')).pop()?.closest('.livc-slip');
        const doing = busyCard ? (busyCard.querySelector('.livc-slip-name')?.textContent || '') : '';
        // 사람 말 없이 중간부터 읽은 턴(창의 첫 턴)은 시작 시각을 모른다 — 경과 시간을 지어내지 않는다.
        const dur = t.ask ? fmtDur(Date.now() - t.startedAt) : '작업 중';
        t.live.textContent = `${doing ? doing + ' · ' : ''}${dur}${opts.onStop ? ' · Esc 로 멈춤' : ''}`;
    };
    const running = (t) => {
        if (runningTurn && runningTurn !== t) {
            runningTurn.work.classList.remove('livc-work-busy');
            runningTurn.live?.remove();
            runningTurn.live = null;
        }
        runningTurn = t;
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        if (!t)
            return;
        t.work.classList.add('livc-work-busy');
        const live = t.live ?? (t.live = el('div', { class: 'livc-live', 'aria-live': 'polite' }));
        t.work.append(live); // 항상 괘선의 맨 아래(새 내용이 오면 다시 내려간다 — event() 참고)
        tickLive();
        ticker = window.setInterval(tickLive, 1000);
    };
    function turn(userText, o) {
        const work = el('div', { class: 'livc-work' }, el('div', { class: 'livc-who', text: opts.who.ai }));
        let ask = null;
        if (userText !== null) {
            ask = el('div', { class: 'livc-ask' }, el('div', { class: 'livc-who' }, el('span', { text: opts.who.me }), o?.ts ? el('time', { class: 'livc-ts', datetime: o.ts, title: new Date(o.ts).toLocaleString(), text: fmtClock(o.ts) }) : null), el('div', { class: 'livc-ask-text', text: userText }));
        }
        const root0 = el('section', { class: 'livc-turn' + (ask ? '' : ' livc-turn-cont') }, ask, work);
        // 경과 시간의 기준 — 사람 말의 시각이 있으면 그것(화면을 나중에 열어도 '이 턴이 얼마나 됐나'가 맞다), 없으면 지금.
        const t0 = o?.ts ? Date.parse(o.ts) : NaN;
        const t = { root: root0, work, ask, text: userText ?? '', ts: o?.ts, r: { cards: new Map(), blocks: new Map(), msgId: null, streamed: new Set() }, live: null, startedAt: Number.isFinite(t0) ? t0 : Date.now() };
        if (o?.at === 'start') {
            list.prepend(root0);
            turnsArr.unshift(t);
        }
        else {
            list.append(root0);
            turnsArr.push(t);
        }
        return t;
    }
    function appendWork(t, node) {
        if (t.live && t.live.parentElement === t.work)
            t.work.insertBefore(node, t.live);
        else
            t.work.append(node);
    }
    function event(t, ev) {
        const r = t.r;
        let lastText;
        const content = ev?.message?.content;
        const isAssistant = ev?.type === 'assistant';
        const already = isAssistant && r.streamed.has(String(ev?.message?.id ?? ''));
        if (Array.isArray(content)) {
            for (const b of content) {
                if (!b)
                    continue;
                if (b.type === 'text' && isAssistant && String(b.text ?? '').trim()) {
                    lastText = String(b.text);
                    if (!already)
                        appendWork(t, said(lastText)); // 조각으로 이미 그렸으면 건너뛴다(같은 글이다)
                }
                else if (b.type === 'thinking' && isAssistant) {
                    if (opts.thinking === 'fold' && String(b.thinking ?? '').trim())
                        appendWork(t, thinkCard(String(b.thinking)));
                }
                else if (b.type === 'tool_use') {
                    const card = actionCard(opts.toolLabel(String(b.name ?? '도구'), b.input), b.input);
                    if (b.id)
                        r.cards.set(String(b.id), card);
                    appendWork(t, card);
                }
                else if (b.type === 'tool_result') {
                    const card = b.tool_use_id ? r.cards.get(String(b.tool_use_id)) : null;
                    const out = typeof b.content === 'string' ? b.content
                        : Array.isArray(b.content) ? b.content.map((c) => (c && c.type === 'text' ? String(c.text ?? '') : c && c.type === 'image' ? '[이미지]' : pretty(c))).join('\n')
                            : pretty(b.content ?? '');
                    if (card)
                        finishCard(card, out, !!b.is_error);
                }
            }
        }
        if (t === runningTurn && t.live)
            t.work.append(t.live);
        return { text: lastText };
    }
    function stream(t, ev) {
        const r = t.r;
        const e = ev?.event;
        if (!e)
            return;
        if (e.type === 'message_start') {
            r.msgId = String(e.message?.id ?? '');
            r.blocks.clear();
            return;
        }
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
            const el0 = el('div', { class: 'livc-said livc-said-live' });
            r.blocks.set(Number(e.index), { el: el0, buf: '' });
            appendWork(t, el0);
            return;
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            const b = r.blocks.get(Number(e.index));
            if (!b)
                return;
            b.buf += String(e.delta.text ?? '');
            b.el.textContent = b.buf;
            if (r.msgId)
                r.streamed.add(r.msgId);
            return;
        }
        if (e.type === 'content_block_stop') {
            const b = r.blocks.get(Number(e.index));
            if (!b)
                return;
            b.el.classList.remove('livc-said-live');
            if (b.buf.trim()) {
                b.el.replaceChildren(renderMarkdown(b.buf));
                decorateCode(b.el);
            }
            else
                b.el.remove();
            r.blocks.delete(Number(e.index));
        }
    }
    function settle(t, o) {
        for (const [i, b] of t.r.blocks) {
            b.el.classList.remove('livc-said-live');
            if (b.buf.trim()) {
                b.el.replaceChildren(renderMarkdown(b.buf));
                decorateCode(b.el);
            }
            else
                b.el.remove();
            t.r.blocks.delete(i);
        }
        t.work.querySelectorAll('.livc-slip-run').forEach((m) => { const c = m.closest('.livc-slip'); if (c)
            settleCard(c); });
        if (t === runningTurn)
            running(null);
        if (o?.interrupted)
            appendWork(t, el('div', { class: 'livc-mark', text: '중단함' }));
        if (o?.exit != null && o.exit !== 0)
            appendWork(t, el('div', { class: 'livc-err', text: '이번 요청은 끝까지 가지 못했습니다. 다시 말씀해 주시면 이어서 해 보겠습니다.' }));
        if (o?.durationMs && o.durationMs > 3000) {
            const w = t.work.querySelector(':scope > .livc-who');
            if (w && !w.querySelector('.livc-dur'))
                w.append(el('span', { class: 'livc-dur', text: fmtDur(o.durationMs) }));
        }
    }
    function divider(text, details, at) {
        const node = details
            ? el('details', { class: 'livc-divider' }, el('summary', { text }), el('div', { class: 'livc-divider-body', text: details }))
            : el('div', { class: 'livc-divider' }, el('span', { text }));
        if (at === 'start')
            list.prepend(node);
        else
            list.append(node);
    }
    const doStop = async () => {
        if (!opts.onStop)
            return;
        stop.disabled = true;
        try {
            await opts.onStop();
        }
        finally {
            stop.disabled = false;
        }
    };
    stop.addEventListener('click', () => { void doStop(); });
    const onEsc = (e) => {
        if (e.key !== 'Escape' || !isBusy || !opts.onStop)
            return;
        if (opts.escActive && !opts.escActive())
            return;
        if (!root.isConnected)
            return;
        e.preventDefault();
        void doStop();
    };
    document.addEventListener('keydown', onEsc);
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || input.disabled)
            return;
        input.value = '';
        input.style.height = '';
        void opts.onSend(text);
    });
    // 한글 입력 중의 Enter 는 조합 확정이지 전송이 아니다(isComposing). Shift+Enter 는 줄바꿈.
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey)
            return;
        if (e.isComposing || e.keyCode === 229)
            return;
        e.preventDefault();
        form.requestSubmit();
    });
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    });
    return {
        root, list, input, form, noteEl: note,
        turn, event, stream, settle, running, busy, scroll,
        scrollToBottom: () => { stick = true; list.scrollTop = list.scrollHeight; jump.hidden = true; },
        setNote: (text) => { note.textContent = text; },
        error: (t, text) => { const n = el('div', { class: 'livc-err', text }); if (t)
            appendWork(t, n);
        else
            list.append(n); scroll(); },
        divider,
        removeOpening: () => { list.querySelector('.livc-open')?.remove(); },
        setFooter: (f) => { footSlot.querySelectorAll(':scope > :not(form)').forEach((n) => n.remove()); if (f) {
            form.hidden = true;
            footSlot.append(f);
        }
        else
            form.hidden = false; },
        turns: () => turnsArr.slice(),
        prependKeepingView: (fn) => {
            const before = list.scrollHeight;
            const top = list.scrollTop;
            fn();
            list.scrollTop = top + (list.scrollHeight - before);
        },
        destroy: () => { document.removeEventListener('keydown', onEsc); if (ticker)
            clearInterval(ticker); },
    };
}
