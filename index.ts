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

app.get(
  "/cached",
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = "cached-data";
      const cached = await client.get(key);

      if (cached) {
        res.status(200).json({
          source: "cache",
          data: cached,
        });

        return;
      }

      const freshData = "Here is some fresh data!";
      await client.set(key, freshData, { EX: 10 });

      res.status(200).json({
        source: "database",
        data: freshData,
      });
    } catch (err) {
      next(err);
    }
  }
);
app.get("/messages/:convoId", protect, fetchMessage);
app.get("/conversation", protect, fetchConversation);
app.get("/start/conversation/:receiver_id", protect, startConversation);

const server = app.listen(3001, () => {
  console.log("Listening on port 3001");
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
