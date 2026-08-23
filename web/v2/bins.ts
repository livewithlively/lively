// v2/bins.ts — 아카이브(#/archive) · 휴지통(#/trash) 화면(#1851, 원준 2026-08-23).
//
//  사이드바 발치의 두 행이 여는 **가운데 화면**이다. 둘 다 '치워 둔 것'의 목록이고, 되돌리는 길이 화면 안에 있다.
//   · 아카이브 — 통째로 보관한 프로젝트들. 각 프로젝트 아래 그 세션(지난 세션)이 줄줄이 보인다(원준: "프로젝트들과 그의 하부
//     AI 세션들이 리스트로 쭉 보이는 창"). 세션을 누르면 그 대화가 열리고, 프로젝트는 [보관 해제]로 원래 자리로 돌아간다.
//   · 휴지통 — **프로젝트에서 떼어낸 세션**(내 것)만 담는다(원준 2026-08-24 확정: "아카이브엔 프로젝트 단위로 넣고 빼면 프로젝트+하위
//     세션이 전부 들어가고, 휴지통은 프로젝트에서 분리된 세션들이 들어가는 방식"). [되돌리기]면 지난 세션으로, [완전 삭제]는 **여기서만**
//     (종전 '완전 삭제' ×의 새 자리). [휴지통 비우기]가 전부를 한 번에. 프로젝트·지식·카테고리의 삭제(감사 스냅샷)는 종전대로 WIKI 앱의
//     휴지통이 맡는다 — 한때 여기 묶음으로 넣었다가(2차) 되돌렸다(지식 archive-trash-v2-shell-1851 참고).
//  행의 문법은 홈·확인할 것(v2-now-row)과 같다 — 새 시각 언어를 만들지 않는다.
import { api, el, relTime, sv, toast } from '../core.js';
// 완전 삭제는 두 갈래(#1851 ⟶ #1850): 중앙 기록이 있는 세션은 #1850 의 범위 선택 확인창 + 기록 파기(purgeSessionRecord)를 그대로
//  쓰고, 그 위에 되살리기 좌표(desired-state)까지 지우는 휴지통 op('purge')를 얹는다. 기록이 없는 세션은 좌표만 지운다.
import { confirmSessionPurge, confirmSessionPurgeLocal, confirmTrashEmpty, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp } from '../session-actions.js';
import { sessText } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isTrashedSess, projName, type Proj, type Sess, type V2Data } from './views.js';

export interface BinHooks { onChanged?: () => void }

const when = (iso: string | null | undefined): string => (iso ? relTime(iso) : '');
const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const MAX_ROWS = 8;   // 프로젝트 하나 아래 펼쳐 보이는 세션 상한 — 넘치면 '외 n개'가 그 자리에서 편다

// 세션 한 줄 — 이름(프로젝트명 되풀이 걷어낸 것) · 상태 · 시각. 오른쪽 끝은 호출자가 준 조작 단추.
function sessRow(s: Sess, pn: string, actions: HTMLElement[] = [], tail?: string): HTMLElement {
  const t = sessText(s, pn);
  return el('div', { class: 'v2-bin-row' + (isLiveSess(s) ? '' : ' past') },
    dot(s.stateKey),
    el('a', { class: 'tw', href: '#/s/' + encodeURIComponent(s.id), title: (s.label || '') + '\n세션 대화를 엽니다' },
      el('span', { class: 't', text: t.main }),
      // 부제('하던 일')가 이름의 되풀이면 생략 — 이름이 첫 지시에서 잘려 나온 세션은 둘이 같은 문장으로 시작한다(실측).
      t.sub && !t.sub.startsWith(t.main.replace(/…$/, '')) && !t.main.startsWith(t.sub) ? el('span', { class: 'p', text: t.sub }) : null),
    el('span', { class: 'st', text: tail || `${s.stateLabel} · ${whenMs(s.lastSeen)}` }),
    ...actions);
}

