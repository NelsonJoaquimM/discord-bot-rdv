// --- Charger les variables d'environnement ---
require("dotenv").config();

// --- Imports ---
const {
  Client,
  GatewayIntentBits,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { google } = require("googleapis");

// --- Authentification Google ---
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// --- Fonction Google Sheets ---
async function saveToSheet(all) {
  try {
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const spreadsheetId = "1VFTJUZzoSp4xNXxourEtAmaY9eHKmwK90RiUs6KfsZI";

    // 🔍 Lire la colonne A pour trouver la dernière ligne réellement remplie
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Feuille1!A2:A3238", // adapte à la taille réelle de ta feuille
    });
    const values = res.data.values || [];

    let lastRow = 1;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] && values[i][0].toString().trim() !== "") {
        lastRow = i + 2; // +2 car on commence à A2
      }
    }
    const nextRow = lastRow + 1;

    // ✍️ Écrire exactement à la suite
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Feuille1!A${nextRow}:I${nextRow}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          new Date().toLocaleString("fr-FR"), // Horodateur (A)
          all.agent,                          // Agent (B)
          all.garage,                         // Garage (C)
          all.client,                         // Client (D)
          all.voiture,                        // Voiture (E)
          all.tel,                            // Tel (F)
          all.date,                           // Date du RDV (G)
          all.heure,                          // Heure du RDV (H)
          all.rebooking || "-"                // Rdv Rebooké ? (I)
        ]],
      },
    });

    console.log("✅ RDV écrit à la ligne " + nextRow);
  } catch (err) {
    console.error("❌ Erreur Google Sheets:", err.message);
  }
}

// --- Discord Bot ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pendingData = new Map();

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash command /rdv
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
        content: "Étape 1 enregistrée. Cliquez pour compléter l’étape 2.",
        components: [new ActionRowBuilder().addComponents(nextBtn)],
        ephemeral: true,
      });
      return;
    }

    // Bouton → second modal
    if (interaction.isButton() && interaction.customId === "rdvFormNext") {
      if (!pendingData.has(interaction.user.id)) {
        await interaction.reply({ content: "Aucune donnée d’étape 1 trouvée. Recommence avec /rdv.", ephemeral: true });
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
      const data1 = pendingData.get(interaction.user.id) || {};
      const data2 = {
        heure: interaction.fields.getTextInputValue("heure"),
        date: interaction.fields.getTextInputValue("date"),
        rebooking: interaction.fields.getTextInputValue("rebooking"),
      };

      const all = { ...data1, ...data2 };
      pendingData.delete(interaction.user.id);

      // ✅ Répondre immédiatement à Discord
      await interaction.reply({
        content:
          `📋 RDV enregistré:\n` +
          `- Agent: ${all.agent}\n- Garage: ${all.garage}\n- Client: ${all.client}\n` +
          `- Voiture: ${all.voiture}\n- Tel: ${all.tel}\n` +
          `- Date: ${all.date}\n- Heure: ${all.heure}\n- Rebooking: ${all.rebooking || "-"}`,
        ephemeral: true,
      });

      // ⚡ Écriture vers Google Sheets en arrière-plan
      saveToSheet(all).catch(err => {
        console.error("❌ Erreur Google Sheets:", err.message);
      });
      return;
    }
  } catch (err) {
    console.error("❌ Erreur interaction:", err);
    if (interaction && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => {});
    }
  }
});

// ✅ Connexion avec le token depuis .env
client.login(process.env.DISCORD_TOKEN);


