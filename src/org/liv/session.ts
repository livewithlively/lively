// 리브 세션(#1631 · #4032) — 리브는 사람마다(워크스페이스마다) 하나인 **진짜 세션**이다.
//
//  ── 왜 진짜 세션인가 ──
//  리브 v1(2026-08-14)은 턴마다 헤드리스 `claude -p` 를 **게이트웨이가 도는 기계의 tmux** 에 띄웠다(spawnTaskSession).
//  그땐 보통 세션을 말풍선으로 그릴 길이 없었고(세션 대화창은 08-18 에 생겼다), 게이트웨이와 세션이 같은 기계의 tmux 를 썼다.
//  매니지드는 보통 세션을 노드의 세션 컨테이너에서 띄운다(LIVELY_SESSION_ENSURE · LIVELY_TMUX_EXEC). 헤드리스 경로는 그리로
//  옮겨지지 않아 리브 탭 [보내기]가 전부 500 이었다 — 판이 CP 호스트에서 sudo 로 즉사하고 다음 `tmux set-option` 이
//  «no server running» 으로 던졌다(#4032 게이트웨이 로그 실측). 그래서 리브도 홈 입력창과 **같은 문**(launchSession)으로 여는
//  보통 세션이 됐다(상민님 결정 2026-09-16).
//
//  ── 한 사람에 세션 하나 ──
//  · 레일 [리브] · 처음 설정 [연결할게요] · [외부 앱 연결] [연결 도와줘] · 증류 2턴이 **같은 세션**을 본다(#4970 «리브 = 세션 하나»,
//    상민님 결정 2026-10-22 — 입구는 하나, 일감만 다르다: me_liv_open). 좌표는 liv_profile.liv_session(워크스페이스 층)이고,
//    없으면 옛 처음 설정 킥오프가 연 세션(welcome.session_id)이 폴백이다.
//  · 세션이 회수돼 복원되면 새 id 가 된다 — 좌표는 복원 이정표(resolveSessionSuccessor)를 따라가 읽고, 읽은 김에 고쳐 적는다.
//  · 작업 폴더는 <개인 루트>/liv 다 — 리브 부팅 훅(org_hook liv-session-boot)의 게이트가 basename(cwd) === "liv" 다.
//    이 폴더가 아니면 그 세션은 리브의 정체성·현황을 못 받는다.
//  · 그 폴더는 라이블리가 정한 자리라, 서버가 task 종류로 연 리브 세션은 세션 생성이 신뢰 대화상자를 대신 수락한다
//    (terminal/session-create-guards.ts — 종류 task 는 요청으로 못 만들어서, 사람이 같은 이름의 폴더를 골라 연 세션과 갈린다).
//    이게 빠지면 첫 말이 그 물음 앞에서 멈춘다(2026-09-16 매니지드 실측 — 아웃박스 trust_ok=false 로 sending 고착).
//  · 종류는 task — 첫 지시가 서버 조립물일 수 있어(킥오프·2턴) 이름 짓기·첫 지시 프로젝트 자동 생성 훅이 건너뛴다(#1979 항목4).
//  · 도구 제한은 두지 않는다(상민님 결정 2026-09-16) — 보통 세션과 같은 승인 흐름을 탄다.
import type { LivelyUser } from "../../context.js";
import type { LaunchedSession } from "../../terminal/session-launch.js";
import { logger } from "../../log.js";
import { LIV_SUBPATH } from "./folder.js";

//  리브 폴더 이름은 잎 모듈(folder.ts)에 있다 — 세션 생성의 신뢰 판정도 같은 값을 본다.
export { LIV_SUBPATH };
/**
 * 리브 세션의 이름(사람이 사이드바에서 보는 이름). (#4970) 화면은 이 글자로 리브 세션을 알아보지 않는다 — 셸이 리브 좌표
 *  (liv_profile.liv_session)로 알아본다. 서버의 리브 답 알림(answer-notify)이 좌표를 못 읽을 때의 보조 단서로만 쓴다.
 *  킥오프 세션 이름은 kickoff.ts LIV_SESSION_LABEL 이다.
 */
export const LIV_CHAT_LABEL = "리브 — 대화";
/** 첫 말 상한 — 사람이 채팅창에 치는 양이다(자료 본문은 올리기로 간다). */
export const LIV_PROMPT_MAX = 8000;

/** (순수) 저장된 좌표 — 리브 탭이 적은 것이 먼저, 없으면 처음 설정 킥오프가 연 세션. */
export function storedLivSession(p: {
  liv_session?: { id?: string | null } | null;
  welcome?: { session_id?: string | null } | null;
} | null | undefined): string | null {
  //  칸마다 따로 다듬는다 — 빈칸(공백)인 리브 좌표가 킥오프 폴백을 가리면 안 된다.
  const clean = (v: unknown): string => String(v ?? "").trim();
  return clean(p?.liv_session?.id) || clean(p?.welcome?.session_id) || null;
}

