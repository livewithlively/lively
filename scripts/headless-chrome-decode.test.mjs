#!/usr/bin/env node
// 헤드리스 크롬 시험 틀(scripts/headless-chrome.mjs dumpDom) — 한글이 출력 조각 경계에서 깨지지 않는다
//
//  CI 실측(2026-10-09, merge_group run 37888867454): session-history-side-runtime H9 가
//   기대 «기타 (미분류) 2» · 실제 «���타 (미분류) 2» 로 떨어졌다. dumpDom 이 stdout 조각(Buffer)을 하나씩 글자로 바꿔
//   이어 붙여, 3바이트 한글 한 글자가 두 조각에 걸치면 양쪽이 각각 깨진다. 조각 경계는 실행마다 달라 무작위로 빨갛다.
//
// 사양(행마다 단언 하나 이상):
//  U1 한 글자가 두 조각에 걸쳐 와도 그대로 읽는다(1바이트 · 2바이트 째에서 끊긴 두 경우)
//  U2 표지(ENDRESULT)를 보면 끝까지 기다리지 않고 돌려준다(종전 동작 유지)
//  U3 배선: 가짜 크롬이 실제로 불렸다(받은 글이 비어 있지 않다)
//
// 진짜 크롬 대신 같은 자리에 «바이트를 나눠 쓰는» 작은 실행 파일을 넘긴다 — dumpDom 은 첫 인자로 받은 실행 파일을 띄울 뿐이다.
// fail-first: dumpDom 의 setEncoding 두 줄을 빼면 U1 이 빨갛다.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dumpDom } from "./headless-chrome.mjs";

if (process.platform === "win32") { console.log("skip  윈도우에서는 셸 스크립트 가짜 크롬을 못 띄워 건너뜁니다"); process.exit(0); }
const dir = mkdtempSync(path.join(tmpdir(), "hc-decode-"));
let pass = 0, fail = 0;
const check = (c, n, info = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${info}`); } };
try {
  const fake = (cut, tail) => {
    const p = path.join(dir, `fake-${cut}.mjs`);
    //  «기타» 의 첫 글자(3바이트)를 cut 바이트째에서 끊어 두 번에 나눠 쓴다. 사이에 쉬어 두 조각으로 오게 한다.
    writeFileSync(p, `#!${process.execPath}
const b = Buffer.from("RESULT 기타 (미분류) 2 ", "utf8"); const i = b.indexOf(Buffer.from("기", "utf8")) + ${cut};
process.stdout.write(b.subarray(0, i));
setTimeout(() => { process.stdout.write(b.subarray(i)); process.stdout.write(${JSON.stringify(tail)}); ${tail.includes("ENDRESULT") ? "setTimeout(() => {}, 20000);" : ""} }, 150);
`);
    chmodSync(p, 0o755);
    return p;
  };
  for (const cut of [1, 2]) {
    const out = await dumpDom(fake(cut, "ENDRESULT"), { html: "<p>x</p>", prefix: "hc-decode-page-" });
    check(out.length > 0, `U3 가짜 크롬이 불렸다(끊는 자리 ${cut})`, JSON.stringify(out));
    check(out.includes("기타 (미분류) 2") && !out.includes("�"), `U1 ${cut}바이트째에서 끊긴 한글을 그대로 읽는다`, JSON.stringify(out));
  }
  const t0 = Date.now();
  const out2 = await dumpDom(fake(1, "ENDRESULT"), { html: "<p>x</p>", prefix: "hc-decode-page-" });
  check(out2.includes("ENDRESULT") && Date.now() - t0 < 10_000, "U2 표지를 보면 곧바로 돌려준다(가짜 크롬은 20초 매달린다)", String(Date.now() - t0));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
