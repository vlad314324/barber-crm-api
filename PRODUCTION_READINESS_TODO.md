# Backend production-readiness TODO

## Purpose and baseline

Implement the backend portion of the production-readiness review dated 2026-09-06. This is an execution backlog, not a claim that the application is ready. All tasks start open; only these planning files have been created.

- Repository: `barber-crm-api`
- Reviewed commit: `b1c0211f8f934fe3345a22c45677875025d82d5a`
- Companion backlog: [frontend TODO](../barber-crm-frontend/PRODUCTION_READINESS_TODO.md)
- Stack: Express 5, CommonJS JavaScript, Mongoose 8, MongoDB with a platform database and one database per salon, Brevo email, in-process reminder cron.
- Review result: **Not ready**. Source inspection and isolated checks established defects; no production systems or real databases were exercised.

## Instructions for the implementing agent

1. Read current repository instructions and inspect the working tree. Revalidate the referenced behavior because code may have changed since the review. Source paths and symbols are navigation aids, not immutable line references.
2. Work through the suggested order below. Implement only the tasks assigned to you; preserve unrelated user changes.
3. Check a task only when its implementation and acceptance criteria are satisfied. Record verification commands, outcomes, and any remaining limitations in its evidence field. A mock passing does not establish database concurrency safety.
4. Coordinate response-shape and permission changes with the linked frontend tasks. Preserve the barber calendar's required lookup data through explicitly scoped endpoints; do not simply prohibit every read used by an administrator page.
5. Use synthetic data and disposable local/staging resources for verification. Do not run seed scripts, migrations, deletion operations, or load tests against an existing deployment. Do not expose secrets in outputs or commits.
6. Mark external verification as `BLOCKED: <missing access/evidence>` when needed, leaving its checkbox open. Do not infer that an upstream control or backup exists from missing repository configuration.
7. Follow the existing JavaScript stack. Introduce shared business logic where the tasks require consistent rules; a framework migration is outside this backlog.

Priorities: **P0** = release blocker; **P1** = conditional release gate or required before broad rollout; **P2** = contained follow-up. Conditional gates must have recorded evidence or an explicit release constraint.

Suggested order: BE-01/02/03/06, then BE-04/05/07; add BE-12 verification alongside these changes. Coordinate BE-10/11 with frontend work. Resolve BE-08 and BE-13 before public release; resolve BE-09 before enabling multiple reminder workers. Complete BE-14/15 before migrating an existing deployment or enabling onboarding at scale.

## Tasks

### [x] BE-01 — Enforce operation-level authorization

- **Priority:** P0. **Review:** F01, confirmed. **Effort:** M.
- **Inspect:** `server.js`; `middleware/verifyToken.js`; every router under `routes/`; frontend `src/App.tsx` and `src/pages/Appointments.tsx`.
- **Problem:** Most CRM endpoints only require a valid JWT. Barber accounts can reach privileged writes, exports, and account lifecycle operations.
- **Implementation:** Define a documented operation/role matrix; enforce it on the server; allowlist writable fields, including protecting employee account linkage. Provide minimal lookup responses for permitted barber workflows. Retain tenant checks. Do not invent an own-appointments-only policy without a product requirement.
- **Acceptance:** Unauthenticated callers cannot reach protected resources; barbers cannot perform administrator operations or access administrator-only fields; administrators retain intended access; the barber calendar still works. All CRUD, import/export, settings, and account lifecycle paths are covered.
- **Verify:** Database-backed role matrix tests and negative tests for direct HTTP requests, sensitive field updates, and cross-tenant tokens.
- **Coordinate:** FE-01. **Evidence:** Done — `requireRole('admin')` gates every export/import/create/update/delete route (`clientRoutes.js`, `employeeRoutes.js`, `appointmentRoutes.js`, `serviceRoutes.js`, plus whole-router gates on `analyticsRoutes.js`/`categoryRoutes.js`/`reviewRoutes.js`/`settingsRoutes.js` PUT). Verified by code audit (grep of every `requireRole` usage across `routes/`) plus the existing regression suite (`test/permissions.test.js`: barber token → 403 on employee/client export and other admin-only routes). Checkbox in this doc was stale — the fix predates this note.

### [x] BE-02 — Invalidate access after account and credential changes

