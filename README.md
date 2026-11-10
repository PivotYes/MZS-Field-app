# MZS Field App

Tenants report problems, workers handle jobs, the office answers tenant messages. Everything saves to Airtable.

## Files
- `index.html`: the app (tenant, worker, and office screens, EN/ES)
- `server.js`: serves the app and talks to Airtable (no outside packages)
- `package.json`: tells Render how to start it

## Render settings (Web Service)
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `AIRTABLE_TOKEN`: Airtable personal access token (scopes: data.records:read, data.records:write, schema.bases:read)
  - `AIRTABLE_BASE_ID`: starts with `app`
  - `WORKER_PIN`: code workers type to open the Worker side
  - `OFFICE_PIN`: code the office types to open the Office side (tenant messages). Use a different code from `WORKER_PIN`.
  - `ANTHROPIC_API_KEY` (optional): turns on the office write-up button
  - `WORKERS` (optional): names for the schedule lanes, comma separated. Default `Worker 1,Worker 2,Worker 3`

## Airtable
Tables `Requests`, `Feedback`, and `Messages`. Field names must match exactly; see `REQ_FIELDS`, `FB_FIELDS`, and `MSG_FIELDS` in server.js.

`Messages` table (tenant <-> office chat):
- `Request`: link to `Requests`
- `From`: single select with options `Tenant`, `Office`
- `Message`: long text
- `Created at`: created time

`Requests` also needs these 3 fields for the office schedule:
- `Assigned to`: single line text (holds a name from `WORKERS`)
- `Visit start`: single line text (24-hour time like `09:30`)
- `Visit length`: number (minutes)

## Office schedule
Office > Schedule shows one lane per worker for the chosen day (7 AM to 7 PM).
- Drag a request from "Not scheduled yet" onto a lane. It snaps to 15 minutes.
- Drag a visit to another lane or time to move it. Drag it back to the list to take it off.
- Tap a request or visit (or "Set time") to type in the worker, date, start time, and length.
- Every card shows the tenant's best time. While dragging, that part of the day lights up green. A visit outside it shows a warning.
- Placing a request sets its status to Scheduled. Tenants and workers see the exact time.

Tenants can message on open and reopened requests, not finished ones. Workers never see messages.
Workers can open the app's Worker side to see a warning if any field is missing.

## Editing with Claude Code
Only edit `index.html` for screen changes. Field mapping between the app and Airtable lives in `server.js`.
