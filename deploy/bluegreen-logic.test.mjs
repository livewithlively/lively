// Blue-green 무중단 배포 — 순수 결정 로직 + 배선 회귀 가드.
//
//  왜 이 테스트인가: blue-green 의 정확성은 **flip 방향과 롤백 안전**에 달려 있는데, 그 결정(active→idle,
//  healthz→flip/rollback, color→port·unit)이 틀리면 박스에서만, 그것도 배포 순간에만 드러난다(idle 대신
//  active 를 갈아엎으면 곧바로 다운타임, healthz 실패인데 flip 하면 죽은 릴리스로 트래픽). 그래서 실제
//  systemd/caddy/네트워크 없이 **순수 함수를 bash 로 직접 실행**해 결정을 락하고, 부작용 있는 절차(기동·flip·
//  drain·흡수)는 스크립트 텍스트의 배선을 정적으로 검증한다.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, "lib", "bluegreen.sh");
const DEPLOY = path.join(here, "deploy-release.sh");
const MIGRATE = path.join(here, "migrate-to-bluegreen.sh");
const COMMON = path.join(here, "lib", "common.sh");
const UNIT = path.join(here, "linux", "lively-gateway@.service");
const UPDATE = path.join(here, "update.sh");

// bluegreen.sh 를 source 한 뒤 스크립트 조각을 실행 — 순수함수만 부르므로 부작용 없음.
//  {stdout, status} 반환(stderr 는 진단이라 버림). env 로 BLUE_PORT/LEGACY_BLUE_UNIT 등 주입.
function sh(snippet, env = {}) {
  try {
    const out = execFileSync("bash", ["-c", `source ${JSON.stringify(LIB)}; ${snippet}`], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { stdout: out.replace(/\n$/, ""), status: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").toString().replace(/\n$/, ""), status: e.status ?? 1 };
  }
}

// migrate-to-bluegreen.sh 의 순수 함수 실행기 — 소스 가드(BASH_SOURCE!=$0)로 main 은 안 돌고 함수만 정의된다.
//  common.sh·bluegreen.sh 를 함께 source 하지만 그 top-level 은 부작용 없음(변수·함수 정의뿐).
function shm(snippet, env = {}) {
  try {
    const out = execFileSync("bash", ["-c", `source ${JSON.stringify(MIGRATE)}; ${snippet}`], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { stdout: out.replace(/\n$/, ""), status: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").toString().replace(/\n$/, ""), status: e.status ?? 1 };
  }
}

// common.sh 의 순수(검증) 경로 실행기 — render_loopback_forwarder 의 die 가드(비정수·인자누락)만 친다.
//  common.sh top-level 은 부작용 없음(변수·함수 정의뿐). die 는 첫 sudo 앞이라 실행해도 부작용 없음.
function shc(snippet, env = {}) {
  try {
    const out = execFileSync("bash", ["-c", `source ${JSON.stringify(COMMON)}; ${snippet}`], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { stdout: out.replace(/\n$/, ""), status: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").toString().replace(/\n$/, ""), status: e.status ?? 1 };
  }
}

// 배선 단언 — 엉뚱한 파일을 읽고 조용히 통과하지 않게 먼저 못 박는다(vacuous 방지).
const lib = readFileSync(LIB, "utf8");
const deploy = readFileSync(DEPLOY, "utf8");
const migrate = readFileSync(MIGRATE, "utf8");
const common = readFileSync(COMMON, "utf8");
const unit = readFileSync(UNIT, "utf8");
const update = readFileSync(UPDATE, "utf8");
for (const [name, src, fn] of [
  ["bluegreen.sh", lib, "bg_idle_color"],
  ["deploy-release.sh", deploy, "alb_wait_healthy"],
  ["migrate-to-bluegreen.sh", migrate, "migrate_one"],
  ["common.sh", common, "render_bluegreen_unit"],
]) {
  assert.ok(new RegExp(`${fn}\\(\\)`).test(src), `${name} 에서 ${fn} 정의를 못 찾았다(테스트가 대상을 잃음)`);
}

// ── A. active/idle color 선택 ──────────────────────────────────────────────
{
  // idle = active 의 반대. active 없으면(fresh) blue — 첫 릴리스는 blue 에 얹는다.
  assert.equal(sh("bg_idle_color blue").stdout, "green", "active=blue → idle=green");
  assert.equal(sh("bg_idle_color green").stdout, "blue", "active=green → idle=blue");
  assert.equal(sh("bg_idle_color ''").stdout, "blue", "active 없음(fresh) → idle=blue");
  assert.equal(sh("bg_idle_color garbage").stdout, "blue", "손상 active → idle=blue(안전 기본)");
}

// ── active 상태 파일 판독(화이트리스트) ─────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "bg-active-"));
  try {
    const f = path.join(dir, "active-color");
    writeFileSync(f, "green\n");
    assert.equal(sh(`bg_read_active ${JSON.stringify(f)}`).stdout, "green", "공백/개행 트림");
    writeFileSync(f, "  blue  ");
    assert.equal(sh(`bg_read_active ${JSON.stringify(f)}`).stdout, "blue", "앞뒤 공백 트림");
    writeFileSync(f, "purple");
    assert.equal(sh(`bg_read_active ${JSON.stringify(f)}`).stdout, "", "화이트리스트 밖 → 빈값(fresh 강등)");
    assert.equal(sh(`bg_read_active ${JSON.stringify(path.join(dir, "nope"))}`).stdout, "", "파일 없음 → 빈값");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── B. flip 결정(healthz 성공/실패) ─────────────────────────────────────────
{
  assert.equal(sh("bg_flip_decision 0").stdout, "flip", "health rc=0 → flip");
  assert.equal(sh("bg_flip_decision 1").stdout, "abort", "health rc!=0 → abort(no-flip, old 계속 서빙)");
  assert.equal(sh("bg_flip_decision 7").stdout, "abort", "curl 실패 rc → abort");
  assert.equal(sh("bg_flip_decision abc").stdout, "abort", "비정수 → abort(안전측)");
  assert.equal(sh("bg_flip_decision").stdout, "abort", "인자 없음 → abort(안전측)");
  // ⚠ 반환값은 'abort'(=no-flip)여야 한다 — 'rollback' 이 아니다(이 함수는 실제로 아무것도 되돌리지 않는다).
  assert.equal(sh("bg_flip_decision 1").stdout !== "rollback", true, "정직한 네이밍: rollback 아님(실제 롤백 동작 없음)");
}

// ── C. 포트 매핑(env 오버라이드 가능, upstream-generic) ─────────────────────
{
  assert.equal(sh("bg_port blue").stdout, "8081", "blue 기본 8081 (8080 은 loopback alias 전용, flip pool 제외)");
  assert.equal(sh("bg_port green").stdout, "8082", "green 기본 8082");
  assert.equal(sh("bg_port blue", { BLUE_PORT: "9090" }).stdout, "9090", "BLUE_PORT 오버라이드");
  assert.equal(sh("bg_port green", { GREEN_PORT: "9091" }).stdout, "9091", "GREEN_PORT 오버라이드");
  assert.equal(sh("bg_port purple").status, 2, "알 수 없는 color → rc 2(조기 차단)");
}

// ── D. color 유효성 ────────────────────────────────────────────────────────
{
  assert.equal(sh("bg_valid_color blue && echo ok").stdout, "ok");
  assert.equal(sh("bg_valid_color green && echo ok").stdout, "ok");
  assert.equal(sh("bg_valid_color foo || echo bad").stdout, "bad");
}

// ── E. color → systemd 유닛(구 단일유닛 흡수 매핑) ──────────────────────────
{
  assert.equal(sh("bg_unit_for blue").stdout, "lively-gateway@blue", "기본 blue = 템플릿 인스턴스");
  assert.equal(sh("bg_unit_for green").stdout, "lively-gateway@green", "기본 green = 템플릿 인스턴스");
  // 최초 흡수: LEGACY_BLUE_UNIT 이 있으면 blue 만 구 유닛명으로(그 flip 의 old 정지 대상).
  assert.equal(
    sh("bg_unit_for blue", { LEGACY_BLUE_UNIT: "lively-gateway" }).stdout,
    "lively-gateway",
    "LEGACY_BLUE_UNIT 설정 시 blue → 구 유닛명",
  );
  assert.equal(
    sh("bg_unit_for green", { LEGACY_BLUE_UNIT: "lively-gateway" }).stdout,
    "lively-gateway@green",
    "green 은 LEGACY 영향 없음",
  );
}

// ── F. caddy flip primitive 폐기 — bg_caddy_upstream_line 제거(ALB 포트 스왑으로 rework) ──
{
  // 순수 caddy 스니펫 헬퍼는 더 이상 존재하지 않는다(flip 은 ALB register/deregister-targets 로 이동).
  assert.equal(sh("type bg_caddy_upstream_line 2>/dev/null; echo done").stdout.trim(), "done", "bg_caddy_upstream_line 정의 제거됨");
  assert.ok(!/bg_caddy_upstream_line/.test(lib), "bluegreen.sh 에 bg_caddy_upstream_line 잔존 금지");
}

// ── G. 인자 파싱(순수 — eval 계약) ──────────────────────────────────────────
{
  // tg-arn 은 필수 — parse 헬퍼는 env LIVELY_TG_ARN 을 주입해 그 검증을 통과시키고, 나머지 필드를 확인한다.
  const parse = (args, env = {}) =>
    sh(
      `eval "$(bg_parse_args ${args})"; echo "$RELEASE_DIR|$LIVELY_ROOT|$HEALTH_PATH|$HEALTH_RETRIES|$DRAIN_SECONDS|$KEEP_OLD|$TG_ARN|$INSTANCE_ID|$ALB_HEALTH_TIMEOUT"`,
      { LIVELY_TG_ARN: "arn:test-tg", ...env },
    );
  // 기본 로컬 health-path 는 readiness(/readyz) — liveness(/healthz) 아님(ALB 넣기 전 자가 게이트는 readiness).
  //  ALB 필드 기본: TG_ARN=env(arn:test-tg) · INSTANCE_ID 빈값(본체가 IMDS 해석) · ALB_HEALTH_TIMEOUT=180.
  assert.equal(parse("--release /r").stdout, "/r|/opt/lively|/readyz|60|5|0|arn:test-tg||180", "기본값(health-path=/readyz, tg=env, timeout=180)");
  assert.equal(parse("--release /r", { LIVELY_ROOT: "/srv/lively" }).stdout, "/r|/srv/lively|/readyz|60|5|0|arn:test-tg||180", "LIVELY_ROOT env 기본");
  assert.equal(parse("--release /r --health-path /healthz").stdout, "/r|/opt/lively|/healthz|60|5|0|arn:test-tg||180", "--health-path 로 liveness 오버라이드 가능");
  assert.equal(
    parse("--release /r --lively-root /x --health-path /hz --health-retries 3 --drain-seconds 9 --keep-old --tg-arn arn:z --instance-id i-abc --alb-health-timeout 90").stdout,
    "/r|/x|/hz|3|9|1|arn:z|i-abc|90",
    "전체 인자 — --tg-arn(인자 우선) · --instance-id · --alb-health-timeout 포함",
  );
  // 실패 케이스 — rc!=0.
  assert.equal(sh("bg_parse_args", { LIVELY_TG_ARN: "arn:x" }).status, 2, "--release 누락 → rc 2");
  assert.equal(sh("bg_parse_args --release /r", { LIVELY_TG_ARN: "" }).status, 2, "--tg-arn·LIVELY_TG_ARN 둘 다 없음 → rc 2");
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:x --bogus").status, 2, "알 수 없는 인자 → rc 2");
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:x --health-retries abc").status, 2, "비정수 retries → rc 2");
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:x --alb-health-timeout abc").status, 2, "비정수 alb-health-timeout → rc 2");

  // 다중 TG — ALB 가 여럿이면(각자 전용 TG) flip 대상도 여럿이다.
  //  ⚠ 첫 --tg-arn 은 env 를 **대체**한다(종전 계약 유지). 그 뒤 반복만 누적 — 아니면 CI env 가 인자에 딸려붙는다.
  assert.equal(parse("--release /r --tg-arn arn:a --tg-arn arn:b").stdout, "/r|/opt/lively|/readyz|60|5|0|arn:a,arn:b||180",
    "--tg-arn 반복 → 콤마 결합(첫 지정이 env 대체, 이후 누적)");
  assert.equal(parse("--release /r --tg-arn arn:a,arn:b").stdout, "/r|/opt/lively|/readyz|60|5|0|arn:a,arn:b||180",
    "콤마 구분 1회 지정도 같은 결과");
  assert.equal(parse("--release /r", { LIVELY_TG_ARN: "arn:a,arn:b" }).stdout, "/r|/opt/lively|/readyz|60|5|0|arn:a,arn:b||180",
    "env LIVELY_TG_ARN 도 콤마 다중 가능(CI 변수 하나로 두 ALB)");
  // 빈 항목은 소비처 루프가 조용히 건너뛰어 **일부 ALB 미flip 을 성공 보고**할 수 있어 파싱에서 끊는다.
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:a,,arn:b").status, 2, "--tg-arn 빈 항목(,,) → rc 2");
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:a,").status, 2, "--tg-arn 후행 콤마 → rc 2");
  // 중복은 두 번째 deregister 가 실패해 flip 이 die 로 멈춘다 → 파싱에서 끊는다.
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:a --tg-arn arn:a").status, 2, "--tg-arn 중복 → rc 2");
  // 공백 패딩은 ARN 에 있을 수 없다 — 다운스트림 aws 실패로도 잡히지만(원복·die) 여기서 끊어 에러를 이르게.
  assert.equal(sh('bg_parse_args --release /r --tg-arn "arn:a, arn:b"').status, 2, "--tg-arn 항목 공백 패딩 → rc 2");
}

// ── H. deploy-release.sh 배선(부작용 절차 — 롤백 안전 불변식) ───────────────
{
  assert.ok(/set -euo pipefail/.test(deploy), "set -euo pipefail 필수(중간 실패 시 진행 금지)");
  assert.ok(/source .*lib\/common\.sh/.test(deploy) && /source .*lib\/bluegreen\.sh/.test(deploy), "두 lib 를 source");

  // ⭐ 롤백 안전(로컬 게이트): 로컬 healthz 실패면 ALB 를 아예 만지지 않고 idle 정리 후 die → old 계속 서빙.
  //  bg_flip_decision 이 flip 이 아니면 ALB register(flip 시작) 앞에서 죽어야 한다. (상세 ALB 배선은 아래 ALB 블록.)
  const iDecision = deploy.indexOf("bg_flip_decision");
  //  ⚠ 다중 TG 화로 `aws elbv2 register-targets` 리터럴은 파일 상단 헬퍼 **정의**에도 있다(첫 등장이 main 이 아니다).
  //   flip 시작점은 main 안의 호출부이므로 그걸 앵커로 쓴다 — 리터럴을 쓰면 슬라이스가 뒤집혀 단언이 무력화된다.
  const iRegister = deploy.indexOf('alb_register_targets "$TG_ARN"'); // ALB flip 시작점(main 안 첫 ALB mutate)
  assert.ok(iDecision > 0 && iRegister > 0 && iDecision < iRegister, "로컬 healthz 게이트가 ALB register 보다 앞서야 한다");
  const rollbackBlock = deploy.slice(iDecision, iRegister);
  assert.ok(/!= flip/.test(rollbackBlock), "flip 이 아니면 분기하는 가드가 있어야 한다");
  assert.ok(/systemctl stop "lively-gateway@\$idle"/.test(rollbackBlock), "로컬 healthz 실패 시 실패한 idle 을 정지해야 한다");
  assert.ok(/\bdie\b/.test(rollbackBlock), "로컬 healthz 실패 시 die(배포 중단)");
  //  헬퍼 경유 호출도 ALB mutate 다 — 리터럴만 막으면 alb_*_targets 로 우회한 회귀를 놓친다.
  assert.ok(!/aws elbv2|alb_register_targets|alb_deregister_targets/.test(rollbackBlock),
    "로컬 healthz 실패 경로는 ALB 를 만지지 않는다(register 앞에서 die)");

  // ⭐ 흡수 코드는 배포 스크립트에서 통째로 제거됐다(데이터파괴 클래스 분리) — negative-assert.
  assert.ok(!/migrate_from_single/.test(deploy), "deploy-release 에 흡수 함수(migrate_from_single) 잔존 금지 — migrate 로 분리");
  // 레거시 유닛명 하드코딩 '스캔' 제거(설명 주석은 허용, 실행 코드만 금지) — 전부 migrate 로 이관.
  assert.ok(!/for u in lively-gateway context-ontology-gateway/.test(deploy), "레거시 유닛 for-스캔 제거");
  assert.ok(!/--value context-ontology-gateway/.test(deploy), "context-ontology-gateway User/WorkingDirectory 조회 제거");
  assert.ok(!/mv "\$old_app/.test(deploy), "흡수용 mv(old_app→shared) 잔존 금지");

  // ⭐ 레이아웃(active-color)이 없으면 die — 조용히 레이아웃을 만들지 않고 migrate 로 안내.
  //  non-blocking#2: 부재(미흡수 → migrate 안내)와 손상(화이트리스트 밖 값 → 수기 복구 안내, migrate 는 재흡수 거부)을
  //  파일 존재 여부(-e)로 갈라 각기 다른 die 로 안내해야 한다(핑퐁 방지).
  const iActiveRead = deploy.indexOf('bg_read_active "$root/active-color"');
  assert.ok(iActiveRead > 0, "active-color 를 bg_read_active 로 읽어 전제 확인");
  const iIdleCalc0 = deploy.indexOf('idle="$(bg_idle_color');
  const preludeBlock = deploy.slice(iActiveRead, iIdleCalc0);
  assert.ok(/\[ -z "\$active" \][\s\S]*\bdie\b/.test(preludeBlock), "active 빈값이면(부재/손상) die");
  // 부재 분기: 파일이 없으면(-e 실패) migrate 로 안내.
  assert.ok(/\[ ! -e "\$root\/active-color" \][\s\S]*migrate-to-bluegreen/.test(preludeBlock), "부재(파일 없음) → migrate-to-bluegreen.sh 안내");
  // 손상 분기: 파일은 있으나 값 이상 → 수기 복구 안내(migrate 자동 안내 아님).
  const iCorruptElse = preludeBlock.indexOf("else");
  assert.ok(iCorruptElse > 0, "부재/손상 분기(else)가 존재");
  const corruptBlock = preludeBlock.slice(iCorruptElse);
  assert.ok(/손상|수기 복구|blue\|green|blue 또는 green/.test(corruptBlock), "손상 분기는 수기 복구(blue|green) 안내");
  assert.ok(!/migrate-to-bluegreen/.test(corruptBlock), "손상 분기는 migrate 로 안내하지 않는다(재흡수 거부 → 핑퐁 방지)");

  // 릴리스 준비 전제 확인(dist/index.js) + 릴리스 안 공유상태 심볼릭.
  assert.ok(/dist\/index\.js/.test(deploy), "릴리스 준비 전제(dist/index.js) 확인");
  assert.ok(/ln -sfn "\$root\/shared\/\$p" "\$rel\/\$p"/.test(deploy), "릴리스 안 공유상태 심볼릭(shared/$p, 배포마다 보존)");

  // idle 에 기동(active 를 건드리지 않는다) — 무중단의 핵심.
  assert.ok(/systemctl restart "lively-gateway@\$idle"/.test(deploy), "idle color 를 기동(active 아님)");
}

// ── H2. blocking#1 심볼릭 정규화(pwd -P) ────────────────────────────────────
//  logical pwd 면 롤백(--release "$root/previous")이 심볼릭을 남겨 blue→previous→불량릴리스 체인 → 재기동 시 부활.
{
  assert.ok(
    /RELEASE_DIR="\$\(cd "\$RELEASE_DIR" && pwd -P\)"/.test(deploy) || /readlink -f "\$RELEASE_DIR"/.test(deploy),
    "RELEASE_DIR 을 실경로로 정규화(pwd -P 또는 readlink -f) — 심볼릭 aliasing 차단",
  );
  assert.ok(!/RELEASE_DIR="\$\(cd "\$RELEASE_DIR" && pwd\)"/.test(deploy), "logical pwd(심볼릭 미해소) 잔존 금지");
}

// ── H3. LEGACY_BLUE_UNIT 은 marker 파일에서(스캔 아님) + idle 포트 선점 검사 ──
{
  // ⭐ deploy-release 는 레거시 유닛명을 스캔하지 않는다 — migrate 가 남긴 marker(legacy-blue-unit) 한 줄만 읽는다.
  const iLegacy = deploy.indexOf('LEGACY_BLUE_UNIT="$(cat "$root/legacy-blue-unit"');
  const iIdleCalc = deploy.indexOf('idle="$(bg_idle_color');
  assert.ok(iLegacy > 0, "LEGACY_BLUE_UNIT 은 marker 파일(legacy-blue-unit)에서 읽는다");
  assert.ok(iIdleCalc > iLegacy, "LEGACY_BLUE_UNIT 확정이 idle 계산보다 앞");
  assert.ok(!/LEGACY_BLUE_UNIT="\$\(migrate_from_single/.test(deploy), "구 방식(migrate_from_single 스캔) 잔존 금지");
  // idle 기동 전에 포트 선점 검사(false-positive flip 방어심층) — restart 앞에 와야 한다.
  const iPortCheck = deploy.indexOf("assert_idle_port_free");
  const iRestart = deploy.indexOf('systemctl restart "lively-gateway@$idle"');
  assert.ok(iPortCheck > 0 && iRestart > 0 && iPortCheck < iRestart, "idle 포트 선점 검사가 기동보다 앞");
  assert.ok(/systemctl is-active --quiet "\$idle_unit"/.test(deploy), "이미 뜬 idle 은 우리 것 → 통과(재점유 아님)");
}

// ── H4. SERVICE_USER — 활성 템플릿유닛 User → LIVELY_SERVICE_USER env → die(id -un 폴백 금지) ──
{
  const idxTemplate = deploy.indexOf('systemctl show -p User --value "lively-gateway@$active"'); // 1순위 = 활성 템플릿유닛 User
  const idxEnv = deploy.indexOf('SERVICE_USER="${LIVELY_SERVICE_USER:-}"');                       // 2순위 = env
  assert.ok(idxTemplate > 0, "SERVICE_USER 1순위 = 활성 템플릿유닛(lively-gateway@$active) User");
  assert.ok(idxEnv > idxTemplate, "SERVICE_USER 2순위 = LIVELY_SERVICE_USER env(템플릿 뒤)");
  // ⭐ 그것도 없으면 die — 실행자(id -un)로 조용히 폴백하지 않는다(게이트웨이 유저 root 드리프트 #4 방지).
  const svcBlock = deploy.slice(idxTemplate, deploy.indexOf("export SERVICE_USER"));
  assert.ok(/\[ -n "\$SERVICE_USER" \][\s\S]*\bdie\b/.test(svcBlock), "SERVICE_USER 미확정이면 die(폴백 아님)");
  assert.ok(!/SERVICE_USER="\$\(id -un\)"/.test(deploy), "id -un 폴백 금지 — silent 실행자 드리프트 차단");
}

// ── H5. ⭐ ALB flip 배선(caddy reload → ALB 타깃 포트 스왑 rework) — 롤백 안전 불변식 ──
//  왜 이 락인가: flip primitive 를 ALB register/deregister-targets 로 바꿨다. 정확성은 **순서**에 달려 있다 —
//   idle 을 register 하고 ALB HC 로 healthy 확인한 **뒤에만** 구 포트를 deregister 해야 겹침 구간(무중단)이 생긴다.
//   순서가 뒤집히면(구 포트를 먼저 빼면) 다운타임, healthy 확인을 건너뛰면 죽은 릴리스로 트래픽. 정적 배선으로 잠근다.
{
  // caddy flip 잔재 제거 — negative-assert.
  assert.ok(!/caddy_apply/.test(deploy), "caddy_apply 잔존 금지(ALB flip 으로 대체)");
  assert.ok(!/ensure_caddy_service/.test(deploy), "ensure_caddy_service 잔존 금지");
  assert.ok(!/systemctl (reload|restart|enable) caddy/.test(deploy), "caddy systemd 조작 잔존 금지");
  assert.ok(!/caddy validate/.test(deploy), "caddy validate 잔존 금지");
  assert.ok(!/reverse_proxy/.test(deploy), "caddy reverse_proxy 스니펫 잔존 금지");
  // require_cmd aws(caddy 아님).
  assert.ok(/require_cmd aws/.test(deploy), "require_cmd aws(elbv2 호출)");
  assert.ok(!/require_cmd caddy/.test(deploy), "require_cmd caddy 제거");

  // flip 3-스텝 앵커(모두 호출부의 `if ! ` 프리픽스로 앵커 — 함수 정의·rollback deregister(|| warn)와 구분).
  //  구 포트 deregister 만 `if ! ` 가드라 register/idle-rollback deregister 와 유일 구분된다.
  const iRegister = deploy.indexOf("if ! alb_register_targets");
  const iHealthPoll = deploy.indexOf("if ! alb_wait_healthy");
  const iDeregOld = deploy.indexOf("if ! alb_deregister_targets"); // 구 포트 deregister(유일한 if-가드 deregister)
  const iStateCommit = deploy.indexOf('tee "$root/active-color"', iDeregOld); // 실제 커밋(die 메시지·주석의 'active-color' 아님)
  assert.ok(iRegister > 0, "ALB register-targets(idle 포트) 호출 존재");
  assert.ok(iHealthPoll > iRegister, "health poll(alb_wait_healthy)이 register 뒤");
  assert.ok(iDeregOld > iHealthPoll, "구 포트 deregister 는 health poll(=healthy 확인) 뒤 — 무중단 겹침 보장");
  assert.ok(iStateCommit > iDeregOld, "active-color 커밋은 구 포트 deregister **뒤**(불변식)");
  // register 는 구 포트 deregister 앞(핵심 불변식 — 먼저 빼면 다운타임).
  assert.ok(iRegister < iDeregOld, "ALB register(+healthy)가 deregister(구 포트)보다 먼저");
  // 구 포트 deregister 는 active_port(구 포트)를 대상으로 한다(idle 포트 아님).
  assert.ok(/if ! alb_deregister_targets "\$TG_ARN" "\$INSTANCE_ID" "\$active_port"/.test(deploy), "구 포트 deregister 대상은 active_port");

  // 롤백 분기들.
  // (a) register 실패 → idle 정지 + die(old 계속 서빙). register 호출부 ~ health poll 사이.
  const registerBlock = deploy.slice(iRegister, iHealthPoll);
  assert.ok(/if ! alb_register_targets/.test(registerBlock), "register 는 실패 시 분기(if !)");
  assert.ok(/systemctl stop "lively-gateway@\$idle"/.test(registerBlock) && /\bdie\b/.test(registerBlock), "register 실패 시 idle 정지 + die");
  // (b) ALB healthy 미달 → idle 등록 취소(deregister idle) + idle 정지 + die(구 유닛 유지). health poll ~ 구 포트 deregister 사이.
  const unhealthyBlock = deploy.slice(iHealthPoll, iDeregOld);
  assert.ok(/if ! alb_wait_healthy/.test(unhealthyBlock), "ALB unhealthy 는 분기(if ! alb_wait_healthy)");
  assert.ok(/alb_deregister_targets "\$TG_ARN" "\$INSTANCE_ID" "\$idle_port"/.test(unhealthyBlock), "ALB unhealthy 롤백은 idle 포트를 등록 취소(원복) — TG 전부에");
  assert.ok(/systemctl stop "lively-gateway@\$idle"/.test(unhealthyBlock) && /\bdie\b/.test(unhealthyBlock), "ALB unhealthy 시 idle 정지 + die");
  // (c) 구 포트 deregister 실패 → die(idle·old 둘 다 등록 = 무중단, active-color 미커밋). idle 은 끄지 않는다(서빙 중).
  const deregBlock = deploy.slice(iDeregOld, iStateCommit);
  assert.ok(/if ! alb_deregister_targets/.test(deregBlock), "구 포트 deregister 는 실패 시 분기");
  assert.ok(/\bdie\b/.test(deregBlock), "구 포트 deregister 실패 시 die(active-color 미커밋)");
  assert.ok(!/systemctl stop "lively-gateway@\$idle"/.test(deregBlock), "구 포트 deregister 실패 경로는 idle 을 끄지 않는다(healthy·서빙 중)");
}

// ── H5b. ⭐ 5차 재게이트(실 prod 게이트웨이 컷오버 안전 강화) — non-blocking 4건 ──
//  왜 이 락인가: ①HC 드리프트가 이 스킴의 유일한 무증상 전면 outage 모드라 register 전에 반드시 단언해야 하고,
//   ②실패경로가 idle 을 disable 안 하면 재부팅 시 양 color 동시기동(OOM 이력 박스 치명), ③BLUE==GREEN 오설정이면
//   deregister 가 방금 register 한 타깃을 도로 빼 flip 이 무효, ④keep-old 인데 sleep 하면 무의미한 지연이다.
{
  const iRegisterFlip = deploy.indexOf("if ! alb_register_targets");
  const iHealthPoll = deploy.indexOf("if ! alb_wait_healthy");
  const iDeregOld = deploy.indexOf("if ! alb_deregister_targets");
  const iDecision = deploy.indexOf("bg_flip_decision");
  //  ⚠ 종전엔 `aws elbv2 register-targets` 리터럴 첫 등장을 썼는데, 다중 TG 화로 그 리터럴이 파일 상단
  //   헬퍼 정의로 옮겨가 iDecision 보다 앞이 됐다(슬라이스가 빈 문자열이 되어 단언이 조용히 무력화된다).
  //   main 안의 첫 ALB mutate = register 호출이므로 그 자리를 직접 쓴다.
  const iRegisterAny = iRegisterFlip;

  // #1 HC=traffic-port preflight — register 보다 앞(배선 락). 호출은 `"$TG_ARN"` 인자형으로 정의(())와 구분.
  const iPreflightCall = deploy.indexOf('assert_tg_hc_traffic_port "$TG_ARN"');
  assert.ok(iPreflightCall > 0, "HC preflight(assert_tg_hc_traffic_port) 호출 존재");
  assert.ok(iPreflightCall < iRegisterFlip, "HC preflight 가 ALB register 보다 앞(flip 진입 전 단언)");
  // preflight 는 describe-target-groups 로 HealthCheckPort 를 읽어 traffic-port 아니면 die.
  const m1 = /assert_tg_hc_traffic_port\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(m1, "assert_tg_hc_traffic_port 본문");
  assert.ok(/describe-target-groups/.test(m1[0]) && /HealthCheckPort/.test(m1[0]), "preflight 는 describe-target-groups 로 HealthCheckPort 조회");
  assert.ok(/\[ "\$hc_port" = traffic-port \][\s\S]*?\bdie\b/.test(m1[0]), "HC 가 traffic-port 아니면 die(query-failed 도 fail-safe die)");
  // preflight 호출 자체는 ALB 를 mutate 하지 않는다(로컬 healthz 실패 경로가 이 함수 정의를 안 타므로 rollbackBlock 불변식 유지).
  assert.ok(!/aws elbv2/.test('assert_tg_hc_traffic_port "$TG_ARN"'), "preflight 호출부는 aws elbv2 리터럴을 포함하지 않는다(mutate 아님)");

  // #3 idle==active 포트 가드 — register 앞.
  const iPortGuard = deploy.indexOf('[ "$idle_port" != "$active_port" ]');
  assert.ok(iPortGuard > 0, "idle!=active 포트 가드 존재");
  assert.ok(iPortGuard < iRegisterFlip, "idle!=active 가드가 ALB register 보다 앞");
  assert.ok(/\[ "\$idle_port" != "\$active_port" \][\s\S]*?\bdie\b/.test(deploy), "idle==active 면 die(BLUE==GREEN 오설정)");

  // #2 실패경로 idle disable — 세 실패분기(로컬 healthz·register·ALB unhealthy) 모두 stop 옆 disable.
  const localFailBlock = deploy.slice(iDecision, iRegisterAny);       // ① 로컬 healthz 실패(ALB 미변경)
  const registerFailBlock = deploy.slice(iRegisterFlip, iHealthPoll); // ② register 실패
  const unhealthyBlock = deploy.slice(iHealthPoll, iDeregOld);        // ③ ALB healthy 미달
  for (const [name, blk] of [["로컬 healthz", localFailBlock], ["register 실패", registerFailBlock], ["ALB unhealthy", unhealthyBlock]]) {
    assert.ok(/systemctl stop "lively-gateway@\$idle"/.test(blk), `${name} 실패경로에 idle stop`);
    assert.ok(/systemctl disable "lively-gateway@\$idle"/.test(blk), `${name} 실패경로에 idle disable(재부팅 양 color 동시기동 방지)`);
  }
  // 구 포트 deregister 실패 경로는 idle 을 끄지도 disable 하지도 않는다(healthy·서빙 중) — 회귀 가드.
  const iStateCommit = deploy.indexOf('tee "$root/active-color"', iDeregOld);
  const deregBlock = deploy.slice(iDeregOld, iStateCommit);
  assert.ok(!/systemctl (stop|disable) "lively-gateway@\$idle"/.test(deregBlock), "구 포트 deregister 실패 경로는 idle stop/disable 안 함(서빙 중)");

  // #4 sleep(drain 유예)은 non-keep-old(else) 분기 안에서만 — keep-old 는 sleep 하지 않는다.
  const iPhase4 = deploy.indexOf("4/4 old");
  const phase4 = deploy.slice(iPhase4);
  const iKeepOldIf = phase4.indexOf('if [ "$KEEP_OLD" = 1 ]');
  const iElse = phase4.indexOf("else", iKeepOldIf);
  const iSleep = phase4.indexOf('sleep "$DRAIN_SECONDS"');
  assert.ok(iKeepOldIf > 0 && iElse > iKeepOldIf && iSleep > 0, "phase4 keep-old 분기 + sleep 존재");
  assert.ok(iSleep > iElse, "sleep 은 else(non-keep-old, old stop) 분기 안 — keep-old 밖");
  assert.ok(!/sleep "\$DRAIN_SECONDS"/.test(phase4.slice(iKeepOldIf, iElse)), "keep-old(then) 분기에는 sleep 없음");
  // sleep 은 old stop 직전(drain 유예) — 같은 else 안에서 stop 보다 앞.
  const iOldStop = phase4.indexOf('systemctl stop "$old_unit"', iElse);
  assert.ok(iOldStop > iSleep, "sleep(drain 유예)이 old stop 보다 앞(같은 non-keep-old 분기)");

  // #5 다중 TG flip — ALB TG 는 로드밸런서 1대에만 붙는 하드 리밋(TargetGroupAssociationLimit)이라 ALB 가
  //  여럿이면 TG 도 여럿이다. flip 이 그 전부에 반영돼야 하고, **부분 적용이 성공으로 보고되면 안 된다**.
  const mSplit = /tg_split\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(mSplit, "tg_split 정의 존재(콤마 구분 TG 리스트 분해)");
  assert.ok(/set -f/.test(mSplit[0]) && /set \+f/.test(mSplit[0]), "tg_split 은 분해 중 glob 확장을 끈다(pathname expansion 차단)");
  assert.ok(/\[ -n "\$item" \]/.test(mSplit[0]), "tg_split 은 빈 항목을 흘리지 않는다");

  const mReg = /alb_register_targets\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(mReg, "alb_register_targets 정의 존재");
  assert.ok(/tg_split/.test(mReg[0]), "register 는 TG 리스트 전부를 순회");
  // 부분 등록 롤백 — healthy 확인 전에 어떤 ALB 도 idle 로 트래픽을 보내지 않는다는 불변식.
  assert.ok(/done_tgs/.test(mReg[0]) && /deregister-targets/.test(mReg[0]) && /return 1/.test(mReg[0]),
    "register 하나라도 실패하면 그 실행에서 등록한 TG 들을 되돌리고 rc 1(부분 등록 금지)");

  const mDereg = /alb_deregister_targets\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(mDereg, "alb_deregister_targets 정의 존재");
  assert.ok(/tg_split/.test(mDereg[0]) && /rc=1/.test(mDereg[0]),
    "deregister 는 TG 전부에 적용하고 하나라도 실패하면 rc 1(호출부가 die 판단)");

  const mWait = /alb_wait_healthy\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(mWait, "alb_wait_healthy 정의 존재");
  assert.ok(/tg_split/.test(mWait[0]) && /pending/.test(mWait[0]) && /still/.test(mWait[0]),
    "healthy 폴링은 미달 TG 만 라운드로빈으로 재확인(TG 수만큼 타임아웃이 곱해지지 않게)");
  assert.ok(/\$\{#still\[@\]\}" -eq 0 \] && return 0/.test(mWait[0]),
    "모든 TG 가 healthy 일 때만 rc 0(하나라도 미달이면 계속 대기 → 타임아웃 시 rc 1)");

  // preflight 도 전 TG 에 적용돼야 한다 — 한 TG 만 검사하면 다른 ALB 의 HC 드리프트가 그대로 통과한다.
  assert.ok(/tg_split/.test(m1[0]), "HC preflight 도 TG 리스트 전부를 순회");

  // #6 다중 TG 고유 edge — healthy 미달 롤백은 idle 을 끄기 전에 drain 유예를 준다. TG 가 여럿이면 먼저
  //  healthy 가 된 ALB 가 타임아웃까지 idle 로 트래픽을 보내고 있었을 수 있어(단일 TG 엔 없던 경로),
  //  유예 없이 stop 하면 그 커넥션이 절단된다.
  const iRollbackDereg = deploy.indexOf('alb_deregister_targets "$TG_ARN" "$INSTANCE_ID" "$idle_port"');
  const iRollbackStop = deploy.indexOf('systemctl stop "lively-gateway@$idle"', iRollbackDereg);
  const iRollbackSleep = deploy.indexOf('sleep "$DRAIN_SECONDS"', iRollbackDereg);
  assert.ok(iRollbackDereg > 0 && iRollbackSleep > 0 && iRollbackStop > 0, "healthy 미달 롤백 블록에 dereg·sleep·stop 존재");
  assert.ok(iRollbackSleep > iRollbackDereg && iRollbackSleep < iRollbackStop,
    "롤백 drain 유예는 idle 등록취소 뒤 · idle stop 앞");
}

// ═══ migrate-to-bluegreen.sh — 1회성 흡수 스크립트 ═══════════════════════════

// ── M1. 순수 이동전략 결정(bash 실행) — 같은 FS=mv(원자), 판정불가/다름=copy(안전측) ──
{
  const dir = mkdtempSync(path.join(tmpdir(), "bg-migrate-"));
  try {
    const a = path.join(dir, "sub1"); const b = path.join(dir, "sub2");
    execFileSync("mkdir", ["-p", a, b]);
    // 같은 tmpdir 하위 = 같은 FS → mv.
    assert.equal(shm(`migrate_move_strategy ${JSON.stringify(a)} ${JSON.stringify(b)}`).stdout, "mv", "같은 FS → mv(원자적 rename)");
    assert.equal(shm(`same_filesystem ${JSON.stringify(dir)} ${JSON.stringify(a)} && echo same`).stdout, "same", "같은 FS 판정");
    // 존재하지 않는 dst = stat 실패 → 안전측 copy(cross-FS 로 취급).
    assert.equal(shm(`migrate_move_strategy ${JSON.stringify(a)} "/no/such/path/xyz"`).stdout, "copy", "판정불가 → copy(안전측)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── M1b. stat 이식(GNU -c / BSD -f) — 이 테스트가 도는 **개발자 머신에서 실제로** FS 판정이 성립해야 한다 ──
//  migrate 본체는 Linux 전용이지만 순수 함수는 npm test 로 어디서나 돈다(deploy/**/*.test.mjs 자동 수집).
//  GNU 문법만 쓰면 macOS 에서 stat 이 통째로 실패 → same_filesystem 이 늘 '다름' → 위 M1 의 mv 단언이 깨진다
//  (실측: 이 PR 원안이 맥에서 `'copy' !== 'mv'` 로 red). stat_fmt 가 그 갭을 한 자리에서 흡수한다.
{
  const dir = mkdtempSync(path.join(tmpdir(), "bg-statfmt-"));
  try {
    const f = path.join(dir, "sized");
    writeFileSync(f, "0123456789");                                    // 정확히 10 바이트
    // 표 #14 — 존재하는 경로의 디바이스 번호: 이 플랫폼에서 rc 0 + 정수.
    const dev = shm(`stat_fmt dev ${JSON.stringify(dir)}`);
    assert.equal(dev.status, 0, "stat_fmt dev 는 이 플랫폼에서 성공해야 한다(폴백이 죽으면 여기서 잡힌다)");
    assert.ok(/^-?[0-9]+$/.test(dev.stdout), `stat_fmt dev 는 정수를 낸다(got: ${JSON.stringify(dev.stdout)})`);
    // 표 #15 — 파일 크기: 실제 바이트 수와 일치(포맷 키가 뒤바뀌면 여기서 잡힌다).
    const size = shm(`stat_fmt size ${JSON.stringify(f)}`);
    assert.equal(size.status, 0, "stat_fmt size 성공");
    assert.equal(size.stdout, "10", "stat_fmt size 는 실제 바이트 수");
    // 표 #16 — 없는 경로: 판정 불가를 성공으로 위장하지 않는다.
    assert.notEqual(shm(`stat_fmt dev "/no/such/path/xyz"`).status, 0, "없는 경로 → rc≠0(안전측 판단은 호출부 몫)");
    // 표 #17 — 알 수 없는 키: 오타를 조용히 흘리지 않는다.
    assert.equal(shm(`stat_fmt bogus ${JSON.stringify(dir)}`).status, 2, "알 수 없는 키 → rc 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 표 #18(배선) — 위 M1 의 `같은 FS → mv` 가 곧 이 폴백의 end-to-end 확인이다. 이식 책임이 한 자리
  //  (stat_fmt)에 모여 있는지도 못 박는다: 호출부가 stat 을 직접 부르기 시작하면 폴백이 다시 새어 나간다.
  const body = (name, src) => {
    const m = new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m").exec(src);
    assert.ok(m, `${name} 본문을 찾지 못했다(테스트가 대상을 잃음)`);
    return m[0];
  };
  assert.ok(/stat_fmt\(\)/.test(migrate), "stat_fmt 이식 래퍼 정의");
  const sfBody = body("same_filesystem", migrate);
  assert.ok(/stat_fmt dev/.test(sfBody), "same_filesystem 은 stat_fmt 를 통해 디바이스 번호를 얻는다");
  assert.ok(!/\bstat -[cf] /.test(sfBody), "same_filesystem 이 stat 을 직접 부르지 않는다(이식은 stat_fmt 한 자리)");
  // verify_copy 는 sudo 가 필요해 stat_fmt 를 못 쓴다 — 대신 그 자리에서 두 문법을 모두 시도해야 한다.
  const vcBody = body("verify_copy", migrate);
  assert.ok(/stat -c %s/.test(vcBody) && /stat -f %z/.test(vcBody), "verify_copy 의 크기 대조는 GNU·BSD 양쪽 문법을 시도한다");
}

// ── M1c. 구 단일유닛의 실서빙 포트 실측(detect_legacy_port) — 8080 가정 금지 ─────
//  최초 flip 의 ALB deregister 대상이 이 값이다. 틀리면 구 포트가 TG 에 남고 구 유닛이 죽어 **사망 타깃**이
//  트래픽을 받는다(무증상 5xx — assert_tg_hc_traffic_port 가 막는 것과 같은 silent-outage 클래스).
//  포트의 유일한 출처는 old_app/.env 의 PORT 다(단일 유닛 템플릿에 PORT Environment/EnvironmentFile 없음).
{
  const dir = mkdtempSync(path.join(tmpdir(), "bg-legacyport-"));
  const env = (s) => writeFileSync(path.join(dir, ".env"), s);
  const port = () => shm(`detect_legacy_port ${JSON.stringify(dir)}`).stdout;
  try {
    assert.equal(port(), "8080", "#1 .env 부재 → 앱 기본값 8080(흡수를 막지 않는다)");
    env("FOO=1\nPORT=9443\nBAR=2\n");
    assert.equal(port(), "9443", "#2 .env 의 PORT 실측(다른 키와 섞여도)");
    env('  PORT = "9444"  \n');
    assert.equal(port(), "9444", "#3 공백·따옴표 트림");
    env("PORT=8081\nPORT=8099\n");
    assert.equal(port(), "8099", "#4 중복 정의는 마지막이 이긴다(dotenv 관례)");
    env("PORT=notanumber\n");
    assert.equal(port(), "8080", "#5 비정수는 신뢰 불가 → 기본값");
    env("ITEMS_DB_PORT=5432\n");
    assert.equal(port(), "8080", "#6 접미 일치(ITEMS_DB_PORT)에 낚이지 않는다");
    // ⚠ 위 줄은 '값이 정수가 아니게 되는' 경로로도 우연히 통과한다(mutation 실측: grep 앵커만 빼면 여전히 green —
    //  sed 앵커가 남아 'ITEMS_DB_PORT=5432' 를 통째로 흘려 비정수 폴백에 걸렸다). 값이 **정수로 보이는** 접미
    //  일치 키를 하나 더 둬, 앵커가 정말 살아 있는지를 우회 없이 친다.
    env("ITEMS_DB_PORT=5432\nADMIN_PORT=7777\n");
    assert.equal(port(), "8080", "#6 정수값을 가진 접미 일치 키(ADMIN_PORT)도 PORT 로 오인하지 않는다");
    env("PORT=\n");
    assert.equal(port(), "8080", "#7 빈 값 → 기본값");
    env("PORT=8080\n");
    assert.equal(port(), "8080", "#8 기본값과 같아도 실측 경로가 통과한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 구 포트가 flip pool(blue|green)과 겹치면 흡수 자체를 막는다 — 겹치면 첫 배포가 idle 을 그 포트에 띄우려다
  //  구 유닛과 충돌하고(선점 die), 최악은 idle==active 포트라 flip 이 무효가 된다. 흡수 뒤에 알면 되돌리기가 번거롭다.
  const iCollide = migrate.indexOf('[ "$legacy_port" = "$blue_port" ]');
  assert.ok(iCollide > 0, "구 포트 ↔ flip pool 충돌 검사 존재");
  assert.ok(/\[ "\$legacy_port" = "\$green_port" \]/.test(migrate), "green 포트와의 충돌도 본다");
  assert.ok(/\bdie\b/.test(migrate.slice(iCollide, iCollide + 500)), "충돌이면 die(흡수 중단)");
  // 그 검사는 어떤 부작용(백업·이동·seed)보다 먼저여야 한다 — dry-run 게이트 앞이면 계획 출력조차 안 나온다.
  assert.ok(iCollide < migrate.indexOf("tar -czf"), "충돌 검사는 백업(첫 부작용)보다 먼저");
}

// ── M1d. 실측 포트의 배선 — 흡수 시점의 값이 flip 시점까지 살아 실제 deregister 대상이 되는가 ──
{
  assert.ok(/tee "\$root\/legacy-blue-port"/.test(migrate), "#9 migrate 가 실측값을 legacy-blue-port marker 로 남긴다");
  assert.ok(/LEGACY_BLUE_PORT="\$\(cat "\$root\/legacy-blue-port"/.test(deploy), "#10 deploy-release 가 그 marker 를 읽는다");
  assert.ok(/active_port="\$LEGACY_BLUE_PORT"/.test(deploy), "#10 최초 flip 의 deregister 대상 = marker 포트");
  assert.ok(!/active_port=8080/.test(deploy), "#11 구 포트 8080 하드코딩 잔존 금지(회귀 가드)");
  assert.ok(
    /rm -f "\$root\/legacy-blue-unit" "\$root\/legacy-blue-port"/.test(deploy),
    "#12 흡수 종결 시 두 marker 를 함께 삭제(포트만 남으면 다음 판정이 어긋난다)",
  );
  // #13 marker 부재(이미 흡수를 끝낸 구 박스)면 8080 폴백 — 배포 불가로 만들지 않는다.
  const iPortRead = deploy.indexOf('LEGACY_BLUE_PORT="$(cat "$root/legacy-blue-port"');
  assert.ok(iPortRead > 0, "#13 marker 읽기 지점");
  assert.ok(
    /grep -qE '\^\[0-9\]\+\$' \|\| LEGACY_BLUE_PORT=8080/.test(deploy.slice(iPortRead, iPortRead + 400)),
    "#13 marker 부재·비정수면 8080 폴백(하위호환)",
  );
}

// ── M1e. legacy marker 값 검증(bg_valid_unit_name) — systemctl 대상이자 삭제 경로 조각이다 ──
//  `systemctl stop/disable <값>` + `rm -f /etc/systemd/system/<값>.service` 로 흐르므로, 손상·수기편집된
//  값(슬래시·공백·`..`)이 그대로 지나면 엉뚱한 유닛 정지나 systemd 디렉터리 밖 삭제가 된다.
{
  const valid = (v) => sh(`bg_valid_unit_name ${JSON.stringify(v)} && echo ok || echo no`).stdout;
  assert.equal(valid("lively-gateway"), "ok", "#19 정상 유닛명");
  assert.equal(valid("context-ontology-gateway"), "ok", "#20 또 다른 정상 레거시명");
  assert.equal(valid("lively-gateway@blue"), "ok", "템플릿 인스턴스명(@)도 유효");
  assert.equal(valid(""), "no", "#21 빈값은 유효하지 않다(호출부가 '부재'로 따로 다룬다)");
  assert.equal(valid("../../tmp/evil"), "no", "#22 경로 조각 탈출 거부(점 시작)");
  // ⚠ 위 한 줄만으로는 '점 시작' 가드에만 걸려 통과한다 — 슬래시 자체를 막는지 따로 봐야 한다(mutation 으로 실측:
  //  허용 문자셋에 `/` 를 끼워도 위 줄은 green 이었다). 점으로 시작하지 않는 경로 탈출로 그 자리를 정확히 친다.
  assert.equal(valid("lively/../../tmp/evil"), "no", "#22 슬래시가 든 값 거부(/etc/systemd/system/<값>.service 탈출)");
  assert.equal(valid("sub/unit"), "no", "#22 하위경로 모양 거부");
  assert.equal(valid("a b"), "no", "#23 공백 거부");
  assert.equal(valid("-x"), "no", "#24 하이픈 시작 거부(옵션 모양)");
  assert.equal(valid(".hidden"), "no", "점 시작 거부(상대경로 모양)");
  assert.equal(valid("evil;reboot"), "no", "구분자·메타문자 거부");
  // 배선 — deploy-release 는 marker 를 export/사용하기 **전에** 이 함수로 검증하고, 위반이면 die.
  const iRead = deploy.indexOf('LEGACY_BLUE_UNIT="$(cat "$root/legacy-blue-unit"');
  const iExport = deploy.indexOf("export LEGACY_BLUE_UNIT", iRead);
  assert.ok(iRead > 0 && iExport > iRead, "marker 읽기 → export 사이가 검증 자리");
  const guard = deploy.slice(iRead, iExport);
  assert.ok(/bg_valid_unit_name "\$LEGACY_BLUE_UNIT"/.test(guard), "#21~24 marker 를 bg_valid_unit_name 으로 검증");
  assert.ok(/\bdie\b/.test(guard), "위반이면 die(엉뚱한 유닛 정지·systemd 밖 삭제 방지)");
  // 빈값(흡수 안 한 박스)은 정상이므로 검증 대상이 아니다 — die 로 막으면 대다수 박스가 배포 불가가 된다.
  assert.ok(/\[ -n "\$LEGACY_BLUE_UNIT" \]/.test(guard), "#21 값이 있을 때만 검증(부재는 정상 경로)");
}

// ── M2. --confirm 게이트 — 없으면 dry-run(부작용 0), 있을 때만 실제 변경. 안티-vacuous 순서 락. ──
{
  assert.ok(/set -euo pipefail/.test(migrate), "set -euo pipefail 필수");
  assert.ok(/--confirm/.test(migrate), "--confirm 인자 존재");
  // dry-run(--confirm 미부여) 종료가 어떤 mutation 보다 앞서야 한다(부작용 0 보장).
  const iConfirmGate = migrate.indexOf('if [ "$CONFIRM" != 1 ]');
  const iReturn = migrate.indexOf("return 0", iConfirmGate);
  assert.ok(iConfirmGate > 0 && iReturn > iConfirmGate, "dry-run 게이트(CONFIRM!=1 → return)");
  const iTar = migrate.indexOf("tar -czf");
  const iActiveWrite = migrate.indexOf('tee "$root/active-color"');
  const iMoveLoop = migrate.indexOf("migrate_one");
  assert.ok(iReturn < iTar, "백업(tar) 은 dry-run 게이트 뒤에서만(부작용)");
  assert.ok(iReturn < iActiveWrite, "active-color 쓰기는 dry-run 게이트 뒤에서만");
  assert.ok(iReturn < migrate.indexOf("for p in .env data", iConfirmGate), "데이터 이동은 dry-run 게이트 뒤에서만");
}

// ── M3. 백업 먼저(가장 중요) — 어떤 이동보다 앞서, 실패면 die(이동 안 함) ────
{
  const iTar = migrate.indexOf("tar -czf");
  const iVerify = migrate.indexOf("tar -tzf");                 // 백업 검증
  const iMoveLoop = migrate.indexOf("for p in .env data");     // 데이터 이동 루프
  const iActiveWrite = migrate.indexOf('tee "$root/active-color"');
  assert.ok(iTar > 0 && iMoveLoop > 0 && iTar < iMoveLoop, "백업(tar)이 데이터 이동보다 앞");
  assert.ok(iVerify > iTar && iVerify < iMoveLoop, "백업 검증(tar -tzf)이 이동보다 앞");
  assert.ok(iTar < iActiveWrite, "백업이 상태 seed(active-color)보다 앞");
  // 백업 실패면 die(이동 안 함).
  const backupBlock = migrate.slice(iTar, iMoveLoop);
  assert.ok(/tar -czf[\s\S]*\|\|\s*die/.test(backupBlock), "백업 생성 실패 시 die");
  assert.ok(/tar -tzf[\s\S]*\|\|\s*die/.test(backupBlock), "백업 검증 실패 시 die");
  assert.ok(/pre-bluegreen-\$\{TS\}\.tar\.gz/.test(migrate), "백업 파일명 = backups/pre-bluegreen-<ts>.tar.gz");
}

// ── M4. 전제검사 — 구 단일유닛 존재 & active-color 부재(재흡수 거부) ──────────
{
  assert.ok(/lively-gateway context-ontology-gateway/.test(migrate), "구 단일유닛 두 이름 탐지(레거시명은 여기에만)");
  const iLegacyReq = migrate.indexOf('[ -n "$legacy" ]');
  assert.ok(iLegacyReq > 0 && /\bdie\b/.test(migrate.slice(iLegacyReq, iLegacyReq + 200)), "구 유닛 없으면 die(흡수 대상 없음)");
  // active-color 존재 = 이미 흡수 → die(멱등·재흡수 거부).
  const iReMigrate = migrate.indexOf('[ ! -e "$root/active-color" ]');
  assert.ok(iReMigrate > 0 && /\bdie\b/.test(migrate.slice(iReMigrate, iReMigrate + 200)), "active-color 있으면 die(재흡수 거부)");
  // WorkingDirectory 확인.
  assert.ok(/systemctl show -p WorkingDirectory --value "\$legacy"/.test(migrate), "구 유닛 WorkingDirectory(old_app) 확인");
}

// ── M5. migrate_one — cross-FS 안전(mv|copy 분기) + 자기참조 안전 + old_app 심볼릭 재배선 ──
{
  const m = /migrate_one\(\)\s*\{[\s\S]*?\n\}/.exec(migrate);
  assert.ok(m, "migrate_one 본문");
  const body = m[0];
  // same_filesystem 로 분기: 같은 FS=mv(원자), 다르면 cp -a→verify_copy→rm.
  assert.ok(/same_filesystem "\$old_app" "\$shared"/.test(body), "same_filesystem 으로 cross-FS 분기");
  assert.ok(/mv "\$src" "\$dst"/.test(body), "같은 FS → mv(원자, 권한·소유 보존)");
  assert.ok(/cp -a "\$src" "\$dst"/.test(body), "다른 FS → cp -a(보존)");
  const iCp = body.indexOf('cp -a "$src" "$dst"');
  const iVerify = body.indexOf("verify_copy", iCp);
  const iRm = body.indexOf('rm -rf "$src"', iVerify);
  assert.ok(iCp > 0 && iVerify > iCp && iRm > iVerify, "cross-FS: cp → verify_copy → 원본 rm 순서");
  assert.ok(/verify_copy "\$src" "\$dst" \|\| die/.test(body), "복사 검증 실패면 die(원본 유지)");
  // old_app 쪽 shared 로의 심볼릭 — 구 유닛이 old_app 경로(8080)에서 계속 본다.
  assert.ok(/ln -sfn "\$dst" "\$src"/.test(body), "old_app/<item> → shared/<item> 심볼릭(구 유닛 8080 서빙 지속)");
  // 자기참조 안전: src 실경로 == dst 실경로면 손대지 않고 skip(원본 파괴 방지).
  assert.ok(/readlink -f "\$src"[\s\S]*readlink -f "\$dst"/.test(body), "src/dst 실경로 대조(자기참조 감지)");
  const iSelf = body.indexOf('[ "$rsrc" = "$rdst" ]');
  assert.ok(iSelf > 0 && /return 0/.test(body.slice(iSelf, iSelf + 120)), "자기참조면 재배선 생략(return)");

  // ⭐ blocking(4차 재게이트): 재실행 분기(dst 존재·비자기참조)에서 src 가 실체(비심볼릭)면 rm 전에 verify_copy 선행.
  //  cross-FS cp -a 가 중간사망(디스크풀·재부팅)하면 dst=부분복사본·src=원본이 남는데, 검증 없이 원본을 지우면
  //  게이트웨이가 부분 data 로 조용히 서빙한다. 그래서 '이미 존재' 분기에서 실체 src 는 verify → 일치할 때만 rm,
  //  불일치면 die(부분복사본을 믿고 원본 파괴 금지). 심볼릭 src(정상완료 재실행)는 대조 없이 skip.
  const iAlreadyWarn = body.indexOf("이동 생략, old_app 심볼릭만 보장");   // 재실행(dst 존재·비자기참조) 분기 진입점
  assert.ok(iAlreadyWarn > 0, "재실행(dst 이미 존재) 분기 존재");
  const rerunBlock = body.slice(iAlreadyWarn);
  // 실체 src 가드 뒤에서만 rm — verify_copy 가 그 rm 보다 앞서야 한다.
  assert.ok(/\[ ! -L "\$src" \] && \[ -e "\$src" \]/.test(rerunBlock), "재실행 분기: src 가 실체(비심볼릭·존재)일 때만 대조·rm");
  const iVerifyR = rerunBlock.indexOf("verify_copy");
  const iRmR = rerunBlock.indexOf('rm -rf "$src"', iVerifyR);
  assert.ok(iVerifyR > 0 && iRmR > iVerifyR, "재실행 분기: verify_copy 가 원본 rm 보다 앞(부분복사본 검증)");
  // die 는 반드시 verify_copy 와 rm '사이'여야 한다 — 함수 전체를 보면 하단 cross-FS 분기의 die 로 false-pass 하므로 구간을 좁혀 잠근다.
  assert.ok(/\bdie\b/.test(rerunBlock.slice(iVerifyR, iRmR)), "재실행 분기: verify_copy 와 원본 rm 사이에 die(불일치면 원본 유지)");
  // 심볼릭 src(정상완료 재실행)는 대조를 건너뛴다 — 실체 가드가 [ ! -L "$src" ] 라 심볼릭이면 verify 를 안 탄다.
  const iLinkR = rerunBlock.indexOf('ln -sfn "$dst" "$src"');
  assert.ok(iLinkR > iRmR, "재실행 분기: 대조·rm 뒤 old_app 심볼릭 재배선");
}

// ── M6. blue seed + 템플릿 유닛 렌더 + 레거시 marker + flip/정지 안 함 ────────
{
  assert.ok(/tee "\$root\/active-color"/.test(migrate), "active-color=blue seed");
  assert.ok(/printf 'blue'/.test(migrate), "active seed 값 = blue");
  assert.ok(/ln -sfn "\$old_app" "\$root\/blue"/.test(migrate), "blue → old_app(구 릴리스 채택)");
  assert.ok(/PORT=%s[\s\S]*tee "\$root\/color-env\/blue\.env"/.test(migrate), "color-env/blue.env PORT seed");
  assert.ok(/bg_port blue/.test(migrate), "blue PORT 는 bg_port(기본 8081·BLUE_PORT 오버라이드)");
  assert.ok(/render_bluegreen_unit/.test(migrate), "템플릿 유닛(@.service) 렌더(SERVICE_USER 읽을 수 있게)");
  assert.ok(/tee "\$root\/legacy-blue-unit"/.test(migrate), "레거시 유닛명을 marker(legacy-blue-unit)로 인계");
  // ⭐ flip 안 함·구 유닛 정지 안 함 — migrate 는 caddy 를 만지지 않고 구 유닛을 stop/disable 하지 않는다.
  assert.ok(!/reverse_proxy/.test(migrate) && !/systemctl reload caddy/.test(migrate), "migrate 는 caddy flip 안 함");
  assert.ok(!/systemctl stop/.test(migrate) && !/systemctl disable/.test(migrate), "migrate 는 구 유닛 stop/disable 안 함");
  // 런북: 백업 위치·다음 명령·롤백법.
  assert.ok(/deploy-release\.sh --release/.test(migrate), "런북: 다음 명령(deploy-release --release)");
  assert.ok(/tar -xzf/.test(migrate), "런북: 롤백(백업 복원 tar -xzf)");
}

// ── H6. old color 는 stop 시 disable(재부팅 양 color 동시기동 방지) + stop 은 맨 마지막 ─────
{
  const iPhase4 = deploy.indexOf("4/4 old");
  const phase4 = deploy.slice(iPhase4);
  assert.ok(/systemctl disable "\$old_unit"/.test(phase4), "old_unit stop 시 disable(재부팅 양 color 동시기동 방지)");
  // ⭐ 불변식: 구 유닛 stop(phase 4/4)은 active-color 커밋(phase 3) 뒤 — 정지가 맨 마지막.
  const iActiveCommit = deploy.indexOf('tee "$root/active-color"');
  assert.ok(iActiveCommit > 0 && iPhase4 > iActiveCommit, "구 유닛 stop 은 active-color 커밋 뒤(맨 마지막)");
  assert.ok(/systemctl stop "\$old_unit"/.test(phase4), "phase 4/4 에서 old 유닛 stop");
}

// ── H7. link_shared_state 파괴 가드(rm 앞) + 자기참조 rm 가드(blocking#1 방어심층) ─
{
  const m = /link_shared_state\(\)\s*\{[\s\S]*?\n\}/.exec(deploy);
  assert.ok(m, "link_shared_state 본문");
  const body = m[0];
  const iGuard = body.indexOf('-f "$rel/dist/index.js"');       // 릴리스 디렉토리 가드(주석 아님)
  const iRm = body.indexOf('rm -rf "$rel/$p"');                 // 파라미터화된 실제 파괴 명령(loop 안)
  assert.ok(iGuard > 0 && iRm > 0 && iGuard < iRm, "sudo rm -rf 앞에 릴리스 디렉토리 가드(dist/index.js)");
  // 자기참조 rm 가드: rel/$p 실경로가 shared 원본과 같으면 rm/재링크를 skip(흡수→previous 롤백의 원본 파괴 방지).
  const iSelfRef = body.indexOf('readlink -f "$rel/$p"');
  assert.ok(iSelfRef > 0 && iSelfRef < iRm, "rm 전에 rel/$p 실경로 해석(자기참조 대조)");
  assert.ok(body.indexOf('readlink -f "$root/shared/$p"') > 0, "shared 원본 실경로도 해석해 대조");
  assert.ok(/\[ "\$relp" = "\$shp" \]/.test(body), "실경로 동일 판정으로 자기참조 감지");
  assert.ok(/continue/.test(body.slice(iSelfRef, iRm)), "자기참조면 rm/재링크 skip(continue)");
}

// ── H8. require_cmd node 가 command -v node 보다 앞(common.sh) ────────────────
{
  const iReq = common.indexOf("require_cmd node");
  const iCmd = common.indexOf('node_bin="$(command -v node)"');
  assert.ok(iReq > 0 && iCmd > 0 && iReq < iCmd, "require_cmd node 가 command -v node 앞(set -e 무언사 차단)");
}

// ── I. systemd 템플릿 유닛 ──────────────────────────────────────────────────
{
  assert.ok(/WorkingDirectory=@LIVELY_ROOT@\/%i/.test(unit), "WorkingDirectory 는 %i(color) 심볼릭");
  assert.ok(/EnvironmentFile=@LIVELY_ROOT@\/color-env\/%i\.env/.test(unit), "per-color EnvironmentFile(PORT)");
  assert.ok(/KillMode=process/.test(unit), "KillMode=process(tmux 세션 보존)");
  assert.ok(/--env-file-if-exists=\.env/.test(unit), "공유 .env 를 --env-file 로(PORT 는 env 가 이긴다)");
  assert.ok(/gateway-%i\.log/.test(unit), "per-color 로그");
}

// ── J. render_bluegreen_unit(common.sh) ─────────────────────────────────────
{
  const m = /render_bluegreen_unit\(\)\s*\{[\s\S]*?\n\}/.exec(common);
  assert.ok(m, "render_bluegreen_unit 본문을 찾지 못함");
  const body = m[0];
  assert.ok(/lively-gateway@\.service/.test(body), "템플릿 유닛 파일을 렌더");
  assert.ok(/systemctl daemon-reload/.test(body), "daemon-reload");
  assert.ok(/ensure_journal_read_access/.test(body), "저널 읽기 권한(단일 유닛과 동일)");
  assert.ok(/detect_os.*linux|linux.*전용/.test(body), "Linux 전용 가드");

  // ⭐ non-blocking(4차 재게이트): SERVICE_USER 미설정이면 die — id -un 폴백 금지(silent 실행자 드리프트 차단).
  //  '드리프트 금지' 불변식을 함수 자체에 박아 미래 호출자(export 안 하는)도 방어한다.
  assert.ok(!/svc_user="\$\{SERVICE_USER:-\$\(id -un\)\}"/.test(body), "render_bluegreen_unit: id -un 폴백 잔존 금지");
  // 가드는 주석이 아니라 실제 조건식에 앵커한다(주석의 'SERVICE_USER' 첫 히트로 앵커하면 가드를 부작용 뒤로 옮겨도 green).
  const iUserGuard = body.indexOf('[ -n "${SERVICE_USER:-}" ]');
  const iUserAssign = body.indexOf('svc_user="$SERVICE_USER"');
  const iFirstSideEffect = body.indexOf("sudo mkdir");
  assert.ok(/\[ -n "\$\{SERVICE_USER:-\}" \][\s\S]*?\bdie\b/.test(body), "SERVICE_USER 미설정이면 die(폴백 아님)");
  assert.ok(iUserGuard > 0 && iUserAssign > iUserGuard, "die 가드가 svc_user 할당보다 앞");
  assert.ok(iFirstSideEffect < 0 || iUserGuard < iFirstSideEffect, "die 가드가 첫 부작용(sudo mkdir)보다 앞");
}

// ── J2. render_loopback_forwarder(common.sh) — 잘못된 active_port 는 부작용 전에 die ──────────
{
  // detect_os 를 linux 로 고정해 OS 가드가 아니라 '정수 검증 die' 를 실제로 친다(호스트 독립 — Mac 러너에서도 동일).
  const guard = "detect_os() { echo linux; };";
  assert.equal(shc(`${guard} render_loopback_forwarder abc`).status !== 0, true, "비정수 active_port → die");
  assert.equal(shc(`${guard} render_loopback_forwarder ''`).status !== 0, true, "빈 active_port → die");
  assert.equal(shc(`${guard} render_loopback_forwarder`).status !== 0, true, "active_port 인자 누락 → die");

  const m = /render_loopback_forwarder\(\)\s*\{[\s\S]*?\n\}/.exec(common);
  assert.ok(m, "render_loopback_forwarder 본문을 찾지 못함");
  const body = m[0];
  assert.ok(/detect_os.*linux|linux.*전용/.test(body), "Linux 전용 가드");
  assert.ok(/\^\[0-9\]\+\$/.test(body), "active_port 정수 검증(정규식 앵커)");
  assert.ok(/systemd-socket-proxyd/.test(body), "systemd-socket-proxyd 바이너리 탐지");
  assert.ok(/lively-loopback\.socket/.test(body) && /lively-loopback\.service/.test(body), "socket·service 유닛 렌더");
  assert.ok(/@ACTIVE_PORT@[\s\S]*@PROXYD_BIN@|@PROXYD_BIN@[\s\S]*@ACTIVE_PORT@/.test(body), "service 는 @ACTIVE_PORT@·@PROXYD_BIN@ sed 치환");
  assert.ok(/systemctl daemon-reload/.test(body), "daemon-reload");
  // render 규약: 파일 렌더만 — enable/start/restart 는 호출자(deploy-release). render_bluegreen_unit 과 동일.
  assert.ok(!/systemctl\s+(enable|start|restart)/.test(body), "render 는 enable/start/restart 안 함(호출자 담당)");
  // 🟡1 결정 락 — migrate 는 forwarder 를 '호출'하지 않는다(흡수 직후 :8080 은 구 유닛이 물어 socket bind 충돌).
  //  주석의 설명 언급(phase3(render_loopback_forwarder))은 허용 — 실제 호출(문 시작 라인)만 금지한다.
  assert.ok(!/^\s*render_loopback_forwarder\s/m.test(migrate), "migrate 는 loopback forwarder 를 호출하지 않는다(구 유닛이 :8080 서빙)");
}

// ── J3. deploy-release forwarder 재지정 배선 순서(불변식 락) ─────────────────────────────────
{
  // ① forwarder 재지정은 active-color 커밋 뒤 · phase4 old stop 앞(세션 핀이 새 active 를 가리키게, drain 전에).
  const iActiveCommit = deploy.indexOf('tee "$root/active-color"');
  const iForwarder = deploy.indexOf('render_loopback_forwarder "$idle_port"');
  const iPhase4 = deploy.indexOf('phase "4/4');
  assert.ok(iActiveCommit > 0 && iForwarder > 0 && iPhase4 > 0, "active-color 커밋·forwarder 재지정·phase4 앵커 존재");
  assert.ok(iForwarder > iActiveCommit, "forwarder 재지정은 active-color 커밋 뒤");
  assert.ok(iForwarder < iPhase4, "forwarder 재지정은 phase4(old stop) 앞");
  // restart 성공만으로 ok 찍지 않는다 — :8080 end-to-end 검증(curl, --max-time 10 으로 hang 방지) 통과 시만 ok.
  assert.ok(/curl -fsS --max-time 10 -o \/dev\/null "http:\/\/127\.0\.0\.1:8080\$\{HEALTH_PATH\}"/.test(deploy), "forwarder 재지정 후 :8080 end-to-end 검증(--max-time 10)");

  // ② legacy 흡수 최초 flip: 구 유닛의 **실측 포트**(marker) 오버라이드가 구 포트 deregister 앞에 온다.
  //  8080 상수가 아니다 — PORT 를 바꿔 설치한 박스에서 엉뚱한 포트를 빼면 구 포트가 TG 에 남아 사망 타깃이 된다(M1c/M1d).
  const iOverride = deploy.indexOf('&& active_port="$LEGACY_BLUE_PORT"');
  const iActivePortCalc = deploy.indexOf('active_port="$(bg_port "$active")"');
  const iDeregOld = deploy.indexOf('alb_deregister_targets "$TG_ARN" "$INSTANCE_ID" "$active_port"');
  assert.ok(iOverride > 0, "LEGACY_BLUE_UNIT 존재 시 active_port ← 실측 marker 포트 오버라이드 존재");
  assert.ok(iOverride > iActivePortCalc, "오버라이드는 active_port=bg_port(active) 산출 뒤");
  assert.ok(iDeregOld > 0 && iOverride < iDeregOld, "오버라이드는 구 포트 deregister 앞(실서빙 포트 대상)");
  // 🔴2 락 — 오버라이드에 active=blue guard(stale marker 시 green 을 구 포트로 오폭 방지). marker 의미론상 legacy=blue.
  assert.ok(
    /\[ -n "\$\{LEGACY_BLUE_UNIT:-\}" \] && \[ "\$active" = blue \] && active_port="\$LEGACY_BLUE_PORT"/.test(deploy),
    "오버라이드는 active=blue guard 로 stale marker 오폭 차단",
  );

  // ③ 🔴1 락 — legacy 분기의 forwarder 재시도가 구 단일유닛 stop 뒤(그때 :8080 이 비어 bind 성립, 암전 방지).
  const iOldStop = deploy.indexOf('stop "$old_unit"');
  const iLegacyRetry = deploy.indexOf('restart lively-loopback.socket lively-loopback.service');
  assert.ok(iOldStop > 0 && iLegacyRetry > 0, "old_unit stop·legacy forwarder 재시도 앵커 존재");
  assert.ok(iLegacyRetry > iOldStop, "legacy forwarder 재시도는 구 유닛 stop 뒤(:8080 해제 후 bind 성립)");
  assert.ok(iLegacyRetry > iForwarder, "legacy 재시도는 phase3 최초 재지정보다 뒤(phase4 인계)");
}

// ── K. --prime-only 폐기 — caddy 컷오버 준비 모드 제거(ALB 가 스위치라 prime 불요) ──
{
  // 파싱에 --prime-only 가 더 이상 없다(알 수 없는 인자로 rc 2). deploy 본체에도 PRIME_ONLY 분기 잔존 금지.
  assert.equal(sh("bg_parse_args --release /r --tg-arn arn:x --prime-only").status, 2, "--prime-only 는 제거됨 → 알 수 없는 인자(rc 2)");
  assert.ok(!/PRIME_ONLY/.test(deploy), "deploy-release 에 PRIME_ONLY 분기 잔존 금지");
  assert.ok(!/PRIME_ONLY/.test(lib), "bluegreen.sh 에 PRIME_ONLY 잔존 금지");
  assert.ok(!/prime-only/.test(deploy), "deploy-release 에 --prime-only 언급 잔존 금지");
}

// ── P. IMDS instance-id + 자격/region 처리 배선 ──────────────────────────────
{
  // INSTANCE_ID 미지정 시 IMDSv2(토큰 PUT → GET)로 해석하고, 못 읽으면 die.
  assert.ok(/imds_get meta-data\/instance-id/.test(deploy), "INSTANCE_ID 미지정 시 IMDS meta-data/instance-id 로 해석");
  assert.ok(/X-aws-ec2-metadata-token-ttl-seconds/.test(deploy) && /X-aws-ec2-metadata-token:/.test(deploy), "IMDSv2(토큰 PUT + 헤더 GET)");
  const iInstDie = deploy.indexOf("imds_get meta-data/instance-id");
  assert.ok(/\bdie\b/.test(deploy.slice(iInstDie, iInstDie + 260)), "IMDS instance-id 실패 시 die(--instance-id 안내)");
  // region 은 AWS_REGION/AWS_DEFAULT_REGION env 또는 IMDS placement/region.
  assert.ok(/AWS_REGION/.test(deploy) && /imds_get meta-data\/placement\/region/.test(deploy), "region: env 또는 IMDS placement/region");
  // INSTANCE_ID 확정이 ALB register 보다 앞(flip 전에 대상 확정).
  const iInst = deploy.indexOf('INSTANCE_ID="$(imds_get');
  const iReg = deploy.indexOf("if ! alb_register_targets");
  assert.ok(iInst > 0 && iReg > 0 && iInst < iReg, "INSTANCE_ID 확정이 ALB register 보다 앞");
}

// ── L. 새 .sh 문법 검증(bash -n) — 이 테스트가 곧 문법 게이트 ────────────────
for (const f of [DEPLOY, MIGRATE, LIB, COMMON, UPDATE]) {
  execFileSync("bash", ["-n", f]); // 실패하면 throw → 테스트 실패
}

// ── U. update.sh 는 blue-green 박스에서 스스로 물러난다 ──────────────────────
//  두 배포 모델이 한 박스에서 겹치면 조용히 망가진다: update.sh 가 단일 유닛을 되살려 포트를 두고 forwarder 와
//  다투고(EADDRINUSE 크래시루프), 정작 트래픽을 받는 active color 는 **구 릴리스로 남는다**(silent no-op).
//  그래서 레이아웃이 보이면 어떤 부작용보다 먼저 멈춰야 한다.
{
  const iGuard = update.indexOf("LIVELY_ALLOW_SINGLE_UPDATE");
  assert.ok(iGuard > 0, "update.sh 에 blue-green 감지 가드가 있다");
  // 두 신호의 OR — 상태파일(레이아웃)과 템플릿 유닛 파일(LIVELY_ROOT 를 모르는 채 흡수된 박스도 잡는다).
  assert.ok(/\[ -e "\$BG_ROOT\/active-color" \]/.test(update), "가드는 active-color 상태파일을 본다");
  assert.ok(/\[ -f "\/etc\/systemd\/system\/lively-gateway@\.service" \]/.test(update), "가드는 템플릿 유닛 파일도 본다");
  assert.ok(/BG_ROOT="\$\{LIVELY_ROOT:-\/opt\/lively\}"/.test(update), "레이아웃 루트는 LIVELY_ROOT(기본 /opt/lively)");
  // ⭐ 가드는 **부작용보다 앞**이어야 한다 — 시크릿 백필·빌드·유닛 렌더가 먼저 돌면 이미 박스를 만진 뒤다.
  //  ⚠ 앵커는 '실행되는 줄'로 잡는다 — 단순 indexOf 는 가드 자신의 설명 주석에 걸려 순서를 거꾸로 읽는다(실측).
  const codeIndex = (re) => {
    const m = new RegExp(`^(?![[:space:]]*#)\\s*(?!#)${re}`, "m").exec(update);
    return m ? m.index : -1;
  };
  for (const [label, re] of [
    ["시크릿 백필(ensure_env_secret)", "ensure_env_secret\\b"],
    ["빌드 단계", 'phase "1/3'],
    ["유닛 렌더(render_service_unit)", "render_service_unit\\b"],
  ]) {
    const i = codeIndex(re);
    assert.ok(i > 0, `${label} 실행 줄 앵커 존재`);
    assert.ok(iGuard < i, `가드는 ${label} 보다 먼저 — 부작용 전에 멈춘다`);
  }
  // 탈출구는 있어야 한다(단일 유닛으로 되돌린 박스) — 단, 기본값은 차단이다.
  assert.ok(/\$\{LIVELY_ALLOW_SINGLE_UPDATE:-0\} != "1"|"\$\{LIVELY_ALLOW_SINGLE_UPDATE:-0\}" != "1"/.test(update), "기본은 차단, 명시 env 로만 강행");
  assert.ok(/deploy-release\.sh/.test(update.slice(iGuard, iGuard + 1200)), "차단 메시지가 올바른 경로(deploy-release.sh)를 알린다");
}

console.log("bluegreen-logic.test: all passed");
