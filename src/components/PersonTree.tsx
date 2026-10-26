import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Person } from "../api";
import { useFaceImage } from "../hooks";
import NameTypeahead from "./NameTypeahead";
import { groupPathOptions } from "./PathTypeahead";
import { rotStyle } from "../rotation";
import ConfirmDialog from "./ConfirmDialog";
import ContextMenu from "./ContextMenu";
import GroupDialog from "./GroupDialog";

interface TreeNode {
  name: string;
  personIds: number[];
  children: TreeNode[];
}

function buildTree(persons: Person[]): TreeNode {
  const root: TreeNode = { name: "", personIds: [], children: [] };
  const find = (parent: TreeNode, name: string): TreeNode => {
    let n = parent.children.find((c) => c.name === name);
    if (!n) {
      n = { name, personIds: [], children: [] };
      parent.children.push(n);
    }
    return n;
  };
  const unknown = find(root, "Unknown");
  const ungrouped = find(root, "Ungrouped");
  // #153 (§3): group placement first — a person with a group row renders
  // under their first path even when named UnknownN (the user may group
  // an UnknownN they remember by face but not by name). The virtual
  // branches hold the ungrouped: UnknownN names to Unknown, the rest to
  // Ungrouped. The importer seeds no group rows, so fresh UnknownN
  // persons are ungrouped by construction (never a literal 'Unknown'
  // segment); historic rows still land on the same top-level branch.
  // #156 (v3.56): a person with SEVERAL group rows renders under every
  // listed path — the §9 harvest importer legally leaves multiple
  // person_groups rows per person (§9.6/#128 additive shell groups), and
  // hiding them on all but the alphabetically-first branch made the
  // person unfindable in the branch the user filed them under. Each
  // distinct row is one placement; duplicates are impossible (PK).
  for (const p of persons) {
    if (p.groups.length > 0) {
      for (const g of p.groups) {
        const parts = g.split("|").filter(Boolean);
        let node = root;
        for (const part of parts) node = find(node, part);
        node.personIds.push(p.id);
      }
    } else if (p.name.startsWith("Unknown")) {
      unknown.personIds.push(p.id);
    } else {
      ungrouped.personIds.push(p.id);
    }
  }
  // #61 (§3): within every branch, biggest clusters first — persons
  // ordered by face count desc; ties by name, then id (deterministic).
  // Sub-branches keep their (snapshot) order.
  const byId = new Map(persons.map((p) => [p.id, p]));
  const sortNodes = (n: TreeNode) => {
    n.personIds.sort((a, b) => {
      const pa = byId.get(a);
      const pb = byId.get(b);
      const d = (pb?.counts.total ?? 0) - (pa?.counts.total ?? 0);
      if (d !== 0) return d;
      const c = (pa?.name ?? "").localeCompare(pb?.name ?? "");
      return c !== 0 ? c : a - b;
    });
    n.children.forEach(sortNodes);
  };
  sortNodes(root);
  return root;
}

/** Person ids in the tree's visual (filtered) display order — the
 * ‹ › / arrow-key person stepping walks this list (#31). A multi-group
 * person renders under every path (#156) but is stepped once, at the
 * first placement reached. */
export function orderedVisiblePersonIds(persons: Person[], filter: string): number[] {
  const tree = buildTree(persons);
  const byId = new Map(persons.map((p) => [p.id, p]));
  const f = filter.trim().toLowerCase();
  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));
  const subtreeMatch = (node: TreeNode): boolean =>
    node.personIds.some((id) => {
      const p = byId.get(id);
      return !!p && matches(p);
    }) || node.children.some(subtreeMatch);
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (node: TreeNode, isRoot: boolean) => {
    if (!isRoot && !subtreeMatch(node)) return;
    for (const id of node.personIds) {
      if (seen.has(id)) continue; // #156: one placement only per id
      const p = byId.get(id);
      if (p && matches(p)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const c of node.children) walk(c, false);
  };
  walk(tree, true);
  return out;
}

