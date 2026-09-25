// v2/bins.ts — 지난 세션(#/archive) · 휴지통(#/trash) 화면(#1851 → #1850 안 A, 원준 2026-08-27 "A안으로 가자").
//  ★ #4158 — [AI 세션] 전체 목록(#/app/terminal, renderSessAll)도 여기 산다: 같은 원장 표 문법·같은 기간 고르개를 쓰는 셋째 표다.
//  ⚠ 「아카이브」였던 자리는 #3778(원준 2026-09-19)에서 **「지난 세션」**이 됐다 — 주인공이 보관한 프로젝트에서
//   세션으로 바뀌었고, 보관한 프로젝트는 같은 화면의 칩 하나로 남았다(renderPast 머리말).
//
//  ── 안 A「원장 표」 ──
//  두 화면이 **같은 표 문법**을 쓴다(프로젝트 앱의 리스트 뷰와 같은 결): 열 머리 + 날짜 묶음 행 + 항목 행.
//   · 묶음 행(오늘·어제·이번 주·이전)에 체크박스 — "오늘 것 전체 선택"이 한 번(원준 요청). 묶음 되돌리기 링크도 그 줄에.
//   · 행을 누르면 **곁칸**(새 셸의 우패널)에 그 항목의 안(함께 들어간 세션·만든 지식·자료·작업 기록)이 열린다 —
//     지우기 전에 안을 본다. 여러 개를 고르면 곁칸 위에 고른 것의 합계와 동사가 선다.
//   · 파괴 동사는 행 안 코랄 글자(진입점) → 확인창의 코랄 채움(확정) 하나뿐. 채운 파랑은 화면에 0개(P1 컬러 예산).
//   · 아카이브는 같은 표에서 동사만 다르다(보관 해제 · 휴지통으로). 종전 카드 깔림(#1851)을 걷어냈다.
//  완전 삭제의 실제 삭제 범위는 #1850 P2~P4(session-actions·session-footprint-store) — 여기는 그 창을 부를 뿐이다.
//  행 문법은 홈·확인할 것과 같은 토큰(v2-dot·bg-sel·line-row)만 쓴다 — 새 시각 언어를 만들지 않는다.
import { api, el, personFace, relTime, renderMarkdown, replaceKids, state, sv, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { fmtSize } from '../projects/files-format.js';
import { confirmSessionPurge, confirmSessionPurgeLocal, confirmSessionPurgeMany, confirmSessionTrash, purgeSessionRecord, purgedToast, sessionNames, sessionTrashOp, setTrashConfirmSkipped, trashConfirmSkipped, trashProjectsFlow, eulReul } from '../session-actions.js';
import { sessText, sidePeople } from './side.js';
import { dotCls, isArchivedProj, isLiveSess, isLooseTrashedSess, isMineSess, isTrashedProj, isTrashedSess, projName, type Proj, type Sess, type V2Data } from './views.js';
import { listDismissedSessions, restoreDismissedSessions, type DismissedSession } from './app-instance.js';   // #3857 「치운 세션」
import { TRASH_TABS, auditProjItems, bundleOpen, extraCountsOf, fileTrashUrl, groupByProject, knowItems, levelLabel, matchesQuery, pickInitialTab, srcItems, type DeletedEntry, type SrcItem, type TabCounts, type TrashTab, type TrashedFile } from '../lib/trash-tabs.js';   // #3778 — 휴지통 네 탭의 잣대(순수)
import { invalidateTrashCounts, setTrashCounts } from './trash-counts.js';   // 사이드바 「휴지통 N」과 같은 값(#3778)
import { groupPastByProject, isDismissedSess, pastNames, PAST_PERIODS, selectPast, standsInPast, type PastPeriod, type PastScope, type PastSessLike } from '../lib/past-sess.js';   // #3778 — 「지난 세션」의 잣대(순수)
import { groupAllSess, mainGroupBy, ownerCounts, pickNowCards, selectAllSess, SESS_GROUP_BYS } from '../lib/sess-all.js';   // #4158 — [AI 세션] 전체 목록의 잣대(순수) · #4233 묶기 · 카드
import { sessGroupName, sessScope } from './sess-scope.js';   // #4233 2안 — 묶기 기준 · 고른 카드는 사이드바가 쥐고 여기선 읽기만
import { SESS_STATES } from '../session-status.js';   // #4233 — 상태 묶기 · 카드의 순위
import { showCtxMenu } from './ctx-menu.js';   // #4233 — 묶기 고르개 · 행 ⋯ 메뉴
import { fetchTurns, type Turn } from './sess-tail.js';   // #4233 — 사이드 피크의 대화 꼬리(세션 카드와 같은 길)
import { lastAsk } from './last-ask.js';   // #4233 — 「지금 볼 것」 카드의 마지막 말
import { rememberUnsentDraft } from './quick-session.js';   // #4233 — 끝난 세션에 보낸 글을 세션 화면 입력칸으로
import { verdictStands, type SessRowVerdict } from './sess-visibility.js';   // #4158 — 홈 목록에서의 자리(판정은 셸이 홈과 같은 재료로 넘긴다)

export interface BinHooks { onChanged?: () => void }

const when = (iso: string | null | undefined): string => (iso ? relTime(iso) : '');
const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k: string) => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });
const PAGE = 50;
const DOC_TYPE: Record<string, string> = { decision: '결정', concept: '개념', 'how-to': '절차', reference: '참조', research: '조사', entity: '사람·조직' };
const folderIcon = () => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }));
const sessIcon = () => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M4 5h16v11H8l-4 4z' }));

// 날짜 묶음 — 오늘 · 어제 · 이번 주(7일) · 이전. 긴 목록의 눈금(OS 휴지통과 같은 문법).
const bucketOf = (iso: string): string => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '이전';
  const d = new Date(t); const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff < 7 ? '이번 주' : '이전';
};

// 정밀 시각은 hover(title)로 — 열은 상대 표기(디자인 시스템 §9).
const whenCell = (iso: string | null | undefined): HTMLElement =>
  el('span', { class: 'm', text: when(iso), title: iso ? new Date(iso).toLocaleString() : '' });

// 체크박스 한 알 — 표 안 어디서나 같은 부품. ⚠ 행 클릭(곁칸 열기)과 겹치지 않게 클릭 전파를 끊는다.
function cb(checked: boolean, label: string, onchange: (on: boolean) => void, indeterminate = false): HTMLInputElement {
  const box = el('input', { type: 'checkbox', class: 'sel', 'aria-label': label }) as HTMLInputElement;
  box.checked = checked; box.indeterminate = indeterminate;
  box.addEventListener('change', () => onchange(box.checked));
  box.addEventListener('click', (ev) => ev.stopPropagation());
  return box;
}

// 곁칸의 항목 줄 하나 — 왼쪽 표식 + 이름 + 오른쪽 값.
function sideLi(lead: HTMLElement | null, label: string, value: string, href?: string): HTMLElement {
  const name = href
    ? el('a', { class: 'n', href, text: label, title: label })
    : el('span', { class: 'n', text: label, title: label });
  return el('div', { class: 'li' }, lead, name, el('span', { class: 'sp' }), el('span', { class: 'v', text: value }));
}

// ── 화면 상태(모듈 수준) ──
//  main.ts 가 20초 결로(그리고 되돌리기·완전 삭제 뒤) render* 를 통째로 다시 부르므로, 클로저에 두면 고른 것·검색어·
//  초점·[더 보기]가 20초마다 증발한다(프리뷰 실측 2026-08-27). 진행 중 잠금(busy)도 같은 이유로 여기.
const TAB_STORE = 'lively_v2_trash_tab';
const savedTab = (): unknown => { try { return localStorage.getItem(TAB_STORE); } catch { return null; } };
const trashUi = {
  tab: null as TrashTab | null,          // null = 아직 안 정함(첫 그림에서 pickInitialTab)
  q: '', shown: PAGE, sel: new Set<string>(),
  projOpen: new Map<number, boolean>(),  // 프로젝트 안 세션 목록을 사람이 편/접은 기록
  oldOpen: false,                        // 「이름·본문만 되살릴 수 있는 것」 구역
  know: null as string | null,           // 지식 탭에서 읽고 있는 문서(name)
};
//  「보관한 프로젝트」 모드의 고른 것·초점 — 세션 모드(pastUi)와 따로 산다(칩을 오가도 각자 자리를 지킨다).
const archUi = { sel: new Set<number>(), focus: null as number | null };
let binBusy = false;
const guard = async (fn: () => Promise<void>): Promise<void> => { if (binBusy) return; binBusy = true; try { await fn(); } finally { binBusy = false; } };

// ── 휴지통의 나머지 재료(#3778) — 지식·자료·옛 길로 지운 프로젝트. 세션·프로젝트(data)와 달리 셸의 20초 결에 안 실린다. ──
//  이 화면이 설 때만 받는다(아래 주기). 못 받았으면 직전 판을 그대로 두고,
//  한 번도 못 받았으면 화면이 «확인하지 못했어요» 라고 말한다 — 빈 목록을 «없다» 로 단언하지 않는다.
let extras: { deleted: DeletedEntry[]; files: TrashedFile[] } | null = null;
let extrasAt = 0;
let extrasLoading = false;
let extrasFailed = false;
let filesFailed = false;
//  ⚠ 주기 = 60초. 이 목록은 감사 표를 훑는 조회라 셸의 20초 결마다 부르지 않는다(#1851 2차 때의 규율). 되돌리기·완전 삭제 뒤에는
//   refresh() 가 시각을 0 으로 돌려 바로 다시 받는다. 실패도 같은 주기를 탄다 — 안 그러면 «실패 → 다시 그림 → 곧바로 재시도» 가 쉬지 않고 돈다.
const EXTRAS_TTL_MS = 60_000;
function ensureExtras(repaint: () => void): void {
  if (extrasLoading || ((extras || extrasFailed) && Date.now() - extrasAt <= EXTRAS_TTL_MS)) return;
  extrasLoading = true;
  //  ★ 받은 것을 그 종류로 **다시 거른다** — entity 필터를 모르는 옛 서버(배포가 도는 동안의 API · dev)는 그 인자를 말없이 무시하고
  //   전부를 돌려준다. 안 거르면 세 번 받은 같은 목록이 합쳐져 줄이 세 벌씩 선다(프리뷰 실측 2026-09-20: 지식 43건이 129건으로).
  const list = (entity: string): Promise<DeletedEntry[]> =>
    api('/api/ui/deleted?limit=500&entity=' + entity).then((d: any) => ((Array.isArray(d?.entries) ? d.entries : []) as DeletedEntry[]).filter((e) => e.entity === entity));
  //  파일 자료 목록은 따로 실패할 수 있다(옛 서버·일시 오류) — 그 하나 때문에 지식·프로젝트 탭까지 비우지 않는다.
  //   대신 자료 탭이 «파일 자료는 확인하지 못했어요» 라고 말한다(빈 목록을 «없다» 로 단언하지 않는다).
  const fileList = api('/api/ui/source-trash').then((d: any) => { filesFailed = false; return (Array.isArray(d?.entries) ? d.entries : []) as TrashedFile[]; })
    .catch(() => { filesFailed = true; return [] as TrashedFile[]; });
  void Promise.all([list('knowledge'), list('source'), list('project'), fileList])
    .then(([k, s, p, f]) => {
      extras = { deleted: [...k, ...s, ...p], files: f }; extrasAt = Date.now(); extrasFailed = false;
      //  사이드바 「휴지통 N」에 이 화면이 센 값을 그대로 준다 — 배지와 탭 숫자가 어긋나지 않는다. 파일 목록을 못 받았으면 주지 않는다(0 이라 단언하지 않는다).
      if (!filesFailed) setTrashCounts(extraCountsOf(extras.deleted, extras.files));
    })
    .catch(() => { extrasFailed = true; extrasAt = Date.now(); })
    .finally(() => { extrasLoading = false; repaint(); });
}
//  지식 읽기 칸의 본문 — 한 번 읽은 것은 다시 안 부른다. null = 못 읽음(지워졌거나 권한 없음).
const previewCache = new Map<string, { title: string; body_md: string; truncated: boolean } | null>();

