// dash/widget-folders-preview.ts — 폴더 위젯 보조.
//  ⭐ #1436 후속: **타입 판정표·표 파서·미리보기 렌더는 여기 있지 않다** — `web/lib/file-preview.ts` 로 내려갔다.
//   이유: 같은 판정이 프로젝트 모달·홈 모달·공유 링크 전체페이지에 각각 살아 있어 같은 파일이 화면마다 다르게
//   열렸다(.csv 는 한쪽에선 표, 다른 쪽에선 원문 / .mp4 는 한쪽에선 재생, 다른 쪽에선 '미지원'). 판정이 여러 벌이면
//   반드시 갈라지므로 렌더러를 한 곳으로 모았다. 여기 남은 것은 **대시보드 고유**인 두 개뿐이다.
import { TOKEN_KEY, apiUrl } from '../core.js';
// 가로 목록 위에서 세로 휠 → 가로 스크롤(#req). 마우스 휠은 deltaY 만 나오는데 가로 목록은 세로로 넘칠 게 없어
// '호버해도 아무 일도 안 일어나던' 문제. 가로로 더 굴러갈 여지가 있을 때만 가로채고(preventDefault), 끝에 닿았거나
// 트랙패드 가로 제스처(|deltaX| 우세)면 그대로 흘려보내 페이지 세로 스크롤을 막지 않는다.
function wheelToHorizontal(elm) {
    elm.addEventListener('wheel', (e) => {
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY))
            return;
        const max = elm.scrollWidth - elm.clientWidth;
        if (max <= 1)
            return; // 넘칠 게 없다 → 페이지 스크롤 그대로
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? elm.clientWidth : 1); // line/page 모드 휠 보정
        const next = Math.max(0, Math.min(max, elm.scrollLeft + e.deltaY * unit));
        if (Math.abs(next - elm.scrollLeft) < 0.5)
            return; // 이미 양 끝 → 세로 스크롤을 가로채지 않는다
        e.preventDefault();
        elm.scrollLeft = next;
    }, { passive: false });
}
// 인증 fetch — 파일 바이트는 api()(JSON 파서)를 못 지나므로 직접 fetch 한다.
//  ✅ #1436 에서 고친 것: 종전엔 `fetch(url)` 을 **apiUrl 없이** 불러, 프리뷰 서브패스(/preview/<id>/ui/, #1036·#1091)에서
//   뜬 화면의 미리보기 요청이 접두사를 못 받고 오리진 루트 = **라이브 게이트웨이**로 샜다(같은 파일의 다른 호출은
//   전부 api() 경유라 프리뷰로 갔다 — 그래서 '프리뷰에서 목록은 내 것, 파일 내용은 라이브 것'이 되는 조용한 함정이었다).
//   당시 주석에 "고치려면 apiUrl 로 감싸면 되지만 동작 변경이라 별도 과제"로 남겨 둔 것을, 미리보기를 한 벌로 모으는
//   이번 작업에서 함께 닫았다.
function dashAuthFetch(url) {
    const t = localStorage.getItem(TOKEN_KEY);
    return fetch(apiUrl(url), { headers: t ? { Authorization: 'Bearer ' + t } : {} });
}
export { dashAuthFetch, wheelToHorizontal };
