// v6 외부 미러 적재 — 커넥터(RawItem) → v6 knowledge/project/source + PM 계층(폴더·리스트·뷰·댓글·타임). 구 knowledge-mirror.ts(→knowledge_unit) 대체.
//
//   v6 모델은 kind(R/K/H/W)를 폐기하고 직교축(injection/provenance)으로 분리했고, 외부 작업(구 W ku)은
//   1급 엔티티 project(level=task/subtask)로 흡수했다. 따라서 커넥터 미러는 **소스로 갈라** 적재한다:
//     · clickup task → project(level='project'|'task'|'subtask' — external_* 좌표 보유).
//     · clickup space/folder → project_folder(중첩), list → project_list(+settings.statuses), view → project_view,
//       comment → task_comment, time → task_time_entry  (#541 무손실 이관).
//     · notion(및 그 외 K류 미러) → knowledge(provenance='observed'), slack/gmail message → source(자료).
//   분류는 ingest-classify.routeIngestV6 가 단일 결정.
//
//   멱등(external idempotency): 각 테이블의 external 부분유니크 ON CONFLICT upsert — 재싱크는 중복 없이 수렴.
//   external_instance 는 NULL→'' 정규화(부분 UNIQUE 갭 메움, pg NULL distinct 회피 — external-identity 중앙 helper).
//
//   🔴H1 redact — title/body/fields/raw 를 쓰기 **전** redactString/redactDeep(커넥터 원본 평문 토큰 마스킹).
//
//   ── 감사 노이즈 게이트(구 mirror 의 핵심 보존) — 미러는 고빈도(매 싱크 다수 행 UPDATE: status-sync 등)라
//      무조건 audit append 하면 org_content_audit 가 노이즈로 비대해진다. 따라서 **본문/제목 실변경 시에만**
//      org_content_audit 리비전을 남긴다. upsert 전에 기존 행을 읽어 비교하고, no-op 재싱크(last_synced_at-only)
//      는 audit 를 생략한다(행은 갱신, 이력은 무변). insert 는 항상 1건(v1). channel='connector',
//      actor='connector:<system>', actor_kind='connector'(채널 신뢰가 아닌 결정적 라벨).
//
//   ⚠ 비파괴·best-effort: 호출자(ingestItems)가 try/catch 로 격리(미러 실패가 인입을 깨면 안 됨 —
//      다음 싱크가 멱등 수렴). item 단위 BEGIN/COMMIT — 한 태스크의 다중 테이블 쓰기(본체+태그+체크리스트+
//      필드+첨부)가 원자적으로 성립/철회된다(ingestItems 자체는 트랜잭션이 없음 — #541 확인).
//
//   ── 담당자(어사이니) 해소(#541) — ClickUp 유저 → org_member.id 3단 폴백(손실 0):
//      ① person_identity(system, external_id=email|숫자id) → person_id(=org_member.id 동기 계약) 가 org_member 에 실재하면 채택
//      ② org_member.email lower 매치
//      ③ raw email(소문자) 또는 숫자 id 문자열 그대로 — UI 는 미해소 id 를 raw+이니셜로 폴백 표시, 관리탭
//         'ClickUp 멤버 매핑'(org_member.identities)으로 사후 매핑하면 다음 싱크가 수렴.
//
//   ── 모듈 지도(#1313 R20) — 이 파일은 **디스패처+재수출 배럴**만 갖고, 축별 적재는 src/v6/mirror/ 에 있다: ──
//     · mirror/clickup-fields.ts   ClickUp 필드/상태 순수 매핑 + merge3/mergeSet (DB 무의존 leaf)
//     · mirror/mirror-common.ts    감사 append(auditConnector) + external 좌표/멤버 해소(공용)
//     · mirror/mirror-knowledge.ts notion 등 K류 → knowledge (+domain-wiki name-키 upsert·삭제 스윕)
//     · mirror/mirror-pm.ts        space/folder·list·view·comment·time → PM 전용 테이블
//     · mirror/mirror-task-parts.ts 태스크 부속 동기(태그·체크리스트·커스텀필드·첨부·링크)
//     · mirror/mirror-project.ts   clickup task → project(3-way 머지) + 재임베딩 큐(flushProjectEmbeds)
//     · mirror/mirror-source.ts    slack/gmail/discord message 등 → source(자료)
//     · mirror/notion-post.ts      노션 후처리(링크 물질화·자식 순서·아카이브 스윕·델타 원장)
import type pg from "pg";
import { buildMemberResolver, reresolveMemberList } from "./member-resolve.js"; // #697 재해소 순수 로직(테스트 분리)
import { routeIngestV6, alsoMirrorKnowledge } from "../org/ingest/ingest-classify.js";
import { boundCollector } from "../connectors/config.js"; // #1419 T3 — 수집기 산출 정책(자료/지식/둘 다)
import type { RawItem } from "../items/store.js";
import { mirrorKnowledgeByNameV6, mirrorKnowledgeV6 } from "./mirror/mirror-knowledge.js";
import { mirrorPmCommentV6, mirrorPmFolderV6, mirrorPmListV6, mirrorPmTimeV6, mirrorPmViewV6 } from "./mirror/mirror-pm.js";
import { mirrorProjectV6 } from "./mirror/mirror-project.js";
import { mirrorSourceV6 } from "./mirror/mirror-source.js";

