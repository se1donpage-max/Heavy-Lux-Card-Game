const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* =========================================================
   POSTGRESQL
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on("error", (err) => {
        console.error("PostgreSQL error:", err);
    });
}

/* =========================================================
   SOCKET.IO
========================================================= */

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 20000
});

/* =========================================================
   CONFIG
========================================================= */

const MAX_ROOMS = 1000;
const MAX_CHAT_MESSAGES = 50;

/*
    Комната хранится в памяти сервера.

    Это нормально для текущего этапа:
    PostgreSQL будет использоваться для игроков/профилей.

    Позже при необходимости можно вынести комнаты
    в Redis или PostgreSQL.
*/

/* =========================================================
   ROOMS
========================================================= */

const rooms = new Map();

/*
room = {
    id,
    hostPlayerId,
    players: [
        {
            playerId,
            socketId,
            name,
            connected
        }
    ],

    status: "waiting" | "playing" | "finished",

    turnPlayerId,

    game: {
        startedAt,
        moves
    },

    chat: []
}
*/

/* =========================================================
   PLAYERS
========================================================= */

const players = new Map();

/*
player = {
    playerId,
    telegramId,
    name,
    socketId,
    connected,
    roomId
}
*/

/* =========================================================
   HELPERS
========================================================= */

function generateId(length = 8) {
    return crypto
        .randomBytes(16)
        .toString("hex")
        .slice(0, length);
}

function normalizeName(name) {
    if (!name) {
        return "Игрок";
    }

    return String(name)
        .trim()
        .slice(0, 24);
}

function getPlayer(playerId) {
    return players.get(playerId) || null;
}

function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

function getRoomPlayers(room) {
    return room.players.map((player) => ({
        playerId: player.playerId,
        name: player.name,
        connected: player.connected
    }));
}

function getPublicRoom(room) {
    return {
        id: room.id,
        status: room.status,
        playersCount: room.players.length,
        maxPlayers: 2,
        players: getRoomPlayers(room)
    };
}

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
    if (!pool) {
        console.log("PostgreSQL: DATABASE_URL not configured");
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                player_id TEXT PRIMARY KEY,
                telegram_id TEXT UNIQUE,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log("PostgreSQL: ready");
    } catch (error) {
        console.error("PostgreSQL initialization error:", error);
    }
}

async function savePlayer(player) {
    if (!pool) {
        return;
    }

    try {
        await pool.query(
            `
            INSERT INTO players (
                player_id,
                telegram_id,
                username,
                first_name,
                last_name,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, NOW())

            ON CONFLICT (player_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                updated_at = NOW()
            `,
            [
                player.playerId,
                player.telegramId,
                player.username || "",
                player.firstName || "",
                player.lastName || ""
            ]
        );
    } catch (error) {
        console.error("savePlayer error:", error);
    }
}

/* =========================================================
   TELEGRAM
========================================================= */

function getTelegramUserFromInitData(initData) {
    if (!initData) {
        return null;
    }

    try {
        const params = new URLSearchParams(initData);

        const userRaw = params.get("user");

        if (!userRaw) {
            return null;
        }

        return JSON.parse(userRaw);
    } catch (error) {
        console.error("Telegram initData parse error:", error);
        return null;
    }
}

/*
    На текущем этапе мы принимаем Telegram WebApp user.

    В production обязательно можно включить полноценную
    проверку hash initData через BOT_TOKEN.

    Чтобы текущая версия не ломалась при тестировании
    через Telegram, user берётся из initData.
*/

function authenticatePlayer(socket) {
    const initData =
        socket.handshake.auth?.initData ||
        "";

    const telegramUser =
        getTelegramUserFromInitData(initData);

    /*
        Если Telegram user есть — используем его.
    */

    if (telegramUser && telegramUser.id) {
        const telegramId = String(telegramUser.id);

        let player = null;

        for (const existing of players.values()) {
            if (existing.telegramId === telegramId) {
                player = existing;
                break;
            }
        }

        if (!player) {
            player = {
                playerId: generateId(12),
                telegramId,
                username: telegramUser.username || "",
                firstName: telegramUser.first_name || "",
                lastName: telegramUser.last_name || "",
                name: normalizeName(
                    telegramUser.first_name ||
                    telegramUser.username ||
                    "Игрок"
                ),
                socketId: socket.id,
                connected: true,
                roomId: null
            };

            players.set(player.playerId, player);
        } else {
            player.socketId = socket.id;
            player.connected = true;

            player.name = normalizeName(
                telegramUser.first_name ||
                telegramUser.username ||
                player.name
            );
        }

        savePlayer(player);

        return player;
    }

    /*
        Резервный режим для тестирования.
    */

    const testId =
        socket.handshake.auth?.testPlayerId ||
        `test_${socket.id}`;

    let player = players.get(testId);

    if (!player) {
        player = {
            playerId: testId,
            telegramId: null,
            username: "",
            firstName: "",
            lastName: "",
            name: `Игрок ${testId.slice(-4)}`,
            socketId: socket.id,
            connected: true,
            roomId: null
        };

        players.set(player.playerId, player);
    } else {
        player.socketId = socket.id;
        player.connected = true;
    }

    return player;
}

