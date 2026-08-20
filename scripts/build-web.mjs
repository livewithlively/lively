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
//  ⚠ 증분 빌드는 outDir 을 **정확히 유지해 주지 않는다**(#1830) — 사라진 소스의 산출물을 안 지우고,
//   산출물이 없어져도 기록만 보고 emit 을 건너뛴다. 그래서 tsc 전후로 두 가지를 직접 맞춘다:
//   ① 컴파일 전 — 기록(.tsbuildinfo)이 약속한 산출물이 실제로 다 있나. 없으면 기록을 버려 전량 재생성.
//   ② 컴파일 후 — 소스가 사라진 산출물(고아)을 지운다. 안 지우면 그대로 public/app 으로 실려 간다.
//   판정은 scripts/tsc-outdir.mjs(순수)가, 파일시스템·tsc 실행은 여기가 쥔다.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeclaration, missingOutputs, planOrphans } from "./tsc-outdir.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "build", "web-app"); // tsc 산출(incremental — .tsbuildinfo 와 고정 짝)
const LIVE = path.join(root, "public", "app"); // 서빙 경로(게이트웨이가 읽는 곳)
const NEXT = path.join(root, "public", ".app-next"); // 스왑 대기 — rename 이 원자적이려면 LIVE 와 같은 볼륨이어야 한다
const OLD = path.join(root, "public", ".app-old"); // 직전 세대(스왑 직후 삭제)

// tsc 를 node 로 직접 실행 — .bin 셸 래퍼(tsc/tsc.cmd)를 타지 않아 윈도우에서도 같은 경로다.
//  bin/tsc 는 typescript 의 exports 에 열려 있지 않아 서브패스로 resolve 되지 않는다 — 패키지
//  진입점(lib/typescript.js)을 짚고 거기서 올라간다.
const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(path.dirname(require.resolve("typescript"))), "bin", "tsc");

// ── 소스 목록은 tsconfig 에게 묻는다 ─────────────────────────────────────────────────────────
//  include/exclude(standalone 제외 등)를 여기서 다시 구현하면 tsconfig 와 어긋난다 — tsc 자신의
//  파서로 **그 프로젝트가 실제로 컴파일할 파일**을 받아 정본으로 쓴다(컴파일은 하지 않는다).
const CONFIG = path.join(root, "web", "tsconfig.json");
const ts = require("typescript");
const cfg = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (cfg.error) {
  console.error(`[build:web] web/tsconfig.json 을 읽지 못했다: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, " ")}`);
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(CONFIG));
const ROOT_DIR = parsed.options.rootDir ? path.resolve(path.dirname(CONFIG), parsed.options.rootDir) : path.dirname(CONFIG);
const TSBUILDINFO = parsed.options.tsBuildInfoFile
  ? path.resolve(path.dirname(CONFIG), parsed.options.tsBuildInfoFile)
  : null;
const rel = (from, p) => path.relative(from, p).split(path.sep).join("/");
const SRC_RELS = parsed.fileNames
  .map((f) => rel(ROOT_DIR, f))
  .filter((f) => !f.startsWith("../") && !isDeclaration(f));   // rootDir 밖(lib 등)·선언파일은 산출물이 없다

/** outDir 안의 파일을 상대경로로 전부 훑는다(없으면 빈 배열). */
function listOut() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(rel(OUT, p));
    }
  };
  if (existsSync(OUT)) walk(OUT);
  return out;
}

// ① 컴파일 전 — 증분 기록이 약속한 산출물이 실제로 다 있나. 하나라도 없으면 그 기록은 거짓이다.
//    (outDir 을 손으로 지운 경우·일부만 사라진 경우 모두 여기서 걸린다. 종전엔 tsc 가 emit 을 건너뛰고
//     빈 디렉터리로 죽으면서 엉뚱하게 outDir **설정**을 의심하게 만들었다.)
if (TSBUILDINFO && existsSync(TSBUILDINFO)) {
  const missing = missingOutputs(SRC_RELS, listOut());
  if (missing.length) {
    rmSync(TSBUILDINFO, { force: true });
    console.log(`[build:web] 증분 기록이 산출물과 어긋난다(없는 산출물 ${missing.length}개, 예: ${missing[0]}) — 기록을 버리고 전량 재생성한다.`);
  }
}

const r = spawnSync(process.execPath, [tsc, "-p", "web/tsconfig.json"], { cwd: root, stdio: "inherit" });
if (r.status !== 0) {
  console.error("[build:web] 컴파일 실패 — public/app 은 건드리지 않았다(돌아가던 화면 유지).");
  process.exit(r.status ?? 1);
}
if (!existsSync(OUT)) {
  console.error(`[build:web] 컴파일은 끝났는데 산출물이 없다: ${OUT}`);
  console.error(`  증분 기록(${TSBUILDINFO ? path.relative(root, TSBUILDINFO) : ".tsbuildinfo"})이 남아 emit 을 건너뛴 경우가 대부분이다 — 그 파일을 지우고 다시 실행하라.`);
  process.exit(1);
}

// ② 컴파일 후 — 소스가 사라진 산출물(고아)을 지운다. 안 지우면 그대로 public/app 으로 실려 가
//    유령 모듈이 서빙되고, untracked 라 릴리스 게이트(git diff -- public/app)에도 안 걸린다.
{
  const orphans = planOrphans(listOut(), SRC_RELS);
  for (const o of orphans) rmSync(path.join(OUT, o), { force: true });
  pruneEmptyDirs(OUT);
  if (orphans.length) console.log(`[build:web] 소스가 사라진 산출물 ${orphans.length}개 정리: ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? " …" : ""}`);
}

/** 고아를 지운 뒤 남은 빈 디렉터리를 걷어낸다(outDir 자신은 남긴다). */
function pruneEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    pruneEmptyDirs(p);
    if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
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