// ── 재수출 배럴(#1313 R20) — 축별 모듈로 해체했으나 **외부 표면은 byte 불변**이다. 소비자(run-sync·items/store·
//  list-store·delivery·notion 커넥터·R7 테스트)는 종전대로 connector-mirror.js 만 import 한다.
export { nativeStatusOf, merge3, mergeSet, msToKstDate, mapClickUpFieldType, mapClickUpFieldConfig, mapClickUpFieldValue } from "./mirror/clickup-fields.js";
export { sweepDomainWikiArchived } from "./mirror/mirror-knowledge.js";
export { flushProjectEmbeds } from "./mirror/mirror-project.js";
export { materializeNotionLinks, applyNotionChildrenOrder, sweepNotionArchived, loadNotionLedger } from "./mirror/notion-post.js";
export type { NotionLedgerEntry, NotionLedger } from "./mirror/notion-post.js";

// ════════════════════════════════════════════════════════════════════════════
// ── 미러 멤버 재해소(#697) — 뒤늦게 건 매핑을 이미 미러된 데이터에 소급 적용 ──
// ════════════════════════════════════════════════════════════════════════════
//  문제: resolveMemberId 는 미러 시점 eager 해소라, 당시 미매핑이던 어사이니/작성자/멤버는 raw(email 소문자 또는
//   ClickUp 숫자 id — resolveMemberId ③)로 굳는다. 이후 관리탭에서 매핑(person_identity)을 걸어도 (a) 매핑 저장은
//   person_identity 만 갱신하고 (b) 증분 싱크는 그 태스크가 외부에서 안 바뀌면 재수집하지 않아 raw 가 영구 잔존한다.
//  해법: raw→org_member.id 재해소를 (1) 매핑 저장 시점(delivery org_member_upsert)과 (2) 매 clickup 싱크
//   (healPmMirror) 양쪽에서 돌려 소급·수렴시킨다. 대상 7개 표면: project.assignee(+external_base.assignee)·
//   task_assignee·project_member·task_comment.author·task_comment_reaction.member·task_time_entry.member·
//   task_checklist_item.assignee. 멱등: 이미 org_member.id 인 값(슬러그)은 맵 키(이메일/숫자)에 없어 불변이고,
//   raw(이메일/숫자)만 매칭되므로 네이티브(비미러) 행은 건드리지 않는다.

