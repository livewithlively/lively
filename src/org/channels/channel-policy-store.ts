// 대화 채널별 개인 열람/발송 정책 스토어(#1226 · 기본값 재설계 #1262) — member_channel_policy CRUD + 집행용 정책 로드.
//
//  **행 = '기본값과 다른 명시 설정'(override)** 이다(#1262 전환). #1226 때는 '기본은 전부 허용, 사람이 끈 것만
//  행으로 남는다'(deny-list)였는데, 그러면 슬랙을 연결한 순간 비공개 채널·DM 이 통째로 AI 에게 열린다
//  (실측 확인). 이제 기본값은 대화 종류가 정한다 — 공개는 열람·발송 허용, 비공개·그룹DM·DM 은 둘 다 거부.
//  그래서 저장 규약도 뒤집힌다: '둘 다 허용이면 삭제' 가 아니라 **'그 종류의 기본값과 같아지면 삭제'** 다.
//  (비공개 채널을 '둘 다 허용' 으로 켠 것은 기본값과 **다르므로** 반드시 행으로 남아야 한다.)
//  집행은 mcp-proxy 가 channel-guard 로 한다(이 파일은 저장·조회만).
import { itemsPool } from "../../db/client.js";
import {
  buildChannelPolicy, channelKey, channelDefaults, type ChannelPolicy, type ChannelType,
} from "./channel-guard.js";
import { loadChannelMeta, upsertChannelMeta } from "./channel-meta-store.js";

// 지금은 슬랙만 — 다른 대화 시스템(팀즈·디스코드)이 붙어도 같은 표에 살 수 있게 축을 열어 둔다.
export const CHANNEL_SYSTEMS = ["slack"] as const;
export type ChannelSystem = (typeof CHANNEL_SYSTEMS)[number];

export interface ChannelPolicyRow {
  member_id: string;
  system: string;
  channel_id: string;
  channel_name: string | null;
  peer_id: string | null;
  allow_read: boolean;
  allow_write: boolean;
  /** #1226 시절 저장된 행 — true 의 뜻이 달라서 channel-guard.overrideOf 가 다르게 읽는다. */
  legacy: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export function normalizeSystem(v: unknown): ChannelSystem {
  const s = String(v ?? "slack").trim().toLowerCase();
  if (!(CHANNEL_SYSTEMS as readonly string[]).includes(s)) throw new Error(`지원하지 않는 대화 시스템: ${s}`);
  return s as ChannelSystem;
}
// 채널 id 위생 — 슬랙 대화 id 형식만(인젝션·키오염 방지). 이름은 표시용이라 느슨하게 받되 길이만 제한.
export function normalizeChannelId(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^[A-Z0-9._-]{2,64}$/i.test(s)) throw new Error(`채널 id 형식 오류: ${s}`);
  return s;
}

export async function listChannelPolicyRows(memberId: string, system: ChannelSystem): Promise<ChannelPolicyRow[]> {
  const r = await itemsPool.query<ChannelPolicyRow>(
    `SELECT member_id, system, channel_id, channel_name, peer_id, allow_read, allow_write, legacy, updated_at, updated_by
       FROM member_channel_policy WHERE member_id=$1 AND system=$2 ORDER BY channel_name NULLS LAST, channel_id`,
    [memberId, system],
  );
  return r.rows;
}

// 집행용 — 이 사람의 명시 설정(override) + 대화 종류 캐시(기본값 판정용)를 함께 싣는다.
//  ⚠ #1226 의 쿼리는 `WHERE allow_read=false OR allow_write=false` 로 **꺼 둔 행만** 읽었다. 이제는
//   '비공개 채널을 켠 것'(둘 다 true)이 정확히 그 사람이 남긴 뜻이므로 **전부 읽어야 한다** —
//   그 조건을 남겨 두면 사람이 켠 비공개 채널이 계속 막힌다.
//  ⚠ 행이 하나도 없어도 빠져나갈 수 없다. #1226 은 '정책이 없으면 전부 허용' 이라 즉시 통과했지만,
//   이제 '설정이 없다 = 비공개는 막혀 있다' 라서 캐시를 읽어 종류를 판정해야 한다.
export async function loadChannelPolicy(memberId: string, system: ChannelSystem): Promise<ChannelPolicy> {
  if (!memberId) return buildChannelPolicy([], []);
  const [ov, meta] = await Promise.all([
    itemsPool.query<{ channel_id: string; channel_name: string | null; peer_id: string | null; allow_read: boolean; allow_write: boolean; legacy: boolean }>(
      `SELECT channel_id, channel_name, peer_id, allow_read, allow_write, legacy
         FROM member_channel_policy WHERE member_id=$1 AND system=$2`,
      [memberId, system],
    ),
    loadChannelMeta(memberId, system),
  ]);
  return buildChannelPolicy(ov.rows, meta);
}

