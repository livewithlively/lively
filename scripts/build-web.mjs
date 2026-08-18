#!/usr/bin/env node
// build:web — 웹 SPA(web/*.ts)를 컴파일해 서빙 디렉터리(public/app)에 **원자 교체**로 반영한다.
//
//  ⚠ 왜 tsc 를 public/app 에 바로 돌리지 않나 (#1760):
//   tsc 는 산출물을 파일 단위로 순차 기록한다 — 실측 21초에 걸쳐 초당 2~21개씩 쓴다. 그 동안
//   게이트웨이(src/web.ts serveStatic)는 재시작 없이 그 디렉터리를 그대로 서빙하므로, 그 창에
//   페이지를 연 사람은 **한 페이지 안에서 옛 모듈과 새 모듈을 섞어** 받는다. 모듈 하나가 옮겨간
//   심볼을 다른 모듈이 아직 옛 자리에서 import 하고 있으면 ESM 은 그 자리에서 죽고(export 불일치
//   SyntaxError) 화면이 통째로 하얗게 남는다. 실제 사고: v2/main.js(옛것)가 views.js(새것)에서
//   이미 project-view.ts 로 옮겨간 renderProject 를 import → dev.lvly.io 백지.
//
//  방법: tsc 는 build/web-app 에 incremental 로 쌓고(항상 같은 디렉터리라 .tsbuildinfo 와 짝이
//   어긋나지 않는다 — 스테이징을 세대별로 바꾸면 증분 빌드가 한 세대 뒤처진 산출물을 남긴다),
//   **빌드가 끝난 뒤에만** 그 결과를 public/app 으로 rename 스왑한다. 중간 상태는 서빙 경로에
//   존재조차 하지 않는다.
//
//  덤: 빌드가 실패하면 스왑을 건너뛴다 — 깨진 빌드가 돌아가던 화면을 내리지 않는다.
//
//  스왑 자체의 잔여 창(rename 2회 사이, 수 ms)은 서버·클라이언트가 덮는다 — src/web.ts 가
//  요청 ?v= 와 현재 assetVersion() 이 다르면 immutable 대신 no-store 로 응답하고(잘못 섞인
//  조합이 1년 캐시로 굳지 않는다), public/index.html 의 자가복구 스크립트가 모듈 로드 실패를
//  감지해 한 번 리로드한다(HTML 은 no-store 라 새 버전 스탬프를 받는다).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "build", "web-app"); // tsc 산출(incremental — .tsbuildinfo 와 고정 짝)
const LIVE = path.join(root, "public", "app"); // 서빙 경로(게이트웨이가 읽는 곳)
const NEXT = path.join(root, "public", ".app-next"); // 스왑 대기 — rename 이 원자적이려면 LIVE 와 같은 볼륨이어야 한다
const OLD = path.join(root, "public", ".app-old"); // 직전 세대(스왑 직후 삭제)

// tsc 를 node 로 직접 실행 — .bin 셸 래퍼(tsc/tsc.cmd)를 타지 않아 윈도우에서도 같은 경로다.
//  bin/tsc 는 typescript 의 exports 에 열려 있지 않아 서브패스로 resolve 되지 않는다 — 패키지
//  진입점(lib/typescript.js)을 짚고 거기서 올라간다.
const tsc = path.join(path.dirname(path.dirname(createRequire(import.meta.url).resolve("typescript"))), "bin", "tsc");
const r = spawnSync(process.execPath, [tsc, "-p", "web/tsconfig.json"], { cwd: root, stdio: "inherit" });
if (r.status !== 0) {
  console.error("[build:web] 컴파일 실패 — public/app 은 건드리지 않았다(돌아가던 화면 유지).");
  process.exit(r.status ?? 1);
}
if (!existsSync(OUT)) {
  console.error(`[build:web] 산출물이 없다: ${OUT} — web/tsconfig.json 의 outDir 을 확인하라.`);
  process.exit(1);
}

// 스왑: 준비(NEXT 채우기) → 교체(rename 2회) → 뒷정리. 교체 구간만 짧게 가져간다.
rmSync(NEXT, { recursive: true, force: true });
rmSync(OLD, { recursive: true, force: true });
mkdirSync(path.dirname(NEXT), { recursive: true });
cpSync(OUT, NEXT, { recursive: true });
if (existsSync(LIVE)) renameSync(LIVE, OLD);
renameSync(NEXT, LIVE);
rmSync(OLD, { recursive: true, force: true });
console.log(`[build:web] public/app 원자 교체 완료 (${path.relative(root, OUT)} → ${path.relative(root, LIVE)})`);
