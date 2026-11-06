// v6/knowledge-chunk.ts — 지식을 절 조각으로 나누는 규칙 한 벌(#5203 · 프로젝트 #5198). 순수 모듈이다(DB 무접촉). 표에 맞추는 일은 knowledge-lex-store.ts.
//
//  왜 조각인가 — 문서 벡터는 앞 2,048토큰만 보고(문서의 55%가 더 길다) 수정의 88.8% 는 끝 덧붙임이라 새 내용이 벡터에 안 들어간다.
//   판정 200+200 질의에서 조각 + BM25 가 문서 벡터 + BM25 를 구간 밖으로 앞섰다(지식 research-1617-chunk-search-combination-2026-10-31).
//
//  ── 규칙(측정한 그대로 — 바꾸면 다시 재고 CHUNK_RULES_VERSION 을 올린다) ──
//   · 제목(#)마다 절 하나. 코드 블록 안의 `# 주석` 은 제목이 아니다. 본문 줄이 없는 절은 버린다. 빈 줄은 뺀다.
//   · 절이 2,000자를 넘으면 줄 경계에서 나눈다. 겹침은 없다. 글자 수 변형(1,000 · 4,000자)은 측정상 구분되지 않았다. 줄 하나가 더 길면 글자 수로 끊는다.
//   · 앞머리는 **절 경로**(« › » 로 이은 제목들)다. 문서 제목은 붙이지 않는다 — 붙이면 오히려 나빠졌다(뺀 쪽이 nDCG@5 사람 +0.001~+0.036 · 에이전트 +0.009~+0.037 높다).
//     경로가 없는 절(첫 제목 앞의 글 · 제목 없는 문서)만 문서 제목을 쓴다.
import crypto from "node:crypto";

/** 조각 규칙의 판 — **규칙이 바뀌면 올린다**. 스윕이 옛 판으로 나눈 문서를 다시 나눈다(글이 같은 조각은 벡터를 그대로 쓴다). */
export const CHUNK_RULES_VERSION = 1;
export const CHUNK_MAX_CHARS = 2000;
/** 문서 하나의 조각 상한 — 약 2MB 다. 넘는 뒤쪽은 낱말 검색으로만 찾힌다. 큰 첨부 글 하나가 하루 임베딩 몫을 다 쓰지 않게. */
export const CHUNK_DOC_MAX = 1000;
const PREFIX_MAX_CHARS = 200;
const FALLBACK_MAX_CHARS = 8000;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export interface KnowledgeChunk {
  seq: number;        // 문서 안 순서(0부터)
  startLine: number;  // 본문에서 이 조각이 시작하는 줄(1부터) — 전달 형식의 «L12»
  path: string;       // 절 경로(« › » 로 이음) — 없으면 빈 글
  prefix: string;     // 임베딩 앞머리 — 경로, 없으면 문서 제목
  body: string;       // 조각 글
  hash: string;       // 임베딩 입력의 해시 — 같으면 벡터를 다시 만들지 않는다
}

interface Line { n: number; text: string }

function sections(body: string): Array<{ path: string[]; lines: Line[] }> {
  const stack: Array<{ lvl: number; title: string }> = [];
  const out: Array<{ path: string[]; lines: Line[] }> = [];
  let cur: { path: string[]; lines: Line[] } | null = null;
  let inFence = false;
  body.split(/\r?\n/).forEach((text, i) => {
    if (FENCE.test(text)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(text);
    if (m) {
      if (cur) out.push(cur);
      const lvl = m[1].length;
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
      stack.push({ lvl, title: m[2].trim() });
      cur = { path: stack.map((h) => h.title), lines: [] };
    } else if (text.trim()) {
      cur ??= { path: [], lines: [] };
      cur.lines.push({ n: i + 1, text });
    }
  });
  if (cur) out.push(cur);
  return out.filter((s) => s.lines.length);
}

/** 줄 하나가 상한보다 길면 글자 수로 끊는다 — 임베딩 입력 상한을 넘기면 뒤가 말없이 잘린다. 서로게이트 쌍은 가르지 않는다. */
function splitLong(line: Line): Line[] {
  if (line.text.length <= CHUNK_MAX_CHARS) return [line];
  const out: Line[] = [];
  let at = 0;
  while (at < line.text.length) {
    let end = Math.min(at + CHUNK_MAX_CHARS, line.text.length);
    const c = line.text.charCodeAt(end - 1);
    if (end < line.text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push({ n: line.n, text: line.text.slice(at, end) });
    at = end;
  }
  return out;
}

/** 조각의 임베딩 입력 — 앞머리 + 글. */
export function chunkEmbedText(c: { prefix?: string | null; body?: string | null }): string {
  return c.prefix ? `${c.prefix}\n${c.body ?? ""}` : String(c.body ?? "");
}

const finish = (seq: number, startLine: number, path: string, prefix: string, body: string): KnowledgeChunk => {
  const p = prefix.slice(0, PREFIX_MAX_CHARS);
  return { seq, startLine, path: path.slice(0, PREFIX_MAX_CHARS), prefix: p, body, hash: crypto.createHash("md5").update(chunkEmbedText({ prefix: p, body })).digest("hex") };
};

/** 지식 → 조각. 본문이 비면 제목 한 조각이고, 제목도 없으면 빈 배열이다. */
export function chunkKnowledge(d: { title?: string | null; body_md?: string | null }): KnowledgeChunk[] {
  const title = (d.title ?? "").trim();
  const out: KnowledgeChunk[] = [];
  for (const s of sections(d.body_md ?? "")) {
    const path = s.path.join(" › ");
    const prefix = s.path.length ? path : title;
    let buf: Line[] = [];
    let n = 0;
    const flush = () => { out.push(finish(out.length, buf[0].n, path, prefix, buf.map((l) => l.text).join("\n"))); buf = []; n = 0; };
    for (const line of s.lines.flatMap(splitLong)) {
      if (n + line.text.length > CHUNK_MAX_CHARS && buf.length) flush();
      buf.push(line);
      n += line.text.length + 1;
    }
    if (buf.length) flush();
  }
  if (out.length) return out.slice(0, CHUNK_DOC_MAX);
  const only = [title, (d.body_md ?? "").trim()].filter(Boolean).join("\n\n").slice(0, FALLBACK_MAX_CHARS);
  return only ? [finish(0, 1, "", "", only)] : [];
}
