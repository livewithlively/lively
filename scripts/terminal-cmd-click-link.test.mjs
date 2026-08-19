// #1541 — Cmd/Ctrl+클릭 링크 열기의 판정부(urlAtColumn) + 배선.
//  왜 표로 못박나: 실측 사슬이 길었다 — 트래킹 pane(claude TUI)에선 클릭이 pty 로 가서 TUI 의 확인창이 뜨고,
//  OK 는 서버 안 open(1)이라 사용자 브라우저엔 아무 일도 없다. 그래서 modifier 클릭은 xterm 전에 가로채
//  클라이언트가 여는데, "어느 글자가 URL 인가"의 판정이 틀리면 빈 자리 클릭이 엉뚱한 링크를 연다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const { urlAtColumn } = await importTerminalModule();
assert.equal(typeof urlAtColumn, "function");

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };

const LINE = "AAA https://dev.lvly.io/ui/#/k/foo-1541 BBB";
t("U1 URL 글자 위 = 그 URL (시작·중간·끝)", () => {
  assert.equal(urlAtColumn(LINE, 4), "https://dev.lvly.io/ui/#/k/foo-1541");
  assert.equal(urlAtColumn(LINE, 20), "https://dev.lvly.io/ui/#/k/foo-1541");
  assert.equal(urlAtColumn(LINE, 38), "https://dev.lvly.io/ui/#/k/foo-1541");
});
t("U2 URL 밖(앞말·뒷말·경계 뒤) = null — 빈 자리 클릭이 링크를 열면 안 된다", () => {
  assert.equal(urlAtColumn(LINE, 0), null);
  assert.equal(urlAtColumn(LINE, 3), null);
  assert.equal(urlAtColumn(LINE, 39), null);
  assert.equal(urlAtColumn(LINE, 42), null);
});
t("U3 문장부호 꼬리를 URL 에 넣지 않는다(문장 속 링크)", () => {
  assert.equal(urlAtColumn("보세요: https://a.io/x. 그리고", 10), "https://a.io/x");
  assert.equal(urlAtColumn("(https://a.io/x)", 3), "https://a.io/x");
});
t("U4 한 줄에 URL 둘 — 클릭한 쪽이 열린다", () => {
  const two = "https://a.io/1 사이 https://b.io/2";
  assert.equal(urlAtColumn(two, 2), "https://a.io/1");
  assert.equal(urlAtColumn(two, 25), "https://b.io/2");
});
t("U5 비-URL·빈 줄 = null (throw 없음)", () => {
  assert.equal(urlAtColumn("no links here", 5), null);
  assert.equal(urlAtColumn("", 0), null);
});
t("W1 배선 — modifier 클릭은 xterm 전에 삼킨다(mousedown·mouseup 캡처) + click 이 urlAtColumn 을 부른다", () => {
  assert.match(src, /swallowIfModifier/, "가로채기 헬퍼가 없다");
  assert.match(src, /addEventListener\('mousedown', swallowIfModifier, true\)/, "mousedown 캡처가 없다 — pty 리포팅이 새서 TUI 확인창이 또 뜬다");
  assert.match(src, /addEventListener\('mouseup', swallowIfModifier, true\)/, "mouseup 캡처가 없다");
  assert.match(src, /urlAtColumn\(text, colInLogical\)/, "클릭 판정이 urlAtColumn 을 안 쓴다");
  assert.match(src, /isWrapped/, "감싸인 긴 URL(줄바꿈)을 잇지 않는다");
});

console.log(`\n${pass} passed`);
