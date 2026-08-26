// 프로젝트 자료(파일) 목록 — **폴더가 아직 디스크에 없는 프로젝트**의 응답 계약을 고정한다.
//
// 실측(2026-08-25 매니지드 도그푸드): 대화로 방금 만든 프로젝트를 열자 자료 화면이 통째로 깨졌다.
//  `GET /api/ui/v6/projects/1936/files?path=` → **404**. 원인은 데이터가 아니라 계약이었다 — DB 엔 폴더
//  경로가 배정돼 있는데(project.folder) 물리 디렉터리는 첫 세션·첫 업로드가 만들기 전까지 없다. 그 사이
//  readdir 이 실패하고 404 가 나갔다. 사용자가 본 것은 "빈 폴더"가 아니라 "없는 프로젝트"였다.
// 왜 눈으로 잡기 어려운가: 개발 환경에선 세션이 곧바로 떠 폴더가 생기므로 이 창이 거의 안 보인다.
//  매니지드처럼 세션이 늦게 뜨거나 실패하면 **정상 경로에서** 재현된다.
// 틀리면 티가 크다:
//   🔴 404 를 그대로 두면 — 새 프로젝트의 자료 탭이 깨진 화면으로 보인다(이번 사고).
//   🔴 반대로 없는 **하위 경로**까지 빈 목록으로 덮으면 — 오타·죽은 링크가 조용히 "빈 폴더"로 보인다(더 나쁜 거짓말).
// 라우트 자체는 DB(가시성 판정)를 타므로 단위테스트로 못 올린다 → 갈림길을 순수 함수로 떼어 표로 고정하고,
//  호출부가 그 판정을 실제로 쓰는지는 소스 텍스트로 확인한다(판정만 맞고 안 부르면 버그는 그대로다).
// 실행: npm run build && node dist/project/project-files-missing-dir.test.js
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { missingDirResponse } from "./project-routes.js";

let pass = 0;
const eq = (got: unknown, want: unknown, n: string): void => { assert.deepEqual(got, want, `${n}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${n}`); };
const EMPTY = { path: "", parent: null, items: [] };
const base = path.resolve("/srv/work/project/1936");

// ── 표. 못 읽은 경로가 루트인가 ──
eq(missingDirResponse(base, base), EMPTY, "A1 루트 자신 → 빈 폴더(이번 사고의 그 자리)");
eq(missingDirResponse(base, path.join(base, "sub")), null, "A2 하위 경로 → null(호출자가 404) · 없는 경로는 없다고 말한다");
eq(missingDirResponse(base, path.join(base, "a", "b")), null, "A3 깊은 하위 경로 → null");
eq(missingDirResponse(base, base + path.sep), EMPTY, "A4 경계: 끝에 구분자가 붙어도 루트다");
eq(missingDirResponse(base, path.join(base, ".")), EMPTY, "A5 경계: '.' 로 해소돼도 루트다");
eq(missingDirResponse(base, path.resolve(base, "..")), null, "A6 경계: 상위로 나간 경로는 루트가 아니다(빈 목록으로 덮으면 범위 밖을 '빈 폴더'라 말하게 된다)");
eq(missingDirResponse(base, path.resolve(base, "../1937")), null, "A7 경계: 형제 프로젝트 폴더도 루트가 아니다");

// ── 배선 — 라우트가 이 판정을 실제로 쓰는가 ──
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)).replace(/dist$/, "src"), "..", "..", "src", "project", "project-routes.ts"), "utf8");
assert.ok(/catch\s*{[\s\S]{0,900}?missingDirResponse\(base, abs\)/.test(src),
  "readdir 실패 catch 가 missingDirResponse 를 거쳐야 한다 — 안 거치면 404 가 그대로 나간다");
pass++; console.log("ok  B1 readdir 실패 경로가 판정을 거친다");
assert.ok(/missingDirResponse\(base, abs\);[\s\S]{0,200}?throw new HttpError\(404/.test(src),
  "판정이 null 이면 404 를 던져야 한다(하위 경로를 조용히 빈 목록으로 덮지 않는다)");
pass++; console.log("ok  B2 판정이 null 이면 404 를 유지한다");

console.log(`\n${pass} 개 통과`);
