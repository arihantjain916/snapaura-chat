import express from "express";
import { Server } from "socket.io";
import {
  fetchUserDetail,
  saveMessage,
  fetchMessage,
  fetchConversation
} from "./messageController";

const app = express();

app.get("/", function (req, res) {
  res.json({
    message: "Hello World!",
  });
});

app.get("/messages/:senderId/:receiverId", fetchMessage);
app.get("/conversation/:senderId", fetchConversation);

const server = app.listen(3000, () => {
  console.log("Listening on port 3000");
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
