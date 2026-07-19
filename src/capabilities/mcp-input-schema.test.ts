// #923 가드레일 — "광고는 되는데 안 되는 MCP 툴"을 CI 에서 차단.
//  실행: npm run build && node dist/capabilities/mcp-input-schema.test.js
//
//  근본 규약: capability.input(zod raw shape)은 **MCP 전용 표면**이다(index.ts registerMcpCapabilities →
//   inputSchema, buildToolCandidates. restMounts() 는 이걸 안 읽는다 — REST 는 mount.parse 가 검증).
//   그래서 input 을 비워두면 REST 는 멀쩡한데 MCP 만 조용히 죽는다:
//    · 하네스가 tools/list 에서 properties:{} 를 보고 → 보낼 필드를 모른다.
//    · 설령 보내도 SDK 가 z.object(input) 로 파싱 → **미선언 키를 strip** → 핸들러가 {} 수신 → 수동검증이 400.
//   REST-first 로 쓴 capability(핸들러가 Record<string,unknown> 을 손으로 검증)가 이 함정에 빠진다.
//   #923 이전엔 이 상태로 35종이 노출돼 있었다(runtime 7 + admin 28) — 노출 ≠ 호출가능.
//   description 에 붙는 restEquivHint("REST body = 이 입력 스키마와 동일 필드")까지 거짓말이 된다.
//
//  세 규칙(strip 두 얼굴 + 카디널리티):
//   R1) mcp 노출 + input 스키마가 **비었는데** 핸들러가 입력을 쓴다 → 전 필드가 strip(전면 불통).
//   R2) mcp 노출 + 핸들러가 읽는 input.<필드> 가 스키마에 **없다** → 그 필드만 strip(부분 불통).
//       R2 가 없으면 org_runtime_update 처럼 '스키마는 있는데 storage_policy·embedding_config 만
//       조용히 안 먹는' 부분 결손을 놓친다(#923 에서 실제로 발견). ⚠ 중첩 객체(z.object)도 하위 키를 strip 하므로
//       하위 키까지 다 선언해야 한다 — 정적으로는 못 잡으니 중첩은 사람이 확인한다.
//   R3) mcp 노출 + 핸들러가 필드 **생략을 보존(preserve)으로 지원**(`input.<f> === undefined ? undefined : …`
//       — 생략을 undefined 로 전파해 store 가 기존값 유지)하는데 스키마가 그 필드를 **required** 로 둔다.
//       그러면 SDK 가 z.object 검증에서 **핸들러 전에** 누락을 거부 → MCP 로는 그 필드를 못 뺀다(부분수정 불가).
//       REST 는 mount.parse 라 멀쩡, MCP 만 조용히 막힌다(strip 이 아니라 카디널리티 판 — 같은 "광고는 되는데
//       안 되는 툴"의 다른 얼굴). #970 org_hook_upsert.event 가 이 갭을 통과했다(핸들러 생략허용 + 스키마 required)
//       → 적대검증서 blocking 으로 잡혀 event 에 .optional() 개별 추가, 본 R3 는 그 **재발 방지 가드**.
//       required 판정은 zod cap.input[f].isOptional() 로 직접 본다(= z.object 가 누락을 받아주는가; 단일 진실원천).
//       ⚠ '생략 보존' 신호는 preserve 관용구(omit→undefined)로 **좁게** 한정 — 오탐 0·예외목록 0:
//         · `input.f ?? null|""`(required-nullable 정규화, null=clear 를 반드시 보내는 6종)·`Array.isArray(input.f)?…:[]`
//           (방어가드)는 omit→구체값이라 required 가 정상 → 신호 제외.
//         · 역방향(핸들러 필수 + 스키마 optional)은 **미구현**: 현 코드의 그 신호(`str(input.f)`)는 전부
//           조건부필수(`remove=true 아니면 필수`·proxy 전용)라 스키마 optional 이 정답 — 제어흐름 없이는 100% 오탐.
//         · 통째위임 helper(resolveX(input.f))·브래킷·중첩 z.object 는 정적 사각 → 사람이 확인(R1/R2 와 동일 한계).
//  핸들러의 수동검증은 방어심층으로 유지 — 스키마의 목적은 *하네스가 무엇을 보낼지 알게* 하는 것.
//  입력을 안 쓰는 capability(파라미터 없음 / `_input` 미사용)는 빈 input 이 정상 — 예외목록 불요.
import assert from "node:assert/strict";
import { z } from "zod";
import { registry } from "./index.js";
import type { Capability } from "./types.js";

