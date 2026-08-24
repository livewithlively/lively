// 나에게 온 알림 (#1842) — 데스크톱 앱이 OS 배너를 띄우기 위해 부르는 단일 창구.
//  판정·문구는 전부 v6/notify-store.ts 에 있다(머리말에 "무엇이 알림인가"의 정의). 여기선 신원·페이지만 맡는다.
//  scope=memory — 프로젝트·댓글 축과 같다. 남의 알림은 어떤 인자로도 조회되지 않는다(수신자는 bearer 신원 고정).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { viewerOf } from "./principal.js";
import { getMember } from "../org/store.js";
import { listMyNotifications, notifyText } from "../v6/notify-store.js";
import { getNotifyPrefs, setNotifyPrefs, NOTIFY_KINDS } from "../v6/notify-pref-store.js";

const notifyFeedInput = {
  since: z.string().optional().describe("이 시각 이후만(ISO 8601). 없으면 최근 24시간 — 앱이 처음 켜졌을 때 과거가 쏟아지지 않게 한다."),
  limit: z.number().int().min(1).max(200).optional().describe("최대 건수(기본 100)"),
};
type NotifyFeedInput = z.infer<z.ZodObject<typeof notifyFeedInput>>;

const notifyFeed: Capability = {
  name: "notify_feed",
  title: "나에게 온 알림",
  description: "사람이 나를 지목해서 한 행위만(멘션·댓글). since 이후 새로 생긴 것. AI 작업 로그·필드 변경·담당 지정은 알림이 아니라 제외된다.",
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
    //  설정도 함께 싣는다(#1842): 앱은 이 폴링에서 받은 값을 캐시로 쓰므로 왕복이 하나 더 늘지 않는다.
    //  첫 폴은 콜드스타트라 어차피 배너를 만들지 않아, 그때 기본값을 쓰는 것이 무해하다.
    const prefs = await getNotifyPrefs(me).catch(() => null);
    return { items: items.map((it) => ({ ...it, text: notifyText(it) })), prefs, now: new Date().toISOString() };
  },
};

// ── 알림 설정 (#1842) — 사람 단위. 웹 [내 정보 ▸ 알림]과 데스크톱 앱이 같은 값을 본다. ──
const notifyPrefsGet: Capability = {
  name: "notify_prefs",
  title: "내 알림 설정",
  description: "어떤 순간에 알림을 받을지(확인 대기·작업 완료·사람이 나를 부를 때). 기기가 아니라 사람 단위로 저장된다.",
  scope: "memory",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/me/notify-prefs"], parse: () => ({}) }] },
  handler: async (_input: unknown, user: LivelyUser, ctx?: CapabilityCtx) => ({
    prefs: await getNotifyPrefs(ctx?.actor ?? user?.userId ?? ""),
  }),
};

const notifyPrefsSetInput = Object.fromEntries(
  NOTIFY_KINDS.map((k) => [k, z.boolean().optional()]),
) as Record<string, z.ZodOptional<z.ZodBoolean>>;

const notifyPrefsSet: Capability = {
  name: "notify_prefs_set",
  title: "내 알림 설정 저장",
  description: "알림 종류별 on/off. 보낸 항목만 바뀐다(부분 갱신).",
  scope: "memory",
  mutates: true,
  input: notifyPrefsSetInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/notify-prefs"], parse: (req: any) => req.body ?? {} }] },
  handler: async (input: Record<string, boolean | undefined>, user: LivelyUser, ctx?: CapabilityCtx) => ({
    prefs: await setNotifyPrefs(ctx?.actor ?? user?.userId ?? "", input),
  }),
};

export const notifyCapabilities: Capability[] = [notifyFeed, notifyPrefsGet, notifyPrefsSet];
