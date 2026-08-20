const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { Server } = require("socket.io");


/*
=========================================================
HEAVY LUX CARD
SERVER.JS
LOBBY + 1x1 ROOMS
=========================================================

Telegram
PostgreSQL
Express
Socket.IO

NO AI
NO BOT PLAYER
NO SINGLE PLAYER

SERVER AUTHORITATIVE
=========================================================
*/


/*
=========================================================
CONFIG
=========================================================
*/

const app = express();

const httpServer =
    http.createServer(app);

const PORT =
    process.env.PORT || 3000;

const BOT_TOKEN =
    process.env.BOT_TOKEN;

const DATABASE_URL =
    process.env.DATABASE_URL;


const START_MONEY = 10000;
const START_XP = 0;
const START_LEVEL = 1;

const MAX_ROOMS = 1000;


/*
=========================================================
POSTGRESQL
=========================================================
*/

if (!DATABASE_URL) {

    console.error(
        "DATABASE_URL is not configured"
    );

}


const pool =
    new Pool({

        connectionString:
            DATABASE_URL,

        ssl:
            DATABASE_URL
                ? {
                    rejectUnauthorized:
                        false
                }
                : undefined

    });


/*
=========================================================
EXPRESS
=========================================================
*/

app.use(cors());

app.use(express.json());

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/*
=========================================================
SOCKET.IO
=========================================================
*/

const io =
    new Server(
        httpServer,
        {

            cors: {

                origin: "*",

                methods: [
                    "GET",
                    "POST"
                ]

            },

            transports: [
                "websocket",
                "polling"
            ],

            pingInterval: 25000,

            pingTimeout: 20000

        }
    );


/*
=========================================================
IN-MEMORY ROOMS
=========================================================

Комнаты живут в памяти сервера.

Профили и экономика находятся
в PostgreSQL.

При перезапуске Render комнаты
очищаются — это нормально на этом
этапе.

Позже при необходимости добавим
persistent matchmaking.
=========================================================
*/

const rooms =
    new Map();


const socketPlayers =
    new Map();


/*
=========================================================
ROOM ID
=========================================================
*/

function generateRoomCode() {

    const letters =
        "ABCDEFGHJKLMNPQRSTUVWXYZ";

    const numbers =
        "23456789";


    let code = "HL-";


    for (
        let i = 0;
        i < 2;
        i++
    ) {

        code +=
            letters[
                Math.floor(
                    Math.random() *
                    letters.length
                )
            ];

    }


    code += "-";


    for (
        let i = 0;
        i < 4;
        i++
    ) {

        code +=
            numbers[
                Math.floor(
                    Math.random() *
                    numbers.length
                )
            ];

    }


    return code;

}


function createUniqueRoomCode() {

    let code;


    do {

        code =
            generateRoomCode();

    } while (
        rooms.has(code)
    );


    return code;

}


/*
=========================================================
TELEGRAM AUTH
=========================================================
*/

