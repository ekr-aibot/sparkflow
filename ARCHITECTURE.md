# Architecture: PR Merge Sync & Cleanup

## Goal
Improve the PR merge-sync process in the `feature-development` workflow and simplify the examples folder.

## Key Design Decisions
- **Fast-Forward Priority**: Maintain `git pull --ff-only` as the primary, fast mechanism for updating the local repository.
- **Agent Fallback**: Use a `claude-code` runtime step (`git-rebase`) to handle cases where a simple fast-forward pull fails (e.g., due to local commits or complex history).
- **Shared Worktree Mode**: Both sync-related steps (`git-pull` and `git-rebase`) operate in `mode: "shared"` to ensure the user's primary working directory is updated.
- **Environment-Based LLM Selection**: Use the `SPARKFLOW_LLM` environment variable to toggle between LLM providers, removing the need for separate workflow files.

## Constraints
- Modifications are restricted to the workflow examples and should not impact the core runtime adapter code.
- The `git-rebase` step must be interactive to allow the agent to resolve conflicts safely.

## Decisions
- (None yet)
