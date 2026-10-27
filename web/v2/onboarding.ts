// v2/onboarding.ts — 처음 설정(#/welcome). (#4970) 인사 → 이름 → (#5060) 파일 올리기 → AI 연결 → «외부 앱을 연결하시겠어요?» 다섯 장면이 전부다.
//
//  ★ #5060(원준님 2026-10-27) — 파일 올리기를 **AI 연결 앞에** 둔다. 올린 파일이 지식이 되는 길이 처음 설정에 없었다(#4970 이 서랍·파일 장면을
//   걷은 뒤 로컬 증류기를 켜는 자리가 사라졌다). 고른 파일은 백그라운드로 올라가고(bg-upload.ts) 사람은 기다리지 않고 다음으로 간다.
//   지식으로 바꾸는 일은 세션이 한다 — [연결할게요]면 연결 대화가 끝난 뒤 같은 대화에, [나중에 할게요]면 올리기가 끝난 뒤 새로 연 리브 대화에
//   서버가 정리 지시(리브 2턴)를 넣는다. 화면은 그 갈림을 반영(me_welcome_apply next·upload)에 실어 보낼 뿐이다.
//
//  ★ #4970(상민님 결정 2026-10-22 — 지식 onboarding-single-flow-connect-in-own-ai-4970) — 처음 설정을 하나로 줄였다.
//   종전(#4213 T13)엔 끝이 «Claude 계정 연결 + 리브 대화» 하나라, 서버에 로그인된 AI 가 없거나 Claude 가 아닌 사람(커서만 쓰는 사람)은
//   처음 설정을 끝내도 아무 일도 없었다. 또 «누가 먼저 왔나»(합류자 판정)로 차례표를 갈랐는데, 셀프호스트 기본 워크스페이스에선 그
//   판정이 인원수 폴백이라 관리자 계정을 먼저 만든 회사의 대표가 합류자로 읽혔다. 이제:
//   · 매니지드·셀프호스트, 첫 관리자·초대 합류자 모두 같은 장면들이다(PR2 당시 셋 → PR4 에서 AI 연결이 더해져 넷).
//   · [연결할게요] — 서버에 로그인된 AI 가 있으면 보통 세션을 열고(첫 지시 = 연결 스킬 liv-connect), 그 세션 화면으로 간다.
//     없으면 같은 장면에서 «쓰는 AI 에서 하기» 세 걸음(데스크톱 앱 → 로그인 → 그 AI 에 한 마디)을 보여 준다. 어느 쪽이든 처음 설정은 끝난다.
//   · [나중에 할게요] — 끝낸다(홈). 나중엔 [외부 앱 연결] 화면 맨 위의 같은 버튼으로 시작한다.
//  ★ AI 연결(상민님 2026-10-23 «AI 연결 유도를 앱 연결 전에 해야 · 클로드만이 아니라 지원하는 거 다 · UX 쉽게») — PR2 가 걷은 «AI 고르기·AI 연결»
//   두 장면을 **한 장면**으로 되살렸다. 이 서버에서 띄울 수 있는 AI(서버 installed)만 줄로 보이고, [연결]을 누르면 그 줄 아래에서 로그인한다
//   ([AI 계정 연결]과 같은 칸 — ai-login-panel.ts · 줄은 onboarding-ai.ts). 하나라도 연결되면 [다음]. PC 의 AI(커서·클로드 코드)를 쓰는 사람은 «PC에서 쓰는 AI로»
//   → 외부 앱 물음의 [연결할게요]가 서버 세션을 열지 않고 «쓰는 AI 에서 하기» 세 걸음을 그린다.
//   · 서비스마다의 갈림(매니지드 중계 / 셀프호스트 앱 등록 / 관리 권한)은 세션 안의 연결 스킬이 한다 — 이 화면은 갈래를 모른다.
//  종전 장면(팀 소개·무대·직무·파일·AI 고르기·AI 연결·앱 고르기·앱 연결·터미널·내 컴퓨터·앱 받기)과 챗 문답은 PR2 에서 코드째 걷었다(git 기록에
//   있다). PR4 의 AI 연결은 그 옛 두 장면을 되돌린 것이 아니라 [AI 계정 연결]의 칸 위에 새로 세운 한 장면이다.
//  사이드바는 실제 것(side.ts)이 그린다 — 인사·이름에서는 숨겨 달라고(ctx.onBare), 연결 물음에서는 유령으로 세워 달라고(ctx.onGhost) 부탁한다.
import { api, state } from '../core.js';
import { drawRail } from './rail.js';   // 이름을 바꾸면 레일 발치의 [나]도 그 자리에서 다시 그린다(#1813)
//  (#4970) 연결을 시작하는 문 한 벌 — [외부 앱 연결] 화면의 [연결 도와줘]와 같은 것을 쓴다(세션 열기 · «쓰는 AI 에서 하기» 세 걸음).
import { openConnectSession, ownAiStepsHtml, wireOwnAiSteps } from './connect-own-ai.js';
//  (#4970) AI 연결 장면의 줄·로그인 칸 — [AI 계정 연결]과 같은 칸 · 같은 로고·이름·순서(onboarding-ai.ts).
import { mountAiList } from './onboarding-ai.js';
//  (#5060) 처음 설정에서 고른 파일 — 다른 화면으로 옮겨 가도 계속 올라간다.
import { bgUploadAdd, bgUploadOnChange, bgUploadState, uploadVerdict } from './bg-upload.js';
import { upDirSupported, upDropZone, upFromInput, type UpItem } from '../projects/files-upload.js';

export const OB_DONE_KEY = 'lively_ob_done';
/** 빠른 로컬 캐시 — 첫 그림에서 화면이 깜빡이지 않게 쓴다. **정본은 서버**(아래 fetchOnboardingDone). */
export function onboardingDone(): boolean { try { return localStorage.getItem(OB_DONE_KEY) === '1'; } catch (_) { return false; } }
/**
 * 처음 설정으로 **자동으로 보냈다**를 서버에 남긴다(#2171). «끝냈다»(onboarded)와 다른 사실이다.
 *  자동 진입은 평생 한 번이어야 하고, 그 근거는 «보여줬다»는 사실이지 «끝냈다»가 아니다(중간에 나간 사람을 앱을 열 때마다 끌고 가지 않게).
 *  ⚠ 실패해도 삼킨다 — 표식을 못 남겼다고 화면이 안 뜨면 안 된다.
 */
