// 태스크 부속 동기(#541) — 태그·체크리스트·커스텀필드·첨부·링크. mirrorProjectV6 가 트랜잭션 안에서 호출.
//  #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관(mirror-project.ts 500줄 상한 유지를 위해 부속만 분리).
import type pg from "pg";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
import { mergeSet, mapClickUpFieldType, mapClickUpFieldConfig, mapClickUpFieldValue } from "./clickup-fields.js";
import { projectIdByExternal, resolveMemberId } from "./mirror-common.js";

// ════════════════════════════════════════════════════════════════════════════
// ── 태스크 부속 동기(#541) — mirrorProjectV6 가 호출. 모두 external 좌표 멱등. ──
// ════════════════════════════════════════════════════════════════════════════

// 태그 — task_tag(lower(name) upsert, color=bg) + task_tag_link 집합 3-way(base 는 external_base.tags).
//  집합 연산은 **lower 정규화 키**로(#541 리뷰) — task_tag 정체성이 lower(name) 유니크라, 케이스만 다른 표기를
//  구분하면 base 에 두 표기가 쌓여 싱크마다 링크 삭제/재추가로 진동한다. 표시 이름은 DB 기존 표기 우선.
export async function syncMirrorTags(
  client: pg.PoolClient, taskId: number,
  baseTags: string[] | null, theirsTags: Array<{ name: string; fg?: string | null; bg?: string | null }>,
): Promise<string[]> {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const cur = await client.query(
    `SELECT t.name FROM task_tag_link l JOIN task_tag t ON t.id=l.tag_id WHERE l.task_id=$1`, [taskId]);
  const oursOrig = (cur.rows as Array<{ name: string }>).map((r) => r.name);
  const ours = oursOrig.map(norm);
  const theirsOrig = theirsTags.map((t) => t.name).filter(Boolean);
  const theirs = theirsOrig.map(norm);
  const merged = mergeSet((baseTags ?? []).map(norm), ours, theirs);

  // 표시 이름/색: theirs 원문 → ours(DB 기존 표기)가 덮음(기존 태그 표기 보존).
  const displayOf = new Map<string, string>();
  for (const n of theirsOrig) displayOf.set(norm(n), n);
  for (const n of oursOrig) displayOf.set(norm(n), n);
  const colorOf = new Map(theirsTags.map((t) => [norm(t.name), t.bg ?? null]));

  for (const key of merged) {
    if (ours.includes(key)) continue;
    const tag = await client.query(
      `INSERT INTO task_tag(name, color) VALUES($1,$2)
       ON CONFLICT (lower(name)) DO UPDATE SET color=COALESCE(task_tag.color, EXCLUDED.color)
       RETURNING id`,
      [displayOf.get(key) ?? key, colorOf.get(key) ?? null]);
    await client.query(
      `INSERT INTO task_tag_link(task_id, tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [taskId, (tag.rows[0] as { id: number }).id]);
  }
  for (const key of ours) {
    if (merged.includes(key)) continue;
    await client.query(
      `DELETE FROM task_tag_link WHERE task_id=$1 AND tag_id=(SELECT id FROM task_tag WHERE lower(name)=$2)`,
      [taskId, key]);
  }
  return merged;
}

// 체크리스트 — external_id 멱등 upsert + 외부 소멸분 삭제(외부 키 있는 행만 — 로컬 체크리스트 불가침).
export async function syncMirrorChecklists(
  client: pg.PoolClient, system: string, taskId: number,
  theirs: Array<{ external_id: string; name?: string | null; orderindex?: number | null;
    items?: Array<{ external_id: string; name?: string | null; resolved?: boolean; orderindex?: number | null;
      assignee?: { id?: unknown; email?: unknown } | null }> }>,
): Promise<void> {
  const keepCl = new Set<string>();
  for (const cl of theirs) {
    if (!cl?.external_id) continue;
    keepCl.add(cl.external_id);
    const r = await client.query(
      `INSERT INTO task_checklist(task_id, name, sort, external_id)
        VALUES($1,$2,$3,$4)
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET task_id=EXCLUDED.task_id, name=EXCLUDED.name, sort=EXCLUDED.sort
       RETURNING id`,
      [taskId, redactString(String(cl.name ?? "")), Math.round(Number(cl.orderindex ?? 0)) || 0, cl.external_id]);
    const clId = (r.rows[0] as { id: number }).id;

    const keepItems = new Set<string>();
    for (const item of cl.items ?? []) {
      if (!item?.external_id) continue;
      keepItems.add(item.external_id);
      const assignee = await resolveMemberId(client, system, item.assignee ?? null);
      await client.query(
        `INSERT INTO task_checklist_item(checklist_id, name, done, assignee, sort, external_id)
          VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET checklist_id=EXCLUDED.checklist_id, name=EXCLUDED.name, done=EXCLUDED.done,
            assignee=EXCLUDED.assignee, sort=EXCLUDED.sort`,
        [clId, redactString(String(item.name ?? "")), !!item.resolved, assignee,
         Math.round(Number(item.orderindex ?? 0)) || 0, item.external_id]);
    }
    await client.query(
      `DELETE FROM task_checklist_item WHERE checklist_id=$1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
      [clId, [...keepItems]]);
  }
  await client.query(
    `DELETE FROM task_checklist WHERE task_id=$1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
    [taskId, [...keepCl]]);
}

// 커스텀필드 — 정의는 태스크의 **루트 프로젝트**에 복제 upsert((project_id, external_id) 멱등), 값은 이 행에.
//  값 부재 필드는 값 행 삭제(reconcile — ClickUp 에서 지운 값 수렴). 정의 삭제는 안 함(보수적 — 값만 사라짐).
export async function syncMirrorCustomFields(
  client: pg.PoolClient, system: string, taskId: number, rootProjectId: number,
  theirs: Array<{ external_id: string; name?: string | null; type?: string | null;
    type_config?: Record<string, unknown> | null; value?: unknown; value_markdown?: string | null }>,
): Promise<void> {
  for (const cf of theirs) {
    if (!cf?.external_id) continue;
    const ftype = mapClickUpFieldType(cf.type);
    const config = redactDeep(mapClickUpFieldConfig(cf.type, cf.type_config ?? null));
    const r = await client.query(
      `INSERT INTO task_field(project_id, field_type, name, config, created_by, external_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (project_id, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET name=EXCLUDED.name, config=EXCLUDED.config
       RETURNING id`,
      [rootProjectId, ftype, redactString(String(cf.name ?? cf.external_id)).slice(0, 120),
       JSON.stringify(config), `connector:${system}`, cf.external_id]);
    const fieldId = (r.rows[0] as { id: number }).id;

    const hasValue = cf.value !== undefined && cf.value !== null;
    if (hasValue) {
      const decoded = redactDeep(mapClickUpFieldValue(cf.type, cf.value, cf.type_config ?? null));
      await client.query(
        `INSERT INTO task_field_value(field_id, task_id, value) VALUES($1,$2,$3::jsonb)
         ON CONFLICT (field_id, task_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [fieldId, taskId, JSON.stringify(decoded)]);
    } else {
      await client.query(`DELETE FROM task_field_value WHERE field_id=$1 AND task_id=$2`, [fieldId, taskId]);
    }
  }
}

// 첨부 — external_id(네이티브)/(task_id,url)(인라인) 멱등 upsert + 외부 소멸분 삭제(clickup 소스 행만).
export async function syncMirrorAttachments(
  client: pg.PoolClient, system: string, taskId: number,
  theirs: Array<{ external_id?: string | null; title?: string | null; url?: string | null; mimetype?: string | null;
    extension?: string | null; size?: number | null; thumbnail?: string | null; parent_type?: string | null;
    source?: string | null; raw?: unknown }>,
): Promise<void> {
  const keepExt: string[] = [];
  const keepUrls: string[] = [];
  for (const a of theirs) {
    const raw = a.raw == null ? null : redactDeep(a.raw);
    if (a.external_id) {
      keepExt.push(a.external_id);
      await client.query(
        `INSERT INTO task_attachment(task_id, external_id, title, url, mimetype, extension, size, source, thumbnail, parent_type, raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET task_id=EXCLUDED.task_id, title=EXCLUDED.title, url=EXCLUDED.url, mimetype=EXCLUDED.mimetype,
            extension=EXCLUDED.extension, size=EXCLUDED.size, thumbnail=EXCLUDED.thumbnail, raw=EXCLUDED.raw`,
        [taskId, a.external_id, a.title ?? null, a.url ?? null, a.mimetype ?? null, a.extension ?? null,
         a.size ?? null, a.source ?? system, a.thumbnail ?? null, a.parent_type ?? "tasks",
         raw == null ? null : JSON.stringify(raw)]);
    } else if (a.url) {
      keepUrls.push(a.url);
      await client.query(
        `INSERT INTO task_attachment(task_id, title, url, source, parent_type)
          VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (task_id, url) WHERE external_id IS NULL AND url IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title`,
        [taskId, a.title ?? null, a.url, a.source ?? `${system}_inline`, a.parent_type ?? "task_inline"]);
    }
  }
  // 소멸 reconcile — 이 태스크의 clickup 계열 행 중 이번 수집에 없는 것 삭제(로컬/타소스 행 불가침).
  await client.query(
    `DELETE FROM task_attachment
      WHERE task_id=$1 AND source LIKE $2
        AND ((external_id IS NOT NULL AND NOT (external_id = ANY($3::text[])))
          OR (external_id IS NULL AND url IS NOT NULL AND NOT (url = ANY($4::text[]))))`,
    [taskId, `${system}%`, keepExt, keepUrls]);
}

// 의존성/링크 — 양측이 미러에 존재할 때 task_link 멱등 insert(+상호 역방향). 추가 전용(삭제는 raw 백스톱 기준 후속).
export async function syncMirrorLinks(
  client: pg.PoolClient, system: string, instance: string, taskId: number, taskExt: string,
  dependencies: Array<Record<string, unknown>>, linked: Array<Record<string, unknown>>,
): Promise<void> {
  const put = async (from: number, to: number, type: string) => {
    await client.query(
      `INSERT INTO task_link(from_task, to_task, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [from, to, type]);
  };
  for (const d of dependencies) {
    const a = String(d?.task_id ?? ""); const b = String(d?.depends_on ?? "");
    if (!a || !b) continue;
    const otherExt = a === taskExt ? b : b === taskExt ? a : null;
    if (!otherExt) continue;
    const otherId = await projectIdByExternal(client, system, instance, otherExt);
    if (otherId == null) continue;
    if (a === taskExt) { await put(taskId, otherId, "waiting_on"); await put(otherId, taskId, "blocking"); }
    else { await put(taskId, otherId, "blocking"); await put(otherId, taskId, "waiting_on"); }
  }
  for (const l of linked) {
    const otherExt = String(l?.task_id ?? l?.link_id ?? "");
    if (!otherExt || otherExt === taskExt) continue;
    const otherId = await projectIdByExternal(client, system, instance, otherExt);
    if (otherId == null) continue;
    await put(taskId, otherId, "linked"); await put(otherId, taskId, "linked");
  }
}
