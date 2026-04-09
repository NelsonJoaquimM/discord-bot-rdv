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

const SPREADSHEET_ID = "1VFTJUZzoSp4xNXxourEtAmaY9eHKmwK90RiUs6KfsZI";

// --- Colonnes ---
const COL = {
  HORODATEUR: 0, // A
  AGENT: 1,      // B
  GARAGE: 2,     // C
  CLIENT: 3,     // D
  VEHICULE: 4,   // E
  TEL: 5,        // F
  DATE_RDV: 6,   // G
  HEURE_RDV: 7,  // H
  REBOOKE: 8,    // I
  ID_RDV: 9,     // J
  STATUT: 10,    // K
};

// --- Écriture d'un nouveau RDV ---
async function saveToSheet(all) {
  try {
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Feuille1!A2:A131076",
    });
    const values = res.data.values || [];

    let lastRow = 1;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] && values[i][0].toString().trim() !== "") {
        lastRow = i + 2;
      }
    }
    const nextRow = lastRow + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Feuille1!A${nextRow}:J${nextRow}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          new Date().toLocaleString("fr-FR"),
          all.agent,
          all.garage,
          all.client,
          all.voiture,
          all.tel,
          all.date,
          all.heure,
          all.rebooking || "-",
          all.idEvenement || "-",
        ]],
      },
    });

    console.log("✅ RDV écrit à la ligne " + nextRow);
  } catch (err) {
    console.error("❌ Erreur saveToSheet:", err.message);
  }
}

// --- Recherche d'une ligne par ID RDV (colonne J) ---
async function findRowByIdRdv(idRdv) {
  try {
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Feuille1!A2:K",
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idCell = (row[COL.ID_RDV] || "").toString().trim();
      if (idCell === idRdv.trim()) {
        return { rowIndex: i + 2, row }; // rowIndex = numéro réel dans le Sheet (base 1, avec header)
      }
    }
    return null;
  } catch (err) {
    console.error("❌ Erreur findRowByIdRdv:", err.message);
    return null;
  }
}

// --- Mise à jour colonne K (Statut) ---
async function updateStatut(rowIndex, statut) {
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Feuille1!K${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[statut]] },
  });
}

// --- Mise à jour colonnes G + H (Date + Heure) ---
async function updateDateHeure(rowIndex, date, heure) {
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Feuille1!G${rowIndex}:H${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[date, heure]] },
  });
}