// ══════════════════════════════════ 휴지통 ══════════════════════════════════
//  안 D(원준 2026-09-20 "D로 해서 매니지드까지") — **네 탭으로 하드하게 가르고, 탭마다 그 종류의 원래 생김새로.**
//   · AI 세션  — 있던 프로젝트로 묶은 줄(「지난 세션」 화면과 같은 묶음 문법)
//   · 프로젝트 — 폴더 한 덩이 + 함께 들어간 세션. 아래에 옛 길로 지운 것(이름·본문만 되살릴 수 있는 것)
//   · 자료     — 썸네일 격자(자료 앱과 같은 결)
//   · 지식     — 왼쪽 목록 + 오른쪽 읽기 칸(지우기 전에 본문을 읽는다)
//  종전 안 A 의 곁칸은 걷었다 — 「안에 든 것」은 탭 안에서 말한다(프로젝트 = 세션 목록, 지식 = 본문). 세션이 남긴 결과물은
//  [완전 삭제…] 창이 이름까지 보여 준다(confirmSessionPurge* — 판정은 그대로 #1850 P2~P4).
//  잣대(무엇이 어느 탭에 서나 · 묶는 법 · 처음 설 탭)는 lib/trash-tabs.ts(순수, scripts/trash-tabs.test.mjs).
export function renderTrash(host: HTMLElement, data: V2Data, hooks: BinHooks = {}, aside?: HTMLElement | null): void {
  const ui = trashUi;
  // ── 재료 ──
  const ss = data.sessions.filter(isLooseTrashedSess).sort((x, y) => String(y.trashedAt || '').localeCompare(String(x.trashedAt || '')));
  const tps = data.projects.filter((p) => isTrashedProj(p)).sort((x, y) => String(y.trashed_at || '').localeCompare(String(x.trashed_at || '')));
  const bundleOf = (p: Proj): Sess[] => data.sessions.filter((s) => isTrashedSess(s) && Number(s.trashedWith) === p.id).sort((a, b) => b.lastSeen - a.lastSeen);
  const oldProj = extras ? auditProjItems(extras.deleted) : [];
  const srcs = extras ? srcItems(extras.deleted, extras.files) : [];
  const knows = extras ? knowItems(extras.deleted) : [];
  const counts: TabCounts = { sess: ss.length, proj: tps.length + oldProj.length, src: srcs.length, know: knows.length };
  if (!ui.tab) ui.tab = pickInitialTab(savedTab(), counts);
  const tab = ui.tab;
  const T = TRASH_TABS.find((t) => t.key === tab)!;
  const sessName = (s: Sess): string => sessText(s, projName(data, s.projectId)).main || s.label || s.id;
  const refresh = (): void => { extrasAt = 0; invalidateTrashCounts(); hooks.onChanged?.(); };

  type Item = { kind: 'project'; key: string; at: string; p: Proj; bundle: Sess[] } | { kind: 'session'; key: string; at: string; s: Sess };

  // 세션 하나는 이름이 둘(박스 id·대화 uuid)이라 서버 응답을 이름이 아니라 **세션 단위**로 읽는다 — 한 이름만 처리돼도 그 세션은 된 것.
  const bySession = (r: { done: string[]; skipped: Array<{ id: string; why: string }> }, list: Sess[]): { ok: Sess[]; failed: Sess[]; why: string } => {
    const done = new Set(r.done);
    const ok = list.filter((s) => sessionNames(s).some((n) => done.has(n)));
    const failed = list.filter((s) => !ok.includes(s));
    const why = failed.length ? (r.skipped.find((k) => sessionNames(failed[0]).includes(k.id))?.why || r.skipped[0]?.why || '처리된 세션이 없어요') : '';
    return { ok, failed, why };
  };
  const logSid = (s: Sess): string => s.logId || (s.stateKey === 'log' ? s.id : '');
  const logNode = (s: Sess): string => String((s.logNode ?? s.node) || '');
  const defaultChoice = { log: true, knowledge: [] as string[], revert: [] as string[], projects: [] as number[], sources: [] as number[], tasks: [] as number[], categories: [] as number[], activities: false };

  // ── 되돌리기(세션 · 프로젝트) ──
  const restoreItems = (list: Item[]): Promise<void> => guard(async () => {
    if (!list.length) return;
    const sess = list.filter((i): i is Extract<Item, { kind: 'session' }> => i.kind === 'session').map((i) => i.s);
    const pjs = list.filter((i): i is Extract<Item, { kind: 'project' }> => i.kind === 'project').map((i) => i.p);
    let sessDone = 0, pjDone = 0, failed = 0; let why = '';
    if (sess.length) {
      try { const o = bySession(await sessionTrashOp('untrash', sess.flatMap((s) => sessionNames(s))), sess); sessDone = o.ok.length; if (o.failed.length) { failed += o.failed.length; why = o.why; } }
      catch (e: any) { failed += sess.length; why = e?.message || String(e); }
    }
    for (const p of pjs) {
      try { await api('/api/ui/v6/projects/' + p.id + '/trash', { method: 'POST', body: JSON.stringify({ trashed: false }) }); pjDone++; }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    const parts: string[] = [];
    if (pjDone) parts.push(`프로젝트 ${pjDone}개`); if (sessDone) parts.push(`세션 ${sessDone}개`);
    if (!parts.length) { toast('되돌리지 못했어요 — ' + (why || '처리된 항목이 없어요'), true); return; }
    const where = pjDone ? '를 원래 자리로 되돌렸어요 — 함께 들어간 세션도 돌아왔어요.' : '를 지난 세션으로 되돌렸어요.';
    toast(parts.join(' · ') + where + (failed ? ` (${failed}개는 못 돌렸어요 — ${why})` : ''), failed > 0);
    ui.sel.clear(); refresh();
  });

  // ── 완전 삭제(세션 · 프로젝트) — 섞어서 **한 창**. 행·선택·묶음·비우기가 전부 이 길을 탄다. ──
  //  confirmed — 창에서 [완전 삭제]를 눌렀나. 프로젝트 탭은 두 출처를 잇달아 지우는데, 첫 창에서 취소했으면 둘째 창을 띄우지 않는다.
  let confirmed = false;
  const purgeItems = (list: Item[], title: string): Promise<void> => guard(async () => {
    confirmed = false;
    if (!list.length) return;
    const loose = list.filter((i): i is Extract<Item, { kind: 'session' }> => i.kind === 'session').map((i) => i.s);
    const pjs = list.filter((i): i is Extract<Item, { kind: 'project' }> => i.kind === 'project');
    const bundled = pjs.flatMap((i) => i.bundle);
    const all = [...loose, ...bundled];
    const choices = await confirmSessionPurgeMany({
      title,
      sessions: all.map((s) => ({ sid: logSid(s) || null, node: logNode(s), label: sessName(s) })),
      projects: pjs.map((i) => ({ id: i.p.id, name: i.p.name, sessN: i.bundle.length })),
    });
    if (!choices) return;
    confirmed = true;
    let logs = 0, failed = 0; const sum = { kn: 0, rv: 0, pj: 0, src: 0, tk: 0, ct: 0 };
    // ⚠ 같은 창에서 프로젝트도 지울 때, 세션 발자국의 projects 에 그 프로젝트가 있으면 세션 쪽이 먼저 지워
    //  아래 프로젝트 삭제가 404 로 헛돈다(순서 경합). 지금 지우려는 프로젝트 id 는 세션 선택에서 뺀다 —
    //  그 행은 아래 /projects/:id/purge 가 지운다(서버가 묶음 세션 결과물까지 마저 되돌린다 — #1850 P4).
    const purgingPj = new Set(pjs.map((i) => i.p.id));
    for (const s of all) {
      const sid = logSid(s); if (!sid) continue;
      try {
        const c = choices.get(sid) || defaultChoice;
        const r = await purgeSessionRecord(sid, logNode(s), { ...c, projects: c.projects.filter((id) => !purgingPj.has(id)) });
        logs++; sum.kn += r.knowledge_deleted; sum.rv += r.knowledge_reverted; sum.pj += r.projects_deleted; sum.src += r.sources_deleted; sum.tk += r.tasks_deleted; sum.ct += r.categories_deleted;
      } catch { failed++; }
    }
    let sessDone = 0, pjDone = 0; let why = '';
    if (loose.length) {
      try { const o = bySession(await sessionTrashOp('purge', loose.flatMap((s) => sessionNames(s))), loose); sessDone = o.ok.length; if (o.failed.length) { failed += o.failed.length; why = o.why; } }
      catch (e: any) { failed += loose.length; why = e?.message || String(e); }
    }
    for (const i of pjs) {
      try { const res: any = await api('/api/ui/v6/projects/' + i.p.id + '/purge', { method: 'POST' }); pjDone++; sessDone += i.bundle.length - (Array.isArray(res?.sessions?.skipped) ? res.sessions.skipped.length : 0); }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    const parts: string[] = [];
    if (pjDone) parts.push(`프로젝트 ${pjDone}개`); if (sessDone) parts.push(`세션 ${sessDone}개`);
    if (!parts.length) { toast('지우지 못했어요 — ' + (why || '처리된 항목이 없어요'), true); refresh(); return; }
    const tail: string[] = [];
    if (logs) tail.push(`대화 기록 ${logs}건 파기`);
    if (sum.kn) tail.push(`지식 ${sum.kn}건 삭제`); if (sum.rv) tail.push(`지식 ${sum.rv}건 되돌림`);
    if (sum.pj) tail.push(`프로젝트 ${sum.pj}건 삭제`); if (sum.src) tail.push(`자료 ${sum.src}건 삭제`);
    if (sum.tk) tail.push(`태스크 ${sum.tk}건 삭제`); if (sum.ct) tail.push(`분류 ${sum.ct}건 삭제`);
    if (failed) tail.push(`⚠ ${failed}건은 지우지 못했어요${why ? ' — ' + why : ''}`);
    toast(parts.join(' · ') + '를 완전히 지웠어요.' + (tail.length ? ' ' + tail.join(' · ') : ''), failed > 0);
    ui.sel.clear(); refresh();
  });
  // 세션 하나는 종전의 단일 창(이름·원격 노드 안내가 있다). 프로젝트·여러 개·비우기는 위 공통 창.
  const purgeSession = (s: Sess): Promise<void> => guard(async () => {
    const name = sessName(s);
    const sid = logSid(s);
    try {
      if (sid) {
        const choice = await confirmSessionPurge({ sid, node: logNode(s), title: `「${name}」${eulReul(name)} 완전히 지울까요?`, remoteNode: logNode(s) || null });
        if (!choice) return;
        const r = await purgeSessionRecord(sid, logNode(s), choice);
        const m = bySession(await sessionTrashOp('purge', sessionNames(s)), [s]);
        if (!m.ok.length) { toast('대화 기록은 지웠지만 휴지통에서 빼지 못했어요 — ' + m.why, true); refresh(); return; }
        toast(purgedToast(r));
      } else {
        if (!await confirmSessionPurgeLocal({ title: `「${name}」${eulReul(name)} 완전히 지울까요?` })) return;
        const m = bySession(await sessionTrashOp('purge', sessionNames(s)), [s]);
        if (!m.ok.length) { toast('지우지 못했어요 — ' + m.why, true); return; }
        toast('완전히 지웠어요.');
      }
      refresh();
    } catch (e: any) { toast('지우지 못했어요 — ' + (e?.message || e), true); }
  });

  // ── 되살리기 · 완전 삭제(지식 · 자료 · 옛 길로 지운 프로젝트) — 감사 스냅샷 휴지통과 파일 보관 두 출처를 한 모양으로. ──
  type Loose = { key: string; label: string; restore: () => Promise<unknown>; purge: () => Promise<unknown> };
  const fileOp = (it: SrcItem, op: 'restore' | 'purge'): Promise<unknown> => {
    const url = fileTrashUrl(it, op);
    if (!url) return Promise.reject(new Error('이 파일이 있던 프로젝트를 알 수 없어요'));
    return api(url, { method: 'POST', body: JSON.stringify({ source_id: it.id }) });
  };
  const auditLoose = (entity: string, key: string, label: string): Loose => ({
    key: entity + ':' + key, label,
    restore: () => api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity, key }) }),
    purge: () => api('/api/ui/deleted/purge', { method: 'POST', body: JSON.stringify({ entity, key }) }),
  });
  const looseOfSrc = (it: SrcItem): Loose => it.origin === 'audit' ? { ...auditLoose('source', String(it.id), it.title), key: it.key } : {
    key: it.key, label: it.title,
    //  파일 보관은 폴더마다 길이 다르다(프로젝트 · 내 폴더 · 공유 폴더) — 주소는 잣대가 고른다(lib/trash-tabs fileTrashUrl).
    restore: () => fileOp(it, 'restore'),
    purge: () => fileOp(it, 'purge'),
  };
  const runLoose = async (list: Loose[], op: 'restore' | 'purge'): Promise<{ done: number; failed: number; why: string }> => {
    let done = 0, failed = 0; let why = '';
    //  여섯 개씩 — 옛 길로 지운 것은 수백 건일 수 있다(실측 243건). 하나씩이면 분 단위, 한꺼번에면 서버가 몰린다.
    for (let i = 0; i < list.length; i += 6) {
      const out = await Promise.allSettled(list.slice(i, i + 6).map((x) => (op === 'restore' ? x.restore() : x.purge())));
      for (const o of out) { if (o.status === 'fulfilled') done++; else { failed++; why = String((o.reason as any)?.message || o.reason || ''); } }
    }
    return { done, failed, why };
  };
  const restoreLoose = (list: Loose[], unit: string, where: string): Promise<void> => guard(async () => {
    if (!list.length) return;
    const r = await runLoose(list, 'restore');
    if (!r.done) { toast('되살리지 못했어요 — ' + (r.why || '처리된 항목이 없어요'), true); return; }
    toast((list.length === 1 ? `「${list[0].label}」${eulReul(list[0].label)}` : `${unit} ${r.done}건을`) + ` ${where}` + (r.failed ? ` (${r.failed}건은 못 되살렸어요 — ${r.why})` : ''), r.failed > 0);
    for (const x of list) { ui.sel.delete(x.key); previewCache.delete(x.key); }
    refresh();
  });
  const purgeLoose = (list: Loose[], unit: string, lines: string[]): Promise<void> => guard(async () => {
    if (!list.length) return;
    const one = list.length === 1;
    if (!await confirmDialog({
      title: one ? `「${list[0].label}」${eulReul(list[0].label)} 완전히 지울까요?` : `${unit} ${list.length}건을 완전히 지울까요?`,
      message: '영영 사라지고, 되돌릴 수 없어요.', lines, confirmText: '완전 삭제', danger: true,
    })) return;
    const r = await runLoose(list, 'purge');
    if (!r.done) { toast('지우지 못했어요 — ' + (r.why || '처리된 항목이 없어요'), true); return; }
    toast(`${unit} ${r.done}건을 완전히 지웠어요.` + (r.failed ? ` ⚠ ${r.failed}건은 지우지 못했어요 — ${r.why}` : ''), r.failed > 0);
    for (const x of list) { ui.sel.delete(x.key); previewCache.delete(x.key); }
    refresh();
  });
  const KNOW_BACK = '원래 이름으로 WIKI 에 되살렸어요 — 카테고리와 다른 지식과의 연결은 돌아오지 않아요.';
  const KNOW_LOST = ['본문과 고친 기록이 함께 지워져요.'];
  const SRC_BACK = '되살렸어요 — 파일은 원래 자리로 돌아갔어요. 글로 적어 둔 자료는 지식과의 연결이 돌아오지 않아요.';
  const SRC_LOST = ['보관해 둔 파일과 자료의 본문이 함께 지워져요. 폴더째 지웠던 것이면, 그 폴더에 함께 있던 그 밖의 파일도 마지막 자료를 지울 때 사라져요.', '이 자료를 출처로 쓰던 지식은 그대로 남고, 출처 표시만 사라져요.'];
  const OLD_BACK = '이름과 본문을 되살렸어요 — 태스크·팀원·연결은 지울 때 사라져서 돌아오지 않아요.';
  const OLD_LOST = ['남아 있던 이름과 본문이 지워져요.'];

  // ── 찾기 · 고른 것 손질 ──
  const hit = (...hay: Array<string | null | undefined>): boolean => matchesQuery(ui.q, ...hay);
  const visSess = ss.filter((s) => hit(sessName(s), projName(data, s.projectId)));
  const visProj = tps.filter((p) => hit(p.name, '#' + p.id));
  const visOld = oldProj.filter((d) => hit(d.label, '#' + d.key));
  const visSrc = srcs.filter((x) => hit(x.title, x.sub, x.projectId ? projName(data, x.projectId) : ''));
  const visKnow = knows.filter((d) => hit(d.label, d.key));
  const keysNow = new Set<string>([...ss.map((s) => 's:' + s.id), ...tps.map((p) => 'p:' + p.id), ...oldProj.map((d) => 'project:' + d.key),
    ...srcs.map((x) => x.key), ...knows.map((d) => 'knowledge:' + d.key)]);
  if (extras) for (const k of Array.from(ui.sel)) if (!keysNow.has(k)) ui.sel.delete(k);

  const sessItem = (s: Sess): Item => ({ kind: 'session', key: 's:' + s.id, at: String(s.trashedAt || ''), s });
  const projItem = (p: Proj): Item => ({ kind: 'project', key: 'p:' + p.id, at: String(p.trashed_at || ''), p, bundle: bundleOf(p) });
  const oldLoose = (d: DeletedEntry): Loose => auditLoose('project', d.key, d.label);
  const knowLoose = (d: DeletedEntry): Loose => auditLoose('knowledge', d.key, d.label);

  // ── 조립 ──
  const body = el('div', { class: 'v2-trash-body' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const segEl = el('div', { class: 'v2-trash-seg', role: 'tablist', 'aria-label': '휴지통 종류' });
  const emptyBtn = el('button', { class: 'btn btn-ghost btn-sm v2-bin-emptyb', type: 'button' }) as HTMLButtonElement;
  const search = el('input', { type: 'search', id: 'v2-trash-q', class: 'v2-bin-search', placeholder: '이 탭에서 이름으로 찾기', 'aria-label': '휴지통에서 이름으로 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; renderTrash(host, data, hooks, aside); });
  const pick = (key: string, label: string): HTMLInputElement => cb(ui.sel.has(key), label + ' 선택', (on) => { if (on) ui.sel.add(key); else ui.sel.delete(key); paintBar(); });
  const acts = (...kids: Array<HTMLElement | null>): HTMLElement => el('span', { class: 'acts' }, ...kids.filter(Boolean) as HTMLElement[]);
  const tx = (text: string, title: string, onclick: () => void, danger = false): HTMLElement =>
    el('button', { class: 'btn-text' + (danger ? ' danger' : ''), type: 'button', text, title, onclick });
  const more = (total: number): HTMLElement | null => total > ui.shown
    ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${total - ui.shown}개 더 보기`, onclick: () => { ui.shown += PAGE; renderTrash(host, data, hooks, aside); } }) : null;
  const note = (text: string): HTMLElement => el('p', { class: 'v2-bin-empty', text });
  const emptyNote = (what: string, how: string): HTMLElement => note(ui.q.trim() ? '찾는 이름이 없어요.' : `버린 ${what}이 없어요. ${how}`);
  const waiting = (): HTMLElement | null => extras ? null : note(extrasFailed ? '목록을 확인하지 못했어요 — 잠시 뒤 다시 열어 주세요.' : '확인하는 중…');

  // ── 선택 줄 — 탭마다 제 동사 ──
  const paintBar = (): void => {
    const n = Array.from(ui.sel).filter((k) => (tab === 'sess' ? k.startsWith('s:') : tab === 'proj' ? k.startsWith('p:') || k.startsWith('project:') : tab === 'src' ? k.startsWith('f:') || k.startsWith('a:') : k.startsWith('knowledge:'))).length;
    if (!n) { replaceKids(barEl); barEl.hidden = true; return; }
    barEl.hidden = false;
    const back = (): void => {
      if (tab === 'sess') void restoreItems(visSess.filter((s) => ui.sel.has('s:' + s.id)).map(sessItem));
      else if (tab === 'proj') {
        const olds = visOld.filter((d) => ui.sel.has('project:' + d.key)).map(oldLoose);
        void restoreItems(visProj.filter((p) => ui.sel.has('p:' + p.id)).map(projItem)).then(() => restoreLoose(olds, '항목', OLD_BACK));
      } else if (tab === 'src') void restoreLoose(visSrc.filter((x) => ui.sel.has(x.key)).map(looseOfSrc), '자료', SRC_BACK);
      else void restoreLoose(visKnow.filter((d) => ui.sel.has('knowledge:' + d.key)).map(knowLoose), '지식', KNOW_BACK);
    };
    const gone = (): void => {
      if (tab === 'sess') void purgeItems(visSess.filter((s) => ui.sel.has('s:' + s.id)).map(sessItem), `고른 세션 ${n}개를 완전히 지울까요?`);
      else if (tab === 'proj') {
        const olds = visOld.filter((d) => ui.sel.has('project:' + d.key)).map(oldLoose);
        const pj = visProj.filter((p) => ui.sel.has('p:' + p.id)).map(projItem);
        void (pj.length ? purgeItems(pj, `고른 프로젝트 ${pj.length}개를 완전히 지울까요?`) : Promise.resolve()).then(() => (!pj.length || confirmed ? purgeLoose(olds, '항목', OLD_LOST) : undefined));
      } else if (tab === 'src') void purgeLoose(visSrc.filter((x) => ui.sel.has(x.key)).map(looseOfSrc), '자료', SRC_LOST);
      else void purgeLoose(visKnow.filter((d) => ui.sel.has('knowledge:' + d.key)).map(knowLoose), '지식', KNOW_LOST);
    };
    replaceKids(barEl, 
      el('span', { class: 'n', text: `${n}개 선택` }),
      tx(T.back, '고른 것을 원래 자리로 되돌립니다', back),
      tx('완전 삭제', '고른 것을 되살릴 수 없게 지웁니다', gone, true),
      tx('선택 해제', '고른 것을 풉니다', () => { ui.sel.clear(); renderTrash(host, data, hooks, aside); }));
  };

  // ── 탭 본문 ──
  const paintSess = (): void => {
    if (!visSess.length) { replaceKids(body, emptyNote('세션', '[지난 세션] 화면이나 사이드바 지난 세션 행의 휴지통 단추로 보낼 수 있어요.')); return; }
    const groups = groupByProject(visSess.slice(0, ui.shown), (s) => s.projectId, (pid) => projName(data, pid) || `#${pid}`);
    replaceKids(body, ...groups.map((g) => el('section', { class: 'v2-trash-grp' },
      el('div', { class: 'gh' }, folderIcon(), el('b', { text: g.name }), el('span', { class: 'c', text: `${g.rows.length}개` }), el('span', { class: 'sp' }),
        tx('이 묶음 되돌리기', `「${g.name}」에 있던 ${g.rows.length}개를 지난 세션으로 되돌립니다`, () => void restoreItems(g.rows.map(sessItem)))),
      ...g.rows.map((s) => el('div', { class: 'v2-trash-row' }, pick('s:' + s.id, sessName(s)), sessIcon(),
        el('a', { class: 't', href: '#/s/' + encodeURIComponent(s.id), text: sessName(s), title: (s.label || '') + '\n세션 대화를 엽니다' }),
        el('span', { class: 'chip', text: logSid(s) ? '대화 기록 있음' : '기록 없음' }),
        el('span', { class: 'sp' }),
        acts(tx('되돌리기', '지난 세션으로 되돌립니다', () => void restoreItems([sessItem(s)])), tx('완전 삭제', '되살릴 수 없게 지웁니다', () => void purgeSession(s), true)),
        el('span', { class: 'w' }, whenCell(s.trashedAt)))))),
      ...[more(visSess.length)].filter(Boolean) as HTMLElement[]);
  };

  const paintProj = (): void => {
    const kids: HTMLElement[] = [];
    //  프로젝트는 **한 그릇 안의 줄**로 세운다 — 프로젝트마다 카드를 따로 세우면 123개가 6천 픽셀이 된다(8/27 에 같은 이유로 걷어낸 그 모양).
    //   함께 들어간 세션은 그 줄 바로 아래에 편다.
    const projRows: HTMLElement[] = [];
    for (const p of visProj.slice(0, ui.shown)) {
      const bundle = bundleOf(p);
      const open = bundleOpen(bundle.length, ui.projOpen.get(p.id));
      const it = projItem(p);
      projRows.push(
        el('div', { class: 'v2-trash-row p' }, pick('p:' + p.id, p.name),
          bundle.length ? el('button', { class: 'v2-bin-gt', type: 'button', 'aria-expanded': String(open), title: open ? '안의 세션 접기' : '안의 세션 펴기',
            onclick: () => { ui.projOpen.set(p.id, !open); renderTrash(host, data, hooks, aside); } }, el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' })) : null,
          folderIcon(), el('span', { class: 't', text: p.name, title: p.name }), el('span', { class: 'mono', text: `#${p.id}` }),
          el('span', { class: 'm', text: bundle.length ? `세션 ${bundle.length}개와 함께` : '안에 든 세션 없음' }),
          el('span', { class: 'sp' }),
          acts(tx('복원', '프로젝트와 함께 들어간 세션이 원래 자리로 돌아갑니다', () => void restoreItems([it])),
            tx('완전 삭제', '되살릴 수 없게 지웁니다', () => void purgeItems([it], `「${p.name}」${eulReul(p.name)} 완전히 지울까요?`), true)),
          el('span', { class: 'w' }, whenCell(p.trashed_at))),
        open ? el('div', { class: 'v2-trash-kids' }, ...bundle.slice(0, 8).map((s) => el('a', { class: 'k', href: '#/s/' + encodeURIComponent(s.id), title: '세션 대화를 엽니다' },
          dot(s.stateKey), el('span', { class: 'kt', text: sessText(s, p.name).main || s.id }), el('span', { class: 'kv', text: s.stateLabel }))),
          bundle.length > 8 ? el('p', { class: 'km', text: `외 ${bundle.length - 8}개 — 복원하면 전부 돌아와요.` }) : null) : null);
    }
    if (projRows.length) kids.push(el('section', { class: 'v2-trash-grp' }, ...projRows.filter(Boolean) as HTMLElement[]));
    const m = more(visProj.length); if (m) kids.push(m);
    if (!visProj.length && !visOld.length) kids.push(extras || tps.length ? emptyNote('프로젝트', '사이드바 프로젝트 행 오른쪽 클릭 ▸ [휴지통으로 보내기]로 보낼 수 있어요.') : (waiting() as HTMLElement));
    // ── 옛 길로 지운 것 — 프로젝트 앱의 [삭제]는 아직 휴지통을 거치지 않고 바로 지운다. 남는 것은 이름·본문뿐이다. ──
    if (visOld.length) {
      kids.push(el('section', { class: 'v2-trash-old' },
        el('button', { class: 'v2-bin-gt', type: 'button', 'aria-expanded': String(ui.oldOpen), onclick: () => { ui.oldOpen = !ui.oldOpen; renderTrash(host, data, hooks, aside); } },
          el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), el('b', { text: '이름과 본문만 되살릴 수 있는 것' }), el('span', { class: 'c', text: ` · ${visOld.length}` })),
        el('p', { class: 'd', text: '프로젝트 앱에서 [삭제]로 지운 프로젝트와 태스크예요. 태스크·팀원·연결은 지울 때 함께 사라져서, 되살려도 이름과 본문만 돌아옵니다.' }),
        ui.oldOpen ? el('div', { class: 'v2-trash-grp' }, ...visOld.slice(0, ui.shown).map((d) => el('div', { class: 'v2-trash-row' }, pick('project:' + d.key, d.label), folderIcon(),
          el('span', { class: 't', text: d.label, title: d.label }), el('span', { class: 'mono', text: `#${d.key}` }), el('span', { class: 'chip', text: levelLabel(d.level) }),
          el('span', { class: 'sp' }),
          acts(tx('복원', '이름과 본문만 되살립니다', () => void restoreLoose([oldLoose(d)], '항목', OLD_BACK)), tx('완전 삭제', '남은 이름과 본문을 지웁니다', () => void purgeLoose([oldLoose(d)], '항목', OLD_LOST), true)),
          el('span', { class: 'w' }, whenCell(d.at)))),
          visOld.length > ui.shown ? note(`외 ${visOld.length - ui.shown}개 — 위 [외 n개 더 보기]나 찾기로 좁혀 보세요.`) : null) : null));
    }
    replaceKids(body, ...kids);
  };

  const paintSrc = (): void => {
    const w = waiting(); if (w) { replaceKids(body, w); return; }
    const partial = filesFailed ? note('지운 파일 자료의 목록은 확인하지 못했어요 — 잠시 뒤 다시 열어 주세요.') : null;
    if (!visSrc.length) { replaceKids(body, ...[partial, partial && !ui.q.trim() ? null : emptyNote('자료', '프로젝트의 자료 칸에서 파일을 지우면 여기로 와요.')].filter(Boolean) as HTMLElement[]); return; }
    replaceKids(body, ...[partial].filter(Boolean) as HTMLElement[], el('div', { class: 'v2-trash-grid' }, ...visSrc.slice(0, ui.shown).map((x) => {
      const where = x.origin === 'file' ? [x.projectId ? projName(data, x.projectId) : '', x.bytes ? fmtSize(x.bytes) : ''].filter(Boolean).join(' · ') : x.sub;
      const one = looseOfSrc(x);
      return el('article', { class: 'v2-trash-file' },
        el('div', { class: 'th' }, el('span', { class: 'ext', text: x.badge }), el('label', { class: 'ck' }, pick(x.key, x.title))),
        el('div', { class: 'bd' },
          el('span', { class: 't', text: x.title, title: x.origin === 'file' ? x.sub : x.title }),
          el('span', { class: 's', text: where || (x.origin === 'file' ? '프로젝트 파일' : '적어 둔 자료') }),
          el('div', { class: 'f' }, whenCell(x.at), el('span', { class: 'sp' }),
            tx('복원', x.origin === 'file' ? '파일을 원래 자리로 되돌립니다' : '자료를 되살립니다', () => void restoreLoose([one], '자료', SRC_BACK)),
            tx('완전 삭제', '되살릴 수 없게 지웁니다', () => void purgeLoose([one], '자료', SRC_LOST), true))));
    })), ...[more(visSrc.length)].filter(Boolean) as HTMLElement[]);
  };

  const paintKnow = (): void => {
    const w = waiting(); if (w) { replaceKids(body, w); return; }
    if (!visKnow.length) { replaceKids(body, emptyNote('지식', 'WIKI 문서의 ⋯ ▸ [삭제]로 지운 지식이 여기로 와요.')); return; }
    if (!ui.know || !visKnow.some((d) => d.key === ui.know)) ui.know = visKnow[0].key;
    const cur = visKnow.find((d) => d.key === ui.know)!;
    const read = el('div', { class: 'v2-trash-read' });
    const paintRead = (): void => {
      const pv = previewCache.get('knowledge:' + cur.key);
      replaceKids(read, 
        el('div', { class: 'hd' },
          cur.doc_type ? el('span', { class: 'cat', text: DOC_TYPE[cur.doc_type] || '지식' }) : null,
          el('span', { class: 'by', text: [cur.actor ? `버린 사람 ${cur.actor}` : '', `버린 때 ${when(cur.at)}`].filter(Boolean).join(' · ') }), el('span', { class: 'sp' }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '복원', onclick: () => void restoreLoose([knowLoose(cur)], '지식', KNOW_BACK) }),
          tx('완전 삭제…', '되살릴 수 없게 지웁니다', () => void purgeLoose([knowLoose(cur)], '지식', KNOW_LOST), true)),
        el('h2', { text: cur.label }),
        pv === undefined ? el('p', { class: 'meta', text: '본문을 읽는 중…' })
          : pv === null ? el('p', { class: 'meta', text: '본문을 읽지 못했어요 — 이미 완전히 지워졌거나 볼 수 없는 문서예요.' })
          : el('div', { class: 'md-rendered pn-md' }, renderMarkdown(pv.body_md || '_(본문이 비어 있어요)_')),
        pv && pv.truncated ? el('p', { class: 'meta', text: '앞부분만 보여 드려요 — 복원하면 전체가 돌아옵니다.' }) : null,
        el('p', { class: 'ft', text: '복원하면 본문·제목이 지운 때 그대로 돌아와요. 카테고리와 다른 지식과의 연결은 지울 때 끊겨서 돌아오지 않아요.' }));
    };
    paintRead();
    if (!previewCache.has('knowledge:' + cur.key)) {
      const k = cur.key;
      void api('/api/ui/deleted/snapshot?entity=knowledge&key=' + encodeURIComponent(k))
        .then((d: any) => { previewCache.set('knowledge:' + k, d?.preview ? { title: String(d.preview.title || ''), body_md: String(d.preview.body_md || ''), truncated: !!d.preview.truncated } : null); })
        .catch(() => { previewCache.set('knowledge:' + k, null); })
        .finally(() => { if (ui.tab === 'know' && ui.know === k && host.contains(read)) paintRead(); });
    }
    replaceKids(body, el('div', { class: 'v2-trash-know' },
      el('div', { class: 'v2-trash-klist' }, ...visKnow.slice(0, ui.shown).map((d) => el('div', { class: 'kr' + (d.key === cur.key ? ' on' : '') }, pick('knowledge:' + d.key, d.label),
        el('button', { class: 'kb', type: 'button', 'aria-current': d.key === cur.key ? 'true' : 'false', onclick: () => { ui.know = d.key; renderTrash(host, data, hooks, aside); } },
          el('span', { class: 't', text: d.label }), el('span', { class: 's', text: [DOC_TYPE[String(d.doc_type || '')] || '', d.actor || '', when(d.at)].filter(Boolean).join(' · ') })))),
        ...[more(visKnow.length)].filter(Boolean) as HTMLElement[]),
      read));
  };

  // ── 비우기 — 지금 탭만. 찾기와 무관하게 그 탭의 전부. ──
  const emptyTab = (): void => {
    if (tab === 'sess') void purgeItems(ss.map(sessItem), `AI 세션 탭을 비울까요? — 세션 ${ss.length}개`);
    else if (tab === 'proj') void (tps.length ? purgeItems(tps.map(projItem), `프로젝트 탭을 비울까요? — 프로젝트 ${tps.length}개`) : Promise.resolve()).then(() => (!tps.length || confirmed ? purgeLoose(oldProj.map(oldLoose), '항목', OLD_LOST) : undefined));
    else if (tab === 'src') void purgeLoose(srcs.map(looseOfSrc), '자료', SRC_LOST);
    else void purgeLoose(knows.map(knowLoose), '지식', KNOW_LOST);
  };

  // ── 조립 ──
  replaceKids(segEl, ...TRASH_TABS.map((t) => el('button', { class: 'v2-trash-segb' + (t.key === tab ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(t.key === tab),
    onclick: () => { ui.tab = t.key; ui.shown = PAGE; try { localStorage.setItem(TAB_STORE, t.key); } catch { /* 기억 못 해도 화면은 선다 */ } renderTrash(host, data, hooks, aside); } },
    el('span', { text: t.label }), el('span', { class: 'n', text: (t.key === 'sess' || extras || (t.key === 'proj' && tps.length)) ? String(counts[t.key]) : '…' }))));
  emptyBtn.textContent = `${T.label} 비우기`;
  emptyBtn.title = `휴지통의 ${T.label} 탭에 든 것을 전부 완전히 지웁니다`;
  emptyBtn.hidden = counts[tab] === 0;
  emptyBtn.onclick = emptyTab;

  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  const scrollTop = host.scrollTop;
  replaceKids(host, el('div', { class: 'v2-center v2-binpage wide v2-trash' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '휴지통' }),
        el('p', { class: 'v2-desc', text: '버린 것이 종류마다 따로 모여 있어요. 되돌리면 원래 자리로 가고, 완전히 지우는 건 여기서만 할 수 있어요.' }),
        // '다음부터 묻지 않기'(confirmSessionTrash)를 켜 둔 사람에게 되돌리는 문 — 확인창이 더는 안 뜨니 여기가 유일한 자리다.
        trashConfirmSkipped() ? el('p', { class: 'v2-desc v2-bin-skipnote' },
          el('span', { text: '휴지통으로 보낼 때 묻지 않고 바로 보내도록 해 두셨어요. ' }),
          el('button', { class: 'btn-text', type: 'button', text: '다시 묻기', onclick: (ev: Event) => { setTrashConfirmSkipped(false); (ev.currentTarget as HTMLElement).closest('p')?.remove(); toast('다음부터 휴지통으로 보낼 때 다시 확인해요.'); } })) : null),
      el('div', { class: 'v2-trash-tools' }, search, emptyBtn)),
    segEl, barEl, body,
    el('p', { class: 'v2-bin-fine', text: '카테고리를 삭제한 것은 WIKI 앱의 휴지통에 있어요.' },
      el('a', { class: 'btn-text', href: location.pathname + '?ui=classic#/trash', target: '_blank', rel: 'noopener', text: '열기 ↗' }))));
  if (tab === 'sess') paintSess(); else if (tab === 'proj') paintProj(); else if (tab === 'src') paintSrc(); else paintKnow();
  paintBar();
  if (aside) replaceKids(aside);   // 안 D 는 곁칸을 쓰지 않는다(main.ts titleFor noAside) — 옛 탭 복원이 곁칸을 물고 와도 비워 둔다
  ensureExtras(() => { if (host.isConnected && host.querySelector('.v2-trash')) renderTrash(host, data, hooks, aside); });
  if (hadFocus) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* 일부 브라우저는 search 타입에 거부 */ } }
  if (scrollTop) host.scrollTop = scrollTop;
}

