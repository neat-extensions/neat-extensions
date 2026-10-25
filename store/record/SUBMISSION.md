# Chrome Web Store submission checklist — Neat Record 1.0.2

**The draft item exists (created through the API). Owner steps: `store/RECORD-OWNER-STEPS.md`.**
Dashboard: https://chrome.google.com/webstore/devconsole, signed in as
**arcan2252@gmail.com**, publisher **Neat**. Paths are relative to
`C:\Projects\Extension Factory\`. Copy long text from the files named, not from
this page, so it's byte-exact. Save draft on every tab; don't press "Submit for
review" until every tab is checked.

## 0. Before uploading

- [ ] `apps/record/app.config.js` has the real `oauthClientId` and `buyUrl` (not placeholders).
- [ ] `npm run build -- record --release` passes (it refuses placeholders) and wrote `dist\neat-record-1.0.2.zip`.
- [ ] `npm run store -- record` regenerated `store/record/` and `docs/record/`; pushed, so the privacy page is live.
- [ ] https://neatextensions.com/record/privacy.html opens.

## 1. Upload the release package

| Step | Value |
|---|---|
| Upload | the draft item already exists: open it → **Package** → upload `dist\neat-record-1.0.2.zip` (only a `--release` build has this name) |
| Check | Name `Neat Record — Screen Recorder, Draw a Box`; permissions activeTab, downloads, identity, offscreen, scripting, storage, tabCapture; **no** site access. Anything else: stop. |
| Check | The item ID equals `extensionId` in `apps/record/app.config.js` (set from the store after the draft upload). If not: stop. |

## 2. Store listing

| Field | Value |
|---|---|
| Title | from manifest (`store/record/title.txt`, 41 chars) |
| Summary | from manifest (`store/record/summary.txt`) |
| Description | all of `store/record/description.txt` |
| Category | **Productivity** (sub-category *Tools* if asked) |
| Language | English |
| Store icon | `store/record/icon-128.png` |
| Screenshots (in order) | `store/record/screenshots/1-draw-a-box.png`, `2-panel.png`, `3-recording.png`, `4-free-vs-pro.png`, `5-saved-and-shared.png` (all 1280×800) |
| Small promo tile | `store/record/promo-small-440x280.png` |
| Marquee | `store/record/marquee-1400x560.png` |
| Official URL | none |
| Homepage URL | `https://neatextensions.com/record/help.html` |
| Support URL | `mailto:hello@neatextensions.com` (if the field refuses mailto, use `https://neatextensions.com/record/help.html`) |
| Mature content | No |

## 3. Privacy tab

Copy each value from `store/record/listing.json`:

- [ ] Single purpose → `singlePurpose`
- [ ] One justification per permission → `permissionJustifications` (tabCapture, offscreen, activeTab, scripting, downloads, storage, identity). Host permissions: none.
- [ ] Remote code → **No** (`remoteCode`)
- [ ] Data usage: tick **Website content** only (Share uploads the one chosen video to the user's own Drive; the developer never receives it). Leave every other type unticked. Tick the three certifications.
- [ ] Privacy policy URL → `https://neatextensions.com/record/privacy.html`

## 4. Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Payments | **Contains in-app purchases** (Pro is sold on our own Stripe page) |

## 5. Before Submit

- [ ] No red errors on any tab.
- [ ] Preview: five screenshots in order, promo tile, marquee.
- [ ] Trader declaration shows (EU listing).
- [ ] Optional: tick **Defer publish** to check the live listing before it goes public.
