// 자산 세대 계산의 정본(web-assets.ts) — 서빙(#1017 캐시 가르기)과 굽기(#2643 롤 도달 판정)가 함께 쓴다.
//
// 이 시험이 지키는 것은 **규칙 그 자체**다. 목록 규칙은 실제로 두 번 바뀌었고(#1313 R50 styles/ 추가 ·
//  R28 app/ 재귀), 그때마다 '버전이 안 올라 옛 모듈이 immutable 로 박히는' 회귀가 났다. 이제 같은 규칙에
//  롤 판정까지 매달려 있어, 어긋나면 «자산은 닿았는데 롤이 빨간불» 이 된다.
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSET_VERSION_FILE, listLocalAssets, assetFingerprint, computeAssetVersion } from "./web-assets.js";

let pass = 0;
const t = (n: string, f: () => void): void => { f(); pass++; console.log(`ok  ${n}`); };

/** 파일 트리를 만든다. 값은 파일 내용. */
function tree(spec: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "web-assets-"));
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

// ── 목록 규칙 ───────────────────────────────────────────────────────────────

t("A1 public 최상위는 js·mjs·css 만 — 그 밖(txt·json·map)은 세지 않는다", () => {
  const d = tree({ "b.js": "1", "a.css": "2", "c.mjs": "3", "d.txt": "4", "e.json": "5", "f.js.map": "6" });
  assert.deepEqual(listLocalAssets(d), ["a.css", "b.js", "c.mjs"]);
});

t("A2 app/ 은 **재귀** — 하위 디렉터리 모듈도 센다 (#1313 R28: 안 세면 'lib 만 고친 배포'가 캐시에 박힌다)", () => {
  const d = tree({ "app/x.js": "1", "app/lib/y.js": "2", "app/v2/deep/z.mjs": "3" });
  assert.deepEqual(listLocalAssets(d), ["app/lib/y.js", "app/v2/deep/z.mjs", "app/x.js"]);
});

t("A3 app/ 은 js·mjs 만 — css 는 styles/ 의 몫이다", () => {
  const d = tree({ "app/x.js": "1", "app/x.css": "2" });
  assert.deepEqual(listLocalAssets(d), ["app/x.js"]);
});

t("A4 styles/ 는 **재귀** css (#1313 R50 — 빠지면 CSS 만 버전 없는 고정 URL 이 된다)", () => {
  const d = tree({ "styles/a.css": "1", "styles/sub/b.css": "2" });
  assert.deepEqual(listLocalAssets(d), ["styles/a.css", "styles/sub/b.css"]);
});

t("A5 styles/ 의 js 는 세지 않는다", () => {
  const d = tree({ "styles/a.css": "1", "styles/a.js": "2" });
  assert.deepEqual(listLocalAssets(d), ["styles/a.css"]);
});

t("★A6 스탬프 파일 자신은 목록에 안 들어간다 — 들어가면 쓸 때마다 값이 바뀌어 영영 수렴하지 않는다", () => {
  const d = tree({ "a.js": "1", [ASSET_VERSION_FILE]: '{"v":"deadbeef0000","files":1}' });
  assert.deepEqual(listLocalAssets(d), ["a.js"]);
  //  스탬프를 쓰기 전과 쓴 뒤의 세대가 같아야 «굽기가 자기 결과를 바꾸는» 일이 없다.
  const before = computeAssetVersion(tree({ "a.js": "1" }));
  assert.equal(computeAssetVersion(d), before);
});

t("A7 목록은 정렬된다 — 해시 입력 순서가 파일시스템 순서에 흔들리면 같은 트리가 다른 값을 낸다", () => {
  const d = tree({ "z.js": "1", "a.js": "2", "app/m.js": "3" });
  assert.deepEqual(listLocalAssets(d), ["a.js", "app/m.js", "z.js"]);
});

t("A8 없는 디렉터리는 빈 목록 — 던지지 않는다(app/ 이나 styles/ 가 없는 판이 있다)", () => {
  assert.deepEqual(listLocalAssets(path.join(tmpdir(), "web-assets-does-not-exist-2643")), []);
  const d = tree({ "a.js": "1" });          // app/·styles/ 둘 다 없음
  assert.deepEqual(listLocalAssets(d), ["a.js"]);
});

// ── 세대 값 ────────────────────────────────────────────────────────────────

t("B1 같은 트리는 같은 값 — 결정적이어야 굽는 자리와 서빙하는 자리가 같은 답을 낸다", () => {
  const spec = { "a.js": "hello", "app/b.js": "world", "styles/c.css": "x" };
  assert.equal(computeAssetVersion(tree(spec)), computeAssetVersion(tree(spec)));
});

t("B2 내용이 바뀌면 값이 바뀐다", () => {
  assert.notEqual(computeAssetVersion(tree({ "a.js": "one" })), computeAssetVersion(tree({ "a.js": "two" })));
});

t("★B3 내용이 같아도 **이름이 바뀌면** 값이 바뀐다 — rename 배포가 immutable 캐시를 그냥 넘어가면 안 된다", () => {
  assert.notEqual(computeAssetVersion(tree({ "a.js": "same" })), computeAssetVersion(tree({ "b.js": "same" })));
});

t("★B4 파일 경계가 흐려지지 않는다 — 이어붙이면 같아지는 두 트리가 다른 값을 낸다", () => {
  //  구분자 없이 이어 붙이면 {a.js:'xy'} 와 {a.js:'x', b.js:'y'} 류가 충돌한다.
  assert.notEqual(computeAssetVersion(tree({ "a.js": "xy" })), computeAssetVersion(tree({ "a.js": "x", "b.js": "y" })));
});

t("B5 12자 소문자 hex", () => {
  assert.match(computeAssetVersion(tree({ "a.js": "1" })), /^[0-9a-f]{12}$/);
});

t("B6 자산이 하나도 없으면 빈 트리의 값 — 굽기 쪽이 이 경우를 실패로 다룬다(stamp-assets.mjs)", () => {
  assert.equal(listLocalAssets(tree({ "readme.md": "x" })).length, 0);
});

// ── 재계산 지문(서빙 최적화) ────────────────────────────────────────────────

t("C1 지문은 mtime 에 반응한다 — 내용이 같아도 다시 계산할 기회를 준다", () => {
  const d = tree({ "a.js": "1" });
  const files = listLocalAssets(d);
  const fp1 = assetFingerprint(d, files);
  utimesSync(path.join(d, "a.js"), new Date(0), new Date(0));
  assert.notEqual(assetFingerprint(d, files), fp1);
});

t("C2 지문은 크기에 반응한다", () => {
  const d = tree({ "a.js": "1" });
  const files = listLocalAssets(d);
  const fp1 = assetFingerprint(d, files);
  writeFileSync(path.join(d, "a.js"), "1234567890");
  assert.notEqual(assetFingerprint(d, files), fp1);
});

t("C3 사라진 파일이 있어도 지문·세대가 던지지 않는다 — 빌드 중 목록과 읽기 사이에 파일이 바뀔 수 있다", () => {
  const d = tree({ "a.js": "1" });
  const files = [...listLocalAssets(d), "gone.js"];
  assert.doesNotThrow(() => assetFingerprint(d, files));
  assert.doesNotThrow(() => computeAssetVersion(d, files));
});

console.log(`web-assets.test: ok (${pass})`);
