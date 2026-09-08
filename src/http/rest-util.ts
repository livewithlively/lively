// REST 어댑터 공용 유틸 — web.ts 에서 이동(Stage①). capabilities/*.ts 의 rest.parse 와
// web.ts 의 에러 매핑이 공유한다(순환 import 방지: web.ts → capabilities/index → rest-util 단방향).
// 검증 메시지·상태코드는 기존 web.ts 와 byte-compat — 문구를 바꾸면 클라이언트/파리티가 깨진다.
// #1313 R9: capabilities/rest-util.ts 에서 원문 이동 — HTTP 공용층은 MCP 표면(capabilities/) 밖에 둔다.
//  HttpError 는 무의존 leaf(src/http-error.ts)로 분리하고, 기존 표면 유지를 위해 여기서 재수출한다.
import type express from "express";
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";

export { HttpError };

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;

// Express 4 는 async rejection 을 전파하지 않음 — 전 라우트에 적용하는 래퍼.
// store 의 plain Error 메시지를 상태코드로 매핑: '없음'→404 · 'domainmap'→502 · 검증 문구→400 · 그 외→500.
// 이 한국어 부분문자열 매핑은 load-bearing — 신규 에러 메시지는 토큰('없음'/'검증 실패' 등)을 포함해야 한다.
export function wrap(fn: AsyncHandler): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      // HttpError 라도 **5xx 는 반드시 로그에 남긴다**(#1278) — 종전엔 여기서 바로 응답만 하고 끝나서
      //  `HttpError(500,"업로드 실패")` 같은 서버측 실패가 gateway.log 에 흔적이 0건이었다(원인 추적 불가).
      //  errno 는 message 가 아니라 cause 에 있으니 명시적으로 꺼내 싣는다(pino 버전별 cause 직렬화에 의존하지 않는다).
      if (err instanceof HttpError) {
        if (err.status >= 500) {
          const c = (err as { cause?: unknown }).cause;
          logger.error({
            path: req.path, status: err.status, msg_out: err.message,
            cause: c instanceof Error ? { message: c.message, code: (c as NodeJS.ErrnoException).code } : c,
          }, "web ui request failed");
        }
        res.status(err.status).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : "";
      // 디스크 부족(#813 T5) — 지금까지 정체불명 500("internal_error")으로 나가 사용자도 운영자도 원인을 몰랐다.
      //  ENOSPC 는 원인이 명확하니 그대로 말하고 무엇을 해야 하는지 알려준다(507 Insufficient Storage).
      //  ⚠ 순환 import 방지로 여기서 정규식을 직접 둔다(disk-guard 는 rest-util 의 HttpError 를 쓴다).
      if ((err as NodeJS.ErrnoException)?.code === "ENOSPC" || (err as NodeJS.ErrnoException)?.code === "EDQUOT"
          || /ENOSPC|no space left on device|quota exceeded/i.test(msg)) {
        logger.error({ err, path: req.path }, "디스크 부족으로 실패");
        res.status(507).json({ error: "디스크 공간이 부족합니다 — 관리 ▸ 저장소·로그 에서 워크스페이스를 정리하거나 디스크를 늘리세요." });
        return;
      }
      // 공유 저장소 연결 끊김(#2548) — 호스트 FUSE(JuiceFS)가 다시 마운트되면 그 전부터 떠 있던 컨테이너의 bind 는
      //  옛 연결을 붙든 채 ENOTCONN(«Transport endpoint is not connected») 을 낸다. 실측(2026-09-02, 매니지드): 세션 복원의
      //  mkdir 이 이걸로 죽었는데 500 «internal_error» 로 나가 사용자도 운영자도 원인을 몰랐다. 원인이 명확하니 그대로 말한다
      //  (503 — 일시적, 브로커가 판을 재생성하면 풀린다). #813 디스크 부족 매핑과 같은 자리·같은 규율.
      if ((err as NodeJS.ErrnoException)?.code === "ENOTCONN" || /Transport endpoint is not connected|\bENOTCONN\b/i.test(msg)) {
        logger.error({ err, path: req.path }, "공유 저장소 연결 끊김(ENOTCONN)으로 실패");
        res.status(503).json({ error: "공유 저장소 연결이 끊겼습니다 — 잠시 뒤 다시 시도하세요. 계속되면 이 워크스페이스의 세션 컨테이너를 다시 띄워야 합니다(관리자)." });
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

// ── 경로/본문 id 파싱(#1313 R46) — capabilities/*.ts 10곳 + delivery/db-sources 1곳에 복붙돼 있던 정의를 수렴. ──
//  ⚠ 문구 계열이 **둘**이다(하나로 뭉개면 응답 문구가 바뀐다 — byte-compat 파기):
//   · parseId     → `${name} 가 올바르지 않습니다`   (기본 name="id" → 종전 "id 가 올바르지 않습니다" 와 byte 동일)
//   · parsePosInt → `${name} 는 양의 정수여야 합니다` (domainmap-curation·delivery/db-sources 계열 — name 필수)
//  둘 다 판정식은 동일(Number → 정수 && >0). 새 호출부는 그 라우트가 이미 쓰던 문구 계열을 그대로 고를 것.
export function parseId(v: unknown, name = "id"): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${name} 가 올바르지 않습니다`);
  return id;
}

export function parsePosInt(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} 는 양의 정수여야 합니다`);
  return n;
}

// ── 문자열 입력 검증(#1313 R46) — capabilities/delivery/shared.ts 에서 승격(원문 그대로). ──
//  delivery 도메인 파일들은 shared.js 재수출로 계속 받으므로 그쪽 import 문은 무수정이다.
export const str = (v: unknown, name: string, max = 20000): string => {
  if (typeof v !== "string") throw new HttpError(400, `${name} 은(는) 문자열 필수`);
  if (v.length > max) throw new HttpError(400, `${name} 은(는) ${max}자 이하여야 합니다`);
  return v;
};

export const slug = (v: unknown, name: string): string => {
  const s = str(v, name, 100).trim();
  if (!s) throw new HttpError(400, `${name} 필수`);
  if (!/^[A-Za-z0-9가-힣_-]+$/.test(s)) throw new HttpError(400, `${name} 은 영문/숫자/한글/_/- 만 허용됩니다`);
  return s;
};

// 이메일 형식 검증 — 이메일이 곧 로그인 아이디라, 생성 시점에 막아 로그인 매칭과 일관성을 맞춘다(실용적 미니 체크).
export const assertEmail = (v: string): void => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "이메일 형식이 올바르지 않습니다");
};

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
