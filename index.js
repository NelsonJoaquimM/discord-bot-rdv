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
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// --- Fonction Google Sheets (append) ---
async function saveToSheet(all) {
  try {
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const spreadsheetId = "1VFTJUZzoSp4xNXxourEtAmaY9eHKmwK90RiUs6KfsZI";

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Feuille1!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toLocaleString("fr-FR"),
          all.agent || "",
          all.garage || "",
          all.client || "",
          all.voiture || "",
          all.tel || "",
          all.date || "",
          all.heure || "",
          all.rebooking || "-"
        ]],
      },
    });

    console.log("✅ RDV ajouté en nouvelle ligne");
  } catch (err) {
    console.error("❌ Erreur Google Sheets:", err.message || err);
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
    if (interaction.isChatInputCommand() && interaction.commandName === "rdv") {
      const modal1 = new ModalBuilder().setCustomId("rdvForm1").setTitle("RDV (Étape 1/2)");

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

    if (interaction.isModalSubmit() && interaction.customId === "rdvForm1") {
      const data1 = {
        agent: interaction.fields.getTextInputValue("agent"),
        garage: interaction.fields.getTextInputValue("garage"),
        client: interaction.fields.getTextInputValue("client"),
        voiture: interaction.fields.getTextInputValue("voiture"),
        tel: interaction.fields.getTextInputValue("tel"),
      };

      pendingData.set(interaction.user.id, data1);

      const nextBtn = new ButtonBuilder().setCustomId("rdvFormNext").setLabel("Compléter (Étape 2)").setStyle(ButtonStyle.Primary);

      await interaction.reply({
        content: "Étape 1 enregistrée. Cliquez pour compléter l’étape 2.",
        components: [new ActionRowBuilder().addComponents(nextBtn)],
        ephemeral: true,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "rdvFormNext") {
      if (!pendingData.has(interaction.user.id)) {
        await interaction.reply({ content: "Aucune donnée d’étape 1 trouvée. Recommence avec /rdv.", ephemeral: true });
        return;
      }

      const modal2 = new ModalBuilder().setCustomId("rdvForm2").setTitle("RDV (Étape 2/2)");

      const heure = new TextInputBuilder().setCustomId("heure").setLabel("Heure (ex: 15:30)").setStyle(TextInputStyle.Short).setRequired(true);
      const date = new TextInputBuilder().setCustomId("date").setLabel("Date (ex: 2025-12-13)").setStyle(TextInputStyle.Short).setRequired(true);
      const rebooking = new TextInputBuilder().setCustomId("rebooking").setLabel("Rebooking (optionnel)").setStyle(TextInputStyle.Short).setRequired(false);

      modal2.addComponents(
        new ActionRowBuilder().addComponents(heure),
        new ActionRowBuilder().addComponents(date),
        new ActionRowBuilder().addComponents(rebooking)
      );

      await interaction.showModal(modal2);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "rdvForm2") {
      const data1 = pendingData.get(interaction.user.id) || {};
      const data2 = {
        heure: interaction.fields.getTextInputValue("heure"),
        date: interaction.fields.getTextInputValue("date"),
        rebooking: interaction.fields.getTextInputValue("rebooking"),
      };

      const all = { ...data1, ...data2 };
      pendingData.delete(interaction.user.id);

      await interaction.reply({
        content:
          `📋 RDV enregistré:\n` +
          `- Agent: ${all.agent}\n- Garage: ${all.garage}\n- Client: ${all.client}\n` +
          `- Voiture: ${all.voiture}\n- Tel: ${all.tel}\n` +
          `- Date: ${all.date}\n- Heure: ${all.heure}\n- Rebooking: ${all.rebooking || "-"}`,
        ephemeral: true,
      });

      await saveToSheet(all);
      return;
    }
  } catch (err) {
    console.error("❌ Erreur interaction:", err);
    if (interaction && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => {});
    }
  }
});

// --- Vérification du token avant connexion ---
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Aucun token Discord trouvé dans les variables d'environnement.");
  process.exit(1);
} else {
  console.log("🔑 Token reçu: OK (masqué)");
  console.log("DISCORD_TOKEN =", process.env.DISCORD_TOKEN ? "✅ présent" : "❌ absent");
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("❌ Erreur lors du login Discord:", err);
    process.exit(1);
  });
}
