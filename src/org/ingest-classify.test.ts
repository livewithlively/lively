// V4-P4 (P4-ingest) — classifyIngest 무키/키 분기 회귀. DB 불요(순수 + fetch 스텁).
//   실행: npm run build && node dist/org/ingest-classify.test.js
//
//   목적:
//     (A) 무키 분기 = 기계 폴백 = 현 KIND_MAP 동작과 byte-identical. ANTHROPIC_API_KEY 비움.
//         여러 source 에서 kind 가 external-identity.KIND_MAP 과 정확히 같음을 단언(라이브 불변 입증).
//     (B) 키 분기 = LLM 분류. fetch 스텁으로 (b1) 정상 tool_use 파싱·(b2) API 오류→기계 폴백·
//         (b3) kind 통제어휘 위반→기계 폴백·(b4) area 통제어휘 밖→null 을 커버.
import assert from "node:assert/strict";
import { classifyIngest, routeIngestV6 } from "./ingest-classify.js";
import { KIND_MAP } from "./external-identity.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 키 env 를 안전하게 비우고/복원하는 헬퍼.
function withoutKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  return fn().finally(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });
}
function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-DUMMY"; // 테스트 더미(외부 호출은 스텁이 가로챔 — 실네트워크 0).
  return fn().finally(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  });
}

