// v2/bins.ts — 아카이브(#/archive) · 휴지통(#/trash) 화면(#1851, 원준 2026-08-23).
//
//  사이드바 발치의 두 행이 여는 **가운데 화면**이다. 둘 다 '치워 둔 것'의 목록이고, 되돌리는 길이 화면 안에 있다.
//   · 아카이브 — 통째로 보관한 프로젝트들. 각 프로젝트 아래 그 세션(지난 세션)이 줄줄이 보인다(원준: "프로젝트들과 그의 하부
//     AI 세션들이 리스트로 쭉 보이는 창"). 세션을 누르면 그 대화가 열리고, 프로젝트는 [보관 해제]로 원래 자리로 돌아간다.
//   · 휴지통 — 버린 세션(내 것). [되돌리기]면 지난 세션으로, [완전 삭제]는 **여기서만**(종전 '완전 삭제' ×의 새 자리).
//     [휴지통 비우기]가 전부를 한 번에. 삭제된 프로젝트(감사 스냅샷 = 옛 #/trash 의 프로젝트 항목)도 아래 묶음으로 보여
//     [복원]이 같은 화면에 있다 — 프로젝트를 버리는 입구(클래식 보드·정보 창)는 여럿인데 되찾는 곳은 하나여야 한다.
//  행의 문법은 홈·확인할 것(v2-now-row)과 같다 — 새 시각 언어를 만들지 않는다.
import { api, el, relTime, sv, toast } from '../core.js';
// 완전 삭제는 두 갈래(#1851 ⟶ #1850): 중앙 기록이 있는 세션은 #1850 의 범위 선택 확인창 + 기록 파기(purgeSessionRecord)를 그대로
//  쓰고, 그 위에 되살리기 좌표(desired-state)까지 지우는 휴지통 op('purge')를 얹는다. 기록이 없는 세션은 좌표만 지운다.
import { confirmSessionPurge, confirmSessionPurgeLocal, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp } from '../session-actions.js';
import { sessText } from './side.js';
import { confirmDialog } from '../ui-primitives.js';
import { dotCls, isArchivedProj, isLiveSess, isTrashedSess, projName } from './views.js';
// ── 재료 적재(#1851) — 삭제된 항목(지식·프로젝트, 서버 휴지통 = 감사 스냅샷) + 보관한 지식(lifecycle=archived). ──
//  main.ts 가 프로젝트 목록과 같은 결로 받아 data.bins 에 둔다(사이드바 개수·두 화면이 같은 재료를 본다). 실패는 빈 목록 — 화면은 "없음"이 아니라
//  서버가 준 것만 말한다(locked 행 — 공개범위 밖이라 스냅샷이 잠긴 것 — 은 복원도 파기도 못 하므로 뺀다).
export async function loadBins() {
    const [del, kn] = await Promise.all([
        api('/api/ui/deleted?limit=500').then((d) => (Array.isArray(d && d.entries) ? d.entries : [])).catch(() => []),
        api('/api/ui/knowledge?lifecycle=archived&limit=500&light=1').then((d) => (Array.isArray(d && d.entries) ? d.entries : [])).catch(() => []),
    ]);
    return {
        deleted: del.filter((e) => e && !e.locked && (e.entity === 'project' || e.entity === 'knowledge'))
            .map((e) => ({ entity: String(e.entity), key: String(e.key), label: String(e.label || ''), at: String(e.at || ''), level: e.level ?? null, title: e.title ?? null })),
        archivedKn: kn.map((k) => ({ name: String(k.name), title: k.title ?? null, updated_at: k.updated_at ?? null, category: k.category_key ?? k.category ?? null })),
    };
}
const binsOf = (data) => data.bins || { deleted: [], archivedKn: [] };
const FOLD = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const DOC = 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6M9 16h6';
const glyphOf = (d, cls) => sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...d.split(' M').map((seg, i) => sv('path', { d: (i ? 'M' : '') + seg })));
// 삭제 항목의 사람 말 — 태스크도 entity='project' 로 쌓인다(#1850 F4). level 로 가른다.
const delKind = (r) => r.entity === 'knowledge' ? '지식' : r.level === 'task' ? '작업' : r.level === 'subtask' ? '하위작업' : '프로젝트';
const knHref = (name) => '#/k/' + encodeURIComponent(name);
const when = (iso) => (iso ? relTime(iso) : '');
const whenMs = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const MAX_ROWS = 8; // 프로젝트 하나 아래 펼쳐 보이는 세션 상한 — 넘치면 '외 n개'가 그 자리에서 편다
// 세션 한 줄 — 이름(프로젝트명 되풀이 걷어낸 것) · 상태 · 시각. 오른쪽 끝은 호출자가 준 조작 단추.
function sessRow(s, pn, actions = [], tail) {
    const t = sessText(s, pn);
    return el('div', { class: 'v2-bin-row' + (isLiveSess(s) ? '' : ' past') }, dot(s.stateKey), el('a', { class: 'tw', href: '#/s/' + encodeURIComponent(s.id), title: (s.label || '') + '\n세션 대화를 엽니다' }, el('span', { class: 't', text: t.main }), 
    // 부제('하던 일')가 이름의 되풀이면 생략 — 이름이 첫 지시에서 잘려 나온 세션은 둘이 같은 문장으로 시작한다(실측).
    t.sub && !t.sub.startsWith(t.main.replace(/…$/, '')) && !t.main.startsWith(t.sub) ? el('span', { class: 'p', text: t.sub }) : null), el('span', { class: 'st', text: tail || `${s.stateLabel} · ${whenMs(s.lastSeen)}` }), ...actions);
}
// ── 아카이브 ──────────────────────────────────────────────────────────────────
export function renderArchive(host, data, hooks = {}) {
    const projs = data.projects.filter((p) => isArchivedProj(p))
        .sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));
    const sessOf = (p) => data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s))
        .sort((a, b) => Number(isLiveSess(b)) - Number(isLiveSess(a)) || b.lastSeen - a.lastSeen);
    const card = (p) => {
        const ss = sessOf(p);
        const live = ss.filter(isLiveSess).length;
        const listEl = el('div', { class: 'v2-bin-list' });
        const paintList = (all) => {
            const head = all ? ss : ss.slice(0, MAX_ROWS);
            // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 배열 스프레드로.
            listEl.replaceChildren(...head.map((s) => sessRow(s, p.name)), ...(ss.length > head.length ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${ss.length - head.length}개 더 보기`, onclick: () => paintList(true) })] : []), ...(!ss.length ? [el('p', { class: 'v2-bin-empty', text: '이 프로젝트엔 세션이 없어요.' })] : []));
        };
        paintList(false);
        const unarch = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제',
            title: '원래 자리(사이드바·보드)로 되돌립니다' });
        unarch.onclick = () => {
            unarch.disabled = true;
            void api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: false }) })
                .then(() => { toast(`「${p.name}」 보관을 해제했어요 — 사이드바로 돌아왔어요.`); hooks.onChanged?.(); })
                .catch((e) => { unarch.disabled = false; toast('보관을 해제하지 못했어요 — ' + (e?.message || e), true); });
        };
        return el('section', { class: 'v2-bin-card' }, el('div', { class: 'v2-bin-head' }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })), el('div', { class: 'tw' }, el('a', { class: 't', href: '#/p/' + p.id, text: p.name, title: '프로젝트 화면을 엽니다' }), el('span', { class: 'p', text: [`#${p.id}`, '보관 ' + when(p.archived_at), `세션 ${ss.length}`, live ? `도는 중 ${live}` : ''].filter(Boolean).join(' · ') })), unarch), listEl);
    };
    // 보관한 지식(lifecycle=archived) — WIKI 문서 ⋯ ▸ [📦 보관]으로 들어온다. 본문·연결은 그대로, 검색·주입에서만 빠진 상태.
    const kns = binsOf(data).archivedKn.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const knRow = (k) => {
        const btn = el('button', { class: 'btn-text', type: 'button', text: '보관 해제', title: '검색·세션 주입·목록에 다시 보입니다' });
        btn.onclick = () => {
            btn.disabled = true;
            void api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) })
                .then(() => { toast(`「${k.title || k.name}」 보관을 해제했어요.`); hooks.onChanged?.(); })
                .catch((e) => { btn.disabled = false; toast('보관을 해제하지 못했어요 — ' + (e?.message || e), true); });
        };
        return el('div', { class: 'v2-bin-row' }, glyphOf(DOC, 'v2-bin-fold sm'), el('a', { class: 'tw', href: knHref(k.name), title: '문서를 엽니다' }, el('span', { class: 't', text: k.title || k.name })), el('span', { class: 'st', text: k.updated_at ? '갱신 ' + when(k.updated_at) : '' }), btn);
    };
    const none = !projs.length && !kns.length;
    host.replaceChildren(el('div', { class: 'v2-center v2-binpage' }, el('h1', { class: 'v2-title', text: '아카이브' }), el('p', { class: 'v2-desc', text: '통째로 보관한 프로젝트와 지식이에요. 지우는 것이 아니라 치워 둔 것 — [보관 해제]를 누르면 원래 자리로 돌아갑니다.\n보내는 길: 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [아카이브로 보내기] · 프로젝트 상세 창의 [보관] · WIKI 문서 ⋯ ▸ [📦 보관].' }), none ? el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '보관한 것이 없어요.' }), el('p', { class: 'sub', text: '끝났거나 한동안 안 볼 프로젝트·지식을 여기 치워 두면 사이드바와 검색이 가벼워져요.' })) : null, projs.length ? el('section', { class: 'v2-bin-sec' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `프로젝트 · ${projs.length}` })), el('div', { class: 'v2-bin-cards' }, ...projs.map(card))) : null, kns.length ? el('section', { class: 'v2-bin-sec' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `지식 · ${kns.length}` })), el('div', { class: 'v2-bin-list' }, ...kns.map(knRow))) : null));
}
// ── 휴지통 ────────────────────────────────────────────────────────────────────
export function renderTrash(host, data, hooks = {}) {
    const ss = data.sessions.filter(isTrashedSess).sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')));
    let busy = false;
    const guard = async (fn) => { if (busy)
        return; busy = true; try {
        await fn();
    }
    finally {
        busy = false;
    } };
    const restore = (s) => guard(async () => {
        try {
            await sessionTrashOp('untrash', sessionNames(s));
            toast('지난 세션으로 되돌렸어요.');
            hooks.onChanged?.();
        }
        catch (e) {
            toast('되돌리지 못했어요 — ' + (e?.message || e), true);
        }
    });
    // 중앙 기록 좌표 — #1850 purgeBtn 과 같은 판정: 접힌 기록(logId)이 있으면 그것, 기록만 남은 행이면 자기 id.
    const logSid = (s) => s.logId || (s.stateKey === 'log' ? s.id : '');
    const logNode = (s) => String((s.logNode ?? s.node) || '');
    const purge = (s) => guard(async () => {
        const name = sessText(s, projName(data, s.projectId)).main || s.id;
        const sid = logSid(s);
        try {
            if (sid) {
                const choice = await confirmSessionPurge({ sid, node: logNode(s), title: `「${name}」을(를) 완전히 지울까요?`, lines: [s.label || sid], remoteNode: logNode(s) || null });
                if (!choice)
                    return;
                const r = await purgeSessionRecord(sid, logNode(s), choice);
                await sessionTrashOp('purge', sessionNames(s)); // 되살리기 좌표까지 — 기록만 지우면 '지난 세션'으로 되돌아온다
                toast(purgedToast(r));
            }
            else {
                if (!await confirmSessionPurgeLocal({ title: `「${name}」을(를) 완전히 지울까요?` }))
                    return;
                await sessionTrashOp('purge', sessionNames(s));
                toast('완전히 지웠어요.');
            }
            hooks.onChanged?.();
        }
        catch (e) {
            toast('지우지 못했어요 — ' + (e?.message || e), true);
        }
    });
    const sessRows = ss.map((s) => {
        const pn = projName(data, s.projectId);
        return sessRow(s, pn, [
            el('button', { class: 'btn-text', type: 'button', text: '되돌리기', title: '지난 세션으로 되돌립니다', onclick: () => void restore(s) }),
            el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => void purge(s) }),
        ], (s.projectId ? pn + ' · ' : '') + '버림 ' + when(s.trashedAt));
    });
    // 삭제된 프로젝트·지식 — 감사 스냅샷(서버 휴지통). [복원] 은 본체만 돌아온다(자식 태스크·연결은 삭제 때 함께 사라져 안 돌아옴 — #1850 F3),
    //  [완전 삭제] 는 스냅샷 본문을 비워 되돌릴 수 없게 한다(행은 남아 '누가 언제'만 남는다 — content_purge).
    const dels = binsOf(data).deleted.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const delProj = dels.filter((r) => r.entity === 'project');
    const delKn = dels.filter((r) => r.entity === 'knowledge');
    const restoreItem = (r, btn) => guard(async () => {
        btn.disabled = true;
        try {
            await api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: r.entity, key: r.key }) });
            toast(`「${r.title || r.label}」을(를) 복원했어요.`);
            hooks.onChanged?.();
        }
        catch (e) {
            btn.disabled = false;
            toast('복원하지 못했어요 — ' + (e?.message || e), true);
        }
    });
    const purgeItem = (r) => guard(async () => {
        const name = r.title || r.label;
        const ok = await confirmDialog({
            title: `「${name}」을(를) 완전히 지울까요?`, danger: true, confirmText: '완전 삭제', cancelText: '취소',
            message: `이 ${delKind(r)}의 보관된 내용이 비워져 [복원]으로도 되살릴 수 없어요.`,
            lines: r.entity === 'knowledge' ? ['변경 이력의 본문도 함께 비워집니다.'] : [],
            note: '누가 언제 지웠는지 기록만 남습니다.',
        });
        if (!ok)
            return;
        try {
            await api('/api/ui/deleted/purge', { method: 'POST', body: JSON.stringify({ entity: r.entity, key: r.key }) });
            toast('완전히 지웠어요.');
            hooks.onChanged?.();
        }
        catch (e) {
            toast('지우지 못했어요 — ' + (e?.message || e), true);
        }
    });
    const delRow = (r) => {
        const rb = el('button', { class: 'btn-text', type: 'button', text: '복원', title: r.entity === 'project' ? '삭제 시점의 본체를 되살립니다(태스크·연결은 함께 지워져 돌아오지 않아요)' : '삭제 시점의 문서를 되살립니다' });
        rb.onclick = () => void restoreItem(r, rb);
        return el('div', { class: 'v2-bin-row' }, glyphOf(r.entity === 'knowledge' ? DOC : FOLD, 'v2-bin-fold sm'), el('span', { class: 'tw' }, el('span', { class: 't', text: r.title || r.label }), r.entity === 'project' && r.level && r.level !== 'project' ? el('span', { class: 'p', text: delKind(r) }) : null), el('span', { class: 'st', text: '삭제 ' + when(r.at) }), rb, el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => void purgeItem(r) }));
    };
    // 수십·수백 건이 쌓여 있다(실측 dev 프로젝트 199건) — 최근 것만 펴고 나머지는 눌러서 본다.
    const HEAD = 12;
    const delSec = (title, rows) => {
        if (!rows.length)
            return null;
        const listEl = el('div', { class: 'v2-bin-list' });
        const paint = (all) => listEl.replaceChildren(...(all ? rows : rows.slice(0, HEAD)).map(delRow), ...(!all && rows.length > HEAD ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${rows.length - HEAD}개 더 보기`, onclick: () => paint(true) })] : []));
        paint(false);
        return el('section', { class: 'v2-bin-sec' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `${title} · ${rows.length}` })), listEl);
    };
    // [휴지통 비우기] — 세션·프로젝트·지식 전부. 한 번의 확인에 무엇이 몇 개인지 적는다.
    const total = ss.length + dels.length;
    const emptyAll = () => guard(async () => {
        if (!total)
            return;
        const bits = [ss.length ? `세션 ${ss.length}개` : '', delProj.length ? `프로젝트·작업 ${delProj.length}개` : '', delKn.length ? `지식 ${delKn.length}개` : ''].filter(Boolean).join(' · ');
        const withLog = ss.filter((s) => !!logSid(s)).length;
        const ok = await confirmDialog({
            title: '휴지통을 비울까요?', danger: true, confirmText: '완전 삭제', cancelText: '취소',
            message: `${bits} — 전부 되돌릴 수 없게 지워져요.`,
            lines: [
                ...(withLog ? [`세션 ${withLog}개는 중앙 대화 기록도 함께 지워집니다.`] : []),
                ...(dels.length ? ['프로젝트·지식은 보관된 내용이 비워져 [복원]이 불가능해집니다.'] : []),
                '세션이 만든 지식·프로젝트는 건드리지 않아요 — 그것까지 정리하려면 행마다 [완전 삭제]를 쓰세요.',
            ],
            note: '작업 폴더·파일·커밋은 그대로 남습니다.',
        });
        if (!ok)
            return;
        let logs = 0;
        let failed = 0;
        let purged = 0;
        for (const s of ss) {
            const sid = logSid(s);
            if (!sid)
                continue;
            try {
                await purgeSessionRecord(sid, logNode(s), { log: true, knowledge: [], revert: [], projects: [], activities: false });
                logs++;
            }
            catch {
                failed++;
            }
        }
        let done = 0;
        if (ss.length) {
            try {
                const r = await sessionTrashOp('empty');
                done = r.done.length;
            }
            catch {
                failed++;
            }
        }
        for (const r of dels) {
            try {
                await api('/api/ui/deleted/purge', { method: 'POST', body: JSON.stringify({ entity: r.entity, key: r.key }) });
                purged++;
            }
            catch {
                failed++;
            }
        }
        toast(`휴지통을 비웠어요 — 세션 ${done}개${logs ? `(기록 ${logs}건 파기)` : ''} · 프로젝트·지식 ${purged}개` + (failed ? ` · ⚠ ${failed}건은 지우지 못했어요` : ''));
        hooks.onChanged?.();
    });
    host.replaceChildren(el('div', { class: 'v2-center v2-binpage' }, el('div', { class: 'v2-bin-top' }, el('div', {}, el('h1', { class: 'v2-title', text: '휴지통' }), el('p', { class: 'v2-desc', text: '버린 세션·프로젝트·지식이에요. [되돌리기]·[복원]이면 원래 자리로 돌아가고, 완전히 지우는 건 여기서만 할 수 있어요.' })), total ? el('button', { class: 'btn btn-ghost btn-sm v2-bin-emptyb', type: 'button', text: '휴지통 비우기', title: '휴지통의 세션·프로젝트·지식을 전부 완전히 지웁니다', onclick: () => void emptyAll() }) : null), !total ? el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '휴지통이 비어 있어요.' }), el('p', { class: 'sub', text: '세션은 [지난 세션] 행의 휴지통 단추로, 프로젝트·지식은 각 화면의 [삭제]로 여기 옵니다.' })) : null, ss.length ? el('section', { class: 'v2-bin-sec' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `세션 · ${ss.length}` })), el('div', { class: 'v2-bin-list' }, ...sessRows)) : null, delSec('프로젝트 · 작업', delProj), delSec('지식', delKn), el('p', { class: 'v2-bin-fine', text: '카테고리(분류축)의 휴지통은 WIKI 앱에 있어요.' }, el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
}
