// 복원이 **대화 매핑을 잃지 않게** 하는 순수 규칙 두 개(#2122). 라우트(terminal/routes.ts)가 이걸 써서
//  ① 매핑이 비었을 때 저장된 대화 파일 경로에서 id 를 재독하고 ② 승계가 확인된 경우에만 옛 행을 지운다.
//
//  왜 이 규칙이 필요한가: 복원은 새 세션을 만들고 **옛 desired-state 행을 지운다**. 매핑(claude_session_id)은
//  그 사이 carry-forward 한 번으로만 옮겨지는데, 종전엔 그게 가드+베스트에포트였다 — 소스가 이미 null 이면
//  건너뛰고, 이관이 0행/throw 로 실패해도 삼킨 뒤 옛 행은 무조건 지웠다. 그러면 매핑이 어디에도 안 남아
//  그 뒤 복원이 **영원히 picker** 로 떨어진다(실측 2026-08-26: 9442ed3d.claude_session_id=null — 대화
//  01985b13 은 2MB 로 멀쩡한데 picker). 박스 세션엔 노드 세션의 org_node_session_map 같은 내구
//  사이드테이블이 없어, 옛 행이 매핑의 **유일한 사본**이다.
import { harnessIo } from "../terminal/harness-io/adapter.js";

/**
 * 저장된 대화 파일 경로에서 그 대화의 id 를 **재독**한다. 추측이 아니라 **저장된 사실의 재독**이다 —
 * 훅 보고를 받는 자리(/claude-uuid)가 `transcript_path.includes(uuid)` 를 강제하므로 두 값이 같은 대화를
 * 가리킨다는 건 이미 검증돼 있고, 여기선 그 경로에서 id 를 도로 뽑아 그 하네스의 id 규약(convIdOk)으로
 * 한 번 더 거른다.
 *
 * ⚠ '그 폴더의 가장 최근 대화'를 고르는 추측 폴백은 **여전히 금지**다(격리 홈에서 남의 대화를 집거나 같은
 *  폴더의 다른 대화를 '최신'이라며 집는다 — 그럴싸하게 틀리는 쪽이 picker 한 번보다 나쁘다, routes.ts 주석).
 *  규약을 확정 안 한 하네스(convIdOk=null: codex·grok·antigravity)는 아무것도 하지 않는다 — 모르면 안 한다.
 */
export function convIdFromTranscriptPath(harnessKey: string | null | undefined, transcriptPath: string | null | undefined): string | null {
  const p = String(transcriptPath || "").trim();
  if (!p) return null;
  const io = harnessIo(harnessKey || "claude");
  if (!io?.convIdOk) return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  // 후보는 둘 — 파일명(확장자 제거)과 그 부모 디렉터리명. 하네스마다 id 가 앉는 자리가 다르다
  //  (claude 는 `<uuid>.jsonl`, grok 은 `<convId>/updates.jsonl`). 규약을 아는 하네스의 자를 대어 맞는 것만 고른다.
  const cands = [String(parts[parts.length - 1] || "").replace(/\.[A-Za-z0-9]+$/, ""), String(parts[parts.length - 2] || "")];
  for (const c of cands) if (c && io.convIdOk(c)) return c;
  return null;
}

/**
 * 옛 desired-state 행을 **지워도 되는가**. 지워도 되는 건 매핑이 확실히 다른 곳에 남았을 때뿐이다.
 *
 * · 이관할 매핑이 애초에 없으면(mapped=null) 잃을 것이 없다 → 지운다(종전 동작 유지).
 * · 새 행(org_session_state) 또는 내구 맵(org_node_session_map) **한 곳이라도** 남았으면 → 지운다.
 * · 매핑은 있는데 **둘 다 실패**했으면 → 지우지 않는다. 옛 행이 마지막 사본이기 때문이다. 남겨두면 복원
 *   목록에 옛 카드가 한 장 남지만(눈에 보이고 사용자가 지울 수 있다) 대화를 잃지는 않는다 — 다음 복원이
 *   그 행에서 매핑을 다시 이관한다(자가치유).
 */
export function mayForgetOldState(mapped: string | null | undefined, carriedInRow: boolean, carriedInDurableMap: boolean): boolean {
  if (!mapped) return true;
  return carriedInRow || carriedInDurableMap;
}

/**
 * 훅의 매핑 보고(POST …/claude-uuid)에 **어떤 HTTP 상태로 답할 것인가**(#2151).
 *
 * 왜 규칙이어야 하나: 훅은 응답 **본문을 읽지 않는다** — HTTP 상태(`r.ok`)만 보고 (box, uuid) 조합당
 * 1회성 dedup 플래그(`<box>.<uuid>.mapped`)를 쓴다. 그래서 '어디에도 못 적었다'를 `200 {ok:false}` 로
 * 답하면 훅은 그걸 **성공으로 기록**하고 그 조합을 영영 다시 보고하지 않는다 = 그 세션은 영구 무매핑,
 * 복원은 영원히 후보 picker (2026-08-27 실측: 한 계정의 복원 가능 claude 세션 124개 중 51개가 이 상태).
 *
 * '박스 행이 없다'는 **거부가 아니라 아직 없다**이다: 노드 세션은 게이트웨이가 create 를 릴레이한 뒤
 * mirrorNodeSession 으로 행을 적는데, 노드의 pane 은 그보다 먼저 떠서 SessionStart 훅이 1초 안에 보고한다.
 * 그 창에 걸리면 박스 행도 노드 스냅샷도 아직 없다 — 그러니 **재시도 가능한 상태**로 답해야 한다.
 * 훅은 60초 쿨다운 뒤 다음 툴 사용에 다시 보고하고, 그때는 행이 있다(/active 가 쓰는 규약과 같다).
 *
 * ⚠ 소유자 불일치(403)는 여기서 다루지 않는다 — 그건 '아직 없다'가 아니라 진짜 거부라 라우트가 먼저 던진다.
 */
export function mappingReportStatus(wroteRow: boolean, wroteDurableMap: boolean): 200 | 404 {
  return wroteRow || wroteDurableMap ? 200 : 404;
}
