# CODE AUDIT REPORT

**Scope:** static review of the two repository files. No Apps Script project manifest,
deployment configuration, sheet schemas, trigger definitions, execution logs, or API
responses were supplied. Therefore all findings below are limited to behavior that is
directly observable in `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`; unprovided runtime
facts are marked **UNKNOWN**.

## 1. Executive summary

| Measure | Result |
| --- | --- |
| Overall health | 31/60 (static-review estimate) |
| Production readiness | Not ready |
| Critical issues | 0 confirmed |
| High issues | 4 confirmed |
| Medium issues | 6 confirmed / potential as noted |
| Low issues | 2 |
| Optimization opportunities | 3 |
| Silent-error locations | 3 confirmed |

The entry point correctly rethrows caught errors, and the API key is obtained from
Script Properties rather than embedded in source. However, it can report `Success`
after silently omitting all primary result fields, can silently use zero distance for
invalid or unavailable distance data, and can overwrite a fixed 20-column window that
is not verified against the header. Concurrent executions are also not serialized or
made idempotent. These are material data-integrity risks.

## 2. Architecture and dependency assessment

### Current call graph

```text
findOptimalRouteUsingExistingDistance(shipmentId, rowId) [entry point]
  -> SpreadsheetApp.openById
  -> prepareWaypointsWithExistingDistance(ss, shipmentId)
       -> computed sheet header / TextFinder / per-match cell reads
  -> selectFinalDestinationAndSort(points)
  -> executeGoogleMapsRoutesAPIOneWay(points)
       -> Script Properties -> UrlFetchApp Routes API
  -> writeResultsToSheet(resultSheet, rowId, route result)
       -> result header / TextFinder / spreadsheet writes
  -> caller receives { Status, CalculatedDistanceKm, GoogleMapsLink }
```

### Strengths

* API errors with non-200 status are thrown; the entry point logs and rethrows them.
* Exact-cell `TextFinder` limits searches to the specified ID/shipment column.
* The API key is retrieved from Script Properties, not a source literal.
* Coordinate output uses a stable six-decimal representation.

### Weaknesses and risk areas

* **Data access:** three columns are looked up per matched shipment row, creating
  spreadsheet RPCs inside a loop; read/write dimensions and required output headers
  are not fully validated.
* **Processing:** a missing or malformed depot-distance value becomes `0`, altering
  final-destination selection without a failure signal.
* **External API:** successful but malformed/unexpected JSON is dereferenced without
  validation; no bounded retry/backoff strategy exists.
* **Output:** missing result headers are deliberately skipped, while the caller returns
  success. The 20 destination output columns are assumed contiguous.
* **Concurrency:** read-modify-write work has no `LockService`, idempotency key, or
  row version; trigger/web-app invocation behavior is **UNKNOWN**.

## 3. Critical findings (CRITICAL / HIGH only)

### [AUD-001]

**SEVERITY:** 🟠 HIGH  
**CATEGORY:** Silent failure / data integrity  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `writeResultsToSheet` / `findOptimalRouteUsingExistingDistance`  
**LINE:** 220-224, 240-242, 250-255, 50-54  
**CONFIDENCE:** HIGH  
**PROBLEM:** Only the ID header is required. Missing `GoogleMapsRoutesAPI`, distance,
map-link, or first-destination headers cause their writes to be skipped. The entry
point then returns `Status: "Success"`.  
**WHY IT MATTERS:** A schema rename or missing column can leave a request with no
visible result (or an incomplete result) while downstream AppSheet/business users are
told it succeeded.  
**FAILURE SCENARIO:** The distance header is renamed. The route API succeeds, the
distance write is skipped, and the function returns a success payload.  
**CURRENT BEHAVIOR:** Silent per-field omission.  
**EXPECTED BEHAVIOR:** Validate all output fields that the contract requires before
calling the external API; fail with a structured, actionable configuration error if
one is absent. If optional fields are intentionally supported, return explicit
`warnings` and do not label a partial result as unqualified success.  
**RECOMMENDED FIX:** Define a `requireHeaders(header, names)` helper and validate the
output schema. Preserve any genuinely optional fields in a documented configuration,
rather than treating absent headers as optional by default.  
**RISK OF FIX:** Existing sheets that intentionally omit a field will start failing
until their contract/configuration is made explicit.

