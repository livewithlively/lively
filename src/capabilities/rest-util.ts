// REST 어댑터 공용 유틸 — web.ts 에서 이동(Stage①). capabilities/*.ts 의 rest.parse 와
// web.ts 의 에러 매핑이 공유한다(순환 import 방지: web.ts → capabilities/index → rest-util 단방향).
// 검증 메시지·상태코드는 기존 web.ts 와 byte-compat — 문구를 바꾸면 클라이언트/파리티가 깨진다.
import type express from "express";
import { logger } from "../log.js";

// ── 에러/검증 헬퍼 ──
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;

// Express 4 는 async rejection 을 전파하지 않음 — 전 라우트에 적용하는 래퍼.
// store 의 plain Error 메시지를 상태코드로 매핑: '없음'→404 · 'domainmap'→502 · 검증 문구→400 · 그 외→500.
// 이 한국어 부분문자열 매핑은 load-bearing — 신규 에러 메시지는 토큰('없음'/'검증 실패' 등)을 포함해야 한다.
export function wrap(fn: AsyncHandler): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
      const msg = err instanceof Error ? err.message : "";
      // 디스크 부족(#813 T5) — 지금까지 정체불명 500("internal_error")으로 나가 사용자도 운영자도 원인을 몰랐다.
      //  ENOSPC 는 원인이 명확하니 그대로 말하고 무엇을 해야 하는지 알려준다(507 Insufficient Storage).
      //  ⚠ 순환 import 방지로 여기서 정규식을 직접 둔다(disk-guard 는 rest-util 의 HttpError 를 쓴다).
      if ((err as NodeJS.ErrnoException)?.code === "ENOSPC" || (err as NodeJS.ErrnoException)?.code === "EDQUOT"
          || /ENOSPC|no space left on device|quota exceeded/i.test(msg)) {
        logger.error({ err, path: req.path }, "디스크 부족으로 실패");
        res.status(507).json({ error: "디스크 공간이 부족합니다 — 관리 ▸ 저장소·로그 에서 워크스페이스를 회수하거나 디스크를 늘리세요." });
        return;
      }
      if (msg.includes("없음")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("domainmap")) { res.status(502).json({ error: `domainmap 연결 실패 — ${msg}` }); return; }
      if (/검증 실패|허용|필수|미지정|형식/.test(msg)) { res.status(400).json({ error: msg }); return; }
      logger.error({ err, path: req.path }, "web ui request failed");
      res.status(500).json({ error: "internal_error" });
    });
  };
}

export const DM_KINDS = new Set(["domains", "entities", "overview"]);

export function qstr(v: unknown, name: string, max = 200): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${name} 형식이 잘못되었습니다`);
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw new HttpError(400, `${name} 은(는) ${max}자 이하여야 합니다`);
  return s;
}

export function qint(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} 은(는) ${min}~${max} 사이 정수여야 합니다`);
  }
  return n;
}

export function qiso(v: unknown): string | undefined {
  const s = qstr(v, "since", 64);
  if (s === undefined) return undefined;
  if (Number.isNaN(Date.parse(s))) throw new HttpError(400, "since 는 ISO8601 형식이어야 합니다");
  return s;
}

// 목록 페이징 정규화(#709) — limit(1~max, 기본 def) · offset(0~1,000,000). org_audit_list(listContentAudit) 관례를 표준화한다.
//  랭킹 top-K 검색(search/grep/similar)엔 offset 이 부적절하므로 목록·시계열 피드형 도구에만 쓴다. NaN/음수/0 은 안전 폴백.
export function clampPage(
  input: { limit?: unknown; offset?: unknown } | undefined,
  def: number, max: number,
): { limit: number; offset: number } {
  const l = Number(input?.limit);
  const limit = Number.isFinite(l) && l > 0 ? Math.min(Math.floor(l), max) : def;
  const o = Number(input?.offset);
  const offset = Number.isFinite(o) && o > 0 ? Math.min(Math.floor(o), 1_000_000) : 0;
  return { limit, offset };
}

// v6 은퇴(2026-06-24): qtype·MappingBody·parseMappingBody(구 item→domain 매핑 body 검증) 제거 — 매핑 서브시스템 폐기.
