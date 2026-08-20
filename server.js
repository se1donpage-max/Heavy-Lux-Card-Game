const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

/*
=========================================================
DATABASE
=========================================================
*/

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on("error", (error) => {
        console.error("PostgreSQL error:", error);
    });
}

/*
=========================================================
STATIC FILES
=========================================================
*/

app.use(express.static(__dirname));

/*
=========================================================
SOCKET.IO
=========================================================
*/

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },

    transports: [
        "websocket",
        "polling"
    ],

    pingInterval: 25000,
    pingTimeout: 20000,

    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true
    }
});

/*
=========================================================
DATA
=========================================================
*/

const players = new Map();
const rooms = new Map();

/*
player:

{
    playerId,
    telegramId,
    name,
    username,
    socketId,
    connected,
    roomId
}

room:

{
    id,
    players: [],
    status,
    turnPlayerId,
    moves
}
*/

/*
=========================================================
HELPERS
=========================================================
*/

function createId(length = 8) {
    return crypto
        .randomBytes(16)
        .toString("hex")
        .slice(0, length);
}

function cleanName(name) {
    const value = String(name || "")
        .trim()
        .slice(0, 30);

    return value || "Игрок";
}

function getPlayer(playerId) {
    return players.get(playerId);
}

function getRoom(roomId) {
    return rooms.get(roomId);
}

/*
=========================================================
TELEGRAM USER
=========================================================
*/

function parseTelegramUser(initData) {
    if (!initData) {
        return null;
    }

    try {
        const params = new URLSearchParams(initData);
        const user = params.get("user");

        if (!user) {
            return null;
        }

        return JSON.parse(user);
    } catch (error) {
        console.error(
            "Telegram user parse error:",
            error
        );

        return null;
    }
}

/*
=========================================================
AUTHENTICATION
=========================================================
*/

function authenticate(socket) {
    const initData =
        socket.handshake.auth?.initData || "";

    const telegramUser =
        parseTelegramUser(initData);

    /*
    Telegram
    */

    if (
        telegramUser &&
        telegramUser.id
    ) {
        const telegramId =
            String(telegramUser.id);

        let player = null;

        for (const item of players.values()) {
            if (
                item.telegramId === telegramId
            ) {
                player = item;
                break;
            }
        }

        if (!player) {
            player = {
                playerId: createId(12),

                telegramId,

                name: cleanName(
                    telegramUser.first_name ||
                    telegramUser.username ||
                    "Игрок"
                ),

                username:
                    telegramUser.username || "",

                socketId: socket.id,

                connected: true,

                roomId: null
            };

            players.set(
                player.playerId,
                player
            );
        } else {
            player.socketId = socket.id;
            player.connected = true;

            player.name = cleanName(
                telegramUser.first_name ||
                telegramUser.username ||
                player.name
            );

            player.username =
                telegramUser.username ||
                player.username ||
                "";
        }

        savePlayer(player);

        return player;
    }

    /*
    Тест вне Telegram
    */

    const testPlayerId =
        socket.handshake.auth?.testPlayerId ||
        `test_${socket.id}`;

    let player =
        players.get(testPlayerId);

    if (!player) {
        player = {
            playerId: testPlayerId,

            telegramId: null,

            name:
                "Игрок " +
                testPlayerId.slice(-4),

            username: "",

            socketId: socket.id,

            connected: true,

            roomId: null
        };

        players.set(
            player.playerId,
            player
        );
    } else {
        player.socketId = socket.id;
        player.connected = true;
    }

    return player;
}

/*
=========================================================
DATABASE
=========================================================
*/

async function initDatabase() {
    if (!pool) {
        console.log(
            "PostgreSQL: DATABASE_URL not configured"
        );

        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                player_id TEXT PRIMARY KEY,
                telegram_id TEXT UNIQUE,
                username TEXT,
                player_name TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log(
            "PostgreSQL: ready"
        );
    } catch (error) {
        console.error(
            "PostgreSQL initialization error:",
            error
        );
    }
}

