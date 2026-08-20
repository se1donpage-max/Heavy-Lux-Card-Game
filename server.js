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
   DURAK
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

function id(length = 10) {
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
    return room.players.find(
        p => p.playerId === playerId
    );
}

function otherPlayer(room, playerId) {
    return room.players.find(
        p => p.playerId !== playerId
    );
}

/* =========================================================
   TELEGRAM
========================================================= */

function parseTelegramUser(initData) {
    if (!initData) {
        return null;
    }

    try {
        const params = new URLSearchParams(initData);
        const rawUser = params.get("user");

        if (!rawUser) {
            return null;
        }

        return JSON.parse(rawUser);
    } catch (err) {
        console.error("Telegram parse error:", err);
        return null;
    }
}

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
                playerId: id(12),
                telegramId,
                username: telegramUser.username || "",
                name: cleanName(
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

    /* TEST MODE */

    const testPlayerId =
        socket.handshake.auth?.testPlayerId ||
        `test_${socket.id}`;

    let player = players.get(testPlayerId);

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
        console.error("savePlayer error:", err);
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
                id: id(10),
                suit,
                rank,
                value
            });
        }
    }

    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [deck[i], deck[j]] =
            [deck[j], deck[i]];
    }

    return deck;
}

function isTrump(card, trumpSuit) {
    return card.suit === trumpSuit;
}

function canBeat(
    attackCard,
    defenseCard,
    trumpSuit
) {
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
        defenseCard.suit === attackCard.suit &&
        defenseCard.value > attackCard.value
    );
}

function cardLabel(card) {
    return `${card.rank}${card.suit}`;
}

/* =========================================================
   GAME PLAYER HELPERS
========================================================= */

/*
 * В системе есть два объекта игрока:
 *
 * 1. players Map
 *    - соединение
 *    - socketId
 *    - telegramId
 *    - roomId
 *
 * 2. room.players[]
 *    - конкретно игровое состояние
 *    - hand
 *    - connected
 *    - name
 *
 * Карты находятся ТОЛЬКО в room.players[].hand.
 *
 * Поэтому перед любой операцией с картами
 * всегда получаем игрока именно из комнаты.
 */

function getRoomPlayer(player) {
    if (!player) {
        return null;
    }

    if (player.hand) {
        return player;
    }

    if (!player.roomId) {
        return null;
    }

    const room =
        rooms.get(player.roomId);

    if (!room) {
        return null;
    }

    return room.players.find(
        p =>
            p.playerId ===
            player.playerId
    ) || null;
}


function findCard(player, cardId) {
    const roomPlayer =
        getRoomPlayer(player);

    if (!roomPlayer) {
        return null;
    }

    if (!Array.isArray(roomPlayer.hand)) {
        roomPlayer.hand = [];
    }

    return roomPlayer.hand.find(
        card =>
            card.id === cardId
    ) || null;
}


