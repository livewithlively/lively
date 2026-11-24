// «누가 무엇을 보나요» 첫 안내(#5598) — 웹 카드의 규칙(web/lib/share-guide-rules.ts) · CLI 설치 끝 상자(kit/cli/lively.mjs) · 배선.
//
//  ⚠ web 은 dist 로 굽히지 않는다 — 순수 모듈의 소스를 TypeScript 로 옮긴 뒤 불러온다(project-access-ui.test.ts 와 같은 방식).
//
//  사양 · 엣지 표(spec-failfirst)
//   R1  워크스페이스 설정 → 2장 갈래: 못 읽음(null) → 초대제 · open → 전체 공개 · ★enforced=false(축 꺼짐) → «팀 전원»(초대제라도)
//   R2  자동으로 띄우지 않는 자리: 처음 설정 · 승인 · 앱 전체 화면 · 앱 허가 · 앱 열기 · 다시 보기 주소 자신.
//       경계 — 그 이름으로 시작하는 다른 주소(#/welcomes)는 막지 않는다 · 쿼리가 붙어도(#/welcome?resume=1) 막는다 · 빈 주소는 띄운다
//   R3  (2026-11-22 안내 팝업으로 바꿈) 1~4장은 개념 설명(AI 세션 · 프로젝트 · 자료 · 지식) — 갈래와 상관없이 같은 문구.
//       5장 «누가 무엇을 볼 수 있나요» 만 갈래를 탄다: 초대제는 «AI 세션과 프로젝트는 나와 내가 초대한 사람만,» ↵ «자료와 지식은 팀 전원»
//       · 전체 공개 · 축 꺼짐은 «AI 세션은 …,» ↵ «프로젝트 · 자료 · 지식은 팀 전원» — ★줄은 «사람만,» 바로 뒤에서 나눈다(<br>)
//   R4  그림 위 뱃지는 없다(권한 팝업이 아니다) · «남아요/안 남아요» 같은 말은 없다
//   R6  ★사실만 — «앱에서 가져온 자료는 원래 볼 수 있던 사람만» 같은 거짓 문구가 없다 · 요약 4줄(세션 · 프로젝트 · 자료 · 지식)이 있고
//       세션 줄은 «관리자도 대화 내용은 못 봐요», 자료 줄은 «올린 파일 · AI가 만든 파일은 팀 전원» 을 말한다 · 실제 로고(슬랙 · 노션 · 드라이브)를 쓴다
//   R5  다시 보기 주소 — #/share-guide · #/share-guide?x · 다른 주소는 아니다
//   C1  ★CLI 상자 — 모든 갈래 × 링크 유무에서 상자 줄의 화면 폭이 같다(오른쪽 테두리가 맞는다, 한글 2칸)
//   C2  CLI 상자 안엔 폭이 터미널마다 다른 기호(· — ↵)가 없다
//   C3  CLI 프로젝트 줄 — 초대제는 «나와 초대한 사람만 봐요» 가 먼저 · 둘째 줄 «초대받아도 남의 세션 안은 못 봐요» · 전체 공개는 «팀 전원»
//       · 네 줄(AI 세션 · 프로젝트 · 자료 · 지식) — 웹 요약과 같은 사실
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

