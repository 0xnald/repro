import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getConfig } from "./config.js";

let s3;

export function storageStatus(config = getConfig()) {
  return {
    configured: Boolean(config.storage.endpoint && config.storage.bucket && config.storage.accessKeyId && config.storage.secretAccessKey && config.storage.publicBaseUrl),
    bucket: config.storage.bucket || null
  };
}

export async function publishArtifacts({ jobId, files }, config = getConfig()) {
  if (!storageStatus(config).configured) {
    return files.map((filePath) => ({
      path: filePath,
      url: localArtifactUrl(jobId, filePath)
    }));
  }

  const client = getS3(config);
  const uploaded = [];
  for (const filePath of files) {
    const key = `repro/${jobId}/${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`;
    const body = await fs.readFile(filePath);
    try {
      await client.send(new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
        Body: body,
        ContentType: contentType(filePath)
      }));
      uploaded.push({
        path: filePath,
        url: `${config.storage.publicBaseUrl.replace(/\/$/, "")}/${key}`
      });
    } catch (error) {
      uploaded.push({
        path: filePath,
        url: localArtifactUrl(jobId, filePath),
        warning: `Artifact upload failed: ${error.message || "unknown storage error"}`
      });
    }
  }
  return uploaded;
}

function getS3(config) {
  if (!s3) {
    s3 = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey
      }
    });
  }
  return s3;
}

function localArtifactUrl(jobId, filePath) {
  const viewport = path.basename(path.dirname(filePath));
  return `/artifacts/${jobId}/${viewport}/${path.basename(filePath)}`;
}

function contentType(filePath) {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".webm")) return "video/webm";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".ts")) return "text/plain";
  return "application/octet-stream";
}
