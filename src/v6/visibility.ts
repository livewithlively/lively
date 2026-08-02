// 맥락 가시성(#1291) — 열람 가시성(read) 술어의 단일 SoT.
//
//  가시성은 **사람과 그 사람의 AI 에 동시에** 적용되는 접근권한이다. 웹 API 와 MCP 가 같은 capability 핸들러를
//  공유하므로(capabilities/index.ts · web.ts), 술어를 store 계층에 두면 두 표면이 자동으로 같은 답을 낸다.
//
//  ## 어휘
//  'open'   = 전원 열람(기본값 — 기존 동작).
//  'members'= 지정 대상(멤버 grant + 팀 grant)만. grant 가 비면 admin 만 본다(빈 audience = fail-closed).
//
//  ## 상속 = 단조 축소(AND)
//  리스트의 유효 대상 = 리스트 자신의 설정 ∩ 소속 스페이스(최상위 폴더)의 설정. 하위는 좁힐 수만 있고 넓힐 수 없다.
//  → "리스트만 비공개면 스페이스·폴더가 껍데기로 전체에 보인다"는 문제를 상위 축으로 해소한다.
//
//  ## 왜 '가시 리스트 id 집합'을 먼저 뽑는가 (성능)
//  행마다 재귀 함수를 부르면 보드 1회 로드에 함수콜이 수천 번 나간다(프로젝트 수백 행 × 목록/검색 여러 벌).
//  리스트는 조직 전체에서 수십 개 규모라, **뷰어의 가시 리스트 집합을 한 번 계산**해 다행(多行) 쿼리에는
//  세미조인으로 붙이는 편이 압도적으로 싸다. 캐시하지 않는다 — grant 회수가 즉시 반영돼야 하고(요청당 1쿼리),
//  이 쿼리 자체가 수십 행 스캔이라 저렴하다.
import { itemsPool } from "../db/client.js";
import { axisOn } from "./visibility-axes.js";
import { q } from "../db/client.js";

// viewer 규약: 문자열=그 멤버로 판정 / null=특권(내부 시스템 경로·긴급열람, 필터 없음).
//  ⚠ undefined 를 특권으로 쓰지 않는다 — '깜빡하고 안 넘김'과 '의도적 특권'이 구분돼야 한다(호출부에서 명시).
//  ⚠ **admin 은 특권이 아니다**(v2 에서 뒤집음) — 아래 '긴급 열람' 참고.
export type Viewer = string | null;

/**
 * '아무에게도 지정되지 않은 사람' — 조직 전체에 나가는 산출물(정적 context.md·발행 번들·멤버 무관 미리보기)의 뷰어.
 *  그런 산출물은 누구의 것도 아니므로 **공개(open)로 표시된 맥락만** 담아야 한다. null(특권)을 쓰면 잠긴 지식이
 *  전원 배포물에 실리고, 실멤버 id 를 쓰면 그 사람의 사적 맥락이 남의 파일에 섞인다.
 *  값이 빈 문자열인 건 의도다: viewerOf()(capabilities/principal.ts)가 빈 userId 를 null 로 접기 때문에 **실제 요청은
 *  절대 이 뷰어가 될 수 없다** → grant 테이블에 이 값이 들어 있을 수도 없다(= 어떤 대상 지정에도 안 걸린다).
 */
export const PUBLIC_VIEWER: Viewer = "";


// ── 긴급 열람(break-glass) ────────────────────────────────────────────────
//  admin 이 그냥 우회하면, admin 신원을 물려받는 **AI 자동화**(분류기·증류기·상시 세션·크론)가 잠긴 내용을 읽어
//  공개 지식으로 되뱉을 수 있다. 사람 한 명이 보는 것보다 이쪽이 위험해서, admin 도 평소엔 같은 술어를 탄다.
//  대신 사유를 적고 여는 문을 둔다 — 열람을 막는 게 아니라 **흔적 없는 열람**을 막는 것이다.
const BG_TTL_MS = 5_000;   // 요청마다 도는 판정이라 짧게 캐시(연 직후 반영은 5초 내).
const bgCache = new Map<string, { until: number; scopes: Array<{ kind: string | null; id: string | null }> }>();

/** 이 멤버에게 지금 열려 있는 긴급열람 스코프(없으면 빈 배열). */
export async function activeBreakGlass(member: string): Promise<Array<{ kind: string | null; id: string | null }>> {
  const now = Date.now();
  const hit = bgCache.get(member);
  if (hit && hit.until > now) return hit.scopes;
  let scopes: Array<{ kind: string | null; id: string | null }> = [];
  try {
    const rows = await q(itemsPool, `
      SELECT scope_kind, scope_id FROM vis_break_glass
       WHERE member_id=$1 AND ended_at IS NULL AND expires_at > now()`, [member]);
    scopes = rows.map((r) => ({ kind: (r.scope_kind as string | null) ?? null, id: (r.scope_id as string | null) ?? null }));
  } catch { scopes = []; }   // 테이블 부재(구 스키마)·DB 흔들림 = 열지 않는다(닫는 쪽)
  bgCache.set(member, { until: now + BG_TTL_MS, scopes });
  return scopes;
}

