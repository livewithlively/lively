// 대화 종류 캐시(#1262) — member_channel_meta CRUD.
//
// 왜 이게 있어야 하나:
//  #1262 로 기본 허용 여부가 **대화 종류**(공개 / 비공개 · 그룹DM · DM)로 갈린다. 그런데 집행 자리
//  (mcp-proxy.callUpstream)에 도착하는 건 채널 id 나 이름뿐이고, **채널 id 로는 종류를 알 수 없다**:
//  슬랙 비공개 채널도 'C' 로 시작한다(실측 — private #lively-비공개 = C0BL393EKCP, public = C0BLJKT7534).
//  공개↔비공개 전환 시 id 가 유지되기 때문이며, 슬랙 공식 문서도 "id 첫 글자로 판단하지 말고 is_private 를
//  보라"고 못박는다. 상류 검색 응답에도 종류는 안 실린다(실측: `Channel: #x (ID: C…)` 뿐).
//  → 종류는 슬랙에 따로 물어서 알아낸 뒤 여기 저장해 두고, 집행 때 이 캐시로 판정한다.
//
// 채우는 경로는 셋이다(모두 같은 표로 모인다):
//   ① 관리탭 대화 목록(users.conversations) — 화면을 열면 내가 속한 대화가 통째로 들어온다.
//   ② 정책 저장 — 사람이 켜고 끈 그 대화.
//   ③ 집행 중 캐시 미스 — conversations.info 단건 조회(channel-resolver).
//  어느 경로로도 못 알아낸 대화는 unknown 으로 남고, 기본값 규칙에 따라 **비공개처럼 막힌다**(fail-closed).
import { itemsPool } from "../../db/client.js";
import type { ChannelMetaLike, ChannelType } from "./channel-guard.js";

export interface ChannelMetaRow extends ChannelMetaLike {
  channel_id: string;
  channel_name: string | null;
  channel_type: ChannelType;
  peer_id: string | null;
  synced_at?: string | null;
}

/** 저장 전 위생 — id·peer 는 대조 키라 오염되면 판정이 어긋난다(표시명은 길이만 제한). */
function sanitizeId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[A-Z0-9._-]{2,64}$/i.test(s) ? s : null;
}
function normalizeType(v: unknown): ChannelType {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "public" || s === "private" || s === "group_dm" || s === "dm" ? s : "unknown";
}

export async function loadChannelMeta(memberId: string, system: string): Promise<ChannelMetaRow[]> {
  if (!memberId) return [];
  const r = await itemsPool.query<ChannelMetaRow>(
    `SELECT channel_id, channel_name, channel_type, peer_id, synced_at
       FROM member_channel_meta WHERE member_id=$1 AND system=$2`,
    [memberId, system],
  );
  return r.rows;
}

/** 이 사람의 캐시가 마지막으로 갱신된 시각 — 목록 전체 동기화를 다시 돌릴지(TTL) 판단용. 비었으면 null. */
export async function lastMetaSyncAt(memberId: string, system: string): Promise<Date | null> {
  if (!memberId) return null;
  const r = await itemsPool.query<{ at: Date | null }>(
    `SELECT MAX(synced_at) AS at FROM member_channel_meta WHERE member_id=$1 AND system=$2`,
    [memberId, system],
  );
  return r.rows[0]?.at ?? null;
}

// 종류를 알아낸 대화들을 저장. 이미 있으면 갱신한다 — 공개↔비공개 전환이 실제로 일어나므로
//  **종류는 항상 최신으로 덮어쓴다**(이름·peer 는 새 값이 있을 때만; 부분 조회가 기존 값을 지우면 안 된다).
//  unknown 은 저장하지 않는다 — '모른다'를 캐시에 박아 두면 다음 조회 기회를 스스로 없앤다.
export async function upsertChannelMeta(
  memberId: string, system: string,
  rows: Array<{ channel_id: string; channel_name?: string | null; channel_type: ChannelType | string; peer_id?: string | null }>,
): Promise<number> {
  if (!memberId || !rows?.length) return 0;
  let n = 0;
  for (const r of rows) {
    const id = sanitizeId(r.channel_id);
    const type = normalizeType(r.channel_type);
    if (!id || type === "unknown") continue;
    await itemsPool.query(
      `INSERT INTO member_channel_meta(member_id, system, channel_id, channel_name, channel_type, peer_id, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (tenant_id, member_id, system, channel_id) DO UPDATE
         SET channel_name=COALESCE(EXCLUDED.channel_name, member_channel_meta.channel_name),
             channel_type=EXCLUDED.channel_type,
             peer_id=COALESCE(EXCLUDED.peer_id, member_channel_meta.peer_id),
             synced_at=now()`,
      [memberId, system, id, r.channel_name ? String(r.channel_name).slice(0, 200) : null, type, sanitizeId(r.peer_id)],
    );
    n++;
  }
  return n;
}
