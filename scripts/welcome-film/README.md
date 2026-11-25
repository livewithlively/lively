# 소개 영상 (welcome film)

제품의 안내 영상 세 편의 **원본**이다.

| 영상 | 어디서 뜨나 | 굽기 |
|---|---|---|
| `welcome-film.mp4` 온보딩 영상(기초) | 처음 설정을 지나 평소 화면에 온 사람에게 창으로 한 번 · [사용 가이드] | 아래 «굽기» |
| `welcome-guide.mp4` 사용 가이드(라이블리 동작원리) | [사용 가이드] | 아래 «굽기» |
| `welcome-intro.mp4` 라이블리 둘러보기 | CLI 설치 끝 상자의 «안내 영상 보기»(`#/film/intro`) · [사용 가이드] | `node render.mjs --page intro` (원본 `intro.*` · `share.css`) |

화면 녹화가 아니라 HTML 로 그린 모션 그래픽이고, 프레임마다 찍어 ffmpeg 로 묶는다.

| 파일 | 하는 일 |
|---|---|
| `film.html` · `film.css` | 무대(1920×1080)와 장면의 생김새. 색은 제품 토큰(`public/styles/01-base.css`)에서 옮겼다 |
| `film.js` | 장면과 시간표(무엇이 몇 초에 어떻게 움직이나) |
| `engine.js` | 시간축 엔진 — 키프레임을 «시각 t 의 값» 으로만 읽는다(벽시계 없음 → 같은 소스는 늘 같은 영상) |
| `gen-assets.mjs` | 제품의 아이콘 표 · 서비스 로고 표에서 영상이 쓰는 그림을 뽑아 `assets.gen.js` 로 적는다 |
| `render.mjs` | 굽기 · 정지 그림 · 모아 보기 |

## 굽기

```sh
node scripts/build-web.mjs                 # 아이콘 · 로고 표(public/app)
cd scripts/welcome-film && npm install     # playwright-core — 제품 의존성이 아니다(이 폴더에만 깐다)
node render.mjs                            # → public/media/welcome-film.mp4 · welcome-film-poster.jpg (15분쯤)
node render.mjs --still 12.5,26.5 --scale 1   # 그 시각의 그림만 out/still-*.png
node render.mjs --sheet 2 --scale 1           # 2초마다 한 장씩 모은 판 out/sheet-*.jpg
```

필요한 것: Google Chrome · ffmpeg · **Pretendard 글꼴**(컴퓨터에 설치돼 있어야 제품과 같은 글자가 나온다).
기본은 두 배로 그려 1080p 로 줄이고(`--scale 2`), 60fps · H.264 · `+faststart`(받는 대로 재생) · 소리 없음이다.

미리 보기: 이 폴더를 아무 정적 서버로 열고 `film.html` — 아래 막대로 시각을 옮긴다(`?t=26.5` 로 그 시각에 멈춰 연다).

## 고칠 때

- **화면이 바뀌면**(레일 칸 · 앱 이름 · 아이콘) `film.html` 의 그 장면을 고치고 다시 굽는다. 아이콘 · 로고는 표에서 읽으므로 굽기만 다시 하면 따라온다.
- 영상은 재생기 안에서 절반쯤으로 줄어 보인다 — 본문 글자는 26px 아래로 내리지 않는다.
- 문장(자막)은 `film.html` 에 있다. 제품의 말과 어긋나지 않게 처음 설정의 문구(`web/v2/onboarding.ts` OB_COPY)와 함께 본다.
- 구운 뒤 `node scripts/welcome-film.test.mjs` — 자산 크기 상한(12MB) · faststart · 인사 장면 배선을 잰다.
