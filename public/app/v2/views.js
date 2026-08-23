// v2/views.ts — 새 셸의 중앙 화면 셋(#1719): 홈(미선택) · 프로젝트 · 세션. 데이터는 main.ts 가 모아 넘긴다(V2Data).
//  홈은 **입력창 하나**(claude.ai 홈처럼 — Enter 로 프로젝트 없는 세션이 열린다, v2/quick-session.ts)이고,
//  프로젝트는 v2/project-view.ts(#1757 — 짧은 개요 + 리브 대화), 세션은 그 세션 자체(대화창 — 라이브 또는 중앙 기록)를 실는다. 리브 대화는 #/liv 에 있다.
//  클래식 모듈을 **복제하지 않는다** — 대화·세션 목록·프로젝트 상세는 이미 있는 것을 가져다 붙인다.
import { el, relTime, state, toast } from '../core.js';
import { isCreatingQuickSession, openQuickSession, takeFirstPrompt } from './quick-session.js';
import { createRunPicker } from './run-picker.js';
import { mountSessionChat } from '../session-chat.js';
import { sessIsDead, sessLabel, sessStateKey, shouldRestoreOnOpen } from '../session-status.js';
import { soloSessionUrl, terminalUrl } from './apps.js';
const dot = (k) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
// 상태 key(web/session-status.ts) → 점 색 클래스. 눈에 띄어야 할 셋만 색이다 — 작업 중(파랑·깜빡)·확인 필요(앰버)·작업 완료(민트 링).
//  나머지 살아 있는 것(대기·오프라인·셸)은 회색 계열로 조용히, 끝난 것(중단됨·종료됨·기록)은 빈 점.
export function dotCls(stateKey) {
    if (stateKey === 'busy')
        return 'busy';
    if (stateKey === 'waiting')
        return 'wait';
    if (stateKey === 'done')
        return 'done';
    if (stateKey === 'idle')
        return 'idle';
    if (stateKey === 'offline')
        return 'off';
    if (stateKey === 'shell')
        return 'shell';
    return '';
}
const when = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
// ── '지금 도는 세션' vs '지난 세션' — 화면 셋이 같은 술어를 쓴다(#1808) ───────────────
//  · 도는 세션 = 박스가 tmux 에 살아 있는 것.
//  · 지난 세션 = **되살릴 수 있는 것 전부** — 자동회수·재부팅으로 멈춘 박스(중단됨), 내가 끝낸 박스(종료됨),
//    메모리 부족으로 죽은 박스(메모리 부족), 그리고 박스는 없고 중앙에 대화만 남은 것(기록).
//    사용자에겐 넷 다 "다시 이어서 할 수 있는 지난 세션"이라 한 묶음으로 다룬다(구분은 상태점·툴팁·세션 화면이 말한다).
export const isLiveSess = (s) => s.live && s.alive;
export const isPastSess = (s) => !isLiveSess(s);
// 휴지통(#1851) — 멈춘 세션 중 사람이 휴지통으로 보낸 것. 사이드바·홈·확인할 것 어디에도 안 나오고 휴지통 화면에만 있다.
export const isTrashedSess = (s) => !!s.trashedAt;
export const isArchivedProj = (p) => !!(p && p.archived_at);
/** 그 세션이 '하던 일' — 하네스 pane 제목이 정본이고, 없으면(멈춘 세션) 중앙 기록의 대화 제목(= 처음 시킨 말). */
export const sessWork = (s) => String((s.raw && s.raw.title) || s.logTitle || '').trim();
/** 화면에 쓸 세션 이름 — 이름이 프로젝트명 그대로면 '하던 일'이 그 자리를 받는다(같은 이름 대여섯 줄 방지). */
export function sessDisplayName(s, projectName) {
    const label = String(s.label || '').trim();
    const work = sessWork(s);
    if (work && work !== label && label === projectName)
        return work;
    return label || work || '이름 없는 세션';
}
// ── 홈 = 런처 (#1719 재설계 · #1798 행선지 제거) — 입력창이 주인공이다 ──────────
//  · 입력은 **항상 프로젝트 없는 세션**으로 열린다(세션 전용 폴더). 종전의 행선지 자동매칭·프로젝트 드롭다운은
//    #1798 에서 제거 — 이름 토큰 매칭의 오연결이 잦았고(무관한 프로젝트에 세션이 붙는 실측), 소속은 세션이
//    맥락을 갖춘 뒤에 정하는 게 맞다(미연결 첫 쓰기 훅이 새 프로젝트 생성을 기본으로 유도 · 상단바 수동 연결 #1749).
//  · Enter → 세션 생성 → 세션 대화 화면. 리브 대화는 홈에 두지 않는다(#/liv 가 그 자리).
//  · '지금 도는 세션'은 **답 기다리는 것 먼저**, 세션 이름과 프로젝트가 같으면 한 번만 쓴다(같은 말 두 줄 금지).
export function renderHome(host, data) {
    const me = state.me || {};
    const name = String(me.display_name || me.email || me.userId || '');
    const live = data.sessions.filter((s) => s.live && s.alive);
    const busy = live.filter((s) => s.stateKey === 'busy').length;
    const waiting = live.filter((s) => s.stateKey === 'waiting').length;
    const h = new Date().getHours();
    const tod = h < 12 ? '좋은 아침이에요' : h < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
    const d = new Date();
    const KO_DAY = ['일', '월', '화', '수', '목', '금', '토'];
    const ta = el('textarea', { class: 'v2-launch-in', rows: '2', placeholder: '무엇이든 시키세요 — 프로젝트 없이 열리고, 소속은 나중에 세션에서 정해요', 'aria-label': '무엇이든 시키기' });
    const send = el('button', { class: 'btn btn-primary v2-launch-send', type: 'button' }, el('span', { text: '시키기' }), el('kbd', { text: '⏎' }));
    // [시키기] 왼쪽 세 칸 — 제공자(어느 회사 모델)·모델·추론강도(#1758). 기본은 내가 지난번에 고른 값이고,
    //  여기서 바꾸면 그게 다음 기본이 된다(v2/run-picker.ts — '새 AI 세션' 폼과 같은 기억을 쓴다).
    const runPicker = createRunPicker();
    const card = el('div', { class: 'v2-launch' }, ta, el('div', { class: 'v2-launch-row' }, el('div', { class: 'v2-launch-ctl' }, runPicker.el), send));
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
    const submit = async () => {
        const text = ta.value.trim();
        if (!text || isCreatingQuickSession())
            return;
        send.disabled = true;
        ta.disabled = true;
        runPicker.disable(true);
        send.replaceChildren(el('span', { text: '여는 중…' }));
        const ok = await openQuickSession(text, { run: runPicker.value() });
        if (!ok) {
            send.disabled = false;
            ta.disabled = false;
            runPicker.disable(false);
            send.replaceChildren(el('span', { text: '시키기' }), el('kbd', { text: '⏎' }));
            ta.focus();
        }
    };
    send.onclick = () => { void submit(); };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void submit();
        }
    });
    host.replaceChildren(el('section', { class: 'v2-home v2-home-launch' }, el('div', { class: 'v2-home-eyebrow' }, el('span', { text: `${d.getMonth() + 1}월 ${d.getDate()}일 ${KO_DAY[d.getDay()]}요일` }), 
    // 세션이 하나도 안 돌면 그 말 자체를 안 한다 — '도는 세션 없음'은 정보가 아니라 빈자리 채우기다.
    busy ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st busy' }, dot('busy'), `작업 중 ${busy}`)] : null, waiting ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'st wait' }, dot('waiting'), `답 기다림 ${waiting}`)] : null), el('h1', { class: 'v2-h1', text: `${tod}${name ? ', ' + name + '님' : ''}.` }), el('p', { class: 'v2-home-sub', text: '무엇을 할까요?' }), card));
    // ★ 홈에서 세션 목록을 걷었다(원준 2026-08-20 "이 부분 내용 빼고, 텍스트 치는 칸을 자연스러운 위치로").
    //  왜: 같은 목록이 **사이드바(프로젝트 폴더 안 세션)**·**[확인할 것]**·**AI 세션 앱** 셋에 이미 있고,
    //  홈은 '무엇이든 시키는 자리' 하나로 충분하다. 게다가 그 목록에는 자동 이름짓기 프롬프트처럼 사람이 시킨 적
    //  없는 기록까지 이름으로 올라와(실측) 첫 화면이 잡동사니로 읽혔다. 시키는 칸은 화면 가운데로 올린다.
    window.setTimeout(() => { grow(); ta.focus(); }, 30);
}
// nowList(돌고 있어요 · 답을 기다려요 · 이어서 할 수 있어요)는 홈에서 걷었다(원준 2026-08-20).
//  그 세 결은 다른 자리가 이미 맡고 있다 — 답 기다림·완료는 [확인할 것], 살아 있는 세션은 사이드바의 프로젝트 폴더,
//  지난 세션은 그 폴더의 '지난 세션'과 AI 세션 앱. 홈에 네 번째 사본을 두지 않는다.
// ── 확인할 것(#1719 사이드바 개편 안2) — 시키다→기다리다→**확인**의 병목을 한 화면에 모은다 ───────
//  · 답을 기다려요: 승인·선택을 기다리는 세션(waiting) — 보이는 것 전부(프로젝트 세션은 팀 누구든 답할 수 있다).
//  · 끝났어요: 시킨 작업이 끝났는데 아직 안 본 세션(stateKey 'done') — 내 것만(남의 완료를 내가 '확인'할 일은 없다).
//  행은 홈의 nowList 와 같은 문법(v2-now-row) — 새 시각 언어를 만들지 않는다. 들어가 보면(lastAttached 갱신) 목록에서 빠진다.
export function renderInbox(host, data) {
    const waits = data.sessions.filter((s) => isLiveSess(s) && s.stateKey === 'waiting').sort((a, b) => b.lastSeen - a.lastSeen);
    const dones = data.sessions.filter((s) => isLiveSess(s) && s.stateKey === 'done' && s.owned).sort((a, b) => b.lastSeen - a.lastSeen);
    const rowOf = (s) => {
        const pn = projName(data, s.projectId);
        const title = sessDisplayName(s, pn);
        return el('a', { class: 'v2-now-row' + (s.stateKey === 'waiting' ? ' wait' : ''), href: '#/s/' + encodeURIComponent(s.id) }, dot(s.stateKey), el('span', { class: 'tw' }, el('span', { class: 't', text: title }), s.projectId && title !== pn ? el('span', { class: 'p', text: pn }) : null), el('span', { class: 'st', text: when(s.lastSeen) }), el('span', { class: 'go btn btn-sm', text: s.stateKey === 'waiting' ? '답하기' : '보기' }));
    };
    host.replaceChildren(el('div', { class: 'v2-center v2-inbox' }, el('h1', { class: 'v2-title', text: '확인할 것' }), el('p', { class: 'v2-desc', text: '내 답이나 확인을 기다리는 세션이에요. 들어가 보면 목록에서 빠집니다.' }), (!waits.length && !dones.length)
        ? el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '지금 확인할 것이 없어요.' }), el('p', { class: 'sub', text: '세션이 답을 기다리거나 작업을 끝내면 여기에 모입니다.' }))
        : el('div', { class: 'v2-now' }, waits.length ? el('section', { class: 'v2-now-wait' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k wait', text: `답을 기다려요 · ${waits.length}` })), ...waits.map(rowOf)) : null, dones.length ? el('section', {}, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `끝났어요 — 확인만 하면 돼요 · ${dones.length}` })), ...dones.map(rowOf)) : null)));
}
export function projName(data, id) {
    if (!id)
        return '프로젝트 없음';
    const p = data.projects.find((x) => Number(x.id) === Number(id));
    return p ? p.name : `프로젝트 #${id}`;
}
export function renderSession(host, data, id, vopts = {}) {
    // 기록(uuid) 링크로 들어왔는데 그 대화를 도는 박스가 있으면 그 박스가 정본이다(mergeSessions 가 기록을 박스에 접었다) — 옛 링크가 산다.
    const s = data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);
    if (!s) {
        host.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 찾을 수 없어요. 목록을 새로고침해 주세요.' })));
        return null;
    }
    // 프레임에 실을 터미널은 embed=1 — 그 안의 상단바·파일 탐색기는 이 화면의 상단바·우패널로 이미 합쳐졌다(#1744).
    //  ⚠ **살아 있는 박스에만** 물린다. 종전엔 `s.live`(= terminal/sessions 행이면 참, 중단된 박스도 참)만 봐서
    //   멈춘 세션을 열면 없는 tmux 에 붙었고, terminal.html 이 4410 → **iframe 안에서 자동 복원 + location.replace**
    //   를 해 버렸다: 셸 주소(#/s/<옛 id>)·탭 제목·사이드바는 옛 세션 그대로인데 프레임만 새 세션인 어긋난 화면이
    //   되고, 그 뒤 [이어서 대화하기] 를 누르면 옛 desired-state 가 이미 지워져 404 가 났다. 멈춘 세션의 정답은
    //   **읽기전용 기록 + [이어서 대화하기] 한 번**(session-chat.ts paintDeadFooter)이다.
    const termSrc = s.live && s.alive ? terminalUrl(s.id, s.label, s.node, { embed: true }) : null;
    return mountSessionChat(host, { ...s, projectName: projName(data, s.projectId) }, {
        terminalSrc: termSrc,
        // 나가는 문: 본 화면이면 이 세션만 담은 **팝아웃 창**(같은 컴포넌트, 사이드바만 없다), 팝아웃 창이면 반대로 전체 화면.
        openHref: vopts.solo ? location.pathname + '#/s/' + encodeURIComponent(s.id) : soloSessionUrl(s.id),
        // 홈 입력창이 방금 연 세션이면 그 첫 지시를 낙관적으로 먼저 그린다(서버가 하네스 입력창이 뜬 뒤 실제로 넣는다).
        firstPrompt: takeFirstPrompt(s.id),
        trail: vopts.trail || null,
        onPickProject: vopts.onPickProject, // 상단바 [프로젝트 연결] 드롭다운(#1749)
        onRename: vopts.onRename, // 제목 = 세션 이름(#1719) — 고치면 사이드바·목록이 그 이름으로 바뀐다
        onArchive: vopts.onArchive,
        onToggleFiles: vopts.onToggleFiles, // 상단바 [파일] → 우패널 파일 탐색기(#1744)
        solo: vopts.solo,
        // ★ #1820 — 멈춘 내 세션은 **열면 바로 되살린다**. 위 주석의 '읽기전용 기록 + 버튼 한 번'은 화면이 어긋나던
        //  사고(#1808)의 처방이었는데, 그 처방이 "열어도 아무 일도 안 난다"를 기본 경험으로 만들었다(dev 실측:
        //  내 세션 219건 중 복원 가능 198건). 어긋남의 원인은 '자동'이 아니라 **프레임이 몰래 갈아탄 것**이었으므로,
        //  셸이 라우팅까지 쥐고 되살리면 둘 다 만족한다. 실패하면 그 기록 화면과 버튼이 그대로 남는다.
        //  휴지통에 있는 것은 예외(trashed — 판정표 session-status.ts 참조, #1851).
        autoResume: shouldRestoreOnOpen({ restorable: !!s.raw?.restorable, owned: s.owned, trashed: isTrashedSess(s) }),
        isVisible: vopts.isVisible,
        onResumed: vopts.onResumed,
    });
}
// ── 데이터 정규화 — 라이브(terminal/sessions) + 기록(v6/sessions) 를 한 목록으로 ─────────
//  같은 세션이 두 목록에 있으면 한 장으로: 라이브 행의 claudeSessionId(박스가 도는 대화 uuid) == 기록 행의 session_id 면
//  기록 행을 라이브 행에 접는다(logId·logNode). 종전엔 '박스 1장 + 그 대화의 기록 1장'이 나란히 떠 같은 세션이 둘로 보였다.
export function mergeSessions(liveRows, logRows) {
    const now = Date.now();
    const out = new Map();
    const byUuid = new Map();
    for (const r of liveRows || []) {
        const k = sessStateKey(r, now);
        const s = {
            id: String(r.id), label: String(r.label || r.title || r.id), projectId: r.projectId ? Number(r.projectId) : null,
            // 노드 세션의 node 는 {id,name,online} 객체다 — id 만 든다(터미널 URL·중앙 기록 좌표에 문자열로 쓴다).
            node: r.node && typeof r.node === 'object' ? (String(r.node.id || '') || null) : (r.node ? String(r.node) : null),
            live: true, alive: !sessIsDead(r, now), owned: !!r.owned, stateKey: k, stateLabel: sessLabel(r, now),
            lastSeen: Number(r.lastActive || r.created || 0) * (String(r.lastActive || r.created || 0).length > 11 ? 1 : 1000) || 0, raw: r,
            trashedAt: r.trashedAt ? String(r.trashedAt) : null, // #1851 — 서버가 내 휴지통 표식을 행에 얹는다
        };
        out.set(s.id, s);
        if (r.claudeSessionId && !byUuid.has(String(r.claudeSessionId)))
            byUuid.set(String(r.claudeSessionId), s);
    }
    for (const r of logRows || []) {
        const id = String(r.session_id);
        if (out.has(id))
            continue;
        const owner = byUuid.get(id);
        if (owner) { // 라이브(또는 복원 가능) 박스가 이 대화를 돌린다 — 그 카드에 접는다
            owner.logId = id;
            owner.logNode = r.node_id || '';
            if (r.title)
                owner.logTitle = String(r.title); // 이름 자리의 폴백(위 logTitle 주석)
            if (!owner.projectId && r.project_id != null)
                owner.projectId = Number(r.project_id);
            if (!owner.trashedAt && r.trashed_at)
                owner.trashedAt = String(r.trashed_at); // 두 이름 중 한쪽에만 표식이 있어도 그 세션은 휴지통
            continue;
        }
        out.set(id, {
            id, label: String(r.title || id), projectId: r.project_id != null ? Number(r.project_id) : null, node: r.node_id || null,
            live: false, alive: false, owned: true, stateKey: 'log', stateLabel: '기록', lastSeen: r.last_seen ? new Date(r.last_seen).getTime() : 0, raw: r,
            trashedAt: r.trashed_at ? String(r.trashed_at) : null,
        });
    }
    return [...out.values()];
}
export function toastOnce(msg) { toast(msg); }
