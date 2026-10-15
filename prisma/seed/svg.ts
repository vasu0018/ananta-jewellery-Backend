/**
 * Vector jewellery illustrations used as placeholder product / banner imagery.
 * Replace them with real photography from the admin media library.
 */

export type Metal = "Silver" | "Gold" | "Rose Gold" | "Oxidised";
export type Stone = "Zircon" | "Lab Grown Diamond" | "Pearl" | "Emerald" | "Ruby" | "Sapphire" | "None";
export type Kind =
  | "ring"
  | "mensring"
  | "stud"
  | "hoop"
  | "drop"
  | "jhumka"
  | "pendant"
  | "heart"
  | "necklace"
  | "chain"
  | "bracelet"
  | "bangle"
  | "kada"
  | "anklet"
  | "mangalsutra"
  | "nosepin";

const METAL_STOPS: Record<Metal, [string, string, string, string]> = {
  Silver: ["#fbfcfd", "#cfd3da", "#8f97a3", "#eef0f3"],
  Gold: ["#fff3c8", "#e6bc5f", "#b07f25", "#f7dc94"],
  "Rose Gold": ["#ffe6de", "#e8a999", "#b46a59", "#f6c9bc"],
  Oxidised: ["#c4c4ca", "#7d7d86", "#45454d", "#a2a2aa"],
};

const STONE_STOPS: Record<Exclude<Stone, "None">, [string, string, string]> = {
  Zircon: ["#ffffff", "#e3eef9", "#a9c3df"],
  "Lab Grown Diamond": ["#ffffff", "#eaf4ff", "#9fbfe6"],
  Pearl: ["#ffffff", "#f6efe6", "#d8cbbb"],
  Emerald: ["#c9f5df", "#2fa36b", "#0d5a37"],
  Ruby: ["#ffd0d6", "#d63452", "#7c0f24"],
  Sapphire: ["#d4e2ff", "#3559c7", "#152e7a"],
};

export const BACKGROUNDS = ["#f7efe9", "#f3eef6", "#eef3f1", "#f6f1e7", "#f1f0f5", "#fbeff0", "#eef2f7", "#f5efe4"];

function defs(metal: Metal, stone: Stone, bg: string, uid: string) {
  const m = METAL_STOPS[metal];
  const s = stone === "None" ? STONE_STOPS.Zircon : STONE_STOPS[stone];
  return `<defs>
  <radialGradient id="bg${uid}" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${bg}"/></radialGradient>
  <linearGradient id="m${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m[0]}"/><stop offset=".35" stop-color="${m[1]}"/><stop offset=".7" stop-color="${m[2]}"/><stop offset="1" stop-color="${m[3]}"/></linearGradient>
  <radialGradient id="s${uid}" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="${s[0]}"/><stop offset=".55" stop-color="${s[1]}"/><stop offset="1" stop-color="${s[2]}"/></radialGradient>
  <filter id="sh${uid}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#3b2a2a" flood-opacity=".16"/></filter>
</defs>`;
}

