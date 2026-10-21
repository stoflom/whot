import { useEffect, useMemo, useState } from "react";
import type { Person, Settings } from "../api";
import { aliasesToText, clusterPersons, textToAliases, type MergeCluster } from "../nameCluster";
import PathTypeahead, { useGroupPathOptions } from "./PathTypeahead";

// #88 (gui-design §4.28) — the Merge Similar Persons triage view:
// clusters of near-identical names with per-pair link evidence, bulk
// merge (shared MergeIntoDialog), bulk group and rename over a
// multi-selection. Detection itself runs pure in App (nameCluster).

interface Props {
  persons: Person[];
  settings: Settings;
  /** persist a partial settings change (whotrc.json, #88) */
  onSaveSettings: (patch: Partial<Settings>) => void;
  /** open the shared merge confirmation for the selected persons */
  onMergeInto: (ids: number[]) => void;
  /** apply one group path to the selected persons (§4.16, reversible) */
  onApplyGroup: (ids: number[], group: string) => void;
  /** rename-merge the selection via the existing AssignDialog (§4.1) */
  onRename: (ids: number[]) => void;
  onClose: () => void;
  /** false while another dialog owns Esc (stacked AssignDialog) */
  escActive: boolean;
}

const KIND_LABEL: Record<string, string> = {
  fold: "case",
  seq: "seq-suffix",
  alias: "alias",
  edit: "edit",
};

