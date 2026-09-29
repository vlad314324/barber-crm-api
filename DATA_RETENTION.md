# Data retention — inventory and proposed policy (BE-17)

Status: **draft, not enforced in code**. No automated deletion runs against any of the data below. This document exists so the product owner can review and approve concrete retention windows; until approved, data is kept indefinitely (current behavior, unchanged).

## Data inventory

| Data | Where | Contains |
|---|---|---|
| Client records | `models/Client.js` (per-tenant DB) | Name, phone, email, notes, appointment history via `Appointment.client` ref |
| Appointment records | `models/Appointment.js` (per-tenant DB) | Client/employee refs, service refs, date/time, price, notes, `clientEmail`/`clientPhone` snapshot for public bookings |
| Employee/staff accounts | `models/Employee.js`, `models/User.js` (per-tenant DB) | Name, phone, email, hashed password, role, hourly rate |
| Reviews | `models/Review.js` (per-tenant DB) | Text, rating, client/employee/appointment refs |
| Notifications | `models/Notification.js` (per-tenant DB) | In-app CRM notification text, timestamps |
| Salon owner/registration | `models/platform/Salon.js`, `models/platform/Invitation.js` (platform DB) | Salon name, owner email, subscription dates, deactivation reason/comments |
| Platform admin accounts | `models/platform/PlatformAdmin.js` (platform DB) | Name, email, hashed password |
| Password reset tokens | `User.resetPasswordToken`/`resetPasswordExpires` fields | Short-lived (existing `expires` field already bounds these) |
| Email delivery | Brevo (third-party processor, HTTP API — see `config/mailer.js`) | Recipient email + message content passes through Brevo's infrastructure per booking confirmation, reminder, password reset, deactivation notice |
| Database hosting | MongoDB Atlas (third-party processor) | All of the above, at rest |
| Application logs | Render (hosting) console/log retention | Error messages; as of this change, reminder-job logs no longer include client email addresses in cleartext (`config/reminderJob.js`) |

## Processors

- **MongoDB Atlas** — primary data store, all models above.
- **Brevo** — transactional email sender (`config/mailer.js`), receives recipient email + message body per send.
- **Render** — application hosting; process stdout/stderr becomes platform logs.
- **Vercel** — frontend hosting; no personal data processed server-side (static assets + client-side API calls to Render).

## Proposed retention windows (pending owner approval — not implemented)

These are engineering defaults for discussion, not a legal determination:

- **Active salon data** (clients, appointments, reviews): retain for the lifetime of the salon's subscription; no automatic deletion while `Salon.isActive === true`.
- **Deactivated salons**: propose a 90-day grace window after `deactivatedAt` before the tenant database becomes eligible for archival/deletion, to allow reactivation or data export requests.
- **Password reset tokens**: already self-expiring (`resetPasswordExpires`), no change needed.
- **Application logs**: follow the hosting provider's (Render) default retention; no PII should appear in log lines going forward — this is enforced ad hoc in code, not centrally, so future log statements should be reviewed for the same concern the `reminderJob.js` fix addressed.

## Explicitly out of scope for this document

- Legal/compliance determination of required retention periods (GDPR-equivalent or otherwise) — requires the product owner and, if applicable, legal counsel.
- Scheduled deletion/anonymization jobs — not built; would need approved windows above before any deletion logic is written, given `BE-07`'s existing rule that deleting a Client/Employee with appointment/review history is currently blocked, not archived.
- Backup retention on the MongoDB Atlas side — an Atlas project/dashboard setting, not application code (see `BE-13`).
