//! Integration tests over a self-built fixture DB (review F8).
//!
//! The database is created from `database/schema.sql` + deterministic seeded
//! rows — no local `data/faces.db` needed, so the suite runs on a fresh clone
//! and in CI.
//!
//! Fixture:
//!   imports: 1 ('/tmp/roll1')
//!   images:  1 'a.jpg', 2 'b.jpg', 3 'c.jpg'
//!   persons: 1 Unknown1 (faces 1,2,6 — conf .90/.80/.60, 3 faces)
//!            2 Unknown2 (face 3  — conf .70, single face)
//!            3 Unknown3 (faces 4,5 — conf .95/.85)
//!   embeddings (dim 4): cos(1,2)=.9, cos(1,6)=.8, cos(4,5)=.98, others 0

use rusqlite::{params, Connection};
use std::path::PathBuf;
use whotapp_lib::db::{self, Paths, Settings};

const SCHEMA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../database/schema.sql");
const NOW: &str = "2026-10-15T00:00:00";

fn fixture_paths(name: &str) -> Paths {
    let root: PathBuf =
        std::env::temp_dir().join(format!("whot-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json") };
    let con = Connection::open(&paths.db).unwrap();
    con.execute_batch(&std::fs::read_to_string(SCHEMA).unwrap()).unwrap();
    seed(&con);
    paths
}

fn seed(con: &Connection) {
    con.execute(
        "INSERT INTO imports(id, path, started_at) VALUES (1, '/tmp/roll1', ?)",
        params![NOW],
    ).unwrap();
    for (id, name) in [(1, "a.jpg"), (2, "b.jpg"), (3, "c.jpg")] {
        con.execute(
            "INSERT INTO images(id, content_hash, width, height, primary_path, state,
                                orientation, type, created_at)
             VALUES (?, ?, 100, 100, ?, 'scanned', 'landscape', 'processed', ?)",
            params![id, format!("{id:0>64}"), name, NOW],
        ).unwrap();
    }
    for (id, name) in [(1, "Unknown1"), (2, "Unknown2"), (3, "Unknown3")] {
        con.execute(
            "INSERT INTO persons(id, name, state, created_at) VALUES (?, ?, 'created', ?)",
            params![id, name, NOW],
        ).unwrap();
        // #165/§4.35: every fresh cluster is seated — all seed faces are
        // provisional, so the derived seat is `New`
        con.execute(
            "INSERT INTO person_groups(person_id, path) VALUES (?, 'New')",
            params![id],
        ).unwrap();
    }
    // (face id, image, person, seq, confidence, embedding)
    let faces: [(i64, i64, i64, i64, f64, [f32; 4]); 6] = [
        (1, 1, 1, 1, 0.90, [1.0, 0.0, 0.0, 0.0]),
        (2, 1, 1, 2, 0.80, [0.9, 0.43589, 0.0, 0.0]),
        (6, 1, 1, 3, 0.60, [0.8, 0.6, 0.0, 0.0]),
        (3, 2, 2, 1, 0.70, [0.0, 1.0, 0.0, 0.0]),
        (4, 3, 3, 1, 0.95, [0.0, 0.0, 1.0, 0.0]),
        (5, 3, 3, 2, 0.85, [0.0, 0.0, 0.98058, 0.19612]),
    ];
    for (fid, img, pid, seq, conf, vec) in faces {
        con.execute(
            "INSERT INTO faces(id, image_id, x, y, w, h, person_id, name, seq, confidence,
                               preview, detected_in_import_id, created_at)
             VALUES (?, ?, ?, 0, 10, 10, ?, ?, ?, ?, ?, 1, ?)",
            params![fid, img, (seq - 1) * 20, pid, format!("Unknown{pid}-{seq}"), seq,
                    conf, vec![0u8; 8], NOW],
        ).unwrap();
        con.execute(
            "INSERT INTO face_embeddings(face_id, model, dim, vector, created_at)
             VALUES (?, 'insightface:buffalo_l', 4, ?, ?)",
            params![fid, vec.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), NOW],
        ).unwrap();
    }
}

// ---------------------------------------------------------------- baseline

