// 순수 설정 파서 단위 체크 — 테스트 러너 없이 node:assert 로 자급(빌드+typecheck 가 게이트).
// 실행: npm run build && node dist/db/sources.test.js
import assert from "node:assert/strict";
import { loadSources, pickDefaultFrom, pickSourceFrom, resolveConnectionString, DEFAULT_SOURCE } from "./sources.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
const throws = (name: string, fn: () => void, re: RegExp): void => {
  assert.throws(fn, re, name);
  pass++;
  console.log(`ok  ${name}`);
};

// ── loadSources: DATABASE_URL → default(후방호환) ──
t("DATABASE_URL → default 소스(rls=app.current_user, 기본 limit)", () => {
  const s = loadSources({ DATABASE_URL: "postgres://ro@h/app" });
  assert.equal(s.size, 1);
  const d = s.get(DEFAULT_SOURCE)!;
  assert.equal(d.url, "postgres://ro@h/app");
  assert.equal(d.driver, "postgres");
  assert.equal(d.rls, "app.current_user");
  assert.equal(d.maxRows, 1000);
  assert.equal(d.timeoutMs, 5000);
});

t("DB_MAX_ROWS/DB_STATEMENT_TIMEOUT_MS 가 기본값에 반영", () => {
  const s = loadSources({ DATABASE_URL: "postgres://ro@h/app", DB_MAX_ROWS: "50", DB_STATEMENT_TIMEOUT_MS: "1234" });
  const d = s.get(DEFAULT_SOURCE)!;
  assert.equal(d.maxRows, 50);
  assert.equal(d.timeoutMs, 1234);
});

// ── DB_SOURCES_JSON 명명 소스 ──
t("DB_SOURCES_JSON — rls 지정/null + 소스별 maxRows", () => {
  const s = loadSources({
    DB_SOURCES_JSON: JSON.stringify({
      ops: { url: "postgres://ro@h/lively", rls: "app.current_user" },
      analytics: { url: "postgres://ro@w/dw", rls: null, maxRows: 5000 },
    }),
  });
  assert.equal(s.size, 2);
  assert.equal(s.get("ops")!.rls, "app.current_user");
  assert.equal(s.get("analytics")!.rls, null);
  assert.equal(s.get("analytics")!.maxRows, 5000);
});

t("DB_SOURCES_JSON 에서 rls 미지정 → null(보수적: 행수준 격리 없음)", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "postgres://ro@h/db" } }) });
  assert.equal(s.get("ops")!.rls, null);
});

t("DATABASE_URL + DB_SOURCES_JSON → default 자동 + 명명 소스 공존", () => {
  const s = loadSources({
    DATABASE_URL: "postgres://ro@h/app",
    DB_SOURCES_JSON: JSON.stringify({ ops: { url: "postgres://ro@h/lively" } }),
  });
  assert.equal(s.size, 2);
  assert.ok(s.has(DEFAULT_SOURCE));
  assert.ok(s.has("ops"));
});

t("DB_SOURCES_JSON 에 default 명시 → DATABASE_URL 무시(명시 우선) + rls 후방호환", () => {
  const s = loadSources({
    DATABASE_URL: "postgres://ro@h/IGNORED",
    DB_SOURCES_JSON: JSON.stringify({ default: { url: "postgres://ro@h/explicit" } }),
  });
  assert.equal(s.size, 1);
  assert.equal(s.get(DEFAULT_SOURCE)!.url, "postgres://ro@h/explicit");
  assert.equal(s.get(DEFAULT_SOURCE)!.rls, "app.current_user"); // 'default' 키는 rls 미지정 시 후방호환 app.current_user
});

t("명시 default + rls:null → null(의도적 opt-out)", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ default: { url: "x", rls: null } }) });
  assert.equal(s.get(DEFAULT_SOURCE)!.rls, null);
});

t("비-default 는 rls 미지정 시 null, default 만 app.current_user", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" }, default: { url: "z" } }) });
  assert.equal(s.get("ops")!.rls, null);
  assert.equal(s.get(DEFAULT_SOURCE)!.rls, "app.current_user");
});

