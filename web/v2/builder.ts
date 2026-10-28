// v2/builder.ts — **앱빌더**(#4632, 원준 2026-10-14 «앱빌더라는 앱을 하나 새로 만들자 … 앱을 만드는 과정 자체도 앱빌더 안에서»).
//
//  셸이 직접 그리는 빌트인 앱(apps/builtin/builder · system.renderer 'builder' · `#/builder`). 앱 찾기 「기본 앱」 묶음의 타일이 문이다.
//   · 목록: 만들던 앱(이어서) · 내가 만든 앱(고치기 · 배포 설정) · 팀원이 만든 앱(사본 · 원본 고치기) · [+ 새 앱]
//   · 만들기: 「+ 새 앱」 · 「이어서」 · 「고치기」 는 **이 창 안에** 앱 만들기 여섯 단계(app-studio.ts)를 세운다 — 머리줄에 「앱빌더 ›」.
//     닫으면 목록으로 돌아온다. 주소가 정본: #/builder/new · #/builder/s/<세션> · #/builder/app/<앱>?how=edit|copy (lib/builder-flow.ts)
//   · 배포 설정: 카드를 누르면 오른쪽에(원준 2026-10-14 «카드만 눌러도 배포 설정이 뜨게») — 누가 쓰나(#4667 공개 · 나만 — 서버의 공개 상태) ·
//     쓰는 자리(매니페스트 studio.place) · 켜 둠(/apps/:id/enabled) · 앱 찾기에 보이기(pad-hidden) · 판 되돌리기 · 지우기 · 만든 사람 · 책임자.
//  「만들던 앱」 은 이 브라우저의 기록(app-studio STUDIO_KEY) · 서버가 아는 내 만들기(#4667 나만 보는 앱의 build_session) · **내** 앱빌딩 세션(이름 꼴 · 앱빌더 프로젝트)으로 모은다 —
//   내가 다른 컴퓨터에서 만들던 것도 세션으로는 보이고, 누르면 세션 이름 · 앱으로 되살려 이어 간다. 남이 만들던 것은 안 보인다(원준: «다른 사람이 만들고 있는 앱을
//   내가 들어가서 멋대로 이어서 만들면 안 되잖아»). 만들던 앱 카드를 누르면 오른쪽에서 이어서 · **지우기**(앱 + 세션 + 기록 전부).
//   「목록에서 빼기」 는 없앴다(원준 2026-10-26 «만들다가 만게 있으면 그 목록이랑 사이드바에는 항상 전부 보여야 · 안 보이게 하려면 삭제») — 안 보이게 하는 길은 지우기 하나.
//   지우기는 카드에도 있다(원준 2026-10-26 «클릭해서 우측 사이드바로 옮기지 않아도 삭제할 수 있는 버튼을 그 카드에도») — 같은 일 · 두 번 눌러야 지운다.
import { api, el, hasScope, toast } from '../core.js';
import { icon } from './icons.js';
import { appGlassIcon, installedAppFace } from './glass-icon.js';
import { fetchAppVersions, revertApp } from './app-versions.js';
import { builderModelFailed, builderModelNow, deletedSids, isDoneApp, listAllApps, memberName, recVerdict, refreshBuilderModel, type BApp, type BuilderEnv, type Draft } from './builder-model.js';   // 목록 재료 — 앱빌더 사이드바와 같은 한 벌
import { confirmPublish } from './publish-preview.js';   // #4732 공개 전에 표에 할 일을 보여 주고 확인
import { closeAppStudio, dropStudioRec, ensureAppServer, openAppStudio, openAppStudioFor, patchManifest, studioRecBuildingFor, studioRecs, studioUiOnly } from './app-studio.js';
import { readPadHidden, togglePadHidden } from './apps.js';
import { padTileId } from '../lib/pad-hidden.js';
import { PLACE, verJ, verName, type StudioPlace } from '../lib/studio-flow.js';
import { builderRoute, builderSeeRoute, builderTabTitle, builderSessionName, builderSessionWhat, draftStageText, isBuilderSession, isBuildingSession, isEditSessionLabel, parseBuilderHash, parseBuilderRoute, type BuilderWhere } from '../lib/builder-flow.js';
import { renderAppSpec } from './app-spec-page.js';   // #4632 앱 「개발 정보」
import { purgeSessionRecord, sessionTrashOp } from '../session-actions.js';   // #4632 앱빌딩 세션은 완전 삭제(지난 세션 · 휴지통에 두면 다시 「만들던 앱」 에 선다)
import { FOLDER_LIMIT_MAX_GB, folderLine, folderSavedText, parseFolderInput } from '../lib/app-folder-text.js';   // #4785 앱 폴더 줄

