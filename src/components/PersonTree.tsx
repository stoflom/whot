import { useMemo, useState } from "react";
import type { Person } from "../api";
import { useFaceImage } from "../hooks";

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
  for (const p of persons) {
    if (p.name.startsWith("Unknown")) {
      unknown.personIds.push(p.id);
    } else if (p.groups.length === 0) {
      ungrouped.personIds.push(p.id);
    } else {
      const parts = p.groups[0].split("|").filter(Boolean);
      let node = root;
      for (const part of parts) node = find(node, part);
      node.personIds.push(p.id);
    }
  }
  return root;
}

interface Props {
  persons: Person[];
  selectedId: number | null;
  reviewCount: number;
  onReview: () => void;
  onSelect: (id: number) => void;
}

function PersonRow({
  person,
  selected,
  onSelect,
}: {
  person: Person;
  selected: boolean;
  onSelect: () => void;
}) {
  const img = person.primary_face_id ? useFaceImage(person.primary_face_id) : null;
  return (
    <button
      className={`tree-person${selected ? " selected" : ""}`}
      onClick={onSelect}
      title={person.groups.join(", ") || "Ungrouped"}
    >
      <span className="tree-avatar">
        {img ? <img src={img} alt="" /> : person.name[0]}
      </span>
      <span className="tree-name">{person.name}</span>
      {person.counts.provisional > 0 && (
        <span className="tree-count prov" title="provisional faces">
          {person.counts.provisional}
        </span>
      )}
      <span className="tree-count total" title="all faces">
        {person.counts.total}
      </span>
    </button>
  );
}

export default function PersonTree({ persons, selectedId, reviewCount, onReview, onSelect }: Props) {
  const [filter, setFilter] = useState("");
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

  const renderNode = (node: TreeNode, depth: number, path: string) => {
    if (!subtreeMatch(node)) return null;
    const personsHere = node.personIds
      .map((id) => byId.get(id))
      .filter((p): p is Person => !!p && matches(p));
    const children = node.children.filter(subtreeMatch);
    if (node.name === "" ) {
      // root: just render children
      return (
        <div key={path || "root"}>
          {children.map((c) => renderNode(c, 0, c.name))}
        </div>
      );
    }
    const isCollapsed = collapsed.has(path) && f === "";
    return (
      <div key={path}>
        <div
          className="tree-node"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (children.length > 0 ? toggle(path) : undefined)}
        >
          {children.length > 0 ? (
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
                  selected={selectedId === p.id}
                  onSelect={() => onSelect(p.id)}
                />
              ))}
            </div>
            {children.map((c) => renderNode(c, depth + 1, `${path}/${c.name}`))}
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
      <input
        className="tree-filter"
        placeholder="filter by name or group…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <button className={`tree-review${selectedId === null ? " selected" : ""}`} onClick={onReview}>
        ▦ Review — {reviewCount} pending
      </button>
      {renderNode(tree, 0, "")}
    </div>
  );
}
