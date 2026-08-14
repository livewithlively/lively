// 프로젝트/태스크 미러(clickup task → project) — 3-way 머지·부속 동기·재임베딩 큐.
//  #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관. flushProjectEmbeds 는 connector-mirror.js 배럴이 재수출.
import type pg from "pg";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
import { normalizeExternalInstance } from "../../org/ingest/external-identity.js";
import type { RawItem } from "../../items/store.js";
import { markProjectEmbeddingPending } from "../project-store.js";
import { merge3, msToKstDate, nativeStatusOf } from "./clickup-fields.js";
import { auditConnector, listIdByExternal, projectIdByExternal, resolveMemberId } from "./mirror-common.js";
import { syncMirrorAttachments, syncMirrorChecklists, syncMirrorCustomFields, syncMirrorLinks, syncMirrorTags } from "./mirror-task-parts.js";

// ── #624 프로젝트 임베딩 재트리거(검색 #631) — 미러 sync 에서 이름/설명이 '실제로 바뀐' project 행 id 만 모았다가,
//  배치(아이템별 BEGIN/COMMIT) 종료 후 run-sync 가 flushProjectEmbeds 로 일괄 pending 마킹. #1053: 서브프로세스에서
//  인라인 임베딩(HTTP)을 하지 않고 벡터만 비운다(nudge=false) — 실제 임베딩은 게이트웨이의 post-sync 스윕이
//  드레인한다(embedding-backfill.runAutoBackfillSweep; scheduler/index.ts·delivery.ts). 이로써 미러 sync 는 임베딩 부하를
//  지지 않고(느린 CPU 백엔드가 sync 런을 붙들던 문제 해소), knowledge 미러의 '리셋만 하고 떠난다' idiom 과 통일된다.
//  '텍스트 변경' 이벤트 게이트라 잦은 ClickUp 싱크(상태·기간·담당자 변경, 무변경 재싱크)엔 재임베딩이 안 튄다 — #624.
const pendingProjectEmbeds = new Set<number>();
export async function flushProjectEmbeds(_pool: pg.Pool): Promise<void> {
  if (pendingProjectEmbeds.size === 0) return;
  const ids = [...pendingProjectEmbeds];
  pendingProjectEmbeds.clear();
  // 벡터를 비워 pending 으로 되돌리기만 한다(nudge=false — run-sync 서브프로세스에서 스윕을 돌리지 않기 위함).
  //  삭제된 행은 UPDATE 가 0행이라 무해. 실제 텍스트는 스윕이 임베딩 시점에 DB 에서 다시 읽는다(큐잉 시점이 아니라 — 정합).
  for (const id of ids) {
    try { await markProjectEmbeddingPending(id, { nudge: false }); } catch { /* best-effort — 다음 편집/스윕이 보강 */ }
  }
}

// 프로젝트 행(level='project') 팀원 동기(#541) — 보드/상세의 '팀원'(project_member)이 ClickUp 어사이니를 보여주게.
//  가산+커넥터-소유분 회수: merged 에 없는 것 중 **이전 커넥터 집합(base)에 있던 것만** 제거 — 사람이 직접 추가한
//  팀원은 불가침. task_assignee/assignee 컬럼과 별개(그건 task 행 표면, 이건 project 행 표면).
async function syncProjectMembers(
  client: pg.PoolClient, projectId: number, prevConnectorSet: string[], merged: string[],
): Promise<void> {
  let sort = 100; // 사람 추가분(보통 0~) 뒤에 붙임 — 정렬 충돌 회피
  for (const m of merged) {
    await client.query(
      `INSERT INTO project_member(project_id, member_id, role, sort) VALUES($1,$2,'member',$3)
       ON CONFLICT (tenant_id, project_id, member_id) DO NOTHING`,
      [projectId, m, sort++]);
  }
  const removed = prevConnectorSet.filter((m) => !merged.includes(m));
  for (const m of removed) {
    await client.query(`DELETE FROM project_member WHERE project_id=$1 AND member_id=$2`, [projectId, m]);
  }
}

