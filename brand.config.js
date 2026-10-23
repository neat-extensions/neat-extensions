// The brand name lives here and only here. Renaming every product, page,
// manifest and store text is a one-line change to BRAND.
export const BRAND = "Neat";

// Derived values — never edit these, edit BRAND.
export const BRAND_SLUG = BRAND.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
