// 대화 채널별 개인 열람/발송 정책 표면(#1226) — [관리 ▸ 외부 서비스 관리 ▸ Slack] 화면이 쓰는 REST.
//
// ⚠ **REST 전용(expose.mcp:false) + 변경은 사람(웹)만**. AI 가 자기에게 걸린 차단을 스스로 풀 수 있으면
//  이 정책은 아무것도 막지 못한다 — 통제의 주체는 사람이어야 한다(undo/content_restore 와 같은 규약).
//  조회도 MCP 로 열지 않는다: '내가 어떤 대화에 속해 있는지' 자체가 사생활이라 AI 세션에 흘릴 이유가 없다.
//  차단당한 AI 는 프록시 가드가 돌려주는 안내문으로 '무엇을 왜 못 쓰는지'만 안다.
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { listMySlackConversations } from "../org/channels/slack-channels.js";
import { channelDefaults, overrideOf, type ChannelType, type ChannelPolicyRowLike } from "../org/channels/channel-guard.js";
import {
  listChannelPolicyRows, setChannelPolicy, normalizeSystem, normalizeChannelId, policyIndex, orphanRows,
} from "../org/channels/channel-policy-store.js";

// 화면이 받는 한 줄 — type 은 슬랙 대화 종류(public·private·group_dm·dm) 또는 목록 밖 정책 행의 'unknown'.
//  #1262: 기본값이 종류마다 달라졌으므로 **기본값도 함께 실어 보낸다.** 화면이 '지금 허용인가' 만 알면
//  "체크가 꺼져 있는 게 내가 끈 건지 원래 그런 건지" 를 구분해 보여줄 수 없다.
interface ChannelDto {
  id: string; name: string; type: string; is_member: boolean;
  peer_id: string | null;   // DM 상대 user_id — 저장 시 함께 보내 정책이 U… 경로도 막게 한다
  allow_read: boolean; allow_write: boolean;
  default_read: boolean; default_write: boolean;   // 이 종류의 기본값(공개=허용 / 그 외=거부)
  explicit: boolean;        // 사람이 직접 정한 상태인가(= 기본값과 다르다)
  from_policy: boolean;     // 지금 내 대화 목록엔 없는데 설정만 남은 행인가
}

function requireMe(user: LivelyUser | undefined): string {
  const id = user?.userId;
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
}

// ⚠ 이 표면의 게이트는 **사람 웹 로그인 세션(tokenSource='session')** 이다. source!=='mcp' 만으로는 부족하다 —
//  하네스는 자기 bearer 토큰을 쥐고 있어 MCP 를 안 거치고 REST 를 그대로 칠 수 있다(실측으로 확인했다).
//  그 경로를 열어 두면 AI 가 자기에게 걸린 차단을 스스로 풀 수 있어 이 기능 전체가 무의미해진다.
//  대가로 CLI·토큰으로는 조회·변경이 안 된다 — 의도된 것이다(창구는 웹 화면 하나).
function requireHumanSession(user: LivelyUser | undefined, ctx: CapabilityCtx | undefined): string {
  const id = requireMe(user);
  if (ctx?.source === "mcp" || user?.tokenSource !== "session") {
    throw new HttpError(403, "대화 채널 허용 설정은 웹에 로그인한 본인만 열람·변경할 수 있습니다(AI·토큰 경로는 막혀 있습니다).");
  }
  return id;
}

// 대화 1개 → 화면 한 줄. **저장된 행이 없으면 그 종류의 기본값이 곧 현재 상태다**(#1262) —
//  #1226 처럼 무조건 true 로 채우면, 실제로는 막혀 있는 비공개 채널이 화면엔 '허용' 으로 보이는
//  가장 나쁜 종류의 거짓말이 된다(사람은 열려 있다고 믿고, AI 는 못 읽는다).
//  ⚠ 저장된 행이 있어도 그 값을 그대로 쓰면 안 된다 — 구 모델 행(legacy)의 true 는 '허용 선택' 이 아니라
//   '기본값을 안 건드림' 이라서, 집행(channel-guard)과 화면이 갈라지면 **화면은 허용, AI 는 차단**이 된다.
//   그래서 집행과 같은 overrideOf 를 써서 실효값을 계산한다(단일 규칙).
function dtoOf(
  c: { id: string; name: string; type: string; is_member: boolean; peer_id?: string | null },
  p: ChannelPolicyRowLike | undefined,
  fromPolicy: boolean,
): ChannelDto {
  const def = channelDefaults(c.type as ChannelType);
  const ov = p ? overrideOf(p) : {};
  const read = ov.read ?? def.read;
  const write = ov.write ?? def.write;
  return {
    id: c.id, name: c.name, type: c.type, is_member: c.is_member, peer_id: c.peer_id ?? null,
    allow_read: read, allow_write: write,
    default_read: def.read, default_write: def.write,
    // '직접 설정' 은 행의 유무가 아니라 **실효값이 기본값과 다른지** 다 — 화면의 isDefault 와 같은 뜻이어야 한다.
    explicit: read !== def.read || write !== def.write,
    from_policy: fromPolicy,
  };
}