function validateTelegramInitData(
    initData
) {

    if (!BOT_TOKEN) {

        return {

            valid: false,

            error:
                "BOT_TOKEN is not configured"

        };

    }


    if (
        !initData ||
        typeof initData !== "string"
    ) {

        return {

            valid: false,

            error:
                "Missing Telegram initData"

        };

    }


    const params =
        new URLSearchParams(
            initData
        );


    const receivedHash =
        params.get("hash");


    if (!receivedHash) {

        return {

            valid: false,

            error:
                "Missing Telegram hash"

        };

    }


    params.delete("hash");


    const dataCheckString =
        Array
            .from(
                params.entries()
            )
            .sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            )
            .map(
                ([key, value]) =>
                    `${key}=${value}`
            )
            .join("\n");


    const secretKey =
        crypto
            .createHmac(
                "sha256",
                "WebAppData"
            )
            .update(BOT_TOKEN)
            .digest();


    const calculatedHash =
        crypto
            .createHmac(
                "sha256",
                secretKey
            )
            .update(dataCheckString)
            .digest("hex");


    if (
        calculatedHash.length !==
        receivedHash.length
    ) {

        return {

            valid: false,

            error:
                "Invalid Telegram signature"

        };

    }


    let valid = false;


    try {

        valid =
            crypto.timingSafeEqual(
                Buffer.from(
                    calculatedHash,
                    "hex"
                ),
                Buffer.from(
                    receivedHash,
                    "hex"
                )
            );

    } catch {

        valid = false;

    }


    if (!valid) {

        return {

            valid: false,

            error:
                "Invalid Telegram signature"

        };

    }


    let user = null;


    const userString =
        params.get("user");


    if (userString) {

        try {

            user =
                JSON.parse(
                    userString
                );

        } catch {

            return {

                valid: false,

                error:
                    "Invalid Telegram user data"

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
DATABASE
=========================================================
*/

async function initializeDatabase() {

    if (!DATABASE_URL) {

        throw new Error(
            "DATABASE_URL is missing"
        );

    }


    await pool.query(`
        CREATE TABLE IF NOT EXISTS heavy_lux_players (

            id BIGSERIAL PRIMARY KEY,

            telegram_id TEXT UNIQUE NOT NULL,

            username TEXT,

            first_name TEXT,

            last_name TEXT,

            money BIGINT NOT NULL DEFAULT 10000,

            xp INTEGER NOT NULL DEFAULT 0,

            level INTEGER NOT NULL DEFAULT 1,

            wins INTEGER NOT NULL DEFAULT 0,

            losses INTEGER NOT NULL DEFAULT 0,

            games_played INTEGER NOT NULL DEFAULT 0,

            created_at TIMESTAMPTZ
                NOT NULL DEFAULT NOW(),

            last_login TIMESTAMPTZ
                NOT NULL DEFAULT NOW()

        );
    `);


    await pool.query(
        "SELECT 1"
    );


    console.log(
        "PostgreSQL connected"
    );


    console.log(
        "Heavy Lux Card database initialized"
    );

}


/*
=========================================================
PLAYER
=========================================================
*/

function getPlayerDisplayName(
    player
) {

    if (
        player.firstName &&
        player.lastName
    ) {

        return (
            `${player.firstName} ` +
            `${player.lastName}`
        ).trim();

    }


    if (player.firstName) {

        return player.firstName;

    }


    if (player.username) {

        return (
            "@" +
            player.username
        );

    }


    return "Игрок";

}


async function getOrCreatePlayer(
    user
) {

    const telegramId =
        String(user.id);

    const username =
        user.username ||
        null;

    const firstName =
        user.first_name ||
        "";

    const lastName =
        user.last_name ||
        "";


    const result =
        await pool.query(

            `
            INSERT INTO heavy_lux_players
            (
                telegram_id,
                username,
                first_name,
                last_name,
                last_login
            )

            VALUES
            (
                $1,
                $2,
                $3,
                $4,
                NOW()
            )

            ON CONFLICT
            (
                telegram_id
            )

            DO UPDATE SET

                username =
                    EXCLUDED.username,

                first_name =
                    EXCLUDED.first_name,

                last_name =
                    EXCLUDED.last_name,

                last_login =
                    NOW()

            RETURNING
                id,
                telegram_id,
                username,
                first_name,
                last_name,
                money,
                xp,
                level,
                wins,
                losses,
                games_played,
                created_at,
                last_login
            `,

            [
                telegramId,
                username,
                firstName,
                lastName
            ]

        );


    return result.rows[0];

}


function serializePlayer(
    player
) {

    return {

        id:
            Number(player.id),

        telegramId:
            player.telegram_id,

        username:
            player.username,

        firstName:
            player.first_name,

        lastName:
            player.last_name,

        displayName:
            getPlayerDisplayName({
                username:
                    player.username,

                firstName:
                    player.first_name,

                lastName:
                    player.last_name
            }),

        money:
            Number(player.money),

        xp:
            Number(player.xp),

        level:
            Number(player.level),

        wins:
            Number(player.wins),

        losses:
            Number(player.losses),

        gamesPlayed:
            Number(player.games_played)

    };

}


/*
=========================================================
ROOM HELPERS
=========================================================
*/

function getRoomPlayer(
    room,
    playerId
) {

    return room.players.find(
        player =>
            player.playerId ===
            playerId
    );

}


function getPublicRoom(
    room
) {

    return {

        code:
            room.code,

        status:
            room.status,

        players:
            room.players.length,

        maxPlayers:
            2,

        createdAt:
            room.createdAt

    };

}


function getRoomStateForPlayer(
    room,
    playerId
) {

    const me =
        getRoomPlayer(
            room,
            playerId
        );


    return {

        code:
            room.code,

        status:
            room.status,

        players:
            room.players.map(
                player => ({

                    playerId:
                        player.playerId,

                    displayName:
                        player.displayName,

                    username:
                        player.username,

                    ready:
                        Boolean(
                            player.ready
                        )

                })
            ),

        myPlayerId:
            playerId,

        myReady:
            Boolean(
                me?.ready
            )

    };

}


/*
=========================================================
ROOM LIST
=========================================================
*/

function getOpenRooms() {

    return Array
        .from(
            rooms.values()
        )
        .filter(
            room =>
                room.status ===
                "waiting" &&
                room.players.length < 2
        )
        .map(
            getPublicRoom
        );

}


/*
=========================================================
BROADCAST LOBBY
=========================================================
*/

function broadcastLobby() {

    io.emit(
        "lobby:rooms",
        {
            rooms:
                getOpenRooms()
        }
    );

}


/*
=========================================================
ROOM SOCKET UPDATE
=========================================================
*/

function broadcastRoom(
    room
) {

    for (
        const player of room.players
    ) {

        io.to(
            player.socketId
        ).emit(
            "room:state",
            getRoomStateForPlayer(
                room,
                player.playerId
            )
        );

    }

}


/*
=========================================================
CREATE ROOM
=========================================================
*/

function createRoom(
    socket,
    player
) {

    if (
        rooms.size >=
        MAX_ROOMS
    ) {

        socket.emit(
            "room:error",
            {
                error:
                    "Сервер комнат временно заполнен."
            }
        );

        return;

    }


    /*
    Игрок не может одновременно
    находиться в нескольких комнатах.
    */

    if (player.roomCode) {

        socket.emit(
            "room:error",
            {
                error:
                    "Вы уже находитесь в комнате."
            }
        );

        return;

    }


    const code =
        createUniqueRoomCode();


    const room = {

        code,

        status:
            "waiting",

        createdAt:
            Date.now(),

        players: []

    };


    room.players.push({

        playerId:
            String(player.id),

        socketId:
            socket.id,

        displayName:
            player.displayName,

        username:
            player.username,

        ready:
            true

    });


    rooms.set(
        code,
        room
    );


    player.roomCode =
        code;


    socket.join(
        code
    );


    socket.emit(
        "room:created",
        {

            code,

            state:
                getRoomStateForPlayer(
                    room,
                    String(player.id)
                )

        }
    );


    broadcastRoom(
        room
    );


    broadcastLobby();


    console.log(
        `Room created ${code} by ${player.displayName}`
    );

}


/*
=========================================================
JOIN ROOM
=========================================================
*/

function joinRoom(
    socket,
    player,
    rawCode
) {

    if (player.roomCode) {

        socket.emit(
            "room:error",
            {
                error:
                    "Вы уже находитесь в комнате."
            }
        );

        return;

    }


    const code =
        String(
            rawCode || ""
        )
        .trim()
        .toUpperCase();


    if (!code) {

        socket.emit(
            "room:error",
            {
                error:
                    "Введите код комнаты."
            }
        );

        return;

    }


    const room =
        rooms.get(code);


    if (!room) {

        socket.emit(
            "room:error",
            {
                error:
                    "Комната не найдена."
            }
        );

        return;

    }


    if (
        room.status !==
        "waiting"
    ) {

        socket.emit(
            "room:error",
            {
                error:
                    "Игра в этой комнате уже началась."
            }
        );

        return;

    }


    if (
        room.players.length >=
        2
    ) {

        socket.emit(
            "room:error",
            {
                error:
                    "Комната уже заполнена."
            }
        );

        return;

    }


    room.players.push({

        playerId:
            String(player.id),

        socketId:
            socket.id,

        displayName:
            player.displayName,

        username:
            player.username,

        ready:
            true

    });


    player.roomCode =
        code;


    socket.join(
        code
    );


    /*
    После входа второго игрока
    переводим комнату в preparing.
    */

    if (
        room.players.length ===
        2
    ) {

        room.status =
            "preparing";

    }


    socket.emit(
        "room:joined",
        {

            code,

            state:
                getRoomStateForPlayer(
                    room,
                    String(player.id)
                )

        }
    );


    broadcastRoom(
        room
    );


    broadcastLobby();


    /*
    Пока не запускаем карты.
    Отправляем событие,
    что комната готова к старту.
    */

    if (
        room.players.length ===
        2
    ) {

        setTimeout(
            () => {

                /*
                Проверяем, что комната
                всё ещё существует
                и оба игрока на месте.
                */

                const currentRoom =
                    rooms.get(code);


                if (
                    !currentRoom
                ) {

                    return;

                }


                if (
                    currentRoom.players.length !==
                    2
                ) {

                    return;

                }


                currentRoom.status =
                    "ready";


                broadcastRoom(
                    currentRoom
                );


                io.to(code).emit(
                    "room:ready",
                    {

                        code,

                        message:
                            "Оба игрока в комнате. Игра готова к запуску."

                    }
                );


                broadcastLobby();

            },

            500
        );

    }


    console.log(
        `${player.displayName} joined ${code}`
    );

}


/*
=========================================================
LEAVE ROOM
=========================================================
*/

function leaveRoom(
    socket,
    player,
    notify = true
) {

    const code =
        player.roomCode;


    if (!code) {

        return;

    }


    const room =
        rooms.get(code);


    player.roomCode =
        null;


    if (!room) {

        socket.leave(code);

        return;

    }


    room.players =
        room.players.filter(
            p =>
                p.socketId !==
                socket.id
        );


    socket.leave(
        code
    );


    if (notify) {

        socket.emit(
            "room:left",
            {
                code
            }
        );

    }


    if (
        room.players.length ===
        0
    ) {

        rooms.delete(
            code
        );

    } else {

        room.status =
            "waiting";


        /*
        Сбрасываем ready
        оставшегося игрока.
        */

        for (
            const p of room.players
        ) {

            p.ready = true;


            io.to(
                p.socketId
            ).emit(
                "room:opponent_left",
                {

                    message:
                        "Соперник покинул комнату."

                }
            );

        }


        broadcastRoom(
            room
        );

    }


    broadcastLobby();


    console.log(
        `Player left room ${code}`
    );

}


/*
=========================================================
READY
=========================================================
*/

function toggleReady(
    socket,
    player
) {

    if (!player.roomCode) {

        return;

    }


    const room =
        rooms.get(
            player.roomCode
        );


    if (!room) {

        player.roomCode =
            null;

        return;

    }


    const roomPlayer =
        getRoomPlayer(
            room,
            String(player.id)
        );


    if (!roomPlayer) {

        return;

    }


    roomPlayer.ready =
        !roomPlayer.ready;


    broadcastRoom(
        room
    );


    /*
    На этом этапе ready только
    визуальный статус.

    Реальный запуск Дурака
    добавим после подключения
    игровой движок.
    */

}


/*
=========================================================
SOCKET AUTH
=========================================================
*/

io.use(
    async (
        socket,
        next
    ) => {

        try {

            const initData =
                socket.handshake
                    .auth
                    ?.initData;


            const result =
                validateTelegramInitData(
                    initData
                );


            if (!result.valid) {

                return next(
                    new Error(
                        result.error
                    )
                );

            }


            if (
                !result.user ||
                !result.user.id
            ) {

                return next(
                    new Error(
                        "Telegram user not found"
                    )
                );

            }


            const dbPlayer =
                await getOrCreatePlayer(
                    result.user
                );


            const player =
                serializePlayer(
                    dbPlayer
                );


            socket.data.player =
                player;


            socket.data.roomCode =
                null;


            next();

        } catch (error) {

            console.error(
                "Socket auth error:",
                error
            );


            next(
                new Error(
                    "Socket authentication failed"
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
            socket.data.player;


        player.roomCode =
            null;


        socketPlayers.set(
            socket.id,
            player
        );


        console.log(
            `Socket connected: ${socket.id} / ${player.displayName}`
        );


        /*
        HELLO
        */

        socket.emit(
            "server:hello",
            {

                ok: true,

                project:
                    "Heavy Lux Card",

                socketId:
                    socket.id,

                player

            }
        );


        /*
        CURRENT LOBBY
        */

        socket.emit(
            "lobby:rooms",
            {

                rooms:
                    getOpenRooms()

            }
        );


        /*
        CREATE ROOM
        */

        socket.on(
            "room:create",
            () => {

                createRoom(
                    socket,
                    player
                );

            }
        );


        /*
        JOIN ROOM
        */

        socket.on(
            "room:join",
            (data) => {

                joinRoom(
                    socket,
                    player,
                    data?.code
                );

            }
        );


        /*
        LEAVE ROOM
        */

        socket.on(
            "room:leave",
            () => {

                leaveRoom(
                    socket,
                    player,
                    true
                );

            }
        );


        /*
        READY
        */

        socket.on(
            "room:ready",
            () => {

                toggleReady(
                    socket,
                    player
                );

            }
        );


        /*
        REQUEST LOBBY
        */

        socket.on(
            "lobby:request",
            () => {

                socket.emit(
                    "lobby:rooms",
                    {

                        rooms:
                            getOpenRooms()

                    }
                );

            }
        );


        /*
        DISCONNECT
        */

        socket.on(
            "disconnect",
            (reason) => {

                console.log(
                    `Socket disconnected: ${socket.id}`,
                    reason
                );


                leaveRoom(
                    socket,
                    player,
                    false
                );


                socketPlayers.delete(
                    socket.id
                );

            }
        );

    }
);


/*
=========================================================
API HEALTH
=========================================================
*/

app.get(
    "/api/health",
    async (req, res) => {

        let database =
            false;


        try {

            await pool.query(
                "SELECT 1"
            );

            database =
                true;

        } catch (error) {

            console.error(
                "Database health error:",
                error.message
            );

        }


        res.json({

            ok: true,

            project:
                "Heavy Lux Card",

            version:
                "3.0.0",

            telegram:
                Boolean(
                    BOT_TOKEN
                ),

            socket:
                true,

            database,

            rooms:
                rooms.size

        });

    }
);


/*
=========================================================
API TELEGRAM AUTH
=========================================================
*/

app.post(
    "/api/auth/telegram",
    async (req, res) => {

        try {

            const initData =
                req.body
                    ?.initData;


            const result =
                validateTelegramInitData(
                    initData
                );


            if (!result.valid) {

                return res
                    .status(401)
                    .json({

                        ok: false,

                        error:
                            result.error

                    });

            }


            if (
                !result.user ||
                !result.user.id
            ) {

                return res
                    .status(401)
                    .json({

                        ok: false,

                        error:
                            "Telegram user not found"

                    });

            }


            const player =
                await getOrCreatePlayer(
                    result.user
                );


            return res.json({

                ok: true,

                player:
                    serializePlayer(
                        player
                    )

            });

        } catch (error) {

            console.error(
                "Telegram auth error:",
                error
            );


            return res
                .status(500)
                .json({

                    ok: false,

                    error:
                        "Database authorization error"

                });

        }

    }
);


/*
=========================================================
START SERVER
=========================================================
*/

async function startServer() {

    try {

        await initializeDatabase();


        httpServer.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `Heavy Lux Card server started on port ${PORT}`
                );


                console.log(
                    "Telegram authentication:",
                    BOT_TOKEN
                        ? "configured"
                        : "NOT CONFIGURED"
                );

            }
        );

    } catch (error) {

        console.error(
            "Server startup failed:",
            error
        );


        process.exit(1);

    }

}


startServer();
