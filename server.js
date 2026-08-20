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
STATIC
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
=========================================================
GAME CONSTANTS
=========================================================
*/

const SUITS = [
    "♠",
    "♥",
    "♦",
    "♣"
];

const RANKS = [
    {
        name: "6",
        value: 6
    },
    {
        name: "7",
        value: 7
    },
    {
        name: "8",
        value: 8
    },
    {
        name: "9",
        value: 9
    },
    {
        name: "10",
        value: 10
    },
    {
        name: "J",
        value: 11
    },
    {
        name: "Q",
        value: 12
    },
    {
        name: "K",
        value: 13
    },
    {
        name: "A",
        value: 14
    }
];

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
TELEGRAM
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
AUTH
=========================================================
*/

function authenticate(socket) {

    const initData =
        socket.handshake.auth?.initData || "";

    const telegramUser =
        parseTelegramUser(initData);

    /*
    TELEGRAM
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
                item.telegramId ===
                telegramId
            ) {
                player = item;
                break;
            }
        }

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
    TEST MODE
    */

    const testPlayerId =
        socket.handshake.auth?.testPlayerId ||
        `test_${socket.id}`;

    let player =
        players.get(testPlayerId);

    if (!player) {

        player = {

            playerId:
                testPlayerId,

            telegramId:
                null,

            name:
                "Игрок " +
                testPlayerId.slice(-4),

            username:
                "",

            socketId:
                socket.id,

            connected:
                true,

            roomId:
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

    } catch (error) {

        console.error(
            "savePlayer error:",
            error
        );
    }
}

/*
=========================================================
CARD
=========================================================
*/

function createDeck() {

    const deck = [];

    for (const suit of SUITS) {

        for (const rank of RANKS) {

            deck.push({

                id:
                    createId(10),

                suit,

                rank:
                    rank.name,

                value:
                    rank.value
            });
        }
    }

    return deck;
}

/*
=========================================================
SHUFFLE
=========================================================
*/

function shuffle(array) {

    for (
        let i = array.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            array[i],
            array[j]
        ] = [
            array[j],
            array[i]
        ];
    }

    return array;
}

/*
=========================================================
CARD HELPERS
=========================================================
*/

function isTrump(card, trumpSuit) {

    return (
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
            defenseCard.value >
            attackCard.value
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

    return (
        defenseCard.suit ===
        attackCard.suit &&
        defenseCard.value >
        attackCard.value
    );
}

function cardLabel(card) {

    return `${card.rank}${card.suit}`;
}

/*
=========================================================
PLAYER IN ROOM
=========================================================
*/

function roomPlayer(room, playerId) {

    return room.players.find(
        (p) =>
            p.playerId === playerId
    );
}

/*
=========================================================
ROOM PUBLIC
=========================================================
*/

function publicRoom(room) {

    return {

        id:
            room.id,

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers:
            2,

        players:
            room.players.map(
                (p) => ({
                    playerId:
                        p.playerId,

                    name:
                        p.name,

                    connected:
                        p.connected
                })
            )
    };
}

/*
=========================================================
GAME STATE FOR PLAYER
=========================================================
*/

function gameState(
    room,
    playerId
) {

    const me =
        roomPlayer(
            room,
            playerId
        );

    const opponent =
        room.players.find(
            (p) =>
                p.playerId !==
                playerId
        );

    let phase =
        room.phase;

    let turn =
        "WAITING";

    if (
        room.status ===
        "playing"
    ) {

        if (
            room.attackerId ===
            playerId
        ) {

            turn =
                "YOUR_TURN";

        } else {

            turn =
                "OPPONENT_TURN";
        }
    }

    let hand = [];

    if (me) {

        hand =
            me.hand.map(
                (card) => ({
                    id:
                        card.id,

                    suit:
                        card.suit,

                    rank:
                        card.rank,

                    value:
                        card.value
                })
            );
    }

    const table =
        room.table.map(
            (pair) => ({

                attack: {
                    id:
                        pair.attack.id,

                    suit:
                        pair.attack.suit,

                    rank:
                        pair.attack.rank,

                    value:
                        pair.attack.value
                },

                defense:
                    pair.defense
                        ? {
                            id:
                                pair.defense.id,

                            suit:
                                pair.defense.suit,

                            rank:
                                pair.defense.rank,

                            value:
                                pair.defense.value
                        }
                        : null
            })
        );

    return {

        roomId:
            room.id,

        status:
            room.status,

        phase,

        turn,

        attackerId:
            room.attackerId,

        defenderId:
            room.defenderId,

        trumpSuit:
            room.trumpSuit,

        deckCount:
            room.deck.length,

        hand,

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

        moves:
            room.moves.slice(-30),

        winnerId:
            room.winnerId || null,

        loserId:
            room.loserId || null
    };
}

/*
=========================================================
SEND GAME STATE
=========================================================
*/

function sendRoomState(room) {

    if (!room) {
        return;
    }

    for (
        const rp of room.players
    ) {

        const player =
            getPlayer(
                rp.playerId
            );

        if (!player) {
            continue;
        }

        if (!player.socketId) {
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

/*
=========================================================
ROOM LIST
=========================================================
*/

function sendRoomList() {

    io.emit(
        "rooms_list",
        Array.from(
            rooms.values()
        ).map(publicRoom)
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

                connected:
                    true,

                hand: []
            }
        ],

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

        table: [],

        moves: [],

        winnerId:
            null,

        loserId:
            null
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
        getRoom(roomId);

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

        hand:
            []
    });

    player.roomId =
        room.id;

    startGame(room);

    return {
        ok: true,
        room
    };
}

/*
=========================================================
START GAME
=========================================================
*/

function startGame(room) {

    room.status =
        "playing";

    room.phase =
        "attack";

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
        (p) => {
            p.hand = [];
        }
    );

    /*
    DEAL 6 EACH
    */

    for (let i = 0; i < 6; i++) {

        for (
            const player of room.players
        ) {

            if (room.deck.length) {

                player.hand.push(
                    room.deck.pop()
                );
            }
        }
    }

    /*
    LAST CARD OF DECK
    DETERMINES TRUMP
    */

    if (room.deck.length) {

        const trumpCard =
            room.deck[
                room.deck.length - 1
            ];

        room.trumpSuit =
            trumpCard.suit;

    } else {

        room.trumpSuit =
            room.players[0]
                .hand[0]
                .suit;
    }

    /*
    FIRST ATTACKER:
    PLAYER WITH LOWEST TRUMP
    */

    let firstPlayer =
        null;

    let lowestTrump =
        null;

    for (
        const player of room.players
    ) {

        const trumps =
            player.hand.filter(
                (card) =>
                    card.suit ===
                    room.trumpSuit
            );

        for (
            const card of trumps
        ) {

            if (
                !lowestTrump ||
                card.value <
                lowestTrump.value
            ) {

                lowestTrump =
                    card;

                firstPlayer =
                    player;
            }
        }
    }

    /*
    Если ни у кого нет козыря —
    первый игрок комнаты.
    */

    if (!firstPlayer) {

        firstPlayer =
            room.players[0];
    }

    const secondPlayer =
        room.players.find(
            (p) =>
                p.playerId !==
                firstPlayer.playerId
        );

    room.attackerId =
        firstPlayer.playerId;

    room.defenderId =
        secondPlayer.playerId;

    room.phase =
        "attack";
}

