//! #167 — the import runner: spawn/monitor/kill `scripts/import_roll.py`
//! as an independent child process + the `scan_import_dir` fs probe.
//! Behaviour rules: docs/gui-design.md §4.36; structure:
//! docs/backend-design.md §7.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// the script's IMAGE_SUFFIXES (import_roll.py) — exact parity (#169),
/// incl. the RAW formats the importer decodes
const IMAGE_SUFFIXES: [&str; 14] = [
    ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".pef", ".dng", ".cr2", ".cr3", ".nef",
    ".arw", ".rw2", ".orf", // ".heic"/".avif" are NOT the script's — never probe them
];
/// the script's THRESHOLD_DEFAULT (import_roll.py) — the GUI's default too
pub const THRESHOLD_DEFAULT: f64 = 0.40;
/// the line buffer never grows without bound: a chatty --recursive scan
/// of a huge tree must not eat the GUI's memory (oldest lines dropped)
const MAX_LINES: usize = 5000;

/// per-roll CLI options, mapped 1:1 onto import_roll.py's argparse
/// surface (scripts-design §8; the pane's toggles — gui-design §4.36).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub roll_dir: String,
    pub dry_run: bool,
    pub all: bool,
    pub gpu: bool,
    pub threshold: f64,
    pub recursive: bool,
    pub create_db: bool,
}

/// render the flag vector (deterministic order); refuses the
/// `--create-db` + `--dry-run` combination before anything spawns —
/// the script's `validate_args` would reject it too (creation is a
/// write).
pub fn build_args(opts: &ImportOptions) -> Result<Vec<String>, String> {
    if opts.create_db && opts.dry_run {
        return Err("--create-db cannot be combined with --dry-run (creation is a write)".into());
    }
    let mut args: Vec<String> = Vec::new();
    if opts.dry_run {
        args.push("--dry-run".into());
    }
    if opts.all {
        args.push("--all".into());
    }
    if opts.gpu {
        args.push("--gpu".into());
    }
    if opts.recursive {
        args.push("--recursive".into());
    }
    if opts.create_db {
        args.push("--create-db".into());
    }
    args.push("--threshold".into());
    args.push(format!("{}", opts.threshold));
    args.push(opts.roll_dir.clone());
    Ok(args)
}

/// Does this path hold ≥ 1 image file **at any depth**? — the one
/// boolean the GUI's "not yet imported" probe needs (#169: rolls are
/// organised in sub-folders, a one-level scan misread them as empty).
/// Recursive with hidden directories skipped and a bounded depth
/// (symlink cycles), **early-exit on the first hit**: the full count is
/// never displayed, so a huge tree costs one match. `IMAGE_SUFFIXES` is
/// the script's exact set. Not-a-directory / unreadable ⇒ false.
pub fn scan_import_dir(path: &Path) -> bool {
    has_image(path, 0)
}

const MAX_SCAN_DEPTH: usize = 32;

fn has_image(dir: &Path, depth: usize) -> bool {
    if depth > MAX_SCAN_DEPTH {
        return false;
    }
    let Ok(mut entries) = std::fs::read_dir(dir) else {
        return false;
    };
    while let Some(Ok(entry)) = entries.next() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            // hidden directories are never part of a roll walk
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if has_image(&entry.path(), depth + 1) {
                return true;
            }
        } else if kind.is_file() {
            let suffix = entry
                .path()
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if IMAGE_SUFFIXES.contains(&suffix.as_str()) {
                return true;
            }
        }
    }
    false
}

/// the observable state of the one import slot (gui-design §4.36: the
/// pane shows running / exit n / killed + the elapsed time)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    pub running: bool,
    pub killed: bool,
    pub exit_code: Option<i32>,
    /// seconds since the current/last run started (the pane's timer)
    pub elapsed: Option<u64>,
    /// cursor for the next get_import_status(since) poll
    pub next_since: usize,
    pub lines: Vec<String>,
}

/// the single import slot — one child at a time (a second Start is
/// refused with an error line). The child handle lives here for
/// `stop_import`; the readers' shared line buffer is the runner's.
struct ImportState {
    child: Option<Child>,
    started: Option<Instant>,
    /// lines drained so far out of the shared reader buffer
    lines: Vec<String>,
    killed: bool,
    exit_code: Option<i32>,
}

impl ImportState {
    fn new() -> Self {
        ImportState {
            child: None,
            started: None,
            lines: Vec::new(),
            killed: false,
            exit_code: None,
        }
    }

