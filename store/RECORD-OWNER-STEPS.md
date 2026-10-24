# Neat Record — owner steps (Kal)

**Already done:** Stripe product + Payment Link, the licence Worker on
licence.neatextensions.com, Brevo email from keys@neatextensions.com, and the
draft store item. That item was created through the API on 2026-10-24 and has
not been submitted:

- Item ID: **`ilaekohhdchofcpdoohciddphpogghae`**
- Dashboard: https://chrome.google.com/webstore/devconsole/99b0b31c-95fb-47dc-8c7c-3c2dce181945/ilaekohhdchofcpdoohciddphpogghae/edit

Open every link with `npm run open -- <link>` from `C:\Projects\Extension Factory`,
so it opens in the **arcan2252@gmail.com** Chrome profile.

**Part 1 is done** (client `60013913850-g4iv…apps.googleusercontent.com`,
2026-10-24). The final release package `dist\neat-record-1.0.0.zip` is uploaded
to the draft. The licence Worker fix is deployed.

**Left for you:** Part 2 (the store screens). Then press **Submit for review**
on the item, or tell me to submit it.

---

## Part 1 — The Google sign-in client for "Share to Drive"

### Screen 1: turn on the Drive API
1. Open https://console.cloud.google.com/apis/library/drive.googleapis.com?project=neat-extensions
2. Top left must say **neat-extensions**. If it doesn't, click the project name and pick **neat-extensions**.
3. Click **Enable**. If it already says **Manage**, it's on. Go on.

### Screen 2: Branding
1. Open https://console.cloud.google.com/auth/branding?project=neat-extensions
2. Fill in or check:
   - App name: `Neat Record`
   - User support email: `arcan2252@gmail.com`
   - App logo: upload `C:\Projects\Extension Factory\apps\record\icons\icon-128.png` (optional: skip it if it asks for review)
   - Application home page: `https://neatextensions.com/record/help.html`
   - Application privacy policy link: `https://neatextensions.com/record/privacy.html`
   - Authorised domains → **+ Add domain** → `neatextensions.com`
   - Developer contact email: `arcan2252@gmail.com`
3. Click **Save**.

### Screen 3: Data access (the only permission)
1. Open https://console.cloud.google.com/auth/scopes?project=neat-extensions
2. Click **Add or remove scopes**.
3. In the filter box type `drive.file`. Tick the one row
   `.../auth/drive.file`: "See, edit, create and delete only the specific Google Drive files you use with this app".
4. Tick **nothing else**. If any other Drive scope is ticked, untick it.
5. Click **Update**, then **Save**.
   (The `chromewebstore` scope used by our release script may also be listed. Leave it as it is.)

### Screen 4: Audience
1. Open https://console.cloud.google.com/auth/audience?project=neat-extensions
2. If **Publishing status** says **Testing**, click **Publish app**, then **Confirm**.
   - Without this, only test users can press Share, and buyers can't.
   - `drive.file` is a non-sensitive scope, so Google needs no security review.
   - Bonus: the release script's sign-in stops expiring every 7 days.

### Screen 5: Create the client
1. Open https://console.cloud.google.com/auth/clients/create?project=neat-extensions
2. **Application type** → **Chrome Extension**.
3. **Name** → `Neat Record`.
4. **Item ID** → `ilaekohhdchofcpdoohciddphpogghae`
5. Click **Create**.
6. A box shows the **Client ID**, which ends in `.apps.googleusercontent.com`.
   Copy it and **paste it to me in chat**. It isn't secret.
   - If it offers **Verify app ownership**, skip that for now. It needs the item published.

---

## Part 2 — The store screens (after Part 1)

Dashboard for the item:
https://chrome.google.com/webstore/devconsole/99b0b31c-95fb-47dc-8c7c-3c2dce181945/ilaekohhdchofcpdoohciddphpogghae/edit

