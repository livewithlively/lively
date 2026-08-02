// OS 레벨 공개범위 강제의 **동기화 지점**(#1291 v2 §4.7) — 잠금 상태가 바뀌면 그 리스트에 속한
//  프로젝트 폴더의 ACL 도 따라가야 한다. 리스트 설정·스페이스 설정·프로젝트 생성·프로젝트 이동이 전부
//  이걸 부르므로, capability 파일 중 한 곳에 두면 서로를 import 하는 순환이 생긴다(실제로 TDZ 로 터졌다).
//  → 정책 SoT(v6/visibility)와 나란히 v6 계층에 둔다. capability 는 여기를 향해 한 방향으로만 의존한다.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";
import { visibleListIds, PUBLIC_VIEWER } from "./visibility.js";
import { listMembers } from "../org/store.js";
import { projectAbsPath } from "../project/project-fs.js";
import { restrictFolder, unrestrictFolder } from "../terminal/os-acl.js";
import { logger } from "../log.js";

// OS 레벨 강제 동기화(#1291 v2 §4.7) — 잠금 상태가 바뀌면 그 리스트에 속한 프로젝트 폴더의 ACL 도 따라가야 한다.
//  중앙박스 AI 는 셸을 가지므로 API 만 잠그면 `cat` 한 줄로 뚫린다. 반대로 열었는데 ACL 이 남으면 대상자가 못 읽는다.
//  best-effort 다 — setfacl 이 없거나 실패해도 잠금 설정 자체는 성공시킨다(API 강제는 이미 유효하고,
//  여기서 실패를 던지면 "설정이 안 됐다"고 오해하게 된다). 결과는 로그로 남는다.
export async function syncFolderAcls(listId: number): Promise<void> {
  try {
    const projects = await q(itemsPool,
      `SELECT folder FROM project WHERE list_id=$1 AND level='project' AND folder IS NOT NULL`, [listId]);
    if (!projects.length) return;
    // ⚠ 잠겼는지를 `row.visibility === 'members'` 로 판단하면 안 된다 — **상속을 못 본다.**
    //  스페이스만 잠근 경우 그 안 리스트는 visibility='open' 이라 여기서 '안 잠김'으로 읽히고,
    //  그러면 unrestrictFolder 가 돌아 **API 는 막았는데 셸 경로만 도로 열어 주는** 최악이 된다.
    //  술어 SoT 에 물어 상속까지 반영한다(뷰어 무관 = 아무 grant 없는 사람에게 보이나).
    const openToAll = await visibleListIds(PUBLIC_VIEWER);
    const locked = !!openToAll && !openToAll.has(listId);
    // 대상 = **실제로 이 리스트를 볼 수 있는 사람 전원**. 자기 grant ∪ 팀만 펼치면 조상까지 걸린 경우가 틀린다
    //  (유효 대상 = 자기 설정 ∩ 조상 전부). 멤버별로 술어에 물어 그 교집합을 그대로 얻는다 — 공개범위 변경은
    //  드문 관리 행위라 멤버 수만큼 조회해도 된다(요청 경로가 아니다).
    let audience: string[] = [];
    if (locked) {
      const members = await listMembers().catch(() => []);
      for (const m of members) {
        if (m.state === "inactive" || m.kind === "system") continue;
        const vis = await visibleListIds(m.id);
        if (!vis || vis.has(listId)) audience.push(m.id);
      }
    }
    for (const pr of projects) {
      const abs = projectAbsPath(String(pr.folder));
      if (locked) await restrictFolder(abs, audience);
      else await unrestrictFolder(abs);
    }
  } catch (e) {
    logger.warn({ listId, err: (e as Error)?.message }, "[vis-acl] 리스트 폴더 ACL 동기화 실패(API 강제는 유효)");
  }
}

/** 스페이스(폴더) 잠금이 바뀌면 그 아래 **모든 리스트**의 ACL 이 따라가야 한다 — 상속이 곧 잠금이기 때문이다.
 *  (조상 체인은 술어가 이미 재귀로 본다. 여기선 '어느 리스트가 영향받나'만 재귀로 모으면 된다.) */
export async function syncFolderAclsUnderFolder(folderId: number): Promise<void> {
  try {
    const rows = await q(itemsPool, `
      WITH RECURSIVE sub AS (
        SELECT id FROM project_folder WHERE id = $1
        UNION ALL
        SELECT f.id FROM project_folder f JOIN sub ON f.parent_id = sub.id
      )
      SELECT id FROM project_list WHERE folder_id IN (SELECT id FROM sub)`, [folderId]);
    for (const r of rows) await syncFolderAcls(Number((r as any).id));
  } catch (e) {
    logger.warn({ folderId, err: (e as Error)?.message }, "[vis-acl] 스페이스 하위 ACL 동기화 실패(API 강제는 유효)");
  }
}
