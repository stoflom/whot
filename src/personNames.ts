// #266 (gui-design §4.35) — the RejectedN cluster-person name family:
// `Rejected` + digits, case-insensitive (the backend's
// `is_rejected_cluster_name` parse rule, mirrored here so the family
// lives in one place). The exact name `Rejected` (no
// digits) is the LEGACY system person, retired by the one-shot split —
// writer-owned in the backend either way, so the GUI treats the whole
// family identically: no rename/move/file/merge/remove/drop, no name or
// seat prefill. The family is listed under All and Show → Rejected while
// it holds faces (§4.10, #305).
// Pure.

/** does this name belong to the writer-owned reject-bin family
    (legacy `Rejected` included)? */
export const isRejectedBin = (name: string): boolean =>
  /^rejected\d*$/i.test(name.trim());
