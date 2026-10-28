// 앱이 선언한 MCP 도구(#5050 앱 v2-40) — 매니페스트 최상위 `mcp_tools` 의 선언 읽기 · 설치 검사 · 표시. DB 를 보지 않는다
//  (실행기 등록부와 빌트인 도구 이름표만 본다). 등록 · 부르기는 mcp/app-declared-tools.ts, 다른 앱과의 이름 겹침(DB)은 apps/app-mcp-store.ts.
//  명세: 지식 app-declared-mcp-tools-spec-v1(§3 매니페스트 · §4 등록 · §6 권한 · §13 결정).
//
//  ── 선언 한 개 ───────────────────────────────────────────────────────────────────────────
//   { name, title?, description, input?, run: { kind, … }, level? }
//   · name   — 구성원의 AI 도구 목록에 그대로 서는 이름(★2 상민 2026-10-28 — 접두 없이, 겹치면 설치 거부). 소문자 슬러그 1~64자 ·
//              빌트인 이름 · `ext__`(프록시 도구 자리) 불가.
//   · input  — 입력 JSON Schema(최상위 object). 속성 이름은 Claude API 규칙(^[a-zA-Z0-9_.-]{1,64}$)을 지킨다 — 한 도구라도 어기면
//              그 사람의 도구 목록 요청이 통째로 거부된다(mcp/dynamic-tools.ts 머리말). 그래서 설치가 막고, 저장된 것도 목록에 올리지 않는다.
//   · run    — 실행기 선택(kind)과 그 실행기의 칸. 칸 검사는 실행기의 validate 몫이다(apps/app-mcp-executors.ts).
//   · level  — L0 조회 · L1 제안(org_tool 어휘). 없으면 L1(쓰는 도구로 본다 — 읽기 전용 연결에서 숨는다). L2(집행)는 아직 받지 않는다.
//
//  ── 두 가지 읽기 ─────────────────────────────────────────────────────────────────────────
//   · 설치 · 판 저장(assertAppMcpToolsInstallable) — 엄격: 모르는 칸 · 모르는 실행기 · 같은 이름 두 번 · 빌트인 이름이면 400.
//   · 저장된 매니페스트(appMcpToolsOf) — 던지지 않는다: 모양이 틀린 항목만 건너뛴다(새 코어에서 깔고 이 코어로 되돌린 앱도 나머지는 읽힌다).
//     최상위 칸이라 이 칸을 모르는 옛 코어는 매니페스트를 그대로 읽고 이 칸을 무시한다(manifest.ts 최상위 passthrough).
//
//  ── 동의 전 표시(consentPresentation) ─────────────────────────────────────────────────────
//   ★3(상민 2026-10-28) — 동의 없는 사람이 부르면 «앱 화면에서 동의하세요» 와 동의 주소를 돌려준다. 그래서 동의 전에도 목록에 서야 한다.
//   다만 앱이 쓴 설명 · 입력 설명은 동의한 사람의 AI 에게만 싣는다 — 구성원이 저장한 앱의 글이 그 앱을 고른 적 없는 사람의 AI 지침이
//   되지 않게(apps/member-app.ts «동의하지 않은 사람에게 새는 것이 없다»). 동의 전에는 게이트웨이가 쓴 한 줄 설명과 빈 입력만 보인다.
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { STRICT_SLUG, assertToolName } from "../org/asset-id.js";
import { assertSafeJsonSchema } from "../mcp/json-schema.js";
import { appMcpExecutor, appMcpExecutorKinds } from "./app-mcp-executors.js";

