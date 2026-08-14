// 프리뷰 화면의 파비콘 치환 가드(#1572).
//
// 왜 가드가 필요한가: 이 치환이 조용히 죽어도 화면은 멀쩡히 뜬다 — 라이브와 **똑같은** 아이콘으로. 즉 실패가
// 에러가 아니라 "구분이 안 되는 정상 화면"으로 나타나서, 사람이 라이브를 미리보기로 착각한 뒤에야 드러난다.
// 반대 방향의 실패는 더 조용하다 — 정규식이 넓으면 스타일시트 <link> 까지 지워 화면이 깨지는데, 그건
// 미리보기에서만 나므로 라이브 테스트가 아무것도 못 잡는다. 그래서 양쪽(다 지웠나 · 안 지울 걸 지켰나)을 다 박는다.
//
// 단언은 **모아서 끝에 보고**한다(assert 직행 아님) — 이 파일은 한 함수의 엣지 표를 훑는 구조라, 앞 행에서
// 죽으면 나머지 행이 아예 안 돌아 "무엇까지 깨졌는지"가 안 보인다(mutation 으로 red 를 입증할 때 특히).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPreviewFavicon, isRewritableHtml } from "./preview-favicon.js";

const fails: string[] = [];
const ok = (cond: boolean, msg: string): void => { if (!cond) fails.push(msg); };
const eq = (a: unknown, b: unknown, msg: string): void => { if (a !== b) fails.push(`${msg} (실제 ${JSON.stringify(a)} ≠ 기대 ${JSON.stringify(b)})`); };

const ICON_LINK_ANY = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*icon[^"'>]*["']?[^>]*>/gi;
const icons = (html: string): string[] => html.match(ICON_LINK_ANY) || [];
const PREVIEW_MARK = "1E2A26"; // 미리보기 아이콘의 지문 = 어두운 배경색(라이브엔 없는 색).
//  ⚠ 민트(16C79A)로는 판별할 수 없다 — 미리보기 아이콘의 뷰파인더도 브랜드 민트다(시그니처가 주역이라 그렇다).
//  라이브가 남았는지는 '원래 href 가 사라졌나'로 본다.

// E1 — 라이브 파비콘이 미리보기 아이콘 하나로 갈린다(P1·P2).
{
  const live = `<link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3Ccircle%20fill='%2316C79A'/%3E%3C/svg%3E">`;
  const src = `<!DOCTYPE html><html><head><meta charset="utf-8">${live}<title>Lively Context</title></head><body>x</body></html>`;
  const out = withPreviewFavicon(src);
  eq(icons(out).length, 1, "E1: 아이콘 선언은 정확히 하나여야 한다");
  ok(icons(out)[0]?.includes(PREVIEW_MARK) === true, "E1: 그 하나가 미리보기 아이콘이어야 한다");
  ok(!out.includes(live), "E1: 라이브 아이콘 선언이 남아 있으면 탭 구분이 실패한다");
  ok(out.includes("<title>Lively Context</title>") && out.includes("<body>x</body>"), "E1: 나머지 내용은 보존돼야 한다");
}

// E2 — rel 표기가 어떻든(작은따옴표·따옴표 없음·href 뒤·공백) 잡는다(P2).
for (const tag of [
  `<link rel='icon' href='/a.svg'>`,
  `<link rel=icon href=/a.svg>`,
  `<link href="/a.svg" rel="icon">`,
  `<link  rel = "icon"  href="/a.svg">`,
]) {
  const out = withPreviewFavicon(`<head>${tag}</head>`);
  eq(icons(out).length, 1, `E2: ${tag} → 아이콘 하나만 남아야 한다`);
  ok(icons(out)[0]?.includes(PREVIEW_MARK) === true, `E2: ${tag} → 남은 하나가 미리보기여야 한다`);
  ok(!out.includes("/a.svg"), `E2: ${tag} → 원래 아이콘이 제거돼야 한다`);
}

// E3 — shortcut icon · apple-touch-icon 도 치운다(홈화면 아이콘까지 라이브 행세하면 안 된다).
for (const [tag, href] of [[`<link rel="shortcut icon" href="/f.ico">`, "/f.ico"], [`<link rel="apple-touch-icon" href="/t.png">`, "/t.png"]]) {
  const out = withPreviewFavicon(`<head>${tag}</head>`);
  eq(icons(out).length, 1, `E3: ${tag} → 아이콘 하나만`);
  ok(!out.includes(href), `E3: ${tag} → 제거돼야 한다`);
}

// E4 — head 가 없는 문서도 아이콘을 얻는다(P4. 새로 도입한 HEAD_OPEN_RE 의 '부재' 케이스).
{
  const out = withPreviewFavicon("<p>조각 HTML</p>");
  eq(icons(out).length, 1, "E4: head 없어도 아이콘이 생겨야 한다");
  ok(out.endsWith("<p>조각 HTML</p>"), "E4: 원문은 그대로 뒤에 남아야 한다");
}

// E5 — 속성 있는 head 는 여는 태그 '뒤'(head 안)에 넣는다. 앞에 넣으면 head 밖이라 무시될 수 있다.
{
  const out = withPreviewFavicon(`<html><head lang="ko"><title>t</title></head>`);
  ok(/<head lang="ko"><link\b[^>]*icon/i.test(out), "E5: head 여는 태그 바로 뒤에 들어가야 한다");
  eq(icons(out).length, 1, "E5: 아이콘 하나만");
}

// E6 — 아이콘 선언이 없던 HTML 도 미리보기 아이콘을 얻는다(P4 — 기본 파비콘으로 남으면 구분 실패).
{
  const out = withPreviewFavicon(`<html><head><title>t</title></head><body>b</body></html>`);
  eq(icons(out).length, 1, "E6: 없던 문서에도 아이콘이 생겨야 한다");
  ok(icons(out)[0]?.includes(PREVIEW_MARK) === true, "E6: 미리보기 아이콘이어야 한다");
}

// E7 — 아이콘이 아닌 링크는 건드리지 않는다(P3). 여기가 넓어지면 미리보기에서만 화면이 깨진다.
{
  const keep = [
    `<link rel="stylesheet" href="./styles/01-base.css">`,
    `<link rel="stylesheet" href="/assets/icons.css">`,   // href 에 'icon' 이 있어도 rel 은 스타일시트다
    `<link rel="preload" as="image" href="/img/icon.svg">`,
    `<link rel="manifest" href="/site.webmanifest">`,
  ];
  const out = withPreviewFavicon(`<head>${keep.join("")}<link rel="icon" href="/f.svg"></head>`);
  for (const k of keep) ok(out.includes(k), `E7: 보존돼야 할 링크가 지워졌다 → ${k}`);
  ok(!out.includes("/f.svg"), "E7: 진짜 아이콘만 지워져야 한다");
}

// E8 — 실물: 프리뷰로 서빙되는 진짜 화면들. 화면마다 파비콘 모양이 달라(터미널·그래프…) 정규식이 하나라도
//  놓치면 여기서 잡힌다. 동시에 '아이콘 외 바이트 보존'을 아이콘 줄 제외 비교로 확인한다.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, "../../public"); // dist/preview → 레포 루트/public
  for (const f of ["index.html", "graph.html", "terminal.html", "terminal-grid.html"]) {
    const src = readFileSync(path.join(publicDir, f), "utf8");
    eq(icons(src).length, 1, `E8: ${f} 원본에 아이콘 선언이 하나 있어야 한다(전제 — 이게 깨지면 테스트가 헛것을 본다)`);
    const out = withPreviewFavicon(src);
    eq(icons(out).length, 1, `E8: ${f} 치환 후에도 아이콘은 하나`);
    ok(icons(out)[0]?.includes(PREVIEW_MARK) === true, `E8: ${f} 미리보기 아이콘이어야 한다`);
    ok(!out.includes(icons(src)[0]), `E8: ${f} 원래 아이콘 선언이 남으면 안 된다`);
    ok(out.replace(ICON_LINK_ANY, "") === src.replace(ICON_LINK_ANY, ""), `E8: ${f} 아이콘 외 내용이 변조됐다`);
  }
}

