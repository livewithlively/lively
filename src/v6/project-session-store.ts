// v6 프로젝트 ↔ 세션·폴더 바인딩(#1313 R21 — project-store 에서 분리).
//  담는 것: "이 세션이 어느 프로젝트에서 돌았나"(session_project) · "이 프로젝트가 어느 환경의 어느 경로에 사나"
//  (project_folder_binding) · 그 둘에 붙는 멤버십/경로 기반 접근 판정.
//  왜 떼냐: 터미널·세션로그 척추가 이 다섯 함수 때문에 PM 스토어(프로젝트 CRUD·보드·검색·추천) 전체를 끌어왔다.
//   여기는 db/client 와 project-origin 만 의존하는 얇은 잎이라, 세션 경로는 이 모듈만 import 하면 된다.
//  ⚠ 방향: project-store → 이 모듈(재수출). 되import 금지(순환 — check-imports 가 잡는다).
//  기존 호출부 호환: project-store.ts 가 아래 심볼을 전부 재수출한다.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";
import { originKey } from "../project/project-origin.js";

// 팀원 게이트(상세/파일/세션/타임라인 접근) — 생성자이거나 project_member 인 사람만.
//  org/store.isProjectMember 와 동형이나 org_project 가 아닌 v6 project(level='project') 기준.
export async function isProjectMember(projectId: number, memberId: string): Promise<boolean> {
  if (!memberId) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM project p
      WHERE p.id=$1 AND p.level='project' AND (p.created_by=$2 OR EXISTS(
        SELECT 1 FROM project_member pm WHERE pm.project_id=p.id AND pm.member_id=$2)) LIMIT 1`,
    [projectId, memberId]);
  return (r.rowCount ?? 0) > 0;
}

// 세션이력 웹뷰 열람권한(#905 C1, view_policy="attach") — 이 세션이 **한 번이라도** 바인딩됐던 프로젝트 중
//  memberId 가 생성자/멤버인 곳이 있나(시간구간 전체 조회). DB 기반이라 **끝난 세션(tmux 없음)도** 판정된다
//  (canAttach 는 살아있는 tmux 기준이라 죽은 세션엔 못 씀 — 웹뷰는 DB 기반이어야 한다, 설계 §5).
export async function sessionBoundToMemberProject(sessionId: string, memberId: string): Promise<boolean> {
  if (!sessionId || !memberId) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM session_project sp
       JOIN project p ON p.id = sp.project_id AND p.level='project'
      WHERE sp.session_id = $1
        AND (p.created_by = $2 OR EXISTS(
          SELECT 1 FROM project_member pm WHERE pm.project_id = p.id AND pm.member_id = $2))
      LIMIT 1`,
    [sessionId, memberId]);
  return (r.rowCount ?? 0) > 0;
}

// 세션↔프로젝트 영속 기록 — 프로젝트 터미널 세션 생성/재바인딩 시 호출. 끝난 세션의 AI 작업도 이 프로젝트로 귀속.
//  시간구간 모델(#905 C1): 마지막 구간의 프로젝트와 **다를 때만** 새 구간(valid_from=now())을 덧붙인다.
//   - 같은 프로젝트 반복 바인딩(세션 시작마다 호출됨)은 새 구간을 안 만든다 → 구간 폭증 방지.
//   - 재바인딩이면 새 구간이 생기고, 과거 작업은 옛 구간(옛 프로젝트)에 그대로 남는다(소급 재귀속 버그 차단).
//   - 같은 시각 동시삽입 충돌은 DO NOTHING(멱등). 재바인딩 자체가 드물어 경쟁은 사실상 없다.
export async function recordSessionProject(sessionId: string, projectId: number | null, bindingEpoch?: number): Promise<void> {
  if (!sessionId) return;
  await itemsPool.query(
    `INSERT INTO session_project(session_id, project_id, binding_epoch)
     SELECT $1::text, $2::int, COALESCE($3::bigint,
       (SELECT COALESCE(MAX(sp2.binding_epoch),0)+1 FROM session_project sp2 WHERE sp2.session_id=$1))
      WHERE (SELECT sp.project_id FROM session_project sp
              WHERE sp.session_id = $1 ORDER BY sp.valid_from DESC LIMIT 1) IS DISTINCT FROM $2::int
     ON CONFLICT (tenant_id, session_id, valid_from) DO NOTHING`,
    [sessionId, projectId, bindingEpoch ?? null]);
}

