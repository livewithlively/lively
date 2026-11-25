// 본문 길이(body_length) 거부를 사람 없이 푸는 결정적 분리 계획 — 어느 절을 떼어 낼지를 글의 모양만 보고 정한다.
//
// 길이 거부의 안전한 처리는 «줄이지 말고 나눈다» 다(writing-style.ts BODY_LENGTH_REJECT_GUIDE). 그런데 에이전트에게 나누기를
//  맡기면 두 가지가 샌다: 어느 절을 뗄지 «판단이 안 선다» 며 사람에게 묻고 멈추거나, 절을 옮겨 적다가 글자가 바뀐다.
//  여기서 절을 고르고 원문 그대로 잘라 내면 둘 다 없어진다 — 판단은 규칙이 하고, 옮기는 글자는 원문 바이트다.
//
// 고르는 규칙: 이력·로그·기록처럼 따로 읽혀도 되는 절을 먼저, 그다음 큰 절부터 옮긴다. 맨 앞(첫 H2 전) 결론은 남긴다.
//  절 끝이 표면 표 머리(머리줄·구분줄)는 남기고 행만 옮긴다 — 행을 덧붙여 가는 원장은 다음 행이 머리 없는 표에 붙지 않아야 한다.
// 순수 함수다(DB 없음). 실패하면(옮길 단위 하나가 너무 크다 등) null — 호출자는 종전 거부로 돌아간다.

export interface SplitPart {
  /** 옮긴 절의 헤딩 글자(# 와 기호를 뗀 것). 머리 없는 본문 덩어리면 null. */
  heading: string | null;
  /** 원문 그대로 옮긴 글. */
  text: string;
}
export interface SplitPlan {
  /** 남는 본문 — 옮긴 자리에 PART_TOKEN(i) 링크 자리표시가 들어 있다. renderSplitParent 로 이름을 채운다. */
  parent: string;
  parts: SplitPart[];
}

export const PART_TOKEN = (i: number): string => `\u0000part${i}\u0000`;
const PART_TOKEN_RE = /\u0000part(\d+)\u0000/g;

/** 자리표시를 [[이름]] 으로 바꾼다. names[i] 가 parts[i] 의 지식 이름이다. */
export function renderSplitParent(plan: SplitPlan, names: string[]): string {
  return plan.parent.replace(PART_TOKEN_RE, (_, i) => `[[${names[Number(i)]}]]`);
}

// 남는 본문은 상한보다 넉넉히 줄인다 — 딱 맞추면 다음 append 한 번에 다시 거부된다.
export const SPLIT_PARENT_RATIO = 0.75;
// 옮긴 조각은 새 지식의 머리 문장이 붙어도 상한 안이어야 한다.
export const SPLIT_PART_RATIO = 0.9;

const HISTORY_RE = /이력|경과|기록|로그|원장|타임라인|변경|부록|사례|실측|측정|history|log|changelog|appendix|timeline/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const H2_RE = /^##\s+\S/;
const TABLE_RE = /^\s*\|/;

const len = (s: string): number => [...s].length;
// 자리표시는 나중에 [[하위 지식 이름]] 으로 바뀐다 — 이름은 64자까지라, 길이는 그 최대치로 잡고 잰다.
const LINK_RESERVE = "x".repeat(64 + 4);
const renderedLen = (s: string): number => len(s.replace(PART_TOKEN_RE, LINK_RESERVE));

/** 펜스 안 줄을 표시한다 — 펜스 안의 '## ' 는 헤딩이 아니다. */
function fenceMask(lines: string[]): boolean[] {
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const l of lines) {
    const m = FENCE_RE.exec(l);
    if (fence) {
      inFence.push(true);
      // 닫는 펜스는 같은 글자·같거나 긴 길이이고 뒤에 정보 문자열이 없어야 한다(writing-resolve timeReferenceLines 와 같은 판정).
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !l.trim().slice(m[1].length).trim()) fence = null;
      continue;
    }
    if (m) { fence = m[1]; inFence.push(true); continue; }
    inFence.push(false);
  }
  return inFence;
}