// ══════════════════════════════ 지난 세션 (#/archive) ══════════════════════════════
//  원준 2026-09-19: "x 를 누르면 아카이브로 보내지 말고 지난 세션으로 보내. 아카이브라는 곳을 없애고 그냥 지난 세션을
//   볼 수 있는 창으로 하는 게 좋겠음. 그 안에서도 프로젝트 단위로 묶어서 보거나 각종 필터 걸려서 쉽게 볼 수 있게."
//
//  ★ 종전엔 이 자리가 「아카이브」였고, 담는 것이 **보관한 프로젝트**였다. 그래서 세션의 두 축이 갈 곳을 잃었다:
//   · 박스가 없는 세션(실행 축)은 홈에서 흐리게 보일 뿐 모아 보는 자리가 없었다(실측 2026-09-19: 원준 계정 213건).
//   · × 로 치운 세션(보임 축)은 이 화면 발치의 「치운 세션」 표에만 있었고, × 툴팁이 그걸 «아카이브»라고 불렀다 —
//     사람에겐 «보관함에 넣었다» 로 읽혔다.
//  ⇒ 이 화면의 주인공을 **세션**으로 바꾼다. 두 축을 한 표에 싣고(가름은 칩), 보관한 프로젝트는 같은 화면의 딴 모드로 남긴다.
//   잣대는 lib/past-sess.ts 한 자리에 있다(순수 함수 — scripts/past-sess.test.mjs 가 값으로 지킨다).
//  ⚠ 주소(#/archive)는 그대로다 — 열어 둔 탭·고정한 자리가 그 문자열을 들고 있다. 바꾸면 그 창들이 빈 화면이 된다.
//  ⚠ 「내 세션」만 싣는다 — 여기서 하는 일(이어서 열기·목록으로 되돌리기·휴지통으로)이 전부 주인의 몫이다.
//   남의 세션은 프로젝트 화면 ▸ [지난 세션] 칸에서 본다.
let dismissedCache: DismissedSession[] = [];
let dismissedAt = 0;
let dismissedLoading = false;
/** 치운 세션 재료(#3857) — 전용 창구 하나. 이 화면이 20초마다 다시 그려져도 15초 안엔 다시 부르지 않는다. */
function ensureDismissed(repaint: () => void): void {
  if (dismissedLoading || Date.now() - dismissedAt <= 15_000) return;
  dismissedLoading = true;
  void listDismissedSessions()
    .then((rows) => { dismissedCache = rows; dismissedAt = Date.now(); })
    .catch(() => { /* 못 받았으면 직전 판을 그대로 둔다 */ })
    .finally(() => { dismissedLoading = false; repaint(); });
}

