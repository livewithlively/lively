// v2/app-studio.ts — **앱 만들기**(#4592, 원준 2026-10-10 «누구나 편하게 앱을 만드는 UX» · 2026-10-11 «정형화된 흐름 · 처음 안내 · 팀과 끝까지»).
//
//  들어오는 길: 앱 찾기(런치패드) 「워크스페이스 앱」 끝의 「+ 새 앱」 → 런치패드가 닫히고 이 화면이 창 전체에 선다.
//  빈 대화 칸 대신 **다섯 단계**가 머리줄 아래 늘 서고, 그 아래 「지금 할 일」 한 문장 + 주 단추 하나. 대화는 곁이다.
//   ① 무엇을(이름 · 설명 · 어디서 쓰나)  ② 내용 — AI 가 먼저 기획 카드를 쓰고 사람은 틀린 줄만 고친다
//   ③ 시안 확인 · 고치기 — 걸음 넷을 지나 진짜 앱이 생기면 **실제 화면 그대로**(세션 위젯 = 시험 세션 · 앱 화면 = #/i) 가서 써 보고 그 위에 코멘트(고르기 · 핀 · 영역)를 남겨 「수정하기」 → 새 판
//     (원준 2026-10-14 «생성된 시안과 고치기는 하나의 과정 · 목업 말고 진짜 리얼 뷰 · 사이드바 그대로 · 그 위에 코멘트만» — app-review.ts)
//   ④ 확인 — AI 가 기획 카드와 대조 · 이름 · 자리  ⑤ 넣기 — 이렇게 만들었어요 · 써 보기 · 팀에 알리기(지식 「앱 소개」 + 슬랙)
//   ⑧ 남이 만든 앱을 내게 맞게 — 앱빌더 ⋯ 「내 사본 떠서 고치기」 · 「원본을 고치기」 → ③부터 짧게.
//  처음 한 번: 세 장 안내 · 단계마다 첫 번에만 뜨는 말풍선 · 「예시로 둘러보기」. 본 것은 이 브라우저에 남는다(SEEN_KEY).
//  자리(세션 옆 · 화면 전체 · 둘 다)에 따라 미리 보는 폭과 테두리, AI 에게 하는 말, 써 보는 길이 다르다.
//
//  새 배관은 없다 — 있는 부품을 엮는다:
//   · 대화 = 일반 세션 하나(spawnSession · 「앱 만들기」 프로젝트 아래)를 대화 보기(renderSession chatHome · 순환을 피해 늦게 들여온다)로 끼운다.
//   · 단계마다 보낼 글은 단추가 보낸다(POST …/prompt). AI 답은 세션 기록(…/transcript ndjson)을 읽어 표식([[기획카드]] · [[걸음 n/4]] · [[점검]])으로 가른다 — lib/studio-flow.ts.
//   · 앱 = 「만들기 시작」 때 서버가 나만 보는 빈 앱을 예약하고(#4667 app_build_start — 만든 사람 · 만들기 세션을 서버가 찍는다), 그 세션의 AI 가
//     그 id 로 app_save 하면 첫 판이 선다(폴링 · 'updated' 사건). 예약 없이 시작한 옛 기록만 시작 때의 앱 목록과 견줘 새로 생긴 내 앱을 찾는다.
//   · 공개 상태(#4667) — 새 앱은 나만 보는 초안, ④ 「누가 쓰나」 → 「이대로 넣기」 가 공개한다. 공개한 앱을 고친 판은 고친 사람의 초안(머리줄 「공개하기」).
//   · 찍어서 의견 = 실제 화면의 앱 프레임(app-ui 가 검토 중인 앱의 문서에 탐침을 넣는다)에게 비율 좌표의 요소(태그 · 글)를 묻는다 — app-review.ts.
//   · 사본 = /apps/:id/pull → id · 이름을 바꿔 /apps/save {origin_app_id} — 원본 · 만든 사람은 서버 기록(#4667). 판 = fetchAppVersions · revertApp.
import { api, apiUrl, el, toast, TOKEN_KEY } from '../core.js';
import { spawnSession } from './quick-session.js';
import { takeCreated } from './created-cache.js';
import { openAppUi, reloadAppFrames } from './app-ui.js';
import { onAppEvent } from './live-sync.js';
import { fetchAppVersions, revertApp } from './app-versions.js';
import { confirmPublish } from './publish-preview.js';   // #4732 공개 전에 표에 할 일을 보여 주고 확인
import { attachAppToSession } from './session-app-pane.js';   // ⑤ 「지금 써 보기」 — 보고 있던 (다른) 세션에 붙인다
import { markReviewOpen, readReviewOpen } from './review-resume.js';   // ③ 실제 화면을 보던 중 새로고침 → 같은 화면 · 막대로
import { ensureTrySession, mountTrySession, type TrySession } from './app-try-session.js';   // ③ 세션 위젯 = 시험 세션(앱을 만드는 세션과 다른 진짜 AI 세션 · 목록엔 안 선다)
import { closeReview, openReview, type ReviewApi } from './app-review.js';   // ③ 진짜 화면 위 코멘트 층
import { createAppInstance, getAppInstance } from './app-instance.js';   // ③ 「앱 화면으로 보기」 — 앱 찾기와 같은 인스턴스 탭(#/i/<id>)
import { effortChoices, effortKo, findHarness, flagChoices, prettyModel, refreshNodes, runCatalog, runNodes, type RunPick } from './run-picker.js';
import { nodeOptions, nodeWhere, resolveNodeChoice, sessionDefaults, type RunNode } from './run-prefs.js';
import { pickStudioAi, studioAiFlags, studioAiInputs, type StudioLogins } from '../lib/studio-ai.js';
import { BUILDER_PROJECT_NAME, builderRoute, builderSessionLabel } from '../lib/builder-flow.js';
import type { SessionChatHandle } from '../session-chat.js';
import { restorePath } from '../lib/restore-force.js';
import { CARD_ROWS, DRAFT_STEPS, ICON_COLORS, ICON_GLYPHS, PLACE, STAGES, WIREFRAME_PATH, verArrived, verJ, verName, assistantTexts, cardText, checkBrief, talkBrief, copyBrief, copyId, draftBrief, editBrief, emptyCard, fixBrief, freshApps, iconBrief, iconSpec, nextStageOpen, notifyBrief, parseCard, parseCheck, parseIcon, parseLimit, parseStep, planBrief, reachedOf, refView, resumeBrief, runStall, splitList, stageIndex, stageTabs, STALL_MS, type CardExtra, type RunStall, type StudioCard, type StudioIcon, type StudioPin, type StudioPlace, type StudioStage } from '../lib/studio-flow.js';
import { appGlassIcon, builtinAppIcon, registerAppIcon } from './glass-icon.js';   // ④ 아이콘 — 고르는 그림을 사이드바 · 세션 위젯 · 앱 찾기 꼴로 미리 그린다
import { icon } from './icons.js';
import { appGlyphName, iconPath } from '../lib/icon-paths.js';
import { darkPair, hexToHsv, hsvToHex, normHex, tooLight, type Hsv } from '../lib/icon-color.js';   // ④ 「다른 색」 팔레트

export type { StudioPlace };
export interface StudioRec {
  sid: string; pid: number; what: string; place: StudioPlace; appId: string; known: string[]; at: number;
  stage: StudioStage; card: StudioCard | null; round: number; from: number;
  mode: 'new' | 'copy' | 'edit'; origin?: { id: string; title: string; by: string }; title?: string; done?: boolean; notified?: boolean;
  view?: 'widget' | 'app';   // ③ 에서 마지막으로 본 실제 화면 — 세션 위젯 · 앱 화면
  /** ③ 세션 위젯의 시험 세션(app-try-session.ts — 앱을 만드는 세션과 다른 진짜 AI 세션 · 목록엔 안 선다). 다시 열면 그 세션으로. */
  trySid?: string;
  /** ③ 「앱 화면으로 보기」 가 연 앱 인스턴스(#/i/<id>) — 다시 열 때 같은 탭으로. */
  instId?: string;
  /** ④ 확인에서 고른 공개 범위 — 기본 「나만」(원준 2026-10-14 «디폴트가 내가 만든 앱은 나만»). 'all' 이면 「이대로 넣기」 가 공개한다(app_save publish).
   *  'me' 면 공개하지 않는다 — 새 앱은 나만 보는 앱으로, 이미 공개한 앱을 고친 것이면 내 초안으로 남는다(공개를 거두지 않는다 · #4667). */
  vis?: 'all' | 'me';
  /** ④ 에서 적던 의견 — 뒤로 갔다 와도 날아가지 않게 기록에 둔다(원준 2026-10-14 «뒤로가기 눌러도 입력했던 내용은 절대 안 날아가게»). */
  pins?: StudioPin[]; general?: string;
  /** 세션 이름을 기획 카드의 이름으로 한 번 지었나(①에서 이름을 비워 둔 경우). */
  named?: boolean;
  /** #4667 「만들기 시작」 때 서버가 예약한 앱 id — AI 가 이 id 로 저장하면 그게 이 만들기의 앱이다(appId 는 첫 판이 생긴 뒤에 선다). */
  draftId?: string;
  /** 와 본 가장 뒤 단계(0~4, lib/studio-flow reachedOf) — 단계 바에서 앞으로도 간다(원준 2026-10-19). 그 뒤 내용이 낡으면 당긴다(기획을 다시 받으면 1 · 새 버전이 나오면 2). */
  reached?: number;
  /** 초안(또는 다시 만들기)을 청할 때의 기획 카드 글 — ②에서 카드를 그 뒤에 고쳤는지 본다(안 고쳤으면 「다음 →」 는 그냥 ③ 으로 간다 · 고쳤으면 「바꾼 기획대로 다시 만들기」). */
  cardSent?: string;
  /** ④ 의 마지막 대조 결과 — 같은 버전 · 같은 기획 카드면 다시 ④ 로 와도 AI 에게 다시 묻지 않는다. */
  check?: { have: string[]; missing: string[]; ver: number; card: string };
  /** ①로 돌아와 고치던 것(아직 「이 내용으로 다시 기획」 전) — 단계를 옮겨 다녀도 날아가지 않게(원준 2026-10-14 «입력했던 내용은 절대 안 날아가게»). */
  whatEdit?: { name: string; what: string; place: StudioPlace };
  /** ③ 첫 판 전 AI 가 알린 걸음(1~4 · [[걸음 n/4]]) — 새로 열어도 «시작하는 중» 으로 돌아가지 않게(원준 2026-10-26). 초안을 다시 청하면 0. */
  step?: number;
  /** ④ 에서 고른 아이콘(아직 저장 전) — 「완료 · 다음 단계로」 의 마무리 저장이 매니페스트 icon 에 싣는다. 없으면 지금 아이콘 그대로. */
  icon?: StudioIcon;
  /** ④ 「AI에게 그려 달라기」 로 받은 그림들(최근 것 먼저 · 여섯까지) — 단계를 오가도 남는다. */
  iconAi?: StudioIcon[];
  /** 고를 때 저장돼 있던 아이콘의 path('' = 없었다) — 그 사이 AI 가 새 버전에 다른 아이콘을 넣었으면 고른 것은 낡았다(덮지 않는다 · 격리 리뷰). */
  iconBase?: string;
  /** ③ 「수정하기」 로 고침을 보낸 때 · 그때 가장 뒤 판 — 새 판이 나올 때까지 있다. 앱빌더를 나갔다 와도 «AI가 수정하고 있어요» 로 다시 열고,
   *  나가 있던 사이 새 판이 나왔으면 열자마자 끝맺는다(원준 2026-10-28 «다른 데 갔다 다시 들어가면 진행중 페이지로 안 가고 이전으로 돌아간 것처럼»). */
  fixing?: { at: number; ver: number };
}
const STUDIO_KEY = 'lively_v2_app_studio';
const SEEN_KEY = 'lively_v2_app_studio_seen';
export const PROJECT_NAME = BUILDER_PROJECT_NAME;   // #4632 — 앱빌더가 여는 세션은 전부 이 프로젝트. 사람에게는 프로젝트가 아니라 앱빌더가 그 문이다(lib/builder-flow)
const EXAMPLE: { what: string; card: StudioCard } = { what: '주간 회의 안건을 모으고 끝난 것 표시', card: { name: '회의 안건', who: '회의를 준비하는 사람과 참석자 모두', items: '안건 제목 · 회의 날짜 · 끝남 표시', can: ['안건 더하기', '회의별로 모아 보기', '끝난 것 접기'], not: '회의록 쓰기 · 알림 보내기', first: '이번 회의 안건 목록(안 끝난 것 먼저)' } };

// ① 설명칸 — 예시는 칸 안 안내글 하나로만(원준 2026-10-14 «예시로 채우기 · 적어 두면 좋은 것 다 빼»).
const DESC_PH = '예: 회의록을 음성 파일로 주면 이를 음성 파일을 전사하고 내용을 요약해서 정리해주면 좋겠어요. 회의록을 정리하는 형식을 사용자가 개인화 할 수 있으면 좋겠어요. 앱 화면에서는 이전의 회의록이 날짜별로 정리되어있으면 좋겠고, 해당 날짜의 회의록을 누르면 정리본이 나오면 좋겠어요. AI 세션의 사이드바에서는 기존의 회의록을 찾고 그 회의록 정리본을 제가 참고하거나, AI 세션에 한 번에 집어넣을 수 있도록 하고 싶어요.';
const firstLine = (s: string): string => String(s || '').split('\n')[0].trim();
// 앱 만들기 세션의 AI · 모델 · 생각 깊이 — 사람이 고르지 않고 여기서 정한다(원준 2026-10-14). 하네스마다의 값과 고르는 순서는 lib/studio-ai 가 정본이다(#4632 2026-10-26 —
//  Codex 나 다른 AI 하나만 연결한 사람도 그 AI 의 «claude opus · 높음» 급으로 연다). 카탈로그에 없는 값이면 그 축은 안 넘긴다(AI 설정 그대로).
interface StudioAi { harness: string; flags: Record<string, string>; chip: string }
/** 시간 안에 안 오면 null — 이 답들은 «만들기 시작» 앞에 서 있다. 늦으면 모름으로 치고 간다(→ 종전처럼 claude). */
const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
/** 자격이 파일로 안 남는 AI(Antigravity)를 따로 물은 답 — 이 화면을 연 동안 한 번만 묻는다(CLI 에게 묻는 데 몇 초 걸린다). */
const probed = new Map<string, Promise<boolean | null>>();
/**
 * 내 AI 로그인(lib/studio-ai StudioLogins). 못 받으면 빈 목록(→ 종전처럼 claude).
 *  ① 화면은 칩을 그리며 두세 번 연달아 묻는다 — 잠깐(30초) 같은 답을 쓰고, 앱빌더를 새로 열 때 비운다(forgetAiLogins).
 *  확인된 AI 가 하나도 없을 때만 목록이 «모름» 으로 준 AI 를 따로 묻는다 — 그래야 Antigravity 하나만 연결한 사람도 그걸로 열린다.
 */
let loginsMemo: { at: number; p: Promise<StudioLogins> } | null = null;
function forgetAiLogins(): void { loginsMemo = null; probed.clear(); }
function aiLogins(): Promise<StudioLogins> {
  if (loginsMemo && Date.now() - loginsMemo.at < 30_000) return loginsMemo.p;
  const p = (async (): Promise<StudioLogins> => {
    const d: any = await within(api('/api/ui/me/ai-accounts').catch(() => null), 4000);
    if (!d) { loginsMemo = null; return { yes: [], absent: [] }; }   // 못 받은 답은 기억하지 않는다
    const as: any[] = Array.isArray(d.accounts) ? d.accounts : [];
    const yes = as.filter((a) => a.loggedIn === true).map((a) => String(a.key));
    const absent = as.filter((a) => a.installed === false).map((a) => String(a.key));
    if (!yes.length) {
      for (const a of as.filter((x) => x.how === 'probe' && x.loggedIn == null && x.installed !== false)) {
        const k = String(a.key);
        if (!probed.has(k)) probed.set(k, within(api('/api/ui/me/ai-accounts/check', { method: 'POST', body: JSON.stringify({ harness: k }) }).then((r: any) => (typeof r?.loggedIn === 'boolean' ? r.loggedIn : null)).catch(() => null), 8000));
        if ((await probed.get(k)) === true) yes.push(k);
      }
    }
    return { yes, absent };
  })();
  loginsMemo = { at: Date.now(), p };
  return p;
}
/** 이 컴퓨터(nodeId — '' 는 중앙)에서 앱 만들기를 무엇으로 열까. 고르는 규칙은 lib/studio-ai(studioAiInputs · pickStudioAi). */
async function studioAi(nodes: RunNode[], nodeId: string): Promise<StudioAi> {
  const [hs, lg] = await Promise.all([runCatalog().catch(() => []), aiLogins()]);
  const harness = pickStudioAi(studioAiInputs(hs.map((h) => h.key), nodes, nodeId, lg));
  const h = findHarness(hs, harness);
  const flags = studioAiFlags(harness, flagChoices(h, '--model'), (m) => effortChoices(h, m));
  const name = harness === 'claude' ? 'Claude' : (h?.label || harness);
  const model = flags['--model'] ? name + ' ' + prettyModel(flags['--model']).replace(/^Gpt\b/, 'GPT') : name + ' · 모델은 AI 설정 그대로';
  return { harness, flags, chip: model + (flags['--effort'] ? ' · 생각 깊이 ' + effortKo(flags['--effort']) : '') };
}

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
/** 이 브라우저에서 이 앱을 **새로** 만드는 중인가(⑤ 「이대로 넣기」 전 · 고치기 · 사본은 아니다) — 앱 찾기 · 앱빌더가 만드는 중인 앱을 가른다(builder-flow isAppInProgress · 원준 2026-10-15). */
export function studioRecBuildingFor(appId: string): boolean { return !!appId && readRecs().some((x) => x.appId === appId && !x.done && x.mode === 'new'); }
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
  } catch (e: any) { toast('AI에게 보내지 못했어요. 잠시 후 다시 시도해주세요. (' + (e && e.message ? e.message : e) + ')', true); return false; }
}
/** 앱빌딩 세션 이름을 못 박는다(사람이 지은 이름 — 에이전트의 session_rename 이 덮지 못한다). 실패해도 만들기는 간다. */
async function relabel(sid: string, name: string | undefined, mode: 'new' | 'copy' | 'edit'): Promise<void> {
  try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(sid), { method: 'POST', body: JSON.stringify({ label: builderSessionLabel(name, mode) }) }); } catch (_) { /* 이름은 못 바꿔도 된다 */ }
}
async function listApps(): Promise<any[]> { try { const out: any = await api('/api/ui/apps'); return Array.isArray(out?.apps) ? out.apps : []; } catch (_) { return []; } }
/** 매니페스트 한 군데를 고쳐 새 판으로 저장한다. opts.publish — 저장하면서 바로 모두에게 공개(#4667 · 배포 설정처럼 «모두의 앱» 을 바꾸는 일). */
export async function patchManifest(appId: string, patch: (man: any) => void, note: string, opts?: { publish?: boolean }): Promise<void> {
  const pulled: any = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/pull');
  const files: any[] = Array.isArray(pulled?.files) ? pulled.files : [];
  const mf = files.find((f) => f && f.path === 'lively-app.json'); if (!mf) throw new Error('앱의 설명 파일(lively-app.json)이 없어요');
  const man = JSON.parse(String(mf.content)); patch(man); mf.content = JSON.stringify(man, null, 2);
  await api('/api/ui/apps/save', { method: 'POST', body: JSON.stringify({ files, note, ...(opts && opts.publish ? { publish: true } : {}) }) });
}
/** GET /api/ui/apps/:id/server 응답에서 이 화면이 읽는 칸(src/apps/app-server-lifecycle.ts serverStatus). */
interface ServerStatusView {
  server_declared?: boolean;
  available?: string | null;
  deploying?: boolean;
  installed?: { deployed_to_cur?: boolean; build?: { status?: string; stage?: string | null; error?: string | null; now?: string } | null } | null;
  function?: { last_error?: string | null } | null;
}
/**
 * #4484 서버가 있는 앱(매니페스트 web.server)이면 「이대로 넣기」·「공개하기」 전에 서버를 빌드해 올린다(결정 상민 2026-10-15 — 저장만으로는 빌드하지 않는다).
 *  같은 코드가 이미 올라가 있으면 바로 지나간다. 빌드는 몇 분 걸릴 수 있어 시작만 하고 상태를 3초마다 본다(최대 12분).
 *  돌려주는 값: true = 넣기 · 공개를 이어서 해도 된다(서버 앱이 아니거나 · 이 워크스페이스에 앱 서버가 없거나 · 올라갔다) · false = 멈춘다(실패 · 시간 초과).
 *  실패하면 그 기록은 서버가 이 앱의 만들기 세션에도 넣는다 — 그 세션의 AI 가 보고 고친다.
 */