export function markWelcomeSeen(): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_seen: true }) })
    .catch(() => { /* 비치명 */ });
}
/** [나중에 할게요](나가기) — 사람이 **스스로 미뤘다**는 표식(#2232). 홈의 «이어서 하기»가 길을 지킨다. 실패해도 삼킨다. */
export function markWelcomeDeferred(): void { setWelcomeDeferred(true); }
/** 미룸 해제 — **사람이 처음 설정을 다시 연 순간**(#2232). 자동 진입은 미룬 사람에게 오지 않으므로 이 화면이 떴다 = 스스로 왔다. */
export function clearWelcomeDeferred(): void { setWelcomeDeferred(false); }
function setWelcomeDeferred(on: boolean): void {
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ welcome_deferred: on }) })
    .catch(() => { /* 비치명 */ });
}
/**
 * 처음 설정을 끝냈는지 **서버에 묻는다**(#1813) — 기기·브라우저를 바꿔도 끝낸 사람에게 다시 뜨지 않게. 서버가 답하면 로컬 캐시도 맞춘다.
 *  못 물으면(오프라인·구 서버) 로컬 캐시로 떨어진다 — 온보딩 때문에 앱이 안 열리는 일은 없어야 한다.
 */
export async function fetchOnboardingDone(): Promise<boolean> {
  try {
    const r: any = await api('/api/ui/me/welcome');
    const done = !!(r && r.done);
    try { done ? localStorage.setItem(OB_DONE_KEY, '1') : localStorage.removeItem(OB_DONE_KEY); } catch (_) { /* 사파리 프라이빗 */ }
    return done;
  } catch (_) { return onboardingDone(); }
}

/** (#4970) 처음 설정의 문구 — 바꿀 말은 여기 한 곳에 모은다(인사 제목은 원준님 확정 전 기본값이다). */
export const OB_COPY = {
  introTitle: '라이블리에 오신 것을 환영합니다',
  introBody: 'Lively는 사용자가 놓여있는 맥락을 저희가 직접 AI에게 풍부하게 주입해서 AI의 세팅 난이도를 줄이고, 양질의 결과물을 얻을 수 있도록 합니다.',
  introNext: '이를 위해서 이 뒤에서는, 라이블리 사용을 위한 기본 설정을 진행합니다.',
  aiTitle: '라이블리에서 쓸 AI를 연결해 주세요',
  aiHelp: '외부 앱 연결과 자료 정리를 이 AI가 대신 합니다. 쓰시는 AI 하나면 돼요.',
  aiNext: '다음',
  //  (#5058) 종전 «PC에서 쓰는 AI로 할게요 (커서·클로드 코드 등)» — 처음 온 비개발자에겐 «PC에서 쓰는 AI» 가 브라우저의 ChatGPT 와
  //   구분되지 않았다. 이 길은 **컴퓨터에 프로그램으로 깔아 쓰는 AI**(커서·클로드 코드) 쪽이라 그렇게 말한다.
  aiPc: '컴퓨터에 설치해 쓰는 AI 프로그램으로 할게요 (Cursor·Claude Code 등)',
  aiNone: '이 서버에는 아직 연결할 수 있는 AI가 없어요. 컴퓨터에 설치해 쓰시는 AI 프로그램(Cursor·Claude Code 등)으로 하시면 됩니다.',
  uploadTitle: '일하실 때 쓰는 파일이 있으면 올려 주세요',
  uploadHelp: '올린 파일은 AI가 읽고 지식으로 정리해요. 올라가는 동안 다음 설정을 계속하실 수 있어요.',
  uploadDrop: '파일이나 폴더를 여기로 끌어다 놓으세요',
  uploadSkip: '올릴 파일이 없어요',
  //  (#5060) 서버에 AI 가 없으면 지식으로 바꿀 자리가 없다 — 올린 파일은 자료로만 남는다. 사실대로 말한다.
  uploadNoServerAi: '올리신 파일을 지식으로 정리하는 일은 라이블리 서버에 연결된 AI가 해요. 지금은 연결된 AI가 없어 파일은 자료로 보관돼요 — 나중에 [내 설정 ▸ AI 계정 연결]에서 연결하시면 정리를 시작할 수 있어요.',
  uploadLater: '올리신 파일은 다 올라가면 리브가 읽고 카테고리와 정리 규칙을 세워 둘게요.',
  uploadKept: '올리신 파일은 [자료]에 보관돼요.',
  connectTitle: '외부 앱을 연결하시겠어요?',
  connectHelp: '슬랙·노션·깃허브 같은 곳의 자료를 라이블리로 모읍니다.',
  connectYes: '연결할게요',
  connectLater: '나중에 할게요',
  //  «쓰는 AI 에서 하기» 세 걸음과 그 AI 에 할 한 마디는 connect-own-ai.ts 에 있다([외부 앱 연결] 화면과 한 벌).
};

/* ── (#5060) 처음 설정에서 고른 파일의 «올리기 끝» — 화면(이 장면)보다 오래 산다(페이지 수명) ──
 *  보낼 때: 실패 0 · 고른 것이 전부 올라갔다(uploadVerdict). 대기열이 빈 것만으로는 보내지 않는다 — 실패만 남아도 빈다(격리 리뷰).
 *  [다시 시도]로 실패가 풀려도 다시 재야 하므로 한 번 쓰고 버리는 «비면 부르기» 가 아니라 바뀔 때마다 듣는다. 서버는 처음 시각을 지킨다(멱등). */
let welcomeUploadExpected = 0;
let welcomeUploadWatching = false;
let welcomeUploadSentAt = -1;
function postUploadDoneIfSettled(): void {
  const s = bgUploadState();
  if (uploadVerdict(s, welcomeUploadExpected) !== 'done' || welcomeUploadSentAt === s.done) return;
  welcomeUploadSentAt = s.done;
  void api('/api/ui/me/liv-profile', { method: 'POST', body: JSON.stringify({ upload_done: true }) }).catch(() => { welcomeUploadSentAt = -1; });
}
function watchWelcomeUploads(): void {
  if (welcomeUploadWatching) return;
  welcomeUploadWatching = true;
  bgUploadOnChange(() => postUploadDoneIfSettled());
}