function removeCard(player, cardId) {
    const roomPlayer =
        getRoomPlayer(player);

    if (!roomPlayer) {
        return null;
    }

    if (!Array.isArray(roomPlayer.hand)) {
        roomPlayer.hand = [];
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
/* =========================================================
   ROOM
========================================================= */

function createRoom(player) {
    if (player.roomId) {
        return {
            ok: false,
            error: "Вы уже находитесь в комнате."
        };
    }

    let roomId;

    do {
        roomId =
            id(6).toUpperCase();
    } while (rooms.has(roomId));

    const room = {
        id: roomId,

        players: [
            {
                playerId: player.playerId,
                name: player.name,
                socketId: player.socketId,
                connected: true,
                hand: []
            }
        ],

        status: "waiting",

        /*
         * WAITING
         * ATTACK
         * DEFENSE
         * BITO
         * FINISHED
         */
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

    rooms.set(roomId, room);

    player.roomId = roomId;

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

    const room = getRoom(roomId);

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

    if (room.status !== "waiting") {
        return {
            ok: false,
            error: "Игра уже началась."
        };
    }

    room.players.push({
        playerId: player.playerId,
        name: player.name,
        socketId: player.socketId,
        connected: true,
        hand: []
    });

    player.roomId = room.id;

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

    room.players.forEach(p => {
        p.hand = [];
    });

    /*
     * 6 карт каждому
     */
    for (let i = 0; i < 6; i++) {
        for (const player of room.players) {
            if (room.deck.length) {
                player.hand.push(
                    room.deck.pop()
                );
            }
        }
    }

    /*
     * Последняя карта колоды определяет козырь.
     * Она остаётся последней картой колоды.
     */
    if (room.deck.length) {
        room.trumpSuit =
            room.deck[
                room.deck.length - 1
            ].suit;
    }

    /*
     * Первый ход делает игрок
     * с младшим козырем.
     */
    let attacker = null;
    let lowestTrump = null;

    for (const player of room.players) {
        for (const card of player.hand) {
            if (
                card.suit === room.trumpSuit &&
                (
                    !lowestTrump ||
                    card.value < lowestTrump.value
                )
            ) {
                lowestTrump = card;
                attacker = player;
            }
        }
    }

    if (!attacker) {
        attacker = room.players[0];
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
    /*
     * Первая атака:
     * любая карта.
     */
    if (room.table.length === 0) {
        return true;
    }

    /*
     * Подкидывать можно только
     * номиналы, уже присутствующие
     * на столе.
     */
    const allowedValues = new Set();

    for (const pair of room.table) {
        allowedValues.add(
            pair.attack.value
        );

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

/* =========================================================
   ATTACK
========================================================= */
function attackCard(player, cardId) {
    const room =
        getRoom(player.roomId);

    if (!room) {
        return {
            ok: false,
            error: "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error: "Игра не идёт."
        };
    }

    if (room.phase !== "attack") {
        return {
            ok: false,
            error: "Сейчас нельзя атаковать."
        };
    }

    if (room.attackerId !== player.playerId) {
        return {
            ok: false,
            error: "Сейчас ход противника."
        };
    }

    const roomPlayer =
        roomPlayerById(
            room,
            player.playerId
        );

    if (!roomPlayer) {
        return {
            ok: false,
            error: "Игрок не найден в комнате."
        };
    }

    if (
        room.table.length >=
        maxTableCards(room)
    ) {
        return {
            ok: false,
            error: "Нельзя подкинуть больше карт."
        };
    }

    const card =
        findCard(
            roomPlayer,
            cardId
        );

    if (!card) {
        return {
            ok: false,
            error: "Этой карты нет у вас."
        };
    }

    if (!validAttackCard(room, card)) {
        return {
            ok: false,
            error: "Такую карту нельзя подкинуть."
        };
    }

    const removed =
        removeCard(
            roomPlayer,
            cardId
        );

    if (!removed) {
        return {
            ok: false,
            error: "Не удалось взять карту из руки."
        };
    }

    room.table.push({
        attack: removed,
        defense: null
    });

    /*
     * После атаки защищается второй игрок.
     */
    room.phase = "defense";

    room.moves.push({
        type: "attack",
        playerId: player.playerId,
        card: cardLabel(removed),
        timestamp: Date.now()
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
            error: "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error: "Игра не идёт."
        };
    }

    if (room.phase !== "defense") {
        return {
            ok: false,
            error:
                "Сейчас нельзя отбиваться."
        };
    }

    if (room.defenderId !== player.playerId) {
        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }

    const pair =
        room.table.find(
            p =>
                p.attack.id === attackId &&
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

    removeCard(
        player,
        defenseId
    );

    pair.defense = defense;

    room.moves.push({
        type: "defend",
        playerId: player.playerId,
        attack: cardLabel(pair.attack),
        card: cardLabel(defense),
        timestamp: Date.now()
    });

    /*
     * Если все карты отбиты,
     * атакующий должен нажать БИТО.
     */
    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            p => !!p.defense
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
            error: "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error: "Игра не идёт."
        };
    }

    if (room.phase !== "defense") {
        return {
            ok: false,
            error:
                "Сейчас нельзя брать карты."
        };
    }

    if (room.defenderId !== player.playerId) {
        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }

    const hasUnbeaten =
        room.table.some(
            p => !p.defense
        );

    if (!hasUnbeaten) {
        return {
            ok: false,
            error:
                "Все карты уже отбиты. Нажмите БИТО."
        };
    }

    /*
     * Защищающийся забирает
     * ВСЕ карты со стола.
     */
    for (const pair of room.table) {
        player.hand.push(pair.attack);

        if (pair.defense) {
            player.hand.push(pair.defense);
        }
    }

    room.moves.push({
        type: "take",
        playerId: player.playerId,
        cards: room.table.length,
        timestamp: Date.now()
    });

    room.table = [];

    /*
     * После взятия атакующий
     * остаётся атакующим.
     */
    room.phase = "draw";

    drawCards(room);

    if (checkGameOver(room)) {
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
            error: "Комната не найдена."
        };
    }

    if (room.status !== "playing") {
        return {
            ok: false,
            error: "Игра не идёт."
        };
    }

    if (room.phase !== "bito") {
        return {
            ok: false,
            error:
                "Пока нельзя нажать БИТО."
        };
    }

    if (room.attackerId !== player.playerId) {
        return {
            ok: false,
            error:
                "Только атакующий может нажать БИТО."
        };
    }

    const allDefended =
        room.table.length > 0 &&
        room.table.every(
            p => !!p.defense
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
        playerId: player.playerId,
        timestamp: Date.now()
    });

    /*
     * Карты уходят в битый сброс.
     */
    room.table = [];

    /*
     * Теперь роли меняются.
     */
    const oldAttacker =
        room.attackerId;

    room.attackerId =
        room.defenderId;

    room.defenderId =
        oldAttacker;

    room.phase = "draw";

    drawCards(room);

    if (checkGameOver(room)) {
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
     * В Дураке сначала добирает атакующий,
     * затем защищавшийся.
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
     * Пока есть карты в колоде —
     * игрок с пустой рукой не обязательно
     * окончательно победил, потому что добор
     * ещё возможен.
     */
    if (room.deck.length > 0) {
        return false;
    }

    const emptyPlayer =
        room.players.find(
            p => p.hand.length === 0
        );

    if (!emptyPlayer) {
        return false;
    }

    const loser =
        otherPlayer(
            room,
            emptyPlayer.playerId
        );

    room.status = "finished";
    room.phase = "finished";

    room.winnerId =
        emptyPlayer.playerId;

    room.loserId =
        loser?.playerId || null;

    room.attackerId = null;
    room.defenderId = null;

    room.moves.push({
        type: "finish",
        playerId: emptyPlayer.playerId,
        timestamp: Date.now()
    });

    return true;
}

/* =========================================================
   GAME STATE
========================================================= */

function serializeCard(card) {
    return {
        id: card.id,
        suit: card.suit,
        rank: card.rank,
        value: card.value
    };
}

function gameState(room, playerId) {
    const me =
        roomPlayer(
            room,
            playerId
        );

    const opponent =
        otherPlayer(
            room,
            playerId
        );

    let turn = "WAITING";

    if (room.status === "playing") {
        if (
            room.phase === "attack" ||
            room.phase === "bito"
        ) {
            turn =
                room.attackerId === playerId
                    ? "YOUR_TURN"
                    : "OPPONENT_TURN";
        }

        if (room.phase === "defense") {
            turn =
                room.defenderId === playerId
                    ? "YOUR_TURN"
                    : "OPPONENT_TURN";
        }

        if (room.phase === "draw") {
            turn = "WAITING";
        }
    }

    const table =
        room.table.map(pair => ({
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
        }));

    const canTake =
        room.status === "playing" &&
        room.phase === "defense" &&
        room.defenderId === playerId &&
        room.table.some(
            p => !p.defense
        );

    const canBito =
        room.status === "playing" &&
        room.phase === "bito" &&
        room.attackerId === playerId &&
        room.table.length > 0 &&
        room.table.every(
            p => !!p.defense
        );

    return {
        roomId: room.id,

        status: room.status,

        phase: room.phase,

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

        canTake,

        canBito,

        moves:
            room.moves.slice(-30),

        winnerId:
            room.winnerId || null,

        loserId:
            room.loserId || null,

        me: {
            playerId
        }
    };
}

/* =========================================================
   SEND STATE
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

        if (!player?.socketId) {
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
        id: room.id,
        status: room.status,
        playersCount:
            room.players.length,
        maxPlayers: 2
    };
}

function sendRoomList() {
    io.emit(
        "rooms_list",
        Array.from(
            rooms.values()
        ).map(publicRoom)
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

    if (room.players.length === 0) {
        rooms.delete(room.id);
    } else {
        const remaining =
            room.players[0];

        if (room.status === "playing") {
            room.status = "finished";
            room.phase = "finished";

            room.winnerId =
                remaining.playerId;

            room.loserId =
                player.playerId;

            room.attackerId = null;
            room.defenderId = null;
        } else {
            room.status = "waiting";
            room.phase = "waiting";
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

io.use((socket, next) => {
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
});

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on("connection", socket => {
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

    player.connected = true;

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
                roomPlayer(
                    room,
                    player.playerId
                );

            if (rp) {
                rp.socketId =
                    socket.id;

                rp.connected = true;
                rp.name =
                    player.name;
            }

            socket.join(room.id);

            sendRoomState(room);
        }
    }

    /* PROFILE */

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

    /* ROOMS */

    socket.on(
        "get_rooms",
        () => {
            socket.emit(
                "rooms_list",
                Array.from(
                    rooms.values()
                ).map(publicRoom)
            );
        }
    );

    /* CREATE */

    socket.on(
        "create_room",
        () => {
            const result =
                createRoom(player);

            if (!result.ok) {
                socket.emit(
                    "error_message",
                    result.error
                );
                return;
            }

            const room =
                result.room;

            socket.join(room.id);

            socket.emit(
                "room_created",
                publicRoom(room)
            );

            sendRoomState(room);
            sendRoomList();

            console.log(
                "Room created:",
                room.id
            );
        }
    );

    /* JOIN */

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

            socket.join(room.id);

            sendRoomState(room);
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

    /* ATTACK */

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

    /* DEFENSE */

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

    /* TAKE */

    socket.on(
        "take_cards",
        () => {
            const result =
                takeCards(player);

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

    /* BITO */

    socket.on(
        "bito",
        () => {
            const result =
                bito(player);

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

    /* LEAVE */

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
                socket.leave(oldRoom.id);
            }

            leaveRoom(player);

            socket.emit(
                "left_room"
            );
        }
    );

    /* DISCONNECT */

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
             * Старый socket не должен
             * сбивать новое подключение.
             */
            if (
                current.socketId !==
                socket.id
            ) {
                return;
            }

            current.connected = false;

            console.log(
                "Player disconnected:",
                current.playerId
            );

            if (current.roomId) {
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
                        rp.connected = false;
                    }

                    sendRoomState(room);
                }
            }
        }
    );
});

/* =========================================================
   HTTP
========================================================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
});

app.get(
    "/api/health",
    async (req, res) => {
        let database = "disabled";

        if (pool) {
            try {
                await pool.query("SELECT 1");
                database = "connected";
            } catch {
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
                "======================================"
            );
        }
    );
}

start();
