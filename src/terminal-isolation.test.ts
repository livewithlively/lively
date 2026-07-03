// 순수 단위 체크(node:assert) — 구성원 격리(#524) drop-priv 래핑·모드 게이트.
// 실행: npm run build && node dist/terminal-isolation.test.js
import assert from "node:assert/strict";
import { osUsername, wrapAsMember, isolationEnabled, BOX_SPAWN, OS_USER_PREFIX } from "./terminal-isolation.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("osUsername → box_<slug> (userSlug 산출물 규칙)", () => {
  assert.equal(osUsername("yoon"), "box_yoon");
  assert.equal(osUsername("won-jun"), "box_won-jun");
  assert.equal(OS_USER_PREFIX, "box_");
});

t("wrapAsMember(하네스 argv) → sudo -n -u <osUser> -- <wrapper> <harness…>", () => {
  assert.deepEqual(
    wrapAsMember("box_yoon", ["claude", "--model", "opus"]),
    ["sudo", "-n", "-u", "box_yoon", "--", BOX_SPAWN, "claude", "--model", "opus"],
  );
});

t("wrapAsMember(빈 argv=셸 세션) → wrapper 만 (로그인 셸은 wrapper 가 실행)", () => {
  assert.deepEqual(
    wrapAsMember("box_yoon", []),
    ["sudo", "-n", "-u", "box_yoon", "--", BOX_SPAWN],
  );
});

t("wrapAsMember: '--' 로 sudo 옵션 종료 — wrapper 는 항상 '--' 바로 다음(옵션 오인 방어)", () => {
  const argv = wrapAsMember("box_x", ["-l", "whatever"]); // 하네스 토큰이 '-' 로 시작해도
  const dd = argv.indexOf("--");
  assert.ok(dd !== -1, "'--' 존재");
  assert.equal(argv[dd + 1], BOX_SPAWN, "'--' 바로 다음은 wrapper");
  assert.equal(argv[0], "sudo");
  assert.equal(argv[3], "box_x"); // -u 다음이 runas 유저
});

t("isolationEnabled: 기본 활성(secure-by-default), 오직 =off 만 하드 비활성", () => {
  const prev = process.env.LIVELY_MEMBER_ISOLATION;
  delete process.env.LIVELY_MEMBER_ISOLATION;
  assert.equal(isolationEnabled(), true);       // 기본 활성(실제 격리는 box-spawn+provision 게이트)
  process.env.LIVELY_MEMBER_ISOLATION = "os";
  assert.equal(isolationEnabled(), true);        // 명시 값도 활성
  process.env.LIVELY_MEMBER_ISOLATION = "off";
  assert.equal(isolationEnabled(), false);       // 하드 킬스위치
  if (prev === undefined) delete process.env.LIVELY_MEMBER_ISOLATION;
  else process.env.LIVELY_MEMBER_ISOLATION = prev;
});

console.log(`\n${pass} passed`);
