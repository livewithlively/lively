// v2/preview-strip.ts — 미리보기(`/preview/<id>/ui/`) 안에 있다는 표시와 «워크스페이스로 돌아가기» 단추(#5581, 원준님 2026-11-19).
//
//  왜: 미리보기는 라이브와 같은 코드·같은 화면이다. 그 안에 들어오면 «여기는 미리보기» 라는 단서가 탭 파비콘뿐이었고
//   (src/preview/preview-favicon.ts), 데스크톱 앱은 주소창도 뒤로 단추도 없어 **돌아갈 길이 없었다**
//   (원준님: "앱 안에서 저 미리보기 누르면 다시 워크스페이스로 돌아오는 길이 없는건지 … 매우 직관적이지 않다").
//  비슷한 제품이 하는 것(Shopify 테마 미리보기 바 · Squarespace 템플릿 미리보기 바 · Stripe 샌드박스 배너)은 셋이 같다:
//   ① 늘 보이는 표시 ② 무엇을 보고 있는지 ③ 실제 화면으로 돌아가는 단추 하나. 그대로 따른다.
//
//  자리:
//   · 브라우저 — 창 맨 위 띠. 본문을 덮지 않고 그 높이만큼 밀어 내린다(--v2-pv-h, 40-v2.css #v2-root 높이).
//   · 데스크톱 앱 — 창 맨 윗줄은 셸의 타이틀바다(신호등 · 창 단추가 얹히고 줄 전체가 창 끌기 자리, titlebar.ts).
//     그 위에 띠를 얹으면 창 단추와 겹친다 → 그 줄 안의 알약으로 둔다(크롬의 시크릿 표시와 같은 자리).
//  안 띄우는 곳: 끼워 넣은 판(?embed=1 — 곁칸에 실린 미리보기는 바깥이 이미 워크스페이스다) · 남의 프레임 안 · 팝아웃(?solo=1).
//
//  «돌아가기» 는 같은 탭에서 **같은 화면의 실제 워크스페이스**로 간다 — `/preview/<id>/ui/#/s/12` → `/ui/#/s/12`.
//   해시 경로는 미리보기와 라이브가 같으므로 보던 자리 그대로 이어진다. 탭을 닫지 않는 까닭: 미리보기 주소를 새 탭에 붙여 연
//   사람에게 탭이 사라지는 건 «돌아가기» 가 아니다.
import { el } from '../core.js';
import { liveUrlOf, previewIdOf } from '../lib/preview-path.js';

export interface PreviewStripOpts {
  /** 셸 뿌리(#v2-root) — 브라우저 띠는 그 바로 앞에 선다. */
  root: HTMLElement;
  /** 데스크톱 타이틀바 줄(titlebar.ts mountTitlebar 의 host). 있으면 띠 대신 그 줄 안에 알약을 둔다. */
  titlebarHost: HTMLElement | null;
  embedded: boolean;
  solo: boolean;
}

/** 미리보기 안이면 표시와 «돌아가기» 단추를 붙인다. 아니면 아무것도 안 한다. 붙였으면 true. */
export function mountPreviewStrip(o: PreviewStripOpts): boolean {
  if (o.embedded || o.solo) return false;
  try { if (window.top !== window) return false; } catch (_) { return false; }   // 다른 출처 프레임 안 — 접근만 해도 던진다
  const id = previewIdOf(location.pathname);
  if (!id) return false;
  const goBack = (): void => { const to = liveUrlOf(location); if (to) location.assign(to); };
  const backBtn = (): HTMLElement => el('button', { type: 'button', class: 'v2-pv-back', text: '워크스페이스로 돌아가기',
    title: '보던 화면 그대로 실제 워크스페이스에서 엽니다', onclick: goBack }) as HTMLElement;

  if (o.titlebarHost) {
    const chip = el('div', { class: 'v2-pv-chip', role: 'status', title: '미리보기 ' + id },
      el('span', { class: 'v2-pv-tag', text: '미리보기' }),
      backBtn()) as HTMLElement;
    const grip = o.titlebarHost.querySelector(':scope > .v2-tb-grip');
    o.titlebarHost.insertBefore(chip, grip);
    return true;
  }
  const strip = el('div', { class: 'v2-pvstrip', role: 'status' },
    el('span', { class: 'v2-pv-tag', text: '미리보기' }),
    el('span', { class: 'v2-pv-id', text: id, title: '미리보기 ' + id }),
    backBtn()) as HTMLElement;
  o.root.before(strip);
  document.documentElement.classList.add('v2-pv-on');
  return true;
}