export interface LivSessionFacts {
  /** 저장된 좌표. */
  stored: string | null;
  /** 그 id 의 desired-state 행(없으면 null). */
  state: { owner?: string | null; superseded_by?: string | null } | null;
  /** 복원 이정표·대화로 찾은 이어진 세션(없으면 null). 행이 살아 있으면 묻지 않는다. */
  successor: string | null;
  /** 좌표가 휴지통에 들어 있나. */
  trashed: boolean;
  /** 이 사람의 id. */
  me: string;
}

/**
 * (순수) **지금의 리브 세션**을 정한다. null 이면 리브 탭의 첫 말이 새로 연다.
 *  · 좌표가 없거나 휴지통에 있으면 없다 — 버린 세션에 다시 붙이면 입력도 못 하는 기록 화면에 갇힌다.
 *  · 행이 남의 것이면 없다(좌표는 본인 프로필에서만 나오지만, 틀린 값이 남의 세션을 열게 두지 않는다).
 *  · 행이 살아 있으면(이정표 없음) 그 id.
 *  · 이어졌거나 행이 없으면 복원 사슬의 끝. 끝을 못 찾으면 이정표가 있을 때만 그 이정표, 행도 없으면 없다.
 */
export function pickLivSession(f: LivSessionFacts): string | null {
  if (!f.stored || f.trashed) return null;
  if (f.state && f.state.owner && f.state.owner !== f.me) return null;
  if (f.state && !f.state.superseded_by) return f.stored;
  return f.successor || f.state?.superseded_by || null;
}

/**
 * 지금의 리브 세션 id — 없으면 null. 좌표가 옛 id 면 고쳐 적는다(heal — 비치명).
 *  o.heal=false 는 **읽기만** 한다 — 조회(GET) 창구가 쓰기를 하지 않게(읽기전용 판정은 메서드로 가른다). 사슬은 매번 따라가므로 답은 같다.
 */
export async function currentLivSessionId(userId: string, o: { heal?: boolean } = {}): Promise<string | null> {
  if (!userId) return null;
  const { getLivProfile, setLivSession } = await import("../store.js");
  const prof = await getLivProfile(userId).catch(() => null);
  const stored = storedLivSession(prof);
  if (!stored) return null;
  const { getSessionState, resolveSessionSuccessor } = await import("../../sessions/session-state.js");
  const { trashMarkedIds } = await import("../../sessions/session-trash.js");
  const [state, trashedIds] = await Promise.all([
    getSessionState(stored).catch(() => undefined),
    trashMarkedIds(userId, [stored]).catch(() => [] as string[]),
  ]);
  const alive = !!state && !state.superseded_by;
  const successor = alive ? null : await resolveSessionSuccessor(stored).catch(() => null);
  const id = pickLivSession({ stored, state: state ?? null, successor, trashed: trashedIds.length > 0, me: userId });
  if (o.heal !== false && id && id !== prof?.liv_session?.id) {
    await setLivSession(userId, { id, at: new Date().toISOString() })
      .catch((err) => logger.warn({ err, member: userId, session: id }, "리브 세션 좌표 갱신 실패(비치명)"));
  }
  return id;
}

export interface OpenedLivSession { session_id: string; harness: string; label: string; session: LaunchedSession }

/**
 * 리브 세션을 **새로** 연다 — 홈 입력창과 같은 문(launchSession: 세션 생성 → 워크스페이스 맵 → 앱 인스턴스).
 *  첫 지시는 initialPrompt 로 넘긴다(입력창이 뜨면 아웃박스가 넣는다 — 여기서 send-keys 를 치지 않는다).
 *  연 세션을 이 워크스페이스의 리브 좌표로 적는다. 실패는 던진다(부르는 쪽이 사람에게 이유를 말한다).
 */
