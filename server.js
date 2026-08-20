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
MEMORY
=========================================================
*/

const players = new Map();
const rooms = new Map();

/*
=========================================================
DURAK 36
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

function roomPlayer(room, playerId) {
    if (!room) {
        return null;
    }

    return room.players.find(
        p => p.playerId === playerId
    ) || null;
}

function otherPlayer(room, playerId) {
    if (!room) {
        return null;
    }

    return room.players.find(
        p => p.playerId !== playerId
    ) || null;
}

function cardLabel(card) {
    return `${card.rank}${card.suit}`;
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

        const params =
            new URLSearchParams(
                initData
            );

        const user =
            params.get("user");

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
            String(
                telegramUser.id
            );

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
        players.get(
            testPlayerId
        );

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

    for (
        const suit of SUITS
    ) {

        for (
            const rank of RANKS
        ) {

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
                Math.random() *
                (i + 1)
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
CARD RULES
=========================================================
*/

function isTrump(
    card,
    trumpSuit
) {

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

    if (
        !attackCard ||
        !defenseCard
    ) {
        return false;
    }

    /*
    Козырь против козыря
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
    Любой козырь бьёт
    некозырную карту
    */

    if (
        isTrump(
            defenseCard,
            trumpSuit
        )
    ) {

        return true;
    }

    /*
    Обычная карта
    */

    return (
        defenseCard.suit ===
        attackCard.suit &&

        defenseCard.value >
        attackCard.value
    );
}

/*
=========================================================
FIND / REMOVE CARD
=========================================================
*/

function findCard(
    player,
    cardId
) {

    if (!player) {
        return null;
    }

    return player.hand.find(
        card =>
            card.id === cardId
    ) || null;
}

