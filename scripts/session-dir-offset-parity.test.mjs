// 세션 작업 폴더 → 프로젝트 오프셋 규약이 서버·웹 두 자리에서 같은가 + 웹이 목록 행의 dir 을 다시 읽지 않는가 (#4105, 2026-09-23)
//  실행: node scripts/session-dir-offset-parity.test.mjs   (npm test 체인)
//  왜: 타임라인 산출물 열기가 죽어 있던 뿌리가 «목록 행(Sess)에 없는 dir 을 any 로 읽어 늘 '' 이던 것»이었고, 프로젝트 판정은
//   서버(node-upload-coord.ts projectOffsetOfSessionDir)와 같은 정규식이어야 한다 — 한쪽만 고치면 두 판정이 갈린다. 둘 다 문자열 가드로 박는다.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SRV = read("src/terminal/node-upload-coord.ts");
const WEB = read("web/v2/panes.ts");
const P = WEB.slice(WEB.indexOf("export function mountPanes("));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log("ok  " + m); };

const LIT = String.raw`/\/(?:project|legacy-project)\/(\d+)(?:\/(.+))?$/`;
ok(SRV.includes("export function projectOffsetOfSessionDir(") && SRV.includes(LIT), "E1 서버 규약(projectOffsetOfSessionDir)의 정규식이 그대로 있다");
ok(P.includes("function projectOffsetOfDir(") && P.includes(LIT), "E2 웹(panes.ts projectOffsetOfDir)이 서버와 **같은** 정규식을 쓴다 — 한쪽만 고치면 두 판정이 갈린다");
ok(/const sessRow = \(sid: string\): Sess \| null =>/.test(P), "E3 sessRow 는 any 가 아니라 Sess 다 — 없는 필드(dir)는 빌드가 막는다");
ok(/const sessDir = \(sid: string\): string => slash\(String\(sessRow\(sid\)\?\.raw\?\.dir \?\? ''\)\)/.test(P), "E4 세션 폴더는 원본 행(raw.dir)에서 읽는다 — 목록 행엔 dir 이 없다(views.ts mergeSessions)");
ok(!/sessRow\([^)]*\)\s*\|\|\s*\{\}\)\.dir\b/.test(P) && !/\bconst dir = String\(\(sessRow/.test(P), "E5 목록 행의 dir 을 다시 읽는 옛 줄이 없다");
const OUT = P.slice(P.indexOf("function openOut("), P.indexOf("async function thumbOf("));
ok(OUT.length > 0 && !/window\.open\(apiUrl/.test(OUT) && !/window\.dispatchEvent/.test(OUT), "E6 산출물 파일은 새 탭(날 주소)·window 신호가 아니라 뷰어(openViewerAt)로 연다");
ok(/openViewerAt\(\{ path: rel, sid, node \}\)/.test(OUT), "E7 노드 세션·프로젝트 밖 파일은 세션 출처(sid·node)로 뷰어에 연다");
ok(/openViewerAt\(\{ path: off \? off \+ '\/' \+ rel : rel \}\)/.test(OUT), "E8 프로젝트 폴더(또는 하위)의 세션이면 오프셋을 붙여 프로젝트 자료로 연다");
ok(/'&node=' \+ encodeURIComponent\(node\)/.test(P), "E9 세션 파일 주소에 node= 를 싣는다(files.ts nodeQ 와 같은 규칙) — 없으면 게이트웨이 fs 에서 404");
console.log(`\n# ${n} passed`);
