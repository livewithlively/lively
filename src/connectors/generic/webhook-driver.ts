// 범용 웹훅 수집 드라이버(#1419 T2) — 남이 **밀어넣는** 소스. 앞의 둘(HTTP·RSS)이 당겨오는 것과 방향이 반대다.
//
//  두 단계로 갈라 둔 이유(schema 주석과 같은 근거, 여기선 실행 쪽):
//   ① 수신(routes) — 서명 검증하고 collector_webhook_event 에 **원문 그대로** 적고 즉시 200.
//   ② 변환(이 파일) — 싱크가 돌 때 쌓인 원문을 꺼내 RawItem 으로 만든다.
//  수신 시점에 파싱까지 하면 파서 버그가 곧 전송 실패(4xx/5xx)가 되고, 보낸 쪽은 재전송하거나 버린다.
//  갈라 두면 파서를 고친 뒤 processed_at 을 비워 **같은 원문으로 다시 돌릴 수 있다**.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BackfillOpts, Connector, RawItem } from "../types.js";
import { mapToRawItem, extractAll, type FieldMap } from "./mapping.js";
import { runCustomParser } from "./parser-sandbox.js";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";

/** 한 번의 싱크가 처리할 이벤트 수 상한 — 폭주 수신 시에도 배치가 끝나게. 남은 건 다음 run 이 집는다. */
const DRAIN_LIMIT = 500;

export interface WebhookDriverConfig {
  /** 서명 검증 — 안 하면 URL 을 아는 누구나 우리 지식창고에 아무거나 밀어넣을 수 있다. */
  signature?: {
    kind: "none" | "hmac-sha256";
    /** 서명이 담긴 헤더 이름(예: X-Hub-Signature-256). */
    header?: string;
    /** 공유 비밀이 담긴 **수집기 설정 키**(값이 아니라 키 — 시크릿은 수집기 소유). */
    secretField?: string;
    /** 헤더 값 접두(예: "sha256=") — 있으면 벗기고 비교. */
    prefix?: string;
  };
  /** 본문에서 항목 목록을 집는 경로. 비우면 본문 자체가 항목 1건. */
  itemsPath?: string;
  map?: FieldMap;
  itemType?: RawItem["type"];
  category?: string;
  parserScript?: string;
}

/**
 * 서명 검증 — HMAC-SHA256. **타이밍 안전 비교**를 쓴다(문자열 === 는 앞에서부터 다르면 바로 끝나
 *  비교 시간으로 서명을 한 바이트씩 맞춰 볼 여지를 준다).
 */
export function verifyWebhookSignature(
  cfg: WebhookDriverConfig, rawBody: string, headers: Record<string, string | undefined>,
  settings: Record<string, string | undefined>,
): { ok: boolean; reason?: string } {
  const sig = cfg.signature;
  if (!sig || sig.kind === "none") return { ok: true };

  const headerName = (sig.header || "x-signature").toLowerCase();
  const got = headers[headerName];
  if (!got) return { ok: false, reason: `서명 헤더(${headerName})가 없습니다` };

  const secret = settings[sig.secretField ?? "webhook_secret"];
  if (!secret) return { ok: false, reason: "이 수집기에 웹훅 공유 비밀이 설정돼 있지 않습니다" };

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  let provided = got.trim();
  if (sig.prefix && provided.startsWith(sig.prefix)) provided = provided.slice(sig.prefix.length);
  // 길이가 다르면 timingSafeEqual 이 던진다 — 길이 자체는 비밀이 아니므로 먼저 거른다.
  if (provided.length !== expected.length) return { ok: false, reason: "서명이 일치하지 않습니다" };
  const ok = timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
  return ok ? { ok: true } : { ok: false, reason: "서명이 일치하지 않습니다" };
}

/**
 * 웹훅 커넥터 — backfill 이 '외부 호출'이 아니라 **수신함 드레인**이다.
 *  처리한 이벤트만 processed_at 을 찍는다. 변환에 실패한 건 error 를 남기고 **지우지 않는다**
 *  (원문이 남아 있어야 파서를 고쳐 다시 돌릴 수 있다).
 */
export function makeWebhookConnector(
  system: string, collectorId: number, cfg: WebhookDriverConfig, settings: Record<string, string | undefined>,
): Connector {
  const instance = settings.instance || undefined;

  return {
    name: system,
    async *backfill(_opts?: BackfillOpts): AsyncIterable<RawItem> {
      const r = await itemsPool.query<{ id: string; body: unknown; body_text: string | null }>(
        `SELECT id, body, body_text FROM collector_webhook_event
          WHERE collector_id=$1 AND processed_at IS NULL ORDER BY id LIMIT ${DRAIN_LIMIT}`, [collectorId]);
      if (!r.rows.length) return;

      let failed = 0;
      for (const ev of r.rows) {
        const evId = Number(ev.id);
        try {
          const payload = ev.body ?? (ev.body_text ? JSON.parse(ev.body_text) : null);
          let items: unknown[] = cfg.itemsPath?.trim()
            ? extractAll(payload, cfg.itemsPath)
            : (Array.isArray(payload) ? payload : [payload]);

          if (cfg.parserScript) {
            const pr = await runCustomParser(cfg.parserScript, items);
            if (!pr.ok) throw new Error(pr.error ?? "커스텀 파서 실패");
            items = pr.items;
          }

          for (const it of items) {
            const raw = mapToRawItem(it, cfg.map ?? {}, {
              system, instance, category: cfg.category, type: cfg.itemType,
            });
            if (raw) yield raw;
          }
          await itemsPool.query(`UPDATE collector_webhook_event SET processed_at=now(), error=NULL WHERE id=$1`, [evId]);
        } catch (e) {
          failed++;
          // 실패는 표시만 하고 **남긴다** — 파서를 고치고 processed_at 을 비우면 재처리된다.
          await itemsPool.query(
            `UPDATE collector_webhook_event SET processed_at=now(), error=$2 WHERE id=$1`,
            [evId, String((e as Error)?.message ?? e).slice(0, 1000)]).catch(() => undefined);
        }
      }
      if (failed) logger.warn({ system, collectorId, failed }, "웹훅 이벤트 변환 실패 — 원문은 보존됨(파서 수정 후 재처리 가능)");
    },
  };
}
