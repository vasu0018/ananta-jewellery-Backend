import type { Kind, Metal, Stone } from "./svg";

export const CATEGORIES: { name: string; slug: string; kind: Kind; metal: Metal; stone: Stone; description: string; children?: { name: string; slug: string; kind: Kind; metal: Metal; stone: Stone }[] }[] = [
  { name: "Rings", slug: "rings", kind: "ring", metal: "Silver", stone: "Zircon", description: "Solitaires, bands and statement rings in 925 silver and lab-grown diamonds." },
  {
    name: "Earrings",
    slug: "earrings",
    kind: "stud",
    metal: "Rose Gold",
    stone: "Zircon",
    description: "Everyday studs, hoops, drops and festive jhumkas.",
    children: [
      { name: "Studs", slug: "studs", kind: "stud", metal: "Silver", stone: "Zircon" },
      { name: "Hoops", slug: "hoops", kind: "hoop", metal: "Gold", stone: "None" },
      { name: "Drops & Jhumkas", slug: "drops-jhumkas", kind: "jhumka", metal: "Oxidised", stone: "None" },
    ],
  },
  {
    name: "Necklaces",
    slug: "necklaces",
    kind: "necklace",
    metal: "Gold",
    stone: "Pearl",
    description: "Pendants, layered necklaces and chokers to light up every neckline.",
    children: [
      { name: "Pendants", slug: "pendants", kind: "heart", metal: "Rose Gold", stone: "Zircon" },
      { name: "Chains & Chokers", slug: "chains-chokers", kind: "necklace", metal: "Silver", stone: "Zircon" },
    ],
  },
  { name: "Bracelets", slug: "bracelets", kind: "bracelet", metal: "Rose Gold", stone: "Zircon", description: "Tennis, charm and chain bracelets." },
  { name: "Bangles", slug: "bangles", kind: "bangle", metal: "Gold", stone: "Zircon", description: "Classic bangles and kadas in pure silver." },
  { name: "Anklets", slug: "anklets", kind: "anklet", metal: "Silver", stone: "None", description: "Payals with ghungroos, charms and delicate chains." },
  { name: "Mangalsutra", slug: "mangalsutra", kind: "mangalsutra", metal: "Gold", stone: "Zircon", description: "Modern mangalsutras for everyday wear." },
  { name: "Nose Pins", slug: "nose-pins", kind: "nosepin", metal: "Silver", stone: "Zircon", description: "Studs, rings and naths in hypoallergenic silver." },
  {
    name: "Men",
    slug: "men",
    kind: "chain",
    metal: "Silver",
    stone: "None",
    description: "Bold chains, rings and kadas for him.",
    children: [
      { name: "Men's Rings", slug: "mens-rings", kind: "mensring", metal: "Silver", stone: "None" },
      { name: "Men's Chains", slug: "mens-chains", kind: "chain", metal: "Gold", stone: "None" },
      { name: "Men's Bracelets & Kadas", slug: "mens-bracelets", kind: "kada", metal: "Oxidised", stone: "None" },
    ],
  },
];

