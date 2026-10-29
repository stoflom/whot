// Tauri mock backend for the WhoT GUI (test/gui-mock).
//
// In-memory emulation of the backend commands the Review flow uses, seeded
// from /snap.json (a real faces.db dump — see dump_snap.py). Loaded as a
// classic script BEFORE the app module (server.py rewrites index.html), so
// window.__TAURI_INTERNALS__ exists by the time the bundle imports
// "@tauri-apps/api/core".
//
// Fidelity notes:
//   - Image commands return small SVG placeholders (no BLOB reads): layout
//     and interaction checks only, never pixel checks.
//   - person_face_clusters returns one cluster per description over the
//     person's confirmed faces (sim 0.9) — no real embedding math.
//   - assign_person emulates §4.1/#165: rename-in-place when the whole
//     scope is one person with that name, otherwise move/create; the CLAIM
//     rule (an assignment always confirms what it touches, incl. rejected
//     faces); zero-face shells deleted; derived names re-derived.
//   - #165/§4.35: reject re-homes onto the system person `Rejected`;
//     accept never un-rejects; every person keeps >= 1 group row (an empty
//     group input seats by state: provisional ⇒ New, else Accepted).
//
// window.__MOCK_SNAP exposes the live in-memory snapshot to test scripts.

(() => {
  let SNAP = null;
  let nextPersonId = 1;
  // #167: the import slot (mirrors importer.rs: one child at a time,
  // append-only line buffer, killed/exit markers)
  const imp = { running: false, killed: false, exit: null, lines: [], started: 0, opts: null, timers: [] };
  const imp_status = (since) => {
    const s = Math.min(since, imp.lines.length);
    return {
      running: imp.running,
      killed: imp.killed,
      exitCode: imp.exit,
      elapsed: imp.started ? Math.floor((Date.now() - imp.started) / 1000) : null,
      nextSince: imp.lines.length,
      lines: imp.lines.slice(s),
    };
  };
  // every invoke waits for the seed load — the app's first getSnapshot
  // races the fetch otherwise (intermittent permanent "loading…")
  let ready = Promise.resolve();

  const svg = (hue, label) =>
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">` +
        `<rect width="128" height="128" fill="hsl(${hue},45%,32%)"/>` +
        `<circle cx="64" cy="52" r="30" fill="hsl(${hue},35%,55%)"/>` +
        `<text x="64" y="118" font-size="16" text-anchor="middle" fill="#eee">${label}</text>` +
        `</svg>`
    );

  const rederiveNames = () => {
    const byPd = new Map();
    for (const f of SNAP.faces) {
      if (f.person_id == null) continue;
      const k = f.person_id + "\u0000" + (f.description ?? "");
      if (!byPd.has(k)) byPd.set(k, []);
      byPd.get(k).push(f);
    }
    for (const [k, arr] of byPd) {
      const pid = k.slice(0, k.indexOf("\u0000"));
      const p = SNAP.persons.find((x) => x.id === parseInt(pid, 10));
      const desc = k.slice(k.indexOf("\u0000") + 1);
      arr.sort((a, b) => a.id - b.id).forEach((f, i) => {
        f.seq = i + 1;
        f.name = `${p.name}${desc ? `-${desc}` : ""}-${f.seq}`;
      });
    }
  };

  const recount = () => {
    for (const p of SNAP.persons) {
      const fs = SNAP.faces.filter((f) => f.person_id === p.id);
      p.counts = {
        total: fs.length,
        provisional: fs.filter((f) => f.link_status === "provisional").length,
        confirmed: fs.filter((f) => f.link_status === "confirmed").length,
        rejected: fs.filter((f) => f.link_status === "rejected").length,
      };
    }
  };

  const getPerson = (name) =>
    SNAP.persons.find((p) => p.name === name.trim()) ?? null;

  const makePerson = (name, group) => {
    const p = {
      id: nextPersonId++,
      name,
      state: "imported",
      note: null,
      primary_face_id: null,
      primary_pinned: 0,
      created_at: new Date().toISOString(),
      groups: group ? [group] : [],
      counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
    };
    SNAP.persons.push(p);
    return p;
  };

  // ---- #165/§4.35: status seats, reserved paths, the system person ----
  const SEATS = ["New", "Accepted", "Rejected"];
  const RESERVED = ["Ungrouped", "New", "Accepted", "Rejected", "Unknown"];
  // seat derivation: any provisional face ⇒ New, else Accepted
  const seatFor = (pid) =>
    SNAP.faces.some((f) => f.person_id === pid && f.link_status === "provisional")
      ? "New"
      : "Accepted";
  const validatePath = (path) => {
    if (String(path ?? "").split("|").some((s) => RESERVED.includes(s)))
      throw new Error("reserved group name (#165)");
  };
  // invariant: >= 1 group row — groupless gets its seat; a seat-only
  // person re-derives; filed persons and the system seat are untouched
  const reseat = (p) => {
    if (p.name === "Rejected") return;
    if (!p.groups.length) p.groups = [seatFor(p.id)];
    else if (p.groups.every((g) => SEATS.includes(g))) p.groups = [seatFor(p.id)];
  };
  const reseatAll = () => SNAP.persons.forEach(reseat);
  const ensureRejected = () => {
    let p = getPerson("Rejected");
    if (!p) return makePerson("Rejected", "Rejected");
    p.groups = ["Rejected"];
    return p;
  };
  const assertNotSystem = (p) => {
    if (p && p.name === "Rejected")
      throw new Error("'Rejected' is the system person (#165)");
  };

  const fixPrimaries = () => {
    for (const p of SNAP.persons) {
      const fs = SNAP.faces.filter(
        (f) => f.person_id === p.id && f.link_status !== "rejected"
      );
      if (!fs.length) {
        p.primary_face_id = null;
        continue;
      }
      if (!p.primary_face_id || !fs.some((f) => f.id === p.primary_face_id)) {
        fs.sort((a, b) => b.confidence - a.confidence);
        p.primary_face_id = fs[0].id;
        p.primary_pinned = 0;
      }
    }
  };

  // §4.1/#165 assign: rename-in-place when the whole scope is one person
  // with that name; otherwise move/create. CLAIM rule: an assignment
  // always confirms what it touches (incl. rejected faces). Zero-face
  // shells deleted. Group applied on create / rename-in-place (F2) — an
  // empty group seats by state (§4.35). Derived names re-derived.
  const assignPerson = ({ faceIds, name, group }) => {
    const name2 = String(name ?? "").trim();
    if (!name2) throw new Error("empty name");
    if (name2.toLowerCase() === "rejected")
      throw new Error("'Rejected' is reserved (#165)");
    if (group) validatePath(group);
    const scope = new Set(faceIds);
    const faces = SNAP.faces.filter((f) => scope.has(f.id));
    const pids = new Set(faces.map((f) => f.person_id).filter((x) => x != null));
    const target = getPerson(name2);
    if (target && /^unknown/i.test(target.name))
      throw new Error("cannot assign an UnknownN name");
    if (pids.size === 1) {
      const pid = [...pids][0];
      const p = SNAP.persons.find((x) => x.id === pid);
      if (p && p.name === name2) {
        // rename in place: claim first, then the group lands (or the seat)
        for (const f of faces) f.link_status = "confirmed";
        p.groups = group ? [group] : [seatFor(p.id)];
        recount(); fixPrimaries(); return;
      }
    }
    const dest = target ?? makePerson(name2, group); // F2: an existing target's group is never touched
    for (const f of faces) {
      f.person_id = dest.id;
      f.link_status = "confirmed";
    }
    for (const pid of pids) {
      if (!SNAP.faces.some((f) => f.person_id === pid))
        SNAP.persons = SNAP.persons.filter((x) => x.id !== pid);
    }
    reseat(dest);
    rederiveNames(); recount(); fixPrimaries();
  };

  const cmd = {
    get_snapshot: () => JSON.parse(JSON.stringify(SNAP)),
    assign_person: assignPerson,
    accept_faces: ({ faceIds }) => {
      // #165/§4.3: plain accept never un-rejects; seat-holders re-derive
      const scope = new Set(faceIds);
      for (const f of SNAP.faces)
        if (scope.has(f.id) && f.link_status !== "rejected")
          f.link_status = "confirmed";
      recount(); fixPrimaries(); reseatAll();
    },
    reject_faces: ({ faceIds }) => {
      // #165/§4.2: every reject re-homes onto the system person
      const rej = ensureRejected();
      const scope = new Set(faceIds);
      for (const f of SNAP.faces)
        if (scope.has(f.id)) {
          f.link_status = "rejected";
          f.person_id = rej.id;
        }
      rederiveNames(); recount(); fixPrimaries(); reseatAll();
    },
    set_face_description: ({ faceId, description }) => {
      const f = SNAP.faces.find((x) => x.id === faceId);
      if (!f) throw new Error("no face");
      f.description = description || null;
      rederiveNames();
    },
    set_primary_face: ({ personId, faceId }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (p) { p.primary_face_id = faceId; p.primary_pinned = 1; }
    },
    set_person_name: ({ personId, name }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (!p) throw new Error("no person");
      assertNotSystem(p); // #165: never rename the system person
      if (String(name).toLowerCase() === "rejected")
        throw new Error("'Rejected' is reserved (#165)");
      const other = getPerson(name);
      if (other && other.id !== personId)
        throw new Error("person already exists: " + name);
      p.name = name;
      rederiveNames();
    },
    set_person_group: ({ personId, group }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (!p) return;
      assertNotSystem(p); // #165
      if (group) validatePath(group);
      p.groups = group ? [group] : [seatFor(p.id)]; // empty ⇒ seat (§4.35)
    },
    set_person_note: ({ personId, note }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (p) p.note = note;
    },
    move_persons_to_group: ({ personIds, group }) => {
      if (group) validatePath(group);
      for (const pid of personIds) {
        const p = SNAP.persons.find((x) => x.id === pid);
        if (!p) continue;
        assertNotSystem(p); // #165
        p.groups = group ? [group] : [seatFor(p.id)]; // empty ⇒ seat (§4.35)
      }
    },
    // #157 (v3.59): tree D&D move — re-home ONE membership per person
    move_persons_between_groups: ({ personIds, fromGroup, toGroup }) => {
      if (toGroup) validatePath(toGroup);
      for (const pid of personIds) {
        const p = SNAP.persons.find((x) => x.id === pid);
        if (!p) continue;
        assertNotSystem(p); // #165
        if (fromGroup !== toGroup)
          p.groups = p.groups.filter((g) => g !== fromGroup);
        if (toGroup) {
          // #165/§4.35: filing replaces the status seat
          p.groups = p.groups.filter((g) => !SEATS.includes(g));
          if (!p.groups.includes(toGroup)) p.groups.push(toGroup);
        } else if (!p.groups.length) {
          p.groups = [seatFor(p.id)]; // last membership removed ⇒ seat
        }
      }
    },
    rename_group: ({ oldPath, newPath }) => {
      if (SEATS.includes(oldPath))
        throw new Error("status branches are system furniture (#165)");
      validatePath(newPath || "\u0000"); // empty target is fine; reserved segments are not
      for (const p of SNAP.persons)
        if (p.groups.some((g) => g === oldPath || g.startsWith(oldPath + "|"))) {
          p.groups = p.groups
            .map((g) =>
              g === oldPath ? newPath :
              g.startsWith(oldPath + "|")
                ? newPath + (newPath ? "|" : "") + g.slice(oldPath.length + 1)
                : g)
            .filter(Boolean);
          if (!p.groups.length) p.groups = [seatFor(p.id)]; // empty ⇒ seat
        }
    },
    delete_group: ({ path }) => {
      if (SEATS.includes(path))
        throw new Error("status branches are system furniture (#165)");
      for (const p of SNAP.persons) {
        p.groups = p.groups.filter(
          (g) => !(g === path || g.startsWith(path + "|")));
        if (!p.groups.length) p.groups = [seatFor(p.id)]; // §4.35
      }
    },
    remove_persons: ({ personIds }) => {
      // #165/§4.13: rejection re-homes — no writer detaches a face
      for (const pid of personIds) {
        const p = SNAP.persons.find((x) => x.id === pid);
        assertNotSystem(p); // #165
      }
      const rej = ensureRejected();
      for (const f of SNAP.faces)
        if (personIds.includes(f.person_id)) {
          f.person_id = rej.id;
          f.link_status = "rejected";
        }
      SNAP.persons = SNAP.persons.filter((p) => !personIds.includes(p.id));
      recount(); fixPrimaries(); reseatAll();
    },
    add_refcrop: () => {},
    remove_refcrop: () => {},
    get_refcrops: () => [],
    open_image: () => {},
    // #174/C34 — same contract as db::rotate_image: the delta
    // normalised to [0,360), added to the stored rotation mod 360
    rotate_image: ({ imageId, delta }) => {
      const img = SNAP.images.find((x) => x.id === imageId);
      if (!img) throw new Error("image not found");
      const d = ((delta % 360) + 360) % 360;
      img.rotation = ((img.rotation ?? 0) + d) % 360;
      return img.rotation;
    },
    person_face_clusters: ({ personId }) => {
      const fs = SNAP.faces.filter(
        (f) => f.person_id === personId && f.link_status === "confirmed");
      const byDesc = new Map();
      for (const f of fs) {
        const k = f.description ?? "";
        if (!byDesc.has(k)) byDesc.set(k, []);
        byDesc.get(k).push({ face_id: f.id, sim: 0.9 });
      }
      return [...byDesc.entries()].map(([description, clusters]) => ({
        description,
        clusters: [clusters],
      }));
    },
    get_settings: () => JSON.parse(JSON.stringify(SNAP.settings)),
    set_settings: ({ settings }) => {
      SNAP.settings = settings;
    },
    get_face_preview: ({ faceId }) => svg((faceId * 47) % 360, String(faceId)),
    get_image_thumb: ({ imageId }) => svg((imageId * 31) % 360, "img" + imageId),
    get_image_preview: ({ imageId }) => svg((imageId * 31) % 360, "img" + imageId),
    // #167: the import runner — scan_import_dir consults the seeded
    // window.__MOCK_ROLL_DIRS__ ({path: imageCount}) and answers the
    // #169 recursive boolean (≥ 1 anywhere ⇒ true); start_import
    // simulates the child: a scripted line stream over timers, then an
    // exit; stop_import "kills" it. window.__MOCK_IMPORT__ exposes the
    // live slot to test scripts.
    scan_import_dir: ({ path }) =>
      ((window.__MOCK_ROLL_DIRS__ ?? {})[path] ?? 0) > 0,
    get_import_info: () => "/mock/data/faces.db",
    start_import: ({ options }) => {
      if (imp.running) throw new Error("an import is already running");
      if (options.createDb && options.dryRun)
        throw new Error("--create-db cannot be combined with --dry-run (creation is a write)");
      const lines = [
        `WhoT import_roll — ${options.dryRun ? "DRY RUN — no writes" : "import"}`,
        `roll dir  : ${options.rollDir}`,
        `recursive : ${options.recursive ? "yes" : "no"}`,
        `threshold : ${options.threshold}  (model insightface:buffalo_l)`,
        `provider  : ${options.gpu ? "gpu (MIGraphX, --gpu)" : "cpu (default, --gpu to opt in)"}`,
        `database  : /mock/data/faces.db`,
        `scanned 3 image(s)`,
        "done — imported 3 image(s), 3 face(s)",
      ];
      imp.running = true; imp.killed = false; imp.exit = null;
      imp.lines = []; imp.since = 0; imp.started = Date.now();
      imp.opts = options;
      lines.forEach((l, i) => {
        imp.timers.push(setTimeout(() => {
          if (!imp.running) return;
          imp.lines.push(l);
          if (i === lines.length - 1) {
            imp.running = false; imp.exit = 0;
            window.__MOCK_IMPORT__ = imp;
          }
        }, 120 * (i + 1)));
      });
      window.__MOCK_IMPORT__ = imp;
      return imp_status(0);
    },
    stop_import: () => {
      if (!imp.running) return false;
      imp.timers.forEach(clearTimeout); imp.timers = [];
      imp.running = false; imp.killed = true; imp.exit = null;
      window.__MOCK_IMPORT__ = imp;
      return true;
    },
    get_import_status: ({ since }) => imp_status(since ?? 0),
    // #162: the native folder picker (tauri-plugin-dialog) — tests seed
    // window.__MOCK_DIALOG_PICK__ with the path to "select" (null = cancel)
    "plugin:dialog|open": () => Promise.resolve(window.__MOCK_DIALOG_PICK__ ?? null),
  };

  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) =>
      ready
        .then(() => {
          const fn = cmd[command];
          if (!fn) throw new Error("mock: unknown command " + command);
          return fn(args ?? {});
        })
        .catch((e) => {
          console.error("mock invoke failed:", command, e);
          throw e;
        }),
  };
  window.__TAURI__ = {
    event: { listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() },
    dialog: { message: (o) => alert(o.message) },
  };

  ready = fetch("/snap.json")
    .then((r) => {
      if (!r.ok) throw new Error("snap.json HTTP " + r.status);
      return r.json();
    })
    .then((s) => {
      SNAP = s;
      nextPersonId = Math.max(0, ...SNAP.persons.map((p) => p.id)) + 1;
      window.__MOCK_SNAP = SNAP;
      window.__MOCK_READY__ = true;
    })
    .catch((e) => {
      window.__MOCK_ERROR__ = String(e);
      throw e;
    });
})();
