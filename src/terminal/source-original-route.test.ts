// #1631 — 팀원 모두가 보게 올린 개인 폴더 자료(share=team)의 원본을 동료가 열 수 있어야 한다.
//
//  합류자 처음 설정의 파일은 «올린 사람의 개인 폴더 + share=team» 으로 들어가 팀원 모두가 자료 목록·원문에서 본다.
//  그런데 자료 화면의 미리보기·내려받기는 브라우즈 API(`/api/ui/terminal/browse/file?root=personal&path=…`)를 불렀고,
//  그 주소는 **보는 사람 자기** 개인 폴더로 풀린다(resolveRootPath 가 요청자로 base 를 잡는다). 그래서 동료에게는
//  «파일 없음» 이거나, 같은 이름의 **자기 파일**이 그 자료의 원본인 척 열렸다.
//  고침: 자료 id 로 여는 창구(GET /api/ui/sources/:id/original) — 좌표는 요청이 아니라 자료 행(external_id)에서 풀고,
//  공개범위는 자료 상세와 같은 판정(getSource)을 지난다. MCP source_artifact 와 같은 규칙.
//
//  DB·파일시스템 바운드라 유닛으로 끝까지 못 몬다 — 구조를 소스에서 못박는다(nonhuman-login.test.ts 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TF = readFileSync("src/terminal/terminal-files.ts", "utf8");
const SRC = readFileSync("web/v2/sources.ts", "utf8");

/** registerTerminalFiles 안의 라우트 하나(다음 `  app.` 전까지). */
function routeBody(head: string): string {
  const a = TF.indexOf(head);
  assert.ok(a >= 0, `라우트가 없다: ${head}`);
  const b = TF.indexOf("\n  app.", a + head.length);
  return TF.slice(a, b > 0 ? b : TF.length);
}

test("★★ 자료 원본 창구 — 좌표는 요청이 아니라 자료 행에서, 공개범위는 자료 상세와 같은 판정", () => {
  const r = routeBody('app.get("/api/ui/sources/:id/original"');
  //  신원 없는 요청(viewer=null)은 공개범위를 건너뛰는 특권 경로다 — 원본 바이트를 올린 사람 권한으로 내보내는 자리라 창구가 직접 막는다
  //   (인증 계층이 userId 없는 신원을 들이지 않지만, 그 보장은 다른 파일에 있다 — 격리 보안 리뷰 제안).
  assert.match(r, /const viewer = viewerFor\(req\);\s*if \(!viewer\) throw new HttpError\(404/, "★ 신원 없는 요청(viewer=null)을 막지 않는다 — 공개범위를 건너뛴 채 남의 파일을 그 사람 권한으로 내보낸다");
  assert.match(r, /await getSource\(id, viewer\)/, "★ 공개범위를 안 본다 — id 만 알면 잠긴 자료의 원본을 받는다");
  assert.match(r, /external_system === LOCAL_SYSTEM/, "올린 파일 자료가 아닌데 파일 좌표를 푼다");
  assert.match(r, /parseLocalExternalId\(/, "파일 좌표를 자료 행(external_id)에서 풀지 않는다");
  assert.doesNotMatch(r, /req\.query\.(root|path)/, "★ 요청의 root·path 로 파일을 고른다 — 남의 파일을 고를 수 있다");
  assert.ok(r.indexOf("getSource(") < r.indexOf("resolveRootPath("), "공개범위보다 파일 해소가 먼저다");
});

test("★ 자료 원본 창구는 개인 폴더 파일만 — 올린 사람의 OS 사용자로 읽고 심링크 봉쇄를 건다", () => {
  const r = routeBody('app.get("/api/ui/sources/:id/original"');
  assert.match(r, /root\.kind !== "personal"/, "개인 폴더 밖까지 연다 — 공유·프로젝트는 폴더 공개범위 게이트가 있는 브라우즈 API 로 연다");
  assert.match(r, /userOsUser\(owner\)/, "올린 사람의 OS 사용자로 읽지 않는다 — 게이트웨이 권한으로 읽으면 심링크가 박스 파일에 닿는다");
  assert.match(r, /resolveRootPath\(owner, "personal", /, "올린 사람의 개인 폴더로 풀지 않는다");
  assert.match(r, /assertJailed\(base, abs, osUser\)/, "심링크를 해소한 뒤 다시 보지 않는다(#3668 T1)");
  assert.match(r, /sendFile\(res, abs, osUser, /, "미리보기 상한·헤더를 브라우즈와 다른 코드로 보낸다");
  //  브라우즈 파일 받기와 같은 한 벌 — 상한(MAX_PREVIEW)·Content-Disposition·no-store 가 갈리지 않게.
  assert.match(routeBody('app.get("/api/ui/terminal/browse/file"'), /sendFile\(res, abs, osUser, /);
});

test("★ 자료 화면 — 개인 폴더 파일의 미리보기·내려받기는 자료 id 창구로, 남의 개인 폴더 «폴더에서 열기» 는 그리지 않는다", () => {
  const f = SRC.slice(SRC.indexOf("function readSheet("), SRC.indexOf("const thread: HTMLElement[] = [];"));
  assert.match(f, /co && co\.root === 'personal' \? '\/api\/ui\/sources\/' \+ encodeURIComponent\(String\(s\.id\)\) \+ '\/original' : null/,
    "★ 개인 폴더 파일을 브라우즈 API 로 연다 — 보는 사람 자기 폴더로 풀려 동료에게는 없는 파일이거나 엉뚱한(자기) 파일이다");
  assert.match(f, /const dl = orig \? orig \+ '\?download=1' : /, "머리 [내려받기] 가 자료 id 창구를 안 쓴다");
  assert.match(f, /const viewUrl = orig \?\? /, "원문 미리보기가 자료 id 창구를 안 쓴다");
  assert.match(f, /const dlUrl = orig \? orig \+ '\?download=1' : /, "원문 칸 내려받기가 자료 id 창구를 안 쓴다");
  assert.match(f, /if \(!orig \|\| mine\) acts\.append\(/, "남의 개인 폴더 주소로 «폴더에서 열기» 를 그린다 — 그 주소는 내 폴더로 풀린다");
});