export const COLLECTIONS: { name: string; slug: string; type: "CURATED" | "OCCASION" | "BOND" | "CELEBRITY" | "COLOUR" | "GIFTING"; description: string; featured?: boolean; art: { kind: Kind; metal: Metal; stone: Stone; bg: string } | { swatch: Metal } }[] = [
  // Shop by colour
  { name: "Silver", slug: "silver", type: "COLOUR", description: "Timeless 925 sterling silver.", art: { swatch: "Silver" } },
  { name: "Gold", slug: "gold", type: "COLOUR", description: "18K gold plated over 925 silver.", art: { swatch: "Gold" } },
  { name: "Rose Gold", slug: "rose-gold", type: "COLOUR", description: "Blush-toned rose gold plating.", art: { swatch: "Rose Gold" } },
  { name: "Oxidised", slug: "oxidised", type: "COLOUR", description: "Antique oxidised silver.", art: { swatch: "Oxidised" } },
  // Shop by bond
  { name: "For Her", slug: "for-her", type: "BOND", description: "Gifts she will treasure.", featured: true, art: { kind: "heart", metal: "Rose Gold", stone: "Zircon", bg: "#fbeff0" } },
  { name: "For Mom", slug: "for-mom", type: "BOND", description: "For the one who gave you everything.", art: { kind: "pendant", metal: "Gold", stone: "Pearl", bg: "#f6f1e7" } },
  { name: "For Sister", slug: "for-sister", type: "BOND", description: "Rakhi & bhai dooj picks.", art: { kind: "bracelet", metal: "Silver", stone: "Zircon", bg: "#f3eef6" } },
  { name: "For Him", slug: "for-him", type: "BOND", description: "Bold, minimal pieces for him.", art: { kind: "chain", metal: "Silver", stone: "None", bg: "#eef2f7" } },
  { name: "Best Friends", slug: "best-friends", type: "BOND", description: "Matching pieces for your person.", art: { kind: "stud", metal: "Gold", stone: "Zircon", bg: "#eef3f1" } },
  // Shop by occasion
  { name: "Daily Wear", slug: "daily-wear", type: "OCCASION", description: "Light, comfortable, all-day sparkle.", art: { kind: "stud", metal: "Silver", stone: "Zircon", bg: "#eef3f1" } },
  { name: "Office Wear", slug: "office-wear", type: "OCCASION", description: "Polished pieces for the 9-to-5.", art: { kind: "hoop", metal: "Gold", stone: "None", bg: "#f5efe4" } },
  { name: "Party Wear", slug: "party-wear", type: "OCCASION", description: "Statement sparkle for the night out.", art: { kind: "drop", metal: "Silver", stone: "Sapphire", bg: "#f1f0f5" } },
  { name: "Wedding & Festive", slug: "wedding-festive", type: "OCCASION", description: "Jhumkas, kadas and mangalsutras for the big days.", art: { kind: "jhumka", metal: "Gold", stone: "Ruby", bg: "#fbeff0" } },
  // Celebrity / studio edits (fictional stylists)
  { name: "The Studio Edit by Aanya", slug: "studio-edit-aanya", type: "CELEBRITY", description: "Stylist Aanya Mehra's everyday favourites.", featured: true, art: { kind: "necklace", metal: "Gold", stone: "Pearl", bg: "#f6f1e7" } },
  { name: "Red Carpet by Kabir", slug: "red-carpet-kabir", type: "CELEBRITY", description: "Kabir Rao's bold picks for him and her.", art: { kind: "mensring", metal: "Silver", stone: "None", bg: "#eef2f7" } },
  // Gifting
  { name: "Gifts Under ₹999", slug: "gifts-under-999", type: "GIFTING", description: "Thoughtful gifts that won't break the bank.", featured: true, art: { kind: "nosepin", metal: "Rose Gold", stone: "Zircon", bg: "#fbeff0" } },
  { name: "Gifts Under ₹1,999", slug: "gifts-under-1999", type: "GIFTING", description: "Our most-loved gifts.", art: { kind: "heart", metal: "Silver", stone: "Zircon", bg: "#f3eef6" } },
  { name: "Anniversary Gifts", slug: "anniversary-gifts", type: "GIFTING", description: "Celebrate every year together.", art: { kind: "ring", metal: "Gold", stone: "Lab Grown Diamond", bg: "#f5efe4" } },
  // Curated
  { name: "Lab Grown Diamonds", slug: "lab-grown-diamonds", type: "CURATED", description: "IGI-certified lab-grown diamonds set in 14K gold.", featured: true, art: { kind: "ring", metal: "Gold", stone: "Lab Grown Diamond", bg: "#eef2f7" } },
  { name: "Gemstone Edit", slug: "gemstone-edit", type: "CURATED", description: "Pops of emerald, ruby and sapphire.", art: { kind: "pendant", metal: "Gold", stone: "Emerald", bg: "#eef3f1" } },
];

export const TAGS = [
  { name: "Gifts for Her", slug: "gifts-for-her", group: "gifting" },
  { name: "Gifts for Him", slug: "gifts-for-him", group: "gifting" },
  { name: "Hypoallergenic", slug: "hypoallergenic", group: "feature" },
  { name: "Adjustable", slug: "adjustable", group: "feature" },
  { name: "Minimal", slug: "minimal", group: "style" },
  { name: "Statement", slug: "statement", group: "style" },
  { name: "Traditional", slug: "traditional", group: "style" },
  { name: "IGI Certified", slug: "igi-certified", group: "feature" },
];

export type ProductSpec = {
  name: string;
  cat: string;
  kind: Kind;
  metal: Metal;
  stone: Stone;
  price: number;
  mrp: number;
  sizes?: string[];
  occasions: string[];
  collections: string[];
  tags: string[];
  flags?: string; // B = bestseller, N = new arrival, F = featured
  gender?: string;
  material?: string;
  weight?: number;
};

const RING = ["6", "8", "10", "12", "14"];
const BANGLE = ["2.4", "2.6", "2.8"];
const CHAIN_W = ['16"', '18"'];
const CHAIN_M = ['20"', '22"'];

