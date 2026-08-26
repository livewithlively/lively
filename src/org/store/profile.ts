// org_profile — 조직 프로필(이름·게이트웨이 URL·시간대) 단일행 CRUD.
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { invalidateOrgTimezone } from "../timezone.js"; // #778 시간대 캐시 무효화(프로필 저장 시)
import { audit } from "./audit.js";

export interface OrgProfile {
  name: string | null;
  display_name: string | null;
  gateway_url: string | null;
  timezone: string | null; // #778 조직 시간대(IANA). NULL=미설정 → org/timezone.ts DEFAULT_TZ.
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

// ── org_profile ──
export async function getOrgProfile(): Promise<OrgProfile> {
  const r = await itemsPool.query(
    `SELECT name, display_name, gateway_url, timezone, version, updated_at, updated_by FROM org_profile WHERE id=1`,
  );
  return (r.rows[0] as OrgProfile) ?? {
    name: null, display_name: null, gateway_url: null, timezone: null, version: 1, updated_at: null, updated_by: null,
  };
}

export async function updateOrgProfile(
  patch: Partial<Pick<OrgProfile, "name" | "display_name" | "gateway_url" | "timezone">>,
  actor?: string,
  source?: string,
): Promise<OrgProfile> {
  const before = await getOrgProfile();
  // ★ 행이 없으면 먼저 만든다 — 아래가 `UPDATE … WHERE id=1` 이라 **행이 없으면 0행 갱신으로 조용히 사라진다**.
  //
  //  이 표의 단일행은 스키마 시딩(org/schema/core.ts 의 `INSERT INTO org_profile(id) VALUES(1)`)이 심는데,
  //  **중앙 게이트웨이(매니지드)는 스키마 초기화를 통째로 건너뛴다**(LIVELY_SKIP_SCHEMA_INIT — 스키마 소유가
  //  마이그레이터라). 그 배포에서는 테넌트에 행이 없고, 그러면 gateway_url 을 아무리 저장해도 남지 않는다.
  //  실측(2026-08-25 app.lvly.io): CP 가 5분마다 "gateway_url 재단언: (없음) → https://…" 를 찍는데
  //  값은 영영 비어 있었다 → OAuth 콜백 URL·릴레이 시작(gw=)·CLI 승인 링크가 전부 죽었다(#1771 과 같은 뿌리).
  //  저장 경로 자체를 자가치유로 만든다 — 어느 배포 모드에서도 "첫 저장이 성립"해야 한다.
  await itemsPool.query(`INSERT INTO org_profile(id) VALUES(1) ON CONFLICT DO NOTHING`);
  await itemsPool.query(
    `UPDATE org_profile SET
       name = COALESCE($1, name),
       display_name = COALESCE($2, display_name),
       gateway_url = COALESCE($3, gateway_url),
       timezone = COALESCE($4, timezone),
       version = version + 1,
       updated_at = now(),
       updated_by = $5
     WHERE id=1`,
    [patch.name ?? null, patch.display_name ?? null, patch.gateway_url ?? null, patch.timezone ?? null, actor ?? null],
  );
  invalidateOrgTimezone(); // #778: 다음 cron 틱·세션 생성이 새 시간대를 즉시 쓰게(TTL 대기 없이).
  const after = await getOrgProfile();
  await audit("org_profile", "1", "update", before, after, actor, source);
  return after;
}
