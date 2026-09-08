// REST 어댑터의 enum 입력 검증 — REST↔MCP 파리티.
//  WHY: MCP 는 SDK 가 zod 스키마로 핸들러 앞에서 인자를 거른다. REST 는 그 스키마를 안 타서 허용값 밖의
//  값이 핸들러·DB 까지 흘러 정체불명의 500 으로 나갔다(계기: POST /api/ui/knowledge 의 type:"incident").
//  이 파일은 "REST 로 들어온 enum 밖 값은 400 으로 거부된다"를 **전 표면 전수**로 고정한다 —
//  특정 필드 하나의 예외 처방으로 퇴화하면(=한 곳만 고치면) R5 스캔이 즉시 red 가 된다.
//  실 DB 를 붙이지 않는다: 핸들러를 부르지 않고 어댑터 입력 파싱(mount.parse)까지만 관측한다.
//  실행: npx tsc -p tsconfig.json && node dist/capabilities/rest-enum-parity.test.js
import assert from "node:assert/strict";
import { registry, restMounts } from "./index.js";
import { HttpError } from "../http/rest-util.js";
import type { Capability, RestMount } from "./types.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; }).catch((e) => { throw new Error(`[${name}] ${e instanceof Error ? e.message : String(e)}`); });

const MOUNTS = restMounts();

// ── zod raw shape 해부 ───────────────────────────────────────────────────────
// WHY: 필드가 enum 인지는 REST 쪽 별도 표가 아니라 **스키마 선언 하나**에서 나와야 한다(R2 문구 이중정의 금지).
//  그래서 테스트도 같은 출처(zod 내부표현)만 보고 기대값을 만든다.
type EnumInfo = { values: readonly string[]; isArray: boolean; desc?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = any;

function peel(zt: AnyZod): { info: EnumInfo | null; base: AnyZod } {
  let cur = zt;
  let isArray = false;
  let desc: string | undefined;
  for (let i = 0; i < 12 && cur && cur._def; i++) {
    const d = cur._def;
    if (!desc && typeof d.description === "string") desc = d.description;
    if (d.typeName === "ZodEnum") return { info: { values: d.values, isArray, desc }, base: cur };
    if (d.typeName === "ZodArray") { isArray = true; cur = d.type; continue; }
    if (d.innerType) { cur = d.innerType; continue; }   // optional/nullable/default (R6)
    if (d.schema) { cur = d.schema; continue; }          // effects
    break;
  }
  return { info: null, base: cur };
}

const enumOf = (zt: AnyZod): EnumInfo | null => peel(zt).info;

function isOptional(zt: AnyZod): boolean {
  try { return zt.safeParse(undefined).success; } catch { return false; }
}

// ── 요청 목(mock) ────────────────────────────────────────────────────────────
// WHY: mount.parse 는 req 의 params/query/body/headers 만 읽으므로 express 없이 평범한 객체로 충분하다.
//  어느 통로를 읽는지는 마운트마다 다르므로 같은 값을 세 통로에 모두 실어 통로 의존성을 없앤다.
function mkReq(mount: RestMount, values: Record<string, unknown>, strFill: string): unknown {
  const path = mount.paths[0];
  const params: Record<string, unknown> = { ...values };
  for (const seg of path.split("/")) {
    if (!seg.startsWith(":")) continue;
    const k = seg.slice(1);
    if (params[k] === undefined) params[k] = strFill;
  }
  // 쿼리스트링은 문자열만 담긴다 — 배열은 콤마결합, 나머지는 String() 으로 실제 HTTP 모양을 맞춘다.
  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    query[k] = Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return {
    method: mount.method, path, originalUrl: path, ip: "127.0.0.1",
    headers: {}, params, query, body: { ...values },
  };
}

const parseWith = (mount: RestMount, values: Record<string, unknown>, strFill = "x") =>
  mount.parse(mkReq(mount, values, strFill) as never);

function caught(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

// ── 기준선(baseline) 채우기 ─────────────────────────────────────────────────
// WHY: enum 밖 값의 거부를 보려면 **나머지 필드 때문에 throw 하지 않는** 요청이 먼저 있어야 한다.
//  통과 조합을 못 찾으면 그 필드는 판정 불가이므로 스캔에서 버린다(오탐 0).
type Profile = { withOptional: boolean; str: string; num: unknown };
const PROFILES: Profile[] = [
  { withOptional: false, str: "x", num: "1" },
  { withOptional: true, str: "x", num: "1" },
  { withOptional: false, str: "1", num: 1 },
  { withOptional: true, str: "2026-01-01T00:00:00.000Z", num: "1" },
  { withOptional: false, str: "2026-01-01T00:00:00.000Z", num: "1" },
];

function fillValue(zt: AnyZod, p: Profile): unknown {
  const { info, base } = peel(zt);
  if (info) return info.isArray ? [info.values[0]] : info.values[0];
  const d = base?._def ?? {};
  switch (d.typeName) {
    case "ZodNumber": return p.num;
    case "ZodBoolean": return true;
    case "ZodArray": return [];
    case "ZodRecord": case "ZodObject": case "ZodUnknown": case "ZodAny": return {};
    case "ZodLiteral": return d.value;
    default: return p.str;
  }
}

function baseline(cap: Capability, p: Profile, target: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, zt] of Object.entries(cap.input)) {
    if (k !== target && !p.withOptional && isOptional(zt)) continue;
    out[k] = fillValue(zt, p);
  }
  return out;
}