export const PRODUCTS: ProductSpec[] = [
  // Rings
  { name: "Silver Solitaire Promise Ring", cat: "rings", kind: "ring", metal: "Silver", stone: "Zircon", price: 1499, mrp: 2999, sizes: RING, occasions: ["Daily Wear", "Gifting"], collections: ["silver", "for-her", "daily-wear", "gifts-under-1999"], tags: ["gifts-for-her", "minimal", "hypoallergenic"], flags: "BF" },
  { name: "Rose Gold Infinity Love Ring", cat: "rings", kind: "ring", metal: "Rose Gold", stone: "Zircon", price: 1699, mrp: 3199, sizes: RING, occasions: ["Daily Wear", "Anniversary"], collections: ["rose-gold", "for-her", "anniversary-gifts", "gifts-under-1999"], tags: ["gifts-for-her", "minimal"], flags: "B" },
  { name: "Golden Twisted Band Ring", cat: "rings", kind: "ring", metal: "Gold", stone: "None", price: 1299, mrp: 2499, sizes: RING, occasions: ["Office Wear"], collections: ["gold", "office-wear", "studio-edit-aanya"], tags: ["minimal"], flags: "N" },
  { name: "Lab Grown Diamond Halo Ring", cat: "rings", kind: "ring", metal: "Gold", stone: "Lab Grown Diamond", price: 24999, mrp: 32999, sizes: RING, occasions: ["Engagement", "Anniversary"], collections: ["lab-grown-diamonds", "anniversary-gifts", "for-her"], tags: ["igi-certified", "gifts-for-her"], flags: "BF", material: "14K Yellow Gold, IGI Lab Grown Diamond", weight: 2.6 },
  { name: "Oxidised Lotus Statement Ring", cat: "rings", kind: "ring", metal: "Oxidised", stone: "None", price: 899, mrp: 1799, sizes: ["Adjustable"], occasions: ["Festive"], collections: ["oxidised", "wedding-festive", "gifts-under-999"], tags: ["statement", "traditional", "adjustable"] },
  { name: "Emerald Princess Cocktail Ring", cat: "rings", kind: "ring", metal: "Gold", stone: "Emerald", price: 2499, mrp: 4499, sizes: RING, occasions: ["Party Wear"], collections: ["gold", "party-wear", "gemstone-edit"], tags: ["statement"], flags: "N" },
  { name: "Silver Adjustable Leaf Ring", cat: "rings", kind: "ring", metal: "Silver", stone: "None", price: 1199, mrp: 2299, sizes: ["Adjustable"], occasions: ["Daily Wear"], collections: ["silver", "daily-wear", "best-friends", "gifts-under-1999"], tags: ["adjustable", "minimal"] },
  { name: "Men's Silver Classic Band", cat: "mens-rings", kind: "mensring", metal: "Silver", stone: "None", price: 1999, mrp: 3499, sizes: ["16", "18", "20", "22"], occasions: ["Daily Wear"], collections: ["silver", "for-him", "red-carpet-kabir"], tags: ["gifts-for-him", "minimal"], gender: "Men", flags: "B", weight: 6.5 },

  // Earrings
  { name: "Silver Sparkling Solitaire Studs", cat: "studs", kind: "stud", metal: "Silver", stone: "Zircon", price: 999, mrp: 1999, occasions: ["Daily Wear", "Office Wear"], collections: ["silver", "daily-wear", "best-friends", "gifts-under-999"], tags: ["minimal", "hypoallergenic", "gifts-for-her"], flags: "BF" },
  { name: "Rose Gold Heart Studs", cat: "studs", kind: "stud", metal: "Rose Gold", stone: "Zircon", price: 1099, mrp: 2199, occasions: ["Daily Wear"], collections: ["rose-gold", "for-her", "gifts-under-1999"], tags: ["gifts-for-her", "minimal"], flags: "B" },
  { name: "Golden Classic Hoops", cat: "hoops", kind: "hoop", metal: "Gold", stone: "None", price: 1399, mrp: 2599, occasions: ["Office Wear", "Daily Wear"], collections: ["gold", "office-wear", "studio-edit-aanya"], tags: ["minimal"], flags: "B" },
  { name: "Silver Huggie Hoops with Zircons", cat: "hoops", kind: "hoop", metal: "Silver", stone: "Zircon", price: 1599, mrp: 2999, occasions: ["Party Wear"], collections: ["silver", "party-wear", "for-sister"], tags: ["gifts-for-her"], flags: "N" },
  { name: "Pearl Drop Earrings", cat: "drops-jhumkas", kind: "drop", metal: "Gold", stone: "Pearl", price: 1799, mrp: 3299, occasions: ["Wedding", "Party Wear"], collections: ["gold", "for-mom", "wedding-festive", "studio-edit-aanya"], tags: ["traditional"], flags: "F" },
  { name: "Oxidised Temple Jhumkas", cat: "drops-jhumkas", kind: "jhumka", metal: "Oxidised", stone: "None", price: 1199, mrp: 2299, occasions: ["Festive", "Wedding"], collections: ["oxidised", "wedding-festive", "for-sister", "gifts-under-1999"], tags: ["traditional", "statement"], flags: "B" },
  { name: "Lab Grown Diamond Studs 0.5 ct", cat: "studs", kind: "stud", metal: "Gold", stone: "Lab Grown Diamond", price: 18999, mrp: 25999, occasions: ["Anniversary", "Gifting"], collections: ["lab-grown-diamonds", "anniversary-gifts"], tags: ["igi-certified"], flags: "F", material: "14K Yellow Gold, IGI Lab Grown Diamond", weight: 1.4 },
  { name: "Rose Gold Butterfly Studs", cat: "studs", kind: "stud", metal: "Rose Gold", stone: "Zircon", price: 1199, mrp: 2299, occasions: ["Daily Wear"], collections: ["rose-gold", "best-friends", "gifts-under-1999"], tags: ["minimal"], flags: "N" },
  { name: "Golden Sunburst Hoops", cat: "hoops", kind: "hoop", metal: "Gold", stone: "Zircon", price: 1599, mrp: 2899, occasions: ["Party Wear"], collections: ["gold", "party-wear"], tags: ["statement"], flags: "N" },
  { name: "Ruby Drop Earrings", cat: "drops-jhumkas", kind: "drop", metal: "Gold", stone: "Ruby", price: 1899, mrp: 3499, occasions: ["Wedding", "Festive"], collections: ["gold", "gemstone-edit", "wedding-festive"], tags: ["traditional"] },

  // Necklaces & pendants
  { name: "Silver Heart Pendant with Chain", cat: "pendants", kind: "heart", metal: "Silver", stone: "Zircon", price: 1599, mrp: 2999, sizes: CHAIN_W, occasions: ["Daily Wear", "Gifting"], collections: ["silver", "for-her", "gifts-under-1999"], tags: ["gifts-for-her", "minimal"], flags: "BF" },
  { name: "Rose Gold Infinity Pendant", cat: "pendants", kind: "pendant", metal: "Rose Gold", stone: "Zircon", price: 1699, mrp: 3199, sizes: CHAIN_W, occasions: ["Anniversary"], collections: ["rose-gold", "anniversary-gifts", "for-her"], tags: ["gifts-for-her"], flags: "B" },
  { name: "Golden Evil Eye Pendant", cat: "pendants", kind: "pendant", metal: "Gold", stone: "Sapphire", price: 1499, mrp: 2799, sizes: CHAIN_W, occasions: ["Daily Wear"], collections: ["gold", "best-friends", "for-sister", "gifts-under-1999"], tags: ["minimal"], flags: "BN" },
  { name: "Lab Grown Diamond Solitaire Pendant", cat: "pendants", kind: "pendant", metal: "Gold", stone: "Lab Grown Diamond", price: 21999, mrp: 28999, sizes: CHAIN_W, occasions: ["Anniversary"], collections: ["lab-grown-diamonds", "anniversary-gifts"], tags: ["igi-certified"], flags: "F", material: "14K Yellow Gold, IGI Lab Grown Diamond", weight: 2.1 },
  { name: "Silver Moon & Star Pendant", cat: "pendants", kind: "pendant", metal: "Silver", stone: "Zircon", price: 1399, mrp: 2599, sizes: CHAIN_W, occasions: ["Daily Wear"], collections: ["silver", "best-friends"], tags: ["minimal"], flags: "N" },
  { name: "Silver Layered Necklace", cat: "chains-chokers", kind: "necklace", metal: "Silver", stone: "Zircon", price: 2499, mrp: 4499, occasions: ["Party Wear"], collections: ["silver", "party-wear", "studio-edit-aanya"], tags: ["statement"] },
  { name: "Golden Pearl Choker", cat: "chains-chokers", kind: "necklace", metal: "Gold", stone: "Pearl", price: 2999, mrp: 5499, occasions: ["Wedding", "Festive"], collections: ["gold", "for-mom", "wedding-festive"], tags: ["traditional", "statement"], flags: "BF" },
  { name: "Emerald Line Necklace", cat: "chains-chokers", kind: "necklace", metal: "Gold", stone: "Emerald", price: 3499, mrp: 5999, occasions: ["Wedding"], collections: ["gold", "gemstone-edit"], tags: ["statement"], flags: "N" },
  { name: "Men's Silver Curb Chain", cat: "mens-chains", kind: "chain", metal: "Silver", stone: "None", price: 3499, mrp: 5999, sizes: CHAIN_M, occasions: ["Daily Wear"], collections: ["silver", "for-him", "red-carpet-kabir"], tags: ["gifts-for-him"], gender: "Men", flags: "B", weight: 14 },
  { name: "Men's Golden Box Chain", cat: "mens-chains", kind: "chain", metal: "Gold", stone: "None", price: 3999, mrp: 6499, sizes: CHAIN_M, occasions: ["Festive"], collections: ["gold", "for-him"], tags: ["gifts-for-him"], gender: "Men", weight: 12 },

  // Bracelets & bangles
  { name: "Silver Tennis Bracelet", cat: "bracelets", kind: "bracelet", metal: "Silver", stone: "Zircon", price: 2999, mrp: 5499, occasions: ["Party Wear", "Anniversary"], collections: ["silver", "party-wear", "for-her", "anniversary-gifts"], tags: ["gifts-for-her", "statement"], flags: "BF" },
  { name: "Rose Gold Charm Bracelet", cat: "bracelets", kind: "bracelet", metal: "Rose Gold", stone: "Zircon", price: 1999, mrp: 3699, occasions: ["Daily Wear"], collections: ["rose-gold", "for-sister", "best-friends"], tags: ["adjustable", "gifts-for-her"], flags: "N" },
  { name: "Golden Evil Eye Bracelet", cat: "bracelets", kind: "bracelet", metal: "Gold", stone: "Sapphire", price: 1299, mrp: 2499, occasions: ["Daily Wear"], collections: ["gold", "for-sister", "gifts-under-1999"], tags: ["adjustable"], flags: "B" },
  { name: "Men's Oxidised Kada", cat: "mens-bracelets", kind: "kada", metal: "Oxidised", stone: "None", price: 2499, mrp: 4299, sizes: BANGLE, occasions: ["Festive"], collections: ["oxidised", "for-him", "red-carpet-kabir"], tags: ["gifts-for-him", "traditional"], gender: "Men", weight: 22 },
  { name: "Silver Classic Bangles (Set of 2)", cat: "bangles", kind: "bangle", metal: "Silver", stone: "None", price: 3999, mrp: 6999, sizes: BANGLE, occasions: ["Daily Wear", "Festive"], collections: ["silver", "for-mom", "wedding-festive"], tags: ["traditional"], weight: 24 },
  { name: "Golden Kada with Zircons", cat: "bangles", kind: "bangle", metal: "Gold", stone: "Zircon", price: 2799, mrp: 4999, sizes: BANGLE, occasions: ["Wedding", "Festive"], collections: ["gold", "wedding-festive", "for-mom"], tags: ["statement", "traditional"], flags: "N", weight: 18 },

  // Anklets
  { name: "Silver Ghungroo Anklet", cat: "anklets", kind: "anklet", metal: "Silver", stone: "None", price: 1799, mrp: 3299, occasions: ["Festive", "Daily Wear"], collections: ["silver", "wedding-festive", "for-sister"], tags: ["traditional"], flags: "B", weight: 9 },
  { name: "Rose Gold Butterfly Anklet", cat: "anklets", kind: "anklet", metal: "Rose Gold", stone: "None", price: 1499, mrp: 2799, occasions: ["Daily Wear"], collections: ["rose-gold", "best-friends", "gifts-under-1999"], tags: ["minimal", "adjustable"], flags: "N" },
  { name: "Oxidised Boho Anklet", cat: "anklets", kind: "anklet", metal: "Oxidised", stone: "None", price: 999, mrp: 1999, occasions: ["Daily Wear"], collections: ["oxidised", "gifts-under-999"], tags: ["adjustable"] },

  // Mangalsutra
  { name: "Silver Solitaire Mangalsutra", cat: "mangalsutra", kind: "mangalsutra", metal: "Silver", stone: "Zircon", price: 2499, mrp: 4599, occasions: ["Daily Wear", "Wedding"], collections: ["silver", "for-her", "wedding-festive"], tags: ["traditional"], flags: "B" },
  { name: "Golden Twin Heart Mangalsutra", cat: "mangalsutra", kind: "mangalsutra", metal: "Gold", stone: "Ruby", price: 2799, mrp: 4999, occasions: ["Wedding"], collections: ["gold", "wedding-festive", "anniversary-gifts"], tags: ["traditional"], flags: "N" },

  // Nose pins
  { name: "Silver Flower Nose Pin", cat: "nose-pins", kind: "nosepin", metal: "Silver", stone: "Zircon", price: 499, mrp: 999, occasions: ["Daily Wear"], collections: ["silver", "gifts-under-999"], tags: ["minimal", "hypoallergenic"], flags: "B", weight: 0.4 },
  { name: "Golden Solitaire Nose Pin", cat: "nose-pins", kind: "nosepin", metal: "Gold", stone: "Zircon", price: 599, mrp: 1199, occasions: ["Daily Wear"], collections: ["gold", "gifts-under-999"], tags: ["minimal"], weight: 0.4 },
  { name: "Oxidised Floral Nath", cat: "nose-pins", kind: "nosepin", metal: "Oxidised", stone: "Ruby", price: 699, mrp: 1399, occasions: ["Festive", "Wedding"], collections: ["oxidised", "wedding-festive", "gifts-under-999"], tags: ["traditional"], flags: "N", weight: 0.8 },
];

