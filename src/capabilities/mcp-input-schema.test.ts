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
//   R4) mcp 노출 + REST mount.parse 가 **실제로 싣는** 키가 스키마에 없다 → 그 필드는 REST 로만 보낼 수 있고
//       MCP 로는 strip 된다. R2 의 짝이자 반대편 관측점이다: R2 는 '핸들러가 읽는 필드'(input.f) 기준이라
//       핸들러가 통째위임(helper(input))·구조분해·옵셔널체이닝(input?.f)으로 읽으면 신호가 없는데,
//       R4 는 어댑터가 **싣는 쪽**에서 같은 갭을 본다(#1403). 여기 걸리면 restEquivHint 가 description 에
//       광고하는 "REST body = 이 입력 스키마와 동일 필드"가 그 필드에서 거짓이 된다.
//       parse 는 req 만 읽는 **동기 순수 함수**(RestMount 타입상 Promise 반환 불가 = async I/O 불가)라
//       mock req 로 **실제 호출**해 반환 키를 관측한다 — 함수라 정적 추출이 불가능한 자리를 동적 관측이 메운다.
//       ⚠ 검증에 걸려 throw 한 시도는 버린다: 관측된 키만 근거로 삼으므로 **오탐 0**, 못 태운 분기는 조용히
//        통과(fail-open·미탐 허용). mcp:false 는 애초에 대상 밖이다 — isToolExposed 가 org_tool override 로도
//        못 켜게 fail-closed 로 막아 zod strip 경로 자체가 없다(그래서 그쪽 input:{} 는 부채가 아니라 정상).
//   R5) heavy payload 툴(대형 본문을 받는 툴)의 **짧은 메타 필드에 zod 하드 상한**이 걸려 있다 → 그 한 필드의
//       초과가 같은 호출에 실린 본문 전체를 무효로 만든다. R3 와 같은 판(SDK 가 핸들러 앞에서 거부)인데
//       무효화되는 게 '그 필드'가 아니라 **호출 전체**여서 대가가 다르다: knowledge_save 는 body_md 를
//       200,000자(≈50k 토큰)까지 받는데 title 200자 초과 하나로 그 본문이 통째로 버려지고, 호출자는 같은
//       본문을 다시 실어 재시도한다. 게다가 그 실패는 registerTool wrap(server.ts instrument) **앞**에서
//       터지므로 mcp_call_log 에 흔적이 없다 — 사람은 반복 실패를 체감하는데 서버는 모르는 실패다(#1442).
//       그래서 heavy 툴의 짧은 문자열 필드는 **분류가 선언돼 있어야** 한다(soft-cap.ts):
//        · SOFT_CAPS — 상한을 zod 에서 떼고 핸들러가 조정(clamp/drop/note) + 응답 capped 로 보고.
//        · HARD_CAP_OK — 기계값(해시·경로·ISO 시각·외부 좌표)이라 자르면 뜻이 깨지므로 거부가 맞다는 판단.
//       R5a 선언된 소프트캡 필드에 zod max 가 (되)붙었다 = 선언만 남고 효력이 사라진 회귀.
//       R5b heavy 툴에 분류 없는 하드캡 짧은 필드가 있다 = 새 필드를 넣을 때 사람이 판단하도록 강제.
//       R5c 선언된 필드가 스키마에 없다 = rename·삭제 뒤 남은 죽은 선언(표가 거짓이 된다).
//  핸들러의 수동검증은 방어심층으로 유지 — 스키마의 목적은 *하네스가 무엇을 보낼지 알게* 하는 것.
//  입력을 안 쓰는 capability(파라미터 없음 / `_input` 미사용)는 빈 input 이 정상 — 예외목록 불요.
import assert from "node:assert/strict";
import { z } from "zod";
import { registry } from "./index.js";
import type { Capability, RestMount } from "./types.js";
import { SOFT_CAPS, HARD_CAP_OK, HEAVY_PAYLOAD_CHARS } from "./soft-cap.js";

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

