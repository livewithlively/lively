// 로그인 카드가 **쓰는 클래스**는 스타일시트에 실제로 있어야 한다 (#2055 후속, 2026-08-28).
//
//  왜: 이 화면의 JS 와 CSS 는 **다른 파일**이라, 이미지에 번들만 넣고 스타일을 빠뜨리면 화면이 조용히 어긋난다.
//  실측 — c81 을 구울 때 바뀐 파일을 `git diff -- src web scripts` 로 골라 `public/styles/41-onboarding.css`
//  (+12줄, .ob-login-* 규칙)를 통째로 빠뜨렸다. 그런 누락은 배포 뒤에야 드러난다. 그래서 여기서 잠근다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("../web/v2/onboarding.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../public/styles/41-onboarding.css", import.meta.url), "utf8");

test("배선 · 두 파일을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SRC.length > 10000 && CSS.length > 1000);
});

test("★ 카드가 쓰는 ob-login-* 클래스가 스타일시트에 전부 있다", () => {
  const used = new Set();
  // 화면에 나가는 자리에서만 모은다 — 주석에 적힌 이름은 계약이 아니다.
  for (const line of SRC.split("\n")) {
    if (line.trim().startsWith("//")) continue;
    for (const m of line.matchAll(/["'=](ob-login-[a-z-]+)["' ]/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 4, `카드 클래스를 못 찾았다 — 모은 것: ${[...used].join(", ")}`);
  for (const cls of used) assert.match(CSS, new RegExp(`\\.${cls}\\b`), `${cls} 규칙이 스타일시트에 없다`);
});
