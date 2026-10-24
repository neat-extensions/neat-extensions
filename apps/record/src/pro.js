// The Pro page inside the extension: what Pro adds, the Buy button, and the
// place to paste a licence key. Keys are checked here, offline, and kept in
// chrome.storage.sync so the user's other computers signed in to Chrome unlock too.
import app from "../app.config.js";
import { licencePublicKey } from "./lib/format.js";
import { BRAND } from "../../../brand.config.js";
import { verifyLicence, cleanLicenceInput } from "../../../packages/engine/src/licence.js";
import { icon, h } from "./lib/ui.js";
import { FREE, PRO, TERMS } from "./lib/compare.js";

const LICENCE_KEY = licencePublicKey(app);

const $ = (id) => document.getElementById(id);
const REASONS = {
  format: "That doesn't look like a whole key. Copy all of it and paste again.",
  signature: "That key isn't valid. Check you copied all of it.",
  product: `That key is for a different ${BRAND} product.`,
  version: "That key is from an older format. Open an issue at github.com/neat-extensions/neat-extensions and we'll swap it.",
  revoked: "That key has been switched off (refunded or shared publicly). If that's a mistake, open an issue at github.com/neat-extensions/neat-extensions.",
};
const placeholderBuy = /PAYMENT_LINK/.test(app.buyUrl);

for (const [list, items] of [
  [$("free"), FREE],
  [$("pro"), PRO],
])
  for (const it of items) list.append(h("li", {}, icon(it.icon, { size: 18 }), h("span", { text: it.text })));
$("price").textContent = `${app.price} once`;
$("terms").textContent = TERMS;

async function paint() {
  const { licence } = await chrome.storage.sync.get("licence");
  const ok = !!licence && (await verifyLicence(LICENCE_KEY, licence, app.licenceProduct, { revoked: app.revokedLicences })).ok;
  const area = $("buy-area");
  area.replaceChildren();
  if (ok) {
    area.append(h("p", { class: "on" }, icon("check", { size: 20 }), h("strong", { text: "Pro is on. Thank you!" })));
    const remove = h("button", { class: "linklike", text: "Remove the key from this browser" });
    remove.addEventListener("click", async () => {
      await chrome.storage.sync.remove("licence");
      paint();
    });
    area.append(remove);
    $("key-area").hidden = true;
  } else {
    area.append(
      placeholderBuy
        ? h("span", { class: "big disabled", role: "link", "aria-disabled": "true", text: "Get Pro — coming soon" })
        : h("a", { class: "big", href: app.buyUrl, target: "_blank", rel: "noopener noreferrer", text: `Get Pro — ${app.price}` }),
    );
    area.append(h("p", { class: "muted small", text: "Paid on Stripe's secure page. We never see your card." }));
    $("key-area").hidden = false;
  }
}

$("unlock").addEventListener("click", async () => {
  const key = cleanLicenceInput($("key").value);
  const r = await verifyLicence(LICENCE_KEY, key, app.licenceProduct, { revoked: app.revokedLicences });
  if (!r.ok) {
    $("key-status").textContent = REASONS[r.reason];
    return;
  }
  await chrome.storage.sync.set({ licence: key });
  $("key").value = "";
  $("key-status").textContent = "";
  paint();
});

paint();
chrome.storage.onChanged.addListener((c, area) => area === "sync" && c.licence && paint());