export const CUSTOMERS = [
  { name: "Priya Sharma", email: "priya@example.com", phone: "9876500001", city: "Bengaluru", state: "Karnataka", pincode: "560001", line1: "12, 4th Cross, Indiranagar" },
  { name: "Ananya Iyer", email: "ananya.iyer@example.com", phone: "9876500002", city: "Chennai", state: "Tamil Nadu", pincode: "600017", line1: "8, Usman Road, T Nagar" },
  { name: "Riya Patel", email: "riya.patel@example.com", phone: "9876500003", city: "Ahmedabad", state: "Gujarat", pincode: "380015", line1: "B-304, Shivalik Heights, Satellite" },
  { name: "Neha Gupta", email: "neha.gupta@example.com", phone: "9876500004", city: "New Delhi", state: "Delhi", pincode: "110017", line1: "C-21, Saket" },
  { name: "Sneha Kulkarni", email: "sneha.k@example.com", phone: "9876500005", city: "Pune", state: "Maharashtra", pincode: "411038", line1: "Flat 6, Kothrud Residency" },
  { name: "Aditi Verma", email: "aditi.verma@example.com", phone: "9876500006", city: "Lucknow", state: "Uttar Pradesh", pincode: "226010", line1: "2/45, Gomti Nagar" },
  { name: "Kavya Reddy", email: "kavya.reddy@example.com", phone: "9876500007", city: "Hyderabad", state: "Telangana", pincode: "500034", line1: "Road No. 12, Banjara Hills" },
  { name: "Ishita Banerjee", email: "ishita.b@example.com", phone: "9876500008", city: "Kolkata", state: "West Bengal", pincode: "700019", line1: "17, Ballygunge Place" },
  { name: "Meera Shah", email: "meera.shah@example.com", phone: "9876500009", city: "Surat", state: "Gujarat", pincode: "395007", line1: "402, Green Avenue, Vesu" },
  { name: "Pooja Nair", email: "pooja.nair@example.com", phone: "9876500010", city: "Kochi", state: "Kerala", pincode: "682020", line1: "Kadavanthra, Near KP Vallon Road" },
  { name: "Rahul Mehta", email: "rahul.mehta@example.com", phone: "9876500011", city: "Mumbai", state: "Maharashtra", pincode: "400050", line1: "21, Hill Road, Bandra West" },
  { name: "Arjun Singh", email: "arjun.singh@example.com", phone: "9876500012", city: "Jaipur", state: "Rajasthan", pincode: "302017", line1: "45, Malviya Nagar" },
  { name: "Simran Kaur", email: "simran.kaur@example.com", phone: "9876500013", city: "Chandigarh", state: "Chandigarh", pincode: "160022", line1: "House 1123, Sector 22" },
  { name: "Tanvi Joshi", email: "tanvi.joshi@example.com", phone: "9876500014", city: "Indore", state: "Madhya Pradesh", pincode: "452001", line1: "77, Vijay Nagar" },
  { name: "Divya Menon", email: "divya.menon@example.com", phone: "9876500015", city: "Guwahati", state: "Assam", pincode: "781005", line1: "Zoo Road, Tiniali" },
];

