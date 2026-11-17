# Chapter 6 — Installation

Status: written — awaiting review
(Linux only, for now: the package route covers the three variants the
build produces — `.deb`, `.rpm`, AppImage; the sources route assumes a
Linux desktop.)

*What you will learn: two ways to put Whot on a Linux machine — from a
ready-made package, or from the sources — and how to prepare the face
finder both routes share.*

Choose by how you want to work:

- **§6.1 From a package** — install one file and start. Best if you just
  want to use Whot.
- **§6.2 From sources** — run Whot straight from the project folder.
  Best if you want the newest state, or plan to help develop it.

Both routes end at **§6.3**, the face finder, which importing a film roll
needs. Everything else in this manual works the same whichever route you
chose.

---

## 6.1 Installing from a package

Whot ships in three Linux variants — pick the one your distribution uses:

| Variant | For | Install with |
| --- | --- | --- |
| `.deb` | Debian, Ubuntu, and derivatives | `sudo apt install ./whot_<version>_amd64.deb` |
| `.rpm` | Fedora, openSUSE, and derivatives | `sudo dnf install ./whot-<version>.x86_64.rpm` |
| AppImage | any Linux desktop | make it executable (`chmod +x whot_<version>_amd64.AppImage`) and run it |

The `.deb` and `.rpm` packages bring the pieces the desktop needs with
them; the AppImage likewise carries its own runtime — it only asks for a
normal graphical desktop.

**What first use sets up.** Nothing is installed into your home folder at
install time. On first start Whot creates your personal settings file at
`~/.config/whot/whotrc.json` (from the default the package carries) and
keeps its records under `~/.local/share/whot`. You never need to touch
either by hand: the **environment…** dialog (⚙ → *environment…*) shows
both and lets you point Whot at your picture folders and legacy sources
(Ch. 5.1; the legacy sources are the ones Ch. 3 needs).

**Good to know**

- Reviewing, editing and exporting work out of the box.
- **Importing a film roll does not yet come with the package** — the
  import tooling lives in the sources (§6.2). Until your package includes
  it, install the sources as well and follow §6.3; Whot will find the
  import tooling there.
- The first start of a fresh install shows the *No database yet* dialog —
  that is Ch. 1.1's normal first-run flow, not a problem.

## 6.2 Installing from sources

Two depths are possible: the **minimal** route gets an app running; the
**full development platform** adds everything needed to build, test and
produce the packages themselves.

### Prerequisites (both depths)

1. **Node.js 22 or newer** — the frontend's toolchain
   (`node --version` to check; from your distribution, or from
   [nodejs.org](https://nodejs.org)).
2. **Rust** — the app's engine, installed through
   [rustup](https://rustup.rs):

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. **The desktop libraries and build tools** Whot builds against. The
   essential pair is the WebKitGTK 4.1 webview and GTK 3; the rest are
   the compiler and helpers the build and packaging need. Package names
   per distribution, for example:
   - Fedora:

     ```sh
     sudo dnf install webkit2gtk4.1-devel glib2-devel gtk3-devel \
         libsoup3-devel gcc gcc-c++ librsvg2-devel libxdo-devel \
         openssl-devel file pkg-config
     ```
   - Debian/Ubuntu:

     ```sh
     sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libglib2.0-dev \
         libsoup-3.0-dev build-essential librsvg2-dev libxdo-dev \
         libssl-dev file pkg-config
     ```

   `glib2-devel` and `libsoup3-devel` (Debian: `libglib2.0-dev` and
   `libsoup-3.0-dev`) normally come along automatically as dependencies
   of the WebKitGTK development package, but naming them costs nothing.
   Your distribution's Tauri documentation lists the exact set for it.

### Minimal route — just get it running

```sh
git clone <the project's repository URL> whot
cd whot
npm install
cp env.sample .env          # then edit .env — see below
npm run tauri dev
```

The first `npm run tauri dev` compiles the engine (several minutes; after
that, starts are quick). The window that opens is the app from Chapter 0.

**Pointing Whot at your machine** — copy `env.sample` to `.env` (done
above) and set the paths it lists: where your picture folders and archive
live (`DEFAULT_IMAGES_DIR`, `ARCHIVE_DIR`), and — after §6.3 — where the
face finder lives (`INSIGHTFACE_PATH`). Every key has a comment in the
file; anything you leave out falls back to its default, and the
**environment…** dialog (⚙) shows what Whot actually resolved.

With no database yet, the app opens with *No database yet* — click
**Open import pane** and import your first roll (Ch. 1.1); Whot creates
its record store as part of that flow.

### Full development platform — build, test, package

The minimal route already compiles everything; this adds the test
suites and the packaging:

```sh
npm run build               # the web frontend → dist/ (needed by the tests below)
npm test                    # frontend unit tests
npx tsc --noEmit            # type check
npm run lint
(cd src-tauri && cargo test)   # engine tests
python3 -m pytest test/ -q  # import/recovery script tests (needs numpy + blake3)
npm run tauri build         # produces the .deb / .rpm / AppImage of §6.1
```

**Good to know**

- The `tauri` command itself comes from the project: `npm install` adds
  `@tauri-apps/cli`, which is what `npm run tauri dev/build` calls. A
  separate `cargo install tauri-cli` is only for running the CLI without
  Node — Whot does not need it.
- The first `npm run tauri build` needs network access: the AppImage
  packaging tool is downloaded on demand. Later builds reuse it.
- The Python tests cover more files when `opencv-python-headless`, `Pillow`
  and `tifffile` are also installed in the same environment the tests run
  in — the picture-decoding tests are skipped otherwise.
- The app's GUI contract harness (the automated browser checks) additionally
  needs `selenium` and the system `WebKitWebDriver`, plus a display — your
  desktop session, or a private virtual one (Xvfb/Xvnc) when the desktop is
  idle. See the project README's test section for the exact commands.
- The packages `npm run tauri build` produces are the same three variants
  §6.1 installs — building them yourself is optional.

## 6.3 The face finder (both routes)

Importing a roll means looking at every picture — that work is done by the
[insightface](https://github.com/deepinsight/insightface) toolkit in its
own small Python environment, set up once:

```sh
mkdir -p ../insightface && python3 -m venv ../insightface/insight_env
../insightface/insight_env/bin/pip install insightface onnxruntime \
    opencv-python-headless rawpy blake3 numpy
```

(Skip the `mkdir` if you keep the venv elsewhere — any location works.)
Then tell Whot where it lives: set `INSIGHTFACE_PATH` to the folder that
*contains* `insight_env` — in the `.env` file (sources route) or in the
environment dialog (installed route).

**Good to know**

- On some distributions (Fedora among them) Python installs its packages
  under a `lib64/` path instead of `lib/`; the import tooling looks in
  both, so this needs no action from you.
- The face finder is only used at import time. Reviewing, editing and
  exporting never touch it.
- A roll import can use the computer's graphics card (`--gpu` in the
  import pane), but the safe default is the processor — leave it as is
  unless you have a reason to change it (Ch. 1.1).