All files are in `C:\Projects\Extension Factory\store\record\`. Copy long text
from the files, not from this page. Press **Save draft** at the top of each tab.

### Screen 6: Trader information (Account, once for the whole publisher)
1. Open https://chrome.google.com/webstore/devconsole/99b0b31c-95fb-47dc-8c7c-3c2dce181945/account
   (or click **Account** in the left menu).
2. **Trader status** → **I am a trader** (Neat Record sells Pro).
3. Fill in your legal name, address, phone and email.
   - In the EU these are shown on the listing.
   - Use a business address and phone if you have them.
   - Email: `hello@neatextensions.com` (it reaches your Gmail).
4. Click **Save changes**.

### Screen 7: Store listing tab
Click **Store listing** in the left menu.

| Field | Value |
|---|---|
| Title / Summary | Taken from the package. Shows `Neat Record — Screen Recorder, Draw a Box`. Nothing to type. |
| Description | All of `description.txt` (open it in Notepad, Ctrl+A, Ctrl+C, paste) |
| Category | **Productivity**, then **Tools** if it asks for a sub-category |
| Language | **English** |
| Store icon | `icon-128.png` |
| Screenshots, in this order | `screenshots\1-draw-a-box.png`, `2-panel.png`, `3-recording.png`, `4-free-vs-pro.png`, `5-saved-and-shared.png` |
| Small promo tile | `promo-small-440x280.png` |
| Marquee promo tile | `marquee-1400x560.png` |
| Global promo video | leave empty |
| Official URL | none |
| Homepage URL | `https://neatextensions.com/record/help.html` |
| Support URL | `mailto:hello@neatextensions.com`. If the box refuses it, use `https://neatextensions.com/record/help.html`. |
| Mature content | **No** |

Click **Save draft**.

### Screen 8: Privacy tab
Click **Privacy** in the left menu. Every value is in `listing.json`.

1. **Single purpose description**:
   `Record the user's screen — a box drawn on a web page, the whole screen, one window, or the current tab — save the video to the user's computer, and optionally share it through the user's own Google Drive.`
2. **Permission justification**, one box per permission:
   - tabCapture: `Records the current tab (and the part of it inside a drawn box) when the user presses Record.`
   - offscreen: `Runs the recorder (capture, encoding and saving) in an offscreen document, because a service worker cannot record media.`
   - activeTab: `Lets the extension act only on the tab where the user clicked its icon or pressed its shortcut: to record that tab and show the recording controls there.`
   - scripting: `Shows the draw-a-box overlay, the small recording bar, the webcam bubble and the 'saved' card on that same tab, from a file inside the extension. Only after the user clicks; never on its own.`
   - downloads: `Saves the finished video (and trimmed copies or GIFs the user asks for) to the user's Downloads folder.`
   - storage: `Remembers the user's choices (mode, microphone, sound, quality), the ID of the 'Neat' folder in the user's Drive if Share was used, the date the 10-minute note was last shown, and, if bought, the Pro licence key.`
   - identity: `Only for Share (Pro): asks Google, after the user presses Share and clicks Allow, for permission to create files in the user's own Drive (drive.file scope) and uploads that one video.`
   - Host permission: there is none, so no box appears.
3. **Are you using remote code?** → **No, I am not using remote code**.
4. **What user data do you plan to collect?** → tick **Website content** only. Leave every other box unticked.
5. Tick all three certifications:
   - I do not sell or transfer user data to third parties…
   - I do not use or transfer user data for purposes that are unrelated to my item's single purpose
   - I do not use or transfer user data to determine creditworthiness or for lending purposes
6. **Privacy policy URL** → `https://neatextensions.com/record/privacy.html`
7. Click **Save draft**.

### Screen 9: Distribution tab
Click **Distribution** in the left menu.

| Field | Value |
|---|---|
| Payments | **Contains in-app purchases** (Pro is bought on our own Stripe page) |
| Visibility | **Public** |
| Regions | **All regions** |

Click **Save draft**. The final package is already uploaded: when every tab
is saved with no red errors, press **Submit for review** (or tell me to).

---

## Also outstanding (any time, one command each)

- **Deploy the licence Worker fix.** It keeps buyers' keys working if the
  free KV quota runs out, and support now goes by email. In a terminal:
  ```
  cd "C:\Projects\Extension Factory\services\licence-worker"
  npx wrangler deploy
  ```
- **Abuse guard** (Cloudflare free plan allows one rule). Open
  https://dash.cloudflare.com/b86a70406b904bfd1334fdbdffb5808e/neatextensions.com/security/waf/rate-limiting-rules
  - Click **Create rule**. Name: `licence success`.
  - **If**: Hostname equals `licence.neatextensions.com` **and** URI Path equals `/success`.
  - **Rate**: 10 requests per 10 seconds, counted per IP.
  - **Action**: Block for 10 seconds.
  - Click **Deploy**.

## Ongoing

- **Refunds / leaked keys:** tell me the purchase date or the Stripe payment.
  I read the key's `sub` from KV. It goes into `revokedLicences` in
  `apps/record/app.config.js` and stops unlocking with the next release.
- **Deleting a buyer's record** on request: delete that `session:…` key in KV
  (Cloudflare → Workers & Pages → KV → `LICENCES`), or ask me.
