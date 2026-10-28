// delivery ▸ liv-chat — 화면이 리브를 여는 창구(#1631 · #4032 · #4970). 리브는 **진짜 세션**이다(org/liv/session.ts).
//
//  ── 무엇이 바뀌었나(#4032, 상민님 결정 2026-09-16) ──
//  종전엔 리브 탭의 한 마디가 헤드리스 한 턴이었다(me_liv_turn → spawnTaskSession). 그 경로는 게이트웨이가 도는 기계의 tmux 를
//  직접 불러, 세션을 노드의 세션 컨테이너에 띄우는 매니지드에서는 한 번도 안 떴다(500 — 판이 sudo 에서 즉사, 다음 set-option 이
//  «no server running»). 그래서 리브는 그 사람의 리브 세션 하나가 됐다.
//
//  ── 입구 하나, 일감만 다르다(#4970 «리브 = 세션 하나», 상민님 결정 2026-10-22) ──
//  레일 [리브] · 처음 설정 [연결할게요] · [외부 앱 연결] [연결 도와줘] · 리브 칸의 [제가 해 드릴게요]가 **같은 리브 세션**으로 간다.
//   첫 지시만 다르다(LIV_JOBS) — 그 말은 사람에게 그대로 보인다(숨길 이유가 없고, 사람이 같은 말을 자기 AI 에서 다시 쓸 수 있다).
//  · 리브 세션이 없으면 그 말을 첫 지시로 연다. 띄울 하네스는 그 사람이 로그인한 것 가운데 첫 번째 — 특정 하네스를 우대하지 않는다.
//    로그인한 AI 가 없으면 열지 않고 ai:false — 화면이 «쓰는 AI 에서 하기» 를 그린다.
//  · 있으면 그 세션에 말을 넣는다 — 홈 입력창·2턴과 같은 통로(deliverPromptForMember). 못 넣었으면(멈춘 세션 등) delivered:false 로
//    알리고 화면이 그 말을 입력칸에 돌려 둔다 — 사람이 보내면 대화창이 세션을 되살리며 넣는다.
//  · ⚠ 좌표를 welcome.session_id 에 넣지 않는다 — 거기 있으면 리브 2턴(증류 지시) 후보가 돼 대화 한복판에 서버 지시가 끼어든다.
//    좌표는 리브 세션 모듈이 liv_profile.liv_session 에 적는다.
//    (#5060) 예외 하나 — 처음 설정의 [연결할게요](from:"welcome")가 연 연결 대화. 처음 설정 반영이 갈래를 connect 로 찍어 두었으면
//    그 세션을 welcome.session_id 에 적는다. connect 갈래의 2턴은 리브가 연결을 마쳤다고 찍을 때(collect_done)까지 기다리므로 대화
//    한복판에 끼어들지 않고, 연결이 끝나면 올린 파일·모은 자료로 카테고리·정리 규칙을 세우는 지시가 같은 대화에 이어서 온다.
//
//  ── mcp:false ──
//  이 문들은 **화면이 리브를 여는 자리**다. 리브가 자기를 다시 부르면 세션이 겹쳐 선다.
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";
import { LIV_PROMPT_MAX, currentLivSessionId, ensureLivSession, type EnsuredLivSession } from "../../org/liv/session.js";
import { currentTenant } from "../../org/tenant-context.js";
import { logger } from "../../log.js";

const currentTenantId = (): string => currentTenant()?.id ?? "";

/** (순수) 첫 말 검사 — 비었으면 400, 상한을 넘으면 몇 자 넘었는지 말하는 400. 통과하면 다듬은 글. */
export function livFirstWords(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new HttpError(400, "할 말이 비어 있습니다");
  if (text.length > LIV_PROMPT_MAX) throw new HttpError(400, `한 번에 보낼 수 있는 글자 수를 넘었습니다(${text.length} > ${LIV_PROMPT_MAX})`);
  return text;
}