/** R4 표본 — zod 타입 1개에서 parse 검증을 통과할 법한 값을 만든다. enum 은 **실제 옵션**을 쓰므로
 *  `action==="add"` 류 조건부 분기를 정확히 태운다(그 분기에서만 실리는 키를 놓치지 않는다).
 *  REST 는 원시 문자열로 오므로 숫자는 문자열/숫자를 라운드마다 번갈아 준다. 라운드 index 만으로 결정 — 난수 없음. */
export function sampleOf(zt: unknown, round: number): unknown {
  const def = (zt as { _def?: Record<string, unknown> } | undefined)?._def;
  const kind = def?.typeName as string | undefined;
  if (kind === "ZodOptional" || kind === "ZodNullable" || kind === "ZodDefault") return sampleOf(def!.innerType, round);
  if (kind === "ZodEnum") { const o = (def!.values ?? []) as string[]; return o.length ? o[round % o.length] : "x"; }
  if (kind === "ZodNumber") return round % 2 ? 1 : "1";
  if (kind === "ZodBoolean") return round % 2 === 0;
  if (kind === "ZodArray") return [sampleOf(def!.type, round), sampleOf(def!.type, round + 1)];   // '2개 이상' 검증 대비
  return round % 2 ? "1" : "x";
}

// 스키마에 없는 키도 parse 가 읽을 수 있으므로(그게 바로 R4 가 찾는 것) get 은 **모든 키**에 값을 준다.
//  ownKeys 는 스키마 키만 노출 — `{...req.body}` spread 패턴이 실존 키를 그대로 싣게 하기 위함.
const R4_FALLBACK: readonly unknown[] = ["1", "x", true, "2026-01-01"];
function mkBag(shape: Record<string, unknown>, round: number): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (const [k, zt] of Object.entries(shape)) store[k] = sampleOf(zt, round);
  return new Proxy(store, {
    get: (t, k) => (typeof k === "symbol" ? undefined : k in t ? t[k as string] : R4_FALLBACK[round % R4_FALLBACK.length]),
    has: () => true,
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, k) => ({ value: t[k as string], enumerable: true, configurable: true, writable: true }),
  }) as Record<string, unknown>;
}

/** R4 관측 — 이 capability 의 REST parse 들이 **실제로 산출한** 키의 합집합.
 *  throw 한 라운드는 버린다(그 조합이 검증에 걸린 것일 뿐 — 관측된 키만 근거). 라운드 수는 enum 옵션을 한 바퀴
 *  돌리기 충분한 값. parse 가 전패하면 빈 배열 = 판정 불가 → 위반 없음으로 통과(fail-open). */
export function parseEmittedKeys(cap: Capability, rounds = 10): string[] {
  const rest = cap.expose.rest;
  if (!Array.isArray(rest) || !rest.length) return [];
  const shape = (cap.input ?? {}) as Record<string, unknown>;
  const keys = new Set<string>();
  for (const mount of rest) {
    for (let r = 0; r < rounds; r++) {
      const bag = mkBag(shape, r);
      const req = { params: bag, query: bag, body: bag, headers: {}, method: "POST", path: "/", originalUrl: "/", ip: "127.0.0.1" };
      try {
        const out = mount.parse(req as never);
        if (out && typeof out === "object") for (const k of Object.keys(out)) keys.add(k);
      } catch { /* 이 값 조합이 parse 검증에 걸림 — 버린다(미탐 허용, 오탐 0) */ }
    }
  }
  return [...keys];
}

/** R5 표본 — zod 타입이 문자열이면 그 상한을, 아니면 null. max 없는 문자열은 `{ max: null }`(= 하드 상한 없음).
 *  optional/nullable/default/effects 래핑은 sampleOf 와 같은 규율로 벗긴다(선언 순서에 판정이 흔들리지 않게). */
