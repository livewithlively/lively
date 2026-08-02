// #1313 R2 — capability 표면 스냅샷 가드: 분해·이동 리팩토링 중 op 가 조용히 빠지는 사고를 기계로 차단.
//  실행: npm run build && node dist/capabilities/surface-snapshot.test.js
//
//  registry 전 op 의 외부 계약 {이름, scope, expose.mcp, capMutates 파생값, REST method+path 목록,
//  input(zod→JSON스키마) 해시} + Map 삽입순(= tools/list 순서)을 체크인된 스냅샷과 대조한다.
//  파일 분할(delivery.ts → delivery/* 등) 커밋마다 이 테스트가 green 이면 표면 무변화가 기계 증명된다.
//
//  ⚠ 갱신은 **의도적 표면 변경**(op 추가/제거/스키마 변경) 시에만:
//    UPDATE_SURFACE_SNAPSHOT=1 node dist/capabilities/surface-snapshot.test.js
//  갱신 커밋에는 왜 표면이 바뀌는지 커밋 메시지에 명시하라 — 리팩토링(이동·분할) 커밋에서 이
//  스냅샷이 변하면 그 자체가 회귀 신호다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registry, capMutates } from "./index.js";

// dist/capabilities/ → 레포루트/src/capabilities/ (cwd 무관)
const SNAP_URL = new URL("../../src/capabilities/surface-snapshot.json", import.meta.url);

interface OpSurface {
  name: string;
  scope: string | null;
  mcp: boolean;
  mutates: boolean;
  rest: string[];
  input_hash: string;
}

// 입력 스키마 해시 — z.object(shape)→JSON스키마 직렬화. 빈 shape({} — me 등)도 유효한 스키마로 직렬화된다.
function inputHash(shape: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(zodToJsonSchema(z.object(shape as z.ZodRawShape))))
    .digest("hex")
    .slice(0, 16);
}

const surface: OpSurface[] = [...registry.values()].map((cap) => ({
  name: cap.name,
  scope: cap.scope,
  mcp: cap.expose.mcp,
  mutates: capMutates(cap),
  rest: Array.isArray(cap.expose.rest)
    ? cap.expose.rest.flatMap((m) => m.paths.map((p) => `${m.method} ${p}`))
    : [],
  input_hash: inputHash(cap.input),
}));

if (process.env.UPDATE_SURFACE_SNAPSHOT) {
  writeFileSync(SNAP_URL, JSON.stringify(surface, null, 1) + "\n");
  console.log(`ok  표면 스냅샷 갱신 — ${surface.length} op → src/capabilities/surface-snapshot.json`);
  process.exit(0);
}

let expected: OpSurface[];
try {
  expected = JSON.parse(readFileSync(SNAP_URL, "utf8"));
} catch {
  console.error(
    "표면 스냅샷 파일이 없습니다(fail-closed) — 생성: UPDATE_SURFACE_SNAPSHOT=1 node dist/capabilities/surface-snapshot.test.js",
  );
  process.exit(1);
}

// 집합 → 순서 → 필드 순으로 좁혀 진단한다(통짜 deepEqual 은 diff 가 읽기 불가).
const curNames = surface.map((s) => s.name);
const expNames = expected.map((s) => s.name);
const added = curNames.filter((n) => !expNames.includes(n));
const removed = expNames.filter((n) => !curNames.includes(n));
assert.deepEqual(
  { added, removed },
  { added: [], removed: [] },
  `표면 op 집합 변화 — 추가: [${added.join(", ")}] 제거: [${removed.join(", ")}]\n` +
    "  리팩토링(이동·분할) 중이라면 op 가 등록 배열에서 빠진 것이다. 의도적 표면 변경이면 UPDATE_SURFACE_SNAPSHOT=1 로 갱신.",
);
assert.deepEqual(curNames, expNames, "op 등록 순서 변화(tools/list 순서) — 의도적이면 스냅샷 갱신");
for (let i = 0; i < surface.length; i++) {
  assert.deepEqual(surface[i], expected[i], `op '${surface[i].name}' 표면 변화(scope/mcp/mutates/rest/input_hash)`);
}

// 배선 자기검증 — 관측 장치가 살아 있음을 증명(vacuous 방지): 표면이 비거나, 해시가 미세 변화를 뭉개면 여기서 죽는다.
assert.ok(surface.length > 100, `registry op 수가 비정상(${surface.length}) — 조립 배선 자체가 깨졌다`);
assert.ok(surface.some((s) => s.rest.length > 0) && surface.some((s) => s.mcp), "REST/MCP 노출 op 가 하나도 없다 — 직렬화 배선 오류");
assert.notEqual(
  inputHash({ x: z.string() }),
  inputHash({ x: z.string().optional() }),
  "입력 해시가 optional 토글을 구분하지 못한다 — 스키마 직렬화가 무력",
);

console.log(`ok  #1313 R2 표면 스냅샷 — ${surface.length} op 전 필드 일치(집합·순서·scope·mcp·mutates·rest·input)`);