export type { BuilderEnv } from './builder-model.js';
const placeOf = (s: BApp['studio']): StudioPlace | '' => (s && (s.place === 'side' || s.place === 'full' || s.place === 'both') ? s.place : '');
const when = (ms: number): string => {
  if (!ms) return ''; const d = new Date(ms); const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? '오늘 ' + hm : (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
};

interface View { root: HTMLElement; top: HTMLElement; body: HTMLElement; list: HTMLElement; panel: HTMLElement; stage: HTMLElement; spec: HTMLElement; specKey: string; specStop: (() => void) | null; sel: string; studioKey: string; watch: number; teamOpen: boolean; seq: number }
const views = new WeakMap<HTMLElement, View>();
//  지우는 중인 만들던 앱 — 지우는 사이 목록이 다시 그려져 새 카드의 단추로 한 번 더 지우지 않게(격리 리뷰).
const deleting = new Set<string>();
/** 두 번 눌러 지우는 단추 — 첫 번은 묻기만(4초 안에 한 번 더). 지우지 못하면(go 가 false 거나 던지면) 다시 누를 수 있게 돌아온다. */
const ARM_MS = 4000;
function armedDelete(cls: string, label: string, armed: string, title: string, go: () => Promise<boolean>): HTMLButtonElement {
  const b = el('button', { class: cls + ' v2-bld-danger', type: 'button', text: label, title: title || null }) as HTMLButtonElement;
  let timer = 0;
  const disarm = (): void => { window.clearTimeout(timer); delete b.dataset.arm; b.textContent = label; };
  b.onclick = async () => {
    if (!b.dataset.arm) { b.dataset.arm = '1'; b.textContent = armed; timer = window.setTimeout(disarm, ARM_MS); return; }
    disarm(); b.disabled = true;
    let done = false;
    try { done = await go(); }
    catch (e: any) { toast('지우지 못했어요. ' + (e && e.message ? e.message : e), true); }
    finally { if (!done) b.disabled = false; }
  };
  return b;
}
//  같은 창 안의 이동(#/builder ↔ #/builder/new …)은 셸이 다시 그리지 않는다(routeKey 가 같다 — tabs.ts) — 가이드 · 자료 · 분류체계처럼 여기서 hashchange 를 듣는다.
let mounted: { host: HTMLElement; env: BuilderEnv } | null = null;
let lastDrawn = '';
/** 주소가 바뀌었을 때 앱빌더가 할 일. 그렸으면 true. */
export function builderOnHash(hash: string): boolean {
  if (!mounted) return false;
  if (!mounted.host.isConnected) { mounted = null; return false; }
  if (hash === lastDrawn) return false;
  const h = String(hash || '').replace(/^#\/?/, '');
  const q = h.indexOf('?'); const segs = (q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean);
  if (segs[0] !== 'builder') return false;   // 앱빌더를 떠나는 이동은 셸이 그린다
  const v = views.get(mounted.host); if (!v || !mounted.host.contains(v.root)) { mounted = null; return false; }
  renderBuilderApp(mounted.host, segs, new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), mounted.env);
  return true;
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => { builderOnHash(location.hash); });

/** 앱빌더 안에서 주소만 바꾼다(hashchange 없이 · 뒤로 가기에 남기지 않게). 뒤로/앞으로 순번(history.state)은 그대로 두고,
 *  셸 탭의 주소(탭을 다시 켤 때 이 주소로 돌아온다)와 사이드바의 켜진 줄도 맞춘다. */
function replaceRoute(to: string): void {
  if (location.hash !== to) { try { history.replaceState(history.state, '', location.pathname + location.search + to); } catch (_) { /* noop */ } lastDrawn = to; }
  mounted?.env.setRoute?.(to);
  mounted?.env.redrawSide?.();
}
/** 고른 카드를 바꾼다 — v.sel 과 주소(#/builder?sel=)를 늘 함께. 목록이 아닌 화면(만들기)에서는 주소를 건드리지 않는다. */
function setSel(v: View, key: string): void {
  v.sel = key;
  const w = parseBuilderHash(location.hash);
  if (!w || w.view !== 'list') return;
  replaceRoute(builderRoute('list', key));
}

export function builderTabTitleFor(segs: readonly string[], params: { get(k: string): string | null }): string {
  return builderTabTitle(parseBuilderRoute(segs, params));
}

/** 앱빌더를 그린다 — 주소가 정본. 목록이면 목록을 다시 읽고, 만들기 주소면 그 자리에 앱 만들기 화면을 세운다. */
export function renderBuilderApp(host: HTMLElement, segs: readonly string[], params: { get(k: string): string | null }, env: BuilderEnv): void {
  const where = parseBuilderRoute(segs, params);
  mounted = { host, env }; lastDrawn = typeof location !== 'undefined' ? location.hash : '';
  let v = views.get(host) || null;
  if (!v || !host.contains(v.root)) {
    v = build(env); views.set(host, v); host.replaceChildren(v.root);
    //  창이 닫혀 뿌리가 떨어지면 앱 만들기(폴링 · 대화)를 거둔다 — 안 거두면 떨어진 화면이 계속 서버를 두드린다.
    const vv = v;
    vv.watch = window.setInterval(() => { if (!vv.root.isConnected) { window.clearInterval(vv.watch); if (vv.studioKey) { vv.studioKey = ''; closeAppStudio(); } } }, 2000);
  }
  if (where.view === 'spec') {
    //  개발 정보 — 「‹ 앱빌더」 는 그 앱 카드를 고른 목록으로 돌아간다. 같은 앱을 다시 그리는 것(해시 재적용)이면 그대로 둔다.
    if (v.studioKey) { v.studioKey = ''; closeAppStudio(); }
    v.top.hidden = true; v.body.hidden = true; v.stage.hidden = true; v.spec.hidden = false;
    v.sel = where.id;
    if (v.specKey !== where.id) { closeSpec(v); v.spec.hidden = false; v.specKey = where.id; v.specStop = renderAppSpec(v.spec, where.id, () => { location.hash = builderRoute('list', where.id); }); }
  } else if (where.view === 'list') {
    closeSpec(v);
    if (v.studioKey) { v.studioKey = ''; closeAppStudio(); }
    v.stage.hidden = true; v.top.hidden = false; v.body.hidden = false;
    v.sel = where.id;   // 고른 카드도 주소가 정본이다(#/builder?sel=<앱> — 사이드바의 앱 줄이 이 주소로 온다)
    void paintList(v, env);
  } else {
    closeSpec(v);
    v.top.hidden = true; v.body.hidden = true; v.stage.hidden = false;
    openStudio(v, where, env);
  }
  //  앱빌더 안의 이동은 셸이 다시 그리지 않는다 — 사이드바의 켜진 줄은 여기서 맞춘다.
  env.redrawSide?.();
}

/** 개발 정보 화면을 걷는다(다시 묻기를 멈추고 비운다). */
function closeSpec(v: View): void {
  v.specStop?.(); v.specStop = null; v.specKey = ''; v.spec.hidden = true; v.spec.replaceChildren();
}

function build(env: BuilderEnv): View {
  const top = el('div', { class: 'v2-bld-top' });
  const list = el('div', { class: 'v2-bld-list' });
  const panel = el('div', { class: 'v2-bld-panel' });
  const body = el('div', { class: 'v2-bld-body' }, list, panel);
  const stage = el('div', { class: 'v2-bld-stage', hidden: true });
  //  #4632 「개발 정보」(코드 기준 명세 · v2/app-spec-page.ts)는 만들기 화면과 다른 자리에 선다 — 오가도 만들던 화면을 건드리지 않게.
  const spec = el('div', { class: 'v2-bld-stage', hidden: true });
  const root = el('div', { class: 'v2-bld' }, top, body, stage, spec);
  const v: View = { root, top, body, list, panel, stage, spec, specKey: '', specStop: null, sel: '', studioKey: '', watch: 0, teamOpen: false, seq: 0 };
  void env;
  return v;
}

// ── 앱빌딩 세션 ──
type SessRow = ReturnType<BuilderEnv['sessions']>[number];
const projNameOf = (env: BuilderEnv, pid: number | null): string => { const p = pid ? env.projects().find((x) => x.id === pid) : null; return p ? p.name : ''; };
/** 이 세션이 **내** 앱빌딩 세션인가 — 앱빌더가 연 세션(이름 꼴 · 앱빌더 프로젝트)이고 남의 세션이 아니다. 보통 AI 세션이 저장한 앱의 만들기 세션은 아니다(감사 1-6). */
function myBuilderSession(env: BuilderEnv, sid: string): SessRow | null {
  const s = sid ? env.sessions().find((x) => x.id === sid) || null : null;
  return s && s.owned !== false && !s.task && isBuilderSession(s.label, projNameOf(env, s.projectId)) ? s : null;
}
const errText = (e: any): string => (e && e.message ? e.message : String(e));
/**
 * 앱빌딩 세션을 **완전 삭제**한다 — 멈추고, 되살리기 좌표(desired-state)를 지우고, 완전 삭제 표식을 붙이고(어느 목록 · 어느 컴퓨터에서도
 *  다시 안 선다), 대화 기록까지 파기한다. 휴지통의 「완전 삭제」 와 같은 두 걸음(bins.ts purgeSession)이다.
 *  종전엔 DELETE ?reclaim=1(지난 세션으로 보관)이라 행이 restorable 로 남았고, 앱빌더는 지난 세션도 「만들던 앱」 으로 세워
 *  새로 열면 지운 카드가 다시 섰다(원준 2026-10-28 «진짜 할거라고 다 삭제했는데 … 다 부활해있어» · «실제로 어디에서도 이게 다 지워지게»).
 *  없는 세션 · 이미 완전 삭제된 세션은 지운 것으로 친다. 못 지웠으면 까닭, 지웠으면 빈 글.
 */
async function purgeBuildSession(env: BuilderEnv, sid: string): Promise<string> {
  const row: any = env.sessions().find((x) => x.id === sid) || null;
  const uuid = String((row && (row.logId || (row.raw && row.raw.claudeSessionId))) || '');
  const r = await sessionTrashOp('purge', [sid, uuid].filter(Boolean));
  const s = r.done.length ? null : (r.skipped.find((x) => x.id === sid) || r.skipped[0] || null);
  const w = s ? String(s.why || '') : '';
  if (s && !/없는 세션/.test(w)) return w || '세션을 지우지 못했어요';
  //  대화 기록 — 모으지 않은 세션(기록 없음)이면 404 · 403 이 온다. 세션은 이미 지웠으니 그건 막지 않는다.
  if (uuid) {
    try { await purgeSessionRecord(uuid, String((row && (row.logNode ?? '')) || ''), null); }   // null = 대화 기록만({ log: true }) — 세션이 남긴 지식 · 프로젝트는 건드리지 않는다
    catch (e: any) { if (e?.status !== 404 && e?.status !== 403) toast('앱빌딩 세션은 지웠지만 대화 기록을 지우지 못했어요. (' + errText(e) + ')', true); }
  }
  return '';
}
/** 기록은 있는데 셸의 세션 목록에 없는 만들기 — 서버에 그 세션 하나를 따로 묻는다(감사 1-5 · 목록이 잘렸을 수 있다). 없다(404 · 410)일 때만 'gone'.
 *  403 은 «있지만 못 본다» 라 지운 것으로 치지 않는다(기록을 걷지 않는다 · 리뷰 N7). 한 번에 여덟 개까지. 답이 바뀐 것이 있으면 true.
 *  모르는 실패(네트워크 · 5xx)는 답 없음이라 다음 그리기에서 다시 묻는다. */
async function askRecSessions(sids: readonly string[]): Promise<boolean> {
  let changed = false;
  await Promise.all(sids.slice(0, 8).map(async (sid) => {
    try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid)); recVerdict.set(sid, 'alive'); changed = true; }
    catch (e: any) {
      if (e && (e.status === 404 || e.status === 410)) { recVerdict.set(sid, 'gone'); changed = true; }
      else if (e && e.status === 403) { recVerdict.set(sid, 'alive'); changed = true; }
    }
  }));
  return changed;
}
/** 앱을 지울 때 그 앱의 만들기 세션이 **내 앱빌딩 세션**이면 sid — 셸 목록에 있으면 그 줄로, 목록에서 잘렸으면 서버에 그 세션 하나를 물어 이름 꼴로 가른다(리뷰 N2).
 *  모르면(못 물음 · 보통 세션 · 남의 세션) 빈 글 — 건드리지 않는다. */
