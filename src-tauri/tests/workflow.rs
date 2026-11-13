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
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json"), mode: "repo", env_source: "dotenv" };
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

    // 3) reject / claim roundtrip (#165/#266 §4.2/§4.3/§4.35): reject
    //    re-homes the face onto a RejectedN cluster person, plain accept
    //    never un-rejects, an assignment claims it back
    db::set_link_status(&p, &[5], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f5 = s.faces.iter().find(|f| f.id == 5).unwrap();
    assert_eq!(f5.link_status, "rejected");
    let rej = s.persons.iter().find(|x| x.name == "Rejected1").unwrap();
    assert_eq!(f5.person_id, Some(rej.id), "reject re-homes onto a RejectedN cluster person");
    assert_eq!(rej.groups, vec!["Rejected".to_string()], "the cluster seat");
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

/// #273 — the viewer keys default to empty (system default) when
/// absent from whotrc.json and round-trip when set.
#[test]
fn settings_viewer_keys_default_and_roundtrip() {
    let p = fixture_paths("viewers");
    // legacy whotrc.json without the viewer keys
    std::fs::write(
        &p.config,
        r#"{ "cluster_threshold": 0.5, "refcrop_n": 3 }"#,
    )
    .unwrap();
    let mut s = db::get_settings(&p).unwrap();
    assert_eq!(s.image_viewer, "", "missing key = system default viewer");
    assert_eq!(s.directory_viewer, "", "missing key = system default manager");
    s.image_viewer = "eog".into();
    s.directory_viewer = "thunar".into();
    db::set_settings(&p, s).unwrap();
    let s2 = db::get_settings(&p).unwrap();
    assert_eq!(s2.image_viewer, "eog", "must round-trip");
    assert_eq!(s2.directory_viewer, "thunar", "must round-trip");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
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

/// §4.27 (#84) + #208 — the stale-shell sweep RIDES the writers (a
/// zero-face UnknownN is deleted by the next write, not the next
/// snapshot) and the read path is pure: a snapshot never writes. Named
/// empty persons are legitimate and never swept.
#[test]
fn writers_sweep_stale_unknown_shells_208() {
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
    // the read path is pure: the stamp does not move and nothing is swept
    let v0 = db::data_version(&p).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(db::data_version(&p).unwrap(), v0, "a snapshot must not write (#208)");
    assert!(s.persons.iter().any(|x| x.name == "Unknown80"),
            "the read path no longer sweeps: {:?}",
            s.persons.iter().map(|x| &x.name).collect::<Vec<_>>());
    // the next writer sweeps (§4.27)
    db::set_link_status(&p, &[1], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Unknown80"),
            "zero-face UnknownN must be swept by the write: {:?}",
            s.persons.iter().map(|x| &x.name).collect::<Vec<_>>());
    assert!(s.persons.iter().any(|x| x.name == "Keeper"),
            "a zero-face NAMED person must never be swept");
    // …and it actually deleted the row (not just hid it)
    {
        let con = rusqlite::Connection::open(&p.db).unwrap();
        let n = con
            .query_row("SELECT COUNT(*) FROM persons WHERE name='Unknown80'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(n, 0, "the sweep must DELETE, not filter");
        // a leftover from an EXTERNAL writer is swept by the next write too
        con.execute(
            "INSERT INTO persons(id, name, state, created_at) VALUES (82, 'Unknown82', 'created', ?)",
            params![NOW],
        ).unwrap();
    }
    db::assign_person(&p, &[3], "Zed", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Unknown82"),
            "assign/merge sweeps too (§4.27)");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #210/#212 — refcrop rows are metadata: the filename derives at read
/// from the face (`faces.name + "-" + seq + ".jpg"`) and the crop pixels
/// load through the binary image pipeline (the rows carry no image);
/// a rename moves the filename without touching the rows, and a
/// recompute whose rows come out identical writes nothing.
#[test]
fn refcrops_derive_crop_and_filename_210() {
    let p = fixture_paths("rcderive");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap();
    db::add_refcrop(&p, 1, 2).unwrap(); // manual pin on face 2 (seq 1)
    let rc = db::get_refcrops(&p, 1).unwrap();
    let r2 = rc.iter().find(|r| r.face_id == 2).unwrap();
    assert_eq!(r2.filename, "Unknown1-2-1.jpg", "<face name>-<pin seq>.jpg");
    // #210: compare-and-skip — the same recompute over identical rows
    // leaves the rows untouched (their identity is stable)
    db::set_primary_face(&p, 1, 1).unwrap(); // derives the auto rows once
    let rowids = || -> Vec<i64> {
        let con = rusqlite::Connection::open(&p.db).unwrap();
        let mut st = con.prepare("SELECT rowid FROM person_refcrops ORDER BY rowid").unwrap();
        st.query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    };
    let before = rowids();
    assert_eq!(before.len(), 2, "the pin + one auto row (face 6)");
    db::set_primary_face(&p, 1, 1).unwrap(); // same rows out ⇒ no write
    assert_eq!(rowids(), before, "#210: identical rows must not be rewritten");
    // a rename re-derives the face names — the filenames follow, the rows stay
    db::set_person_name(&p, 1, "Alice").unwrap();
    let rc = db::get_refcrops(&p, 1).unwrap();
    let r2 = rc.iter().find(|r| r.face_id == 2).unwrap();
    assert_eq!(r2.filename, "Alice-2-1.jpg", "derived at read, not rebuilt");
    assert_eq!(rowids(), before, "the rename touched no refcrop rows");
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

/// §4.13/#35/#165/#266 — remove_persons: faces rejected AND re-homed
/// into RejectedN cluster persons (no writer detaches a face anymore),
/// person and its groups/refcrops deleted, other persons untouched; a
/// later assignment claims the faces back.
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
    // faces 1/2/6 are mutually similar (cos .9/.8 ≥ 0.4) ⇒ one cluster bin
    let rej = s.persons.iter().find(|x| x.name == "Rejected1")
        .expect("the cluster person exists");
    for f in s.faces.iter().filter(|f| [1, 2, 6].contains(&f.id)) {
        assert_eq!(f.link_status, "rejected", "face {} must be rejected", f.id);
        assert_eq!(f.person_id, Some(rej.id), "face {} homes on Rejected1 (#266)", f.id);
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

/// design v3.87 §4.16 (#193) — rename/move CLASH = merge: a person in
/// both the source (branch or sub-branch) and the destination path must
/// not raise the unique-constraint failure — the clashing source row is
/// dropped (the person keeps the single destination row), the rest
/// rewrite, and the source branch is absorbed (gone once emptied). An
/// entirely-clashing branch still succeeds.
#[test]
fn rename_group_clash_merges_193() {
    let p = fixture_paths("groupclash193");
    // fixture ids: Unknown1=1 (faces 1,2,6), Unknown2=2 (face 3),
    // Unknown3=3 (faces 4,5)
    db::assign_person(&p, &[1, 2, 6], "Alice", "family").unwrap();
    db::assign_person(&p, &[3], "Bob", "friends").unwrap();
    db::assign_person(&p, &[4, 5], "Carol", "family").unwrap();
    // Carol in BOTH branches: the branch-level clash is set
    db::move_persons_between_groups(&p, &[3], "", "friends").unwrap();

    let groups_of = |name: &str| -> Vec<String> {
        let s = db::snapshot(&p).unwrap();
        s.persons.iter().find(|x| x.name == name).unwrap().groups.clone()
    };
    assert_eq!(
        groups_of("Carol"),
        vec!["family".to_string(), "friends".to_string()]
    );

    // 1) the clash is a merge, not a unique-constraint error
    db::rename_group(&p, "family", "friends").unwrap();
    assert_eq!(groups_of("Alice"), vec!["friends".to_string()], "non-clashing rows rewrite");
    assert_eq!(groups_of("Carol"), vec!["friends".to_string()], "clash drops the source row, keeps the destination");
    assert_eq!(groups_of("Bob"), vec!["friends".to_string()], "others untouched");
    assert!(db::rename_group(&p, "family", "x").is_err(), "the source branch is gone once emptied");

    // 2) sub-branch clash: Carol holds old|test AND friends|test, Dora
    //    holds old|test only
    db::assign_person(&p, &[4], "Dora", "old|test").unwrap();
    db::move_persons_between_groups(&p, &[3], "", "old|test").unwrap();
    db::move_persons_between_groups(&p, &[3], "", "friends|test").unwrap();
    db::rename_group(&p, "old", "friends").unwrap();
    assert_eq!(groups_of("Dora"), vec!["friends|test".to_string()], "sub-branch row rewrites");
    assert_eq!(
        groups_of("Carol"),
        vec!["friends".to_string(), "friends|test".to_string()],
        "the clashing sub-branch row is dropped, the destination kept"
    );

    // 3) entire absorption: the branch's only row clashes — still success
    db::move_persons_between_groups(&p, &[3], "", "solo").unwrap();
    db::rename_group(&p, "solo", "friends").unwrap();
    assert_eq!(
        groups_of("Carol"),
        vec!["friends".to_string(), "friends|test".to_string()]
    );
    assert!(db::rename_group(&p, "solo", "x").is_err(), "the absorbed branch is gone");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #165/#266 / §4.35 — reserved person names, the RejectedN guards, the
/// claim rule and the seat derivation in one pass.
#[test]
fn status_seats_and_system_person_guards_165() {
    let p = fixture_paths("guards165");
    // reserved person names (target side of every name-writing path)
    assert!(db::assign_person(&p, &[1, 2], "Rejected", "").is_err());
    assert!(db::set_person_name(&p, 1, "Rejected").is_err());
    assert!(db::set_person_name(&p, 1, "rejected").is_err(), "case-insensitive (#165)");
    assert!(db::set_person_name(&p, 1, "Rejected1").is_err(), "the family is reserved (#266)");
    assert!(db::assign_person(&p, &[1, 2], "Rejected7", "").is_err(), "the family is reserved (#266)");

    // reject re-homes onto a RejectedN cluster person, created on demand
    db::set_link_status(&p, &[1], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let rej = s.persons.iter().find(|x| x.name == "Rejected1").expect("cluster person");
    assert_eq!(rej.groups, vec!["Rejected".to_string()], "the fixed seat");
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().person_id, Some(rej.id));

    // the cluster person is guarded everywhere
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
    // emptied by claims ⇒ swept (the stale-shell sweep covers the family,
    // §4.27/#266)
    assert!(
        !s.persons.iter().any(|x| x.name == "Rejected1"),
        "the emptied RejectedN is swept (§4.27/#266)"
    );
    db::set_link_status(&p, &[6], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(
        s.persons.iter().filter(|x| x.name == "Rejected1").count(),
        1,
        "the number is reused once the old row is swept"
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
    assert_eq!(db::rotate_image(&p, 1, 90).unwrap().images.unwrap()[0].rotation, 90);
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
    assert_eq!(db::rotate_face(&p, 1, -90).unwrap().faces.unwrap()[0].rotation, 0);
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|x| x.id == 1).unwrap().rotation, 90);
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().rotation, 0);
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().rotation, 90);

    // a second image rotation adds to the crop's own correction
    assert_eq!(db::rotate_image(&p, 1, 90).unwrap().images.unwrap()[0].rotation, 180);
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|x| x.id == 1).unwrap().rotation, 180);
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().rotation, 90); // 0 + 90
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().rotation, 180); // 90 + 90
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #185 / §4.36 — a USABLE database means the schema is present: the
/// missing file and the empty file a failed first load can leave behind
/// both report false, the fixture true.
#[test]
fn has_schema_probes_usable_database_185() {
    let p = fixture_paths("schema185");
    assert!(db::has_schema(&p), "the fixture is usable");
    std::fs::remove_file(&p.db).unwrap();
    assert!(!db::has_schema(&p), "a missing file is not a database");
    // #252: the probe is read-only — it must NOT create the file as a
    // side effect (the old Connection::open left an empty faces.db behind)
    assert!(!p.db.exists(), "the probe must not create a missing database");
    // an empty file — Connection::open creates exactly this on a failed
    // first load, so file-existence alone must never gate the offer
    std::fs::write(&p.db, b"").unwrap();
    assert!(!db::has_schema(&p), "an empty file is not a usable database");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

// ------------------------------------------- session 1 performance (#207–#216)

/// #209 — batch image rotation: one call rotates every image and
/// cascades to the crops exactly like the single command (§4.32); a
/// repeated id rotates once; a missing image rolls the whole batch back
/// (the old per-image loop applied the prefix before failing).
#[test]
fn rotate_images_batch_cascades_209() {
    let p = fixture_paths("rotbatch");
    db::rotate_images(&p, &[1, 2], 90).unwrap();
    let s = db::snapshot(&p).unwrap();
    let rot_img = |id: i64| s.images.iter().find(|i| i.id == id).unwrap().rotation;
    let rot_face = |id: i64| s.faces.iter().find(|f| f.id == id).unwrap().rotation;
    assert_eq!((rot_img(1), rot_img(2), rot_img(3)), (90, 90, 0));
    assert_eq!(
        (rot_face(1), rot_face(2), rot_face(6), rot_face(3), rot_face(4)),
        (90, 90, 90, 90, 0),
        "each crop follows its image (§4.32 cascade)"
    );
    // a repeated id rotates once; negative deltas normalise
    db::rotate_images(&p, &[1, 1], -90).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.images.iter().find(|i| i.id == 1).unwrap().rotation, 0);
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().rotation, 0);
    // a missing image aborts the whole batch — no prefix applied
    assert!(db::rotate_images(&p, &[2, 999], 90).is_err());
    let s = db::snapshot(&p).unwrap();
    assert_eq!(
        s.images.iter().find(|i| i.id == 2).unwrap().rotation, 90,
        "the failed batch rolled back"
    );
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #209 — batch description write: call order decides the shared new
/// group's seqs exactly as the sequential single calls did (§4.4/§4.7);
/// re-stating the same description never renumbers.
#[test]
fn set_face_descriptions_batch_seqs_in_call_order_209() {
    let p = fixture_paths("descbatch");
    db::set_face_descriptions(&p, &[1, 2], "smiling").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f = |id: i64| s.faces.iter().find(|x| x.id == id).unwrap();
    assert_eq!((f(1).description.as_deref(), f(1).seq), (Some("smiling"), 1));
    assert_eq!((f(2).description.as_deref(), f(2).seq), (Some("smiling"), 2));
    assert_eq!(f(1).name, "Unknown1-smiling-1");
    assert_eq!(f(2).name, "Unknown1-smiling-2");
    assert_eq!((f(6).description.as_deref(), f(6).name.as_str()), (None, "Unknown1-3"));
    // no-op repeat: the same tags never renumber
    db::set_face_descriptions(&p, &[1, 2], "smiling").unwrap();
    let s = db::snapshot(&p).unwrap();
    let g = |id: i64| s.faces.iter().find(|x| x.id == id).unwrap().seq;
    assert_eq!((g(1), g(2)), (1, 2));
    // another person's group numbers independently
    db::set_face_descriptions(&p, &[3], "beard").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f3 = s.faces.iter().find(|x| x.id == 3).unwrap();
    assert_eq!(
        (f3.description.as_deref(), f3.seq, f3.name.as_str()),
        (Some("beard"), 1, "Unknown2-beard-1")
    );
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #208 — the change stamp: moves only on real writes (from ANY
/// connection; zero-row writes never move it) and travels with the
/// snapshot, so the GUI can skip no-op focus reloads.
#[test]
fn data_version_tracks_real_changes_only_208() {
    let p = fixture_paths("dver");
    let v0 = db::data_version(&p).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.version, v0, "no write between the two reads");
    assert_eq!(db::data_version(&p).unwrap(), v0, "idle stays put");
    db::set_link_status(&p, &[1], "confirmed").unwrap();
    let v1 = db::data_version(&p).unwrap();
    assert_ne!(v1, v0, "a real write bumps the stamp");
    assert_eq!(
        db::snapshot(&p).unwrap().version, v1,
        "the next snapshot reports it"
    );
    // zero-row writes (the §4.27 sweep's steady state) never bump
    {
        let con = rusqlite::Connection::open(&p.db).unwrap();
        con.execute("DELETE FROM persons WHERE name = 'NoSuch'", []).unwrap();
    }
    assert_eq!(db::data_version(&p).unwrap(), v1);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #211 — the cluster cache: identical inputs hit (no recompute), any
/// change to the clustering inputs recomputes, and the threshold is part
/// of the cache key.
#[test]
fn cluster_cache_hits_until_inputs_change_211() {
    let p = fixture_paths("clcache");
    // pin the primary first: backfill would otherwise move it on the
    // first verdict and change the primary flag of the input rows
    db::set_primary_face(&p, 1, 1).unwrap();
    let a = db::person_face_clusters(&p, 1, 0.5).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.5), 0, "first call computes");
    let b = db::person_face_clusters(&p, 1, 0.5).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.5), 1, "second call hits");
    assert_eq!(format!("{a:?}"), format!("{b:?}"), "the cached result is identical");
    // provisional→confirmed feeds no clustering input — the re-read hits
    db::set_link_status(&p, &[2], "confirmed").unwrap();
    let _ = db::person_face_clusters(&p, 1, 0.5).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.5), 2, "no input changed");
    // a reject drops the face from the input rows — recompute
    db::set_link_status(&p, &[1], "rejected").unwrap();
    let c = db::person_face_clusters(&p, 1, 0.5).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.5), 0, "changed inputs recompute");
    let ids: Vec<i64> = c
        .iter()
        .flat_map(|g| g.clusters.iter().flatten())
        .map(|f| f.face_id)
        .collect();
    assert!(!ids.contains(&1), "the rejected face is gone: {ids:?}");
    // the threshold is part of the key
    let _ = db::person_face_clusters(&p, 1, 0.6).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.5), 0, "the 0.5 entry is untouched");
    let _ = db::person_face_clusters(&p, 1, 0.6).unwrap();
    assert_eq!(db::cluster_cache_hits(&p, 1, 0.6), 1);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #212 — parse the WHOTIMG frame (mirror of src/imageBatch.ts).