// 이어받기(#905 C1) — 이 세션의 **가장 최근 바인딩** 프로젝트 id(+박스 폴더). 없으면 null. 세션이 어느 프로젝트에서
//  돌았는지로 이어받기 세션의 작업 경로·멤버십 게이트를 정한다.
/**
 * 이어받기 승계(#1867) — **실행 세션 id 로 먼저, 없으면 그 세션이 이어받은 대화 uuid 로** 마지막 소속을 찾는다.
 *
 *  왜 두 축인가: 대화(conversation)와 실행 세션(execution)은 다른 엔티티다. 같은 대화를 새 세션에서 이어받으면
 *   실행 id 는 **새로 발급**되므로 그 id 로는 아무 소속도 없다 — 그러면 첫 프롬프트에서 훅이 '미연결'로 보고
 *   **새 프로젝트를 만든다**(2026-08-25 실측: 대화 `1bf015ec…`가 #1867 에 붙어 있었는데, 그 대화를 이어받은
 *   `box-yoon-6178a7c3` 이 새 프로젝트 #2015 를 만들었다 — 상민님이 "왜 직전 프롬프트가 프로젝트명이지?"로 발견).
 *  대화 uuid 축에도 소속이 남는 이유: session_log append 가 실행 세션의 현재 소속을 대화 id 로 투영한다.
 *
 *  ⚠ 순서가 의미다 — 실행 id 가 이겨야 한다. 세션을 옮긴 뒤(detach·재바인딩)의 정답은 그 실행 세션의 것이고,
 *   대화 축은 그보다 낡을 수 있다.
 */
export async function latestProjectForSessionChain(
  ids: Array<string | null | undefined>,
  lookup: (id: string) => Promise<{ id: number; folder: string } | null> = latestProjectForSession,
): Promise<{ id: number; folder: string } | null> {
  for (const id of ids) {
    const key = String(id ?? "").trim();
    if (!key) continue;                       // 빈 축은 조회하지 않는다(대화 uuid 가 없는 세션이 정상이다)
    const one = await lookup(key);
    if (one) return one;
  }
  return null;
}

export async function latestProjectForSession(sessionId: string): Promise<{ id: number; folder: string } | null> {
  if (!sessionId) return null;
  // ⚠ `p.trashed_at IS NULL` — **지워진 프로젝트는 승계하지 않는다**(#1867, 2026-08-26 실측으로 추가).
  //  껍데기를 휴지통에 넣는 것이 정상 정리 절차인데(태스크 #2051), 그 상태로 대화를 이어받으면
  //  이 조회가 지워진 프로젝트를 돌려줘 세션이 **휴지통에 있는 프로젝트에 붙는다**(보드엔 안 보이는데
  //  맥락은 거기서 주입된다). 그때는 소속이 없는 것으로 보고, 훅이 새 껍데기를 만들게 두는 편이 맞다.
  //  ⚠ '한 칸 더 옛날 바인딩'으로 되살리지 않는다 — 마지막 구간만 본다. 사람이 지운 프로젝트를 우회해
  //   그 이전 소속을 부활시키면, 옮긴 뒤 지운 경우에 **의도와 정반대**가 된다(detach 가 NULL 로 남는 것과 같은 이유).
  const r = await itemsPool.query(
    `SELECT p.id, COALESCE(p.folder,'') AS folder
       FROM (SELECT project_id FROM session_project
              WHERE session_id=$1 ORDER BY valid_from DESC LIMIT 1) sp
       JOIN project p ON p.id = sp.project_id AND p.trashed_at IS NULL`,
    [sessionId]);
  const row = r.rows[0] as { id: number; folder: string } | undefined;
  return row ? { id: Number(row.id), folder: String(row.folder || "") } : null;
}