/**
 * target 필드에 정상 enum 값을 넣은 채 parse 가 통과하고, **그 값이 핸들러 입력으로 실려 나오는**
 * 프로파일을 찾는다(없으면 null → 판정 불가라 스캔에서 버린다).
 * WHY 실려 나오는지까지 보는가: 어떤 마운트의 parse 는 그 필드를 애초에 싣지 않거나 자체 기본값으로
 *  치환한다. 그런 필드는 나쁜 값이 하류로 흐를 수 없으므로 이 규칙의 관측 대상이 아니다(오탐 0).
 *  반대로 값이 그대로 실려 나온다면 나쁜 값도 그대로 실릴 수 있으므로 반드시 400 이어야 한다.
 */
function findBaseline(cap: Capability, mount: RestMount, target: string): { values: Record<string, unknown>; str: string } | null {
  const info = enumOf(cap.input[target])!;
  const good = info.values[0];
  for (const p of PROFILES) {
    const values = baseline(cap, p, target);
    let out: Record<string, unknown> | null = null;
    try { out = parseWith(mount, values, p.str); } catch { continue; }
    if (JSON.stringify(out?.[target] ?? null).includes(good)) return { values, str: p.str };
  }
  return null;
}

const POISON = "__no_such_enum_value__";

// ── R1·R2 구체 사례 (실측 재현: POST /api/ui/knowledge, type:"incident" → 변경 전 500) ────────
const KNOWLEDGE_SAVE = MOUNTS.find((m) => m.cap.name === "knowledge_save" && m.mount.paths.includes("/api/ui/knowledge"));
assert.ok(KNOWLEDGE_SAVE, "knowledge_save 의 POST /api/ui/knowledge 마운트가 없다 — 테스트 전제 붕괴");
const KS_BODY = {
  name: "test-page", title: "제목", body_md: "본문",
  provenance: "authored", category: "admin-backoffice",
};
const KS_TYPE = enumOf(registry.get("knowledge_save")!.input.type);
assert.ok(KS_TYPE, "knowledge_save.type 이 enum 선언이 아니다 — 테스트 전제 붕괴");

