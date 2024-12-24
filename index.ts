import express from "express";
import { Server } from "socket.io";
import {
  fetchUserDetail,
  saveMessage,
  fetchMessage,
  fetchConversation,
} from "./messageController";
import {protect} from "./middleware/authMiddleware";

const app = express();

app.get("/", function (req, res) {
  res.status(200).json({
    message: "Welcome to SnapAura Chat Backend!",
  });
});

app.get("/messages/:senderId/:receiverId", protect , fetchMessage);
app.get("/conversation/",protect, fetchConversation);

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
  console.log("a user connected");

  socket.on("add-user", async (data) => {
    const user = await fetchUserDetail(data);
    onlineUser.set(user.id, socket.id);

    console.log(onlineUser);
  });

  saveMessage(socket, io, onlineUser);

  socket.on("disconnect", () => {
    onlineUser.delete(socket.id);
    console.log("user disconnected");
  });
});