/** 앱 하나가 선언할 수 있는 도구 수. */
export const APP_MCP_TOOLS_MAX = 32;
/** 받는 level — L2(집행)는 아직 받지 않는다(명세 §3). */
export const APP_MCP_LEVELS = ["L0", "L1"] as const;
export type AppMcpLevel = (typeof APP_MCP_LEVELS)[number];
/** 도구 결과 글의 상한 — http_proxy 도구 응답 상한(mcp/dynamic-tools.ts maxBytes)과 같은 값. 넘으면 잘라 표시한다. */
export const APP_MCP_RESULT_MAX_BYTES = 256 * 1024;
/** 프록시 MCP 도구가 쓰는 이름 자리(mcp/mcp-proxy.ts `ext__<서버>__<도구>`) — 앱 도구는 이 접두를 못 쓴다. */
export const PROXY_TOOL_PREFIX = "ext__";
/** 도구 정의 _meta 의 앱 표지 — server.ts 의 호출 기록(instrument)이 이 값으로 그 호출을 앱에 귀속한다(mcp_call_log.app · org_app_activity). */
export const APP_TOOL_META_KEY = "lively/app";
/** Claude API 의 입력 속성 이름 규칙(mcp/dynamic-tools.ts 머리말 #4211). */
const INPUT_PROP_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface AppMcpToolDecl {
  name: string;
  title?: string;
  description: string;
  /** 입력 JSON Schema(최상위 object). 선언에 없으면 빈 object. */
  input: Record<string, unknown>;
  run: { kind: string } & Record<string, unknown>;
  level: AppMcpLevel;
}

const declBase = z.object({
  name: z.string().regex(STRICT_SLUG, "name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다"),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1, "description 이 필요합니다 — AI 가 이 도구를 언제 쓸지 고르는 근거입니다").max(2000),
  input: z.record(z.unknown()).optional(),
  run: z.object({ kind: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "run.kind 는 실행기 이름(소문자 영숫자/_/-)이어야 합니다") }).passthrough(),
  level: z.enum(APP_MCP_LEVELS, { errorMap: () => ({ message: "level 은 L0(조회) 또는 L1(제안)입니다 — L2(집행)는 아직 받지 않습니다" }) }).default("L1"),
});
/** 설치 · 저장 — 모르는 칸은 거부(오타가 곧 다른 뜻). */
const declStrict = declBase.strict();
/** 저장된 것 — 모르는 칸은 무시(새 코어가 더한 칸). */
const declLenient = declBase.passthrough();

/** 모양 밖의 규칙(이름 자리 · 입력 스키마 위생 · 속성 이름) — 틀리면 까닭, 맞으면 null. 두 읽기가 같이 쓴다. */
function declRuleProblem(d: { name: string; input?: Record<string, unknown> }): string | null {
  if (d.name.startsWith(PROXY_TOOL_PREFIX)) return `name 은 '${PROXY_TOOL_PREFIX}' 로 시작할 수 없습니다(프록시 도구 자리)`;
  if (d.input !== undefined) {
    try { assertSafeJsonSchema(d.input); } catch (e) { return `input — ${(e as Error).message}`; }
    const props = (d.input as { properties?: unknown }).properties;
    if (props !== undefined && (props === null || typeof props !== "object" || Array.isArray(props))) return "input.properties 는 객체여야 합니다";
    for (const k of Object.keys((props ?? {}) as Record<string, unknown>)) {
      if (!INPUT_PROP_RE.test(k)) return `input.properties 의 이름 '${k}' 은(는) 쓸 수 없습니다 — 영문·숫자·_·.·- 1~64자만(AI 도구 규칙)`;
    }
  }
  return null;
}

function normalize(d: z.infer<typeof declBase>): AppMcpToolDecl {
  return {
    name: d.name,
    ...(d.title ? { title: d.title } : {}),
    description: d.description,
    input: d.input ?? { type: "object", properties: {} },
    run: d.run as AppMcpToolDecl["run"],
    level: d.level,
  };
}

/**
 * 저장된 매니페스트에서 선언을 읽는다 — 모양이 틀린 항목은 건너뛴다(던지지 않는다). 같은 이름이면 앞의 것. 앞에서 APP_MCP_TOOLS_MAX 개까지.
 *  실행기가 등록돼 있는지는 보지 않는다(부르는 쪽이 appMcpExecutor 로 거른다 — 목록은 거르고, 설치는 막는다).
 */
