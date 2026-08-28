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
 * Firefox et Chrome lisent le même Manifest V3, à deux clés près.
 *
 * `browser_specific_settings` porte l'identifiant de l'extension et la version
 * minimale de Firefox ; Chrome ne la connaît pas.
 *
 * `web_accessible_resources[].matches` n'accepte pas de CHEMIN chez Chrome, qui
 * refuse alors le manifeste entier. Le premier paquet livré ne se chargeait pas
 * pour cette raison. Les deux écarts sont dérivés ici, et le résultat est validé
 * par Chrome lui-même avant qu'un paquet sorte.
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
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"]
  .find(function (p) { return fs.existsSync(p); }) || "";

function manifeste() {
  return JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
}

/* Une copie récursive, sans dépendance : quatre lignes valent mieux qu'un
 * paquet de plus dans une chaîne d'approvisionnement qu'il faudra surveiller.
 *
 * ELLE ÉCARTE CE QUI COMMENCE PAR UN POINT, et ce n'est pas une préférence de
 * rangement. web-ext le fait pour Firefox ; ma copie ne le faisait pas, et le
 * paquet Chrome est parti avec « .amo-upload-uuid » — l'identifiant d'envoi que
 * Mozilla dépose après une signature. Vu en lisant le répertoire central de
 * l'archive, pas en relisant ce code.
 *
 * Le fichier n'était pas secret. Ce qui l'était, c'est ce que le défaut
 * annonçait : un « .git » égaré, un fichier d'échange d'éditeur, une clé posée
 * là un instant — tout serait parti de la même façon, chez tout le monde. */
function copie(de, vers) {
  fs.mkdirSync(vers, { recursive: true });
  fs.readdirSync(de, { withFileTypes: true }).forEach(function (e) {
    if (e.name.charAt(0) === ".") { return; }
    const a = path.join(de, e.name), b = path.join(vers, e.name);
    if (e.isDirectory()) { copie(a, b); } else { fs.copyFileSync(a, b); }
  });
}

/* CE QUE L'ARCHIVE CONTIENT VRAIMENT — lu dans son répertoire central, et non
 * déduit de ce qu'on croit y avoir mis. C'est le seul contrôle qui aurait vu le
 * défaut ci-dessus, et il tourne désormais à chaque fabrication. */
function entrees(f) {
  const b = fs.readFileSync(f);
  const out = [];
  for (let i = 0; i < b.length - 46; i++) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x01 || b[i + 3] !== 0x02) { continue; }
    const n = b.readUInt16LE(i + 28);
    out.push(b.toString("utf8", i + 46, i + 46 + n));
  }
  return out;
}