### [AUD-002]

**SEVERITY:** 🟠 HIGH  
**CATEGORY:** Business logic / silent data corruption  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `prepareWaypointsWithExistingDistance` / `selectFinalDestinationAndSort`  
**LINE:** 115, 143-149  
**CONFIDENCE:** HIGH  
**PROBLEM:** `parseFloat(value) || 0` converts `NaN` and other falsy parsed values to
zero. The sort then treats this indistinguishably from a valid zero distance.  
**WHY IT MATTERS:** The final destination is selected from this sort order. Invalid
source distance can silently make a different stop the final destination and change
the route and reimbursement distance.  
**FAILURE SCENARIO:** A matched row contains an empty, locale-formatted, or malformed
distance. It is assigned `0`; a nearer/incorrect point can become the final
destination.  
**CURRENT BEHAVIOR:** Invalid input continues as a valid zero.  
**EXPECTED BEHAVIOR:** Distinguish a finite numeric zero from missing/invalid input;
reject affected records or apply a documented, observable fallback.  
**RECOMMENDED FIX:** Parse once, validate with `Number.isFinite(distance)`, and include
the shipment row in a thrown validation error (or return a structured skipped-record
warning if partial routes are an approved business rule). Do not use truthiness for
numeric validation.  
**RISK OF FIX:** Existing malformed distances that previously produced a route will be
rejected; data cleanup or an agreed fallback policy will be required.

### [AUD-003]

**SEVERITY:** 🟠 HIGH  
**CATEGORY:** Data integrity / schema assumption  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `writeResultsToSheet`  
**LINE:** 225, 245-255  
**CONFIDENCE:** HIGH  
**PROBLEM:** Finding `Lat/Long_ปลายทาง_01` authorizes a write to the next 20 physical
columns, without verifying that columns 02-20 exist, are destination columns, or
should be cleared.  
**WHY IT MATTERS:** A changed sheet layout can overwrite unrelated cells/formulas.
For routes with fewer stops, blank entries clear all remaining cells in this assumed
window.  
**FAILURE SCENARIO:** An unrelated calculated field is inserted after destination 05.
The batch write overwrites it with a coordinate or `''`.  
**CURRENT BEHAVIOR:** Fixed contiguous 20-cell write.  
**EXPECTED BEHAVIOR:** Derive and validate the exact allowed destination-column
indices from the header, then write only those columns. Clearing stale values must be
an explicit documented behavior.  
**RECOMMENDED FIX:** Build names `Lat/Long_ปลายทาง_01` through `_20`, verify every
required column before a contiguous `setValues`, or group verified contiguous runs.
Use an explicit `clearUnusedDestinationCells` policy.  
**RISK OF FIX:** If the existing physical 20-column window is an undocumented
contract, tightening it can expose layout discrepancies that need migration.

### [AUD-004]

**SEVERITY:** 🟠 HIGH  
**CATEGORY:** Concurrency / idempotency  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `findOptimalRouteUsingExistingDistance` / `writeResultsToSheet`  
**LINE:** 30-59, 218-258  
**CONFIDENCE:** MEDIUM  
**PROBLEM:** The flow reads matching data, calls a billed external service, finds a
target row, and writes results without `LockService`, an idempotency key, or a
compare-and-set/version check.  
**WHY IT MATTERS:** Concurrent trigger, web-app, AppSheet, or user invocations can
duplicate API charges and cause last-writer-wins output. Invocation sources are
**UNKNOWN**, so the probability requires runtime confirmation.  
**FAILURE SCENARIO:** Two executions for the same `rowId` run simultaneously; both
call Routes API and both write the target row.  
**CURRENT BEHAVIOR:** No serialization or duplicate detection.  
**EXPECTED BEHAVIOR:** Same logical request must be deduplicated or safely serialized;
different requests should retain appropriate throughput.  
**RECOMMENDED FIX:** Use a narrow `LockService` critical section plus a persisted
request/state key keyed by the business identifier and input fingerprint. Avoid
holding a global lock over a long network call; persist `PROCESSING`/`COMPLETED` state
and reconcile timed-out leases.  
**RISK OF FIX:** Incorrect key selection could suppress valid recalculations; business
rules for when a route may be recomputed are required.

