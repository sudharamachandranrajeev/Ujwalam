# 2026-11-12 — Growth section setup notes (YouTube statistics, Instagram insights)

For AN1 (plan `2026-11-11-growth-content-instagram-plan.md`, decision D371). These are the one-time steps on your own
Google and Meta accounts. Ujwalam never does them for you, and nothing here posts or changes anything: both
permissions are read only. Keys and tokens stay in Windows Credential Manager; nothing goes into a file.

## YouTube (built)

You already have a Google Cloud project with an OAuth client for uploads (P16b). The same project and client are used.

1. Open Google Cloud Console and pick the project you made for Ujwalam uploads.
2. **Turn on the YouTube Analytics API.** APIs & Services > Library > search "YouTube Analytics API" > Enable.
   (The "YouTube Data API v3" is already on from the upload setup; it is also needed.)
3. **Add the permissions to the app.** Google Auth Platform > Data Access > Add or remove scopes. Tick:
   - `https://www.googleapis.com/auth/yt-analytics.readonly` (read your channel's statistics)
   - `https://www.googleapis.com/auth/youtube.readonly` (read each video's public state and counts; it may already be
     there from scheduled posting)
   Save. While the app is in "Testing" with you as its test user, Google does not need to review these scopes
   (UNVERIFIED for a published app).
4. **Switch on the flag** `growth` (Settings > Advanced, or the control page's flag list).
5. **Sign in again**, so the stored sign-in carries the new permission:
   `node services/posting/cli.mjs youtube signin` (or Settings > Connections > YouTube). Google's consent page now lists
   "See YouTube Analytics reports for your YouTube content". Tick every box and allow.
   The new sign-in replaces the old one; uploads keep working.
6. **Read the numbers:** `node services/analytics/cli.mjs fetch`, then `node services/analytics/cli.mjs show`.
   A video gets numbers once it is public. YouTube fills the statistics (watch time, average viewed %, shares,
   subscribers) a day or two late; views and likes come at once.

If step 6 says "reading statistics is not allowed yet", step 3 or 5 was missed: add the scope, then sign in again.

## YouTube upload quota: use about 6 a day, then ask Google for more (D375, 2026-11-13)

Automatic posting (Settings > Posting & growth > Auto-post) uploads at most as many clips a day as the YouTube Data
API quota allows. With the default quota of 10,000 units a day, about 6 uploads fit: each upload is counted as 1,600
units plus 50 for its thumbnail, and 100 units stay free for reading the channel's schedule and the upload status.
The card shows "About N uploads a day fit in the quota" and sets "Uploads at most" to that number at first.

Google's quota page (fetched 2026-11-13) says uploads now have their own count of 100 a day. If your project's
Quotas page shows that, uploads no longer use the 10,000 units and more fit; this is UNVERIFIED for your project, so
the card keeps the safe count until you check.

To ask Google for more (one time; Google decides, it can take days or weeks; the menu and form names below are
UNVERIFIED, Google renames them now and then):

1. Open Google Cloud Console and pick the project you made for Ujwalam uploads.
2. APIs & Services > Enabled APIs & services > YouTube Data API v3 > **Quotas & System Limits**. Note the "Queries
   per day" limit and how much you use.
3. Open the quota extension form: on that page use **Edit quota** / **Apply for higher quota**, or go to the YouTube
   API Services audit and quota extension form (linked from Google's "Quota and Compliance Audits" help page).
4. Fill it in: the project number (Cloud Console home), your channel, what the app does ("uploads my own game clips
   from my own PC to my own channel as scheduled posts, about N a day"), and the daily units you ask for (for example
   30,000 for about 18 uploads a day). Google may ask for a screen recording of the upload flow and to check the app
   against the YouTube API Services Terms; answer from your own account only.
5. When Google grants the new number: Settings > Posting & growth > Auto-post > **YouTube quota**, type the new daily
   units, click Save. The card then shows how many uploads fit; raise "Uploads at most" if you want more a day.

Nothing in Ujwalam sends this form or changes the Cloud project for you.

## Instagram (not built yet; for a later AN1 step)

Instagram insights come through the Instagram Graph API, which needs a Creator or Business account linked to a Facebook
Page. You have a Creator account (2026-11-11). Steps (UNVERIFIED in detail; Meta changes these screens often):

1. In the Instagram app: make sure the Creator account is linked to a Facebook Page you manage
   (Settings > Account Center, or the Page's linked accounts).
2. Go to developers.facebook.com, sign in, and create an app (type "Business"; use case to read Instagram insights).
3. Add the product "Instagram" (Instagram API with Facebook Login).
4. Request the permissions `instagram_basic`, `instagram_manage_insights`, `pages_show_list` and
   `pages_read_engagement`. In development mode, as the app's admin, you can use them on your own account without
   App Review (UNVERIFIED).
5. Note the App ID and App Secret. When the Instagram step is built, Ujwalam will ask for them once and keep them in
   Windows Credential Manager, then open Meta's sign-in in your browser.

Tell me when you want the Instagram step built; until then nothing is needed on Meta's side.
