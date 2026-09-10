// 좌측 목록에 «설 자격» 규칙(web/lib/row-stands.ts) — #3778, 원준 2026-09-10 **3차** 신고.
//
// 같은 자리를 세 번 신고받았다. 판정이 «서지 **않을** 것»을 열거하는 방식이라, 열거에서 빠진 종류가 그때마다 샜다:
//   1차 앱 첫 화면 다섯 줄(확인할 것·자료·프로젝트·AI 세션·새 작업)
//   2차 프로젝트에 들어갈 때마다 생기던 「새 세션」 줄
//   3차 앱 인스턴스 — 「웹 브라우저」 ×3 · 「안녕 앱」, 그리고 레일 [홈] 누를 때마다 되살아나는 빈 「새 작업」
// ⇒ «**설** 것»을 열거하는 쪽으로 뒤집었고, 이 표가 그 열거 전체다. 행 하나가 곧 시나리오 하나.
//
// 사양·엣지 표(spec-failfirst):
//  S1  세션 #/s/<id>                     → 선다 (여기 말고 돌아갈 길이 없다)
//  S2  홈, 쓰다 만 지시 없음              → **안 섬** (3차: 레일 [홈] 누를 때마다 되살아났다)
//  S3  홈, 쓰다 만 지시 있음              → 선다
//  S4  #/p/<id>, 지시 없음                → 안 섬 (2차: 세션 되기 전 빈 슬롯)
//  S5  #/app/<key> 첫 화면                → 안 섬 (1차: 레일·런치패드가 문)
//  S6  #/app/<key>/<더>                   → 선다 (어디까지 봤나)
//  S7  #/sources · #/sources/<id>         → 안 섬 · 선다
//  S8  #/i 브라우저, url == home          → **안 섬** (3차: 열어만 보고 둔 것)
//  S9  #/i 브라우저, url != home          → 선다
//  S10 #/i 그 밖, state 비었음             → 안 섬
//  S11 #/i 그 밖, state 있음               → 선다
//  S12 #/i 캐시에 없음                     → 안 섬 («안 보이는 쪽으로 틀린다» 규약)
//  S13 모르는 주소                         → **안 섬** (기본값을 뒤집은 것 자체)
//  S14 쿼리스트링이 붙어도 판정이 같다
//  T1  브라우저 인스턴스 제목 = 호스트(www. 뗌)
//  T2  브라우저 아님·주소 없음 → 빈 문자열(호출부가 앱 이름으로 물러난다)
// 웹 모듈은 src 테스트가 직접 import 할 수 없다(rootDir 밖) — proj-match.test.ts 와 같은 방식으로
//  소스를 transpile 해 data: URL 로 싣는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Facts = { renderer?: string | null; home?: string | null; state?: Record<string, unknown> | null };
type Deps = { hasDraft: boolean; isClassicPage(p: string): boolean; inst(id: string): Facts | null };
type Mod = {
  rowStands: (route: string, deps: Deps) => boolean;
  instHasState: (inst: Facts | null) => boolean;
  instBrowserHost: (inst: Facts | null) => string;
};
const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
let cached: Promise<Mod> | null = null;
function load(): Promise<Mod> {
  if (!cached) {
    const src = readFileSync(webPath("lib/row-stands.ts"), "utf8");
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    cached = import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as Promise<Mod>;
  }
  return cached;
}

/** 기본 배선 — 인스턴스는 표에서 넘긴 것만 안다. */
const deps = (o?: { hasDraft?: boolean; insts?: Record<string, Facts> }): Deps => ({
  hasDraft: !!(o && o.hasDraft),
  isClassicPage: (p: string) => p === "knowledge" || p === "terminal",
  inst: (id: string) => ((o && o.insts && o.insts[id]) || null) as Facts | null,
});

test("S1 세션은 언제나 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/s/box-abc", deps()), true);
});

test("S2·S3 홈은 쓰다 만 지시가 있을 때만 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/", deps()), false, "빈 홈이 선다 — 레일 [홈] 누를 때마다 되살아난다");
  assert.equal(m.rowStands("#/dashboard", deps()), false);
  assert.equal(m.rowStands("#/", deps({ hasDraft: true })), true);
});

test("S4 프로젝트 주소는 지시가 있을 때만 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/p/3778", deps()), false);
  assert.equal(m.rowStands("#/p/3778", deps({ hasDraft: true })), true);
});

test("S5·S6 앱은 첫 화면이면 안 서고 깊은 자리면 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/app/terminal", deps()), false);
  assert.equal(m.rowStands("#/app/knowledge/k/some-doc", deps()), true);
});

test("S7 정본 주소 빌트인·클래식 딥링크도 같은 자", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/sources", deps()), false);
  assert.equal(m.rowStands("#/sources/12", deps()), true);
  assert.equal(m.rowStands("#/inbox", deps()), false);
  assert.equal(m.rowStands("#/knowledge", deps()), false);
  assert.equal(m.rowStands("#/knowledge/some-doc", deps()), true);
});

test("S8·S9 브라우저 인스턴스는 첫 주소를 떠났을 때만 선다", async () => {
  const m = await load();
  const home = "https://www.google.com/";
  const at = (url: string) => ({ renderer: "browser", home, state: { url } });
  assert.equal(m.rowStands("#/i/a", deps({ insts: { a: at(home) } })), false, "열어만 보고 둔 브라우저가 선다");
  assert.equal(m.rowStands("#/i/a", deps({ insts: { a: at("https://news.ycombinator.com/") } })), true);
  //  주소가 아직 안 실린 브라우저도 «두고 온 것 없음».
  assert.equal(m.rowStands("#/i/a", deps({ insts: { a: { renderer: "browser", home, state: {} } } })), false);
});

test("S10·S11 그 밖의 앱은 state 가 비었으면 안 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/i/h", deps({ insts: { h: { renderer: null, state: {} } } })), false);
  assert.equal(m.rowStands("#/i/h", deps({ insts: { h: { renderer: null, state: { step: 2 } } } })), true);
});

test("S12 아직 못 읽은 인스턴스는 안 선다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/i/unknown", deps()), false);
});

test("S13 모르는 주소는 안 선다 — 기본값이 «안 섬»이다", async () => {
  const m = await load();
  for (const r of ["#/archive", "#/trash", "#/connect", "#/liv", "#/welcome", "#/무엇이든"]) {
    assert.equal(m.rowStands(r, deps()), false, r + " 가 선다 — 열거 밖이 새고 있다");
  }
});

test("S14 쿼리스트링이 붙어도 판정이 같다", async () => {
  const m = await load();
  assert.equal(m.rowStands("#/app/terminal?x=1", deps()), false);
  assert.equal(m.rowStands("#/s/box-abc?solo=1", deps()), true);
});

test("T1·T2 브라우저 인스턴스 제목은 호스트(www. 뗌)", async () => {
  const m = await load();
  assert.equal(m.instBrowserHost({ renderer: "browser", state: { url: "https://www.google.com/x?q=1" } }), "google.com");
  assert.equal(m.instBrowserHost({ renderer: "browser", state: { url: "https://news.ycombinator.com/" } }), "news.ycombinator.com");
  assert.equal(m.instBrowserHost({ renderer: "browser", state: {} }), "");
  assert.equal(m.instBrowserHost({ renderer: null, state: { url: "https://x.com/" } }), "");
  assert.equal(m.instBrowserHost({ renderer: "browser", state: { url: "그냥 글자" } }), "");
  assert.equal(m.instBrowserHost(null), "");
});