## 4. Remaining findings

### [AUD-005]

**SEVERITY:** 🟡 MEDIUM  
**CATEGORY:** Runtime validation / error classification  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `executeGoogleMapsRoutesAPIOneWay`  
**LINE:** 192-204  
**CONFIDENCE:** HIGH  
**PROBLEM:** Parsed JSON, `routes`, `routes[0]`, `distanceMeters`, and optimization
indices are not schema-validated. A 200 response with no route produces an incidental
TypeError at `route.distanceMeters`, and an invalid index is silently omitted.  
**RECOMMENDED FIX:** Safely parse JSON, assert an array with one route, validate a
finite nonnegative `distanceMeters`, validate optimization index count/permutation,
and throw a contextual `RoutesApiResponseError`. Preserve a bounded/redacted response
excerpt for diagnostics.  
**RISK OF FIX:** Strict validation may reject previously tolerated API variations;
verify against captured approved responses.

### [AUD-006]

**SEVERITY:** 🟡 MEDIUM  
**CATEGORY:** Range bounds / empty dataset  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `prepareWaypointsWithExistingDistance`, `writeResultsToSheet`  
**LINE:** 81-82, 230-231  
**CONFIDENCE:** HIGH  
**PROBLEM:** Both ID/shipment search ranges start at row 2 but use `getLastRow()` as
the row count. The correct data-row count is `getLastRow() - 1`, after explicitly
handling a header-only/empty sheet.  
**WHY IT MATTERS:** The range includes one extra row and can exceed the sheet grid if
the last populated row is also the sheet's last allocated row; empty/header-only
cases have no valid data range.  
**RECOMMENDED FIX:** Introduce `getDataRowCount(sheet)` and return/throw a controlled
empty-input outcome before `getRange(2, ..., count, 1)`.  
**RISK OF FIX:** None expected beyond changing an incidental service exception into a
controlled error.

### [AUD-007]

**SEVERITY:** 🟡 MEDIUM  
**CATEGORY:** Input validation / geographic correctness  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `prepareWaypointsWithExistingDistance`  
**LINE:** 101-132  
**CONFIDENCE:** HIGH  
**PROBLEM:** Coordinate parsing removes all non-digit/comma/dot/minus characters and
only checks `isNaN`; latitude and longitude bounds are not enforced. Malformed values
may be silently skipped or sent to the API.  
**RECOMMENDED FIX:** Use an anchored coordinate parser and require latitude in
`[-90, 90]`, longitude in `[-180, 180]`. Record rejected matched rows so a route is
not silently computed from a subset unless partial processing is explicitly approved.  
**RISK OF FIX:** Source values currently accepted via aggressive cleanup may require
normalization in the sheet.

### [AUD-008]

**SEVERITY:** 🟡 MEDIUM  
**CATEGORY:** Reliability / external API  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `executeGoogleMapsRoutesAPIOneWay`  
**LINE:** 177-190  
**CONFIDENCE:** HIGH  
**PROBLEM:** One `UrlFetchApp.fetch` attempt is made; retryable transient failures
such as 429/5xx/timeouts are not distinguished from non-retryable failures.  
**RECOMMENDED FIX:** Add a small, bounded retry policy with exponential backoff and
jitter for only classified retryable failures. Do not retry 400/401/403/404. Respect
the execution deadline and surface final status/body safely.  
**RISK OF FIX:** Retries can increase charges or latency if the request is not made
idempotent; address AUD-004 first.