/** 소스 위생 — 주석은 항상 제거(문자열 안의 '//' 는 보존해야 하므로 문자열 인식이 필요).
 *  keepStrings=false 면 문자열 내용도 지운다: '식별자 사용' 판정이 주석("// input 검증")·문자열("input 오류")에 오탐하지 않게.
 *  keepStrings=true 는 `input["필드"]` 브래킷 표기의 필드명을 살려야 할 때(내용을 지우면 필드명이 사라진다). */
export function scrub(src: string, keepStrings: boolean): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; out += " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let lit = c, j = i + 1;
      for (; j < src.length && src[j] !== q; j++) { if (src[j] === "\\") { lit += src[j]; j++; } lit += src[j]; }
      out += keepStrings ? lit + q : '""';
      i = j; continue;
    }
    out += c;
  }
  return out;
}

// fn.toString() 에서 첫 파라미터와 본문을 분리. null = 파라미터 목록을 못 찾음.
export function firstParam(src: string): { first: string; body: string } | null {
  const open = src.indexOf("(");
  if (open === -1) return null;
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const params = src.slice(open + 1, end);
  let d = 0, first = params;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    else if (c === "," && d === 0) { first = params.slice(0, i); break; }
  }
  return { first: first.split("=")[0].trim(), body: src.slice(end + 1) };
}

/** 핸들러가 첫 인자(=capability 입력)를 어떻게 쓰는가.
 *  uses  — 입력을 쓰기는 하는가(직접 접근이든 helper(input) 통째 전달이든). R1 의 근거.
 *  fields — `input.x`/`input["x"]` 로 **직접** 읽는 필드. R2 의 근거(통째 전달은 여기 안 잡힘 → 사람이 확인). */
export function inputUsage(fn: (...a: never[]) => unknown): { uses: boolean; fields: string[] } {
  const p = firstParam(fn.toString());
  if (!p || !p.first) return { uses: false, fields: [] };                       // 파라미터 없음
  if (p.first.startsWith("{") || p.first.startsWith("[")) return { uses: true, fields: [] }; // 구조분해
  if (!/^[A-Za-z_$][\w$]*$/.test(p.first)) return { uses: true, fields: [] };   // 예상 밖 → fail-closed
  const bare = scrub(p.body, false);        // 사용여부·점표기용(문자열 내용 제거)
  const withStrings = scrub(p.body, true);  // 브래킷 표기용(필드명이 문자열 안에 있다)
  const name = p.first.replace(/\$/g, "\\$");
  if (!new RegExp(`\\b${name}\\b`).test(bare)) return { uses: false, fields: [] }; // 선언만 하고 미사용(_input)
  const fields = new Set<string>();
  let m: RegExpExecArray | null;
  const dot = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, "g");
  while ((m = dot.exec(bare))) fields.add(m[1]);
  const bracket = new RegExp(`\\b${name}\\[["']([^"']+)["']\\]`, "g");
  while ((m = bracket.exec(withStrings))) fields.add(m[1]);
  return { uses: true, fields: [...fields] };
}

/** R3(카디널리티) — 핸들러가 '부분수정 preserve' 관용구로 **생략을 보존**하는 필드.
 *  생략(값 없음)을 undefined 로 전파하는 형태 `input.<f> === undefined ? undefined : …`
 *  (그리고 null 도 보존으로 뭉개는 `input.<f> == null ? undefined : …`)만 잡는다.
 *  ⚠ `?? null|""`(omit→구체값=required-nullable 정규화)·`? null`·방어가드는 잡지 않는다 — required 가 정상(오탐 0).
 *  통째전달/구조분해/미사용은 필드별 신호가 없어 빈 목록(R1/R2 와 동일 한계, 사람이 확인). */
