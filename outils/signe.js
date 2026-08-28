/* SIGNER L'EXTENSION CHEZ MOZILLA.
 *
 *     node outils/signe.js
 *
 * ---------- POURQUOI UNE SIGNATURE ----------
 *
 * Depuis Firefox 48, une extension non signée ne s'installe PAS dans un Firefox
 * ordinaire. `about:debugging` sait charger un dossier tel quel, mais c'est un
 * module TEMPORAIRE : il disparaît à la fermeture du navigateur. Pour qu'une
 * extension s'installe et reste, il faut un `.xpi` signé par Mozilla.
 *
 * ---------- LES DEUX VOIES, ET CELLE QU'ON PREND ----------
 *
 * · « listed »   : l'extension est publiée sur addons.mozilla.org, avec une
 *                  page, une revue humaine, et des mises à jour automatiques.
 * · « unlisted » : Mozilla signe le paquet et le rend, sans le publier. On le
 *                  distribue soi-même. La revue est automatique, la signature
 *                  arrive en quelques minutes, et Firefox l'installe comme
 *                  n'importe quelle autre.
 *
 * On prend « unlisted » : le paquet est distribué depuis les pages du dépôt.
 * `--channel=listed` reste possible le jour où l'on voudra le magasin.
 *
 * ---------- LES IDENTIFIANTS ----------
 *
 * Ils se prennent une fois sur
 *     https://addons.mozilla.org/developers/addon/api/key/
 * et se rangent dans `outils/config.json`, que .gitignore couvre déjà :
 *
 *     "amo": { "cle": "user:12345678:123", "secret": "…" }
 *
 * ILS NE DOIVENT ENTRER DANS AUCUN FICHIER VERSIONNÉ. Ce sont des identifiants
 * personnels : qui les a peut signer N'IMPORTE QUOI au nom de leur auteur, et
 * Firefox l'installera sans un mot. C'est la même prudence que pour les
 * identifiants de campagne, avec une conséquence bien pire.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RACINE = path.join(__dirname, "..");
const SOURCE = path.join(RACINE, "extension");
const DIST = path.join(RACINE, "dist");
const CONFIG = path.join(__dirname, "config.json");
const WEBEXT = path.join(RACINE, "node_modules", "web-ext", "bin", "web-ext.js");

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { return {}; }
}

function manque() {
  console.log("Aucun identifiant AMO dans outils/config.json.");
  console.log("");
  console.log("  1. Ouvre  https://addons.mozilla.org/developers/addon/api/key/");
  console.log("  2. Génère une paire, puis ajoute dans outils/config.json :");
  console.log("");
  console.log('       "amo": { "cle": "user:00000000:000", "secret": "…" }');
  console.log("");
  console.log("  Ce fichier est ignoré par git : les identifiants ne partiront nulle part.");
  console.log("  Ils permettent de signer AU NOM de leur auteur — ils valent une clé.");
  return 1;
}

function main() {
  const c = config().amo || {};
  if (!c.cle || !c.secret) { return manque(); }

  const m = JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
  const id = (m.browser_specific_settings || {}).gecko || {};
  console.log("VTTinker " + m.version + "   identifiant " + (id.id || "(aucun)"));
  if (!id.id) {
    console.log("\n  Le manifeste ne déclare pas d'identifiant. Mozilla en attribuerait un au");
    console.log("  hasard, et la mise à jour suivante serait considérée comme une AUTRE");
    console.log("  extension. On s'arrête ici.");
    return 1;
  }

  fs.mkdirSync(DIST, { recursive: true });
  console.log("\n  Envoi à Mozilla, et attente de la signature.");
  console.log("  (quelques minutes ; la revue est automatique en « unlisted »)\n");

  try {
    execFileSync(process.execPath,
      [WEBEXT, "sign",
       "--source-dir", SOURCE,
       "--artifacts-dir", DIST,
       "--channel", "unlisted",
       "--api-key", c.cle,
       "--api-secret", c.secret],
      { cwd: RACINE, stdio: "inherit" });
  } catch (e) {
    console.log("\n  La signature a échoué. Les causes ordinaires, dans l'ordre :");
    console.log("    · un numéro de version déjà signé — Mozilla refuse deux fois le même ;");
    console.log("    · des identifiants périmés ou révoqués ;");
    console.log("    · une règle du manifeste refusée par la validation automatique.");
    console.log("  Le message ci-dessus dit lequel des trois.");
    return 1;
  }

  const xpi = fs.readdirSync(DIST).filter(function (f) { return /\.xpi$/.test(f); });
  if (!xpi.length) {
    console.log("\n  Mozilla n'a rendu aucun .xpi. Rien n'est signé.");
    return 1;
  }
  xpi.forEach(function (f) {
    const t = Math.round(fs.statSync(path.join(DIST, f)).size / 1024);
    console.log("\n  signé : dist/" + f + "   " + t + " Ko");
  });
  console.log("\n  Il s'installe d'un clic depuis les pages du dépôt, et Firefox le garde.");
  return 0;
}

process.exit(main());