export async function ensureAppServer(appId: string, onProgress?: (text: string) => void): Promise<boolean> {
  const path = '/api/ui/apps/' + encodeURIComponent(appId) + '/server';
  let st: ServerStatusView | null;
  try { st = await api(path); } catch (_) { return true; }   // 상태를 못 읽으면(옛 서버) 종전대로 넣는다
  if (!st || !st.server_declared) return true;
  if (st.available) { toast('이 워크스페이스는 앱 서버가 아직 켜져 있지 않아 화면만 넣어요. ' + st.available, true); return true; }
  if (st.installed && st.installed.deployed_to_cur) return true;
  try { await api(path + '/deploy', { method: 'POST', body: JSON.stringify({ wait_s: 3 }) }); }
  catch (e: unknown) { toast('서버를 빌드하지 못했어요. ' + (e instanceof Error ? e.message : String(e)), true); return false; }
  toast('서버를 빌드하고 있어요. 몇 분 걸릴 수 있어요.');
  const t0 = Date.now();
  let told = t0;
  for (;;) {
    await new Promise((r) => window.setTimeout(r, 3000));
    try { st = await api(path); } catch (_) { continue; }
    const b = st && st.installed && st.installed.build;
    if (st && st.installed && st.installed.deployed_to_cur && !st.deploying) { toast('서버를 올렸어요'); return true; }
    if (st && !st.deploying) {
      //  일이 끝났는데 올라가지 않았다 — 빌드 실패 · 올리기 실패(시험 호출 등) · 그 밖. 기록은 서버가 만들기 세션에 넣었다.
      const why = b && b.status === 'failed' ? '서버 빌드가 실패했어요(' + (b.stage || '?') + '). ' + (b.error || '')
        : st.function && st.function.last_error ? '서버를 올리지 못했어요. ' + st.function.last_error
          : '서버를 올리지 못했어요. 앱빌더의 상태에서 까닭을 볼 수 있어요.';
      toast(why + ' 기록은 만들기 세션의 AI에게 보냈어요.', true);
      return false;
    }
    const line = '서버 빌드 중 · ' + Math.round((Date.now() - t0) / 1000) + '초' + (b && b.now ? ' · ' + String(b.now).slice(0, 80) : '');
    if (onProgress) onProgress(line);
    else if (Date.now() - told >= 30_000) { told = Date.now(); toast(line); }
    if (Date.now() - t0 > 12 * 60_000) { toast('서버 빌드가 12분 넘게 끝나지 않아 기다리기를 멈췄어요. 상태는 앱빌더에서 다시 볼 수 있어요.', true); return false; }
  }
}
/** 매니페스트 studio 칸에서 서버가 기록하는 것(만든 사람 · 만들기 세션 · 원본)을 걷는다 — #4667 그건 앱 코드가 아니라 서버 칸이 정본이다. 자리 · 기획 카드는 남긴다. */
export function studioUiOnly(studio: any): Record<string, unknown> {
  const { made_by: _m, build_session: _b, origin: _o, ...keep } = (studio && typeof studio === 'object' ? studio : {}) as Record<string, unknown>;
  return keep;
}
/** #4667 그 앱의 지금 공개 상태(서버) — 머리줄 「n판 · 나만 보는 초안」 · 「공개하기」 · ④⑤ 의 재료. 못 읽으면 null. */
export interface StudioVis { visibility: 'all' | 'me'; publishedNo: number; draftMine: boolean; canPublish: boolean; canUnpublish: boolean; empty: boolean; title: string; card: unknown; icon: StudioIcon | null }
async function readVis(appId: string): Promise<StudioVis | null> {
  try {
    const out: any = await api('/api/ui/apps/' + encodeURIComponent(appId)); const a = out?.app || out; if (!a) return null;
    const me0 = await me();
    return { visibility: a.visibility === 'me' ? 'me' : 'all', publishedNo: Number(a.published_version_no) || 0,
      draftMine: !!(a.draft && a.draft.by && a.draft.by === me0.id), canPublish: !!a.can_publish, canUnpublish: !!a.can_unpublish, empty: !!a.empty,
      title: String(a.title || ''), card: a.manifest && a.manifest.studio ? a.manifest.studio.card : null, icon: iconSpec(a.manifest && a.manifest.icon) };
  } catch (_) { return null; }
}
/** ⑧ 내 사본 — 원본 파일을 받아 id · 이름 · studio.origin 만 바꿔 저장한다. 원본은 그대로. */
async function makeCopy(origin: { id: string; title: string; by: string }, place: StudioPlace): Promise<{ id: string; title: string }> {
  const m = await me(); const id = copyId(origin.id, m.id); const title = origin.title + ' · ' + (m.name || '내 것');
  const pulled: any = await api('/api/ui/apps/' + encodeURIComponent(origin.id) + '/pull');
  const files: any[] = (Array.isArray(pulled?.files) ? pulled.files : []).filter((f: any) => f && typeof f.path === 'string' && !/^bin\//.test(f.path));
  const mf = files.find((f) => f.path === 'lively-app.json'); if (!mf) throw new Error('원본의 설명 파일이 없어요');
  const man = JSON.parse(String(mf.content)); man.id = id; man.title = title;
  //  #4667 원본 · 만든 사람은 서버가 기록한다(origin_app_id · 저장한 사람) — 매니페스트엔 자리만 남긴다. 마무리 표시(put)도 걷는다 —
  //   사본은 이제부터 만드는 앱이다(원본의 「다 만듦」 이 따라오면 다른 기기의 「만들던 앱」 에서 빠진다 · 격리 리뷰 2-9).
  const { put: _put, ...ui } = studioUiOnly(man.studio);
  man.studio = { ...ui, place };
  mf.content = JSON.stringify(man, null, 2);
  await api('/api/ui/apps/save', { method: 'POST', body: JSON.stringify({ files, note: '사본 · 원본 「' + origin.title + '」 그대로', origin_app_id: origin.id }) });
  return { id, title };
}

// ── 화면 뿌리 ──────────────────────────────────────────────────────────────────────────
//  창 전체를 덮는 창(기본)이거나, 앱빌더(#4632) 안의 자리(host)에 선다 — 그때 머리줄에 「앱빌더 ›」 가 붙고 닫으면 onClose 가 불린다(목록으로).
export interface StudioMountOpts {
  host?: HTMLElement | null; onClose?: () => void;
  /** 세션이 생겼다(① 만들기 시작 · ⑧ 사본/원본) — 앱빌더가 주소를 그 세션으로 바꿔 새로고침해도 돌아오게 한다. */ onSession?: (sid: string) => void;
  /** ③ 실제 화면으로 써 보기 시작 · 끝(null) — 앱빌더가 주소에 적어(lib/builder-flow builderSeeRoute) 그동안 앱빌더 사이드바를 접는다(#4632 원준 2026-10-19). */
  onSee?: (sid: string, see: 'widget' | 'app' | null) => void;
}
let root: HTMLElement | null = null;
let teardown: (() => void) | null = null;
let mountOpts: StudioMountOpts = {};
export function closeAppStudio(): void {
  if (teardown) { teardown(); teardown = null; }
  if (root) { root.remove(); root = null; }
  closeCoach();
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
//  머리줄 = 「앱빌더 › <만들고 있는 앱 이름>」(원준 2026-10-19 «앱 만들기 이 말이 왜 필요한건지? 차라리 만들고 있는 앱 이름을 · 앱빌더 누르면 앱 맨앞으로 나가져야»).
//   「앱빌더」 는 단추다 — 누르면 앱빌더 첫 화면(목록)으로 나간다(닫기와 같은 길 · onClose). 만들던 것은 기록에 남아 「만들던 앱」 에서 이어진다.
const crumb = (): HTMLElement | null => (mountOpts.host ? el('button', { class: 'v2-studio-crumb', type: 'button', text: '앱빌더 ›', title: '앱빌더 첫 화면으로 나가요. 만들던 내용은 그대로 남아요.', onclick: () => closeAppStudio() }) : null);
/** 머리줄의 앱 이름 — 이름을 아직 안 정했으면 「새 앱」. */
const NEW_APP_NAME = '새 앱';
export { me as studioMe };

/** 이어서 열 세션 — 이 브라우저에 기록이 없으면 세션 이름(what)과 그 세션이 만든 앱(appId)으로 되살린다(앱빌더 #4632). */
export interface StudioResume { sid: string; what?: string; title?: string; appId?: string }
/** 앱 만들기를 연다. resume 을 주면 만들던 것을 이어서(그 세션 · 그 단계), 없으면 시작 화면부터. */
export function openAppStudio(resume?: StudioResume | null, opts?: StudioMountOpts): void {
  mountRoot(opts);
  const rec = resume ? readRecs().find((r) => r.sid === resume.sid) || null : null;
  if (rec) { void build(rec); return; }
  if (resume && resume.sid) {
    //  기록 없이 되살리기(다른 브라우저 · 다른 컴퓨터) — #4667 서버가 아는 «이 세션이 만드는 앱» 으로 잇는다(세션 → 앱 역조회).
    //   앱이 있으면 ③(판이 있다 · fix), 아직 첫 판 전이면 ② — 기획 카드는 앱에 적어 둔 것, 없으면 그 세션의 대화 기록에서 마지막 카드를 다시 읽는다.
    void (async () => {
      const rows: any[] = await api('/api/ui/apps?session=' + encodeURIComponent(resume.sid)).then((d: any) => (Array.isArray(d?.apps) ? d.apps : [])).catch(() => []);
      const a = rows[0] || null;
      if (!root) return;
      if (!a && !resume.what && !resume.appId) { start(); return; }
      const appId = a ? (a.empty ? '' : String(a.id)) : (resume.appId || '');
      const pl = a && a.manifest && a.manifest.studio ? a.manifest.studio.place : '';
      const place: StudioPlace = pl === 'side' || pl === 'full' || pl === 'both' ? pl : 'both';
      let card: StudioCard | null = a && a.manifest && a.manifest.studio && a.manifest.studio.card ? a.manifest.studio.card : null;
      let from = 0;
      const log = await rawLog(resume.sid, 'from=0');
      if (log) { from = log.to; if (!card) assistantTexts(log.text).forEach((t) => { const c = parseCard(t); if (c) card = c; }); }
      if (!root) return;
      const known = a ? [] : (await listApps()).map((x) => String(x.id));   // 예약이 없던 옛 만들기만 «새로 생긴 앱» 을 찾는다
      const title = resume.title || (a && !a.empty ? String(a.title || '') : '');
      const r2: StudioRec = { sid: resume.sid, pid: 0, what: resume.what || title || (a ? String(a.title || '') : ''), place, appId, known, at: Date.now(),
        stage: appId ? 'fix' : 'plan', card, round: 0, from, mode: 'new', ...(a ? { draftId: String(a.id) } : {}), ...(title ? { title } : {}) };
      saveRec(r2); void build(r2);
    })();
    return;
  }
  start();
}
/** ⑧ 남이 만든(또는 내가 만든) 앱을 내게 맞게 — 사본을 떠서, 또는 원본을 그대로 고치기. ③ 시안 확인 · 고치기에서 연다. */
export async function openAppStudioFor(app: { id: string; title: string; by: string; place?: StudioPlace }, how: 'copy' | 'edit', opts?: StudioMountOpts): Promise<void> {
  const r = mountRoot(opts);
  r.replaceChildren(el('div', { class: 'v2-studio-top' }, crumb(), el('b', { class: 'v2-studio-name', text: app.title || NEW_APP_NAME }), el('span', { class: 'v2-studio-sp' })),
    el('div', { class: 'v2-studio-wait v2-studio-wait--page' }, el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' }), el('b', { text: how === 'copy' ? '사본을 만드는 중이에요' : '수정할 준비를 하는 중이에요' })));
  const place: StudioPlace = app.place || 'both';
  try {
    const target = how === 'copy' ? await makeCopy(app, place) : { id: app.id, title: app.title };
    if (!root) return;
    const known = (await listApps()).map((a) => String(a.id));
    const pid = await studioProject();
    const brief = how === 'copy' ? copyBrief(target.id, target.title, app.title, app.by, place) : editBrief(app.id, app.title, place);
    //  고치기 · 사본도 새로 만들기와 같은 AI · 모델 · 생각 깊이로 연다(종전엔 run 없이 직전 세션 설정으로 열렸다). 컴퓨터는 종전대로 중앙.
    forgetAiLogins(); const ai = await studioAi([], '');
    const run: RunPick = { harness: ai.harness, flags: ai.flags, node: '', mode: 'normal', autoApprove: sessionDefaults().autoApprove, writeVis: '' };
    const s = await spawnSession(brief, { ...(pid > 0 ? { projectId: pid } : { projectName: PROJECT_NAME }), run, label: builderSessionLabel(target.title, how) });
    if (!s) { toast('세션을 열지 못했어요', true); closeAppStudio(); return; }
    //  #4667 이 세션이 이 앱의 만들기 세션 — 내가 책임자인 앱(내 사본 · 내가 만든 앱)이면 서버가 잇고, 남의 원본이면 그대로 둔다.
    void api('/api/ui/apps/build-start', { method: 'POST', body: JSON.stringify({ session_id: s.id, app_id: target.id }) }).catch(() => { /* 못 이어도 고치기는 된다 */ });
    const rec: StudioRec = { sid: s.id, pid, what: target.title, place, appId: target.id, known, at: Date.now(), stage: 'fix', round: 0, from: 0, mode: how, origin: { id: app.id, title: app.title, by: app.by }, title: target.title, card: null, named: true };
    saveRec(rec); if (mountOpts.onSession) mountOpts.onSession(s.id); void build(rec);
  } catch (e: any) { toast((how === 'copy' ? '사본을 만들지 못했어요. ' : '앱을 열지 못했어요. ') + (e && e.message ? e.message : e), true); closeAppStudio(); }
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
/** 「예시로 둘러보기」 — 「회의 안건」 앱이 ①→⑤ 가는 것을 같은 꼴의 장면 다섯으로. 진짜로 만들지 않는다. */
function showTour(onDone?: () => void): void {
  if (!root) return;
  const c = EXAMPLE.card;
  const slides: Array<{ n: number; t: string; now: string; body: () => HTMLElement }> = [
    { n: 1, t: '앱 이름과 기능 정하기', now: '이름과 하고 싶은 일을 적고, 쓸 자리를 고른 뒤 「만들기 시작」을 눌러주세요.', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'in', text: '회의 안건' }), el('div', { class: 'in', text: EXAMPLE.what }), el('div', { class: 'row' }, el('span', { class: 'on', text: '세션 위젯' }), el('span', { text: '앱 화면' }), el('span', { text: '둘 다' }))) },
    { n: 2, t: '세부 기획 정하기', now: '기획 카드에서 틀린 내용을 고쳐주세요', body: () => cardView(c, null) },
    { n: 3, t: '시안 확인 · 수정', now: '가상 화면에서 실제로 어떻게 동작하는지 테스트해 보고, 고칠 곳에 코멘트를 남겨주세요.', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'steps' }, ...DRAFT_STEPS.map((s, i) => el('span', { class: i < 4 ? 'done' : '', text: s }))), el('div', { class: 'app' }, el('b', { text: '이번 회의 안건 📍' }), el('div', { text: '☐ 지표 대시보드 범위 정하기 📍' }), el('div', { text: '☐ 다음 분기 채용' }), el('div', { class: 'mute', text: '☑ 지난 회의록 확인' })), el('div', { class: 'cm' }, el('div', { text: '📍 제목 「이번 회의 안건」 → 회의 날짜도 같이 보이게' }), el('div', { text: '📍 안건 줄 → 체크 말고 「끝남」 단추로' }), el('div', { class: 'mute', text: '→ V2: 제목에 날짜, 「끝남」 단추, 안 끝난 것 먼저' }))) },
    { n: 4, t: '확인', now: '아래 다섯 가지가 맞는지 확인해주세요.', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'chk' }, el('div', { text: '✓ 원하던 것이 다 있나요? 셋 다 있어요' }), el('div', { text: '✓ 이름: 회의 안건' }), el('div', { text: '✓ 쓰는 자리: 세션 위젯' }), el('div', { text: '✓ 누가 쓰나: 나만 (기본)' }), el('div', { text: '✓ 아이콘: AI가 그린 그림' }))) },
    { n: 5, t: '넣기', now: '「지금 써 보기」로 바로 열어 보고, 「팀에 알리기」로 팀에 알려주세요.', body: () => el('div', { class: 'v2-studio-tour-wire' }, el('div', { class: 'chk' }, el('div', { text: '이렇게 만들었어요: 초안, V2 날짜와 끝남 단추, V3 글자 크기' }), el('div', { text: '이렇게 쓰세요: 세션 오른쪽 위 +에서 이 앱을 고르면 세션 위젯으로 붙어요' }), el('div', { text: '팀에 알리기: 「장원준 님이 「회의 안건」 앱을 만들었어요」' }))) },
  ];
  let i = 0; const ov = el('div', { class: 'v2-studio-intro v2-studio-tour' }); const box = el('div', { class: 'v2-studio-intro-box' });
  const paint = (): void => {
    const s = slides[i];
    box.replaceChildren(
      el('div', { class: 'v2-studio-bar v2-studio-bar--tour' }, ...STAGES.map((x) => el('span', { class: x.n < s.n ? 'done' : x.n === s.n ? 'on' : '', text: '① ② ③ ④ ⑤ ⑥'.split(' ')[x.n - 1] + ' ' + x.label }))),
      el('div', { class: 'v2-studio-now' }, el('span', { text: s.now })),
      el('h2', { text: s.n + '. ' + s.t + ' (예시: 회의 안건)' }), s.body(),
      el('div', { class: 'v2-studio-intro-act' },
        el('button', { class: 'btn btn-ghost', type: 'button', text: '닫기', onclick: () => { ov.remove(); } }),
        el('span', { class: 'v2-studio-sp' }),
        i > 0 ? el('button', { class: 'btn btn-ghost', type: 'button', text: '이전', onclick: () => { i--; paint(); } }) : null,
        i < slides.length - 1 ? el('button', { class: 'v2-studio-go', type: 'button', text: '다음', onclick: () => { i++; paint(); } })
          : el('button', { class: 'v2-studio-go', type: 'button', text: '내 앱 만들기', onclick: () => { ov.remove(); if (onDone) onDone(); } })));
  };
  ov.append(box); root.append(ov); paint();
}
/** 단계마다 첫 번에만 — 지금 눌러야 할 자리 바로 아래에 안내 한 칸. 화면 흐름 안에 끼워 아래 것을 밀어낸다 — 위에 떠서 다른 것을 가리지 않는다
 *  (원준 2026-10-16 «다른거 가리게 만드니까 별론데»). 이 브라우저에서 그 단계를 처음 볼 때 한 번 뜨고, 「닫기」 를 누르거나 그 단계를 떠나면 사라진다.
 *  사라질 때 아래 것이 제자리로 올라오니 아무 데나 누르면 닫히던 것 · 12초 뒤 물러나던 것은 걷었다(누르려던 단추가 손 밑에서 움직인다).
 *  그 단계 화면을 다시 그려도(새 버전 · 대조 결과) 닫기 전엔 같은 자리에 다시 선다 — 그래서 열린 안내를 여기 들고 있다. */
