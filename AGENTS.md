## Branching Strategy

- **All changes must be done in a `dev` branch**, branched fresh from `main` per change.
- The `dev` branch is **NEVER** to be pushed to `origin`.
- Development proceeds by:
    1. Investigation and planning; results land in the design document (and/or a GitHub issue).
    2. Update the design document and commit to `dev`.
    3. Implement code and commit to `dev`.
    4. Update tests and commit to `dev`.
    5. Loop [test, fix bugs, commit] until all tests pass.
- `main` is **pushed to `origin`** only when the user gives the go-ahead.

## Design Documents

All development is governed by a design document.

- Design documents have a **version** consisting of `major.minor`:
    - **Major** is bumped for new features.
    - **Minor** is bumped for changes or corrections.
- The agent proposes version bumps in the design document.

## Other documents

- Only AGENTS.md lives in `.`.
- Other current documents live in `./docs/`.

## Application Versioning

Each application (one per app subdirectory) has a **version number** consisting of `major.minor.subminor`,
recorded in the app's `package.json` (or version file if the app has none):

- **Major** and **minor** always correspond to the design document's version (`major.minor`).
- **Subminor** is bumped by the agent for bug fixes and small changes that do not modify the design document.

## Thinking

- Do not loop.
- If confused, stop and ask for clarity.

## Issues

- Issues are managed with the `gh issue` commands, labelled appropriately (e.g. `bug`, `enhancement`, `frontend`, `script`).

## Migration/Legacy files

- No database migrations in development; schema changes are applied by dropping and recreating the database from the DDL.
- Legacy files are moved to legacy/ to keep the repo clean.

## Testing

- All tests are integrated into the suite for regression testing; each app's suite is run before committing.
- Tests reside under an appropriate `test/` subdirectory.
- TypeScript must pass `tsc --noEmit` (globally installed) before committing.