//  R7 — 온보딩 영상(기초) 창을 자동으로 띄울까(상민 2026-11-24: 처음 설정의 영상 ↔ 셸의 안내 카드 자리 바꿈). 엣지 표:
//   E1 due 있음 · seen 없음 · 안내 확인함 · #/            → 띄운다
//   E2 due 없음(이 변경 전부터 쓰던 구성원)                → 안 띄운다
//   E3 due · seen 둘 다 있음                               → 안 띄운다(한 번만)
//   E4 지나가는 자리(#/welcome · #/full · #/activate …)    → 안 띄운다
//   E5 안내 확인 표식 없음(카드 팝업이 뜰 차례)            → 안 띄운다 — 창은 한 번에 하나
//   E6 프로필 null · 새 칸 undefined(옛 서버) · 빈 문자열  → 안 띄운다
//   E7 경계 — #/welcomes 는 지나가는 자리가 아니다          → 띄운다
test("R7 온보딩 영상 창 — 처음 설정을 지난 사람에게 한 번 · 기존 구성원에겐 안 뜬다", async () => {
  const m = await loadRules();
  const due = { share_guide_seen_at: "2026-11-24T00:00:00Z", welcome_film_due_at: "2026-11-24T00:00:01Z", welcome_film_seen_at: null };
  assert.equal(m.welcomeFilmAutoDue(due, "#/"), true, "E1");
  assert.equal(m.welcomeFilmAutoDue(due, "#/s/abc"), true, "E1 — 세션 화면에서도");
  assert.equal(m.welcomeFilmAutoDue({ ...due, welcome_film_due_at: null }, "#/"), false, "E2 ★기존 구성원에게 영상이 뜬다");
  assert.equal(m.welcomeFilmAutoDue({ ...due, welcome_film_seen_at: "2026-11-24T00:01:00Z" }, "#/"), false, "E3 ★본 사람에게 또 뜬다");
  for (const h of ["#/welcome", "#/welcome?resume=1", "#/full/x", "#/activate?code=AB", "#/share-guide", "#/app-open/2"]) {
    assert.equal(m.welcomeFilmAutoDue(due, h), false, "E4 " + h);
  }
  assert.equal(m.welcomeFilmAutoDue({ ...due, share_guide_seen_at: null }, "#/"), false, "E5 ★카드 팝업과 영상 창이 겹친다");
  assert.equal(m.welcomeFilmAutoDue(null, "#/"), false, "E6 null");
  assert.equal(m.welcomeFilmAutoDue(undefined, "#/"), false, "E6 undefined");
  assert.equal(m.welcomeFilmAutoDue({ share_guide_seen_at: "x" }, "#/"), false, "E6 옛 서버 — 새 칸이 없다");
  assert.equal(m.welcomeFilmAutoDue({ ...due, welcome_film_due_at: "" }, "#/"), false, "E6 빈 문자열");
  assert.equal(m.welcomeFilmAutoDue(due, "#/welcomes"), true, "E7");
  assert.equal(m.welcomeFilmAutoDue(due, ""), true, "E7 — 빈 주소는 홈이다");
});

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

test("R3 1~4장은 개념 설명 · 5장만 갈래 — 줄은 «사람만,» 뒤에서 나눈다", async () => {
  const m = await loadRules();
  assert.deepEqual(m.SG_STEPS.map((s: { scene: string }) => s.scene), ["s1", "s2", "s3", "s4", "s5"]);
  const t = (i: number, md: string) => m.SG_STEPS[i].title(md);
  assert.equal(t(0, "invite"), "AI 세션은 AI와 일하는 대화창이에요");
  assert.equal(t(1, "invite"), "프로젝트는 한 가지 일을 모아 두는 곳이에요");
  assert.equal(t(2, "invite"), "자료는 AI가 읽는 회사의 글과 파일이에요");
  assert.equal(t(3, "invite"), "지식은 AI가 정리해 둔 메모예요");
  for (let i = 0; i < 4; i++) {
    assert.equal(m.SG_STEPS[i].lead("invite"), m.SG_STEPS[i].lead("open"), `${i + 1}장은 갈래를 타지 않는다`);
    assert.equal(t(i, "invite"), t(i, "all"));
  }
  const last = m.SG_STEPS[4];
  assert.equal(last.title("invite"), "누가 무엇을 볼 수 있나요");
  assert.equal(text(last.lead("invite").replace("<br>", "\n")), "AI 세션과 프로젝트는 나와 내가 초대한 사람만,\n자료와 지식은 팀 전원이 봐요.");
  for (const md of ["open", "all"]) {
    assert.equal(text(last.lead(md).replace("<br>", "\n")), "AI 세션은 나와 내가 초대한 사람만,\n프로젝트 · 자료 · 지식은 팀 전원이 봐요.", md);
  }
  assert.match(last.extra(), /\/lively-disconnect/);
  assert.match(m.SG_STEPS[3].extra(), /지식으로 남기기 싫을 때는\?/);
});

test("R4 그림 위 뱃지 없음 · «남아요» 류 금지", async () => {
  const m = await loadRules();
  assert.equal(m.SG_STEPS.length, 5);
  for (const s of m.SG_STEPS) {
    assert.equal("badges" in s, false, s.scene);
    for (const md of ["invite", "open", "all"]) assert.doesNotMatch(text(s.title(md) + s.lead(md)), /남아요|안 남아요|작업 폴더/, s.scene);
  }
  assert.doesNotMatch(readFileSync("web/v2/share-guide.ts", "utf8"), /badges/);
});

