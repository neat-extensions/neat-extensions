# Chrome Web Store submission checklist — Neat — Hide YouTube Shorts 1.0.0

Fill in the Developer Dashboard (https://chrome.google.com/webstore/devconsole),
signed in as **arcan2252@gmail.com**, publisher **Neat**. Paths are relative to
`C:\Projects\Extension Factory\`. Every value below is copied from
`store/listing.json` / `store/*.txt`; for long text, copy from the file named,
not from this page, so the text is byte-exact.

Save draft on every tab. **Do not press "Submit for review"** until you've
reviewed every tab.

---

## 0. Create the item

| Step | Value |
|---|---|
| Button | **+ New item** (top right) |
| Upload | `dist\neat-youtube-1.0.0.zip` (54,472 bytes, sha256 `7f0336d2b9b1653ddff7e45752f0b66beee96fcbc358651950f5b0514446f2e7`) |
| Record | The 32-letter **item ID**: it's in the URL (`…/devconsole/<publisher-id>/<ITEM_ID>/edit`) and under the item name. **Send me this ID.** |

The dashboard reads name, version 1.0.0 and permissions from the zip's manifest:
name `Neat — Hide YouTube Shorts`, permissions `storage`, `alarms`, host
`https://www.youtube.com/*`. If it shows anything else, stop.

---

## 1. Store listing tab

### Product details

| Field | Value |
|---|---|
| Title | Pre-filled from the manifest: `Neat — Hide YouTube Shorts` (`store/title.txt`, 26 chars) |
| Summary | Pre-filled from the manifest. Must read exactly: `Hide YouTube Shorts everywhere — Home, search, subscriptions, channels, sidebar — and open Shorts links as normal videos.` (`store/summary.txt`, 121 chars) |
| Description | Paste the whole of **`store/description.txt`** (open it, Ctrl+A, Ctrl+C). It starts `Shorts gone. YouTube back to videos.` and ends `Neat is not affiliated with or endorsed by YouTube or Google.` — keep the blank lines and the `•` bullets. |
| Category | **Productivity** (CWS may show it as *Productivity → Tools / Workflow & planning*; pick *Tools* if a sub-category is required) |
| Language | **English** (English (United States) if a variant is required) |

### Graphic assets

| Field | File | Size |
|---|---|---|
| Store icon | `apps\youtube\icons\icon-128.png` | 128×128 |
| Global promo video | leave empty | — |
| Screenshot 1 | `store\screenshots\1-before-after.png` | 1280×800 |
| Screenshot 2 | `store\screenshots\2-popup.png` | 1280×800 |
| Screenshot 3 | `store\screenshots\3-options.png` | 1280×800 |
| Small promo tile | `store\promo-small-440x280.png` | 440×280 |
| Marquee promo tile | `store\marquee-1400x560.png` | 1400×560 |

Upload screenshots in that order (drag to reorder if needed: 1 → 2 → 3).

### Additional fields

| Field | Value |
|---|---|
| Official URL | **None** (requires a Search Console–verified domain; github.io isn't yours to verify) |
| Homepage URL | `https://neat-extensions.github.io/neat-extensions/` |
| Support URL | `https://neat-extensions.github.io/neat-extensions/` |
| Mature content | **No** |

→ **Save draft.**

---

## 2. Privacy tab (Privacy practices)

| Field | Value |
|---|---|
| Single purpose description | `Hide YouTube Shorts and other distracting parts of YouTube that the user chooses.` |
| Justification — `storage` | `Saves the user's on/off choices, allow list and the latest hiding rules on this device.` |
| Justification — `alarms` | `Checks once a day for updated hiding rules so the extension keeps working when YouTube changes its layout.` |
| Justification — host permission (`https://www.youtube.com/*`) | `Needed to hide elements on YouTube pages. The extension runs on no other site.` |
| Are you using remote code? | **No, I am not using Remote code** |
| Remote code justification (if a box is still shown) | `No. The extension downloads a JSON rules file containing only CSS selectors and labels; it is strictly validated and never executed.` |

### Data usage

| Field | Value |
|---|---|
| "What user data do you plan to collect…" | Tick **nothing** (no personally identifiable info, health, financial, authentication, personal communications, location, web history, user activity or website content). Our answer: *Collects no user data.* |
| Certification 1 | ☑ I do not sell or transfer user data to third parties, outside of the approved use cases |
| Certification 2 | ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose |
| Certification 3 | ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes |
| Privacy policy URL | `https://neat-extensions.github.io/neat-extensions/privacy.html` |

→ **Save draft.**

---

## 3. Distribution tab

| Field | Value |
|---|---|
| Payments / pricing | **Free** (no in-app purchases). If the tab has no pricing control, nothing to do — the store only lists free items now. |
| Visibility | **Public** |
| Distribution (regions) | **All regions** |

→ **Save draft.**

---

## 4. Account tab (once per publisher)

Contact email set and **verified**; publisher name **Neat**. Without a verified
contact email, Submit stays disabled.

---

## 5. Before you press Submit

- [ ] Every tab shows no red errors; "Why can't I submit?" (if shown) lists nothing.
- [ ] Store listing preview: title, summary, three screenshots in order, promo tiles.
- [ ] Privacy URL opens: https://neat-extensions.github.io/neat-extensions/privacy.html
- [ ] Item ID sent to Claude.

Optional on submit: *Defer publish* (publish manually after approval) lets you
check the live listing before it's public.

## After you send me the item ID

I set `EXTENSION_ID` in `scripts/store.mjs`, run `npm run store -- --no-shots`
and `npm run rules:publish` (the landing page's disabled "coming soon" button
becomes a real "Add to Chrome" link), then commit and push.

Note: the store page `chromewebstore.google.com/detail/<ID>` only exists once
the item is approved and published. Until then the landing-page button would
lead to a "not found" page, so the cleanest moment to set the ID is after
approval. Tell me which you prefer when you send it.