// 표면 재해소 실행 — member-resolve 맵으로 raw→org_member.id 치환 + 어사이니 표면 백필. 자체 트랜잭션(원자적).
//  best-effort 호출자(healPmMirror/delivery)가 예외를 격리한다(롤백 후 rethrow — 부분 적용 split-brain 방지).
export async function reresolveMirrorMembers(
  client: pg.PoolClient, system: string,
): Promise<{ assignee: number; surfaces: number }> {
  // 맵 소스 — person_identity(org_member 실재 조인) + org_member.email.
  const idn = await client.query(
    `SELECT pi.external_id, pi.email, pi.person_id AS member_id
       FROM person_identity pi JOIN org_member om ON om.id = pi.person_id
      WHERE pi.system=$1`, [system]);
  const mem = await client.query(`SELECT lower(email) AS email, id FROM org_member WHERE email <> ''`);
  const idnRows = idn.rows as Array<{ external_id: string; email: string | null; member_id: string }>;
  const memRows = mem.rows as Array<{ email: string; id: string }>;
  const resolve = buildMemberResolver(idnRows, memRows);

  // (raw-key → mid) 쌍 — key!=mid 만. 실제 존재 대조는 SQL 이 하니 맵 전체를 후보로(미존재는 0행).
  const pairMap = new Map<string, string>();
  for (const r of idnRows) {
    if (r.external_id && r.external_id !== r.member_id) pairMap.set(r.external_id, r.member_id);
    const ek = (r.email ?? "").trim().toLowerCase();
    if (ek && ek !== r.member_id && !pairMap.has(ek)) pairMap.set(ek, r.member_id);
  }
  for (const r of memRows) {
    const ek = (r.email ?? "").trim().toLowerCase();
    if (ek && ek !== r.id && !pairMap.has(ek)) pairMap.set(ek, r.id);
  }
  const pairs = [...pairMap.entries()]; // Array<[raw, mid]>

  let assignee = 0, surfaces = 0;
  await client.query("BEGIN"); // 다중 문 원자성 — 부분 적용/split-brain 방지(실패 시 전체 롤백, 다음 호출 재시도).
  try {
    if (pairs.length) {
      const flat: string[] = pairs.flat();
      // (VALUES ($1::text,$2::text),($3,$4),...) — 첫 튜플에 text 캐스팅으로 컬럼 타입 확정.
      const vlist = pairs.map((_, i) => (i === 0 ? `($1::text,$2::text)` : `($${i * 2 + 1},$${i * 2 + 2})`)).join(",");

      // ── 단순 컬럼(유니크 없음) — 통째 UPDATE. raw(이메일/숫자)만 매칭 → 네이티브 슬러그 불가침. ──
      for (const tc of [["task_comment", "author"], ["task_checklist_item", "assignee"]] as const) {
        const r = await client.query(
          `UPDATE ${tc[0]} t SET ${tc[1]}=m.mid FROM (VALUES ${vlist}) AS m(raw,mid) WHERE t.${tc[1]}=m.raw`, flat);
        surfaces += r.rowCount ?? 0;
      }

      // ── PK 유니크 표면 — mid 행을 생성(ON CONFLICT skip: 기존 mid·배치 중복 둘 다 흡수)한 뒤 raw 행 삭제. ──
      //  단순 UPDATE 면, 한 스코프에 같은 사람이 두 raw 형태(숫자 id + 이메일)로 쌓여 있을 때(#541 표면 백필은 raw 만
      //  INSERT·삭제 안 함) 둘 다 같은 mid 로 바뀌며 유니크 위반이 난다. INSERT-then-DELETE 는 그 collapse 를 흡수한다.
      const pk = [
        { table: "task_assignee", col: "member_id", cols: "task_id, member_id, sort", sel: "t.task_id, m.mid, t.sort", conflict: "task_id, member_id" },
        { table: "project_member", col: "member_id", cols: "project_id, member_id, role, sort, status_message", sel: "t.project_id, m.mid, t.role, t.sort, t.status_message", conflict: "tenant_id, project_id, member_id" },
        { table: "task_comment_reaction", col: "member", cols: "comment_id, emoji, member", sel: "t.comment_id, t.emoji, m.mid", conflict: "comment_id, emoji, member" },
      ];
      for (const s of pk) {
        const ins = await client.query(
          `INSERT INTO ${s.table}(${s.cols}) SELECT ${s.sel}
             FROM ${s.table} t JOIN (VALUES ${vlist}) AS m(raw,mid) ON t.${s.col}=m.raw
           ON CONFLICT (${s.conflict}) DO NOTHING`, flat);
        surfaces += ins.rowCount ?? 0;
        await client.query(
          `DELETE FROM ${s.table} t USING (VALUES ${vlist}) AS m(raw,mid) WHERE t.${s.col}=m.raw`, flat);
      }

      // ── task_time_entry — external_id 유니크가 있어 INSERT 복제 불가 → UPDATE. 부분유니크(task_id,member)
      //  WHERE ended_at IS NULL(열린 타이머) 충돌만 선삭제(미러 타임엔트리는 대부분 종료라 열린 충돌은 희소). ──
      await client.query(
        `DELETE FROM task_time_entry t USING (VALUES ${vlist}) AS m(raw,mid)
          WHERE t.member=m.raw AND t.ended_at IS NULL
            AND EXISTS (SELECT 1 FROM task_time_entry t2 WHERE t2.task_id=t.task_id AND t2.member=m.mid AND t2.ended_at IS NULL)`, flat);
      const te = await client.query(
        `UPDATE task_time_entry t SET member=m.mid FROM (VALUES ${vlist}) AS m(raw,mid) WHERE t.member=m.raw`, flat);
      surfaces += te.rowCount ?? 0;
    }

    // ── project.assignee(JSON 배열 문자열) 재해소 + external_base.assignee 동기 + 어사이니 표면 백필(#541 흡수). ──
    //  external_base.assignee 는 mirrorProjectV6 가 JSON 배열 **문자열**(jsonb string)로 심으므로(미푸시 필드 base=theirs)
    //  같은 shape 로 갱신한다(안 맞추면 다음 싱크 merge3 가 base(raw)≠ours(치환) 로 raw 재기록). 표면 백필은 매핑
    //  유무와 무관하게 항상 — 재미러 창 밖 행의 project_member/task_assignee 표면을 materialize(매핑 저장 훅에서도
    //  즉시 완결되게: 재해소만으론 '표면에 아예 없던' 어사이니는 안 생긴다). 멱등(ON CONFLICT skip).
    const rows = await client.query(
      `SELECT id, level, assignee, external_base FROM project WHERE external_system=$1 AND assignee LIKE '[%'`, [system]);
    for (const row of rows.rows as Array<{ id: number; level: string; assignee: string; external_base: Record<string, unknown> | null }>) {
      let arr: string[];
      try { const a = JSON.parse(row.assignee); if (!Array.isArray(a)) continue; arr = a.filter(Boolean).map(String); }
      catch { continue; }
      const next = reresolveMemberList(arr, resolve);
      if (next) {
        const nextStr = JSON.stringify(next);
        const baseHasAssignee = row.external_base != null && Object.prototype.hasOwnProperty.call(row.external_base, "assignee");
        await client.query(
          `UPDATE project SET assignee=$2,
              external_base = CASE WHEN $3::boolean
                THEN jsonb_set(COALESCE(external_base,'{}'::jsonb), '{assignee}', to_jsonb($2::text)) ELSE external_base END
            WHERE id=$1`,
          [row.id, nextStr, baseHasAssignee]);
        assignee++;
      }
      const members = next ?? arr; // 재해소됐으면 치환값, 아니면 원본(이미 member_id 또는 미매핑 raw — 손실0)
      let sort = 100; // 사람 추가분(0~) 뒤에
      for (const m of members) {
        await client.query(
          `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
          [row.id, m, sort]);
        if (row.level === "project") {
          await client.query(
            `INSERT INTO project_member(project_id, member_id, role, sort) VALUES($1,$2,'member',$3) ON CONFLICT (tenant_id, project_id, member_id) DO NOTHING`,
            [row.id, m, sort]);
        }
        sort++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err; // 호출자(healPmMirror/delivery)가 best-effort 격리 — 다음 호출/싱크가 멱등 재시도.
  }
  return { assignee, surfaces };
}

// ── 힐 패스(#541) — 스트림 순서 밖(부모 미변경 증분 등)으로 미해소된 parent_id/list_id 를 raw/fields 백스톱으로 일괄 수렴. ──
//  run-sync 가 인제스트 후 1회 호출. 멱등 · 커넥터 행(external_system=$1)만.
//  opts.pruneEmptyContainers(허용목록 스코프에서만 true): 리스트가 하나도 없는 **커넥터 소유** 폴더/스페이스를
//  잎부터 제거 — 과거 무필터 이관이 남긴 빈 컨테이너 정리(네이티브 폴더·리스트 보유 컨테이너는 불가침).
export async function healPmMirror(
  client: pg.PoolClient, system: string, opts?: { pruneEmptyContainers?: boolean },
): Promise<{ parents: number; lists: number; statusKeys: number; prunedContainers: number; reresolvedAssignee: number; reresolvedSurfaces: number }> {
  const p = await client.query(
    `UPDATE project c SET parent_id = par.id
       FROM project par
      WHERE c.external_system=$1 AND c.parent_id IS NULL AND c.raw->>'parent' IS NOT NULL
        AND par.external_system=$1 AND par.external_instance=c.external_instance
        AND par.external_id = c.raw->>'parent' AND par.id <> c.id`,
    [system]);
  const l = await client.query(
    `UPDATE project c SET list_id = pl.id
       FROM project_list pl
      WHERE c.external_system=$1 AND c.list_id IS NULL AND c.level='project' AND c.fields->>'list_id' IS NOT NULL
        AND pl.external_system=$1 AND pl.external_instance=c.external_instance
        AND pl.external_id = c.fields->>'list_id'`,
    [system]);
  // 레거시 status_raw 라벨→키 일괄 정규화(#541 업그레이드) — 구버전 미러가 심은 원문 라벨("to do")을 소속 리스트
  //  settings.statuses 의 label 매치로 key("to-do")로 수렴. 재미러(증분 창) 밖의 옛 행도 UI 커스텀 상태 그룹에 즉시 합류.
  //  task/subtask 행은 list_id 가 없으므로 부모 체인(≤2단: subtask→task→project)으로 루트의 리스트를 해소.
  const s = await client.query(
    `UPDATE project c SET status_raw = st->>'key'
       FROM project_list pl, jsonb_array_elements(COALESCE(pl.settings->'statuses','[]'::jsonb)) st
      WHERE c.external_system=$1
        AND pl.id = COALESCE(c.list_id,
              (SELECT COALESCE(p1.list_id, p2.list_id)
                 FROM project p1 LEFT JOIN project p2 ON p2.id = p1.parent_id
                WHERE p1.id = c.parent_id))
        AND c.status_raw IS NOT NULL AND st->>'label' = c.status_raw AND st->>'key' <> c.status_raw`,
    [system]);
  // 멤버 재해소 + 어사이니 표면 백필(#697/#541) — raw(이메일/숫자)로 굳은 어사이니/작성자/멤버를 현재 매핑으로 소급
  //  치환하고, project.assignee 를 표시 표면(project_member/task_assignee)에 materialize 한다(재미러 창 밖 행 포함,
  //  멱등). 매핑 저장 훅(delivery)과 공유하는 동일 함수 — 자체 트랜잭션(원자적).
  const rr = await reresolveMirrorMembers(client, system);

  // 빈 커넥터 컨테이너 정리 — 잎(하위 폴더·리스트 없음)부터 반복 삭제(≤5회 — 실제 깊이 2). project_view 는 FK CASCADE.
  let pruned = 0;
  if (opts?.pruneEmptyContainers) {
    for (let i = 0; i < 5; i++) {
      const d = await client.query(
        `DELETE FROM project_folder f
          WHERE f.external_system=$1 AND f.external_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM project_list pl WHERE pl.folder_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM project_folder c WHERE c.parent_id = f.id)`,
        [system]);
      pruned += d.rowCount ?? 0;
      if (!d.rowCount) break;
    }
  }
  return { parents: p.rowCount ?? 0, lists: l.rowCount ?? 0, statusKeys: s.rowCount ?? 0, prunedContainers: pruned,
           reresolvedAssignee: rr.assignee, reresolvedSurfaces: rr.surfaces };
}

// ── 단일 RawItem → v6 적재(라우팅). ingestItems 의 client 공유 — item 단위 BEGIN/COMMIT(다중 테이블 원자성). ──
//  라우팅: routeIngestV6(type, system) → project|knowledge|source|pm_* | null(미정의=skip).
//  external_id 부재(이론상 불가)면 멱등키가 없어 skip. 적재 시 true, skip 시 false.
export async function mirrorExternalToV6(client: pg.PoolClient, it: RawItem): Promise<boolean> {
  const system = it.provenance.system;
  const externalId = it.provenance.external_id;
  if (!externalId) return false;
  // 수집기 산출 정책(#1419 T3) — 이 프로세스가 대리하는 수집기의 설정이 기본 라우팅을 덮는다.
  //  바인딩이 없으면(레거시 경로·수동 실행) 'preset' = 종전 동작 그대로.
  const outputMode = boundCollector()?.outputMode ?? "preset";
  const target = routeIngestV6(it.type, system, outputMode);
  if (target == null) return false; // 라우팅 정의 밖 — 미러 skip(보수적, 임의 분류 금지).

  await client.query("BEGIN");
  try {
    let ok = false;
    if (target === "project") ok = await mirrorProjectV6(client, it, system, externalId);
    // domain-wiki(#696): 파일 슬러그=name 자연식별 → name-키 upsert(기존 NULL-external 행 채택). 그 외 K류는 external-좌표.
    else if (target === "knowledge" && system === "domain-wiki") ok = await mirrorKnowledgeByNameV6(client, it, system, externalId);
    else if (target === "knowledge") ok = await mirrorKnowledgeV6(client, it, system, externalId);
    else if (target === "source") {
      ok = await mirrorSourceV6(client, it, system, externalId);
      // 'both' — 원문을 자료로 남기면서 지식도 만든다(출처 추적 + 즉시 검색). 같은 트랜잭션 안이라
      //  둘 중 하나만 적재되는 반쪽 상태가 생기지 않는다. 지식 쪽 실패는 항목 전체를 롤백시킨다.
      if (alsoMirrorKnowledge(it.type, system, outputMode)) {
        const kOk = system === "domain-wiki"
          ? await mirrorKnowledgeByNameV6(client, it, system, externalId)
          : await mirrorKnowledgeV6(client, it, system, externalId);
        ok = ok || kOk;
      }
    }
    else if (target === "pm_folder") ok = await mirrorPmFolderV6(client, it, system, externalId);
    else if (target === "pm_list") ok = await mirrorPmListV6(client, it, system, externalId);
    else if (target === "pm_view") ok = await mirrorPmViewV6(client, it, system, externalId);
    else if (target === "pm_comment") ok = await mirrorPmCommentV6(client, it, system, externalId);
    else if (target === "pm_time") ok = await mirrorPmTimeV6(client, it, system, externalId);
    await client.query("COMMIT");
    return ok;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err; // ingestItems 가 warn 격리 — 다음 싱크 멱등 수렴
  }
}
