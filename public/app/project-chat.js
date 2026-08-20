// project-chat.ts — 프로젝트 화면의 **리브 대화**(#1757). 홈 리브(web/liv-chat.ts)와 같은 대화창(web/chat-view.ts, desktop 문법)에
//  **프로젝트 폴더에서 도는 턴**을 싣는다. 이 파일은 프로젝트 대화 고유의 것만 든다: 어디서 읽고(v6/projects/:id/chat/turn/:tid)
//  어디로 보내는지(POST …/chat/turn), 되그리기, 멈춤, 그리고 **턴이 끝나면 화면에 알리기**(리브가 본문·태스크를 바꿨을 수 있다).
//
//  ── 지키는 것(홈 리브에서 물려받은 원칙, 그대로) ──
//  · 답을 기다리는 동안 입력을 막는다(턴이 겹치면 --resume 이 꼬인다). · 도구 이름은 사람 말로, 모르는 이름은 그대로.
//  · 진행이 멈추면(STALL) 조용히 풀지 않고 "끝나지 못했다"고 말한다. · 실패를 삼키지 않는다 — 그 자리에 말한다.
import { api } from './core.js';
import { createChatView } from './chat-view.js';
const POLL_MS = 400; // 조각(글자 단위)이 와도 이 간격마다 그린다 — 곧 체감 속도(liv-chat 과 같다)
const RETRY_MAX = 6; // 진행 읽기 연속 실패 허용(배포·네트워크 blip)
const STALL_MS = 3 * 60_000; // 진행이 이만큼 안 늘면 끝난 것으로 본다(done 이 영영 안 찍히는 사고 대비 — liv-chat 실측)
/** 도구 이름 → 사람 말. 라이블리 도구는 무슨 일인지 이름에서 읽어 준다(프로젝트 대화는 그 도구가 주인공이다). */
const TOOL_LABELS = {
    ToolSearch: '쓸 도구 찾기', Skill: '전담 절차 실행', TodoWrite: '할 일 정리', AskUserQuestion: '물어보기',
    mcp__lively__project_get_v6: '프로젝트 읽기', mcp__lively__project_update_v6: '프로젝트 본문 고치기',
    mcp__lively__project_set_status_v6: '프로젝트 상태 바꾸기', mcp__lively__task_create_v6: '태스크 만들기',
    mcp__lively__task_update_v6: '태스크 고치기', mcp__lively__task_set_status_v6: '태스크 상태 바꾸기',
    mcp__lively__project_link_knowledge_v6: '지식 연결', mcp__lively__knowledge_search: '지식 찾기', mcp__lively__knowledge_grep: '지식 찾기',
    mcp__lively__knowledge_get: '지식 읽기', mcp__lively__project_folder_index_v6: '공유 폴더 보기', mcp__lively__whoami: '누구인지 확인',
};
function toolLabel(name) {
    if (TOOL_LABELS[name])
        return { label: TOOL_LABELS[name] };
    if (name.startsWith('mcp__lively__'))
        return { label: '라이블리 · ' + name.slice('mcp__lively__'.length) };
    if (name.startsWith('mcp__'))
        return { label: '연결한 도구 사용' };
    return { label: name };
}
export function mountProjectChat(host, opts) {
    const base = `/api/ui/v6/projects/${encodeURIComponent(String(opts.projectId))}/chat`;
    let view;
    let running = null; // 지금 도는 턴 id — 멈추려면 무엇을 멈출지 알아야 한다
    let stopping = false;
    let restartNext = false; // 다음 턴을 새 대화로
    let dead = false; // destroy 뒤엔 폴링·콜백을 멈춘다(화면을 떠났다)
    let hasTurns = false;
    const setHas = (h) => { if (hasTurns !== h) {
        hasTurns = h;
        opts.onHasTurns?.(h);
    } };
    async function stopTurn() {
        if (!running || stopping)
            return;
        stopping = true;
        view.setNote('멈추는 중…');
        const r = await api(`${base}/turn/${encodeURIComponent(running)}/stop`, { method: 'POST', body: '{}' })
            .catch((e) => ({ stopped: false, reason: e.message }));
        if (!r?.stopped) {
            view.setNote(r?.reason || '멈추지 못했습니다 — 리브가 계속 일하고 있습니다.');
            stopping = false;
        }
    }
    view = createChatView(host, {
        who: { me: '나', ai: '리브' },
        placeholder: '리브에게 이 프로젝트 시키기 — 본문 정리 · 태스크 · 상태 · 다음 할 일',
        busyPlaceholder: '리브가 하는 중…',
        toolLabel,
        thinking: 'hide',
        sendWhileBusy: false,
        style: 'desktop',
        onSend: (text) => sendTurn(text),
        onStop: stopTurn,
        escActive: () => !!document.body.dataset.ui && document.body.contains(host),
        opening: opts.opening ?? null,
        bar: opts.bar,
    });
    async function drain(turnId, t, from0 = 0) {
        let from = from0, sawText = false, fails = 0, grewAt = Date.now();
        for (;;) {
            if (dead)
                return;
            let tail;
            try {
                tail = await api(`${base}/turn/${encodeURIComponent(turnId)}?from=${from}`);
                fails = 0;
            }
            catch (e) {
                fails++;
                if (fails <= RETRY_MAX) {
                    await new Promise((s) => setTimeout(s, Math.min(POLL_MS * 2 ** (fails - 1), 5000)));
                    continue;
                }
                view.error(t, '진행을 따라가지 못했습니다. 리브는 계속 일하고 있을 수 있으니, 화면을 새로고침하면 이어서 보입니다.');
                return;
            }
            if (tail.chunk) {
                for (const line of tail.chunk.split('\n')) {
                    if (!line.trim())
                        continue;
                    let ev;
                    try {
                        ev = JSON.parse(line);
                    }
                    catch {
                        continue;
                    } // 잘린 줄 — 다음 청크에서 온전히 온다
                    if (ev.type === 'stream_event') {
                        view.stream(t, ev);
                        sawText = true;
                        continue;
                    }
                    if (ev.type === 'result') {
                        if (!sawText && String(ev.result ?? '').trim())
                            view.event(t, { type: 'assistant', message: { content: [{ type: 'text', text: String(ev.result) }] } });
                        continue;
                    }
                    if (view.event(t, ev).text)
                        sawText = true;
                }
                from = tail.next ?? from;
                grewAt = Date.now();
                view.scroll();
            }
            if (tail.done) {
                view.settle(t, { exit: tail.exit });
                view.scroll();
                return;
            }
            if (Date.now() - grewAt > STALL_MS) {
                view.settle(t);
                view.error(t, '이 요청은 끝나지 못했습니다(진행이 멈췄어요). 다시 말씀해 주시면 이어서 해 보겠습니다.');
                return;
            }
            await new Promise((s) => setTimeout(s, POLL_MS));
        }
    }
    /** 지난 대화를 되그린다 — 새로고침·다시 들어와도 같은 대화가 그 자리에. 마지막 턴이 아직 돌고 있으면 거기서 live 로 이어붙는다. */
    async function replayHistory() {
        let chat = null;
        try {
            chat = (await api(base)).chat;
        }
        catch {
            return;
        }
        if (dead)
            return;
        const turns = chat?.turns ?? [];
        if (!turns.length) {
            setHas(false);
            return;
        }
        view.removeOpening();
        setHas(true);
        for (const tt of turns) {
            if (dead)
                return;
            const t = view.turn(tt.text, { ts: tt.at });
            let tail = null;
            try {
                tail = await api(`${base}/turn/${encodeURIComponent(tt.id)}?from=0`);
            }
            catch {
                t.work.remove();
                continue;
            }
            for (const line of String(tail.chunk ?? '').split('\n')) {
                if (!line.trim())
                    continue;
                let ev;
                try {
                    ev = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (ev.type === 'stream_event' || ev.type === 'result')
                    continue;
                view.event(t, ev);
            }
            const ageMs = tt.at ? Date.now() - Date.parse(tt.at) : 0;
            if (!tail.done && ageMs > 30 * 60_000) {
                view.settle(t);
                view.error(t, '이 요청은 끝나지 못했습니다(그때 진행이 멈췄어요). 다시 말씀해 주시면 이어서 해 보겠습니다.');
            }
            else if (!tail.done) {
                running = tt.id;
                stopping = false;
                view.running(t);
                view.busy(true);
                void drain(tt.id, t, tail.next ?? 0).finally(() => { running = null; view.settle(t); view.busy(false); opts.onTurnDone?.(); });
            }
            else {
                view.settle(t);
            }
        }
        view.scrollToBottom();
    }
    async function sendTurn(text) {
        view.removeOpening();
        setHas(true);
        const t = view.turn(text);
        view.running(t);
        view.scroll();
        view.busy(true);
        try {
            const r = await api(`${base}/turn`, { method: 'POST', body: JSON.stringify({ text, restart: restartNext }) });
            restartNext = false;
            running = r.turn_id;
            stopping = false;
            await drain(r.turn_id, t);
        }
        catch (e) {
            view.error(t, `보내지 못했습니다. ${e.message}`);
        }
        finally {
            running = null;
            stopping = false;
            view.settle(t);
            view.busy(false);
            if (!dead) {
                view.input.focus();
                opts.onTurnDone?.();
            }
        }
    }
    void replayHistory();
    return {
        say(text) {
            view.input.value = text;
            if (view.input.disabled) {
                view.input.focus();
                return;
            } // 도는 중 — 글만 남기고 사람이 때를 고른다
            view.form.requestSubmit();
        },
        restart() {
            restartNext = true;
            view.divider('새 대화 — 다음 말부터 리브가 이전 대화를 잊고 시작합니다');
            view.scrollToBottom();
            view.input.focus();
        },
        focus() { view.input.focus(); },
        destroy() { dead = true; view.destroy(); },
    };
}
