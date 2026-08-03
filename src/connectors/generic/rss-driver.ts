// 범용 RSS/Atom 수집 드라이버(#1419 T2) — 공개 피드·사내 블로그·릴리스 노트를 코드 없이 붙인다.
//
//  왜 HTTP 드라이버로 안 되나: 피드는 JSON 이 아니라 XML 이고, 두 규격(RSS 2.0 · Atom)이 태그 이름만
//   다르게 같은 것을 말한다(item/entry · pubDate/updated · description/content). 그 사소한 차이를
//   관리자에게 매핑시키면 '피드 주소만 넣으면 되는 일'이 설정 노동이 된다 — 그래서 여기서 흡수한다.
//
//  ⚠ XML 파서를 의존성으로 들이지 않는다. 피드는 구조가 얕고 고정적이라(채널 > 항목 > 스칼라 필드)
//   필요한 만큼만 직접 훑는 편이 작다. 대신 **엔티티·CDATA·네임스페이스 접두** 처리는 확실히 한다 —
//   실제 피드가 그걸로 깨지기 때문이다.
import type { BackfillOpts, Connector, RawItem } from "../types.js";
import { asIso } from "./mapping.js";
import { runCustomParser } from "./parser-sandbox.js";

const REQUEST_TIMEOUT_MS = 30_000;

export interface RssDriverConfig {
  /** 피드 URL — {config.<key>} 치환 가능(사내 피드가 경로에 팀명을 받는 경우 등). */
  url: string;
  /** 항목 종류(기본 note) · provenance.category(기본 collab_tool). */
  itemType?: RawItem["type"];
  category?: string;
  /** 이 피드가 속한 '채널' 표시명 — 비우면 피드 <title> 을 쓴다(증류 맥락용, #735 계승). */
  containerName?: string;
  /** 커스텀 파서(선택) — 파싱된 항목 배열에 끼어든다. */
  parserScript?: string;
  allowPrivateNetwork?: boolean;
}

/** XML 엔티티 복원 — 숫자 참조 포함. 피드 제목의 &amp;#39; 같은 이중 인코딩이 흔하다. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // amp 는 마지막 — 먼저 풀면 이중 인코딩이 잘못 복원된다
}

/** 태그 1개의 텍스트(첫 매치). CDATA 를 벗기고 네임스페이스 접두(dc:creator)를 허용한다. */
function tagText(xml: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(`<(?:[\\w-]+:)?${name}(\\s[^>]*)?\\s*(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, "i");
    const m = re.exec(xml);
    if (!m) continue;
    let v = m[2];
    if (v == null) { // 자기닫힘 태그 — Atom link 처럼 값이 속성에 있는 경우
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[1] ?? "");
      if (href) return decodeEntities(href[1].trim());
      continue;
    }
    v = v.trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
    if (cdata) return cdata[1].trim();
    if (!v) continue;
    return decodeEntities(v).trim();
  }
  return undefined;
}

/** Atom link — rel="alternate"(또는 rel 없음)의 href 를 고른다. rel="self" 를 항목 URL 로 쓰면 안 된다. */
function atomLink(xml: string): string | undefined {
  const re = /<(?:[\w-]+:)?link\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null, fallback: string | undefined;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? "";
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!rel || rel === "alternate") return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

/** 피드 XML → 항목 블록들. RSS(item)·Atom(entry) 양쪽. */
function splitEntries(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w-]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[2]);
  return out;
}

/** 항목 블록 → 우리 필드. 두 규격의 이름 차이를 여기서 흡수한다. */
function parseEntry(block: string): {
  id?: string; title?: string; body?: string; url?: string; at?: string; author?: string;
} {
  const url = tagText(block, "link") ?? atomLink(block);
  return {
    // guid(RSS)·id(Atom) 우선, 없으면 링크 — 셋 다 없으면 호출자가 버린다(멱등 키 없음).
    id: tagText(block, "guid", "id") ?? url,
    title: tagText(block, "title"),
    // content:encoded(RSS 확장)가 가장 온전하고, 그다음 Atom content, 마지막이 요약이다.
    body: tagText(block, "encoded", "content", "description", "summary"),
    url,
    at: tagText(block, "pubDate", "published", "updated", "date"),
    author: tagText(block, "creator", "author", "name"),
  };
}

export function makeRssConnector(
  system: string, cfg: RssDriverConfig, settings: Record<string, string | undefined>,
): Connector {
  const instance = settings.instance || undefined;

  return {
    name: system,
    async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
      const url = String(cfg.url ?? "").replace(/\{config\.([a-zA-Z0-9_]+)\}/g,
        (_m, k: string) => encodeURIComponent(settings[k] ?? ""));
      if (!url) throw new Error("피드 URL 이 비어 있습니다");
      // SSRF 차단선은 HTTP 드라이버와 같은 판정을 쓴다(사내 피드는 명시적 옵트인).
      const { assertRssUrlAllowed } = await import("./url-guard.js");
      const checked = await assertRssUrlAllowed(url, cfg.allowPrivateNetwork === true);

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      let xml: string;
      try {
        const res = await fetch(checked, { signal: ctl.signal, redirect: "follow", headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
        if (!res.ok) throw new Error(`HTTP ${res.status} — 피드를 읽지 못했습니다`);
        xml = await res.text();
      } finally { clearTimeout(timer); }

      // 채널 제목 — 항목 블록을 지운 뒤 뽑아야 첫 '항목의 제목'을 채널명으로 오인하지 않는다.
      const channelOnly = xml.replace(/<(?:[\w-]+:)?(item|entry)\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?\1>/gi, "");
      const containerName = cfg.containerName || tagText(channelOnly, "title");

      let entries = splitEntries(xml).map(parseEntry);
      if (cfg.parserScript) {
        const r = await runCustomParser(cfg.parserScript, entries);
        if (!r.ok) throw new Error(`커스텀 파서 실패 — ${r.error ?? "알 수 없는 오류"}`);
        entries = r.items as typeof entries;
      }

      // 증분 — 피드는 대개 최근 N건만 주므로 since 이전은 걸러 내보낸다(멱등이라 안 걸러도 무해하나,
      //  하류 처리량을 아낀다). 시각을 못 읽은 항목은 **버리지 않는다**(거르면 조용한 유실).
      const sinceMs = opts?.since ? Date.parse(opts.since) : NaN;

      for (const e of entries) {
        if (!e?.id) continue; // 멱등 키 없음
        const iso = asIso(e.at);
        if (Number.isFinite(sinceMs) && iso && Date.parse(iso) < sinceMs) continue;
        yield {
          type: cfg.itemType ?? "note",
          provenance: {
            category: cfg.category ?? "collab_tool",
            system, instance, external_id: String(e.id), external_url: e.url,
          },
          actor: e.author ? { display_name: e.author } : undefined,
          container_name: containerName,
          title: e.title,
          body: e.body,
          occurred_at: iso,
          updated_at: iso,
          fields: containerName ? { container_name: containerName } : undefined,
          raw: e,
        };
      }
    },
  };
}
