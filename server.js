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
VERSION 8.0
=========================================================

CORE
- Express
- Socket.IO
- PostgreSQL
- Telegram WebApp authentication
- Test mode
- Real players only
- 1x1 rooms
- Durak 36 cards
- Authoritative server
- Reconnect
- Disconnect grace period

GAME
- Correct Durak round cycle
- Attack
- Defense
- Throw-in
- Take
- Bito
- Draw
- Correct turn switching
- Correct trump determination
- Correct game finish

ECONOMY
- Server-side wallet
- 8 stake levels
- Stake reservation
- Winner payout
- Draw refund
- Disconnect = opponent victory
- No client-side money modification

PLAYER FOUNDATION
- XP
- Level
- Games
- Wins
- Losses
- Draws

FUTURE RP FOUNDATION
- Garage
- Cars
- Car colors
- Government plates
- GIBDD
- Property
- Businesses
- Economy

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
   DURAK
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

const DEFAULT_BALANCE = 1000;


/* =========================================================
   GAME CONFIG
========================================================= */

const MAX_PLAYERS_PER_ROOM = 2;

const STARTING_HAND_SIZE = 6;

const MAX_ATTACK_CARDS = 6;

const DISCONNECT_GRACE_MS =
    2 * 60 * 1000;

const TELEGRAM_MAX_AGE_SECONDS =
    24 * 60 * 60;


/* =========================================================
   XP CONFIG
========================================================= */

const XP_WIN = 100;
const XP_LOSS = 25;
const XP_DRAW = 50;

const XP_PER_LEVEL = 500;


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


function money(value) {

    const n = Number(value);

    if (!Number.isFinite(n)) {
        return 0;
    }

    return Math.max(
        0,
        Math.floor(n)
    );
}


function formatMoney(value) {

    return money(value)
        .toLocaleString("ru-RU");
}


function isValidStake(stake) {

    return STAKES.includes(
        Number(stake)
    );
}


function safeRoomId(roomId) {

    return String(roomId || "")
        .trim()
        .toUpperCase()
        .slice(0, 20);
}


function getPlayer(playerId) {

    return players.get(
        playerId
    ) || null;
}