/** 긴급열람을 시작·종료했으면 캐시를 버린다(즉시 반영). */
export function invalidateBreakGlass(): void { bgCache.clear(); }

/**
 * 이 요청의 **유효 뷰어** — 전체 스코프 긴급열람이 열려 있으면 특권(null)으로 승격한다.
 * 스코프가 지정된 긴급열람(특정 리스트만)은 여기서 승격하지 않고 개별 판정에서 본다.
 */
export async function effectiveViewer(viewer: Viewer): Promise<Viewer> {
  if (viewer === null) return null;
  const scopes = await activeBreakGlass(viewer);
  return scopes.some((s) => !s.kind) ? null : viewer;
}

// 폴더 체인은 재귀로 오른다 — 스페이스▸폴더▸리스트가 흔한 모양이기 때문이다(ClickUp 미러가 그렇게 만든다).
//  직속 부모만 보면 "스페이스를 잠갔는데 그 안 폴더의 리스트는 전원에게 열려 있는" 구멍이 생긴다.
//  깊이 상한은 안전장치다: 폴더 이동은 앱 레벨에서만 순환을 막으므로(동시 이동이 겹치면 DB 에 순환이 남을 수 있다)
//  상한이 없으면 그 한 건이 커넥션을 차례로 삼켜 게이트웨이 전체를 멈춘다.
const MAX_FOLDER_DEPTH = 32;

// grant 판정 = 멤버 직접 지정 OR 팀 경유(team_member 라이브 조인 — 팀원 변경이 즉시 반영된다).
const LIST_GRANT_SQL = `(
  EXISTS(SELECT 1 FROM project_list_member plm WHERE plm.list_id = pl.id AND plm.member_id = $1)
  OR EXISTS(SELECT 1 FROM project_list_team plt JOIN team_member tm ON tm.team_id = plt.team_id
             WHERE plt.list_id = pl.id AND tm.member_id = $1))`;
const FOLDER_GRANT_SQL = `(
  EXISTS(SELECT 1 FROM project_folder_member pfm
          WHERE pfm.folder_id = pf.id AND pfm.subject_kind = 'member' AND pfm.member_id = $1)
  OR EXISTS(SELECT 1 FROM project_folder_member pfm JOIN team_member tm ON tm.team_id::text = pfm.member_id
             WHERE pfm.folder_id = pf.id AND pfm.subject_kind = 'team' AND tm.member_id = $1))`;

// 이 뷰어에게 '닫힌' 폴더 — members 인데 대상이 아닌 것. 하위(리스트·폴더)는 여기 걸리면 전부 가려진다.
const BLOCKED_FOLDERS_CTE = `WITH RECURSIVE blocked AS (
      SELECT pf.id FROM project_folder pf
       WHERE pf.visibility = 'members' AND NOT ${FOLDER_GRANT_SQL}
    )`;

/** 이 뷰어에게 보이는 리스트 id 집합. 특권(null)이면 null 을 돌려준다(= 필터 없음). */
export async function visibleListIds(viewer: Viewer): Promise<Set<number> | null> {
  if (viewer === null) return null;
  // 축이 꺼져 있으면 필터 자체를 걷는다(#1291) — null = 특권 = 전부 보임 = 종전 동작.
  //  여기 한 곳이 프로젝트·태스크·파일·세션·타임라인·db self 까지 전부를 덮는다(그 전부가 이 집합에서 파생된다).
  if (!(await axisOn("project"))) return null;
  // 긴급열람 — 전체 스코프면 필터 자체를 걷고, 특정 리스트 스코프면 그 리스트만 더한다.
  const bg = await activeBreakGlass(viewer);
  if (bg.some((b) => !b.kind)) return null;
  const bgListIds = bg.filter((b) => b.kind === "project_list" && b.id).map((b) => Number(b.id));
  const rows = await q(itemsPool, `
    ${BLOCKED_FOLDERS_CTE},
    chain AS (
      -- 리스트 → 조상 폴더 체인. 시작은 직속 폴더, 재귀로 위로 오른다.
      SELECT pl.id AS list_id, pl.folder_id AS folder_id, 1 AS depth
        FROM project_list pl WHERE pl.folder_id IS NOT NULL
      UNION ALL
      SELECT c.list_id, pf.parent_id, c.depth + 1
        FROM chain c JOIN project_folder pf ON pf.id = c.folder_id
       WHERE pf.parent_id IS NOT NULL AND c.depth < ${MAX_FOLDER_DEPTH}
    )
    SELECT pl.id
      FROM project_list pl
     WHERE (pl.visibility IS DISTINCT FROM 'members' OR ${LIST_GRANT_SQL})
       AND NOT EXISTS(SELECT 1 FROM chain c WHERE c.list_id = pl.id AND c.folder_id IN (SELECT id FROM blocked))`,
    [viewer]);
  const ids = new Set(rows.map((r) => Number(r.id)));
  for (const id of bgListIds) if (Number.isFinite(id)) ids.add(id);   // 스코프 긴급열람으로 연 리스트
  return ids;
}

