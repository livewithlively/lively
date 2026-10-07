// 앱 화면 → 붙은 세션으로 글 보내기 capability (#4594) — REST 전용(앱 화면 다리가 부른다 · 하네스 세션은 자기 입력칸이 있다).
//  판정·표식·빈도는 apps/app-chat-send.ts(순수, deps 주입)에 있고 여기는 입력과 표면, 살아 있는 의존뿐이다.
//  배달은 /prompt 라우트와 같은 deliverPromptForMember — 노드 판정·접근 판정·아웃박스가 전부 그 한 함수에 있다.
//  멈춤 판정은 localSessionGone — 중앙 tmux 에 있는 세션에만 sessionGone 을 묻는다(노드 세션은 중앙에 없는 것이 정상).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { listAttachedApps, sessionOwnerOf } from "../apps/session-apps.js";
import { RateWindow, localSessionGone, sendFromApp, type ChatSendDeps } from "../apps/app-chat-send.js";
import { appSqlTenantId } from "../apps/app-sql-exec.js";

const rate = new RateWindow();
const liveDeps: ChatSendDeps = {
  getApp: (id) => getApp(id),
  getGrant: getActiveGrant,
  sessionOwner: sessionOwnerOf,
  listAttached: listAttachedApps,
  isGone: async (sid) => {
    const { sessionGone } = await import("../terminal/terminal-sessions.js");
    const { remoteNodeOfSession } = await import("../node/registry.js");
    return localSessionGone(sid, { remoteNode: (s) => remoteNodeOfSession(s, sessionGone), gone: sessionGone });
  },
  deliver: async (sid, member, text) => { const { deliverPromptForMember } = await import("../terminal/deliver-prompt.js"); return deliverPromptForMember(sid, member, text); },
  tenant: appSqlTenantId,
};

const appChatSend: Capability = {
  name: "org_app_chat_send",
  title: "앱 화면이 붙은 세션에 보내기",
  description: "세션에 붙은 앱 화면이 그 세션에 글을 바로 보낸다(SDK lively.chat.send). 앱이 permissions.chat_send 를 선언했고, 그 앱에 동의한 세션 주인이, 그 앱이 지금 붙어 있을 때만. "
    + "서버가 글 앞에 「(앱 「제목」에서 보냄)」 한 줄을 붙인다. 4,000자 · (사람, 앱) 분당 20회. 세션이 멈춰 있으면 409 {draft:true, draft_text}. REST 전용.",
  scope: null,
  input: { app_id: z.string(), session_id: z.string(), text: z.string() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/chat-send"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, session_id: b.session_id, text: b.text };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) => {
    const member = user?.userId || "";
    if (!member) throw new HttpError(401, "인증이 필요합니다");
    const appId = String(input.app_id ?? "").trim();
    if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
    return sendFromApp({ appId, member, sessionId: String(input.session_id ?? ""), text: String(input.text ?? "") }, liveDeps, rate);
  },
};

export const appChatSendCapabilities: Capability[] = [appChatSend];