// ── 검증 에러 ──
throws(
  "driver != postgres → 거부",
  () => loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { url: "mysql://h/db", driver: "mysql" } }) }),
  /pg-only|미지원/,
);
throws("url 누락 → 거부", () => loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { rls: null } }) }), /url/);
throws("잘못된 JSON → 거부", () => loadSources({ DB_SOURCES_JSON: "{not json" }), /파싱 실패/);
throws("배열 JSON → 거부", () => loadSources({ DB_SOURCES_JSON: "[]" }), /객체/);
throws(
  "rls 가 숫자 → 거부",
  () => loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { url: "postgres://h/db", rls: 5 } }) }),
  /rls/,
);
throws(
  "maxRows 비정수(float) → 거부",
  () => loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { url: "postgres://h/db", maxRows: 3.5 } }) }),
  /정수/,
);
throws(
  "timeoutMs 문자열 → 거부(조용한 무시 방지)",
  () => loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { url: "postgres://h/db", timeoutMs: "1000" } }) }),
  /정수/,
);
t("maxRows 양의 정수 → 적용", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ x: { url: "postgres://h/db", maxRows: 250 } }) });
  assert.equal(s.get("x")!.maxRows, 250);
});

// ── pickDefaultFrom ──
t("pickDefaultFrom: default 있으면 default", () => {
  const s = loadSources({ DATABASE_URL: "x", DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" } }) });
  assert.equal(pickDefaultFrom(s), DEFAULT_SOURCE);
});
t("pickDefaultFrom: 단일 비-default → 그것", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" } }) });
  assert.equal(pickDefaultFrom(s), "ops");
});
t("pickDefaultFrom: 다중+default없음 → null", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" }, ana: { url: "z" } }) });
  assert.equal(pickDefaultFrom(s), null);
});

// ── pickSourceFrom (D1 정책) ──
t("pickSourceFrom: 명시 소스 존재 → 그대로", () => {
  const s = loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" }, ana: { url: "z" } }) });
  assert.equal(pickSourceFrom(s, "ana"), "ana");
});
throws(
  "pickSourceFrom: 명시했는데 없음 → 에러",
  () => pickSourceFrom(loadSources({ DATABASE_URL: "x" }), "nope"),
  /알 수 없는 db source/,
);
t("pickSourceFrom: 미지정+단일 → 그것", () => {
  assert.equal(pickSourceFrom(loadSources({ DATABASE_URL: "x" })), DEFAULT_SOURCE);
});
throws(
  "pickSourceFrom: 미지정+다중+기본없음 → 에러",
  () => pickSourceFrom(loadSources({ DB_SOURCES_JSON: JSON.stringify({ ops: { url: "y" }, ana: { url: "z" } }) })),
  /source 명시 필요/,
);
throws("pickSourceFrom: 소스 0개 → 에러", () => pickSourceFrom(loadSources({})), /등록된 DB 소스 없음/);

// ── 인증 평면(authMode/secretSource/origin) + connectionString 조립 ──
t("env 소스는 authMode=password, secretSource=null, origin=env", () => {
  const d = loadSources({ DATABASE_URL: "postgres://ro@h/app" }).get(DEFAULT_SOURCE)!;
  assert.equal(d.authMode, "password");
  assert.equal(d.secretSource, null);
  assert.equal(d.origin, "env");
});

const at = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

await at("resolveConnectionString: env 소스 → connectionString 만(비번 미주입)", async () => {
  const d = loadSources({ DATABASE_URL: "postgres://ro@h/app" }).get(DEFAULT_SOURCE)!;
  const cfg = await resolveConnectionString(d);
  assert.equal(cfg.connectionString, "postgres://ro@h/app");
  assert.equal(cfg.password, undefined);
});
await at("resolveConnectionString: iam 미지원 → throw", async () => {
  const base = loadSources({ DATABASE_URL: "postgres://ro@h/app" }).get(DEFAULT_SOURCE)!;
  await assert.rejects(() => resolveConnectionString({ ...base, authMode: "iam" }), /미지원/);
});

console.log(`\n${pass} checks passed`);