/** 이 뷰어에게 보이는 폴더 id 집합(자기 자신 또는 조상이 닫혀 있으면 제외). 특권이면 null. */
export async function visibleFolderIds(viewer: Viewer): Promise<Set<number> | null> {
  if (viewer === null) return null;
  if (!(await axisOn("project"))) return null;
  const rows = await q(itemsPool, `
    ${BLOCKED_FOLDERS_CTE},
    chain AS (
      -- 폴더 → 자기 자신 + 조상 체인(자기가 닫혀도, 위가 닫혀도 안 보인다).
      SELECT f.id AS folder_id, f.id AS anc_id, 1 AS depth FROM project_folder f
      UNION ALL
      SELECT c.folder_id, pf.parent_id, c.depth + 1
        FROM chain c JOIN project_folder pf ON pf.id = c.anc_id
       WHERE pf.parent_id IS NOT NULL AND c.depth < ${MAX_FOLDER_DEPTH}
    )
    SELECT f.id FROM project_folder f
     WHERE NOT EXISTS(SELECT 1 FROM chain c WHERE c.folder_id = f.id AND c.anc_id IN (SELECT id FROM blocked))`,
    [viewer]);
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * 다행 쿼리에 붙일 SQL 술어. `列`(list_id 를 가리키는 SQL 식)이 가시 집합에 들거나 NULL(미분류=전원)이면 통과.
 * 특권이면 "TRUE" 를 돌려주므로 호출부는 분기 없이 그대로 이어붙이면 된다.
 */
export function listIdPredicate(col: string, ids: Set<number> | null): string {
  if (ids === null) return "TRUE";
  if (ids.size === 0) return `${col} IS NULL`;
  return `(${col} IS NULL OR ${col} IN (${[...ids].join(",")}))`;
}

/**
 * 프로젝트 행(project 테이블) 1건이 이 뷰어에게 보이나.
 *  ⚠ task/subtask 행은 자기 list_id 를 쓰지 않는다(createTask 가 그 컬럼을 채우지 않아 사실상 항상 NULL).
 *   그래서 "list_id NULL = 전원 열람" 규칙을 태스크에 그대로 적용하면 잠긴 프로젝트의 태스크가 전부 새어나간다.
 *   태스크는 부모(→ subtask 면 조부모)를 타고 올라가 **프로젝트 행의 list_id** 로 판정한다.
 */
export async function canSeeProjectRow(id: number, viewer: Viewer): Promise<boolean> {
  if (viewer === null) return true;
  const listId = await projectRowListId(id);
  if (listId === undefined) return true;   // 그런 행이 없다 — 존재 판정은 호출부(404)의 몫
  if (listId === null) return true;        // 미분류 프로젝트 = 전원
  const ids = await visibleListIds(viewer);
  return ids === null || ids.has(listId);
}

/** 프로젝트/태스크/서브태스크 행이 속한 **프로젝트의** list_id. 행이 없으면 undefined. */
export async function projectRowListId(id: number): Promise<number | null | undefined> {
  const rows = await q(itemsPool, `
    SELECT COALESCE(pr.list_id, p.list_id) AS list_id
      FROM project p
      LEFT JOIN project par ON par.id = p.parent_id
      LEFT JOIN project pr ON pr.id = CASE WHEN p.level = 'subtask' THEN par.parent_id
                                           WHEN p.level = 'task'    THEN par.id
                                           ELSE p.id END
     WHERE p.id = $1`, [id]);
  if (!rows.length) return undefined;
  const v = rows[0].list_id;
  return v == null ? null : Number(v);
}

// ── 세션 목록용 — '이 사람에게 안 보이는 프로젝트' 집합 ────────────────────────────────
//  세션 목록은 5초마다 폴링되고 한 번에 수십 건을 판정한다. 세션마다 DB 를 때리는 대신 **가려진 프로젝트 id 집합**을
//  한 번 뽑아 메모리에서 대조한다. 아무도 잠그지 않은 조직에선 이 집합이 **빈 셋**이라 사실상 비용이 0이다.
const HIDDEN_TTL_MS = 15_000;      // 폴링 주기(5초)의 3배 — 회수 반영 지연 상한
const HIDDEN_GRACE_MS = 300_000;   // DB 가 흔들릴 때 마지막 성공값을 재사용할 수 있는 한도
const hiddenCache = new Map<string, { v: HiddenProjects; at: number; ok: number }>();
/** 가려진 프로젝트 — id 와 폴더 경로 두 축. 세션은 둘 중 하나로만 자기 프로젝트를 알 수 있어 둘 다 필요하다. */
export interface HiddenProjects { ids: Set<number>; folders: Set<string> }
const EMPTY_HIDDEN: HiddenProjects = { ids: new Set(), folders: new Set() };

/**
 * 이 뷰어에게 **보이지 않는** 프로젝트(특권이면 빈 셋).
 *  폴더 축도 함께 주는 이유: 세션은 `@box_project`(정수 id)로 프로젝트를 알지만, 그 옵션이 없는 옛 세션은
 *  작업 디렉터리(`project/<id>` 또는 옛 규칙의 `project/<이름>`)뿐이다. 한 번의 조회로 두 축을 다 덮는다.
 * 실패 시: 최근(5분 내) 성공값이 있으면 그걸 쓰고, 그마저 없으면 throw 한다 — 호출부는 그때 프로젝트 세션을
 * 통째로 감춘다(fail-closed). "판정을 못 하겠으니 일단 보여주자"는 잠금을 무력화하는 방향이라 택하지 않는다.
 */
export async function hiddenProjects(viewer: Viewer): Promise<HiddenProjects> {
  if (viewer === null) return EMPTY_HIDDEN;
  const now = Date.now();
  const hit = hiddenCache.get(viewer);
  if (hit && now - hit.at < HIDDEN_TTL_MS) return hit.v;
  try {
    // v2: admin 이라고 건너뛰지 않는다 — 세션 화면엔 그 프로젝트의 대화·파일이 그대로 흐르고,
    //  admin 신원을 물려받은 AI 세션이 그걸 읽어 공개 지식으로 되뱉을 수 있다. 긴급열람은 visibleListIds 가 반영한다.
    const visIds = await visibleListIds(viewer);
    const rows = await q(itemsPool, `
      SELECT id, folder FROM project
       WHERE level='project' AND list_id IS NOT NULL
         AND NOT (${listIdPredicate("list_id", visIds)})`, []);
    const v: HiddenProjects = {
      ids: new Set(rows.map((r) => Number(r.id))),
      folders: new Set(rows.map((r) => String(r.folder ?? "")).filter(Boolean)),
    };
    hiddenCache.set(viewer, { v, at: now, ok: now });
    return v;
  } catch (e) {
    if (hit && now - hit.ok < HIDDEN_GRACE_MS) {
      hiddenCache.set(viewer, { ...hit, at: now });   // 유예 재사용(연속 실패에도 매번 재시도하지 않게)
      return hit.v;
    }
    throw e;
  }
}

/** grant·공개범위가 바뀌면 즉시 반영되도록 캐시를 버린다(설정 변경 경로에서 호출). */
export function invalidateVisibilityCache(): void { hiddenCache.clear(); }

/** 지식 1건이 이 뷰어에게 보이나 — 직접 grant 또는 컨테이너(리스트) 참조 grant. */
export async function canSeeKnowledge(name: string, viewer: Viewer): Promise<boolean> {
  // 긴급 열람을 여기서도 본다 — 목록·검색(knowledgeVisWhere)은 이미 반영하는데 단건 조회만 빼면
  //  "검색엔 제목이 뜨는데 열면 404" 가 된다(#1291 v2).
  const eff = await effectiveViewer(viewer);
  if (eff === null) return true;
  viewer = eff;
  const rows = await q(itemsPool,
    `SELECT visibility FROM knowledge WHERE name = $1`, [name]);
  if (!rows.length) return true;                       // 없는 문서 — 존재 판정은 호출부
  if (rows[0].visibility !== "members") return true;
  const direct = await q(itemsPool, `
    SELECT 1 FROM knowledge_member km
     WHERE km.name = $1 AND ((km.subject_kind = 'member' AND km.member_id = $2)
       OR (km.subject_kind = 'team' AND EXISTS(SELECT 1 FROM team_member tm
             WHERE tm.team_id::text = km.member_id AND tm.member_id = $2)))
     LIMIT 1`, [name, viewer]);
  if (direct.length) return true;
  const viaList = await q(itemsPool,
    `SELECT list_id FROM knowledge_list_grant WHERE name = $1`, [name]);
  if (!viaList.length) return false;
  const ids = await visibleListIds(viewer);
  return ids === null || viaList.some((r) => ids.has(Number(r.list_id)));
}
