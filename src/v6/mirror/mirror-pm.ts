// PM 계층 미러(#541 무손실) — space/folder·list·view·comment·time 을 전용 테이블에 멱등 적재.
//  #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관(공용 해소 헬퍼는 mirror-common).
import type pg from "pg";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
import { normalizeExternalInstance } from "../../org/ingest/external-identity.js";
import type { RawItem } from "../../items/store.js";
import { folderIdByExternal, listIdByExternal, projectIdByExternal, resolveMemberId } from "./mirror-common.js";

// ── space/folder → project_folder 멱등 upsert. 컨테이너는 theirs-wins(이름·메타 — ClickUp 이 자기 계층의 권위). ──
//  adopt-by-name: external 미매치 + 동명(external 없음) 네이티브 폴더가 있으면 좌표를 접붙인다(중복 컨테이너 방지 —
//  기존 배포처럼 네이티브 리스트/폴더가 먼저 있던 DB 에 커넥터를 켜는 업그레이드 경로).
export async function mirrorPmFolderV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const settingsPatch = redactDeep({ clickup: f }) as Record<string, unknown>;
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const color = typeof f.color === "string" ? f.color : null;

  // 부모(스페이스) 해소 — folder 타입만. 스트림이 space 를 먼저 흘리므로 보통 즉시 해소.
  let parentId: number | null = null;
  if (it.type === "folder" && it.parent_external_id) {
    parentId = await folderIdByExternal(client, system, instance, it.parent_external_id);
  }

  const prev = await client.query(
    `SELECT id, settings FROM project_folder WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  let row = prev.rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined;

  if (!row) {
    // adopt-by-name(1건 한정, 좌표 없는 네이티브만).
    const adopt = await client.query(
      `SELECT id, settings FROM project_folder WHERE external_id IS NULL AND name=$1 ORDER BY id LIMIT 1`, [name]);
    row = adopt.rows[0] as typeof row;
  }

  if (row) {
    const mergedSettings = { ...(row.settings ?? {}), ...settingsPatch };
    await client.query(
      `UPDATE project_folder SET name=$2, color=COALESCE($3, color), parent_id=$4, settings=$5::jsonb,
          external_system=$6, external_instance=$7, external_id=$8, updated_at=now()
        WHERE id=$1`,
      [row.id, name, color, parentId, JSON.stringify({ ...mergedSettings, _raw: raw }), system, instance, externalId]);
  } else {
    await client.query(
      `INSERT INTO project_folder(name, color, parent_id, settings, created_by, external_system, external_instance, external_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [name, color, parentId, JSON.stringify({ ...settingsPatch, _raw: raw }), `connector:${system}`, system, instance, externalId]);
  }
  return true;
}

// ── list → project_list 멱등 upsert + settings.statuses(#475 UI 계약) 이관. ──
//  settings 병합 규칙: 커넥터 소유 키(statusMode/statuses/clickup)만 갱신, 로컬 키(icon 등)는 보존.
export async function mirrorPmListV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const statusDefs = Array.isArray(f.status_defs) ? (redactDeep(f.status_defs) as unknown[]) : [];

  // 부모 폴더(folder:... 또는 space:...) 해소.
  let folderId: number | null = null;
  if (it.parent_external_id) folderId = await folderIdByExternal(client, system, instance, it.parent_external_id);

  const prev = await client.query(
    `SELECT id, settings FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  let row = prev.rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined;

  if (!row) {
    // adopt-by-name(좌표 없는 네이티브 동명 리스트 — 업그레이드 경로 중복 방지).
    const adopt = await client.query(
      `SELECT id, settings FROM project_list WHERE external_id IS NULL AND name=$1 ORDER BY id LIMIT 1`, [name]);
    row = adopt.rows[0] as typeof row;
  }

  const clickupMeta = redactDeep({
    content: f.content ?? null, orderindex: f.orderindex ?? null, archived: !!f.archived,
    task_count: f.task_count ?? null, start_date: f.start_date ?? null, due_date: f.due_date ?? null,
    space_id: f.space_id ?? null, space_name: f.space_name ?? null,
    folder_id: f.folder_id ?? null, folder_name: f.folder_name ?? null,
    override_statuses: !!f.override_statuses,
    field_defs: f.field_defs ?? [],
    _raw: raw,
  });

  if (row) {
    const prevSettings = (row.settings ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...prevSettings, clickup: clickupMeta };
    if (statusDefs.length) {
      // 상태세트는 **순서 포함 전부 ClickUp 권위**(#541 고객사 A 라운드2). 이전엔 순서만 로컬 커스텀을 3-way 보존했는데,
      //  ①상태 정의는 아웃바운드 미푸시라 로컬 순서 편집이 ClickUp 과 발산만 낳고 ②커넥터 밖 경로(구버전 UI 수동 구성 등)로
      //  로컬≠base 가 된 리스트는 그 오순서가 '커스텀'으로 오인돼 영구 고착됐다(고객사 A 실사례 — 싱크로 안 낫는 상태 순서).
      //  theirs 전면 채택이 고착도 다음 싱크에 자동 치유한다. (로컬 순서 커스텀이 필요해지면 ClickUp 에서 바꾸는 게 정본.)
      merged.statusMode = "custom";
      merged.statuses = statusDefs;
      (merged.clickup as Record<string, unknown>).status_defs_base = statusDefs; // 진단용(마지막 커넥터 기록 순서)
    }
    await client.query(
      `UPDATE project_list SET name=$2, folder_id=$3, settings=$4::jsonb,
          external_system=$5, external_instance=$6, external_id=$7, updated_at=now()
        WHERE id=$1`,
      [row.id, name, folderId, JSON.stringify(merged), system, instance, externalId]);
  } else {
    const settings: Record<string, unknown> = { clickup: clickupMeta };
    if (statusDefs.length) {
      settings.statusMode = "custom"; settings.statuses = statusDefs;
      (settings.clickup as Record<string, unknown>).status_defs_base = statusDefs;
    }
    await client.query(
      `INSERT INTO project_list(name, folder_id, settings, created_by, external_system, external_instance, external_id)
        VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [name, folderId, JSON.stringify(settings), `connector:${system}`, system, instance, externalId]);
  }
  return true;
}

