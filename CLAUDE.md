# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

BarberCRM API — an Express + MongoDB backend for a barbershop booking/CRM system. Plain JavaScript (CommonJS), no TypeScript, no test suite.

## Commands

- `npm run dev` — start the server with nodemon (auto-restart on file change)
- `node server.js` — start the server directly
- There is no lint or test command configured (`npm test` is a placeholder that exits with an error). Do not assume Jest/Mocha are set up.

The server requires a `.env` file with `MONGO_URI`, `JWT_SECRET`, `EMAIL_USER`, `BREVO_API_KEY`, and optionally `PORT` (defaults to 5000).

## Architecture

Standard Express layout with no service/controller layer — route handlers talk directly to Mongoose models:

- `server.js` — app entrypoint. Registers all `/api/*` routers, initializes the DB connection and the cron reminder job at startup.
- `config/db.js` — Mongoose connection (`connectDB`), called once from `server.js`.
- `config/mailer.js` — sends all outbound email via the Brevo HTTP API (`BREVO_API_KEY`), not SMTP — Render's free tier blocks outbound SMTP ports, so a nodemailer/SMTP transporter can't reach any mail server from production. Exports `sendBookingConfirmation`, `sendEmployeeBookingNotification`, `sendReminder`, `sendPasswordResetEmail`, `sendSalonDeactivatedEmail`. Email failures are caught and logged, not thrown (e.g. booking still succeeds if email fails).
- `config/reminderJob.js` — `node-cron` job (`startReminderJob`) that ticks every 15 minutes, finds `Scheduled` appointments falling into the "exactly 24h before start" window (per-salon timezone via `utils/timezone.js`), and sends one reminder per appointment via `sendReminder` from `config/mailer.js` (tracked with `Appointment.reminderSent` to avoid duplicates).
- `models/` — Mongoose schemas: `User` (auth, bcrypt password hashing via `pre('save')` hook + `comparePassword`), `Client`, `Employee`, `Service`, `Appointment`, `Review`, `Settings` (singleton doc holding shop info + per-day `workingHours` map).
- `routes/` — one router per resource, mounted in `server.js` under `/api/<resource>`. Handlers are inline async functions with try/catch; errors return `500` with either plain text or `{ msg }` JSON depending on the route (inconsistent — check the specific file before assuming a response shape).
- `middleware/verifyToken.js` — exists but is an empty file and is not required/used anywhere. There is currently no auth middleware enforcing JWT checks on any route; `authRoutes.js` issues and verifies tokens inline (`GET /me`) but no other route checks `Authorization` headers.

### Key cross-file flows

- **Booking flow** (`routes/bookingRoutes.js`): reads `Settings.workingHours` (keyed by lowercase day name, e.g. `monday`) to compute open hours for a date, generates 30-minute slots, subtracts slots already covered by existing non-cancelled `Appointment`s for that employee/date, then on `POST /` upserts a `Client` by phone, creates the `Appointment`, and fires a confirmation email.
- **Reviews** (`routes/reviewRoutes.js`): creating or deleting a `Review` recomputes and writes the average `rating`/`reviewCount` back onto the referenced `Employee` document — there's no incremental update, it re-aggregates all reviews for that employee each time.
- **Analytics** (`routes/analyticsRoutes.js`): three independent endpoints computed on the fly from `Appointment` data (no caching/precomputation):
  - `/dashboard` — revenue/appointment totals, month-over-month change, 12-month revenue series, top services, per-employee performance.
  - `/forecast` — per-weekday forecast combining a simple moving average and least-squares linear regression (`alpha = 0.4` blend) over the trailing 4 weeks, plus a trailing-window MAE estimate.
  - `/rfm` — Recency/Frequency/Monetary client segmentation (percentile-ranked scores 1–5, segments like Champions/Loyal/At Risk/Lost).
- **Settings** is a singleton collection — routes call `Settings.findOne()` and lazily `Settings.create({})` if no document exists yet, rather than seeding one on startup.

### Conventions to be aware of

- Many user-facing strings (error messages, email templates) are in Ukrainian; keep new user-facing text consistent with the existing language unless told otherwise.
- No global error-handling middleware — every route handler has its own try/catch.
- No input validation layer (no Joi/Zod/express-validator) — validation is ad hoc per route (e.g. manual required-field checks in `bookingRoutes.js`).
