import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { env } from "../config/env";
import { randomToken, slugify } from "./utils";

export type StoredFile = {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
};

interface StorageDriver {
  put(key: string, body: Buffer, mimeType: string): Promise<string>;
  remove(url: string): Promise<void>;
}

/** Stores files on local disk under UPLOAD_DIR and serves them from /uploads. */
class LocalDriver implements StorageDriver {
  private root = path.resolve(process.cwd(), env.UPLOAD_DIR);

  async put(key: string, body: Buffer) {
    const full = path.join(this.root, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
    return `/uploads/${key.replace(/\\/g, "/")}`;
  }

  async remove(url: string) {
    if (!url.startsWith("/uploads/")) return;
    const full = path.join(this.root, url.replace(/^\/uploads\//, ""));
    await fs.unlink(full).catch(() => undefined);
  }
}

/**
 * S3-compatible driver (AWS S3, Cloudflare R2, DigitalOcean Spaces).
 * Install `@aws-sdk/client-s3` and set STORAGE_DRIVER=s3 to enable.
 */
class S3Driver implements StorageDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  private async getClient() {
    if (this.client) return this.client;
    const modName = "@aws-sdk/client-s3";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require(modName);
    this.client = {
      sdk,
      s3: new sdk.S3Client({
        region: env.S3_REGION,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID!,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        },
      }),
    };
    return this.client;
  }

  async put(key: string, body: Buffer, mimeType: string) {
    const { sdk, s3 } = await this.getClient();
    await s3.send(
      new sdk.PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: mimeType }),
    );
    return `${env.S3_PUBLIC_URL?.replace(/\/$/, "")}/${key}`;
  }

  async remove(url: string) {
    const { sdk, s3 } = await this.getClient();
    const key = url.replace(`${env.S3_PUBLIC_URL?.replace(/\/$/, "")}/`, "");
    await s3.send(new sdk.DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
}

export const storage: StorageDriver = env.STORAGE_DRIVER === "s3" ? new S3Driver() : new LocalDriver();

/**
 * Optimise an uploaded image (auto-rotate, max 1800px, WebP q82) and store it.
 * Non-image files (PDF/CSV) are stored as-is.
 */
export async function storeUpload(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  folder = "general",
): Promise<StoredFile> {
  const base = slugify(path.parse(file.originalname).name) || "file";
  const stamp = `${Date.now().toString(36)}-${randomToken(3)}`;
  const isRaster = /^image\/(jpeg|png|webp|avif|gif)$/.test(file.mimetype);

  if (isRaster) {
    const img = sharp(file.buffer, { failOn: "none" }).rotate();
    const out = await img
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const key = `${folder}/${base}-${stamp}.webp`;
    const url = await storage.put(key, out.data, "image/webp");
    return {
      url,
      filename: `${base}.webp`,
      mimeType: "image/webp",
      size: out.info.size,
      width: out.info.width,
      height: out.info.height,
    };
  }

  const ext = path.extname(file.originalname).toLowerCase() || "";
  const key = `${folder}/${base}-${stamp}${ext}`;
  const url = await storage.put(key, file.buffer, file.mimetype);
  return { url, filename: file.originalname, mimeType: file.mimetype, size: file.buffer.length };
}

/** Absolute URL for media referenced in emails / PDFs. */
export function absoluteUrl(url?: string | null) {
  if (!url) return "";
  if (/^https?:\/\//.test(url)) return url;
  return `${env.API_PUBLIC_URL.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}