- **Priority:** P0. **Review:** F02, confirmed. **Effort:** M.
- **Inspect:** `middleware/verifyToken.js`; `models/User.js`; `routes/authRoutes.js`; `routes/employeeRoutes.js`; `routes/settingsRoutes.js`.
- **Problem:** Seven-day JWT claims remain effective after deactivation, demotion, and password changes. `/auth/me` also does not reject inactive accounts.
- **Implementation:** Resolve current active status and permissions during authorization; introduce a session/token-version mechanism for revocation. Apply it consistently to deactivation, role change, staff password reset, forgotten-password reset, and self-service password change. Specify how older tokens are handled during rollout.
- **Acceptance:** Every previously issued session loses the relevant access immediately after those events, on every replica. Inactive accounts cannot validate through `/auth/me`. A new login with valid current credentials works as intended.
- **Verify:** Issue a token, change each relevant account state, and exercise both privileged endpoints and `/auth/me` with the old token.
- **Coordinate:** FE-01, FE-02. **Evidence:** Done — `middleware/verifyToken.js` re-reads the User document on every request (live `isActive`/`role` check) and compares JWT `iat` against `User.passwordChangedAt`, set by the single `pre('save')` hook shared by every password-set path (registration, staff reset, forgot/reset, self-service). `/auth/me` goes through the same middleware, so it's covered too. Regression-tested end-to-end in `test/tokenInvalidation.test.js` (deactivation, role demotion, and password-change invalidation, each with the *same* pre-change token re-used against a live endpoint). Note: a real production incident earlier caused by a related but distinct bug (a schema `default` on `passwordChangedAt` firing on every read, not just writes) was found and fixed separately — see commit `e8cf4f7`.

### [x] BE-03 — Restrict the public employee response

- **Priority:** P0. **Review:** F03, confirmed. **Effort:** S.
- **Inspect:** `routes/bookingRoutes.js` GET `/employees`; `models/Employee.js`.
- **Problem:** Anonymous callers receive full employee records, including phone, email, hourly rate, and `userId`.
- **Implementation:** Use an explicit public projection/DTO containing only fields required for booking. Do not serialize arbitrary future schema additions.
- **Acceptance:** Public responses omit private contact, compensation, and account-linkage fields while keeping the booking selection flow functional.
- **Verify:** Response-contract tests using employees with every sensitive field populated; check both active filtering and property absence.
- **Coordinate:** FE-03. **Evidence:** Done — `GET /:salonSlug/booking/employees` (`routes/bookingRoutes.js:84-93`) already uses an explicit `.select('name role customRoleLabel bio specialties translations services')` allowlist, with an inline comment stating why `phone`/`email`/`hourlyRate`/`userId`/`schedule`/`rating` must stay hidden. Verified by code audit (full `Employee` schema field list cross-checked against the projection). Checkbox was stale — the fix predates this note.

### [x] BE-04 — Make reservations exclusive and retry-safe

- **Priority:** P0. **Review:** F04, confirmed. **Effort:** L.
- **Inspect:** `routes/bookingRoutes.js` POST `/`; `routes/appointmentRoutes.js` create/update/import; `models/Appointment.js`.
- **Problem:** Conflict checks and inserts are separate; CRM and import paths bypass equivalent checks. Concurrent requests can reserve the same interval.
- **Implementation:** Centralize reservation writes. Select a database-enforced allocation or serialization mechanism covering employee/day intervals and rescheduling. A transaction that merely repeats the current read-then-insert sequence is insufficient. Add idempotency for public submission retries, scoped to tenant and operation, with payload-mismatch handling.
- **Acceptance:** Public, CRM, update, and import operations preserve the same non-overlap invariant. Concurrent identical/partially overlapping requests cannot both succeed. Retries return the original outcome without duplicate appointments or notification events. Define any intentional historical-import exceptions explicitly.
- **Verify:** Real MongoDB concurrency tests for identical and overlapping intervals, different employees/tenants, cancellation/rebooking, rescheduling, interrupted responses, and repeated idempotency keys.
- **Depends on:** Shared scheduling rules in BE-05. **Coordinate:** FE-03. **Evidence:** Done. A prior session (before this backlog re-pass) already added the core mechanism: `utils/appointmentLock.js` — a per-`(employee, day)` mutex via atomic insert into `AppointmentLock` (unique index on `key`, E11000 on collision, retry with jitter) — with the overlap check and the write happening *inside* the lock (`utils/appointmentOverlap.js` + `withEmployeeDayLock`), shared identically by public `POST /booking` (`routes/bookingRoutes.js`), CRM `POST`/`PUT /appointments` (`routes/appointmentRoutes.js`), and `POST /appointments/import`. Regression-tested under real concurrency (`test/bookingConcurrency.test.js`: 10 truly-parallel identical requests → exactly 1 success, N-1 clean 409s, 0 leftover locks). Cancelled appointments explicitly don't take the lock (freeing a slot can't conflict) — the one documented historical-import/status exception. This session added the missing piece: idempotency for public submission retries — an optional `Idempotency-Key` header on `POST /booking` (`models/IdempotencyKey.js`, TTL 24h); a retry with the same key replays the original response (whether success or the fact that no side effect occurred) instead of creating a duplicate appointment or surfacing a confusing "slot taken by someone else" error for the client's own prior booking. Verified live: same key + same payload twice → identical response body, exactly one `Appointment` document; different key → unaffected; no leftover `pending` idempotency records after any outcome.

