// #1631(2026-09-13) — 초대로 들어온 사람이 물려받는 «워크스페이스 용도» 는 **그 워크스페이스 칸에서만** 온다.
//
//  격리 리뷰가 잡은 자리: workspacePurposeStage 가 워크스페이스 칸(by_workspace[ws])이 없는 구성원의 옛 최상위
//   welcome 을 후보로 넣고 있었다. 셀프호스트 박스처럼 구성원 행이 워크스페이스를 가로지르는 배포에서는 **다른
//   워크스페이스에서 답한 용도**가 새 워크스페이스로 새고, 먼저 답한 순이라 옛 값이 새 답을 계속 이긴다.
//   용도 질문(#909)은 워크스페이스 칸(#2265)이 생긴 뒤에 들어왔으므로, 워크스페이스 축이 있으면 칸만 봐도 잃는 답이 없다.
//
//  DB 바운드라 조회 모양을 소스에서 못박는다(me-account-delete.test.ts 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MEMBERS = readFileSync("src/org/store/members.ts", "utf8");

function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `함수를 찾지 못했다: ${sig}`);
  const next = src.slice(at + sig.length).search(/\nexport /);
  return next > 0 ? src.slice(at, at + sig.length + next) : src.slice(at);
}

test("★ P1 워크스페이스 축이 있으면 그 칸의 답만 후보다 — 칸이 없는 사람의 옛 최상위 답을 빌려 오지 않는다", () => {
  const body = fnBody(MEMBERS, "export async function workspacePurposeStage(");
  assert.doesNotMatch(body, /ELSE m\.liv_profile->'welcome'/,
    "워크스페이스 칸이 없는 구성원의 최상위 welcome 을 후보로 넣는다 — 다른 워크스페이스에서 답한 용도가 샌다");
  assert.match(body, /by_workspace/, "워크스페이스 칸을 안 본다 — 물려받기가 통째로 사라졌다");
});
