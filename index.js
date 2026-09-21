const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    REST,
    Routes
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    demuxProbe
} = require('@discordjs/voice');

const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');


// =====================================================
// EINSTELLUNGEN
// =====================================================

// HIER DEINEN NEU GENERIERTEN TOKEN EINTRAGEN
const TOKEN = process.env.DISCORD_TOKEN;

const CLIENT_ID = '1548997506820735099';

const SUPPORT_WARTERAUM_ID = '1547562290172268684';
const SUPPORT_BENACHRICHTIGUNG_CHANNEL_ID = '1547562454286999612';
const SUPPORT_TEAM_ROLE_ID = '1547562141714747415';


// =====================================================
// MUSIK
// =====================================================

const SUPPORT_MUSIK_URL =
    'https://www.youtube.com/watch?v=PTEyjK-lzwU';

const AUSSERHALB_SUPPORT_MUSIK_URL =
    'https://www.youtube.com/watch?v=TrFgW1O8Ubw';

const ZEITZONE =
    'Europe/Berlin';


// =====================================================
// SUPPORTZEITEN
// =====================================================

const SUPPORT_ZEITEN = {
    1: { start: '14:00', ende: '22:00' }, // Montag
    2: { start: '14:00', ende: '22:00' }, // Dienstag
    3: { start: '14:00', ende: '22:00' }, // Mittwoch
    4: { start: '14:00', ende: '22:00' }, // Donnerstag
    5: { start: '14:00', ende: '00:00' }, // Freitag
    6: { start: '13:00', ende: '00:00' }, // Samstag
    0: { start: '13:00', ende: '20:00' }  // Sonntag
};


function istSupportGeoeffnet() {

    const jetzt =
        new Date();


    const wochentagText =
        new Intl.DateTimeFormat(
            'en-US',
            {
                timeZone: ZEITZONE,
                weekday: 'short'
            }
        ).format(jetzt);


    const wochentage = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
    };


    const wochentag =
        wochentage[
            wochentagText
        ];


    const zeit =
        new Intl.DateTimeFormat(
            'de-DE',
            {
                timeZone: ZEITZONE,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            }
        ).format(jetzt);


    const [stunden, minuten] =
        zeit
            .split(':')
            .map(Number);


    const aktuelleMinuten =
        stunden * 60 +
        minuten;


    const zeiten =
        SUPPORT_ZEITEN[
            wochentag
        ];


    if (!zeiten) {
        return false;
    }


    const [startStunde, startMinute] =
        zeiten.start
            .split(':')
            .map(Number);


    const [endeStunde, endeMinute] =
        zeiten.ende
            .split(':')
            .map(Number);


    const start =
        startStunde * 60 +
        startMinute;


    let ende =
        endeStunde * 60 +
        endeMinute;


    // 00:00 = Mitternacht
    if (ende === 0) {
        ende = 24 * 60;
    }


    return (
        aktuelleMinuten >= start &&
        aktuelleMinuten < ende
    );
}


function holeAktuelleMusikUrl() {

    if (istSupportGeoeffnet()) {

        return SUPPORT_MUSIK_URL;

    }

    return AUSSERHALB_SUPPORT_MUSIK_URL;
}


// =====================================================
// BLACKLIST DATEI
// =====================================================

const BLACKLIST_DATEI =
    path.join(
        __dirname,
        'blacklist.json'
    );


function ladeBlacklist() {

    try {

        if (!fs.existsSync(BLACKLIST_DATEI)) {

            fs.writeFileSync(
                BLACKLIST_DATEI,
                JSON.stringify(
                    [],
                    null,
                    4
                )
            );

            return [];
        }


        const daten =
            fs.readFileSync(
                BLACKLIST_DATEI,
                'utf8'
            );


        return JSON.parse(
            daten
        );

    } catch (error) {

        console.error(
            '❌ Fehler beim Laden der Blacklist:',
            error.message
        );

        return [];
    }
}


function speichereBlacklist(
    blacklist
) {

    try {

        fs.writeFileSync(
            BLACKLIST_DATEI,
            JSON.stringify(
                blacklist,
                null,
                4
            )
        );

    } catch (error) {

        console.error(
            '❌ Fehler beim Speichern der Blacklist:',
            error.message
        );
    }
}


let blacklist =
    ladeBlacklist();


// =====================================================
// CLIENT
// =====================================================

const client =
    new Client({

        intents: [

            GatewayIntentBits.Guilds,

            GatewayIntentBits.GuildVoiceStates,

            GatewayIntentBits.GuildMembers

        ]

    });


// =====================================================
// AUDIO
// =====================================================

const player =
    createAudioPlayer();

let connection = null;

let youtubeProcess = null;

let restarting = false;

let startInProgress = false;

let supportZeitStatus = null;

let supportZeitTimer = null;


// =====================================================
// ECHTE USER IM WARTERAUM
// =====================================================

async function sindUserImWarteraum() {

    try {

        const channel =
            await client.channels.fetch(
                SUPPORT_WARTERAUM_ID
            );


        if (
            !channel ||
            !channel.isVoiceBased()
        ) {

            return false;
        }


        const echteUser =
            channel.members.filter(
                member =>
                    !member.user.bot
            );


        return echteUser.size > 0;

    } catch (error) {

        console.error(
            '❌ Fehler beim Prüfen des Warteraums:',
            error.message
        );

        return false;
    }
}


