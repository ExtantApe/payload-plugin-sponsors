# Changelog

## Unreleased

- Tests for the public read, `GET /api/sponsors`, through Payload's own REST handler against a real in-memory MongoDB: a visitor, a signed-in user who is not staff, and staff. Listed, current sponsors only for the first two, never contacts, unlisted or archived sponsors, however the query is written; staff see everything. Also checks that the exported `publicSponsors` filter is not changed by requests.
- No code change. A visitor's 500 on `GET /api/sponsors` could not be reproduced with the plugin alone (0.3.2 behaves the same on every query tried), so no fix is claimed. See the pull request.

Tested: full suite (29 tests), typecheck, build and the leak check, on Node 24. The new tests pass on the unchanged plugin.
Not tested: a host that wraps `read` with a multi-tenant plugin or its own request-time lookups, a real browser, and Atlas rather than the in-memory MongoDB.
