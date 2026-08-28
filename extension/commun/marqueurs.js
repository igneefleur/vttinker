/* LES MARQUEURS PERSONNALISÉS — le modèle, et lui seul.
 *
 * Ce fichier est chargé des DEUX côtés, comme le catalogue des modules : le
 * panneau s'en sert pour analyser ce qu'on colle, le script de contenu pour
 * relire ce qui a été enregistré. Une seule définition de ce qu'est un marqueur,
 * donc jamais deux idées divergentes de ce qui est valide.
 *
 * CE QU'EST UN MARQUEUR, ICI : { tag, nom, url }.
 *   - `tag` est ce qui voyage dans le champ « statusmarkers » de Roll20, que
 *     Roll20 diffuse à tous les joueurs et que son propre menu préserve — sa
 *     fonction toggleTokenMarker travaille en delta, c'est mesuré. Il est
 *     préfixé pour qu'on reconnaisse les nôtres et qu'ils ne puissent jamais
 *     entrer en collision avec les siens.
 *   - `url` est une image, chargée telle quelle dans la scène Babylon. Roll20
 *     accepte les domaines étrangers : mesuré sur cdn.discordapp.com, en
 *     <img>, en crossOrigin et en texture.
 *
 * ES5, global, sans module : un script de contenu ne s'importe pas, et une page
 * d'extension ne peut pas porter de script en ligne.
 */

/* ---------- L'ÉTIQUETTE PORTE L'ADRESSE, ET C'EST TOUT LE PROPOS ----------
 *
 * Forme : « vttk_<nom>_<adresse sans https://> ».
 *
 * L'ancienne forme (« vt-<nom> ») ne disait QUE le nom : pour savoir quelle
 * image dessiner, il fallait un catalogue partagé — un document de campagne à
 * créer, à fusionner, à faire converger, et que seul un MJ peut écrire. Une
 * étiquette qui porte son adresse rend tout cela inutile : n'importe quel joueur
 * ayant l'extension voit le marqueur, immédiatement, sans rien avoir à recevoir.
 *
 * CE N'EST PAS UNE SUPPOSITION. Mesuré sur une vraie partie : une étiquette de
 * 70 caractères est écrite, relue et renvoyée INTACTE par Roll20, quatre
 * secondes plus tard comme aussitôt ; trois marqueurs d'un coup (180 caractères)
 * de même. Les « ? », « = », « / » et « . » d'une adresse passent sans dommage.
 *
 * LE DÉCOUPAGE EST NON AMBIGU parce que le NOM s'interdit le souligné : le
 * premier après « vttk » ferme le préfixe, le second ferme le nom, et tout ce
 * qui suit est l'adresse — soulignés compris.
 *
 * Le schéma est retiré parce qu'il est toujours le même : on n'accepte que
 * https, donc l'écrire coûterait huit caractères par marqueur pour rien. */
var VTT_MARQUEUR_PREFIXE = "vttk_";

/* IL N'Y A QU'UNE FORME, ET IL N'Y EN A JAMAIS EU DEUX QUI COMPTENT.
 *
 * Une compatibilité avec l'ancienne « vt-<nom> » a existé quelques heures, le
 * temps de croire qu'il fallait ménager des marqueurs déjà posés. L'extension
 * n'a jamais eu d'utilisateur hors de son auteur : il n'y avait rien à ménager,
 * et deux formats à lire, c'est deux chemins à tenir d'accord pour rien.
 *
 * Une étiquette qui ne commence pas par « vttk_ » n'est donc pas à nous — Roll20
 * l'ignore de son côté, nous du nôtre, et personne ne dessine rien. */

/* Le nom, réduit à ce qui traverse tout : Roll20 découpe le champ sur les
 * virgules et coupe après « @ » pour y lire un compteur. On s'interdit les deux,
 * ET le souligné, qui sert ici de séparateur. */
