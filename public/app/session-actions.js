// session-actions.ts — AI 세션 **종료·목록제거 확인창의 단일 정의**(#1582).
//
// 왜 한 곳에 두나: 같은 동작(DELETE /api/ui/terminal/sessions/:id)이 네 화면에 흩어져 있었고, 화면마다
//  이름도 설명도 달랐다 — AI 세션 탭만 '종료' + 라이블리 모달 + "대화록은 남아요"(#1062)로 고쳐졌고,
//  대시보드 위젯·⋯메뉴·프로젝트 상세는 '삭제' + 브라우저 confirm + **"되돌릴 수 없어요"** 로 남아 있었다.
//  그 문구는 사실이 아니다(아래) — 그런데 가장 파괴적으로 읽히는 말이라, 사람들이 세션을 안 지우고
//  쌓아 두다가 박스 메모리를 잡아먹었다(상민님 신고). 어휘가 갈라지면 반드시 한쪽이 거짓말을 한다.
//
// ── 종료가 실제로 하는 일 (src/terminal/sessions.ts killSession) ──
//  ① tmux kill-session → 그 세션에서 돌던 작업이 즉시 중단된다(여기까지가 되돌릴 수 없는 부분)
//  ② org_session_state(desired-state) 행 삭제 → '복원 가능' 카드가 사라져 [복원] 경로가 끊긴다
//  파일은 **한 줄도 건드리지 않는다** — 작업 폴더·워크트리·커밋·로컬 대화록(~/.claude/…/<uuid>.jsonl) 전부 그대로다.
//  게다가 조직이 세션 공유를 켜 두었으면 대화록이 중앙에도 남아, 「📜 세션 기록」에서 다시 보고
//  「💬 이어 질문하기」(claude --resume)로 그 대화를 이어받을 수 있다.
//
// ⚠ 그래서 어느 쪽으로도 **단언하면 틀린다**: "되돌릴 수 없다"도 거짓이고, "대화록은 항상 남는다"도
//  조직이 세션 공유를 안 켰거나 그 하네스가 캡처 대상이 아니면(claude 만 지원) 거짓이다. 확인창을 그리기
//  직전에 서버에 정책을 물어(sessionLogPolicy) 그 조직·그 세션에서 참인 문장만 쓴다.
import { api, el } from './core.js';
// ⚠ confirmDialog 는 **정의처(ui-primitives)에서 직접** 가져온다 — admin.ts 배럴을 거치면 이 leaf 가
//  페이지 모듈을 역방향으로 끌어와 순환이 된다(admin-collector-presets.ts 와 같은 이유).
import { confirmDialog } from './ui-primitives.js';
// 조회는 세션당 한 번이면 충분하고(조직 설정이라 화면 도중 바뀌지 않는다) 확인창을 여는 순간에만 필요하다.
//  그래서 미리 받아두지 않고 lazy + 프로세스 캐시. 실패하면 null 을 캐시하지 않는다(다음 확인창에서 재시도).
let policyCache = null;
export async function sessionLogPolicy() {
    if (policyCache)
        return policyCache;
    try {
        const d = await api('/api/ui/terminal/session-log-policy');
        const p = {
            enabled: !!(d && d.enabled),
            harnesses: Array.isArray(d && d.harnesses) ? d.harnesses.map((h) => String(h)) : [],
            retentionDays: Number(d && d.retentionDays) || 0,
        };
        policyCache = p;
        return p;
    }
    catch {
        return null;
    } // 게이트웨이가 구버전이거나 네트워크가 죽었을 때 — 확인창은 '항상 참인' 문구로 폴백
}
// 대상 세션들의 하네스 집합. 목록이 비면(호출부가 안 넘겼으면) 판정을 못 하므로 보수 문구로 간다.
const harnessesOf = (sessions) => [...new Set((sessions || []).map((s) => String((s && s.harness) || '')).filter(Boolean))];
function logFate(policy, harnesses) {
    if (!policy)
        return 'unknown';
    if (!policy.enabled)
        return 'none'; // 조직이 세션 공유를 안 켰다 = 중앙에 아무것도 안 올라간다
    if (!harnesses.length)
        return 'unknown';
    const kept = harnesses.filter((h) => policy.harnesses.includes(h)).length;
    return kept === harnesses.length ? 'all' : kept ? 'some' : 'none';
}
// 확인창 하단 안내문 — **그 조직·그 세션에서 참인 문장만**.
//  어느 경우에도 공통으로 참인 사실이 하나 있다: 종료는 파일을 건드리지 않는다. 그걸 먼저 말하고,
//  대화록이 중앙에 남는지는 판정 결과에 따라 덧붙인다.
function keepNote(fate, policy) {
    const keep = '작업 폴더와 파일은 그대로 남습니다.';
    const days = policy && policy.retentionDays > 0 ? ` (기록 ${policy.retentionDays}일 보관)` : '';
    // ⚠ 이모지는 칩(「」) **밖에** 둔다 — 칩 라벨에 공백이 있으면 nowrap 이 안 걸려(uiKeyCls) 좁은 확인창에서
    //  '📜' 와 '세션 기록' 이 서로 다른 줄로 갈라진다(실측). 이모지를 앞에 빼면 갈라져도 문장이 안 깨진다.
    if (fate === 'all')
        return `${keep} 대화 기록도 지워지지 않아요 — 📜 「세션 기록」에 남고, 거기서 💬 「이어 질문하기」로 이어받을 수 있어요.${days}`;
    if (fate === 'some')
        return `${keep} 대화 기록은 claude 세션만 📜 「세션 기록」에 남아 💬 「이어 질문하기」로 이어받을 수 있어요 — 나머지는 이 박스 안에만 남습니다.${days}`;
    if (fate === 'none')
        return `${keep} 대화 기록도 이 종료로는 지워지지 않지만, 📜 「세션 기록」에는 안 올라가 웹에서 다시 열 수는 없어요.`;
    return `${keep} 대화 기록도 이 종료로는 지워지지 않아요.`; // unknown — 확인된 사실만
}
// ── 종료 확인(라이브 세션) — 카드 단건·일괄·⋯메뉴·프로젝트 상세가 **모두 이걸 쓴다**. ──
//  sessions 를 넘기면 하네스로 안내문을 정확히 고르고, 안 넘기면 '항상 참인' 보수 문구가 된다.
export async function confirmSessionEnd(opts) {
    const policy = await sessionLogPolicy();
    const fate = logFate(policy, harnessesOf(opts.sessions));
    return confirmDialog({
        title: opts.title, danger: true, confirmText: '종료', cancelText: '취소',
        message: '실행 중인 작업이 있으면 함께 중단됩니다.',
        lines: opts.lines || [],
        note: keepNote(fate, policy),
        // 기록이 실제로 남는 경우에만 증거를 건넨다 — 안 남는데 링크를 주면 빈 목록이 약속을 배신한다.
        extra: fate === 'all' || fate === 'some' ? sessionLogLink() : null,
    });
}
// ── 목록에서 지우기(restorable 세션) ── tmux 는 이미 죽었으니 끊을 작업이 없다. 지워지는 건 desired-state
//  (그 세션의 폴더·설정·초대를 기억해 둔 카드)뿐이라, '종료'와는 잃는 것이 다르다 → 문구·버튼을 따로 둔다.
export async function confirmSessionForget(opts) {
    const policy = await sessionLogPolicy();
    const fate = logFate(policy, harnessesOf(opts.sessions));
    return confirmDialog({
        title: opts.title, danger: true, confirmText: '지우기', cancelText: '취소',
        message: '이 세션 카드가 목록에서 사라지고, [복원]으로는 다시 열 수 없어요.',
        lines: opts.lines || [],
        note: keepNote(fate, policy),
        extra: fate === 'all' || fate === 'some' ? sessionLogLink() : null,
    });
}
// ── 보관(reclaim=1) ── tmux 만 내리고 desired-state 는 남긴다. 잃는 것은 **돌던 실행뿐**이고,
//  설정·대화 좌표가 DB 에 남아 [되살리기](POST …/restore)가 --resume 으로 그 대화를 이어 붙인다.
//  그래서 이 약속만은 조직의 세션공유 설정과 무관하게 참이다(중앙 기록이 아니라 desired-state + 로컬 대화록에 기댄다).
export async function confirmSessionArchive(opts) {
    return confirmDialog({
        title: opts.title, danger: opts.working, confirmText: '보관', cancelText: '취소',
        message: opts.working ? '지금 돌고 있는 작업은 그 자리에서 멈춥니다.' : '돌고 있는 터미널을 내려놓습니다.',
        lines: [
            '세션이 사라지는 게 아니에요 — 설정과 대화는 그대로 남습니다.',
            '[보관한 세션]에서 [되살리기]를 누르면 그 대화를 이어서 다시 엽니다.',
        ],
    });
}
// 종료·제거 뒤 토스트 — '어디서 다시 볼 수 있는지'를 결과 메시지에서도 한 번 더 말한다(확인창을 읽지 않고
//  누른 사람에게 남는 유일한 안내라서). 중앙에 안 남는 경우엔 그 약속을 하지 않는다.
export async function endedToast(n, sessions) {
    const policy = await sessionLogPolicy();
    const head = n === 1 ? '세션을 종료했어요' : `${n}개 세션을 종료했어요`;
    return logFate(policy, harnessesOf(sessions)) === 'all' ? `${head} — 대화록은 📜 세션 기록에 남아 있어요` : head;
}
// 「📜 세션 기록」으로 가는 링크 — 확인창에서 '정말 남나?'를 그 자리에서 확인하고 싶은 사람을 위해
//  새 탭으로 연다(현재 확인창·작업 흐름을 끊지 않는다). 세션 기록 화면이 곧 그 약속의 증거다.
export function sessionLogLink(text) {
    return el('a', {
        class: 'btn-text', target: '_blank', rel: 'noopener',
        href: location.pathname + '#/sessions', text: text || '📜 세션 기록 열어보기 →',
    });
}
async function fetchFootprint(sid, node) {
    try {
        const d = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/footprint?node=${encodeURIComponent(node || '')}`);
        return {
            tmux_session_id: d?.tmux_session_id ?? null,
            knowledge_created: Array.isArray(d?.knowledge_created) ? d.knowledge_created : [],
            knowledge_edited: Array.isArray(d?.knowledge_edited) ? d.knowledge_edited : [],
            projects: Array.isArray(d?.projects) ? d.projects : [],
            activities: Number(d?.activities) || 0,
        };
    }
    catch {
        return null;
    } // 못 읽으면 대화 기록만 지우는 종전 흐름으로(있지도 않은 목록을 지어내지 않는다)
}
// 체크 한 줄 — 라벨 + (있으면) 그 안에 무엇이 들었는지 이름까지. 목록 없이 개수만 보이면 무엇을 지우는지 모른다.
function checkRow(id, label, names, hint) {
    const box = el('input', { type: 'checkbox', id });
    const kids = [el('span', { class: 'n', text: label })];
    if (hint)
        kids.push(el('span', { class: 'h', text: hint }));
    // ⚠ 제목을 그대로 이어 붙이면 안 된다 — 우리 지식 제목은 200자짜리도 있어서(실측) 확인창이 글자 벽이 된다.
    //  무엇이 사라지는지 알아볼 만큼만 보이면 된다: 한 줄에 하나씩, 42자에서 자른다.
    for (const n of names.slice(0, 5))
        kids.push(el('span', { class: 'l', text: '· ' + (n.length > 42 ? n.slice(0, 42) + '…' : n) }));
    if (names.length > 5)
        kids.push(el('span', { class: 'l', text: `· 외 ${names.length - 5}건` }));
    return { el: el('label', { class: 'sess-purge-row', for: id }, box, el('span', { class: 'b' }, ...kids)), box };
}
export async function confirmSessionPurge(opts) {
    const fp = await fetchFootprint(opts.sid, opts.node || '');
    const kept = ['작업 폴더·파일·커밋은 그대로 남습니다.'];
    if (opts.remoteNode)
        kept.push(`대화 파일이 다른 컴퓨터(${opts.remoteNode})에도 있다면 그건 여기서 지울 수 없어요.`);
    // 아직 도는 세션을 지우면 **이후 대화도 중앙에 안 올라간다**(재수집을 막는 장치라 그 세션 전체가 대상에서 빠진다).
    if (opts.live)
        kept.push('이 세션은 계속 쓸 수 있지만, 앞으로의 대화도 중앙 기록에 남지 않습니다.');
    const boxes = [];
    const rows = [];
    const kc = fp?.knowledge_created ?? [];
    const ke = fp?.knowledge_edited ?? [];
    const pjMine = (fp?.projects ?? []).filter((p) => p.created_here); // 이 세션이 **만든** 프로젝트만 대상이다
    const acts = fp?.activities ?? 0;
    // ⚠ 먼저 항목을 만들고, **하나라도 있을 때만** 머리글을 붙인다. 종전엔 머리글 조건에 `projects.length` 를 써서,
    //  이 세션이 만들지 않은 프로젝트만 붙어 있는 세션에서 **머리글만 뜨고 고를 것이 하나도 없는 화면**이 됐다
    //  (원준 실측 2026-08-23). 고를 것이 없으면 묻지도 않는다.
    if (kc.length) {
        const r = checkRow('pg-kc', `이 세션이 만든 지식 ${kc.length}건 지우기`, kc.map((k) => k.title || k.name));
        rows.push(r.el);
        boxes.push({ kind: 'kc', box: r.box });
    }
    if (ke.length) {
        const r = checkRow('pg-ke', `이 세션이 고친 지식 ${ke.length}건 되돌리기`, ke.map((k) => k.title || k.name), '지우지 않고 이 세션 직전 내용으로 되돌립니다');
        rows.push(r.el);
        boxes.push({ kind: 'ke', box: r.box });
    }
    if (pjMine.length) {
        const r = checkRow('pg-pj', `이 세션이 만든 프로젝트 ${pjMine.length}건 지우기`, pjMine.map((p) => `#${p.id} ${p.name}`));
        rows.push(r.el);
        boxes.push({ kind: 'pj', box: r.box });
    }
    if (acts) {
        const r = checkRow('pg-ac', `이 세션의 작업 기록 ${acts}건 지우기`, []);
        rows.push(r.el);
        boxes.push({ kind: 'ac', box: r.box });
    }
    if (rows.length) {
        // ⚠ **질문형으로 쓰지 않는다.** "…도 함께 정리할까요?" 라고 물으면 사람은 그 물음에 답하는 [예]/[아니오] 를
        //  찾는데, 아래 버튼은 [취소]/[완전 삭제] 뿐이라 "정리는 원치 않는다"를 고를 데가 없어 보인다(원준 지적).
        //  체크박스 묶음의 머리글은 **질문이 아니라 이름표**다 — 답은 체크박스가 하고, 안 고르면 그게 '아니오'다.
        rows.unshift(el('p', { class: 'sess-purge-h' }, el('span', { text: '함께 지울 것을 고르세요' }), el('span', { class: 'sub', text: '고르지 않으면 대화 기록만 지웁니다' })));
    }
    else if (fp && !fp.tmux_session_id) {
        // 다리(대화 uuid ↔ tmux 세션)가 없으면 작업 기록을 **찾을 수 없다**. 없다고 단언하지 않는다.
        rows.push(el('p', { class: 'sess-purge-h' }, el('span', { text: '이 세션이 만든 지식·프로젝트·작업 기록은 찾지 못했어요' }), el('span', { class: 'sub', text: '있더라도 이 삭제로는 지워지지 않고 그대로 남습니다' })));
    }
    const ok = await confirmDialog({
        title: opts.title, danger: true, confirmText: '완전 삭제', cancelText: '취소',
        message: '대화 전문이 중앙 기록에서 영구히 지워지고, 되돌릴 수 없어요.',
        lines: opts.lines || [],
        note: kept.join(' '),
        extra: rows.length ? el('div', { class: 'sess-purge' }, ...rows) : null,
    });
    if (!ok)
        return null;
    const on = (k) => boxes.some((b) => b.kind === k && b.box.checked);
    return {
        log: true,
        knowledge: on('kc') ? kc.map((k) => k.name) : [],
        revert: on('ke') ? ke.map((k) => k.name) : [],
        projects: on('pj') ? pjMine.map((p) => p.id) : [],
        activities: on('ac'),
    };
}
export async function purgeSessionRecord(sid, node, choice) {
    const r = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/purge?node=${encodeURIComponent(node || '')}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choice || { log: true }),
    });
    return {
        bytes: Number(r?.log?.bytes) || 0, subagents: Number(r?.log?.subagents) || 0,
        localFiles: Number(r?.localFiles) || 0, localPending: r?.localPending || null,
        knowledge_deleted: Number(r?.knowledge_deleted) || 0,
        knowledge_reverted: Number(r?.knowledge_reverted) || 0,
        knowledge_revert_failed: Array.isArray(r?.knowledge_revert_failed) ? r.knowledge_revert_failed : [],
        projects_deleted: Number(r?.projects_deleted) || 0,
        activities_deleted: Number(r?.activities_deleted) || 0,
    };
}
// 완전 삭제 뒤 토스트 — 실제로 일어난 일만. 못 한 것(되돌리기 실패·원격 파일)도 숨기지 않는다.
export function purgedToast(r) {
    const kb = r.bytes >= 1024 ? `${Math.round(r.bytes / 1024).toLocaleString()}KB` : `${r.bytes}B`;
    const parts = [`대화 기록을 완전히 지웠어요 (${kb}${r.subagents ? ` · 서브에이전트 ${r.subagents}개` : ''})`];
    if (r.knowledge_deleted)
        parts.push(`지식 ${r.knowledge_deleted}건 삭제`);
    if (r.knowledge_reverted)
        parts.push(`지식 ${r.knowledge_reverted}건 되돌림`);
    if (r.projects_deleted)
        parts.push(`프로젝트 ${r.projects_deleted}건 삭제`);
    if (r.activities_deleted)
        parts.push(`작업 기록 ${r.activities_deleted}건 삭제`);
    if (r.localFiles)
        parts.push(`이 박스의 대화 파일 ${r.localFiles}개도 삭제`);
    if (r.knowledge_revert_failed.length)
        parts.push(`⚠ 되돌릴 판을 못 찾은 지식 ${r.knowledge_revert_failed.length}건은 그대로예요`);
    if (r.localPending)
        parts.push(`⚠ ${r.localPending} 컴퓨터의 파일은 그대로입니다`);
    return parts.join(' · ');
}
