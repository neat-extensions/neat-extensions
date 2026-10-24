// App config for "Neat Record". Record is a TOOL product, not a rules product:
// no remote rules, no updater, no alarms. Everything here is plain data.
import { BRAND, SITE_URL } from "../../brand.config.js";

const PAGES = `${SITE_URL}record/`;

export default {
  kind: "tool",
  id: "record",
  name: "Record",
  productName: `${BRAND} Record`,
  version: "1.0.0",
  // The public key the Chrome Web Store gave the item (fetchStatus, 2026-10-24; the store refuses a
  // manifest key on a new item, so .secrets/record-extension-key.pem is retired). It pins the same ID
  // in unpacked builds as in the store, which the Google OAuth client is bound to.
  extensionKey:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArk3e0o4LG8pTtis1+3i8o5TQc60X8OZxFMlRTRyNiwsW8Z5aEoYVFlWV4HIl+Yj3CTK37mk2nx2CiBm5A1pUfroHFA8P6sMFsmB1+Tgbk2l5UoLM5lDdXtRo1Hkr2UQuCpjfY69oNKTNvSJBlMHA+fBdcBUpq+BZnJxeokIQk6Y3IedMClBJwWHNNPgiemRW1Q/GPAvePLzk7XNBQOkvwg7iw+qGS63YosiBXQoFs1tVS7nJPkuYp9nAd+Nv0QU89waTtutBpQAMC8Zc3ThCBXGY+GiPC0kGZ1R0yOZhneACpNS8xfV/WbtFlHiiFUnDtQZKKEpyOiBLGjxPZC1ZSwIDAQAB",
  extensionId: "ilaekohhdchofcpdoohciddphpogghae",
  // Google Cloud → APIs & Services → Credentials → OAuth client (type "Chrome Extension",
  // item ID = extensionId). Owner step: store/RECORD-OWNER-STEPS.md. Until it is set,
  // Share to Drive says it is not set up yet; --release refuses the placeholder.
  oauthClientId: "60013913850-g4ivgchfjvt57dgpna8vb95sro5pdh69.apps.googleusercontent.com",
  // Browsers without Chrome's own sign-in (Edge, Brave, …) sign in through a web page instead
  // (chrome.identity.launchWebAuthFlow). That needs a second client, type "Web application", with the
  // redirect URI https://<extensionId>.chromiumapp.org/ — owner step in store/RECORD-OWNER-STEPS.md.
  // While it is a placeholder, Share on those browsers says it works in Chrome for now.
  oauthWebClientId: "OAUTH_WEB_CLIENT_ID.apps.googleusercontent.com",
  driveScope: "https://www.googleapis.com/auth/drive.file",
  // Public half of .secrets/licence-private.jwk (scripts/licence-sign.mjs).
  licencePublicKey: { kty: "EC", crv: "P-256", x: "o4PFK7bPn2hjfql_HtvDGUXXnExckr1gBDav74IWKcU", y: "BfGeyMQjunl63SIfkzdg1EAIg3rUC0uVGzJoORLRqE0" },
  licenceProduct: "record",
  // Subjects ("sub") of refunded or leaked keys; they stop unlocking with the next release.
  revokedLicences: [
    "O3eAY1aQsiU9rc8E", // 2026-10-24 owner's own live $9.99 test purchase
  ],
  // Stripe Payment Link for the $9.99 one-off (scripts/stripe-setup.mjs; redirects to the licence Worker).
  buyUrl: "https://buy.stripe.com/fZucN64JQ335fat9sQ9R600",
  price: "$9.99",
  helpUrl: `${PAGES}help.html`,
  proUrl: `${PAGES}pro.html`,
  privacyUrl: `${PAGES}privacy.html`,
  storeItemId: "ilaekohhdchofcpdoohciddphpogghae",
  command: { id: "toggle-recording", key: "Alt+Shift+R" },
  freeLimitMinutes: 10,
};