// --- Discord Bot ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pendingData = new Map();       // Données étape 1 RDV
const pendingModif = new Map();      // Données modification en attente (ID + rowIndex + infos)

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {

    // ══════════════════════════════════════════
    //  /rdv — Prise de RDV (étape 1)
    // ══════════════════════════════════════════
    if (interaction.isChatInputCommand() && interaction.commandName === "rdv") {
      const modal1 = new ModalBuilder().setCustomId("rdvForm1").setTitle("RDV (Étape 1/2)");
      modal1.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("agent").setLabel("Agent").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("garage").setLabel("Garage").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("client").setLabel("Client").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("voiture").setLabel("Voiture").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tel").setLabel("Téléphone").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal1);
      return;
    }

    // ══════════════════════════════════════════
    //  /modifier-rdv — Modification d'un RDV
    // ══════════════════════════════════════════
    if (interaction.isChatInputCommand() && interaction.commandName === "modifier-rdv") {
      const modal = new ModalBuilder().setCustomId("modifIdForm").setTitle("Modifier un RDV");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("idRdv")
            .setLabel("ID du RDV (colonne J du Sheet)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Ex: 3s3u6g52dj2m7pa3odgvqv9dk4")
            .setRequired(true)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    // ══════════════════════════════════════════
    //  Modal — ID RDV soumis → recherche + boutons
    // ══════════════════════════════════════════
    if (interaction.isModalSubmit() && interaction.customId === "modifIdForm") {
      const idRdv = interaction.fields.getTextInputValue("idRdv").trim();

      await interaction.deferReply({ ephemeral: true });

      const result = await findRowByIdRdv(idRdv);
      if (!result) {
        await interaction.editReply({ content: `❌ Aucun RDV trouvé avec l'ID **${idRdv}**. Vérifie la colonne J du Sheet.` });
        return;
      }

      const { rowIndex, row } = result;

      // Sauvegarder pour usage après clic bouton
      pendingModif.set(interaction.user.id, { idRdv, rowIndex, row });

      const info =
        `📋 **RDV trouvé — Ligne ${rowIndex}**\n` +
        `👤 Client : **${row[COL.CLIENT] || "N/A"}**\n` +
        `👷 Agent : **${row[COL.AGENT] || "N/A"}**\n` +
        `🏢 Garage : **${row[COL.GARAGE] || "N/A"}**\n` +
        `🚗 Véhicule : **${row[COL.VEHICULE] || "N/A"}**\n` +
        `📅 Date : **${row[COL.DATE_RDV] || "N/A"}** à **${row[COL.HEURE_RDV] || "N/A"}**\n` +
        `📊 Statut actuel : **${row[COL.STATUT] || "—"}**\n\n` +
        `**Que veux-tu faire ?**`;

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("modif_VENU").setLabel("✋ VENU").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("modif_ANNULE").setLabel("❌ ANNULÉ").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("modif_VENDU").setLabel("💰 VENDU").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("modif_SAV").setLabel("🔧 SAV").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("modif_REPORTER").setLabel("📅 REPORTER").setStyle(ButtonStyle.Primary),
      );

      await interaction.editReply({ content: info, components: [row1] });
      return;
    }

    // ══════════════════════════════════════════
    //  Boutons — Action choisie
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith("modif_")) {
      const action = interaction.customId.replace("modif_", "");
      const modif = pendingModif.get(interaction.user.id);

      if (!modif) {
        await interaction.reply({ content: "❌ Session expirée. Relance `/modifier-rdv`.", ephemeral: true });
        return;
      }

      // Cas REPORTER → ouvrir modal date + heure
      if (action === "REPORTER") {
        const modal = new ModalBuilder().setCustomId("reporterForm").setTitle("📅 Reporter le RDV");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("newDate")
              .setLabel("Nouvelle date (JJ/MM/AAAA)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Ex: 20/04/2026")
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("newHeure")
              .setLabel("Nouvelle heure (HH:MM)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Ex: 14:30")
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Cas statut direct : VENU, ANNULÉ, VENDU, SAV
      const labelMap = {
        VENU: "VENU",
        ANNULE: "ANNULÉ",
        VENDU: "VENDU",
        SAV: "SAV",
      };
      const statut = labelMap[action];

      await interaction.deferReply({ ephemeral: true });
      await updateStatut(modif.rowIndex, statut);
      pendingModif.delete(interaction.user.id);

      await interaction.editReply({
        content: `✅ RDV **${modif.idRdv}** mis à jour !\n📊 Statut → **${statut}** (colonne K, ligne ${modif.rowIndex})`,
        components: [],
      });
      return;
    }

    // ══════════════════════════════════════════
    //  Modal — Reporter (nouvelle date + heure)
    // ══════════════════════════════════════════
    if (interaction.isModalSubmit() && interaction.customId === "reporterForm") {
      const newDate = interaction.fields.getTextInputValue("newDate").trim();
      const newHeure = interaction.fields.getTextInputValue("newHeure").trim();
      const modif = pendingModif.get(interaction.user.id);

      if (!modif) {
        await interaction.reply({ content: "❌ Session expirée. Relance `/modifier-rdv`.", ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      await updateDateHeure(modif.rowIndex, newDate, newHeure);
      pendingModif.delete(interaction.user.id);

      await interaction.editReply({
        content:
          `✅ RDV **${modif.idRdv}** reporté !\n` +
          `📅 Nouvelle date → **${newDate}** à **${newHeure}** (colonnes G+H, ligne ${modif.rowIndex})`,
      });
      return;
    }

    // ══════════════════════════════════════════
    //  /rdv — Modal étape 1 soumis
    // ══════════════════════════════════════════
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
        content: "Étape 1 enregistrée. Cliquez pour compléter l'étape 2.",
        components: [new ActionRowBuilder().addComponents(nextBtn)],
        ephemeral: true,
      });
      return;
    }

    // ══════════════════════════════════════════
    //  /rdv — Bouton étape 2
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === "rdvFormNext") {
      if (!pendingData.has(interaction.user.id)) {
        await interaction.reply({ content: "Aucune donnée d'étape 1 trouvée. Recommence avec /rdv.", ephemeral: true });
        return;
      }

      const modal2 = new ModalBuilder().setCustomId("rdvForm2").setTitle("RDV (Étape 2/2)");
      modal2.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("heure").setLabel("Heure").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("date").setLabel("Date").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("rebooking").setLabel("Rebooking").setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("idEvenement").setLabel("ID Événement RDV").setStyle(TextInputStyle.Short).setRequired(false))
      );
      await interaction.showModal(modal2);
      return;
    }

    // ══════════════════════════════════════════
    //  /rdv — Modal étape 2 soumis → enregistrement
    // ══════════════════════════════════════════
    if (interaction.isModalSubmit() && interaction.customId === "rdvForm2") {
      const data1 = pendingData.get(interaction.user.id) || {};
      const data2 = {
        heure: interaction.fields.getTextInputValue("heure"),
        date: interaction.fields.getTextInputValue("date"),
        rebooking: interaction.fields.getTextInputValue("rebooking"),
        idEvenement: interaction.fields.getTextInputValue("idEvenement"),
      };

      const all = { ...data1, ...data2 };
      pendingData.delete(interaction.user.id);

      await interaction.reply({
        content:
          `📋 RDV enregistré:\n` +
          `- Agent: ${all.agent}\n- Garage: ${all.garage}\n- Client: ${all.client}\n` +
          `- Voiture: ${all.voiture}\n- Tel: ${all.tel}\n` +
          `- Date: ${all.date}\n- Heure: ${all.heure}\n- Rebooking: ${all.rebooking || "-"}\n- ID Événement: ${all.idEvenement || "-"}`,
        ephemeral: true,
      });

      saveToSheet(all).catch(err => console.error("❌ Erreur Google Sheets:", err.message));
      return;
    }

  } catch (err) {
    console.error("❌ Erreur interaction:", err);
    if (interaction && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
