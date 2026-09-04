// 유령 attach 정리의 참조수 (#2148) — 스크래치패드 spec-attach.md 표 A(1~5행).
//
// 왜 참조수가 필요한가: 원격 tmux(매니지드)에서는 `term.kill()` 이 컨테이너 **안**의 attach 클라이언트를
//  못 죽인다(도커는 exec 클라이언트가 끊겨도 exec 을 죽이지 않고, tmux -CC 는 SIGHUP 을 무시한다).
//  그래서 WS 가 닫힐 때 `detach-client -s <세션>` 으로 끊어야 하는데, 그건 그 세션의 **모든** 클라이언트를
//  끊으므로 **마지막 WS 가 닫힐 때만** 해야 한다 — 세션 공유(session-share)로 두 사람이 같은 판을 볼 수 있다.
import assert from "node:assert/strict";
import test from "node:test";
import { acquireAttachRef, attachRefCount, releaseAttachRef, nothingToDetach } from "./terminal-pty.js";

test("① 참조 1개 → release 는 '마지막'이고 카운터를 비운다", () => {
  const id = "box-t-solo";
  acquireAttachRef(id);
  assert.equal(attachRefCount(id), 1);
  assert.equal(releaseAttachRef(id), true, "마지막 WS 였으므로 유령을 끊어야 한다");
  assert.equal(attachRefCount(id), 0, "카운터에서 지워야 한다(무한 증가 방지)");
});

// ★ 여기가 이 기능의 전부다 — 탭 두 개가 같은 판을 볼 때 하나를 닫았다고 detach 하면
//  **남아서 보고 있는 사람의 화면이 끊긴다.**
test("② 참조 2개 → 첫 release 는 '마지막 아님'", () => {
  const id = "box-t-shared";
  acquireAttachRef(id); acquireAttachRef(id);
  assert.equal(releaseAttachRef(id), false, "아직 보고 있는 WS 가 있으면 끊지 않는다");
  assert.equal(attachRefCount(id), 1);
});

test("③ 참조 2개 → 두 번째 release 가 '마지막'", () => {
  const id = "box-t-shared2";
  acquireAttachRef(id); acquireAttachRef(id);
  releaseAttachRef(id);
  assert.equal(releaseAttachRef(id), true);
  assert.equal(attachRefCount(id), 0);
});

// 게이트웨이 재시작으로 참조 장부를 잃은 뒤 남은 WS 가 닫히는 경로. 참조가 없다 = 붙은 WS 가 없다 이므로
//  그 시점에 컨테이너에 남아 있는 클라이언트는 정의상 유령이다 → 끊는 쪽이 맞다.
test("④ 모르는 id 를 release 하면 '마지막'으로 본다", () => {
  assert.equal(releaseAttachRef("box-t-unknown"), true);
  assert.equal(attachRefCount("box-t-unknown"), 0);
});

test("⑤ 참조 3개 → release 2회는 둘 다 '마지막 아님'", () => {
  const id = "box-t-three";
  acquireAttachRef(id); acquireAttachRef(id); acquireAttachRef(id);
  assert.equal(releaseAttachRef(id), false);
  assert.equal(releaseAttachRef(id), false);
  assert.equal(attachRefCount(id), 1);
});

// 세션끼리 섞이지 않는다 — 한 세션의 마지막 탭이 다른 세션의 클라이언트를 끊으면 안 된다.
test("⑥ 세션별로 독립이다", () => {
  acquireAttachRef("box-t-a"); acquireAttachRef("box-t-b");
  assert.equal(releaseAttachRef("box-t-a"), true);
  assert.equal(attachRefCount("box-t-b"), 1, "다른 세션의 참조는 그대로");
});

// ── 「끊을 것이 없었다」와 「못 끊었다」를 가른다 (#3545) ───────────────────────────────
//  왜 필요한가: 워커가 죽으면 릴레이가 함께 죽어 컨테이너 안 클라이언트가 **이미** 걷힌 뒤다
//  (프로덕션 실측 2026-09-04). 그래서 게이트웨이가 뒤늦게 쏘는 `detach-client` 는 거의 항상
//  `no current client` 로 끝난다. 그걸 실패로 남기면 **정상 경로가 매번 빨간 줄을 찍고**, 진짜
//  실패(중계 404·타임아웃)가 그 잡음에 묻힌다 — #2625 T1 이 warn 을 넣은 취지가 거꾸로 죽는다.
//  ⚠ 반대 방향이 더 위험하다: 모르는 오류를 «없음» 으로 접으면 못 끊은 걸 아무도 모른다.
//   그래서 표는 **아는 문구만** 성공으로 접고 나머지는 전부 시끄럽게 둔다.
test("D1 tmux 가 «클라이언트 없음»으로 끝낸 것은 실패가 아니다 — 실측 문자열 그대로", () => {
  assert.equal(nothingToDetach(
    'Command failed: node /opt/lively/libexec/tmux-relay.cjs lively-46e3 detach-client -s box-sangmin-yoon-520fa471\nno current client\n'), true);
});
test("D2 세션이 이미 갔다는 답도 실패가 아니다(유령도 함께 갔다)", () => {
  for (const m of ["can't find session: box-a-1", "cant find session", "session not found", "no such session"]) {
    assert.equal(nothingToDetach(m), true, m);
  }
});
test("D3 대소문자는 안 가린다", () => {
  assert.equal(nothingToDetach("NO CURRENT CLIENT"), true);
});
test("D4 진짜 못 끊은 것은 전부 시끄럽게 남는다", () => {
  for (const m of [
    "Command failed: … 404 Not Found",           // 중계가 세션 컨테이너를 못 찾음
    "timed out after 5000ms",                     // 중계 타임아웃
    "EACCES: permission denied",                  // 소켓 권한
    "connect ECONNREFUSED /run/lvly-t/x/sock",    // 브로커 소켓 없음
    "",                                           // 사유 없음 — 모르면 시끄럽게
  ]) {
    assert.equal(nothingToDetach(m), false, m);
  }
});
