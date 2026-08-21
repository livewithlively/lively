'use strict';
(() => {
  // web/standalone/md.ts
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function safeHref(raw) {
    const url = String(raw).trim();
    if (!url) return null;
    if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return url;
    if (url.startsWith("//")) return url;
    const stripped = url.replace(/[\x00-\x1f\x7f]/g, "");
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
    if (m) {
      const scheme = m[1].toLowerCase();
      if (scheme === "http" || scheme === "https" || scheme === "mailto") return url;
      return null;
    }
    return url;
  }
  function mdImage(src, alt) {
    const img = el("img", { class: "md-img", alt: alt || "", loading: "lazy" });
    if (!String(src).startsWith("/api/ui/")) {
      img.setAttribute("src", src);
      return img;
    }
    let token = null;
    try {
      token = localStorage.getItem("lively_ui_token");
    } catch (_) {
    }
    fetch(src, { headers: token ? { Authorization: "Bearer " + token } : {} }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    }).then((b) => {
      img.src = URL.createObjectURL(b);
    }).catch(() => {
      img.classList.add("md-img-missing");
      img.alt = (alt || "\uC774\uBBF8\uC9C0") + " (\uBD88\uB7EC\uC624\uAE30 \uC2E4\uD328)";
    });
    return img;
  }
  function renderInline(text) {
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) {
        out.push(document.createTextNode(buf));
        buf = "";
      }
    };
    const s = text;
    let i = 0;
    const paired = (mark, make) => {
      const prev = i > 0 ? s[i - 1] : "";
      if (prev && /[A-Za-z0-9]/.test(prev)) return false;
      const end = s.indexOf(mark, i + 2);
      if (end > i + 2 && s[i + 2] !== " " && s[end - 1] !== " ") {
        flush();
        out.push(make(s.slice(i + 2, end)));
        i = end + 2;
        return true;
      }
      return false;
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i) {
          flush();
          out.push(el("code", { class: "md-code", text: s.slice(i + 1, end) }));
          i = end + 1;
          continue;
        }
      }
      if (ch === "!" && s[i + 1] === "[") {
        const close = s.indexOf("]", i + 2);
        if (close > i && s[close + 1] === "(") {
          const paren = s.indexOf(")", close + 2);
          if (paren > close) {
            const alt = s.slice(i + 2, close);
            const src = safeHref(s.slice(close + 2, paren));
            flush();
            if (src) out.push(mdImage(src, alt));
            else if (alt) out.push(document.createTextNode(alt));
            i = paren + 1;
            continue;
          }
        }
      }
      if (ch === "*" && s[i + 1] === "*") {
        const end = s.indexOf("**", i + 2);
        if (end > i + 1) {
          flush();
          out.push(el("strong", {}, ...renderInline(s.slice(i + 2, end))));
          i = end + 2;
          continue;
        }
      }
      if (ch === "~" && s[i + 1] === "~" && paired("~~", (t) => el("del", { class: "md-del" }, ...renderInline(t)))) continue;
      if (ch === "+" && s[i + 1] === "+" && paired("++", (t) => el("u", { class: "md-u" }, ...renderInline(t)))) continue;
      if (ch === "=" && s[i + 1] === "=" && paired("==", (t) => el("mark", { class: "md-mark" }, ...renderInline(t)))) continue;
      if (ch === "*" && s[i + 1] !== "*" && s[i + 1] !== " " && s[i + 1] !== void 0) {
        const end = s.indexOf("*", i + 1);
        if (end > i && s[end - 1] !== " ") {
          flush();
          out.push(el("em", {}, ...renderInline(s.slice(i + 1, end))));
          i = end + 1;
          continue;
        }
      }
      if (ch === "[") {
        const close = s.indexOf("]", i + 1);
        if (close > i && s[close + 1] === "(") {
          const paren = s.indexOf(")", close + 2);
          if (paren > close) {
            const label = s.slice(i + 1, close);
            const href = safeHref(s.slice(close + 2, paren));
            flush();
            if (href) out.push(el("a", { class: "md-link", href, rel: "noopener noreferrer nofollow", target: "_blank" }, ...renderInline(label)));
            else out.push(...renderInline(label));
            i = paren + 1;
            continue;
          }
        }
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  }
  function mdParseContainerAttrs(rest) {
    const attrs = {};
    let summary = "";
    for (const tok of String(rest || "").split(/\s+/)) {
      const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
      if (m && summary === "") attrs[m[1]] = m[2];
      else summary += (summary ? " " : "") + tok;
    }
    return { attrs, summary: summary.trim() };
  }
  function mdRenderContainer(type, rest, bodyLines) {
    const { attrs, summary } = mdParseContainerAttrs(rest);
    const inner = () => renderMarkdown(bodyLines.join("\n"));
    const move = (from, to) => {
      while (from.firstChild) to.append(from.firstChild);
      return to;
    };
    switch (type) {
      case "toggle":
      case "template": {
        const det = el(
          "details",
          { class: "md-toggle" },
          el("summary", { class: "md-toggle-sum" }, ...renderInline(summary || rest || "\uD3BC\uCE58\uAE30"))
        );
        return move(inner(), det);
      }
      case "callout": {
        const color = String(attrs.color || "").replace(/_background$/, "") || "default";
        const box = el("div", { class: "md-callout md-callout-" + color.replace(/[^a-z]/g, "") });
        if (attrs.icon) box.append(el("span", { class: "md-callout-ic", "aria-hidden": "true", text: attrs.icon }));
        box.append(move(inner(), el("div", { class: "md-callout-body" })));
        return box;
      }
      case "columns": {
        const row = el("div", { class: "md-columns" });
        const rendered = inner();
        while (rendered.firstChild) row.append(rendered.firstChild);
        return row;
      }
      case "column": {
        const col = el("div", { class: "md-column" });
        const ratio = Number(attrs.ratio);
        if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) col.style.flex = String(ratio) + " 1 0";
        return move(inner(), col);
      }
      case "synced": {
        const box = el("div", { class: "md-synced" });
        box.append(el("span", { class: "md-block-chip", text: "\u21BB \uB3D9\uAE30\uD654 \uBE14\uB85D" }));
        if (attrs.missing === "true") box.append(el("div", { class: "md-synced-missing", text: "\uC6D0\uBCF8 \uBE14\uB85D\uC774 \uACF5\uC720 \uBC94\uC704 \uBC16\uC774\uB77C \uB0B4\uC6A9\uC744 \uAC00\uC838\uC62C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }));
        else box.append(move(inner(), el("div", { class: "md-synced-body" })));
        return box;
      }
      case "toc":
        return el("div", { class: "md-block-chip md-toc", text: "\uBAA9\uCC28 (\uC6D0\uBCF8 \uBB38\uC11C\uC758 \uBAA9\uCC28 \uBE14\uB85D)" });
      case "unsupported":
        return el("div", {
          class: "md-block-chip md-unsup",
          title: attrs.id ? "block " + attrs.id : "",
          text: "\uC9C0\uC6D0\uB418\uC9C0 \uC54A\uB294 \uBE14\uB85D" + (attrs.type ? ": " + attrs.type : "")
        });
      default:
        return inner();
    }
  }
  function renderMarkdown(md) {
    const root = el("div", { class: "md" });
    const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf("-") >= 0;
    const splitRow = (l) => {
      let t = l.trim();
      if (t.startsWith("|")) t = t.slice(1);
      if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
      const cells = [];
      let cur = "";
      for (let j = 0; j < t.length; j++) {
        const ch = t[j];
        if (ch === "\\" && t[j + 1] === "|") {
          cur += "|";
          j++;
          continue;
        }
        if (ch === "|") {
          cells.push(cur.trim());
          cur = "";
          continue;
        }
        cur += ch;
      }
      cells.push(cur.trim());
      return cells;
    };
    const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
    const contClose = (l) => l.trim() === ":::";
    while (i < lines.length) {
      let line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }
      const cont = /^:::\s*([a-zA-Z_-]+)\s*(.*)$/.exec(line);
      if (cont) {
        const body = [];
        let depth = 1;
        let inFence = false;
        i++;
        while (i < lines.length && depth > 0) {
          const l = lines[i];
          if (/^(```|~~~)/.test(l)) inFence = !inFence;
          else if (!inFence && contOpen(l)) depth++;
          else if (!inFence && contClose(l)) {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          body.push(l);
          i++;
        }
        root.append(mdRenderContainer(cont[1], cont[2], body));
        continue;
      }
      if (contClose(line)) {
        i++;
        continue;
      }
      if (line.trim() === "$$") {
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "$$") {
            close = j;
            break;
          }
        }
        if (close >= 0) {
          root.append(el("pre", { class: "md-eq", title: "LaTeX" }, el("code", { text: lines.slice(i + 1, close).join("\n") })));
          i = close + 1;
          continue;
        }
        root.append(el("p", { class: "md-p", text: "$$" }));
        i++;
        continue;
      }
      const fence = /^(```|~~~)(.*)$/.exec(line);
      if (fence) {
        const marker = fence[1];
        const code = [];
        i++;
        while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) {
          code.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        root.append(el("pre", { class: "md-pre" }, el("code", { text: code.join("\n") })));
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        root.append(el("hr", { class: "md-hr" }));
        i++;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const lvl = h[1].length;
        root.append(el("h" + lvl, { class: "md-h md-h" + lvl }, ...renderInline(h[2].trim())));
        i++;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        const inner = renderMarkdown(quote.join("\n"));
        const bq = el("blockquote", { class: "md-quote" });
        while (inner.firstChild) bq.append(inner.firstChild);
        root.append(bq);
        continue;
      }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() !== "" && lines[i].indexOf("|") >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const headerEmpty = header.every((c) => !c);
        const table = el("table", { class: "md-table" });
        if (!headerEmpty) {
          const thead = el("thead");
          const htr = el("tr");
          for (const c of header) htr.append(el("th", {}, ...renderInline(c)));
          thead.append(htr);
          table.append(thead);
        }
        const tbody = el("tbody");
        for (const r of rows) {
          const tr = el("tr");
          for (let c = 0; c < header.length; c++) tr.append(el("td", {}, ...renderInline(r[c] || "")));
          tbody.append(tr);
        }
        table.append(tbody);
        root.append(table);
        continue;
      }
      const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
      const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
      if (bulletRe.test(line) || orderedRe.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const bm = bulletRe.exec(l);
          const om = bm ? null : orderedRe.exec(l);
          if (bm || om) {
            const m = bm || om;
            const level = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
            let text = m[3];
            let checked = null;
            if (bm) {
              const cb = /^\[( |x|X)\]\s+(.*)$/.exec(text);
              if (cb) {
                checked = cb[1] !== " ";
                text = cb[2];
              }
            }
            items.push({ level, ordered: !!om, num: om ? Number(om[2]) : 0, checked, text });
            i++;
            continue;
          }
          if (l.trim() !== "" && /^\s+/.test(l) && items.length) {
            items[items.length - 1].text += " " + l.trim();
            i++;
            continue;
          }
          break;
        }
        const build = (idx2, level) => {
          const first = items[idx2];
          const list = el(first.ordered ? "ol" : "ul", { class: "md-list" });
          if (first.ordered && first.num > 1) list.setAttribute("start", String(first.num));
          let j = idx2;
          while (j < items.length && items[j].level >= level) {
            if (items[j].level > level) {
              const sub = build(j, items[j].level);
              (list.lastChild || list).append(sub.node);
              j = sub.next;
              continue;
            }
            if (items[j].ordered !== first.ordered) break;
            const it = items[j];
            const li = el("li", {});
            if (it.checked != null) {
              const cb = el("input", { type: "checkbox", class: "md-check", tabindex: "-1", "aria-hidden": "true" });
              cb.disabled = true;
              cb.checked = it.checked;
              li.classList.add("md-task");
              if (it.checked) li.classList.add("md-task-done");
              li.append(cb);
            }
            for (const n of renderInline(it.text)) li.append(n);
            list.append(li);
            j++;
          }
          return { node: list, next: j };
        };
        let idx = 0;
        while (idx < items.length) {
          const r = build(idx, items[idx].level);
          root.append(r.node);
          idx = r.next;
        }
        continue;
      }
      const para = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") break;
        if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) || /^(\s*)(\d+)[.)]\s+/.test(l) || contOpen(l) || contClose(l) || l.trim() === "$$" || l.indexOf("|") >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1])) break;
        para.push(l);
        i++;
      }
      const p = el("p", { class: "md-p" });
      para.forEach((l, idx) => {
        if (idx > 0) p.append(el("br"));
        for (const n of renderInline(l)) p.append(n);
      });
      root.append(p);
    }
    return root;
  }

  // web/standalone/terminal.ts
  function urlAtColumn(lineText, col) {
    const re = /(https?:\/\/[^\s"'<>\u3000]+|(?:www\.|(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}\/)[^\s"'<>\u3000]*)/gi;
    for (let m = re.exec(lineText); m; m = re.exec(lineText)) {
      if (col >= m.index && col < m.index + m[0].length) {
        const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
        if (!raw) return null;
        return /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
      }
    }
    return null;
  }
  function openLinkFromTerminal(uri) {
    try {
      const u = new URL(uri, location.href);
      const uiPath = location.pathname.replace(/terminal(?:-grid)?\.html$/, "");
      if (u.origin === location.origin && u.pathname === uiPath && u.hash && window.parent !== window) {
        window.parent.location.hash = u.hash;
        return;
      }
      if (u.origin === location.origin && /\/preview\/[^/]+\//.test(u.pathname) && window.parent !== window) {
        let taken = false;
        const ack = (e) => {
          if (e.data && e.data.type === "lively:open-in-pane:ok") taken = true;
        };
        window.addEventListener("message", ack);
        window.parent.postMessage({ type: "lively:open-in-pane", url: u.href }, location.origin);
        window.setTimeout(() => {
          window.removeEventListener("message", ack);
          if (!taken) window.open(uri, "_blank", "noopener");
        }, 400);
        return;
      }
    } catch (_) {
    }
    window.open(uri, "_blank", "noopener");
  }
  var TOKEN_KEY = "lively_ui_token";
  var PREFS_KEY = "lively_term_prefs";
  var SESSION_ID = new URLSearchParams(location.search).get("session") || "";
  var SESSION_LABEL = new URLSearchParams(location.search).get("label") || "";
  var NODE_ID = new URLSearchParams(location.search).get("node") || "";
  var RESTORED = new URLSearchParams(location.search).get("restored") === "1";
  var EMBED = new URLSearchParams(location.search).get("embed") === "1";
  var nodeQ = (joiner) => NODE_ID ? joiner + "node=" + encodeURIComponent(NODE_ID) : "";
  var FONTS = [
    { v: "'JetBrains Mono', 'D2Coding', monospace", label: "JetBrains Mono" },
    { v: "'D2Coding', monospace", label: "D2Coding \xB7 \uD55C\uAE00 \uCF54\uB529" },
    { v: "'Fira Code', 'D2Coding', monospace", label: "Fira Code" },
    { v: "'Source Code Pro', 'D2Coding', monospace", label: "Source Code Pro" },
    { v: "'IBM Plex Mono', 'D2Coding', monospace", label: "IBM Plex Mono" },
    { v: "'Roboto Mono', 'D2Coding', monospace", label: "Roboto Mono" },
    { v: "Menlo, 'D2Coding', monospace", label: "Menlo" },
    { v: "'SF Mono', SFMono-Regular, 'D2Coding', monospace", label: "SF Mono" },
    { v: "Monaco, 'D2Coding', monospace", label: "Monaco" },
    { v: "Consolas, 'D2Coding', monospace", label: "Consolas" }
  ];
  var ANSI_DARK = {
    black: "#2B3549",
    red: "#F07E7E",
    green: "#37B592",
    yellow: "#F0A32B",
    blue: "#6E9AF8",
    magenta: "#A29AE8",
    cyan: "#3EC4C6",
    white: "#B0BDD5",
    brightBlack: "#74839F",
    brightRed: "#F6B3AB",
    brightGreen: "#43E5B0",
    brightYellow: "#F0C97E",
    brightBlue: "#8FB2FA",
    brightMagenta: "#C0B8FF",
    brightCyan: "#6FE0E2",
    brightWhite: "#EAF0FA"
  };
  var ANSI_LIGHT = {
    black: "#15233B",
    red: "#C7443F",
    green: "#0F7A5F",
    yellow: "#8A5A00",
    blue: "#2453C7",
    magenta: "#6C4FB8",
    cyan: "#0E6E70",
    white: "#5A6B85",
    brightBlack: "#64728A",
    brightRed: "#B84E44",
    brightGreen: "#0A805F",
    brightYellow: "#6B4E00",
    brightBlue: "#2D6BF0",
    brightMagenta: "#5B4FA8",
    brightCyan: "#12797B",
    brightWhite: "#15233B"
  };
  var APP_DARK = Object.assign({ background: "#111726", foreground: "#EAF0FA", cursor: "#43E5B0", selectionBackground: "#2B3B5C" }, ANSI_DARK);
  var APP_LIGHT = Object.assign({ background: "#FFFFFF", foreground: "#15233B", cursor: "#2D6BF0", selectionBackground: "#CFE0F7" }, ANSI_LIGHT);
  var THEMES = {
    auto: { name: "\uC571 \uD14C\uB9C8 \uB530\uB984", auto: true },
    dark: { name: "\uB2E4\uD06C", dark: true, theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", selectionBackground: "#585b70" } },
    light: { name: "\uB77C\uC774\uD2B8", dark: false, theme: { background: "#fdfdfd", foreground: "#2a2a2a", cursor: "#5566ff", selectionBackground: "#cfe3ff" } },
    dracula: { name: "Dracula", dark: true, theme: { background: "#282a36", foreground: "#f8f8f2", cursor: "#ff79c6", selectionBackground: "#44475a" } },
    solarized: { name: "Solarized Dark", dark: true, theme: { background: "#002b36", foreground: "#93a1a1", cursor: "#cb4b16", selectionBackground: "#073642" } },
    nord: { name: "Nord", dark: true, theme: { background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", selectionBackground: "#434c5e" } },
    github: { name: "GitHub Light", dark: false, theme: { background: "#ffffff", foreground: "#24292f", cursor: "#0969da", selectionBackground: "#b6e3ff" } }
  };
  function appIsDark() {
    try {
      const p = localStorage.getItem("lv:theme");
      if (p === "dark") return true;
      if (p === "light") return false;
    } catch (_) {
    }
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function resolveTheme(key) {
    const t = THEMES[key] || THEMES.auto;
    if (t.auto) return appIsDark() ? APP_DARK : APP_LIGHT;
    return t.theme;
  }
  function themeIsDark(key) {
    const t = THEMES[key] || THEMES.auto;
    return t.auto ? appIsDark() : !!t.dark;
  }
  function withKR(ff) {
    ff = String(ff || FONTS[0].v);
    if (/D2Coding/i.test(ff)) return ff;
    if (/,?\s*monospace\s*$/i.test(ff)) return ff.replace(/,?\s*monospace\s*$/i, ", 'D2Coding', monospace");
    return ff + ", 'D2Coding', monospace";
  }
  function prefs() {
    let p = {};
    try {
      p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch (_) {
    }
    const merged = Object.assign({ fontFamily: FONTS[0].v, fontSize: IS_MOBILE ? 12 : 14, theme: "auto", cursorStyle: "bar", scrollSpeed: 3, padGain: 3, mobileDock: true }, p);
    if (!merged.themeAutoMigrated && (merged.theme === "dark" || merged.theme === "light")) {
      merged.theme = "auto";
      merged.themeAutoMigrated = true;
      savePrefs(merged);
    }
    merged.fontFamily = withKR(merged.fontFamily);
    return merged;
  }
  function savePrefs(p) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch (_) {
    }
  }
  function applyChrome(themeKey) {
    const th = resolveTheme(themeKey);
    document.documentElement.dataset.theme = themeIsDark(themeKey) ? "dark" : "light";
    document.documentElement.style.setProperty("--term-bg", th.background);
  }
  function syncAppTheme() {
    const p = prefs();
    if (p.theme !== "auto") return;
    const th = resolveTheme("auto");
    try {
      if (term) term.options.theme = th;
    } catch (_) {
    }
    applyChrome("auto");
    try {
      doResize();
    } catch (_) {
    }
  }
  function watchAppTheme() {
    window.addEventListener("storage", (e) => {
      if (!e.key || e.key === "lv:theme") syncAppTheme();
    });
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncAppTheme);
    } catch (_) {
    }
  }
  var API_PREFIX = (() => {
    const m = /^(\/preview\/[A-Za-z0-9][A-Za-z0-9._-]*)\//.exec(location.pathname);
    return m ? m[1] : "";
  })();
  var apiUrl = (path) => API_PREFIX && String(path).charAt(0) === "/" ? API_PREFIX + path : path;
  function authHeaders(extra) {
    const t = localStorage.getItem(TOKEN_KEY);
    return Object.assign({}, extra, t ? { Authorization: "Bearer " + t } : {});
  }
  async function api(path, opts = {}) {
    const headers = authHeaders(opts.headers);
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(apiUrl(path), Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data && data.error || "\uC694\uCCAD \uC2E4\uD328 " + res.status);
    return data;
  }
  function fetchAuth(path, opts = {}) {
    return fetch(apiUrl(path), Object.assign({}, opts, { headers: authHeaders(opts.headers) }));
  }
  var sUrl = (suffix) => "/api/ui/terminal/sessions/" + encodeURIComponent(SESSION_ID) + suffix + nodeQ(suffix.indexOf("?") >= 0 ? "&" : "?");
  function toast(msg, isErr) {
    const t = el("div", { text: msg, style: "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:" + (isErr ? "#c0392b" : "#333") + ";color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,.3)" });
    document.body.append(t);
    setTimeout(() => t.remove(), 2800);
  }
  var term, fit, ws, statusEl, explorerEl, tabbarEl, panesEl, termPane, titleEl, projectBtnEl;
  function __injectRefsForTest(refs) {
    if ("term" in refs) term = refs.term;
    if ("ws" in refs) ws = refs.ws;
    if ("statusEl" in refs) statusEl = refs.statusEl;
    if ("panesEl" in refs) panesEl = refs.panesEl;
  }
  var curDir = "";
  var sessionProjectId = 0;
  var tabs = [];
  var activeId = "term";
  var lastCols = 0, lastRows = 0, resizeTimer = null, didInitialFit = false;
  var scrollSpeed = 1;
  var padGain = 3;
  var shiftEnterPending = false;
  var DIAG_MAX = 400;
  var diagBuf = [];
  function diagPreview(s, n) {
    return String(s).slice(0, n || 48).replace(/[\x00-\x1f\x7f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  }
  function dlog(kind, info) {
    try {
      diagBuf.push((/* @__PURE__ */ new Date()).toISOString().slice(11, 23) + " " + kind + (info ? " " + info : ""));
      if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
    } catch (_) {
    }
  }
  function diagText() {
    return [
      "# \uC6F9\uD130\uBBF8\uB110 \uC785\uB825 \uC9C4\uB2E8 (#1117) \xB7 build da60a6ae",
      "ua: " + navigator.userAgent,
      "session: " + SESSION_ID + (NODE_ID ? " node=" + NODE_ID : ""),
      "secure: " + window.isSecureContext + " \xB7 exported: " + (/* @__PURE__ */ new Date()).toISOString(),
      ""
    ].concat(diagBuf).join("\n");
  }
  window.livelyTermDiag = () => diagText();
  var IS_SAFARI = /Apple/i.test(navigator.vendor || "") && !/CriOS|FxiOS|Chrome|Chromium|Edg/i.test(navigator.userAgent || "");
  var IS_MOBILE = (() => {
    const q = new URLSearchParams(location.search).get("mobile");
    if (q === "1") return true;
    if (q === "0") return false;
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    return coarse || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  })();
  var imeComposing = false;
  var appDragSelect = false;
  var DCS_BYTES = [27, 80, 49, 48, 48, 48, 112];
  var BACKFILL_LINES = 600;
  var STATE_MARKER = "__LTSTATE__";
  function makeControl(opts) {
    let mode = null;
    let pending = new Uint8Array(0);
    let inBlock = false, blockNum = "", blockParts = [], blockAt = 0;
    const BLOCK_MAX_MS = 1500;
    const outDec = new TextDecoder("utf-8");
    const rawDec = new TextDecoder("utf-8");
    const ascii = (b, s, e) => {
      let r = "";
      for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
      return r;
    };
    function append(chunk) {
      if (pending.length === 0) {
        pending = chunk;
        return;
      }
      const c = new Uint8Array(pending.length + chunk.length);
      c.set(pending);
      c.set(chunk, pending.length);
      pending = c;
    }
    function octalDecode(b, s, e) {
      const out = [];
      for (let i = s; i < e; i++) {
        if (b[i] === 92) {
          let o = "", j = i + 1;
          while (j < e && o.length < 3 && b[j] >= 48 && b[j] <= 55) {
            o += String.fromCharCode(b[j]);
            j++;
          }
          if (o.length) {
            out.push(parseInt(o, 8) & 255);
            i = j - 1;
            continue;
          }
          out.push(92);
        } else out.push(b[i]);
      }
      return new Uint8Array(out);
    }
    function handleLine(s, e0) {
      let e = e0;
      if (e > s && pending[e - 1] === 13) e--;
      if (inBlock && blockAt && Date.now() - blockAt > BLOCK_MAX_MS) {
        inBlock = false;
        blockParts = [];
        blockAt = 0;
        if (opts.blockLost) opts.blockLost();
      }
      if (inBlock) {
        const head2 = ascii(pending, s, Math.min(e, s + 8));
        if ((head2.startsWith("%end ") || head2.startsWith("%error ")) && ascii(pending, s, e).split(" ")[2] === blockNum) {
          inBlock = false;
          blockAt = 0;
          const SEP = [27, 91, 48, 109, 13, 10];
          let len = 0;
          for (const p of blockParts) len += p.length;
          len += Math.max(0, blockParts.length - 1) * SEP.length;
          const merged = new Uint8Array(len);
          let off = 0;
          for (let k = 0; k < blockParts.length; k++) {
            if (k) {
              for (let z = 0; z < SEP.length; z++) merged[off++] = SEP[z];
            }
            merged.set(blockParts[k], off);
            off += blockParts[k].length;
          }
          blockParts = [];
          const text = new TextDecoder("utf-8").decode(merged);
          if (text.startsWith(STATE_MARKER)) {
            if (opts.state) opts.state(text);
            return;
          }
          if (text.length) opts.backfill(text);
          return;
        }
        blockParts.push(pending.slice(s, e));
        return;
      }
      if (ascii(pending, s, Math.min(e, s + 8)) === "%output ") {
        let p = s + 8;
        while (p < e && pending[p] !== 32) p++;
        const vstart = p + 1;
        if (vstart <= e) {
          const str = outDec.decode(octalDecode(pending, vstart, e), { stream: true });
          if (str) opts.write(str);
        }
        return;
      }
      const head = ascii(pending, s, Math.min(e, s + 18));
      if (head.startsWith("%begin ")) {
        inBlock = true;
        blockAt = Date.now();
        blockNum = ascii(pending, s, e).split(" ")[2] || "";
        blockParts = [];
      } else if (head.startsWith("%extended-output ")) {
        const full = ascii(pending, s, Math.min(e, s + 200));
        const mk = full.indexOf(" : ");
        if (mk >= 0) {
          const str = outDec.decode(octalDecode(pending, s + mk + 3, e), { stream: true });
          if (str) opts.write(str);
        }
      } else if (head.startsWith("%exit")) opts.onExit();
    }
    function processLines() {
      let start = 0;
      for (let i = 0; i < pending.length; i++) if (pending[i] === 10) {
        handleLine(start, i);
        start = i + 1;
      }
      pending = start ? pending.slice(start) : pending;
    }
    function feed(bytes) {
      if (mode === "raw") {
        const s = rawDec.decode(bytes, { stream: true });
        if (s) opts.write(s);
        return;
      }
      append(bytes);
      if (mode === null) {
        const n = Math.min(pending.length, DCS_BYTES.length);
        for (let i = 0; i < n; i++) if (pending[i] !== DCS_BYTES[i]) {
          mode = "raw";
          const s = rawDec.decode(pending, { stream: true });
          pending = new Uint8Array(0);
          if (s) opts.write(s);
          return;
        }
        if (pending.length < DCS_BYTES.length) return;
        mode = "control";
        pending = pending.slice(DCS_BYTES.length);
      }
      processLines();
    }
    return { feed, isControl: () => mode === "control" };
  }
  var ctrl = null, didBackfill = false;
  var syncedThisConn = false;
  var pendingPaneState = null, lastStateAt = 0, lastMouseResetAt = 0, lastMouseProbeAt = 0, mouseResetTries = 0;
  var BACKFILL_WAIT_MS = 900;
  var MAX_NUDGES = 3;
  var backfillWatch = null, nudgeTries = 0, needBackfill = false, lastKnownState = null;
  var wantRedrawCap = false;
  function clearBackfillWatch() {
    if (backfillWatch) {
      clearTimeout(backfillWatch);
      backfillWatch = null;
    }
  }
  function nudgeSizes(cols, rows) {
    const c = Math.trunc(cols) || 0, r = Math.trunc(rows) || 0;
    if (c < 1 || r < 2) return null;
    return [{ t: "r", c, r: r - 1 }, { t: "r", c, r }];
  }
  function isShellCmd(cmd) {
    const c = String(cmd || "").replace(/^-/, "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    return ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "powershell", "pwsh", "cmd"].indexOf(c) >= 0;
  }
  function captureSafeBackend(st) {
    if (!st) return false;
    if (st.mux) return st.mux !== "psmux";
    return !st.flagsMissing;
  }
  function captureAllowed(st) {
    if (!st) return false;
    if (captureSafeBackend(st)) return true;
    return isShellCmd(st.cmd);
  }
  function doNudge() {
    if (++nudgeTries > MAX_NUDGES) return;
    try {
      if (fit) fit.fit();
    } catch (_) {
    }
    const msgs = nudgeSizes(term && term.cols, term && term.rows);
    if (!msgs || !ws || ws.readyState !== 1) return;
    dlog("nudge", "#" + nudgeTries + " " + msgs[1].c + "x" + msgs[1].r);
    try {
      ws.send(JSON.stringify(msgs[0]));
    } catch (_) {
    }
    setTimeout(() => {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msgs[1]));
      } catch (_) {
      }
    }, 140);
    lastCols = 0;
    lastRows = 0;
  }
  function armBackfillWatch() {
    clearBackfillWatch();
    backfillWatch = setTimeout(() => {
      backfillWatch = null;
      const st = pendingPaneState;
      if (!st) return;
      pendingPaneState = null;
      dlog("backfill", "\uBCF4\uB0B8 \uCEA1\uCC98\uAC00 \uC548 \uB3CC\uC544\uC654\uB2E4 \u2192 \uD06C\uAE30 \uB11B\uC9C0\uB85C \uC7AC\uADF8\uB9AC\uAE30 \uC720\uB3C4");
      doNudge();
    }, BACKFILL_WAIT_MS);
  }
  function parsePaneState(line) {
    const m = {};
    for (const tok of String(line).trim().split(/\s+/)) {
      const i = tok.indexOf("=");
      if (i > 0) m[tok.slice(0, i)] = tok.slice(i + 1);
    }
    const num = (k) => {
      const n = parseInt(m[k], 10);
      return Number.isFinite(n) ? n : null;
    };
    const any = num("any"), btn = num("btn"), std = num("std"), sgr = num("sgr"), cx = num("cx"), cy = num("cy");
    return {
      alt: num("alt") === 1,
      mouseOn: any === 1 || btn === 1 || std === 1,
      // 1003/1002/1000 중 하나라도 = tmux flag 상 마우스 리포트 요구
      any: any === 1,
      btn: btn === 1,
      std: std === 1,
      sgr: sgr === 1,
      mux: m.mux || "",
      // 백엔드(tmux|psmux) — 서버가 알려주면 이게 답
      // 구 노드 번들엔 mux 토큰이 없다 → 지문으로 판별한다: psmux 는 마우스 flag 포맷변수를 구현하지 않아
      //  `any= btn= std= sgr=` 처럼 **전부 빈 값**으로 온다(실측). tmux 는 0/1 을 준다.
      flagsMissing: any === null && btn === null && std === null && sgr === null,
      cmd: m.cmd || "",
      // foreground 프로세스 — flag 가 stale 인지 가리는 단서(paneMouseMode)
      cx,
      cy,
      hasCursor: cx !== null && cy !== null
    };
  }
  function paneMouseMode(st) {
    if (!st) return "none";
    if (isShellCmd(st.cmd)) return "none";
    if (!paneMouseKnown(st)) return "keep";
    if (!(st.any || st.btn || st.std)) return "none";
    return st.any ? "any" : st.btn ? "drag" : "vt200";
  }
  function paneMouseKnown(st) {
    if (!st) return false;
    if (st.mux === "psmux") return false;
    return !st.flagsMissing;
  }
  function isMouseReport(d) {
    return /^\x1b\[(<[0-9;]+[Mm]|[0-9;]+M|M)/.test(String(d || ""));
  }
  function applyPaneState(st) {
    if (!term || !st) return;
    lastKnownState = st;
    pendingPaneState = st;
    lastStateAt = Date.now();
    try {
      const isAlt = !!(term.buffer && term.buffer.active && term.buffer.active.type === "alternate");
      if (st.alt && !isAlt) {
        dlog("alt", "1049h (\uC571 alt \xB7 \uD074\uB77C normal)");
        term.write("\x1B[?1049h");
      } else if (!st.alt && isAlt) {
        dlog("alt", "1049l (\uC571 normal \xB7 \uD074\uB77C alt)");
        term.write("\x1B[?1049l");
      }
    } catch (_) {
    }
    try {
      let xtMode = "none";
      try {
        xtMode = term.modes && term.modes.mouseTrackingMode || "none";
      } catch (_) {
      }
      const xtOn = xtMode !== "none";
      const wantMode = paneMouseMode(st);
      if (wantMode === "keep") {
        if (xtOn) dlog("mouse", "keep " + xtMode + " (\uBC31\uC5D4\uB4DC\uAC00 flag \uB97C \uC548 \uC900\uB2E4 \xB7 mux=" + (st.mux || "?") + " cmd=" + (st.cmd || "?") + ")");
      } else if (wantMode === "none") {
        if (st.mouseOn) requestMouseReset();
        if (xtOn) term.write("\x1B[?1000l\x1B[?1002l\x1B[?1003l\x1B[?1005l\x1B[?1006l\x1B[?1015l");
      } else if (wantMode !== xtMode) {
        let seq = xtOn ? "\x1B[?1000l\x1B[?1002l\x1B[?1003l" : "";
        if (st.std) seq += "\x1B[?1000h";
        if (st.btn) seq += "\x1B[?1002h";
        if (st.any) seq += "\x1B[?1003h";
        if (st.sgr) seq += "\x1B[?1006h";
        term.write(seq);
      }
    } catch (_) {
    }
  }
  function requestMouseReset() {
    const now = Date.now();
    if (mouseResetTries >= 3 || now - lastMouseResetAt < 1e4) return;
    lastMouseResetAt = now;
    mouseResetTries++;
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ t: "mr" }));
      } catch (_) {
      }
    }
  }
  function applyFit() {
    if (!fit || !term) return;
    try {
      fit.fit();
    } catch (_) {
    }
    if (ws && ws.readyState === 1 && (term.cols !== lastCols || term.rows !== lastRows)) {
      lastCols = term.cols;
      lastRows = term.rows;
      dlog("fit", term.cols + "x" + term.rows);
      try {
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      } catch (_) {
      }
    }
  }
  function doResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyFit, 130);
  }
  function forceRedraw() {
    if (!fit || !term) return;
    try {
      fit.fit();
    } catch (_) {
    }
    if (ws && ws.readyState === 1) {
      lastCols = term.cols;
      lastRows = term.rows;
      try {
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      } catch (_) {
      }
      if (ctrl && ctrl.isControl()) {
        if (!captureSafeBackend(lastKnownState)) {
          dlog("redraw", "cap \uBCF4\uB958 \u2014 \uC0C1\uD0DC \uC9C8\uC758 \uD6C4 \uD310\uC815(backend=" + (lastKnownState && lastKnownState.mux || "\uBBF8\uC0C1") + ")");
          wantRedrawCap = true;
          try {
            ws.send(JSON.stringify({ t: "st" }));
          } catch (_) {
          }
        } else {
          dlog("redraw", "cap \uC804\uC1A1(backend=" + lastKnownState.mux + ")");
          try {
            ws.send(JSON.stringify({ t: "cap", n: BACKFILL_LINES, st: 1 }));
            armBackfillWatch();
          } catch (_) {
          }
        }
      }
    }
    try {
      term.refresh(0, term.rows - 1);
    } catch (_) {
    }
  }
  function softReconnect() {
    if (sessionEnded) return;
    try {
      if (fit && term) fit.fit();
    } catch (_) {
    }
    didBackfill = false;
    reconnectDelay = 250;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close();
      } catch (_) {
      }
    } else {
      connectNow();
    }
    try {
      statusEl.textContent = "\uBCF5\uAD6C \uC911\u2026";
      statusEl.className = "status";
    } catch (_) {
    }
  }
  var fontReadyPromise = null;
  function loadTermFonts(family) {
    if (!(document.fonts && document.fonts.load)) return Promise.resolve();
    if (!family && fontReadyPromise) return fontReadyPromise;
    const sz = term && term.options.fontSize || 14;
    const fam = String(family || term && term.options.fontFamily || "");
    const want = [["\uAC00\uD7A3\uAE00\uAF34", "'D2Coding'"], ["\uAC00\uD7A3\uAE00\uAF34", "bold 'D2Coding'"]];
    try {
      const first = fam.split(",")[0].trim();
      if (first && !/D2Coding/i.test(first) && !/^(ui-)?monospace$/i.test(first)) {
        want.push(["AaWgMm0", first], ["AaWgMm0", "bold " + first]);
      }
    } catch (_) {
    }
    const pr = Promise.all(want.map(([t, f]) => document.fonts.load(f.replace(/^(bold )?/, "$1" + sz + "px "), t).catch(() => null)));
    if (!family) fontReadyPromise = pr;
    return pr;
  }
  function remeasureAfterFonts(family) {
    const run = () => {
      try {
        const fs = term.options.fontSize;
        term.options.fontSize = fs + 1;
        term.options.fontSize = fs;
      } catch (_) {
      }
      try {
        requestAnimationFrame(forceRedraw);
      } catch (_) {
        forceRedraw();
      }
    };
    loadTermFonts(family).then(() => document.fonts && document.fonts.ready || null).then(() => setTimeout(run, 30)).catch(() => setTimeout(run, 120));
  }
  function initialSettleRedraw() {
    if (didInitialFit) return;
    didInitialFit = true;
    remeasureAfterFonts();
  }
  function loadRenderer() {
    try {
      if (window.WebglAddon && window.WebglAddon.WebglAddon) {
        const w = new WebglAddon.WebglAddon();
        w.onContextLoss(() => {
          try {
            w.dispose();
          } catch (_) {
          }
          try {
            if (window.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon());
          } catch (__) {
          }
        });
        term.loadAddon(w);
        return;
      }
    } catch (_) {
    }
    try {
      if (window.CanvasAddon && window.CanvasAddon.CanvasAddon) term.loadAddon(new CanvasAddon.CanvasAddon());
    } catch (_) {
    }
  }
  function execCopy(text) {
    let ok = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = !!document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) {
    }
    try {
      term.focus();
    } catch (_) {
    }
    return ok;
  }
  function copySyncViaEvent(text) {
    let ok = false;
    const fill = (e) => {
      try {
        e.clipboardData.setData("text/plain", text);
        e.preventDefault();
        e.stopImmediatePropagation();
        ok = true;
      } catch (_) {
      }
    };
    try {
      document.addEventListener("copy", fill, true);
      document.execCommand("copy");
    } catch (_) {
    }
    document.removeEventListener("copy", fill, true);
    return ok;
  }
  var pendingCopy = null;
  function stashPendingCopy(text) {
    pendingCopy = text;
    dlog("copy-stash", "len=" + text.length);
  }
  function flushPendingCopy(ev) {
    if (!pendingCopy) return;
    if (imeComposing || ev && (ev.isComposing || ev.keyCode === 229)) return;
    const t = pendingCopy;
    pendingCopy = null;
    if (copySyncViaEvent(t)) {
      dlog("copy-flush-ok", "sync len=" + t.length);
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(() => dlog("copy-flush-ok", "api len=" + t.length), () => dlog("copy-flush-fail"));
    } else dlog("copy-flush-fail");
  }
  document.addEventListener("keydown", flushPendingCopy, true);
  document.addEventListener("mousedown", flushPendingCopy, true);
  function copyText(text, silent, gesture) {
    if (!text) return;
    const inGesture = !!gesture;
    if (inGesture && copySyncViaEvent(text)) dlog("copy-ok", "sync len=" + text.length);
    else if (inGesture && execCopy(text)) dlog("copy-ok", "exec len=" + text.length);
    else if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        () => dlog("copy-ok", "api len=" + text.length),
        () => {
          dlog("copy-fail", "api len=" + text.length);
          stashPendingCopy(text);
        }
      );
    } else if (!execCopy(text)) stashPendingCopy(text);
    if (!silent) toast("\uBCF5\uC0AC\uB428");
  }
  var osc52Resolve = null, osc52Timer = null;
  function armClipboardPromise() {
    if (!IS_SAFARI || !window.ClipboardItem || !(navigator.clipboard && navigator.clipboard.write)) return;
    if (osc52Resolve) return;
    try {
      const p = new Promise((res, rej) => {
        osc52Resolve = (t) => {
          res(new Blob([t], { type: "text/plain" }));
        };
        osc52Timer = setTimeout(() => {
          osc52Resolve = null;
          rej(new Error("osc52-timeout"));
        }, 2e3);
      });
      navigator.clipboard.write([new ClipboardItem({ "text/plain": p })]).then(() => dlog("copy-ok", "osc52-armed"), () => dlog("copy-arm-miss"));
      dlog("copy-arm");
    } catch (_) {
      osc52Resolve = null;
    }
  }
  var copyHintAt = 0;
  function copyHintToast() {
    if (Date.now() - copyHintAt < 8e3) return;
    copyHintAt = Date.now();
    toast("\uBCF5\uC0AC\uD560 \uC120\uD0DD\uC774 \uC5C6\uC5B4\uC694 \u2014 \uB4DC\uB798\uADF8\uB85C \uC120\uD0DD\uD55C \uB4A4 \u2318C (\uC6F9 \uC120\uD0DD\uC740 Shift+\uB4DC\uB798\uADF8)");
  }
  var dragPress = null, dragMoved = false;
  function trackAppMouse(d) {
    if (!(d.charCodeAt(0) === 27 && d.charCodeAt(1) === 91 && d.charCodeAt(2) === 60)) {
      if (d.charCodeAt(0) !== 27) appDragSelect = false;
      return;
    }
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let m;
    while (m = re.exec(d)) {
      const b = Number(m[1]) & ~(4 | 8 | 16);
      const isUp = m[4] === "m";
      if (b >= 64) continue;
      if (b >= 32) {
        if (!isUp && (b & 3) !== 3 && dragPress) dragMoved = true;
        continue;
      }
      if (!isUp) {
        dragPress = m[2] + "," + m[3];
        dragMoved = false;
      } else {
        appDragSelect = !!(dragPress && (dragMoved || dragPress !== m[2] + "," + m[3]));
        if (appDragSelect) dlog("app-drag-select");
        dragPress = null;
        dragMoved = false;
      }
    }
  }
  var repChunk = "", repCount = 0, repAt = 0;
  function spamGuard(d) {
    if (d.length < 6 || d.charCodeAt(0) === 27) {
      repChunk = "";
      repCount = 0;
      return;
    }
    if (d === repChunk && Date.now() - repAt < 2e3) {
      if (++repCount >= 3) {
        repCount = 0;
        dlog("spam-detect", "x3 " + diagPreview(d));
        try {
          const ta = term.textarea;
          if (ta && !imeComposing && ta.value) {
            dlog("spam-clean", diagPreview(ta.value));
            ta.value = "";
          }
        } catch (_) {
        }
      }
    } else {
      repChunk = d;
      repCount = 1;
    }
    repAt = Date.now();
  }
  var imeEcho = "", imeEchoDone = "", imeSwallow = null;
  var HANGUL_CH_RE = /^[ㄱ-ㆎ가-힣]$/;
  var MODIFIER_KEYCODES = { 16: 1, 17: 1, 18: 1, 20: 1, 91: 1, 93: 1 };
  function setupWebkitImeAdapter() {
    if (!IS_SAFARI) return;
    const ta = term.textarea;
    if (!ta) return;
    ta.addEventListener("beforeinput", (e) => {
      if (imeComposing) return;
      const t = e && e.inputType || "", d = e && e.data || "";
      if (t === "insertReplacementText") {
        if (d && d === imeEcho) {
          dlog("ime", "repl=echo skip");
          return;
        }
        if (d && !imeEcho && d === imeEchoDone) {
          imeEchoDone = "";
          dlog("ime", "repl=done skip");
          return;
        }
        const seq = (imeEcho ? "\x7F" : "") + d;
        if (seq) sendInput(seq);
        imeEcho = d;
        dlog("ime", "repl " + diagPreview(d, 8));
        return;
      }
      if (t === "insertText" && d && (imeEcho || d.length === 1 && HANGUL_CH_RE.test(d))) {
        imeSwallow = d;
        userTyped = true;
        sendInput(d);
        imeEcho = d.length === 1 && HANGUL_CH_RE.test(d) ? d : "";
        imeEchoDone = "";
        appDragSelect = false;
        dlog("ime", "echo " + diagPreview(d, 8));
      }
    }, true);
    ta.addEventListener("input", () => {
      imeSwallow = null;
    }, true);
  }
  function handleTermData(d) {
    userTyped = true;
    if (imeSwallow !== null && d === imeSwallow) {
      imeSwallow = null;
      dlog("ime", "swallow " + diagPreview(d, 8));
      return;
    }
    if (!(d.charCodeAt(0) === 27 && d.charCodeAt(1) === 91 && d.charCodeAt(2) === 60)) dlog("out", diagPreview(d, 16));
    trackAppMouse(d);
    spamGuard(d);
    cancelPromptSeek(true);
    if (shiftEnterPending && d === "\r") {
      shiftEnterPending = false;
      d = "\x1B\r";
    }
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ t: "i", d }));
      } catch (_) {
      }
    }
    if (isMouseReport(d) && Date.now() - lastStateAt > 8e3 && Date.now() - lastMouseProbeAt > 8e3) {
      lastMouseProbeAt = Date.now();
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ t: "st" }));
        } catch (_) {
        }
      }
    }
  }
  function setupOscClipboard() {
    try {
      term.parser.registerOscHandler(52, (data) => {
        try {
          const i = data.indexOf(";");
          const b64 = i >= 0 ? data.slice(i + 1) : data;
          if (b64 && b64 !== "?") {
            let text = "";
            try {
              text = decodeURIComponent(escape(atob(b64)));
            } catch (_) {
              try {
                text = atob(b64);
              } catch (__) {
                text = "";
              }
            }
            if (text) {
              dlog("osc52", "len=" + text.length);
              if (osc52Resolve) {
                const r = osc52Resolve;
                osc52Resolve = null;
                clearTimeout(osc52Timer);
                r(text);
              } else copyText(text, true);
            }
          }
        } catch (_) {
        }
        return true;
      });
    } catch (_) {
    }
  }
  function sendInput(d) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ t: "i", d }));
      } catch (_) {
      }
    }
  }
  function sanitizePasteText(t) {
    return String(t).replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(/\x1b\[[0-9:;?<=>!"'$#% ]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, "").replace(/\x1b[\s\S]?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, "");
  }
  function pasteText(t) {
    if (!t) return;
    t = sanitizePasteText(t);
    if (!t) return;
    dlog("paste", "len=" + t.length + (/\n/.test(t) ? " multiline" : ""));
    if (/\n/.test(t)) sendInput("\x1B[200~" + t + "\x1B[201~");
    else sendInput(t);
  }
  var WELCOME_PROMPT = "\uB77C\uC774\uBE14\uB9AC \uC0AC\uC6A9\uBC95\uC744 \uC54C\uB824\uC918 \u2014 \uB77C\uC774\uBE14\uB9AC\uAC00 \uC5B4\uB5A4 \uB3C4\uAD6C\uC774\uACE0 \uBB58 \uD560 \uC218 \uC788\uB294\uC9C0, \uADF8\uB9AC\uACE0 \uB9E5\uB77D(\uC9C0\uC2DD\xB7\uD504\uB85C\uC81D\uD2B8\xB7\uCE74\uD14C\uACE0\uB9AC\xB7\uB3C4\uBA54\uC778\uB9F5)\uC744 \uC5B4\uB5BB\uAC8C \uAE30\uB85D\uD558\uACE0 \uBD88\uB7EC\uC624\uB294\uC9C0 \uD575\uC2EC \uD750\uB984\uC744 \uC608\uC2DC\uC640 \uD568\uAED8 \uBCF4\uC5EC\uC918. \uB9C8\uC9C0\uB9C9\uC5D0 \uC9C0\uAE08 \uBC14\uB85C \uD574\uBCFC \uB9CC\uD55C \uAC78 \uD558\uB098 \uC81C\uC548\uD574\uC918.";
  var autosendIsWelcome = false;
  var AUTOSEND = (() => {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get("autosend")) {
        const k = "lively:autosend:" + SESSION_ID;
        const v = localStorage.getItem(k) || "";
        if (v) localStorage.removeItem(k);
        return v;
      }
      if (q.get("welcome")) {
        autosendIsWelcome = true;
        return WELCOME_PROMPT;
      }
      return "";
    } catch (_) {
      return "";
    }
  })();
  var autosendDone = false, autosendLastOut = 0, autosendDeadline = 0, autosendTimer = null;
  var AUTOSEND_MAX_TRIES = 8;
  function autosendReadScreen() {
    try {
      const b = term.buffer.active;
      const rows = term.rows || 24;
      const out = [];
      for (let i = 0; i < rows; i++) {
        const ln = b.getLine(b.baseY + i);
        if (ln) out.push(ln.translateToString(true));
      }
      return out.join("\n");
    } catch (_) {
      return "";
    }
  }
  function autosendLanded(screen) {
    if (/\[Pasted text|paste again to expand|\+\s*\d+\s*lines?/i.test(screen)) return true;
    const probe = AUTOSEND.replace(/\s+/g, " ").trim().slice(0, 24);
    return probe.length >= 6 && screen.replace(/\s+/g, " ").indexOf(probe) !== -1;
  }
  function autosendBlockingDialog(screen) {
    return /trust (this|the) folder|Do you trust|Enter to confirm|❯\s*1\.\s|\bNo, exit\b|Bypass Permissions mode|accept the risk/i.test(screen);
  }
  function autosendPasteTry(n) {
    if (autosendDone !== "firing") return;
    if (autosendBlockingDialog(autosendReadScreen()) && n < AUTOSEND_MAX_TRIES) {
      setTimeout(() => autosendPasteTry(n + 1), 900);
      return;
    }
    try {
      pasteText(AUTOSEND);
    } catch (_) {
    }
    setTimeout(() => {
      if (autosendLanded(autosendReadScreen())) {
        autosendDone = true;
        try {
          sendInput("\r");
        } catch (_) {
        }
        try {
          toast(autosendIsWelcome ? "\uB77C\uC774\uBE14\uB9AC \uC0AC\uC6A9\uBC95 \uC548\uB0B4\uB97C \uC2DC\uC791\uD588\uC5B4\uC694" : "\uC120\uD0DD\uD55C \uD0DC\uC2A4\uD06C\uB97C \uD074\uB85C\uB4DC\uC5D0\uAC8C \uC804\uB2EC\uD588\uC5B4\uC694");
        } catch (_) {
        }
      } else if (n < AUTOSEND_MAX_TRIES) {
        setTimeout(() => autosendPasteTry(n + 1), 800);
      } else {
        autosendDone = true;
        if (!autosendBlockingDialog(autosendReadScreen())) {
          try {
            sendInput("\r");
          } catch (_) {
          }
        }
      }
    }, 400);
  }
  function scheduleAutosend() {
    if (!AUTOSEND || autosendDone) return;
    clearTimeout(autosendTimer);
    autosendTimer = setTimeout(() => {
      if (autosendDone) return;
      const quiet = Date.now() - autosendLastOut;
      if (autosendLastOut && quiet >= 1600 || autosendDeadline && Date.now() >= autosendDeadline) {
        autosendDone = "firing";
        try {
          if (term) term.focus();
        } catch (_) {
        }
        autosendPasteTry(0);
      } else {
        scheduleAutosend();
      }
    }, 500);
  }
  var uploadDestLabel = () => sessionProjectId > 0 ? "\uC774 \uD504\uB85C\uC81D\uD2B8 \uACF5\uC720 \uD3F4\uB354" : "\uC138\uC158 \uC791\uC5C5 \uD3F4\uB354";
  var HINT_DROP_KEY = "lively_term_hint_filedrop";
  function showDropHint() {
    const main = document.getElementById("main");
    if (!main || document.querySelector(".pop-hint")) return;
    if (main.querySelector(".ended-bar")) return;
    if (IS_MOBILE) return;
    try {
      if (window.top !== window.self) return;
    } catch (_) {
      return;
    }
    try {
      if (localStorage.getItem(HINT_DROP_KEY) === "1") return;
    } catch (_) {
    }
    const step = (n, title, sub) => el(
      "div",
      { class: "hint-step" },
      el("span", { class: "n", text: String(n) }),
      el("span", { class: "t" }, title, el("small", { text: sub }))
    );
    const dont = el("input", { type: "checkbox" });
    const ok = el("button", { class: "hint-ok", text: "\uC54C\uACA0\uC5B4\uC694" });
    const pop = el(
      "div",
      { class: "pop pop-hint" },
      el("h3", { text: "\uD30C\uC77C\uC740 \uB04C\uC5B4\uB2E4 \uB193\uC73C\uBA74 \uB429\uB2C8\uB2E4" }),
      el("p", { class: "hint-sub", text: "\uC774\uBBF8\uC9C0\xB7\uBB38\uC11C\uB97C \uD074\uB85C\uB4DC\uC5D0\uAC8C \uC904 \uB54C \uACBD\uB85C\uB97C \uC9C1\uC811 \uCE60 \uD544\uC694\uAC00 \uC5C6\uC5B4\uC694." }),
      el(
        "div",
        { class: "hint-steps" },
        step(1, "\uD654\uBA74 \uC544\uBB34 \uB370\uB098 \uB04C\uC5B4\uB2E4 \uB193\uAE30", "\uCEA1\uCC98\uD55C \uC774\uBBF8\uC9C0\uB294 \u2318V(Ctrl+V)\uB85C \uBD99\uC5EC\uB123\uC5B4\uB3C4 \uB429\uB2C8\uB2E4"),
        step(2, uploadDestLabel() + "\uC5D0 \uBCF5\uC0AC", "uploads/ \uD3F4\uB354\uC5D0 \uC62C\uB77C\uAC00 \uB098\uC911\uC5D0\uB3C4 \uB2E4\uC2DC \uCC3E\uC744 \uC218 \uC788\uC5B4\uC694"),
        step(3, "\uACBD\uB85C\uAC00 \uC785\uB825\uCC3D\uC5D0 \uC790\uB3D9 \uC0BD\uC785", "\uC124\uBA85\uC744 \uB367\uBD99\uC774\uACE0 Enter \u2014 \uBCF4\uB0B4\uB294 \uAC74 \uC9C1\uC811 \uD558\uC154\uC57C \uD569\uB2C8\uB2E4")
      ),
      el(
        "div",
        { class: "hint-row" },
        el("label", {}, dont, "\uB2E4\uC2DC \uBCF4\uC9C0 \uC54A\uAE30"),
        el("span", { class: "spacer" }),
        ok
      )
    );
    const back = el("div", { class: "pop-back" }, pop);
    const close = () => {
      if (dont.checked) {
        try {
          localStorage.setItem(HINT_DROP_KEY, "1");
        } catch (_) {
        }
      }
      back.remove();
      document.removeEventListener("keydown", esc);
    };
    function esc(ev) {
      if (ev.key === "Escape") close();
    }
    ok.onclick = close;
    back.onclick = (e) => {
      if (e.target === back) close();
    };
    document.addEventListener("keydown", esc);
    document.body.append(back);
    ok.focus();
  }
  async function uniqueUploadName(name) {
    const taken = /* @__PURE__ */ new Set();
    try {
      const d = await api(sUrl("/ls?path=" + encodeURIComponent("uploads")));
      for (const it of d.items || []) taken.add(it.name);
    } catch (_) {
      return name;
    }
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; i < 1e3; i++) {
      const c = stem + "-" + i + ext;
      if (!taken.has(c)) return c;
    }
    return stem + "-" + Math.floor(Math.random() * 1e6) + ext;
  }
  async function dropFileToAgent(file) {
    if (!file) return;
    let name = (file.name || "pasted").split(/[/\\]/).pop().replace(/[^\w.\-가-힣]/g, "_");
    if (!/\.[a-z0-9]+$/i.test(name)) name += "." + ((file.type || "").split("/")[1] || "png");
    name = await uniqueUploadName(name);
    const rel = "uploads/" + name;
    toast("\uC5C5\uB85C\uB4DC \uC911\u2026 " + name);
    let abs = rel;
    try {
      const res = await fetchAuth(sUrl("/file?path=" + encodeURIComponent(rel)), { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(j && j.error || "" + res.status);
      }
      if (j && j.path) abs = j.path;
    } catch (e) {
      toast("\uC5C5\uB85C\uB4DC \uC2E4\uD328 \u2014 " + e.message, true);
      return;
    }
    const quoted = "'" + abs.replace(/'/g, "'\\''") + "'";
    sendInput(" " + quoted + " ");
    toast("\uCCA8\uBD80: " + name + " \u2014 \uACBD\uB85C\uAC00 \uC785\uB825\uCC3D\uC5D0 \uB4E4\uC5B4\uAC14\uC5B4\uC694(\uC124\uBA85 \uC801\uACE0 Enter)");
    if (explorerLoaded) loadDir(curDir);
  }
  function setupClipboard() {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (EMBED && (e.key === "k" || e.key === "K") && !e.ctrlKey && (e.altKey || e.metaKey)) {
        e.preventDefault();
        try {
          window.parent.postMessage({ type: "lively-omni-open" }, location.origin);
        } catch (_) {
        }
        return false;
      }
      if (imeEcho && e.keyCode !== 229 && !e.isComposing && !MODIFIER_KEYCODES[e.keyCode]) {
        imeEchoDone = imeEcho;
        imeEcho = "";
      }
      if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        shiftEnterPending = true;
        Promise.resolve().then(() => {
          shiftEnterPending = false;
        });
        return true;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const wordSeq = e.key === "ArrowLeft" ? "\x1Bb" : "\x1Bf";
        e.preventDefault();
        if (e.isComposing) return false;
        const dSeq = wordSeq;
        setTimeout(() => {
          if (ws && ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ t: "i", d: dSeq }));
            } catch (_) {
            }
          }
        }, 0);
        return false;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "Backspace") {
        e.preventDefault();
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ t: "i", d: "" }));
          } catch (_) {
          }
        }
        return false;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return true;
      const k = (e.key || "").toLowerCase();
      if (k === "c") {
        let mouseOn = false;
        try {
          mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== "none");
        } catch (_) {
        }
        if (term.hasSelection()) {
          copyText(term.getSelection(), false, true);
          return false;
        }
        if (e.metaKey && !e.ctrlKey) {
          if (mouseOn) {
            if (appDragSelect) {
              appDragSelect = false;
              armClipboardPromise();
              sendInput("");
              dlog("cmdc-bridge", "consume");
            } else {
              dlog("cmdc-skip", "no-app-selection");
              copyHintToast();
            }
            return false;
          }
          return true;
        }
        if (e.ctrlKey && !e.metaKey && mouseOn && appDragSelect) armClipboardPromise();
        return true;
      }
      if (k === "v") {
        if (e.metaKey && !e.ctrlKey) return true;
        schedulePasteFallback();
        return false;
      }
      return true;
    });
  }
  function setupTextareaHygiene() {
    const ta = term.textarea;
    if (!ta) return;
    let menuHold = false, timer = null;
    const IDLE = IS_SAFARI ? 1500 : 300;
    const sweep = () => {
      if (imeComposing || menuHold) return;
      try {
        if (ta.value) {
          dlog("hygiene", diagPreview(ta.value));
          ta.value = "";
        }
      } catch (_) {
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(sweep, IDLE);
    };
    ta.addEventListener("compositionstart", () => {
      imeComposing = true;
    }, true);
    ta.addEventListener("compositionend", () => {
      imeComposing = false;
      arm();
    }, true);
    ta.addEventListener("keydown", arm, true);
    ta.addEventListener("keyup", arm, true);
    ta.addEventListener("input", arm, true);
    try {
      if (term.element) term.element.addEventListener("contextmenu", () => {
        menuHold = true;
      }, true);
    } catch (_) {
    }
    const resume = () => {
      menuHold = false;
      arm();
    };
    document.addEventListener("mousedown", resume, true);
    document.addEventListener("keydown", resume, true);
    document.addEventListener("copy", resume, true);
    document.addEventListener("paste", resume, true);
    arm();
  }
  function setupImeTrace() {
    const ta = term.textarea;
    if (!ta) return;
    const st = () => {
      try {
        return " len=" + ta.value.length + " sel=" + ta.selectionStart;
      } catch (_) {
        return "";
      }
    };
    ta.addEventListener("keydown", (e) => dlog("kd", (e.keyCode || 0) + (e.isComposing ? " C" : "") + " " + diagPreview(e.key || "", 8) + st()), true);
    ta.addEventListener("compositionstart", (e) => dlog("cs", diagPreview(e && e.data || "", 12) + st()), true);
    ta.addEventListener("compositionupdate", (e) => dlog("cu", diagPreview(e && e.data || "", 12) + st()), true);
    ta.addEventListener("compositionend", (e) => dlog("ce", diagPreview(e && e.data || "", 12) + st()), true);
    ta.addEventListener("input", (e) => dlog("in", (e && e.inputType || "?") + " " + diagPreview(e && e.data || "", 12) + st()), true);
  }
  var pasteFallbackTimer = null;
  function cancelPasteFallback() {
    if (pasteFallbackTimer) {
      clearTimeout(pasteFallbackTimer);
      pasteFallbackTimer = null;
    }
  }
  function schedulePasteFallback() {
    cancelPasteFallback();
    if (!(navigator.clipboard && navigator.clipboard.read && window.isSecureContext)) return;
    pasteFallbackTimer = setTimeout(() => {
      pasteFallbackTimer = null;
      dlog("paste-src", "fallback-api");
      navigator.clipboard.read().then(async (its) => {
        let textDone = false;
        for (const it of its) {
          const t = (it.types || []).find((x) => x.startsWith("image/"));
          if (t) await dropFileToAgent(new File([await it.getType(t)], "pasted." + (t.split("/")[1] || "png"), { type: t }));
          else if (!textDone && (it.types || []).includes("text/plain")) {
            textDone = true;
            pasteText(await (await it.getType("text/plain")).text());
          }
        }
      }).catch(() => navigator.clipboard.readText().then((t) => pasteText(t)).catch(() => {
      }));
    }, 60);
  }
  function setupPaste() {
    const dz = panesEl || document.body;
    dz.addEventListener("paste", (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const img = [...dt.items || []].find((it) => it.kind === "file" && (it.type || "").startsWith("image/"));
      if (img) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const blob = img.getAsFile();
        if (blob) {
          cancelPasteFallback();
          dlog("paste-src", "native-image");
          dropFileToAgent(blob);
        }
        return;
      }
      const text = dt.getData("text/plain") || dt.getData("text") || "";
      if (text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelPasteFallback();
        dlog("paste-src", "native");
        pasteText(text);
      }
    }, true);
  }
  function cellHeightPx() {
    try {
      const scr = term.element && term.element.querySelector(".xterm-screen") || term.element;
      return Math.max(4, scr.getBoundingClientRect().height / term.rows);
    } catch (_) {
      return 17;
    }
  }
  function setupWheel() {
    if (!term.attachCustomWheelEventHandler) return;
    const NOTCH_MIN_PX = 100;
    const cellFromEvent = (e) => {
      try {
        const scr = term.element && term.element.querySelector(".xterm-screen") || term.element;
        const r = scr.getBoundingClientRect();
        return {
          col: Math.min(term.cols, Math.max(1, Math.floor((e.clientX - r.left) / (r.width / term.cols)) + 1)),
          row: Math.min(term.rows, Math.max(1, Math.floor((e.clientY - r.top) / (r.height / term.rows)) + 1))
        };
      } catch (_) {
        return { col: 1, row: 1 };
      }
    };
    const isNotch = (e) => {
      if (e.deltaMode !== 0) return true;
      const wdy = e.wheelDeltaY;
      if (typeof wdy === "number" && wdy !== 0) return Math.abs(wdy) % 120 === 0;
      return Math.abs(e.deltaY) >= NOTCH_MIN_PX;
    };
    let accPx = 0, accAt = 0;
    term.attachCustomWheelEventHandler((e) => {
      cancelPromptSeek(true);
      let alt = false, mouseOn = false;
      try {
        alt = term.buffer.active.type === "alternate";
      } catch (_) {
      }
      try {
        mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== "none");
      } catch (_) {
      }
      const notch = isNotch(e);
      if (alt && mouseOn && notch && scrollSpeed <= 1) return true;
      let lines;
      if (e.deltaMode === 2) {
        lines = e.deltaY * term.rows;
      } else if (notch) {
        accPx = 0;
        const approx = e.deltaMode === 1 ? e.deltaY : Math.trunc(e.deltaY / 18) || (e.deltaY > 0 ? 1 : -1);
        lines = approx * Math.max(1, Math.round(scrollSpeed));
      } else {
        const now = e.timeStamp || 0;
        if (accPx && (Math.sign(accPx) !== Math.sign(e.deltaY) || now - accAt > 300)) accPx = 0;
        accAt = now;
        accPx += e.deltaY * Math.max(0.2, padGain);
        const h = cellHeightPx();
        lines = Math.trunc(accPx / h);
        accPx -= lines * h;
      }
      const n = Math.trunc(lines);
      if (alt && mouseOn) {
        const reps = notch ? Math.min(Math.max(1, Math.round(scrollSpeed)), 12) : Math.min(Math.abs(n), 12);
        if (!reps) return false;
        const c = cellFromEvent(e);
        const btn = n < 0 ? 64 : 65;
        let seq = "";
        for (let i = 0; i < reps; i++) seq += "\x1B[<" + btn + ";" + c.col + ";" + c.row + "M";
        sendInput(seq);
        return false;
      }
      if (alt) return true;
      if (n) term.scrollLines(n);
      return false;
    });
  }
  function setupTouch() {
    const hostEl = term.element;
    if (!hostEl) return;
    const cellFromXY = (x, y) => {
      try {
        const scr = hostEl.querySelector(".xterm-screen") || hostEl;
        const r = scr.getBoundingClientRect();
        return {
          col: Math.min(term.cols, Math.max(1, Math.floor((x - r.left) / (r.width / term.cols)) + 1)),
          row: Math.min(term.rows, Math.max(1, Math.floor((y - r.top) / (r.height / term.rows)) + 1))
        };
      } catch (_) {
        return { col: 1, row: 1 };
      }
    };
    const emit = (lines, x, y) => {
      const n = Math.trunc(lines);
      if (!n) return 0;
      let alt = false, mouseOn = false;
      try {
        alt = term.buffer.active.type === "alternate";
      } catch (_) {
      }
      try {
        mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== "none");
      } catch (_) {
      }
      const reps = Math.min(Math.abs(n), 8);
      if (alt && mouseOn) {
        const c = cellFromXY(x, y);
        const btn = n < 0 ? 64 : 65;
        let seq = "";
        for (let i = 0; i < reps; i++) seq += "\x1B[<" + btn + ";" + c.col + ";" + c.row + "M";
        sendInput(seq);
      } else if (alt) {
        let seq = "";
        for (let i = 0; i < reps; i++) seq += n < 0 ? "\x1B[A" : "\x1B[B";
        sendInput(seq);
      } else {
        term.scrollLines(n);
      }
      return n;
    };
    let lastY = 0, lastX = 0, accPx = 0, vel = 0, lastT = 0, raf = 0, active = false;
    const stopFling = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    hostEl.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) {
        active = false;
        return;
      }
      stopFling();
      active = true;
      accPx = 0;
      vel = 0;
      lastY = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      lastT = e.timeStamp;
    }, { passive: true });
    hostEl.addEventListener("touchmove", (e) => {
      if (!active || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = lastY - t.clientY;
      const dt = Math.max(1, e.timeStamp - lastT);
      vel = 0.8 * vel + 0.2 * (dy / dt);
      lastY = t.clientY;
      lastX = t.clientX;
      lastT = e.timeStamp;
      accPx += dy;
      const h = cellHeightPx();
      const used = emit(accPx / h, t.clientX, t.clientY);
      accPx -= used * h;
      e.preventDefault();
    }, { passive: false });
    const endTouch = (e) => {
      if (!active) return;
      active = false;
      if (Math.abs(vel) < 0.15) return;
      const x = lastX, y = lastY;
      let v = Math.max(-4, Math.min(4, vel)), prev = 0, acc = 0;
      const step = (ts) => {
        raf = 0;
        if (!prev) prev = ts;
        const dt = Math.min(64, ts - prev);
        prev = ts;
        acc += v * dt;
        v *= Math.pow(0.994, dt);
        const h = cellHeightPx();
        const used = emit(acc / h, x, y);
        acc -= used * h;
        if (Math.abs(v) > 0.03) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    hostEl.addEventListener("touchend", endTouch, { passive: true });
    hostEl.addEventListener("touchcancel", () => {
      active = false;
    }, { passive: true });
  }
  var mdockEl = null, mcompEl = null;
  function mobileDockOn() {
    return IS_MOBILE && prefs().mobileDock !== false;
  }
  function setTermTextareaReadonly(on) {
    try {
      const ta = term.textarea;
      if (!ta) return;
      ta.readOnly = !!on;
      if (on) {
        ta.setAttribute("inputmode", "none");
        ta.tabIndex = -1;
      } else {
        ta.removeAttribute("inputmode");
        ta.tabIndex = 0;
      }
    } catch (_) {
    }
  }
  function arrowSeq(letter) {
    let app = false;
    try {
      app = !!(term.modes && term.modes.applicationCursorKeysMode);
    } catch (_) {
    }
    return (app ? "\x1BO" : "\x1B[") + letter;
  }
  function mobileSend() {
    if (!mcompEl) return;
    const t = String(mcompEl.value || "");
    userTyped = true;
    if (t) {
      if (/\n/.test(t)) pasteText(t);
      else sendInput(sanitizePasteText(t));
    }
    sendInput("\r");
    mcompEl.value = "";
    mobileGrow();
    dlog("mdock", "send len=" + t.length);
  }
  function mobileGrow() {
    if (!mcompEl) return;
    mcompEl.style.height = "auto";
    mcompEl.style.height = Math.min(112, Math.max(38, mcompEl.scrollHeight)) + "px";
  }
  function openCopySheet() {
    const lines = [];
    try {
      const b = term.buffer.active;
      const from = Math.max(0, b.length - 400);
      for (let i = from; i < b.length; i++) {
        const ln = b.getLine(i);
        lines.push(ln ? ln.translateToString(true) : "");
      }
    } catch (_) {
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = lines.join("\n");
    const pre = el("pre", { class: "copy-sheet-pre", text: text || "(\uD654\uBA74\uC5D0 \uAE00\uC790\uAC00 \uC5C6\uC5B4\uC694)" });
    const back = el(
      "div",
      { class: "pop-back", onclick: (e) => {
        if (e.target === back) back.remove();
      } },
      el(
        "div",
        { class: "pop copy-sheet" },
        el(
          "div",
          { class: "copy-sheet-head" },
          el("h3", { text: "\uD654\uBA74 \uAE00\uC790 \xB7 \uCD5C\uADFC " + lines.length + "\uC904" }),
          el("span", { class: "spacer" }),
          el("button", { class: "tbtn", text: "\uC804\uCCB4 \uBCF5\uC0AC", onclick: () => {
            copyText(text, false, true);
          } }),
          el("button", { class: "tbtn", text: "\uB2EB\uAE30", onclick: () => back.remove() })
        ),
        el("div", { class: "copy-sheet-hint", text: "\uAFB9 \uB20C\uB7EC \uD544\uC694\uD55C \uBD80\uBD84\uB9CC \uACE0\uB974\uAC70\uB098, \uC804\uCCB4 \uBCF5\uC0AC\uB97C \uB204\uB974\uC138\uC694." }),
        pre
      )
    );
    document.body.append(back);
    try {
      pre.scrollTop = pre.scrollHeight;
    } catch (_) {
    }
  }
  function setupMobileDock(mainEl) {
    if (!IS_MOBILE) return;
    document.body.classList.add("mobile");
    const tbtn = (label, title, act, onStart) => {
      const b = el("button", { class: "mkey", type: "button", title: title || label, text: label });
      b.addEventListener(onStart ? "touchstart" : "touchend", (e) => {
        e.preventDefault();
        act();
      }, { passive: false });
      b.addEventListener("click", (e) => {
        if (e.detail === 0) act();
      });
      return b;
    };
    const key = (label, seq, title) => tbtn(label, title, () => {
      userTyped = true;
      sendInput(typeof seq === "function" ? seq() : seq);
    }, true);
    const keys = el(
      "div",
      { class: "mkeys" },
      key("Esc", "\x1B"),
      key("Tab", "	"),
      key("\u2191", () => arrowSeq("A")),
      key("\u2193", () => arrowSeq("B")),
      key("\u2190", () => arrowSeq("D")),
      key("\u2192", () => arrowSeq("C")),
      key("^C", "", "Ctrl+C \u2014 \uC911\uB2E8"),
      key("\u23CE", "\r", "Enter \uB9CC \uBCF4\uB0B4\uAE30"),
      tbtn("\u29C9 \uBCF5\uC0AC", "\uD654\uBA74 \uAE00\uC790 \uACE0\uB974\uAE30\xB7\uBCF5\uC0AC", openCopySheet),
      tbtn("\u2398 \uBD99\uC5EC\uB123\uAE30", "\uD074\uB9BD\uBCF4\uB4DC \uB0B4\uC6A9\uC744 \uC785\uB825\uCE78\uC5D0", mobilePasteIn)
    );
    mcompEl = el("textarea", {
      class: "mcomp",
      rows: "1",
      placeholder: "\uC5EC\uAE30\uC5D0 \uC4F0\uACE0 \uBCF4\uB0B4\uAE30 \u2014 \uAFB9 \uB20C\uB7EC \uBCF5\uC0AC\xB7\uBD99\uC5EC\uB123\uAE30",
      autocapitalize: "off",
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "send",
      "aria-label": "\uD130\uBBF8\uB110\uC5D0 \uBCF4\uB0BC \uAE00"
    });
    const sendBtn = tbtn("\uBCF4\uB0B4\uAE30", "\uBCF4\uB0B4\uAE30(Enter)", mobileSend);
    sendBtn.className = "msend";
    mcompEl.addEventListener("input", mobileGrow);
    mcompEl.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        mobileSend();
      }
    });
    mcompEl.addEventListener("focus", () => {
      setTimeout(() => {
        try {
          window.scrollTo(0, 0);
        } catch (_) {
        }
      }, 50);
    });
    mdockEl = el("div", { id: "mdock" }, keys, el("div", { class: "mrow" }, mcompEl, sendBtn));
    mainEl.append(mdockEl);
    applyMobileDock();
  }
  function mobilePasteIn() {
    if (!(navigator.clipboard && navigator.clipboard.readText)) {
      toast("\uBE0C\uB77C\uC6B0\uC800\uAC00 \uBD99\uC5EC\uB123\uAE30 \uC77D\uAE30\uB97C \uB9C9\uC558\uC5B4\uC694 \u2014 \uC785\uB825\uCE78\uC744 \uAFB9 \uB20C\uB7EC \uBD99\uC5EC\uB123\uC73C\uC138\uC694.", true);
      return;
    }
    navigator.clipboard.readText().then((t) => {
      if (!mcompEl) return;
      const v = mcompEl.value;
      const st = mcompEl.selectionStart ?? v.length;
      mcompEl.value = v.slice(0, st) + t + v.slice(mcompEl.selectionEnd ?? v.length);
      mobileGrow();
      mcompEl.focus();
    }).catch(() => toast("\uBD99\uC5EC\uB123\uAE30\uB97C \uBABB \uC77D\uC5C8\uC5B4\uC694 \u2014 \uC785\uB825\uCE78\uC744 \uAFB9 \uB20C\uB7EC \uBD99\uC5EC\uB123\uC73C\uC138\uC694.", true));
  }
  function applyMobileDock() {
    const on = mobileDockOn();
    if (mdockEl) mdockEl.hidden = !on;
    setTermTextareaReadonly(on);
    doResize();
  }
  function setupViewportFit() {
    const vv = window.visualViewport;
    if (!vv || !IS_MOBILE) return;
    const ws2 = document.getElementById("ws");
    const apply = () => {
      if (!ws2) return;
      ws2.style.height = Math.round(vv.height) + "px";
      ws2.style.transform = vv.offsetTop ? "translateY(" + Math.round(vv.offsetTop) + "px)" : "";
      doResize();
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
  }
  function setActive(id) {
    activeId = id;
    for (const t of tabs) t.pane.classList.toggle("active", t.id === id);
    for (const b of tabbarEl.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.id === id);
    if (id === "term") setTimeout(doResize, 0);
  }
  function renderTabbar() {
    tabbarEl.style.display = tabs.length <= 1 ? "none" : "flex";
    tabbarEl.replaceChildren();
    for (const t of tabs) {
      const btn = el("button", { class: "tab" + (t.id === activeId ? " active" : ""), "data-id": t.id, onclick: () => setActive(t.id) }, t.label);
      if (t.closable) btn.append(el("span", { class: "x", text: "\xD7", onclick: (e) => {
        e.stopPropagation();
        closeTab(t.id);
      } }));
      tabbarEl.append(btn);
    }
  }
  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs[i].pane.remove();
    tabs.splice(i, 1);
    if (activeId === id) activeId = "term";
    renderTabbar();
    setActive(activeId);
  }
  function addPane(id, label, closable, node) {
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      existing.pane.replaceChildren(node);
      renderTabbar();
      setActive(id);
      return;
    }
    const pane = el("div", { class: "pane" }, node);
    panesEl.append(pane);
    tabs.push({ id, label, pane, closable });
    renderTabbar();
    setActive(id);
  }
  function fileIcon(name, type) {
    if (type === "dir") return "\u{1F4C1}";
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return "\u{1F5BC}";
    if (/\.md$/i.test(name)) return "\u{1F4DD}";
    return "\u{1F4C4}";
  }
  var shareRoot = null;
  var sharePath = "";
  function shareUrlFor(rel) {
    const appBase = location.origin + location.pathname.replace(/[^/]*$/, "");
    return appBase + "#/f?root=" + encodeURIComponent(shareRoot || "") + "&path=" + encodeURIComponent(rel || "");
  }
  async function copyShareLink(rel, isDir) {
    const url = shareUrlFor(rel);
    const who = shareRoot === "personal" ? "\uAC1C\uC778 \uD3F4\uB354\uB77C \uC774 \uB9C1\uD06C\uB294 \uB098\uB9CC \uC5F4 \uC218 \uC788\uC5B4\uC694" : "\uBCFC \uAD8C\uD55C\uC774 \uC788\uB294 \uD300\uC6D0\uC774 \uC5F4 \uC218 \uC788\uC5B4\uC694";
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      toast((isDir ? "\uD3F4\uB354" : "\uD30C\uC77C") + " \uB9C1\uD06C \uBCF5\uC0AC \u2014 " + who);
    } catch (_) {
      window.prompt("\uC544\uB798 \uC8FC\uC18C\uB97C \uBCF5\uC0AC\uD574 \uBCF4\uB0B4\uC138\uC694", url);
    }
  }
  async function loadDir(p) {
    curDir = p || "";
    const list = document.getElementById("exp-list");
    document.getElementById("exp-path").textContent = "/" + curDir;
    list.replaceChildren(el("div", { class: "exp-item", text: "\uBD88\uB7EC\uC624\uB294 \uC911\u2026" }));
    let data;
    try {
      data = await api(sUrl("/ls?path=" + encodeURIComponent(curDir)));
    } catch (e) {
      list.replaceChildren(el("div", { class: "exp-item", text: "\uC624\uB958: " + e.message }));
      return;
    }
    shareRoot = data.shareRoot || null;
    sharePath = data.sharePath || "";
    list.replaceChildren();
    if (data.parent !== null && curDir) list.append(el("div", { class: "exp-item", onclick: () => loadDir(data.parent), title: "\uC0C1\uC704" }, el("span", { class: "ic", text: "\u21A9" }), ".."));
    for (const it of data.items || []) {
      const childPath = (curDir ? curDir + "/" : "") + it.name;
      const isDir = it.type === "dir";
      const shareRel = shareRoot ? sharePath ? sharePath + "/" + it.name : it.name : null;
      const row = el(
        "div",
        { class: "exp-item", onclick: () => isDir ? loadDir(childPath) : openPreview(childPath, it.name, shareRel) },
        el("span", { class: "ic", text: fileIcon(it.name, it.type) }),
        it.name,
        // .sz 는 폴더에서도(빈 값으로) 항상 그린다 — 이 span 의 margin-left:auto 가 오른쪽 액션들을 끝으로 밀기
        //  때문이다(terminal.html .exp-item .sz). 폴더에서 빼면 🔗 가 이름 바로 옆에 붙어 열이 어긋난다.
        el("span", { class: "sz", text: isDir ? "" : fmtSize(it.size) }),
        shareRel ? el("span", { class: "exp-dl exp-share", text: "\u{1F517}", title: "\uB9C1\uD06C \uBCF5\uC0AC", onclick: (e) => {
          e.stopPropagation();
          copyShareLink(shareRel, isDir);
        } }) : null,
        it.type === "file" ? el("span", { class: "exp-dl", text: "\u2B07", title: "\uB2E4\uC6B4\uB85C\uB4DC", onclick: (e) => {
          e.stopPropagation();
          downloadFile(childPath, it.name);
        } }) : null
      );
      list.append(row);
    }
  }
  var fmtSize = (n) => n < 1024 ? n + "B" : n < 1048576 ? (n / 1024).toFixed(0) + "K" : (n / 1048576).toFixed(1) + "M";
  async function downloadFile(p, name) {
    try {
      const res = await fetchAuth(sUrl("/file?path=" + encodeURIComponent(p) + "&download=1"));
      if (!res.ok) throw new Error("" + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      toast("\uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328: " + e.message, true);
    }
  }
  async function uploadFile(file, dir) {
    const rel = (dir ? dir + "/" : "") + file.name;
    const res = await fetchAuth(sUrl("/file?path=" + encodeURIComponent(rel)), { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d && d.error || "" + res.status);
    }
  }
  async function uploadMany(files, dir) {
    for (const f of files) {
      try {
        await uploadFile(f, dir);
        toast("\uC5C5\uB85C\uB4DC: " + f.name);
      } catch (e) {
        toast("\uC5C5\uB85C\uB4DC \uC2E4\uD328: " + f.name + " \u2014 " + e.message, true);
      }
    }
    loadDir(curDir);
  }
  function startUpload() {
    const input = document.getElementById("upload-input");
    input.value = "";
    input.onchange = () => {
      const files = [...input.files || []];
      if (files.length) uploadMany(files, curDir);
    };
    input.click();
  }
  async function newFolder() {
    const name = prompt("\uC0C8 \uD3F4\uB354 \uC774\uB984");
    if (!name || !name.trim()) return;
    const rel = (curDir ? curDir + "/" : "") + name.trim();
    try {
      await api(sUrl("/mkdir?path=" + encodeURIComponent(rel)), { method: "POST" });
      toast("\uD3F4\uB354 \uC0DD\uC131: " + name.trim());
      loadDir(curDir);
    } catch (e) {
      toast("\uC0DD\uC131 \uC2E4\uD328: " + e.message, true);
    }
  }
  function setupDnd() {
    const dz = explorerEl;
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", (e) => {
      if (e.target === dz) dz.classList.remove("drag");
    });
    dz.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (!explorerLoaded) {
        explorerLoaded = true;
        await loadDir("");
      }
      const files = [...e.dataTransfer && e.dataTransfer.files || []];
      if (files.length) uploadMany(files, curDir);
    });
  }
  function setupTermDrop() {
    const dz = panesEl;
    if (!dz) return;
    let note = null;
    const on = () => {
      dz.style.outline = "2px dashed #4a9eff";
      dz.style.outlineOffset = "-4px";
      if (note) return;
      note = el(
        "div",
        { class: "drop-note" },
        el("b", { text: "\uC5EC\uAE30\uC5D0 \uB193\uC73C\uC138\uC694" }),
        el("span", { text: uploadDestLabel() + "(uploads/)\uC5D0 \uBCF5\uC0AC\uB418\uACE0, \uADF8 \uACBD\uB85C\uAC00 \uC785\uB825\uCC3D\uC5D0 \uB4E4\uC5B4\uAC11\uB2C8\uB2E4" })
      );
      dz.append(note);
    };
    const off = () => {
      dz.style.outline = "";
      dz.style.outlineOffset = "";
      if (note) {
        note.remove();
        note = null;
      }
    };
    dz.addEventListener("dragover", (e) => {
      if (!(e.dataTransfer && [...e.dataTransfer.types].includes("Files"))) return;
      e.preventDefault();
      on();
    });
    dz.addEventListener("dragleave", (e) => {
      if (e.target === dz) off();
    });
    dz.addEventListener("drop", async (e) => {
      const files = [...e.dataTransfer && e.dataTransfer.files || []];
      if (!files.length) return;
      e.preventDefault();
      off();
      for (const f of files) await dropFileToAgent(f);
    });
  }
  var IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
  var MD_RE = /\.(md|markdown)$/i;
  var TEXT_RE = /\.(txt|text|log|json|jsonc|ya?ml|toml|ini|conf|cfg|env|csv|tsv|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|cc|hpp|cs|php|sh|bash|zsh|fish|sql|xml|gradle|properties)$/i;
  var TEXT_NAMES = /* @__PURE__ */ new Set(["dockerfile", "makefile", "license", "readme", "changelog", ".gitignore", ".gitattributes", ".editorconfig", ".env"]);
  var isTextLike = (name) => MD_RE.test(name) || TEXT_RE.test(name) || TEXT_NAMES.has(name.toLowerCase());
  async function openPreview(p, name, shareRel) {
    const id = "file:" + p;
    const body = el("div", { class: "preview-body" }, el("div", { class: "gate-msg", text: "\uBD88\uB7EC\uC624\uB294 \uC911\u2026" }));
    const bar = el(
      "div",
      { class: "preview-bar" },
      el("span", { class: "preview-bar-nm", title: name, text: name }),
      el("span", { class: "preview-bar-sp" }),
      shareRel ? el("a", { class: "tbtn", href: shareUrlFor(shareRel), target: "_blank", rel: "noopener", title: "\uC804\uCCB4\uD654\uBA74(\uC0C8 \uD0ED)", text: "\u26F6 \uC804\uCCB4\uD654\uBA74" }) : null,
      shareRel ? el("button", { class: "tbtn", text: "\u{1F517} \uB9C1\uD06C", title: "\uB9C1\uD06C \uBCF5\uC0AC", onclick: () => copyShareLink(shareRel, false) }) : null,
      el("button", { class: "tbtn", text: "\u2B07 \uB2E4\uC6B4\uB85C\uB4DC", onclick: () => downloadFile(p, name) })
    );
    const pane = el("div", { class: "preview-pane" }, bar, body);
    addPane(id, name, true, pane);
    if (IMG_RE.test(name)) {
      renderImage(body, p, name);
      return;
    }
    if (isTextLike(name)) {
      renderTextPreview(body, p, MD_RE.test(name));
      return;
    }
    body.replaceChildren(el(
      "div",
      { class: "unsupported" },
      el(
        "div",
        { class: "unsupported-card" },
        el("div", { class: "unsupported-title", text: shareRel ? "\uC774 \uD615\uC2DD\uC740 \uC804\uCCB4\uD654\uBA74\uC5D0\uC11C \uC5F4\uB824\uC694" : "\uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C" }),
        el("div", { class: "unsupported-sub", text: shareRel ? name + " \u2014 PDF\xB7\uD45C\xB7\uC74C\uC131\xB7\uC601\uC0C1\uC740 \uC804\uCCB4\uD654\uBA74 \uBBF8\uB9AC\uBCF4\uAE30\uAC00 \uB80C\uB354\uD569\uB2C8\uB2E4." : name }),
        el(
          "div",
          { class: "unsupported-actions" },
          shareRel ? el("a", { class: "tbtn", href: shareUrlFor(shareRel), target: "_blank", rel: "noopener", text: "\u26F6 \uC804\uCCB4\uD654\uBA74\uC73C\uB85C \uC5F4\uAE30" }) : null,
          el("button", { class: "tbtn", text: "\uB2E4\uC6B4\uB85C\uB4DC", onclick: () => downloadFile(p, name) })
        )
      )
    ));
  }
  async function renderImage(body, p, name) {
    try {
      const res = await fetchAuth(sUrl("/file?path=" + encodeURIComponent(p)));
      if (!res.ok) throw new Error("" + res.status);
      body.replaceChildren(el("img", { src: URL.createObjectURL(await res.blob()), alt: name }));
    } catch (e) {
      body.replaceChildren(el("div", { class: "gate-msg", text: "\uBD88\uB7EC\uC624\uAE30 \uC2E4\uD328: " + e.message }));
    }
  }
  async function renderTextPreview(body, p, asMd) {
    body.replaceChildren(el("div", { class: "gate-msg", text: "\uBD88\uB7EC\uC624\uB294 \uC911\u2026" }));
    try {
      const res = await fetchAuth(sUrl("/file?path=" + encodeURIComponent(p)));
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d && d.error || "" + res.status);
      }
      let text = await res.text();
      if (/\.json$/i.test(p)) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
        }
      }
      body.replaceChildren(asMd ? renderMarkdown(text) : el("pre", { class: "raw", text }));
    } catch (e) {
      body.replaceChildren(el("div", { class: "gate-msg", text: "\uBBF8\uB9AC\uBCF4\uAE30 \uC2E4\uD328: " + e.message }));
    }
  }
  function openSettings() {
    const p = prefs();
    const fontSel = el("select", {}, ...FONTS.map((f) => el("option", { value: f.v, selected: f.v === p.fontFamily ? "" : null }, f.label)));
    const sizeI = el("input", { type: "number", min: "9", max: "30", value: String(p.fontSize) });
    const themeSel = el("select", {}, ...Object.entries(THEMES).map(([k, v]) => el("option", { value: k, selected: k === p.theme ? "" : null }, v.name)));
    const cursorSel = el("select", {}, ...["bar", "block", "underline"].map((c) => el("option", { value: c, selected: c === p.cursorStyle ? "" : null }, c)));
    const speedI = el("input", { type: "number", min: "1", max: "12", step: "1", value: String(p.scrollSpeed || 3) });
    const gainI = el("input", { type: "number", min: "0.5", max: "6", step: "0.5", value: String(p.padGain || 3) });
    const dockI = el("input", { type: "checkbox", checked: p.mobileDock !== false ? "" : null, style: "width:auto" });
    let curFamily = p.fontFamily;
    const apply = () => {
      const np = { fontFamily: fontSel.value, fontSize: Number(sizeI.value) || 14, theme: themeSel.value, cursorStyle: cursorSel.value, scrollSpeed: Math.max(1, Math.min(12, Number(speedI.value) || 1)), padGain: Math.max(0.5, Math.min(6, Number(gainI.value) || 3)), mobileDock: !!dockI.checked };
      term.options.fontFamily = np.fontFamily;
      term.options.fontSize = np.fontSize;
      term.options.cursorStyle = np.cursorStyle;
      term.options.theme = resolveTheme(np.theme);
      scrollSpeed = np.scrollSpeed;
      padGain = np.padGain;
      savePrefs(np);
      applyChrome(np.theme);
      doResize();
      if (np.fontFamily !== curFamily) {
        curFamily = np.fontFamily;
        remeasureAfterFonts(np.fontFamily);
      }
    };
    for (const c of [fontSel, themeSel, cursorSel]) c.addEventListener("change", apply);
    sizeI.addEventListener("input", apply);
    speedI.addEventListener("input", apply);
    gainI.addEventListener("input", apply);
    dockI.addEventListener("change", () => {
      apply();
      applyMobileDock();
    });
    const back = el(
      "div",
      { class: "pop-back", onclick: (e) => {
        if (e.target === back) back.remove();
      } },
      el(
        "div",
        { class: "pop" },
        el("h3", { text: "\uD658\uACBD \uC124\uC815" }),
        el("div", { class: "field" }, el("label", { text: "\uD3F0\uD2B8" }), fontSel),
        el("div", { class: "field" }, el("label", { text: "\uD06C\uAE30(px)" }), sizeI),
        el("div", { class: "field" }, el("label", { text: "\uD14C\uB9C8" }), themeSel),
        el("div", { class: "field" }, el("label", { text: "\uCEE4\uC11C" }), cursorSel),
        el("div", { class: "field" }, el("label", { text: "\uB9C8\uC6B0\uC2A4 \uD720 \uC18D\uB3C4 (1~12)" }), speedI),
        el("div", { class: "field" }, el("label", { text: "\uD2B8\uB799\uD328\uB4DC \uC18D\uB3C4 (1 = \uC190\uAC00\uB77D \uC774\uB3D9\uB9CC\uD07C)" }), gainI),
        IS_MOBILE ? el("div", { class: "field field-row" }, dockI, el("label", { text: "\uBAA8\uBC14\uC77C \uC785\uB825 \uBC14 \u2014 \uC544\uB798 \uC785\uB825\uCE78\uC5D0\uC11C \uC4F0\uACE0 \uBCF4\uB0B4\uAE30(\uB044\uBA74 \uD130\uBBF8\uB110\uC5D0 \uC9C1\uC811 \uD0C0\uC774\uD551, \uD55C\uAE00\uC774 \uAE68\uC9C8 \uC218 \uC788\uC5B4\uC694)" })) : null,
        el("button", { class: "tbtn pop-close", text: "\uB2EB\uAE30", onclick: () => back.remove() })
      )
    );
    document.addEventListener("keydown", function esc(ev) {
      if (ev.key === "Escape") {
        back.remove();
        document.removeEventListener("keydown", esc);
      }
    });
    document.body.append(back);
  }
  function openHelp() {
    const kb = (keys, desc) => el(
      "div",
      { class: "help-item" },
      el("span", { class: "k" }, ...keys.map((t) => el("span", { class: "kbd", text: t }))),
      el("span", { class: "d", text: desc })
    );
    const tool = (name, desc) => el(
      "div",
      { class: "help-tool" },
      el("b", { text: name }),
      el("span", { text: " \u2014 " + desc })
    );
    const sec = (title, ...items) => el(
      "div",
      { class: "help-sec" },
      el("div", { class: "help-sec-t", text: title }),
      el("div", { class: "help-list" }, ...items)
    );
    const pop = el(
      "div",
      { class: "pop pop-help" },
      el("button", { class: "help-x", title: "\uB2EB\uAE30", text: "\u2715", onclick: () => back.remove() }),
      el(
        "div",
        { class: "help-head" },
        el("h3", { text: "\uC0AC\uC6A9\uBC95 \uC548\uB0B4" }),
        el("p", { class: "help-intro", text: "\uD130\uBBF8\uB110\uC774 \uCC98\uC74C\uC774\uC5B4\uB3C4 \uC774\uAC83\uB9CC \uC54C\uBA74 \uC785\uB825\uC774 \uD6E8\uC52C \uBE68\uB77C\uC838\uC694." })
      ),
      el(
        "div",
        { class: "help-body" },
        sec(
          "\uC774\uC804\uC5D0 \uCE5C \uBA85\uB839 \uB2E4\uC2DC \uC4F0\uAE30",
          kb(["\u2191 \u2193"], "\uBC14\uB85C \uC804\uC5D0 \uC785\uB825\uD55C \uBA85\uB839\uB4E4\uC744 \uC704/\uC544\uB798\uB85C \uBD88\uB7EC\uC624\uAE30"),
          kb(["Ctrl R"], "\uC608\uC804 \uBA85\uB839\uC744 \uAC80\uC0C9\uD574\uC11C \uCC3E\uAE30 (\uC77C\uBD80\uB9CC \uCCD0\uB3C4 \uB429\uB2C8\uB2E4)"),
          kb(["Tab"], "\uC785\uB825\uD558\uB2E4 \uB204\uB974\uBA74 \uD30C\uC77C\xB7\uBA85\uB839 \uC774\uB984 \uC790\uB3D9\uC644\uC131")
        ),
        sec(
          "\uD55C \uC904\uC5D0\uC11C \uCEE4\uC11C \uC774\uB3D9",
          kb(["Option \u2190/\u2192"], "\uD55C \uB2E8\uC5B4\uC529 \uAC74\uB108\uB6F0\uBA70 \uC774\uB3D9 (Windows\uB294 Alt)"),
          kb(["Ctrl A"], "\uC904 \uB9E8 \uC55E\uC73C\uB85C"),
          kb(["Ctrl E"], "\uC904 \uB9E8 \uB05D\uC73C\uB85C")
        ),
        sec(
          "\uC798\uBABB \uCE5C \uAC83 \uC9C0\uC6B0\uAE30",
          kb(["Ctrl U"], "\uC9C0\uAE08 \uCE5C \uC904\uC744 \uD1B5\uC9F8\uB85C \uC9C0\uC6B0\uAE30"),
          kb(["Alt \u232B"], "\uCEE4\uC11C \uC55E \uB2E8\uC5B4 \uD558\uB098 \uC9C0\uC6B0\uAE30 (Mac\uC740 Option+\u232B \xB7 Windows\uC5D0\uC11C Ctrl+W\uB294 \uD0ED\uC774 \uB2EB\uD600\uC694)"),
          kb(["Ctrl K"], "\uCEE4\uC11C \uC624\uB978\uCABD\uC744 \uB05D\uAE4C\uC9C0 \uC9C0\uC6B0\uAE30")
        ),
        sec(
          "\uD654\uBA74 \xB7 \uC2E4\uD589",
          kb(["Ctrl L"], "\uD654\uBA74 \uBE44\uC6B0\uAE30 (\uC704\uB85C \uC2A4\uD06C\uB864\uD558\uBA74 \uB0A8\uC544 \uC788\uC74C)"),
          kb(["Ctrl C"], "\uBA48\uCD98\xB7\uC2E4\uD589 \uC911\uC778 \uBA85\uB839 \uAC15\uC81C \uC911\uB2E8"),
          kb(["\uD720 \u2191"], "\uC704\uB85C \uC2A4\uD06C\uB864\uD574 \uC9C0\uB09C \uCD9C\uB825 \uBCF4\uAE30")
        ),
        sec(
          "\uBCF5\uC0AC",
          kb(["\uB4DC\uB798\uADF8 \u2192 \u2318/Ctrl C"], "\uB4DC\uB798\uADF8\uB85C \uC120\uD0DD\uD55C \uB4A4 \uBCF5\uC0AC \u2014 \uC790\uB3D9 \uBCF5\uC0AC\uB294 \uC5C6\uC5B4\uC694(\uD074\uB9BD\uBCF4\uB4DC \uC548 \uB36E\uC784)"),
          kb(["Shift \uB4DC\uB798\uADF8"], "Claude \uC548\uC5D0\uC11C\uB294 Shift \uB204\uB978 \uCC44 \uB4DC\uB798\uADF8\uB85C \uC120\uD0DD"),
          kb(["Claude \uBCF5\uC0AC"], "Claude \uAC00 \uBCF5\uC0AC\uD55C \uB0B4\uC6A9\uC740 \uB0B4 \uCEF4\uD4E8\uD130 \uD074\uB9BD\uBCF4\uB4DC\uC5D0\uB3C4 \uC790\uB3D9\uC73C\uB85C \uC62C\uB77C\uAC00\uC694"),
          kb(["\u2318C (\uC120\uD0DD \uC5C6\uC774)"], "Claude \uD654\uBA74\uC5D0\uC11C \uC120\uD0DD \uC5C6\uC774 \u2318C \uB97C \uB20C\uB7EC\uB3C4 \uC774\uC81C Claude \uAC00 \uC885\uB8CC\uB418\uC9C0 \uC54A\uC544\uC694")
        ),
        // 파일 전달은 이 화면에서 가장 안 알려진 기능이라 별도 섹션으로 앞에 둔다(#1235 — 종전엔 '파일 탐색기' 한 줄이 전부였다).
        sec(
          "\uD30C\uC77C\xB7\uC774\uBBF8\uC9C0 \uC8FC\uAE30",
          tool("\uB04C\uC5B4\uB2E4 \uB193\uAE30", "\uD654\uBA74 \uC544\uBB34 \uB370\uB098 \uB193\uC73C\uBA74 " + uploadDestLabel() + "(uploads/)\uC5D0 \uC62C\uB77C\uAC00\uACE0 \uADF8 \uACBD\uB85C\uAC00 \uC785\uB825\uCC3D\uC5D0 \uB4E4\uC5B4\uAC11\uB2C8\uB2E4"),
          tool("\uBD99\uC5EC\uB123\uAE30", "\uCEA1\uCC98\uD55C \uC774\uBBF8\uC9C0\uB294 \u2318V(Windows \uB294 Ctrl+V)\uB85C \uBC14\uB85C \u2014 \uAC19\uC740 \uBC29\uC2DD\uC73C\uB85C \uC804\uB2EC\uB429\uB2C8\uB2E4"),
          tool("\uBCF4\uB0BC \uB54C", "\uACBD\uB85C \uB4A4\uC5D0 \uC124\uBA85\uC744 \uC801\uACE0 Enter \uB97C \uB20C\uB7EC\uC57C \uD074\uB85C\uB4DC\uAC00 \uC77D\uC2B5\uB2C8\uB2E4 (\uC790\uB3D9 \uC804\uC1A1 \uC548 \uD568)")
        ),
        sec(
          "\uBB38\uC81C\uAC00 \uC0DD\uACBC\uC744 \uB54C",
          tool("\uC785\uB825 \uC9C4\uB2E8 \uBCF5\uC0AC", "\uC785\uB825\uC774 \uC774\uC0C1\uD560 \uB54C(\uD0A4\uB9CC \uB20C\uB7EC\uB3C4 \uAC19\uC740 \uBB38\uC790\uC5F4\uC774 \uB4E4\uC5B4\uAC00\uB294 \uB4F1) \uC544\uB798 \uBC84\uD2BC\uC73C\uB85C \uCD5C\uADFC \uC785\uB825 \uAE30\uB85D\uC744 \uBCF5\uC0AC\uD574 \uC81C\uBCF4\uC5D0 \uBD99\uC5EC \uC8FC\uC138\uC694 \u2014 \uC11C\uBC84\uB85C\uB294 \uC804\uC1A1\uB418\uC9C0 \uC54A\uC544\uC694"),
          el("button", { class: "tbtn", text: "\u{1F50D} \uC785\uB825 \uC9C4\uB2E8 \uBCF5\uC0AC", onclick: () => copyText(diagText(), false, true) }),
          tool("\uC2E4\uD589 \uC911 \uBE4C\uB4DC", "da60a6ae \u2014 \uC81C\uBCF4 \uC2DC \uC774 \uAC12\uC744 \uD568\uAED8 \uC54C\uB824 \uC8FC\uC138\uC694(\uC61B \uCE90\uC2DC\uB85C \uD14C\uC2A4\uD2B8\uD558\uB294 \uC624\uC778 \uBC29\uC9C0)")
        ),
        sec(
          "\uB3C4\uAD6C (\uC624\uB978\uCABD \uC704 \uBC84\uD2BC)",
          tool("\uC9C8\uBB38", "\uC774 \uC138\uC158\uC5D0\uC11C AI \uC5D0\uAC8C \uBCF4\uB0B8 \uC9C8\uBB38 \uC804\uBD80 \u2014 \uD074\uB9AD\uD558\uBA74 \uADF8 \uC704\uCE58\uB85C \uC774\uB3D9"),
          tool("\uD30C\uC77C \uD0D0\uC0C9\uAE30", "\uC62C\uB9B0 \uD30C\uC77C \uD655\uC778\xB7\uB2E4\uC6B4\uB85C\uB4DC (\uC5EC\uAE30\uC5D0 \uB193\uC73C\uBA74 \uC9C0\uAE08 \uC5F4\uB9B0 \uD3F4\uB354\uB85C \uC5C5\uB85C\uB4DC)"),
          tool("\uD654\uBA74 \uBCF5\uAD6C", "\uD654\uBA74\uC774 \uAE68\uC9C0\uAC70\uB098 \uC2A4\uD06C\uB864\uC774 \uC548 \uB420 \uB54C \uC7AC\uC5F0\uACB0\uB85C \uBCF5\uAD6C"),
          tool("\uD658\uACBD \uC124\uC815", "\uAE00\uAF34\xB7\uD06C\uAE30\xB7\uD14C\uB9C8\xB7\uCEE4\uC11C\xB7\uC2A4\uD06C\uB864 \uC18D\uB3C4")
        ),
        sec(
          "\uD074\uB85C\uB4DC \uCF54\uB4DC",
          kb(["Esc"], "\uC5D0\uC774\uC804\uD2B8\uAC00 \uD558\uB358 \uC791\uC5C5 \uBA48\uCD94\uAE30"),
          kb(["/"], "\uC4F8 \uC218 \uC788\uB294 \uBA85\uB839 \uBAA9\uB85D")
        )
      )
    );
    const back = el("div", { class: "pop-back", onclick: (e) => {
      if (e.target === back) back.remove();
    } }, pop);
    document.addEventListener("keydown", function esc(ev) {
      if (ev.key === "Escape") {
        back.remove();
        document.removeEventListener("keydown", esc);
      }
    });
    document.body.append(back);
  }
  var stripWS = (s) => String(s || "").replace(/\s+/g, "");
  function promptNeedles(text) {
    const first = String(text || "").split("\n").find((l) => l.trim()) || "";
    const s = stripWS(first);
    const out = [];
    if (s.length >= 4) out.push(s.slice(0, 60));
    if (s.length > 24) out.push(s.slice(0, 24));
    if (s.length > 12) out.push(s.slice(0, 12));
    if (!out.length && s) out.push(s);
    return [...new Set(out)];
  }
  function findRowIn(from, count, needles) {
    let b;
    try {
      b = term.buffer.active;
    } catch (_) {
      return -1;
    }
    const n = Math.max(0, Math.min(count, b.length - from));
    if (!n) return -1;
    const offs = new Array(n + 1);
    offs[0] = 0;
    let big = "";
    for (let i = 0; i < n; i++) {
      const ln = b.getLine(from + i);
      const t = ln ? stripWS(ln.translateToString(true)) : "";
      big += t;
      offs[i + 1] = offs[i] + t.length;
    }
    const rowOf = (off) => {
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const m = lo + hi + 1 >> 1;
        if (offs[m] <= off) lo = m;
        else hi = m - 1;
      }
      return from + lo;
    };
    for (const nd of needles) {
      const rows = [];
      let i = big.indexOf(nd);
      while (i !== -1 && rows.length < 50) {
        rows.push(rowOf(i));
        i = big.indexOf(nd, i + 1);
      }
      if (!rows.length) continue;
      const anchored = rows.find((y) => {
        const ln = b.getLine(y);
        const s = ln ? ln.translateToString(true).trimStart() : "";
        return s.startsWith(">");
      });
      return anchored !== void 0 ? anchored : rows[0];
    }
    return -1;
  }
  function flashRow(y) {
    try {
      term.clearSelection();
      term.select(0, y, term.cols);
      setTimeout(() => {
        try {
          term.clearSelection();
        } catch (_) {
        }
      }, 1600);
    } catch (_) {
    }
  }
  var promptSeek = null;
  function cancelPromptSeek(notice) {
    if (!promptSeek) return;
    promptSeek.stop = true;
    promptSeek = null;
    if (notice) toast("\uC9C8\uBB38 \uC704\uCE58 \uC774\uB3D9\uC744 \uC911\uB2E8\uD588\uC5B4\uC694");
  }
  function seekPromptInApp(needles) {
    const seek = { stop: false, ticks: 0 };
    promptSeek = seek;
    const colC = Math.max(1, Math.ceil(term.cols / 2)), rowC = Math.max(1, Math.ceil(term.rows / 2));
    const wheel = (btn, k) => {
      let s = "";
      for (let i = 0; i < k; i++) s += "\x1B[<" + btn + ";" + colC + ";" + rowC + "M";
      sendInput(s);
    };
    const visible = () => {
      try {
        const b = term.buffer.active;
        return findRowIn(b.baseY, term.rows, needles);
      } catch (_) {
        return -1;
      }
    };
    const BATCH = 6, WAIT = 110, MAX_BATCH = 900;
    let unchanged = 0, last = "";
    const finish = (foundRow) => {
      if (foundRow >= 0) {
        if (promptSeek === seek) promptSeek = null;
        flashRow(foundRow);
        return;
      }
      toast("\uD654\uBA74 \uAE30\uB85D\uC5D0\uC11C \uC774 \uC9C8\uBB38\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694 \u2014 \uC6D0\uB798 \uC704\uCE58\uB85C \uB3CC\uC544\uAC11\uB2C8\uB2E4", true);
      const back = (left) => {
        if (left <= 0 || seek.stop) {
          if (promptSeek === seek) promptSeek = null;
          return;
        }
        const k = Math.min(40, left);
        wheel(65, k);
        setTimeout(() => back(left - k), 30);
      };
      back(seek.ticks);
    };
    const step = (iter) => {
      if (seek.stop) return;
      const y = visible();
      if (y >= 0) {
        finish(y);
        return;
      }
      if (iter >= MAX_BATCH || unchanged >= 8) {
        finish(-1);
        return;
      }
      wheel(64, BATCH);
      seek.ticks += BATCH;
      setTimeout(() => {
        if (seek.stop) return;
        const cur = autosendReadScreen();
        if (cur === last) unchanged++;
        else {
          unchanged = 0;
          last = cur;
        }
        step(iter + 1);
      }, WAIT);
    };
    toast("\uC9C8\uBB38 \uC704\uCE58\uB85C \uC774\uB3D9 \uC911\u2026 (\uC544\uBB34 \uD0A4\uB098 \uB204\uB974\uBA74 \uC911\uB2E8)");
    step(0);
  }
  function jumpToPrompt(text) {
    cancelPromptSeek();
    const needles = promptNeedles(text);
    if (!needles.length) {
      toast("\uC774 \uC9C8\uBB38\uC740 \uB0B4\uC6A9\uC774 \uB108\uBB34 \uC9E7\uC544 \uC704\uCE58\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC5B4\uC694", true);
      return;
    }
    let alt = false, mouseOn = false;
    try {
      alt = term.buffer.active.type === "alternate";
    } catch (_) {
    }
    try {
      mouseOn = !!(term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== "none");
    } catch (_) {
    }
    if (!alt) {
      const y = findRowIn(0, term.buffer.active.length, needles);
      if (y < 0) {
        toast("\uD654\uBA74 \uAE30\uB85D\uC5D0\uC11C \uC774 \uC9C8\uBB38\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694 \u2014 \uAE30\uB85D\uC774 \uBC00\uB824\uB0AC\uC744 \uC218 \uC788\uC5B4\uC694", true);
        return;
      }
      try {
        term.scrollToLine(Math.max(0, y - 2));
      } catch (_) {
      }
      flashRow(y);
      return;
    }
    if (!mouseOn || sessionEnded || !ws || ws.readyState !== 1) {
      const b = term.buffer.active;
      const y = findRowIn(b.baseY, term.rows, needles);
      if (y >= 0) flashRow(y);
      else toast("\uC9C0\uAE08 \uD654\uBA74\uC5D0\uC120 \uC774 \uC9C8\uBB38\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694 (\uC138\uC158 \uC5F0\uACB0\uC774 \uC5C6\uC5B4 \uC2A4\uD06C\uB864 \uD0D0\uC0C9 \uBD88\uAC00)", true);
      return;
    }
    seekPromptInApp(needles);
  }
  window.livelyJumpToPrompt = function(text) {
    try {
      jumpToPrompt(String(text || ""));
    } catch (_) {
    }
  };
  function openMyPrompts() {
    const head = el(
      "div",
      { class: "help-head" },
      el("h3", { text: "\u{1F4AC} \uC774 \uC138\uC158\uC758 \uC9C8\uBB38" }),
      el("p", { class: "help-intro", text: "\uC774 \uC138\uC158\uC5D0\uC11C AI \uC5D0\uAC8C \uBCF4\uB0B8 \uC9C8\uBB38\uC744 \uB204\uAC00 \uBCF4\uB0C8\uB4E0 \uCD5C\uC2E0 \uC21C\uC73C\uB85C. \uD074\uB9AD\uD558\uBA74 \uADF8 \uC9C8\uBB38 \uC704\uCE58\uB85C \uC774\uB3D9\uD574\uC694." })
    );
    const body = el("div", { class: "help-body" }, el("div", { class: "q-empty", text: "\uBD88\uB7EC\uC624\uB294 \uC911\u2026" }));
    const pop = el(
      "div",
      { class: "pop pop-help" },
      el("button", { class: "help-x", title: "\uB2EB\uAE30", text: "\u2715", onclick: () => back.remove() }),
      head,
      body
    );
    const back = el("div", { class: "pop-back", onclick: (e) => {
      if (e.target === back) back.remove();
    } }, pop);
    document.addEventListener("keydown", function esc(ev) {
      if (ev.key === "Escape") {
        back.remove();
        document.removeEventListener("keydown", esc);
      }
    });
    document.body.append(back);
    const fmtWhen = (ts) => {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "";
      const s = (Date.now() - d.getTime()) / 1e3;
      if (s < 60) return "\uBC29\uAE08";
      if (s < 3600) return Math.floor(s / 60) + "\uBD84 \uC804";
      if (s < 86400) return Math.floor(s / 3600) + "\uC2DC\uAC04 \uC804";
      if (s < 604800) return Math.floor(s / 86400) + "\uC77C \uC804";
      return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
    };
    api(sUrl("/prompts")).then((d) => {
      const prompts = d && d.prompts || [];
      const total = d && d.total || prompts.length;
      if (!prompts.length) {
        body.replaceChildren(el("div", { class: "q-empty", text: d && d.found ? "\uC774 \uC138\uC158\uC5D0\uC11C \uBCF4\uB0B8 \uC9C8\uBB38\uC774 \uC544\uC9C1 \uC5C6\uC5B4\uC694." : "\uC774 \uC138\uC158\uC758 \uB300\uD654 \uAE30\uB85D\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694." }));
        return;
      }
      const multiAuthor = new Set(prompts.map((p) => p.author).filter(Boolean)).size > 1;
      const search = el("input", { class: "q-search", type: "search", placeholder: "\uC774 \uC138\uC158\uC758 \uC9C8\uBB38 \uAC80\uC0C9\u2026" });
      const cap = el("div", { class: "q-cap" });
      const list = el("div", { class: "q-list" });
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const terms = q ? q.split(/\s+/).filter(Boolean) : [];
        const seq = prompts.map((p, i) => ({ p, num: i + 1 })).reverse();
        const shown = terms.length ? seq.filter((x) => {
          const t = x.p.text.toLowerCase();
          return terms.every((w) => t.indexOf(w) >= 0);
        }) : seq;
        cap.textContent = terms.length ? shown.length + " / " + total + "\uAC1C \uC77C\uCE58" : total + "\uAC1C \uC9C8\uBB38 \xB7 \uCD5C\uC2E0\uC21C" + (total > prompts.length ? " (\uCD5C\uADFC " + prompts.length + "\uAC1C)" : "") + " \u2014 \uD074\uB9AD\uD558\uBA74 \uADF8 \uC704\uCE58\uB85C \uC774\uB3D9";
        list.replaceChildren();
        if (!shown.length) {
          list.append(el("div", { class: "q-empty", text: "\uC77C\uCE58\uD558\uB294 \uC9C8\uBB38\uC774 \uC5C6\uC5B4\uC694." }));
          return;
        }
        shown.forEach((x) => {
          const who = multiAuthor && x.p.author ? el("span", { class: "q-who", title: "\uC774 \uC9C8\uBB38\uC744 \uBCF4\uB0B8 \uC0AC\uB78C", text: x.p.author }) : null;
          list.append(el(
            "div",
            { class: "q-item", title: "\uD074\uB9AD\uD558\uBA74 \uD130\uBBF8\uB110\uC5D0\uC11C \uC774 \uC9C8\uBB38 \uC704\uCE58\uB85C \uC774\uB3D9", onclick: () => {
              back.remove();
              jumpToPrompt(x.p.text);
            } },
            el(
              "div",
              { class: "q-meta" },
              el("span", { class: "q-num", text: "#" + x.num }),
              ...who ? [who] : [],
              el("span", { class: "q-when", text: fmtWhen(x.p.ts) }),
              el("span", { class: "q-spacer" }),
              el("button", { class: "q-copy", title: "\uC774 \uC9C8\uBB38 \uD14D\uC2A4\uD2B8 \uBCF5\uC0AC", text: "\uBCF5\uC0AC", onclick: (e) => {
                e.stopPropagation();
                copyText(x.p.text, false, true);
              } })
            ),
            el("div", { class: "q-text", text: x.p.text })
          ));
        });
      };
      search.addEventListener("input", draw);
      body.replaceChildren(search, cap, list);
      draw();
      setTimeout(() => {
        try {
          search.focus();
        } catch (_) {
        }
      }, 0);
    }).catch((e) => {
      body.replaceChildren(el("div", { class: "q-empty", text: "\uC9C8\uBB38\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC5B4\uC694 \u2014 " + (e && e.message || e) }));
    });
  }
  function gate(msg) {
    document.getElementById("root").replaceChildren(el("div", { class: "gate-msg", text: msg }));
  }
  function gateLogin() {
    document.getElementById("root").replaceChildren(
      el(
        "div",
        { class: "gate-card" },
        el("div", { class: "gate-icon", text: "\u{1F512}" }),
        el("h2", { class: "gate-title", text: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD574\uC694" }),
        el("p", { class: "gate-sub", text: "\uC774 \uD130\uBBF8\uB110 \uC138\uC158\uC744 \uC5F4\uB824\uBA74 \uBA3C\uC800 \uB77C\uC774\uBE14\uB9AC\uC5D0 \uB85C\uADF8\uC778\uD558\uC138\uC694. \uC0C8 \uD0ED\uC5D0\uC11C \uB85C\uADF8\uC778\uD55C \uB4A4 \uC774 \uD398\uC774\uC9C0\uB85C \uB3CC\uC544\uC640 \u2018\uB2E4\uC2DC \uC2DC\uB3C4\u2019\uB97C \uB204\uB974\uBA74 \uBC14\uB85C \uC5F0\uACB0\uB429\uB2C8\uB2E4." }),
        el("a", { class: "gate-cta", href: apiUrl("/ui/"), target: "_blank", rel: "noopener", text: "\uC0C8 \uD0ED\uC5D0\uC11C \uB85C\uADF8\uC778\uD558\uAE30 \u2192" }),
        el("button", { class: "gate-retry", text: "\uB85C\uADF8\uC778\uD588\uC5B4\uC694 \u2014 \uB2E4\uC2DC \uC2DC\uB3C4", onclick: () => boot() })
      )
    );
  }
  function setTitle(label) {
    if (!label || !titleEl) return;
    titleEl.textContent = label;
    document.title = label + " \xB7 Lively";
  }
  function setProjectLink(projectId) {
    if (!projectBtnEl || !(projectId > 0)) return;
    projectBtnEl.href = apiUrl("/ui/#/projects2/p/") + projectId;
    projectBtnEl.style.display = "";
  }
  async function loadSessionMeta() {
    let data = null;
    try {
      data = await api(sUrl(""));
    } catch (_) {
    }
    if (data && data.label) setTitle(data.label);
    else if (SESSION_LABEL) setTitle(SESSION_LABEL);
    if (data) setProjectLink(Number(data.projectId) || 0);
    sessionProjectId = data && Number(data.projectId) || 0;
    showDropHint();
    return data;
  }
  function setupEmbedBridge() {
    window.addEventListener("message", (ev) => {
      if (ev.origin !== location.origin || ev.source !== window.parent) return;
      const m = ev.data;
      if (!m || m.type !== "lively-term") return;
      if (m.cmd === "reconnect") softReconnect();
      else if (m.cmd === "settings") openSettings();
      else if (m.cmd === "help") openHelp();
      else if (m.cmd === "prompts") openMyPrompts();
      else if (m.cmd === "focus") {
        try {
          term.focus();
        } catch (_) {
        }
      }
    });
    const post = () => {
      try {
        window.parent.postMessage({
          type: "lively-term-status",
          text: statusEl.textContent || "",
          cls: String(statusEl.className || "").replace("status", "").trim()
        }, location.origin);
      } catch (_) {
      }
    };
    try {
      new MutationObserver(post).observe(statusEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    } catch (_) {
    }
    post();
  }
  async function boot() {
    const p = prefs();
    scrollSpeed = Math.max(1, Math.min(12, Number(p.scrollSpeed) || 3));
    padGain = Math.max(0.5, Math.min(6, Number(p.padGain) || 3));
    applyChrome(p.theme);
    watchAppTheme();
    if (!SESSION_ID) {
      gate('\uC138\uC158\uC774 \uC9C0\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC138\uC158 \uBAA9\uB85D\uC5D0\uC11C "\uC5F4\uAE30"\uB85C \uC9C4\uC785\uD558\uC138\uC694.');
      return;
    }
    if (!window.Terminal || !window.FitAddon) {
      gate("\uD130\uBBF8\uB110 \uB77C\uC774\uBE0C\uB7EC\uB9AC(xterm) \uB85C\uB4DC \uC2E4\uD328.");
      return;
    }
    gate("\uC5F0\uACB0 \uC900\uBE44 \uC911\u2026");
    try {
      await api("/api/ui/me");
    } catch (_) {
      gateLogin();
      return;
    }
    explorerEl = el(
      "aside",
      { id: "explorer" },
      el(
        "div",
        { class: "exp-head" },
        el("span", { text: "\uD30C\uC77C" }),
        el("span", { class: "spacer" }),
        el("button", { class: "tbtn", text: "\uFF0B\uD3F4\uB354", title: "\uC0C8 \uD3F4\uB354", onclick: newFolder }),
        el("button", { class: "tbtn", text: "\u2B06", title: "\uC5C5\uB85C\uB4DC", onclick: startUpload }),
        el("button", { class: "tbtn", text: "\u27F3", title: "\uC0C8\uB85C\uACE0\uCE68", onclick: () => loadDir(curDir) })
      ),
      el("div", { id: "exp-path", class: "exp-path" }),
      el("div", { id: "exp-list" })
    );
    statusEl = el("span", { class: "status", text: "\uC5F0\uACB0 \uC911\u2026" });
    titleEl = el("span", { class: "title", text: SESSION_LABEL || "\uD130\uBBF8\uB110", title: SESSION_ID });
    if (SESSION_LABEL) document.title = SESSION_LABEL + " \xB7 Lively";
    projectBtnEl = el("a", {
      class: "tbtn",
      href: apiUrl("/ui/"),
      target: "_blank",
      rel: "noopener",
      text: "\u{1F5C2} \uD504\uB85C\uC81D\uD2B8 \uD398\uC774\uC9C0",
      title: "\uC774 \uC138\uC158\uC774 \uC18D\uD55C \uD504\uB85C\uC81D\uD2B8 \uD398\uC774\uC9C0 \uC5F4\uAE30(\uC0C8 \uD0ED)",
      style: "display:none; text-decoration:none"
    });
    const toolbar = el(
      "div",
      { class: "toolbar" },
      el("button", { class: "tbtn", text: "\u{1F4C1} \uD30C\uC77C \uD0D0\uC0C9\uAE30", title: "\uD30C\uC77C \uD0D0\uC0C9\uAE30 \uC5F4\uAE30/\uB2EB\uAE30 (\uC5C5\uB85C\uB4DC\xB7\uB2E4\uC6B4\uB85C\uB4DC)", onclick: toggleExplorer }),
      projectBtnEl,
      titleEl,
      el("span", { class: "spacer" }),
      statusEl,
      // #1018 로 임시로 숨겼던 버튼을 #1062 에서 되살렸다 — 당시 '제대로 작동하지 않던' 원인은 목록 수집이었다:
      //  서버가 공유 ~/.claude 의 **최신 대화 파일 하나**만 읽어, 멤버 프로필(#1014 이후 세션의 실제 기록 위치)과
      //  같은 폴더의 다른 대화가 통째로 빠졌다. 이제 전부 합쳐 준다(src/terminal-transcript.ts).
      //  '그 위치로 이동'은 여전히 화면 탐색 휴리스틱이라 못 찾을 수 있는데, 그 경우엔 조용히 실패하지 않고 토스트로 알린다.
      //  ⚠ 이 버튼은 그리드 각 셀(iframe=이 페이지)마다 하나씩 있어야 한다 — 그리드 상단 통합검색은 대체재가 아니다.
      el("button", { class: "tbtn", text: "\u{1F4AC} \uC9C8\uBB38", title: "\uC774 \uC138\uC158\uC5D0\uC11C AI \uC5D0\uAC8C \uBCF4\uB0B8 \uC9C8\uBB38 \uC804\uBD80(\uB204\uAC00 \uBCF4\uB0C8\uB4E0) \u2014 \uD074\uB9AD\uD558\uBA74 \uADF8 \uC704\uCE58\uB85C \uC774\uB3D9", onclick: openMyPrompts }),
      el("button", { class: "tbtn", text: "\u27F3 \uD654\uBA74 \uBCF5\uAD6C", title: "\uD654\uBA74\uC774 \uAE68\uC9C0\uAC70\uB098 \uC5B4\uAE0B\uB0AC\uC744 \uB54C \uC7AC\uC5F0\uACB0\uB85C \uBCF5\uAD6C(\uC18C\uD504\uD2B8 \uC0C8\uB85C\uACE0\uCE68)", onclick: softReconnect }),
      el("button", { class: "tbtn", text: "\u2699 \uD658\uACBD \uC124\uC815", onclick: openSettings }),
      el("button", { class: "tbtn", text: "\u24D8 \uC0AC\uC6A9\uBC95 \uC548\uB0B4", title: "\uD130\uBBF8\uB110\xB7\uB2E8\uCD95\uD0A4 \uAC04\uB2E8 \uC0AC\uC6A9\uBC95", onclick: openHelp })
    );
    const host = el("div", { id: "term-host" });
    termPane = el("div", { class: "pane active" }, host);
    tabbarEl = el("div", { id: "tabbar" });
    panesEl = el("div", { id: "panes" }, termPane);
    const main = EMBED ? el("div", { id: "main" }, tabbarEl, panesEl) : el("div", { id: "main" }, toolbar, tabbarEl, panesEl);
    document.getElementById("root").replaceChildren(EMBED ? el("div", { id: "ws" }, main) : el("div", { id: "ws" }, explorerEl, main));
    tabs.push({ id: "term", label: "\uD130\uBBF8\uB110", pane: termPane, closable: false });
    renderTabbar();
    if (!EMBED) setupDnd();
    setupTermDrop();
    if (EMBED) setupEmbedBridge();
    const metaAtBoot = loadSessionMeta();
    try {
      const ch = new BroadcastChannel("lively-terminal");
      ch.onmessage = (ev) => {
        const m = ev.data;
        if (m && m.type === "session-label" && m.id === SESSION_ID && m.label) setTitle(m.label);
      };
    } catch (_) {
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadSessionMeta();
    });
    window.addEventListener("focus", () => {
      loadSessionMeta();
    });
    term = new Terminal({
      fontFamily: p.fontFamily,
      fontSize: p.fontSize,
      cursorStyle: p.cursorStyle,
      cursorBlink: true,
      theme: resolveTheme(p.theme),
      scrollback: 1e4,
      allowProposedApi: true,
      // OSC 8 하이퍼링크(#1541) — TUI(claude 등)가 표시 텍스트와 별개의 URI 를 심는 형식. 핸들러가 없으면 xterm 은
      //  아무것도 안 한다(죽은 링크). 열기 규칙은 한 곳(openLinkFromTerminal) — 트래킹 pane 에선 클릭이 pty 로 가서
      //  이 핸들러까지 안 오는 경우가 있는데, 그 축은 아래 캡처 경로(urlAtColumn)가 표시 텍스트로 커버한다.
      linkHandler: { activate: (_e, uri) => openLinkFromTerminal(uri) },
      // tmux mouse on 이라도 선택할 수 있게: macOS 는 Option+드래그(iTerm 습관), 공통으로 Shift+드래그.
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => {
        e.preventDefault();
        openLinkFromTerminal(uri);
      }));
    }
    term.open(host);
    const linkAtEvent = (ev) => {
      if (!term) return null;
      const screen = host.querySelector(".xterm-screen");
      if (!screen) return null;
      const r = screen.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const col = Math.floor((ev.clientX - r.left) / (r.width / term.cols));
      const row = Math.floor((ev.clientY - r.top) / (r.height / term.rows));
      if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return null;
      const buf = term.buffer.active;
      if (!buf.getLine(buf.viewportY + row)) return null;
      let startY = buf.viewportY + row;
      while (startY > 0 && buf.getLine(startY)?.isWrapped) startY--;
      let text = "";
      let colInLogical = col;
      for (let y = startY; y < buf.length; y++) {
        const l = buf.getLine(y);
        if (!l || y > startY && !l.isWrapped) break;
        if (y < buf.viewportY + row) colInLogical += term.cols;
        text += l.translateToString(true).padEnd(term.cols);
      }
      return urlAtColumn(text, colInLogical);
    };
    const mouseTracked = () => {
      try {
        const m = term?.modes?.mouseTrackingMode;
        return !!m && m !== "none";
      } catch {
        return false;
      }
    };
    let pendingLink = null;
    host.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) {
        pendingLink = null;
        return;
      }
      const wantsLink = ev.metaKey || ev.ctrlKey || mouseTracked();
      pendingLink = wantsLink ? linkAtEvent(ev) : null;
      if (pendingLink || (ev.metaKey || ev.ctrlKey)) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);
    host.addEventListener("mouseup", (ev) => {
      if (pendingLink || (ev.metaKey || ev.ctrlKey) && ev.button === 0) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);
    host.addEventListener("click", (ev) => {
      if (!pendingLink) return;
      ev.stopPropagation();
      ev.preventDefault();
      const url = linkAtEvent(ev);
      if (url && url === pendingLink) openLinkFromTerminal(url);
      pendingLink = null;
    }, true);
    loadRenderer();
    loadTermFonts();
    setupClipboard();
    setupPaste();
    setupWheel();
    setupTouch();
    setupMobileDock(main);
    setupViewportFit();
    setupOscClipboard();
    setupTextareaHygiene();
    setupImeTrace();
    setupWebkitImeAdapter();
    applyFit();
    window.addEventListener("resize", doResize);
    try {
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(doResize);
        ro.observe(host);
      }
    } catch (_) {
    }
    term.onData(handleTermData);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (!ws || ws.readyState >= 2) {
        reconnectDelay = 1e3;
        connectNow();
      } else if (ws.readyState === 1) forceRedraw();
    });
    window.addEventListener("focus", () => {
      if (ws && ws.readyState === 1) forceRedraw();
    });
    if (await maybeRestoreOnOpen(await metaAtBoot)) return;
    connectNow();
  }
  async function maybeRestoreOnOpen(meta) {
    if (!meta || !meta.restorable) return false;
    restoreTried = true;
    const mode = goneMode(meta, !!NODE_ID, RESTORED, false);
    if (mode === "notowner") {
      endSession({
        info: true,
        icon: "\u21BB",
        title: "\uC774 \uC138\uC158\uC740 \uBA48\uCDB0 \uC788\uC2B5\uB2C8\uB2E4.",
        body: "\uC774\uC5B4\uC11C \uC5EC\uB294 \uAC74 \uC138\uC158\uC744 \uB9CC\uB4E0 \uC0AC\uB78C\uB9CC \uD560 \uC218 \uC788\uC5B4\uC694. \uC544\uB798 \uB9C8\uC9C0\uB9C9 \uD654\uBA74\uC740 \uADF8\uB300\uB85C \uC77D\uACE0 \uBCF5\uC0AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
      });
      return true;
    }
    if (mode === "loop") {
      endSession({
        info: true,
        icon: "\u21BB",
        title: "\uC774\uC5B4\uC11C \uC5F4\uC5C8\uC9C0\uB9CC \uC138\uC158\uC774 \uACE7 \uB2E4\uC2DC \uC885\uB8CC\uB410\uC5B4\uC694.",
        body: "\uC774\uC5B4\uBC1B\uC744 \uB300\uD654\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC744 \uC218 \uC788\uC5B4\uC694(\uC608: \uADF8 \uB300\uD654 \uAE30\uB85D\uC774 \uC774 \uD3F4\uB354\uC5D0 \uC5C6\uC74C). \uC544\uB798 \uBC84\uD2BC\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uBA74 \uB300\uD654 \uBAA9\uB85D\uC5D0\uC11C \uC9C1\uC811 \uACE0\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
        restoreBtn: true,
        restoreLabel: "\uB300\uD654 \uBAA9\uB85D\uC5D0\uC11C \uACE0\uB974\uAE30"
      });
      return true;
    }
    if (mode !== "auto") return false;
    if (handOffToShell(meta)) return true;
    startRestore(meta);
    return true;
  }
  function handOffToShell(meta) {
    if (!(EMBED && window.parent !== window)) return false;
    try {
      window.parent.postMessage({ type: "lively-term-gone", id: SESSION_ID, restorable: true, canRestore: !!(meta && meta.canRestore) }, location.origin);
    } catch (_) {
    }
    sessionEnded = true;
    showEndedBar({ info: true, icon: "\u21BB", title: "\uBA48\uCDB0 \uC788\uB294 \uC138\uC158\uC774\uC5D0\uC694.", body: "\uC774\uC5B4\uC11C \uC5F4\uACE0 \uC788\uC2B5\uB2C8\uB2E4 \u2014 \uC7A0\uC2DC\uB9CC\uC694.", restoreBtn: true, restoreLabel: "\uC5EC\uAE30\uC11C \uC774\uC5B4\uC11C \uC5F4\uAE30" });
    return true;
  }
  function startRestore(meta) {
    sessionEnded = true;
    try {
      term.options.disableStdin = true;
      term.blur();
    } catch (_) {
    }
    try {
      statusEl.textContent = "\uC774\uC5B4\uC11C \uC5EC\uB294 \uC911\u2026";
      statusEl.className = "status";
    } catch (_) {
    }
    showRestoringBanner(meta);
    restoreThisSession();
  }
  var reconnectTimer = null, reconnectDelay = 1500, wasConnected = false, connecting = false, attempts = 0;
  var denyRetries = 0;
  var MAX_DENY_RETRIES = 5;
  var sessionEnded = false;
  var MAX_RECONNECT_ATTEMPTS = 40;
  var gaveUp = false;
  function scheduleReconnect(label) {
    clearTimeout(reconnectTimer);
    if (sessionEnded || gaveUp) return;
    attempts++;
    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      giveUpReconnect();
      return;
    }
    try {
      statusEl.textContent = label + (attempts > 1 ? " (" + attempts + "\uD68C\uC9F8)" : "");
      statusEl.className = "status err";
    } catch (_) {
    }
    reconnectTimer = setTimeout(connectNow, reconnectDelay);
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5e3);
  }
  async function giveUpReconnect() {
    let retryAfterMs = 0;
    try {
      const r = await fetch(apiUrl("/healthz"), { cache: "no-store" });
      if (r.status === 503) {
        const ra = Number(r.headers.get("retry-after") || 0);
        retryAfterMs = Math.min(Math.max(ra > 0 ? ra * 1e3 : 5e3, 1e3), 3e4);
      }
    } catch (_) {
    }
    if (retryAfterMs) {
      attempts = 0;
      reconnectDelay = retryAfterMs;
      try {
        statusEl.textContent = "\uC11C\uBC84\uAC00 \uC900\uBE44 \uC911\uC785\uB2C8\uB2E4 \u2014 \uC7A0\uC2DC \uD6C4 \uC790\uB3D9\uC73C\uB85C \uC5F0\uACB0\uB429\uB2C8\uB2E4";
        statusEl.className = "status err";
      } catch (_) {
      }
      reconnectTimer = setTimeout(connectNow, retryAfterMs);
      return;
    }
    gaveUp = true;
    clearTimeout(reconnectTimer);
    try {
      statusEl.textContent = "\uC5F0\uACB0\uD560 \uC218 \uC5C6\uC74C";
      statusEl.className = "status err";
    } catch (_) {
    }
    showRetryBar();
  }
  function showRetryBar() {
    if (document.getElementById("retry-bar")) return;
    const bar = el(
      "div",
      { class: "ended-bar", id: "retry-bar" },
      el("span", { text: "\uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uB124\uD2B8\uC6CC\uD06C\uB098 \uAC8C\uC774\uD2B8\uC6E8\uC774 \uC0C1\uD0DC\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." }),
      el("button", {
        class: "gate-retry",
        text: "\uB2E4\uC2DC \uC2DC\uB3C4",
        onclick: () => {
          const b = document.getElementById("retry-bar");
          if (b && b.parentNode) b.parentNode.removeChild(b);
          gaveUp = false;
          attempts = 0;
          reconnectDelay = 1500;
          connectNow();
        }
      })
    );
    const root = document.getElementById("root");
    if (root) root.insertBefore(bar, root.firstChild);
  }
  function endSession(opts) {
    if (sessionEnded) return;
    sessionEnded = true;
    clearTimeout(reconnectTimer);
    try {
      if (ws && ws.readyState <= 1) ws.close();
    } catch (_) {
    }
    try {
      statusEl.textContent = "\uC138\uC158 \uC885\uB8CC\uB428";
      statusEl.className = "status end";
    } catch (_) {
    }
    try {
      term.options.disableStdin = true;
      term.blur();
    } catch (_) {
    }
    if (!document.title.startsWith("(\uC885\uB8CC\uB428)")) document.title = "(\uC885\uB8CC\uB428) " + document.title;
    showEndedBar(opts || {});
  }
  function showEndedBar(o) {
    const main = document.getElementById("main");
    if (!main) return;
    const old = main.querySelector(".ended-bar");
    if (old) old.remove();
    const txt = el("span", { class: "ended-txt" }, el("b", { text: o.title || "\uC774 \uC138\uC158\uC740 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4." }), " " + (o.body || "\uC138\uC158\uC774 \uB05D\uB0AC\uAC70\uB098(exit) \uC0AD\uC81C\uB418\uC5B4 \uC11C\uBC84\uC5D0 \uB354 \uC774\uC0C1 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uC811\uC18D \uC624\uB958\uAC00 \uC544\uB2D9\uB2C8\uB2E4. \uC544\uB798 \uB9C8\uC9C0\uB9C9 \uD654\uBA74\uC740 \uADF8\uB300\uB85C \uC77D\uACE0 \uBCF5\uC0AC\uD560 \uC218 \uC788\uC5B4\uC694."));
    const bar = el("div", { class: "ended-bar" + (o.info ? " info" : "") }, el("span", { class: "ended-ic", text: o.icon || "\u23F9" }), txt);
    if (o.restoreBtn) {
      const rb = el("button", { class: "ended-cta", text: o.restoreLabel || "\uB2E4\uC2DC \uC5F4\uAE30" });
      rb.onclick = () => {
        rb.disabled = true;
        rb.textContent = "\uC5EC\uB294 \uC911\u2026";
        restoreThisSession();
      };
      bar.append(rb);
    }
    bar.append(el("a", { class: "ended-cta", href: apiUrl("/ui/#/terminal"), target: "_blank", rel: "noopener", text: "\uC138\uC158 \uBAA9\uB85D \uC5F4\uAE30 \u2192" }));
    main.insertBefore(bar, panesEl);
  }
  function goneMode(meta, isNode, alreadyRestored, typed) {
    void isNode;
    if (!meta || !meta.restorable) return "end";
    if (!meta.canRestore) return "notowner";
    if (typed) return "ask";
    if (alreadyRestored) return "loop";
    return "auto";
  }
  var restoreTried = false;
  var userTyped = false;
  async function onSessionGone() {
    if (sessionEnded || restoreTried) {
      endSession();
      return;
    }
    restoreTried = true;
    clearTimeout(reconnectTimer);
    let meta = null;
    try {
      meta = await api(sUrl(""));
    } catch (_) {
    }
    const mode = goneMode(meta, !!NODE_ID, RESTORED, userTyped);
    if (mode === "end") {
      endSession();
      return;
    }
    if (mode === "loop") {
      endSession({
        info: true,
        icon: "\u21BB",
        title: "\uC774\uC5B4\uC11C \uC5F4\uC5C8\uC9C0\uB9CC \uC138\uC158\uC774 \uACE7 \uB2E4\uC2DC \uC885\uB8CC\uB410\uC5B4\uC694.",
        body: "\uC774\uC5B4\uBC1B\uC744 \uB300\uD654\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC744 \uC218 \uC788\uC5B4\uC694(\uC608: \uADF8 \uB300\uD654 \uAE30\uB85D\uC774 \uC774 \uD3F4\uB354\uC5D0 \uC5C6\uC74C). \uC544\uB798 \uBC84\uD2BC\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uBA74 \uB300\uD654 \uBAA9\uB85D\uC5D0\uC11C \uC9C1\uC811 \uACE0\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
        restoreBtn: true,
        restoreLabel: "\uB300\uD654 \uBAA9\uB85D\uC5D0\uC11C \uACE0\uB974\uAE30"
      });
      return;
    }
    if (mode === "notowner") {
      endSession({ info: true, icon: "\u21BB", title: "\uC774 \uC138\uC158\uC740 \uC911\uB2E8\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.", body: "\uC774\uC5B4\uC11C \uC5EC\uB294 \uAC74 \uC138\uC158\uC744 \uB9CC\uB4E0 \uC0AC\uB78C\uB9CC \uD560 \uC218 \uC788\uC5B4\uC694. \uC544\uB798 \uB9C8\uC9C0\uB9C9 \uD654\uBA74\uC740 \uADF8\uB300\uB85C \uC77D\uACE0 \uBCF5\uC0AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4." });
      return;
    }
    if (mode === "ask") {
      endSession({
        info: true,
        title: "\uC774 \uC138\uC158\uC774 \uBC29\uAE08 \uB05D\uB0AC\uC2B5\uB2C8\uB2E4.",
        body: "\uC774 \uD0ED\uC5D0\uC11C \uC870\uC791\uD55C \uB4A4 \uB05D\uB0AC\uC5B4\uC694 \u2014 \uC9C1\uC811 \uC885\uB8CC\uD55C \uAC83\uC774\uBA74 \uADF8\uB300\uB85C \uB450\uC2DC\uBA74 \uB429\uB2C8\uB2E4. \uC544\uB2C8\uB77C\uBA74 \uB300\uD654\uB97C \uC774\uC5B4\uC11C \uB2E4\uC2DC \uC5F4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
        restoreBtn: true
      });
      return;
    }
    if (handOffToShell(meta)) return;
    startRestore(meta);
  }
  function showRestoringBanner(meta) {
    const why = meta && meta.exitedByUser ? "\uC9C1\uC811 \uC885\uB8CC\uD588\uB358 \uC138\uC158\uC774\uC5D0\uC694." : meta && meta.oomKilled ? "\uBA54\uBAA8\uB9AC\uAC00 \uBAA8\uC790\uB77C \uBA48\uCDC4\uB358 \uC138\uC158\uC774\uC5D0\uC694." : "\uC7AC\uBD80\uD305\uC774\uB098 \uC790\uB3D9 \uD68C\uC218\uB85C \uBA48\uCDB0 \uC788\uB358 \uC138\uC158\uC774\uC5D0\uC694.";
    showEndedBar({
      info: true,
      icon: "\u21BB",
      title: "\uC138\uC158\uC744 \uC774\uC5B4\uC11C \uC5EC\uB294 \uC911\u2026",
      body: why + " \uAC19\uC740 \uD3F4\uB354\xB7\uC124\uC815\uC73C\uB85C \uB2E4\uC2DC \uC5F4\uACE0 \uB300\uD654\uB97C \uC774\uC5B4\uBC1B\uC2B5\uB2C8\uB2E4."
    });
  }
  async function restoreThisSession() {
    try {
      if (ws && ws.readyState <= 1) ws.close();
    } catch (_) {
    }
    let r = null;
    try {
      r = await api(sUrl("/restore"), { method: "POST", body: "{}" });
    } catch (e) {
      sessionEnded = true;
      showEndedBar({ title: "\uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", body: (e && e.message || String(e)) + " \u2014 \uC138\uC158 \uBAA9\uB85D\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." });
      return;
    }
    if (r && r.already) {
      location.reload();
      return;
    }
    const ns = r && r.session;
    if (ns && ns.id) {
      location.replace(apiUrl("/ui/terminal.html?session=") + encodeURIComponent(ns.id) + "&label=" + encodeURIComponent(ns.label || SESSION_LABEL || "") + "&restored=1" + (ns.node && ns.node.id ? "&node=" + encodeURIComponent(ns.node.id) : ""));
      return;
    }
    sessionEnded = true;
    showEndedBar({ title: "\uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", body: "\uC11C\uBC84\uAC00 \uC0C8 \uC138\uC158\uC744 \uB3CC\uB824\uC8FC\uC9C0 \uC54A\uC558\uC5B4\uC694 \u2014 \uC138\uC158 \uBAA9\uB85D\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." });
  }
  async function connectNow() {
    if (sessionEnded) return;
    if (connecting) return;
    if (ws && ws.readyState <= 1) return;
    connecting = true;
    clearTimeout(reconnectTimer);
    try {
      await api("/api/ui/terminal/ticket", { method: "POST" });
    } catch (e) {
      connecting = false;
      scheduleReconnect("\uAC8C\uC774\uD2B8\uC6E8\uC774 \uC751\uB2F5 \uC5C6\uC74C \u2014 \uC7AC\uC5F0\uACB0 \uC911\u2026");
      return;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(proto + "://" + location.host + apiUrl("/terminal/ws") + "?session=" + encodeURIComponent(SESSION_ID) + nodeQ("&"));
    sock.binaryType = "arraybuffer";
    ws = sock;
    ctrl = makeControl({
      write: (str) => {
        try {
          term.write(str);
        } catch (_) {
        }
      },
      // 상태 블록(백필 직전) — tmux pane 실상태로 alt-screen·마우스모드를 '지금' 동기화하고, 커서 좌표를 백필용으로 담아둠(#1092).
      state: (line) => {
        try {
          dlog("state", diagPreview(line, 96));
          const st = parsePaneState(line);
          applyPaneState(st);
          const wantCap = needBackfill || wantRedrawCap;
          needBackfill = false;
          wantRedrawCap = false;
          if (!wantCap) return;
          if (!captureAllowed(st)) {
            dlog("backfill", "\uCEA1\uCC98 \uBD88\uAC00(psmux + \uC571 \uD32C) \u2192 \uB11B\uC9C0\uB85C \uC7AC\uADF8\uB9AC\uAE30 \xB7 cmd=" + (st.cmd || "?"));
            doNudge();
            return;
          }
          try {
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ t: "cap", n: BACKFILL_LINES, st: 1 }));
              armBackfillWatch();
            }
          } catch (_) {
          }
        } catch (_) {
        }
      },
      // 닫히지 않는 블록을 포기했다 — 백필은 오지 않는다. 앱이 스스로 다시 그리게 넛지한다.
      blockLost: () => {
        try {
          dlog("backfill", "\uBBF8\uC644\uACB0 \uBE14\uB85D \uD3EC\uAE30 \u2192 \uB11B\uC9C0\uB85C \uC7AC\uADF8\uB9AC\uAE30 \uC720\uB3C4");
          doNudge();
        } catch (_) {
        }
      },
      // 백필(capture 스냅샷)은 '현재 화면 전체'다 → 쓰기 전 화면+스크롤백을 비워(\e[H\e[2J\e[3J) 첫 연결 중
      //  attach~capture 사이에 먼저 흘러든 라이브 %output 과 겹쳐 줄이 중복되는 것을 막는다. 이후 라이브는 그대로 append.
      backfill: (text) => {
        try {
          clearBackfillWatch();
          const st = pendingPaneState;
          pendingPaneState = null;
          dlog("backfill", "len=" + text.length + (st ? " +state" : ""));
          if (!st && term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== "none" && term.buffer && term.buffer.active && term.buffer.active.type !== "alternate") {
            term.write("\x1B[?1049h");
          }
          term.write("\x1B[H\x1B[2J\x1B[3J\x1B[0m");
          term.write(text);
          if (st && st.hasCursor) term.write("\x1B[" + (st.cy + 1) + ";" + (st.cx + 1) + "H");
        } catch (_) {
        }
      },
      // tmux control 스트림의 %exit — 이 attach 클라가 끝났다는 뜻일 뿐, '세션이 죽었다'는 뜻은 아니다
      //  (게이트웨이 재배포로 attach PTY 가 kill 돼도 %exit 이다). 그래서 여기서 종료를 단정하지 않고, 곧바로
      //  재연결해 서버에게 물어본다(살아있으면 그대로 붙고, 진짜 없으면 4410 이 와서 종료 배너). 짧은 지연으로 빠르게 판정.
      onExit: () => {
        reconnectDelay = 400;
        try {
          sock.close();
        } catch (_) {
        }
      }
    });
    sock.onopen = () => {
      dlog("ws", "open");
      connecting = false;
      wasConnected = true;
      reconnectDelay = 1500;
      denyRetries = 0;
      attempts = 0;
      gaveUp = false;
      syncedThisConn = false;
      nudgeTries = 0;
      needBackfill = !didBackfill;
      wantRedrawCap = false;
      lastKnownState = null;
      mouseResetTries = 0;
      statusEl.textContent = "\uC5F0\uACB0\uB428";
      statusEl.className = "status ok";
      lastCols = 0;
      lastRows = 0;
      applyFit();
      setTimeout(applyFit, 350);
      initialSettleRedraw();
      term.focus();
      if (AUTOSEND && !autosendDone) {
        autosendDeadline = Date.now() + 12e3;
        autosendLastOut = Date.now();
        scheduleAutosend();
      }
    };
    sock.onmessage = (e) => {
      const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : typeof e.data === "string" ? new TextEncoder().encode(e.data) : null;
      if (!bytes) return;
      ctrl.feed(bytes);
      if (AUTOSEND && !autosendDone) autosendLastOut = Date.now();
      if (ctrl.isControl()) {
        if (!didBackfill) {
          didBackfill = true;
          try {
            sock.send(JSON.stringify({ t: "st" }));
          } catch (_) {
          }
        } else if (!syncedThisConn) {
          syncedThisConn = true;
          try {
            sock.send(JSON.stringify({ t: "st" }));
          } catch (_) {
          }
        }
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      dlog("ws", "close " + (e && e.code || ""));
      connecting = false;
      if (e && e.code === 4410) {
        onSessionGone();
        return;
      }
      if (e && e.code === 4403) {
        if (++denyRetries <= MAX_DENY_RETRIES) {
          scheduleReconnect("\uC5F0\uACB0 \uD655\uC778 \uC911\u2026");
          return;
        }
        clearTimeout(reconnectTimer);
        gate("\uC774 \uC138\uC158\uC5D0 \uC785\uC7A5\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.\n\n\uD504\uB85C\uC81D\uD2B8 \uD300\uC6D0\uB9CC \uC785\uC7A5\uD560 \uC218 \uC788\uC5B4\uC694. \uB610\uB294 \uC774 \uC138\uC158\uC774 \uB354 \uC774\uC0C1 \uD504\uB85C\uC81D\uD2B8\uC5D0 \uC5F0\uACB0\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4(\uD3F4\uB354 \uC774\uB3D9\xB7\uD504\uB85C\uC81D\uD2B8 \uC0AD\uC81C \uB4F1). \uD504\uB85C\uC81D\uD2B8 \uD398\uC774\uC9C0\uC5D0\uC11C \uC138\uC158\uC744 \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
        return;
      }
      if (e && e.code === 4462) {
        scheduleReconnect("\uC774 \uC138\uC158\uC758 \uB178\uB4DC\uAC00 \uC5F0\uACB0\uB3FC \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 \u2014 \uC7AC\uC5F0\uACB0 \uC911\u2026");
        return;
      }
      scheduleReconnect(wasConnected ? "\uC5F0\uACB0 \uB04A\uAE40 \u2014 \uC7AC\uC5F0\uACB0 \uC911\u2026" : "\uC7AC\uC5F0\uACB0 \uC911\u2026");
    };
    sock.onerror = () => {
    };
  }
  var explorerLoaded = false;
  function toggleExplorer() {
    explorerEl.classList.toggle("open");
    if (explorerEl.classList.contains("open") && !explorerLoaded) {
      explorerLoaded = true;
      loadDir("");
    }
    setTimeout(doResize, 180);
  }

  // web/standalone/terminal.entry.ts
  boot();
})();