### [AUD-009]

**SEVERITY:** 🟡 MEDIUM  
**CATEGORY:** Configuration validation  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `prepareWaypointsWithExistingDistance`, `findOptimalRouteUsingExistingDistance`  
**LINE:** 34, 66, 69, 78, 47-48  
**CONFIDENCE:** HIGH  
**PROBLEM:** `getSheetByName` return values are used without checking for `null`.
Missing/renamed sheets consequently fail with an unhelpful TypeError rather than a
configuration error.  
**RECOMMENDED FIX:** Validate spreadsheet and named-sheet retrieval in a dedicated
repository/configuration boundary and include the configured sheet name in errors.  
**RISK OF FIX:** None; this improves diagnostics.

### [AUD-010]

**SEVERITY:** 🔵 OPTIMIZATION  
**CATEGORY:** Google Sheets performance / quota  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `prepareWaypointsWithExistingDistance`  
**LINE:** 99-120  
**CONFIDENCE:** HIGH  
**PROBLEM:** Each matched row issues one coordinate read and up to two additional
single-cell reads. This is an N+1 RPC pattern: for *m* matches, 1-3*m* reads occur
after the search.  
**RECOMMENDED FIX:** Read the three needed columns for all matched row numbers in
coalesced contiguous ranges, or read a bounded data block once and index it in memory.
Choose based on measured match distribution and sheet size.  
**RISK OF FIX:** Batch row/column mapping must be tested carefully to avoid mixing
values from different matched rows.

### [AUD-011]

**SEVERITY:** 🔵 OPTIMIZATION  
**CATEGORY:** Spreadsheet writes / quota  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `writeResultsToSheet`  
**LINE:** 240-255  
**CONFIDENCE:** HIGH  
**PROBLEM:** Up to four separate write RPCs are used per successful route. The first
three are separate cells; the fourth is the fixed destination window.  
**RECOMMENDED FIX:** After validating output schema, group only verified contiguous
columns into minimal `setValues` calls. Do not optimize by writing a broad rectangular
range that might overwrite formulas.  
**RISK OF FIX:** A careless rectangular batch write would create the very overwrite
risk described in AUD-003.

### [AUD-012]

**SEVERITY:** 🟢 LOW  
**CATEGORY:** Observability / privacy  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** `findOptimalRouteUsingExistingDistance`, `writeResultsToSheet`  
**LINE:** 32, 57, 258  
**CONFIDENCE:** MEDIUM  
**PROBLEM:** Logs include shipment/row identifiers and coordinates; error logging may
include external response text. Whether these are sensitive is **UNKNOWN**.  
**RECOMMENDED FIX:** Classify logs, avoid sensitive payloads by default, use a
correlation ID, and redact/truncate API error content.  
**RISK OF FIX:** Reduced debugging detail unless secure structured logging is
available.

### [AUD-013]

**SEVERITY:** 🟢 LOW  
**CATEGORY:** Maintainability  
**FILE:** `OPTIMIZED ROUTING SCRIPT PRO VERSION.gs`  
**FUNCTION:** global configuration / `writeResultsToSheet`  
**LINE:** 12-25, 222-225, 247  
**CONFIDENCE:** HIGH  
**PROBLEM:** Header names and the destination limit are split between constants and
inline string literals. This makes schema changes easy to apply partially.  
**RECOMMENDED FIX:** Centralize all header contracts and output policies in one frozen
configuration object, then validate it at entry.  
**RISK OF FIX:** Minimal if behavior is retained; tests should protect exact headers.

## 5. Silent error report

**SILENT ERROR COUNT: 3 confirmed locations**

| Location | Failure hidden | Business impact |
| --- | --- | --- |
| Lines 240-242 | Missing primary output header skips its write | Returns success with incomplete/no visible result |
| Line 115 | Invalid/missing distance coerced to zero | Wrong final destination/order may be selected |
| Lines 199-201 | Invalid optimized waypoint index is omitted | Returned route list can omit a stop while appearing successful |

