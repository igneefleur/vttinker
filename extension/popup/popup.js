/* LA FENÊTRE DE L'EXTENSION.
 *
 * ELLE NE FAIT PLUS CE QUE FAIT LE PANNEAU. Les deux surfaces montraient la
 * même chose — c'était le même fichier HTML, chargé une fois dans la fenêtre du
 * navigateur et une fois dans une iframe posée sur la partie —, si bien qu'il y
 * avait deux endroits pour un seul geste et aucun des deux n'était le bon.
 *
 * La séparation est celle-ci :
 *   · ICI, on dit si l'extension EXISTE, et dans quelle langue elle parle.
 *   · DANS LA PARTIE, on dit ce qu'elle FAIT — quel module, quels réglages.
 *
 * browser.storage.local suffit à tout : chaque onglet Roll20 ouvert écoute
 * storage.onChanged et se met à jour de lui-même, tous en même temps. L'
 * extension ne demande donc que « storage », et rien de plus.
 */
/* Le repli vers « chrome » vit dans commun/000-navigateur.js, chargé avant
 * tout le reste. Une règle recopiée à cinq endroits est une règle qui
 * diverge : celle-ci tenait à l'ordre du manifeste, sans que rien ne le dise. */

(function () {
  "use strict";

  var etat = {};

  function ecris(cle, val) {
    etat[cle] = val;
    var o = {};
    o[cle] = val;
    try { browser.storage.local.set(o); } catch (e) {}
  }

  function mot(cle) { return vttMot(cle, vttLangueDe(etat)); }

  /* ---------- LE DESSIN ----------
   * Les nœuds existent déjà dans le HTML : on ne fabrique rien, on remplit. Une
   * fenêtre de quatre lignes n'a pas besoin d'un moteur de rendu, et un
   * document déjà écrit s'affiche sans attendre le script. */
  /* ---------- LE THÈME ----------
   *
   * DANS CETTE FENÊTRE, « automatique » VEUT DIRE LE NAVIGATEUR. Il n'y a pas
   * de Roll20 derrière une fenêtre de navigateur : la seule préférence qui
   * existe ici est celle du système, et la feuille sait déjà la lire
   * (prefers-color-scheme). On ne pose donc AUCUN attribut dans ce cas — poser
   * « jour » ou « nuit » empêcherait justement la préférence de décider.
   *
   * Dans le PANNEAU, le même mot veut dire autre chose : Roll20. Voir
   * panneau.js. */
  function poseTheme() {
    var t = vttThemeDe(etat);
    if (t === "auto") { document.documentElement.removeAttribute("data-theme"); }
    else { document.documentElement.setAttribute("data-theme", t); }
  }

  function peint() {
    poseTheme();
    document.getElementById("mot-langue").textContent = mot("app.langue");
    document.getElementById("mot-theme").textContent = mot("app.theme");

    var b = document.getElementById("actif");
    b.checked = vttActif(etat);
    b.setAttribute("aria-label", mot("app.etat"));

    var sel = document.getElementById("langue");
    /* On regarde les ENFANTS, et non « options » : c'est ce que les deux
     * ont en commun, et le banc n'a pas à réimplémenter une collection
     * HTMLOptions pour vérifier qu'on remplit une liste une seule fois. */
    if (!sel.children.length) {
      VTT_LANGUES.forEach(function (l) {
        var o = document.createElement("option");
        o.value = l;
        /* LE NOM DE CHAQUE LANGUE DANS SA PROPRE LANGUE. « French » écrit en
         * anglais ne se trouve pas quand on ne lit que le français, et c'est
         * précisément la situation de quelqu'un qui cherche ce sélecteur. */
        o.textContent = VTT_LANGUE_NOMS[l] || l;
        sel.appendChild(o);
      });
    }
    sel.value = vttLangueDe(etat);

    var th = document.getElementById("theme");
    if (!th.children.length) {
      VTT_THEMES.forEach(function (t) {
        var o = document.createElement("option");
        o.value = t;
        th.appendChild(o);
      });
    }
    /* Les intitulés se réécrivent à chaque peinture, et pas seulement à la
     * création : changer de langue doit renommer « Automatique » en
     * « Automatic », options comprises. */
    [].slice.call(th.children).forEach(function (o) { o.textContent = mot("theme." + o.value); });
    th.value = vttThemeDe(etat);

    var site = document.getElementById("site");
    var soutien = document.getElementById("soutien");
    site.textContent = mot("app.site");
    soutien.textContent = mot("app.soutien");
    /* LES DEUX BOUTONS SONT PRÉPARÉS ET N'OUVRENT RIEN — c'est ce qui a été
     * demandé. Ils sont donc DÉSACTIVÉS, et leur infobulle le dit : un bouton
     * qui ne fait rien quand on le presse est pire qu'un bouton absent, on s'y
     * reprend à trois fois avant de comprendre qu'il n'y a rien à comprendre. */
    site.title = mot("app.site") + " — " + mot("app.bientot");
    soutien.title = mot("app.soutien") + " — " + mot("app.bientot");
  }

  function version() {
    var v = "";
    try { v = browser.runtime.getManifest().version; } catch (e) {}
    document.getElementById("version").textContent = v ? "v" + v : "";
  }

  /* ON VISE LE NŒUD, ET NON « this ». Un écouteur n'est pas toujours appelé avec
   * l'élément pour contexte — il ne l'est pas dans le banc d'essai —, alors que
   * le nœud, lui, est déjà là, capturé une fois. */
  function branche() {
    var inter = document.getElementById("actif");
    inter.addEventListener("change", function () {
      ecris("reg:actif", inter.checked);
    });
    var sel = document.getElementById("langue");
    sel.addEventListener("change", function () {
      ecris("reg:langue", vttLangueValide(sel.value));
      peint();   // la fenêtre elle-même change de langue, sur-le-champ
    });
    var th = document.getElementById("theme");
    th.addEventListener("change", function () {
      ecris("reg:theme", vttThemeValide(th.value));
      peint();   // et de thème, de même
    });
  }

  /* UNE SEULE LECTURE, puis on dessine. Trois lectures, ce seraient trois
   * instants, donc trois occasions de se contredire à l'écran. */
  function lis() {
    var def = vttDefauts();
    function recu(r) {
      Object.keys(def).forEach(function (k) {
        etat[k] = (r && r[k] !== undefined) ? r[k] : def[k];
      });
      version();
      peint();
      branche();
    }
    // Un rejet du stockage donne les défauts, jamais le silence : une extension
    // fraîchement installée doit fonctionner, et une extension dont le stockage
    // répond mal ne doit pas disparaître sans un mot.
    try { browser.storage.local.get(vttCles()).then(recu, function () { recu(null); }); }
    catch (e) { recu(null); }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", lis);
  } else { lis(); }
})();
