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

`Requests` also needs a `Priority` field: single select with options `Urgent`, `High`, `Medium`, `Low`. Add it before deploying, or sending requests will fail. The `Urgent` checkbox stays in sync with it.

`Requests` also needs these 3 fields for the office schedule:
- `Assigned to`: single line text (holds a name from `WORKERS`)
- `Visit start`: single line text (24-hour time like `09:30`)
- `Visit length`: number (minutes)

## Office schedule
Office tabs go Schedule, Open, Finished. Schedule opens first. Open requests show when each one is scheduled, or "Not scheduled yet."

Office > Schedule shows one lane per worker for the chosen day (7 AM to 7 PM).
- Drag a request from "Not scheduled yet" onto a lane. It snaps to 15 minutes.
- Drag a visit to another lane or time to move it. Drag it back to the list to take it off.
- Tap a request or visit (or "Set time") to type in the worker, date, start time, and length.
- Every card shows the tenant's best time. While dragging, that part of the day lights up green. A visit outside it shows a warning.
- While dragging, a dotted box shows exactly where and how long the visit will land.
- Placing a request sets its status to Scheduled. Workers see the exact time. Tenants see a 1-hour arrival window ("Tech arrives between 9:30 AM and 10:30 AM"); change `ARRIVE_WIN` in index.html to adjust.

## Office: New request
The green "+ New request" bar stays at the top of every Office screen. It opens the same form tenants use. Phone is optional here. The request lands in "Not scheduled yet" on the schedule. If a phone is entered, the tenant can see it under "My requests".

## Worker tabs
Worker side has a tab for All plus one per worker (names from `WORKERS`). A worker's tab shows only jobs assigned to them, in visit order. The phone remembers the last tab picked. On a worker's tab, they can switch between List and Calendar. Calendar shows that worker's day (7 AM to 7 PM) like the office schedule; tap a visit to open the job. Finished visits show faded with a ✓.

Tenants can message on open and reopened requests, not finished ones. Workers never see messages.
Workers can open the app's Worker side to see a warning if any field is missing.

## Editing with Claude Code
Only edit `index.html` for screen changes. Field mapping between the app and Airtable lives in `server.js`.

## Priority
Tenants and the office pick Urgent, High, Medium, or Low when sending a request. It defaults to Medium, and switches to Urgent for No heat or Leak unless they already picked one. Lists sort by priority.
