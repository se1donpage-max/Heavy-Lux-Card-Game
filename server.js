const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const PORT = process.env.PORT || 3000;

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        project: "Heavy Lux Card",
        version: "1.0.0"
    });
});

io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    socket.emit("server:hello", {
        message: "Welcome to Heavy Lux Card"
    });

    socket.on("disconnect", () => {
        console.log("Player disconnected:", socket.id);
    });
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Heavy Lux Card server started on port ${PORT}`);
});
