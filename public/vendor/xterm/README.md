# xterm.js — vendored copy (#3537)

*[한국어](README.ko.md)*

xterm.js and the four add-ons used by the terminal screen (`public/terminal.html`). **We self-host them.**

## Why we moved off the CDN

Previously all six files came from `cdn.jsdelivr.net`, and `xterm.min.css` among them was a **render-blocking stylesheet**
in `<head>`. In other words, **the first pixel of the session screen was tied to a round trip to a third-party CDN** —
every time a session was opened, and every time the iframe reloaded.

This is exactly the stretch where people measure «when does Claude Code show up» (#3537 investigation), so it's not a place to leave to
someone else's infrastructure. The gateway already serves `public/`, so serving from the same origin removes
DNS · TLS · the round trip entirely, and also eliminates the cases where, on restricted networks (corporate intranets · China), **the terminal
didn't load at all**.

## Versions (pinned)

| File | Package | Version |
|---|---|---|
| `xterm.min.css` · `xterm.min.js` | `@xterm/xterm` | 5.5.0 |
| `addon-fit.min.js` | `@xterm/addon-fit` | 0.10.0 |
| `addon-webgl.min.js` | `@xterm/addon-webgl` | 0.18.0 |
| `addon-canvas.min.js` | `@xterm/addon-canvas` | 0.7.0 |
| `addon-web-links.min.js` | `@xterm/addon-web-links` | 0.11.0 |

Downloaded from: `https://cdn.jsdelivr.net/npm/<package>@<version>/<path>` (2026-09-04).
The versions are **exactly the ones the old `terminal.html` had pinned** — this commit changed only «where we get them from»,
not «what we get» (to avoid introducing any behavior difference).

## Upgrading

Download from the same URL, overwrite with the same file names, and update the versions in the table above. `terminal.html` refers to the
file names, so it doesn't need to be touched. The add-ons have compatibility ranges with the xterm core, so upgrade them **together**.