/** 줄 배열을 헤딩 경계로 자른다. 첫 헤딩 전은 head. */
function splitAt(lines: string[], isHead: RegExp): { head: string[]; sections: string[][] } {
  const mask = fenceMask(lines);
  const head: string[] = [];
  const sections: string[][] = [];
  lines.forEach((l, i) => {
    if (!mask[i] && isHead.test(l)) sections.push([l]);
    else if (sections.length) sections[sections.length - 1].push(l);
    else head.push(l);
  });
  return { head, sections };
}

/** 빈 줄로 나뉜 덩어리(문단·표·코드 블록). 펜스 안의 빈 줄은 나누지 않는다. */
function blocksOf(lines: string[]): string[][] {
  const mask = fenceMask(lines);
  const out: string[][] = [];
  let cur: string[] = [];
  lines.forEach((l, i) => {
    if (!mask[i] && !l.trim()) { if (cur.length) { out.push(cur); cur = []; } return; }
    cur.push(l);
  });
  if (cur.length) out.push(cur);
  return out;
}

const headingText = (line: string): string =>
  line.replace(/^#+\s*/, "").replace(/\p{Extended_Pictographic}(?:️)?/gu, "").replace(/\*\*/g, "").trim() || "본문";

const trimEnd = (ls: string[]): string[] => { const a = [...ls]; while (a.length && !a[a.length - 1].trim()) a.pop(); return a; };

/** 덩어리들을 상한 안의 조각들로 묶는다. 덩어리 하나가 상한을 넘으면 표는 행으로(머리 반복), 그 밖은 실패. */
function packBlocks(blocks: string[][], max: number): string[] | null {
  const units: string[] = [];
  for (const b of blocks) {
    const text = b.join("\n");
    if (len(text) <= max) { units.push(text); continue; }
    if (b.length >= 3 && b.every((l) => TABLE_RE.test(l)) && TABLE_SEP_RE.test(b[1])) {
      const head = b.slice(0, 2).join("\n");
      let rows: string[] = [];
      for (const r of b.slice(2)) {
        if (len(r) + len(head) + 2 > max) return null;
        if (rows.length && len([head, ...rows, r].join("\n")) > max) { units.push([head, ...rows].join("\n")); rows = []; }
        rows.push(r);
      }
      if (rows.length) units.push([head, ...rows].join("\n"));
      continue;
    }
    return null;
  }
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    const next = cur ? `${cur}\n\n${u}` : u;
    if (cur && len(next) > max) { chunks.push(cur); cur = u; } else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

interface Section { lines: string[]; heading: string | null; headingLine: string | null; history: boolean }

const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 절 끝의 표 — 머리줄·구분줄과 행 1개 이상. 행 사이 빈 줄은 표의 일부로 본다(빈 줄로 이어 붙인 원장이 있다).
 *  행 자리에 구분줄이 또 나오면 표가 둘 이상이다 — 하나로 합치면 열이 다른 표가 깨지므로 표로 다루지 않는다. */
function tailTable(lines: string[]): { start: number; rows: string[] } | null {
  const body = trimEnd(lines);
  let i = body.length;
  while (i > 0 && (TABLE_RE.test(body[i - 1]) || !body[i - 1].trim())) i--;
  while (i < body.length && !body[i].trim()) i++;
  if (!TABLE_RE.test(body[i] ?? "") || !TABLE_SEP_RE.test(body[i + 1] ?? "")) return null;
  const rows = body.slice(i + 2).filter((l) => l.trim());
  if (rows.some((l) => TABLE_SEP_RE.test(l))) return null;
  return rows.length ? { start: i, rows } : null;
}

/**
 * 본문을 상한 안으로 나누는 계획. 상한 안이면 null(나눌 필요 없음), 나눌 수 없어도 null.
 *  limit 는 코드포인트 수다(lint 의 body_length 와 같은 단위).
 */
export function planBodySplit(body: string, limit: number): SplitPlan | null {
  if (len(body) <= limit) return null;
  const target = Math.floor(limit * SPLIT_PARENT_RATIO);
  const partMax = Math.floor(limit * SPLIT_PART_RATIO);
  const lines = body.split("\n");
  const top = splitAt(lines, H2_RE);
  let head = top.head;
  let sections: Section[] = top.sections.map((s) => ({ lines: s, heading: headingText(s[0]), headingLine: s[0], history: HISTORY_RE.test(s[0]) }));
  if (!sections.length) {
    // 헤딩 없는 글 — 첫 문단(결론)만 남기고 나머지를 머리 없는 한 덩어리로 본다.
    if (blocksOf(lines).length < 2) return null;
    // 결론 문단까지 남긴다 — 맨 앞 H1(제목 반복)은 문단으로 치지 않는다(lint 의 첫 줄 판정과 같다).
    let firstEnd = lines.findIndex((l) => l.trim());
    if (/^#\s/.test(lines[firstEnd] ?? "")) { firstEnd++; while (firstEnd < lines.length && !lines[firstEnd].trim()) firstEnd++; }
    while (firstEnd < lines.length && lines[firstEnd].trim()) firstEnd++;
    head = lines.slice(0, firstEnd);
    sections = [{ lines: lines.slice(firstEnd), heading: null, headingLine: null, history: true }];
  }

  // 옮길 순서: 이력류 먼저, 그다음 큰 절. 같으면 문서 순서.
  const order = sections.map((s, i) => i).sort((a, b) =>
    Number(sections[b].history) - Number(sections[a].history) || len(sections[b].lines.join("\n")) - len(sections[a].lines.join("\n")) || a - b);

  const rendered: string[][] = sections.map((s) => s.lines);
  const parts: SplitPart[] = [];
  const total = (): number => renderedLen([...head, ...rendered.flat()].join("\n"));

  for (const i of order) {
    if (total() <= target) break;
    const s = sections[i];
    const tt = tailTable(s.lines);
    if (tt) {
      // 표 행만 옮긴다. 머리줄·구분줄은 남기고, 옮긴 조각에도 머리를 붙인다(packBlocks 가 표 블록 단위로 다룬다).
      const tableHead = s.lines.slice(tt.start, tt.start + 2);
      const tableRows = tt.rows;
      const pre = s.lines.slice(0, tt.start);
      const preLen = len(pre.join("\n"));
      // 표 앞 서술이 길면 그것까지 옮겨야 줄어든다 — 그때는 절을 통째로 다룬다(아래 일반 경로).
      if (preLen < target / 2) {
        const chunks = packBlocks([[...tableHead, ...tableRows]], partMax);
        if (!chunks) return null;
        const first = parts.length;
        for (const c of chunks) parts.push({ heading: s.heading, text: c });
        const links = chunks.map((_, k) => PART_TOKEN(first + k)).join(", ");
        rendered[i] = [...trimEnd(pre), "", `앞선 행은 ${links} 로 옮겼다.`, "", ...tableHead, ...s.lines.slice(trimEnd(s.lines).length)];
        continue;
      }
    }
    const moved = s.headingLine ? s.lines.slice(1) : s.lines;
    const chunks = packBlocks(blocksOf(moved), partMax);
    if (!chunks || !chunks.length) continue;
    const first = parts.length;
    chunks.forEach((c, k) => parts.push({
      heading: s.heading,
      text: s.headingLine && k === 0 ? `${s.headingLine}\n\n${c}` : c,
    }));
    const links = chunks.map((_, k) => PART_TOKEN(first + k)).join(", ");
    const stub = s.headingLine ? `${s.headingLine}\n\n이 절은 ${links} 로 옮겼다.\n` : `이어지는 내용은 ${links} 로 옮겼다.\n`;
    rendered[i] = stub.split("\n");
  }

  if (!parts.length) return null;
  const parent = [...head, ...rendered.flat()].join("\n");
  if (renderedLen(parent) > limit || parts.some((p) => len(p.text) > partMax)) return null;
  // 무손실 — 원문의 내용 줄이 남는 본문과 옮긴 조각 어딘가에 그만큼 있어야 한다.
  const have = new Map<string, number>();
  for (const l of [...parent.split("\n"), ...parts.flatMap((p) => p.text.split("\n"))]) {
    const k = l.trim(); if (k) have.set(k, (have.get(k) ?? 0) + 1);
  }
  for (const l of lines) {
    const k = l.trim(); if (!k) continue;
    const n = have.get(k) ?? 0;
    if (n <= 0) return null;
    have.set(k, n - 1);
  }
  return { parent, parts };
}
