// 리브와의 대화 — 터미널 대신 말풍선(#1631 v1). 그림·입력·스크롤은 **공용 대화창**(web/chat-view.ts, #1719)이 맡고,
//  이 파일은 리브 고유의 것만 든다: 어디서 읽고(me/liv/turn 진행 파일) 어디로 보내는지(POST me/liv/turn), 되그리기, 멈춤.
//
//  ── 왜 터미널을 걷어내나 ──
//  v0 는 웹터미널을 재사용했다. 두뇌를 먼저 검증하려는 선택이었고 그건 성공했다. 그런데 리브의 대상은
//  "라이블리를 1도 모르는 사람"이고, 그 사람이 마주하는 화면 오른쪽 절반이 **까만 터미널**이었다.
//  잘 대답해도 그 자리가 무섭다. 두뇌는 그대로 두고 표면만 바꾼다(D2·D5).
//
//  ── 무엇을 그리나 ──
//  서버가 헤드리스 한 턴을 띄우고(POST me/liv/turn) 진행을 JSONL 로 남긴다. 화면은 그 줄을 바이트
//  오프셋으로 이어 읽어 대화창에 넘긴다: assistant 의 글 → 말 / 도구 호출 → 작업 슬립(접힘) / 마지막 result → 답이
//  비어 있을 때만.
//
//  ── 이 화면이 지키는 것 ──
//  · **답을 기다리는 동안 입력을 막는다.** 턴이 겹치면 대화 이어받기(--resume)가 꼬인다(sendWhileBusy=false).
//  · 도구 이름은 사람 말로, 모르는 이름은 그대로(틀린 한국어보다 낯선 영어 한 줄이 낫다). 연속 도구는 한 줄로 접힌다(desktop 변형).
//  · 그림은 세션 대화창과 **같은 문법**(desktop) — 한 제품 안에 대화창이 두 모양이면 안 된다.
import { api } from './core.js';
import { createChatView } from './chat-view.js';
/**
 * 진행을 다시 물어보는 간격.
 *
 * 조각(글자 단위)이 와도 이 간격마다 그리므로 **이 값이 곧 체감 속도**다. 900ms 면 조각이 와도
 * 뭉텅이로 나타나 스트리밍이 아니게 된다. 400ms 는 20초 턴에 50회 남짓인데, 한 번이 파일을
 * 오프셋부터 이어 읽는 값싼 요청이라 감당된다.
 * ⚠ 진짜 밀어주기(SSE)가 아니라 **당겨오기**다 — 부드러운 타이핑이 아니라 짧은 뭉치로 나타난다.
 */
const POLL_MS = 400;
/** 진행 읽기가 연달아 몇 번까지 실패해도 버티나. 배포·네트워크 blip 은 몇 초면 지나간다. */
const RETRY_MAX = 6;
/**
 * 진행이 **이만큼 안 늘면** 그 턴은 끝난 것으로 본다(done 표식이 없어도).
 * 실측 2026-08-18: 리브 턴의 실행 세션이 회수·사망하면 진행 파일에 done 이 영영 안 찍힌다 → 화면은 "리브가 하는 중…"에
 * 입력이 잠긴 채 멈춘다(홈이 리브 대화라 아무 말도 못 건다). 서버가 못 알려주면 화면이 시간을 근거로 풀어 준다 —
 * 대신 조용히 풀지 않고 "끝나지 못했다"고 말한다.
 */
const STALL_MS = 3 * 60_000;
/**
 * 도구 이름을 사람 말로.
 *
 * 이 화면의 전제가 "무대 뒤를 드러내지 않는다"인데, 액션카드에 `ToolSearch` 같은 하네스 내부 이름이
 * 그대로 뜨면 그 전제가 카드 한 장으로 깨진다(실측: 첫 대화에서 그렇게 떴다). 그렇다고 감추지는 않는다 —
 * 카드가 있다는 사실 자체가 '진짜 했다'의 증거라, **이름만 사람 말로 바꾸고 원문은 접어 둔다.**
 * ⚠ 모르는 이름은 **그대로 둔다.** 그럴싸한 한국어를 지어내면 사람이 무슨 일이 있었는지 오해한다.
 */
