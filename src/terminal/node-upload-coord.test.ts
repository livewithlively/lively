// 노드 세션 업로드의 게이트웨이 좌표(#3787) — 순수 판정.
import assert from "node:assert/strict";
import test from "node:test";
import { projectOffsetOfSessionDir, projectRelForUpload } from "./node-upload-coord.js";

test("윈도우 노드의 프로젝트 슬롯 — 역슬래시도 같은 자리로 읽는다", () => {
  assert.equal(projectOffsetOfSessionDir("C:\\Users\\amorite\\workspace\\project\\3966", 3966), "");
  assert.equal(projectOffsetOfSessionDir("/Users/haru/workspace/project/3966", 3966), "");
});

test("프로젝트 하위 폴더에서 뜬 세션은 그만큼 오프셋이 붙는다", () => {
  assert.equal(projectOffsetOfSessionDir("C:\\Users\\a\\workspace\\project\\3966\\repo\\web", 3966), "repo/web");
});

test("legacy-project 도 같은 자리다(#1436)", () => {
  assert.equal(projectOffsetOfSessionDir("/home/u/workspace/legacy-project/12", 12), "");
});

test("다른 프로젝트·프로젝트 밖이면 null — 게이트웨이 정본 없음(릴레이만)", () => {
  assert.equal(projectOffsetOfSessionDir("/home/u/workspace/project/3966", 3965), null);
  assert.equal(projectOffsetOfSessionDir("/home/u/box/uploads", 3966), null);
  assert.equal(projectOffsetOfSessionDir("", 3966), null);
  //  ⚠ 이름이 비슷한 자리를 삼키면 안 된다 — 그게 «엉뚱한 폴더에 남의 파일을 쓴다» 가 된다.
  assert.equal(projectOffsetOfSessionDir("/home/u/workspace/project/3966x", 3966), null);
});

test("드롭 상대경로를 프로젝트 기준으로 편다 · 탈출은 거부", () => {
  assert.equal(projectRelForUpload("", "uploads/a.png"), "uploads/a.png");
  assert.equal(projectRelForUpload("repo/web", "uploads/a.png"), "repo/web/uploads/a.png");
  assert.equal(projectRelForUpload("", "\\uploads\\a.png"), "uploads/a.png");
  assert.equal(projectRelForUpload("", "../escape.png"), null);
  assert.equal(projectRelForUpload("repo", "../../etc/passwd"), null);
  assert.equal(projectRelForUpload("", ""), null);
});

// ── 라우트 배선 가드 — 이 계약이 코드에서 사라지면 #3787 이 그대로 재발한다. ──
import { readFileSync } from "node:fs";
const ROUTE = readFileSync(new URL("./terminal-files.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

test("노드 세션 업로드는 **게이트웨이 정본을 먼저 쓴다** — 릴레이만 하고 끝내지 않는다", () => {
  assert.match(ROUTE, /const gw = await gatewayUploadForNodeSession\(/,
    "게이트웨이 정본 갈래가 없다 — 중앙에 닿는 길이 push 훅 하나뿐이 되고, 하네스가 안 돌면 파일이 영영 안 온다");
  assert.match(ROUTE, /await finishUpload\(\{ coord: gw\.coord/, "정본을 써도 자료 등록·좌표를 안 거친다");
});

test("정본을 쓴 경우엔 **릴레이하지 않는다** — 두 사본의 mtime 이 갈리면 영구 거짓 충돌이 난다", () => {
  const branch = ROUTE.slice(ROUTE.indexOf("const gw = await gatewayUploadForNodeSession("),
    ROUTE.indexOf("// 좌표를 못 잡는 세션"));
  assert.doesNotMatch(branch, /fsWrite/, "정본 갈래가 노드로도 쓴다 — fsWrite 는 mtime 을 못 맞춘다(원장 기준선이 깨진다)");
  assert.match(branch, /delivery: "pull"/, "배달 주체를 응답에 안 밝힌다");
});

test("좌표를 못 잡으면 종전대로 릴레이 — 개인 폴더 세션까지 막으면 안 된다", () => {
  assert.match(ROUTE, /\/\/ 좌표를 못 잡는 세션[^\n]*\n\s*let nodeAbs = "";/, "폴백 릴레이 갈래가 사라졌다");
});
