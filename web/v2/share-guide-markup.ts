// v2/share-guide-markup.ts — «누가 무엇을 보나요» 안내 카드의 정적 마크업(#5598).
//  ⚠ 생성물이다 — 원본은 시안 HTML(프로젝트 #5598 share-guide.html, 2026-11-22 안내 팝업판)이고, 이름은 전부 sg- 로 감쌌다
//    (시안의 g-xxx → sg-xxx · g-card → sg-gcard · g-note → sg-fnote — 제품의 .sg-card · .sg-note 와 안 겹치게). 54-share-guide.css 와 짝.
//  로고(sg-lg-*)는 web/svc-logos.ts 와 같은 공식 로고 경로다.
//  고칠 때는 문구 · 좌표를 여기서 직접 고쳐도 되지만, 클래스 이름은 CSS 와 같이 고친다. 사람 입력이 들어가지 않는 고정 문자열이다.
export const SG_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="sg-i-folder" viewBox="0 0 24 24"><path d="M3 6.5h6.2l2 2.2H21V19H3z"/></symbol>
  <symbol id="sg-i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="sg-i-team" viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17.2" cy="8" r="2.5"/><path d="M15.6 14.3c2.9.1 5.4 2 5.4 5.2"/></symbol>
  <symbol id="sg-i-know" viewBox="0 0 24 24"><path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z"/></symbol>
  <symbol id="sg-i-power" viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0"/></symbol>
  <symbol id="sg-i-check" viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></symbol>
  <symbol id="sg-i-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></symbol>
  <symbol id="sg-i-replay" viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.5v4.6h4.6"/></symbol>
  <symbol id="sg-i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="sg-i-chat" viewBox="0 0 24 24"><path d="M4 5h16v11H10l-5 4v-4H4z"/></symbol>
  <symbol id="sg-i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z"/></symbol>
  <symbol id="sg-i-help" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/></symbol>
  <symbol id="sg-i-doc" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></symbol>
  <symbol id="sg-i-box" viewBox="0 0 24 24"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></symbol>
  <symbol id="sg-i-upload" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/></symbol>
  <symbol id="sg-lg-slack" viewBox="0 0 256 256"><path d="M53.841 161.32c0 14.832-11.987 26.82-26.819 26.82S.203 176.152.203 161.32c0-14.831 11.987-26.818 26.82-26.818H53.84zm13.41 0c0-14.831 11.987-26.818 26.819-26.818s26.819 11.987 26.819 26.819v67.047c0 14.832-11.987 26.82-26.82 26.82c-14.83 0-26.818-11.988-26.818-26.82z" fill="#e01e5a"/><path d="M94.07 53.638c-14.832 0-26.82-11.987-26.82-26.819S79.239 0 94.07 0s26.819 11.987 26.819 26.819v26.82zm0 13.613c14.832 0 26.819 11.987 26.819 26.819s-11.987 26.819-26.82 26.819H26.82C11.987 120.889 0 108.902 0 94.069c0-14.83 11.987-26.818 26.819-26.818z" fill="#36c5f0"/><path d="M201.55 94.07c0-14.832 11.987-26.82 26.818-26.82s26.82 11.988 26.82 26.82s-11.988 26.819-26.82 26.819H201.55zm-13.41 0c0 14.832-11.988 26.819-26.82 26.819c-14.831 0-26.818-11.987-26.818-26.82V26.82C134.502 11.987 146.489 0 161.32 0s26.819 11.987 26.819 26.819z" fill="#2eb67d"/><path d="M161.32 201.55c14.832 0 26.82 11.987 26.82 26.818s-11.988 26.82-26.82 26.82c-14.831 0-26.818-11.988-26.818-26.82V201.55zm0-13.41c-14.831 0-26.818-11.988-26.818-26.82c0-14.831 11.987-26.818 26.819-26.818h67.25c14.832 0 26.82 11.987 26.82 26.819s-11.988 26.819-26.82 26.819z" fill="#ecb22e"/></symbol>
  <symbol id="sg-lg-notion" viewBox="0 0 256 268"><path d="M16.092 11.538L164.09.608c18.179-1.56 22.85-.508 34.28 7.801l47.243 33.282C253.406 47.414 256 48.975 256 55.207v182.527c0 11.439-4.155 18.205-18.696 19.24L65.44 267.378c-10.913.517-16.11-1.043-21.825-8.327L8.826 213.814C2.586 205.487 0 199.254 0 191.97V29.726c0-9.352 4.155-17.153 16.092-18.188" fill="#fff"/><path d="M164.09.608L16.092 11.538C4.155 12.573 0 20.374 0 29.726v162.245c0 7.284 2.585 13.516 8.826 21.843l34.789 45.237c5.715 7.284 10.912 8.844 21.825 8.327l171.864-10.404c14.532-1.035 18.696-7.801 18.696-19.24V55.207c0-5.911-2.336-7.614-9.21-12.66l-1.185-.856L198.37 8.409C186.94.1 182.27-.952 164.09.608M69.327 52.22c-14.033.945-17.216 1.159-25.186-5.323L23.876 30.778c-2.06-2.086-1.026-4.69 4.163-5.207l142.274-10.395c11.947-1.043 18.17 3.12 22.842 6.758l24.401 17.68c1.043.525 3.638 3.637.517 3.637L71.146 52.095zm-16.36 183.954V81.222c0-6.767 2.077-9.887 8.3-10.413L230.02 60.93c5.724-.517 8.31 3.12 8.31 9.879v153.917c0 6.767-1.044 12.49-10.387 13.008l-161.487 9.361c-9.343.517-13.489-2.594-13.489-10.921M212.377 89.53c1.034 4.681 0 9.362-4.681 9.897l-7.783 1.542v114.404c-6.758 3.637-12.981 5.715-18.18 5.715c-8.308 0-10.386-2.604-16.609-10.396l-50.898-80.079v77.476l16.1 3.646s0 9.362-12.989 9.362l-35.814 2.077c-1.043-2.086 0-7.284 3.63-8.318l9.351-2.595V109.823l-12.98-1.052c-1.044-4.68 1.55-11.439 8.826-11.965l38.426-2.585l52.958 81.113v-71.76l-13.498-1.552c-1.043-5.733 3.111-9.896 8.3-10.404z" fill="#000"/></symbol>
  <symbol id="sg-lg-google-drive" viewBox="0 0 256 229"><path d="m19.354 196.034l11.29 19.5c2.346 4.106 5.718 7.332 9.677 9.678q17.009-21.591 23.68-33.137q6.77-11.717 16.641-36.655q-26.604-3.502-40.32-3.502q-13.165 0-40.322 3.502c0 4.545 1.173 9.09 3.519 13.196z" fill="#0066da"/><path d="M215.681 225.212c3.96-2.346 7.332-5.572 9.677-9.677l4.692-8.064l22.434-38.855a26.57 26.57 0 0 0 3.518-13.196q-27.315-3.502-40.247-3.502q-13.899 0-40.248 3.502q9.754 25.075 16.422 36.655q6.724 11.683 23.752 33.137" fill="#ea4335"/><path d="M128.001 73.311q19.68-23.768 27.125-36.655q5.996-10.377 13.196-33.137C164.363 1.173 159.818 0 155.126 0h-54.25C96.184 0 91.64 1.32 87.68 3.519q9.16 26.103 15.544 37.154q7.056 12.213 24.777 32.638" fill="#00832d"/><path d="M175.36 155.42H80.642l-40.32 69.792c3.958 2.346 8.503 3.519 13.195 3.519h148.968c4.692 0 9.238-1.32 13.196-3.52z" fill="#2684fc"/><path d="M128.001 73.311L87.681 3.52c-3.96 2.346-7.332 5.571-9.678 9.677L3.519 142.224A26.57 26.57 0 0 0 0 155.42h80.642z" fill="#00ac47"/><path d="m215.242 77.71l-37.243-64.514c-2.345-4.106-5.718-7.331-9.677-9.677l-40.32 69.792l47.358 82.109h80.496c0-4.546-1.173-9.09-3.519-13.196z" fill="#ffba00"/></symbol>
  <symbol id="sg-i-cursor" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#fff" stroke="#14213A" stroke-width="1.6"/></symbol>
