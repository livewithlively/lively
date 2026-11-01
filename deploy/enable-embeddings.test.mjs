// 임베딩 켜기 (#5232, deploy/enable-embeddings.sh) — 가짜 docker·sudo·node 로 실제 셸을 돌려 부작용으로 단언한다(네트워크·root·DB 없음).
//  계기: 백필이 0건으로 실패했는데 스크립트는 «임베딩 활성화 완료» 와 종료코드 0 으로 끝났다.
//  표(사양 E·F):
//   E1 백필 성공 → 0 · 완료 표시
//   E2·E3 백필 실패(1 · 2) → 0 이 아니다 · 완료 표시 없음 · 재시도 명령 · 설정은 켜진 채
//   E4 모델 pull 실패 → 0 이 아니다 · .env 그대로 · 재시작 없음 · 백필 없음
//   E5 순서 — 서버 기동 → 모델 pull → .env → 재시작 → 백필 (pull 이 백그라운드면 처음 켜는 박스의 백필이 늘 실패한다)
//   E6 --external — compose 를 안 부른다
//   E7 백필에 시간 상한이 실린다 (문서 수천 건 박스에서 하루를 붙들지 않는다)
//   F1 compose 의 ollama 이미지 — 두 줄이 같은 숫자 판
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const t = (name, fn) => { if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return; fn(); pass++; console.log(`ok  ${name}`); };

const ENV_BEFORE = "PORT=18999\nEMBEDDINGS_PROVIDER=off\nEMBEDDINGS_MODEL=bge-m3\n";

function sandbox({ upRc = 0, pullRc = 0, backfillRc = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "enable-emb-"));
  const fake = join(root, "fake");
  mkdirSync(join(root, "deploy", "lib"), { recursive: true });
  mkdirSync(fake);
  //  스크립트는 자기 자리에서 APP_DIR 을 정한다 — 시험 자리에 복사해 돌려야 진짜 .env 를 안 건드린다.
  copyFileSync(join(here, "enable-embeddings.sh"), join(root, "deploy", "enable-embeddings.sh"));
  copyFileSync(join(here, "lib", "common.sh"), join(root, "deploy", "lib", "common.sh"));
  const envFile = join(root, ".env");
  writeFileSync(envFile, ENV_BEFORE);
  const log = join(root, "calls.log");
  const stub = (name, body) => { writeFileSync(join(fake, name), `#!/bin/sh\n${body}\n`); chmodSync(join(fake, name), 0o755); };
  stub("docker", `[ "$1" = info ] && exit 0
echo "docker $*" >> "${log}"
case "$*" in
  *" run --rm embeddings-init"*) echo "그때 .env: $(grep '^EMBEDDINGS_PROVIDER=' "${envFile}")" >> "${log}"; exit ${pullRc} ;;
  *" up -d"*) exit ${upRc} ;;
esac`);
  stub("sudo", `exec "$@"`);
  stub("systemctl", `echo "systemctl $*" >> "${log}"`);
  stub("curl", `exit 0`);
  stub("node", `echo "node $*" >> "${log}"; exit ${backfillRc}`);
  stub("uname", `echo Linux`);
  //  BSD sed 의 -i 는 인자 꼴이 달라 맥에서 set_env 가 죽는다 — 둘 다 받는 꼴로 넘긴다.
  stub("sed", `if [ "$1" = "-i" ]; then shift; exec /usr/bin/sed -i.bak "$@"; fi
exec /usr/bin/sed "$@"`);
  const run = (args = [], env = {}) => spawnSync("bash", [join(root, "deploy", "enable-embeddings.sh"), ...args], {
    env: { PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, FORCE: "1", ...env }, encoding: "utf8", cwd: root,
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { run, calls, env: () => readFileSync(envFile, "utf8"), done: () => rmSync(root, { recursive: true, force: true }) };
}

const DONE = "임베딩 활성화 완료";
const idx = (calls, needle) => {
  const i = calls.findIndex((c) => c.includes(needle));
  assert.ok(i >= 0, `호출에 없다: ${needle}\n${calls.join("\n")}`);
  return i;
};

t("E1 백필 성공 — 0 · 완료 표시 · 설정 반영", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(DONE), r.stderr);
  assert.match(s.env(), /^EMBEDDINGS_PROVIDER=http$/m);
  assert.equal(s.calls().filter((c) => c.startsWith("node ")).length, 1, "배선 — 백필을 정확히 한 번 불렀다");
  s.done();
});