#[test]
fn full_workflow() {
    let p = fixture_paths("full");

    // snapshot sanity
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.len(), 3);
    assert_eq!(s.faces.len(), 6);
    assert_eq!(s.images.len(), 3);
    assert_eq!(s.imports.len(), 1);

    // 1) rename the whole Unknown3 cluster in place
    db::assign_person(&p, &[4, 5], "Carol", "family|test").unwrap();
    let s = db::snapshot(&p).unwrap();
    let carol = s.persons.iter().find(|x| x.name == "Carol").unwrap();
    assert_eq!(carol.groups, vec!["family|test".to_string()]);
    assert_eq!(carol.counts.confirmed, 2);
    let prim = carol.primary_face_id.expect("primary backfilled");
    assert!(prim == 4 || prim == 5);
    // refcrops: the other confirmed face, primary excluded (§4.6)
    let rc = db::get_refcrops(&p, carol.id).unwrap();
    assert_eq!(rc.len(), 1);
    assert_eq!(rc[0].face_id, if prim == 4 { 5 } else { 4 });

    // 2) description normalisation + derived name (§4.4)
    db::set_face_description(&p, 5, "  beard | glasses ").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f5 = s.faces.iter().find(|f| f.id == 5).unwrap();
    assert_eq!(f5.description.as_deref(), Some("beard|glasses"));
    assert!(f5.name.starts_with("Carol-beard|glasses-"), "{}", f5.name);

    // 3) reject / claim roundtrip (#165 §4.2/§4.3/§4.35): reject re-homes
    //    the face onto the system person, plain accept never un-rejects,
    //    an assignment claims it back
    db::set_link_status(&p, &[5], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f5 = s.faces.iter().find(|f| f.id == 5).unwrap();
    assert_eq!(f5.link_status, "rejected");
    let rej = s.persons.iter().find(|x| x.name == "Rejected").unwrap();
    assert_eq!(f5.person_id, Some(rej.id), "reject re-homes onto the system person");
    assert_eq!(rej.groups, vec!["Rejected".to_string()], "the system seat");
    assert!(s.persons.iter().find(|x| x.name == "Carol").unwrap().primary_face_id != Some(5));
    db::set_link_status(&p, &[5], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(
        s.faces.iter().find(|f| f.id == 5).unwrap().link_status,
        "rejected",
        "plain accept never un-rejects (#165)"
    );
    db::assign_person(&p, &[5], "Carol", "family|test").unwrap(); // the claim
    let s = db::snapshot(&p).unwrap();
    assert_eq!(
        s.faces.iter().find(|f| f.id == 5).unwrap().link_status,
        "confirmed",
        "assignment claims (#165)"
    );

    // 4) appearance-partitioned clusters on Carol: step 2 gave face 5 the
    //    description 'beard|glasses' ⇒ two appearances, one face each (§4.9)
    let cl = db::person_face_clusters(&p, carol.id, 0.5).unwrap();
    assert_eq!(cl.len(), 2, "descriptions partition the person view");
    let mut descs: Vec<&str> = cl.iter().map(|g| g.description.as_str()).collect();
    descs.sort();
    assert_eq!(descs, vec!["", "beard|glasses"]);
    assert!(cl.iter().all(|g| g.clusters.len() == 1 && g.clusters[0].len() == 1));
    let total: usize = cl.iter().map(|g| g.clusters.iter().map(|c| c.len()).sum::<usize>()).sum();
    assert_eq!(total, 2);

    // 5) name validation + no-op self rename
    assert!(db::assign_person(&p, &[3], "Unknown99", "").is_err());
    assert!(db::set_person_name(&p, carol.id, "Carol").is_ok());

    // 6) settings round-trip
    db::set_settings(&p, Settings { cluster_threshold: 0.5, refcrop_n: 3, ..Settings::default() }).unwrap();
    assert_eq!(db::get_settings(&p).unwrap().refcrop_n, 3);
    assert_eq!(db::get_settings(&p).unwrap().face_filter, db::FaceFilter::All);

    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

// ---------------------------------------------------------------- regressions

/// F1 — manual pins must survive refcrop recomputation (design §4.6).
/// The pinned face (conf .85) is *inside* the auto top-N, which is exactly
/// the case where the old INSERT OR REPLACE evicted the pin row.
#[test]
fn pin_survives_recompute() {
    let p = fixture_paths("pin");
    db::set_link_status(&p, &[4, 5], "confirmed").unwrap();
    db::set_primary_face(&p, 3, 4).unwrap();
    db::add_refcrop(&p, 3, 5).unwrap();
    // trigger two recomputes WITHOUT moving the pinned face — since #165 a
    // reject re-homes the face and takes its refcrop rows with it
    db::set_face_description(&p, 4, "hat").unwrap();
    db::set_link_status(&p, &[4], "confirmed").unwrap();
    let rc = db::get_refcrops(&p, 3).unwrap();
    let pin = rc.iter().find(|r| r.face_id == 5)
        .expect("pinned face must survive recompute");
    assert!(pin.pinned, "pin flag lost");
    assert_eq!(pin.description, "", "pinned row must keep its appearance group");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F3 — rejecting a person's primary face must trigger reassignment (§4.2).
#[test]
fn rejected_primary_reassigned() {
    let p = fixture_paths("rejprim");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    let u1 = s.persons.iter().find(|x| x.name == "Unknown1").unwrap();
    assert_eq!(u1.primary_face_id, Some(1), "highest confidence (.90) wins");
    db::set_link_status(&p, &[1], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let u1 = s.persons.iter().find(|x| x.name == "Unknown1").unwrap();
    assert_eq!(u1.primary_face_id, Some(2), "rejected face must not stay primary");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F2 — merging into an existing person must keep that person's group (§4.1).
#[test]
fn assign_existing_keeps_group() {
    let p = fixture_paths("group");
    db::assign_person(&p, &[4, 5], "Alice", "family|test").unwrap();
    // merge Unknown2's face into Alice with an EMPTY group argument
    db::assign_person(&p, &[3], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    assert_eq!(alice.groups, vec!["family|test".to_string()],
               "existing person's group path must not be clobbered");
    let f3 = s.faces.iter().find(|f| f.id == 3).unwrap();
    assert_eq!(f3.person_id, Some(alice.id));
    assert_eq!(f3.link_status, "confirmed");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F5 — moving a middle-seq face out and another face in must not reuse a seq
/// (design §4.7: labels stay unique within a person).
#[test]
fn seq_unique_after_move_out_and_in() {
    let p = fixture_paths("seq");
    db::assign_person(&p, &[1, 2, 6], "Dave", "").unwrap();  // Unknown1 → Dave (seqs 1,2,3)
    let s = db::snapshot(&p).unwrap();
    let dave_id = s.persons.iter().find(|x| x.name == "Dave").unwrap().id;
    db::assign_person(&p, &[2], "Bob", "").unwrap();        // move seq-2 face out → gap {1,3}
    db::assign_person(&p, &[3], "Dave", "").unwrap();       // move Unknown2's face in
    let s = db::snapshot(&p).unwrap();
    let names: Vec<String> = s.faces.iter()
        .filter(|f| f.person_id == Some(dave_id))
        .map(|f| f.name.clone())
        .collect();
    assert_eq!(names.len(), 3); // f1 (seq 1), f6 (seq 3), f3 (must get seq 4)
    let mut uniq = names.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(names.len(), uniq.len(), "duplicate face names within person: {names:?}");
    let f3 = s.faces.iter().find(|f| f.id == 3).unwrap();
    assert_eq!(f3.seq, 4, "incoming face must get MAX(seq)+1 = 4, got {}", f3.seq);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F7 → #165: renaming an UnknownN keeps the person's group rows —
/// memberships are never dropped by a rename (the retired `Unknown`
/// value only survives in pre-#165 data; the fix script rewrites it to
/// a status seat, and the fixture carries the modern `New` seat).
#[test]
fn rename_unknown_keeps_group_rows() {
    let p = fixture_paths("rename");
    let s = db::snapshot(&p).unwrap();
    let u2 = s.persons.iter().find(|x| x.name == "Unknown2").unwrap();
    assert_eq!(u2.groups, vec!["New".to_string()]);
    db::set_person_name(&p, 2, "Erin").unwrap();
    let s = db::snapshot(&p).unwrap();
    let erin = s.persons.iter().find(|x| x.name == "Erin").unwrap();
    assert_eq!(erin.groups, vec!["New".to_string()], "rename keeps the rows (#165/#153)");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F19 — duplicated ids are deduped, not an error.
#[test]
fn duplicate_face_ids_accepted() {
    let p = fixture_paths("dup");
    db::assign_person(&p, &[3, 3], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().any(|x| x.name == "Alice"));
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F16 — the connection must set a busy timeout (importer runs concurrently).
#[test]
fn busy_timeout_set() {
    let p = fixture_paths("busy");
    let con = db::connect(&p).unwrap();
    let t: i64 = con
        .query_row("SELECT timeout FROM pragma_busy_timeout()", [], |r| r.get(0))
        .unwrap();
    assert!(t > 0, "busy_timeout not set");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// F15 — ${VAR} falls back to the process environment; unknown refs literal.
#[test]
fn env_process_fallback() {
    let root = std::env::temp_dir().join(format!("whot-envtest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(".env"),
        "A=${HOME}/pics\nB=${TOTALLY_UNSET_VAR_XYZ_123}/x\nC=${A}/deep\n",
    ).unwrap();
    let env = db::parse_env(&root.join(".env"));
    let home = std::env::var("HOME").expect("HOME set in test environment");
    assert_eq!(env["A"], format!("{home}/pics"), "process-env fallback must resolve $HOME");
    assert_eq!(env["B"], "${TOTALLY_UNSET_VAR_XYZ_123}/x", "unknown refs stay literal");
    assert_eq!(env["C"], format!("{home}/pics/deep"), "in-file refs still win");
    std::fs::remove_dir_all(&root).ok();
}

/// #99 — face_filter defaults to all when the key is absent (the retired
/// show_rejected key is ignored), both new keys round-trip, and the UI's
/// "accepted" vocabulary parses as Confirmed via serde alias.
#[test]
fn settings_face_filter_and_cluster_group_defaults_and_roundtrip() {
    let p = fixture_paths("settings");
    // legacy whotrc.json: no new keys, retired show_rejected present
    std::fs::write(
        &p.config,
        r#"{ "cluster_threshold": 0.5, "refcrop_n": 3, "show_rejected": false }"#,
    )
    .unwrap();
    let s = db::get_settings(&p).unwrap();
    assert_eq!(
        s.face_filter,
        db::FaceFilter::All,
        "missing key must default to all; the legacy key must be ignored"
    );
    assert_eq!(s.cluster_group, db::ClusterGroup::Accuracy);
    assert_eq!(s.refcrop_n, 3, "unrelated keys keep loading");
    let mut s2 = s;
    s2.face_filter = db::FaceFilter::Confirmed;
    s2.cluster_group = db::ClusterGroup::Description;
    db::set_settings(&p, s2).unwrap();
    let s3 = db::get_settings(&p).unwrap();
    assert_eq!(s3.face_filter, db::FaceFilter::Confirmed, "must round-trip");
    assert_eq!(s3.cluster_group, db::ClusterGroup::Description, "must round-trip");
    // UI vocabulary alias: a hand-edited "accepted" parses as Confirmed
    std::fs::write(
        &p.config,
        r#"{ "cluster_threshold": 0.4, "refcrop_n": 5, "face_filter": "accepted" }"#,
    )
    .unwrap();
    assert_eq!(db::get_settings(&p).unwrap().face_filter, db::FaceFilter::Confirmed);
    // no whotrc.json at all
    std::fs::remove_file(&p.config).ok();
    assert_eq!(db::get_settings(&p).unwrap().face_filter, db::FaceFilter::All);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #88 (§4.28) — Merge Similar Persons settings: legacy whotrc.json
/// files keep loading with serde defaults; distance clamps to 1..=3.
#[test]
fn merge_settings_defaults_and_clamp() {
    let p = fixture_paths("merge-settings");
    // legacy whotrc without the merge keys
    std::fs::write(&p.config, r#"{ "cluster_threshold": 0.5, "refcrop_n": 3 }"#).unwrap();
    let s = db::get_settings(&p).unwrap();
    assert_eq!(s.merge_name_distance, 2, "missing key must default to 2");
    assert!(s.merge_suffix_aliases.is_empty(), "aliases default off");
    // round-trip both fields
    let mut s2 = s.clone();
    s2.merge_name_distance = 1;
    s2.merge_suffix_aliases = vec![vec!["J".into(), "Jr".into(), "Junior".into()]];
    db::set_settings(&p, s2).unwrap();
    let s3 = db::get_settings(&p).unwrap();
    assert_eq!(s3.merge_name_distance, 1);
    assert_eq!(s3.merge_suffix_aliases[0], ["J", "Jr", "Junior"]);
    // hand-edited out-of-range values clamp on read
    std::fs::write(&p.config, r#"{ "cluster_threshold": 0.5, "refcrop_n": 3, "merge_name_distance": 99 }"#).unwrap();
    assert_eq!(db::get_settings(&p).unwrap().merge_name_distance, 3);
    std::fs::write(&p.config, r#"{ "cluster_threshold": 0.5, "refcrop_n": 3, "merge_name_distance": 0 }"#).unwrap();
    assert_eq!(db::get_settings(&p).unwrap().merge_name_distance, 1);
    // snapshot carries the settings through
    std::fs::write(&p.config, r#"{ "cluster_threshold": 0.5, "refcrop_n": 3 }"#).unwrap();
    assert_eq!(db::snapshot(&p).unwrap().settings.merge_name_distance, 2);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// v1.5 — refcrops are rebuilt per appearance group: one top-N list per
/// distinct (person, description), seq 1..n inside each group (§4.6).
#[test]
fn refcrops_per_description_group() {
    let p = fixture_paths("refgroups");
    db::set_settings(&p, Settings { refcrop_n: 1, ..Settings::default() }).unwrap();
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // Unknown1: .90/.80/.60
    db::set_face_description(&p, 1, "beard").unwrap();
    db::set_face_description(&p, 2, "beard").unwrap();
    // primary = face 1 (highest confidence), excluded from refcrops
    let rc = db::get_refcrops(&p, 1).unwrap();
    assert_eq!(rc.len(), 2, "one auto row per appearance group, got {rc:?}");
    let beard = rc.iter().find(|r| r.description == "beard").expect("beard group");
    let none = rc.iter().find(|r| r.description.is_empty()).expect("no-description group");
    assert_eq!(beard.face_id, 2, "beard group: best non-primary beard face");
    assert_eq!(beard.seq, 1, "seq restarts inside the group");
    assert_eq!(none.face_id, 6, "face 6 has no description -> own group");
    assert_eq!(none.seq, 1, "seq restarts inside the group");
    assert!(rc.iter().all(|r| !r.pinned));
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// v1.5 — pinning a face inside a group: survives recompute, occupies its
/// seq slot (auto rows of that group skip it), no duplicate rows.
#[test]
fn pin_occupies_group_seq_slot() {
    let p = fixture_paths("pinseat");
    db::set_settings(&p, Settings { refcrop_n: 2, ..Settings::default() }).unwrap();
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // auto rows: f2=1, f6=2
    db::add_refcrop(&p, 1, 2).unwrap(); // upgrade f2's auto row -> pinned at seq 1
    // trigger a recompute WITHOUT moving an auto-row face (#165: a reject
    // re-homes the face, which would take its refcrop rows along)
    db::set_face_description(&p, 1, "hat").unwrap();
    let rc = db::get_refcrops(&p, 1).unwrap();
    let f2: Vec<_> = rc.iter().filter(|r| r.face_id == 2).collect();
    assert_eq!(f2.len(), 1, "pinned face must not be duplicated: {rc:?}");
    assert!(f2[0].pinned);
    assert_eq!(f2[0].seq, 1, "upgrade keeps the row's seq slot");
    // face 1 is primary; face 2 is pinned at seq 1; the auto row for face 6
    // must skip that slot and take seq 2
    let f6 = rc.iter().find(|r| r.face_id == 6).expect("auto row for face 6");
    assert_eq!(f6.seq, 2, "auto row must skip the pinned seq slot");
    assert!(!f6.pinned);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// §4.4/#27 — editing a description re-assigns seq within the new group
/// (unique labels) and rebuilds that person's refcrops into the groups.
#[test]
fn description_edit_reassigns_seq_and_regroups_refcrops() {
    let p = fixture_paths("descedit");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // seqs 1,2,3
    db::set_face_description(&p, 2, "beard").unwrap(); // -> group beard, seq 1
    db::set_face_description(&p, 1, "beard").unwrap(); // -> group beard, seq 2 (after face 2)
    let s = db::snapshot(&p).unwrap();
    let f1 = s.faces.iter().find(|f| f.id == 1).unwrap();
    let f2 = s.faces.iter().find(|f| f.id == 2).unwrap();
    assert_eq!((f1.person_id, f1.seq), (Some(1), 2));
    assert_eq!((f2.person_id, f2.seq), (Some(1), 1));
    assert_ne!(f1.name, f2.name, "labels must stay unique within the group");
    // refcrops must have followed the face into its new group
    let rc = db::get_refcrops(&p, 1).unwrap();
    let by = |g: &str| rc.iter().filter(|r| r.description == g).map(|r| r.face_id).collect::<Vec<_>>();
    assert_eq!(by("beard"), vec![2], "face 1 is primary, face 2 is the beard refcrop");
    assert_eq!(by(""), vec![6], "face 6 stays in the no-description group");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// v1.5 — schema_version compatibility gate: matching passes, mismatched
/// version and missing marker are both refused with a clear message.
#[test]
fn schema_version_compatibility_gate() {
    let p = fixture_paths("schemaver");
    db::connect(&p).unwrap(); // matching schema passes
    {
        let con = Connection::open(&p.db).unwrap();
        con.execute("UPDATE schema_version SET version = '1.4'", []).unwrap();
    }
    let err = db::connect(&p).unwrap_err();
    assert!(err.to_string().contains("does not match"), "{err}");

    let p2 = fixture_paths("schemaver2");
    {
        let con = Connection::open(&p2.db).unwrap();
        con.execute_batch("DROP TABLE schema_version").unwrap();
    }
    let err = db::connect(&p2).unwrap_err();
    assert!(err.to_string().contains("schema_version"), "{err}");

    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
    std::fs::remove_dir_all(p2.db.parent().unwrap()).ok();
}

/// §4.9/§4.12 — the person view partitions faces by appearance and clusters
/// by similarity *inside* each partition; the primary's appearance first.
#[test]
fn clusters_partitioned_by_appearance() {
    let p = fixture_paths("appear");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // cos(1,2)=.9, cos(1,6)=.8
    db::set_face_description(&p, 1, "beard").unwrap();          // primary = face 1
    db::set_face_description(&p, 2, "beard").unwrap();
    let cl = db::person_face_clusters(&p, 1, 0.4).unwrap();
    // pooled, faces 1+2 would share a cluster; partitioned: beard={1,2}, ''={6}
    assert_eq!(cl.len(), 2, "two appearance groups expected: {cl:?}");
    let beard = cl.iter().find(|g| g.description == "beard").expect("beard group");
    let none = cl.iter().find(|g| g.description.is_empty()).expect("no-description group");
    let ids = |g: &db::AppearanceGroup| -> Vec<i64> {
        let mut v: Vec<i64> = g.clusters.iter().flatten().map(|c| c.face_id).collect();
        v.sort();
        v
    };
    assert_eq!(ids(beard), vec![1, 2], "same-appearance faces cluster together");
    assert_eq!(beard.clusters.len(), 1, "cos .9 >= threshold ⇒ one cluster");
    assert_eq!(ids(none), vec![6]);
    assert_eq!(cl[0].description, "beard", "primary's appearance sorts first");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// §4.27 (#84) — snapshot sweeps zero-face UnknownN leftovers (pre-v1.9
/// runs / external writers); named empty persons are legitimate and stay.
#[test]
fn snapshot_sweeps_stale_unknown_shells() {
    let p = fixture_paths("sweep");
    {
        let con = rusqlite::Connection::open(&p.db).unwrap();
        con.execute(
            "INSERT INTO persons(id, name, state, created_at) VALUES (80, 'Unknown80', 'created', ?)",
            params![NOW],
        ).unwrap();
        con.execute(
            "INSERT INTO persons(id, name, state, created_at) VALUES (81, 'Keeper', 'created', ?)",
            params![NOW],
        ).unwrap();
        // Unknown80 has zero faces; Keeper too — but Keeper is named
        let n = con
            .query_row("SELECT COUNT(*) FROM persons", [], |r| r.get::<_, i64>(0))
            .unwrap();
        assert_eq!(n, 5, "seeded two zero-face persons");
    }
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Unknown80"),
            "zero-face UnknownN must be swept: {:?}",
            s.persons.iter().map(|x| &x.name).collect::<Vec<_>>());
    assert!(s.persons.iter().any(|x| x.name == "Keeper"),
            "a zero-face NAMED person must never be swept");
    // idempotent: a second snapshot changes nothing
    let s2 = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.len(), s2.persons.len());
    // and it actually deleted the row (not just hid it)
    {
        let con = rusqlite::Connection::open(&p.db).unwrap();
        let n = con
            .query_row("SELECT COUNT(*) FROM persons WHERE name='Unknown80'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(n, 0, "the sweep must DELETE, not filter");
    }
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #80 — persons.primary_face_id is nullable (freshly imported/harvested
/// person, or one whose faces are all rejected): the is_primary column must
/// be NULL-safe, not crash with "Invalid column type Null at index 2".
#[test]
fn clusters_tolerate_null_primary() {
    let p = fixture_paths("nullprim");
    // raw fixture: no person has a primary_face_id (all NULL)
    let cl = db::person_face_clusters(&p, 1, 0.4).unwrap();
    assert!(!cl.is_empty(), "faces still cluster without a primary");
    // highest-confidence face stands in as reference (fallback, §4.9)
    let ids: Vec<i64> = cl.iter().flat_map(|g| g.clusters.iter().flatten()).map(|c| c.face_id).collect();
    assert!(ids.contains(&1), "face 1 (conf .90) present: {ids:?}");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// §4.13/#35/#165 — remove_persons: faces rejected AND re-homed onto the
/// system person `Rejected` (no writer detaches a face anymore), person
/// and its groups/refcrops deleted, other persons untouched; a later
/// assignment claims the faces back.
#[test]
fn remove_persons_rejects_and_rehomes() {
    let p = fixture_paths("remove");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // person 1
    db::add_refcrop(&p, 1, 2).unwrap();                        // pin → must go with the person
    db::set_link_status(&p, &[4, 5], "confirmed").unwrap();    // person 3 keeps its own
    db::remove_persons(&p, &[1]).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.id != 1), "person 1 must be gone");
    assert!(s.persons.iter().any(|x| x.id == 3), "other persons untouched");
    let rej = s.persons.iter().find(|x| x.name == "Rejected")
        .expect("the system person exists");
    for f in s.faces.iter().filter(|f| [1, 2, 6].contains(&f.id)) {
        assert_eq!(f.link_status, "rejected", "face {} must be rejected", f.id);
        assert_eq!(f.person_id, Some(rej.id), "face {} homes on Rejected (#165)", f.id);
    }
    // refcrops went with the person
    assert!(db::get_refcrops(&p, 1).unwrap().is_empty());
    // claim: an assignment un-rejects and moves (§4.35)
    db::assign_person(&p, &[6], "Rescued", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let rescued = s.persons.iter().find(|x| x.name == "Rescued").unwrap().id;
    let f6 = s.faces.iter().find(|f| f.id == 6).unwrap();
    assert_eq!(f6.person_id, Some(rescued));
    assert_eq!(f6.link_status, "confirmed", "assignment claims (#165)");
    // …while plain accept can never un-reject
    db::set_link_status(&p, &[1], "rejected").unwrap();
    db::set_link_status(&p, &[1], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().link_status, "rejected");
    // removing an unknown id errors, batch of several works
    assert!(db::remove_persons(&p, &[]).is_err());
    db::remove_persons(&p, &[2, 3]).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.id != 2 && x.id != 3));
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #41 — a face without an embedding reports sim 0.0 (no evidence), not 1.0.
#[test]
fn embeddingless_face_reports_zero_sim() {
    let p = fixture_paths("nosim");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // Unknown1: .90/.80/.60
    {
        let con = db::connect(&p).unwrap();
        con.execute("DELETE FROM face_embeddings WHERE face_id = 6", []).unwrap();
    }
    let cl = db::person_face_clusters(&p, 1, 0.5).unwrap();
    let all: Vec<&db::ClusterFace> = cl.iter().flat_map(|g| g.clusters.iter().flatten()).collect();
    let f6 = all.iter().find(|c| c.face_id == 6).copied().expect("face 6 must be shown");
    assert_eq!(f6.sim, 0.0, "no embedding ⇒ no similarity evidence, not 100%");
    assert!(
        cl.iter().any(|g| g.clusters.iter().any(|c| c.len() == 1 && c[0].face_id == 6)),
        "face 6 stays visible in its own cluster"
    );
    let f1 = all.iter().find(|c| c.face_id == 1).copied().unwrap();
    assert_eq!(f1.sim, 1.0, "the primary keeps sim 1.0");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #45 — a corrupt embedding blob (length not a multiple of 4) is reported
/// with the face id instead of being silently truncated by as_chunks.
#[test]
fn corrupt_embedding_blob_is_reported() {
    let p = fixture_paths("corrupt");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap();
    {
        let con = db::connect(&p).unwrap();
        con.execute(
            "UPDATE face_embeddings SET vector = ? WHERE face_id = 6",
            params![vec![0u8; 10]], // 10 % 4 != 0
        )
        .unwrap();
    }
    let err = db::person_face_clusters(&p, 1, 0.5).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("face 6"), "{msg}");
    assert!(msg.contains("not a multiple of 4"), "{msg}");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #149 — a length-valid blob that decodes to NaN components must degrade,
/// not panic: NaN is "no similarity evidence" (0.0, like #41) and the
/// ordering paths use unwrap_or(Ordering::Equal).
#[test]
fn nan_embedding_blob_degrades_not_panics() {
    let p = fixture_paths("nanblob");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap();
    {
        let con = db::connect(&p).unwrap();
        let nan = f32::NAN.to_le_bytes();
        let mut v = Vec::new();
        for _ in 0..4 {
            v.extend_from_slice(&nan); // 16 bytes = 4 dims of NaN
        }
        con.execute(
            "UPDATE face_embeddings SET vector = ? WHERE face_id = 6",
            params![v],
        )
        .unwrap();
    }
    // must return Ok — the pre-#149 code panicked in the order sort below
    let cl = db::person_face_clusters(&p, 1, 0.5).unwrap();
    let all: Vec<&db::ClusterFace> = cl.iter().flat_map(|g| g.clusters.iter().flatten()).collect();
    let f6 = all.iter().find(|c| c.face_id == 6).copied().expect("face 6 must be shown");
    assert_eq!(f6.sim, 0.0, "NaN embedding ⇒ no similarity evidence, not 100%");
    assert!(
        cl.iter().any(|g| g.clusters.iter().any(|c| c.len() == 1 && c[0].face_id == 6)),
        "face 6 stays visible in its own cluster"
    );
    let f1 = all.iter().find(|c| c.face_id == 1).copied().unwrap();
    assert_eq!(f1.sim, 1.0, "the primary keeps sim 1.0");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #44 — a malformed whotrc.json falls back to the defaults (with a
/// visible warning) instead of vanishing silently; a missing file is a
/// first run and stays quiet.
#[test]
fn corrupt_settings_file_falls_back_to_defaults() {
    let p = fixture_paths("corruptcfg");
    std::fs::write(&p.config, "{ not json !").unwrap();
    assert_eq!(db::get_settings(&p).unwrap(), db::Settings::default());
    // a well-formed file still wins
    let s2 = db::Settings { refcrop_n: 7, ..db::Settings::default() };
    db::set_settings(&p, s2).unwrap();
    assert_eq!(db::get_settings(&p).unwrap().refcrop_n, 7);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #43 — set_person_name rebuilds the refcrops, so filenames follow the
/// renamed face names (symmetric with assign_person).
#[test]
fn rename_updates_refcrop_filenames() {
    let p = fixture_paths("refnames");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // primary = face 1
    db::set_person_name(&p, 1, "Rita").unwrap();
    let rc = db::get_refcrops(&p, 1).unwrap();
    assert!(!rc.is_empty(), "refcrops must exist after the rename");
    for r in &rc {
        assert!(r.filename.starts_with("Rita-"), "stale filename: {}", r.filename);
    }
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #42/#165 — group paths are normalised on the write side: segments
/// trimmed, empties dropped, whitespace-only path ⇒ the person's status
/// seat (§4.35), and the five reserved segments are refused.
#[test]
fn group_paths_normalised_on_write() {
    let p = fixture_paths("groups");
    db::set_person_group(&p, 1, "  family |  test  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    let u1 = s.persons.iter().find(|x| x.id == 1).unwrap();
    assert_eq!(u1.groups, vec!["family|test".to_string()]);
    // empties collapse; a whitespace-only path seats the person (#165)
    db::set_person_group(&p, 1, "a || b |  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.iter().find(|x| x.id == 1).unwrap().groups, vec!["a|b".to_string()]);
    db::set_person_group(&p, 1, "   |  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    // person 1 still holds its provisional seed faces ⇒ `New` (#165/§4.35)
    assert_eq!(s.persons.iter().find(|x| x.id == 1).unwrap().groups, vec!["New".to_string()]);
    // the five reserved segments are refused on every group-writing path
    for bad in ["New", "Accepted", "Rejected", "Ungrouped", "Unknown"] {
        assert!(db::set_person_group(&p, 1, bad).is_err(), "{bad} must be reserved");
        assert!(db::set_person_group(&p, 1, &format!("x|{bad}")).is_err(), "{bad} must be reserved");
    }
    // the same normalisation applies through assign_person (new person)
    db::assign_person(&p, &[3], "Gina", " x |  y | ").unwrap();
    let s = db::snapshot(&p).unwrap();
    let gina = s.persons.iter().find(|x| x.name == "Gina").unwrap();
    assert_eq!(gina.groups, vec!["x|y".to_string()]);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #39 — a confirmed face with a NULL preview must not abort the refcrop
/// recompute (and therefore the mutation transaction); it is skipped.
#[test]
fn recompute_tolerates_null_preview() {
    let p = fixture_paths("nullprev");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // Unknown1: .90/.80/.60
    {
        let con = db::connect(&p).unwrap();
        con.execute("UPDATE faces SET preview = NULL WHERE id = 2", []).unwrap();
    }
    // a mutation that triggers person 1's recompute must not error —
    // without moving a face (#165: reject re-homes it onto `Rejected`)
    db::set_face_description(&p, 1, "hat").unwrap();
    let rc = db::get_refcrops(&p, 1).unwrap();
    assert!(rc.iter().all(|r| r.face_id != 2), "crop-less face must be skipped");
    let f6 = rc.iter().find(|r| r.face_id == 6).expect("face 6 still a refcrop");
    assert_eq!(f6.seq, 2, "face 6 keeps its rank position (rn 2; the skip leaves a gap)");
    assert_eq!(rc.len(), 1);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #36/#165 §4.2/§4.35 — an assignment CLAIMS rejected faces (un-rejects
/// and moves them); plain accept never un-rejects.
#[test]
fn rename_merge_claims_rejected() {
    let p = fixture_paths("claim");
    // Unknown1: confirm 1+6, reject 2 (the reject re-homes face 2)
    db::set_link_status(&p, &[1, 6], "confirmed").unwrap();
    db::set_link_status(&p, &[2], "rejected").unwrap();

    // 1) rename-in-place claims the rejected face from the selection
    db::assign_person(&p, &[1, 2, 6], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    let f2 = s.faces.iter().find(|f| f.id == 2).unwrap();
    assert_eq!(f2.person_id, Some(alice.id), "claimed face follows the rename");
    assert_eq!(f2.link_status, "confirmed", "assignment claims (#165)");
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().link_status, "confirmed");
    assert_eq!(s.faces.iter().find(|f| f.id == 6).unwrap().link_status, "confirmed");
    assert_eq!(alice.counts.rejected, 0);

    // 2) merge into an existing person: the claimed face follows
    db::assign_person(&p, &[3], "Carol", "").unwrap(); // Unknown2 → Carol (confirmed)
    db::assign_person(&p, &[1, 2, 6], "Carol", "").unwrap(); // Alice merged into Carol
    let s = db::snapshot(&p).unwrap();
    let carol = s.persons.iter().find(|x| x.name == "Carol").unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Alice"), "emptied Alice shell deleted");
    let f2 = s.faces.iter().find(|f| f.id == 2).unwrap();
    assert_eq!(f2.person_id, Some(carol.id), "the face follows the merge");
    assert_eq!(f2.link_status, "confirmed");

    // 3) plain accept is never an exit from rejected (#165)
    db::set_link_status(&p, &[2], "rejected").unwrap(); // → system person
    db::set_link_status(&p, &[2], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().link_status, "rejected");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// design v1.9 §4.1 — a person left with zero faces by an assignment is
/// deleted: merges and whole-group renames leave no stale shell behind.
#[test]
fn stale_empty_persons_are_deleted() {
    let p = fixture_paths("shell");
    // Unknown2 (id 2) owns exactly one face (3): renaming it in place keeps
    // the person (now Alice) — no shell involved
    db::assign_person(&p, &[3], "Alice", "family|x").unwrap();
    let s = db::snapshot(&p).unwrap();
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    assert_eq!(alice.id, 2, "rename-in-place keeps the person row");
    assert_eq!(alice.groups, vec!["family|x".to_string()]);
    // merging other persons' faces into Alice empties those persons -> shells
    db::assign_person(&p, &[4, 5], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.id != 3), "Unknown3 shell must be deleted");
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    assert_eq!(alice.counts.total, 3);
    assert_eq!(alice.groups, vec!["family|x".to_string()], "merge must not clobber the group");
    // renaming an UnknownN keeps its row (rename-in-place)…
    db::assign_person(&p, &[1, 2, 6], "Bob", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let bob = s.persons.iter().find(|x| x.name == "Bob").unwrap();
    assert_eq!(bob.id, 1, "Unknown1 renamed in place, not moved");
    // …but merging Bob's faces into an EXISTING person empties his row -> shell
    db::assign_person(&p, &[1, 2, 6], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.id != 1), "emptied Bob must be deleted");
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    assert_eq!(alice.counts.total, 6);
    // tree-rename semantics: assign ALL of Alice's faces to a corrected name
    // (new name ⇒ move to a fresh person; the emptied Alice shell must go)
    let ids: Vec<i64> = s.faces.iter().filter(|f| f.person_id == Some(alice.id)).map(|f| f.id).collect();
    db::assign_person(&p, &ids, "Alicia", "family|x").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Alice"), "old shell must be gone");
    let alicia = s.persons.iter().find(|x| x.name == "Alicia").unwrap();
    assert_eq!(alicia.counts.total, 6);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// design v1.16 §4.16 (#50) — group management: rename/move a branch
/// (prefix rewrite incl. sub-branches), delete a branch (members fall to
/// their status seats, §4.35), move persons between groups; membership
/// only, faces and statuses untouched. Status branches are system
/// furniture (#165): no rename/delete, reserved as paths.
#[test]
fn group_management() {
    let p = fixture_paths("groupmgmt");
    // seed groups: Carol family|test, Alice family|test|deep, Bob friends
    db::assign_person(&p, &[4, 5], "Carol", "family|test").unwrap();
    db::assign_person(&p, &[1, 2, 6], "Alice", "family|test|deep").unwrap();
    db::assign_person(&p, &[3], "Bob", "friends").unwrap();

    let groups_of = |name: &str| -> Vec<String> {
        let s = db::snapshot(&p).unwrap();
        s.persons.iter().find(|x| x.name == name).unwrap().groups.clone()
    };
    let status_of = |fid: i64| -> String {
        let s = db::snapshot(&p).unwrap();
        s.faces.iter().find(|f| f.id == fid).unwrap().link_status.clone()
    };
    let faces_of = |name: &str| -> usize {
        let s = db::snapshot(&p).unwrap();
        let pid = s.persons.iter().find(|x| x.name == name).unwrap().id;
        s.faces.iter().filter(|f| f.person_id == Some(pid)).count()
    };

    // 1) rename/move a branch — the prefix rewrite reaches sub-branches
    db::rename_group(&p, "family", "work").unwrap();
    assert_eq!(groups_of("Carol"), vec!["work|test".to_string()]);
    assert_eq!(groups_of("Alice"), vec!["work|test|deep".to_string()]);
    assert_eq!(groups_of("Bob"), vec!["friends".to_string()], "others untouched");

    // 2) guards: inside itself, empty old, reserved name, unknown branch,
    //    status branches (#165/§4.35 — system furniture, refused by path)
    assert!(db::rename_group(&p, "work", "work|inner").is_err());
    assert!(db::rename_group(&p, "work", "work").is_err());
    assert!(db::rename_group(&p, "", "x").is_err());
    assert!(db::rename_group(&p, "work", "x|Ungrouped").is_err());
    assert!(db::rename_group(&p, "nope", "x").is_err(), "empty branch is an error");
    assert!(db::rename_group(&p, "New", "x").is_err(), "status branches cannot be renamed (#165)");
    assert!(db::delete_group(&p, "Accepted").is_err(), "status branches cannot be deleted (#165)");

    // 3) move the branch under another one (frontend computes target|leaf)
    db::rename_group(&p, "work|test", "friends|test").unwrap();
    assert_eq!(groups_of("Carol"), vec!["friends|test".to_string()]);
    assert_eq!(groups_of("Alice"), vec!["friends|test|deep".to_string()]);

    // 4) move persons between groups (single + batch), incl. to the seat
    // (fixture ids: Alice=1, Bob=2, Carol=3)
    db::move_persons_to_group(&p, &[2, 1], "acme").unwrap();
    assert_eq!(groups_of("Bob"), vec!["acme".to_string()]);
    assert_eq!(groups_of("Alice"), vec!["acme".to_string()], "batch move replaces the path");
    db::move_persons_to_group(&p, &[1], "").unwrap();
    // person 1's faces are all confirmed ⇒ the derived seat is Accepted
    assert_eq!(groups_of("Alice"), vec!["Accepted".to_string()], "empty target = status seat (#165)");
    assert!(db::move_persons_to_group(&p, &[2], "a|Ungrouped").is_err());
    assert!(db::move_persons_to_group(&p, &[2], "New").is_err(), "reserved seat path (#165)");
    assert!(db::move_persons_to_group(&p, &[], "x").is_err());
    assert!(db::move_persons_to_group(&p, &[999], "x").is_err());

    // 5) delete a branch — its persons (incl. sub-branches) fall to their
    //    status seats (#165/§4.35; Carol's faces are confirmed → Accepted)
    db::delete_group(&p, "friends").unwrap();
    assert_eq!(groups_of("Carol"), vec!["Accepted".to_string()]);
    assert!(db::delete_group(&p, "friends").is_err(), "already gone");
    assert!(db::delete_group(&p, "").is_err());

    // 6) membership only: faces, statuses and person rows all survived
    assert_eq!(faces_of("Carol"), 2);
    assert_eq!(faces_of("Bob"), 1);
    assert_eq!(status_of(4), "confirmed");
    assert_eq!(status_of(3), "confirmed");
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.len(), 3);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #165 / §4.35 — reserved person name, the system person's guards, the
/// claim rule and the seat derivation in one pass.
#[test]
fn status_seats_and_system_person_guards_165() {
    let p = fixture_paths("guards165");
    // reserved person names (target side of every name-writing path)
    assert!(db::assign_person(&p, &[1, 2], "Rejected", "").is_err());
    assert!(db::set_person_name(&p, 1, "Rejected").is_err());
    assert!(db::set_person_name(&p, 1, "rejected").is_err(), "case-insensitive (#165)");

    // reject re-homes onto the system person, created on demand
    db::set_link_status(&p, &[1], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let rej = s.persons.iter().find(|x| x.name == "Rejected").expect("system person");
    assert_eq!(rej.groups, vec!["Rejected".to_string()], "the fixed seat");
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().person_id, Some(rej.id));

    // the system person is guarded everywhere
    assert!(db::set_person_name(&p, rej.id, "Nope").is_err());
    assert!(db::set_person_group(&p, rej.id, "x").is_err());
    assert!(db::move_persons_to_group(&p, &[rej.id], "x").is_err());
    assert!(db::remove_persons(&p, &[rej.id]).is_err());

    // plain accept never un-rejects; the assignment claims
    db::set_link_status(&p, &[1], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().link_status, "rejected");
    db::assign_person(&p, &[1], "Clara", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let clara = s.persons.iter().find(|x| x.name == "Clara").unwrap();
    let f1 = s.faces.iter().find(|f| f.id == 1).unwrap();
    assert_eq!(f1.person_id, Some(clara.id));
    assert_eq!(f1.link_status, "confirmed", "assignment claims (#165)");
    assert_eq!(clara.groups, vec!["Accepted".to_string()], "empty input seats (#165)");
    // emptied but never deleted: the system person is reused by the next reject
    assert!(
        s.persons.iter().any(|x| x.name == "Rejected"),
        "the emptied system person survives (never swept, §4.35)"
    );
    db::set_link_status(&p, &[6], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(
        s.persons.iter().filter(|x| x.name == "Rejected").count(),
        1,
        "recreated, not duplicated"
    );
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

#[test]
fn rename_keeps_id_and_never_seats_the_caller_178() {
    let p = fixture_paths("rename178");
    let s = db::snapshot(&p).unwrap();
    let u1 = s.persons.iter().find(|x| x.name == "Unknown1").unwrap();
    assert_eq!(u1.groups, vec!["New".to_string()]);
    let same_id = u1.id;
    // #178: the rename sends "" — a seat is NEVER passed (#165's
    // up-front validation would reject 'New' before the in-place branch)
    db::assign_person(&p, &[1, 2, 6], "Dave", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let dave = s.persons.iter().find(|x| x.name == "Dave").unwrap();
    assert_eq!(dave.id, same_id, "rename in place keeps the id");
    assert_eq!(dave.groups, vec!["Accepted".to_string()], "seat derives after the claim");
    assert_eq!(dave.counts.provisional, 0, "all claimed");
    // the caller contract, backend side: a seat still errors, so every
    // caller must send ""; a merge with "" never applies the group (F2)
    let err = db::assign_person(&p, &[3], "Dave", "Accepted").unwrap_err();
    assert!(err.to_string().contains("reserved group name"), "{err}");
    db::assign_person(&p, &[3], "Dave", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let dave = s.persons.iter().find(|x| x.name == "Dave").unwrap();
    assert_eq!(dave.counts.total, 4, "face 3 merged onto Dave");
    assert_eq!(dave.groups, vec!["Accepted".to_string()], "F2: the target's group untouched");
    assert!(
        !s.persons.iter().any(|x| x.name == "Unknown2"),
        "the emptied source shell is deleted"
    );
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #183 / §4.32 — rotating an image cascades the same delta to every
/// crop on it; the converse (rotate_face) never touches the image.
#[test]
fn rotate_image_cascades_to_crops_183() {
    let p = fixture_paths("rot183");
    // image 1 holds faces 1, 2, 6; image 3 holds 4, 5
    assert_eq!(db::rotate_image(&p, 1, 90).unwrap(), 90);
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|x| x.id == 1).unwrap().rotation, 90);
    for f in s.faces.iter().filter(|f| f.image_id == 1) {
        assert_eq!(f.rotation, 90, "face {} cascaded with the image", f.id);
    }
    assert_eq!(
        s.faces.iter().find(|f| f.id == 4).unwrap().rotation,
        0,
        "faces of OTHER images are untouched"
    );

    // the converse: a crop rotation never touches the image
    assert_eq!(db::rotate_face(&p, 1, -90).unwrap(), 0);
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|x| x.id == 1).unwrap().rotation, 90);
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().rotation, 0);
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().rotation, 90);

    // a second image rotation adds to the crop's own correction
    assert_eq!(db::rotate_image(&p, 1, 90).unwrap(), 180);
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|x| x.id == 1).unwrap().rotation, 180);
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().rotation, 90); // 0 + 90
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().rotation, 180); // 90 + 90
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}