// =====================================================
// YOUTUBE STOPPEN
// =====================================================

function stopYoutubeProcess() {

    if (!youtubeProcess) {
        return;
    }


    console.log(
        '🛑 Beende alten YouTube-Stream...'
    );


    const processToStop =
        youtubeProcess;


    youtubeProcess = null;


    try {

        processToStop.catch(
            () => {}
        );

    } catch {}


    try {

        processToStop.kill(
            'SIGTERM'
        );

    } catch {}
}


// =====================================================
// VOICE TRENNEN
// =====================================================

function disconnectVoice() {

    if (!connection) {
        return;
    }


    console.log(
        '🔌 Trenne Voice-Verbindung...'
    );


    try {

        connection.removeAllListeners();

    } catch {}


    try {

        connection.destroy();

    } catch {}


    connection = null;
}


// =====================================================
// AUDIO ZURÜCKSETZEN
// =====================================================

function resetAudio() {

    console.log(
        '🧹 Setze Audio zurück...'
    );


    try {

        player.stop(true);

    } catch {}


    stopYoutubeProcess();

    disconnectVoice();

    startInProgress = false;
}


// =====================================================
// WARTERAUM VERLASSEN
// =====================================================

async function verlasseWarteraum() {

    console.log('');

    console.log(
        '🚪 ========================================'
    );

    console.log(
        '🚪 KEIN USER MEHR IM SUPPORT-WARTERAUM'
    );

    console.log(
        '🚪 BOT VERLÄSST DEN VOICE-CHANNEL'
    );

    console.log(
        '🚪 ========================================'
    );

    console.log('');


    restarting = false;

    resetAudio();
}


// =====================================================
// MUSIK STARTEN
// =====================================================

async function starteMusik() {

    if (startInProgress) {

        console.log(
            '⏳ Musik wird bereits gestartet...'
        );

        return;
    }


    const userImWarteraum =
        await sindUserImWarteraum();


    if (!userImWarteraum) {

        console.log(
            '👤 Niemand im Support-Warteraum.'
        );

        return;
    }


    startInProgress = true;


    try {

        const channel =
            await client.channels.fetch(
                SUPPORT_WARTERAUM_ID
            );


        if (!channel) {

            throw new Error(
                'Support-Warteraum nicht gefunden!'
            );
        }


        if (!channel.isVoiceBased()) {

            throw new Error(
                'Support-Warteraum ist kein Voice-Kanal!'
            );
        }


        const echteUser =
            channel.members.filter(
                member =>
                    !member.user.bot
            );


        if (echteUser.size === 0) {

            console.log(
                '👤 Niemand mehr im Warteraum.'
            );

            return;
        }


        stopYoutubeProcess();


        if (connection) {

            try {
                connection.destroy();
            } catch {}

            connection = null;
        }


        try {
            player.stop(true);
        } catch {}


        // =================================================
        // AKTUELLEN SOUND AUSWÄHLEN
        // =================================================

        const supportGeoeffnet =
            istSupportGeoeffnet();


        const aktuelleMusik =
            holeAktuelleMusikUrl();


        console.log(
            supportGeoeffnet
                ? '🟢 Support ist geöffnet.'
                : '🔴 Support ist geschlossen.'
        );


        console.log(
            `🎵 Musik: ${aktuelleMusik}`
        );


        // =================================================
        // VOICE JOIN
        // =================================================

        connection =
            joinVoiceChannel({

                channelId:
                    channel.id,

                guildId:
                    channel.guild.id,

                adapterCreator:
                    channel.guild.voiceAdapterCreator,

                selfDeaf:
                    false,

                selfMute:
                    false

            });


        // =================================================
        // VERBINDUNG GETRENNT
        // =================================================

        connection.on(

            VoiceConnectionStatus.Disconnected,

            async () => {

                console.log(
                    '⚠️ Voice-Verbindung wurde getrennt!'
                );


                if (restarting) {
                    return;
                }


                const userDa =
                    await sindUserImWarteraum();


                if (!userDa) {

                    resetAudio();

                    return;
                }


                restarting = true;

                resetAudio();


                console.log(
                    '⏳ Erneuter Verbindungsversuch in 3 Sekunden...'
                );


                setTimeout(

                    async () => {

                        restarting = false;

                        try {

                            await starteMusik();

                        } catch (error) {

                            console.error(
                                '❌ Neustart fehlgeschlagen:',
                                error.message
                            );

                        }

                    },

                    3000
                );
            }
        );


        // =================================================
        // READY
        // =================================================

        await entersState(

            connection,

            VoiceConnectionStatus.Ready,

            30000
        );


        connection.subscribe(
            player
        );


        // =================================================
        // YOUTUBE
        // =================================================

        youtubeProcess =
            youtubedl.exec(

                aktuelleMusik,

                {

                    format:
                        'bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]',

                    output:
                        '-',

                    quiet:
                        true,

                    noWarnings:
                        true,

                    noPlaylist:
                        true

                },

                {

                    stdio: [

                        'ignore',

                        'pipe',

                        'pipe'

                    ]

                }
            );


        youtubeProcess.catch(
            () => {}
        );


        youtubeProcess.on(

            'error',

            error => {

                const message =
                    String(
                        error?.message ||
                        error
                    );


                if (

                    message.includes(
                        'Broken pipe'
                    ) ||

                    message.includes(
                        'EPIPE'
                    ) ||

                    message.includes(
                        'SIGTERM'
                    )

                ) {

                    console.log(
                        'ℹ️ Alter YouTube-Stream wurde beendet.'
                    );

                    return;
                }


                console.error(
                    '❌ yt-dlp Fehler:',
                    error
                );
            }
        );


        if (youtubeProcess.stderr) {

            youtubeProcess.stderr.on(

                'data',

                data => {

                    const text =
                        data
                            .toString()
                            .trim();


                    if (

                        text &&

                        !text.includes(
                            'Broken pipe'
                        ) &&

                        !text.includes(
                            'EPIPE'
                        )

                    ) {

                        console.log(
                            'ℹ️ yt-dlp:',
                            text
                        );
                    }
                }
            );
        }


        // =================================================
        // AUDIO ERKENNEN
        // =================================================

        const probed =
            await demuxProbe(
                youtubeProcess.stdout
            );


        const resource =
            createAudioResource(

                probed.stream,

                {

                    inputType:
                        probed.type

                }

            );


        player.play(
            resource
        );


        console.log('');

        console.log(
            '🎶 MUSIK LÄUFT!'
        );

        console.log(
            supportGeoeffnet
                ? '🟢 SUPPORT IST GEÖFFNET'
                : '🔴 SUPPORT IST GESCHLOSSEN'
        );

        console.log(
            '🔊 BOT IST IM SUPPORT-WARTERAUM.'
        );

        console.log('');

    } catch (error) {

        console.error(
            '❌ Musik konnte nicht gestartet werden:',
            error?.message ||
            error
        );


        stopYoutubeProcess();

        disconnectVoice();


        try {
            player.stop(true);
        } catch {}


        const userDa =
            await sindUserImWarteraum();


        if (
            userDa &&
            !restarting
        ) {

            restarting = true;


            setTimeout(

                async () => {

                    restarting = false;

                    try {

                        await starteMusik();

                    } catch (err) {

                        console.error(
                            '❌ Musik-Neustart fehlgeschlagen:',
                            err.message
                        );
                    }

                },

                5000
            );
        }

    } finally {

        startInProgress = false;
    }
}


