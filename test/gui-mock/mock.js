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
//   - assign_person emulates §4.1: rename-in-place when the whole scope is
//     one person with that name, otherwise move/create; sticky rejected;
//     zero-face shells deleted; derived names re-derived (person[-desc]-seq).
//
// window.__MOCK_SNAP exposes the live in-memory snapshot to test scripts.

(() => {
  let SNAP = null;
  let nextPersonId = 1;
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

  // §4.1 assign: rename-in-place when the whole scope is one person with
  // that name; otherwise move/create. Sticky rejected. Zero-face shells
  // deleted. Group applied on create / rename-in-place (F2).
  const assignPerson = ({ faceIds, name, group }) => {
    const name2 = String(name ?? "").trim();
    if (!name2) throw new Error("empty name");
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
        // rename in place: group replaces the path
        p.groups = group ? [group] : [];
        for (const f of faces)
          if (f.link_status !== "rejected") f.link_status = "confirmed";
        recount(); fixPrimaries(); return;
      }
    }
    const dest = target ?? makePerson(name2, group);
    for (const f of faces) {
      f.person_id = dest.id;
      if (f.link_status !== "rejected") f.link_status = "confirmed";
    }
    for (const pid of pids) {
      if (!SNAP.faces.some((f) => f.person_id === pid))
        SNAP.persons = SNAP.persons.filter((x) => x.id !== pid);
    }
    rederiveNames(); recount(); fixPrimaries();
  };

  const cmd = {
    get_snapshot: () => JSON.parse(JSON.stringify(SNAP)),
    assign_person: assignPerson,
    accept_faces: ({ faceIds }) => {
      for (const f of SNAP.faces)
        if (faceIds.includes(f.id)) f.link_status = "confirmed";
      recount(); fixPrimaries();
    },
    reject_faces: ({ faceIds }) => {
      for (const f of SNAP.faces)
        if (faceIds.includes(f.id)) f.link_status = "rejected";
      recount(); fixPrimaries();
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
      const other = getPerson(name);
      if (other && other.id !== personId)
        throw new Error("person already exists: " + name);
      p.name = name;
      rederiveNames();
    },
    set_person_group: ({ personId, group }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (p) p.groups = group ? [group] : [];
    },
    set_person_note: ({ personId, note }) => {
      const p = SNAP.persons.find((x) => x.id === personId);
      if (p) p.note = note;
    },
    move_persons_to_group: ({ personIds, group }) => {
      for (const pid of personIds) {
        const p = SNAP.persons.find((x) => x.id === pid);
        if (p) p.groups = group ? [group] : [];
      }
    },
    // #157 (v3.59): tree D&D move — re-home ONE membership per person
    move_persons_between_groups: ({ personIds, fromGroup, toGroup }) => {
      for (const pid of personIds) {
        const p = SNAP.persons.find((x) => x.id === pid);
        if (!p) continue;
        if (fromGroup !== toGroup)
          p.groups = p.groups.filter((g) => g !== fromGroup);
        if (toGroup && !p.groups.includes(toGroup)) p.groups.push(toGroup);
      }
    },
    rename_group: ({ oldPath, newPath }) => {
      for (const p of SNAP.persons)
        if (p.groups.some((g) => g === oldPath || g.startsWith(oldPath + "|")))
          p.groups = p.groups
            .map((g) =>
              g === oldPath ? newPath :
              g.startsWith(oldPath + "|")
                ? newPath + (newPath ? "|" : "") + g.slice(oldPath.length + 1)
                : g)
            .filter(Boolean);
    },
    delete_group: ({ path }) => {
      for (const p of SNAP.persons)
        p.groups = p.groups.filter(
          (g) => !(g === path || g.startsWith(path + "|")));
    },
    remove_persons: ({ personIds }) => {
      for (const f of SNAP.faces)
        if (personIds.includes(f.person_id)) {
          f.person_id = null;
          f.link_status = "rejected";
        }
      SNAP.persons = SNAP.persons.filter((p) => !personIds.includes(p.id));
      recount(); fixPrimaries();
    },
    add_refcrop: () => {},
    remove_refcrop: () => {},
    get_refcrops: () => [],
    open_image: () => {},
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