interface Props {
  persons: Person[];
  selectedId: number | null;
  reviewCount: number;
  /** filter text is owned by App — the toolbar person-stepping needs the
      same visible order the tree renders (#31) */
  filter: string;
  onFilter: (v: string) => void;
  onReview: () => void;
  onSelect: (id: number, e?: ReactMouseEvent) => void;
  /** multi-selection for bulk actions (#35): ctrl/cmd-click toggles,
      shift-click extends over the visible order */
  selectedIds: Set<number>;
  /** inline rename of a person (#29) — set_person_name, errors surface as toast */
  onRename: (id: number, name: string) => void;
  /** select all pending faces of a person (context menu, #32) */
  onSelectPending?: (id: number) => void;
  /** remove persons — row menu + branch bulk menus (§4.13, #35) */
  onRemovePersons: (ids: number[]) => void;
  /** #50 (§4.16) — rename/move a whole branch (prefix rewrite) */
  onRenameGroup: (oldPath: string, newPath: string) => void;
  /** #50 (§4.16) — delete a branch; its persons fall to Ungrouped */
  onDeleteGroup: (path: string) => void;
  /** #50 (§4.16) — move persons (or a selection) into a group */
  onMovePersons: (ids: number[], path: string, src?: string) => void;
  /** drag-drop validation errors surface as toast */
  onError?: (msg: string) => void;
  /** #88 (§4.28) — open the Merge Similar Persons triage dialog */
  onOpenMerge: () => void;
  /** #88 (§4.28) — merge a (multi-)selection into a person: context menu
      (no targetId → typeahead in the dialog) and DnD (targetId set) */
  onMergeInto: (ids: number[], targetId?: number) => void;
  /** #88 (§4.28) — rename-merge a multi-selection via the Edit dialog (#101) */
  onRenameSelection?: (ids: number[]) => void;
  /** #122: person id -> primary face rotation (avatar display) */
  primaryRot: Map<number, number>;
  /** #135 (rule 34): a face drag from the centre pane is live — every
      person row is a merge-into target for it (null = no face drag).
      Rendered for the highlight/clear bookkeeping… */
  faceDragIds?: number[] | null;
  /** …but ACCEPTANCE reads this ref at event time (v3.33 fix): the working
      person-drag path is ref-driven for exactly this reason — a drop must
      not depend on a React re-render having landed mid-drag */
  faceDragRef?: { current: number[] | null };
  /** #135: a face drag dropped on a person row — validation +
      confirmation live in App (same shared path as every merge) */
  onDropFaces?: (faceIds: number[], personId: number) => void;
}