type Ctx = { onBare?: (bare: boolean) => void; onGhost?: (on: boolean) => void; onDone?: () => void };
/** viaPc — AI 연결에서 «PC에서 쓰는 AI로» 를 골랐다(#4970). 그러면 [연결할게요]가 서버 세션을 열지 않는다. */
/** uploaded — (#5060) 이 처음 설정에서 고른 파일 수(새로 줄 선 것 + 이미 올려 건너뛴 것). 0 이면 올린 것이 없다(반영에 upload 를 싣지 않는다).
 *  serverAi — AI 연결 장면에서 서버 AI 가 하나라도 연결돼 있었나(안내 문구를 사실대로 가른다). */
interface ObState { scene: string; name: string; nameSet: boolean; trail: string[]; viaPc: boolean; uploaded: number; serverAi: boolean }

export function renderOnboarding(host: HTMLElement, ctx: Ctx = {}): { destroy(): void } {
  host.className = 'ob-root';
  // ⚠ 나가는 문(#2171) — 처음 설정에서 스스로 나갈 길. 홈으로 보내면서 «이어서 하기» 를 남긴다(포기가 아니라 미룸).
  host.innerHTML = `<div class="ob-crumb" id="crumb"><span class="ob-lm">L</span><span style="font-weight:600">라이블리</span><span class="ob-sep">/</span><span>처음 설정</span><button class="ob-q-back" id="obBack" data-back hidden>← 이전</button><button class="ob-q-back ob-q-exit" id="obExit" title="홈으로 갑니다. 남은 설정은 홈에서 이어서 하실 수 있어요.">나중에 할게요</button></div>
    <div class="ob-qwrap"><div class="ob-qcol" id="qcol"></div></div>
<div class="ob-toast" id="toast"></div>`;
  //  화면에 들어온 것 자체가 «보여줬다» 다 — 사람이 스스로 연 경우(홈의 «이어서 하기»·주소)에도 표식은 있어야 옳다(서버가 처음 시각을 지킨다).
  markWelcomeSeen();
  clearWelcomeDeferred();   // #2232 — 이 화면이 떴다 = 사람이 다시 열었다 → 미룸을 푼다
  //  #2232 — 떴다 = 끝낼 때까지 «하다 만 것» 이다. 홈의 «이어서 하기» 줄(me.welcome_pending)을 여기서 미리 맞춘다 — me 는 부팅 때 한 번 읽는다.
  try { if (state.me && !onboardingDone()) (state.me as { welcome_pending?: boolean }).welcome_pending = true; } catch (_) { /* 비치명 */ }
  const exitBtn = host.querySelector('#obExit') as HTMLButtonElement | null;
  if (exitBtn) exitBtn.onclick = () => {
    markWelcomeDeferred();
    try { if (state.me) (state.me as { welcome_pending?: boolean }).welcome_pending = true; } catch (_) { /* 비치명 */ }
    location.hash = '#/';
  };

  const $ = <T extends Element = HTMLElement>(s: string, el?: ParentNode | null): T | null => (el || host).querySelector(s) as T | null;
  const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let toastT: ReturnType<typeof setTimeout> | null = null;
  function toast(t: string) {
    const el = $('#toast'); if (!el) return;
    el.textContent = t; el.classList.add('ob-on');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('ob-on'), 2600);
  }

  /* ── 상태 ── */
  const KEY = 'lively-ob-v2';
  /** 이 화면이 이미 걷혔나 — 서버를 기다리는 사이에 떠날 수 있다. */
  let destroyed = false;
  /** 이 화면이 히스토리에 쌓은 걸음 순번 — «뒤로» 와 «나가기» 를 가르는 근거(onPop 참조). */
  let obSeq = 0;
  /** 서버에 «어디까지 하셨나» 를 묻고 기다리는 한도. 넘으면 처음부터 연다 — 못 물었다고 화면이 안 열리면 안 된다. */
  const RESUME_WAIT_MS = 2500;
  /** 기다리는 말을 띄우기 전에 조용히 기다리는 시간 — 금방 답이 오면 그 말은 아예 안 보인다(#1631). */
  const RESUME_HINT_MS = 600;
  const fresh = (): ObState => ({ scene: 'intro', name: '', nameSet: false, trail: [], viaPc: false, uploaded: 0, serverAi: false });
  let S: ObState = fresh();
  /** 아직 **아무것도 답하지 않은** 장면 — 인사(intro)·이름(name). 여기 머문 것은 «하다 만 것» 이 아니다(이름을 적었으면 nameSet 이 말한다).
   *  ⚠ 마운트하는 동안 읽힌다 — 그래서 여기(hadLocal 보다 앞)에 둔다(뒤에 두면 선언 전 참조로 화면이 통째로 죽는다). */
  const BEFORE_ANSWER = ['intro', 'name'];
  /** 이 탭에 남아 있던 진행이 있었나 — 있으면 그게 가장 새 것이다.
   *  ⚠ **아무것도 답하지 않은 상태는 «있음» 으로 치지 않는다** — 한 번의 서버 실패로 저장된 첫 화면이 그 사람의 진행을 영영 가린다. */
  let hadLocal = false;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (v && v.scene) { S = Object.assign(fresh(), pickState(v)); hadLocal = !BEFORE_ANSWER.includes(v.scene) || !!v.nameSet; }
  } catch (e) { /* 깨진 저장본 — 처음부터 */ }
  /** 저장본에서 지금 쓰는 칸만 고른다 — 옛 판(장면 11개 시절)의 진행에는 업로드·AI 고르기 같은 칸이 함께 들어 있다. */
  function pickState(v: any): Partial<ObState> {
    return {
      scene: typeof v.scene === 'string' ? v.scene : 'intro',
      name: typeof v.name === 'string' ? v.name : '',
      nameSet: !!v.nameSet,
      trail: Array.isArray(v.trail) ? v.trail.filter((x: unknown) => typeof x === 'string') : [],
      viaPc: v.viaPc === true,
      uploaded: typeof v.uploaded === 'number' && v.uploaded > 0 ? Math.floor(v.uploaded) : 0,
      serverAi: v.serverAi === true,
    };
  }

  /* ── 하다 만 자리를 **서버에** 남긴다 (#2207) ─────────────────────────────────
   *  sessionStorage 는 탭을 닫으면 사라진다 — 자리표까지 서버가 든다. 이 탭에 있으면 이 탭이 정본이다(로컬은 매 저장마다 서버로 밀린다).
   *  ⚠ 자주 불린다 — 그래서 debounce 하고, 한 번에 하나만 날린다. */
  const PUSH_MS = 800;
  let pushT: ReturnType<typeof setTimeout> | null = null, pushing = false, pushAgain = false, pushOff = false;
  const saveLocal = () => { try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 사파리 프라이빗 */ } };
  /** 남길 만한 진행인가 — **아무것도 답하지 않은 첫 화면은 «하다 만 것» 이 아니다**(열어보기만 한 사람을 다음 로그인마다 끌어오지 않게). */
  const worthSaving = () => !BEFORE_ANSWER.includes(S.scene) || S.nameSet;
  function schedulePush() {
    if (pushOff || !worthSaving()) return;   // 끝난 사람의 진행은 남기지 않는다(서버도 거절한다)
    if (pushT) clearTimeout(pushT);
    pushT = setTimeout(() => { void flushProgress(); }, PUSH_MS);
  }
  /** 지금 상태를 서버에 밀어 넣는다. **실패해도 진행을 막지 않는다.** `keepalive` 는 창을 닫는 중에도 요청이 끝까지 가게 한다. */
  async function flushProgress(keepalive?: boolean) {
    if (pushOff || !worthSaving()) return;
    if (pushT) clearTimeout(pushT); pushT = null;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      await api('/api/ui/me/welcome/progress', Object.assign(
        { method: 'POST', body: JSON.stringify({ scene: S.scene || 'name', state: S }) },
        keepalive ? { keepalive: true } : {}));
    } catch (_) { /* 비치명 — 이 탭에는 남아 있다 */ }
    pushing = false;
    if (pushAgain) { pushAgain = false; void flushProgress(); }
  }
  const save = () => { saveLocal(); schedulePush(); };
  /** 창을 닫거나 탭을 숨길 때 — 마지막 한 걸음이 유실되는 자리가 정확히 여기다(debounce 대기 중). */
  const onLeave = () => { if (document.visibilityState === 'hidden') void flushProgress(true); };
  const onPageHide = () => { void flushProgress(true); };
  addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onLeave);

  /* 막1(인사·이름)은 민낯(셸 숨김), 연결 물음은 유령 셸(#2232) — 사이드바를 누르면 처음 설정에서 빠져나가 버리던 자리다. */
  const setStage = (s: string) => { host.className = 'ob-root ob-' + s; ctx.onBare && ctx.onBare(s === 'stage-name'); ctx.onGhost && ctx.onGhost(s !== 'stage-name'); };
  /* ══════════════ 장면 차례 ══════════════ */
  const ORDER = ['intro', 'name', 'upload', 'ai', 'connect-ask'];
  const STEP_OF: Record<string, number> = Object.fromEntries(ORDER.map((k, i) => [k, i]));
  /** 지금 차례표에서 이 장면 **다음**. 끝이면 null. */
  const nextScene = (cur: string): string | null => { const i = ORDER.indexOf(cur); return i >= 0 && i + 1 < ORDER.length ? ORDER[i + 1]! : null; };

  function qHead(lead: string, title: string, help: string) {
    return `<div class="ob-q-top"><div class="ob-q-ic">L</div></div>
      ${lead ? `<p class="ob-q-lead">${lead}</p>` : ''}
      <h1 class="ob-q-title">${title}</h1>
      ${help ? `<p class="ob-q-help">${help}</p>` : ''}`;
  }

  /** 인사 장면의 그림(#1631) — 첫 문장 «맥락을 AI 에게 주입한다» 를 옮긴 흐름도다. 보조기기에는 숨긴다(같은 말을 아래 문장이 한다). */
  function introArt() {
    const ic = (d: string) => `<svg class="ob-in-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const chip = (d: string, t: string) => `<span class="ob-in-chip">${ic(d)}<span>${t}</span></span>`;
    return `<div class="ob-in-art" aria-hidden="true"><div class="ob-in-flow">
      <div class="ob-in-src">
        ${chip('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', '문서')}
        ${chip('<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>', '대화')}
        ${chip('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2L7.5 11M4 18l1.2 1.2L7.5 17"/>', '업무')}
      </div>
      <span class="ob-in-join"></span>
      <span class="ob-in-hub">Lively<span class="pulse-dot"></span></span>
      <span class="ob-in-wire"><span class="ob-in-run"><i></i></span></span>
      <span class="ob-in-ai">${ic('<path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/><path d="M18.5 15.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>')}<span>AI</span><span class="ob-in-ok">${ic('<path d="M6 12.5l3.8 3.8L18 8"/>')}</span></span>
    </div></div>`;
  }

  /** 이름을 **그 자리에서** 서버에 남긴다(#1813) — 중간에 나가도 방금 적은 이름이 워크스페이스에 보이게. 실패해도 진행은 막지 않는다
   *  (마무리에서 한 번 더 보낸다). ⚠ display_name 만 넣는다 — 닉네임은 [내 설정 ▸ 프로필]에서 따로 정한다. */
  function saveName(v: string) {
    if (!v) return;
    void api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ display_name: v }) })
      .then(() => {
        try { if (state && (state as any).me) { (state as any).me.display_name = v; } } catch (_) { /* noop */ }
        try { drawRail(); } catch (_) { /* 레일이 없는 배포(클래식)면 그냥 넘어간다 */ }
      })
      .catch(() => { /* 비치명 — 마무리에서 한 번 더 보낸다 */ });
  }

  const SCENES: Record<string, { html: () => string; bind?: (el: HTMLElement) => void }> = {
    /* 인사(#1631) — 무엇을 묻기 전에 **Lively 가 무엇을 하는지**와 이 뒤에서 무엇을 하는지를 먼저 말한다.
     *  ⚠ 아무것도 묻지 않는 장면이다 — BEFORE_ANSWER 에 들어 있어 여기 머문 것은 저장·이어 열기의 대상이 아니다. */
    intro: {
      html: () => `${introArt()}
        <h1 class="ob-q-title ob-in-title">${esc(OB_COPY.introTitle)}</h1>
        <p class="ob-in-p">${esc(OB_COPY.introBody)}</p>
        <p class="ob-in-p ob-in-next">${esc(OB_COPY.introNext)}</p>
        <button class="ob-btn ob-btn-pri ob-in-go" id="introGo">계속하기</button>`,
      bind: (el) => { $<HTMLButtonElement>('#introGo', el)!.onclick = () => goScene(nextScene('intro')!); },
    },
    /* 이름 — 이름 하나만, 가운데. */
    name: {
      html: () => qHead('안녕하세요, 저는 리브예요. 이 워크스페이스를 계속 돌봐 드릴 담당자입니다.',
        '어떻게 불러 드릴까요?',
        '이름이든 별명이든 편한 대로 적어 주세요. 나중에 언제든 바꾸실 수 있어요.')
        + `<div class="ob-q-write"><input id="nameIn" type="text" placeholder="예: 원준" value="${esc(S.nameSet ? S.name : '')}"></div>
           <button class="ob-btn ob-btn-pri" id="nameGo">이렇게 불러 주세요</button>
           <button class="ob-q-skip" data-skip>그냥 넘어갈게요</button>`,
      bind: (el) => {
        const inp = $<HTMLInputElement>('#nameIn', el)!;
        const go = () => { const v = inp.value.trim(); if (v) { S.name = v; S.nameSet = true; saveName(v); } goScene(nextScene('name')!); };
        $<HTMLButtonElement>('#nameGo', el)!.onclick = go;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
        $<HTMLButtonElement>('[data-skip]', el)!.onclick = () => goScene(nextScene('name')!);
        inp.focus();
      },
    },
    /* (#5060) 파일 올리기 — AI 연결보다 먼저. 고르면 곧바로 백그라운드로 올라가고 [다음]이 켜진다(기다리지 않는다). 안 올려도 된다. */
    upload: {
      html: () => qHead(S.nameSet && S.name ? `${esc(S.name)}님, 먼저 자료부터 받아 둘게요.` : '먼저 자료부터 받아 둘게요.',
        esc(OB_COPY.uploadTitle), esc(OB_COPY.uploadHelp))
        + `<div class="ob-up-drop" id="upDrop">
             <p class="ob-up-hint">${esc(OB_COPY.uploadDrop)}</p>
             <div class="ob-up-btns">
               <button type="button" class="ob-btn ob-btn-sub ob-btn-inline" id="upFiles">파일 고르기</button>
               ${upDirSupported() ? '<button type="button" class="ob-btn ob-btn-sub ob-btn-inline" id="upDir">폴더 고르기</button>' : ''}
             </div>
           </div>
           <p class="ob-q-help ob-up-stat" id="upStat" aria-live="polite"></p>
           <button class="ob-btn ob-btn-pri" id="upNext" hidden>다음</button>
           <button class="ob-q-skip" id="upSkip">${esc(OB_COPY.uploadSkip)}</button>`,
      bind: (el) => bindUpload(el),
    },
    /* (#4970 상민님 2026-10-23) AI 연결 — 외부 앱보다 먼저. 이 서버에서 띄울 수 있는 AI 만 줄로 보이고(서버 installed), [연결]은 그 줄 아래에서
     *  로그인한다([AI 계정 연결]과 같은 칸). 하나라도 연결되면 [다음]. PC 의 AI 를 쓰는 사람은 아래 길로 간다. 묻지 않고 넘기는 길은 없다 —
     *  머리의 [나중에 할게요](홈)가 그 자리다. */
    ai: {
      html: () => qHead(S.nameSet && S.name ? `${esc(S.name)}님이 쓰시는 AI부터 연결할게요.` : '쓰시는 AI부터 연결할게요.',
        esc(OB_COPY.aiTitle), esc(OB_COPY.aiHelp))
        + `<div class="ob-opt-cards ob-ai" id="aiList"><p class="ob-q-help">이 서버에서 쓸 수 있는 AI를 보고 있어요.</p></div>
           <button class="ob-btn ob-btn-pri" id="aiNext" disabled>${esc(OB_COPY.aiNext)}</button>
           <button class="ob-q-skip" id="aiPc">${esc(OB_COPY.aiPc)}</button>`,
      bind: (el) => bindAi(el),
    },
    /* (#4970) 연결 물음 — 처음 설정의 마지막 물음. 고르는 순간 처음 설정은 끝난다(반영 먼저, 그다음 연결). */
    'connect-ask': {
      html: () => qHead(S.nameSet && S.name ? `${esc(S.name)}님, 마지막으로 하나만 여쭐게요.` : '마지막으로 하나만 여쭐게요.',
        esc(OB_COPY.connectTitle), esc(OB_COPY.connectHelp))
        + `<div id="cxBody">
             <button class="ob-btn ob-btn-pri" id="cxYes">${esc(OB_COPY.connectYes)}</button>
             <button class="ob-q-skip" id="cxLater">${esc(OB_COPY.connectLater)}</button>
           </div>`,
      bind: (el) => {
        const yes = $<HTMLButtonElement>('#cxYes', el)!;
        const later = $<HTMLButtonElement>('#cxLater', el)!;
        yes.onclick = () => void connectYes(el, yes, later);
        later.onclick = async () => {
          yes.disabled = true; later.disabled = true;
          if (await finishOnboarding('later')) {
            //  (#5060) 올린 파일이 있으면 그 파일이 어떻게 되는지까지 말한다 — 서버 AI 가 없으면(PC 의 AI 를 고름) 정리할 자리가 없다는 것도.
            const filesLine = S.uploaded ? ' ' + filesFate() : '';
            say(el, esc('준비됐어요. 외부 앱은 왼쪽 [외부 앱 연결]에서 언제든 연결하실 수 있어요.' + filesLine));
            await sleep(S.uploaded ? 3200 : 1400); location.hash = '#/';
          }
          else { yes.disabled = false; later.disabled = false; }
        };
      },
    },
  };

  /**
   * AI 연결 장면을 잇는다 — 줄과 로그인 칸은 onboarding-ai.ts(mountAiList)가 그 자리에서 고친다. 여기는 [다음]·«PC에서 쓰는 AI로» 만 다룬다.
   *  [다음]은 연결된 AI 가 하나라도 있을 때만 켠다. 띄울 AI 가 하나도 없으면 [다음]을 숨기고 PC 길을 주 버튼으로 세운다.
   */
  function bindAi(el: HTMLElement) {
    const list = $('#aiList', el)!;
    const next = $<HTMLButtonElement>('#aiNext', el)!;
    const pc = $<HTMLButtonElement>('#aiPc', el)!;
    next.onclick = () => { S.viaPc = false; goScene(nextScene('ai')!); };
    pc.onclick = () => { S.viaPc = true; goScene(nextScene('ai')!); };
    mountAiList(list, {
      esc, noneText: OB_COPY.aiNone,
      alive: () => !destroyed && list.isConnected,
      onRows: (anyConnected) => { next.hidden = false; next.disabled = !anyConnected; S.serverAi = anyConnected; save(); },
      onEmpty: () => { next.hidden = true; pc.className = 'ob-btn ob-btn-pri'; },   // 남은 길이 이것뿐이다 — 조용한 링크로 두지 않는다
    });
  }

  /**
   * 파일 올리기 장면을 잇는다(#5060) — 고른 파일은 bg-upload 대기열로 가고, 이 장면은 몇 개를 줄 세웠는지만 말한다.
   *  올리기가 끝나면 서버에 «올리기 끝» 을 알린다(리브 2턴이 그것을 기다린다 — second-turn.ts). 이 장면이 걷혀도 그 알림은 간다(모듈이 쥔다).
   */
  function bindUpload(el: HTMLElement) {
    const stat = $('#upStat', el)!;
    const next = $<HTMLButtonElement>('#upNext', el)!;
    const skip = $<HTMLButtonElement>('#upSkip', el)!;
    const paint = () => {
      if (!S.uploaded) return;
      const st = bgUploadState();
      stat.textContent = st.running
        ? `${S.uploaded.toLocaleString('ko-KR')}개를 올리고 있어요. 다음으로 넘어가셔도 계속 올라가요.`
        : `${S.uploaded.toLocaleString('ko-KR')}개를 받아 두었어요.`;
      next.hidden = false; skip.hidden = true;
    };
    const take = (items: UpItem[]) => {
      if (!items.length) { toast('올릴 파일을 찾지 못했어요.'); return; }
      const r = bgUploadAdd(items.map((u) => ({ file: u.file as File, rel: u.rel })));
      S.uploaded += r.added + r.skipped; save();
      welcomeUploadExpected = S.uploaded; watchWelcomeUploads();
      paint();
    };
    const pick = (dir: boolean) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.hidden = true;
      if (dir) inp.setAttribute('webkitdirectory', '');
      inp.addEventListener('change', () => { take(upFromInput(inp)); inp.remove(); });
      document.body.append(inp); inp.click();
    };
    $<HTMLButtonElement>('#upFiles', el)!.onclick = () => pick(false);
    const dirBtn = $<HTMLButtonElement>('#upDir', el); if (dirBtn) dirBtn.onclick = () => pick(true);
    const drop = $('#upDrop', el)!;
    upDropZone(drop, drop, (items) => take(items));
    const off = bgUploadOnChange(() => { if (!stat.isConnected) { off(); return; } paint(); });
    next.onclick = () => { off(); goScene(nextScene('upload')!); };
    skip.onclick = () => { off(); goScene(nextScene('upload')!); };
    paint();
  }
  /** 올린 파일이 어떻게 되는지 한 줄(#5060) — «정리해 둘게요» 는 서버가 그 갈래(files)를 실제로 세웠을 때만. 관리 권한이 없거나 띄울 AI 가 없으면 세우지 않는다. */
  function filesFate(): string {
    return appliedFlow === 'files' ? OB_COPY.uploadLater : !S.serverAi ? OB_COPY.uploadNoServerAi : OB_COPY.uploadKept;
  }

  /** 장면 안에 한 줄 말한다(그 장면의 본문 자리를 갈아끼운다). */
  function say(el: HTMLElement, html: string) {
    const body = $('#cxBody', el);
    if (body) body.innerHTML = `<p class="ob-q-help">${html}</p>`;
  }

  /**
   * 처음 설정 반영 — **여기가 실제로 워크스페이스를 바꾸는 자리다**(이름·완료 표식). 실패하면 끝났다고 말하지 않는다(표식도 안 남긴다).
   *  (#4970) 서랍·용도·직무는 더 묻지 않는다 — 없는 채로 보낸다(지어내지 않는다). 팀 구조는 서버가 관리 권한으로 가른다.
   */
  /** 반영이 돌려준 정리 지시의 갈래(#5060 — connect · files · null). */
  let appliedFlow: string | null = null;
  async function finishOnboarding(next: 'connect' | 'later'): Promise<boolean> {
    S.scene = 'done'; save();
    //  (#5060) 올린 파일과 다음 걸음 — 서버가 이것으로 정리 지시(리브 2턴)의 갈래를 정한다.
    //   upload: 고른 것이 실패 없이 전부 올라갔을 때만 'done'(uploadVerdict) — 실패가 남았거나 새로고침으로 대기열을 잃었으면 'running'
    //   (서버가 상한 뒤 있는 것으로 시작한다). next: PC 의 AI 를 고른 사람은 서버에서 연결 대화를 열지 않으므로 늘 later
    //   (서버 AI 가 있으면 올린 파일 정리는 서버 리브 세션이 맡는다 — files 갈래).
    const upload = S.uploaded ? uploadVerdict(bgUploadState(), S.uploaded) : undefined;
    try {
      const applied: any = await api('/api/ui/me/welcome', { method: 'POST', body: JSON.stringify({
        name: S.nameSet ? S.name : null,
        ...(upload ? { upload } : {}),
        next: S.viaPc ? 'later' : next,
      }) });
      appliedFlow = applied && typeof applied.flow === 'string' ? applied.flow : null;
      //  반영이 «아직 올라가는 중» 으로 나간 사이에 올리기가 끝났으면, 그 «끝» 알림은 찍을 자리(반영 전)가 없어 버려졌다 — 한 번 더 잰다(멱등).
      if (upload === 'running') { welcomeUploadExpected = S.uploaded; welcomeUploadSentAt = -1; postUploadDoneIfSettled(); }
    } catch (e: any) {
      toast(`정리하다 막혔어요. ${(e && e.message) || '알 수 없는 오류'} — 잠시 뒤 다시 눌러 주세요.`);
      S.scene = 'connect-ask'; save();
      return false;
    }
    try { localStorage.setItem(OB_DONE_KEY, '1'); } catch (e) { /* 사파리 프라이빗 */ }
    try { if (state.me) (state.me as { welcome_pending?: boolean }).welcome_pending = false; } catch (_) { /* 비치명 */ }   // 홈의 «이어서 하기» 줄을 내린다(#2232)
    //  끝났으니 «하다 만 자리» 저장을 멈춘다(#2207). 늦게 도착한 push 하나가 자리표를 되살리면 다음 로그인이 다시 온보딩으로 간다.
    pushOff = true; if (pushT) clearTimeout(pushT); pushT = null;
    ctx.onDone && ctx.onDone();
    return true;
  }

  /** [연결할게요] — 반영 → 연결 세션 열기. AI 가 있으면 그 세션으로 가고, 없으면 이 자리에 «쓰는 AI 에서 하기» 를 그린다. */
  async function connectYes(el: HTMLElement, yes: HTMLButtonElement, later: HTMLButtonElement) {
    yes.disabled = true; later.disabled = true; yes.textContent = '확인하고 있어요…';
    if (!(await finishOnboarding('connect'))) { yes.disabled = false; later.disabled = false; yes.textContent = OB_COPY.connectYes; return; }
    //  (#4970) AI 연결에서 «PC에서 쓰는 AI로» 를 골랐다 — 서버 세션을 열지 않고 그 AI 에서 하는 세 걸음을 바로 그린다.
    if (S.viaPc) { showOwnAi(el); return; }
    await openOrGuide(el);
  }
  /** «쓰는 AI 에서 하기» 세 걸음 — 처음 설정은 이미 끝났다(돌아와도 막다른 길에 다시 갇히지 않게). */
  function showOwnAi(el: HTMLElement) {
    const body = $('#cxBody', el); if (!body) return;
    //  (#5060) 파일을 올렸는데 서버에 AI 가 없다 — 그 파일이 지금은 자료로만 남는다는 것을 숨기지 않는다.
    body.innerHTML = `${ownAiStepsHtml()}
      ${S.uploaded ? `<p class="ob-q-help">${esc(filesFate())}</p>` : ''}
      <button class="ob-q-skip" id="cxHome">홈으로 갈게요</button>`;
    wireOwnAiSteps(body);
    $<HTMLButtonElement>('#cxHome', body)!.onclick = () => { location.hash = '#/'; };
  }
  /** 처음 설정은 이미 끝났다 — 여기서 실패해도 연결을 못 연 사실만 말하고 갈 길을 남긴다. */
  async function openOrGuide(el: HTMLElement) {
    const body = $('#cxBody', el); if (!body) return;
    let r: Awaited<ReturnType<typeof openConnectSession>>;
    try { r = await openConnectSession({ fromWelcome: true }); }
    catch (e: any) {
      body.innerHTML = `<p class="ob-q-help">연결을 도와드릴 대화를 열지 못했어요. ${esc((e && e.message) || '')}</p>
        <button class="ob-btn ob-btn-pri" id="cxRetry">다시 시도할게요</button>
        <button class="ob-q-skip" id="cxHome">홈으로 갈게요</button>`;
      $<HTMLButtonElement>('#cxRetry', body)!.onclick = () => { body.innerHTML = '<p class="ob-q-help">다시 열고 있어요.</p>'; void openOrGuide(el); };
      $<HTMLButtonElement>('#cxHome', body)!.onclick = () => { location.hash = '#/'; };
      return;
    }
    //  (#5060) 연결 대화를 묶는 쓰기(서버 markWelcomeSession)가 welcome 을 통째로 다시 쓴다 — 그 사이에 «올리기 끝» 이 찍혔으면 지워질 수 있다.
    //   한 번 더 잰다(서버가 처음 시각을 지킨다 — 멱등). 격리 리뷰 2026-10-27.
    welcomeUploadSentAt = -1; postUploadDoneIfSettled();
    if (r.ai) {
      say(el, '연결을 도와드릴 대화를 열었어요. 그 자리로 모시겠습니다.');
      await sleep(900);
      location.hash = r.href;
      return;
    }
    //  로그인된 AI 가 없다 — 처음 설정은 이미 끝난 것으로 둔다(돌아와도 막다른 길에 다시 갇히지 않게).
    showOwnAi(el);
  }

  function renderScene(key: string, animate?: boolean) {
    const sc = SCENES[key];
    if (!sc) return;
    //  인사·이름은 민낯이다 — 셸이 뒤에 비치면 «설정을 시작하기 전» 이라는 장면이 흐려진다(#1631).
    setStage(key === 'intro' || key === 'name' ? 'stage-name' : 'stage-q');
    host.dataset.scene = key;   // 장면 이름표 — 장면별 CSS(41-onboarding.css `.ob-root[data-scene=…]`)의 축
    const col = $('#qcol')!;
    col.style.animation = 'none';
    if (animate !== false) { void col.offsetWidth; col.style.animation = ''; }
    col.classList.toggle('ob-intro', key === 'intro');
    col.innerHTML = sc.html();
    syncBack();
    sc.bind && sc.bind(col);
  }
  /* 뒤로가기는 **지나온 자취**를 되짚는다. */
  function goBack() { const prev = S.trail.pop(); if (!prev) return; save(); goScene(prev, { back: true }); }
  /* 뒤로가기 버튼은 이동줄에 하나만 두고 켜고 끈다. */
  function syncBack() {
    const b = $<HTMLButtonElement>('#obBack'); if (!b) return;
    b.hidden = !S.trail.length;
    b.onclick = () => goBack();
  }
  /* 브라우저 뒤로가기 — 쌓아 둔 장면이 있으면 그 한 걸음을 먹고, 없으면 셸이 하던 대로 나간다.
   * ⚠ **popstate 는 «뒤로» 전용이 아니다**(#2207 실측 2026-08-27). 같은 문서 안에서 해시가 바뀌는 이동이면 브라우저가 전부 popstate 를
   *  띄운다 — 사람이 사이드바로 **나가는** 순간에도. 그래서 우리가 쌓은 걸음에 순번(obSeq)을 찍고, 되돌아온 자리의 순번이 **지금보다 뒤**일
   *  때만 «뒤로» 로 읽는다. */
  function onPop(ev: PopStateEvent) {
    const st = ev && ev.state;
    if (!st || typeof st.obSeq !== 'number' || st.obSeq >= obSeq) return;   // 앞으로 나가는 이동 — 우리 일이 아니다
    obSeq = st.obSeq;
    if (!S.trail.length) return;                 // 더 물러날 곳이 없다 → 홈으로 나가는 게 맞다
    goBack();
    // 우리가 한 걸음 먹었으니 그만큼 다시 쌓아 둔다 — 다음 뒤로가기도 이 안에서 듣는다.
    try { history.pushState({ ob: S.scene, obSeq: ++obSeq }, '', location.href); } catch (_) { /* noop */ }
  }
  addEventListener('popstate', onPop);
  /* (#5031) 이 서버에서 쓸 개인 계정(격리 박스의 box_<사람>)은 여기서 미리 만들지 않는다 — 사람이 AI 장면에서 서버 AI 의 [연결]을 누를 때
   *  만든다(onboarding-ai.ts). 종전(#4970)엔 인사 장면에서 미리 시작해, «PC에서 쓰는 AI로» 를 고를 사람도 계정 · 구성원 몫 클로드·챗GPT 설치
   *  (≈700MB · 20초 남짓)를 치렀다. */
  function goScene(key: string, opts?: { back?: boolean }) {
    if (!(opts && opts.back) && S.scene && S.scene !== key && STEP_OF[key] != null) {
      S.trail.push(S.scene);
      //  주소(해시)는 **바꾸지 않는다** — 바꾸면 셸 라우터가 화면을 새로 그린다. 같은 주소로 state 만 쌓아 popstate 때 우리가 먼저 받는다.
      try { history.pushState({ ob: key, obSeq: ++obSeq }, '', location.href); } catch (_) { /* 사파리 프라이빗 */ }
    }
    S.scene = key; save();
    renderScene(key, true);
    syncBack();
  }

  /* ── 이어서 열기 (#2207) — 탭에 남은 것이 없을 때만 서버에 묻는다 ── */
  /** 저장된 장면 → 지금 열 장면. 옛 판(장면 11개 시절)의 자리도 알아본다 — 팀 소개면 이름, 반영 중이었으면 마지막 물음, 그 밖은 AI 연결. 못 열 자리면 null. */
  function fitScene(scene: unknown): string | null {
    const k = String(scene || '');
    if (STEP_OF[k] != null) return k;
    if (k === 'team') return 'name';
    //  'done' = 반영을 누른 뒤 그게 실패했거나 끊긴 자리 → 마지막 물음.
    if (k === 'done') return 'connect-ask';
    //  그 밖 = 옛 판의 질문 장면들(이름 뒤에 있었다 — AI 고르기·AI 연결도) → AI 연결부터(#4970: AI 연결이 외부 앱 앞이다).
    return k ? 'ai' : null;
  }
  async function loadWelcome(): Promise<any> { try { return await api('/api/ui/me/welcome'); } catch (_) { return null; } }
  /** 서버에 남은 자리로 화면을 연다. 못 물으면 처음부터 — 온보딩이 **안 열리는** 것보다 낫다. */
  async function resumeFromServer() {
    if (destroyed) return;
    setStage('stage-name');
    const col0 = $('#qcol')!;
    col0.innerHTML = '';
    //  #1631 — 기다리는 말은 **조금 기다린 뒤에만** 띄운다(처음 오는 사람에게는 «지난번» 이 없다).
    const waitT = setTimeout(() => {
      if (destroyed) return;
      col0.innerHTML = `<div class="ob-q-top"><div class="ob-q-ic">L</div></div>
      <p class="ob-q-help">지난번에 어디까지 하셨는지 보고 있어요.</p>`;
    }, RESUME_HINT_MS);
    const got = await Promise.race([loadWelcome(), sleep(RESUME_WAIT_MS)]);
    clearTimeout(waitT);
    if (destroyed) return;                 // 기다리는 사이에 화면을 떠났다 — 없는 화면에 그리지 않는다
    const p = got && (got as any).progress;
    const scene = p && p.state && typeof p.state === 'object' ? fitScene(p.scene) : null;
    if (scene) {
      S = Object.assign(fresh(), pickState(p.state), { scene });
      saveLocal();          // 이 탭에도 얹어 둔다 — 이제부터는 이 탭이 정본이다(서버로 다시 밀지 않는다)
      goScene(S.scene);
      toast('지난번에 하시던 자리에서 이어 갑니다.');
      return;
    }
    //  처음부터 — 답한 것이 없는 탭의 저장본(인사·이름에 멈춘 것)은 첫 장면으로 되돌린다. 자취도 비운다.
    if (BEFORE_ANSWER.includes(S.scene)) { S.scene = ORDER[0]!; S.trail = []; }
    goScene(fitScene(S.scene) || ORDER[0]!);
  }

  /* ── 부팅 ── */
  //  지금 이 히스토리 자리에 **출발점 도장(obSeq 0)** 을 찍는다 — 이게 있어야 첫 걸음에서의 «뒤로» 가 «되돌아온 것» 으로 읽힌다(#2026).
  //  ⚠ 셸이 찍어 둔 값(v2i 등)은 **보존한다** — 통째로 갈아끼우면 셸의 앞/뒤 화살표 판정이 무너진다.
  try { history.replaceState({ ...(history.state || {}), ob: S.scene, obSeq: 0 }, '', location.href); } catch (_) { /* 사파리 rate limit */ }
  // 장면 바로 열기 — 셸에선 질의가 해시 뒤에 붙는다(#/welcome?scene=connect-ask). 검토용.
  const want = new URLSearchParams(location.search).get('scene') || new URLSearchParams((location.hash.split('?')[1] || '')).get('scene');
  if (want && STEP_OF[want] != null) goScene(want);
  else if (hadLocal) { goScene(fitScene(S.scene) || ORDER[0]!); schedulePush(); }
  else void resumeFromServer();
  return { destroy() {
    destroyed = true;
    if (toastT) clearTimeout(toastT);
    removeEventListener('popstate', onPop);
    removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onLeave);
    void flushProgress();          // 화면을 떠나는 것도 '중간에 나간 것'이다 — 마지막 한 걸음을 남긴다
    ctx.onBare && ctx.onBare(false);
    ctx.onGhost && ctx.onGhost(false);   // 유령 셸도 반드시 푼다 — 어떤 길로 나갔든(#2232)
  } };
}
