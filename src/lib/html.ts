import sanitizeHtml from "sanitize-html";
import { z } from "zod";

/**
 * Rich text from the admin editor is rendered as HTML on the storefront, so strip
 * scripts, event handlers and unsafe URLs before it's stored.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags.filter((t) => t !== "code" && t !== "pre"),
    "img",
    "figure",
    "figcaption",
    "span",
    "u",
    "s",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    "*": ["class"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target === "_blank" ? { ...attribs, rel: "noopener noreferrer" } : attribs,
    }),
  },
};

export const sanitizeRichText = (html: string) => sanitizeHtml(html, OPTIONS).trim();

/** Zod string that is sanitized on parse. */
export const richText = (max: number) => z.string().max(max).transform(sanitizeRichText);
