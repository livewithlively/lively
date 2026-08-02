(() => {
  // web/standalone/page-scrollbar.ts
  (function() {
    function init() {
      if (document.querySelector(".page-scroll")) return;
      var bar = document.createElement("div");
      bar.className = "page-scroll";
      var thumb = document.createElement("div");
      thumb.className = "page-scroll-thumb";
      bar.appendChild(thumb);
      document.body.appendChild(bar);
      var BOT = 8;
      var topbar = document.querySelector(".topbar");
      var scroller = document.scrollingElement || document.documentElement;
      var hideT = 0, raf = 0, dragging = false, startY = 0, startTop = 0;
      function topOff() {
        return (topbar ? topbar.getBoundingClientRect().height : 64) + 6;
      }
      function metrics() {
        var sh = scroller.scrollHeight, vh = window.innerHeight;
        var st = scroller.scrollTop || window.scrollY || 0;
        return { sh, vh, st, top: topOff(), trackH: vh - topOff() - BOT };
      }
      function update() {
        raf = 0;
        var m = metrics();
        if (m.sh <= m.vh + 2 || m.trackH < 40) {
          bar.classList.remove("on", "act");
          return;
        }
        bar.classList.add("on");
        bar.style.top = m.top + "px";
        bar.style.height = m.trackH + "px";
        var thumbH = Math.max(28, m.trackH * m.vh / m.sh);
        var maxY = m.trackH - thumbH;
        var y = m.sh - m.vh > 0 ? m.st / (m.sh - m.vh) * maxY : 0;
        thumb.style.height = thumbH + "px";
        thumb.style.transform = "translateY(" + Math.max(0, Math.min(maxY, y)) + "px)";
      }
      function schedule() {
        if (!raf) raf = requestAnimationFrame(update);
      }
      function activate() {
        schedule();
        bar.classList.add("act");
        clearTimeout(hideT);
        hideT = setTimeout(function() {
          if (!dragging) bar.classList.remove("act");
        }, 1e3);
      }
      window.addEventListener("scroll", function() {
        schedule();
        activate();
      }, { passive: true });
      window.addEventListener("resize", schedule);
      window.addEventListener("hashchange", function() {
        setTimeout(schedule, 60);
      });
      var view = document.getElementById("view");
      if (view && "MutationObserver" in window) {
        new MutationObserver(schedule).observe(view, { childList: true, subtree: true });
      }
      thumb.addEventListener("pointerdown", function(e) {
        dragging = true;
        startY = e.clientY;
        startTop = scroller.scrollTop || window.scrollY || 0;
        bar.classList.add("act");
        if (thumb.setPointerCapture) thumb.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      window.addEventListener("pointermove", function(e) {
        if (!dragging) return;
        var m = metrics();
        var thumbH = Math.max(28, m.trackH * m.vh / m.sh);
        var maxY = m.trackH - thumbH;
        if (maxY <= 0) return;
        scroller.scrollTop = startTop + (e.clientY - startY) / maxY * (m.sh - m.vh);
        schedule();
      });
      window.addEventListener("pointerup", function() {
        if (dragging) {
          dragging = false;
          activate();
        }
      });
      thumb.addEventListener("pointerenter", function() {
        bar.classList.add("act");
        clearTimeout(hideT);
      });
      thumb.addEventListener("pointerleave", function() {
        if (!dragging) {
          clearTimeout(hideT);
          hideT = setTimeout(function() {
            bar.classList.remove("act");
          }, 500);
        }
      });
      update();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  })();
})();
