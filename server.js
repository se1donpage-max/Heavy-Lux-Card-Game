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

/* =========================================================
   EXPRESS
========================================================= */

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on("error", err => {
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
    pingTimeout: 20000,

    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true
    }
});

/* =========================================================
   MEMORY
========================================================= */

const players = new Map();
const rooms = new Map();

/* =========================================================
   DURAK 36
========================================================= */

const SUITS = ["♠", "♥", "♦", "♣"];

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
   HELPERS
========================================================= */

function createId(length = 12) {
    return crypto
        .randomBytes(16)
        .toString("hex")
        .slice(0, length);
}

function cleanName(name) {
    const value = String(name || "")
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

function roomPlayerById(room, playerId) {
    if (!room) return null;

    return room.players.find(
        p => p.playerId === playerId
    ) || null;
}

function otherPlayer(room, playerId) {
    if (!room) return null;

    return room.players.find(
        p => p.playerId !== playerId
    ) || null;
}

function getRoomPlayer(player) {
    if (!player) return null;

    if (!player.roomId) return null;

    const room = getRoom(player.roomId);

    if (!room) return null;

    return roomPlayerById(
        room,
        player.playerId
    );
}

function findCard(player, cardId) {
    const rp = getRoomPlayer(player);

    if (!rp || !Array.isArray(rp.hand)) {
        return null;
    }

    return rp.hand.find(
        card => card.id === cardId
    ) || null;
}

function removeCard(player, cardId) {
    const rp = getRoomPlayer(player);

    if (!rp || !Array.isArray(rp.hand)) {
        return null;
    }

    const index = rp.hand.findIndex(
        card => card.id === cardId
    );

    if (index === -1) {
        return null;
    }

    return rp.hand.splice(index, 1)[0];
}

function cardLabel(card) {
    if (!card) return "";

    return `${card.rank}${card.suit}`;
}

/* =========================================================
   TELEGRAM
========================================================= */

function parseTelegramUser(initData) {
    if (!initData) {
        return null;
    }

    try {
        const params =
            new URLSearchParams(initData);

        const rawUser =
            params.get("user");

        if (!rawUser) {
            return null;
        }

        return JSON.parse(rawUser);
    } catch (err) {
        console.error(
            "Telegram parse error:",
            err
        );

        return null;
    }
}

/*
 * Сейчас оставляем совместимость
 * с тестовым режимом.
 *
 * Для production Telegram WebApp
 * hash можно добавить отдельной проверкой.
 */

function authenticate(socket) {
    const initData =
        socket.handshake.auth?.initData || "";

    const telegramUser =
        parseTelegramUser(initData);

    if (telegramUser?.id) {
        const telegramId =
            String(telegramUser.id);

        let player = null;

        for (const p of players.values()) {
            if (p.telegramId === telegramId) {
                player = p;
                break;
            }
        }

        if (!player) {
            player = {
                playerId: createId(12),
                telegramId,
                username:
                    telegramUser.username || "",
                name: cleanName(
                    telegramUser.first_name ||
                    telegramUser.username ||
                    "Игрок"
                ),
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

    /* =====================================================
       TEST MODE
    ===================================================== */

    const testPlayerId =
        socket.handshake.auth?.testPlayerId ||
        `test_${socket.id}`;

    let player =
        players.get(testPlayerId);

    if (!player) {
        player = {
            playerId: testPlayerId,
            telegramId: null,
            username: "",
            name:
                "Игрок " +
                testPlayerId.slice(-4),
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

/* =========================================================
   DATABASE
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

        console.log("PostgreSQL: ready");
    } catch (err) {
        console.error(
            "PostgreSQL initialization error:",
            err
        );
    }
}

async function savePlayer(player) {
    if (!pool || !player) {
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
            VALUES ($1, $2, $3, $4, NOW())

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
    } catch (err) {
        console.error(
            "savePlayer error:",
            err
        );
    }
}

/* =========================================================
   CARDS
========================================================= */

function createDeck() {
    const deck = [];

    for (const suit of SUITS) {
        for (const [rank, value] of RANKS) {
            deck.push({
                id: createId(10),
                suit,
                rank,
                value
            });
        }
    }

    return deck;
}

function shuffle(deck) {
    for (
        let i = deck.length - 1;
        i > 0;
        i--
    ) {
        const j =
            Math.floor(
                Math.random() * (i + 1)
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

    /*
     * Козырь бьётся только
     * старшим козырем.
     */
    if (attackTrump) {
        return (
            defenseTrump &&
            defenseCard.value >
                attackCard.value
        );
    }

    /*
     * Некозырную карту
     * можно побить козырем.
     */
    if (defenseTrump) {
        return true;
    }

    /*
     * Или старшей картой
     * той же масти.
     */
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
            createId(6).toUpperCase();
    } while (rooms.has(roomId));

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

                connected: true,

                hand: []
            }
        ],

        status: "waiting",
        phase: "waiting",

        deck: [],
        trumpSuit: null,

        attackerId: null,
        defenderId: null,

        table: [],

        moves: [],

        winnerId: null,
        loserId: null
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

function joinRoom(player, roomId) {
    roomId =
        String(roomId || "")
            .trim()
            .toUpperCase();

    if (player.roomId) {
        return {
            ok: false,
            error:
                "Вы уже находитесь в комнате."
        };
    }

    const room =
        getRoom(roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (room.players.length >= 2) {
        return {
            ok: false,
            error:
                "Комната уже заполнена."
        };
    }

    if (room.status !== "waiting") {
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

        connected: true,

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

/* =========================================================
   START GAME
========================================================= */

function startGame(room) {
    room.status = "playing";
    room.phase = "attack";

    room.deck =
        shuffle(createDeck());

    room.table = [];
    room.moves = [];

    room.winnerId = null;
    room.loserId = null;

    room.players.forEach(
        player => {
            player.hand = [];
            player.connected = true;
        }
    );

    /*
     * Раздаём по одной карте
     * до 6 каждому.
     */
    for (let i = 0; i < 6; i++) {
        for (const player of room.players) {
            if (room.deck.length > 0) {
                player.hand.push(
                    room.deck.pop()
                );
            }
        }
    }

    /*
     * Последняя карта колоды
     * определяет козырь.
     */
    room.trumpSuit =
        room.deck.length > 0
            ? room.deck[
                room.deck.length - 1
            ].suit
            : null;

    /*
     * Первый ход —
     * игрок с младшим козырем.
     */
    let attacker = null;
    let lowestTrump = null;

    for (const player of room.players) {
        for (const card of player.hand) {
            if (
                card.suit ===
                    room.trumpSuit &&
                (
                    !lowestTrump ||
                    card.value <
                        lowestTrump.value
                )
            ) {
                lowestTrump = card;
                attacker = player;
            }
        }
    }

    /*
     * Теоретически при 6 картах
     * козырей может не быть.
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
}

/* =========================================================
   ATTACK VALIDATION
========================================================= */

function validAttackCard(room, card) {
    if (!card) {
        return false;
    }

    /*
     * Первая карта атаки —
     * любая карта.
     */
    if (room.table.length === 0) {
        return true;
    }

    /*
     * При подкидывании разрешены
     * только значения, которые
     * уже есть на столе.
     */
    const allowedValues =
        new Set();

    for (const pair of room.table) {
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

function maxTableCards(room) {
    const defender =
        roomPlayerById(
            room,
            room.defenderId
        );

    if (!defender) {
        return 0;
    }

    /*
     * В 1x1 максимум 6 карт
     * на одну атаку.
     */
    return Math.min(
        6,
        defender.hand.length
    );
}

/* =========================================================
   ATTACK
========================================================= */

function attackCard(player, cardId) {
    const room =
        getRoom(player.roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error:
                "Игра не идёт."
        };
    }

    if (
        room.phase !== "attack"
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
        maxTableCards(room);

    if (
        room.table.length >=
        maxCards
    ) {
        return {
            ok: false,
            error:
                "Больше карт подкинуть нельзя."
        };
    }

    /*
     * Важный момент:
     *
     * После первой атаки, если карта
     * ещё не отбита, атакующий может
     * либо подкинуть карту, либо
     * дождаться защиты.
     *
     * Поэтому attackCard разрешается
     * только когда:
     *
     * 1. стол пуст;
     * 2. предыдущая карта уже отбита.
     */
    if (room.table.length > 0) {
        const hasUnbeaten =
            room.table.some(
                pair => !pair.defense
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
        attack: removed,
        defense: null
    });

    room.phase = "defense";

    room.moves.push({
        type: "attack",
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

/* =========================================================
   DEFENSE
========================================================= */

function defendCard(
    player,
    attackId,
    defenseId
) {
    const room =
        getRoom(player.roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error:
                "Игра не идёт."
        };
    }

    if (
        room.phase !== "defense"
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
            p =>
                p.attack &&
                p.attack.id ===
                    attackId &&
                !p.defense
        );

    if (!pair) {
        return {
            ok: false,
            error:
                "Эта карта уже отбита."
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
        type: "defend",
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
     * Все текущие карты отбиты.
     *
     * Атакующий теперь может:
     *
     * - подкинуть ещё одну карту;
     * - нажать БИТО.
     */
    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            pair =>
                !!pair.defense
        );

    if (allDefended) {
        room.phase = "bito";
    }

    return {
        ok: true
    };
}

/* =========================================================
   TAKE
========================================================= */

function takeCards(player) {
    const room =
        getRoom(player.roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error:
                "Игра не идёт."
        };
    }

    if (
        room.phase !== "defense"
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
     * Защищающийся забирает
     * абсолютно все карты стола.
     */
    for (const pair of room.table) {
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
        type: "take",
        playerId:
            player.playerId,
        cards:
            room.table.length,
        timestamp:
            Date.now()
    });

    room.table = [];

    /*
     * После взятия атакующий
     * остаётся атакующим.
     */
    room.phase = "draw";

    drawCards(room);

    if (
        checkGameOver(room)
    ) {
        return {
            ok: true
        };
    }

    room.phase = "attack";

    return {
        ok: true
    };
}

/* =========================================================
   BITO
========================================================= */

function bito(player) {
    const room =
        getRoom(player.roomId);

    if (!room) {
        return {
            ok: false,
            error:
                "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error:
                "Игра не идёт."
        };
    }

    if (
        room.phase !== "bito"
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
        type: "bito",
        playerId:
            player.playerId,
        timestamp:
            Date.now()
    });

    /*
     * Все карты уходят в битый сброс.
     */
    room.table = [];

    /*
     * Защищавшийся становится
     * новым атакующим.
     */
    const oldAttacker =
        room.attackerId;

    room.attackerId =
        room.defenderId;

    room.defenderId =
        oldAttacker;

    room.phase = "draw";

    drawCards(room);

    if (
        checkGameOver(room)
    ) {
        return {
            ok: true
        };
    }

    room.phase = "attack";

    return {
        ok: true
    };
}

/* =========================================================
   DRAW
========================================================= */

function drawCards(room) {
    /*
     * В классическом Дураке:
     *
     * 1. атакующий;
     * 2. остальные участники;
     * 3. защищавшийся последним.
     *
     * Для 1x1 достаточно:
     *
     * атакующий -> защитник.
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

    for (const player of order) {
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

/* =========================================================
   GAME OVER
========================================================= */

function checkGameOver(room) {
    /*
     * Пока колода не закончилась,
     * победитель не определяется.
     */
    if (room.deck.length > 0) {
        return false;
    }

    /*
     * После окончания колоды
     * игрок с нулём карт победил.
     */
    const winner =
        room.players.find(
            player =>
                player.hand.length === 0
        );

    if (!winner) {
        return false;
    }

    const loser =
        otherPlayer(
            room,
            winner.playerId
        );

    room.status = "finished";
    room.phase = "finished";

    room.winnerId =
        winner.playerId;

    room.loserId =
        loser?.playerId || null;

    room.attackerId = null;
    room.defenderId = null;

    room.moves.push({
        type: "finish",
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

function serializeCard(card) {
    if (!card) {
        return null;
    }

    return {
        id: card.id,
        suit: card.suit,
        rank: card.rank,
        value: card.value
    };
}

function gameState(room, playerId) {
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

    let turn = "WAITING";

    if (
        room.status === "playing"
    ) {
        if (
            room.phase === "attack" ||
            room.phase === "bito"
        ) {
            turn =
                room.attackerId ===
                    playerId
                    ? "YOUR_TURN"
                    : "OPPONENT_TURN";
        }

        if (
            room.phase === "defense"
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
        room.status === "playing" &&
        room.phase === "defense" &&
        room.defenderId === playerId &&
        room.table.some(
            pair =>
                !pair.defense
        );

    const canBito =
        room.status === "playing" &&
        room.phase === "bito" &&
        room.attackerId === playerId &&
        room.table.length > 0 &&
        room.table.every(
            pair =>
                !!pair.defense
        );

    /*
     * Атакующий может подкидывать
     * только когда:
     *
     * - он действительно атакующий;
     * - стол не заполнен;
     * - все предыдущие карты отбиты.
     */
    const canAttack =
        room.status === "playing" &&
        room.attackerId === playerId &&
        (
            room.phase === "attack" ||
            room.phase === "bito"
        ) &&
        room.table.length <
            maxTableCards(room) &&
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

function sendRoomState(room) {
    if (!room) {
        return;
    }

    for (const rp of room.players) {
        const player =
            getPlayer(
                rp.playerId
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

function publicRoom(room) {
    return {
        id:
            room.id,

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers:
            2
    };
}

function sendRoomList() {
    io.emit(
        "rooms_list",
        Array.from(
            rooms.values()
        ).map(
            publicRoom
        )
    );
}

/* =========================================================
   LEAVE
========================================================= */

function leaveRoom(player) {
    const roomId =
        player.roomId;

    if (!roomId) {
        return null;
    }

    const room =
        getRoom(roomId);

    if (!room) {
        player.roomId = null;
        return null;
    }

    room.players =
        room.players.filter(
            p =>
                p.playerId !==
                player.playerId
        );

    player.roomId = null;

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

            room.attackerId = null;
            room.defenderId = null;
        } else {
            room.status =
                "waiting";

            room.phase =
                "waiting";
        }
    }

    sendRoomList();

    if (rooms.has(room.id)) {
        sendRoomState(room);
    }

    return room;
}

/* =========================================================
   SOCKET AUTH
========================================================= */

io.use(
    (socket, next) => {
        try {
            const player =
                authenticate(socket);

            socket.playerId =
                player.playerId;

            next();
        } catch (err) {
            console.error(
                "Authentication error:",
                err
            );

            next(
                new Error(
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
            socket.disconnect(true);
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
         * RECONNECT
         */

        if (player.roomId) {
            const room =
                getRoom(
                    player.roomId
                );

            if (room) {
                const rp =
                    roomPlayerById(
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
           ROOMS
        ================================================= */

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

        /* =================================================
           CREATE ROOM
        ================================================= */

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
                    room.id
                );
            }
        );

        /* =================================================
           JOIN ROOM
        ================================================= */

        socket.on(
            "join_room",
            roomId => {
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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );
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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );
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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );

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

                sendRoomState(
                    getRoom(
                        player.roomId
                    )
                );

                sendRoomList();
            }
        );

        /* =================================================
           LEAVE ROOM
        ================================================= */

        socket.on(
            "leave_room",
            () => {
                const oldRoom =
                    player.roomId
                        ? getRoom(
                            player.roomId
                        )
                        : null;

                if (oldRoom) {
                    socket.leave(
                        oldRoom.id
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

                /*
                 * Старый socket не должен
                 * сбивать новое подключение.
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
                        getRoom(
                            current.roomId
                        );

                    if (room) {
                        const rp =
                            roomPlayerById(
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

/* =========================================================
   HTTP
========================================================= */

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
            } catch (err) {
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
                "ATTACK / DEFENSE / TAKE / BITO: ready"
            );

            console.log(
                "Reconnect: ready"
            );

            console.log(
                "======================================"
            );
        }
    );
}

start();