/** A faceted (or pearl) stone with prongs. */
function stoneAt(x: number, y: number, r: number, stone: Stone, u: string) {
  if (stone === "None") {
    return `<circle cx="${x}" cy="${y}" r="${r * 0.55}" fill="url(#m${u})"/><circle cx="${x - r * 0.18}" cy="${y - r * 0.2}" r="${r * 0.14}" fill="#fff" opacity=".7"/>`;
  }
  if (stone === "Pearl") {
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#s${u})"/><ellipse cx="${x - r * 0.3}" cy="${y - r * 0.35}" rx="${r * 0.28}" ry="${r * 0.18}" fill="#fff" opacity=".85"/>`;
  }
  const pts = Array.from({ length: 8 }, (_, i) => {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  const inner = Array.from({ length: 8 }, (_, i) => {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    return `${(x + r * 0.5 * Math.cos(a)).toFixed(1)},${(y + r * 0.5 * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  const prongs = [45, 135, 225, 315]
    .map((d) => {
      const a = (d * Math.PI) / 180;
      return `<circle cx="${(x + r * 0.98 * Math.cos(a)).toFixed(1)}" cy="${(y + r * 0.98 * Math.sin(a)).toFixed(1)}" r="${(r * 0.17).toFixed(1)}" fill="url(#m${u})"/>`;
    })
    .join("");
  return `<polygon points="${pts}" fill="url(#s${u})" stroke="#ffffff" stroke-opacity=".7" stroke-width="2"/>
<polygon points="${inner}" fill="none" stroke="#ffffff" stroke-opacity=".8" stroke-width="2"/>
<line x1="${x - r}" y1="${y}" x2="${x + r}" y2="${y}" stroke="#fff" stroke-opacity=".35" stroke-width="1.5"/>
<line x1="${x}" y1="${y - r}" x2="${x}" y2="${y + r}" stroke="#fff" stroke-opacity=".35" stroke-width="1.5"/>
<circle cx="${x - r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.12}" fill="#fff" opacity=".95"/>${prongs}`;
}

function dots(cx: number, cy: number, rx: number, ry: number, from: number, to: number, n: number, r: number, fill: string) {
  return Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / Math.max(1, n - 1);
    return `<circle cx="${(cx + rx * Math.cos(a)).toFixed(1)}" cy="${(cy + ry * Math.sin(a)).toFixed(1)}" r="${r}" fill="${fill}"/>`;
  }).join("");
}

const HEART = "M0 70 C -70 20 -95 -25 -62 -55 C -35 -78 -8 -62 0 -38 C 8 -62 35 -78 62 -55 C 95 -25 70 20 0 70 Z";

function art(kind: Kind, stone: Stone, u: string) {
  const M = `url(#m${u})`;
  switch (kind) {
    case "ring":
      return `<ellipse cx="400" cy="460" rx="165" ry="140" fill="none" stroke="${M}" stroke-width="30"/>
<ellipse cx="400" cy="460" rx="146" ry="122" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="3"/>
<path d="M352 330 L400 300 L448 330" fill="none" stroke="${M}" stroke-width="14" stroke-linejoin="round"/>
${stoneAt(400, 272, 52, stone, u)}`;
    case "mensring":
      return `<ellipse cx="400" cy="420" rx="185" ry="150" fill="none" stroke="${M}" stroke-width="64"/>
<ellipse cx="400" cy="420" rx="185" ry="150" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="3"/>
<ellipse cx="400" cy="420" rx="168" ry="134" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>
<ellipse cx="400" cy="420" rx="203" ry="166" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="3"/>`;
    case "stud":
      return [290, 510]
        .map((x) => `${dots(x, 400, 78, 78, 0, Math.PI * 2 - 0.4, 14, 9, M)}${stoneAt(x, 400, 56, stone, u)}`)
        .join("");
    case "hoop":
      return [280, 520]
        .map(
          (x) => `<circle cx="${x}" cy="420" r="115" fill="none" stroke="${M}" stroke-width="22"/>
<circle cx="${x}" cy="420" r="104" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>
${stone !== "None" ? dots(x, 420, 115, 115, Math.PI * 0.2, Math.PI * 0.8, 6, 9, `url(#s${u})`) : ""}`,
        )
        .join("");
    case "drop":
      return [290, 510]
        .map(
          (x) => `${stoneAt(x, 250, 30, stone === "Pearl" ? "Zircon" : stone, u)}
<line x1="${x}" y1="282" x2="${x}" y2="380" stroke="${M}" stroke-width="6"/>
${stone === "Pearl" ? stoneAt(x, 450, 70, "Pearl", u) : `<path d="M${x} 375 C ${x - 75} 470 ${x - 55} 560 ${x} 560 C ${x + 55} 560 ${x + 75} 470 ${x} 375 Z" fill="url(#s${u})" stroke="${M}" stroke-width="10"/>`}`,
        )
        .join("");
    case "jhumka":
      return [285, 515]
        .map(
          (x) => `<circle cx="${x}" cy="220" r="34" fill="${M}"/>${stoneAt(x, 220, 18, stone, u)}
<line x1="${x}" y1="254" x2="${x}" y2="300" stroke="${M}" stroke-width="8"/>
<path d="M${x - 95} 440 C ${x - 95} 340 ${x - 40} 300 ${x} 300 C ${x + 40} 300 ${x + 95} 340 ${x + 95} 440 Z" fill="${M}"/>
<path d="M${x - 95} 440 L ${x + 95} 440" stroke="#000" stroke-opacity=".18" stroke-width="4"/>
${Array.from({ length: 9 }, (_, i) => `<circle cx="${x - 88 + i * 22}" cy="470" r="9" fill="${M}"/>`).join("")}
${Array.from({ length: 8 }, (_, i) => `<circle cx="${x - 77 + i * 22}" cy="${330 + (i % 2) * 40}" r="7" fill="#fff" opacity=".5"/>`).join("")}`,
        )
        .join("");
    case "pendant":
    case "heart": {
      const charm =
        kind === "heart"
          ? `<g transform="translate(400 480)"><path d="${HEART}" fill="${M}"/><path d="${HEART}" transform="scale(.72)" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="4"/>${stone !== "None" ? stoneAt(0, -5, 26, stone, u) : ""}</g>`
          : `<path d="M385 360 Q400 330 415 360" fill="none" stroke="${M}" stroke-width="10"/>${stoneAt(400, 430, 62, stone, u)}`;
      return `<path d="M110 110 Q400 640 690 110" fill="none" stroke="${M}" stroke-width="7" stroke-dasharray="15 6" stroke-linecap="round"/>${charm}`;
    }
    case "necklace":
      return `<path d="M120 120 Q400 600 680 120" fill="none" stroke="${M}" stroke-width="7" stroke-dasharray="15 6"/>
<path d="M140 150 Q400 700 660 150" fill="none" stroke="${M}" stroke-width="5" stroke-dasharray="10 6"/>
${[0.25, 0.38, 0.5, 0.62, 0.75]
  .map((t) => {
    const x = (1 - t) * (1 - t) * 140 + 2 * (1 - t) * t * 400 + t * t * 660;
    const y = (1 - t) * (1 - t) * 150 + 2 * (1 - t) * t * 700 + t * t * 150;
    return stoneAt(x, y + 18, t === 0.5 ? 38 : 24, stone, u);
  })
  .join("")}`;
    case "chain":
      return `<path d="M120 100 Q400 720 680 100" fill="none" stroke="${M}" stroke-width="22" stroke-dasharray="30 9" stroke-linecap="round"/>
<path d="M120 100 Q400 720 680 100" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="5" stroke-dasharray="30 9"/>
<rect x="378" y="390" width="44" height="26" rx="8" fill="${M}"/>`;
    case "bracelet":
      return `<ellipse cx="400" cy="420" rx="250" ry="130" fill="none" stroke="${M}" stroke-width="12" stroke-dasharray="18 6"/>
${Array.from({ length: 7 }, (_, i) => {
  const a = Math.PI * 0.2 + (Math.PI * 0.6 * i) / 6;
  return stoneAt(400 + 250 * Math.cos(a), 420 + 130 * Math.sin(a), 20, stone, u);
}).join("")}`;
    case "bangle":
      return `<ellipse cx="370" cy="400" rx="230" ry="120" fill="none" stroke="${M}" stroke-width="30"/>
<ellipse cx="440" cy="440" rx="230" ry="120" fill="none" stroke="${M}" stroke-width="30"/>
<ellipse cx="440" cy="440" rx="230" ry="120" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="4"/>
${stone !== "None" ? dots(440, 440, 230, 120, Math.PI * 0.25, Math.PI * 0.75, 7, 9, `url(#s${u})`) : ""}`;
    case "kada":
      return `<ellipse cx="400" cy="420" rx="235" ry="140" fill="none" stroke="${M}" stroke-width="56"/>
<ellipse cx="400" cy="420" rx="235" ry="140" fill="none" stroke="#000" stroke-opacity=".15" stroke-width="2"/>
<ellipse cx="400" cy="420" rx="214" ry="122" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="3"/>
${dots(400, 420, 235, 140, Math.PI * 0.15, Math.PI * 0.85, 11, 6, "rgba(0,0,0,.18)")}`;
    case "anklet":
      return `<path d="M90 330 Q250 520 400 470 T710 330" fill="none" stroke="${M}" stroke-width="8" stroke-dasharray="12 5"/>
${[160, 250, 340, 430, 520, 610]
  .map((x, i) => {
    const y = i < 3 ? 400 + i * 25 : 455 - (i - 3) * 25;
    return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 40}" stroke="${M}" stroke-width="4"/><circle cx="${x}" cy="${y + 56}" r="18" fill="${M}"/><circle cx="${x - 6}" cy="${y + 50}" r="5" fill="#fff" opacity=".6"/>`;
  })
  .join("")}`;
    case "mangalsutra":
      return `${Array.from({ length: 34 }, (_, i) => {
        const t = i / 33;
        const x = (1 - t) * (1 - t) * 120 + 2 * (1 - t) * t * 400 + t * t * 680;
        const y = (1 - t) * (1 - t) * 110 + 2 * (1 - t) * t * 600 + t * t * 110;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 4 === 0 ? 9 : 7}" fill="${i % 4 === 0 ? M : "#1d1d22"}"/>`;
      }).join("")}
<path d="M385 360 Q400 335 415 360" fill="none" stroke="${M}" stroke-width="9"/>
<g transform="translate(400 440)"><circle r="62" fill="${M}"/><circle r="46" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="3"/></g>
${stoneAt(400, 440, 30, stone, u)}`;
    case "nosepin":
      return `${Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `<ellipse cx="${400 + 70 * Math.cos(a)}" cy="${400 + 70 * Math.sin(a)}" rx="52" ry="34" transform="rotate(${(a * 180) / Math.PI} ${400 + 70 * Math.cos(a)} ${400 + 70 * Math.sin(a)})" fill="${M}"/>`;
      }).join("")}${stoneAt(400, 400, 50, stone, u)}`;
  }
}

/** Product image (800×800). `variant` changes framing so the gallery has distinct shots. */
export function productSvg(kind: Kind, metal: Metal, stone: Stone, variant = 0, bgIndex = 0) {
  const u = `${kind.slice(0, 3)}${variant}`;
  const bg = BACKGROUNDS[(bgIndex + variant * 3) % BACKGROUNDS.length];
  const transform = variant === 1 ? "rotate(-14 400 400) translate(0 10)" : variant === 2 ? "translate(400 420) scale(1.45) translate(-400 -400)" : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">
${defs(metal, stone, bg, u)}
<rect width="800" height="800" fill="url(#bg${u})"/>
<ellipse cx="400" cy="700" rx="230" ry="26" fill="#000" opacity=".05"/>
<g filter="url(#sh${u})" transform="${transform}">${art(kind, stone, u)}</g>
</svg>`;
}

/** Wide banner art (1600×700). Text is rendered by the storefront on top of it. */
export function bannerSvg(kind: Kind, metal: Metal, stone: Stone, from: string, to: string, align: "left" | "right" = "right") {
  const u = `b${kind.slice(0, 3)}`;
  const cx = align === "right" ? 1150 : 450;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 700" width="1600" height="700" preserveAspectRatio="xMidYMid slice">
${defs(metal, stone, from, u)}
<linearGradient id="g${u}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>
<rect width="1600" height="700" fill="url(#g${u})"/>
<circle cx="${cx}" cy="350" r="310" fill="#fff" opacity=".35"/>
<circle cx="${cx}" cy="350" r="230" fill="#fff" opacity=".4"/>
${Array.from({ length: 26 }, (_, i) => `<circle cx="${(i * 137) % 1600}" cy="${(i * 211) % 700}" r="${(i % 3) + 1.5}" fill="#fff" opacity=".6"/>`).join("")}
<g filter="url(#sh${u})" transform="translate(${cx} 350) scale(.82) translate(-400 -420)">${art(kind, stone, u)}</g>
</svg>`;
}

/** Category / collection tile (600×600). */
export function tileSvg(kind: Kind, metal: Metal, stone: Stone, bg: string) {
  const u = `t${kind.slice(0, 3)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="600" height="600">
${defs(metal, stone, bg, u)}
<rect width="800" height="800" fill="url(#bg${u})"/>
<g filter="url(#sh${u})" transform="translate(400 400) scale(.9) translate(-400 -400)">${art(kind, stone, u)}</g>
</svg>`;
}

/** Plain colour swatch used for "Shop by colour" collections. */
export function swatchSvg(metal: Metal) {
  const m = METAL_STOPS[metal];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
<defs><linearGradient id="sw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m[0]}"/><stop offset=".4" stop-color="${m[1]}"/><stop offset=".75" stop-color="${m[2]}"/><stop offset="1" stop-color="${m[3]}"/></linearGradient></defs>
<rect width="600" height="600" fill="#fbf8f6"/>
<circle cx="300" cy="300" r="210" fill="url(#sw)"/>
<circle cx="300" cy="300" r="170" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="6"/>
<ellipse cx="240" cy="220" rx="60" ry="32" fill="#fff" opacity=".45" transform="rotate(-30 240 220)"/>
</svg>`;
}