/** 이 대화의 종류 — 저장된 캐시에서 찾는다(없으면 unknown). 저장 규약(기본값과 같으면 삭제)에 필요. */
async function typeOf(memberId: string, system: ChannelSystem, channelId: string, hint?: unknown): Promise<ChannelType> {
  const h = String(hint ?? "").trim().toLowerCase();
  if (h === "public" || h === "private" || h === "group_dm" || h === "dm") return h;
  const rows = await loadChannelMeta(memberId, system);
  return rows.find((r) => r.channel_id === channelId)?.channel_type ?? "unknown";
}

// 한 대화의 허용 상태를 저장. **그 종류의 기본값과 같아지면 행을 지운다** —
//  기본값과 같은 상태를 굳이 남기지 않는다(org_asset_pref 의 '기본값과 같아지면 개인설정 해제'와 같은 규약).
//  공개 채널은 '둘 다 허용' 이 기본값이라 그 때 지워지고, 비공개·DM 은 반대로 **'둘 다 거부' 일 때** 지워진다.
//  종류를 모르면(unknown) 기본값은 '둘 다 거부' 로 본다 — 그래야 켜 둔 설정이 실수로 사라지지 않는다.
//  화면이 보낸 종류(channelType)는 캐시에도 반영한다 — 집행 때 그 대화의 종류를 알아야 하기 때문이다.
export async function setChannelPolicy(
  memberId: string, system: ChannelSystem, channelId: string,
  v: { channelName?: string | null; peerId?: string | null; channelType?: ChannelType | string | null; allowRead: boolean; allowWrite: boolean },
  actor?: string,
): Promise<ChannelPolicyRow | null> {
  const id = normalizeChannelId(channelId);
  const name = v.channelName ? String(v.channelName).slice(0, 200) : null;
  // DM 상대 user_id — 형식 밖이면 조용히 버린다(표시용이 아니라 대조 키라 오염되면 안 된다).
  const peer = v.peerId && /^[A-Z0-9._-]{2,64}$/i.test(String(v.peerId)) ? String(v.peerId) : null;

  const type = await typeOf(memberId, system, id, v.channelType);
  // 종류를 알게 됐으면 캐시에 남긴다 — 집행 자리는 이 캐시로만 공개/비공개를 가린다.
  if (type !== "unknown") {
    await upsertChannelMeta(memberId, system, [{ channel_id: id, channel_name: name, channel_type: type, peer_id: peer }])
      .catch(() => 0); // 캐시 실패가 정책 저장을 막지는 않는다(다음 목록 조회가 채운다)
  }

  const def = channelDefaults(type);
  if (v.allowRead === def.read && v.allowWrite === def.write) {
    await itemsPool.query(`DELETE FROM member_channel_policy WHERE member_id=$1 AND system=$2 AND channel_id=$3`, [memberId, system, id]);
    return null;
  }
  // legacy=false 로 못박는다 — 사람이 **새 규칙 화면에서** 정한 것이므로 true 도 '명시 허용' 으로 살아야 한다
  //  (구 행이었다면 이 저장으로 시대가 벗겨진다).
  const r = await itemsPool.query<ChannelPolicyRow>(
    `INSERT INTO member_channel_policy(member_id, system, channel_id, channel_name, peer_id, allow_read, allow_write, legacy, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)
     ON CONFLICT (member_id, system, channel_id) DO UPDATE
       SET channel_name=COALESCE(EXCLUDED.channel_name, member_channel_policy.channel_name),
           peer_id=COALESCE(EXCLUDED.peer_id, member_channel_policy.peer_id),
           allow_read=EXCLUDED.allow_read, allow_write=EXCLUDED.allow_write, legacy=false,
           updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING member_id, system, channel_id, channel_name, peer_id, allow_read, allow_write, legacy, updated_at, updated_by`,
    [memberId, system, id, name, peer, v.allowRead, v.allowWrite, actor ?? memberId],
  );
  return r.rows[0] ?? null;
}

// 목록 화면용 — 채널 id 로 바로 찾을 수 있게. channelKey 를 쓰지 않는 이유: 화면은 id 축으로만 대조한다.
export function policyIndex(rows: ChannelPolicyRow[]): Map<string, ChannelPolicyRow> {
  const m = new Map<string, ChannelPolicyRow>();
  for (const r of rows) m.set(r.channel_id, r);
  return m;
}

// 정책은 있는데 채널 목록에는 안 잡히는 행(내가 나간 채널·권한 밖)도 화면에서 보여야 지울 수 있다.
export function orphanRows(rows: ChannelPolicyRow[], knownIds: Set<string>): ChannelPolicyRow[] {
  return rows.filter((r) => !knownIds.has(r.channel_id) && !!channelKey(r.channel_id));
}