// =====================================================
// SUPPORTZEIT AUTOMATISCH ÜBERWACHEN
// =====================================================

function starteSupportZeitPruefung() {

    if (supportZeitTimer) {

        clearInterval(
            supportZeitTimer
        );
    }


    supportZeitStatus =
        istSupportGeoeffnet();


    supportZeitTimer =
        setInterval(

            async () => {

                const neuerStatus =
                    istSupportGeoeffnet();


                if (
                    neuerStatus ===
                    supportZeitStatus
                ) {

                    return;
                }


                supportZeitStatus =
                    neuerStatus;


                console.log('');

                console.log(
                    '🕐 ========================================'
                );

                console.log(
                    neuerStatus
                        ? '🟢 SUPPORT IST JETZT GEÖFFNET'
                        : '🔴 SUPPORT IST JETZT GESCHLOSSEN'
                );

                console.log(
                    '🕐 ========================================'
                );


                const userDa =
                    await sindUserImWarteraum();


                if (!userDa) {
                    return;
                }


                if (restarting) {
                    return;
                }


                console.log(
                    '🔄 Wechsle automatisch den Sound...'
                );


                restarting = true;

                resetAudio();


                setTimeout(

                    async () => {

                        restarting = false;

                        try {

                            await starteMusik();

                        } catch (error) {

                            console.error(
                                '❌ Soundwechsel fehlgeschlagen:',
                                error.message
                            );
                        }

                    },

                    1000
                );

            },

            30 * 1000

        );
}


// =====================================================
// MUSIK ENDE
// =====================================================

player.on(

    AudioPlayerStatus.Idle,

    async () => {

        console.log(
            '🔁 Musik beendet.'
        );


        stopYoutubeProcess();


        const userDa =
            await sindUserImWarteraum();


        if (!userDa) {

            await verlasseWarteraum();

            return;
        }


        if (!restarting) {

            restarting = true;


            setTimeout(

                async () => {

                    restarting = false;

                    try {

                        await starteMusik();

                    } catch (error) {

                        console.error(
                            '❌ Musik-Neustart fehlgeschlagen:',
                            error.message
                        );
                    }

                },

                2000
            );
        }
    }
);


// =====================================================
// AUDIO FEHLER
// =====================================================

player.on(

    'error',

    async error => {

        const message =
            String(
                error?.message ||
                error
            );


        if (

            message.includes(
                'Broken pipe'
            ) ||

            message.includes(
                'EPIPE'
            ) ||

            message.includes(
                'SIGTERM'
            )

        ) {

            console.log(
                'ℹ️ Alter Audio-Stream wurde beendet.'
            );

            return;
        }


        console.error(
            '❌ Audio-Fehler:',
            error
        );


        stopYoutubeProcess();


        const userDa =
            await sindUserImWarteraum();


        if (
            userDa &&
            !restarting
        ) {

            restarting = true;


            setTimeout(

                async () => {

                    restarting = false;

                    try {

                        await starteMusik();

                    } catch (err) {

                        console.error(
                            '❌ Audio-Neustart fehlgeschlagen:',
                            err.message
                        );
                    }

                },

                3000
            );
        }
    }
);


// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [

    new SlashCommandBuilder()

        .setName('ping')

        .setDescription(
            'Zeigt die aktuelle Bot-Latenz an.'
        ),


    new SlashCommandBuilder()

        .setName('serverinfo')

        .setDescription(
            'Zeigt Informationen über den Server.'
        ),


    new SlashCommandBuilder()

        .setName('userinfo')

        .setDescription(
            'Zeigt Informationen über einen Benutzer.'
        )

        .addUserOption(
            option =>
                option

                    .setName('user')

                    .setDescription(
                        'Benutzer auswählen.'
                    )

                    .setRequired(false)
        ),


    new SlashCommandBuilder()

        .setName('clear')

        .setDescription(
            'Löscht Nachrichten aus einem Kanal.'
        )

        .addIntegerOption(

            option =>

                option

                    .setName('anzahl')

                    .setDescription(
                        'Anzahl der zu löschenden Nachrichten.'
                    )

                    .setMinValue(1)

                    .setMaxValue(100)

                    .setRequired(true)
        )

        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages.toString()
        ),


    new SlashCommandBuilder()

        .setName('blacklist')

        .setDescription(
            'Verwaltet die Blacklist.'
        )

        .addSubcommand(

            subcommand =>

                subcommand

                    .setName('add')

                    .setDescription(
                        'Fügt einen Benutzer zur Blacklist hinzu.'
                    )

                    .addUserOption(

                        option =>

                            option

                                .setName('user')

                                .setDescription(
                                    'Benutzer für die Blacklist.'
                                )

                                .setRequired(true)
                    )

                    .addStringOption(

                        option =>

                            option

                                .setName('grund')

                                .setDescription(
                                    'Grund für die Blacklist.'
                                )

                                .setRequired(false)
                    )
        )

        .addSubcommand(

            subcommand =>

                subcommand

                    .setName('remove')

                    .setDescription(
                        'Entfernt einen Benutzer von der Blacklist.'
                    )

                    .addUserOption(

                        option =>

                            option

                                .setName('user')

                                .setDescription(
                                    'Benutzer entfernen.'
                                )

                                .setRequired(true)
                    )
        )

        .addSubcommand(

            subcommand =>

                subcommand

                    .setName('list')

                    .setDescription(
                        'Zeigt die Blacklist an.'
                    )
        )

].map(
    command =>
        command.toJSON()
);


// =====================================================
// SLASH COMMANDS REGISTRIEREN
// =====================================================

async function registriereCommands() {

    try {

        console.log(
            '🔄 Registriere Slash Commands...'
        );


        const rest =
            new REST({
                version: '10'
            }).setToken(
                TOKEN
            );


        await rest.put(

            Routes.applicationCommands(
                CLIENT_ID
            ),

            {
                body: commands
            }
        );


        console.log(
            '✅ Slash Commands erfolgreich registriert!'
        );

    } catch (error) {

        console.error(
            '❌ Fehler beim Registrieren der Commands:',
            error
        );
    }
}


// =====================================================
// SLASH COMMAND HANDLER
// =====================================================

