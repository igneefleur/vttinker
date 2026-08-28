/* LE DÉMARRAGE — chargé en dernier, et c'est le seul fichier qui AGIT.
 *
 * Il lit le stockage une fois, décide qui a le droit de tourner dans cette
 * frame, et lance. Un module éteint n'est jamais appelé, donc ne pose ni
 * écouteur ni noeud : éteindre veut dire quelque chose.
 *
 * CE QU'ÉTEINDRE PEUT ET NE PEUT PAS. Sur une page ouverte ENSUITE, un module
 * éteint ne se réveille pas du tout. Sur une partie DÉJÀ ouverte, un module qui
 * tourne continue : le pont posé dans le monde principal ne se retire pas
 * (aucun script de contenu ne l'atteint, et sa balise s'est effacée toute
 * seule), et les écouteurs déjà posés sont des fonctions anonymes que
 * removeEventListener ne sait pas viser. Un module qui a besoin de savoir se
 * démonter le déclarera lui-même ; en attendant, la promesse tenable est
 * « au rechargement de la partie », comme chez uBlock.
 *
 * UNE SEULE LECTURE pour tous les réglages : trois lectures, ce seraient trois
 * instants, donc trois occasions de se contredire.
 */
/* Le repli vers « chrome » vit dans commun/000-navigateur.js, chargé avant
 * tout le reste. Une règle recopiée à cinq endroits est une règle qui
 * diverge : celle-ci tenait à l'ordre du manifeste, sans que rien ne le dise. */

