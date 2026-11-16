// #331 — the centre pane's toolbar subtree, extracted verbatim from
// App.tsx's render (the mode's ‹ n/m › stepper cluster + the person
// view's cluster-group seg). App stays the state owner — the props ARE
// the existing values and callbacks, relocated; no behaviour change.
// The contract suite (C1–C74) pins the surface.
import type { Mode } from "../sections";
import type { ClusterGroup } from "../viewFilters";

interface Props {
  mode: Mode;
  /** Rolls: the selected branch's images (the ‹ n/m › denominator) */
  branchImageCount: number;
  /** Rolls: the open image's index in the branch list (-1 = off-list) */
  imgStepIdx: number;
  /** Person/Review: the tree's visible order (the stepper's range) */
  stepIds: number[];
  /** the anchored person's index in stepIds (-1 = not in it) */
  stepIdx: number;
  /** Person view only: how faces form sections (§4.9) */
  clusterGroup: ClusterGroup;
  stepImage: (dir: 1 | -1) => void;
  stepPerson: (dir: 1 | -1) => void;
  setClusterGroup: (g: ClusterGroup) => void;
}

export default function CenterToolbar({
  mode,
  branchImageCount,
  imgStepIdx,
  stepIds,
  stepIdx,
  clusterGroup,
  stepImage,
  stepPerson,
  setClusterGroup,
}: Props) {
  return (
    <div className="center-toolbar">
      <span className="toolbar-left">
        {mode === "rolls" ? (
          <>
            <button
              className="ghost"
              onClick={() => stepImage(-1)}
              disabled={
                branchImageCount === 0 ||
                imgStepIdx === -1 ||
                imgStepIdx <= 0
              }
              title="previous image (←)"
            >
              ‹
            </button>
            <span className="nav-pos">
              {branchImageCount > 0
                ? `${imgStepIdx === -1 ? "–" : imgStepIdx + 1}/${branchImageCount}`
                : "–"}
            </span>
            <button
              className="ghost"
              onClick={() => stepImage(1)}
              disabled={
                branchImageCount === 0 ||
                imgStepIdx === -1 ||
                imgStepIdx >= branchImageCount - 1
              }
              title="next image (→)"
            >
              ›
            </button>
          </>
        ) : (
          <>
            <button
              className="ghost"
              onClick={() => stepPerson(-1)}
              disabled={stepIds.length === 0 || (stepIdx !== -1 && stepIdx <= 0)}
              title="previous person (←)"
            >
              ‹
            </button>
            <span className="nav-pos">
              {stepIds.length > 0
                ? `${stepIdx === -1 ? "–" : stepIdx + 1}/${stepIds.length}`
                : "–"}
            </span>
            <button
              className="ghost"
              onClick={() => stepPerson(1)}
              disabled={
                stepIds.length === 0 || (stepIdx !== -1 && stepIdx >= stepIds.length - 1)
              }
              title="next person (→)"
            >
              ›
            </button>
          </>
        )}
      </span>
      {/* #99/#100: the cluster-group seg hugs the right side of the
          person view — the Show filter is a global control and lives
          in the top bar (#158, v3.57); #163: person view ONLY —
          cluster_group shapes that view's sections alone (§4.9), so
          Review and Rolls must not show it; its title stays
          reference-free (§4.43) */}
      {mode === "person" && (
        <span className="toolbar-right">
          <span
            className="seg"
            title="Person view: how faces form sections — Accuracy = similarity clusters within each description; Description = one section per description (threshold ignored)"
          >
            <button
              className={clusterGroup === "description" ? "active" : ""}
              onClick={() => setClusterGroup("description")}
            >
              Description
            </button>
            <button
              className={clusterGroup === "accuracy" ? "active" : ""}
              onClick={() => setClusterGroup("accuracy")}
            >
              Accuracy
            </button>
          </span>
        </span>
      )}
    </div>
  );
}
