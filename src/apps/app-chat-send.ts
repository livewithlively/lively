// 앱 화면이 붙은 세션에 글을 **바로 보낸다** (#4594) — 원준 결정(2026-10-07): 입력칸을 채우는 데서 멈추지 않고 곧바로 보낸다.
//
//  왜 필요한가: 세션에 붙은 앱(#4225)은 사람과 AI 가 같은 화면을 보지만, 사람이 앱에서 한 일(의견 12건을 적고 [AI에게 보내기])은
//   AI 에게 아무 신호가 없었다. 이 통로가 그 신호다 — 앱이 짧은 한 줄을 세션에 넣으면 AI 가 앱 표(store_*)에서 내용을 읽는다.
//  경계(붙이기·떼기·store_* 와 같은 세 겹, apps/session-apps.ts 머리말): ① 그 앱에 동의한 사람 ② 그 세션의 주인 ③ 그 앱이 지금 그 세션에
//   붙어 있음. 셋 다 매 호출 다시 본다. 그래서 앱이 남의 세션에 말을 넣거나, 뗀 뒤에도 넣는 일이 없다.
//  글 앞에 `(앱 「<제목>」에서 보냄)` 한 줄을 서버가 붙인다 — 대화 기록에서 사람이 친 말과 구별되고, 턴 훅(session-apps-inject)이
//   이 표식을 보고 그 앱의 지침을 다시 알린다. 앱이 제 손으로 붙인 표식은 믿지 않는다(서버가 붙여야 위조가 안 된다).
//  빈도 상한 (사람, 앱) 분당 20 — 앱 코드가 돌면서 세션을 메시지로 메우지 못하게. 긴 내용은 표에 두고 한 줄만 보내라는 장치이기도 하다.
//  판정은 순수하게 두고(deps 주입) 살아 있는 의존은 capabilities/app-chat-send.ts 가 꽂는다 — 시험이 가짜 세계로 표(S1)를 못박는다.
import { HttpError } from "../http-error.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import { requireSessionOwner, requireUsableApp, type SessionAppRow } from "./session-apps.js";
import type { DeliverResult } from "../terminal/deliver-prompt.js";

export const CHAT_SEND_MAX_CHARS = 4000;
export const CHAT_SEND_PER_MINUTE = 20;

export interface ChatSendDeps {
  getApp: (appId: string) => Promise<OrgApp | null>;
  getGrant: (appId: string, memberId: string) => Promise<AppGrantRow | null>;
  sessionOwner: (sessionId: string) => Promise<string | null>;
  listAttached: (sessionId: string) => Promise<SessionAppRow[]>;
  /** tmux 가 «그런 세션 없다» 고 확답하나(멈춘 세션). 모르면 false — 배달이 알아서 아웃박스로 간다. */
  isGone: (sessionId: string) => Promise<boolean>;
  /** 라우트(/prompt)와 같은 배달 — 노드 판정 + 접근 판정 + deliverPrompt. 접근이 막히면 HttpError 를 던진다. */
  deliver: (sessionId: string, memberId: string, text: string) => Promise<DeliverResult>;
  now?: () => number;
}

export interface ChatSendInput { appId: string; sessionId: string; member: string; text: string; mark?: string }
export type ChatSendResult = { sent: true; session: string; transport: string | null };

/** 서버가 붙이는 표식 한 줄 + 사람(앱)이 보낸 글. 표식 뒤의 `)` 까지가 훅이 찾는 꼴(`에서 보냄)`). */
export function composeAppMessage(appTitle: string, text: string): string {
  return `(앱 「${appTitle}」에서 보냄)\n${text}`;
}

/** 글 검사 — 공백만이면 400, 상한 넘으면 400. 돌려주는 값 = 다듬은 글. 순수. */
export function normalizeChatText(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new HttpError(400, "보낼 내용이 없습니다");
  if (text.length > CHAT_SEND_MAX_CHARS) {
    throw new HttpError(400, `보낼 글이 너무 깁니다(${text.length}자 > ${CHAT_SEND_MAX_CHARS}자) — 내용은 앱 표에 두고 한 줄로 알리세요`);
  }
  return text;
}

/** 미끄럼 창 빈도 상한 — 키(사람:앱)마다 지난 60초의 호출 시각을 든다. 메모리뿐이라 프로세스마다 따로 센다(상한이 느슨해질 뿐 막히지 않는다). */
export class RateWindow {
  private hits = new Map<string, number[]>();
  constructor(private limit = CHAT_SEND_PER_MINUTE, private windowMs = 60_000) {}
  /** 이번 호출을 세고 허용되나. 넘치면 false(세지 않는다). */
  take(key: string, now: number): boolean {
    const cut = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cut);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

/**
 * 앱 화면 → 붙은 세션으로 글 보내기. 순서: 글(400) → 앱(404/409) → 동의(403) → 주인(404/403) → 붙음(403) → 빈도(429) → 멈춤(409 draft) → 배달.
 *  멈춘 세션(409 `{draft:true}`)은 실패가 아니라 «입력칸에 넣어 두라» 는 신호다 — 호스트가 그 세션 화면의 입력칸에 글을 넣고,
 *  사람이 보내면 그 말이 세션을 깨운다(#2439 되살리기 규칙을 그대로 탄다).
 */
export async function sendFromApp(q: ChatSendInput, deps: ChatSendDeps, rate: RateWindow): Promise<ChatSendResult> {
  const text = normalizeChatText(q.text);
  const sessionId = String(q.sessionId ?? "").trim();
  if (!sessionId) throw new HttpError(400, "session_id 가 필요합니다 — 세션에 붙은 앱 화면에서만 보낼 수 있습니다");
  const app = requireUsableApp(await deps.getApp(q.appId), q.appId);
  if (!(await deps.getGrant(q.appId, q.member))) throw new HttpError(403, `앱 '${q.appId}' 사용 동의(grant)가 없습니다`);
  await requireSessionOwner(sessionId, q.member, { sessionOwner: deps.sessionOwner });
  const attached = await deps.listAttached(sessionId);
  if (!attached.some((a) => a.app_id === q.appId)) {
    throw new HttpError(403, `앱 '${q.appId}' 이 이 세션에 붙어 있지 않습니다 — 붙은 앱 화면에서만 세션에 보낼 수 있습니다`);
  }
  const now = deps.now ? deps.now() : Date.now();
  if (!rate.take(`${q.member}:${q.appId}`, now)) {
    throw new HttpError(429, `이 앱이 세션에 너무 자주 보내고 있습니다(분당 ${CHAT_SEND_PER_MINUTE}회) — 내용은 앱 표에 모으고 한 번에 알리세요`);
  }
  if (await deps.isGone(sessionId)) {
    throw new HttpError(409, "세션이 멈춰 있어 보내지 못했습니다 — 입력칸에 넣어 두었어요. 보내면 세션이 깨어납니다", { body: { draft: true, session: sessionId } });
  }
  const r = await deps.deliver(sessionId, q.member, composeAppMessage(app.title || app.id, text));
  const transport = "transport" in r && r.transport ? String(r.transport) : ("queued" in r && r.queued ? "outbox" : null);
  return { sent: true, session: sessionId, transport };
}
