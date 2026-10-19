## What and why

## Checklist

- [ ] Failing test written first, then the change
- [ ] `bun run typecheck`, `bun run lint`, unit tests pass; integration tests run if the change touches SQL, drivers, locks or placement
- [ ] No applied migration/seed file was edited (`frozen-identifiers` test passes)
- [ ] Changeset added for published packages (`bun run changeset`)
- [ ] Docs updated (`packages/*/docs`, `docs/guides`)
- [ ] Commits are signed off (`git commit -s`)