function vttMarqueurNomPropre(nom) {
  return String(nom || "")
    .toLowerCase()
    .replace(/[àâä]/g, "a").replace(/[éèêë]/g, "e").replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o").replace(/[ùûü]/g, "u").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function vttMarqueurEtiquette(nom, url) {
  var s = vttMarqueurNomPropre(nom);
  var u = vttMarqueurUrlValide(url);
  if (!s || !u) { return ""; }
  return VTT_MARQUEUR_PREFIXE + s + "_" + u.replace(/^https:\/\//i, "");
}

/* Relire une étiquette, et n'en croire que ce qui se vérifie. Elle vient des
 * données de la campagne, donc d'autres joueurs : on la revalide entièrement,
 * comme si on la recevait pour la première fois. */
function vttMarqueurDepuisEtiquette(tag) {
  var t = String(tag || "");
  if (t.indexOf(VTT_MARQUEUR_PREFIXE) !== 0) { return null; }
  var reste = t.slice(VTT_MARQUEUR_PREFIXE.length);
  var coupe = reste.indexOf("_");
  if (coupe <= 0) { return null; }
  var nom = reste.slice(0, coupe);
  if (!/^[a-z0-9-]{1,24}$/.test(nom)) { return null; }
  var url = vttMarqueurUrlValide("https://" + reste.slice(coupe + 1));
  if (!url) { return null; }
  return { tag: t, nom: nom, url: url };
}

/* UNE URL, ET RIEN QU'UNE URL D'IMAGE EN HTTPS.
 *
 * On refuse « javascript: » et consorts pour des raisons évidentes, mais aussi
 * « http: » — la page de Roll20 est en HTTPS, et un navigateur bloque le contenu
 * mixte sans rien dire à personne : le marqueur serait simplement invisible, et
 * introuvable. Mieux vaut refuser à la saisie qu'échouer en silence.
 *
 * « data: » est refusé aussi, pour l'instant : une image en clair dans le champ
 * ne se partage pas raisonnablement avec les autres joueurs. */
function vttMarqueurUrlValide(url) {
  var u = String(url || "").trim();
  /* UN HÔTE PLAUSIBLE, ET UN CHEMIN. Le premier jet se contentait de
   * « commence par https:// et ne contient ni espace ni chevron » — et laissait
   * donc passer « https://javascript:alert(1) », qui n'est pas une adresse
   * d'image mais coche toutes les cases. Inoffensif (Babylon échouerait à la
   * charger) mais ça n'a rien à faire dans les données d'une campagne. On exige
   * un nom d'hôte pointé, un port éventuel, et un chemin. */
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?\/[^\s"'<>]*$/i.test(u)) { return null; }
  /* NI VIRGULE, NI AROBASE, désormais interdits pour de bon : l'adresse voyage
   * DANS l'étiquette, et Roll20 découpe ce champ sur les virgules et coupe après
   * « @ » pour y lire un compteur. Une adresse qui en porterait couperait
   * l'étiquette en deux, et le marqueur deviendrait deux marqueurs fantômes.
   * Aucune des deux n'a d'usage courant dans une adresse d'image. */
  if (u.indexOf(",") >= 0 || u.indexOf("@") >= 0) { return null; }
  /* 240, et non 500 : l'étiquette entière part dans les données de la campagne,
   * plusieurs fois par token. Une adresse plus longue que ça est de toute façon
   * suspecte pour une image de dix-neuf pixels. */
  if (u.length > 240) { return null; }
  return u;
}

/* Le nom lisible qu'on déduit d'une URL quand l'utilisateur n'en donne pas :
 * le dernier segment du chemin, sans extension ni paramètres.
 *
 * CAS PARTICULIER, ET C'EST LE PRINCIPAL. Une URL d'emote Discord ressemble à
 * .../emojis/123456789.webp : son nom de fichier est un identifiant, pas un
 * nom. Le premier jet refusait donc l'usage même pour lequel on écrit ce
 * module. On ne rejette pas une image valide faute de savoir la nommer : on
 * l'appelle par son identifiant, ce qui donne une étiquette STABLE — recoller
 * la même URL demain rendra la même —, et l'utilisateur la renomme s'il veut. */
function vttMarqueurNomDepuisUrl(url) {
  try {
    var chemin = String(url).split("?")[0].split("#")[0];
    var bout = chemin.split("/").pop() || "";
    bout = bout.replace(/\.[a-z0-9]{1,5}$/i, "");
    if (!bout) { return ""; }
    return /^[0-9]+$/.test(bout) ? "e" + bout : bout;
  } catch (e) { return ""; }
}

/* ---------- UN NOM ET UNE ADRESSE DEVIENNENT UN MARQUEUR ----------
 *
 * C'EST LE SEUL ENDROIT OÙ CE PASSAGE SE FAIT, et il y a maintenant deux portes
 * qui y mènent : le formulaire de la palette — deux champs et un bouton « + » —
 * et le collage de plusieurs lignes. Si chacune décidait pour son compte de ce
 * qu'est un nom acceptable, les deux divergeraient au premier cas tordu.
 *
 * On rend soit { marqueur }, soit { raison } — jamais rien de muet. Un
 * formulaire qui avale une saisie sans un mot est un formulaire qui ment. */
function vttMarqueurDepuisChamps(nom, url, existants) {
  var brut = String(url || "").trim();
  var propre = vttMarqueurUrlValide(brut);
  if (!propre) {
    /* UN CODE À CÔTÉ DE LA PHRASE, et pas à sa place. La phrase est celle que
     * le banc d'essai lit et que les relevés portent depuis le début ; le code,
     * lui, est ce que l'interface traduit. Remplacer l'une par l'autre aurait
     * cassé les deux. */
    return !brut ? { code: "sansAdresse", raison: "il faut une adresse d'image" }
         : /^http:/i.test(brut) ? { code: "http", raison: "http n'est pas accepté, il faut https" }
         : /^data:/i.test(brut) ? { code: "data", raison: "les images en data: ne se partagent pas" }
         : { code: "pasHttps", raison: "ce n'est pas une URL https" };
  }

  /* LE NOM EST FACULTATIF : sans lui on le tire de l'adresse, ce qui est le cas
   * courant quand on colle une emote. Il n'y a d'échec que si l'adresse elle-même
   * n'en fournit aucun — une adresse qui finit par « / », par exemple. */
  var n = String(nom || "").trim();
  var tag = vttMarqueurEtiquette(n || vttMarqueurNomDepuisUrl(propre), propre);
  if (!tag) { return { code: "sansNom", raison: "impossible d'en tirer un nom : donnez-en un" }; }

  var lu = vttMarqueurDepuisEtiquette(tag);
  /* ON RELIT CE QU'ON VIENT D'ÉCRIRE. L'étiquette porte l'adresse : si elle ne
   * se relit pas, le marqueur ne se dessinerait chez personne — et il vaut mieux
   * l'apprendre à la saisie que le découvrir sur la carte. */
  if (!lu) { return { code: "tropLongue", raison: "cette adresse ne tient pas dans une étiquette" }; }

  /* DEUX ADRESSES IDENTIQUES DONNENT LA MÊME ÉTIQUETTE, et c'est voulu :
   * l'étiquette EST l'adresse plus le nom. Resaisir la même ne crée donc pas un
   * doublon, elle retombe sur le même marqueur — ce qui vaut mieux qu'une
   * numérotation qui multiplierait les marqueurs identiques. Deux images
   * DIFFÉRENTES portant le même nom, elles, se distinguent d'elles-mêmes par
   * leur adresse : il n'y a plus rien à numéroter. */
  var deja = false;
  (existants || []).forEach(function (j) { if (j && j.tag === tag) { deja = true; } });
  if (deja) { return { code: "doublon", raison: "ce marqueur est déjà dans votre palette", deja: true }; }

  /* LE NOM GARDÉ EST CELUI QU'ON A ÉCRIT, pas le nom réduit de l'étiquette :
   * « Poison » s'affiche « Poison » et non « poison ». L'étiquette, elle, est
   * réduite parce qu'elle traverse le champ de Roll20 ; l'affichage n'a pas
   * cette contrainte, et rien n'oblige à s'infliger la sienne. */
  return { marqueur: { tag: tag, nom: n || vttMarqueurNomDepuisUrl(propre), url: propre } };
}

/* ---------- CE QU'ON COLLE ----------
 *
 * Une URL par ligne, éventuellement précédée d'un nom séparé par une barre
 * verticale ou une tabulation :
 *
 *     https://exemple.org/feu.png
 *     Poison | https://exemple.org/skull.png
 *
 * Le découpage de la ligne est la SEULE chose qui se décide ici ; tout le reste
 * passe par la porte commune ci-dessus. */
function vttMarqueursDepuisTexte(texte, existants) {
  var lignes = String(texte || "").split(/[\r\n]+/);
  var retenus = [], rejets = [], vus = (existants || []).slice(), i;

  for (i = 0; i < lignes.length; i++) {
    var ligne = lignes[i].trim();
    if (!ligne) { continue; }

    var nom = "", url = ligne;
    var coupe = ligne.split(/\s*[|\t]\s*/);
    if (coupe.length >= 2) { nom = coupe[0]; url = coupe.slice(1).join(" "); }

    var r = vttMarqueurDepuisChamps(nom, url, vus);
    /* UN DOUBLON N'EST PAS UN REJET DANS UN COLLAGE : recoller une liste dont on
     * a déjà la moitié doit ajouter l'autre moitié sans se plaindre. Il en va
     * autrement au formulaire, où l'utilisateur saisit UNE entrée et attend
     * qu'on lui dise pourquoi elle n'apparaît pas. */
    if (r.deja) { continue; }
    if (!r.marqueur) { rejets.push({ ligne: ligne.slice(0, 80), raison: r.raison }); continue; }
    vus.push(r.marqueur);
    retenus.push(r.marqueur);
  }
  return { retenus: retenus, rejets: rejets };
}

/* ---------- L'ORDRE DE LA PALETTE ----------
 *
 * IL EST DEVENU SIGNIFIANT. Tant qu'on ne pouvait qu'ajouter et retirer, l'ordre
 * était celui des ajouts et personne ne s'en souciait ; depuis qu'on trie à la
 * souris, c'est une donnée que l'utilisateur a posée lui-même, et la perdre se
 * verrait immédiatement.
 *
 * On réordonne SANS RIEN PERDRE : les étiquettes citées passent devant, dans
 * l'ordre demandé, et tout ce que la demande ne cite pas reste à la suite dans
 * son ordre d'avant. Une demande venue d'une palette périmée — un marqueur
 * supprimé entre-temps par une autre fenêtre — ne peut donc ni ressusciter ni
 * effacer quoi que ce soit. */
function vttMarqueursReordonnes(liste, ordre) {
  var propre = vttMarqueursPropres(liste);
  var rang = {}, i;
  for (i = 0; i < (ordre || []).length; i++) {
    if (rang[ordre[i]] === undefined) { rang[ordre[i]] = i; }
  }
  var cites = [], reste = [];
  propre.forEach(function (j) {
    if (rang[j.tag] === undefined) { reste.push(j); } else { cites.push(j); }
  });
  cites.sort(function (a, b) { return rang[a.tag] - rang[b.tag]; });
  return cites.concat(reste);
}

/* La liste rangée : on ne garde que des entrées complètes et des étiquettes
 * uniques. Elle est appelée sur ce qui SORT du stockage autant que sur ce qui y
 * entre — une donnée écrite par une version précédente n'a aucune raison d'être
 * crue sur parole. */
function vttMarqueursPropres(liste) {
  var vus = {}, out = [];
  (liste || []).forEach(function (j) {
    if (!j || !j.tag || !j.url) { return; }
    var t = String(j.tag);
    /* L'ÉTIQUETTE DOIT SE RELIRE, pas seulement commencer par le bon préfixe :
     * c'est elle qui porte l'adresse, et une étiquette qu'on ne sait pas relire
     * ne dessinerait rien chez personne. */
    if (!vttMarqueurDepuisEtiquette(t)) { return; }
    if (vus[t]) { return; }
    if (!vttMarqueurUrlValide(j.url)) { return; }
    vus[t] = 1;
    out.push({ tag: t, nom: String(j.nom || t), url: String(j.url) });
  });
  return out;
}
