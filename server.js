const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;


/*
=========================================================
CONFIG
=========================================================
*/

const START_MONEY = 10000;
const START_XP = 0;
const START_LEVEL = 1;


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


const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl: DATABASE_URL
        ? {
            rejectUnauthorized: false
        }
        : undefined
});


/*
=========================================================
SOCKET.IO
=========================================================
*/

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
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
        path.join(__dirname, "public")
    )
);


/*
=========================================================
DATABASE INITIALIZATION
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


    console.log(
        "PostgreSQL connected"
    );


    console.log(
        "Heavy Lux Card database initialized"
    );

}


/*
=========================================================
TELEGRAM INIT DATA
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
            .from(params.entries())
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


    const valid =
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
GET /api/health
=========================================================
*/

app.get(
    "/api/health",
    async (req, res) => {

        let database = false;

        try {

            await pool.query(
                "SELECT 1"
            );

            database = true;

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
                "2.0.0",

            telegram:
                Boolean(BOT_TOKEN),

            socket:
                true,

            database

        });

    }
);


/*
=========================================================
TELEGRAM AUTH
=========================================================
*/

app.post(
    "/api/auth/telegram",
    async (req, res) => {

        try {

            const {
                initData
            } = req.body || {};


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


            const user =
                result.user;


            if (
                !user ||
                !user.id
            ) {

                return res
                    .status(401)
                    .json({

                        ok: false,

                        error:
                            "Telegram user not found"

                    });

            }


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


            /*
            =============================================
            CREATE / UPDATE PLAYER
            =============================================
            */

            const resultPlayer =
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


            const player =
                resultPlayer.rows[0];


            return res.json({

                ok: true,

                player: {

                    id:
                        player.id,

                    telegramId:
                        player.telegram_id,

                    username:
                        player.username,

                    firstName:
                        player.first_name,

                    lastName:
                        player.last_name,

                    money:
                        Number(
                            player.money
                        ),

                    xp:
                        player.xp,

                    level:
                        player.level,

                    wins:
                        player.wins,

                    losses:
                        player.losses,

                    gamesPlayed:
                        player.games_played

                }

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
SOCKET.IO
=========================================================
*/

io.on(
    "connection",
    (socket) => {

        console.log(
            "Socket connected:",
            socket.id
        );


        socket.emit(
            "server:hello",
            {

                ok: true,

                project:
                    "Heavy Lux Card",

                socketId:
                    socket.id

            }
        );


        socket.on(
            "disconnect",
            (reason) => {

                console.log(
                    "Socket disconnected:",
                    socket.id,
                    reason
                );

            }
        );

    }
);


/*
=========================================================
START
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