function getRoom(roomId) {

    return rooms.get(
        roomId
    ) || null;
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

    if (!player || !player.roomId) {
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


function emitPlayerError(
    socket,
    event,
    message
) {

    socket.emit(
        event,
        message
    );
}


/* =========================================================
   PLAYER LEVEL
========================================================= */

function calculateLevel(xp) {

    return Math.max(
        1,
        Math.floor(
            money(xp) /
            XP_PER_LEVEL
        ) + 1
    );
}


function addXP(
    player,
    amount
) {

    if (!player) {
        return;
    }

    player.xp =
        money(
            player.xp
        ) + money(amount);

    player.level =
        calculateLevel(
            player.xp
        );
}


/* =========================================================
   WALLET
========================================================= */

function getWallet(player) {

    const balance =
        money(
            player.balance
        );

    const reserved =
        money(
            player.reservedBalance
        );

    return {

        balance,

        reserved,

        available:
            Math.max(
                0,
                balance - reserved
            )
    };
}


function hasAvailableMoney(
    player,
    amount
) {

    const wallet =
        getWallet(
            player
        );

    return (
        wallet.available >=
        money(amount)
    );
}


function reserveMoney(
    player,
    amount
) {

    amount =
        money(amount);

    if (
        !hasAvailableMoney(
            player,
            amount
        )
    ) {
        return false;
    }

    player.reservedBalance =
        money(
            player.reservedBalance
        ) + amount;

    return true;
}


function consumeReservedMoney(
    player,
    amount
) {

    amount =
        money(amount);

    const reserved =
        money(
            player.reservedBalance
        );

    if (
        reserved < amount
    ) {
        return false;
    }

    player.reservedBalance =
        reserved - amount;

    player.balance =
        Math.max(
            0,
            money(
                player.balance
            ) - amount
        );

    return true;
}


function releaseReservedMoney(
    player,
    amount
) {

    amount =
        money(amount);

    player.reservedBalance =
        Math.max(
            0,
            money(
                player.reservedBalance
            ) - amount
        );
}


function addMoney(
    player,
    amount
) {

    player.balance =
        money(
            player.balance
        ) + money(amount);
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


    /*
     * TEST / DEVELOPMENT MODE
     */

    if (
        !process.env.TELEGRAM_BOT_TOKEN
    ) {

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


    const calculatedBuffer =
        Buffer.from(
            calculatedHash,
            "hex"
        );

    const receivedBuffer =
        Buffer.from(
            hash,
            "hex"
        );


    if (
        calculatedBuffer.length !==
        receivedBuffer.length
    ) {

        throw new Error(
            "Invalid Telegram signature"
        );
    }


    if (
        !crypto.timingSafeEqual(
            calculatedBuffer,
            receivedBuffer
        )
    ) {

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

                balance BIGINT NOT NULL DEFAULT 1000,
                reserved_balance BIGINT NOT NULL DEFAULT 0,

                xp BIGINT NOT NULL DEFAULT 0,
                level INTEGER NOT NULL DEFAULT 1,

                games INTEGER NOT NULL DEFAULT 0,
                wins INTEGER NOT NULL DEFAULT 0,
                losses INTEGER NOT NULL DEFAULT 0,
                draws INTEGER NOT NULL DEFAULT 0,

                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);


        const migrations = [
            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS balance
            BIGINT NOT NULL DEFAULT 1000
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS reserved_balance
            BIGINT NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS xp
            BIGINT NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS level
            INTEGER NOT NULL DEFAULT 1
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS games
            INTEGER NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS wins
            INTEGER NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS losses
            INTEGER NOT NULL DEFAULT 0
            `,

            `
            ALTER TABLE players
            ADD COLUMN IF NOT EXISTS draws
            INTEGER NOT NULL DEFAULT 0
            `
        ];


        for (
            const migration
            of migrations
        ) {

            await pool.query(
                migration
            );
        }


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
   DATABASE LOAD
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
                    player_name,

                    balance,
                    reserved_balance,

                    xp,
                    level,

                    games,
                    wins,
                    losses,
                    draws

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


/* =========================================================
   DATABASE SAVE
========================================================= */

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

                balance,
                reserved_balance,

                xp,
                level,

                games,
                wins,
                losses,
                draws,

                updated_at
            )

            VALUES
            (
                $1,
                $2,
                $3,
                $4,

                $5,
                $6,

                $7,
                $8,

                $9,
                $10,
                $11,
                $12,

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

                balance =
                    EXCLUDED.balance,

                reserved_balance =
                    EXCLUDED.reserved_balance,

                xp =
                    EXCLUDED.xp,

                level =
                    EXCLUDED.level,

                games =
                    EXCLUDED.games,

                wins =
                    EXCLUDED.wins,

                losses =
                    EXCLUDED.losses,

                draws =
                    EXCLUDED.draws,

                updated_at =
                    NOW()
            `,
            [
                player.playerId,
                player.telegramId,
                player.username,
                player.name,

                money(
                    player.balance
                ),

                money(
                    player.reservedBalance
                ),

                money(
                    player.xp
                ),

                Math.max(
                    1,
                    Number(
                        player.level || 1
                    )
                ),

                Number(
                    player.games || 0
                ),

                Number(
                    player.wins || 0
                ),

                Number(
                    player.losses || 0
                ),

                Number(
                    player.draws || 0
                )
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


    /*
     * TELEGRAM
     */

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

                    balance:
                        money(
                            dbPlayer.balance
                        ),

                    reservedBalance:
                        money(
                            dbPlayer.reserved_balance
                        ),

                    xp:
                        money(
                            dbPlayer.xp
                        ),

                    level:
                        Math.max(
                            1,
                            Number(
                                dbPlayer.level ||
                                calculateLevel(
                                    dbPlayer.xp
                                )
                            )
                        ),

                    games:
                        Number(
                            dbPlayer.games || 0
                        ),

                    wins:
                        Number(
                            dbPlayer.wins || 0
                        ),

                    losses:
                        Number(
                            dbPlayer.losses || 0
                        ),

                    draws:
                        Number(
                            dbPlayer.draws || 0
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

                balance:
                    DEFAULT_BALANCE,

                reservedBalance:
                    0,

                xp:
                    0,

                level:
                    1,

                games:
                    0,

                wins:
                    0,

                losses:
                    0,

                draws:
                    0,

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


            player.balance =
                money(
                    player.balance
                );

            player.reservedBalance =
                money(
                    player.reservedBalance
                );

            player.xp =
                money(
                    player.xp
                );

            player.level =
                calculateLevel(
                    player.xp
                );


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

            balance:
                DEFAULT_BALANCE,

            reservedBalance:
                0,

            xp:
                0,

            level:
                1,

            games:
                0,

            wins:
                0,

            losses:
                0,

            draws:
                0,

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
   DECK
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
   ECONOMY
========================================================= */

function getPot(room) {

    return (
        money(
            room.stake
        ) *
        2
    );
}


function reserveGameStakes(
    room
) {

    if (
        !room ||
        room.players.length !== 2
    ) {

        return {
            ok: false,
            error:
                "Недостаточно игроков."
        };
    }


    if (
        room.stakesReserved
    ) {

        return {
            ok:
                true
        };
    }


    const playerA =
        getPlayer(
            room.players[0].playerId
        );

    const playerB =
        getPlayer(
            room.players[1].playerId
        );


    if (
        !playerA ||
        !playerB
    ) {

        return {
            ok: false,
            error:
                "Игрок не найден."
        };
    }


    if (
        !hasAvailableMoney(
            playerA,
            room.stake
        )
    ) {

        return {
            ok: false,
            error:
                `${playerA.name} не хватает денег для ставки ${formatMoney(room.stake)}.`
        };
    }


    if (
        !hasAvailableMoney(
            playerB,
            room.stake
        )
    ) {

        return {
            ok: false,
            error:
                `${playerB.name} не хватает денег для ставки ${formatMoney(room.stake)}.`
        };
    }


    if (
        !reserveMoney(
            playerA,
            room.stake
        )
    ) {

        return {
            ok: false,
            error:
                "Не удалось зарезервировать первую ставку."
        };
    }


    if (
        !reserveMoney(
            playerB,
            room.stake
        )
    ) {

        releaseReservedMoney(
            playerA,
            room.stake
        );

        return {
            ok: false,
            error:
                "Не удалось зарезервировать вторую ставку."
        };
    }


    room.stakesReserved =
        true;

    room.pot =
        getPot(
            room
        );


    return {
        ok:
            true
    };
}


async function settleWinner(
    room,
    winnerId,
    loserId
) {

    if (
        !room ||
        room.settled
    ) {
        return;
    }


    const winner =
        getPlayer(
            winnerId
        );

    const loser =
        getPlayer(
            loserId
        );


    if (
        !winner ||
        !loser
    ) {
        return;
    }


    const stake =
        money(
            room.stake
        );


    if (
        room.stakesReserved
    ) {

        consumeReservedMoney(
            winner,
            stake
        );

        consumeReservedMoney(
            loser,
            stake
        );
    }


    const pot =
        money(
            room.pot ||
            stake * 2
        );


    addMoney(
        winner,
        pot
    );


    winner.games =
        Number(
            winner.games || 0
        ) + 1;

    loser.games =
        Number(
            loser.games || 0
        ) + 1;


    winner.wins =
        Number(
            winner.wins || 0
        ) + 1;

    loser.losses =
        Number(
            loser.losses || 0
        ) + 1;


    addXP(
        winner,
        XP_WIN
    );

    addXP(
        loser,
        XP_LOSS
    );


    room.settled =
        true;

    room.settlement =
        "winner";

    room.payout =
        pot;


    await savePlayer(
        winner
    );

    await savePlayer(
        loser
    );
}


async function settleDraw(
    room
) {

    if (
        !room ||
        room.settled
    ) {
        return;
    }


    const stake =
        money(
            room.stake
        );


    for (
        const roomPlayer
        of room.players
    ) {

        const player =
            getPlayer(
                roomPlayer.playerId
            );


        if (!player) {
            continue;
        }


        if (
            room.stakesReserved
        ) {

            releaseReservedMoney(
                player,
                stake
            );
        }


        player.games =
            Number(
                player.games || 0
            ) + 1;

        player.draws =
            Number(
                player.draws || 0
            ) + 1;


        addXP(
            player,
            XP_DRAW
        );


        await savePlayer(
            player
        );
    }


    room.settled =
        true;

    room.settlement =
        "draw";

    room.payout =
        0;
}


async function refundRoom(
    room
) {

    if (
        !room ||
        room.settled
    ) {
        return;
    }


    const stake =
        money(
            room.stake
        );


    for (
        const roomPlayer
        of room.players
    ) {

        const player =
            getPlayer(
                roomPlayer.playerId
            );


        if (!player) {
            continue;
        }


        if (
            money(
                player.reservedBalance
            ) >= stake
        ) {

            releaseReservedMoney(
                player,
                stake
            );
        }


        await savePlayer(
            player
        );
    }


    room.settled =
        true;

    room.settlement =
        "refund";

    room.payout =
        0;
}


/* =========================================================
   ROOM
========================================================= */

function createRoom(
    player,
    requestedStake
) {

    if (player.roomId) {

        return {
            ok: false,
            error:
                "Вы уже находитесь в комнате."
        };
    }


    const stake =
        Number(
            requestedStake
        );


    if (
        !isValidStake(
            stake
        )
    ) {

        return {
            ok: false,
            error:
                "Выберите корректную ставку."
        };
    }


    if (
        !hasAvailableMoney(
            player,
            stake
        )
    ) {

        return {
            ok: false,
            error:
                `Недостаточно средств. Нужно ${formatMoney(stake)}.`
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

        stake,

        pot:
            0,

        stakesReserved:
            false,

        settled:
            false,

        settlement:
            null,

        payout:
            0,

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
    roomId
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


    if (
        !hasAvailableMoney(
            player,
            room.stake
        )
    ) {

        return {
            ok: false,
            error:
                `Недостаточно средств для входа на ${formatMoney(room.stake)}.`
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


    const started =
        startGame(
            room
        );


    if (!started.ok) {

        room.players =
            room.players.filter(
                p =>
                    p.playerId !==
                    player.playerId
            );

        player.roomId =
            null;

        return started;
    }


    return {
        ok:
            true,

        room
    };
}


/* =========================================================
   GAME START
========================================================= */

function startGame(
    room
) {

    if (
        !room ||
        room.players.length !== 2
    ) {

        return {
            ok: false,
            error:
                "Для начала нужны два игрока."
        };
    }


    const reserve =
        reserveGameStakes(
            room
        );


    if (!reserve.ok) {
        return reserve;
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

    room.settled =
        false;

    room.settlement =
        null;

    room.payout =
        0;


    for (
        const player
        of room.players
    ) {

        player.hand =
            [];

        player.connected =
            true;
    }


    /*
     * Раздаём по одной карте.
     */

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
                room.deck.length > 0
            ) {

                player.hand.push(
                    room.deck.pop()
                );
            }
        }
    }


    /*
     * Козырь — последняя карта колоды.
     */

    room.trumpSuit =
        room.deck.length > 0
            ? room.deck[
                room.deck.length - 1
            ].suit
            : null;


    /*
     * Первый ходящий —
     * игрок с младшим козырем.
     */

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


    /*
     * Теоретически козырь
     * всегда должен быть найден.
     * Но сохраняем безопасный fallback.
     */

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

        timestamp:
            Date.now()
    });


    return {
        ok:
            true
    };
}


/* =========================================================
   ROUND
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
   CARDS
========================================================= */

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
                card.id ===
                cardId
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
                card.id ===
                cardId
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


    /*
     * Первая карта раунда —
     * можно положить любую карту.
     */

    if (
        room.table.length === 0
    ) {
        return true;
    }


    /*
     * Подкидывать можно только
     * значения, уже присутствующие
     * на столе.
     */

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


    /*
     * Атаковать можно:
     *
     * 1. в начале атаки
     * 2. после полной отбивки
     */

    if (
        room.phase !== "attack" &&
        room.phase !== "bito"
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


    const maxCards =
        maxTableCards(
            room
        );


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


    /*
     * Если на столе есть
     * неотбитая карта —
     * нельзя начинать новую атаку.
     */

    if (
        room.table.some(
            pair =>
                !pair.defense
        )
    ) {

        return {
            ok: false,
            error:
                "Сначала нужно отбить предыдущую карту."
        };
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
            pair =>
                !!pair.defense
        );


    /*
     * ВАЖНО:
     *
     * После отбивки атакующий
     * снова получает возможность
     * подкинуть карту.
     *
     * Если он не хочет —
     * нажимает БИТО.
     */

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

async function takeCards(
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


    /*
     * При ВЗЯТЬ защитник
     * получает все карты стола.
     */

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


    /*
     * ВЗЯВШИЙ остаётся
     * защитником.
     *
     * Атакующий продолжает
     * атаку в следующем раунде.
     */

    room.phase =
        "draw";


    drawCards(
        room
    );


    if (
        await checkGameOver(
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

async function bito(
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


    /*
     * После БИТО
     * защитник становится
     * новым атакующим.
     */

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
        await checkGameOver(
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


    /*
     * В Дураке сначала добирает
     * атакующий, затем защитник.
     */

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

async function checkGameOver(
    room
) {

    if (!room) {
        return false;
    }


    /*
     * Пока колода не пуста —
     * партия не заканчивается
     * только из-за пустой руки.
     */

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


    /*
     * Оба закончили одновременно.
     */

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


        await settleDraw(
            room
        );


        return true;
    }


    /*
     * Один игрок закончил.
     */

    if (
        emptyPlayers.length === 1
    ) {

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


        if (loser) {

            await settleWinner(
                room,
                winner.playerId,
                loser.playerId
            );
        }


        return true;
    }


    return false;
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


    const player =
        getPlayer(
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


    const wallet =
        player
            ? getWallet(
                player
            )
            : {
                balance: 0,
                reserved: 0,
                available: 0
            };


    return {

        roomId:
            room.id,

        stake:
            room.stake,

        pot:
            room.pot,

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

        settlement:
            room.settlement ||
            null,

        payout:
            room.payout ||
            0,

        wallet,

        me: {

            playerId,

            name:
                player
                    ? player.name
                    : "Игрок"
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
   PROFILE
========================================================= */

async function sendProfile(
    socket,
    player
) {

    const wallet =
        getWallet(
            player
        );


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
                player.username,

            wallet,

            xp:
                money(
                    player.xp
                ),

            level:
                calculateLevel(
                    player.xp
                ),

            games:
                Number(
                    player.games || 0
                ),

            wins:
                Number(
                    player.wins || 0
                ),

            losses:
                Number(
                    player.losses || 0
                ),

            draws:
                Number(
                    player.draws || 0
                ),

            stakes:
                STAKES
        }
    );
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

        pot:
            room.stake * 2,

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers:
            MAX_PLAYERS_PER_ROOM
    };
}


function getPublicRooms() {

    return Array.from(
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
    );
}


function sendRoomList() {

    io.emit(
        "rooms_list",
        getPublicRooms()
    );
}


/* =========================================================
   LEAVE ROOM
========================================================= */

async function leaveRoom(
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


    /*
     * Finished room.
     */

    if (
        room.status ===
        "finished"
    ) {

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
        }


        sendRoomList();

        return room;
    }


    /*
     * Waiting room.
     */

    if (
        room.status ===
        "waiting"
    ) {

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

        } else {

            room.status =
                "waiting";

            room.phase =
                "waiting";
        }


        sendRoomList();

        return room;
    }


    /*
     * Active game.
     *
     * Manual leave =
     * opponent wins immediately.
     */

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
                "leave_finish",

            playerId:
                opponent.playerId,

            timestamp:
                Date.now()
        });


        await settleWinner(
            room,
            opponent.playerId,
            player.playerId
        );
    }


    room.players =
        room.players.filter(
            roomPlayer =>
                roomPlayer.playerId !==
                player.playerId
        );


    player.roomId =
        null;


    sendRoomList();

    sendRoomState(
        room
    );


    return room;
}


/* =========================================================
   DISCONNECT CLEANUP
========================================================= */

async function scheduleDisconnectCleanup(
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
            async () => {

                try {

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


                                await settleWinner(
                                    room,
                                    opponent.playerId,
                                    player.playerId
                                );


                                sendRoomState(
                                    room
                                );

                            } else {

                                await leaveRoom(
                                    player
                                );
                            }
                        }
                    }


                    await savePlayer(
                        player
                    );

                } catch (err) {

                    console.error(
                        "Disconnect cleanup error:",
                        err
                    );

                } finally {

                    player.disconnectTimer =
                        null;
                }

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


        /*
         * Защита от старого socket.
         */

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


        /*
         * RECONNECT
         */

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


        /*
         * PROFILE
         */

        socket.on(
            "get_profile",
            async () => {

                await sendProfile(
                    socket,
                    player
                );
            }
        );


        /*
         * ROOMS
         */

        socket.on(
            "get_rooms",
            () => {

                socket.emit(
                    "rooms_list",
                    getPublicRooms()
                );
            }
        );


        /*
         * CREATE ROOM
         */

        socket.on(
            "create_room",
            async data => {

                try {

                    const stake =
                        Number(
                            data?.stake
                        );


                    const result =
                        createRoom(
                            player,
                            stake
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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


                    await sendProfile(
                        socket,
                        player
                    );


                    console.log(
                        "Room created:",
                        room.id,
                        "stake:",
                        room.stake
                    );

                } catch (err) {

                    console.error(
                        "create_room error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "error_message",
                        "Ошибка создания комнаты."
                    );
                }
            }
        );


        /*
         * JOIN ROOM
         */

        socket.on(
            "join_room",
            async roomId => {

                try {

                    const result =
                        joinRoom(
                            player,
                            roomId
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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


                    await sendProfile(
                        socket,
                        player
                    );


                    console.log(
                        "Player joined:",
                        player.name,
                        room.id,
                        "stake:",
                        room.stake
                    );

                } catch (err) {

                    console.error(
                        "join_room error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "error_message",
                        "Ошибка входа в комнату."
                    );
                }
            }
        );


        /*
         * ATTACK
         */

        socket.on(
            "attack_card",
            async cardId => {

                try {

                    const result =
                        attackCard(
                            player,
                            String(
                                cardId || ""
                            )
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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

                } catch (err) {

                    console.error(
                        "attack_card error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "game_error",
                        "Ошибка атаки."
                    );
                }
            }
        );


        /*
         * DEFENSE
         */

        socket.on(
            "defend_card",
            async data => {

                try {

                    const result =
                        defendCard(
                            player,
                            String(
                                data?.attackId || ""
                            ),
                            String(
                                data?.defenseId || ""
                            )
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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

                } catch (err) {

                    console.error(
                        "defend_card error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "game_error",
                        "Ошибка защиты."
                    );
                }
            }
        );


        /*
         * TAKE
         */

        socket.on(
            "take_cards",
            async () => {

                try {

                    const result =
                        await takeCards(
                            player
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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


                    await sendProfile(
                        socket,
                        player
                    );


                    sendRoomList();

                } catch (err) {

                    console.error(
                        "take_cards error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "game_error",
                        "Ошибка при взятии карт."
                    );
                }
            }
        );


        /*
         * BITO
         */

        socket.on(
            "bito",
            async () => {

                try {

                    const result =
                        await bito(
                            player
                        );


                    if (!result.ok) {

                        emitPlayerError(
                            socket,
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


                    await sendProfile(
                        socket,
                        player
                    );


                    sendRoomList();

                } catch (err) {

                    console.error(
                        "bito error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "game_error",
                        "Ошибка завершения раунда."
                    );
                }
            }
        );


        /*
         * LEAVE ROOM
         */

        socket.on(
            "leave_room",
            async () => {

                try {

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


                    await leaveRoom(
                        player
                    );


                    socket.emit(
                        "left_room"
                    );


                    await sendProfile(
                        socket,
                        player
                    );

                } catch (err) {

                    console.error(
                        "leave_room error:",
                        err
                    );

                    emitPlayerError(
                        socket,
                        "error_message",
                        "Ошибка выхода из комнаты."
                    );
                }
            }
        );


        /*
         * DISCONNECT
         */

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


                /*
                 * Старый socket
                 * не имеет права
                 * менять состояние
                 * нового соединения.
                 */

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
   HTTP API
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


/* =========================================================
   HEALTH
========================================================= */

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

            } catch (err) {

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
                "8.0",

            database,

            telegramAuth:
                !!process.env.TELEGRAM_BOT_TOKEN,

            stakes:
                STAKES,

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
   STAKES API
========================================================= */

app.get(
    "/api/stakes",
    (
        req,
        res
    ) => {

        res.json({

            ok:
                true,

            stakes:
                STAKES.map(
                    stake => ({

                        value:
                            stake,

                        label:
                            formatMoney(
                                stake
                            ),

                        pot:
                            stake * 2
                    })
                )
        });
    }
);


/* =========================================================
   PUBLIC ROOMS API
========================================================= */

app.get(
    "/api/rooms",
    (
        req,
        res
    ) => {

        res.json({

            ok:
                true,

            rooms:
                getPublicRooms()
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

                    ok:
                        false,

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
                "Server version: 8.0"
            );

            console.log(
                "======================================"
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
                "Correct game cycle: ready"
            );

            console.log(
                "Attack / Defense / Throw-in: ready"
            );

            console.log(
                "Take / Bito: ready"
            );

            console.log(
                "Real players 1x1: ready"
            );

            console.log(
                "Authoritative game server: ready"
            );

            console.log(
                "Wallet: ready"
            );

            console.log(
                "Stake reservation: ready"
            );

            console.log(
                "Winner payout: ready"
            );

            console.log(
                "Draw refund: ready"
            );

            console.log(
                "XP / Levels: ready"
            );

            console.log(
                "Player statistics: ready"
            );

            console.log(
                "Reconnect: ready"
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
                "Stakes:",
                STAKES.join(", ")
            );

            console.log(
                "======================================"
            );
        }
    );
}


/* =========================================================
   SHUTDOWN
========================================================= */

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


/* =========================================================
   RUN
========================================================= */

start();
