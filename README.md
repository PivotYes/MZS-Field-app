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
  - `ANTHROPIC_API_KEY` (optional): turns on the office write-up button and the tenant AI assistant

## Airtable
Tables `Requests`, `Feedback`, and `Messages`. Field names must match exactly; see `REQ_FIELDS`, `FB_FIELDS`, and `MSG_FIELDS` in server.js.

`Messages` table (tenant <-> office chat):
- `Request`: link to `Requests`
- `From`: single select with options `Tenant`, `Office`
- `Message`: long text
- `Created at`: created time

Tenants can message on open and reopened requests, not finished ones. Workers never see messages.

## Tenant AI assistant
"Ask a question" on the tenant side. It answers the status of the tenant's own requests and simple fix-it tips, and drafts new requests (the tenant taps Yes to send). Questions it can't or shouldn't answer go to the office chat on that request ("Connecting you to the office..."), and the office reply shows in the assistant chat and in My requests. No photos in chat. Rules live in `assistSystem` in server.js. Needs `ANTHROPIC_API_KEY`; hidden if it isn't set.
Workers can open the app's Worker side to see a warning if any field is missing.

## Editing with Claude Code
Only edit `index.html` for screen changes. Field mapping between the app and Airtable lives in `server.js`.