    fn push_line(&mut self, line: String) {
        self.lines.push(line);
        if self.lines.len() > MAX_LINES {
            let drop = self.lines.len() - MAX_LINES;
            self.lines.drain(0..drop);
        }
    }

    fn status(&mut self, shared: &Arc<Mutex<Vec<String>>>, since: usize) -> ImportStatus {
        // absorb whatever the reader threads have produced
        if let Ok(mut buf) = shared.lock() {
            for line in buf.drain(..) {
                self.push_line(line);
            }
        }
        // reap a finished child
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => {}
                Ok(Some(status)) => {
                    self.exit_code = status.code();
                    self.child = None;
                }
                Err(_) => {
                    self.exit_code = None;
                    self.child = None;
                }
            }
        }
        let since = since.min(self.lines.len());
        ImportStatus {
            running: self.child.is_some(),
            killed: self.killed,
            exit_code: self.exit_code,
            elapsed: self.started.map(|s| s.elapsed().as_secs()),
            next_since: self.lines.len(),
            lines: self.lines[since..].to_vec(),
        }
    }
}

/// the import slot held in AppState (backend-design §1): the Mutex-guarded
/// state + the one shared line buffer the reader threads push into
pub struct ImportRunner {
    state: Mutex<ImportState>,
    shared: Arc<Mutex<Vec<String>>>,
}

impl ImportRunner {
    pub fn new() -> Self {
        ImportRunner {
            state: Mutex::new(ImportState::new()),
            shared: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// spawn the child (refusing while one is live) and start the two
    /// reader threads; the pane polls `status(0)` from a fresh cursor
    pub fn start(&self, root: &Path, opts: &ImportOptions) -> Result<ImportStatus, String> {
        let args = build_args(opts)?;
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        // reap a finished child so a new run is allowed; refuse a live one
        if let Some(child) = st.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Err("an import is already running".into()),
                Ok(Some(status)) => {
                    st.exit_code = status.code();
                    st.child = None;
                }
                Err(e) => return Err(format!("cannot inspect the running import: {e}")),
            }
        }
        let python = std::env::var("WHOT_IMPORT_PYTHON").unwrap_or_else(|_| "python3".into());
        let script = root.join("scripts").join("import_roll.py");
        if !script.is_file() {
            return Err(format!("import script not found: {}", script.display()));
        }
        // cwd = project root: the script resolves .env / FACES_DB from it,
        // exactly like a terminal run (scripts-design §8)
        let mut child = Command::new(python)
            .arg(&script)
            .args(&args)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start the import process: {e}"))?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        // fresh run: the buffer is the readers' — cleared before they start
        if let Ok(mut buf) = self.shared.lock() {
            buf.clear();
        }
        st.lines.clear();
        st.killed = false;
        st.exit_code = None;
        st.started = Some(Instant::now());
        st.child = Some(child);

        let out = Arc::clone(&self.shared);
        std::thread::spawn(move || drain(stdout, &out));
        let err = Arc::clone(&self.shared);
        std::thread::spawn(move || drain(stderr, &err));

        Ok(st.status(&self.shared, 0))
    }

    /// append the readers' new lines, reap if the child has exited, and
    /// return the slice `[since..]` (the pane's poll, 300 ms)
    pub fn status(&self, since: usize) -> ImportStatus {
        match self.state.lock() {
            Ok(mut st) => st.status(&self.shared, since),
            Err(_) => ImportStatus {
                running: false,
                killed: false,
                exit_code: None,
                elapsed: None,
                next_since: since,
                lines: Vec::new(),
            },
        }
    }

    /// kill the child, if any; reports whether one was killed
    pub fn stop(&self) -> Result<bool, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        let Some(mut child) = st.child.take() else {
            return Ok(false);
        };
        child
            .kill()
            .map_err(|e| format!("cannot kill the import: {e}"))?;
        let _ = child.wait();
        st.killed = true;
        st.exit_code = None;
        Ok(true)
    }
}

/// drain one pipe into the shared line buffer (combined stdout+stderr)
fn drain<R: std::io::Read>(pipe: R, lines: &Arc<Mutex<Vec<String>>>) {
    for line in BufReader::new(pipe).lines() {
        match line {
            Ok(l) => {
                if let Ok(mut buf) = lines.lock() {
                    buf.push(l);
                    if buf.len() > MAX_LINES {
                        let drop = buf.len() - MAX_LINES;
                        buf.drain(0..drop);
                    }
                }
            }
            Err(_) => break,
        }
    }
}
