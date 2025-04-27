import express, { NextFunction, Request, Response } from "express";
import { Server } from "socket.io";
import {
  fetchUserDetail,
  saveMessage,
  fetchMessage,
  fetchConversation,
  startConversation,
} from "./messageController";
import { protect } from "./middleware/authMiddleware";
import { createClient } from "redis";
import multer from "multer";
import { FileUpload } from "./fileUplaod";

const app = express();

const client = createClient({
  url: process.env.REDIS_URL,
});

client.connect().catch(console.error);

app.get("/", function (req, res) {
  res.status(200).json({
    message: "Welcome to SnapAura Chat Backend!",
  });
});

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200000000 },
});

app.get("/messages/:convoId", protect, fetchMessage);
app.get("/conversation", protect, fetchConversation);
app.get("/start/conversation/:receiver_id", protect, startConversation);

app.post(
  "/upload",
  uploadFile.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(500).json({
          status: false,
          data: "Please uplaod file",
        });
        return;
      }

      const url = await FileUpload(req.file!);
      res.status(200).json({
        status: true,
        data: url?.secure_url,
      });
    } catch (e: any) {
      res.status(500).json({
        status: false,
        data: e.message,
      });
      return;
    }
  }
);

const PORT = process.env.PORT;

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const onlineUser = new Map();
io.on("connection", (socket) => {
  socket.on("add-user", async (data: string) => {
    const user = await fetchUserDetail(data, client);
    onlineUser.set(user.id, socket.id);
  });

  saveMessage(socket, io, onlineUser);

  socket.on("disconnect", () => {
    onlineUser.delete(socket.id);
  });
});
