/* MODULE « Destinataire du chat ».
 *
 * Roll20 ne dit à qui l'on parle que par une commande tapée à la main :
 * « /w gm » pour le MJ, « /w Nom » pour un joueur. Il faut la connaître, la
 * réécrire à chaque message, et l'orthographier juste — un nom mal tapé part en
 * clair devant toute la table.
 *
 * Ce module ajoute une seconde ligne sous « En tant que : », devenu « De : » :
 *
 *     De : [ personnage   ▾ ]   ← la sienne, renommée
 *     À :  [ destinataire ▾ ]   ← la nôtre
 *
 * et préfixe le message tout seul au moment de l'envoi.
 *
 * IL TRAVAILLE DANS LE DOM ORDINAIRE, SANS LE PONT. La zone de chat n'est ni
 * Babylon ni Pinia : un script de contenu y a accès directement. Le pont
 * n'apporte qu'une chose, celle que le monde isolé ne peut pas voir — la liste
 * des joueurs, qui vit dans la collection Backbone de la campagne.
 */
(function () {
  "use strict";

  var VTT = window.VTT;

  /* Ce que Roll20 nous donne, relevé sur une vraie partie :
   *   · l'intitulé est un <label> NU — aucune classe — dont le texte est
   *     « En tant que: » ;
   *   · le sélecteur est <select id="speakingas" class="selectize">, 140 × 28 ;
   *   · la saisie est #textchat-input textarea, le bouton un .btn « Envoyer ».
   * On clone donc ses classes plutôt que d'habiller le nôtre : une pièce
   * rapportée se voit, un élément aux mêmes classes non. */
  var SEL_SPEAKING = "#speakingas";
  var SEL_SAISIE = "#textchat-input textarea";
  /* SON BOUTON D'ENVOI SE DÉSIGNE PAR SON IDENTIFIANT, et c'est une correction.
   *
   * Le premier jet visait « #textchat-input .btn, #textchat-input button » — ce
   * qui attrapait AUSSI les trois boutons qu'on venait d'ajouter, puisqu'ils
   * sont des <button> dans la même zone. Chaque passage du guet en déplaçait
   * donc un dans notre ligne : les trois y ont fini un par un, la ligne « De : »
   * s'est retrouvée avec un conteneur vide, et le vrai bouton n'a jamais bougé.
   *
   * Il porte un identifiant — #chatSendBtn, relevé sur une vraie partie —, ce
   * qui ne laisse aucune place au malentendu. Le repli exclut explicitement les
   * nôtres, faute de quoi il reproduirait le même défaut. */
  var SEL_ENVOI = "#chatSendBtn, #textchat-input .btn:not(.vttk-chat-bouton)";

  var joueurs = [];
  var moi = null;
  var destinataire = "";      // "" = tout le monde ; "gm" ; sinon un nom de joueur
  var notreLigne = null;
  var notreSelect = null;
  var guet = null;
  var branche = false;
  var pontPret = false;
  /* UN MODULE ÉTEINT NE REMONTE RIEN, et il fallait un drapeau pour le tenir.
   *
   * Les écouteurs de messages ne se retirent jamais — le socle le dit lui-même —
   * et celui de « chat-joueurs » appelle pose() sans condition. Un message déjà
   * EN VOL au moment de l'extinction rebâtissait donc tout l'habillage sur un
   * module qu'on venait d'éteindre : ligne « À : » recréée, bouton d'envoi de
   * Roll20 redéplacé, guet mort — et plus aucun interrupteur pour l'enlever,
   * puisque le module n'est plus dans la liste des démarrés.
   *
   * La fenêtre est courte — le temps qu'une tâche de stockage passe —, mais
   * l'invariant du socle est clair : éteindre veut dire quelque chose. */
  var actif = false;
  var boutonRendu = null;   // son bouton d envoi, et d où il vient

  function el(balise, classe, texte) {
    var n = document.createElement(balise);
    if (classe) { n.className = classe; }
    if (texte !== undefined) { n.textContent = texte; }
    return n;
  }

  /* L'intitulé, d'où tout part. On le retrouve par son TEXTE et non par une
   * classe : il n'en a aucune, et son voisinage peut changer. */
  function intituleDeRoll20() {
    var n = document.querySelectorAll("label"), i, t;
    for (i = 0; i < n.length; i++) {
      t = (n[i].textContent || "").replace(/\s+/g, " ").trim();
      /* TROIS ÉCRITURES, ET LA TROISIÈME A COÛTÉ TOUT LE MODULE.
       *
       * Sur une campagne d'HÉRITAGE, Roll20 écrit simplement « As: » — relevé
       * sur une vraie partie. Le motif n'acceptait que « En tant que » et
       * « Speaking as » : l'intitulé n'était jamais trouvé, la ligne « À : » ne
       * se posait pas, et le pied de chat entier — destinataire et émojis —
       * restait absent sans qu'aucun message ne l'explique. */
      if (/^(En tant que|Speaking as|As)\s*:?$/i.test(t)) { return n[i]; }
      if (n[i].getAttribute("data-vttk-avant")) { return n[i]; }
    }
    return null;
  }

  /* ---------- LA SYNTAXE DU CHUCHOTEMENT, MESURÉE ----------
   *
   * Quatre envois sur une vraie partie, chacun relu dans le journal du chat :
   *
   *   /w gm texte                      → « (To GM) : texte »
   *   /w Alandush texte                → « (To Alandush) : texte »
   *   /w Jean Batiste-Bernard … texte  → CASSÉ. Roll20 devine bien le
   *       destinataire, mais il AVALE une partie du message : « (To Jean …) :
   *       Batiste-Bernard de la Boutonnière texte ». Il ne prend que le premier
   *       mot comme nom, et le reste retombe dans le corps du message.
   *   /w "Jean Batiste-Bernard …" texte → « (To Jean …) : texte »
   *
   * D'où la règle : un nom qui n'est pas un seul mot simple passe entre
   * guillemets. « gm » est un mot-clé, jamais un nom, donc jamais entre
   * guillemets. */
  function prefixe() {
    if (!destinataire) { return ""; }
    if (destinataire === "gm") { return "/w gm "; }
    var n = String(destinataire).replace(/"/g, "");
    return /^[A-Za-z0-9_-]+$/.test(n) ? "/w " + n + " " : "/w \"" + n + "\" ";
  }

  /* ON NE TOUCHE PAS À UNE COMMANDE. Un message qui commence par « / » en est
   * une — /roll, /em, /desc, /gmroll, ou un /w que l'utilisateur a écrit
   * lui-même. Y coller un préfixe la casserait, et il n'existe aucune façon
   * générale de composer deux commandes de Roll20. Le sélecteur ne s'applique
   * donc qu'à un message ordinaire ; une commande part telle quelle. */
  function texteAEnvoyer(brut) {
    var t = String(brut || "");
    if (!t.trim()) { return null; }
    if (t.charAt(0) === "/") { return null; }
    var p = prefixe();
    return p ? p + t : null;
  }

  /* On écrit dans le champ comme le navigateur écrit : par le setteur natif du
   * prototype, puis un événement « input ». Poser `value` directement ne
   * préviendrait pas le composant qui l'observe, et le champ paraîtrait changé
   * sans que personne ne l'ait appris. */
  function poseTexte(zone, texte) {
    var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(zone), "value");
    if (d && d.set) { d.set.call(zone, texte); } else { zone.value = texte; }
    zone.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function prefixeAvantEnvoi() {
    var z = document.querySelector(SEL_SAISIE);
    if (!z) { return; }
    var neuf = texteAEnvoyer(z.value);
    if (neuf === null) { return; }
    poseTexte(z, neuf);
  }

  /* ---------- LES TROIS BOUTONS À VENIR ----------
   *
   * « + », une émoticône et GIF : ils n'ouvrent encore rien. Ils sont là parce
   * que la disposition les attend, et DÉSACTIVÉS parce qu'un bouton qui ne fait
   * rien quand on le presse est pire qu'un bouton absent — on s'y reprend à
   * trois fois avant de comprendre qu'il n'y a rien à comprendre. Leur infobulle
   * le dit en toutes lettres. */
  function faisBoutonAVenir(mot, aide, dessin) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "vttk-chat-bouton";
    b.disabled = true;
    b.title = aide + " — " + VTT.mot("app.bientot");
    b.setAttribute("aria-label", b.title);
    if (dessin) { b.appendChild(dessin()); } else { b.textContent = mot; }
    return b;
  }

  var SVG = "http://www.w3.org/2000/svg";

  function faisSourire() {
    var s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "vttk-chat-icone");
    var g = document.createElementNS(SVG, "g");
    g.setAttribute("fill", "none");
    g.setAttribute("stroke", "currentColor");
    g.setAttribute("stroke-width", "1.8");
    g.setAttribute("stroke-linecap", "round");
    var c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9");
    g.appendChild(c);
    [[9, 10], [15, 10]].forEach(function (p) {
      var o = document.createElementNS(SVG, "line");
      o.setAttribute("x1", p[0]); o.setAttribute("y1", p[1] - 0.6);
      o.setAttribute("x2", p[0]); o.setAttribute("y2", p[1] + 0.6);
      g.appendChild(o);
    });
    var b = document.createElementNS(SVG, "path");
    b.setAttribute("d", "M8 14.5a5 5 0 0 0 8 0");
    g.appendChild(b);
    s.appendChild(g);
    return s;
  }

  /* ---------- LES ÉMOJIS ----------
   *
   * CE QUI PART EST DU TEXTE, et c'est toute la feature. Un émoji Unicode
   * voyage dans le message comme une lettre : Roll20 le stocke, le rediffuse,
   * et chaque poste le dessine avec sa propre police. Un lecteur sans
   * l'extension le voit donc exactement comme nous — ce qui était la demande, et
   * ce qui exclut d'emblée l'idée d'émojis maison, qui n'existeraient que chez
   * ceux qui les ont.
   *
   * Le catalogue vit dans commun/emojis.js, avec les règles qu'il s'impose. */

  var panneau = null;        // le panneau ouvert, ou rien
  var recents = [];          // les derniers choisis, du plus récent au plus vieux
  var CLE_RECENTS = "_emojiRecents";

  function litRecents() {
    try {
      browser.storage.local.get(CLE_RECENTS).then(function (r) {
        var v = r && r[CLE_RECENTS];
        if (Object.prototype.toString.call(v) === "[object Array]") {
          /* ON RELIT CE QU'ON A ÉCRIT SANS LE CROIRE. Un stockage est un
           * fichier : il a pu être modifié, tronqué, ou écrit par une version
           * qui ne s'imposait pas les mêmes règles. */
          recents = v.filter(vttEmojiBienForme).slice(0, VTT_EMOJI_RECENTS_MAX);
        }
      }, function () {});
    } catch (e) {}
  }

  function noteRecent(car) {
    recents = [car].concat(recents.filter(function (x) { return x !== car; }))
      .slice(0, VTT_EMOJI_RECENTS_MAX);
    try {
      var o = {};
      o[CLE_RECENTS] = recents;
      browser.storage.local.set(o);
    } catch (e) {}
  }

  /* L'INSERTION SE FAIT AU CURSEUR, et remplace la sélection s'il y en a une —
   * c'est ce que fait toute frappe au clavier, et un émoji n'a aucune raison de
   * se comporter autrement. On rend ensuite le curseur JUSTE APRÈS l'émoji :
   * sans cela il retombe au début, et le deuxième émoji se pose avant le
   * premier. La longueur en unités UTF-16 est la bonne mesure ici, c'est celle
   * dans laquelle le champ compte. */
  function poseEmoji(car) {
    var z = document.querySelector(SEL_SAISIE);
    if (!z) { return; }
    var d = z.selectionStart, f = z.selectionEnd, v = z.value;
    if (typeof d !== "number") { d = f = v.length; }
    poseTexte(z, v.slice(0, d) + car + v.slice(f));
    try {
      z.focus();
      z.selectionStart = z.selectionEnd = d + car.length;
    } catch (e) {}
    noteRecent(car);
  }

  /* Le panneau s'habille des couleurs DE LA ZONE, pas des siennes. Il est posé
   * sur <body> pour qu'aucun débordement de Roll20 ne le rogne, et y perdrait
   * donc l'héritage de couleur dont tout le reste du module se sert. On lui
   * porte les deux valeurs à la main, relevées au moment de l'ouverture : c'est
   * ce qui le fait suivre un thème sombre sans qu'on ait à le connaître. */
  function fondDe(n) {
    while (n && n !== document.documentElement) {
      var f = getComputedStyle(n).backgroundColor;
      if (f && f !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(f)) { return f; }
      n = n.parentNode;
    }
    return "#fff";
  }

  function faisTuile(car, nom) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "vttk-emoji-tuile";
    b.textContent = car;
    b.title = nom;
    b.setAttribute("aria-label", nom);
    return b;
  }

  function remplitGrille(grille, liste) {
    grille.textContent = "";
    if (!liste.length) {
      grille.appendChild(el("p", "vttk-emoji-vide", VTT.mot("chat.rienEncore")));
      return;
    }
    /* LE NOM VIENT DE L'ENTRÉE, PAS D'UN RANG. Chaque entrée porte deux noms —
     * celui d'Unicode et le nôtre — et c'est le catalogue qui sait lequel
     * prendre : écrire « p[1] » ici, c'était figer l'anglais. */
    liste.forEach(function (p) { grille.appendChild(faisTuile(p[0], vttEmojiNom(p, VTT.langue()))); });
  }

  function faisPanneau() {
    var p = el("div", "vttk-emoji-panneau");
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", VTT.mot("chat.emojis"));

    var onglets = el("div", "vttk-emoji-onglets");
    var grille = el("div", "vttk-emoji-grille");
    var titre = el("div", "vttk-emoji-titre", "");

    /* Les récents d'abord : c'est l'onglet qu'on rouvre, et le seul dont le
     * contenu change. Il n'apparaît que s'il a quelque chose à montrer — un
     * onglet vide au premier rang ferait croire que le panneau est cassé. */
    var cats = [];
    if (recents.length) {
      cats.push({
        id: "recents", nom: VTT.mot("chat.recents"), onglet: "🕘",
        liste: recents.map(function (c) { return [c, nomDe(c), nomDe(c)]; })
      });
    }
    /* Le nom d'une catégorie vient du dictionnaire, jamais du catalogue : le
     * catalogue porte l'identifiant du groupe officiel, qui ne se traduit pas. */
    cats = cats.concat(VTT_EMOJIS.map(function (g) {
      return { id: g.id, nom: VTT.mot("emo." + g.id), onglet: g.onglet, liste: g.liste };
    }));

    function montre(i) {
      titre.textContent = cats[i].nom;
      remplitGrille(grille, cats[i].liste);
      [].slice.call(onglets.children).forEach(function (b, k) {
        b.classList.toggle("choisi", k === i);
        b.setAttribute("aria-selected", k === i ? "true" : "false");
      });
      grille.scrollTop = 0;
    }

    cats.forEach(function (c, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "vttk-emoji-onglet";
      b.textContent = c.onglet;
      b.title = c.nom;
      b.setAttribute("role", "tab");
      b.addEventListener("click", function () { montre(i); });
      onglets.appendChild(b);
    });

    /* UN SEUL ÉCOUTEUR POUR SIX CENT VINGT-HUIT TUILES. Un par bouton, ce
     * serait six cent vingt-huit fonctions à poser à chaque ouverture, et
     * autant à laisser derrière soi. L'événement remonte : on lit qui l'a
     * déclenché. */
    grille.addEventListener("click", function (ev) {
      var t = ev.target;
      while (t && t !== grille && !t.classList.contains("vttk-emoji-tuile")) { t = t.parentNode; }
      if (!t || t === grille) { return; }
      poseEmoji(t.textContent);
    });

    /* LE PANNEAU NE PREND PAS LE FOCUS, et c'est indispensable : le curseur du
     * champ de saisie EST l'endroit où l'émoji doit aller. Laisser le bouton se
     * saisir du focus effacerait la sélection en cours et rendrait
     * l'insertion au curseur impossible. On refuse donc la prise de focus à la
     * racine, une fois, plutôt que sur chaque tuile. */
    p.addEventListener("mousedown", function (ev) { ev.preventDefault(); });

    p.appendChild(onglets);
    p.appendChild(titre);
    p.appendChild(grille);
    montre(0);
    return p;
  }

  /* Le nom d'un émoji, retrouvé dans le catalogue. Sert aux récents, qui ne
   * stockent que le caractère — dupliquer les noms dans le stockage les figerait
   * à la version qui les a écrits. */
  /* La table des noms est refaite QUAND LA LANGUE CHANGE, et pas seulement à
   * la première demande : gardée telle quelle, elle aurait figé les infobulles
   * dans la langue du premier panneau ouvert. */
  var NOMS = null, NOMS_LANGUE = null;
  function nomDe(car) {
    var l = VTT.langue();
    if (!NOMS || NOMS_LANGUE !== l) {
      NOMS = {};
      NOMS_LANGUE = l;
      VTT_EMOJIS.forEach(function (c) {
        c.liste.forEach(function (p) { NOMS[p[0]] = vttEmojiNom(p, l); });
      });
    }
    return NOMS[car] || VTT.mot("chat.emojis");
  }

  /* ---------- LE PANNEAU SE CALE SUR LE CHAMP, PAS SUR LE BOUTON ----------
   *
   * Le premier jet l'ancrait au bouton qui l'ouvre, et le posait juste
   * au-dessus. Résultat : il RECOUVRAIT le champ de saisie — on ne voyait plus
   * ce qu'on était en train d'écrire au moment même où l'on y insérait quelque
   * chose. C'est le contraire de ce qu'un choix d'émojis doit faire.
   *
   * Il se cale donc sur le CHAMP : même bord gauche, même largeur, et son bas
   * juste au-dessus du haut du champ. Rien n'est recouvert, et les deux boîtes
   * se lisent comme une seule colonne.
   *
   * LA LARGEUR NE SE DEVINE PAS, ELLE SE MESURE À CHAQUE FOIS. Le champ est
   * redimensionnable — par sa propre poignée, et par celle que Roll20 pose sur
   * la zone — et une largeur choisie à l'ouverture serait fausse au premier
   * glissement. C'est pour cela qu'un observateur suit le champ tant que le
   * panneau est ouvert, plutôt qu'une valeur figée.
   *
   * La hauteur, elle, est bornée par ce qui reste AU-DESSUS du champ : un
   * panneau plus haut sortirait par le haut de l'écran, là où il n'y a rien
   * pour l'arrêter puisqu'il est en position fixe. */
  var ECART_PANNEAU = 6;
  var suiveur = null;

  function placePanneau() {
    var champ = document.querySelector(SEL_SAISIE);
    if (!panneau || !champ) { return; }
    var r = champ.getBoundingClientRect();
    if (!r.width) { return; }
    var place = Math.max(120, r.top - ECART_PANNEAU - 8);
    panneau.style.left = Math.round(r.left) + "px";
    panneau.style.right = "auto";
    panneau.style.width = Math.round(r.width) + "px";
    panneau.style.bottom = Math.round(window.innerHeight - r.top + ECART_PANNEAU) + "px";
    panneau.style.maxHeight = Math.round(Math.min(place, window.innerHeight * 0.46)) + "px";
  }

  function ouvreEmojis(bouton) {
    if (panneau) { fermeEmojis(); return; }
    panneau = faisPanneau();
    var z = document.querySelector("#textchat-input");
    if (z) {
      var s = getComputedStyle(z);
      panneau.style.color = s.color;
      panneau.style.background = fondDe(z);
    }
    document.body.appendChild(panneau);
    placePanneau();

    /* L'OBSERVATEUR SUIT LE CHAMP, ET NON LA FENÊTRE. Un redimensionnement du
     * champ ou de la barre latérale ne produit aucun événement de fenêtre :
     * s'en remettre à « resize » laisserait le panneau à l'ancienne largeur
     * pendant tout le glissement. On observe donc la boîte elle-même. */
    var champ = document.querySelector(SEL_SAISIE);
    if (champ && typeof ResizeObserver === "function") {
      suiveur = new ResizeObserver(function () { placePanneau(); });
      suiveur.observe(champ);
      if (z) { suiveur.observe(z); }
    }

    bouton.classList.add("ouvert");
    bouton.setAttribute("aria-expanded", "true");
  }

  function fermeEmojis() {
    if (suiveur) { try { suiveur.disconnect(); } catch (e) {} suiveur = null; }
    if (panneau && panneau.parentNode) { panneau.parentNode.removeChild(panneau); }
    panneau = null;
    var b = document.querySelector(".vttk-chat-emoji");
    if (b) { b.classList.remove("ouvert"); b.setAttribute("aria-expanded", "false"); }
  }

  function faisBoutonEmoji() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "vttk-chat-bouton vttk-chat-emoji";
    b.title = VTT.mot("chat.emojis");
    b.setAttribute("aria-label", VTT.mot("chat.emojis"));
    b.setAttribute("aria-expanded", "false");
    b.appendChild(faisSourire());
    b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      ouvreEmojis(b);
    });
    return b;
  }

  function faisOutils() {
    var d = el("div", "vttk-chat-outils");
    d.appendChild(faisBoutonAVenir("+", VTT.mot("chat.ajouter")));
    d.appendChild(faisBoutonEmoji());
    d.appendChild(faisBoutonAVenir("GIF", VTT.mot("chat.gif")));
    return d;
  }

  /* ---------- LA LIGNE « À : » ---------- */
  function faisLigne(modele) {
    var ligne = el("div", "vttk-chat-a");
    ligne.appendChild(el("label", "vttk-chat-etiquette", VTT.mot("chat.a")));

    var s = document.createElement("select");
    /* LES CLASSES SONT LES SIENNES. Son sélecteur porte « selectize » ; le nôtre
     * doit lui ressembler sans qu'on ait à connaître son thème. */
    s.className = (modele && modele.className) || "";
    s.classList.add("vttk-chat-select");
    s.setAttribute("aria-label", "Destinataire du message");
    /* AUCUNE LARGEUR ICI. Elle se recopiait du sien à chaque passage du guet, et
     * se trompait tant que Roll20 n'avait pas fini de charger ses options — 115
     * px relevés là où il en fait 140. Les deux sélecteurs remplissent
     * désormais la MÊME COLONNE d'une grille : ils sont identiques par
     * construction, et il n'y a plus rien à recopier ni à corriger. */
    ligne.appendChild(s);

    notreSelect = s;
    remplitSelect();
    s.addEventListener("change", function () {
      destinataire = s.value;
      peintEtat();
    });
    return ligne;
  }

  function remplitSelect() {
    var s = notreSelect, i;
    if (!s) { return; }
    var garde = destinataire;
    while (s.firstChild) { s.removeChild(s.firstChild); }

    function ajoute(valeur, mot) {
      var o = document.createElement("option");
      o.value = valeur;
      o.textContent = mot;
      s.appendChild(o);
    }

    /* LES NOMS, ET RIEN QUE LES NOMS.
     *
     * Un premier jet écrivait « MJ — chuchoter » et « Nom — hors ligne ». Ni
     * l'un ni l'autre n'avait été demandé : le premier répète ce que la ligne
     * « À : » dit déjà, le second est un état qui change tout seul et qui n'a
     * aucune conséquence — Roll20 délivre un chuchotement à qui se reconnecte.
     * Un menu qui commente ses propres entrées les rend plus longues à lire, pas
     * plus claires.
     *
     * ET SOI-MÊME Y FIGURE. Un autre jet l'avait retiré, en jugeant que se
     * chuchoter à soi n'a pas d'usage : c'en est un — c'est ainsi qu'on se
     * garde une note dans le fil de la partie, sans que la table la lise. Ce
     * n'était pas à décider ici. */
    ajoute("", VTT.mot("chat.tous"));
    ajoute("gm", VTT.mot("chat.mj"));
    joueurs.forEach(function (j) { ajoute(j.nom, j.nom); });

    /* ON REPOSE LE CHOIX D'AVANT s'il existe encore. Un joueur qui se déconnecte
     * ne doit pas faire retomber le destinataire sur « tout le monde » sans un
     * mot : le message suivant partirait à toute la table. */
    var existe = false;
    for (i = 0; i < s.options.length; i++) {
      if (s.options[i].value === garde) { existe = true; }
    }
    s.value = existe ? garde : "";
    destinataire = s.value;
    peintEtat();
  }

  /* Le chuchotement se VOIT, et pas seulement dans un menu déroulant refermé :
   * c'est la différence entre un message que toute la table lit et un message
   * privé. */
  function peintEtat() {
    if (notreLigne) { notreLigne.classList.toggle("chuchote", !!destinataire); }
  }

  /* ---------- LA POSE, ET SA REPOSE ----------
   *
   * Roll20 refait son pied de chat de temps à autre. Un guet léger remet notre
   * ligne quand elle a disparu — même parti que la grille, et pour la même
   * raison : un module qui s'évanouit sans rien dire est pire qu'un module
   * absent. */
  function pose() {
    if (!actif) { return false; }
    var lab = intituleDeRoll20();
    if (!lab) { return false; }

    /* SON INTITULÉ DEVIENT « DE : », et on garde le texte d'origine SUR le nœud :
     * l'extinction doit le rendre tel qu'on l'a trouvé, et une variable de module
     * ne survivrait pas à un rechargement de la zone. */
    if (!lab.getAttribute("data-vttk-avant")) {
      lab.setAttribute("data-vttk-avant", lab.textContent);
    }
    /* L'INTITULÉ SE COMPARE À CE QU'ON VEUT ÉCRIRE, et non à un mot figé :
     * sans quoi, changer de langue laisserait « De : » en place pour toujours,
     * puisque le test « ce n'est pas De : » serait faux. */
    var sien = VTT.mot("chat.de");
    if (lab.textContent !== sien) { lab.textContent = sien; }
    lab.classList.add("vttk-chat-de");

    var bloc = lab.parentNode;
    if (!bloc || !bloc.parentNode) { return false; }

    /* LE CONTENEUR DES DEUX LIGNES EST MARQUÉ, LUI AUSSI, et il a fallu lire
     * l'arbre pour comprendre qu'il existait.
     *
     * On croyait nos deux lignes filles de la zone de saisie, donc soumises à
     * son écart. Relevé : elles vivent dans un <div> intermédiaire, sans classe,
     * en « display: block » et sans le moindre écart — l'espacement de la zone
     * ne les a jamais concernées. Roll20 les séparait par la marge basse de son
     * sélecteur ; cette marge décalait l'alignement et a dû partir, et les deux
     * lignes se sont retrouvées collées.
     *
     * On lui pose donc une classe, comme à ses autres nœuds, pour que l'écart
     * soit porté là où il agit vraiment. */
    bloc.parentNode.classList.add("vttk-chat-lignes");

    /* ON EFFACE LES BOÎTES VIDES DE LA ZONE, et ce n'est pas du rangement.
     *
     * En passant la zone en « flex », son écart s'applique entre CHAQUE paire
     * d'enfants — y compris autour d'un <div class="clear"> haut de zéro pixel,
     * dont le seul rôle était de dégager des flottants et qui ne fait plus rien
     * du tout dans une boîte flexible. L'écart entre le champ et nos lignes
     * valait donc DEUX écarts au lieu d'un, et il tombait juste par accident :
     * le jour où Roll20 retire ce <div>, l'espacement se réduit de moitié sans
     * qu'une ligne de notre feuille ait changé.
     *
     * On les efface, et l'écart de la zone redevient ce qu'il annonce. */
    var enf = bloc.parentNode.parentNode ? bloc.parentNode.parentNode.children : [];
    [].slice.call(enf).forEach(function (n) {
      if (n.children.length || (n.textContent || "").trim()) { return; }
      if (!n.classList.contains("clear")) { return; }
      n.classList.add("vttk-chat-vide");
    });

    /* ---------- ON MARQUE SES NOEUDS POUR POUVOIR LES HABILLER ----------
     *
     * La feuille de l extension s interdit tout selecteur qui ne commence pas
     * par « .vttk- » : c est la seule chose qui empeche de repeindre
     * l interface de quelqu un d autre, et ca ne se negocie pas. Pour styler ce
     * qui est a Roll20, on lui pose donc une classe a nous — c est deja ce
     * qu on fait pour sa ligne et pour son bouton d envoi.
     *
     * Rien n est ecrase : ses classes restent, les notres s ajoutent, et
     * l extinction les retire une a une. */
    var zone = document.querySelector("#textchat-input");
    if (zone) { zone.classList.add("vttk-chat-zone"); }
    var champ = document.querySelector(SEL_SAISIE);
    if (champ) { champ.classList.add("vttk-chat-saisie"); }
    var sonChoix = document.querySelector(SEL_SPEAKING);
    if (sonChoix) { sonChoix.classList.add("vttk-chat-choix"); }

    /* SA LIGNE DEVIENT UNE VRAIE LIGNE. Elle ne remplissait pas son parent —
     * mesuré, 191 px dans 330 — et laissait donc la place à ce qui suivait de
     * se ranger à côté d'elle. On lui donne la largeur pleine et la disposition
     * en rangée, puis on lui accroche les trois boutons à droite. */
    bloc.classList.add("vttk-chat-de-ligne");
    if (!bloc.querySelector(".vttk-chat-outils")) { bloc.appendChild(faisOutils()); }

    /* « parentNode » N'EST PAS UN TEST DE VIVANT, et la nuance coûte cher ici.
     * Quand Roll20 refait son pied de chat, notre ligne n'est pas détruite : elle
     * part avec l'ancien sous-arbre, DÉTACHÉE du document mais toujours pourvue
     * d'un parent. On la croyait donc en place, et on déplaçait le NOUVEAU bouton
     * d'envoi de Roll20 dans un nœud que plus personne n'affiche — le chat
     * perdait de quoi envoyer. La question à poser est « le document le
     * contient-il ? », et c'est celle-là qu'on pose. */
    if (!notreLigne || !document.contains(notreLigne)) {
      notreLigne = faisLigne(document.querySelector(SEL_SPEAKING));
      /* SOUS LA SIENNE, DANS LE MÊME PARENT : c'est le seul endroit où la ligne
       * se lit comme la suite de la première. */
      if (bloc.nextSibling) { bloc.parentNode.insertBefore(notreLigne, bloc.nextSibling); }
      else { bloc.parentNode.appendChild(notreLigne); }
    }

    /* ---------- SON BOUTON D'ENVOI REMONTE SUR NOTRE LIGNE ----------
     *
     * Il était passé SOUS les deux lignes, ce qui n'est ni ce qu'il était ni ce
     * qu'on veut. On le DÉPLACE — on ne le recrée pas : un nœud déplacé garde
     * ses écouteurs, un nœud cloné les perd, et c'est Roll20 qui les a posés.
     *
     * On note d'où il vient pour l'y remettre à l'extinction. Sur le nœud, pas
     * dans une variable : Roll20 refait cette zone, et une variable de module ne
     * survivrait pas au remplacement. */
    var envoi = document.querySelector(SEL_ENVOI);
    if (envoi && document.contains(envoi) && envoi.parentNode !== notreLigne) {
      /* CHAQUE BOUTON NEUF EST NOTÉ À NEUF. Après une reprise de zone, Roll20 en
       * fabrique un autre : garder l'ancien souvenir rendrait, à l'extinction, un
       * bouton mort à un parent mort. On retient donc d'où vient CELUI qu'on
       * déplace, chaque fois qu'on en déplace un. */
      if (!boutonRendu || boutonRendu.noeud !== envoi) {
        envoi.setAttribute("data-vttk-place", "1");
        boutonRendu = { noeud: envoi, pere: envoi.parentNode, apres: envoi.nextSibling };
      }
      envoi.classList.add("vttk-chat-envoi");
      notreLigne.appendChild(envoi);
    }
    return true;
  }

  function ote() {
    /* LE PANNEAU PART EN PREMIER, et il est le seul nœud du module posé hors de
     * la zone de chat — sur <body>, pour qu'aucun débordement ne le rogne.
     * L'oublier ici laisserait une grille d'émojis flottante sur une page dont
     * plus rien d'autre ne serait à nous. */
    fermeEmojis();

    /* ON REND SON BOUTON D ENVOI À SA PLACE, exactement où il était. Le laisser
     * dans une ligne qu on vient de retirer le ferait disparaître avec elle, et
     * le chat n aurait plus de quoi envoyer. */
    /* ON NE RANGE PAS DANS UN PÈRE MORT. Si Roll20 a refait sa zone depuis, le
     * parent d'origine est détaché : y remettre le bouton l'enterrerait avec
     * lui. Dans ce cas on ne touche à rien — Roll20 a déjà fabriqué son bouton
     * neuf, et celui qu'on tenait n'a plus d'usage. */
    if (boutonRendu && boutonRendu.noeud && boutonRendu.pere &&
        document.contains(boutonRendu.pere)) {
      try {
        boutonRendu.noeud.classList.remove("vttk-chat-envoi");
        boutonRendu.noeud.removeAttribute("data-vttk-place");
        if (boutonRendu.apres && boutonRendu.apres.parentNode === boutonRendu.pere) {
          boutonRendu.pere.insertBefore(boutonRendu.noeud, boutonRendu.apres);
        } else { boutonRendu.pere.appendChild(boutonRendu.noeud); }
      } catch (e) {}
    }
    boutonRendu = null;
    ["#textchat-input:vttk-chat-zone", "textarea:vttk-chat-saisie",
     "#speakingas:vttk-chat-choix"].forEach(function (paire) {
      var c = paire.split(":");
      var n = document.querySelector(c[0] === "textarea" ? SEL_SAISIE : c[0]);
      if (n) { n.classList.remove(c[1]); }
    });
    var bloc = document.querySelector(".vttk-chat-de-ligne");
    if (bloc) {
      var o = bloc.querySelector(".vttk-chat-outils");
      if (o) { bloc.removeChild(o); }
      bloc.classList.remove("vttk-chat-de-ligne");
    }
    var lignes = document.querySelector(".vttk-chat-lignes");
    if (lignes) { lignes.classList.remove("vttk-chat-lignes"); }
    [].slice.call(document.querySelectorAll(".vttk-chat-vide")).forEach(function (n) {
      n.classList.remove("vttk-chat-vide");
    });
    var lab = intituleDeRoll20();
    if (lab && lab.getAttribute("data-vttk-avant")) {
      lab.textContent = lab.getAttribute("data-vttk-avant");
      lab.removeAttribute("data-vttk-avant");
      lab.classList.remove("vttk-chat-de");
    }
    if (notreLigne && notreLigne.parentNode) { notreLigne.parentNode.removeChild(notreLigne); }
    notreLigne = null;
    notreSelect = null;
    destinataire = "";
    if (guet) { clearInterval(guet); guet = null; }
  }

  VTT.module({
    id: "chat",
    portee: "editeur",

    demarre: function () {
      actif = true;
      if (!branche) {
        branche = true;

        VTT.surPage("chat-joueurs", function (d) {
          joueurs = d.joueurs || [];
          moi = d.moi || null;
          if (pose()) { remplitSelect(); }
        });

        VTT.surPage("chat-resultat", function (d) {
          if (!d.ok) { return; }
          pontPret = true;
          VTT.log("chat :", d.joueurs, "joueur(s) à la table");
        });

        /* L'ENVOI SE PREND EN CAPTURE, SUR LE DOCUMENT — et pas sur le champ.
         *
         * Roll20 refait son pied de chat : un écouteur posé sur le champ
         * disparaîtrait avec lui, sans un mot. En capture sur le document, le
         * nôtre passe AVANT le sien quel que soit le champ du moment — ce qui
         * est exactement l'ordre qu'il faut : on écrit le préfixe, puis Roll20
         * lit le champ et l'envoie. */
        document.addEventListener("keydown", function (ev) {
          if (!notreLigne || !destinataire) { return; }
          if (ev.key !== "Enter" && ev.keyCode !== 13) { return; }
          if (ev.shiftKey) { return; }   // saut de ligne, pas un envoi
          var z = document.querySelector(SEL_SAISIE);
          if (!z || ev.target !== z) { return; }
          prefixeAvantEnvoi();
        }, true);

        document.addEventListener("click", function (ev) {
          if (!notreLigne || !destinataire) { return; }
          var b = ev.target;
          while (b && b !== document.body) {
            if (b.matches && b.matches(SEL_ENVOI)) { prefixeAvantEnvoi(); return; }
            b = b.parentNode;
          }
        }, true);

        /* LE PANNEAU D'ÉMOJIS SE FERME COMME TOUT MENU : Échap, ou un clic
         * ailleurs. Les deux écouteurs sont posés une seule fois, avec les
         * autres, et sortent tout de suite si rien n'est ouvert.
         *
         * Échap n'est consommé QUE si l'on a effectivement fermé quelque chose.
         * Roll20 s'en sert aussi — désélectionner un jeton, fermer une fenêtre —
         * et le lui prendre quand on n'avait rien à fermer serait lui voler une
         * touche. */
        document.addEventListener("keydown", function (ev) {
          if (!panneau) { return; }
          if (ev.key !== "Escape" && ev.keyCode !== 27) { return; }
          fermeEmojis();
          ev.preventDefault();
          ev.stopPropagation();
        }, true);

        document.addEventListener("mousedown", function (ev) {
          if (!panneau) { return; }
          var n = ev.target;
          while (n && n !== document.body) {
            /* Le bouton se garde lui-même : il bascule, et se fermer ici en
             * plus le rouvrirait aussitôt. */
            if (n === panneau || (n.classList && n.classList.contains("vttk-chat-emoji"))) { return; }
            n = n.parentNode;
          }
          fermeEmojis();
        }, true);

        /* Un panneau en position fixe ne suit pas une fenêtre qu'on
         * redimensionne. Le premier jet le FERMAIT — ce qui se défendait tant
         * qu'il flottait n'importe où, et ne se défend plus depuis qu'il se cale
         * exactement sur le champ : on sait où il doit aller, donc on l'y met. */
        window.addEventListener("resize", function () { if (panneau) { placePanneau(); } });
      }

      litRecents();

      /* ON REDEMANDE JUSQU'À CE QUE LE PONT RÉPONDE, et c'est ce qui manquait.
       *
       * `injectePont` est asynchrone : le premier `versPage` part dans le vide,
       * personne ne l'écoute encore, et rien ne le renvoyait jamais. Le
       * sélecteur ne proposait donc que « tout le monde » et « MJ » — pour
       * toujours, sur une table de cinq joueurs. C'est le même guet que celui du
       * module des marqueurs, et pour exactement la même raison.
       *
       * Le même battement sert à (re)poser la ligne : le pied de chat se monte
       * après la page, et Roll20 le refait de temps à autre. */
      VTT.injectePont();
      pontPret = false;
      if (guet) { clearInterval(guet); }
      var tours = 0;
      guet = setInterval(function () {
        tours++;
        pose();
        /* ON CESSE DE REDEMANDER LE PONT au bout d'une minute : s'il n'a pas
         * répondu, il ne répondra pas. Mais LE GUET DE POSE NE MEURT PAS —
         * Roll20 peut reprendre sa zone à n'importe quel moment d'une partie de
         * quatre heures. Un premier jet l'arrêtait à cent soixante secondes tout
         * en promettant le contraire en commentaire : passé ce délai, on aurait
         * chuchoté sans que rien ne l'affiche. */
        if (!pontPret && tours < 150) { VTT.versPage({ type: "chat", actif: true }); }
      }, 400);
      VTT.versPage({ type: "chat", actif: true });
      pose();
    },

    /* CHANGER DE LANGUE REPOSE LES INTITULÉS. On ne démonte pas : le guet
     * repose la ligne à chaque tour de toute façon, et le sélecteur de
     * destinataire, lui, se remplit à nouveau — c'est le seul qui porte du
     * texte qu'un simple repositionnement ne rafraîchirait pas. */
    change: function (cles) {
      if (cles.indexOf("reg:langue") < 0) { return; }
      fermeEmojis();
      var lab = intituleDeRoll20();
      if (lab && lab.getAttribute("data-vttk-avant")) { lab.textContent = VTT.mot("chat.de"); }
      var et = document.querySelector(".vttk-chat-etiquette");
      if (et) { et.textContent = VTT.mot("chat.a"); }
      if (notreSelect) { remplitSelect(); }
      var b = document.querySelector(".vttk-chat-emoji");
      if (b) { b.title = VTT.mot("chat.emojis"); b.setAttribute("aria-label", VTT.mot("chat.emojis")); }
    },

    arrete: function () {
      /* LE DRAPEAU TOMBE EN PREMIER, avant même de prévenir le pont : c'est ce
       * qui ferme la fenêtre pendant laquelle un message en vol pourrait tout
       * remonter. */
      actif = false;
      VTT.versPage({ type: "chat", actif: false });
      ote();
    }
  });
})();
