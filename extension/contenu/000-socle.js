/* LE SOCLE — monde isolé, chargé le premier, et il ne FAIT rien.
 *
 * Il ne pose aucun écouteur sur Roll20, n'écrit pas dans le DOM et n'injecte
 * rien : il définit seulement de quoi les modules ont besoin. Tout ce qui a un
 * effet passe par 999-demarrage.js, qui n'agit qu'une fois le stockage lu.
 * C'est la condition pour qu'un module éteint ne laisse AUCUNE trace — la même
 * leçon qu'ailleurs : un écouteur posé avant de savoir si on a le droit n'est
 * pas éteignable, parce qu'on ne retire pas une fonction anonyme.
 *
 * Les fichiers de content_scripts partagent un seul monde isolé et un seul
 * objet window : c'est ce qui permet à un module de trouver VTT sans import.
 * Cet expando reste invisible de la page, comme la page reste invisible d'ici.
 */
/* Le repli vers « chrome » vit dans commun/000-navigateur.js, chargé avant
 * tout le reste. Une règle recopiée à cinq endroits est une règle qui
 * diverge : celle-ci tenait à l'ordre du manifeste, sans que rien ne le dise. */

(function () {
  "use strict";

  var NS = "vttinker";

  var IS_TOP = (function () { try { return window.top === window; } catch (e) { return true; } })();
  var IS_POPOUT = IS_TOP && /^\/editor\/character\/[^/]+\//.test(location.pathname);
  var IS_EDITEUR = IS_TOP && !IS_POPOUT && /^\/editor(\/|$)/.test(location.pathname);

  var modules = [];        // tout ce qui s'est déclaré
  var demarres = {};       // id -> définition, ceux qui tournent
  var journal = [];        // ce qu'on a dit, pour qui ne peut pas lire la console
  var pontPose = false;    // tant qu'il n'est pas là, rien ne sert d'envoyer

  var VTT = window.VTT = {
    NS: NS,
    frame: { top: IS_TOP, editeur: IS_EDITEUR, popout: IS_POPOUT },
    reglages: {},          // rempli par le démarrage, tenu à jour ensuite

    /* ---------- LA LANGUE, DITE D'UN SEUL ENDROIT ----------
     *
     * Chaque module a du texte à l'écran, et la langue est un réglage comme un
     * autre : elle vit dans VTT.reglages, remplie par le démarrage et tenue à
     * jour par le stockage. Ce raccourci évite que chaque module refasse le
     * même « lire le réglage, valider, chercher le mot » — et surtout qu'un
     * seul d'entre eux oublie de valider et rende du vide. */
    langue: function () {
      return vttLangueValide(VTT.reglages && VTT.reglages["reg:langue"]);
    },

    mot: function (cle) { return vttMot(cle, VTT.langue()); },

    /* CE QUE LE PONT DOIT SAVOIR DIRE. Il vit dans le monde de la page, où
     * langue.js n'est pas : il ne peut pas traduire lui-même. On lui envoie
     * donc les mots dont il a besoin, et lui seulement — envoyer tout le
     * dictionnaire ferait voyager cinquante chaînes pour en employer dix. */
    motsDuPont: function () {
      var out = {};
      ["pal.titre", "pal.fermer", "pal.editer", "pal.editerFin", "pal.maniere",
       "pal.mode1", "pal.mode1Aide", "pal.mode2", "pal.mode2Aide",
       "pal.nom", "pal.url", "pal.ajoute", "pal.retire",
       "pal.pasAVous", "pal.choisisJetons",
       "mq.nom", "zoom.reglages", "mod.marqueurs"].forEach(function (c) { out[c] = VTT.mot(c); });
      return out;
    },

    /* Un module se déclare, il ne se lance pas. Le démarrage décide.
     *   { id, portee?, demarre(ctx), change?(cles) } */
    module: function (def) { modules.push(def); },
    _modules: function () { return modules; },
    _demarres: function () { return demarres; },
    _noteDemarre: function (def) { demarres[def.id] = def; },
    _oublie: function (id) { delete demarres[id]; },

    /* LE JOURNAL VOYAGE AUSSI VERS LE MONDE DE LA PAGE, et c'est ce qui rend le
     * travail supportable. Un script de contenu écrit dans une console que RIEN
     * d'extérieur ne sait lire : ni un pilote WebDriver, ni un relevé, ni rien
     * qui puisse être ramassé autrement qu'en sélectionnant du texte à la main.
     * Posé sur window.__vttinkerJournal, il se lit d'un executeScript.
     *
     * On renvoie le journal ENTIER à chaque ligne, et non la dernière : le pont
     * est injecté après coup, et les premières lignes — celles du démarrage,
     * justement les plus utiles quand rien ne marche — seraient perdues. */
    log: function () {
      var a = [].slice.call(arguments);
      try { console.log.apply(console, ["[VTTinker]"].concat(a)); } catch (e) {}
      try {
        var ligne = a.map(function (x) {
          if (typeof x === "string") { return x; }
          if (x instanceof Error) { return x.message; }
          try { return JSON.stringify(x); } catch (e) { return String(x); }
        }).join(" ");
        journal.push(ligne);
        if (journal.length > 200) { journal.shift(); }
        /* ON N'ENVOIE QUE LA LIGNE NEUVE.
         *
         * On renvoyait le journal ENTIER à chaque ligne, pour que le pont —
         * injecté plus tard — ne perde pas les premières. Le raisonnement était
         * juste, le remède beaucoup trop cher : chaque appel clonait jusqu'à
         * deux cents chaînes à travers postMessage, et ce coût est payé chez
         * tout le monde, pas seulement quand un pilote regarde.
         *
         * Le pont accumule désormais lui-même, et c'est l'INJECTION qui verse le
         * retard d'un coup — voir injectePont. Les premières lignes sont donc
         * toujours là, et une ligne ne coûte plus qu'une ligne. */
        if (pontPose) { VTT.versPage({ type: "journal", lignes: [ligne] }); }
      } catch (e) {}
    },

    /* ---------- franchir la frontière des mondes ----------
     * window.d20 et les objets internes de Roll20 vivent dans le MONDE
     * PRINCIPAL, qu'un script de contenu ne voit pas. Le seul passage sans eval
     * (refusé à la revue Mozilla) est une ressource déclarée en
     * web_accessible_resources, chargée par une balise <script src>.
     *
     * Le marqueur est posé sur <html> et NON sur la balise : celle-ci se retire
     * d'elle-même à l'onload, et un test sur son existence laisserait chaque
     * appel réinjecter un pont — donc des écouteurs en double, donc chaque
     * ordre exécuté deux fois. Le pont, de son côté, tient le même verrou.
     *
     * L'INJECTION EST PARESSEUSE, réclamée par un module et jamais faite au
     * chargement : sur Roll20, un script poussé dans le monde principal pendant
     * que la partie se monte gêne son propre démarrage. */
    injectePont: function () {
      var racine = document.documentElement;
      if (!racine || racine.hasAttribute("data-vttinker-pont")) { return; }
      racine.setAttribute("data-vttinker-pont", "1");
      var s = document.createElement("script");
      s.src = browser.runtime.getURL("page/pont.js");
      s.onload = function () {
        this.remove();   // l'écouteur, lui, reste
        /* LE RETARD SE VERSE ICI, ET UNE SEULE FOIS. Tout ce qui a été dit avant
         * que le pont existe part maintenant, d'un bloc ; ensuite, log() n'envoie
         * plus que la ligne neuve. */
        pontPose = true;
        try { VTT.versPage({ type: "journal", lignes: journal.slice(), remplace: true }); } catch (e) {}
        /* LES MOTS PARTENT ICI, ET PAS AVANT — MÊME RAISON QUE LE JOURNAL.
         *
         * Le démarrage les envoyait juste après avoir lancé les modules. Or
         * c'est un module qui injecte le pont, et cette injection est
         * ASYNCHRONE : le message partait dans le vide, personne ne l'écoutait
         * encore, et rien ne le renvoyait. Mesuré : la palette de marqueurs
         * restait en français alors que l'anglais est le défaut — titre,
         * rouage, les deux modes, la croix de fermeture.
         *
         * Ici, le pont vient exactement de se charger. C'est le seul instant où
         * l'on sait qu'il écoute. */
        try { VTT.versPage({ type: "langue", mots: VTT.motsDuPont() }); } catch (e) {}
        try { VTT.versPage({ type: "theme", theme: vttThemeValide(VTT.reglages && VTT.reglages["reg:theme"]) }); } catch (e) {}
      };
      (document.head || racine).appendChild(s);
    },

    /* Tout le monde poste vers window.top ; le pont répond par ev.source. On ne
     * descend jamais l'arbre des frames : ev.source traverse les origines, ce
     * que targetOrigin ne sait pas faire. */
    versPage: function (msg) {
      msg.ns = NS;
      msg.depuis = "contenu";
      /* VERS NOTRE PAGE, NOMMÉMENT. Le protocole ne transporte rien de secret,
       * mais une cible explicite est ce qui distingue un message d'une
       * diffusion — et « * » est une diffusion. */
      try { window.top.postMessage(msg, location.origin); } catch (e) {}
    },

    /* UN ÉCOUTEUR QUI TOMBE LE DIT. Le try/catch est indispensable — une
     * exception qui remonte d'ici casse Roll20, pas seulement nous — mais
     * l'avaler en silence a déjà caché une panne entière : le code qui dessine
     * échouait à sa première ligne, et le banc d'essai passait en croyant avoir
     * tout vérifié. On attrape, et on écrit. */
    surPage: function (type, cb) {
      window.addEventListener("message", function (ev) {
        var d = ev.data;
        // Le filtre sur « depuis » évite qu'on s'entende soi-même : le pont et
        // le socle écoutent le MÊME window, l'un dans le monde principal,
        // l'autre dans le monde isolé, et reçoivent donc tous les deux chaque
        // message posté vers window.top.
        try {
          if (!d || d.ns !== NS || d.depuis !== "page") { return; }
          if (d.type !== type) { return; }
          /* ET D'OÙ IL VIENT, PAS SEULEMENT CE QU'IL DIT.
           *
           * Les quatre lignes au-dessus ne lisent que le CONTENU du message :
           * trois chaînes, que n'importe qui peut écrire. Or postMessage
           * traverse les origines par construction — une page qui garde une
           * poignée sur cet onglet, ne serait-ce qu'un window.open, peut poster
           * ici et se faire passer pour le pont.
           *
           * Le pont poste sur CETTE fenêtre, depuis le monde principal de la
           * même page : son origine est la nôtre, et sa fenêtre est la nôtre.
           * L'origine écarte la page étrangère ; la fenêtre écarte un cadre de
           * même origine — Roll20 en héberge — qui posterait vers le haut. */
          if (ev.origin !== location.origin) { return; }
          if (ev.source !== window) { return; }
        } catch (e) { return; }
        try { cb(d, ev); }
        catch (e) { VTT.log("écouteur « " + type + " » : " + ((e && e.message) || e)); }
      }, false);
    }
  };
})();
