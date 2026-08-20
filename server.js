const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 10000);

/*
=========================================================
HEAVY LUX CARD
SERVER.JS
VERSION 7.0
=========================================================

CORE:
- Express
- Socket.IO
- PostgreSQL
- Telegram WebApp authentication
- Test mode
- Real players 1x1
- Durak 36 cards
- Authoritative server
- Reconnect
- Rooms
- Attack
- Defense
- Take
- Bito
- Correct draw order
- Correct round limits
- Game over detection

STAKE SYSTEM:
- 100
- 250
- 500
- 1000
- 2000
- 5000
- 10000
- 50000

IMPORTANT:
- Each room has exactly ONE immutable stake.
- Players can only join a room with its stake.
- Stake is currently a table/game tier.
- Balance/economy is NOT changed by this server version.
- This keeps future economy isolated from game logic.

NO AI
NO BOT
NO COMPUTER PLAYER
=========================================================
*/


/* =========================================================
   EXPRESS
========================================================= */

app.use(cors());

app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(express.static(__dirname));


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {

    pool = new Pool({
        connectionString:
            process.env.DATABASE_URL,

        ssl: {
            rejectUnauthorized: false
        },

        max: 10,

        idleTimeoutMillis: 30000,

        connectionTimeoutMillis: 10000
    });

    pool.on(
        "error",
        err => {
            console.error(
                "PostgreSQL error:",
                err
            );
        }
    );
}


/* =========================================================
   SOCKET.IO
========================================================= */

const io = new Server(
    server,
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

        pingTimeout: 20000,

        connectionStateRecovery: {
            maxDisconnectionDuration:
                2 * 60 * 1000,

            skipMiddlewares: true
        }
    }
);


/* =========================================================
   MEMORY
========================================================= */

const players = new Map();

const rooms = new Map();


/* =========================================================
   STAKES
========================================================= */

const STAKES = [
    100,
    250,
    500,
    1000,
    2000,
    5000,
    10000,
    50000
];

const STAKE_SET =
    new Set(STAKES);


function normalizeStake(value) {

    const stake =
        Number(value);

    if (
        !Number.isInteger(stake) ||
        !STAKE_SET.has(stake)
    ) {
        return null;
    }

    return stake;
}


/* =========================================================
   DURAK 36
========================================================= */

const SUITS = [
    "♠",
    "♥",
    "♦",
    "♣"
];

const RANKS = [
    ["6", 6],
    ["7", 7],
    ["8", 8],
    ["9", 9],
    ["10", 10],
    ["J", 11],
    ["Q", 12],
    ["K", 13],
    ["A", 14]
];


/* =========================================================
   CONFIG
========================================================= */

const MAX_PLAYERS_PER_ROOM = 2;

const STARTING_HAND_SIZE = 6;

const MAX_ATTACK_CARDS = 6;

const DISCONNECT_GRACE_MS =
    2 * 60 * 1000;

const TELEGRAM_MAX_AGE_SECONDS =
    24 * 60 * 60;


/* =========================================================
   HELPERS
========================================================= */

function createId(length = 12) {

    return crypto
        .randomBytes(32)
        .toString("hex")
        .slice(0, length);
}


function cleanName(name) {

    const value =
        String(name || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 30);

    return value || "Игрок";
}


function getPlayer(playerId) {

    return players.get(playerId) || null;
}


function getRoom(roomId) {

    return rooms.get(roomId) || null;
}


function roomPlayerById(
    room,
    playerId
) {

    if (!room) {
        return null;
    }

    return (
        room.players.find(
            player =>
                player.playerId ===
                playerId
        ) || null
    );
}


function otherPlayer(
    room,
    playerId
) {

    if (!room) {
        return null;
    }

    return (
        room.players.find(
            player =>
                player.playerId !==
                playerId
        ) || null
    );
}


function getRoomPlayer(player) {

    if (!player) {
        return null;
    }

    if (!player.roomId) {
        return null;
    }

    const room =
        getRoom(
            player.roomId
        );

    if (!room) {
        return null;
    }

    return roomPlayerById(
        room,
        player.playerId
    );
}


function findCard(
    player,
    cardId
) {

    const roomPlayer =
        getRoomPlayer(
            player
        );

    if (
        !roomPlayer ||
        !Array.isArray(
            roomPlayer.hand
        )
    ) {
        return null;
    }

    return (
        roomPlayer.hand.find(
            card =>
                card.id === cardId
        ) || null
    );
}


function removeCard(
    player,
    cardId
) {

    const roomPlayer =
        getRoomPlayer(
            player
        );

    if (
        !roomPlayer ||
        !Array.isArray(
            roomPlayer.hand
        )
    ) {
        return null;
    }

    const index =
        roomPlayer.hand.findIndex(
            card =>
                card.id === cardId
        );

    if (index === -1) {
        return null;
    }

    return roomPlayer.hand.splice(
        index,
        1
    )[0];
}


function cardLabel(card) {

    if (!card) {
        return "";
    }

    return `${card.rank}${card.suit}`;
}


function safeRoomId(roomId) {

    return String(roomId || "")
        .trim()
        .toUpperCase()
        .slice(0, 20);
}


/* =========================================================
   TELEGRAM AUTH
========================================================= */

