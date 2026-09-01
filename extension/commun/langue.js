/* LA LANGUE — un seul dictionnaire, chargé des deux côtés.
 *
 * L'ANGLAIS EST LE DÉFAUT, et ce n'est pas un choix de goût : Roll20 est une
 * table anglophone, l'extension s'y greffe, et quelqu'un qui l'installe sans
 * rien régler doit lire la même langue que le reste de sa page.
 *
 * LE CHOIX SE RANGE COMME LES MARQUEURS — dans `browser.storage.local`, sous
 * une clé de réglage ordinaire. Il traverse donc les mêmes chemins que tout le
 * reste : le stockage prévient tous les onglets ouverts, les modules reçoivent
 * déjà « change », et le panneau lit déjà les défauts au même endroit. Un
 * rangement à part aurait redemandé les trois.
 *
 * UNE CLÉ ABSENTE REND SA PROPRE CLÉ, et jamais du vide. Un intitulé manquant
 * doit se voir dans l'interface — « chat.de » à l'écran est laid et se corrige ;
 * une étiquette vide passe inaperçue jusqu'à ce qu'un utilisateur la signale.
 *
 * ES5, global, sans module : un script de contenu ne s'importe pas, et une page
 * d'extension ne peut pas porter de script en ligne (CSP script-src 'self').
 */

var VTT_LANGUES = ["en", "fr"];
var VTT_LANGUE_DEFAUT = "en";

/* Le nom de chaque langue DANS SA PROPRE LANGUE : c'est la seule façon qu'un
 * sélecteur de langue soit lisible par quelqu'un qui ne comprend pas celle qui
 * est active. */
var VTT_LANGUE_NOMS = { en: "English", fr: "Français" };

/* ---------- LES TROIS THÈMES ----------
 *
 * « auto » NE VEUT PAS DIRE LA MÊME CHOSE DES DEUX CÔTÉS, et c'est voulu :
 *
 *   · dans la FENÊTRE du navigateur, il n'y a pas de Roll20 à suivre — on suit
 *     donc le réglage du navigateur (prefers-color-scheme) ;
 *   · dans le PANNEAU, posé sur une partie, suivre le navigateur serait absurde
 *     quand Roll20 est en clair juste derrière. On suit donc ROLL20, dont le
 *     pont sait déjà lire le thème et le dit au cadre.
 *
 * « jour » et « nuit », eux, valent partout et ne demandent rien à personne. */
var VTT_THEMES = ["auto", "jour", "nuit"];
var VTT_THEME_DEFAUT = "auto";

function vttThemeValide(t) {
  return VTT_THEMES.indexOf(String(t)) >= 0 ? String(t) : VTT_THEME_DEFAUT;
}

