// 범용 HTTP/REST 수집 드라이버(#1419 T2) — "코드 배포 없이 사내 API 를 붙인다".
//
//  커넥터 모듈(slack.ts 등)이 코드로 하던 일을 **설정(driver_config)** 으로 한다:
//   URL 템플릿 · 인증 · 페이지네이션 · 목록 경로 · 필드 매핑 · 증분 커서.
//  결과는 여느 커넥터와 똑같은 RawItem 스트림이라, 하류(적재·증류·분류)는 이게 범용인지 모른다.
//
//  ⚠ SSRF 방어: 이 드라이버는 **관리자가 준 URL 로 게이트웨이가 직접 나간다**. 게이트웨이는 사내망 안에 있고
//   클라우드에선 메타데이터 엔드포인트(169.254.169.254)에 닿는다 — 즉 URL 하나로 자격증명을 긁어올 수 있는
//   자리다. admin scope 라 해도 실수·오타 한 번의 반경이 너무 크므로 기본 차단선을 둔다(assertPublicUrl).
//   사내 API 를 일부러 붙이는 게 목적인 기능이라 **차단은 옵트아웃 가능**하되, 끄는 것이 명시적이어야 한다.
import type { BackfillOpts, Connector, RawItem } from "../types.js";
import { mapToRawItem, extractAll, type FieldMap } from "./mapping.js";
import { runCustomParser } from "./parser-sandbox.js";
import { assertUrlAllowed } from "./url-guard.js";
import { logger } from "../../log.js";

/** 한 번의 backfill 이 돌 수 있는 상한 — 설정 실수로 무한 페이지를 도는 것을 막는 백스톱. */
const MAX_PAGES = 500;
const REQUEST_TIMEOUT_MS = 30_000;

export interface HttpDriverConfig {
  /** 요청 URL. 치환 토큰: {cursor} {page} {offset} {limit} + 수집기 설정값 {config.<key>} */
  url: string;
  method?: "GET" | "POST";
  /** 고정 헤더 — 값에도 {config.<key>} 치환이 먹는다(예: X-Api-Key: {config.api_key}). */
  headers?: Record<string, string>;
  /** POST 본문 템플릿(문자열 — 같은 치환 적용). */
  body?: string;
  auth?: {
    kind: "none" | "bearer" | "header" | "basic" | "query";
    /** bearer/header/query: 토큰이 담긴 **수집기 설정 키**(예: "api_token"). 값을 직접 적지 않는다(시크릿은 수집기 소유). */
    tokenField?: string;
    /** header 방식의 헤더 이름(기본 Authorization) · query 방식의 파라미터 이름(기본 access_token). */
    name?: string;
    /** basic: 사용자/비밀번호가 담긴 설정 키. */
    userField?: string;
    passField?: string;
  };
  pagination?: {
    kind: "none" | "page" | "offset" | "cursor" | "link";
    /** page/offset 시작값(기본 page=1, offset=0)과 페이지 크기. */
    startPage?: number;
    pageSize?: number;
    /** cursor 방식: 응답에서 다음 커서를 집는 경로. 값이 비면 종료. */
    nextPath?: string;
    /** link 방식: 응답에서 다음 URL 을 집는 경로(절대 URL). 비면 종료. */
    nextUrlPath?: string;
    /** 최대 페이지(설정 상한 — MAX_PAGES 와 함께 작동, 작은 쪽). */
    maxPages?: number;
  };
  /** 응답에서 **항목 목록**을 집는 경로(예: "$.data.items"). 비우면 응답 자체가 배열이라고 본다. */
  itemsPath?: string;
  /** 항목 → RawItem 매핑. */
  map?: FieldMap;
  /** RawItem.type · provenance.category(기본 note/collab_tool). */
  itemType?: RawItem["type"];
  category?: string;
  /** 증분 — 이 값이 있으면 URL 의 {cursor} 에 마지막 관측 시각(ISO)이 들어간다. */
  incremental?: boolean;
  /** 상대 URL 절대화 베이스. */
  baseUrl?: string;
  /**
   * 사설/링크로컬 대역 접근 허용(기본 false=차단). 사내 API 를 붙이려면 켜야 하고,
   * 켠다는 것은 'SSRF 차단선을 내가 책임지고 연다'는 뜻이다(화면에 그렇게 쓴다).
   */
  allowPrivateNetwork?: boolean;
  /**
   * 커스텀 파서(선택) — 목록을 뽑은 **뒤**, 매핑 **전**에 끼어들어 항목 배열을 다시 만든다.
   *  격리 자식 프로세스에서 돈다(parser-sandbox.ts — 그 헤더에 경계와 한계 명시).
   */
  parserScript?: string;
}

/** {config.key} · {cursor} · {page} · {offset} · {limit} 치환. 값은 URL 인코딩(쿼리 조작 방지). */
function fill(tpl: string, vars: Record<string, string | number | undefined>, cfg: Record<string, string | undefined>, encode: boolean): string {
  return String(tpl ?? "").replace(/\{([a-zA-Z0-9_.]+)\}/g, (_m, key: string) => {
    let v: string | number | undefined;
    if (key.startsWith("config.")) v = cfg[key.slice(7)];
    else v = vars[key];
    if (v == null) return "";
    return encode ? encodeURIComponent(String(v)) : String(v);
  });
}