async function builderSessionOf(env: BuilderEnv, sid: string): Promise<string> {
  if (!sid) return '';
  if (env.sessions().some((x) => x.id === sid)) return myBuilderSession(env, sid) ? sid : '';
  try { const d: any = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid)); return d && !d.movedTo && isBuilderSession(String(d.label || ''), '') ? sid : ''; }
  catch (_) { return ''; }
}

// ── 만들기 — 이 창 안에 앱 만들기 화면을 세운다 ──
function openStudio(v: View, where: BuilderWhere, env: BuilderEnv): void {
  const key = where.view + ':' + where.id + ':' + where.how;
  if (v.studioKey === key && v.stage.querySelector('.v2-studio')) return;   // 같은 자리를 다시 그리는 것(해시 재적용) — 만들던 화면을 그대로 둔다
  v.studioKey = key;
  const opts = { host: v.stage, onClose: () => {
    v.studioKey = '';
    //  닫기 = 목록으로 — 열기 전에 골라 둔 카드 그대로. 이미 다른 데로 갔으면(창 닫힘 · 다른 주소) 건드리지 않는다.
    if (/^#\/builder\/(new|s|app)(\/|\?|$)/.test(location.hash)) location.hash = builderRoute('list', v.sel);
  }, onSession: (sid: string) => {
    //  세션이 생겼다 — 주소를 그 세션으로 바꿔 둔다(새로고침 · 뒤로 와도 만들던 자리). hashchange 를 내지 않아(replaceState) 지금 화면은 그대로다.
    const to = builderRoute('resume', sid);
    v.studioKey = 'resume:' + sid + ':edit';
    replaceRoute(to);   // 사이드바에도 새 앱이 「만들던 앱」 에 켜진 채로 선다 · 탭을 다시 켜도 이 자리로
  }, onSee: (sid: string, see: 'widget' | 'app' | null) => {
    //  ③ 실제 화면으로 써 보는 중 — 주소에 적어(#/builder/s/<세션>?see=…) 셸이 앱빌더 사이드바를 접게 한다(lib/side-owner · 원준 2026-10-19 «안그렇게 해줘»).
    //   지금 주소가 그 세션을 이어 만드는 주소일 때만 주소창을 고친다 — 이미 다른 데로 갔으면(앱 화면 #/i · 다른 탭) 주소창은 그대로.
    //   ⚠ 걷을 때(null)는 그래도 **이 탭의 주소**는 고친다 — 안 그러면 탭을 다시 켤 때 낡은 ?see= 가 주소로 되살아나 허브에서 사이드바가 접힌 채 선다(격리 리뷰).
    const to = see ? builderSeeRoute(sid, see) : builderRoute('resume', sid);
    const w = parseBuilderHash(location.hash);
    if (w && w.view === 'resume' && w.id === sid) { replaceRoute(to); return; }
    if (!see) mounted?.env.setRoute?.(to);
  } };
  if (where.view === 'new') { openAppStudio(null, opts); return; }
  if (where.view === 'resume') {
    const rec = studioRecs().find((r) => r.sid === where.id);
    if (rec) { openAppStudio({ sid: where.id }, opts); return; }
    //  이 브라우저에 기록이 없는 앱빌딩 세션 — 세션 이름과(있으면) 그 세션이 만든 앱으로 되살린다.
    const s = env.sessions().find((x) => x.id === where.id);
    //  앱빌더가 연 내 세션이 아니면 잇지 않는다 — 보통 AI 세션을 새 앱 만들기로 열면 그 앱이 «만드는 중» 으로 쳐져 앱 찾기에서 빠졌고, 남의 세션으로도 들어갔다(감사 1-6).
    if (s && !myBuilderSession(env, s.id)) { toast('앱빌더에서 만든 세션이 아니라서 여기서 이어 만들 수 없어요'); location.hash = builderRoute('list'); return; }
    void listAllApps().then(async (apps) => {
      if (v.studioKey !== key) return;
      //  있는 앱을 고치던 세션(«"이름" 앱 고치기»)은 고치기 흐름으로 잇는다 — 새 앱 ②부터가 아니라(감사 1-3). 고치던 앱은 가운데 목록과 같은 자로 찾는다.
      if (s && isEditSessionLabel(s.label)) {
        await refreshBuilderModel();
        const M = builderModelNow(env);
        const d = M ? M.drafts.find((x) => x.sid === where.id) || null : null;
        const t = d && d.appId ? apps.find((x) => x.id === d.appId) || null : null;
        if (v.studioKey !== key) return;
        if (d && t) { openAppStudio({ sid: where.id, what: t.title, appId: t.id, title: t.title, mode: d.mode === 'edit' ? 'edit' : 'copy', origin: d.origin || { id: t.id, title: t.title, by: t.madeBy } }, opts); return; }
      }
      //  #4667 그 세션이 만드는 앱은 서버 기록(build_session)으로 — 예약만 된 빈 앱이면 앱 없이(②부터) 연다.
      const a = apps.find((x) => x.buildSession === where.id) || null;
      const what = s ? builderSessionWhat(s.label) : '';
      if (!what && !a) { toast('그 세션의 기록을 찾을 수 없어 새로 만들어요'); location.hash = builderRoute('new'); return; }
      //  이름은 사람이 정한 것 — 세션 이름 «"이름" 앱 제작» 에 박혀 있다(다른 브라우저에서 이어도 같은 이름 · 원준 2026-10-15). 없으면 첫 판의 앱 이름.
      const named = s ? builderSessionName(s.label) : '';
      openAppStudio({ sid: where.id, what: what || (a ? a.title : ''), appId: a && !a.empty ? a.id : '', title: named || (a && !a.empty ? a.title : '') }, opts);
    });
    return;
  }
  void listAllApps().then((apps) => {
    if (v.studioKey !== key) return;
    const a = apps.find((x) => x.id === where.id);
    if (!a) { toast('그 앱을 찾을 수 없어요'); location.hash = builderRoute('list'); return; }
    let how = where.how;
    if (how === 'edit' && !a.canEdit) { how = 'copy'; toast('이 앱은 지정한 사람만 고칠 수 있어요. 내 사본을 만들어 고쳐요.'); }
    void openAppStudioFor({ id: a.id, title: a.title, by: a.madeBy, place: placeOf(a.studio) || undefined }, how, opts);
  });
}

// ── 목록 ──
/** 목록을 그린다. soft = 카드만 골랐다(감사 6-2) — 목록을 «불러오는 중» 으로 비우지 않고, 받아 둔 앱 목록(30초)을 그대로 쓴다. */
async function paintList(v: View, env: BuilderEnv, soft = false): Promise<void> {
  const seq = ++v.seq;
  if (!soft || !v.list.querySelector('.v2-bld-sec')) v.list.replaceChildren(el('p', { class: 'v2-bld-empty', text: '불러오는 중…' }));
  await refreshBuilderModel(!soft);
  //  셸이 세션 목록을 아직 못 받았으면 받을 때까지(15초까지) 기다린다 — 받기 전엔 이 브라우저의 기록이 지운 만들기인지 모른다
  //   (builder-model goneRec). 가운데 목록은 셸이 세션을 새로 받아도 다시 그려지지 않으니, 먼저 그리면 지운 카드가 그대로 남는다.
  for (let t = 0; env.sessionsReady && !env.sessionsReady() && t < 50 && seq === v.seq; t++) await new Promise((r) => setTimeout(r, 300));
  const M = builderModelNow(env);
  if (seq !== v.seq || !v.root.isConnected) return;
  //  서버에 세션이 없는 이 브라우저의 기록 — 지운 만들기다(다른 브라우저에서 지웠다). 기록도 걷는다(앱 찾기의 «만드는 중» 판정도 이 기록을 읽는다).
  if (M) M.goneRecs.forEach((sid) => { dropStudioRec(sid); recVerdict.delete(sid); });
  //  목록에 없는 기록은 서버에 하나씩 물어본 뒤에 판정한다(감사 1-5). 답이 오면 다시 그린다(살아 있으면 카드가 서고, 없으면 기록을 걷는다).
  if (M && M.askRecs.length) void askRecSessions(M.askRecs).then((ch) => { if (ch && seq === v.seq && v.root.isConnected) { void paintList(v, env, true); env.redrawSide?.(); } });
  if (!M) { v.list.replaceChildren(el('p', { class: 'v2-bld-empty', text: builderModelFailed() ? '앱 목록을 불러오지 못했어요. 잠시 후 다시 시도해주세요.' : '불러오는 중…' })); return; }
  const { apps, me: m, drafts, mine, team } = M;
  //  사이드바에서 팀원이 만든 앱을 골라 왔으면 그 묶음을 펴 둔다 — 고른 카드가 접힌 묶음 안에 숨지 않게.
  if (v.sel && team.some((a) => a.id === v.sel)) v.teamOpen = true;
  const hidden = new Set(readPadHidden());
  const refresh = (): void => { void paintList(v, env); };
  const repaint = (): void => { void paintList(v, env, true); };   // 서버에서 바뀐 것이 없다 — 깜빡이지 않게(감사 6-2)
  //  카드를 고르면 주소에도 적는다(setSel) — 사이드바가 같은 줄을 켠다.
  const pick = (key: string): void => { setSel(v, key); repaint(); };
  //  개발 정보(#4632)는 첫 버전이 있으면 만들던 앱에도 선다(원준 2026-10-27 «개발 정보 페이지 이건 어디있는걸까?» — 회의록은 아직 만들던 앱이다).
  //   거기서 「‹ 앱빌더」 로 돌아오면 주소는 그 앱(#/builder?sel=<앱>)이라, 그 앱을 만들던 카드를 고른다.
  const specApp = (d: Draft): string => (d.appId && apps.some((x) => x.id === d.appId && !x.empty) ? d.appId : '');
  //   그 앱이 앱 카드로도 서 있으면(고치던 앱 · keepApp) 앱 카드 그대로 — 배포 설정이 선다.
  if (v.sel && !v.sel.startsWith('draft:') && !mine.some((a) => a.id === v.sel) && !team.some((a) => a.id === v.sel)) { const d = drafts.find((x) => specApp(x) === v.sel); if (d) setSel(v, 'draft:' + d.sid); }
  const specBtn = (id: string): HTMLElement => el('button', { class: 'btn btn-ghost v2-bld-info', type: 'button', title: '이 앱이 코드로 어떻게 돌아가는지 쉬운 말로 봐요', onclick: () => { location.hash = builderRoute('spec', id); } }, icon('info', 'v2-ic'), el('span', { text: '개발 정보' }));

  const appCard = (a: BApp, own: boolean): HTMLElement => {
    const pl = placeOf(a.studio);
    const chips: Array<[string, string]> = [[a.enabled ? 'ok' : 'off', a.enabled ? '켜짐' : '꺼짐']];
    if (pl) chips.push(['', PLACE[pl].title]);   // 쓰는 자리는 칩 하나로만(작은 줄에 또 적지 않는다 · 감사 6-9)
    if (hidden.has(padTileId('installed', a.id))) chips.push(['', '앱 찾기에 안 보임']);
    //  #4667 공개 상태 · 내 초안 · 원본 · 만든 사람 — 전부 서버 기록
    chips.unshift(a.visibility === 'me' ? ['me', '나만 씀'] : ['ok', '모두 씀']);
    if (a.draft) chips.push(['st', '비공개 ' + verName(a.draft.versionNo)]);
    if (a.origin) chips.push(['', '원본: ' + (a.origin.title || a.origin.id)]);
    if (!own && a.madeBy) chips.push(['me', memberName(a.madeBy) + ' 만듦']);   // 계정 아이디가 아니라 표시 이름(감사 6-5)
    //  카드 자체가 배포 설정의 문이다(원준 2026-10-14) — 안의 단추는 제 일을 하고(위로 번지지 않는다), 그 밖 어디를 눌러도 오른쪽에 이 앱의 배포 설정이 선다.
    const card = el('div', { class: 'v2-bld-card v2-bld-card--sel' + (v.sel === a.id ? ' on' : ''), role: 'listitem', tabindex: '0', title: '누르면 오른쪽에 배포 설정이 떠요',
      onclick: (e: MouseEvent) => { if ((e.target as HTMLElement).closest('button')) return; pick(a.id); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); pick(a.id); } } },
      el('div', { class: 'hd' }, appGlassIcon(installedAppFace({ id: a.id, hasUi: a.hasUi, icon: a.icon })), el('div', { style: 'min-width:0' }, el('b', { text: a.title }), el('small', { text: [verLine(a, m.id), when(a.installedAt)].filter(Boolean).join(' · ') }))),
      el('div', { class: 'v2-bld-chips' }, ...chips.map(([k, t]) => el('span', { class: 'v2-bld-chip' + (k ? ' ' + k : ''), text: t }))),
      el('div', { class: 'v2-bld-acts' },
        own || a.canEdit
          ? el('button', { class: 'v2-bld-pri sm', type: 'button', text: '고치기', title: '말과 코멘트로 이 앱을 고쳐 다음 버전을 만들어요', onclick: () => { location.hash = builderRoute('app', a.id, 'edit'); } })
          : el('button', { class: 'v2-bld-pri sm', type: 'button', text: '내 사본 떠서 고치기', onclick: () => { location.hash = builderRoute('app', a.id, 'copy'); } }),
        own ? null : el('button', { class: 'btn btn-ghost', type: 'button', text: '사본', title: '원본은 그대로 두고 내 사본을 고쳐요', onclick: () => { location.hash = builderRoute('app', a.id, 'copy'); } }),
        //  #4632 코드 기준 명세(원준 2026-10-26 «(i) 같은거나 … 개발 정보? 뭐 이런 느낌이 드는 버튼»)
        specBtn(a.id)));
    return card;
  };
  //  만들던 앱 — 단계는 아래 줄에 한 번만(원준 2026-10-14 «세부 기획 정하기가 두 번이네 · 뱃지 빼버려»). 카드를 누르면 오른쪽에 이어서 · 지우기.
  const draftKey = (d: Draft): string => 'draft:' + d.sid;
  const draftCard = (d: Draft): HTMLElement => {
    const card = el('div', { class: 'v2-bld-card v2-bld-card--sel' + (v.sel === draftKey(d) ? ' on' : ''), role: 'listitem', tabindex: '0', title: '누르면 오른쪽에 이어서 만들기와 지우기가 나와요',
      onclick: (e: MouseEvent) => { if ((e.target as HTMLElement).closest('button')) return; pick(draftKey(d)); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); pick(draftKey(d)); } } },
      el('div', { class: 'hd' }, appGlassIcon('builder'), el('div', { style: 'min-width:0' }, el('b', { text: d.title }), el('small', { text: [draftStageText(d.stage, !!d.appId, d.done, d.fixing), when(d.at), d.local ? '' : '다른 컴퓨터에서'].filter(Boolean).join(' · ') }))),
      el('div', { class: 'v2-bld-acts' },
        el('button', { class: 'v2-bld-pri sm', type: 'button', text: '이어서 만들기', onclick: () => { location.hash = builderRoute('resume', d.sid); } }),
        specApp(d) ? specBtn(specApp(d)) : null,
        el('span', { class: 'v2-studio-sp' }),
        armedDelete('btn btn-ghost', '지우기', '한 번 더 누르면 지워져요', d.keepApp ? '고치던 세션과 기록을 지워요. 앱은 그대로 있어요.' : '앱, 앱빌딩 세션, 기록을 모두 지워요. 되돌릴 수 없어요.', () => deleteDraft(d))));
    return card;
  };
  //  지우기 — 앱(있으면 · 판 이력째) → 앱빌딩 세션(멈추고 휴지통으로) → 이 브라우저의 기록. 진짜로 없어진다(원준: «기능적으로도 싹 삭제»). 지웠으면 true.
  const deleteDraft = async (d: Draft): Promise<boolean> => {
    if (deleting.has(d.sid)) return false;
    deleting.add(d.sid);
    try { return await deleteDraftNow(d); } finally { deleting.delete(d.sid); }
  };
  const deleteDraftNow = async (d: Draft): Promise<boolean> => {
    const why = errText;
    //  #4667 만들던 앱 = 나만 보는 앱(예약만 된 빈 앱 포함) — 책임자가 지운다(/discard). 공개한 앱(「원본을 고치기」 로 연 만들던 앱 포함)은
    //   여기서 지우지 않는다 — 모두가 쓰는 앱이다(격리 리뷰 NB-12). 앱빌딩 세션과 이 브라우저의 기록만 걷고, 내 초안은 판 이력에 남는다.
    //   있는 앱을 고치던 것 · 이미 다 된 앱(넣었거나 공개)도 앱은 그대로 둔다(keepApp · 감사 1-1 — 「고치기」 로 열었다 나와 지우면 쓰던 앱이 통째로 지워졌다).
    const appId = d.serverApp || d.appId;
    const shared = !!appId && apps.some((x) => x.id === appId && x.visibility === 'all');
    //   ⚠ 앱을 지우는 것은 **이 만들기가 그 앱을 새로 만든 것이 분명할 때만** — 빈 예약이거나, 이 브라우저의 기록이 새 앱 · 사본이라고 하거나,
    //   기록이 없으면 그 세션이 앱빌더의 새 앱 세션(«"이름" 앱 제작»)일 때. 판정이 어긋나도 쓰던 앱을 지우지 않게 한 겹 더(리뷰 B1).
    const keep = shared || d.keepApp || (!!appId && apps.some((x) => x.id === appId && isDoneApp(x)));
    const target = appId ? apps.find((x) => x.id === appId) || null : null;
    const rec = studioRecs().find((r) => r.sid === d.sid) || null;
    const row = env.sessions().find((x) => x.id === d.sid) || null;
    const madeHere = !!target && (target.empty || (rec ? rec.mode === 'new' || rec.mode === 'copy'
      : d.mode === 'new' && ((!!row && isBuildingSession(row.label, projNameOf(env, row.projectId))) || studioRecBuildingFor(target.id))));
    const discard = !!appId && !keep && madeHere;
    if (discard) {
      try { await api('/api/ui/apps/' + encodeURIComponent(appId) + '/discard', { method: 'POST', body: JSON.stringify({}) }); }
      catch (e: any) { if (e?.status !== 404) { toast('앱을 지우지 못했어요. ' + why(e), true); return false; } }
    }
    const purge = (sid: string): Promise<string> => purgeBuildSession(env, sid);
    let left = '';
    try { left = await purge(d.sid); }
    catch (e: any) { left = why(e); }
    if (left) {
      toast((discard ? '앱은 지웠지만 ' : '') + '앱빌딩 세션을 지우지 못했어요. ' + left, true);
      refresh();
      return false;
    }
    //  ③ 시험 세션(목록엔 안 서는 «"이름" 앱 시험» — app-try-session.ts)도 함께 지운다. 이 브라우저가 띄운 것만 안다 — 없으면 건너뛴다.
    const trySid = (studioRecs().find((r) => r.sid === d.sid) || { trySid: '' }).trySid;
    if (trySid) { try { await purge(trySid); } catch (_) { /* 이미 없으면 그만 */ } }
    deletedSids.add(d.sid); dropStudioRec(d.sid); if (v.sel === draftKey(d)) setSel(v, '');
    toast(shared ? '「' + d.title + '」의 앱빌딩 세션과 기록을 지웠어요. 공개한 앱은 그대로 있고, 비공개 버전은 버전 이력에 남아요.'
      : appId && !discard ? '「' + d.title + '」을 고치던 세션과 기록을 지웠어요. 앱은 그대로 있어요.'
        : discard ? '「' + d.title + '」 앱과 앱빌딩 세션, 기록을 모두 지웠어요.' : '「' + d.title + '」의 앱빌딩 세션과 기록을 지웠어요.');
    refresh();
    return true;
  };

  const sec = (title: string, sub: string, kids: HTMLElement[], empty: string): HTMLElement => el('section', { class: 'v2-bld-sec' },
    el('h3', { text: title }, el('small', { text: sub })),
    kids.length ? el('div', { class: 'v2-bld-grid', role: 'list' }, ...kids) : el('p', { class: 'v2-bld-empty', text: empty }));
  const kids = (xs: Array<HTMLElement | null>): HTMLElement[] => xs.filter((x): x is HTMLElement => !!x);
  v.top.replaceChildren(...kids([
    el('h1', {}, appGlassIcon('builder'), el('span', { text: '앱빌더' })),
    el('span', { class: 'v2-bld-crumb', text: '내가 만든 앱 ' + mine.length + ' · 만들던 앱 ' + drafts.length }),
    el('span', { class: 'v2-studio-sp' }),
    team.length ? el('button', { class: 'btn btn-ghost', type: 'button', text: (v.teamOpen ? '팀원이 만든 앱 접기' : '팀원이 만든 앱 ' + team.length), onclick: () => { v.teamOpen = !v.teamOpen; refresh(); } }) : null,
    el('button', { class: 'v2-bld-pri', type: 'button', onclick: () => { location.hash = builderRoute('new'); } }, icon('plus', 'v2-ic'), el('span', { text: '새 앱' }))]));
  v.list.replaceChildren(...kids([
    sec('만들던 앱', '이어서 만들 수 있어요. 다른 컴퓨터에서도 보여요.', drafts.map(draftCard), '만들던 앱이 없어요. 「+ 새 앱」으로 시작해 보세요.'),
    sec('내가 만든 앱', '고치기 · 배포 설정 · 버전 되돌리기', mine.map((a) => appCard(a, true)), '아직 만든 앱이 없어요'),
    v.teamOpen ? sec('팀원이 만든 앱', '내 사본을 떠서 고치거나, 고칠 수 있는 앱이면 원본을 고쳐요', team.map((a) => appCard(a, false)), '팀원이 만든 앱이 없어요') : null,
    el('p', { class: 'v2-bld-mini', text: '「+ 새 앱」, 「고치기」, 「이어서 만들기」를 누르면 이 창에서 다섯 단계로 앱을 만들어요. 앱빌딩 세션은 홈 사이드바에 망치 아이콘으로 보이고, 누르면 여기로 와요.' })]));
  //  사이드바에서 골라 왔으면 그 카드가 보이게 — 목록이 길면 아래에 있다.
  v.list.querySelector('.v2-bld-card.on')?.scrollIntoView({ block: 'nearest' });
  const selDraft = drafts.find((d) => draftKey(d) === v.sel) || null;
  if (selDraft) { paintDraftPanel(v, selDraft, specApp(selDraft), deleteDraft); return; }
  const selApp = apps.find((a) => a.id === v.sel) || null;
  paintPanel(v, selApp, m, hidden, refresh, repaint, env);
}

