// v2/app-studio.ts — **앱 만들기**(#4592, 원준 2026-10-10 «누구나 편하게 앱을 만드는 UX» · 2026-10-11 «정형화된 흐름 · 처음 안내 · 팀과 끝까지»).
//
//  들어오는 길: 앱 찾기(런치패드) 「워크스페이스 앱」 끝의 「+ 새 앱」 → 런치패드가 닫히고 이 화면이 창 전체에 선다.
//  빈 대화 칸 대신 **여섯 단계**가 머리줄 아래 늘 서고, 그 아래 「지금 할 일」 한 문장 + 주 단추 하나. 대화는 곁이다.
//   ① 무엇을(한 줄 · 어디서 쓰나)  ② 내용 — AI 가 먼저 기획 카드를 쓰고 사람은 틀린 줄만 고친다  ③ 시안 — 걸음 넷을 지나 진짜 앱이 뜬다
//   ④ 고치기 — 찍어서 의견 · 앱 전체 의견 · 대화를 묶어 보내면 새 판  ⑤ 확인 — AI 가 기획 카드와 대조 · 이름 · 자리  ⑥ 넣기 — 이렇게 만들었어요 · 써 보기
//   ⑦ 팀에 알리기(지식 「앱 소개」 + 슬랙)  ⑧ 남이 만든 앱을 내게 맞게 — 앱 찾기 ⋯ 「내 사본 떠서 고치기」 · 「원본을 고치기」 → ④부터 짧게.
//  처음 한 번: 세 장 안내 · 단계마다 첫 번에만 뜨는 말풍선 · 「예시로 둘러보기」. 본 것은 이 브라우저에 남는다(SEEN_KEY).
//  자리(세션 옆 · 화면 전체 · 둘 다)에 따라 미리 보는 폭과 테두리, AI 에게 하는 말, 써 보는 길이 다르다.
//
//  새 배관은 없다 — 있는 부품을 엮는다:
//   · 대화 = 일반 세션 하나(spawnSession · 「앱 만들기」 프로젝트 아래)를 대화 보기(renderSession chatHome · 순환을 피해 늦게 들여온다)로 끼운다.
//   · 단계마다 보낼 글은 단추가 보낸다(POST …/prompt). AI 답은 세션 기록(…/transcript ndjson)을 읽어 표식([[기획카드]] · [[걸음 n/4]] · [[점검]])으로 가른다 — lib/studio-flow.ts.
//   · 앱 = 그 세션의 AI 가 app_save 로 저장하면 생긴다. 시작할 때의 앱 목록과 견줘 새로 생긴 id 를 찾고(폴링) mountAppUiFrame 으로 띄운다. 'updated' 사건마다 다시.
//   · 찍어서 의견 = 앱 문서에 탐침 스크립트를 함께 넣어(extraScript) 비율 좌표의 요소(태그 · 글)를 받는다.
//   · 사본 = /apps/:id/pull → id · 이름 · studio.origin 을 바꿔 /apps/save. 판 = fetchAppVersions · revertApp.
import { api, apiUrl, el, toast, TOKEN_KEY } from '../core.js';
import { spawnSession } from './quick-session.js';
import { takeCreated } from './created-cache.js';
import { mountAppUiFrame, openAppUi, type AppUiFrame } from './app-ui.js';
import { onAppEvent } from './live-sync.js';
import { fetchAppVersions, revertApp } from './app-versions.js';
import { attachAppToSession } from './session-app-pane.js';
import { effortKo, findHarness, flagChoices, prettyModel, refreshNodes, runCatalog, runNodes, type RunPick } from './run-picker.js';
import { nodeOptions, nodeWhere, resolveNodeChoice, sessionDefaults } from './run-prefs.js';
import { BUILDER_PROJECT_NAME } from '../lib/builder-flow.js';
import type { SessionChatHandle } from '../session-chat.js';
import { CARD_ROWS, DRAFT_STEPS, PLACE, PROBE_JS, STAGES, assistantTexts, cardText, checkBrief, copyBrief, copyId, draftBrief, editBrief, emptyCard, fixBrief, freshApps, notifyBrief, parseCard, parseCheck, parseStep, planBrief, splitList, stageIndex, whereText, type StudioCard, type StudioPin, type StudioPlace, type StudioStage } from '../lib/studio-flow.js';

export type { StudioPlace };
type FixTool = 'try' | 'pick' | 'pin' | 'box';
export interface StudioRec {
  sid: string; pid: number; what: string; place: StudioPlace; appId: string; known: string[]; at: number;
  stage: StudioStage; card: StudioCard | null; round: number; from: number;
  mode: 'new' | 'copy' | 'edit'; origin?: { id: string; title: string; by: string }; title?: string; done?: boolean; notified?: boolean;
  view?: 'widget' | 'app';   // ③④ 에서 지금 보는 꼴 — 세션 위젯 · 앱 화면
}
const STUDIO_KEY = 'lively_v2_app_studio';
const SEEN_KEY = 'lively_v2_app_studio_seen';
export const PROJECT_NAME = BUILDER_PROJECT_NAME;   // #4632 — 앱빌더가 여는 세션은 전부 이 프로젝트. 사람에게는 프로젝트가 아니라 앱빌더가 그 문이다(lib/builder-flow)
const EXAMPLE: { what: string; card: StudioCard } = { what: '주간 회의 안건을 모으고 끝난 것 표시', card: { name: '회의 안건', who: '회의를 준비하는 사람과 참석자 모두', items: '안건 제목 · 회의 날짜 · 끝남 표시', can: ['안건 더하기', '회의별로 모아 보기', '끝난 것 접기'], not: '회의록 쓰기 · 알림 보내기', first: '이번 회의 안건 목록(안 끝난 것 먼저)' } };

// ① 설명칸 — 예시는 칸 안 안내글 하나로만(원준 2026-10-14 «예시로 채우기 · 적어 두면 좋은 것 다 빼»).
const DESC_PH = '예: 회의록을 음성 파일로 주면 이를 음성 파일을 전사하고 내용을 요약해서 정리해주면 좋겠어요. 회의록을 정리하는 형식을 사용자가 개인화 할 수 있으면 좋겠어요. 앱 화면에서는 이전의 회의록이 날짜별로 정리되어있으면 좋겠고, 해당 날짜의 회의록을 누르면 정리본이 나오면 좋겠어요. AI 세션의 사이드바에서는 기존의 회의록을 찾고 그 회의록 정리본을 제가 참고하거나, AI 세션에 한 번에 집어넣을 수 있도록 하고 싶어요.';
const firstLine = (s: string): string => String(s || '').split('\n')[0].trim();
// 앱 만들기 세션의 모델 · 생각 깊이 — 사람이 고르지 않고 여기서 정한다(원준 2026-10-14). 카탈로그에 없는 값이면 그 축은 안 넘긴다(AI 설정 그대로).
const STUDIO_FLAGS: Record<string, string> = { '--model': 'opus', '--effort': 'high' };

// ── 기록(이 브라우저) ─────────────────────────────────────────────────────────────────────
function readRecs(): StudioRec[] {
  try {
    const a = JSON.parse(localStorage.getItem(STUDIO_KEY) || '[]'); if (!Array.isArray(a)) return [];
    return a.filter((r) => r && r.sid).map((r) => ({ pid: 0, stage: r.appId ? 'fix' : 'plan', card: null, round: 0, from: 0, mode: 'new', ...r }));   // 옛 기록(단계 없던 판)도 선다
  } catch (_) { return []; }
}
function writeRecs(rs: StudioRec[]): void { try { localStorage.setItem(STUDIO_KEY, JSON.stringify(rs.slice(-12))); } catch (_) { /* noop */ } }
function saveRec(r: StudioRec): void { const rs = readRecs().filter((x) => x.sid !== r.sid); rs.push(r); writeRecs(rs); }
/** 이 브라우저의 만들던 기록 전부 — 앱빌더 목록이 읽는다. */
export function studioRecs(): StudioRec[] { return readRecs(); }
/** 만들던 기록 하나를 지운다(세션 · 앱은 그대로). */
export function dropStudioRec(sid: string): void { writeRecs(readRecs().filter((x) => x.sid !== sid)); }
export function studioRecForApp(appId: string): { sid: string } | null { const r = readRecs().filter((x) => x.appId === appId).pop(); return r ? { sid: r.sid } : null; }
interface Seen { intro?: 1; coach?: Record<string, 1> }
function readSeen(): Seen { try { const s = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; } }
function markSeen(patch: (s: Seen) => void): void { const s = readSeen(); patch(s); try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (_) { /* noop */ } }