function controle(f) {
  const l = entrees(f);
  const sales = l.filter(function (x) {
    return /(^|\/)\.[^/]/.test(x) || /node_modules|\.map$/.test(x);
  });
  if (sales.length) {
    console.log("\n  CE PAQUET CONTIENT CE QU'IL NE DEVRAIT PAS :");
    sales.forEach(function (x) { console.log("    " + x); });
    throw new Error("paquet impur : " + path.basename(f));
  }
  return l.length;
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
  console.log("  " + path.relative(RACINE, ff) + "   " + taille(ff) + "   " + controle(ff) + " entrées");
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

  /* 1. La clé propre à Firefox : identifiant et version minimale. */
  delete c.browser_specific_settings;

  /* 2. « web_accessible_resources[].matches » N'ACCEPTE PAS DE CHEMIN CHEZ CHROME.
   *
   * Le manifeste vise « https://app.roll20.net/editor* », ce que Firefox accepte.
   * Chrome refuse le manifeste ENTIER, avec :
   *
   *     Invalid value for 'web_accessible_resources[0]'. Invalid match pattern.
   *
   * Demandé à Chrome lui-même, par --pack-extension, avec témoin :
   *
   *     tel quel .......................... REFUSÉ
   *     matches -> https://app.roll20.net/*  CHARGE
   *     seul content_scripts modifié ...... REFUSÉ   ← la faute n'est pas là
   *
   * On ne perd rien : Chrome IGNORE de toute façon le chemin de ce motif-là. Le
   * chemin reste sur « content_scripts », que Chrome respecte, et c'est lui qui
   * décide où l'extension s'exécute. */
  (c.web_accessible_resources || []).forEach(function (e) {
    e.matches = (e.matches || []).map(function (m) {
      return m.replace(/^([a-z]+:\/\/[^/]+)\/.*$/, "$1/*");
    });
  });

  fs.writeFileSync(path.join(TRAVAIL, "manifest.json"), JSON.stringify(c, null, 2) + "\n", "utf8");
  const ch = path.join(DIST, "vttinker-" + v + "-chrome.zip");
  archive(TRAVAIL, ch);
  fs.rmSync(TRAVAIL, { recursive: true, force: true });
  console.log("  " + path.relative(RACINE, ch) + "   " + taille(ch) + "   " + controle(ch) + " entrées");
  console.log("  (deux écarts : browser_specific_settings retiré, et le chemin ôté");
  console.log("   des « matches » de web_accessible_resources, que Chrome refuse)");

  /* ---------- ET CHROME LE VALIDE LUI-MÊME ----------
   *
   * Le premier paquet Chrome livré ne se chargeait pas. Le manifeste était
   * pourtant du JSON valide, l'archive était propre, et rien ici ne s'en
   * apercevait : on avait vérifié ce qu'on avait mis dedans, jamais si le
   * navigateur visé en voulait.
   *
   * Chrome sait valider un dossier sans qu'on ouvre quoi que ce soit :
   * « --pack-extension » lit le manifeste, refuse ce qui ne va pas, et n'écrit
   * son .crx que s'il l'accepte. C'est le seul contrôle qui aurait vu le défaut,
   * et il tient en dix lignes. */
  if (fs.existsSync(CHROME)) {
    const bac = path.join(DIST, "controle-chrome");
    fs.rmSync(bac, { recursive: true, force: true });
    copie(SOURCE, bac);
    fs.writeFileSync(path.join(bac, "manifest.json"), JSON.stringify(c, null, 2) + "\n", "utf8");
    try { fs.unlinkSync(bac + ".crx"); } catch (e) {}
    try { fs.unlinkSync(bac + ".pem"); } catch (e) {}
    let dit = "";
    try {
      execFileSync(CHROME, ["--pack-extension=" + bac, "--no-message-box"],
        { encoding: "utf8", stdio: "pipe", timeout: 120000 });
    } catch (e) { dit = String((e.stdout || "") + (e.stderr || "")); }
    const accepte = fs.existsSync(bac + ".crx");
    fs.rmSync(bac, { recursive: true, force: true });
    try { fs.unlinkSync(bac + ".crx"); } catch (e) {}
    try { fs.unlinkSync(bac + ".pem"); } catch (e) {}
    if (!accepte) {
      console.log("\n  CHROME REFUSE CE MANIFESTE :");
      dit.split(/\r?\n/).filter(function (l) { return /Invalid|manifest/i.test(l); })
         .slice(0, 3).forEach(function (l) { console.log("    " + l.replace(/^\[[^\]]*\]\s*/, "")); });
      throw new Error("manifeste refusé par Chrome");
    }
    console.log("  Chrome accepte ce manifeste (validé par --pack-extension)");
  } else {
    console.log("  Chrome absent du poste : le manifeste n'a PAS été validé par lui.");
  }

  /* ---------- CE QUE L'ON VIENT DE FABRIQUER ---------- */
  console.log("\n  Les deux paquets portent le MÊME code. Les écarts sont deux clés");
  console.log("  de manifeste, dérivées à la fabrication et jamais tenues à la main.");
  console.log("\n  Signature Firefox :   node outils/signe.js");
  return 0;
}

process.exit(main());
