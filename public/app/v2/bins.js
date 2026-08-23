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
import { confirmSessionPurge, sessionNames, sessionTrashOp } from '../session-actions.js';
import { sessText } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isTrashedSess, projName } from './views.js';
const when = (iso) => (iso ? relTime(iso) : '');
const whenMs = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const MAX_ROWS = 8; // 프로젝트 하나 아래 펼쳐 보이는 세션 상한 — 넘치면 '외 n개'가 그 자리에서 편다
// 세션 한 줄 — 이름(프로젝트명 되풀이 걷어낸 것) · 상태 · 시각. 오른쪽 끝은 호출자가 준 조작 단추.
function sessRow(s, pn, actions = [], tail) {
    const t = sessText(s, pn);
    return el('div', { class: 'v2-bin-row' + (isLiveSess(s) ? '' : ' past') }, dot(s.stateKey), el('a', { class: 'tw', href: '#/s/' + encodeURIComponent(s.id), title: (s.label || '') + '\n세션 대화를 엽니다' }, el('span', { class: 't', text: t.main }), t.sub ? el('span', { class: 'p', text: t.sub }) : null), el('span', { class: 'st', text: tail || `${s.stateLabel} · ${whenMs(s.lastSeen)}` }), ...actions);
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
            listEl.replaceChildren(...head.map((s) => sessRow(s, p.name)), ss.length > head.length ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${ss.length - head.length}개 더 보기`, onclick: () => paintList(true) }) : null, !ss.length ? el('p', { class: 'v2-bin-empty', text: '이 프로젝트엔 세션이 없어요.' }) : null);
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
    host.replaceChildren(el('div', { class: 'v2-center v2-bin' }, el('h1', { class: 'v2-title', text: '아카이브' }), el('p', { class: 'v2-desc', text: '통째로 보관한 프로젝트예요. 아래 세션은 그대로 열어 볼 수 있고, [보관 해제]를 누르면 원래 자리로 돌아갑니다.\n보내는 길: 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [아카이브로 보내기], 또는 프로젝트 정보 창의 [보관].' }), projs.length
        ? el('div', { class: 'v2-bin-cards' }, ...projs.map(card))
        : el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '보관한 프로젝트가 없어요.' }), el('p', { class: 'sub', text: '끝났거나 한동안 안 볼 프로젝트를 여기 치워 두면 사이드바가 가벼워져요.' }))));
}
let deletedCache = null;
async function deletedProjects(force = false) {
    if (!force && deletedCache && Date.now() - deletedCache.at < 15000)
        return deletedCache.rows;
    try {
        const d = await api('/api/ui/deleted?limit=100');
        const rows = (Array.isArray(d && d.entries) ? d.entries : []).filter((e) => e && e.entity === 'project' && !e.locked);
        deletedCache = { at: Date.now(), rows };
        return rows;
    }
    catch {
        return deletedCache ? deletedCache.rows : [];
    }
}
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
    const purge = (s) => guard(async () => {
        const name = sessText(s, projName(data, s.projectId)).main || s.id;
        if (!await confirmSessionPurge({ title: `「${name}」을(를) 완전히 지울까요?`, sessions: [{ harness: String((s.raw && s.raw.harness) || '') }] }))
            return;
        try {
            await sessionTrashOp('purge', sessionNames(s));
            toast('완전히 지웠어요.');
            hooks.onChanged?.();
        }
        catch (e) {
            toast('지우지 못했어요 — ' + (e?.message || e), true);
        }
    });
    const empty = () => guard(async () => {
        if (!ss.length)
            return;
        if (!await confirmSessionPurge({ title: '휴지통을 비울까요?', n: ss.length, sessions: ss.map((s) => ({ harness: String((s.raw && s.raw.harness) || '') })) }))
            return;
        try {
            const r = await sessionTrashOp('empty');
            toast(`${r.done.length}개 세션을 완전히 지웠어요.` + (r.skipped.length ? ` (${r.skipped.length}개는 건너뜀)` : ''));
            hooks.onChanged?.();
        }
        catch (e) {
            toast('비우지 못했어요 — ' + (e?.message || e), true);
        }
    });
    const sessRows = ss.map((s) => {
        const pn = projName(data, s.projectId);
        return sessRow(s, pn, [
            el('button', { class: 'btn-text', type: 'button', text: '되돌리기', title: '지난 세션으로 되돌립니다', onclick: () => void restore(s) }),
            el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => void purge(s) }),
        ], (s.projectId ? pn + ' · ' : '') + '버림 ' + when(s.trashedAt));
    });
    // 삭제된 프로젝트 — 감사 스냅샷(서버 휴지통)에서. 비동기라 자리를 먼저 만들고 채운다.
    const projHost = el('div', { class: 'v2-bin-list' }, el('p', { class: 'v2-bin-empty', text: '불러오는 중…' }));
    const projSec = el('section', { class: 'v2-bin-sec', hidden: true }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: '삭제된 프로젝트' })), projHost);
    void deletedProjects().then((rows) => {
        if (!projHost.isConnected)
            return;
        projSec.hidden = !rows.length;
        projHost.replaceChildren(...rows.map((r) => {
            const btn = el('button', { class: 'btn-text', type: 'button', text: '복원', title: '삭제 시점의 프로젝트 본체를 되살립니다(태스크·연결은 함께 지워져 돌아오지 않아요)' });
            btn.onclick = () => {
                btn.disabled = true;
                void api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: 'project', key: r.key }) })
                    .then(() => { toast(`「${r.label}」을(를) 복원했어요.`); deletedCache = null; hooks.onChanged?.(); })
                    .catch((e) => { btn.disabled = false; toast('복원하지 못했어요 — ' + (e?.message || e), true); });
            };
            return el('div', { class: 'v2-bin-row' }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })), el('span', { class: 'tw' }, el('span', { class: 't', text: r.label })), el('span', { class: 'st', text: '삭제 ' + when(r.at) }), btn);
        }));
    });
    host.replaceChildren(el('div', { class: 'v2-center v2-bin' }, el('div', { class: 'v2-bin-top' }, el('div', {}, el('h1', { class: 'v2-title', text: '휴지통' }), el('p', { class: 'v2-desc', text: '버린 세션이에요. [되돌리기]면 지난 세션으로 돌아가고, 완전히 지우는 건 여기서만 할 수 있어요.' })), ss.length ? el('button', { class: 'btn btn-ghost btn-sm v2-bin-emptyb', type: 'button', text: '휴지통 비우기', title: '휴지통의 세션을 전부 완전히 지웁니다', onclick: () => void empty() }) : null), el('section', { class: 'v2-bin-sec' }, el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `세션 · ${ss.length}` })), ss.length
        ? el('div', { class: 'v2-bin-list' }, ...sessRows)
        : el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '휴지통이 비어 있어요.' }), el('p', { class: 'sub', text: '사이드바 [지난 세션]의 행 오른쪽 끝 휴지통 단추로 보낼 수 있어요.' }))), projSec, el('p', { class: 'v2-bin-fine', text: '지식·카테고리의 휴지통은 WIKI 앱에 있어요.' }, el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
}
