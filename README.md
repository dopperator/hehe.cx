# hehe.cx

A link-in-bio platform: sign up, claim `hehe.cx/<username>`, and build a profile page with your social links, a custom background (gradient, image or video), background music and badges. This is the code behind [hehe.cx](https://hehe.cx).

## Features

- Email-verified signup and login (6-character codes, sent over SMTP)
- Profile editor with live phone preview: avatar, bio, gradient/image/video backgrounds, 19 link platforms with URL validation, drag-to-reorder links
- Background music from YouTube, Spotify, SoundCloud or an uploaded file (premium), with start/end times and click-to-enter
- Badges that admins create and grant; users pick one to show next to their name
- Premium flag with larger uploads, GIF avatars/backgrounds and video backgrounds (payments aren't wired up)
- Admin panel with email-code login: user search, profile edits, deactivation, premium, badges, and full or view-only maintenance mode
- Uploaded media is served through a `/media` proxy so storage URLs stay hidden

## Stack

Node.js + Express, PostgreSQL in production or SQLite for local development, and Supabase Storage for uploads (or the local `uploads/` folder when Supabase isn't configured). The frontend is plain HTML/CSS/JS in `public/`.

## Running it

```bash
npm install
cp .env.example .env   # fill in what you need
npm start              # http://localhost:3000
```

With an empty `.env` it runs locally on SQLite (`hehecx.db`) with uploads on disk, and verification codes are printed to the console instead of emailed. For production, set `DATABASE_URL` (Postgres), `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`, the `EMAIL_*` SMTP settings, `SESSION_SECRET` and `NODE_ENV=production`. The server refuses to start in production without `SESSION_SECRET`, and it expects to sit behind a reverse proxy that terminates HTTPS.

## Admin access

The account with user ID 1 (the first signup) is made an admin at every startup. The admin panel lives at `/admin-panel-for-the-lolz`; logging in takes the account password plus a code sent by email. The code is also written to the server log as a fallback, so treat server logs as sensitive.

## Notes

- Contact links in the pages point to `support@example.com`; change them to your own address.
- Sessions use express-session's in-memory store, so a restart logs everyone out and it won't scale past one process.
- `scripts/give-premium.js` and `scripts/remove-premium.js` toggle premium on the local SQLite database.

## License

MIT