/* =========================================================
   GAME STATE
========================================================= */

function getGameState(room, playerId) {
    if (!room) {
        return null;
    }

    const me = room.players.find(
        (player) => player.playerId === playerId
    );

    const opponent = room.players.find(
        (player) => player.playerId !== playerId
    );

    let turn = "WAITING";

    if (room.status === "playing") {
        if (room.turnPlayerId === playerId) {
            turn = "YOUR_TURN";
        } else {
            turn = "OPPONENT_TURN";
        }
    }

    return {
        roomId: room.id,

        status: room.status,

        turn,

        turnPlayerId: room.turnPlayerId,

        me: me
            ? {
                playerId: me.playerId,
                name: me.name,
                connected: me.connected
            }
            : null,

        opponent: opponent
            ? {
                playerId: opponent.playerId,
                name: opponent.name,
                connected: opponent.connected
            }
            : null,

        players: getRoomPlayers(room),

        moves: room.game.moves
    };
}

/* =========================================================
   SEND ROOM STATE
========================================================= */

function emitRoomState(room) {
    if (!room) {
        return;
    }

    for (const roomPlayer of room.players) {
        const player = players.get(roomPlayer.playerId);

        if (!player) {
            continue;
        }

        if (!player.socketId) {
            continue;
        }

        io.to(player.socketId).emit(
            "game_state",
            getGameState(room, player.playerId)
        );
    }
}

/* =========================================================
   ROOM LIST
========================================================= */

function emitRoomList() {
    const list = [];

    for (const room of rooms.values()) {
        list.push(getPublicRoom(room));
    }

    io.emit("rooms_list", list);
}

/* =========================================================
   CREATE ROOM
========================================================= */

function createRoom(player) {
    if (rooms.size >= MAX_ROOMS) {
        return {
            ok: false,
            error: "Слишком много комнат."
        };
    }

    if (player.roomId) {
        return {
            ok: false,
            error: "Вы уже находитесь в комнате."
        };
    }

    const roomId = generateId(6).toUpperCase();

    const room = {
        id: roomId,

        hostPlayerId: player.playerId,

        players: [
            {
                playerId: player.playerId,
                socketId: player.socketId,
                name: player.name,
                connected: true
            }
        ],

        status: "waiting",

        /*
            ВАЖНО:

            Здесь НЕТ turnPlayerId.

            Пока второй игрок не вошёл,
            ход не начинается.
        */

        turnPlayerId: null,

        game: {
            startedAt: null,
            moves: []
        },

        chat: []
    };

    rooms.set(roomId, room);

    player.roomId = roomId;

    return {
        ok: true,
        room
    };
}

/* =========================================================
   JOIN ROOM
========================================================= */

function joinRoom(player, roomId) {
    if (!roomId) {
        return {
            ok: false,
            error: "Не указан ID комнаты."
        };
    }

    roomId = String(roomId).trim().toUpperCase();

    const room = rooms.get(roomId);

    if (!room) {
        return {
            ok: false,
            error: "Комната не найдена."
        };
    }

    if (player.roomId) {
        return {
            ok: false,
            error: "Вы уже находитесь в комнате."
        };
    }

    if (room.players.length >= 2) {
        return {
            ok: false,
            error: "Комната уже заполнена."
        };
    }

    /*
        Второй игрок.
    */

    room.players.push({
        playerId: player.playerId,
        socketId: player.socketId,
        name: player.name,
        connected: true
    });

    player.roomId = room.id;

    /*
        =====================================================
        КРИТИЧЕСКИЙ МОМЕНТ
        =====================================================

        Первый игрок всегда получает первый ход.

        Не socket.id.

        Не клиент.

        Не случайное значение.

        Сервер хранит конкретный playerId.
    */

    const firstPlayer = room.players[0];

    room.turnPlayerId = firstPlayer.playerId;

    room.status = "playing";

    room.game.startedAt = Date.now();

    room.game.moves = [];

    return {
        ok: true,
        room
    };
}

