import { z } from "zod";

type DialCountry = { iso: string; name: string; dial: string; lengths: number[]; pattern?: RegExp };

const COUNTRIES: DialCountry[] = [
  { iso: "IN", name: "India", dial: "91", lengths: [10], pattern: /^[6-9]\d{9}$/ },
  { iso: "AE", name: "United Arab Emirates", dial: "971", lengths: [9] },
  { iso: "SA", name: "Saudi Arabia", dial: "966", lengths: [9] },
  { iso: "QA", name: "Qatar", dial: "974", lengths: [8] },
  { iso: "KW", name: "Kuwait", dial: "965", lengths: [8] },
  { iso: "OM", name: "Oman", dial: "968", lengths: [8] },
  { iso: "BH", name: "Bahrain", dial: "973", lengths: [8] },
  { iso: "US", name: "United States", dial: "1", lengths: [10] },
  { iso: "CA", name: "Canada", dial: "1", lengths: [10] },
  { iso: "GB", name: "United Kingdom", dial: "44", lengths: [10] },
  { iso: "SG", name: "Singapore", dial: "65", lengths: [8] },
  { iso: "MY", name: "Malaysia", dial: "60", lengths: [9, 10] },
  { iso: "AU", name: "Australia", dial: "61", lengths: [9] },
  { iso: "NZ", name: "New Zealand", dial: "64", lengths: [8, 9, 10] },
  { iso: "NP", name: "Nepal", dial: "977", lengths: [10] },
  { iso: "BD", name: "Bangladesh", dial: "880", lengths: [10] },
  { iso: "LK", name: "Sri Lanka", dial: "94", lengths: [9] },
  { iso: "PK", name: "Pakistan", dial: "92", lengths: [10] },
  { iso: "TH", name: "Thailand", dial: "66", lengths: [9] },
  { iso: "ID", name: "Indonesia", dial: "62", lengths: [9, 10, 11, 12] },
  { iso: "PH", name: "Philippines", dial: "63", lengths: [10] },
  { iso: "JP", name: "Japan", dial: "81", lengths: [10] },
  { iso: "KR", name: "South Korea", dial: "82", lengths: [9, 10] },
  { iso: "CN", name: "China", dial: "86", lengths: [11] },
  { iso: "HK", name: "Hong Kong", dial: "852", lengths: [8] },
  { iso: "DE", name: "Germany", dial: "49", lengths: [10, 11] },
  { iso: "FR", name: "France", dial: "33", lengths: [9] },
  { iso: "IT", name: "Italy", dial: "39", lengths: [9, 10] },
  { iso: "ES", name: "Spain", dial: "34", lengths: [9] },
  { iso: "NL", name: "Netherlands", dial: "31", lengths: [9] },
  { iso: "IE", name: "Ireland", dial: "353", lengths: [9] },
  { iso: "CH", name: "Switzerland", dial: "41", lengths: [9] },
  { iso: "SE", name: "Sweden", dial: "46", lengths: [9] },
  { iso: "NO", name: "Norway", dial: "47", lengths: [8] },
  { iso: "DK", name: "Denmark", dial: "45", lengths: [8] },
  { iso: "BE", name: "Belgium", dial: "32", lengths: [9] },
  { iso: "AT", name: "Austria", dial: "43", lengths: [10, 11] },
  { iso: "PT", name: "Portugal", dial: "351", lengths: [9] },
  { iso: "ZA", name: "South Africa", dial: "27", lengths: [9] },
  { iso: "KE", name: "Kenya", dial: "254", lengths: [9] },
  { iso: "NG", name: "Nigeria", dial: "234", lengths: [10] },
  { iso: "EG", name: "Egypt", dial: "20", lengths: [10] },
  { iso: "TR", name: "Turkey", dial: "90", lengths: [10] },
  { iso: "BR", name: "Brazil", dial: "55", lengths: [10, 11] },
  { iso: "MX", name: "Mexico", dial: "52", lengths: [10] },
];

function lengthLabel(lengths: number[]) {
  if (lengths.length === 1) return `${lengths[0]} digits`;
  if (lengths.length === 2) return `${lengths[0]} or ${lengths[1]} digits`;
  return `${lengths[0]}–${lengths[lengths.length - 1]} digits`;
}

function splitPhone(stored: string) {
  const digits = stored.replace(/\D/g, "");
  const match = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((c) => digits.startsWith(c.dial));
  if (!match) return null;
  return { country: match, national: digits.slice(match.dial.length) };
}

export function storedPhoneError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter your mobile number";
  if (/^\+91[6-9]\d{9}$/.test(v) || /^[6-9]\d{9}$/.test(v)) return null;
  if (v.startsWith("+")) {
    const parts = splitPhone(v);
    if (!parts) return "Select a supported country code";
    const expect = lengthLabel(parts.country.lengths);
    if (!parts.country.lengths.includes(parts.national.length)) return `${parts.country.name} numbers are ${expect}`;
    if (parts.country.pattern && !parts.country.pattern.test(parts.national)) return "Enter a valid Indian mobile number starting with 6, 7, 8 or 9";
    return null;
  }
  if (/^\d+$/.test(v)) return "India numbers are 10 digits and start with 6, 7, 8 or 9";
  return "Enter a valid mobile number";
}

/** Indian numbers are stored without +91 so existing accounts keep working. */
export function normalizePhone(value: string) {
  const v = value.trim();
  if (/^\+91[6-9]\d{9}$/.test(v)) return v.slice(3);
  return v;
}

export const phoneSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const message = storedPhoneError(value);
    if (message) ctx.addIssue({ code: "custom", message });
  })
  .transform(normalizePhone);