// ── 세션 · 기록 · 나 ──────────────────────────────────────────────────────────────────────
let meCache: { id: string; name: string } | null = null;
export async function me(): Promise<{ id: string; name: string }> {
  if (meCache) return meCache;
  try { const d: any = await api('/api/ui/me/whoami'); meCache = { id: String(d?.member_id || ''), name: String(d?.display_name || d?.nickname || d?.member_id || '') }; }
  catch (_) { meCache = { id: '', name: '' }; }
  return meCache;
}
export async function studioProject(): Promise<number> {
  try { const d: any = await api('/api/ui/v6/projects?mine=1'); const ps = Array.isArray(d?.projects) ? d.projects : []; const p = ps.find((x: any) => String(x?.name || '').trim() === PROJECT_NAME && !/done|closed|archived/i.test(String(x?.status_category || ''))); return p ? Number(p.id) || 0 : 0; }
  catch (_) { return 0; }
}
async function rawLog(sid: string, q: string): Promise<{ text: string; to: number } | null> {
  const headers: Record<string, string> = {}; const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
  try {
    const res = await fetch(apiUrl('/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/transcript?' + q), { headers, credentials: 'same-origin' });
    if (!res.ok) return null;
    return { text: await res.text(), to: Number(res.headers.get('X-Log-To')) || 0 };
  } catch (_) { return null; }
}
async function logEnd(sid: string): Promise<number> { const r = await rawLog(sid, 'tail=1'); return r ? r.to : 0; }
async function sendPrompt(rec: StudioRec, text: string): Promise<boolean> {
  try {
    rec.from = await logEnd(rec.sid); saveRec(rec);
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(rec.sid) + '/prompt', { method: 'POST', body: JSON.stringify({ text }) });
    return true;
  } catch (e: any) { toast('AI 에게 보내지 못했어요 — ' + (e && e.message ? e.message : e) + ' · 오른쪽 대화 칸에서 다시 보내 보세요', true); return false; }
}
async function listApps(): Promise<any[]> { try { const out: any = await api('/api/ui/apps'); return Array.isArray(out?.apps) ? out.apps : []; } catch (_) { return []; } }
export async function patchManifest(appId: string, patch: (man: any) => void, note: string): Promise<void> {
  const pulled: any = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/pull');
  const files: any[] = Array.isArray(pulled?.files) ? pulled.files : [];
  const mf = files.find((f) => f && f.path === 'lively-app.json'); if (!mf) throw new Error('앱의 설명 파일(lively-app.json)이 없어요');
  const man = JSON.parse(String(mf.content)); patch(man); mf.content = JSON.stringify(man, null, 2);
  await api('/api/ui/apps/save', { method: 'POST', body: JSON.stringify({ files, note }) });
}
/** ⑧ 내 사본 — 원본 파일을 받아 id · 이름 · studio.origin 만 바꿔 저장한다. 원본은 그대로. */
async function makeCopy(origin: { id: string; title: string; by: string }, place: StudioPlace): Promise<{ id: string; title: string }> {
  const m = await me(); const id = copyId(origin.id, m.id); const title = origin.title + ' · ' + (m.name || '내 것');
  const pulled: any = await api('/api/ui/apps/' + encodeURIComponent(origin.id) + '/pull');
  const files: any[] = (Array.isArray(pulled?.files) ? pulled.files : []).filter((f: any) => f && typeof f.path === 'string' && !/^bin\//.test(f.path));
  const mf = files.find((f) => f.path === 'lively-app.json'); if (!mf) throw new Error('원본의 설명 파일이 없어요');
  const man = JSON.parse(String(mf.content)); man.id = id; man.title = title;
  man.studio = { ...(man.studio && typeof man.studio === 'object' ? man.studio : {}), origin: { id: origin.id, title: origin.title, by: origin.by }, made_by: m.id, place };
  mf.content = JSON.stringify(man, null, 2);
  await api('/api/ui/apps/save', { method: 'POST', body: JSON.stringify({ files, note: '사본 · 원본 「' + origin.title + '」 그대로' }) });
  return { id, title };
}

// ── 화면 뿌리 ──────────────────────────────────────────────────────────────────────────
//  창 전체를 덮는 창(기본)이거나, 앱빌더(#4632) 안의 자리(host)에 선다 — 그때 머리줄에 「앱빌더 ›」 가 붙고 닫으면 onClose 가 불린다(목록으로).
export interface StudioMountOpts { host?: HTMLElement | null; onClose?: () => void }
let root: HTMLElement | null = null;
let teardown: (() => void) | null = null;
let mountOpts: StudioMountOpts = {};
export function closeAppStudio(): void {
  if (teardown) { teardown(); teardown = null; }
  if (root) { root.remove(); root = null; }
  const done = mountOpts.onClose; mountOpts = {};
  if (done) done();
}
function mountRoot(opts?: StudioMountOpts): HTMLElement {
  mountOpts = {};   // 앞서 열린 것을 닫되 그쪽의 onClose 는 부르지 않는다 — 새로 여는 중이지 나가는 게 아니다
  closeAppStudio();
  mountOpts = opts || {};
  const r = el('div', { class: 'v2-studio' + (mountOpts.host ? ' v2-studio--in' : ''), role: 'dialog', 'aria-modal': mountOpts.host ? 'false' : 'true', 'aria-label': '앱 만들기' });
  root = r; (mountOpts.host || document.body).append(r); return r;
}
const crumb = (): HTMLElement | null => (mountOpts.host ? el('span', { class: 'v2-studio-crumb', text: '앱빌더 ›' }) : null);
export { me as studioMe };

/** 이어서 열 세션 — 이 브라우저에 기록이 없으면 세션 이름(what)과 그 세션이 만든 앱(appId)으로 되살린다(앱빌더 #4632). */
export interface StudioResume { sid: string; what?: string; title?: string; appId?: string }
/** 앱 만들기를 연다. resume 을 주면 만들던 것을 이어서(그 세션 · 그 단계), 없으면 시작 화면부터. */
export function openAppStudio(resume?: StudioResume | null, opts?: StudioMountOpts): void {
  mountRoot(opts);
  const rec = resume ? readRecs().find((r) => r.sid === resume.sid) || null : null;
  if (rec) { void build(rec); return; }
  if (resume && (resume.what || resume.appId)) {
    //  기록 없이 되살리기 — 단계는 앱이 있으면 ④, 없으면 ②. known 은 지금 있는 앱 전부(이 뒤에 생기는 것이 «이 세션이 만든 앱»).
    void (async () => {
      const known = (await listApps()).map((a) => String(a.id));
      if (!root) return;
      const r2: StudioRec = { sid: resume.sid, pid: 0, what: resume.what || resume.title || '', place: 'both', appId: resume.appId || '', known, at: Date.now(), stage: resume.appId ? 'fix' : 'plan', card: null, round: 0, from: 0, mode: 'new', ...(resume.title ? { title: resume.title } : {}) };
      saveRec(r2); void build(r2);
    })();
    return;
  }
  start();
}
/** ⑧ 남이 만든(또는 내가 만든) 앱을 내게 맞게 — 사본을 떠서, 또는 원본을 그대로 고치기. ④ 고치기에서 연다. */
export async function openAppStudioFor(app: { id: string; title: string; by: string; place?: StudioPlace }, how: 'copy' | 'edit', opts?: StudioMountOpts): Promise<void> {
  const r = mountRoot(opts);
  r.replaceChildren(el('div', { class: 'v2-studio-top' }, crumb(), el('span', { class: 'v2-studio-tag', text: '앱 만들기' }), el('span', { class: 'v2-studio-sp' })),
    el('div', { class: 'v2-studio-wait v2-studio-wait--page' }, el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' }), el('b', { text: how === 'copy' ? '내 사본을 뜨는 중' : '고칠 준비를 하는 중' })));
  const place: StudioPlace = app.place || 'both';
  try {
    const target = how === 'copy' ? await makeCopy(app, place) : { id: app.id, title: app.title };
    if (!root) return;
    const known = (await listApps()).map((a) => String(a.id));
    const pid = await studioProject();
    const brief = how === 'copy' ? copyBrief(target.id, target.title, app.title, app.by, place) : editBrief(app.id, app.title, place);
    const s = await spawnSession(brief, pid > 0 ? { projectId: pid } : { projectName: PROJECT_NAME });
    if (!s) { toast('세션을 열지 못했어요', true); closeAppStudio(); return; }
    void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: ('앱 고치기 · ' + target.title).slice(0, 28) }) }).catch(() => { /* 이름은 못 바꿔도 된다 */ });
    const rec: StudioRec = { sid: s.id, pid, what: target.title, place, appId: target.id, known, at: Date.now(), stage: 'fix', card: null, round: 0, from: 0, mode: how, origin: { id: app.id, title: app.title, by: app.by }, title: target.title };
    saveRec(rec); void build(rec);
  } catch (e: any) { toast((how === 'copy' ? '사본을 뜨지 못했어요 — ' : '열지 못했어요 — ') + (e && e.message ? e.message : e), true); closeAppStudio(); }
}

