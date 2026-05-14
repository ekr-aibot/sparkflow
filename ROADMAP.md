# Roadmap: PR Merge Sync & Cleanup

## Merge Sync Improvement
- [ ] Update `git-pull` step in `examples/feature-development.json` to handle failures
- [ ] Add `git-rebase` agent fallback step to `examples/feature-development.json`
- [ ] Validate `examples/feature-development.json` schema

## Consolidation
- [ ] Delete redundant `examples/codex-feature-development.json`
- [ ] Verify `SPARKFLOW_LLM=codex` works with `feature-development.json`

## Verification
- [ ] Induce a local sync conflict and verify agent fallback
- [ ] Confirm cleanup of examples folder
