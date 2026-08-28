/* FABRIQUER LES DEUX PAQUETS.
 *
 *     node outils/paquet.js
 *
 * Il n'y a rien à COMPILER — c'est tout le parti de cette extension : le dossier
 * `extension/` se charge tel quel dans `about:debugging`. Fabriquer un paquet
 * ne fait donc que deux choses : mettre le dossier dans une archive, et écrire
 * le manifeste que CHAQUE navigateur attend.
 *
 * ---------- POURQUOI DEUX MANIFESTES, ET UN SEUL SOURCE ----------
 *
 * Firefox et Chrome lisent le même Manifest V3, à une clé près :
 * `browser_specific_settings` porte l'identifiant de l'extension et la version
 * minimale de Firefox. Chrome l'ignore, mais son magasin la refuse — et
 * l'ignorer n'est pas la même chose que l'accepter.
 *
 * On ne tient donc PAS deux fichiers à la main : le manifeste de Chrome est
 * DÉRIVÉ de celui de Firefox, à la fabrication, par un retrait. Deux fichiers
 * qu'on maintient côte à côte divergent — c'est la même leçon que le repli vers
 * `chrome`, recopié à quatre endroits et absent de six autres.
 *
 * ---------- CE QUI N'ENTRE PAS DANS LE PAQUET ----------
 *
 * Seul `extension/` est livré. Le banc, le pilote, les relevés, la
 * documentation, les profils Firefox : rien de tout ça n'a affaire chez
 * l'utilisateur, et une extension signée est lue par un relecteur.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RACINE = path.join(__dirname, "..");
const SOURCE = path.join(RACINE, "extension");
const DIST = path.join(RACINE, "dist");
const TRAVAIL = path.join(DIST, "chrome");

function manifeste() {
  return JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
}

/* Une copie récursive, sans dépendance : quatre lignes valent mieux qu'un
 * paquet de plus dans une chaîne d'approvisionnement qu'il faudra surveiller. */
function copie(de, vers) {
  fs.mkdirSync(vers, { recursive: true });
  fs.readdirSync(de, { withFileTypes: true }).forEach(function (e) {
    const a = path.join(de, e.name), b = path.join(vers, e.name);
    if (e.isDirectory()) { copie(a, b); } else { fs.copyFileSync(a, b); }
  });
}

/* PowerShell sait faire une archive, et il est là. On évite ainsi une
 * dépendance de plus pour un geste que le système rend déjà. */
function archive(dossier, cible) {
  try { fs.unlinkSync(cible); } catch (e) {}
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Compress-Archive -Path '" + path.join(dossier, "*") + "' -DestinationPath '" + cible + "' -Force"],
    { stdio: "pipe" });
}

function taille(f) {
  return Math.round(fs.statSync(f).size / 1024) + " Ko";
}

function main() {
  const m = manifeste();
  const v = m.version;
  fs.mkdirSync(DIST, { recursive: true });
  console.log("VTTinker " + v);

  /* ---------- FIREFOX ----------
   *
   * web-ext fabrique l'archive ET la valide au passage : il refuse un manifeste
   * incohérent, une ressource nommée qui n'existe pas, une permission inconnue.
   * C'est le même outil qui signera, donc la même lecture. */
  console.log("\n  ---------- Firefox ----------");
  /* ON APPELLE SON POINT D'ENTRÉE, PAS « npx ». Sous Windows, lancer un « .cmd »
   * par execFile lève EINVAL : Node refuse d'exécuter un script de commandes
   * sans passer par un interpréteur, et passer par l'interpréteur ouvrirait la
   * porte à tout ce qu'une chaîne de commande sait faire d'un argument. Le
   * fichier JavaScript de web-ext, lui, se lance comme n'importe quel autre. */
  const WEBEXT = path.join(RACINE, "node_modules", "web-ext", "bin", "web-ext.js");
  const sortie = execFileSync(process.execPath,
    [WEBEXT, "build", "--source-dir", SOURCE, "--artifacts-dir", DIST,
     "--overwrite-dest", "--filename", "vttinker-" + v + "-firefox.zip"],
    { cwd: RACINE, encoding: "utf8", stdio: "pipe" });
  const ff = path.join(DIST, "vttinker-" + v + "-firefox.zip");
  console.log("  " + path.relative(RACINE, ff) + "   " + taille(ff));
  const avert = (sortie.match(/WARNING/g) || []).length;
  if (avert) { console.log("  " + avert + " avertissement(s) de web-ext — voir ci-dessous"); console.log(sortie.trim()); }

  /* ---------- CHROME ----------
   *
   * Le manifeste dérive de celui de Firefox : on retire la clé qui lui est
   * propre, et RIEN D'AUTRE. Tout écart supplémentaire serait une seconde
   * version du produit, à tenir à jour, donc à faire diverger. */
  console.log("\n  ---------- Chrome ----------");
  fs.rmSync(TRAVAIL, { recursive: true, force: true });
  copie(SOURCE, TRAVAIL);
  const c = manifeste();
  delete c.browser_specific_settings;
  fs.writeFileSync(path.join(TRAVAIL, "manifest.json"), JSON.stringify(c, null, 2) + "\n", "utf8");
  const ch = path.join(DIST, "vttinker-" + v + "-chrome.zip");
  archive(TRAVAIL, ch);
  fs.rmSync(TRAVAIL, { recursive: true, force: true });
  console.log("  " + path.relative(RACINE, ch) + "   " + taille(ch));
  console.log("  (browser_specific_settings retiré — c'est le seul écart)");

  /* ---------- CE QUE L'ON VIENT DE FABRIQUER ---------- */
  console.log("\n  Les deux paquets portent le MÊME code. Le seul écart est une clé");
  console.log("  de manifeste, dérivée à la fabrication et jamais tenue à la main.");
  console.log("\n  Signature Firefox :   node outils/signe.js");
  return 0;
}

process.exit(main());
