# Milestone Zero evidence — target baseline ddefc45

Index of acceptance evidence for target commit `ddefc45fbc7f8e46dd73185e68295696d1297887`
(`0.1.6-alpha.2`). The August records in [../README.md](../README.md) remain the
historical evidence for the old baseline `47f9438` and are not reused here.

| Task | Evidence | Status |
|---|---|---|
| A1 repo baseline | commit history of this repository | DONE (a2ce83d) |
| A2 build & boot baseline | `A2-build-boot.md`, `A2-logupload-off.md`, `A2-v3-migration.md` | PASS (build/CLI/boot/upload-off/V3+P1); real PTC session PENDING credentials |
| A2/P5 CLI probe | recorded in `A2-build-boot.md` | PASS |
| A2/P6 upload-off config | `A2-logupload-off.md` | PASS (config level + request level, both directions) |
| A2/P1 standalone persistence (via V3 migration script) | `A2-v3-migration.md` | PASS |
| A3 probe adaptation | `A3-probe-adaptation.md` | PASS (tests 3/3, real-session record + handle match, marker lifecycle installed/removed/reinstalled); successful model turn PENDING credentials |

Rules: every record states what actually ran and what did not; simulated or
partial results are never recorded as passed acceptance.
