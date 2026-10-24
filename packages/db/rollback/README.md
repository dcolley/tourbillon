# Rollback (down) files

Drizzle only migrates forward. For each migration in `src/migrations/NNNN_name.sql`, this folder holds a hand-written `NNNN_name.down.sql` that reverses it. A down file undoes the schema change and deletes that migration's row from `drizzle.__drizzle_migrations`.

## Run rollbacks newest first

Always roll back in reverse order: the newest applied migration first, then the one before it. For example, roll back 0020 before 0019, and 0019 before 0018. Never roll back an older migration while a newer one is still applied.

The reason is how drizzle's migrator decides what to apply. It reads the newest `created_at` in `drizzle.__drizzle_migrations` and applies only migrations whose timestamp is newer than that. Suppose you run `0018_…down.sql` while 0019 is still applied:

- 0018's objects are dropped and its journal row is deleted.
- 0019's row is still the newest, so a later `pnpm db:migrate` treats 0018 as already applied.
- Drizzle reports success but never recreates 0018's objects.

The database is then missing those objects, with nothing to say so.

To roll back to just before migration N, run the down file for every applied migration newer than N, newest first, and then run N's down file.

## Running a down file

Back up the database first. Then apply the file by hand against the target database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/rollback/0020_apr2_hitl.down.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/rollback/0019_assistant_thread_pins.down.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/rollback/0018_slippery_justin_hammer.down.sql
```

Here `DATABASE_URL` points at the database you are rolling back. Afterwards, `pnpm db:migrate` re-applies the rolled-back migrations in order, provided the steps above were followed newest first.

## Every migration ships with a down file and a rollback test

A PR that adds a migration must also add:

1. `packages/db/rollback/<migration tag>.down.sql`. It reverses only that migration's objects and deletes its `drizzle.__drizzle_migrations` row (matched on `created_at`, the journal `when`).
2. A rollback test in `packages/db/src/*.test.ts`. The test runs against an in-memory Postgres (PGlite) with the repo's migrations applied, and goes up, down, then up again. It checks that the objects are gone after the down file, that unrelated data is untouched, and that the normal migrator recreates the objects. It also checks that the down file only touches that migration's objects and journal row.

`src/apr2-hitl-migration.test.ts` (0020), `src/assistant-thread-pins-migration.test.ts` (0019) and `src/company-llm-provider-queries.test.ts` (0018) are examples.