(function () {
  "use strict";

  var VTT = window.VTT;
  if (!VTT) { return; }   // socle absent : rien à démarrer, et rien à dire

  // Verrou de frame : si l'extension était rechargée pendant qu'une partie est
  // ouverte, deux jeux de scripts de contenu se retrouveraient dans le même
  // monde isolé, et chaque ordre partirait en double.
  try {
    if (window.__vttinker) { return; }
    window.__vttinker = true;
  } catch (e) {}

  function porteeOK(mod) {
    switch (mod.portee) {
      case "editeur": return VTT.frame.editeur;
      case "popout":  return VTT.frame.popout;
      case "top":     return VTT.frame.top;
      default:        return true;   // sans portée déclarée : partout
    }
  }

  /* Lancer UN module. Le même chemin sert au chargement de la partie et à un
   * rallumage en cours de route : deux chemins finiraient par ne plus faire la
   * même chose, et c'est toujours le second qui se met à mentir. */
  function lance(mod) {
    if (!porteeOK(mod)) { return false; }
    if (VTT._demarres()[mod.id]) { return true; }
    try {
      mod.demarre(VTT);
      VTT._noteDemarre(mod);
      return true;
    } catch (e) {
      // Un module qui tombe ne doit emporter ni les autres, ni Roll20.
      VTT.log("module « " + mod.id + " » : échec au démarrage", e);
      return false;
    }
  }

  function demarre(etat) {
    VTT.reglages = etat;

    /* L'INTERRUPTEUR GÉNÉRAL PASSE AVANT TOUT LE RESTE.
     *
     * Il est dans la fenêtre de l'extension, pas dans la partie : la fenêtre du
     * navigateur dit si l'extension EXISTE, la boîte à outils dit ce qu'elle
     * FAIT. Éteinte, aucun module ne démarre — donc aucun écouteur, aucun nœud,
     * aucun pont injecté, et pas de bouton dans la boîte à outils. Il n'y a
     * rien à régler pour une extension qui ne tourne pas.
     *
     * On le dit quand même au journal : une extension qui ne fait rien et qui
     * ne dit pas pourquoi est indiscernable d'une extension cassée. */
    if (!vttActif(etat)) {
      try {
        var mfe = browser.runtime.getManifest();
        VTT.log("vttinker " + mfe.version + " — éteint (interrupteur général)");
      } catch (e) {}
      return;
    }

    /* LA VERSION, DITE À VOIX HAUTE, ET DÈS LA PREMIÈRE LIGNE.
     *
     * Une capture d'écran ne dit pas quelle version l'a produite. On a passé une
     * session entière à mesurer un défaut sur une trame que huit contrôles
     * disaient juste, sans pouvoir écarter l'hypothèse la plus simple : que
     * l'extension chargée n'était pas celle qu'on corrigeait. Cette ligne coûte
     * un appel et clôt la question pour toujours. */
    try {
      var mf = browser.runtime.getManifest();
      VTT.log("vttinker " + mf.version + " — modules : " +
        VTT._modules().map(function (m) {
          return m.id + (etat["mod:" + m.id] === false ? " (éteint)" : "");
        }).join(", "));
    } catch (e) {}

    VTT._modules().forEach(function (mod) {
      if (etat["mod:" + mod.id] === false) { return; }
      lance(mod);
    });

    /* LES MOTS DU PONT PARTENT APRÈS LES MODULES, et c'est l'ordre qui compte :
     * c'est un module qui injecte le pont, et un message envoyé avant qu'il
     * existe se perd. Envoyé après, il arrive — et s'il n'y a pas de pont,
     * parce qu'aucun module n'en avait besoin, il ne coûte rien. */
    try { VTT.versPage({ type: "langue", mots: VTT.motsDuPont() }); } catch (e) {}

    /* LE POPUP NE PEUT PAS SAVOIR SI L'ONGLET COURANT EST UNE PARTIE : le lire
     * demanderait la permission « tabs », c'est-à-dire l'accès à l'historique,
     * pour un simple message. On laisse donc ici une trace, la seule que le
     * popup ait le droit de lire, et il ne s'en sert que pour dire « l'extension
     * ne s'est encore jamais réveillée sur une partie ». */
    if (VTT.frame.editeur) {
      try { browser.storage.local.set({ _vuEditeur: Date.now() }); } catch (e) {}
    }
  }

  /* Un réglage changé s'applique à chaud, dans tous les onglets Roll20 ouverts
   * en même temps : le popup n'écrit que le stockage, et c'est le stockage qui
   * prévient. Aucun message, aucune permission de plus.
   *
   * L'INTERRUPTEUR MARCHE DANS LES DEUX SENS.
   *   - ÉTEINT : le module est prévenu, s'il sait l'être. Il a peut-être laissé
   *     la page dans un état dont elle ne sait plus sortir seule, et lui seul
   *     sait le défaire — le zoom, par exemple, a pu emmener la vue à 600 % là
   *     où Roll20 ne sait pas aller.
   *   - RALLUMÉ : il redémarre, sur-le-champ. On avait d'abord décidé le
   *     contraire, en attendant un rechargement de la partie. C'était défendable
   *     pour un module qui aurait démonté la moitié de l'interface, et faux pour
   *     tous les autres : éteindre puis rallumer faisait disparaître la commande
   *     de zoom DÉFINITIVEMENT, sans que rien ne l'explique. Un interrupteur qui
   *     ne rallume pas n'est pas un interrupteur.
   *
   * Un module qui ne SAIT pas redémarrer le dit, par « relance: false ». Aucun
   * ne le fait aujourd'hui, et ce sera à celui-là de le justifier. */
  function ecoute() {
    try {
      browser.storage.onChanged.addListener(function (ch, zone) {
        if (zone && zone !== "local") { return; }
        ch = ch || {};
        var vivants = VTT._demarres();

        /* ---------- L'INTERRUPTEUR GÉNÉRAL, À CHAUD ----------
         *
         * ÉTEINT : on arrête tout ce qui tourne, un par un, par le même chemin
         * qu'un module éteint à la main. Rallumé : on relance ce que le
         * stockage dit d'allumer. Sans ça, l'interrupteur ne ferait rien tant
         * que la partie n'aurait pas été rechargée — et un interrupteur qui ne
         * commute qu'au prochain démarrage n'est pas un interrupteur. */
        if (ch["reg:actif"]) {
          VTT.reglages["reg:actif"] = ch["reg:actif"].newValue;
          if (ch["reg:actif"].newValue === false) {
            Object.keys(vivants).forEach(function (id) {
              var m = vivants[id];
              if (typeof m.arrete === "function") {
                try { m.arrete.call(m); } catch (e) { VTT.log("module « " + id + " » : échec à l'arrêt", e); }
              }
              VTT._oublie(id);
            });
            /* ET ON LE DIT AU PONT. Il porte des pièces qu'aucun module n'a
             * posées — le bouton VTTK, son intitulé de section, le panneau —,
             * qu'éteindre les modules un par un ne peut donc pas emporter. */
            try { VTT.versPage({ type: "vttk", actif: false }); } catch (e) {}
            VTT.log("vttinker éteint (interrupteur général)");
            return;
          }
          VTT._modules().forEach(function (mod) {
            if (VTT.reglages["mod:" + mod.id] === false) { return; }
            lance(mod);
          });
          try { VTT.versPage({ type: "vttk", actif: true, mots: VTT.motsDuPont() }); } catch (e) {}
          VTT.log("vttinker rallumé (interrupteur général)");
          vivants = VTT._demarres();
        }

        /* ÉTEINTE, ELLE NE RÉAGIT PLUS À RIEN D'AUTRE : rallumer un module un à
         * un pendant que le général est baissé le ferait tourner alors que
         * l'utilisateur croit tout éteint. */
        if (!vttActif(VTT.reglages)) { return; }

        Object.keys(ch).forEach(function (k) {
          if (k.indexOf("mod:") !== 0) { return; }
          var id = k.slice(4);

          if (ch[k].newValue === false) {
            var m = vivants[id];
            if (!m) { return; }
            if (typeof m.arrete === "function") {
              try { m.arrete.call(m); } catch (e) { VTT.log("module « " + id + " » : échec à l'arrêt", e); }
            }
            VTT._oublie(id);
            VTT.log("module « " + id + " » éteint");
            return;
          }

          if (ch[k].newValue === true && !vivants[id]) {
            var def = VTT._modules().filter(function (x) { return x.id === id; })[0];
            if (!def || def.relance === false) { return; }
            if (lance(def)) { VTT.log("module « " + id + " » rallumé"); }
          }
        });

        var cles = Object.keys(ch).filter(function (k) { return k.indexOf("reg:") === 0; });
        if (!cles.length) { return; }
        cles.forEach(function (k) { VTT.reglages[k] = ch[k].newValue; });

        /* LA LANGUE TRAVERSE JUSQU'À LA PAGE. Les modules la lisent d'eux-mêmes
         * par « change » ; le pont, lui, ne peut pas — il vit dans un monde où
         * le dictionnaire n'existe pas. */
        if (cles.indexOf("reg:langue") >= 0) {
          try { VTT.versPage({ type: "langue", mots: VTT.motsDuPont() }); } catch (e) {}
        }
        /* LE THÈME AUSSI TRAVERSE. La palette de marqueurs est peinte par le
         * pont, avec les couleurs qu'il lit chez Roll20 : un thème choisi doit
         * passer devant, sans quoi les deux panneaux se retrouvent l'un blanc
         * et l'autre noir. */
        if (cles.indexOf("reg:theme") >= 0) {
          try { VTT.versPage({ type: "theme", theme: vttThemeDe(VTT.reglages) }); } catch (e) {}
        }
        vivants = VTT._demarres();
        Object.keys(vivants).forEach(function (id) {
          var m = vivants[id];
          if (typeof m.change !== "function") { return; }
          try { m.change.call(m, cles); } catch (e) { VTT.log("module « " + id + " » : échec au changement", e); }
        });
      });
    } catch (e) {}
  }

  function lis() {
    var def = vttDefauts();
    function recu(r) {
      var etat = {};
      Object.keys(def).forEach(function (k) {
        etat[k] = (r && r[k] !== undefined) ? r[k] : def[k];
      });
      demarre(etat);
      ecoute();
    }
    // Un rejet du stockage donne les défauts, jamais le silence : une extension
    // fraîchement installée doit fonctionner, et une extension dont le stockage
    // répond mal ne doit pas disparaître sans un mot.
    try { browser.storage.local.get(vttCles()).then(recu, function () { recu(null); }); }
    catch (e) { recu(null); }
  }

  lis();
})();