async function savePlayer(player) {
    if (!pool) {
        return;
    }

    try {
        await pool.query(
            `
            INSERT INTO players
            (
                player_id,
                telegram_id,
                username,
                player_name,
                updated_at
            )
            VALUES
            ($1, $2, $3, $4, NOW())

            ON CONFLICT (player_id)
            DO UPDATE SET
                telegram_id = EXCLUDED.telegram_id,
                username = EXCLUDED.username,
                player_name = EXCLUDED.player_name,
                updated_at = NOW()
            `,
            [
                player.playerId,
                player.telegramId,
                player.username,
                player.name
            ]
        );
    } catch (error) {
        console.error(
            "savePlayer error:",
            error
        );
    }
}

/*
=========================================================
ROOM PUBLIC STATE
=========================================================
*/

function publicRoom(room) {
    return {
        id: room.id,

        status: room.status,

        playersCount:
            room.players.length,

        maxPlayers: 2,

        players:
            room.players.map((p) => ({
                playerId: p.playerId,
                name: p.name,
                connected: p.connected
            }))
    };
}

/*
=========================================================
GAME STATE
=========================================================
*/

function gameState(room, playerId) {
    const me =
        room.players.find(
            (p) =>
                p.playerId === playerId
        );

    const opponent =
        room.players.find(
            (p) =>
                p.playerId !== playerId
        );

    let turn = "WAITING";

    if (
        room.status === "playing"
    ) {
        if (
            room.turnPlayerId ===
            playerId
        ) {
            turn = "YOUR_TURN";
        } else {
            turn = "OPPONENT_TURN";
        }
    }

    return {
        roomId: room.id,

        status: room.status,

        turn,

        turnPlayerId:
            room.turnPlayerId,

        me: me
            ? {
                playerId: me.playerId,
                name: me.name,
                connected: me.connected
            }
            : null,

        opponent: opponent
            ? {
                playerId:
                    opponent.playerId,
                name: opponent.name,
                connected:
                    opponent.connected
            }
            : null,

        players:
            room.players.map((p) => ({
                playerId: p.playerId,
                name: p.name,
                connected: p.connected
            })),

        moves: room.moves
    };
}

/*
=========================================================
SEND ROOM STATE
=========================================================
*/

function sendRoomState(room) {
    if (!room) {
        return;
    }

    room.players.forEach((roomPlayer) => {
        const player =
            players.get(
                roomPlayer.playerId
            );

        if (!player) {
            return;
        }

        if (!player.socketId) {
            return;
        }

        io.to(
            player.socketId
        ).emit(
            "game_state",
            gameState(
                room,
                player.playerId
            )
        );
    });
}

/*
=========================================================
ROOM LIST
=========================================================
*/

function sendRoomList() {
    const list =
        Array.from(
            rooms.values()
        ).map(publicRoom);

    io.emit(
        "rooms_list",
        list
    );
}

/*
=========================================================
CREATE ROOM
=========================================================
*/

function createRoom(player) {
    if (player.roomId) {
        return {
            ok: false,
            error:
                "Вы уже находитесь в комнате."
        };
    }

    let roomId;

    do {
        roomId =
            createId(6)
                .toUpperCase();
    } while (
        rooms.has(roomId)
    );

    const room = {
        id: roomId,

        players: [
            {
                playerId:
                    player.playerId,

                name:
                    player.name,

                socketId:
                    player.socketId,

                connected: true
            }
        ],

        status: "waiting",

        /*
        Пока один игрок —
        хода нет.
        */

        turnPlayerId: null,

        moves: []
    };

    rooms.set(
        room.id,
        room
    );

    player.roomId =
        room.id;

    return {
        ok: true,
        room
    };
}

/*
=========================================================
JOIN ROOM
=========================================================
*/

