import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import { sendError, sendSuccess } from "./apiResponse";
import { Server, Socket } from "socket.io";
import { FileUpload } from "./fileUpload";
import { protect } from "./middleware/authMiddleware";
import {
  fetchConversation,
  fetchMessage,
  prisma,
  saveMessage,
  startConversation,
} from "./messageController";
import { rateLimit } from "./rateLimit";
import { connectRedis, disconnectRedis } from "./redisClient";
import { AuthUser, resolveUserFromToken } from "./userService";

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

// Modest hardening headers. A dedicated package (helmet) covers more, but
// adding one means a lockfile change; these are the ones that matter for a
// JSON API.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "100kb" }));

void connectRedis();

// 25MB, down from 200MB. multer buffers the whole file in memory and the
// container is capped at 150MB, so the old limit was a one-request OOM.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
];

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Unrecognised types used to be accepted and stored as raw Cloudinary
    // assets, which made this an open file host.
    if (!ALLOWED_UPLOAD_TYPES.includes(file.mimetype)) {
      cb(new Error("Unsupported file type"));
      return;
    }
    cb(null, true);
  },
});

app.get("/", function (_req: Request, res: Response) {
  sendSuccess(res, undefined, "Welcome to SnapAura Chat Backend!");
});

app.get(
  "/messages/:convoId",
  protect,
  rateLimit({ name: "messages", limit: 120, windowSeconds: 60 }),
  fetchMessage,
);

app.get(
  "/conversation",
  protect,
  rateLimit({ name: "conversations", limit: 60, windowSeconds: 60 }),
  fetchConversation,
);

app.get(
  "/start/conversation/:receiver_id",
  protect,
  rateLimit({ name: "start-conversation", limit: 20, windowSeconds: 60 }),
  startConversation,
);

app.post(
  "/upload",
  // This endpoint had no authentication at all: anyone on the internet could
  // push files into the project's Cloudinary account.
  protect,
  rateLimit({ name: "upload", limit: 20, windowSeconds: 60 }),
  uploadFile.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        sendError(res, "Please upload a file", 400);
        return;
      }

      const url = await FileUpload(req.file);

      sendSuccess(res, url?.secure_url, "File uploaded successfully");
    } catch (e: any) {
      console.error("[upload] failed:", e?.message ?? e);
      sendError(res, "Upload failed", 500);
    }
  },
);

// multer rejections (size, type) surface here rather than as thrown responses.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (!err) {
    next();
    return;
  }

  if (err?.code === "LIMIT_FILE_SIZE") {
    sendError(res, "File is too large", 413);
    return;
  }

  if (err?.message === "Unsupported file type") {
    sendError(res, err.message, 415);
    return;
  }

  console.error("[http] unhandled error:", err?.message ?? err);
  sendError(res, "Something went wrong", 500);
});

// Was 5900, while the Dockerfile exposed 3001 and compose published 3001:3001
// with no PORT set anywhere, so nothing was reachable on the mapped port.
const PORT = Number(process.env.PORT) || 3001;

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

const io = new Server(server, {
  cors: {
    origin: process.env.SOCKET_ORIGINS?.split(",").map((o) => o.trim()) ?? "*",
  },
  maxHttpBufferSize: 1e6,
});

/** userId -> socket id */
const onlineUser = new Map<string, string>();

/**
 * Attach a verified user to the socket.
 *
 * Sockets were never authenticated: the client announced who it was via
 * "add-user" and every later event trusted the ids in the payload.
 */
async function authenticateSocket(
  socket: Socket,
  token: string,
): Promise<AuthUser> {
  const user = await resolveUserFromToken(token);

  socket.data.user = user;
  onlineUser.set(user.id, socket.id);

  return user;
}

io.use(async (socket, next) => {
  // Preferred path: token supplied in the handshake. Falls through to
  // "add-user" so clients that have not been updated still work.
  const header = socket.handshake.headers.authorization;
  const token =
    (socket.handshake.auth?.token as string | undefined) ??
    (header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined);

  if (!token) {
    next();
    return;
  }

  try {
    await authenticateSocket(socket, token);
    next();
  } catch (err: any) {
    console.error("[socket] handshake auth failed:", err?.message ?? err);
    next(new Error("Not authorized"));
  }
});

io.on("connection", (socket) => {
  socket.on("add-user", async (token: string) => {
    try {
      const user = await authenticateSocket(socket, token);
      socket.emit("user-added", { id: user.id });
    } catch (err: any) {
      console.error("[socket] add-user rejected:", err?.message ?? err);
      socket.emit("error", "Not authorized");
      socket.disconnect(true);
    }
  });

  saveMessage(socket, io, onlineUser);

  socket.on("disconnect", () => {
    // Was onlineUser.delete(socket.id) against a map keyed by user id, so
    // entries were never removed: the map grew without bound and messages kept
    // being routed to dead sockets.
    const user = socket.data.user as AuthUser | undefined;

    if (user?.id && onlineUser.get(user.id) === socket.id) {
      onlineUser.delete(user.id);
    }
  });
});

async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}`);

  io.close();
  server.close();

  await Promise.allSettled([prisma.$disconnect(), disconnectRedis()]);

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