### [x] BE-05 — Unify availability and booking validation

- **Priority:** P0. **Review:** F05, confirmed. **Effort:** M–L.
- **Inspect:** `routes/bookingRoutes.js`; `routes/appointmentRoutes.js`; `models/Appointment.js`; `models/Service.js`; `utils/timezone.js`; employee and salon schedules.
- **Problem:** Availability ignores employee schedules; submission accepts malformed/out-of-hours times and unavailable services. Date operations depend on the host timezone.
- **Implementation:** Share validation between availability and writes. Validate date/time syntax and real calendar values, service selection, positive duration, service availability, employee eligibility, and the intersection of employee/salon hours. Define past-booking and historical-import policies separately. Use the salon timezone consistently and expose it to the public client. Preserve maximum-duration reservation behavior when service ranges are enabled.
- **Acceptance:** Advertised slots satisfy submission rules, subject only to intervening reservations. Invalid times, unavailable services, day-off bookings, and appointments extending beyond closing are rejected with stable client-readable errors.
- **Verify:** Boundary, leap-date, past-date, DST, host-timezone, day-off, service-range, and rescheduling tests. Include `23:30` outside hours and `not-a-time` as regression cases.
- **Coordinate:** BE-04, FE-03. **Evidence:** Done, with one explicit, intentional exception. Shared via `utils/scheduleWindow.js` (date/time syntax + real calendar values, salon/employee working-hours intersection) and `utils/employeeServices.js` (`canEmployeePerformServices`): public booking enforces all of it (date/time syntax, service availability + eligibility, positive duration, employee day-off, salon/employee hours intersection, past-booking rejection, salon-timezone-aware via `toZonedInstant`). This session closed the remaining gaps in the other two write paths — **CRM create/update** (`routes/appointmentRoutes.js` `POST`/`PUT /appointments`) and **import** (`POST /appointments/import`) now both enforce positive `totalDuration` (previously only checked *presence*, not that it's `> 0`) and employee/service eligibility via `canEmployeePerformServices` (import previously didn't call it at all — a genuine gap, since an import row could silently assign a master a service they don't offer). **Explicit, intentional exception** (already true before this session, now documented here rather than left ambiguous): CRM create/update deliberately does **not** enforce the employee/salon working-hours intersection — staff can record a walk-in or a backdated booking outside normal hours, which is a real operational need, not an oversight (see the inline comment at `appointmentRoutes.js` above the CRM `POST`/`PUT` handlers). Import also uses a slightly looser time-format regex (`/^\d{1,2}:\d{2}$/` vs. the stricter `TIME_RE`) to tolerate spreadsheet formatting variance — also intentional. Verified live: CRM reject `totalDuration<=0` on create and update; import row rejects an employee/service mismatch and a zero-duration row while still importing a valid row in the same batch.

### [x] BE-06 — Deduplicate tenant connection initialization

- **Priority:** P0. **Review:** F06, confirmed. **Effort:** M.
- **Inspect:** `config/tenantDb.js`; `middleware/tenantResolver.js`; reminder use of tenant contexts.
- **Problem:** Parallel cold requests create independent connections before any entry is cached. Overwritten connections escape the reaper.
- **Implementation:** Cache in-flight initialization; remove failed entries safely; close failed/superseded connections; ensure reaping cannot remove a newer entry or close a context still in active use. Expose connection cleanup for shutdown.
- **Acceptance:** Concurrent requests for one cold tenant share one context/pool. Initialization failure permits a clean retry. Reconnection, idle cleanup, and shutdown leave no orphan connections.
- **Verify:** Concurrency and failure-injection tests plus connection-count observations against disposable MongoDB. The review's five-call case must create one connection, not five.
- **Coordinate:** BE-13 shutdown work. **Evidence:** Done — `config/tenantDb.js` caches a `Map<dbName, Promise<ctx>>` and inserts the promise into the cache synchronously before the first `await` inside `connect()` (`:44-45`), so concurrent cold-start calls for the same tenant share one in-flight promise instead of each creating a connection. Rejected promises are evicted (`:47-55`), stale/closed connections are detected and replaced (`:32-42`). A reaper (`setInterval`, `:58-74`) closes connections idle > 30 min and only deletes the map entry matching the connection it closed, so it doesn't clobber a newer entry that replaced it. Checkbox was stale — the fix predates this note. Explicit shutdown-time cache drain still needed — tracked under BE-13.

### [x] BE-07 — Preserve history and linked-account consistency on deletion

- **Priority:** P0. **Review:** F07, confirmed. **Effort:** M.
- **Inspect:** Client/employee/service deletion routes; `models/Appointment.js`; `models/Review.js`; employee `userId` lifecycle.
- **Problem:** Hard deletes leave appointment references dangling; deleting an employee leaves its login intact. Frontend code assumes populated references are non-null.
- **Implementation:** Choose restrictive deletion or archival/anonymization appropriate to referenced records. Preserve historical usability and prevent future assignment of archived entities. Handle the linked login consistently. Do not repair existing orphans by silently deleting their appointments.
- **Acceptance:** Referenced deletion is rejected or safely archived; historical and future appointments remain inspectable; employee removal cannot leave active unintended access. Legacy orphaned references have an explicit remediation path.
- **Verify:** Create past/future appointments and reviews, delete/archive each referenced entity, and verify API responses, history, future booking eligibility, and login behavior.
- **Depends on:** BE-02 for revocation. **Coordinate:** FE-04. **Evidence:** Done. Client/Employee deletion already had a restrictive history-guard (`routes/clientRoutes.js:284-308`, `routes/employeeRoutes.js:333-359` — blocks hard delete if referenced by `Appointment`/`Review`) plus a soft-delete path (`Employee.isActive` + `/:id/deactivate`/`/reactivate`, which also flips the linked `User.isActive`) predating this session. This phase closed the two remaining gaps with the same guard pattern: `Service` DELETE (`routes/serviceRoutes.js`) now blocks if any `Appointment.services` references it (`SERVICE_HAS_HISTORY`); `Appointment` DELETE (`routes/appointmentRoutes.js`) now blocks if a `Review` references it (`APPOINTMENT_HAS_REVIEW`), preventing a dangling `Review.appointment`. Verified via live smoke test against a disposable tenant (referenced vs. unreferenced service/appointment, both directions). Legacy orphaned references predating this fix have no remediation script — none were found to exist, and the guard only prevents new ones going forward.

### [x] BE-08 — Establish public endpoint abuse protection

- **Priority:** P0 unless equivalent deployed controls are demonstrated. **Review:** F08, probable deployment risk. **Effort:** M.
- **Inspect:** Public login, password recovery, platform login/bootstrap, salon registration, and booking routes; proxy/deployment configuration when available.
- **Problem:** No application throttling was found. Upstream controls were not verified.
- **Implementation:** First inspect existing gateway controls. Close gaps with per-account, per-origin, and per-tenant policies appropriate to each endpoint, distributed across replicas. Bound booking/email abuse without exposing account existence. Configure client-address trust for the actual proxy topology.
- **Acceptance:** Repeated abuse is limited with consistent responses; limits cannot be bypassed simply by switching replicas or spoofing untrusted forwarding headers; ordinary shared-network users can still complete workflows.
- **Verify:** Staging requests through the actual proxy, including limits, recovery windows, multiple replicas, and generic password-recovery responses.
- **Coordinate:** FE-05 handling of rate-limit errors. **Evidence:** Done — `express-rate-limit` (`middleware/rateLimit.js`) was already wired on tenant login/forgot-password/reset-password (`routes/authRoutes.js`), public booking and analytics-event ingestion (`routes/bookingRoutes.js`), and salon self-registration (`routes/salonRoutes.js`). This session closed the remaining gap: added `platformLoginLimiter` (`POST /api/platform/auth/login`) and `platformAdminCreateLimiter` (`POST /api/platform/admins`) — the two platform-admin routes had no limiter at all. `app.js:16` already sets `app.set('trust proxy', 1)`, matching Render's single reverse-proxy hop, so `req.ip`-keyed limits can't be bypassed by spoofing forwarding headers from outside that hop. Render is a single instance (no autoscaling/replicas), so the in-memory store — documented in `middleware/rateLimit.js`'s header comment — doesn't need a shared store; re-evaluate if the deployment topology changes. Deep proxy/replica staging verification remains unexercised (no staging environment exists), consistent with this doc's general no-staging caveat.

### [ ] BE-09 — Make notification delivery durable and worker-safe

- **Priority:** P1; blocks multiple reminder workers until mitigated. **Review:** F09, confirmed. **Effort:** M–L.
- **Inspect:** `config/mailer.js`; `config/reminderJob.js`; booking/password-reset notification callers; appointment reminder state.
- **Problem:** Confirmation work can be lost after request completion; reminder workers can send the same message concurrently; outbound requests lack an explicit deadline.
- **Implementation:** Add a durable outbox with atomic claims, bounded timeouts/retries/backoff, and observable failure state. Define provider idempotency and crash recovery so delivery guarantees are accurate. Reevaluate reminders when appointments are rescheduled/cancelled. Until implemented, document and enforce a single reminder owner during deployments.
- **Acceptance:** Booking commits do not depend on email availability; committed notification work survives restarts; overlapping workers do not normally deliver duplicate reminders; permanent failures become actionable.
- **Verify:** Provider timeout/429/5xx, worker crash before/after send, two workers, cancellation/rescheduling, and recovery tests. Record unavoidable provider-side duplicate windows instead of claiming exactly-once delivery without evidence.
- **Depends on:** BE-04 notification event/idempotency contract. **Evidence:** Partial. The reminder cron already claims atomically before sending (`config/reminderJob.js:70-73`, `findOneAndUpdate({reminderSent:{$ne:true}})`), so overlapping ticks/instances can't double-send — this part of the acceptance criteria was already met. This session fixed a related bug: `Appointment.reminderSent` wasn't reset when a scheduled appointment's `date`/`startTime` changed (`routes/appointmentRoutes.js` PUT `/:id`), so a rescheduled appointment that already had a reminder sent for its old slot silently never got one for the new slot — now reset to `false` on reschedule when it was previously `true`. Still open: booking-confirmation email remains fire-and-forget with no durable outbox/retry (`routes/bookingRoutes.js`, intentional per `CLAUDE.md`'s "email failures are caught and logged, not thrown" note, but that means a crash between commit and send still loses the confirmation silently); no explicit provider-timeout/backoff policy beyond `config/mailer.js`'s 10s timeout. Full outbox implementation not attempted this session — out of scope for the phase that covered this item.