/** 한 줄이 들고 있는 것 — 세션 행(내 세션)과, 세션 목록엔 없고 치움 기록만 남은 행을 같은 모양으로 만든다. */
interface PastItem extends PastSessLike {
  key: string; name: string; stateKey: string; stateLabel: string; s: Sess | null; dismissed: boolean;
}

/** 화면 상태 — 모듈 수준인 이유는 trashUi 와 같다(20초 결로가 render 를 통째로 다시 부른다). */
const pastUi = {
  mode: 'sess' as 'sess' | 'proj',      // 세션 보기 / 보관한 프로젝트 보기
  scope: 'all' as PastScope,
  period: 'all' as PastPeriod,
  group: true,                          // 프로젝트로 묶기(끄면 날짜 묶음)
  q: '', newestFirst: true, shown: PAGE,
  sel: new Set<string>(), focus: null as string | null,
  closed: new Set<number>(),            // 접어 둔 프로젝트 묶음
};

export function renderPast(host: HTMLElement, data: V2Data, hooks: BinHooks = {}, aside?: HTMLElement | null): void {
  const ui = pastUi;
  const now = Date.now();
  const dism = new Set(dismissedCache.map((d) => String(d.session_id || '')).filter(Boolean));
  const archProjs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p));   // 버린 것은 휴지통이 맡는다

  // ── 재료 ──
  const items: PastItem[] = [];
  const known = new Set<string>();
  for (const s of data.sessions) {
    if (!s.owned || isTrashedSess(s)) continue;
    if (!standsInPast(s, dism)) continue;
    const it: PastItem = {
      id: s.id, logId: s.logId || null, altIds: s.altIds, projectId: s.projectId,
      live: s.live, alive: s.alive, trashedAt: s.trashedAt || null, lastSeen: s.lastSeen,
      key: s.id, name: sessText(s, projName(data, s.projectId)).main || s.label || s.id,
      stateKey: s.stateKey, stateLabel: s.stateLabel, s, dismissed: isDismissedSess(s, dism),
    };
    items.push(it);
    for (const n of pastNames(it)) known.add(n);
  }
  //  세션 목록엔 없고 치움 기록만 남은 줄 — 그래도 세운다(치운 것이 «어디에도 없는» 상태가 #3857 이 고친 그 증상이다).
  //  ⚠ 서버가 gone 이라 한 것은 뺀다 — 되살릴 수도 열 수도 없어 되돌려도 설 자리가 없다.
  for (const d of dismissedCache) {
    const sid = String(d.session_id || '');
    if (!sid || known.has(sid) || d.subject_state === 'gone') continue;
    known.add(sid);
    items.push({
      id: sid, projectId: d.subject_project_id ?? null, live: false, alive: false, trashedAt: null,
      lastSeen: Date.parse(String(d.closed_at || '')) || 0,
      key: sid, name: String(d.subject_label || d.title || sid), stateKey: 'log', stateLabel: '기록', s: null, dismissed: true,
    });
  }

  const needle = ui.q.trim().toLowerCase();
  const hay = (it: PastItem): string => `${it.name} ${projName(data, it.projectId ?? null)} ${it.id}`.toLowerCase();
  const visible = (): PastItem[] => selectPast(items, {
    dismissed: dism, scope: ui.scope, period: ui.period, now, newestFirst: ui.newestFirst,
    match: needle ? (it: PastItem) => hay(it).includes(needle) : undefined,
  });
  const dismN = items.filter((it) => it.dismissed).length;

  // 고른 것 청소 — 다시 그릴 때 사라진 줄은 선택에서도 뺀다.
  const keys = new Set(items.map((it) => it.key));
  for (const k of Array.from(ui.sel)) if (!keys.has(k)) ui.sel.delete(k);
  if (ui.focus && !keys.has(ui.focus)) ui.focus = null;

  // ── 동작 ──
  const restoreRows = (list: PastItem[]): Promise<void> => guard(async () => {
    const ids = [...new Set(list.flatMap((it) => pastNames(it)))];
    if (!ids.length) return;
    try { await restoreDismissedSessions(ids); }
    catch (e: any) { toast('되돌리지 못했어요 — ' + (e?.message || e), true); return; }
    toast(list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)} 홈 목록으로 되돌렸어요.` : `세션 ${list.length}개를 홈 목록으로 되돌렸어요.`);
    ui.sel.clear(); dismissedAt = 0; hooks.onChanged?.();
  });
  const trashRows = (list: PastItem[]): Promise<void> => guard(async () => {
    const names = [...new Set(list.flatMap((it) => (it.s ? sessionNames(it.s) : [it.id])))];
    if (!names.length) return;
    //  사이드바 휴지통 단추와 같은 확인창(#3778) — 종전엔 이 화면만 묻지 않고 보냈다. «다음부터 묻지 않기» 를 켠 사람에겐 어디서든 안 묻는다.
    if (!await confirmSessionTrash({ title: list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)} 휴지통으로 보낼까요?` : `세션 ${list.length}개를 휴지통으로 보낼까요?`, n: list.length })) return;
    try {
      const out = await sessionTrashOp('trash', names);
      if (!out.done.length) { toast('휴지통으로 보내지 못했어요 — ' + (out.skipped[0]?.why || '처리된 세션이 없어요'), true); return; }
    } catch (e: any) { toast('휴지통으로 보내지 못했어요 — ' + (e?.message || e), true); return; }
    toast((list.length === 1 ? `「${list[0].name}」${eulReul(list[0].name)}` : `세션 ${list.length}개를`) + ' 휴지통으로 보냈어요 — 휴지통에서 되돌릴 수 있어요.');
    ui.sel.clear(); dismissedAt = 0; hooks.onChanged?.();
  });

  // ── 조각 ──
  const tblWrap = el('div', { class: 'v2-bin-tblwrap' });
  const chipsEl = el('div', { class: 'v2-bin-chips' });
  const toolsEl = el('div', { class: 'v2-bin-tools' });
  const barEl = el('div', { class: 'v2-bin-selbar' });
  const countEl = el('span', { class: 'v2-bin-count' });
  const search = el('input', { type: 'search', class: 'v2-bin-search', placeholder: '세션·프로젝트 이름으로 찾기', 'aria-label': '지난 세션에서 찾기' }) as HTMLInputElement;
  search.value = ui.q;
  search.addEventListener('input', () => { ui.q = search.value; ui.shown = PAGE; paint(); });

  const chip = (on: boolean, label: string, n: number, onclick: () => void) =>
    el('button', { class: 'v2-bin-chip' + (on ? ' on' : ''), type: 'button', text: `${label} ${n}`, 'aria-pressed': String(on), onclick });
  const paintChips = () => {
    chipsEl.replaceChildren(
      chip(ui.mode === 'sess' && ui.scope === 'all', '전체', items.length, () => { ui.mode = 'sess'; ui.scope = 'all'; ui.shown = PAGE; paint(); }),
      chip(ui.mode === 'sess' && ui.scope === 'dismissed', '치운 것', dismN, () => { ui.mode = 'sess'; ui.scope = 'dismissed'; ui.shown = PAGE; paint(); }),
      //  ★ 보관한 프로젝트는 **없어지지 않는다** — 자리만 이 화면 안의 딴 모드로 옮겼다(사이드바 ▸ 프로젝트 우클릭 ▸ [보관하기]의 도착지).
      chip(ui.mode === 'proj', '보관한 프로젝트', archProjs.length, () => { ui.mode = 'proj'; ui.shown = PAGE; paint(); }));
  };
  const paintTools = () => {
    if (ui.mode === 'proj') { toolsEl.replaceChildren(chipsEl); return; }
    const period = el('select', { class: 'v2-bin-pick', 'aria-label': '기간', onchange: (e: Event) => { ui.period = (e.target as HTMLSelectElement).value as PastPeriod; ui.shown = PAGE; paint(); } },
      ...PAST_PERIODS.map((p) => el('option', { value: p.key, text: p.label, ...(p.key === ui.period ? { selected: 'selected' } : {}) }))) as HTMLSelectElement;
    period.value = ui.period;
    const grpBtn = el('button', { class: 'v2-bin-chip' + (ui.group ? ' on' : ''), type: 'button', text: '프로젝트로 묶기',
      'aria-pressed': String(ui.group), title: ui.group ? '끄면 시간 순서로 늘어놓습니다' : '프로젝트마다 묶어서 보여 줍니다',
      onclick: () => { ui.group = !ui.group; ui.shown = PAGE; paint(); } });
    const sortBtn = el('button', { class: 'btn-text v2-bin-sort', type: 'button', text: ui.newestFirst ? '최근 순' : '오래된 순', title: '정렬을 바꿉니다',
      onclick: () => { ui.newestFirst = !ui.newestFirst; paint(); } });
    toolsEl.replaceChildren(chipsEl, period, grpBtn, el('span', { class: 'sp' }), search, sortBtn);
  };
  const paintBar = () => {
    const vis = visible();
    const picked = vis.filter((it) => ui.sel.has(it.key));
    const anyDism = picked.some((it) => it.dismissed);
    barEl.replaceChildren(...(picked.length ? [
      el('span', { class: 'n', text: `${picked.length}개 선택` }),
      anyDism ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', title: '홈 목록에 다시 세웁니다', onclick: () => void restoreRows(picked.filter((it) => it.dismissed)) }) : null,
      el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows(picked) }),
      el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); paint(); } }),
    ] : []), countEl);
    countEl.textContent = vis.length === items.length ? `${items.length}개` : `${vis.length}개 표시 · 전체 ${items.length}`;
  };

  const rowOf = (it: PastItem): HTMLElement => {
    const tr = el('tr', { class: (ui.focus === it.key ? 'focus' : '') + (it.dismissed ? ' dism' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(it.key), it.name + ' 선택', (on) => { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); paintBar(); paintAside(); })),
      el('td', { class: 'c-name' }, sessIcon(),
        el('a', { class: 't', href: '#/s/' + encodeURIComponent(it.key), text: it.name, title: '세션을 엽니다 — 그때 대화를 그대로 이어서 계속할 수 있어요', onclick: (ev: Event) => { ev.stopPropagation(); dismissedAt = 0; } }),
        it.dismissed ? el('span', { class: 'v2-bin-tag', text: '치움', title: '내가 홈 목록에서 치운 세션이에요 — [홈 목록으로]를 누르면 다시 섭니다' }) : null),
      ...(ui.group ? [] : [el('td', { class: 'c-in' }, el('span', { text: it.projectId ? projName(data, it.projectId) : '프로젝트 없음' }))]),
      el('td', { class: 'c-kind' }, dot(it.stateKey), el('span', { text: it.stateLabel || '지난 세션' })),
      el('td', { class: 'c-when' }, el('span', { class: 'm', text: whenMs(Number(it.lastSeen) || 0), title: it.lastSeen ? new Date(Number(it.lastSeen)).toLocaleString() : '' })),
      el('td', { class: 'c-acts' }, el('span', { class: 'acts' },
        it.dismissed ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', title: '홈 목록에 다시 세웁니다', onclick: () => void restoreRows([it]) }) : null,
        el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', title: '휴지통으로 보냅니다 — 되돌릴 수 있어요', onclick: () => void trashRows([it]) }))));
    tr.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, a')) return;
      ui.focus = ui.focus === it.key ? null : it.key;
      paint();
    });
    return tr;
  };

  //  묶음 머리줄 — 프로젝트로 묶었으면 프로젝트(접을 수 있다), 아니면 날짜.
  const projHead = (g: { id: number; rows: PastItem[] }): HTMLElement => {
    const p = g.id ? data.projects.find((x) => x.id === g.id) : null;
    const closed = ui.closed.has(g.id);
    const name = g.id ? (p ? p.name : `#${g.id}`) : '프로젝트 없음';
    const sel = g.rows.every((it) => ui.sel.has(it.key));
    return el('tr', { class: 'g' + (closed ? ' closed' : '') },
      el('td', { class: 'c-cb' }, cb(sel, `${name} 전체 선택`, (on) => { for (const it of g.rows) { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); } paint(); }, !sel && g.rows.some((it) => ui.sel.has(it.key)))),
      el('td', { colspan: '3' },
        el('button', { class: 'v2-bin-gt', type: 'button', 'aria-expanded': String(!closed), title: closed ? '펴기' : '접기',
          onclick: () => { if (closed) ui.closed.delete(g.id); else ui.closed.add(g.id); paint(); } },
          el('span', { class: 'v2-car', 'aria-hidden': 'true', text: '›' }), folderIcon(), el('b', { text: name })),
        p && isArchivedProj(p) ? el('span', { class: 'v2-bin-tag', text: '보관됨', title: '보관한 프로젝트예요 — [보관한 프로젝트] 칩에서 해제할 수 있어요' }) : null,
        el('span', { class: 'n', text: ` · ${g.rows.length}` })),
      el('td', { class: 'c-acts' }, g.id
        ? el('a', { class: 'btn-text', href: '#/p/' + g.id, text: '프로젝트 열기 →', title: '그 프로젝트 화면을 엽니다' })
        : null));
  };

  const paintTable = () => {
    const vis = visible();
    const body = el('tbody', {});
    let drawn = 0;
    if (ui.group) {
      const groups = groupPastByProject(vis);
      for (const g of groups) {
        if (drawn >= ui.shown) break;
        body.append(projHead(g));
        if (ui.closed.has(g.id)) continue;
        for (const it of g.rows) {
          if (drawn >= ui.shown) break;
          body.append(rowOf(it)); drawn++;
        }
      }
    } else {
      let cur = '';
      for (const it of vis.slice(0, ui.shown)) {
        const b = bucketOf(new Date(Number(it.lastSeen) || 0).toISOString());
        if (b !== cur) {
          cur = b;
          const grp = vis.filter((x) => bucketOf(new Date(Number(x.lastSeen) || 0).toISOString()) === b);
          const gAll = grp.every((x) => ui.sel.has(x.key));
          body.append(el('tr', { class: 'g' },
            el('td', { class: 'c-cb' }, cb(gAll, `${b} 전체 선택`, (on) => { for (const x of grp) { if (on) ui.sel.add(x.key); else ui.sel.delete(x.key); } paint(); }, !gAll && grp.some((x) => ui.sel.has(x.key)))),
            el('td', { colspan: '4' }, el('b', { text: b }), el('span', { class: 'n', text: ` · ${grp.length}` }))));
        }
        body.append(rowOf(it)); drawn++;
      }
    }
    const allOn = vis.length > 0 && vis.every((it) => ui.sel.has(it.key));
    const master = cb(allOn, '보이는 세션 전체 선택', (on) => { for (const it of vis) { if (on) ui.sel.add(it.key); else ui.sel.delete(it.key); } paint(); }, !allOn && vis.some((it) => ui.sel.has(it.key)));
    const left = vis.length - drawn;
    tblWrap.replaceChildren(
      el('table', { class: 'v2-bin-tbl arch past' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'c-cb' }, master), el('th', { text: '세션' }),
          ...(ui.group ? [] : [el('th', { text: '프로젝트' })]),
          el('th', { text: '상태' }), el('th', { text: '마지막' }), el('th', {}))),
        body),
      ...(left > 0 ? [el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${left}개 더 보기`, onclick: () => { ui.shown += PAGE; paint(); } })] : []),
      ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: dismissedLoading && !dismissedAt ? '불러오는 중…' : needle || ui.period !== 'all' || ui.scope !== 'all' ? '이 조건엔 없어요 — 칩이나 기간을 바꿔 보세요.' : '지난 세션이 없어요. 세션이 멈추거나 × 로 치우면 여기 모입니다.' })] : []));
  };

  const paintAside = () => {
    if (!aside) return;
    const box = el('div', { class: 'v2-bin-side' });
    const vis = visible();
    const picked = vis.filter((it) => ui.sel.has(it.key));
    if (picked.length > 1) {
      box.append(el('div', { class: 'v2-bin-side-sum' },
        el('h4', { text: `고른 ${picked.length}개` }),
        el('p', { class: 'd', text: `치운 것 ${picked.filter((it) => it.dismissed).length} · 멈춘 것 ${picked.filter((it) => !it.dismissed).length}` }),
        el('div', { class: 'act' },
          picked.some((it) => it.dismissed) ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '홈 목록으로', onclick: () => void restoreRows(picked.filter((it) => it.dismissed)) }) : null,
          el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows(picked) }))));
    }
    const it = items.find((x) => x.key === ui.focus) || (picked.length === 1 ? picked[0] : null);
    if (!it) {
      if (!picked.length) box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 세션의 안이 여기 열립니다. 이름을 누르면 그 대화를 이어서 계속할 수 있어요.' }));
      aside.replaceChildren(box);
      return;
    }
    const detail = el('div', { class: 'v2-bin-side-detail' },
      el('div', { class: 'h' }, sessIcon(), el('b', { text: it.name }), it.dismissed ? el('span', { class: 'tag', text: '치움' }) : null),
      el('p', { class: 'meta', text: `${it.projectId ? projName(data, it.projectId) : '프로젝트 없음'} · ${it.stateLabel || '지난 세션'} · 마지막 ${whenMs(Number(it.lastSeen) || 0)}` }));
    detail.append(el('div', { class: 'act' },
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/s/' + encodeURIComponent(it.key), text: '이어서 열기', onclick: () => { dismissedAt = 0; } }),
      it.dismissed ? el('button', { class: 'btn-text', type: 'button', text: '홈 목록으로', onclick: () => void restoreRows([it]) }) : null,
      el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void trashRows([it]) }),
      it.projectId ? el('a', { class: 'btn-text', href: '#/p/' + it.projectId, text: '프로젝트 열기 →' }) : null));
    box.append(detail);
    aside.replaceChildren(box);
  };

  const paint = () => {
    if (ui.mode === 'proj') { paintChips(); paintTools(); archivedProjects(tblWrap, barEl, countEl, data, hooks, aside, paint); return; }
    paintChips(); paintTools(); paintTable(); paintBar(); paintAside();
  };

  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('v2-bin-search');
  const scrollTop = host.scrollTop;
  host.replaceChildren(el('div', { class: 'v2-center v2-binpage wide' },
    el('div', { class: 'v2-bin-top' },
      el('div', {},
        el('h1', { class: 'v2-title', text: '지난 세션' }),
        el('p', { class: 'v2-desc', text: '박스가 멈춰 지금은 안 도는 세션과, 홈 목록에서 × 로 치운 세션이에요. 이름을 누르면 그때 대화를 그대로 이어서 계속할 수 있어요.' }))),
    el('section', { class: 'v2-bin-sec' }, toolsEl, barEl, tblWrap)));
  paint();
  ensureDismissed(() => { if (host.isConnected) renderPast(host, data, hooks, aside); });
  if (hadFocus) { search.focus(); const n = search.value.length; try { search.setSelectionRange(n, n); } catch { /* 일부 브라우저는 search 타입에 거부 */ } }
  if (scrollTop) host.scrollTop = scrollTop;
}

// ── 같은 화면의 딴 모드: 보관한 프로젝트 ────────────────────────────────────────
//  통째로 치워 둔 프로젝트와 그 아래 세션. 동사는 둘(보관 해제 · 휴지통으로) — 여기엔 파괴 동사가 없다.
//  ⚠ 「아카이브」라는 **자리**는 없앴지만 프로젝트 보관 자체는 그대로다(사이드바 우클릭 ▸ [보관하기]).
//   그 도착지가 이 모드다 — 없애면 보관한 프로젝트를 되돌릴 길이 사라진다.
function archivedProjects(tblWrap: HTMLElement, barEl: HTMLElement, countEl: HTMLElement, data: V2Data, hooks: BinHooks, aside: HTMLElement | null | undefined, repaint: () => void): void {
  const projs = data.projects.filter((p) => isArchivedProj(p) && !isTrashedProj(p));
  const sessOf = (p: Proj): Sess[] => data.sessions.filter((s) => Number(s.projectId) === p.id && !isTrashedSess(s))
    .sort((a, b) => Number(isLiveSess(b)) - Number(isLiveSess(a)) || b.lastSeen - a.lastSeen);
  const liveOf = (p: Proj): number => sessOf(p).filter(isLiveSess).length;

  const ui = archUi;
  const ids = new Set(projs.map((p) => p.id));
  for (const k of Array.from(ui.sel)) if (!ids.has(k)) ui.sel.delete(k);
  if (ui.focus != null && !ids.has(ui.focus)) ui.focus = null;

  const unarchive = (list: Proj[]): Promise<void> => guard(async () => {
    let done = 0, failed = 0; let why = '';
    for (const p of list) {
      try { await api('/api/ui/v6/projects/' + p.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: false }) }); done++; }
      catch (e: any) { failed++; why = e?.message || String(e); }
    }
    if (!done) { toast('보관을 해제하지 못했어요 — ' + (why || '처리된 프로젝트가 없어요'), true); return; }
    toast((list.length === 1 ? `「${list[0].name}」 보관을 해제했어요 — 사이드바로 돌아왔어요.` : `프로젝트 ${done}개의 보관을 해제했어요.`) + (failed ? ` (${failed}개 실패 — ${why})` : ''), failed > 0);
    ui.sel.clear(); hooks.onChanged?.();
  });
  // 휴지통으로 — 어느 화면이든 같은 길(session-actions.trashProjectsFlow, #3778).
  //  종전엔 «잃는 것이 없다 → 확인창 없이 바로» 였는데 그 전제가 이 표에서는 틀렸다: 같은 줄이 「도는 중 n」을 보여 주고,
  //   서버는 그 세션들을 **멈춘다**(stopLive). 멈추는 것은 잃는 것이다 — 확인창이 그 개수를 말하고 묻는다.
  const toTrash = (list: Proj[]): Promise<void> => guard(async () => {
    const done = await trashProjectsFlow(list.map((p) => ({ id: p.id, name: p.name })));
    if (done) { ui.sel.clear(); hooks.onChanged?.(); }
  });

  const visible = (): Proj[] => projs.slice().sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));

  const rowOf = (p: Proj): HTMLElement => {
    const ss = sessOf(p); const live = liveOf(p);
    const tr = el('tr', { class: (ui.focus === p.id ? 'focus' : '') },
      el('td', { class: 'c-cb' }, cb(ui.sel.has(p.id), p.name + ' 선택', (on) => { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); repaint(); })),
      el('td', { class: 'c-name' }, folderIcon(),
        el('a', { class: 't', href: '#/p/' + p.id, text: p.name, title: '프로젝트 화면을 엽니다', onclick: (ev: Event) => ev.stopPropagation() }),
        el('span', { class: 'mono', text: `#${p.id}` })),
      el('td', { class: 'c-in' }, live ? dot('busy') : null, el('span', { text: ss.length ? `${ss.length}${live ? ` · 도는 중 ${live}` : ''}` : '없음' })),
      el('td', { class: 'c-when' }, whenCell(p.archived_at)),
      el('td', { class: 'c-acts' }, el('span', { class: 'acts' },
        el('button', { class: 'btn-text', type: 'button', text: '보관 해제', title: '원래 자리(사이드바·보드)로 되돌립니다', onclick: () => void unarchive([p]) }),
        el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', title: '휴지통으로 보냅니다 — 되돌릴 수 있어요', onclick: () => void toTrash([p]) }))));
    tr.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('button, input, a')) return;
      ui.focus = ui.focus === p.id ? null : p.id;
      repaint();
    });
    return tr;
  };

  const vis = visible();
  const body = el('tbody', {});
  for (const p of vis) body.append(rowOf(p));
  const allOn = vis.length > 0 && vis.every((p) => ui.sel.has(p.id));
  const master = cb(allOn, '보이는 항목 전체 선택', (on) => { for (const p of vis) { if (on) ui.sel.add(p.id); else ui.sel.delete(p.id); } repaint(); }, !allOn && vis.some((p) => ui.sel.has(p.id)));
  tblWrap.replaceChildren(
    el('table', { class: 'v2-bin-tbl arch' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'c-cb' }, master), el('th', { text: '이름' }), el('th', { text: '세션' }),
        el('th', { text: '보관한 때' }), el('th', {}))),
      body),
    ...(!vis.length ? [el('p', { class: 'v2-bin-empty', text: '보관한 프로젝트가 없어요. 사이드바 프로젝트 행을 오른쪽 클릭 ▸ [보관하기]로 치워 두면 사이드바가 가벼워져요.' })] : []));

  const picked = vis.filter((p) => ui.sel.has(p.id));
  barEl.replaceChildren(...(picked.length ? [
    el('span', { class: 'n', text: `${picked.length}개 선택` }),
    el('button', { class: 'btn-text', type: 'button', text: '보관 해제', onclick: () => void unarchive(picked) }),
    el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash(picked) }),
    el('button', { class: 'btn-text', type: 'button', text: '선택 해제', onclick: () => { ui.sel.clear(); repaint(); } }),
  ] : []), countEl);
  countEl.textContent = `${vis.length}개`;

  if (!aside) return;
  const box = el('div', { class: 'v2-bin-side' });
  const p = projs.find((x) => x.id === ui.focus) || (picked.length === 1 ? picked[0] : null);
  if (!p) {
    box.append(el('p', { class: 'v2-bin-side-hint', text: '행을 누르면 그 프로젝트의 세션이 여기 열립니다.' }));
    aside.replaceChildren(box);
    return;
  }
  const ss = sessOf(p);
  const detail = el('div', { class: 'v2-bin-side-detail' },
    el('div', { class: 'h' }, folderIcon(), el('b', { text: p.name }), el('span', { class: 'tag', text: `#${p.id}` })),
    el('p', { class: 'meta', text: `보관 ${when(p.archived_at)} · 세션 ${ss.length}개` }));
  if (ss.length) {
    detail.append(el('h5', { text: '세션' }));
    for (const s of ss.slice(0, 8)) detail.append(sideLi(dot(s.stateKey), sessText(s, p.name).main || s.id, s.stateLabel, '#/s/' + encodeURIComponent(s.id)));
    if (ss.length > 8) detail.append(el('p', { class: 'meta', text: `외 ${ss.length - 8}개` }));
  } else detail.append(el('p', { class: 'meta', text: '이 프로젝트엔 세션이 없어요.' }));
  detail.append(el('div', { class: 'act' },
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '보관 해제', onclick: () => void unarchive([p]) }),
    el('button', { class: 'btn-text danger', type: 'button', text: '휴지통으로', onclick: () => void toTrash([p]) }),
    el('a', { class: 'btn-text', href: '#/p/' + p.id, text: '프로젝트 열기 →' })));
  box.append(detail);
  aside.replaceChildren(box);
}

