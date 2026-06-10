# E2E Working Notes

E2E tests express `design/10-e2e-contract.md` through public protocol surfaces. Keep package implementation details out of this directory.

Default CI runs the e2e suite with full scenarios skipped. A full scenario becomes active only when the harness environment in `README.md` is complete.

Fixture data belongs in `support/contract-fixtures.ts` and must pass the current protocol validators before a scenario sends it across a boundary.
