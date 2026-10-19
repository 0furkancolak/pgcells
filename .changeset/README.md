# Changesets

Every pull request that changes a published package adds a changeset (`bun run changeset`): pick the packages, the bump (`patch`, `minor`; `major` only after 1.0) and write the release note in one or two sentences. The release workflow turns pending changesets into a "version packages" pull request and publishes when it is merged.

`@0furkancolak/pgcells`, `@0furkancolak/pgcells-single` and `@0furkancolak/pgcells-redis` are versioned together.