await t("R1 enum 밖 값은 400 HttpError 로 거부된다 — 핸들러로 흘리지 않는다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "incident" }));
  assert.ok(err instanceof HttpError, `type:"incident" 가 거부되지 않았다(반환: ${JSON.stringify(err)}) — 하류로 샌다`);
  assert.equal(err.status, 400, `허용값 밖 입력은 400 이어야 한다(실제 ${err.status})`);
});

await t("R2 400 메시지에 허용값 전체 목록이 담긴다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "incident" })) as HttpError;
  const missing = KS_TYPE!.values.filter((v) => !err.message.includes(v));
  assert.equal(missing.length, 0, `허용값 누락: ${missing.join(", ")} — 메시지: ${err.message}`);
});

await t("R2 400 메시지에 스키마 선언의 안내문(.describe)이 함께 담긴다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "incident" })) as HttpError;
  const desc = KS_TYPE!.desc;
  assert.ok(desc, "knowledge_save.type 에 안내문 선언이 없다 — 테스트 전제 붕괴");
  // 안내문은 REST 에 재작성하지 않고 스키마 하나에서 나와야 한다 → 선언 문구가 그대로 들어있어야 한다.
  const head = desc!.slice(0, 24);
  assert.ok(err.message.includes(head), `안내문(${head}…)이 메시지에 없다 — 메시지: ${err.message}`);
});

await t("R2 위반한 필드 이름이 메시지에 있다(어디를 고칠지 특정 가능)", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "incident" })) as HttpError;
  assert.ok(err.message.includes("type"), `필드명이 없다 — 메시지: ${err.message}`);
});

await t("R3 허용값 안의 값은 통과하고 값이 보존된다", () => {
  const out = parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "decision" });
  assert.equal(out.type, "decision", "허용값이 과잉 차단되거나 값이 변형됐다");
});

await t("R3 나머지 허용값도 전부 통과한다(한 값만 특례 처리 아님)", () => {
  for (const v of KS_TYPE!.values) {
    const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: v }));
    assert.equal(err, null, `허용값 "${v}" 가 거부됐다: ${(err as Error)?.message}`);
  }
});

// ── R4 오탐 방지 — 미전송(undefined·null·"")은 enum 검증 대상이 아니다 ───────────────
await t("R4 미전송(필드 자체 없음)은 400 이 되지 않는다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY }));
  assert.equal(err, null, `필드를 안 보낸 정상 요청이 거부됐다: ${(err as Error)?.message}`);
});

await t("R4 빈 문자열은 400 이 되지 않는다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "" }));
  assert.equal(err, null, `type:"" 가 거부됐다 — REST 관례상 미전송이다: ${(err as Error)?.message}`);
});

await t("R4 null 은 400 이 되지 않는다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: null }));
  assert.equal(err, null, `type:null 이 거부됐다: ${(err as Error)?.message}`);
});

await t("R4 undefined 는 400 이 되지 않는다", () => {
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: undefined }));
  assert.equal(err, null, `type:undefined 가 거부됐다: ${(err as Error)?.message}`);
});

// ── R6 감싼 선언 / 배열 원소 판정 ────────────────────────────────────────────
await t("R6 optional 로 감싼 enum 도 같은 판정을 받는다", () => {
  // knowledge_save.type 은 raw shape 상 ZodOptional 로 감싸여 있다 — 겉껍질 typeName 만 보면 놓치는 자리.
  assert.notEqual((registry.get("knowledge_save")!.input.type as AnyZod)._def.typeName, "ZodEnum",
    "이 필드가 더는 감싼 선언이 아니다 — R6 표본을 다른 필드로 바꿔야 한다");
  const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: POISON }));
  assert.ok(err instanceof HttpError && err.status === 400, "감싼 enum 선언이 무검증 통과했다");
});

