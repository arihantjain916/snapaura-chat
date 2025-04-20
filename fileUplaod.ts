import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";

const currentDateTime = new Date()
  .toISOString()
  .slice(0, -1)
  .replace(/\W/g, "");

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

    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "snapaura",
          public_id: `${currentDateTime}_${file.originalname}`,
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

    console.log("Upload Result:", uploadResult);
    return uploadResult;
  } catch (err) {
    console.error("Error uploading file:", err);
    throw err;
  }
};
