// #2172 후속 — 자기노드 판정 **배선**. 사양의 W1·W2 (스크래치패드 spec.md).
//
//  순수 판정(hasSelfProbeCandidate)이 맞아도 그게 **그 자리에 안 서 있으면** 노출 창은 그대로다.
//  이 파일이 값이 아니라 소스 구조를 보는 이유가 그것이다 — 잰 고장이 "판정이 틀렸다"가 아니라
//  "판정을 엉뚱한 때 시도해서 최소간격을 먹었다"였고, 그건 **순서**라 값으로는 안 잡힌다.
//
//  실측(2026-08-27): 게이트웨이 재시작 직후 자기노드가 세션 생성 목록에 약 30초 남았고, 그 사이
//  '내 것 + 가장 최근 연결'이라 새 세션의 기본 실행 노드로 뽑혔다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

/** 주석을 걷어 **코드만** 남긴다 — "최소간격보다 먼저 본다"를 설명한 주석이 순서 단언에 걸리면 안 된다. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const REG = code(read("src/node/registry.ts"));

/** 함수 하나의 본문만 — 파일 전체에서 순서를 재면 다른 함수의 줄이 섞인다. */
function body(src, header) {
  const a = src.indexOf(header);
  assert.ok(a >= 0, `함수를 못 찾았다: ${header}`);
  const b = src.indexOf("\n}", a);
  assert.ok(b > a, `함수 끝을 못 찾았다: ${header}`);
  return src.slice(a, b);
}

// ── W1. 시도 가드가 **최소간격 검사보다 먼저** 온다 ─────────────────────────
//  이 순서가 곧 이 수정의 전부다. 뒤에 오면 헛시도가 여전히 간격을 먹는다(고친 게 없다).
//  ⚠ 헤더에 `async` 를 박아 두지 않는다(#2592): 이 함수는 «지금 낼 수 있는 판정이 다 났다» 를 뜻하는
//   프로미스를 **직접 만들어** 돌려주게 바뀌었다(호출부 applyState 가 그걸 기다린 뒤 발견 기록을 부른다).
//   서명이 바뀔 때마다 이 테스트가 «함수를 못 찾았다» 로 죽으면, 그건 배선이 아니라 문자열을 재는 것이다.
const probe = body(REG, "function probeSelfNodes()");
const iGuard = probe.indexOf("hasSelfProbeCandidate");
const iThrottle = probe.indexOf("SELF_PROBE_MS");
ok(iGuard >= 0, "W1a probeSelfNodes 가 시도 가드를 본다");
ok(iThrottle >= 0, "W1b probeSelfNodes 에 최소간격 검사가 남아 있다(정상 리듬은 그대로)");
ok(iGuard < iThrottle, "W1c 시도 가드가 최소간격 검사보다 **먼저** 온다 — 헛시도가 간격을 먹지 않는다");

// 가드가 간격 갱신(selfProbeAt = ...)보다도 먼저여야 한다 — 간격을 '쓰는' 자리가 그쪽이다.
const iStamp = probe.search(/selfProbeAt\s*=\s*Date\.now\(\)/);
ok(iStamp >= 0, "W1d 시도할 때 간격 시각을 갱신한다");
ok(iGuard < iStamp, "W1e 시도 가드가 간격 시각 갱신보다 먼저 온다");

// ── W2. 스냅샷 복구가 끝나면 **곧바로** 판정한다 ───────────────────────────
//  이게 없으면 판정이 노드의 다음 보고에만 달려 있어, 부팅~첫 보고 사이가 통째로 노출 창이 된다.
const hydrate = body(REG, "export async function hydrateNodeStates()");
ok(/await\s+probeSelfNodes\(\)/.test(hydrate),
  "W2 스냅샷 복구 뒤 곧바로 판정을 부른다(다음 보고를 기다리지 않는다)");

// ── 회귀 방지 — 판정 자체의 성질은 그대로여야 한다 ─────────────────────────
//  ⓐ 겹칠 때만 참(양성 확답) ⓑ 한 번 선 판정은 안 뒤집는다. 이번 수정은 '언제 보나'만 바꿨다.
ok(/if\s*\(selfNodes\.has\(k\)\)\s*continue/.test(probe),
  "R1 이미 판정된 노드는 다시 보지 않는다(선 판정 유지)");
ok(!/selfNodes\.delete|selfNodes\.clear/.test(probe),
  "R2 판정을 뒤집는 경로가 probe 안에 없다(없음 ≠ 아니다)");

console.log(`\n${pass} assertions passed`);