const btn = (href: string, label: string) =>
  `<p style="margin:28px 0"><a href="${href}" style="background:#9b5b6b;color:#fff;padding:12px 26px;border-radius:999px;text-decoration:none;font-weight:600">${label}</a></p>`;
const items = `<table width="100%" style="border-top:1px solid #f0e6e2;border-bottom:1px solid #f0e6e2;margin:16px 0">{{itemsHtml}}</table>`;

export const EMAIL_TEMPLATES = [
  {
    key: "ORDER_CONFIRMATION",
    name: "Order confirmation",
    subject: "Your order {{orderNumber}} is confirmed ✨",
    html: `<h2 style="margin:0 0 8px">Thank you, {{customerName}}!</h2><p>We've received your order <b>{{orderNumber}}</b> and our artisans are getting it ready.</p>${items}<p><b>Total:</b> {{orderTotal}} · {{paymentMethod}}</p><p><b>Shipping to:</b> {{shippingAddress}}</p>${btn("{{orderUrl}}", "View order")}`,
  },
  {
    key: "ORDER_SHIPPED",
    name: "Order shipped",
    subject: "Your {{storeName}} order is on its way 🚚",
    html: `<h2 style="margin:0 0 8px">Good news, {{customerName}}!</h2><p>Order <b>{{orderNumber}}</b> has been shipped with <b>{{courierName}}</b>.</p><p>Tracking number: <b>{{awb}}</b></p>${btn("{{trackingUrl}}", "Track shipment")}`,
  },
  {
    key: "ORDER_DELIVERED",
    name: "Order delivered",
    subject: "Delivered: {{orderNumber}} 💝",
    html: `<h2 style="margin:0 0 8px">It's here, {{customerName}}!</h2><p>Your order <b>{{orderNumber}}</b> has been delivered. We hope you love it as much as we loved making it.</p><p>Share a review and earn loyalty points on your next purchase.</p>${btn("{{orderUrl}}", "Write a review")}`,
  },
  {
    key: "ORDER_CANCELLED",
    name: "Order cancelled",
    subject: "Your order {{orderNumber}} has been cancelled",
    html: `<h2 style="margin:0 0 8px">Hi {{customerName}},</h2><p>Your order <b>{{orderNumber}}</b> has been cancelled. If you paid online, the refund will reach your original payment method in 5–7 working days.</p>${btn("{{storeUrl}}", "Continue shopping")}`,
  },
  {
    key: "REFUND_PROCESSED",
    name: "Refund processed",
    subject: "Refund of {{refundAmount}} processed for {{orderNumber}}",
    html: `<h2 style="margin:0 0 8px">Hi {{customerName}},</h2><p>We've processed a refund of <b>{{refundAmount}}</b> for order <b>{{orderNumber}}</b>. It should reflect in 5–7 working days.</p>${btn("{{orderUrl}}", "View order")}`,
  },
  {
    key: "ABANDONED_CART",
    name: "Abandoned cart reminder",
    subject: "You left something sparkly behind ✨",
    html: `<h2 style="margin:0 0 8px">Still thinking it over, {{customerName}}?</h2><p>Your favourites are waiting in your bag — but stock is limited.</p>${items}<p><b>Bag total:</b> {{cartTotal}}</p>${btn("{{cartUrl}}", "Complete my order")}`,
  },
  {
    key: "WELCOME",
    name: "Welcome email",
    subject: "Welcome to {{storeName}} 💫",
    html: `<h2 style="margin:0 0 8px">Welcome, {{customerName}}!</h2><p>We've added <b>{{points}} loyalty points</b> to your account as a thank-you for joining.</p><p>Use code <b>WELCOME10</b> for 10% off your first order.</p>${btn("{{storeUrl}}", "Start shopping")}`,
  },
  {
    key: "PASSWORD_RESET",
    name: "Password reset",
    subject: "Reset your {{storeName}} password",
    html: `<h2 style="margin:0 0 8px">Hi {{customerName}},</h2><p>We received a request to reset your password. This link is valid for 1 hour.</p>${btn("{{resetUrl}}", "Reset password")}<p style="color:#8a8a99;font-size:13px">If you didn't request this, you can safely ignore this email.</p>`,
  },
];