var VTT_MOTS = {
  en: {
    /* ---------- la fenêtre de l'extension ---------- */
    "app.etat":        "VTTinker",
    "app.langue":      "Language",
    "app.theme":       "Theme",
    "theme.auto":      "Automatic",
    "theme.jour":      "Day",
    "theme.nuit":      "Night",
    "app.version":     "Version",
    "app.site":        "Website",
    "app.soutien":     "Support",
    "app.bientot":     "coming soon",

    /* ---------- le panneau, dans la partie ---------- */
    "pan.titre":       "VTTinker",
    "pan.eteint":      "VTTinker is off.",
    "pan.horsPartie":  "Open a Roll20 game.",

    /* ---------- les modules ---------- */
    "mod.zoom":        "Zoom range",
    "mod.grille":      "Grid beyond the page",
    "mod.marqueurs":   "Custom markers",
    "mod.horsPage":    "Tokens off the map",
    "mod.chat":        "Chat footer",

    /* ---------- les réglages ---------- */
    "reg.zoomMin":     "Minimum",
    "reg.zoomMax":     "Maximum",
    "reg.grilleCases": "Squares around",
    "reg.marqueursPerso": "Your markers",
    "unite.pourcent":  "%",
    "unite.cases":     "squares",

    /* ---------- les marqueurs ----------
     * L'ÉDITION N'EST PAS DANS LE PANNEAU, et c'est une décision antérieure
     * qu'on ne défait pas : elle se fait dans la palette, sur la carte, à côté
     * des marqueurs de Roll20 et du jeton qu'on vise. Deux formulaires pour la
     * même liste, ce sont deux formulaires à tenir d'accord — et le jour où ils
     * divergent, personne ne sait plus lequel dit vrai. Ici on voit ce qu'on a,
     * et on lit où ça se règle. */
    "mq.nom":          "name",
    "mq.vide":         "none yet",
    "mq.compte":       "markers",
    "mq.ou":           "Add and remove them in the markers palette, in the toolbar.",
    "reg.bornes":      "Minimum must stay below maximum.",

    /* ---------- le pied de chat ---------- */
    "chat.de":         "From:",
    "chat.a":          "To:",
    "chat.tous":       "Everyone",
    "chat.mj":         "GM",
    "chat.envoyer":    "Send",
    "chat.ajouter":    "Add",
    "chat.emojis":     "Emojis",
    "chat.gif":        "GIF",
    "chat.recents":    "Recent",
    "chat.rienEncore": "Nothing yet. Emojis you pick land here.",

    /* ---------- les catégories d'émojis ---------- */
    "emo.visages":     "Smileys & Emotion",
    "emo.gens":        "People & Body",
    "emo.nature":      "Animals & Nature",
    "emo.nourriture":  "Food & Drink",
    "emo.lieux":       "Travel & Places",
    "emo.activites":   "Activities",
    "emo.objets":      "Objects",
    "emo.symboles":    "Symbols",

    /* ---------- la commande de zoom ---------- */
    "zoom.titre":      "Zoom",
    "zoom.plus":       "Zoom in",
    "zoom.moins":      "Zoom out",
    "zoom.reglages":   "VTTinker settings",

    /* ---------- la palette de marqueurs ---------- */
    "pal.titre":       "Markers",
    "pal.fermer":      "Close the palette",
    "pal.maniere":     "How markers are placed",
    "pal.mode1":       "Marker first, then tokens",
    "pal.mode2":       "Tokens first, then marker",
    "pal.nom":         "Marker name",
    "pal.url":         "Image address",
    "pal.ajoute":      "Add this marker",
    "pal.retire":      "Remove",
    "pal.editer":      "Add, remove, reorder",
    "pal.editerFin":   "Done editing",
    "pal.mode1":       "Marker \u2192 tokens",
    "pal.mode1Aide":   "Pick a marker, then click the tokens.",
    "pal.mode2":       "Tokens \u2192 marker",
    "pal.mode2Aide":   "Select tokens, then one click on a marker marks them all.",
    "pal.pasAVous":    "is not yours — Roll20 would refuse the marker.",
    "pal.choisisJetons": "Select one or more tokens on the map first.",
    "pal.vide":        "Your palette is empty. Open the palette in the toolbar to add markers.",
    "pal.echec":       "Markers could not be drawn"
  },

  fr: {
    "app.etat":        "VTTinker",
    "app.langue":      "Langue",
    "app.theme":       "Thème",
    "theme.auto":      "Automatique",
    "theme.jour":      "Jour",
    "theme.nuit":      "Nuit",
    "app.version":     "Version",
    "app.site":        "Site",
    "app.soutien":     "Soutenir",
    "app.bientot":     "à venir",

    "pan.titre":       "VTTinker",
    "pan.eteint":      "VTTinker est éteint.",
    "pan.horsPartie":  "Ouvre une partie Roll20.",

    "mod.zoom":        "Bornes du zoom",
    "mod.grille":      "Grille hors carte",
    "mod.marqueurs":   "Marqueurs personnalisés",
    "mod.horsPage":    "Jetons hors carte",
    "mod.chat":        "Pied de chat",

    "reg.zoomMin":     "Minimum",
    "reg.zoomMax":     "Maximum",
    "reg.grilleCases": "Cases autour",
    "reg.marqueursPerso": "Vos marqueurs",
    "unite.pourcent":  "%",
    "unite.cases":     "cases",

    "mq.nom":          "nom",
    "mq.vide":         "aucun pour l'instant",
    "mq.compte":       "marqueurs",
    "mq.ou":           "L'ajout et le retrait se font dans la palette de marqueurs, dans la boîte à outils.",
    "reg.bornes":      "Le minimum doit rester sous le maximum.",

    "chat.de":         "De :",
    "chat.a":          "À :",
    "chat.tous":       "Tout le monde",
    "chat.mj":         "MJ",
    "chat.envoyer":    "Envoyer",
    "chat.ajouter":    "Ajouter",
    "chat.emojis":     "Émojis",
    "chat.gif":        "GIF",
    "chat.recents":    "Récents",
    "chat.rienEncore": "Rien encore. Les émojis choisis se rangent ici.",

    "emo.visages":     "Visages et émotions",
    "emo.gens":        "Gens et gestes",
    "emo.nature":      "Animaux et nature",
    "emo.nourriture":  "Nourriture et boissons",
    "emo.lieux":       "Voyage et lieux",
    "emo.activites":   "Activités",
    "emo.objets":      "Objets",
    "emo.symboles":    "Symboles",

    "zoom.titre":      "Zoom",
    "zoom.plus":       "Zoomer",
    "zoom.moins":      "Dézoomer",
    "zoom.reglages":   "Réglages de VTTinker",

    "pal.titre":       "Marqueurs",
    "pal.fermer":      "Fermer la palette",
    "pal.maniere":     "Manière de poser les marqueurs",
    "pal.mode1":       "Le marqueur d'abord, puis les jetons",
    "pal.mode2":       "Les jetons d'abord, puis le marqueur",
    "pal.nom":         "Nom du marqueur",
    "pal.url":         "Adresse de l'image",
    "pal.ajoute":      "Ajouter ce marqueur",
    "pal.retire":      "Retirer",
    "pal.editer":      "Ajouter, supprimer, trier",
    "pal.editerFin":   "Terminer l'édition",
    "pal.mode1":       "Marqueur \u2192 jetons",
    "pal.mode1Aide":   "On choisit un marqueur, puis on clique les jetons.",
    "pal.mode2":       "Jetons \u2192 marqueur",
    "pal.mode2Aide":   "On sélectionne des jetons, puis un clic sur un marqueur les marque tous.",
    "pal.pasAVous":    "ne vous appartient pas — Roll20 refuserait la pose.",
    "pal.choisisJetons": "Sélectionnez d'abord un ou plusieurs jetons sur la carte.",
    "pal.vide":        "Votre palette est vide. Ouvrez la palette dans la barre d'outils pour y ajouter des marqueurs.",
    "pal.echec":       "Les marqueurs n'ont pas pu être dessinés"
  }
};

/* Une langue qu'on ne connaît pas retombe sur le défaut, sans un mot : une
 * valeur écrite par une version ultérieure, ou par une main, ne doit pas vider
 * l'interface. */
function vttLangueValide(l) {
  return VTT_LANGUES.indexOf(String(l)) >= 0 ? String(l) : VTT_LANGUE_DEFAUT;
}

function vttMot(cle, langue) {
  var t = VTT_MOTS[vttLangueValide(langue)] || VTT_MOTS[VTT_LANGUE_DEFAUT];
  var v = t[cle];
  if (v === undefined) { v = (VTT_MOTS[VTT_LANGUE_DEFAUT] || {})[cle]; }
  return v === undefined ? String(cle) : v;
}