test("R6 ★사실만 — 거짓 문구 없음 · 요약 4줄 · 실제 로고", async () => {
  const m = await loadRules();
  const mk = readFileSync("web/v2/share-guide-markup.ts", "utf8");
  const all = mk + m.SG_STEPS.map((s: { title: (x: string) => string; lead: (x: string) => string; extra?: () => string }) =>
    s.title("invite") + s.lead("invite") + (s.extra ? s.extra() : "")).join("");
  assert.doesNotMatch(text(all), /원래 볼 수 있던/, "앱에서 모은 자료는 기본이 열려 있다(관리자 규칙이 없으면) — «원래 보던 사람만» 은 거짓");
  const recap = mk.slice(mk.indexOf('class="sg-rcap"'));
  const rows = recap.match(/class="sg-rrow/g) || [];
  assert.equal(rows.length, 4, "세션 · 프로젝트 · 자료 · 지식");
  assert.match(recap, /관리자도 대화 내용은 못 봐요/);
  assert.match(text(recap), /올린 파일 · AI가 만든 파일은 팀 전원이 찾아봐요/);
  assert.match(text(recap), /닫힌 자료에서 나온 지식은 그 자료를 볼 수 있는 사람만/);
  for (const id of ["slack", "notion", "google-drive"]) {
    assert.match(mk, new RegExp(`<symbol id="sg-lg-${id}" viewBox="0 0 \\d+ \\d+"><path`), id);
    assert.match(mk, new RegExp(`href="#sg-lg-${id}"`), `${id} 로고를 그림에서 쓴다`);
  }
  assert.doesNotMatch(mk, /class="sg-tile/, "글자 상자(S · N)로 로고를 흉내 내지 않는다");
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
    for (const link of ["", "https://acme.app.lvly.io/ui/#/film/intro"]) {
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
    for (const l of boxLines(c.shareGuideLines({ mode, link: "https://x/ui/#/film/intro", color: false }))) {
      assert.doesNotMatch(l, /[·—↵]/, l);
    }
  }
});

test("C3 CLI 네 줄 — 웹 요약과 같은 사실 · 프로젝트 줄은 갈래를 탄다", async () => {
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
  for (const ls of [inv, open, all]) {
    const at = (re: RegExp) => ls.findIndex((l: string) => re.test(l));
    const s = at(/AI 세션\s+비공개\s+나와 초대한 사람만 봐요/);
    assert.ok(s >= 0); assert.match(ls[s + 1], /관리자도 대화 내용은 못 봐요/);
    const d = at(/자료\s+전체 공개\s+올린 파일과 AI가 만든 파일은 팀 전원이 봐요/);
    assert.ok(d >= 0, "자료 줄"); assert.match(ls[d + 1], /앱에서 모은 자료는 모을 때 정한 범위만큼/);
    const k = at(/지식\s+전체 공개\s+AI가 정리한 글을 팀 전원이 봐요/);
    assert.ok(k > d, "지식 줄은 자료 줄 뒤"); assert.match(ls[k + 1], /닫힌 자료로 만든 지식은 그 자료를 보는 사람만/);
    assert.ok(s < at(/프로젝트\s/) && at(/프로젝트\s/) < d, "순서: 세션 · 프로젝트 · 자료 · 지식");
    assert.ok(!ls.some((l: string) => /원래 볼 수 있던|AI가 정리한 글만/.test(l)));
    assert.ok(ls.some((l: string) => l.includes("lively run --readonly") && l.includes("--incognito")));
    assert.ok(ls.some((l: string) => l.includes("/lively-disconnect")));
  }
});

test("C4 색 끄기 · 좁은 창 · 링크 없음", async () => {
  const c = await loadCli();
  assert.ok(!c.shareGuideLines({ color: false }).join("\n").includes("\u001b"));
  assert.ok(c.shareGuideLines({ color: true }).join("\n").includes("\u001b[48;5;62"), "색을 켜면 머리 띠 · 뱃지에 바탕색이 있다");
  const narrow = c.shareGuideLines({ color: false, narrow: true, link: "https://x/ui/#/film/intro" });
  assert.equal(boxLines(narrow).length, 0);
  assert.ok(narrow.some((l: string) => l.includes("안내 영상 보기: https://x/ui/#/film/intro")), "좁은 창 — 영상 링크 줄");
  assert.ok(!c.shareGuideLines({ color: false, link: "" }).some((l: string) => l.includes("안내 영상")));
  // 상민 2026-11-24 — 제목은 «접근 권한 안내», 링크는 팝업이 아니라 둘러보기 영상.
  const box = c.shareGuideLines({ color: false, link: "https://x/ui/#/film/intro" });
  assert.ok(box.some((l: string) => /라이블리 \/ 접근 권한 안내/.test(l)), "상자 제목");
  assert.ok(narrow.some((l: string) => /라이블리 \/ 접근 권한 안내/.test(l)), "좁은 창 제목");
  assert.ok(!box.concat(narrow).some((l: string) => /누가 무엇을 보나요|1분 안내/.test(l)), "옛 제목 · 옛 링크 글이 남았다");
  assert.ok(box.some((l: string) => l.includes("안내 영상 보기  https://x/ui/#/film/intro")), "상자 — 영상 링크 줄");
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
  assert.match(main, /const openFilm = boot \? filmOfRoute\(boot\) : null;\n\s*if \(openFilm\) boot = null;/, "영상 주소로 켜면 탭은 그대로 두고 창만 연다");
  assert.match(main, /else if \(openFilm\) \{[\s\S]{0,260}openWelcomeFilm\(openFilm\);/, "켤 때 영상 창을 연다");
  assert.match(main, /const film = filmOfRoute\(hash\);\n\s*if \(film\) \{\n\s*openWelcomeFilm\(film\);/, "주소가 바뀌어도 영상 창으로 연다");
  const sg = readFileSync("web/v2/share-guide.ts", "utf8");
  assert.match(sg, /if \(!p\?\.share_guide_seen_at\) \{ openShareGuide\(\); return; \}/, "확인 안 한 사람에겐 카드가 먼저");
  assert.match(sg, /if \(welcomeFilmAutoDue\(p, location\.hash\)\) \{ markWelcomeFilmSeen\(\); openWelcomeFilm\(WELCOME_FILM, FIRST_FILM_HEAD\); \}/, "★띄우면서 «띄웠다» 를 남긴다 — 안 남기면 켤 때마다 뜬다");
  assert.match(sg, /welcome_film_due: true/); assert.match(sg, /welcome_film_seen: true/);
  assert.match(sg, /share_guide_seen: true/);
  assert.match(sg, /catch \(_\) \{ return; \}/, "표식을 못 읽으면 띄우지 않는다");
});

test("W2 배선 — 서버 표식", () => {
  const liv = readFileSync("src/capabilities/delivery/liv.ts", "utf8");
  assert.match(liv, /const shareGuideSeen = input\.share_guide_seen === true/);
  assert.match(liv, /!desktopSeen && !shareGuideSeen && /, "이 표식만 와도 400 이 아니다");
  assert.match(liv, /\n\s*shareGuideSeen,\n/);
  assert.match(liv, /share_guide_seen: z\.boolean\(\)\.optional\(\)/);
  assert.match(liv, /share_guide_seen_at: p\.share_guide_seen_at \?\? null/, "GET 이 돌려준다");
  const mem = readFileSync("src/org/store/members.ts", "utf8");
  assert.match(mem, /if \(patch\.shareGuideSeen && !cur\.share_guide_seen_at\) next\.share_guide_seen_at =/, "처음 시각을 지킨다");
  // S1~S3 — 온보딩 영상 창 표식 둘(due · seen): 그 표식만 와도 400 이 아니다 · 처음 시각을 지킨다 · GET 이 돌려준다.
  assert.match(liv, /const welcomeFilmDue = input\.welcome_film_due === true/);
  assert.match(liv, /const welcomeFilmSeen = input\.welcome_film_seen === true/);
  assert.match(liv, /!shareGuideSeen && !welcomeFilmDue && !welcomeFilmSeen\) throw/, "S1·S2 이 표식만 와도 400 이 아니다");
  assert.match(liv, /welcomeFilmDue,\n\s*welcomeFilmSeen,\n\s*\}\);/, "저장으로 넘긴다");
  assert.match(liv, /welcome_film_due: z\.boolean\(\)\.optional\(\)/); assert.match(liv, /welcome_film_seen: z\.boolean\(\)\.optional\(\)/);
  assert.match(liv, /welcome_film_due_at: p\.welcome_film_due_at \?\? null, welcome_film_seen_at: p\.welcome_film_seen_at \?\? null/, "S3 GET 이 돌려준다");
  assert.match(mem, /if \(patch\.welcomeFilmDue && !cur\.welcome_film_due_at\) next\.welcome_film_due_at =/, "S1 처음 시각을 지킨다");
  assert.match(mem, /if \(patch\.welcomeFilmSeen && !cur\.welcome_film_seen_at\) next\.welcome_film_seen_at =/, "S2 처음 시각을 지킨다");
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
  assert.match(src, /\n  guide {18}접근 권한 안내/, "도움말에 있다");
  assert.match(say, /const link = gw \? `\$\{gw\}\/ui\/#\/film\/intro` : "";/, "★상자의 링크가 둘러보기 영상을 열지 않는다");
});