// ── 만들던 앱 하나 — 이어서 · 지우기(전부) ──
function paintDraftPanel(v: View, d: Draft, specId: string, del: (d: Draft) => Promise<boolean>): void {
  const delBtn = armedDelete('btn btn-ghost btn-sm', d.keepApp ? '고치던 것 지우기 (세션, 기록)' : '모두 지우기 (앱, 세션, 기록)', '한 번 더 누르면 지워져요. 되돌릴 수 없어요.', '', () => del(d));
  v.panel.replaceChildren(
    el('h3', { text: '만들던 앱 「' + d.title + '」' }),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '어디까지' }), el('small', { text: draftStageText(d.stage, !!d.appId, d.done, d.fixing) + (d.at ? ' · ' + when(d.at) : '') + (d.local ? '' : ' · 다른 컴퓨터에서 만들던 것') })),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '앱' }), el('small', { text: d.keepApp && d.appId ? '쓰던 앱을 고치는 중이에요. 지워도 앱과 버전 이력은 그대로 있어요.' : d.appId ? '초안이 있어요. 지우면 버전 이력도 함께 없어져요.' : '아직 앱이 없어요(기획 단계)' })),
    el('div', { class: 'v2-bld-acts' },
      el('button', { class: 'v2-bld-pri sm', type: 'button', text: '이어서 만들기', onclick: () => { location.hash = builderRoute('resume', d.sid); } }),
      specId ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '개발 정보 보기', title: '지금 버전의 코드를 기준으로 쓴 이 앱의 명세예요', onclick: () => { location.hash = builderRoute('spec', specId); } }) : null),
    el('p', { class: 'v2-bld-mini', text: d.keepApp ? '만들던 앱은 지우기 전까지 이 목록과 사이드바에 늘 보여요. 지우면 고치던 앱빌딩 세션과 대화 기록을 완전히 지워요. 앱은 「내가 만든 앱」에 그대로 있어요.' : '만들던 앱은 지우기 전까지 이 목록과 사이드바에 늘 보여요. 「모두 지우기」는 앱, 앱빌딩 세션, 대화 기록을 모두 완전히 지워요. 휴지통에도 남지 않고 되돌릴 수 없어요.' }),
    el('div', { class: 'v2-bld-acts' }, el('span', { class: 'v2-studio-sp' }), delBtn));
}

