// v2/share-guide-markup.ts — «누가 무엇을 보나요» 안내 카드의 정적 마크업(#5598).
//  ⚠ 생성물이다 — 원본은 시안 HTML(프로젝트 #5598 share-guide.html)이고, 이름은 전부 sg- 로 감쌌다(54-share-guide.css 와 짝).
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
  <symbol id="sg-i-cursor" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#fff" stroke="#14213A" stroke-width="1.6"/></symbol>
</svg>`;

export const SG_MARKUP = `  <section class="sg-card" data-sg="card" role="dialog" aria-modal="true">
    <div class="sg-stage" data-sg="stage">

      <!-- 1. AI 세션은 비공개 -->
      <div class="sg-scene" data-sg="s1">
        <svg class="sg-svgl" viewBox="0 0 100 59.6" preserveAspectRatio="none" aria-hidden="true">
          <path class="sg-d sg-i-draw" pathLength="1" d="M33.4 23 C37 23 38 25.2 41.8 25.2" style="--d:1.1s;stroke:var(--mine)"/>
        </svg>
        <div class="sg-p sg-a-pop" style="--x:19%;--y:44%;--d:.05s">
          <div class="sg-slist">
            <div class="sg-slist-h"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>AI 세션</div>
            <div class="sg-srow sg-sel sg-i-sel" style="--d:.8s"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">법인카드 한도 정리</span><svg class="sg-ic sg-lk"><use href="#sg-i-lock"/></svg></div>
            <div class="sg-srow"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">채용 공고 초안</span><svg class="sg-ic sg-lk"><use href="#sg-i-lock"/></svg></div>
            <div class="sg-srow"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">주간 보고 정리</span><svg class="sg-ic sg-lk"><use href="#sg-i-lock"/></svg></div>
          </div>
        </div>
        <div class="sg-p sg-a-pop" style="--x:19%;--y:86%;--d:.5s"><span class="sg-pill sg-soft">대화 하나 = AI 세션 하나</span></div>
        <div class="sg-p sg-a-pop" style="--x:63%;--y:52%;--d:1.3s">
          <div class="sg-guard sg-i-ripple" style="--d:2.1s">
            <div class="sg-win" style="--w:39cqw">
              <div class="sg-tab"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">법인카드 한도 정리</span><span class="sg-lockp sg-i-pop" style="--d:1.9s"><svg class="sg-ic"><use href="#sg-i-lock"/></svg>비공개</span></div>
              <div class="sg-win-b">
                <div class="sg-msg sg-me sg-i-rise" style="--d:1.6s">법인카드 한도 정책 정리해 줘</div>
                <div class="sg-msg sg-ai sg-i-rise" style="--d:1.9s">직급별로 세 단계예요. 넘으면 팀장 승인이 필요해요.</div>
              </div>
            </div>
          </div>
        </div>
        <div class="sg-p" style="--x:93%;--y:20%"><div class="sg-av sg-min sg-ghost sg-i-ghost" style="--d:.6s">민</div></div>
        <div class="sg-p" style="--x:94%;--y:50%"><div class="sg-av sg-so sg-ghost sg-i-ghost" style="--d:.8s">소</div></div>
        <div class="sg-p sg-a-mv" style="--x:86%;--y:80%;--x0:97%;--y0:92%;--d:2.8s"><div class="sg-who"><div class="sg-av sg-jun sg-i-light" style="--d:3s">준</div><span class="sg-pill sg-mine sg-i-pop" style="--d:3.5s"><svg class="sg-ic"><use href="#sg-i-plus"/></svg>초대함</span></div></div>
      </div>

      <!-- 2. 프로젝트 — 주: 비공개라 초대받은 사람만 들어온다 · 덧: 들어와도 남이 만든 세션 안은 못 본다 -->
      <div class="sg-scene" data-sg="s2" hidden>
        <svg class="sg-svgl" viewBox="0 0 100 59.6" preserveAspectRatio="none" aria-hidden="true">
          <path class="sg-d sg-i-draw sg-dash2" pathLength="1" d="M57 46.5 C57 41 56.5 37 55.6 33.6" style="--d:4.9s;stroke:var(--bad);stroke-width:.4"/>
          <path class="sg-d sg-i-draw" pathLength="1" d="M68.6 36.2 C63.5 36 60 33.4 56.6 32.8" style="--d:5.6s;stroke:var(--bad);stroke-width:.35;stroke-dasharray:1;opacity:.8"/>
        </svg>
        <div class="sg-pzone sg-i-fade" style="left:4%;top:16%;width:62%;height:80%;--d:.05s"><div class="sg-pzone-r sg-i-ripple" style="--d:4s"></div>
          <span class="sg-pz-l" data-sg="pz-label"><svg class="sg-ic"><use href="#sg-i-lock"/></svg>비공개 · 초대받은 사람만 들어와요</span></div>
        <div class="sg-p sg-a-pop" style="--x:35%;--y:55%;--d:.15s">
          <div class="sg-proj">
            <div class="sg-proj-h"><span class="sg-fi"><svg class="sg-ic"><use href="#sg-i-folder"/></svg></span><div><small>프로젝트</small><b>법인카드 정책</b></div><span class="sg-sp"></span>
              <span class="sg-mems"><span class="sg-av sg-me-av" style="--s:4.4cqw">나</span><span class="sg-av sg-jun sg-i-pop" style="--s:4.4cqw;--d:4.1s">준</span></span></div>
            <div class="sg-proj-b"><div class="sg-slot"></div><div class="sg-slot"></div></div>
          </div>
        </div>
        <div class="sg-p sg-a-pop" style="--x:35%;--y:55%;--d:.4s"><div class="sg-sess"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">법인카드 한도 정리</span><small>내 세션</small><svg class="sg-ic sg-lk sg-bad-lk sg-i-shake" style="--d:5.4s"><use href="#sg-i-lock"/></svg></div></div>
        <div class="sg-p sg-a-fly" style="--x:35%;--y:67.3%;--x0:-14%;--y0:67.3%;--d:.8s;--d2:.9s"><div class="sg-sess"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">예외 승인 절차</span><small>내 세션</small><svg class="sg-ic sg-lk"><use href="#sg-i-lock"/></svg></div></div>

        <div class="sg-p" style="--x:86%;--y:22%"><div class="sg-av sg-min sg-ghost sg-i-ghost" style="--d:.5s">민</div></div>
        <div class="sg-p" style="--x:90%;--y:84%"><div class="sg-av sg-so sg-ghost sg-i-ghost" style="--d:.7s">소</div></div>
        <div class="sg-p sg-a-mv" style="--x:84%;--y:50%;--x0:47%;--y0:28%;--d:1.7s"><span class="sg-pill sg-mine sg-inv sg-i-blip" style="--d:1.5s;opacity:0"><svg class="sg-ic"><use href="#sg-i-plus"/></svg>초대</span></div>
        <div class="sg-p sg-a-mv" style="--x:57%;--y:85%;--x0:84%;--y0:50%;--d:3.1s"><div class="sg-av sg-jun sg-i-light" style="--d:2.6s">준</div></div>
        <div class="sg-p sg-a-pop" style="--x:44%;--y:85%;--d:4.3s"><span class="sg-pill sg-mine"><svg class="sg-ic"><use href="#sg-i-check"/></svg>프로젝트 팀원</span></div>

        <div class="sg-p sg-a-pop" style="--x:83%;--y:61%;--d:5.5s"><div class="sg-note2"><b>＋</b><span>초대받아도<br><strong>남이 만든 세션 안</strong>은<br>못 봐요</span></div></div>
      </div>

      <!-- 3. 지식 -->
      <div class="sg-scene" data-sg="s3" hidden>
        <svg class="sg-svgl" viewBox="0 0 100 59.6" preserveAspectRatio="none" aria-hidden="true">
          <path class="sg-d sg-i-draw" pathLength="1" d="M57.6 36.8 C59 36.8 59.2 33 61.2 31.5" style="--d:2.9s;stroke:var(--team);stroke-width:.5"/>
        </svg>
        <div class="sg-p sg-a-pop" style="--x:21%;--y:50%;--d:.05s">
          <div class="sg-win" style="--w:35cqw">
            <div class="sg-tab"><svg class="sg-ic"><use href="#sg-i-chat"/></svg><span class="sg-t">AI 세션</span><span class="sg-lockp"><svg class="sg-ic"><use href="#sg-i-lock"/></svg>비공개</span></div>
            <div class="sg-win-b">
              <div class="sg-msg sg-me sg-i-rise" style="--d:.3s">법카 한도 몇이었지? 대충 정리 좀 ㅋㅋ</div>
              <div class="sg-msg sg-ai sg-i-rise" style="--d:.6s">사내 문서 세 곳을 찾아봤어요. 직급별 3단계예요.</div>
              <div class="sg-msg sg-me sg-i-rise" style="--d:.9s">오 땡큐, 팀장님한테 묻기 애매했는데</div>
            </div>
          </div>
        </div>
        <div class="sg-p sg-a-fly" style="--x:50%;--y:30%;--x0:36%;--y0:36%;--d:1.4s;--d2:1.4s"><span class="sg-chip sg-no sg-i-strike" style="--d:2.2s"><svg class="sg-ic"><use href="#sg-i-x"/></svg>내 질문 원문</span></div>
        <div class="sg-p sg-a-fly" style="--x:50%;--y:46%;--x0:36%;--y0:50%;--d:1.55s;--d2:1.55s"><span class="sg-chip sg-no sg-i-strike" style="--d:2.35s"><svg class="sg-ic"><use href="#sg-i-x"/></svg>잡담 · 말투</span></div>
        <div class="sg-p sg-a-fly" style="--x:50%;--y:62%;--x0:36%;--y0:62%;--d:1.7s;--d2:1.7s"><span class="sg-chip sg-yes"><svg class="sg-ic"><use href="#sg-i-check"/></svg>결론 · 근거</span></div>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:13%;--d:1.2s"><span class="sg-pill sg-soft"><svg class="sg-ic"><use href="#sg-i-know"/></svg>AI가 다시 써요</span></div>
        <div class="sg-p sg-a-pop" style="--x:79%;--y:44%;--d:3.1s">
          <div class="sg-kdoc">
            <div class="sg-kdoc-h"><svg class="sg-ic"><use href="#sg-i-know"/></svg>지식<span class="sg-sp"></span><span class="sg-lockp sg-pub"><svg class="sg-ic"><use href="#sg-i-globe"/></svg>전체 공개</span></div>
            <div class="sg-kdoc-b">
              <b class="sg-i-rise" style="--d:3.4s">법인카드 월 한도 기준</b>
              <div class="sg-kf sg-i-rise" style="--d:3.6s"><span>요약</span><span>직급별 월 한도는 3단계이며, 넘으면 팀장 승인이 필요하다.</span></div>
              <div class="sg-kf sg-i-rise" style="--d:3.8s"><span>근거</span><span>재무 규정 v4 외 사내 문서 3건</span></div>
              <div class="sg-kf sg-i-rise" style="--d:4s"><span>정리</span><span>AI · 2026-11-20</span></div>
            </div>
          </div>
        </div>
        <div class="sg-p" style="--x:70%;--y:86%"><div class="sg-av sg-min sg-i-light" style="--s:5.6cqw;--d:4.3s">민</div></div>
        <div class="sg-p" style="--x:77%;--y:86%"><div class="sg-av sg-jun sg-i-light" style="--s:5.6cqw;--d:4.4s">준</div></div>
        <div class="sg-p" style="--x:84%;--y:86%"><div class="sg-av sg-so sg-i-light" style="--s:5.6cqw;--d:4.5s">소</div></div>
        <div class="sg-p sg-a-pop" style="--x:93%;--y:86%;--d:4.6s"><span class="sg-pill sg-team">팀 전원</span></div>
      </div>

      <!-- 4. 쓰다가 라이블리 끄기 -->
      <div class="sg-scene" data-sg="s4" hidden>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:55%;--d:.05s">
          <div class="sg-twin">
            <div class="sg-twin-h"><i></i><i></i><i></i><span class="sg-t">claude — 법인카드 한도 정리</span>
              <span class="sg-lvst"><span class="sg-on sg-i-out" style="--d:2.7s;opacity:0"><i></i>라이블리 켜짐</span><span class="sg-off sg-i-pop" style="--d:2.8s"><i></i>라이블리 꺼짐</span></span>
            </div>
            <div class="sg-twin-b">
              <div class="sg-tl sg-u sg-i-fade" style="--d:.3s">&gt; 법인카드 한도 정리해 줘</div>
              <div class="sg-tl sg-i-fade" style="--d:.6s">⏺ 정리했어요. 직급별 3단계예요.</div>
              <div class="sg-tl sg-u sg-i-type" style="--d:1.2s">&gt; /lively-disconnect</div>
              <div class="sg-tl sg-t sg-i-fade" style="--d:2.4s">  [라이블리] 이 세션에서 껐어요 · 다시 켜려면 /lively-connect</div>
              <div class="sg-tl sg-u sg-i-fade" style="--d:3.4s">&gt; 개인 일정 메모 좀 정리해 줘<span class="sg-tag-off">기록 안 됨</span></div>
              <div class="sg-tl sg-d sg-i-fade" style="--d:3.8s">⏺ 정리했어요. (회사 맥락 없이 답함)</div>
              <div class="sg-tl sg-u sg-i-fade" style="--d:4.1s">&gt; <span class="sg-caret"></span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. 한눈에 -->
      <div class="sg-scene" data-sg="s5" hidden>
        <div class="sg-p sg-a-pop" style="--x:50%;--y:50%;--d:.05s">
          <div class="sg-rcap">
            <div class="sg-rrow sg-i-rise" style="--d:.2s"><span class="sg-bd sg-what"><svg class="sg-ic"><use href="#sg-i-chat"/></svg>AI 세션</span><span class="sg-bd sg-priv"><svg class="sg-ic"><use href="#sg-i-lock"/></svg>비공개</span><p>나와 <strong>초대한 사람</strong>만 봐요</p></div>
            <div class="sg-rrow sg-i-rise" style="--d:.35s" data-sg="r-proj"></div>
            <div class="sg-rrow sg-i-rise" style="--d:.5s"><span class="sg-bd sg-what"><svg class="sg-ic"><use href="#sg-i-know"/></svg>지식</span><span class="sg-bd sg-pub"><svg class="sg-ic"><use href="#sg-i-globe"/></svg>전체 공개</span><p>AI가 <strong>정리한 글</strong>만 팀에 자동 공유돼요</p></div>
          </div>
        </div>
      </div>

      <div class="sg-badges" data-sg="badges" aria-live="polite"></div>
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
