// ClickUp 커넥터 (phase B) — ClickUp API v2 → canonical RawItem.
// 리스트 나열 → 리스트별 태스크 백필/팀 단위 증분 폴(date_updated_gt)
// → 태스크 1건을 type:"task" RawItem 으로 정규화. 캐노니컬 진입은 run-sync.js(태스크 + 커서);
// SPI backfill 은 무손실 스트림(losslessStream)을 그대로 흘린다(전체 재수집은 run-sync clickup --full).
//
// 인증: Authorization: <CLICKUP_API_TOKEN> (Bearer 접두사 없음 — personal token 컨벤션).
// rate limit: 100 req/min/token — X-RateLimit-Remaining=0 선제 대기 + 429 시 retry-after 재시도.
// instance = team(workspace) id. external_id = task id (워크스페이스 내 안정·고유).
// 액터 컨벤션(load-bearing): clickup 신원의 external_id 는 **소문자 이메일**(없으면 숫자 id 문자열) —
// daon 의 manual 신원(clickup / 'admin@example.com')이 정확히 매치되어야 한다(resolveActor 정확 일치 룩업).
import type { Connector, ConnectorUser, RawItem, BackfillOpts } from "../types.js";
import { getTeam } from "./api.js";
import { losslessStream } from "./stream.js";

// 배럴 — 구 clickup.ts 의 export 집합을 그대로 재수출(소비자 import 무수정).
export * from "./types.js";
export * from "./transform.js";
export * from "./api.js";
export * from "./stream.js";

// ── Connector SPI 구현 — 무손실 스트림 그대로(run-sync generic 경로 호환).
export const clickupConnector: Connector = {
  name: "clickup",
  // #837 — 팀 멤버를 그대로 매핑 후보로. 이미 getTeam() 이 5분 memo 라 추가 비용 없음.
  async listUsers(): Promise<ConnectorUser[]> {
    const team = await getTeam();
    return (team.members ?? []).map((mm) => mm.user)
      .filter((u): u is NonNullable<typeof u> => !!u && u.id != null)
      .map((u) => ({
        id: String(u.id),
        name: u.username ?? null,
        email: u.email ?? null,
        initials: u.initials ?? null,
        color: u.color ?? null,
        avatar_url: u.profilePicture ?? null,
        instance: team.id ?? null,
      }));
  },

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const sinceMs = opts?.since ? new Date(opts.since).getTime() : undefined;
    yield* losslessStream({ sinceMs: sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : undefined });
  },
};