for (const [row, backfillRc] of [["E2", 1], ["E3", 2]]) {
  t(`★ ${row} 백필이 ${backfillRc} 로 실패 — 완료라고 말하지 않고 0 으로 끝나지 않는다`, () => {
    const s = sandbox({ backfillRc });
    const r = s.run();
    assert.notEqual(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(DONE), r.stderr);
    assert.match(r.stderr, /scripts\/backfill-embeddings\.mjs/, "재시도 명령을 안내한다");
    assert.match(s.env(), /^EMBEDDINGS_PROVIDER=http$/m, "설정은 켜진 채로 남는다 — 게이트웨이가 다시 시도한다");
    assert.ok(s.calls().some((c) => c.startsWith("node ")), "배선 — 백필까지 갔다");
    s.done();
  });
}

t("★ E4 모델 pull 실패 — .env 를 안 쓰고 재시작도 백필도 안 한다", () => {
  const s = sandbox({ pullRc: 1 });
  const r = s.run();
  assert.notEqual(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(DONE), r.stderr);
  assert.equal(s.env(), ENV_BEFORE);
  const calls = s.calls();
  assert.ok(calls.some((c) => c.includes("embeddings-init")), `배선 — pull 까지 갔다\n${calls.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("systemctl")), "재시작 없음");
  assert.ok(!calls.some((c) => c.startsWith("node ")), "백필 없음");
  s.done();
});

t("★ E5 순서 — 서버 기동 → 모델 pull(.env 는 아직 off) → 재시작 → 백필", () => {
  const s = sandbox();
  assert.equal(s.run().status, 0);
  const calls = s.calls();
  const up = idx(calls, "--profile embeddings up -d embeddings");
  const pull = idx(calls, "--profile embeddings run --rm embeddings-init");
  const restart = idx(calls, "systemctl restart lively-gateway");
  const backfill = idx(calls, "scripts/backfill-embeddings.mjs");
  assert.ok(up < pull && pull < restart && restart < backfill, calls.join("\n"));
  assert.ok(calls.includes("그때 .env: EMBEDDINGS_PROVIDER=off"), `모델이 준비된 뒤에 켠다\n${calls.join("\n")}`);
  assert.ok(!calls.some((c) => /\bup -d\s*$/.test(c)), "프로필 전체 up 은 pull 을 백그라운드로 돌린다");
  s.done();
});

t("E6 --external — compose 를 안 부르고 설정을 쓴 뒤 백필한다", () => {
  const s = sandbox();
  const r = s.run(["--external"], { EMBEDDINGS_BASE_URL: "https://embed.test", EMBEDDINGS_MODEL: "m1", EMBEDDINGS_AUTH_ENV: "KEY_NAME" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!s.calls().some((c) => c.startsWith("docker ")), s.calls().join("\n"));
  assert.match(s.env(), /^EMBEDDINGS_BASE_URL=https:\/\/embed\.test$/m);
  assert.match(s.env(), /^EMBEDDINGS_AUTH_ENV=KEY_NAME$/m);
  assert.ok(s.calls().some((c) => c.startsWith("node ")), "배선 — 백필을 불렀다");
  s.done();
});

t("★ E7 백필에 시간 상한이 실린다", () => {
  const s = sandbox();
  assert.equal(s.run().status, 0);
  const line = s.calls().find((c) => c.startsWith("node "));
  assert.match(line, /--max-seconds=[1-9]\d*(\s|$)/, line);
  s.done();
});

t("★ F1 compose 의 ollama 이미지 — 두 줄이 같은 숫자 판", () => {
  const compose = readFileSync(join(here, "..", "docker-compose.yml"), "utf8");
  const images = [...compose.matchAll(/^\s*image:\s*(ollama\/ollama\S*)\s*$/gm)].map((m) => m[1]);
  assert.equal(images.length, 2, `ollama 이미지 줄: ${images}`);
  assert.equal(new Set(images).size, 1, `두 줄의 판이 다르다: ${images}`);
  assert.match(images[0], /^ollama\/ollama:\d+\.\d+\.\d+$/, images[0]);
});

if (pass === 0) { console.error("✗ 돈 행이 없다 — ONLY 를 확인하세요"); process.exit(1); }
console.log(`✓ enable-embeddings — ${pass}행`);