export const POSTS = [
  {
    title: "How to Care for Your Silver Jewellery",
    type: "BLOG" as const,
    excerpt: "Five simple habits that keep your 925 silver sparkling for years.",
    tags: ["care", "silver"],
    art: { kind: "ring" as Kind, metal: "Silver" as Metal, stone: "Zircon" as Stone, from: "#eef2f7", to: "#f7efe9" },
    content: `<p>925 sterling silver is durable, hypoallergenic and naturally lustrous — but like all fine things, it loves a little care.</p>
<h2>1. Last on, first off</h2><p>Put your jewellery on after perfume, lotion and hairspray, and take it off before bathing, swimming or working out.</p>
<h2>2. Store it dry</h2><p>Keep each piece in the anti-tarnish pouch it came in. Air and moisture are what cause silver to darken.</p>
<h2>3. Wipe after wearing</h2><p>A quick wipe with a soft microfibre cloth removes oils and keeps the shine.</p>
<h2>4. Gentle cleaning</h2><p>Use lukewarm water with a drop of mild soap, then dry thoroughly. Avoid toothpaste and harsh chemicals.</p>
<h2>5. Wear it often</h2><p>Believe it or not, regular wear keeps silver bright. And remember — every Ananta piece comes with lifetime plating service.</p>`,
  },
  {
    title: "Lab Grown vs Mined Diamonds: What's the Difference?",
    type: "BLOG" as const,
    excerpt: "Same sparkle, same chemistry — here's why lab-grown diamonds are the smarter choice.",
    tags: ["lab-grown", "diamonds", "guide"],
    art: { kind: "ring" as Kind, metal: "Gold" as Metal, stone: "Lab Grown Diamond" as Stone, from: "#f6f1e7", to: "#eef2f7" },
    content: `<p>Lab-grown diamonds are real diamonds — chemically, physically and optically identical to mined ones. The only difference is their origin.</p>
<h2>Same 4Cs</h2><p>They're graded on cut, colour, clarity and carat by the same labs (IGI, GIA). Every Ananta lab-grown diamond comes with an IGI certificate.</p>
<h2>Kinder to the planet</h2><p>No mining means a dramatically smaller environmental footprint and fully traceable origin.</p>
<h2>Better value</h2><p>You get a bigger, better diamond for 60–70% less than a comparable mined stone.</p>`,
  },
  {
    title: "The Ultimate Ring Size Guide",
    type: "BLOG" as const,
    excerpt: "Find your perfect ring size at home in under two minutes.",
    tags: ["guide", "rings"],
    art: { kind: "mensring" as Kind, metal: "Rose Gold" as Metal, stone: "None" as Stone, from: "#fbeff0", to: "#f3eef6" },
    content: `<p>Not sure of your ring size? Here's the easiest way to measure at home.</p>
<h2>Using a ring you own</h2><p>Measure the inside diameter of a ring that fits well and match it to our size chart on any ring page.</p>
<h2>Using a strip of paper</h2><p>Wrap a thin strip around the base of your finger, mark where it overlaps, and measure the length in millimetres.</p>
<h2>Still unsure?</h2><p>Choose an adjustable ring or use our free size exchange within 30 days.</p>`,
  },
  {
    title: "Gifting Guide: Jewellery for Every Bond",
    type: "BLOG" as const,
    excerpt: "From Rakhi to anniversaries — thoughtful picks for everyone you love.",
    tags: ["gifting"],
    art: { kind: "heart" as Kind, metal: "Rose Gold" as Metal, stone: "Zircon" as Stone, from: "#fbeff0", to: "#f6f1e7" },
    content: `<p>A piece of jewellery is a memory you can wear. Here are our favourite picks for every relationship.</p>
<h2>For her</h2><p>A solitaire pendant or a delicate tennis bracelet never goes out of style.</p>
<h2>For mom</h2><p>Pearl drops and classic bangles — elegant, timeless and comfortable.</p>
<h2>For your sister</h2><p>Evil-eye bracelets and huggie hoops make perfect Rakhi gifts.</p>
<h2>For him</h2><p>A bold curb chain or a classic silver band.</p>`,
  },
  {
    title: "Festive Lookbook: Gold Hour",
    type: "LOOKBOOK" as const,
    excerpt: "Jhumkas, kadas and chokers styled for the season of lights.",
    tags: ["festive", "lookbook"],
    art: { kind: "jhumka" as Kind, metal: "Gold" as Metal, stone: "Ruby" as Stone, from: "#f5efe4", to: "#fbeff0" },
    content: `<p>Warm gold tones, rich rubies and the gentle chime of ghungroos — our festive lookbook celebrates tradition with a modern twist.</p><p>Pair the Golden Pearl Choker with Ruby Drop Earrings for an effortless puja look, or stack Golden Kadas for sangeet nights.</p>`,
  },
  {
    title: "Everyday Minimal: The Office Edit",
    type: "LOOKBOOK" as const,
    excerpt: "Quiet sparkle for the 9-to-5.",
    tags: ["minimal", "lookbook"],
    art: { kind: "hoop" as Kind, metal: "Gold" as Metal, stone: "None" as Stone, from: "#eef3f1", to: "#f1f0f5" },
    content: `<p>Polished, light and meeting-ready. Classic hoops, a twisted band and a single solitaire pendant are all you need.</p>`,
  },
];

