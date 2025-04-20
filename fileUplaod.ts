import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";

// Generate a unique timestamp for the public_id
const currentDateTime = new Date()
  .toISOString()
  .slice(0, -1)
  .replace(/\W/g, "");

const getResourceType = (
  mimetype: string
): "image" | "video" | "auto" | "raw" => {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "video";
  return "raw";
};

export const FileUpload = async (file: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}) => {
  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_NAME,
      api_key: process.env.CLOUDINARY_KEY,
      api_secret: process.env.CLOUDINARY_SECRET,
    });

    const resourceType = getResourceType(file.mimetype);

    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "snapaura",
          public_id: `${currentDateTime}_${file.originalname}`,
          resource_type: resourceType,
        },
        (error, result) => {
          if (error) {
            return reject(error);
          }
          resolve(result);
        }
      );

      const bufferStream = new Readable();
      bufferStream.push(file.buffer);
      bufferStream.push(null);
      bufferStream.pipe(stream);
    });

    return uploadResult;
  } catch (err) {
    console.error("Error uploading file:", err);
    throw err;
  }
};