The top-level `catch` is **not** a swallow: it logs and rethrows. The concern is that
the three conditions above continue normally, so no error reaches the caller.

### Recommended error flow

```text
Input/schema/API response validation failure
  -> typed contextual error (code, safe metadata, correlation ID)
  -> entry point logs redacted diagnostic
  -> caller receives failure status or thrown error
  -> no output row is partially written
```

For deliberate partial processing, return an explicit result such as
`{ status: 'PARTIAL', rejectedRows: [...], warnings: [...] }`; never return plain
`Success` without disclosing omissions.

## 6. Performance, quota, complexity, and memory report

* **API calls:** exactly one Routes API call per invocation is observable in source.
  Total invocation volume, response latency, API limits, and trigger frequency are
  **UNKNOWN**. There is no API call inside a loop.
* **Sheet reads:** header reads plus two TextFinder searches occur per invocation;
  waypoint processing adds 1-3 reads per match (AUD-010). The write function adds a
  header read and ID search.
* **Sheet writes:** 3-4 writes per invocation depending on headers. This is not a
  catastrophic N+1 write loop, but can be reduced safely only after schema validation.
* **Algorithmic complexity:** `selectFinalDestinationAndSort` is O(n log n) for *n*
  destinations; optimization-index reconstruction is O(n). The API call is constant
  per invocation. No O(n²) loop is visible.
* **Memory:** the implementation does not call `getDataRange().getValues()` and stores
  only matched points, which is favorable. Maximum matching rows/waypoints and Routes
  API waypoint limits are **UNKNOWN** and not guarded in source.
* **Quota risk:** spreadsheet RPC risk is **MEDIUM** for shipments with many matched
  rows; URL Fetch and execution-time risk are **MEDIUM** because retry/deadline and
  input-size controls are absent; concurrent execution risk is **HIGH** if invocations
  can overlap (trigger topology is **UNKNOWN**).

**Benchmark:** NOT MEASURABLE FROM STATIC ANALYSIS. No real sheet size, matched-row
distribution, execution logs, or API latency data was supplied; no numeric runtime or
percentage improvement is claimed.

## 7. Data integrity and security report

### Data integrity

* Potential partial output / incorrect success: **confirmed** (AUD-001).
* Wrong route ordering due to invalid distance fallback: **confirmed** (AUD-002).
* Overwrite of unrelated cells/formulas from an unverified 20-column window:
  **confirmed structural risk** (AUD-003); whether affected columns exist is
  **UNKNOWN**.
* Duplicate execution / last-writer-wins: **potential**, dependent on invocation
  concurrency (AUD-004).
* No transactional spreadsheet write exists. A failure between separate `setValue`
  calls can leave partially updated primary fields. This is **confirmed** by the
  multiple writes; practical repair policy is **UNKNOWN**.

### Security

* The Routes API key is read from Script Properties (positive); its restrictions,
  rotation, IAM access, and project configuration are **UNKNOWN**.
* A spreadsheet identifier is hard-coded. This is not treated as a secret in this
  report, but access-control exposure depends on sharing settings, which are
  **UNKNOWN**.
* No `eval`, HTML output, or direct user-supplied URL construction is visible.
* Validate that the Google API key is restricted to the Routes API and appropriate
  caller/project constraints; do not log it or include it in error messages.
* Formula injection is not confirmed: route outputs are generated coordinates/numbers,
  not direct sheet strings. Name values are not written by this code.

## 8. Function inventory and health scores

Scores are static-review estimates, not runtime measurements.

| Function | Correctness | Reliability | Performance | Error handling | Maintainability | Security | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `findOptimalRouteUsingExistingDistance` | 6 | 5 | 6 | 7 | 6 | 7 | 37/60 |
| `prepareWaypointsWithExistingDistance` | 4 | 3 | 4 | 4 | 5 | 7 | 27/60 |
| `selectFinalDestinationAndSort` | 6 | 5 | 8 | 5 | 7 | 8 | 39/60 |
| `executeGoogleMapsRoutesAPIOneWay` | 5 | 4 | 7 | 5 | 6 | 7 | 34/60 |
| `writeResultsToSheet` | 3 | 3 | 6 | 3 | 4 | 7 | 26/60 |