/*
=========================================================
VALID ATTACK
=========================================================
*/

function validAttackCard(
    room,
    card
) {

    if (
        room.table.length === 0
    ) {
        return true;
    }

    const values =
        new Set();

    for (
        const pair of room.table
    ) {

        values.add(
            pair.attack.value
        );

        if (pair.defense) {

            values.add(
                pair.defense.value
            );
        }
    }

    return values.has(
        card.value
    );
}

/*
=========================================================
MAX TABLE
=========================================================
*/

function maxTableCards(room) {

    const defender =
        roomPlayer(
            room,
            room.defenderId
        );

    if (!defender) {
        return 0;
    }

    return Math.min(
        6,
        defender.hand.length
    );
}

/*
=========================================================
FIND CARD
=========================================================
*/

function findCard(
    player,
    cardId
) {

    return player.hand.find(
        (card) =>
            card.id === cardId
    );
}

/*
=========================================================
REMOVE CARD
=========================================================
*/

function removeCard(
    player,
    cardId
) {

    const index =
        player.hand.findIndex(
            (card) =>
                card.id === cardId
        );

    if (index === -1) {
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

function attack(
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
                "Игра завершена."
        };
    }

    if (
        room.attackerId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас не ваша атака."
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

    if (
        room.table.length >=
        maxTableCards(room)
    ) {

        return {
            ok: false,
            error:
                "Больше карт подкинуть нельзя."
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
                "Карта не найдена."
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
            cardLabel(removed),

        timestamp:
            Date.now()
    });

    return {
        ok: true
    };
}

/*
=========================================================
DEFEND
=========================================================
*/

function defend(
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
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Вы не защищаетесь."
        };
    }

    const pair =
        room.table.find(
            (item) =>
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

    const defenseCard =
        findCard(
            player,
            defenseId
        );

    if (!defenseCard) {

        return {
            ok: false,
            error:
                "Карты нет у вас."
        };
    }

    if (
        !canBeat(
            pair.attack,
            defenseCard,
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
                "Карта не найдена."
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
            cardLabel(pair.attack),

        card:
            cardLabel(removed),

        timestamp:
            Date.now()
    });

    /*
    Если все карты отбиты —
    атакующий может подкинуть ещё.
    */

    room.phase =
        "attack";

    return {
        ok: true
    };
}

/*
=========================================================
CAN TAKE
=========================================================
*/

