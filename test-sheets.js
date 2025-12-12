// --- Charger les variables d'environnement ---
require("dotenv").config();
const { google } = require("googleapis");

// --- Logs de démarrage ---
console.log("🚀 Script test-sheets.js lancé !");

// --- Authentification Google ---
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json", // ton fichier de service account
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// --- Fonction principale ---
async function testWrite() {
  try {
    console.log("🔑 Authentification…");
    const client = await auth.getClient();
    console.log("✅ Auth OK");

    const sheets = google.sheets({ version: "v4", auth: client });
    console.log("📄 Connexion à la feuille…");

    const spreadsheetId = "1VFTJUZzoSp4xNXxourEtAmaY9eHKmwK90RiUs6KfsZI"; // ton ID de feuille

    // --- Écriture test ---
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Feuille1!A1", // adapte si ton onglet s'appelle autrement
      valueInputOption: "RAW",
      requestBody: {
        values: [["✅ Test Sheets OK", new Date().toLocaleString()]],
      },
    });

    console.log("✅ Ligne test envoyée !");
    console.log("Réponse API:", res.status, res.statusText);
  } catch (err) {
    console.error("❌ Erreur test-sheets.js:", err);
  }
}

// --- Lancer la fonction ---
testWrite();

// --- Capture des erreurs globales ---
process.on("uncaughtException", err => {
  console.error("💥 Erreur non capturée:", err);
});
process.on("unhandledRejection", err => {
  console.error("💥 Promesse rejetée:", err);
});