## 9. Safe refactoring plan and recommended architecture

### P0 — immediate

1. Validate exact output schema before calling Routes API; prevent partial-success
   responses (AUD-001).
2. Stop coercing invalid distance to zero; validate coordinates and reject/report
   invalid matched rows (AUD-002, AUD-007).
3. Verify every destination output column before write and make stale-cell clearing an
   explicit policy (AUD-003).
4. Use a single validated write plan where practical and record a recoverable failure
   state for partial writes.

### P1 — reliability

1. Add named-sheet, empty-data, range-bound, and API-response validation.
2. Define idempotency/recalculation policy and concurrency control before adding
   retries (AUD-004).
3. Add bounded retry/backoff only for classified transient failures (AUD-008).
4. Add correlation IDs and safe structured error results.

### P2 — performance

1. Batch/coalesce matched-row reads while preserving row mapping.
2. Group verified contiguous output writes; measure Apps Script execution logs before
   choosing a broader data-read strategy.
3. Add an explicit waypoint/input-size limit based on the approved Routes API
   contract; the permitted maximum is **UNKNOWN** in supplied code.

### P3 — cleanup

1. Centralize header names, destination count, and optional-output policy.
2. Split repository (Sheets), route client (HTTP/API validation), route service
   (ordering/business validation), and controller (entry/error response).

```text
Controller / AppSheet entry
  -> RouteService: validate request, idempotency state, orchestration
     -> ShipmentRepository: schema validation and batch reads
     -> RoutesClient: request, bounded retry, response validation
     -> ResultRepository: validated write plan and status update
```

This separation makes errors attributable, lets the API client be tested with fixtures,
and prevents business code from depending directly on spreadsheet RPC calls.

## 10. Regression protection and test matrix

**What could break when fixing:** strict schema/input validation can reject malformed
legacy rows; a selected idempotency key can suppress an intended recalculation; changing
destination clearing can leave stale values or remove a relied-on cleanup behavior;
batch reads/writes can misalign row-to-value mappings. Confirm the sheet contract and
business policy before deployment.

| Test | Input | Expected | Risk |
| --- | --- | --- | --- |
| Normal | Valid two-stop and multi-stop shipments | Validated result fields written; success only after writes | LOW |
| Empty | Header-only sheets / no shipment match | Controlled no-data error; no API call | MEDIUM |
| Null | Missing sheet, missing header, blank coordinate/distance | Contextual configuration/validation error; no partial output | HIGH |
| Invalid | Out-of-range/malformed coordinate; nonnumeric distance | Rejected row/request reported, never coerced silently | HIGH |
| API 500 | Controlled mock response | Bounded retry then explicit failure; no success write | HIGH |
| API 429 | Controlled mock response | Backoff with jitter and maximum attempts | HIGH |
| API 200 malformed | `{}` / no routes / invalid index fixture | Typed API-response failure | HIGH |
| Duplicate | Same logical request twice | One billed/committed result per idempotency policy | HIGH |
| Concurrent | Two overlapping invocations for same row | No lost update or duplicate API call under chosen policy | HIGH |
| Partial write | Inject failure after first output field | Recoverable failed state; no false success | HIGH |
| Large data | 10k+ source rows and approved maximum matched points | Measured acceptable runtime/quota behavior | HIGH |

No automated tests exist in the supplied repository, so none were executed for this
static audit.

## Final verdict

**PRODUCTION STATUS: 🟠 NOT READY**

The implementation has positive error propagation for thrown exceptions, but confirmed
silent partial success, silent distance coercion affecting route selection, unverified
output-window writes, and missing concurrency/idempotency controls prevent a production
readiness conclusion. Address P0 and validate the sheet/API/trigger contracts, then
execute the test matrix with representative production-scale data before reassessment.