// ══════════════════════════════ AI 세션 전체 (#/app/terminal) ══════════════════════════════
//  #4158 — 회의 #3977(2026-09-14) «AI 세션 탭 = 전체 세션 풀스크린 조회» · 액션 아이템 P1-4 «풀스크린 목록, 날짜/사람 필터».
//  ★ #4233 안 A(원준 2026-09-25 «안 A 좋아 · 매니지드까지»): 위키 2판과 같은 구성으로 바꿨다.
//   · 머리 두 줄 — 1행 빵부스러기(AI 세션 / 전체 · 프로젝트), 2행 도구줄(묶기 · 기간 · 사람 · 상태 칩 · 찾기 · ＋ 새 세션). 테두리 상자 없음.
//   · 「지금 볼 것」 카드 줄(내 세션 중 확인 필요 → 작업 완료 → 작업 중 → 대기 중, 최대 4장) → 묶음별 목록(묶음 머리 + 46px 행).
//   · 묶기는 날짜 · 프로젝트 · 사람 · 상태 넷(원준 «날짜 말고 사람으로 묶거나 다른 옵션으로도»). 이름 없는 세션은 묶음마다 한 줄로 접는다.
//   · 행을 누르면 **오른쪽 사이드 피크**에 대화 끝부분이 뜬다(화면 이동 없음). 피크의 입력칸으로 도는 세션에 바로 보낸다.
//     홈으로 가는 길은 피크의 [세션 열기]와 행 두 번 클릭 — 종전 «줄을 누르면 홈에서 연다»(P1-4)를 이 결정이 바꿨다.
//  ★ 이 표가 계속 지키는 셋(#4158):
//   ① **전부** 싣는다 — 도는 것·지난 것·남의 것(프로젝트 공개·초대). 휴지통 것만 뺀다(제 화면이 있다, #1851).
//   ② 홈과 **한 자**다 — 행이 홈 목록에서 어디 있나(목록에 둠·치움)는 셸이 홈 사이드바와 같은 함수로 재어 넘기고(hooks.verdict),
//      치우기는 홈의 × 와 같은 함수로 간다(hooks.onDismiss). 치운 세션은 「치움」 꼬리표를 달고 그대로 선다.
//   ③ 홈에서 여는 길은 홈 사이드바 행과 같은 문(hooks.onOpen ← 셸 openSideRow) 하나뿐이다.
//  ★ #4233 2안(원준 2026-09-25 «2안이 좋아»): 묶기 기준은 **사이드바 머리의 드롭다운**이 고른다(side.ts renderSessions).
//   이 화면 도구줄에는 묶기 단추가 없다. 기준 · 고른 카드 · 고른 줄은 sess-scope.ts 한 자리에서 읽고, 본문 묶음은 mainGroupBy
//   (카드를 안 골랐으면 그 기준, 카드를 골랐으면 프로젝트별, 줄까지 골랐으면 시간별). 빵부스러기가 «AI 세션 / 기준 / 고른 것» 을 적는다.
//  ⚠ 거르기 · 묶기 · 카드 잣대는 lib/sess-all.ts(순수 — scripts/sess-all.test.mjs).
export interface SessAllHooks {
  /** 홈 목록에서의 자리 — **내 세션만** 잰다(남의 것은 null: 치우기도 꼬리표도 없다 — 서버도 주인만 허용한다). */
  verdict: (s: Sess) => SessRowVerdict | null;
  /** 홈에서 연다 — 홈 사이드바 행과 같은 문. 피크의 [세션 열기] · 행 두 번 클릭 · 끝난 세션에 보내기가 부른다. */
  onOpen: (s: Sess) => void;
  /** 홈 목록에서 치우기 — 홈의 × 와 같은 함수(세션은 그대로 돈다). */
  onDismiss: (s: Sess) => void;
  /** 도구줄 [＋ 새 세션] — 사이드바 머리의 ＋ 와 같은 동작(셸 onNewTask). */
  onNew?: () => void;
}

