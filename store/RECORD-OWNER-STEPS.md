# Neat Record — owner steps (Kal)

Everything below is a one-time setup only you can do (accounts, money, legal).
Nothing has been uploaded to the Chrome Web Store. The build is ready:
`dist\neat-record-1.0.0.zip` (store package) and `dist\record\` (unpacked).

**Order matters.** Do A (trader + VAT) before any upload. B–E can be done in
any order; send me the values marked **→ send me**.

---

## A. Before ANY upload: trader status and VAT (must come first)

Neat Record sells something (Pro), so in the EU you are a **trader**.

1. Chrome Web Store Developer Dashboard (https://chrome.google.com/webstore/devconsole), signed in as **arcan2252@gmail.com**.
2. Left menu → **Account**.
3. **Trader / non-trader declaration** → choose **Trader**. Fill in: legal name, address, email, phone (these become public on the listing in the EU — use a business address/phone if you have one). → **Save**.
   - The YouTube item is free; the declaration is per publisher, so it applies to it too. That's fine.
4. **VAT**: you are selling a digital service to consumers. Before the first sale:
   - In Stripe (step B) turn on **Stripe Tax** (Settings → Tax → Get started) and add your registrations, *or* register yourself for VAT OSS / your country's scheme.
   - Where you are based decides the rules (for example, sellers outside the EU selling digital services to EU consumers use the EU **non-Union OSS** from the first sale). Ask an accountant if unsure — I can't decide this for you.
5. Don't upload `neat-record-1.0.0.zip` until 3 and 4 are done.

## B. Stripe: the $9.99 product and the Payment Link

1. https://dashboard.stripe.com → create an account (or sign in). Finish **Activate payments** (business details, bank account).
2. **Product catalog** → **+ Add product**:
   - Name: `Neat Record Pro`
   - Description: `Lifetime Pro licence for the Neat Record Chrome extension. Up to 3 of your own computers.`
   - Pricing: **One-off**, **9.99 USD** (add EUR/GBP prices if you like). Tax behaviour: **Inclusive** (if Stripe Tax is on).
   - **Save product**. Open the price → copy its id `price_…` → **send me**.
3. **Payment Links** → **+ New**:
   - Product: Neat Record Pro, quantity fixed at 1.
   - **After payment** tab → **Don't show confirmation page** → **Redirect customers to your website** →
     `https://neat-licence.<your-subdomain>.workers.dev/success?session_id={CHECKOUT_SESSION_ID}`
     (exactly like that, braces included; the subdomain comes from step C).
   - Options: **Collect customers' email addresses** = on (it's on by default).
   - Payment methods: Settings → Payment methods → keep **Cards**, turn on **Apple Pay**, **Google Pay** (and **PayPal** if offered in your country).
   - **Create link** → copy `https://buy.stripe.com/…` → **send me** (it goes in `apps/record/app.config.js → buyUrl`).
4. **Developers** → **API keys** → **+ Create restricted key**: name `neat-licence`, permission **Checkout Sessions: Read**, everything else None → **Create** → copy `rk_live_…` (only for step C, never send it to anyone, including me).

## C. Cloudflare: the licence Worker (free plan)

1. https://dash.cloudflare.com/sign-up → create a free account → verify email.
2. **Workers & Pages** → it asks for a `*.workers.dev` subdomain → pick one (e.g. `neat`) → this gives `neat-licence.neat.workers.dev`.
3. On this computer, in `C:\Projects\Extension Factory\services\licence-worker\`:
   ```
   npx wrangler login
   npx wrangler kv namespace create LICENCES
   ```
   Copy the printed `id` into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`). Put the Stripe price id from B2 into `STRIPE_PRICE_ID`.
