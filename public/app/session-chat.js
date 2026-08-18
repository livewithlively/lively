// session-chat.ts — 세션 화면의 가운데(#1719): 라이브 AI 세션(또는 그 기록)을 **터미널 대신 대화창**으로.
//
//  ── 무엇 ──
//  공용 대화창(web/chat-view.ts — 리브와 같은 그림)에 **세션의 대화 파일**을 실어 준다.
//   · 읽기: 박스 세션은 GET terminal/sessions/:id/transcript(박스의 대화 파일을 창으로, 0.7초 폴링) · 노드 세션·기록만 남은 세션은 중앙 기록
//     (v6/sessions/:uuid/log). **둘 다 공통 ChatLine ndjson**(#1746 — 서버 하네스 어댑터가 claude·grok·agy 원문을 한 모양으로 번역, 이 파일은
//     하네스를 모른다). 창은 서버가 줄 경계로 맞춰 준다(X-Log-From/To 가 다음 경계). 못 읽는 하네스는 409 + 행의 chat.read=false → 터미널 안내.
//   · 보내기: POST terminal/sessions/:id/prompt(#1664 — 터미널에서 치는 것과 같은 주입). Claude Code 는 도는 중에 친
//     글을 **큐에 쌓아** 다음 턴으로 받으므로 도는 동안에도 보낼 수 있다(리브와 다른 점).
//   · 멈춤/승인: POST …/keys {action: interrupt|approve|deny} — 키는 서버 어댑터가 정한다. 못 누르는 하네스(chat.answer=false)엔 버튼을 안 둔다.
//   · 끝난 세션(중단됨·종료됨·기록만): 입력칸 대신 [이어서 대화하기] — 복원(restore)/이어받기(resume)로 새 라이브 세션을 만들어
//     그 화면으로 간다(같은 대화 uuid 를 잇는다).
//
//  ── Claude Code(데스크톱)와 맞추려 한 것 ──
//   턴 = 내 말 + 그 아래 AI 가 한 모든 것 / 도구 호출은 `읽기 src/x.ts` 식 이름+대상 한 줄, 펼치면 입출력 원문 / 생각은 접힌 카드 /
//   돌 때 경과 시간 줄 + Esc 로 멈춤 / 답을 읽고 있으면 스크롤을 뺏지 않음 / 확인(승인) 대기는 배너로 / 긴 기록은 꼬리부터,
//   위로 [이전 대화 불러오기] / 질문 목차 / 코드 복사 / 터미널은 **버리지 않고** 토글(승인 대화상자 등 터미널이 맞는 순간이 있다).
//
//  ── 안 하는 것 ──
//   대화 uuid 를 추측하지 않는다(서버 원칙) — 매핑이 없으면 '기록 아직 없음'으로 말하고 터미널을 권한다.
import { api, apiUrl, TOKEN_KEY, anchoredPopover, el, toast } from './core.js';
import { createChatView } from './chat-view.js';
import { toolLabel } from './session-tool-labels.js';
import { classifyToolUse } from './session-trail.js';
import { makeSplitter } from './v2/split.js';
const WINDOW = 1_500_000; // 첫 로드·[이전 불러오기] 한 번에 읽는 바이트(긴 세션은 30MB — 꼬리부터)
const POLL_RUN_MS = 700; // 도는 중(블록 단위로 즉시 쌓인다 — 이 값이 체감 지연)
const POLL_IDLE_MS = 3000; // 살아 있고 안 도는 중(다음 지시를 터미널에서 칠 수도 있다)
const POLL_LOG_MS = 8000; // 중앙 기록(턴 단위 — 자주 봐도 안 늘어난다)
const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|Caveat:)/;
const INTERRUPT_RE = /^\s*\[Request interrupted/;
const CONTINUED_RE = /^\s*This session is being continued/;
async function rawGet(path) {
    const headers = {};
    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok)
        headers.Authorization = 'Bearer ' + tok;
    const res = await fetch(apiUrl(path), { headers, credentials: 'same-origin' });
    const text = res.ok ? await res.text() : '';
    if (!res.ok) {
        let msg = '';
        try {
            msg = (await res.json())?.error || '';
        }
        catch { /* */ }
        const e = new Error(msg || `요청 실패 (${res.status})`);
        e.status = res.status;
        throw e;
    }
    const n = (h) => { const v = Number(res.headers.get(h)); return Number.isFinite(v) ? v : 0; };
    return { status: res.status, text, bytes: n('X-Log-Bytes'), from: n('X-Log-From'), to: n('X-Log-To') || (n('X-Log-From') + text.length), uuid: res.headers.get('X-Session-Uuid') || undefined, prev: res.headers.get('X-Prev-Session') || undefined };
}
const srcPath = (s, q) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    return s.kind === 'box'
        ? `/api/ui/terminal/sessions/${encodeURIComponent(s.id)}/transcript?${qs}`
        : `/api/ui/v6/sessions/${encodeURIComponent(s.sid)}/log?node=${encodeURIComponent(s.node)}&fmt=chat&${qs}`; // fmt=chat: 공통 ChatLine(원본 바이트 아님)
};
// ── 마운트 ────────────────────────────────────────────────────────────────────────────────
// opts.firstPrompt — 홈 입력창(#1719 v2/quick-session)이 방금 연 세션의 첫 지시. 서버가 하네스 입력창이 뜬 뒤 실제로 넣으므로
//  여기서는 **낙관적으로 그 턴을 먼저 그리고**(보낸 것과 같은 모양) 대화 파일에 나타나면 그 턴을 재사용한다(pendingSent 규약).
// opts.onPickProject — 상단바 [프로젝트 연결]/[▾] 를 눌렀을 때 검색 드롭다운을 여는 콜백(#1749, v2/main.ts 가 준다).
//  붙이기·떼기의 실행·갱신은 그쪽 몫이고, 여기는 바뀐 target 을 update() 로 받아 라벨만 되그린다.
export function mountSessionChat(host, first, opts) {
    let target = first;
    const isBox = first.live; // 라이브 행(박스) — 죽었어도(restorable) 박스다
    const dead = () => !target.live || !target.alive || !!target.raw?.restorable;
    const canType = () => !dead();
    const caps = () => (target.raw?.chat && typeof target.raw.chat === 'object') ? { read: target.raw.chat.read !== false, answer: target.raw.chat.answer !== false } : { read: true, answer: true }; // 서버 harness-io 능력(행의 chat) — 없으면(구 서버) 둘 다 있는 것으로
    const canKeys = () => canType() && !target.node && caps().answer;
    // 헤더 — 제목 · 상태 · 프로젝트 · 하네스 · [목차] [터미널] [새 탭] ————
    const dot = el('span', { class: 'v2-dot', 'aria-hidden': 'true' });
    const stateEl = el('span', { class: 'sc-state' });
    const titleEl = el('b', { class: 'sc-title', text: target.label });
    const idxBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '목차', title: '질문 목차', onclick: () => openIndex() });
    const termBtn = el('button', { class: 'btn-text sc-act', type: 'button', text: '터미널', title: '터미널로 보기(승인 대화상자 등은 터미널이 맞을 때가 있어요)', onclick: () => toggleTerminal() });
    // 프로젝트 소속(#1749) — 붙었으면 프로젝트 링크 + [▾](바꾸기), 아니면 [프로젝트 연결] 버튼(검색 드롭다운). 내 세션에서만 바꿀 수 있다.
    //  update() 가 되그린다(소속은 화면이 열린 뒤에도 바뀐다).
    const projEl = el('span', { class: 'sc-proj' });
    function paintProject() {
        const canPick = !!opts.onPickProject && target.owned;
        if (target.projectId) {
            projEl.replaceChildren(el('a', { href: '#/p/' + target.projectId, text: target.projectName }), ...(canPick ? [el('button', { class: 'btn-text sc-proj-btn', type: 'button', text: '▾', title: '프로젝트 바꾸기·떼기', 'aria-label': '프로젝트 바꾸기', onclick: (e) => opts.onPickProject(e.currentTarget) })] : []));
        }
        else if (canPick) {
            projEl.replaceChildren(el('button', { class: 'btn-text sc-proj-btn sc-proj-connect', type: 'button', title: '이 세션을 프로젝트에 붙입니다 — 언제든 바꾸거나 뗄 수 있어요', onclick: (e) => opts.onPickProject(e.currentTarget) }, el('span', { text: '프로젝트 연결' }), el('span', { class: 'sc-proj-car', 'aria-hidden': 'true', text: '▾' })));
        }
        else {
            projEl.replaceChildren(el('span', { class: 'sc-proj-none', text: target.projectName || '프로젝트 없음' }));
        }
    }
    paintProject();
    const head = el('div', { class: 'sc-head' }, el('div', { class: 'sc-head-l' }, dot, titleEl, el('span', { class: 'sc-meta' }, stateEl, el('span', { class: 'sc-sep', text: '·' }), projEl, target.raw?.harness ? [el('span', { class: 'sc-sep', text: '·' }), el('span', { class: 'mono', text: String(target.raw.harness) })] : null, target.node ? [el('span', { class: 'sc-sep', text: '·' }), el('span', { text: String(target.node) })] : null)), el('div', { class: 'sc-head-r' }, idxBtn, opts.terminalSrc && isBox ? termBtn : null, el('button', { class: 'btn-text sc-act', type: 'button', text: '링크', title: '이 세션 링크 복사', onclick: async () => { try {
            await navigator.clipboard.writeText(location.href);
            toast('링크를 복사했습니다.');
        }
        catch {
            window.prompt('이 링크를 복사하세요:', location.href);
        } } }), opts.openHref ? el('a', { class: 'btn-text sc-act', href: opts.openHref, target: '_blank', rel: 'noopener', text: '새 탭 ↗' }) : null));
    const chatHost = el('div', { class: 'sc-chat' });
    const termHost = el('div', { class: 'sc-term', hidden: true });
    const waitBar = el('div', { class: 'sc-wait', hidden: true });
    const wrap = el('div', { class: 'sc-wrap' }, head, waitBar, chatHost);
    // 터미널은 대화 **아래**에 붙는다(둘 다 보인다) — 사이 경계는 끌어서 조정(#1719 '수평 경계').
    const termSplit = makeSplitter({ axis: 'y', key: 'sc-term-h', cssVar: '--sc-term-h', target: wrap, def: 320, min: 120, max: 1200, grow: -1, label: '대화·터미널 경계' });
    termSplit.hidden = true;
    wrap.append(termSplit, termHost);
    host.replaceChildren(wrap);
    // 입력칸 아래 바(Claude Desktop 의 '자동 · Opus 5 · 엑스트라' 자리) — 이 세션이 실제로 도는 모드·모델·노력. 트랜스크립트 줄에서
    //  읽어 채운다(user.permissionMode · assistant.message.model · assistant.effort). **바꾸는 컨트롤이 아니라 사실 표시**다 —
    //  이 값은 터미널(/model·/effort)에서만 바뀐다. 눌러도 되는 척하는 버튼은 두지 않는다(막다른 컨트롤 금지).
    const chipMode = el('span', { class: 'dt-chip', hidden: true });
    const chipModel = el('span', { class: 'dt-chip', hidden: true });
    const chipEffort = el('span', { class: 'dt-chip', hidden: true });
    const chip = (n, v) => { n.textContent = v; n.hidden = !v; };
    const MODE_KO = { default: '기본', auto: '자동', acceptEdits: '수정 자동승인', bypassPermissions: '전부 자동', plan: '계획', dontAsk: '묻지 않음' };
    const EFFORT_KO = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
    const prettyModel = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-').map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
    // 대화창 ————
    const view = createChatView(chatHost, {
        who: { me: '나', ai: 'AI' },
        placeholder: target.node ? '이 세션에 보내기(그 컴퓨터로 전달)' : '이 세션에 보내기',
        toolLabel,
        thinking: 'fold',
        sendWhileBusy: true,
        style: 'desktop',
        bar: { right: el('span', { class: 'dt-chips' }, chipMode, chipModel, chipEffort) },
        onSend: (text) => sendPrompt(text),
        onStop: canKeys() ? () => sendKey('interrupt') : undefined,
        escActive: () => true,
        opening: null,
    });
    // 상태 표시(헤더 점·라벨·확인 대기 배너·끝난 세션 바) ————
    const dotCls = (k) => k === 'busy' ? 'busy' : k === 'waiting' ? 'wait' : (k === 'done' || k === 'idle') ? 'done' : '';
    let running = false; // 대화 파일 기준 '지금 턴이 도는 중'
    const paintState = () => {
        const k = running && !dead() ? 'busy' : target.stateKey;
        dot.className = 'v2-dot ' + dotCls(k);
        stateEl.textContent = running && !dead() ? '작업 중' : target.stateLabel;
        const waiting = !dead() && (!!target.raw?.awaiting || target.raw?.agentState === 'waiting');
        waitBar.hidden = !waiting;
        if (waiting && !waitBar.childElementCount) {
            waitBar.replaceChildren(el('span', { class: 'v2-dot wait', 'aria-hidden': 'true' }), el('div', { class: 'sc-wait-t' }, el('b', { text: '확인이 필요해요' }), el('span', { text: ' — 세션이 승인이나 선택을 기다리고 있어요. 무엇을 묻는지는 터미널에 떠 있습니다.' })), el('div', { class: 'sc-wait-acts' }, opts.terminalSrc && isBox ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '터미널에서 답하기', onclick: () => toggleTerminal(true) }) : null, canKeys() ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '기본 선택으로 답하기', onclick: () => sendKey('approve') }) : null, canKeys() ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '거부', onclick: () => sendKey('deny') }) : null));
        }
        if (dead())
            paintDeadFooter();
    };
    let deadFooterOn = false;
    const paintDeadFooter = () => {
        if (deadFooterOn)
            return;
        deadFooterOn = true;
        const why = target.stateKey === 'exited_user' ? '내가 종료한 세션' : target.stateKey === 'oom_killed' ? '메모리 부족으로 끝난 세션' : target.stateKey === 'restorable' ? '중단된 세션' : '기록만 남은 세션';
        const btn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '이어서 대화하기' });
        btn.addEventListener('click', () => { void resumeSession(btn); });
        view.setFooter(el('div', { class: 'sc-bar' }, el('span', { class: 'sc-bar-t', text: `${why}이에요 — 대화는 그대로 이어받을 수 있어요.` }), btn));
        view.busy(false);
    };
    // 터미널 토글 — 버리지 않는다. 처음 켤 때 한 번 만들고, 그 뒤엔 숨겼다 보였다(WS 를 유지해 즉시 전환).
    let termFrame = null;
    function toggleTerminal(on) {
        const show = on ?? termHost.hidden;
        if (show && !termFrame && opts.terminalSrc) {
            termFrame = el('iframe', { class: 'sc-term-frame', src: opts.terminalSrc, title: '터미널', allow: 'clipboard-read; clipboard-write' });
            termHost.append(termFrame);
        }
        termHost.hidden = !show;
        termSplit.hidden = !show;
        termBtn.textContent = show ? '터미널 닫기' : '터미널';
        termBtn.classList.toggle('sc-act-on', show);
        view.scrollToBottom();
        if (!show)
            view.input.focus();
    }
    const recs = []; // 화면 순서(위→아래)
    let cur = null;
    let src = null;
    let loadedFrom = 0;
    let loadedTo = 0;
    // 맥락 압축 사슬 — Claude Code 는 압축 때 새 uuid 의 새 파일을 연다(서버 findPrevTranscript 주석). curUuid = 지금 자라는 파일,
    //  oldestUuid/oldestPrev = 화면 맨 위 창이 속한 파일과 그 이전 파일(있으면 [압축 전 대화 불러오기]).
    let curUuid = null;
    let oldestUuid = null;
    let oldestPrev = null;
    let carry = ''; // 잘린 마지막 줄(다음 폴에서 이어 붙인다)
    const pending = [];
    let outboxTimer = null;
    let firstPrompt = opts.firstPrompt ? String(opts.firstPrompt) : null; // 홈 입력창의 첫 지시(한 번만 그린다)
    let pollTimer = null;
    let destroyed = false;
    let lastLineAt = 0;
    const flat = (s) => s.replace(/\s*\n\s*/g, ' ').trim();
    // 타임라인 장 제목 — 붙여넣은 로그·여러 문단은 **첫 줄(또는 첫 문장)**만. 통째로 이으면 제목이 벽이 된다.
    const firstLine = (t) => {
        const ln = String(t || '').split('\n').map((x) => x.trim()).find((x) => x.length > 1) || '';
        const dot = ln.search(/[.?!。]\s/);
        return (dot > 8 ? ln.slice(0, dot + 1) : ln).trim();
    };
    function userText(o) {
        const c = o?.message?.content;
        if (typeof c === 'string')
            return { text: c, results: [] };
        if (!Array.isArray(c))
            return { text: '', results: [] };
        return { text: c.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('\n'), results: c.filter((b) => b && b.type === 'tool_result') };
    }
    const newRec = (text, ts, at) => { const r = { t: view.turn(text, { ts, at }), evs: [] }; if (at === 'start')
        recs.unshift(r);
    else
        recs.push(r); return r; };
    /** 한 줄을 (끝에) 반영한다. 되그리기·라이브 둘 다 이 함수 하나. */
    function applyLine(o) {
        if (!o || typeof o !== 'object' || o.isSidechain)
            return;
        if (o.timestamp) {
            const ms = new Date(o.timestamp).getTime();
            if (Number.isFinite(ms))
                lastLineAt = ms;
        }
        if (o.type === 'user') {
            if (o.permissionMode)
                chip(chipMode, MODE_KO[String(o.permissionMode)] || String(o.permissionMode));
            const { text, results } = userText(o);
            if (results.length) {
                if (!cur)
                    cur = newRec(null);
                cur.evs.push(o);
                view.event(cur.t, { type: 'user', message: { content: results } });
                trailResults(results);
            }
            if (o.isMeta || !text.trim())
                return;
            if (INTERRUPT_RE.test(text)) {
                if (cur)
                    view.settle(cur.t, { interrupted: true });
                running = false;
                return;
            }
            if (CONTINUED_RE.test(text)) {
                view.divider('맥락 압축 — 이전 대화를 요약해 이어감', text);
                cur = newRec(null);
                running = true;
                return;
            }
            if (INJECTED_RE.test(text))
                return; // 슬래시 명령·리마인더 — 사람 말이 아니다
            // 내가 보낸(또는 큐에 있던) 말이 파일에 나타났다 → 낙관적으로 그린 그 턴을 그대로 쓴다(두 번 그리지 않는다)
            const pi = pending.findIndex((pd) => flat(pd.text) === flat(text));
            if (pi >= 0) {
                const pd = pending[pi];
                pending.splice(pi, 1);
                pd.state.remove(); // '전달 대기' 줄은 물러난다 — 기록에 적힌 것이 곧 전달이다
                view.setNote(''); // '여는 중·아직 안 나타남' 안내도 그 순간 물러난다
                const rec = recs.find((r) => r.t === pd.t);
                if (rec) {
                    cur = rec;
                    rec.t.ts = o.timestamp;
                    running = true;
                    return;
                }
            }
            cur = newRec(text, o.timestamp);
            running = true;
            // 타임라인(우패널)의 장(章) 머리 — 이 지시 아래로 그동안의 일이 묶인다(#1719 C안).
            trail?.add({ id: 'turn:' + String(o.uuid || o.timestamp || text.slice(0, 40)), kind: 'say', verb: '지시', label: firstLine(text), key: 'turn|' + String(o.uuid || o.timestamp), ts: o.timestamp }, 'end');
            return;
        }
        if (o.type === 'assistant') {
            if (o.message?.model)
                chip(chipModel, prettyModel(String(o.message.model)));
            if (o.effort)
                chip(chipEffort, EFFORT_KO[String(o.effort)] || String(o.effort));
            if (!cur)
                cur = newRec(null);
            cur.evs.push(o);
            view.event(cur.t, o);
            running = true;
            trailUses(o, 'end');
            return;
        }
        if (o.type === 'system') {
            // 턴의 끝 — turn_duration(소요 시간)·stop_hook_summary(Stop 훅 요약) 둘 다 턴이 끝난 뒤에만 찍힌다(둘 중 하나만 있어도 마감).
            if (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary') {
                if (cur)
                    view.settle(cur.t, { durationMs: Number(o.durationMs) || 0 });
                running = false;
            }
            // 공통 ChatLine(#1746) — 중단(사용자가 끊음)·맥락 압축(어댑터가 system 줄로 올린다. claude 는 위의 사용자 줄 표식으로도 온다).
            else if (o.subtype === 'interrupted') {
                if (cur)
                    view.settle(cur.t, { interrupted: true });
                running = false;
            }
            else if (o.subtype === 'compact') {
                view.divider('맥락 압축 — 이전 대화를 요약해 이어감', typeof o.text === 'string' ? o.text : undefined);
                cur = newRec(null);
                running = true;
            }
            return;
        }
    }
    // 발자취(우패널) — 이 세션이 읽고 쓴 것. tool_use → 항목, tool_result → 그 항목의 본문. 대화창과 같은 줄에서 함께 뽑는다.
    const trail = opts.trail || null;
    const trailOut = (b) => typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.map((c) => (c && c.type === 'text' ? String(c.text ?? '') : '')).join('\n') : '';
    function trailUses(o, at) {
        if (!trail)
            return;
        const c = o?.message?.content;
        if (!Array.isArray(c))
            return;
        for (const b of c) {
            if (!b || b.type !== 'tool_use' || !b.id)
                continue;
            const cls = classifyToolUse(String(b.name ?? ''), b.input);
            if (cls)
                trail.add({ ...cls, id: String(b.id), ts: o.timestamp }, at);
        }
    }
    function trailResults(results) {
        if (!trail)
            return;
        for (const b of results)
            if (b?.tool_use_id)
                trail.result(String(b.tool_use_id), trailOut(b), !!b.is_error);
    }
    // ── 아웃박스(#1753) — 전달 대기·실패의 화면 짝 ─────────────────────────────────────────
    /** 낙관 턴 + 말풍선 밑 상태 줄 한 벌. 서버 큐 행(obId)과 연결되면 새로고침에도 큐에서 되살아난다. */
    function addPending(text, obId) {
        const rec = newRec(text, new Date().toISOString());
        const state = el('div', { class: 'dt-qstate' });
        rec.t.ask?.append(state);
        const pd = { text, t: rec.t, obId, state };
        pending.push(pd);
        cur = rec;
        running = true;
        view.running(rec.t);
        view.busy(true);
        watchOutbox();
        return pd;
    }
    const QSTATE_TEXT = {
        queued: '전달 대기 중 — AI 입력창이 뜨면 들어갑니다',
        sending: '전달하는 중…',
    };
    function paintQState(pd, row) {
        if (!row) {
            pd.state.textContent = '';
            return;
        } // 큐에서 사라짐(delivered/sent) — 에코가 곧 마감한다
        if (row.status === 'failed') {
            const why = row.last_error === 'not-ready' ? '입력창이 끝내 안 떴어요(로그인·오류 화면)'
                : row.last_error === 'session-gone' ? '세션이 그새 닫혔어요' : (row.last_error || '알 수 없는 이유');
            const retry = el('button', { class: 'btn-text dt-qact', type: 'button', text: '다시 보내기', onclick: () => { void outboxAct(pd, 'retry'); } });
            const drop = el('button', { class: 'btn-text dt-qact', type: 'button', text: '지우기', onclick: () => { void outboxAct(pd, 'discard'); } });
            pd.state.replaceChildren(el('span', { class: 'dt-qfail', text: `전달 안 됨 — ${why} ` }), retry, drop);
            if (pd.t === cur?.t) {
                running = false;
                view.settle(pd.t);
                view.busy(false);
            }
            return;
        }
        // 오래 못 들어가고 있다(로그인·대화상자 의심) — 글자만 두지 않는다: 눌러서 그 화면(터미널)을 바로 연다(막다른 안내 금지).
        //  터미널은 이 페이지 아래 분할로 열리므로 '웹 안에서' 로그인까지 끝낼 수 있다.
        const stuck = row.status === 'queued' && row.last_error === 'not-ready' && Date.now() - Date.parse(row.created_at) > 60_000;
        if (stuck) {
            pd.state.replaceChildren(el('span', { text: '전달 대기 중 — 입력창이 아직 안 떠요. 로그인이 필요한 상태일 수 있어요. ' }), ...(opts.terminalSrc && isBox ? [el('button', { class: 'btn-text dt-qact', type: 'button', text: '터미널 열기', onclick: () => toggleTerminal(true) })] : []));
            maybeAutoOpenTerminal();
            return;
        }
        pd.state.textContent = QSTATE_TEXT[row.status] || '';
    }
    // 세션이 멈춰 있고 **보여줄 대화도 없으면** 터미널 분할을 한 번 자동으로 연다 — 로그인 화면은 터미널에만 있는데,
    //  빈 채팅만 두면 사람이 볼 수 있는 게 없다(실측 신고). 대화가 이미 있으면 자동으로 열지 않는다(읽던 화면을 뺏지 않는다).
    let autoTermOpened = false;
    function maybeAutoOpenTerminal() {
        if (autoTermOpened || destroyed || !opts.terminalSrc || !isBox)
            return;
        if (curUuid || recs.some((r) => r.evs.length))
            return; // 대화가 보이고 있다 — 알림 줄이면 충분
        autoTermOpened = true;
        toggleTerminal(true);
        view.setNote('세션이 입력을 못 받고 있어 터미널을 열었어요 — 로그인 등 필요한 단계를 여기서 끝내면 대기 중인 지시가 이어서 들어갑니다.');
    }
    async function outboxAct(pd, act) {
        if (!pd.obId)
            return;
        try {
            await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/outbox/${pd.obId}/${act}`, { method: 'POST', body: '{}' });
            if (act === 'discard') {
                const i = pending.indexOf(pd);
                if (i >= 0)
                    pending.splice(i, 1);
                pd.t.root.remove();
                const ri = recs.findIndex((r) => r.t === pd.t);
                if (ri >= 0)
                    recs.splice(ri, 1);
            }
            else {
                pd.state.textContent = QSTATE_TEXT.queued;
                view.running(pd.t);
            }
            void syncOutbox();
        }
        catch (e) {
            toast(e?.message || '처리하지 못했습니다.');
        }
    }
    /** 서버 큐와 화면을 맞춘다 — 몰랐던 행(다른 탭·홈 첫 지시)은 턴으로 올리고, 아는 행은 상태 줄만 갱신. */
    async function syncOutbox() {
        if (destroyed || !isBox || target.node)
            return;
        let items = [];
        try {
            items = (await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/outbox`)).items || [];
        }
        catch {
            return;
        }
        for (const row of items) {
            let pd = pending.find((x) => x.obId === row.id) || pending.find((x) => !x.obId && flat(x.text) === flat(String(row.text)));
            if (!pd)
                pd = addPending(String(row.text), Number(row.id));
            pd.obId = Number(row.id);
            paintQState(pd, row);
        }
        for (const pd of pending)
            if (pd.obId && !items.some((r) => Number(r.id) === pd.obId))
                paintQState(pd, null);
        if (pending.some((x) => x.obId))
            watchOutbox();
        else
            stopWatchOutbox();
    }
    function watchOutbox() {
        if (outboxTimer || destroyed)
            return;
        outboxTimer = window.setInterval(() => { if (!document.hidden)
            void syncOutbox(); }, 3000);
    }
    function stopWatchOutbox() { if (outboxTimer) {
        clearInterval(outboxTimer);
        outboxTimer = null;
    } }
    function applyText(text) {
        const chunk = carry + text;
        const lines = chunk.split('\n');
        carry = lines.pop() ?? ''; // 마지막 조각(개행 없이 끝남)은 다음에
        let n = 0;
        for (const line of lines) {
            if (!line.trim())
                continue;
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                continue;
            }
            applyLine(o);
            n++;
        }
        return n;
    }
    /** 첫 로드 — 어디서 읽을지 정하고 꼬리 창을 그린다. */
    async function open() {
        view.setNote('');
        const tries = [];
        if (isBox) {
            if (!target.node)
                tries.push({ kind: 'box', id: target.id });
            const uuid = target.logId || target.raw?.claudeSessionId;
            if (uuid)
                tries.push({ kind: 'log', sid: String(uuid), node: String(target.logNode ?? target.node ?? '') });
        }
        else {
            tries.push({ kind: 'log', sid: target.id, node: String(target.node ?? '') });
        }
        let chunk = null;
        const errs = [];
        for (const s of tries) {
            try {
                chunk = await rawGet(srcPath(s, { tail: WINDOW }));
                src = s;
                break;
            }
            catch (e) {
                errs.push(e);
                if (![403, 404, 409].includes(Number(e?.status)))
                    break;
            } // '없음·권한 아직 없음·딴 컴퓨터' 는 다음 후보로
        }
        if (destroyed)
            return;
        if (!chunk) {
            // 기록이 아직 없다(첫 대화 전) 또는 못 읽는다 — 그 자리에 말한다. 라이브면 입력칸은 살아 있다(첫 지시를 여기서 보낼 수 있다).
            //  박스 후보가 404 였으면 그게 사실(파일이 아직 없다)이다 — 그 뒤 중앙 기록 후보의 403(행이 아직 없다)을 앞세우지 않는다.
            const boxErr = errs.find((e) => tries[errs.indexOf(e)]?.kind === 'box');
            const lastErr = boxErr ?? errs[errs.length - 1];
            const notYet = !errs.length || errs.every((e) => [403, 404].includes(Number(e?.status)));
            const unreadable = Number(lastErr?.status) === 409 && lastErr?.message !== 'node' && !!lastErr?.message; // 409 = 'node'(그 컴퓨터) 또는 못 읽는 하네스(문장, #1746 — 폴링 무의미)
            // 홈 입력창이 방금 연 세션 — 첫 지시는 서버가 넣는 중이다. '아직 없음' 대신 그 턴을 도는 모양으로 먼저 그린다.
            //  하네스 부팅(수 초)+신뢰 대화상자를 지나 파일에 내 말이 나타나면 applyLine 이 이 턴을 재사용한다. 오래 안 나타나면 말한다.
            if (notYet && firstPrompt && canType() && !target.node) {
                addPending(firstPrompt);
                firstPrompt = null; // 서버 큐(createSession 가 enqueue)가 곧 obId 를 붙인다(syncOutbox)
                view.scrollToBottom();
                view.setNote('세션을 여는 중이에요 — AI 가 뜨면 첫 지시가 들어갑니다.');
                paintState();
                src = { kind: 'box', id: target.id };
                schedule();
                void syncOutbox();
                return;
            }
            // ⚠ 압축(Compacting) 탓을 하지 않는다 — 압축은 새 uuid 파일로 이어지고 폴링이 그 전환을 따라간다(아래 poll()). 여기 닿는
            //  '기록 없음'의 실제 원인은 대부분 ① 방금 연 세션(하네스 부팅 전) ② 로그인·신뢰 대화상자에 멈춤 — 둘 다 **터미널에만 보인다**.
            //  그래서 문구가 터미널을 가리키고, 버튼도 이 경우에 항상 둔다(막다른 안내 금지 — 확인할 길을 같이 준다).
            const msg = !tries.length ? '이 세션의 대화 id 를 아직 몰라 여기서 읽을 수 없어요 — 첫 턴이 끝나면 중앙 기록으로 보입니다. 지금은 터미널로 보세요.'
                : notYet ? (canType() ? '아직 대화 기록이 없어요. 세션이 방금 떴다면 곧 여기 보이고, 계속 비어 있으면 로그인·확인 대화상자에 멈춰 있는 것일 수 있어요 — 터미널로 확인해 보세요.' : '이 세션의 대화 기록을 찾지 못했어요.')
                    : unreadable ? String(lastErr.message)
                        : lastErr?.status === 409 ? '이 세션의 대화 파일은 그 컴퓨터에 있어 여기서 바로 읽지 못해요. 첫 턴이 끝나면 중앙 기록으로 보입니다.'
                            : `대화 기록을 불러오지 못했습니다. ${lastErr?.message || ''}`;
            view.list.append(el('div', { class: 'livc-open sc-empty' }, el('p', { text: msg }), opts.terminalSrc && isBox ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '터미널로 보기', onclick: () => toggleTerminal(true) }) : null));
            paintState();
            // 라이브 박스면 파일이 생기는 순간을 잡는다(사람이 터미널에서 먼저 말을 걸 수도 있다) — 첫 대화 뒤에 여기로 흘러든다.
            //  못 읽는 하네스면 기다려도 안 온다 — 폴링하지 않는다(보내기는 된다: 주입은 tmux 라 하네스 무관).
            if (canType() && !target.node && !unreadable) {
                src = { kind: 'box', id: target.id };
                schedule();
            }
            void syncOutbox(); // ⚠ 기록이 아직 없어도 큐엔 내 말이 있을 수 있다(다른 탭에서 보냄·막힌 세션) — 대기 말풍선을 되살린다
            return;
        }
        loadedFrom = chunk.from;
        loadedTo = chunk.to; // 서버가 줄 경계로 맞춘 창 — 첫 줄 버리기·조각 이어붙이기가 필요 없다(#1746 window.ts)
        curUuid = chunk.uuid || null;
        oldestUuid = curUuid;
        oldestPrev = chunk.from === 0 ? (chunk.prev || null) : null;
        applyText(chunk.text);
        olderBar();
        finishReplay();
        view.scrollToBottom();
        paintState();
        void syncOutbox(); // 큐에 남은 내 말(다른 탭·홈 첫 지시·재시작 전) — 새로고침에도 대기 말풍선으로 되살아난다
        schedule();
    }
    function finishReplay() {
        // 창 안에서 끝나지 않은 마지막 턴 — 지금 도는 중이면 라이브 표시, 아니면(죽었거나 오래됐으면) 조용히 마감.
        const staleMs = Date.now() - lastLineAt;
        const looksLive = running && !dead() && (target.raw?.working || target.raw?.agentState === 'busy' || staleMs < 120_000);
        if (cur && looksLive) {
            view.running(cur.t);
            view.busy(true);
        }
        else {
            running = false;
            recs.forEach((r) => view.settle(r.t));
            view.busy(false);
        }
        titleFromFirstAsk();
    }
    function titleFromFirstAsk() {
        if (target.label && !/^box-|^[0-9a-f-]{20,}$/i.test(target.label))
            return;
        const q = recs.find((r) => r.t.text)?.t.text;
        if (q)
            titleEl.textContent = q.length > 60 ? q.slice(0, 60) + '…' : q;
    }
    // 위로 더 — [from-WINDOW, from) 창을 읽어 **턴 단위로 거꾸로** 앞에 끼운다(보고 있던 자리는 그대로).
    let olderEl = null;
    function olderBar() {
        olderEl?.remove();
        if (loadedFrom <= 0 && !oldestPrev) {
            olderEl = null;
            return;
        }
        const kb = Math.round(loadedFrom / 1024);
        const label = loadedFrom > 0 ? `이전 대화 불러오기 (${kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : kb + 'KB'} 더 있음)` : '압축 전 대화 불러오기';
        const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: label });
        btn.addEventListener('click', () => { void loadOlder(btn); });
        const bar = el('div', { class: 'sc-older' }, btn);
        olderEl = bar;
        view.list.prepend(bar);
    }
    async function loadOlder(btn) {
        if (!src || (loadedFrom <= 0 && !oldestPrev))
            return;
        btn.disabled = true;
        btn.textContent = '불러오는 중…';
        // 같은 파일의 앞 창, 또는(파일 머리에 닿았으면) 압축 전 파일의 꼬리 창.
        const intoPrev = loadedFrom <= 0 && !!oldestPrev;
        const q = intoPrev ? { uuid: oldestPrev, tail: WINDOW } : { from: Math.max(0, loadedFrom - WINDOW), to: loadedFrom };
        if (!intoPrev && src.kind === 'box' && oldestUuid && oldestUuid !== curUuid)
            q.uuid = oldestUuid;
        let chunk;
        try {
            chunk = await rawGet(srcPath(src, q));
        }
        catch (e) {
            btn.disabled = false;
            btn.textContent = '다시 시도';
            toast(e?.message || '이전 대화를 불러오지 못했습니다.');
            return;
        }
        if (destroyed)
            return;
        const from = chunk.from; // 서버가 줄 경계로 맞춘 창(#1746) — 첫 줄 버리기 없음
        if (intoPrev) {
            oldestUuid = oldestPrev;
            oldestPrev = null;
        }
        if (from === 0)
            oldestPrev = chunk.prev || null;
        const text = chunk.text;
        const bundles = [];
        let b = null;
        for (const line of text.split('\n')) {
            if (!line.trim())
                continue;
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!o || o.isSidechain)
                continue;
            if (o.type === 'user') {
                const { text: ut, results } = userText(o);
                if (results.length) {
                    if (!b) {
                        b = { text: null, lines: [], kind: 'cont' };
                        bundles.push(b);
                    }
                    b.lines.push(o);
                }
                if (o.isMeta || !ut.trim() || INTERRUPT_RE.test(ut) || INJECTED_RE.test(ut)) {
                    if (INTERRUPT_RE.test(ut) && b)
                        b.lines.push(o);
                    continue;
                }
                if (CONTINUED_RE.test(ut)) {
                    bundles.push({ text: null, lines: [], kind: 'divider', raw: ut });
                    b = { text: null, lines: [], kind: 'cont' };
                    bundles.push(b);
                    continue;
                }
                b = { text: ut, ts: o.timestamp, lines: [], kind: 'turn' };
                bundles.push(b);
            }
            else if (o.type === 'system' && o.subtype === 'compact') {
                bundles.push({ text: null, lines: [], kind: 'divider', raw: typeof o.text === 'string' ? o.text : undefined });
                b = { text: null, lines: [], kind: 'cont' };
                bundles.push(b);
            }
            else if (o.type === 'assistant' || (o.type === 'system' && (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary' || o.subtype === 'interrupted'))) {
                if (!b) {
                    b = { text: null, lines: [], kind: 'cont' };
                    bundles.push(b);
                }
                b.lines.push(o);
            }
        }
        // 발자취 — 이 창의 도구 사용을 시간순으로 모았다가 **위에**(오래된 쪽) 끼운다(가장 최신 것부터 거꾸로 add 해야 순서가 맞다).
        const olderUses = [];
        const olderResults = [];
        const olderTurns = []; // 되그린 창의 지시 = 타임라인 장 머리
        for (const bd of bundles) {
            if (bd.text && bd.text.trim()) {
                const head = bd.lines.find((x) => x && x.type === 'user') || {};
                olderTurns.push({ uuid: String(head.uuid || head.timestamp || bd.text.slice(0, 40)), ts: String(head.timestamp || ''), text: bd.text });
            }
            for (const o of bd.lines) {
                if (o.type === 'assistant')
                    olderUses.push(o);
                else if (o.type === 'user') {
                    const { results } = userText(o);
                    if (results.length)
                        olderResults.push(...results);
                }
            }
        }
        // 화면 맨 위가 '이어짐'(사람 말 없음)이었으면 그 내용은 이 창의 마지막 턴에 속한다 — 합친다.
        const firstRec = recs[0];
        let orphan = null;
        if (firstRec && !firstRec.t.ask && bundles.length && bundles[bundles.length - 1].kind !== 'divider') {
            orphan = firstRec;
        }
        view.prependKeepingView(() => {
            const savedCur = cur;
            for (let i = bundles.length - 1; i >= 0; i--) {
                const bd = bundles[i];
                if (bd.kind === 'divider') {
                    view.divider('맥락 압축 — 이전 대화를 요약해 이어감', bd.raw, 'start');
                    continue;
                }
                const rec = newRec(bd.text, bd.ts, 'start');
                cur = rec;
                for (const o of bd.lines) {
                    if (o.type === 'user') {
                        const { text: ut, results } = userText(o);
                        if (results.length)
                            view.event(rec.t, { type: 'user', message: { content: results } });
                        if (INTERRUPT_RE.test(ut))
                            view.settle(rec.t, { interrupted: true });
                    }
                    else if (o.type === 'assistant')
                        view.event(rec.t, o);
                    else if (o.type === 'system')
                        view.settle(rec.t, o.subtype === 'interrupted' ? { interrupted: true } : { durationMs: Number(o.durationMs) || 0 });
                }
                if (i === bundles.length - 1 && orphan) {
                    // 고아 이어짐의 이벤트를 이 턴 뒤에 다시 그리고 고아는 치운다. 고아가 '지금 도는 턴'이었으면 그 표시(깜빡임·경과 줄)도 옮긴다.
                    const wasLive = !!orphan.t.live;
                    for (const o of orphan.evs)
                        view.event(rec.t, o);
                    orphan.t.root.remove();
                    recs.splice(recs.indexOf(orphan), 1);
                    if (savedCur === orphan)
                        cur = rec;
                    if (wasLive) {
                        view.running(rec.t);
                        continue;
                    } // 도는 턴은 마감하지 않는다
                }
                view.settle(rec.t);
            }
            cur = savedCur && recs.includes(savedCur) ? savedCur : cur;
            loadedFrom = chunk.from; // 서버가 맞춘 경계(요청한 from 이 줄 중간이면 다음 줄부터)
            olderBar();
        });
        for (let i = olderUses.length - 1; i >= 0; i--)
            trailUses(olderUses[i], 'start');
        for (let i = olderTurns.length - 1; i >= 0; i--) {
            const o = olderTurns[i];
            trail?.add({ id: 'turn:' + String(o.uuid || o.ts), kind: 'say', verb: '지시', label: firstLine(o.text), key: 'turn|' + String(o.uuid || o.ts), ts: o.ts }, 'start');
        }
        trailResults(olderResults);
        titleFromFirstAsk();
    }
    // 폴링 — 도는 중이면 촘촘히, 아니면 느슨히. 탭이 숨어 있으면 건너뛴다.
    function schedule() {
        if (destroyed || !src)
            return;
        if (pollTimer)
            clearTimeout(pollTimer);
        const ms = src.kind === 'log' ? POLL_LOG_MS : running ? POLL_RUN_MS : POLL_IDLE_MS;
        if (dead() && src.kind === 'log' && !running)
            return; // 죽은 세션의 중앙 기록은 더 안 는다
        pollTimer = window.setTimeout(() => { void poll(); }, ms);
    }
    let fails = 0;
    async function poll() {
        if (destroyed || !src)
            return;
        if (document.hidden) {
            schedule();
            return;
        }
        try {
            let c = await rawGet(srcPath(src, { from: loadedTo }));
            fails = 0;
            if (destroyed)
                return;
            if (src.kind === 'box' && c.uuid && curUuid && c.uuid !== curUuid) {
                // 맥락 압축 — 박스가 새 uuid 의 새 파일로 넘어갔다. 화면을 비우지 않는다(지금까지가 곧 '압축 전 대화'다). 새 파일을 0 부터 이어 읽는다 —
                //  그 첫 줄(compact_boundary + 요약)이 곧 구분선으로 그려진다.
                curUuid = c.uuid;
                loadedTo = 0;
                carry = '';
                c = await rawGet(srcPath(src, { from: 0 }));
                if (destroyed)
                    return;
            }
            else if (c.bytes < loadedTo) { // 같은 파일이 줄었다(교체됨) — 처음부터 다시
                clearAll();
                await open();
                return;
            }
            if (!curUuid && c.uuid) {
                curUuid = c.uuid;
                oldestUuid = c.uuid;
            } // 열 때는 파일이 없었다가 지금 생겼다
            if (loadedTo === 0 && c.from === 0 && c.prev && !oldestPrev && oldestUuid === c.uuid) {
                oldestPrev = c.prev;
                olderBar();
            }
            if (c.text) {
                view.list.querySelector('.sc-empty')?.remove(); // 파일이 생겼다 — '아직 없음' 안내는 물러난다
                const wasRunning = running;
                applyText(c.text);
                loadedTo = c.to;
                if (running && cur) {
                    if (!wasRunning || !cur.t.live)
                        view.running(cur.t);
                    view.busy(true);
                }
                if (!running) {
                    if (cur)
                        view.settle(cur.t);
                    view.busy(false);
                }
                view.scroll();
                paintState();
                titleFromFirstAsk();
            }
            else if (running && cur && !dead()) {
                // 새 줄이 없는데 도는 중 표시 — 오래 조용하면(120초) 상태 보고까지 안 바쁘다면 마감한다(터미널에서 Esc 했거나 죽은 경우)
                if (Date.now() - lastLineAt > 120_000 && !(target.raw?.working || target.raw?.agentState === 'busy')) {
                    running = false;
                    view.settle(cur.t);
                    view.busy(false);
                    paintState();
                }
            }
        }
        catch (e) {
            fails++;
            if (e?.status === 404 && src.kind === 'box') { /* 아직 파일 없음 — 계속 기다린다(첫 대화 뒤에 생긴다) */ }
            else if (e?.status === 409 && src.kind === 'box' && e?.message && e.message !== 'node') {
                src = null;
                return;
            } // 못 읽는 하네스 — 더 안 묻는다(#1746)
            else if (fails === 3)
                view.setNote('진행을 따라가지 못하고 있어요 — 다시 붙는 중…');
        }
        schedule();
    }
    function clearAll() {
        recs.splice(0);
        cur = null;
        carry = '';
        loadedFrom = loadedTo = 0;
        running = false;
        view.list.replaceChildren();
        olderEl = null;
        trail?.clear();
    }
    // ── 보내기·키·이어받기 ──────────────────────────────────────────────────────────────
    async function sendPrompt(text) {
        if (!canType()) {
            toast('끝난 세션이에요 — [이어서 대화하기]로 새 세션을 열어 보내세요.');
            return;
        }
        // 낙관적으로 그리고 **서버 큐에 넣는다**(#1753). 배달자가 입력창을 확인하고 넣고 에코로 delivered 를 확정한다 —
        //  로그인·대화상자에 멈춘 세션이어도 유실되지 않고, 새로고침해도 큐에서 되살아난다. 미제출 Enter 재시도도 배달자 몫.
        view.removeOpening();
        view.list.querySelector('.sc-empty')?.remove();
        const pd = addPending(text);
        view.scrollToBottom();
        try {
            const r = await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) });
            if (r?.outbox_id)
                pd.obId = Number(r.outbox_id);
            view.setNote('');
            if (!caps().read) { // 큐엔 들어갔지만(배달자가 전달) 답은 여기 안 온다(파서 전) — 도는 척 두지 않고 그 자리에 말한다
                const i = pending.indexOf(pd);
                if (i >= 0)
                    pending.splice(i, 1);
                pd.state.textContent = '';
                running = false;
                view.settle(pd.t);
                view.busy(false);
                view.setNote('보냈어요 — 이 하네스의 답은 아직 여기 안 보여요. 터미널로 보세요.');
                return;
            }
            if (!src) {
                src = { kind: 'box', id: target.id };
            }
            schedule();
            void syncOutbox();
        }
        catch (e) {
            const i = pending.indexOf(pd);
            if (i >= 0)
                pending.splice(i, 1);
            pd.state.remove();
            running = false;
            view.settle(pd.t);
            view.busy(false);
            view.error(pd.t, `보내지 못했습니다. ${e?.message || ''}`);
            view.input.value = text; // 친 글은 돌려준다
        }
    }
    // 동작(승인·거부·중단)을 보낸다 — 어느 키인지는 서버의 하네스 어댑터가 정한다(#1746). 대신 못 누르는 하네스면 서버가 409 로 말한다.
    async function sendKey(action, quiet = false) {
        try {
            await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/keys`, { method: 'POST', body: JSON.stringify({ action }) });
            if (quiet)
                return;
            view.setNote(action === 'interrupt' ? '멈춤을 보냈어요.' : action === 'deny' ? '거부를 보냈어요.' : '승인을 보냈어요.');
            window.setTimeout(() => { if (!destroyed)
                view.setNote(''); }, 2500);
        }
        catch (e) {
            if (!quiet)
                view.setNote(e?.message || '키를 보내지 못했습니다.');
        }
    }
    async function resumeSession(btn) {
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = '여는 중…';
        try {
            let nextId = '';
            if (isBox && target.raw?.restorable) {
                const r = await api(`/api/ui/terminal/sessions/${encodeURIComponent(target.id)}/restore`, { method: 'POST', body: '{}' });
                nextId = String(r?.session?.id || (r?.already ? target.id : ''));
            }
            else {
                const sid = !isBox ? target.id : String(target.logId || target.raw?.claudeSessionId || '');
                const node = !isBox ? String(target.node ?? '') : String(target.logNode ?? '');
                if (!sid)
                    throw new Error('이어받을 대화 id 를 모릅니다.');
                const r = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/resume?node=${encodeURIComponent(node)}`, { method: 'POST', body: '{}' });
                nextId = String(r?.session?.id || '');
                if (r?.mode === 'fallback' && r?.reason)
                    toast(String(r.reason));
            }
            if (!nextId)
                throw new Error('새 세션 id 를 받지 못했습니다.');
            toast('이어받기 세션을 열었어요.');
            location.hash = '#/s/' + encodeURIComponent(nextId);
        }
        catch (e) {
            toast(e?.message || '이어받기 세션을 만들지 못했습니다.');
            btn.disabled = false;
            btn.textContent = orig || '이어서 대화하기';
        }
    }
    // 목차 — 이 창에서 읽은 질문들. 누르면 그 턴으로.
    function openIndex() {
        const qs = recs.filter((r) => r.t.text);
        // dash-pop-panel — 배경·테두리·그림자는 이 클래스가 준다(anchoredPopover 는 위치만 잡는다). 없으면 글자가 본문 위에 투명하게 겹친다.
        const panel = el('div', { class: 'dash-pop-panel sc-idx' }, el('div', { class: 'sc-idx-h', text: qs.length ? `질문 ${qs.length}개${loadedFrom > 0 ? ' · 불러온 범위 안' : ''}` : '이 창에 질문이 없어요' }), ...qs.map((r, i) => el('button', { class: 'sc-idx-item', type: 'button', title: r.t.text, onclick: () => { close(); r.t.root.scrollIntoView({ behavior: 'smooth', block: 'start' }); r.t.root.classList.add('sc-flash'); setTimeout(() => r.t.root.classList.remove('sc-flash'), 1800); } }, el('span', { class: 'sc-idx-n', text: String(i + 1) }), el('span', { class: 'sc-idx-t', text: r.t.text.length > 90 ? r.t.text.slice(0, 90) + '…' : r.t.text }))));
        const close = anchoredPopover(idxBtn, panel);
    }
    void open();
    return {
        update(t) {
            const wasDead = dead();
            target = t;
            titleEl.textContent = t.label && !/^box-|^[0-9a-f-]{20,}$/i.test(t.label) ? t.label : titleEl.textContent;
            paintProject();
            paintState();
            if (!wasDead && dead()) {
                running = false;
                if (cur)
                    view.settle(cur.t);
            }
        },
        destroy() { destroyed = true; if (pollTimer)
            clearTimeout(pollTimer); stopWatchOutbox(); view.destroy(); },
    };
}
