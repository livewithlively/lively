// sse-frames.ts — 서버 전송 이벤트(SSE) 바이트 흐름을 **프레임으로 자르는** 순수 함수(#2055). DOM·네트워크를 모른다.
//
//  ── 왜 떼어냈나 ──
//  이 자르기는 **틀려도 조용하다**. 청크가 프레임 한가운데서 끊기면(항상 그런다) 잘못 자른 조각은 JSON 파싱에서
//  버려지고, 화면엔 "가끔 글자가 빠진다"로만 나타난다 — 신고되지 않고 원인도 안 보인다. 그래서 계약을 표로 못박고
//  DOM 없는 자리에 둔다(chat-tool-group.ts 와 같은 결).
//
//  ── 계약(SSE 규격 중 우리가 쓰는 부분) ──
//  · 프레임 경계는 **빈 줄**(\n\n). 마지막 조각(경계가 아직 안 온 것)은 rest 로 돌려 다음 청크에 이어 붙인다.
//  · 한 프레임에 `data:` 줄이 여럿이면 **개행으로 이어 붙인다**(규격) — 한 줄만 읽으면 긴 페이로드가 잘린다.
//  · `data:` 뒤의 공백 **한 칸만** 벗긴다(그 뒤 공백은 값이다).
//  · `:` 로 시작하는 줄은 주석(하트비트) — 값이 없으므로 프레임이 통째로 비면 건너뛴다.
//  · CRLF 도 받는다(프록시가 바꿔 놓는 경우).

export interface SseSplit {
  /** 완성된 프레임들의 data 값(주석뿐인 프레임은 빠진다). */
  data: string[];
  /** 아직 경계가 안 온 꼬리 — 호출자가 다음 청크 앞에 붙인다. */
  rest: string;
}

/** 프레임 한 장 → data 값. 없으면 null(주석·필드만 있는 프레임). */
export function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;             // 빈 줄·주석(하트비트)
    if (!line.startsWith('data:')) continue;                 // event:·id:·retry: 는 우리가 안 쓴다
    const v = line.slice(5);
    parts.push(v.startsWith(' ') ? v.slice(1) : v);          // 규격: 공백 한 칸만 벗긴다
  }
  return parts.length ? parts.join('\n') : null;
}

/** 누적 버퍼 → 완성된 data 값들 + 남은 꼬리. */
export function splitSse(acc: string): SseSplit {
  const data: string[] = [];
  let rest = String(acc ?? '');
  for (;;) {
    // \n\n 이 정식 경계지만 프록시가 CRLF 로 바꾸면 \r\n\r\n 으로 온다 — 둘 다 받는다.
    const lf = rest.indexOf('\n\n');
    const crlf = rest.indexOf('\r\n\r\n');
    const at = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
    if (at < 0) break;
    const len = rest.startsWith('\r\n\r\n', at) ? 4 : 2;
    const frame = rest.slice(0, at);
    rest = rest.slice(at + len);
    const d = frameData(frame);
    if (d !== null) data.push(d);
  }
  return { data, rest };
}