// E9~E12 — 어떤 응답을 건드려도 되는가(P5). 잘못 true 면 JS·이미지가 깨지고, 잘못 false 면 아이콘이 안 바뀐다.
{
  eq(isRewritableHtml("text/html; charset=utf-8", undefined), true, "E9: HTML(utf-8)");
  eq(isRewritableHtml("text/html", undefined), true, "E9: charset 미명시는 통과(우리 화면 전제)");
  eq(isRewritableHtml("TEXT/HTML; CHARSET=UTF-8", undefined), true, "E9: 대소문자 무관");
  eq(isRewritableHtml("text/html", ""), true, "E10 경계: 빈 인코딩 = 무압축");
  eq(isRewritableHtml("text/html", "identity"), true, "E10 경계: identity = 무압축");
  eq(isRewritableHtml("application/javascript; charset=utf-8", undefined), false, "E11: JS 를 건드리면 화면이 깨진다");
  eq(isRewritableHtml("image/svg+xml", undefined), false, "E11: SVG");
  eq(isRewritableHtml("application/json", undefined), false, "E11: JSON");
  eq(isRewritableHtml(undefined, undefined), false, "E11: content-type 부재");
  eq(isRewritableHtml("text/html; charset=utf-8", "gzip"), false, "E12: 압축 바디를 문자열로 다루면 응답이 깨진다");
  eq(isRewritableHtml("text/html; charset=euc-kr", undefined), false, "E12: utf-8 아닌 바디는 손대지 않는다");
}

if (fails.length > 0) {
  console.error(`preview-favicon: ${fails.length}건 실패`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("preview-favicon: ok");
