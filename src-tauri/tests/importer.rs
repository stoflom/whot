//! #167 — import runner integration tests (backend-design §8): arg
//! building, `scan_import_dir` over a temp tree, and a real child-process
//! lifecycle against a stub script.

use whotapp_lib::importer::{build_args, scan_import_dir, ImportOptions, ImportRunner};

fn opts(
    dry_run: bool,
    all: bool,
    gpu: bool,
    threshold: f64,
    recursive: bool,
    create_db: bool,
) -> ImportOptions {
    ImportOptions {
        roll_dir: "/tmp/roll".into(),
        dry_run,
        all,
        gpu,
        threshold,
        recursive,
        create_db,
    }
}

#[test]
fn build_args_default_is_threshold_and_dir_only() {
    let a = build_args(&opts(false, false, false, 0.40, false, false)).unwrap();
    assert_eq!(a, vec!["--threshold", "0.4", "/tmp/roll"]);
}

#[test]
fn build_args_flags_in_deterministic_order() {
    let a = build_args(&opts(true, true, true, 0.55, true, false)).unwrap();
    assert_eq!(
        a,
        vec![
            "--dry-run",
            "--all",
            "--gpu",
            "--recursive",
            "--threshold",
            "0.55",
            "/tmp/roll"
        ]
    );
}

#[test]
fn build_args_create_db_dry_run_refused() {
    let e = build_args(&opts(true, false, false, 0.40, false, true)).unwrap_err();
    assert!(e.contains("--create-db"), "{e}");
    // create-db alone is fine
    let a = build_args(&opts(false, false, false, 0.40, false, true)).unwrap();
    assert_eq!(a[0], "--create-db");
}

#[test]
fn scan_import_dir_counts_one_level_images() {
    let dir = std::env::temp_dir().join(format!("whot-scan-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("a.JPG"), b"x").unwrap();
    std::fs::write(dir.join("b.png"), b"x").unwrap();
    std::fs::write(dir.join("c.txt"), b"x").unwrap();
    std::fs::write(dir.join("sub/hidden.jpg"), b"x").unwrap(); // level 2 — not counted
    assert_eq!(scan_import_dir(&dir), 2);
    // a file / missing path is not a directory → 0
    assert_eq!(scan_import_dir(&dir.join("a.JPG")), 0);
    assert_eq!(scan_import_dir(&dir.join("missing")), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// the full lifecycle: start → refused second start → drain both pipes →
/// kill. The stub "script" is a shell file; WHOT_IMPORT_PYTHON points at
/// /bin/sh so no python is needed.
#[test]
fn runner_lifecycle_start_status_stop() {
    let root = std::env::temp_dir().join(format!("whot-runner-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("scripts")).unwrap();
    std::fs::write(
        root.join("scripts/import_roll.py"),
        "#!/bin/sh\necho line-one\necho line-two >&2\nsleep 30\n",
    )
    .unwrap();
    // SAFETY: single-threaded test setup before the runner spawns
    unsafe { std::env::set_var("WHOT_IMPORT_PYTHON", "/bin/sh") };

    let runner = ImportRunner::new();
    let o = opts(false, false, false, 0.40, false, false);
    let st = runner.start(&root, &o).unwrap();
    assert!(st.running);
    // second start while live is refused
    assert!(runner
        .start(&root, &o)
        .unwrap_err()
        .to_string()
        .contains("already running"));
    // drain until both lines arrive
    let mut since = 0;
    let mut got: Vec<String> = Vec::new();
    for _ in 0..100 {
        let s = runner.status(since);
        since = s.next_since;
        got.extend(s.lines);
        if got.len() >= 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(got, vec!["line-one", "line-two"]);
    // kill it
    assert!(runner.stop().unwrap());
    let s = runner.status(0);
    assert!(!s.running);
    assert!(s.killed);
    let _ = std::fs::remove_dir_all(&root);
}

/// a child that exits on its own is reaped by the next poll and reports
/// its exit code (gui-design §4.36: `exit n` in the pane)
#[test]
fn runner_exit_code_reaped_on_poll() {
    let root = std::env::temp_dir().join(format!("whot-exit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("scripts")).unwrap();
    std::fs::write(
        root.join("scripts/import_roll.py"),
        "#!/bin/sh\necho done\nexit 3\n",
    )
    .unwrap();
    // SAFETY: single-threaded test setup before the runner spawns
    unsafe { std::env::set_var("WHOT_IMPORT_PYTHON", "/bin/sh") };

    let runner = ImportRunner::new();
    runner
        .start(&root, &opts(false, false, false, 0.40, false, false))
        .unwrap();
    let mut since = 0;
    let mut code = None;
    for _ in 0..100 {
        let s = runner.status(since);
        since = s.next_since;
        if !s.running {
            code = s.exit_code;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(code, Some(3));
    let _ = std::fs::remove_dir_all(&root);
}

/// the missing-script refusal (the pane surfaces it as an error line)
#[test]
fn runner_refuses_missing_script() {
    let root = std::env::temp_dir().join(format!("whot-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let runner = ImportRunner::new();
    let e = runner
        .start(&root, &opts(false, false, false, 0.40, false, false))
        .unwrap_err();
    assert!(e.contains("import script not found"), "{e}");
    let _ = std::fs::remove_dir_all(&root);
}