/** 문마다 리브에게 건네는 첫 말 — 사람에게 그대로 보인다. 스킬 이름을 넣어 자동 호출이 빗나가도 사람이 알아본다. */
export const LIV_JOBS = {
  /** 레일 [리브] — 워크스페이스 점검. */
  liv: "liv 스킬로 이 워크스페이스를 점검해 줘.",
  /** 처음 설정 [연결할게요] · [외부 앱 연결] [연결 도와줘] — 외부 앱 연결(입구 스킬이 앱마다 상태를 보고 앱별 스킬로 넘긴다). */
  connect: "liv-connect 스킬로 이 워크스페이스의 외부 앱 연결을 도와줘.",
} as const;
export type LivJob = keyof typeof LIV_JOBS;

/** (순수) 리브에게 넣을 말 — 글(text)을 주면 그 글(첫 말 규칙대로), 없으면 일감(job, 기본 liv)의 정해진 말. 모르는 일감은 400. */
export function livInstruction(input: { job?: unknown; text?: unknown } | null | undefined): string {
  if (input?.text !== undefined && input?.text !== null) return livFirstWords(input.text);
  const job = input?.job === undefined || input?.job === null || input?.job === "" ? "liv" : String(input.job);
  if (!Object.prototype.hasOwnProperty.call(LIV_JOBS, job)) throw new HttpError(400, `모르는 일입니다: ${job}`);
  return LIV_JOBS[job as LivJob];
}

/** (순수) 맡긴 일감 — 글(text)을 주면 null(사람·카드가 쓴 말이라 같은 말을 다시 할 수 있다), 아니면 job(기본 liv). 모르는 일감은 null(livInstruction 이 400). */
export function livJobOf(input: { job?: unknown; text?: unknown } | null | undefined): LivJob | null {
  if (input?.text !== undefined && input?.text !== null) return null;
  const job = input?.job === undefined || input?.job === null || input?.job === "" ? "liv" : String(input.job);
  return Object.prototype.hasOwnProperty.call(LIV_JOBS, job) ? (job as LivJob) : null;
}

/** (순수) 리브 세션을 띄울 하네스 — 로그인한 것(순서 그대로) 가운데 세션으로 띄울 수 있는 첫 번째. 없으면 null. */
export function pickLivHarness(usable: readonly string[], launchable: readonly string[]): string | null {
  for (const k of usable) if (k && k !== "shell" && launchable.includes(k)) return k;
  return null;
}

/** 화면이 갈 곳 — 리브 세션 화면. */
export const livSessionHref = (id: string): string => `#/s/${encodeURIComponent(id)}`;

export type LivOpenResult =
  | { ai: false; reason: "ai-not-connected" | "no-session" }
  | { ai: true; session_id: string; href: string; created: true; harness?: string; session?: unknown; initialPrompt: string }
  | { ai: true; session_id: string; href: string; created: false; delivered: boolean; text: string; repeated?: true };

/**
 * 같은 **일감**(job — [연결할게요] · [연결 도와줘] · [리브와 대화 시작])을 같은 리브 세션에 이 사이 안에 두 번 넣지 않는다 — 단추를 두 번
 *  누르거나 «다시 시도» 가 성공한 첫 시도(새로 연 세션의 첫 지시 포함)와 겹치는 자리(격리 리뷰). 글(text — 카드의 «저장했어요» ·
 *  [제가 해 드릴게요])은 거르지 않는다: 자격을 둘 저장하면 같은 맞장구가 두 번 가야 한다.
 */
export const LIV_REPEAT_MS = 60_000;