let openCoach: { key: string; text: string; example: string } | null = null;
function coach(key: string, after: Element | null, text: string, example: string): void {
  if (!root || !after) return;
  if (!openCoach || openCoach.key !== key) {
    if (readSeen().coach?.[key]) return;
    markSeen((s) => { s.coach = s.coach || {}; s.coach[key] = 1; });
  }
  openCoach = { key, text, example };
  root.querySelectorAll('.v2-studio-coach').forEach((n) => n.remove());
  const b = el('div', { class: 'v2-studio-coach', role: 'note' },
    el('div', {}, el('b', { text: '처음 안내' }), el('span', { text }), el('small', { text: '예: ' + example })),
    el('button', { class: 'v2-studio-coach-x', type: 'button', text: '×', title: '닫기', 'aria-label': '처음 안내 닫기', onclick: () => { closeCoach(); } }));
  after.after(b);
}
/** 열린 안내를 그 자리에 다시 세운다(그 단계 화면을 다시 그렸을 때) — 닫았거나 다른 단계의 안내면 아무것도 안 한다. */
function recoach(key: string, after: Element | null): void { if (openCoach && openCoach.key === key) coach(key, after, openCoach.text, openCoach.example); }
/** 열린 안내를 닫는다(다시 그려도 서지 않는다) — 화면에 있으면 걷는다. */
function closeCoach(): void { openCoach = null; if (root) root.querySelectorAll('.v2-studio-coach').forEach((n) => n.remove()); }
/** 단계를 옮겼다 — 그 단계의 안내가 아니면 닫는다(돌아와도 다시 서지 않는다). */
function leaveCoach(key: string): void { if (openCoach && openCoach.key !== key) closeCoach(); }
function helpMenu(btn: HTMLElement, onIntro: () => void, onTour: () => void): void {
  if (!root) return;
  root.querySelectorAll('.v2-studio-help').forEach((n) => n.remove());
  const m = el('div', { class: 'v2-studio-help' },
    el('button', { type: 'button', text: '처음 안내 다시 보기', onclick: () => { m.remove(); onIntro(); } }),
    el('button', { type: 'button', text: '예시로 둘러보기(1분)', onclick: () => { m.remove(); onTour(); } }),
    el('button', { type: 'button', text: '단계별 안내 다시 켜기', onclick: () => { m.remove(); markSeen((s) => { s.coach = {}; }); toast('다음 단계부터 안내가 다시 나와요'); } }));
  const r = btn.getBoundingClientRect(); m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  root.append(m);
  const off = (e: Event): void => { if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}
//  누른 채인가 — 「참고한 서비스」 가 보기로 돌아갈 때를 늦춘다(cardView).
let pointerHeld = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  document.addEventListener('pointerup', () => { pointerHeld = false; }, true);
  document.addEventListener('pointercancel', () => { pointerHeld = false; }, true);
}
/** 「참고한 서비스」 보기 — 서비스마다 한 줄(이름 굵게) · 맨 아래 「출처」 뒤 이름만 보이는 링크(새 탭). 주소 글자는 링크의 title 에만. */
function refNode(raw: string): HTMLElement {
  const r = refView(raw);
  return el('div', { class: 'v2-studio-ref' },
    r.items.length ? el('ul', {}, ...r.items.map((x) => el('li', {}, x.name ? el('b', { text: x.name }) : null, el('span', { text: x.text })))) : null,
    r.links.length ? el('p', { class: 'src' }, el('span', { class: 'src-k', text: '출처' }),
      ...r.links.map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label, title: l.url }))) : null);
}
/** 기획 카드 보기 · 고치기 — onEdit 을 주면 줄을 눌러 그 자리에서 고친다. */
function cardView(c: StudioCard, onEdit: ((c: StudioCard) => void) | null): HTMLElement {
  const box = el('div', { class: 'v2-studio-card' + (onEdit ? ' edit' : '') }, el('b', { class: 'v2-studio-card-h', text: '기획 카드' + (c.name ? ' · ' + c.name : '') }));
  CARD_ROWS.forEach((r) => {
    const val = r.k === 'can' ? (c.can || []).join(' · ') : String(c[r.k] || '');
    const v = el('span', { class: 'v', text: val || '' }) as HTMLElement;
    //  「참고한 서비스」 는 보기와 고치기가 다르다(원준 2026-10-26 «주소 그냥 하이퍼링크로 … 텍스트 박스 안에서 이쁘게» · «주소 일일이 복붙해야하더라») —
    //   보기는 서비스마다 한 줄 · 출처는 누르면 새 탭으로 여는 링크(refNode). 링크 말고 글을 누르면 원문 그대로 고치고, 나가면 다시 보기.
    const isRef = r.k === 'ref';
    let raw = val;
    const editing = (): boolean => v.getAttribute('contenteditable') === 'true';
    const view = (): void => {
      if (!isRef || !raw) return;
      v.removeAttribute('contenteditable'); v.classList.add('ref'); v.replaceChildren(refNode(raw));
      if (onEdit) { v.setAttribute('role', 'button'); v.setAttribute('aria-label', r.label + ', 누르면 고칠 수 있어요'); }
    };
    if (onEdit) {
      v.setAttribute('contenteditable', 'true'); v.setAttribute('data-placeholder', r.hint); v.setAttribute('aria-label', r.label);
      v.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && editing()) { e.preventDefault(); v.blur(); }
        else if ((e.key === 'Enter' || e.key === ' ') && !editing() && e.target === v) { e.preventDefault(); editRaw(); }   // 보기 상태 — 단추처럼
      });
      //  보기 상태에서 지나가기만 한 것(탭 · 링크 누름)은 고친 게 아니다 — 보기 글로 기록을 덮지 않는다.
      //  보기로 돌아가면 줄이 짧아져 아래가 올라온다 — 다른 단추를 누르는 중(누른 채)이면 뗀 뒤에 바꾼다(그 누름이 빈 데로 새지 않게 · 격리 리뷰).
      v.addEventListener('blur', () => {
        if (!editing()) return;
        const t = String(v.textContent || '').trim(); raw = t; if (r.k === 'can') c.can = splitList(t); else c[r.k] = t; onEdit(c);
        if (!pointerHeld) { view(); return; }
        //  뗀 뒤 — 그사이 다시 눌러 고치는 중이면 그대로 둔다.
        document.addEventListener('pointerup', () => { window.setTimeout(() => { if (document.activeElement !== v) view(); }, 0); }, { once: true, capture: true });
      });
      const editRaw = (): void => { v.classList.remove('ref'); v.removeAttribute('role'); v.setAttribute('aria-label', r.label); v.textContent = raw; v.setAttribute('contenteditable', 'true'); v.focus(); const sel = window.getSelection(); if (sel) { sel.selectAllChildren(v); sel.collapseToEnd(); } };
      if (isRef) {
        v.tabIndex = 0;
        v.addEventListener('click', (e: MouseEvent) => { if ((e.target as HTMLElement).closest('a') || editing()) return; editRaw(); });
      }
    }
    view();
    box.append(el('div', { class: 'row' }, el('span', { class: 'k', text: r.label }), v));
  });
  //  더한 항목(원준 2026-10-26 «섹션 제목과 본문도 원한다면 더 추가해서») — 정해진 줄 뒤에. 고치기 카드에서만 더하고 빼고 고친다.
  const extraRow = (x: CardExtra): HTMLElement => {
    const k = el('span', { class: 'k', text: x.title }), v = el('span', { class: 'v', text: x.body });
    const row = el('div', { class: 'row x' }, k, v);
    if (!onEdit) return row;
    const editable = (n: HTMLElement, hint: string, label: string, save: (t: string) => void, onEnter: () => void): void => {
      n.setAttribute('contenteditable', 'true'); n.setAttribute('data-placeholder', hint); n.setAttribute('aria-label', label);
      n.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); onEnter(); } });
      n.addEventListener('blur', () => { save(String(n.textContent || '').trim()); onEdit(c); });
    };
    editable(k, '항목 이름', '더한 항목 이름', (t) => { x.title = t; }, () => v.focus());
    editable(v, '내용', '더한 항목 내용', (t) => { x.body = t; }, () => v.blur());
    row.append(el('button', { class: 'v2-studio-card-rm', type: 'button', text: '×', title: '이 항목을 빼요', 'aria-label': '항목 빼기',
      onclick: () => { c.extra = (c.extra || []).filter((y) => y !== x); row.remove(); onEdit(c); } }));
    return row;
  };
  (c.extra || []).forEach((x) => box.append(extraRow(x)));
  if (onEdit) {
    const add = el('button', { class: 'v2-studio-card-add', type: 'button', text: '+ 항목 더하기', title: '제목과 내용을 직접 적어 기획에 더해요',
      onclick: () => { const x: CardExtra = { title: '', body: '' }; c.extra = [...(c.extra || []), x]; const row = extraRow(x); box.insertBefore(row, add); (row.querySelector('.k') as HTMLElement).focus(); } });
    box.append(add);
  }
  return box;
}

// ── 단계 바 — 지금 · 돌아가기 · 다시 가기(와 본 곳) · 아직 ─────────────────────────────────────────────
//  원준 2026-10-19 «상단 탭을 클릭하는 방향으로도 적절히 원하는 위치로 이동할 수 있어야» — 지난 단계뿐 아니라 와 본 앞 단계도 눌러서 간다(lib/studio-flow stageTabs).
const CIRC = '① ② ③ ④ ⑤ ⑥'.split(' ');
//  busy — AI 가 고치는 중(③ 수정하기를 보냈다). 그동안 앞 단계로는 못 간다 — ④ 대조를 고침 한가운데 청하게 되고, 고침이 끝난 것을 ③ 이 못 받는다(격리 리뷰).
function paintStageBar(bar: HTMLElement, cur: number, reached: number, mode: 'new' | 'copy' | 'edit', labelOf: (i: number, label: string) => string, onGo: (k: 'what' | StudioStage) => void, busy = false): void {
  const tabs = stageTabs(cur, busy ? cur : reached, mode);
  bar.replaceChildren(...STAGES.map((x, i) => {
    const text = CIRC[x.n - 1] + ' ' + labelOf(i, x.label);
    const st = tabs[i];
    if (st === 'back') return el('button', { type: 'button', class: 'done go', text, title: '이 단계로 돌아가요. 적은 내용은 그대로 남아요.', onclick: () => onGo(x.key) });
    if (st === 'ahead') return el('button', { type: 'button', class: 'go ahead', text, title: '이 단계로 다시 가요. 저장한 내용 그대로예요.', onclick: () => onGo(x.key) });
    return el('span', { class: st === 'on' ? 'on' : st === 'done' ? 'done' : '', text, ...(st === 'on' ? { 'aria-current': 'step' } : {}) });
  }));
}
/** 「다음 →」 — 바로 다음 단계가 와 본 곳일 때만(아직 안 간 단계는 그 단계의 주 단추가 연다). 「← 이전」 과 짝. */
function nextBtnFor(cur: number, reached: number, mode: 'new' | 'copy' | 'edit', onGo: (k: 'what' | StudioStage) => void, busy = false): HTMLElement | null {
  if (busy) return null;   // AI 가 고치는 중 — 위 paintStageBar 의 busy 와 같은 까닭
  const i = nextStageOpen(cur, reached, mode);
  return i < 0 ? null : el('button', { class: 'btn btn-ghost btn-sm v2-studio-next', type: 'button', text: '다음 →', title: '다음 단계로 가요. 저장한 내용 그대로예요.', onclick: () => onGo(STAGES[i].key) });
}

// ── ① 앱 이름과 기능 정하기 — 이름 · 설명(자세할수록 좋다) · 자리 · 누가 어디서 만드나 ──────────────
const DRAFT_KEY = 'lively_v2_app_studio_draft';   // ① 에 적던 것(세션이 생기기 전) — 닫았다 열어도 남는다
function readDraft(): { name: string; what: string; place: StudioPlace } { try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); return { name: String(d.name || ''), what: String(d.what || ''), place: d.place === 'full' || d.place === 'both' ? d.place : 'side' }; } catch (_) { return { name: '', what: '', place: 'side' }; } }
function writeDraft(d: { name: string; what: string; place: StudioPlace } | null): void { try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch (_) { /* noop */ } }
/** ① — prefill 을 주면 이미 세션이 있는 것(뒤로 온 것): 적었던 것을 그대로 보이고, 단계 바 · 「다음 →」 로 와 본 단계에 그대로 다시 간다.
 *  적은 것을 바꿨을 때만 「이 내용으로 다시 기획」 이 눌린다(그 세션에 기획을 다시 청한다). 바꾸던 것은 기록에 남는다(whatEdit). */
function start(prefill?: StudioRec | null): void {
  if (!root) return;
  forgetAiLogins();   // ① 을 새로 열 때마다 내 AI 로그인을 다시 읽는다(방금 연결한 AI 가 바로 잡히게)
  const orig = prefill ? { name: prefill.title || '', what: prefill.what, place: prefill.place } : null;
  const draft = prefill ? (prefill.whatEdit || orig!) : readDraft();
  let place: StudioPlace = draft.place;
  const nameIn = el('input', { class: 'v2-studio-name-field', type: 'text', maxlength: '40', placeholder: '예: 회의록', 'aria-label': '앱 이름' }) as HTMLInputElement;
  const input = el('textarea', { class: 'v2-studio-what', rows: '6', maxlength: '4000', placeholder: DESC_PH, 'aria-label': '어떤 앱인가요' }) as HTMLTextAreaElement;
  nameIn.value = draft.name; input.value = draft.what;
  const go = el('button', { class: 'v2-studio-go', type: 'button', text: prefill ? '이 내용으로 다시 기획' : '만들기 시작' }) as HTMLButtonElement;
  const topName = el('b', { class: 'v2-studio-name', text: draft.name.trim() || (prefill && prefill.card && prefill.card.name) || NEW_APP_NAME });
  const changed = (): boolean => !!orig && (nameIn.value.trim() !== orig.name.trim() || input.value.trim() !== orig.what.trim() || place !== orig.place);
  const sync = (): void => {
    topName.textContent = nameIn.value.trim() || (prefill && prefill.card && prefill.card.name) || NEW_APP_NAME;
    if (!prefill) { go.disabled = !input.value.trim(); writeDraft({ name: nameIn.value, what: input.value, place }); return; }
    //  뒤로 온 ① — 바꾼 게 있어야 다시 기획한다. 바꾸던 것은 기록에(단계를 옮겨 다녀도 그대로) · 되돌려 놓으면 지운다.
    go.disabled = !changed() || !input.value.trim();
    if (changed()) prefill.whatEdit = { name: nameIn.value, what: input.value, place }; else delete prefill.whatEdit;
    saveRec(prefill);
  };
  nameIn.addEventListener('input', sync);
  const cards = (Object.keys(PLACE) as StudioPlace[]).map((k) => {
    const b = el('button', { class: 'v2-studio-place' + (k === place ? ' on' : ''), type: 'button', 'data-place': k },
      placePic(k), el('b', { text: PLACE[k].title }), el('small', { text: PLACE[k].sub }));
    b.onclick = () => { place = k; cards.forEach((c) => c.classList.toggle('on', c === b)); sync(); };
    return b;
  });
  // 누가 어디서 만드나 — 실행 컴퓨터는 사람이 고르고, 모델 · 생각 깊이는 여기서 정해 둔다.
  const nodeSel = el('select', { class: 'v2-studio-node', 'aria-label': '어디서 실행할까요' }) as HTMLSelectElement;
  const nodeNote = el('small', { class: 'v2-studio-ai-note', text: '' });
  const modelChip = el('span', { class: 'v2-studio-ai-fix', text: '확인하는 중…' });   // 내 AI 로그인 · 컴퓨터를 읽고 paintAi 가 채운다(연결 안 한 AI 를 먼저 보여 주지 않게)
  let nodes: Awaited<ReturnType<typeof runNodes>> = [];
  const paintNodes = (): void => {
    const pref = nodeSel.value || sessionDefaults().nodeDefault;
    const opts = nodeOptions(nodes);
    nodeSel.replaceChildren(...opts.map((o) => { const op = el('option', { value: o.v, text: o.t }) as HTMLOptionElement; op.disabled = !!o.off; return op; }));
    nodeSel.value = opts.some((o) => o.v === pref && !o.off) ? pref : '';
    nodeNote.textContent = nodeWhere(nodes, nodeSel.value);
  };
  //  컴퓨터를 바꾸면 그 컴퓨터가 띄울 수 있는 AI 로 칩도 바뀐다 — 늦게 온 답이 나중 고름을 덮지 않게 차례를 센다.
  let aiTurn = 0;
  const paintAi = (): void => {
    const my = ++aiTurn;
    void studioAi(nodes, resolveNodeChoice(nodes, nodeSel.value).id).then((ai) => { if (my === aiTurn && modelChip.isConnected) modelChip.textContent = ai.chip; })
      .catch(() => { if (my === aiTurn) modelChip.textContent = 'AI 설정 그대로'; });   // 칩은 못 그려도 시작은 된다 — «확인하는 중» 에 멈춰 두지 않는다
  };
  nodeSel.onchange = () => { nodeNote.textContent = nodeWhere(nodes, nodeSel.value); paintAi(); };
  void runNodes().then((ns) => { nodes = ns; if (root && nodeSel.isConnected) { paintNodes(); paintAi(); } }).catch(() => { /* 노드 목록이 없으면 자동(중앙)으로 */ });
  paintNodes(); paintAi();
  const studioRun = async (): Promise<RunPick> => {
    const ns = await refreshNodes(0).catch(() => nodes);
    const ch = resolveNodeChoice(ns, nodeSel.value);
    if (ch.fellBack) toast(nodeWhere(ns, nodeSel.value));
    const ai = await studioAi(ns, ch.id);
    const d = sessionDefaults();
    return { harness: ai.harness, flags: ai.flags, node: ch.id, mode: 'normal', autoApprove: d.autoApprove, writeVis: '' };
  };
  const begin = async (): Promise<void> => {
    const what = input.value.trim(), nm = nameIn.value.trim(); if (!what || go.disabled) return;
    go.disabled = true; go.textContent = '준비하는 중…';
    if (prefill) {
      //  뒤로 와서 고친 뒤 — 세션은 그대로, 기획 카드만 다시 청한다. 적은 것은 기록에 남는다.
      const rec = prefill;
      //  먼저 보낸다 — 못 보냈으면 기록을 그대로 둔다(고치던 것은 whatEdit 에 남아 있다 · 격리 리뷰).
      if (!(await sendPrompt(rec, planBrief(what, place, nm)))) { go.disabled = false; go.textContent = '이 내용으로 다시 기획'; return; }
      rec.what = what; rec.place = place; if (nm) { rec.title = nm; rec.named = true; } else { delete rec.title; rec.named = false; }
      //  기획을 다시 받는다 — ④ · ⑤ 는 옛 기획의 것이라 «와 본 곳» 을 당긴다(앱이 이미 있으면 ③ 의 옛 시안은 그대로 볼 수 있다). 넣은 앱이어도(done) 다시 만드는 중이다.
      //   청한 카드를 빈 글로 두어, 새 카드가 오면 ② 에 「바꾼 기획대로 다시 만들기」 가 선다(옛 시안으로 그냥 넘어가지 않게).
      rec.card = null; rec.stage = 'plan'; rec.reached = 1; rec.done = false; rec.cardSent = ''; delete rec.whatEdit; delete rec.check; saveRec(rec);
      void relabel(rec.sid, nm, 'new');
      void build(rec); return;
    }
    const known = (await listApps()).map((a) => String(a.id));   // 이 뒤에 새로 생기는 앱이 «내가 만들고 있는 앱»
    const pid = await studioProject();
    const run = await studioRun();
    //  이름은 만들 때 같이 싣는다 — 서버가 사람 이름으로 박아 AI 가 제 이름(「회의록 기획카드」 같은)으로 덮지 못한다(원준 2026-10-15).
    const s = await spawnSession(planBrief(what, place, nm), { ...(pid > 0 ? { projectId: pid } : { projectName: PROJECT_NAME }), run, label: builderSessionLabel(nm, 'new') });
    if (!s) { go.disabled = false; go.textContent = '만들기 시작'; return; }
    const rec: StudioRec = { sid: s.id, pid, what, place, appId: '', known, at: Date.now(), stage: 'plan', card: null, round: 0, from: 0, mode: 'new', ...(nm ? { title: nm, named: true } : {}) };
    saveRec(rec); writeDraft(null);   // 세션 이름은 위에서 같이 실었다 — «"이름" 앱 제작» · 이름을 비웠으면 «새 앱 제작» → 기획 카드가 오면 그 이름으로
    //  #4667 초안 앱을 지금 만든다(나만 보는 빈 앱 · 만든 사람 = 나 · 만들기 세션 = 이 세션). AI 는 이 id 로 저장한다(시안 글에 실린다).
    //   못 만들면 종전처럼 «새로 생긴 앱» 을 찾는다(예약 없는 길).
    try { const r: any = await api('/api/ui/apps/build-start', { method: 'POST', body: JSON.stringify({ session_id: s.id, title: nm || firstLine(what) }) }); if (r && r.app_id) { rec.draftId = String(r.app_id); saveRec(rec); } }
    catch (_) { /* 예약 없이 간다 */ }
    if (mountOpts.onSession) mountOpts.onSession(s.id);
    void build(rec);
  };
  go.onclick = () => { void begin(); };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void begin(); } });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.focus(); } });
  const help = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '?', title: '안내 다시 보기', 'aria-label': '안내' });
  help.onclick = () => helpMenu(help, () => showIntro(() => input.focus(), () => showTour(() => input.focus())), () => showTour(() => input.focus()));
  //  뒤로 온 ① 에서 와 본 단계로 — 적은 것을 바꾼 채여도 그대로 간다(바꾸던 것은 whatEdit 에 남아 ①로 돌아오면 다시 보인다).
  const goStage = (k: 'what' | StudioStage): void => {
    if (!prefill || k === 'what') return;
    prefill.stage = k === 'fix' && !prefill.appId ? 'draft' : k; saveRec(prefill); void build(prefill);
  };
  const bar = el('div', { class: 'v2-studio-bar' });
  const reached = prefill ? reachedOf(prefill) : 0;
  paintStageBar(bar, 0, reached, prefill ? prefill.mode : 'new', (_i, label) => label, goStage);
  const next = prefill ? nextBtnFor(0, reached, prefill.mode, goStage) : null;
  root.replaceChildren(
    el('div', { class: 'v2-studio-top' },
      crumb(), topName,
      el('span', { class: 'v2-studio-sp' }), help,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => closeAppStudio() })),
    bar,
    ...(next ? [el('div', { class: 'v2-studio-now' }, next, el('span', { class: 'v2-studio-now-t', text: '적은 내용을 바꾸면 「이 내용으로 다시 기획」으로 기획 카드를 다시 받아요.' }))] : []),
    el('div', { class: 'v2-studio-start' },
      el('h2', { text: '앱의 이름과 기능을 정해주세요.' }),
      el('label', { class: 'v2-studio-lab' }, el('span', { text: '앱 이름' }), el('small', { text: '비워 두면 AI가 지어요. 나중에 바꿀 수 있어요.' })),
      nameIn,
      el('label', { class: 'v2-studio-lab' }, el('span', { text: '어떤 앱인가요?' }), el('small', { text: '자세할수록 좋아요' })),
      input,
      el('h3', { text: '어디에서 쓰는 앱인가요?' }),
      el('p', { class: 'v2-studio-fine', text: '고른 자리에 맞춰 화면 크기와 여는 방법이 정해져요.' }),
      el('div', { class: 'v2-studio-places' }, ...cards),
      el('div', { class: 'v2-studio-ai' },
        el('div', { class: 'v2-studio-ai-h' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text: '이 앱은 AI가 만들어요' })),
        el('p', { text: prefill ? '적은 내용을 바꾸고 「이 내용으로 다시 기획」을 누르면 AI가 기획 카드를 다시 써요. 바꾸지 않았으면 「다음 단계로」로 그대로 이어가요.' : '「만들기 시작」을 누르면 AI 세션이 하나 열려서 이를 바탕으로 더 궁금한 점을 물어볼거예요.' }),
        el('div', { class: 'v2-studio-ai-row' }, el('span', { class: 'k', text: '어디서 실행할까요' }), nodeSel, nodeNote),
        el('div', { class: 'v2-studio-ai-row' }, el('span', { class: 'k', text: '모델 · 생각 깊이' }), modelChip, el('small', { class: 'v2-studio-ai-note', text: '앱 만들기에 맞게 정해 두었어요' }), el('span', { class: 'v2-studio-sp' }),
          //  뒤로 온 ① — 아래 단추 자리에도 「다음 단계로」(원준 2026-10-19 «밑에 이 내용으로 다시 기획 이거밖에 없어서 어색해»). 위 「다음 →」 과 같은 길.
          ...(next ? [el('button', { class: 'btn btn-ghost', type: 'button', text: '다음 단계로', title: '바꾸지 않고 다음 단계로 가요. 저장한 내용 그대로예요.', onclick: () => goStage(STAGES[nextStageOpen(0, reached, prefill!.mode)].key) })] : []), go))));
  go.disabled = prefill ? !changed() || !input.value.trim() : !input.value.trim();   // 적어 둔 것이 있으면 바로 갈 수 있다(쓰기 전엔 draft 를 건드리지 않는다) · 뒤로 온 ① 은 바꿔야 다시 기획
  // ① 엔 말풍선을 띄우지 않는다 — 칸 이름과 안내글로 충분하다(원준 2026-10-14).
  const focusName = (): void => { nameIn.focus(); };
  if (!prefill && !readSeen().intro) showIntro(focusName, () => showTour(focusName));
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

