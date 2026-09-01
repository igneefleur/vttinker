/* LE CATALOGUE DES MODULES — source unique, chargée des DEUX côtés.
 *
 * Le popup dessine ses réglages à partir de ce fichier, et le script de contenu
 * décide à partir du même quoi démarrer. Une seule liste, donc jamais de case à
 * cocher qui ne commande plus rien, ni de module allumé qu'aucune case ne montre.
 *
 * AJOUTER UNE FEATURE, C'EST TROIS GESTES ET PAS UN DE PLUS :
 *   1. une entrée ici ;
 *   2. un fichier contenu/modules/<id>.js qui appelle VTT.module({ id, demarre }) ;
 *   3. une ligne de plus dans content_scripts.js du manifeste.
 * Le popup, le stockage et le cycle de vie suivent tout seuls.
 *
 * ES5, global, sans module : un script de contenu ne s'importe pas, et une page
 * d'extension ne peut pas porter de script en ligne (CSP script-src 'self').
 *
 * PLUS AUCUNE DESCRIPTION, ET C'EST UNE DEMANDE EXPLICITE. Chaque module
 * portait un résumé de deux lignes expliquant ce qu'il fait ; ils ont été
 * retirés d'un bloc. Un intitulé qui a besoin d'un paragraphe est un intitulé
 * mal choisi, et une liste de réglages n'est pas un endroit où l'on vient lire.
 *
 * LES NOMS SONT DES CLÉS, PAS DU TEXTE. « mod.zoom » se traduit dans
 * commun/langue.js : écrire le libellé ici en obligerait deux à vivre côte à
 * côte, et c'est toujours le second qui finit par mentir.
 *
 * LES CLÉS DE RÉGLAGE SONT PUBLIQUES ET DÉFINITIVES. Elles sont déjà posées dans
 * le stockage des utilisateurs dès la première version : renommer « zoomMin »
 * ne migre rien, ça oublie le réglage sans rien dire.
 */
var VTT_CATALOGUE = [
  {
    id: "zoom",
    nom: "mod.zoom",
    defaut: true,
    // « editeur » : la page de la partie et elle seule (pas les popouts de fiche,
    // pas les iframes). Le socle s'en sert pour ne pas réveiller un module là où
    // il n'a rien à faire.
    portee: "editeur",
    /* IL N'Y A PAS DE RÉGLAGE « MASQUER LE CONTRÔLE DE ROLL20 », et il n'y en a
     * plus besoin. Le masquage reste INDISPENSABLE — mesuré : affiché, son
     * contrôle repousse le zoom dans SA plage en moins de soixante
     * millisecondes, dans les deux sens —, mais il est devenu GRATUIT : le
     * module rend à sa place une commande de mêmes dimensions, aux mêmes
     * couleurs et à la même place. Il n'y a donc plus d'arbitrage à soumettre,
     * et une case qui n'ouvre aucun choix n'est pas un réglage, c'est une
     * corvée. Le pont masque de lui-même quand les bornes sortent de celles de
     * Roll20, et lui rend son réglage intact à l'extinction. */
    reglages: [
      { cle: "zoomMin", libelle: "reg.zoomMin", type: "nombre", defaut: 10,  min: 1,   max: 100,  pas: 1,  unite: "unite.pourcent" },
      { cle: "zoomMax", libelle: "reg.zoomMax", type: "nombre", defaut: 250, min: 100, max: 2000, pas: 10, unite: "unite.pourcent" }
    ]
  },

  {
    id: "grille",
    nom: "mod.grille",
    defaut: true,
    portee: "editeur",
    /* UN SEUL RÉGLAGE, ET C'EST UNE DISTANCE. Le pas est la case de la page —
     * soixante-dix pixels sur celle qui a servi de mesure, mais le pont le
     * CALCULE à partir de la grille elle-même : une page à l'échelle différente
     * étend la sienne de ses propres cases.
     *
     * LE DÉFAUT EST LARGE, ET IL PEUT L'ÊTRE. Les cinq types sont désormais
     * PEINTS : un quad de six sommets et un shader, comme Roll20 le fait pour sa
     * grille carrée. Quatre cents cases coûtent exactement ce que dix coûtent,
     * puisque le prix est celui de la surface à l'écran et pas du halo.
     *
     * Ça n'a pas toujours été vrai, et ça s'est payé : quand on répétait la
     * géométrie, soixante cases donnaient 232 000 segments sur l'hexagone et
     * l'affichage ramait. Le repli en segments existe encore pour une machine où
     * le shader ne compilerait pas — lui garde son budget de travail, et prévient
     * quand il doit raboter le halo. */
    reglages: [
      { cle: "grilleCases", libelle: "reg.grilleCases", type: "nombre",
        defaut: 60, min: 0, max: 400, pas: 10, unite: "unite.cases" }
    ]
  },

  {
    id: "marqueurs",
    nom: "mod.marqueurs",
    defaut: true,
    portee: "editeur",
    /* LES IDENTIFIANTS NE SUIVENT PAS LE RENOMMAGE. Le module s'appelle
     * désormais « marqueurs » dans tout ce qui se lit — « jeton », dans
     * l'interface française de Roll20, désigne un TOKEN, et employer le même mot
     * pour ce qu'on pose dessus entretenait une confusion. Mais `id: "marqueurs"`
     * et `cle: "marqueursPerso"` deviennent `mod:marqueurs` et `reg:marqueursPerso` dans
     * le stockage : les renommer effacerait la palette et l'état d'allumage de
     * tous ceux qui en ont.
     *
     * LE CATALOGUE PASSE PAR LE MÊME CHEMIN QUE LES AUTRES RÉGLAGES, et ce n'est
     * pas de la paresse : le stockage prévient déjà tous les onglets d'un
     * changement, le module reçoit déjà « change », et le panneau lit déjà les
     * défauts ici. Un rangement à part aurait redemandé les trois.
     *
     * `storage.local` survit au nettoyage des cookies et des données de site —
     * seule la désinstallation l'efface (MDN, storage.local). C'est la palette
     * PERSONNELLE ; les autres joueurs, eux, n'en ont pas besoin : l'étiquette
     * porte l'adresse de l'image, donc elle se suffit à elle-même. */
    reglages: [
      { cle: "marqueursPerso", libelle: "reg.marqueursPerso", type: "marqueurs", defaut: [] },
      /* LE MODE DE POSE, ET IL MANQUAIT AU CATALOGUE.
       *
       * La palette l'écrit dans le stockage et le relit dans VTT.reglages —
       * mais VTT.reglages ne porte que ce que le catalogue déclare. Il n'était
       * donc JAMAIS rechargé : chaque ouverture de partie repartait sur le mode
       * par défaut, alors que le code avait l'air de le retenir.
       *
       * « cache: true » : il se règle depuis la palette, dans la partie, et non
       * depuis le panneau — l'y afficher donnerait deux commandes pour un seul
       * réglage. */
      { cle: "marqueursMode", libelle: "reg.marqueursMode", type: "texte",
        defaut: "marqueur", cache: true }
    ]
  },

  {
    id: "horsPage",
    nom: "mod.horsPage",
    defaut: true,
    portee: "editeur",
    /* AUCUN RÉGLAGE : il n'y a rien à doser. Le nuanceur de Roll20 jette ou ne
     * jette pas ce qui déborde de la page, et le module retire ce rejet. Un
     * curseur n'aurait aucune position intermédiaire à offrir.
     *
     * CHEZ LE MJ, IL NE FAIT RIEN. Roll20 lui donne déjà le drapeau que ce
     * module pose ; l'allumer ou l'éteindre ne change pas un pixel de son écran.
     * Il reste visible dans la liste pour la même raison que les autres : une
     * case qui disparaît selon le rôle est une case dont on se demande où elle
     * est passée. */
    reglages: []
  },

  {
    id: "chat",
    nom: "mod.chat",
    defaut: true,
    portee: "editeur",
    /* AUCUN RÉGLAGE, ET C'EST VOULU. Le destinataire est un état de travail, pas
     * une préférence : il se choisit dans le chat, pour le message qu'on est en
     * train d'écrire, et le retrouver au rechargement serait un piège — on
     * chuchoterait sans le savoir à quelqu'un choisi la veille.
     *
     * IL RETOMBE DONC SUR « TOUT LE MONDE » À CHAQUE CHARGEMENT. C'est le seul
     * défaut sûr : un message public envoyé par erreur se voit et se corrige,
     * un message privé envoyé au mauvais destinataire, non. */
    reglages: []
  }
];

