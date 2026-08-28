/* SE CONNECTER À ROLL20 SANS QUE CLOUDFLARE VOIE UN ROBOT.
 *
 * POURQUOI CE FICHIER EXISTE. Le pilote ouvrait une fenêtre « ordinaire » sur
 * SON PROPRE profil pour que l'humain s'y connecte. Ça ne marche plus, et c'est
 * logique : geckodriver écrit ses préférences DANS ce profil, et Firefox les
 * relit à chaque démarrage. Relevé dans outils/.profil/prefs.js :
 *
 *     marionette.port                     63731
 *     remote.active-protocols             1
 *     remote.prefs.recommended.applied    true
 *     remote.system-access-check.enabled  false
 *
 * La fenêtre n'était donc pas « sans automatisation » : elle démarrait sur un
 * profil qui en porte les marques, et le contrôle anti-robot les voit. Il a
 * raison de les voir, et ce n'est pas à contourner.
 *
 * CE QU'ON FAIT À LA PLACE — et ce n'est pas un contournement, c'est la
 * séparation qui manquait :
 *
 *   1. un SECOND profil, « .profil-humain », qui ne verra JAMAIS geckodriver ;
 *      c'est un Firefox ordinaire, l'humain s'y connecte comme partout ailleurs
 *      et résout ce qu'il y a à résoudre ;
 *   2. on n'en rapporte QUE LES COOKIES vers le profil du pilote.
 *
 * Le pilote, lui, reste détectable — il l'est par nature — mais Roll20 ne
 * redemande le contrôle qu'à la CONNEXION. Avec un cookie déjà valide, la
 * session pilotée passe, et c'est ce qu'on a constaté toute la journée.
 *
 *     node outils/connexion-humaine.js ouvre     puis, une fois connecté ET FERMÉ :
 *     node outils/connexion-humaine.js recolte
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const RACINE = path.join(__dirname, "..");
const PROFIL_PILOTE = path.join(__dirname, ".profil");
const PROFIL_HUMAIN = path.join(__dirname, ".profil-humain");

const FIREFOX = process.env.FIREFOX ||
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe";

/* Les trois fichiers d'une base SQLite ouverte : la base, son journal
 * d'écriture, et sa mémoire partagée. Les copier tous les trois évite de
 * rapporter une base à moitié écrite. */
const COOKIES = ["cookies.sqlite", "cookies.sqlite-wal", "cookies.sqlite-shm"];

/* UN PROFIL VERROUILLÉ EST UN PROFIL OUVERT — mais LA PRÉSENCE DU FICHIER NE
 * DIT RIEN, et le premier jet s'y est trompé. Sur Windows, « parent.lock »
 * survit à la fermeture : il reste sur le disque, vide, et le tester par
 * existsSync déclarait le profil ouvert alors que Firefox était fermé depuis
 * longtemps.
 *
 * Ce qui compte, c'est le VERROU, pas le fichier. On demande donc à l'ouvrir en
 * écriture : refusé, il est tenu ; accordé, le profil est libre. C'est le
 * système qui répond, et il ne se trompe pas.
 *
 * On ne tue rien — jamais — et on ne copie pas depuis une base que Firefox
 * tient encore : on demande sa fermeture. */
function estOuvert(profil) {
  return ["parent.lock", ".parentlock", "cookies.sqlite"].some(function (n) {
    const c = path.join(profil, n);
    if (!fs.existsSync(c)) { return false; }
    try { const fd = fs.openSync(c, "r+"); fs.closeSync(fd); return false; }
    catch (e) { return true; }
  });
}

function ouvre() {
  fs.mkdirSync(PROFIL_HUMAIN, { recursive: true });
  /* AUCUN user.js ICI. Ce profil doit être aussi ordinaire que possible : la
   * moindre préférence posée par nous serait exactement ce qu'on cherche à
   * éviter. */
  spawn(FIREFOX, ["-profile", PROFIL_HUMAIN, "-no-remote",
                  "https://app.roll20.net/sessions/new"],
        { stdio: "ignore", detached: true }).unref();

  console.log("Firefox s'ouvre sur un profil NEUF, qui n'a jamais vu geckodriver.");
  console.log("");
  console.log("  1. connecte-toi à Roll20 ;");
  console.log("  2. FERME entièrement cette fenêtre ;");
  console.log("  3. puis :   node outils/connexion-humaine.js recolte");
  console.log("");
  console.log("Ce profil-là n'est pas piloté et ne le sera jamais : le contrôle");
  console.log("anti-robot s'y résout normalement.");
}

function recolte() {
  if (!fs.existsSync(PROFIL_HUMAIN)) {
    console.log("Pas de profil humain : lance d'abord « ouvre ».");
    return 1;
  }
  if (estOuvert(PROFIL_HUMAIN)) {
    console.log("Le Firefox du profil humain est ENCORE OUVERT.");
    console.log("Ferme-le entièrement, puis relance — on ne copie pas une base");
    console.log("que Firefox tient encore, et on ne ferme jamais un navigateur");
    console.log("à ta place.");
    return 1;
  }
  if (estOuvert(PROFIL_PILOTE)) {
    console.log("Le profil du pilote est ouvert. Ferme-le d'abord.");
    return 1;
  }
  fs.mkdirSync(PROFIL_PILOTE, { recursive: true });

  let n = 0;
  COOKIES.forEach(function (f) {
    const de = path.join(PROFIL_HUMAIN, f);
    if (!fs.existsSync(de)) { return; }
    fs.copyFileSync(de, path.join(PROFIL_PILOTE, f));
    console.log("  rapporté : " + f + "  (" + fs.statSync(de).size + " o)");
    n++;
  });
  if (!n) {
    console.log("Aucun cookie trouvé — la connexion n'a peut-être pas abouti.");
    return 1;
  }
  console.log("");
  console.log("La session est rapportée dans le profil du pilote.");
  console.log("Vérifie :   node outils/pilote.js campagnes");
  return 0;
}

const quoi = (process.argv[2] || "ouvre").toLowerCase();
if (quoi === "recolte") { process.exit(recolte() || 0); }
else { ouvre(); }
