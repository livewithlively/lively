#!/usr/bin/env node
// 노드 에이전트 단일 번들(#869) — dist/node/agent.js + 의존(ws·pg·pino 등 순수 JS)을 esbuild 로 한 파일(agent.mjs)로 묶는다.
//  node-pty 만 external(네이티브 애드온 — 실행환경 node_modules 에서 해소). 멤버 노드(lively node pull)·워커(baked) 공용.
//  전제: npm run build(tsc) 로 dist/node/agent.js 가 먼저 있어야 한다.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { statSync, mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

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

const result = await build({
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
  metafile: true,
});

// ── 번들 경계 가드(#1313 R8) — '노드 에이전트에 DB 없음' 계약을 빌드 타임 기계 검증으로. ──
//  번들에 실린 우리 모듈(dist/**)을 화이트리스트(node-agent-allowed-modules.json)와 대조한다.
//  목록 밖 모듈(특히 org/·v6/·items/·db/ 신규 유입) 발견 시 **경고**(1단계 — 안정화 후 실패로 승격 예정).
//  현재 이미 실리는 DB 계열 모듈은 초기 화이트리스트에 명시 등재된 '알고 있는 부채'다(주석 참조).
//  갱신(의도적 경계 변경·파일 이동 시): UPDATE_NODE_AGENT_ALLOWLIST=1 node scripts/build-node-agent.mjs
//  #2165 — 목록이 **둘**이다. 하나로는 "승인했다"와 "알고 있지만 아직 못 고쳤다"를 구별할 수 없어서,
//   경고를 끄려고 전부 승인목록에 넣게 되고 계약이 문서로만 남는다.
//   · node-agent-allowed-modules.json — **승인**: 노드가 실제로 쓰는 것(계약 안).
//   · node-agent-known-debt.json      — **부채**: 지금 실려 있지만 빠져야 하는 것. 줄어들기만 해야 하는 목록이다.
//   둘 중 **어느 쪽에도 없으면 빌드 실패**(종전 경고 → 승격). 그래야 드리프트가 더 자라지 않는다.
//   고칠 자리는 `node scripts/node-agent-bundle-map.mjs` 가 경계 간선으로 보여 준다.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const allowPath = join(here, "node-agent-allowed-modules.json");
  const debtPath = join(here, "node-agent-known-debt.json");
  const bundled = Object.keys(result.metafile.inputs)
    .filter((p) => p.startsWith("dist/"))
    .sort();
  const load = (p) => (existsSync(p) ? new Set(JSON.parse(readFileSync(p, "utf8"))) : new Set());
  if (process.env.UPDATE_NODE_AGENT_ALLOWLIST) {
    // 갱신은 **부채 목록만** 다시 굳힌다 — 승인목록은 사람이 판단해 손으로 옮긴다.
    //  (여기서 승인목록을 통째로 덮으면 '가르는 일'이 영영 안 일어난다.)
    const allowed = load(allowPath);
    writeFileSync(debtPath, JSON.stringify(bundled.filter((p) => !allowed.has(p)), null, 1) + "\n");
    console.log(`✓ 부채 목록 재동결 — 승인 ${allowed.size} · 부채 ${bundled.filter((p) => !allowed.has(p)).length}`);
  } else if (!existsSync(allowPath)) {
    console.warn("⚠ 번들 승인목록 없음 — UPDATE_NODE_AGENT_ALLOWLIST=1 로 생성하라");
  } else {
    const allowed = load(allowPath);
    const debt = load(debtPath);
    const known = new Set([...allowed, ...debt]);
    const intruders = bundled.filter((p) => !known.has(p));
    const stale = [...known].filter((p) => !bundled.includes(p));
    if (intruders.length) {
      console.error(
        `\n✗ 노드 에이전트 번들에 **새 모듈 ${intruders.length}개**가 들어왔다:\n  ${intruders.join("\n  ")}\n\n` +
          "  노드 에이전트는 'DB 없음'이 계약이다(org/·v6/·items/·db/ 는 원칙적으로 금지).\n" +
          "  · 노드가 실제로 쓰는 것이면 scripts/node-agent-allowed-modules.json 에 **손으로** 넣어라(근거를 커밋 메시지에).\n" +
          "  · 딸려온 것이면 끊어라 — `node scripts/node-agent-bundle-map.mjs` 가 끊을 경계 간선을 보여 준다.\n" +
          "  ⚠ `await import()` 로 미루는 건 소용없다. esbuild 는 outfile 하나면 동적 import 를 그대로 인라인한다(#2165 실측).\n" +
          "  · 부채로 남길 수밖에 없으면 UPDATE_NODE_AGENT_ALLOWLIST=1 로 재동결하되, **왜 지금 못 고치는지**를 남겨라.\n",
      );
      process.exit(1);
    }
    if (stale.length) console.warn(`⚠ 목록 스테일 ${stale.length}개(번들에 더는 없음) — 줄었으니 재동결하라:\n  ${stale.join("\n  ")}`);
    console.log(`✓ 번들 경계 가드 — 승인 ${allowed.size} · 부채 ${debt.size} · 새 유입 0`);
  }
}

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`✓ 노드 에이전트 번들: dist/node-agent/agent.mjs (${kb} KiB) · external: node-pty`);