/** 화면 상태 — 모듈 수준인 이유는 pastUi 와 같다(셸의 결이 render 를 통째로 다시 부른다). 기억하지 않는다(페이지 수명). */
const allUi = {
  period: 'all' as PastPeriod, owner: '', state: '', q: '', searching: false,
  shown: PAGE,
  /** 마지막으로 그린 사이드바 선택(기준 · 카드 · 줄) — 바뀌면 [더 보기]는 처음부터, 피크는 닫는다. */
  scopeKey: '',
  /** 접은 묶음(`기준:key`) · 펼친 «이름 없는 세션» 줄(`기준:key`). */
  closed: new Set<string>(), openUntitled: new Set<string>(),
  /** 사이드 피크에 띄운 세션 id('' = 닫힘) · 세션별 입력 중인 글. */
  peek: '', drafts: new Map<string, string>(),
};
/** 피크의 대화 꼬리 — 세션 id → 읽은 시점의 lastSeen · 턴. lastSeen 이 바뀌면(새 활동) 다시 읽는다. */
const peekTail = new Map<string, { seen: number; turns: Turn[] | null; loading: boolean }>();
/** 보내는 중인 세션 — 응답이 오기 전에 다시 보내지 않게(다시 그려도 남는다). */
const peekSending = new Set<string>();
const PEEK_TAIL = 240000;   // 도구 기록이 긴 세션은 사람 · AI 글이 수백 KB 뒤에 있다(last-ask TAIL_FAR 와 같은 값)
const PEEK_TURNS = 16;
/** 키보드(Esc · ↑ ↓)가 지금 그려진 목록을 알아야 한다 — 마지막으로 그린 화면의 순서와 다시 그리기. */
let peekNav: { host: HTMLElement; order: string[]; repaint: () => void } | null = null;
let peekKeysBound = false;

