// 빌트인 앱이 **배포 번들에 실리는가** — 이 게이트가 없어 2026-08-31 까지 한 번도 안 실렸다.
//
//  ⚠ 왜 이 시험이 필요한가. `seedBuiltinApps` 는 `apps/builtin` 이 없으면 **조용히 빈손으로 돌아간다**
//   (그 자체는 옳다 — 빌트인 앱이 없는 배포도 있다). 그래서 «시더가 돌고 있다»와 «앱이 심겼다»가
//   갈리는데, 로그로는 구별이 안 된다. 실측(2026-08-31 프로덕션):
//     · 정비는 20분에 4번 돌았고 반환값은 {seeded:[],skipped:[],updated:[]}
//     · 이미지 안: `ls /app/apps/builtin` → No such file or directory
//     · 라이브 테넌트 8개 중 7개가 org_app=0 → ai-session 알림이 20분간 denied 6 / notified 0
//   즉 **총알이 이미지에 없는데 방아쇠만 고치고 있었다.**
//
//  ⓘ lvly-cloud 의 `tenant-image/build.sh` 는 자기 CORE_FILES 를 이 tar 목록과 **대조**한다
//   (다르면 빌드가 죽는다). 그래서 여기 한 곳만 잠그면 테넌트 이미지까지 전파된다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const RELEASE_YML = ".github/workflows/release.yml";
/** 시더가 읽는 경로(`src/apps/seed.ts` 의 `builtinAppsRoot`)와 **같은 문자열**이어야 한다. */
const BUILTIN_DIR = "apps/builtin";

/** release.yml 의 `tar -czf lively.tgz …` 에 나열된 토큰들. */
function tarTokens(): string[] {
  const text = readFileSync(RELEASE_YML, "utf8");
  const m = /tar -czf lively\.tgz\s*\\\n((?:\s+.*\\\n)*\s+.*)/.exec(text);
  assert.ok(m, "release.yml 에서 tar 목록을 못 찾았다 — 패키징 방식이 바뀌었으면 이 시험도 고쳐야 한다");
  return m![1].replace(/\\/g, " ").split(/\s+/).filter(Boolean);
}

test("[L1] 빌트인 앱 디렉터리가 배포 번들에 실린다", () => {
  assert.ok(tarTokens().includes(BUILTIN_DIR),
    `release.yml 의 tar 목록에 ${BUILTIN_DIR} 이 없다 — 시더는 조용히 빈손으로 돌고 아무도 못 알아챈다`);
});

test("[L2] 시더가 읽는 경로와 번들에 싣는 경로가 같은 문자열이다", () => {
  const seed = readFileSync("src/apps/seed.ts", "utf8");
  //  `path.resolve(<dist/apps>, "..", "..", "apps", "builtin")` 의 마지막 두 조각.
  assert.match(seed, /"apps",\s*"builtin"/,
    "seed.ts 의 경로 조립이 바뀌었다 — 번들에 싣는 경로도 함께 바뀌어야 한다");
});

test("[L3] 실을 빌트인 앱이 실제로 있다 — 0개면 위 두 시험이 공허하다", () => {
  const dirs = readdirSync(BUILTIN_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(dirs.length > 0, `${BUILTIN_DIR} 에 앱이 없다`);
  //  각 앱은 매니페스트가 있어야 로더가 읽는다(없으면 실려도 건너뛴다 — 또 조용한 빈손).
  for (const d of dirs) {
    const files = readdirSync(`${BUILTIN_DIR}/${d.name}`);
    assert.ok(files.includes("lively-app.json"),
      `${d.name} 에 lively-app.json 이 없다 — 실려도 로더가 건너뛴다`);
  }
});

test("[L4] 시더의 «디렉터리 없음 → 조용히 빈손» 이 그대로 남아 있다(설계) — 그래서 L1 이 유일한 방어다", () => {
  const seed = readFileSync("src/apps/seed.ts", "utf8");
  assert.match(seed, /apps\/builtin 부재/,
    "부재를 조용히 넘기는 분기가 사라졌다면 이 시험군의 전제를 다시 봐야 한다");
});