export function appMcpToolsOf(manifest: unknown): AppMcpToolDecl[] {
  const raw = (manifest as { mcp_tools?: unknown } | null)?.mcp_tools;
  if (!Array.isArray(raw)) return [];
  const out: AppMcpToolDecl[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, APP_MCP_TOOLS_MAX)) {
    const p = declLenient.safeParse(item);
    if (!p.success || declRuleProblem(p.data) || seen.has(p.data.name)) continue;
    seen.add(p.data.name);
    out.push(normalize(p.data));
  }
  return out;
}

/** 매니페스트가 이 칸을 선언했나(빈 배열 포함) — 설치 검사를 건너뛸지 가른다. */
export function declaresMcpTools(manifest: unknown): boolean {
  return (manifest as { mcp_tools?: unknown } | null)?.mcp_tools !== undefined;
}

/**
 * 설치 · 판 저장 때의 검사 — 틀리면 HttpError(400) «매니페스트 오류 [mcp_tools.<i>…]». 실행기의 validate 까지 돈다.
 *  다른 앱 · 조직 도구와의 이름 겹침은 DB 가 필요해 여기서 보지 않는다(apps/app-mcp-store.ts assertMcpToolNamesFree — 설치 코어가 부른다).
 */
export async function assertAppMcpToolsInstallable(manifest: unknown): Promise<AppMcpToolDecl[]> {
  if (!declaresMcpTools(manifest)) return [];
  const raw = (manifest as { mcp_tools?: unknown }).mcp_tools;
  if (!Array.isArray(raw)) throw new HttpError(400, "매니페스트 오류 [mcp_tools]: 도구 선언의 배열이어야 합니다");
  if (raw.length > APP_MCP_TOOLS_MAX) throw new HttpError(400, `매니페스트 오류 [mcp_tools]: 도구는 앱 하나에 ${APP_MCP_TOOLS_MAX}개까지입니다(${raw.length}개)`);
  const out: AppMcpToolDecl[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const p = declStrict.safeParse(raw[i]);
    if (!p.success) {
      const first = p.error.issues[0];
      const where = ["mcp_tools", String(i), ...(first?.path ?? []).map(String)].join(".");
      const msg = first?.code === "unrecognized_keys"
        ? `모르는 칸입니다(${(first as { keys?: string[] }).keys?.join(", ") ?? ""}) — name · title · description · input · run · level 만 씁니다(실행기의 설정은 run 안에)`
        : first?.message ?? "형식이 올바르지 않습니다";
      throw new HttpError(400, `매니페스트 오류 [${where}]: ${msg}`);
    }
    const where = `매니페스트 오류 [mcp_tools.${i}]`;
    const rule = declRuleProblem(p.data);
    if (rule) throw new HttpError(400, `${where}: ${rule}`);
    try { assertToolName(p.data.name, "app_mcp"); } catch (e) { throw new HttpError(400, `${where}: ${(e as Error).message}`); }
    if (seen.has(p.data.name)) throw new HttpError(400, `${where}: 도구 이름 '${p.data.name}' 이(가) 두 번 있습니다`);
    seen.add(p.data.name);
    const decl = normalize(p.data);
    const ex = appMcpExecutor(decl.run.kind);
    if (!ex) {
      const kinds = appMcpExecutorKinds();
      throw new HttpError(400, `${where}: run.kind '${decl.run.kind}' 은(는) 이 코어가 모르는 실행기입니다` +
        (kinds.length ? `(쓸 수 있는 것: ${kinds.join(" · ")})` : " — 이 코어엔 아직 도구 실행기가 없습니다"));
    }
    try { await ex.validate?.(decl, manifest); }
    catch (e) { throw e instanceof HttpError ? new HttpError(e.status, `${where}: ${e.message}`, e.body ? { body: e.body } : undefined) : e; }
    out.push(decl);
  }
  return out;
}

