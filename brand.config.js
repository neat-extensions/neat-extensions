// The brand name lives here and only here. Renaming every product, page,
// manifest and store text is a one-line change to BRAND.
export const BRAND = "Neat";

// Derived values — never edit these, edit BRAND.
export const BRAND_SLUG = BRAND.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Public website. docs/ is published by GitHub Pages at OLD_SITE_URL and served at
// SITE_URL by services/site-worker (which explains why github.io can't simply redirect).
export const SITE_URL = "https://neatextensions.com/";
export const OLD_SITE_URL = "https://neat-extensions.github.io/neat-extensions/";
export const LICENCE_URL = "https://licence.neatextensions.com";

/** <head> lines for a docs/ page at `pagePath` (e.g. "record/help.html"): its canonical
 *  address, and on github.io a hop to the same page on SITE_URL. */
export const movedHead = (pagePath) => {
  const old = new URL(OLD_SITE_URL);
  return `<link rel="canonical" href="${SITE_URL}${pagePath}">
<script>if(location.hostname==="${old.hostname}")location.replace("${SITE_URL.replace(/\/$/, "")}"+location.pathname.slice(${old.pathname.length - 1})+location.search+location.hash)</script>`;
};
