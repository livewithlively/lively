// «누가 무엇을 보나요» 첫 안내(#5598) — 웹 카드의 규칙(web/lib/share-guide-rules.ts) · CLI 설치 끝 상자(kit/cli/lively.mjs) · 배선.
//
//  ⚠ web 은 dist 로 굽히지 않는다 — 순수 모듈의 소스를 TypeScript 로 옮긴 뒤 불러온다(project-access-ui.test.ts 와 같은 방식).
//
//  사양 · 엣지 표(spec-failfirst)
//   R1  워크스페이스 설정 → 2장 갈래: 못 읽음(null) → 초대제 · open → 전체 공개 · ★enforced=false(축 꺼짐) → «팀 전원»(초대제라도)
//   R2  자동으로 띄우지 않는 자리: 처음 설정 · 승인 · 앱 전체 화면 · 앱 허가 · 앱 열기 · 다시 보기 주소 자신.
//       경계 — 그 이름으로 시작하는 다른 주소(#/welcomes)는 막지 않는다 · 쿼리가 붙어도(#/welcome?resume=1) 막는다 · 빈 주소는 띄운다
//   R3  2장 문구 — 초대제는 «비공개», 전체 공개 · 축 꺼짐은 «팀» — ★어느 쪽이든 «남이 만든 세션 안은 볼 수 없어요» 를 말한다
//   R4  뱃지는 [대상][공개 범위] 두 개 — 1~4장 모두 정확히 두 개 · 5장(요약)은 없음 · «남아요/안 남아요» 같은 말은 없다
//   R5  다시 보기 주소 — #/share-guide · #/share-guide?x · 다른 주소는 아니다
//   C1  ★CLI 상자 — 모든 갈래 × 링크 유무에서 상자 줄의 화면 폭이 같다(오른쪽 테두리가 맞는다, 한글 2칸)
//   C2  CLI 상자 안엔 폭이 터미널마다 다른 기호(· — ↵)가 없다
//   C3  CLI 프로젝트 줄 — 초대제는 «나와 초대한 사람만 봐요» 가 먼저 · 둘째 줄 «초대받아도 남의 세션 안은 못 봐요» · 전체 공개는 «팀 전원»
//   C4  color=false 면 ANSI 가 하나도 없다 · narrow 면 테두리가 없다 · 링크가 비면 링크 줄이 없다
//   W1  배선 — 셸(main.ts)이 첫 안내를 띄우고 다시 보기 주소를 가로챈다 · 승인 페이지가 승인 뒤 안내를 붙인다 · 스타일이 실린다
//   W2  배선 — 서버 표식 share_guide_seen: 받는다 · 처음 시각을 지킨다 · GET 이 돌려준다
//   W3  배선 — setup 두 출구(클라우드 · 자체 호스팅)가 설치 끝에 상자를 찍는다 · 멈춤은 앱(PROMPTER)·비대화형에선 하지 않는다 ·
//       ★Enter 뒤 stdin 을 멈춘다(Windows 행) · tty 가 닫혀도 풀린다 · lively guide
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rules: any = null;
async function loadRules() {
  if (rules) return rules;
  const js = ts.transpileModule(readFileSync("web/lib/share-guide-rules.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  rules = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return rules;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cli: any = null;
async function loadCli() {
  if (cli) return cli;
  cli = await import(pathToFileURL(resolve("kit/cli/lively.mjs")).href);
  return cli;
}
const strip = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const width = (s: string) => [...strip(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const boxLines = (ls: string[]) => ls.filter((l) => /[│╭╰├]/.test(l));
const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("R1 워크스페이스 설정 → 2장 갈래", async () => {
  const m = await loadRules();
  assert.equal(m.projModeOf(null), "invite");
  assert.equal(m.projModeOf(undefined), "invite");
  assert.equal(m.projModeOf({ mode: "invite", enforced: true }), "invite");
  assert.equal(m.projModeOf({ mode: "open", enforced: true }), "open");
  assert.equal(m.projModeOf({ mode: "invite", enforced: false }), "all", "축이 꺼지면 초대제 표시가 아무것도 가리지 않는다 — «비공개» 라고 말하면 거짓 안심");
  assert.equal(m.projModeOf({ mode: "open", enforced: false }), "all");
  assert.equal(m.projModeOf({}), "invite");
});

test("R2 자동으로 띄우지 않는 자리 · 경계", async () => {
  const m = await loadRules();
  for (const h of ["#/welcome", "#/welcome?resume=1", "#/activate?code=AB", "#/full/x", "#/app-grant/1", "#/app-open/2", "#/share-guide"]) {
    assert.equal(m.shareGuideAutoAllowed(h), false, h);
  }
  for (const h of ["", "#/", "#/s/abc", "#/p/12", "#/welcomes", "#/fullscreen-ish"]) {
    assert.equal(m.shareGuideAutoAllowed(h), true, h);
  }
});

test("R3 2장 문구 — 갈래마다 공개 범위가 맞고, 어느 쪽이든 «남이 만든 세션 안» 을 말한다", async () => {
  const m = await loadRules();
  const s2 = m.SG_STEPS.find((s: { scene: string }) => s.scene === "s2");
  assert.match(s2.title("invite"), /프로젝트도 비공개/);
  assert.match(s2.title("open"), /팀에 공개/);
  assert.match(s2.title("all"), /팀에 공개/);
  assert.match(text(s2.badges("invite")), /프로젝트비공개/);
  assert.match(text(s2.badges("open")), /프로젝트전체 공개/);
  for (const md of ["invite", "open", "all"]) assert.match(text(s2.lead(md)), /남이 만든 세션 안은 볼 수 없어요/, md);
  assert.match(text(s2.lead("open")), /결과를 남긴 프로젝트는 팀 전원/);
  assert.doesNotMatch(text(s2.lead("all")), /결과를 남긴/, "축이 꺼진 곳은 결과와 상관없이 전원이 본다");
});

test("R4 뱃지 — 1~4장은 [대상][공개 범위] 정확히 두 개 · 요약은 없음 · «남아요» 류 금지", async () => {
  const m = await loadRules();
  assert.equal(m.SG_STEPS.length, 5);
  m.SG_STEPS.forEach((s: { scene: string; badges: (x: string) => string; title: (x: string) => string; lead: (x: string) => string }, i: number) => {
    for (const md of ["invite", "open"]) {
      const n = (s.badges(md).match(/class="sg-bd /g) || []).length;
      assert.equal(n, i < 4 ? 2 : 0, `${s.scene} ${md}`);
      assert.match(s.badges(md), i < 4 ? /sg-what/ : /^$/);
      const all = text(s.badges(md) + s.title(md) + s.lead(md));
      assert.doesNotMatch(all, /남아요|안 남아요|작업 폴더/, s.scene);
    }
  });
});

test("R5 다시 보기 주소", async () => {
  const m = await loadRules();
  assert.ok(m.SHARE_GUIDE_ROUTE.test("#/share-guide"));
  assert.ok(m.SHARE_GUIDE_ROUTE.test("#/share-guide?from=cli"));
  assert.ok(!m.SHARE_GUIDE_ROUTE.test("#/share-guides"));
  assert.ok(!m.SHARE_GUIDE_ROUTE.test("#/"));
});

test("C1 ★CLI 상자 — 모든 갈래 × 링크 유무에서 오른쪽 테두리가 맞는다", async () => {
  const c = await loadCli();
  for (const mode of ["invite", "open", "all"]) {
    for (const link of ["", "https://acme.app.lvly.io/ui/#/share-guide"]) {
      for (const color of [true, false]) {
        const ls = boxLines(c.shareGuideLines({ mode, link, color }));
        assert.ok(ls.length >= 15, `상자 줄이 있어야 한다 ${mode}`);
        const ws = new Set(ls.map(width));
        assert.equal(ws.size, 1, `${mode} link=${!!link} color=${color} 폭 ${[...ws].join(",")}`);
      }
    }
  }
});

test("C2 CLI 상자 안엔 폭이 애매한 기호가 없다", async () => {
  const c = await loadCli();
  for (const mode of ["invite", "open", "all"]) {
    for (const l of boxLines(c.shareGuideLines({ mode, link: "https://x/ui/#/share-guide", color: false }))) {
      assert.doesNotMatch(l, /[·—↵]/, l);
    }
  }
});

test("C3 CLI 프로젝트 줄 — 초대제는 «나와 초대한 사람만 봐요» 가 먼저, 남의 세션 줄이 뒤에", async () => {
  const c = await loadCli();
  const inv = c.shareGuideLines({ mode: "invite", color: false }).map(strip);
  const i = inv.findIndex((l: string) => l.includes("프로젝트"));
  assert.match(inv[i], /프로젝트\s+비공개\s+나와 초대한 사람만 봐요/);
  assert.match(inv[i + 1], /초대받아도 남의 세션 안은 못 봐요/);
  const open = c.shareGuideLines({ mode: "open", color: false }).map(strip);
  const j = open.findIndex((l: string) => l.includes("프로젝트"));
  assert.match(open[j], /프로젝트\s+전체 공개\s+결과를 남기면 팀 전원이 봐요/);
  assert.match(open[j + 1], /초대받아도 남의 세션 안은 못 봐요/);
  const all = c.shareGuideLines({ mode: "all", color: false }).map(strip);
  assert.ok(all.some((l: string) => /프로젝트\s+전체 공개\s+팀 전원이 봐요/.test(l)));
  // 다른 두 줄은 갈래와 상관없다
  for (const ls of [inv, open, all]) {
    assert.ok(ls.some((l: string) => /AI 세션\s+비공개\s+나와 초대한 사람만 봐요/.test(l)));
    assert.ok(ls.some((l: string) => /지식\s+전체 공개\s+AI가 정리한 글만 팀에 자동 공유돼요/.test(l)));
    assert.ok(ls.some((l: string) => l.includes("lively run --readonly") && l.includes("--incognito")));
    assert.ok(ls.some((l: string) => l.includes("/lively-disconnect")));
  }
});

test("C4 색 끄기 · 좁은 창 · 링크 없음", async () => {
  const c = await loadCli();
  assert.ok(!c.shareGuideLines({ color: false }).join("\n").includes("\u001b"));
  assert.ok(c.shareGuideLines({ color: true }).join("\n").includes("\u001b[48;5;62"), "색을 켜면 머리 띠 · 뱃지에 바탕색이 있다");
  const narrow = c.shareGuideLines({ color: false, narrow: true, link: "https://x/ui/#/share-guide" });
  assert.equal(boxLines(narrow).length, 0);
  assert.ok(narrow.some((l: string) => l.includes("https://x/ui/#/share-guide")));
  assert.ok(!c.shareGuideLines({ color: false, link: "" }).some((l: string) => l.includes("1분 안내")));
});

test("W1 배선 — 셸 · 승인 페이지 · 스타일", () => {
  const main = readFileSync("web/v2/main.ts", "utf8");
  assert.match(main, /import \{[^}]*maybeShowShareGuide[^}]*\} from '\.\/share-guide\.js'/);
  assert.match(main, /void maybeShowShareGuide\(\)/, "셸이 선 뒤 첫 안내를 띄운다");
  assert.match(main, /SHARE_GUIDE_ROUTE\.test\(boot\)/, "다시 보기 주소로 켜면 창으로 연다");
  assert.match(main, /SHARE_GUIDE_ROUTE\.test\(hash\)[\s\S]{0,80}openShareGuide\(\{ again: true \}\)/, "주소가 바뀌어도 창으로 연다");
  const act = readFileSync("web/activate.ts", "utf8");
  assert.match(act, /cli\/device\/approve[\s\S]{0,600}showShareGuideAfterApprove\(slot\)/, "승인한 뒤에 안내를 붙인다");
  assert.match(act, /share_guide_seen_at\) return/, "이미 확인한 사람에겐 붙이지 않는다");
  assert.match(readFileSync("public/index.html", "utf8"), /styles\/54-share-guide\.css/);
  const sg = readFileSync("web/v2/share-guide.ts", "utf8");
  assert.match(sg, /share_guide_seen: true/);
  assert.match(sg, /catch \(_\) \{ return; \}/, "표식을 못 읽으면 띄우지 않는다");
});

test("W2 배선 — 서버 표식", () => {
  const liv = readFileSync("src/capabilities/delivery/liv.ts", "utf8");
  assert.match(liv, /const shareGuideSeen = input\.share_guide_seen === true/);
  assert.match(liv, /!desktopSeen && !shareGuideSeen\) throw/, "이 표식만 와도 400 이 아니다");
  assert.match(liv, /shareGuideSeen,\n\s*\}\);/);
  assert.match(liv, /share_guide_seen: z\.boolean\(\)\.optional\(\)/);
  assert.match(liv, /share_guide_seen_at: p\.share_guide_seen_at \?\? null/, "GET 이 돌려준다");
  const mem = readFileSync("src/org/store/members.ts", "utf8");
  assert.match(mem, /if \(patch\.shareGuideSeen && !cur\.share_guide_seen_at\) next\.share_guide_seen_at =/, "처음 시각을 지킨다");
});

test("W3 배선 — setup 두 출구 · 멈춤 조건 · lively guide", () => {
  const src = readFileSync("kit/cli/lively.mjs", "utf8");
  const setup = src.slice(src.indexOf("async function cmdSetup("), src.indexOf("// ── «누가 무엇을 보나요» 상자"));
  const exits = setup.match(/await cmdInstall\(opts\);\n\s*await sayShareGuide\(\{ pause: true \}\);\n\s*setupDoneHints\(\);/g) || [];
  assert.equal(exits.length, 2, "클라우드 · 자체 호스팅 두 출구 모두");
  assert.match(src, /if \(!pause \|\| PROMPTER \|\| !interactive\(\)\) return;/, "앱 · 비대화형에선 멈추지 않는다");
  const say = src.slice(src.indexOf("export async function sayShareGuide("), src.indexOf("async function cmdGuide()"));
  assert.match(say, /finally \{[\s\S]*t\.in\.pause\?\.\(\)[\s\S]*t\.close\(\);/, "★Enter 를 받은 뒤 stdin 을 멈춘다 — Windows 는 close() 가 stdin 을 닫지 않아 흐르는 stdin 이 설치를 안 끝나게 한다");
  assert.match(say, /\["data", "end", "close", "error"\]/, "tty 가 닫히거나 깨져도 기다림이 풀린다");
  assert.match(say, /color: !!TTY/, "★파이프면 isTTY 가 undefined 라 그대로 넘기면 기본값(색 켬)이 끼어든다 — 로그 파일에 색 코드가 섞인다");
  assert.match(src, /case "guide": return cmdGuide\(\);/);
  assert.match(src, /\n  guide {18}누가 무엇을 보나요/, "도움말에 있다");
});
