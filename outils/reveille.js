/* RALLUMER L'EXTENSION DANS LE PROFIL DU PILOTE.
 *
 * POURQUOI CE FICHIER EXISTE. Le pilote tient un profil Firefox À LUI, qui
 * survit d'une session à l'autre — c'est ce qui évite de se reconnecter à
 * Roll20 vingt fois par jour. Mais le stockage de l'extension y survit aussi.
 *
 * Une sonde a éprouvé l'interrupteur général, l'a laissé sur ÉTEINT, et le
 * passage suivant a trouvé une extension muette. Il n'y avait plus aucun chemin
 * pour la rallumer : le panneau ne s'affiche que par un bouton que l'extension
 * éteinte ne pose pas, et Firefox piloté refuse de naviguer vers une page
 * moz-extension. La seule porte restante est le disque.
 *
 * CE SCRIPT EFFACE LE STOCKAGE DE L'EXTENSION, ET RIEN D'AUTRE. Les réglages
 * repartent à leurs défauts — allumée, anglais, thème automatique —, ce qui est
 * exactement l'état d'une installation neuve, donc celui qu'une sonde devrait
 * toujours trouver. Les cookies de Roll20, eux, sont ailleurs et ne sont pas
 * touchés : la connexion tient.
 *
 *     node outils/reveille.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PROFIL = path.join(__dirname, ".profil");
const STOCKAGE = path.join(PROFIL, "storage", "default");

/* Le nôtre se reconnaît à son identifiant, celui que le manifeste déclare et
 * que le pilote impose au chargement. Les autres dossiers moz-extension du
 * profil appartiennent aux extensions internes de Firefox : on n'y touche
 * pas. */
const NOTRE_UUID = "7b1f0a2c-4d3e-4a5b-8c6d-9e0f1a2b3c4d";

if (!fs.existsSync(STOCKAGE)) {
  console.log("Pas de profil de pilote : rien à réveiller.");
  process.exit(0);
}

const cibles = fs.readdirSync(STOCKAGE)
  .filter(function (n) { return n.indexOf("moz-extension+++" + NOTRE_UUID) === 0; });

if (!cibles.length) {
  console.log("Le stockage de l'extension est déjà vide.");
  process.exit(0);
}

cibles.forEach(function (n) {
  const p = path.join(STOCKAGE, n);
  fs.rmSync(p, { recursive: true, force: true });
  console.log("  effacé : " + n);
});
console.log("L'extension repart à ses défauts : allumée, anglais, thème automatique.");