fn parse_image_batch(buf: &[u8]) -> Vec<(i64, Vec<u8>)> {
    assert_eq!(&buf[..8], b"WHOTIMG\x01", "frame magic");
    let count = u32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
    let header = 12 + count * 16;
    let mut out = Vec::new();
    for i in 0..count {
        let at = 12 + i * 16;
        let id = i64::from_le_bytes(buf[at..at + 8].try_into().unwrap());
        let off = u32::from_le_bytes(buf[at + 8..at + 12].try_into().unwrap()) as usize;
        let len = u32::from_le_bytes(buf[at + 12..at + 16].try_into().unwrap()) as usize;
        out.push((id, buf[header + off..header + off + len].to_vec()));
    }
    out
}

/// #207/#212 — the pooled connection serves successive calls and still
/// sees every committed write (incl. raw external connections); the
/// batch preview fetch returns id-ordered raw bytes for every face with
/// a preview and skips the rest.
#[test]
fn pooled_connect_and_batch_previews_207_212() {
    let p = fixture_paths("pool");
    let s1 = db::snapshot(&p).unwrap();
    assert_eq!(s1.faces.len(), 6);
    // an external write through a raw connection must be visible
    {
        let con = Connection::open(&p.db).unwrap();
        con.execute("UPDATE faces SET description = 'ext' WHERE id = 6", []).unwrap();
    }
    let s2 = db::snapshot(&p).unwrap();
    assert_eq!(
        s2.faces.iter().find(|f| f.id == 6).unwrap().description.as_deref(),
        Some("ext")
    );
    // #212: one binary batch, deduped id-ordered entries for faces with
    // a preview (raw bytes — no base64)
    let rows =
        parse_image_batch(&db::image_batch_bytes(&p, "face", &[3, 1, 2, 2, 999]).unwrap());
    let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec![1, 2, 3], "deduped, id-ordered, unknown ids skipped");
    // identical bytes to the single-image path
    assert_eq!(rows[0].1, db::face_preview_bytes(&p, 1).unwrap().unwrap());
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #212 — the image-batch frame round-trips and each kind resolves from
/// the right column; missing blobs are omitted and bad kinds refused.
#[test]
fn image_batch_framing_and_kinds_212() {
    let p = fixture_paths("imgbatch");
    // the frame carries exactly the single-path bytes
    let rows = parse_image_batch(&db::image_batch_bytes(&p, "face", &[1, 2, 3, 999]).unwrap());
    assert_eq!(
        rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    for (id, bytes) in &rows {
        assert_eq!(bytes, &db::face_preview_bytes(&p, *id).unwrap().unwrap());
    }
    // images: the seed has no thumbnails/previews until we write some
    assert!(parse_image_batch(&db::image_batch_bytes(&p, "thumb", &[1, 2]).unwrap()).is_empty());
    {
        let con = Connection::open(&p.db).unwrap();
        con.execute(
            "UPDATE images SET thumbnail = x'0102', preview = x'030405' WHERE id = 1",
            [],
        )
        .unwrap();
    }
    assert_eq!(
        parse_image_batch(&db::image_batch_bytes(&p, "thumb", &[1, 2]).unwrap()),
        vec![(1, vec![1, 2])],
        "thumb reads images.thumbnail; missing omitted"
    );
    assert_eq!(
        parse_image_batch(&db::image_batch_bytes(&p, "preview", &[1, 2]).unwrap()),
        vec![(1, vec![3, 4, 5])]
    );
    assert_eq!(
        db::image_thumb_bytes(&p, 1).unwrap().unwrap(),
        vec![1, 2],
        "the single-image path agrees"
    );
    // unknown kinds refuse; empty input frames empty
    assert!(db::image_batch_bytes(&p, "bogus", &[1]).is_err());
    assert!(parse_image_batch(&db::image_batch_bytes(&p, "face", &[]).unwrap()).is_empty());
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #227 — a batch never exceeds its byte cap except a single oversized
/// image (always served alone); deferred ids are a strict id-prefix and
/// re-serve whole when requested alone — the api.ts re-request loop's
/// contract.
#[test]
fn image_batch_byte_cap_truncates_and_defers_227() {
    let p = fixture_paths("capbatch");
    // 3 preview blobs of 2048 bytes each: with cap 4096 exactly two fit
    let blob = |k: u8| vec![k; 2048];
    {
        let con = Connection::open(&p.db).unwrap();
        for (id, k) in [(1, 0x11u8), (2, 0x22), (3, 0x33)] {
            con.execute("UPDATE images SET preview = ? WHERE id = ?", params![blob(k), id]).unwrap();
        }
    }
    // a multi-id batch truncates at the cap: strict id-prefix [1, 2]
    let rows = parse_image_batch(&db::image_batch_bytes_capped(&p, "preview", &[3, 2, 1, 999], 4096).unwrap());
    assert_eq!(
        rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![1, 2],
        "deferred at the cap; unsorted input deduped/ordered"
    );
    assert_eq!(rows[0].1, blob(0x11), "the prefix carries the right bytes");
    // the deferred id re-requested later: served whole (single-id ⇒
    // never truncatable)
    let rows = parse_image_batch(&db::image_batch_bytes_capped(&p, "preview", &[3], 4096).unwrap());
    assert_eq!(
        rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![3]
    );
    // a single-id request is NEVER truncatable — one oversized image
    // (> the whole cap) is served in full
    let rows = parse_image_batch(&db::image_batch_bytes_capped(&p, "preview", &[1], 100).unwrap());
    assert_eq!(rows, vec![(1, blob(0x11))]);
    // a lone genuinely-missing id stays a miss (the frontend caches null)
    assert!(parse_image_batch(&db::image_batch_bytes_capped(&p, "preview", &[999], 8192).unwrap()).is_empty());
    // untruncated path unchanged: cap 32 MiB default via image_batch_bytes
    let rows = parse_image_batch(&db::image_batch_bytes(&p, "preview", &[1, 2, 3]).unwrap());
    assert_eq!(
        rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "small blobs are never truncated by the default cap"
    );
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #218 — the async command surface: concurrent readers and writers
/// contend on the same pooled connection from DIFFERENT threads and
/// stay serialised (no deadlock, no torn reads) — exactly the
/// multi-thread situation the async commands introduce.
#[test]
fn concurrent_readers_and_writers_serialised_218() {
    let p = fixture_paths("concur");
    let paths_for = |p: &Paths| Paths { root: p.root.clone(), db: p.db.clone(), config: p.config.clone(), mode: p.mode, env_source: p.env_source };
    let reader = std::thread::spawn({
        let paths = paths_for(&p);
        move || {
            for _ in 0..30 {
                let s = db::snapshot(&paths).unwrap();
                assert!(s.faces.len() >= 6, "torn read: faces vanished");
            }
        }
    });
    // writer thread: a note write loop with real transactions
    let writer = std::thread::spawn({
        let paths = paths_for(&p);
        move || {
            for i in 0..30 {
                db::set_person_note(&paths, 1, &format!("note {i}")).unwrap();
            }
        }
    });
    reader.join().unwrap();
    writer.join().unwrap();
    // the last write must be visible and the snapshot stays consistent
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.iter().find(|x| x.id == 1).unwrap().note.as_deref(), Some("note 29"));
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #218 — every `#[tauri::command]` fn is `async fn` (off the UI main
/// thread) except the listed cheap ones (runner-mutex / config-file
/// only). A new command must be CONSCIOUSLY filed into one of the two
/// lists — this is the guard for the #218 decision.
#[test]
fn commands_run_off_the_main_thread_218() {
    // runner-mutex / config-file only: no DB, no blobs, no fs walks
    const ALLOW_SYNC: [&str; 6] = [
        "get_data_version", // one PRAGMA on the persistent probe connection
        "get_settings",     // config file read
        "set_settings",     // config file write
        "start_import",     // runner mutex + one spawn + one fs is_file check
        "stop_import",      // runner mutex + one child wait
        "get_import_status", // runner mutex + bounded line slice
    ];
    let src = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"));
    // Collect (name, is_async) for each #[tauri::command] fn
    let mut commands: Vec<(&str, bool)> = Vec::new();
    let bytes = src.as_bytes();
    let mut pos = 0;
    while let Some(at) = src[pos..].find("#[tauri::command]") {
        let start = pos + at + "#[tauri::command]".len();
        // the first non-comment, non-empty line after the attribute is
        // the fn head: "fn NAME(" or "async fn NAME("
        let mut line_start = start;
        loop {
            let line_end = bytes[line_start..]
                .iter()
                .position(|&b| b == b'\n')
                .map(|i| line_start + i)
                .unwrap_or(src.len());
            let line = src[line_start..line_end].trim();
            if !line.is_empty() && !line.starts_with("//") {
                let t = line.split_whitespace().collect::<Vec<_>>();
                // e.g. ["async", "fn", "NAME("...] | ["fn", "NAME("...]
                let is_async = t[0] == "async";
                let fn_at = if is_async { 1 } else { 0 };
                assert!(t[fn_at] == "fn", "unexpected line after #[tauri::command]: {line}");
                let name = t[fn_at + 1].split('(').next().unwrap();
                commands.push((name, is_async));
                break;
            }
            line_start = line_end + 1;
            if line_start >= src.len() {
                panic!("#[tauri::command] with no fn head");
            }
        }
        pos = pos + at + 1;
    }
    assert!(commands.len() >= 30, "command surface sanity: {}", commands.len());
    for (name, is_async) in &commands {
        if ALLOW_SYNC.contains(name) {
            assert!(!is_async, "{name} must stay in the sync allowlist shape");
        } else {
            assert!(is_async, "{name} is DB-backed and must be `async fn` (#218)");
        }
    }
    for name in ALLOW_SYNC {
        assert!(
            commands.iter().any(|(n, _)| *n == name),
            "allowlist entry {name} is no longer a command — drop it from the list"
        );
    }
}

// ---------------------------------------------------------------- #219 delta protocol

/// #219 — a mutation's `Delta` carries ONLY the touched rows (the owner
/// person + the accepted face), the post-write stamp, and no images/
/// removed — so the GUI applies a diff instead of a full re-fetch.
#[test]
fn delta_carries_only_touched_rows_219() {
    let p = fixture_paths("delta219");
    // accept face 1 (owner: person 1, faces 1/2/6)
    let d = db::set_link_status(&p, &[1], "confirmed").unwrap();
    assert!(!d.drifted);
    assert_eq!(d.version, db::data_version(&p).unwrap(), "stamp is post-write");
    // only the touched face moved
    let faces = d.faces.as_ref().unwrap();
    assert_eq!(faces.iter().map(|f| f.id).collect::<Vec<_>>(), vec![1]);
    assert_eq!(faces[0].link_status, "confirmed");
    // only the owner person re-derived; untouched persons absent
    let persons = d.persons.as_ref().unwrap();
    let ids: Vec<i64> = persons.iter().map(|x| x.id).collect();
    assert!(ids.contains(&1), "owner person 1 in the delta: {ids:?}");
    assert!(!ids.contains(&2), "person 2 untouched");
    assert!(!ids.contains(&3), "person 3 untouched");
    // the owner's counts re-derived in the person row
    let p1 = persons.iter().find(|x| x.id == 1).unwrap();
    assert_eq!(p1.counts.total, 3);
    assert_eq!(p1.counts.confirmed, 1);
    // no images touched, nothing removed
    assert!(d.images.is_none());
    assert!(d.removed.is_empty());
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #219 — `remove_persons` reports the dropped ids in `removed` and
/// carries the re-homed faces + the `Rejected` person in the delta.
#[test]
fn delta_remove_persons_reports_removed_219() {
    let p = fixture_paths("delta219rm");
    // remove person 2 (face 3 re-homes onto `Rejected`)
    let d = db::remove_persons(&p, &[2]).unwrap();
    assert!(!d.drifted);
    assert_eq!(d.version, db::data_version(&p).unwrap());
    assert_eq!(d.removed, vec![2], "the deleted person id is reported");
    // the re-homed face is in the delta (now rejected, on `Rejected1`)
    let faces = d.faces.as_ref().unwrap();
    let f3 = faces.iter().find(|f| f.id == 3).unwrap();
    assert_eq!(f3.link_status, "rejected");
    // the `Rejected1` person row is present (the re-home target)
    let persons = d.persons.as_ref().unwrap();
    assert!(persons.iter().any(|x| x.name == "Rejected1"), "Rejected1 in the delta");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #219 — `assign_person` re-derives the target's face names (all their
/// faces re-fetched via person_face_ids) and reports no removals when a
/// cluster is renamed in place.
#[test]
fn delta_assign_rederives_names_219() {
    let p = fixture_paths("delta219assign");
    // rename Unknown3 (faces 4,5) in place to Carol
    let d = db::assign_person(&p, &[4, 5], "Carol", "family").unwrap();
    assert!(!d.drifted);
    assert_eq!(d.version, db::data_version(&p).unwrap());
    // the target person (renamed in place) is in the delta
    let persons = d.persons.as_ref().unwrap();
    assert!(persons.iter().any(|x| x.name == "Carol"));
    // all its faces re-named (person_face_ids = [target])
    let faces = d.faces.as_ref().unwrap();
    let f4 = faces.iter().find(|f| f.id == 4).unwrap();
    assert!(f4.name.starts_with("Carol-"), "name re-derived: {}", f4.name);
    // rename-in-place keeps the person — nothing removed
    assert!(d.removed.is_empty());
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #219 — drift detection: `delta_after` flags a stale pre-write stamp
/// (v2 > v1 + 1 means an external write interleaved). The GUI then falls
/// back to a full refresh instead of applying an incomplete delta.
#[test]
fn delta_drift_flags_stale_prewrite_219() {
    let p = fixture_paths("delta219drift");
    let con = db::connect(&p).unwrap();
    let v_now = db::data_version(&p).unwrap();
    // a stale pre-read (external write moved the stamp by > 1) ⇒ drift
    let d = db::delta_after(&p, &*con, v_now - 5, &[], &[], &[], &[], Vec::new()).unwrap();
    assert!(d.drifted, "v2 > v1 + 1 ⇒ drift");
    // a fresh pre-read (no external write) ⇒ no drift
    let d2 = db::delta_after(&p, &*con, v_now, &[], &[], &[], &[], Vec::new()).unwrap();
    assert!(!d2.drifted, "no external write ⇒ no drift");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

// ---------------------------------------------------------------- #281
// performance-review §6.3 N3 — the delta protocol's coverage edges. The
// `base` stamp makes staleness exact (an external write BEFORE the
// command's pre-read is visible to the GUI), and every deletion the
// command performed rides `removed` (the §4.27 sweep, the #266 legacy
// split) so swept shells leave the tree instead of lingering.

/// #281 — `base` is the command's pre-write stamp: the GUI compares it
/// against the stamp of the state it applied, so an external write that
/// landed before the pre-read (which `v2 > v1 + 1` cannot see) is
/// detectable. Pin that `base` is genuinely the pre-read, not a copy of
/// the post-commit `version`.
#[test]
fn delta_base_is_the_prewrite_stamp_281() {
    let p = fixture_paths("base281");
    let v0 = db::data_version(&p).unwrap();
    let d = db::set_link_status(&p, &[1], "confirmed").unwrap();
    assert_eq!(d.base, v0, "base = the stamp read before the write");
    assert_eq!(d.version, db::data_version(&p).unwrap(), "version = post-commit");
    assert!(d.version > d.base, "the write moved the stamp");
    // an external write lands BEFORE the next command's pre-read: `base`
    // reflects the (already moved) pre-read stamp — the GUI's own
    // comparison (`base` != its applied stamp) is what flags it, not
    // `drifted` (the count never moves by > 1 in-command)
    let ext = db::connect(&p).unwrap();
    ext.execute("UPDATE persons SET note = 'x' WHERE id = 2", []).unwrap();
    drop(ext);
    let v1 = db::data_version(&p).unwrap();
    let d2 = db::set_link_status(&p, &[1], "confirmed").unwrap();
    assert_eq!(d2.base, v1, "base tracks the pre-read, not the old state");
    assert!(!d2.drifted, "no in-command interleaving: drifted stays false");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #281 — the §4.27 sweep's deletions ride `removed`: a reject that
/// empties an `UnknownN` (its faces re-homed) and a claim that empties a
/// writer-owned `RejectedN` both leave the GUI holding stale shell rows
/// unless the swept ids are reported.
#[test]
fn swept_shells_ride_removed_281() {
    let p = fixture_paths("sweep281");
    // reject face 3 — its owner Unknown2 is emptied by the re-home and
    // swept by the same write: the id must be reported
    let d = db::set_link_status(&p, &[3], "rejected").unwrap();
    assert!(d.removed.contains(&2), "swept Unknown2 reported: {:?}", d.removed);
    let rej1: i64 = {
        let con = db::connect(&p).unwrap();
        con.query_row("SELECT id FROM persons WHERE name = 'Rejected1'", [], |r| r.get(0)).unwrap()
    };
    // claim the rejected face for Alice — the claim un-rejects it, the
    // emptied `Rejected1` is writer-owned (never deleted inline, only
    // swept): the swept id must be reported
    let d2 = db::assign_person(&p, &[3], "Alice", "").unwrap();
    assert!(d2.removed.contains(&rej1),
            "swept Rejected1 ({rej1}) reported: {:?}", d2.removed);
    // and the row itself is gone from the delta's persons — the GUI
    // drops it by id instead of upserting a shell
    let persons = d2.persons.as_ref().unwrap();
    assert!(!persons.iter().any(|x| x.id == rej1), "swept shell not upserted");
    // the claimed face landed confirmed on Alice
    let faces = d2.faces.as_ref().unwrap();
    let f3 = faces.iter().find(|f| f.id == 3).unwrap();
    assert_eq!(f3.link_status, "confirmed");
    assert!(f3.name.starts_with("Alice-"), "name re-derived: {}", f3.name);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #281 — the #266 legacy split (a reject retires the old single
/// `Rejected` bin) is part of the reject write: the deleted legacy id
/// rides `removed`, the `RejectedN` targets that received its faces ride
/// the delta's persons, and the moved faces ride the delta's faces.
#[test]
fn split_legacy_rides_delta_281() {
    let p = fixture_paths("split281");
    // the legacy state: a single `Rejected` person holding two faces
    let legacy: i64 = {
        let con = db::connect(&p).unwrap();
        con.execute(
            "INSERT INTO persons(name, state, created_at) VALUES ('Rejected', 'created', ?)",
            rusqlite::params![NOW],
        ).unwrap();
        con.last_insert_rowid()
    };
    seed_faces(&p.db, legacy, 100, &["", ""]);
    // a reject on an unrelated face retires the legacy bin first
    let d = db::set_link_status(&p, &[1], "rejected").unwrap();
    // the legacy person is deleted and reported
    assert_eq!(d.removed, vec![legacy], "the retired bin rides removed");
    let persons = d.persons.as_ref().unwrap();
    let targets: Vec<&db::Person> = persons
        .iter()
        .filter(|x| x.name.starts_with("Rejected") && x.name != "Rejected")
        .collect();
    assert!(!targets.is_empty(), "the RejectedN targets ride persons");
    // both legacy faces moved onto a RejectedN target and are in the delta
    let faces = d.faces.as_ref().unwrap();
    for fid in [100i64, 101] {
        let f = faces.iter().find(|f| f.id == fid)
            .unwrap_or_else(|| panic!("legacy face {fid} in the delta"));
        assert_eq!(f.person_id, Some(targets[0].id), "re-homed onto the target");
        assert_eq!(f.link_status, "rejected");
    }
    // and the row is really gone
    let s = db::snapshot(&p).unwrap();
    assert!(!s.persons.iter().any(|x| x.name == "Rejected"));
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #281/#283 — `rotate_images` is one set-based statement pair for the
/// whole batch (the old per-image loop was 3 statements × N): the
/// write-phase statement count is constant in the image count. Also
/// pins the in-tx delta face read (#281): every face of every rotated
/// image is in the delta.
#[test]
fn rotate_images_write_phase_is_constant_281() {
    let count = |name: &str, ids: &[i64]| -> (usize, db::Delta) {
        let p = fixture_paths(name);
        {
            let mut con = db::connect(&p).unwrap();
            con.trace(Some(counting_trace));
        }
        let d = db::rotate_images(&p, ids, 90).unwrap();
        let seen = STMT_SEEN.load(Ordering::SeqCst);
        {
            let mut con = db::connect(&p).unwrap();
            con.trace(None);
        }
        std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
        (seen, d)
    };
    let (one, d1) = count("rot281a", &[1]);
    let (three, d3) = count("rot281b", &[1, 2, 3]);
    assert_eq!(one, three,
               "write phase is constant in the image count: {one} vs {three}");
    // #281: the delta carries every face on every rotated image (read
    // inside the tx) plus the image rows
    let mut ids: Vec<i64> = d3.faces.as_ref().unwrap().iter().map(|f| f.id).collect();
    ids.sort();
    assert_eq!(ids, vec![1, 2, 3, 4, 5, 6], "all faces of the 3 images");
    assert_eq!(
        d3.images.as_ref().unwrap().iter().map(|i| i.id).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(d3.persons.is_none(), "no person rows move on a rotation");
    let _ = d1;
}

/// #283 (N4) — the §9 multi-row moves are set-based: the write phase is
/// constant in the selection size (the old loop was 2–3 statements per
/// person: DELETE from-membership + INSERT to + seat drop).
#[test]
fn move_persons_write_phase_is_constant_283() {
    let count = |name: &str, ids: &[i64]| -> usize {
        let p = fixture_paths(name);
        {
            let mut con = db::connect(&p).unwrap();
            con.trace(Some(counting_trace));
        }
        let _ =
            db::move_persons_between_groups(&p, ids, "New", "Group1|Group2").unwrap();
        let seen = STMT_SEEN.load(Ordering::SeqCst);
        {
            let mut con = db::connect(&p).unwrap();
            con.trace(None);
        }
        std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
        seen
    };
    let one = count("mv283a", &[1]);
    let three = count("mv283b", &[1, 2, 3]);
    assert_eq!(one, three,
               "write phase constant in the selection size: {one} vs {three}");
}

// ---------------------------------------------------------------- #220
// performance-review §3.2 B-M2/B-M3/B-M4 — write-path N+1. The
// acceptance line: a reject batch over F faces must not run more than
// 2·F statements (the old per-face MAX+UPDATE loop ran exactly 2 per
// face, before even counting the per-person existence checks).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static STMT_ARMED: AtomicBool = AtomicBool::new(false);
static STMT_SEEN: AtomicUsize = AtomicUsize::new(0);

/// `Connection::trace` callback — counts every statement executed while
/// armed. Only the fixture's own pooled connection carries the trace, so
/// parallel tests on other fixtures never fire it.
/// Counts the statements of the WRITE PHASE only — from `BEGIN` to
/// `COMMIT`. That is the window the old per-face MAX+UPDATE loop lived in
/// (B-M2); the per-person name refresh after commit is a fixed cost per
/// person, not a per-face one.
fn counting_trace(sql: &str) {
    if sql.starts_with("BEGIN") {
        STMT_ARMED.store(true, Ordering::SeqCst);
        STMT_SEEN.store(0, Ordering::SeqCst);
        return;
    }
    if !STMT_ARMED.load(Ordering::SeqCst) {
        return;
    }
    if sql.starts_with("COMMIT") || sql.starts_with("ROLLBACK") {
        STMT_ARMED.store(false, Ordering::SeqCst);
        return;
    }
    STMT_SEEN.fetch_add(1, Ordering::SeqCst);
}

/// Seed F extra faces on `person_id` (image 1) with the given
/// descriptions, ids starting at `first_id` — through a SEPARATE
/// connection so the counting window below only sees the batch itself.
fn seed_faces(db_path: &std::path::Path, person_id: i64, first_id: i64, descs: &[&str]) {
    let con = Connection::open(db_path).unwrap();
    // #266: the shared identity embedding [1.0, 0, 0, 0] — every seeded
    // face decodes to the same unit-length vector (matching face 1's
    // identity vector in the base fixture), so a reject batch over them
    // joins ONE RejectedN cluster bin (§4.35), keeping the per-(bin,
    // description) seq-group assertions face-count-independent
    let blob: Vec<u8> = [1.0f32, 0.0, 0.0, 0.0]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    for (i, desc) in descs.iter().enumerate() {
        con.execute(
            "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state, origin,
                               description, name, seq, confidence, detected_in_import_id,
                               created_at, description_key)
             VALUES (?, 1, ?, 0, 10, 10, ?, 'provisional', 'detected', 'insightface',
                     ?, ?, ?, 0.9, 1, '2026-10-15T00:00:00', ?)",
            rusqlite::params![
                first_id + i as i64,
                500 + i,                      // x unique per image
                person_id,
                *desc,
                format!("seed-{first_id}-{i}"),
                i as i64 + 1,
                desc,
            ],
        ).unwrap();
        con.execute(
            "INSERT INTO face_embeddings(face_id, model, dim, vector, created_at)
             VALUES (?, 'insightface:buffalo_l', 4, ?, '2026-10-15T00:00:00')",
            rusqlite::params![first_id + i as i64, blob.clone()],
        ).unwrap();
    }
}

/// Run a reject batch over `descs` faces (all on Unknown1) in a fresh
/// fixture and return the write-phase statement count (BEGIN..COMMIT).
fn reject_count_fixture(name: &str, first_id: i64, descs: &[&str]) -> usize {
    let p = fixture_paths(name);
    seed_faces(&p.db, 1, first_id, descs);
    let fids: Vec<i64> = (first_id..first_id + descs.len() as i64).collect();
    // arm the trace on the pooled connection, release the guard, then run
    // the batch (which re-checks the pool — no deadlock). The counter
    // itself opens at BEGIN and closes at COMMIT (see counting_trace).
    {
        let mut con = db::connect(&p).unwrap();
        con.trace(Some(counting_trace));
    }
    let _ = db::set_link_status(&p, &fids, "rejected").unwrap();
    let seen = STMT_SEEN.load(Ordering::SeqCst);
    {
        let mut con = db::connect(&p).unwrap();
        con.trace(None);
    }
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
    seen
}

/// #220 — a reject batch must not scale with its FACE count (B-M2,
/// statement-level instrument): the same two description groups with 5
/// and with 15 faces may add at most one write-phase statement (the old
/// per-face MAX+UPDATE loop adds exactly 2 per face — 20 here).
#[test]
fn reject_batch_no_per_face_scaling_220() {
    let small = reject_count_fixture("stmtsmall220", 101, &["", "", "", "glasses", "glasses"]);
    let large = reject_count_fixture(
        "stmtlarge220",
        101,
        &["", "", "", "", "", "", "", "", "", "", "glasses", "glasses", "glasses", "glasses", "glasses"],
    );
    let growth = large.saturating_sub(small);
    assert!(
        growth <= 1,
        "#220/B-M2: growing a two-group reject batch from 5 to 15 faces added \
         {growth} write-phase statements — the old per-face MAX+UPDATE loop \
         adds exactly 2 per face (20 here); the batch must not scale with \
         face count (performance-review §3.2)",
    );
}

/// #220/#266 — set-based seq assignment keeps the gap-proof F5 semantics
/// across MULTIPLE description groups in one batch, per cluster bin:
/// each (RejectedN, key) group numbers from its own pre-batch MAX,
/// positions in id order, names per §4.7 — and groups/bins not in the
/// batch are untouched.
#[test]
fn reject_multigroup_seq_monotonic_220() {
    let p = fixture_paths("seqmono220");
    // pre-state: faces 1 (Unknown1) and 4 (Unknown3) already rejected —
    // dissimilar embeddings (cos 0) ⇒ TWO separate cluster bins
    db::set_link_status(&p, &[1, 4], "rejected").unwrap();
    let rej1: i64 = {
        let con = db::connect(&p).unwrap();
        con.query_row("SELECT id FROM persons WHERE name = 'Rejected1'", [], |r| r.get(0)).unwrap()
    };
    let rej2: i64 = {
        let con = db::connect(&p).unwrap();
        con.query_row("SELECT id FROM persons WHERE name = 'Rejected2'", [], |r| r.get(0)).unwrap()
    };
    // Rejected1 already has an 'a'-group face (seq 1); Unknown2 has three
    // 'b' faces and one 'a' face whose embeddings match face 1 — reject
    // the four in ONE batch (they all join Rejected1)
    let con = Connection::open(&p.db).unwrap();
    con.execute(
        "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state, origin,
                           description, name, seq, confidence, detected_in_import_id,
                           created_at, description_key)
         VALUES (201, 2, 500, 0, 10, 10, ?, 'rejected', 'detected', 'insightface',
                 'a', 'Rejected1-a-1', 1, 0.9, 1, '2026-10-15T00:00:00', 'a')",
        rusqlite::params![rej1],
    ).unwrap();
    seed_faces(&p.db, 2, 202, &["a", "b", "b", "b"]);
    db::set_link_status(&p, &[202, 203, 204, 205], "rejected").unwrap();
    // verify per group: seqs contiguous from the pre-batch MAX, id order,
    // §4.7 names, and the untouched '' group keeps its lone face
    let con = Connection::open(&p.db).unwrap();
    let mut st = con.prepare(
        "SELECT id, description_key, seq, name FROM faces
          WHERE person_id = ? ORDER BY description_key, id").unwrap();
    let rows: Vec<(i64, String, i64, String)> = st
        .query_map(rusqlite::params![rej1], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let by_group = |key: &str| -> Vec<(i64, i64, String)> {
        rows.iter()
            .filter(|(_, k, _, _)| k == key)
            .map(|(id, _, seq, name)| (*id, *seq, name.clone()))
            .collect()
    };
    let empty = by_group("");
    assert_eq!(empty, vec![(1, 1, "Rejected1-1".into())],
               "group not in the batch is untouched: {empty:?}");
    let a = by_group("a");
    assert_eq!(a, vec![(201, 1, "Rejected1-a-1".into()), (202, 2, "Rejected1-a-2".into())],
               "'a' continues from the pre-batch MAX: {a:?}");
    let b = by_group("b");
    assert_eq!(b, vec![(203, 1, "Rejected1-b-1".into()), (204, 2, "Rejected1-b-2".into()),
                       (205, 3, "Rejected1-b-3".into())],
               "'b' numbers 1..n in id order: {b:?}");
    // the other bin is untouched by the batch
    let mut st2 = con.prepare(
        "SELECT id, description_key, seq, name FROM faces
          WHERE person_id = ? ORDER BY id").unwrap();
    let rows2: Vec<(i64, String, i64, String)> = st2
        .query_map(rusqlite::params![rej2], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows2, vec![(4, String::new(), 1, "Rejected2-1".into())],
               "the other bin is untouched: {rows2:?}");
    let names: std::collections::HashSet<&str> =
        rows.iter().map(|(_, _, _, n)| n.as_str()).collect();
    assert_eq!(names.len(), rows.len(), "no duplicate names after the batch");
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}