4. Secrets (each command asks you to paste the value):
   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put LICENCE_PRIVATE_JWK
   ```
   - `STRIPE_SECRET_KEY` = the restricted `rk_live_…` key from B4.
   - `LICENCE_PRIVATE_JWK` = the whole content of `C:\Projects\Extension Factory\.secrets\licence-private.jwk` (open in Notepad, Ctrl+A, Ctrl+C). Backup: `Documents\Neat-keys\licence-private.jwk`.
5. Email the key to buyers (optional but recommended). Cloudflare's own email sending only reaches arbitrary addresses on the paid Workers plan, so the Worker uses **Brevo**'s free tier (300 emails/day):
   - https://www.brevo.com → sign up (free) → **Senders, domains & dedicated IPs** → **Senders** → **Add a sender** → your address (e.g. arcan2252@gmail.com) → confirm the email they send.
   - **SMTP & API** → **API keys** → **Generate a new API key** → copy.
   - `npx wrangler secret put BREVO_API_KEY` → paste. Put the sender address in `wrangler.toml → MAIL_FROM`.
   - Without Brevo the key is still shown on the success page (and the page tells buyers to copy it).
6. `npx wrangler deploy` → it prints `https://neat-licence.<subdomain>.workers.dev` → **send me** the address, and use it in B3.
7. Test with Stripe **test mode**: make a test Payment Link the same way (redirect to the same Worker), pay with card `4242 4242 4242 4242`, any future date, any CVC → you land on the success page with a key. (Use test-mode keys `rk_test_…`/`price_…` for this run, then switch the secrets to live.)

## D. First draft upload, then the OAuth client for Share to Drive

The OAuth client must be bound to the **store's** item ID, and a new item gets
its ID from the store on its first upload (the store zip carries no `key`). So:

1. Dashboard → **+ New item** → upload `dist\neat-record-1.0.0-not-for-upload.zip`
   (the current build). **Do not submit it.** It's only to get the ID.
2. Copy the 32-letter **item ID** (in the URL and under the name) → **send me**.
3. **Package** tab → **View public key** → copy the whole key → **send me**.
   I put it in `apps/record/app.config.js → extensionKey` (it replaces the one I
   generated), so the unpacked build and the store build have the same ID from
   now on.
4. https://console.cloud.google.com → project picker → **neat-extensions**.
5. ☰ → **APIs & Services** → **Library** → search **Google Drive API** → **Enable**.
6. **Google Auth Platform** (APIs & Services → OAuth consent screen) → **Branding**:
   app name `Neat Record`, support email, logo (`apps\record\icons\icon-128.png`), home page
   `https://neat-extensions.github.io/neat-extensions/record/help.html`, privacy policy
   `https://neat-extensions.github.io/neat-extensions/record/privacy.html`, authorised domain
   `neat-extensions.github.io` → **Save**. (The pages go live when I push them.)
7. **Data access** → **Add or remove scopes** → tick `.../auth/drive.file` ("See, edit, create and
   delete only the specific Google Drive files you use with this app") → **Update** → **Save**.
   Google lists `drive.file` as **non-sensitive**: no security assessment, only the light brand check.
8. **Audience** → **Publish app** (In production), so any Google user can press Share.
9. **Clients** → **+ Create client** → type **Chrome Extension** → name `Neat Record` →
   **Item ID** = the store item ID from step 2 → **Create** → copy the **Client ID**
   (`…apps.googleusercontent.com`) → **send me**.

## E. When A–D are done

1. Send me: Stripe price id, Payment Link URL, Worker URL, store item ID + public key, OAuth client id. I put them in `apps/record/app.config.js` and `wrangler.toml`, run `npm run build -- record --release` (it refuses placeholders and missing pages) and `npm run store -- record`, and commit. That build writes `dist\neat-record-1.0.0.zip`.
2. In the draft item from D1: **Package** → upload `dist\neat-record-1.0.0.zip`, then follow `store/record/SUBMISSION.md`.
3. In the item's **Privacy** tab answer exactly what `store/record/listing.json` says.

## F. Ongoing

- **Abuse guard** (once, after C): Cloudflare dashboard → your domain-less account → **Security** → **WAF** → **Rate limiting rules** (free plan allows one) → *If* URI path equals `/success` → *rate* 20 requests per 10 seconds per IP → *action* Block for 10 seconds. (If your plan shows no WAF for `workers.dev`, skip: the Worker also caches unknown ids itself.)
- **Refunds / leaked keys:** in Cloudflare → **Workers & Pages** → **KV** → `LICENCES` → find `session:<Checkout Session id>` (from the Stripe payment) → copy its `sub` → send it to me; it goes into `revokedLicences` in `apps/record/app.config.js` and stops unlocking with the next release.
- **Deleting a buyer's record** on request: delete that `session:…` key in KV.
