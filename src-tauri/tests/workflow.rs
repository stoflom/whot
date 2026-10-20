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
    let paths = Paths { db: root.join("faces.db"), config: root.join("whotrc.json") };
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
        con.execute(
            "INSERT INTO person_groups(person_id, path) VALUES (?, 'Unknown')",
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

    // 3) reject / re-accept roundtrip (§4.2/§4.3)
    db::set_link_status(&p, &[5], "rejected").unwrap();
    let s = db::snapshot(&p).unwrap();
    let f5 = s.faces.iter().find(|f| f.id == 5).unwrap();
    assert_eq!(f5.link_status, "rejected");
    assert!(s.persons.iter().find(|x| x.name == "Carol").unwrap().primary_face_id != Some(5));
    db::set_link_status(&p, &[5], "confirmed").unwrap();

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
    assert!(db::get_settings(&p).unwrap().show_rejected);

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
    // trigger two recomputes
    db::set_link_status(&p, &[5], "rejected").unwrap();
    db::set_link_status(&p, &[5], "confirmed").unwrap();
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

/// F7 — renaming an UnknownN via the detail pane must drop the 'Unknown'
/// group path so the person leaves the Unknown tree branch.
#[test]
fn rename_unknown_clears_unknown_group() {
    let p = fixture_paths("rename");
    let s = db::snapshot(&p).unwrap();
    let u2 = s.persons.iter().find(|x| x.name == "Unknown2").unwrap();
    assert_eq!(u2.groups, vec!["Unknown".to_string()]);
    db::set_person_name(&p, 2, "Erin").unwrap();
    let s = db::snapshot(&p).unwrap();
    let erin = s.persons.iter().find(|x| x.name == "Erin").unwrap();
    assert!(erin.groups.is_empty(), "renamed person must leave the Unknown branch: {:?}", erin.groups);
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

/// #23 — show_rejected defaults to true when the key is absent and round-trips.
#[test]
fn settings_show_rejected_default_and_roundtrip() {
    let p = fixture_paths("settings");
    // legacy whotrc.json without the key
    std::fs::write(&p.config, r#"{ "cluster_threshold": 0.5, "refcrop_n": 3 }"#).unwrap();
    let s = db::get_settings(&p).unwrap();
    assert!(s.show_rejected, "missing key must default to true");
    assert_eq!(s.refcrop_n, 3);
    let mut s2 = s;
    s2.show_rejected = false;
    db::set_settings(&p, s2).unwrap();
    assert!(!db::get_settings(&p).unwrap().show_rejected, "must round-trip");
    // no whotrc.json at all
    std::fs::remove_file(&p.config).ok();
    assert!(db::get_settings(&p).unwrap().show_rejected);
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
    db::set_link_status(&p, &[6], "rejected").unwrap(); // trigger recompute
    db::set_link_status(&p, &[6], "confirmed").unwrap();
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

/// §4.13/#35 — remove_persons: faces rejected + detached, person and its
/// groups/refcrops deleted, other persons untouched, unowned faces are
/// still addressable (assign moves them back into the fold).
#[test]
fn remove_persons_rejects_detaches_deletes() {
    let p = fixture_paths("remove");
    db::set_link_status(&p, &[1, 2, 6], "confirmed").unwrap(); // person 1
    db::add_refcrop(&p, 1, 2).unwrap();                        // pin → must cascade
    db::set_link_status(&p, &[4, 5], "confirmed").unwrap();    // person 3 keeps its own
    db::remove_persons(&p, &[1]).unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().all(|x| x.id != 1), "person 1 must be gone");
    assert!(s.persons.iter().any(|x| x.id == 3), "other persons untouched");
    for f in s.faces.iter().filter(|f| [1, 2, 6].contains(&f.id)) {
        assert_eq!(f.link_status, "rejected", "face {} must be rejected", f.id);
        assert_eq!(f.person_id, None, "face {} must be unowned", f.id);
    }
    // refcrops cascaded with the person
    assert!(db::get_refcrops(&p, 1).unwrap().is_empty());
    // a removed person's faces move with an assignment but keep their
    // rejected status (sticky, §4.2); the explicit accept re-claims them
    db::assign_person(&p, &[6], "Rescued", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let rescued = s.persons.iter().find(|x| x.name == "Rescued").unwrap().id;
    let f6 = s.faces.iter().find(|f| f.id == 6).unwrap();
    assert_eq!(f6.person_id, Some(rescued));
    assert_eq!(f6.link_status, "rejected", "assignment must not un-reject");
    db::set_link_status(&p, &[6], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.faces.iter().find(|f| f.id == 6).unwrap().link_status, "confirmed");
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

/// #44 — a malformed whotrc.json falls back to the defaults (with a
/// visible warning) instead of vanishing silently; a missing file is a
/// first run and stays quiet.
#[test]
fn corrupt_settings_file_falls_back_to_defaults() {
    let p = fixture_paths("corruptcfg");
    std::fs::write(&p.config, "{ not json !").unwrap();
    assert_eq!(db::get_settings(&p).unwrap(), db::Settings::default());
    // a well-formed file still wins
    let mut s2 = db::Settings::default();
    s2.refcrop_n = 7;
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

/// #42 — group paths are normalised on the write side: segments trimmed,
/// empties dropped, whitespace-only path ⇒ ungrouped.
#[test]
fn group_paths_normalised_on_write() {
    let p = fixture_paths("groups");
    db::set_person_group(&p, 1, "  family |  test  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    let u1 = s.persons.iter().find(|x| x.id == 1).unwrap();
    assert_eq!(u1.groups, vec!["family|test".to_string()]);
    // empties collapse; a whitespace-only path means ungrouped
    db::set_person_group(&p, 1, "a || b |  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.persons.iter().find(|x| x.id == 1).unwrap().groups, vec!["a|b".to_string()]);
    db::set_person_group(&p, 1, "   |  ").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert!(s.persons.iter().find(|x| x.id == 1).unwrap().groups.is_empty());
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
    // a mutation that triggers person 1's recompute must not error
    db::set_link_status(&p, &[6], "rejected").unwrap();
    db::set_link_status(&p, &[6], "confirmed").unwrap();
    let rc = db::get_refcrops(&p, 1).unwrap();
    assert!(rc.iter().all(|r| r.face_id != 2), "crop-less face must be skipped");
    let f6 = rc.iter().find(|r| r.face_id == 6).expect("face 6 still a refcrop");
    assert_eq!(f6.seq, 2, "face 6 keeps its rank position (rn 2; the skip leaves a gap)");
    assert_eq!(rc.len(), 1);
    std::fs::remove_dir_all(p.db.parent().unwrap()).ok();
}

/// #36 / design v1.12 §4.2 — `rejected` is sticky: a rename or merge moves
/// a person's rejected faces along but never re-confirms them; only an
/// explicit accept un-rejects.
#[test]
fn rename_merge_keeps_rejected_sticky() {
    let p = fixture_paths("sticky");
    // Unknown1: confirm 1+6, reject 2
    db::set_link_status(&p, &[1, 6], "confirmed").unwrap();
    db::set_link_status(&p, &[2], "rejected").unwrap();

    // 1) rename-in-place: the rejected face keeps its status
    db::assign_person(&p, &[1, 2, 6], "Alice", "").unwrap();
    let s = db::snapshot(&p).unwrap();
    let alice = s.persons.iter().find(|x| x.name == "Alice").unwrap();
    let f2 = s.faces.iter().find(|f| f.id == 2).unwrap();
    assert_eq!(f2.person_id, Some(alice.id));
    assert_eq!(f2.link_status, "rejected", "rename must not un-reject");
    assert_eq!(s.faces.iter().find(|f| f.id == 1).unwrap().link_status, "confirmed");
    assert_eq!(s.faces.iter().find(|f| f.id == 6).unwrap().link_status, "confirmed");
    assert_ne!(alice.primary_face_id, Some(2), "rejected face is not a primary candidate");

    // 2) merge into an existing person: the rejected face follows, still rejected
    db::assign_person(&p, &[3], "Carol", "").unwrap(); // Unknown2 → Carol (confirmed)
    db::assign_person(&p, &[1, 2, 6], "Carol", "").unwrap(); // Alice merged into Carol
    let s = db::snapshot(&p).unwrap();
    let carol = s.persons.iter().find(|x| x.name == "Carol").unwrap();
    assert!(s.persons.iter().all(|x| x.name != "Alice"), "emptied Alice shell deleted");
    let f2 = s.faces.iter().find(|f| f.id == 2).unwrap();
    assert_eq!(f2.person_id, Some(carol.id), "rejected face follows the merge");
    assert_eq!(f2.link_status, "rejected", "merge must not un-reject");
    assert_eq!(carol.counts.rejected, 1);

    // 3) the explicit accept is the only exit
    db::set_link_status(&p, &[2], "confirmed").unwrap();
    let s = db::snapshot(&p).unwrap();
    assert_eq!(s.faces.iter().find(|f| f.id == 2).unwrap().link_status, "confirmed");
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
/// Ungrouped), move persons between groups; membership only, faces and
/// statuses untouched.
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

    // 2) guards: inside itself, empty old, reserved name, unknown branch
    assert!(db::rename_group(&p, "work", "work|inner").is_err());
    assert!(db::rename_group(&p, "work", "work").is_err());
    assert!(db::rename_group(&p, "", "x").is_err());
    assert!(db::rename_group(&p, "work", "x|Ungrouped").is_err());
    assert!(db::rename_group(&p, "nope", "x").is_err(), "empty branch is an error");

    // 3) move the branch under another one (frontend computes target|leaf)
    db::rename_group(&p, "work|test", "friends|test").unwrap();
    assert_eq!(groups_of("Carol"), vec!["friends|test".to_string()]);
    assert_eq!(groups_of("Alice"), vec!["friends|test|deep".to_string()]);

    // 4) move persons between groups (single + batch), incl. to Ungrouped
    // (fixture ids: Alice=1, Bob=2, Carol=3)
    db::move_persons_to_group(&p, &[2, 1], "acme").unwrap();
    assert_eq!(groups_of("Bob"), vec!["acme".to_string()]);
    assert_eq!(groups_of("Alice"), vec!["acme".to_string()], "batch move replaces the path");
    db::move_persons_to_group(&p, &[1], "").unwrap();
    assert!(groups_of("Alice").is_empty(), "empty target = Ungrouped");
    assert!(db::move_persons_to_group(&p, &[2], "a|Ungrouped").is_err());
    assert!(db::move_persons_to_group(&p, &[], "x").is_err());
    assert!(db::move_persons_to_group(&p, &[999], "x").is_err());

    // 5) delete a branch — its persons (incl. sub-branches) fall to Ungrouped
    db::delete_group(&p, "friends").unwrap();
    assert!(groups_of("Carol").is_empty());
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