function takeCards(player) {

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
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас вы не защищаетесь."
        };
    }

    const hasUnbeaten =
        room.table.some(
            (pair) =>
                !pair.defense
        );

    if (!hasUnbeaten) {

        return {
            ok: false,
            error:
                "Все карты уже отбиты."
        };
    }

    const defender =
        player;

    /*
    Забираем все карты со стола.
    */

    for (
        const pair of room.table
    ) {

        defender.hand.push(
            pair.attack
        );

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
            room.table.length,

        timestamp:
            Date.now()
    });

    room.table =
        [];

    /*
    Атакующий остаётся атакующим.
    */

    room.phase =
        "draw";

    finishRound(
        room,
        false
    );

    return {
        ok: true
    };
}

/*
=========================================================
DRAW CARDS
=========================================================
*/

function drawToSix(room) {

    /*
    В Дураке сначала добирает
    атакующий, затем второй игрок.
    */

    const attacker =
        roomPlayer(
            room,
            room.attackerId
        );

    const defender =
        roomPlayer(
            room,
            room.defenderId
        );

    const order = [
        attacker,
        defender
    ];

    for (
        const player of order
    ) {

        if (!player) {
            continue;
        }

        while (
            player.hand.length < 6 &&
            room.deck.length > 0
        ) {

            player.hand.push(
                room.deck.pop()
            );
        }
    }
}

/*
=========================================================
CHECK GAME OVER
=========================================================
*/

function checkGameOver(room) {

    if (
        room.deck.length > 0
    ) {
        return false;
    }

    const empty =
        room.players.find(
            (p) =>
                p.hand.length === 0
        );

    if (!empty) {
        return false;
    }

    const winner =
        empty;

    const loser =
        room.players.find(
            (p) =>
                p.playerId !==
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

    return true;
}

/*
=========================================================
FINISH ROUND
=========================================================
*/

function finishRound(
    room,
    successfulDefense
) {

    /*
    Если игрок взял —
    атака остаётся за атакующим.

    Если отбился —
    роли меняются.
    */

    if (
        successfulDefense
    ) {

        const oldAttacker =
            room.attackerId;

        room.attackerId =
            room.defenderId;

        room.defenderId =
            oldAttacker;
    }

    drawToSix(room);

    if (
        checkGameOver(room)
    ) {
        return;
    }

    room.phase =
        "attack";
}

/*
=========================================================
BEAT ROUND
=========================================================
*/

function endSuccessfulDefense(
    room
) {

    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            (pair) =>
                !!pair.defense
        );

    if (!allDefended) {

        return false;
    }

    room.moves.push({

        type:
            "successful_defense",

        playerId:
            room.defenderId,

        timestamp:
            Date.now()
    });

    room.table =
        [];

    finishRound(
        room,
        true
    );

    return true;
}

/*
=========================================================
LEAVE
=========================================================
*/

function leaveRoom(player) {

    const roomId =
        player.roomId;

    if (!roomId) {
        return;
    }

    const room =
        getRoom(roomId);

    if (!room) {

        player.roomId =
            null;

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

    /*
    Если игрок вышел —
    оставшийся считается победителем
    технически.
    */

    if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.id
        );

    } else {

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
        } else {

            room.status =
                "waiting";

            room.phase =
                "waiting";
        }
    }

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

        /*
        Защита от старого socket
        */

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
        RECONNECT
        */

        if (player.roomId) {

            const room =
                getRoom(
                    player.roomId
                );

            if (room) {

                const rp =
                    roomPlayer(
                        room,
                        player.playerId
                    );

                if (rp) {

                    rp.socketId =
                        socket.id;

                    rp.connected =
                        true;

                    rp.name =
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
        PROFILE
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
        ROOMS
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
        CREATE
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
        JOIN
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
                    "Attacker:",
                    room.attackerId
                );

                console.log(
                    "Defender:",
                    room.defenderId
                );

                console.log(
                    "Trump:",
                    room.trumpSuit
                );
            }
        );

        /*
        ATTACK
        */

        socket.on(
            "attack_card",
            (cardId) => {

                const result =
                    attack(
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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );
            }
        );

        /*
        DEFEND
        */

        socket.on(
            "defend_card",
            (data) => {

                const result =
                    defend(
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

                /*
                Если всё отбито —
                раунд автоматически заканчивается.
                */

                endSuccessfulDefense(
                    room
                );

                sendRoomState(
                    room
                );
            }
        );

        /*
        TAKE
        */

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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );
            }
        );

        /*
        LEAVE
        */

        socket.on(
            "leave_room",
            () => {

                leaveRoom(
                    player
                );

                socket.leave(
                    player.roomId || ""
                );

                socket.emit(
                    "left_room"
                );
            }
        );

        /*
        DISCONNECT
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
                Старый socket
                не должен менять
                новый.
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
                        getRoom(
                            current.roomId
                        );

                    if (room) {

                        const rp =
                            roomPlayer(
                                room,
                                current.playerId
                            );

                        if (rp) {

                            rp.connected =
                                false;
                        }

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

            ok:
                true,

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
                "======================================"
            );

            console.log(
                "HEAVY LUX CARD"
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
                "1x1 rooms: ready"
            );

            console.log(
                "Telegram authentication: configured"
            );

            console.log(
                "======================================"
            );
        }
    );
}

start();