// ── 처음 안내 — 세 장 · 둘러보기 · 단계 말풍선 ────────────────────────────────────────────
function showIntro(onStart: () => void, onTour: () => void): void {
  if (!root) return;
  const ov = el('div', { class: 'v2-studio-intro' });
  const close = (): void => { markSeen((s) => { s.intro = 1; }); ov.remove(); };
  const cards = [
    { pic: 'talk', t: '대화하며 앱을 만들어요', s: '코드를 볼 필요 없이, AI와 대화하며 필요한 앱을 만들 수 있어요.' },
    { pic: 'steps', t: '따라가다보면 자연스럽게 생성돼요', s: '라이블리가 창에 띄운 단계를 자연스럽게 따라가다보면 자연스럽게 완성돼요' },
    { pic: 'share', t: '팀에게 공유할 수도 있어요', s: '나만 쓸 수도 있고, 원한다면 팀원들이 함께 사용하도록 공유할 수 있어요.' },
  ];
  // 그림은 글자 대신 작은 장면 — 대화 → 앱 · 단계 바를 따라 누름 · 나 → 앱 → 팀원(건너뛰기는 「시작하기」 와 하는 일이 같아 걷었다)
  ov.append(el('div', { class: 'v2-studio-intro-box' },
    el('h2', { text: '앱 만들기, 처음이시죠?' }),
    el('div', { class: 'v2-studio-intro-cards' }, ...cards.map((c) => el('div', {}, introPic(c.pic), el('b', { text: c.t }), el('small', { text: c.s })))),
    el('div', { class: 'v2-studio-intro-act' },
      el('span', { class: 'v2-studio-sp' }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: '예시로 둘러보기(1분)', onclick: () => { close(); onTour(); } }),
      el('button', { class: 'v2-studio-go', type: 'button', text: '시작하기', onclick: () => { close(); onStart(); } }))));
  root.append(ov);
}
function introPic(kind: string): HTMLElement {
  const i = (cls: string, style?: string): HTMLElement => el('i', { class: cls, ...(style ? { style } : {}) });
  const kids = kind === 'talk' ? [i('bub a'), i('bub b'), i('bub c'), i('arr'), i('tile')]
    : kind === 'steps' ? [i('sg done', 'left:0'), i('sg done', 'left:33px'), i('sg on', 'left:66px'), i('sg', 'left:99px'), i('sg', 'left:132px'), i('sg', 'left:165px'), i('line'), i('pbtn'), i('cur')]
      : [i('av me'), i('lk', 'left:34px;width:30px'), i('tile s'), i('lk', 'left:112px;width:26px'), i('av', 'left:142px;top:6px'), i('av', 'left:160px;top:26px'), i('av', 'left:142px;top:46px')];
  return el('div', { class: 'pic', 'aria-hidden': 'true' }, el('span', { class: 'v2-studio-ill' }, ...kids));
}
/** 「예시로 둘러보기」 — 「회의 안건」 앱이 ①→⑥ 가는 것을 같은 꼴의 장면 여섯으로. 진짜로 만들지 않는다. */
function showTour(onDone?: () => void): void {
  if (!root) return;
  const c = EXAMPLE.card;
  const slides: Array<{ n: number; t: string; now: string; body: () => HTMLElement }> = [
    { n: 1, t: '앱 이름과 기능 정하기', now: '이름과 하고 싶은 일을 적고 자리 고르기 → 「만들기 시작」', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'in', text: '회의 안건' }), el('div', { class: 'in', text: EXAMPLE.what }), el('div', { class: 'row' }, el('span', { class: 'on', text: '세션 위젯' }), el('span', { text: '앱 화면' }), el('span', { text: '둘 다' }))) },
    { n: 2, t: '세부 기획 정하기', now: 'AI 가 쓴 기획 카드에서 틀린 줄만 고치고 「이대로 시안 만들기」', body: () => cardView(c, null) },
    { n: 3, t: '생성된 시안', now: '걸음 넷을 지나면 진짜 앱이 떠요 · 직접 눌러 써 보세요', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'steps' }, ...DRAFT_STEPS.map((s, i) => el('span', { class: i < 4 ? 'done' : '', text: s }))), el('div', { class: 'app' }, el('b', { text: '이번 회의 안건' }), el('div', { text: '☐ 지표 대시보드 범위 정하기' }), el('div', { text: '☐ 다음 분기 채용' }), el('div', { class: 'mute', text: '☑ 지난 회의록 확인' }))) },
    { n: 4, t: '고치기', now: '고칠 곳을 찍고 한 줄씩 적은 뒤 「AI 에게 보내기 · 2건」 → 새 판', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'app' }, el('b', { text: '이번 회의 안건 📍' }), el('div', { text: '☐ 지표 대시보드 범위 정하기 📍' })), el('div', { class: 'cm' }, el('div', { text: '📍 제목 「이번 회의 안건」 → 회의 날짜도 같이 보이게' }), el('div', { text: '📍 안건 줄 → 체크 말고 「끝남」 단추로' }), el('div', { class: 'mute', text: '→ 2판 · 제목에 날짜 · 「끝남」 단추 · 안 끝난 것 먼저' }))) },
    { n: 5, t: '확인', now: '네 줄만 보고 「이대로 넣기」', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'chk' }, el('div', { text: '✓ 원하던 것이 다 있나요? — 셋 다 있어요(AI 가 대조)' }), el('div', { text: '✓ 이름 · 「회의 안건」' }), el('div', { text: '✓ 쓰는 자리 · 세션 위젯' }), el('div', { text: '✓ 누가 쓰나 · 워크스페이스 모두' }))) },
    { n: 6, t: '넣기', now: '이제 워크스페이스 앱이에요 · 「지금 써 보기」 · 「팀에 알리기」', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'chk' }, el('div', { text: '이렇게 만들었어요 — 1판 처음 · 2판 날짜와 끝남 단추 · 3판 글자 크기' }), el('div', { text: '이렇게 쓰세요 — 세션 오른쪽 위 + 에서 이 앱을 고르면 세션 위젯으로 붙어요' }), el('div', { text: '팀에 알리기 — 「장원준 님이 「회의 안건」 앱을 만들었어요 · 써 보기」' }))) },
  ];
  let i = 0; const ov = el('div', { class: 'v2-studio-intro v2-studio-tour' }); const box = el('div', { class: 'v2-studio-intro-box' });
  const paint = (): void => {
    const s = slides[i];
    box.replaceChildren(
      el('div', { class: 'v2-studio-bar v2-studio-bar--tour' }, ...STAGES.map((x) => el('span', { class: x.n < s.n ? 'done' : x.n === s.n ? 'on' : '', text: '① ② ③ ④ ⑤ ⑥'.split(' ')[x.n - 1] + ' ' + x.label }))),
      el('div', { class: 'v2-studio-now' }, el('span', { text: '지금 할 일: ' + s.now })),
      el('h2', { text: s.n + '. ' + s.t + ' — 예시 「회의 안건」' }), s.body(),
      el('div', { class: 'v2-studio-intro-act' },
        el('button', { class: 'btn btn-ghost', type: 'button', text: '닫기', onclick: () => { ov.remove(); } }),
        el('span', { class: 'v2-studio-sp' }),
        i > 0 ? el('button', { class: 'btn btn-ghost', type: 'button', text: '이전', onclick: () => { i--; paint(); } }) : null,
        i < slides.length - 1 ? el('button', { class: 'v2-studio-go', type: 'button', text: '다음', onclick: () => { i++; paint(); } })
          : el('button', { class: 'v2-studio-go', type: 'button', text: '내 앱 만들기', onclick: () => { ov.remove(); if (onDone) onDone(); } })));
  };
  ov.append(box); root.append(ov); paint();
}
/** 단계마다 첫 번에만 — 지금 눌러야 할 자리 옆에 검은 말풍선 하나. 아무 데나 누르면 사라진다. */
function coach(key: string, anchor: HTMLElement | null, text: string, example: string, force = false): void {
  if (!root || !anchor) return;
  if (!force && readSeen().coach?.[key]) return;
  root.querySelectorAll('.v2-studio-coach').forEach((n) => n.remove());
  const b = el('div', { class: 'v2-studio-coach', role: 'note' }, el('b', { text: '처음 안내' }), el('span', { text: ' ' + text }), el('small', { text: '예: ' + example }));
  root.append(b);
  const r = anchor.getBoundingClientRect(), bw = Math.min(300, window.innerWidth - 24);
  b.style.width = bw + 'px'; b.style.top = Math.min(window.innerHeight - 120, r.bottom + 10) + 'px'; b.style.left = Math.max(12, Math.min(r.left, window.innerWidth - bw - 12)) + 'px';
  const off = (): void => { b.remove(); document.removeEventListener('pointerdown', off, true); window.clearTimeout(t); markSeen((s) => { s.coach = s.coach || {}; s.coach[key] = 1; }); };
  const t = window.setTimeout(off, 12000);   // 안 눌러도 12초면 물러난다
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}
function helpMenu(btn: HTMLElement, onIntro: () => void, onTour: () => void): void {
  if (!root) return;
  root.querySelectorAll('.v2-studio-help').forEach((n) => n.remove());
  const m = el('div', { class: 'v2-studio-help' },
    el('button', { type: 'button', text: '처음 안내 다시 보기', onclick: () => { m.remove(); onIntro(); } }),
    el('button', { type: 'button', text: '예시로 둘러보기(1분)', onclick: () => { m.remove(); onTour(); } }),
    el('button', { type: 'button', text: '단계 말풍선 다시 켜기', onclick: () => { m.remove(); markSeen((s) => { s.coach = {}; }); toast('다음 단계부터 말풍선이 다시 떠요'); } }));
  const r = btn.getBoundingClientRect(); m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  root.append(m);
  const off = (e: Event): void => { if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}
/** 기획 카드 보기 · 고치기 — onEdit 을 주면 줄을 눌러 그 자리에서 고친다. */
function cardView(c: StudioCard, onEdit: ((c: StudioCard) => void) | null): HTMLElement {
  const box = el('div', { class: 'v2-studio-card' + (onEdit ? ' edit' : '') }, el('b', { class: 'v2-studio-card-h', text: '기획 카드' + (c.name ? ' · ' + c.name : '') }));
  CARD_ROWS.forEach((r) => {
    const val = r.k === 'can' ? c.can.join(' · ') : c[r.k];
    const v = el('span', { class: 'v', text: val || '' });
    if (onEdit) {
      v.setAttribute('contenteditable', 'true'); v.setAttribute('data-placeholder', r.hint); v.setAttribute('aria-label', r.label);
      v.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); (v as HTMLElement).blur(); } });
      v.addEventListener('blur', () => { const t = String(v.textContent || '').trim(); if (r.k === 'can') c.can = splitList(t); else c[r.k] = t; onEdit(c); });
    }
    box.append(el('div', { class: 'row' }, el('span', { class: 'k', text: r.label }), v));
  });
  return box;
}

// ── ① 앱 이름과 기능 정하기 — 이름 · 설명(자세할수록 좋다) · 자리 · 누가 어디서 만드나 ──────────────
function start(): void {
  if (!root) return;
  let place: StudioPlace = 'side';
  const nameIn = el('input', { class: 'v2-studio-name-field', type: 'text', maxlength: '40', placeholder: '예: 회의록', 'aria-label': '앱 이름' }) as HTMLInputElement;
  const input = el('textarea', { class: 'v2-studio-what', rows: '6', maxlength: '4000', placeholder: DESC_PH, 'aria-label': '어떤 앱인가요' }) as HTMLTextAreaElement;
  const go = el('button', { class: 'v2-studio-go', type: 'button', text: '만들기 시작' }) as HTMLButtonElement;
  const sync = (): void => { go.disabled = !input.value.trim(); };
  const cards = (Object.keys(PLACE) as StudioPlace[]).map((k) => {
    const b = el('button', { class: 'v2-studio-place' + (k === place ? ' on' : ''), type: 'button', 'data-place': k },
      placePic(k), el('b', { text: PLACE[k].title }), el('small', { text: PLACE[k].sub }));
    b.onclick = () => { place = k; cards.forEach((c) => c.classList.toggle('on', c === b)); };
    return b;
  });
  // 누가 어디서 만드나 — 실행 컴퓨터는 사람이 고르고, 모델 · 생각 깊이는 여기서 정해 둔다.
  const nodeSel = el('select', { class: 'v2-studio-node', 'aria-label': '어디서 실행할까요' }) as HTMLSelectElement;
  const nodeNote = el('small', { class: 'v2-studio-ai-note', text: '' });
  const modelChip = el('span', { class: 'v2-studio-ai-fix', text: 'Claude ' + prettyModel(STUDIO_FLAGS['--model']) + ' · 생각 깊이 ' + effortKo(STUDIO_FLAGS['--effort']) });
  let nodes: Awaited<ReturnType<typeof runNodes>> = [];
  const paintNodes = (): void => {
    const pref = nodeSel.value || sessionDefaults().nodeDefault;
    const opts = nodeOptions(nodes);
    nodeSel.replaceChildren(...opts.map((o) => { const op = el('option', { value: o.v, text: o.t }) as HTMLOptionElement; op.disabled = !!o.off; return op; }));
    nodeSel.value = opts.some((o) => o.v === pref && !o.off) ? pref : '';
    nodeNote.textContent = nodeWhere(nodes, nodeSel.value);
  };
  nodeSel.onchange = () => { nodeNote.textContent = nodeWhere(nodes, nodeSel.value); };
  void runNodes().then((ns) => { nodes = ns; if (root && nodeSel.isConnected) paintNodes(); }).catch(() => { /* 노드 목록이 없으면 자동(중앙)으로 */ });
  paintNodes();
  void runCatalog().then((hs) => {
    const h = findHarness(hs, 'claude'); if (!h) return;
    const m = flagChoices(h, '--model').includes(STUDIO_FLAGS['--model']), e = flagChoices(h, '--effort').includes(STUDIO_FLAGS['--effort']);
    if (!m || !e) modelChip.textContent = (m ? 'Claude ' + prettyModel(STUDIO_FLAGS['--model']) : 'AI 설정 그대로') + (e ? ' · 생각 깊이 ' + effortKo(STUDIO_FLAGS['--effort']) : '');
  }).catch(() => { /* 카탈로그를 못 받아도 시작은 된다 */ });
  const studioRun = async (): Promise<RunPick> => {
    const ns = await refreshNodes(0).catch(() => nodes);
    const ch = resolveNodeChoice(ns, nodeSel.value);
    if (ch.fellBack) toast(nodeWhere(ns, nodeSel.value));
    const hs = await runCatalog().catch(() => []); const h = findHarness(hs, 'claude');
    const flags: Record<string, string> = {};
    Object.entries(STUDIO_FLAGS).forEach(([k, v]) => { if (!h || flagChoices(h, k).includes(v)) flags[k] = v; });
    const d = sessionDefaults();
    return { harness: 'claude', flags, node: ch.id, mode: 'normal', autoApprove: d.autoApprove, writeVis: '' };
  };
  const begin = async (): Promise<void> => {
    const what = input.value.trim(), nm = nameIn.value.trim(); if (!what || go.disabled) return;
    go.disabled = true; go.textContent = '준비하는 중…';
    const known = (await listApps()).map((a) => String(a.id));   // 이 뒤에 새로 생기는 앱이 «내가 만들고 있는 앱»
    const pid = await studioProject();
    const run = await studioRun();
    const s = await spawnSession(planBrief(what, place, nm), { ...(pid > 0 ? { projectId: pid } : { projectName: PROJECT_NAME }), run });
    if (!s) { go.disabled = false; go.textContent = '만들기 시작'; return; }
    const rec: StudioRec = { sid: s.id, pid, what, place, appId: '', known, at: Date.now(), stage: 'plan', card: null, round: 0, from: 0, mode: 'new', ...(nm ? { title: nm } : {}) };
    saveRec(rec);
    void api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: ('앱 만들기 · ' + (nm || firstLine(what))).slice(0, 28) }) }).catch(() => { /* 이름은 못 바꿔도 된다 */ });
    void build(rec);
  };
  go.onclick = () => { void begin(); };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void begin(); } });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.focus(); } });
  const help = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '?', title: '안내 다시 보기', 'aria-label': '안내' });
  help.onclick = () => helpMenu(help, () => showIntro(() => input.focus(), () => showTour(() => input.focus())), () => showTour(() => input.focus()));
  root.replaceChildren(
    el('div', { class: 'v2-studio-top' },
      crumb(), el('span', { class: 'v2-studio-tag', text: '앱 만들기' }),
      el('span', { class: 'v2-studio-sp' }), help,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => closeAppStudio() })),
    el('div', { class: 'v2-studio-bar' }, ...STAGES.map((x) => el('span', { class: x.n === 1 ? 'on' : '', text: '① ② ③ ④ ⑤ ⑥'.split(' ')[x.n - 1] + ' ' + x.label }))),
    el('div', { class: 'v2-studio-start' },
      el('h2', { text: '앱의 이름과 기능을 정해주세요.' }),
      el('label', { class: 'v2-studio-lab' }, el('span', { text: '앱 이름' }), el('small', { text: '비워 두면 AI 가 지어요 · 나중에 바꿀 수 있어요' })),
      nameIn,
      el('label', { class: 'v2-studio-lab' }, el('span', { text: '어떤 앱인가요?' }), el('small', { text: '자세할수록 좋아요' })),
      input,
      el('h3', { text: '어디에서 쓰는 앱인가요?' }),
      el('p', { class: 'v2-studio-fine', text: '자리에 따라 AI 가 만드는 폭과 미리 보는 틀, 다 만든 뒤 여는 길이 달라요.' }),
      el('div', { class: 'v2-studio-places' }, ...cards),
      el('div', { class: 'v2-studio-ai' },
        el('div', { class: 'v2-studio-ai-h' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text: '이 앱은 AI 가 만들어요' })),
        el('p', { text: '「만들기 시작」 을 누르면 AI 세션이 하나 열려서 이를 바탕으로 더 궁금한 점을 물어볼거예요.' }),
        el('div', { class: 'v2-studio-ai-row' }, el('span', { class: 'k', text: '어디서 실행할까요' }), nodeSel, nodeNote),
        el('div', { class: 'v2-studio-ai-row' }, el('span', { class: 'k', text: '모델 · 생각 깊이' }), modelChip, el('small', { class: 'v2-studio-ai-note', text: '앱 만들기에 맞게 정해 두었어요' }), el('span', { class: 'v2-studio-sp' }), go))));
  sync();
  // ① 엔 말풍선을 띄우지 않는다 — 칸 이름과 안내글로 충분하다(원준 2026-10-14).
  const focusName = (): void => { nameIn.focus(); };
  if (!readSeen().intro) showIntro(focusName, () => showTour(focusName));
  else focusName();
}
/** 자리 그림 — 보라는 늘 «앱이 서는 자리» 다. 세션 위젯은 AI 세션(대화) 옆, 앱 화면은 화면 전체, 둘 다는 두 꼴을 나란히. */
function placePic(k: StudioPlace): HTMLElement {
  const ses = (): HTMLElement => el('span', { class: 'ses' }, el('i', { class: 'u' }), el('i', { class: 'a' }), el('i', { class: 'a2' }));
  const ap = (cls: string): HTMLElement => el('span', { class: 'ap ' + cls });   // 앱 자리는 빈 보라 — 대화하는 곳이 아니니 글줄을 그리지 않는다
  const rail = (): HTMLElement => el('span', { class: 'rail' });
  if (k === 'side') return el('span', { class: 'v2-studio-pk', 'aria-hidden': 'true' }, rail(), ses(), ap('side'), el('span', { class: 'tg', text: 'AI 세션' }), el('span', { class: 'tg on', text: '세션 위젯' }));
  if (k === 'full') return el('span', { class: 'v2-studio-pk', 'aria-hidden': 'true' }, rail(), ap('full'), el('span', { class: 'tg on', text: '앱 화면' }));
  return el('span', { class: 'v2-studio-pk dual', 'aria-hidden': 'true' }, el('span', { class: 'mini' }, rail(), ses(), ap('side')), el('span', { class: 'plus', text: '+' }), el('span', { class: 'mini' }, rail(), ap('full')));
}