await t("R6 optional/nullable/default 로 감싼 enum 전수 — 감싼 종류별로 최소 1건씩 400", () => {
  const seen = new Map<string, string>();       // 감싼 종류 → 확인한 표본
  for (const { cap, mount } of MOUNTS) {
    for (const [k, zt] of Object.entries(cap.input)) {
      const wrapper = (zt as AnyZod)._def?.typeName;
      if (!["ZodOptional", "ZodNullable", "ZodDefault"].includes(wrapper)) continue;
      const info = enumOf(zt);
      if (!info || info.isArray || seen.has(wrapper)) continue;
      const base = findBaseline(cap, mount, k);
      if (!base) continue;
      const err = caught(() => parseWith(mount, { ...base.values, [k]: POISON }, base.str));
      assert.ok(err instanceof HttpError && err.status === 400,
        `${wrapper} 로 감싼 ${cap.name}.${k} 가 무검증 통과했다`);
      seen.set(wrapper, `${cap.name}.${k}`);
    }
  }
  assert.ok(seen.has("ZodOptional"), "optional 로 감싼 enum 표본을 하나도 못 찾았다 — 스캔이 고장났다");
});

await t("R6 배열 enum 은 원소 단위로 판정한다(정상 원소들은 통과, 나쁜 원소 하나면 400)", () => {
  let judged = 0;
  for (const { cap, mount } of MOUNTS) {
    for (const [k, zt] of Object.entries(cap.input)) {
      const info = enumOf(zt);
      if (!info || !info.isArray) continue;
      const base = findBaseline(cap, mount, k);
      if (!base) continue;
      const ok = caught(() => parseWith(mount, { ...base.values, [k]: [...info.values] }, base.str));
      assert.equal(ok, null, `${cap.name}.${k}: 허용값만 담은 배열이 거부됐다: ${(ok as Error)?.message}`);
      const bad = caught(() => parseWith(mount, { ...base.values, [k]: [info.values[0], POISON] }, base.str));
      assert.ok(bad instanceof HttpError && bad.status === 400,
        `${cap.name}.${k}: 나쁜 원소가 섞인 배열이 통과했다 — 원소 단위 판정이 아니다`);
      judged++;
    }
  }
  assert.ok(judged > 0, "배열 enum 표본을 하나도 판정하지 못했다 — 스캔이 고장났다");
});

// ── 폐기된 입력 — 서버가 값을 고정한 필드는 '조용히 무시'가 아니라 거절이어야 한다 ────────────
// WHY(실측 2026-09-08): `POST /api/ui/knowledge` 에 `injection:"always"` 를 보내면 **200 으로 성공**하고
//  그 값만 사라졌다. 지식의 injection 은 서버 고정값(recalled)인데 선언에도 없고 parse 도 안 실어
//  입력이 통째로 증발한 것이다. 이건 같은 엔드포인트의 type=incident(500)보다 나쁘다 — 500 은 시끄럽게
//  실패하지만 이쪽은 **잘못된 지정이 성공으로 기록되고** 호출자는 자기 지정이 먹혔다고 믿는다.
//  고정값을 '유일 허용값' enum 으로 선언에 남기면 MCP(SDK)·REST(파리티 가드)가 같은 판정을 낸다.
await t("폐기된 입력: knowledge_save.injection 에 서버 고정값 밖 값을 보내면 400(조용히 무시 아님)", () => {
  for (const bad of ["always", "bogus"]) {
    const err = caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "decision", injection: bad }));
    assert.ok(err instanceof HttpError && err.status === 400,
      `injection:"${bad}" 가 조용히 통과했다(반환: ${JSON.stringify(err)}) — 잘못된 지정이 성공으로 기록된다`);
    assert.match((err as HttpError).message, /recalled/);
  }
});

await t("폐기된 입력: 고정값 자체(recalled)와 미전송은 그대로 통과한다", () => {
  assert.equal(caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "decision", injection: "recalled" })), null);
  assert.equal(caught(() => parseWith(KNOWLEDGE_SAVE!.mount, { ...KS_BODY, type: "decision" })), null);
});

