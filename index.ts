import express from "express";
import { Server } from "socket.io";

const app = express();

app.get("/", function (req, res) {
  res.json({
    message: "Hello World!",
  });
});

const server = app.listen(3000, () => {
  console.log("Listening on port 3000");
});

const io = new Server(server, {
    cors: {
      origin: "*",
    },
  });