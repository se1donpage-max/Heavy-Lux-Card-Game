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
VERSION 4.0

ONLINE DURAK 36 CARDS
PLAYER VS PLAYER
1x1 ROOMS
SERVER AUTHORITATIVE

Telegram
PostgreSQL
Express
Socket.IO

NO AI
NO BOT
NO SINGLE PLAYER
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

const MAX_LEVEL = 100;

const MAX_ROOMS = 1000;

const MAX_ATTACK_CARDS = 6;


/*
=========================================================
DATABASE
=========================================================
*/

const pool =
    new Pool({

        connectionString:
            DATABASE_URL,

        ssl:
            DATABASE_URL
                ? {
                    rejectUnauthorized: false
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

            pingTimeout: 20000,

            connectionStateRecovery: {

                maxDisconnectionDuration:
                    2 * 60 * 1000,

                skipMiddlewares: false

            }

        }
    );


/*
=========================================================
ROOMS
=========================================================
*/

const rooms =
    new Map();


/*
=========================================================
CARD DATA
=========================================================
*/

const SUITS = [
    "hearts",
    "diamonds",
    "clubs",
    "spades"
];

const SUIT_SYMBOLS = {

    hearts: "♥",

    diamonds: "♦",

    clubs: "♣",

    spades: "♠"

};

const RANKS = [
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14
];

const RANK_NAMES = {

    11: "J",
    12: "Q",
    13: "K",
    14: "A"

};


/*
=========================================================
XP
=========================================================
*/

function getGameXP(
    result
) {

    return result === "win"
        ? 40
        : 10;

}


/*
=========================================================
TITLE
=========================================================
*/

function getTitle(
    level
) {

    if (level >= 100)
        return "Покровитель";

    if (level >= 80)
        return "Попечитель";

    if (level >= 60)
        return "Почётный член клуба";

    if (level >= 40)
        return "Старший член клуба";

    if (level >= 20)
        return "Член клуба";

    return "Новичок";

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

    try {

        if (
            !crypto.timingSafeEqual(
                Buffer.from(
                    calculatedHash,
                    "hex"
                ),
                Buffer.from(
                    receivedHash,
                    "hex"
                )
            )
        ) {

            return {

                valid: false,

                error:
                    "Invalid Telegram signature"

            };

        }

    } catch {

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
DATABASE INIT
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

function displayNameFromUser(
    user
) {

    const first =
        user.first_name || "";

    const last =
        user.last_name || "";

    if (
        `${first} ${last}`.trim()
    ) {

        return (
            `${first} ${last}`
        ).trim();

    }

    if (user.username) {

        return "@" + user.username;

    }

    return "Игрок";

}


function getDisplayNameFromPlayer(
    player
) {

    const first =
        player.first_name || "";

    const last =
        player.last_name || "";

    const full =
        `${first} ${last}`.trim();

    if (full)
        return full;

    if (player.username)
        return "@" + player.username;

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
                money,
                xp,
                level,
                last_login
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

            RETURNING *
            `,

            [
                telegramId,
                username,
                firstName,
                lastName,
                START_MONEY,
                START_XP,
                START_LEVEL
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
            getDisplayNameFromPlayer(
                player
            ),

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
            Number(player.games_played),

        title:
            getTitle(
                Number(player.level)
            )

    };

}


async function getPlayerByTelegramId(
    telegramId
) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM heavy_lux_players
            WHERE telegram_id = $1
            LIMIT 1
            `,
            [
                String(telegramId)
            ]
        );

    return result.rows[0] || null;

}


/*
=========================================================
XP / RESULT
=========================================================
*/

async function applyGameResult(
    telegramId,
    result
) {

    const xp =
        getGameXP(
            result
        );

    await pool.query(
        `
        UPDATE heavy_lux_players
        SET
            xp = xp + $1,

            games_played =
                games_played + 1,

            wins =
                wins +
                CASE
                    WHEN $2 = 'win'
                    THEN 1
                    ELSE 0
                END,

            losses =
                losses +
                CASE
                    WHEN $2 = 'loss'
                    THEN 1
                    ELSE 0
                END
        WHERE telegram_id = $3
        `,
        [
            xp,
            result,
            String(telegramId)
        ]
    );


    /*
    Level calculation.

    100 XP per level.
    Maximum level 100.
    */

    await pool.query(
        `
        UPDATE heavy_lux_players
        SET level =
            LEAST(
                $1,
                GREATEST(
                    1,
                    FLOOR(xp / 100) + 1
                )
            )
        WHERE telegram_id = $2
        `,
        [
            MAX_LEVEL,
            String(telegramId)
        ]
    );


    return getPlayerByTelegramId(
        telegramId
    );

}


/*
=========================================================
CARDS
=========================================================
*/

function createDeck() {

    const deck = [];

    for (
        const suit of SUITS
    ) {

        for (
            const rank of RANKS
        ) {

            deck.push({

                id:
                    `${suit}-${rank}`,

                suit,

                rank

            });

        }

    }

    return deck;

}


function shuffle(
    array
) {

    for (
        let i = array.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() *
                (i + 1)
            );

        [
            array[i],
            array[j]
        ] =
        [
            array[j],
            array[i]
        ];

    }

    return array;

}


function cardName(
    card
) {

    const rank =
        RANK_NAMES[card.rank] ||
        String(card.rank);

    return (
        rank +
        SUIT_SYMBOLS[card.suit]
    );

}


/*
=========================================================
CARD COMPARISON
=========================================================
*/

function isTrump(
    card,
    trumpSuit
) {

    return (
        card.suit ===
        trumpSuit
    );

}


function canBeat(
    defenseCard,
    attackCard,
    trumpSuit
) {

    if (
        isTrump(
            attackCard,
            trumpSuit
        )
    ) {

        return (
            isTrump(
                defenseCard,
                trumpSuit
            ) &&
            defenseCard.rank >
            attackCard.rank
        );

    }


    if (
        isTrump(
            defenseCard,
            trumpSuit
        )
    ) {

        return true;

    }


    if (
        defenseCard.suit !==
        attackCard.suit
    ) {

        return false;

    }


    return (
        defenseCard.rank >
        attackCard.rank
    );

}


function cardCanBeAdded(
    card,
    table
) {

    if (!table.length)
        return true;


    for (
        const item of table
    ) {

        if (
            item.attack.rank ===
            card.rank
        ) {

            return true;

        }

        if (
            item.defense &&
            item.defense.rank ===
            card.rank
        ) {

            return true;

        }

    }

    return false;

}


/*
=========================================================
GAME PLAYER
=========================================================
*/

function getGamePlayer(
    game,
    playerId
) {

    return game.players.find(
        player =>
            player.playerId ===
            playerId
    );

}


/*
=========================================================
GAME CREATION
=========================================================
*/

function createGame(
    room
) {

    const deck =
        shuffle(
            createDeck()
        );

    const trumpCard =
        deck[
            deck.length - 1
        ];

    const trumpSuit =
        trumpCard.suit;


    const playerA =
        room.players[0];

    const playerB =
        room.players[1];


    const gamePlayers = [

        {

            playerId:
                playerA.playerId,

            socketId:
                playerA.socketId,

            displayName:
                playerA.displayName,

            username:
                playerA.username,

            hand: []

        },

        {

            playerId:
                playerB.playerId,

            socketId:
                playerB.socketId,

            displayName:
                playerB.displayName,

            username:
                playerB.username,

            hand: []

        }

    ];


    for (
        let i = 0;
        i < 6;
        i++
    ) {

        gamePlayers[0].hand.push(
            deck.shift()
        );

        gamePlayers[1].hand.push(
            deck.shift()
        );

    }


    /*
    First attacker:
    lowest trump card.
    If only one player has trump,
    that player starts.
    */

    let firstPlayer =
        gamePlayers[0];


    let bestTrump = null;


    for (
        const player of gamePlayers
    ) {

        for (
            const card of player.hand
        ) {

            if (
                card.suit !==
                trumpSuit
            ) {

                continue;

            }

            if (
                !bestTrump ||
                card.rank <
                bestTrump.rank
            ) {

                bestTrump = card;

                firstPlayer =
                    player;

            }

        }

    }


    return {

        deck,

        trumpSuit,

        trumpCard,

        players:
            gamePlayers,

        attackerId:
            firstPlayer.playerId,

        defenderId:
            gamePlayers.find(
                p =>
                    p.playerId !==
                    firstPlayer.playerId
            ).playerId,

        table: [],

        phase:
            "attack",

        waitingFor:
            "attacker",

        winnerId:
            null,

        loserId:
            null,

        finished:
            false,

        resultApplied:
            false

    };

}


/*
=========================================================
DRAW
=========================================================
*/

function drawToSix(
    game
) {

    /*
    Attacker draws first,
    defender second.

    Standard 1x1 order.
    */

    const attacker =
        getGamePlayer(
            game,
            game.attackerId
        );

    const defender =
        getGamePlayer(
            game,
            game.defenderId
        );


    const order = [
        attacker,
        defender
    ];


    for (
        const player of order
    ) {

        while (
            player.hand.length < 6 &&
            game.deck.length > 0
        ) {

            player.hand.push(
                game.deck.shift()
            );

        }

    }

}


/*
=========================================================
END ROUND
=========================================================
*/

function allTableCardsCovered(
    game
) {

    if (!game.table.length)
        return false;

    return game.table.every(
        item =>
            Boolean(
                item.defense
            )
    );

}


/*
=========================================================
WIN CHECK
=========================================================
*/

function checkWinner(
    game
) {

    if (
        game.deck.length > 0
    ) {

        return null;

    }


    for (
        const player of game.players
    ) {

        if (
            player.hand.length === 0
        ) {

            return player.playerId;

        }

    }


    return null;

}


/*
=========================================================
FINISH GAME
=========================================================
*/

async function finishGame(
    room,
    winnerId
) {

    if (
        !winnerId ||
        room.game.finished
    ) {

        return;

    }


    const game =
        room.game;


    game.finished =
        true;


    game.winnerId =
        winnerId;


    const loser =
        game.players.find(
            p =>
                p.playerId !==
                winnerId
        );


    game.loserId =
        loser?.playerId ||
        null;


    if (
        !game.resultApplied
    ) {

        game.resultApplied =
            true;


        for (
            const player of game.players
        ) {

            const result =
                player.playerId ===
                winnerId
                    ? "win"
                    : "loss";


            const updated =
                await applyGameResult(
                    player.playerId,
                    result
                );


            player.newProfile =
                serializePlayer(
                    updated
                );

        }

    }


    room.status =
        "finished";


    broadcastGameState(
        room
    );


    io.to(
        room.code
    ).emit(
        "game:finished",
        {

            winnerId,

            winnerName:
                game.players.find(
                    p =>
                        p.playerId ===
                        winnerId
                )?.displayName,

            loserId:
                game.loserId,

            message:
                game.players.find(
                    p =>
                        p.playerId ===
                        winnerId
                )?.displayName +
                " победил!"

        }
    );

}


/*
=========================================================
PREPARE NEXT ROUND
=========================================================
*/

function startNextAttack(
    room
) {

    const game =
        room.game;


    const winner =
        checkWinner(
            game
        );


    if (winner) {

        finishGame(
            room,
            winner
        );

        return;

    }


    /*
    Clear table.
    */

    game.table =
        [];


    /*
    Previous defender becomes
    attacker.

    Previous attacker becomes
    defender.
    */

    const oldAttacker =
        game.attackerId;

    game.attackerId =
        game.defenderId;

    game.defenderId =
        oldAttacker;


    drawToSix(
        game
    );


    game.phase =
        "attack";

    game.waitingFor =
        "attacker";


    broadcastGameState(
        room
    );

}


/*
=========================================================
GAME STATE
=========================================================
*/

function serializeCard(
    card,
    hidden = false
) {

    if (hidden) {

        return {

            id:
                card.id,

            hidden: true

        };

    }


    return {

        id:
            card.id,

        suit:
            card.suit,

        rank:
            card.rank,

        name:
            cardName(card)

    };

}


function getPublicGameState(
    room,
    playerId
) {

    const game =
        room.game;


    const me =
        getGamePlayer(
            game,
            playerId
        );


    const opponent =
        game.players.find(
            p =>
                p.playerId !==
                playerId
        );


    return {

        code:
            room.code,

        status:
            room.status,

        gameStarted:
            true,

        trumpSuit:
            game.trumpSuit,

        trumpCard:
            serializeCard(
                game.trumpCard
            ),

        deckCount:
            game.deck.length,

        myPlayerId:
            playerId,

        attackerId:
            game.attackerId,

        defenderId:
            game.defenderId,

        phase:
            game.phase,

        waitingFor:
            game.waitingFor,

        table:
            game.table.map(
                item => ({

                    attack:
                        serializeCard(
                            item.attack
                        ),

                    defense:
                        item.defense
                            ? serializeCard(
                                item.defense
                            )
                            : null

                })
            ),

        myHand:
            me.hand.map(
                card =>
                    serializeCard(
                        card
                    )
            ),

        opponent:
            {

                playerId:
                    opponent.playerId,

                displayName:
                    opponent.displayName,

                cardCount:
                    opponent.hand.length

            },

        finished:
            game.finished,

        winnerId:
            game.winnerId

    };

}


function broadcastGameState(
    room
) {

    if (
        !room.game
    ) {

        return;

    }


    for (
        const player of room.players
    ) {

        io.to(
            player.socketId
        ).emit(
            "game:state",
            getPublicGameState(
                room,
                player.playerId
            )
        );

    }

}


/*
=========================================================
ROOM STATE
=========================================================
*/

function broadcastRoomState(
    room
) {

    for (
        const player of room.players
    ) {

        io.to(
            player.socketId
        ).emit(
            "room:state",
            {

                code:
                    room.code,

                status:
                    room.status,

                players:
                    room.players.map(
                        p => ({

                            playerId:
                                p.playerId,

                            displayName:
                                p.displayName,

                            username:
                                p.username,

                            ready:
                                Boolean(
                                    p.ready
                                )

                        })
                    ),

                myPlayerId:
                    player.playerId,

                myReady:
                    Boolean(
                        player.ready
                    )

            }
        );

    }

}


/*
=========================================================
LOBBY
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
            room => ({

                code:
                    room.code,

                status:
                    room.status,

                players:
                    room.players.length,

                maxPlayers:
                    2

            })
        );

}


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
ROOM CODE
=========================================================
*/

function generateRoomCode() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code =
        "HL-";


    for (
        let i = 0;
        i < 2;
        i++
    ) {

        code +=
            chars[
                Math.floor(
                    Math.random() *
                    chars.length
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
            chars[
                Math.floor(
                    Math.random() *
                    chars.length
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
CREATE ROOM
=========================================================
*/

function createRoom(
    socket
) {

    const player =
        socket.data.player;


    if (
        findPlayerRoom(
            player.telegramId
        )
    ) {

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

        players: [],

        game:
            null

    };


    room.players.push({

        playerId:
            player.telegramId,

        socketId:
            socket.id,

        displayName:
            player.displayName,

        username:
            player.username,

        ready:
            true,

        connected:
            true

    });


    rooms.set(
        code,
        room
    );


    socket.join(
        code
    );


    socket.data.roomCode =
        code;


    socket.emit(
        "room:created",
        {

            code

        }
    );


    broadcastRoomState(
        room
    );


    broadcastLobby();


    console.log(
        `Room created: ${code} by ${player.displayName}`
    );

}


/*
=========================================================
FIND PLAYER ROOM
=========================================================
*/

function findPlayerRoom(
    playerId
) {

    for (
        const room of rooms.values()
    ) {

        if (
            room.players.some(
                player =>
                    player.playerId ===
                    String(playerId)
            )
        ) {

            return room;

        }

    }

    return null;

}


/*
=========================================================
JOIN ROOM
=========================================================
*/

function joinRoom(
    socket,
    code
) {

    const player =
        socket.data.player;


    const normalizedCode =
        String(
            code || ""
        )
        .trim()
        .toUpperCase();


    if (
        findPlayerRoom(
            player.telegramId
        )
    ) {

        socket.emit(
            "room:error",
            {

                error:
                    "Вы уже находитесь в комнате."

            }
        );

        return;

    }


    const room =
        rooms.get(
            normalizedCode
        );


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
                    "Игра уже началась."

            }
        );

        return;

    }


    if (
        room.players.length >= 2
    ) {

        socket.emit(
            "room:error",
            {

                error:
                    "Комната заполнена."

            }
        );

        return;

    }


    room.players.push({

        playerId:
            player.telegramId,

        socketId:
            socket.id,

        displayName:
            player.displayName,

        username:
            player.username,

        ready:
            true,

        connected:
            true

    });


    socket.join(
        room.code
    );


    socket.data.roomCode =
        room.code;


    socket.emit(
        "room:joined",
        {

            code:
                room.code

        }
    );


    broadcastRoomState(
        room
    );


    broadcastLobby();


    if (
        room.players.length ===
        2
    ) {

        room.status =
            "starting";


        broadcastRoomState(
            room
        );


        setTimeout(
            () => {

                const currentRoom =
                    rooms.get(
                        room.code
                    );


                if (
                    !currentRoom ||
                    currentRoom.players.length !== 2
                ) {

                    return;

                }


                startGame(
                    currentRoom
                );

            },
            800
        );

    }


    console.log(
        `${player.displayName} joined ${room.code}`
    );

}


/*
=========================================================
START GAME
=========================================================
*/

function startGame(
    room
) {

    if (
        room.players.length !== 2
    ) {

        return;

    }


    room.status =
        "playing";


    room.game =
        createGame(
            room
        );


    broadcastGameState(
        room
    );


    broadcastLobby();


    io.to(
        room.code
    ).emit(
        "game:started",
        {

            message:
                "Игра началась!"

        }
    );


    console.log(
        `Game started: ${room.code}`
    );

}


/*
=========================================================
LEAVE ROOM
=========================================================
*/

function leaveRoom(
    socket
) {

    const player =
        socket.data.player;


    const roomCode =
        socket.data.roomCode;


    if (!roomCode) {

        return;

    }


    const room =
        rooms.get(
            roomCode
        );


    if (!room) {

        socket.data.roomCode =
            null;

        return;

    }


    const roomPlayer =
        room.players.find(
            p =>
                p.playerId ===
                player.telegramId
        );


    if (roomPlayer) {

        roomPlayer.connected =
            false;

    }


    /*
    Если игра идёт,
    второй игрок получает победу
    при намеренном выходе.
    */

    if (
        room.status ===
        "playing" &&
        room.game &&
        !room.game.finished
    ) {

        const opponent =
            room.players.find(
                p =>
                    p.playerId !==
                    player.telegramId
            );


        if (opponent) {

            finishGame(
                room,
                opponent.playerId
            );

        }

    }


    room.players =
        room.players.filter(
            p =>
                p.playerId !==
                player.telegramId
        );


    socket.leave(
        roomCode
    );


    socket.data.roomCode =
        null;


    if (
        room.players.length === 0
    ) {

        rooms.delete(
            roomCode
        );

    } else {

        room.status =
            "waiting";

        room.game =
            null;

        room.players[0].ready =
            true;


        io.to(
            room.players[0].socketId
        ).emit(
            "room:opponent_left",
            {

                message:
                    "Соперник покинул комнату."

            }
        );


        broadcastRoomState(
            room
        );

    }


    broadcastLobby();

}


/*
=========================================================
READY
=========================================================
*/

function toggleReady(
    socket
) {

    const player =
        socket.data.player;


    const roomCode =
        socket.data.roomCode;


    const room =
        rooms.get(
            roomCode
        );


    if (!room)
        return;


    if (
        room.status !==
        "waiting"
    )
        return;


    const roomPlayer =
        getRoomPlayerById(
            room,
            player.telegramId
        );


    if (!roomPlayer)
        return;


    roomPlayer.ready =
        !roomPlayer.ready;


    broadcastRoomState(
        room
    );

}


function getRoomPlayerById(
    room,
    playerId
) {

    return room.players.find(
        p =>
            p.playerId ===
            String(playerId)
    );

}


/*
=========================================================
GAME VALIDATION
=========================================================
*/

function reject(
    socket,
    message
) {

    socket.emit(
        "game:error",
        {
            error: message
        }
    );

}


function requirePlayingGame(
    socket
) {

    const player =
        socket.data.player;


    const roomCode =
        socket.data.roomCode;


    const room =
        rooms.get(
            roomCode
        );


    if (!room) {

        reject(
            socket,
            "Комната не найдена."
        );

        return null;

    }


    if (
        room.status !==
        "playing"
    ) {

        reject(
            socket,
            "Игра сейчас не активна."
        );

        return null;

    }


    if (
        !room.game ||
        room.game.finished
    ) {

        reject(
            socket,
            "Игра завершена."
        );

        return null;

    }


    return {

        room,

        game:
            room.game,

        playerId:
            player.telegramId

    };

}


/*
=========================================================
FIND CARD IN HAND
=========================================================
*/

function findCardInHand(
    player,
    cardId
) {

    return player.hand.find(
        card =>
            card.id ===
            String(cardId)
    );

}


function removeCardFromHand(
    player,
    cardId
) {

    const index =
        player.hand.findIndex(
            card =>
                card.id ===
                String(cardId)
        );


    if (
        index === -1
    ) {

        return null;

    }


    return player.hand.splice(
        index,
        1
    )[0];

}


/*
=========================================================
ATTACK
=========================================================
*/

function playAttackCard(
    socket,
    cardId
) {

    const context =
        requirePlayingGame(
            socket
        );


    if (!context)
        return;


    const {
        room,
        game,
        playerId
    } = context;


    if (
        game.phase !==
        "attack"
    ) {

        reject(
            socket,
            "Сейчас нельзя атаковать."
        );

        return;

    }


    if (
        game.waitingFor !==
        "attacker"
    ) {

        reject(
            socket,
            "Сейчас ход защитника."
        );

        return;

    }


    if (
        game.attackerId !==
        playerId
    ) {

        reject(
            socket,
            "Сейчас ход другого игрока."
        );

        return;

    }


    if (
        game.table.length >=
        MAX_ATTACK_CARDS
    ) {

        reject(
            socket,
            "Достигнуто максимальное количество карт атаки."
        );

        return;

    }


    const attacker =
        getGamePlayer(
            game,
            playerId
        );


    const card =
        findCardInHand(
            attacker,
            cardId
        );


    if (!card) {

        reject(
            socket,
            "Этой карты нет у вас."
        );

        return;

    }


    /*
    Первая карта может быть любой.
    Следующие карты должны совпадать
    с рангом любой карты на столе.
    */

    if (
        game.table.length > 0 &&
        !cardCanBeAdded(
            card,
            game.table
        )
    ) {

        reject(
            socket,
            "Можно подкинуть только карту подходящего достоинства."
        );

        return;

    }


    /*
    Нельзя атаковать, если у защитника
    уже нет карт.
    */

    const defender =
        getGamePlayer(
            game,
            game.defenderId
        );


    if (
        defender.hand.length === 0
    ) {

        reject(
            socket,
            "У защитника нет карт."
        );

        return;

    }


    const removed =
        removeCardFromHand(
            attacker,
            cardId
        );


    if (!removed) {

        reject(
            socket,
            "Не удалось сыграть карту."
        );

        return;

    }


    game.table.push({

        attack:
            removed,

        defense:
            null

    });


    game.phase =
        "defense";

    game.waitingFor =
        "defender";


    broadcastGameState(
        room
    );

}


/*
=========================================================
DEFEND
=========================================================
*/

function defendCard(
    socket,
    defenseCardId,
    attackCardId
) {

    const context =
        requirePlayingGame(
            socket
        );


    if (!context)
        return;


    const {
        room,
        game,
        playerId
    } = context;


    if (
        game.phase !==
        "defense"
    ) {

        reject(
            socket,
            "Сейчас нельзя защищаться."
        );

        return;

    }


    if (
        game.waitingFor !==
        "defender"
    ) {

        reject(
            socket,
            "Сейчас ход другого игрока."
        );

        return;

    }


    if (
        game.defenderId !==
        playerId
    ) {

        reject(
            socket,
            "Сейчас ход другого игрока."
        );

        return;

    }


    const defender =
        getGamePlayer(
            game,
            playerId
        );


    const tableItem =
        game.table.find(
            item =>
                item.attack.id ===
                String(attackCardId)
        );


    if (!tableItem) {

        reject(
            socket,
            "Карта атаки не найдена."
        );

        return;

    }


    if (tableItem.defense) {

        reject(
            socket,
            "Эта карта уже побита."
        );

        return;

    }


    const defenseCard =
        findCardInHand(
            defender,
            defenseCardId
        );


    if (!defenseCard) {

        reject(
            socket,
            "Этой карты нет у вас."
        );

        return;

    }


    if (
        !canBeat(
            defenseCard,
            tableItem.attack,
            game.trumpSuit
        )
    ) {

        reject(
            socket,
            "Этой картой нельзя побить атаку."
        );

        return;

    }


    const removed =
        removeCardFromHand(
            defender,
            defenseCardId
        );


    if (!removed) {

        reject(
            socket,
            "Не удалось сыграть карту."
        );

        return;

    }


    tableItem.defense =
        removed;


    /*
    Если все карты побиты,
    атакующий может подкинуть
    ещё одну карту или закончить.
    */

    if (
        allTableCardsCovered(
            game
        )
    ) {

        game.phase =
            "attack";

        game.waitingFor =
            "attacker";

    }


    broadcastGameState(
        room
    );

}


/*
=========================================================
TAKE CARDS
=========================================================
*/

function takeCards(
    socket
) {

    const context =
        requirePlayingGame(
            socket
        );


    if (!context)
        return;


    const {
        room,
        game,
        playerId
    } = context;


    if (
        game.defenderId !==
        playerId
    ) {

        reject(
            socket,
            "Вы не защитник."
        );

        return;

    }


    if (
        game.waitingFor !==
        "defender"
    ) {

        reject(
            socket,
            "Сейчас нельзя брать карты."
        );

        return;

    }


    const defender =
        getGamePlayer(
            game,
            playerId
        );


    /*
    Все атакующие карты
    переходят защитнику.

    Побитые карты тоже здесь не должны
    находиться, потому что после каждой
    защиты карта закрыта.
    */

    for (
        const item of game.table
    ) {

        defender.hand.push(
            item.attack
        );


        if (
            item.defense
        ) {

            defender.hand.push(
                item.defense
            );

        }

    }


    game.table =
        [];


    /*
    Защитник взял карты.
    Он остаётся защитником,
    атакующий начинает новый раунд.
    */

    drawToSix(
        game
    );


    game.phase =
        "attack";

    game.waitingFor =
        "attacker";


    broadcastGameState(
        room
    );


    const winner =
        checkWinner(
            game
        );


    if (winner) {

        finishGame(
            room,
            winner
        );

    }

}


/*
=========================================================
END ATTACK
=========================================================
*/

function endAttack(
    socket
) {

    const context =
        requirePlayingGame(
            socket
        );


    if (!context)
        return;


    const {
        room,
        game,
        playerId
    } = context;


    if (
        game.attackerId !==
        playerId
    ) {

        reject(
            socket,
            "Вы не атакующий."
        );

        return;

    }


    if (
        game.table.length === 0
    ) {

        reject(
            socket,
            "Сначала нужно атаковать."
        );

        return;

    }


    /*
    Нельзя закончить атаку,
    пока есть непобитая карта.
    */

    if (
        !allTableCardsCovered(
            game
        )
    ) {

        reject(
            socket,
            "Сначала защитник должен побить все карты или взять."
        );

        return;

    }


    /*
    Проверяем возможность победы
    до добора.
    */

    if (
        game.deck.length === 0
    ) {

        const winner =
            checkWinner(
                game
            );


        if (winner) {

            finishGame(
                room,
                winner
            );

            return;

        }

    }


    /*
    Убираем карты в битое.
    */

    game.table =
        [];


    /*
    Следующий раунд.
    */

    const oldAttacker =
        game.attackerId;

    game.attackerId =
        game.defenderId;

    game.defenderId =
        oldAttacker;


    drawToSix(
        game
    );


    game.phase =
        "attack";

    game.waitingFor =
        "attacker";


    const winner =
        checkWinner(
            game
        );


    if (winner) {

        finishGame(
            room,
            winner
        );

        return;

    }


    broadcastGameState(
        room
    );

}


/*
=========================================================
GAME EVENTS
=========================================================
*/

function registerGameEvents(
    socket
) {

    socket.on(
        "game:attack",
        data => {

            playAttackCard(
                socket,
                data?.cardId
            );

        }
    );


    socket.on(
        "game:defend",
        data => {

            defendCard(
                socket,
                data?.defenseCardId,
                data?.attackCardId
            );

        }
    );


    socket.on(
        "game:take",
        () => {

            takeCards(
                socket
            );

        }
    );


    socket.on(
        "game:end_attack",
        () => {

            endAttack(
                socket
            );

        }
    );


    socket.on(
        "game:request_state",
        () => {

            const player =
                socket.data.player;


            const room =
                findPlayerRoom(
                    player.telegramId
                );


            if (
                room &&
                room.game &&
                !room.game.finished
            ) {

                /*
                Обновляем socketId
                после переподключения.
                */

                const roomPlayer =
                    getRoomPlayerById(
                        room,
                        player.telegramId
                    );


                if (roomPlayer) {

                    roomPlayer.socketId =
                        socket.id;

                    roomPlayer.connected =
                        true;

                    socket.data.roomCode =
                        room.code;


                    socket.join(
                        room.code
                    );

                }


                broadcastGameState(
                    room
                );

            }

        }
    );

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


            socket.data.player =
                serializePlayer(
                    dbPlayer
                );


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
    socket => {

        const player =
            socket.data.player;


        console.log(
            `Socket connected: ${socket.id} / ${player.displayName}`
        );


        /*
        Если игрок уже находится
        в комнате — восстанавливаем
        его socket.
        */

        const existingRoom =
            findPlayerRoom(
                player.telegramId
            );


        if (existingRoom) {

            const roomPlayer =
                getRoomPlayerById(
                    existingRoom,
                    player.telegramId
                );


            if (roomPlayer) {

                roomPlayer.socketId =
                    socket.id;

                roomPlayer.connected =
                    true;

                socket.data.roomCode =
                    existingRoom.code;

                socket.join(
                    existingRoom.code
                );


                if (
                    existingRoom.game
                ) {

                    broadcastGameState(
                        existingRoom
                    );

                } else {

                    broadcastRoomState(
                        existingRoom
                    );

                }

            }

        }


        socket.emit(
            "server:hello",
            {

                ok: true,

                project:
                    "Heavy Lux Card",

                player

            }
        );


        socket.emit(
            "lobby:rooms",
            {

                rooms:
                    getOpenRooms()

            }
        );


        /*
        ROOM
        */

        socket.on(
            "room:create",
            () => {

                createRoom(
                    socket
                );

            }
        );


        socket.on(
            "room:join",
            data => {

                joinRoom(
                    socket,
                    data?.code
                );

            }
        );


        socket.on(
            "room:leave",
            () => {

                leaveRoom(
                    socket
                );

            }
        );


        socket.on(
            "room:ready",
            () => {

                toggleReady(
                    socket
                );

            }
        );


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


        registerGameEvents(
            socket
        );


        /*
        DISCONNECT
        */

        socket.on(
            "disconnect",
            reason => {

                console.log(
                    `Socket disconnected: ${socket.id}`,
                    reason
                );


                const player =
                    socket.data.player;


                const room =
                    findPlayerRoom(
                        player.telegramId
                    );


                /*
                НЕ удаляем игрока мгновенно.

                Это важно для мобильного Telegram:
                при временном обрыве Socket.IO
                игрок может переподключиться.
                */

                if (room) {

                    const roomPlayer =
                        getRoomPlayerById(
                            room,
                            player.telegramId
                        );


                    if (roomPlayer) {

                        roomPlayer.connected =
                            false;

                    }


                    /*
                    Даём время
                    на восстановление.
                    */

                    setTimeout(
                        () => {

                            const currentRoom =
                                findPlayerRoom(
                                    player.telegramId
                                );


                            if (!currentRoom)
                                return;


                            const currentPlayer =
                                getRoomPlayerById(
                                    currentRoom,
                                    player.telegramId
                                );


                            if (
                                !currentPlayer
                            )
                                return;


                            /*
                            Если игрок уже
                            переподключился,
                            ничего не делаем.
                            */

                            if (
                                currentPlayer.connected
                            ) {

                                return;

                            }


                            /*
                            Игрок действительно ушёл.
                            */

                            const fakeSocket = {

                                data: {

                                    player,

                                    roomCode:
                                        currentRoom.code

                                },

                                leave: () => {},

                                emit: () => {}

                            };


                            /*
                            Если игра идёт —
                            победа сопернику.
                            */

                            if (
                                currentRoom.status ===
                                "playing" &&
                                currentRoom.game &&
                                !currentRoom.game.finished
                            ) {

                                const opponent =
                                    currentRoom.players.find(
                                        p =>
                                            p.playerId !==
                                            player.telegramId
                                    );


                                if (opponent) {

                                    finishGame(
                                        currentRoom,
                                        opponent.playerId
                                    );

                                }

                            }


                            currentRoom.players =
                                currentRoom.players.filter(
                                    p =>
                                        p.playerId !==
                                        player.telegramId
                                );


                            if (
                                currentRoom.players.length ===
                                0
                            ) {

                                rooms.delete(
                                    currentRoom.code
                                );

                            } else {

                                currentRoom.status =
                                    "waiting";

                                currentRoom.game =
                                    null;


                                io.to(
                                    currentRoom.players[0].socketId
                                ).emit(
                                    "room:opponent_left",
                                    {

                                        message:
                                            "Соперник отключился."

                                    }
                                );


                                broadcastRoomState(
                                    currentRoom
                                );

                            }


                            broadcastLobby();

                        },

                        35000
                    );

                }

            }
        );

    }
);


/*
=========================================================
HEALTH
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

        } catch {}

        res.json({

            ok: true,

            project:
                "Heavy Lux Card",

            version:
                "4.0.0",

            database,

            telegram:
                Boolean(
                    BOT_TOKEN
                ),

            socket:
                true,

            rooms:
                rooms.size

        });

    }
);


/*
=========================================================
TELEGRAM AUTH API
=========================================================
*/

app.post(
    "/api/auth/telegram",
    async (req, res) => {

        try {

            const result =
                validateTelegramInitData(
                    req.body?.initData
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
SERVER START
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
