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

  // web/standalone/md.entry.ts
  Object.assign(window, { el, safeHref, mdImage, renderInline, mdParseContainerAttrs, mdRenderContainer, renderMarkdown });
})();