// clickup task → project(level='project'|'task'|'subtask') 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
//  level: 커넥터가 it.level 로 위계 전달(ClickUp Task 깊이→우리 level). it.level 부재(타 커넥터)면 parent 유무로 폴백.
//  #541 무손실: fields/raw 백스톱 + list_id/priority/dates/status_raw/assignee(3-way base 확장) +
//  부속(태그·체크리스트·커스텀필드·첨부·링크) 동기. 부모는 스트림 위상순서로 대부분 즉시 해소(+run-sync heal).
export async function mirrorProjectV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — name(title)/description(body)/external_url 평문 시크릿 마스킹.
  const name = it.title == null ? "" : redactString(String(it.title));
  const description = it.body == null ? null : redactString(String(it.body));
  const level = it.level ?? (it.parent_external_id ? "task" : "project");
  const author = `connector:${system}`;
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const fieldsJson = redactDeep(f);
  const rawJson = it.raw == null ? null : redactDeep(it.raw);

  // ── theirs 값 도출 ──
  const statusCategory = typeof f.status_category === "string" ? f.status_category : "unstarted";
  const priorityLabel = (f.priority as Record<string, unknown> | null)?.label;
  const priority = typeof priorityLabel === "string" && ["urgent", "high", "normal", "low"].includes(priorityLabel) ? priorityLabel : null;
  const startDate = msToKstDate(f.start_date_ms);
  const dueDate = msToKstDate(f.due_date_ms);
  const listExt = f.list_id != null ? String(f.list_id) : null;
  // 원본 생성/갱신 시각(#541) — ClickUp date_created/date_updated(ISO). 미러 행의 created_at/updated_at 은
  //  적재 시각이 아니라 소스 시각이어야 생성일·갱신일 컬럼이 ClickUp 과 동형(로컬 편집은 아웃박스 푸시가
  //  ClickUp date_updated 를 끌어올려 다음 싱크에 수렴).
  const theirsCreatedAt = it.occurred_at ?? null;
  const theirsUpdatedAt = it.updated_at ?? null;

  // 소속 리스트 행(1쿼리) — list_id 해소 + status key 매핑(settings.statuses) 겸용. 스트림이 리스트를 먼저 흘리므로 보통 존재.
  const listRow = listExt
    ? ((await client.query(
        `SELECT id, settings FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
        [system, instance, listExt])).rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined) ?? null
    : null;

  // status_raw = 리스트 settings.statuses 에서 **라벨 매치**로 key 채택(키 충돌 dedup(-2 접미) 정합 — #541 리뷰).
  //  리스트 미적재/라벨 미스매치면 슬러그 폴백(clickUpStatusKey 동형 — 자기일관).
  const statusLabel = f.status != null ? String(f.status) : null;
  let statusRaw: string | null = null;
  if (statusLabel) {
    const defs = Array.isArray((listRow?.settings as Record<string, unknown> | null)?.statuses)
      ? (listRow!.settings!.statuses as Array<{ key?: unknown; label?: unknown }>) : [];
    const hit = defs.find((s) => s && String(s.label ?? "") === statusLabel);
    statusRaw = hit?.key
      ? String(hit.key)
      : (statusLabel.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "status");
  }

  // 담당자 해소(3단 폴백) — theirs 를 member_id 배열로.
  const assigneesRaw = Array.isArray(f.assignees) ? f.assignees as Array<{ id?: unknown; email?: unknown }> : [];
  const theirsAssignees: string[] = [];
  for (const a of assigneesRaw) {
    const m = await resolveMemberId(client, system, a);
    if (m && !theirsAssignees.includes(m)) theirsAssignees.push(m);
  }
  const theirsAssigneeCol = theirsAssignees.length ? JSON.stringify(theirsAssignees) : null; // UI 규약(JSON 배열 문자열)

  // 부모 task 행 내부 id — 스트림이 부모 우선이라 보통 해소됨(미해소면 NULL → heal 패스 수렴).
  let parentId: number | null = null;
  if (it.parent_external_id) parentId = await projectIdByExternal(client, system, instance, it.parent_external_id);

  // ── 기존 행 조회 — 3-way 머지 base(external_base) + 감사 스냅샷. ──
  const prev = await client.query(
    `SELECT id, name, description, status, status_raw, status_category, priority, start_date, due_date,
            assignee, list_id, external_base
       FROM project
      WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as {
    id: number; name: string; description: string | null;
    status: string; status_raw: string | null; status_category: string | null;
    priority: string | null; start_date: string | null; due_date: string | null;
    assignee: string | null; list_id: number | null;
    external_base: Record<string, unknown> | null;
  } | undefined;
  const isInsert = !prevRow;

  let id: number;
  let appliedName = name;
  let appliedDesc: string | null = description;
  let changed: boolean;
  const theirsTags = Array.isArray(f.tags) ? f.tags as Array<{ name: string; fg?: string | null; bg?: string | null }> : [];

  if (isInsert) {
    // 최초 import — theirs 채택. external_base=theirs(다음 3-way 의 공통조상). tags 는 lower 정규화 키(케이스 무시 집합).
    const listId = listRow?.id ?? null;
    const baseJson = JSON.stringify({
      name, description, status_category: statusCategory, status_raw: statusRaw,
      priority, start_date: startDate, due_date: dueDate, assignee: theirsAssigneeCol,
      list_ext: listExt, tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
    });
    const ins = await client.query(
      `INSERT INTO project(
          level, parent_id, name, description, status, status_raw, status_category, created_by,
          priority, start_date, due_date, assignee, list_id,
          external_system, external_instance, external_id, external_url, external_base,
          fields, raw, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,COALESCE($21::timestamptz,now()),COALESCE($22::timestamptz,now()))
       RETURNING id`,
      [level, parentId, name, description, nativeStatusOf(statusCategory), statusRaw, statusCategory, author,
       priority, startDate, dueDate, theirsAssigneeCol, listId,
       system, instance, externalId, it.provenance.external_url ?? null, baseJson,
       JSON.stringify(fieldsJson), rawJson == null ? null : JSON.stringify(rawJson),
       theirsCreatedAt, theirsUpdatedAt],
    );
    id = (ins.rows[0] as { id: number }).id;
    let asort = 0;
    for (const m of theirsAssignees) {
      await client.query(
        `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
        [id, m, asort++]);
    }
    if (level === "project") await syncProjectMembers(client, id, [], theirsAssignees); // 팀원 표면(#541)
    changed = true;
  } else {
    // 기존 행 — 필드별 3-way 머지(base/ours/theirs). 충돌=ours(우리 DB master). 인바운드는 단일프로세스(스케줄러 락+배치 순차)라 SELECT→UPDATE TOCTOU 무시가능.
    id = prevRow!.id;
    // ⚠ 아웃박스 pending 가드(#541) — 직전 머지가 ours 우세로 끝나 푸시 대기 중이면, 그 푸시가 나가기 전의
    //  theirs 는 '아직 우리 값을 못 받은 구값'이다. base=merged 시맨틱상 o==b 로 보여 theirs 를 재채택(핑퐁)하므로,
    //  pending 동안은 base 를 **theirs 로 가장** → merge3 전 필드가 t==b → ours 유지(theirs 채택 봉인). 푸시
    //  드레인 후 다음 싱크부터 정상 3-way 재개. (푸시는 merged 를 PUT 하므로 pending 중 ClickUp 편집도 어차피 덮인다 — 일관.)
    const pendingPush = await client.query(
      `SELECT 1 FROM external_outbox WHERE system=$1 AND entity_id=$2 AND done_at IS NULL
        AND updated_at > now() - interval '24 hours' LIMIT 1`,
      [system, prevRow!.id]);
    const hasPendingPush = (pendingPush.rowCount ?? 0) > 0;
    const base = hasPendingPush
      ? {
          name, description, status_category: statusCategory,
          status_raw: statusRaw, priority, start_date: startDate,
          due_date: dueDate, assignee: theirsAssigneeCol, list_ext: listExt,
          tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
        } as Record<string, unknown>
      : (prevRow!.external_base ?? null);
    const mName = merge3(base?.name as string | undefined, prevRow!.name, name) ?? "";
    const mDesc = merge3(base?.description as string | null | undefined, prevRow!.description, description);
    const mCat = merge3(base?.status_category as string | undefined, prevRow!.status_category, statusCategory) ?? "unstarted";
    let mRaw = merge3(base?.status_raw as string | null | undefined, prevRow!.status_raw, statusRaw);
    // 레거시 라벨 정규화(#541 업그레이드 경로) — 구버전 미러는 status_raw 에 **원문 라벨**("to do")을 심었고,
    //  레거시 base(3키)엔 status_raw 가 없어 merge3 가 충돌→ours 로 라벨을 영구 고착시킨다. 같은 상태의 표기
    //  차이(라벨 vs 슬러그 키)는 로컬 편집이 아니므로 슬러그가 일치하면 키 표기로 수렴(진짜 상태 변경은 슬러그가 달라 보존).
    if (mRaw && statusRaw && mRaw !== statusRaw) {
      const slugOf = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "status";
      if (slugOf(mRaw) === statusRaw) mRaw = statusRaw;
    }
    const mPriority = merge3(base?.priority as string | null | undefined, prevRow!.priority, priority);
    const mStart = merge3(base?.start_date as string | null | undefined, prevRow!.start_date, startDate);
    const mDue = merge3(base?.due_date as string | null | undefined, prevRow!.due_date, dueDate);
    const mAssignee = merge3(base?.assignee as string | null | undefined, prevRow!.assignee, theirsAssigneeCol);
    // 리스트 좌표 — ours 를 external id 로 환산해 base/theirs 와 비교(로컬 이동 보존, 외부 이동 수렴).
    let oursListExt: string | null = null;
    if (prevRow!.list_id != null) {
      const r = await client.query(`SELECT external_id FROM project_list WHERE id=$1`, [prevRow!.list_id]);
      oursListExt = (r.rows[0] as { external_id: string | null } | undefined)?.external_id ?? `__local:${prevRow!.list_id}`;
    }
    const mListExt = merge3(base?.list_ext as string | null | undefined, oursListExt, listExt);
    let mListId: number | null = prevRow!.list_id;
    if (mListExt !== oursListExt) {
      mListId = mListExt && !mListExt.startsWith("__local:")
        ? (mListExt === listExt ? (listRow?.id ?? null) : await listIdByExternal(client, system, instance, mListExt))
        : null;
    }
    // status_category 가 ours 로 유지되면 네이티브 status 도 ours 보존(active↔in_progress 동일카테고리 진동 방지). theirs 채택 시만 재투영.
    const mStatus = mCat === (prevRow!.status_category ?? null) ? prevRow!.status : nativeStatusOf(mCat);

    // 태그 집합 3-way(부속이지만 base 에 함께 실림).
    await syncMirrorTags(client, id, (base?.tags as string[] | undefined) ?? null, theirsTags);

    // ── base 전진 규칙(#541 리뷰) — 필드가 **외부로 수렴하는 경로가 있는지**에 따라 갈린다: ──
    //  · 푸시 필드(name/desc/status_category/priority/dates — mkBody 에 실림): base=merged. 우리값 우세 시
    //    아웃박스 푸시가 ClickUp 을 merged 로 끌어와 base 가 실제 공통조상이 된다.
    //  · 미푸시 필드(status_raw/assignee/list_ext/tags): base=**theirs**. merged 로 전진하면 다음 싱크에
    //    ours==base·theirs≠base 가 되어 theirs 재채택 → 로컬 편집이 두 번째 싱크에 조용히 원복된다.
    //    theirs 를 기록하면 t==b 로 ours 가 안정 유지되고, 외부 실변경 시에만 채택/충돌 판정이 돈다.
    const newBase = JSON.stringify({
      name: mName, description: mDesc, status_category: mCat,
      priority: mPriority, start_date: mStart, due_date: mDue,
      status_raw: statusRaw, assignee: theirsAssigneeCol, list_ext: listExt,
      tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
    });
    await client.query(
      `UPDATE project SET
          level=$2, parent_id=COALESCE($3, parent_id),
          name=$4, description=$5, status=$6, status_raw=$7, status_category=$8,
          priority=$9, start_date=$10, due_date=$11, assignee=$12, list_id=$13,
          external_url=$14, external_base=$15::jsonb,
          fields=$16::jsonb, raw=$17::jsonb,
          created_at=COALESCE($18::timestamptz, created_at), updated_at=COALESCE($19::timestamptz, now())
        WHERE id=$1`,
      [id, level, parentId, mName, mDesc, mStatus, mRaw, mCat,
       mPriority, mStart, mDue, mAssignee, mListId,
       it.provenance.external_url ?? null, newBase,
       JSON.stringify(fieldsJson), rawJson == null ? null : JSON.stringify(rawJson),
       theirsCreatedAt, theirsUpdatedAt]);
    appliedName = mName; appliedDesc = mDesc;

    // task_assignee 섀도 동기(머지 결과 기준 통째 교체 — project-store.syncTaskAssignees 시맨틱).
    const mergedAssignees: string[] = (() => {
      if (!mAssignee) return [];
      try { const arr = JSON.parse(mAssignee); return Array.isArray(arr) ? arr.filter(Boolean) : [String(mAssignee)]; }
      catch { return [String(mAssignee)]; }
    })();
    await client.query(`DELETE FROM task_assignee WHERE task_id=$1`, [id]);
    let asort = 0;
    for (const m of mergedAssignees) {
      await client.query(
        `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
        [id, m, asort++]);
    }
    // 팀원 표면 동기(#541) — 이전 커넥터 집합 = base.assignee(JSON 배열 문자열).
    if (level === "project") {
      const prevSet: string[] = (() => {
        const b = base?.assignee;
        if (typeof b !== "string" || !b) return [];
        try { const a = JSON.parse(b); return Array.isArray(a) ? a.filter(Boolean).map(String) : []; } catch { return []; }
      })();
      await syncProjectMembers(client, id, prevSet, mergedAssignees);
    }

    // 수렴 — 머지결과가 theirs 와 다르면(우리값 우세) ClickUp 도 merged 로 끌어와야 다음 싱크 진동 안 함 → 아웃박스(같은 client, 원자적).
    //  priority/dates 포함(#541) — mkBody 가 싣는 필드는 전부: base=merged 규칙(위)의 전제가 '우세 시 반드시 푸시'이므로.
    if (mName !== name || (mDesc ?? null) !== (description ?? null) || mCat !== statusCategory
      || (mPriority ?? null) !== (priority ?? null) || (mStart ?? null) !== (startDate ?? null) || (mDue ?? null) !== (dueDate ?? null)) {
      await client.query(
        `INSERT INTO external_outbox(entity_id, system, op) VALUES($1,$2,'upsert')
         ON CONFLICT (tenant_id, system, entity_id) WHERE done_at IS NULL
         DO UPDATE SET op='upsert', updated_at=now(), attempts=0, last_error=NULL`,
        [id, system]);
    }
    changed = (mName !== (prevRow!.name ?? "")) || ((mDesc ?? null) !== (prevRow!.description ?? null)) || (mCat !== (prevRow!.status_category ?? null));
  }

  // ── 부속 동기(무손실) — 태그(insert 경로), 체크리스트, 커스텀필드, 첨부, 링크. 모두 멱등·best-effort 아님(트랜잭션 내). ──
  if (isInsert && theirsTags.length) {
    await syncMirrorTags(client, id, null, theirsTags);
  }
  const checklists = Array.isArray(f.checklists) ? f.checklists as Parameters<typeof syncMirrorChecklists>[3] : [];
  await syncMirrorChecklists(client, system, id, checklists);

  // 커스텀필드 — 정의는 루트 프로젝트에. 루트 = 자기 자신(project) 또는 top_level_parent/parent 해소.
  const customFields = Array.isArray(f.custom_fields) ? f.custom_fields as Parameters<typeof syncMirrorCustomFields>[4] : [];
  if (customFields.length) {
    let rootId: number | null = level === "project" ? id : null;
    if (rootId == null) {
      const rawTask = (it.raw ?? {}) as { top_level_parent?: string | null; parent?: string | null };
      const rootExt = rawTask.top_level_parent ?? rawTask.parent ?? it.parent_external_id ?? null;
      if (rootExt) rootId = await projectIdByExternal(client, system, instance, String(rootExt));
    }
    if (rootId != null) await syncMirrorCustomFields(client, system, id, rootId, customFields);
  }

  const attachments = Array.isArray(f.attachments) ? f.attachments as Parameters<typeof syncMirrorAttachments>[3] : [];
  await syncMirrorAttachments(client, system, id, attachments);

  const deps = Array.isArray(f.dependencies) ? f.dependencies as Array<Record<string, unknown>> : [];
  const linked = Array.isArray(f.linked_tasks) ? f.linked_tasks as Array<Record<string, unknown>> : [];
  if (deps.length || linked.length) await syncMirrorLinks(client, system, instance, id, externalId, deps, linked);

  if (changed) {
    const beforeSnap = isInsert ? null : { id, name: prevRow!.name, description: prevRow!.description };
    const afterSnap = { id, level, name: appliedName, description: appliedDesc, external_system: system, external_id: externalId, created_by: author };
    await auditConnector(client, "project", String(id), isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  // #624 재임베딩 트리거 — 이름/설명이 실제로 바뀐 미러 행만 큐잉(신규 포함). 상태·담당자·기간·무변경 재싱크엔 안 걸림.
  //  커밋 후 run-sync 가 flushProjectEmbeds 로 pending 마킹(벡터 리셋)하고, 실제 임베딩은 게이트웨이 post-sync 스윕이 채운다(#1053).
  if (isInsert || appliedName !== prevRow!.name || (appliedDesc ?? null) !== (prevRow!.description ?? null)) {
    pendingProjectEmbeds.add(id);
  }
  return true;
}
