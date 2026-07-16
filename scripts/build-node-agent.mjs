#!/usr/bin/env node
// 노드 에이전트 단일 번들(#869) — dist/node/agent.js + 의존(ws·pg·pino 등 순수 JS)을 esbuild 로 한 파일(agent.mjs)로 묶는다.
//  node-pty 만 external(네이티브 애드온 — 실행환경 node_modules 에서 해소). 멤버 노드(lively node pull)·워커(baked) 공용.
//  전제: npm run build(tsc) 로 dist/node/agent.js 가 먼저 있어야 한다.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { statSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "node-agent", "agent.mjs");

// 리눅스 node-pty prebuild 동봉(#869) — node-pty 는 리눅스에서 npm install 시 소스빌드(build/Release)라, mac 게이트웨이의
//  node_modules 엔 리눅스 바이너리가 없다(prebuilds 엔 darwin/win32 만). 그러면 리눅스 노드가 서빙 번들의 node-pty 를 로드
//  못 한다. 레포에 커밋한 prebuild(deploy/node-pty-prebuilds/<arch>/pty.node)를 node_modules/node-pty/prebuilds/ 로 복사해
//  서빙 tar 에 포함시킨다(npm ci 후 build 에서 복원). node-pty pty.node 는 **N-API** → 노드 버전 무관. (x64 는 후속.)
{
  const vendored = join(root, "deploy", "node-pty-prebuilds");
  const nptyPrebuilds = join(root, "node_modules", "node-pty", "prebuilds");
  if (existsSync(vendored) && existsSync(join(root, "node_modules", "node-pty"))) {
    for (const arch of readdirSync(vendored)) {
      const src = join(vendored, arch, "pty.node");
      if (!existsSync(src)) continue;
      mkdirSync(join(nptyPrebuilds, arch), { recursive: true });
      copyFileSync(src, join(nptyPrebuilds, arch, "pty.node"));
      console.log(`✓ node-pty prebuild 동봉: prebuilds/${arch}/pty.node`);
    }
  }
}

await build({
  entryPoints: [join(root, "dist", "node", "agent.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  // node-pty = 네이티브 애드온 → 번들 밖. 실행환경(agent.mjs 옆 node_modules/node-pty)에서 로드.
  external: ["node-pty"],
  // ESM 번들에서 CJS 의존(pg 등)의 require/__dirname 참조가 깨지지 않게.
  banner: { js: "import{createRequire as __cr}from'node:module';import{fileURLToPath as __f}from'node:url';import{dirname as __d}from'node:path';const require=__cr(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);" },
  logLevel: "info",
});

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`✓ 노드 에이전트 번들: dist/node-agent/agent.mjs (${kb} KiB) · external: node-pty`);