/** 의존(시험 seam) — 실제 구현은 아래 realDeps. */
export interface LivOpenDeps {
  /** 지금의 리브 세션 id(없으면 null) — only_existing 일 때만 쓴다(새로 열지 않는다). */
  current: (userId: string) => Promise<string | null>;
  /** 리브 세션 확보 — 있으면 그 id, 없으면 그 말로 연다(하네스 물음은 열 때만). 로그인한 AI 가 없으면 null. */
  ensure: (user: LivelyUser, text: string, harness: () => Promise<string | null>) => Promise<EnsuredLivSession | null>;
  /** 이 사람이 로그인한 하네스(순서 그대로). */
  usable: (userId: string) => Promise<string[]>;
  /** 세션으로 띄울 수 있는 하네스. */
  launchable: () => Promise<readonly string[]>;
  /** 떠 있는 세션에 말을 넣는다(사람이 보낸 것과 같은 통로). 못 넣으면(멈춘 세션 포함) 던진다. */
  deliver: (sessionId: string, userId: string, text: string) => Promise<unknown>;
  /** 이 말을 이 세션에 방금(LIV_REPEAT_MS 안에) 넣었나 — 넣은 것만 센다(못 넣은 시도는 다시 넣을 수 있어야 한다). 없으면 거르지 않는다. */
  recent?: { seen: (key: string) => boolean; mark: (key: string) => void };
}

/**
 * 리브에게 일 맡기기 — 판정 순서: 말 검사 → (리브 세션 있음 → 넣기) / (없음 → 로그인 확인 → 그 말로 열기 · 없으면 ai:false).
 *  only_existing — 있는 리브 세션에만 넣는다(새로 열지 않는다). 카드의 맞장구(«자격 저장했어요»)가 세션이 사라진 사이 새 리브 세션의 첫 지시가
 *   되지 않게(격리 리뷰). 없으면 ai:false · reason no-session.
 */
export async function openLiv(user: LivelyUser, input: { job?: unknown; text?: unknown; only_existing?: unknown } | null | undefined, d: LivOpenDeps): Promise<LivOpenResult> {
  const userId = String(user?.userId ?? "");
  if (!userId) throw new HttpError(401, "인증이 필요합니다");
  const text = livInstruction(input);
  const job = livJobOf(input);
  let r: EnsuredLivSession | null;
  if (input?.only_existing === true) {
    const cur = await d.current(userId).catch(() => null);
    if (!cur) return { ai: false, reason: "no-session" };
    r = { session_id: cur, created: false };
  } else {
    const harness = async (): Promise<string | null> => {
      const [usable, launchable] = await Promise.all([d.usable(userId).catch(() => [] as string[]), d.launchable()]);
      return pickLivHarness(usable, launchable);
    };
    try {
      r = await d.ensure(user, text, harness);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      //  세션을 못 연 이유를 사람에게 그대로 말한다 — 이 자리의 실패가 500 «internal_error» 로 뭉개져 원인을 못 찾은 것이 #4032 였다.
      throw new HttpError(503, `리브를 열지 못했습니다 — ${(e as Error)?.message ?? e}`, { cause: e });
    }
  }
  if (!r) return { ai: false, reason: "ai-not-connected" };
  const href = livSessionHref(r.session_id);
  //  같은 일감을 짧은 사이 두 번 넣지 않는다 — 새로 연 세션의 첫 지시도 «넣은 것» 으로 센다(열고 나서 «다시 시도» 가 또 넣던 자리).
  const key = job ? `${userId}|${r.session_id}|job:${job}` : null;
  if (r.created) {
    if (key) d.recent?.mark(key);
    return { ai: true, session_id: r.session_id, href, created: true, harness: r.harness, session: r.session, initialPrompt: text };
  }
  if (key && d.recent?.seen(key)) return { ai: true, session_id: r.session_id, href, created: false, delivered: true, text, repeated: true };
  const delivered = await d.deliver(r.session_id, userId, text).then(() => true, () => false);
  if (delivered && key) d.recent?.mark(key);
  return { ai: true, session_id: r.session_id, href, created: false, delivered, text };
}

/** (순수) 넣은 말 기억 — 열쇠마다 넣은 시각. 오래된 것은 볼 때 걷는다(사람 수 × 말 수만큼 쌓이지 않게). */
export function livRecentMemo(now: () => number = Date.now, ttl: number = LIV_REPEAT_MS): { seen: (key: string) => boolean; mark: (key: string) => void } {
  const at = new Map<string, number>();
  const sweep = (t: number): void => { for (const [k, v] of at) if (t - v >= ttl) at.delete(k); };
  return {
    seen: (key) => { const t = now(); sweep(t); return at.has(key); },
    mark: (key) => { const t = now(); sweep(t); at.set(key, t); },
  };
}
const recentDeliveries = livRecentMemo();

