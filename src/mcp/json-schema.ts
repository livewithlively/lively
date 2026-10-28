// 도구 입력 스키마(JSON Schema) 위생 검사 + zod 셰이프 변환 — 잎 모듈(zod · http-error 만).
//  소비자: mcp/dynamic-tools.ts(http_proxy 도구 — 저장 · 등록) · apps/app-mcp-decl.ts(#5050 앱이 선언한 MCP 도구 — 설치 검사 · 등록).
//  본문은 dynamic-tools.ts 에 있던 것 그대로다(#5050 에서 옮김 — 앱 선언 도구의 설치 검사가 프록시 배관(DB · 자격 · SSRF)을 끌어오지 않게).
//  dynamic-tools.ts 가 같은 이름으로 다시 내보내 기존 import 는 그대로다.
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { HttpError } from "../http-error.js";

// 저장 시 input_schema 위생 검사(B21 경량판 — ajv 무의존): $ref 금지·크기/깊이 상한·최상위 object.
export function assertSafeJsonSchema(schema: unknown): void {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== "object" || Array.isArray(schema)) throw new HttpError(400, "input_schema 는 객체여야 합니다");
  const json = JSON.stringify(schema);
  if (json.length > 32 * 1024) throw new HttpError(400, "input_schema 가 너무 큽니다(32KiB 초과)");
  if (/"\$ref"|"\$dynamicRef"|"\$recursiveRef"/.test(json)) throw new HttpError(400, "input_schema 에 $ref 는 허용되지 않습니다");
  if (/"(__proto__|constructor|prototype)"\s*:/.test(json)) throw new HttpError(400, "input_schema 에 예약 키(__proto__/constructor/prototype)는 허용되지 않습니다");
  const walk = (v: unknown, d: number): void => {
    if (d > 6) throw new HttpError(400, "input_schema 중첩이 너무 깊습니다(6단 초과)");
    if (v && typeof v === "object") for (const val of Object.values(v as Record<string, unknown>)) walk(val, d + 1);
  };
  walk(schema, 0);
  const s = schema as { type?: unknown };
  if (s.type !== undefined && s.type !== "object") throw new HttpError(400, "input_schema 의 최상위 type 은 object 여야 합니다");
}

// JSON Schema(object) → MCP inputSchema(zod raw shape). 단순 평면 스키마만 정밀 변환, 그 외는 unknown.
//  (정밀 깊은 검증보다 SSRF/scope/allowlist 가 1차 방어선이라 인자 검증은 타입 수준으로 충분 — v1.)
export function jsonSchemaToZodShape(schema: unknown): ZodRawShape {
  const shape: ZodRawShape = {};
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  if (!s.properties || typeof s.properties !== "object") return shape;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const [key, propRaw] of Object.entries(s.properties)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue; // 프로토타입 오염 차단
    const p = (propRaw ?? {}) as { type?: string; description?: string };
    let zt: ZodTypeAny;
    switch (p.type) {
      case "string": zt = z.string(); break;
      case "number": case "integer": zt = z.number(); break;
      case "boolean": zt = z.boolean(); break;
      case "array": zt = z.array(z.unknown()); break;
      case "object": zt = z.object({}).passthrough(); break;
      default: zt = z.unknown();
    }
    if (p.description) zt = zt.describe(p.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}