export function preserveOmitFields(fn: (...a: never[]) => unknown): string[] {
  const p = firstParam(fn.toString());
  if (!p || !p.first) return [];
  if (p.first.startsWith("{") || p.first.startsWith("[")) return [];       // 구조분해 — 필드별 신호 없음
  if (!/^[A-Za-z_$][\w$]*$/.test(p.first)) return [];                       // 예상 밖 파라미터
  const bare = scrub(p.body, false);                                       // 주석·문자열 제거(오탐 방지)
  const name = p.first.replace(/\$/g, "\\$");
  // input.<f> (=== undefined | == null) ? undefined  — 생략을 undefined 로 전파(=store preserve)
  const re = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)\\s*(?:===\\s*undefined|==\\s*null)\\s*\\?\\s*undefined\\b`, "g");
  const fields = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) fields.add(m[1]);
  return [...fields];
}

/** 스키마가 이 필드의 **누락**(키 부재)을 받아주는가 = z.object 가 거부 안 하는가(MCP 호출자가 뺄 수 있는가).
 *  .optional()/.default() → true · required → false · .nullable() 단독(=required-nullable, null 은 되나
 *  누락은 거부) → false · .nullable().optional() → true. zod isOptional() 을 단일 진실원천으로 신뢰. */
function mcpOptional(zt: unknown): boolean {
  const f = (zt as { isOptional?: () => boolean } | null | undefined)?.isOptional;
  return typeof f === "function" ? f.call(zt) : true;                      // 판정 불가 → fail-open(오탐 억제)
}

/** 한 capability 의 R1/R2/R3 위반 메시지(없으면 []). 메인 루프와 합성-capability 회귀테스트가 **같은 배선**을 공유한다
 *  — 회귀는 이 함수 하나에 고정되고(#970 event 부류), 루프는 registry 순회만 한다. */
export function checkCapability(cap: Capability): string[] {
  if (!cap.expose.mcp) return [];                      // REST 전용 → mount.parse 가 검증
  const declared = new Set(Object.keys(cap.input ?? {}));
  const { uses, fields } = inputUsage(cap.handler);
  if (!uses) return [];                                // 입력을 안 씀 → 빈 스키마 정상
  if (!declared.size) {                                // 스키마가 비면 먼저 R1(그 상태선 R2/R3 판정 불가)
    return [`R1 ${cap.name} [scope=${cap.scope}] — 핸들러가 입력을 쓰는데 input 스키마가 비었다(전 필드 strip)`];
  }
  const out: string[] = [];
  const missing = fields.filter((f) => !declared.has(f));
  if (missing.length) {
    out.push(`R2 ${cap.name} [scope=${cap.scope}] — 핸들러가 읽는데 미선언: ${missing.join(", ")} (그 필드만 strip)`);
  }
  // R3 — 핸들러가 생략을 보존(preserve)으로 지원하는데 스키마가 required → MCP 로 그 필드를 못 뺀다(부분수정 불가).
  for (const f of preserveOmitFields(cap.handler)) {
    if (!declared.has(f)) continue;                    // 미선언은 R2 소관
    if (!mcpOptional(cap.input[f])) {
      out.push(`R3 ${cap.name} [scope=${cap.scope}] — 핸들러는 ${f} 생략을 보존으로 지원하는데 스키마가 required → MCP 로 부분수정 시 ${f} 를 못 뺀다(#970 event 부류; 스키마에 .optional() 필요)`);
    }
  }
  return out;
}

// ── 본 검사 — 레지스트리(= MCP 어댑터가 실제로 등록하는 그 객체들)를 그대로 순회 ──
const offenders: string[] = [];
for (const cap of registry.values()) offenders.push(...checkCapability(cap));
assert.equal(offenders.length, 0,
  `#923 — MCP 로 호출 불가/부분불통인 capability ${offenders.length}종:\n` +
  offenders.map((o) => "    " + o).join("\n") +
  "\n  → R1/R2: restRuntime/restOnly/restRead 의 input 인자에 zod raw shape 을 선언하라(핸들러가 읽는 필드 **전부** —" +
  "\n    zod 는 미선언 키를 strip 하므로 빠뜨린 필드는 계속 하네스에서 안 보인다). 입력을 안 쓰는 핸들러면 파라미터를 지우거나 `_input` 으로 표시하라." +
  "\n  → R3: 핸들러가 생략을 보존(preserve)으로 지원하면 스키마 필드에 .optional() 을 붙여라(안 붙이면 SDK 가 누락을 먼저 거부해 MCP 로 부분수정 불가).");

// ── 자기검증 — 가드가 '무력화'되지 않았음을 known-bad 로 증명(#923 이전엔 35종이 다 통과했었다) ──
let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; };

