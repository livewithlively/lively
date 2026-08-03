// 웹훅 수신 엔드포인트(#1419 T2) — 외부가 우리에게 **밀어넣는** 유일한 인입구.
//
//  ⚠ 이 라우트는 **무인증**이다. 그래야만 한다 — 깃허브·젠데스크·사내 시스템은 우리 게이트웨이의 bearer 토큰을
//   갖고 있지 않다. 그래서 인증 대신 **세 겹**으로 막는다:
//   ① 경로에 수집기 id — 존재하고 켜져 있고 driver='webhook' 인 수집기만 받는다.
//   ② HMAC 서명 검증 — 프리셋이 요구하면 통과 못 한 요청은 401(수집기의 공유 비밀로 검증).
//   ③ 본문 크기 상한 — 무제한이면 이 엔드포인트 하나가 디스크·메모리 고갈 경로가 된다.
//
//  하는 일은 '검증하고 통째로 적고 즉시 200'까지다. 변환·적재는 싱크가 나중에 한다(webhook-driver.ts 헤더 참조).
//  200 을 빨리 주는 게 중요하다 — 대부분의 발신자는 몇 초 안에 응답이 없으면 실패로 보고 재전송하거나 버린다.
import type express from "express";
import { itemsPool } from "../../db/client.js";
import { resolvePreset } from "../../org/store/collector-presets.js";
import { resolveConnectorConfig, withCollector } from "../config.js";
import { verifyWebhookSignature, type WebhookDriverConfig } from "./webhook-driver.js";
import { logger } from "../../log.js";

/** 본문 상한 — 웹훅 페이로드는 보통 수 KB. 1MB 면 넉넉하고, 남용 반경은 닫는다. */
const MAX_BODY = 1_000_000;

export function registerWebhookRoutes(app: express.Express): void {
  // 원문 그대로가 필요하다 — 서명은 **파싱 전 바이트**로 계산되므로, JSON 파서가 재직렬화한 문자열로
  //  검증하면 키 순서·공백 차이로 정상 요청이 탈락한다(가장 흔한 웹훅 디버깅 지옥).
  app.post("/hooks/collector/:id",
    (req, res, next) => {
      let raw = "", tooBig = false;
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        if (tooBig) return;
        if (raw.length + c.length > MAX_BODY) { tooBig = true; raw = ""; return; }
        raw += c;
      });
      req.on("end", () => {
        if (tooBig) { res.status(413).json({ error: "본문이 너무 큽니다(1MB 상한)" }); return; }
        (req as unknown as { rawBody: string }).rawBody = raw;
        next();
      });
      req.on("error", () => { res.status(400).json({ error: "본문을 읽지 못했습니다" }); });
    },
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) { res.status(404).json({ error: "not found" }); return; }
      const rawBody = (req as unknown as { rawBody: string }).rawBody ?? "";

      try {
        const cr = await itemsPool.query<{ preset_key: string; instance_key: string; enabled: boolean }>(
          `SELECT preset_key, instance_key, enabled FROM org_collector WHERE id=$1`, [id]);
        const row = cr.rows[0];
        // 없는·꺼진 수집기는 **똑같이 404** — 어느 id 가 실재하는지 알려 주지 않는다(열거 방지).
        if (!row || !row.enabled) { res.status(404).json({ error: "not found" }); return; }

        const preset = await resolvePreset(row.preset_key);
        if (!preset || preset.driver !== "webhook") { res.status(404).json({ error: "not found" }); return; }

        // 서명 검증 — 수집기의 공유 비밀로. 해소는 요청 범위 바인딩 안에서(동시 수신이 서로 섞이지 않게).
        const cfg = { ...preset.driverConfig } as WebhookDriverConfig;
        const settings = await withCollector(
          { id, presetKey: row.preset_key, instanceKey: row.instance_key },
          () => resolveConnectorConfig(row.preset_key));
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        const sig = verifyWebhookSignature(cfg, rawBody, headers, settings);
        if (!sig.ok) {
          logger.warn({ collectorId: id, reason: sig.reason }, "웹훅 서명 검증 실패 — 거부");
          res.status(401).json({ error: sig.reason ?? "서명 검증 실패" });
          return;
        }

        // 원문 보관 — JSON 이면 구조로, 아니면 텍스트로. 둘 다 남겨 파서가 어느 쪽이든 볼 수 있게.
        let parsed: unknown = null;
        try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* JSON 아님 — body_text 로만 */ }
        // 헤더도 남긴다(이벤트 종류가 헤더에만 있는 소스가 흔하다 — X-GitHub-Event 등).
        //  ⚠ 자격 계열 헤더는 빼고 적는다 — 수신함은 감사·재처리용이라 오래 남는다.
        const safeHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (/authorization|cookie|signature|token|secret|api-key/i.test(k)) continue;
          if (v != null) safeHeaders[k] = String(v).slice(0, 500);
        }

        await itemsPool.query(
          `INSERT INTO collector_webhook_event(collector_id, headers, body, body_text)
             VALUES($1,$2::jsonb,$3::jsonb,$4)`,
          [id, JSON.stringify(safeHeaders), parsed == null ? null : JSON.stringify(parsed),
           parsed == null ? rawBody.slice(0, MAX_BODY) : null]);

        // 즉시 200 — 변환은 다음 싱크가 한다. 여기서 파싱까지 하면 파서 버그가 곧 전송 실패가 된다.
        res.status(202).json({ ok: true, queued: true });
      } catch (e) {
        logger.error({ err: (e as Error)?.message, collectorId: id }, "웹훅 수신 실패");
        // 우리 쪽 장애는 5xx 로 — 발신자가 재전송해 주는 편이 유실보다 낫다.
        res.status(503).json({ error: "일시적으로 수신할 수 없습니다 — 재전송해 주세요" });
      }
    });
}
