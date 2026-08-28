/* FERMER CE QUE LE PILOTE A LAISSÉ DERRIÈRE LUI — ET RIEN D'AUTRE.
 *
 * POURQUOI CE FICHIER EXISTE. Une commande `taskkill /F /IM firefox.exe` a été
 * lancée pour nettoyer un geckodriver resté en vol : elle a fermé TOUTES les
 * fenêtres Firefox de la machine, dont celles de l'auteur, qui travaillait
 * dedans. Une extension nommée par son image ne distingue pas le navigateur
 * piloté du navigateur de quelqu'un.
 *
 * CE SCRIPT NE PEUT PAS COMMETTRE CETTE ERREUR. Il ne connaît qu'un seul nom de
 * processus — geckodriver.exe, le serveur WebDriver, qui n'appartient jamais à
 * personne d'autre — et il REFUSE tout le reste, y compris si on le lui demande.
 * Le refus est dans le code, pas dans une consigne.
 *
 * Les Firefox pilotés, eux, meurent avec leur geckodriver ou avec le
 * `driver.quit()` de la sonde. On ne les vise jamais par leur nom : sur cette
 * machine, `tasklist` ne donne pas la ligne de commande, donc rien ne permet de
 * distinguer à coup sûr celui du pilote de ceux de l'auteur.
 *
 *     node outils/ferme-pilote.js
 */
"use strict";

const { execFileSync } = require("child_process");

/* La seule image qu'on s'autorise. Toute autre valeur est une erreur du
 * programme, pas une option de l'utilisateur. */
const AUTORISE = "geckodriver.exe";
const INTERDIT = /firefox/i;

function processus(image) {
  let brut = "";
  try {
    brut = execFileSync("tasklist", ["/FI", "IMAGENAME eq " + image, "/FO", "CSV", "/NH"],
      { encoding: "utf8" });
  } catch (e) { return []; }
  return brut.split(/\r?\n/)
    .map(function (l) { return l.match(/^"([^"]+)","(\d+)"/); })
    .filter(Boolean)
    .map(function (m) { return { nom: m[1], pid: parseInt(m[2], 10) }; });
}

function ferme(image) {
  /* LE GARDE-FOU EST ICI, et il est catégorique. */
  if (image !== AUTORISE) {
    throw new Error("ferme-pilote ne ferme que " + AUTORISE + " — jamais « " + image + " »");
  }
  if (INTERDIT.test(image)) {
    throw new Error("ferme-pilote ne touchera jamais à un navigateur");
  }

  const liste = processus(image);
  if (!liste.length) { console.log("  aucun " + image + " en vol"); return 0; }

  let fermes = 0;
  liste.forEach(function (p) {
    /* On revérifie le nom du processus LU, pas celui demandé : c'est la dernière
     * chose qui sépare une erreur de frappe d'un accident. */
    if (INTERDIT.test(p.nom) || p.nom !== AUTORISE) {
      console.log("  refusé : « " + p.nom + " » (" + p.pid + ")");
      return;
    }
    try { process.kill(p.pid); fermes++; console.log("  fermé : " + p.nom + " (" + p.pid + ")"); }
    catch (e) { console.log("  déjà parti : " + p.pid); }
  });
  return fermes;
}

const nFirefox = processus("firefox.exe").length;
console.log("Fermeture de ce que le pilote a laissé.");
console.log("  Firefox sur la machine : " + nFirefox + " — on n'y touche pas.");
ferme(AUTORISE);