client.on(

    'interactionCreate',

    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) {

            return;
        }


        try {

            // =============================================
            // PING
            // =============================================

            if (
                interaction.commandName === 'ping'
            ) {

                const sent =
                    await interaction.reply({

                        content:
                            '🏓 Pong!',

                        fetchReply:
                            true

                    });


                const botPing =
                    sent.createdTimestamp -
                    interaction.createdTimestamp;


                await interaction.editReply({

                    content:
                        `🏓 **Pong!**\n` +
                        `📡 Bot-Latenz: **${botPing}ms**\n` +
                        `💓 WebSocket: **${client.ws.ping}ms**`

                });


                return;
            }


            // =============================================
            // SERVERINFO
            // =============================================

            if (
                interaction.commandName === 'serverinfo'
            ) {

                const guild =
                    interaction.guild;


                if (!guild) {

                    await interaction.reply({

                        content:
                            '❌ Dieser Befehl kann nur auf einem Server verwendet werden.',

                        ephemeral:
                            true

                    });

                    return;
                }


                const owner =
                    await guild.fetchOwner();


                const embed =
                    new EmbedBuilder()

                        .setColor(
                            0x5865F2
                        )

                        .setTitle(
                            `🏙️ ${guild.name}`
                        )

                        .setThumbnail(
                            guild.iconURL({
                                extension: 'png',
                                size: 256
                            })
                        )

                        .addFields(

                            {
                                name:
                                    '🆔 Server-ID',

                                value:
                                    `\`${guild.id}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '👥 Mitglieder',

                                value:
                                    `\`${guild.memberCount}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '👑 Besitzer',

                                value:
                                    `${owner.user}`,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '💬 Textkanäle',

                                value:
                                    `\`${guild.channels.cache.filter(
                                        c => c.isTextBased()
                                    ).size}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '🔊 Sprachkanäle',

                                value:
                                    `\`${guild.channels.cache.filter(
                                        c => c.isVoiceBased()
                                    ).size}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '🎭 Rollen',

                                value:
                                    `\`${guild.roles.cache.size}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '😀 Emojis',

                                value:
                                    `\`${guild.emojis.cache.size}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '📅 Erstellt',

                                value:
                                    `<t:${Math.floor(
                                        guild.createdTimestamp / 1000
                                    )}:F>`,

                                inline:
                                    false
                            }

                        )

                        .setFooter({

                            text:
                                'KölnCity RP • Serverinformationen'

                        })

                        .setTimestamp();


                await interaction.reply({

                    embeds: [
                        embed
                    ]

                });


                return;
            }


            // =============================================
            // USERINFO
            // =============================================

            if (
                interaction.commandName === 'userinfo'
            ) {

                const user =
                    interaction.options.getUser(
                        'user'
                    ) ||
                    interaction.user;


                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(
                            () => null
                        );


                const embed =
                    new EmbedBuilder()

                        .setColor(
                            0x5865F2
                        )

                        .setTitle(
                            '👤 Benutzerinformationen'
                        )

                        .setThumbnail(
                            user.displayAvatarURL({
                                extension: 'png',
                                size: 256
                            })
                        )

                        .addFields(

                            {
                                name:
                                    '👤 Benutzername',

                                value:
                                    `**${member?.displayName || user.username}**`,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '🏷️ Username',

                                value:
                                    `\`${user.username}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '🆔 ID',

                                value:
                                    `\`${user.id}\``,

                                inline:
                                    true
                            },

                            {
                                name:
                                    '📅 Discord Account',

                                value:
                                    `<t:${Math.floor(
                                        user.createdTimestamp / 1000
                                    )}:F>`,

                                inline:
                                    false
                            },

                            {
                                name:
                                    '📥 Server beigetreten',

                                value:

                                    member?.joinedTimestamp

                                        ? `<t:${Math.floor(
                                            member.joinedTimestamp / 1000
                                        )}:F>`

                                        : 'Nicht verfügbar',

                                inline:
                                    false
                            },

                            {
                                name:
                                    '🤖 Bot',

                                value:
                                    user.bot
                                        ? 'Ja'
                                        : 'Nein',

                                inline:
                                    true
                            }

                        )

                        .setFooter({

                            text:
                                'KölnCity RP • Benutzerinformationen'

                        })

                        .setTimestamp();


                await interaction.reply({

                    embeds: [
                        embed
                    ]

                });


                return;
            }


            // =============================================
            // CLEAR
            // =============================================

            if (
                interaction.commandName === 'clear'
            ) {

                if (
                    !interaction.memberPermissions
                        ?.has(
                            PermissionFlagsBits.ManageMessages
                        )
                ) {

                    await interaction.reply({

                        content:
                            '❌ Du benötigst die Berechtigung **Nachrichten verwalten**.',

                        ephemeral:
                            true

                    });

                    return;
                }


                const anzahl =
                    interaction.options.getInteger(
                        'anzahl'
                    );


                if (
                    !interaction.channel ||
                    !interaction.channel.isTextBased()
                ) {

                    await interaction.reply({

                        content:
                            '❌ Dieser Befehl kann hier nicht verwendet werden.',

                        ephemeral:
                            true

                    });

                    return;
                }


                await interaction.deferReply({
                    ephemeral: true
                });


                try {

                    const geloescht =
                        await interaction.channel.bulkDelete(
                            anzahl,
                            true
                        );


                    await interaction.editReply({

                        content:
                            `🧹 **${geloescht.size}** Nachrichten wurden gelöscht.`

                    });

                } catch (error) {

                    console.error(
                        '❌ Clear Fehler:',
                        error
                    );


                    await interaction.editReply({

                        content:
                            '❌ Die Nachrichten konnten nicht gelöscht werden.'

                    });
                }


                return;
            }


            // =============================================
            // BLACKLIST
            // =============================================

            if (
                interaction.commandName === 'blacklist'
            ) {

                if (
                    !interaction.memberPermissions
                        ?.has(
                            PermissionFlagsBits.BanMembers
                        )
                ) {

                    await interaction.reply({

                        content:
                            '❌ Du benötigst die Berechtigung **Mitglieder bannen**.',

                        ephemeral:
                            true

                    });

                    return;
                }


                const subcommand =
                    interaction.options.getSubcommand();


                if (
                    subcommand === 'add'
                ) {

                    const user =
                        interaction.options.getUser(
                            'user'
                        );


                    const grund =
                        interaction.options.getString(
                            'grund'
                        ) ||
                        'Kein Grund angegeben';


                    const bereitsVorhanden =
                        blacklist.find(
                            entry =>
                                entry.userId === user.id
                        );


                    if (
                        bereitsVorhanden
                    ) {

                        await interaction.reply({

                            content:
                                `⚠️ **${user.tag}** steht bereits auf der Blacklist.`,

                            ephemeral:
                                true

                        });

                        return;
                    }


                    blacklist.push({

                        userId:
                            user.id,

                        username:
                            user.tag,

                        grund:
                            grund,

                        hinzugefuegtVon:
                            interaction.user.id,

                        hinzugefuegtAm:
                            Date.now()

                    });


                    speichereBlacklist(
                        blacklist
                    );


                    const embed =
                        new EmbedBuilder()

                            .setColor(
                                0xED4245
                            )

                            .setTitle(
                                '🚫 Benutzer auf Blacklist gesetzt'
                            )

                            .setThumbnail(
                                user.displayAvatarURL({
                                    extension: 'png',
                                    size: 256
                                })
                            )

                            .addFields(

                                {
                                    name:
                                        '👤 Benutzer',

                                    value:
                                        `${user}`,

                                    inline:
                                        true
                                },

                                {
                                    name:
                                        '🆔 ID',

                                    value:
                                        `\`${user.id}\``,

                                    inline:
                                        true
                                },

                                {
                                    name:
                                        '📝 Grund',

                                    value:
                                        grund,

                                    inline:
                                        false
                                },

                                {
                                    name:
                                        '👮 Eingetragen von',

                                    value:
                                        `${interaction.user}`,

                                    inline:
                                        true
                                }

                            )

                            .setTimestamp();


                    await interaction.reply({

                        embeds: [
                            embed
                        ]

                    });


                    return;
                }


                if (
                    subcommand === 'remove'
                ) {

                    const user =
                        interaction.options.getUser(
                            'user'
                        );


                    const index =
                        blacklist.findIndex(
                            entry =>
                                entry.userId === user.id
                        );


                    if (
                        index === -1
                    ) {

                        await interaction.reply({

                            content:
                                `ℹ️ **${user.tag}** steht nicht auf der Blacklist.`,

                            ephemeral:
                                true

                        });

                        return;
                    }


                    blacklist.splice(
                        index,
                        1
                    );


                    speichereBlacklist(
                        blacklist
                    );


                    await interaction.reply({

                        content:
                            `✅ **${user.tag}** wurde von der Blacklist entfernt.`

                    });


                    return;
                }


                if (
                    subcommand === 'list'
                ) {

                    if (
                        blacklist.length === 0
                    ) {

                        await interaction.reply({

                            content:
                                '✅ Die Blacklist ist aktuell leer.',

                            ephemeral:
                                true

                        });

                        return;
                    }


                    let text = '';


                    blacklist.forEach(
                        (entry, index) => {

                            text +=
                                `**${index + 1}.** ` +
                                `<@${entry.userId}>\n` +
                                `🆔 \`${entry.userId}\`\n` +
                                `📝 ${entry.grund}\n\n`;

                        }
                    );


                    if (
                        text.length > 4000
                    ) {

                        text =
                            text.substring(
                                0,
                                3900
                            ) +
                            '\n... weitere Einträge vorhanden.';
                    }


                    const embed =
                        new EmbedBuilder()

                            .setColor(
                                0xED4245
                            )

                            .setTitle(
                                '🚫 Blacklist'
                            )

                            .setDescription(
                                text
                            )

                            .setFooter({

                                text:
                                    `KölnCity RP • ${blacklist.length} Einträge`

                            })

                            .setTimestamp();


                    await interaction.reply({

                        embeds: [
                            embed
                        ],

                        ephemeral:
                            true

                    });


                    return;
                }
            }

        } catch (error) {

            console.error(
                '❌ Fehler beim Slash Command:',
                error
            );


            if (
                interaction.replied ||
                interaction.deferred
            ) {

                await interaction.followUp({

                    content:
                        '❌ Beim Ausführen des Befehls ist ein Fehler aufgetreten.',

                    ephemeral:
                        true

                }).catch(
                    () => {}
                );

            } else {

                await interaction.reply({

                    content:
                        '❌ Beim Ausführen des Befehls ist ein Fehler aufgetreten.',

                    ephemeral:
                        true

                }).catch(
                    () => {}
                );
            }
        }
    }
);


