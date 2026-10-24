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
  // Public half of .secrets/record-extension-key.pem (scripts/extension-key.mjs).
  // It pins the extension ID below, which the Google OAuth client is bound to.
  extensionKey:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtXykyZy5tS7+ZuVpSDSLyE0T3DPuj0Ox/u0vcY1Ff2XlEmvWi5MonIPTWb7hN8gCkWNmlzhowWm2xTSNU9Hlv2xI00T5MdeV6dr37PMzJxDa5kFXZm8vxHoYrcWE8hObRNlVkshHKEAxE5MXBR5H8dhEgRfE4Lu1AFzkc0Cdt4BvJdqqj1ry9SIhr+EznH33GkidzKJhIJ3oA6DOhyoYmFZyN5XcUjY9c5UMIko2jqgDcogVETkeQocwf52ivMjsks1ziZ5FpjDdDFBUg/g0QCoFKmkIcwCwy3moEE5t3WViwSUsiSkhglUZS5nKis74tYDdaJlmApnT55q+t8qC+QIDAQAB",
  extensionId: "njbhijplkhmcehhcemjofldcgpbgoopf",
  // Google Cloud → APIs & Services → Credentials → OAuth client (type "Chrome Extension",
  // item ID = extensionId). Owner step: store/RECORD-OWNER-STEPS.md. Until it is set,
  // Share to Drive says it is not set up yet; --release refuses the placeholder.
  oauthClientId: "OAUTH_CLIENT_ID.apps.googleusercontent.com",
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
  storeItemId: null,
  command: { id: "toggle-recording", key: "Alt+Shift+R" },
  freeLimitMinutes: 10,
};
