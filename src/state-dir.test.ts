// #618 가드레일 — 게이트웨이 런타임 쓰기 경로는 반드시 state-dir.ts 의 stateDir()/stateRoot() 로만.
//  cwd-상대/하드코딩 런타임 dir(예: "var/repos", process.cwd()+"data")이 헬퍼 밖에서 다시 새면
//  서비스유저↔디렉 소유 불일치로 EACCES 가 재발한다(#606 도메인맵 스캐너처럼 조용히). 이 테스트가 그걸 CI 에서 잡는다.
//  ※ 소스(src/*.ts)를 스캔한다 — 빌드 산출(dist)이 아니라 저장소 루트의 src 를 읽는다(npm test 는 저장소 루트에서 실행).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
// 런타임 루트를 정의하는 유일 지점만 허용(그 외 파일이 cwd-상대 런타임 dir 를 직접 만들면 위반).
const ALLOW = new Set(["src/state-dir.ts"]);
const BAD = [
  { re: /process\.cwd\(\)\s*,\s*["']data["']/, why: 'cwd-상대 data 디렉 — stateDir(...) 사용' },
  { re: /["']var\/repos["']/, why: 'var/repos 리터럴 — stateDir("repos") 사용' },
  { re: /\?\?\s*["']var\//, why: 'cwd-상대 var/ 디폴트 — stateDir(...) 사용' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") out.push(...walk(p)); }
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const violations: string[] = [];
for (const f of walk(SRC)) {
  const rel = path.relative(process.cwd(), f).split(path.sep).join("/");
  if (ALLOW.has(rel)) continue;
  readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
    if (ln.trim().startsWith("//") || ln.trim().startsWith("*")) return; // 주석 제외
    for (const b of BAD) if (b.re.test(ln)) violations.push(`${rel}:${i + 1} — ${b.why}\n    ${ln.trim()}`);
  });
}

assert.equal(violations.length, 0, "런타임 쓰기 경로 가드레일 위반(state-dir stateDir() 로 라우팅하세요):\n" + violations.join("\n"));
console.log("ok  #618 state-dir 가드레일 — 헬퍼 밖 cwd-상대/하드코딩 런타임 dir 없음");