/**
 * (#5060) 처음 설정의 연결 대화를 2턴 대상으로 묶는다 — 반영(me_welcome_apply)이 갈래를 connect 로 찍었고 아직 세션이 없을 때만.
 *  그 밖(갈래가 다르다 · 이미 묶였다 · 2턴이 이미 나갔다)은 건드리지 않는다. 실패해도 연결은 연 것이다(비치명 — 로그만).
 */
async function markWelcomeSession(userId: string, sessionId: string): Promise<void> {
  if (!userId || !sessionId) return;
  try {
    const { getLivProfile, appendLivProfile } = await import("../../org/store.js");
    const w = (await getLivProfile(userId))?.welcome;
    if (!w || w.flow !== "connect" || w.session_id || w.distill_at) return;
    await appendLivProfile(userId, { welcome: { ...w, session_id: sessionId } });
  } catch (err) {
    logger.warn({ err, member: userId, session: sessionId }, "처음 설정 연결 대화를 2턴 대상으로 묶지 못함(비치명)");
  }
}

const realDeps: LivOpenDeps = {
  current: (userId) => currentLivSessionId(userId),
  ensure: (user, text, harness) => ensureLivSession(user, text, { harness }),
  usable: async (userId) => {
    const { memberUsableHarnesses } = await import("../../terminal/profiles.js");
    return memberUsableHarnesses(userId);
  },
  launchable: async () => {
    const { HARNESSES } = await import("../../terminal/catalog.js");
    return HARNESSES.map((h) => h.key).filter((k) => k !== "shell");
  },
  deliver: async (sessionId, userId, text) => {
    //  멈춘(회수된) 리브 세션이면 넣지 않는다 — 아웃박스는 «복원 가능» 이면 말을 들고만 있어, 사람이 대화창에서 다시 열 때까지 아무것도
    //   돌지 않는다(격리 리뷰). 못 넣었다고 알리면(delivered:false) 화면이 그 말을 입력칸에 돌려 두고, 보내는 순간 대화창이 되살리며 넣는다.
    //   생사를 모르면(null — 못 닿음) 종전대로 넣는다(아웃박스가 상한까지 들고 있는다).
    //  ⚠ 이 판정은 이 게이트웨이의 tmux 를 본다 — 멤버 PC(노드) 좌표의 세션이면 «여기 없다» 가 «멈췄다» 가 아니다(그쪽은 넣기 통로가 릴레이로 판단한다).
    //   리브 세션은 서버가 연다(노드 아님)지만, 넣기 통로(deliverPromptForMember)와 같은 기준으로 가른다(격리 리뷰).
    const { sessionGone, sessionGoneVerdict } = await import("../../terminal/tmux-exec.js");
    const { remoteNodeOfSession } = await import("../../node/registry.js");
    const node = await remoteNodeOfSession(sessionId, sessionGone).catch(() => null);
    if (!node && (await sessionGoneVerdict(sessionId)) === true) {
      logger.info({ member: userId, session: sessionId }, "리브 세션이 멈춰 있어 말을 넣지 않음 — 화면이 입력칸에 돌려 둔다(delivered:false)");
      throw new Error("리브 세션이 멈춰 있습니다");
    }
    const { deliverPromptForMember } = await import("../../terminal/deliver-prompt.js");
    return deliverPromptForMember(sessionId, userId, text);
  },
  recent: {
    //  워크스페이스마다 따로 센다 — 게이트웨이 한 프로세스가 여러 워크스페이스를 받는다(같은 사람 id 가 두 워크스페이스에 있을 수 있다).
    seen: (key) => recentDeliveries.seen(`${currentTenantId()}|${key}`),
    mark: (key) => recentDeliveries.mark(`${currentTenantId()}|${key}`),
  },
};

