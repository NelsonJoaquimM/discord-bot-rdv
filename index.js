// index.js
require("dotenv").config();

const {
    Client, GatewayIntentBits, Events,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes
} = require("discord.js");
const { google } = require("googleapis");

// --- Authentification Google ---
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// --- Fonction Google Sheets (ajout automatique à la fin) ---
async function saveToSheet(all) {
    try {
        const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
        const spreadsheetId = process.env.SPREADSHEET_ID;
        const sheetName = "Feuille1";

        // Utilisation de .append au lieu de .update
        const result = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A1`, // L'API recherche la prochaine ligne libre à partir d'ici
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS", // Force l'insertion d'une nouvelle ligne
            resource: {
                values: [[
                    new Date().toLocaleString("fr-FR"), // A : horodatage lisible
                    all.agent,                          // B
                    all.garage,                         // C
                    all.client,                         // D
                    all.voiture,                        // E
                    all.tel,                            // F
                    all.date,                           // G
                    all.heure,                          // H
                    all.rebooking || "-",               // I
                    "-",                                // J
                    "",                                 // K
                    "-"                                 // L (verrou)
                ]]
            }
        });

        // Extraction de la ligne insérée pour le feedback utilisateur
        const appendedRange = result.data.updates.updatedRange; 
        const nextRow = appendedRange.match(/(\d+)/g).pop(); 

        console.log(`✅ RDV ajouté AUTOMATIQUEMENT en ligne ${nextRow} (A:L)`);
        return nextRow; 
    } catch (err) {
        console.error("❌ Erreur Google Sheets:", err.message);
        throw err; // Propager pour feedback dans Discord
    }
}

// --- Discord Bot ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pendingData = new Map();

client.once(Events.ClientReady, () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

// Gestion des interactions
client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // Slash command /rdv → premier formulaire
        if (interaction.isChatInputCommand() && interaction.commandName === "rdv") {
            const modal1 = new ModalBuilder()
                .setCustomId("rdvForm1")
                .setTitle("RDV (Étape 1/2)");

            const agent = new TextInputBuilder().setCustomId("agent").setLabel("Agent").setStyle(TextInputStyle.Short).setRequired(true);
            const garage = new TextInputBuilder().setCustomId("garage").setLabel("Garage").setStyle(TextInputStyle.Short).setRequired(true);
            const clientName = new TextInputBuilder().setCustomId("client").setLabel("Client").setStyle(TextInputStyle.Short).setRequired(true);
            const voiture = new TextInputBuilder().setCustomId("voiture").setLabel("Voiture").setStyle(TextInputStyle.Short).setRequired(true);
            const tel = new TextInputBuilder().setCustomId("tel").setLabel("Téléphone").setStyle(TextInputStyle.Short).setRequired(true);

            modal1.addComponents(
                new ActionRowBuilder().addComponents(agent),
                new ActionRowBuilder().addComponents(garage),
                new ActionRowBuilder().addComponents(clientName),
                new ActionRowBuilder().addComponents(voiture),
                new ActionRowBuilder().addComponents(tel)
            );

            await interaction.showModal(modal1);
            return;
        }

        // Soumission du premier modal
        if (interaction.isModalSubmit() && interaction.customId === "rdvForm1") {
            const data1 = {
                agent: interaction.fields.getTextInputValue("agent"),
                garage: interaction.fields.getTextInputValue("garage"),
                client: interaction.fields.getTextInputValue("client"),
                voiture: interaction.fields.getTextInputValue("voiture"),
                tel: interaction.fields.getTextInputValue("tel"),
            };
            pendingData.set(interaction.user.id, data1);

            const nextBtn = new ButtonBuilder()
                .setCustomId("rdvFormNext")
                .setLabel("Compléter (Étape 2)")
                .setStyle(ButtonStyle.Primary);

            await interaction.reply({
                content: "✅ Étape 1 enregistrée. Cliquez pour compléter l’étape 2.",
                components: [new ActionRowBuilder().addComponents(nextBtn)],
                ephemeral: true,
            });
            return;
        }

        // Bouton → second modal
        if (interaction.isButton() && interaction.customId === "rdvFormNext") {
            if (!pendingData.has(interaction.user.id)) {
                await interaction.reply({ content: "❌ Aucune donnée d’étape 1 trouvée. Recommence avec /rdv.", ephemeral: true });
                return;
            }

            const modal2 = new ModalBuilder()
                .setCustomId("rdvForm2")
                .setTitle("RDV (Étape 2/2)");

            const heure = new TextInputBuilder().setCustomId("heure").setLabel("Heure").setStyle(TextInputStyle.Short).setRequired(true);
            const date = new TextInputBuilder().setCustomId("date").setLabel("Date").setStyle(TextInputStyle.Short).setRequired(true);
            const rebooking = new TextInputBuilder().setCustomId("rebooking").setLabel("Rebooking").setStyle(TextInputStyle.Short).setRequired(false);

            modal2.addComponents(
                new ActionRowBuilder().addComponents(heure),
                new ActionRowBuilder().addComponents(date),
                new ActionRowBuilder().addComponents(rebooking)
            );

            await interaction.showModal(modal2);
            return;
        }

        // Soumission du second modal
        if (interaction.isModalSubmit() && interaction.customId === "rdvForm2") {
            await interaction.deferReply({ ephemeral: true });

            const data1 = pendingData.get(interaction.user.id) || {};
            const data2 = {
                heure: interaction.fields.getTextInputValue("heure"),
                date: interaction.fields.getTextInputValue("date"),
                rebooking: interaction.fields.getTextInputValue("rebooking"),
            };
            const all = { ...data1, ...data2 };
            pendingData.delete(interaction.user.id);

            try {
                const row = await saveToSheet(all); // Capture le numéro de ligne

                await interaction.editReply({
                    content: `📋 RDV enregistré **à la ligne ${row}**:\n` +
                        `- Agent: ${all.agent}\n- Garage: ${all.garage}\n- Client: ${all.client}\n` +
                        `- Voiture: ${all.voiture}\n- Tel: ${all.tel}\n` +
                        `- Date: ${all.date}\n- Heure: ${all.heure}\n- Rebooking: ${all.rebooking || "-"}`
                });
            } catch (err) {
                console.error("❌ Erreur Sheets:", err);
                await interaction.editReply({
                    content: "❌ Une erreur est survenue lors de l'enregistrement dans Google Sheets."
                });
            }
            return;
        }
    } catch (err) {
        console.error("❌ Erreur interaction:", err);
        if (interaction && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => {});
        }
    }
});

// --- Enregistrement de la commande /rdv ---
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: [
                new SlashCommandBuilder()
                    .setName("rdv")
                    .setDescription("Créer un RDV (2 étapes)")
                    .toJSON()
            ] }
        );
        console.log("✅ Commande /rdv déployée");
        client.login(process.env.DISCORD_TOKEN);
    } catch (err) {
        console.error("❌ Erreur au démarrage:", err);
    }
})();