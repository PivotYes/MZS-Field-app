# MZS Field App

Tenants report problems, workers handle jobs. Everything saves to Airtable.

## Files
- `index.html`: the app (tenant + worker screens, EN/ES)
- `server.js`: serves the app and talks to Airtable (no outside packages)
- `package.json`: tells Render how to start it

## Render settings (Web Service)
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `AIRTABLE_TOKEN`: Airtable personal access token (scopes: data.records:read, data.records:write, schema.bases:read)
  - `AIRTABLE_BASE_ID`: starts with `app`
  - `WORKER_PIN`: code workers type to open the Worker side
  - `ANTHROPIC_API_KEY` (optional): turns on the office write-up button

## Airtable
Tables `Requests` and `Feedback`. Field names must match exactly; see `REQ_FIELDS` and `FB_FIELDS` in server.js.
Workers can open the app's Worker side to see a warning if any field is missing.

## Editing with Claude Code
Only edit `index.html` for screen changes. Field mapping between the app and Airtable lives in `server.js`.
