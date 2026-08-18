// 자산 캐시 정책 + 빌드 경로 계약 (#1760) — 회귀 대상: dev.lvly.io 가 하루에 두 번 백지가 됐다.
//
//  ① 빌드 레이스 — `tsc -p web/tsconfig.json` 이 서빙 디렉터리(public/app)에 직접, 파일 단위로 썼다
//   (실측: 산출물 mtime 이 20:30:57~20:31:18 에 분산 — 21초). 게이트웨이는 그 디렉터리를 재시작 없이
//   서빙하므로, 그 창에 페이지를 연 사람은 한 페이지 안에서 옛 모듈과 새 모듈을 섞어 받았다:
//   v2/main.js(옛것)가 views.js(새것)에서 이미 project-view.ts 로 옮겨간 renderProject 를 import
//   → ESM 로드 실패 → 화면 전체 백지.
//  ② 굳는 캐시 — 그렇게 받은 조합이 immutable(1년)로 캐시에 박혀, 서버가 이미 온전한 번들을 서빙하는데도
//   그 사람 화면은 하드 리로드 전까지 백지로 고정됐다.
//  ③ 같은 날 두 번째 사고 — 미해결 머지(충돌마커가 든 web/timeline.ts)를 tsc 가 **에러를 내면서도 emit**
//   해(noEmitOnError 기본 false) 서빙 경로에 들어갔다. ①의 실패 게이트가 이것도 막는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assetCacheControl } from "./web.js";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const isImmutable = (h: string): boolean => /\bimmutable\b/.test(h);

// ── 정책 A: 응답의 Cache-Control ─────────────────────────────────────────────
//  단언은 문구가 아니라 **효과**로 한다 — max-age 숫자를 바꾸는 튜닝에 거짓 실패하지 않도록,
//  "굳히는가 / 남기는가"라는 성질만 본다.

// A1 — 요청 v == 현재 v: 굳힌다(재검증 왕복 0. #1017 이 얻은 성능을 지키는 행).
assert.ok(isImmutable(assetCacheControl("abc123", "abc123")),
  "A1: 요청 ?v= 가 현재 빌드버전과 같으면 immutable 이어야 한다");

// A2 — 세대 불일치: 캐시에 남기지 않는다. 이 행이 사고의 '고착' 경로를 끊는다.
assert.equal(assetCacheControl("old999", "abc123"), "no-store",
  "A2: 세대가 어긋난 ?v= 응답은 no-store 여야 한다 — 섞인 모듈 조합이 immutable 로 굳으면 백지가 고착된다");

// A3 — ?v= 없는 직접·구 URL: 굳히지도, 버리지도 않는다(하위호환 재검증).
assert.equal(assetCacheControl("", "abc123"), "no-cache",
  "A3: ?v= 없는 요청은 no-cache(재검증)여야 한다");

// A4 — 현재 버전이 빈 값(계산 실패 등)인데 요청에도 v 가 없는 경우.
//  ⚠ 이번에 들인 '현재 버전' 인자가 비었을 때 생기는 새 엣지다. 두 빈 문자열이 '일치'로 읽히면
//   판단 근거가 없는 응답을 1년 굳히게 된다 — 부재 검사가 일치 검사보다 **먼저** 와야 한다.
assert.ok(!isImmutable(assetCacheControl("", "")),
  "A4: 요청에 ?v= 가 없으면 현재 버전이 빈 값이어도 immutable 로 새면 안 된다");
assert.equal(assetCacheControl("", ""), "no-cache", "A4: 그 경우의 정책은 재검증(no-cache)이다");

// A5 — 현재 버전만 빈 값: 대조할 기준이 없으므로 굳히지 않는다.
assert.equal(assetCacheControl("abc123", ""), "no-store",
  "A5: 현재 빌드버전을 모르는 상태에서 받은 ?v= 응답을 굳히면 안 된다");

// ── 정책 B: 빌드가 서빙 디렉터리를 중간 상태로 노출하지 않는다 ────────────────
//  구현 미러링이 아니라 **경로 계약**을 본다 — 어느 디렉터리에 쓰는가, 어떤 스크립트를 타는가,
//  실패를 확인하는 지점이 교체보다 앞인가. 셋 중 하나만 되돌아가도 레이스가 그대로 부활한다.

// B1 — 컴파일러 산출 경로가 서빙 디렉터리면 안 된다.
const outDir = /"outDir"\s*:\s*"([^"]+)"/.exec(read("web/tsconfig.json"))?.[1];
assert.ok(outDir, "B1: web/tsconfig.json 에서 outDir 을 못 읽었다");
assert.ok(!/(^|\/)public\/app\/?$/.test(String(outDir)),
  `B1: web tsconfig 의 outDir 이 서빙 디렉터리(${outDir})다 — tsc 가 public/app 에 직접 쓰면 ` +
  "순차 기록 동안 옛/새 모듈이 섞여 로드돼 화면이 백지가 된다. 별도 디렉터리에 쌓고 완료 후 원자 교체할 것");

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

// B2 — build:web 이 원자 교체 스크립트를 탄다.
assert.match(pkg.scripts["build:web"] ?? "", /scripts\/build-web\.mjs/,
  "B2: build:web 이 원자 교체 스크립트를 타지 않는다 — tsc 를 직접 부르면 중간 상태가 그대로 서빙된다");

// B3 — 풀빌드도 같은 경로를 탄다. build:web 만 고치고 여기를 놓치면 **배포 경로에서** 레이스가 되살아난다.
assert.ok(!/tsc\s+-p\s+web\/tsconfig\.json(?!\s+--noEmit)/.test(pkg.scripts.build ?? ""),
  "B3: 풀빌드(build)가 web tsconfig 를 직접 emit 한다 — 배포 경로에 레이스가 남는다");

// B4 — 실패 확인이 교체보다 앞. 순서가 뒤집히면 오늘의 두 번째 사고(충돌마커 emit)가 그대로 재현된다.
//  ⚠ import 줄을 걷어내고 본다 — 상단 `import { … renameSync … }` 가 '첫 교체 지점'으로 잡히면
//   순서가 뒤집혀도 통과하는 vacuous 검사가 된다(실제로 처음 쓸 때 그렇게 잡혔다).
const buildWeb = read("scripts/build-web.mjs").split("\n").filter((l) => !/^\s*import\s/.test(l)).join("\n");
const failGate = buildWeb.indexOf("r.status !== 0");
const firstSwap = buildWeb.search(/\brenameSync\(/);
assert.ok(failGate > 0, "B4: build-web.mjs 에서 컴파일 실패 게이트를 찾지 못했다");
assert.ok(firstSwap > 0, "B4: build-web.mjs 에서 교체(rename) 지점을 찾지 못했다");
assert.ok(failGate < firstSwap,
  "B4: 컴파일 성공을 확인하기 전에 서빙 디렉터리를 교체한다 — 깨진 산출물이 그대로 나간다");

console.log("web-asset-cache: ok (A1–A5, B1–B4)");