export const livChatCapabilities: Capability[] = [
  restRead("me_liv_session", "리브 세션 찾기",
    "이 사람이 이 워크스페이스에서 이어 가는 리브 세션 id(없으면 null). 세션이 복원돼 id 가 바뀌었으면 이어진 id 를 준다. " +
    "화면은 이 id 의 세션을 리브 세션으로 연다(대화가 본자리 · 오른쪽 «리브» 칸 · 물음 입력칸).",
    [{ method: "GET", paths: ["/api/ui/me/liv/session"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      //  조회는 읽기만 한다(heal:false) — 옛 좌표 고쳐 적기는 여는 문·2턴 스윕이 한다.
      return { session_id: await currentLivSessionId(userId, { heal: false }) };
    }),

  restRead("me_liv_open", "리브에게 일 맡기기",
    "리브 세션에 일을 맡긴다 — 리브 세션이 없으면 그 말을 첫 지시로 연다(created:true), 있으면 그 세션에 말을 넣는다(created:false · " +
    "delivered 가 넣었는지). 말은 text 로 주거나 job 으로 고른다(liv = 워크스페이스 점검 · connect = 외부 앱 연결). " +
    "로그인한 AI 가 없고 리브 세션도 없으면 열지 않고 ai:false — 그때 화면은 «쓰는 AI 에서 하기» 를 안내한다. " +
    "사람이 레일 [리브] · 처음 설정 [연결할게요] · [외부 앱 연결] [연결 도와줘] · 리브 칸에서 누르는 문이다.",
    [{ method: "POST", paths: ["/api/ui/me/liv/open"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const r = await openLiv(user, input, realDeps);
      if (input?.from === "welcome" && r.ai) await markWelcomeSession(String(user?.userId ?? ""), r.session_id);
      return r;
    },
    false,
    {
      job: z.enum(["liv", "connect"]).optional().describe("맡길 일(text 가 없을 때) — liv = 워크스페이스 점검(기본) · connect = 외부 앱 연결"),
      // ⚠ text 에 zod .max() 를 두지 않는다 — 상한 초과는 핸들러가 "몇 자 넘었는지"를 말해 주는 게 낫다(#1442).
      text: z.string().optional().describe("리브에게 할 말(주면 job 대신 이 말)"),
      only_existing: z.boolean().optional().describe("true 면 있는 리브 세션에만 넣는다(새로 열지 않는다 — 없으면 ai:false · reason no-session)"),
      from: z.enum(["welcome"]).optional().describe("(#5060) 처음 설정의 [연결할게요]가 부를 때 — 이 세션이 연결을 마친 뒤 증류 지시(2턴)를 받는다"),
    }),

  restRead("me_liv_ask_dismiss", "물음 접어두기",
    "리브가 걸어 둔 물음(자격·객관식·올리기)을 **사람이 지금은 안 하겠다**고 접는다. " +
    "접은 사실을 declined 에도 남겨, 다음 대화의 리브가 같은 걸 곧바로 다시 묻지 않게 한다.",
    [{ method: "POST", paths: ["/api/ui/me/liv/ask-dismiss"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile, setLivSecretAsk, appendLivProfile } = await import("../../org/store.js");
      const cur = await getLivProfile(userId);
      const ask = cur.secret_ask ?? null;
      if (!ask) return { ask: null, dismissed: false };
      // 무엇을 접었는지 남긴다 — 안 남기면 다음 턴의 리브가 같은 걸 또 묻고, 그게 잔소리가 된다.
      // kind 별로 식별자가 다르다(객관식=key · 자격=field · 올리기=없음). 셋 다 같은 모양의 키로 접는다.
      const a = ask as unknown as { kind?: string; key?: string; field?: string };
      const key = `ask.${a.kind ?? "secret"}.${a.key ?? a.field ?? ""}`.replace(/\.$/, "");
      await appendLivProfile(userId, {
        declined: { at: new Date().toISOString(), key, why: "지금은 안 하겠다고 화면에서 접음" },
      });
      return { ask: null, dismissed: true, profile: await setLivSecretAsk(userId, null) };
    }),
];