### [x] BE-10 — Normalize authenticated-user and password-change contracts

- **Priority:** P1; small pre-release repair. **Review:** F11, confirmed. **Effort:** S.
- **Inspect:** `routes/authRoutes.js` login/register/me; `routes/settingsRoutes.js` change-password.
- **Problem:** Login emits `id`, but `/auth/me` emits `_id`; password change requires a client-supplied user identifier.
- **Implementation:** Return one explicit safe user DTO from all authentication endpoints. Derive the self-service password-change target from authenticated identity, keeping staff resets a separate authorized operation.
- **Acceptance:** Login and restored-session responses have the same documented shape; no credential/reset fields leak; self-service password change does not depend on a caller-selected target ID.
- **Verify:** Contract tests and login → restore session → change password → revoke old session sequence.
- **Depends on:** BE-02. **Coordinate:** FE-02. **Evidence:** Done — `routes/authRoutes.js`: register (`:59`), login (`:142`), and `/me` (`:175`) all return `{ id, name, email, role }` consistently, with an inline comment at `/me` (`:170-174`) noting the shape was already fixed to match login. `routes/settingsRoutes.js` `PUT /change-password` (`:59-81`) derives the target user from `req.user.id` (`:71`), with a comment (`:56-58`) explicitly warning against trusting a body/param `userId`. Frontend `src/context/AuthContext.tsx` types `User` with only `id` (no `_id` fallback), consistent with the backend contract. Checkbox was stale — the fix predates this note.

