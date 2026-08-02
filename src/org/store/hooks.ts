// org_hook — 커스텀 훅(런너 fetch·per-member 유효성 #699·실행 실패 health #892).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit, sha256, type WriteCtx } from "./audit.js";

// ════════ 커스텀 훅 — org_hook ════════
export type HookHarness = "claude" | "codex" | "openclaw" | "all";
export interface OrgHook {
  id: string;
  label: string | null;
  harness: HookHarness;
  event: string;
  matcher: string | null;
  source_code: string;
  timeout_sec: number;
  note: string | null;
  summary: string;             // 화면에 보이는 '쉬운 한 줄'(#1085) — note(운영 메모)와 별개
  target_members: string[] | null; // #699: NULL/빈=전원, 배열=그 멤버만(org_harness_asset 와 대칭)
  enabled: boolean;
  sort: number;
  version: number;
  content_hash: string | null;
  health: Record<string, OrgHookHealth>; // #892: member_id → 마지막 실패. 정상이면 {} (실패 시에만 기록)
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

// 훅 실행 실패 1건(멤버 러너 보고, #892). 성공은 기록하지 않는다 — '조용한 죽음'만 드러내면 된다.
export interface OrgHookHealth {
  at: string;               // ISO
  reason: string;           // crash | timeout | hash_mismatch | spawn_error
  exit_code: number | null;
  stderr: string;           // 꼬리 일부(진단용)
}

function mapHook(row: Record<string, unknown>): OrgHook {
  const tm = row.target_members;
  return {
    id: row.id as string,
    label: (row.label as string) ?? null,
    harness: row.harness as HookHarness,
    event: row.event as string,
    matcher: (row.matcher as string) ?? null,
    source_code: (row.source_code as string) ?? "",
    timeout_sec: (row.timeout_sec as number) ?? 10,
    note: (row.note as string) ?? null,
    summary: (row.summary as string) ?? "",
    target_members: Array.isArray(tm) ? (tm as string[]) : null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    content_hash: (row.content_hash as string) ?? null,
    health: (row.health && typeof row.health === "object" && !Array.isArray(row.health))
      ? (row.health as Record<string, OrgHookHealth>) : {},
    created_by: (row.created_by as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const HOOK_COLS = "id, label, harness, event, matcher, source_code, timeout_sec, note, summary, target_members, enabled, sort, version, content_hash, health, created_by, updated_at, updated_by";
const HOOK_COLS_Q = HOOK_COLS.split(", ").map((c) => "h." + c).join(", "); // JOIN 용 정규화(updated_at/updated_by 모호성 회피, #699)

export async function listOrgHooks(): Promise<OrgHook[]> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook ORDER BY sort, id`);
  return r.rows.map(mapHook);
}

// 런너 fetch 용 — enabled 훅만. harness 지정 시 그 하네스 또는 'all' 만. memberId 지정 시 per-member 유효성
//  적용(#699): 개인 오버라이드(org_asset_pref) 있으면 그 state, 없으면 target_members(NULL/빈=전원). enabled=false=마스터킬.
export async function listEnabledHooks(harness?: string, memberId?: string | null): Promise<OrgHook[]> {
  const r = await itemsPool.query(
    `SELECT ${HOOK_COLS_Q} FROM org_hook h
       LEFT JOIN org_asset_pref p ON p.target_kind='org_hook' AND p.ref_id=h.id AND p.member_id=$2
      WHERE h.enabled=true
        AND ($1::text IS NULL OR h.harness=$1 OR h.harness='all')
        AND (CASE WHEN p.member_id IS NOT NULL THEN p.state
                  ELSE (h.target_members IS NULL OR jsonb_array_length(h.target_members)=0
                        OR ($2::text IS NOT NULL AND h.target_members @> to_jsonb($2::text))) END)
      ORDER BY h.sort, h.id`,
    [harness ?? null, memberId ?? null],
  );
  return r.rows.map(mapHook);
}

export async function getOrgHook(id: string): Promise<OrgHook | null> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook WHERE id=$1`, [id]);
  return r.rows[0] ? mapHook(r.rows[0]) : null;
}

// 멤버 러너가 보고한 훅 실행 실패를 health 에 기록(#892). 멤버당 마지막 1건만 — 멤버 수로 유계라 정리 불요.
//  audit 은 남기지 않는다: 설정 변경이 아니라 런타임 텔레메트리이고, 크래시마다 감사로그를 채우면 노이즈다.
//  존재하지 않는 hook_id 는 UPDATE 가 0행으로 조용히 무시한다(멤버가 임의 키를 심을 수 없다).
export async function recordHookFailures(
  memberId: string,
  failures: { hook_id: string; reason: string; exit_code?: number | null; stderr?: string }[],
): Promise<void> {
  for (const f of failures) {
    const entry: OrgHookHealth = {
      at: new Date().toISOString(),
      reason: f.reason,
      exit_code: f.exit_code ?? null,
      stderr: (f.stderr ?? "").slice(-800),
    };
    await itemsPool.query(
      `UPDATE org_hook SET health = jsonb_set(COALESCE(health,'{}'::jsonb), ARRAY[$2::text], $3::jsonb, true) WHERE id=$1`,
      [f.hook_id, memberId, JSON.stringify(entry)],
    );
  }
}

export interface OrgHookInput {
  id: string;
  label?: string | null;
  harness?: HookHarness;
  event?: string;
  matcher?: string | null;
  source_code?: string;
  timeout_sec?: number;
  note?: string | null;
  summary?: string;            // 표시용 한 줄(#1085) — 미전송=보존
  target_members?: string[] | null; // #699: undefined=보존, null/빈=전원, 배열=지정
  enabled?: boolean;
  sort?: number;
}

export async function upsertOrgHook(h: OrgHookInput, ctx: WriteCtx = {}): Promise<OrgHook> {
  const before = await getOrgHook(h.id);
  const harness = h.harness ?? before?.harness ?? "all";
  const event = h.event ?? before?.event;
  if (!event) throw new Error("event 필수"); // delivery 가 먼저 검증하지만 store 계층 방어
  const sourceCode = h.source_code ?? before?.source_code ?? "";
  const contentHash = sha256(sourceCode);
  const targetMembers = h.target_members === undefined ? (before?.target_members ?? null) : h.target_members;
  // matcher — target_members 와 동형(#970): null 은 '전체 매칭'이라는 의미 있는 값이라 `?? before`(nullish 보존)로는
  //  '명시적 전체매칭'과 '미지정'을 못 가른다. undefined(미지정)만 보존, null/문자열은 그 값을 그대로 쓴다.
  const matcher = h.matcher === undefined ? (before?.matcher ?? null) : h.matcher;
  const summary = h.summary ?? before?.summary ?? "";
  await itemsPool.query(
    `INSERT INTO org_hook(id,label,harness,event,matcher,source_code,timeout_sec,note,summary,target_members,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$15,$14,$9,$10,1,$11,$12,now(),$13)
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label, harness=EXCLUDED.harness, event=EXCLUDED.event, matcher=EXCLUDED.matcher,
       source_code=EXCLUDED.source_code, timeout_sec=EXCLUDED.timeout_sec, note=EXCLUDED.note, summary=EXCLUDED.summary,
       target_members=EXCLUDED.target_members, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort, content_hash=EXCLUDED.content_hash,
       -- 본문이 바뀌면 건강 기록을 비운다(#892): 옛 본문의 실패는 새 본문과 무관한데, 안 지우면 고친 뒤에도
       -- '⚠ 실패' 배지가 영영 남아 지표를 못 믿게 된다(경보 피로). 본문이 그대로면(토글·라벨만 수정) 유지.
       health=CASE WHEN org_hook.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN '{}'::jsonb ELSE org_hook.health END,
       version=org_hook.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [h.id, h.label ?? before?.label ?? null, harness, event, matcher,
     sourceCode, h.timeout_sec ?? before?.timeout_sec ?? 10, h.note ?? before?.note ?? null,
     h.enabled ?? before?.enabled ?? true, h.sort ?? before?.sort ?? 0, contentHash,
     before?.created_by ?? ctx.actor ?? null, ctx.actor ?? null,
     targetMembers === null ? null : JSON.stringify(targetMembers), summary],
  );
  const after = await getOrgHook(h.id);
  await audit("org_hook", h.id, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgHook;
}

export async function removeOrgHook(id: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getOrgHook(id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_hook WHERE id=$1`, [id]);
  await audit("org_hook", id, "delete", before, null, ctx.actor, ctx.source, ctx);
}
