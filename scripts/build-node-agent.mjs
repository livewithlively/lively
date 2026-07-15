#!/usr/bin/env node
// 노드 에이전트 단일 번들(#869) — dist/node/agent.js + 의존(ws·pg·pino 등 순수 JS)을 esbuild 로 한 파일(agent.mjs)로 묶는다.
//  node-pty 만 external(네이티브 애드온 — 실행환경 node_modules 에서 해소). 멤버 노드(lively node pull)·워커(baked) 공용.
//  전제: npm run build(tsc) 로 dist/node/agent.js 가 먼저 있어야 한다.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "node-agent", "agent.mjs");

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