/**
 * 범용 HTTP 커넥터를 만든다. 반환값은 여느 커넥터와 같은 SPI(Connector) — run-sync 는 차이를 모른다.
 *  cfg = 프리셋의 driver_config, settings = **수집기 인스턴스**의 해소된 설정(토큰 포함).
 */
export function makeHttpConnector(
  system: string, cfg: HttpDriverConfig, settings: Record<string, string | undefined>,
): Connector {
  const instance = settings.instance || undefined;
  const map = cfg.map ?? {};
  const pag = cfg.pagination ?? { kind: "none" };
  const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(pag.maxPages ?? MAX_PAGES)));
  const pageSize = Math.max(1, Number(pag.pageSize ?? 100));

  async function fetchPage(url: string, cursor: string | undefined, page: number, offset: number): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = fill(v, { cursor, page, offset, limit: pageSize }, settings, false);

    // 인증 — 토큰 '값'은 수집기 설정에서 온다(프리셋에 시크릿을 적지 않는다).
    const auth = cfg.auth ?? { kind: "none" };
    let finalUrl = url;
    if (auth.kind === "bearer") {
      const t = settings[auth.tokenField ?? "token"];
      if (t) headers.Authorization = `Bearer ${t}`;
    } else if (auth.kind === "header") {
      const t = settings[auth.tokenField ?? "token"];
      if (t) headers[auth.name || "Authorization"] = t;
    } else if (auth.kind === "basic") {
      const u = settings[auth.userField ?? "username"] ?? "";
      const p = settings[auth.passField ?? "password"] ?? "";
      if (u || p) headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    } else if (auth.kind === "query") {
      const t = settings[auth.tokenField ?? "token"];
      if (t) {
        const uo = new URL(finalUrl);
        uo.searchParams.set(auth.name || "access_token", t);
        finalUrl = uo.toString();
      }
    }

    const checked = await assertUrlAllowed(finalUrl, cfg.allowPrivateNetwork === true);
    const method = cfg.method ?? "GET";
    const body = method === "POST" && cfg.body
      ? fill(cfg.body, { cursor, page, offset, limit: pageSize }, settings, false)
      : undefined;
    if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(checked.toString(), { method, headers, body, signal: ctl.signal, redirect: "follow" });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* JSON 아님 — 파서/매핑이 text 를 볼 수 있게 둔다 */ }
      return { status: res.status, json: json ?? text, text };
    } finally { clearTimeout(timer); }
  }

  return {
    name: system,
    async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
      const since = cfg.incremental ? opts?.since : undefined;
      let cursor: string | undefined = since;
      let page = Number(pag.startPage ?? 1);
      let offset = 0;
      let nextUrl: string | undefined;
      let mapFailures = 0, emitted = 0;

      for (let i = 0; i < maxPages; i++) {
        const url = nextUrl ?? fill(cfg.url, { cursor, page, offset, limit: pageSize }, settings, true);
        if (!url) break;

        const { status, json, text } = await fetchPage(url, cursor, page, offset);
        if (status < 200 || status >= 300) {
          // 실패는 던진다 — run-sync 가 잡아 **커서를 얼린다**(유실 방지 불변식). 조용히 끝내면 안 된다.
          throw new Error(`HTTP ${status} — ${String(text).slice(0, 300)}`);
        }

        // 항목 목록 뽑기 → (선택) 커스텀 파서 → 매핑
        let items: unknown[] = cfg.itemsPath?.trim()
          ? extractAll(json, cfg.itemsPath)
          : (Array.isArray(json) ? json : [json]);

        if (cfg.parserScript) {
          const r = await runCustomParser(cfg.parserScript, items);
          if (!r.ok) throw new Error(`커스텀 파서 실패 — ${r.error ?? "알 수 없는 오류"}`);
          items = r.items;
        }

        for (const it of items) {
          const raw = mapToRawItem(it, map, {
            system, instance, category: cfg.category, type: cfg.itemType, baseUrl: cfg.baseUrl ?? url,
          });
          if (!raw) { mapFailures++; continue; }
          emitted++;
          yield raw;
        }

        // 다음 페이지 결정
        if (pag.kind === "none") break;
        if (pag.kind === "page") { if (!items.length) break; page++; }
        else if (pag.kind === "offset") { if (!items.length) break; offset += items.length; }
        else if (pag.kind === "cursor") {
          const nx = pag.nextPath ? extractAll(json, pag.nextPath)[0] : undefined;
          if (nx == null || nx === "") break;
          cursor = String(nx);
        } else if (pag.kind === "link") {
          const nx = pag.nextUrlPath ? extractAll(json, pag.nextUrlPath)[0] : undefined;
          if (nx == null || nx === "") break;
          nextUrl = String(nx);
        }
      }

      if (mapFailures) {
        // 조용히 넘기지 않는다 — '수집은 됐는데 0건'의 가장 흔한 원인이 external_id 매핑 누락이다.
        logger.warn({ system, mapFailures, emitted },
          "범용 수집기: 고유 id(external_id) 매핑이 비어 건너뛴 항목 — 필드 매핑의 'external_id' 경로를 확인하세요");
      }
    },
  };
}