// ── 앱 폴더 상한 · 쓰는 양(#4785) ──
//  상한은 앱 책임자 · 관리자가 바꾼다(서버가 folder.can_set 으로 말한다). 거는 것은 매니지드의 5분 쿼터 정비라 바꾼 값은 5분 안에 적용된다.
//  셀프호스트(folder.enforced = false)는 걸 자리가 없다 — 그렇다고 말하고 입력 칸을 내지 않는다. 문장 규칙은 lib/app-folder-text.
function folderRow(a: BApp, refresh: () => void): HTMLElement {
  const f = a.folder;
  const row = el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '앱 폴더' }), el('small', { text: folderLine(f, when) }));
  if (!f.enforced || !f.canSet) return row;
  const inp = el('input', { class: 'v2-bld-num', type: 'number', min: '1', max: String(FOLDER_LIMIT_MAX_GB), step: '1', 'aria-label': '앱 폴더 상한(GiB)' }) as HTMLInputElement;
  inp.value = f.limitGb == null ? '' : String(f.limitGb);
  const save = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '상한 저장', onclick: async () => {
    const p = parseFolderInput(inp.value);
    if ('error' in p) { toast(p.error, true); return; }
    try {
      const r: any = await api('/api/ui/apps/' + encodeURIComponent(a.id) + '/folder-limit', { method: 'POST', body: JSON.stringify({ limit_gb: p.gb }) });
      toast(folderSavedText(p.gb, !!(r && r.warning)));
      refresh();
    } catch (e: any) { toast('바꾸지 못했어요. ' + (e && e.message ? e.message : e), true); }
  } });
  row.append(el('span', { class: 'v2-bld-folder' }, inp, el('span', { text: 'GiB' }), save),
    el('small', { text: '상한을 넘으면 이 앱 폴더에 쓸 수 없어요. 80%에 닿으면 책임자와 관리자에게 알려요. 비워 두면 상한이 없어요.' }));
  return row;
}