function joinRoom(
    player,
    roomId
) {
    roomId =
        String(roomId || "")
            .trim()
            .toUpperCase();

    const room =
        rooms.get(roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (player.roomId) {
        return {
            ok: false,
            error:
                "Вы уже находитесь в комнате."
        };
    }

    if (
        room.players.length >= 2
    ) {
        return {
            ok: false,
            error:
                "Комната уже заполнена."
        };
    }

    room.players.push({
        playerId:
            player.playerId,

        name:
            player.name,

        socketId:
            player.socketId,

        connected: true
    });

    player.roomId =
        room.id;

    /*
    =====================================================
    САМОЕ ВАЖНОЕ

    Первый игрок получает первый ход.

    Не socket.id.
    Не клиент.
    Не случайное значение.

    Именно playerId первого игрока.
    =====================================================
    */

    const firstPlayer =
        room.players[0];

    room.turnPlayerId =
        firstPlayer.playerId;

    room.status =
        "playing";

    room.moves = [];

    return {
        ok: true,
        room
    };
}

/*
=========================================================
SWITCH TURN
=========================================================
*/

function switchTurn(room) {
    if (
        !room ||
        room.players.length !== 2
    ) {
        return;
    }

    const currentIndex =
        room.players.findIndex(
            (p) =>
                p.playerId ===
                room.turnPlayerId
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
        room.players[
            nextIndex
        ].playerId;
}

/*
=========================================================
MAKE TEST MOVE
=========================================================
*/

function makeMove(
    player,
    data
) {
    if (!player.roomId) {
        return {
            ok: false,
            error:
                "Вы не находитесь в комнате."
        };
    }

    const room =
        rooms.get(
            player.roomId
        );

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (
        room.status !==
        "playing"
    ) {
        return {
            ok: false,
            error:
                "Игра ещё не началась."
        };
    }

    /*
    Сервер проверяет,
    действительно ли игрок имеет ход.
    */

    if (
        room.turnPlayerId !==
        player.playerId
    ) {
        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }

    room.moves.push({
        playerId:
            player.playerId,

        type:
            data?.type || "test",

        timestamp:
            Date.now()
    });

    /*
    Передаём ход второму игроку.
    */

    switchTurn(room);

    return {
        ok: true
    };
}

/*
=========================================================
SOCKET MIDDLEWARE
=========================================================
*/

io.use(
    (socket, next) => {
        try {
            const player =
                authenticate(socket);

            socket.playerId =
                player.playerId;

            next();
        } catch (error) {
            console.error(
                "Socket auth error:",
                error
            );

            next(
                new Error(
                    "Authentication failed"
                )
            );
        }
    }
);

/*
=========================================================
SOCKET CONNECTION
=========================================================
*/

io.on(
    "connection",
    (socket) => {

        const player =
            getPlayer(
                socket.playerId
            );

        if (!player) {
            socket.disconnect(
                true
            );

            return;
        }

        player.socketId =
            socket.id;

        player.connected =
            true;

        console.log(
            "Player connected:",
            player.playerId,
            player.name
        );

        /*
        =================================================
        RECONNECT
        =================================================
        */

        if (player.roomId) {

            const room =
                rooms.get(
                    player.roomId
                );

            if (room) {

                const roomPlayer =
                    room.players.find(
                        (p) =>
                            p.playerId ===
                            player.playerId
                    );

                if (roomPlayer) {

                    roomPlayer.socketId =
                        socket.id;

                    roomPlayer.connected =
                        true;

                    roomPlayer.name =
                        player.name;
                }

                socket.join(
                    room.id
                );

                socket.emit(
                    "game_state",
                    gameState(
                        room,
                        player.playerId
                    )
                );

                sendRoomState(
                    room
                );
            }
        }

        /*
        =================================================
        PROFILE
        =================================================
        */

        socket.on(
            "get_profile",
            () => {

                socket.emit(
                    "profile",
                    {
                        playerId:
                            player.playerId,

                        telegramId:
                            player.telegramId,

                        name:
                            player.name,

                        username:
                            player.username
                    }
                );
            }
        );

        /*
        =================================================
        ROOMS
        =================================================
        */

        socket.on(
            "get_rooms",
            () => {

                socket.emit(
                    "rooms_list",

                    Array.from(
                        rooms.values()
                    ).map(
                        publicRoom
                    )
                );
            }
        );

        /*
        =================================================
        CREATE ROOM
        =================================================
        */

        socket.on(
            "create_room",
            () => {

                const result =
                    createRoom(
                        player
                    );

                if (!result.ok) {

                    socket.emit(
                        "error_message",
                        result.error
                    );

                    return;
                }

                const room =
                    result.room;

                socket.join(
                    room.id
                );

                socket.emit(
                    "room_created",
                    publicRoom(room)
                );

                sendRoomState(
                    room
                );

                sendRoomList();

                console.log(
                    "Room created:",
                    room.id
                );
            }
        );

        /*
        =================================================
        JOIN ROOM
        =================================================
        */

        socket.on(
            "join_room",
            (roomId) => {

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

                const room =
                    result.room;

                socket.join(
                    room.id
                );

                /*
                ОЧЕНЬ ВАЖНО:

                Здесь сразу отправляем
                состояние обоим игрокам.

                Игрок №1:
                YOUR_TURN

                Игрок №2:
                OPPONENT_TURN
                */

                sendRoomState(
                    room
                );

                sendRoomList();

                console.log(
                    "Player joined:",
                    player.name,
                    room.id
                );

                console.log(
                    "Current turn:",
                    room.turnPlayerId
                );
            }
        );

        /*
        =================================================
        MAKE MOVE
        =================================================
        */

        socket.on(
            "make_move",
            (data) => {

                const result =
                    makeMove(
                        player,
                        data
                    );

                if (!result.ok) {

                    socket.emit(
                        "move_error",
                        result.error
                    );

                    return;
                }

                const room =
                    rooms.get(
                        player.roomId
                    );

                if (!room) {
                    return;
                }

                /*
                Отправляем новое состояние
                обоим игрокам.
                */

                sendRoomState(
                    room
                );
            }
        );

        /*
        =================================================
        LEAVE ROOM
        =================================================
        */

        socket.on(
            "leave_room",
            () => {

                const roomId =
                    player.roomId;

                if (!roomId) {
                    return;
                }

                const room =
                    rooms.get(
                        roomId
                    );

                if (!room) {

                    player.roomId =
                        null;

                    socket.emit(
                        "left_room"
                    );

                    return;
                }

                room.players =
                    room.players.filter(
                        (p) =>
                            p.playerId !==
                            player.playerId
                    );

                player.roomId =
                    null;

                socket.leave(
                    room.id
                );

                /*
                Если никого нет —
                удаляем комнату.
                */

                if (
                    room.players.length ===
                    0
                ) {

                    rooms.delete(
                        room.id
                    );

                } else {

                    /*
                    Остался один игрок.
                    Возвращаем комнату
                    в ожидание.
                    */

                    room.status =
                        "waiting";

                    room.turnPlayerId =
                        null;

                    room.moves = [];

                    room.players[0]
                        .connected = true;
                }

                socket.emit(
                    "left_room"
                );

                sendRoomList();

                if (
                    rooms.has(room.id)
                ) {
                    sendRoomState(
                        room
                    );
                }
            }
        );

        /*
        =================================================
        DISCONNECT
        =================================================
        */

        socket.on(
            "disconnect",
            () => {

                const current =
                    players.get(
                        player.playerId
                    );

                if (!current) {
                    return;
                }

                /*
                Если уже произошло
                новое подключение,
                старый socket ничего
                не меняет.
                */

                if (
                    current.socketId !==
                    socket.id
                ) {
                    return;
                }

                current.connected =
                    false;

                console.log(
                    "Player disconnected:",
                    current.playerId
                );

                if (
                    current.roomId
                ) {

                    const room =
                        rooms.get(
                            current.roomId
                        );

                    if (room) {

                        const roomPlayer =
                            room.players.find(
                                (p) =>
                                    p.playerId ===
                                    current.playerId
                            );

                        if (roomPlayer) {

                            roomPlayer.connected =
                                false;
                        }

                        /*
                        Комнату НЕ удаляем.

                        Игрок сможет
                        переподключиться.
                        */

                        sendRoomState(
                            room
                        );
                    }
                }
            }
        );
    }
);

/*
=========================================================
HTTP ROUTES
=========================================================
*/

/*
Главная страница.

ВАЖНО:
index.html должен лежать рядом
с server.js.
*/

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );
    }
);

/*
Health check.
*/

app.get(
    "/api/health",
    async (req, res) => {

        let database =
            "disabled";

        if (pool) {

            try {

                await pool.query(
                    "SELECT 1"
                );

                database =
                    "connected";

            } catch (error) {

                database =
                    "error";
            }
        }

        res.json({
            ok: true,

            service:
                "Heavy Lux Card",

            database,

            rooms:
                rooms.size,

            players:
                players.size,

            time:
                new Date().toISOString()
        });
    }
);

/*
=========================================================
START
=========================================================
*/

async function start() {

    await initDatabase();

    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                "Heavy Lux Card server started on port",
                PORT
            );

            console.log(
                "Socket.IO: ready"
            );

            console.log(
                "HTTP: ready"
            );

            console.log(
                "Telegram authentication: configured"
            );
        }
    );
}

start();
