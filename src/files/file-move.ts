// 이름 바꾸기·옮기기 뒷일(#4688) — 웹·API 로 파일·폴더를 옮긴 **같은 자리에서** 두 가지를 맞춘다.
//  ① 자료 좌표 옮기기(ingest/local-file moveLocalPath) — 같은 자료 행을 제자리에서. 종전엔 옮긴 파일의 자료가 옛 경로에 남아
//     AI 가 원본을 못 가져오고(openLocalArtifact 가 옛 자리에서 찾다 null) 프로젝트 파일 색인이 옛 경로를 보였고 새 경로엔 자료가 없었다.
//  ② «옛 경로 → 새 경로» 기록(v6/file-move-store) — 옛 링크(#/f?root=&path=)가 새 자리로 열리게(탐색기 «옛 링크 풀기» 가 따라간다).
//  부르는 곳: 프로젝트 자료 이름 바꾸기 · 옮기기(project-routes) · 홈 탐색기 이름 바꾸기(terminal-files). 셸 `mv` 는 서버가 모른다(범위 밖).
//  둘은 따로 간다 — 하나가 실패해도 다른 하나는 한다. 실패는 남기고 삼킨다: 파일 옮기기는 이미 끝났고, 지우기 전파·공개범위 경로 동기화와
//   같은 자세다(되돌릴 수 없는 일을 끝낸 뒤의 뒷일이 요청을 실패로 만들면 화면과 디스크가 어긋난다).
import { moveLocalPath, type LocalMove } from "../ingest/local-file.js";
import { recordFileMove } from "../v6/file-move-store.js";

export interface SettledMove {
  /** 기록의 자리 — 'shared' · 'personal:<구성원>'(v6/file-move-store SHARED_MOVE_SCOPE · personalMoveScope). null = 기록하지 않는 자리 */
  scope: string | null;
  /** 그 자리 기준 옛·새 경로(링크의 path 와 같은 꼴 — 공유 루트면 `project/<id>/…` 포함) */
  fromPath: string;
  toPath: string;
  /** 자료 좌표 — 자료를 만들지 않는 자리면 null */
  local: LocalMove | null;
  /** 옮긴 사람(열람 신원) */
  by: string | null;
}

export async function settleFileMove(m: SettledMove): Promise<void> {
  if (m.local) {
    await moveLocalPath(m.local)
      .catch((e) => console.warn(`[file-move] 자료 좌표 옮기기 실패 ${m.fromPath} → ${m.toPath}: ${(e as Error)?.message ?? e}`));
  }
  if (m.scope) {
    await recordFileMove(m.scope, m.fromPath, m.toPath, m.by)
      .catch((e) => console.warn(`[file-move] 옮긴 기록 실패 ${m.fromPath} → ${m.toPath}: ${(e as Error)?.message ?? e}`));
  }
}
