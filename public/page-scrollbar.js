// 페이지(루트) 오버레이 스크롤바 (#756) — 네이티브 루트 스크롤바는 CSS 로 숨겨(레이아웃 밀림 0) 홈을 전폭으로
// 유지하고, 콘텐츠 위에 '겹쳐 뜨는' 얇은 막대로 스크롤 위치를 표시한다. 내부 스크롤러(사이드바·모달 등)는
// 손대지 않는다(자체 스크롤바 유지). 순수 JS(빌드 불필요) — index.html 이 defer 로 로드.
(function () {
  function init() {
    if (document.querySelector('.page-scroll')) return;
    var bar = document.createElement('div'); bar.className = 'page-scroll';
    var thumb = document.createElement('div'); thumb.className = 'page-scroll-thumb';
    bar.appendChild(thumb); document.body.appendChild(bar);
    var BOT = 8;                                              // 트랙 하단 여백
    var topbar = document.querySelector('.topbar');
    var scroller = document.scrollingElement || document.documentElement;
    var hideT = 0, raf = 0, dragging = false, startY = 0, startTop = 0;

    // 트랙 시작 = 상단바(스티키) 아래. 상단바는 좁은 화면에서 2줄로 높아지므로 실제 높이를 매번 잰다.
    function topOff() { return (topbar ? topbar.getBoundingClientRect().height : 64) + 6; }
    function metrics() {
      var sh = scroller.scrollHeight, vh = window.innerHeight;
      var st = scroller.scrollTop || window.scrollY || 0;
      return { sh: sh, vh: vh, st: st, top: topOff(), trackH: vh - topOff() - BOT };
    }
    function update() {
      raf = 0;
      var m = metrics();
      if (m.sh <= m.vh + 2 || m.trackH < 40) { bar.classList.remove('on', 'act'); return; }
      bar.classList.add('on');
      bar.style.top = m.top + 'px';
      bar.style.height = m.trackH + 'px';
      var thumbH = Math.max(28, m.trackH * m.vh / m.sh);
      var maxY = m.trackH - thumbH;
      var y = (m.sh - m.vh) > 0 ? (m.st / (m.sh - m.vh)) * maxY : 0;
      thumb.style.height = thumbH + 'px';
      thumb.style.transform = 'translateY(' + Math.max(0, Math.min(maxY, y)) + 'px)';
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(update); }
    function activate() {
      schedule(); bar.classList.add('act');
      clearTimeout(hideT);
      hideT = setTimeout(function () { if (!dragging) bar.classList.remove('act'); }, 1000);
    }

    window.addEventListener('scroll', function () { schedule(); activate(); }, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', function () { setTimeout(schedule, 60); });
    var view = document.getElementById('view');
    if (view && 'MutationObserver' in window) {
      new MutationObserver(schedule).observe(view, { childList: true, subtree: true });
    }

    // 드래그 — 네이티브 막대가 없으니 마우스 사용자를 위해 커스텀 썸을 끌 수 있게.
    thumb.addEventListener('pointerdown', function (e) {
      dragging = true; startY = e.clientY; startTop = scroller.scrollTop || window.scrollY || 0;
      bar.classList.add('act');
      if (thumb.setPointerCapture) thumb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var m = metrics();
      var thumbH = Math.max(28, m.trackH * m.vh / m.sh);
      var maxY = m.trackH - thumbH;
      if (maxY <= 0) return;
      scroller.scrollTop = startTop + (e.clientY - startY) / maxY * (m.sh - m.vh);
      schedule();
    });
    window.addEventListener('pointerup', function () { if (dragging) { dragging = false; activate(); } });
    thumb.addEventListener('pointerenter', function () { bar.classList.add('act'); clearTimeout(hideT); });
    thumb.addEventListener('pointerleave', function () {
      if (!dragging) { clearTimeout(hideT); hideT = setTimeout(function () { bar.classList.remove('act'); }, 500); }
    });

    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
