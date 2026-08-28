/* LE NOM DE L'API D'EXTENSION, ET IL N'EST PAS LE MÊME PARTOUT.
 *
 * Firefox expose `browser`, avec des promesses. Chrome expose `chrome`, et
 * depuis Manifest V3 ses méthodes rendent elles aussi des promesses quand on
 * n'y passe pas de rappel. Les deux sont donc interchangeables pour ce que
 * cette extension emploie — `storage.local`, `runtime.getURL`,
 * `runtime.getManifest`, `storage.onChanged` — et un simple repli suffit.
 *
 * ---------- POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST PREMIER ----------
 *
 * Le repli était recopié dans quatre fichiers et absent des six autres. Ça
 * marchait — mais par ACCIDENT : les six qui en manquaient sont chargés APRÈS
 * l'un des quatre, et un `var` au premier niveau d'un script de contenu vaut
 * pour tout le monde isolé. Autrement dit, la compatibilité avec Chrome tenait
 * à l'ordre du manifeste, sans que rien ne le dise ni ne le vérifie.
 *
 * Réordonner deux lignes du manifeste aurait suffi à la casser, et le défaut ne
 * se serait vu que sur Chrome, à l'exécution, sous la forme d'un
 * `ReferenceError: browser is not defined` dans une console que personne
 * n'ouvre.
 *
 * Ce fichier est donc chargé EN PREMIER, partout : par les scripts de contenu,
 * par la page du panneau et par celle de la fenêtre. Il ne fait que ça.
 *
 * ---------- CE QU'IL NE FAIT PAS ----------
 *
 * Il ne dit rien du monde de la PAGE. Le pont, injecté dans le monde principal
 * de Roll20, n'a accès NI à `browser` NI à `chrome` — c'est la frontière même
 * des deux mondes, et c'est pour ça qu'il reçoit tout par messages. Les trois
 * mentions de `browser` qu'on y lit sont des commentaires qui expliquent
 * précisément cette impossibilité.
 */
"use strict";

/* eslint-disable no-var */
if (typeof browser === "undefined" && typeof chrome !== "undefined") {
  /* `var` et non `const` : il faut que le nom existe pour les fichiers chargés
   * ensuite, et une déclaration de bloc ne sortirait pas de ce fichier. */
  var browser = chrome;
}
