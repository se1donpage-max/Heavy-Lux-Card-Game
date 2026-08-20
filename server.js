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

/*
=========================================================
MIDDLEWARE
=========================================================
*/

app.use(cors());
app.use(express.json());

/*
=========================================================
POSTGRESQL
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
GAME DATA
=========================================================
*/

const players = new Map();
const rooms = new Map();

/*
PLAYER

{
    playerId,
    telegramId,
    name,
    username,
    socketId,
    connected,
    roomId
}

ROOM

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
        const userJson = params.get("user");

        if (!userJson) {
            return null;
        }

        const user = JSON.parse(userJson);

        if (!user || !user.id) {
            return null;
        }

        return user;

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
PLAYER FIND
=========================================================
*/

function findPlayerByTelegramId(telegramId) {
    for (const player of players.values()) {
        if (
            player.telegramId &&
            player.telegramId === telegramId
        ) {
            return player;
        }
    }

    return null;
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
    =====================================================
    TELEGRAM
    =====================================================
    */

    if (telegramUser) {

        const telegramId =
            String(telegramUser.id);

        let player =
            findPlayerByTelegramId(
                telegramId
            );

        if (!player) {

            player = {
                playerId:
                    createId(12),

                telegramId,

                name:
                    cleanName(
                        telegramUser.first_name ||
                        telegramUser.username ||
                        "Игрок"
                    ),

                username:
                    telegramUser.username || "",

                socketId:
                    socket.id,

                connected: true,

                roomId: null
            };

            players.set(
                player.playerId,
                player
            );

        } else {

            /*
            Игрок уже существует.

            Обновляем только
            текущее соединение.
            */

            player.socketId =
                socket.id;

            player.connected =
                true;

            player.name =
                cleanName(
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
    =====================================================
    TEST MODE
    =====================================================
    */

    const testPlayerId =
        String(
            socket.handshake.auth?.testPlayerId ||
            `test_${socket.id}`
        );

    let player =
        players.get(
            testPlayerId
        );

    if (!player) {

        player = {
            playerId:
                testPlayerId,

            telegramId: null,

            name:
                "Игрок " +
                testPlayerId.slice(-4),

            username: "",

            socketId:
                socket.id,

            connected: true,

            roomId: null
        };

        players.set(
            player.playerId,
            player
        );

    } else {

        player.socketId =
            socket.id;

        player.connected =
            true;
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
PUBLIC ROOM
=========================================================
*/

function publicRoom(room) {

    return {
        id: room.id,

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers: 2,

        players:
            room.players.map(
                (player) => ({
                    playerId:
                        player.playerId,

                    name:
                        player.name,

                    connected:
                        player.connected
                })
            )
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
            (player) =>
                player.playerId ===
                playerId
        );

    const opponent =
        room.players.find(
            (player) =>
                player.playerId !==
                playerId
        );

    let turn = "WAITING";

    if (
        room.status === "playing" &&
        room.turnPlayerId
    ) {

        turn =
            room.turnPlayerId ===
            playerId
                ? "YOUR_TURN"
                : "OPPONENT_TURN";
    }

    return {

        roomId:
            room.id,

        status:
            room.status,

        turn,

        turnPlayerId:
            room.turnPlayerId,

        me:
            me
                ? {
                    playerId:
                        me.playerId,

                    name:
                        me.name,

                    connected:
                        me.connected
                }
                : null,

        opponent:
            opponent
                ? {
                    playerId:
                        opponent.playerId,

                    name:
                        opponent.name,

                    connected:
                        opponent.connected
                }
                : null,

        players:
            room.players.map(
                (player) => ({
                    playerId:
                        player.playerId,

                    name:
                        player.name,

                    connected:
                        player.connected
                })
            ),

        moves:
            room.moves
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

    for (
        const roomPlayer
        of room.players
    ) {

        const player =
            players.get(
                roomPlayer.playerId
            );

        if (!player) {
            continue;
        }

        if (!player.socketId) {
            continue;
        }

        const socket =
            io.sockets.sockets.get(
                player.socketId
            );

        if (!socket) {
            continue;
        }

        socket.emit(
            "game_state",
            gameState(
                room,
                player.playerId
            )
        );
    }
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
        ).map(
            publicRoom
        );

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

        id:
            roomId,

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

        status:
            "waiting",

        turnPlayerId:
            null,

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

    const normalizedRoomId =
        String(roomId || "")
            .trim()
            .toUpperCase();

    const room =
        rooms.get(
            normalizedRoomId
        );

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

    /*
    Второй игрок добавляется
    только здесь.
    */

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
    Первый игрок ВСЕГДА
    получает первый ход.
    */

    room.turnPlayerId =
        room.players[0].playerId;

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
            (player) =>
                player.playerId ===
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
        room.players[nextIndex]
            .playerId;
}

/*
=========================================================
MAKE MOVE
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
    Сервер является
    единственным источником
    истины по ходу.
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
            data?.type ||
            "test",

        timestamp:
            Date.now()
    });

    switchTurn(room);

    return {
        ok: true
    };
}

/*
=========================================================
SOCKET AUTH MIDDLEWARE
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
                "Socket authentication error:",
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
            player.name,
            socket.id
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
                        (item) =>
                            item.playerId ===
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

                /*
                Сразу отправляем
                WAITING состояние.
                */

                sendRoomState(
                    room
                );

                sendRoomList();

                console.log(
                    "Room created:",
                    room.id,
                    "owner:",
                    player.playerId
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
                Теперь сервер уже знает
                обоих игроков и конкретный
                playerId первого игрока.
                */

                console.log(
                    "ROOM START:",
                    room.id
                );

                console.log(
                    "PLAYER 1:",
                    room.players[0].playerId
                );

                console.log(
                    "PLAYER 2:",
                    room.players[1].playerId
                );

                console.log(
                    "TURN:",
                    room.turnPlayerId
                );

                sendRoomState(
                    room
                );

                sendRoomList();
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

                leaveRoom(
                    player,
                    socket
                );
            }
        );

        /*
        =================================================
        DISCONNECT
        =================================================
        */

        socket.on(
            "disconnect",
            (reason) => {

                const current =
                    players.get(
                        player.playerId
                    );

                if (!current) {
                    return;
                }

                /*
                Старый socket не должен
                сбрасывать новое соединение.
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
                    current.playerId,
                    reason
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
                                (item) =>
                                    item.playerId ===
                                    current.playerId
                            );

                        if (roomPlayer) {

                            roomPlayer.connected =
                                false;

                            roomPlayer.socketId =
                                null;
                        }

                        /*
                        Комнату сохраняем.
                        Игрок может вернуться.
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
LEAVE ROOM HELPER
=========================================================
*/

function leaveRoom(
    player,
    socket
) {

    const roomId =
        player.roomId;

    if (!roomId) {

        socket.emit(
            "left_room"
        );

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

        sendRoomList();

        return;
    }

    room.players =
        room.players.filter(
            (item) =>
                item.playerId !==
                player.playerId
        );

    player.roomId =
        null;

    player.connected =
        true;

    socket.leave(
        room.id
    );

    if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.id
        );

    } else {

        /*
        Остался один игрок.
        Комната снова ждёт соперника.
        */

        room.status =
            "waiting";

        room.turnPlayerId =
            null;

        room.moves = [];
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

/*
=========================================================
HTTP
=========================================================
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

            socket:
                "ready",

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
                "================================"
            );

            console.log(
                "Heavy Lux Card server started"
            );

            console.log(
                "Port:",
                PORT
            );

            console.log(
                "HTTP: ready"
            );

            console.log(
                "Socket.IO: ready"
            );

            console.log(
                "PostgreSQL:",
                pool
                    ? "configured"
                    : "disabled"
            );

            console.log(
                "Telegram authentication: configured"
            );

            console.log(
                "================================"
            );
        }
    );
}

start();