// ── ②~⑤ 만드는 화면 — 머리줄 · 단계 바 · 지금 할 일 · 가운데(기획 카드 · 시안 허브 · 점검표 · 마무리) · AI 세션(접힘 → 떠 있는 창 → 오른쪽에 붙임) ──
//  ③ 시안 확인 · 고치기(원준 2026-10-14 «생성된 시안과 고치기는 하나의 과정 · 대충 구현한 앱 화면/세션 위젯 말고 진짜 리얼 뷰 · 사이드바 그대로 · 그 위에 코멘트만»):
//   여기엔 앱을 띄우지 않는다. 가운데 단추가 실제 화면으로 보내고 그 위에 코멘트 층(app-review.ts)이 선다 — 세션 위젯 = **시험 세션**(app-try-session.ts:
//   앱을 만드는 세션과 다른 진짜 AI 세션 · 진짜 세션 화면 · 우측 사이드바에 앱 · 사람이 쳐서 써 본다), 앱 화면 = #/i/<앱>.
//   앱을 앱빌딩 세션에 붙이지 않는다(원준 2026-10-15 «시연 중이잖아 · 앱을 수정하는 세션이 들어가면 안 되지» — 붙여 두면 앱이 보낸 글이 만드는 대화에 섞였다).
async function build(rec: StudioRec): Promise<void> {
  if (!root) return;
  if (teardown) { teardown(); teardown = null; }
  const S = { dead: false, chat: null as SessionChatHandle | null, title: rec.title || (rec.card && rec.card.name) || rec.what, curVer: 0, prevVer: 0, pollT: 0, logT: 0,
    pins: (rec.pins || []) as StudioPin[], general: rec.general || '', step: rec.step || 0, check: null as { have: string[]; missing: string[] } | null, checkWait: false,
    waiting: !!rec.fixing, waitT0: rec.fixing ? rec.fixing.at : 0, topVer: 0, tick: 0, checkFor: null as { ver: number; card: string } | null, chatMode: 'off' as 'off' | 'float' | 'dock', review: null as ReviewApi | null, tryS: null as TrySession | null, lastNote: '', vis: null as StudioVis | null, board: null as { close(): void } | null,
    stall: null as RunStall | null, stallNode: '', stallT0: 0, runT: 0, limit: '',   // limit: AI 답 글이 알린 사용 한도(parseLimit 의 한 줄) — 새로 보내면 걷는다
    iconOpen: false, iconWait: false, iconMiss: false, iconT: 0, iconRead: false, iconFail: false,   // ④ 아이콘 — 고르는 칸이 펼쳐졌나 · AI 가 그리는 중 · 안 보냈다 · 지금 아이콘을 읽었나 · 못 읽었나
    colorOpen: false, cpick: null as Hsv | null, hexBad: false,   // ④ 「다른 색」 — 팔레트가 펼쳐졌나 · 손잡이 자리(다시 그려도 그대로) · 적은 색 코드가 틀렸나
    //  막 연 만들기(세션이 뜨는 중) — 2분 동안은 멈췄다 하지 않는다 · 막 보낸 고침도 보낸 때부터 60초(armRun 과 같은 틈)
    quietTill: Math.max(Date.now() - rec.at < 120000 ? rec.at + 120000 : 0, rec.fixing ? rec.fixing.at + 60000 : 0) };
  const name = el('b', { class: 'v2-studio-name', text: S.title || NEW_APP_NAME });
  const ver = el('span', { class: 'v2-studio-ver', text: '' });
  const undo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이전 버전으로', hidden: true }) as HTMLButtonElement;
  //  #4667 「공개하기」 — 공개한 앱을 고쳐 생긴 내 초안을 모두에게 내보낼 때, 또는 ⑤ 에서 「나만」 으로 둔 앱을 나중에 공개할 때. 새 앱의 첫 공개는 ④ 「누가 쓰나」 → 「이대로 넣기」 가 한다.
  const pubBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '공개하기', hidden: true }) as HTMLButtonElement;
  const help = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '?', title: '안내 다시 보기', 'aria-label': '안내' });
  const bar = el('div', { class: 'v2-studio-bar' });
  const now = el('div', { class: 'v2-studio-now' });
  const band = el('div', { class: 'v2-studio-band', hidden: true });
  // AI 세션(앱을 만드는 대화)은 기본으로 접어 둔다 — 단추가 보낸 글과 AI 의 표식 답은 화면이 카드 · 걸음 · 새 판으로 보여 준다.
  //  보고 싶으면 머리줄 단추로 떠 있는 창을 열고, 그 창을 끌어 오른쪽 끝에 놓으면 오른쪽 칸에 붙는다(원준 2026-10-14). 안은 **기본 터미널 보기**(원준: «베타인 대화 뷰 말고 기본 터미널 뷰»).
  const chatBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'AI 세션 보기' }) as HTMLButtonElement;
  chatBtn.onclick = () => { S.chatMode = S.chatMode === 'off' ? 'float' : 'off'; applyPlace(); };
  const tray = el('div', { class: 'v2-studio-tray', hidden: true });   // ③ 보낼 의견 — 허브 안 한 칸(실제 화면의 막대와 같은 것을 본다)
  const appBox = el('div', { class: 'v2-studio-app v2-studio-app--full' });   // 가운데 칸 — 단계마다 카드 · 허브 · 점검표 · 마무리
  const stage = el('div', { class: 'v2-studio-stage' }, appBox);
  const chatHost = el('div', { class: 'v2-studio-chat' });
  const sideHead = el('div', { class: 'v2-studio-side-head' }, el('b', { text: 'AI 세션' }), el('small', { text: '이 앱을 만드는 대화' }), el('span', { class: 'v2-studio-sp' }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '떼어 내기', onclick: () => { S.chatMode = 'float'; applyPlace(); } }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => { S.chatMode = 'off'; applyPlace(); } }));
  const side = el('div', { class: 'v2-studio-side' }, sideHead, chatHost);
  const winHead = el('div', { class: 'v2-studio-chatwin-head', title: '끌어서 옮길 수 있어요. 오른쪽 끝에 놓으면 붙어요.' }, el('b', { text: 'AI 세션' }), el('small', { text: '끌어서 오른쪽 끝에 놓으면 붙어요' }), el('span', { class: 'v2-studio-sp' }),
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
  const paintBar = (): void => {
    //  지난 단계는 눌러서 돌아가고(원준 2026-10-14 «뒤로 가는 게 너무 없다»), 와 본 앞 단계는 눌러서 다시 간다(원준 2026-10-19) — 적은 것은 기록에 있으니 날아가지 않는다.
    paintStageBar(bar, stageIndex(rec.stage), reachedOf(rec), rec.mode, (i, label) => {
      let t = label;
      if (rec.mode !== 'new' && i < 3) t = i === 0 ? '앱 이름과 기능(원본)' : i === 1 ? '세부 기획(물려받음)' : '원본 시안 확인 · 수정';
      if (STAGES[i].key === 'fix' && rec.round > 0) t += ' · ' + (rec.round + (rec.stage === 'fix' && !S.waiting ? 1 : 0)) + '번째';
      return t;
    }, (k) => { void goTo(k); }, S.waiting);
  };
  /** 한 단계 뒤 — ①로 가면 세션은 두고 적었던 것을 다시 보인다. 없으면 null(① 이거나 고치기 흐름의 ①~③). */
  /** 멈춘 AI 일을 화면 모든 자리(막대 · 띠 · 허브 · 실제 화면의 코멘트 막대)가 같은 말로 — 멈추지 않았으면 null.
   *  원준 2026-10-28 «중간에 안됐는데 수정중 하면서 시간 세고있으면 어떡해» — 막대만 멈췄다 하고 띠는 «AI 수정 중 11:06» 을 세고 있었다. */
  const stallInfo = (): { text: string; short: string; go: string; resume: boolean } | null => {
    const kind = runKind(); if (!S.stall || !kind) return null;
    const go = kind === 'fix' ? '이어서 수정하기' : '이어서 만들기';
    if (S.stall === 'ask') return { text: 'AI가 확인을 기다리고 있어요. 「AI 세션 보기」를 눌러 답해주세요.', short: 'AI가 확인을 기다려요', go, resume: false };
    if (S.stall === 'offline') return { text: '세션이 돌던 컴퓨터' + (S.stallNode ? '(' + S.stallNode + ')' : '') + '가 꺼져 있거나 잠들어 있어서 AI가 멈췄어요. 그 컴퓨터를 켜면 이어서 할 수 있어요.', short: 'AI가 멈췄어요', go, resume: false };
    if (S.stall === 'ended') return { text: '세션이 꺼져서 AI가 멈췄어요. 「' + go + '」를 누르면 세션을 다시 켜고 멈춘 곳부터 해요.', short: 'AI가 멈췄어요', go, resume: true };
    if (S.stall === 'limit') return { text: (S.limit || 'AI 사용 한도에 걸려 멈췄어요.') + ' 풀린 뒤 「' + go + '」를 누르면 멈춘 곳부터 해요.', short: 'AI 사용 한도로 멈췄어요', go, resume: true };
    return { text: 'AI가 끝내지 못하고 멈췄어요. 「' + go + '」를 누르면 멈춘 곳부터 다시 해요.', short: 'AI가 멈췄어요', go, resume: true };
  };
  const prevOf = (): 'what' | StudioStage | null => {
    if (rec.stage === 'plan') return rec.mode === 'new' ? 'what' : null;
    if (rec.stage === 'draft' || rec.stage === 'fix') return rec.mode === 'new' ? 'plan' : null;
    if (rec.stage === 'check') return 'fix';
    return 'check';
  };
  const goTo = async (k: 'what' | StudioStage): Promise<void> => {
    rec.pins = S.pins; rec.general = S.general; saveRec(rec);
    if (k === 'what') { if (teardown) { teardown(); teardown = null; } closeCoach(); start(rec); return; }   // ①로 — 열린 안내는 닫는다(다시 와도 또 서지 않게)
    await setStage(k === 'fix' && !rec.appId ? 'draft' : k);
  };
  const nowBtn = (text: string, pri: boolean, run: () => void, disabled = false): HTMLButtonElement => { const b = el('button', { class: pri ? 'v2-studio-now-pri' : 'btn btn-ghost btn-sm', type: 'button', text, onclick: run }) as HTMLButtonElement; b.disabled = disabled; return b; };
  const cmCount = (): number => S.pins.filter((p) => p.note.trim()).length + (S.general.trim() ? 1 : 0);
  const paintNow = (): void => {
    const kids: Array<HTMLElement | null> = []; let text = '';
    const hasCm = cmCount() > 0;
    if (rec.stage === 'plan') {
      text = rec.card ? '기획 카드에서 틀린 내용을 고쳐주세요' : 'AI가 기획 카드를 쓰는 중이에요';
      //  이미 이 기획으로 시안을 청했다(와 본 곳이 ③ 이상) — 카드를 안 고쳤으면 「다음 →」 로 그대로 간다(다시 만들지 않는다).
      //   고쳤으면 「바꾼 기획대로 다시 만들기」(앱이 있으면 새 버전 · 아직 첫 판 전이면 초안을 다시 청한다).
      if (reachedOf(rec) < 2) kids.push(nowBtn('완료 · 다음 단계로', true, () => { void toDraft(); }, !rec.card));
      else if (rec.card && rec.cardSent != null && cardText(rec.card) !== rec.cardSent) kids.push(nowBtn('바꾼 기획대로 다시 만들기', true, () => { void remake(); }, S.waiting));
    }
    else if (rec.stage === 'draft' || rec.stage === 'fix') {
      if (!rec.appId) text = 'AI가 초안을 만들고 있어요(' + (S.step ? DRAFT_STEPS[S.step - 1] : '시작하는 중') + '). 몇 분 걸려요.';
      else if (S.waiting) text = 'AI가 수정하고 있어요. 다음 버전이 나오면 화면이 바뀌어요.';
      else if (hasCm) { text = '코멘트 ' + cmCount() + '건을 남겼어요. 「수정하기」를 누르면 AI가 반영해 다음 버전을 만들어요.'; kids.push(nowBtn('완료 · 다음 단계로', false, () => { void setStage('check'); }), nowBtn('수정하기 · ' + cmCount() + '건', true, () => { void sendFix(); })); }
      else { text = '가상 화면에서 실제로 어떻게 동작하는지 테스트해 보고, 고칠 곳에 코멘트를 남겨주세요.'; kids.push(nowBtn('완료 · 다음 단계로', rec.round >= 1, () => { void setStage('check'); })); }
    } else if (rec.stage === 'check') { text = '아래 다섯 가지가 맞는지 확인해주세요.'; kids.push(nowBtn('더 고치기', false, () => { void setStage('fix'); }), nowBtn('완료 · 다음 단계로', true, () => { void putApp(); }, S.check != null && S.check.missing.length > 0)); }
    else if (rec.stage === 'put') { text = (S.vis && S.vis.visibility === 'me' ? '앱이 만들어졌어요. 지금은 나만 볼 수 있어요.' : S.vis && S.vis.draftMine ? '이 버전은 비공개로 두었어요. 다른 사람은 공개 버전을 써요.' : '워크스페이스 앱이 됐어요.') + ' 「지금 써 보기」로 바로 열어 보세요.'; }
    const st = stallInfo();
    if (st) {   // 기다리던 AI 일이 멈췄다 — «만들고 있어요» 대신 까닭과 할 일(원준 2026-10-26)
      kids.length = 0; text = st.text;
      if (S.stall === 'ask') kids.push(nowBtn('AI 세션 보기', true, () => { S.chatMode = 'float'; applyPlace(); }));
      else kids.push(nowBtn(st.go, true, () => { void resumeRun(); }, !st.resume));
    }
    const prev = prevOf();
    const next = nextBtnFor(stageIndex(rec.stage), reachedOf(rec), rec.mode, (k) => { void goTo(k); }, S.waiting);
    now.replaceChildren(...(prev ? [el('button', { class: 'btn btn-ghost btn-sm v2-studio-back', type: 'button', text: '← 이전', title: '이전 단계로 돌아가요. 적은 내용은 그대로 남아요.', onclick: () => { void goTo(prev); } })] : []),
      ...(next ? [next] : []),
      el('span', { class: 'v2-studio-now-t', text }), el('span', { class: 'v2-studio-sp' }), ...kids.filter(Boolean) as HTMLElement[]);
    rec.pins = S.pins; rec.general = S.general; saveRec(rec);   // 적던 의견은 늘 기록에(뒤로 가도 · 닫아도 그대로)
    syncFixIn();
  };
  /** 허브 글 속 「수정하기」 단추를 막대의 단추와 맞춘다 — 의견이 있어야 눌리고(「수정하기 · n건」), 고치는 중엔 잠긴다. 뒤 조사도 글에 맞춘다(수정하기를 · n건을). */
  const syncFixIn = (): void => {
    const n = cmCount();
    appBox.querySelectorAll('.v2-studio-fix-in').forEach((b0: Element) => { const b = b0 as HTMLButtonElement;
      b.textContent = '수정하기' + (n ? ' · ' + n + '건' : ''); b.disabled = S.waiting || n === 0;
      b.title = S.waiting ? 'AI가 수정하고 있어요' : n ? '코멘트 ' + n + '건을 AI에게 보내요' : '코멘트를 남기면 누를 수 있어요';
      const j = b.nextElementSibling; if (j && j.classList.contains('v2-studio-fix-j')) j.textContent = n ? '을' : '를';
    });
  };
  const paintVer = async (): Promise<void> => {
    if (!rec.appId) return;
    try {
      const vs = await fetchAppVersions(rec.appId); if (S.dead) return;
      const cur = vs.find((v) => v.is_current) || vs[vs.length - 1];
      S.curVer = cur ? cur.version_no : 0;
      S.topVer = vs.reduce((m, v) => Math.max(m, v.version_no), 0);
      S.prevVer = vs.map((v) => v.version_no).filter((n) => n < S.curVer).sort((a, b) => b - a)[0] || 0;
      ver.textContent = verName(S.curVer);
      undo.hidden = !S.prevVer || rec.stage === 'put'; undo.textContent = S.prevVer ? verJ(S.prevVer, '으로') + ' 되돌리기' : '이전 버전으로';
      S.vis = await readVis(rec.appId); if (S.dead) return;
      paintVis();
    } catch (_) { /* 판 이력을 못 읽어도 만들기는 간다 */ }
  };
  //  #4667 머리줄의 판 글 — 「n판 · 나만 보는 초안」(공개 전) · 「n판 · 초안 · 공개 판은 m판」(공개한 앱을 내가 고침) · 「n판 · 공개됨」.
  const paintVis = (): void => {
    const v = S.vis;
    const state = !v ? '' : v.visibility === 'me' ? '비공개' : v.draftMine ? '비공개 · 공개 버전은 ' + verName(v.publishedNo) : '공개됨';
    ver.textContent = verName(S.curVer) + (state ? (S.curVer ? ' · ' : '') + state : '');
    ver.title = !v ? '' : v.visibility === 'me' ? '나만 볼 수 있어요' : v.draftMine ? '이 버전은 나만 볼 수 있어요. 다른 사람은 ' + verJ(v.publishedNo, '을') + ' 써요.' : '워크스페이스 모두가 이 버전을 써요';
    pubBtn.hidden = !v || !v.canPublish || !(v.draftMine || (v.visibility === 'me' && !!rec.done));
  };
  pubBtn.onclick = async () => {
    if (!rec.appId || pubBtn.disabled) return;
    pubBtn.disabled = true;
    try {
      if (!(await confirmPublish(rec.appId, { title: S.title }))) { pubBtn.disabled = false; return; }
      const out: any = await api('/api/ui/apps/' + encodeURIComponent(rec.appId) + '/visibility', { method: 'POST', body: JSON.stringify({ visibility: 'all' }) });
      const n = Number(out && out.version_no) || S.curVer;
      toast(verJ(n, '을') + ' 공개했어요. 이어서 수정하면 ' + verJ(n + 1, '은') + ' 다시 비공개로 시작해요.');
      S.vis = await readVis(rec.appId); paintVis();
      if (rec.stage === 'put') paintPut();
      paintNow();
    } catch (e: any) { toast('공개하지 못했어요. ' + (e && e.message ? e.message : e), true); }
    pubBtn.disabled = false;
  };
  // AI 세션 자리 — 접힘(기본) · 떠 있는 창 · 오른쪽 칸
  const applyPlace = (): void => {
    const inSide = S.chatMode === 'dock';
    const host = inSide ? side : S.chatMode === 'float' ? winBody : null;
    if (host && chatHost.parentElement !== host) host.append(chatHost);
    body.classList.toggle('v2-studio-body--solo', !inSide);
    chatWin.hidden = S.chatMode !== 'float';
    chatBtn.textContent = S.chatMode === 'off' ? 'AI 세션 보기' : 'AI 세션 닫기';
  };
  const appHost = (): HTMLElement => { const h0 = appBox.querySelector('.v2-studio-app-body') as HTMLElement | null; if (h0) return h0; const h = el('div', { class: 'v2-studio-app-body' }); appBox.replaceChildren(h); return h; };
  const waiting = (title: string, sub: string, steps?: HTMLElement, still = false): void => {
    appHost().replaceChildren(el('div', { class: 'v2-studio-wait' + (still ? ' v2-studio-wait--still' : '') }, ...(still ? [] : [el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' })]), el('b', { text: title }), ...(steps ? [steps] : []), ...sub.split('\n').map((t) => el('p', { text: t }))));
  };

  // ── ③ 실제 화면으로 — 코멘트 층과 함께 시험 세션(세션 위젯) · 앱 화면(#/i)으로 ──
  const dropTry = (): void => { if (S.tryS) { S.tryS.destroy(); S.tryS = null; } };
  const backToBuilder = (): void => {
    markReviewOpen(null);   // 앱빌더로 돌아왔다 — 새로고침해도 이 화면(허브)으로
    closeReview(); S.review = null; dropTry();
    if (root) root.hidden = false;
    if (mountOpts.onSee) mountOpts.onSee(rec.sid, null);   // 앱빌더 화면(허브)으로 — 앱빌더 사이드바가 돌아온다
    if (mountOpts.host && !/^#\/builder(\/|\?|$)/.test(location.hash)) location.hash = builderRoute('resume', rec.sid);
  };
  let opening = false;   // 앱 화면을 마련하는 동안 두 번 눌러도 한 번만 간다
  const openReal = async (view: 'widget' | 'app'): Promise<void> => {
    if (!rec.appId || S.waiting || opening) return;
    opening = true;
    try { await openRealNow(view); } finally { opening = false; }
  };
  const openRealNow = async (view: 'widget' | 'app'): Promise<void> => {
    rec.view = view; saveRec(rec);
    let route = location.hash;
    //  먼저 걷는다 — 열린 코멘트 층이 있으면 openReview 가 그것을 닫으며 onClose(dropTry)를 부르는데, 그때면 이 아래에서 막 세운 시험 세션 화면이 걷힌다.
    closeReview(); S.review = null; dropTry();
    let talked = false;
    if (view === 'widget') {
      //  세션 위젯 = **시험 세션**(앱을 만드는 세션과 다른 진짜 AI 세션 · 목록엔 안 선다)의 우측 사이드바 — 이 자리 · 이 주소에 진짜 세션 화면이 선다
      //   (앱빌더 화면만 비킨다). 처음이면 세션을 띄우고 앱을 붙인다(몇 초 · 동의를 거절하면 조용히 멈춘다).
      const pid = await studioProject().catch(() => 0);
      if (S.dead) return;
      if (!pid) { toast('앱빌더 프로젝트를 찾지 못했어요. 잠시 후 다시 시도해주세요.', true); return; }
      if (!rec.trySid) toast('시안을 여는 중이에요. 처음엔 몇 초 걸려요.');
      //  세션 id 는 정해지는 즉시 기록한다 — 붙이기가 실패하거나 그 사이 화면을 떠나도 다음에 같은 세션을 쓴다(숨긴 세션이라 사람은 못 찾는다).
      const keep = (sid: string): void => { if (rec.trySid !== sid) { rec.trySid = sid; saveRec(rec); } };
      const sid = await ensureTrySession({ appId: rec.appId, title: S.title, projectId: pid, prevSid: rec.trySid, onSpawned: keep });
      if (!sid || S.dead) return;
      S.tryS = mountTrySession(mountOpts.host || document.body, { appId: rec.appId, sid, projectId: pid, onResumed: keep });
    }
    if (view === 'app') {
      //  앱 화면 = 앱 찾기가 여는 것과 같은 앱 인스턴스 탭(#/i/<인스턴스>, app-instance openInstalledApp 과 같은 길). 한 번 연 것은 다시 쓴다.
      try {
        let inst = rec.instId ? await getAppInstance(rec.instId).catch(() => null) : null;
        if (!inst) { inst = await createAppInstance(rec.appId, { projectId: null, title: S.title }); rec.instId = inst.id; saveRec(rec); }
        route = '#/i/' + encodeURIComponent(inst.id);
      } catch (e: any) { toast('앱 화면을 열지 못했어요. ' + (e && e.message ? e.message : e), true); return; }
      if (S.dead) return;
    }
    if (root && (S.tryS || !mountOpts.host)) root.hidden = true;   // 시험 세션 화면이 이 자리에 섰거나 창 전체를 덮는 꼴이면 비킨다 — 실제 화면이 보여야 한다
    S.review = openReview({
      appId: rec.appId, title: S.title, route, dock: S.tryS ? S.tryS.dock : undefined,
      pins: S.pins, general: S.general, version: S.curVer, waiting: S.waiting, stall: reviewStall(),
      onResume: () => { void resumeRun(); },
      //  「AI에게 말하기」 — 이 앱을 만드는 AI 세션 화면을 막대의 대화 칸에 빌려준다(원준 2026-10-28 «대화형으로 수정»). 이 화면을 연 뒤 첫 말에만 대화 방식을 붙인다.
      chat: chatHost,
      onTalk: async (text) => { const ok = await send(talkBrief(text, rec.appId, rec.place, !talked)); if (ok) talked = true; return ok; },
      onChange: (p) => { S.pins = p.pins; S.general = p.general; rec.pins = S.pins; rec.general = S.general; saveRec(rec); paintTray(); paintNow(); },
      onSend: () => { void sendFix(); },
      onLike: () => { backToBuilder(); void setStage('check'); },
      onBack: () => { backToBuilder(); },
      onClose: () => { S.review = null; dropTry(); if (root) root.hidden = false; markReviewOpen(null); if (mountOpts.onSee) mountOpts.onSee(rec.sid, null); },   // 막대가 걷혔다(돌아옴 · 다른 데로 · 창 닫힘) — 새로고침으로는 안 불린다
    });
    //  이 자리에 만들고 있는 앱의 실제 화면(시험 세션)이 섰다 — 그 화면의 주인은 그 앱이라 앱빌더 사이드바를 접는다(원준 2026-10-19 «안그렇게 해줘»).
    //   ⚠ 막대를 연 **뒤에** 적는다 — openReview 가 제 주소(route)로 맞추며 이 표시를 지운다.
    if (S.tryS && mountOpts.onSee) mountOpts.onSee(rec.sid, 'widget');
    //  이 화면을 보는 중이라고 적어 둔다 — 새로고침하면 앱빌더가 같은 화면 · 막대로 다시 연다(v2/review-resume.ts).
    markReviewOpen({ sid: rec.sid, appId: rec.appId, view, route });
  };
  // 보낼 의견 — 짚은 곳마다 한 줄 · 앱 전체 한 칸(실제 화면의 막대 「의견 n건」 과 같은 것)
  const paintTray = (): void => {
    if (rec.stage !== 'fix' || !rec.appId) { tray.hidden = true; return; }
    tray.hidden = false;
    const rows = S.pins.map((p, i) => {
      const inp = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 코멘트' }) as HTMLInputElement; inp.value = p.note;
      inp.addEventListener('input', () => { p.note = inp.value; paintNow(); if (S.review) S.review.update({}); });
      const wire = p.on === 'wire';
      return el('div', { class: 'v2-studio-tray-row' }, wire ? el('button', { type: 'button', class: 'n', text: String(i + 1), title: '와이어프레임에서 그 자리 보기', onclick: () => { void openWireframe(i); } }) : el('span', { class: 'n', text: String(i + 1) }),
        el('span', { class: 'w', text: (wire ? '와이어프레임 · ' : '') + (p.kind === 'pick' ? '요소 ' : p.kind === 'box' ? '영역 ' : '핀 ') + (p.where || '') }), inp,
        el('button', { type: 'button', class: 'x', text: '✕', title: '이 코멘트 지우기', onclick: () => { S.pins.splice(i, 1); rec.pins = S.pins; saveRec(rec); paintTray(); paintNow(); if (S.review) S.review.update({ pins: S.pins }); } }));
    });
    const g = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '앱 전체 코멘트 · 예: 글자 조금 크게', 'aria-label': '앱 전체 코멘트' }) as HTMLInputElement; g.value = S.general;
    g.addEventListener('input', () => { S.general = g.value; paintNow(); if (S.review) S.review.update({ general: S.general }); });
    tray.replaceChildren(el('div', { class: 'v2-studio-tray-h' }, el('b', { text: '코멘트' + (cmCount() ? ' · ' + cmCount() + '건' : '') }), el('span', { class: 'v2-studio-sp' }), el('small', { text: S.pins.length ? '실제 화면에서 번호를 누르면 그 자리를 보여줘요.' : '실제 화면에서 선택 · 핀 · 영역으로 코멘트를 남기면 여기 모여요 · 앱 전체에 주는 코멘트는 바로 적어도 돼요' })),
      el('div', { class: 'v2-studio-tray-list' }, el('div', { class: 'v2-studio-tray-row all' }, el('span', { class: 'w', text: '앱 전체' }), g), ...rows));   // 앱 전체 칸은 머리 바로 아래(원준 2026-10-15)
  };
  // ③ 허브 — 판 · 가운데 단추(실제 화면으로) · 보낼 의견
  // ── 와이어프레임(화면 흐름) 보기 — 화면 전체 보드(v2/wire-board.ts · 원준 2026-10-16 «전체화면 · 피그마 보드처럼 · 여기서도 선택 · 핀 · 영역»).
  //   AI 가 앱과 함께 저장한 그림(lib/studio-flow WIREFRAME_PATH)을 놓는다. 그림이 아직 없는 앱은 앱 화면 그대로를 한 장으로(«한 장만 나와도 그냥 있는 거지») —
  //   「그려 달라기」 단추는 걷었다. 다음 「수정하기」 가 그 그림을 함께 그리게 한다(fixBrief). 보드에서 단 코멘트는 on:'wire' 로 같은 목록에 모인다.
  const openWireframe = async (focus?: number): Promise<void> => {
    if (!rec.appId || !root) return;
    let html = '';
    try {
      const d: any = await api('/api/ui/apps/' + encodeURIComponent(rec.appId) + '/pull');
      const f = (Array.isArray(d && d.files) ? d.files : []).find((x: any) => x && x.path === WIREFRAME_PATH);
      html = f && typeof f.content === 'string' ? f.content : '';
    } catch (e: any) { toast('와이어프레임을 읽지 못했어요. ' + (e && e.message ? e.message : e), true); return; }
    if (S.dead) return;
    const { openWireBoard } = await import('./wire-board.js');
    if (S.dead) return;
    S.board = openWireBoard({ appId: rec.appId, title: S.title, version: verName(S.curVer), place: rec.place, html, focus,
      pins: () => S.pins,
      onPins: (ps) => { if (S.dead) return; S.pins = ps; rec.pins = ps; saveRec(rec); paintTray(); paintNow(); if (S.review) S.review.update({ pins: S.pins }); },
      onClose: () => { S.board = null; } });
  };
  const paintHub = (): void => {
    const h = appHost();
    const views: Array<['widget' | 'app', string, string]> = [];
    if (rec.place !== 'full') views.push(['widget', '세션 위젯으로 보기', 'AI 세션의 우측 사이드바에 붙은 모습']);
    if (rec.place !== 'side') views.push(['app', '앱 화면으로 보기', '실제 앱의 사용 화면과 동일한 화면']);
    const first = views.findIndex((v) => v[0] === rec.view); if (first > 0) views.unshift(...views.splice(first, 1));   // 지난번에 본 꼴을 앞에
    //  단추마다 ① 「어디에서 쓰나」 의 그림을 작게(원준 2026-10-16 «맨 처음 페이지에서 그림 있었던 거 참고해서 · 적당히 예쁘게 · 이전처럼 크지 않더라도»).
    const go = el('div', { class: 'v2-studio-hub-go' }, ...views.map(([k, t, s], i) => el('button', { type: 'button', class: i ? 'alt' : '', onclick: () => { void openReal(k); } }, placePic(k === 'widget' ? 'side' : 'full'), el('b', { text: t }), el('small', { text: s }))));
    h.replaceChildren(el('div', { class: 'v2-studio-hub' },
      el('div', { class: 'v2-studio-hub-head' },
        el('h2', { text: rec.mode !== 'new' && rec.round === 0 && !S.waiting ? '원본 그대로 열렸어요' : S.waiting ? (stallInfo() || { short: 'AI가 수정하고 있어요' }).short : verArrived(S.curVer || 1) }),
        //  글 속 「수정하기」 는 진짜 단추다 — 「지금 할 일」 줄 · 코멘트 막대의 「수정하기」 와 같은 꼴 · 같은 일(sendFix) · 같은 때 눌린다(원준 2026-10-16
        //   «버튼 제대로 똑같이 구현하고, 저 문구 위에 있는 버튼 눌러도 똑같이 작동하게»). 글 · 눌림은 syncFixIn 이 의견 수에 맞춘다.
        el('p', {}, '진짜 라이블리 화면에서 써 보고, 고칠 곳을 짚어서 적어주세요. 그 화면에서 하나하나 코멘트를 남기거나, 이 화면으로 돌아와 여기에 적어도 돼요. 다음 화면에서 ',
          el('button', { class: 'v2-studio-now-pri v2-studio-fix-in', type: 'button', onclick: () => { void sendFix(); } }), el('span', { class: 'v2-studio-fix-j' }), ' 누르면 AI가 한 번에 고쳐 다음 버전을 내요.')),
      S.waiting ? (S.stall ? el('div', { class: 'v2-studio-hub-wait' }, el('span', { text: '위 막대에서 까닭을 보고 이어서 수정할 수 있어요.' }))
        : el('div', { class: 'v2-studio-hub-wait' }, el('span', { class: 'v2-studio-spin', 'aria-hidden': 'true' }), el('span', { text: '다음 버전이 나오면 화면이 바뀌어요.' }))) : go,
      el('button', { class: 'v2-studio-wf-btn', type: 'button', onclick: () => { void openWireframe(); } }, el('b', { text: '와이어프레임(화면 흐름) 보기' }), el('small', { text: '화면에서 무엇을 누르면 다른 어느 화면으로 이어지는지 보여줍니다.' })),
      tray));
    paintTray(); syncFixIn();
    if (S.waiting) { if (openCoach && openCoach.key === 'draft') closeCoach(); }   // 고침을 보냈다 — 첫 안내는 할 일을 다 했다
    else recoach('draft', go);
  };
  // 새 버전이 왔다(처음 · 고침 · 되돌림) — 버전 이력 · 띠 · 허브 · 코멘트 층 · 떠 있는 앱 화면을 맞춘다
  const showApp = async (note?: string): Promise<void> => {
    if (S.dead || !rec.appId) return;
    await paintVer(); if (S.dead) return;
    if (note != null) { S.lastNote = note; band.replaceChildren(el('span', { text: (S.curVer ? verName(S.curVer) + ' · ' : '') + (note || '고쳤어요') })); band.hidden = false; }
    if (rec.stage === 'fix') paintHub();
    paintBar(); paintNow();
    if (S.review) S.review.update({ version: S.curVer, waiting: S.waiting, title: S.title, pins: S.pins, general: S.general, note: note || undefined });
    reloadAppFrames(rec.appId);   // 앱 화면(#/i) 탭은 제 사건이 없다 — 새 판을 다시 띄운다(세션 곁칸은 스스로 띄운다)
  };
  // 새로 생긴 앱 찾기 — 시작할 때 없던 id. 여럿이면 가장 나중 것. 생기면 ③ 허브로(붙이기는 setStage 가).
  const findApp = async (): Promise<void> => {
    if (S.dead || rec.appId) return;
    let found = '', foundTitle = '';
    if (rec.draftId) {
      //  #4667 「만들기 시작」 이 예약한 앱 — 첫 판이 저장되면(빈 앱이 아니게 되면) 그게 이 만들기의 앱이다.
      const v = await readVis(rec.draftId);
      if (v && !v.empty) { found = rec.draftId; foundTitle = v.title || rec.draftId; S.vis = v; }
    } else {
      //  예약 없이 시작한 만들기(옛 기록) — 시작 때 없던 앱 가운데 **내가 만든 것**만(같은 때 팀원이 만든 앱을 잡지 않게 · 만든 사람은 서버 기록).
      const m0 = await me();
      const apps = (await listApps()).filter((x) => !m0.id || String(x.made_by || x.installed_by || '') === m0.id);
      const fresh = freshApps(rec.known, apps);
      if (fresh.length) { found = fresh[fresh.length - 1]; const a = apps.find((x) => String(x.id) === found); foundTitle = String((a && a.title) || found); }
    }
    if (S.dead) return;
    if (found) {
      rec.appId = found; S.title = foundTitle; rec.title = S.title; saveRec(rec); name.textContent = S.title;
      await setStage('fix');
      await showApp('처음 만들었어요');
      coach('draft', appBox.querySelector('.v2-studio-hub-go'), '진짜 앱이 생겼어요. 가운데 단추로 실제 라이블리 화면에서 어떻게 동작하는지 테스트해보고, 고칠 곳에 코멘트를 남기세요.', '제목을 누르고 「글자 더 크게」');
      return;
    }
    S.pollT = window.setTimeout(() => { void findApp(); }, 4000);
  };
  //  고침이 끝났다(새 판) — 다음 차례로: 몇 번째를 올리고 보낸 코멘트를 걷는다. 새 판이 나왔으니 ④ 확인 · ⑤ 넣기는 그 판으로 다시(«와 본 곳» 을 ③ 으로).
  const settleFix = (): void => { S.waiting = false; window.clearTimeout(S.tick); rec.round += 1; S.pins = []; S.general = ''; rec.pins = []; rec.general = ''; rec.reached = 2; delete rec.fixing; saveRec(rec); };
  /** 고침을 보냈다 — 보낸 때와 그때 가장 뒤 판을 기록에 둔다(새로 열어도 기다림을 잇고, 그 뒤 판이 생겼는지로 끝났나를 안다). */
  const markFixing = async (): Promise<void> => {
    S.waiting = true; S.waitT0 = Date.now();
    if (rec.appId && !S.topVer) await paintVer();   // 판을 아직 못 읽었다(② 에서 다시 만들기) — 0 이면 끝남을 못 가린다
    rec.fixing = { at: S.waitT0, ver: S.topVer }; saveRec(rec);
  };
  const off = onAppEvent((ev) => {
    if (S.dead) return;
    if (!rec.appId) { if (ev.kind === 'updated' || ev.kind === 'attach') { window.clearTimeout(S.pollT); void findApp(); } return; }
    if (ev.app_id === rec.appId && ev.kind === 'updated') {
      //  고침을 기다리던 중이면 어느 단계에 있든 먼저 끝맺는다 — ② 로 돌아가 있어도 ③ 이 «수정하고 있어요» 에 멈추지 않게(격리 리뷰).
      //   새 버전이 나왔다 — ④ 확인 · ⑤ 넣기는 그 버전으로 다시 해야 하니 «와 본 곳» 을 ③ 으로 당긴다.
      const settled = S.waiting;
      if (S.waiting) settleFix();
      if (rec.stage === 'put' || rec.stage === 'check' || rec.stage === 'plan') { void paintVer(); if (settled) { band.hidden = true; paintBar(); paintNow(); } return; }   // 마무리 표시 저장도 'updated' 다 — 그 화면을 갈아 끼우지 않는다
      void showApp(ev.note || '고쳤어요');
    }
  });
  // AI 답 읽기 — 단계가 보낸 글 뒤의 답만(rec.from 워터마크). 2.5초마다.
  const onText = (t: string): void => {
    //  ④ 「AI에게 그려 달라기」 의 답 — 어느 단계에서 와도 받아 둔다(그새 다른 단계로 갔어도 돌아오면 그림 목록 맨 앞에 있다).
    const ic = parseIcon(t);
    if (ic) { rec.iconAi = [ic, ...(rec.iconAi || []).filter((x) => x.path !== ic.path)].slice(0, 4); setPick(ic); S.iconWait = false; S.iconMiss = false; window.clearTimeout(S.iconT); if (rec.stage === 'check') paintCheck(); }
    //  하네스가 «사용 한도에 걸렸다» 로 턴을 끝냈다 — 기다리지 않고 바로 까닭을 말한다(세션 줄로는 그냥 idle 이다).
    const lim = parseLimit(t); if (lim) { S.limit = lim; if (runKind()) setStall('limit'); return; }
    if (rec.stage === 'plan') { const c = parseCard(t); if (c) { rec.card = c; saveRec(rec); paintPlan(); paintNow();
      //  ①에서 이름을 비웠으면 기획 카드의 이름으로 세션 이름을 한 번 짓는다 — «"회의 안건" 앱 제작».
      //   그 이름이 곧 이 앱의 이름이다 — 머리줄 · 앱빌더 카드 · 세션 이름이 같은 글을 쓴다(원준 2026-10-15).
      if (!rec.named && !rec.title && c.name) { rec.named = true; rec.title = c.name; S.title = c.name; name.textContent = c.name; saveRec(rec); void relabel(rec.sid, c.name, 'new'); } } }
    else if ((rec.stage === 'draft' || rec.stage === 'fix') && !rec.appId) { const n = parseStep(t); if (n > S.step) { S.step = n; rec.step = n; saveRec(rec); paintSteps(); paintNow(); } }
    else if (rec.stage === 'check') { const ck = parseCheck(t); if (ck) { S.check = ck; S.checkWait = false; if (S.checkFor && S.checkFor.ver > 0) { rec.check = { ...ck, ...S.checkFor }; saveRec(rec); } paintCheck(); paintNow(); } }
  };
  //  drain — 쌓인 답을 지금 한 번 읽는다. 새 글을 보내기 전에도 부른다(보내면 워터마크가 기록 끝으로 가서, 아직 안 읽은 답 · 예: ④ 대조를 건너뛴다).
  const drain = async (): Promise<void> => {
    if (S.dead) return;
    const r = await rawLog(rec.sid, 'from=' + rec.from);
    if (!S.dead && r && r.to > rec.from) { const texts = assistantTexts(r.text); rec.from = r.to; saveRec(rec); texts.forEach(onText); }
  };
  const pump = async (): Promise<void> => {
    await drain();
    if (!S.dead) S.logT = window.setTimeout(() => { void pump(); }, 2500);
  };
  // 기다림 띠(③ 보낸 뒤) — m:ss
  const tickWait = (): void => { if (!S.waiting) return;
    const st = stallInfo(); if (st) { window.clearTimeout(S.tick); band.replaceChildren(el('span', { text: st.short })); band.hidden = false; return; }   // 멈췄으면 시계를 세우고 그 말만
    const s = Math.floor((Date.now() - S.waitT0) / 1000); band.replaceChildren(el('span', { text: 'AI 수정 중 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') })); band.hidden = false; S.tick = window.setTimeout(tickWait, 1000); };

  // ── 단계 화면들 ──
  const paintPlan = (): void => {
    const h = appHost();
    //  옛 기록(카드 글을 안 적던 판)으로 ② 에 왔다 — 지금 카드를 «청한 카드» 로 잡아 둔다(이 뒤에 고친 것만 «바꾼 기획» 이다).
    if (rec.card && rec.cardSent == null && reachedOf(rec) >= 2) { rec.cardSent = cardText(rec.card); saveRec(rec); }
    if (!rec.card) { waiting('AI가 기획 카드를 쓰는 중이에요', '한 줄 요청을 읽고 AI가 정리해요(1분 안팎).\n카드가 오면 다르게 생각하신 내용이 있는지 확인해주세요.'); return; }
    // 대화를 접어 두었으니 카드를 통째로 다시 쓰게 하는 한마디는 카드 아래에서 받는다.
    const ask = el('input', { class: 'v2-studio-ask-in', type: 'text', maxlength: '400', placeholder: '고칠 내용을 적어주세요. 예: 더 단순하게, 담당자 칸 추가', 'aria-label': '기획 카드 수정 요청' }) as HTMLInputElement;
    const askGo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '수정하기' }) as HTMLButtonElement;
    const doAsk = async (): Promise<void> => {
      const t = ask.value.trim(); if (!t || !rec.card || askGo.disabled) return;
      askGo.disabled = true;
      if (await send('기획 카드를 이렇게 고쳐서 같은 꼴로 다시 답해 줘(앞뒤에 다른 말 없이 · 정해진 줄 뒤에 내가 더한 줄도 그대로 남겨): ' + t + '\n지금 카드:\n' + cardText(rec.card))) { ask.value = ''; toast('AI가 기획 카드를 고치고 있어요.'); }
      askGo.disabled = false;
    };
    askGo.onclick = () => { void doAsk(); };
    ask.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void doAsk(); } });
    //  카드의 이름 줄을 고치면 그게 앱 이름이다 — 머리줄 · 앱빌더 카드 · 세션 이름 «"이름" 앱 제작» 이 따라간다(원준 2026-10-15 «내가 이름 정해 주지 않았나»).
    const onCard = (c: StudioCard): void => {
      rec.card = c; const nn = String(c.name || '').trim();
      if (nn && nn !== String(rec.title || '').trim()) { rec.title = nn; rec.named = true; S.title = nn; name.textContent = nn; void relabel(rec.sid, nn, rec.mode); }
      saveRec(rec);
      paintNow();   // 카드를 고쳤다 — 이미 시안을 청한 기획이면 「바꾼 기획대로 다시 만들기」 가 선다
    };
    h.replaceChildren(cardView(rec.card, onCard), el('div', { class: 'v2-studio-ask' }, ask, askGo));   // 안내문은 걷었다(원준 2026-10-14) — 줄 누르기 · 아래 한마디 칸이 스스로 말한다
    coach('plan', h.querySelector('.v2-studio-card'), '틀린 줄을 누르면 바로 고칠 수 있어요. 다 맞으면 「완료 · 다음 단계로」를 눌러주세요.', '「저장하는 정보」에 「담당자」를 더하면 앱에 그 칸이 생겨요');
  };
  const stepsEl = el('div', { class: 'v2-studio-steps' });
  const paintSteps = (): void => { stepsEl.replaceChildren(...DRAFT_STEPS.map((s, i) => el('span', { class: i < S.step ? 'done' : i === S.step ? 'on' : '', text: s }))); };
  const paintDraftView = (): void => {
    paintSteps();
    if (S.stall) waiting('AI가 초안을 만들다 멈췄어요', '만든 데까지는 그대로 남아 있어요. 위 막대에서 까닭을 보고 이어서 만들 수 있어요.', stepsEl, true);
    else waiting('AI가 초안을 만들고 있어요', '몇 분 걸려요. 다 되면 여기서 바로 써 볼 수 있어요. 창을 닫아도 계속 만들어지고, 앱빌더의 「만들던 앱」에서 다시 열 수 있어요.', stepsEl);
  };
  const paintDraft = (): void => { paintDraftView(); void findApp(); };
  /** 지금 AI 의 답을 기다리는 일 — 없으면 null(멈춤을 볼 까닭이 없다). */
  const runKind = (): 'plan' | 'draft' | 'fix' | 'check' | null => {
    if (rec.stage === 'plan' && !rec.card) return 'plan';
    if ((rec.stage === 'draft' || rec.stage === 'fix') && !rec.appId) return 'draft';
    if (S.waiting) return 'fix';   // 고침 기다림은 기록(rec.fixing)에 있다 — 나갔다 새로 열어도 멈춤을 본다
    if (rec.stage === 'check' && S.checkWait) return 'check';
    return null;
  };
  const reviewStall = (): { text: string; resume: boolean } | null => { const st = stallInfo(); return st ? { text: st.text, resume: st.resume } : null; };
  const setStall = (k: RunStall | null, node = S.stallNode): void => {
    if (k === S.stall && node === S.stallNode) return;
    const was = S.stall; S.stall = k; S.stallNode = node;
    if ((rec.stage === 'draft' || rec.stage === 'fix') && !rec.appId) paintDraftView();   // 앱 찾기(findApp)는 이미 돌고 있다 — 다시 걸지 않는다
    else if (rec.stage === 'fix' && S.waiting) paintHub();
    if (S.waiting) { window.clearTimeout(S.tick); if (was && !k) S.waitT0 = Date.now(); tickWait(); }   // 다시 돌면 시계는 그때부터
    if (S.review) S.review.update({ stall: reviewStall() });
    paintNow();
  };
  /** 새로 AI 에게 일을 맡겼다 — 지난 멈춤을 걷고 60초 동안은 멈췄다 하지 않는다(말이 막 닿는 틈). */
  const armRun = (): void => { S.stallT0 = 0; S.quietTill = Date.now() + 60000; S.limit = ''; setStall(null); };
  //  이 화면에서 AI 에게 보내는 글은 모두 여기로 — 보내면 멈춤 판정을 처음부터.
  const send = async (text: string): Promise<boolean> => { const ok = await sendPrompt(rec, text); if (ok) armRun(); return ok; };
  //  AI 일을 기다리는 동안 10초마다 그 세션 한 줄을 본다 — 멈춤이 STALL_MS 넘게 이어지면 막대가 까닭과 「이어서 만들기」 를 낸다.
  //   만들기 세션이 돌던 노트북이 잠들어 턴이 끝났는데 화면은 몇 시간째 «만들고 있어요» 였다(원준 2026-10-26).
  const watchRun = async (): Promise<void> => {
    if (S.dead) return;
    if (!runKind()) { S.stallT0 = 0; setStall(null); }
    else {
      let row: any = undefined;
      try { const d: any = await api('/api/ui/terminal/sessions?only=' + encodeURIComponent(rec.sid) + '&includeProjects=1'); row = Array.isArray(d?.sessions) ? (d.sessions[0] || null) : undefined; }
      catch (_) { /* 못 읽으면 그대로 둔다 */ }
      if (S.dead) return;
      if (row !== undefined) {
        let k = runStall(row); const now = Date.now();
        if (k === 'idle' && S.limit) k = 'limit';   // 턴이 끝난 까닭을 답 글이 말했다
        const node = row && row.node && row.node.name ? String(row.node.name).replace(/\.local$/, '') : '';
        if (!k) { S.stallT0 = 0; setStall(null, node); }
        else if (now >= S.quietTill) { if (!S.stallT0) S.stallT0 = now; if (now - S.stallT0 >= STALL_MS) setStall(k, node); }
      }
    }
    if (!S.dead) S.runT = window.setTimeout(() => { void watchRun(); }, 10000);
  };
  let resuming = false;   // 두 번 눌러도 되살리기 · 글은 한 번
  const resumeRun = async (): Promise<void> => {
    const kind = runKind(); if (!kind || !S.stall || resuming) return;
    resuming = true;
    try {
      const restored = S.stall === 'ended';
      if (restored) {
        try { await api(restorePath(rec.sid), { method: 'POST', body: '{}' }); }
        catch (e: any) { toast('세션을 다시 켜지 못했어요. 잠시 후 다시 시도해주세요. (' + (e && e.message ? e.message : e) + ')', true); return; }
        S.stall = 'idle';   // 세션은 켜졌다 — 글이 못 가도 다음 누름은 되살리지 않고 글만
      }
      //  막 되살린 세션은 글을 받을 준비가 늦을 수 있다 — 3초 간격으로 세 번까지(마지막 실패만 알린다).
      let ok = false;
      for (let i = 0; i < (restored ? 3 : 1) && !ok && !S.dead; i++) {
        if (i) await new Promise((r) => window.setTimeout(r, 3000));
        ok = await send(resumeBrief(kind));
      }
      if (ok) toast('멈춘 곳부터 이어서 하라고 AI에게 보냈어요.');
    } finally { resuming = false; }
  };
  const nameIn = el('input', { class: 'v2-studio-name-in', type: 'text', maxlength: '40', 'aria-label': '앱 이름' }) as HTMLInputElement;
  //  ④ 누가 쓰나(#4632 기본 「나만」 · #4667) — 「워크스페이스 모두」 면 「이대로 넣기」 가 공개한다. 「나만」 이면 공개하지 않는다: 새 앱은 나만 보는 앱으로,
  //   이미 공개한 앱을 고친 것이면 내 초안으로 남고 다른 사람은 공개 판을 계속 쓴다(공개를 거두는 일은 앱빌더 배포 설정에서).
  const whoRow = (): HTMLElement => {
    const vis = rec.vis || 'me';
    const live = !!S.vis && S.vis.visibility === 'all';
    const opts: Array<['all' | 'me', string]> = [['me', live ? '비공개로 두기 (기본)' : '나만 (기본)'], ['all', live ? '모두에게 공개' : '워크스페이스 모두']];
    return el('span', {},
      el('div', { class: 'v2-studio-chk-places' }, ...opts.map(([k, t]) => el('button', { type: 'button', class: k === vis ? 'on' : '', text: t, onclick: () => { rec.vis = k; saveRec(rec); paintCheck(); } }))),
      el('small', { text: vis === 'all' ? '「완료 · 다음 단계로」를 누르면 공개돼요. 워크스페이스 모두가 앱 찾기에서 쓸 수 있어요.'
        : live ? '이 버전은 나만 볼 수 있어요. 다른 사람은 지금 공개 버전을 계속 써요.'
          : '나만 볼 수 있어요. 나중에 앱빌더 배포 설정에서 공개할 수 있어요.' }));
  };
  // ── ④ 아이콘(원준 2026-10-28) — 지금 아이콘이 사이드바 · 세션 위젯 · 앱 찾기에 어떻게 서는지 보이고, 그림 · 색을 고르거나 AI 에게 다시 그려 달란다 ──
  //  고른 것은 rec.icon 에만 두고 「완료 · 다음 단계로」 의 마무리 저장(putAppOnce)이 매니페스트 icon 에 싣는다 — 고를 때마다 버전이 오르지 않게.
  const iconAsk = el('input', { class: 'v2-studio-name-in', type: 'text', maxlength: '80', placeholder: '예: 마이크와 메모지', 'aria-label': 'AI에게 부탁할 아이콘 그림' }) as HTMLInputElement;
  //  「다른 색」 의 색상 띠 · 색 코드 칸 — 다시 그려도 같은 요소를 단다(끄는 중 · 치는 중에 손이 안 빠지게).
  const hueIn = el('input', { class: 'v2-studio-cpick-hue', type: 'range', min: '0', max: '360', step: '1', 'aria-label': '색상' }) as HTMLInputElement;
  const hexIn = el('input', { class: 'v2-studio-name-in v2-studio-cpick-hex', type: 'text', maxlength: '7', spellcheck: 'false', placeholder: '#3A7BD5', 'aria-label': '색 코드' }) as HTMLInputElement;
  const iconNow = (): StudioIcon | null => rec.icon || (S.vis ? S.vis.icon : null);
  /** 고른 아이콘을 기록한다 — 그때 저장돼 있던 아이콘을 함께 적어 둔다(iconBase). spec 이 null 이면 고른 것을 걷는다. */
  const setPick = (spec: StudioIcon | null): void => {
    if (spec) { if (!rec.icon) rec.iconBase = S.vis && S.vis.icon ? S.vis.icon.path : ''; rec.icon = spec; } else { delete rec.icon; delete rec.iconBase; }
    saveRec(rec);
  };
  /** 미리 그릴 그림 이름 — 선언은 미리보기 이름으로 등록한다(앱 id 로 등록하면 저장 전에 이 창 밖의 그 앱 그림까지 바뀐다). 없으면 기본 그림. */
  const faceOf = (spec: StudioIcon | null): string => {
    if (!spec) return builtinAppIcon(rec.appId, true);
    const k = spec.path + '|' + spec.color + '|' + (spec.color_dark || ''); let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
    return registerAppIcon('studio-pv-' + (h >>> 0).toString(36), spec) || builtinAppIcon(rec.appId, true);
  };
  /** 글자 옆 선 그림을 그 그림의 색으로(사이드바 줄 · 세션 위젯 탭과 같은 꼴 · session-app-pane faceIcon). */
  const glyph = (face: string, cls: string): SVGElement => { const svg = icon(appGlyphName(face), cls); svg.setAttribute('style', 'color: var(--gi-c-' + face + ')'); return svg; };
  const askIcon = async (): Promise<void> => {
    if (S.iconWait || !rec.appId) return;
    await drain();   // 보내기 전에 쌓인 답(④ 대조)을 먼저 읽는다
    if (S.dead || !(await send(iconBrief(nameIn.value.trim() || S.title, rec.appId, iconAsk.value, iconNow())))) return;
    S.iconWait = true; S.iconMiss = false; window.clearTimeout(S.iconT);
    S.iconT = window.setTimeout(() => { if (S.dead || !S.iconWait) return; S.iconWait = false; S.iconMiss = true; if (rec.stage === 'check') paintCheck(); }, 180000);
    if (rec.stage === 'check') paintCheck();
  };
  const iconRow = (): HTMLElement => {
    const cur = iconNow(); const face = faceOf(cur); const title = nameIn.value.trim() || S.title;
    const sub = rec.icon ? '바꾼 아이콘은 「완료 · 다음 단계로」를 누르면 저장돼요.'
      : cur ? (rec.mode === 'new' ? 'AI가 앱을 만들 때 그린 아이콘이에요. 아래 자리에 같은 그림이 나와요.' : '지금 앱의 아이콘이에요. 아래 자리에 같은 그림이 나와요.')
        : !S.iconRead ? '아이콘을 불러오는 중…' : S.iconFail ? '지금 아이콘을 불러오지 못했어요. 잠시 후 다시 확인해주세요.' : '아직 아이콘이 없어 기본 그림으로 보여요. 「아이콘 바꾸기」에서 고를 수 있어요.';
    const spot = (cap: string, body: HTMLElement): HTMLElement => el('figure', { class: 'v2-studio-ico-spot' }, body, el('figcaption', { text: cap }));
    const spots = el('div', { class: 'v2-studio-ico-spots' },
      spot('사이드바', el('div', { class: 'v2-studio-ico-side' }, glyph(face, 'v2-ic'), el('span', { text: title }))),
      ...(rec.place !== 'full' ? [spot('세션 위젯', el('div', { class: 'v2-studio-ico-tab' }, glyph(face, 'v2-ic'), el('span', { text: title })))] : []),
      spot('앱 찾기', el('div', { class: 'v2-studio-ico-pad' }, appGlassIcon(face, 'v2-studio-ico-tile'), el('span', { text: title }))));
    const act = el('div', { class: 'v2-studio-ico-act' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-ico-k': 'toggle', 'aria-expanded': String(S.iconOpen), text: S.iconOpen ? '접기' : '아이콘 바꾸기', onclick: () => { S.iconOpen = !S.iconOpen; paintCheck(); } }),
      ...(rec.icon ? [el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-ico-k': 'reset', text: '처음대로', title: '바꾸기 전 아이콘으로 돌아가요', onclick: () => { setPick(null); paintCheck(); } })] : []));
    return el('div', { class: 'v2-studio-ico' }, el('span', { text: sub }), spots, act, ...(S.iconOpen ? [iconEditor(cur)] : []));
  };
  /** 어두운 화면으로 보고 있나(90-dark.css 의 두 선택자와 같은 잣대) — 끄는 동안의 미리보기를 그 화면의 색으로 칠한다. */
  const darkNow = (): boolean => { const t = document.documentElement.getAttribute('data-theme'); return t === 'dark' || (t !== 'light' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); };
  const colorPicker = (cur: StudioIcon | null, path0: string): HTMLElement => {
    //  팔레트 밖에서 색이 바뀌었으면(9색 · AI 그림 · 처음대로) 손잡이를 지금 색으로 옮긴다.
    if (S.cpick && cur && hsvToHex(S.cpick) !== cur.color.toUpperCase()) S.cpick = null;
    const hsv: Hsv = S.cpick || hexToHsv(cur ? cur.color : ICON_COLORS[0].color) || { h: 210, s: 0.7, v: 0.8 }; S.cpick = hsv;
    const knob = el('span', { class: 'v2-studio-cpick-knob' });   // <i> 는 안 된다 — 확인 줄의 체크 칸 규칙(.v2-studio-chk i)이 먹는다
    const sv = el('div', { class: 'v2-studio-cpick-sv', 'data-ico-k': 'sv', tabindex: '0', role: 'slider', 'aria-label': '채도와 밝기(방향키로 옮겨요)' }, knob) as HTMLElement;
    const chip = el('span', { class: 'v2-studio-cpick-chip' });
    const note = el('small', { class: 'v2-studio-cpick-note', role: 'status', 'aria-live': 'polite' });
    //  지금 손잡이 자리를 그린다 — 색 면 바탕(색상) · 손잡이 · 띠 · 코드 · 견본 · 위 미리보기 세 자리 · 흐림 안내. 다시 그리지 않는다.
    const show = (live = false): string => {
      const hex = hsvToHex(hsv);
      sv.style.backgroundColor = 'hsl(' + Math.round(hsv.h) + ' 100% 50%)';
      knob.style.left = (hsv.s * 100) + '%'; knob.style.top = ((1 - hsv.v) * 100) + '%'; knob.style.background = hex;
      sv.setAttribute('aria-valuetext', hex);
      hueIn.value = String(Math.round(hsv.h)); if (document.activeElement !== hexIn) hexIn.value = hex;
      const tint = darkNow() ? darkPair(hex) : hex;
      chip.style.background = tint;
      const host = live ? sv.closest('.v2-studio-ico') : null;   // 끄는 중에만 — 고른 뒤엔 위 미리보기가 제 색(등록한 짝)으로 다시 그려진다
      if (host) {
        host.querySelectorAll<SVGElement>('.v2-studio-ico-spots svg.v2-ic').forEach((n) => { n.style.color = tint; });
        host.querySelectorAll<SVGElement>('.v2-studio-ico-spots .v2-gi-glyph').forEach((n) => n.setAttribute('stroke', tint));
      }
      note.textContent = S.hexBad ? '색 코드는 #과 여섯 자리로 적어주세요. 예: #3A7BD5'
        : tooLight(hex) ? '밝은 화면에서 흐리게 보여요. 조금 더 진한 색을 골라주세요.' : '어두운 화면에서는 같은 색을 조금 밝게 보여줘요.';
      note.classList.toggle('warn', S.hexBad || tooLight(hex));
      return hex;
    };
    const commit = (): void => { const hex = hsvToHex(hsv); S.hexBad = false; setPick({ path: path0, color: hex, color_dark: darkPair(hex) }); paintCheck(); };
    const at = (e: PointerEvent): void => { const r = sv.getBoundingClientRect(); hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))); hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1))); show(true); };
    let drag = false;
    sv.onpointerdown = (e: PointerEvent) => { drag = true; try { sv.setPointerCapture(e.pointerId); } catch (_) { /* 잡지 못해도 끈다 */ } sv.focus(); at(e); e.preventDefault(); };
    sv.onpointermove = (e: PointerEvent) => { if (drag) at(e); };
    sv.onpointerup = (e: PointerEvent) => { if (!drag) return; drag = false; at(e); commit(); };
    sv.onpointercancel = () => { if (drag) { drag = false; commit(); } };
    sv.onkeydown = (e: KeyboardEvent) => {
      const d = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') hsv.s = Math.max(0, hsv.s - d); else if (e.key === 'ArrowRight') hsv.s = Math.min(1, hsv.s + d);
      else if (e.key === 'ArrowUp') hsv.v = Math.min(1, hsv.v + d); else if (e.key === 'ArrowDown') hsv.v = Math.max(0, hsv.v - d);
      else return;
      e.preventDefault(); commit();
    };
    hueIn.oninput = () => { hsv.h = Number(hueIn.value) || 0; show(true); };
    hueIn.onchange = () => { hsv.h = Number(hueIn.value) || 0; commit(); };
    const takeHex = (): void => { const hex = normHex(hexIn.value); if (!hex) { S.hexBad = true; show(); return; } const v = hexToHsv(hex); if (v) Object.assign(hsv, v); hexIn.value = hex; commit(); };
    hexIn.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); takeHex(); } };
    hexIn.onchange = () => { takeHex(); };
    const box = el('div', { class: 'v2-studio-cpick' }, sv, hueIn, el('div', { class: 'v2-studio-cpick-row' }, chip, hexIn), note);
    show();
    return box;
  };
  const iconEditor = (cur: StudioIcon | null): HTMLElement => {
    const tone = cur ? { color: cur.color, color_dark: cur.color_dark || cur.color } : { color: ICON_COLORS[0].color, color_dark: ICON_COLORS[0].color_dark };
    const pick = (spec: StudioIcon): void => { setPick(spec); paintCheck(); };
    const tile = (spec: StudioIcon, tip: string): HTMLElement => el('button', { type: 'button', class: 'v2-studio-ico-pick' + (cur && cur.path === spec.path ? ' on' : ''), 'data-ico-k': 'g:' + spec.path, title: tip, 'aria-label': tip, 'aria-pressed': String(!!cur && cur.path === spec.path), onclick: () => pick(spec) }, glyph(faceOf(spec), 'v2-studio-ico-g'));
    const ai = rec.iconAi || []; const first = S.vis && S.vis.icon && !ai.some((x) => x.path === S.vis!.icon!.path) ? S.vis.icon : null;
    const tiles = [
      ...ai.map((x, i) => tile(x, i === 0 ? 'AI가 방금 그린 그림' : 'AI가 그린 그림')),
      ...(first ? [tile(first, rec.mode === 'new' ? 'AI가 처음 그린 그림' : '지금 아이콘')] : []),
      ...ICON_GLYPHS.map((n) => tile({ path: iconPath(n), ...tone }, '기본 그림')),
    ];
    //  색 칸은 그 색으로 등록한 미리보기 토큰(--gi-c-…)으로 칠한다 — 라이트 · 다크에서 실제로 쓰일 색이 그대로 보인다.
    const path0 = cur ? cur.path : iconPath(appGlyphName(builtinAppIcon(rec.appId, true)));
    const swatches = ICON_COLORS.map((c) => { const spec = { path: path0, color: c.color, color_dark: c.color_dark };
      const on = !!cur && cur.color.toLowerCase() === c.color.toLowerCase();
      return el('button', { type: 'button', class: 'v2-studio-ico-sw' + (on ? ' on' : ''), 'data-ico-k': 'c:' + c.color, 'aria-pressed': String(on), title: c.name, 'aria-label': c.name + ' 색',
        style: 'background: var(--gi-c-' + faceOf(spec) + ')', onclick: () => pick(spec) }); });
    //  「다른 색」(원준 2026-10-28 «9개 냅두고, 원하면 다른 색을 훨씬 더 다양하게 · 연속적 컬러팔레트») — 색 면(채도 × 밝기) · 색상 띠 · 색 코드.
    //   사람은 밝은 화면 색 하나만 고르고, 어두운 화면 색은 darkPair 가 만든다. 끄는 동안은 미리보기만 칠하고(다시 그리지 않는다) 손을 떼면 고른다.
    const custom = !!cur && !ICON_COLORS.some((c) => c.color.toLowerCase() === cur.color.toLowerCase());
    const more = el('button', { type: 'button', class: 'v2-studio-ico-more' + (custom ? ' on' : ''), 'data-ico-k': 'more', 'aria-expanded': String(S.colorOpen), 'aria-pressed': String(custom), title: '색 더 고르기',
      onclick: () => { S.colorOpen = !S.colorOpen; S.hexBad = false; if (S.colorOpen) S.cpick = hexToHsv(cur ? cur.color : ICON_COLORS[0].color); paintCheck(); } },
      el('span', { class: 'v2-studio-ico-more-dot', ...(custom ? { style: 'background: var(--gi-c-' + faceOf(cur) + ')' } : {}) }), el('span', { text: '다른 색' }));
    const askBtn = el('button', { type: 'button', class: 'v2-studio-go sm', 'data-ico-k': 'ask', text: 'AI에게 그려 달라기', disabled: S.iconWait || !rec.appId, onclick: () => { void askIcon(); } });
    iconAsk.onkeydown = (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void askIcon(); } };
    return el('div', { class: 'v2-studio-ico-ed' },
      el('b', { text: '그림' }), el('div', { class: 'v2-studio-ico-grid' }, ...tiles),
      el('b', { text: '색' }), el('div', { class: 'v2-studio-ico-colors' }, ...swatches, more),
      ...(S.colorOpen ? [colorPicker(cur, path0)] : []),
      el('b', { text: 'AI에게 부탁하기' }), el('div', { class: 'v2-studio-ico-ask' }, iconAsk, askBtn),
      el('small', { role: 'status', 'aria-live': 'polite', text: S.iconWait ? 'AI가 아이콘을 그리는 중…' : S.iconMiss ? 'AI가 아이콘을 보내지 않았어요. 다시 부탁해주세요.' : '원하는 그림을 적으면 AI가 새로 그려 그림 목록 맨 앞에 더해요.' }));
  };
  const paintCheck = (): void => {
    const h = appHost(); const c = rec.card;
    //  다시 그려도 손이 있던 자리로 — 아이콘 칸의 그림 · 색 · 단추에서 고르면 포커스가 몸으로 빠지지 않게(격리 리뷰). 입력칸(이름 · 부탁)은 같은 요소를 다시 단다.
    const act = document.activeElement as HTMLElement | null;
    const focusK = act && h.contains(act) ? act.getAttribute('data-ico-k') : null;
    const refocus = act === iconAsk || act === nameIn || act === hueIn || act === hexIn ? act : null;
    const row = (ok: boolean | null, title: string, sub: HTMLElement | string): HTMLElement => el('div', { class: 'v2-studio-chk' + (ok === true ? ' ok' : ok === false ? ' no' : '') }, el('i', { text: ok === true ? '✓' : ok === false ? '!' : '…' }), el('div', {}, el('b', { text: title }), typeof sub === 'string' ? el('span', { text: sub }) : sub));
    const r1 = !c ? row(null, '원하던 것이 다 있나요?', '기획 카드가 없는 앱이라 비교하지 않았어요. 앱을 직접 써 보고 확인해주세요.')
      : S.check ? row(S.check.missing.length === 0, '원하던 것이 다 있나요?', S.check.missing.length ? '빠진 것: ' + S.check.missing.join(', ') + '. 「더 고치기」를 눌러 코멘트로 남겨주세요.' : '있어요: ' + (S.check.have.length ? S.check.have.join(', ') : c.can.join(', ')) + ' (AI가 기획 카드와 비교)')
      : row(null, '원하던 것이 다 있나요?', 'AI가 기획 카드와 지금 버전을 비교하는 중…');
    if (nameIn.value === '') nameIn.value = S.title;
    const places = el('div', { class: 'v2-studio-chk-places' }, ...(Object.keys(PLACE) as StudioPlace[]).map((k) => el('button', { type: 'button', class: k === rec.place ? 'on' : '', text: PLACE[k].title, onclick: () => { rec.place = k; saveRec(rec); paintCheck(); } })));
    h.replaceChildren(el('div', { class: 'v2-studio-chks' }, r1,
      row(true, '이름', el('span', {}, nameIn, el('small', { text: ' 여기서 바꿀 수 있어요' }))),
      row(true, '쓰는 자리', places),
      row(true, '누가 쓰나', whoRow()),
      row(true, '아이콘', iconRow()),
      el('p', { class: 'v2-studio-fine', text: '하나라도 다르면 「더 고치기」를 눌러 ③ 단계로 돌아가요.' })));
    coach('check', h.querySelector('.v2-studio-chks'), '다섯 가지만 확인하면 돼요. 다른 게 있으면 「더 고치기」를 눌러주세요.', '이름이 「' + S.title + '」 맞나요?');
    if (refocus) refocus.focus();
    else if (focusK) {
      const hit = [...h.querySelectorAll<HTMLElement>('[data-ico-k]')].find((n) => n.getAttribute('data-ico-k') === focusK)
        || h.querySelector<HTMLElement>('[data-ico-k="toggle"]');   // 「처음대로」 처럼 사라진 단추면 펼치기 단추로
      if (hit) hit.focus();
    }
  };
  const paintPut = (): void => {
    const h = appHost(); const c = rec.card; const placeName = PLACE[rec.place].title; const title = S.title;
    const steps: HTMLElement[] = [
      el('div', { class: 'v2-studio-step' }, el('b', { text: rec.mode === 'copy' ? '이렇게 시작했어요' : '이렇게 부탁했어요' }), el('p', { text: rec.mode === 'copy' && rec.origin ? '「' + rec.origin.title + '」' + (rec.origin.by ? '(' + rec.origin.by + ' 님이 만듦)' : '') + '의 사본 · ' + placeName : '「' + firstLine(rec.what) + '」 · ' + placeName })),
      c ? el('div', { class: 'v2-studio-step' }, el('b', { text: '기획 카드로 정했어요' }), el('p', { text: c.who + ' · 저장하는 정보: ' + c.items + ' · 주요 기능: ' + c.can.join(' · ') })) : el('div', { class: 'v2-studio-step' }, el('b', { text: 'AI가 세션에서 만들었어요' }), el('p', { text: '수정할 때마다 버전이 하나씩 올라가요(초안 → V2 → V3).' })),
    ];
    const list = el('div', { class: 'v2-studio-steps-list' }, ...steps);
    fetchAppVersions(rec.appId).then((vs) => {
      if (S.dead) return; const rows = vs.slice().sort((a, b) => a.version_no - b.version_no);
      const vrow = (v: { version_no: number; note: string | null; saved_at: string }): HTMLElement => el('div', { class: 'v2-studio-step v2-studio-step--ver' }, el('b', { text: verName(v.version_no) }), el('p', { text: (v.note || '').trim() || (v.version_no === 1 ? '처음 만듦' : '고침') }), el('small', { text: whenText(v.saved_at) }));
      const vr = rows.length <= 8 ? rows.map(vrow) : [vrow(rows[0]), el('div', { class: 'v2-studio-step v2-studio-step--ver' }, el('p', { text: '… ' + (rows.length - 7) + '번 더 고쳤어요' })), ...rows.slice(-6).map(vrow)];
      vr.forEach((n) => list.append(n));
      //  #4667 공개 상태대로 말한다 — 공개(모두) · 나만 보는 앱 · 공개한 앱에 둔 내 초안.
      const v = S.vis;
      list.append(!v || (v.visibility === 'all' && !v.draftMine)
        ? el('div', { class: 'v2-studio-step' }, el('b', { text: '워크스페이스 앱이 됐어요' }), el('p', { text: '앱 찾기(왼쪽 「앱」)의 「워크스페이스 앱」에 「' + title + '」 이름으로 있어요. 워크스페이스 모두가 쓸 수 있어요.' }))
        : v.visibility === 'me'
          ? el('div', { class: 'v2-studio-step' }, el('b', { text: '내 앱이 됐어요' }), el('p', { text: '앱 찾기(왼쪽 「앱」)에 「' + title + '」 이름으로 있어요. 지금은 나만 볼 수 있고, 아래에서 팀에 공개할 수 있어요.' }))
          : el('div', { class: 'v2-studio-step' }, el('b', { text: '비공개로 두었어요' }), el('p', { text: '이 버전은 나만 볼 수 있어요. 다른 사람은 공개 버전(' + verName(v.publishedNo) + ')을 계속 써요. 모두에게 공개하려면 아래 「공개하기」를 눌러주세요.' })));
    }).catch(() => { /* 판 이력 없이도 안내한다 */ });
    const how: HTMLElement[] = [];
    if (rec.place !== 'full') how.push(el('div', {}, el('span', { class: 'k', text: '세션 위젯으로' }), el('span', { text: '세션 오른쪽 위 +에서 이 앱을 고르면 세션 위젯으로 붙어요. 세션의 AI에게 말하면 위젯 내용을 읽고 바꿔줘요.' })));
    if (rec.place !== 'side') how.push(el('div', {}, el('span', { class: 'k', text: '앱 화면으로' }), el('span', { text: '앱 찾기(왼쪽 「앱」)에서 이 앱을 누르면 전체 화면으로 열려요.' })));
    how.push(el('div', {}, el('span', { class: 'k', text: '더 고치려면' }), el('span', { text: '앱빌더의 「내가 만든 앱」에서 「고치기」를 눌러주세요. 수정할 때마다 새 버전이 생기고, 이전 버전으로 되돌릴 수도 있어요.' })));
    const shared = !S.vis || (S.vis.visibility === 'all' && !S.vis.draftMine);
    if (shared) how.push(el('div', {}, el('span', { class: 'k', text: '팀원은' }), el('span', { text: '앱 찾기의 ⋯ 메뉴에서 「내 사본 떠서 고치기」로 사본을 만들어 바꿔 쓰거나, 「원본을 고치기」로 새 버전을 만들어 공개할 수 있어요.' })));
    // ⑦ 팀에 알리기 — 글은 기획 카드에서 미리 적는다. 지식 「앱 소개」 + 슬랙(적으면).
    const line = el('textarea', { class: 'ta', rows: '4' }) as HTMLTextAreaElement;
    line.value = (meCache && meCache.name ? meCache.name + ' 님이 ' : '') + '「' + title + '」 앱을 만들었어요.\n' + (c ? '주요 기능: ' + c.can.join(', ') : firstLine(rec.what)) + '\n쓰는 자리: ' + placeName + '\n앱 찾기(왼쪽 「앱」)의 「워크스페이스 앱」에서 열 수 있어요.';
    const slack = el('input', { class: 'v2-studio-name-in', type: 'text', placeholder: '슬랙 채널 (선택, 예: #product)', maxlength: '60' }) as HTMLInputElement;
    const tellBtn = el('button', { class: 'v2-studio-go sm', type: 'button', text: rec.notified ? '알렸어요' : '팀에 알리기' }) as HTMLButtonElement; tellBtn.disabled = !!rec.notified;
    tellBtn.onclick = async () => { tellBtn.disabled = true; if (await send(notifyBrief(title, line.value.trim(), slack.value))) { rec.notified = true; saveRec(rec); tellBtn.textContent = '알렸어요'; toast('AI가 팀에 알리고 있어요. 결과는 AI 세션에서 볼 수 있어요.'); } else tellBtn.disabled = false; };
    const tryBtn = el('button', { class: 'v2-studio-go', type: 'button', text: '지금 써 보기' }) as HTMLButtonElement;
    tryBtn.onclick = async () => {
      tryBtn.disabled = true;
      const sid = rec.place !== 'full' ? routeSession() : '';
      if (sid && sid !== rec.sid) { if (await attachAppToSession(sid, rec.appId, title)) { closeAppStudio(); toast('「' + title + '」 앱을 이 세션에 위젯으로 붙였어요. 오른쪽 탭에서 볼 수 있어요.'); return; } }
      closeAppStudio();
      if (!(await openAppUi(rec.appId, { title }))) toast('앱 찾기(왼쪽 「앱」)에서 「' + title + '」 앱을 열어 보세요.');
    };
    h.replaceChildren(el('div', { class: 'v2-studio-fin' },
      el('h2', { text: '「' + title + '」 앱이 만들어졌어요' }),
      el('p', { class: 'v2-studio-lead', text: '어떻게 만들었는지와 어디서 쓰는지 확인하고 바로 써 보세요.' }),
      el('h3', { text: '이렇게 만들었어요' }), list,
      el('h3', { text: '이렇게 쓰세요' }), el('div', { class: 'v2-studio-how' }, ...how),
      //  팀에 알리기는 모두가 쓰는 앱일 때만 — 나만 보는 앱 · 내 초안을 알리면 팀원은 열 수 없는 앱을 보게 된다(#4667). 그 전엔 「팀에 공개하기」(#4632).
      el('h3', { text: shared ? '팀에 알리기' : '팀에 공개하기' }),
      shared
        ? el('div', { class: 'v2-studio-tell' }, el('p', { class: 'v2-studio-fine', text: '팀 지식에 「앱 소개」로 남고 대시보드 알림에 떠요. 슬랙 채널을 적으면 그 채널에도 보내요.' }), line, el('div', { class: 'v2-studio-tell-act' }, slack, tellBtn))
        : el('div', { class: 'v2-studio-tell' }, el('p', { class: 'v2-studio-fine', text: S.vis && S.vis.draftMine
            ? '이 버전은 아직 나만 볼 수 있어요. 공개하면 워크스페이스 모두가 이 버전을 쓰고, 팀에 알릴 수 있어요.'
            : '지금은 나만 쓰는 앱이에요. 공개하면 워크스페이스 모두가 앱 찾기에서 쓸 수 있고, 팀에 알릴 수 있어요. 공개 범위는 앱빌더 배포 설정에서 언제든 바꿀 수 있어요.' }),
          el('div', { class: 'v2-studio-tell-act' }, el('button', { class: 'v2-studio-go sm', type: 'button', text: S.vis && S.vis.draftMine ? '이 버전을 모두에게 공개하기' : '워크스페이스 모두에게 공개하기', disabled: !!S.vis && !S.vis.canPublish,
            onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; if (await setVisibility('all')) { toast('워크스페이스 모두에게 공개했어요'); paintNow(); paintPut(); } else b.disabled = false; } }))),
      el('div', { class: 'v2-studio-fin-act' }, tryBtn, el('button', { class: 'btn btn-ghost', type: 'button', text: '더 고치기', onclick: () => { rec.done = false; void setStage('fix'); } }))));
    coach('put', tryBtn.parentElement, (shared ? '워크스페이스 앱이 됐어요. ' : S.vis && S.vis.draftMine ? '이 버전은 비공개로 두었어요. ' : '앱이 만들어졌어요. 지금은 나만 볼 수 있어요. ') + '「지금 써 보기」로 바로 열어 보세요.', rec.place === 'full' ? '전체 화면으로 열어 직접 써 보세요' : '세션 위젯으로 붙이고 AI에게 「안건 3개 적어 줘」처럼 말해 보세요');
  };

  // ── 단계 넘기기 — 속 단계 draft(첫 판 기다림)는 앱이 생기면 fix 다(사람에게는 같은 ③) ──
  const setStage = async (s0: StudioStage): Promise<void> => {
    const s: StudioStage = s0 === 'draft' && rec.appId ? 'fix' : s0;
    leaveCoach(s === 'fix' || s === 'draft' ? 'draft' : s);
    rec.stage = s; if (s !== 'put') rec.done = false; rec.reached = Math.max(reachedOf(rec), stageIndex(s)); saveRec(rec);   // done 을 먼저 — reachedOf 는 넣은 앱을 ⑤ 까지로 본다
    if (s !== 'fix' && S.review) backToBuilder();
    body.classList.toggle('v2-studio-body--put', s === 'put'); body.classList.toggle('v2-studio-body--hub', s === 'fix' || s === 'draft'); body.classList.toggle('v2-studio-body--plan', s === 'plan' || s === 'check');
    appBox.className = 'v2-studio-app ' + (s === 'plan' || s === 'check' ? 'v2-studio-app--side' : 'v2-studio-app--full');
    undo.hidden = s === 'put' || !S.prevVer;
    appBox.replaceChildren();
    if (s === 'put') { rec.done = true; saveRec(rec); paintPut(); }
    else if (s === 'plan') paintPlan();
    else if (s === 'draft') paintDraft();
    else if (s === 'fix') { if (!rec.appId) paintDraft(); else { paintHub(); void paintVer().then(() => { if (!S.dead && rec.stage === 'fix') paintHub(); }); } }
    else if (s === 'check') {
      //  같은 버전 · 같은 기획 카드로 이미 대조했으면 그 결과를 그대로 — 단계 바로 오갈 때마다 AI 에게 다시 묻지 않는다.
      if (rec.appId && !S.curVer) { await paintVer(); if (S.dead || rec.stage !== 'check') return; }   // 기다리는 사이 다른 단계로 갔거나 닫혔다
      //  버전을 못 읽었으면(0) 지난 결과를 믿지 않는다 — 다른 버전의 대조를 그대로 보일 수 있다.
      const same = !!rec.check && S.curVer > 0 && rec.check.ver === S.curVer && rec.check.card === (rec.card ? cardText(rec.card) : '');
      S.check = same && rec.check ? { have: rec.check.have, missing: rec.check.missing } : null; paintCheck();
      //  ④ 아이콘은 지금 버전의 매니페스트에서 — ③ 에서 버전이 올랐을 수 있어 들어올 때마다 다시 읽는다.
      //   고른 것이 있는데 그 사이 저장된 아이콘이 바뀌었으면(AI 가 새 버전에 넣었다) 고른 것은 낡았다 — 걷어 새 아이콘을 덮지 않게.
      if (rec.appId) void readVis(rec.appId).then((v) => {
        if (S.dead) return; S.iconRead = true; S.iconFail = !v;
        if (v) { S.vis = v; if (rec.icon && rec.iconBase !== undefined && rec.iconBase !== (v.icon ? v.icon.path : '')) setPick(null); }
        if (rec.stage === 'check') paintCheck();
      });
      //  청한 때의 버전 · 카드로 결과에 도장을 찍는다(답이 올 때의 것이 아니라 — 그 사이 바뀌었으면 다음에 다시 묻는다).
      if (!same && rec.card && rec.appId) { S.checkWait = true; S.checkFor = { ver: S.curVer, card: cardText(rec.card) }; void send(checkBrief(rec.card, rec.appId)); }
    }
    applyPlace(); paintBar(); paintNow(); paintTray();
  };
  const toDraft = async (): Promise<void> => { if (!rec.card) return; if (await send(draftBrief(rec.card, rec.place, rec.draftId || ''))) { rec.cardSent = cardText(rec.card); rec.step = 0; saveRec(rec); S.step = 0; await setStage('draft'); } };
  //  ② 에서 기획 카드를 고친 뒤 「바꾼 기획대로 다시 만들기」 — 앱이 있으면 고침 한 번(바뀐 카드 전문을 앱 전체 코멘트로 · 새 버전), 첫 판 전이면 초안을 다시 청한다.
  const remake = async (): Promise<void> => {
    if (!rec.card || S.waiting) return;
    if (!rec.appId) { await toDraft(); return; }
    const say = '기획 카드를 이렇게 바꿨어요. 바뀐 카드대로 앱을 고쳐주세요.\n' + cardText(rec.card);
    if (await send(fixBrief(rec.round + 1, [], say, rec.place, rec.appId))) {
      rec.cardSent = cardText(rec.card); saveRec(rec);
      await markFixing(); tickWait();
      await setStage('fix');
    }
  };
  const sendFix = async (): Promise<void> => {
    if (S.waiting) return;
    const pins = S.pins.filter((p) => p.note.trim()); if (!pins.length && !S.general.trim()) return;
    if (await send(fixBrief(rec.round + 1, pins, S.general, rec.place, rec.appId))) { await markFixing(); tickWait(); paintBar(); paintNow(); if (rec.stage === 'fix') paintHub(); if (S.review) S.review.update({ waiting: true }); }
  };
  //  #4732 「이대로 넣기」 는 연타를 막지 않는 단추라 — 미리 보기 · 저장 · 공개가 두 번 나가지 않게 하나씩만.
  let putting = false;
  const putApp = async (): Promise<void> => {
    if (putting) return;
    putting = true;
    try { await putAppOnce(); } finally { putting = false; }
  };
  const putAppOnce = async (): Promise<void> => {
    const newName = nameIn.value.trim() || S.title;
    const share = rec.vis || 'me';
    //  #4484 서버가 있는 앱이면 넣기 전에 서버부터(실패하면 넣지 않는다 — 기록은 만들기 세션으로 간다).
    if (!(await ensureAppServer(rec.appId))) return;
    //  #4732 「워크스페이스 모두」 면 이 저장이 곧 공개다 — 고친 공개 앱이면 미뤄 둔 표 변경이 이때 적용되므로 먼저 보여 주고 묻는다(새 앱은 할 일이 없어 묻지 않는다).
    if (share === 'all' && !(await confirmPublish(rec.appId, { title: newName }))) return;
    try {
      //  #4667 만든 사람 · 만들기 세션 · 원본은 서버가 이미 기록했다 — 매니페스트엔 자리 · 기획 카드 · 마무리 표시만(옛 칸은 걷는다).
      //   「워크스페이스 모두」 면 이 저장이 곧 공개다(publish) · 「나만」 이면 공개하지 않는다.
      const pickedIcon = rec.icon ? iconSpec(rec.icon) : null;   // ④ 에서 고른 아이콘 — 서버 잣대로 한 번 더 거른다(틀린 선언이면 이 저장이 400 으로 막힌다)
      await patchManifest(rec.appId, (man) => { if (newName) man.title = newName; if (pickedIcon) man.icon = pickedIcon; man.studio = { ...studioUiOnly(man.studio), place: rec.place, put: true, ...(rec.card ? { card: rec.card } : {}) }; }, '마무리 · ' + newName + (pickedIcon ? ' · 아이콘' : ''), { publish: share === 'all' });
      delete rec.icon; delete rec.iconBase;   // 매니페스트에 실렸다 — 다음 ④ 는 저장된 아이콘에서 시작한다
      S.title = newName; rec.title = newName; name.textContent = newName; void relabel(rec.sid, newName, rec.mode);
    } catch (e: any) { toast('마무리 표시를 저장하지 못했어요. 앱은 그대로 쓸 수 있어요. (' + (e && e.message ? e.message : e) + ')', true); }
    S.vis = await readVis(rec.appId);
    rec.vis = undefined; saveRec(rec);   // 이번 넣기에 쓴 ④ 의 고름 — 다음 고침은 기본(「나만」 · 공개한 앱이면 「내 초안으로 두기」)에서 다시 고른다
    await setStage('put');
    paintVis();
  };
  //  공개 범위(#4632 app_visibility_set) — 'all' 이면 「공개하기」(나만 보는 앱을 처음 공개 · 공개한 앱의 내 초안을 공개 판으로, #4667). 못 해도 앱은 그대로.
  const setVisibility = async (v: 'all' | 'me'): Promise<boolean> => {
    try {
      if (v === 'all' && !(await ensureAppServer(rec.appId))) return false;   // #4484 공개할 판의 서버가 빌드돼 있어야 한다
      if (v === 'all' && !(await confirmPublish(rec.appId, { title: S.title }))) return false;   // #4732
      await api('/api/ui/apps/' + encodeURIComponent(rec.appId) + '/visibility', { method: 'POST', body: JSON.stringify({ visibility: v }) });
      S.vis = await readVis(rec.appId); paintVis(); return true;   // ④ 의 고름(rec.vis)은 건드리지 않는다 — 다음 고침의 기본은 다시 「나만」 쪽(격리 리뷰 2-9)
    } catch (e: any) { toast('공개 범위를 바꾸지 못했어요. ' + (e && e.message ? e.message : e), true); return false; }
  };
  undo.onclick = async () => {
    if (!rec.appId || !S.prevVer) return;
    undo.disabled = true; const to = await revertApp(rec.appId, S.prevVer, S.title); undo.disabled = false;
    if (to != null) { rec.reached = 2; saveRec(rec); await showApp(verJ(to, '으로') + ' 되돌렸어요'); }   // 되돌린 버전으로 ④ · ⑤ 를 다시
  };
  help.onclick = () => helpMenu(help, () => showIntro(() => { /* 그대로 */ }, () => showTour()), () => showTour());
  teardown = () => { S.dead = true; if (S.board) { const bd = S.board; S.board = null; bd.close(); }   // 보드는 몸(body)에 붙어 있다 — 창과 함께 걷는다
    window.clearTimeout(S.pollT); window.clearTimeout(S.logT); window.clearTimeout(S.tick); window.clearTimeout(S.runT); window.clearTimeout(S.iconT); off(); if (S.review) { S.review = null; closeReview(); } dropTry(); if (S.chat) S.chat.destroy(); };
  root.replaceChildren(
    el('div', { class: 'v2-studio-top v2-studio-top--build' }, crumb(), name, ver,
      ...(rec.origin ? [el('small', { class: 'v2-studio-origin', text: '원본: ' + rec.origin.title })] : []),
      el('span', { class: 'v2-studio-sp' }), pubBtn, undo, chatBtn, help,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: () => closeAppStudio() })),
    bar, now, band, body, chatWin, dockHint);
  if (rec.appId) {
    //  #4667 제목 · 기획 카드 · 공개 상태를 서버에서(이름은 못 읽으면 기록의 것으로).
    const v = await readVis(rec.appId);
    if (v) { S.vis = v; if (v.title) { S.title = v.title; rec.title = S.title; name.textContent = S.title; } if (!rec.card && v.card) rec.card = v.card as StudioCard; paintVis(); }
  }
  if (!rec.from) rec.from = await logEnd(rec.sid);
  //  고침을 보내 두고 나갔다 왔다 — 그 사이 새 판이 나왔으면 끝맺고 그 판을 알리고, 아니면 «AI가 수정하고 있어요» 를 잇는다(시계는 보낸 때부터).
  let fixedAway = '';
  if (rec.fixing && rec.appId) {
    try {
      const vs = await fetchAppVersions(rec.appId); if (S.dead) return;
      const f = rec.fixing;
      //  보낼 때 판을 못 읽었으면(ver 0) 보낸 뒤에 저장된 판으로 가린다
      const fresh = vs.filter((v) => (f.ver > 0 ? v.version_no > f.ver : Date.parse(v.saved_at) > f.at)).sort((a, b) => b.version_no - a.version_no)[0];
      if (fresh) { settleFix(); fixedAway = fresh.note || '고쳤어요'; }
    } catch (_) { /* 판 이력을 못 읽으면 기다림을 잇는다 — 새 판이 오면 사건이 끝맺는다 */ }
  }
  await setStage(rec.stage);
  if (fixedAway && rec.stage === 'fix') await showApp(fixedAway);
  else if (S.waiting) tickWait();
  void pump();
  void watchRun();
  //  새로고침 전에 실제 화면(시험 세션 · 앱 화면)을 보던 중이었으면 그 화면과 막대를 다시 연다(원준 2026-10-16 «새로고침하니까 밑에 떠 있는 창 사라짐»).
  { const m = readReviewOpen();
    if (m && m.sid === rec.sid && m.appId === rec.appId && rec.stage === 'fix' && rec.appId && !S.dead) void openReal(m.view);
    else if (mountOpts.onSee) mountOpts.onSee(rec.sid, null); }   // 다시 열 화면이 없다 — 주소에 남은 «보는 중» 표시를 걷어 앱빌더 사이드바를 되돌린다
  // AI 세션 — 그 세션 화면을 끼운다(리브와 같은 방식: 목록을 한 번 읽어 그 세션 한 장으로). 기본 터미널 보기(chatHome 아님).
  try {
    const [live, logs] = await Promise.all([
      api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
      api('/api/ui/v6/sessions?limit=40').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
    ]);
    if (S.dead) return;
    const { mergeSessions, renderSession } = await import('./views.js');   // 정적으로 들여오면 views → apps → app-studio → views 순환(check-imports)
    const made = takeCreated(rec.sid);
    const rows = made ? [made, ...(live as any[])] : (live as any[]);
    //  세션 이름 되맞추기 — 정한 앱 이름이 있는데 세션 이름이 «"이름" 앱 제작» 꼴이 아니면(옛 머리말 · AI 가 지은 이름) 한 번 바로잡는다(원준 2026-10-15).
    const row = rows.find((x: any) => x && x.id === rec.sid);
    const nm = String(rec.title || (rec.card && rec.card.name) || '').trim();
    if (row && nm && String(row.label || '').trim() !== builderSessionLabel(nm, rec.mode)) void relabel(rec.sid, nm, rec.mode);
    S.chat = renderSession(chatHost, { projects: [], sessions: mergeSessions(rows, logs as any[]), loadedAt: Date.now() } as any, rec.sid, { solo: true, isVisible: () => !!root && chatHost.isConnected });
  } catch (e: any) {
    chatHost.replaceChildren(el('p', { class: 'v2-muted', text: 'AI 세션을 열지 못했어요. ' + (e && e.message ? e.message : e) }));
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