const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', opencode: 'OpenCode', antigravity: 'Antigravity', shell: '셸' };
const harnessName = (s: Sess): string => {
  const h = String((s.raw && s.raw.harness) || '').toLowerCase();
  return HARNESS_NAME[h] || (h ? h[0].toUpperCase() + h.slice(1) : '');
};
const stateRank = (k: string): number => (SESS_STATES[k] ? SESS_STATES[k].rank : 99);
/** 상태 표시 — 눈에 띄어야 할 셋(확인 필요 · 작업 완료 · 작업 중)은 알약, 나머지는 점 + 흐린 글. */
function stateCell(s: Sess): HTMLElement {
  const k = s.stateKey;
  const label = s.stateLabel || '지난 세션';
  if (k === 'waiting' || k === 'done' || k === 'busy') return el('span', { class: 'v2-sa-st ' + dotCls(k) }, dot(k), el('span', { text: label }));
  return el('span', { class: 'v2-sa-st quiet' }, dot(k), el('span', { text: label }));
}
const svgI = (d: string, cls = 'v2-sa-ic'): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d }));
const IC_SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3';
const IC_CHEV = 'M6 9l6 6 6-6';
const IC_UP = 'M18 15l-6-6-6 6';
const IC_OPEN = 'M14 4h6v6 M20 4l-9 9 M19 14v6H4V5h6';
const IC_SEND = 'M5 12h14 M13 6l6 6-6 6';
const IC_MORE = 'M5 12h.01 M12 12h.01 M19 12h.01';
const IC_PLUS = 'M12 5v14 M5 12h14';

export function renderSessAll(host: HTMLElement, data: V2Data, hooks: SessAllHooks): void {
  const ui = allUi;
  const sc = sessScope();
  const scKey = `${sc.by}|${sc.group ?? ''}|${sc.proj ?? ''}`;
  if (ui.scopeKey !== scKey) { ui.scopeKey = scKey; ui.shown = PAGE; ui.peek = ''; }   // 사이드바에서 다른 걸 골랐으면 [더 보기]는 처음부터 · 피크는 닫는다
  const mby = mainGroupBy(sc);
  const now = Date.now();
  const people = sidePeople();
  const repaint = (): void => renderSessAll(host, data, hooks);
  const listOf = new Map(data.projects.map((p) => [p.id, p.list_id ?? null]));
  const items = data.sessions.map((s) => {
    const t = sessText(s, projName(data, s.projectId));
    return {
      s, projectId: s.projectId, trashedAt: s.trashedAt || null, lastSeen: s.lastSeen, stateKey: s.stateKey,
      listId: s.projectId != null ? (listOf.get(s.projectId) ?? null) : null,
      owner: isMineSess(s) ? 'me' : String((s.raw && s.raw.owner) || ''),
      name: t.main || s.label || s.id, untitled: t.untitled,
    };
  });
  type Item = (typeof items)[number];
  const meId = String((state.me && state.me.userId) || '');
  const ownerName = (k: string): string => (k === 'me' ? '나' : (people[k] && people[k].display_name) || k || '알 수 없음');
  const q = { proj: sc.proj, group: sc.group !== null ? { by: sc.by, key: sc.group } : null, period: ui.period, owner: ui.owner, state: ui.state, now };
  const inProj = selectAllSess(items, { ...q, period: 'all', owner: '', state: '' });
  const needle = ui.q.trim().toLowerCase();
  const vis = selectAllSess(items, q).filter((it) => !needle
    || it.name.toLowerCase().includes(needle) || projName(data, it.projectId).toLowerCase().includes(needle));
  //  빵부스러기 — «AI 세션 / 기준 / 고른 것». 고른 것이 없으면 «전체».
  const byLabel = (SESS_GROUP_BYS.find((b) => b.key === sc.by) || SESS_GROUP_BYS[0]).label;
  const pickedProj = sc.proj === null ? '' : (projName(data, sc.proj) || '프로젝트 없음');
  const crumbs = [sc.group !== null ? sessGroupName(sc.by, sc.group, data, ownerName) : '', pickedProj].filter(Boolean);
  const byState = (k: string): number => inProj.filter((it) => it.owner === 'me' && it.stateKey === k).length;
  const open = (s: Sess): void => hooks.onOpen(s);
  const openPeek = (id: string): void => { ui.peek = id; repaint(); };

  // ── 2행 도구줄 — 기간 · 사람 · 상태 칩 · 찾기 · ＋ 새 세션(묶기는 사이드바 머리의 드롭다운) ──
  const period = el('select', { class: 'v2-sa-pick', 'aria-label': '기간', 'data-pick': 'period',
    onchange: (e: Event) => { ui.period = (e.target as HTMLSelectElement).value as PastPeriod; ui.shown = PAGE; repaint(); } },
    ...PAST_PERIODS.map((p) => el('option', { value: p.key, text: p.label }))) as HTMLSelectElement;
  period.value = ui.period;
  const who = el('select', { class: 'v2-sa-pick', 'aria-label': '사람', 'data-pick': 'owner',
    onchange: (e: Event) => { ui.owner = (e.target as HTMLSelectElement).value; ui.shown = PAGE; repaint(); } },
    el('option', { value: '', text: '모든 사람' }),
    ...ownerCounts(items, q).map((o) => el('option', { value: o.key, text: `${ownerName(o.key)} ${o.n}` }))) as HTMLSelectElement;
  who.value = ui.owner;
  const chip = (key: string, label: string, cls: string): HTMLElement | null => {
    const n = byState(key);
    if (!n && ui.state !== key) return null;
    const on = ui.state === key;
    return el('button', { class: `v2-sa-chip ${cls}${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on ? '거르기를 풉니다' : `내 세션 중 ${label}만 봅니다`,
      onclick: () => { ui.state = on ? '' : key; ui.shown = PAGE; repaint(); } }, el('span', { text: `${label} ${n}` }));
  };
  const search = ui.searching || ui.q
    ? el('input', { class: 'v2-sa-q', type: 'search', placeholder: '세션 이름 · 프로젝트 찾기', 'data-pick': 'q', value: ui.q,
        oninput: (e: Event) => { ui.q = (e.target as HTMLInputElement).value; ui.shown = PAGE; repaint(); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { ui.q = ''; ui.searching = false; repaint(); } } })
    : el('button', { class: 'v2-sa-tb ic', type: 'button', 'aria-label': '찾기', title: '세션 찾기', onclick: () => { ui.searching = true; repaint(); host.querySelector<HTMLElement>('[data-pick="q"]')?.focus(); } }, svgI(IC_SEARCH));
  const tools = el('div', { class: 'v2-sa-tools' }, period, who,
    chip('waiting', '확인 필요', 'warn'), chip('busy', '작업 중', 'blue'),
    el('span', { class: 'sp' }), search,
    hooks.onNew ? el('button', { class: 'v2-sa-new', type: 'button', title: '새 세션 — 홈에서 무엇이든 시키면 열려요', onclick: () => hooks.onNew?.() },
      svgI(IC_PLUS), el('span', { text: '새 세션' })) : null);

  // ── 「지금 볼 것」 카드 ──
  const cards = pickNowCards(inProj, stateRank, 4, now);
  const nowSec = cards.length ? el('section', { class: 'v2-sa-now', 'aria-label': '지금 볼 것' },
    el('div', { class: 'v2-sa-now-h' }, el('b', { text: '지금 볼 것' }),
      el('span', { class: 'c', text: `확인 필요 ${byState('waiting')} · 작업 중 ${byState('busy')}` })),
    el('div', { class: 'v2-sa-cards' }, ...cards.map((it) => {
      const s = it.s;
      const ask = lastAsk(s);
      const said = ask && !ask.startsWith('<') ? ask : '';
      return el('button', { class: 'v2-sa-card' + (ui.peek === s.id ? ' on' : ''), type: 'button', 'data-sid': s.id,
        onclick: () => openPeek(s.id), ondblclick: () => open(s) },
        el('div', { class: 'k' }, stateCell(s), el('span', { class: 'sp' }), el('span', { class: 'm', text: whenMs(Number(s.lastSeen) || 0) })),
        el('div', { class: 't', text: it.untitled ? `이름 없는 세션 · ${harnessName(s)}` : it.name }),
        said ? el('div', { class: 'ask' }, el('b', { text: '마지막 말' }), el('span', { text: ' ' + said })) : null,
        el('div', { class: 'p', text: projName(data, s.projectId) || '프로젝트 없음' }));
    }))) : null;

  // ── 묶음별 목록 ──
  const cols = sc.proj === null;
  const headCols = (): HTMLElement[] => [
    ...(cols ? [el('span', { class: 'hc', text: '프로젝트' })] : []),
    el('span', { class: 'hc', text: '상태' }), el('span', { class: 'hc', text: '사람' }), el('span', { class: 'hc', text: 'AI' }), el('span', { class: 'hc', text: '시각' }), el('span', {})];
  const groupLabel = (key: string): string => sessGroupName(mby, key, data, ownerName);
  const order: string[] = [];
  const rowOf = (it: Item): HTMLElement => {
    const s = it.s;
    const v = hooks.verdict(s);
    order.push(s.id);
    //  ⌘/Ctrl/Shift+클릭은 브라우저 몫으로 둔다(새 창·새 탭) — 셸 안 링크의 관례(main.ts bindAltOpen 머리말)와 같다.
    const nameClick = (ev: MouseEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      ev.preventDefault(); ev.stopPropagation(); openPeek(s.id);
    };
    const more = el('button', { class: 'v2-sa-more', type: 'button', 'aria-label': '더 보기', title: '열기 · 홈에서 치우기',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        //  치우기는 **홈 목록에 서 있는 내 세션**에만 — 안 서 있는 줄에서 «목록에서 치우기» 는 뜻이 없다(홈의 × 도 선 줄에만 있다).
        showCtxMenu(r.right - 180, r.bottom + 4, [
          { label: '세션 열기', icon: 'open', run: () => open(s) },
          ...(v && verdictStands(v) ? [{ label: '홈에서 치우기', hint: '세션은 그대로 돌아요', run: () => hooks.onDismiss(s) }] : []),
        ], { title: it.untitled ? '이름 없는 세션' : it.name });
      } }, svgI(IC_MORE));
    const row = el('div', { class: 'v2-sa-row' + (cols ? '' : ' np') + (ui.peek === s.id ? ' on' : '') + (v === 'dismissed' ? ' dism' : ''),
      role: 'button', tabindex: '0', 'data-sid': s.id },
      el('div', { class: 'c-name' }, sessIcon(),
        el('a', { class: 't' + (it.untitled ? ' un' : ''), href: '#/s/' + encodeURIComponent(s.id), text: it.untitled ? `이름 없는 세션 · ${harnessName(s)}` : it.name, onclick: nameClick }),
        v === 'dismissed' ? el('span', { class: 'v2-bin-tag', text: '치움', title: '내가 홈 목록에서 치운 세션이에요. 열면 홈 목록에 돌아와요' }) : null),
      cols ? el('div', { class: 'c-proj' + (s.projectId ? '' : ' none') }, s.projectId ? folderIcon() : null, el('span', { text: projName(data, s.projectId) || '프로젝트 없음' })) : null,
      el('div', { class: 'c-kind' }, stateCell(s)),
      el('div', { class: 'c-who' }, personFace(it.owner === 'me' ? meId : it.owner, 'v2-sall-face', ownerName(it.owner))),
      el('div', { class: 'c-ai', text: harnessName(s) }),
      el('div', { class: 'c-when' }, el('span', { class: 'm', text: whenMs(Number(s.lastSeen) || 0), title: s.lastSeen ? new Date(Number(s.lastSeen)).toLocaleString() : '' })),
      el('div', { class: 'c-acts' }, more));
    row.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('button, a, input, select')) return; openPeek(s.id); });
    row.addEventListener('dblclick', (ev) => { if ((ev.target as HTMLElement).closest('button, input, select')) return; open(s); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); openPeek(s.id); } });
    return row;
  };
  const list = el('div', { class: 'v2-sa-list', 'aria-label': 'AI 세션 목록' });
  let budget = ui.shown;
  //  묶지 않음 — 묶음 머리 없이 열 머리 한 줄, 이름 없는 세션도 접지 않고 전부 최근 순(«완전 raw 한 전체보기»).
  if (mby === 'none' && vis.length) {
    list.append(el('div', { class: 'v2-sa-gh flat' + (cols ? '' : ' np') }, el('span', { class: 'hc', text: '세션' }), ...headCols()));
    for (const it of vis) { if (budget-- <= 0) break; list.append(rowOf(it)); }
  }
  for (const g of mby === 'none' ? [] : groupAllSess(vis, mby, now, stateRank)) {
    if (budget <= 0) break;
    const gk = `${mby}:${g.key}`;
    const closed = ui.closed.has(gk);
    list.append(el('div', { class: 'v2-sa-gh' + (cols ? '' : ' np') },
      el('button', { class: 'l', type: 'button', 'aria-expanded': String(!closed), onclick: () => { if (closed) ui.closed.delete(gk); else ui.closed.add(gk); repaint(); } },
        el('span', { class: 'car' + (closed ? ' shut' : '') }, svgI(IC_CHEV, 'v2-sa-ic sm')),
        el('span', { class: 'pill', text: groupLabel(g.key) }), el('span', { class: 'n', text: String(g.rows.length) })),
      ...headCols()));
    if (closed) continue;
    const named = g.rows.filter((it) => !it.untitled);
    const unnamed = g.rows.filter((it) => it.untitled);
    for (const it of named) { if (budget-- <= 0) break; list.append(rowOf(it)); }
    if (unnamed.length && budget > 0) {
      const uOpen = ui.openUntitled.has(gk);
      const hs = [...new Set(unnamed.map((it) => harnessName(it.s)).filter(Boolean))].join(' · ');
      list.append(el('button', { class: 'v2-sa-fold', type: 'button', 'aria-expanded': String(uOpen),
        onclick: () => { if (uOpen) ui.openUntitled.delete(gk); else ui.openUntitled.add(gk); repaint(); } },
        el('span', { class: 'car' + (uOpen ? '' : ' shut') }, svgI(IC_CHEV, 'v2-sa-ic sm')),
        el('span', { text: `이름 없는 세션 ${unnamed.length}개${hs ? ' · ' + hs : ''}` })));
      if (uOpen) for (const it of unnamed) { if (budget-- <= 0) break; list.append(rowOf(it)); }
    }
  }
  const left = vis.length - Math.min(vis.length, ui.shown);
  const empty = !inProj.length
    ? (sc.group === null && sc.proj === null ? '아직 세션이 없어요. 홈에서 무엇이든 시켜 보세요.' : '고른 묶음에 세션이 없어요.')
    : '이 조건에 맞는 세션이 없어요. 기간 · 사람 · 상태를 바꿔 보세요.';

  // ── 사이드 피크 ──
  const peekIt = ui.peek ? items.find((it) => it.s.id === ui.peek && !it.trashedAt) : undefined;
  if (ui.peek && !peekIt) ui.peek = '';
  const peekEl = peekIt ? renderPeek(peekIt.s, peekIt.untitled ? `이름 없는 세션 · ${harnessName(peekIt.s)}` : peekIt.name, data, hooks, repaint, ownerName(peekIt.owner)) : null;

  const hadPick = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? (document.activeElement.dataset.pick || '') : '';
  const act = document.activeElement;
  const caret = hadPick && (act instanceof HTMLTextAreaElement || act instanceof HTMLInputElement) ? [act.selectionStart, act.selectionEnd] : null;
  const bodyOld = host.querySelector<HTMLElement>('.v2-sa-body');
  const scrollTop = bodyOld ? bodyOld.scrollTop : 0;
  const chatOld = host.querySelector<HTMLElement>('.v2-sa-chat');
  const chatKeep = chatOld && chatOld.dataset.sid === ui.peek && chatOld.scrollHeight - chatOld.scrollTop - chatOld.clientHeight > 24 ? chatOld.scrollTop : -1;
  replaceKids(host, el('div', { class: 'v2-sa' + (peekEl ? ' peeking' : '') },
    el('div', { class: 'v2-sa-top' },
      el('span', { class: 'crumb', text: 'AI 세션' }), el('span', { class: 'sl', text: '/' }),
      el('span', { class: 'crumb k', 'data-by': sc.by, text: byLabel }), el('span', { class: 'sl', text: '/' }),
      ...crumbs.slice(0, -1).flatMap((c) => [el('span', { class: 'crumb', text: c }), el('span', { class: 'sl', text: '/' })]),
      el('b', { class: 'now', text: crumbs.length ? crumbs[crumbs.length - 1] : '전체' }),
      el('span', { class: 'desc', text: vis.length === inProj.length ? `${inProj.length}개` : `${vis.length}개 표시 · 전체 ${inProj.length}` })),
    tools,
    el('div', { class: 'v2-sa-body' },
      nowSec,
      list,
      left > 0 ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${left}개 더 보기`, onclick: () => { ui.shown += PAGE; repaint(); } }) : null,
      !vis.length ? el('p', { class: 'v2-bin-empty', text: empty }) : null,
      //  클래식 세션 관리(만들기 폼 · 노드 · 여러 개 한꺼번에 종료·복원)는 없애지 않았다 — 셸 안 `#/terminal` 로 그대로 열린다.
      el('p', { class: 'v2-bin-fine', text: '새 세션 만들기 · 노드 연결 · 여러 세션 한꺼번에 종료·복원은 세션 관리 화면에서 해요.' },
        el('a', { class: 'btn-text', href: '#/terminal', text: '세션 관리 열기 →' }))),
    peekEl));
  //  셸의 결(8초)이 통째로 다시 그려도 고르던 칸 · 보던 자리 · 입력 중인 글을 잃지 않게 — 「지난 세션」의 검색칸과 같은 규율.
  if (hadPick) {
    const f = host.querySelector<HTMLElement>(`[data-pick="${hadPick}"]`);
    f?.focus();
    if (f instanceof HTMLTextAreaElement || f instanceof HTMLInputElement) {
      const n = f.value.length;
      const a = caret && caret[0] != null ? Math.min(Number(caret[0]), n) : n;
      const b = caret && caret[1] != null ? Math.min(Number(caret[1]), n) : n;
      try { f.setSelectionRange(a, b); } catch (_) { /* search 입력은 선택 범위를 안 받는 브라우저가 있다 */ }
    }
  }
  const bodyNew = host.querySelector<HTMLElement>('.v2-sa-body');
  if (bodyNew && scrollTop) bodyNew.scrollTop = scrollTop;
  const chatNew = host.querySelector<HTMLElement>('.v2-sa-chat');
  if (chatNew) chatNew.scrollTop = chatKeep >= 0 ? chatKeep : chatNew.scrollHeight;
  peekNav = { host, order, repaint };
  bindPeekKeys();
}

