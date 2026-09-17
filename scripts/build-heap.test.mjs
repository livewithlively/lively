#!/usr/bin/env node
// 코어 빌드의 tsc 힙 상한 (#4067) — 테넌트 이미지 굽기 러너에서 코어 빌드가 메모리로 죽지 않게.
//
//  왜: 굽기 러너(lvly-cloud bake.yml 의 `lvly-bake` 레인 — lvly-runner-2)는 메모리 1.5GiB 컨테이너라 Node 기본 힙 한도가
//   **792MB** 다. 코어 tsc 는 2026-09-17(#1007 머지 뒤 첫 굽기) 그 한도를 넘어 «JavaScript heap out of memory» 로 죽었다.
//   같은 조건의 컨테이너(리눅스 arm64 · 1536MB · node 22)에서 재현했다: 기본 한도 → exit 134 · 1100MB → 통과(컨테이너 최대 1033MB).
//   GitHub 러너(16GB)에서는 드러나지 않는다 — CI 는 초록인 채 굽기만 죽는다. 그래서 여기서 못박는다.
//  ⚠ 상한을 더 올려야 하면 러너 메모리도 같이 본다: 힙 상한이 컨테이너 한도에 가까우면 V8 의 분명한 OOM 대신
//   cgroup 의 SIGKILL 로 죽는다(원인이 흐려진다). 그래서 위쪽 경계도 둔다.
//  윈도우에서도 도는 모양이어야 한다(`NODE_OPTIONS=… tsc` 는 cmd 에서 안 된다) — node 로 tsc 를 직접 띄운다.
//
//  실행: node scripts/build-heap.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const build = String(pkg.scripts?.build ?? "");

const m = /^node --max-old-space-size=(\d+) node_modules\/typescript\/bin\/tsc -p tsconfig\.json && /.exec(build);
assert.ok(m, `build 의 첫 단계가 힙 상한을 준 코어 tsc 가 아니다: ${build.slice(0, 100)}`);
console.log("ok  build 의 첫 단계는 힙 상한을 준 코어 tsc 다(윈도우에서도 도는 모양)");

const mb = Number(m[1]);
assert.ok(mb >= 1100 && mb <= 1300, `힙 상한 ${mb}MB — 1100~1300 이어야 한다(러너 1.5GiB 안에서 V8 OOM 이 cgroup kill 보다 먼저)`);
console.log(`ok  힙 상한 ${mb}MB — 기본 792MB 위 · 러너 한도 아래`);

//  나머지 단계는 그대로다 — 이 규칙이 빌드 순서를 바꾸지 않았다.
assert.match(build, /&& node scripts\/build-web\.mjs && tsc -p web\/standalone\/tsconfig\.json && /);
console.log("ok  웹·단독 번들 단계는 그대로다");

console.log("\n3 passed — 코어 빌드 힙 상한(#4067)");