/* =========================================================
   LEAVE ROOM
========================================================= */

function leaveRoom(player) {
    if (!player.roomId) {
        return;
    }

    const room = rooms.get(player.roomId);

    if (!room) {
        player.roomId = null;
        return;
    }

    room.players = room.players.filter(
        (p) => p.playerId !== player.playerId
    );

    player.roomId = null;

    /*
        Если в комнате никого не осталось —
        удаляем комнату.
    */

    if (room.players.length === 0) {
        rooms.delete(room.id);
        emitRoomList();
        return;
    }

    /*
        Если один игрок остался —
        возвращаем комнату в ожидание.
    */

    room.status = "waiting";

    room.turnPlayerId = null;

    room.game.startedAt = null;

    room.game.moves = [];

    room.hostPlayerId =
        room.players[0].playerId;

    emitRoomState(room);
    emitRoomList();
}

/* =========================================================
   SWITCH TURN
========================================================= */

function switchTurn(room) {
    if (!room || room.players.length !== 2) {
        return;
    }

    const currentIndex =
        room.players.findIndex(
            (player) =>
                player.playerId === room.turnPlayerId
        );

    if (currentIndex === -1) {
        room.turnPlayerId =
            room.players[0].playerId;

        return;
    }

    const nextIndex =
        currentIndex === 0
            ? 1
            : 0;

    room.turnPlayerId =
        room.players[nextIndex].playerId;
}

/* =========================================================
   MAKE MOVE
========================================================= */

function makeMove(player, moveData) {
    if (!player.roomId) {
        return {
            ok: false,
            error: "Вы не находитесь в комнате."
        };
    }

    const room = rooms.get(player.roomId);

    if (!room) {
        return {
            ok: false,
            error: "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error: "Игра ещё не началась."
        };
    }

    /*
        СЕРВЕРНАЯ ПРОВЕРКА ХОДА
    */

    if (room.turnPlayerId !== player.playerId) {
        return {
            ok: false,
            error: "Сейчас ход противника."
        };
    }

    /*
        Сохраняем ход.
    */

    room.game.moves.push({
        playerId: player.playerId,
        move: moveData || {},
        timestamp: Date.now()
    });

    /*
        Для тестирования просто переключаем ход.

        Позже здесь будет полноценная логика Дурака:
        - карты
        - атака
        - защита
        - битые карты
        - взятие
        - колода
        - победа
        - поражение
    */

    switchTurn(room);

    return {
        ok: true
    };
}

/* =========================================================
   SOCKET AUTH
========================================================= */

