// 프로젝트 파일 응답의 캐시 머리(#3870) — **판이 실린 미리보기만** 브라우저가 보관해도 된다.
//
// 신고(원준 2026-09-30): «미리보기 보이는거 왜캐 느리고 오래 기다려야하고 좀 별로야».
//  실측(매니지드): 파일 하나에 0.34~0.55초가 고정으로 들고(12바이트 파일도 같다 — 멤버 저장소 왕복), 응답이 `no-store` 라
//  곁칸 자료를 열 때마다·폴더를 오갈 때마다 전부 다시 받았다(14칸 중 마지막 3.2초 · 다시 열어도 2.9초).
// 사양 — 요청 주소의 `v` = `<내림한 mtime>.<size>`(web/v2/file-preview.ts pvVersion 이 목록의 값으로 만든다):
//  · v 가 지금 파일과 **같으면** 오래 보관(private · immutable) + Vary(다른 사람 토큰·쿠키에는 보관본을 주지 않는다)
//  · v 가 없거나 다르거나(바뀐 뒤 옛 주소) 내려받기(download=1)면 종전 그대로 no-store
// 틀리면 티가 크다:
//   🔴 판이 달라도 보관하면 — 바뀐 파일의 옛 그림이 한 달 동안 뜬다(고친 시안이 곁칸에서 안 바뀐다).
//   🔴 Vary 가 없으면 — 같은 브라우저에서 로그아웃 뒤 다른 사람이 같은 주소로 남의 파일 보관본을 받는다.
// 라우트는 DB(가시성 판정)를 타서 단위로 못 올린다 → 판정을 순수 함수로 떼어 표로 고정하고, 라우트가 그걸 쓰는지는 소스로 본다.
// 실행: npm run build && node dist/project/project-file-cache.test.js
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fileCacheHeaders } from "./project-routes.js";

let pass = 0;
const eq = (got: unknown, want: unknown, n: string): void => { assert.deepEqual(got, want, `${n}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${n}`); };
const KEEP = { "Cache-Control": "private, max-age=2592000, immutable", Vary: "Authorization, Cookie" };
const NO = { "Cache-Control": "no-store" };
const st = { mtime: 1790755112311, size: 25077 };

// ── 표 ──
eq(fileCacheHeaders("1790755112311.25077", st, false), KEEP, "C1 판이 같다 → 보관(+Vary)");
eq(fileCacheHeaders(undefined, st, false), NO, "C2 판 없음(뷰어·옛 화면) → no-store 그대로");
eq(fileCacheHeaders("", st, false), NO, "C3 빈 판 → no-store");
eq(fileCacheHeaders("1790755112311.25078", st, false), NO, "C4 크기가 다르다(같은 시각에 다시 저장) → no-store");
eq(fileCacheHeaders("1790755112310.25077", st, false), NO, "C5 시각이 다르다(바뀐 뒤 옛 주소) → no-store");
eq(fileCacheHeaders("1790755112311.25077", st, true), NO, "C6 내려받기(download=1) → no-store(판이 맞아도)");
eq(fileCacheHeaders("1790755112311.25077", { mtime: 1790755112311.9, size: 25077 }, false), KEEP, "C7 경계: 저장소 시각에 소수가 있어도 내림으로 맞춘다(화면 목록이 내림이다)");
eq(fileCacheHeaders(["1790755112311.25077"], st, false), NO, "C8 경계: v 가 두 번 실려 배열로 오면 판으로 치지 않는다");
eq(fileCacheHeaders("1790755112311.25077 ", st, false), NO, "C9 경계: 판 뒤에 군더더기가 붙으면 다른 판이다");

// ── 배선 — 라우트가 이 판정을 실제로 쓰는가(판정만 맞고 안 부르면 그대로 no-store 다) ──
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)).replace(/dist$/, "src"), "..", "..", "src", "project", "project-routes.ts"), "utf8");
const fileRoute = src.slice(src.indexOf("app.get(`${prefix}/:id/file`"), src.indexOf("app.put(`${prefix}/:id/file`"));
assert.ok(fileRoute.length > 100, "GET /file 라우트를 못 찾았다");
assert.ok(/fileCacheHeaders\(req\.query\.v, st, download\)/.test(fileRoute), "GET /file 이 fileCacheHeaders(req.query.v, st, download) 로 캐시 머리를 정해야 한다");
pass++; console.log("ok  W1 GET /file 이 판정을 쓴다");
assert.doesNotMatch(fileRoute.replace(/\/\/.*$/gm, ""), /setHeader\("Cache-Control", "no-store"\)/, "GET /file 에 판정을 덮어쓰는 no-store 가 남아 있다");
pass++; console.log("ok  W2 판정을 덮어쓰는 no-store 가 없다");

console.log(`\n${pass} 개 통과`);