await t("폐기된 입력: 그 판정이 MCP 표면에도 걸린다 — 선언에 있어야 SDK 가 거른다", () => {
  const spec = enumOf(registry.get("knowledge_save")!.input.injection);
  assert.ok(spec, "injection 이 스키마에 enum 으로 선언돼 있지 않다 — MCP 는 미선언 키를 조용히 strip 한다(같은 무음 실패)");
  assert.deepEqual([...spec!.values], ["recalled"]);
});

// ── R5 전 표면 전수 스캔 ─────────────────────────────────────────────────────
// WHY: 이 규칙은 한 필드의 처방이 아니라 전 표면 규칙이다. 특정 capability 만 고친 구현은 여기서 걸린다.
//  판정 결과는 세 갈래로 적었지만 가드가 restMounts() 안에 있는 한 dropped 는 구조상 0 이다(나쁜 값이
//  parse 산출에 닿기 전에 throw). dropped 분기를 남겨 두는 건 가드가 빠졌을 때 '유출'과 '마운트 자체
//  필터가 떨굼'을 구분해 보여 주기 위해서다 — 그 둘은 해악이 다르다(전자는 500, 후자는 무언의 무시).
type Verdict = { rejected400: string[]; dropped: string[]; leaked: string[]; skipped: string[]; skippedIds: string[] };

function scanAll(): Verdict {
  const v: Verdict = { rejected400: [], dropped: [], leaked: [], skipped: [], skippedIds: [] };
  for (const { cap, mount } of MOUNTS) {
    for (const [k, zt] of Object.entries(cap.input)) {
      const info = enumOf(zt);
      if (!info) continue;
      const where = `${cap.name}.${k} [${mount.method} ${mount.paths[0]}] 허용값=${info.values.join("|")}`;
      const base = findBaseline(cap, mount, k);
      if (!base) { v.skipped.push(where); v.skippedIds.push(`${cap.name}.${k}`); continue; }   // 다른 이유로 throw = 판정 불가 → 버린다
      const poison = info.isArray ? [POISON] : POISON;
      let out: Record<string, unknown> | null = null;
      try { out = parseWith(mount, { ...base.values, [k]: poison }, base.str); }
      catch (e) {
        if (e instanceof HttpError && e.status === 400) v.rejected400.push(where);
        else v.leaked.push(`${where} → 400 이 아닌 ${e instanceof HttpError ? e.status : "비-HttpError"} 로 실패`);
        continue;
      }
      if (JSON.stringify(out?.[k] ?? null).includes(POISON)) v.leaked.push(where);
      else v.dropped.push(where);
    }
  }
  return v;
}
const SCAN = scanAll();

await t("R5 REST 전 표면 — 허용값 밖 값이 핸들러 입력으로 실려 나가는 enum 필드가 하나도 없다", () => {
  assert.equal(SCAN.leaked.length, 0,
    `허용값 밖 값이 하류(핸들러·DB)로 새는 필드 ${SCAN.leaked.length}건 / 판정 ` +
    `${SCAN.rejected400.length + SCAN.dropped.length}건:\n  ${SCAN.leaked.join("\n  ")}`);
});

await t("R5 그 차단의 주된 형태가 400 거부다 — 한 필드 예외 처방이 아니라 전 표면 규칙", () => {
  assert.ok(SCAN.rejected400.length >= 100,
    `400 으로 거부된 enum 필드가 ${SCAN.rejected400.length}건뿐이다(마운트 자체 필터가 떨군 것 ` +
    `${SCAN.dropped.length}건, 판정불가 ${SCAN.skipped.length}건) — 전 표면 규칙이 아니라 국소 처방으로 보인다`);
});

