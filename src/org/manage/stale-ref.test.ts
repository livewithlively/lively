// stale_ref 순수 판정 회귀 잠금(#1419 도그푸드) — DB·파일시스템 무의존.
//  실행: npm run build && node dist/org/manage/stale-ref.test.js
//
//  여기서 보는 것은 두 함수뿐이다 — 경로 추출(extractPaths)과 생사 판정(verifyRef).
//  이 둘이 틀리면 **조용히 나쁘다**:
//   · 추출이 과하면(URL·긴 식별자 중간을 자르면) 있지도 않은 경로를 '사라졌다'고 보고해 큐가 오탐으로 덮인다.
//   · 추출이 모자라면 낡은 런북이 영영 안 잡힌다.
//   · 판정이 moved 를 gone 으로 보면 "고칠 자리를 찍어 준다"는 이 판정기의 유일한 강점이 사라진다.
//
//  사양 엣지 표 S1~S10 (각 케이스 주석). 실측 근거는 stale-ref.ts 헤더 참조.
import assert from "node:assert/strict";
import { extractPaths, verifyRef, type RepoIndex } from "./stale-ref.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 색인 하나 만들기 — 실제 indexRepo 는 파일시스템을 걸으므로 여기선 결과 모양만 흉내낸다. */
const idxOf = (files: string[]): RepoIndex => {
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const b = f.slice(f.lastIndexOf("/") + 1);
    const cur = byBase.get(b);
    if (cur) cur.push(f); else byBase.set(b, [f]);
  }
  return { files: new Set(files), byBase };
};

// ══ 생사 판정 ══
t("S1 색인에 있으면 alive", () => {
  const idx = idxOf(["src/db/client.ts"]);
  assert.deepEqual(verifyRef("src/db/client.ts", idx), { state: "alive" });
});

t("S2 같은 파일명이 다른 자리에 있으면 moved — 그 자리를 알려준다", () => {
  // 실측된 지배적 형태다: #1313 리팩토링이 src/org/default-content.ts 를
  //  src/org/delivery/default-content.ts 로 옮겼다. 사람은 문서의 경로만 고치면 끝난다.
  const idx = idxOf(["src/org/delivery/default-content.ts"]);
  assert.deepEqual(verifyRef("src/org/default-content.ts", idx),
    { state: "moved", to: ["src/org/delivery/default-content.ts"] });
});

t("S3 파일명조차 없으면 gone", () => {
  // 삭제·개명 — 문서가 설명하는 대상 자체가 없어졌다. moved 보다 무겁게 다뤄야 한다.
  const idx = idxOf(["src/db/client.ts"]);
  assert.deepEqual(verifyRef("src/db/write.ts", idx), { state: "gone" });
});

t("S4 moved 후보가 여러 개면 최대 3개까지만", () => {
  // 흔한 파일명(index.ts·types.ts)은 후보가 수십 개다. 전부 적으면 증거문이 읽히지 않는다.
  const idx = idxOf(["a/index.ts", "b/index.ts", "c/index.ts", "d/index.ts", "e/index.ts"]);
  const v = verifyRef("src/index.ts", idx);
  assert.equal(v.state, "moved");
  assert.equal((v as { to: string[] }).to.length, 3);
});

t("S5 alive 가 moved 를 이긴다 — 같은 이름이 딴 데도 있어도 정확 일치가 우선", () => {
  // 이게 뒤집히면 살아 있는 경로를 '이동했다'고 보고한다(가장 흔한 형태의 오탐).
  const idx = idxOf(["src/index.ts", "web/index.ts"]);
  assert.deepEqual(verifyRef("src/index.ts", idx), { state: "alive" });
});

// ══ 경로 추출 ══
t("S6 백틱·괄호·대괄호·줄머리에서 잡는다", () => {
  const got = extractPaths([
    "변경은 `src/db/client.ts` 에서 한다",
    "(web/core.ts) 도 함께",
    "- [scripts/run-tests.mjs] 참고",
    "public/styles.css 가 맨 앞",
  ].join("\n"));
  assert.deepEqual(got.sort(),
    ["public/styles.css", "scripts/run-tests.mjs", "src/db/client.ts", "web/core.ts"]);
});

t("S7 확장자 없는 디렉터리·모듈 이름은 안 잡는다", () => {
  // code_unit 은 모듈 단위(src/tools·web/terminal)로 저장된다 — 그걸 파일로 오인하면
  //  전부 '사라짐'이 된다(디렉터리는 파일 색인에 없으므로). 확장자 요구가 그 방어선이다.
  assert.deepEqual(extractPaths("src/tools 와 web/terminal 을 본다"), []);
});

t("S8 허용 접두어 밖은 안 잡는다", () => {
  // dist/ 는 빌드 산출물이고 tmp/ 는 남의 경로다. 인용해도 '우리 소스가 사라졌다'가 아니다.
  assert.deepEqual(extractPaths("dist/index.js 와 tmp/foo.ts 와 node_modules/x/y.js"), []);
});

t("S9 같은 경로를 여러 번 인용해도 한 번만", () => {
  // 중복이 남으면 발견 하나가 같은 경로를 N번 세어 심각도·문장이 부풀려진다.
  const got = extractPaths("`src/web.ts` 를 고치고 다시 src/web.ts 를 본다 (src/web.ts)");
  assert.deepEqual(got, ["src/web.ts"]);
});

t("S10 URL 안의 경로는 안 잡는다", () => {
  // https://…/src/x.ts 는 우리 레포 경로가 아니다(남의 깃허브일 수 있다). 앞 문자가 '/' 라 경계에 안 걸린다.
  assert.deepEqual(extractPaths("https://github.com/o/r/blob/main/src/x.ts 를 봐라"), []);
});

console.log(`\n${pass} passed`);