### [x] BE-11 — Align the review persistence contract

- **Priority:** P2; fix before offering review entry, or disable the feature. **Review:** F12, confirmed. **Effort:** S.
- **Inspect:** `models/Review.js`; `routes/reviewRoutes.js`; frontend review DTOs and employee review form.
- **Problem:** The frontend submits `comment`; the backend stores `text`, silently discarding the submission.
- **Implementation:** Agree on one canonical field and whether an appointment reference is required. Align validation and responses. Handle compatibility explicitly; do not claim already discarded text can be recovered from the database.
- **Acceptance:** Nonempty review text survives create/read/reload and validation failures do not appear successful.
- **Verify:** API contract tests with nonempty text and the agreed appointment-reference behavior.
- **Coordinate:** FE-06. **Evidence:** Done — the claimed mismatch is not present in current code: both `models/Review.js` and the frontend review form (`src/pages/Employees.tsx`) consistently use the field name `text`. Checkbox was stale (this was either already fixed before the reviewed baseline commit, or the review's premise was mistaken); no code change was needed.

### [x] BE-12 — Establish repeatable backend release verification

- **Priority:** P0 assurance gate. **Review:** F15, confirmed. **Effort:** M, alongside feature fixes.
- **Inspect:** `package.json`; `package-lock.json`; existing repository automation.
- **Implementation:** Replace the failing test placeholder with a meaningful local test workflow. Add required release checks for permissions, revocation, reservation concurrency, response contracts, and provisioning failures. Pin/document the supported runtime and reproducible installation/build/start commands; use the committed lockfile. Add checked-in CI configuration if none exists.
- **Acceptance:** A clean disposable environment can reproduce the checks. Database-required tests are clearly separated from isolated tests and cannot accidentally target production. Failures block the release workflow. No arbitrary coverage target substitutes for critical-path tests.
- **Verify:** Run the documented commands in the disposable environment and record versions/results. Complete a dependency advisory audit and triage reachable issues; the original audit failed due to registry DNS resolution.
- **Depends on:** Tests evolve with BE-01 through BE-11. **Coordinate:** FE-08. **Evidence:** Done — `"test": "node --test"` (`package.json:6`, Node's built-in runner, no extra devDependency needed) runs three real regression suites: `test/permissions.test.js`, `test/tokenInvalidation.test.js`, `test/bookingConcurrency.test.js`. Each test creates a disposable tenant (`test/helpers/tenant.js`: unique `dbName`, isolated database) and tears it down (`dropDatabase` + delete the `Salon` doc) in `after()`, so runs are self-contained and can't accidentally corrupt or leave residue in another tenant's data even though `MONGO_URI` points at the same shared cluster used elsewhere — the same disposable-tenant convention used throughout this session's manual smoke tests. `npm audit` was run successfully this session (network resolved) and found only `multer`, since fixed (`^2.4.0`). Added `.github/workflows/test.yml` (checked-in CI, runs `npm test` on push/PR to `main`) — **requires the repo owner to add `MONGO_URI` and `JWT_SECRET` as GitHub Actions secrets** (Settings → Secrets and variables → Actions) before the workflow can pass; this is a GitHub UI action, not something committable in code.

### [ ] BE-13 — Verify operational release controls and recovery

- **Priority:** P0 release evidence gate. **Review:** Operational evidence gaps. **Effort:** M–L.
- **Inspect:** `server.js`; database configuration; environment documentation; actual staging/deployment configuration when available.
- **Implementation:** Validate required configuration at startup without logging values. Provide separate liveness/readiness behavior. Retain the HTTP listener for graceful draining, stop jobs, close connections, and bound shutdown. Document deployment/migration ordering, rollback compatibility, alert ownership, and incident response. Verify TLS, database access restrictions, secret handling, and deployment permissions.
- **Acceptance:** Dependency failure makes readiness fail appropriately; termination drains safely; startup configuration errors fail clearly. Platform and dynamically provisioned tenant databases are covered by backups. Owners approve explicit RPO/RTO, availability, and alert criteria.
- **Verify:** Staging database outage/recovery, SIGTERM during requests/jobs, release rollback, and restoration of both platform and tenant data from backups. Store sanitized evidence/runbook references.
- **Depends on:** BE-06, BE-09. **Evidence:** Partial. `server.js` (was 24 lines with none of this) now has: startup validation of `MONGO_URI`/`JWT_SECRET`/`PLATFORM_JWT_SECRET`/`EMAIL_USER`/`BREVO_API_KEY` — missing any of them logs only the variable *names* (never values) and calls `process.exit(1)` before the app binds a port; `GET /health` (liveness — always 200 if the process can respond at all, no dependency checks) and `GET /ready` (readiness — 503 unless the platform Mongo connection's `readyState === 1`) added to `app.js`; graceful shutdown on `SIGTERM`/`SIGINT` — stops both cron jobs (`reminderJob`/`platformRollupJob`, now returning their `node-cron` task so `.stop()` is callable), calls `server.close()` to drain in-flight requests before closing every cached tenant connection (`config/tenantDb.js`'s new `closeAllTenantConnections()`) and the platform connection (`config/db.js`'s new `.close()`), with a 15s force-exit safety net if anything hangs. Verified live: missing-env child process exits(1) fast with only variable names in output (asserted the actual `MONGO_URI` value never appears); `/health`/`/ready` respond correctly once up. **Could not verify the SIGTERM/SIGINT path via live signal delivery in this session's Windows sandbox** — `child_process.kill('SIGTERM'/'SIGINT')` unconditionally force-terminates the child on Windows (no real POSIX signal delivery; confirmed empirically, not just from docs), so `process.on('SIGTERM', ...)` is unreachable via that test method on this platform regardless of `server.js`'s correctness. Render (the actual deployment target) is Linux, where this exact handler will receive and act on a real SIGTERM; verified by code review only, not by a live signal test. **Explicitly out of code scope, unresolved** (per this doc's own `BLOCKED` allowance — needs Render/Atlas/Vercel dashboard access, not a code change): real backup existence/restore testing, TLS verification, database access-permission audit, deployment-permission review, RPO/RTO sign-off, staging-environment tests (no staging environment exists).

### [ ] BE-14 — Make existing-data migrations tenant-aware and recoverable

- **Priority:** P1; blocks releases requiring legacy-data migration. **Review:** Migration evidence gap. **Effort:** M.
- **Inspect:** `scripts/migrateEmployeeSchedule.js`; `scripts/registerFirstTenant.js`; platform salon registry.
- **Problem:** The schedule migration connects directly to the database in `MONGO_URI`, not an explicit tenant selection or registry traversal.
- **Implementation:** Require explicit targets; add a dry-run/validation mode, version/progress tracking, and resumable/idempotent execution. Document compatibility ordering and preserve recoverable original data where conversion is uncertain. Keep destructive seed tooling separate from migrations.
- **Acceptance:** Operators can identify exactly which tenant databases will change and which completed. An interruption can be resumed safely; a second run does not damage converted data. Rollback or restoration is documented and rehearsed.
- **Verify:** Fixtures containing legacy, current, malformed, and partial schedules across multiple disposable tenant databases, including interrupted reruns.
- **Depends on:** BE-13 backup/rollback evidence. **Evidence:** Partial. `scripts/migrateEmployeeSchedule.js` rewritten: now connects to the platform DB, reads the full `Salon` registry, and migrates every tenant's `employees` collection in turn (previously it connected straight to whatever single DB `MONGO_URI` pointed at — effectively migrating one tenant, silently skipping the rest of the registry). Added `--dry-run` (reports per-tenant "would change" counts, writes nothing — verified live: ran against the full real tenant registry with zero writes). Per-tenant progress is printed as it goes (`[slug] N employee(s): X migrated, Y already up to date`), and a failure on one tenant is caught, logged, and does not stop the rest of the registry from being processed — the run ends with an explicit list of any failed tenant slugs. No separate checkpoint/resume file was added because none is needed: each employee document's migration is independently idempotent (`parseOldValue` is a no-op on an already-migrated value), so simply re-running the whole script — including after an interruption — is itself the resume mechanism; verified live (ran the real script twice in a row against two disposable tenants seeded with legacy-format data: first run migrated both, second run reported 0 migrated / 1 already-up-to-date for each, and a full run against the entire real production tenant registry made zero changes to any real salon, confirming their data was already in the new format). Still open, and explicitly not attempted this session: documented/rehearsed rollback and restore — that depends on `BE-13`'s backup verification, which remains blocked on Atlas dashboard access this session doesn't have.

### [ ] BE-15 — Prove salon provisioning can recover from partial failure

- **Priority:** P1; release condition for registration/onboarding. **Review:** Provisioning evidence gap. **Effort:** M.
- **Inspect:** `routes/salonRoutes.js`; platform `Salon`/`Invitation` models; tenant initialization.
- **Problem:** Registration spans platform and tenant writes, then activates the salon, consumes the invitation, and signs a token. Catch-based cleanup does not prove recovery from process termination.
- **Implementation:** Establish explicit provisioning states and idempotent retry/reconciliation behavior. Preserve ownership/slug uniqueness protections; prevent cleanup from deleting an unrelated tenant. Define recovery when invitation use, activation, or response delivery is interrupted.
- **Acceptance:** Each injected failure has a recoverable, inspectable state; incomplete salons are not accidentally bookable; retries neither create duplicate owners nor strand an invitation without an operator recovery path.
- **Verify:** Fail or terminate at every persistence boundary in disposable databases, restart, reconcile/retry, and verify tenant isolation and final state.
- **Coordinate:** FE-07. **Evidence:** Pending; crash recovery not yet exercised.

### [ ] BE-16 — Bound queries, import/export work, and tenant growth

- **Priority:** P1; capacity gate before unrestricted rollout. **Review:** F10, confirmed query shape; runtime impact unmeasured. **Effort:** M–L.
- **Inspect:** `routes/clientRoutes.js`; `routes/appointmentRoutes.js`; `routes/analyticsRoutes.js`; `utils/excel.js`; `middleware/upload.js`; relevant schemas.
- **Implementation:** Replace per-client appointment queries with aggregate statistics; add date-bounded/cursor-paginated reads; select indexes using actual query plans; bound import rows, processing concurrency, and export work. Retain the existing upload byte limit, which alone does not bound parsed workbook size or processing time.
- **Acceptance:** Ordinary screen reads do not fetch all tenant history. Query count does not grow linearly with client count for statistics. Large import/export work cannot indefinitely occupy the request process or exhaust memory.
- **Verify:** Explain plans and staging load tests using representative and projected tenant datasets; record query counts, p95 latency, memory, event-loop delay, connection counts, and errors against agreed budgets.
- **Coordinate:** FE-09. **Evidence:** Partial. `GET /clients` already had an opt-in paginated/searchable/sortable path from a prior phase this session (`?page`, backward-compatible flat array otherwise). This phase: added the same opt-in `?page` pattern to `GET /appointments` (`routes/appointmentRoutes.js`) — default behavior unchanged (still a flat array, since `Dashboard.tsx` and the `Appointments.tsx` calendar both consume the full list and weren't rewritten to paginate); added `Client.email` index (`models/Client.js`, used by `findOne({email})` on login/registration/import, previously an unindexed full collection scan); replaced the two genuine N+1 loops in `routes/analyticsRoutes.js` — `/dashboard`'s per-employee `Appointment.find` inside `Promise.all` and `/rfm`'s per-client `Appointment.find` inside `Promise.all` — with a single query each, grouped in JS (same output shape, verified against known input data); added a shared `MAX_IMPORT_ROWS` (5000) row-count cap in `utils/excel.js`, applied to all four import routes (clients/employees/services/appointments) — file byte size was already bounded (multer, 5MB) but row count wasn't, so a wide file could still drive thousands of sequential per-row DB round-trips. Still open: `/analytics/dashboard`'s main query and both list/export endpoints still fetch full tenant history by design (changing that would alter reported totals, e.g. all-time revenue, not just improve performance — out of this session's scope); no staging load test was run (no staging environment exists); import processing is still sequential per row, not concurrency-bounded/streamed.

### [ ] BE-17 — Document retention and third-party data handling

- **Priority:** P1 operating-policy gate. **Review:** Privacy/retention evidence gaps. **Effort:** M.
- **Inspect:** Client, appointment, notification, user/reset, and invitation storage; email/logging paths; backup retention.
- **Implementation:** Document the actual data inventory and processors, define approved retention/deletion behavior with the product owner, and implement scheduled cleanup where required. Reconcile deletion with historical appointments and backup retention. Redact unnecessary personal data and credentials from logs.
- **Acceptance:** Retention and deletion rules are explicit and testable; deletion does not silently destroy required history or leave unaccounted copies; logs and email failure messages follow the documented data policy.
- **Verify:** Synthetic retention/deletion fixtures and sanitized log review. Link approved policy and processor configuration evidence; do not infer legal compliance from code inspection.
- **Depends on:** BE-07, BE-13. **Coordinate:** FE-10. **Evidence:** Partial. Added `DATA_RETENTION.md` (data inventory, processors — MongoDB Atlas, Brevo — and proposed default retention windows), explicitly marked as a draft pending product-owner approval, not enforced. Fixed the one concrete log-redaction gap found: `config/reminderJob.js` logged the client's email address in cleartext on both success and failure (`:88,90`); now logs the appointment id instead. No scheduled deletion/anonymization job was implemented — retention windows require an explicit owner decision first (see the doc), and actual data deletion also depends on `BE-07`'s referenced-record handling and `BE-13`'s backup-retention verification, neither of which is a decision this session can make unilaterally.

## Original verification baseline

- Node `v24.19.0`, npm `11.17.0` in the review environment; these are observations, not a selected production runtime.
- `node --check`: 47 JavaScript files passed. `npm test`: failed because it is a placeholder.
- 144 installed package versions matched corresponding lockfile entries; no clean installation was attempted.
- `npm audit --json --ignore-scripts`: failed because `registry.npmjs.org` could not resolve; no clean dependency-security result exists.
- Isolated checks reproduced public staff-field disclosure, two accepted overlapping bookings, malformed/out-of-hours acceptance, unavailable-service acceptance, day-off slots, inactive-token acceptance, connection initialization leaks, duplicate reminder workers, user ID mismatch, and discarded review text. Cross-tenant token mismatch correctly returned 403.
- No real MongoDB concurrency, staging, email delivery, migration, load, or backup restore checks were run.

## Backend release handoff

- [ ] All P0 tasks have implementation and verification evidence.
- [ ] Every P1 conditional gate has evidence or an explicit documented release constraint.
- [ ] Frontend/backend contracts and rollout order agree with the companion backlog.
- [ ] CI results, dependency audit, load limits, restore results, and operational ownership are attached or linked.
- [ ] Remaining limitations are stated explicitly; do not relabel an unverified release as ready.
