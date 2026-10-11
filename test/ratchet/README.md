# Env-read ratchet (operator-owned, closed by design)

`env-read-ratchet.test.ts` pins every environment variable name activity-api's `src/` reads, with
`env-read-ratchet.list.json` saying for each name whether it is **bootstrap** (secrets, own/peer
endpoints, identity, filesystem roots, log level, test-only flags) or **behaviour** (anything that
switches runtime behaviour), and why. The behaviour set is frozen in the test file and may only shrink.

This directory is **operator-owned and closed to the autonomous lane by design**. The system must refuse
behaviour-switch breakage from anyone, operators included:

- A behaviour change goes through a **shaped mechanism** (an impulse read at use time, law 1), never by
  editing the list or `FROZEN_BEHAVIOUR`.
- Adding a name to the frozen behaviour set, adding a behaviour entry to the list, or re-classing a
  frozen behaviour name as bootstrap is **refused** by the test.
- A new bootstrap name needs an explicit list entry with a reason, visible in review.
- Removing a behaviour switch (migrating its read to a shape) is always allowed: delete the read, its
  list entry, and its name in `FROZEN_BEHAVIOUR`. Stale entries are printed as a warning.

Dynamic reads (`process.env[expr]`) are pinned as `<dynamic>@file:<expression>#n` (whitespace and
comments removed, `n` the occurrence index of that expression in the file), never by line number, so an
edit that only shifts lines in a file cannot fail the gate; a new dynamic read is a new pin and fails.

Each entry's `reason` is checked only for being present and non-empty, never for its content (the site
lists in it are informational and may go stale), so a stale reason can never fail the gate.

`env-read-scanner.ts` is the dependency-free scanner; its header lists the forms it recognises and the
residual forms it does not.
