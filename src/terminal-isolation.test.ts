// 순수 단위 체크(node:assert) — 구성원 격리(#524) drop-priv 래핑·모드 게이트.
// 실행: npm run build && node dist/terminal-isolation.test.js
import assert from "node:assert/strict";
import { osUsername, wrapAsMember, isolationMode, BOX_SPAWN, OS_USER_PREFIX } from "./terminal-isolation.js";

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

t("isolationMode: 기본 off, 오직 =os 만 os (opt-in·무회귀, 엄격 비교)", () => {
  const prev = process.env.LIVELY_MEMBER_ISOLATION;
  delete process.env.LIVELY_MEMBER_ISOLATION;
  assert.equal(isolationMode(), "off");
  process.env.LIVELY_MEMBER_ISOLATION = "1";   // 레거시/오타 값 → off (안전)
  assert.equal(isolationMode(), "off");
  process.env.LIVELY_MEMBER_ISOLATION = "OS";  // 대문자도 아님 → off (엄격)
  assert.equal(isolationMode(), "off");
  process.env.LIVELY_MEMBER_ISOLATION = "os";
  assert.equal(isolationMode(), "os");
  if (prev === undefined) delete process.env.LIVELY_MEMBER_ISOLATION;
  else process.env.LIVELY_MEMBER_ISOLATION = prev;
});

console.log(`\n${pass} passed`);