export async function openLivSession(user: LivelyUser, o: { prompt: string; label: string; harness?: string | null }): Promise<OpenedLivSession> {
  const userId = user?.userId;
  if (!userId) throw new Error("인증된 사용자가 아닙니다");
  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) throw new Error("첫 지시가 비어 있습니다");
  // 동적 import — terminal/* 는 tmux·pty 를 끌고 오는 무거운 모듈이고 org/* 에서 정적으로 걸면 순환(check-imports) 위험.
  const { resolveHeadlessHarness } = await import("../../node/headless-harness.js");
  const { launchSession } = await import("../../terminal/session-launch.js");
  //  하네스는 그 사람이 **로그인한 것**(claude 하드코딩 금지, #1884). 비용 주체 = 사용자.
  //  (#4970) 부르는 쪽이 고른 하네스(me_liv_open — 로그인한 것 가운데 세션으로 띄울 수 있는 첫 번째)는 **그대로** 쓴다. 리브 세션은 보통
  //   대화형 세션이라 헤드리스(위탁) 지원표로 거르지 않는다 — 거르면 그 표에 없는 하네스(opencode)로만 로그인한 사람에게 리브가 안 열린다(503).
  const harness = String(o.harness ?? "").trim() || await resolveHeadlessHarness(userId, null);
  //  (#4970) 모델·추론강도는 새 세션 화면의 기본과 같게 지정한다(catalog.sessionFlagDefaults) — 비우면 그 계정의 CLI 기본으로 떠서
  //   무엇으로 도는지 라이블리가 말할 수 없었다. 사람이 보면서 하는 대화라 무인 자동화 기본(AUTOMATION_DEFAULTS)이 아니다.
  //  (#5058 원준님 2026-10-27 «오토모드로») 리브 세션은 **오토모드**로 연다 — 그 하네스의 autoModeArgv(claude --permission-mode auto ·
  //   codex --approve-for-me), 없으면 자동 승인(catalog.ts AUTO_MODE_FLAG). 리브는 처음 설정·앱 연결을 대신 하며 도구를 연달아 부른다.
  //   승인 대기로 열면 Codex 는 도구마다 멈추고, 그 물음은 대화 칸에 안 떠 사람은 «진척이 안 된다» 만 본다(Codex 의 Shift+Tab 은 권한이 아니라
  //   계획 모드 전환이라 사람이 풀 길도 없다). 전부 건너뛰는 자동 승인으로 하지 않는 이유: 리브는 노션·올린 파일 같은 남의 글을 읽는다 —
  //   그 안의 지시가 승인·샌드박스 없이 돌면 안 된다(격리 리뷰). 사람이 만든 세션의 기본은 그대로다.
  const { sessionFlagDefaults, AUTO_MODE_FLAG } = await import("../../terminal/catalog.js");
  const session = await launchSession(user, {
    kind: "task",
    label: o.label,
    rootKey: "personal", subpath: LIV_SUBPATH,
    harness, flags: { ...sessionFlagDefaults(harness), [AUTO_MODE_FLAG]: "1" }, autoApprove: false,
    initialPrompt: prompt,
  }, { nodeId: "", invites: [] });
  const { setLivSession } = await import("../store.js");
  await setLivSession(userId, { id: session.id, at: new Date().toISOString() })
    .catch((err) => logger.warn({ err, member: userId, session: session.id }, "리브 세션 좌표 기록 실패 — 다음 리브 탭 첫 말이 세션을 또 열 수 있다"));
  return { session_id: session.id, harness, label: session.label, session };
}

/**
 * (도구) 같은 열쇠의 비동기 일을 **한 줄로 세운다** — 앞 일이 끝나야 뒤 일이 시작한다. 다른 열쇠는 서로 기다리지 않는다.
 *  앞 일이 실패해도 뒤 일은 돈다(뒤 일은 처음부터 다시 판정한다). 끝난 열쇠는 지운다(열쇠가 사람 수만큼 쌓이지 않게).
 */
export function serialByKey(): { run<T>(key: string, fn: () => Promise<T>): Promise<T>; size(): number } {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const mine = prev.catch(() => undefined).then(fn);
      tails.set(key, mine);
      try { return await mine; } finally { if (tails.get(key) === mine) tails.delete(key); }
    },
    size: () => tails.size,
  };
}

/**
 * 같은 사람의 «리브 세션 확보» 를 한 줄로 — 리브 탭을 두 개 열어 두고 동시에 보내면 세션이 둘 서는 자리다.
 *  게이트웨이는 한 프로세스가 여러 워크스페이스를 받으므로 열쇠에 워크스페이스를 넣는다.
 */
const opening = serialByKey();

export interface EnsuredLivSession { session_id: string; created: boolean; session?: LaunchedSession; harness?: string }

export interface EnsureLivOpts {
  /**
   * 새로 열 때만 부른다 — 그 세션을 띄울 하네스. null 이면 로그인한 AI 가 없다는 뜻이라 **열지 않고** null 을 돌려준다
   *  (화면이 «쓰는 AI 에서 하기» 를 그린다). 생략하면 resolveHeadlessHarness 의 기본을 쓴다.
   *  로그인 확인은 비싸다(자격 파일이 없을 때 프로브 — 실측 4.3초·상한 25초) — 그래서 세션이 이미 있으면 묻지 않는다.
   */
  harness?: () => Promise<string | null>;
}

/**
 * 리브 세션을 확보한다 — 이미 있으면 **그 세션 id 만 돌려주고 말은 넣지 않는다**(넣는 것은 부르는 쪽 몫 — me_liv_open 이
 *  세션에 넣는다). 없으면 그 말을 첫 지시로 새로 연다. 로그인한 AI 가 없으면(o.harness 가 null) null.
 */
export async function ensureLivSession(user: LivelyUser, text: string, o: EnsureLivOpts = {}): Promise<EnsuredLivSession | null> {
  const userId = user?.userId;
  if (!userId) throw new Error("인증된 사용자가 아닙니다");
  const { currentTenant } = await import("../tenant-context.js");
  return await opening.run(`${currentTenant()?.id ?? ""}|${userId}`, async () => {
    const cur = await currentLivSessionId(userId);
    if (cur) return { session_id: cur, created: false };
    const harness = o.harness ? await o.harness() : undefined;
    if (harness === null) return null;
    const made = await openLivSession(user, { prompt: text, label: LIV_CHAT_LABEL, harness });
    return { session_id: made.session_id, created: true, session: made.session, harness: made.harness };
  });
}
