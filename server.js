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
    players: [playerId, playerId],
    status,
    game
}
*/

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
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A"
];

const RANK_VALUE = {
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    "J": 11,
    "Q": 12,
    "K": 13,
    "A": 14
};

const MAX_HAND = 6;

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

function getGame(room) {
    return room?.game || null;
}

function playerInRoom(room, playerId) {
    return room.players.includes(playerId);
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
AUTHENTICATION
=========================================================
*/

function authenticate(socket) {
    const initData =
        socket.handshake.auth?.initData || "";

    const telegramUser =
        parseTelegramUser(initData);

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
    Тестовый вход вне Telegram.
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
DECK
=========================================================
*/

function createDeck() {
    const deck = [];

    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({
                id:
                    `${rank}_${suit}_${createId(4)}`,

                suit,

                rank
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
        ] =
        [
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

function cardById(game, cardId) {
    for (const playerId of game.players) {
        const hand =
            game.hands[playerId] || [];

        const found =
            hand.find(
                card =>
                    card.id === cardId
            );

        if (found) {
            return found;
        }
    }

    if (game.table) {
        for (const pair of game.table) {
            if (
                pair.attack.id === cardId
            ) {
                return pair.attack;
            }

            if (
                pair.defense &&
                pair.defense.id === cardId
            ) {
                return pair.defense;
            }
        }
    }

    return null;
}

function cardIsTrump(game, card) {
    return card.suit === game.trump;
}

function canBeat(game, defense, attack) {
    if (!defense || !attack) {
        return false;
    }

    /*
    Козырь бьёт любую некозырную карту.
    */

    if (
        cardIsTrump(game, defense) &&
        !cardIsTrump(game, attack)
    ) {
        return true;
    }

    /*
    Некозырная карта не может бить козырь.
    */

    if (
        !cardIsTrump(game, defense) &&
        cardIsTrump(game, attack)
    ) {
        return false;
    }

    /*
    Одна масть — старшая карта бьёт младшую.
    */

    if (
        defense.suit === attack.suit
    ) {
        return (
            RANK_VALUE[defense.rank] >
            RANK_VALUE[attack.rank]
        );
    }

    return false;
}

function tableRanks(game) {
    const ranks = new Set();

    for (const pair of game.table) {
        if (pair.attack) {
            ranks.add(pair.attack.rank);
        }

        if (pair.defense) {
            ranks.add(pair.defense.rank);
        }
    }

    return ranks;
}

/*
=========================================================
GAME CREATION
=========================================================
*/

function createGame(player1, player2) {
    let deck =
        shuffle(
            createDeck()
        );

    const hands = {
        [player1]: [],
        [player2]: []
    };

    for (let i = 0; i < 6; i++) {
        hands[player1].push(
            deck.pop()
        );

        hands[player2].push(
            deck.pop()
        );
    }

    const trumpCard =
        deck[deck.length - 1];

    const game = {
        players: [
            player1,
            player2
        ],

        hands,

        deck,

        trump: trumpCard.suit,

        trumpCard,

        table: [],

        /*
        Первый ход определяем
        по младшей козырной карте.
        */

        attacker: null,

        defender: null,

        phase: "attack",

        winner: null,

        loser: null,

        lastAction: null,

        startedAt: Date.now()
    };

    const p1Trump =
        hands[player1]
            .filter(c =>
                c.suit === game.trump
            );

    const p2Trump =
        hands[player2]
            .filter(c =>
                c.suit === game.trump
            );

    let first = null;

    if (
        p1Trump.length &&
        p2Trump.length
    ) {
        const p1Min =
            Math.min(
                ...p1Trump.map(
                    c =>
                        RANK_VALUE[c.rank]
                )
            );

        const p2Min =
            Math.min(
                ...p2Trump.map(
                    c =>
                        RANK_VALUE[c.rank]
                )
            );

        first =
            p1Min <= p2Min
                ? player1
                : player2;

    } else if (p1Trump.length) {

        first = player1;

    } else if (p2Trump.length) {

        first = player2;

    } else {

        /*
        Если ни у кого нет козыря,
        случайно выбираем первого.
        */

        first =
            Math.random() < 0.5
                ? player1
                : player2;
    }

    game.attacker = first;

    game.defender =
        first === player1
            ? player2
            : player1;

    sortHand(
        game.hands[player1],
        game.trump
    );

    sortHand(
        game.hands[player2],
        game.trump
    );

    return game;
}

function sortHand(hand, trump) {
    hand.sort((a, b) => {

        const at =
            a.suit === trump
                ? 1
                : 0;

        const bt =
            b.suit === trump
                ? 1
                : 0;

        if (at !== bt) {
            return at - bt;
        }

        return (
            RANK_VALUE[a.rank] -
            RANK_VALUE[b.rank]
        );
    });
}

/*
=========================================================
DRAW CARDS
=========================================================
*/

function drawUpToSix(game) {

    /*
    В Дураке первым добирает атакующий,
    затем остальные.

    Здесь функция принимает порядок.
    */

}

function refillHands(game, order) {

    for (const playerId of order) {

        const hand =
            game.hands[playerId];

        while (
            hand.length < MAX_HAND &&
            game.deck.length > 0
        ) {
            hand.push(
                game.deck.pop()
            );
        }

        sortHand(
            hand,
            game.trump
        );
    }
}

/*
=========================================================
ROUND END / TURN
=========================================================
*/

function allCardsEmpty(game, playerId) {
    return (
        game.hands[playerId].length === 0 &&
        game.deck.length === 0
    );
}

function checkGameEnd(game) {

    if (
        game.deck.length > 0
    ) {
        return false;
    }

    const p1 =
        game.players[0];

    const p2 =
        game.players[1];

    const p1Empty =
        game.hands[p1].length === 0;

    const p2Empty =
        game.hands[p2].length === 0;

    if (!p1Empty && !p2Empty) {
        return false;
    }

    if (
        p1Empty &&
        p2Empty
    ) {
        game.status = "draw";
        game.phase = "finished";
        game.winner = null;
        game.loser = null;
        return true;
    }

    const winner =
        p1Empty
            ? p1
            : p2;

    const loser =
        winner === p1
            ? p2
            : p1;

    game.status = "finished";
    game.phase = "finished";
    game.winner = winner;
    game.loser = loser;

    return true;
}

/*
=========================================================
AFTER SUCCESSFUL DEFENSE
=========================================================
*/

function finishSuccessfulDefense(game) {

    /*
    Все карты со стола уходят
    в сброс.

    В данном прототипе сброс
    хранится просто как счётчик.
    */

    game.table = [];

    /*
    Атакующим становится
    бывший защитник.
    */

    const oldDefender =
        game.defender;

    const oldAttacker =
        game.attacker;

    game.attacker =
        oldDefender;

    game.defender =
        oldAttacker;

    game.phase = "attack";

    game.lastAction =
        "defended";

    /*
    Добор.

    Сначала бывший атакующий
    (теперь защитник), затем
    бывший защитник (новый атакующий).

    Для классической схемы важен
    порядок: первым добирает тот,
    у кого меньше карт.
    */

    refillHands(
        game,
        [
            game.attacker,
            game.defender
        ]
    );

    if (checkGameEnd(game)) {
        return;
    }
}

/*
=========================================================
TAKE TABLE
=========================================================
*/

function takeTable(game) {

    const defender =
        game.defender;

    for (const pair of game.table) {

        game.hands[defender].push(
            pair.attack
        );

        if (pair.defense) {
            game.hands[defender].push(
                pair.defense
            );
        }
    }

    sortHand(
        game.hands[defender],
        game.trump
    );

    game.table = [];

    /*
    После того как защитник взял,
    атакующий остаётся атакующим.
    */

    game.phase = "attack";

    game.lastAction =
        "taken";

    refillHands(
        game,
        [
            game.attacker,
            game.defender
        ]
    );

    if (checkGameEnd(game)) {
        return;
    }
}

/*
=========================================================
PUBLIC GAME STATE
=========================================================
*/

function publicCard(card) {
    return {
        id: card.id,
        suit: card.suit,
        rank: card.rank
    };
}

function publicGameState(
    room,
    playerId
) {
    const game =
        getGame(room);

    if (!game) {
        return null;
    }

    const opponent =
        game.players.find(
            id =>
                id !== playerId
        );

    const hand =
        game.hands[playerId] || [];

    const opponentHand =
        game.hands[opponent] || [];

    return {
        roomId: room.id,

        status:
            game.status || "playing",

        phase:
            game.phase,

        trump:
            game.trump,

        trumpCard:
            publicCard(
                game.trumpCard
            ),

        deckCount:
            game.deck.length,

        hand:
            hand.map(publicCard),

        opponent: {
            playerId: opponent,

            name:
                getPlayer(opponent)?.name ||
                "Игрок",

            cards:
                opponentHand.length,

            connected:
                getPlayer(opponent)?.connected !== false
        },

        table:
            game.table.map(pair => ({
                attack:
                    publicCard(
                        pair.attack
                    ),

                defense:
                    pair.defense
                        ? publicCard(
                            pair.defense
                        )
                        : null
            })),

        isAttacker:
            game.attacker ===
            playerId,

        isDefender:
            game.defender ===
            playerId,

        attacker:
            game.attacker,

        defender:
            game.defender,

        winner:
            game.winner,

        loser:
            game.loser,

        lastAction:
            game.lastAction
    };
}

/*
=========================================================
SEND GAME STATE
=========================================================
*/

function sendGameState(room) {

    if (!room || !room.game) {
        return;
    }

    for (
        const playerId of room.players
    ) {

        const player =
            getPlayer(playerId);

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
            publicGameState(
                room,
                playerId
            )
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

        status:
            room.status,

        playersCount:
            room.players.length,

        maxPlayers: 2,

        players:
            room.players.map(
                playerId => {

                    const player =
                        getPlayer(
                            playerId
                        );

                    return {
                        playerId,

                        name:
                            player?.name ||
                            "Игрок",

                        connected:
                            player?.connected !== false
                    };
                }
            )
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
            player.playerId
        ],

        status: "waiting",

        game: null
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

    room.players.push(
        player.playerId
    );

    player.roomId =
        room.id;

    room.status =
        "playing";

    room.game =
        createGame(
            room.players[0],
            room.players[1]
        );

    return {
        ok: true,
        room
    };
}

/*
=========================================================
VALIDATE ATTACK
=========================================================
*/

function attackCard(
    player,
    game,
    cardId
) {

    if (
        game.phase !==
        "attack"
    ) {
        return {
            ok: false,
            error:
                "Сейчас нельзя атаковать."
        };
    }

    if (
        game.attacker !==
        player.playerId
    ) {
        return {
            ok: false,
            error:
                "Сейчас ход противника."
        };
    }

    const hand =
        game.hands[player.playerId];

    const index =
        hand.findIndex(
            card =>
                card.id === cardId
        );

    if (index === -1) {
        return {
            ok: false,
            error:
                "Этой карты нет у вас."
        };
    }

    const card =
        hand[index];

    /*
    Первая карта атаки —
    любая карта.

    Последующие атаки —
    только ранг, уже присутствующий
    на столе.
    */

    if (
        game.table.length > 0
    ) {

        const ranks =
            tableRanks(game);

        if (
            !ranks.has(card.rank)
        ) {
            return {
                ok: false,
                error:
                    "Можно подкинуть только карту номинала, уже присутствующего на столе."
            };
        }
    }

    /*
    Максимум 6 атакующих карт
    */

    if (
        game.table.length >= 6
    ) {
        return {
            ok: false,
            error:
                "Больше шести карт атаковать нельзя."
        };
    }

    hand.splice(
        index,
        1
    );

    game.table.push({
        attack: card,
        defense: null
    });

    game.phase =
        "defense";

    game.lastAction =
        "attack";

    return {
        ok: true
    };
}

/*
=========================================================
VALIDATE DEFENSE
=========================================================
*/

function defendCard(
    player,
    game,
    cardId,
    attackId
) {

    if (
        game.phase !==
        "defense"
    ) {
        return {
            ok: false,
            error:
                "Сейчас нельзя отбиваться."
        };
    }

    if (
        game.defender !==
        player.playerId
    ) {
        return {
            ok: false,
            error:
                "Вы не защищаетесь."
        };
    }

    const pair =
        game.table.find(
            p =>
                p.attack.id ===
                attackId
        );

    if (!pair) {
        return {
            ok: false,
            error:
                "Атакующая карта не найдена."
        };
    }

    if (pair.defense) {
        return {
            ok: false,
            error:
                "Эта карта уже побита."
        };
    }

    const hand =
        game.hands[player.playerId];

    const index =
        hand.findIndex(
            card =>
                card.id === cardId
        );

    if (index === -1) {
        return {
            ok: false,
            error:
                "Этой карты нет у вас."
        };
    }

    const defense =
        hand[index];

    if (
        !canBeat(
            game,
            defense,
            pair.attack
        )
    ) {
        return {
            ok: false,
            error:
                "Этой картой нельзя отбиться."
        };
    }

    hand.splice(
        index,
        1
    );

    pair.defense =
        defense;

    /*
    После отбивания игрок,
    который атаковал, может:
    - подкинуть;
    - закончить атаку.
    */

    game.phase =
        "attack";

    game.lastAction =
        "defense";

    /*
    Если все карты на столе побиты,
    атакующий получает возможность
    завершить раунд или подкинуть.
    */

    return {
        ok: true
    };
}

/*
=========================================================
FINISH ATTACK
=========================================================
*/

function finishAttack(
    player,
    game
) {

    if (
        game.attacker !==
        player.playerId
    ) {
        return {
            ok: false,
            error:
                "Только атакующий может закончить атаку."
        };
    }

    if (
        game.table.length === 0
    ) {
        return {
            ok: false,
            error:
                "Сначала нужно положить карту."
        };
    }

    const allDefended =
        game.table.every(
            pair =>
                !!pair.defense
        );

    if (!allDefended) {
        return {
            ok: false,
            error:
                "Не все карты побиты."
        };
    }

    finishSuccessfulDefense(
        game
    );

    return {
        ok: true
    };
}

/*
=========================================================
TAKE
=========================================================
*/

function defenderTake(
    player,
    game
) {

    if (
        game.defender !==
        player.playerId
    ) {
        return {
            ok: false,
            error:
                "Вы не являетесь защищающимся."
        };
    }

    if (
        game.phase !==
        "defense"
    ) {
        return {
            ok: false,
            error:
                "Сейчас нельзя брать карты."
        };
    }

    takeTable(game);

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
        RECONNECT
        */

        if (player.roomId) {

            const room =
                getRoom(
                    player.roomId
                );

            if (room) {

                socket.join(
                    room.id
                );

                sendGameState(
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
        CREATE ROOM
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

                sendRoomList();

                console.log(
                    "Room created:",
                    room.id
                );
            }
        );

        /*
        JOIN ROOM
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

                sendGameState(
                    room
                );

                sendRoomList();

                console.log(
                    "Game started:",
                    room.id
                );

                console.log(
                    "Trump:",
                    room.game.trump
                );

                console.log(
                    "Attacker:",
                    room.game.attacker
                );
            }
        );

        /*
        ATTACK
        */

        socket.on(
            "attack_card",
            (data) => {

                const room =
                    getRoom(
                        player.roomId
                    );

                if (!room) {
                    socket.emit(
                        "move_error",
                        "Комната не найдена."
                    );

                    return;
                }

                const result =
                    attackCard(
                        player,
                        room.game,
                        data?.cardId
                    );

                if (!result.ok) {

                    socket.emit(
                        "move_error",
                        result.error
                    );

                    return;
                }

                sendGameState(
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

                const room =
                    getRoom(
                        player.roomId
                    );

                if (!room) {
                    socket.emit(
                        "move_error",
                        "Комната не найдена."
                    );

                    return;
                }

                const result =
                    defendCard(
                        player,
                        room.game,
                        data?.cardId,
                        data?.attackId
                    );

                if (!result.ok) {

                    socket.emit(
                        "move_error",
                        result.error
                    );

                    return;
                }

                sendGameState(
                    room
                );
            }
        );

        /*
        FINISH ATTACK
        */

        socket.on(
            "finish_attack",
            () => {

                const room =
                    getRoom(
                        player.roomId
                    );

                if (!room) {
                    return;
                }

                const result =
                    finishAttack(
                        player,
                        room.game
                    );

                if (!result.ok) {

                    socket.emit(
                        "move_error",
                        result.error
                    );

                    return;
                }

                sendGameState(
                    room
                );

                sendRoomList();
            }
        );

        /*
        TAKE CARDS
        */

        socket.on(
            "take_cards",
            () => {

                const room =
                    getRoom(
                        player.roomId
                    );

                if (!room) {
                    return;
                }

                const result =
                    defenderTake(
                        player,
                        room.game
                    );

                if (!result.ok) {

                    socket.emit(
                        "move_error",
                        result.error
                    );

                    return;
                }

                sendGameState(
                    room
                );

                sendRoomList();
            }
        );

        /*
        LEAVE ROOM
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
                Старый socket не должен
                отключать новое подключение.
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
                        sendGameState(
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
LEAVE ROOM
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
        getRoom(roomId);

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
            id =>
                id !==
                player.playerId
        );

    player.roomId =
        null;

    socket.leave(
        room.id
    );

    /*
    Если игрок вышел из игры,
    оставшийся получает победу.
    */

    if (
        room.game &&
        room.status === "playing" &&
        room.players.length === 1
    ) {

        const winner =
            room.players[0];

        room.game.status =
            "finished";

        room.game.phase =
            "finished";

        room.game.winner =
            winner;

        room.game.loser =
            player.playerId;

        sendGameState(
            room
        );

        /*
        Комнату оставляем,
        чтобы результат можно было
        увидеть.
        */

        room.status =
            "finished";

    } else if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.id
        );
    }

    socket.emit(
        "left_room"
    );

    sendRoomList();

    if (rooms.has(room.id)) {
        sendGameState(
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

            game:
                "Durak 36 cards 1x1",

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
                "Durak 36 cards: ready"
            );

            console.log(
                "Telegram authentication: configured"
            );
        }
    );
}

start();
