// v6 스키마 조각 — file_move(#4688): **옛 경로 → 새 경로 기록**. 웹·API 로 파일·폴더 이름을 바꾸거나 옮길 때 한 줄씩 남고,
//  옛 링크(#/f?root=&path=)를 열면 이 기록을 따라 새 자리로 연다(#4671 ① — 바뀌지 않는 id 주소 대신 경로 주소 + 이 기록).
//  설계 정본: 지식 file-address-scheme-design-4670 §4 · rename-move-redirect-source-rekey-4688.
//
//   · scope     — 자리. 'shared'(공유 루트 — 프로젝트 폴더도 그 아래 project/<id>/…) · 'personal:<구성원>'(개인 폴더는 주인별 —
//                 root=personal 링크는 여는 사람 자신의 폴더로 풀리므로 남의 기록을 따라가면 안 된다).
//   · from_path · to_path — 그 자리 기준 상대경로(posix). 폴더는 접두로 한 줄이다(하위 전부가 그 줄로 따라간다).
//   · arrived_at — 그 줄이 옮겨 놓은 것이 to_path 에 **도착한 때**(접으면 지금으로 바뀐다). 접기와 따라가기가 «도착 뒤에 생긴 기록만»
//     다음 걸음으로 보는 데 쓴다(같은 이름 폴더를 다시 쓰는 경우 — file-move-store.ts 머리말).
//   · 같은 옛 경로는 한 줄 — 나중 이동이 이긴다. 기록할 때 «그 자리로 들어왔던 기록»의 목적지를 새 자리로 접어(연쇄 접기)
//     대개 한두 번에 닿고, 되돌리기(A→B→A)로 생긴 제자리 줄은 지운다(file-move-store.ts).
//
//  ⚠ tenant_id 는 boot/schemas.ts 의 ensureTenantColumn 이 붙인다. 자연키 (scope, from_path) 는 (tenant_id, …) 로 다시 쓰이므로
//   store 의 ON CONFLICT 는 tenant_id 를 명시한다(shared-folder-store 와 같은 규약).
//  ⚠ 경로에는 잠긴 폴더·가려진 프로젝트 안의 이름이 남는다 — db/firewall DENIED_TABLES 에 올려 두었다. 읽는 길은 판정을 거치는
//   탐색기 «옛 링크 풀기»(GET /api/ui/terminal/browse/moved) 하나다.
import type { Pool } from "pg";
import { ensureCheck } from "../../org/schema/ddl-util.js";

export async function initV6FileMove(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_move(
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      moved_by TEXT,
      arrived_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ${ensureCheck("file_move", {
      file_move_scope_chk: "scope = 'shared' OR scope LIKE 'personal:_%'",
      file_move_paths_chk: "from_path <> '' AND to_path <> '' AND from_path <> to_path",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS file_move_from_uq ON file_move(scope, from_path);
    CREATE INDEX IF NOT EXISTS file_move_to_idx ON file_move(scope, to_path);
  `);
}