t("R1 known-bad: input.field 직접 접근 → uses", () => {
  assert.deepEqual(inputUsage(((input: Record<string, unknown>, _u: unknown) => input.id) as never), { uses: true, fields: ["id"] });
});
t("R1 known-bad: 구조분해 파라미터 → uses", () => {
  assert.equal(inputUsage((({ id }: { id: string }) => id) as never).uses, true);
});
t("R1 known-bad: helper(input) 통째 전달 → uses (org_git_credential_set 패턴 — input.x 가 안 보인다)", () => {
  const helper = (x: unknown): unknown => x;
  assert.deepEqual(inputUsage(((input: Record<string, unknown>, _u: unknown) => helper(input)) as never), { uses: true, fields: [] });
});
t("R1 known-bad: `_input` 이지만 실제로 사용 → uses(언더스코어로 못 숨는다)", () => {
  assert.equal(inputUsage(((_input: Record<string, unknown>) => _input.id) as never).uses, true);
});
t("R2 known-bad: 읽는 필드 전부 열거 → 스키마와 대조 가능(org_runtime_update 부분결손 재발 차단)", () => {
  const fn = (input: Record<string, unknown>): unknown => [input.storage_policy, input.embedding_config, input["work_roots"]];
  assert.deepEqual(inputUsage(fn as never).fields.sort(), ["embedding_config", "storage_policy", "work_roots"]);
});
t("known-good: 파라미터 없음 → 미사용", () => {
  assert.deepEqual(inputUsage((() => ({ ok: true })) as never), { uses: false, fields: [] });
});
t("known-good: `_input` 선언만 하고 미사용 → 미사용", () => {
  assert.equal(inputUsage(((_input: unknown, user: { id: string }) => user.id) as never).uses, false);
});
t("오탐방지: 주석·문자열이 파라미터명을 언급해도 미사용이면 통과", () => {
  const fn = (_input: unknown, user: { id: string }): string => {
    // _input 은 쓰지 않는다 — 목록 조회라 인자가 없다
    return user.id + "_input 오류";
  };
  assert.equal(inputUsage(fn as never).uses, false);
});

// ── R3(카디널리티) 자기검증 — 사양 기반 블라인드 작성(spec-blind-test): preserveOmitFields·mcpOptional·통합규칙 ──
t("R3 (1) 생략→undefined 보존 관용구: 단일 필드 검출", () => {
  assert.deepEqual(
    preserveOmitFields(((input: Record<string, unknown>) => (input.event === undefined ? undefined : String(input.event))) as never),
    ["event"],
  );
});
t("R3 (2) 보존 필드가 여럿이면 전부 검출(중복 없이)", () => {
  assert.deepEqual(
    preserveOmitFields(
      ((input: Record<string, unknown>) => ({
        title: input.title === undefined ? undefined : String(input.title),
        body: input.body === undefined ? undefined : String(input.body),
      })) as never,
    ).sort(),
    ["body", "title"],
  );
});
t("R3 (3) '값 없으면 undefined 산출'의 또다른 형태(== null 분기)도 검출", () => {
  assert.deepEqual(
    preserveOmitFields(((input: Record<string, unknown>) => (input.note == null ? undefined : String(input.note))) as never),
    ["note"],
  );
});
t("R3 (4) 생략을 null(구체값)로 정규화하는 필드는 검출 안 됨(required-nullable)", () => {
  assert.deepEqual(
    preserveOmitFields(((input: Record<string, unknown>) => (input.parent === undefined ? null : String(input.parent))) as never),
    [],
  );
});
t("R3 (5) 생략을 빈문자열/빈배열/0(구체값)로 정규화하는 필드는 검출 안 됨", () => {
  assert.deepEqual(
    preserveOmitFields(
      ((input: Record<string, unknown>) => ({
        name: input.name === undefined ? "" : String(input.name),
        tags: input.tags === undefined ? [] : input.tags,
        count: input.count === undefined ? 0 : Number(input.count),
      })) as never,
    ),
    [],
  );
});
t("R3 (6) 첫 인자가 구조분해(비식별자)면 빈 목록", () => {
  assert.deepEqual(
    preserveOmitFields((({ a, b }: Record<string, unknown>) => (a === undefined ? undefined : String(b))) as never),
    [],
  );
});
t("R3 (7a) 무인자 핸들러는 빈 목록", () => {
  assert.deepEqual(preserveOmitFields((() => undefined) as never), []);
});
t("R3 (7b) 입력을 통째로만 참조하고 필드 접근이 없으면 빈 목록", () => {
  assert.deepEqual(preserveOmitFields(((input: Record<string, unknown>) => (input ? undefined : undefined)) as never), []);
});
t("R3 (8) 주석/문자열 리터럴의 유사문구는 오검출하지 않고 실제 접근만 검출", () => {
  assert.deepEqual(
    preserveOmitFields(
      ((input: Record<string, unknown>) => {
        // input.ghost === undefined ? undefined : String(input.ghost)
        const note = "input.phantom === undefined ? undefined : String(input.phantom)";
        const real = input.real === undefined ? undefined : String(input.real);
        return real ?? note;
      }) as never,
    ),
    ["real"],
  );
});
t("R3 (9) mcpOptional: 수식 없는 required 타입은 false", () => {
  assert.equal(mcpOptional(z.string()), false);
});
t("R3 (10a) mcpOptional: .optional() 은 true", () => {
  assert.equal(mcpOptional(z.string().optional()), true);
});
t("R3 (10b) mcpOptional: .default(...) 은 true", () => {
  assert.equal(mcpOptional(z.string().default("x")), true);
});
t("R3 (10c) mcpOptional: isOptional 없는 값은 fail-open(true) — 판정 불가 시 오탐 억제", () => {
  assert.equal(mcpOptional(undefined), true);
  assert.equal(mcpOptional({}), true);
});
t("R3 (11) mcpOptional: .nullable() 단독은 false(값은 null 허용하나 생략은 거부)", () => {
  assert.equal(mcpOptional(z.string().nullable()), false);
});
t("R3 (12) mcpOptional: .nullable().optional() 은 true", () => {
  assert.equal(mcpOptional(z.string().nullable().optional()), true);
});
t("R3 (13) 통합: required 스키마 + 보존 핸들러 → 위반", () => {
  const shape: Record<string, unknown> = { event: z.enum(["created", "updated"]) };
  const handler = ((input: Record<string, unknown>) => (input.event === undefined ? undefined : String(input.event))) as never;
  const violations = preserveOmitFields(handler).filter((f) => f in shape && mcpOptional(shape[f]) === false);
  assert.deepEqual(violations, ["event"]);
});
t("R3 (14) 통합: optional 스키마 + 보존 핸들러 → 위반 아님", () => {
  const shape: Record<string, unknown> = { event: z.enum(["created", "updated"]).optional() };
  const handler = ((input: Record<string, unknown>) => (input.event === undefined ? undefined : String(input.event))) as never;
  const violations = preserveOmitFields(handler).filter((f) => f in shape && mcpOptional(shape[f]) === false);
  assert.deepEqual(violations, []);
});
t("R3 (통합) 보존 필드라도 스키마에 미선언이면 R3 대상 아님(R2 소관)", () => {
  const shape: Record<string, unknown> = { other: z.string() };
  const handler = ((input: Record<string, unknown>) => (input.event === undefined ? undefined : String(input.event))) as never;
  const violations = preserveOmitFields(handler).filter((f) => f in shape && mcpOptional(shape[f]) === false);
  assert.deepEqual(violations, []);
});

