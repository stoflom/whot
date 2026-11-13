//! #216 follow-up — opt-in performance bench: wall-clock cost of the
//! real backend verdict path (set_link_status) and the clusters
//! recompute, measured against a COPY of the developer's real
//! faces.db. The copy must live at /tmp/opencode/perf216/whot/data/
//! faces.db; every test skips (with a message) when it is absent, so
//! the regular `cargo test` run is unaffected.
//! Run:  cd src-tauri && cargo test --test perf216 --release -- --nocapture
//!
//! NOTE: db::connect's DbConn holds the global pool lock for its
//! lifetime — never hold a connection across a command call.
use rusqlite::params;
use std::path::PathBuf;
use std::time::Instant;
use whotapp_lib::db::{self, Paths};

const ROOT: &str = "/tmp/opencode/perf216/whot";

fn paths() -> Option<Paths> {
    let db = PathBuf::from(ROOT).join("data/faces.db");
    if !db.is_file() {
        return None;
    }
    Some(Paths {
        root: PathBuf::from(ROOT),
        db,
        config: PathBuf::from(ROOT).join("whotrc.json"),
        mode: "repo",
        env_source: "dotenv",
    })
}

fn provisional_faces(p: &Paths) -> Vec<i64> {
    let ids = {
        let con = db::connect(p).unwrap();
        let mut st = con
            .prepare("SELECT id FROM faces WHERE link_status = 'provisional' ORDER BY id")
            .unwrap();
        st.query_map([], |r| r.get(0))
            .unwrap()
            .map(std::result::Result::unwrap)
            .collect::<Vec<i64>>()
    };
    ids
}

fn mean_ms(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len().max(1) as f64
}
use std::sync::{Arc, Mutex};

fn main_print(name: &str, v: &[(f64, &str)]) {
    let times: Vec<f64> = v.iter().map(|(t, _)| *t).collect();
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    let p50 = sorted.get(sorted.len() / 2).copied().unwrap_or(f64::NAN);
    eprintln!(
        "{name:<34} n={:<4} mean={:.1}ms p50={:.1}ms min={:.1}ms max={:.1}ms",
        v.len(),
        mean_ms(&times),
        p50,
        times.iter().copied().fold(f64::MAX, f64::min),
        times.iter().copied().fold(0.0, f64::max),
    );
}

#[test]
fn perf_verdict_commands() {
    let _ = Arc::new(Mutex::new(())); // silence unused import
    let p = match paths() {
        Some(p) => p,
        None => {
            eprintln!("skip: {ROOT}/data/faces.db missing");
            return;
        }
    };
    let faces = provisional_faces(&p);
    eprintln!("provisional faces: {}", faces.len());
    assert!(!faces.is_empty());

    // ── accept one face repeatedly (the card ✓ path) ──
    let mut acc = Vec::new();
    for &fid in faces.iter().take(25) {
        let t0 = Instant::now();
        let d = db::set_link_status(&p, &[fid], "confirmed").unwrap();
        acc.push((t0.elapsed().as_secs_f64() * 1000.0, ""));
        assert!(d.faces.is_some() || d.persons.is_some());
    }
    eprint!("\n");
    main_print("accept (1 face)", &acc);

    // ── reject one face repeatedly (the card ✗ path) ──
    let mut rej = Vec::new();
    for &fid in faces.iter().skip(25).take(25) {
        let t0 = Instant::now();
        let d = db::set_link_status(&p, &[fid], "rejected").unwrap();
        rej.push((t0.elapsed().as_secs_f64() * 1000.0, ""));
        assert!(d.faces.is_some() || d.persons.is_some());
    }
    main_print("reject (1 face)", &rej);

    // ── a cluster-header ✓ on the biggest provisional groups ──
    let groups: Vec<(i64, Vec<i64>)> = {
        let con = db::connect(&p).unwrap();
        let mut st = con
            .prepare(
                "SELECT person_id, COUNT(*) n FROM faces WHERE link_status='provisional'
                  GROUP BY person_id ORDER BY n DESC LIMIT 5",
            )
            .unwrap();
        let top: Vec<(i64, i64)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(std::result::Result::unwrap)
            .collect();
        top.into_iter()
            .map(|(pid, n)| {
                let mut st2 = con
                    .prepare("SELECT id FROM faces WHERE person_id=? AND link_status='provisional'")
                    .unwrap();
                let ids: Vec<i64> = st2
                    .query_map(params![pid], |r| r.get(0))
                    .unwrap()
                    .map(std::result::Result::unwrap)
                    .collect();
                eprintln!("  group person {pid}: {n} faces");
                (pid, ids)
            })
            .collect()
    }; // con dropped — releases the pool lock
    let mut grp = Vec::new();
    for (pid, ids) in &groups {
        eprintln!("  accepting person {pid} ({} faces)", ids.len());
        let t0 = Instant::now();
        let _ = db::set_link_status(&p, ids, "confirmed").unwrap();
        grp.push((t0.elapsed().as_secs_f64() * 1000.0, ""));
    }
    main_print("accept (whole group)", &grp);

    // ── clusters recompute after a verdict moved the stamp (cache miss) ──
    eprintln!();
    let shots: [i64; 3] = [2, 18, 1229];
    for &pid in &shots {
        let mut runs = Vec::new();
        for _ in 0..3 {
            let t0 = Instant::now();
            let _ = db::person_face_clusters(&p, pid, 0.40).unwrap();
            runs.push((t0.elapsed().as_secs_f64() * 1000.0, ""));
        }
        main_print(&format!("person_face_clusters pid={pid}"), &runs);
    }
}
