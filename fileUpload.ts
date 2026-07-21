import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const getResourceType = (
  mimetype: string,
): "image" | "video" | "auto" | "raw" => {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "video";
  return "raw";
};

/**
 * Cloudinary public_ids may not contain path separators, and the original
 * filename is attacker-controlled.
 */
const safeName = (originalname: string): string =>
  originalname
    .replace(/[^\w.-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "file";

export const FileUpload = async (file: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}) => {
  const resourceType = getResourceType(file.mimetype);

  // The timestamp used to be computed once when the module loaded, so every
  // upload in a given process shared one prefix and collided on same-named
  // files.
  const publicId = `${Date.now()}_${randomUUID().slice(0, 8)}_${safeName(file.originalname)}`;

  return new Promise<any>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "snapaura",
        public_id: publicId,
        resource_type: resourceType,
      },
      (error, result) => {
        if (error) {
          console.error("[cloudinary] upload failed:", error?.message ?? error);
          reject(error);
          return;
        }
        resolve(result);
      },
    );

    const bufferStream = new Readable();
    bufferStream.push(file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(stream);
  });
};
