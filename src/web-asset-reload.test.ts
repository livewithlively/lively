// 자산 갱신 시 열려 있는 화면을 어떻게 할지 — 정책 노브 (#2126).
//
//  배경: gen-watch(#1841)는 자산 세대가 바뀌면 화면이 다시 보이는 순간 **무조건** 다시 실었다.
//   dev 박스는 그게 맞다 — serve-sync(deploy/io.lvly.stage-sync.plist)가 60초마다 origin/stage 를
//   당겨 build:web 을 돌리므로 자산이 수시로 바뀌고, 개발자는 최신 판을 바로 보고 싶어 한다.
//   고객사 박스는 다르다 — 릴리스는 운영자가 수동으로 돌리는 드문 사건인데, 그 한 번이 하필
//   **글 쓰다 다른 창 갔다 돌아온 사람**의 입력을 통째로 날릴 수 있다(gen-watch 에 dirty 가드가 없었다).
//
//  그래서 정책을 갈랐다. 이 파일이 지키는 계약은 하나 — **모르면 안전한 쪽(notify)** 이다.
//   env 를 안 넣은 박스가 곧 고객사 박스이므로, 기본값이 auto 로 새면 이 패치는 아무것도 못 막는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assetReloadPolicy } from "./web.js";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

// ── A. 노브 해석 — 「입력 × 기대」 ────────────────────────────────────────────
// A1 — 미설정: 고객사 박스의 실제 상태다. 이 행이 이 패치의 존재 이유.
assert.equal(assetReloadPolicy(undefined), "notify",
  "A1: env 미설정이면 notify — 아무것도 안 넣은 박스가 곧 고객사 박스다");
assert.equal(assetReloadPolicy(""), "notify", "A1: 빈 값도 미설정과 같다");

// A2 — 명시적 옵트인. dev 박스가 이걸 넣어 종전 동작을 유지한다.
for (const on of ["1", "true", "yes", "on", "auto"])
  assert.equal(assetReloadPolicy(on), "auto", `A2: '${on}' 은 자동 리로드 옵트인이어야 한다`);

// A3 — 표기 흔들림(.env 는 사람이 손으로 쓴다). 대소문자·앞뒤 공백에 정책이 뒤집히면 안 된다.
for (const on of ["AUTO", " auto ", "True", "ON\n"])
  assert.equal(assetReloadPolicy(on), "auto", `A3: '${JSON.stringify(on)}' 도 auto 로 읽어야 한다`);

// A4 — 끄는 값. 명시적으로 껐는데 켜지면 최악이다.
for (const off of ["0", "false", "no", "off", "notify"])
  assert.equal(assetReloadPolicy(off), "notify", `A4: '${off}' 는 notify 여야 한다`);

// A5 — 모르는 값: fail-safe. 오타(`aut0`)가 자동 리로드로 새면 고객사에서 입력이 날아간다.
for (const junk of ["aut0", "yep", "kinda", "1 2", "auto-ish"])
  assert.equal(assetReloadPolicy(junk), "notify", `A5: 모르는 값 '${junk}' 은 안전한 쪽(notify)이어야 한다`);

// ── B. 배선 계약 — 함수만 맞고 배선이 끊기면 정책은 화면에 닿지 않는다 ────────
const webSrc = read("src/web.ts");
const genWatch = read("web/gen-watch.ts");

// B1 — /ui/__gen 이 정책을 함께 실어야 한다. 이게 화면까지 가는 유일한 통로다.
const genRoute = /app\.get\("\/ui\/__gen"[\s\S]{0,400}?\}\);/.exec(webSrc)?.[0] ?? "";
assert.ok(genRoute, "B1: /ui/__gen 라우트를 찾지 못했다");
assert.match(genRoute, /assetReloadPolicy\(/,
  "B1: /ui/__gen 응답이 정책을 싣지 않는다 — 화면은 정책을 알 길이 없어 종전대로 무조건 리로드한다");
assert.match(genRoute, /\bv:\s*assetVersion\(\)/,
  "B1: 세대 필드 v 는 그대로 있어야 한다 — 데스크톱 앱(main.mjs)이 이 이름을 읽는다");

// B2 — 화면이 그 정책을 실제로 분기해야 한다.
assert.match(genWatch, /reload\s*===\s*["']auto["']|policy\s*===\s*["']auto["']/,
  "B2: gen-watch 가 정책으로 분기하지 않는다");

// B3 — auto 라도 사람이 뭘 쓰고 있으면 자동으로 날리지 않는다. 이 가드가 사고의 실제 표면이다.
assert.match(genWatch, /function\s+isBusy\b/,
  "B3: gen-watch 에 입력 중 판정(isBusy)이 없다 — auto 박스에서 타이핑하던 글이 날아간다");

// B4 — notify 경로에는 사람이 누를 자리가 있어야 한다. 알림만 뜨고 방법이 없으면 막다른 길이다.
assert.match(genWatch, /location\.reload\(\)/, "B4: gen-watch 에 리로드 경로가 없다");
assert.match(genWatch, /addEventListener\(["']click["']|onclick/,
  "B4: notify 배너에 누를 자리(클릭 핸들러)가 없다");

// B5 — 데스크톱 앱도 같은 정책을 따라야 한다. 여기가 빠지면 앱 사용자만 종전대로 날아간다.
const desktop = read("desktop/main/main.mjs");
const stale = /async function reloadIfStale\(\)[\s\S]{0,1200}?\n\}/.exec(desktop)?.[0] ?? "";
assert.ok(stale, "B5: desktop/main/main.mjs 에서 reloadIfStale 을 찾지 못했다");
assert.match(stale, /reload|policy/,
  "B5: 데스크톱 자가복구가 정책을 읽지 않는다 — 앱 창은 고객사에서도 무조건 다시 싣는다");

// ── C. 운영자가 알 수 있어야 한다 ────────────────────────────────────────────
// C1 — dev 박스가 종전 속도를 유지하려면 이 노브를 알아야 한다. 문서화되지 않은 노브는 없는 노브다.
assert.match(read("deploy/env.example"), /LIVELY_ASSET_AUTO_RELOAD/,
  "C1: deploy/env.example 에 노브가 문서화되지 않았다 — dev 박스가 켤 방법을 모른다");

console.log("web-asset-reload: ok (A1–A5, B1–B5, C1)");
