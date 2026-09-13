## Dogfooding

Codeestra is developed with Codeestra itself, so the tooling is exercised on every change to this repository.

- Every task runs in its own git worktree rather than in the primary checkout, keeping concurrent work isolated.
- The worktree is checked out on a `refs/heads/task/<task-id>` branch dedicated to that task.
- Results are committed on that task branch, so each task's changes are reviewable and independently traceable.
- Task verification runs the commands declared in `.codeestra/policies/verification.json`.
- Verification executes against an isolated copy of the tested commit, so the checks reflect exactly the revision under test.