function PersonRow({
  person,
  personOptions,
  selected,
  multi,
  renaming,
  rot,
  dropTarget,
  onSelect,
  onStartRename,
  onRename,
  onRenameCancel,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  person: Person;
  /** #97: name suggestions for the inline rename */
  personOptions: Person[];
  selected: boolean;
  multi: boolean;
  renaming: boolean;
  /** #122: the primary face's stored display rotation (crop spins) */
  rot: number;
  /** #88: highlighted as the merge target while persons are dragged over it */
  dropTarget: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onStartRename: () => void;
  onRename: (id: number, name: string) => void;
  onRenameCancel: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  /** #50: drag the person — or the whole selection when part of one */
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** #88: merge-on-drop target */
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const img = useFaceImage(person.primary_face_id);
  const [name, setName] = useState(person.name);
  useEffect(() => setName(person.name), [person.name, renaming]);
  const commit = () => {
    const v = name.trim();
    if (v && v !== person.name) onRename(person.id, v);
    onRenameCancel();
  };
  const cls = `tree-person${selected ? " selected" : ""}${multi ? " multi-selected" : ""}${dropTarget ? " merge-target" : ""}`;
  const title = `${person.groups.join(", ") || "Ungrouped"} — double-click to rename`;
  const inner = (
    <>
      <span className="tree-avatar">
        {img ? (
          // v3.33: a press on the avatar must not start a native image
          // drag — the row is the drag source
          <img src={img} alt="" style={rotStyle(rot)} draggable={false} />
        ) : (
          person.name[0]
        )}
      </span>
      {renaming ? (
        <NameTypeahead
          className="tree-rename"
          autoFocus
          value={name}
          onChange={setName}
          persons={personOptions}
          title="Rename — an existing person merges into (Enter commits, Esc cancels)"
          // #97: suggestions everywhere; click-away commits, Esc (list
          // closed) cancels — the dropdown's Esc closes it first (§4.21)
          onLeave={commit}
          onEscape={() => setName(person.name)}
        />
      ) : (
        <span className="tree-name">{person.name}</span>
      )}
      {person.counts.provisional > 0 && (
        <span className="tree-count prov" title="provisional (new, unreviewed) faces">
          {person.counts.provisional}
        </span>
      )}
      <span className="tree-count total" title="all faces">
        {person.counts.total}
      </span>
    </>
  );
  // #143: while renaming, the row must NOT stay a <button> — the
  // NameTypeahead input nesting inside a button is invalid HTML and
  // WebKit bubbles input clicks to the row's select handler / fights the
  // typeahead over focus. The renaming row is a bare <div> with the same
  // class/identity data (CSS class styling ⇒ identical geometry); the
  // input owns the interaction, click-away commits via onLeave.
  if (renaming) {
    return (
      <div data-person-id={person.id} className={`${cls} renaming`} title={title}>
        {inner}
      </div>
    );
  }
  return (
    <button
      data-person-id={person.id} // #76: cursor hit-test for ←/→ stepping
      className={cls}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={title}
    >
      {inner}
    </button>
  );
}

export default function PersonTree({ persons, selectedId, reviewCount, filter, onFilter, onReview, onSelect, selectedIds, onRename, onSelectPending, onRemovePersons, onRenameGroup, onDeleteGroup, onMovePersons, onError, onOpenMerge, onMergeInto, onRenameSelection, primaryRot, faceDragIds, faceDragRef, onDropFaces }: Props) {
  // #135: a face drag ending without a drop (Esc, drop outside) must
  // clear the merge-target highlight — the drag state itself lives in
  // App, only the highlight is ours
  useEffect(() => {
    if (faceDragIds == null) setDropPerson(null);
  }, [faceDragIds]);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
    groupPath: string;      // '|' path — branch ops live in that namespace
  } | null>(null);
  // #50 (§4.16) — group dialogs: rename/move a branch, move persons,
  // add a group (#54, §4.18: create = move the tree selection into it)
  const [groupDialog, setGroupDialog] = useState<
    | { kind: "rename-branch"; path: string }
    | { kind: "move-persons"; ids: number[] }
    | { kind: "add-group"; parent: string }
    | null
  >(null);
  // #54: 'Add group…' from the tree root (empty space) as well
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  // #97 (§4.21) — one path-suggestion list per persons snapshot, shared
  // by every group-path field opened from the tree
  const pathOptions = useMemo(() => groupPathOptions(persons), [persons]);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<{
    path: string;
    count: number;
  } | null>(null);
  // #50 — drag-and-drop state: what is dragged, and the hovered branch
  const dragRef = useRef<
    | { kind: "persons"; ids: number[]; /** #157: the dragged placement's branch path */
      src: string }
    | { kind: "branch"; path: string }
    | null
  >(null);
  const [dropPath, setDropPath] = useState<string | null>(null); // '' = Ungrouped node
  const [dropPerson, setDropPerson] = useState<number | null>(null); // #88 merge target
  // #135 (rule 34): face drag in flight (state view — highlight/effects)
  const faceDrag = faceDragIds != null && faceDragIds.length > 0;
  // v3.33 fix: the EVENT-TIME views — acceptance and the dropped payload
  // come from the ref, mirroring how the person-drag path reads dragRef
  const liveFaceDrag = () =>
    faceDragRef?.current != null && faceDragRef.current.length > 0;
  const liveFaceDragIds = () => faceDragRef?.current ?? null;
  const tree = useMemo(() => buildTree(persons), [persons]);
  const byId = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const f = filter.trim().toLowerCase();

  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));

  const subtreeMatch = (node: TreeNode): boolean => {
    if (node.personIds.some((id) => byId.get(id) && matches(byId.get(id)!))) return true;
    return node.children.some(subtreeMatch);
  };

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  // structural paths of every branch (persons or sub-branches), mirroring
  // the path scheme used by renderNode — for roll-up-all (#24)
  const collectBranchPaths = (node: TreeNode, prefix: string): string[] => {
    const out: string[] = [];
    for (const c of node.children) {
      const p = prefix ? `${prefix}/${c.name}` : c.name;
      if (c.personIds.length > 0 || c.children.length > 0) {
        out.push(p);
        out.push(...collectBranchPaths(c, p));
      }
    }
    return out;
  };
  const rollUpAll = () => setCollapsed(new Set(collectBranchPaths(tree, "")));
  const rollDownAll = () => setCollapsed(new Set());

  // structural (unfiltered) person ids of a branch — bulk remove (#35).
  // #156: dedupe — a multi-group person sits in several sub-branches and
  // must not be removed (or confirmed) twice.
  const collectSubtreeIds = (node: TreeNode): number[] => {
    const seen = new Set<number>();
    const walk = (n: TreeNode): number[] => {
      for (const id of n.personIds) seen.add(id);
      n.children.forEach(walk);
      return [];
    };
    walk(node);
    return [...seen];
  };
  const menuTargets = menu
    ? selectedIds.has(menu.id) && selectedIds.size > 1
      ? [...selectedIds]
      : [menu.id]
    : [];
  const branchIds = branchMenu ? collectSubtreeIds(branchMenu.node) : [];

  // ------------------------------------------------------------ #50 drag & drop (§4.16)

  const isVirtual = (name: string, depth: number) =>
    depth === 0 && (name === "Unknown" || name === "Ungrouped");

  const startDragPerson = (e: React.DragEvent, id: number, fromPath: string) => {
    // dragging a selected row moves the whole selection; otherwise just it
    const ids = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id];
    // #157 (v3.59): the dragged placement's branch path rides along — the
    // drop re-homes THAT membership (owner ruling: the dragged-from group
    // leaves the person, the target group is filed, other memberships are
    // kept)
    dragRef.current = { kind: "persons", ids, src: fromPath };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${ids.length} person(s)`); // firefox needs data
  };
  const startDragBranch = (e: React.DragEvent, groupPath: string) => {
    dragRef.current = { kind: "branch", path: groupPath };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", groupPath);
  };
  const clearDrag = () => {
    dragRef.current = null;
    setDropPath(null);
    setDropPerson(null);
  };
  // #88 (§4.28): dragging persons ONTO a person row = merge into it —
  // a new drop-target type beside #50's branch/Ungrouped drops. #135
  // (rule 34) adds the same row as a target for FACE drags from the
  // centre pane. Branch drags deliberately fall through (no
  // stopPropagation) so hovering a person row inside a branch still
  // targets that branch.
  const dragOverPerson = (e: React.DragEvent, id: number) => {
    const d = dragRef.current;
    if (d && d.kind === "persons") {
      e.preventDefault();
      e.stopPropagation(); // the branch under this row must not highlight
      e.dataTransfer.dropEffect = "move";
      if (dropPerson !== id) setDropPerson(id);
      return;
    }
    if (liveFaceDrag()) {
      // #135: face payload — person rows accept (ref-checked at event
      // time, v3.33)
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropPerson !== id) setDropPerson(id);
    }
  };
  const dragLeavePerson = (id: number) => {
    if (
      (dragRef.current?.kind === "persons" || faceDrag) &&
      dropPerson === id
    ) {
      setDropPerson(null);
    }
  };
  const acceptPersonDrop = (e: React.DragEvent, id: number) => {
    const d = dragRef.current;
    if (d && d.kind === "persons") {
      e.preventDefault();
      e.stopPropagation();
      const ids = d.ids;
      clearDrag();
      // validation + confirmation live in App (shared with menu/dialog, §4.28)
      onMergeInto(ids, id);
      return;
    }
    const faces = liveFaceDragIds();
    if (faces && faces.length > 0) {
      // #135: face payload → face-level merge (ref at drop time, v3.33)
      e.preventDefault();
      e.stopPropagation();
      clearDrag();
      onDropFaces?.(faces, id);
    }
  };
  const acceptDrop = (e: React.DragEvent, target: string) => {
    // #135: face drags target person rows only — branches refuse them
    // (ref-checked at event time, v3.33)
    if (liveFaceDrag()) return;
    // target '' = the Ungrouped node: persons drop ungrouped, a branch
    // re-homes at the top level (its leaf name only)
    e.preventDefault();
    e.stopPropagation();
    const d = dragRef.current;
    clearDrag();
    if (!d) return;
    if (d.kind === "persons") {
      // #157 (v3.59): the dragged placement's src rides along — the drop
      // re-homes that membership; without src (no placement context) the
      // §4.16 dialog-style replace-all keeps its meaning
      onMovePersons(d.ids, target, d.src);
      return;
    }
    const src = d.path;
    if (target) {
      if (target === src || target.startsWith(`${src}|`)) {
        onError?.("a branch cannot be moved inside itself"); // cycle guard
        return;
      }
    }
    const leaf = src.split("|").pop() ?? src;
    const dest = target ? `${target}|${leaf}` : leaf;
    if (dest !== src) onRenameGroup(src, dest);
  };
  const dragOver = (e: React.DragEvent, target: string) => {
    if (!dragRef.current) return;
    if (liveFaceDrag()) return; // #135: face drags do not target branches
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dropPath !== target) setDropPath(target);
  };

  const renderNode = (node: TreeNode, depth: number, path: string, groupPath: string) => {
    if (!subtreeMatch(node)) return null;
    const personsHere = node.personIds
      .map((id) => byId.get(id))
      .filter((p): p is Person => !!p && matches(p));
    const children = node.children.filter(subtreeMatch);
    if (node.name === "" ) {
      // root: just render children; empty space offers 'Add group…' (#54)
      return (
        <div
          key={path || "root"}
          onContextMenu={(e) => {
            e.preventDefault();
            setRootMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {children.map((c) => renderNode(c, 0, c.name, c.name))}
        </div>
      );
    }
    const virtual = isVirtual(node.name, depth);
    // drop target for this node: '' = Ungrouped (virtual) — no group path
    const dropTarget = virtual && node.name === "Ungrouped" ? "" : groupPath;
    const isCollapsed = collapsed.has(path) && f === "";
    const collapsible = node.children.length > 0 || node.personIds.length > 0;
    return (
      <div key={path}>
        <div
          className={`tree-node${dropPath === dropTarget ? " drop-target" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (collapsible ? toggle(path) : undefined)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // #154: virtual branches (Unknown/Ungrouped) offer no branch
            // menu — Unknown cleanup lives in the top-bar 'Remove
            // Unknowns' button
            if (isVirtual(node.name, depth)) return;
            setBranchMenu({ x: e.clientX, y: e.clientY, node, groupPath });
          }}
          draggable={!virtual}
          onDragStart={(e) => !virtual && startDragBranch(e, groupPath)}
          onDragEnd={clearDrag}
          onDragOver={(e) => dragOver(e, dropTarget)}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (dropPath === dropTarget) setDropPath(null);
          }}
          onDrop={(e) => acceptDrop(e, dropTarget)}
        >
          {collapsible ? (
            <span className="tree-arrow">{isCollapsed ? "▸" : "▾"}</span>
          ) : (
            <span className="tree-arrow" />
          )}
          <span className="tree-node-name">{node.name}</span>
          <span className="tree-count dim">
            {node.personIds.filter((id) => byId.get(id) && matches(byId.get(id)!)).length +
              node.children.reduce(
                (acc, c) => acc + countPersons(c),
                0
              )}
          </span>
        </div>
        {!isCollapsed && (
          <>
            <div className="tree-children" style={{ paddingLeft: 10 + depth * 14 }}>
              {personsHere.map((p) => (
                <PersonRow
                  key={p.id}
                  person={p}
                  personOptions={persons}
                  selected={selectedId === p.id}
                  multi={selectedIds.has(p.id)}
                  renaming={renamingId === p.id}
                  rot={primaryRot.get(p.id) ?? 0}
                  onSelect={(e) => onSelect(p.id, e)}
                  onStartRename={() => setRenamingId(p.id)}
                  onRename={onRename}
                  onRenameCancel={() => setRenamingId(null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, id: p.id });
                  }}
                  onDragStart={(e) => startDragPerson(e, p.id, groupPath)}
                  onDragEnd={clearDrag}
                  dropTarget={dropPerson === p.id}
                  onDragOver={(e) => dragOverPerson(e, p.id)}
                  onDragLeave={() => dragLeavePerson(p.id)}
                  onDrop={(e) => acceptPersonDrop(e, p.id)}
                />
              ))}
            </div>
            {children.map((c) => renderNode(c, depth + 1, `${path}/${c.name}`, groupPath ? `${groupPath}|${c.name}` : c.name))}
          </>
        )}
      </div>
    );

    function countPersons(n: TreeNode): number {
      if (f !== "") {
        return (
          n.personIds.filter((id) => byId.get(id) && matches(byId.get(id)!)).length +
          n.children.reduce((acc, c) => acc + countPersons(c), 0)
        );
      }
      return (
        n.personIds.length + n.children.reduce((acc, c) => acc + countPersons(c), 0)
      );
    }
  };

  return (
    <div className="person-tree">
      <div className="tree-header">
        <div className="tree-tools">
          <button
            className="ghost"
            onClick={rollUpAll}
            disabled={f !== ""}
            title={f !== "" ? "Clear the search filter first" : "Collapse (roll up) all branches"}
          >
            ⌃
          </button>
          <button className="ghost" onClick={rollDownAll} title="Expand (roll down) all branches">
            ⌄
          </button>
          <input
            className="tree-filter"
            placeholder="filter by name or group…"
            title="Filter the tree by person name or group"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          />
          <button
            className="ghost merge-open"
            onClick={onOpenMerge}
            title="Merge Similar Persons — find and combine near-identical names (§4.28, #88)"
          >
            ⧉ merge similar
          </button>
        </div>
        <button className={`tree-review${selectedId === null ? " selected" : ""}`} onClick={onReview}
          title="Open the Review view — all unreviewed (provisional) faces, UnknownN first">
          ▦ Review — {reviewCount} pending
        </button>
      </div>
      {renderNode(tree, 0, "", "")}
      {menu && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            groups: [
              {
                items: [
                  { label: "Open person", onClick: () => onSelect(menu.id) },
                  { label: "Rename…", onClick: () => setRenamingId(menu.id) },
                  {
                    label: "Select their pending faces",
                    onClick: () => onSelectPending?.(menu.id),
                    disabled:
                      (persons.find((p) => p.id === menu.id)?.counts.provisional ?? 0) === 0,
                  },
                ],
              },
              {
                items: [
                  {
                    // #50: acts on the multi-selection, like Remove does
                    label:
                      menuTargets.length > 1
                        ? `Move ${menuTargets.length} persons to group…`
                        : "Move to group…",
                    onClick: () => setGroupDialog({ kind: "move-persons", ids: menuTargets }),
                  },
                  {
                    // #88 (§4.28): shared confirmation dialog, target via typeahead
                    label:
                      menuTargets.length > 1
                        ? `Merge ${menuTargets.length} persons into…`
                        : "Merge into…",
                    onClick: () => onMergeInto(menuTargets),
                    hint: "§4.28",
                  },
                  // #88 (§4.28): rename-merge over all their faces (§4.1);
                  // a single person already has inline rename (double-click)
                  ...(menuTargets.length > 1 && onRenameSelection
                    ? [
                        {
                          label: `Rename ${menuTargets.length} persons to…`,
                          onClick: () => onRenameSelection(menuTargets),
                        },
                      ]
                    : []),
                  {
                    label:
                      menuTargets.length > 1
                        ? `Remove ${menuTargets.length} persons`
                        : "Remove person",
                    onClick: () => onRemovePersons(menuTargets),
                    danger: true,
                  },
                ],
              },
            ],
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {branchMenu && (
        <ContextMenu
          menu={{
            x: branchMenu.x,
            y: branchMenu.y,
            groups: [
              // #50 (§4.16): real branches can be renamed/moved and
              // deleted (#154: virtual branches never open this menu at
              // all — Unknown cleanup is the top-bar 'Remove Unknowns'
              // button)
              {
                title: "Group",
                items: [
                  {
                    // #54 (§4.18): 'creating' a group = moving the
                    // tree selection into it — empty groups cannot
                    // exist (branches derive from person paths)
                    label: "Add group…",
                    onClick: () =>
                      setGroupDialog({ kind: "add-group", parent: branchMenu.groupPath }),
                    disabled: selectedIds.size === 0,
                  },
                  {
                    label: "Rename/move group…",
                    onClick: () =>
                      setGroupDialog({ kind: "rename-branch", path: branchMenu.groupPath }),
                  },
                  {
                    label: "Delete group",
                    onClick: () =>
                      setConfirmDeleteGroup({
                        path: branchMenu.groupPath,
                        count: branchIds.length,
                      }),
                    disabled: branchIds.length === 0,
                    danger: true,
                  },
                ],
              },
              {
                items: [
                  {
                    label: `Remove all persons in this branch (${branchIds.length})`,
                    onClick: () => onRemovePersons(branchIds),
                    disabled: branchIds.length === 0,
                    danger: true,
                  },
                ],
              },
            ],
          }}
          onClose={() => setBranchMenu(null)}
        />
      )}
      {rootMenu && (
        <ContextMenu
          menu={{
            x: rootMenu.x,
            y: rootMenu.y,
            groups: [
              {
                items: [
                  {
                    label:
                      selectedIds.size > 0
                        ? `Add group with ${selectedIds.size} selected person(s)…`
                        : "Add group…",
                    onClick: () => setGroupDialog({ kind: "add-group", parent: "" }),
                    disabled: selectedIds.size === 0,
                  },
                ],
              },
            ],
          }}
          onClose={() => setRootMenu(null)}
        />
      )}
      {groupDialog && (
        <GroupDialog
          options={pathOptions}
          title={
            groupDialog.kind === "rename-branch"
              ? "Rename / move group"
              : groupDialog.kind === "add-group"
                ? groupDialog.parent
                  ? `Add group under '${groupDialog.parent}'`
                  : "Add top-level group"
                : groupDialog.ids.length > 1
                  ? `Move ${groupDialog.ids.length} persons to a group`
                  : "Move person to a group"
          }
          body={
            groupDialog.kind === "rename-branch"
              ? "The whole branch — including sub-branches — follows to the new path. " +
                "Empty = move everything to Ungrouped."
            : groupDialog.kind === "add-group"
              ? `The ${selectedIds.size} selected person(s) move into the new group ` +
                "(a group exists through its persons). Faces and names are untouched."
            : "Replaces each person's group path (empty = ungrouped). " +
              "Faces and names are untouched."
          }
          defaultPath={
            groupDialog.kind === "rename-branch"
              ? groupDialog.path
              : groupDialog.kind === "add-group"
                ? groupDialog.parent
                  ? `${groupDialog.parent}|`
                  : ""
              : (byId.get(groupDialog.ids[0])?.groups[0] ?? "")
          }
          submitLabel={
            groupDialog.kind === "rename-branch"
              ? "move group"
              : groupDialog.kind === "add-group"
                ? "add group"
                : "move"
          }
          onSubmit={(path) => {
            const d = groupDialog;
            setGroupDialog(null);
            if (d.kind === "rename-branch") {
              // compare normalised (#42): whitespace-only edits are a no-op
              const norm = path.split("|").map((s) => s.trim()).filter(Boolean).join("|");
              if (norm !== d.path) onRenameGroup(d.path, norm);
            } else if (d.kind === "add-group") {
              const norm = path.split("|").map((s) => s.trim()).filter(Boolean).join("|");
              if (norm && selectedIds.size > 0) onMovePersons([...selectedIds], norm);
            } else {
              onMovePersons(d.ids, path);
            }
          }}
          onCancel={() => setGroupDialog(null)}
        />
      )}
      {confirmDeleteGroup && (
        <ConfirmDialog
          title={`Delete group '${confirmDeleteGroup.path}'`}
          body={
            `${confirmDeleteGroup.count} person(s) — including any sub-branches — ` +
            "move to Ungrouped. Faces, names and statuses are untouched."
          }
          confirmLabel="delete group"
          danger
          onConfirm={() => {
            const d = confirmDeleteGroup;
            setConfirmDeleteGroup(null);
            onDeleteGroup(d.path);
          }}
          onCancel={() => setConfirmDeleteGroup(null)}
        />
      )}
    </div>
  );
}
