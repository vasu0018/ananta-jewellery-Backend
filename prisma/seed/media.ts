import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";

const FOLDER: Record<string, string> = {
  product: "products",
  category: "categories",
  collection: "collections",
  banner: "banners",
  flash: "banners",
  blog: "blog",
};
const MIME: Record<string, string> = { ".webp": "image/webp", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

/** Lists every seeded image in the Media Library so the admin picker can reuse them. Safe to re-run. */
export async function registerSeedMedia(seedDir: string) {
  const known = new Set((await prisma.media.findMany({ select: { url: true } })).map((m) => m.url));
  const rows = [];
  for (const filename of (await fs.readdir(seedDir)).sort()) {
    const ext = path.extname(filename).toLowerCase();
    const url = `/uploads/seed/${filename}`;
    if (!MIME[ext] || known.has(url)) continue;
    const file = path.join(seedDir, filename);
    const [stat, meta] = await Promise.all([fs.stat(file), sharp(file).metadata().catch(() => null)]);
    rows.push({
      url,
      filename,
      mimeType: MIME[ext],
      size: stat.size,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      alt: path.basename(filename, ext).replace(/-\d+$/, "").split("-").slice(1).join(" ") || null,
      folder: FOLDER[filename.split("-")[0]] ?? "general",
    });
  }
  if (rows.length) await prisma.media.createMany({ data: rows });
  return rows.length;
}

if (require.main === module) {
  registerSeedMedia(path.resolve(process.cwd(), env.UPLOAD_DIR, "seed"))
    .then((n) => console.log(`Registered ${n} seed images in the Media Library`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
