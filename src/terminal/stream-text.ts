// 자식 프로세스 stdout·stderr 를 **글자**로 모은다 — 조각(chunk)을 다 받은 뒤 한 번에 UTF-8 로 푼다.
//
//  ★ 왜 `out += d` 가 아닌가(#4135, 2026-09-25 실측): 파이프의 Buffer 조각은 대개 64KB 마다 끊기는데, 그 경계가
//   3바이트 한글 한가운데에 걸리면 조각을 **따로** 글자로 바꾸는 순간 U+FFFD 로 깨진다. 186KB 짜리 AGENTS.md 를
//   멤버 경계로 읽어 «내용이 같으면 안 쓴다» 고 비교하던 agents-md.ts 가 그래서 늘 «다르다» 로 판정했고, 8초마다
//   같은 내용을 다시 써서 mtime 이 바뀌었다 — 자료 칸 카드가 8초마다 갈아 끼워지던(깜빡이던) 원인. 같은 읽기로
//   «## 규칙» 절을 뽑는 readRules 도 경계가 표식 글자에 걸리면 규칙을 잃는다.
//  이 모듈은 leaf(의존 없음) — 노드 번들에도 실릴 수 있다.

/** 조각들을 **이어 붙인 뒤** 한 번에 푼다. 문자열 조각은 그대로 잇는다(이미 글자다). */
export function decodeChunks(chunks: ReadonlyArray<Buffer | Uint8Array | string>): string {
  const bufs: Buffer[] = [];
  for (const c of chunks) {
    if (typeof c === "string") bufs.push(Buffer.from(c, "utf8"));
    else bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(bufs).toString("utf8");
}

/** 스트림의 data 를 모아 두고, `get()` 때 한 번에 푼다. 스트림이 없으면(stdio ignore) 빈 글자. */
export function collectText(stream: { on(ev: "data", cb: (d: Buffer | string) => void): unknown } | null | undefined): { get(): string } {
  const chunks: Array<Buffer | string> = [];
  stream?.on("data", (d) => { chunks.push(d); });
  return { get: () => decodeChunks(chunks) };
}