// ── 폴더 바인딩(#905 P1-①) — "이 프로젝트가 어느 멤버의 어느 환경에서 어느 절대경로에 사는가"(N:M). ──
//  project.folder(1:1, 박스 정본)로는 표현 불가한 나머지(멤버 노트북·워커노드·사용자 자기 폴더)를 담는다.
//  ⚠ project_folder(클릭업 Folder)와 무관 — 스키마 주석(v6/schema.ts 6a-2) 참조.
export const SHARED_BINDING_MEMBER = ""; // member_id '' = 환경 공유(멤버 무관 — 박스/워커노드 폴더)
export type FolderSyncMode = "none" | "pull" | "both";

export interface ProjectFolderBinding {
  project_id: number;
  member_id: string;
  node_id: string;
  abs_path: string;
  sync: FolderSyncMode;
  origin_key: string | null;
  binding_kind: "canonical" | "ephemeral";
  created_at: string;
  seen_at: string;
}

// 바인딩 등록/갱신(멱등) — 같은 (프로젝트,멤버,환경,경로)면 sync/origin_key 갱신 + seen_at 터치.
//  seen_at 은 '마지막으로 이 경로가 살아있다고 보고된 시각' — 죽은 바인딩(지운 폴더)을 나중에 가려내는 신호.
export async function upsertProjectFolderBinding(b: {
  projectId: number; memberId?: string | null; nodeId: string; absPath: string;
  sync?: FolderSyncMode; originKey?: string | null; bindingKind?: "canonical" | "ephemeral";
}): Promise<void> {
  if (!b.projectId || !b.nodeId || !b.absPath) return;
  const kind = b.bindingKind ?? "canonical";
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    // 서로 다른 경로를 동시에 canonical로 올려도 demote→upsert가 교차하지 않게 프로젝트 행으로 직렬화한다.
    // 이 락이 없으면 두 트랜잭션이 모두 "기존 canonical 없음"을 본 뒤 유니크 인덱스에서 한쪽이 실패한다.
    await client.query("SELECT id FROM project WHERE id=$1 FOR UPDATE", [b.projectId]);
    if (kind === "canonical") {
      await client.query(
        `UPDATE project_folder_binding SET binding_kind='ephemeral'
          WHERE project_id=$1 AND node_id=$2 AND binding_kind='canonical'
            AND NOT (member_id=$3 AND abs_path=$4)`,
        [b.projectId, b.nodeId, b.memberId ?? SHARED_BINDING_MEMBER, b.absPath]);
    }
    await client.query(
      `INSERT INTO project_folder_binding(project_id, member_id, node_id, abs_path, sync, origin_key, binding_kind)
         VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, member_id, node_id, abs_path) DO UPDATE   -- PK 는 project_id(대리키 FK) 포함이라 tenant_id 로 재작성되지 않는다(tenant-column.isNaturalKey ⓑ) — 중재자에 tenant_id 를 넣으면 42P10
         SET sync=EXCLUDED.sync, origin_key=COALESCE(EXCLUDED.origin_key, project_folder_binding.origin_key),
             binding_kind=EXCLUDED.binding_kind, seen_at=now()`,
      [b.projectId, b.memberId ?? SHARED_BINDING_MEMBER, b.nodeId, b.absPath, b.sync ?? "none", b.originKey ?? null, kind]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function listProjectFolderBindings(projectId: number): Promise<ProjectFolderBinding[]> {
  return await q(itemsPool,
    `SELECT project_id, member_id, node_id, abs_path, sync, origin_key, binding_kind, created_at, seen_at
       FROM project_folder_binding WHERE project_id=$1 ORDER BY node_id, member_id, abs_path`, [projectId]);
}

export async function removeProjectFolderBinding(
  projectId: number, memberId: string | null, nodeId: string, absPath: string,
): Promise<boolean> {
  const r = await itemsPool.query(
    `DELETE FROM project_folder_binding WHERE project_id=$1 AND member_id=$2 AND node_id=$3 AND abs_path=$4`,
    [projectId, memberId ?? SHARED_BINDING_MEMBER, nodeId, absPath]);
  return (r.rowCount ?? 0) > 0;
}

// ── 크로스멤버 신원 해석(#905 P1-③) — git origin 키 → 이 origin 을 쓰는 기존 프로젝트 후보. ──
//  왜: 마커는 설계상 동기화되지 않으므로(project-manifest 가 '.' 시작 전량 제외) **두 번째 멤버에겐 마커 탐색이
//   원리적 100% 미스**다. 거기서 create 로 폴백하면 '중복 생성이 기본 동작'이 된다. origin URL 만이 멤버 간
//   동일한 유일 값이라 그걸 키로 기존 프로젝트를 찾는다.
//  두 채널을 합집합으로 본다(회수 최대화 — 놓치면 중복이 생기니까):
//   ① 레포 레지스트리 — repo.git_url ≈ origin → repo.name → project_repo. 아무도 바인딩한 적 없어도 찾힌다(주채널).
//   ② 기존 바인딩 — 다른 멤버가 이미 init 한 origin_key. 레지스트리에 없는 레포(미등록)도 찾힌다(보조채널).
//  정규화는 SQL 로 못 하므로(스킴·자격·포트·.git 규칙) JS 에서 originKey 로 비교한다 — repo 행 수는 조직당
//  수십 규모라 전량 로드가 싸다. **판정은 하지 않는다** — 후보만 돌려주고 최종 선택(중복·애매 시 사람에게 묻기)은 호출자 몫.
export interface OriginProjectCandidate {
  project_id: number; name: string; status: string; via: "repo" | "binding"; repo: string | null;
}
export async function findProjectsByOriginKey(key: string): Promise<OriginProjectCandidate[]> {
  if (!key) return [];
  const out = new Map<number, OriginProjectCandidate>();

  // ① 레포 레지스트리 경유 — git_url 을 정규화해 키가 같은 레포를 찾고, 그 레포를 쓰는 프로젝트를 모은다.
  const repos: { name: string; git_url: string | null }[] = await q(itemsPool,
    `SELECT name, git_url FROM repo WHERE git_url IS NOT NULL AND name IS NOT NULL`);
  const names = repos.filter((r) => originKey(r.git_url) === key).map((r) => r.name);
  if (names.length) {
    const rows: { project_id: number; name: string; status: string; repo: string }[] = await q(itemsPool,
      `SELECT p.id AS project_id, p.name, p.status, pr.repo
         FROM project_repo pr JOIN project p ON p.id = pr.project_id
        WHERE pr.repo = ANY($1) AND p.level='project'
        ORDER BY p.updated_at DESC`, [names]);
    for (const r of rows) if (!out.has(r.project_id)) out.set(r.project_id, { ...r, via: "repo" });
  }

  // ② 기존 바인딩 경유 — 다른 멤버/환경이 이미 이 origin 으로 바인딩해 둔 프로젝트(미등록 레포 커버).
  const bound: { project_id: number; name: string; status: string }[] = await q(itemsPool,
    `SELECT DISTINCT p.id AS project_id, p.name, p.status
       FROM project_folder_binding b JOIN project p ON p.id = b.project_id
      WHERE b.origin_key = $1 AND p.level='project'`, [key]);
  for (const r of bound) if (!out.has(r.project_id)) out.set(r.project_id, { ...r, via: "binding", repo: null });

  return [...out.values()];
}

// folder(상대경로) 기준 접근 판정 — org/store.projectAccessByFolder 의 v6(project) 짝.
//  WS attach 게이트(canAttach)가 세션 dir→folder 로 프로젝트를 찾을 때, UI 프로젝트 탭은 v6 project 에
//  세션을 만들므로(org_project 아님) 반드시 이 테이블도 함께 봐야 한다. 안 그러면 생성자 본인도 입장 불가.
export async function projectAccessByFolder(folder: string, memberId: string): Promise<boolean> {
  if (!folder || !memberId) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM project p
      WHERE p.folder=$1 AND p.level='project' AND (p.created_by=$2 OR EXISTS(
        SELECT 1 FROM project_member pm WHERE pm.project_id=p.id AND pm.member_id=$2)) LIMIT 1`,
    [folder, memberId]);
  return (r.rowCount ?? 0) > 0;
}