// ── 아카이브 ──────────────────────────────────────────────────────────────────
export function renderArchive(host: HTMLElement, data: V2Data, hooks: BinHooks = {}): void {
  const projs = data.projects.filter((p) => isArchivedProj(p))
    .sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));
  const sessOf = (p: Proj): Sess[] => data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s))
    .sort((a, b) => Number(isLiveSess(b)) - Number(isLiveSess(a)) || b.lastSeen - a.lastSeen);
  const card = (p: Proj): HTMLElement => {
    const ss = sessOf(p);
    const live = ss.filter(isLiveSess).length;
    const listEl = el('div', { class: 'v2-bin-list' });
    const paintList = (all: boolean): void => {
      const head = all ? ss : ss.slice(0, MAX_ROWS);
      // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 배열 스프레드로.
      listEl.replaceChildren(
        ...head.map((s) => sessRow(s, p.name)),
        ...(ss.length > head.length ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${ss.length - head.length}개 더 보기`, onclick: () => paintList(true) })] : []),
        ...(!ss.length ? [el('p', { class: 'v2-bin-empty', text: '이 프로젝트엔 세션이 없어요.' })] : []));
    };
    paintList(false);
    const unarch = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제',
      title: '원래 자리(사이드바·보드)로 되돌립니다' }) as HTMLButtonElement;
    unarch.onclick = () => {
      unarch.disabled = true;
      void api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: false }) })
        .then(() => { toast(`「${p.name}」 보관을 해제했어요 — 사이드바로 돌아왔어요.`); hooks.onChanged?.(); })
        .catch((e: any) => { unarch.disabled = false; toast('보관을 해제하지 못했어요 — ' + (e?.message || e), true); });
    };
    return el('section', { class: 'v2-bin-card' },
      el('div', { class: 'v2-bin-head' },
        sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })),
        el('div', { class: 'tw' },
          el('a', { class: 't', href: '#/p/' + p.id, text: p.name, title: '프로젝트 화면을 엽니다' }),
          el('span', { class: 'p', text: [`#${p.id}`, '보관 ' + when(p.archived_at), `세션 ${ss.length}`, live ? `도는 중 ${live}` : ''].filter(Boolean).join(' · ') })),
        unarch),
      listEl);
  };
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage' },
    el('h1', { class: 'v2-title', text: '아카이브' }),
    el('p', { class: 'v2-desc', text: '통째로 보관한 프로젝트예요. 아래 세션은 그대로 열어 볼 수 있고, [보관 해제]를 누르면 원래 자리로 돌아갑니다.\n보내는 길: 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [아카이브로 보내기], 또는 프로젝트 상세 창의 [보관].' }),
    projs.length
      ? el('div', { class: 'v2-bin-cards' }, ...projs.map(card))
      : el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '보관한 프로젝트가 없어요.' }),
          el('p', { class: 'sub', text: '끝났거나 한동안 안 볼 프로젝트를 여기 치워 두면 사이드바가 가벼워져요.' }))));
}