/** 카드 작은 줄의 버전 — 공개한 앱에 공개 전 버전이 있으면 둘을 나눠 적는다(«공개 V3 · 내 버전 V5» · 감사 6-9). */
function verLine(a: BApp, me: string): string {
  if (a.visibility !== 'all' || !a.publishedNo) return verName(a.versionNo);
  if (!a.draft || a.draft.versionNo === a.publishedNo) return verName(a.publishedNo);
  return '공개 ' + verName(a.publishedNo) + ' · ' + (a.draft.by === me ? '내 버전 ' : '비공개 ') + verName(a.draft.versionNo);
}

// ── 배포 설정 — 고른 앱 하나 ──
function paintPanel(v: View, a: BApp | null, m: { id: string; name: string }, hidden: Set<string>, refresh: () => void, repaint: () => void, env: BuilderEnv): void {
  if (!a) { v.panel.replaceChildren(el('h3', { text: '배포 설정' }), el('p', { class: 'v2-bld-mini', text: '왼쪽에서 앱 카드를 누르면 여기서 공개 범위, 쓰는 자리, 켜기/끄기, 버전 되돌리기를 바꿀 수 있어요. 만들던 앱 카드를 누르면 이어서 만들기와 지우기가 나와요.' })); return; }
  const pl = placeOf(a.studio);
  const seg = (opts: Array<[string, string]>, cur: string, on: (k: string) => void, off = false): HTMLElement => el('span', { class: 'v2-bld-seg', role: 'radiogroup' }, ...opts.map(([k, t]) => { const b = el('button', { type: 'button', role: 'radio', class: k === cur ? 'on' : '', 'aria-checked': k === cur ? 'true' : 'false', text: t, onclick: () => { if (k !== cur) on(k); } }) as HTMLButtonElement; b.disabled = off; return b; }));
  const tog = (on: boolean, text: string, run: () => void, off = false): HTMLElement => { const b = el('button', { class: 'v2-bld-tog' + (on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', onclick: run }, el('span', { text }), el('i', { 'aria-hidden': 'true' })) as HTMLButtonElement; b.disabled = off; return b; };
  const post = async (path: string, body: unknown, okMsg: string, after?: () => Promise<void>): Promise<boolean> => {
    try { await api('/api/ui/apps/' + encodeURIComponent(a.id) + path, { method: 'POST', body: JSON.stringify(body) }); }
    catch (e: any) { toast('바꾸지 못했어요. ' + (e && e.message ? e.message : e), true); return false; }
    if (after) await after();
    toast(okMsg); refresh(); return true;
  };
  const admin = hasScope('admin');
  const vers = el('div', { class: 'v2-bld-vers' }, el('span', { class: 'v2-bld-mini', text: '버전 이력을 읽는 중…' }));
  void fetchAppVersions(a.id).then((vs) => {
    if (!vers.isConnected) return;
    const rows = vs.slice().sort((x, y) => y.version_no - x.version_no);
    //  #4667 is_current = 내가 지금 보는 판 · is_published = 모두가 쓰는 판. 「이 판으로」 는 배포 설정이라 공개 앱이면 그 판을 바로 모두의 판으로(고칠 수 있는 사람).
    const pubIt = a.visibility === 'all' && a.canEdit;
    vers.replaceChildren(...(rows.length ? rows.slice(0, 8).map((x) => el('div', {}, el('b', { text: verName(x.version_no) }), el('span', { text: (x.note || '').trim() || (x.version_no === 1 ? '처음 만듦' : '고침') }),
      x.is_published && !x.is_current ? el('small', { text: '공개 버전' }) : null,
      x.is_current ? el('small', { text: a.visibility === 'all' && x.is_published ? '지금 쓰는 버전 · 공개' : '지금 보는 버전' })
        : el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이 버전으로', onclick: async () => {
          //  #4732 공개 앱이면 되돌린 버전이 바로 모두의 버전이다 — 그 버전이 표에 할 일을 먼저 보여 주고 묻는다.
          if (pubIt && !(await confirmPublish(a.id, { versionNo: x.version_no, title: a.title }))) return;
          const to = await revertApp(a.id, x.version_no, a.title, { publish: pubIt }); if (to != null) refresh();
        } }))) : [el('span', { class: 'v2-bld-mini', text: '버전 이력이 없어요' })]));
  }).catch(() => { vers.replaceChildren(el('span', { class: 'v2-bld-mini', text: '버전 이력을 읽지 못했어요' })); });
  //  #4667 나만 보는 앱은 책임자 · 관리자가 지운다(/discard) · 공개한 앱은 관리자만(/remove). 지울 수 없는 사람에게는 단추를 안 보인다(감사 1-7 — 누르면 «바꾸지 못했어요» 만 떴다).
  const canDel = !a.builtin && (a.visibility === 'me' ? a.isOwner || admin : admin);
  const del = el('button', { class: 'btn btn-ghost btn-sm v2-bld-danger', type: 'button', text: '앱 지우기' }) as HTMLButtonElement;
  del.onclick = () => {
    //  지우면 그 앱의 앱빌딩 세션도 완전히 지운다 — 남겨 두면 세션 목록에서 «② 세부 기획» 의 만들던 앱으로 되살아났다(감사 1-2). 보통 AI 세션은 건드리지 않는다.
    if (del.dataset.arm) {
      delete del.dataset.arm; del.disabled = true;
      void post(a.visibility === 'me' ? '/discard' : '/remove', {}, '「' + a.title + '」 앱을 지웠어요', async () => {
        //  이 브라우저의 기록에 있는 세션은 앱빌더가 연 세션이라 그대로 지운다(셸 목록에서 잘렸어도 · 리뷰 N2). 앱의 만들기 세션은 앱빌딩 세션일 때만.
        const sids = new Set(studioRecs().filter((r) => r.appId === a.id || r.draftId === a.id).map((r) => r.sid));
        const own = await builderSessionOf(env, a.buildSession);
        if (own) sids.add(own);
        for (const sid of sids) {
          deletedSids.add(sid); dropStudioRec(sid);
          const w = await purgeBuildSession(env, sid).catch((e) => errText(e));
          if (w) toast('앱은 지웠지만 앱빌딩 세션을 지우지 못했어요. ' + w, true);
        }
        setSel(v, '');
      }).then((ok) => { if (!ok) { del.disabled = false; del.textContent = '앱 지우기'; } });
      return;
    }
    del.dataset.arm = '1'; del.textContent = '한 번 더 누르면 지워져요'; window.setTimeout(() => { if (!del.dataset.arm) return; delete del.dataset.arm; del.textContent = '앱 지우기'; }, 4000);
  };
  //  #4667 만든 사람 · 만들기 세션 · 책임자 · 공개 상태는 서버 기록이다(매니페스트 studio 칸이 아니라).
  const by = a.madeBy || '';
  const buildSid = myBuilderSession(env, a.buildSession) ? a.buildSession : '';
  const enabledTog = (): HTMLElement => {
    const offAll = a.enabled && a.visibility === 'all';
    const b = tog(a.enabled, a.enabled ? '켜 둠: 앱 찾기와 세션 위젯 목록에 보여요' : '꺼 둠: 아무도 열 수 없어요', () => {
      if (offAll && !b.dataset.arm) {
        b.dataset.arm = '1'; (b.querySelector('span') as HTMLElement).textContent = '한 번 더 누르면 꺼져요. 모든 사람이 이 앱을 못 쓰게 돼요.';
        window.setTimeout(() => { if (!b.dataset.arm || !b.isConnected) return; delete b.dataset.arm; (b.querySelector('span') as HTMLElement).textContent = '켜 둠: 앱 찾기와 세션 위젯 목록에 보여요'; }, 4000);
        return;
      }
      delete b.dataset.arm;
      void post('/enabled', { enabled: !a.enabled }, a.enabled ? '껐어요' : '켰어요');
    });
    return b;
  };
  const cur = a.visibility;
  const canFlip = cur === 'me' ? a.canPublish : a.canUnpublish;
  const visNote = a.visibility === 'me' ? '나만 쓰는 앱이에요. 다른 사람의 앱 찾기와 세션 위젯 목록에는 보이지 않아요.' + (a.canPublish ? ' 「워크스페이스 모두」를 누르면 공개돼요.' : '')
    : a.draft ? '모두가 공개 버전을 써요. 비공개 ' + verJ(a.draft.versionNo, '은') + ' ' + (a.draft.by === m.id ? '나' : memberName(a.draft.by)) + '에게만 보여요.'
      : '워크스페이스 모두가 써요.' + (a.canUnpublish ? ' 「나만」을 누르면 다른 사람은 더 이상 열 수 없어요.' : '');
  v.panel.replaceChildren(
    el('h3', { text: '「' + a.title + '」 배포 설정' }),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '누가 쓰나' }), seg([['me', '나만'], ['all', '워크스페이스 모두']], cur, async (k) => {
      if (k === 'all' && !(await ensureAppServer(a.id))) return;   // #4484 서버가 있는 앱이면 공개할 판의 서버부터
      if (k === 'all' && !(await confirmPublish(a.id, { title: a.title }))) return;   // #4732
      void post('/visibility', { visibility: k }, k === 'all' ? '워크스페이스 모두에게 공개했어요' : '이제 나만 쓰는 앱이에요. 다른 사람은 더 이상 열 수 없어요.');
    }, !canFlip), el('small', { text: visNote })),
    ...(a.draft && a.canPublish ? [el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '비공개 버전' }), el('small', { text: verName(a.draft.versionNo) + ' (아직 공개 전)' }),
      el('button', { class: 'v2-bld-pri sm', type: 'button', text: '공개하기', onclick: async () => {
        //  #4484 서버가 있는 앱이면 공개할 판의 서버가 빌드돼 있어야 한다(남이 저장한 판이면 그 사람이 먼저 빌드해야 한다 — 서버가 까닭을 말한다).
        if (!(await ensureAppServer(a.id))) return;
        //  #4732 남의 것이어도(책임자 · 관리자) 공개하면 표에 무엇을 하는지 먼저 보여 주고 묻는다.
        if (!(await confirmPublish(a.id, { title: a.title }))) return;
        void post('/visibility', { visibility: 'all' }, verJ(a.draft!.versionNo, '을') + ' 공개했어요. 이제 워크스페이스 모두가 써요.');
      } }))] : []),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '쓰는 자리' }), seg([['side', '세션 위젯'], ['full', '앱 화면'], ['both', '둘 다']], pl, async (k) => {
      //  배포 설정이라 공개 앱이면 바로 모두에게(초안이 걸려 있으면 그 초안에 담기고 공개는 「공개하기」 로).
      const now = a.visibility === 'all' && !a.draft;
      try { await patchManifest(a.id, (man) => { man.studio = { ...studioUiOnly(man.studio), place: k }; }, '쓰는 자리 · ' + PLACE[k as StudioPlace].title, { publish: now }); toast('쓰는 자리를 바꿨어요. ' + (now ? '모두에게 바로 적용돼요.' : a.visibility === 'me' ? '새 버전으로 저장했어요.' : '비공개 버전에 담았어요. 「공개하기」를 누르면 모두에게 적용돼요.')); refresh(); }
      catch (e: any) { toast('바꾸지 못했어요. ' + (e && e.message ? e.message : e), true); }
    }, !a.canEdit), el('small', { text: pl ? PLACE[pl].sub : '아직 정하지 않았어요. 고르면 다음 수정부터 그 자리에 맞춰요.' })),
    //  켜 둠 — 책임자 · 관리자에게만 보인다. 모두가 쓰는 앱을 끄면 모든 사람이 못 쓰게 되니 한 번 더 묻는다(감사 1-7).
    ...(a.isOwner || admin ? [enabledTog()] : []),
    tog(!hidden.has(padTileId('installed', a.id)), '앱 찾기에 보이기 (끄면 내 앱 찾기에서만 숨겨요)', () => { togglePadHidden(padTileId('installed', a.id)); repaint(); }),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '개발 정보' }), el('small', { text: '코드를 기준으로 쓴 이 앱의 명세예요. 쓰는 API, 저장하는 정보, 기능이 어떻게 돌아가는지 보여 줘요. 코드가 바뀌면 저절로 다시 써요.' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '개발 정보 보기', onclick: () => { location.hash = builderRoute('spec', a.id); } })),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: 'AI 지침' }), el('small', { text: a.hasInstructions ? '세션에 붙으면 AI가 이 앱의 지침을 함께 읽어요' : '이 앱에는 AI가 읽을 지침이 없어요. 「고치기」에서 「AI 지침」을 부탁하면 생겨요.' })),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '버전' }), vers),
    //  「세션 보기」 는 앱빌더가 연 내 세션일 때만 — 보통 AI 세션으로 만든 앱이면 그 세션이 새 앱 만들기로 열려 앱이 목록에서 빠졌다(감사 1-6).
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '만든 사람 · 세션' }), el('small', {}, el('span', { text: (by === m.id ? '나' : memberName(by) || '모름') + (buildSid ? ' · 앱빌딩 세션 ' : '') }),
      buildSid ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '세션 보기', onclick: () => { location.hash = builderRoute('resume', buildSid); } }) : null)),
    el('div', { class: 'v2-bld-row' }, el('span', { class: 'k', text: '책임자' }), el('small', { text: a.ownerMember ? (a.ownerMember === m.id ? '나' : memberName(a.ownerMember)) : '관리자가 맡고 있어요' })),
    folderRow(a, refresh),
    el('div', { class: 'v2-bld-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '사본 뜨기', onclick: () => { location.hash = builderRoute('app', a.id, 'copy'); } }),
      el('span', { class: 'v2-studio-sp' }), canDel ? del : null));
}
