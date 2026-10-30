// terminal/session-id.ts — 세션 id 의 **모양** 한 자리(리프). 접두어 규칙과 «게이트웨이가 미리 정한 id 를 받아 줄지» 판정.
//  sessions.ts 에서 떼어 냈다(#4135): 게이트웨이의 node-session-preissue 와 시험이 sessions.ts(DB·tmux 를 통째로 문다) 없이
//  같은 규칙을 쓰기 위해서다. sessions.ts 는 여기 것을 그대로 쓰고 sessionPrefix 를 종전대로 재수출한다(배럴 소비자 무영향).
import type { LivelyUser } from "../context.js";
import { userSlug } from "./profiles.js";
import { SESSION_ID_RE } from "../org/auth/agent-identity.js";   // #852 — 세션 id 형식의 단일 진실원천

export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;

/** 게이트웨이가 미리 정한 세션 id(#4135 CreateInput.preissued)를 받아 줄지 — 형식(SESSION_ID_RE)과 **이 사용자의 접두어**가 맞을 때만.
 *  아니면 null(createSession 이 종전대로 스스로 만든다). 노드는 정책을 판단하지 않지만, 남의 접두어·깨진 값을 세션 이름으로 앉히지는 않는다. */
export function acceptPreissuedId(u: LivelyUser, id: unknown): string | null {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id) || !id.startsWith(sessionPrefix(u))) return null;
  return id;
}
