import express from "express";

const app = express();

app.get("/", function (req, res) {
  res.json({
    message: "Hello World!",
  });
});

const server = app.listen(3000, () => {
  console.log("Listening on port 3000");
});