// 내가 속한 슬랙 대화 + 각 대화의 현재 허용 상태. 미연결이면 connected:false(에러 아님 — 화면이 [연결]을 안내).
const meSlackChannels: Capability = {
  name: "me_slack_channels", title: "내 슬랙 대화 목록(열람·발송 허용 상태)",
  description: "내가 속한 슬랙 대화(공개·비공개·그룹DM·DM)와 각각의 열람/발송 허용 상태. 웹 화면 전용.",
  scope: null, input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/me/slack/channels"], parse: () => ({}) }] },
  handler: async (_input, user, ctx?: CapabilityCtx) => {
    const me = requireHumanSession(user, ctx);
    const system = "slack" as const;
    const rows = await listChannelPolicyRows(me, system);
    let listed;
    try {
      listed = await listMySlackConversations(me);
    } catch (err) {
      // 목록을 못 받아도 이미 저장된 정책은 보여 준다 — 그래야 사람이 잘못 걸어 둔 차단을 풀 수 있다.
      const fallback: ChannelDto[] = rows.map((r) => dtoOf({ id: r.channel_id, name: r.channel_name || r.channel_id, type: "unknown", is_member: false, peer_id: r.peer_id ?? null }, r, true));
      return { connected: true, auth: null, error: (err as Error).message, dm_listed: false, channels: fallback };
    }
    const idx = policyIndex(rows);
    const channels: ChannelDto[] = listed.conversations.map((c) => dtoOf(c, idx.get(c.id), false));
    // 목록엔 없는데 정책만 남은 것(나간 채널·권한 밖) — 숨기면 영영 못 지운다.
    const known = new Set(listed.conversations.map((c) => c.id));
    for (const r of orphanRows(rows, known)) {
      channels.push(dtoOf({ id: r.channel_id, name: r.channel_name || r.channel_id, type: "unknown", is_member: false, peer_id: r.peer_id ?? null }, r, true));
    }
    return {
      connected: listed.connected, auth: listed.auth, dm_listed: listed.dm_listed,
      warning: listed.warning ?? null, channels,
    };
  },
};

const meChannelPolicySet: Capability = {
  name: "me_channel_policy_set", title: "내 대화 채널 열람·발송 허용 변경",
  description: "내 대화 채널 1개의 열람/발송 허용 여부를 저장한다. 그 대화 종류의 기본값(공개=허용, 비공개·그룹DM·DM=거부)과 같아지면 행이 지워진다. 웹 화면 전용(사람만).",
  scope: null,
  input: {
    system: z.string().optional(), channel_id: z.string(), channel_name: z.string().optional(),
    // channel_type: 기본값 판정(=행을 지울지)과 집행용 종류 캐시에 쓴다. 화면이 목록에서 받은 값을 그대로 보낸다.
    channel_type: z.string().optional(),
    peer_id: z.string().optional(), allow_read: z.boolean(), allow_write: z.boolean(),
  },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/me/channel-policy"], parse: (req) => (req.body ?? {}) as Record<string, unknown> }] },
  handler: async (input, user, ctx?: CapabilityCtx) => {
    const me = requireHumanSession(user, ctx);   // AI 가 자기 차단을 스스로 푸는 경로 차단(이 정책의 존재 이유)
    const i = (input ?? {}) as Record<string, unknown>;
    const system = normalizeSystem(i.system);
    const channelId = normalizeChannelId(i.channel_id);
    if (typeof i.allow_read !== "boolean" || typeof i.allow_write !== "boolean") {
      throw new HttpError(400, "allow_read·allow_write 는 true/false 여야 합니다");
    }
    const row = await setChannelPolicy(
      me, system, channelId,
      {
        channelName: i.channel_name ? String(i.channel_name) : null,
        peerId: i.peer_id ? String(i.peer_id) : null,
        channelType: i.channel_type ? String(i.channel_type) : null,
        allowRead: i.allow_read, allowWrite: i.allow_write,
      },
      ctx?.actor ?? me,
    );
    return { policy: row, cleared: row === null };
  },
};

export const channelPolicyCapabilities: Capability[] = [meSlackChannels, meChannelPolicySet];
