// 자료 미러(slack/gmail/discord message 등 → source) — #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관.
import type pg from "pg";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
import { normalizeExternalInstance } from "../../org/ingest/external-identity.js";
import type { RawItem } from "../../items/store.js";
import { auditConnector } from "./mirror-common.js";
import { stampSourceVisibility } from "../source-vis-policy.js";

// system → source.kind 매핑(표준 kind 준수 — SOURCE_KINDS). 그 외는 'other'(raw 에 system 보존).
function sourceKindOf(system: string): string {
  switch (system) {
    case "slack": return "slack";
    case "gmail": return "email";
    case "notion": return "notion_doc";
    case "clickup": return "clickup_doc";
    case "gdrive": return "drive_file"; // #541 Drive 파일 = raw 자료(source) → distill 대상
    case "discord": return "discord";   // #735 커넥터별 kind 충실화(종전 'other' 로 뭉뚱그려져 UI 필터 불가)
    case "local": return "local_file";  // #1881 내 컴퓨터 업로드(폴더·파일) — drive_file 과 섞이면 자료함 필터·증류기 match_kinds 가 갈린다
    default: return "other";
  }
}

// slack/gmail/discord message(및 미정제 raw) → source(자료) 멱등 upsert (#541). distill 이 여기서 지식을 증류(source→knowledge).
//  external 좌표(source_external_uidx) ON CONFLICT. 본문 실변경 시에만 audit(노이즈 게이트 — knowledge 미러와 동일).
//  🔴H1 redact — title/body/raw 평문 시크릿 마스킹. provenance=observed(외부 수집물). knowledge_search 에 자동 미포함(별 테이블).
export async function mirrorSourceV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const kind = sourceKindOf(system);
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const author = `connector:${system}`;

  // #735 구조화 메타 보존 — 예전엔 message→source 미러가 it.fields·container_ref·actor 를 통째로 버려
  //  (knowledge 미러는 fields 를 보존하는데 source 미러만 누락) 채널명·작성자·스레드 같은 지식화 핵심 맥락이
  //  유실됐다. 여기서 커넥터가 채운 구조화 값을 source.fields(JSONB)에 접어 저장한다 — slack 특화가 아니라
  //  전 커넥터(gmail·notion·discord 등) 공통. body/title(raw 원문)은 건드리지 않는다.
  const baseFields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = { ...baseFields, _item_type: it.type };
  if (it.container_ref) fields.container_ref = it.container_ref;
  if (it.container_name) fields.container_name = redactString(String(it.container_name));
  if (it.actor?.external_id) fields.author_external_id = it.actor.external_id;
  if (it.actor?.display_name) fields.author_name = redactString(String(it.actor.display_name));
  if (it.actor?.email) fields.author_email = redactString(String(it.actor.email));
  if (it.actor?.is_bot != null) fields.author_is_bot = it.actor.is_bot;

  // ── 감사 노이즈 게이트 — external 좌표로 기존 행을 읽어 본문/제목 비교. no-op 재싱크(last_synced_at-only)는 audit 생략. ──
  const prev = await client.query(
    `SELECT id, title, body_md FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as { id: number; title: string | null; body_md: string } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.title ?? null) !== (title ?? null)
    || (prevRow.body_md ?? "") !== (body ?? "");

  const r = await client.query(
    `INSERT INTO source(
        kind, title, body_md, raw, fields, provenance,
        external_system, external_instance, external_id, external_url, parent_external_id,
        occurred_at, last_synced_at, author, updated_at, updated_by)
      VALUES($1,$2,$3,$4::jsonb,$11::jsonb,'observed',
             $5,$6,$7,$8,$12,
             $9, now(), $10, now(), $10)
     ON CONFLICT (tenant_id, external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        kind=EXCLUDED.kind, title=EXCLUDED.title, body_md=EXCLUDED.body_md, raw=EXCLUDED.raw,
        fields=EXCLUDED.fields, parent_external_id=EXCLUDED.parent_external_id,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(),
        -- ⚠ updated_at 은 **내용이 바뀐 시각**이다 — "마지막 동기화 시각"은 last_synced_at 이 맡는다.
        --  무조건 now() 로 밀면 일일 full 스윕이 전 자료의 updated_at 을 갱신하고, 이걸 재판정 신호로 쓰는
        --  증류 인박스가 **매일 전량을 다시 증류한다**(#1289). 제목·본문이 실제로 달라졌을 때만 전진시킨다.
        updated_at=CASE WHEN $13::boolean THEN now() ELSE source.updated_at END,
        updated_by=EXCLUDED.updated_by
     RETURNING id`,
    [kind, title, body, raw == null ? null : JSON.stringify(raw),
     system, instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, author, JSON.stringify(fields), it.parent_external_id ?? null,
     contentChanged],
  );
  const id = (r.rows[0] as { id: number }).id;

  // 공개범위(#1291 v4) — 커넥터별 정책으로 **태어날 때** 정한다. 자료의 생산자는 사람이 아니라 커넥터라
  //  개별 잠금이 현실적이지 않다(슬랙만 1만건 규모). 채널 좌표는 fields 에 접힌 값을 그대로 쓴다.
  //  ⚠ INSERT 에만 — 재싱크마다 덮으면 사람이 손으로 조정한 공개범위가 매번 되돌아간다.
  if (isInsert) {
    await stampSourceVisibility(client, id, system,
      [it.container_ref, it.container_name, fields.container_ref as string, fields.container_name as string]);
  }

  if (contentChanged) {
    const beforeSnap = isInsert ? null : { id, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { id, kind, title, body_md: body, provenance: "observed", source: system, author };
    await auditConnector(client, "source", String(id), isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}
