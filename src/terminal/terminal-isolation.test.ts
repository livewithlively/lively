// 순수 단위 체크(node:assert) — 구성원 격리(#524) drop-priv 래핑·모드 게이트.
// 실행: npm run build && node dist/terminal/terminal-isolation.test.js
import assert from "node:assert/strict";
import { osUsername, wrapAsMember, cgspawnArgv, sessionSpawnArgv, cgroupInfraReady, isolationEnabled, BOX_SPAWN, BOX_CGSPAWN, OS_USER_PREFIX } from "./terminal-isolation.js";

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

t("wrapAsMember(cwd 지정) → box-spawn 앞에 --cwd <dir> (멤버 uid 로 cd — tmux -c 우회)", () => {
  assert.deepEqual(
    wrapAsMember("box_yoon", ["claude"], "/home/box_yoon/box"),
    ["sudo", "-n", "-u", "box_yoon", "--", BOX_SPAWN, "--cwd", "/home/box_yoon/box", "claude"],
  );
  // cwd 없으면 --cwd 안 붙음(파일 브리지 호출)
  assert.deepEqual(wrapAsMember("box_x", ["node"]), ["sudo", "-n", "-u", "box_x", "--", BOX_SPAWN, "node"]);
});

t("wrapAsMember: '--' 로 sudo 옵션 종료 — wrapper 는 항상 '--' 바로 다음(옵션 오인 방어)", () => {
  const argv = wrapAsMember("box_x", ["-l", "whatever"]); // 하네스 토큰이 '-' 로 시작해도
  const dd = argv.indexOf("--");
  assert.ok(dd !== -1, "'--' 존재");
  assert.equal(argv[dd + 1], BOX_SPAWN, "'--' 바로 다음은 wrapper");
  assert.equal(argv[0], "sudo");
  assert.equal(argv[3], "box_x"); // -u 다음이 runas 유저
});

// ── per-session cgroup 메모리 격리(#1059 D) ──
t("cgspawnArgv: sudo -n -- box-cgspawn <user> <high>M <max>M -- box-spawn -- cwd -- argv (uid 강하는 box-cgspawn 이 systemd-run --scope 로)", () => {
  assert.deepEqual(
    cgspawnArgv("box_yoon", ["claude", "--model", "opus"], "/home/box_yoon/box", { highMb: 3072, maxMb: 4096 }),
    ["sudo", "-n", "--", BOX_CGSPAWN, "box_yoon", "3072M", "4096M", "--", BOX_SPAWN, "--cwd", "/home/box_yoon/box", "claude", "--model", "opus"],
  );
});

t("cgspawnArgv: 0/미지정 한도 → '0'(무제한 — box-cgspawn 이 그 축 생략)", () => {
  // high 만 캡, max 무제한
  assert.deepEqual(
    cgspawnArgv("box_x", ["node"], undefined, { highMb: 2048 }),
    ["sudo", "-n", "--", BOX_CGSPAWN, "box_x", "2048M", "0", "--", BOX_SPAWN, "node"],
  );
  // 둘 다 0/음수/NaN → "0"
  assert.deepEqual(
    cgspawnArgv("box_x", [], undefined, { highMb: 0, maxMb: -5 }),
    ["sudo", "-n", "--", BOX_CGSPAWN, "box_x", "0", "0", "--", BOX_SPAWN],
  );
});

t("wrapAsMember(cg 지정): cgroup 인프라 미설치 박스면 종전 sudo -u 경로로 폴백(cap-gated 무회귀)", () => {
  // box_test 로컬엔 /opt/lively/libexec/box-cgspawn 이 없어 cgroupInfraReady()=false → 폴백 기대.
  //  인프라가 있는 박스(EC2 등)면 cgspawn 경유 — 그 경우만 positive shape 를 확인(환경 의존이라 조건부).
  const got = wrapAsMember("box_yoon", ["claude"], "/w", { highMb: 3072, maxMb: 4096 });
  if (cgroupInfraReady()) {
    assert.equal(got[3], BOX_CGSPAWN, "인프라 준비 → box-cgspawn 경유");
  } else {
    assert.deepEqual(got, ["sudo", "-n", "-u", "box_yoon", "--", BOX_SPAWN, "--cwd", "/w", "claude"], "미설치 → 종전 경로 폴백");
  }
});

