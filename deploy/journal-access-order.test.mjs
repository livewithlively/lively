// #1240 회귀 가드 — 저널 읽기 권한 부여의 **호출 위치** 불변식.
//
//  사양: 게이트웨이 서비스 유저를 `systemd-journal` 그룹에 넣는 일은 **서비스 유저가 확정된 뒤**, 그리고
//   **서비스를 (재)기동하기 전**에 일어나야 한다. 그 두 조건을 동시에 만족하는 자리가 `render_service_unit` 이다.
//
//  왜 테스트가 필요한가(2026-07-29 실제로 발생한 버그): 처음엔 이 로직을 `ensure_host_memory_safety` 안에 뒀는데,
//   그 함수는 `install.sh` 에서 `os_install_service` **앞**에 호출된다. 그런데 `SERVICE_USER` 는 바로 그
//   `os_install_service`(→ deploy/linux/provision.sh) 안에서야 할당된다. 그래서 신규 설치에선 값이 비어
//   폴백으로 떨어지고 — 기본 경로는 대상 유저가 아예 없고, opt-in 경로도 유저 생성 전이라 — **양쪽 다 조용히
//   no-op** 이 됐다. 첫 `update.sh` 전까지 기능이 안 켜지는데 **경고조차 안 뜬다**(조건문 자체가 거짓이라
//   warn 분기에 도달하지 못한다). 관측 공백을 메우려던 기능이 스스로 관측 불가 상태가 되는 셈이라 특히 나쁘다.
//
//  이 파일은 그 배치를 텍스트로 못 박는다(형제: provision-member-order.test.mjs 가 같은 방식으로 순서를 락한다).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const common = readFileSync(join(here, "lib", "common.sh"), "utf8");
const install = readFileSync(join(here, "install.sh"), "utf8");

// 셸 함수 본문 추출 — `name() {` 부터 컬럼 0 의 `}` 까지.
const bodyOf = (src, name) => {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.ok(start >= 0, `함수를 찾지 못했다: ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.ok(end > start, `함수 끝을 찾지 못했다: ${name}`);
  return lines.slice(start, end + 1).join("\n");
};
// 주석이 아닌 실제 명령 라인만 — 설명 주석의 명령어 언급에 오탐되지 않게(형제 테스트와 같은 원칙).
const hasCmd = (body, re) => body.split(/\r?\n/).some((l) => !l.trimStart().startsWith("#") && re.test(l));

const renderBody = bodyOf(common, "render_service_unit");
const memBody = bodyOf(common, "ensure_host_memory_safety");
const grantBody = bodyOf(common, "ensure_journal_read_access");

// ① 그룹 편입은 전용 함수 안에서만 일어난다(여기저기 흩어지면 위치 불변식을 지킬 수 없다).
{
  const usermodLines = common.split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#") && /usermod -aG systemd-journal/.test(l));
  assert.equal(usermodLines.length, 1, `systemd-journal 편입은 한 곳에서만 해야 한다(발견 ${usermodLines.length}곳)`);
  assert.ok(hasCmd(grantBody, /usermod -aG systemd-journal/), "그 한 곳은 ensure_journal_read_access 여야 한다");
}

// ② 호출은 render_service_unit 안에서 — 거기서 SERVICE_USER 가 확정돼 있고(유닛의 User= 를 그 값으로 쓴다),
//    아직 기동 전이라 새 그룹이 다음 exec 에 적용된다.
assert.ok(hasCmd(renderBody, /ensure_journal_read_access\b/),
  "render_service_unit 이 ensure_journal_read_access 를 호출해야 한다(서비스 유저 확정 + 기동 전)");

// ③ ⚠ 핵심 회귀락 — ensure_host_memory_safety 안에서는 부르면 안 된다.
//    아래 ④ 가 보여주듯 그 함수는 서비스 유저가 정해지기 **전에** 돌기 때문이다.
assert.ok(!hasCmd(memBody, /ensure_journal_read_access\b|usermod -aG systemd-journal/),
  "ensure_host_memory_safety 안에서 저널 권한을 주면 안 된다 — 그 시점엔 서비스 유저가 아직 없다(신규 설치에서 조용히 no-op)");

// ④ ③ 의 전제를 사실로 고정한다: install.sh 에서 ensure_host_memory_safety 는 os_install_service 보다 **앞**이다.
//    (이 순서가 뒤집히면 ③ 의 근거가 바뀌므로, 그때 이 테스트가 깨져 사람이 다시 판단하게 된다.)
{
  const lines = install.split(/\r?\n/);
  const idx = (re) => {
    const i = lines.findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));
    assert.ok(i >= 0, `install.sh 에서 못 찾음: ${re}`);
    return i;
  };
  assert.ok(idx(/^\s*ensure_host_memory_safety\b/) < idx(/^\s*os_install_service\b/),
    "install.sh 는 ensure_host_memory_safety 를 os_install_service 앞에서 부른다 — 그래서 거기에 저널 권한을 두면 안 된다");
}

// ⑤ 대상 유저는 인자로 받는다(함수가 SERVICE_USER 를 스스로 추측하면 같은 부류의 버그가 재발한다).
assert.ok(/ensure_journal_read_access\(\)\s*\{[\s\S]{0,200}?local svc_user="\$\{1:/.test(common),
  "ensure_journal_read_access 는 서비스 유저를 인자로 받아야 한다(전역 추측 금지)");
assert.ok(hasCmd(renderBody, /ensure_journal_read_access "\$svc_user"/),
  "render_service_unit 이 자신이 계산한 svc_user 를 그대로 넘겨야 한다(유닛 User= 와 같은 값)");

console.log("journal-access-order.test OK — 저널 권한 부여는 서비스 유저 확정 후·기동 전(render_service_unit)에서만 (#1240 가드)");