function removeCard(
    player,
    cardId
) {

    if (!player) {
        return null;
    }

    const index =
        player.hand.findIndex(
            card =>
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
                player => ({

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

        status:
            "waiting",

        phase:
            "waiting",

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
        String(
            roomId || ""
        )
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
        room.status !== "waiting"
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

    room.players.forEach(
        player => {

            player.hand = [];
        }
    );

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
    НАЧИНАЕТ ИГРОК
    С МЛАДШИМ КОЗЫРЕМ
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
            player =>
                player.playerId !==
                firstPlayer.playerId
        );

    room.attackerId =
        firstPlayer.playerId;

    room.defenderId =
        secondPlayer.playerId;

    room.phase =
        "attack";

    room.moves.push({

        type:
            "start",

        playerId:
            firstPlayer.playerId,

        timestamp:
            Date.now()
    });
}

/*
=========================================================
ATTACK VALIDATION
=========================================================
*/

function validAttackCard(
    room,
    card
) {

    /*
    Первая атака:
    можно положить любую карту.
    */

    if (
        room.table.length === 0
    ) {

        return true;
    }

    /*
    Новая атака возможна
    только если все предыдущие
    карты уже отбиты.
    */

    const unfinished =
        room.table.some(
            pair =>
                !pair.defense
        );

    if (unfinished) {

        return false;
    }

    /*
    Можно подкинуть только
    достоинство, уже лежащее
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
MAX ATTACK CARDS
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

    /*
    Максимум — 6 карт.
    Но нельзя подкинуть больше,
    чем карт осталось у защищающегося.
    */

    return Math.min(
        6,
        defender.hand.length +
        room.table.filter(
            pair =>
                !pair.defense
        ).length
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
                "Игра не идёт."
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

    /*
    Нельзя атаковать,
    пока есть неотбитая карта.
    */

    const unfinished =
        room.table.some(
            pair =>
                !pair.defense
        );

    if (unfinished) {

        return {
            ok: false,
            error:
                "Сначала дождитесь отбоя."
        };
    }

    if (
        room.table.length >=
        maxTableCards(room)
    ) {

        return {
            ok: false,
            error:
                "Больше подкинуть нельзя."
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
                "Карта не найдена."
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
                "Не удалось взять карту."
        };
    }

    room.table.push({

        attack:
            removed,

        defense:
            null
    });

    /*
    После атаки
    ход ЗАЩИЩАЮЩЕГОСЯ.
    */

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
DEFENSE
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
                "Сейчас защищается другой игрок."
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
                "Эту карту уже отбили."
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
    Если все карты отбиты,
    раунд заканчивается.
    */

    const allDefended =
        room.table.every(
            pair =>
                !!pair.defense
        );

    if (allDefended) {

        finishRound(
            room,
            true
        );

    } else {

        /*
        Если осталась ещё
        неотбитая карта —
        защищающийся продолжает.
        */

        room.phase =
            "defense";
    }

    return {
        ok: true
    };
}

/*
=========================================================
TAKE CARDS
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
                "Сейчас защищается другой игрок."
        };
    }

    const unfinished =
        room.table.some(
            pair =>
                !pair.defense
        );

    if (!unfinished) {

        return {
            ok: false,
            error:
                "Все карты уже отбиты."
        };
    }

    /*
    Защищающийся забирает
    ВСЕ карты со стола.
    */

    for (
        const pair of room.table
    ) {

        player.hand.push(
            pair.attack
        );

        if (pair.defense) {

            player.hand.push(
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
    Атакующий остаётся атакующим.
    */

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
    В классическом Дураке
    сначала добирает атакующий,
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

    /*
    Пока колода не закончилась,
    игрок с нулём карт ещё
    не считается победителем.
    */

    if (
        room.deck.length > 0
    ) {

        return false;
    }

    const emptyPlayer =
        room.players.find(
            player =>
                player.hand.length === 0
        );

    if (!emptyPlayer) {

        return false;
    }

    const loser =
        room.players.find(
            player =>
                player.playerId !==
                emptyPlayer.playerId
        );

    room.status =
        "finished";

    room.phase =
        "finished";

    room.winnerId =
        emptyPlayer.playerId;

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

    room.moves.push({

        type:
            "finish",

        playerId:
            emptyPlayer.playerId,

        timestamp:
            Date.now()
    });

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
    Очищаем стол только
    после завершения раунда.
    */

    room.table =
        [];

    /*
    Если отбились —
    бывший защитник становится
    новым атакующим.

    Если взяли —
    старый атакующий продолжает
    атаковать.
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

    /*
    Сначала проверяем окончание,
    потом добираем.
    */

    if (
        room.deck.length === 0
    ) {

        /*
        Если кто-то уже пуст —
        партия заканчивается.
        */

        if (
            checkGameOver(room)
        ) {

            return;
        }
    }

    drawToSix(room);

    /*
    После добора снова проверяем
    окончание партии.
    */

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
        otherPlayer(
            room,
            playerId
        );

    let turn =
        "WAITING";

    /*
    КЛЮЧЕВАЯ ЛОГИКА ХОДА
    */

    if (
        room.status ===
        "playing"
    ) {

        if (
            room.phase ===
            "attack"
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

        } else if (
            room.phase ===
            "defense"
        ) {

            /*
            Во время защиты ход
            принадлежит DEFENDER,
            а не attackerId.
            */

            if (
                room.defenderId ===
                playerId
            ) {

                turn =
                    "YOUR_TURN";

            } else {

                turn =
                    "OPPONENT_TURN";
            }

        } else {

            turn =
                "WAITING";
        }
    }

    const hand =
        me
            ? me.hand.map(
                card => ({

                    id:
                        card.id,

                    suit:
                        card.suit,

                    rank:
                        card.rank,

                    value:
                        card.value
                })
            )
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

        me:
            me
                ? {
                    playerId:
                        me.playerId,

                    name:
                        me.name
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
                player.playerId
            )
        );
    }
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
        return null;
    }

    const room =
        getRoom(roomId);

    if (!room) {

        player.roomId =
            null;

        return null;
    }

    /*
    Запоминаем старый roomId,
    чтобы socket реально вышел
    из комнаты.
    */

    const socketId =
        player.socketId;

    const socket =
        io.sockets.sockets.get(
            socketId
        );

    if (socket) {

        socket.leave(
            room.id
        );
    }

    room.players =
        room.players.filter(
            p =>
                p.playerId !==
                player.playerId
        );

    player.roomId =
        null;

    /*
    Комната пустая.
    */

    if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.id
        );

    } else {

        /*
        Если второй игрок остался,
        он побеждает при выходе.
        */

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

    return room;
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
                authenticate(
                    socket
                );

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

        console.log(
            "Player connected:",
            player.playerId,
            player.name
        );

        /*
        RECONNECT
        */

        if (
            player.roomId
        ) {

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
        JOIN ROOM
        */

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

        /*
        ATTACK
        */

        socket.on(
            "attack_card",
            cardId => {

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
            data => {

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

                sendRoomState(
                    room
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
                Старое соединение
                не должно менять
                состояние нового.
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
