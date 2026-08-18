// 배포 신원(#1289 회귀 가드) — "지금 도는 게 몇 버전인가"를 밖에서 볼 수 있어야 한다.
//
// 계기: 게이트웨이가 롤백된 것 같은데 확인할 방법이 없어 **기능 지문을 grep 해 추측**했고, 그 과정에서
// 구 경로를 보고 틀린 결론까지 냈다(실행 경로는 blue/green 심링크였다). 두 릴리스가 유실됐는데 한참 뒤에 알았다.
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseBuildInfo, buildInfoPath, buildInfo } from "./build-info.js";

let pass = 0;
const t = (n: string, f: () => void): void => { f(); pass++; console.log(`ok  ${n}`); };

t("V1 정상 파일 → version·commit·built_at 을 그대로 낸다", () => {
  assert.deepEqual(parseBuildInfo({ version: "v0.1.303", commit: "abc123", built_at: "2026-08-04T01:00:00Z" }),
    { version: "v0.1.303", commit: "abc123", built_at: "2026-08-04T01:00:00Z" });
});

t("V2 파일 없음 → null 로 정직하게(거짓 값을 지어내지 않는다)", () => {
  assert.deepEqual(parseBuildInfo(null), { version: null, commit: null, built_at: null });
  assert.deepEqual(parseBuildInfo(undefined), { version: null, commit: null, built_at: null });
});

t("V3 깨진 입력 → V2 와 같게(fail-soft — 기동·응답이 안 죽는다)", () => {
  for (const bad of ["문자열", 42, [], true]) {
    assert.deepEqual(parseBuildInfo(bad), { version: null, commit: null, built_at: null });
  }
});

t("V6 문자열만 통과 — 알 수 없는 키·비문자열은 버린다(미인증 응답으로 나가는 값이다)", () => {
  const r = parseBuildInfo({ version: "v1", commit: 42, built_at: null, secret: "토큰", path: "/opt/x" }) as unknown as Record<string, unknown>;
  assert.equal(r.version, "v1");
  assert.equal(r.commit, null, "비문자열은 버린다");
  assert.equal(r.secret, undefined, "모르는 키는 응답에 새지 않는다");
  assert.equal(r.path, undefined);
  assert.equal(Object.keys(r).length, 3, "필드는 정확히 셋");
});

t("V6b 빈 문자열·공백은 null(값이 있는 척하지 않는다) + 길이 상한", () => {
  assert.equal(parseBuildInfo({ version: "   " }).version, null);
  assert.equal(parseBuildInfo({ version: "x".repeat(500) }).version!.length, 200);
});

// V5 — 이번 사고의 지형. cwd 가 아니라 **모듈 위치** 기준이어야 blue/green 심링크·다른 cwd 에서도 자기 번들을 읽는다.
t("V5 경로는 cwd 가 아니라 모듈 위치 기준 — 번들 루트(모듈의 한 단계 위)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bi-"));
  const dist = path.join(root, "dist"); mkdirSync(dist);
  const p = buildInfoPath(pathToFileURL(path.join(dist, "build-info.js")).href);
  assert.equal(path.resolve(p), path.resolve(path.join(root, "build-info.json")),
    "cwd 를 쓰면 blue/green 처럼 cwd 가 릴리스 디렉터리가 아닐 때 엉뚱한 파일을 읽거나 못 읽는다");
  // cwd 를 바꿔도 결과가 같아야 한다.
  const before = process.cwd();
  try { process.chdir(tmpdir()); assert.equal(buildInfoPath(pathToFileURL(path.join(dist, "build-info.js")).href), p); }
  finally { process.chdir(before); }
  writeFileSync(path.join(root, "build-info.json"), "{}");   // 파일을 실제로 만들어 경로가 유효함을 보인다
});

t("V4 반복 호출이 디스크를 다시 읽지 않는다(같은 객체를 돌려준다)", () => {
  assert.equal(buildInfo(), buildInfo(), "매 /readyz 요청마다 파일을 읽으면 안 된다");
});

t("V2b 이 레포에서 실행하면(번들 아님) 모른다고 답한다 — 죽지 않는다", () => {
  const b = buildInfo();
  assert.ok(b && typeof b === "object", "어떤 경우에도 객체를 돌려준다");
  assert.ok("version" in b && "commit" in b && "built_at" in b);
});

console.log(`build-info.test: ok (${pass})`);
