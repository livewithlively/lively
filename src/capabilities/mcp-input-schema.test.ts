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
//  두 규칙(strip 이라는 같은 원인의 두 얼굴):
//   R1) mcp 노출 + input 스키마가 **비었는데** 핸들러가 입력을 쓴다 → 전 필드가 strip(전면 불통).
//   R2) mcp 노출 + 핸들러가 읽는 input.<필드> 가 스키마에 **없다** → 그 필드만 strip(부분 불통).
//       R2 가 없으면 org_runtime_update 처럼 '스키마는 있는데 storage_policy·embedding_config 만
//       조용히 안 먹는' 부분 결손을 놓친다(#923 에서 실제로 발견). ⚠ 중첩 객체(z.object)도 하위 키를 strip 하므로
//       하위 키까지 다 선언해야 한다 — 정적으로는 못 잡으니 중첩은 사람이 확인한다.
//  핸들러의 수동검증은 방어심층으로 유지 — 스키마의 목적은 *하네스가 무엇을 보낼지 알게* 하는 것.
//  입력을 안 쓰는 capability(파라미터 없음 / `_input` 미사용)는 빈 input 이 정상 — 예외목록 불요.
import assert from "node:assert/strict";
import { registry } from "./index.js";

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

// ── 본 검사 — 레지스트리(= MCP 어댑터가 실제로 등록하는 그 객체들)를 그대로 순회 ──
const offenders: string[] = [];
for (const cap of registry.values()) {
  if (!cap.expose.mcp) continue;                       // REST 전용 → mount.parse 가 검증
  const declared = new Set(Object.keys(cap.input ?? {}));
  const { uses, fields } = inputUsage(cap.handler);
  if (!uses) continue;                                 // 입력을 안 씀 → 빈 스키마 정상
  if (!declared.size) {
    offenders.push(`R1 ${cap.name} [scope=${cap.scope}] — 핸들러가 입력을 쓰는데 input 스키마가 비었다(전 필드 strip)`);
    continue;
  }
  const missing = fields.filter((f) => !declared.has(f));
  if (missing.length) {
    offenders.push(`R2 ${cap.name} [scope=${cap.scope}] — 핸들러가 읽는데 미선언: ${missing.join(", ")} (그 필드만 strip)`);
  }
}
assert.equal(offenders.length, 0,
  `#923 — MCP 로 호출 불가/부분불통인 capability ${offenders.length}종:\n` +
  offenders.map((o) => "    " + o).join("\n") +
  "\n  → restRuntime/restOnly/restRead 의 input 인자에 zod raw shape 을 선언하라(핸들러가 읽는 필드 **전부** —" +
  "\n    zod 는 미선언 키를 strip 하므로 빠뜨린 필드는 계속 하네스에서 안 보인다)." +
  "\n  → 입력을 안 쓰는 핸들러면 파라미터를 지우거나 `_input` 으로 표시하라.");

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

const exposed = [...registry.values()].filter((c) => c.expose.mcp).length;
console.log(`ok  #923 MCP input 스키마 가드 — 노출 ${exposed}종 R1/R2 위반 0 + 자기검증 ${pass}건`);
