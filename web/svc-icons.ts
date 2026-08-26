// svc-icons.ts — 외부 서비스 타일(#1597). 로고 자체는 svc-logos.ts(공식 경로 데이터)가 갖고, 여기는 **타일**만 만든다.
//  형태 언어는 대시보드 알림 타일(dash-ntf-tile)과 같다: 라운드 스퀘어 + 그 안의 마크.
//
//  ⚠ 2026-08-21 변경 — 마크를 **우리가 그리지 않는다**. 종전엔 이 파일이 서비스마다 도형 좌표를 직접 들고
//   있었는데(노션은 사각형+N, 슬랙은 막대 넷…) 원준님이 "조잡하다, 외부에서 제대로 된 로고를 가져와라"고 했다.
//   맞는 지적이다: 로고는 '비슷한 그림'이 아니라 **그 모양 자체**가 신원이라, 눈대중으로 그리면 그 서비스로
//   읽히지 않는다. 이제 공식 마크의 경로를 CC0 아이콘 세트에서 그대로 쓴다 → svc-logos.ts.
//
/* DS-EXCEPTION: 외부 브랜드 자산(서비스 로고) — 팔레트 밖 색 리터럴을 여기서만 허용한다.
   근거: ui-design-system-agent ▸ exception-policy §1 '외부 브랜드 자산(서비스 로고 등)'. 2026-08-10, #1597 */
import { el } from './core.js';
import { svcLogo } from './svc-logos.js';

// 서비스 키 → 브랜드 대표색. 타일 바탕(브랜드색 12% 틴트)에만 쓴다 — 마크의 색은 로고가 스스로 갖고 있다.
const SVC_BRAND: Record<string, string> = {
  notion: '#191919',
  linear: '#5E6AD2',
  slack: '#4A154B',
  google: '#4285F4', // #1881 G5 — 접힌 구글 타일. 아래 구 키 3개는 기존 화면 호환으로 남긴다.
  'google-gmail': '#EA4335',
  'google-drive': '#0F9D58',
  'google-calendar': '#4285F4',
  github: '#181717',
  gitlab: '#FC6D26',
  clickup: '#7B68EE',
  figma: '#F24E1E',
  prometheus: '#E6522C',
  'claude-headless': '#D97757',
};

// 표에 없는 서비스(나중에 늘어난 것)도 화면이 깨지지 않게 — 이름 첫 글자 글리프로 떨어진다.
function fallbackMark(label: string) {
  return el('span', { class: 'svc-tile-ini', text: String(label || '?').trim().slice(0, 1).toUpperCase() });
}

// 서비스 타일 — on=연결됨(로고 제 색) / off=미연결(색이 빠져 잠들어 있고, 부모 hover 때 깨어난다).
//  '켜져 있으면 색이 산다'가 이 화면에서 연결/미연결을 가르는 가장 빠른 신호다.
//  ⚠ off 를 색상 속성(color)으로 만들지 않는다 — 이제 마크가 여러 색을 스스로 들고 있어서 currentColor 가
//   안 먹는다. 대신 CSS 에서 filter: grayscale 로 **색만 뺀다**(모양은 그대로 남는다).
function svcTile(key: string, label: string, on: boolean) {
  const brand = SVC_BRAND[key];
  return el('span', {
    class: 'svc-tile' + (on ? '' : ' off'),
    style: brand ? '--svc-brand:' + brand : null,
  }, svcLogo(key) || fallbackMark(label));
}

export { SVC_BRAND, svcTile };
