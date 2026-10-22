#!/usr/bin/env python3
"""Serve the built WhoT frontend with the Tauri mock backend injected.

Requires a fresh build first:  npm run build   (writes dist/).

Usage:
    python3 server.py [PORT]      # default 8123

The server rewrites index.html so that /mock.js (a classic script that
installs window.__TAURI_INTERNALS__) loads before the app module bundle.
/snap.json is served from this directory (gitignored — regenerate with
dump_snap.py). The mock state is per page-load: every navigation starts
from a clean snapshot.
"""
import http.server
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
DIST = HERE.parents[1] / "dist"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def _send(self, code, ctype, data: bytes):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    LOGGER = """
    // optional listener logger — served only for ?log=1 URLs
    if (/[?&]log=1/.test(location.search)) {
      window.__L = { reg: [], run: [] };
      const origAdd = window.addEventListener.bind(window);
      const origRem = window.removeEventListener.bind(window);
      window.addEventListener = (t, fn, o) => {
        if (t === 'keydown' && typeof fn === 'function') {
          const id = window.__L.reg.length;
          window.__L.reg.push({ id, at: Math.round(performance.now()),
                                src: (fn.toString() || '').replace(/\\s+/g, ' ').slice(0, 80) });
          const w = function (e) {
            window.__L.run.push({ id, key: e.key, trusted: e.isTrusted });
            return fn.call(this, e);
          };
          w.__lid = id;
          return origAdd(t, w, o);
        }
        return origAdd(t, fn, o);
      };
      window.removeEventListener = (t, fn, o) => {
        if (t === 'keydown' && fn && typeof fn.__lid === 'number') {
          window.__L.reg[fn.__lid].removedAt = Math.round(performance.now());
          return origRem(t, fn, o);
        }
        return origRem(t, fn, o);
      };
    }
    """

    def do_GET(self):
        from urllib.parse import urlsplit

        path = urlsplit(self.path).path
        if path == "/snap.json":
            f = HERE / "snap.json"
            if not f.exists():
                return self._send(404, "text/plain",
                                  b"run python3 dump_snap.py first")
            return self._send(200, "application/json", f.read_bytes())
        if path == "/mock.js":
            return self._send(200, "application/javascript",
                              (HERE / "mock.js").read_bytes())
        if path == "/log.js":
            return self._send(200, "application/javascript",
                              self.LOGGER.encode())
        if path in ("/", "/index.html"):
            html = (DIST / "index.html").read_text()
            if "/mock.js" not in html:
                html = html.replace(
                    '<script type="module"',
                    '<script src="/mock.js"></script>\n    <script type="module"',
                    1,
                )
            if "/log.js" not in html:
                html = html.replace(
                    '<script src="/mock.js"></script>',
                    '<script src="/mock.js"></script>\n    <script src="/log.js"></script>',
                    1,
                )
            return self._send(200, "text/html", html.encode())
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    if not (DIST / "index.html").exists():
        sys.exit(f"{DIST}/index.html not found — run `npm run build` first")
    if not (HERE / "snap.json").exists():
        sys.exit(f"{HERE / 'snap.json'} not found — run `python3 dump_snap.py` first")
    print(f"serving {DIST} with mock on http://127.0.0.1:{port}/")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
