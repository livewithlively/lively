// 나에게 온 알림 (#1842) — 데스크톱 앱이 OS 배너를 띄우기 위해 부르는 단일 창구.
//  판정·문구는 전부 v6/notify-store.ts 에 있다(머리말에 "무엇이 알림인가"의 정의). 여기선 신원·페이지만 맡는다.
//  scope=memory — 프로젝트·댓글 축과 같다. 남의 알림은 어떤 인자로도 조회되지 않는다(수신자는 bearer 신원 고정).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { viewerOf } from "./principal.js";
import { getMember } from "../org/store.js";
import { listMyNotifications, notifyText } from "../v6/notify-store.js";

const notifyFeedInput = {
  since: z.string().optional().describe("이 시각 이후만(ISO 8601). 없으면 최근 24시간 — 앱이 처음 켜졌을 때 과거가 쏟아지지 않게 한다."),
  limit: z.number().int().min(1).max(200).optional().describe("최대 건수(기본 100)"),
};
type NotifyFeedInput = z.infer<z.ZodObject<typeof notifyFeedInput>>;

const notifyFeed: Capability = {
  name: "notify_feed",
  title: "나에게 온 알림",
  description: "사람이 나를 지목해서 한 행위만(멘션·댓글·담당 지정). since 이후 새로 생긴 것. AI 작업 로그·필드 변경은 알림이 아니라 제외된다.",
  scope: "memory",
  input: notifyFeedInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/notify/feed"],
      parse: (req: any) => ({
        since: req.query?.since ? String(req.query.since) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      }) }],
  },
  handler: async (input: NotifyFeedInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const me = ctx?.actor ?? user?.userId ?? "";
    if (!me) return { items: [], now: new Date().toISOString() };
    // 멘션 표기는 이름으로도 쓰인다(`@장원준`) — 화면과 같은 규칙을 보려면 표시 이름이 필요하다.
    let displayName: string | null = null;
    try { displayName = (await getMember(me))?.display_name ?? null; } catch { /* 못 읽어도 아이디 멘션은 잡힌다 */ }
    const items = await listMyNotifications(me, { since: input.since ?? null, limit: input.limit, displayName }, viewerOf(user));
    // 문구를 서버가 붙여 보낸다 — 앱·화면이 각자 문장을 조립하면 같은 사건이 자리마다 다르게 읽힌다.
    return { items: items.map((it) => ({ ...it, text: notifyText(it) })), now: new Date().toISOString() };
  },
};

export const notifyCapabilities: Capability[] = [notifyFeed];