await (async () => {
  // ── (A) 무키 = 기계 폴백 = KIND_MAP byte-identical ──
  await t("무키: clickup task→W·notion doc→K — KIND_MAP 과 동일·area null·mechanical", async () => {
    await withoutKey(async () => {
      const w = await classifyIngest({ text: "x", source: "task:clickup", externalSystem: "clickup" });
      assert.equal(w.kind, "W");
      assert.equal(w.kind, KIND_MAP["task:clickup"]); // 오라클: 중앙 KIND_MAP 과 일치
      assert.equal(w.area, null);
      assert.equal(w.provenance, "observed");
      assert.equal(w.classifiedBy, "mechanical");

      const k = await classifyIngest({ text: "y", source: "doc:notion", externalSystem: "notion" });
      assert.equal(k.kind, "K");
      assert.equal(k.kind, KIND_MAP["doc:notion"]);
      assert.equal(k.classifiedBy, "mechanical");
    });
  });

  await t("무키: 미정의 source(slack message·교차조합)→kind undefined(미러 skip 유지)", async () => {
    await withoutKey(async () => {
      const a = await classifyIngest({ text: "z", source: "message:slack", externalSystem: "slack" });
      assert.equal(a.kind, undefined);
      assert.equal(a.kind, KIND_MAP["message:slack"]); // 둘 다 undefined
      assert.equal(a.classifiedBy, "mechanical");

      const b = await classifyIngest({ text: "z", source: "task:notion", externalSystem: "notion" });
      assert.equal(b.kind, undefined); // 교차 미정의 — KIND_MAP 미정의와 동일
      assert.equal(b.classifiedBy, "mechanical");
    });
  });

  await t("무키: 전 KIND_MAP 키 전수 — classifyIngest 무키 == KIND_MAP[source] (byte-identical 오라클)", async () => {
    await withoutKey(async () => {
      for (const [source, expected] of Object.entries(KIND_MAP)) {
        const r = await classifyIngest({ text: "t", source });
        assert.equal(r.kind, expected, `source=${source}`);
        assert.equal(r.area, null);
        assert.equal(r.provenance, "observed");
        assert.equal(r.classifiedBy, "mechanical");
      }
    });
  });

  // ── (B) 키 = LLM 분류(fetch 스텁) ──
  await t("키(b1): 정상 tool_use 응답 파싱 — kind/area 채택·classifiedBy=ai", async () => {
    await withKey(async () => {
      const captured: { url: string; body: string }[] = [];
      const stub = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
        captured.push({ url, body: init.body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "tool_use", name: "classify", input: { kind: "H", area: "delivery-web" } }],
          }),
        };
      };
      const r = await classifyIngest({
        text: "런북: 설치 절차",
        source: "doc:notion",
        externalSystem: "notion",
        areaVocab: ["delivery-web", "gtm"],
        fetchImpl: stub,
      });
      assert.equal(r.kind, "H");
      assert.equal(r.area, "delivery-web");
      assert.equal(r.provenance, "observed");
      assert.equal(r.classifiedBy, "ai");
      // 엔드포인트·모델·시크릿 비노출 확인.
      assert.equal(captured.length, 1);
      assert.equal(captured[0].url, "https://api.anthropic.com/v1/messages");
      assert.ok(captured[0].body.includes("claude-haiku-4-5-20251001"));
    });
  });

  await t("키(b2): API 오류(500)→기계 폴백(graceful)·classifiedBy=mechanical", async () => {
    await withKey(async () => {
      const stub = async () => ({ ok: false, status: 500, json: async () => ({}) });
      const r = await classifyIngest({ text: "x", source: "task:clickup", fetchImpl: stub });
      assert.equal(r.kind, "W"); // KIND_MAP 폴백
      assert.equal(r.kind, KIND_MAP["task:clickup"]);
      assert.equal(r.area, null);
      assert.equal(r.classifiedBy, "mechanical");
    });
  });

  await t("키(b2'): fetch 가 throw(타임아웃/네트워크)→기계 폴백", async () => {
    await withKey(async () => {
      const stub = async () => {
        throw new Error("network down");
      };
      const r = await classifyIngest({ text: "x", source: "doc:notion", fetchImpl: stub });
      assert.equal(r.kind, "K");
      assert.equal(r.classifiedBy, "mechanical");
    });
  });

  await t("키(b3): kind 통제어휘 위반(예: 'A')→기계 폴백(가드)", async () => {
    await withKey(async () => {
      const stub = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "tool_use", name: "classify", input: { kind: "A", area: "x" } }] }),
      });
      const r = await classifyIngest({ text: "x", source: "task:clickup", fetchImpl: stub });
      assert.equal(r.kind, "W"); // 위반 → 폴백
      assert.equal(r.classifiedBy, "mechanical");
    });
  });

  await t("키(b4): area 통제어휘 밖 → null(어휘 강제)·kind 는 채택", async () => {
    await withKey(async () => {
      const stub = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "tool_use", name: "classify", input: { kind: "K", area: "not-in-vocab" } }],
        }),
      });
      const r = await classifyIngest({
        text: "x",
        source: "doc:notion",
        areaVocab: ["gtm", "brand"],
        fetchImpl: stub,
      });
      assert.equal(r.kind, "K");
      assert.equal(r.area, null); // 어휘 밖 → null
      assert.equal(r.classifiedBy, "ai");
    });
  });

  await t("키(b4'): area=null 응답 → null 정규화·kind 채택", async () => {
    await withKey(async () => {
      const stub = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "tool_use", name: "classify", input: { kind: "R", area: null } }] }),
      });
      const r = await classifyIngest({ text: "x", source: "doc:notion", fetchImpl: stub });
      assert.equal(r.kind, "R");
      assert.equal(r.area, null);
      assert.equal(r.classifiedBy, "ai");
    });
  });

  // ── (C) routeIngestV6 — 소스별 v6 엔티티 라우팅. #541: Drive doc → source(distill), notion doc → knowledge 유지. ──
  await t("route: gdrive doc→source(distill 대상), notion doc→knowledge 불변", () => {
    // #541 결정 — Drive 파일은 raw 자료로 source 적재(증류 게이트), notion 정제 문서는 knowledge 직행.
    assert.equal(routeIngestV6("doc", "gdrive"), "source");
    assert.equal(routeIngestV6("doc", "notion"), "knowledge");
    // raw 메시지류(slack/gmail/discord)는 source, clickup task 는 project — 기존 계약 불변.
    assert.equal(routeIngestV6("message", "slack"), "source");
    assert.equal(routeIngestV6("message", "gmail"), "source");
    assert.equal(routeIngestV6("task", "clickup"), "project");
    // PM 계층 부속(clickup)도 불변.
    assert.equal(routeIngestV6("list", "clickup"), "pm_list");
    assert.equal(routeIngestV6("space", "clickup"), "pm_folder");
    // 미정의 조합은 보수적 skip(null).
    assert.equal(routeIngestV6("bogus", "nowhere"), null);
  });
})();

console.log(`\n${pass} passed (ingest-classify 무키 byte-identical + 키 LLM 분류)`);
