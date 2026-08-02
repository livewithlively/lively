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