</svg>`;

export const SG_MARKUP = `  <section class="sg-card" data-sg="card" role="dialog" aria-modal="true">
    <div class="sg-stage" data-sg="stage">

      <!-- 1. AI 세션 = AI와 일하는 대화창 하나 -->
      <div class="sg-scene" data-sg="s1">
        <div class="sg-p sg-a-pop" style="--x:50%;--y:52%;--d:.05s">
          <div class="sg-gcard sg-app">
            <div class="sg-side">
              <div class="sg-side-h">AI 세션</div>
              <div class="sg-si sg-on"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>법인카드 한도 정리</div>
              <div class="sg-si"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>채용 공고 초안</div>
              <div class="sg-si"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>주간 보고 정리</div>
            </div>
            <div class="sg-chat">
              <div class="sg-chat-h"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>법인카드 한도 정리</div>
              <div class="sg-chat-b">
                <div class="sg-msg sg-me sg-i-rise" style="--d:.5s">법인카드 한도 정리해 줘</div>
                <div class="sg-msg sg-ai sg-i-rise" style="--d:1s">직급별로 3단계예요. 넘으면 팀장 승인이 필요해요.</div>
              </div>
              <div class="sg-frame sg-i-fade" style="--d:1.7s"><span class="sg-fnote">이 대화창 하나 = AI 세션 하나</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 프로젝트 = 한 가지 일을 하는 AI 세션과 파일을 모아 두는 곳 -->
      <div class="sg-scene" data-sg="s2" hidden>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:52%;--d:.05s">
          <div class="sg-gcard sg-proj" style="width:62cqw">
            <div class="sg-proj-h"><span class="sg-fi"><svg class="sg-ic"><use href="#sg-i-folder"/></svg></span><div><small>프로젝트</small><b>법인카드 한도 정리</b></div></div>
            <div class="sg-proj-b" style="grid-template-columns:repeat(2,minmax(0,1fr))">
              <div class="sg-pc"><h4>AI 세션</h4>
                <div class="sg-hit sg-i-pop" style="--d:.6s"><svg class="sg-ic sg-m"><use href="#sg-i-chat"/></svg><span class="sg-t">한도 정리</span></div>
                <div class="sg-hit sg-i-pop" style="--d:.9s"><svg class="sg-ic sg-m"><use href="#sg-i-chat"/></svg><span class="sg-t">예외 승인 절차</span></div></div>
              <div class="sg-pc"><h4>AI가 만든 파일</h4>
                <div class="sg-hit sg-i-pop" style="--d:1.3s"><svg class="sg-ic"><use href="#sg-i-doc"/></svg><span class="sg-t">한도표.xlsx</span></div>
                <div class="sg-hit sg-i-pop" style="--d:1.6s"><svg class="sg-ic"><use href="#sg-i-doc"/></svg><span class="sg-t">팀 공지 초안.md</span></div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 자료 = AI가 읽는 회사의 글과 파일 -->
      <div class="sg-scene" data-sg="s3" hidden>
        <svg class="sg-svgl" viewBox="0 0 100 59.6" preserveAspectRatio="none" aria-hidden="true">
          <path class="sg-d sg-i-draw" pathLength="1" d="M17.6 26 C17.6 34 40 34 42 40.5" style="--d:1.2s;stroke:var(--line);stroke-width:.5"/>
          <path class="sg-d sg-i-draw" pathLength="1" d="M33.8 26 C33.8 34 45 34 46 40.5" style="--d:1.3s;stroke:var(--line);stroke-width:.5"/>
          <path class="sg-d sg-i-draw" pathLength="1" d="M50 26 L50 40.5" style="--d:1.4s;stroke:var(--line);stroke-width:.5"/>
          <path class="sg-d sg-i-draw" pathLength="1" d="M66.2 26 C66.2 34 55 34 54 40.5" style="--d:1.5s;stroke:var(--line);stroke-width:.5"/>
          <path class="sg-d sg-i-draw" pathLength="1" d="M82.4 26 C82.4 34 60 34 58 40.5" style="--d:1.6s;stroke:var(--line);stroke-width:.5"/>
        </svg>
        <div class="sg-p" style="--x:50%;--y:29%">
          <div class="sg-srcs">
            <div class="sg-gcard sg-src sg-i-rise" style="--d:.1s"><svg class="sg-lg sg-big"><use href="#sg-lg-slack"/></svg>슬랙</div>
            <div class="sg-gcard sg-src sg-i-rise" style="--d:.25s"><svg class="sg-lg sg-big"><use href="#sg-lg-notion"/></svg>노션</div>
            <div class="sg-gcard sg-src sg-i-rise" style="--d:.4s"><svg class="sg-lg sg-big"><use href="#sg-lg-google-drive"/></svg>드라이브</div>
            <div class="sg-gcard sg-src sg-i-rise" style="--d:.55s"><svg class="sg-ic sg-big"><use href="#sg-i-upload"/></svg>내가 올린 파일</div>
            <div class="sg-gcard sg-src sg-i-rise" style="--d:.7s"><svg class="sg-ic sg-big"><use href="#sg-i-doc"/></svg>AI가 만든 파일</div>
          </div>
        </div>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:76%;--d:1.8s">
          <div class="sg-gcard sg-pile"><svg class="sg-ic"><use href="#sg-i-box"/></svg><b>자료</b><span>AI가 일할 때 여기서 찾아 읽어요</span></div>
        </div>
      </div>

      <!-- 4. 지식 = AI가 자료를 읽고 정리해 둔 메모 -->
      <div class="sg-scene" data-sg="s4" hidden>
        <div class="sg-p" style="--x:50%;--y:52%">
          <div class="sg-row" style="gap:2.4cqw">
            <div class="sg-col" style="gap:1cqw"><span class="sg-lbl">자료</span>
              <div class="sg-raw" style="width:24cqw">
                <div class="sg-gcard sg-rawi sg-i-rise" style="--d:.1s"><svg class="sg-lg"><use href="#sg-lg-slack"/></svg><span>한도 넘으면 팀장님 승인 받아야 해요~</span></div>
                <div class="sg-gcard sg-rawi sg-i-rise" style="--d:.3s"><svg class="sg-lg"><use href="#sg-lg-notion"/></svg><span>경비 규정 v4 · 3.2 법인카드 사용 한도</span></div>
              </div></div>
            <div class="sg-col sg-i-fade" style="--d:.9s;gap:.6cqw"><span class="sg-lbl">AI가 정리</span><svg class="sg-arrow" viewBox="0 0 40 24"><path d="M2 12h34M28 4l8 8-8 8"/></svg></div>
            <div class="sg-col sg-i-rise" style="--d:1.2s;gap:1cqw"><span class="sg-lbl">지식</span>
              <div class="sg-gcard sg-kdoc" style="width:32cqw">
                <div class="sg-kdoc-h"><svg class="sg-ic"><use href="#sg-i-know"/></svg>지식</div>
                <div class="sg-kdoc-b">
                  <b>법인카드 월 한도</b>
                  <span class="sg-kline">직급별로 3단계, 넘으면 팀장 승인</span>
                  <span class="sg-src"><span class="sg-tag"><svg class="sg-lg"><use href="#sg-lg-notion"/></svg>경비 규정 v4</span><span class="sg-tag"><svg class="sg-lg"><use href="#sg-lg-slack"/></svg>#재무팀</span></span>
                </div>
              </div></div>
          </div>
        </div>
      </div>

      <!-- 5. 누가 볼 수 있나요 (이전 4줄 정리) -->
      <div class="sg-scene" data-sg="s5" hidden>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:50%;--d:.05s">
          <div class="sg-rcap">
            <div class="sg-rrow sg-i-rise" style="--d:.2s"><span class="sg-bd sg-what"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>AI 세션</span><span class="sg-bd sg-priv"><svg class="sg-ic"><use href="#sg-i-lock"/></svg>비공개</span><p>나와 <strong>초대한 사람</strong>만 봐요<br><span class="sg-sub">관리자도 대화 내용은 못 봐요</span></p></div>
            <div class="sg-rrow sg-i-rise" style="--d:.35s" data-sg="r-proj"></div>
            <div class="sg-rrow sg-i-rise" style="--d:.5s"><span class="sg-bd sg-what"><svg class="sg-ic"><use href="#sg-i-box"/></svg>자료</span><span class="sg-bd sg-pub"><svg class="sg-ic"><use href="#sg-i-globe"/></svg>전체 공개</span><p>올린 파일 · AI가 만든 파일은 <strong>팀 전원</strong>이 찾아봐요<br><span class="sg-sub">앱에서 모은 자료는 모을 때 정한 범위만큼</span></p></div>
            <div class="sg-rrow sg-i-rise" style="--d:.65s"><span class="sg-bd sg-what"><svg class="sg-ic"><use href="#sg-i-know"/></svg>지식</span><span class="sg-bd sg-pub"><svg class="sg-ic"><use href="#sg-i-globe"/></svg>전체 공개</span><p>AI가 <strong>정리한 글</strong>을 팀 전원이 봐요<br><span class="sg-sub">닫힌 자료에서 나온 지식은 그 자료를 볼 수 있는 사람만</span></p></div>
          </div>
        </div>
      </div>

      <button type="button" class="sg-replay" data-sg="replay"><svg class="sg-ic"><use href="#sg-i-replay"/></svg>다시 보기</button>
    </div>

    <div class="sg-content">
      <div class="sg-pop" data-sg="pop" role="dialog" aria-label="지식으로 남기지 않는 법" hidden>
        <div class="sg-pop-top">
          <div class="sg-ptabs" role="tablist"><button type="button" role="tab" data-mode="ro" aria-selected="true">읽기 전용</button><button type="button" role="tab" data-mode="ic" aria-selected="false">인코그니토</button></div>
          <button type="button" class="sg-pop-x" data-sg="pop-x" aria-label="닫기">×</button>
        </div>
        <div class="sg-mini-wrap">
          <div class="sg-mini-bar"><span class="sg-dots3" aria-hidden="true"><i></i><i></i><i></i></span>
          <div class="sg-mini-switch" role="tablist" aria-label="어디서 켤까요">
            <button type="button" role="tab" data-where="app" aria-selected="true"><svg class="sg-ic" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="13" rx="2"/><path d="M9 21h6M12 17.5V21"/></svg>라이블리 앱</button>
            <button type="button" role="tab" data-where="term" aria-selected="false"><svg class="sg-ic" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/></svg>터미널</button>
          </div></div>
          <div class="sg-mini" data-sg="mini"></div>
        </div>
        <p class="sg-pop-txt" data-sg="pop-txt"></p>
      </div>
      <div class="sg-dots" data-sg="dots" role="tablist" aria-label="단계"></div>
      <h2 data-sg="title" tabindex="-1"></h2>
      <p class="sg-lead" data-sg="lead"></p>
      <div data-sg="extra" style="display:contents"></div>
      <div class="sg-actions">
        <button type="button" class="sg-btn" data-sg="prev">이전</button>
        <span class="sg-sp"></span>
        <button type="button" class="sg-btn sg-pri" data-sg="next">다음</button>
      </div>
    </div>
  </section>`;