// ── 약속(계약) 지문 ───────────────────────────────────────────────────────────────────────
//  목록에 올린 때와 부를 때의 선언이 같은 약속인가 — level · run · 입력의 모양(설명 · 제목 · 예시는 뺀다). 다르면 부르기를 멈추고 목록을
//  다시 받게 한다: 하네스는 목록의 표시(readOnlyHint 등)로 확인 절차를 정하는데, 그새 판이 바뀌어 L0 이 L1 이 됐거나 실행 칸이 바뀌었으면
//  사람이 본 것과 다른 일을 하게 된다. 설명만 바뀐 것은 막지 않는다.
const COSMETIC_KEYS = new Set(["description", "title", "examples", "$comment"]);
//  이름을 담는 칸 — 그 안의 키는 속성 이름이라(속성 이름이 'title' 일 수 있다) 설명으로 보지 않고 값만 다시 내려간다.
const NAMED_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
function schemaShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(schemaShape);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    if (COSMETIC_KEYS.has(k)) continue;
    const x = o[k];
    out[k] = NAMED_MAPS.has(k) && x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((p) => [p, schemaShape((x as Record<string, unknown>)[p])]))
      : schemaShape(x);
  }
  return out;
}
//  run 칸은 실행기의 설정이라 설명성 칸이 없다 — 값 전체가 약속이다(키 순서만 고정).
function sortedDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortedDeep((v as Record<string, unknown>)[k])]));
  return v;
}
/** 선언의 약속 지문(sha256 앞 16자). 같은 약속이면 같은 값 — 키 순서 · 설명 문구와 무관하다. */
export function appMcpToolContract(d: AppMcpToolDecl): string {
  return createHash("sha256").update(JSON.stringify({ level: d.level, run: sortedDeep(d.run), input: schemaShape(d.input) })).digest("hex").slice(0, 16);
}

// ── 표시 ────────────────────────────────────────────────────────────────────────────────
/** 앱 제목을 한 줄 이름표로 — 줄바꿈 · 제어 글자를 걷고 40자에서 자른다(동의 전 설명에 들어가는 유일한 앱 글자). */
export function appLabel(title: string): string {
  const s = String(title ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s || "앱";
}

/** 동의 전 표시 — 게이트웨이가 쓴 글만(앱의 설명 · 입력 설명은 싣지 않는다 · 머리말). */
export function consentPresentation(appTitle: string, d: AppMcpToolDecl): { title: string; description: string } {
  const label = appLabel(appTitle);
  return {
    title: `${label} · ${d.name} (동의 필요)`,
    description: `「${label}」 앱이 내놓은 도구입니다. 이 사람은 아직 이 앱 사용에 동의하지 않아 도구 설명을 싣지 않았습니다. ` +
      "이 앱이 필요해 보이면 불러 보세요 — 동의할 주소를 돌려줍니다. 동의한 뒤에는 도구 목록을 다시 받으면 설명이 보입니다.",
  };
}

/**
 * 동의 자리 — 라이블리 화면 `#/app-grant/<앱>?v=<판>&from=mcp`(web/v2/main.ts). 앱 주소의 동의(apps/app-front-api.ts consentUrlFor)와 같은 자리지만
 *  앱 주소를 만들 수 있어야 하는 조건이 없다 — AI 대화창에서 온 사람은 앱 주소로 돌아가지 않는다(from=mcp 면 화면이 «대화창으로 돌아가» 를 말한다).
 *  공개 주소를 모르면(org 프로필 · PUBLIC_URL 없음) null.
 */
export function appConsentUrl(base: string | null, appId: string, variant: "pub" | "draft"): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/ui/#/app-grant/${encodeURIComponent(appId)}?${new URLSearchParams({ v: variant, from: "mcp" }).toString()}`;
}

/** 결과 → 도구 결과 글. 글자는 그대로, 그 밖은 JSON 한 줄. 상한을 넘으면 UTF-8 경계에서 자르고 끝에 잘림 표시를 붙인다. */
export function renderToolResultText(data: unknown, max = APP_MCP_RESULT_MAX_BYTES): { text: string; truncated: boolean; bytes: number } {
  const text = typeof data === "string" ? data : (JSON.stringify(data === undefined ? null : data) ?? "null");
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false, bytes: buf.length };
  const cut = buf.subarray(0, max).toString("utf8").replace(/�+$/, "");
  return { text: `${cut}\n…(결과가 ${Math.round(max / 1024)}KiB 를 넘어 여기서 잘렸습니다 — 전체 ${buf.length}바이트)`, truncated: true, bytes: buf.length };
}