// ── view → project_view 멱등 upsert. 스코프(list|space|folder)별 FK 해소. config 는 원형 보존. ──
export async function mirrorPmViewV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const scopeKind = String(f.scope_kind ?? "list");
  const viewType = String(f.view_type ?? "list");
  const config = redactDeep({ ...(f.config as Record<string, unknown> ?? {}), _raw: it.raw ?? null });

  let listId: number | null = null;
  let folderId: number | null = null;
  if (it.parent_external_id) {
    if (scopeKind === "list") listId = await listIdByExternal(client, system, instance, it.parent_external_id);
    else folderId = await folderIdByExternal(client, system, instance, it.parent_external_id);
  }
  if (listId == null && folderId == null) return false; // 스코프 미해소 — 다음 싱크 수렴(컨테이너가 먼저 적재되면 해소)

  await client.query(
    `INSERT INTO project_view(list_id, folder_id, name, type, config, created_by, external_system, external_instance, external_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET list_id=EXCLUDED.list_id, folder_id=EXCLUDED.folder_id, name=EXCLUDED.name,
        type=EXCLUDED.type, config=EXCLUDED.config, updated_at=now()`,
    [listId, folderId, name, viewType, JSON.stringify(config), `connector:${system}`, system, instance, externalId]);
  return true;
}

// ── comment → task_comment 멱등 upsert(원시각 보존·답글 1단 해소·반응 미러). ──
export async function mirrorPmCommentV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const taskExt = String(f.task_external_id ?? it.parent_external_id ?? "");
  if (!taskExt) return false;
  const taskId = await projectIdByExternal(client, system, instance, taskExt);
  if (taskId == null) return false; // 귀속 태스크 미적재 — 스트림 순서상 드묾, 다음 싱크 수렴

  const author = await resolveMemberId(client, system, f.author as { id?: unknown; email?: unknown } | null)
    ?? `connector:${system}`;
  const body = redactString(String(it.body ?? ""));
  const raw = it.raw == null ? null : redactDeep(it.raw);

  let replyTo: number | null = null;
  const replyExt = f.reply_to_external_id ? String(f.reply_to_external_id) : null;
  if (replyExt) {
    const r = await client.query(`SELECT id FROM task_comment WHERE external_id=$1`, [replyExt]);
    replyTo = (r.rows[0] as { id: number } | undefined)?.id ?? null;
  }

  const res = await client.query(
    `INSERT INTO task_comment(task_id, author, body, reply_to, created_at, external_id, raw)
      VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7::jsonb)
     ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET body=EXCLUDED.body, author=EXCLUDED.author, reply_to=COALESCE(EXCLUDED.reply_to, task_comment.reply_to), raw=EXCLUDED.raw
     RETURNING id`,
    [taskId, author, body, replyTo, it.occurred_at ?? null, externalId, raw == null ? null : JSON.stringify(raw)]);
  const commentId = (res.rows[0] as { id: number }).id;

  // 반응(이모지) 미러 — ClickUp reactions [{reaction, user}] → task_comment_reaction 멱등.
  const reactions = Array.isArray(f.reactions) ? f.reactions as Array<Record<string, unknown>> : [];
  for (const rx of reactions) {
    const emoji = typeof rx?.reaction === "string" ? rx.reaction : null;
    if (!emoji) continue;
    const member = await resolveMemberId(client, system, rx?.user as { id?: unknown; email?: unknown } | null) ?? "clickup";
    await client.query(
      `INSERT INTO task_comment_reaction(comment_id, emoji, member) VALUES($1,$2,$3)
       ON CONFLICT (comment_id, emoji, member) DO NOTHING`,
      [commentId, emoji, member]);
  }
  return true;
}

// ── time → task_time_entry 멱등 upsert. ──
export async function mirrorPmTimeV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const taskExt = String(f.task_external_id ?? it.parent_external_id ?? "");
  if (!taskExt) return false;
  const taskId = await projectIdByExternal(client, system, instance, taskExt);
  if (taskId == null) return false;
  const member = typeof f.member === "string" ? f.member : null;
  const resolved = member ? await resolveMemberId(client, system, { email: member.includes("@") ? member : undefined, id: member.includes("@") ? undefined : member }) : null;

  await client.query(
    `INSERT INTO task_time_entry(task_id, member, started_at, ended_at, duration_seconds, note, source, external_id)
      VALUES($1,$2,$3,$4,$5,$6,'manual',$7)
     ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET task_id=EXCLUDED.task_id, member=EXCLUDED.member, started_at=EXCLUDED.started_at,
        ended_at=EXCLUDED.ended_at, duration_seconds=EXCLUDED.duration_seconds, note=EXCLUDED.note`,
    [taskId, resolved ?? member, f.started_at ?? null, f.ended_at ?? null,
     f.duration_seconds ?? null, f.note == null ? null : redactString(String(f.note)), externalId]);
  return true;
}
