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
app.use(express.static(__dirname));

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
DURAK
=========================================================
*/

const SUITS = [
    "♠",
    "♥",
    "♦",
    "♣"
];

const RANKS = [
    { name: "6", value: 6 },
    { name: "7", value: 7 },
    { name: "8", value: 8 },
    { name: "9", value: 9 },
    { name: "10", value: 10 },
    { name: "J", value: 11 },
    { name: "Q", value: 12 },
    { name: "K", value: 13 },
    { name: "A", value: 14 }
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

function roomPlayer(room, playerId) {
    if (!room) return null;

    return room.players.find(
        p => p.playerId === playerId
    );
}

function opponentOf(room, playerId) {
    if (!room) return null;

    return room.players.find(
        p => p.playerId !== playerId
    );
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

        for (
            const item of players.values()
        ) {

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
DECK
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
CARDS
=========================================================
*/

function isTrump(card, trumpSuit) {

    return (
        card &&
        card.suit === trumpSuit
    );
}

function canBeat(
    attackCard,
    defenseCard,
    trumpSuit
) {

    if (!attackCard || !defenseCard) {
        return false;
    }

    /*
    Козырную карту можно бить
    только старшим козырем.
    */

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

    /*
    Некозырную карту можно бить
    картой той же масти или козырем.
    */

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

function findCard(
    playerInRoom,
    cardId
) {

    if (!playerInRoom) {
        return null;
    }

    if (!Array.isArray(playerInRoom.hand)) {
        return null;
    }

    return playerInRoom.hand.find(
        card =>
            card.id === cardId
    );
}

function removeCard(
    playerInRoom,
    cardId
) {

    if (!playerInRoom) {
        return null;
    }

    if (!Array.isArray(playerInRoom.hand)) {
        return null;
    }

    const index =
        playerInRoom.hand.findIndex(
            card =>
                card.id === cardId
        );

    if (index === -1) {
        return null;
    }

    return playerInRoom.hand.splice(
        index,
        1
    )[0];
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
                p => ({
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
GAME TURN
=========================================================
*/

function getTurnForPlayer(
    room,
    playerId
) {

    if (
        room.status !==
        "playing"
    ) {

        return "WAITING";
    }

    /*
    АТАКА
    */

    if (
        room.phase ===
        "attack"
    ) {

        return (
            room.attackerId ===
            playerId
        )
            ? "YOUR_TURN"
            : "OPPONENT_TURN";
    }

    /*
    ЗАЩИТА
    */

    if (
        room.phase ===
        "defense"
    ) {

        return (
            room.defenderId ===
            playerId
        )
            ? "YOUR_TURN"
            : "OPPONENT_TURN";
    }

    return "WAITING";
}

/*
=========================================================
GAME STATE
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
        opponentOf(
            room,
            playerId
        );

    const hand =
        me && Array.isArray(me.hand)
            ? me.hand.map(card => ({
                id:
                    card.id,

                suit:
                    card.suit,

                rank:
                    card.rank,

                value:
                    card.value
            }))
            : [];

    const table =
        room.table.map(
            pair => ({

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

        phase:
            room.phase,

        turn:
            getTurnForPlayer(
                room,
                playerId
            ),

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
                        Array.isArray(
                            opponent.hand
                        )
                            ? opponent.hand.length
                            : 0
                }

                : null,

        table,

        moves:
            room.moves.slice(-30),

        winnerId:
            room.winnerId || null,

        loserId:
            room.loserId || null,

        canTake:
            room.phase ===
            "defense" &&

            room.defenderId ===
            playerId &&

            room.table.some(
                pair =>
                    !pair.defense
            ),

        canFinishAttack:
            room.phase ===
            "attack" &&

            room.attackerId ===
            playerId &&

            room.table.length > 0 &&

            room.table.every(
                pair =>
                    !!pair.defense
            )
    };
}

/*
=========================================================
SEND STATE
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
                rp.playerId
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
JOIN
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

        hand: []
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

    for (
        const player of room.players
    ) {

        player.hand = [];
    }

    /*
    6 КАРТ КАЖДОМУ
    */

    for (
        let i = 0;
        i < 6;
        i++
    ) {

        for (
            const player of room.players
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

    /*
    КОЗЫРЬ
    */

    if (
        room.deck.length > 0
    ) {

        room.trumpSuit =
            room.deck[
                room.deck.length - 1
            ].suit;

    } else {

        room.trumpSuit =
            room.players[0]
                .hand[0]
                .suit;
    }

    /*
    ПЕРВЫЙ ХОД:
    МЛАДШИЙ КОЗЫРЬ
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
                card =>
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

    if (!firstPlayer) {

        firstPlayer =
            room.players[0];
    }

    const secondPlayer =
        room.players.find(
            p =>
                p.playerId !==
                firstPlayer.playerId
        );

    room.attackerId =
        firstPlayer.playerId;

    room.defenderId =
        secondPlayer.playerId;
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

    /*
    Первая карта атаки
    */

    if (
        room.table.length === 0
    ) {

        return true;
    }

    /*
    Нельзя подкидывать,
    пока есть неотбитая карта.
    */

    const hasUnbeaten =
        room.table.some(
            pair =>
                !pair.defense
        );

    if (hasUnbeaten) {
        return false;
    }

    /*
    Можно подкинуть только
    номинал, уже присутствующий
    на столе.
    */

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
        room.phase !==
        "attack"
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

    const roomPlayerObject =
        roomPlayer(
            room,
            player.playerId
        );

    if (!roomPlayerObject) {

        return {
            ok: false,
            error:
                "Игрок не найден в комнате."
        };
    }

    const card =
        findCard(
            roomPlayerObject,
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
                room.table.length > 0
                    ? "Можно подкидывать только после того, как предыдущие карты отбиты, и только по номиналу карт на столе."
                    : "Эту карту нельзя сыграть."
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
            roomPlayerObject,
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
        room.phase !==
        "defense"
    ) {

        return {
            ok: false,
            error:
                "Сейчас нельзя защищаться."
        };
    }

    if (
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас защищается другой игрок."
        };
    }

    const defender =
        roomPlayer(
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

    const pair =
        room.table.find(
            item =>
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
            defender,
            defenseId
        );

    if (!defenseCard) {

        return {
            ok: false,
            error:
                "Этой карты нет у вас."
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
            defender,
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

    /*
    Если всё отбито,
    атакующий получает право
    подкинуть ещё.
    */

    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            p =>
                !!p.defense
        );

    if (allDefended) {

        room.phase =
            "attack";
    }

    return {
        ok: true
    };
}

/*
=========================================================
TAKE
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
        room.phase !==
        "defense"
    ) {

        return {
            ok: false,
            error:
                "Сейчас брать карты нельзя."
        };
    }

    if (
        room.defenderId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас не ваш ход."
        };
    }

    const defender =
        roomPlayer(
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

    const hasUnbeaten =
        room.table.some(
            pair =>
                !pair.defense
        );

    if (!hasUnbeaten) {

        return {
            ok: false,
            error:
                "Все карты уже отбиты."
        };
    }

    /*
    Забираем все карты.
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

        timestamp:
            Date.now()
    });

    room.table =
        [];

    /*
    После взятия атакующий
    остаётся атакующим.
    */

    room.phase =
        "draw";

    drawToSix(room);

    if (
        checkGameOver(room)
    ) {

        return {
            ok: true
        };
    }

    room.phase =
        "attack";

    return {
        ok: true
    };
}

/*
=========================================================
END ATTACK / БИТО
=========================================================
*/

function finishAttack(player) {

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
        room.phase !==
        "attack"
    ) {

        return {
            ok: false,
            error:
                "Сейчас нельзя закончить атаку."
        };
    }

    if (
        room.attackerId !==
        player.playerId
    ) {

        return {
            ok: false,
            error:
                "Сейчас не ваш ход."
        };
    }

    if (
        room.table.length === 0
    ) {

        return {
            ok: false,
            error:
                "Сначала нужно сделать атаку."
        };
    }

    const allDefended =
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
            "successful_defense",

        playerId:
            room.defenderId,

        timestamp:
            Date.now()
    });

    room.table =
        [];

    /*
    Меняем роли.
    */

    const oldAttacker =
        room.attackerId;

    room.attackerId =
        room.defenderId;

    room.defenderId =
        oldAttacker;

    room.phase =
        "draw";

    drawToSix(room);

    if (
        checkGameOver(room)
    ) {

        return {
            ok: true
        };
    }

    room.phase =
        "attack";

    return {
        ok: true
    };
}

/*
=========================================================
DRAW
=========================================================
*/

function drawToSix(room) {

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

    /*
    Сначала атакующий,
    потом защищающийся.
    */

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

        if (!Array.isArray(player.hand)) {
            player.hand = [];
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
GAME OVER
=========================================================
*/

function checkGameOver(room) {

    if (
        room.deck.length > 0
    ) {

        return false;
    }

    const winner =
        room.players.find(
            p =>
                p.hand.length === 0
        );

    if (!winner) {
        return false;
    }

    const loser =
        room.players.find(
            p =>
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

    room.table =
        [];

    return true;
}

/*
=========================================================
LEAVE ROOM
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
            p =>
                p.playerId !==
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

                const room =
                    getRoom(
                        player.roomId
                    );

                sendRoomState(
                    room
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

                const room =
                    getRoom(
                        player.roomId
                    );

                if (room) {
                    sendRoomState(room);
                }
            }
        );

        /*
        БИТО / ЗАКОНЧИТЬ АТАКУ
        */

        socket.on(
            "finish_attack",
            () => {

                const result =
                    finishAttack(
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
                    sendRoomState(room);
                }
            }
        );

        /*
        LEAVE
        */

        socket.on(
            "leave_room",
            () => {

                const roomId =
                    player.roomId;

                leaveRoom(
                    player
                );

                if (roomId) {

                    socket.leave(
                        roomId
                    );
                }

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
                не должен отключать
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
                "Real players 1x1: ready"
            );

            console.log(
                "Rooms by code/list: ready"
            );

            console.log(
                "======================================"
            );
        }
    );
}

start();