// =====================================================
// VOICE STATE UPDATE
// =====================================================

client.on(

    'voiceStateUpdate',

    async (oldState, newState) => {

        if (!client.user) {
            return;
        }


        // =================================================
        // USER BETRITT SUPPORT
        // =================================================

        const userBetrittWarteraum =

            newState.channelId ===
                SUPPORT_WARTERAUM_ID &&

            oldState.channelId !==
                SUPPORT_WARTERAUM_ID &&

            newState.id !==
                client.user.id;


        if (userBetrittWarteraum) {

            const user =
                newState.member?.user;


            console.log(
                `👤 ${user?.tag || 'User'} ist dem Support-Warteraum beigetreten.`
            );


            if (
                !connection &&
                !startInProgress
            ) {

                console.log(
                    '🔊 Erster User ist da -> Bot joint sofort!'
                );


                try {

                    await starteMusik();

                } catch (error) {

                    console.error(
                        '❌ Bot konnte nicht joinen:',
                        error.message
                    );
                }

            } else {

                console.log(
                    '👥 Bot ist bereits im Warteraum.'
                );
            }


            // =================================================
            // SUPPORT BENACHRICHTIGUNG
            // =================================================

            try {

                const notificationChannel =
                    await client.channels.fetch(
                        SUPPORT_BENACHRICHTIGUNG_CHANNEL_ID
                    );


                if (
                    notificationChannel &&
                    user
                ) {

                    const member =
                        newState.member;


                    const accountCreated =
                        `<t:${Math.floor(
                            user.createdTimestamp / 1000
                        )}:F>`;


                    const serverJoined =

                        member?.joinedTimestamp

                            ? `<t:${Math.floor(
                                member.joinedTimestamp / 1000
                            )}:F>`

                            : 'Nicht verfügbar';


                    const requestTime =
                        `<t:${Math.floor(
                            Date.now() / 1000
                        )}:R>`;


                    const displayName =
                        member?.displayName ||
                        user.username;


                    const avatar =
                        user.displayAvatarURL({

                            extension:
                                'png',

                            size:
                                256

                        });


                    const embed =

                        new EmbedBuilder()

                            .setColor(
                                0x5865F2
                            )

                            .setAuthor({

                                name:
                                    'KölnCity RP • Support-System',

                                iconURL:
                                    client.user.displayAvatarURL({

                                        extension:
                                            'png',

                                        size:
                                            128

                                    })

                            })

                            .setTitle(
                                '🚨 Neue Support-Anfrage'
                            )

                            .setDescription(

                                `### 👋 Support benötigt!\n\n` +

                                `**${displayName}** ist gerade dem ` +
                                `**Support-Warteraum** beigetreten.\n\n` +

                                `> 🛡️ Ein Support-Teammitglied sollte ` +
                                `sich so schnell wie möglich um die ` +
                                `Anfrage kümmern.`

                            )

                            .setThumbnail(
                                avatar
                            )

                            .addFields(

                                {

                                    name:
                                        '👤 Benutzer',

                                    value:
                                        `**${displayName}**\n@${user.username}`,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '🏷️ Discord-Tag',

                                    value:
                                        `\`${user.tag}\``,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '🆔 Benutzer-ID',

                                    value:
                                        `\`${user.id}\``,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '📅 Account erstellt',

                                    value:
                                        accountCreated,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '📥 Server beigetreten',

                                    value:
                                        serverJoined,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '🕐 Anfrage',

                                    value:
                                        requestTime,

                                    inline:
                                        true

                                },

                                {

                                    name:
                                        '🎧 Support-Warteraum',

                                    value:
                                        `<#${SUPPORT_WARTERAUM_ID}>`,

                                    inline:
                                        false

                                },

                                {

                                    name:
                                        '🔗 Benutzerprofil',

                                    value:
                                        `[👤 Profil von ${displayName} öffnen]` +
                                        `(https://discord.com/users/${user.id})`,

                                    inline:
                                        false

                                }

                            )

                            .setFooter({

                                text:
                                    'KölnCity RP • Support-Anfrage'

                            })

                            .setTimestamp();


                    await notificationChannel.send({

                        content:
                            `🚨 <@&${SUPPORT_TEAM_ROLE_ID}> **Neue Support-Anfrage!**`,

                        embeds:
                            [embed],

                        allowedMentions: {

                            roles:
                                [SUPPORT_TEAM_ROLE_ID]

                        }

                    });


                    console.log(
                        `🔔 Support-Benachrichtigung für ${user.tag} gesendet.`
                    );
                }

            } catch (error) {

                console.error(
                    '❌ Support-Benachrichtigung fehlgeschlagen:',
                    error.message
                );
            }
        }


        // =================================================
        // USER VERLÄSST SUPPORT
        // =================================================

        const userVerlaesstWarteraum =

            oldState.channelId ===
                SUPPORT_WARTERAUM_ID &&

            newState.channelId !==
                SUPPORT_WARTERAUM_ID &&

            oldState.id !==
                client.user.id;


        if (userVerlaesstWarteraum) {

            console.log(
                `👋 ${oldState.member?.user?.tag || 'User'} hat den Support-Warteraum verlassen.`
            );


            setTimeout(

                async () => {

                    const userDa =
                        await sindUserImWarteraum();


                    if (!userDa) {

                        await verlasseWarteraum();

                    } else {

                        console.log(
                            '👥 Noch User im Warteraum -> Bot bleibt.'
                        );
                    }

                },

                500
            );
        }


        // =================================================
        // BOT WURDE GETRENNT
        // =================================================

        const botWurdeGetrennt =

            oldState.id ===
                client.user.id &&

            oldState.channelId ===
                SUPPORT_WARTERAUM_ID &&

            newState.channelId !==
                SUPPORT_WARTERAUM_ID;


        if (botWurdeGetrennt) {

            console.log(
                '🚨 BOT WURDE AUS DEM VOICE GETRENNT!'
            );


            const userDa =
                await sindUserImWarteraum();


            if (!userDa) {

                resetAudio();

                return;
            }


            if (restarting) {
                return;
            }


            restarting = true;

            resetAudio();


            setTimeout(

                async () => {

                    restarting = false;

                    try {

                        await starteMusik();

                    } catch (error) {

                        console.error(
                            '❌ Erneutes Joinen fehlgeschlagen:',
                            error.message
                        );
                    }

                },

                3000
            );
        }
    }
);