// ── 휴지통 ────────────────────────────────────────────────────────────────────
export function renderTrash(host: HTMLElement, data: V2Data, hooks: BinHooks = {}): void {
  const ss = data.sessions.filter(isTrashedSess).sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')));
  let busy = false;
  const guard = async (fn: () => Promise<void>): Promise<void> => { if (busy) return; busy = true; try { await fn(); } finally { busy = false; } };

  // ⚠ 서버는 못 한 이름을 **200 + skipped** 로 돌려준다(남의 것·없는 것·아직 도는 것). 그걸 안 읽으면 아무것도 안 됐는데
  //  "됐어요"라고 말하게 된다 — 실측(원준 2026-08-24): 완전 삭제를 눌러도 행이 그대로 남고 [되돌리기]가 살아 있는데 토스트는
  //  "완전히 지웠어요"였다. 한 이름도 처리되지 않았으면 실패로, 일부만 됐으면 그 사실대로 말한다(사이드바 '휴지통으로'와 같은 규칙).
  const outcome = (r: { done: string[]; skipped: Array<{ id: string; why: string }> }, okMsg: string, failMsg: string): boolean => {
    if (!r.done.length) { toast(failMsg + ' — ' + (r.skipped[0]?.why || '처리된 세션이 없어요'), true); return false; }
    toast(okMsg + (r.skipped.length ? ` (일부는 건너뜀 — ${r.skipped[0].why})` : ''));
    return true;
  };
  const restore = (s: Sess): Promise<void> => guard(async () => {
    try {
      const r = await sessionTrashOp('untrash', sessionNames(s));
      if (!outcome(r, '지난 세션으로 되돌렸어요.', '되돌리지 못했어요')) return;
      hooks.onChanged?.();
    } catch (e: any) { toast('되돌리지 못했어요 — ' + (e?.message || e), true); }
  });
  // 중앙 기록 좌표 — #1850 purgeBtn 과 같은 판정: 접힌 기록(logId)이 있으면 그것, 기록만 남은 행이면 자기 id.
  const logSid = (s: Sess): string => s.logId || (s.stateKey === 'log' ? s.id : '');
  const logNode = (s: Sess): string => String((s.logNode ?? s.node) || '');
  const purge = (s: Sess): Promise<void> => guard(async () => {
    const name = sessText(s, projName(data, s.projectId)).main || s.id;
    const sid = logSid(s);
    try {
      if (sid) {
        const choice = await confirmSessionPurge({ sid, node: logNode(s), title: `「${name}」을(를) 완전히 지울까요?`, lines: [s.label || sid], remoteNode: logNode(s) || null });
        if (!choice) return;
        const r = await purgeSessionRecord(sid, logNode(s), choice);
        // 되살리기 좌표·휴지통 표식까지 — 기록만 지우면 '지난 세션'으로 되돌아온다. 기록은 이미 지워졌으므로 여기서 막히면
        //  "기록은 지웠는데 행은 남았다"는 **부분 성공**이다 — 그걸 성공으로 포장하지 않는다.
        const m = await sessionTrashOp('purge', sessionNames(s));
        if (!m.done.length) { toast('대화 기록은 지웠지만 휴지통에서 빼지 못했어요 — ' + (m.skipped[0]?.why || '처리된 세션이 없어요'), true); hooks.onChanged?.(); return; }
        toast(purgedToast(r));
      } else {
        if (!await confirmSessionPurgeLocal({ title: `「${name}」을(를) 완전히 지울까요?` })) return;
        const m = await sessionTrashOp('purge', sessionNames(s));
        if (!outcome(m, '완전히 지웠어요.', '지우지 못했어요')) return;
      }
      hooks.onChanged?.();
    } catch (e: any) { toast('지우지 못했어요 — ' + (e?.message || e), true); }
  });
  const empty = (): Promise<void> => guard(async () => {
    if (!ss.length) return;
    // 비우기는 한 번의 확인으로 전부 — 범위 선택(지식·프로젝트)은 세션마다 달라 여기서 묻지 않는다: **대화 기록만** 지운다
    //  (기본값과 같다). 지식·프로젝트까지 함께 정리하려면 행별 [완전 삭제]로.
    if (!await confirmTrashEmpty({ n: ss.length, withLog: ss.filter((s) => !!logSid(s)).length })) return;
    let logs = 0; let failed = 0;
    for (const s of ss) {
      const sid = logSid(s);
      if (!sid) continue;
      try { await purgeSessionRecord(sid, logNode(s), { log: true, knowledge: [], revert: [], projects: [], activities: false }); logs++; }
      catch { failed++; }
    }
    try {
      const r = await sessionTrashOp('empty');
      toast(`${r.done.length}개 세션을 완전히 지웠어요.` + (logs ? ` 대화 기록 ${logs}건 파기.` : '') + (failed ? ` ⚠ 기록 ${failed}건은 지우지 못했어요.` : '') + (r.skipped.length ? ` (${r.skipped.length}개는 건너뜀)` : ''));
      hooks.onChanged?.();
    } catch (e: any) { toast('비우지 못했어요 — ' + (e?.message || e), true); }
  });

  const sessRows = ss.map((s) => {
    const pn = projName(data, s.projectId);
    return sessRow(s, pn, [
      el('button', { class: 'btn-text', type: 'button', text: '되돌리기', title: '지난 세션으로 되돌립니다', onclick: () => void restore(s) }),
      el('button', { class: 'btn-text danger', type: 'button', text: '완전 삭제', title: '되살릴 수 없게 지웁니다', onclick: () => void purge(s) }),
    ], (s.projectId ? pn + ' · ' : '') + '버림 ' + when(s.trashedAt));
  });

  host.replaceChildren(el('div', { class: 'v2-center v2-binpage' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '휴지통' }),
        el('p', { class: 'v2-desc', text: '프로젝트에서 떼어내 버린 세션이에요. [되돌리기]면 그 프로젝트의 지난 세션으로 돌아가고, 완전히 지우는 건 여기서만 할 수 있어요.' })),
      ss.length ? el('button', { class: 'btn btn-ghost btn-sm v2-bin-emptyb', type: 'button', text: '휴지통 비우기', title: '휴지통의 세션을 전부 완전히 지웁니다', onclick: () => void empty() }) : null),
    el('section', { class: 'v2-bin-sec' },
      el('div', { class: 'v2-now-h' }, el('span', { class: 'v2-k', text: `세션 · ${ss.length}` })),
      ss.length
        ? el('div', { class: 'v2-bin-list' }, ...sessRows)
        : el('div', { class: 'v2-inbox-empty' }, el('p', { class: 'h', text: '휴지통이 비어 있어요.' }),
            el('p', { class: 'sub', text: '사이드바 [지난 세션]의 행 오른쪽 끝 휴지통 단추로 보낼 수 있어요.' }))),
    el('p', { class: 'v2-bin-fine', text: '프로젝트·지식·카테고리를 삭제한 것은 WIKI 앱의 휴지통에 있어요.' },
      el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
}