export default function MergeSimilarDialog({
  persons,
  settings,
  onSaveSettings,
  onMergeInto,
  onApplyGroup,
  onRename,
  onClose,
  escActive,
}: Props) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dist, setDist] = useState(settings.merge_name_distance);
  const [aliasText, setAliasText] = useState(aliasesToText(settings.merge_suffix_aliases));
  const [group, setGroup] = useState("");
  const pathOptions = useGroupPathOptions(persons);   // #97
  const byId = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons]);
  // detection is pure and cheap, but only runs while this dialog is open
  const clusters = useMemo(
    () =>
      clusterPersons(persons, {
        distance: settings.merge_name_distance,
        suffixAliases: settings.merge_suffix_aliases,
      }),
    [persons, settings.merge_name_distance, settings.merge_suffix_aliases],
  );

  // close on Esc while no other dialog is stacked above us
  useEffect(() => {
    if (!escActive) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [escActive, onClose]);

  // prune dead ids after a merge/rename refresh changed the person set
  useEffect(() => {
    setSel((prev) => {
      const next = new Set([...prev].filter((id) => byId.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [byId]);

  const toggle = (id: number) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCluster = (c: MergeCluster) =>
    setSel((prev) => {
      const next = new Set(prev);
      const all = c.members.every((m) => next.has(m.id));
      for (const m of c.members) {
        if (all) next.delete(m.id);
        else next.add(m.id);
      }
      return next;
    });

  const selected = clusters.flatMap((c) => c.members).filter((m) => sel.has(m.id));
  const faceCount = selected.reduce((a, p) => a + p.counts.total, 0);

  const saveDistance = (v: number) => {
    setDist(v);
    onSaveSettings({ merge_name_distance: v });
  };
  const saveAliases = () => {
    const parsed = textToAliases(aliasText);
    setAliasText(aliasesToText(parsed)); // normalise the text field
    onSaveSettings({ merge_suffix_aliases: parsed });
  };

  const evidenceFor = (m: Person, c: MergeCluster) =>
    c.edges
      .filter((e) => e.a === m.id || e.b === m.id)
      .map((e) => {
        const other = byId.get(e.a === m.id ? e.b : e.a);
        const kind = e.kind === "edit" ? `edit${e.distance}` : KIND_LABEL[e.kind] ?? e.kind;
        return {
          key: `${e.a}-${e.b}`,
          text: `↔ ${other?.name ?? "?"} · ${kind}`,
          title: `${other?.name ?? "?"} — ${kind === "case" ? "differs only in case/whitespace" : kind === "seq-suffix" ? "differs only by a ' N' seq suffix" : kind === "alias" ? "differs only by a generational suffix" : `Damerau-Levenshtein distance ${e.distance}`}`,
        };
      });

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog merge-dialog">
        <h3>Merge Similar Persons</h3>
        <p className="dim">
          Names within <b>Damerau-Levenshtein ≤ {dist}</b> (case, seq suffixes and transpositions
          count as one edit), single-linkage. Check the evidence, select who to combine, then
          merge or realign the set — merging is confirmed and has no undo.
        </p>

        <div className="merge-opts">
          <label title="Max edit distance (1–3); persisted in whotrc.json (#88)">
            distance
            <select value={dist} onChange={(e) => saveDistance(Number(e.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label
            className="merge-aliases"
            title="Generational-suffix equivalence groups, off when empty — e.g. J,Jr,Junior means the Jr/Junior suffix is ignored before comparing (#88)"
          >
            suffix aliases
            <input
              value={aliasText}
              placeholder="J,Jr,Junior; S,Sr,Senior"
              onChange={(e) => setAliasText(e.target.value)}
              onBlur={saveAliases}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") saveAliases();
              }}
            />
          </label>
        </div>

        {clusters.length === 0 ? (
          <p className="dim">No similar names found under the current rule.</p>
        ) : (
          clusters.map((c) => {
            const allSel = c.members.every((m) => sel.has(m.id));
            return (
              <div className="merge-cluster" key={c.key}>
                <div className="merge-cluster-head">
                  <input
                    type="checkbox"
                    checked={allSel}
                    onChange={() => toggleCluster(c)}
                    title={`select all ${c.members.length} member(s)`}
                  />
                  <b>{c.label}</b>
                  <span className="dim">
                    {c.members.length} person(s) · {c.members.reduce((a, m) => a + m.counts.total, 0)} faces
                  </span>
                </div>
                {c.members.map((m) => (
                  <label className="merge-member" key={m.id}>
                    <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} />
                    <span className="merge-name">{m.name}</span>
                    {m.state === "imported" && (
                      <span className="pill merge-prov" title="created by a harvest import run">
                        imported
                      </span>
                    )}
                    <span
                      className="merge-counts dim"
                      title="total · provisional · confirmed · rejected"
                    >
                      {m.counts.total}f {m.counts.provisional}p {m.counts.confirmed}c{" "}
                      {m.counts.rejected}r
                    </span>
                    <span className="merge-groups dim" title="group path(s)">
                      {m.groups.join(", ") || "Ungrouped"}
                    </span>
                    <span className="merge-when dim" title="created (UTC)">
                      {m.created_at}
                    </span>
                    <span className="merge-evidence">
                      {evidenceFor(m, c).map((ev) => (
                        <span className="ev-chip" key={ev.key} title={ev.title}>
                          {ev.text}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            );
          })
        )}

        <div className="merge-foot">
          <span className="dim">
            {sel.size} person(s) · {faceCount} face(s) selected
          </span>
          <span className="merge-spacer" />
          <PathTypeahead
            className="input-group"
            value={group}
            onChange={setGroup}
            options={pathOptions}
            placeholder="group path (empty = ungrouped)"
            title="Apply one group path to every selected person (§4.16) — reversible, faces untouched"
            onSubmit={() => {
              if (sel.size > 0) {
                onApplyGroup([...sel], group);
                setGroup("");
              }
            }}
          />
          <button
            disabled={sel.size === 0}
            onClick={() => {
              onApplyGroup([...sel], group);
              setGroup("");
            }}
            title="Replace the group path of every selected person (§4.16) — reversible"
          >
            apply group
          </button>
          <button
            disabled={sel.size === 0}
            onClick={() => onRename([...sel])}
            title="Rename/merge all selected persons to one name — opens the Assign dialog with their faces (§4.1)"
          >
            rename to…
          </button>
          <button
            className="bad"
            disabled={sel.size === 0 || faceCount === 0}
            onClick={() => onMergeInto([...sel])}
            title="Merge the selection into one person — confirmation required, no undo (§4.28)"
          >
            Merge into…
          </button>
        </div>
      </div>
    </div>
  );
}
