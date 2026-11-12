import {
  memo,
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import type { Person } from "../api";
import { useFaceImage } from "../hooks";
import NameTypeahead from "./NameTypeahead";
import { groupPathOptions } from "./PathTypeahead";
import { firstRealGroup, normalizeGroupPath } from "../groupList";
import { rotStyle } from "../rotation";
import ConfirmDialog from "./ConfirmDialog";
import ContextMenu, { type MenuState } from "./ContextMenu";
import GroupDialog from "./GroupDialog";
import AddGroupDialog from "./AddGroupDialog";
// #260: the shared "is a face drag live" predicate (faceDrop.ts) — the
// ONE definition App's grid handlers and this pane's person-row drop
// targets both read (the #252 dup merge)
import { faceDragLive } from "../faceDrop";
import { isRejectedBin } from "../personNames";
// #223 (F-M1/F-M2): the tree structure and its queries are pure
// (treeIndex.ts, co-tested) — the pane receives the App-built tree and
// indexes it once per (tree, persons, filter) change
import { indexTree, type TreeNode } from "../treeIndex";

// #255: the APG tree key pattern shared by branch nodes and person rows —
// Enter/Space activate (branch toggle / person select), Up/Down move focus
// among the visible items (DOM order == display order), Right expands a
// branch, Left collapses it or climbs to the parent branch. Items are
// found by their `data-tree-key`; the focused one owns its keys
// (`data-owns-keys`) so App's global arrow-step guard bails out.
function treeItemKey(
  e: React.KeyboardEvent,
  key: string,
  isBranch: boolean,
  expanded: boolean,
  onActivate: () => void,
  onToggle: () => void,
  parentKey: string | null
) {
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-tree-key]"));
  const focusKey = (k: string | null) => {
    if (k == null) return;
    const el = items().find((h) => h.getAttribute("data-tree-key") === k);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  };
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onActivate();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = items();
    const idx = list.findIndex((h) => h.getAttribute("data-tree-key") === key);
    focusKey(
      list[idx + (e.key === "ArrowDown" ? 1 : -1)]?.getAttribute("data-tree-key") ?? null
    );
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (isBranch && !expanded) onToggle();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (isBranch && expanded) onToggle();
    else focusKey(parentKey);
  }
}

interface Props {
  /** #223: the App-built tree (built once per treePersons change) — the
      pane no longer rebuilds it per render */
  tree: TreeNode;
  persons: Person[];
  selectedId: number | null;
  /** filter text is owned by App — the toolbar person-stepping needs the
      same visible order the tree renders (#31) */
  filter: string;
  onFilter: (v: string) => void;
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
  /** #50 (§4.16) — delete a branch; its persons fall to their status
      seats (#165, §4.35) */
  onDeleteGroup: (path: string) => void;
  /** #50 (§4.16) — move persons (or a selection) into a group */
  onMovePersons: (ids: number[], path: string, src?: string) => void;
  /** #164 (§4.18) — add the typed path as an ADDITIONAL membership
      (every current group of the person(s) is kept) */
  onAddGroup: (ids: number[], path: string) => void;
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
  /** #297 (rule 50): the tree's collapsed set is owned by App so it can
      persist across restarts — the component only renders + toggles it */
  collapsed: Set<string>;
  onSetCollapsed: Dispatch<SetStateAction<Set<string>>>;
}

