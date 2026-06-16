import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageGateway {
  presignUpload(o: { key: string; contentType: string }): Promise<{ url: string }>;
  presignDownload(o: { key: string }): Promise<{ url: string }>;
  putObject(o: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
}

function r2Client(): S3Client {
  const acct = process.env.R2_ACCOUNT_ID;
  if (!acct || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    throw new Error("storage_not_configured");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${acct}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export const r2Storage: StorageGateway = {
  async presignUpload({ key, contentType }) {
    const url = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 },
    );
    return { url };
  },
  async presignDownload({ key }) {
    const url = await getSignedUrl(
      r2Client(),
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
      { expiresIn: 300 },
    );
    return { url };
  },
  async putObject({ key, bytes, contentType }) {
    await r2Client().send(
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: contentType }),
    );
  },
};

export function makeFakeStorage(): StorageGateway & { calls: { op: string; key: string }[] } {
  const calls: { op: string; key: string }[] = [];
  return {
    calls,
    async presignUpload({ key }) {
      calls.push({ op: "upload", key });
      return { url: `https://fake-r2/${key}?sig=put` };
    },
    async presignDownload({ key }) {
      calls.push({ op: "download", key });
      return { url: `https://fake-r2/${key}?sig=get` };
    },
    async putObject({ key }) {
      calls.push({ op: "put", key });
    },
  };
}