// =====================================================
// BOT READY
// =====================================================

client.once(

    'ready',

    async () => {

        console.log('');

        console.log(
            '=========================================='
        );

        console.log(
            `🤖 Bot online: ${client.user.tag}`
        );

        console.log(
            '=========================================='
        );


        await registriereCommands();


        // =================================================
        // SUPPORTZEIT ÜBERWACHUNG STARTEN
        // =================================================

        starteSupportZeitPruefung();


        const userDa =
            await sindUserImWarteraum();


        if (userDa) {

            console.log(
                '👤 User ist bereits im Warteraum.'
            );


            try {

                await starteMusik();

            } catch (error) {

                console.error(
                    '❌ Musik konnte nicht gestartet werden:',
                    error.message
                );
            }

        } else {

            console.log(
                '👤 Niemand im Support-Warteraum.'
            );

            console.log(
                '🚪 Bot bleibt außerhalb des Voice-Channels.'
            );
        }
    }
);


// =====================================================
// WEBSEITEN-API / ANKÜNDIGUNGEN
// =====================================================
const http = require('http');
const crypto = require('crypto');
const API_PORT = Number(process.env.PORT || 3000);
const PANEL_API_KEY = process.env.PANEL_API_KEY || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
let apiRequests = [];

function jsonResponse(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Panel-Key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function cleanApiString(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validApiColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}

function apiAuthorized(req) {
    if (!PANEL_API_KEY) return false;
    const supplied = req.headers['x-panel-key'];
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(PANEL_API_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function apiRateLimited() {
    const now = Date.now();
    apiRequests = apiRequests.filter(t => now - t < 60000);
    if (apiRequests.length >= 30) return true;
    apiRequests.push(now);
    return false;
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 256 * 1024) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch { reject(new Error('INVALID_JSON')); }
        });
        req.on('error', reject);
    });
}

const apiServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});

    if (req.method === 'GET' && req.url === '/api/health') {
        return jsonResponse(res, 200, {
            ok: true,
            discordReady: client.isReady(),
            bot: client.user ? client.user.tag : null,
            guildId: DISCORD_GUILD_ID || null
        });
    }

    if (req.method !== 'POST' || req.url !== '/api/announcements') {
        return jsonResponse(res, 404, { ok: false, error: 'API-Endpunkt nicht gefunden' });
    }

    if (!apiAuthorized(req)) {
        return jsonResponse(res, 401, { ok: false, error: 'Ungültiger Panel-Key' });
    }

    if (apiRateLimited()) {
        return jsonResponse(res, 429, { ok: false, error: 'Zu viele Anfragen. Bitte kurz warten.' });
    }

    try {
        if (!client.isReady()) return jsonResponse(res, 503, { ok: false, error: 'Discord-Bot ist noch nicht bereit' });

        const body = await readRequestBody(req);
        const channelId = cleanApiString(body.channelId, 30);
        const title = cleanApiString(body.title, 256);
        const description = typeof body.description === 'string' ? body.description.trim().slice(0, 4096) : '';
        const image = cleanApiString(body.image, 2048);
        const footer = cleanApiString(body.footer, 2048);
        const color = cleanApiString(body.color, 7) || '#ff1717';

        if (!/^\d{17,20}$/.test(channelId)) return jsonResponse(res, 400, { ok: false, error: 'Ungültige Discord Channel-ID' });
        if (!title && !description) return jsonResponse(res, 400, { ok: false, error: 'Titel oder Nachricht fehlt' });
        if (!validApiColor(color)) return jsonResponse(res, 400, { ok: false, error: 'Farbe muss im Format #RRGGBB sein' });
        if (image && !/^https?:\/\//i.test(image)) return jsonResponse(res, 400, { ok: false, error: 'Bild-URL muss mit http:// oder https:// beginnen' });

        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
            return jsonResponse(res, 400, { ok: false, error: 'Der Channel ist kein beschreibbarer Text-Channel' });
        }
        if (DISCORD_GUILD_ID && channel.guildId !== DISCORD_GUILD_ID) {
            return jsonResponse(res, 403, { ok: false, error: 'Dieser Channel gehört nicht zu deinem freigegebenen Discord-Server' });
        }

        const embed = new EmbedBuilder().setColor(color).setTimestamp();
        if (title) embed.setTitle(title);
        if (description) embed.setDescription(description);
        if (image) embed.setImage(image);
        if (footer) embed.setFooter({ text: footer });

        const message = await channel.send({ embeds: [embed] });
        console.log(`📢 Ankündigung gesendet: ${message.id} -> #${channel.name || channel.id}`);
        return jsonResponse(res, 200, { ok: true, messageId: message.id, channelId: channel.id });
    } catch (error) {
        console.error('❌ API-Ankündigung fehlgeschlagen:', error);
        if (error?.message === 'BODY_TOO_LARGE') return jsonResponse(res, 413, { ok: false, error: 'Anfrage ist zu groß' });
        if (error?.message === 'INVALID_JSON') return jsonResponse(res, 400, { ok: false, error: 'Ungültiges JSON' });
        if (error?.code === 10003) return jsonResponse(res, 404, { ok: false, error: 'Discord-Channel nicht gefunden' });
        if (error?.code === 50001 || error?.code === 50013) return jsonResponse(res, 403, { ok: false, error: 'Bot hat dort keine Berechtigung zu schreiben. Benötigt: Kanal ansehen, Nachrichten senden, Links einbetten.' });
        return jsonResponse(res, 500, { ok: false, error: 'Discord-Nachricht konnte nicht gesendet werden' });
    }
});

if (!PANEL_API_KEY) {
    console.error('❌ PANEL_API_KEY fehlt. Die Webseiten-Ankündigungen bleiben deaktiviert.');
} else {
    apiServer.listen(API_PORT, '0.0.0.0', () => {
        console.log(`🌐 Webseiten-API läuft auf http://localhost:${API_PORT}`);
    });
}

// =====================================================
// START
// =====================================================

console.log(
    '🚀 Bot wird gestartet...'
);

if (!TOKEN) {
    console.error('❌ DISCORD_TOKEN fehlt. Bitte .env konfigurieren.');
    process.exit(1);
}

client.login(
    TOKEN
);