function parseTelegramInitData(
    initData
) {

    if (!initData) {
        return null;
    }

    try {

        const params =
            new URLSearchParams(
                initData
            );

        const rawUser =
            params.get("user");

        if (!rawUser) {
            return null;
        }

        const user =
            JSON.parse(
                rawUser
            );

        const authDate =
            Number(
                params.get(
                    "auth_date"
                ) || 0
            );

        const hash =
            params.get("hash") ||
            "";

        return {
            params,
            user,
            authDate,
            hash
        };

    } catch (err) {

        console.error(
            "Telegram parse error:",
            err
        );

        return null;
    }
}


function verifyTelegramInitData(
    initData
) {

    const parsed =
        parseTelegramInitData(
            initData
        );

    if (!parsed) {
        return null;
    }

    const {
        params,
        user,
        authDate,
        hash
    } = parsed;


    if (
        !process.env.TELEGRAM_BOT_TOKEN
    ) {

        console.warn(
            "WARNING: TELEGRAM_BOT_TOKEN is not configured. Telegram signature verification is disabled."
        );

        return user;
    }


    if (!hash) {

        throw new Error(
            "Telegram hash missing"
        );
    }


    if (!authDate) {

        throw new Error(
            "Telegram auth_date missing"
        );
    }


    const now =
        Math.floor(
            Date.now() / 1000
        );


    if (
        Math.abs(
            now - authDate
        ) >
        TELEGRAM_MAX_AGE_SECONDS
    ) {

        throw new Error(
            "Telegram initData expired"
        );
    }


    const dataCheckArray = [];


    for (
        const [
            key,
            value
        ]
        of params.entries()
    ) {

        if (
            key === "hash"
        ) {
            continue;
        }

        dataCheckArray.push(
            `${key}=${value}`
        );
    }


    dataCheckArray.sort();


    const dataCheckString =
        dataCheckArray.join(
            "\n"
        );


    const secretKey =
        crypto
            .createHmac(
                "sha256",
                "WebAppData"
            )
            .update(
                process.env.TELEGRAM_BOT_TOKEN
            )
            .digest();


    const calculatedHash =
        crypto
            .createHmac(
                "sha256",
                secretKey
            )
            .update(
                dataCheckString
            )
            .digest("hex");


    let valid = false;


    try {

        valid =
            crypto.timingSafeEqual(
                Buffer.from(
                    calculatedHash,
                    "hex"
                ),
                Buffer.from(
                    hash,
                    "hex"
                )
            );

    } catch {

        valid = false;
    }


    if (!valid) {

        throw new Error(
            "Invalid Telegram signature"
        );
    }


    return user;
}


/* =========================================================
   DATABASE INIT
========================================================= */

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

    } catch (err) {

        console.error(
            "PostgreSQL initialization error:",
            err
        );
    }
}


/* =========================================================
   DATABASE PLAYER
========================================================= */

async function loadPlayerByTelegramId(
    telegramId
) {

    if (
        !pool ||
        !telegramId
    ) {
        return null;
    }


    try {

        const result =
            await pool.query(
                `
                SELECT
                    player_id,
                    telegram_id,
                    username,
                    player_name
                FROM players
                WHERE telegram_id = $1
                LIMIT 1
                `,
                [
                    telegramId
                ]
            );


        if (
            result.rows.length === 0
        ) {
            return null;
        }


        return result.rows[0];

    } catch (err) {

        console.error(
            "loadPlayerByTelegramId error:",
            err
        );

        return null;
    }
}


