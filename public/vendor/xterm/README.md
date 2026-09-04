# xterm.js — 벤더링 사본 (#3537)

터미널 화면(`public/terminal.html`)이 쓰는 xterm.js 와 애드온 넷. **셀프호스팅한다.**

## 왜 CDN 에서 걷었나

종전엔 여섯 개 전부 `cdn.jsdelivr.net` 에서 받았고, 그중 `xterm.min.css` 는 `<head>` 의
**렌더블로킹 스타일시트**였다. 즉 **세션 화면의 첫 픽셀이 서드파티 CDN 왕복에 묶여 있었다** —
세션을 열 때마다, 그리고 iframe 이 다시 뜰 때마다.

여기는 사람이 «클로드 코드가 언제 뜨나» 를 재는 바로 그 구간이라(#3537 조사) 남의 인프라에
맡길 자리가 아니다. 게이트웨이가 이미 `public/` 을 서빙하므로 같은 출처에서 주면
DNS·TLS·왕복이 통째로 사라지고, 망이 막힌 환경(사내망·중국)에서 **터미널이 아예 안 뜨던**
경우도 함께 없어진다.

## 버전 (고정)

| 파일 | 패키지 | 버전 |
|---|---|---|
| `xterm.min.css` · `xterm.min.js` | `@xterm/xterm` | 5.5.0 |
| `addon-fit.min.js` | `@xterm/addon-fit` | 0.10.0 |
| `addon-webgl.min.js` | `@xterm/addon-webgl` | 0.18.0 |
| `addon-canvas.min.js` | `@xterm/addon-canvas` | 0.7.0 |
| `addon-web-links.min.js` | `@xterm/addon-web-links` | 0.11.0 |

받은 자리: `https://cdn.jsdelivr.net/npm/<패키지>@<버전>/<경로>` (2026-09-04).
버전은 **종전 `terminal.html` 이 박아 두었던 것 그대로**다 — 이 커밋은 «어디서 받나» 만 바꾸고
«무엇을 받나» 는 안 바꿨다(동작 차이를 만들지 않으려는 것).

## 올릴 때

같은 URL 에서 같은 파일명으로 받아 덮고 위 표의 버전을 고친다. `terminal.html` 은 파일명을
가리키므로 손댈 필요가 없다. 애드온은 xterm 본체와 호환 범위가 있으니 **함께** 올린다.
