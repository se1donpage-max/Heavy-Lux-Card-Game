const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

/*
=========================================================
HEAVY LUX CARD
TELEGRAM + SOCKET.IO FOUNDATION
=========================================================
*/

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        project: "Heavy Lux Card",
        version: "1.0.0",
        telegram: Boolean(BOT_TOKEN),
        socket: true
    });
});

/*
=========================================================
TELEGRAM INIT DATA VALIDATION
=========================================================
*/

function validateTelegramInitData(initData) {
    if (!BOT_TOKEN) {
        return {
            valid: false,
            error: "BOT_TOKEN is not configured"
        };
    }

    if (!initData || typeof initData !== "string") {
        return {
            valid: false,
            error: "Missing Telegram initData"
        };
    }

    const params = new URLSearchParams(initData);

    const receivedHash = params.get("hash");

    if (!receivedHash) {
        return {
            valid: false,
            error: "Missing Telegram hash"
        };
    }

    params.delete("hash");

    const dataCheckString = Array
        .from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    const valid = crypto.timingSafeEqual(
        Buffer.from(calculatedHash, "hex"),
        Buffer.from(receivedHash, "hex")
    );

    if (!valid) {
        return {
            valid: false,
            error: "Invalid Telegram signature"
        };
    }

    let user = null;

    const userString = params.get("user");

    if (userString) {
        try {
            user = JSON.parse(userString);
        } catch {
            return {
                valid: false,
                error: "Invalid Telegram user data"
            };
        }
    }

    return {
        valid: true,
        user
    };
}

/*
=========================================================
TELEGRAM AUTHENTICATION
=========================================================
*/

app.post("/api/auth/telegram", (req, res) => {
    const { initData } = req.body || {};

    const result = validateTelegramInitData(initData);

    if (!result.valid) {
        return res.status(401).json({
            ok: false,
            error: result.error
        });
    }

    const user = result.user;

    if (!user || !user.id) {
        return res.status(401).json({
            ok: false,
            error: "Telegram user not found"
        });
    }

    return res.json({
        ok: true,
        player: {
            telegramId: String(user.id),
            username: user.username || null,
            firstName: user.first_name || "",
            lastName: user.last_name || "",
            languageCode: user.language_code || null
        }
    });
});

/*
=========================================================
SOCKET.IO
=========================================================
*/

io.on("connection", (socket) => {

    console.log("Socket connected:", socket.id);

    socket.emit("server:hello", {
        ok: true,
        project: "Heavy Lux Card",
        socketId: socket.id
    });

    socket.on("disconnect", (reason) => {

        console.log(
            "Socket disconnected:",
            socket.id,
            reason
        );

    });

});

/*
=========================================================
START SERVER
=========================================================
*/

httpServer.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Heavy Lux Card server started on port ${PORT}`
    );

    console.log(
        `Telegram authentication: ${
            BOT_TOKEN ? "configured" : "NOT CONFIGURED"
        }`
    );

});
