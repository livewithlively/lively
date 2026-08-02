// 집행 시점 대화 종류 해소(#1262) — "이 호출이 지목한 대화가 공개인가 비공개인가"를 알아내는 자리.
//
// 왜 별도 계층인가: #1262 로 기본 허용 여부가 대화 종류로 갈리는데, 집행 자리(mcp-proxy.callUpstream)에
//  도착하는 건 채널 id·이름뿐이고 **id 로는 종류를 알 수 없다**(비공개도 C 로 시작 — 실측·슬랙 공식문서).
//  판정 자체는 순수 로직(channel-guard)이어야 테스트가 되므로, 종류를 미리 해소해서 넘겨주는 조율만 여기서 한다.
//
// 해소 순서(싼 것부터):
//   ① 이미 아는 것 — 사람이 정한 설정(override)이나 캐시(member_channel_meta)에 있으면 그걸로 끝.
//   ② 목록 전체 동기화 — users.conversations 한 방이면 이름·DM 상대(U…)까지 통째로 해소된다.
//      무거워서(최대 10페이지 + users.list) 캐시가 오래됐을 때만, 한 호출에 한 번만 시도한다.
//   ③ 단건 조회 — 그래도 남은 id 는 conversations.info 로 하나씩(상한 있음).
//   ④ 그래도 모르면 unknown 으로 남긴다 → 기본값 규칙에 따라 **비공개처럼 막힌다**(fail-closed).
//
// ⚠ 해소 실패를 예외로 올리지 않는다. 슬랙이 죽었다고 호출을 에러로 끝내는 대신 '모르는 대화' 로 두면,
//  공개 채널은 캐시가 있는 한 계속 열리고 모르는 것만 닫힌다 — 안전측이면서 덜 시끄럽다.
import { loadChannelPolicy, type ChannelSystem } from "./channel-policy-store.js";
import { lastMetaSyncAt } from "./channel-meta-store.js";
import { listMySlackConversations, fetchConversationTypes } from "./slack-channels.js";
import type { ChannelPolicy } from "./channel-guard.js";
import { logger } from "../../log.js";

/** 목록 전체 동기화를 다시 돌리기까지의 최소 간격 — 모르는 대화가 나올 때만, 그것도 이 간격을 넘겼을 때만. */
const LIST_SYNC_TTL_MS = 5 * 60_000;

export interface ChannelGate {
  /** 현재까지 해소된 정책. resolve() 를 부를 때마다 갱신된다. */
  readonly policy: ChannelPolicy;
  /** 이 키들 중 종류를 모르는 게 있으면 슬랙에 물어 채우고, 갱신된 정책을 돌려준다. */
  resolve(keys: Iterable<string>): Promise<ChannelPolicy>;
}

export async function openChannelGate(memberId: string, system: ChannelSystem): Promise<ChannelGate> {
  let policy = await loadChannelPolicy(memberId, system);
  let listSyncTried = false;   // 목록 전체 동기화는 한 호출에 한 번만(모르는 키가 여러 번 나와도)

  // 아직 아무 근거가 없는 키 — 사람이 정한 것도, 캐시된 종류도 없는 것.
  const unresolved = (keys: Iterable<string>): string[] =>
    [...keys].filter((k) => !policy.override.has(k) && !policy.types.has(k));

  const reload = async (): Promise<void> => { policy = await loadChannelPolicy(memberId, system); };

  const resolve = async (keys: Iterable<string>): Promise<ChannelPolicy> => {
    let missing = unresolved(keys);
    if (!missing.length) return policy;

    // ② 목록 전체 동기화 — 이름(#foo)·DM 상대(U…)는 단건 조회로 못 풀어서 이 경로가 유일하다.
    if (!listSyncTried) {
      listSyncTried = true;
      const last = await lastMetaSyncAt(memberId, system).catch(() => null);
      if (!last || Date.now() - last.getTime() > LIST_SYNC_TTL_MS) {
        try {
          await listMySlackConversations(memberId);   // 내부에서 캐시를 채운다
          await reload();
          missing = unresolved(keys);
          if (!missing.length) return policy;
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "대화 목록 동기화 실패 — 모르는 대화는 기본값(거부)으로 남는다");
        }
      }
    }

    // ③ 남은 id 는 단건 조회. '#이름' 은 여기서 풀 수 없다(슬랙 API 가 이름으로 대화를 안 찾아준다).
    const ids = missing.filter((k) => !k.startsWith("#"));
    if (ids.length) {
      try {
        const found = await fetchConversationTypes(memberId, ids);
        if (found.length) await reload();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "대화 종류 단건 조회 실패 — 기본값(거부) 적용");
      }
    }
    return policy;
  };

  return { get policy() { return policy; }, resolve };
}