export const REVIEW_SNIPPETS = [
  { rating: 5, title: "Absolutely stunning", body: "Even prettier in person. The finish is beautiful and it hasn't tarnished at all after weeks of daily wear." },
  { rating: 5, title: "Perfect gift", body: "Bought this for my wife's birthday and she loved it. The packaging was premium too." },
  { rating: 4, title: "Lovely piece", body: "Very elegant and lightweight. Delivery took a day longer than expected but worth the wait." },
  { rating: 5, title: "Great quality", body: "Hallmarked silver, sturdy clasp and the stones really sparkle. Will definitely buy again." },
  { rating: 4, title: "Looks premium", body: "Looks much more expensive than it is. Size was slightly big but the exchange was easy." },
  { rating: 5, title: "My new everyday favourite", body: "I haven't taken it off since it arrived. Doesn't irritate my sensitive skin at all." },
  { rating: 3, title: "Nice but small", body: "Good quality, but smaller than it looked in the pictures. Still a nice piece." },
  { rating: 5, title: "Worth every rupee", body: "The shine and craftsmanship are top notch. Customer service helped me pick the right size." },
  { rating: 4, title: "Beautiful design", body: "Delicate and classy. Goes with both ethnic and western outfits." },
  { rating: 2, title: "Clasp issue", body: "The design is pretty but the clasp felt a little loose. Support offered a replacement quickly." },
];