async function savePlayer(
    player
) {

    if (
        !pool ||
        !player
    ) {
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
            (
                $1,
                $2,
                $3,
                $4,
                NOW()
            )

            ON CONFLICT (player_id)
            DO UPDATE SET
                telegram_id =
                    EXCLUDED.telegram_id,

                username =
                    EXCLUDED.username,

                player_name =
                    EXCLUDED.player_name,

                updated_at =
                    NOW()
            `,
            [
                player.playerId,
                player.telegramId,
                player.username,
                player.name
            ]
        );

    } catch (err) {

        console.error(
            "savePlayer error:",
            err
        );
    }
}


/* =========================================================
   AUTHENTICATION
========================================================= */

async function authenticate(
    socket
) {

    const auth =
        socket.handshake.auth || {};

    const initData =
        auth.initData || "";


    if (initData) {

        const telegramUser =
            verifyTelegramInitData(
                initData
            );


        if (
            !telegramUser ||
            !telegramUser.id
        ) {

            throw new Error(
                "Telegram user not found"
            );
        }


        const telegramId =
            String(
                telegramUser.id
            );


        let player = null;


        for (
            const existing
            of players.values()
        ) {

            if (
                existing.telegramId ===
                telegramId
            ) {

                player =
                    existing;

                break;
            }
        }


        if (!player) {

            const dbPlayer =
                await loadPlayerByTelegramId(
                    telegramId
                );


            if (dbPlayer) {

                player = {

                    playerId:
                        dbPlayer.player_id,

                    telegramId,

                    username:
                        dbPlayer.username ||
                        "",

                    name:
                        cleanName(
                            dbPlayer.player_name
                        ),

                    socketId:
                        socket.id,

                    connected:
                        true,

                    roomId:
                        null,

                    disconnectTimer:
                        null
                };
            }
        }


        if (!player) {

            player = {

                playerId:
                    createId(12),

                telegramId,

                username:
                    telegramUser.username ||
                    "",

                name:
                    cleanName(
                        telegramUser.first_name ||
                        telegramUser.username ||
                        "Игрок"
                    ),

                socketId:
                    socket.id,

                connected:
                    true,

                roomId:
                    null,

                disconnectTimer:
                    null
            };

        } else {

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


            if (
                player.disconnectTimer
            ) {

                clearTimeout(
                    player.disconnectTimer
                );

                player.disconnectTimer =
                    null;
            }
        }


        players.set(
            player.playerId,
            player
        );


        await savePlayer(
            player
        );


        return player;
    }


    /*
     * TEST MODE
     */

    const testPlayerId =
        String(
            auth.testPlayerId ||
            `test_${socket.id}`
        )
        .slice(0, 100);


    let player =
        players.get(
            testPlayerId
        );


    if (!player) {

        player = {

            playerId:
                testPlayerId,

            telegramId:
                null,

            username:
                "",

            name:
                "Игрок " +
                testPlayerId.slice(-4),

            socketId:
                socket.id,

            connected:
                true,

            roomId:
                null,

            disconnectTimer:
                null
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


        if (
            player.disconnectTimer
        ) {

            clearTimeout(
                player.disconnectTimer
            );

            player.disconnectTimer =
                null;
        }
    }


    return player;
}


/* =========================================================
   CARDS
========================================================= */

function createDeck() {

    const deck = [];


    for (
        const suit
        of SUITS
    ) {

        for (
            const [
                rank,
                value
            ]
            of RANKS
        ) {

            deck.push({

                id:
                    createId(16),

                suit,

                rank,

                value
            });
        }
    }


    return deck;
}


function shuffle(
    deck
) {

    for (
        let i =
            deck.length - 1;

        i > 0;

        i--
    ) {

        const j =
            Math.floor(
                Math.random() *
                (i + 1)
            );


        [
            deck[i],
            deck[j]
        ] = [
            deck[j],
            deck[i]
        ];
    }


    return deck;
}


function isTrump(
    card,
    trumpSuit
) {

    return (
        !!card &&
        card.suit ===
            trumpSuit
    );
}


function canBeat(
    attackCard,
    defenseCard,
    trumpSuit
) {

    if (
        !attackCard ||
        !defenseCard
    ) {
        return false;
    }


    const attackTrump =
        isTrump(
            attackCard,
            trumpSuit
        );


    const defenseTrump =
        isTrump(
            defenseCard,
            trumpSuit
        );


    if (attackTrump) {

        return (
            defenseTrump &&
            defenseCard.value >
                attackCard.value
        );
    }


    if (defenseTrump) {
        return true;
    }


    return (
        defenseCard.suit ===
            attackCard.suit &&

        defenseCard.value >
            attackCard.value
    );
}


/* =========================================================
   ROOM
========================================================= */

function createRoom(
    player,
    stake
) {

    if (player.roomId) {

        return {
            ok: false,

            error:
                "Вы уже находитесь в комнате."
        };
    }


    const normalizedStake =
        normalizeStake(
            stake
        );


    if (
        normalizedStake === null
    ) {

        return {
            ok: false,

            error:
                "Выбрана недопустимая ставка."
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

        /*
         * Ставка комнаты фиксируется
         * при создании и больше
         * никогда не изменяется.
         */
        stake:
            normalizedStake,

        players: [],

        status:
            "waiting",

        phase:
            "waiting",

        deck: [],

        trumpSuit:
            null,

        attackerId:
            null,

        defenderId:
            null,

        roundMaxCards:
            0,

        table: [],

        moves: [],

        winnerId:
            null,

        loserId:
            null,

        createdAt:
            Date.now(),

        startedAt:
            null,

        finishedAt:
            null
    };


    const roomPlayer = {

        playerId:
            player.playerId,

        name:
            player.name,

        socketId:
            player.socketId,

        connected:
            true,

        hand: []
    };


    room.players.push(
        roomPlayer
    );


    rooms.set(
        room.id,
        room
    );


    player.roomId =
        room.id;


    return {
        ok:
            true,

        room
    };
}


function joinRoom(
    player,
    roomId,
    requestedStake = null
) {

    roomId =
        safeRoomId(
            roomId
        );


    if (player.roomId) {

        return {
            ok: false,

            error:
                "Вы уже находитесь в комнате."
        };
    }


    const room =
        getRoom(
            roomId
        );


    if (!room) {

        return {
            ok: false,

            error:
                "Комната не найдена."
        };
    }


    if (
        requestedStake !== null &&
        normalizeStake(
            requestedStake
        ) !== room.stake
    ) {

        return {
            ok: false,

            error:
                "Эта комната относится к другой ставке."
        };
    }


    if (
        room.players.length >=
        MAX_PLAYERS_PER_ROOM
    ) {

        return {
            ok: false,

            error:
                "Комната уже заполнена."
        };
    }


    if (
        room.status !==
        "waiting"
    ) {

        return {
            ok: false,

            error:
                "Игра уже началась."
        };
    }


    room.players.push({

        playerId:
            player.playerId,

        name:
            player.name,

        socketId:
            player.socketId,

        connected:
            true,

        hand: []
    });


    player.roomId =
        room.id;


    startGame(
        room
    );


    return {
        ok:
            true,

        room
    };
}


/* =========================================================
   START GAME
========================================================= */

function startGame(
    room
) {

    if (
        !room ||
        room.players.length !== 2
    ) {
        return false;
    }


    room.status =
        "playing";

    room.phase =
        "attack";

    room.startedAt =
        Date.now();

    room.finishedAt =
        null;

    room.deck =
        shuffle(
            createDeck()
        );

    room.table =
        [];

    room.moves =
        [];

    room.winnerId =
        null;

    room.loserId =
        null;


    room.players.forEach(
        player => {

            player.hand =
                [];

            player.connected =
                true;
        }
    );


    for (
        let i = 0;
        i < STARTING_HAND_SIZE;
        i++
    ) {

        for (
            const player
            of room.players
        ) {

            if (
                room.deck.length
            ) {

                player.hand.push(
                    room.deck.pop()
                );
            }
        }
    }


    room.trumpSuit =
        room.deck.length > 0
            ? room.deck[
                room.deck.length - 1
            ].suit
            : null;


    let attacker =
        null;

    let lowestTrump =
        null;


    for (
        const player
        of room.players
    ) {

        for (
            const card
            of player.hand
        ) {

            if (
                card.suit ===
                    room.trumpSuit &&
                (
                    !lowestTrump ||
                    card.value <
                        lowestTrump.value
                )
            ) {

                lowestTrump =
                    card;

                attacker =
                    player;
            }
        }
    }


    if (!attacker) {

        attacker =
            room.players[0];
    }


    const defender =
        otherPlayer(
            room,
            attacker.playerId
        );


    room.attackerId =
        attacker.playerId;

    room.defenderId =
        defender.playerId;


    startNewAttackRound(
        room
    );


    room.moves.push({

        type:
            "game_start",

        playerId:
            attacker.playerId,

        stake:
            room.stake,

        timestamp:
            Date.now()
    });


    return true;
}


/* =========================================================
   ROUND LIMIT
========================================================= */

function startNewAttackRound(
    room
) {

    const defender =
        roomPlayerById(
            room,
            room.defenderId
        );


    if (!defender) {

        room.roundMaxCards =
            0;

        return;
    }


    room.roundMaxCards =
        Math.min(
            MAX_ATTACK_CARDS,
            defender.hand.length
        );
}


function maxTableCards(
    room
) {

    return Math.max(
        0,
        Math.min(
            MAX_ATTACK_CARDS,
            Number(
                room.roundMaxCards || 0
            )
        )
    );
}


/* =========================================================
   ATTACK VALIDATION
========================================================= */

function validAttackCard(
    room,
    card
) {

    if (!card) {
        return false;
    }


    if (
        room.table.length === 0
    ) {

        return true;
    }


    const allowedValues =
        new Set();


    for (
        const pair
        of room.table
    ) {

        if (pair.attack) {

            allowedValues.add(
                pair.attack.value
            );
        }


        if (pair.defense) {

            allowedValues.add(
                pair.defense.value
            );
        }
    }


    return allowedValues.has(
        card.value
    );
}


/* =========================================================
   ATTACK
========================================================= */

function attackCard(
    player,
    cardId
) {

    const room =
        getRoom(
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
                "Игра не идёт."
        };
    }


    if (
        room.phase !==
            "attack" &&
        room.phase !==
            "bito"
    ) {

        return {
            ok: false,
            error:
                "Сейчас нельзя атаковать."
        };
    }


    if (
        room.attackerId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }


    const attacker =
        roomPlayerById(
            room,
            player.playerId
        );


    if (!attacker) {

        return {
            ok: false,
            error:
                "Игрок не найден."
        };
    }


    const maxCards =
        maxTableCards(
            room
        );


    if (
        maxCards <= 0
    ) {

        return {
            ok: false,
            error:
                "Нельзя добавить карту."
        };
    }


    if (
        room.table.length >=
        maxCards
    ) {

        return {
            ok: false,
            error:
                "Достигнут максимум карт на столе."
        };
    }


    if (
        room.table.length > 0
    ) {

        const hasUnbeaten =
            room.table.some(
                pair =>
                    !pair.defense
            );


        if (hasUnbeaten) {

            return {
                ok: false,
                error:
                    "Сначала нужно отбить предыдущую карту."
            };
        }
    }


    const card =
        findCard(
            player,
            cardId
        );


    if (!card) {

        return {
            ok: false,
            error:
                "Этой карты нет у вас."
        };
    }


    if (
        !validAttackCard(
            room,
            card
        )
    ) {

        return {
            ok: false,
            error:
                "Такую карту нельзя подкинуть."
        };
    }


    const removed =
        removeCard(
            player,
            cardId
        );


    if (!removed) {

        return {
            ok: false,
            error:
                "Не удалось взять карту из руки."
        };
    }


    room.table.push({

        attack:
            removed,

        defense:
            null
    });


    room.phase =
        "defense";


    room.moves.push({

        type:
            "attack",

        playerId:
            player.playerId,

        card:
            cardLabel(
                removed
            ),

        timestamp:
            Date.now()
    });


    return {
        ok:
            true
    };
}


/* =========================================================
   DEFENSE
========================================================= */

function defendCard(
    player,
    attackId,
    defenseId
) {

    const room =
        getRoom(
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
                "Игра не идёт."
        };
    }


    if (
        room.phase !==
        "defense"
    ) {

        return {
            ok: false,
            error:
                "Сейчас нельзя отбиваться."
        };
    }


    if (
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }


    const pair =
        room.table.find(
            item =>
                item.attack &&
                item.attack.id ===
                    attackId &&
                !item.defense
        );


    if (!pair) {

        return {
            ok: false,
            error:
                "Эта карта уже отбита или не существует."
        };
    }


    const defense =
        findCard(
            player,
            defenseId
        );


    if (!defense) {

        return {
            ok: false,
            error:
                "Этой карты нет у вас."
        };
    }


    if (
        !canBeat(
            pair.attack,
            defense,
            room.trumpSuit
        )
    ) {

        return {
            ok: false,
            error:
                "Этой картой нельзя отбить."
        };
    }


    const removed =
        removeCard(
            player,
            defenseId
        );


    if (!removed) {

        return {
            ok: false,
            error:
                "Не удалось взять карту из руки."
        };
    }


    pair.defense =
        removed;


    room.moves.push({

        type:
            "defend",

        playerId:
            player.playerId,

        attack:
            cardLabel(
                pair.attack
            ),

        card:
            cardLabel(
                removed
            ),

        timestamp:
            Date.now()
    });


    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            item =>
                !!item.defense
        );


    room.phase =
        allDefended
            ? "bito"
            : "defense";


    return {
        ok:
            true
    };
}


/* =========================================================
   TAKE
========================================================= */

function takeCards(
    player
) {

    const room =
        getRoom(
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
                "Игра не идёт."
        };
    }


    if (
        room.phase !==
        "defense"
    ) {

        return {
            ok: false,
            error:
                "Сейчас нельзя брать карты."
        };
    }


    if (
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }


    const hasUnbeaten =
        room.table.some(
            pair =>
                !pair.defense
        );


    if (!hasUnbeaten) {

        return {
            ok: false,
            error:
                "Все карты отбиты. Нажмите БИТО."
        };
    }


    const defender =
        roomPlayerById(
            room,
            player.playerId
        );


    if (!defender) {

        return {
            ok: false,
            error:
                "Игрок не найден."
        };
    }


    for (
        const pair
        of room.table
    ) {

        if (pair.attack) {

            defender.hand.push(
                pair.attack
            );
        }


        if (pair.defense) {

            defender.hand.push(
                pair.defense
            );
        }
    }


    room.moves.push({

        type:
            "take",

        playerId:
            player.playerId,

        cards:
            room.table.reduce(
                (
                    count,
                    pair
                ) =>
                    count +
                    (pair.attack ? 1 : 0) +
                    (pair.defense ? 1 : 0),
                0
            ),

        timestamp:
            Date.now()
    });


    room.table =
        [];


    room.phase =
        "draw";


    drawCards(
        room
    );


    if (
        checkGameOver(
            room
        )
    ) {

        return {
            ok:
                true
        };
    }


    startNewAttackRound(
        room
    );


    room.phase =
        "attack";


    return {
        ok:
            true
    };
}


/* =========================================================
   BITO
========================================================= */

function bito(
    player
) {

    const room =
        getRoom(
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
                "Игра не идёт."
        };
    }


    if (
        room.phase !==
        "bito"
    ) {

        return {
            ok: false,
            error:
                "Пока нельзя нажать БИТО."
        };
    }


    if (
        room.attackerId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Только атакующий может нажать БИТО."
        };
    }


    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            pair =>
                !!pair.defense
        );


    if (!allDefended) {

        return {
            ok: false,
            error:
                "Не все карты отбиты."
        };
    }


    room.moves.push({

        type:
            "bito",

        playerId:
            player.playerId,

        timestamp:
            Date.now()
    });


    room.table =
        [];


    const oldAttacker =
        room.attackerId;

    const oldDefender =
        room.defenderId;


    room.attackerId =
        oldDefender;

    room.defenderId =
        oldAttacker;


    room.phase =
        "draw";


    drawCards(
        room
    );


    if (
        checkGameOver(
            room
        )
    ) {

        return {
            ok:
                true
        };
    }


    startNewAttackRound(
        room
    );


    room.phase =
        "attack";


    return {
        ok:
            true
    };
}


/* =========================================================
   DRAW
========================================================= */

function drawCards(
    room
) {

    if (
        !room ||
        room.deck.length === 0
    ) {
        return;
    }


    const attacker =
        roomPlayerById(
            room,
            room.attackerId
        );


    const defender =
        roomPlayerById(
            room,
            room.defenderId
        );


    const order = [
        attacker,
        defender
    ];


    for (
        const player
        of order
    ) {

        if (!player) {
            continue;
        }


        while (
            player.hand.length <
                STARTING_HAND_SIZE &&

            room.deck.length > 0
        ) {

            player.hand.push(
                room.deck.pop()
            );
        }
    }
}


/* =========================================================
   GAME OVER
========================================================= */

function checkGameOver(
    room
) {

    if (!room) {
        return false;
    }


    if (
        room.deck.length > 0
    ) {

        return false;
    }


    const emptyPlayers =
        room.players.filter(
            player =>
                player.hand.length === 0
        );


    if (
        emptyPlayers.length !== 1
    ) {

        if (
            emptyPlayers.length === 2
        ) {

            room.status =
                "finished";

            room.phase =
                "finished";

            room.winnerId =
                null;

            room.loserId =
                null;

            room.attackerId =
                null;

            room.defenderId =
                null;

            room.finishedAt =
                Date.now();

            room.moves.push({

                type:
                    "draw",

                timestamp:
                    Date.now()
            });

            return true;
        }


        return false;
    }


    const winner =
        emptyPlayers[0];


    const loser =
        otherPlayer(
            room,
            winner.playerId
        );


    room.status =
        "finished";

    room.phase =
        "finished";

    room.winnerId =
        winner.playerId;

    room.loserId =
        loser
            ? loser.playerId
            : null;

    room.attackerId =
        null;

    room.defenderId =
        null;

    room.finishedAt =
        Date.now();


    room.moves.push({

        type:
            "finish",

        playerId:
            winner.playerId,

        timestamp:
            Date.now()
    });


    return true;
}


/* =========================================================
   SERIALIZATION
========================================================= */

function serializeCard(
    card
) {

    if (!card) {
        return null;
    }


    return {

        id:
            card.id,

        suit:
            card.suit,

        rank:
            card.rank,

        value:
            card.value
    };
}


/* =========================================================
   GAME STATE
========================================================= */

function gameState(
    room,
    playerId
) {

    const me =
        roomPlayerById(
            room,
            playerId
        );


    const opponent =
        otherPlayer(
            room,
            playerId
        );


    let turn =
        "WAITING";


    if (
        room.status ===
        "playing"
    ) {

        if (
            room.phase ===
                "attack" ||

            room.phase ===
                "bito"
        ) {

            turn =
                room.attackerId ===
                    playerId
                    ? "YOUR_TURN"
                    : "OPPONENT_TURN";
        }


        if (
            room.phase ===
                "defense"
        ) {

            turn =
                room.defenderId ===
                    playerId
                    ? "YOUR_TURN"
                    : "OPPONENT_TURN";
        }
    }


    const table =
        room.table.map(
            pair => ({

                attack:
                    serializeCard(
                        pair.attack
                    ),

                defense:
                    pair.defense
                        ? serializeCard(
                            pair.defense
                        )
                        : null
            })
        );


    const canTake =
        room.status ===
            "playing" &&

        room.phase ===
            "defense" &&

        room.defenderId ===
            playerId &&

        room.table.some(
            pair =>
                !pair.defense
        );


    const canBito =
        room.status ===
            "playing" &&

        room.phase ===
            "bito" &&

        room.attackerId ===
            playerId &&

        room.table.length > 0 &&

        room.table.every(
            pair =>
                !!pair.defense
        );


    const canAttack =
        room.status ===
            "playing" &&

        room.attackerId ===
            playerId &&

        (
            room.phase ===
                "attack" ||

            room.phase ===
                "bito"
        ) &&

        room.table.length <
            maxTableCards(
                room
            ) &&

        (
            room.table.length === 0 ||

            room.table.every(
                pair =>
                    !!pair.defense
            )
        );


    return {

        roomId:
            room.id,

        /*
         * Главная информация
         * для будущей экономики.
         */
        stake:
            room.stake,

        status:
            room.status,

        phase:
            room.phase,

        turn,

        attackerId:
            room.attackerId,

        defenderId:
            room.defenderId,

        trumpSuit:
            room.trumpSuit,

        deckCount:
            room.deck.length,

        roundMaxCards:
            room.roundMaxCards,

        hand:
            me
                ? me.hand.map(
                    serializeCard
                )
                : [],

        opponent:
            opponent
                ? {

                    playerId:
                        opponent.playerId,

                    name:
                        opponent.name,

                    connected:
                        opponent.connected,

                    cardsCount:
                        opponent.hand.length
                }
                : null,

        table,

        canAttack,

        canTake,

        canBito,

        moves:
            room.moves.slice(-30),

        winnerId:
            room.winnerId ||
            null,

        loserId:
            room.loserId ||
            null,

        me: {

            playerId
        }
    };
}


/* =========================================================
   ROOM STATE
========================================================= */

function sendRoomState(
    room
) {

    if (!room) {
        return;
    }


    for (
        const roomPlayer
        of room.players
    ) {

        const player =
            getPlayer(
                roomPlayer.playerId
            );


        if (
            !player ||
            !player.socketId
        ) {
            continue;
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
    }
}


/* =========================================================
   PUBLIC ROOM
========================================================= */

function publicRoom(
    room
) {

    return {

        id:
            room.id,

        stake:
            room.stake,

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers:
            MAX_PLAYERS_PER_ROOM
    };
}


function roomsByStake() {

    const result = {};


    for (
        const stake
        of STAKES
    ) {

        result[String(stake)] =
            [];
    }


    for (
        const room
        of rooms.values()
    ) {

        if (
            !STAKE_SET.has(
                room.stake
            )
        ) {
            continue;
        }


        if (
            room.status !==
                "waiting" &&
            room.status !==
                "playing"
        ) {
            continue;
        }


        result[
            String(room.stake)
        ].push(
            publicRoom(
                room
            )
        );
    }


    return result;
}


function sendRoomList() {

    const payload = {

        stakes:
            STAKES,

        rooms:
            Array.from(
                rooms.values()
            )
            .filter(
                room =>
                    room.status ===
                        "waiting" ||
                    room.status ===
                        "playing"
            )
            .map(
                publicRoom
            ),

        byStake:
            roomsByStake()
    };


    io.emit(
        "rooms_list",
        payload
    );
}


/* =========================================================
   LEAVE ROOM
========================================================= */

function leaveRoom(
    player
) {

    const roomId =
        player.roomId;


    if (!roomId) {
        return null;
    }


    const room =
        getRoom(
            roomId
        );


    if (!room) {

        player.roomId =
            null;

        return null;
    }


    room.players =
        room.players.filter(
            roomPlayer =>
                roomPlayer.playerId !==
                player.playerId
        );


    player.roomId =
        null;


    if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.id
        );

        sendRoomList();

        return room;
    }


    const remaining =
        room.players[0];


    if (
        room.status ===
        "playing"
    ) {

        room.status =
            "finished";

        room.phase =
            "finished";

        room.winnerId =
            remaining.playerId;

        room.loserId =
            player.playerId;

        room.attackerId =
            null;

        room.defenderId =
            null;

        room.finishedAt =
            Date.now();

    } else {

        room.status =
            "waiting";

        room.phase =
            "waiting";
    }


    sendRoomList();

    sendRoomState(
        room
    );


    return room;
}


/* =========================================================
   DISCONNECT
========================================================= */

function scheduleDisconnectCleanup(
    player
) {

    if (
        player.disconnectTimer
    ) {

        clearTimeout(
            player.disconnectTimer
        );
    }


    player.disconnectTimer =
        setTimeout(
            () => {

                if (
                    player.connected
                ) {

                    player.disconnectTimer =
                        null;

                    return;
                }


                if (
                    player.roomId
                ) {

                    const room =
                        getRoom(
                            player.roomId
                        );


                    if (room) {

                        const opponent =
                            otherPlayer(
                                room,
                                player.playerId
                            );


                        if (
                            room.status ===
                                "playing" &&
                            opponent
                        ) {

                            room.status =
                                "finished";

                            room.phase =
                                "finished";

                            room.winnerId =
                                opponent.playerId;

                            room.loserId =
                                player.playerId;

                            room.attackerId =
                                null;

                            room.defenderId =
                                null;

                            room.finishedAt =
                                Date.now();


                            room.moves.push({

                                type:
                                    "disconnect_finish",

                                playerId:
                                    opponent.playerId,

                                timestamp:
                                    Date.now()
                            });


                            sendRoomState(
                                room
                            );

                        } else {

                            leaveRoom(
                                player
                            );
                        }
                    }
                }


                player.disconnectTimer =
                    null;

            },

            DISCONNECT_GRACE_MS
        );
}


/* =========================================================
   SOCKET AUTH
========================================================= */

io.use(
    async (
        socket,
        next
    ) => {

        try {

            const player =
                await authenticate(
                    socket
                );


            socket.playerId =
                player.playerId;


            next();

        } catch (err) {

            console.error(
                "Authentication error:",
                err.message
            );


            next(
                new Error(
                    err.message ||
                    "Authentication failed"
                )
            );
        }
    }
);


/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

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


        if (
            player.disconnectTimer
        ) {

            clearTimeout(
                player.disconnectTimer
            );

            player.disconnectTimer =
                null;
        }


        console.log(
            "Player connected:",
            player.playerId,
            player.name
        );


        /* =================================================
           RECONNECT
        ================================================= */

        if (
            player.roomId
        ) {

            const room =
                getRoom(
                    player.roomId
                );


            if (room) {

                const roomPlayer =
                    roomPlayerById(
                        room,
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

            } else {

                player.roomId =
                    null;
            }
        }


        /* =================================================
           PROFILE
        ================================================= */

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


        /* =================================================
           STAKES
        ================================================= */

        socket.on(
            "get_stakes",
            () => {

                socket.emit(
                    "stakes",
                    STAKES
                );
            }
        );


        /* =================================================
           ROOMS
        ================================================= */

        socket.on(
            "get_rooms",
            () => {

                socket.emit(
                    "rooms_list",
                    {

                        stakes:
                            STAKES,

                        rooms:
                            Array.from(
                                rooms.values()
                            )
                            .filter(
                                room =>
                                    room.status ===
                                        "waiting" ||
                                    room.status ===
                                        "playing"
                            )
                            .map(
                                publicRoom
                            ),

                        byStake:
                            roomsByStake()
                    }
                );
            }
        );


        /* =================================================
           CREATE ROOM
           data = {
               stake: 100
           }
        ================================================= */

        socket.on(
            "create_room",
            data => {

                const stake =
                    normalizeStake(
                        data?.stake
                    );


                if (
                    stake === null
                ) {

                    socket.emit(
                        "error_message",
                        "Выберите ставку: 100, 250, 500, 1000, 2000, 5000, 10000 или 50000."
                    );

                    return;
                }


                const result =
                    createRoom(
                        player,
                        stake
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
                    publicRoom(
                        room
                    )
                );


                sendRoomState(
                    room
                );


                sendRoomList();


                console.log(
                    "Room created:",
                    room.id,
                    "stake:",
                    room.stake
                );
            }
        );


        /* =================================================
           JOIN ROOM

           Можно передать:
           {
               roomId: "ABC123",
               stake: 500
           }

           Если stake не передан —
           проверяется только ставка комнаты.
        ================================================= */

        socket.on(
            "join_room",
            data => {

                let roomId = data;
                let requestedStake = null;


                if (
                    typeof data ===
                    "object"
                ) {

                    roomId =
                        data?.roomId;

                    requestedStake =
                        data?.stake ??
                        null;
                }


                const result =
                    joinRoom(
                        player,
                        roomId,
                        requestedStake
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


                sendRoomState(
                    room
                );


                sendRoomList();


                console.log(
                    "Player joined:",
                    player.name,
                    room.id,
                    "stake:",
                    room.stake
                );


                console.log(
                    "Trump:",
                    room.trumpSuit
                );


                console.log(
                    "Attacker:",
                    room.attackerId
                );


                console.log(
                    "Defender:",
                    room.defenderId
                );
            }
        );


        /* =================================================
           ATTACK
        ================================================= */

        socket.on(
            "attack_card",
            cardId => {

                const result =
                    attackCard(
                        player,
                        cardId
                    );


                if (!result.ok) {

                    socket.emit(
                        "game_error",
                        result.error
                    );

                    return;
                }


                const room =
                    getRoom(
                        player.roomId
                    );


                if (room) {

                    sendRoomState(
                        room
                    );
                }
            }
        );


        /* =================================================
           DEFENSE
        ================================================= */

        socket.on(
            "defend_card",
            data => {

                const result =
                    defendCard(
                        player,
                        data?.attackId,
                        data?.defenseId
                    );


                if (!result.ok) {

                    socket.emit(
                        "game_error",
                        result.error
                    );

                    return;
                }


                const room =
                    getRoom(
                        player.roomId
                    );


                if (room) {

                    sendRoomState(
                        room
                    );
                }
            }
        );


        /* =================================================
           TAKE
        ================================================= */

        socket.on(
            "take_cards",
            () => {

                const result =
                    takeCards(
                        player
                    );


                if (!result.ok) {

                    socket.emit(
                        "game_error",
                        result.error
                    );

                    return;
                }


                const room =
                    getRoom(
                        player.roomId
                    );


                if (room) {

                    sendRoomState(
                        room
                    );
                }


                sendRoomList();
            }
        );


        /* =================================================
           BITO
        ================================================= */

        socket.on(
            "bito",
            () => {

                const result =
                    bito(
                        player
                    );


                if (!result.ok) {

                    socket.emit(
                        "game_error",
                        result.error
                    );

                    return;
                }


                const room =
                    getRoom(
                        player.roomId
                    );


                if (room) {

                    sendRoomState(
                        room
                    );
                }


                sendRoomList();
            }
        );


        /* =================================================
           LEAVE ROOM
        ================================================= */

        socket.on(
            "leave_room",
            () => {

                const room =
                    player.roomId
                        ? getRoom(
                            player.roomId
                        )
                        : null;


                if (room) {

                    socket.leave(
                        room.id
                    );
                }


                leaveRoom(
                    player
                );


                socket.emit(
                    "left_room"
                );
            }
        );


        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            reason => {

                const current =
                    players.get(
                        player.playerId
                    );


                if (!current) {
                    return;
                }


                if (
                    current.socketId !==
                    socket.id
                ) {

                    return;
                }


                current.connected =
                    false;


                const room =
                    current.roomId
                        ? getRoom(
                            current.roomId
                        )
                        : null;


                if (room) {

                    const roomPlayer =
                        roomPlayerById(
                            room,
                            current.playerId
                        );


                    if (roomPlayer) {

                        roomPlayer.connected =
                            false;
                    }


                    sendRoomState(
                        room
                    );
                }


                console.log(
                    "Player disconnected:",
                    current.playerId,
                    reason
                );


                scheduleDisconnectCleanup(
                    current
                );
            }
        );
    }
);


/* =========================================================
   HTTP
========================================================= */

app.get(
    "/",
    (
        req,
        res
    ) => {

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
    async (
        req,
        res
    ) => {

        let database =
            "disabled";


        if (pool) {

            try {

                await pool.query(
                    "SELECT 1"
                );

                database =
                    "connected";

            } catch {

                database =
                    "error";
            }
        }


        res.json({

            ok:
                true,

            service:
                "Heavy Lux Card",

            version:
                "7.0",

            stakes:
                STAKES,

            database,

            telegramAuth:
                !!process.env.TELEGRAM_BOT_TOKEN,

            rooms:
                rooms.size,

            players:
                players.size,

            time:
                new Date()
                    .toISOString()
        });
    }
);


/* =========================================================
   404
========================================================= */

app.use(
    (
        req,
        res
    ) => {

        if (
            req.path.startsWith(
                "/api/"
            )
        ) {

            res.status(404)
                .json({
                    ok: false,
                    error:
                        "API endpoint not found"
                });

            return;
        }


        res.status(404)
            .send(
                "Not Found"
            );
    }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "Express error:",
            err
        );


        if (
            res.headersSent
        ) {

            return next(
                err
            );
        }


        res.status(500)
            .json({

                ok:
                    false,

                error:
                    "Internal server error"
            });
    }
);


/* =========================================================
   START
========================================================= */

async function start() {

    await initDatabase();


    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                "======================================"
            );

            console.log(
                "HEAVY LUX CARD"
            );

            console.log(
                "Server version: 7.0"
            );

            console.log(
                "Server started on port",
                PORT
            );

            console.log(
                "Socket.IO: ready"
            );

            console.log(
                "Durak 36 cards: ready"
            );

            console.log(
                "Real players 1x1: ready"
            );

            console.log(
                "Authoritative game server: ready"
            );

            console.log(
                "ATTACK / DEFENSE: ready"
            );

            console.log(
                "TAKE: ready"
            );

            console.log(
                "BITO: ready"
            );

            console.log(
                "Correct draw order: ready"
            );

            console.log(
                "Round card limit: ready"
            );

            console.log(
                "Reconnect: ready"
            );

            console.log(
                "STAKE TABLES: ready"
            );

            console.log(
                "Available stakes:",
                STAKES.join(", ")
            );

            console.log(
                "Telegram auth:",
                process.env.TELEGRAM_BOT_TOKEN
                    ? "verified"
                    : "test/unverified"
            );

            console.log(
                "PostgreSQL:",
                pool
                    ? "enabled"
                    : "disabled"
            );

            console.log(
                "======================================"
            );
        }
    );
}


process.on(
    "SIGTERM",
    async () => {

        console.log(
            "SIGTERM received"
        );

        await shutdown();
    }
);


process.on(
    "SIGINT",
    async () => {

        console.log(
            "SIGINT received"
        );

        await shutdown();
    }
);


async function shutdown() {

    try {

        io.close();

        server.close();

        if (pool) {

            await pool.end();
        }

        console.log(
            "Server stopped"
        );

        process.exit(0);

    } catch (err) {

        console.error(
            "Shutdown error:",
            err
        );

        process.exit(1);
    }
}


start();