function PersonRow({
  person,
  personOptions,
  selected,
  multi,
  renaming,
  rot,
  dropTarget,
  groupPath,
  tabbable,
  onSelect,
  onFocus,
  onKeyDown,
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
  /** #223: the row's branch path ('|' form) — the person-drag src (#157) */
  groupPath: string;
  /** #255: the roving tabindex — only the focused row is tabbable */
  tabbable: boolean;
  /** #223: id-carrying handlers with ONE shared identity (the pane's
      rowHandlers memo) — the per-row closures that defeated memo() are
      gone; the row binds its own id at the DOM boundary */
  onSelect: (id: number, e: ReactMouseEvent) => void;
  onFocus: (id: number) => void;
  onKeyDown: (id: number, e: React.KeyboardEvent) => void;
  onStartRename: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onRenameCancel: (id: number) => void;
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  /** #50: drag the person — or the whole selection when part of one */
  onDragStart: (id: number, groupPath: string, e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** #88: merge-on-drop target */
  onDragOver: (id: number, e: React.DragEvent) => void;
  onDragLeave: (id: number) => void;
  onDrop: (id: number, e: React.DragEvent) => void;
}) {
  const img = useFaceImage(person.primary_face_id);
  const system = isRejectedBin(person.name); // #165/§4.35, #266 family
  const [name, setName] = useState(person.name);
  useEffect(() => setName(person.name), [person.name, renaming]);
  const commit = () => {
    const v = name.trim();
    if (v && v !== person.name) onRename(person.id, v);
    onRenameCancel(person.id);
  };
  const cls = `tree-person${selected ? " selected" : ""}${multi ? " multi-selected" : ""}${dropTarget ? " merge-target" : ""}`;
  // #165: a reject-bin person's tooltip (legacy `Rejected` or a
  // `RejectedN` cluster, §4.35/#266) states the way back in product
  // language, reference-free (§4.43)
  const title = system
    ? `${person.name} — a rejected cluster; assignment is its only way out`
    : `${person.groups.join(", ") || "(no group)"} — double-click to rename`;
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
      data-tree-key={`p:${person.id}`}
      data-owns-keys
      role="treeitem"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      className={cls}
      onClick={(e) => onSelect(person.id, e)}
      onFocus={() => onFocus(person.id)}
      onKeyDown={(e) => onKeyDown(person.id, e)}
      onDoubleClick={() => !system && onStartRename(person.id)}
      onContextMenu={(e) => onContextMenu(person.id, e)}
      draggable={!renaming && !system}
      onDragStart={(e) => onDragStart(person.id, groupPath, e)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(person.id, e)}
      onDragLeave={() => onDragLeave(person.id)}
      onDrop={(e) => onDrop(person.id, e)}
      title={title}
    >
      {inner}
    </button>
  );
}

// #223 (F-M2): memoised — every row carries its own useFaceImage and DOM
// subtree; with the id-carrying handler identities shared (rowHandlers)
// and the per-row values passed as primitives, a tree selection, drag
// highlight, rename or filter keystroke re-renders only the rows whose
// own values moved
const MemoPersonRow = memo(PersonRow);

