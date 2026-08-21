// v2/web-url.ts — 웹 칸(칸 하나를 작은 브라우저로 쓰는 부품)에 **실을 주소**를 만든다.
//
//  두 가지를 한자리에서 정한다:
//   ① 사람이 친 글자를 주소로 — 스킴이 없으면 붙이고, 주소가 아니면 검색으로 보낸다(막다른 입력칸 금지).
//   ② **우리 화면이면 끼워 넣은 판임을 표시**한다 — 표가 없으면 안쪽 라이블리가 바깥 저장값을 읽어 바깥이
//     보던 화면을 자기 안에 복제한다(까닭은 embed.ts).
import { EMBED_ON, EMBED_PARAM } from './embed.js';

const selfOrigin = (): string => { try { return location.origin; } catch (_) { return ''; } };

/** 주소칸의 글자 → 실제로 실을 주소. origin 은 '우리 화면인가'를 가리는 기준(기본은 이 판의 오리진). */
export function normWebUrl(v: string, origin: string = selfOrigin()): string {
  const t = String(v || '').trim();
  if (!t) return '';
  let u = t;
  if (!/^https?:\/\//i.test(u)) {
    // 도메인처럼 생겼으면 주소로, 아니면 검색으로. 여기서 갈라 두지 않으면 오타 하나가 빈 화면이 된다.
    if (!/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(u)) return 'https://www.google.com/search?q=' + encodeURIComponent(u);
    u = 'https://' + u;
  }
  try {
    const o = new URL(u);
    // 이미 표가 있으면 손대지 않는다 — 사람이 일부러 넣었을 수도 있고, 덮어쓰면 그 뜻을 뺏는다.
    if (origin && o.origin === origin && !o.searchParams.has(EMBED_PARAM)) {
      o.searchParams.set(EMBED_PARAM, EMBED_ON);
      return o.href;
    }
  } catch (_) { /* 파싱이 안 되면 손대지 않는다 — 있는 그대로 싣는다(예외로 칸을 죽이지 않는다) */ }
  return u;
}