// ── 실클라이언트 계약 — 가드가 **지금 웹이 실제로 보내는 쿼리**를 깨지 않는가 ─────────────
// WHY: 위 스캔은 '거부돼야 할 값'만 넣어 본다. 그래서 "기존 호출부가 보내는 값이 여전히 통과하는가"는
//  한 번도 관측되지 않는데, 실제로 그 방향에서 회귀가 났다 — knowledge_list.lifecycle 은 스키마엔
//  단일 enum 으로 적혀 있지만 REST 는 'active,pending' 쉼표 다중값을 지원한다(#783, knowledge-store 의
//  `lifecycle = ANY(...)`). WIKI 사이드바(web/wiki-data.ts)·흐름 지도(web/context-map.ts)가 그 형태로 부른다.
const WEB_QUERIES: Array<[string, Record<string, unknown>]> = [
  ["wiki-data 카테고리 행", { lifecycle: "active,pending", light: "1", limit: "500" }],
  ["wiki-data 미분류 배지", { category: "none", lifecycle: "active,pending", light: "1", limit: "1" }],
  ["context-map 미니어처", { lifecycle: "active,pending", light: "1", limit: "2000" }],
  ["검토 큐", { lifecycle: "pending", orderBy: "updated_at", limit: "50" }],
];
await t("실클라이언트: 웹이 보내는 knowledge_list 쿼리가 그대로 통과한다(다중값 포함)", () => {
  const m = MOUNTS.find((x) => x.cap.name === "knowledge_list");
  assert.ok(m, "knowledge_list 마운트 없음 — 테스트 전제 붕괴");
  for (const [label, query] of WEB_QUERIES) {
    const err = caught(() => m!.mount.parse({
      method: "GET", path: "/api/ui/knowledge", originalUrl: "/api/ui/knowledge",
      ip: "127.0.0.1", headers: {}, params: {}, query, body: {},
    } as never));
    assert.equal(err, null, `${label} 쿼리가 거부됐다: ${(err as Error)?.message}`);
  }
});

await t("R5 스캔이 실제로 표본을 훑었다 — 0건 훑고 통과하는 자기기만 방지", () => {
  const judged = SCAN.rejected400.length + SCAN.dropped.length;
  assert.ok(judged >= 60, `판정 표본 ${judged}건뿐(판정불가 ${SCAN.skipped.length}건) — 스캔이 고장났다`);
  // 판정불가(skip)는 fail-open 이라 늘어나도 위 단언들이 조용히 버틴다 — 현재값(3건: project_list_v6 의
  //  archived·trashed 는 parse 가 정상값을 undefined 로 접어 기준선을 못 세우고, knowledge_save.injection 은
  //  parse 가 그 키를 아예 안 싣는다 — 아래 '폐기된 입력' 블록이 그 필드를 따로 잠근다)을 못으로 박아
  //  커버리지 누수를 눈에 보이게 한다.
  // 개수가 아니라 **식별자 집합**으로 못박는다 — 개수만 보면 한 필드가 빠지고 다른 필드가 들어오는
  //  교체형 드리프트가 숨는다(주석만 거짓이 된다).
  const EXPECTED_SKIPS = new Set([
    "knowledge_save.injection", "project_list_v6.archived", "project_list_v6.trashed",
  ]);
  assert.deepEqual(new Set(SCAN.skippedIds), EXPECTED_SKIPS,
    `판정불가 집합이 바뀌었다 — 커버리지가 조용히 새거나 옮겨갔다:\n  ${SCAN.skipped.join("\n  ")}`);
});

await t("R5 전수 스캔 대상이 실제로 여러 capability 에 걸쳐 있다", () => {
  const caps = new Set<string>();
  for (const { cap } of MOUNTS) {
    for (const zt of Object.values(cap.input)) if (enumOf(zt)) { caps.add(cap.name); break; }
  }
  assert.ok(caps.size >= 20, `enum 선언 capability 가 ${caps.size}개뿐 — 레지스트리 순회가 고장났다`);
});

console.log(`ok  REST enum 검증 파리티(R1~R6 + knowledge_save 실측 사례) — ${pass}건`);