// ── ②~⑥ 만드는 화면 — 머리줄 · 단계 바 · 지금 할 일 · 가운데(자리에 맞는 틀) · 옆(의견 · 대화) ──
async function build(rec: StudioRec): Promise<void> {
  if (!root) return;
  if (teardown) { teardown(); teardown = null; }
  const S = { dead: false, frame: null as AppUiFrame | null, chat: null as SessionChatHandle | null, title: rec.title || rec.what, curVer: 0, prevVer: 0, pollT: 0, logT: 0,
    pins: [] as StudioPin[], general: '', tool: 'pick' as FixTool, active: -1, hoverAt: 0, step: 0, check: null as { have: string[]; missing: string[] } | null, checkWait: false,
    waiting: false, waitT0: 0, tick: 0, wide: rec.place === 'full' || (rec.place === 'both' && rec.view === 'app'), chatMode: 'off' as 'off' | 'float' | 'dock', hitWaits: {} as Record<number, (h: any) => void>, hitSeq: 1, lastNote: '' };
  const tag = el('span', { class: 'v2-studio-tag', text: '앱 만드는 중' });
  const name = el('b', { class: 'v2-studio-name', text: S.title });
  const ver = el('span', { class: 'v2-studio-ver', text: '' });
  const undo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이전 판으로', hidden: true }) as HTMLButtonElement;
  const help = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '?', title: '안내 다시 보기', 'aria-label': '안내' });
  const bar = el('div', { class: 'v2-studio-bar' });
  const now = el('div', { class: 'v2-studio-now' });
  const band = el('div', { class: 'v2-studio-band', hidden: true });
  // ③④ 맨 위 — 지금 보는 꼴(세션 위젯 · 앱 화면)을 오가는 자리. 원준 2026-10-14 «둘 중 내가 뭘 보는지 왔다갔다 하게 · 가장 위 위계»
  const viewBar = el('div', { class: 'v2-studio-view', hidden: true });
  // AI 세션(앱을 만드는 대화)은 기본으로 접어 둔다 — 단추가 보낸 글과 AI 의 표식 답은 화면이 카드 · 걸음 · 새 판으로 보여 준다.
  //  보고 싶으면 머리줄 단추로 떠 있는 창을 열고, 그 창을 끌어 오른쪽 끝에 놓으면 오른쪽 칸에 붙는다(원준 2026-10-14).
  const chatBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'AI 세션 보기' }) as HTMLButtonElement;
  chatBtn.onclick = () => { S.chatMode = S.chatMode === 'off' ? 'float' : 'off'; applyPlace(); };
  const tray = el('div', { class: 'v2-studio-tray', hidden: true });   // ④ 보낼 의견 — 앱 아래 한 칸
  const stageTools = el('div', { class: 'v2-studio-stagetools', hidden: true });
  const appBox = el('div', { class: 'v2-studio-app' });       // 자리에 맞는 틀(곁칸 · 창) + 앱 + 핀 층
  const stage = el('div', { class: 'v2-studio-stage' }, stageTools, appBox, tray);
  const chatHost = el('div', { class: 'v2-studio-chat' });
  const sideHead = el('div', { class: 'v2-studio-side-head' }, el('b', { text: 'AI 세션' }), el('small', { text: '이 앱을 만드는 대화' }), el('span', { class: 'v2-studio-sp' }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '떼어 내기', onclick: () => { S.chatMode = 'float'; applyPlace(); } }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => { S.chatMode = 'off'; applyPlace(); } }));
  const side = el('div', { class: 'v2-studio-side' }, sideHead, chatHost);
  const winHead = el('div', { class: 'v2-studio-chatwin-head', title: '끌어서 옮겨요 · 오른쪽 끝에 놓으면 붙어요' }, el('b', { text: 'AI 세션' }), el('small', { text: '끌어서 오른쪽 끝에 놓으면 붙어요' }), el('span', { class: 'v2-studio-sp' }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '오른쪽에 붙이기', onclick: () => { S.chatMode = 'dock'; applyPlace(); } }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕', title: '닫기', 'aria-label': 'AI 세션 닫기', onclick: () => { S.chatMode = 'off'; applyPlace(); } }));
  const winBody = el('div', { class: 'v2-studio-chatwin-body' });
  const chatWin = el('div', { class: 'v2-studio-chatwin', hidden: true, role: 'dialog', 'aria-label': 'AI 세션' }, winHead, winBody);
  const dockHint = el('div', { class: 'v2-studio-dockhint', hidden: true }, el('span', { text: '여기에 놓으면 오른쪽에 붙어요' }));
  winHead.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || !root) return;
    const r = chatWin.getBoundingClientRect(), rr = root.getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top;
    winHead.setPointerCapture(e.pointerId); root.classList.add('v2-studio--drag');
    const near = (x: number): boolean => x >= rr.right - 96;
    const move = (ev: PointerEvent): void => {
      chatWin.style.left = Math.max(0, Math.min(rr.width - r.width, ev.clientX - rr.left - dx)) + 'px';
      chatWin.style.top = Math.max(48, Math.min(rr.height - 60, ev.clientY - rr.top - dy)) + 'px';
      chatWin.style.right = 'auto'; chatWin.style.bottom = 'auto'; dockHint.hidden = !near(ev.clientX);
    };
    const up = (ev: PointerEvent): void => {
      winHead.removeEventListener('pointermove', move); winHead.removeEventListener('pointerup', up); winHead.removeEventListener('pointercancel', up);
      root?.classList.remove('v2-studio--drag'); dockHint.hidden = true;
      if (near(ev.clientX)) { S.chatMode = 'dock'; applyPlace(); }
    };
    winHead.addEventListener('pointermove', move); winHead.addEventListener('pointerup', up); winHead.addEventListener('pointercancel', up);
  });
  const body = el('div', { class: 'v2-studio-body' }, stage, side);
  const frameWin = (): Window | null => { const r: any = S.frame && S.frame.root; if (!r) return null; const f: HTMLIFrameElement | null = r.tagName === 'IFRAME' ? r : r.querySelector('iframe'); return f && f.contentWindow ? f.contentWindow : null; };
  const circ = (n: number): string => '① ② ③ ④ ⑤ ⑥'.split(' ')[n - 1];

  const paintBar = (): void => {
    const cur = stageIndex(rec.stage);
    bar.replaceChildren(...STAGES.map((x, i) => {
      let label = x.label;
      if (rec.mode !== 'new' && i < 3) label = i === 0 ? '앱 이름과 기능(원본)' : i === 1 ? '세부 기획(물려받음)' : '생성된 시안(원본 그대로)';
      if (x.key === 'fix' && rec.round > 0) label += ' · ' + (rec.round + (rec.stage === 'fix' && !S.waiting ? 1 : 0)) + '번째';
      return el('span', { class: i < cur ? 'done' : i === cur ? 'on' : '', text: circ(x.n) + ' ' + label });
    }));
  };
  const nowBtn = (text: string, pri: boolean, run: () => void, disabled = false): HTMLButtonElement => { const b = el('button', { class: pri ? 'v2-studio-now-pri' : 'btn btn-ghost btn-sm', type: 'button', text, onclick: run }) as HTMLButtonElement; b.disabled = disabled; return b; };
  const paintNow = (): void => {
    const kids: Array<HTMLElement | null> = []; let text = '';
    const hasCm = S.pins.some((p) => p.note.trim()) || !!S.general.trim();
    if (rec.stage === 'plan') { text = rec.card ? '기획 카드에서 틀린 줄만 고치고 「이대로 시안 만들기」' : 'AI 가 기획 카드를 쓰는 중이에요 · 잠깐만요'; kids.push(nowBtn('이대로 시안 만들기', true, () => { void toDraft(); }, !rec.card)); }
    else if (rec.stage === 'draft') {
      if (!rec.appId) text = 'AI 가 첫 판을 만드는 중 · ' + (S.step ? DRAFT_STEPS[S.step - 1] : '시작하는 중') + ' (몇 분 걸려요)';
      else { text = '진짜 앱이에요 · 직접 눌러 써 보세요. 고칠 곳이 있으면 「고칠 곳 있어요」'; kids.push(nowBtn('마음에 들어요 · 확인으로', false, () => { void setStage('check'); }), nowBtn('고칠 곳 있어요', true, () => { void setStage('fix'); })); }
    } else if (rec.stage === 'fix') {
      if (S.waiting) text = 'AI 가 고치는 중이에요 · 새 판이 오면 여기 앱이 바뀌어요';
      else if (hasCm) { text = '적은 의견을 모아 「수정하기」 를 누르면 AI 가 한 번에 고쳐 새 판을 내요'; kids.push(nowBtn('수정하기 · ' + cmCount() + '건', true, () => { void sendFix(); })); }
      else { text = (rec.round >= 2 ? '지금도 충분하면 확인으로 가도 돼요 · ' : '') + '고르기 · 핀 · 영역으로 고칠 곳을 짚고 한 줄씩 적으세요'; kids.push(nowBtn('마음에 들어요 · 확인으로', true, () => { void setStage('check'); })); }
    } else if (rec.stage === 'check') { text = '네 줄만 보고 「이대로 넣기」 · 하나라도 아니면 「더 고치기」'; kids.push(nowBtn('더 고치기', false, () => { void setStage('fix'); }), nowBtn('이대로 넣기', true, () => { void putApp(); }, S.check != null && S.check.missing.length > 0)); }
    else if (rec.stage === 'put') { text = '이제 워크스페이스 앱이에요 · 「지금 써 보기」 로 바로 열어 보세요'; }
    now.replaceChildren(el('span', { class: 'v2-studio-now-t', text: '지금 할 일: ' + text }), el('span', { class: 'v2-studio-sp' }), ...kids.filter(Boolean) as HTMLElement[]);
  };
  const cmCount = (): number => S.pins.filter((p) => p.note.trim()).length + (S.general.trim() ? 1 : 0);
  const paintVer = async (): Promise<void> => {
    if (!rec.appId) return;
    try {
      const vs = await fetchAppVersions(rec.appId); if (S.dead) return;
      const cur = vs.find((v) => v.is_current) || vs[vs.length - 1];
      S.curVer = cur ? cur.version_no : 0;
      S.prevVer = vs.map((v) => v.version_no).filter((n) => n < S.curVer).sort((a, b) => b - a)[0] || 0;
      ver.textContent = S.curVer ? S.curVer + '판' : '';
      undo.hidden = !S.prevVer || rec.stage === 'put'; undo.textContent = S.prevVer ? S.prevVer + '판으로 되돌리기' : '이전 판으로';
    } catch (_) { /* 판 이력을 못 읽어도 앱은 뜬다 */ }
  };
  const applyPlace = (): void => {
    const wide = rec.place === 'full' || (rec.place === 'both' && S.wide);
    appBox.className = 'v2-studio-app ' + (wide ? 'v2-studio-app--full' : 'v2-studio-app--side');
    const head = appBox.querySelector('.v2-studio-app-head');
    if (head) head.replaceChildren(...(wide
      ? [el('span', { class: 'dot' }), el('b', { text: S.title }), el('span', { class: 'v2-studio-sp' }), el('small', { text: '앱 화면 · 앱 찾기에서 열었을 때 모습' })]
      : [el('span', { class: 'tab', text: '자료' }), el('span', { class: 'tab', text: '지식' }), el('span', { class: 'tab on', text: S.title }), el('span', { class: 'v2-studio-sp' }), el('small', { text: '세션 위젯' })]));
    stageTools.hidden = !(rec.stage === 'fix' && rec.appId);
    if (!stageTools.hidden) paintTools();
    // 판 짜기 — ③ 시안은 «써 보는» 단계: 앱 화면이면 화면 가득, 세션 위젯이면 실제 세션처럼 왼쪽 대화 · 오른쪽 위젯.
    //  그 밖엔 AI 세션이 접혀 있고(기본) · 떠 있는 창이거나 · 오른쪽 칸에 붙는다.
    const tryIt = rec.stage === 'draft' && !!rec.appId;
    const tryWidget = tryIt && !wide;
    const inSide = tryWidget || S.chatMode === 'dock';
    const host = inSide ? side : S.chatMode === 'float' ? winBody : null;
    if (host && chatHost.parentElement !== host) host.append(chatHost);
    body.classList.toggle('v2-studio-body--try-widget', tryWidget);
    body.classList.toggle('v2-studio-body--solo', !inSide);
    body.classList.toggle('v2-studio-body--try-app', tryIt && wide);
    sideHead.hidden = tryWidget;
    chatWin.hidden = tryWidget || S.chatMode !== 'float';
    chatBtn.hidden = tryWidget;
    chatBtn.textContent = S.chatMode === 'off' ? 'AI 세션 보기' : 'AI 세션 닫기';
    const views: Array<['widget' | 'app', string, string]> = [];
    if (rec.place !== 'full') views.push(['widget', '세션 위젯', tryIt ? '세션 오른쪽에 붙었을 때 모습 · 왼쪽 대화로 시켜도 위젯이 바뀌어요' : '세션 위젯 폭(360px)으로 보는 중']);
    if (rec.place !== 'side') views.push(['app', '앱 화면', tryIt ? '앱 찾기에서 열었을 때 모습 · 화면 가득 직접 눌러 써 보세요' : '앱 화면 폭으로 보는 중']);
    const cur = wide ? 'app' : 'widget';
    viewBar.hidden = !(rec.appId && (rec.stage === 'draft' || rec.stage === 'fix'));
    viewBar.replaceChildren(
      el('span', { class: 'v2-studio-view-tabs', role: 'tablist' }, ...views.map(([k, t]) => {
        const b = el('button', { type: 'button', role: 'tab', class: k === cur ? 'on' : '', 'aria-selected': k === cur ? 'true' : 'false', text: t, onclick: () => { if (k === cur) return; S.wide = k === 'app'; rec.view = k; saveRec(rec); applyPlace(); } }) as HTMLButtonElement;
        b.disabled = views.length < 2; return b;
      })),
      el('span', { class: 'v2-studio-view-sub', text: (views.find((v) => v[0] === cur) || ['', '', ''])[2] }));
  };
  const appHost = (): HTMLElement => { const h0 = appBox.querySelector('.v2-studio-app-body') as HTMLElement | null; if (h0) return h0; const h = el('div', { class: 'v2-studio-app-body' }); appBox.replaceChildren(el('div', { class: 'v2-studio-app-head' }), h); applyPlace(); return h; };
  const waiting = (title: string, sub: string, steps?: HTMLElement): void => {
    appHost().replaceChildren(el('div', { class: 'v2-studio-wait' }, el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' }), el('b', { text: title }), ...(steps ? [steps] : []), el('p', { text: sub })));
  };
  // ④ 고치기 — 장표 수정 앱처럼 고르기 · 핀 · 영역으로 짚고 그 자리에서 한 줄(원준 2026-10-14). 앱 위 투명한 층이 누름을 받고(써 보기면 비킨다),
  //  고르기 · 핀은 탐침에게 그 자리의 요소(태그 · 글 · 테두리)를 묻는다. 의견은 앱 아래 「보낼 의견」 에 모이고 「수정하기」 한 번으로 간다.
  const TOOLS: Array<{ k: FixTool; t: string; ico: string; help: string }> = [
    { k: 'try', t: '써 보기', ico: '👆', help: '앱을 그대로 눌러 써 봐요. 의견을 달려면 고르기 · 핀 · 영역 가운데 하나를 고르세요.' },
    { k: 'pick', t: '고르기', ico: '⬚', help: '앱 안의 버튼 · 칸 · 글을 누르면 그 요소가 골라지고 그 자리에 의견을 적어요. 마우스를 올리면 무엇이 골라질지 테두리로 미리 보여요.' },
    { k: 'pin', t: '핀', ico: '📍', help: '누른 자리에 핀을 꽂고 의견을 적어요. 요소가 애매하거나 빈 자리를 말할 때 써요.' },
    { k: 'box', t: '영역', ico: '▭', help: '끌어서 상자를 그리면 그 영역 전체에 대한 의견을 적어요. 여러 요소를 한꺼번에 말할 때 써요.' },
  ];
  const paintTools = (): void => {
    const cur = TOOLS.find((x) => x.k === S.tool) || TOOLS[1];
    stageTools.replaceChildren(
      el('div', { class: 'v2-studio-toolrow' },
        el('span', { class: 'v2-studio-tools', role: 'tablist', 'aria-label': '의견 다는 도구' }, ...TOOLS.map((x) => el('button', { type: 'button', role: 'tab', class: x.k === S.tool ? 'on' : '', 'aria-selected': x.k === S.tool ? 'true' : 'false', title: x.help,
          onclick: () => { setTool(x.k); } }, el('span', { class: 'ico', 'aria-hidden': 'true', text: x.ico }), el('span', { text: x.t })))),
        el('span', { class: 'v2-studio-sp' }),
        el('small', { class: 'v2-studio-toolcount', text: S.pins.length ? '짚은 곳 ' + S.pins.length + '개' : '' })),
      el('div', { class: 'v2-studio-toolhelp' }, el('b', { text: cur.ico + ' ' + cur.t }), el('span', { text: cur.help })));
  };
  const setTool = (k: FixTool): void => { S.tool = k; closePop(); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); paintTools(); paintMarks(); };
  const askHit = async (x: number, y: number): Promise<any> => {
    const w = frameWin(); if (!w) return null;
    const id = S.hitSeq++;
    return new Promise((res) => { S.hitWaits[id] = res; w.postMessage({ __studio: 'hit', id, x, y }, '*'); setTimeout(() => { if (S.hitWaits[id]) { delete S.hitWaits[id]; res(null); } }, 700); });
  };
  const ratio = (h: HTMLElement, e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = h.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))), y: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))) };
  };
  const addItem = (p: StudioPin): void => {
    S.pins.push(p);
    const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*');
    paintTray(); paintNow(); paintTools(); openPop(S.pins.length - 1);
  };
  // 앱 위 투명한 층 — 도구마다 하는 일이 다르다(고르기 = 요소 · 핀 = 점 · 영역 = 끌어 그린 상자)
  const overlayOf = (h: HTMLElement): HTMLElement => {
    const o0 = h.querySelector('.v2-studio-overlay') as HTMLElement | null; if (o0) return o0;
    const o = el('div', { class: 'v2-studio-overlay' });
    let drag: { x: number; y: number; box: HTMLElement } | null = null; let skip = false;
    o.addEventListener('pointermove', (e: PointerEvent) => {
      if (S.tool === 'pick' && Date.now() - S.hoverAt > 70) { S.hoverAt = Date.now(); const w = frameWin(); const q = ratio(h, e); if (w) w.postMessage({ __studio: 'hit', id: 0, x: q.x, y: q.y }, '*'); }
      if (S.tool === 'box' && drag) {
        const q = ratio(h, e); const l = Math.min(q.x, drag.x), t = Math.min(q.y, drag.y);
        Object.assign(drag.box.style, { left: l * 100 + '%', top: t * 100 + '%', width: Math.abs(q.x - drag.x) * 100 + '%', height: Math.abs(q.y - drag.y) * 100 + '%' });
      }
    });
    o.addEventListener('pointerleave', () => { if (S.tool === 'pick') { const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); } });
    o.addEventListener('pointerdown', (e: PointerEvent) => {
      if (pop) { closePop(); skip = true; return; }   // 열린 의견 칸 밖을 누르면 먼저 닫기만 한다
      if (S.tool !== 'box') return;
      const q = ratio(h, e); const box = el('div', { class: 'v2-studio-mk v2-studio-mk-box draft' }); h.append(box); drag = { x: q.x, y: q.y, box }; o.setPointerCapture(e.pointerId);
    });
    o.addEventListener('click', async (e: MouseEvent) => {
      if (skip) { skip = false; return; }
      if (S.tool !== 'pick' && S.tool !== 'pin') return;
      const q = ratio(h, e); const hit = await askHit(q.x, q.y);
      if (S.tool === 'pick' && hit && hit.rect) addItem({ kind: 'pick', x: hit.rect.l, y: hit.rect.t, w: hit.rect.w, h: hit.rect.h, where: whereText(hit), note: '' });
      else addItem({ kind: 'pin', x: q.x, y: q.y, where: whereText(hit), note: '' });
    });
    o.addEventListener('pointerup', async (e: PointerEvent) => {
      if (S.tool !== 'box' || !drag) return;
      const q = ratio(h, e); const d = drag; drag = null; d.box.remove();
      const l = Math.min(q.x, d.x), t = Math.min(q.y, d.y), w = Math.abs(q.x - d.x), hh = Math.abs(q.y - d.y);
      if (w < 0.02 || hh < 0.02) return;   // 너무 작은 상자는 실수로 본다
      const hit = await askHit(l + w / 2, t + hh / 2);
      addItem({ kind: 'box', x: l, y: t, w, h: hh, where: whereText(hit), note: '' });
    });
    h.append(o); return o;
  };
  const paintMarks = (): void => {
    if (rec.stage !== 'fix' || !rec.appId || !S.frame) { appBox.querySelectorAll('.v2-studio-overlay, .v2-studio-mk').forEach((n) => n.remove()); return; }
    const h = appHost();
    const o = overlayOf(h); o.hidden = S.tool === 'try' || S.waiting; o.dataset.tool = S.tool;
    h.querySelectorAll('.v2-studio-mk').forEach((n) => n.remove());
    S.pins.forEach((p, i) => {
      const hot = i === S.active;
      if (p.kind === 'pick' || p.kind === 'box') {
        const b = el('div', { class: 'v2-studio-mk v2-studio-mk-box' + (p.kind === 'pick' ? ' pick' : '') + (hot ? ' hot' : '') });
        Object.assign(b.style, { left: p.x * 100 + '%', top: p.y * 100 + '%', width: (p.w || 0) * 100 + '%', height: (p.h || 0) * 100 + '%' });
        h.append(b);
      }
      const n = el('button', { type: 'button', class: 'v2-studio-mk v2-studio-mk-n' + (p.kind === 'pick' || p.kind === 'box' ? '' : ' pin') + (hot ? ' hot' : ''), title: p.note || p.where || '', 'aria-label': (i + 1) + '번 의견 열기',
        onclick: (e: MouseEvent) => { e.stopPropagation(); openPop(i); } }, el('span', { text: String(i + 1) }));
      n.style.left = p.x * 100 + '%'; n.style.top = p.y * 100 + '%';
      h.append(n);
    });
  };
  // 그 자리의 의견 칸 — 짚은 곳 옆에 뜬다
  let pop: HTMLElement | null = null;
  const closePop = (): void => { if (pop) { pop.remove(); pop = null; } if (S.active >= 0) { S.active = -1; paintMarks(); } };
  const openPop = (i: number): void => {
    const p = S.pins[i]; if (!p) return;
    if (pop) pop.remove();
    S.active = i; paintMarks();
    const h = appHost();
    const ta = el('textarea', { class: 'ta', rows: '2', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 의견' }) as HTMLTextAreaElement; ta.value = p.note;
    ta.addEventListener('input', () => { p.note = ta.value; paintTray(); paintNow(); });
    ta.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); closePop(); } if (e.key === 'Escape') closePop(); });
    const kind = p.kind === 'pick' ? '고른 요소' : p.kind === 'box' ? '영역' : '핀';
    const pp = el('div', { class: 'v2-studio-pop', role: 'dialog', 'aria-label': (i + 1) + '번 의견' },
      el('div', { class: 'k' }, el('span', { class: 'n', text: String(i + 1) }), el('b', { text: kind }), el('span', { class: 'w', text: p.where || '' })),
      ta,
      el('div', { class: 'act' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '빼기', onclick: () => { S.pins.splice(i, 1); closePop(); paintMarks(); paintTray(); paintNow(); paintTools(); } }),
        el('span', { class: 'v2-studio-sp' }), el('button', { type: 'button', class: 'v2-studio-now-pri', text: '완료', onclick: () => closePop() })));
    pp.addEventListener('pointerdown', (e) => e.stopPropagation());
    const right = p.x + (p.w || 0);
    pp.style.top = Math.min(p.y * 100, 66) + '%';
    if (right < 0.6) pp.style.left = 'calc(' + right * 100 + '% + 12px)'; else pp.style.right = 'calc(' + (100 - p.x * 100) + '% + 12px)';
    pop = pp; h.append(pp); ta.focus();
  };
  // 보낼 의견 — 앱 아래 한 칸(사이드바 없이). 짚은 곳마다 한 줄 · 앱 전체 한 칸.
  const paintTray = (): void => {
    if (rec.stage !== 'fix' || !rec.appId) { tray.hidden = true; return; }
    tray.hidden = false;
    const rows = S.pins.map((p, i) => {
      const inp = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 의견' }) as HTMLInputElement; inp.value = p.note;
      inp.addEventListener('input', () => { p.note = inp.value; paintNow(); });
      return el('div', { class: 'v2-studio-tray-row' }, el('button', { type: 'button', class: 'n', text: String(i + 1), title: '그 자리 보기', onclick: () => openPop(i) }),
        el('span', { class: 'w', text: (p.kind === 'pick' ? '요소 ' : p.kind === 'box' ? '영역 ' : '핀 ') + (p.where || '') }), inp,
        el('button', { type: 'button', class: 'x', text: '✕', title: '빼기', onclick: () => { S.pins.splice(i, 1); closePop(); paintMarks(); paintTray(); paintNow(); paintTools(); } }));
    });
    const g = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '앱 전체 의견(비워 두면 좋다는 뜻) · 예: 글자 조금 크게', 'aria-label': '앱 전체 의견' }) as HTMLInputElement; g.value = S.general;
    g.addEventListener('input', () => { S.general = g.value; paintNow(); });
    tray.replaceChildren(el('div', { class: 'v2-studio-tray-h' }, el('b', { text: '보낼 의견' + (cmCount() ? ' · ' + cmCount() + '건' : '') }), el('span', { class: 'v2-studio-sp' }), el('small', { text: S.pins.length ? '번호를 누르면 그 자리 의견 칸이 열려요' : '위 도구로 고칠 곳을 짚어 보세요' })),
      el('div', { class: 'v2-studio-tray-list' }, ...rows, el('div', { class: 'v2-studio-tray-row all' }, el('span', { class: 'w', text: '앱 전체' }), g)));
  };
  const onMsg = (ev: MessageEvent): void => { const m: any = ev.data; if (!m || m.__studio !== 'hitres' || ev.source !== frameWin()) return; const w = S.hitWaits[m.id]; if (w) { delete S.hitWaits[m.id]; w(m); } };
  window.addEventListener('message', onMsg);
  const showApp = async (note?: string): Promise<void> => {
    if (S.dead || !rec.appId || rec.stage === 'put' || rec.stage === 'check' || rec.stage === 'plan') return;
    try {
      const f = await mountAppUiFrame(rec.appId, { sessionId: rec.sid, title: S.title, extraScript: PROBE_JS });
      if (S.dead) { f.destroy(); return; }
      if (S.frame) S.frame.destroy();
      S.frame = f; const h = appHost(); h.replaceChildren(f.root); paintMarks();
      await paintVer();
      if (note != null) { S.lastNote = note; band.replaceChildren(el('span', { text: (S.curVer ? S.curVer + '판 · ' : '') + (note || '고쳤어요') })); band.hidden = false; }
      paintBar(); paintNow();
    } catch (e: any) {
      appHost().replaceChildren(el('div', { class: 'v2-studio-wait' }, el('b', { text: '앱 화면을 띄우지 못했어요' }), el('p', { text: String(e && e.message ? e.message : e) })));
    }
  };
  // 새로 생긴 앱 찾기 — 시작할 때 없던 id. 여럿이면 가장 나중 것.
  const findApp = async (): Promise<void> => {
    if (S.dead || rec.appId) return;
    const apps = await listApps(); const fresh = freshApps(rec.known, apps);
    if (fresh.length) {
      const id = fresh[fresh.length - 1], a = apps.find((x) => String(x.id) === id);
      rec.appId = id; S.title = String((a && a.title) || id); rec.title = S.title; saveRec(rec); name.textContent = S.title; applyPlace();
      await showApp('첫 판이 나왔어요 · 눌러 보세요'); paintNow();
      requestAnimationFrame(() => coach('draft', rec.place === 'both' ? viewBar : appBox, '진짜 앱이에요. 직접 눌러 써 보세요.' + (rec.place === 'both' ? ' 위에서 세션 위젯과 앱 화면을 바꿔 볼 수 있어요.' : ' 마음에 안 드는 곳은 다음 단계에서 찍어서 말해요.'), rec.place === 'full' ? '화면 가득 한 바퀴 눌러 보세요' : '왼쪽 대화에 「안건 3개 적어 줘」 라고 시켜 보세요'));
      return;
    }
    S.pollT = window.setTimeout(() => { void findApp(); }, 4000);
  };
  const off = onAppEvent((ev) => {
    if (S.dead) return;
    if (!rec.appId) { if (ev.kind === 'updated' || ev.kind === 'attach') { window.clearTimeout(S.pollT); void findApp(); } return; }
    if (ev.app_id === rec.appId && ev.kind === 'updated') {
      if (rec.stage === 'put' || rec.stage === 'check' || rec.stage === 'plan') { void paintVer(); return; }   // 마무리 표시 저장도 'updated' 다 — 그 화면을 앱으로 갈아 끼우지 않는다
      if (S.waiting) { S.waiting = false; rec.round += 1; S.pins = []; S.general = ''; S.tool = 'pick'; saveRec(rec); paintTray(); paintTools(); }
      void showApp(ev.note || '고쳤어요');
    }
  });
  // AI 답 읽기 — 단계가 보낸 글 뒤의 답만(rec.from 워터마크). 2.5초마다.
  const onText = (t: string): void => {
    if (rec.stage === 'plan') { const c = parseCard(t); if (c) { rec.card = c; saveRec(rec); paintPlan(); paintNow(); } }
    else if (rec.stage === 'draft' && !rec.appId) { const n = parseStep(t); if (n > S.step) { S.step = n; paintSteps(); paintNow(); } }
    else if (rec.stage === 'check') { const ck = parseCheck(t); if (ck) { S.check = ck; S.checkWait = false; paintCheck(); paintNow(); } }
  };
  const pump = async (): Promise<void> => {
    if (S.dead) return;
    const r = await rawLog(rec.sid, 'from=' + rec.from);
    if (!S.dead && r && r.to > rec.from) { const texts = assistantTexts(r.text); rec.from = r.to; saveRec(rec); texts.forEach(onText); }
    if (!S.dead) S.logT = window.setTimeout(() => { void pump(); }, 2500);
  };
  // 기다림 띠(④ 보낸 뒤) — m:ss
  const tickWait = (): void => { if (!S.waiting) return; const s = Math.floor((Date.now() - S.waitT0) / 1000); band.replaceChildren(el('span', { text: 'AI 고치는 중 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' · 새 판이 오면 앱이 바뀌어요' })); band.hidden = false; S.tick = window.setTimeout(tickWait, 1000); };

  // ── 단계 화면들 ──
  const paintPlan = (): void => {
    const h = appHost();
    if (!rec.card) { waiting('AI 가 기획 카드를 쓰는 중', '한 줄 요청을 읽고 여섯 줄로 정리해요(1분 안팎). 카드가 오면 틀린 줄만 고치면 돼요.'); return; }
    // 대화를 접어 두었으니 카드를 통째로 다시 쓰게 하는 한마디는 카드 아래에서 받는다.
    const ask = el('input', { class: 'v2-studio-ask-in', type: 'text', maxlength: '400', placeholder: '통째로 바꾸고 싶으면 한마디 · 예: 더 단순하게 · 담당자 칸도', 'aria-label': '기획 카드를 다시 쓰게 할 말' }) as HTMLInputElement;
    const askGo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '다시 써 줘' }) as HTMLButtonElement;
    const doAsk = async (): Promise<void> => {
      const t = ask.value.trim(); if (!t || !rec.card || askGo.disabled) return;
      askGo.disabled = true;
      if (await sendPrompt(rec, '기획 카드를 이렇게 고쳐서 같은 꼴로 다시 답해 줘(앞뒤에 다른 말 없이): ' + t + '\n지금 카드:\n' + cardText(rec.card))) { ask.value = ''; toast('AI 가 카드를 다시 쓰는 중이에요 · 오면 여기 카드가 바뀌어요'); }
      askGo.disabled = false;
    };
    askGo.onclick = () => { void doAsk(); };
    ask.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void doAsk(); } });
    h.replaceChildren(cardView(rec.card, (c) => { rec.card = c; saveRec(rec); }), el('p', { class: 'v2-studio-fine', text: '줄을 누르면 그 자리에서 고칠 수 있어요 · 통째로 다시 쓰게 하려면 아래 칸에 한마디' }), el('div', { class: 'v2-studio-ask' }, ask, askGo));
    requestAnimationFrame(() => coach('plan', h.querySelector('.v2-studio-card') as HTMLElement, 'AI 가 읽은 대로 적은 카드예요. 틀린 줄만 고치고 「이대로 시안 만들기」 를 누르세요.', '「무엇을 적나」 에 「담당자」 를 더하면 그 칸이 생겨요'));
  };
  const stepsEl = el('div', { class: 'v2-studio-steps' });
  const paintSteps = (): void => { stepsEl.replaceChildren(...DRAFT_STEPS.map((s, i) => el('span', { class: i < S.step ? 'done' : i === S.step ? 'on' : '', text: s }))); };
  const paintDraft = (): void => { if (rec.appId) { void showApp(); return; } paintSteps(); waiting('AI 가 첫 판을 만들고 있어요', '몇 분 걸려요. 다 되면 여기에 앱이 바로 떠요. 이 화면을 닫아도 AI 는 계속 만들어요 — 앱이 저장되면 앱 찾기의 그 칸 ⋯ → 「이어서 만들기」 로 다시 열 수 있어요.', stepsEl); void findApp(); };
  const paintFix = (): void => {
    if (!rec.appId) { paintDraft(); return; }
    if (!S.frame) void showApp(); else paintMarks();
    paintTray();
    requestAnimationFrame(() => coach('fix', stageTools.querySelector('.v2-studio-tools') as HTMLElement, '도구를 골라 고칠 곳을 짚고 한 줄 적으세요. 「수정하기」 한 번이면 AI 가 고쳐 새 판을 내요.', '고르기로 제목을 누르고 「글자 더 크게」'));
  };
  const nameIn = el('input', { class: 'v2-studio-name-in', type: 'text', maxlength: '40', 'aria-label': '앱 이름' }) as HTMLInputElement;
  const paintCheck = (): void => {
    const h = appHost(); const c = rec.card;
    const row = (ok: boolean | null, title: string, sub: HTMLElement | string): HTMLElement => el('div', { class: 'v2-studio-chk' + (ok === true ? ' ok' : ok === false ? ' no' : '') }, el('i', { text: ok === true ? '✓' : ok === false ? '!' : '…' }), el('div', {}, el('b', { text: title }), typeof sub === 'string' ? el('span', { text: sub }) : sub));
    const r1 = !c ? row(null, '원하던 것이 다 있나요?', '기획 카드가 없는 앱이라 대조는 건너뛰어요 · 앱을 눌러 보고 판단하세요')
      : S.check ? row(S.check.missing.length === 0, '원하던 것이 다 있나요?', S.check.missing.length ? '빠진 것: ' + S.check.missing.join(' · ') + ' → 「더 고치기」 로 돌아가 적어 주세요' : '있어요: ' + (S.check.have.length ? S.check.have.join(' · ') : c.can.join(' · ')) + ' (AI 가 기획 카드와 대조)')
      : row(null, '원하던 것이 다 있나요?', 'AI 가 기획 카드와 지금 판을 대조하는 중…');
    if (nameIn.value === '') nameIn.value = S.title;
    const places = el('div', { class: 'v2-studio-chk-places' }, ...(Object.keys(PLACE) as StudioPlace[]).map((k) => el('button', { type: 'button', class: k === rec.place ? 'on' : '', text: PLACE[k].title, onclick: () => { rec.place = k; S.wide = k === 'full'; saveRec(rec); applyPlace(); paintCheck(); } })));
    h.replaceChildren(el('div', { class: 'v2-studio-chks' }, r1,
      row(true, '이름', el('span', {}, nameIn, el('small', { text: ' 바꾸려면 여기서 고치세요' }))),
      row(true, '쓰는 자리', places),
      row(true, '누가 쓰나', '워크스페이스 모두 (지금은 저장하면 모두에게 보여요 · 나만 보는 초안은 아직 없어요)'),
      el('p', { class: 'v2-studio-fine', text: '하나라도 아니면 「더 고치기」 로 ④에 돌아가요' })));
    requestAnimationFrame(() => coach('check', h.querySelector('.v2-studio-chks') as HTMLElement, '다 됐는지 네 줄만 봐요. 하나라도 아니면 「더 고치기」.', '이름이 「' + S.title + '」 이 맞나요?'));
  };
  const paintPut = (): void => {
    const h = appHost(); const c = rec.card; const placeName = PLACE[rec.place].title; const title = S.title;
    const steps: HTMLElement[] = [
      el('div', { class: 'v2-studio-step' }, el('b', { text: rec.mode === 'copy' ? '이렇게 시작했어요' : '이렇게 부탁했어요' }), el('p', { text: rec.mode === 'copy' && rec.origin ? '「' + rec.origin.title + '」' + (rec.origin.by ? '(' + rec.origin.by + ' 님이 만듦)' : '') + ' 의 사본으로 · ' + placeName : '「' + firstLine(rec.what) + '」 · ' + placeName })),
      c ? el('div', { class: 'v2-studio-step' }, el('b', { text: '기획 카드로 정했어요' }), el('p', { text: c.who + ' · 적는 것: ' + c.items + ' · 할 수 있는 것: ' + c.can.join(' · ') })) : el('div', { class: 'v2-studio-step' }, el('b', { text: 'AI 가 세션에서 만들었어요' }), el('p', { text: '대화로 고칠 때마다 판이 하나씩 올라갔어요.' })),
    ];
    const list = el('div', { class: 'v2-studio-steps-list' }, ...steps);
    fetchAppVersions(rec.appId).then((vs) => {
      if (S.dead) return; const rows = vs.slice().sort((a, b) => a.version_no - b.version_no);
      const vrow = (v: { version_no: number; note: string | null; saved_at: string }): HTMLElement => el('div', { class: 'v2-studio-step v2-studio-step--ver' }, el('b', { text: v.version_no + '판' + (v.version_no === 1 ? ' · 처음' : '') }), el('p', { text: (v.note || '').trim() || (v.version_no === 1 ? '첫 판' : '고침') }), el('small', { text: whenText(v.saved_at) }));
      const vr = rows.length <= 8 ? rows.map(vrow) : [vrow(rows[0]), el('div', { class: 'v2-studio-step v2-studio-step--ver' }, el('p', { text: '… ' + (rows.length - 7) + '판 더 고쳤어요' })), ...rows.slice(-6).map(vrow)];
      vr.forEach((n) => list.append(n));
      list.append(el('div', { class: 'v2-studio-step' }, el('b', { text: '워크스페이스 앱이 됐어요' }), el('p', { text: '앱 찾기(왼쪽 「앱」)의 「워크스페이스 앱」 에 있어요 — 이름은 「' + title + '」. 워크스페이스 사람 모두 쓸 수 있어요.' })));
    }).catch(() => { /* 판 이력 없이도 안내한다 */ });
    const how: HTMLElement[] = [];
    if (rec.place !== 'full') how.push(el('div', {}, el('span', { class: 'k', text: '세션 위젯으로' }), el('span', { text: '세션을 열고 오른쪽 위 + 에서 이 앱을 고르면 세션 위젯으로 붙어요. 그 세션의 AI 도 같이 봐요 — 세션에 말로 시키면 AI 가 위젯 내용을 읽고 바꿔요.' })));
    if (rec.place !== 'side') how.push(el('div', {}, el('span', { class: 'k', text: '앱 화면으로' }), el('span', { text: '앱 찾기(왼쪽 「앱」)에서 이 앱을 누르면 사이드바 없이 화면 가득 열려요.' })));
    how.push(el('div', {}, el('span', { class: 'k', text: '더 고치려면' }), el('span', { text: '앱 찾기에서 그 칸의 ⋯ → 「이어서 만들기」. 말로 고치면 새 판이 되고, 마음에 안 들면 이전 판으로 되돌릴 수 있어요.' })));
    how.push(el('div', {}, el('span', { class: 'k', text: '팀원은' }), el('span', { text: '앱 찾기 ⋯ 에서 「내 사본 떠서 고치기」 로 자기 식으로 바꿔 쓰거나, 「원본을 고치기」 로 모두에게 적용되는 고침을 할 수 있어요.' })));
    // ⑦ 팀에 알리기 — 글은 기획 카드에서 미리 적는다. 지식 「앱 소개」 + 슬랙(적으면).
    const line = el('textarea', { class: 'ta', rows: '2' }) as HTMLTextAreaElement;
    line.value = (meCache && meCache.name ? meCache.name + ' 님이 ' : '') + '「' + title + '」 앱을 만들었어요 · ' + (c ? c.can.join(' · ') : rec.what) + ' · ' + placeName + ' · 앱 찾기(왼쪽 「앱」)의 워크스페이스 앱에 있어요';
    const slack = el('input', { class: 'v2-studio-name-in', type: 'text', placeholder: '슬랙 채널(선택) · 예: #product', maxlength: '60' }) as HTMLInputElement;
    const tellBtn = el('button', { class: 'v2-studio-go sm', type: 'button', text: rec.notified ? '알렸어요' : '팀에 알리기' }) as HTMLButtonElement; tellBtn.disabled = !!rec.notified;
    tellBtn.onclick = async () => { tellBtn.disabled = true; if (await sendPrompt(rec, notifyBrief(title, line.value.trim(), slack.value))) { rec.notified = true; saveRec(rec); tellBtn.textContent = '알렸어요'; toast('AI 가 팀에 알리는 중이에요 · 오른쪽 대화에서 확인하세요'); } else tellBtn.disabled = false; };
    const tryBtn = el('button', { class: 'v2-studio-go', type: 'button', text: '지금 써 보기' }) as HTMLButtonElement;
    tryBtn.onclick = async () => {
      tryBtn.disabled = true;
      const sid = rec.place !== 'full' ? routeSession() : '';
      if (sid && sid !== rec.sid) { if (await attachAppToSession(sid, rec.appId, title)) { closeAppStudio(); toast('「' + title + '」 을 이 세션에 위젯으로 붙였어요 · 오른쪽 탭에서 보세요 · 「안건 3개 적어 줘」 처럼 AI 에게 시켜 보세요'); return; } }
      closeAppStudio();
      if (!(await openAppUi(rec.appId, { title }))) toast('앱 찾기(왼쪽 「앱」)에서 「' + title + '」 을 열어 보세요');
    };
    h.replaceChildren(el('div', { class: 'v2-studio-fin' },
      el('h2', { text: '「' + title + '」 앱이 만들어졌어요' }),
      el('p', { class: 'v2-studio-lead', text: '코드를 만지지 않고 말로만 만든 앱이에요. 어떻게 만들어졌는지와 어디서 쓰는지를 한 번 보고, 바로 써 보세요.' }),
      el('h3', { text: '이렇게 만들었어요' }), list,
      el('h3', { text: '이렇게 쓰세요' }), el('div', { class: 'v2-studio-how' }, ...how),
      el('h3', { text: '팀에 알리기' }), el('div', { class: 'v2-studio-tell' }, el('p', { class: 'v2-studio-fine', text: '팀 지식에 「앱 소개」 로 남고(대시보드 알림에 뜸), 슬랙 채널을 적으면 거기에도 가요. 안 알려도 돼요.' }), line, el('div', { class: 'v2-studio-tell-act' }, slack, tellBtn)),
      el('div', { class: 'v2-studio-fin-act' }, tryBtn, el('button', { class: 'btn btn-ghost', type: 'button', text: '더 고치기', onclick: () => { rec.done = false; void setStage('fix'); } }))));
    requestAnimationFrame(() => coach('put', tryBtn, '이제 워크스페이스 앱이에요. 여기서 바로 열어 보세요.', rec.place === 'full' ? '크게 열어 한 바퀴 눌러 보세요' : '세션 위젯으로 붙이고 「안건 3개 적어 줘」 라고 시켜 보세요'));
  };

  // ── 단계 넘기기 ──
  const setStage = async (s: StudioStage): Promise<void> => {
    rec.stage = s; if (s !== 'put') rec.done = false; saveRec(rec);
    S.tool = 'pick'; S.active = -1; if (pop) { pop.remove(); pop = null; } body.classList.toggle('v2-studio-body--put', s === 'put'); body.classList.toggle('v2-studio-body--plan', s === 'plan' || s === 'check');
    tag.textContent = s === 'put' ? '앱 완성' : (rec.mode === 'new' ? '앱 만드는 중' : '앱 고치는 중'); undo.hidden = s === 'put' || !S.prevVer;
    if (s === 'put') { rec.done = true; saveRec(rec); if (S.frame) { S.frame.destroy(); S.frame = null; } appBox.replaceChildren(); applyPlace(); paintPut(); }
    else if (s === 'plan') { if (S.frame) { S.frame.destroy(); S.frame = null; } appBox.replaceChildren(); applyPlace(); paintPlan(); }
    else if (s === 'draft') { if (!rec.appId) { appBox.replaceChildren(); applyPlace(); } paintDraft(); }
    else if (s === 'fix') { if (!S.frame) { appBox.replaceChildren(); applyPlace(); } paintFix(); }
    else if (s === 'check') { S.check = null; if (S.frame) { S.frame.destroy(); S.frame = null; } appBox.replaceChildren(); applyPlace(); paintCheck(); if (rec.card && rec.appId) { S.checkWait = true; void sendPrompt(rec, checkBrief(rec.card, rec.appId)); } }
    applyPlace(); paintBar(); paintNow(); paintTray(); paintMarks();
  };
  const toDraft = async (): Promise<void> => { if (!rec.card) return; if (await sendPrompt(rec, draftBrief(rec.card, rec.place))) { S.step = 0; await setStage('draft'); } };
  const sendFix = async (): Promise<void> => {
    const pins = S.pins.filter((p) => p.note.trim()); if (!pins.length && !S.general.trim()) return;
    if (await sendPrompt(rec, fixBrief(rec.round + 1, pins, S.general, rec.place, rec.appId))) { S.waiting = true; S.waitT0 = Date.now(); S.tool = 'try'; closePop(); applyPlace(); paintMarks(); tickWait(); paintBar(); paintNow(); }
  };
  const putApp = async (): Promise<void> => {
    const newName = nameIn.value.trim() || S.title;
    try {
      const m = await me();
      await patchManifest(rec.appId, (man) => { if (newName) man.title = newName; man.studio = { ...(man.studio && typeof man.studio === 'object' ? man.studio : {}), made_by: man.studio?.made_by || m.id, build_session: rec.sid, place: rec.place, ...(rec.card ? { card: rec.card } : {}), ...(rec.origin ? { origin: rec.origin } : {}) }; }, '마무리 · 이름과 자리 표시');
      S.title = newName; rec.title = newName; name.textContent = newName;
    } catch (e: any) { toast('마무리 표시를 저장하지 못했어요 — ' + (e && e.message ? e.message : e) + ' · 앱은 그대로 쓸 수 있어요', true); }
    await setStage('put');
  };
  undo.onclick = async () => {
    if (!rec.appId || !S.prevVer) return;
    undo.disabled = true; const to = await revertApp(rec.appId, S.prevVer, S.title); undo.disabled = false;
    if (to != null) await showApp(to + '판으로 되돌렸어요');
  };
  help.onclick = () => helpMenu(help, () => showIntro(() => { /* 그대로 */ }, () => showTour()), () => showTour());
  teardown = () => { S.dead = true; window.clearTimeout(S.pollT); window.clearTimeout(S.logT); window.clearTimeout(S.tick); off(); window.removeEventListener('message', onMsg); if (S.frame) S.frame.destroy(); if (S.chat) S.chat.destroy(); };
  root.replaceChildren(
    el('div', { class: 'v2-studio-top v2-studio-top--build' }, crumb(), tag, name, ver,
      ...(rec.origin ? [el('small', { class: 'v2-studio-origin', text: '원본: ' + rec.origin.title })] : []),
      el('span', { class: 'v2-studio-sp' }), undo, chatBtn, help,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => closeAppStudio() })),
    bar, now, viewBar, band, body, chatWin, dockHint);
  if (rec.appId) { try { const out: any = await api('/api/ui/apps/' + encodeURIComponent(rec.appId)); const a = out?.app || out; if (a && a.title) { S.title = String(a.title); rec.title = S.title; name.textContent = S.title; } if (!rec.card && a?.manifest?.studio?.card) rec.card = a.manifest.studio.card; } catch (_) { /* noop */ } }
  if (!rec.from) rec.from = await logEnd(rec.sid);
  await setStage(rec.stage);
  void pump();
  // 대화 — 그 세션의 대화 보기를 끼운다(리브와 같은 방식: 목록을 한 번 읽어 그 세션 한 장으로).
  try {
    const [live, logs] = await Promise.all([
      api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
      api('/api/ui/v6/sessions?limit=40').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
    ]);
    if (S.dead) return;
    const { mergeSessions, renderSession } = await import('./views.js');   // 정적으로 들여오면 views → apps → app-studio → views 순환(check-imports)
    const made = takeCreated(rec.sid);
    const rows = made ? [made, ...(live as any[])] : (live as any[]);
    S.chat = renderSession(chatHost, { projects: [], sessions: mergeSessions(rows, logs as any[]), loadedAt: Date.now() } as any, rec.sid, { chatHome: true, solo: true, isVisible: () => !!root && chatHost.isConnected });
  } catch (e: any) {
    chatHost.replaceChildren(el('p', { class: 'v2-muted', text: '대화를 열지 못했어요 — ' + (e && e.message ? e.message : e) }));
  }
}

function whenText(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const now = new Date(), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? '오늘 ' + hm : (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + hm;
}
/** 지금 보고 있는 세션(주소 #/s/<id>) — 세션 옆 앱을 「지금 써 보기」 할 때 붙일 곳. */
function routeSession(): string {
  const m = /^#\/s\/([^?/]+)/.exec(location.hash || ''); try { return m ? decodeURIComponent(m[1]) : ''; } catch (_) { return ''; }
}
export { emptyCard };