// R3 회귀 고정(실배선) — 위 (13)/(14)/(통합) 은 preserveOmitFields+mcpOptional 조합만 보고 루프 배선은 안 태운다.
//  아래 둘은 checkCapability 를 직접 태워 '#970 이전 event 형태(required 스키마 + 보존 핸들러)를 red 로'를 자동 고정한다
//  (AGENTS.md 검증 아이디어 — delivery.ts 를 손대는 수동 뮤테이션에 의존하지 않고 배선까지 회귀로 박는다).
const synthCap = (eventSchema: z.ZodTypeAny): Capability => ({
  name: "synthetic_hook_upsert",
  title: "t",
  description: "d",
  scope: null,
  input: { event: eventSchema },
  expose: { mcp: true, rest: false },
  handler: ((input: Record<string, unknown>) =>
    ({ event: input.event === undefined ? undefined : String(input.event) })) as unknown as Capability["handler"],
});
t("R3 (회귀) 실배선: #970 이전 event(required 스키마 + 보존 핸들러)를 checkCapability 가 red 로 잡는다", () => {
  const found = checkCapability(synthCap(z.enum(["SessionStart", "Stop"])));
  assert.equal(found.length, 1);
  assert.match(found[0], /^R3 synthetic_hook_upsert\b/);
  assert.match(found[0], /event/);
});
t("R3 (회귀) 실배선: event 에 .optional() 이면 위반 없음(green) — 뮤테이션 복원 대칭", () => {
  assert.deepEqual(checkCapability(synthCap(z.enum(["SessionStart", "Stop"]).optional())), []);
});

const exposed = [...registry.values()].filter((c) => c.expose.mcp).length;
console.log(`ok  #923 MCP input 스키마 가드 — 노출 ${exposed}종 R1/R2/R3 위반 0 + 자기검증 ${pass}건`);