const TOOL_LABELS = {
    ToolSearch: '쓸 도구 찾기',
    Skill: '전담 절차 실행',
    TodoWrite: '할 일 정리',
    AskUserQuestion: '물어보기',
};
function toolLabel(name) {
    if (name.startsWith('mcp__lively__'))
        return { label: '라이블리 설정' };
    if (name.startsWith('mcp__'))
        return { label: '연결한 도구 사용' };
    return { label: TOOL_LABELS[name] ?? name };
}
/** askHost = 리브가 던진 물음이 앉는 자리. **대화와 같은 칸, 입력 바로 위**에 끼운다. */
export function mountLivChat(host, askHost) {
    let view;
    // 지금 도는 턴 — 멈추려면 무엇을 멈출지 알아야 한다.
    let running = null;
    let stopping = false;
    /** 하던 것 멈추기 — 시작만 할 수 있고 멈추지는 못하면 그건 대화가 아니다. 못 멈췄으면 못 멈췄다고 말한다. */
    async function stopTurn() {
        if (!running || stopping)
            return;
        stopping = true;
        view.setNote('멈추는 중…');
        const r = await api(`/api/ui/me/liv/turn/${encodeURIComponent(running)}/stop`, { method: 'POST', body: '{}' })
            .catch((e) => ({ stopped: false, reason: e.message }));
        if (!r?.stopped) {
            view.setNote(r?.reason || '멈추지 못했습니다 — 리브가 계속 일하고 있습니다.');
            stopping = false;
        }
    }
    view = createChatView(host, {
        who: { me: '나', ai: '리브' },
        placeholder: '리브에게 말하기',
        busyPlaceholder: '리브가 하는 중…',
        toolLabel,
        thinking: 'hide',
        sendWhileBusy: false,
        // 그림은 세션 대화창과 같은 Claude Desktop 문법(상민님 결정 2026-08-18 — "리브도 desktop 스타일로"): 오른쪽 말풍선·이름표 없는 답·
        //  연속 도구 한 줄 접힘·✻. #1631 의 '일지' 그림은 chat-view 의 journal 변형으로 남아 있다(한 플래그).
        style: 'desktop',
        onSend: (text) => sendTurn(text),
        onStop: stopTurn,
        escActive: () => document.body.dataset.route === 'liv' || !!document.body.dataset.ui,
        opening: null, // 첫 화면의 초대는 편지가 한다(#1719 재구성) — 같은 초대를 두 곳에 두지 않는다
        askHost,
    });
    async function drain(turnId, t, from0 = 0) {
        let from = from0;
        let sawText = false;
        let fails = 0;
        let grewAt = Date.now();
        for (;;) {
            let tail;
            try {
                tail = await api(`/api/ui/me/liv/turn/${encodeURIComponent(turnId)}?from=${from}`);
                fails = 0;
            }
            catch (e) {
                // 한 번 끊겼다고 턴을 버리지 않는다 — 리브는 서버에서 계속 일하고 진행도 계속 쌓인다. 오프셋을 들고 다시 붙는다.
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
    /**
     * 지난 대화를 되그린다 — 일지인데 지난 장을 못 펼치면 일지가 아니다.
     * 턴 목록만 받아 각 턴의 진행을 처음부터 한 번씩 읽어 같은 방식으로 그린다. 조각은 건너뛴다(완성본에 같은 글이 있다).
     * 마지막 턴이 아직 돌고 있으면 거기서부터 live 로 이어붙는다.
     */
    async function replayHistory() {
        let chat = null;
        try {
            chat = (await api('/api/ui/me/liv/chat')).chat;
        }
        catch {
            return;
        }
        const turns = chat?.turns ?? [];
        if (!turns.length)
            return;
        view.removeOpening();
        for (const tt of turns) {
            const t = view.turn(tt.text);
            let tail = null;
            try {
                tail = await api(`/api/ui/me/liv/turn/${encodeURIComponent(tt.id)}?from=0`);
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
                // 반나절 전에 시작해 아직도 '도는 중'인 턴 — 실행 세션이 죽어 done 이 안 찍힌 것이다(위 STALL_MS 주석). 잠그지 않는다.
                view.settle(t);
                view.error(t, '이 요청은 끝나지 못했습니다(그때 진행이 멈췄어요). 다시 말씀해 주시면 이어서 해 보겠습니다.');
            }
            else if (!tail.done) {
                running = tt.id;
                stopping = false;
                view.running(t);
                view.busy(true);
                void drain(tt.id, t, tail.next ?? 0).finally(() => { running = null; view.settle(t); view.busy(false); });
            }
            else {
                view.settle(t);
            }
            view.scroll();
        }
    }
    async function sendTurn(text) {
        view.removeOpening();
        const t = view.turn(text);
        view.running(t);
        view.scroll();
        view.busy(true);
        try {
            const r = await api('/api/ui/me/liv/turn', { method: 'POST', body: JSON.stringify({ text }) });
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
            view.input.focus();
        }
    }
    void replayHistory();
    view.input.focus();
}
/**
 * 카드(맡기기·객관식 답·업로드·자격 저장)가 리브에게 말을 거는 **유일한 문**.
 * 리브가 답하는 중이면 버리지 않고 기다린다 — 끝내 못 보내면 친 글은 입력칸에 남겨 사람이 직접 보낼 수 있게 한다.
 */
/**
 * 입력칸에 **담기만** 한다(보내지 않는다). 침묵 화면의 '이런 것도 부탁하실 수 있어요' 가 쓰는 문.
 * 보내기까지 하면 사람이 문장을 고칠 기회를 뺏는다 — 예시는 출발점이지 완성된 지시가 아니다.
 */
export function livChatFill(text) {
    const input = document.querySelector('.livc-input');
    if (!input)
        return;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
}
export function livChatAsk(text) {
    const t0 = Date.now();
    const tryOnce = () => {
        const form = document.querySelector('.livc-compose');
        const input = document.querySelector('.livc-input');
        if (!form || !input)
            return;
        if (input.disabled) {
            if (Date.now() - t0 > 120_000) {
                input.value = text;
                return;
            }
            setTimeout(tryOnce, 500);
            return;
        }
        input.value = text;
        form.requestSubmit();
    };
    tryOnce();
}
