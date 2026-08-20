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
t("U6 ★ 스킴 없는 링크(실측: TUI 가 developer.apple.com/… 로 찍는다) — 열 때 https:// 보정", () => {
  const line = "가서 developer.apple.com/account/resources/certificates 를 여세요";
  assert.equal(urlAtColumn(line, 10), "https://developer.apple.com/account/resources/certificates");
  assert.equal(urlAtColumn("www.apple.com 참고", 3), "https://www.apple.com");
  assert.equal(urlAtColumn("호스트만: apple.com/kr", 7), "https://apple.com/kr");
});
t("U7 스킴 없는 형태의 오탐 경계 — 경로 없는 점-이름·파일 경로는 링크가 아니다", () => {
  assert.equal(urlAtColumn("package.json 을 여세요", 4), null, "경로(/) 없는 점-이름");
  assert.equal(urlAtColumn("src/foo.ts 수정", 4), null, "일반 파일 경로(호스트 형태 아님)");
  assert.equal(urlAtColumn("버전 1.2.3/4 확인", 4), null, "숫자.숫자/… 는 TLD 가 아니다");
});
t("W1 배선 — 판정은 mousedown 에서(press 가 pty 로 새면 TUI 확인창이 뜬다), down/up/click 캡처 셋이 한 판정을 공유", () => {
  assert.match(src, /pendingLink = wantsLink \? linkAtEvent\(ev\) : null/, "mousedown 에서 링크를 판정하지 않는다");
  assert.match(src, /urlAtColumn\(text, colInLogical\)/, "판정이 urlAtColumn 을 안 쓴다");
  assert.match(src, /isWrapped/, "감싸인 긴 URL(줄바꿈)을 잇지 않는다");
  // 캡처(true) 3종 — 버블 단계면 xterm 이 먼저 먹는다
  for (const evName of ["mousedown", "mouseup", "click"]) {
    assert.match(src, new RegExp(`addEventListener\\('${evName}',[\\s\\S]{0,700}?\\}, true\\);`), `${evName} 이 캡처가 아니다`);
  }
});
t("W2 배선 — 맨클릭은 '트래킹 pane × URL 위'로 좁힌다(TUI 마우스 입력·셸 드래그 선택 보존), modifier 는 항상", () => {
  assert.match(src, /\(ev\.metaKey \|\| ev\.ctrlKey\) \|\| mouseTracked\(\)/, "맨클릭 경로가 트래킹 판정을 안 탄다");
  assert.match(src, /mouseTrackingMode/, "트래킹 판정이 xterm modes 를 안 본다");
  assert.match(src, /linkHandler: \{ activate:/, "OSC 8 하이퍼링크(linkHandler)가 없다 — TUI 가 심은 실제 URI 링크가 죽은 링크가 된다");
  assert.match(src, /if \(pendingLink \|\| \(ev\.metaKey \|\| ev\.ctrlKey\)\)/, "맨클릭이 URL 밖에서도 삼켜진다(TUI 입력이 죽는다) — URL 위일 때만 삼켜야 한다");
  assert.match(src, /url && url === pendingLink/, "드래그(다른 자리에서 뗌)를 클릭으로 오인한다");
});

console.log(`\n${pass} passed`);