export function stringCap(zt: unknown): { max: number | null } | null {
  let def = (zt as { _def?: Record<string, unknown> } | null | undefined)?._def;
  while (def && ["ZodOptional", "ZodNullable", "ZodDefault", "ZodEffects"].includes(def.typeName as string)) {
    def = ((def.innerType ?? def.schema) as { _def?: Record<string, unknown> } | undefined)?._def;
  }
  if (def?.typeName !== "ZodString") return null;
  const max = ((def.checks ?? []) as Array<{ kind: string; value?: number }>).find((c) => c.kind === "max");
  return { max: typeof max?.value === "number" ? max.value : null };
}

/** R5c 의 툴 단위 판 — 선언 표(soft-cap.ts)의 **툴 이름**이 드리프트하면(툴 rename·삭제) 그 표는 아무 필드도
 *  지키지 못하고 조용히 무효가 된다. capability 순회로는 볼 수 없는 자리다(없는 이름은 순회에 안 나온다). */
export function declaredToolDrift(existing: readonly string[]): string[] {
  const have = new Set(existing);
  const out: string[] = [];
  for (const [label, table] of [["SOFT_CAPS", SOFT_CAPS], ["HARD_CAP_OK", HARD_CAP_OK]] as const) {
    for (const tool of Object.keys(table)) {
      if (!have.has(tool)) {
        out.push(`R5c ${tool} — soft-cap.ts ${label} 에 선언됐는데 그 이름의 capability 가 없다(툴 rename·삭제 뒤 남은 죽은 선언)`);
      }
    }
  }
  return out;
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
//  tables — R5 의 선언 표를 주입(자기검증 전용). 미지정이면 실제 soft-cap.ts 표를 cap.name 으로 찾는다(본 검사 경로).
export function checkCapability(
  cap: Capability,
  tables?: { soft?: Readonly<Record<string, { limit: number }>>; hardOk?: readonly string[] },
): string[] {
  const declared = new Set(Object.keys(cap.input ?? {}));
  const { uses, fields } = inputUsage(cap.handler);
  const out: string[] = [];
  if (cap.expose.mcp) {
    if (!uses) return [];                              // 입력을 안 씀 → 빈 스키마 정상
    if (!declared.size) {                              // 스키마가 비면 먼저 R1(그 상태선 R2/R3/R4 판정이 무의미)
      return [`R1 ${cap.name} [scope=${cap.scope}] — 핸들러가 입력을 쓰는데 input 스키마가 비었다(전 필드 strip)`];
    }
    const missing = fields.filter((f) => !declared.has(f));
    if (missing.length) {
      out.push(`R2 ${cap.name} [scope=${cap.scope}] — 핸들러가 읽는데 미선언: ${missing.join(", ")} (그 필드만 strip)`);
    }
    // R3 — 핸들러가 생략을 보존(preserve)으로 지원하는데 스키마가 required → MCP 로 그 필드를 못 뺀다(부분수정 불가).
    for (const f of preserveOmitFields(cap.handler)) {
      if (!declared.has(f)) continue;                  // 미선언은 R2 소관
      if (!mcpOptional(cap.input[f])) {
        out.push(`R3 ${cap.name} [scope=${cap.scope}] — 핸들러는 ${f} 생략을 보존으로 지원하는데 스키마가 required → MCP 로 부분수정 시 ${f} 를 못 뺀다(#970 event 부류; 스키마에 .optional() 필요)`);
      }
    }
  } else if (!uses) {
    return [];                                         // REST 전용 + 입력 미사용 → 빈 스키마 정상
  }
  // R4 — 어댑터(REST parse)가 **싣는** 키 기준. 핸들러 쪽 신호(R2)가 없는 읽기 방식이어도 여기서 잡힌다.
  //  ⚠ mcp:false 도 검사한다(#1403): input 은 expose.mcp 와 무관하게 parse 산출을 선언하는 게 규약이고
  //   (types.ts), 어긋난 채로 mcp:true 로 여는 순간 그 필드가 조용히 strip 되기 때문이다.
  // R5 — #1442 소프트캡 정합. 대상은 **스키마 자체**(핸들러 소스가 아니다)라 mcp:false 여부와 무관하게 검사한다:
  //  REST 경로는 zod 를 안 타므로 지금은 무해하지만, 같은 스키마를 mcp:true 로 여는 순간 하드 리젝트가 산다.
  const strFields = Object.entries(cap.input ?? {})
    .map(([f, zt]) => [f, stringCap(zt)] as const)
    .filter((e): e is readonly [string, { max: number | null }] => e[1] !== null);
  const soft = tables?.soft ?? SOFT_CAPS[cap.name] ?? {};
  const hardOk = new Set(tables?.hardOk ?? HARD_CAP_OK[cap.name] ?? []);
  // R5a/R5c — 선언(soft-cap.ts 표)과 스키마의 정합. 선언한 쪽이 거짓이 되는 두 방향을 각각 본다.
  for (const [f, spec] of Object.entries(soft)) {
    const found = strFields.find(([k]) => k === f)?.[1];
    if (!found) {
      out.push(`R5c ${cap.name} — SOFT_CAPS 에 선언된 ${f} 가 스키마에 문자열 필드로 없다(rename·삭제 뒤 남은 죽은 선언 — 표가 거짓이 된다)`);
      continue;
    }
    if (found.max !== null) {
      out.push(`R5a ${cap.name} — 소프트캡 필드 ${f} 에 zod .max(${found.max}) 가 붙어 있다(선언만 남고 효력 소멸: SDK 가 핸들러 앞에서 거부해 본문 전체가 함께 튕긴다 — ${spec.limit}자 상한은 describe+applySoftCaps 로만)`);
    }
  }
  for (const f of hardOk) {
    if (!strFields.some(([k]) => k === f)) {
      out.push(`R5c ${cap.name} — HARD_CAP_OK 에 선언된 ${f} 가 스키마에 문자열 필드로 없다(죽은 선언)`);
    }
  }
  // R5b — heavy 툴(대형 본문을 받는 툴)의 짧은 하드캡 필드는 분류 선언이 있어야 한다.
  if (strFields.some(([, c]) => c.max !== null && c.max >= HEAVY_PAYLOAD_CHARS)) {
    for (const [f, c] of strFields) {
      if (c.max === null || c.max >= HEAVY_PAYLOAD_CHARS) continue;   // 상한 없음 / 본문급 필드는 대상 밖
      if (f in soft || hardOk.has(f)) continue;                       // 이미 분류됨
      out.push(`R5b ${cap.name} — heavy payload 툴인데 ${f}=max(${c.max}) 가 분류되지 않았다(이 한 필드의 초과가 본문 전체를 튕기고 그 실패는 mcp_call_log 에도 안 남는다) → soft-cap.ts 의 SOFT_CAPS(조정) 또는 HARD_CAP_OK(기계값이라 거부가 맞다)에 선언하라`);
    }
  }
  const emitted = parseEmittedKeys(cap).filter((f) => !declared.has(f));
  if (emitted.length) {
    const impact = cap.expose.mcp
      ? "MCP 로는 그 필드를 못 보낸다 — description 의 restEquivHint 가 그 필드에서 거짓"
      : "지금은 mcp:false 라 무해하나, mcp:true 로 여는 순간 그 필드가 strip 된다";
    out.push(`R4 ${cap.name} [scope=${cap.scope}] — REST parse 는 싣는데 스키마 미선언: ${emitted.join(", ")} (${impact})`);
  }
  return out;
}

// ── 본 검사 — 레지스트리(= MCP 어댑터가 실제로 등록하는 그 객체들)를 그대로 순회 ──
const offenders: string[] = [];
for (const cap of registry.values()) offenders.push(...checkCapability(cap));
offenders.push(...declaredToolDrift([...registry.values()].map((c) => c.name)));
assert.equal(offenders.length, 0,
  `#923 — MCP 로 호출 불가/부분불통인 capability ${offenders.length}종:\n` +
  offenders.map((o) => "    " + o).join("\n") +
  "\n  → R1/R2: restRuntime/restOnly/restRead 의 input 인자에 zod raw shape 을 선언하라(핸들러가 읽는 필드 **전부** —" +
  "\n    zod 는 미선언 키를 strip 하므로 빠뜨린 필드는 계속 하네스에서 안 보인다). 입력을 안 쓰는 핸들러면 파라미터를 지우거나 `_input` 으로 표시하라." +
  "\n  → R3: 핸들러가 생략을 보존(preserve)으로 지원하면 스키마 필드에 .optional() 을 붙여라(안 붙이면 SDK 가 누락을 먼저 거부해 MCP 로 부분수정 불가)." +
  "\n  → R4: REST mount.parse 가 싣는 키를 input 스키마에도 선언하라. 그 필드가 REST 전용이 맞다면 parse 에서 빼라 —" +
  "\n    둘 중 하나를 하지 않으면 description 의 restEquivHint('REST body = 이 입력 스키마와 동일 필드')가 거짓이 된다." +
  "\n  → R5(#1442): heavy payload 툴의 짧은 문자열 필드는 zod .max() 로 막지 말고 soft-cap.ts 에 분류를 선언하라 —" +
  "\n    SOFT_CAPS(핸들러가 조정 + 응답 capped 로 보고) 또는 HARD_CAP_OK(기계값이라 거부가 맞다는 판단, 이유를 주석으로)." +
  "\n    하드 상한을 두면 그 한 필드 때문에 본문 전체가 튕기고(SDK 는 핸들러 앞에서 검증) 그 실패는 mcp_call_log 에도 안 남는다.");

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

// ── R4(어댑터 정합) 자기검증 — 사양 엣지 표 13행 전수(#1403). 관측 장치가 죽으면 이 규칙은 '통과하면서 아무것도
//  안 보는' 테스트가 되므로, 배선 단언(어댑터가 실제로 불려 필드를 관측했다)을 함께 둔다. ──
type ProbeReq = { params: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> };
const r4Cap = (input: z.ZodRawShape, parse: (req: ProbeReq) => Record<string, unknown>): Capability => ({
  name: "synthetic_parse_drift",
  title: "t",
  description: "d",
  scope: null,
  input,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/x"], parse: parse as unknown as RestMount["parse"] }] },
  handler: ((i: Record<string, unknown>) => ({ ok: i.id })) as unknown as Capability["handler"],
});

t("R4 (1) known-bad: 어댑터가 싣는데 스키마에 없는 필드를 red 로 잡는다", () => {
  const cap = r4Cap({ id: z.number() }, (req) => ({ id: Number(req.params?.id), limit: 10 }));
  assert.deepEqual(parseEmittedKeys(cap).sort(), ["id", "limit"]);   // 배선 — 어댑터가 실제로 불려 관측됐다
  const found = checkCapability(cap);
  assert.equal(found.length, 1);
  assert.match(found[0], /^R4 synthetic_parse_drift\b/);
  assert.match(found[0], /limit/);
});
t("R4 (2) 그 필드를 스키마에 선언하면 green(1 의 복원 대칭)", () => {
  assert.deepEqual(
    checkCapability(r4Cap({ id: z.number(), limit: z.number().optional() }, (req) => ({ id: Number(req.params?.id), limit: 10 }))),
    [],
  );
});
t("R4 (3) 어댑터가 어떤 입력에도 실패하면 관측 불가 → 통과(못 본 것을 위반이라 부르지 않는다)", () => {
  assert.deepEqual(checkCapability(r4Cap({ id: z.number() }, () => { throw new Error("검증 실패"); })), []);
});
t("R4 (4) 열거형의 특정 선택지에서만 실리는 필드까지 관측한다(task_time_v6 형태)", () => {
  const found = checkCapability(r4Cap(
    { id: z.number(), action: z.enum(["start", "add"]) },
    (req) => (String(req.body?.action) === "add"
      ? { id: 1, action: "add", seconds: 60 }
      : { id: 1, action: "start" }),
  ));
  assert.equal(found.length, 1);
  assert.match(found[0], /seconds/);
});
t("R4 (5) REST 어댑터가 없는 MCP 전용 op 은 관측 대상 아님", () => {
  const cap = r4Cap({ id: z.number() }, () => ({ id: 1, limit: 10 }));
  assert.deepEqual(parseEmittedKeys({ ...cap, expose: { mcp: true, rest: false } }), []);
});
t("R4 (6) MCP 미노출이어도 검사한다(#1403 규약) — 다만 영향 문구가 '아직 무해'로 달라진다", () => {
  const cap = r4Cap({ id: z.number() }, () => ({ id: 1, limit: 10 }));
  const found = checkCapability({ ...cap, expose: { ...cap.expose, mcp: false } });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R4 synthetic_parse_drift\b/);
  assert.match(found[0], /limit/);
  assert.match(found[0], /mcp:true 로 여는 순간/);          // mcp:true 판(restEquivHint 거짓) 문구가 아니다
});
t("R4 (6b) MCP 미노출 + 빈 스키마 + parse 산출 → R1 이 아니라 R4 가 잡는다(R1 은 MCP 전용)", () => {
  const cap = r4Cap({}, () => ({ id: 1, limit: 10 }));
  const found = checkCapability({ ...cap, expose: { ...cap.expose, mcp: false } });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R4 /);
  assert.match(found[0], /id, limit|limit, id/);
});
t("R4 (6c) MCP 미노출 + 핸들러가 입력을 안 씀 → 빈 스키마가 정상(위반 0)", () => {
  const cap: Capability = {
    ...r4Cap({}, () => ({ id: 1 })),
    handler: ((_i: unknown, u: { userId?: string }) => ({ me: u?.userId })) as unknown as Capability["handler"],
  };
  assert.deepEqual(checkCapability({ ...cap, expose: { ...cap.expose, mcp: false } }), []);
});
t("R4 (7) 스키마가 비어 있으면 R1 이 먼저 보고한다(R4 는 도달하지 않음)", () => {
  const found = checkCapability(r4Cap({}, () => ({ id: 1, limit: 10 })));
  assert.equal(found.length, 1);
  assert.match(found[0], /^R1 /);
});
t("R4 (8) 입력을 통째로 펼쳐 싣는 어댑터 — 스키마 필드가 관측되어 위반 0", () => {
  const cap = r4Cap({ id: z.number(), note: z.string().optional() }, (req) => ({ ...req.body }));
  assert.deepEqual(parseEmittedKeys(cap).sort(), ["id", "note"]);   // 배선 — 펼침 경로에서도 관측된다
  assert.deepEqual(checkCapability(cap), []);
});
t("R4 (9) 표본: 열거형은 라운드 순서로 순회하고 한 바퀴 뒤 처음으로(난수 없음 — CI 재현성)", () => {
  assert.deepEqual([0, 1, 2, 3].map((r) => sampleOf(z.enum(["a", "b", "c"]), r)), ["a", "b", "c", "a"]);
});
t("R4 (10) 표본: 선택·널·기본값 래핑은 안쪽 타입의 표본을 그대로 쓴다", () => {
  assert.equal(sampleOf(z.string().optional(), 1), sampleOf(z.string(), 1));
  assert.equal(sampleOf(z.enum(["a", "b"]).nullable(), 1), "b");
  assert.equal(sampleOf(z.number().default(3), 1), sampleOf(z.number(), 1));
});
t("R4 (11) 표본: 배열은 2개 이상 — 길이 하한 검증(ids 는 2개 이상)을 통과할 수 있게", () => {
  const s = sampleOf(z.array(z.enum(["a", "b"])), 0);
  assert.ok(Array.isArray(s) && s.length >= 2);
  assert.deepEqual(s, ["a", "b"]);
});
t("R4 (12) 표본: 처음 보는 타입·부재도 실패 없이 일반 표본으로 대체된다", () => {
  assert.equal(sampleOf(z.object({ a: z.string() }), 0), "x");
  assert.equal(sampleOf(undefined, 0), "x");
  assert.equal(sampleOf(null, 1), "1");
});
t("R4 (13) 선택지가 라운드보다 많아 미도달 분기가 남아도 통과한다(놓칠지언정 헛짚지 않는다)", () => {
  const cap = r4Cap(
    { id: z.number(), pick: z.enum(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11"]) },
    (req) => (String(req.body?.pick) === "a11" ? { id: 1, pick: "a11", rare: 1 } : { id: 1, pick: "a0" }),
  );
  assert.deepEqual(checkCapability(cap), []);
});

// ── R5(#1442 소프트캡 정합) 자기검증 — 사양(spec) C 표 전수. 선언 표를 **주입**해(tables) 합성 cap 으로
//  known-bad 를 만든다: 실제 SOFT_CAPS 를 건드리지 않고 '가드가 red 를 낼 수 있는가'를 증명하고, 그 반대편
//  green 을 대칭으로 고정한다(복원 대칭이 없으면 red 만 보고 '고쳤다'고 착각할 수 있다). ──
const capOf = (input: z.ZodRawShape): Capability => ({
  name: "synthetic_soft_cap", title: "t", description: "d", scope: null, input,
  expose: { mcp: true, rest: false },
  handler: ((i: Record<string, unknown>) => ({ ok: i.body_md })) as unknown as Capability["handler"],
});
const r5 = (input: z.ZodRawShape, tables?: Parameters<typeof checkCapability>[1]): string[] =>
  checkCapability(capOf(input), tables).filter((m) => m.startsWith("R5"));
const HEAVY_BODY = z.string().max(200_000);

t("R5 C1 known-bad: heavy 본문 + 분류 없는 짧은 하드캡 필드 → red", () => {
  const found = r5({ body_md: HEAVY_BODY, title: z.string().max(200).optional() });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R5b synthetic_soft_cap\b/);
  assert.match(found[0], /title=max\(200\)/);
});
t("R5 C2 (복원 대칭) 그 필드를 '의도적 거부'로 분류하면 green", () => {
  assert.deepEqual(r5({ body_md: HEAVY_BODY, title: z.string().max(200).optional() }, { hardOk: ["title"] }), []);
});
t("R5 C3 (복원 대칭) 하드 상한을 떼고 '조정'으로 분류하면 green — #1442 의 목표 형태", () => {
  assert.deepEqual(r5({ body_md: HEAVY_BODY, title: z.string().optional() }, { soft: { title: { limit: 200 } } }), []);
});
t("R5 C4: heavy 필드가 없는 툴은 대상 밖 — 재전송 비용이 없는 자리는 건드리지 않는다", () => {
  assert.deepEqual(r5({ description: z.string().max(4_000), title: z.string().max(200).optional() }), []);
});
t("R5 C5 경계: 본문 필드가 임계 미만이면 heavy 가 아니다", () => {
  assert.deepEqual(r5({ body_md: z.string().max(HEAVY_PAYLOAD_CHARS - 1), title: z.string().max(200).optional() }), []);
});
t("R5 C6 경계: 본문 필드가 임계와 같으면 heavy 다", () => {
  assert.equal(r5({ body_md: z.string().max(HEAVY_PAYLOAD_CHARS), title: z.string().max(200).optional() }).length, 1);
});
t("R5 C7: 상한 없는 짧은 필드는 위반이 아니다(하드 리젝트를 만들지 않으므로)", () => {
  assert.deepEqual(r5({ body_md: HEAVY_BODY, note: z.string().optional() }), []);
});
t("R5 C8: 문자열이 아닌 필드는 대상 밖(숫자·열거·불리언)", () => {
  assert.deepEqual(r5({ body_md: HEAVY_BODY, n: z.number().int(), e: z.enum(["a", "b"]), b: z.boolean() }), []);
});
t("R5 C9 known-bad: '조정' 선언 필드에 하드 상한이 (되)붙으면 red — 선언만 남고 효력 소멸", () => {
  const found = r5({ body_md: HEAVY_BODY, title: z.string().max(200).optional() }, { soft: { title: { limit: 200 } } });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R5a synthetic_soft_cap\b/);
  assert.match(found[0], /\.max\(200\)/);
});
t("R5 C10: 래핑(선택·널·기본값) 안쪽의 상한도 찾아낸다 — 선언 순서로 가드를 피할 수 없다", () => {
  for (const zt of [z.string().max(200).nullable().optional(), z.string().max(200).default("x"), z.string().max(200).nullable()]) {
    assert.equal(r5({ body_md: HEAVY_BODY, title: zt }, { soft: { title: { limit: 200 } } }).length, 1);
  }
});
t("R5 C11 known-bad: '조정' 선언 필드가 스키마에 없으면 red(rename·삭제 뒤 남은 죽은 선언)", () => {
  const found = r5({ body_md: HEAVY_BODY }, { soft: { headline: { limit: 200 } } });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R5c synthetic_soft_cap\b/);
  assert.match(found[0], /headline/);
});
t("R5 C12 known-bad: '의도적 거부' 쪽 죽은 선언도 잡는다", () => {
  const found = r5({ body_md: HEAVY_BODY }, { hardOk: ["gone_field"] });
  assert.equal(found.length, 1);
  assert.match(found[0], /^R5c /);
  assert.match(found[0], /gone_field/);
});
t("R5 C13: 선언된 이름이 문자열 아닌 필드면 죽은 선언으로 본다(문자열 상한은 문자열에만 의미가 있다)", () => {
  assert.match(r5({ body_md: HEAVY_BODY, n: z.number() }, { soft: { n: { limit: 200 } } })[0], /^R5c /);
});
t("R5 C14 실배선(회귀): 실제 knowledge_save 는 R5 위반 0이고 다섯 필드에 하드 상한이 없다 — #1442 재발 시 red", () => {
  const cap = [...registry.values()].find((c) => c.name === "knowledge_save");
  assert.ok(cap, "knowledge_save capability 가 있어야 한다");
  assert.deepEqual(checkCapability(cap!).filter((m) => m.startsWith("R5")), []);
  for (const f of ["title", "name", "supersedes", "parent_name", "change_note"]) {
    assert.equal(stringCap(cap!.input[f])?.max, null, `knowledge_save.${f} 에 zod .max() 가 붙으면 본문 전체가 튕긴다`);
  }
});
t("R5 C15: 선언 표의 툴 이름이 존재하지 않으면 red(툴 단위 죽은 선언) / 존재하면 green", () => {
  const drift = declaredToolDrift(["knowledge_save"]);          // source_save·activity_log·delegate_run 이 없는 세계
  assert.ok(drift.length >= 2, "없는 툴 이름들이 보고돼야 한다");
  assert.ok(drift.every((m) => m.startsWith("R5c ")));
  assert.deepEqual(declaredToolDrift([...registry.values()].map((c) => c.name)), []);   // 실배선은 드리프트 0
});
t("R5 C16 표본(stringCap): 문자열 아님→null · 상한 없는 문자열→{max:null} · 상한 있음→그 값", () => {
  assert.equal(stringCap(z.number()), null);
  assert.equal(stringCap(z.enum(["a"])), null);
  assert.equal(stringCap(undefined), null);
  assert.deepEqual(stringCap(z.string()), { max: null });
  assert.deepEqual(stringCap(z.string().min(1).optional()), { max: null });
  assert.deepEqual(stringCap(z.string().max(7)), { max: 7 });
});

const exposed = [...registry.values()].filter((c) => c.expose.mcp).length;
console.log(`ok  #923 MCP input 스키마 가드 — 노출 ${exposed}종 R1/R2/R3/R4 위반 0 + 자기검증 ${pass}건`);