/* ---------- CE QUI N'APPARTIENT À AUCUN MODULE ----------
 *
 * Deux réglages ne sont pas des features : ils commandent l'extension entière.
 * Ils passent par les MÊMES clés de stockage que les autres — donc par le même
 * chemin de lecture, la même notification à tous les onglets, le même « change »
 * chez les modules. Rien de neuf à écrire, nulle part.
 *
 * L'INTERRUPTEUR GÉNÉRAL EST DANS LA FENÊTRE DE L'EXTENSION, PAS DANS LA
 * PARTIE. C'est la séparation demandée : la fenêtre du navigateur dit si
 * l'extension existe, la boîte à outils dit ce qu'elle fait. Éteinte, aucun
 * module ne démarre et le bouton de la boîte à outils disparaît — il n'y a rien
 * à régler pour une extension qui ne tourne pas.
 *
 * LA LANGUE VAUT « en » PAR DÉFAUT. Roll20 est une table anglophone ;
 * l'extension s'y greffe. */
var VTT_REGLAGES_GLOBAUX = [
  { cle: "actif",  defaut: true },
  { cle: "langue", defaut: VTT_LANGUE_DEFAUT },
  { cle: "theme",  defaut: VTT_THEME_DEFAUT }
];

/* Le défaut d'un réglage, lu au même endroit par la fenêtre, le panneau et les
 * modules : deux tables de défauts finissent toujours par diverger. */
function vttDefauts() {
  var out = {};
  VTT_REGLAGES_GLOBAUX.forEach(function (r) { out["reg:" + r.cle] = r.defaut; });
  VTT_CATALOGUE.forEach(function (m) {
    out["mod:" + m.id] = m.defaut !== false;
    (m.reglages || []).forEach(function (r) { out["reg:" + r.cle] = r.defaut; });
  });
  return out;
}

/* La langue en vigueur, lue dans un état déjà chargé. Elle passe par
 * vttLangueValide, donc une valeur inconnue retombe sur le défaut. */
function vttLangueDe(etat) {
  return vttLangueValide(etat && etat["reg:langue"]);
}

/* Le thème en vigueur, lu dans un état déjà chargé. */
function vttThemeDe(etat) {
  return vttThemeValide(etat && etat["reg:theme"]);
}

/* L'extension est-elle allumée ? Absent vaut ALLUMÉ : une extension fraîchement
 * installée doit fonctionner, et un stockage qui répond mal ne doit pas la
 * faire disparaître sans un mot. */
function vttActif(etat) {
  return !etat || etat["reg:actif"] !== false;
}

/* Toutes les clés que le stockage peut porter, pour une lecture unique.
 * Une lecture par réglage, ce serait autant d'instants différents, donc autant
 * d'occasions de se contredire à l'écran. */
function vttCles() { return Object.keys(vttDefauts()); }
