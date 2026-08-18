// 멤버 파일 op 실행 seam(LIVELY_MEMBER_EXEC) — **설정이 없으면 종전과 완전히 동일**해야 한다.
//  tmux-exec-seam.test 와 같은 명제·같은 구조: 새 노브가 기본 동작을 건드리지 않는다(무회귀).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { installTenantSlugResolver } from "./catalog.js";
import { memberExecArgv } from "./terminal-member-fs.js";
import { memberExecConfigured } from "./terminal-isolation.js";

afterEach(() => {
  delete process.env.LIVELY_MEMBER_EXEC;
  installTenantSlugResolver(() => null);
});

test("기본(미설정) — 빈 argv = 로컬 uid 강하(wrapAsMember)를 그대로 쓴다", () => {
  delete process.env.LIVELY_MEMBER_EXEC;
  assert.deepEqual(memberExecArgv(), []);
  assert.equal(memberExecConfigured(), false);
});

test("빈 문자열·공백만이면 미설정과 같다", () => {
  process.env.LIVELY_MEMBER_EXEC = "   ";
  assert.deepEqual(memberExecArgv(), []);
  assert.equal(memberExecConfigured(), false);
});

test("★★ {slug} 가 그 요청의 테넌트로 치환된다", () => {
  process.env.LIVELY_MEMBER_EXEC = "node /opt/lively/libexec/member-exec-relay.cjs {slug}";
  installTenantSlugResolver(() => "acme");
  assert.deepEqual(memberExecArgv(), ["node", "/opt/lively/libexec/member-exec-relay.cjs", "acme"]);
});

test("★★ {slug} 인데 컨텍스트가 없으면 던진다 — 로컬 폴백 금지(남의/없는 경로를 만지게 된다)", () => {
  process.env.LIVELY_MEMBER_EXEC = "relay {slug}";
  installTenantSlugResolver(() => null);
  assert.throws(() => memberExecArgv(), /테넌트 컨텍스트/);
});

test("템플릿 없는 고정 명령이면 그대로 쪼갠다(컨텍스트 불요)", () => {
  process.env.LIVELY_MEMBER_EXEC = "ssh node-1 member-run";
  assert.deepEqual(memberExecArgv(), ["ssh", "node-1", "member-run"]);
});

test("★ 값은 호출 시점에 읽는다(모듈 로드 시점이 아니라)", () => {
  delete process.env.LIVELY_MEMBER_EXEC;
  assert.deepEqual(memberExecArgv(), []);
  process.env.LIVELY_MEMBER_EXEC = "relay";
  assert.deepEqual(memberExecArgv(), ["relay"]);
});

// ── 게이트 우회 — 중계 배포에선 로컬 passwd·box-spawn 존재가 판정 기준이 아니다 ──
import { resolveMemberOsUser, osUsername } from "./terminal-isolation.js";

test("★ 중계 설정 시 resolveMemberOsUser 는 로컬 게이트(리눅스·box-spawn·passwd)를 건너뛴다", async () => {
  process.env.LIVELY_MEMBER_EXEC = "relay {slug}";
  // 이 러너(맥·box-spawn 없음)에서 non-null 이 나온다 = 로컬 검사를 안 탔다는 증명이다.
  assert.equal(await resolveMemberOsUser("yoon"), osUsername("yoon"));
  delete process.env.LIVELY_MEMBER_EXEC;
  if (process.platform !== "linux") {
    assert.equal(await resolveMemberOsUser("yoon"), null, "미설정이면 종전대로 폴백");
  }
});
