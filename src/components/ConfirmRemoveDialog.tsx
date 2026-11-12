// The person-removal confirm (gui-design §4.44 round 2 stage 4, #295)
// — the #165/§4.13 informational copy and the #266 wording as a
// dedicated component; the removal action (the exhaust mark, the
// anchor drop, the mutation) stays in App. Copy is product language
// (rule 43).
import ConfirmDialog from "./ConfirmDialog";

export default function ConfirmRemoveDialog({
  ids,
  onConfirm,
  onCancel,
}: {
  ids: number[];
  onConfirm: (ids: number[]) => void;
  onCancel: () => void;
}) {
  const many = ids.length > 1;
  return (
    <ConfirmDialog
      title={many ? `Remove ${ids.length} persons` : "Remove person"}
      body={
        // #165/§4.13 informational copy, #266 wording: removal
        // rejects the faces and files them onto their rejected
        // cluster person; they can be claimed again — the body
        // stays reference-free (§4.43)
        `All faces of ${many ? "these persons" : "this person"} ` +
        `become rejected and join a rejected cluster; ` +
        `${many ? "the persons are" : "the person is"} deleted — ` +
        "the faces stay in the database and can be claimed again by " +
        "assigning them a person. This cannot be undone."
      }
      confirmLabel="remove"
      danger
      onConfirm={() => onConfirm(ids)}
      onCancel={onCancel}
    />
  );
}