/** 사이드 피크 — 대화 끝부분 + 입력칸. 도는 세션은 여기서 바로 보내고(/prompt — 세션 화면과 같은 통로), 끝난 세션은 글을 담아 세션 화면으로 넘긴다. */
function renderPeek(s: Sess, name: string, data: V2Data, hooks: SessAllHooks, repaint: () => void, owner: string): HTMLElement {
  const ui = allUi;
  const seen = Number(s.lastSeen) || 0;
  const tail = peekTail.get(s.id);
  if (!tail || (tail.seen !== seen && !tail.loading)) {
    const next = { seen, turns: tail ? tail.turns : null, loading: true };
    peekTail.set(s.id, next);
    void fetchTurns(s, PEEK_TAIL).then((turns) => { next.turns = turns.slice(-PEEK_TURNS); }, () => { next.turns = next.turns || []; })
      .finally(() => { next.loading = false; if (ui.peek === s.id) repaint(); });
  }
  const cur = peekTail.get(s.id)!;
  const live = isLiveSess(s);
  const mine = isMineSess(s);
  const close = (): void => { ui.peek = ''; repaint(); };
  const step = (d: number): void => {
    const order = peekNav ? peekNav.order : [];
    const i = order.indexOf(s.id);
    if (i < 0) return;   // 카드에서 연 세션이 접힌 묶음 안에 있으면 목록에 없다. 첫 행으로 건너뛰지 않는다(리뷰 지적).
    const nx = order[i + d];
    if (nx) { ui.peek = nx; repaint(); }
  };
  const turns = cur.turns;
  const chat = el('div', { class: 'v2-sa-chat', 'data-sid': s.id },
    ...(turns === null ? [el('p', { class: 'v2-sa-note', text: '대화를 불러오는 중…' })]
      : !turns.length ? [el('p', { class: 'v2-sa-note', text: '읽을 대화가 아직 없어요. 세션 화면에서 전체 기록을 볼 수 있어요.' })]
      : turns.map((t) => (t.who === 'me'
        ? el('div', { class: 'v2-sa-turn me' }, el('span', { class: 'av', text: owner === '나' ? '나' : owner.slice(0, 1) }),
            el('div', { class: 'bx' }, el('div', { class: 'who', text: owner }), el('div', { class: 'tx', text: t.text })))
        : el('div', { class: 'v2-sa-turn ai' }, el('span', { class: 'av', text: 'AI' }),
            el('div', { class: 'bx' }, el('div', { class: 'who', text: harnessName(s) || 'AI' }), el('div', { class: 'md-rendered tx' }, renderMarkdown(t.text))))))));
  //  보내기 — 도는 세션: 세션 화면(session-chat sendPrompt)과 같은 서버 큐(/prompt). 끝난 내 세션: 글을 세션 화면 입력칸으로 넘기고 연다
  //   (그 화면이 «말을 거는 것» 으로 되살린다, #2439). 끝난 남의 세션: 보낼 수 없다(되살리기는 주인만).
  const canSend = live || mine;
  const ta = el('textarea', { class: 'v2-sa-ta', rows: '2', 'data-pick': 'peek', 'aria-label': '메시지',
    placeholder: live ? '메시지 입력' : mine ? '끝난 세션이에요. 보내면 세션 화면에서 이 글로 이어서 시작해요.' : '다른 사람의 끝난 세션에는 보낼 수 없어요.',
    disabled: canSend ? undefined : 'true',
    oninput: (e: Event) => { ui.drafts.set(s.id, (e.target as HTMLTextAreaElement).value); } }) as HTMLTextAreaElement;
  ta.value = ui.drafts.get(s.id) || '';
  if (peekSending.has(s.id)) ta.disabled = true;
  const sendBtn = el('button', { class: 'send', type: 'button', 'aria-label': live ? '보내기' : '세션 열어서 보내기',
    disabled: canSend && !peekSending.has(s.id) ? undefined : 'true', onclick: () => void send() }, svgI(IC_SEND)) as HTMLButtonElement;
  const send = async (): Promise<void> => {
    const text = ta.value.trim();
    if (!text || !canSend || peekSending.has(s.id)) return;
    if (!live) { rememberUnsentDraft(s.id, text); ui.drafts.delete(s.id); hooks.onOpen(s); return; }
    //  두 번 보내지 않는다(리뷰 지적). 보내기 전에 칸을 비우고 이 세션을 «보내는 중»으로 잡는다. 실패하면 글을 돌려준다.
    peekSending.add(s.id); ui.drafts.delete(s.id); ta.value = ''; ta.disabled = true; sendBtn.disabled = true;
    try {
      await api(`/api/ui/terminal/sessions/${encodeURIComponent(s.id)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) });
      const t = peekTail.get(s.id);
      if (t && t.turns) t.turns = [...t.turns, { who: 'me' as const, text }].slice(-PEEK_TURNS);
      toast('보냈어요.');
      repaint();
      //  답은 세션이 턴을 마치면 기록에 오른다 — 조금 뒤 꼬리를 다시 읽는다(목록의 lastSeen 이 바뀌어도 다시 읽는다).
      setTimeout(() => { const t2 = peekTail.get(s.id); if (t2 && !t2.loading) { t2.seen = -1; if (ui.peek === s.id) repaint(); } }, 6000);
    } catch (e: any) {
      ui.drafts.set(s.id, text);
      toast(`보내지 못했어요. ${e?.message || ''}`);
    } finally {
      peekSending.delete(s.id);
      if (ui.peek === s.id) repaint();
    }
  };
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void send(); } });
  const model = String((s.raw && s.raw.flags && s.raw.flags['--model']) || '');
  return el('aside', { class: 'v2-sa-peek', 'aria-label': `${name} 대화` },
    el('div', { class: 'v2-sa-ph' },
      el('span', { class: 'cr', text: `${projName(data, s.projectId) || '프로젝트 없음'} › 세션` }), el('span', { class: 'sp' }),
      el('button', { class: 'ib', type: 'button', 'aria-label': '이전 세션', title: '이전 세션 (↑)', onclick: () => step(-1) }, svgI(IC_UP)),
      el('button', { class: 'ib', type: 'button', 'aria-label': '다음 세션', title: '다음 세션 (↓)', onclick: () => step(1) }, svgI(IC_CHEV)),
      el('button', { class: 'ibt', type: 'button', title: '홈에서 이 세션을 엽니다', onclick: () => hooks.onOpen(s) }, svgI(IC_OPEN), el('span', { text: '세션 열기' })),
      el('button', { class: 'ib', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close }, el('span', { text: '✕' }))),
    el('div', { class: 'v2-sa-ptop' },
      el('h2', { text: name }),
      el('div', { class: 'chips' }, stateCell(s),
        el('span', { class: 'pill', text: projName(data, s.projectId) || '프로젝트 없음' }),
        harnessName(s) ? el('span', { class: 'pill', text: model ? `${harnessName(s)} · ${model}` : harnessName(s) }) : null,
        el('span', { class: 'pill', text: owner }),
        el('span', { class: 'pill', text: whenMs(seen) })),
      s.stateKey === 'waiting' ? el('div', { class: 'v2-sa-ban' },
        el('span', { class: 'msg' }, el('b', { text: '확인 필요.' }), el('span', { text: ' 세션이 승인이나 선택을 기다리고 있어요.' })),
        el('button', { class: 'ibt', type: 'button', onclick: () => hooks.onOpen(s) }, el('span', { text: '세션 열어서 답하기' }))) : null),
    chat,
    el('div', { class: 'v2-sa-cmp' + (canSend ? '' : ' off') }, ta,
      el('div', { class: 'rw' },
        el('span', { class: 'hint', text: live ? '⌘Enter 보내기' : mine ? '세션 화면으로 넘어가요' : '' }),
        sendBtn)));
}

/** Esc 로 피크를 닫고, ↑ ↓ 로 옆 세션으로 — 목록이 화면에 보일 때만(다른 탭에 숨어 있으면 가만히 있는다). 입력칸 안에서는 쓰지 않는다. */
function bindPeekKeys(): void {
  if (peekKeysBound) return;
  peekKeysBound = true;
  document.addEventListener('keydown', (ev) => {
    const nav = peekNav;
    if (!nav || !allUi.peek || !nav.host.isConnected || !nav.host.offsetParent) return;
    const t = ev.target as HTMLElement | null;
    if (t && t.closest && t.closest('textarea, input, select, [contenteditable="true"], .pn-ctx')) return;
    if (ev.key === 'Escape') { allUi.peek = ''; nav.repaint(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = nav.order.indexOf(allUi.peek);
    if (i < 0) return;
    const nx = nav.order[i + (ev.key === 'ArrowDown' ? 1 : -1)];
    if (nx) { ev.preventDefault(); allUi.peek = nx; nav.repaint(); }
  });
}