function PersonTree({ tree, persons, selectedId, filter, onFilter, onSelect, selectedIds, onRename, onSelectPending, onRemovePersons, onRenameGroup, onDeleteGroup, onMovePersons, onAddGroup, onError, onOpenMerge, onMergeInto, onRenameSelection, primaryRot, faceDragIds, faceDragRef, onDropFaces, collapsed, onSetCollapsed }: Props) {
  // #135: a face drag ending without a drop (Esc, drop outside) must
  // clear the merge-target highlight — the drag state itself lives in
  // App, only the highlight is ours
  useEffect(() => {
    if (faceDragIds == null) setDropPerson(null);
  }, [faceDragIds]);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  // #261: the filter input's context menu — a *Clear* entry beside the ✕
  // button (gui-design 6.0)
  const [clearMenu, setClearMenu] = useState<MenuState | null>(null);
  const [branchMenu, setBranchMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
    groupPath: string;      // '|' path — branch ops live in that namespace
  } | null>(null);
  // #50 (§4.16) — group dialogs: rename/move a branch, move persons,
  // add a group (#164 supersedes #54: person rows only — the typed path
  // becomes an ADDITIONAL membership, §4.18)
  const [groupDialog, setGroupDialog] = useState<
    | { kind: "rename-branch"; path: string }
    | { kind: "move-persons"; ids: number[] }
    | { kind: "add-group"; ids: number[] }
    | null
  >(null);
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
  // #223: the render-time views the row handlers read — refs (the
  // pendingRef pattern) so the shared rowHandlers identity never depends
  // on the selection or the highlight state
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const dropPersonRef = useRef(dropPerson);
  dropPersonRef.current = dropPerson;
  // #135 (rule 34): face drag in flight — the EVENT-TIME views read the
  // ref (v3.33 fix: acceptance and the dropped payload come from the
  // ref, mirroring how the person-drag path reads dragRef); the state
  // view only drives the clear-on-end effect below
  // #260: the shared live-face-drag predicate (ONE definition, faceDrop.ts)
  const liveFaceDrag = () => faceDragLive(faceDragRef?.current);
  const byId = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons]);
  // #297 (rule 50): the collapsed set is owned by App (it persists across
  // restarts) — this component only renders + toggles it
  // #255: the roving-tabindex focus — exactly one visible item (branch
  // node or person row) is tabbable; arrows move it (treeItemKey)
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // #215: the filter input stays crisp — the (heavier) row filtering
  // trails a frame behind the keystrokes instead of blocking them
  const deferredFilter = useDeferredValue(filter);
  const f = deferredFilter.trim().toLowerCase();
  // #223 (F-M1): ONE post-order pass per (tree, persons, filter) change
  // produces every node's match/count — the render reads entries instead
  // of running the two recursive subtreeMatch walks and the recursive
  // countPersons sums per node (O(n·depth) → O(n) total, once)
  const treeIdx = useMemo(() => indexTree(tree, byId, deferredFilter), [tree, byId, deferredFilter]);

  // #255: keep exactly one visible item tabbable — seed the first item on
  // mount, and if a focus move / re-render leaves `focusedKey` pointing at
  // an item that no longer renders, fall back to the first visible one
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>("[data-tree-key]"));
    if (items.length === 0) return;
    const alive =
      focusedKey != null && items.some((h) => h.getAttribute("data-tree-key") === focusedKey);
    if (!alive) setFocusedKey(items[0].getAttribute("data-tree-key"));
  }, [focusedKey, tree, persons, deferredFilter]);

  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));

  const toggle = (path: string) =>
    onSetCollapsed((prev) => {
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
  const rollUpAll = () => onSetCollapsed(new Set(collectBranchPaths(tree, "")));
  const rollDownAll = () => onSetCollapsed(new Set());

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
  // #165/§4.35/#266: reject-bin persons offer no rename/move/file/
  // merge/remove
  const systemInMenu = menuTargets.some((id) => isRejectedBin(byId.get(id)?.name ?? ""));
  // #182/§4.14: the one-person-only entries grey out for a multi-scope
  const manyInMenu = menuTargets.length > 1;

  // ------------------------------------------------------------ #50 drag & drop (§4.16)

  const isVirtual = (name: string, depth: number) =>
    depth === 0 && (name === "Unknown" || name === "Ungrouped");
  // #165 (§4.35): the status branches are system furniture — no menu,
  // not draggable, and NOT drop targets (their paths are reserved)
  const isStatusBranch = (name: string, depth: number) =>
    depth === 0 && (name === "New" || name === "Accepted" || name === "Rejected");

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

  // #223 (F-M2): ONE handler set for every row — id-carrying and identity
  // stable across renders. Everything the handlers read lives behind a
  // ref (the pendingRef pattern, §4.44 rule 44): the selection, the drop
  // highlight, the snapshot map, and App's own callbacks (whose
  // identities legitimately move with the snapshot/selection — the pane
  // must not inherit that churn into every row). The row binds its own
  // id at the DOM boundary.
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onRenameRef = useRef(onRename);
  onRenameRef.current = onRename;
  const mergeIntoRef = useRef(onMergeInto);
  mergeIntoRef.current = onMergeInto;
  const dropFacesRef = useRef(onDropFaces);
  dropFacesRef.current = onDropFaces;
  const rowHandlers = useMemo(() => {
    // #260: `clearDrag` (the shared tree-drag clear, above) and
    // `liveFaceDrag` (the shared face-drag predicate, above) are the
    // single definitions — no local dups
    return {
      onSelect: (id: number, e: ReactMouseEvent) => onSelectRef.current(id, e),
      // #255: the row's keyboard home — focus moves the roving tabindex,
      // arrows/Enter run the APG tree pattern (the parent branch is the
      // row's nearest .tree-node ancestor, read from the DOM)
      onFocus: (id: number) => setFocusedKey(`p:${id}`),
      onKeyDown: (id: number, e: React.KeyboardEvent) => {
        const el = e.currentTarget as HTMLElement;
        const parentKey =
          el.closest(".tree-node")?.getAttribute("data-tree-key") ?? null;
        treeItemKey(
          e,
          `p:${id}`,
          false,
          false,
          () => onSelectRef.current(id),
          () => {},
          parentKey
        );
      },
      onStartRename: (id: number) => setRenamingId(id),
      onRename: (id: number, name: string) => onRenameRef.current(id, name),
      onRenameCancel: (_id: number) => setRenamingId(null),
      onContextMenu: (id: number, e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, id });
      },
      // #50: drag the person — or the whole selection when part of one
      onDragStart: (id: number, groupPath: string, e: React.DragEvent) => {
        // #165/§4.35/#266: a reject-bin person never drags (a merge/move
        // source)
        if (isRejectedBin(byIdRef.current.get(id)?.name ?? "")) return;
        const sel = selectedIdsRef.current;
        const ids = sel.has(id) && sel.size > 1 ? [...sel] : [id];
        // #157 (v3.59): the dragged placement's branch path rides along —
        // the drop re-homes THAT membership (owner ruling: the
        // dragged-from group leaves the person, the target group is
        // filed, other memberships are kept)
        dragRef.current = { kind: "persons", ids, src: groupPath };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `${ids.length} person(s)`); // firefox needs data
      },
      onDragEnd: clearDrag,
      // #88 (§4.28): dragging persons ONTO a person row = merge into it —
      // a new drop-target type beside #50's branch/Ungrouped drops. #135
      // (rule 34) adds the same row as a target for FACE drags from the
      // centre pane. Branch drags deliberately fall through (no
      // stopPropagation) so hovering a person row inside a branch still
      // targets that branch.
      onDragOver: (id: number, e: React.DragEvent) => {
        const d = dragRef.current;
        if (d && d.kind === "persons") {
          e.preventDefault();
          e.stopPropagation(); // the branch under this row must not highlight
          e.dataTransfer.dropEffect = "move";
          if (dropPersonRef.current !== id) setDropPerson(id);
          return;
        }
        if (liveFaceDrag()) {
          // #135: face payload — person rows accept (ref-checked at
          // event time, v3.33)
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          if (dropPersonRef.current !== id) setDropPerson(id);
        }
      },
      onDragLeave: (id: number) => {
        if (
          (dragRef.current?.kind === "persons" || liveFaceDrag()) &&
          dropPersonRef.current === id
        ) {
          setDropPerson(null);
        }
      },
      onDrop: (id: number, e: React.DragEvent) => {
        const d = dragRef.current;
        if (d && d.kind === "persons") {
          e.preventDefault();
          e.stopPropagation();
          const ids = d.ids;
          clearDrag();
          // validation + confirmation live in App (shared with
          // menu/dialog, §4.28)
          mergeIntoRef.current(ids, id);
          return;
        }
        const faces = faceDragRef?.current ?? null;
        if (faces && faces.length > 0) {
          // #135: face payload → face-level merge (ref at drop time, v3.33)
          e.preventDefault();
          e.stopPropagation();
          clearDrag();
          dropFacesRef.current?.(faces, id);
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref-only by construction (#223)
  }, []);

  const renderNode = (node: TreeNode, depth: number, path: string, groupPath: string) => {
    // #223: the index entry replaces the subtreeMatch walk…
    const entry = treeIdx.get(node);
    if (!entry || !entry.match) return null;
    const personsHere = node.personIds
      .map((id) => byId.get(id))
      .filter((p): p is Person => !!p && matches(p));
    // …and the child filter is an O(children) lookup, not a walk
    const children = node.children.filter((c) => treeIdx.get(c)?.match);
    if (node.name === "" ) {
      // root: just render children; #164 removed the empty-space
      // 'Add group…' menu (#54 superseded) — swallow the context menu
      return (
        <div
          key={path || "root"}
          onContextMenu={(e) => e.preventDefault()}
        >
          {children.map((c) => renderNode(c, 0, c.name, c.name))}
        </div>
      );
    }
    const virtual = isVirtual(node.name, depth);
    const system = isStatusBranch(node.name, depth);
    // drop target for this node: '' = Ungrouped (virtual) — no group path;
    // status branches accept no drops at all (#165/§4.35)
    const dropTarget = virtual && node.name === "Ungrouped" ? "" : groupPath;
    const isCollapsed = collapsed.has(path) && f === "";
    const collapsible = node.children.length > 0 || node.personIds.length > 0;
    return (
      <div key={path}>
        <div
          // #176 (§4.41): the status branches speak the status colours
          className={`tree-node${dropPath === dropTarget ? " drop-target" : ""}${
            system ? ` status-${node.name.toLowerCase()}` : ""
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          // #255: APG tree branch — roving tabindex, Enter/Space + Left/Right
          // toggle, Up/Down move focus, Left on a collapsed branch climbs
          role="treeitem"
          aria-expanded={collapsible ? !isCollapsed : undefined}
          tabIndex={focusedKey === `b:${path}` ? 0 : -1}
          data-tree-key={`b:${path}`}
          data-owns-keys
          onClick={() => (collapsible ? toggle(path) : undefined)}
          onFocus={() => setFocusedKey(`b:${path}`)}
          onKeyDown={(e) => {
            const el = e.currentTarget as HTMLElement;
            const parentKey =
              el.parentElement?.closest(".tree-node")?.getAttribute("data-tree-key") ??
              null;
            treeItemKey(e, `b:${path}`, true, !isCollapsed, () => toggle(path), () => toggle(path), parentKey);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // #154/#165: virtual and status branches offer no branch menu
            // — status branches are system furniture (§4.35)
            if (virtual || system) return;
            setBranchMenu({ x: e.clientX, y: e.clientY, node, groupPath });
          }}
          draggable={!virtual && !system}
          onDragStart={(e) => !virtual && !system && startDragBranch(e, groupPath)}
          onDragEnd={clearDrag}
          onDragOver={(e) => (system ? undefined : dragOver(e, dropTarget))}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (dropPath === dropTarget) setDropPath(null);
          }}
          onDrop={(e) => (system ? undefined : acceptDrop(e, dropTarget))}
        >
          {collapsible ? (
            <span className="tree-arrow">{isCollapsed ? "▸" : "▾"}</span>
          ) : (
            <span className="tree-arrow" />
          )}
          <span className="tree-node-name">{node.name}</span>
          <span className="tree-count dim">{entry.count}</span>
        </div>
        {!isCollapsed && (
          <>
            <div className="tree-children" style={{ paddingLeft: 10 + depth * 14 }}>
              {personsHere.map((p) => (
                <MemoPersonRow
                  key={p.id}
                  person={p}
                  personOptions={persons}
                  selected={selectedId === p.id}
                  multi={selectedIds.has(p.id)}
                  renaming={renamingId === p.id}
                  rot={primaryRot.get(p.id) ?? 0}
                  groupPath={groupPath}
                  tabbable={focusedKey === `p:${p.id}`}
                  {...rowHandlers}
                  dropTarget={dropPerson === p.id}
                />
              ))}
            </div>
            {children.map((c) => renderNode(c, depth + 1, `${path}/${c.name}`, groupPath ? `${groupPath}|${c.name}` : c.name))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="person-tree">
      {/* gui-design 6.1 / #261: the left-pane top bar — two rows: the
          search input (flex) + Clear (✕) on top, then the roll
          controls + Merge Similar. The old *Review — N pending* button
          is gone: the top bar's status totals beside the lock (§4.41)
          show the pending count. */}
      <div className="tree-header">
        <div className="tree-tools">
          {/* gui-design 6.1: row 1 — search input + Clear (✕) */}
          <div className="tree-filter-row">
            <input
              className="tree-filter"
            placeholder="search persons…"
            title="Filter the tree by person name or group"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            onContextMenu={(e) => {
              e.preventDefault();
              setClearMenu({
                x: e.clientX,
                y: e.clientY,
                groups: [
                  {
                    items: [
                      {
                        label: "Clear",
                        disabled: filter === "",
                        onClick: () => onFilter("")
                      },
                    ],
                  },
                ],
              });
            }}
            />
            <button
              className="ghost"
              onClick={() => onFilter("")}
              disabled={filter === ""}
              title="Clear the search filter"
            >
              ✕
            </button>
          </div>
          {/* gui-design 6.1: row 2 — roll controls + Merge Similar */}
          <div className="tree-actions-row">
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
            {/* §4.28 + #88: the merge-similar dialog — icon-only like
                the ⌃/⌄ neighbours (v12.7/#286); the wording lives in
                the tooltip, reference-free (§4.43) */}
            <button
              className="ghost merge-open"
              onClick={onOpenMerge}
              title="Merge Similar Persons — find and combine near-identical names"
            >
              ⧉
            </button>
          </div>
        </div>
      </div>
      {clearMenu && (
        <ContextMenu menu={clearMenu} onClose={() => setClearMenu(null)} />
      )}
      {/* #255: the APG tree — branch nodes + person rows are the treeitems */}
      <div role="tree" aria-label="persons and groups">
        {renderNode(tree, 0, "", "")}
      </div>
      {menu && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            groups: [
              {
                items: [
                  {
                    label: "Open person",
                    onClick: () => onSelect(menu.id),
                    disabled: manyInMenu, // #182: one person at a time
                  },
                  {
                    label: "Rename…",
                    onClick: () => setRenamingId(menu.id),
                    // #182: inline rename is single-person — the
                    // multi-scope has 'Rename N persons to…' below
                    disabled: systemInMenu || manyInMenu,
                  },
                  {
                    label: "Select their pending faces",
                    onClick: () => onSelectPending?.(menu.id),
                    disabled:
                      (persons.find((p) => p.id === menu.id)?.counts.provisional ?? 0) === 0 ||
                      manyInMenu,
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
                    disabled: systemInMenu,
                  },
                  {
                    // #164 (§4.18): an ADDITIONAL membership — Move
                    // replaces every group, this keeps them all
                    // (move_persons_between_groups with from='')
                    label:
                      menuTargets.length > 1
                        ? `Add group to ${menuTargets.length} persons…`
                        : "Add group…",
                    onClick: () => setGroupDialog({ kind: "add-group", ids: menuTargets }),
                    disabled: systemInMenu,
                  },
                  {
                    // #88 (§4.28): shared confirmation dialog, target via
                    // typeahead; the hint column carries shortcuts/group
                    // info only — no section numbers there (§4.43)
                    label:
                      menuTargets.length > 1
                        ? `Merge ${menuTargets.length} persons into…`
                        : "Merge into…",
                    onClick: () => onMergeInto(menuTargets),
                    disabled: systemInMenu,
                  },
                  // #88 (§4.28): rename-merge over all their faces (§4.1);
                  // a single person already has inline rename (double-click)
                  ...(menuTargets.length > 1 && onRenameSelection
                    ? [
                        {
                          label: `Rename ${menuTargets.length} persons to…`,
                          onClick: () => onRenameSelection(menuTargets),
                          disabled: systemInMenu,
                        },
                      ]
                    : []),
                  {
                    label:
                      menuTargets.length > 1
                        ? `Remove ${menuTargets.length} persons`
                        : "Remove person",
                    onClick: () => onRemovePersons(menuTargets),
                    disabled: systemInMenu,
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
              // deleted; virtual and status branches never open this
              // menu (status branches are system furniture, #165/§4.35)
              {
                title: "Group",
                items: [
                  {
                    // #164 (§4.18): 'Add group…' moved to person rows —
                    // branches derive from person paths, so a branch
                    // entry could only move the selection (disabled
                    // without one) or "create" nothing visible
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
      {/* #165/§4.35 (status seats) + §4.16 (add vs replace) — the
          dialog bodies stay reference-free (§4.43) */}
      {/* #256 — the "add-group" kind is the shared AddGroupDialog
          (title/body/normalization in ONE place); the other two stay.
          #165/§4.35 (status seats) + §4.16 (add vs replace) — the
          dialog bodies stay reference-free (§4.43) */}
      {groupDialog && groupDialog.kind !== "add-group" && (
        <GroupDialog
          options={pathOptions}
          title={
            groupDialog.kind === "rename-branch"
              ? "Rename / move group"
              : groupDialog.ids.length > 1
                ? `Move ${groupDialog.ids.length} persons to a group`
                : "Move person to a group"
          }
          body={
            groupDialog.kind === "rename-branch"
              ? "The whole branch — including sub-branches — follows to the new path. " +
                "Empty = everybody falls to their status seat."
              : // #233 (§4.35 display rule) lives in the defaultPath below
                "Replaces each person's group path (empty = their status seat). " +
                "Faces and names are untouched."
          }
          defaultPath={
            groupDialog.kind === "rename-branch"
              ? groupDialog.path
              // #233 (§4.35 display rule): the prefill is the person's
              // first REAL group — a status seat never shows as the
              // current group
              : firstRealGroup(byId.get(groupDialog.ids[0])?.groups ?? [])
          }
          submitLabel={
            groupDialog.kind === "rename-branch" ? "move group" : "move"
          }
          onSubmit={(path) => {
            const d = groupDialog;
            setGroupDialog(null);
            if (d.kind === "rename-branch") {
              // compare normalised (#42 via #256's normalizeGroupPath):
              // whitespace-only edits are a no-op
              const norm = normalizeGroupPath(path);
              if (norm !== d.path) onRenameGroup(d.path, norm);
            } else {
              onMovePersons(d.ids, path);
            }
          }}
          onCancel={() => setGroupDialog(null)}
        />
      )}
      {groupDialog?.kind === "add-group" && (
        <AddGroupDialog
          ids={groupDialog.ids}
          persons={persons}
          options={pathOptions}
          onSubmit={(ids, norm) => {
            setGroupDialog(null);
            if (norm && ids.length > 0) onAddGroup(ids, norm);
          }}
          onCancel={() => setGroupDialog(null)}
        />
      )}
      {confirmDeleteGroup && (
        <ConfirmDialog
          title={`Delete group '${confirmDeleteGroup.path}'`}
          body={
            // #165/§4.35: absorbed persons fall to their status seat —
            // the body stays reference-free (§4.43)
            `${confirmDeleteGroup.count} person(s) — including any sub-branches — ` +
            "fall to their status seat. Faces, names and statuses are untouched."
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

// #215: memoised — App keeps the handler identities stable, so a
// re-render that changes none of this pane's own props skips it
export default memo(PersonTree);
