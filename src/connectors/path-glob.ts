// 레포 상대경로 glob — 위키 레포 수집기의 범위(include/exclude)와 경로별 분류 규칙이 같은 문법을 쓴다.
//
//  왜 직접 두나: Node 의 path.matchesGlob 은 22 에서도 실험 기능이고 engines.node(>=20) 에는 없다. 필요한 문법은
//   작아서(아래 다섯 줄) 외부 의존을 늘릴 이유가 없다. 문법을 한 곳에 두는 이유는 범위와 분류가 같은 경로를 서로
//   다르게 읽으면 «범위에는 들어왔는데 분류 규칙엔 안 걸려 미분류로 쌓이는» 조용한 구멍이 생기기 때문이다.
//
//  문법(gitignore 에서 자주 쓰는 부분만):
//   · `*` 는 `/` 를 넘지 않는 아무 글자, `?` 는 `/` 가 아닌 한 글자.
//   · `**` 는 `/` 를 넘는다. `**/` 는 «0개 이상의 폴더» 라서 `**/x.md` 가 루트의 `x.md` 에도 맞는다.
//   · `/` 로 끝나면 그 폴더 아래 전부(`Card/` = `Card/**`). ⚠ gitignore 와 달리 **루트의 그 폴더**다 — 어느 깊이의
//     같은 이름 폴더든이면 `**/skills/` 로 쓴다(범위 설정에서 «어디든» 과 «루트만» 이 조용히 섞이지 않게 한 가지로 정했다).
//   · `/` 가 없는 패턴은 어느 깊이의 파일 이름에도 맞는다(`CLAUDE.md` = `**/CLAUDE.md`).
//   · 앞에 `/` · `./` 가 있으면 루트 기준이다(`/CLAUDE.md` 는 루트의 그 파일에만 맞는다). 대소문자는 가린다.
//  경로와 패턴은 둘 다 NFC 로 맞춘다 — macOS 에서 만든 한글 파일명은 NFD 로 들어올 수 있어, 눈에는 같은
//  `카드.md` 가 바이트로는 달라 패턴이 조용히 빗나간다.

import path from "node:path";

/** 패턴 한 줄 → 정규식. 빈 줄 · `#` 주석은 null. */
export function compileGlob(pattern: string): RegExp | null {
  let p = String(pattern ?? "").trim().normalize("NFC");
  if (!p || p.startsWith("#")) return null;
  //  `/` · `./` 는 둘 다 «루트 기준» 표시 — 이름만 남아도(`/CLAUDE.md`) 어느 깊이에나 맞지 않고 루트에만 맞는다.
  const anchored = p.startsWith("/") || p.startsWith("./");
  if (anchored) p = p.replace(/^(?:\.?\/)+/, "");
  if (!p) return null;
  if (p.endsWith("/")) p += "**";
  if (!anchored && !p.includes("/")) p = `**/${p}`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const atSegmentStart = i === 0 || p[i - 1] === "/";
        if (atSegmentStart && p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** 설정 문자열(줄바꿈 또는 쉼표 구분) → 패턴 목록. 경로에 쉼표가 있으면 줄바꿈으로 나눠 적는다. */
export function parseGlobList(raw: string | null | undefined): string[] {
  const s = String(raw ?? "");
  const parts = s.includes("\n") ? s.split("\n") : s.split(",");
  return parts.map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
}

/** 미리 컴파일한 패턴 묶음. 같은 목록을 파일 수천 개에 대므로 한 번만 컴파일한다. */
export class GlobSet {
  private readonly res: RegExp[];
  /** 받은 패턴 수(빈 줄 · 주석 뺀) — 정규식으로 못 만든 패턴(`/` 처럼 걷고 나면 빈 것)도 센다.
   *  include 가 «설정됐는가» 는 이 수로 본다(size 로 보면 무효 패턴만 적은 include 가 «전부 포함» 으로 샌다). */
  readonly configured: number;
  constructor(patterns: readonly string[]) {
    const given = patterns.map((p) => String(p ?? "").trim()).filter((p) => p && !p.startsWith("#"));
    this.configured = given.length;
    this.res = given.map(compileGlob).filter((r): r is RegExp => r !== null);
  }
  get size(): number { return this.res.length; }
  matches(relpath: string): boolean {
    const p = toPosixRel(relpath);
    return this.res.some((r) => r.test(p));
  }
}

/** 범위 판정 — include 가 비면 전부 들어오고, exclude 가 이긴다.
 *  include 는 좁히는 설정이라 실패는 닫힌 쪽이다: 패턴을 적었는데 하나도 유효하지 않으면 아무것도 들어오지 않는다. */
export function inScope(relpath: string, include: GlobSet, exclude: GlobSet): boolean {
  if (include.configured && !include.matches(relpath)) return false;
  return !exclude.matches(relpath);
}

/** OS 구분자 · 앞의 `./` 를 걷은 NFC POSIX 상대경로. */
export function toPosixRel(relpath: string): string {
  const s = String(relpath ?? "");
  return (path.sep === "/" ? s : s.split(path.sep).join("/")).replace(/^\.\/+/, "").normalize("NFC");
}