t("wrapAsMember(cg 없음): 항상 종전 sudo -u 경로 — 기존 호출부 무회귀", () => {
  assert.deepEqual(
    wrapAsMember("box_yoon", ["claude"], "/w"),
    ["sudo", "-n", "-u", "box_yoon", "--", BOX_SPAWN, "--cwd", "/w", "claude"],
  );
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

// ── 세션 spawn 훅(LIVELY_SESSION_SPAWN) ──────────────────────────────────────
// 세션을 어디에 담아 띄울지 배포자가 갈아끼우는 확장점. 기본(미설정)에서는 **아무것도 바뀌지 않아야** 한다.

const withHook = (path: string, fn: () => void): void => {
  const prev = process.env.LIVELY_SESSION_SPAWN;
  process.env.LIVELY_SESSION_SPAWN = path;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.LIVELY_SESSION_SPAWN;
    else process.env.LIVELY_SESSION_SPAWN = prev;
  }
};

t("★ 미설정이면 기존 동작 그대로 — 이 훅은 기본 배포에 영향이 없어야 한다", () => {
  assert.deepEqual(wrapAsMember("box_x", ["claude"]), ["sudo", "-n", "-u", "box_x", "--", BOX_SPAWN, "claude"]);
});

t("설정하면 훅이 argv 를 받는다 — 순서는 box-cgspawn 과 동일(기존 래퍼 재사용 가능)", () => {
  withHook("/opt/x/session-spawn", () => {
    assert.deepEqual(
      sessionSpawnArgv("box_yoon", ["claude", "--model", "opus"], undefined, { highMb: 768, maxMb: 1024 }),
      ["/opt/x/session-spawn", "box_yoon", "768M", "1024M", "--", "claude", "--model", "opus"],
    );
  });
});

t("★★ 메모리 캡이 없어도 훅은 호출된다 — box-cgspawn 갈래를 재사용 못 한 이유가 바로 이것이다", () => {
  withHook("/opt/x/session-spawn", () => {
    const got = wrapAsMember("box_yoon", ["claude"]);   // cg 없음
    assert.equal(got[0], "/opt/x/session-spawn");
    assert.deepEqual(got.slice(1), ["box_yoon", "0", "0", "--", "claude"]);
  });
});

t("cwd 는 훅 뒤 '--' 다음에 그대로 넘어간다(멤버 uid 로 cd 하는 책임은 훅에 있다)", () => {
  withHook("/opt/x/session-spawn", () => {
    assert.deepEqual(
      wrapAsMember("box_yoon", ["claude"], "/home/box_yoon/box"),
      ["/opt/x/session-spawn", "box_yoon", "0", "0", "--", "--cwd", "/home/box_yoon/box", "claude"],
    );
  });
});

t("훅이 설정되면 cgroup 경로보다 우선한다(둘 다 켜도 훅 하나만 탄다)", () => {
  withHook("/opt/x/session-spawn", () => {
    const got = wrapAsMember("box_yoon", ["claude"], undefined, { highMb: 100, maxMb: 200 });
    assert.equal(got[0], "/opt/x/session-spawn");
    assert.ok(!got.includes(BOX_CGSPAWN));
    assert.ok(!got.includes("sudo"));
  });
});

t("빈 문자열은 미설정과 같다(env 를 '' 로 둔 배포가 조용히 격리를 잃으면 안 된다)", () => {
  withHook("", () => {
    assert.deepEqual(wrapAsMember("box_x", ["claude"]), ["sudo", "-n", "-u", "box_x", "--", BOX_SPAWN, "claude"]);
  });
});

console.log(`\n${pass} passed`);