io.use((socket, next) => {
    try {
        const player = authenticatePlayer(socket);

        socket.playerId = player.playerId;

        next();
    } catch (error) {
        console.error("Socket authentication error:", error);

        next(
            new Error("Authentication failed")
        );
    }
});

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on("connection", (socket) => {
    const player = getPlayer(socket.playerId);

    if (!player) {
        socket.disconnect(true);
        return;
    }

    player.socketId = socket.id;
    player.connected = true;

    console.log(
        `Player connected: ${player.playerId} / ${player.name}`
    );

    /*
        Если игрок уже был в комнате —
        восстанавливаем его соединение.
    */

    if (player.roomId) {
        const room = rooms.get(player.roomId);

        if (room) {
            const roomPlayer = room.players.find(
                (p) =>
                    p.playerId === player.playerId
            );

            if (roomPlayer) {
                roomPlayer.socketId = socket.id;
                roomPlayer.connected = true;
                roomPlayer.name = player.name;
            }

            socket.join(room.id);

            socket.emit(
                "game_state",
                getGameState(
                    room,
                    player.playerId
                )
            );

            emitRoomState(room);
        }
    }

    /*
        =====================================================
        GET PROFILE
        =====================================================
    */

    socket.on("get_profile", () => {
        socket.emit("profile", {
            playerId: player.playerId,
            telegramId: player.telegramId,
            name: player.name,
            username: player.username,
            firstName: player.firstName,
            lastName: player.lastName
        });
    });

    /*
        =====================================================
        GET ROOMS
        =====================================================
    */

    socket.on("get_rooms", () => {
        const list = [];

        for (const room of rooms.values()) {
            list.push(getPublicRoom(room));
        }

        socket.emit("rooms_list", list);
    });

    /*
        =====================================================
        CREATE ROOM
        =====================================================
    */

    socket.on("create_room", () => {
        const result = createRoom(player);

        if (!result.ok) {
            socket.emit("error_message", result.error);
            return;
        }

        const room = result.room;

        socket.join(room.id);

        socket.emit(
            "room_created",
            getPublicRoom(room)
        );

        emitRoomState(room);
        emitRoomList();

        console.log(
            `Room created: ${room.id} by ${player.name}`
        );
    });

    /*
        =====================================================
        JOIN ROOM
        =====================================================
    */

    socket.on("join_room", (roomId) => {
        const result =
            joinRoom(
                player,
                roomId
            );

        if (!result.ok) {
            socket.emit(
                "error_message",
                result.error
            );

            return;
        }

        const room = result.room;

        socket.join(room.id);

        /*
            ВАЖНО:
            После входа второго игрока
            оба клиента получают НОВОЕ состояние.

            Первый:
                YOUR_TURN

            Второй:
                OPPONENT_TURN
        */

        emitRoomState(room);
        emitRoomList();

        console.log(
            `Player ${player.name} joined room ${room.id}`
        );

        console.log(
            `TURN -> ${room.turnPlayerId}`
        );
    });

    /*
        =====================================================
        LEAVE ROOM
        =====================================================
    */

    socket.on("leave_room", () => {
        const oldRoomId = player.roomId;

        leaveRoom(player);

        if (oldRoomId) {
            socket.leave(oldRoomId);
        }

        socket.emit("left_room");
    });

    /*
        =====================================================
        MAKE MOVE
        =====================================================
    */

    socket.on("make_move", (moveData) => {
        const result =
            makeMove(
                player,
                moveData
            );

        if (!result.ok) {
            socket.emit(
                "move_error",
                result.error
            );

            return;
        }

        const room =
            rooms.get(player.roomId);

        if (!room) {
            return;
        }

        /*
            После хода оба получают новое состояние.
        */

        emitRoomState(room);

        console.log(
            `MOVE room=${room.id} player=${player.playerId}`
        );

        console.log(
            `NEXT TURN=${room.turnPlayerId}`
        );
    });

    /*
        =====================================================
        CHAT
        =====================================================
    */

    socket.on("chat_message", (text) => {
        if (!player.roomId) {
            return;
        }

        const room =
            rooms.get(player.roomId);

        if (!room) {
            return;
        }

        const message =
            String(text || "")
                .trim()
                .slice(0, 200);

        if (!message) {
            return;
        }

        const chatMessage = {
            id: generateId(10),
            playerId: player.playerId,
            name: player.name,
            text: message,
            timestamp: Date.now()
        };

        room.chat.push(chatMessage);

        if (
            room.chat.length >
            MAX_CHAT_MESSAGES
        ) {
            room.chat.shift();
        }

        io.to(room.id).emit(
            "chat_message",
            chatMessage
        );
    });

    /*
        =====================================================
        DISCONNECT
        =====================================================
    */

    socket.on("disconnect", () => {
        const currentPlayer =
            players.get(player.playerId);

        if (!currentPlayer) {
            return;
        }

        /*
            Проверяем, что это действительно
            последнее соединение игрока.

            Это важно при переподключении.
        */

        if (
            currentPlayer.socketId !==
            socket.id
        ) {
            return;
        }

        currentPlayer.connected = false;

        console.log(
            `Player disconnected: ${player.playerId}`
        );

        /*
            Игрок НЕ удаляется из комнаты.

            Благодаря этому он сможет
            переподключиться и продолжить.
        */

        if (currentPlayer.roomId) {
            const room =
                rooms.get(
                    currentPlayer.roomId
                );

            if (room) {
                const roomPlayer =
                    room.players.find(
                        (p) =>
                            p.playerId ===
                            currentPlayer.playerId
                    );

                if (roomPlayer) {
                    roomPlayer.connected = false;
                }

                emitRoomState(room);
            }
        }
    });
});

/* =========================================================
   HTTP ROUTES
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(
        require("path").join(
            __dirname,
            "index.html"
        )
    );
});

app.get("/api/health", async (req, res) => {
    let database = "disabled";

    if (pool) {
        try {
            await pool.query("SELECT 1");
            database = "connected";
        } catch (error) {
            database = "error";
        }
    }

    res.json({
        ok: true,
        service: "Heavy Lux Card",
        database,
        rooms: rooms.size,
        players: players.size,
        time: new Date().toISOString()
    });
});

/* =========================================================
   START
========================================================= */

async function startServer() {
    await initDatabase();

    server.listen(
        PORT,
        "0.0.0.0",
        () => {
            console.log(
                `Heavy Lux Card server started on port ${PORT}`
            );

            console.log(
                `Telegram authentication: configured`
            );

            console.log(
                `Socket.IO: ready`
            );
        }
    );
}

startServer();
