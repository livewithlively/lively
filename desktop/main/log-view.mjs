// 로그 보기 (#1541) — 앱 안에서 로그 꼬리를 읽는다. 경로 판단·자르기만 하는 순수 모듈.
//
// 왜 필요한가: 노드가 안 뜨거나 조용히 죽으면 화면이 말할 수 있는 건 "정지됨" 뿐이다. 트레이의 '로그 폴더 열기'는
//  탐색기를 띄우고 끝이라 사용자가 어느 파일을 무슨 뷰어로 열지부터 정해야 한다(Windows 는 `.log` 연결이 없는 일이 흔하다).
//  그래서 앱이 직접 꼬리를 보여준다 — 제보에 붙일 수 있는 형태로.
//
// ⚠ **렌더러가 경로를 정하지 못한다.** 읽기는 화이트리스트된 id 로만 연다. 임의 경로를 받으면 XSS 한 방이
//  임의 파일 읽기로 승격된다(이 앱의 렌더러 불신 원칙 — argv 를 메인이 만드는 것과 같은 이유).

/** 앱이 보여주는 로그 — `~/.lively/logs/` 안의 **고정 파일명**만. 사람이 고르는 건 이 목록에서다. */
export const LOG_VIEWS = [
  { id: "node", file: "node-agent.log", label: "노드 에이전트" },
];

/**
 * 화이트리스트 id → 실제 경로. 목록에 없으면 **null**(경로를 지어내지 않는다).
 * @param {(...p:string[])=>string} joiner  플랫폼 join (호스트 구분자 의존을 부르지 않게 주입받는다)
 */
export function resolveLogPath(joiner, livelyDir, id) {
  const v = LOG_VIEWS.find((x) => x.id === id);
  if (!v || !livelyDir) return null;
  return joiner(livelyDir, "logs", v.file);
}

/**
 * 꼬리 자르기 — 줄 경계를 지킨다.
 *
 * 로그는 몇 MB 가 되기도 한다. 통째로 IPC 에 실으면 창이 얼고, 바이트로만 자르면 첫 줄이 반토막 나
 * "깨진 로그" 처럼 보인다(제보에 붙였을 때 오해를 만든다). 그래서 **줄 단위로** 뒤에서 세고,
 * 그래도 크면 앞을 더 버린다. 잘랐다는 사실은 숨기지 않는다(truncated).
 */
export function tailText(text, opts) {
  const o = opts || {};
  const maxLines = Number.isFinite(o.maxLines) ? o.maxLines : 400;
  const maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : 200_000;
  const s = String(text ?? "");
  if (!s) return { text: "", truncated: false, lines: 0 };

  // 끝의 개행 하나는 줄 수에 안 센다(파일이 개행으로 끝나는 게 정상이다).
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  const all = body.split("\n");
  let kept = all.length > maxLines ? all.slice(all.length - maxLines) : all;
  let out = kept.join("\n");
  let truncated = kept.length < all.length;

  // 줄이 적어도 한 줄이 거대할 수 있다(스택트레이스 한 줄, JSON 한 덩어리) — 바이트로 한 번 더 조인다.
  while (kept.length > 1 && Buffer.byteLength(out, "utf8") > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length / 2));
    out = kept.join("\n");
    truncated = true;
  }
  // 한 줄만 남았는데도 크면 그 줄의 뒤쪽만 남긴다(최신이 뒤에 있다).
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = Buffer.from(out, "utf8").subarray(-maxBytes).toString("utf8");
    truncated = true;
  }
  return { text: out, truncated, lines: kept.length };
}
